import type Database from 'better-sqlite3';
import { appErrors } from '../shared/appError';

/**
 * Settings SQL, isolated behind a repository (`ARCHITECTURE.md §12`,
 * `DATA_MODEL.md §19-20`).
 *
 * Every accessor here targets an explicit, hard-coded settings `key` — there is
 * NO generic `setSetting(key, value)` — so no caller (least of all the renderer,
 * which never reaches this layer) can turn it into an arbitrary key/value write.
 * The `settings` table already exists (migration `001`, `key TEXT PRIMARY KEY`,
 * `value TEXT`, `updated_at TEXT NOT NULL`); Phase 2A seeds only
 * `business_timezone`, so `tax_rate_bps` and the business/receipt keys are
 * absent until the store user configures them. No new migration is needed.
 *
 * Key names (`tax_rate_bps`, `business_address`, `business_phone`,
 * `receipt_disclaimer`, `receipt_footer`) are the canonical ones listed in
 * `DATA_MODEL.md §19`.
 */

const TAX_RATE_KEY = 'tax_rate_bps';

const BUSINESS_ADDRESS_KEY = 'business_address';
const BUSINESS_PHONE_KEY = 'business_phone';
const RECEIPT_DISCLAIMER_KEY = 'receipt_disclaimer';
const RECEIPT_FOOTER_KEY = 'receipt_footer';

/**
 * The canonically fixed store identity (`PRODUCT_SCOPE.md §6/§15`,
 * `REQ-REC-002`, `DATA_MODEL.md §4`, `POS_WORKFLOWS.md §78`). It is not in the
 * `POS_WORKFLOWS.md §69` "Change Business Information" trigger list and no
 * canonical document grants editing it, so V1 treats it as a constant supplied
 * by the trusted layer rather than a stored/editable settings row. `DATA_MODEL.md
 * §19` lists `business_name` among settings keys that *"may"* exist — "may", not
 * "must" — so leaving it unstored is within the canon.
 */
export const BUSINESS_NAME = 'Go Phones - Alvin';

/** Free-text ceilings — mirror the existing `REASON_MAX_LENGTH` / `PHONE_MAX_LENGTH` conventions. */
export const BUSINESS_ADDRESS_MAX_LENGTH = 500;
export const BUSINESS_PHONE_MAX_LENGTH = 60;
export const RECEIPT_DISCLAIMER_MAX_LENGTH = 2000;
export const RECEIPT_FOOTER_MAX_LENGTH = 500;

/**
 * Maximum `tax_rate_bps` — the same `0 .. 100000` bound the `sales.tax_rate_bps`
 * CHECK constraint enforces (migration `001`; `825` bps = `8.25%`, so this
 * ceiling is a loose `1000%` fat-finger guard, not a business figure). A setting
 * value that could never be written onto a sale would be meaningless, so the
 * setting uses the identical bound; no tighter business maximum is invented
 * (task `§8`).
 */
export const TAX_RATE_BPS_MAX = 100_000;

/** Raw settings value for `key`, or `null` when the row is missing or its value is `NULL`. */
export function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string | null } | undefined;
  return row && row.value !== null ? row.value : null;
}

export interface TaxRateSetting {
  readonly taxRateBps: number;
  /** ISO-8601 UTC timestamp stored in `settings.updated_at`. */
  readonly updatedAt: string;
}

/**
 * The persisted tax-rate setting, or `null` when none is configured (row
 * absent, or value blank). A present-but-malformed value (non-integer,
 * negative, or above `100000`) is a real misconfiguration the store user must
 * fix, so it throws a typed `TAX_RATE_NOT_CONFIGURED` error rather than being
 * silently treated as zero.
 */
export function readTaxRateSetting(db: Database.Database): TaxRateSetting | null {
  const row = db
    .prepare('SELECT value, updated_at FROM settings WHERE key = ?')
    .get(TAX_RATE_KEY) as { value: string | null; updated_at: string } | undefined;
  if (!row || row.value === null || row.value.trim() === '') {
    return null;
  }
  const trimmed = row.value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw appErrors.taxRateNotConfigured();
  }
  const taxRateBps = Number(trimmed);
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > TAX_RATE_BPS_MAX) {
    throw appErrors.taxRateNotConfigured();
  }
  return { taxRateBps, updatedAt: row.updated_at };
}

