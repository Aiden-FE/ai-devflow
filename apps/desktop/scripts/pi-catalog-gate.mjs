import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REQUIRED_PI_MODELS = [
  ['anthropic', 'claude-sonnet-5'],
  ['anthropic', 'claude-sonnet-4-6'],
  ['anthropic', 'claude-sonnet-4-5'],
  ['openai', 'gpt-5.6-terra'],
  ['openai', 'gpt-5.4'],
  ['openai', 'gpt-5.6-sol'],
  ['openai', 'gpt-5.6-luna'],
  ['openai', 'gpt-5.4-mini'],
  ['google', 'gemini-3.1-pro-preview'],
  ['google', 'gemini-2.5-pro'],
  ['google', 'gemini-3.5-flash'],
  ['google', 'gemini-2.5-flash'],
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-v4-flash'],
  ['openrouter', 'anthropic/claude-sonnet-5'],
  ['openrouter', 'anthropic/claude-sonnet-4.6'],
  ['openrouter', 'openai/gpt-5.6-sol'],
  ['openrouter', 'openai/gpt-5.6-terra'],
  ['openrouter', 'deepseek/deepseek-v4-flash'],
  ['openrouter', 'google/gemini-3.5-flash'],
].map(([provider, model]) => ({ provider, model, requiresThinking: true }));

const REQUIRED_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const REQUIRED_FLAGS = ['--thinking', '--extension', '--skill', '--no-context-files'];
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function parsePiModelCatalog(output) {
  const rows = [];
  for (const line of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || fields[0] === 'provider') continue;
    rows.push({
      provider: fields[0],
      model: fields[1],
      thinking: fields[4].toLowerCase() === 'yes',
    });
  }
  return rows;
}

export function assertPiCatalogCompatibility(catalogOutput, helpOutput, opts = {}) {
  const models = opts.models ?? REQUIRED_PI_MODELS;
  const catalog = new Map(parsePiModelCatalog(catalogOutput).map((row) => [
    `${row.provider}\0${row.model}`,
    row,
  ]));
  for (const expected of models) {
    const key = `${expected.provider}\0${expected.model}`;
    const actual = catalog.get(key);
    if (!actual) throw new Error(`missing model ${expected.provider}/${expected.model}`);
    if (expected.requiresThinking && !actual.thinking) {
      throw new Error(`thinking unsupported ${expected.provider}/${expected.model}`);
    }
  }

  const help = helpOutput.replace(ANSI_ESCAPE, '');
  for (const tool of REQUIRED_TOOLS) {
    if (!new RegExp(`\\b${tool}\\b`).test(help)) throw new Error(`missing built-in tool ${tool}`);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!help.includes(flag)) throw new Error(`missing CLI flag ${flag}`);
  }
}

function cleanProbeEnv(probeRoot) {
  const env = {
    HOME: probeRoot,
    PI_CODING_AGENT_DIR: join(probeRoot, 'config'),
    PI_CODING_AGENT_SESSION_DIR: join(probeRoot, 'sessions'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ELECTRON_RUN_AS_NODE: '1',
    // Non-secret sentinels make every built-in provider visible to --list-models.
    ANTHROPIC_API_KEY: 'offline-catalog-probe',
    OPENAI_API_KEY: 'offline-catalog-probe',
    GEMINI_API_KEY: 'offline-catalog-probe',
    GOOGLE_API_KEY: 'offline-catalog-probe',
    DEEPSEEK_API_KEY: 'offline-catalog-probe',
    OPENROUTER_API_KEY: 'offline-catalog-probe',
  };
  for (const name of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
  return env;
}

export function runPiCatalogGate(entryPath) {
  const probeRoot = mkdtempSync(join(tmpdir(), 'ai-devflow-pi-catalog-'));
  try {
    const env = cleanProbeEnv(probeRoot);
    const options = { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
    const catalog = execFileSync(process.execPath, [entryPath, '--offline', '--list-models'], options);
    const help = execFileSync(process.execPath, [entryPath, '--help'], options);
    assertPiCatalogCompatibility(catalog, help);
    return { modelCount: REQUIRED_PI_MODELS.length, toolCount: REQUIRED_TOOLS.length };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
