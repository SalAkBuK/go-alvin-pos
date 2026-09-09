import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { pinUserDataPath, resolveAppPaths } from './app/paths';
import { Logger } from './app/logger';
import { createMainWindow } from './app/window';
import { resolveRendererEntry } from './app/rendererEntry';
import { focusExistingWindow } from './app/singleInstance';
import { installWebContentsHardening } from './app/security';
import { registerIpcHandlers } from './ipc/register';
import { ProductionDatabase, DatabaseInitializationError } from './database/database';
import { setDatabaseStatus } from './database/status';
import { createElectronSecureCrypto } from './google/electronSafeStorage';
import { createExportWorker } from './google/exportWorker';
import type { ExportWorker } from './google/exportWorker';
import { createGoogleConfigService } from './google/googleConfigService';
import { createGoogleCredentialStore } from './google/googleCredentialStore';
import { createServiceAccountAuthProvider } from './google/googleAuth';
import { createSheetsTransport } from './google/sheetsTransport';

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
let googleExportWorker: ExportWorker | null = null;

/**
 * Phase 2J Google wiring, shared by the IPC handlers and the background export
 * worker. The encrypted service-account credential lives under `userData/secrets`
 * — never in SQLite, never plaintext, never in the renderer.
 */
const googleCredentialStore = createGoogleCredentialStore({
  filePath: join(paths.userData, 'secrets', 'google-service-account.enc'),
  crypto: createElectronSecureCrypto(),
});

async function pickGoogleCredentialFile(): Promise<string | null> {
  const options = {
    title: 'Select the Google service-account JSON key',
    properties: ['openFile' as const],
    filters: [{ name: 'Service account key', extensions: ['json'] }],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

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

  // Graceful shutdown: stop the export worker (synchronous — stop scheduling
  // work and abort our wait on the active request; an ambiguous in-flight job is
  // left `EXPORTING` for the 5-minute startup stale recovery) BEFORE closing the
  // one authoritative connection.
  app.on('will-quit', () => {
    googleExportWorker?.stopSync();
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
        google: {
          credentialStore: googleCredentialStore,
          pickCredentialFile: pickGoogleCredentialFile,
          createAuthProvider: createServiceAccountAuthProvider,
        },
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

        // (3) Google Sheets export worker — only after the DB is open. Reconcile
        // any crash-interrupted credential change, recover stale EXPORTING jobs,
        // then start the non-overlapping poll loop. Google latency/outage never
        // touches checkout (`AGENTS.md` invariants 2 & 7).
        const googleConfigService = createGoogleConfigService({
          db: productionDatabase.connection,
          appVersion: app.getVersion(),
          credentialStore: googleCredentialStore,
          pickCredentialFile: pickGoogleCredentialFile,
          createAuthProvider: createServiceAccountAuthProvider,
        });
        try {
          await googleConfigService.reconcileAtStartup();
        } catch (reconcileError) {
          logger.error('google', 'google.config.reconcile-failed', {
            error:
              reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
          });
        }
        googleExportWorker = createExportWorker({
          db: productionDatabase.connection,
          logger,
          resolveContext: () => googleConfigService.resolveExportContext(),
          createTransport: (ctx, signal) =>
            createSheetsTransport({ spreadsheetId: ctx.spreadsheetId, auth: ctx.auth, signal }),
        });
        googleExportWorker.recoverStale();
        googleExportWorker.start();
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
