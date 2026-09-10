# Go Phones POS — Architecture

## 1. Purpose

This document defines the technical architecture for Go Phones POS V1.

The primary architectural goal is:

> The store must be able to complete sales safely even when internet connectivity is unavailable.

The system is therefore designed as a **local-first Windows desktop application**.

The local SQLite database is the operational source of truth.

External integrations such as Google Sheets and printing must not sit on the critical transaction path.

---

# 2. Core Architecture Principle

The critical sale path is:

`Checkout → Validation → SQLite Transaction → COMMIT → Sale Complete`

Only after the local transaction has successfully committed may the system perform secondary operations such as:

- Receipt printing
- Google Sheets export
- Scheduled backup work
- Future external integrations

Correct:

`Sale + durable export job → SQLite COMMIT → Receipt / Google Sheets network worker`

Incorrect:

`Sale → Google Sheets → SQLite`

A sale must never depend on internet connectivity or external services.

---

# 3. Proposed Technology Stack

## Desktop Runtime

**Electron**

Responsibilities:

- Windows desktop application lifecycle
- Native window creation
- File-system access
- SQLite access
- Printing
- Secure local configuration
- IPC communication
- Google Sheets integration, including the desktop OAuth flow (external system
  browser + temporary `localhost` loopback listener) and encrypted refresh-token
  storage (Section 27)
- V1 application update capability
- Windows packaging

---

## Frontend

**React + TypeScript**

Responsibilities:

- POS user interface
- Product management UI
- Checkout UI
- Customer UI
- Sales history
- Reporting
- Settings
- Synchronization status

React must not directly access:

- SQLite
- Node.js filesystem APIs
- Google credentials
- Native printer APIs

Those capabilities remain in the Electron main process.

---

## Database

**SQLite**

SQLite is the local operational database.

It stores:

- Products
- Customers
- Sales
- Sale items
- Payments
- Inventory movements
- Application settings
- Google Sheets export jobs
- Durable audit events
- Backup-related metadata where needed

The database must persist locally and remain usable without internet connectivity.

**Selected binding: `better-sqlite3`.** It runs synchronously, exposes the SQLite Online Backup API directly (`Database.prototype.backup()`, the mechanism `DATA_MODEL.md` Section 54 requires for backups), and must remain behind the Electron main-process boundary at all times — the renderer never requires it directly (`REQ-DB-006`).

Because it is a native Node addon, its Electron packaging behavior was verified with a scaffolding spike before adopting it:

- `better-sqlite3` v13+ uses Node-API (N-API, `NAPI_VERSION=10`), which is ABI-stable across Node.js and Electron versions. A single platform/arch prebuild (e.g. `win32-x64.node`) loaded correctly inside Electron 44's bundled runtime with **no rebuild step**, confirmed by requiring it directly under `ELECTRON_RUN_AS_NODE`.
- `electron-builder`'s default automatic native-dependency rebuild (`npmRebuild: true`) still attempts to compile from source via `node-gyp` regardless, and fails on a machine without Visual Studio Build Tools installed. The build config must set **`"npmRebuild": false`** to use the already-correct prebuild instead of forcing an unnecessary source rebuild.
- Electron packages the app into an `asar` archive by default, and a native `.node` file cannot be `dlopen`'d from inside one. The build config must include an **`asarUnpack`** pattern covering `better-sqlite3` (e.g. `"**/node_modules/better-sqlite3/**"`) so the native binary is extracted alongside the archive at build time.
- With both settings in place, requiring `better-sqlite3` from inside the packaged `app.asar` was confirmed working end-to-end against the actual packaged Electron binary (`sqlite_version()` returned successfully; `typeof db.backup === 'function'`).

These three settings (no forced native rebuild, `asarUnpack` for the native module, main-process-only access) are load-bearing for `better-sqlite3` specifically and should be treated as fixed packaging requirements, not implementation-time guesses, when the production build configuration is written.

---

## External Reporting

**Google Sheets API** — writes sale/void rows to the application's own spreadsheet.

**Google Drive API** — used only to create that spreadsheet and to re-locate it
after an ambiguous creation outcome. It runs under the **same least-privilege
`https://www.googleapis.com/auth/drive.file` OAuth scope** as the Sheets calls
(per-file access to files this application created); it does not add or widen any
scope (Section 27).

Google Sheets is a secondary export destination.

Direction:

`Go Phones POS → Google Sheets`

Google Sheets must not be used as the primary database.

---

# 4. High-Level Architecture

```text
┌─────────────────────────────────────────────┐
│               WINDOWS COMPUTER              │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │           ELECTRON APPLICATION        │  │
│  │                                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │        REACT RENDERER           │  │  │
│  │  │                                 │  │  │
│  │  │  Checkout                       │  │  │
│  │  │  Products                       │  │  │
│  │  │  Customers                      │  │  │
│  │  │  Sales History                  │  │  │
│  │  │  Reports                        │  │  │
│  │  │  Settings                       │  │  │
│  │  └───────────────┬─────────────────┘  │  │
│  │                  │ IPC                │  │
│  │  ┌───────────────▼─────────────────┐  │  │
│  │  │       ELECTRON MAIN PROCESS     │  │  │
│  │  │                                 │  │  │
│  │  │  Application Services           │  │  │
│  │  │  Database Layer                 │  │  │
│  │  │  Printing                       │  │  │
│  │  │  Google Sheets Export           │  │  │
│  │  │  Backup                         │  │  │
│  │  └───────────────┬─────────────────┘  │  │
│  │                  │                    │  │
│  │         ┌────────▼────────┐           │  │
│  │         │     SQLITE      │           │  │
│  │         │ LOCAL DATABASE  │           │  │
│  │         └─────────────────┘           │  │
│  └───────────────────────────────────────┘  │
│                                             │
└───────────────────┬─────────────────────────┘
                    │
              INTERNET OPTIONAL
                    │
        ┌───────────▼───────────┐
        │   GOOGLE SHEETS API   │
        │  Secondary Export     │
        └───────────────────────┘
```

---

# 5. Process Boundaries

Electron consists primarily of two application environments:

1. Main process
2. Renderer process

These boundaries must be respected.

---

# 6. Renderer Process

The renderer contains the React application.

It is responsible for presentation and user interaction.

Example features:

```text
renderer/
├── checkout/
├── products/
├── customers/
├── sales/
├── reports/
└── settings/
```

The renderer may:

- Display products
- Capture barcode input
- Build checkout carts
- Request a sale
- Display reports
- Show synchronization status
- Request receipt printing

The renderer must not:

- Open SQLite directly
- Read arbitrary files
- Store Google credentials
- Call native APIs directly
- Execute unrestricted Node.js code
- Construct raw SQL queries

---

# 7. Electron Main Process

The Electron main process owns privileged operations.

Responsibilities include:

