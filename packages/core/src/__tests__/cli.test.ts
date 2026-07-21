import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  normalizeNewlines,
  collapseCarriage,
  standardizeCliOutput,
  inferLevel,
  summarizeOutput,
} from '../cli.js';

describe('CLI standardization', () => {
  it('strips ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('\x1b[1;31mERR\x1b[0m: bad')).toBe('ERR: bad');
  });

  it('removes other control chars', () => {
    expect(stripAnsi('a\x00b\x07c')).toBe('abc');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses carriage-overwritten progress lines to last segment', () => {
    expect(collapseCarriage('loading 1%\rloading 50%\rloading 100%')).toBe('loading 100%');
  });

  it('standardizeCliOutput produces clean lines with levels', () => {
    const raw = '\x1b[32mINFO\x1b[0m start\r\nworking...\rERROR: boom\n\n';
    const lines = standardizeCliOutput(raw);
    expect(lines.map((l) => l.text)).toEqual(['INFO start', 'working...', 'ERROR: boom']);
    expect(lines[0]!.level).toBe('info');
    expect(lines[2]!.level).toBe('error');
  });

  it('drops trailing whitespace and empty lines', () => {
    const lines = standardizeCliOutput('a   \n\n  b  \n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('inferLevel detects warn and error keywords', () => {
    expect(inferLevel('Warning: deprecation')).toBe('warn');
    expect(inferLevel('failed to connect')).toBe('error');
    expect(inferLevel('all good')).toBe('info');
  });

  it('summarizeOutput returns last line truncated', () => {
    expect(summarizeOutput('a\nb\nc')).toBe('c');
    const long = 'x'.repeat(300);
    const s = summarizeOutput(long, 50);
    expect(s.length).toBe(50);
    expect(s.endsWith('…')).toBe(true);
  });
});
