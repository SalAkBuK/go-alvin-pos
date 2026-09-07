import { app, shell } from 'electron';
import type { WebContents } from 'electron';
import { isAllowedRendererNavigation, resolveRendererEntry } from './rendererEntry';
import type { RendererEntry } from './rendererEntry';

/**
 * Baseline renderer security hardening (ARCHITECTURE.md Sections 6, 29).
 *
 * The renderer already runs with `contextIsolation: true`, `nodeIntegration:
 * false`, and `sandbox: true` (see `window.ts`). This adds the process-level
 * guards that hold regardless of page URL or protocol:
 *
 * - external `https:` links open in the OS browser; every other child-window
 *   request is denied outright;
 * - `will-navigate` and `will-redirect` are constrained to the single
 *   legitimate renderer destination (see `rendererEntry.ts`) — no arbitrary
 *   `http://localhost:*`, `http://127.0.0.1:*`, or `file://` page;
 * - `<webview>` attachment is denied;
 * - all permission requests are denied.
 *
 * The production Content-Security-Policy is injected into `index.html` at build
 * time (see `build/cspPlugin.ts`).
 */

function openExternalIfHttps(url: string): void {
  if (url.startsWith('https://')) {
    void shell.openExternal(url);
  }
}

function hardenWebContents(contents: WebContents, entry: RendererEntry): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttps(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event) => {
    if (!isAllowedRendererNavigation(event.url, entry)) {
      event.preventDefault();
      openExternalIfHttps(event.url);
    }
  });

  contents.on('will-redirect', (event) => {
    if (!isAllowedRendererNavigation(event.url, entry)) {
      event.preventDefault();
      openExternalIfHttps(event.url);
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function installWebContentsHardening(entry: RendererEntry = resolveRendererEntry()): void {
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, entry);
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  });
}
