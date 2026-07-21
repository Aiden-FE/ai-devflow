#!/usr/bin/env node
// Release Notes / CHANGELOG 生成器（零依赖，Node 22+）。
//
// 设计原则：
// - 纯逻辑函数（parseCommit / isNoise / categorize / formatReleaseNotes /
//   findPrevTag / compareSemverTag / mergeIntoChangelog）全部导出，供 node:test 单测，
//   不依赖 git，可在任意环境断言。
// - 仅当作为 CLI 直接运行时才 spawn git（main），读取 prevTag..HEAD 的提交。
//
// 语义：
// - 一段 Release Notes 只描述「上一版本 tag → 当前版本」之间的变化。
// - 按「新功能 / 问题修复 / 其他变更」分组；过滤 merge、版本号提交、dependabot 等噪音。
// - 附 GitHub compare 链接；正文面向用户，不是原始 commit log 堆砌。
//
// 用法（发版工作流 prepare 阶段调用）：
//   node scripts/gen-changelog.mjs <version> [--repo owner/repo] \
//        [--out RELEASE_NOTES.md] [--update-changelog CHANGELOG.md]
//   - <version> 不含 v 前缀（如 0.1.0）。
//   - --out 输出本轮 Release 正文（供 gh release create -F 使用）。
//   - --update-changelog 将本轮小节prepend 到仓库 CHANGELOG.md（保持与 Release 正文一致）。

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

export const CATEGORY_TITLES = {
  feat: '新功能',
  fix: '问题修复',
  other: '其他变更',
};

/** 解析一行 `git log --pretty=format:%H\t%s` 输出为结构化提交。 */
export function parseCommit(line) {
  const trimmed = line.replace(/\r$/, '');
  const idx = trimmed.indexOf('\t');
  const hash = idx >= 0 ? trimmed.slice(0, idx) : '';
  const subject = (idx >= 0 ? trimmed.slice(idx + 1) : trimmed).trim();
  // 约定式前缀：type(scope)!: desc 或 type: desc
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
  if (m) {
    return {
      hash,
      type: m[1].toLowerCase(),
      scope: (m[2] || '').trim(),
      breaking: Boolean(m[3]),
      desc: m[4].trim(),
      raw: subject,
    };
  }
  return { hash, type: '', scope: '', breaking: false, desc: subject, raw: subject };
}

/** 是否为不应进入用户可见 Release Notes 的噪音提交。 */
export function isNoise(commit) {
  const s = (commit.raw || commit.desc || '').trim();
  if (!s) return true;
  if (/^merge\b/i.test(s)) return true; // merge commit
  if (/^merge pull request/i.test(s)) return true;
  if (/^chore\(release\)/i.test(s)) return true; // 版本号提交 chore(release): vX
  if (/^chore:\s*release\b/i.test(s)) return true;
  if (/^v?\d+\.\d+\.\d+(-[\w.-]+)?\s*$/.test(s)) return true; // 纯版本号
  if (/^bump\b/i.test(s)) return true; // dependabot / renovate bump
  if (/^dependabot\b/i.test(s)) return true;
  if (/^update (lockfile|dependencies)/i.test(s)) return true;
  return false;
}

/** 将提交分类为 feat / fix / other 三组（先过滤噪音）。 */
export function categorize(commits) {
  const sections = { feat: [], fix: [], other: [] };
  for (const raw of commits) {
    const c = raw.type === undefined ? parseCommit(raw) : raw;
    if (isNoise(c)) continue;
    if (c.type === 'feat') sections.feat.push(c);
    else if (c.type === 'fix') sections.fix.push(c);
    else sections.other.push(c);
  }
  return sections;
}

/** 单条变更条目：保留 scope 语义与短哈希，去掉约定式前缀，面向用户。 */
export function formatEntry(c) {
  const scope = c.scope ? `**${c.scope}**：` : '';
  const short = c.hash ? `（${c.hash.slice(0, 7)}）` : '';
  const bang = c.breaking ? '【破坏性】' : '';
  return `- ${bang}${scope}${c.desc}${short}`;
}

/**
 * 生成一段 Release Notes（Markdown）。
 * @param {{version:string, prevTag?:string, repo:string, commits:Array}} opts
 */
export function formatReleaseNotes({ version, prevTag, repo, commits }) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const sections = categorize(commits);
  const lines = [`## ${tag}`];
  if (prevTag) {
    const compare = `https://github.com/${repo}/compare/${prevTag}...${tag}`;
    lines.push('', `变更范围：[${prevTag}...${tag}](${compare})`);
  }
  const blocks = [
    [CATEGORY_TITLES.feat, sections.feat],
    [CATEGORY_TITLES.fix, sections.fix],
    [CATEGORY_TITLES.other, sections.other],
  ];
  let any = false;
  for (const [title, items] of blocks) {
    if (items.length === 0) continue;
    any = true;
    lines.push('', `### ${title}`);
    for (const c of items) lines.push(formatEntry(c));
  }
  if (!any) {
    lines.push('', '_本轮无面向用户的变更说明。_');
  }
  return lines.join('\n');
}

