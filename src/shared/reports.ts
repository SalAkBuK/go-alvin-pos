/**
 * Shared Daily Reports contract (Phase 2K — Daily Reports).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY reporting shapes that cross the IPC boundary —
 * the renderer never sees a raw SQLite row, SQL text, an `Error`, or a DB
 * handle.
 *
 * SCOPE: a single read-only "Daily Report" recomputed live from authoritative
 * local `sales` snapshots for one selected business day (`PRODUCT_SCOPE.md §19`;
 * `REQ-REPORT-001`-`REQ-REPORT-009`; `POS_WORKFLOWS.md §53`-`§55`;
 * `ARCHITECTURE.md §36`; `DATA_MODEL.md §4`). Every monetary total is an integer
 * number of cents (`DATA_MODEL.md §5`); revenue metrics exclude `VOIDED` sales
 * while void visibility is retained as a separate count. Google Sheets is never
 * queried. Advanced accounting, CSV/print export, charts, employee reports, and
 * closing/lock workflows are out of scope.
 *
 * The typed result envelope (`IpcResult` / `IpcError`) and error codes are
 * reused from `./products` — the shared cross-slice contract.
 */

export type { PaymentMethod } from './checkout';

/**
 * `reports:daily` payload. `businessDate` is optional: omitted / `null` / `''`
 * means "the current business day in the configured `business_timezone`",
 * resolved authoritatively in the trusted layer (never from the renderer /
 * OS / browser clock). A provided value must be a real `YYYY-MM-DD` calendar
 * date; it is interpreted in the currently configured `business_timezone`
 * (`DATA_MODEL.md §4`), never the UTC calendar date.
 */
export interface DailyReportInput {
  readonly businessDate?: string | null;
}

/**
 * One day's report — all values recomputed live from `sales` at query time.
 *
 * A sale is attributed to this report's `businessDate` when the calendar date of
 * its immutable `sales.completed_at` (UTC), converted into `businessTimezone`
 * using standard IANA rules, equals `businessDate`. `created_at`, the UTC
 * calendar date, and `voided_at` are never used for this attribution.
 *
 * Revenue metrics (`grossSalesCents`, `discountCents`, `taxCents`,
 * `totalSalesCents`, `cashTotalCents`, `cardTotalCents`) and
 * `completedTransactionCount` count only non-`VOIDED` `COMPLETED` sales.
 * `voidedTransactionCount` counts sales attributed to this same business date
 * whose current status is `VOIDED` — exposed so a void is never hidden, and
 * clearly excluded from every revenue total. A sale voided on a later day
 * therefore reduces *this* (its original) day's revenue retroactively the next
 * time the report is viewed, with no revenue-adjustment line on the void date
 * (`REQ-REPORT-009`, `DATA_MODEL.md §4` "Late-void attribution").
 *
 * For valid V1 `COMPLETED` sales (payment method is exactly `CASH` or `CARD`),
 * `cashTotalCents + cardTotalCents === totalSalesCents`.
 */
export interface DailyReport {
  /** The business day this report covers, `YYYY-MM-DD`, in `businessTimezone`. */
  readonly businessDate: string;
  /** The IANA timezone the attribution used — the value configured *now*. */
  readonly businessTimezone: string;
  /** `true` when `businessDate` is the current business day (for "return to today" UX). */
  readonly isToday: boolean;
  /** Non-voided `COMPLETED` sales attributed to `businessDate`. */
  readonly completedTransactionCount: number;
  /** `VOIDED` sales attributed to `businessDate` by their original `completed_at`. */
  readonly voidedTransactionCount: number;
  /** Σ `sales.subtotal_cents` over non-voided `COMPLETED` sales (`REQ-REPORT-002`). */
  readonly grossSalesCents: number;
  /** Σ `sales.discount_cents` over non-voided `COMPLETED` sales (`REQ-REPORT-003`). */
  readonly discountCents: number;
  /** Σ `sales.tax_cents` over non-voided `COMPLETED` sales (`REQ-REPORT-004`). */
  readonly taxCents: number;
  /** Σ `sales.total_cents` over non-voided `COMPLETED` sales (`REQ-REPORT-005`). */
  readonly totalSalesCents: number;
  /** Σ `sales.total_cents` where `payment_method_snapshot = 'CASH'` (`REQ-REPORT-006`). */
  readonly cashTotalCents: number;
  /** Σ `sales.total_cents` where `payment_method_snapshot = 'CARD'` (`REQ-REPORT-006`). */
  readonly cardTotalCents: number;
}
