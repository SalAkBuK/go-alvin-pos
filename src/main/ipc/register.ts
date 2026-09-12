import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc';
import type { AppInfo, DatabaseStatus, NativeSqliteCheckResult } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { AppPaths } from '../app/paths';
import type { ProductionDatabase } from '../database/database';
import { getDatabaseStatus } from '../database/status';
import { runNativeSqliteCheck } from '../diagnostics/nativeSqliteCheck';
import type { ProductionDatabase as ProductionDatabaseType } from '../database/database';
import type { GoogleConfigService } from '../google/googleConfigService';
import type { BackupService } from '../backup/backupService';
import type { RestoreService } from '../backup/restoreService';
import type { MaintenanceCoordinator } from '../maintenance/maintenanceCoordinator';
import type { CrashEvidenceService } from '../diagnostics/crashEvidence';
import type { ActivityHistoryService } from '../diagnostics/activityHistory';
import type { UpdateStateInspector } from '../diagnostics/updateHealth';
import type { UpdateService } from '../updater/updateService';
import { registerBackupIpcHandlers } from './backupIpc';
import { registerMaintenanceIpcHandlers } from './maintenanceIpc';
import { registerUpdatesIpcHandlers } from './updatesIpc';
import { registerCheckoutIpcHandlers } from './checkoutIpc';
import { registerCustomerIpcHandlers } from './customerIpc';
import { createIpcDiagnosticsService, registerDiagnosticsIpcHandlers } from './diagnosticsIpc';
import { registerGoogleIpcHandlers } from './googleIpc';
import { registerPrintingIpcHandlers } from './printingIpc';
import { registerProductIpcHandlers } from './productIpc';
import { registerReconciliationIpcHandlers } from './reconciliationIpc';
import { registerReportsIpcHandlers } from './reportsIpc';
import { registerSalesHistoryIpcHandlers } from './salesHistoryIpc';
import { registerSettingsIpcHandlers } from './settingsIpc';
import { registerSupportIpcHandlers } from './supportIpc';

/**
 * Registers the foundation IPC handlers (ARCHITECTURE.md Sections 9-10).
 *
 * Handlers are thin: they validate/marshal only and return a structured result.
 * Every channel is an explicit, business- or diagnostic-named capability. There
 * is deliberately no generic `database:query`, `execute-sql`, `read-file`, or
 * `run-command` handler, and none may be added.
 */
export interface IpcContext {
  readonly logger: Logger;
  readonly paths: AppPaths;
  readonly appVersion: string;
  readonly installationId: string;
  readonly crashEvidence: CrashEvidenceService;
  /** Phase 2M-F1 friendly activity/error history (`REQ-DIAG-002`). */
  readonly activityHistory: ActivityHistoryService;
  /** The one production database, or `null` while/if initialization has not succeeded. */
  readonly getDatabase: () => ProductionDatabase | null;
  /**
   * Phase 2L `BackupService`, or `null` while/if database initialization has
   * not succeeded (backup needs the authoritative connection).
   */
  readonly getBackupService: () => BackupService | null;
  /** Phase 2L-B `RestoreService`, or `null` before the database is ready. */
  readonly getRestoreService: () => RestoreService | null;
  /** Phase 2L-C native directory dialog for OFF_DEVICE setup; `null` = cancelled. */
  readonly showOffDeviceDirectoryDialog?: () => Promise<string | null>;
  /** Phase 2L-C native file dialog for "Browse for a backup file…"; `null` = cancelled. */
  readonly showBackupFileDialog?: () => Promise<string | null>;
  /** Main-owned support-bundle Save dialog. The selected path never crosses IPC. */
  readonly showSupportBundleSaveDialog: (suggestedFileName: string) => Promise<string | null>;
  /** The one maintenance coordinator (`ARCHITECTURE.md §42.3`). */
  readonly maintenanceCoordinator: MaintenanceCoordinator;
  /**
   * Phase 2J.1 Google wiring — one config-service factory assembled in
   * `index.ts` and shared with the export worker + startup reconciliation.
   */
  readonly google: {
    readonly getService: () => GoogleConfigService | null;
    readonly createService: (
      db: ProductionDatabaseType['connection'],
      appVersion: string,
    ) => GoogleConfigService;
  };
  /** Phase 2N-B: the real updater snapshot, bridged for Phase 2M diagnostics. */
  readonly updateStateInspector?: UpdateStateInspector;
  /** Phase 2N-C: the one trusted `UpdateService`, for `updates:*`. */
  readonly updateService: UpdateService;
}

