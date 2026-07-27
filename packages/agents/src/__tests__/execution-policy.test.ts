import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

interface PolicyHandlers {
  canWrite(path: string): boolean;
  onToolCall(event: Record<string, unknown>): { block: true; reason: string } | undefined;
  onToolResult(event: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError: true } | undefined;
}

let createExecutionPolicy: (context: { role: string; expert?: string; worktree: string }) => PolicyHandlers;

beforeAll(async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'execution-policy-module-'));
  const outfile = join(outputDir, 'execution-policy.mjs');
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../assets/profiles/shared/extensions/execution-policy.ts',
  );
  buildSync({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'esm' });
  const loaded = await import(pathToFileURL(outfile).href) as {
    createExecutionPolicy: typeof createExecutionPolicy;
  };
  createExecutionPolicy = loaded.createExecutionPolicy;
});

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'execution-policy-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'policy@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Policy Test']);
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'fixture']);
  return dir;
}

function bash(policy: PolicyHandlers, command: string) {
  return policy.onToolCall({
    type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: { command },
  });
}

describe('execution policy', () => {
  it.each(['coder', 'reviewer', 'tester'] as const)(
    'rejects chained git before role classification for %s',
    (role) => {
      const policy = createExecutionPolicy({ role, worktree: worktree() });
      expect(bash(policy, 'git status; touch escaped.txt')).toMatchObject({
        block: true,
        reason: expect.stringContaining('policy:shell-escape'),
      });
    },
  );

  it.each([
    'find . -delete',
    'find . -exec touch {} ;',
    'node -e "require(\'fs\').writeFileSync(\'escaped\',\'x\')"',
    'python3 -c "open(\'escaped\',\'w\').write(\'x\')"',
    'git reset --hard HEAD',
    'git clean -fdx',
  ])('rejects destructive or interpreter escape command: %s', (command) => {
    const policy = createExecutionPolicy({ role: 'coder', worktree: worktree() });
    expect(bash(policy, command)).toMatchObject({ block: true });
  });

  it('rejects path arguments that escape the worktree for coder/tester bash', () => {
    const root = worktree();
    for (const role of ['coder', 'tester'] as const) {
      const policy = createExecutionPolicy({ role, worktree: root });
      expect(bash(policy, `touch ${join(root, '..', 'escaped.txt')}`)).toMatchObject({
        block: true,
        reason: expect.stringContaining('policy:outside-worktree'),
      });
      expect(bash(policy, 'cp tracked.txt ../escaped.txt')).toMatchObject({ block: true });
    }
  });

  it('rejects package mutation even when pnpm filters precede the action', () => {
    const policy = createExecutionPolicy({ role: 'coder', worktree: worktree() });
    expect(bash(policy, 'pnpm --filter @ai-devflow/agents add left-pad')).toMatchObject({
      block: true,
      reason: expect.stringContaining('policy:install-forbidden'),
    });
  });

  it.each(['coder', 'tester'] as const)(
    'rejects package-manager execution wrappers and nested payloads for %s',
    (role) => {
      const policy = createExecutionPolicy({ role, worktree: worktree() });
      for (const command of [
        'pnpm exec node -e "process.exit(0)"',
        'npm exec -- sh -c "touch escaped"',
        'pnpm dlx tsx /tmp/outside.ts',
        '/usr/local/bin/pnpm exec python3 -c "print(1)"',
        'corepack pnpm --filter @ai-devflow/agents exec node -e "process.exit(0)"',
        'corepack npm --workspace agents exec -- sh -c "touch escaped"',
        'corepack yarn --cwd . exec node -e "process.exit(0)"',
        '/usr/bin/corepack pnpm exec python3 -c "print(1)"',
        'pnpm --filter @ai-devflow/agents node -e "process.exit(0)"',
      ]) {
        expect(bash(policy, command)).toMatchObject({
          block: true,
          reason: expect.stringContaining('policy:package-execution-wrapper'),
        });
      }
    },
  );

  it.each([
    'npm run test -- x',
    'pnpm vitest run exec',
  ])('does not classify a later verification argument as the package action: %s', (command) => {
    const policy = createExecutionPolicy({ role: 'reviewer', worktree: worktree() });
    expect(bash(policy, command)).toBeUndefined();
  });

  it.each([
    'corepack pnpm@9 exec node -e "process.exit(0)"',
    'corepack yarnpkg exec node -e "process.exit(0)"',
    '/usr/bin/corepack prepare pnpm@9 --activate',
    'npm --heading foo exec node -e "process.exit(0)"',
    'pnpm --mystery value exec node -e "process.exit(0)"',
    'yarnpkg exec node -e "process.exit(0)"',
    'pnpm frobnicate',
  ])('fails closed for ambiguous package-manager command: %s', (command) => {
    const policy = createExecutionPolicy({ role: 'coder', worktree: worktree() });
    expect(bash(policy, command)).toMatchObject({
      block: true,
      reason: expect.stringContaining('policy:package-execution-wrapper'),
    });
  });

  it.each(['coder', 'tester'] as const)(
    'rejects pnpm implicit interpreter execution for %s',
    (role) => {
      const policy = createExecutionPolicy({ role, worktree: worktree() });
      expect(bash(policy, 'pnpm --filter @ai-devflow/agents node -e "process.exit(0)"')).toMatchObject({
        block: true,
        reason: expect.stringContaining('policy:package-execution-wrapper'),
      });
    },
  );

  it.each(['coder', 'reviewer', 'tester'] as const)(
    'rejects command wrappers before classifying nested commands for %s',
    (role) => {
      const policy = createExecutionPolicy({ role, worktree: worktree() });
      for (const command of [
        'env sh -c "touch escaped"',
        'command python3 -c "open(\'escaped\',\'w\')"',
        '/usr/bin/env git reset --hard HEAD',
      ]) {
        expect(bash(policy, command)).toMatchObject({
          block: true,
          reason: expect.stringContaining('policy:command-wrapper'),
        });
      }
    },
  );

  it.each(['coder', 'reviewer', 'tester'] as const)(
    'rejects path-form executable tokens for %s',
    (role) => {
      const policy = createExecutionPolicy({ role, worktree: worktree() });
      expect(bash(policy, './wrapper --do-it')).toMatchObject({
        block: true,
        reason: expect.stringContaining('policy:executable-path'),
      });
    },
  );

  it('uses exact reviewer argv patterns for read-only git and package verification', () => {
    const policy = createExecutionPolicy({ role: 'reviewer', worktree: worktree() });
    expect(bash(policy, 'git diff --check')).toBeUndefined();
    expect(bash(policy, 'git status --porcelain')).toBeUndefined();
    expect(bash(policy, 'pnpm --filter @ai-devflow/agents test')).toBeUndefined();
    expect(bash(policy, 'npm run test')).toBeUndefined();
    expect(bash(policy, 'pnpm vitest run')).toBeUndefined();
    expect(bash(policy, 'yarnpkg test')).toBeUndefined();
    expect(bash(policy, 'git status --output=owned')).toMatchObject({ block: true });
    expect(bash(policy, 'git -c alias.status=clean status')).toMatchObject({ block: true });
    expect(bash(policy, 'pnpm add left-pad')).toMatchObject({ block: true });
  });

  it('fails a reviewer bash result if any tracked file hash changed', () => {
    const root = worktree();
    const policy = createExecutionPolicy({ role: 'reviewer', worktree: root });
    expect(bash(policy, 'git status --porcelain')).toBeUndefined();
    writeFileSync(join(root, 'tracked.txt'), 'mutated\n');

    const result = policy.onToolResult({
      type: 'tool_result',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'git status --porcelain' },
      content: [{ type: 'text', text: ' M tracked.txt' }],
      isError: false,
      details: undefined,
    });
    expect(result).toMatchObject({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining('policy:reviewer-tracked-files-changed') })],
    });

    expect(policy.onToolCall({
      type: 'tool_call',
      toolCallId: 'report-after-mutation',
      toolName: 'ai_devflow_report_result',
      input: {
        summary: 'REVIEW_VERDICT: PASS',
        verification: ['claimed clean'],
        changedFiles: [],
        unresolved: [],
      },
    })).toMatchObject({
      block: true,
      reason: expect.stringContaining('policy:reviewer-integrity-violation'),
    });
  });
});

