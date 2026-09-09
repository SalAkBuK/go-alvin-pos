import type Database from 'better-sqlite3';
import { GOOGLE_SALES_SHEET_DEFAULT, GOOGLE_SALE_ITEMS_SHEET_DEFAULT } from '../../shared/google';
import { getSettingValue } from './settingsRepository';

/**
 * The non-secret `google_*` settings rows — a DEDICATED path (`task §5`),
 * separate from the tax / business / printer repositories so the trusted
 * settings surface is never broadened into a generic key/value writer.
 *
 * Canon names these keys in `DATA_MODEL.md §19`-`§20`; the `settings` table
 * (migration `001`) already persists them. **No migration** (`task §26`).
 *
 * A service-account private key is NEVER stored here (`DATA_MODEL.md §21`,
 * `REQ-GSHEET-013`) — only `google_credential_generation`, a non-secret
 * monotonic counter that pairs the encrypted credential file with the DB
 * (`task §4`).
 */

const KEY_ENABLED = 'google_sheets_enabled';
const KEY_SPREADSHEET_ID = 'google_spreadsheet_id';
const KEY_SALES_SHEET = 'google_sales_sheet_name';
const KEY_SALE_ITEMS_SHEET = 'google_sale_items_sheet_name';
const KEY_LAST_SYNC = 'google_last_successful_sync_at';
const KEY_CREDENTIAL_GENERATION = 'google_credential_generation';
/**
 * Companion bookkeeping key: whether the credential at `credentialGeneration` is
 * the active one. Disconnect flips this to `false` (it does NOT lower the
 * monotonic generation), so startup reconciliation can tell a committed
 * disconnect's lingering file apart from a connect that crashed before its
 * commit (`task §4`). Non-secret.
 */
const KEY_CREDENTIAL_ACTIVE = 'google_credential_active';

export interface GoogleSettingsRow {
  readonly enabled: boolean;
  /** `null` when never configured. */
  readonly spreadsheetId: string | null;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
  /** ISO-8601 UTC, worker-written; `null` until the first successful export. */
  readonly lastSuccessfulSyncAt: string | null;
  /** Monotonic; `0` before the first connect. Never lowered by a disconnect. */
  readonly credentialGeneration: number;
  /** Whether the credential at `credentialGeneration` is currently active. */
  readonly credentialActive: boolean;
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value.trim() : null;
}

export function readGoogleSettings(db: Database.Database): GoogleSettingsRow {
  const enabledRaw = getSettingValue(db, KEY_ENABLED);
  const genRaw = getSettingValue(db, KEY_CREDENTIAL_GENERATION);
  const gen = genRaw !== null && /^\d+$/.test(genRaw.trim()) ? Number(genRaw.trim()) : 0;
  return {
    enabled: enabledRaw === 'true',
    spreadsheetId: nonEmpty(getSettingValue(db, KEY_SPREADSHEET_ID)),
    salesSheetName: nonEmpty(getSettingValue(db, KEY_SALES_SHEET)) ?? GOOGLE_SALES_SHEET_DEFAULT,
    saleItemsSheetName:
      nonEmpty(getSettingValue(db, KEY_SALE_ITEMS_SHEET)) ?? GOOGLE_SALE_ITEMS_SHEET_DEFAULT,
    lastSuccessfulSyncAt: nonEmpty(getSettingValue(db, KEY_LAST_SYNC)),
    credentialGeneration: gen,
    credentialActive: getSettingValue(db, KEY_CREDENTIAL_ACTIVE) === 'true' && gen > 0,
  };
}

const UPSERT = `INSERT INTO settings (key, value, updated_at)
   VALUES (@key, @value, @updatedAt)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

export interface WriteGoogleConfigSettings {
  readonly enabled: boolean;
  readonly spreadsheetId: string;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
}

/** Upsert the four non-secret config rows. Opens no transaction — participates in the caller's. */
export function writeGoogleConfigSettings(
  db: Database.Database,
  values: WriteGoogleConfigSettings,
  updatedAt: string,
): void {
  const upsert = db.prepare(UPSERT);
  upsert.run({ key: KEY_ENABLED, value: values.enabled ? 'true' : 'false', updatedAt });
  upsert.run({ key: KEY_SPREADSHEET_ID, value: values.spreadsheetId, updatedAt });
  upsert.run({ key: KEY_SALES_SHEET, value: values.salesSheetName, updatedAt });
  upsert.run({ key: KEY_SALE_ITEMS_SHEET, value: values.saleItemsSheetName, updatedAt });
}

/** Turn off `google_sheets_enabled` only (used by disconnect). Opens no transaction. */
export function writeGoogleDisabled(db: Database.Database, updatedAt: string): void {
  db.prepare(UPSERT).run({ key: KEY_ENABLED, value: 'false', updatedAt });
}

/** Connect / rotate: advance the monotonic generation and mark it active. Opens no transaction. */
export function writeCredentialConnected(
  db: Database.Database,
  generation: number,
  updatedAt: string,
): void {
  const upsert = db.prepare(UPSERT);
  upsert.run({ key: KEY_CREDENTIAL_GENERATION, value: String(generation), updatedAt });
  upsert.run({ key: KEY_CREDENTIAL_ACTIVE, value: 'true', updatedAt });
}

/** Disconnect: flip the active flag off (generation is left at its monotonic value). Opens no transaction. */
export function writeCredentialInactive(db: Database.Database, updatedAt: string): void {
  db.prepare(UPSERT).run({ key: KEY_CREDENTIAL_ACTIVE, value: 'false', updatedAt });
}

/** Worker-only: record the instant of the most recent confirmed export. Opens its own write. */
export function writeLastSuccessfulSync(db: Database.Database, iso: string): void {
  db.prepare(UPSERT).run({ key: KEY_LAST_SYNC, value: iso, updatedAt: iso });
}
