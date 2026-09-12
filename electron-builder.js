/**
 * electron-builder configuration (Phase 2N-B follow-up fix).
 *
 * Moved out of `package.json`'s `"build"` field into this standalone,
 * officially-supported config file for exactly one reason: `publish.url`
 * needs a computed fallback when `GO_PHONES_UPDATE_FEED_URL` is unset, and
 * electron-builder's own `${env.X}` macro THROWS
 * (`ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED`) if the variable is undefined —
 * there is no macro syntax for a default value. A plain `.js` config can
 * compute that fallback with `process.env.X || fallback`, which a static
 * JSON `package.json` field cannot.
 *
 * ## Why `publish` is required at all (not just for the URL)
 *
 * `package.json` has a `repository` (GitHub) field. Per electron-builder's
 * own `PublishManager` (`getPublishConfigsForUpdateInfo` in
 * `app-builder-lib/out/publish/PublishManager.js`): "if no publish config,
 * detect using repository info... default publish config is github, file
 * should be generated regardless of publish state." Without an EXPLICIT
 * `publish` block here, electron-builder would silently bake a `provider:
 * github` (this repo's owner/name) into the generated `app-update.yml` —
 * exactly the client GitHub dependency `REQ-UPDATE-010` and this codebase's
 * `updateFeedConfig.ts` forbid. The `generic` provider below exists
 * specifically to override that default, not to introduce a second
 * meaningful feed source (see `src/main/updater/updateService.ts`'s module
 * docstring for the full canonical-source explanation: `setFeedURL()` at
 * runtime is authoritative for which URL/provider a real check/download
 * uses; this file's `publish.url` is consulted by electron-updater only as
 * a fallback default and is never reachable in practice because the
 * runtime service never calls `checkForUpdates()` unless
 * `GO_PHONES_UPDATE_FEED_URL` — the SAME variable — is configured, in which
 * case both values are identical).
 *
 * `win.target` includes `nsis` alongside the existing `dir` target:
 * `app-update.yml` generation (needed for `getOrCreateDownloadHelper()`'s
 * `updaterCacheDirName` — see `updateService.ts`) is tied to an
 * auto-updatable installer target in electron-builder; the `dir` target
 * alone can never produce it (empirically confirmed in Phase 2N-B). `dir`
 * is kept so `npm run pack:win`'s existing fast `--dir`-only dev loop
 * (which overrides the target list on the CLI) is completely unaffected.
 */

const FALLBACK_UPDATE_FEED_URL = 'https://updates.invalid.example/gophones-pos/';
const windowsPublisherName = process.env.GO_PHONES_WINDOWS_PUBLISHER_NAME?.trim();

// Phase 2N-E2 packaged update-install E2E identity switch. `PRODUCTION_*` are
// this app's real, permanent identity and MUST NEVER change here. The
// `UPDATE_INSTALL_E2E_*` pair is a distinct, test-only NSIS install identity
// so a real installed-A → real-installed-B update round trip can be proven
// on this machine without ever touching the real Go Phones POS installation,
// Program Files entry, uninstall registration, or updater cache. It only
// activates when `GO_PHONES_UPDATE_INSTALL_E2E_BUILD=1` is set for THIS
// electron-builder invocation — `npm run pack:win` / `npm run dist:win` never
// set it, so ordinary production/dev packaging is completely unaffected.
// These two string literals are intentionally duplicated (not imported) from
// `src/main/updater/updateInstallE2eConfig.ts`, because this file is loaded
// directly by the electron-builder CLI (no TypeScript/bundler step); their
// equality is asserted by `tests/unit/update-install-e2e.test.ts`.
const PRODUCTION_APP_ID = 'com.gophones.pos';
const PRODUCTION_PRODUCT_NAME = 'Go Phones POS';
const UPDATE_INSTALL_E2E_APP_ID = 'com.gophones.pos.update-e2e';
const UPDATE_INSTALL_E2E_PRODUCT_NAME = 'Go Phones POS Update E2E';
const updateInstallE2eBuild = process.env.GO_PHONES_UPDATE_INSTALL_E2E_BUILD === '1';
const appId = updateInstallE2eBuild ? UPDATE_INSTALL_E2E_APP_ID : PRODUCTION_APP_ID;
const productName = updateInstallE2eBuild
  ? UPDATE_INSTALL_E2E_PRODUCT_NAME
  : PRODUCTION_PRODUCT_NAME;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId,
  productName,
  npmRebuild: false,
  files: ['out/**/*', 'package.json'],
  asarUnpack: ['**/node_modules/better-sqlite3/**'],
  win: {
    target: ['nsis', 'dir'],
    signAndEditExecutable: true,
    signExecutable: true,
    verifyUpdateCodeSignature: true,
    ...(windowsPublisherName ? { publisherName: windowsPublisherName } : {}),
  },
  nsis: {
    // Deliberately NOT derived from `productName`: `release-lib.mjs`'s
    // `expectedInstallerName()` (used by the real release pipeline and by
    // the E1/E2 update E2E harnesses) hardcodes this exact production
    // artifact name. The E2E installer's on-disk file name staying constant
    // is harmless — it never leaves the harness's own temporary build
    // directory — while the INSTALLED identity (Program Files folder,
    // uninstall registration, shortcuts, updater cache) still comes from
    // `appId`/`productName` above and is genuinely distinct for E2E builds.
    artifactName: 'Go Phones POS Setup ${version}.${ext}',
    // E2E only: a MANUAL silent (`/S`) install of A must not auto-launch a
    // harness-uncontrolled process that could grab the single-instance lock
    // before the harness launches A itself with the required isolated
    // environment. This does not affect the real update path: electron-
    // updater's `quitAndInstall()` invokes the update installer with its own
    // explicit `--force-run` switch, which relaunches the app regardless of
    // this build-time default (confirmed against the installed
    // `electron-updater` package's NSIS invocation in Phase 2N-C/E2).
    ...(updateInstallE2eBuild ? { runAfterFinish: false } : {}),
  },
  publish: [
    {
      provider: 'generic',
      url: process.env.GO_PHONES_UPDATE_FEED_URL || FALLBACK_UPDATE_FEED_URL,
      channel: 'latest',
    },
  ],
  directories: {
    output: 'release',
  },
};