describe('project_lead write policy', () => {
  function policyForPL() {
    const root = worktree();
    for (const dir of ['docs/knowledge/feature', 'docs/iterations/v1/tasks/t1']) {
      execFileSync('mkdir', ['-p', join(root, dir)]);
    }
    return { root, policy: createExecutionPolicy({ role: '', expert: 'project_lead', worktree: root }) };
  }

  it('allows writes inside docs/knowledge and docs/iterations', () => {
    const { policy } = policyForPL();
    expect(policy.canWrite('docs/knowledge/feature/tasks.md')).toBe(true);
    expect(policy.canWrite('docs/iterations/v1/tasks/t1/MEMORY.md')).toBe(true);
  });

  it('rejects writes outside the documentation roots', () => {
    const { policy } = policyForPL();
    expect(policy.canWrite('packages/core/src/types.ts')).toBe(false);
    expect(policy.canWrite('docs/knowledge')).toBe(true); // 根目录本身允许（索引）
  });

  it('rejects absolute paths and traversal', () => {
    const { policy } = policyForPL();
    expect(policy.canWrite('/etc/passwd')).toBe(false);
    expect(policy.canWrite('../escape.md')).toBe(false);
    expect(policy.canWrite('docs/knowledge/../../../etc/passwd')).toBe(false);
  });

  it('blocks write tool calls outside the scope', () => {
    const { policy } = policyForPL();
    expect(policy.onToolCall({
      type: 'tool_call', toolCallId: 'w1', toolName: 'write',
      input: { path: 'packages/core/src/types.ts', content: 'x' },
    })).toMatchObject({ block: true, reason: expect.stringContaining('project-lead-scope') });
    expect(policy.onToolCall({
      type: 'tool_call', toolCallId: 'w2', toolName: 'edit',
      input: { path: 'docs/knowledge/feature/a.md', content: 'x' },
    })).toBeUndefined();
  });

  it('denies bash for project_lead', () => {
    const { policy } = policyForPL();
    expect(policy.onToolCall({
      type: 'tool_call', toolCallId: 'b1', toolName: 'bash', input: { command: 'git status' },
    })).toMatchObject({ block: true });
  });
});
