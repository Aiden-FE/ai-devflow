// 维护者自检：打印各内置角色生效的 tools/skills/extensions。
// 直接运行时用 esbuild 打包 packages/agents/src/profiles.ts 读取真实常量（仓库无 tsx、agents 无 dist）。
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILES_SRC = join(here, '..', 'packages', 'agents', 'src', 'profiles.ts');

/**
 * 纯函数：把角色能力格式化为文本或 JSON。供测试直接调用，不触发 esbuild。
 * @param {Record<string, {role:string;version:number;tools:string[];excludedTools:string[];skills:string[];extensions:string[];timeoutMs:number;systemPromptFile?:string}>} profiles
 * @param {string[]} internalTools
 * @param {string[]} builtinExtensions  注册池（仅用于注释，不改变输出）
 * @param {{json?:boolean; skillPool?: {name:string;source:string}[]}} [opts]
 *   skillPool 提供时，输出每个技能的物理来源（source=角色名或 'shared'），便于调试共享/跨角色借用技能。
 */
export function formatRoleCapabilities(profiles, internalTools, builtinExtensions, opts = {}) {
  const skillByName = new Map((opts.skillPool ?? []).map((s) => [s.name, s]));
  const roles = Object.values(profiles);
  const view = Object.fromEntries(roles.map((p) => {
    const tools = [...p.tools, ...internalTools];
    const skillSources = p.skills.map((name) => skillByName.get(name) ?? { name, source: '?' });
    return [p.role, { version: p.version, tools, excludedTools: p.excludedTools, skills: p.skills, skillSources, extensions: p.extensions, timeoutMs: p.timeoutMs, systemPromptFile: p.systemPromptFile }];
  }));
  if (opts.json) return JSON.stringify(view, null, 2);
  const lines = [`# 内置角色生效能力（internal tools: ${internalTools.join(', ')}）`, ''];
  for (const p of roles) {
    lines.push(`## ${p.role} (v${p.version})`);
    lines.push(`- tools: ${[...p.tools, ...internalTools].join(', ')}`);
    if (p.excludedTools.length) lines.push(`- excludedTools: ${p.excludedTools.join(', ')}`);
    lines.push(`- skills: ${p.skills.join(', ')}`);
    const sources = p.skills.map((name) => {
      const entry = skillByName.get(name);
      return entry ? `${name}(${entry.source})` : `${name}(?)`;
    });
    lines.push(`- skillSources: ${sources.join(', ')}`);
    lines.push(`- extensions: ${p.extensions.join(', ')}`);
    lines.push(`- timeoutMs: ${p.timeoutMs}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function loadProfiles() {
  const entry = join(mkdtempSync(join(tmpdir(), 'inspect-roles-')), 'entry.mjs');
  writeFileSync(entry, `export { ROLE_PROFILES, INTERNAL_TOOLS, BUILTIN_EXTENSIONS, BUILTIN_SKILLS } from '${PROFILES_SRC.replace(/\\/g, '/')}';\n`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['node:*'],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(dataUrl);
}

async function main() {
  const { ROLE_PROFILES, INTERNAL_TOOLS, BUILTIN_EXTENSIONS, BUILTIN_SKILLS } = await loadProfiles();
  const json = process.argv.includes('--json');
  process.stdout.write(formatRoleCapabilities(ROLE_PROFILES, [...INTERNAL_TOOLS], [...BUILTIN_EXTENSIONS], { json, skillPool: [...BUILTIN_SKILLS] }) + '\n');
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
