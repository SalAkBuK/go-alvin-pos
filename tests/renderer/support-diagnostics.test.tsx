import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_ERROR_MESSAGE,
  DiagnosticsSnapshotView,
  SupportDiagnosticsSection,
  createManualDiagnosticsAction,
} from '../../src/renderer/src/features/settings/SupportDiagnosticsSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
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
} from '../../src/shared/diagnostics';
import type { IpcResult } from '../../src/shared/products';

const database: DatabaseDiagnostic = {
  status: 'HEALTHY',
  open: true,
  schemaVersion: 1,
  expectedSchemaVersion: 1,
  migrationStateValid: true,
  foreignKeysEnabled: true,
  criticalTablesAvailable: true,
  quickCheck: 'NOT_RUN',
  issueCodes: [],
};

const disk: DiskDiagnostic = {
  status: 'HEALTHY',
  inspectionAvailable: true,
  availableBytes: 8 * 1024 ** 3,
  warningBelowBytes: 2 * 1024 ** 3,
  criticalBelowBytes: 500 * 1024 ** 2,
  issueCode: null,
};

const backup: BackupDiagnostic = {
  status: 'HEALTHY',
  lastSuccessfulLocalAt: '2026-09-12T08:30:00.000Z',
  lastLocalFailure: null,
  localOverdue: false,
  offDevice: { state: 'NOT_CONFIGURED' },
  issueCode: null,
};

const google: GoogleDiagnostic = {
  status: 'HEALTHY',
  enabled: true,
  setupState: 'READY',
  needsReauthorization: false,
  setupNeedsAttention: false,
  pendingExports: 0,
  exportingExports: 0,
  failedExports: 0,
  lastSuccessfulExportAt: '2026-09-12T09:00:00.000Z',
  issueCode: null,
};

const cardReconciliation: CardReconciliationDiagnostic = {
  status: 'HEALTHY',
  unresolvedCount: 0,
  issueCode: null,
};

const printer: PrinterDiagnostic = {
  status: 'HEALTHY',
  state: 'AVAILABLE',
  configuredName: 'Receipt Printer',
  availabilitySupported: true,
  printHistorySupported: false,
  lastSuccessfulPrintAt: null,
  lastFailedPrintAt: null,
  issueCode: null,
};

const connectivity: ConnectivityDiagnostic = {
  status: 'HEALTHY',
  supported: true,
  state: 'ONLINE',
  issueCode: null,
};

interface SnapshotOverrides {
  readonly overallStatus?: HealthStatus;
  readonly mode?: DiagnosticSnapshot['mode'];
  readonly database?: Partial<DatabaseDiagnostic>;
  readonly disk?: Partial<DiskDiagnostic>;
  readonly backup?: Partial<BackupDiagnostic>;
  readonly google?: Partial<GoogleDiagnostic>;
  readonly cardReconciliation?: Partial<CardReconciliationDiagnostic>;
  readonly printer?: Partial<PrinterDiagnostic>;
  readonly connectivity?: Partial<ConnectivityDiagnostic>;
}

function snapshot(overrides: SnapshotOverrides = {}): DiagnosticSnapshot {
  return {
    generatedAt: '2026-09-12T10:00:00.000Z',
    mode: overrides.mode ?? 'SUMMARY',
    application: {
      version: '1.2.3',
      buildIdentifier: 'build-abc123',
      installationId: 'INST-12345678',
    },
    runtime: {
      platform: 'win32',
      osRelease: '10.0.26100',
      arch: 'x64',
      electron: '44.2.0',
      node: '24.0.0',
    },
    overallStatus: overrides.overallStatus ?? 'HEALTHY',
    components: {
      database: { ...database, ...overrides.database },
      disk: { ...disk, ...overrides.disk },
      backup: { ...backup, ...overrides.backup },
      google: { ...google, ...overrides.google },
      cardReconciliation: { ...cardReconciliation, ...overrides.cardReconciliation },
      printer: { ...printer, ...overrides.printer },
      connectivity: { ...connectivity, ...overrides.connectivity },
    },
  };
}

function markup(value: DiagnosticSnapshot, running = false, error: string | null = null): string {
  return renderToStaticMarkup(
    <DiagnosticsSnapshotView snapshot={value} running={running} actionError={error} />,
  );
}