- Database initialization
- Database migrations
- Product persistence
- Customer persistence
- Checkout transaction execution
- Inventory mutation
- Receipt printing
- Google Sheets export
- Backup creation
- Secure local settings
- Window lifecycle
- Single-instance enforcement
- Update lifecycle and maintenance-safety coordination
- Diagnostics, health checks, and support bundles
- Owner CSV export

The main process acts as the trusted boundary between React and the operating system.

---

# 8. Preload Layer

A restricted Electron preload script should expose a narrow application API to React.

Example conceptual API:

```text
window.pos.products.list()
window.pos.products.create()
window.pos.products.update()

window.pos.customers.search()
window.pos.customers.create()

window.pos.checkout.complete()

window.pos.sales.list()
window.pos.sales.get()

window.pos.reports.daily()

window.pos.print.receipt()

window.pos.sync.status()
window.pos.sync.retry()

window.pos.sales.void()
window.pos.backup.create()
window.pos.export.csv()
window.pos.updates.restartAndInstall()
window.pos.diagnostics.run()
window.pos.support.exportBundle()
```

React should interact with these defined APIs rather than Node.js directly.

---

# 9. IPC Architecture

Renderer-to-main communication should use typed IPC contracts.

Each IPC operation should represent a business capability.

Good:

```text
checkout:complete
products:create
customers:search
sales:get
reports:daily
receipt:print
sync:retry
```

Avoid generic interfaces such as:

```text
database:query
execute-sql
run-command
read-any-file
```

Generic privileged interfaces weaken security boundaries and make future maintenance harder.

---

# 10. Application Layer

Business logic should not live inside React components or IPC handlers.

The architecture should use application services.

Example:

```text
CheckoutService
ProductService
CustomerService
SalesService
ReportingService
PrintingService
GoogleSheetsExportService
BackupService
AuditService
UpdateService
DiagnosticsService
OwnerExportService
```

IPC handlers should be thin.

Example:

```text
IPC request
    ↓
Validate request
    ↓
CheckoutService.completeSale()
    ↓
Return structured result
```

---

# 11. Domain Layer

Business rules should live independently of the UI.

Suggested domain areas:

```text
domain/
├── products/
├── inventory/
├── sales/
├── customers/
├── payments/
├── tax/
└── receipts/
```

Examples of business rules:

- Sale quantity cannot exceed inventory.
- Selling price cannot be negative.
- Completed transactions retain historical prices.
- Receipt numbers must be unique.
- A card transaction requires cashier confirmation.
- Inventory changes must be recorded.

These rules should be testable without launching Electron.

---

# 12. Repository Layer

Database access should be isolated behind repositories.

Suggested repositories:

```text
ProductRepository
CustomerRepository
SaleRepository
PaymentRepository
InventoryRepository
SettingsRepository
ExportJobRepository
```

Example:

```text
CheckoutService
      ↓
SaleRepository
InventoryRepository
PaymentRepository
      ↓
SQLite
```

React must never call repositories directly.

---

# 13. Database Architecture

The SQLite database is the authoritative operational store.

Suggested database location:

```text
Windows Application Data
    ↓
GoPhonesPOS/
    ↓
gophones.sqlite
```

The database must not live:

- Inside the Git repository
- Inside temporary folders
- Inside the application installation directory
- In a location likely to be overwritten during updates
- Inside a cloud-sync folder (OneDrive, Dropbox, Google Drive Desktop, etc.) or on a network drive/UNC path — SQLite's WAL locking and durability guarantees (`DATA_MODEL.md` Section 54) are not assumed to hold on such filesystems

SQLite is configured with `journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`, and a busy timeout, with checkout using `BEGIN IMMEDIATE`; the concrete rationale and pragma values are fixed in `DATA_MODEL.md` Section 54 rather than decided during implementation.

---

# 14. Proposed Database Entities

Initial database entities include:

```text
products
customers
sales
sale_items
payments
inventory_movements
settings
google_sheet_export_jobs
checkout_requests
counters
audit_events
backup_records
schema_migrations
```

The exact fields are defined in `DATA_MODEL.md`.

---

# 15. Sale Transaction Boundary

Completing a sale is the most critical database operation.

The transaction should conceptually execute:

```text
BEGIN TRANSACTION

1. Validate product availability
2. Generate immutable Sale ID
3. Generate receipt number
4. Insert sale
5. Insert sale items
6. Insert payment
7. Update product quantities
8. Insert inventory movements
9. Insert Google Sheets export job
10. Insert durable audit events required by the sale, including price overrides and `SALE_COMPLETED`

COMMIT
```

If any required step fails:

```text
ROLLBACK
```

No partial transaction may remain.

---

# 15A. Card-Approved / Local-Commit-Failure Handling

The transaction above (Phase 2) is preceded by a Phase 1 that is itself ordered into two independently committed steps, specifically so a durable local record exists **before Clover is ever invoked**, not merely before the sale transaction (`DATA_MODEL.md` Sections 31–31A):

```text
Cashier finalizes checkout review
      ↓
Phase 1, Step A: durable checkout_requests record committed
(request ID, fingerprint, payment method, intended total, status = PENDING_PAYMENT)
      ↓
Cashier is instructed to process that exact amount on Clover
      ↓
Clover approves charge
      ↓
Cashier confirms approval in POS
      ↓
Phase 1, Step B: durable update committed
(clover_approved_confirmed_at set, status = SUBMITTED)
      ↓
Phase 2: authoritative sale transaction attempted
      ↓
   Fails
      ↓
Sale never existed — but the Step A and Step B records survive
      ↓
Cashier is warned: check/void/refund separately in Clover
      ↓
Incident tracked in the Reconciliation Queue until resolved
```

This ordering closes a narrower gap than "record before the sale transaction": if the durable record were only written after Clover approval (as opposed to before Clover is invoked), a total loss of SQLite availability at the instant right after approval could leave a real charge with no local trace at all. Writing Step A first means the worst case is a `PENDING_PAYMENT` row with no confirmation yet — which is itself made visible once stale, rather than being indistinguishable from "no attempt happened."

For Cash, there is no external charge to protect against, so Phase 1 remains the single step it always was, written directly as `status = SUBMITTED`.

The application never fabricates a completed sale to hide this failure, never claims to know Clover's outcome except from the cashier's explicit confirmation, and never calls a Clover API to reverse or verify the charge — V1 has no direct Clover integration. Full workflow detail is in `POS_WORKFLOWS.md` Sections 30 and 35A–35B.

---

# 16. Google Sheets Queue Placement

The export job itself should be recorded inside the same transaction that creates the sale.

Example:

```text
BEGIN

Create Sale
Create Sale Items
Record Payment
Reduce Inventory
Create Inventory Movements
Create Export Job

COMMIT
```

The actual network export happens later.

This creates an important guarantee:

