import type { DatabaseStatus } from '../../shared/ipc';

/**
 * Process-wide production-database status, for the read-only
 * `diagnostics:database-status` IPC channel. The lifecycle owner
 * (`src/main/index.ts`) sets it; the IPC handler reads it. It never carries
 * SQL, rows, paths, or business data.
 */

let current: DatabaseStatus = {
  state: 'initializing',
  schemaVersion: null,
  failureCode: null,
};

export function setDatabaseStatus(status: DatabaseStatus): void {
  current = status;
}

export function getDatabaseStatus(): DatabaseStatus {
  return current;
}
