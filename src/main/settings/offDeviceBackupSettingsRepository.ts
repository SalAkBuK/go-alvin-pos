import type Database from 'better-sqlite3';

/**
 * Dedicated settings access for the optional OFF_DEVICE destination.
 *
 * Only the canonical main-process path is stored. A prior successful
 * verification is deliberately not persisted as authority: every use runs the
 * destination verifier again because drive letters and network mappings can
 * change. Whole-database restore naturally rewinds/removes this row with all
 * other settings; callers must never reapply an in-memory pre-restore value.
 */

export const OFF_DEVICE_BACKUP_DESTINATION_KEY = 'off_device_backup_destination';

export interface OffDeviceBackupDestinationSetting {
  readonly destinationPath: string;
  readonly updatedAt: string;
}

export function readOffDeviceBackupDestination(
  db: Database.Database,
): OffDeviceBackupDestinationSetting | null {
  const row = db
    .prepare('SELECT value, updated_at FROM settings WHERE key = ?')
    .get(OFF_DEVICE_BACKUP_DESTINATION_KEY) as
    { readonly value: string | null; readonly updated_at: string } | undefined;
  if (!row || row.value === null || row.value.trim().length === 0) {
    return null;
  }
  return { destinationPath: row.value, updatedAt: row.updated_at };
}

export function writeOffDeviceBackupDestination(
  db: Database.Database,
  destinationPath: string,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OFF_DEVICE_BACKUP_DESTINATION_KEY, destinationPath, updatedAt);
}

export function clearOffDeviceBackupDestination(db: Database.Database): boolean {
  return (
    db.prepare('DELETE FROM settings WHERE key = ?').run(OFF_DEVICE_BACKUP_DESTINATION_KEY)
      .changes > 0
  );
}
