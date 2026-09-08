import { describe, expect, it } from 'vitest';
import {
  computeCheckoutFingerprint,
  serializeCheckoutIntent,
} from '../../src/main/checkout/checkoutFingerprint';
import type { CheckoutFingerprintInput } from '../../src/main/checkout/checkoutFingerprint';
import type { CanonicalLine } from '../../src/main/checkout/checkoutCalculation';

/**
 * Deterministic checkout fingerprint — the Phase-2D-testable portion of
 * `TEST_PLAN.md` TEST-IDEMP-008 (`DATA_MODEL.md §41B`).
 *
 * NOT covered here (needs durable sale / checkout-request implementation):
 * TEST-IDEMP-001..007, commit-time drift rejection, Card total enforcement.
 */

const l = (p: Partial<CanonicalLine>): CanonicalLine => ({
  productId: 'p',
  listedPriceCents: 0,
  soldPriceCents: 0,
  quantity: 1,
  ...p,
});

function input(overrides: Partial<CheckoutFingerprintInput>): CheckoutFingerprintInput {
  return {
    customerId: null,
    lines: [],
    taxRateBps: 825,
    subtotalCents: 0,
    discountCents: 0,
    taxableAmountCents: 0,
    taxCents: 0,
    totalCents: 0,
    paymentMethod: 'CASH',
    ...overrides,
  };
}

const productA = '11111111-1111-1111-1111-111111111111';
const productB = '22222222-2222-2222-2222-222222222222';

// Cart (1): same product on two lines at different prices, plus a second product.
const cart1: CanonicalLine[] = [
  l({ productId: productA, listedPriceCents: 59900, soldPriceCents: 59900, quantity: 1 }),
  l({ productId: productA, listedPriceCents: 59900, soldPriceCents: 55000, quantity: 1 }),
  l({ productId: productB, listedPriceCents: 48000, soldPriceCents: 48000, quantity: 2 }),
];
// Cart (2): identical tuples, reverse insertion order.
const cart2: CanonicalLine[] = [...cart1].reverse();
// Cart (3): genuine change — one line's quantity differs.
const cart3: CanonicalLine[] = cart1.map((line, i) => (i === 2 ? { ...line, quantity: 3 } : line));

describe('TEST-IDEMP-008 — deterministic fingerprint ordering', () => {
  it('(1) and (2) — same line multiset, different order → identical fingerprint', () => {
    expect(computeCheckoutFingerprint(input({ lines: cart1 }))).toBe(
      computeCheckoutFingerprint(input({ lines: cart2 })),
    );
  });

  it('(3) — a genuine content change → different fingerprint', () => {
    expect(computeCheckoutFingerprint(input({ lines: cart1 }))).not.toBe(
      computeCheckoutFingerprint(input({ lines: cart3 })),
    );
  });

  it('(4) — exact-duplicate tuples: both input orders match, and both entries are represented', () => {
    const dupA: CanonicalLine[] = [
      l({ productId: productA, listedPriceCents: 1000, soldPriceCents: 900, quantity: 2 }),
      l({ productId: productA, listedPriceCents: 1000, soldPriceCents: 900, quantity: 2 }),
      l({ productId: productB, listedPriceCents: 500, soldPriceCents: 500, quantity: 1 }),
    ];
    const dupB: CanonicalLine[] = [dupA[2]!, dupA[1]!, dupA[0]!];
    expect(computeCheckoutFingerprint(input({ lines: dupA }))).toBe(
      computeCheckoutFingerprint(input({ lines: dupB })),
    );
    // The serialization keeps two separate [productA,1000,900,2] entries.
    const serialized = serializeCheckoutIntent(input({ lines: dupA }));
    const matches = serialized.match(/\["11111111-1111-1111-1111-111111111111",1000,900,2\]/g);
    expect(matches).toHaveLength(2);
  });

  it('stock aggregation is independent of fingerprint line preservation', () => {
    // Splitting one product's quantity across two lines vs. one combined line
    // fingerprints differently (the tuples differ) even though stock validation
    // would aggregate them to the same total.
    const split: CanonicalLine[] = [
      l({ productId: productA, listedPriceCents: 1000, soldPriceCents: 1000, quantity: 1 }),
      l({ productId: productA, listedPriceCents: 1000, soldPriceCents: 1000, quantity: 2 }),
    ];
    const combined: CanonicalLine[] = [
      l({ productId: productA, listedPriceCents: 1000, soldPriceCents: 1000, quantity: 3 }),
    ];
    expect(computeCheckoutFingerprint(input({ lines: split }))).not.toBe(
      computeCheckoutFingerprint(input({ lines: combined })),
    );
  });
});

describe('material non-line changes → different fingerprint', () => {
  const base = input({ lines: cart1, totalCents: 100, taxableAmountCents: 100 });
  it.each([
    ['customer', input({ ...base, customerId: productB })],
    ['payment method', input({ ...base, paymentMethod: 'CARD' })],
    ['tax rate', input({ ...base, taxRateBps: 600 })],
    ['tax cents', input({ ...base, taxCents: 9 })],
    ['total cents', input({ ...base, totalCents: 999 })],
    ['discount cents', input({ ...base, discountCents: 1 })],
    ['subtotal cents', input({ ...base, subtotalCents: 7 })],
  ])('changing %s changes the fingerprint', (_label, changed) => {
    expect(computeCheckoutFingerprint(base)).not.toBe(computeCheckoutFingerprint(changed));
  });
});

describe('determinism', () => {
  it('is a 64-char hex sha256 digest, identical across repeated calls', () => {
    const fp = computeCheckoutFingerprint(input({ lines: cart1 }));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 10; i += 1) {
      expect(computeCheckoutFingerprint(input({ lines: cart1 }))).toBe(fp);
    }
  });
});
