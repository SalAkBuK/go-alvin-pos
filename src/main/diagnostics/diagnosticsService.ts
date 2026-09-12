import { arch, platform, release } from 'node:os';
import type Database from 'better-sqlite3';
import type { BackupHealth, OffDeviceBackupHealth } from '../../shared/backup';
import type {
  BackupDiagnostic,
  CardReconciliationDiagnostic,
  ConnectivityDiagnostic,
  DiagnosticSnapshot,
  GoogleDiagnostic,
  HealthStatus,
  PrinterDiagnostic,
  UpdateDiagnostic,
} from '../../shared/diagnostics';
import type { GoogleConfig } from '../../shared/google';
import type { PrinterConfig } from '../../shared/printing';
import { redactString } from '../app/logger';
import type { Logger } from '../app/logger';
import type { BackupService } from '../backup/backupService';
import { listBackupRecords } from '../backup/backupRecordsRepository';
import type { DatabaseStatus } from '../../shared/ipc';
import type { ProductionDatabase } from '../database/database';
import { createReconciliationService } from '../reconciliation/reconciliationService';
import { classifyDiskSpace, createDiskSpaceInspector, failedDiskInspection } from './diskSpace';
import type { DiskSpaceInspector } from './diskSpace';
import { inspectDatabaseHealth, unavailableDatabaseDiagnostic } from './databaseHealth';
import { buildUpdateDiagnostic, unsupportedUpdateDiagnostic } from './updateHealth';
import type { UpdateStateInspector } from './updateHealth';

export interface ConnectivityInspector {
  inspect(): Promise<'ONLINE' | 'OFFLINE'>;
}

export interface DiagnosticsServiceDeps {
  readonly appVersion: string;
  readonly buildIdentifier?: string | null;
  readonly installationId: string;
  /** Trusted path used only as input to statfs; it never crosses IPC or enters logs. */
  readonly storagePath: string;
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly getDatabaseStatus: () => DatabaseStatus;
  readonly getBackupService: () => BackupService | null;
  readonly getGoogleConfig: () => Promise<GoogleConfig>;
  readonly getPrinterConfig: (db: Database.Database) => Promise<PrinterConfig>;
  readonly diskInspector?: DiskSpaceInspector;
  /** Omit when no reliable existing online/offline signal exists. */
  readonly connectivityInspector?: ConnectivityInspector;
  /** Omit when no real update-check mechanism exists (true for all of V1 — see `updateHealth.ts`). */
  readonly updateStateInspector?: UpdateStateInspector;
  readonly now?: () => Date;
  readonly runtime?: {
    readonly platform: string;
    readonly osRelease: string;
    readonly arch: string;
    readonly electron: string | null;
    readonly node: string;
  };
}

export interface DiagnosticsService {
  getSummary(): Promise<DiagnosticSnapshot>;
  runDiagnostics(): Promise<DiagnosticSnapshot>;
}

export function aggregateHealth(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes('CRITICAL')) return 'CRITICAL';
  if (statuses.includes('WARNING')) return 'WARNING';
  return 'HEALTHY';
}

function latestSuccessfulLocalAt(db: Database.Database): string | null {
  const row = listBackupRecords(db)
    .filter((entry) => entry.locationKind === 'LOCAL_DISK' && entry.status === 'COMPLETED')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  return row?.completedAt ?? null;
}

function backupDiagnostic(db: Database.Database, health: BackupHealth): BackupDiagnostic {
  const localSuccess = latestSuccessfulLocalAt(db);
  const localFailureIsCurrent =
    health.lastFailure !== null &&
    (localSuccess === null || health.lastFailure.at.localeCompare(localSuccess) > 0);
  const offDevice: OffDeviceBackupHealth = health.offDevice ?? { state: 'NOT_CONFIGURED' };
  const issueCode: BackupDiagnostic['issueCode'] = health.overdue
    ? 'BACKUP_OVERDUE'
    : localFailureIsCurrent
      ? 'BACKUP_FAILED'
      : offDevice.state === 'ATTENTION'
        ? 'OFF_DEVICE_ATTENTION'
        : null;
  return {
    status: issueCode === null ? 'HEALTHY' : 'WARNING',
    lastSuccessfulLocalAt: localSuccess,
    lastLocalFailure: health.lastFailure
      ? {
          ...health.lastFailure,
          errorCode: /^[A-Z][A-Z0-9_]{0,99}$/.test(health.lastFailure.errorCode)
            ? health.lastFailure.errorCode
            : 'BACKUP_FAILED',
        }
      : null,
    localOverdue: health.overdue,
    offDevice,
    issueCode,
  };
}

function unavailableBackupDiagnostic(): BackupDiagnostic {
  return {
    status: 'WARNING',
    lastSuccessfulLocalAt: null,
    lastLocalFailure: null,
    localOverdue: true,
    offDevice: { state: 'NOT_CONFIGURED' },
    issueCode: 'BACKUP_FAILED',
  };
}

