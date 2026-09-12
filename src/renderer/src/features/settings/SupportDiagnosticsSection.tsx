import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BackupDiagnostic,
  CardReconciliationDiagnostic,
  ConnectivityDiagnostic,
  DatabaseDiagnostic,
  DiagnosticSnapshot,
  DiskDiagnostic,
  GoogleDiagnostic,
  HealthStatus,
  PrinterDiagnostic,
  UpdateDiagnostic,
} from '../../../../shared/diagnostics';
import type { IpcResult } from '../../../../shared/products';
import { ActivityHistorySection } from './ActivityHistorySection';
import { SupportActions } from './SupportActions';

export const DIAGNOSTICS_ERROR_MESSAGE =
  'Diagnostics could not be completed. Please try again. If this continues, contact support.';

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

function snapshotFromResult(result: IpcResult<DiagnosticSnapshot>): DiagnosticSnapshot {
  if (result.ok) return result.data;
  throw new Error('diagnostics unavailable');
}

export interface ManualDiagnosticsCallbacks {
  readonly onRunningChange: (running: boolean) => void;
  readonly onSnapshot: (snapshot: DiagnosticSnapshot) => void;
  readonly onError: (message: string | null) => void;
}

/**
 * One guarded manual action shared by the component and its renderer tests.
 * The fixed error text deliberately does not echo a rejected IPC payload or a
 * thrown exception, so a path, stack, secret, or PII cannot become UI copy.
 */
export function createManualDiagnosticsAction(
  invoke: () => Promise<IpcResult<DiagnosticSnapshot>>,
  callbacks: ManualDiagnosticsCallbacks,
): { run: () => Promise<DiagnosticSnapshot | null>; isRunning: () => boolean } {
  let running = false;

  return {
    isRunning: () => running,
    run: async () => {
      if (running) return null;

      running = true;
      callbacks.onRunningChange(true);
      callbacks.onError(null);
      try {
        const snapshot = snapshotFromResult(await invoke());
        callbacks.onSnapshot(snapshot);
        return snapshot;
      } catch {
        callbacks.onError(DIAGNOSTICS_ERROR_MESSAGE);
        return null;
      } finally {
        running = false;
        callbacks.onRunningChange(false);
      }
    },
  };
}

export function healthLabel(status: HealthStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'Healthy';
    case 'WARNING':
      return 'Needs attention';
    case 'CRITICAL':
      return 'Critical';
  }
}

