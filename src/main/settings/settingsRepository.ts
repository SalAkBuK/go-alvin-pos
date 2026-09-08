import type Database from 'better-sqlite3';
import { appErrors } from '../shared/appError';

/**
 * Settings SQL, isolated behind a repository (`ARCHITECTURE.md §12`,
 * `DATA_MODEL.md §19-20`).
 *
 * This repository is deliberately tax-rate-only. There is NO generic
 * `setSetting(key, value)` here — the `key` is hard-coded — so no caller (least
 * of all the renderer, which never reaches this layer) can turn it into an
 * arbitrary key/value write. The `settings` table already exists (migration
 * `001`, `key TEXT PRIMARY KEY`, `value TEXT`, `updated_at TEXT NOT NULL`);
 * Phase 2A seeds only `business_timezone`, so `tax_rate_bps` is absent until the
 * store user configures it. No new migration is needed for this slice.
 */

const TAX_RATE_KEY = 'tax_rate_bps';

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
