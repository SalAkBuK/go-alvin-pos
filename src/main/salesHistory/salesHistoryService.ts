import type Database from 'better-sqlite3';
import type { SaleDetail, SaleDetailItem, SalesHistoryEntry } from '../../shared/salesHistory';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { appErrors } from '../shared/appError';
import { deriveBusinessDate } from './businessDate';
import {
  findSaleForHistory,
  listSaleItemsForHistory,
  listSalesForHistory,
} from './salesHistoryRepository';
import type { SalesHistoryListRow } from './salesHistoryRepository';
import { validateHistorySaleId, validateHistorySearch } from './salesHistoryValidation';

/**
 * The Sales History read model (`REQ-HIST-001`-`REQ-HIST-004`; `POS_WORKFLOWS.md
 * §50`-`§52`; `DATA_MODEL.md §4`, `§11`-`§16`, `§44-49`; `task §5`-`§18`).
 *
 * Pure read. It:
 *
 *  - loads committed rows from `sales` / `sale_items` / `payments` /
 *    `google_sheet_export_jobs` only — never current `products`, `customers`, or
 *    tax/business settings as a substitute for historical content
 *    (`REQ-SALE-009`, `TEST-HIST-004`);
 *  - derives each sale's *business date* live from the immutable `completed_at`
 *    plus the *currently configured* `business_timezone` (`DATA_MODEL.md §4`);
 *  - applies receipt-number / customer-snapshot / business-date search
 *    deterministically in this trusted layer;
 *  - writes nothing and emits no audit event — viewing history is not an
 *    authoritative business event (`DATA_MODEL.md §36A`, `task §34`);
 *  - needs no network: all data is local SQLite (`REQ-OFF-006`, `REQ-OFF-008`,
 *    `task §22`).
 *
 * Void mutation, Retry Export, and physical printing are explicitly NOT here;
 * "View Receipt" reuses the existing `receiptService` path.
 */

export interface SalesHistoryServiceDeps {
  readonly db: Database.Database;
}

export interface SalesHistoryService {
  list(rawSearch: unknown): readonly SalesHistoryEntry[];
  getById(rawSaleId: unknown): SaleDetail;
}

/** Uppercased, alphanumerics only — so `GP-000124`, `000124`, `gp000124` all compare. */
function normalizeReceipt(value: string): string {
  return value.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

function matchesQuery(row: SalesHistoryListRow, query: string): boolean {
  if (query === '') {
    return true;
  }
  const q = query.toLowerCase();
  const receiptHit = normalizeReceipt(row.receipt_number).includes(normalizeReceipt(query));
  const nameHit =
    row.customer_name_snapshot !== null && row.customer_name_snapshot.toLowerCase().includes(q);
  const queryDigits = digitsOnly(query);
  const phoneHit =
    queryDigits.length > 0 &&
    row.customer_phone_snapshot !== null &&
    digitsOnly(row.customer_phone_snapshot).includes(queryDigits);
  return receiptHit || nameHit || phoneHit;
}

export function createSalesHistoryService(deps: SalesHistoryServiceDeps): SalesHistoryService {
  const { db } = deps;

  return {
    list(rawSearch: unknown): readonly SalesHistoryEntry[] {
      const { query, businessDate } = validateHistorySearch(rawSearch);
      const timezone = readBusinessTimezone(db);

      const rows = listSalesForHistory(db);
      const entries: SalesHistoryEntry[] = [];
      for (const row of rows) {
        if (!matchesQuery(row, query)) {
          continue;
        }
        const rowBusinessDate = deriveBusinessDate(row.completed_at, timezone);
        if (businessDate !== null && rowBusinessDate !== businessDate) {
          continue;
        }
        entries.push({
          saleId: row.id,
          receiptNumber: row.receipt_number,
          completedAt: row.completed_at,
          businessDate: rowBusinessDate,
          customerName: row.customer_name_snapshot,
          totalCents: row.total_cents,
          paymentMethod: row.payment_method_snapshot,
          status: row.status,
          voidedAt: row.voided_at,
          exportStatus: row.export_status,
        });
      }
      // The repository already returns newest-completed-first with a
      // deterministic tie-break; filtering preserves that order.
      return entries;
    },

    getById(rawSaleId: unknown): SaleDetail {
      const saleId = validateHistorySaleId(rawSaleId);

      const sale = findSaleForHistory(db, saleId);
      if (!sale) {
        throw appErrors.saleNotFound();
      }

      const items: SaleDetailItem[] = listSaleItemsForHistory(db, saleId).map((row) => ({
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
        customerName: sale.customer_name_snapshot,
        customerPhone: sale.customer_phone_snapshot,
        items,
        subtotalCents: sale.subtotal_cents,
        discountCents: sale.discount_cents,
        taxableAmountCents: sale.taxable_amount_cents,
        taxRateBps: sale.tax_rate_bps,
        taxCents: sale.tax_cents,
        totalCents: sale.total_cents,
        paymentMethod: sale.payment_method_snapshot,
        exportStatus: sale.export_status,
      };
    },
  };
}
