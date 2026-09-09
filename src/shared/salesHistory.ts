/**
 * Shared Sales History contract (Phase 2G — Sales History + Transaction Detail).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY sales-history shapes that cross the IPC boundary —
 * the renderer never sees a raw SQLite row, SQL text, or an `Error`/stack.
 *
 * SCOPE: a read model over committed local transaction state (`sales`,
 * `sale_items`, `payments`, `google_sheet_export_jobs`) — the Sales History list,
 * receipt-number / customer / business-date search, and one sale's historical
 * detail (`REQ-HIST-001`-`REQ-HIST-004`; `POS_WORKFLOWS.md §50`-`§52`;
 * `DATA_MODEL.md §4`, `§11`-`§16`, `§44-49`) — plus the Phase 2H one-time
 * completed-sale **void** launched from that detail (`REQ-VOID-001`-`REQ-VOID-008`;
 * `POS_WORKFLOWS.md §88`-`§91`; `ARCHITECTURE.md §42.1`; `DATA_MODEL.md §18`,
 * `§63`). Returns, refunds, Retry Export, physical printing, and reporting are
 * NOT here. "View Receipt" reuses the existing `receipts:get-by-sale-id` path
 * unchanged; the void reuses the existing audit / inventory-movement / export-job
 * infrastructure.
 *
 * The typed result envelope (`IpcResult` / `IpcError`) and error codes are
 * reused from `./products` — the shared cross-slice contract.
 */

import type { PaymentMethod, SaleExportStatus } from './checkout';
import type { ProductCondition } from './products';

export type { SaleExportStatus } from './checkout';

/** Sale lifecycle states surfaced by history (`DATA_MODEL.md §11`). V1 produces `COMPLETED`; `VOIDED` is future-compatible. */
export type SaleHistoryStatus = 'COMPLETED' | 'VOIDED';

/** Trimmed upper bound for the free-text receipt/customer search term (guards against pathological IPC strings). */
export const SALES_HISTORY_QUERY_MAX_LENGTH = 120;

/**
 * `sales-history:list` payload. Both fields optional; an omitted/blank field is
 * "no filter". Filters combine with AND (`task §11`).
 */
export interface SalesHistorySearch {
  /** Free text — matched against `sales.receipt_number` and the historical customer name/phone snapshots. */
  readonly query?: string;
  /**
   * A single business date as `YYYY-MM-DD`, interpreted in the *currently
   * configured* `business_timezone` (`DATA_MODEL.md §4`), never the UTC calendar
   * date. `null` / omitted = no date filter.
   */
  readonly businessDate?: string | null;
}

/**
 * One Sales History list row — deliberately narrow (`task §6`). Every value is a
 * committed transaction-time snapshot except `businessDate`, which is derived
 * live from the immutable `completed_at` plus the current `business_timezone`
 * (`DATA_MODEL.md §4`).
 */
export interface SalesHistoryEntry {
  readonly saleId: string;
  readonly receiptNumber: string;
  /** `sales.completed_at` — ISO-8601 UTC, the authoritative completion instant. */
  readonly completedAt: string;
  /** Calendar date of `completedAt` in the current `business_timezone`, `YYYY-MM-DD`. */
  readonly businessDate: string;
  /** `sales.customer_name_snapshot` — `null` for a customerless sale (no placeholder is invented). */
  readonly customerName: string | null;
  readonly totalCents: number;
  readonly paymentMethod: PaymentMethod;
  readonly status: SaleHistoryStatus;
  /** `sales.voided_at` (ISO-8601 UTC) when `status = VOIDED`, else `null`. */
  readonly voidedAt: string | null;
  /**
   * The durable local export state from `google_sheet_export_jobs.status`
   * (`DATA_MODEL.md §22`-`§23`; `REQ-HIST-004`). `null` only if the (always
   * expected) job row is somehow absent — displayed honestly, never faked.
   */
  readonly exportStatus: SaleExportStatus | null;
}

/** One historical sold line — every value a `sale_items` transaction-time snapshot (`DATA_MODEL.md §13`-`§14`). */
export interface SaleDetailItem {
  readonly productName: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly quantity: number;
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly discountCents: number;
  readonly lineSubtotalCents: number;
  readonly lineTotalCents: number;
}

/**
 * One sale's full historical detail (`REQ-HIST-002`; `POS_WORKFLOWS.md §51`).
 * Assembled entirely from committed snapshots; the single live value is
 * `businessTimezone`, used only to label the immutable timestamps in local time
 * (`DATA_MODEL.md §4`, matching the receipt convention).
 */
export interface SaleDetail {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly status: SaleHistoryStatus;
  readonly completedAt: string;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly businessTimezone: string;
  /** `sales.customer_name_snapshot` — `null` when no customer was attached. */
  readonly customerName: string | null;
  /** `sales.customer_phone_snapshot` — `null` when absent. */
  readonly customerPhone: string | null;
  readonly items: readonly SaleDetailItem[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly taxRateBps: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paymentMethod: PaymentMethod;
  readonly exportStatus: SaleExportStatus | null;
}

// ── Phase 2H: Sale Void / Correction ────────────────────────────────────────

/**
 * Trimmed bounds for the required staff-entered void reason. The lower bound is
 * "non-blank after trim" (the `sales` CHECK constraint also enforces
 * `length(trim(void_reason)) > 0`, `DATA_MODEL.md §11`, `TEST-DB-015`); the upper
 * bound mirrors the existing inventory-adjustment `REASON_MAX_LENGTH` (both are a
 * required staff reason attached to an inventory-affecting correction) rather
 * than inventing a new ceiling or a reason taxonomy (`task §9`).
 */
export const VOID_REASON_MAX_LENGTH = 500;

/**
 * The exact Clover warning a Card void must display and the cashier must
 * explicitly acknowledge before the local void is submitted (`REQ-VOID-008`;
 * `POS_WORKFLOWS.md §90`; `PRODUCT_SCOPE.md §33`). Verbatim canonical text — no
 * Clover API call, refund, charge verification, or negative Card payment is ever
 * made.
 */
export const CARD_VOID_CLOVER_WARNING =
  'Voiding this POS sale does not refund or reverse the Clover payment. ' +
  'Complete any required refund or reversal separately in Clover.';

/**
 * `sales-history:void` payload. The renderer sends ONLY the immutable Sale ID and
 * the staff-entered reason; the trusted layer determines the void timestamp,
 * re-verifies the sale is `COMPLETED`, and performs the whole authoritative void
 * transaction. It never sends a timestamp, a sync version, inventory numbers, or
 * any Clover data.
 */
export interface VoidSaleInput {
  readonly saleId: string;
  readonly reason: string;
}
