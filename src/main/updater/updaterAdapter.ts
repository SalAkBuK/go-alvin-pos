/**
 * The only file in this codebase permitted to `require('electron-updater')`
 * (Phase 2N-A — `ARCHITECTURE.md` "Trusted main/application layer"). Nothing
 * outside `updater/` ever imports the library directly, and the renderer
 * never sees it at all — `updateService.ts` only ever consumes the narrow
 * `UpdaterAdapter` interface below, so a real library object can never leak
 * past this one boundary.
 *
 * This module does not check for, download, or install anything by itself.
 * It only constructs the library's updater object, points it at the
 * configured generic-HTTPS feed, and disables the two behaviors 2N-A is not
 * ready to own (`autoDownload`, `autoInstallOnAppQuit`) — orchestrating them
 * is 2N-B/2N-C.
 */

export type UpdaterAdapterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error';

export interface UpdaterAdapterInfo {
  readonly version?: unknown;
}
export interface UpdaterAdapterProgress {
  readonly percent?: unknown;
}

/**
 * The minimal surface `updateService.ts` depends on. Deliberately narrower
 * than electron-updater's real `AppUpdater` — no `checkForUpdates`,
 * `downloadUpdate`, or `quitAndInstall` yet, since this slice never calls
 * them. Event payloads are typed as `unknown`-ish/untrusted; the service
 * normalizer is responsible for extracting only safe fields.
 */
export interface UpdaterAdapter {
  on(event: 'checking-for-update', listener: () => void): void;
  on(event: 'update-available', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'update-not-available', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'download-progress', listener: (progress: UpdaterAdapterProgress) => void): void;
  on(event: 'update-downloaded', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
}

/** The subset of electron-updater's real `autoUpdater` this module configures. */
export interface ConfigurableAutoUpdater extends UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
}

/**
 * Point a real `autoUpdater`-shaped object at the configured generic-HTTPS
 * feed and disable the two behaviors 2N-A is not ready to own —
 * `autoDownload` and `autoInstallOnAppQuit` — since orchestrating either is
 * 2N-B/2N-C's job, not this foundation's. A pure configuration step, kept
 * separate from `createElectronUpdaterAdapter` below so it is directly
 * unit-testable against a fake without touching the real library (a raw
 * `require('electron-updater')` cannot be intercepted by a module mock).
 */
export function configureUpdaterAdapter(
  autoUpdater: ConfigurableAutoUpdater,
  feedUrl: string,
): UpdaterAdapter {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  return autoUpdater;
}

/**
 * Construct the real electron-updater-backed adapter for a generic HTTPS
 * feed. Never called for an unpackaged/development run (`updateService.ts`
 * gates that). This function can throw (e.g. the module fails to load
 * outside a real Electron process, or `setFeedURL` rejects a malformed
 * config); catching that is the caller's job (`updateService.ts`'s
 * fail-open construction).
 */
export function createElectronUpdaterAdapter(feedUrl: string): UpdaterAdapter {
  // Lazy `require` (not a static import) keeps electron-updater entirely out
  // of any module-load path that doesn't actually run packaged — importing
  // this file, or `updateService.ts`, never touches the library. Accessing
  // `.autoUpdater` (a lazy getter in electron-updater) is what actually
  // constructs its updater instance, which requires a real Electron `app`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as {
    autoUpdater: ConfigurableAutoUpdater;
  };
  return configureUpdaterAdapter(autoUpdater, feedUrl);
}