describe('Settings Support & Diagnostics location and overall state', () => {
  it('renders the D2 support actions plus the F1 Recent Activity section in Settings, without a crash-history UI', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Support &amp; Diagnostics');
    expect(html).toContain('Export Support Bundle');
    expect(html).toContain('Report a Problem');
    expect(html).toContain('Recent Activity');
    expect(html).not.toContain('Crash history');
  });

  it('has an honest loading first render', () => {
    const html = renderToStaticMarkup(<SupportDiagnosticsSection />);
    expect(html).toContain('Loading diagnostic status');
    expect(html).toContain('privacy-safe system health');
  });

  it('renders HEALTHY in plain language with safe system metadata', () => {
    const html = markup(snapshot());
    expect(html).toContain('Overall system status');
    expect(html).toContain('Healthy');
    expect(html).toContain('Application version');
    expect(html).toContain('build-abc123');
    expect(html).toContain('INST-12345678');
    expect(html).toContain('Windows 10.0.26100');
    expect(html).toContain('Node 24.0.0');
  });

  it('renders WARNING as Needs attention and keeps it distinct from corruption', () => {
    const html = markup(snapshot({ overallStatus: 'WARNING' }));
    expect(html).toContain('Needs attention');
    expect(html).toContain('external-service warnings do not mean local sales data is corrupted');
    expect(html).not.toContain('Local transaction persistence may not be safe');
  });

  it('renders CRITICAL with the required stop-transacting database wording', () => {
    const html = markup(
      snapshot({
        overallStatus: 'CRITICAL',
        database: {
          status: 'CRITICAL',
          open: false,
          schemaVersion: null,
          migrationStateValid: false,
          foreignKeysEnabled: false,
          criticalTablesAvailable: false,
        },
      }),
    );
    expect(html).toContain('Critical');
    expect(html).toContain('Local transaction persistence may not be safe');
    expect(html).toContain('Do not complete new transactions until this is resolved');
    expect(html).toContain('could not be opened safely');
    expect(html).toContain('schema or migration state could not be verified');
    expect(html).toContain('required database safety check is not enabled');
    expect(html).toContain('Required sales database records could not be verified');
  });
});

describe('component health presentation', () => {
  it('renders low disk and critical disk as distinct states', () => {
    const low = markup(
      snapshot({
        overallStatus: 'WARNING',
        disk: {
          status: 'WARNING',
          availableBytes: 1400 * 1024 ** 2,
          issueCode: 'DISK_SPACE_LOW',
        },
      }),
    );
    expect(low).toContain('Low disk space');
    expect(low).toContain('1.4 GB available');
    expect(low).not.toContain('Critically low disk space');

    const critical = markup(
      snapshot({
        overallStatus: 'CRITICAL',
        disk: {
          status: 'CRITICAL',
          availableBytes: 300 * 1024 ** 2,
          issueCode: 'DISK_SPACE_CRITICAL',
        },
      }),
    );
    expect(critical).toContain('Critically low disk space');
    expect(critical).toContain('300 MB available');
    expect(critical).toContain('local sales database');
  });

  it('renders healthy and overdue local recovery backup states', () => {
    const healthy = markup(snapshot());
    expect(healthy).toContain('Latest local recovery backup');
    expect(healthy).toContain('2026-09-12 08:30 UTC');
    expect(healthy).not.toContain('local recovery backup is overdue');

    const overdue = markup(
      snapshot({
        overallStatus: 'WARNING',
        backup: { status: 'WARNING', localOverdue: true, issueCode: 'BACKUP_OVERDUE' },
      }),
    );
    expect(overdue).toContain('local recovery backup is overdue');
    expect(overdue).toContain('not a database-corruption report');
  });

  it('renders all three off-device protection states using canonical safe wording', () => {
    expect(markup(snapshot())).toContain('Off-device backup not set up');
    expect(
      markup(
        snapshot({
          backup: {
            offDevice: {
              state: 'HEALTHY',
              lastSuccessfulAt: '2026-09-12T08:30:00.000Z',
              destinationKind: 'USB',
            },
          },
        }),
      ),
    ).toContain('Protected with an external/network backup');
    expect(
      markup(
        snapshot({
          overallStatus: 'WARNING',
          backup: {
            status: 'WARNING',
            issueCode: 'OFF_DEVICE_ATTENTION',
            offDevice: {
              state: 'ATTENTION',
              reason: 'VERIFICATION_FAILED',
              lastSuccessfulAt: null,
              destinationKind: null,
            },
          },
        }),
      ),
    ).toContain('External/network backup needs attention');
  });

  it.each([
    ['DISCONNECTED', 'Disconnected'],
    ['SETUP_INCOMPLETE', 'Setup incomplete'],
    ['READY', 'Ready to sync'],
  ] as const)('renders Google %s as %s', (setupState, expected) => {
    const warning = setupState === 'READY' ? 'HEALTHY' : 'WARNING';
    const html = markup(
      snapshot({
        overallStatus: warning,
        google: {
          status: warning,
          setupState,
          setupNeedsAttention: setupState === 'SETUP_INCOMPLETE',
          issueCode:
            setupState === 'DISCONNECTED'
              ? 'GOOGLE_DISCONNECTED'
              : setupState === 'SETUP_INCOMPLETE'
                ? 'GOOGLE_SETUP_INCOMPLETE'
                : null,
        },
      }),
    );
    expect(html).toContain(expected);
  });

  it('keeps a Google backlog warning secondary and explicitly says local sales are safe', () => {
    const html = markup(
      snapshot({
        overallStatus: 'WARNING',
        google: {
          status: 'WARNING',
          pendingExports: 3,
          failedExports: 1,
          issueCode: 'GOOGLE_EXPORT_BACKLOG',
        },
      }),
    );
    expect(html).toContain('3 pending, 1 failed');
    expect(html).toContain('Local sales remain safely stored');
    expect(html).not.toContain('Local transaction persistence may not be safe');
  });

  it('prominently renders unresolved Card incidents, but no warning when the count is zero', () => {
    const warning = markup(
      snapshot({
        overallStatus: 'WARNING',
        cardReconciliation: {
          status: 'WARNING',
          unresolvedCount: 2,
          issueCode: 'CARD_RECONCILIATION_REQUIRED',
        },
      }),
    );
    expect(warning).toContain('Possible card charges need review: 2');
    expect(warning).toContain('role="alert"');

    const none = markup(snapshot());
    expect(none).toContain('No unresolved Card reconciliation incidents');
    expect(none).not.toContain('Possible card charges need review');
  });

  it('keeps printer unavailability a warning and handles unsupported device checks honestly', () => {
    const unavailable = markup(
      snapshot({
        overallStatus: 'WARNING',
        printer: {
          status: 'WARNING',
          state: 'UNAVAILABLE',
          issueCode: 'PRINTER_UNAVAILABLE',
        },
      }),
    );
    expect(unavailable).toContain('Unavailable');
    expect(unavailable).toContain('does not invalidate a committed sale');
    expect(unavailable).not.toContain('Local transaction persistence may not be safe');

    const unsupported = markup(
      snapshot({
        overallStatus: 'WARNING',
        printer: {
          status: 'WARNING',
          state: 'UNKNOWN',
          configuredName: null,
          availabilitySupported: false,
          issueCode: 'PRINTER_INSPECTION_FAILED',
        },
        connectivity: { supported: false, state: 'UNKNOWN' },
      }),
    );
    expect(unsupported).toContain('Availability checking is unsupported right now');
    expect(unsupported).toContain('Print history');
    expect(unsupported).toContain('Not supported by current diagnostics');
    expect(unsupported).toContain('Connectivity checking is unsupported right now');
  });
});