> Every committed sale has a durable local export job. When Google Sheets is disabled, not connected, or connected but not yet ready to sync (no Google account, or the spreadsheet/worksheets are not yet provisioned — Section 27.5), **export-delivery** network work remains paused; becoming ready and enabled later makes represented sale state eligible for export. (Bounded provisioning recovery — the startup `files.list` lookup of Section 27.5.1 and explicit `Retry Setup` — is a separate operation, not export delivery.)

---

# 17. Post-Commit Operations

After successful database commit:

```text
SALE COMMITTED
      │
      ├── UI receives success
      │
      ├── Receipt may print
      │
      └── Google export worker may run
```

Receipt printing and Google Sheets export happen outside the critical database transaction.

---

# 18. Printing Architecture

Receipt generation and printing should be separate concepts.

Example:

```text
Sale Data
   ↓
ReceiptService
   ↓
Receipt Representation
   ↓
PrintingService
   ↓
Windows Printer
```

This separation allows:

- Print
- Reprint
- Preview
- Normal printer
- Future 80mm thermal printer
- Future 58mm thermal printer

without altering transaction storage.

---

# 19. Printer Failure Behavior

If printing fails:

```text
Sale = Completed
Receipt = Available
Print attempt = Failed
```

The user should receive an error such as:

```text
Sale completed successfully.
Receipt could not be printed.

[Retry Print]
```

The application must never report that the sale failed merely because the printer failed.

---

# 20. Barcode Architecture

V1 assumes the scanner behaves as keyboard input.

Flow:

```text
Scanner
   ↓
Barcode characters
   ↓
Enter key
   ↓
React barcode input
   ↓
products.findByBarcode()
   ↓
Local SQLite lookup
   ↓
Product added to cart
```

No internet is required.

---

# 21. Offline Architecture

The core POS must have zero mandatory network dependencies.

Offline-capable features include:

```text
Application startup
Products
Inventory
Barcode lookup
Customers
Checkout
Tax
Cash payment
Card payment recording
Sales history
Reporting
Receipts
Printing
```

Network-dependent features include:

```text
Google Sheets export
Application update discovery and download
Future remote reporting
```

Failure of network-dependent capabilities must not disable offline-capable capabilities.

---

# 22. Connectivity Model

The application should not determine whether a sale is allowed based on a network-status indicator.

Instead:

```text
Local operations
→ always attempt locally

Network operations
→ attempt when appropriate
→ handle failure
→ retry later
```

An "Online/Offline" indicator may be displayed for user awareness but must not determine local transaction validity.

---

# 23. Google Sheets Export Architecture

Google Sheets synchronization is asynchronous.

Conceptual flow:

```text
Completed Sale
     ↓
Export Job = PENDING
     ↓
Export Worker
     ↓
Google Sheets API
     ↓
Success?
   /       \
 YES        NO
 ↓          ↓
EXPORTED    PENDING / FAILED
```

The worker should run independently of checkout.

---

# 24. Export Worker

A background worker inside the running desktop application should periodically inspect pending export jobs.

Conceptually:

```text
Find pending jobs
      ↓
Attempt export
      ↓
Success?
      ↓
Mark exported
```

If export fails:

```text
Increment retry count
Store error
Schedule later retry
```

The worker must not block UI responsiveness.

---

# 25. Export Idempotency

Retries must not generate duplicate Google Sheet records.

Every sale has:

```text
internal_sale_id
```

Example:

```text
f788e17a-551d-4f84-8f77-7cc4d48cf522
```

This immutable ID should accompany every Google Sheets record.

The export layer should use it to determine whether a transaction has already been exported.

Exports are revision-aware. Completing or voiding a sale advances the local export revision and makes the one job for that Sale ID pending. A successful response acknowledges only the revision sent; an older in-flight response cannot mark a newer local revision exported. The worker upserts Sales and Sale Items records for the immutable Sale ID, so a void converges the existing logical sale to `VOIDED` rather than appending another sale.

---

# 26. Google Sheets Structure

Preferred V1 structure:

```text
Google Spreadsheet
│
├── Sales
└── Sale Items
```

## Sales

One row per transaction.

## Sale Items

One row per sold item.

Both worksheets reference the same immutable internal Sale ID.

---

# 27. Google Authentication

## 27.1 Model

V1 authenticates to Google with a **desktop OAuth 2.0 authorization-code flow**,
not a service account. The store owner connects their own normal Google account;
the application never uses, imports, or asks the client for a service account,
a service-account key file, a service-account email, domain-wide delegation, or a
manually shared spreadsheet.

- The Google OAuth client is of type **Desktop app** (an installed/native
  application, not a web-server client). The **developer** owns and configures
  this OAuth client in Google Cloud; the client machine never supplies it.
- Authorization uses the user's **external system browser**. The Google
  sign-in/consent page is **never** rendered inside an Electron
  `BrowserWindow`, `<webview>`, or any embedded browser surface.
- The flow uses **PKCE**, a cryptographically random `state` value that is
  verified on the callback, and a **loopback redirect** bound only to
  `localhost` / `127.0.0.1` on an ephemeral port — never `0.0.0.0` or any
  externally reachable interface.
- The temporary loopback listener exists only for one authorization attempt and
  is shut down after success, denial, error, or timeout.

## 27.2 Failure handling

The flow must handle, as **Google-configuration failures only** (they never
touch SQLite sale capability, inventory, receipts, or reporting, and never
discard durable export jobs):

- the user closes the browser or denies access;
- the callback never arrives (timeout);
- `state` mismatch on the callback;
- token exchange failure;
- the loopback port/listener cannot be opened;
- the application shuts down mid-authorization.

## 27.3 Scopes (least privilege)

- **`https://www.googleapis.com/auth/drive.file`** — the only business-data
  scope. It grants per-file access limited to files this application creates
  (its own spreadsheet). The broad `https://www.googleapis.com/auth/drive` and
  `https://www.googleapis.com/auth/spreadsheets` scopes are **not** requested.
- **`openid`** and **`email`** — identity, used only to show which account is
  connected. `profile` is not requested unless implementation later proves it
  necessary.

The connected-account email is **display metadata only**. A durable unique
Google-user identifier, if one is retained, is the OpenID Connect **`sub`**
claim, never the email address.

## 27.4 Token storage

- The **OAuth refresh token** is the sensitive long-lived credential. It is held
  only in the trusted main process, encrypted with the operating-system
  secure-storage mechanism (`safeStorage`), in a local encrypted credential
  wrapper under the pinned `userData` directory, outside the SQLite database.
  There is **no plaintext fallback**; if secure storage is unavailable the
  application says so and does not connect.
