import type Database from 'better-sqlite3';
import type { PaymentMethod } from '../../shared/reports';
import type { SaleHistoryStatus } from '../../shared/salesHistory';

/**
 * Read-only SQL for the Daily Report (`ARCHITECTURE.md §12`, `§36`;
 * `DATA_MODEL.md §4`, `§11`; `POS_WORKFLOWS.md §53`-`§55`).
 *
 * A single pure `SELECT` over `sales` — it opens no transaction, writes nothing,
 * and reads ONLY the immutable transaction-time snapshot columns the report
 * aggregates. It never joins current `products`, `customers`, `settings`, or
 * `google_sheet_export_jobs`: report totals are derived from what each sale
 * stored at completion, never recalculated from current prices/tax, and the
 * Google export state has zero effect on them (`REQ-REPORT-007`, `TEST-OFF-011`).
 *
 * There is deliberately no generic query capability — this is one fixed,
 * business-named statement with no caller-supplied predicate, column, or order.
 *
 * Business-day attribution is not expressed in SQL. Following the established
 * Sales History implementation (`salesHistory/businessDate.ts`, `TEST-HIST-006`),
 * every sale's business date is derived in the trusted service layer from its
 * `completed_at` plus the currently configured `business_timezone`, so Daily
 * Reports and Sales History can never disagree about which day a sale belongs
 * to. V1 is a single fixed store, so reading all sale rows and bucketing in
 * memory is well within scale.
 */

export interface DailyReportSaleRow {
  readonly completed_at: string;
  readonly status: SaleHistoryStatus;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly payment_method_snapshot: PaymentMethod;
}

/**
 * Every committed sale (`COMPLETED` and `VOIDED`) with only the columns the
 * Daily Report needs. Order is irrelevant to an aggregate, but a deterministic
 * `completed_at` order keeps test assertions and any future streaming stable.
 */
export function listSalesForDailyReport(db: Database.Database): DailyReportSaleRow[] {
  return db
    .prepare(
      `SELECT s.completed_at, s.status,
              s.subtotal_cents, s.discount_cents, s.tax_cents, s.total_cents,
              s.payment_method_snapshot
         FROM sales s
        ORDER BY s.completed_at ASC, s.id ASC`,
    )
    .all() as DailyReportSaleRow[];
}
