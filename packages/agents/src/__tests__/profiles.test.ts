import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProfileMaterializer, ROLE_PROFILES, BUILTIN_EXTENSIONS, BUILTIN_SKILLS, validateRoleProfiles, type BuiltinSkill } from '../profiles.js';

const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/profiles');

/** 在临时 assetsRoot 下写入一个技能文件（source 为角色名或 'shared'）。 */
function writeSkillFixture(root: string, source: string, name: string, body: string): void {
  const dir = join(root, source, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

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

  it('materializes a shared skill (source=shared) into the role snapshot', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-shared-'));
    const assets = mkdtempSync(join(tmpdir(), 'profiles-shared-assets-'));
    writeSkillFixture(assets, 'coder', 'test-driven-development', '---\nname: test-driven-development\n---\n# TDD\n');
    writeSkillFixture(assets, 'shared', 'git-hygiene', '---\nname: git-hygiene\n---\n# Git hygiene\n');
    const profiles = { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, skills: ['test-driven-development', 'git-hygiene'] } };
    const skillPool: readonly BuiltinSkill[] = [
      { name: 'test-driven-development', source: 'coder' },
      { name: 'git-hygiene', source: 'shared' },
    ];
    const m = new ProfileMaterializer(assets, base, profiles, skillPool);
    const { profileDir } = m.materialize({
      role: 'coder', providerId: 'p1', providerKind: 'openai', providerRevision: 1,
      providerName: 'openai', models: ['m'],
    });
    // 共享技能从 shared/skills/ 拷入
    expect(existsSync(join(profileDir, 'skills', 'git-hygiene', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(profileDir, 'skills', 'git-hygiene', 'SKILL.md'), 'utf8')).toContain('# Git hygiene');
    // 角色私有技能仍由 cpSync 带入
    expect(existsSync(join(profileDir, 'skills', 'test-driven-development', 'SKILL.md'))).toBe(true);
  });

  it('materializes a cross-role borrowed skill (source=other role) into the borrowing role snapshot', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-borrow-'));
    const assets = mkdtempSync(join(tmpdir(), 'profiles-borrow-assets-'));
    writeSkillFixture(assets, 'reviewer', 'code-review', '---\nname: code-review\n---\n# Review\n');
    // coder 目录需存在供 cpSync 拷角色骨架
    mkdirSync(join(assets, 'coder'), { recursive: true });
    const profiles = { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, skills: ['code-review'] } };
    const skillPool: readonly BuiltinSkill[] = [{ name: 'code-review', source: 'reviewer' }];
    const m = new ProfileMaterializer(assets, base, profiles, skillPool);
    const { profileDir } = m.materialize({
      role: 'coder', providerId: 'p1', providerKind: 'openai', providerRevision: 1,
      providerName: 'openai', models: ['m'],
    });
    expect(existsSync(join(profileDir, 'skills', 'code-review', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(profileDir, 'skills', 'code-review', 'SKILL.md'), 'utf8')).toContain('# Review');
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
  it('rejects a role that references an unregistered skill', () => {
    expect(() => validateRoleProfiles(
      { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, skills: [...ROLE_PROFILES.coder.skills, 'ghost'] } },
      BUILTIN_EXTENSIONS,
      BUILTIN_SKILLS,
    )).toThrow(/未注册的技能/);
  });
  it('allows a role to reference another role\'s non-shared skill (cross-role borrow)', () => {
    expect(() => validateRoleProfiles(
      { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, skills: ['code-review'] } },
      BUILTIN_EXTENSIONS,
      BUILTIN_SKILLS,
    )).not.toThrow();
  });
  it('allows a role to reference a shared skill', () => {
    expect(() => validateRoleProfiles(
      { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, skills: ['git-hygiene'] } },
      BUILTIN_EXTENSIONS,
      [...BUILTIN_SKILLS, { name: 'git-hygiene', source: 'shared' }],
    )).not.toThrow();
  });
});
