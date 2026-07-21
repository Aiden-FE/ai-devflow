// gen-changelog.mjs 纯逻辑单测（node:test，零配置：node --test scripts/）。
// 覆盖：提交解析、噪音过滤、分组、Release Notes 排版、上一版本 tag 选择、CHANGELOG 合并幂等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommit,
  isNoise,
  categorize,
  formatReleaseNotes,
  findPrevTag,
  compareSemverTag,
  mergeIntoChangelog,
} from './gen-changelog.mjs';

test('parseCommit 解析约定式前缀（含 scope 与破坏性标记）', () => {
  const c = parseCommit('abc1234\tfeat(updater): 支持立即升级');
  assert.equal(c.hash, 'abc1234');
  assert.equal(c.type, 'feat');
  assert.equal(c.scope, 'updater');
  assert.equal(c.breaking, false);
  assert.equal(c.desc, '支持立即升级');

  const b = parseCommit('def456\trefactor!: 重写状态机');
  assert.equal(b.type, 'refactor');
  assert.equal(b.breaking, true);
  assert.equal(b.desc, '重写状态机');

  const free = parseCommit('999\t随便写的一句话');
  assert.equal(free.type, '');
  assert.equal(free.desc, '随便写的一句话');
});

test('isNoise 过滤 merge / 版本号 / dependabot，但保留正常提交', () => {
  assert.equal(isNoise(parseCommit('a\tMerge pull request #1 from x/y')), true);
  assert.equal(isNoise(parseCommit('a\tMerge branch main')), true);
  assert.equal(isNoise(parseCommit('a\tchore(release): v0.0.3')), true);
  assert.equal(isNoise(parseCommit('a\t0.0.3')), true);
  assert.equal(isNoise(parseCommit('a\tv0.0.3')), true);
  assert.equal(isNoise(parseCommit('a\tBump deps')), true);
  assert.equal(isNoise(parseCommit('a\tfix(pi): 修复检测')), false);
  assert.equal(isNoise(parseCommit('a\tfeat: 新功能')), false);
});

test('categorize 按 feat/fix/other 分组并过滤噪音', () => {
  const commits = [
    'a\tfeat(ui): 聊天窗口',
    'b\tfix(updater): 立即升级无反应',
    'c\tchore(release): v0.0.2',
    'd\tMerge branch',
    'e\tdocs: 更新 README',
  ].map(parseCommit);
  const s = categorize(commits);
  assert.equal(s.feat.length, 1);
  assert.equal(s.fix.length, 1);
  assert.equal(s.other.length, 1); // docs -> other
  assert.equal(s.other[0].desc, '更新 README');
});

test('formatReleaseNotes 生成面向用户的分组正文与 compare 链接', () => {
  const commits = [
    'aaaaaaa\tfeat(lang): 设置页新增界面语言',
    'bbbbbbb\tfix(pi): 修复 Node 运行时不兼容',
    'ccccccc\tchore(release): v0.0.2',
  ].map(parseCommit);
  const notes = formatReleaseNotes({ version: '0.1.0', prevTag: 'v0.0.2', repo: 'Aiden-FE/ai-devflow', commits });
  assert.match(notes, /## v0\.1\.0/);
  assert.match(notes, /compare\/v0\.0\.2\.\.\.v0\.1\.0/);
  assert.match(notes, /### 新功能/);
  assert.match(notes, /### 问题修复/);
  assert.match(notes, /\*\*lang\*\*：设置页新增界面语言（aaaaaaa）/);
  // 版本号提交被过滤
  assert.doesNotMatch(notes, /chore\(release\)/);
});

test('formatReleaseNotes 无变更时给出占位说明', () => {
  const notes = formatReleaseNotes({ version: '0.0.3', prevTag: 'v0.0.2', repo: 'o/r', commits: [parseCommit('a\tchore(release): v0.0.3')] });
  assert.match(notes, /本轮无面向用户的变更说明/);
});

test('compareSemverTag 正确排序（含预发布）', () => {
  assert.ok(compareSemverTag('v0.0.2', 'v0.0.3') < 0);
  assert.ok(compareSemverTag('v0.1.0', 'v0.0.9') > 0);
  assert.equal(compareSemverTag('v1.2.3', 'v1.2.3'), 0);
  assert.ok(compareSemverTag('v1.0.0-beta.1', 'v1.0.0') < 0); // 预发布 < 正式
});

test('findPrevTag 选择小于当前版本的最高 tag', () => {
  assert.equal(findPrevTag('0.1.0', ['v0.0.2', 'v0.0.3', 'v0.1.0']), 'v0.0.3');
  assert.equal(findPrevTag('0.0.3', ['v0.0.2']), 'v0.0.2');
  assert.equal(findPrevTag('0.0.1', ['v0.0.2']), undefined); // 首版无前序
  assert.equal(findPrevTag('1.0.0', []), undefined);
});

test('mergeIntoChangelog 倒序插入且幂等（重跑不重复）', () => {
  const v1 = formatReleaseNotes({ version: '0.0.2', prevTag: undefined, repo: 'o/r', commits: [parseCommit('a\tfeat: 初始')] });
  const v2 = formatReleaseNotes({ version: '0.0.3', prevTag: 'v0.0.2', repo: 'o/r', commits: [parseCommit('b\tfix: 修复')] });
  let doc = mergeIntoChangelog(undefined, v1, '0.0.2');
  doc = mergeIntoChangelog(doc, v2, '0.0.3');
  // v0.0.3 应出现在 v0.0.2 之前（倒序）
  assert.ok(doc.indexOf('## v0.0.3') < doc.indexOf('## v0.0.2'));
  assert.match(doc, /# 更新日志/);
  // 幂等：再次合并 v0.0.3 不产生重复小节
  const before = doc;
  doc = mergeIntoChangelog(doc, v2, '0.0.3');
  assert.equal(doc, before);
});