- The credential wrapper preserves the crash-consistency model already defined
  for this integration: a monotonic credential generation/version paired with an
  active-generation marker in local settings, so a crash between writing the
  encrypted file and committing local configuration is detectable and
  reconcilable on the next launch. **"Connected"** means a usable encrypted
  OAuth credential exists and matches the locally active credential
  generation/configuration.
- The wrapper may hold only the minimum needed for safe operation: credential
  generation/version, the refresh token, the Google `sub` if retained, and the
  account email for display. Access tokens are short-lived runtime values and
  are not persisted beyond what safe operation requires.
- These must **never** be stored in SQLite, returned to the renderer, written to
  logs, included in support bundles, or committed to Git: the refresh token, any
  access token, the authorization code, the PKCE verifier (`code_verifier`), the
  ID token, and raw OAuth token responses. Central redaction
  (`SUPPORT_DIAGNOSTICS.md §14`, `§16`, `§54`) covers all of them. The account
  email is not logged by default.
- The developer OAuth client configuration (the downloaded "Desktop app" JSON)
  is a **developer/build artifact**, not a client setup artifact: it is never
  shown in Settings, returned to the renderer, or logged. An installed desktop
  OAuth app is a **public client** — its client-configuration value cannot be
  assumed to remain confidential and must not be treated as equivalent to a
  refresh token or a private key. The exact mechanism for shipping the developer
  OAuth client configuration in the packaged application is a bounded
  implementation decision to be locked during Google-integration implementation;
  this document does not define a production build-secret system.

## 27.5 Spreadsheet provisioning and ambiguous-outcome recovery

After OAuth succeeds, the application creates and configures **its own**
spreadsheet in the owner's Google account (working name `Go Phones POS Sales`;
may incorporate the canonical fixed business name) with the canonical `Sales`
and `Sale Items` worksheets (`DATA_MODEL.md §26`). The spreadsheet ID is stored
as **non-secret local configuration** once it is obtained (created or adopted —
§27.5.1). The client never enters a spreadsheet ID or a worksheet name during
normal setup.

Provisioning must be safe under an **ambiguous creation outcome** — Google
creates the spreadsheet but the application loses the response before it learns
the spreadsheet ID, then the user retries or restarts. A naive
`create → lost response → create again` flow is prohibited because it would
leave multiple `Go Phones POS Sales` spreadsheets in the account. A robust V1
design **cannot** be Sheets-API-only: the Sheets API offers no way to enumerate
a previously created spreadsheet, so an orphaned spreadsheet from a lost
response would be undiscoverable and a retry would duplicate it.

### 27.5.1 Locked V1 provisioning mechanism

V1 provisioning is **not** an implementation choice between the Drive API and the
Sheets API. It is locked as follows. The Google Drive API is enabled as another
API used under the **same `drive.file` scope** — it does not widen authorization.

**Local provisioning token.** Before any create attempt, the application
generates (or loads, if a prior attempt already generated one) a **durable local
provisioning/idempotency token** and persists it to local configuration. The
same token is reused across every retry and restart until provisioning
completes.

**Spreadsheet creation — one authoritative request.** The spreadsheet is
created with a **single Google Drive `files.create` request** that carries, in
that same request:

- the spreadsheet display name;
- MIME type `application/vnd.google-apps.spreadsheet`;
- app-private `appProperties` containing **both** a stable Go Phones POS
  integration marker **and** the durable provisioning token.

The Sheets `spreadsheets.create` call **must not** be used as the normal
provisioning path, and the pattern "create the spreadsheet, then attach
`appProperties` in a later `files.update`" is **prohibited**: if the create
succeeds but its response is lost before the separate tagging request succeeds,
the account is left with an **untagged orphan** that the recovery lookup cannot
find. The identifying `appProperties` must therefore be written by the same
authoritative `files.create` that brings the spreadsheet into existence.

**Ambiguous-create recovery.** The provisioning sequence is:

1. Generate or load the durable local provisioning token.
2. Search Drive with `files.list`, restricted under the existing `drive.file`
   authorization, for a Google-Sheets-MIME file whose `appProperties` carry the
   expected integration marker **and** this provisioning token.
3. **Exactly one** valid match → adopt its file ID.
4. **No match** → issue the single `files.create` (name + Sheets MIME type +
   `appProperties`) described above.
5. **Create response lost or otherwise ambiguous** → do **not** immediately
   create again; repeat the `files.list` recovery lookup (step 2) with the same
   durable token.
6. Adopt the matching spreadsheet once it becomes discoverable.
7. **More than one** valid match (an abnormal condition) → **stop provisioning**,
   surface a safe diagnostic / not-ready configuration state, and do **not**
   guess which spreadsheet is authoritative or delete any remote spreadsheet.
   V1 defines no automatic selection among multiple matches.

**Startup recovery boundary.** Provisioning has two distinct recovery paths, and
they are **not** the same:

- **Explicit `Retry Setup`** (owner-initiated) runs the full sequence above,
  including the single tagged `files.create` on a zero-match result.
- **Automatic startup recovery** runs **only** when local recovery state records
  that a `files.create` has already been attempted for this installation (a
  non-secret "create attempted" marker — the exact key name is an implementation
  detail — set the first time a `files.create` request is issued and reused,
  like the provisioning token, across restarts; a spreadsheet may therefore
  already exist remotely). When that marker is set and `google_spreadsheet_id`
  is not, startup **may** run **lookup only** — one `files.list` with the durable
  provisioning token:
  - exactly one non-trashed match → adopt it and complete canonical
    worksheet/header convergence automatically → **Ready to sync**;
  - more than one match → remain **Connected / setup incomplete** (safe stop);
  - **zero matches → startup must NOT issue `files.create`** → remain
    **Connected / setup incomplete** and offer `Retry Setup`.

  When the "create attempted" marker is **not** set — an ordinary
  `Connected / setup incomplete` state where provisioning failed at or before
  the lookup and no create request was ever issued — startup performs **no**
  Drive or Sheets network work at all: no `files.list`, no `files.create`, no
  worksheet mutation. The state and its sanitized reason persist across
  restarts, and recovery is only through explicit `Retry Setup`.

This preserves ambiguous-create restart recovery while ensuring that merely
launching the application (for example, a cashier opening the POS after the
owner left setup incomplete) never creates or mutates files in the owner's
Google Drive.

**Worksheet convergence (idempotent).** After a spreadsheet ID is obtained or
adopted, the application uses the **Sheets API** to inspect and converge the
structure to the canonical `Sales` and `Sale Items` worksheets
(`DATA_MODEL.md §26`):

- inspect existing worksheet titles/IDs first;
- create a canonical worksheet only if it is missing;
- reuse an existing canonical worksheet;
- never blindly add a second worksheet in the same canonical role after an
  ambiguous response — re-inspect instead;
- verify the final canonical structure (both worksheets present with the
  required columns) before the integration is declared **Ready to sync**.

