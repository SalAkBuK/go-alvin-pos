import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc';
import type { AppInfo, DatabaseStatus, NativeSqliteCheckResult } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { AppPaths } from '../app/paths';
import { getDatabaseStatus } from '../database/status';
import { runNativeSqliteCheck } from '../diagnostics/nativeSqliteCheck';

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
}
