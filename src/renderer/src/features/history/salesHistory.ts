import type { SaleExportStatus } from '../../../../shared/checkout';
import { formatCents } from '../../../../shared/money';
import type {
  SaleDetail,
  SalesHistoryEntry,
  SalesHistorySearch,
} from '../../../../shared/salesHistory';
import { SALES_HISTORY_QUERY_MAX_LENGTH } from '../../../../shared/salesHistory';
import { formatReceiptDateTime, formatTaxRateBps } from '../checkout/receiptView';

/**
 * Render an already-local `YYYY-MM-DD` business date as `"Sep 9, 2026"`. The
 * value is a calendar date, not an instant, so it is formatted in UTC to avoid
 * any second timezone shift. A malformed value is returned unchanged.
 */
export function formatBusinessDate(businessDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return businessDate;
  }
  const instant = new Date(`${businessDate}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) {
    return businessDate;
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(instant);
}

/**
 * Pure, React-free shaping + input helpers for the Sales History screen
 * (`POS_WORKFLOWS.md §50`-`§51`; `task §4`, `§6`, `§12`-`§16`, `§32`-`§33`,
 * `§36`, `§38`). No jsdom in the renderer suites, so the display strings and the
 * search-input gate are unit-tested here directly.
 *
 * Nothing here recalculates money or reconstructs historical content — every
 * value comes straight from the trusted `SalesHistoryEntry` / `SaleDetail`.
 * Date/time rendering reuses the receipt helper so history and receipts label
 * the same instant identically.
 */

/**
 * The durable local Google Sheets export state, shown honestly (`task §12`,
 * `REQ-HIST-004`): a persisted `EXPORTING` reads as "Exporting", never
 * "Exported". No network is consulted.
 */
export function describeExportStatus(status: SaleExportStatus | null): string {
  switch (status) {
    case 'PENDING':
      return 'Pending';
    case 'EXPORTING':
      return 'Exporting';
    case 'EXPORTED':
      return 'Exported';
    case 'FAILED':
      return 'Failed';
    case null:
      return 'Unknown';
  }
}

export function describePaymentMethod(method: 'CASH' | 'CARD'): string {
  return method === 'CASH' ? 'Cash' : 'Card';
}

export interface SalesHistoryRowView {
  readonly saleId: string;
  readonly receiptNumber: string;
  /** The sale's derived business date, e.g. `"Sep 9, 2026"` (`DATA_MODEL.md §4`). */
  readonly date: string;
  /** `"Jane Doe"` or `"No customer"` — never a fabricated "Walk-in" value (`task §8`). */
  readonly customerLabel: string;
  readonly total: string;
  readonly paymentLabel: string;
  readonly exportLabel: string;
  /** `"COMPLETED"` / `"VOIDED"` — a voided sale stays visible and is clearly marked (`task §16`). */
  readonly statusLabel: string;
  readonly voided: boolean;
}

export function toSalesHistoryRow(entry: SalesHistoryEntry): SalesHistoryRowView {
  return {
    saleId: entry.saleId,
    receiptNumber: entry.receiptNumber,
    date: formatBusinessDate(entry.businessDate),
    customerLabel: entry.customerName ?? 'No customer',
    total: formatCents(entry.totalCents),
    paymentLabel: describePaymentMethod(entry.paymentMethod),
    exportLabel: describeExportStatus(entry.exportStatus),
    statusLabel: entry.status,
    voided: entry.status === 'VOIDED',
  };
}

/**
 * The renderer-side pre-check before calling `sales-history:list`. The trusted
 * layer re-validates everything; this only spares the user an obvious round-trip.
 * A blank search is valid — it means "show everything".
 */
export function validateHistorySearchInput(input: {
  readonly query: string;
  readonly date: string;
}): string | null {
  if (input.query.trim().length > SALES_HISTORY_QUERY_MAX_LENGTH) {
    return `The search term must be ${SALES_HISTORY_QUERY_MAX_LENGTH} characters or fewer.`;
  }
  if (input.date.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.date.trim())) {
    return 'Enter a date as YYYY-MM-DD.';
  }
  return null;
}

/** Turn the two form fields into the narrow IPC search payload (omitting empties). */
export function toHistorySearch(input: {
  readonly query: string;
  readonly date: string;
}): SalesHistorySearch {
  const search: { query?: string; businessDate?: string } = {};
  if (input.query.trim() !== '') {
    search.query = input.query.trim();
  }
  if (input.date.trim() !== '') {
    search.businessDate = input.date.trim();
  }
  return search;
}

export interface SaleDetailLineView {
  readonly name: string;
  readonly detail: string;
  readonly quantity: string;
  readonly listed: string;
  readonly sold: string;
  readonly discount: string;
  readonly lineTotal: string;
}

export interface SaleDetailTotalRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface SaleDetailView {
  readonly receiptNumber: string;
  readonly saleId: string;
  readonly statusLabel: string;
  readonly voided: boolean;
  readonly completedAt: string;
  /** Present only for a `VOIDED` sale (`task §13`, `§16`). */
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly customer: { readonly name: string; readonly phone: string | null } | null;
  readonly items: readonly SaleDetailLineView[];
  readonly totalRows: readonly SaleDetailTotalRow[];
  readonly paymentLabel: string;
  readonly exportLabel: string;
}

function lineDetail(item: SaleDetail['items'][number]): string {
  const parts = [`${item.brand} ${item.model}`.trim(), item.condition];
  if (item.sku) {
    parts.push(`SKU ${item.sku}`);
  }
  if (item.barcode) {
    parts.push(`Barcode ${item.barcode}`);
  }
  return parts.filter((p) => p.length > 0).join(' · ');
}

export function toSaleDetailView(detail: SaleDetail): SaleDetailView {
  return {
    receiptNumber: detail.receiptNumber,
    saleId: detail.saleId,
    statusLabel: detail.status,
    voided: detail.status === 'VOIDED',
    completedAt: formatReceiptDateTime(detail.completedAt, detail.businessTimezone),
    voidedAt:
      detail.voidedAt === null
        ? null
        : formatReceiptDateTime(detail.voidedAt, detail.businessTimezone),
    voidReason: detail.voidReason,
    customer:
      detail.customerName === null
        ? null
        : { name: detail.customerName, phone: detail.customerPhone },
    items: detail.items.map((item) => ({
      name: item.productName,
      detail: lineDetail(item),
      quantity: String(item.quantity),
      listed: formatCents(item.listedPriceCents),
      sold: formatCents(item.soldPriceCents),
      discount: formatCents(item.discountCents),
      lineTotal: formatCents(item.lineTotalCents),
    })),
    totalRows: [
      { label: 'Subtotal', value: formatCents(detail.subtotalCents) },
      { label: 'Discount', value: formatCents(detail.discountCents) },
      { label: 'Taxable amount', value: formatCents(detail.taxableAmountCents) },
      {
        label: `Tax (${formatTaxRateBps(detail.taxRateBps)})`,
        value: formatCents(detail.taxCents),
      },
      { label: 'Total', value: formatCents(detail.totalCents), emphasis: true },
    ],
    paymentLabel: describePaymentMethod(detail.paymentMethod),
    exportLabel: describeExportStatus(detail.exportStatus),
  };
}
