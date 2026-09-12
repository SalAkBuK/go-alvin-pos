import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { app, BrowserWindow, powerMonitor, shell } from 'electron';
import { pinUserDataPath, resolveAppPaths } from './app/paths';
import { Logger } from './app/logger';
import { loadOrCreateInstallationId } from './app/installationIdentity';
import { createMainWindow } from './app/window';
import { resolveRendererEntry } from './app/rendererEntry';
import { handleSecondInstance } from './app/singleInstance';
import { installWebContentsHardening } from './app/security';
import { registerIpcHandlers } from './ipc/register';
import { createBackupService } from './backup/backupService';
import type { BackupService } from './backup/backupService';
import { createBackupScheduler } from './backup/backupScheduler';
import type { BackupScheduler } from './backup/backupScheduler';
import { createRestoreService } from './backup/restoreService';
import type { RestoreService } from './backup/restoreService';
import { createBackupFileDialogOpener } from './app/backupFileDialog';
import { createOffDeviceDirectoryDialogOpener } from './app/offDeviceDirectoryDialog';
import { createSupportBundleSaveDialogOpener } from './app/supportBundleSaveDialog';
import { recoverInterruptedRestore } from './app/startupRestoreRecovery';
import { createMaintenanceCoordinator } from './maintenance/maintenanceCoordinator';
import type { MaintenanceCoordinator } from './maintenance/maintenanceCoordinator';
import { ProductionDatabase, DatabaseInitializationError } from './database/database';
import { targetSchemaVersion } from './database/migrations';
import { resolveActiveMigrations } from './database/migrations/e3MigrationConfig';
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
import { createCrashEvidenceService } from './diagnostics/crashEvidence';
import { installCrashEvidenceHandlers } from './diagnostics/crashLifecycle';
import { installPowerLifecycleHandlers } from './diagnostics/powerLifecycle';
import { createClockWatcher } from './diagnostics/clockWatcher';
import { createActivityHistoryService } from './diagnostics/activityHistory';
import { createUpdateService } from './updater/updateService';
import type { UpdateService } from './updater/updateService';
import { loadUpdateFeedConfig } from './updater/updateFeedConfig';
import { createUpdaterStateInspector } from './updater/updateDiagnosticsBridge';
import { loadBuildIdentity } from './app/buildIdentity';
import {
  installUpdateInstallE2eTrigger,
  type UpdateInstallE2eTrigger,
} from './updater/updateInstallE2eTrigger';
import { applyUpdateInstallE2eAppName } from './updater/updateInstallE2eConfig';

declare const __UPDATE_INSTALL_E2E_ENABLED__: boolean | undefined;

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

// (0) Packaged update-install E2E only (Phase 2N-E2): force `app.getName()`
// to the distinct E2E product name BEFORE anything reads it. No-op in every
// ordinary build.
applyUpdateInstallE2eAppName(app);

// (1) Pin userData FIRST — before the single-instance lock, the logger, or any
// other code can create a file under Electron's implicit default location.
pinUserDataPath();

const isDev = !app.isPackaged;
const paths = resolveAppPaths();
const rendererEntry = resolveRendererEntry();
const installationId = loadOrCreateInstallationId(paths.installationIdentityFile);
// Phase 2N-E3: the one build-time migration-set authority every trusted
// component below agrees with — `null` (== `PRODUCTION_MIGRATIONS`) in every
// ordinary build (`database/migrations/e3MigrationConfig.ts`).
const activeMigrations = resolveActiveMigrations();
const buildIdentity = loadBuildIdentity(app.getVersion(), targetSchemaVersion(activeMigrations));
const logger = new Logger({
  dir: paths.logs,
  installationId,
  minLevel: isDev ? 'debug' : 'info',
  console: isDev,
});

