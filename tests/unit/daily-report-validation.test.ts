import { describe, expect, it } from 'vitest';
import { validateDailyReportInput } from '../../src/main/reports/dailyReportValidation';
import { isAppError } from '../../src/main/shared/appError';

/**
 * Phase 2K — trusted `reports:daily` payload validation. The renderer is never
 * the boundary; a malformed / impossible date is rejected cleanly and there is
 * no way to express SQL, a range, or a column.
 */

function expectValidation(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a VALIDATION error');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('validateDailyReportInput — an OMITTED date means "current business day"', () => {
  it.each([undefined, null, {}, { businessDate: null }])('%o → { businessDate: null }', (raw) => {
    expect(validateDailyReportInput(raw)).toEqual({ businessDate: null });
  });
});

describe('validateDailyReportInput — an explicitly-supplied empty/blank date is rejected', () => {
  it("{ businessDate: '' } → VALIDATION (not treated as today)", () => {
    expectValidation(() => validateDailyReportInput({ businessDate: '' }));
  });

  it("{ businessDate: '   ' } → VALIDATION", () => {
    expectValidation(() => validateDailyReportInput({ businessDate: '   ' }));
    expectValidation(() => validateDailyReportInput({ businessDate: '\t' }));
  });
});

describe('validateDailyReportInput — a specific day', () => {
  it('accepts a real YYYY-MM-DD and trims it', () => {
    expect(validateDailyReportInput({ businessDate: '2026-09-07' })).toEqual({
      businessDate: '2026-09-07',
    });
    expect(validateDailyReportInput({ businessDate: '  2026-02-28  ' })).toEqual({
      businessDate: '2026-02-28',
    });
    // A real leap day.
    expect(validateDailyReportInput({ businessDate: '2028-02-29' })).toEqual({
      businessDate: '2028-02-29',
    });
  });
});

describe('validateDailyReportInput — rejections', () => {
  it('rejects an impossible calendar date (2026-02-30)', () => {
    expectValidation(() => validateDailyReportInput({ businessDate: '2026-02-30' }));
  });

  it('rejects a non-leap Feb 29', () => {
    expectValidation(() => validateDailyReportInput({ businessDate: '2027-02-29' }));
  });

  it.each([
    'garbage',
    '2026-9-7',
    '2026/09/07',
    '26-09-07',
    '2026-13-01',
    '2026-00-10',
    '2026-09-00',
    '2026-09-32',
    '2026-09-07T00:00:00Z',
  ])('rejects the malformed date %j', (value) => {
    expectValidation(() => validateDailyReportInput({ businessDate: value }));
  });

  it('rejects a non-string businessDate', () => {
    expectValidation(() => validateDailyReportInput({ businessDate: 20260907 }));
    expectValidation(() => validateDailyReportInput({ businessDate: ['2026-09-07'] }));
  });

  it('rejects unexpected fields (no generic query surface)', () => {
    expectValidation(() => validateDailyReportInput({ businessDate: '2026-09-07', where: '1=1' }));
    expectValidation(() => validateDailyReportInput({ sql: 'select 1' }));
    expectValidation(() => validateDailyReportInput({ startDate: '2026-09-01' }));
  });

  it('rejects a non-object payload', () => {
    expectValidation(() => validateDailyReportInput('2026-09-07'));
    expectValidation(() => validateDailyReportInput(42));
    expectValidation(() => validateDailyReportInput(['2026-09-07']));
  });
});
