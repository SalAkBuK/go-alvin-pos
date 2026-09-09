import type Database from 'better-sqlite3';

/**
 * The `selected_printer` settings row — a DEDICATED printer-selection path
 * (`task §10`), deliberately separate from the tax / business settings
 * repository so the trusted settings surface is never broadened into a generic
 * key/value writer.
 *
 * Canon already names `selected_printer → string` a valid `settings` key
 * (`DATA_MODEL.md §19`-`§20`); the `settings` table (migration `001`:
 * `key TEXT PRIMARY KEY`, `value TEXT`, `updated_at TEXT NOT NULL`) already
 * persists it. No migration is needed or added (`task §11`).
 *
 * A printer selection is a purely local device preference — it is never exported
 * to Google Sheets and never freezes into a sale snapshot, so (unlike a tax /
 * business-settings change) it writes no audit event and needs no `BEGIN
 * IMMEDIATE` transaction: `POS_WORKFLOWS.md §70` defines the workflow as
 * "selection is saved locally" with no audit step, and `task §14` forbids
 * inventing audit events.
 */

const SELECTED_PRINTER_KEY = 'selected_printer';

/** Device-name ceiling — a loose fat-finger guard, not a business figure. */
export const SELECTED_PRINTER_MAX_LENGTH = 255;

/**
 * The persisted printer device name, or `null` when none is selected (row
 * absent, or value blank/whitespace). Never invents a name (`task §12`).
 */
export function readSelectedPrinter(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SELECTED_PRINTER_KEY) as
    { value: string | null } | undefined;
  const value = row && row.value !== null ? row.value.trim() : '';
  return value === '' ? null : value;
}

/**
 * Upsert `selected_printer`. Caller supplies an already-trimmed, already-bounded
 * device name and the UTC timestamp.
 */
export function writeSelectedPrinter(
  db: Database.Database,
  deviceName: string,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ key: SELECTED_PRINTER_KEY, value: deviceName, updatedAt });
}