let mainWindow: BrowserWindow | null = null;
let productionDatabase: ProductionDatabase | null = null;
let googleExportWorker: ExportWorker | null = null;
let googleConfigService: GoogleConfigService | null = null;
let backupService: BackupService | null = null;
let backupScheduler: BackupScheduler | null = null;
let restoreService: RestoreService | null = null;
let updateInstallE2eTrigger: UpdateInstallE2eTrigger | null = null;

const crashEvidence = createCrashEvidenceService({
  diagnosticsRoot: paths.diagnostics,
  appVersion: app.getVersion(),
  installationId,
  logger,
  getSchemaVersion: () => productionDatabase?.schemaVersion ?? null,
});

/** Significant wall-clock-jump detection (`SUPPORT_DIAGNOSTICS.md §33`). Rebaselined on resume so elapsed sleep is never mistaken for a clock jump. */
const clockWatcher = createClockWatcher({ logger });

/** Friendly activity/error history (`REQ-DIAG-002`) — reads the same bounded Phase 2M-A log files; no database, no new logging system. */
const activityHistory = createActivityHistoryService({
  logsRoot: paths.logs,
  logger,
});

/**
 * The one maintenance coordinator (`ARCHITECTURE.md §42.3`). Created before the
 * database so the IPC surface and restore share it. `getDb` returns the live
 * connection, or `null` mid-swap.
 */
const maintenanceCoordinator: MaintenanceCoordinator = createMaintenanceCoordinator({
  logger,
  getDb: () => productionDatabase?.connection ?? null,
});

/**
 * Phase 2N-A/B/C updater engine: construct the trusted `UpdateService`
 * (fail-open, no database dependency — `updateService.ts`), wire its real
 * snapshot into the Phase 2M `updateStateInspector` diagnostics seam
 * (`updateDiagnosticsBridge.ts`), and give it a read-only view of the one
 * maintenance coordinator's state so `restartAndInstall()` can gate a
 * user-requested install/restart the same way every other exclusive
 * maintenance decision is gated — this passes only `.status`, never the
 * coordinator itself, so the updater can query but never claim/mutate
 * maintenance state. `updateService.start()` is called later, inside
 * `whenReady()` alongside `clockWatcher.start()`, so the (delayed,
 * non-blocking) first update check never competes with window
 * creation/login — see the `whenReady()` block below.
 */
