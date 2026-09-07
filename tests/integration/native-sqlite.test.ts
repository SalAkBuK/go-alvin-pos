import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNativeSqliteCheck } from '../../src/main/diagnostics/nativeSqliteCheck';

/**
 * Integration-test foundation: the native better-sqlite3 binding must load and
 * respond outside the packaging spike, in the same code path the main process
 * uses. This is a foundation smoke test only — it asserts no business schema.
 */
describe('better-sqlite3 native module (integration)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpp-sqlite-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the native binding, opens a database, and answers a trivial query', () => {
    const result = runNativeSqliteCheck(join(dir, 'diagnostics', 'native-check.sqlite'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.journalMode.toLowerCase()).toBe('wal');
      expect(result.hasBackupApi).toBe(true);
    }
  });

  it('creates only the throwaway diagnostic file and no business schema', () => {
    runNativeSqliteCheck(join(dir, 'diagnostics', 'native-check.sqlite'));

    const created = readdirSync(join(dir, 'diagnostics'));
    expect(created.some((name) => name.startsWith('native-check.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'gophones.sqlite'))).toBe(false);
  });

  it('returns a structured error instead of throwing when the database cannot be opened', () => {
    // A directory can never be opened as a SQLite database file.
    const result = runNativeSqliteCheck(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
