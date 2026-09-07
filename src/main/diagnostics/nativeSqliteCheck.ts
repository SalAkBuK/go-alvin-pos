import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { NativeSqliteCheckResult } from '../../shared/ipc';

/**
 * Narrowly scoped scaffold verification, carried over from the packaging spike.
 *
 * It proves that the native `better-sqlite3` binding loads and answers from the
 * Electron main process (and, in packaged builds, from inside `app.asar` via
 * `asarUnpack`). It opens only a throwaway diagnostic database under the
 * application-data `diagnostics/` directory.
 *
 * This is NOT business persistence: it defines no schema, runs no migration,
 * and stores no products / sales / customers / payments. It must never be
 * grown into the operational database path.
 */
export function runNativeSqliteCheck(diagnosticDbFile: string): NativeSqliteCheckResult {
  try {
    mkdirSync(dirname(diagnosticDbFile), { recursive: true });

    const db = new Database(diagnosticDbFile);
    try {
      // Exercise the same WAL journal mode the operational database will use
      // later (DATA_MODEL.md Section 54) so packaging problems surface now.
      db.pragma('journal_mode = WAL');
      const journalMode = String(db.pragma('journal_mode', { simple: true }));
      const { version } = db.prepare('SELECT sqlite_version() AS version').get() as {
        version: string;
      };

      return {
        ok: true,
        sqliteVersion: version,
        journalMode,
        hasBackupApi: typeof db.backup === 'function',
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