const updateFeedConfig = loadUpdateFeedConfig({
  onWarn: (message) => logger.warn('application', 'update.feed-config-unavailable', { message }),
});
const updateService: UpdateService = createUpdateService({
  logger,
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  feedUrl: updateFeedConfig?.url ?? null,
  getMaintenanceState: () => maintenanceCoordinator.status(),
});
const updateStateInspector = createUpdaterStateInspector(updateService);

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
  installCrashEvidenceHandlers(app, process, crashEvidence);
  crashEvidence.startSession();

  app.on('second-instance', () => {
    handleSecondInstance(mainWindow, logger);
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
  // A restore mid-swap leaves its crash-consistent marker + verified pre-restore
  // copy — the next launch recovers from those (`startupRestoreRecovery`).
  app.on('will-quit', () => {
    googleConfigService?.cancelPendingAuthorization();
    googleExportWorker?.stopSync();
    backupScheduler?.stopSync();
    clockWatcher.stopSync();
    updateService.stopSync();
    updateInstallE2eTrigger?.stopSync();
    productionDatabase?.close();
    crashEvidence.markCleanShutdown();
  });

  /**
   * Wire every database-backed service/worker against `pdb`'s connection and
   * publish "ready" status. Used at first startup AND after a restore swaps the
   * database (Phase 2L-B Item 15) — objects that closed over the previous
   * connection are rebuilt, not mutated.
   */
  function wireDatabaseBackedServices(pdb: ProductionDatabase): void {
    productionDatabase = pdb;
    setDatabaseStatus({
      state: 'ready',
      schemaVersion: pdb.schemaVersion,
      failureCode: null,
    });

    const configService = buildGoogleConfigService(pdb.connection, app.getVersion());
    googleConfigService = configService;
    googleExportWorker = createExportWorker({
      db: pdb.connection,
      logger,
      resolveContext: () => configService.resolveExportContext(),
      createTransport: (ctx, signal) =>
        createSheetsTransport({ spreadsheetId: ctx.spreadsheetId, auth: ctx.auth, signal }),
      reportAuthHealth: (result, credentialGeneration) =>
        configService.noteExportAuthResult(credentialGeneration, result),
      onStructuralTargetFailure: (spreadsheetId, kind) =>
        configService.invalidateSpreadsheetTarget(spreadsheetId, kind),
    });
    backupService = createBackupService({
      db: pdb.connection,
      backupsRoot: paths.backups,
      appVersion: app.getVersion(),
      logger,
      isExclusiveMaintenanceActive: () => maintenanceCoordinator.isExclusiveActive(),
    });
    backupScheduler = createBackupScheduler(backupService, logger);
  }

  /** Reconcile Google state, recover stale export work, then start the workers + scheduler. */
  function startBackgroundWork(): void {
    const configService = googleConfigService;
    if (configService) {
      void configService.reconcileAtStartup().catch((error: unknown) => {
        logger.error('google', 'google.config.reconcile-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void configService.ensureProvisionedIfNeeded().catch((error: unknown) => {
        logger.warn('google', 'google.config.provision-at-startup-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    googleExportWorker?.recoverStale();
    googleExportWorker?.start();
    void backupService?.runAutomaticIfDue().catch((error: unknown) => {
      logger.warn('backup', 'backup.startup-catch-up-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    backupScheduler?.start();
  }

  /** Bring background DB work to a safe boundary WITHOUT closing the connection (Phase 2L-B Item 7). */
  async function quiesceBackgroundWork(): Promise<void> {
    backupScheduler?.stopSync();
    await backupService?.awaitIdle();
    googleConfigService?.cancelPendingAuthorization();
    await googleExportWorker?.stop();
  }

  app
    .whenReady()
    .then(async () => {
      installWebContentsHardening(rendererEntry);

      clockWatcher.start();
      // Non-blocking: `start()` only arms a delayed timer (Phase 2N-B —
      // `DEFAULT_STARTUP_CHECK_DELAY_MS`); it never awaits network I/O here,
      // so it cannot delay window creation, login, or checkout.
      updateService.start();
      installPowerLifecycleHandlers(powerMonitor, {
        logger,
        getDatabase: () => productionDatabase?.connection ?? null,
        getMaintenanceState: () => maintenanceCoordinator.status(),
        onResumeSafetyCheck: (safety) => {
          // Reuse the EXISTING critical-safe status surface (`ARCHITECTURE.md`
          // Decision 32) — this never opens/closes/reassigns the database
          // connection itself, only reports what is already true.
          if (!safety.databaseOpen || !safety.schemaValid) {
            setDatabaseStatus({
              state: 'unavailable',
              schemaVersion: null,
              failureCode: !safety.databaseOpen
                ? 'DATABASE_UNAVAILABLE'
                : 'MIGRATION_HISTORY_INVALID',
            });
          }
        },
        // Reuse the existing stale-`EXPORTING`-job recovery (already run at
        // startup and at the top of every drain pass) — no new worker logic.
        onResumeExportRecovery: () => googleExportWorker?.recoverStale(),
        onResumeClockRebaseline: () => clockWatcher.resetBaseline(),
      });

      restoreService = createRestoreService({
        logger,
        databaseFile: paths.databaseFile,
        backupsRoot: paths.backups,
        userDataDir: paths.userData,
        targetSchemaVersion: targetSchemaVersion(activeMigrations),
        coordinator: maintenanceCoordinator,
        getCurrentDatabase: () => productionDatabase,
        quiesceBackgroundWork,
        openDatabase: () =>
          ProductionDatabase.open({
            filename: paths.databaseFile,
            backupDir: paths.backups,
            logger,
            appVersion: app.getVersion(),
            migrations: activeMigrations,
          }),
        activateDatabase: (pdb, context) => {
          wireDatabaseBackedServices(pdb as ProductionDatabase);
          if (context?.restored) {
            // Restore-specific lifecycle ordering (2L-B final corrections):
            // rebuild GoogleConfigService against the restored connection
            // (above) → let it narrowly inspect the restored credential
            // relationship and persist a quarantine if necessary → only THEN
            // resume ordinary reconcileAtStartup/provisioning/worker/scheduler
            // background work. `restoreService` itself never learns this
            // step's name or what it does — it only signals "a restore just
            // completed" via `context.restored`.
            const configService = googleConfigService;
            const prepared = configService
              ? configService.prepareRestoredCredentialState().catch((error: unknown) => {
                  logger.error('google', 'google.restore-reconcile-failed', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                })
              : Promise.resolve();
            void prepared.then(() => startBackgroundWork());
          } else {
            startBackgroundWork();
          }
        },
      });

      registerIpcHandlers({
        logger,
        paths,
        appVersion: app.getVersion(),
        buildIdentity,
        installationId,
        crashEvidence,
        activityHistory,
        getDatabase: () => productionDatabase,
        getBackupService: () => backupService,
        getRestoreService: () => restoreService,
        maintenanceCoordinator,
        // Phase 2L-C.4: the native "Browse for a backup file…" dialog is
        // main-owned; `mainWindow` is read lazily so the current window
        // applies even though it is not created until after this call.
        showBackupFileDialog: createBackupFileDialogOpener(() => mainWindow),
        // Phase 2L-C.1: the native off-device destination directory dialog is
        // main-owned the same way.
        showOffDeviceDirectoryDialog: createOffDeviceDirectoryDialogOpener(() => mainWindow),
        showSupportBundleSaveDialog: createSupportBundleSaveDialogOpener(() => mainWindow),
        google: {
          getService: () => googleConfigService,
          createService: buildGoogleConfigService,
        },
        updateStateInspector,
        updateService,
      });

      // (2) Open the production database — only now that we own the instance.
      try {
        // Interrupted-restore recovery FIRST (`DATA_MODEL.md §52A` step 6).
        const recovery = recoverInterruptedRestore({
          userDataDir: paths.userData,
          backupsRoot: paths.backups,
          databaseFile: paths.databaseFile,
          targetSchemaVersion: targetSchemaVersion(activeMigrations),
          logger,
        });
        if (recovery.kind === 'failed') {
          setDatabaseStatus({
            state: 'unavailable',
            schemaVersion: null,
            failureCode: recovery.failureCode,
          });
          logger.fatal('database', 'database.initialization-failed', {
            failureCode: recovery.failureCode,
          });
          mainWindow = createMainWindow(rendererEntry);
          return;
        }

        const pdb = await ProductionDatabase.open({
          filename: paths.databaseFile,
          backupDir: paths.backups,
          logger,
          appVersion: app.getVersion(),
          migrations: activeMigrations,
        });
        wireDatabaseBackedServices(pdb);
        startBackgroundWork();
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
        storageLocation: 'LOCAL_APP_DATA',
        databaseReady: productionDatabase !== null,
      });

      if (
        typeof __UPDATE_INSTALL_E2E_ENABLED__ === 'boolean' &&
        __UPDATE_INSTALL_E2E_ENABLED__ &&
        productionDatabase !== null
      ) {
        updateInstallE2eTrigger = installUpdateInstallE2eTrigger({
          buildEnabled: true,
          isPackaged: app.isPackaged,
          appName: app.getName(),
          userData: paths.userData,
          localAppData: process.env['LOCALAPPDATA'],
          diagnosticsRoot: paths.diagnostics,
          logger,
          maintenanceCoordinator,
          updateService,
        });
      }
    })
    .catch((error: unknown) => {
      logger.fatal('application', 'application.start-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    });
}
