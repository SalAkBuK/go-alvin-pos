import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/main/shared/appError';
import {
  normalizePhone,
  validateCreateCustomer,
  validateCustomerId,
  validateCustomerSearchQuery,
  validateUpdateCustomer,
} from '../../src/main/customers/customerValidation';

/**
 * Trusted customer-validation unit coverage (task `§3`). Nothing here touches
 * SQLite — this is the boundary that must reject malformed input before any
 * service/repository runs.
 */

describe('normalizePhone', () => {
  it.each([
    ['(281) 824-0001', '2818240001'],
    ['281-824-0001', '2818240001'],
    ['2818240001', '2818240001'],
    ['+1 (281) 824.0001 x9', '128182400019'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe('validateCreateCustomer', () => {
  it('trims the name and returns it', () => {
    expect(validateCreateCustomer({ name: '  Jane  ' })).toEqual({
      name: 'Jane',
      phone: null,
      phoneNormalized: null,
    });
  });

  it('name-only is valid', () => {
    expect(validateCreateCustomer({ name: 'Jane' }).phone).toBeNull();
  });

  it('preserves the trimmed human phone and derives digits-only normalized form', () => {
    const result = validateCreateCustomer({ name: 'Jane', phone: '  (281) 824-0001  ' });
    expect(result.phone).toBe('(281) 824-0001');
    expect(result.phoneNormalized).toBe('2818240001');
  });

  it('blank / whitespace / null / absent phone all → null', () => {
    for (const phone of ['', '   ', null, undefined]) {
      expect(validateCreateCustomer({ name: 'Jane', phone }).phone).toBeNull();
      expect(validateCreateCustomer({ name: 'Jane', phone }).phoneNormalized).toBeNull();
    }
  });

  it.each([
    ['blank name', { name: '   ' }],
    ['whitespace-only name', { name: '\t\n ' }],
    ['missing name', {}],
    ['non-string name', { name: 5 }],
    ['non-string phone', { name: 'Jane', phone: 5551234 }],
    ['phone with no digits', { name: 'Jane', phone: '()- .' }],
    ['unexpected field', { name: 'Jane', nickname: 'JJ' }],
    ['array', ['name']],
    ['string', 'Jane'],
  ])('rejects %s as a VALIDATION error', (_label, payload) => {
    try {
      validateCreateCustomer(payload);
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('validateUpdateCustomer', () => {
  it('applies the same rules as create', () => {
    expect(validateUpdateCustomer({ name: 'Jane', phone: '281.824.0001' })).toEqual({
      name: 'Jane',
      phone: '281.824.0001',
      phoneNormalized: '2818240001',
    });
    expect(() => validateUpdateCustomer({ name: '' })).toThrow();
  });
});

describe('validateCustomerId / validateCustomerSearchQuery', () => {
  it('rejects a blank / non-string id', () => {
    expect(() => validateCustomerId('')).toThrow();
    expect(() => validateCustomerId(123)).toThrow();
    expect(validateCustomerId('  abc  ')).toBe('abc');
  });

  it('trims a search query and accepts an empty one (means "list")', () => {
    expect(validateCustomerSearchQuery('  jane  ')).toBe('jane');
    expect(validateCustomerSearchQuery('')).toBe('');
    expect(() => validateCustomerSearchQuery(5)).toThrow();
  });
});
