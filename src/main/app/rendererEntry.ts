import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';

/**
 * The single legitimate renderer destination for the current run mode
 * (ARCHITECTURE.md Sections 6, 29).
 *
 * The preload stays attached to the `BrowserWindow` across navigations, so any
 * page the window is allowed to reach receives `window.pos`. Navigation and
 * redirects must therefore be constrained to exactly one target:
 *
 * - development: the exact dev-server URL electron-vite injected
 *   (`ELECTRON_RENDERER_URL`) — not "any localhost port";
 * - packaged: the exact `file://` URL of the bundled `index.html` — not "any
 *   `file://` page".
 *
 * `window.ts` and `security.ts` both consume this so the loaded URL and the
 * allow-list can never drift apart.
 */
export interface RendererEntry {
  /** Dev-server URL to load, or `null` when the packaged file entry should be used. */
  readonly devServerUrl: string | null;
  /** Absolute path of the bundled renderer entry HTML. */
  readonly fileEntryPath: string;
  /** `file://` URL form of {@link fileEntryPath}. */
  readonly fileEntryUrl: string;
}

export function resolveRendererEntry(): RendererEntry {
  const fileEntryPath = join(__dirname, '../renderer/index.html');
  const injectedDevUrl = process.env['ELECTRON_RENDERER_URL'];
  const devServerUrl =
    !app.isPackaged && typeof injectedDevUrl === 'string' && injectedDevUrl.length > 0
      ? injectedDevUrl
      : null;

  return {
    devServerUrl,
    fileEntryPath,
    fileEntryUrl: pathToFileURL(fileEntryPath).href,
  };
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Compare only the file path of a `file:` URL — ignoring query string and hash
 * (so client-side hash routing still counts as "same document") and letter
 * case (Windows paths are case-insensitive).
 */
function normalizeFilePath(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a top-level navigation or redirect to `targetUrl` is permitted for
 * the given renderer entry. Everything else must be blocked.
 */
export function isAllowedRendererNavigation(targetUrl: string, entry: RendererEntry): boolean {
  const target = tryParseUrl(targetUrl);
  if (!target) {
    return false;
  }

  if (entry.devServerUrl) {
    const devUrl = tryParseUrl(entry.devServerUrl);
    if (
      devUrl &&
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      target.origin === devUrl.origin
    ) {
      return true;
    }
  }

  if (target.protocol === 'file:') {
    const entryUrl = tryParseUrl(entry.fileEntryUrl);
    return entryUrl !== null && normalizeFilePath(target) === normalizeFilePath(entryUrl);
  }

  return false;
}
