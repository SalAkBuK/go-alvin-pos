# Go Phones POS

Local-first Windows point-of-sale application for Go Phones. See [`docs/`](docs/) for
the canonical V1 specification and [`AGENTS.md`](AGENTS.md) before changing architecture.

## Status: Phase 1 foundation scaffold

This repository currently contains the **application foundation only**. It is not
a working POS. There is intentionally **no** product/inventory/customer/checkout/
sales/payment/tax/receipt/printing/Google Sheets/backup/auth/reporting/update
functionality, and **no** SQLite schema or migrations.

What exists:

| Area                        | State                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Electron main process       | window lifecycle, single-instance lock, structured logging, renderer hardening                                  |
| Preload bridge              | narrow typed `window.pos` surface — no `ipcRenderer`, no generic SQL/FS/command APIs                            |
| React + TypeScript renderer | minimal "foundation initialized" screen                                                                         |
| Typed IPC                   | `app:info`, `diagnostics:native-sqlite-check` only                                                              |
| better-sqlite3              | dependency retained, main-process-only, load proven by a throwaway diagnostic                                   |
| Tooling                     | strict TypeScript, ESLint, Prettier, Vitest (unit + integration), electron-builder (Windows), GitHub Actions CI |

## Requirements

- Node.js 22+
- npm 10+
- Windows for packaging (`npm run dist:win`)

## Scripts

| Script                     | Purpose                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`              | Run the app in development (electron-vite, HMR)                                  |
| `npm run build`            | Production bundle of main/preload/renderer into `out/`                           |
| `npm start`                | Preview the production bundle                                                    |
| `npm run lint`             | ESLint over the whole project                                                    |
| `npm run typecheck`        | `tsc --noEmit` for the Node and web TypeScript projects                          |
| `npm test`                 | Vitest unit + integration run                                                    |
| `npm run format`           | Prettier write                                                                   |
| `npm run pack:win`         | Build + package an unpacked Windows app into `release/`, then `verify:packaging` |
| `npm run dist:win`         | Build + package a Windows distributable into `release/`, then `verify:packaging` |
| `npm run verify:packaging` | Assert the packaged runtime loads `better-sqlite3` and ships the production CSP  |

## Security boundaries (see `docs/ARCHITECTURE.md` §§6, 29)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has no direct access to Node, the filesystem, or SQLite
- `better-sqlite3` is required only in the main process
- Preload exposes exactly one object (`window.pos`) of explicit typed methods
- Navigation and redirects are constrained to the single legitimate renderer
  URL (dev server origin, or the packaged `index.html` file URL); everything
  else is blocked and `https:` links open in the OS browser
- Production renderer is locked to a same-origin Content-Security-Policy,
  injected as the first child of `<head>`; the build fails if it cannot be placed

## Application data

All mutable state lives under a **pinned** application-data directory that is
independent of `package.json` `name` / `productName` / `app.getName()`:

```
%LOCALAPPDATA%\GoPhonesPOS\
  logs\
  diagnostics\
  gophones.sqlite      (planned — not created until Phase 2 persistence)
```

`src/main/app/paths.ts` calls `app.setPath('userData', …)` once at the very
start of `main`, before the single-instance lock or the logger run.

**Root choice — `%LOCALAPPDATA%`, not `%APPDATA%` (Roaming):** Electron's
default `userData` sits under Roaming AppData, which is copied between machines
on a Windows roaming profile — unsafe for a live WAL SQLite database
(`DATA_MODEL.md §54`). `%LOCALAPPDATA%` is per-machine, never roamed, and not a
OneDrive "Known Folder Move" target. `ARCHITECTURE.md §13` requires "Windows
Application Data" without mandating Roaming, and forbids cloud-sync/UNC
locations. This path is a long-term production invariant; do not change
`APP_DATA_DIRECTORY_NAME`.

Nothing mutable is written into the install directory or the repository.

## Native dependencies

`better-sqlite3` is the only compiled dependency and `npmRebuild: false` is
correct only for it. Before adding any other native module, read
[`docs/NATIVE_DEPENDENCIES.md`](docs/NATIVE_DEPENDENCIES.md).
