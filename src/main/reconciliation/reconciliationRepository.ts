import type Database from 'better-sqlite3';
import type { ReconciliationEntry } from '../../shared/reconciliation';

/**
 * `checkout_requests` reads/writes for the Reconciliation Queue, isolated behind
 * a repository (`ARCHITECTURE.md §12`; `DATA_MODEL.md §31B`; `POS_WORKFLOWS.md
 * §35B`). Card-only by construction — every query filters
 * `payment_method_snapshot = 'CARD'`. No SQL is exposed to services or the
 * renderer; there is deliberately no generic query capability.
 */

interface Row {
  readonly request_id: string;
  readonly status: 'PENDING_PAYMENT' | 'COMMIT_FAILED';
  readonly failure_code: string | null;
  readonly intended_total_cents: number;
  readonly created_at: string;
  readonly clover_approved_confirmed_at: string | null;
  readonly resolution_status: 'UNRESOLVED' | 'RESOLVED' | null;
}

function toEntry(row: Row): ReconciliationEntry {
  return {
    requestId: row.request_id,
    status: row.status,
    failureCode: row.failure_code,
    intendedTotalCents: row.intended_total_cents,
    createdAt: row.created_at,
    cloverApprovedConfirmedAt: row.clover_approved_confirmed_at,
    resolutionStatus: row.resolution_status ?? 'UNRESOLVED',
  };
}

/**
 * Unresolved Card incidents (`DATA_MODEL.md §31B`), newest last:
 *
 *  - `COMMIT_FAILED` with a `failure_code` other than `CLOVER_DECLINED` — Phase 2
 *    failed, or Step B's confirmation write failed and a best-effort
 *    `COMMIT_FAILED` transition succeeded; OR
 *  - `PENDING_PAYMENT` whose `created_at` is at or before `staleCutoffIso`
 *    (now − 5 min) — Case 2, where the confirmation write could not be recorded
 *    at all.
 *
 * A not-yet-stale `PENDING_PAYMENT` row is a healthy in-progress checkout and is
 * excluded; a `CLOVER_DECLINED` row is an expected outcome and is excluded; a
 * `RESOLVED` row is excluded. Timestamps are ISO-8601 UTC, so the string
 * comparison is a valid chronological comparison.
 */
export function listUnresolvedCardIncidents(
  db: Database.Database,
  staleCutoffIso: string,
): ReconciliationEntry[] {
  const rows = db
    .prepare(
      `SELECT request_id, status, failure_code, intended_total_cents, created_at,
              clover_approved_confirmed_at, resolution_status
         FROM checkout_requests
        WHERE payment_method_snapshot = 'CARD'
          AND (resolution_status IS NULL OR resolution_status <> 'RESOLVED')
          AND (
                (status = 'COMMIT_FAILED' AND failure_code <> 'CLOVER_DECLINED')
             OR (status = 'PENDING_PAYMENT' AND created_at <= @staleCutoffIso)
              )
        ORDER BY created_at ASC, request_id ASC`,
    )
    .all({ staleCutoffIso }) as Row[];
  return rows.map(toEntry);
}

/** One incident, whatever its state, for the resolve path's precondition check. */
export function findReconciliationRow(db: Database.Database, requestId: string): Row | null {
  const row = db
    .prepare(
      `SELECT request_id, status, failure_code, intended_total_cents, created_at,
              clover_approved_confirmed_at, resolution_status
         FROM checkout_requests
        WHERE request_id = ? AND payment_method_snapshot = 'CARD'`,
    )
    .get(requestId) as Row | undefined;
  return row ?? null;
}

/**
 * Mark a Card incident manually resolved (`DATA_MODEL.md §31B` step 2;
 * `POS_WORKFLOWS.md §35B`). Records only that a person reconciled the
 * discrepancy — never creates, edits, or backdates a sale, inventory movement,
 * or payment. The schema CHECK requires a non-blank note and `resolved_at`
 * together with `resolution_status = 'RESOLVED'`.
 */
export function markReconciliationResolved(
  db: Database.Database,
  args: { readonly requestId: string; readonly note: string; readonly resolvedAt: string },
): number {
  const info = db
    .prepare(
      `UPDATE checkout_requests
          SET resolution_status = 'RESOLVED', resolution_note = @note, resolved_at = @resolvedAt
        WHERE request_id = @requestId
          AND payment_method_snapshot = 'CARD'
          AND (resolution_status IS NULL OR resolution_status <> 'RESOLVED')`,
    )
    .run(args);
  return info.changes;
}

export { toEntry as reconciliationRowToEntry };
export type { Row as ReconciliationCheckoutRow };
