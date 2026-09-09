import type Database from 'better-sqlite3';
import type { ReconciliationEntry, ResolveReconciliationInput } from '../../shared/reconciliation';
import {
  RECONCILIATION_STALE_MINUTES,
  RESOLUTION_NOTE_MAX_LENGTH,
} from '../../shared/reconciliation';
import { AppError, appErrors } from '../shared/appError';
import {
  findReconciliationRow,
  listUnresolvedCardIncidents,
  markReconciliationResolved,
  reconciliationRowToEntry,
} from './reconciliationRepository';

/**
 * The local Reconciliation Queue (`DATA_MODEL.md §31A`-`§31B`; `POS_WORKFLOWS.md
 * §35B`; `REQ-RECONCILE-004`; task Phase 2F `§20`-`§22`).
 *
 * It surfaces unresolved **Card** incidents only and lets a person mark one
 * resolved with a required note. Resolution has NO business side effects — no
 * sale, inventory, payment, backdating, or Clover call. Staleness is judged at
 * query time against an injected clock; no background service is needed.
 */

export interface ReconciliationServiceDeps {
  readonly db: Database.Database;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface ReconciliationService {
  list(): readonly ReconciliationEntry[];
  resolve(raw: unknown): ReconciliationEntry;
}

/** `nowIso` minus the staleness window, as an ISO-8601 UTC string. */
export function staleCutoff(nowIso: string, minutes = RECONCILIATION_STALE_MINUTES): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error('reconciliation clock returned an invalid timestamp');
  }
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function validateResolveInput(raw: unknown): ResolveReconciliationInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw appErrors.validation('The resolution request must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((k) => k !== 'requestId' && k !== 'note');
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The resolution request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }
  const requestId = record['requestId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw appErrors.validation('The reconciliation entry is missing.');
  }
  const noteRaw = record['note'];
  if (typeof noteRaw !== 'string') {
    throw appErrors.validation('Enter a note describing how this was reconciled.');
  }
  const note = noteRaw.trim();
  if (note.length === 0) {
    throw appErrors.validation('Enter a note describing how this was reconciled.');
  }
  if (note.length > RESOLUTION_NOTE_MAX_LENGTH) {
    throw appErrors.validation(
      `The resolution note must be ${RESOLUTION_NOTE_MAX_LENGTH} characters or fewer.`,
    );
  }
  return { requestId: requestId.trim(), note };
}

export function createReconciliationService(
  deps: ReconciliationServiceDeps,
): ReconciliationService {
  const { db } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    list(): readonly ReconciliationEntry[] {
      return listUnresolvedCardIncidents(db, staleCutoff(now()));
    },

    resolve(raw: unknown): ReconciliationEntry {
      const { requestId, note } = validateResolveInput(raw);
      const resolvedAt = now();

      return db
        .transaction((): ReconciliationEntry => {
          const row = findReconciliationRow(db, requestId);
          if (!row) {
            throw appErrors.checkoutRequestInvalid();
          }
          if (row.resolution_status === 'RESOLVED') {
            throw appErrors.validation('This reconciliation entry is already resolved.');
          }
          // Only a genuine incident may be resolved: a COMMIT_FAILED row that is
          // not a plain decline, or a PENDING_PAYMENT row past the staleness
          // window (`DATA_MODEL.md §31B`).
          const isIncident =
            (row.status === 'COMMIT_FAILED' && row.failure_code !== 'CLOVER_DECLINED') ||
            (row.status === 'PENDING_PAYMENT' && row.created_at <= staleCutoff(resolvedAt));
          if (!isIncident) {
            throw appErrors.checkoutRequestInvalid();
          }

          const changed = markReconciliationResolved(db, { requestId, note, resolvedAt });
          if (changed !== 1) {
            throw appErrors.checkoutRequestInvalid();
          }
          const updated = findReconciliationRow(db, requestId);
          if (!updated) {
            throw new AppError(
              'INTERNAL',
              'The reconciliation entry could not be read back after resolving it.',
            );
          }
          return reconciliationRowToEntry(updated);
        })
        .immediate();
    },
  };
}
