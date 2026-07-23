import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatRoleCapabilities } from './inspect-roles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'inspect-roles.mjs');

function mockProfiles() {
  return {
    coder: { role: 'coder', version: 1, systemPromptFile: 'SYSTEM.md', tools: ['read', 'bash'], excludedTools: [], skills: ['tdd'], extensions: ['event-bridge', 'structured-result'], timeoutMs: 1000 },
  };
}

test('formatRoleCapabilities lists tools union internal tools, skills, extensions per role', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction', 'ai_devflow_report_result'], ['event-bridge', 'structured-result', 'execution-policy']);
  assert.match(out, /coder/);
  assert.match(out, /read, bash, ai_devflow_interaction, ai_devflow_report_result/);
  assert.match(out, /tdd/);
  assert.match(out, /event-bridge, structured-result/);
});

test('formatRoleCapabilities --json returns parseable object with all roles', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction'], ['event-bridge'], { json: true });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.coder.tools, ['read', 'bash', 'ai_devflow_interaction']);
});

test('script run prints all four roles (smoke, exercises esbuild bundle)', () => {
  const stdout = execFileSync('node', [script], { encoding: 'utf8' });
  for (const role of ['planner', 'coder', 'reviewer', 'tester']) assert.match(stdout, new RegExp(role));
});

test('script run --json parses and contains four roles', () => {
  const stdout = execFileSync('node', [script, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['coder', 'planner', 'reviewer', 'tester']);
});
