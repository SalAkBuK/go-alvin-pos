import type Database from 'better-sqlite3';
import type { PaymentMethod } from '../../shared/checkout';
import type { SaleHistoryStatus } from '../../shared/salesHistory';

/**
 * SQL for the authoritative void transaction (`ARCHITECTURE.md §12`, `§42.1`;
 * `DATA_MODEL.md §11`-`§12`, `§17`-`§18`, `§22`-`§23`, `§63`).
 *
 * Every function takes the connection it should use and opens NO transaction of
 * its own, so they compose inside the void service's single `BEGIN IMMEDIATE`.
 * The `VOID_REVERSAL` movement inserts and the current-quantity reads reuse
 * `inventoryRepository` / `productRepository`; this module owns only the
 * void-specific `sales` and `google_sheet_export_jobs` writes plus the read of
 * the sale's original `SALE` movements.
 *
 * A void never updates or deletes an original `SALE` movement, a `sale_items`
 * row, a `payments` row, or a snapshot column.
 */

export interface SaleVoidRow {
  readonly id: string;
  readonly status: SaleHistoryStatus;
  readonly sync_version: number;
  readonly payment_method_snapshot: PaymentMethod;
  readonly receipt_number: string;
}

/** The minimal sale row the void transaction needs to decide and act. */
export function findSaleForVoid(db: Database.Database, saleId: string): SaleVoidRow | null {
  const row = db
    .prepare(
      `SELECT id, status, sync_version, payment_method_snapshot, receipt_number
         FROM sales WHERE id = ?`,
    )
    .get(saleId) as SaleVoidRow | undefined;
  return row ?? null;
}

/**
 * The controlled `COMPLETED → VOIDED` transition (`DATA_MODEL.md §12`, `§57`;
 * `sales` void-field CHECK, `TEST-DB-015`). The `WHERE status = 'COMPLETED'`
 * clause is defence-in-depth on top of the service's own re-check inside the
 * transaction — the row must already be COMPLETED for exactly one caller to win.
 * Returns the number of rows changed (1 = applied, 0 = not COMPLETED / missing).
 */
export function markSaleVoided(
  db: Database.Database,
  args: {
    readonly saleId: string;
    readonly voidedAt: string;
    readonly voidReason: string;
    readonly newSyncVersion: number;
  },
): number {
  return db
    .prepare(
      `UPDATE sales
          SET status = 'VOIDED',
              voided_at = @voidedAt,
              void_reason = @voidReason,
              sync_version = @newSyncVersion
        WHERE id = @saleId AND status = 'COMPLETED'`,
    )
    .run(args).changes;
}

export interface OriginalSaleMovementRow {
  readonly id: string;
  readonly product_id: string;
  /** The original deduction, always negative for a `SALE` movement. */
  readonly quantity_change: number;
}

/**
 * The sale's original `SALE` inventory movements — the movements a void reverses
 * (`REQ-VOID-003`, `DATA_MODEL.md §18` step 4). Phase 2 writes exactly one `SALE`
 * movement per product; `id` order is deterministic and restart-stable.
 */
export function listOriginalSaleMovements(
  db: Database.Database,
  saleId: string,
): OriginalSaleMovementRow[] {
  return db
    .prepare(
      `SELECT id, product_id, quantity_change
         FROM inventory_movements
        WHERE sale_id = ? AND movement_type = 'SALE'
        ORDER BY id`,
    )
    .all(saleId) as OriginalSaleMovementRow[];
}

/**
 * "Advance and reschedule" the sale's single existing Google Sheets export job
 * for the new `sync_version` (`REQ-VOID-007`; `POS_WORKFLOWS.md §88` step 8;
 * `DATA_MODEL.md §23` "the same job row is updated ... target_sync_version is set
 * to the incremented sales.sync_version and status returns to PENDING", `§63`).
 *
 * Canon pins: `target_sync_version = new sync_version`, `status = 'PENDING'`, one
 * job per Sale ID (no insert). `exported_sync_version` is deliberately LEFT
 * UNCHANGED — it records the most recent revision actually confirmed remotely,
 * and a void must not claim the new revision has already exported (`task §7`;
 * `DATA_MODEL.md §22` `exported_sync_version` definition).
 *
 * The retry-bookkeeping fields (`attempt_count`, `next_attempt_at`,
 * `last_attempt_at`, `exported_at`, `last_error`) are reset to the same initial
 * state `insertExportJob` establishes for a fresh delivery of a target revision:
 * this is the literal reading of "**reschedule**" (POS_WORKFLOWS §88.8) — the job
 * has never attempted to deliver this new revision, so the attempt history and
 * failure state from the *previous* target must not carry over and cause the
 * void delivery to be escalated to `FAILED` prematurely (`REQ-VOID-007`:
 * "must eventually reflect"; `TEST-VOID-007`: "remains retryable"). See the
 * Phase 2H report — this reset is a derived interpretation, not verbatim canon.
 *
 * Returns rows changed (1 = the expected single job; 0 = no job row, which the
 * service treats as an inconsistency and rolls back).
 */
export function requeueExportJobForVoid(
  db: Database.Database,
  args: {
    readonly saleId: string;
    readonly targetSyncVersion: number;
    readonly updatedAt: string;
  },
): number {
  return db
    .prepare(
      `UPDATE google_sheet_export_jobs
          SET status = 'PENDING',
              target_sync_version = @targetSyncVersion,
              attempt_count = 0,
              next_attempt_at = @updatedAt,
              last_attempt_at = NULL,
              exported_at = NULL,
              last_error = NULL,
              updated_at = @updatedAt
        WHERE sale_id = @saleId`,
    )
    .run(args).changes;
}
