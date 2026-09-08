import { describe, expect, it } from 'vitest';
import type { ReceiptItem, ReceiptRepresentation } from '../../src/shared/receipt';
import {
  formatReceiptDateTime,
  formatTaxRateBps,
  toReceiptView,
} from '../../src/renderer/src/features/checkout/receiptView';

/**
 * Phase 2E.1 — pure receipt presentation shaping (`REQ-REC-002`; task `§6`-`§9`).
 * No DOM; asserts strings only. Nothing here recalculates money.
 */

function item(overrides: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    productName: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sku: null,
    barcode: null,
    quantity: 1,
    listedPriceCents: 59900,
    soldPriceCents: 59900,
    discountCents: 0,
    lineSubtotalCents: 59900,
    lineTotalCents: 59900,
    ...overrides,
  };
}

function representation(overrides: Partial<ReceiptRepresentation> = {}): ReceiptRepresentation {
  return {
    saleId: 's1',
    receiptNumber: 'GP-000123',
    status: 'COMPLETED',
    completedAt: '2026-09-08T17:42:00.000Z',
    voidedAt: null,
    voidReason: null,
    businessTimezone: 'America/Chicago',
    business: { name: 'Go Phones - Alvin', address: '123 Main St', phone: '(281) 555-0100' },
    customer: null,
    items: [item()],
    totals: {
      subtotalCents: 59900,
      discountCents: 0,
      taxableAmountCents: 59900,
      taxRateBps: 825,
      taxCents: 4942,
      totalCents: 64842,
    },
    payment: { method: 'CASH', amountCents: 64842 },
    disclaimer: 'All sales final.',
    footer: 'Thank you!',
    ...overrides,
  };
}

describe('formatReceiptDateTime', () => {
  it('renders the UTC instant in the configured business timezone', () => {
    // 17:42 UTC on 2026-09-08 is 12:42 PM CDT (America/Chicago, DST).
    expect(formatReceiptDateTime('2026-09-08T17:42:00.000Z', 'America/Chicago')).toBe(
      'Sep 8, 2026, 12:42 PM',
    );
  });

  it('a different configured timezone shifts the displayed local time', () => {
    expect(formatReceiptDateTime('2026-09-08T17:42:00.000Z', 'UTC')).toBe('Sep 8, 2026, 5:42 PM');
  });

  it('falls back without throwing on a malformed timezone', () => {
    const out = formatReceiptDateTime('2026-09-08T17:42:00.000Z', 'Not/AZone');
    expect(out).toMatch(/UTC$/);
  });

  it('returns the raw string on an unparseable timestamp', () => {
    expect(formatReceiptDateTime('nonsense', 'America/Chicago')).toBe('nonsense');
  });
});

describe('formatTaxRateBps', () => {
  it('renders basis points as a percentage', () => {
    expect(formatTaxRateBps(825)).toBe('8.25%');
    expect(formatTaxRateBps(600)).toBe('6.00%');
  });
});

describe('toReceiptView', () => {
  it('maps the header, meta, totals, and payment from the representation', () => {
    const view = toReceiptView(representation());
    expect(view.title).toBe('Go Phones - Alvin');
    expect(view.businessLines).toEqual(['123 Main St', '(281) 555-0100']);
    expect(view.meta).toEqual([
      { label: 'Receipt', value: 'GP-000123' },
      { label: 'Date', value: 'Sep 8, 2026, 12:42 PM' },
    ]);
    expect(view.totalRows).toEqual([
      { label: 'Subtotal', value: '$599.00' },
      { label: 'Discount', value: '$0.00' },
      { label: 'Tax (8.25%)', value: '$49.42' },
      { label: 'Total', value: '$648.42', emphasis: true },
    ]);
    expect(view.paymentLabel).toBe('Cash');
  });

  it('omits the customer block for a customerless sale (no placeholder)', () => {
    expect(toReceiptView(representation({ customer: null })).customer).toBeNull();
  });

  it('carries a customer name + phone through', () => {
    const view = toReceiptView(
      representation({ customer: { name: 'Sam Buyer', phone: '555-1234' } }),
    );
    expect(view.customer).toEqual({ name: 'Sam Buyer', phone: '555-1234' });
  });

  it('a normal (non-negotiated) line shows the unit price and no list / discount note', () => {
    const view = toReceiptView(representation({ items: [item()] }));
    expect(view.items[0]).toMatchObject({
      line: 'Qty 1 × $599.00',
      amount: '$599.00',
      listNote: null,
      discountNote: null,
    });
  });

  it('a below-list negotiated line shows the list price and the discount', () => {
    const view = toReceiptView(
      representation({
        items: [
          item({
            soldPriceCents: 55000,
            discountCents: 4900,
            lineSubtotalCents: 59900,
            lineTotalCents: 55000,
          }),
        ],
      }),
    );
    expect(view.items[0]).toMatchObject({
      line: 'Qty 1 × $550.00',
      amount: '$550.00',
      listNote: 'List: $599.00',
      discountNote: 'Discount: $49.00',
    });
  });

  it('an above-list override shows the list price but no discount and never a negative value', () => {
    const view = toReceiptView(
      representation({
        items: [
          item({
            listedPriceCents: 50000,
            soldPriceCents: 52500,
            discountCents: 0,
            lineSubtotalCents: 50000,
            lineTotalCents: 52500,
          }),
        ],
      }),
    );
    expect(view.items[0]).toMatchObject({
      line: 'Qty 1 × $525.00',
      amount: '$525.00',
      listNote: 'List: $500.00',
      discountNote: null,
    });
    expect(JSON.stringify(view.items[0])).not.toMatch(/-\$/);
  });

  it('blank disclaimer and footer stay blank — no substitute text', () => {
    const view = toReceiptView(representation({ disclaimer: '', footer: '' }));
    expect(view.disclaimer).toBe('');
    expect(view.footer).toBe('');
  });
});
