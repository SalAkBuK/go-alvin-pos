import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/main/shared/appError';
import { validateVoidSaleInput } from '../../src/main/void/voidValidation';
import { VOID_REASON_MAX_LENGTH } from '../../src/shared/salesHistory';

/**
 * Phase 2H — trusted-boundary validation for `sales-history:void` (`task §9`,
 * `REQ-VOID-002`).
 */

function expectValidation(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a validation rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('validateVoidSaleInput', () => {
  it('accepts and trims a real sale id + reason', () => {
    expect(validateVoidSaleInput({ saleId: '  s-1 ', reason: '  rang up twice  ' })).toEqual({
      saleId: 's-1',
      reason: 'rang up twice',
    });
  });

  it('rejects a blank / whitespace-only / missing / non-string reason (REQ-VOID-002)', () => {
    expectValidation(() => validateVoidSaleInput({ saleId: 's1', reason: '   ' }));
    expectValidation(() => validateVoidSaleInput({ saleId: 's1', reason: '' }));
    expectValidation(() => validateVoidSaleInput({ saleId: 's1' }));
    expectValidation(() => validateVoidSaleInput({ saleId: 's1', reason: 42 }));
  });

  it('rejects an over-long reason', () => {
    expectValidation(() =>
      validateVoidSaleInput({ saleId: 's1', reason: 'x'.repeat(VOID_REASON_MAX_LENGTH + 1) }),
    );
    expect(
      validateVoidSaleInput({ saleId: 's1', reason: 'x'.repeat(VOID_REASON_MAX_LENGTH) }).reason
        .length,
    ).toBe(VOID_REASON_MAX_LENGTH);
  });

  it('rejects a blank / missing / non-string sale id', () => {
    expectValidation(() => validateVoidSaleInput({ saleId: '   ', reason: 'ok' }));
    expectValidation(() => validateVoidSaleInput({ reason: 'ok' }));
    expectValidation(() => validateVoidSaleInput({ saleId: 5, reason: 'ok' }));
  });

  it('rejects a non-object and unknown fields (no SQL / extra mutation surface)', () => {
    expectValidation(() => validateVoidSaleInput('void s1'));
    expectValidation(() => validateVoidSaleInput(null));
    expectValidation(() =>
      validateVoidSaleInput({ saleId: 's1', reason: 'ok', voidedAt: '2026-01-01' }),
    );
    expectValidation(() => validateVoidSaleInput({ saleId: 's1', reason: 'ok', syncVersion: 9 }));
  });
});
