import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SaleDetailView } from '../../src/renderer/src/features/history/SalesHistoryPage';
import { VoidSalePanel } from '../../src/renderer/src/features/history/VoidSalePanel';
import {
  CARD_VOID_CLOVER_WARNING,
  canSubmitVoid,
  cardVoidWarning,
  voidReasonError,
  voidTransactionContext,
} from '../../src/renderer/src/features/history/voidSale';
import type { SaleDetail } from '../../src/shared/salesHistory';
import { VOID_REASON_MAX_LENGTH } from '../../src/shared/salesHistory';

/**
 * Phase 2H renderer coverage — the Void Sale gate/warning helpers and the
 * confirmation panel's first-render markup (`REQ-VOID-002`, `REQ-VOID-008`;
 * `POS_WORKFLOWS.md §88`, `§90`; `task §10`, `§11`). No jsdom.
 */

function detail(overrides: Partial<SaleDetail> = {}): SaleDetail {
  return {
    saleId: 's1',
    receiptNumber: 'GP-000124',
    status: 'COMPLETED',
    completedAt: '2026-09-09T15:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    businessTimezone: 'America/Chicago',
    customerName: 'Jane Doe',
    customerPhone: '(281) 824-0001',
    items: [
      {
        productName: 'iPhone 15',
        brand: 'Apple',
        model: 'iPhone 15',
        condition: 'NEW',
        sku: null,
        barcode: null,
        quantity: 1,
        listedPriceCents: 59900,
        soldPriceCents: 55000,
        discountCents: 4900,
        lineSubtotalCents: 59900,
        lineTotalCents: 55000,
      },
    ],
    subtotalCents: 59900,
    discountCents: 4900,
    taxableAmountCents: 55000,
    taxRateBps: 825,
    taxCents: 4538,
    totalCents: 59538,
    paymentMethod: 'CASH',
    exportStatus: 'PENDING',
    ...overrides,
  };
}

const noop = () => {};

describe('voidReasonError', () => {
  it('requires a non-blank reason and bounds the length', () => {
    expect(voidReasonError('')).toMatch(/enter a reason/i);
    expect(voidReasonError('   ')).toMatch(/enter a reason/i);
    expect(voidReasonError('x'.repeat(VOID_REASON_MAX_LENGTH + 1))).toMatch(
      new RegExp(`${VOID_REASON_MAX_LENGTH} characters or fewer`),
    );
    expect(voidReasonError('  rang up twice  ')).toBeNull();
  });
});

describe('cardVoidWarning', () => {
  it('is the verbatim Clover warning for Card and null for Cash (no automated-refund implication)', () => {
    expect(cardVoidWarning('CARD')).toBe(CARD_VOID_CLOVER_WARNING);
    expect(cardVoidWarning('CARD')).toMatch(/does not refund or reverse the Clover payment/i);
    expect(cardVoidWarning('CASH')).toBeNull();
  });
});

describe('canSubmitVoid', () => {
  it('Cash: needs a valid reason and not submitting; acknowledgement is irrelevant', () => {
    expect(
      canSubmitVoid({
        reason: 'ok',
        paymentMethod: 'CASH',
        acknowledged: false,
        submitting: false,
      }),
    ).toBe(true);
    expect(
      canSubmitVoid({ reason: '  ', paymentMethod: 'CASH', acknowledged: true, submitting: false }),
    ).toBe(false);
    expect(
      canSubmitVoid({ reason: 'ok', paymentMethod: 'CASH', acknowledged: true, submitting: true }),
    ).toBe(false);
  });

  it('Card: additionally requires the explicit Clover acknowledgement', () => {
    expect(
      canSubmitVoid({
        reason: 'ok',
        paymentMethod: 'CARD',
        acknowledged: false,
        submitting: false,
      }),
    ).toBe(false);
    expect(
      canSubmitVoid({ reason: 'ok', paymentMethod: 'CARD', acknowledged: true, submitting: false }),
    ).toBe(true);
  });
});

describe('voidTransactionContext', () => {
  it('shows the immutable receipt / total / payment method from the committed detail', () => {
    expect(voidTransactionContext(detail())).toEqual([
      { label: 'Receipt', value: 'GP-000124' },
      { label: 'Total', value: '$595.38' },
      { label: 'Payment method', value: 'Cash' },
    ]);
  });
});

describe('<SaleDetailView /> — Void Sale action visibility (task §10)', () => {
  it('offers Void Sale alongside View Receipt for a COMPLETED sale', () => {
    const html = renderToStaticMarkup(
      <SaleDetailView
        detail={detail()}
        loading={false}
        error={null}
        onBack={noop}
        onViewReceipt={noop}
        onReprint={noop}
        onVoid={noop}
      />,
    );
    expect(html).toContain('View Receipt');
    expect(html).toContain('Void Sale');
  });

  it('a VOIDED sale shows the badge + void metadata and offers NO active Void Sale', () => {
    const html = renderToStaticMarkup(
      <SaleDetailView
        detail={detail({
          status: 'VOIDED',
          voidedAt: '2026-09-10T09:00:00.000Z',
          voidReason: 'Rang up in error',
        })}
        loading={false}
        error={null}
        onBack={noop}
        onViewReceipt={noop}
        onReprint={noop}
        onVoid={noop}
      />,
    );
    expect(html).toContain('VOIDED');
    expect(html).toContain('Rang up in error');
    expect(html).toContain('View Receipt');
    expect(html).not.toContain('Void Sale');
  });
});

describe('<VoidSalePanel /> first-render markup', () => {
  it('Cash: shows context + required reason, no Clover warning, no automated-refund text', () => {
    const html = renderToStaticMarkup(
      <VoidSalePanel
        detail={detail()}
        submitting={false}
        error={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('Void sale GP-000124');
    expect(html).toContain('$595.38');
    expect(html).toContain('Reason for voiding (required)');
    expect(html).toContain('Confirm void');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Clover');
    expect(html.toLowerCase()).not.toContain('refund');
    // Confirm disabled until a reason is entered.
    expect(html).toMatch(/Confirm void<\/button>/);
    expect(html).toContain('disabled');
  });

  it('Card: shows the verbatim Clover warning and an acknowledgement checkbox', () => {
    const html = renderToStaticMarkup(
      <VoidSalePanel
        detail={detail({ paymentMethod: 'CARD' })}
        submitting={false}
        error={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('does not refund or reverse the Clover payment');
    expect(html).toContain('Complete any required refund or reversal separately in Clover');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('I understand the Clover payment is not refunded');
    expect(html).toContain('role="alert"');
  });

  it('submitting state disables both buttons and shows progress', () => {
    const html = renderToStaticMarkup(
      <VoidSalePanel detail={detail()} submitting error={null} onCancel={noop} onConfirm={noop} />,
    );
    expect(html).toContain('Voiding sale…');
    expect(html).toContain('Voiding…');
  });

  it('renders a void error without claiming the sale changed', () => {
    const html = renderToStaticMarkup(
      <VoidSalePanel
        detail={detail()}
        submitting={false}
        error="This sale has already been voided. Its original void reason and timestamp are unchanged."
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('already been voided');
  });
});
