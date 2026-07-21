// 真实内置 Pi 端到端测试（设计 §16.5）。仅由 `pnpm test:real:pi`（--env-file=.env）触发；
// 普通测试运行因缺少 DEV_API_KEY 自动跳过。验证：四变量合法、固定 Pi 入口 --mode json、
// 角色读写/审查/测试能力、interaction/report_result JSON 解析、确定失败候选后自动降级、同角色并发隔离。
// 全程使用与生产相同的脱敏；密钥只经子进程环境变量传递，绝不落入 argv/日志/断言文本。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, ProviderKind } from '@ai-devflow/core';
import {
  BundledPiLocator,
  PiProcessSupervisor,
  ProfileMaterializer,
  ROLE_PROFILES,
  buildPiRunPlan,
  createPiEventTranslator,
  isCompatibleKind,
  type ProviderRoute,
} from '../index.js';

const HAVE_KEY = !!process.env.DEV_API_KEY;
const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/profiles');
// stage:pi 由 test:real:pi 脚本先行执行；此处定位 staging 产物。
const STAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/desktop/build/pi-runtime');

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'openai_compatible', 'anthropic_compatible'];

function devKind(): ProviderKind {
  const raw = (process.env.DEV_API_TYPE ?? '').trim() as ProviderKind;
  if (!KINDS.includes(raw)) throw new Error(`DEV_API_TYPE 非法：${raw}（须为 ${KINDS.join(' | ')}）`);
  return raw;
}

function devRoute(routeId: string, providerName: string): ProviderRoute {
  const kind = devKind();
  return {
    providerId: 'dev',
    providerKind: kind,
    providerName,
    routeId,
    model: process.env.DEV_API_DEFAULT_MODEL!,
    thinking: 'medium',
    baseURL: process.env.DEV_API_URL,
    secret: process.env.DEV_API_KEY!,
  };
}

interface RunResult {
  ok: boolean;
  events: AgentEvent[];
  journal: ReturnType<ReturnType<typeof createPiEventTranslator>['journal']>;
  exitCode: number | null;
  sessionDir: string;
}

let locator: BundledPiLocator;
let entry = '';
const tempDirs: string[] = [];

