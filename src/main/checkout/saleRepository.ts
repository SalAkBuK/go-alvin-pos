import type Database from 'better-sqlite3';
import type { PaymentMethod, SaleExportStatus } from '../../shared/checkout';

/**
 * SQL for the authoritative sale transaction — `sales`, `sale_items`,
 * `payments`, the sale's Google Sheets export job, and the transactional
 * receipt-number counter (`ARCHITECTURE.md §12`, `DATA_MODEL.md §11`-`§16`,
 * `§22`, `§28`-`§30`, `§44-49`).
 *
 * Every function takes the connection it should use and opens NO transaction of
 * its own, so they compose inside the sale service's one `BEGIN IMMEDIATE`
 * (`DATA_MODEL.md §31`, `REQ-INV-003`, `REQ-GSHEET-002`). SALE inventory
 * movements reuse `inventoryRepository.insertMovement`.
 */

const RECEIPT_PREFIX = 'GP-';
const RECEIPT_DIGITS = 6;

/** Format a raw counter value as the canonical `GP-000001` receipt number (`DATA_MODEL.md §28`). */
export function formatReceiptNumber(value: number): string {
  return `${RECEIPT_PREFIX}${String(value).padStart(RECEIPT_DIGITS, '0')}`;
}

/**
 * Read-increment-within-transaction allocation, identical in shape to the
 * `audit_sequence` allocation (`DATA_MODEL.md §29`-`§30`). If the surrounding
 * transaction rolls back, the increment rolls back with it and the number may be
 * used by a later successful sale; a committed number is never reused.
 */
export function allocateReceiptNumber(
  db: Database.Database,
  updatedAt: string,
): { readonly value: number; readonly receiptNumber: string } {
  const counter = db.prepare("SELECT value FROM counters WHERE key = 'receipt_number'").get() as
    { value: number } | undefined;
  if (!counter) {
    throw new Error('receipt_number counter row is missing');
  }
  const value = counter.value + 1;
  db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'receipt_number'").run(
    value,
    updatedAt,
  );
  return { value, receiptNumber: formatReceiptNumber(value) };
}

export interface InsertSaleRow {
  readonly id: string;
  readonly receiptNumber: string;
  readonly customerId: string | null;
  readonly customerNameSnapshot: string | null;
  readonly customerPhoneSnapshot: string | null;
  readonly businessNameSnapshot: string;
  readonly businessAddressSnapshot: string;
  readonly businessPhoneSnapshot: string;
  readonly receiptDisclaimerSnapshot: string;
  readonly receiptFooterSnapshot: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly taxRateBps: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paymentMethodSnapshot: PaymentMethod;
  /** When checkout began — the Phase 1 `checkout_requests.created_at` (`DATA_MODEL.md §4`). */
  readonly createdAt: string;
  /** Authoritative completion instant — the Phase 2 commit time (`DATA_MODEL.md §4`). */
  readonly completedAt: string;
}

export function insertSale(db: Database.Database, row: InsertSaleRow): void {
  db.prepare(
    `INSERT INTO sales
       (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
        business_name_snapshot, business_address_snapshot, business_phone_snapshot,
        receipt_disclaimer_snapshot, receipt_footer_snapshot,
        status, sync_version, subtotal_cents, discount_cents, taxable_amount_cents,
        tax_rate_bps, tax_cents, total_cents, payment_method_snapshot,
        created_at, completed_at, voided_at, void_reason)
     VALUES
       (@id, @receiptNumber, @customerId, @customerNameSnapshot, @customerPhoneSnapshot,
        @businessNameSnapshot, @businessAddressSnapshot, @businessPhoneSnapshot,
        @receiptDisclaimerSnapshot, @receiptFooterSnapshot,
        'COMPLETED', 1, @subtotalCents, @discountCents, @taxableAmountCents,
        @taxRateBps, @taxCents, @totalCents, @paymentMethodSnapshot,
        @createdAt, @completedAt, NULL, NULL)`,
  ).run(row);
}

export interface InsertSaleItemRow {
  readonly id: string;
  readonly saleId: string;
  readonly productId: string;
  readonly productNameSnapshot: string;
  readonly brandSnapshot: string;
  readonly modelSnapshot: string;
  readonly conditionSnapshot: string;
  readonly skuSnapshot: string | null;
  readonly barcodeSnapshot: string | null;
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly discountCents: number;
  readonly quantity: number;
  readonly lineSubtotalCents: number;
  readonly lineTotalCents: number;
  readonly createdAt: string;
}

export function insertSaleItem(db: Database.Database, row: InsertSaleItemRow): void {
  db.prepare(
    `INSERT INTO sale_items
       (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
        condition_snapshot, sku_snapshot, barcode_snapshot, listed_price_cents, sold_price_cents,
        discount_cents, quantity, line_subtotal_cents, line_total_cents, created_at)
     VALUES
       (@id, @saleId, @productId, @productNameSnapshot, @brandSnapshot, @modelSnapshot,
        @conditionSnapshot, @skuSnapshot, @barcodeSnapshot, @listedPriceCents, @soldPriceCents,
        @discountCents, @quantity, @lineSubtotalCents, @lineTotalCents, @createdAt)`,
  ).run(row);
}

export interface InsertPaymentRow {
  readonly id: string;
  readonly saleId: string;
  readonly method: PaymentMethod;
  readonly amountCents: number;
  readonly createdAt: string;
}

/** Exactly one `COMPLETED` payment per sale (`DATA_MODEL.md §15-16`). */
export function insertPayment(db: Database.Database, row: InsertPaymentRow): void {
  db.prepare(
    `INSERT INTO payments (id, sale_id, method, amount_cents, status, created_at)
     VALUES (@id, @saleId, @method, @amountCents, 'COMPLETED', @createdAt)`,
  ).run(row);
}

export interface InsertExportJobRow {
  readonly id: string;
  readonly saleId: string;
  readonly createdAt: string;
}

/**
 * The sale's single durable Google Sheets export job, created inside the sale
 * transaction regardless of whether synchronization is enabled or configured
 * (`DATA_MODEL.md §22-23`, `REQ-GSHEET-001/002`). `next_attempt_at` is set to
 * the creation time so a future worker treats it as immediately eligible; every
 * other lifecycle field is its initial value. No network request is made here.
 */
export function insertExportJob(db: Database.Database, row: InsertExportJobRow): void {
  db.prepare(
    `INSERT INTO google_sheet_export_jobs
       (id, sale_id, status, target_sync_version, exported_sync_version, attempt_count,
        next_attempt_at, last_attempt_at, exported_at, last_error, created_at, updated_at)
     VALUES
       (@id, @saleId, 'PENDING', 1, NULL, 0,
        @createdAt, NULL, NULL, NULL, @createdAt, @createdAt)`,
  ).run(row);
}

export interface CompletedSaleSummaryRow {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly totalCents: number;
  readonly paymentMethod: PaymentMethod;
  readonly exportStatus: SaleExportStatus;
}

/** Read back what the success screen needs after commit (`POS_WORKFLOWS.md §37`). */
export function readCompletedSaleSummary(
  db: Database.Database,
  saleId: string,
): CompletedSaleSummaryRow | null {
  const row = db
    .prepare(
      `SELECT s.id AS saleId, s.receipt_number AS receiptNumber, s.total_cents AS totalCents,
              s.payment_method_snapshot AS paymentMethod, j.status AS exportStatus
         FROM sales s
         JOIN google_sheet_export_jobs j ON j.sale_id = s.id
        WHERE s.id = ?`,
    )
    .get(saleId) as CompletedSaleSummaryRow | undefined;
  return row ?? null;
}