export function formatDiagnosticTimestamp(value: string | null): string {
  if (value === null) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatAvailableBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unavailable';
  const gibibytes = value / 1024 ** 3;
  if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB available`;
  return `${Math.round(value / 1024 ** 2)} MB available`;
}

function OverallHealth({ status }: { readonly status: HealthStatus }) {
  const copy =
    status === 'CRITICAL'
      ? 'Go Phones POS cannot safely verify the local sales database. Do not complete new transactions until this is resolved.'
      : status === 'WARNING'
        ? 'One or more secondary services or safeguards need attention. Review the items below; external-service warnings do not mean local sales data is corrupted.'
        : 'The local sales database and the checked supporting components are healthy.';

  return (
    <div
      className={`diagnostics-overall diagnostics-overall-${status.toLowerCase()}`}
      role={status === 'HEALTHY' ? 'status' : 'alert'}
    >
      <p className="diagnostics-eyebrow">Overall system status</p>
      <h4>{healthLabel(status)}</h4>
      <p>{copy}</p>
    </div>
  );
}

function HealthCard({
  title,
  status,
  children,
}: {
  readonly title: string;
  readonly status: HealthStatus;
  readonly children: React.ReactNode;
}) {
  return (
    <article className={`diagnostics-card diagnostics-card-${status.toLowerCase()}`}>
      <header>
        <h4>{title}</h4>
        <span className={`diagnostics-badge diagnostics-badge-${status.toLowerCase()}`}>
          {healthLabel(status)}
        </span>
      </header>
      {children}
    </article>
  );
}

function DatabaseHealth({ diagnostic }: { readonly diagnostic: DatabaseDiagnostic }) {
  const schema =
    diagnostic.schemaVersion === null
      ? 'Unavailable'
      : diagnostic.schemaVersion === diagnostic.expectedSchemaVersion
        ? `Version ${diagnostic.schemaVersion} (current)`
        : `Version ${diagnostic.schemaVersion}; expected ${diagnostic.expectedSchemaVersion}`;

  return (
    <HealthCard title="Database" status={diagnostic.status}>
      <dl className="diagnostics-details">
        <div>
          <dt>Schema</dt>
          <dd>{schema}</dd>
        </div>
        <div>
          <dt>Manual integrity check</dt>
          <dd>
            {diagnostic.quickCheck === 'NOT_RUN'
              ? 'Run Diagnostics to check'
              : diagnostic.quickCheck === 'OK'
                ? 'Passed'
                : 'Issue found'}
          </dd>
        </div>
      </dl>
      {diagnostic.status === 'CRITICAL' && (
        <div className="diagnostics-critical-copy">
          <strong>Local transaction persistence may not be safe.</strong>
          <p>
            Go Phones POS cannot safely verify the local sales database. Do not complete new
            transactions until this is resolved.
          </p>
          <ul>
            {!diagnostic.open && <li>The local sales database could not be opened safely.</li>}
            {!diagnostic.migrationStateValid && (
              <li>The database schema or migration state could not be verified.</li>
            )}
            {!diagnostic.foreignKeysEnabled && (
              <li>A required database safety check is not enabled.</li>
            )}
            {!diagnostic.criticalTablesAvailable && (
              <li>Required sales database records could not be verified.</li>
            )}
            {diagnostic.quickCheck === 'FAILED' && (
              <li>The manual database integrity check found a problem.</li>
            )}
          </ul>
        </div>
      )}
    </HealthCard>
  );
}

function DiskHealth({ diagnostic }: { readonly diagnostic: DiskDiagnostic }) {
  const explanation = !diagnostic.inspectionAvailable
    ? 'Disk-space checking is unavailable right now.'
    : diagnostic.status === 'CRITICAL'
      ? 'Critically low disk space. Local database writes or backups may fail. Free space before completing new transactions.'
      : diagnostic.status === 'WARNING'
        ? 'Low disk space. Free space soon to keep local sales and backups working safely.'
        : 'There is sufficient free space for normal local operation.';

  return (
    <HealthCard title="Disk" status={diagnostic.status}>
      <p className="diagnostics-value">{formatAvailableBytes(diagnostic.availableBytes)}</p>
      <p>{explanation}</p>
    </HealthCard>
  );
}

function offDeviceDescription(diagnostic: BackupDiagnostic): string {
  const health = diagnostic.offDevice;
  if (health.state === 'NOT_CONFIGURED') return 'Off-device backup not set up';
  if (health.state === 'HEALTHY') return 'Protected with an external/network backup';

  const reason = {
    NEVER_SUCCEEDED: 'No external/network copy has completed yet.',
    UNAVAILABLE: 'The configured external/network location is unavailable.',
    STALE: 'The latest external/network copy is out of date.',
    LAST_COPY_FAILED: 'The latest external/network copy did not complete.',
    VERIFICATION_FAILED: 'The external/network location could not be verified safely.',
  }[health.reason];
  return `External/network backup needs attention. ${reason}`;
}

function BackupHealthCard({ diagnostic }: { readonly diagnostic: BackupDiagnostic }) {
  const localWarning = diagnostic.localOverdue
    ? 'The local recovery backup is overdue. This is a backup warning, not a database-corruption report.'
    : diagnostic.issueCode === 'BACKUP_FAILED'
      ? 'The latest local backup attempt needs attention. Local sales are not reported as corrupted.'
      : null;

  return (
    <HealthCard title="Backups" status={diagnostic.status}>
      <dl className="diagnostics-details">
        <div>
          <dt>Latest local recovery backup</dt>
          <dd>{formatDiagnosticTimestamp(diagnostic.lastSuccessfulLocalAt)}</dd>
        </div>
        <div>
          <dt>Off-device protection</dt>
          <dd>{offDeviceDescription(diagnostic)}</dd>
        </div>
      </dl>
      {localWarning && <p className="diagnostics-warning-copy">{localWarning}</p>}
    </HealthCard>
  );
}

function googleState(diagnostic: GoogleDiagnostic): string {
  if (diagnostic.setupState === 'DISCONNECTED') return 'Disconnected';
  if (diagnostic.setupState === 'SETUP_INCOMPLETE') return 'Setup incomplete';
  return diagnostic.enabled ? 'Ready to sync' : 'Ready to sync (export paused)';
}

function GoogleHealth({ diagnostic }: { readonly diagnostic: GoogleDiagnostic }) {
  const waiting =
    diagnostic.pendingExports + diagnostic.exportingExports + diagnostic.failedExports;
  return (
    <HealthCard title="Google Sheets" status={diagnostic.status}>
      <dl className="diagnostics-details">
        <div>
          <dt>Connection</dt>
          <dd>{googleState(diagnostic)}</dd>
        </div>
        <div>
          <dt>Export queue</dt>
          <dd>
            {diagnostic.pendingExports} pending, {diagnostic.failedExports} failed
          </dd>
        </div>
        <div>
          <dt>Last successful export</dt>
          <dd>{formatDiagnosticTimestamp(diagnostic.lastSuccessfulExportAt)}</dd>
        </div>
      </dl>
      {diagnostic.needsReauthorization && (
        <p className="diagnostics-warning-copy">Google account reauthorization is required.</p>
      )}
      {diagnostic.setupNeedsAttention && (
        <p className="diagnostics-warning-copy">The sales spreadsheet setup needs attention.</p>
      )}
      {waiting > 0 && (
        <p className="diagnostics-warning-copy">
          {waiting} export {waiting === 1 ? 'item is' : 'items are'} waiting or failed. Local sales
          remain safely stored in Go Phones POS.
        </p>
      )}
      {diagnostic.status === 'WARNING' && waiting === 0 && (
        <p className="diagnostics-secondary-copy">
          Google Sheets is a secondary service. Local sales remain safe and checkout can continue.
        </p>
      )}
    </HealthCard>
  );
}

function CardReconciliationHealth({
  diagnostic,
}: {
  readonly diagnostic: CardReconciliationDiagnostic;
}) {
  return (
    <HealthCard title="Card reconciliation" status={diagnostic.status}>
      {diagnostic.unresolvedCount > 0 ? (
        <p className="diagnostics-reconciliation-warning" role="alert">
          Possible card charges need review: {diagnostic.unresolvedCount}
        </p>
      ) : diagnostic.issueCode === 'RECONCILIATION_CHECK_FAILED' ? (
        <p className="diagnostics-warning-copy">
          Go Phones POS could not verify the Card reconciliation count right now.
        </p>
      ) : (
        <p>No unresolved Card reconciliation incidents.</p>
      )}
    </HealthCard>
  );
}

function PrinterHealth({ diagnostic }: { readonly diagnostic: PrinterDiagnostic }) {
  const state = !diagnostic.availabilitySupported
    ? 'Availability checking is unsupported right now'
    : diagnostic.state === 'NOT_CONFIGURED'
      ? 'Not configured'
      : diagnostic.state === 'AVAILABLE'
        ? 'Available'
        : diagnostic.state === 'UNAVAILABLE'
          ? 'Unavailable'
          : 'Unknown';

  return (
    <HealthCard title="Printer" status={diagnostic.status}>
      <dl className="diagnostics-details">
        <div>
          <dt>Status</dt>
          <dd>{state}</dd>
        </div>
        {diagnostic.configuredName && (
          <div>
            <dt>Configured printer</dt>
            <dd>{diagnostic.configuredName}</dd>
          </div>
        )}
        <div>
          <dt>Print history</dt>
          <dd>Not supported by current diagnostics</dd>
        </div>
      </dl>
      {diagnostic.status === 'WARNING' && diagnostic.availabilitySupported && (
        <p className="diagnostics-secondary-copy">
          Printing is secondary. A printer problem does not invalidate a committed sale.
        </p>
      )}
    </HealthCard>
  );
}

function ConnectivityHealth({ diagnostic }: { readonly diagnostic: ConnectivityDiagnostic }) {
  const state = !diagnostic.supported
    ? 'Connectivity checking is unsupported right now'
    : diagnostic.state === 'ONLINE'
      ? 'Online'
      : diagnostic.state === 'OFFLINE'
        ? 'Offline'
        : 'Unknown';
  return (
    <HealthCard title="Connectivity" status={diagnostic.status}>
      <p className="diagnostics-value">{state}</p>
      {diagnostic.supported && diagnostic.state !== 'ONLINE' && (
        <p className="diagnostics-secondary-copy">
          Internet state is informational. Local checkout does not depend on internet access.
        </p>
      )}
    </HealthCard>
  );
}

function updateStateLabel(diagnostic: UpdateDiagnostic): string {
  if (!diagnostic.supported) return 'Update status unavailable';
  switch (diagnostic.state) {
    case 'UP_TO_DATE':
      return 'Up to date';
    case 'AVAILABLE':
      return 'Update available';
    case 'PENDING':
      return 'Update ready to install';
    case 'DEFERRED':
      return 'Update deferred';
    case 'FAILED':
      return 'Update needs attention';
    case 'UNKNOWN':
      return 'Update status unavailable';
  }
}

function UpdateHealth({ diagnostic }: { readonly diagnostic: UpdateDiagnostic }) {
  return (
    <HealthCard title="Updates" status={diagnostic.status}>
      <dl className="diagnostics-details">
        <div>
          <dt>Status</dt>
          <dd>{updateStateLabel(diagnostic)}</dd>
        </div>
        <div>
          <dt>Installed version</dt>
          <dd>{diagnostic.currentVersion}</dd>
        </div>
        {diagnostic.availableVersion && (
          <div>
            <dt>Available version</dt>
            <dd>{diagnostic.availableVersion}</dd>
          </div>
        )}
      </dl>
      {!diagnostic.supported && (
        <p className="diagnostics-secondary-copy">
          Update checking is not available in this version. Go Phones POS continues to work normally
          and does not require an update to keep operating.
        </p>
      )}
      {diagnostic.supported && diagnostic.state === 'FAILED' && (
        <p className="diagnostics-secondary-copy">
          Updating is secondary. Local sales are unaffected while this is resolved.
        </p>
      )}
    </HealthCard>
  );
}

function platformName(platform: string): string {
  if (platform === 'win32') return 'Windows';
  return platform;
}

export interface DiagnosticsSnapshotViewProps {
  readonly snapshot: DiagnosticSnapshot;
  readonly running?: boolean;
  readonly actionError?: string | null;
  readonly onRun?: () => void;
}

export function DiagnosticsSnapshotView({
  snapshot,
  running = false,
  actionError = null,
  onRun,
}: DiagnosticsSnapshotViewProps) {
  const database = snapshot.components.database;
  return (
    <>
      <OverallHealth status={snapshot.overallStatus} />

      <div className="diagnostics-toolbar">
        <button type="button" onClick={onRun} disabled={running}>
          {running ? 'Running diagnostics...' : 'Run Diagnostics'}
        </button>
        <span>
          Last checked {formatDiagnosticTimestamp(snapshot.generatedAt)} (
          {snapshot.mode === 'MANUAL' ? 'manual' : 'summary'})
        </span>
      </div>

      {actionError && (
        <p className="product-form-error diagnostics-action-error" role="alert">
          {actionError}
        </p>
      )}

      <section className="diagnostics-subsection" aria-labelledby="system-information-heading">
        <h4 id="system-information-heading">System information</h4>
        <dl className="diagnostics-system-info">
          <div>
            <dt>Application version</dt>
            <dd>{snapshot.application.version}</dd>
          </div>
          {snapshot.application.buildIdentifier && (
            <div>
              <dt>Build</dt>
              <dd>{snapshot.application.buildIdentifier}</dd>
            </div>
          )}
          {snapshot.application.sourceRevision && (
            <div>
              <dt>Source revision</dt>
              <dd>{snapshot.application.sourceRevision}</dd>
            </div>
          )}
          {snapshot.application.buildTimestamp && (
            <div>
              <dt>Built</dt>
              <dd>{formatDiagnosticTimestamp(snapshot.application.buildTimestamp)}</dd>
            </div>
          )}
          <div>
            <dt>Database schema</dt>
            <dd>{database.schemaVersion === null ? 'Unavailable' : database.schemaVersion}</dd>
          </div>
          <div>
            <dt>Installation ID</dt>
            <dd>{snapshot.application.installationId}</dd>
          </div>
          <div>
            <dt>Operating system</dt>
            <dd>
              {platformName(snapshot.runtime.platform)} {snapshot.runtime.osRelease} (
              {snapshot.runtime.arch})
            </dd>
          </div>
          {snapshot.runtime.electron && (
            <div>
              <dt>Electron</dt>
              <dd>{snapshot.runtime.electron}</dd>
            </div>
          )}
          <div>
            <dt>Runtime</dt>
            <dd>Node {snapshot.runtime.node}</dd>
          </div>
        </dl>
      </section>

      <section className="diagnostics-subsection" aria-labelledby="component-health-heading">
        <h4 id="component-health-heading">Component health</h4>
        <div className="diagnostics-grid">
          <DatabaseHealth diagnostic={database} />
          <DiskHealth diagnostic={snapshot.components.disk} />
          <BackupHealthCard diagnostic={snapshot.components.backup} />
          <GoogleHealth diagnostic={snapshot.components.google} />
          <CardReconciliationHealth diagnostic={snapshot.components.cardReconciliation} />
          <PrinterHealth diagnostic={snapshot.components.printer} />
          <ConnectivityHealth diagnostic={snapshot.components.connectivity} />
          <UpdateHealth diagnostic={snapshot.components.update} />
        </div>
      </section>
    </>
  );
}

export function SupportDiagnosticsSection() {
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = pos();
    if (!api) {
      setError(DIAGNOSTICS_ERROR_MESSAGE);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void api.diagnostics
      .getSummary()
      .then((result) => {
        if (!active) return;
        setSnapshot(snapshotFromResult(result));
        setError(null);
      })
      .catch(() => {
        if (active) setError(DIAGNOSTICS_ERROR_MESSAGE);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const manualAction = useMemo(
    () =>
      createManualDiagnosticsAction(
        async () => {
          const api = pos();
          if (!api) throw new Error('unavailable');
          return api.diagnostics.run();
        },
        {
          onRunningChange: setRunning,
          onSnapshot: setSnapshot,
          onError: setError,
        },
      ),
    [],
  );

  const onRun = useCallback(() => {
    void manualAction.run();
  }, [manualAction]);

  return (
    <section className="settings-page support-diagnostics">
      <h3>Support &amp; Diagnostics</h3>
      <p className="field-hint">
        Current, privacy-safe system health. This page does not show file paths, credentials,
        customer details, or raw technical logs.
      </p>

      {loading && <p role="status">Loading diagnostic status...</p>}
      {!loading && snapshot === null && (
        <>
          <p className="product-form-error diagnostics-action-error" role="alert">
            {error ?? DIAGNOSTICS_ERROR_MESSAGE}
          </p>
          <div className="diagnostics-toolbar">
            <button type="button" onClick={onRun} disabled={running}>
              {running ? 'Running diagnostics...' : 'Run Diagnostics'}
            </button>
          </div>
        </>
      )}
      {snapshot && (
        <DiagnosticsSnapshotView
          snapshot={snapshot}
          running={running}
          actionError={error}
          onRun={onRun}
        />
      )}
      <ActivityHistorySection />
      <SupportActions />
    </section>
  );
}
