import type Database from 'better-sqlite3';
import type { PaymentMethod, SaleExportStatus } from '../../shared/checkout';
import type { ProductCondition } from '../../shared/products';
import type { SaleHistoryStatus } from '../../shared/salesHistory';

/**
 * Read-only SQL for the Sales History view model (`ARCHITECTURE.md §12`;
 * `DATA_MODEL.md §11`-`§16`, `§22`, `§37`, `§44-49`; `POS_WORKFLOWS.md §50`-`§51`).
 *
 * Every function here is a pure `SELECT` — it opens no transaction, writes
 * nothing, and reads ONLY `sales`, `sale_items`, `payments`, and
 * `google_sheet_export_jobs`. It never joins current `products`, `customers`, or
 * `settings` rows: a historical sale must render identically after those change
 * (`REQ-SALE-009`, `REQ-HIST-004`, `TEST-HIST-004`).
 *
 * There is deliberately no generic query capability — each function is a fixed,
 * business-named statement.
 */

export interface SalesHistoryListRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly completed_at: string;
  readonly customer_name_snapshot: string | null;
  readonly customer_phone_snapshot: string | null;
  readonly total_cents: number;
  readonly payment_method_snapshot: PaymentMethod;
  readonly status: SaleHistoryStatus;
  readonly voided_at: string | null;
  readonly export_status: SaleExportStatus | null;
}

/**
 * Every committed sale (`COMPLETED` and `VOIDED`), newest completed first with a
 * deterministic tie-break, joined to its single durable export job
 * (`google_sheet_export_jobs.sale_id UNIQUE`; `LEFT JOIN` so a sale still lists
 * if the job row is somehow missing). `task §7`: never rely on unspecified
 * SQLite row order — `completed_at DESC, receipt_number DESC`.
 *
 * V1 scale is a single fixed store, so history is read whole and the
 * receipt/customer/business-date filters are applied deterministically in the
 * trusted service layer (`task §10`, `§18`).
 */
export function listSalesForHistory(db: Database.Database): SalesHistoryListRow[] {
  return db
    .prepare(
      `SELECT s.id, s.receipt_number, s.completed_at,
              s.customer_name_snapshot, s.customer_phone_snapshot,
              s.total_cents, s.payment_method_snapshot, s.status, s.voided_at,
              j.status AS export_status
         FROM sales s
         LEFT JOIN google_sheet_export_jobs j ON j.sale_id = s.id
        ORDER BY s.completed_at DESC, s.receipt_number DESC`,
    )
    .all() as SalesHistoryListRow[];
}

export interface SaleHistoryRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly status: SaleHistoryStatus;
  readonly completed_at: string;
  readonly voided_at: string | null;
  readonly void_reason: string | null;
  readonly customer_name_snapshot: string | null;
  readonly customer_phone_snapshot: string | null;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly taxable_amount_cents: number;
  readonly tax_rate_bps: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly payment_method_snapshot: PaymentMethod;
  readonly export_status: SaleExportStatus | null;
}

export function findSaleForHistory(db: Database.Database, saleId: string): SaleHistoryRow | null {
  const row = db
    .prepare(
      `SELECT s.id, s.receipt_number, s.status, s.completed_at, s.voided_at, s.void_reason,
              s.customer_name_snapshot, s.customer_phone_snapshot,
              s.subtotal_cents, s.discount_cents, s.taxable_amount_cents,
              s.tax_rate_bps, s.tax_cents, s.total_cents, s.payment_method_snapshot,
              j.status AS export_status
         FROM sales s
         LEFT JOIN google_sheet_export_jobs j ON j.sale_id = s.id
        WHERE s.id = ?`,
    )
    .get(saleId) as SaleHistoryRow | undefined;
  return row ?? null;
}

export interface SaleHistoryItemRow {
  readonly product_name_snapshot: string;
  readonly brand_snapshot: string;
  readonly model_snapshot: string;
  readonly condition_snapshot: ProductCondition;
  readonly sku_snapshot: string | null;
  readonly barcode_snapshot: string | null;
  readonly quantity: number;
  readonly listed_price_cents: number;
  readonly sold_price_cents: number;
  readonly discount_cents: number;
  readonly line_subtotal_cents: number;
  readonly line_total_cents: number;
}

/**
 * The sale's lines in the same deterministic, restart-stable order the receipt
 * representation uses (`receiptRepository.readSaleItemsForReceipt`): the
 * canonical `DATA_MODEL.md §41B` line tuple with `id` as a final tiebreaker.
 */
export function listSaleItemsForHistory(
  db: Database.Database,
  saleId: string,
): SaleHistoryItemRow[] {
  return db
    .prepare(
      `SELECT product_name_snapshot, brand_snapshot, model_snapshot, condition_snapshot,
              sku_snapshot, barcode_snapshot, quantity,
              listed_price_cents, sold_price_cents, discount_cents,
              line_subtotal_cents, line_total_cents
         FROM sale_items
        WHERE sale_id = ?
        ORDER BY product_id, listed_price_cents, sold_price_cents, quantity, id`,
    )
    .all(saleId) as SaleHistoryItemRow[];
}
