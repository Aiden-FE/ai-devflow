// 生成 README 产品截图：用 Playwright 启动开发模式应用，注入示例数据后截取关键界面。
// 运行：node scripts/capture-screenshots.mjs   （需已构建 dist / dist-electron / build/pi-runtime）
//
// 仅用于生成静态截图，不执行真实 Pi 任务（所有任务停留在「待开发」泳道）。
// 产物写入仓库 docs/images/，供 README 引用。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const { _electron: electron } = await import('playwright');

const APP_ROOT = process.cwd(); // apps/desktop
const IMG_DIR = join(APP_ROOT, '..', '..', 'docs', 'images');
mkdirSync(IMG_DIR, { recursive: true });

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'shot@local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'shot'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# demo repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

const repo = mkdtempSync(join(tmpdir(), 'aidf-shot-repo-'));
const userData = mkdtempSync(join(tmpdir(), 'aidf-shot-userdata-'));
let app;
try {
  initGitRepo(repo);
  const env = { ...process.env, AI_DEVFLOW_USER_DATA: userData };
  app = await electron.launch({ executablePath: electronPath, args: ['.'], env, cwd: APP_ROOT });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 统一较大窗口，确保看板 5 列（xl ≥1280）与侧栏都能完整呈现。
  try { await win.setViewportSize({ width: 1600, height: 1000 }); } catch {}

  // 注入示例数据：1 个提供商 + 1 个项目 + 1 个迭代 + 1 个需求 + 5 个任务（均落在「待开发」）。
  await win.evaluate(async ({ repoPath }) => {
    await window.api.providers.save({
      id: 'shot-provider', kind: 'openai_compatible', displayName: 'OpenAI',
      enabled: true, priority: 0, authType: 'api_key',
      baseURL: 'https://api.openai.com/v1', revision: 0,
      apiKey: 'sk-shot-demo-key-do-not-use', allowInsecureLocal: false,
    });
    const project = await window.api.projects.create({ name: 'ai-devflow', path: repoPath, defaultBranch: 'main' });
    const iteration = await window.api.iterations.create(project.id, '2026 Q3', '0.1.2');
    const requirement = await window.api.requirements.create(
      iteration.id,
      '泳道看板与门禁流转',
      '把自动化开发流程做成泳道看板，由内置 Pi 运行时在隔离 Git worktree 中真实执行任务。',
      'high',
      '六泳道状态机合法迁移；开发任务禁止直接进入待验收；审查通过才合并。',
    );
    const tasks = [
      ['实现泳道状态机与门禁', 'coder', '定义六泳道合法迁移图与门禁拦截，覆盖拖拽与 IPC。'],
      ['拆解迭代需求与任务依赖', 'planner', '将需求拆解为有序任务并标注串行依赖。'],
      ['编写状态机迁移单元测试', 'tester', '覆盖合法/非法迁移、门禁拒绝、退回修复路径。'],
      ['集成 SQLite 持久化与备份', 'coder', '迁移前一致性备份、事务、Repository。'],
      ['审查门禁与看板流转', 'reviewer', '只读审查需求覆盖、测试构建、安全与无关改动。'],
    ];
    for (const [title, role, description] of tasks) {
      await window.api.tasks.create({ requirementId: requirement.id, title, description, role });
    }
  }, { repoPath: repo });

  // 重新加载以让 React 重新拉取注入的数据。
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  try { await win.setViewportSize({ width: 1600, height: 1000 }); } catch {}

  // 1) 项目页
  await win.getByText('ai-devflow').first().waitFor({ timeout: 15_000 });
  await win.screenshot({ path: join(IMG_DIR, 'projects.png') });
  console.log('✓ projects.png');

  // 2) 进入工作台 -> 看板
  await win.getByRole('button', { name: '打开' }).first().click();
  await win.getByText('看板').first().waitFor({ timeout: 15_000 });
  await win.locator('[data-lane="ready"] [data-task-card]').first().waitFor({ timeout: 15_000 });
  // 滚动让看板完整入镜。
  await win.locator('h3:has-text("看板")').scrollIntoViewIfNeeded().catch(() => {});
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(IMG_DIR, 'kanban.png') });
  console.log('✓ kanban.png');

  // 3) 任务详情（侧滑窗对话）
  await win.locator('[data-task-card]').first().click();
  await win.getByText('任务对话').waitFor({ timeout: 15_000 });
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(IMG_DIR, 'task-detail.png') });
  console.log('✓ task-detail.png');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // 4) 设置 -> AI 服务商
  await win.getByRole('button', { name: '设置' }).click();
  await win.getByText('AI 服务商').first().waitFor({ timeout: 15_000 });
  await win.getByText('OpenAI').first().waitFor({ timeout: 15_000 });
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(IMG_DIR, 'settings.png') });
  console.log('✓ settings.png');

  console.log(`\n截图已保存到 ${IMG_DIR}`);
} finally {
  await app?.close().catch(() => {});
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
