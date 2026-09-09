/**
 * Shared Reconciliation Queue contract (Phase 2F).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY reconciliation shapes that cross the IPC boundary.
 *
 * SCOPE: surfacing unresolved *Card* checkout incidents and marking one resolved
 * with a required note (`DATA_MODEL.md §31A`-`§31B`; `POS_WORKFLOWS.md §35B`;
 * `REQ-RECONCILE-004`). No Clover data is ever represented here — there is no
 * terminal transaction id, card number, or authorization code in V1.
 */

/** V1 default staleness window for a `PENDING_PAYMENT` Card row (`ARCHITECTURE.md §49A`). */
export const RECONCILIATION_STALE_MINUTES = 5;

/** Trimmed lower/upper bounds for a manual resolution note. */
export const RESOLUTION_NOTE_MIN_LENGTH = 1;
export const RESOLUTION_NOTE_MAX_LENGTH = 1000;

/**
 * One unresolved Card incident. Every field is durable local evidence from the
 * `checkout_requests` row — never inferred Clover state.
 *
 *  - `COMMIT_FAILED` (with a `failureCode` other than `CLOVER_DECLINED`): Phase 2
 *    failed, or the Step B confirmation write failed and a best-effort
 *    `COMMIT_FAILED` transition succeeded.
 *  - `PENDING_PAYMENT` (older than the staleness window): the confirmation write
 *    itself could not be recorded (`DATA_MODEL.md §31A` Case 2).
 */
export interface ReconciliationEntry {
  readonly requestId: string;
  readonly status: 'PENDING_PAYMENT' | 'COMMIT_FAILED';
  readonly failureCode: string | null;
  readonly intendedTotalCents: number;
  readonly createdAt: string;
  /** Set only once Phase 1 Step B durably committed; `null` for a stale pending row. */
  readonly cloverApprovedConfirmedAt: string | null;
  readonly resolutionStatus: 'UNRESOLVED' | 'RESOLVED';
}

/** `reconciliation:resolve` payload. */
export interface ResolveReconciliationInput {
  readonly requestId: string;
  readonly note: string;
}
