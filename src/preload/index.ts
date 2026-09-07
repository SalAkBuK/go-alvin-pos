import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { PosApi } from '../shared/ipc';

/**
 * Preload bridge (ARCHITECTURE.md Section 8).
 *
 * Runs in a sandboxed, context-isolated world. It exposes exactly one object,
 * `window.pos`, whose methods each forward to a single named IPC channel.
 *
 * It never exposes `ipcRenderer` (or `require`, `process`, `fs`, ...) to the
 * renderer, and offers no generic "send any message" / "run any SQL" method.
 * New capabilities must be added as explicit typed methods here and as matching
 * handlers in `src/main/ipc/register.ts`.
 */
const api: PosApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appInfo),
  },
  diagnostics: {
    checkNativeSqlite: () => ipcRenderer.invoke(IPC.nativeSqliteCheck),
    databaseStatus: () => ipcRenderer.invoke(IPC.databaseStatus),
  },
};

contextBridge.exposeInMainWorld('pos', api);
