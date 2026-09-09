import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  addProduct,
  canBeginCard,
  EMPTY_CART,
  setPaymentMethod,
  toCardCheckoutRequest,
  withReview,
} from '../../src/renderer/src/features/checkout/cart';
import {
  describeCardLocalFailure,
  describeCloverInstruction,
  IDLE_CARD_ATTEMPT,
  interpretBeginResult,
  isCardCheckoutLocked,
  isCardLocalCommitFailure,
} from '../../src/renderer/src/features/checkout/cardCheckout';
import { requiresReReview } from '../../src/renderer/src/features/checkout/checkoutCompletion';
import { CardPaymentPanel } from '../../src/renderer/src/features/checkout/CardPaymentPanel';
import type { CheckoutReview, CompletedSaleResult } from '../../src/shared/checkout';
import type { ProductRecord } from '../../src/shared/products';

/**
 * Phase 2F renderer coverage — the pure Card state-machine helpers and the
 * Clover-instruction / local-failure panel markup (`POS_WORKFLOWS.md §30`,
 * `§35A`; task Phase 2F `§39`). No jsdom (repo convention).
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

function cardReview(overrides: Partial<CheckoutReview> = {}): CheckoutReview {
  return {
    customerId: null,
    customer: null,
    paymentMethod: 'CARD',
    lines: [],
    subtotalCents: 59900,
    discountCents: 0,
    taxableAmountCents: 59900,
    taxRateBps: 825,
    taxCents: 4942,
    totalCents: 64842,
    fingerprint: 'b'.repeat(64),
    ...overrides,
  };
}

const sale: CompletedSaleResult = {
  saleId: 's1',
  receiptNumber: 'GP-000123',
  totalCents: 64842,
  paymentMethod: 'CARD',
  exportStatus: 'PENDING',
  alreadyCompleted: false,
};

describe('canBeginCard / toCardCheckoutRequest', () => {
  it('true only with a current CARD review + attempt id', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CARD');
    expect(canBeginCard(state)).toBe(false);
    state = withReview(state, cardReview());
    expect(canBeginCard(state)).toBe(true);
  });

  it('false for a CASH review', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CASH');
    state = withReview(state, cardReview({ paymentMethod: 'CASH' }));
    expect(canBeginCard(state)).toBe(false);
  });

  it('builds the request from the reviewed intent, fingerprint, and attempt id (never re-minted)', () => {
    let state = addProduct(EMPTY_CART, makeProduct());
    state = setPaymentMethod(state, 'CARD');
    state = withReview(state, cardReview());
    const request = toCardCheckoutRequest(state);
    expect(request.reviewedFingerprint).toBe('b'.repeat(64));
    expect(request.requestId).toBe(state.requestId);
    expect(request.checkout).toEqual({
      customerId: null,
      paymentMethod: 'CARD',
      lines: [{ productId: 'p1', quantity: 1, soldPriceCents: 59900 }],
    });
  });
});

describe('interpretBeginResult', () => {
  it('awaiting_clover → an awaiting attempt carrying the trusted amount', () => {
    const outcome = interpretBeginResult({
      requestId: 'r1',
      intendedTotalCents: 59538,
      stage: 'awaiting_clover',
      completed: null,
    });
    expect(outcome).toEqual({
      kind: 'awaiting',
      attempt: { phase: 'awaiting_clover', requestId: 'r1', intendedTotalCents: 59538 },
    });
  });

  it('approved → proceed straight to recording (Step B already committed)', () => {
    const outcome = interpretBeginResult({
      requestId: 'r1',
      intendedTotalCents: 59538,
      stage: 'approved',
      completed: null,
    });
    expect(outcome).toEqual({ kind: 'approved', requestId: 'r1', intendedTotalCents: 59538 });
  });

  it('completed → the existing sale', () => {
    const outcome = interpretBeginResult({
      requestId: 'r1',
      intendedTotalCents: 64842,
      stage: 'completed',
      completed: sale,
    });
    expect(outcome).toEqual({ kind: 'completed', result: sale });
  });
});

describe('lock + error classification', () => {
  it('every non-idle phase locks the cart', () => {
    expect(isCardCheckoutLocked(IDLE_CARD_ATTEMPT)).toBe(false);
    for (const attempt of [
      { phase: 'beginning' } as const,
      { phase: 'awaiting_clover', requestId: 'r', intendedTotalCents: 1 } as const,
      { phase: 'recording', requestId: 'r', intendedTotalCents: 1, retry: false } as const,
      { phase: 'declining', requestId: 'r', intendedTotalCents: 1 } as const,
      { phase: 'local_failure', requestId: 'r', intendedTotalCents: 1, message: 'x' } as const,
    ]) {
      expect(isCardCheckoutLocked(attempt)).toBe(true);
    }
  });

  it('only CARD_LOCAL_COMMIT_FAILURE is the possible-charge incident code', () => {
    expect(isCardLocalCommitFailure('CARD_LOCAL_COMMIT_FAILURE')).toBe(true);
    expect(isCardLocalCommitFailure('CHECKOUT_DRIFT')).toBe(false);
    expect(isCardLocalCommitFailure('SALE_COMMIT_FAILED')).toBe(false);
  });
});

describe('TEST-CARD-008 D — pre-Clover CHECKOUT_DRIFT from begin-card', () => {
  it('is a re-review case (clears review + request id, keeps the cart), not a reconciliation incident', () => {
    // CheckoutPage.onBeginCard maps a begin-card CHECKOUT_DRIFT through
    // requiresReReview → clearReview (drops review + requestId, keeps
    // lines/customer/payment) and leaves cardAttempt idle, so CardPaymentPanel
    // (the only place a Clover amount is shown) never renders.
    expect(requiresReReview('CHECKOUT_DRIFT')).toBe(true);
    expect(isCardLocalCommitFailure('CHECKOUT_DRIFT')).toBe(false);
  });

  it('the Clover instruction lives only in CardPaymentPanel, which renders nothing while idle', () => {
    const html = renderToStaticMarkup(
      <CardPaymentPanel
        attempt={IDLE_CARD_ATTEMPT}
        onApproved={() => {}}
        onDeclined={() => {}}
        onRetryLocalSave={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).toBe('');
    expect(html).not.toMatch(/process .* on clover/i);
  });
});

describe('describeCloverInstruction', () => {
  it('uses the actual intended total and offers exactly Approved / Declined', () => {
    const i = describeCloverInstruction(59538);
    expect(i.amountLine).toBe('Process $595.38 on Clover.');
    expect(i.approveLabel).toBe('Payment Approved');
    expect(i.declineLabel).toBe('Payment Declined / Cancel');
  });
});

describe('describeCardLocalFailure', () => {
  it('offers a local-only retry, never a "process card again"', () => {
    const v = describeCardLocalFailure('Local sale could not be saved.\n... CHK-1');
    expect(v.retryLabel.toLowerCase()).toContain('local');
    expect(v.retryLabel.toLowerCase()).not.toContain('process card');
    expect(v.body).toContain('CHK-1');
  });
});

describe('CardPaymentPanel markup', () => {
  it('beginning: no amount, no Approved/Declined button, tells the cashier not to use Clover yet', () => {
    const html = renderToStaticMarkup(
      <CardPaymentPanel
        attempt={{ phase: 'beginning' }}
        onApproved={() => {}}
        onDeclined={() => {}}
        onRetryLocalSave={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).not.toContain('Payment Approved');
    expect(html).toMatch(/do not process anything on clover yet/i);
  });

  it('awaiting_clover: shows the amount and the two Clover-result buttons only', () => {
    const html = renderToStaticMarkup(
      <CardPaymentPanel
        attempt={{ phase: 'awaiting_clover', requestId: 'r1', intendedTotalCents: 59538 }}
        onApproved={() => {}}
        onDeclined={() => {}}
        onRetryLocalSave={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).toContain('Process $595.38 on Clover.');
    expect(html).toContain('Payment Approved');
    expect(html).toContain('Payment Declined / Cancel');
    // No PCI-sensitive inputs.
    expect(html).not.toMatch(/card number|cvv|authorization code|terminal id/i);
    expect(html).not.toContain('<input');
  });

  it('local_failure: shows the verbatim warning + a local-save retry, not a re-charge', () => {
    const message =
      'Local sale could not be saved.\n\nIf you already saw "Approved" on Clover, that charge may still exist.\nDO NOT RUN THE CARD AGAIN.\n\nThis attempt was recorded for reconciliation: CHK-9';
    const html = renderToStaticMarkup(
      <CardPaymentPanel
        attempt={{ phase: 'local_failure', requestId: 'CHK-9', intendedTotalCents: 59538, message }}
        onApproved={() => {}}
        onDeclined={() => {}}
        onRetryLocalSave={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).toMatch(/DO NOT RUN THE CARD AGAIN/);
    expect(html).toContain('CHK-9');
    expect(html).toContain('Retry local save');
    expect(html).not.toMatch(/process (the )?card again/i);
  });

  it('idle renders nothing', () => {
    const html = renderToStaticMarkup(
      <CardPaymentPanel
        attempt={IDLE_CARD_ATTEMPT}
        onApproved={() => {}}
        onDeclined={() => {}}
        onRetryLocalSave={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).toBe('');
  });
});
