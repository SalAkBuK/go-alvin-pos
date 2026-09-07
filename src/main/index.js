'use strict';

/**
 * Native-module packaging verification spike.
 *
 * This is NOT the production application. It exists only to prove that
 * better-sqlite3 (the selected SQLite binding, ARCHITECTURE.md Section 3)
 * loads correctly from behind the Electron main-process boundary, both in
 * development and inside a packaged Windows build (asar-safe).
 *
 * Per instruction: no production schema and no backup implementation are
 * created here. The only SQLite work performed is opening a throwaway
 * diagnostic database and confirming the driver/API surface loads.
 */

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

let mainWindow = null;

function checkNativeSqliteModule() {
  // Deliberately required lazily and wrapped in try/catch so a native-module
  // load failure (e.g. missing prebuild for this platform/arch, or an asar
  // packaging problem) is reported to the renderer instead of crashing the
  // main process silently.
  try {
    const Database = require('better-sqlite3');

    // Diagnostic-only database. Lives in Electron's per-user app-data
    // directory (never the install directory), matching ARCHITECTURE.md
    // Section 13's database-location rule. No production tables are
    // created; this is not the real schema.
    const diagnosticDbPath = path.join(app.getPath('userData'), 'native-module-check.sqlite');
    const db = new Database(diagnosticDbPath);

    db.pragma('journal_mode = WAL');
    const versionRow = db.prepare('SELECT sqlite_version() AS version').get();
    const hasBackupApi = typeof db.backup === 'function';

    db.close();

    return {
      ok: true,
      dbPath: diagnosticDbPath,
      sqliteVersion: versionRow.version,
      hasBackupApi,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      moduleAbi: process.versions.modules,
      packaged: app.isPackaged,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      moduleAbi: process.versions.modules,
      packaged: app.isPackaged,
    };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 420,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// The renderer never touches better-sqlite3 directly (REQ-DB-006). It asks
// the main process for a result through a single narrow, explicit IPC
// channel, consistent with ARCHITECTURE.md Section 9's IPC rules.
ipcMain.handle('diagnostics:native-sqlite-check', () => checkNativeSqliteModule());

app.whenReady().then(() => {
  // Also write the result to disk at startup, independent of any renderer
  // interaction, so a packaged build can be verified headlessly (no human
  // needs to look at the window) by launching it, waiting briefly, and
  // reading this file back.
  const fs = require('node:fs');
  const resultPath = path.join(app.getPath('userData'), 'native-module-check-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(checkNativeSqliteModule(), null, 2));

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
