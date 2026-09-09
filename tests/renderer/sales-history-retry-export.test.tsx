import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SaleDetailView } from '../../src/renderer/src/features/history/SalesHistoryPage';
import type { SaleDetail } from '../../src/shared/salesHistory';

/**
 * Phase 2J — Sales History → "Retry Export" for a FAILED job (`REQ-GSHEET-012`;
 * `POS_WORKFLOWS.md §48`; `task §9`). No jsdom — static markup.
 */

const noop = () => {};

function detail(exportStatus: SaleDetail['exportStatus']): SaleDetail {
  return {
    saleId: 's1',
    receiptNumber: 'GP-000200',
    status: 'COMPLETED',
    completedAt: '2026-09-09T15:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    businessTimezone: 'America/Chicago',
    customerName: null,
    customerPhone: null,
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
        soldPriceCents: 59900,
        discountCents: 0,
        lineSubtotalCents: 59900,
        lineTotalCents: 59900,
      },
    ],
    subtotalCents: 59900,
    discountCents: 0,
    taxableAmountCents: 59900,
    taxRateBps: 825,
    taxCents: 4942,
    totalCents: 64842,
    paymentMethod: 'CASH',
    exportStatus,
  };
}

function render(d: SaleDetail, retryExportBusy = false, retryExportNotice: string | null = null) {
  return renderToStaticMarkup(
    <SaleDetailView
      detail={d}
      loading={false}
      error={null}
      onBack={noop}
      onViewReceipt={noop}
      onReprint={noop}
      onRetryExport={noop}
      retryExportBusy={retryExportBusy}
      retryExportNotice={retryExportNotice}
      onVoid={noop}
    />,
  );
}

describe('Retry Export action visibility', () => {
  it('is shown only when the export job is FAILED', () => {
    expect(render(detail('FAILED'))).toContain('Retry Export');
    for (const status of ['PENDING', 'EXPORTING', 'EXPORTED', null] as const) {
      expect(render(detail(status))).not.toContain('Retry Export');
    }
  });

  it('shows progress + a notice, without implying the sale changed', () => {
    const busy = render(detail('FAILED'), true);
    expect(busy).toContain('Re-queuing…');
    const done = render(
      detail('FAILED'),
      false,
      'Export re-queued. It will retry in the background.',
    );
    expect(done).toContain('Export re-queued');
    expect(done.toLowerCase()).not.toContain('sale changed');
  });
});