describe('Run Diagnostics behavior and renderer safety', () => {
  it('renders a running state and disables duplicate submissions in the view', () => {
    const html = markup(snapshot(), true);
    expect(html).toContain('Running diagnostics...');
    expect(html).toContain('disabled=""');
  });

  it('invokes the existing API once, guards duplicate clicks, and publishes the refreshed result', async () => {
    let resolve!: (value: IpcResult<DiagnosticSnapshot>) => void;
    const pending = new Promise<IpcResult<DiagnosticSnapshot>>((done) => {
      resolve = done;
    });
    const invoke = vi.fn(() => pending);
    const runningChanges: boolean[] = [];
    const snapshots: DiagnosticSnapshot[] = [];
    const errors: Array<string | null> = [];
    const action = createManualDiagnosticsAction(invoke, {
      onRunningChange: (value) => runningChanges.push(value),
      onSnapshot: (value) => snapshots.push(value),
      onError: (value) => errors.push(value),
    });

    const first = action.run();
    const duplicate = action.run();
    expect(action.isRunning()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBeNull();

    const refreshed = snapshot({ mode: 'MANUAL', overallStatus: 'WARNING' });
    resolve({ ok: true, data: refreshed });
    await expect(first).resolves.toBe(refreshed);
    expect(action.isRunning()).toBe(false);
    expect(runningChanges).toEqual([true, false]);
    expect(snapshots).toEqual([refreshed]);
    expect(errors).toEqual([null]);
    expect(markup(snapshots[0]!)).toContain('(manual)');
    expect(markup(snapshots[0]!)).toContain('Needs attention');
  });

  it('renders only a fixed sanitized error when IPC rejects with raw sensitive detail', async () => {
    const errors: Array<string | null> = [];
    const action = createManualDiagnosticsAction(
      () =>
        Promise.reject(
          new Error(
            'C:\\Users\\Owner\\AppData\\gophones.sqlite token=secret Jane Doe 281-555-0100',
          ),
        ),
      {
        onRunningChange: () => undefined,
        onSnapshot: () => undefined,
        onError: (value) => errors.push(value),
      },
    );

    await expect(action.run()).resolves.toBeNull();
    expect(errors.at(-1)).toBe(DIAGNOSTICS_ERROR_MESSAGE);
    const html = markup(snapshot(), false, errors.at(-1));
    expect(html).toContain('Diagnostics could not be completed');
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('gophones.sqlite');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('281-555-0100');
  });

  it('does not render backend-only issue codes or failure detail from the typed snapshot', () => {
    const html = markup(
      snapshot({
        database: {
          issueCodes: [
            'C:\\Users\\Owner\\AppData\\gophones.sqlite',
            'refresh_token=secret',
            'customer Jane Doe 281-555-0100',
          ],
        },
        backup: {
          lastLocalFailure: {
            backupType: 'AUTOMATIC',
            at: '2026-09-12T09:30:00.000Z',
            errorCode: 'C:\\private\\backup.sqlite',
          },
        },
      }),
    );
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('refresh_token');
    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('281-555-0100');
    expect(html).not.toContain('backup.sqlite');
  });
});
