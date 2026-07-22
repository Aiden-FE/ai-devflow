import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { buildControlledPath } from '../env-safety.js';

describe('buildControlledPath', () => {
  it('builds a darwin PATH from trusted system dirs', () => {
    const path = buildControlledPath('darwin');
    expect(path).toContain('/usr/bin');
    expect(path).toContain('/bin');
    expect(path).toContain('/opt/homebrew/bin');
  });

  it('builds a linux PATH from trusted system dirs', () => {
    const path = buildControlledPath('linux');
    expect(path).toContain('/usr/bin');
    expect(path).toContain('/bin');
    expect(path).toContain('/snap/bin');
  });

  it('never includes user-level ($HOME-relative) directories', () => {
    const home = homedir();
    for (const platform of ['darwin', 'linux'] as const) {
      const path = buildControlledPath(platform);
      for (const dir of path.split(':')) {
        expect(dir.startsWith(home)).toBe(false);
      }
    }
  });

  it('is not equal to a verbatim user-laden PATH', () => {
    const home = homedir();
    const userPath = `${home}/.nvm/bin:${home}/.local/bin:/usr/bin:/bin`;
    expect(buildControlledPath('darwin')).not.toBe(userPath);
  });

  it('returns System32-based dirs on win32', () => {
    const path = buildControlledPath('win32', 'C:\\Windows');
    expect(path).toContain('C:\\Windows\\System32');
    expect(path.split(';')).toContain('C:\\Windows');
  });
});
