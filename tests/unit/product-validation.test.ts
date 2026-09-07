import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/main/shared/appError';
import {
  validateAdjustment,
  validateBarcodeQuery,
  validateCreateProduct,
  validateUpdateProduct,
} from '../../src/main/products/productValidation';

/**
 * Trusted-validation unit coverage (task `§3`, `DATA_MODEL.md §41A`). Nothing
 * here touches SQLite — this is the boundary that must reject malformed input
 * before any service/repository runs.
 */

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: '  iPhone 15  ',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity: 5,
    ...overrides,
  };
}

describe('validateCreateProduct', () => {
  it('trims required strings and normalises blank SKU/barcode to null', () => {
    const result = validateCreateProduct(
      validCreate({ sku: '  ', barcode: '\t', costPriceCents: null }),
    );
    expect(result.name).toBe('iPhone 15');
    expect(result.sku).toBeNull();
    expect(result.barcode).toBeNull();
    expect(result.costPriceCents).toBeNull();
  });

  it('keeps a leading-zero barcode intact (trimmed only)', () => {
    expect(validateCreateProduct(validCreate({ barcode: ' 0012 ' })).barcode).toBe('0012');
  });

  it.each([
    ['blank name', validCreate({ name: '   ' })],
    ['missing brand', { ...validCreate(), brand: undefined }],
    ['bad condition', validCreate({ condition: 'LIKE_NEW' })],
    ['float price', validCreate({ sellingPriceCents: 1.5 })],
    ['string price', validCreate({ sellingPriceCents: '599' })],
    ['NaN price', validCreate({ sellingPriceCents: Number.NaN })],
    ['Infinity price', validCreate({ sellingPriceCents: Number.POSITIVE_INFINITY })],
    ['negative price', validCreate({ sellingPriceCents: -1 })],
    ['over-ceiling price', validCreate({ sellingPriceCents: 10_000_000 })],
    ['negative quantity', validCreate({ quantity: -1 })],
    ['float quantity', validCreate({ quantity: 2.5 })],
    ['negative threshold', validCreate({ lowStockThreshold: -1 })],
    ['unexpected field', validCreate({ imei: '123' })],
    ['not an object', 42],
  ])('rejects %s as a VALIDATION error', (_label, payload) => {
    try {
      validateCreateProduct(payload);
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('validateUpdateProduct', () => {
  it('rejects a payload carrying quantity / quantityOnHand', () => {
    expect(() =>
      validateUpdateProduct({
        name: 'x',
        brand: 'x',
        model: 'x',
        condition: 'NEW',
        sellingPriceCents: 100,
        costPriceCents: null,
        sku: null,
        barcode: null,
        lowStockThreshold: null,
        quantityOnHand: 9,
      }),
    ).toThrow(/Adjust Stock/i);
  });
});

describe('validateAdjustment', () => {
  it('accepts a signed delta with a reason', () => {
    expect(
      validateAdjustment({ productId: 'p1', mode: 'delta', delta: -2, reason: 'Damaged' }),
    ).toEqual({ productId: 'p1', mode: 'delta', delta: -2, reason: 'Damaged' });
  });

  it('accepts a target quantity', () => {
    expect(
      validateAdjustment({ productId: 'p1', mode: 'target', targetQuantity: 7, reason: 'Recount' }),
    ).toMatchObject({ mode: 'target', targetQuantity: 7 });
  });

  it.each([
    ['zero delta', { productId: 'p1', mode: 'delta', delta: 0, reason: 'x' }],
    ['float delta', { productId: 'p1', mode: 'delta', delta: 1.5, reason: 'x' }],
    ['missing reason', { productId: 'p1', mode: 'delta', delta: 1 }],
    ['blank reason', { productId: 'p1', mode: 'delta', delta: 1, reason: '   ' }],
    ['negative target', { productId: 'p1', mode: 'target', targetQuantity: -1, reason: 'x' }],
    ['bad mode', { productId: 'p1', mode: 'set', value: 1, reason: 'x' }],
    ['unexpected field', { productId: 'p1', mode: 'delta', delta: 1, reason: 'x', evil: 1 }],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateAdjustment(payload)).toThrow();
  });
});

describe('validateBarcodeQuery', () => {
  it('trims but preserves case and leading zeroes', () => {
    expect(validateBarcodeQuery('  0012AbC \n')).toBe('0012AbC');
  });
  it('rejects a blank or non-string value', () => {
    expect(() => validateBarcodeQuery('   ')).toThrow();
    expect(() => validateBarcodeQuery(123)).toThrow();
  });
});