If a specific required Drive or Sheets call is proven against live Google to need
a broader scope than `drive.file`, that is an explicit escalation decision —
never a silent scope change. What remains subject to live verification is only
the concrete request/response detail, not the mechanism above.

### 27.5.2 Post-provisioning lifecycle — transient vs structural spreadsheet failure

Once `setupState` is **Ready to sync**, the stored `google_spreadsheet_id`
alone does **not** remain an authoritative Ready target after the application
has obtained a **definite structural failure** proving the configured remote
spreadsheet can no longer be used. The export worker's own request outcomes
classify the failure.

**Transient failures** — network outage, timeout / aborted request, an
ambiguous (`unknownOutcome`) result, an HTTP 5xx, or an HTTP 429 rate limit:

- do **not** invalidate the spreadsheet configuration;
- `google_spreadsheet_id` and the **Ready to sync** state are preserved;
- the existing export-engine rules apply unchanged (`DATA_MODEL.md §23`-`§25`:
  definite-failure backoff/retry; `unknownOutcome` leaves the job `EXPORTING`
  for the 5-minute stale recovery);
- the local sale remains authoritative and unaffected.

**Structural spreadsheet-target failures** — the configured spreadsheet is
definitely unavailable / not found (deleted or trashed); or the application
definitely no longer has permission to use it (the per-file `drive.file` grant
was revoked); or the configured spreadsheet can no longer satisfy the canonical
export-target contract. These correspond to a **definite** (not
`unknownOutcome`) Google result that unambiguously identifies the configured
spreadsheet target as not-found or not-permitted. The application may confirm
the result on the export job's normal retry before acting, so a single
transient blip is not misclassified.

Once such a structural failure is **established for the configured target**:

- local sale / inventory / payment / receipt state is unchanged;
- the export job keeps its canonical failure/retry evidence (it is not
  discarded);
- the integration **stops presenting the spreadsheet as Ready** merely because a
  stale ID exists — the locally usable spreadsheet target
  (`google_spreadsheet_id`) is **cleared/invalidated**;
- the **OAuth connection is preserved** when the credential itself is still
  valid — no disconnect, no forced re-authorization;
- `setupState` transitions **Ready to sync → Connected / setup incomplete**,
  with a persisted sanitized setup-incomplete reason stating that the Google
  spreadsheet needs attention;
- the export worker makes **no further spreadsheet export writes** while setup is
  incomplete (jobs stay queued and durable);
- the UI visibly explains that the Google spreadsheet needs attention and offers
  **`Retry Setup`**;
- the owner is **not** forced to disconnect or re-authorize solely because the
  spreadsheet was deleted or access was lost.

The export worker must **never** automatically create a replacement spreadsheet
from an export failure. Recovery that requires creation is only through the
explicit **`Retry Setup`** workflow (`POS_WORKFLOWS.md §71`), which reuses the
existing OAuth credential and the existing durable provisioning token, performs
the canonical Drive lookup first, and — on a zero-match result — may issue the
single tagged `files.create` for a replacement, then converges and verifies the
canonical worksheets before returning to **Ready to sync**.

## 27.6 Boundary rules

Google OAuth credentials and configuration must only be accessible from the
trusted application layer. They must never be embedded in React bundles, stored
in Git, printed in logs, or returned through IPC unnecessarily. Authorization,
token exchange, token refresh, spreadsheet provisioning, and the loopback
listener all run in the Electron main process.

Opening the connected spreadsheet ("Open Spreadsheet") and the OAuth consent
page both use the **external system browser**; neither is a manual step the user
must perform without the application initiating it.

## 27.7 Production readiness

- Development may use Google's "Testing" OAuth publishing state with explicit
  test users.
- A production release must use an OAuth configuration published/verified
  according to Google's requirements for the requested scopes.
- The production release must not depend on the developer remaining signed in;
  each store connects its own normal Google account.
- While the authorization remains valid, normal operation must not require
  repeated sign-in — the stored refresh token keeps background export working
  across restarts.

This document does not otherwise specify Google Cloud project deployment.

---

# 28. Authentication Architecture

V1 uses one shared store login.

Authentication must work offline.

The application should store only a secure representation of credentials, using a salted, memory-hard hashing algorithm (bcrypt, scrypt, or Argon2) rather than a fast unsalted hash. The credential store is independent of the SQLite `settings` table (Section 21 of `DATA_MODEL.md`) so restoring a SQLite backup never implicitly changes or removes the currently configured shared password.

Conceptual design:

```text
Entered Password
      ↓
Password verification
      ↓
Stored password hash
```

The raw password must not be stored.

## Credential Lifecycle

```text
First launch, no credential exists
      ↓
Setup screen: create shared password (+ confirmation)
      ↓
AUTH_CREDENTIAL_CHANGED audit event
      ↓
Normal login (offline-capable) for every subsequent launch
```

- **Password change** (Settings): requires the current password plus a new password (with confirmation); records `AUTH_CREDENTIAL_CHANGED`.
- **Forgotten password / recovery**: V1 has no online identity service, so recovery is a documented local procedure requiring direct physical/administrative access to the installed application (not a self-service email/SMS reset). It resets the shared credential without touching business data.
- **Reinstall**: reinstalling the application while the existing application-data directory (and its separate credential store) is preserved requires the existing password; no credential is silently reset.
- **Brute-force backoff**: repeated consecutive failed attempts trigger an increasing delay before the next attempt is accepted. The shared login is never permanently locked, since V1 has no alternate account or online reset path to fall back on.

Future multi-user authentication can be introduced without changing the checkout transaction model.

---

# 29. Security Boundaries

Electron security requirements include:

- Renderer isolation
- No unrestricted Node access in renderer
- Explicit preload API
- Narrow IPC handlers
- Input validation
- No generic command execution
- No arbitrary SQL IPC
- No hard-coded secrets
- No secrets committed to Git

---

# 30. Input Validation

Inputs should be validated at multiple boundaries.

Example:

```text
React form
   ↓
UI validation
   ↓
IPC request
   ↓
Application-layer validation
   ↓
Domain rules
   ↓
Database constraints
```

UI validation alone is not sufficient.

Checkout-specific validation additionally aggregates duplicate cart lines by product ID before stock validation, rejects non-integer or out-of-bounds quantities and monetary values, and rejects malformed numeric input outright rather than coercing it (`DATA_MODEL.md` Section 41A).

---

# 31. Monetary Values

Money must not use unsafe floating-point calculations.

Preferred internal strategy:

Store monetary values as integer cents.

Example:

```text
$599.99
```

stored as:

```text
59999
```

instead of:

```text
599.99 floating-point
```

Examples:

```text
list_price_cents
sold_price_cents
discount_cents
tax_cents
total_cents
```

This avoids common floating-point rounding errors.

---

# 32. Tax Calculation

Tax calculation should be isolated in a domain service.

Example:

