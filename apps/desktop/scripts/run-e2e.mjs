// E2E：用 Playwright 的 _electron 启动打包后的应用，驱动关键 UI 流程并断言。
// 需要 electron 二进制（已通过 .npmrc 镜像安装）。
// 运行：node scripts/run-e2e.mjs
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// require('electron') 返回 Electron 二进制路径（path.txt 已就位时）
const electronPath = require('electron');
const { _electron: electron } = await import('playwright');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('build step failed', cmd, args.join(' ')); process.exit(1); }
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'e2e');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

console.log('[e2e] building app...');
run('npx', ['vite', 'build']);
run('node', ['build-electron.mjs']);

const repo = mkdtempSync(join(tmpdir(), 'aidf-e2e-repo-'));
initGitRepo(repo);
const userData = mkdtempSync(join(tmpdir(), 'aidf-e2e-userdata-'));

const env = {
  ...process.env,
  AI_DEVFLOW_USER_DATA: userData,
  // 让“测试适配器”任务产出 done；恢复时产出 done。
  AI_DEVFLOW_TEST_CONTROL: JSON.stringify([{ type: 'log', level: 'info', text: 'working', t: 0 }, { type: 'done', summary: 'ok', t: 0 }]),
  AI_DEVFLOW_TEST_RESUME_CONTROL: JSON.stringify([{ type: 'log', level: 'info', text: 'resumed', t: 0 }, { type: 'done', summary: 'ok', t: 0 }]),
};

let failures = 0;
function check(name, cond) {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
  if (!cond) failures++;
}

const app = await electron.launch({ executablePath: electronPath, args: ['.'], env, cwd: process.cwd() });
let win;
try {
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const dialog = () => win.getByRole('dialog');

  // 1. 导入本地项目（新建项目 -> 导入已有 tab）
  await win.getByRole('button', { name: '新建项目' }).click();
  await dialog().waitFor();
  await dialog().getByPlaceholder('my-project').fill('E2E Proj');
  await dialog().getByPlaceholder('/Users/me/code/repo').fill(repo);
  await dialog().getByRole('button', { name: '导入', exact: true }).click();
  await win.getByText('E2E Proj').first().waitFor();
  check('导入本地 Git 项目', await win.getByText('E2E Proj').first().isVisible());

  // 进入工作台
  await win.getByRole('button', { name: '打开' }).click();
  await win.getByRole('button', { name: '新建迭代' }).waitFor();

  // 2. 创建迭代
  await win.getByRole('button', { name: '新建迭代' }).click();
  await dialog().waitFor();
  await dialog().getByPlaceholder('2026 Q3').fill('Iter1');
  await dialog().getByRole('button', { name: '创建', exact: true }).click();
  await win.getByText('需求').first().waitFor();
  check('创建迭代', true);

  // 3. 创建需求（含验收标准）
  await win.getByRole('button', { name: '新建需求' }).click();
  await dialog().waitFor();
  await dialog().locator('input').nth(0).fill('Req1');
  await dialog().locator('textarea').nth(0).fill('描述');
  await dialog().locator('textarea').nth(1).fill('验收标准1');
  await dialog().getByRole('button', { name: '创建', exact: true }).click();
  await win.getByText('Req1').first().waitFor();
  check('创建需求（含验收标准）', true);

  // 4. 创建任务（指定测试适配器）-> 直接进入待开发泳道（需求池已移除）
  await win.getByRole('button', { name: '创建任务' }).click();
  await dialog().waitFor();
  await dialog().locator('input').nth(0).fill('Task1');
  await dialog().locator('textarea').nth(0).fill('做点事');
  // 第二个 combobox 是 Agent
  await dialog().getByRole('combobox').nth(1).click();
  await win.getByRole('option', { name: '测试适配器' }).click();
  await dialog().getByRole('button', { name: '创建', exact: true }).click();
  await win.locator('[data-lane="ready"] [data-task-card]').first().waitFor();
  check('创建任务直接进入待开发', true);

  // 5. 配置并检测 Agent
  await win.getByRole('button', { name: '设置' }).click();
  await win.getByText('Agent 桥接器检测').waitFor();
  await win.getByText('Claude Code').first().waitFor({ timeout: 15000 });
  check('检测 Agent（含 Claude Code/Codex/Pi）', await win.getByText('Claude Code').first().isVisible());
  await win.getByRole('button', { name: '工作台' }).click();
  await win.getByText('看板').first().waitFor({ timeout: 10000 });

  // 6. 启动任务并查看任务对话窗口（侧滑窗）
  await win.locator('[data-lane="ready"] [data-task-card]').first().click();
  await dialog().waitFor(); // Sheet 打开
  await dialog().getByRole('button', { name: '启动' }).click();
  await win.getByText('任务对话').waitFor({ timeout: 5000 });
  check('启动任务并查看任务对话（侧滑窗）', await win.getByText('任务对话').isVisible());
  // 任务执行后推进到待验收/归档（待验收=人工验收入口，不自动归档）
  await win.locator('[data-lane="in_review"] [data-task-card], [data-lane="archived"] [data-task-card]').first().waitFor({ timeout: 15000 });
  check('任务执行后推进到待验收/归档', true);

  // 8. 语言切换（默认中文 -> English -> 中文）
  await win.keyboard.press('Escape'); // 关闭任务详情侧滑窗
  await win.getByRole('button', { name: 'English' }).click();
  await win.getByText('Projects').first().waitFor({ timeout: 3000 });
  check('切换到 English', await win.getByText('Projects').first().isVisible());
  await win.getByRole('button', { name: '中文' }).click();
  await win.getByText('项目').first().waitFor({ timeout: 3000 });
  check('切换回中文', true);
} catch (err) {
  console.error('[e2e] error:', err.message);
  failures++;
} finally {
  await app.close().catch(() => {});
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n[e2e] ALL PASSED' : `\n[e2e] ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
