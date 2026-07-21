import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProfileMaterializer, ROLE_PROFILES } from '../profiles.js';

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

  it('materializes all four roles distinctly', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const dirs = (['planner', 'coder', 'reviewer', 'tester'] as const).map((role) =>
      m.materialize({ role, providerId: 'p1', providerKind: 'openai', providerRevision: 1, providerName: 'openai', models: ['gpt-5.6-sol'] }).profileDir,
    );
    expect(new Set(dirs).size).toBe(4);
    for (const d of dirs) expect(d).toMatch(/\/(planner|coder|reviewer|tester)$/);
  });
});
