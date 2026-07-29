import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatRoleCapabilities } from './inspect-roles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'inspect-roles.mjs');
const eventBridge = join(here, '..', 'packages', 'agents', 'assets', 'profiles', 'shared', 'extensions', 'event-bridge.ts');

async function reportParametersFor(resultKind) {
  const result = await build({
    stdin: {
      contents: `
        process.env.AI_DEVFLOW_RESULT_KIND = ${JSON.stringify(resultKind)};
        const { default: register } = await import(${JSON.stringify(eventBridge)});
        const tools = [];
        register({ registerTool(tool) { tools.push(tool); } });
        export const parameters = tools.find((tool) => tool.name === 'ai_devflow_report_result').parameters;
      `,
      resolveDir: here,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'typebox-test-double',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^typebox$/ }, () => ({ path: 'typebox', namespace: 'typebox-test' }));
        esbuild.onLoad({ filter: /.*/, namespace: 'typebox-test' }, () => ({
          loader: 'js',
          contents: `
            const scalar = (type, options = {}) => ({ type, ...options });
            export const Type = {
              String: (options) => scalar('string', options),
              Number: (options) => scalar('number', options),
              Integer: (options) => scalar('integer', options),
              Boolean: () => scalar('boolean'),
              Literal: (value) => ({ const: value }),
              Union: (anyOf) => ({ anyOf }),
              Array: (items, options = {}) => ({ type: 'array', items, ...options }),
              Optional: (schema) => ({ ...schema, __optional: true }),
              Unknown: () => ({}),
              Object: (properties) => {
                const required = [];
                const normalized = {};
                for (const [name, schema] of Object.entries(properties)) {
                  const { __optional, ...rest } = schema;
                  normalized[name] = rest;
                  if (!__optional) required.push(name);
                }
                return { type: 'object', properties: normalized, required };
              },
            };
          `,
        }));
      },
    }],
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return (await import(dataUrl)).parameters;
}

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

test('formatRoleCapabilities annotates each skill with its source when skillPool is provided', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction'], ['event-bridge'], { skillPool: [{ name: 'tdd', source: 'coder' }] });
  assert.match(out, /skillSources: tdd\(coder\)/);
  // 无对应注册条目时用 '?' 标注未知来源
  const outUnknown = formatRoleCapabilities({ coder: { ...mockProfiles().coder, skills: ['ghost'] } }, [], [], { skillPool: [] });
  assert.match(outUnknown, /skillSources: ghost\(\?\)/);
});

test('formatRoleCapabilities --json returns parseable object with all roles', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction'], ['event-bridge'], { json: true });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.coder.tools, ['read', 'bash', 'ai_devflow_interaction']);
  assert.deepEqual(parsed.coder.skillSources, [{ name: 'tdd', source: '?' }]);
});

test('formatRoleCapabilities --json includes skill sources when skillPool provided', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction'], ['event-bridge'], { json: true, skillPool: [{ name: 'tdd', source: 'coder' }] });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.coder.skillSources, [{ name: 'tdd', source: 'coder' }]);
});

test('script run prints all four roles and six execution experts (smoke, exercises esbuild bundle)', () => {
  const stdout = execFileSync('node', [script], { encoding: 'utf8' });
  for (const role of ['planner', 'coder', 'reviewer', 'tester']) assert.match(stdout, new RegExp(role));
  for (const expert of ['product', 'ux', 'dev_lead', 'dev', 'test', 'project_lead']) assert.match(stdout, new RegExp(expert));
});

test('script run --json parses and contains four roles and six experts', () => {
  const stdout = execFileSync('node', [script, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed.roles).sort(), ['coder', 'planner', 'reviewer', 'tester']);
  assert.deepEqual(Object.keys(parsed.experts).sort(), ['dev', 'dev_lead', 'product', 'project_lead', 'test', 'ux']);
  // 真实 BUILTIN_SKILLS 被注入：每个技能来源为角色名或 'shared'，无 '?' 占位
  for (const role of Object.keys(parsed.roles)) {
    for (const s of parsed.roles[role].skillSources) {
      assert.ok(s.source !== '?', `${role}/${s.name} 未能解析来源`);
    }
  }
});

test('event bridge requires a result-kind-specific payload schema', async () => {
  const taskExecution = await reportParametersFor('task_execution');
  assert.equal(taskExecution.properties.payload, undefined);

  const review = await reportParametersFor('task_review');
  assert.ok(review.required.includes('payload'));
  assert.equal(review.properties.payload.properties.kind.const, 'task_review');
  const noneAssessment = review.properties.payload.properties.knowledgeAssessment.anyOf[0];
  assert.equal(noneAssessment.properties.evidence.minItems, 1);

  for (const kind of [
    'knowledge_initialization',
    'knowledge_audit',
    'knowledge_repair',
    'knowledge_deposition',
    'iteration_changelog',
  ]) {
    const parameters = await reportParametersFor(kind);
    assert.ok(parameters.required.includes('payload'), `${kind} payload must be required`);
    assert.equal(parameters.properties.payload.properties.kind.const, kind);
  }
});