function semverParts(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(String(tag).trim());
  if (!m) return { major: 0, minor: 0, patch: 0, pre: '', raw: String(tag) };
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '', raw: String(tag) };
}

/** 语义化比较两个 tag（含预发布号）。返回 <0 / 0 / >0。 */
export function compareSemverTag(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // 无预发布 > 有预发布
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

/**
 * 在已知 tag 列表中找出「小于当前版本」的最高 tag（即上一版本）。
 * @param {string} currentVersion 不含或含 v 前缀均可
 * @param {string[]} tags 例如 ['v0.0.2','v0.0.3']
 * @returns {string|undefined}
 */
export function findPrevTag(currentVersion, tags) {
  const cur = currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`;
  const sorted = [...(tags || [])]
    .map((t) => String(t).trim())
    .filter(Boolean)
    .sort(compareSemverTag);
  let prev;
  for (const t of sorted) {
    if (compareSemverTag(t, cur) < 0) prev = t;
    else break;
  }
  return prev;
}

const CHANGELOG_HEADER = `# 更新日志（CHANGELOG）

本文件记录各版本面向用户的变更。由发版工作流自动维护：每次发版时，
\`scripts/gen-changelog.mjs\` 会生成「上一版本 tag → 当前版本」的小节并 prepend 到此处，
GitHub Release 正文与本文件对应小节保持一致。

分组：新功能 / 问题修复 / 其他变更；自动过滤 merge、版本号提交等噪音，并附 compare 链接。
`;

/**
 * 将本轮小节合并进整份 CHANGELOG 文本：保留文件头部说明，按版本倒序排列小节。
 * 若已存在同版本小节则替换（幂等，重跑不发胖）。
 * @param {string|undefined} existing 现有 CHANGELOG.md 文本（可空）
 * @param {string} section 本轮 formatReleaseNotes 结果（以 `## vX` 开头）
 * @param {string} version 不含 v 前缀
 */
export function mergeIntoChangelog(existing, section, version) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const heading = `## ${tag}`;
  let body = existing && existing.trim() ? existing : CHANGELOG_HEADER;
  // 拆出头部（首个 `## ` 之前的内容）与既有小节
  const firstSection = body.search(/^## /m);
  let header;
  let rest;
  if (firstSection === -1) {
    header = body.trimEnd();
    rest = '';
  } else {
    header = body.slice(0, firstSection).trimEnd();
    rest = body.slice(firstSection);
  }
  if (!header.trim()) header = CHANGELOG_HEADER.trimEnd();
  // 移除既有的同版本小节（幂等）
  if (rest) {
    const lines = rest.split('\n');
    const out = [];
    let skip = false;
    for (const ln of lines) {
      if (/^## /.test(ln)) {
        skip = ln.trim() === heading || ln.startsWith(`${heading} `);
      }
      if (!skip) out.push(ln);
    }
    rest = out.join('\n').replace(/^\s+/, '');
  }
  const parts = [header, '', section.trimEnd()];
  if (rest.trim()) parts.push('', rest.trimEnd());
  return `${parts.join('\n')}\n`;
}

// ----------------------------- CLI -----------------------------

function getOpt(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function main(argv = process.argv.slice(2)) {
  const version = argv[0];
  if (!version) {
    console.error('用法: gen-changelog.mjs <version> [--repo owner/repo] [--out FILE] [--update-changelog FILE]');
    process.exit(1);
  }
  const repo = getOpt(argv, '--repo') || process.env.GITHUB_REPOSITORY || 'Aiden-FE/ai-devflow';
  const out = getOpt(argv, '--out');
  const updateChangelog = getOpt(argv, '--update-changelog');

  const tags = git(['tag', '--list', 'v*']).split('\n').map((s) => s.trim()).filter(Boolean);
  const prevTag = findPrevTag(version, tags);
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const log = git(['log', range, '--pretty=format:%H\t%s']).split('\n').filter(Boolean);
  const commits = log.map(parseCommit);
  const notes = formatReleaseNotes({ version, prevTag, repo, commits });

  if (out) {
    // 写入 Release 正文文件（不带顶部 `## vX` 标题更适合 Release，标题由 gh 提供）。
    const releaseBody = notes.replace(/^## [^\n]*\n/, '').trimStart();
    writeFileSync(out, releaseBody, 'utf8');
    console.error(`[gen-changelog] 已写入 ${out}（prev=${prevTag || '(首版)'}，${commits.length} 条提交）`);
  }
  if (updateChangelog) {
    let existing;
    try {
      existing = readFileSync(updateChangelog, 'utf8');
    } catch {
      existing = undefined;
    }
    writeFileSync(updateChangelog, mergeIntoChangelog(existing, notes, version), 'utf8');
    console.error(`[gen-changelog] 已更新 ${updateChangelog}`);
  }
  if (!out && !updateChangelog) {
    // 无输出目标时打印到 stdout，便于调试。
    process.stdout.write(`${notes}\n`);
  }
}

// 仅在直接运行时执行 CLI（被 import 时不执行，便于测试）。
const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
