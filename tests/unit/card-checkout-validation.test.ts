import { describe, expect, it } from 'vitest';
import {
  validateCardCheckout,
  validateDeclineCard,
} from '../../src/main/checkout/cardCheckoutValidation';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Phase 2F trusted validation of the Card channel payloads (`ARCHITECTURE.md
 * §30`; task Phase 2F `§7`, `§11`). Structure only — the service owns money,
 * stock, tax, drift, and the Card total invariant.
 */

const FP = 'a'.repeat(64);
const cardCheckout = {
  customerId: null,
  paymentMethod: 'CARD' as const,
  lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 59900 }],
};

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('expected rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe(code);
  }
}

describe('validateCardCheckout', () => {
  it('accepts a well-formed CARD payload and trims the request id', () => {
    const v = validateCardCheckout({
      requestId: '  req-1  ',
      reviewedFingerprint: FP,
      checkout: cardCheckout,
    });
    expect(v.requestId).toBe('req-1');
    expect(v.checkout.paymentMethod).toBe('CARD');
  });

  it('rejects a CASH checkout on the Card channel', () => {
    expectCode(
      () =>
        validateCardCheckout({
          requestId: 'r',
          reviewedFingerprint: FP,
          checkout: { ...cardCheckout, paymentMethod: 'CASH' },
        }),
      'VALIDATION',
    );
  });

  it('rejects a missing / malformed fingerprint', () => {
    expectCode(
      () =>
        validateCardCheckout({
          requestId: 'r',
          reviewedFingerprint: 'short',
          checkout: cardCheckout,
        }),
      'VALIDATION',
    );
  });

  it('rejects an unexpected top-level field', () => {
    expectCode(
      () =>
        validateCardCheckout({
          requestId: 'r',
          reviewedFingerprint: FP,
          checkout: cardCheckout,
          cloverApproved: true,
        }),
      'VALIDATION',
    );
  });

  it('rejects a blank request id', () => {
    expectCode(
      () =>
        validateCardCheckout({ requestId: '   ', reviewedFingerprint: FP, checkout: cardCheckout }),
      'VALIDATION',
    );
  });
});

describe('validateDeclineCard', () => {
  it('accepts requestId + fingerprint only', () => {
    expect(validateDeclineCard({ requestId: 'r', reviewedFingerprint: FP })).toEqual({
      requestId: 'r',
      reviewedFingerprint: FP,
    });
  });

  it('rejects an extra field (e.g. a cart body)', () => {
    expectCode(
      () =>
        validateDeclineCard({ requestId: 'r', reviewedFingerprint: FP, checkout: cardCheckout }),
      'VALIDATION',
    );
  });
});
