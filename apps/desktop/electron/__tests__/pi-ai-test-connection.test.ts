// 集成验证「测试连接」端到端：用真实内置 Pi 二进制 + 本地 fake 401 provider，确认 testConnection
// 返回的真实错误根因（如 401）而非泛化「所有已配置 AI 服务暂时不可用」。
// 无 staged Pi runtime 时自动跳过（与 real-pi.test.ts 同一前置条件）。
import { existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
import {
  BundledPiLocator,
  PiProcessSupervisor,
  ProviderRouter,
  buildControlledPath,
  type ProviderHealthStore,
} from '@ai-devflow/agents';
import { createPiAiService, createProductionTextExecutor } from '../pi-ai.js';

const here = dirname(fileURLToPath(import.meta.url));
const STAGE_DIR = join(here, '..', '..', 'build', 'pi-runtime');
const HAVE_RUNTIME = existsSync(join(STAGE_DIR, 'runtime-manifest.json'));

describe.skipIf(!HAVE_RUNTIME)('testConnection surfaces the real provider error', () => {
  it('returns the 401 root cause instead of the generic unreachable message', async () => {
    // fake provider: always 401 on /chat/completions
    const server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseURL = `http://127.0.0.1:${port}`;

    const provider: ProviderConfig = {
      id: 'fake-401', kind: 'openai_compatible', displayName: 'Fake 401',
      enabled: true, priority: 0, authType: 'api_key', credentialRef: 'provider:fake-401',
      baseURL, defaultModel: 'fake-model', revision: 1,
    };
    const healthValues = new Map<string, ProviderHealth>();
    const health: ProviderHealthStore = {
      get: (pid, rid) => healthValues.get(`${pid}\0${rid}`),
      listByProvider: (pid) => [...healthValues.values()].filter((v) => v.providerId === pid),
      upsert: (v) => { healthValues.set(`${v.providerId}\0${v.routeId}`, v); },
      clearProvider: (pid) => { for (const [k, v] of healthValues) if (v.providerId === pid) healthValues.delete(k); },
    };
    const router = new ProviderRouter({
      listProviders: () => [provider],
      resolveSecret: () => 'fake-secret-value',
      health,
      now: () => Date.now(),
      sleep: async () => undefined,
    });
    const locator = new BundledPiLocator(STAGE_DIR, { requireProfiles: true });
    const executor = createProductionTextExecutor({
      locator,
      router,
      supervisor: new PiProcessSupervisor(),
      sessionsBaseDir: mkdtempSync(join(tmpdir(), 'aidf-testconn-')),
      projectToolPath: buildControlledPath(),
    });
    const ai = createPiAiService(executor);

    const result = await ai.testConnection('fake-401');

    server.close();
    expect(result.ok).toBe(false);
    expect(result.providerId).toBe('fake-401');
    // 真实根因：包含 401 状态与提供商错误说明，而非泛化的「所有已配置 AI 服务暂时不可用」。
    expect(result.error).toContain('401');
    expect(result.error).not.toContain('所有已配置 AI 服务');
  }, 120_000);
});
