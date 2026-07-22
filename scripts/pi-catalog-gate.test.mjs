import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPiCatalogCompatibility,
  parsePiModelCatalog,
} from '../apps/desktop/scripts/pi-catalog-gate.mjs';

const CATALOG = `provider  model                 context  max-out  thinking  images
openai    gpt-test              128k     32k      yes       yes
google    gemini-test           1m       64k      no        yes
`;

const HELP = `
--thinking <level>
--extension <path>
--skill <path>
--no-context-files
Built-in tools: read, bash, edit, write, grep, find, ls
`;

test('parsePiModelCatalog extracts provider, model, and thinking support', () => {
  assert.deepEqual(parsePiModelCatalog(CATALOG), [
    { provider: 'openai', model: 'gpt-test', thinking: true },
    { provider: 'google', model: 'gemini-test', thinking: false },
  ]);
});

test('assertPiCatalogCompatibility accepts a complete model/tool/flag contract', () => {
  assert.doesNotThrow(() => assertPiCatalogCompatibility(CATALOG, HELP, {
    models: [{ provider: 'openai', model: 'gpt-test', requiresThinking: true }],
  }));
});

test('assertPiCatalogCompatibility rejects a missing configured model', () => {
  assert.throws(
    () => assertPiCatalogCompatibility(CATALOG, HELP, {
      models: [{ provider: 'openai', model: 'gpt-missing', requiresThinking: true }],
    }),
    /missing model openai\/gpt-missing/i,
  );
});

test('assertPiCatalogCompatibility rejects a model without required thinking support', () => {
  assert.throws(
    () => assertPiCatalogCompatibility(CATALOG, HELP, {
      models: [{ provider: 'google', model: 'gemini-test', requiresThinking: true }],
    }),
    /thinking unsupported google\/gemini-test/i,
  );
});

test('assertPiCatalogCompatibility rejects a missing built-in tool or required flag', () => {
  assert.throws(
    () => assertPiCatalogCompatibility(CATALOG, HELP.replace('grep', 'missing'), {
      models: [{ provider: 'openai', model: 'gpt-test', requiresThinking: true }],
    }),
    /missing built-in tool grep/i,
  );
  assert.throws(
    () => assertPiCatalogCompatibility(CATALOG, HELP.replace('--skill', '--missing'), {
      models: [{ provider: 'openai', model: 'gpt-test', requiresThinking: true }],
    }),
    /missing cli flag --skill/i,
  );
});
