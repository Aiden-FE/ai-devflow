import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories } from '@ai-devflow/persistence';
import { buildVerificationArgs, HostVerificationRunner, type ExecFileFn, type GitExecFn } from '../verification-runner.js';

function makeRepos() {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  repos.projects.insert({
    id: 'p1', name: 'P', path: '/repos/a', defaultBranch: 'main',
    createdAt: 0, updatedAt: 0, settings: {},
  });
  repos.iterations.insert({ id: 'it1', projectId: 'p1', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  repos.requirements.insert({ id: 'r1', iterationId: 'it1', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
  repos.tasks.insert({
    id: 't1', requirementId: 'r1', iterationId: 'it1', projectId: 'p1', title: 'T', description: '',
    status: 'testing', role: 'coder', stages: [], currentStage: 0,
    statusChangedAt: 0, createdAt: 0, updatedAt: 0, retryCount: 0,
  } as never);
  return repos;
}

describe('buildVerificationArgs', () => {
  it('runs workspace-level commands at the repo root', () => {
    expect(buildVerificationArgs('test')).toEqual(['-w', 'test']);
    expect(buildVerificationArgs('typecheck')).toEqual(['-w', 'exec', 'tsc', '--noEmit']);
    expect(buildVerificationArgs('lint')).toEqual(['-w', 'exec', 'eslint', '.', '--max-warnings=0']);
  });

  it('scopes to a single package when a filter is provided', () => {
    expect(buildVerificationArgs('test', '@ai-devflow/agents')).toEqual([
      '--filter', '@ai-devflow/agents', 'test',
    ]);
  });
});

describe('HostVerificationRunner', () => {
  it('resolves project path from task and project scopes', () => {
    const repos = makeRepos();
    const runner = new HostVerificationRunner(repos, { execFileFn: async () => ({ stdout: '', stderr: '' }) });
    expect(runner.resolveProjectPath({ kind: 'task', taskId: 't1' })).toBe('/repos/a');
    expect(runner.resolveProjectPath({ kind: 'project', projectId: 'p1' })).toBe('/repos/a');
    expect(runner.resolveProjectPath({ kind: 'task', taskId: 'missing' })).toBeUndefined();
  });

  it('returns ok=true with sanitized output on exit 0', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const execFileFn: ExecFileFn = async (_file, args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return { stdout: 'all tests passed', stderr: '' };
    };
    const runner = new HostVerificationRunner(makeRepos(), { execFileFn });
    const result = await runner.run({ command: 'test', cwd: '/repos/a' });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('all tests passed');
    expect(calls[0]?.args).toEqual(['-w', 'test']);
    expect(calls[0]?.cwd).toBe('/repos/a');
  });

  it('returns ok=false with output on non-zero exit (test failures are valid results)', async () => {
    const execFileFn: ExecFileFn = async () => {
      const err = new Error('Command failed') as Error & { code: number; stdout: string; stderr: string };
      err.code = 1;
      err.stdout = 'FAIL  src/foo.test.ts';
      err.stderr = '';
      throw err;
    };
    const runner = new HostVerificationRunner(makeRepos(), { execFileFn });
    const result = await runner.run({ command: 'test', cwd: '/repos/a' });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('FAIL  src/foo.test.ts');
    expect(result.summary).toContain('exit 1');
  });

  it('redacts secrets from output', async () => {
    const secret = 'sk-super-secret-key-123';
    const execFileFn: ExecFileFn = async () => ({
      stdout: `running with key ${secret}`,
      stderr: '',
    });
    const runner = new HostVerificationRunner(makeRepos(), { execFileFn });
    const result = await runner.run({ command: 'lint', cwd: '/repos/a' });
    expect(result.output).not.toContain(secret);
  });

  it('runs task-scope verification in the task worktree when it exists', async () => {
    const repos = makeRepos();
    const wt = mkdtempSync(join(tmpdir(), 'verify-wt-'));
    repos.tasks.setWorktree('t1', wt);
    const calls: string[] = [];
    const execFileFn: ExecFileFn = async (_file, _args, opts) => {
      calls.push(opts.cwd);
      return { stdout: 'ok', stderr: '' };
    };
    const runner = new HostVerificationRunner(repos, { execFileFn });
    const result = await runner.run({
      command: 'test', cwd: '/repos/a', agentScope: { kind: 'task', taskId: 't1' },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe(wt);
    rmSync(wt, { recursive: true, force: true });
  });

  it('creates a task-branch verification worktree when the task worktree is missing', async () => {
    const repos = makeRepos();
    const base = mkdtempSync(join(tmpdir(), 'verify-base-'));
    const gitCalls: string[][] = [];
    const gitExecFn: GitExecFn = async (args) => {
      gitCalls.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[2]!, { recursive: true });
      }
      return { stdout: '', stderr: '' };
    };
    const execFileFn: ExecFileFn = async (_file, _args, opts) => ({ stdout: `cwd=${opts.cwd}`, stderr: '' });
    const runner = new HostVerificationRunner(repos, { execFileFn, gitExecFn, worktreesBaseDir: base });
    const result = await runner.run({
      command: 'typecheck', cwd: '/repos/a', agentScope: { kind: 'task', taskId: 't1' },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(join(base, 't1'));
    expect(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'add' && args[3] === 'ai-devflow/t1')).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('links main repo node_modules into an existing task worktree when missing', async () => {
    const repos = makeRepos();
    const projectDir = mkdtempSync(join(tmpdir(), 'verify-proj-'));
    const wt = mkdtempSync(join(tmpdir(), 'verify-wt-link-'));
    mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'marker.txt'), 'x');
    const project = repos.projects.get('p1')!;
    repos.projects.update({ ...project, path: projectDir });
    repos.tasks.setWorktree('t1', wt);
    const execFileFn: ExecFileFn = async () => ({ stdout: 'ok', stderr: '' });
    const runner = new HostVerificationRunner(repos, { execFileFn });
    await runner.run({ command: 'test', cwd: projectDir, agentScope: { kind: 'task', taskId: 't1' } });
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it('reports timeout as a failure rather than throwing', async () => {
    const execFileFn: ExecFileFn = async () => {
      const err = new Error('Timed out') as Error & { killed: boolean; signal: string; code: number };
      err.killed = true;
      err.signal = 'SIGTERM';
      err.code = 1;
      throw err;
    };
    const runner = new HostVerificationRunner(makeRepos(), { execFileFn });
    const result = await runner.run({ command: 'typecheck', cwd: '/repos/a', timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/超时/);
  });
});
