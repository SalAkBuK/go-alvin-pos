import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type { ReconciliationEntry } from '../../../../shared/reconciliation';
import {
  describeQueueSummary,
  describeReconciliationEntry,
  validateResolutionNote,
} from './reconciliationQueue';

/**
 * Settings → Reconciliation Queue (`DATA_MODEL.md §31A`-`§31B`; `POS_WORKFLOWS.md
 * §35B`; `SUPPORT_DIAGNOSTICS.md §3`; task Phase 2F `§20`-`§22`, `§38`).
 *
 * Surfaces unresolved **Card** incidents only — a Clover charge that may exist
 * with no matching local sale. Marking one resolved requires a note and records
 * only that a person reconciled it; it never creates, edits, or backdates a
 * sale, and never contacts Clover. All access is through the narrow
 * `window.pos.reconciliation.*` surface.
 */

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
}

export function ReconciliationQueueSection() {
  const [entries, setEntries] = useState<readonly ReconciliationEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('The reconciliation queue is unavailable in this context.');
      return;
    }
    try {
      setEntries(await unwrap(api.reconciliation.list()));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onResolve = useCallback(
    async (requestId: string) => {
      const message = validateResolutionNote(notes[requestId] ?? '');
      if (message) {
        setRowError((prev) => ({ ...prev, [requestId]: message }));
        return;
      }
      const api = pos();
      if (!api) {
        setRowError((prev) => ({ ...prev, [requestId]: 'Unavailable in this context.' }));
        return;
      }
      setBusyRow(requestId);
      setNotice(null);
      try {
        await unwrap(
          api.reconciliation.resolve({ requestId, note: (notes[requestId] ?? '').trim() }),
        );
        setNotice(`Entry ${requestId} marked resolved.`);
        setNotes((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
        setRowError((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
        await load();
      } catch (error) {
        setRowError((prev) => ({
          ...prev,
          [requestId]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setBusyRow(null);
      }
    },
    [notes, load],
  );

  return (
    <section className="settings-page reconciliation-queue">
      <h3>Reconciliation Queue</h3>
      <p className="field-hint">
        Card charges whose local sale could not be saved. Check the transaction directly in Clover,
        take any needed action there, then mark the entry resolved with a note. Resolving never
        creates or changes a sale.
      </p>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}
      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}

      {entries !== null && (
        <p className="reconciliation-summary" role="status">
          {describeQueueSummary(entries)}
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className="reconciliation-list">
          {entries.map((entry) => {
            const view = describeReconciliationEntry(entry);
            return (
              <li key={entry.requestId} className="reconciliation-item">
                <dl className="checkout-totals">
                  <div>
                    <dt>Attempt ID</dt>
                    <dd>
                      <code>{view.requestId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{view.statusLabel}</dd>
                  </div>
                  <div>
                    <dt>Failure code</dt>
                    <dd>{view.failureLabel}</dd>
                  </div>
                  <div>
                    <dt>Intended amount</dt>
                    <dd>{view.amount}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{view.createdAt}</dd>
                  </div>
                  <div>
                    <dt>Clover approval confirmed</dt>
                    <dd>{view.cloverApprovalLabel}</dd>
                  </div>
                </dl>
                <label>
                  Resolution note
                  <textarea
                    value={notes[entry.requestId] ?? ''}
                    aria-label={`Resolution note for ${entry.requestId}`}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [entry.requestId]: e.target.value }))
                    }
                  />
                </label>
                {rowError[entry.requestId] && (
                  <p className="product-form-error" role="alert">
                    {rowError[entry.requestId]}
                  </p>
                )}
                <button
                  type="button"
                  disabled={busyRow === entry.requestId}
                  onClick={() => void onResolve(entry.requestId)}
                >
                  {busyRow === entry.requestId ? 'Saving…' : 'Mark resolved'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
