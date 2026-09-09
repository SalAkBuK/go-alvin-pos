import type Database from 'better-sqlite3';
import type { PaymentMethod } from '../../shared/checkout';
import type { GoogleQueueSummary } from '../../shared/google';
import type { ProductCondition } from '../../shared/products';
import type { SaleHistoryStatus } from '../../shared/salesHistory';

/**
 * SQL for the `google_sheet_export_jobs` state machine (`DATA_MODEL.md §22`-`§25`;
 * `REQ-GSHEET-004`-`REQ-GSHEET-007`, `REQ-GSHEET-015`; `task §10`-`§13`).
 *
 * Every function takes the connection it should use and opens no transaction of
 * its own except {@link claimNextJob}, which needs one atomic read+flip. There
 * is no migration — the schema (migration `001`) already carries every field.
 *
 * A job's success/failure writes are always guarded by a compare-and-set on
 * `status = 'EXPORTING' AND target_sync_version = <written version>` so a stale
 * acknowledgment, or a concurrent void that advanced the target, can never
 * finalize or regress the job (`REQ-GSHEET-015`).
 */

const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
export const MAX_FAILED_ATTEMPTS = 10;

/** `min(30 min, 30 s · 2^(n-1))` where `n` is `attempt_count` after the increment. */
export function backoffDelayMs(attemptCountAfterIncrement: number): number {
  const exponent = Math.max(0, attemptCountAfterIncrement - 1);
  const raw = INITIAL_BACKOFF_MS * 2 ** exponent;
  return Math.min(MAX_BACKOFF_MS, raw);
}

export interface SaleExportRow {
  readonly sale_id: string;
  readonly receipt_number: string;
  readonly customer_name_snapshot: string | null;
  readonly customer_phone_snapshot: string | null;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly tax_rate_bps: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly payment_method_snapshot: PaymentMethod;
  readonly status: SaleHistoryStatus;
  readonly sync_version: number;
  readonly completed_at: string;
  readonly voided_at: string | null;
  readonly void_reason: string | null;
}

export interface SaleItemExportRow {
  readonly id: string;
  readonly product_id: string;
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
  readonly line_total_cents: number;
}

export interface ClaimedJob {
  readonly id: string;
  readonly saleId: string;
  readonly targetSyncVersion: number;
  readonly attemptCount: number;
}

export type ClaimOutcome =
  | { readonly outcome: 'idle' }
  | {
      readonly outcome: 'invariant';
      readonly jobId: string;
      readonly saleId: string;
      readonly jobTargetVersion: number;
      readonly saleSyncVersion: number;
    }
  | { readonly outcome: 'claimed'; readonly job: ClaimedJob; readonly sale: SaleExportRow };

/**
 * Atomically pick the oldest eligible `PENDING` job (excluding `excludeIds`),
 * verify the version invariant, and flip it to `EXPORTING`. Runs in one
 * transaction so a concurrent void cannot tear the job/sale read.
 *
 * `invariant` ⇒ `job.target_sync_version !== sales.sync_version`, which the two
 * authoritative writers (checkout / void) make impossible; the worker logs it
 * and skips the job without any network call or mutation (`task §10`).
 */
export function claimNextJob(
  db: Database.Database,
  now: string,
  excludeIds: readonly string[] = [],
): ClaimOutcome {
  const run = db.transaction((): ClaimOutcome => {
    const placeholders = excludeIds.map(() => '?').join(', ');
    const notIn = excludeIds.length > 0 ? `AND j.id NOT IN (${placeholders})` : '';
    const job = db
      .prepare(
        `SELECT j.id, j.sale_id, j.target_sync_version, j.attempt_count
           FROM google_sheet_export_jobs j
          WHERE j.status = 'PENDING'
            AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= @now)
            ${notIn}
          ORDER BY j.next_attempt_at IS NULL DESC, j.next_attempt_at ASC, j.created_at ASC
          LIMIT 1`,
      )
      .get(...excludeIds, { now }) as
      | {
          id: string;
          sale_id: string;
          target_sync_version: number;
          attempt_count: number;
        }
      | undefined;
    if (!job) {
      return { outcome: 'idle' };
    }

    const sale = db
      .prepare(
        `SELECT id AS sale_id, receipt_number,
                customer_name_snapshot, customer_phone_snapshot,
                subtotal_cents, discount_cents, tax_rate_bps, tax_cents, total_cents,
                payment_method_snapshot, status, sync_version,
                completed_at, voided_at, void_reason
           FROM sales WHERE id = ?`,
      )
      .get(job.sale_id) as SaleExportRow | undefined;
    if (!sale) {
      // Job with no sale — treat as an invariant violation (skip, no network).
      return {
        outcome: 'invariant',
        jobId: job.id,
        saleId: job.sale_id,
        jobTargetVersion: job.target_sync_version,
        saleSyncVersion: -1,
      };
    }

    if (job.target_sync_version !== sale.sync_version) {
      return {
        outcome: 'invariant',
        jobId: job.id,
        saleId: job.sale_id,
        jobTargetVersion: job.target_sync_version,
        saleSyncVersion: sale.sync_version,
      };
    }

    db.prepare(
      `UPDATE google_sheet_export_jobs
          SET status = 'EXPORTING', last_attempt_at = @now, updated_at = @now
        WHERE id = @id AND status = 'PENDING'`,
    ).run({ id: job.id, now });

    return {
      outcome: 'claimed',
      job: {
        id: job.id,
        saleId: job.sale_id,
        targetSyncVersion: job.target_sync_version,
        attemptCount: job.attempt_count,
      },
      sale,
    };
  });
  return run.immediate();
}

