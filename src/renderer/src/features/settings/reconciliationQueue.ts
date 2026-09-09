import type { ReconciliationEntry } from '../../../../shared/reconciliation';
import { RESOLUTION_NOTE_MAX_LENGTH } from '../../../../shared/reconciliation';
import { formatCents } from '../../../../shared/money';

/**
 * Pure, React-free shaping + validation for the Settings → Reconciliation Queue
 * section (`DATA_MODEL.md §31B`; `POS_WORKFLOWS.md §35B`; task Phase 2F `§21`,
 * `§22`, `§38`). No jsdom in the renderer suites, so the display strings and the
 * resolve-note gate are unit-tested here directly.
 *
 * Only durable local evidence is shown — never fabricated Clover data (no
 * terminal transaction id, card number, or authorization code exists in V1).
 */

export interface ReconciliationRowView {
  readonly requestId: string;
  readonly statusLabel: string;
  readonly failureLabel: string;
  readonly amount: string;
  readonly createdAt: string;
  readonly cloverApprovalLabel: string;
}

export function describeReconciliationEntry(entry: ReconciliationEntry): ReconciliationRowView {
  return {
    requestId: entry.requestId,
    statusLabel:
      entry.status === 'PENDING_PAYMENT' ? 'Awaiting confirmation (stale)' : 'Local save failed',
    failureLabel: entry.failureCode ?? '—',
    amount: formatCents(entry.intendedTotalCents),
    createdAt: entry.createdAt,
    cloverApprovalLabel: entry.cloverApprovedConfirmedAt ?? 'Not confirmed in Go Phones POS',
  };
}

/** The exact gate `ReconciliationQueueSection` runs before calling `resolve`. */
export function validateResolutionNote(raw: string): string | null {
  const note = raw.trim();
  if (note.length === 0) {
    return 'Enter a note describing how this was reconciled (e.g. what you checked or did in Clover).';
  }
  if (note.length > RESOLUTION_NOTE_MAX_LENGTH) {
    return `The note must be ${RESOLUTION_NOTE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function describeQueueSummary(entries: readonly ReconciliationEntry[]): string {
  if (entries.length === 0) {
    return 'No unresolved card charges. Any Clover charge whose local sale failed would appear here.';
  }
  return entries.length === 1
    ? '1 unresolved card charge needs review.'
    : `${entries.length} unresolved card charges need review.`;
}
