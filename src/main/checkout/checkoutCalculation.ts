import { CHECKOUT_TOTAL_CENTS_MAX, PER_UNIT_PRICE_CENTS_MAX } from '../../shared/money';
import { appErrors } from '../shared/appError';

/**
 * Pure checkout money/tax/discount arithmetic (`DATA_MODEL.md §41`, `§42`, `§43`).
 *
 * No SQLite, no Electron, no React, no clock — every function is a
 * deterministic integer-cent calculation over its arguments, so it is unit-
 * testable in isolation and produces an identical result on every run
 * (`TEST-MONEY-004`). The trusted checkout service composes these after it has
 * loaded authoritative product state; the renderer may run the same functions
 * for an immediate preview, but the service's result is the authoritative one.
 */

/** One cart line reduced to the four values that drive every derived amount. */
export interface CanonicalLine {
  readonly productId: string;
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly quantity: number;
}

export interface ReviewTotals {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly taxRateBps: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw appErrors.validation(`${label} is not a valid whole number.`);
  }
  return value;
}

/** `listed_price_cents × quantity` (`§13`, `§41`). */
export function lineListedSubtotalCents(line: CanonicalLine): number {
  return assertSafeInteger(line.listedPriceCents * line.quantity, 'A line subtotal');
}

/** `sold_price_cents × quantity` (`§13`, `§41`). */
export function lineTotalCents(line: CanonicalLine): number {
  return assertSafeInteger(line.soldPriceCents * line.quantity, 'A line total');
}

/**
 * `max(0, listed_price_cents − sold_price_cents) × quantity` (`§41`).
 * A sold price at or above the listed price yields `0` — never a negative
 * "discount" and never a surfaced markup.
 */
export function lineDiscountCents(line: CanonicalLine): number {
  const perUnit = Math.max(0, line.listedPriceCents - line.soldPriceCents);
  return assertSafeInteger(perUnit * line.quantity, 'A line discount');
}

/**
 * Transaction-level tax (`DATA_MODEL.md §42`):
 *
 * ```text
 * tax_cents = floor((taxable_amount_cents × tax_rate_bps + 5000) / 10000)
 * ```
 *
 * Integer arithmetic, round-half-up. Calculated once per transaction from the
 * summed sold-price line totals — never per line, never from listed prices.
 */
export function calculateTaxCents(taxableAmountCents: number, taxRateBps: number): number {
  if (!Number.isInteger(taxableAmountCents) || taxableAmountCents < 0) {
    throw appErrors.validation('The taxable amount must be a non-negative whole number of cents.');
  }
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
    throw appErrors.validation('The tax rate must be a non-negative whole number of basis points.');
  }
  const numerator = assertSafeInteger(
    taxableAmountCents * taxRateBps + 5000,
    'The tax calculation',
  );
  return Math.floor(numerator / 10000);
}

/**
 * Sort a copy of `lines` into the canonical order defined by `DATA_MODEL.md
 * §41B` — ascending, field by field, by
 * `(product_id, listed_price_cents, sold_price_cents, quantity)` — exactly like
 * a compound SQL `ORDER BY`. Never uses insertion order or any client-side
 * index. Identical tuples are kept as separate entries (canonical ordering
 * never merges or deduplicates lines).
 */
export function canonicalLineOrder(lines: readonly CanonicalLine[]): CanonicalLine[] {
  return [...lines].sort((a, b) => {
    if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
    if (a.listedPriceCents !== b.listedPriceCents) return a.listedPriceCents - b.listedPriceCents;
    if (a.soldPriceCents !== b.soldPriceCents) return a.soldPriceCents - b.soldPriceCents;
    return a.quantity - b.quantity;
  });
}

/**
 * Authoritative checkout totals (`DATA_MODEL.md §42`, `§43`):
 *
 * ```text
 * subtotal_cents        = Σ(listed_price_cents × quantity)
 * discount_cents        = Σ(max(0, listed − sold) × quantity)
 * taxable_amount_cents  = Σ(sold_price_cents × quantity)   ← tax basis
 * tax_cents             = floor((taxable × bps + 5000) / 10000)
 * total_cents           = taxable_amount_cents + tax_cents
 * ```
 *
 * There is no order-level discount in V1. Per-unit prices are bounded by the
 * caller; this function additionally rejects a final total above the canonical
 * `$999,999.99` ceiling.
 */
export function calculateReviewTotals(
  lines: readonly CanonicalLine[],
  taxRateBps: number,
): ReviewTotals {
  for (const line of lines) {
    if (
      !Number.isInteger(line.listedPriceCents) ||
      line.listedPriceCents < 0 ||
      line.listedPriceCents > PER_UNIT_PRICE_CENTS_MAX ||
      !Number.isInteger(line.soldPriceCents) ||
      line.soldPriceCents < 0 ||
      line.soldPriceCents > PER_UNIT_PRICE_CENTS_MAX
    ) {
      throw appErrors.validation('A line price is outside the allowed range.');
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw appErrors.validation('A line quantity is not a positive whole number.');
    }
  }

  let subtotalCents = 0;
  let discountCents = 0;
  let taxableAmountCents = 0;
  for (const line of lines) {
    subtotalCents = assertSafeInteger(
      subtotalCents + lineListedSubtotalCents(line),
      'The subtotal',
    );
    discountCents = assertSafeInteger(discountCents + lineDiscountCents(line), 'The discount');
    taxableAmountCents = assertSafeInteger(
      taxableAmountCents + lineTotalCents(line),
      'The taxable amount',
    );
  }

  const taxCents = calculateTaxCents(taxableAmountCents, taxRateBps);
  const totalCents = assertSafeInteger(taxableAmountCents + taxCents, 'The total');

  if (totalCents > CHECKOUT_TOTAL_CENTS_MAX) {
    throw appErrors.checkoutTotalExceeded();
  }

  return {
    subtotalCents,
    discountCents,
    taxableAmountCents,
    taxRateBps,
    taxCents,
    totalCents,
  };
}
