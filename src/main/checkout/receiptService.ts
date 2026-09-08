import type Database from 'better-sqlite3';
import type { ReceiptItem, ReceiptRepresentation } from '../../shared/receipt';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { appErrors } from '../shared/appError';
import {
  readPaymentsForReceipt,
  readSaleForReceipt,
  readSaleItemsForReceipt,
} from './receiptRepository';

/**
 * Assembles a printer-independent {@link ReceiptRepresentation} for one
 * committed sale (`ARCHITECTURE.md §18`, `§34`; `DATA_MODEL.md §38`, `§44-49`;
 * `REQ-REC-001`-`REQ-REC-003`; `POS_WORKFLOWS.md §38`).
 *
 * Pure read. It:
 *
 *  - loads `sales`, `sale_items`, and `payments` for the Sale ID only;
 *  - uses ONLY transaction-time snapshot columns for historical content — it
 *    never consults current `products`, `customers`, or business/tax settings
 *    as a substitute (`REQ-REC-003`, `TEST-PRINT-005`);
 *  - reads exactly one live value, `business_timezone`, purely to label the
 *    immutable `completed_at` instant in local time (`DATA_MODEL.md §4`);
 *  - writes nothing and emits no audit event — viewing a receipt is not an
 *    authoritative business event (`DATA_MODEL.md §36A`).
 *
 * Local SQLite only: no network, no Google Sheets, no printer API is touched
 * (`REQ-OFF-007`, receipt-generation portion).
 *
 * Printing, reprint-from-history, and Sales History are explicitly NOT here.
 */

export interface ReceiptServiceDeps {
  readonly db: Database.Database;
}

export interface ReceiptService {
  getBySaleId(rawSaleId: unknown): ReceiptRepresentation;
}

function validateSaleId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('A sale must be selected to view its receipt.');
  }
  return raw.trim();
}

export function createReceiptService(deps: ReceiptServiceDeps): ReceiptService {
  const { db } = deps;

  return {
    getBySaleId(rawSaleId: unknown): ReceiptRepresentation {
      const saleId = validateSaleId(rawSaleId);

      const sale = readSaleForReceipt(db, saleId);
      if (!sale) {
        throw appErrors.receiptNotFound();
      }

      const itemRows = readSaleItemsForReceipt(db, saleId);
      if (itemRows.length === 0) {
        // A committed sale always has at least one line (`DATA_MODEL.md §13`).
        throw appErrors.receiptDataInconsistent();
      }

      const paymentRows = readPaymentsForReceipt(db, saleId);
      if (paymentRows.length !== 1) {
        // Exactly one completed payment per V1 sale (`DATA_MODEL.md §15-16`).
        throw appErrors.receiptDataInconsistent();
      }
      const payment = paymentRows[0]!;
      if (payment.amount_cents !== sale.total_cents) {
        // Σ(payment amounts) must equal the sale total (`DATA_MODEL.md §16`).
        throw appErrors.receiptDataInconsistent();
      }

      const items: ReceiptItem[] = itemRows.map((row) => ({
        productName: row.product_name_snapshot,
        brand: row.brand_snapshot,
        model: row.model_snapshot,
        condition: row.condition_snapshot,
        sku: row.sku_snapshot,
        barcode: row.barcode_snapshot,
        quantity: row.quantity,
        listedPriceCents: row.listed_price_cents,
        soldPriceCents: row.sold_price_cents,
        discountCents: row.discount_cents,
        lineSubtotalCents: row.line_subtotal_cents,
        lineTotalCents: row.line_total_cents,
      }));

      return {
        saleId: sale.id,
        receiptNumber: sale.receipt_number,
        status: sale.status,
        completedAt: sale.completed_at,
        voidedAt: sale.voided_at,
        voidReason: sale.void_reason,
        businessTimezone: readBusinessTimezone(db),
        business: {
          name: sale.business_name_snapshot,
          address: sale.business_address_snapshot,
          phone: sale.business_phone_snapshot,
        },
        customer:
          sale.customer_name_snapshot === null
            ? null
            : { name: sale.customer_name_snapshot, phone: sale.customer_phone_snapshot },
        items,
        totals: {
          subtotalCents: sale.subtotal_cents,
          discountCents: sale.discount_cents,
          taxableAmountCents: sale.taxable_amount_cents,
          taxRateBps: sale.tax_rate_bps,
          taxCents: sale.tax_cents,
          totalCents: sale.total_cents,
        },
        payment: { method: payment.method, amountCents: payment.amount_cents },
        disclaimer: sale.receipt_disclaimer_snapshot,
        footer: sale.receipt_footer_snapshot,
      };
    },
  };
}
