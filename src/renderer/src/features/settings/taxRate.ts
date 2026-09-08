/**
 * Renderer-only tax-rate percent <-> basis-point helpers (Phase 2D.1).
 *
 * The cashier-facing field is a percentage (`8.25`), because that is how a
 * store owner thinks about sales tax; the canonical persisted representation is
 * integer basis points (`DATA_MODEL.md §6`, `825` = `8.25%`). Conversion is a
 * deterministic integer operation — `whole * 100 + fractionDigits` — never
 * `parseFloat(value) * 100`, which can drift (`8.25 * 100 === 824.9999…` in some
 * engines is avoided entirely here).
 *
 * Pure, React-free, and independently testable. Not authoritative:
 * `settingsValidation.ts` in the main process re-validates the basis-point
 * integer before it is persisted.
 */

/**
 * Maximum tax rate in basis points — mirrors the `sales.tax_rate_bps` CHECK
 * bound (`825` bps = `8.25%`, so this `100000` ceiling is a loose fat-finger
 * guard, not a business figure). The trusted layer re-enforces it.
 */
export const TAX_RATE_BPS_MAX = 100_000;

export class PercentParseError extends Error {
  override readonly name = 'PercentParseError';
}

/**
 * Parse a typed percentage string (`"8.25"`, `"6"`, `"0"`, `"7.5"`) into integer
 * basis points. At most two fractional digits. Throws `PercentParseError` for
 * anything else — a leading sign, `%`, thousands separators, exponent notation,
 * more than two decimals, `NaN`, `Infinity`, or any non-digit character.
 */
export function parsePercentToBps(raw: string): number {
  if (typeof raw !== 'string') {
    throw new PercentParseError('Enter a percentage like 8.25.');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new PercentParseError('Enter a tax rate.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new PercentParseError('Enter a percentage like 8.25 (at most two decimal places).');
  }
  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  const fraction = (parts[1] ?? '').padEnd(2, '0');
  const bps = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(bps)) {
    throw new PercentParseError('That rate is too large.');
  }
  return bps;
}

/** Format integer basis points as a two-decimal percentage: `825` -> `"8.25%"`. */
export function formatBpsAsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0');
  return `${whole}.${fraction}%`;
}

/**
 * Field-level validation for the percent input. Returns an error sentence, or
 * `null` when the value is a well-formed rate within the canonical bound.
 */
export function validateTaxRatePercent(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return 'Enter a tax rate, for example 8.25.';
  }
  if (trimmed.startsWith('-')) {
    return 'The tax rate cannot be negative.';
  }
  if (/^\d*\.\d{3,}$/.test(trimmed)) {
    return 'The tax rate can have at most two decimal places.';
  }
  let bps: number;
  try {
    bps = parsePercentToBps(trimmed);
  } catch (error) {
    return error instanceof PercentParseError ? error.message : 'Enter a percentage like 8.25.';
  }
  if (bps > TAX_RATE_BPS_MAX) {
    return 'The tax rate is above the maximum allowed.';
  }
  return null;
}