function googleDiagnostic(config: GoogleConfig): GoogleDiagnostic {
  const issueCode: GoogleDiagnostic['issueCode'] = config.needsReauthorization
    ? 'GOOGLE_REAUTHORIZATION_REQUIRED'
    : config.setupState === 'DISCONNECTED'
      ? 'GOOGLE_DISCONNECTED'
      : config.setupState === 'SETUP_INCOMPLETE'
        ? 'GOOGLE_SETUP_INCOMPLETE'
        : config.queue.pending + config.queue.exporting + config.queue.failed > 0
          ? 'GOOGLE_EXPORT_BACKLOG'
          : null;
  return {
    status: issueCode === null ? 'HEALTHY' : 'WARNING',
    enabled: config.enabled,
    setupState: config.setupState,
    needsReauthorization: config.needsReauthorization,
    setupNeedsAttention: config.setupState === 'SETUP_INCOMPLETE',
    pendingExports: config.queue.pending,
    exportingExports: config.queue.exporting,
    failedExports: config.queue.failed,
    lastSuccessfulExportAt: config.lastSuccessfulSyncAt,
    issueCode,
  };
}

function unavailableGoogleDiagnostic(): GoogleDiagnostic {
  return {
    status: 'WARNING',
    enabled: false,
    setupState: 'DISCONNECTED',
    needsReauthorization: false,
    setupNeedsAttention: false,
    pendingExports: 0,
    exportingExports: 0,
    failedExports: 0,
    lastSuccessfulExportAt: null,
    issueCode: 'GOOGLE_DIAGNOSTIC_UNAVAILABLE',
  };
}

function printerDiagnostic(config: PrinterConfig): PrinterDiagnostic {
  if (config.selectedDeviceName === null) {
    return {
      status: 'WARNING',
      state: 'NOT_CONFIGURED',
      configuredName: null,
      availabilitySupported: true,
      printHistorySupported: false,
      lastSuccessfulPrintAt: null,
      lastFailedPrintAt: null,
      issueCode: 'PRINTER_NOT_CONFIGURED',
    };
  }
  return {
    status: config.selectedIsAvailable ? 'HEALTHY' : 'WARNING',
    state: config.selectedIsAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
    configuredName: safeDeviceLabel(config.selectedDisplayName ?? config.selectedDeviceName),
    availabilitySupported: true,
    printHistorySupported: false,
    lastSuccessfulPrintAt: null,
    lastFailedPrintAt: null,
    issueCode: config.selectedIsAvailable ? null : 'PRINTER_UNAVAILABLE',
  };
}

/** Printer labels are useful, but a path-like value is not allowed into the support DTO. */
function safeDeviceLabel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 255 || /[\\/]/.test(trimmed) || /^[a-z]:/i.test(trimmed)) {
    return null;
  }
  return redactString(trimmed);
}

function unavailablePrinterDiagnostic(): PrinterDiagnostic {
  return {
    status: 'WARNING',
    state: 'UNKNOWN',
    configuredName: null,
    availabilitySupported: false,
    printHistorySupported: false,
    lastSuccessfulPrintAt: null,
    lastFailedPrintAt: null,
    issueCode: 'PRINTER_INSPECTION_FAILED',
  };
}

function unsupportedConnectivityDiagnostic(): ConnectivityDiagnostic {
  return {
    status: 'HEALTHY',
    supported: false,
    state: 'UNKNOWN',
    issueCode: null,
  };
}

