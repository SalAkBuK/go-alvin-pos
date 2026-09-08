import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_TOTAL_CENTS_MAX,
  PER_UNIT_PRICE_CENTS_MAX,
  formatCents,
  isCentsAmountInRange,
  MoneyParseError,
  parseCurrencyToCents,
} from '../../src/shared/money';

/**
 * Integer-cent money primitives (`TEST_PLAN.md` TEST-MONEY-001..004,
 * `DATA_MODEL.md §5`, `§41A`).
 */

describe('TEST-MONEY-001 — integer cents', () => {
  it('parses "$599.99" style input to 59999 cents (no floating point)', () => {
    expect(parseCurrencyToCents('599.99')).toBe(59999);
    expect(parseCurrencyToCents('599')).toBe(59900);
    expect(parseCurrencyToCents('599.00')).toBe(59900);
    expect(parseCurrencyToCents('550.50')).toBe(55050);
    expect(parseCurrencyToCents('550.5')).toBe(55050);
  });

  it('parses the classic float-error case exactly', () => {
    // 0.1 + 0.2 style: 1010.10 must be 101010, not 101009.99999
    expect(parseCurrencyToCents('1010.10')).toBe(101010);
    expect(parseCurrencyToCents('  70.07  ')).toBe(7007);
  });
});

describe('TEST-MONEY-002 — zero value', () => {
  it('parses "0" and "0.00" to 0', () => {
    expect(parseCurrencyToCents('0')).toBe(0);
    expect(parseCurrencyToCents('0.00')).toBe(0);
  });
});

describe('TEST-MONEY-003 — negative rejected', () => {
  it('rejects a leading minus sign', () => {
    expect(() => parseCurrencyToCents('-1.00')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents('-0.01')).toThrow(MoneyParseError);
  });
});

describe('TEST-MONEY-004 — repeated calculation stability', () => {
  it('returns the identical cent value on every call', () => {
    const results = Array.from({ length: 25 }, () => parseCurrencyToCents('1234.56'));
    expect(new Set(results)).toEqual(new Set([123456]));
  });
});

describe('decimal-string parsing rejects malformed input rather than coercing', () => {
  it.each([
    '',
    '   ',
    'abc',
    '12a',
    '12.',
    '.5',
    '1,234.00',
    '$5.00',
    '5e2',
    'NaN',
    'Infinity',
    '1.999', // more than two fractional digits
    '1.234',
    '10.001',
  ])('rejects %j', (input) => {
    expect(() => parseCurrencyToCents(input)).toThrow(MoneyParseError);
  });

  it('rejects a value whose cents would leave the safe-integer range', () => {
    expect(() => parseCurrencyToCents('999999999999999999')).toThrow(MoneyParseError);
  });
});

describe('formatCents', () => {
  it('formats integer cents with grouping and two decimals', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(59999)).toBe('$599.99');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
    expect(formatCents(null)).toBe('—');
  });
});

describe('canonical ceilings', () => {
  it('exposes the documented per-unit and total ceilings', () => {
    expect(PER_UNIT_PRICE_CENTS_MAX).toBe(9_999_999);
    expect(CHECKOUT_TOTAL_CENTS_MAX).toBe(99_999_999);
  });

  it('isCentsAmountInRange guards non-negative integers within the ceiling', () => {
    expect(isCentsAmountInRange(0, PER_UNIT_PRICE_CENTS_MAX)).toBe(true);
    expect(isCentsAmountInRange(9_999_999, PER_UNIT_PRICE_CENTS_MAX)).toBe(true);
    expect(isCentsAmountInRange(10_000_000, PER_UNIT_PRICE_CENTS_MAX)).toBe(false);
    expect(isCentsAmountInRange(-1, PER_UNIT_PRICE_CENTS_MAX)).toBe(false);
    expect(isCentsAmountInRange(1.5, PER_UNIT_PRICE_CENTS_MAX)).toBe(false);
    expect(isCentsAmountInRange(Number.NaN, PER_UNIT_PRICE_CENTS_MAX)).toBe(false);
    expect(isCentsAmountInRange(Number.POSITIVE_INFINITY, PER_UNIT_PRICE_CENTS_MAX)).toBe(false);
  });
});
