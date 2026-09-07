import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { resolveRendererEntry } from './rendererEntry';
import type { RendererEntry } from './rendererEntry';

/**
 * Main application window (ARCHITECTURE.md Sections 5-8).
 *
 * Security-relevant `webPreferences` are fixed here and verified by the
 * scaffold checks:
 *   - `contextIsolation: true`  — renderer and preload get isolated worlds
 *   - `nodeIntegration: false`  — no Node globals in the renderer
 *   - `sandbox: true`           — renderer runs in an OS sandbox; the preload
 *                                 may use only `electron` + the exposed bridge
 *
 * The renderer therefore has no path to Node, the filesystem, or SQLite except
 * the narrow typed IPC surface defined in `src/shared/ipc.ts`. Which URL the
 * window is allowed to load — and later navigate to — is decided once in
 * `rendererEntry.ts` and shared with `security.ts`.
 */
export function createMainWindow(entry: RendererEntry = resolveRendererEntry()): BrowserWindow {
  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (entry.devServerUrl) {
    void window.loadURL(entry.devServerUrl);
  } else {
    void window.loadFile(entry.fileEntryPath);
  }

  return window;
}
