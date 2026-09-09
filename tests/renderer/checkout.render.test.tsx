import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { CheckoutPage } from '../../src/renderer/src/features/checkout/CheckoutPage';
import {
  addProduct,
  aggregateQuantityByProduct,
  cartPreview,
  clearCart,
  EMPTY_CART,
  isReviewCurrent,
  previewValidationErrors,
  removeLine,
  setCustomer,
  setPaymentMethod,
  setQuantity,
  setSoldPrice,
  toReviewRequest,
  withReview,
} from '../../src/renderer/src/features/checkout/cart';
import type { CheckoutReview } from '../../src/shared/checkout';
import type { ProductRecord } from '../../src/shared/products';

/**
 * Renderer checkout UX + the pure draft-cart reducer
 * (`TEST_PLAN.md` TEST-CART-001..006/010 renderer/domain portion, task `§16`-`§18`).
 * No jsdom in this suite — assertions are over static markup and the pure module.
 */

function makeProduct(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: 'p1',
    sku: null,
    barcode: null,
    name: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    costPriceCents: null,
    sellingPriceCents: 59900,
    quantityOnHand: 5,
    lowStockThreshold: null,
    isActive: true,
    lowStock: false,
    zeroStock: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkout screen renders on the shell', () => {
  it('App shows a New Sale nav entry', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('New Sale');
  });

  it('CheckoutPage shows the canonical review fields and no completion control before a review', () => {
    const html = renderToStaticMarkup(<CheckoutPage />);
    for (const label of [
      'Subtotal',
      'Discount',
      'Taxable amount',
      'Tax',
      'Final total',
      'Payment method',
      'Customer (optional)',
      'Clear cart',
      'Review checkout',
    ]) {
      expect(html).toContain(label);
    }
    // Neither the Cash nor the Card completion control renders until a review
    // exists — the empty cart only offers Clear cart + Review checkout.
    expect(html).not.toMatch(/<button[^>]*>\s*Complete sale \(cash\)\s*<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>\s*Begin card payment\s*<\/button>/);
    expect(html).toContain('disabled');
  });
});

describe('TEST-CART-002 — start new sale', () => {
  it('the empty cart has no lines, customer, payment, or review', () => {
    expect(EMPTY_CART.lines).toHaveLength(0);
    expect(EMPTY_CART.customerId).toBeNull();
    expect(EMPTY_CART.paymentMethod).toBeNull();
    expect(EMPTY_CART.review).toBeNull();
  });
});

describe('TEST-CART-003 — add item', () => {
  it('adds a line at listed = sold = current selling price, quantity 1', () => {
    const state = addProduct(EMPTY_CART, makeProduct());
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({
      productId: 'p1',
      listedPriceCents: 59900,
      soldPriceCents: 59900,
      quantity: 1,
    });
    expect(cartPreview(state).subtotalCents).toBe(59900);
  });

  it('re-adding the same untouched product increments the existing line', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = addProduct(state, makeProduct());
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]?.quantity).toBe(2);
  });

  it('keeps a separate line once a line has a negotiated price', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setSoldPrice(state, state.lines[0]!.key, 55000);
    state = addProduct(state, makeProduct());
    expect(state.lines).toHaveLength(2);
  });
});

describe('TEST-CART-004 — remove item', () => {
  it('removes only the targeted line and recalculates the preview', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = addProduct(state, makeProduct({ id: 'p2', name: 'Pixel', sellingPriceCents: 40000 }));
    state = removeLine(state, state.lines[0]!.key);
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]?.productId).toBe('p2');
    expect(cartPreview(state).subtotalCents).toBe(40000);
  });
});

describe('TEST-CART-005 — quantity change and stock limit', () => {
  it('accepts quantity 3 and flags quantity 6 against a stock of 5 in the preview', () => {
    let state = addProduct(EMPTY_CART, makeProduct({ quantityOnHand: 5 }));
    state = setPaymentMethod(state, 'CASH');
    state = setQuantity(state, state.lines[0]!.key, 3);
    expect(previewValidationErrors(state)).toEqual([]);
    state = setQuantity(state, state.lines[0]!.key, 6);
    expect(previewValidationErrors(state).some((m) => /only 5 in stock/i.test(m))).toBe(true);
  });
});

describe('TEST-CART-006 — duplicate-product aggregation (preview)', () => {
  it('sums quantities per product ID for the stock check', () => {
    let state = addProduct(EMPTY_CART, makeProduct({ quantityOnHand: 2 }));
    state = setSoldPrice(state, state.lines[0]!.key, 55000);
    state = addProduct(state, makeProduct({ quantityOnHand: 2 }));
    state = setQuantity(state, state.lines[1]!.key, 2);
    expect(aggregateQuantityByProduct(state).get('p1')).toBe(3);
    expect(previewValidationErrors(state).some((m) => /3 requested across the cart/i.test(m))).toBe(
      true,
    );
  });
});

describe('TEST-CART-010 — negotiated price above listed (preview)', () => {
  it('shows zero discount for an above-list sold price', () => {
    let state = addProduct(EMPTY_CART, makeProduct({ sellingPriceCents: 59900 }));
    state = setSoldPrice(state, state.lines[0]!.key, 65000);
    expect(cartPreview(state).discountCents).toBe(0);
  });
});

describe('TEST-CART-001 (cart portion) — clear cart', () => {
  it('drops lines, customer, payment, and review with no persistence hook', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setCustomer(state, 'c1');
    state = setPaymentMethod(state, 'CASH');
    state = clearCart();
    expect(state).toBe(EMPTY_CART);
  });
});

describe('task §18 — review invalidation', () => {
  const review = { fingerprint: 'abc', totalCents: 1 } as unknown as CheckoutReview;

  it.each([
    ['quantity change', (s: ReturnType<typeof addProduct>) => setQuantity(s, s.lines[0]!.key, 2)],
    ['line removed', (s: ReturnType<typeof addProduct>) => removeLine(s, s.lines[0]!.key)],
    [
      'product added',
      (s: ReturnType<typeof addProduct>) => addProduct(s, makeProduct({ id: 'p9' })),
    ],
    [
      'sold price changed',
      (s: ReturnType<typeof addProduct>) => setSoldPrice(s, s.lines[0]!.key, 100),
    ],
    ['customer changed', (s: ReturnType<typeof addProduct>) => setCustomer(s, 'c2')],
    ['payment changed', (s: ReturnType<typeof addProduct>) => setPaymentMethod(s, 'CARD')],
  ])('%s clears a prior review', (_label, mutateFn) => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = withReview(state, review);
    expect(isReviewCurrent(state)).toBe(true);
    state = mutateFn(state);
    expect(isReviewCurrent(state)).toBe(false);
  });
});

describe('toReviewRequest', () => {
  it('sends only product id, quantity, and sold price per line', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CARD');
    state = setCustomer(state, 'c1');
    expect(toReviewRequest(state)).toEqual({
      customerId: 'c1',
      paymentMethod: 'CARD',
      lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 59900 }],
    });
  });

  it('refuses to build a request with no payment method', () => {
    const state = addProduct(EMPTY_CART, makeProduct());
    expect(() => toReviewRequest(state)).toThrow(/payment method/i);
  });
});