export function registerIpcHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
    };
  });

  ipcMain.handle(IPC.nativeSqliteCheck, (): NativeSqliteCheckResult => {
    const result = runNativeSqliteCheck(context.paths.nativeCheckDbFile);
    if (result.ok) {
      context.logger.info('diagnostics', 'diagnostics.native-sqlite-check.ok', {
        sqliteVersion: result.sqliteVersion,
        journalMode: result.journalMode,
      });
    } else {
      context.logger.error('diagnostics', 'diagnostics.native-sqlite-check.failed', {
        error: result.error,
      });
    }
    return result;
  });

  ipcMain.handle(IPC.databaseStatus, (): DatabaseStatus => getDatabaseStatus());

  registerDiagnosticsIpcHandlers({
    logger: context.logger,
    appVersion: context.appVersion,
    installationId: context.installationId,
    storagePath: context.paths.userData,
    getDatabase: context.getDatabase,
    getDatabaseStatus,
    getBackupService: context.getBackupService,
    getGoogleConfigService: context.google.getService,
    ...(context.updateStateInspector ? { updateStateInspector: context.updateStateInspector } : {}),
  });

  const supportDiagnostics = createIpcDiagnosticsService({
    logger: context.logger,
    appVersion: context.appVersion,
    installationId: context.installationId,
    storagePath: context.paths.userData,
    getDatabase: context.getDatabase,
    getDatabaseStatus,
    getBackupService: context.getBackupService,
    getGoogleConfigService: context.google.getService,
    ...(context.updateStateInspector ? { updateStateInspector: context.updateStateInspector } : {}),
  });
  registerSupportIpcHandlers({
    logger: context.logger,
    appVersion: context.appVersion,
    installationId: context.installationId,
    reportsRoot: join(context.paths.diagnostics, 'problem-reports'),
    logsRoot: context.paths.logs,
    getDatabase: context.getDatabase,
    getDiagnostics: () => supportDiagnostics.getSummary(),
    getCrashEvidence: () => context.crashEvidence.collectRecent(),
    getActivityHistory: () => context.activityHistory.getRecent(),
    showSaveDialog: context.showSupportBundleSaveDialog,
  });

  registerProductIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
  });

  registerCustomerIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
  });

  registerCheckoutIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
    coordinator: context.maintenanceCoordinator,
  });

  registerReconciliationIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
  });

  registerSalesHistoryIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
    coordinator: context.maintenanceCoordinator,
  });

  registerReportsIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
  });

  registerSettingsIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
  });

  registerPrintingIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
  });

  registerBackupIpcHandlers({
    logger: context.logger,
    getBackupService: context.getBackupService,
    getRestoreService: context.getRestoreService,
    ...(context.showOffDeviceDirectoryDialog
      ? { showOffDeviceDirectoryDialog: context.showOffDeviceDirectoryDialog }
      : {}),
    ...(context.showBackupFileDialog ? { showBackupFileDialog: context.showBackupFileDialog } : {}),
  });

  registerMaintenanceIpcHandlers({
    logger: context.logger,
    coordinator: context.maintenanceCoordinator,
  });

  registerUpdatesIpcHandlers({
    logger: context.logger,
    updateService: context.updateService,
  });

  registerGoogleIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
    createService: context.google.createService,
  });
}