export function createDiagnosticsService(deps: DiagnosticsServiceDeps): DiagnosticsService {
  const diskInspector = deps.diskInspector ?? createDiskSpaceInspector();
  const now = deps.now ?? (() => new Date());
  const runtime =
    deps.runtime ??
    ({
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      electron: process.versions.electron ?? null,
      node: process.versions.node,
    } as const);

  async function snapshot(mode: DiagnosticSnapshot['mode']): Promise<DiagnosticSnapshot> {
    const manual = mode === 'MANUAL';
    if (manual) deps.logger.info('diagnostics', 'diagnostics.run.started');

    let database: ProductionDatabase | null = null;
    let databaseLookupFailed = false;
    try {
      database = deps.getDatabase();
    } catch {
      databaseLookupFailed = true;
      deps.logger.error('diagnostics', 'diagnostics.component.failed', {
        component: 'database',
        errorCode: 'DATABASE_CHECK_FAILED',
      });
    }
    let databaseResult;
    try {
      databaseResult =
        !databaseLookupFailed && database && !database.closed
          ? inspectDatabaseHealth(database.connection, { deep: manual })
          : unavailableDatabaseDiagnostic(
              databaseLookupFailed ? 'DATABASE_CHECK_FAILED' : deps.getDatabaseStatus().failureCode,
            );
    } catch {
      databaseResult = unavailableDatabaseDiagnostic('DATABASE_CHECK_FAILED');
      deps.logger.error('diagnostics', 'diagnostics.component.failed', {
        component: 'database',
        errorCode: 'DATABASE_CHECK_FAILED',
      });
    }

    const diskPromise = diskInspector
      .availableBytes(deps.storagePath)
      .then(classifyDiskSpace)
      .catch(() => {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'disk',
          errorCode: 'DISK_INSPECTION_FAILED',
        });
        return failedDiskInspection();
      });

    const backupPromise = (async (): Promise<BackupDiagnostic> => {
      try {
        const service = deps.getBackupService();
        if (!database || database.closed || !service) return unavailableBackupDiagnostic();
        return backupDiagnostic(database.connection, await service.statusVerified());
      } catch {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'backup',
          errorCode: 'BACKUP_DIAGNOSTIC_FAILED',
        });
        return unavailableBackupDiagnostic();
      }
    })();

    const googlePromise = deps
      .getGoogleConfig()
      .then(googleDiagnostic)
      .catch(() => {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'google',
          errorCode: 'GOOGLE_DIAGNOSTIC_UNAVAILABLE',
        });
        return unavailableGoogleDiagnostic();
      });

    const reconciliationPromise = Promise.resolve().then((): CardReconciliationDiagnostic => {
      try {
        if (!database || database.closed) throw new Error('unavailable');
        const count = createReconciliationService({
          db: database.connection,
          now: () => now().toISOString(),
        }).list().length;
        return {
          status: count > 0 ? 'WARNING' : 'HEALTHY',
          unresolvedCount: count,
          issueCode: count > 0 ? 'CARD_RECONCILIATION_REQUIRED' : null,
        };
      } catch {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'card-reconciliation',
          errorCode: 'RECONCILIATION_CHECK_FAILED',
        });
        return {
          status: 'WARNING',
          unresolvedCount: 0,
          issueCode: 'RECONCILIATION_CHECK_FAILED',
        };
      }
    });

    const printerPromise = (async (): Promise<PrinterDiagnostic> => {
      try {
        if (!database || database.closed) return unavailablePrinterDiagnostic();
        return printerDiagnostic(await deps.getPrinterConfig(database.connection));
      } catch {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'printer',
          errorCode: 'PRINTER_INSPECTION_FAILED',
        });
        return unavailablePrinterDiagnostic();
      }
    })();

    const connectivityPromise = (async (): Promise<ConnectivityDiagnostic> => {
      if (!deps.connectivityInspector) return unsupportedConnectivityDiagnostic();
      try {
        const state = await deps.connectivityInspector.inspect();
        return {
          status: state === 'OFFLINE' ? 'WARNING' : 'HEALTHY',
          supported: true,
          state,
          issueCode: state === 'OFFLINE' ? 'INTERNET_OFFLINE' : null,
        };
      } catch {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'connectivity',
          errorCode: 'CONNECTIVITY_INSPECTION_FAILED',
        });
        return {
          status: 'WARNING',
          supported: true,
          state: 'UNKNOWN',
          issueCode: 'CONNECTIVITY_INSPECTION_FAILED',
        };
      }
    })();

    const updatePromise = (async (): Promise<UpdateDiagnostic> => {
      if (!deps.updateStateInspector) return unsupportedUpdateDiagnostic(deps.appVersion);
      try {
        const input = await deps.updateStateInspector.inspect();
        return buildUpdateDiagnostic(input);
      } catch {
        deps.logger.warn('diagnostics', 'diagnostics.component.failed', {
          component: 'update',
          errorCode: 'UPDATE_CHECK_FAILED',
        });
        return unsupportedUpdateDiagnostic(deps.appVersion);
      }
    })();

    const [disk, backup, google, cardReconciliation, printer, connectivity, update] =
      await Promise.all([
        diskPromise,
        backupPromise,
        googlePromise,
        reconciliationPromise,
        printerPromise,
        connectivityPromise,
        updatePromise,
      ]);

    if (disk.issueCode === 'DISK_SPACE_LOW' || disk.issueCode === 'DISK_SPACE_CRITICAL') {
      deps.logger.warn('diagnostics', 'diagnostics.disk-space.low', {
        errorCode: disk.issueCode,
        availableBytes: disk.availableBytes,
      });
    }

    const overallStatus = aggregateHealth([
      databaseResult.status,
      disk.status,
      backup.status,
      google.status,
      cardReconciliation.status,
      printer.status,
      connectivity.status,
      update.status,
    ]);
    const result: DiagnosticSnapshot = {
      generatedAt: now().toISOString(),
      mode,
      application: {
        version: deps.appVersion,
        buildIdentifier: deps.buildIdentifier ?? null,
        installationId: deps.installationId,
      },
      runtime,
      overallStatus,
      components: {
        database: databaseResult,
        disk,
        backup,
        google,
        cardReconciliation,
        printer,
        connectivity,
        update,
      },
    };

    if (manual) {
      deps.logger.info('diagnostics', 'diagnostics.run.completed', { overallStatus });
    }
    return result;
  }

  return {
    getSummary: () => snapshot('SUMMARY'),
    runDiagnostics: () => snapshot('MANUAL'),
  };
}
