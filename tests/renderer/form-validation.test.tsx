import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdjustStockPanel } from '../../src/renderer/src/features/products/AdjustStockPanel';
import { ProductForm } from '../../src/renderer/src/features/products/ProductForm';
import {
  mapProductServerError,
  resultingQuantity,
  validateAdjustmentForm,
  validateProductForm,
} from '../../src/renderer/src/features/products/formValidation';
import type {
  AdjustmentFormFields,
  ProductFormFields,
} from '../../src/renderer/src/features/products/formValidation';
import type { ProductRecord } from '../../src/shared/products';

/**
 * Phase 2B renderer UX polish — field-level form validation.
 *
 * The form components run every blur/submit check through the pure
 * `formValidation` module, so exercising that module exercises the exact code
 * path that gates an IPC submission. `validateProductForm` returning
 * `payload: null` (or `validateAdjustmentForm` returning `ok: false`) is what
 * stops `handleSubmit` before it ever calls `window.pos.*` — nothing is coerced
 * to `0` and no IPC call is made.
 */

function productFields(overrides: Partial<ProductFormFields> = {}): ProductFormFields {
  return {
    name: 'iPhone 15 128GB',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPrice: '599.00',
    quantity: '5',
    sku: '',
    barcode: '',
    costPrice: '',
    lowStockThreshold: '',
    ...overrides,
  };
}

function adjustmentFields(overrides: Partial<AdjustmentFormFields> = {}): AdjustmentFormFields {
  return { mode: 'delta', value: '2', reason: 'Physical recount', ...overrides };
}

const sampleProduct: ProductRecord = {
  id: 'p1',
  sku: null,
  barcode: null,
  name: 'iPhone 15',
  brand: 'Apple',
  model: 'iPhone 15',
  condition: 'NEW',
  costPriceCents: null,
  sellingPriceCents: 59900,
  quantityOnHand: 1,
  lowStockThreshold: null,
  isActive: true,
  lowStock: false,
  zeroStock: false,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
};

describe('product form — required text', () => {
  it('rejects a blank name, brand, and model before IPC', () => {
    const result = validateProductForm(
      productFields({ name: '  ', brand: '', model: '\t' }),
      'create',
    );
    expect(result.payload).toBeNull();
    expect(result.errors.name).toMatch(/required/i);
    expect(result.errors.brand).toMatch(/required/i);
    expect(result.errors.model).toMatch(/required/i);
  });
});

describe('product form — selling price', () => {
  it('rejects blank selling price and does not coerce to 0', () => {
    const result = validateProductForm(productFields({ sellingPrice: '' }), 'create');
    expect(result.payload).toBeNull();
    expect(result.errors.sellingPrice).toMatch(/required/i);
  });

  it('rejects a non-numeric selling price', () => {
    expect(
      validateProductForm(productFields({ sellingPrice: 'abc' }), 'create').errors.sellingPrice,
    ).toMatch(/dollar amount/i);
  });

  it('rejects a negative selling price', () => {
    expect(
      validateProductForm(productFields({ sellingPrice: '-5' }), 'create').errors.sellingPrice,
    ).toMatch(/negative/i);
  });

  it('rejects a selling price with more than 2 decimal places', () => {
    expect(
      validateProductForm(productFields({ sellingPrice: '10.999' }), 'create').errors.sellingPrice,
    ).toMatch(/2 decimal places/i);
  });

  it('rejects a selling price above the $99,999.99 canonical ceiling', () => {
    expect(
      validateProductForm(productFields({ sellingPrice: '100000' }), 'create').errors.sellingPrice,
    ).toMatch(/99,999\.99/);
    expect(
      validateProductForm(productFields({ sellingPrice: '99999.99' }), 'create').errors
        .sellingPrice,
    ).toBeUndefined();
  });
});

describe('product form — starting quantity (create only)', () => {
  it('rejects blank / negative / fractional / non-numeric quantity without coercing to 0', () => {
    for (const quantity of ['', '-1', '1.5', 'abc']) {
      const result = validateProductForm(productFields({ quantity }), 'create');
      expect(result.payload).toBeNull();
      expect(result.errors.quantity).toBeTruthy();
    }
  });

  it('ignores quantity entirely in edit mode', () => {
    const result = validateProductForm(productFields({ quantity: '-5' }), 'edit');
    expect(result.errors.quantity).toBeUndefined();
    expect(result.payload).not.toBeNull();
  });
});

describe('product form — optional cost price and low-stock threshold', () => {
  it('accepts a blank optional cost price and threshold', () => {
    const result = validateProductForm(
      productFields({ costPrice: '', lowStockThreshold: '' }),
      'create',
    );
    expect(result.errors.costPrice).toBeUndefined();
    expect(result.errors.lowStockThreshold).toBeUndefined();
    expect(result.payload).not.toBeNull();
  });

  it('rejects an invalid cost price when one is provided', () => {
    for (const costPrice of ['abc', '-1', '1.234']) {
      expect(
        validateProductForm(productFields({ costPrice }), 'create').errors.costPrice,
      ).toBeTruthy();
    }
  });

  it('rejects a negative or fractional low-stock threshold', () => {
    expect(
      validateProductForm(productFields({ lowStockThreshold: '-1' }), 'create').errors
        .lowStockThreshold,
    ).toMatch(/negative/i);
    expect(
      validateProductForm(productFields({ lowStockThreshold: '2.5' }), 'create').errors
        .lowStockThreshold,
    ).toMatch(/whole number/i);
  });
});

