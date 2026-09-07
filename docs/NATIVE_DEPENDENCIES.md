# Native dependency & packaging policy

Developer-facing rule. Not part of the canonical V1 specification; it records how
the current packaging configuration must be maintained. See `ARCHITECTURE.md §3`
for the original `better-sqlite3` packaging spike.

## Current state

`better-sqlite3` is the **only** native (compiled) dependency. `package.json`
sets:

```json
"build": {
  "npmRebuild": false,
  "asarUnpack": ["**/node_modules/better-sqlite3/**"]
}
```

`npmRebuild: false` is **correct only because** `better-sqlite3` v13 ships
Node-API (N-API) prebuilt binaries that are ABI-stable across the pinned
Electron runtime — it needs no compile-from-source step, and forcing one would
fail on machines without MSVC build tools. This is a property of
`better-sqlite3`, **not a general packaging truth**.

## Rule for adding any new native dependency

A "native dependency" is any package that loads a `.node` binary (directly or
transitively): e.g. `bcrypt`, `argon2`, `keytar`, `serialport`, `usb`,
`node-hid`, `sharp`, most printer/scale/scanner SDKs.

Before adding one:

1. **Confirm it ships a prebuilt binary compatible with the pinned Electron
   runtime** (N-API prebuild, or an Electron-ABI prebuild for the exact Electron
   version). Prefer pure-JS or WASM alternatives where they exist
   (e.g. `hash-wasm`, `@node-rs/argon2`).
2. **If it does not**, `npmRebuild: false` must change deliberately — either
   `npmRebuild: true` plus a build toolchain (MSVC Build Tools) in CI and on
   build machines, or a targeted `@electron/rebuild` step for that module. This
   is a packaging-architecture decision, not a drive-by change.
3. **Add the module to `asarUnpack`** so its `.node` binary is extracted beside
   the archive (a native binary cannot be `dlopen`'d from inside `app.asar`).
4. **Extend `scripts/verify-packaging.mjs`** to load the module from the
   **packaged** runtime (via `ELECTRON_RUN_AS_NODE` against the packaged
   executable), not only from `npm run dev`. Dev mode uses the system Node ABI
   and will happily load a binary that the packaged app cannot.

## Verification

`npm run verify:packaging` (run automatically by `pack:win` / `dist:win` and in
CI) asserts that the packaged Electron runtime can `require('better-sqlite3')`
and reach the SQLite Online Backup API, and that the native binary is unpacked.
Every native dependency added later must be covered by the same script.
