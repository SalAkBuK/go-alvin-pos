import { useCallback, useEffect, useState } from 'react';
import type { BackupHealth, ManualBackupResult } from '../../../../shared/backup';
import type { IpcResult } from '../../../../shared/products';
import {
  LOCAL_PROTECTION_TEXT,
  describeAutomaticSchedule,
  describeBackupWarning,
  describeLastAutomatic,
  formatBackupTimestamp,
} from './backup';

/**
 * Settings → Backup & Restore (Phase 2L — backup-creation half;
 * `REQ-BACKUP-001`, `REQ-BACKUP-007`, `REQ-BACKUP-010`; `POS_WORKFLOWS.md §65`,
 * `§96`).
 *
 * Shows backup health (last automatic backup, protection statement, any overdue
 * / failure warning) and an owner `Back Up Now` button. All work happens in the
 * trusted main process through the narrow `window.pos.backup.*` surface — the
 * renderer never sees a path, a SQLite command, or backup metadata ids.
 *
 * Restore lives in the sibling `<RestoreSection>` (Phase 2L-B/2L-C), and the
 * optional off-device destination (`REQ-BACKUP-010`; `POS_WORKFLOWS.md §67B`)
 * lives in the sibling `<OffDeviceSection>` (Phase 2L-C.6) — both rendered
 * alongside this one in `SettingsPage`.
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

export function BackupSection() {
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Backup & Restore is unavailable in this context.');
      return;
    }
    try {
      setHealth(await unwrap(api.backup.status()));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onBackUpNow = useCallback(async () => {
    const api = pos();
    if (!api) {
      setActionError('Backup & Restore is unavailable in this context.');
      return;
    }
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      const result: ManualBackupResult = await unwrap(api.backup.createManual());
      setNotice(
        `Backup completed at ${formatBackupTimestamp(result.completedAt)} (${Math.max(
          1,
          Math.round(result.sizeBytes / 1024),
        )} KB). It is stored on this computer.`,
      );
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const warning = describeBackupWarning(health);

  return (
    <section className="settings-page backup-settings">
      <h3>Backup &amp; Restore</h3>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      <dl className="settings-current">
        <div>
          <dt>Last automatic backup</dt>
          <dd>{describeLastAutomatic(health)}</dd>
        </div>
        <div>
          <dt>Automatic backup</dt>
          <dd>{describeAutomaticSchedule(health)}</dd>
        </div>
        <div>
          <dt>Protection</dt>
          <dd>{LOCAL_PROTECTION_TEXT}</dd>
        </div>
      </dl>

      {warning && (
        <p className="products-notice" role="status">
          {warning}
        </p>
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

      <div className="product-form-actions">
        <button type="button" onClick={() => void onBackUpNow()} disabled={busy}>
          {busy ? 'Backing up…' : 'Back Up Now'}
        </button>
      </div>
    </section>
  );
}
