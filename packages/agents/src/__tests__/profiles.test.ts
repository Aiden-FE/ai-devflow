import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProfileMaterializer, ROLE_PROFILES, BUILTIN_EXTENSIONS, validateRoleProfiles } from '../profiles.js';

const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/profiles');

describe('ProfileMaterializer', () => {
  it('materializes a self-contained standard-provider role snapshot', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const { profileDir } = m.materialize({
      role: 'coder', providerId: 'p1', providerKind: 'openai', providerRevision: 1,
      providerName: 'openai', models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    });
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(profileDir, 'SYSTEM.md'))).toBe(true);
    for (const skill of ROLE_PROFILES.coder.skills) {
      expect(existsSync(join(profileDir, 'skills', skill, 'SKILL.md'))).toBe(true);
    }
    const settings = JSON.parse(readFileSync(join(profileDir, 'settings.json'), 'utf8')) as { retry: { enabled: boolean } };
    expect(settings.retry.enabled).toBe(false);
    // standard provider → no models.json
    expect(existsSync(join(profileDir, 'models.json'))).toBe(false);
  });

  it('writes a compatible models.json referencing only the env var; idempotent and content-addressed', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const input = {
      role: 'coder' as const, providerId: 'p1', providerKind: 'openai_compatible' as const,
      providerRevision: 1, baseURL: 'https://gw.example/v1', providerName: 'ai-devflow-0123456789ab',
      models: ['gpt-5.6-sol'],
    };
    const a = m.materialize(input);
    const models = readFileSync(join(a.profileDir, 'models.json'), 'utf8');
    expect(models).toContain('AI_DEVFLOW_ACTIVE_API_KEY');
    expect(models).toContain('openai-completions');
    expect(models).toContain('https://gw.example/v1');
    // idempotent: same input → same directory
    const b = m.materialize(input);
    expect(b.profileDir).toBe(a.profileDir);
    // provider revision change → new content-addressed snapshot
    const c = m.materialize({ ...input, providerRevision: 2 });
    expect(c.profileDir).not.toBe(a.profileDir);
  });

  it('keys snapshots by provider identity and the sorted complete model set', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const input = {
      role: 'coder' as const,
      providerId: 'provider-a',
      providerKind: 'openai_compatible' as const,
      providerRevision: 7,
      baseURL: 'https://gw.example/v1',
      providerName: 'ai-devflow-provider-a',
      models: ['fallback-model', 'primary-model'],
    };

    const digest = m.digest(input);
    expect(m.digest({ ...input, models: [...input.models].reverse() })).toBe(digest);
    expect(m.digest({ ...input, providerId: 'provider-b' })).not.toBe(digest);
    expect(m.digest({ ...input, providerName: 'ai-devflow-provider-b' })).not.toBe(digest);
    expect(m.digest({ ...input, models: ['primary-model'] })).not.toBe(digest);
  });

  it('rejects and replaces a completed snapshot whose contents no longer validate', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const input = {
      role: 'coder' as const,
      providerId: 'p1',
      providerKind: 'openai_compatible' as const,
      providerRevision: 1,
      baseURL: 'https://gw.example/v1',
      providerName: 'ai-devflow-0123456789ab',
      models: ['primary-model', 'fallback-model'],
    };
    const first = m.materialize(input);
    writeFileSync(join(first.profileDir, 'models.json'), '{"tampered":true}');

    const second = m.materialize(input);
    expect(second.profileDir).toBe(first.profileDir);
    expect(readFileSync(join(second.profileDir, 'models.json'), 'utf8')).toContain('fallback-model');
    expect(readFileSync(join(second.profileDir, '.complete'), 'utf8')).toContain(first.digest);
  });

  it('materializes all four roles distinctly', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const dirs = (['planner', 'coder', 'reviewer', 'tester'] as const).map((role) =>
      m.materialize({ role, providerId: 'p1', providerKind: 'openai', providerRevision: 1, providerName: 'openai', models: ['gpt-5.6-sol'] }).profileDir,
    );
    expect(new Set(dirs).size).toBe(4);
    for (const d of dirs) expect(d).toMatch(/\/(planner|coder|reviewer|tester)$/);
  });

  it('materializes exactly the extensions declared by the role profile', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const { profileDir } = m.materialize({
      role: 'reviewer', providerId: 'p1', providerKind: 'openai', providerRevision: 1,
      providerName: 'openai', models: ['m'],
    });
    const extFiles = readdirSync(join(profileDir, 'extensions')).sort();
    expect(extFiles).toEqual(ROLE_PROFILES.reviewer.extensions.map((e) => `${e}.ts`).sort());
  });
});

describe('validateRoleProfiles', () => {
  it('passes for the built-in profiles', () => {
    expect(() => validateRoleProfiles()).not.toThrow();
  });
  it('rejects a role that references an unregistered extension', () => {
    expect(() => validateRoleProfiles(
      { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, extensions: ['event-bridge', 'ghost'] } },
      BUILTIN_EXTENSIONS,
    )).toThrow(/未注册的扩展/);
  });
});
