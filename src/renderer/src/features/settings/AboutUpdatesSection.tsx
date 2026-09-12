import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UpdateInstallResultCode, UpdateServiceSnapshot } from '../../../../shared/update';
import {
  UPDATE_UNAVAILABLE_MESSAGE,
  createManualCheckAction,
  createRestartInstallAction,
  describeInstallResult,
  describeProgress,
  describeUpdateStatus,
  formatLastChecked,
} from './aboutUpdates';

/**
 * Settings → About & Updates (Phase 2N-C —
 * `UPDATE_RELEASE_STRATEGY.md` §34; `REQ-UPDATE-004`/`REQ-UPDATE-005`).
 *
 * Discovery, background download, and normalized state already exist
 * (Phase 2N-A/B, `UpdateService`). This section only displays that state and
 * lets the cashier/owner trigger a manual check or, once `READY`, request
 * `Restart & Update`. The main process alone decides whether a restart is
 * currently safe — this component never inspects maintenance state itself;
 * it only shows whatever denial reason `updates:restart-and-install` returns.
 */

const POLL_INTERVAL_MS = 2000;

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

export interface AboutUpdatesViewProps {
  readonly snapshot: UpdateServiceSnapshot;
  readonly schemaVersion: number | null;
  readonly checking?: boolean;
  readonly checkError?: string | null;
  readonly installBusy?: boolean;
  readonly installResult?: UpdateInstallResultCode | null;
  readonly dismissed?: boolean;
  readonly onCheckNow?: () => void;
  readonly onRestartAndInstall?: () => void;
  readonly onLater?: () => void;
}

export function AboutUpdatesView({
  snapshot,
  schemaVersion,
  checking = false,
  checkError = null,
  installBusy = false,
  installResult = null,
  dismissed = false,
  onCheckNow,
  onRestartAndInstall,
  onLater,
}: AboutUpdatesViewProps) {
  const progress = describeProgress(snapshot);
  const installDenialMessage = installResult ? describeInstallResult(installResult) : null;

  return (
    <>
      <dl className="settings-current about-updates-info">
        <div>
          <dt>Application version</dt>
          <dd>{snapshot.currentVersion}</dd>
        </div>
        <div>
          <dt>Database schema</dt>
          <dd>{schemaVersion === null ? 'Unavailable' : schemaVersion}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{formatLastChecked(snapshot.lastCheckedAt)}</dd>
        </div>
      </dl>

      <p className="about-updates-status" role="status">
        {describeUpdateStatus(snapshot)}
      </p>
      {progress && <p className="about-updates-progress">{progress}</p>}
      {snapshot.availableVersion && snapshot.state !== 'READY' && (
        <p className="field-hint">Available version: {snapshot.availableVersion}</p>
      )}

      {checkError && (
        <p className="product-form-error" role="alert">
          {checkError}
        </p>
      )}
      {installDenialMessage && (
        <p className="product-form-error about-updates-install-denied" role="alert">
          {installDenialMessage}
        </p>
      )}

      <div className="diagnostics-toolbar">
        <button type="button" onClick={onCheckNow} disabled={checking || installBusy}>
          {checking ? 'Checking…' : 'Check for Updates'}
        </button>
      </div>

      {snapshot.state === 'READY' && !dismissed && (
        <div className="product-form-actions about-updates-ready-actions">
          <button type="button" onClick={onLater} disabled={installBusy}>
            Later
          </button>
          <button type="button" onClick={onRestartAndInstall} disabled={installBusy}>
            {installBusy ? 'Restarting…' : 'Restart & Update'}
          </button>
        </div>
      )}
      {snapshot.state === 'READY' && dismissed && (
        <div className="product-form-actions about-updates-ready-actions">
          <button type="button" onClick={onRestartAndInstall} disabled={installBusy}>
            {installBusy ? 'Restarting…' : 'Restart & Update'}
          </button>
        </div>
      )}
    </>
  );
}

export function AboutUpdatesSection() {
  const [snapshot, setSnapshot] = useState<UpdateServiceSnapshot | null>(null);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installResult, setInstallResult] = useState<UpdateInstallResultCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const pollInFlight = useRef(false);

  useEffect(() => {
    const api = pos();
    if (!api) {
      setLoadError(UPDATE_UNAVAILABLE_MESSAGE);
      setLoading(false);
      return;
    }
    let active = true;

    void api.diagnostics
      .databaseStatus()
      .then((status) => {
        if (active) setSchemaVersion(status.schemaVersion);
      })
      .catch(() => {
        /* schema version is a nice-to-have display field; never blocks the section */
      });

    const poll = (): void => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void api.updates
        .getStatus()
        .then((result) => {
          if (active && result.ok) {
            setSnapshot(result.data);
            setLoadError(null);
          } else if (active && !result.ok) {
            setLoadError(UPDATE_UNAVAILABLE_MESSAGE);
          }
        })
        .catch(() => {
          if (active) setLoadError(UPDATE_UNAVAILABLE_MESSAGE);
        })
        .finally(() => {
          pollInFlight.current = false;
          if (active) setLoading(false);
        });
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const manualCheck = useMemo(
    () =>
      createManualCheckAction(
        async () => {
          const api = pos();
          if (!api) throw new Error('unavailable');
          return api.updates.checkNow();
        },
        {
          onCheckingChange: setChecking,
          onSnapshot: setSnapshot,
          onError: setCheckError,
        },
      ),
    [],
  );

  const restartInstall = useMemo(
    () =>
      createRestartInstallAction(
        async () => {
          const api = pos();
          if (!api) throw new Error('unavailable');
          return api.updates.restartAndInstall();
        },
        {
          onBusyChange: setInstallBusy,
          onResult: setInstallResult,
        },
      ),
    [],
  );

  const onCheckNow = useCallback(() => {
    void manualCheck.run();
  }, [manualCheck]);

  const onRestartAndInstall = useCallback(() => {
    void restartInstall.run();
  }, [restartInstall]);

  const onLater = useCallback(() => {
    setDismissed(true);
  }, []);

  return (
    <section className="settings-page about-updates">
      <h3>About &amp; Updates</h3>

      {loading && <p role="status">Loading update status…</p>}
      {!loading && loadError && !snapshot && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}
      {snapshot && (
        <AboutUpdatesView
          snapshot={snapshot}
          schemaVersion={schemaVersion}
          checking={checking}
          checkError={checkError}
          installBusy={installBusy}
          installResult={installResult}
          dismissed={dismissed}
          onCheckNow={onCheckNow}
          onRestartAndInstall={onRestartAndInstall}
          onLater={onLater}
        />
      )}
    </section>
  );
}
