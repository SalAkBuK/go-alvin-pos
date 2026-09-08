import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckoutPage } from '../../src/renderer/src/features/checkout/CheckoutPage';
import {
  addProduct,
  canCompleteCash,
  clearReview,
  EMPTY_CART,
  removeLine,
  setPaymentMethod,
  setQuantity,
  toCompleteCashRequest,
  withReview,
} from '../../src/renderer/src/features/checkout/cart';
import {
  describeExportStatus,
  describeSaleSuccess,
  isRetryableCommitFailure,
  requiresReReview,
} from '../../src/renderer/src/features/checkout/checkoutCompletion';
import type { CheckoutReview, CompletedSaleResult } from '../../src/shared/checkout';
import type { ProductRecord } from '../../src/shared/products';

/**
 * Phase 2E renderer coverage — the Cash completion lifecycle helpers and the
 * request-id lifecycle in the pure cart reducer (`POS_WORKFLOWS.md §33`-`§37`;
 * `DATA_MODEL.md §32`; task `§5`, `§6`, `§25`). No jsdom (repo convention).
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

function cashReview(overrides: Partial<CheckoutReview> = {}): CheckoutReview {
  return {
    customerId: null,
    customer: null,
    paymentMethod: 'CASH',
    lines: [],
    subtotalCents: 59900,
    discountCents: 0,
    taxableAmountCents: 59900,
    taxRateBps: 825,
    taxCents: 4942,
    totalCents: 64842,
    fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

describe('request-id lifecycle in the cart reducer', () => {
  it('minted on review, stable across a re-render, cleared by any material change', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    expect(state.requestId).toBeNull();

    state = withReview(state, cashReview());
    const id = state.requestId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.review).not.toBeNull();

    // A material change clears both the review and its attempt id.
    state = setQuantity(state, state.lines[0]!.key, 2);
    expect(state.review).toBeNull();
    expect(state.requestId).toBeNull();
  });

  it('a fresh review after invalidation mints a NEW attempt id', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    state = withReview(state, cashReview());
    const first = state.requestId;
    state = removeLine(state, state.lines[0]!.key);
    state = addProduct(state, makeProduct());
    state = withReview(state, cashReview());
    expect(state.requestId).not.toBe(first);
  });

  it('clearReview drops the review + id but keeps the lines/customer/payment', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    state = withReview(state, cashReview());
    state = clearReview(state);
    expect(state.review).toBeNull();
    expect(state.requestId).toBeNull();
    expect(state.lines).toHaveLength(1);
    expect(state.paymentMethod).toBe('CASH');
  });
});

describe('canCompleteCash / toCompleteCashRequest', () => {
  it('true only with a current CASH review and an attempt id', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    expect(canCompleteCash(state)).toBe(false);
    state = withReview(state, cashReview());
    expect(canCompleteCash(state)).toBe(true);
  });

  it('false for a CARD review', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CARD');
    state = withReview(state, cashReview({ paymentMethod: 'CARD' }));
    expect(canCompleteCash(state)).toBe(false);
  });

  it('builds the request from the reviewed intent, the fingerprint, and the attempt id', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    state = withReview(state, cashReview());
    const request = toCompleteCashRequest(state);
    expect(request.reviewedFingerprint).toBe('a'.repeat(64));
    expect(request.requestId).toBe(state.requestId);
    expect(request.checkout).toEqual({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 59900 }],
    });
  });

  it('throws when there is no current review', () => {
    expect(() => toCompleteCashRequest(EMPTY_CART)).toThrow(/review/i);
  });
});

describe('error classification', () => {
  it.each([
    'CHECKOUT_DRIFT',
    'IDEMPOTENCY_CONFLICT',
    'INSUFFICIENT_STOCK',
    'PRODUCT_ARCHIVED',
    'TAX_RATE_NOT_CONFIGURED',
    'CHECKOUT_REQUEST_INVALID',
  ] as const)('%s requires re-review', (code) => {
    expect(requiresReReview(code)).toBe(true);
    expect(isRetryableCommitFailure(code)).toBe(false);
  });

  it('SALE_COMMIT_FAILED is a retryable commit failure, not a re-review', () => {
    expect(isRetryableCommitFailure('SALE_COMMIT_FAILED')).toBe(true);
    expect(requiresReReview('SALE_COMMIT_FAILED')).toBe(false);
  });

  it('BUSINESS_NOT_CONFIGURED is neither (its own message points to Settings)', () => {
    expect(requiresReReview('BUSINESS_NOT_CONFIGURED')).toBe(false);
    expect(isRetryableCommitFailure('BUSINESS_NOT_CONFIGURED')).toBe(false);
  });
});

describe('describeSaleSuccess / describeExportStatus', () => {
  const base: CompletedSaleResult = {
    saleId: 's1',
    receiptNumber: 'GP-000123',
    totalCents: 64842,
    paymentMethod: 'CASH',
    exportStatus: 'PENDING',
    alreadyCompleted: false,
  };

  it('formats the success screen with receipt, total, payment, and export status', () => {
    const success = describeSaleSuccess(base);
    expect(success.heading).toBe('SALE COMPLETE');
    expect(success.lines).toEqual([
      { label: 'Receipt', value: 'GP-000123' },
      { label: 'Total', value: '$648.42' },
      { label: 'Payment', value: 'Cash' },
      { label: 'Google Sheets', value: 'Pending' },
    ]);
  });

  it('marks an idempotent replay distinctly', () => {
    expect(describeSaleSuccess({ ...base, alreadyCompleted: true }).heading).toBe(
      'SALE ALREADY COMPLETED',
    );
  });

  it.each([
    ['PENDING', 'Pending'],
    ['EXPORTING', 'Pending'],
    ['EXPORTED', 'Sent'],
    ['FAILED', 'Failed — will retry'],
  ] as const)('describeExportStatus(%s) = %s', (status, text) => {
    expect(describeExportStatus(status)).toBe(text);
  });
});

describe('CheckoutPage static markup', () => {
  it('renders the empty checkout with no enabled Cash completion control', () => {
    const html = renderToStaticMarkup(<CheckoutPage />);
    expect(html).toContain('Review checkout');
    expect(html).toContain('Clear cart');
    // Card fallback button is present but disabled; there is no bare Cash button.
    expect(html).toContain('not available yet');
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/>\s*Complete sale \(cash\)\s*</);
  });
});
