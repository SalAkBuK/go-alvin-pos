# Go Phones POS

Local-first Windows point-of-sale application for Go Phones. See [`docs/`](docs/) for
the canonical V1 specification and [`AGENTS.md`](AGENTS.md) before changing architecture.

## Status: Phase 2C — Customers

The application foundation (Phase 1), real SQLite persistence (Phase 2A),
**Products & Inventory** (Phase 2B), and **Customers** (Phase 2C) are implemented.

Still **not** implemented: checkout / cart / sale completion, receipt numbering,
tax, discounts, payments, the Clover / reconciliation workflow, sales history,
void, receipts, printing, the Google Sheets API and export worker,
authentication, reporting, CSV export, backup scheduling / restore UI,
application updates, and the Support & Diagnostics UI.

What exists:

| Area                        | State                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron main process       | window lifecycle, single-instance lock, structured logging, renderer hardening                                                                                                                      |
| SQLite persistence (2A)     | `ProductionDatabase` lifecycle owner; WAL + `synchronous=FULL` + FK durability policy; backup-gated versioned migrations                                                                            |
| Canonical V1 schema         | `001_initial_schema` creates the **complete** `DATA_MODEL.md` logical schema (13 tables, constraints, indexes, seed counters)                                                                       |
| Products & Inventory (2B)   | create / edit / archive / search / barcode lookup; low- & zero-stock state; initial stock + manual adjustment with atomic inventory movement and `INVENTORY_ADJUSTED` audit event; movement history |
| Customers (2C)              | create / edit / list / search by name and phone (formatting-insensitive via derived `phone_normalized`); customer detail with read-only purchase history over existing `sales`; no deletion         |
| Preload bridge              | narrow typed `window.pos` surface — `app`, `diagnostics`, `products.*`, `inventory.*`, `customers.*`; no `ipcRenderer`, no generic SQL/FS/command APIs                                              |
| React + TypeScript renderer | product-management + customers screens (list/search, add, edit, archive/adjust; customer detail + purchase history)                                                                                 |
| Typed IPC                   | `app:info`, `diagnostics:*`, `products:*`, `inventory:*`, `customers:*` — every business channel sender-validated and returning a typed result envelope                                             |
| better-sqlite3              | main-process-only; renderer bundle proven free of it by `verify:packaging`                                                                                                                          |
| Tooling                     | strict TypeScript, ESLint, Prettier, Vitest (unit + integration), electron-builder (Windows), GitHub Actions CI                                                                                     |

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
  backups\             (pre-migration backups)
  gophones.sqlite      (authoritative operational database, WAL)
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
