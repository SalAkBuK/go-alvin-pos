import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/main/shared/appError';
import {
  calculateReviewTotals,
  calculateTaxCents,
  canonicalLineOrder,
  lineDiscountCents,
  lineListedSubtotalCents,
  lineTotalCents,
} from '../../src/main/checkout/checkoutCalculation';
import type { CanonicalLine } from '../../src/main/checkout/checkoutCalculation';

/**
 * Pure discount / tax / totals arithmetic
 * (`TEST_PLAN.md` TEST-DISC-001..005 domain portion, TEST-TAX-001/003/005,
 * `DATA_MODEL.md §41`, `§42`, `§43`).
 */

function line(partial: Partial<CanonicalLine>): CanonicalLine {
  return { productId: 'p', listedPriceCents: 0, soldPriceCents: 0, quantity: 1, ...partial };
}

describe('TEST-DISC-001 — simple negotiated price', () => {
  it('$599 listed, $550 sold, qty 1 → $49 discount', () => {
    const l = line({ listedPriceCents: 59900, soldPriceCents: 55000, quantity: 1 });
    expect(lineListedSubtotalCents(l)).toBe(59900);
    expect(lineTotalCents(l)).toBe(55000);
    expect(lineDiscountCents(l)).toBe(4900);
  });
});

describe('TEST-DISC-002 — quantity two', () => {
  it('$599 listed, $550 sold, qty 2 → listed $1198, sold $1100, discount $98', () => {
    const l = line({ listedPriceCents: 59900, soldPriceCents: 55000, quantity: 2 });
    expect(lineListedSubtotalCents(l)).toBe(119800);
    expect(lineTotalCents(l)).toBe(110000);
    expect(lineDiscountCents(l)).toBe(9800);
  });
});

describe('TEST-DISC-003 — no discount', () => {
  it('listed equals sold → discount 0', () => {
    expect(
      lineDiscountCents(line({ listedPriceCents: 12345, soldPriceCents: 12345, quantity: 3 })),
    ).toBe(0);
  });
});

describe('TEST-DISC-005 (domain) — sold price above listed', () => {
  it('is accepted and yields discount 0 (clamped, never negative)', () => {
    const l = line({ listedPriceCents: 59900, soldPriceCents: 65000, quantity: 2 });
    expect(lineDiscountCents(l)).toBe(0);
    expect(lineTotalCents(l)).toBe(130000);
    const totals = calculateReviewTotals([l], 825);
    expect(totals.discountCents).toBe(0);
    expect(totals.taxableAmountCents).toBe(130000);
  });
});

describe('TEST-TAX-003 — tax rounding (concrete expected values)', () => {
  it.each([
    [55000, 825, 4538],
    [33, 825, 3],
    [30, 825, 2],
    [10, 500, 1],
    [100, 825, 8],
    [0, 825, 0],
  ])('taxable %d @ %d bps → %d cents', (taxable, bps, expected) => {
    expect(calculateTaxCents(taxable, bps)).toBe(expected);
  });

  it('is stable across repeated evaluation', () => {
    const runs = Array.from({ length: 20 }, () => calculateTaxCents(55000, 825));
    expect(new Set(runs)).toEqual(new Set([4538]));
  });
});

describe('TEST-TAX-001 / TEST-TAX-005 — transaction-level totals from sold price', () => {
  it('taxes the summed sold-price totals, not the listed totals', () => {
    const lines: CanonicalLine[] = [
      line({ productId: 'a', listedPriceCents: 60000, soldPriceCents: 55000, quantity: 1 }),
    ];
    const totals = calculateReviewTotals(lines, 825);
    expect(totals.subtotalCents).toBe(60000);
    expect(totals.discountCents).toBe(5000);
    expect(totals.taxableAmountCents).toBe(55000); // sold, not listed
    expect(totals.taxCents).toBe(4538);
    expect(totals.totalCents).toBe(59538);
  });

  it('computes tax once for the whole cart, not per line', () => {
    // Two lines summing to a taxable amount of 33 cents.
    const lines: CanonicalLine[] = [
      line({ productId: 'a', listedPriceCents: 17, soldPriceCents: 17, quantity: 1 }),
      line({ productId: 'b', listedPriceCents: 16, soldPriceCents: 16, quantity: 1 }),
    ];
    // Transaction level: taxable 33 → floor((33*825 + 5000)/10000) = 3.
    // Per line it would be floor((17*825+5000)/10000) + floor((16*825+5000)/10000) = 1 + 1 = 2.
    expect(calculateReviewTotals(lines, 825).taxCents).toBe(3);
  });
});

describe('canonical line ordering (DATA_MODEL §41B)', () => {
  it('sorts ascending by (productId, listed, sold, quantity) and never merges duplicates', () => {
    const a = line({ productId: 'p2', listedPriceCents: 100, soldPriceCents: 100, quantity: 1 });
    const b = line({ productId: 'p1', listedPriceCents: 100, soldPriceCents: 90, quantity: 5 });
    const c = line({ productId: 'p1', listedPriceCents: 100, soldPriceCents: 100, quantity: 1 });
    const d = line({ productId: 'p1', listedPriceCents: 100, soldPriceCents: 100, quantity: 1 });
    const ordered = canonicalLineOrder([a, b, c, d]);
    expect(ordered).toEqual([b, c, d, a]);
    expect(ordered).toHaveLength(4); // duplicates c/d both kept
  });
});

describe('ceilings and malformed intermediates', () => {
  it('rejects a total above the canonical $999,999.99 ceiling', () => {
    const l = line({ listedPriceCents: 9_999_999, soldPriceCents: 9_999_999, quantity: 999 });
    try {
      calculateReviewTotals([l], 825);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_TOTAL_EXCEEDED');
    }
  });

  it('rejects a non-integer tax rate', () => {
    expect(() => calculateTaxCents(1000, 8.25)).toThrow();
  });
});
