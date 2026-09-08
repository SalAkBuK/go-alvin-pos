import { describe, expect, it } from 'vitest';
import { validateCompleteCashSale } from '../../src/main/checkout/saleValidation';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Trusted validation of the `checkout:complete-cash` payload (structure only —
 * money/stock/drift are the sale service's job). `TEST_PLAN.md` TEST-CART-009
 * spirit: rejected at the trusted boundary regardless of the renderer.
 */

const FP = 'a'.repeat(64);
const goodCheckout = {
  customerId: null,
  paymentMethod: 'CASH' as const,
  lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 100 }],
};

function expectValidationError(fn: () => unknown) {
  try {
    fn();
    throw new Error('expected a validation error');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('validateCompleteCashSale', () => {
  it('accepts a well-formed payload and trims the request id', () => {
    const result = validateCompleteCashSale({
      requestId: '  req-123  ',
      reviewedFingerprint: FP,
      checkout: goodCheckout,
    });
    expect(result.requestId).toBe('req-123');
    expect(result.reviewedFingerprint).toBe(FP);
    expect(result.checkout.lines).toHaveLength(1);
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
  ])('rejects a payload that is %s', (_label, raw) => {
    expectValidationError(() => validateCompleteCashSale(raw));
  });

  it('rejects unexpected top-level fields', () => {
    expectValidationError(() =>
      validateCompleteCashSale({
        requestId: 'r',
        reviewedFingerprint: FP,
        checkout: goodCheckout,
        extra: 1,
      }),
    );
  });

  it.each([
    ['missing request id', { reviewedFingerprint: FP, checkout: goodCheckout }],
    ['blank request id', { requestId: '   ', reviewedFingerprint: FP, checkout: goodCheckout }],
    ['non-string request id', { requestId: 5, reviewedFingerprint: FP, checkout: goodCheckout }],
    [
      'over-long request id',
      { requestId: 'x'.repeat(201), reviewedFingerprint: FP, checkout: goodCheckout },
    ],
  ])('rejects %s', (_label, raw) => {
    expectValidationError(() => validateCompleteCashSale(raw));
  });

  it.each([
    ['missing fingerprint', { requestId: 'r', checkout: goodCheckout }],
    ['short fingerprint', { requestId: 'r', reviewedFingerprint: 'abc', checkout: goodCheckout }],
    [
      'uppercase-hex fingerprint',
      { requestId: 'r', reviewedFingerprint: 'A'.repeat(64), checkout: goodCheckout },
    ],
    [
      'non-hex fingerprint',
      { requestId: 'r', reviewedFingerprint: 'z'.repeat(64), checkout: goodCheckout },
    ],
  ])('rejects %s', (_label, raw) => {
    expectValidationError(() => validateCompleteCashSale(raw));
  });

  it('rejects a Card checkout — Cash completion only', () => {
    expectValidationError(() =>
      validateCompleteCashSale({
        requestId: 'r',
        reviewedFingerprint: FP,
        checkout: { ...goodCheckout, paymentMethod: 'CARD' },
      }),
    );
  });

  it('rejects a checkout that is not a valid review request (empty lines)', () => {
    expectValidationError(() =>
      validateCompleteCashSale({
        requestId: 'r',
        reviewedFingerprint: FP,
        checkout: { customerId: null, paymentMethod: 'CASH', lines: [] },
      }),
    );
  });

  it('rejects a smuggled authoritative field inside a cart line', () => {
    expectValidationError(() =>
      validateCompleteCashSale({
        requestId: 'r',
        reviewedFingerprint: FP,
        checkout: {
          customerId: null,
          paymentMethod: 'CASH',
          lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 100, listedPriceCents: 1 }],
        },
      }),
    );
  });
});
