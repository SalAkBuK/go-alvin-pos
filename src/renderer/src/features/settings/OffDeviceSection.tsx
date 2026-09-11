import { useCallback, useEffect, useState } from 'react';
import type { BackupHealth, OffDeviceBackupConfiguration } from '../../../../shared/backup';
import type { IpcResult } from '../../../../shared/products';
import {
  describeOffDeviceAttentionReason,
  describeOffDeviceDestination,
  describeOffDeviceError,
  describeOffDeviceStatus,
  offDeviceConfigurationChanged,
} from './offDevice';

/**
 * Settings → External/Network Backup (Phase 2L-C.6 — makes the already-built
 * 2L-C.1 OFF_DEVICE backend reachable from Settings; `REQ-BACKUP-010`,
 * `POS_WORKFLOWS.md §67B`).
 *
 * All work happens through the existing narrow `window.pos.backup.*` surface
 * (`configureOffDevice`, `clearOffDevice`, `offDeviceConfiguration`,
 * `statusVerified`) — this component takes no path, runs no verification
 * itself, and never receives one. The native directory-selection dialog is
 * entirely main-owned; `configureOffDevice()` takes no argument, and a
 * cancelled dialog resolves the unchanged current configuration, which this
 * component detects (`offDeviceConfigurationChanged`) so cancelling never
 * shows a false success notice.
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

export function OffDeviceSection() {
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const [configuration, setConfiguration] = useState<OffDeviceBackupConfiguration | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('External/network backup is unavailable in this context.');
      return;
    }
    try {
      const [verifiedHealth, currentConfiguration] = await Promise.all([
        unwrap(api.backup.statusVerified()),
        unwrap(api.backup.offDeviceConfiguration()),
      ]);
      setHealth(verifiedHealth);
      setConfiguration(currentConfiguration);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSetUpOrChange = useCallback(async () => {
    const api = pos();
    if (!api) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const updated = await unwrap(api.backup.configureOffDevice());
      const changed = offDeviceConfigurationChanged(configuration, updated);
      setConfiguration(updated);
      if (changed) {
        setNotice('External/network backup location saved.');
        setHealth(await unwrap(api.backup.statusVerified()));
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'OFF_DEVICE_CONFIGURE_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      setActionError(describeOffDeviceError(code, message));
    } finally {
      setBusy(false);
    }
  }, [configuration]);

  const onRemove = useCallback(async () => {
    const api = pos();
    if (!api) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const updated = await unwrap(api.backup.clearOffDevice());
      setConfiguration(updated);
      setNotice(
        'External/network backup location removed. Existing backup files were not deleted.',
      );
      setHealth(await unwrap(api.backup.statusVerified()));
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'OFF_DEVICE_CLEAR_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      setActionError(describeOffDeviceError(code, message));
    } finally {
      setBusy(false);
    }
  }, []);

  const destination = describeOffDeviceDestination(configuration);
  const attentionReason = describeOffDeviceAttentionReason(health);
  const configured = configuration?.configured === true;

  return (
    <section className="settings-page off-device-settings">
      <h3>External/Network Backup</h3>
      <p className="field-hint">
        Optional: keep an extra backup copy on a separate USB drive or network location, so your
        data can still be recovered if this computer or its disk is ever lost, stolen, or damaged.
      </p>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      <dl className="settings-current">
        <div>
          <dt>Status</dt>
          <dd>{describeOffDeviceStatus(health)}</dd>
        </div>
        {destination && (
          <div>
            <dt>Location</dt>
            <dd>{destination}</dd>
          </div>
        )}
      </dl>

      {attentionReason && (
        <p className="products-notice" role="status">
          {attentionReason}
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
        {!configured && (
          <button type="button" disabled={busy} onClick={() => void onSetUpOrChange()}>
            {busy ? 'Working…' : 'Set up external/network backup'}
          </button>
        )}
        {configured && (
          <>
            <button type="button" disabled={busy} onClick={() => void onSetUpOrChange()}>
              {busy ? 'Working…' : 'Change backup location'}
            </button>
            <button type="button" disabled={busy} onClick={() => void onRemove()}>
              Remove backup location
            </button>
          </>
        )}
      </div>
    </section>
  );
}
