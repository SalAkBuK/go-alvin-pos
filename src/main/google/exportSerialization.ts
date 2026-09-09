import { deriveBusinessDate } from '../salesHistory/businessDate';
import type { SaleExportRow, SaleItemExportRow } from './exportJobRepository';

/**
 * Turns committed SQLite snapshots into Google Sheets cell rows
 * (`DATA_MODEL.md §26`; `PRODUCT_SCOPE.md §22.4`-`§22.5`; `task §16`-`§19`).
 *
 * Column order is fixed here (we own the one-way layout — `task §18`). Every
 * outgoing cell passes through {@link neutralizeCell} so a value beginning
 * `= + - @` is rendered as literal text and can never execute as a formula
 * (`REQ-GSHEET-014`); the writes also use `valueInputOption=RAW` (transport).
 * No exported numeric column is ever negative (every money / quantity CHECK is
 * `>= 0`), so neutralization is a no-op for our formatted numbers and dates.
 */

/** `DATA_MODEL.md §26` Sales worksheet columns, in order (A..Q). */
export const SALES_HEADER: readonly string[] = [
  'Sale ID',
  'Receipt Number',
  'Date',
  'Time',
  'Customer Name',
  'Customer Phone',
  'Subtotal',
  'Discount',
  'Tax Rate',
  'Tax',
  'Total',
  'Payment Method',
  'Status',
  'Sync Version',
  'Voided At',
  'Void Reason',
  'Exported At',
];

/** `DATA_MODEL.md §26` Sale Items worksheet columns, in order (A..O). */
export const SALE_ITEMS_HEADER: readonly string[] = [
  'Sale Item ID',
  'Sale ID',
  'Receipt Number',
  'Product ID',
  'Product Name',
  'Brand',
  'Model',
  'Condition',
  'SKU',
  'Barcode',
  'Quantity',
  'Listed Price',
  'Sold Price',
  'Discount',
  'Line Total',
];

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@']);

/** Prefix an apostrophe when the cell begins with a spreadsheet formula trigger. */
export function neutralizeCell(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGERS.has(value[0]!)) {
    return `'${value}`;
  }
  return value;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function taxRate(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function paymentMethod(method: 'CASH' | 'CARD'): string {
  return method === 'CASH' ? 'Cash' : 'Card';
}

function timeInZone(isoUtc: string, timeZone: string): string {
  const instant = new Date(isoUtc);
  if (Number.isNaN(instant.getTime())) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(instant);
  }
}

/** Build the one Sales worksheet row for a sale at `writtenVersion`. */
export function buildSalesRow(
  sale: SaleExportRow,
  businessTimezone: string,
  exportedAtIso: string,
): string[] {
  const row = [
    sale.sale_id,
    sale.receipt_number,
    deriveBusinessDate(sale.completed_at, businessTimezone),
    timeInZone(sale.completed_at, businessTimezone),
    sale.customer_name_snapshot ?? '',
    sale.customer_phone_snapshot ?? '',
    money(sale.subtotal_cents),
    money(sale.discount_cents),
    taxRate(sale.tax_rate_bps),
    money(sale.tax_cents),
    money(sale.total_cents),
    paymentMethod(sale.payment_method_snapshot),
    sale.status,
    String(sale.sync_version),
    sale.voided_at ?? '',
    sale.void_reason ?? '',
    exportedAtIso,
  ];
  return row.map(neutralizeCell);
}

/** Build the Sale Items worksheet rows for a sale (immutable — a void does not change them). */
export function buildSaleItemRows(
  sale: SaleExportRow,
  items: readonly SaleItemExportRow[],
): string[][] {
  return items.map((item) =>
    [
      item.id,
      sale.sale_id,
      sale.receipt_number,
      item.product_id,
      item.product_name_snapshot,
      item.brand_snapshot,
      item.model_snapshot,
      item.condition_snapshot,
      item.sku_snapshot ?? '',
      item.barcode_snapshot ?? '',
      String(item.quantity),
      money(item.listed_price_cents),
      money(item.sold_price_cents),
      money(item.discount_cents),
      money(item.line_total_cents),
    ].map(neutralizeCell),
  );
}
