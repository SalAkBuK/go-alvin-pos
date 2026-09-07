/**
 * Renderer-side currency helpers (task `§18`).
 *
 * Internally and across IPC every monetary value is integer cents. The renderer
 * only formats cents for display and parses a typed dollar string back to cents
 * for the trusted layer to re-validate. No floating-point currency is persisted.
 */

export function formatCents(cents: number | null): string {
  if (cents === null) {
    return '—';
  }
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parse a user-typed dollar amount to integer cents.
 * Returns `null` for empty input; throws `Error` for anything malformed so the
 * form can show a message rather than silently coercing (`DATA_MODEL.md §41A`).
 */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('Enter a dollar amount like 599 or 599.99.');
  }
  const [dollars, fraction = ''] = trimmed.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new Error('That amount is too large.');
  }
  return cents;
}

export function parseIntegerField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Enter a whole number.');
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error('That number is too large.');
  }
  return value;
}

/** Parse a signed integer (for a stock delta like `-2` or `+5`). */
export function parseSignedInteger(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error('Enter a whole number, optionally with a leading + or -.');
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error('That number is too large.');
  }
  return value;
}
