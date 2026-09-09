import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/main/shared/appError';
import { deriveBusinessDate, isValidBusinessDate } from '../../src/main/salesHistory/businessDate';
import {
  validateHistorySaleId,
  validateHistorySearch,
} from '../../src/main/salesHistory/salesHistoryValidation';

/**
 * Phase 2G — trusted-boundary validation for Sales History (`task §10`, `§37`,
 * `§38`) and the business-date derivation `TEST-HIST-006` depends on.
 */

function expectValidation(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a validation rejection');
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('VALIDATION');
  }
}

describe('validateHistorySearch', () => {
  it('treats undefined / null / {} as "no filters"', () => {
    expect(validateHistorySearch(undefined)).toEqual({ query: '', businessDate: null });
    expect(validateHistorySearch(null)).toEqual({ query: '', businessDate: null });
    expect(validateHistorySearch({})).toEqual({ query: '', businessDate: null });
  });

  it('trims the query and drops a blank/absent date', () => {
    expect(validateHistorySearch({ query: '  GP-000124  ' })).toEqual({
      query: 'GP-000124',
      businessDate: null,
    });
    expect(validateHistorySearch({ query: 'Jane', businessDate: '' })).toEqual({
      query: 'Jane',
      businessDate: null,
    });
  });

  it('accepts a valid YYYY-MM-DD business date', () => {
    expect(validateHistorySearch({ businessDate: '2026-09-09' })).toEqual({
      query: '',
      businessDate: '2026-09-09',
    });
  });

  it('rejects a malformed or impossible date', () => {
    expectValidation(() => validateHistorySearch({ businessDate: '09/09/2026' }));
    expectValidation(() => validateHistorySearch({ businessDate: '2026-13-01' }));
    expectValidation(() => validateHistorySearch({ businessDate: '2026-02-30' }));
  });

  it('rejects a non-string query, an over-long query, and unknown fields (no raw SQL)', () => {
    expectValidation(() => validateHistorySearch({ query: 42 }));
    expectValidation(() => validateHistorySearch({ query: 'x'.repeat(121) }));
    expectValidation(() =>
      validateHistorySearch({ query: 'ok', orderBy: 'total_cents; DROP TABLE sales' }),
    );
    expectValidation(() => validateHistorySearch({ where: '1=1' }));
  });
});

describe('validateHistorySaleId', () => {
  it('trims a real id and rejects blank / non-string', () => {
    expect(validateHistorySaleId('  s-1 ')).toBe('s-1');
    expectValidation(() => validateHistorySaleId('   '));
    expectValidation(() => validateHistorySaleId(123));
    expectValidation(() => validateHistorySaleId(null));
  });
});

describe('isValidBusinessDate', () => {
  it('accepts real dates and rejects the rest', () => {
    expect(isValidBusinessDate('2026-09-09')).toBe(true);
    expect(isValidBusinessDate('2024-02-29')).toBe(true); // leap year
    expect(isValidBusinessDate('2026-02-29')).toBe(false);
    expect(isValidBusinessDate('2026-9-9')).toBe(false);
    expect(isValidBusinessDate('nonsense')).toBe(false);
  });
});

describe('deriveBusinessDate — America/Chicago', () => {
  const tz = 'America/Chicago';

  it('TEST-HIST-006 boundary: 01:30Z belongs to the previous Chicago business date', () => {
    expect(deriveBusinessDate('2026-09-10T01:30:00.000Z', tz)).toBe('2026-09-09');
    expect(deriveBusinessDate('2026-09-10T06:00:00.000Z', tz)).toBe('2026-09-10');
  });

  it('is DST-aware: the same clock-time crosses the date boundary at a different UTC hour in summer vs winter', () => {
    // Winter (CST, UTC-6): 05:30Z is 23:30 the previous day.
    expect(deriveBusinessDate('2026-01-15T05:30:00.000Z', tz)).toBe('2026-01-14');
    // Summer (CDT, UTC-5): 05:30Z is 00:30 the same day; 04:30Z is the previous day.
    expect(deriveBusinessDate('2026-07-15T05:30:00.000Z', tz)).toBe('2026-07-15');
    expect(deriveBusinessDate('2026-07-15T04:30:00.000Z', tz)).toBe('2026-07-14');
  });

  it('falls back to the UTC calendar date for an unknown timezone, and throws on a bad timestamp', () => {
    expect(deriveBusinessDate('2026-09-10T01:30:00.000Z', 'Not/AZone')).toBe('2026-09-10');
    expect(() => deriveBusinessDate('not-a-timestamp', tz)).toThrow();
  });
});