```text
TaxService.calculate()
```

Historical sales must preserve:

- Tax rate used
- Taxable amount
- Tax amount

Changing the store's configured tax rate must not affect historical transactions.

---

# 33. Receipt Number Generation

Receipt numbers should be human-readable.

Example:

```text
GP-000001
GP-000002
GP-000003
```

The database must enforce uniqueness.

Receipt-number generation must occur safely within the transaction process to prevent duplicates.

The internal sale identifier remains separate.

---

# 34. Historical Data Snapshots

Sale items must preserve transaction-time values.

For example:

```text
product_name_snapshot
listed_price_cents
sold_price_cents
quantity
discount_cents
```

This ensures an old receipt remains unchanged if the current product later changes.

---

# 35. Inventory Movements

Current product quantity alone is not sufficient for auditing.

Every stock-changing event should create an inventory movement.

Example:

```text
Product: iPhone 15
Change: -1
Reason: SALE
Sale ID: ...
Timestamp: ...
```

Required V1 movement types include:

```text
SALE
VOID_REVERSAL
MANUAL_ADJUSTMENT
INITIAL_STOCK
```

`VOID_REVERSAL` movements reverse and link to the original sale movements and are created atomically with the sale's void state and durable audit event. Return, purchase, trade-in, repair, and transfer movement types are outside V1.

---

# 36. Reporting Architecture

Reports should be calculated from local SQLite data.

Example:

```text
ReportingService.daily(date)
```

Outputs may include:

```text
transaction_count
gross_sales
discounts
tax
net_sales
cash_total
card_total
```

Normal revenue, transaction-count, and payment totals exclude `VOIDED` sales while reports and history retain separate void visibility.

A sale's reporting date is derived at query time from its authoritative `completed_at` (UTC) converted into the currently configured business timezone; it is never stored as a separate column. A late void reduces the original sale's business-date revenue retroactively (reports are always computed live and simply omit `VOIDED` sales) while the void action itself is dated by `voided_at` for audit/void-activity visibility. Full rules, including timezone-change and DST behavior, are defined in `DATA_MODEL.md` Section 4.

Google Sheets must not be queried to generate primary POS reports.

---

# 37. Backup Architecture

The SQLite database requires a separate backup strategy.

Google Sheets is not a complete database backup.

Backup architecture should support:

```text
SQLite operational database
        ↓
Safe backup procedure
        ↓
Backup copy
```

Backup operations must respect SQLite consistency. Because the operational database runs in WAL mode (`DATA_MODEL.md` Section 54), a backup or pre-restore recovery copy must be produced through a SQLite-consistent snapshot/backup mechanism — either a SQLite backup API/equivalent safe snapshot taken while the database remains open, or a raw file copy taken only after the database has been safely quiesced/closed with WAL fully checkpointed. Copying only the live main `.sqlite` file while connections or WAL activity may exist is prohibited; see `DATA_MODEL.md` Section 54, "Backup and Recovery-Copy Safety Under WAL," for the full rule and why it applies identically to automatic, manual, and pre-migration backups and to the pre-restore recovery copy.

Restore procedures must also be tested.

V1 provides manual and recurring automatic backups, bounded retention/cleanup, visible health and failure state, and verified restore. Backup work must not corrupt or replace the open authoritative database. Every migration that modifies an existing initialized database — including a startup migration after an update — requires a newly created SQLite-consistent backup whose existence and readability are verified first, and whose evidence is durably recorded, before any migration change is applied. The first-time creation of a brand-new empty database (`001_initial_schema`) is bootstrap initialization and is the sole exception: no prior authoritative state exists to preserve, and the tables that hold backup evidence do not exist until that migration runs. Once an initialized database exists, no schema migration may modify it without a verified pre-migration backup. Backup failure stops the migration but does not otherwise block sales while the active database remains healthy.

Minimal `backup_records` metadata may record backup kind, location kind (same-disk vs. off-device), sanitized path/category, timestamps, source schema version, size, verification result, and failure code/message. The backup files remain the backup; these rows exist only for health, audit, retention, and migration evidence.

## Local Recovery vs. Device/Disk-Loss Protection

Every V1 automatic and pre-migration backup defaults to the same disk as the operational database (`location_kind = LOCAL_DISK`). This protects against accidental deletion, application-level corruption, and a bad migration — it does **not** protect against loss of the machine or disk itself. An optional, separately configured off-device destination (`location_kind = OFF_DEVICE`) is required for that protection. Backup health displays and documentation must state this distinction explicitly rather than implying a same-disk backup survives hardware loss.

## Restore Safety

A whole-database restore never silently replaces the active database. Before restoring, the trusted layer preserves a SQLite-consistent snapshot of the current database (not a raw file copy — see above), compares the candidate backup's metadata and latest sale timestamp against the current database's latest sale timestamp, warns and requires explicit confirmation if the current database is newer, and validates the restored database before reopening checkout — falling back to the preserved pre-restore copy if validation fails. V1 restore is a whole-database replace-or-abort operation with no record-level merge (`DATA_MODEL.md` Section 52A).

---

# 38. Application Startup Sequence

Conceptual application startup:

```text
Launch Go Phones POS
       ↓
Initialize Electron
       ↓
Acquire single-instance lock
       ↓
Already running? Focus/restore existing instance and exit
       ↓
Locate application-data directory
       ↓
Open SQLite
       ↓
Inspect schema and migration requirement
       ↓
If upgrading an existing initialized database, enter maintenance mode and create/verify a pre-migration backup (skipped for first-run bootstrap of 001_initial_schema)
       ↓
Run pending migrations; stop safely on backup, migration, or validation failure
       ↓
Validate database state
       ↓
Initialize services
       ↓
Start export worker
       ↓
Create application window
       ↓
Display login
```

Internet must not be required during startup.

---

# 39. Application Shutdown

Before shutdown:

- Database writes must complete safely.
- SQLite connections should close cleanly.
- In-flight Google exports may stop safely.
- Pending exports remain stored for future retry.

The application must never require all Google Sheets jobs to finish before closing.

---

# 40. Error Model

Application errors should distinguish between critical and non-critical failure.

## Critical

Examples:

- Cannot open SQLite database
- Cannot commit sale
- Database corruption detected
- Migration failed or cannot begin without a verified backup

Expected behavior:

Do not claim transaction success.

---

## Non-Critical

Examples:

- Google Sheets unavailable
- Printer unavailable
- Internet disconnected
- Update feed or download unavailable

Expected behavior:

Local POS continues operating.

---

# 41. Checkout State

The checkout UI should maintain a temporary cart before completion.

Example:

```text
Draft Cart
│
├── Items
├── Customer
├── Price Overrides
├── Discounts
├── Tax Preview
└── Payment Selection
```

The draft cart does not change inventory.

Inventory changes only after successful sale commit.

