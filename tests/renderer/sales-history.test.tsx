import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { SalesHistoryPage } from '../../src/renderer/src/features/history/SalesHistoryPage';
import {
  describeExportStatus,
  formatBusinessDate,
  toHistorySearch,
  toSaleDetailView,
  toSalesHistoryRow,
  validateHistorySearchInput,
} from '../../src/renderer/src/features/history/salesHistory';
import type { SaleDetail, SalesHistoryEntry } from '../../src/shared/salesHistory';

/**
 * Phase 2G renderer coverage — Sales History shaping + input helpers and
 * first-render markup (`task §4`, `§12`-`§16`, `§32`-`§33`, `§36`). No jsdom:
 * assertions are over pure functions and static markup.
 */

const entry: SalesHistoryEntry = {
  saleId: 's1',
  receiptNumber: 'GP-000124',
  completedAt: '2026-09-09T15:00:00.000Z',
  businessDate: '2026-09-09',
  customerName: 'Jane Doe',
  totalCents: 59538,
  paymentMethod: 'CARD',
  status: 'COMPLETED',
  voidedAt: null,
  exportStatus: 'PENDING',
};

const detail: SaleDetail = {
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
      sku: 'SKU-1',
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
  paymentMethod: 'CARD',
  exportStatus: 'EXPORTING',
};

describe('describeExportStatus — honest local state (task §12)', () => {
  it('shows the actual persisted state, never faking EXPORTING as EXPORTED', () => {
    expect(describeExportStatus('PENDING')).toBe('Pending');
    expect(describeExportStatus('EXPORTING')).toBe('Exporting');
    expect(describeExportStatus('EXPORTED')).toBe('Exported');
    expect(describeExportStatus('FAILED')).toBe('Failed');
    expect(describeExportStatus(null)).toBe('Unknown');
  });
});

describe('toSalesHistoryRow', () => {
  it('shapes a list row from the entry, with "No customer" for a customerless sale', () => {
    expect(toSalesHistoryRow(entry)).toEqual({
      saleId: 's1',
      receiptNumber: 'GP-000124',
      date: 'Sep 9, 2026',
      customerLabel: 'Jane Doe',
      total: '$595.38',
      paymentLabel: 'Card',
      exportLabel: 'Pending',
      statusLabel: 'COMPLETED',
      voided: false,
    });
    expect(toSalesHistoryRow({ ...entry, customerName: null }).customerLabel).toBe('No customer');
  });

  it('flags a VOIDED sale', () => {
    const row = toSalesHistoryRow({
      ...entry,
      status: 'VOIDED',
      voidedAt: '2026-09-10T09:00:00.000Z',
    });
    expect(row.statusLabel).toBe('VOIDED');
    expect(row.voided).toBe(true);
  });
});

describe('formatBusinessDate', () => {
  it('formats a local calendar date without a second timezone shift', () => {
    expect(formatBusinessDate('2026-09-09')).toBe('Sep 9, 2026');
    expect(formatBusinessDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatBusinessDate('garbage')).toBe('garbage');
  });
});

describe('validateHistorySearchInput / toHistorySearch', () => {
  it('a blank search is valid and produces an empty filter payload', () => {
    expect(validateHistorySearchInput({ query: '', date: '' })).toBeNull();
    expect(toHistorySearch({ query: '', date: '' })).toEqual({});
  });
  it('rejects an over-long query and a malformed date', () => {
    expect(validateHistorySearchInput({ query: 'x'.repeat(121), date: '' })).toMatch(
      /120 characters or fewer/i,
    );
    expect(validateHistorySearchInput({ query: '', date: '9/9/2026' })).toMatch(/YYYY-MM-DD/);
  });
  it('builds the narrow IPC payload from the two fields', () => {
    expect(toHistorySearch({ query: '  Jane  ', date: '2026-09-09' })).toEqual({
      query: 'Jane',
      businessDate: '2026-09-09',
    });
  });
});

describe('toSaleDetailView', () => {
  it('shapes every canonical detail field from the snapshot, honest export label', () => {
    const view = toSaleDetailView(detail);
    expect(view.receiptNumber).toBe('GP-000124');
    expect(view.saleId).toBe('s1');
    expect(view.completedAt).toBe('Sep 9, 2026, 10:00 AM');
    expect(view.customer).toEqual({ name: 'Jane Doe', phone: '(281) 824-0001' });
    expect(view.items[0]).toMatchObject({
      name: 'iPhone 15',
      quantity: '1',
      listed: '$599.00',
      sold: '$550.00',
      discount: '$49.00',
      lineTotal: '$550.00',
    });
    expect(view.items[0]?.detail).toContain('SKU SKU-1');
    expect(view.totalRows.map((r) => r.label)).toEqual([
      'Subtotal',
      'Discount',
      'Taxable amount',
      'Tax (8.25%)',
      'Total',
    ]);
    expect(view.paymentLabel).toBe('Card');
    expect(view.exportLabel).toBe('Exporting');
    expect(view.voided).toBe(false);
    expect(view.voidedAt).toBeNull();
  });

  it('a VOIDED sale exposes the void timestamp and reason; a customerless sale has a null customer', () => {
    const view = toSaleDetailView({
      ...detail,
      status: 'VOIDED',
      voidedAt: '2026-09-10T09:00:00.000Z',
      voidReason: 'Rang up in error',
      customerName: null,
      customerPhone: null,
    });
    expect(view.voided).toBe(true);
    expect(view.voidedAt).toBe('Sep 10, 2026, 4:00 AM');
    expect(view.voidReason).toBe('Rang up in error');
    expect(view.customer).toBeNull();
  });
});

describe('first-render markup', () => {
  it('the page renders the search controls and a loading state with no noisy error', () => {
    const html = renderToStaticMarkup(<SalesHistoryPage />);
    expect(html).toContain('Search receipt or customer');
    expect(html).toContain('Clear filters');
    expect(html).toContain('Loading sales…');
    expect(html).not.toContain('role="alert"');
  });

  it('the App shell exposes a Sales History destination', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Sales History');
  });
});
