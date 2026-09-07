'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow, explicit preload API (ARCHITECTURE.md Section 8). Only the one
// diagnostic call needed for this packaging-verification spike is exposed;
// no generic IPC, no filesystem access, no direct database handle.
contextBridge.exposeInMainWorld('posDiagnostics', {
  checkNativeSqlite: () => ipcRenderer.invoke('diagnostics:native-sqlite-check'),
});
