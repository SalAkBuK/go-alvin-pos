import { isAbsolute, basename, dirname, normalize, resolve } from 'node:path';

export const PRODUCTION_UPDATE_APP_ID = 'com.gophones.pos';
export const PRODUCTION_UPDATE_PRODUCT_NAME = 'Go Phones POS';
export const UPDATE_INSTALL_E2E_APP_ID = 'com.gophones.pos.update-e2e';
export const UPDATE_INSTALL_E2E_PRODUCT_NAME = 'Go Phones POS Update E2E';
export const UPDATE_INSTALL_E2E_PACKAGE_NAME = 'go-phones-pos-update-e2e';
export const UPDATE_INSTALL_E2E_RUN_PREFIX = 'gpp-update-install-e2e-';
export const UPDATE_INSTALL_E2E_RUNTIME_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_RUNTIME';
export const UPDATE_INSTALL_E2E_BUILD_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_BUILD';
export const UPDATE_INSTALL_E2E_PROFILE_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_PROFILE';
export const UPDATE_INSTALL_E2E_PROFILE_LEAF = 'GoPhonesPOS';

declare const __UPDATE_INSTALL_E2E_ENABLED__: boolean | undefined;
declare const __UPDATE_INSTALL_E2E_PROFILE__: string | undefined;

export interface UpdateInstallE2eIdentity {
  readonly appId: string;
  readonly productName: string;
  readonly packageName: string;
}

export function assertDistinctUpdateInstallE2eIdentity(
  production: UpdateInstallE2eIdentity,
  e2e: UpdateInstallE2eIdentity,
): UpdateInstallE2eIdentity {
  if (
    production.appId === e2e.appId ||
    production.productName === e2e.productName ||
    production.packageName === e2e.packageName
  ) {
    throw new Error('Packaged update install E2E identity must be distinct from production.');
  }
  return e2e;
}

export function isGuardedUpdateInstallE2eProfile(profile: string): boolean {
  if (
    !profile ||
    !isAbsolute(profile) ||
    basename(normalize(profile)) !== UPDATE_INSTALL_E2E_PROFILE_LEAF
  ) {
    return false;
  }
  let cursor = resolve(profile);
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(cursor).startsWith(UPDATE_INSTALL_E2E_RUN_PREFIX)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return false;
}

export function validateUpdateInstallE2eBuildConfig(env: NodeJS.ProcessEnv): {
  readonly enabled: boolean;
  readonly profile: string;
} {
  const enabled = env[UPDATE_INSTALL_E2E_BUILD_ENV] === '1';
  if (!enabled) return { enabled: false, profile: '' };
  const profile = env[UPDATE_INSTALL_E2E_PROFILE_ENV] ?? '';
  if (!isGuardedUpdateInstallE2eProfile(profile)) {
    throw new Error('Packaged update install E2E build profile is not safely isolated.');
  }
  return { enabled: true, profile: resolve(profile) };
}

/**
 * Force `app.getName()` to the E2E product name when this build is E2E-enabled,
 * called BEFORE `pinUserDataPath()` (which reads `app.getName()`) and before
 * anything else touches Electron's `app`. Electron's default `app.getName()`
 * for a packaged app returns `package.json`'s top-level `name` field (e.g.
 * `go-phones-pos`), never `productName` — so without this call, no build-time
 * mechanism would make `app.getName()` equal `UPDATE_INSTALL_E2E_PRODUCT_NAME`
 * without an `extraMetadata.name` package.json rewrite at build time. Doing it
 * here instead avoids that: a plain human-readable string with spaces going
 * into package.json's `name` field is exactly the kind of npm-tooling
 * assumption electron-builder is not guaranteed to tolerate.
 */
export function applyUpdateInstallE2eAppName(app: { setName(name: string): void }): void {
  const enabled =
    typeof __UPDATE_INSTALL_E2E_ENABLED__ === 'boolean' && __UPDATE_INSTALL_E2E_ENABLED__;
  if (enabled) {
    app.setName(UPDATE_INSTALL_E2E_PRODUCT_NAME);
  }
}

export function embeddedUpdateInstallE2eProfile(appName: string): string | null {
  const enabled =
    typeof __UPDATE_INSTALL_E2E_ENABLED__ === 'boolean' && __UPDATE_INSTALL_E2E_ENABLED__;
  const profile =
    typeof __UPDATE_INSTALL_E2E_PROFILE__ === 'string' ? __UPDATE_INSTALL_E2E_PROFILE__ : '';
  if (!enabled) return null;
  if (appName !== UPDATE_INSTALL_E2E_PRODUCT_NAME || !isGuardedUpdateInstallE2eProfile(profile)) {
    throw new Error('Packaged update install E2E profile guard rejected this application.');
  }
  return resolve(profile);
}

export function updateInstallE2eRuntimeAllowed(input: {
  readonly buildEnabled: boolean;
  readonly isPackaged: boolean;
  readonly appName: string;
  readonly runtimeValue: string | undefined;
  readonly userData: string;
  readonly localAppData: string | undefined;
}): boolean {
  if (
    !input.buildEnabled ||
    !input.isPackaged ||
    input.appName !== UPDATE_INSTALL_E2E_PRODUCT_NAME ||
    input.runtimeValue !== '1' ||
    !isGuardedUpdateInstallE2eProfile(input.userData) ||
    !input.localAppData
  ) {
    return false;
  }
  return resolve(input.userData) === resolve(input.localAppData, UPDATE_INSTALL_E2E_PROFILE_LEAF);
}

assertDistinctUpdateInstallE2eIdentity(
  {
    appId: PRODUCTION_UPDATE_APP_ID,
    productName: PRODUCTION_UPDATE_PRODUCT_NAME,
    packageName: 'go-phones-pos',
  },
  {
    appId: UPDATE_INSTALL_E2E_APP_ID,
    productName: UPDATE_INSTALL_E2E_PRODUCT_NAME,
    packageName: UPDATE_INSTALL_E2E_PACKAGE_NAME,
  },
);
