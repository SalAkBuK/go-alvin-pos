import { describe, expect, it } from 'vitest';
import { validateCheckoutReviewRequest } from '../../src/main/checkout/checkoutValidation';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Trusted-boundary structural validation of a `checkout:review` payload
 * (`TEST_PLAN.md` TEST-CART-007/008/009, `DATA_MODEL.md §41A`). Authoritative
 * regardless of what the renderer already checked.
 */

function base(overrides: Record<string, unknown> = {}) {
  return {
    customerId: null,
    paymentMethod: 'CASH',
    lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 1000 }],
    ...overrides,
  };
}

function expectValidationReject(payload: unknown) {
  try {
    validateCheckoutReviewRequest(payload);
    throw new Error('expected a VALIDATION rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('accepts a well-formed payload', () => {
  it('normalizes a blank customer id to null and keeps line intent verbatim', () => {
    const result = validateCheckoutReviewRequest(
      base({ customerId: '   ', paymentMethod: 'CARD' }),
    );
    expect(result.customerId).toBeNull();
    expect(result.paymentMethod).toBe('CARD');
    expect(result.lines).toEqual([{ productId: 'p1', quantity: 1, soldPriceCents: 1000 }]);
  });
});

describe('TEST-CART-007 — quantity bounds', () => {
  it.each([0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY, '2', null])(
    'rejects quantity %p',
    (quantity) => {
      expectValidationReject(
        base({ lines: [{ productId: 'p1', quantity, soldPriceCents: 1000 }] }),
      );
    },
  );

  it('accepts the inclusive 1 and 999 bounds', () => {
    expect(
      validateCheckoutReviewRequest(
        base({ lines: [{ productId: 'p1', quantity: 999, soldPriceCents: 1 }] }),
      ).lines[0]?.quantity,
    ).toBe(999);
  });
});

describe('TEST-CART-008 — monetary bounds', () => {
  it.each([-1, 10_000_000, 1.25, Number.NaN, Number.POSITIVE_INFINITY, '10'])(
    'rejects sold price %p',
    (soldPriceCents) => {
      expectValidationReject(base({ lines: [{ productId: 'p1', quantity: 1, soldPriceCents }] }));
    },
  );

  it('accepts the per-unit ceiling of 9,999,999 cents', () => {
    expect(
      validateCheckoutReviewRequest(
        base({ lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 9_999_999 }] }),
      ).lines[0]?.soldPriceCents,
    ).toBe(9_999_999);
  });
});

describe('TEST-CART-009 — malformed / structural input', () => {
  it.each([
    null,
    undefined,
    42,
    'nope',
    [],
    base({ lines: [] }),
    base({ lines: 'not-an-array' }),
    base({ paymentMethod: 'CHECK' }),
    base({ paymentMethod: undefined }),
    base({ lines: [{ productId: '', quantity: 1, soldPriceCents: 1 }] }),
    base({ lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 1, extra: true }] }),
    base({ surprise: 1 }),
  ])('rejects %p', (payload) => {
    expectValidationReject(payload);
  });

  it('rejects a cart with more than the max number of lines', () => {
    const lines = Array.from({ length: 201 }, () => ({
      productId: 'p1',
      quantity: 1,
      soldPriceCents: 1,
    }));
    expectValidationReject(base({ lines }));
  });
});
