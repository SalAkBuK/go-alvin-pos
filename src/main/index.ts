import { app, BrowserWindow } from 'electron';
import { pinUserDataPath, resolveAppPaths } from './app/paths';
import { Logger } from './app/logger';
import { createMainWindow } from './app/window';
import { resolveRendererEntry } from './app/rendererEntry';
import { focusExistingWindow } from './app/singleInstance';
import { installWebContentsHardening } from './app/security';
import { registerIpcHandlers } from './ipc/register';

/**
 * Electron main-process entry point (ARCHITECTURE.md Sections 5, 7, 38, 42.4).
 *
 * FOUNDATION SCOPE: pin the application-data directory, acquire the
 * single-instance lock, stand up structured logging against that directory,
 * harden the renderer, register the narrow typed IPC surface, and open one
 * window. No database is opened, no schema or migration exists, and no POS
 * service is started.
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

if (!app.requestSingleInstanceLock()) {
  // Losing instance: do not touch the shared log file; just exit.
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

  app
    .whenReady()
    .then(() => {
      installWebContentsHardening(rendererEntry);
      registerIpcHandlers({ logger, paths });

      mainWindow = createMainWindow(rendererEntry);

      logger.info('application', 'application.started', {
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron,
        userData: userDataDir,
      });
    })
    .catch((error: unknown) => {
      logger.fatal('application', 'application.start-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    });
}
