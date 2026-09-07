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
- Google Sheets integration
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

---

## External Reporting

**Google Sheets API**

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

> Every committed sale has a durable local export job. When Google Sheets is disabled, network work remains paused; enabling it later makes represented sale state eligible for export.

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

Google API credentials must only be accessible from the trusted application layer.

They must never be:

- Embedded in React bundles
- Stored inside Git
- Printed in logs
- Returned through IPC unnecessarily

The exact Google authentication approach will be finalized before Google Sheets implementation.

---

# 28. Authentication Architecture

V1 uses one shared store login.

Authentication must work offline.

The application should store only a secure representation of credentials.

Conceptual design:

```text
Entered Password
      ↓
Password verification
      ↓
Stored password hash
```

The raw password must not be stored.

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

Backup operations must respect SQLite consistency.

Restore procedures must also be tested.

V1 provides manual and recurring automatic backups, bounded retention/cleanup, visible health and failure state, and verified restore. Backup work must not corrupt or replace the open authoritative database. Every migration, including a startup migration after an update, requires a newly created SQLite-consistent backup whose existence and readability are verified first. Backup failure stops the migration but does not otherwise block sales while the active database remains healthy.

Minimal `backup_records` metadata may record backup kind, sanitized path/category, timestamps, source schema version, size, verification result, and failure code/message. The backup files remain the backup; these rows exist only for health, audit, retention, and migration evidence.

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
If required, enter maintenance mode and create/verify a pre-migration backup
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
- Authentication tokens
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
Spreadsheet ID
Worksheet configuration
```

Settings should be stored locally in an appropriate trusted location or database table.

Secrets and ordinary business settings should not necessarily use the same storage mechanism.

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
28. Manual and automatic backups use retention, health reporting, and tested restore; every migration requires a verified backup.
29. V1 updates use code-signed artifacts from an independent HTTPS feed and never require client GitHub credentials.
30. Single-instance and maintenance-safety coordination protect database ownership and active checkout.
31. Owner CSV export is read-only, and CSV import remains outside V1.
32. Health and diagnostics cover restart, sleep/resume, low storage, clock anomalies, external backlogs, and crash evidence without exposing sensitive data.

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