/**
 * The configured tax rate in basis points, or `null` when none is configured.
 * The Phase 2D checkout review reads through this; behaviour is unchanged —
 * it now simply derives from {@link readTaxRateSetting}.
 */
export function readConfiguredTaxRateBps(db: Database.Database): number | null {
  return readTaxRateSetting(db)?.taxRateBps ?? null;
}

/**
 * Insert or update the `tax_rate_bps` row. Caller supplies an already-validated
 * non-negative integer and the transaction's UTC timestamp; this function opens
 * no transaction of its own so it participates in the caller's atomic
 * setting + audit-event write.
 */
export function writeTaxRateBps(
  db: Database.Database,
  taxRateBps: number,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ key: TAX_RATE_KEY, value: String(taxRateBps), updatedAt });
}

// ── Business & receipt settings (Phase 2D.2) ─────────────────────────────────

export interface BusinessSettingsRow {
  /** `null` = the key row has never been written. `''` = configured blank. */
  readonly businessAddress: string | null;
  readonly businessPhone: string | null;
  readonly receiptDisclaimer: string | null;
  readonly receiptFooter: string | null;
  /** Newest `updated_at` among the four rows, or `null` when none exist. */
  readonly updatedAt: string | null;
}

const BUSINESS_KEYS = [
  BUSINESS_ADDRESS_KEY,
  BUSINESS_PHONE_KEY,
  RECEIPT_DISCLAIMER_KEY,
  RECEIPT_FOOTER_KEY,
] as const;

/** Read the four business/receipt setting rows as raw stored text (no validation, no defaults). */
export function readBusinessSettings(db: Database.Database): BusinessSettingsRow {
  const rows = db
    .prepare(
      `SELECT key, value, updated_at FROM settings
       WHERE key IN (${BUSINESS_KEYS.map(() => '?').join(', ')})`,
    )
    .all(...BUSINESS_KEYS) as Array<{ key: string; value: string | null; updated_at: string }>;

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const valueOf = (key: string): string | null => {
    const row = byKey.get(key);
    return row && row.value !== null ? row.value : null;
  };
  const timestamps = rows.map((r) => r.updated_at).sort();

  return {
    businessAddress: valueOf(BUSINESS_ADDRESS_KEY),
    businessPhone: valueOf(BUSINESS_PHONE_KEY),
    receiptDisclaimer: valueOf(RECEIPT_DISCLAIMER_KEY),
    receiptFooter: valueOf(RECEIPT_FOOTER_KEY),
    updatedAt: timestamps.length > 0 ? (timestamps[timestamps.length - 1] ?? null) : null,
  };
}

export interface WriteBusinessSettings {
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly receiptDisclaimer: string;
  readonly receiptFooter: string;
}

/**
 * Upsert all four business/receipt rows with one shared `updated_at`. Caller
 * supplies already-trimmed, already-validated values; blank disclaimer/footer
 * are written as the empty string (`DATA_MODEL.md §44-49`: a configured blank is
 * stored as the transaction-time blank value, not null). Opens no transaction
 * of its own — participates in the caller's atomic settings + audit write.
 */
export function writeBusinessSettings(
  db: Database.Database,
  values: WriteBusinessSettings,
  updatedAt: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  upsert.run({ key: BUSINESS_ADDRESS_KEY, value: values.businessAddress, updatedAt });
  upsert.run({ key: BUSINESS_PHONE_KEY, value: values.businessPhone, updatedAt });
  upsert.run({ key: RECEIPT_DISCLAIMER_KEY, value: values.receiptDisclaimer, updatedAt });
  upsert.run({ key: RECEIPT_FOOTER_KEY, value: values.receiptFooter, updatedAt });
}