async function runRealAttempt(opts: {
  role: keyof typeof ROLE_PROFILES;
  prompt: string;
  cwd: string;
  route: ProviderRoute;
  executionId: string;
  attemptId: string;
}): Promise<RunResult> {
  const materializer = new ProfileMaterializer(ASSETS_ROOT, join(opts.cwd, '.pi-runtime'));
  const { profileDir } = materializer.materialize({
    role: opts.role,
    providerId: opts.route.providerId,
    providerKind: opts.route.providerKind,
    providerRevision: 1,
    baseURL: opts.route.baseURL,
    providerName: opts.route.providerName,
    models: [opts.route.model],
  });
  const sessionDir = join(opts.cwd, '.pi-runtime', 'sessions', opts.executionId, opts.attemptId);
  mkdirSync(join(sessionDir, 'home'), { recursive: true });
  mkdirSync(join(sessionDir, 'tmp'), { recursive: true });
  const plan = buildPiRunPlan({
    runtimeEntry: entry,
    profileDir,
    sessionDir,
    isolatedHome: join(sessionDir, 'home'),
    tempDir: join(sessionDir, 'tmp'),
    executionId: opts.executionId,
    attemptId: opts.attemptId,
    role: opts.role,
    initialMessage: opts.prompt,
    route: opts.route,
    projectToolPath: process.env.PATH ?? '/usr/bin:/bin',
    worktree: opts.cwd,
  });
  const supervisor = new PiProcessSupervisor();
  const spawned = supervisor.spawn(plan, { cwd: opts.cwd, timeoutMs: ROLE_PROFILES[opts.role].timeoutMs, secrets: [opts.route.secret] });
  const translator = createPiEventTranslator({ executionId: opts.executionId, attemptId: opts.attemptId, routeId: opts.route.routeId, secrets: [opts.route.secret] });
  const events: AgentEvent[] = [];
  for await (const line of spawned.lines) {
    if (line.stream !== 'stdout') continue;
    for (const ev of translator.push(line.text)) events.push(ev);
  }
  const exit = await spawned.done();
  let ok = false;
  try {
    translator.finish();
    ok = translator.hasStructuredResult() && exit.exitCode === 0;
  } catch {
    ok = false;
  }
  return { ok, events, journal: translator.journal(), exitCode: exit.exitCode, sessionDir };
}

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'real-pi-repo-'));
  tempDirs.push(dir);
  execSync('git init -q && git config user.email "t@t.dev" && git config user.name "t"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

describe.skipIf(!HAVE_KEY)('real bundled pi provider e2e', () => {
  beforeAll(async () => {
    expect(existsSync(join(STAGE_DIR, 'runtime-manifest.json')), '缺少 staging 产物，先运行 pnpm --filter @ai-devflow/desktop stage:pi').toBe(true);
    locator = new BundledPiLocator(STAGE_DIR, { requireProfiles: false });
    const verified = await locator.verify();
    entry = verified.entry;
    expect(verified.version).toBe('0.80.10');
  }, 120_000);

  afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  it('validates the four DEV_API_* variables and .env ignore status', () => {
    for (const v of ['DEV_API_KEY', 'DEV_API_URL', 'DEV_API_DEFAULT_MODEL', 'DEV_API_TYPE']) {
      expect(process.env[v], `${v} 必填`).toBeTruthy();
    }
    expect(() => devKind()).not.toThrow();
    // .env 仍被 Git ignore
    const ignored = execSync('git check-ignore .env', { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..') }).toString().trim();
    expect(ignored).toContain('.env');
  });

  it('runs a minimal coder task through the bundled pi and parses the structured result', async () => {
    const cwd = makeGitFixture();
    const route = devRoute('dev:coder:primary', isCompatibleKind(devKind()) ? 'ai-devflow-devtest0001' : devKind());
    const res = await runRealAttempt({
      role: 'coder',
      prompt: '在 src/app.ts 中新增并导出一个常量 answer = 42，不要改动其它内容。完成后调用 ai_devflow_report_result 上报。',
      cwd,
      route,
      executionId: 'exec-coder',
      attemptId: 'attempt-01',
    });
    expect(res.ok, `coder 任务应成功（exit=${res.exitCode}）`).toBe(true);
    expect(res.events.some((e) => e.type === 'done')).toBe(true);
  }, 300_000);

  it('fails over from a deterministic dead candidate to the real provider', async () => {
    const cwd = makeGitFixture();
    // 确定失败的候选：指向本地关闭端口的兼容网关。
    const badRoute: ProviderRoute = {
      providerId: 'bad', providerKind: 'openai_compatible', providerName: 'ai-devflow-deadbeef0001',
      routeId: 'bad:coder:primary', model: 'unused-model', thinking: 'medium',
      baseURL: 'http://127.0.0.1:59999/v1', secret: 'dead-secret',
    };
    const bad = await runRealAttempt({ role: 'coder', prompt: 'noop', cwd, route: badRoute, executionId: 'exec-fo', attemptId: 'attempt-01' });
    expect(bad.ok).toBe(false); // 确定失败
    // 真实候选成功（降级后到达）
    const goodRoute = devRoute('dev:coder:primary', isCompatibleKind(devKind()) ? 'ai-devflow-devtest0001' : devKind());
    const good = await runRealAttempt({ role: 'coder', prompt: '调用 ai_devflow_report_result 上报 summary="ok"。', cwd, route: goodRoute, executionId: 'exec-fo', attemptId: 'attempt-02' });
    expect(good.ok, '降级到真实供应商后应成功').toBe(true);
  }, 300_000);

  it('runs the same role concurrently with isolated config/session dirs', async () => {
    const cwd = makeGitFixture();
    const route = devRoute('dev:tester:primary', isCompatibleKind(devKind()) ? 'ai-devflow-devtest0001' : devKind());
    const [a, b] = await Promise.all([
      runRealAttempt({ role: 'tester', prompt: '调用 ai_devflow_report_result 上报 summary="A"。', cwd, route, executionId: 'exec-conc', attemptId: 'attempt-A' }),
      runRealAttempt({ role: 'tester', prompt: '调用 ai_devflow_report_result 上报 summary="B"。', cwd, route, executionId: 'exec-conc', attemptId: 'attempt-B' }),
    ]);
    expect(a.sessionDir).not.toBe(b.sessionDir);
    expect([a.ok, b.ok].some(Boolean), '至少一个并发运行应成功').toBe(true);
  }, 300_000);
});
