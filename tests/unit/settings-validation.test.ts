import { describe, expect, it } from 'vitest';
import { validateTaxRateUpdate } from '../../src/main/settings/settingsValidation';
import { TAX_RATE_BPS_MAX } from '../../src/main/settings/settingsRepository';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Trusted-boundary validation of the tax-rate update payload (task `§8`,
 * `DATA_MODEL.md §20`, `POS_WORKFLOWS.md §68` step 1).
 */

function expectReject(payload: unknown) {
  try {
    validateTaxRateUpdate(payload);
    throw new Error('expected a VALIDATION rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('accepts valid basis-point values', () => {
  it.each([0, 1, 600, 825, 1000, TAX_RATE_BPS_MAX])('accepts %d bps', (taxRateBps) => {
    expect(validateTaxRateUpdate({ taxRateBps })).toEqual({ taxRateBps });
  });

  it('accepts zero (the schema bound is >= 0, so no tax is a valid configured rate)', () => {
    expect(validateTaxRateUpdate({ taxRateBps: 0 })).toEqual({ taxRateBps: 0 });
  });
});

describe('rejects malformed / out-of-bound values, never coercing', () => {
  it.each([
    -1,
    -825,
    8.25,
    0.5,
    TAX_RATE_BPS_MAX + 1,
    200000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '825',
    null,
    undefined,
  ])('rejects taxRateBps %p', (taxRateBps) => {
    expectReject({ taxRateBps });
  });

  it.each([null, undefined, 42, 'nope', [], { taxRateBps: 825, extra: true }, {}])(
    'rejects payload %p',
    (payload) => {
      expectReject(payload);
    },
  );
});
