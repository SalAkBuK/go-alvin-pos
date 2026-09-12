import type { OffDeviceBackupHealth } from './backup';
import type { GoogleSetupState } from './google';

/** The only V1 top-level and component health states. */
export type HealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

export interface DatabaseDiagnostic {
  readonly status: HealthStatus;
  readonly open: boolean;
  readonly schemaVersion: number | null;
  readonly expectedSchemaVersion: number;
  readonly migrationStateValid: boolean;
  readonly foreignKeysEnabled: boolean;
  readonly criticalTablesAvailable: boolean;
  readonly quickCheck: 'NOT_RUN' | 'OK' | 'FAILED';
  /** Stable, non-sensitive categories only; never SQLite messages or SQL. */
  readonly issueCodes: readonly string[];
}

export interface DiskDiagnostic {
  readonly status: HealthStatus;
  readonly inspectionAvailable: boolean;
  readonly availableBytes: number | null;
  readonly warningBelowBytes: number;
  readonly criticalBelowBytes: number;
  readonly issueCode: 'DISK_SPACE_LOW' | 'DISK_SPACE_CRITICAL' | 'DISK_INSPECTION_FAILED' | null;
}

export interface BackupDiagnostic {
  /** Backup/off-device failures are secondary and therefore never CRITICAL. */
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly lastSuccessfulLocalAt: string | null;
  readonly lastLocalFailure: {
    readonly backupType: 'AUTOMATIC' | 'MANUAL' | 'PRE_MIGRATION';
    readonly at: string;
    readonly errorCode: string;
  } | null;
  readonly localOverdue: boolean;
  readonly offDevice: OffDeviceBackupHealth;
  readonly issueCode: 'BACKUP_OVERDUE' | 'BACKUP_FAILED' | 'OFF_DEVICE_ATTENTION' | null;
}

export interface GoogleDiagnostic {
  /** Google is secondary and therefore never CRITICAL. */
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly enabled: boolean;
  readonly setupState: GoogleSetupState;
  readonly needsReauthorization: boolean;
  readonly setupNeedsAttention: boolean;
  readonly pendingExports: number;
  readonly exportingExports: number;
  readonly failedExports: number;
  readonly lastSuccessfulExportAt: string | null;
  readonly issueCode:
    | 'GOOGLE_DISCONNECTED'
    | 'GOOGLE_SETUP_INCOMPLETE'
    | 'GOOGLE_REAUTHORIZATION_REQUIRED'
    | 'GOOGLE_EXPORT_BACKLOG'
    | 'GOOGLE_DIAGNOSTIC_UNAVAILABLE'
    | null;
}

export interface CardReconciliationDiagnostic {
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly unresolvedCount: number;
  readonly issueCode: 'CARD_RECONCILIATION_REQUIRED' | 'RECONCILIATION_CHECK_FAILED' | null;
}

export interface PrinterDiagnostic {
  /** Printer state is secondary and therefore never CRITICAL. */
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly state: 'NOT_CONFIGURED' | 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly configuredName: string | null;
  readonly availabilitySupported: boolean;
  readonly printHistorySupported: false;
  readonly lastSuccessfulPrintAt: null;
  readonly lastFailedPrintAt: null;
  readonly issueCode:
    'PRINTER_NOT_CONFIGURED' | 'PRINTER_UNAVAILABLE' | 'PRINTER_INSPECTION_FAILED' | null;
}

export interface ConnectivityDiagnostic {
  /** Connectivity is informational/secondary and therefore never CRITICAL. */
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly supported: boolean;
  readonly state: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  readonly issueCode: 'INTERNET_OFFLINE' | 'CONNECTIVITY_INSPECTION_FAILED' | null;
}

/**
 * V1 has no update-check/download/install mechanism yet (`UPDATE_RELEASE_STRATEGY.md`
 * describes the target design; none of it is implemented). `supported: false` /
 * `state: 'UNKNOWN'` is therefore the only value V1 ever actually produces —
 * honest, not fabricated. The full state set is defined so a future updater can
 * populate this component without another DTO redesign.
 */
export const UPDATE_STATES = [
  'UP_TO_DATE',
  'AVAILABLE',
  'PENDING',
  'DEFERRED',
  'FAILED',
  'UNKNOWN',
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export interface UpdateDiagnostic {
  /** Update checking is secondary/external and therefore never CRITICAL. */
  readonly status: Exclude<HealthStatus, 'CRITICAL'>;
  readonly supported: boolean;
  readonly state: UpdateState;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly lastCheckedAt: string | null;
  readonly issueCode: 'UPDATE_CHECK_FAILED' | 'UPDATE_INSTALL_FAILED' | null;
}

export interface DiagnosticSnapshot {
  readonly generatedAt: string;
  readonly mode: 'SUMMARY' | 'MANUAL';
  readonly application: {
    readonly version: string;
    readonly buildIdentifier: string | null;
    readonly installationId: string;
  };
  readonly runtime: {
    readonly platform: string;
    readonly osRelease: string;
    readonly arch: string;
    readonly electron: string | null;
    readonly node: string;
  };
  readonly overallStatus: HealthStatus;
  readonly components: {
    readonly database: DatabaseDiagnostic;
    readonly disk: DiskDiagnostic;
    readonly backup: BackupDiagnostic;
    readonly google: GoogleDiagnostic;
    readonly cardReconciliation: CardReconciliationDiagnostic;
    readonly printer: PrinterDiagnostic;
    readonly connectivity: ConnectivityDiagnostic;
    readonly update: UpdateDiagnostic;
  };
}