---

# 42. Duplicate Sale Protection

The UI must prevent accidental duplicate submission.

Recommended protections include:

- Disable Complete Sale while processing.
- Assign a checkout request identifier.
- Ensure main-process checkout completion cannot accidentally execute the same request twice.
- Enforce database-level uniqueness where appropriate.

UI protection alone is not sufficient.

---

## 42.1 Void Transaction Boundary

A completed sale may transition once from `COMPLETED` to `VOIDED`; it is never deleted or rewritten into a different transaction. The trusted application layer requires a reason and executes one SQLite transaction that:

```text
BEGIN IMMEDIATE
Validate sale is COMPLETED
Set status = VOIDED, voided_at, and void_reason
Restore product quantities
Insert one VOID_REVERSAL movement linked to each original SALE movement
Advance the existing Google export job revision to PENDING
Insert SALE_VOIDED audit event
COMMIT
```

Any failure rolls the entire void back. A uniqueness constraint on each reversing movement and the sale-state guard reject a second void. The payment record remains historical. A Card void warns that any Clover reversal/refund is performed separately; no Clover API call occurs.

---

## 42.2 Audit Architecture

`audit_events` is the durable, append-only local record of important business and system actions. It is distinct from bounded diagnostic logs. Business events that are part of a database mutation, including sale completion/void, price override, inventory adjustment, and audited setting changes, are inserted in the same SQLite transaction as that mutation.

Each event carries both a wall-clock `occurred_at` and a locally monotonically increasing `sequence` value; ordering questions use `sequence`, never `occurred_at` alone, since a significant system clock change (Section 42.4) must not be able to misorder the audit history.

Backup, migration, and update lifecycle events are written as soon as the authoritative database is safely available. When a database-open or migration failure prevents an audit write, structured diagnostic evidence is the required fallback; the application must never claim that an unavailable audit write succeeded.

---

## 42.3 Application Updates and Maintenance Safety

V1 distribution is:

`Private source repository → CI build/test → code-signed Windows release → independent generic HTTPS/static update feed → installed clients`

The hosting provider remains replaceable and may later use S3-compatible storage or equivalent. Installed clients access only the feed and artifacts; they require no GitHub access or token, CI/API credentials, manual normal-operation downloads, shell commands, migration operation, or update-infrastructure administration.

Update discovery and background download are secondary network work. The installed version remains usable offline and on endpoint failure. The user chooses `Restart & Update`; no forced restart occurs during active checkout.

One maintenance coordinator owns restart and exclusive database lifecycle safety. It denies or defers update restart, migration entry, and restore while a checkout is active or a sale transaction is in flight. During migration or restore, new checkout cannot begin. Update installation replaces application binaries only. Business data remains in its separate application-data location.

---

## 42.4 Health, Recovery, and Diagnostics

The trusted main/application layer owns structured rotating logs, correlation IDs, stable error codes, centralized redaction, health checks, problem reports, sanitized support bundles, and privacy-safe crash evidence. It reports application/build/schema/installation identity and database, disk, backup, internet, printer where detectable, Google queue, and update state.

On Windows sleep/resume, the application revalidates database usability and maintenance state, then refreshes connectivity, export work, printer state where practical, disk, and backup health. On application crash, abrupt termination/power loss, or Windows restart, SQLite recovery must yield fully committed or fully absent transactions; stale export work is recovered idempotently. Significant suspicious clock changes are logged and may warn, but do not alone block local sales.

Go Phones POS is single-instance. A second launch focuses/restores the existing window and exits without opening another independent database-owning POS process.

---

## 42.5 Owner CSV Export

An owner export service reads consistent SQLite snapshots and writes CSV for products/inventory, customers, sales, and inventory movements through a controlled file-save boundary. Export is read-only: failure or cancellation never changes authoritative data. V1 has no CSV import or migration path.

Any exported field value beginning with `=`, `+`, `-`, or `@` is neutralized (e.g., a leading apostrophe is prefixed) before being written, so a spreadsheet application opening the CSV cannot execute it as a formula. The same neutralization rule applies to the Google Sheets exporter (Section 25) for every text field it writes.

---

# 43. Proposed Source Layout

Suggested project organization:

```text
go-phones-pos/
│
├── docs/
│   ├── PRODUCT_SCOPE.md
│   ├── PRODUCT_REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── POS_WORKFLOWS.md
│   ├── TEST_PLAN.md
│   ├── UPDATE_RELEASE_STRATEGY.md
│   └── SUPPORT_DIAGNOSTICS.md
│
├── src/
│   │
│   ├── main/
│   │   ├── app/
│   │   ├── database/
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   ├── ipc/
│   │   ├── printing/
│   │   ├── googleSheets/
│   │   ├── backup/
│   │   └── security/
│   │
│   ├── preload/
│   │   └── index.ts
│   │
│   ├── renderer/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── products/
│   │   │   ├── checkout/
│   │   │   ├── customers/
│   │   │   ├── sales/
│   │   │   ├── reports/
│   │   │   └── settings/
│   │   └── pages/
│   │
│   ├── application/
│   │   ├── products/
│   │   ├── checkout/
│   │   ├── customers/
│   │   ├── sales/
│   │   ├── reporting/
│   │   └── sync/
│   │
│   ├── domain/
│   │   ├── products/
│   │   ├── inventory/
│   │   ├── sales/
│   │   ├── payments/
│   │   ├── customers/
│   │   ├── tax/
│   │   └── receipts/
│   │
│   └── shared/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── package.json
└── README.md
```

This is a proposed structure, not a requirement to create every folder immediately.

Only folders required by implemented functionality should be added.

---

# 44. Testing Boundaries

The architecture should support multiple levels of testing.

## Unit Tests

Examples:

- Tax calculation
- Price override rules
- Inventory calculations
- Receipt calculations

---

## Database Integration Tests

Examples:

- Sale transaction
- Rollback behavior
- Inventory movement
- Receipt uniqueness
- Export queue persistence

---

## Application Integration Tests

Examples:

- Checkout service
- Product service
- Google export state machine

---

## End-to-End Tests

Examples:

```text
Launch app
Add product
Create sale
Verify inventory
Verify receipt
```

---

## Physical Hardware Tests

Examples:

- Actual scanner
- Actual printer
- Wi-Fi disconnected
- Windows restart

---

# 45. Migration Strategy

SQLite schema changes must use versioned migrations.

Example:

```text
001_initial_schema.sql
002_add_customer_phone_index.sql
003_add_export_jobs.sql
```

The application startup process must determine which migrations have already been applied.

Migrations must be repeat-safe in the sense that already-applied migrations are not executed again.

---

# 46. Logging

The application should maintain diagnostic logs sufficient for troubleshooting.

Logs may include:

- Application startup
- Database migrations
- Database errors
- Printing failures
- Google export failures
- Backup events

