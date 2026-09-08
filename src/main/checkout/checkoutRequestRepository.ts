import type Database from 'better-sqlite3';

/**
 * `checkout_requests` SQL, isolated behind a repository (`ARCHITECTURE.md §12`,
 * `DATA_MODEL.md §32`-`§34`).
 *
 * Phase 2E writes only the Cash lifecycle: insert a `SUBMITTED` row (Phase 1
 * Step A), advance it to `COMPLETED` (Phase 2 success), or advance it to
 * `COMMIT_FAILED` (best effort, after any Phase 2 rollback — a storage failure
 * as `SALE_COMMIT_FAILED`, or a trusted revalidation rejection as its specific
 * code: `DATA_MODEL.md §31`, `§33`). It never writes `PENDING_PAYMENT`,
 * `clover_approved_confirmed_at`, or any resolution field — those are the Card /
 * reconciliation slice (Phase 2F). Every function takes the connection it should
 * use and opens no transaction of its own.
 */

export interface CheckoutRequestRow {
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly payment_method_snapshot: 'CASH' | 'CARD';
  readonly intended_total_cents: number;
  readonly clover_approved_confirmed_at: string | null;
  readonly sale_id: string | null;
  readonly status: 'PENDING_PAYMENT' | 'SUBMITTED' | 'COMPLETED' | 'COMMIT_FAILED';
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly failed_at: string | null;
}

export function findCheckoutRequest(
  db: Database.Database,
  requestId: string,
): CheckoutRequestRow | null {
  const row = db
    .prepare(
      `SELECT request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
              clover_approved_confirmed_at, sale_id, status, failure_code,
              created_at, completed_at, failed_at
         FROM checkout_requests WHERE request_id = ?`,
    )
    .get(requestId) as CheckoutRequestRow | undefined;
  return row ?? null;
}

export interface InsertSubmittedCashRequest {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly intendedTotalCents: number;
  readonly createdAt: string;
}

/** Phase 1 Step A for Cash: `status = SUBMITTED` immediately (`DATA_MODEL.md §31`). */
export function insertSubmittedCashRequest(
  db: Database.Database,
  row: InsertSubmittedCashRequest,
): void {
  db.prepare(
    `INSERT INTO checkout_requests
       (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
        clover_approved_confirmed_at, sale_id, status, failure_code,
        resolution_status, resolution_note, created_at, completed_at, failed_at, resolved_at)
     VALUES
       (@requestId, @requestFingerprint, 'CASH', @intendedTotalCents,
        NULL, NULL, 'SUBMITTED', NULL,
        NULL, NULL, @createdAt, NULL, NULL, NULL)`,
  ).run(row);
}

/**
 * Phase 2 success: advance the existing row to `COMPLETED`. `failure_code` /
 * `failed_at` are cleared so the schema's
 * `(status = 'COMMIT_FAILED') = (failure_code IS NOT NULL)` invariant holds when
 * a previously `COMMIT_FAILED` row completes on retry (`DATA_MODEL.md §33`,
 * `§34`).
 */
export function markCheckoutRequestCompleted(
  db: Database.Database,
  args: { readonly requestId: string; readonly saleId: string; readonly completedAt: string },
): void {
  db.prepare(
    `UPDATE checkout_requests
        SET status = 'COMPLETED', sale_id = @saleId, completed_at = @completedAt,
            failure_code = NULL, failed_at = NULL
      WHERE request_id = @requestId`,
  ).run(args);
}

/**
 * Phase 2 failure: best-effort transition to `COMMIT_FAILED`, written in its own
 * tiny transaction *after* Phase 2 rolled back so it survives independently
 * (`DATA_MODEL.md §31` "Phase 2 failure — record the outcome").
 */
export function markCheckoutRequestCommitFailed(
  db: Database.Database,
  args: { readonly requestId: string; readonly failureCode: string; readonly failedAt: string },
): void {
  db.prepare(
    `UPDATE checkout_requests
        SET status = 'COMMIT_FAILED', failure_code = @failureCode, failed_at = @failedAt
      WHERE request_id = @requestId AND status IN ('SUBMITTED', 'COMMIT_FAILED')`,
  ).run(args);
}
