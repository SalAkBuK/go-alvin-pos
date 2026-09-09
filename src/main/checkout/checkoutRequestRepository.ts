import type Database from 'better-sqlite3';

/**
 * `checkout_requests` SQL, isolated behind a repository (`ARCHITECTURE.md §12`,
 * `DATA_MODEL.md §32`-`§34`).
 *
 * Phase 2E writes the Cash lifecycle: insert a `SUBMITTED` row (Phase 1 Step A),
 * advance it to `COMPLETED` (Phase 2 success), or advance it to `COMMIT_FAILED`
 * (best effort, after any Phase 2 rollback). Phase 2F adds the Card lifecycle:
 * insert a `PENDING_PAYMENT` row (Phase 1 Step A, before Clover is invoked),
 * confirm the Clover approval (Phase 1 Step B → `SUBMITTED`), record an explicit
 * decline (`COMMIT_FAILED` / `CLOVER_DECLINED`), and auto-resolve a
 * reconciliation incident when a retry completes (`DATA_MODEL.md §31`-`§31B`).
 * Every function takes the connection it should use and opens no transaction of
 * its own.
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
  readonly resolution_status: 'UNRESOLVED' | 'RESOLVED' | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly failed_at: string | null;
  readonly resolved_at: string | null;
}

const COLUMNS = `request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
                 clover_approved_confirmed_at, sale_id, status, failure_code,
                 resolution_status, resolution_note,
                 created_at, completed_at, failed_at, resolved_at`;

export function findCheckoutRequest(
  db: Database.Database,
  requestId: string,
): CheckoutRequestRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM checkout_requests WHERE request_id = ?`)
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

export interface InsertPendingCardRequest {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly intendedTotalCents: number;
  readonly createdAt: string;
}

/**
 * Phase 1 Step A for Card: `status = PENDING_PAYMENT`, `clover_approved_confirmed_at`
 * left `NULL` — the POS does not yet know, and must not imply, whether Clover will
 * approve anything. This row MUST be committed before the cashier is instructed
 * to process any amount on Clover (`DATA_MODEL.md §31`, `§31A`;
 * `POS_WORKFLOWS.md §30`; `REQ-RECONCILE-001`).
 */
export function insertPendingCardRequest(
  db: Database.Database,
  row: InsertPendingCardRequest,
): void {
  db.prepare(
    `INSERT INTO checkout_requests
       (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
        clover_approved_confirmed_at, sale_id, status, failure_code,
        resolution_status, resolution_note, created_at, completed_at, failed_at, resolved_at)
     VALUES
       (@requestId, @requestFingerprint, 'CARD', @intendedTotalCents,
        NULL, NULL, 'PENDING_PAYMENT', NULL,
        NULL, NULL, @createdAt, NULL, NULL, NULL)`,
  ).run(row);
}

/**
 * Phase 1 Step B for Card: record the cashier's explicit confirmation that
 * Clover approved and advance `PENDING_PAYMENT → SUBMITTED` (`DATA_MODEL.md §31`).
 * The guard means only a genuine pending Card row is advanced; the caller checks
 * the returned change count and treats `0` as a Step-B failure.
 */
export function confirmCardCheckoutApproval(
  db: Database.Database,
  args: { readonly requestId: string; readonly confirmedAt: string },
): number {
  const info = db
    .prepare(
      `UPDATE checkout_requests
          SET clover_approved_confirmed_at = @confirmedAt, status = 'SUBMITTED'
        WHERE request_id = @requestId
          AND payment_method_snapshot = 'CARD'
          AND status = 'PENDING_PAYMENT'`,
    )
    .run(args);
  return info.changes;
}

/**
 * The cashier chose "Payment Declined / Cancel": best-effort terminal update of
 * the same `PENDING_PAYMENT` row to `COMMIT_FAILED` / `CLOVER_DECLINED`
 * (`POS_WORKFLOWS.md §31`; `DATA_MODEL.md §31B`). Never touches
 * `clover_approved_confirmed_at` (stays `NULL`) or `sale_id`. Excluded from the
 * Reconciliation Queue by `failure_code`.
 */
export function markCardCheckoutDeclined(
  db: Database.Database,
  args: { readonly requestId: string; readonly failedAt: string },
): number {
  const info = db
    .prepare(
      `UPDATE checkout_requests
          SET status = 'COMMIT_FAILED', failure_code = 'CLOVER_DECLINED', failed_at = @failedAt
        WHERE request_id = @requestId
          AND payment_method_snapshot = 'CARD'
          AND status = 'PENDING_PAYMENT'`,
    )
    .run(args);
  return info.changes;
}

export interface MarkCheckoutRequestCompleted {
  readonly requestId: string;
  readonly saleId: string;
  readonly completedAt: string;
  /**
   * When present, also close a Card reconciliation incident on the same row
   * inside the authoritative Phase 2 transaction (`DATA_MODEL.md §31B` step 4):
   * `resolution_status = RESOLVED`, note, and `resolved_at`.
   */
  readonly resolution?: { readonly note: string; readonly resolvedAt: string };
}

/**
 * Phase 2 success: advance the existing row to `COMPLETED`. `failure_code` /
 * `failed_at` are cleared so the schema's
 * `(status = 'COMMIT_FAILED') = (failure_code IS NOT NULL)` invariant holds when
 * a previously `COMMIT_FAILED` row completes on retry (`DATA_MODEL.md §33`,
 * `§34`). When `resolution` is supplied (a Card retry that closes a
 * reconciliation incident), the resolution fields are set in the same statement.
 */
export function markCheckoutRequestCompleted(
  db: Database.Database,
  args: MarkCheckoutRequestCompleted,
): void {
  if (args.resolution) {
    db.prepare(
      `UPDATE checkout_requests
          SET status = 'COMPLETED', sale_id = @saleId, completed_at = @completedAt,
              failure_code = NULL, failed_at = NULL,
              resolution_status = 'RESOLVED', resolution_note = @note, resolved_at = @resolvedAt
        WHERE request_id = @requestId`,
    ).run({
      requestId: args.requestId,
      saleId: args.saleId,
      completedAt: args.completedAt,
      note: args.resolution.note,
      resolvedAt: args.resolution.resolvedAt,
    });
    return;
  }
  db.prepare(
    `UPDATE checkout_requests
        SET status = 'COMPLETED', sale_id = @saleId, completed_at = @completedAt,
            failure_code = NULL, failed_at = NULL
      WHERE request_id = @requestId`,
  ).run({ requestId: args.requestId, saleId: args.saleId, completedAt: args.completedAt });
}

/**
 * Phase 2 failure: best-effort transition to `COMMIT_FAILED`, written in its own
 * tiny transaction *after* Phase 2 rolled back so it survives independently
 * (`DATA_MODEL.md §31` "Phase 2 failure — record the outcome"). The guard
 * (`status IN ('SUBMITTED', 'COMMIT_FAILED')`) means a `PENDING_PAYMENT` Card row
 * (its Step B never committed — that is a stale-pending reconciliation case), a
 * `COMPLETED` row, or a missing row is never mutated here. Card approval evidence
 * in `clover_approved_confirmed_at` is preserved — this statement never clears it.
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
