// 生产 Pi 运行时装配（设计 §6/§8/§9）：ProviderStore + ProviderRouter + BundledPiLocator +
// ProfileMaterializer + PiProcessSupervisor + PiRunner。开发模式从 staging 目录或 workspace 解析 Pi；
// 打包模式从 resources/pi-runtime 解析并要求角色资源齐全。运行时不可用时不抛错崩溃，而是返回一个
// verify/run 皆可恢复失败的 runner（任务级失败提示「应用运行组件损坏」，提供商 CRUD 仍可用）。
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  BundledPiLocator,
  buildProbeEnv,
  PiProcessSupervisor,
  PiRunner,
  ProfileMaterializer,
  ProviderRouter,
  type ProviderHealthStore,
  type RuntimeLocator,
} from '@ai-devflow/agents';
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
import type { Repositories } from '@ai-devflow/persistence';
import { decryptProviderSecret, encryptProviderSecret } from './credentials.js';
import { ProviderStore } from './provider-store.js';

const execFileP = promisify(execFile);
export const EXPECTED_PI_VERSION = '0.80.10';

/** 始终失败的 locator：运行时不可用（无法解析内置 Pi）时的安全占位。 */
class UnavailableLocator implements RuntimeLocator {
  constructor(private reason: string) {}
  async verify(): Promise<{ version: string; entry: string }> {
    throw new Error(`应用运行组件损坏：${this.reason}`);
  }
}

/** 开发模式 locator：直接执行解析到的 Pi 入口并校验版本（无 manifest 要求）。 */
class DevPiLocator implements RuntimeLocator {
  constructor(private entry: string) {}
  async verify(): Promise<{ version: string; entry: string }> {
    const { stdout } = await execFileP(process.execPath, [this.entry, '--version'], {
      env: buildProbeEnv(process.env),
    });
    const version = String(stdout).trim();
    if (version !== EXPECTED_PI_VERSION) {
      throw new Error(`应用运行组件损坏：Pi 版本不匹配（期望 ${EXPECTED_PI_VERSION}，实际 ${version}）`);
    }
    return { entry: this.entry, version };
  }
}

function resolveDevEntry(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve('@earendil-works/pi-coding-agent/package.json');
  const pkg = req(pkgPath) as { bin?: string | { pi?: string } };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error('Pi 包缺少 bin.pi');
  return join(dirname(pkgPath), bin);
}

export function createRuntimeLocator(): RuntimeLocator {
  try {
    if (app.isPackaged) {
      return new BundledPiLocator(join(process.resourcesPath, 'pi-runtime'), { requireProfiles: true });
    }
    // 开发：优先用已 staging 的 build/pi-runtime（含 manifest），否则从 workspace 解析精确依赖。
    const repoRoot = join(app.getAppPath(), '..', '..');
    const staged = join(app.getAppPath(), 'build', 'pi-runtime');
    if (existsSync(join(staged, 'runtime-manifest.json'))) {
      return new BundledPiLocator(staged);
    }
    return new DevPiLocator(resolveDevEntryFrom(repoRoot));
  } catch (err) {
    return new UnavailableLocator(err instanceof Error ? err.message : String(err));
  }
}

function resolveDevEntryFrom(repoRoot: string): string {
  // 从 monorepo 根的 pnpm 虚拟存储解析精确 Pi 依赖（开发模式，desktop 未直接依赖该包）。
  const req = createRequire(join(repoRoot, 'package.json'));
  try {
    return resolveDevEntryVia(req);
  } catch {
    return resolveDevEntry();
  }
}

function resolveDevEntryVia(req: NodeRequire): string {
  const pkgPath = req.resolve('@earendil-works/pi-coding-agent/package.json');
  const pkg = req(pkgPath) as { bin?: string | { pi?: string } };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error('Pi 包缺少 bin.pi');
  return join(dirname(pkgPath), bin);
}

function assetsRootFor(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'pi-runtime', 'profiles');
  return join(app.getAppPath(), '..', '..', 'packages', 'agents', 'assets', 'profiles');
}

export interface PiRuntimeServices {
  runner: PiRunner;
  providerStore: ProviderStore;
  locator: RuntimeLocator;
  router: ProviderRouter;
}

export function createPiRuntime(repos: Repositories, userData: string): PiRuntimeServices {
  const cipher = { encrypt: encryptProviderSecret, decrypt: decryptProviderSecret };
  const providerStore = new ProviderStore(
    {
      get: (k) => repos.credentials.get(k),
      upsert: (k, v) => repos.credentials.upsert(k, v),
      delete: (k) => repos.credentials.delete(k),
      transaction: (fn) => repos.credentials.transaction(fn),
    },
    cipher,
    (providerId) => repos.providerHealth.clearProvider(providerId),
  );

  const health: ProviderHealthStore = {
    get: (providerId, routeId) => repos.providerHealth.get(providerId, routeId),
    listByProvider: (providerId) => repos.providerHealth.listByProvider(providerId),
    upsert: (value: ProviderHealth) => repos.providerHealth.upsert(value),
    clearProvider: (providerId) => repos.providerHealth.clearProvider(providerId),
  };

  const router = new ProviderRouter({
    listProviders: (): ProviderConfig[] => providerStore.listConfigs(),
    resolveSecret: (providerId) => providerStore.resolveSecret(providerId),
    health,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const locator = createRuntimeLocator();
  const sessionsBaseDir = join(userData, 'pi-runtime', 'sessions');
  const materializer = new ProfileMaterializer(assetsRootFor(), join(userData, 'pi-runtime'));
  const supervisor = new PiProcessSupervisor();

  const runner = new PiRunner({
    locator,
    router,
    materializer,
    supervisor,
    sessionsBaseDir,
    projectToolPath: process.env.PATH ?? '/usr/bin:/bin',
    attempts: repos.executionAttempts,
  });

  return { runner, providerStore, locator, router };
}
