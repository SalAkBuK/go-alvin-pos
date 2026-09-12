# Packaged Update Install E2E (Phase 2N-E2)

Run the Windows-only, real, install-affecting update round trip with:

```powershell
npm run test:update:e2e:install
```

This goes one step further than the download-only E1 harness
(`docs/PACKAGED_UPDATE_DOWNLOAD_E2E.md`): it genuinely **installs** version A
via its real NSIS installer, drives the real update flow to a genuine
**install of version B over it** (`UpdateService.restartAndInstall()` →
`electron-updater`'s `quitAndInstall()` → the real NSIS updater → B
relaunching), and proves business data survives the swap. It never bypasses
`restartAndInstall()`, never invokes an installer directly as the "update"
step, and never touches the real production installation or its data.

## A distinct, compile-time-only E2E identity

A real install/uninstall round trip must never collide with a real Go Phones
POS installation. `electron-builder.js` reads `GO_PHONES_UPDATE_INSTALL_E2E_BUILD=1`
(set only by this harness's own build step) and swaps in a completely
separate identity for that one electron-builder invocation:

| | Production | E2E build |
| --- | --- | --- |
| `appId` | `com.gophones.pos` | `com.gophones.pos.update-e2e` |
| `productName` | `Go Phones POS` | `Go Phones POS Update E2E` |
| `package.json` `name` (`extraMetadata.name`) | `go-phones-pos` | `go-phones-pos-update-e2e` |

The `package.json` name override matters more than it looks: electron-builder's
**per-user** (non-`perMachine`) NSIS default install directory is derived from
the package **name**, not `productName` — confirmed empirically during this
slice's development, when an early build without this override silently
landed at the exact same `%LOCALAPPDATA%\Programs\go-phones-pos` a real
per-user production install would use. `assertSafeInstallRoot()` in
`update-install-e2e-lib.mjs` hard-codes the E2E package name so install,
uninstall, and cleanup can never target that real path.

`src/main/updater/updateInstallE2eConfig.ts`'s `applyUpdateInstallE2eAppName()`
separately forces `app.getName()` to the E2E product name at runtime (called
before anything else touches `app`), because Electron's `app.getName()` reads
`package.json`'s `name` field, not `productName` — this keeps the two
identity-bearing values distinct for their own separate purposes without
needing an npm-unsafe, human-readable `name` override.

Every one of these identity strings is duplicated (not imported) across three
toolchains with no shared module resolution — the TypeScript config module,
the plain-Node harness library, and the plain-CJS `electron-builder.js` — and
their equality is asserted by `tests/unit/update-install-e2e.test.ts`.

## The compile-time-only trigger

`src/main/updater/updateInstallE2eTrigger.ts` is a one-shot, main-process-only
action. It is inert in every ordinary build: `__UPDATE_INSTALL_E2E_ENABLED__`
is a Vite `define` constant baked to `false` unless the build explicitly opts
in, and even then it only arms when the packaged runtime *also* presents the
matching runtime marker (`GO_PHONES_UPDATE_INSTALL_E2E_RUNTIME=1`), the exact
E2E app name, and a `userData` path that resolves under the guarded E2E
profile. Once armed, it does nothing until the harness writes one fixed, empty
marker file (`diagnostics/update-install-e2e.trigger`); it then exercises the
**real** `MaintenanceCoordinator` (claims a draft cart, proving
`CHECKOUT_ACTIVE` deferral), clears it, and calls the **real**
`UpdateService.restartAndInstall()`. It accepts no path, command, feed URL, or
installer location from anywhere. `scripts/verify-packaging.mjs` scans the
packaged production bundle to confirm the runtime marker name and the trigger
file name are both absent.

## Business-data profile isolation

A and B share one **compile-time-baked** business-data profile
(`__UPDATE_INSTALL_E2E_PROFILE__`, embedded via the same `GO_PHONES_UPDATE_INSTALL_E2E_PROFILE`
value passed to both builds), so the file path survives even the relaunch of B
by the NSIS updater — a process the harness does not spawn directly and so
cannot re-inject environment variables into once it starts, other than what
inherits down the process tree. `LOCALAPPDATA` is *also* set on the harness's
own launch of the installed A executable, purely as an extra runtime
cross-check (`updateInstallE2eRuntimeAllowed`); it is not what determines the
actual database path.

## Fixture and preservation proof

Once A is genuinely installed and launched once (creating the schema),
`update-install-e2e-lib.mjs` seeds one deterministic, schema-valid row per
table directly with `better-sqlite3` — product, customer, sale, sale item,
payment, inventory movement, audit event, a `PENDING` Google export job,
checkout request, and a settings row — and captures pre-update evidence as
logical facts (row values, counts, the receipt/audit counters), never raw
bytes. After B starts, the same facts are recaptured and compared;
`compareBusinessEvidence()` flags any changed value, any row-count drift
(duplicates), a no-longer-`PENDING` export job, or a failed
`integrity_check`/`foreign_key_check`. Receipt-sequence continuity is proven
by allocating one more receipt after B starts and asserting it is exactly one
past where the fixture left it — never reset.

## Evidence and qualification

The command prints the source revision, both test-only versions
(`0.1.100` → `0.1.101`), the real READY state sequence, the real
`CHECKOUT_ACTIVE` deferral and trusted-install-acceptance log evidence, B's
own `application.started` record, and the preservation/receipt-continuity
results, followed by:

```text
FUNCTIONAL PACKAGED UPDATE INSTALL VERIFIED
PRODUCTION AUTHENTICODE NOT VERIFIED LOCALLY
```

Unsigned local artifacts prove the install/update/business-data-preservation
mechanism only. Production release signing remains governed by the release
pipeline (`docs/UPDATE_RELEASE_STRATEGY.md`) and is not weakened or claimed by
this E2E. Cleanup uninstalls the E2E-identity install via its own generated
uninstaller and removes only paths under its dedicated
`%TEMP%\gpp-update-install-e2e-*` run root — the same defensive-prefix
discipline as `docs/PACKAGED_UPDATE_DOWNLOAD_E2E.md`.
