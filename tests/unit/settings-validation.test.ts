import { describe, expect, it } from 'vitest';
import {
  validateBusinessConfigUpdate,
  validateTaxRateUpdate,
} from '../../src/main/settings/settingsValidation';
import {
  BUSINESS_ADDRESS_MAX_LENGTH,
  BUSINESS_PHONE_MAX_LENGTH,
  RECEIPT_DISCLAIMER_MAX_LENGTH,
  RECEIPT_FOOTER_MAX_LENGTH,
  TAX_RATE_BPS_MAX,
} from '../../src/main/settings/settingsRepository';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Trusted-boundary validation of the settings update payloads (task `§9`,
 * `DATA_MODEL.md §20`, `§44-49`, `POS_WORKFLOWS.md §68`/`§69`).
 */

function expectReject(payload: unknown) {
  try {
    validateTaxRateUpdate(payload);
    throw new Error('expected a VALIDATION rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

function baseBusiness(overrides: Record<string, unknown> = {}) {
  return {
    businessAddress: '123 Main St, Alvin, TX 77511',
    businessPhone: '(281) 555-0100',
    receiptDisclaimer: 'All sales final. 30-day warranty on refurbished devices.',
    receiptFooter: 'Thank you for shopping with us!',
    ...overrides,
  };
}

function expectBusinessReject(payload: unknown) {
  try {
    validateBusinessConfigUpdate(payload);
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

describe('validateBusinessConfigUpdate', () => {
  it('accepts a complete payload and returns trimmed values', () => {
    const result = validateBusinessConfigUpdate(
      baseBusiness({
        businessAddress: '  123 Main St  ',
        businessPhone: '  555-0100  ',
        receiptDisclaimer: '  policy text  ',
        receiptFooter: '  thanks  ',
      }),
    );
    expect(result).toEqual({
      businessAddress: '123 Main St',
      businessPhone: '555-0100',
      receiptDisclaimer: 'policy text',
      receiptFooter: 'thanks',
    });
  });

  it('accepts a blank disclaimer and footer (configured blank is permitted)', () => {
    const result = validateBusinessConfigUpdate(
      baseBusiness({ receiptDisclaimer: '', receiptFooter: '   ' }),
    );
    expect(result.receiptDisclaimer).toBe('');
    expect(result.receiptFooter).toBe('');
  });

  it('preserves internal newlines in a multi-line disclaimer', () => {
    const result = validateBusinessConfigUpdate(
      baseBusiness({ receiptDisclaimer: '  line one\nline two  ' }),
    );
    expect(result.receiptDisclaimer).toBe('line one\nline two');
  });

  it.each([
    ['missing address', baseBusiness({ businessAddress: undefined })],
    ['blank address', baseBusiness({ businessAddress: '   ' })],
    ['non-string address', baseBusiness({ businessAddress: 42 })],
    [
      'over-long address',
      baseBusiness({ businessAddress: 'x'.repeat(BUSINESS_ADDRESS_MAX_LENGTH + 1) }),
    ],
    ['missing phone', baseBusiness({ businessPhone: undefined })],
    ['blank phone', baseBusiness({ businessPhone: '  ' })],
    ['phone with no digit', baseBusiness({ businessPhone: 'call the store' })],
    ['over-long phone', baseBusiness({ businessPhone: '1'.repeat(BUSINESS_PHONE_MAX_LENGTH + 1) })],
    [
      'over-long disclaimer',
      baseBusiness({ receiptDisclaimer: 'x'.repeat(RECEIPT_DISCLAIMER_MAX_LENGTH + 1) }),
    ],
    [
      'over-long footer',
      baseBusiness({ receiptFooter: 'x'.repeat(RECEIPT_FOOTER_MAX_LENGTH + 1) }),
    ],
    ['non-string disclaimer', baseBusiness({ receiptDisclaimer: 5 })],
    ['unknown key', baseBusiness({ businessName: 'Someone Else' })],
    ['unknown key', baseBusiness({ selectedPrinter: 'HP' })],
    ['array payload', []],
    ['null payload', null],
    ['string payload', 'nope'],
    ['number payload', 7],
  ])('rejects %s', (_label, payload) => {
    expectBusinessReject(payload);
  });

  it('rejects a payload that tries to smuggle in businessName', () => {
    expectBusinessReject(baseBusiness({ businessName: 'Rogue Store' }));
  });
});
