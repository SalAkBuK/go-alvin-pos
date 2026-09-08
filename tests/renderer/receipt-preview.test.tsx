import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReceiptPreview } from '../../src/renderer/src/features/checkout/ReceiptPreview';
import { SaleSuccess } from '../../src/renderer/src/features/checkout/SaleSuccess';
import type { CompletedSaleResult } from '../../src/shared/checkout';
import type { ReceiptRepresentation } from '../../src/shared/receipt';

/**
 * Phase 2E.1 renderer coverage — the success screen's `View receipt` action and
 * the receipt preview surface (`POS_WORKFLOWS.md §37`-`§38`; task `§13`-`§14`,
 * `§22`). No jsdom (repo convention): assertions are over static markup.
 */

const noop = () => {};

const saleResult: CompletedSaleResult = {
  saleId: 's1',
  receiptNumber: 'GP-000123',
  totalCents: 64842,
  paymentMethod: 'CASH',
  exportStatus: 'PENDING',
  alreadyCompleted: false,
};

function representation(overrides: Partial<ReceiptRepresentation> = {}): ReceiptRepresentation {
  return {
    saleId: 's1',
    receiptNumber: 'GP-000123',
    status: 'COMPLETED',
    completedAt: '2026-09-08T17:42:00.000Z',
    voidedAt: null,
    voidReason: null,
    businessTimezone: 'America/Chicago',
    business: {
      name: 'Go Phones - Alvin',
      address: '123 Main St, Alvin, TX 77511',
      phone: '(281) 555-0100',
    },
    customer: { name: 'Sam Buyer', phone: '(555) 123-4567' },
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
    totals: {
      subtotalCents: 59900,
      discountCents: 4900,
      taxableAmountCents: 55000,
      taxRateBps: 825,
      taxCents: 4538,
      totalCents: 59538,
    },
    payment: { method: 'CASH', amountCents: 59538 },
    disclaimer: 'All sales final.',
    footer: 'Thank you for shopping with Go Phones!',
    ...overrides,
  };
}

describe('SaleSuccess', () => {
  it('offers an enabled View receipt action and a disabled Print receipt', () => {
    const html = renderToStaticMarkup(
      <SaleSuccess result={saleResult} onViewReceipt={noop} onNewSale={noop} />,
    );
    expect(html).toContain('View receipt');
    expect(html).toContain('New Sale');
    expect(html).toContain('Print receipt (not available yet)');
    expect(html).toContain('disabled');
    // Receipt/total still visible from the Phase 2E success summary.
    expect(html).toContain('GP-000123');
  });
});

describe('ReceiptPreview — loaded representation', () => {
  const html = renderToStaticMarkup(
    <ReceiptPreview
      representation={representation()}
      loading={false}
      error={null}
      saleReceiptNumber="GP-000123"
      onBack={noop}
      onNewSale={noop}
    />,
  );

  it('renders the business header from the snapshot', () => {
    expect(html).toContain('Go Phones - Alvin');
    expect(html).toContain('123 Main St, Alvin, TX 77511');
    expect(html).toContain('(281) 555-0100');
  });

  it('renders receipt number and a local date/time', () => {
    expect(html).toContain('GP-000123');
    expect(html).toContain('Sep 8, 2026, 12:42 PM');
  });

  it('renders the customer block when present', () => {
    expect(html).toContain('Customer');
    expect(html).toContain('Sam Buyer');
    expect(html).toContain('(555) 123-4567');
  });

  it('renders the negotiated item with list price and discount notes', () => {
    expect(html).toContain('iPhone 15');
    expect(html).toContain('Qty 1 × $550.00');
    expect(html).toContain('List: $599.00');
    expect(html).toContain('Discount: $49.00');
  });

  it('renders the totals block and payment method', () => {
    expect(html).toContain('Subtotal');
    expect(html).toContain('$599.00');
    expect(html).toContain('Tax (8.25%)');
    expect(html).toContain('$45.38');
    expect(html).toContain('$595.38');
    expect(html).toContain('Payment: Cash');
  });

  it('renders the disclaimer and footer snapshots', () => {
    expect(html).toContain('All sales final.');
    expect(html).toContain('Thank you for shopping with Go Phones!');
  });

  it('keeps Print receipt unavailable and offers Back / New Sale', () => {
    expect(html).toContain('Print receipt (not available yet)');
    expect(html).toContain('Back');
    expect(html).toContain('New Sale');
  });
});

describe('ReceiptPreview — edge states', () => {
  it('a customerless representation omits the customer block', () => {
    const html = renderToStaticMarkup(
      <ReceiptPreview
        representation={representation({ customer: null })}
        loading={false}
        error={null}
        saleReceiptNumber="GP-000123"
        onBack={noop}
        onNewSale={noop}
      />,
    );
    expect(html).not.toContain('>Customer<');
  });

  it('blank disclaimer / footer render nothing extra', () => {
    const html = renderToStaticMarkup(
      <ReceiptPreview
        representation={representation({ disclaimer: '', footer: '' })}
        loading={false}
        error={null}
        saleReceiptNumber="GP-000123"
        onBack={noop}
        onNewSale={noop}
      />,
    );
    expect(html).not.toContain('receipt-disclaimer');
    expect(html).not.toContain('receipt-footer');
  });

  it('a loading state shows a receipt-loading message', () => {
    const html = renderToStaticMarkup(
      <ReceiptPreview
        representation={null}
        loading
        error={null}
        saleReceiptNumber="GP-000123"
        onBack={noop}
        onNewSale={noop}
      />,
    );
    expect(html).toContain('Loading receipt');
  });

  it('a load failure still states the sale succeeded and never says the sale failed', () => {
    const html = renderToStaticMarkup(
      <ReceiptPreview
        representation={null}
        loading={false}
        error="That sale could not be found."
        saleReceiptNumber="GP-000123"
        onBack={noop}
        onNewSale={noop}
      />,
    );
    expect(html).toContain('Sale completed successfully.');
    expect(html).toContain('Receipt GP-000123 is saved.');
    expect(html).toContain('The receipt preview could not be loaded.');
    expect(html).toContain('That sale could not be found.');
    expect(html.toLowerCase()).not.toContain('sale failed');
    expect(html).toContain('Back');
    expect(html).toContain('New Sale');
  });
});
