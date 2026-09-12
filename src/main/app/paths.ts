import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { embeddedUpdateInstallE2eProfile } from '../updater/updateInstallE2eConfig';

/**
 * Application-data location strategy (ARCHITECTURE.md Sections 13, 46; DATA_MODEL.md Section 54).
 *
 * ## Why the location is pinned explicitly
 *
 * Electron's default `userData` path is `<appData>/<app.getName()>`, and
 * `app.getName()` is derived from `package.json` `name` (or a top-level
 * `productName`, if present). That means a routine metadata edit — adding a
 * top-level `productName`, renaming the package, or an Electron change to name
 * resolution — would silently move the entire application-data directory. For a
 * POS whose database, backups, and logs live there, that is an apparent
 * total-data-loss event.
 *
 * `pinUserDataPath()` therefore sets `userData` to a fixed, metadata-independent
 * location **once, at the very start of `main`**, before the single-instance
 * flow or the logger can create any file-backed infrastructure.
 *
 * ## Chosen root: Local AppData (`%LOCALAPPDATA%`), not Roaming (`%APPDATA%`)
 *
 * `ARCHITECTURE.md` Section 13 requires "Windows Application Data" and forbids
 * cloud-sync folders and network/UNC paths. Electron's `appData` path is
 * *Roaming* AppData, which on a machine with a Windows roaming profile is
 * copied between machines at logon/logoff — unsafe for a live WAL SQLite
 * database (`DATA_MODEL.md` Section 54). `%LOCALAPPDATA%` is per-machine, is
 * never roamed, and is not a OneDrive "Known Folder Move" target. This is a
 * long-term production invariant.
 *
 * The operational SQLite database path is defined here for a single source of
 * truth, but the FOUNDATION does not open or create it — no schema, no
 * migrations exist yet.
 */

/**
 * Canonical application-data directory name. Deliberately independent of
 * `package.json` `name`, `productName`, `app.getName()`, and electron-builder
 * metadata. Changing this string moves every user's data directory, so it must
 * never change once a release ships.
 */
export const APP_DATA_DIRECTORY_NAME = 'GoPhonesPOS';

/**
 * Resolve the per-machine local application-data root.
 *
 * Production is Windows-only (`ARCHITECTURE.md` Section 1); the non-Windows
 * branch exists only so developer machines and CI on other platforms behave
 * sanely.
 */
function localAppDataRoot(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData && localAppData.length > 0) {
      return localAppData;
    }
    return join(app.getPath('home'), 'AppData', 'Local');
  }
  return app.getPath('appData');
}

/**
 * Pin Electron's `userData` path to the canonical location. Idempotent and
 * safe to call before `app.whenReady()`. Returns the pinned absolute path.
 *
 * MUST be called before `resolveAppPaths()`, before `Logger` construction, and
 * before `app.requestSingleInstanceLock()` so that no application-owned file is
 * ever created under the implicit default location.
 */
export function pinUserDataPath(): string {
  const pinned =
    embeddedUpdateInstallE2eProfile(app.getName()) ??
    join(localAppDataRoot(), APP_DATA_DIRECTORY_NAME);
  // `app.setPath('userData', …)` requires the target directory to exist on some
  // platforms; creating our own container directory here is intentional.
  mkdirSync(pinned, { recursive: true });
  app.setPath('userData', pinned);
  return pinned;
}

export interface AppPaths {
  /** Root per-user application-data directory (the pinned `userData`). */
  readonly userData: string;
  /** Stable, non-secret installation identity stored outside the business database. */
  readonly installationIdentityFile: string;
  /** Structured-log output directory. */
  readonly logs: string;
  /** Support/diagnostics working directory. */
  readonly diagnostics: string;
  /** Root directory for SQLite backups (pre-migration in Phase 2A; automatic/manual later). */
  readonly backups: string;
  /** Location of the authoritative operational database (`DATA_MODEL.md §13`). */
  readonly databaseFile: string;
  /** Throwaway database file used only by the native-module scaffold check. */
  readonly nativeCheckDbFile: string;
}

/**
 * Derive every application path from the (already pinned) Electron `userData`
 * directory. Call `pinUserDataPath()` first.
 */
export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  return {
    userData,
    installationIdentityFile: join(userData, 'installation-id'),
    logs: join(userData, 'logs'),
    diagnostics: join(userData, 'diagnostics'),
    backups: join(userData, 'backups'),
    databaseFile: join(userData, 'gophones.sqlite'),
    nativeCheckDbFile: join(userData, 'diagnostics', 'native-module-check.sqlite'),
  };
}
