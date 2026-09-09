import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `REQ-DB-006` / `REQ-SEC-001`: renderer code must never reach SQLite or Node
 * primitives. This is a source-level guard; `scripts/verify-packaging.mjs`
 * additionally proves the built renderer bundle is free of `better-sqlite3`.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('renderer isolation', () => {
  const rendererFiles = walk(join(process.cwd(), 'src', 'renderer'));

  it('scans a non-trivial number of renderer source files', () => {
    expect(rendererFiles.length).toBeGreaterThan(3);
  });

  it.each([
    ['better-sqlite3', /better-sqlite3/],
    ['node:fs / fs', /from ['"](node:)?fs['"]/],
    ['node:child_process', /child_process/],
    ['electron ipcRenderer', /ipcRenderer/],
    ['a direct database import', /database\/(connection|database|migrationRunner)/],
    ['google-auth-library', /google-auth-library/],
    ['a main-process module', /from ['"].*\/main\//],
  ])('no renderer file imports %s', (_label, pattern) => {
    for (const file of rendererFiles) {
      expect(readFileSync(file, 'utf8')).not.toMatch(pattern);
    }
  });

  it('the renderer only reaches the main process through window.pos', () => {
    const usesPos = rendererFiles.some((file) => readFileSync(file, 'utf8').includes('window.pos'));
    expect(usesPos).toBe(true);
  });
});
