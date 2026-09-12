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

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.gophones.pos',
  productName: 'Go Phones POS',
  npmRebuild: false,
  files: ['out/**/*', 'package.json'],
  asarUnpack: ['**/node_modules/better-sqlite3/**'],
  win: {
    target: ['nsis', 'dir'],
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
