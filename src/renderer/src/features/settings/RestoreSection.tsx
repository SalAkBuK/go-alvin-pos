import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type {
  NewerDataLoss,
  RestoreCandidate,
  RestoreCandidateInspection,
  RestoreOutcome,
} from '../../../../shared/restore';
import {
  describeCandidate,
  describeGenericRestoreWarning,
  describeIncompatible,
  describeNewerDataLoss,
  describeRestoreError,
  formatRestoreTimestamp,
  mergeBrowsedCandidate,
} from './restore';

/**
 * Settings → Restore Database (2L-B final corrections — Policy 1).
 *
 * Lists app-managed backups by opaque id, previews one, then runs the guarded
 * two-stage restore. The FIRST guarded attempt always comes back
 * `CONFIRMATION_REQUIRED` — there is no silent whole-database swap. When newer
 * completed sales would be lost, the stronger Variant A warning names the
 * exact count/date range (`Cancel` / `Restore Anyway`); otherwise the generic
 * Variant B warning explains that the operation replaces the whole database
 * (`Cancel` / `Restore Database`). Either way `Cancel` is first and the
 * destructive action is never the default-focused control. The renderer never
 * sees a filesystem path.
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
  const err = new Error(result.error.message);
  (err as { code?: string }).code = result.error.code;
  throw err;
}

export function RestoreSection() {
  const [candidates, setCandidates] = useState<readonly RestoreCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<RestoreCandidateInspection | null>(null);
  const [pendingLoss, setPendingLoss] = useState<{
    loss: NewerDataLoss | null;
    token: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Restore is unavailable in this context.');
      return;
    }
    try {
      setCandidates(await unwrap(api.backup.listRestoreCandidates()));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = useCallback(async (backupId: string) => {
    const api = pos();
    if (!api) return;
    setSelectedId(backupId);
    setInspection(null);
    setPendingLoss(null);
    setNotice(null);
    setActionError(null);
    setBusy(true);
    try {
      setInspection(await unwrap(api.backup.inspectRestoreCandidate({ backupId })));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const onBrowse = useCallback(async () => {
    const api = pos();
    if (!api) return;
    setBrowseError(null);
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const browsed = await unwrap(api.backup.browseRestoreCandidate());
      if (browsed === null) {
        // Cancelled dialog — no state change.
        return;
      }
      setCandidates((prev) => mergeBrowsedCandidate(prev, browsed));
      await onSelect(browsed.backupId);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'BROWSE_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      setBrowseError(describeRestoreError(code, message));
    } finally {
      setBusy(false);
    }
  }, [onSelect]);

  const runRestore = useCallback(
    async (confirmationToken?: string) => {
      const api = pos();
      if (!api || !selectedId) return;
      setBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        const outcome: RestoreOutcome = await unwrap(
          api.backup.restore(
            confirmationToken === undefined
              ? { backupId: selectedId }
              : { backupId: selectedId, confirmationToken },
          ),
        );
        if (outcome.outcome === 'CONFIRMATION_REQUIRED') {
          setPendingLoss({ loss: outcome.newerData, token: outcome.confirmationToken });
          return;
        }
        setPendingLoss(null);
        setInspection(null);
        setSelectedId(null);
        setNotice(
          `Restore complete. The database now matches the backup from ${formatRestoreTimestamp(
            outcome.restoredFromCreatedAt,
          )}. Sales are available again.`,
        );
        await load();
      } catch (error) {
        setPendingLoss(null);
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [selectedId, load],
  );

  return (
    <section className="settings-page restore-settings">
      <h3>Restore Database</h3>
      <p className="field-hint">
        Restoring replaces your <strong>entire</strong> current database with the selected backup.
        Sales are unavailable while the restore runs. A recovery copy of your current data is kept
        automatically.
      </p>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      <div className="product-form-actions">
        <button type="button" disabled={busy} onClick={() => void onBrowse()}>
          Browse for a backup file…
        </button>
      </div>

      {browseError && (
        <p className="product-form-error" role="alert">
          {browseError}
        </p>
      )}

      {candidates !== null && candidates.length === 0 && (
        <p className="field-hint">No backups are available to restore from yet.</p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <ul className="restore-candidate-list">
          {candidates.map((c) => (
            <li key={c.backupId}>
              <span>{describeCandidate(c)}</span>
              <button
                type="button"
                disabled={busy}
                aria-current={selectedId === c.backupId}
                onClick={() => void onSelect(c.backupId)}
              >
                {selectedId === c.backupId ? 'Selected' : 'Inspect'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {actionError && (
        <p className="product-form-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}

      {inspection && !pendingLoss && (
        <div className="restore-inspection">
          <dl className="settings-current">
            <div>
              <dt>Backup</dt>
              <dd>{describeCandidate(inspection.candidate)}</dd>
            </div>
          </dl>
          {!inspection.compatible && inspection.incompatibleReason && (
            <p className="product-form-error" role="alert">
              {describeIncompatible(inspection.incompatibleReason)}
            </p>
          )}
          {inspection.compatible && inspection.newerData && (
            <p className="products-notice" role="status">
              {describeNewerDataLoss(inspection.newerData)}
            </p>
          )}
          {inspection.compatible && (
            <div className="product-form-actions">
              <button type="button" disabled={busy} onClick={() => void runRestore()}>
                {busy ? 'Working…' : 'Restore Database'}
              </button>
            </div>
          )}
        </div>
      )}

      {pendingLoss && (
        <div className="restore-confirm" role="alertdialog" aria-label="Confirm database restore">
          <p className="product-form-error">
            {pendingLoss.loss
              ? describeNewerDataLoss(pendingLoss.loss)
              : describeGenericRestoreWarning()}
          </p>
          <div className="product-form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPendingLoss(null);
                setNotice('Restore cancelled. Your current data is unchanged.');
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void runRestore(pendingLoss.token)}
            >
              {busy ? 'Restoring…' : pendingLoss.loss ? 'Restore Anyway' : 'Restore Database'}
            </button>
          </div>
        </div>
      )}

      <div className="product-form-actions">
        <button type="button" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
    </section>
  );
}
