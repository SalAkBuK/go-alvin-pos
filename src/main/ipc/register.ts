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
import { registerCheckoutIpcHandlers } from './checkoutIpc';
import { registerCustomerIpcHandlers } from './customerIpc';
import { registerGoogleIpcHandlers } from './googleIpc';
import { registerPrintingIpcHandlers } from './printingIpc';
import { registerProductIpcHandlers } from './productIpc';
import { registerReconciliationIpcHandlers } from './reconciliationIpc';
import { registerSalesHistoryIpcHandlers } from './salesHistoryIpc';
import { registerSettingsIpcHandlers } from './settingsIpc';

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
  /** The one production database, or `null` while/if initialization has not succeeded. */
  readonly getDatabase: () => ProductionDatabase | null;
  /**
   * Phase 2J.1 Google wiring — one config-service factory assembled in
   * `index.ts` and shared with the export worker + startup reconciliation.
   */
  readonly google: {
    readonly createService: (
      db: ProductionDatabaseType['connection'],
      appVersion: string,
    ) => GoogleConfigService;
  };
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
  });

  registerReconciliationIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
  });

  registerSalesHistoryIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
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

  registerGoogleIpcHandlers({
    logger: context.logger,
    getDatabase: context.getDatabase,
    appVersion: context.appVersion,
    createService: context.google.createService,
  });
}
