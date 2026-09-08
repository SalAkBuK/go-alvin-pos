/**
 * Shared integer-cent money primitives.
 *
 * Pure TypeScript, dependency-free (no Node, no DOM, no React), so the identical
 * parsing/formatting/ceiling rules bundle into the main process, the sandboxed
 * preload, and the renderer alike. Every monetary value in the system is an
 * integer number of cents (`DATA_MODEL.md §5`); binary floating-point currency
 * is never persisted or used for arithmetic.
 *
 * The renderer uses `parseCurrencyToCents` to turn typed dollar text into cents
 * for a request; the trusted application layer never relies on that — it
 * independently re-validates the integer it receives (`DATA_MODEL.md §41A`,
 * `§43`). Keeping the logic here rather than inside a React component is what
 * makes it independently testable.
 */

/** Per-unit price ceiling in cents ($99,999.99) — `DATA_MODEL.md §41A`. */
export const PER_UNIT_PRICE_CENTS_MAX = 9_999_999;

/** Checkout final-total ceiling in cents ($999,999.99) — `DATA_MODEL.md §41A`. */
export const CHECKOUT_TOTAL_CENTS_MAX = 99_999_999;

/** Thrown by `parseCurrencyToCents` for anything that is not a clean dollar amount. */
export class MoneyParseError extends Error {
  override readonly name = 'MoneyParseError';
}

/**
 * Parse user-typed dollar text (`"599"`, `"599.00"`, `"550.50"`) into an
 * integer number of cents.
 *
 * Deterministic and never coercive:
 *  - empty / whitespace-only input throws (callers decide if "empty" is allowed);
 *  - a leading `-`, `+`, `$`, thousands separators, exponent notation, more than
 *    two fractional digits, `NaN`, `Infinity`, or any non-digit character throws;
 *  - the result is computed as `dollars * 100 + fractionDigits` — never
 *    `parseFloat(x) * 100`, which can introduce floating-point cent drift.
 */
export function parseCurrencyToCents(raw: string): number {
  if (typeof raw !== 'string') {
    throw new MoneyParseError('Enter a dollar amount like 599 or 599.99.');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new MoneyParseError('Enter a dollar amount.');
  }
  // Whole dollars, or dollars with exactly one or two decimal places. Nothing else.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new MoneyParseError('Enter a dollar amount like 599 or 599.99.');
  }
  const parts = trimmed.split('.');
  const dollars = parts[0] ?? '0';
  const fraction = (parts[1] ?? '').padEnd(2, '0');
  const cents = Number(dollars) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyParseError('That amount is too large.');
  }
  return cents;
}

/** Format integer cents as `$1,234.56`. `null` renders as an em dash. */
export function formatCents(cents: number | null): string {
  if (cents === null) {
    return '—';
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, '0');
  const grouped = dollars.toLocaleString('en-US');
  return `${negative ? '-' : ''}$${grouped}.${remainder}`;
}

/** True when `value` is a non-negative integer within `[0, max]`. */
export function isCentsAmountInRange(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}