describe('product form — valid input still builds the correct payload', () => {
  it('create: produces a CreateProductInput with integer cents and no coercion surprises', () => {
    const result = validateProductForm(
      productFields({
        name: '  iPhone 15 128GB  ',
        sellingPrice: '599.99',
        quantity: '5',
        costPrice: '450',
        lowStockThreshold: '2',
        sku: '  IP15-128  ',
        barcode: '  0012345  ',
      }),
      'create',
    );
    expect(result.errors).toEqual({});
    expect(result.payload).toEqual({
      name: 'iPhone 15 128GB',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'NEW',
      sellingPriceCents: 59999,
      quantity: 5,
      sku: 'IP15-128',
      barcode: '0012345',
      costPriceCents: 45000,
      lowStockThreshold: 2,
    });
  });

  it('create: blank SKU / barcode become null', () => {
    const result = validateProductForm(productFields({ sku: '   ', barcode: '' }), 'create');
    expect(result.payload).toMatchObject({ sku: null, barcode: null });
  });

  it('edit: produces an UpdateProductInput without a quantity field', () => {
    const result = validateProductForm(productFields(), 'edit');
    expect(result.payload).not.toBeNull();
    expect(result.payload && 'quantity' in result.payload).toBe(false);
  });
});

describe('product form — trusted/server errors map to a field or the form', () => {
  it('duplicate barcode / SKU messages map to their field', () => {
    expect(mapProductServerError('This barcode is already assigned to another product.')).toEqual({
      field: 'barcode',
      message: 'This barcode is already assigned to another product.',
    });
    expect(mapProductServerError('This SKU is already assigned to another product.')).toEqual({
      field: 'sku',
      message: 'This SKU is already assigned to another product.',
    });
  });

  it('any other server message stays a general form error', () => {
    expect(mapProductServerError('Something went wrong. Please try again.').field).toBe('form');
  });
});

describe('adjustment form', () => {
  it('rejects a blank adjustment value before IPC', () => {
    const result = validateAdjustmentForm(adjustmentFields({ value: '' }), 5);
    expect(result.ok).toBe(false);
    expect(result.errors.value).toMatch(/required/i);
  });

  it('rejects a non-integer delta and a negative target', () => {
    expect(
      validateAdjustmentForm(adjustmentFields({ mode: 'delta', value: '1.5' }), 5).errors.value,
    ).toBeTruthy();
    expect(
      validateAdjustmentForm(adjustmentFields({ mode: 'delta', value: 'abc' }), 5).errors.value,
    ).toBeTruthy();
    expect(
      validateAdjustmentForm(adjustmentFields({ mode: 'target', value: '-1' }), 5).errors.value,
    ).toMatch(/negative/i);
  });

  it('rejects a zero-change adjustment (delta 0 and target === current)', () => {
    expect(
      validateAdjustmentForm(adjustmentFields({ mode: 'delta', value: '0' }), 5).errors.value,
    ).toBeTruthy();
    expect(
      validateAdjustmentForm(adjustmentFields({ mode: 'target', value: '5' }), 5).errors.value,
    ).toBeTruthy();
  });

  it('rejects an adjustment that would make resulting stock negative, before IPC', () => {
    const result = validateAdjustmentForm(adjustmentFields({ mode: 'delta', value: '-2' }), 1);
    expect(result.ok).toBe(false);
    expect(result.errors.value).toMatch(/below zero/i);
    expect(resultingQuantity({ mode: 'delta', value: '-2' }, 1)).toBe(-1);
  });

  it('rejects a blank reason after trimming', () => {
    const result = validateAdjustmentForm(adjustmentFields({ reason: '   ' }), 5);
    expect(result.ok).toBe(false);
    expect(result.errors.reason).toMatch(/required/i);
  });

  it('accepts a valid delta and a valid target adjustment', () => {
    expect(validateAdjustmentForm(adjustmentFields({ mode: 'delta', value: '+3' }), 5).ok).toBe(
      true,
    );
    expect(validateAdjustmentForm({ mode: 'target', value: '9', reason: 'Recount' }, 5).ok).toBe(
      true,
    );
  });
});

describe('forms are not noisy on first render', () => {
  it('ProductForm shows no field errors or aria-invalid before interaction', () => {
    const html = renderToStaticMarkup(
      <ProductForm mode="create" onCreate={async () => null} onCancel={() => {}} />,
    );
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('class="field-error"');
    expect(html.toLowerCase()).toContain('novalidate');
  });

  it('AdjustStockPanel shows no field errors before interaction', () => {
    const html = renderToStaticMarkup(
      <AdjustStockPanel product={sampleProduct} onSubmit={async () => null} onCancel={() => {}} />,
    );
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('class="field-error"');
  });
});
