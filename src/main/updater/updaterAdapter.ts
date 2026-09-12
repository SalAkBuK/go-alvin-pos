/**
 * The only file in this codebase permitted to `require('electron-updater')`
 * (Phase 2N-A/2N-B — `ARCHITECTURE.md` "Trusted main/application layer").
 * Nothing outside `updater/` ever imports the library directly, and the
 * renderer never sees it at all — `updateService.ts` only ever consumes the
 * narrow `UpdaterAdapter` interface below, so a real library object can
 * never leak past this one boundary.
 *
 * This module does not decide WHEN to check (that is `updateService.ts`'s
 * scheduling, Phase 2N-B). It only constructs the library's updater object,
 * points it at the configured generic-HTTPS feed via `setFeedURL` (the
 * canonical, single source of truth for the feed — see `updateFeedConfig.ts`
 * and `updateService.ts`'s module docstring for the full precedence
 * explanation), and configures the two behaviors this codebase has an
 * opinion on: `autoDownload = true` (Phase 2N-B — `UPDATE_RELEASE_STRATEGY.md`
 * §13, `REQ-UPDATE-003`: once `checkForUpdates()` finds an approved newer
 * version, electron-updater downloads it automatically, no separate
 * `downloadUpdate()` call needed) and `autoInstallOnAppQuit = false`
 * (installation/restart is still out of scope — Phase 2N-C).
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
 * than electron-updater's real `AppUpdater` — no `downloadUpdate` (automatic
 * via `autoDownload = true`, below) or `quitAndInstall` (Phase 2N-C) yet.
 * Event payloads are typed as `unknown`-ish/untrusted; the service
 * normalizer is responsible for extracting only safe fields.
 */
export interface UpdaterAdapter {
  on(event: 'checking-for-update', listener: () => void): void;
  on(event: 'update-available', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'update-not-available', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'download-progress', listener: (progress: UpdaterAdapterProgress) => void): void;
  on(event: 'update-downloaded', listener: (info: UpdaterAdapterInfo) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  /**
   * Ask the configured feed whether a newer approved version exists. The
   * library internally de-duplicates overlapping calls (returns the
   * in-flight promise rather than starting a second check/download), and —
   * with `autoDownload = true` — automatically downloads any discovered
   * update as part of this same call. Resolution/rejection carries the raw
   * library result/error; callers must never surface either directly and
   * must always attach a rejection handler (the library also emits a
   * normalized `'error'` event for the same failure).
   */
  checkForUpdates(): Promise<unknown>;
}

/** The subset of electron-updater's real `autoUpdater` this module configures. */
export interface ConfigurableAutoUpdater extends UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
}

/**
 * Point a real `autoUpdater`-shaped object at the configured generic-HTTPS
 * feed (`setFeedURL` — the single canonical source; see `updateFeedConfig.ts`
 * and `updateService.ts` for why no `app-update.yml` is required), enable
 * automatic background download (`autoDownload = true`, Phase 2N-B —
 * `REQ-UPDATE-003`), and keep automatic install-on-quit disabled
 * (`autoInstallOnAppQuit = false` — installation/restart is Phase 2N-C). A
 * pure configuration step, kept separate from `createElectronUpdaterAdapter`
 * below so it is directly unit-testable against a fake without touching the
 * real library (a raw `require('electron-updater')` cannot be intercepted
 * by a module mock).
 */
export function configureUpdaterAdapter(
  autoUpdater: ConfigurableAutoUpdater,
  feedUrl: string,
): UpdaterAdapter {
  autoUpdater.autoDownload = true;
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