Logs must not contain:

- Raw passwords
- Google secrets
- Authentication tokens, including OAuth refresh/access tokens, the
  authorization code, the PKCE verifier, ID tokens, and raw OAuth token
  responses
- Sensitive credentials

Logging full customer information should also be avoided unless necessary for debugging.

---

# 47. Configuration

Configurable business settings may include:

```text
Business name
Address
Phone
Tax rate
Receipt footer
Receipt disclaimer
Selected printer
Google Sheets enabled
```

The Google **spreadsheet ID** and the canonical **worksheet names** are managed
automatically by the application after the owner connects a Google account
(Section 27); they are not entered by the client during normal setup. They may
still exist internally as validated non-secret local configuration.

Settings should be stored locally in an appropriate trusted location or database table.

Secrets and ordinary business settings should not necessarily use the same storage mechanism. The OAuth refresh token is a secret and is never an ordinary settings row (Section 27.4, `DATA_MODEL.md §21`).

---

# 48. Future Compatibility

The V1 architecture should avoid blocking future additions such as:

- Employee accounts
- Repair management
- Trade-ins
- IMEI tracking
- Accessory inventory
- Direct Clover integration
- Multiple locations
- Cloud reporting
- Remote backups

However:

> Future compatibility must not justify building unused V2 features inside V1.

The architecture may preserve clean boundaries without implementing future functionality.

---

# 49. Explicit Architectural Non-Goals

V1 should not introduce unnecessary infrastructure such as:

- Microservices
- Kubernetes
- Always-online backend
- Distributed databases
- Event streaming platforms
- Complex cloud orchestration
- Multiple databases
- Real-time multi-location synchronization
- Server-required authentication
- Full return/refund workflows

For one local store with approximately 50 phone products, this complexity is unnecessary.

---

# 49A. V1 Operational Defaults

Several operational policies must have a concrete, documented V1 default (configurable later) so behavior remains deterministic and testable rather than implementation-defined:

| Policy | V1 Default |
|---|---|
| Automatic backup cadence | Daily at 03:00 local business time |
| Automatic backup retention | Most recent 14 days |
| Manual backup retention | 90 days |
| Log rotation | 10 MB per file, last 10 files retained, 30-day retention |
| Stale `EXPORTING` job timeout | 5 minutes of no update, then reset to `PENDING` on next worker cycle/startup |
| Google export retry backoff | Exponential, starting at 30 seconds, capped at 30 minutes between attempts |
| Export retry-exhausted behavior | After 10 consecutive failed attempts, mark `FAILED` (still manually retryable); never silently abandoned |
| Low-disk warning threshold | Below 2 GB free |
| Low-disk critical threshold | Below 500 MB free |
| Significant clock-jump threshold | A system clock change exceeding 5 minutes relative to expected elapsed time |
| Product search response target | Under 300 ms for the expected V1 catalog size |
| Barcode-to-cart-add response target | Under 200 ms |
| Checkout commit feedback target | Under 1 second under normal local conditions |
| Checkout quantity/monetary bounds | See `DATA_MODEL.md` Section 41A |

These are conservative, simple defaults chosen to avoid unnecessary enterprise complexity for a single store with roughly 50 products; each may be made owner-configurable, but the values above are what tests and behavior assume when nothing else is configured.

---

# 50. Architecture Decision Summary

The primary architectural decisions for V1 are:

1. Go Phones POS is a Windows desktop application.
2. Electron provides the desktop runtime.
3. React + TypeScript provides the renderer UI.
4. SQLite is the authoritative local operational database.
5. The application is local-first.
6. Internet connectivity is not required for core sales.
7. React does not directly access SQLite.
8. Privileged operations live in the Electron main process.
9. Preload exposes a restricted typed API.
10. Business logic lives outside UI components.
11. Database access uses repositories.
12. Sale completion is atomic.
13. Monetary values are stored as integer cents.
14. Historical sale values are snapshotted.
15. Inventory changes produce movement records.
16. Printing happens after local commit.
17. Google Sheets export happens after local commit.
18. Google Sheets synchronization is one-way in V1.
19. Google exports use a persistent local queue.
20. Google export retries must be idempotent.
21. Google credentials never live in renderer code.
22. Daily reporting uses SQLite.
23. Google Sheets is not a database backup.
24. SQLite backup and restore must be tested.
25. External failures must not invalidate committed local sales.
26. A void preserves the sale and payment, restores inventory through linked reversing movements, and is atomic.
27. Durable audit events are separate from rotating diagnostic logs.
28. Manual and automatic backups use retention, health reporting, and tested restore; every migration that modifies an existing initialized database requires a verified pre-migration backup (first-run bootstrap of `001_initial_schema` is exempt, as no prior state exists to preserve).
29. V1 updates use code-signed artifacts from an independent HTTPS feed and never require client GitHub credentials.
30. Single-instance and maintenance-safety coordination protect database ownership and active checkout.
31. Owner CSV export is read-only, and CSV import remains outside V1.
32. Health and diagnostics cover restart, sleep/resume, low storage, clock anomalies, external backlogs, and crash evidence without exposing sensitive data.
33. A Card checkout's payment method, intended total, and Clover-approval confirmation are durably recorded before the sale transaction is attempted, so a local commit failure after Clover approval is never silently lost or fabricated as a completed sale.
34. SQLite durability is fixed (WAL, synchronous=FULL, foreign_keys=ON, busy timeout), and its guarantees are documented as applying only to a local, directly attached filesystem.
35. Checkout re-validates every reviewed value against current authoritative state immediately before commit and rejects rather than silently commits on drift.
36. Local (same-disk) backups and optional off-device backups protect against different failure classes, and documentation states the difference explicitly; restore preserves a pre-restore recovery copy and requires confirmation before overwriting newer data.
37. Business date is derived at query time from UTC `completed_at` and the currently configured timezone, never stored separately; a void corrects the original sale-date's revenue and is itself dated by `voided_at`.
38. The shared credential lifecycle (first-run setup, change, local recovery, brute-force backoff) is fully defined without introducing online authentication.

---

# 51. Architectural Definition of Success

This architecture is successful when the following scenario works reliably:

```text
Internet disconnected
        ↓
Launch Go Phones POS
        ↓
Scan iPhone
        ↓
Negotiate price
        ↓
Select customer
        ↓
Select Cash
        ↓
Complete Sale
        ↓
SQLite transaction commits
        ↓
Inventory decreases
        ↓
Receipt prints
        ↓
Sale appears in history
        ↓
Google export remains pending
        ↓
Close application
        ↓
Restart Windows
        ↓
Open application offline
        ↓
Sale and inventory remain correct
        ↓
Internet reconnects
        ↓
Google export completes once
```

If this works consistently, the central architectural requirement of Go Phones POS has been achieved.
