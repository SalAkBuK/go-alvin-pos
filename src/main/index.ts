import { app, BrowserWindow } from 'electron';
import { pinUserDataPath, resolveAppPaths } from './app/paths';
import { Logger } from './app/logger';
import { createMainWindow } from './app/window';
import { resolveRendererEntry } from './app/rendererEntry';
import { focusExistingWindow } from './app/singleInstance';
import { installWebContentsHardening } from './app/security';
import { registerIpcHandlers } from './ipc/register';
import { ProductionDatabase, DatabaseInitializationError } from './database/database';
import { setDatabaseStatus } from './database/status';

/**
 * Electron main-process entry point (ARCHITECTURE.md Sections 5, 7, 38, 39, 42.4).
 *
 * PHASE 2A SCOPE: pin the application-data directory, acquire the single-instance
 * lock, stand up structured logging, harden the renderer, register the narrow
 * typed IPC surface, then — only after this process owns the instance — open the
 * production SQLite database (configure durability, migrate with a backup gate,
 * validate), open the window, and close the database cleanly on shutdown.
 *
 * No POS service/worker/feature is started here — there are none yet.
 */

// (1) Pin userData FIRST — before the single-instance lock, the logger, or any
// other code can create a file under Electron's implicit default location.
const userDataDir = pinUserDataPath();

const isDev = !app.isPackaged;
const paths = resolveAppPaths();
const rendererEntry = resolveRendererEntry();
const logger = new Logger({
  dir: paths.logs,
  minLevel: isDev ? 'debug' : 'info',
  console: isDev,
});

let mainWindow: BrowserWindow | null = null;
let productionDatabase: ProductionDatabase | null = null;

if (!app.requestSingleInstanceLock()) {
  // Losing instance: never open the database or touch the shared log file; exit.
  app.quit();
} else {
  app.on('second-instance', () => {
    logger.info('application', 'application.single-instance.focus-existing');
    focusExistingWindow(mainWindow);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(rendererEntry);
    }
  });

  // Graceful shutdown: close the one authoritative connection exactly once,
  // after all windows are gone and no application code can still be running.
  app.on('will-quit', () => {
    productionDatabase?.close();
  });

  app
    .whenReady()
    .then(async () => {
      installWebContentsHardening(rendererEntry);
      registerIpcHandlers({
        logger,
        paths,
        appVersion: app.getVersion(),
        getDatabase: () => productionDatabase,
      });

      // (2) Open the production database — only now that we own the instance.
      try {
        productionDatabase = await ProductionDatabase.open({
          filename: paths.databaseFile,
          backupDir: paths.backups,
          logger,
          appVersion: app.getVersion(),
        });
        setDatabaseStatus({
          state: 'ready',
          schemaVersion: productionDatabase.schemaVersion,
          failureCode: null,
        });
      } catch (error) {
        const failureCode =
          error instanceof DatabaseInitializationError ? error.code : 'DB_INIT_FAILED';
        setDatabaseStatus({ state: 'unavailable', schemaVersion: null, failureCode });
        logger.fatal('database', 'database.initialization-failed', {
          failureCode,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fail safe into a non-operational state: no DB connection, no services.
        // The window still opens so the failure is visible via
        // `diagnostics:database-status`; recovery evidence is in logs + any
        // pre-migration backup already written.
      }

      mainWindow = createMainWindow(rendererEntry);

      logger.info('application', 'application.started', {
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron,
        userData: userDataDir,
        databaseReady: productionDatabase !== null,
      });
    })
    .catch((error: unknown) => {
      logger.fatal('application', 'application.start-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    });
}