/** The sale's immutable item rows for the export payload (deterministic order). */
export function readSaleItemsForExport(db: Database.Database, saleId: string): SaleItemExportRow[] {
  return db
    .prepare(
      `SELECT id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
              condition_snapshot, sku_snapshot, barcode_snapshot, quantity,
              listed_price_cents, sold_price_cents, discount_cents, line_total_cents
         FROM sale_items
        WHERE sale_id = ?
        ORDER BY product_id, listed_price_cents, sold_price_cents, quantity, id`,
    )
    .all(saleId) as SaleItemExportRow[];
}

/**
 * Finalize a job — only when the revision it wrote still equals the current
 * target (`REQ-GSHEET-015`). Returns rows changed: `1` = finalized, `0` = stale
 * (a void advanced the target, or the job already moved) — the caller discards.
 */
export function markExported(
  db: Database.Database,
  args: { readonly id: string; readonly writtenVersion: number; readonly now: string },
): number {
  return db
    .prepare(
      `UPDATE google_sheet_export_jobs
          SET status = 'EXPORTED',
              exported_sync_version = @writtenVersion,
              exported_at = @now,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = @now
        WHERE id = @id
          AND status = 'EXPORTING'
          AND target_sync_version = @writtenVersion
          AND (exported_sync_version IS NULL OR exported_sync_version < @writtenVersion)`,
    )
    .run(args).changes;
}

export interface FailureResult {
  readonly changed: number;
  readonly terminal: boolean;
  readonly attemptCount: number;
}

/**
 * Record a definite export failure: `attempt_count + 1`, exponential
 * `next_attempt_at`, scrubbed `last_error`; the 10th failure ⇒ `FAILED` with
 * `next_attempt_at = NULL`. CAS-guarded on the written version so a raced void
 * is never overwritten (`changed = 0`).
 */
export function recordFailure(
  db: Database.Database,
  args: {
    readonly id: string;
    readonly writtenVersion: number;
    readonly now: string;
    readonly sanitizedError: string;
  },
): FailureResult {
  const run = db.transaction((): FailureResult => {
    const current = db
      .prepare(
        `SELECT attempt_count FROM google_sheet_export_jobs
          WHERE id = @id AND status = 'EXPORTING' AND target_sync_version = @writtenVersion`,
      )
      .get({ id: args.id, writtenVersion: args.writtenVersion }) as
      { attempt_count: number } | undefined;
    if (!current) {
      return { changed: 0, terminal: false, attemptCount: 0 };
    }
    const attemptCount = current.attempt_count + 1;
    const terminal = attemptCount >= MAX_FAILED_ATTEMPTS;
    const nextAttemptAt = terminal
      ? null
      : new Date(Date.parse(args.now) + backoffDelayMs(attemptCount)).toISOString();
    const changed = db
      .prepare(
        `UPDATE google_sheet_export_jobs
            SET status = @status,
                attempt_count = @attemptCount,
                next_attempt_at = @nextAttemptAt,
                last_error = @sanitizedError,
                updated_at = @now
          WHERE id = @id AND status = 'EXPORTING' AND target_sync_version = @writtenVersion`,
      )
      .run({
        id: args.id,
        writtenVersion: args.writtenVersion,
        status: terminal ? 'FAILED' : 'PENDING',
        attemptCount,
        nextAttemptAt,
        sanitizedError: args.sanitizedError.slice(0, 500),
        now: args.now,
      }).changes;
    return { changed, terminal, attemptCount };
  });
  return run.immediate();
}

/**
 * Recover jobs stuck `EXPORTING` past the 5-minute threshold (crash, hang, or an
 * ambiguous/aborted request) back to `PENDING`. Never touches `attempt_count`,
 * `target_sync_version`, `exported_sync_version`, or the sale (`task §13`,
 * `DATA_MODEL.md §24`).
 */
export function recoverStaleExporting(
  db: Database.Database,
  args: { readonly now: string; readonly staleBefore: string },
): number {
  return db
    .prepare(
      `UPDATE google_sheet_export_jobs
          SET status = 'PENDING',
              next_attempt_at = @now,
              last_error = COALESCE(last_error, 'Recovered from stale EXPORTING state'),
              updated_at = @now
        WHERE status = 'EXPORTING'
          AND (last_attempt_at IS NULL OR last_attempt_at <= @staleBefore)`,
    )
    .run(args).changes;
}

/**
 * Manual "Retry Export" (`REQ-GSHEET-012`, `POS_WORKFLOWS.md §48`): `FAILED`
 * (or a lingering `PENDING`) → `PENDING` with a fresh retry budget. Never
 * touches the sale, payment, inventory, receipt number, or any sync version.
 * Returns rows changed.
 */
export function manualRetry(
  db: Database.Database,
  args: { readonly saleId: string; readonly now: string },
): number {
  return db
    .prepare(
      `UPDATE google_sheet_export_jobs
          SET status = 'PENDING',
              attempt_count = 0,
              next_attempt_at = @now,
              last_error = NULL,
              updated_at = @now
        WHERE sale_id = @saleId AND status IN ('FAILED', 'PENDING')`,
    )
    .run(args).changes;
}

export function queueSummary(db: Database.Database): GoogleQueueSummary {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM google_sheet_export_jobs GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const byStatus = new Map(rows.map((r) => [r.status, r.n]));
  return {
    pending: byStatus.get('PENDING') ?? 0,
    exporting: byStatus.get('EXPORTING') ?? 0,
    exported: byStatus.get('EXPORTED') ?? 0,
    failed: byStatus.get('FAILED') ?? 0,
  };
}
