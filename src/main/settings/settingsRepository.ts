import type Database from 'better-sqlite3';
import { appErrors } from '../shared/appError';

/**
 * Settings SQL, isolated behind a repository (`ARCHITECTURE.md §12`,
 * `DATA_MODEL.md §19-20`).
 *
 * Phase 2D needs exactly one trusted read: the configured `tax_rate_bps` for
 * checkout review. The `settings` table already exists (migration `001`); Phase
 * 2A seeds only `business_timezone`, so `tax_rate_bps` is normally absent until
 * a store is configured. There is deliberately no settings *write* path and no
 * new migration in this phase — a first-run Settings UI is a later slice, and
 * tests seed `tax_rate_bps` through a database fixture.
 */

const TAX_RATE_KEY = 'tax_rate_bps';

/** Maximum `tax_rate_bps` the `sales.tax_rate_bps` CHECK constraint accepts (`= 100%`). */
const TAX_RATE_BPS_MAX = 100_000;

/** Raw settings value for `key`, or `null` when the row is missing or its value is `NULL`. */
export function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string | null } | undefined;
  return row && row.value !== null ? row.value : null;
}

/**
 * The configured tax rate in basis points, or `null` when none is configured
 * (row absent, or value blank). A present-but-malformed value (non-integer,
 * negative, or above 100%) is a real misconfiguration the owner must fix, so it
 * throws a typed `TAX_RATE_NOT_CONFIGURED` error rather than being silently
 * treated as zero.
 */
export function readConfiguredTaxRateBps(db: Database.Database): number | null {
  const raw = getSettingValue(db, TAX_RATE_KEY);
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw appErrors.taxRateNotConfigured();
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > TAX_RATE_BPS_MAX) {
    throw appErrors.taxRateNotConfigured();
  }
  return value;
}
