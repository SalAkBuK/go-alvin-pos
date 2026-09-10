import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { app, BrowserWindow, shell } from 'electron';
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
import type { GoogleConfigService } from './google/googleConfigService';
import { createGoogleCredentialStore } from './google/googleCredentialStore';
import { createGoogleOAuthClient } from './google/googleOAuthClient';
import { loadOAuthClientConfig } from './google/oauthClientConfig';
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
let googleConfigService: GoogleConfigService | null = null;

/**
 * Phase 2J.1 Google wiring, shared by the IPC handlers, the background export
 * worker, and startup reconciliation. The encrypted OAuth refresh token lives
 * under `userData/secrets` — never in SQLite, never plaintext, never in the
 * renderer (`ARCHITECTURE.md §27.4`).
 */
const googleCredentialStore = createGoogleCredentialStore({
  filePath: join(paths.userData, 'secrets', 'google-oauth.enc'),
  crypto: createElectronSecureCrypto(),
});

/**
 * The developer OAuth "Desktop app" client configuration for this build/run
 * (`ARCHITECTURE.md §27.4`). `null` — and Google connection unavailable — when
 * `GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON` is unset or invalid; startup and local
 * POS are unaffected. Neither value is ever logged.
 */
const googleOAuthClientConfig = loadOAuthClientConfig({
  onWarn: (message) => logger.warn('google', 'google.oauth.client-config-unavailable', { message }),
});
const googleOAuthClient = googleOAuthClientConfig
  ? createGoogleOAuthClient(googleOAuthClientConfig)
  : null;

const googleLoggerAdapter = {
  info: (event: string, fields?: Record<string, unknown>) => logger.info('google', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => logger.warn('google', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => logger.error('google', event, fields),
};

function buildGoogleConfigService(db: Database.Database, appVersion: string): GoogleConfigService {
  return createGoogleConfigService({
    db,
    appVersion,
    credentialStore: googleCredentialStore,
    oauthClient: googleOAuthClient,
    openExternal: (url: string) => shell.openExternal(url),
    logger: googleLoggerAdapter,
  });
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
  // left `EXPORTING` for the 5-minute startup stale recovery) and abort any
  // pending OAuth authorization, BEFORE closing the one authoritative connection.
  app.on('will-quit', () => {
    googleConfigService?.cancelPendingAuthorization();
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
          createService: buildGoogleConfigService,
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
        // any crash-interrupted credential change, finish provisioning for a
        // connected-but-not-ready account, recover stale EXPORTING jobs, then
        // start the non-overlapping poll loop. Google latency/outage never
        // touches checkout (`AGENTS.md` invariants 2 & 7).
        const configService = buildGoogleConfigService(
          productionDatabase.connection,
          app.getVersion(),
        );
        googleConfigService = configService;
        try {
          await configService.reconcileAtStartup();
        } catch (reconcileError) {
          logger.error('google', 'google.config.reconcile-failed', {
            error:
              reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
          });
        }
        void configService.ensureProvisionedIfNeeded().catch((error: unknown) => {
          logger.warn('google', 'google.config.provision-at-startup-failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        googleExportWorker = createExportWorker({
          db: productionDatabase.connection,
          logger,
          resolveContext: () => configService.resolveExportContext(),
          createTransport: (ctx, signal) =>
            createSheetsTransport({ spreadsheetId: ctx.spreadsheetId, auth: ctx.auth, signal }),
          reportAuthHealth: (result, credentialGeneration) =>
            configService.noteExportAuthResult(credentialGeneration, result),
          onStructuralTargetFailure: (spreadsheetId, kind) =>
            configService.invalidateSpreadsheetTarget(spreadsheetId, kind),
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
