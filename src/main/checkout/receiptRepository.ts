import type Database from 'better-sqlite3';
import type { PaymentMethod } from '../../shared/checkout';
import type { ProductCondition } from '../../shared/products';

/**
 * Read-only SQL for assembling one committed sale's receipt from its
 * transaction-time snapshots (`DATA_MODEL.md §11`-`§16`, `§44-49`;
 * `POS_WORKFLOWS.md §38`; `ARCHITECTURE.md §34`).
 *
 * Every function here is a pure `SELECT` — it opens no transaction, writes
 * nothing, and reads ONLY `sales` / `sale_items` / `payments`. It never touches
 * current `products`, `customers`, or `settings` rows: an old receipt must
 * render identically after those change (`REQ-REC-003`, `TEST-PRINT-005`).
 */

export interface SaleReceiptRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly status: 'COMPLETED' | 'VOIDED';
  readonly customer_name_snapshot: string | null;
  readonly customer_phone_snapshot: string | null;
  readonly business_name_snapshot: string;
  readonly business_address_snapshot: string;
  readonly business_phone_snapshot: string;
  readonly receipt_disclaimer_snapshot: string;
  readonly receipt_footer_snapshot: string;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly taxable_amount_cents: number;
  readonly tax_rate_bps: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly completed_at: string;
  readonly voided_at: string | null;
  readonly void_reason: string | null;
}

export function readSaleForReceipt(db: Database.Database, saleId: string): SaleReceiptRow | null {
  const row = db
    .prepare(
      `SELECT id, receipt_number, status,
              customer_name_snapshot, customer_phone_snapshot,
              business_name_snapshot, business_address_snapshot, business_phone_snapshot,
              receipt_disclaimer_snapshot, receipt_footer_snapshot,
              subtotal_cents, discount_cents, taxable_amount_cents,
              tax_rate_bps, tax_cents, total_cents,
              completed_at, voided_at, void_reason
         FROM sales
        WHERE id = ?`,
    )
    .get(saleId) as SaleReceiptRow | undefined;
  return row ?? null;
}

export interface SaleItemReceiptRow {
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
 * The sale's lines in a deterministic, restart-stable order: the canonical
 * `DATA_MODEL.md §41B` line tuple — the exact order Phase 2E validated,
 * fingerprinted, and inserted them in — with `id` as a final tiebreaker for
 * exact-duplicate lines. Canon does not require original cashier cart order for
 * a receipt; it requires only that the receipt render deterministically, and it
 * must never rely on an unordered `SELECT`.
 */
export function readSaleItemsForReceipt(
  db: Database.Database,
  saleId: string,
): SaleItemReceiptRow[] {
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
    .all(saleId) as SaleItemReceiptRow[];
}

export interface PaymentReceiptRow {
  readonly method: PaymentMethod;
  readonly amount_cents: number;
}

/** The sale's payment rows. V1 constrains this to exactly one (`payments.sale_id UNIQUE`). */
export function readPaymentsForReceipt(db: Database.Database, saleId: string): PaymentReceiptRow[] {
  return db
    .prepare(`SELECT method, amount_cents FROM payments WHERE sale_id = ?`)
    .all(saleId) as PaymentReceiptRow[];
}
