/**
 * Shared Main <-> Preload <-> Renderer IPC contract.
 *
 * This module is intentionally dependency-free (pure TypeScript types and
 * string constants) so it can be bundled into the main process (Node),
 * the sandboxed preload, and the renderer (browser) alike.
 *
 * FOUNDATION SCOPE: the only channels defined here are the minimum needed to
 * prove the typed IPC path works end to end and that better-sqlite3 loads in
 * the main process. No POS business capability (products, checkout, sales,
 * customers, reports, backup, printing, ...) is defined yet. When those are
 * added they must each be an explicit, narrow, business-named channel per
 * ARCHITECTURE.md Sections 8-9 — never a generic `database:query`,
 * `execute-sql`, `read-file`, or `run-command` surface.
 */

export const IPC = {
  /** Static application/runtime identity for display and diagnostics. */
  appInfo: 'app:info',
  /**
   * Narrowly scoped scaffold verification: confirms the native better-sqlite3
   * binding loads and responds from the main process. This is NOT business
   * persistence and must never be turned into one.
   */
  nativeSqliteCheck: 'diagnostics:native-sqlite-check',
  /**
   * Read-only production-database health for startup-status display. Returns a
   * small status enum + schema version + failure code — never SQL, rows, paths,
   * or business data. It exists so a database that fails to initialize is
   * visible rather than silent.
   */
  databaseStatus: 'diagnostics:database-status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly packaged: boolean;
}

export type NativeSqliteCheckResult =
  | {
      readonly ok: true;
      readonly sqliteVersion: string;
      readonly journalMode: string;
      readonly hasBackupApi: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface DatabaseStatus {
  /** `ready` = migrated + validated + connected; `unavailable` = init failed. */
  readonly state: 'ready' | 'unavailable' | 'initializing';
  readonly schemaVersion: number | null;
  /** Stable failure code when `state === 'unavailable'`, else `null`. */
  readonly failureCode: string | null;
}

/**
 * The shape exposed to the renderer as `window.pos` by the preload script.
 * Every method is an async, argument-validated request to the main process.
 */
export interface PosApi {
  readonly app: {
    getInfo(): Promise<AppInfo>;
  };
  readonly diagnostics: {
    checkNativeSqlite(): Promise<NativeSqliteCheckResult>;
    databaseStatus(): Promise<DatabaseStatus>;
  };
}
