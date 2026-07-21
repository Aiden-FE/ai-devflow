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
  // done 摘要携带 REVIEW_VERDICT: PASS，使「测试中」阶段的审查 Agent（同样由测试适配器扮演）审查通过。
  AI_DEVFLOW_TEST_CONTROL: JSON.stringify([{ type: 'log', level: 'info', text: 'working', t: 0 }, { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 }]),
  AI_DEVFLOW_TEST_RESUME_CONTROL: JSON.stringify([{ type: 'log', level: 'info', text: 'resumed', t: 0 }, { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 }]),
  // 强制审查 Agent 使用测试适配器，避免 E2E 调用真实 claude/codex/pi。
  AI_DEVFLOW_REVIEW_AGENT: 'test',
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

  // 7. 待沟通/恢复流程：暂停 -> 输入区可达 -> 回复 -> 待验收（lane-aware 恢复，待验收暂停不重跑）
  await dialog().getByRole('button', { name: '标记待沟通' }).click();
  await win.getByRole('status').first().waitFor({ timeout: 5000 }).catch(() => {});
  await win.getByText('待沟通', { exact: true }).first().waitFor({ timeout: 5000 });
  check('暂停后进入待沟通', true);
  // 输入区可达：滚动详情到底部后，composer 文本框必须落在视口内（不被裁切）
  const composer = dialog().getByRole('textbox').last();
  await composer.waitFor({ timeout: 5000 });
  await win.evaluate(() => {
    const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await win.waitForTimeout(150);
  const cbox = await composer.boundingBox();
  check('待沟通输入区始终可访问', !!cbox && cbox.y >= 0 && cbox.y + cbox.height <= 840 + 1);
  await composer.fill('补充说明 e2e');
  await dialog().getByRole('button', { name: '发送' }).click();
  await win.locator('[data-lane="in_review"] [data-task-card]').first().waitFor({ timeout: 10000 });
  check('待沟通回复后恢复到待验收', true);

  // 7b. 宽表格局部横向滚动且不撑破详情/页面
  await dialog().evaluate((root) => {
    const btn = [...root.querySelectorAll('button')].find((b) => /展开执行记录/.test(b.textContent || ''));
    btn?.click();
  }).catch(async () => { await dialog().getByRole('button', { name: /执行记录/ }).click(); });
  const wide = await win.evaluate(() => {
    const tbl = document.querySelector('table');
    if (!tbl) return { hasTable: false };
    tbl.style.minWidth = '2000px'; // 强制宽表格，验证局部滚动而非整体撑破
    const wrap = tbl.closest('[class*="overflow-x-auto"]') || tbl.parentElement;
    const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
    return {
      hasTable: true,
      wrapScrollable: (wrap?.scrollWidth ?? 0) > (wrap?.clientWidth ?? 0) + 1,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vpOverflow: vp ? vp.scrollWidth - vp.clientWidth : 0,
    };
  });
  check('宽表格局部横向滚动', !!wide.hasTable && !!wide.wrapScrollable);
  check('宽表格未撑破详情/页面', wide.docOverflow <= 2 && wide.vpOverflow <= 2);

  // 7c. 超长文本无撑破：创建超长标题/描述/连续字符串任务，在默认/最小窗口/放大三种尺寸下校验
  await win.keyboard.press('Escape');
  // 确保窗口回到默认尺寸，避免 960x640 下创建弹窗过高导致按钮被挤到视口外
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 840); });
  await win.waitForTimeout(200);
  const longWord = 'x'.repeat(300);
  const longUrl = 'https://example.com/' + 'a'.repeat(260);
  await win.getByRole('button', { name: '创建任务' }).click();
  await dialog().waitFor();
  await dialog().locator('input').nth(0).fill('Overflow ' + longWord);
  await dialog().locator('textarea').nth(0).fill('说明 ' + longUrl + ' 末 ' + longWord);
  await dialog().getByRole('combobox').nth(1).click();
  await win.getByRole('option', { name: '测试适配器' }).click();
  await dialog().getByRole('button', { name: '创建', exact: true }).click();
  await win.locator('[data-lane="ready"] [data-task-card]').filter({ hasText: 'Overflow' }).first().waitFor();
  await win.locator('[data-lane="ready"] [data-task-card]').filter({ hasText: 'Overflow' }).first().click();
  await dialog().waitFor();
  const noBleed = async () => win.evaluate(() => {
    const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
    return {
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vpOverflow: vp ? vp.scrollWidth - vp.clientWidth : 0,
    };
  });
  const assertNoBleed = async (label) => {
    await win.waitForTimeout(150);
    const r = await noBleed();
    check(`${label} 无页面级横向溢出`, r.docOverflow <= 2);
    check(`${label} 详情无横向撑破`, r.vpOverflow <= 2);
  };
  await assertNoBleed('默认尺寸(640 详情)');
  // 最小窗口 960x640
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(960, 640); });
  await assertNoBleed('最小窗口 960x640');
  // 放大模式（最小窗口下）
  await dialog().getByRole('button', { name: '放大' }).click();
  await assertNoBleed('放大模式 @960x640');
  await dialog().getByRole('button', { name: '还原' }).click();
  // 放大模式（默认窗口下）
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 840); });
  await dialog().getByRole('button', { name: '放大' }).click();
  await assertNoBleed('放大模式 @1280x840');
  await dialog().getByRole('button', { name: '还原' }).click();
  await win.keyboard.press('Escape');

  // 8. 界面语言（设置 -> 界面语言）：中文 -> English -> 中文
  await win.keyboard.press('Escape'); // 关闭任务详情侧滑窗
  await win.getByRole('button', { name: '设置' }).click();
  await win.locator('[data-testid="lang-select"]').waitFor({ timeout: 5000 });
  check('设置页包含界面语言区块', await win.getByText('界面语言').first().isVisible());
  // 切换到 English（导航文案随之变为 Settings）
  await win.locator('[data-testid="lang-select"]').click();
  await win.getByRole('option', { name: 'English' }).click();
  await win.getByRole('button', { name: 'Settings' }).first().waitFor({ timeout: 3000 });
  check('切换到 English', await win.getByRole('button', { name: 'Settings' }).first().isVisible());
  // 切换回中文（导航文案恢复为「设置」）
  await win.locator('[data-testid="lang-select"]').click();
  await win.getByRole('option', { name: '中文' }).click();
  await win.getByRole('button', { name: '设置' }).first().waitFor({ timeout: 3000 });
  check('切换回中文', await win.getByRole('button', { name: '设置' }).first().isVisible());
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
