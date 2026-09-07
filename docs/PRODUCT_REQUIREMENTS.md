# Go Phones POS — Product Requirements

## 1. Purpose

This document defines the functional and non-functional requirements for Go Phones POS V1.

`PRODUCT_SCOPE.md` defines what is included in the product.

This document defines what the system must actually do.

Each requirement has a stable identifier so implementation, testing, bug reports, and future changes can reference the same behavior.

---

# 2. Requirement Levels

Requirements use the following priority levels:

- **MUST** — Required for V1 production release.
- **SHOULD** — Strongly desired but not required to prove the core system.
- **MAY** — Optional improvement if time and scope allow.

---

# 3. Product Management Requirements

## REQ-PROD-001 — Create Product

**Priority:** MUST

The user must be able to create a phone product.

A product must support:

- Product name
- Brand
- Model
- Condition
- Selling price
- Quantity

Optional fields may include:

- SKU
- Barcode
- Cost price

### Acceptance Criteria

- A valid product can be created.
- The product remains available after application restart.
- Product creation works without internet connectivity.

---

## REQ-PROD-002 — Product Condition

**Priority:** MUST

A product must support a basic condition classification.

Supported values should include:

- New
- Used
- Refurbished

Detailed condition grading is not required.

---

## REQ-PROD-003 — Edit Product

**Priority:** MUST

The user must be able to edit an existing product.

Editable properties must include:

- Name
- Brand
- Model
- Condition
- Selling price
- Cost price
- Barcode
- SKU
- Quantity where appropriate

Historical sales must not change when a product is edited.

---

## REQ-PROD-004 — Archive Product

**Priority:** MUST

The user must be able to deactivate/archive a product without deleting historical references.

Archived products must:

- Remain referenced by historical sales.
- Not appear as normally sellable inventory.
- Be recoverable if future product reactivation is supported.

---

## REQ-PROD-005 — Search Products

**Priority:** MUST

The user must be able to search products locally.

Search should support relevant fields such as:

- Product name
- Brand
- Model
- SKU
- Barcode

Search must work without internet access.

---

## REQ-PROD-006 — Barcode Identification

**Priority:** MUST

A product may have a barcode.

The system must be able to locate a product using the stored barcode.

---

# 4. Inventory Requirements

## REQ-INV-001 — Quantity Tracking

**Priority:** MUST

The system must track current inventory quantity for each phone product.

Example:

`iPhone 15 128GB — Quantity 5`

---

## REQ-INV-002 — Sale Inventory Deduction

**Priority:** MUST

Completing a sale must reduce inventory by the quantity sold.

Example:

Before:

`Quantity = 5`

Sale:

`Quantity sold = 2`

After:

`Quantity = 3`

---

## REQ-INV-003 — Atomic Inventory Update

**Priority:** MUST

Inventory deduction and sale creation must occur within the same local database transaction.

The system must never produce:

- A completed sale without corresponding inventory deduction.
- Inventory deduction without a completed sale.

If any required database operation fails, the entire transaction must roll back.

---

## REQ-INV-004 — Prevent Invalid Stock Sale

**Priority:** MUST

The system must prevent completing a sale where the requested quantity exceeds available stock unless a future explicit override feature is introduced.

Example:

Available:

`2`

Requested:

`3`

Expected:

Sale cannot complete.

---

## REQ-INV-005 — Inventory Movement Record

**Priority:** MUST

Every inventory-changing sale must create an inventory movement record.

The record must preserve:

- Product
- Quantity change
- Reason
- Related sale ID
- Date/time

Example:

`iPhone 15 | -1 | SALE | GP-000125`

---

## REQ-INV-006 — Manual Inventory Adjustment

**Priority:** SHOULD

The system should allow authorized users to correct inventory quantity manually.

Adjustments should record:

- Previous quantity
- New quantity or adjustment amount
- Reason
- Timestamp

---

# 5. Barcode Scanner Requirements

## REQ-SCAN-001 — Keyboard-Wedge Scanner Support

**Priority:** MUST

The application must support common USB/Bluetooth barcode scanners that behave like keyboards.

---

## REQ-SCAN-002 — Scan to Product

**Priority:** MUST

Scanning a known barcode during checkout must locate the matching product.

---

## REQ-SCAN-003 — Unknown Barcode

**Priority:** MUST

If a scanned barcode does not match a product, the application must display a clear non-fatal message.

Checkout must remain usable.

---

## REQ-SCAN-004 — Offline Scanning

**Priority:** MUST

Barcode lookup must work while the internet is disconnected.

---

# 6. Checkout Requirements

## REQ-SALE-001 — Start Sale

**Priority:** MUST

The cashier must be able to create a new checkout session.

---

## REQ-SALE-002 — Add Product

**Priority:** MUST

The cashier must be able to add one or more products to the current sale.

Products may be added by:

- Search
- Barcode scan

---

## REQ-SALE-003 — Remove Product

**Priority:** MUST

The cashier must be able to remove an item from the current cart before completing the transaction.

---

## REQ-SALE-004 — Change Quantity

**Priority:** MUST

The cashier must be able to change the quantity of a cart item.

The quantity must not exceed available stock.

---

## REQ-SALE-005 — Price Override

**Priority:** MUST

The cashier must be able to change the selling price of an item during checkout.

The system must preserve:

- Original/list price
- Actual sold price

---

## REQ-SALE-006 — Discount Calculation

**Priority:** MUST

The system must calculate the monetary difference between listed price and actual selling price where applicable.

---

## REQ-SALE-007 — Transaction Totals

**Priority:** MUST

Checkout must calculate and display:

- Subtotal
- Discount
- Tax
- Final total

---

## REQ-SALE-008 — Complete Sale

**Priority:** MUST

The cashier must be able to complete a valid sale.

Completion must:

1. Validate cart contents.
2. Validate inventory.
3. Validate payment method.
4. Begin the authoritative SQLite transaction.
5. Claim the checkout-attempt identifier and generate the immutable Sale ID and unique receipt number.
6. Create the sale and sale items.
7. Record payment.
8. Update inventory and record inventory movements.
9. Record the sale-completed audit event.
10. Create the sale's single durable Google Sheets export job.
11. Commit the SQLite transaction.
12. Make the committed receipt available for printing and allow the export worker to attempt delivery.

Steps 5 through 10 must succeed or fail as one unit. Receipt printing and network delivery to Google Sheets occur only after commit and must not invalidate the committed sale.

---

## REQ-SALE-009 — Immutable Historical Sale Values

**Priority:** MUST

Historical sales must preserve transaction-time values including:

- Product description
- Listed price
- Sold price
- Quantity
- Discount
- Tax
- Total

Later edits to the product must not change old sales.

---

## REQ-SALE-010 — Duplicate Completion Protection

**Priority:** MUST

Repeated clicking of the Complete Sale button must not create duplicate sales.

Examples include:

- Double-click
- Slow machine
- UI lag
- Accidental repeated input

A single checkout attempt must produce no more than one completed transaction.

The checkout-attempt identifier must be enforced by SQLite inside the sale transaction so retrying after a timeout, renderer crash, or uncertain response returns the original result instead of creating another sale.

---

## REQ-SALE-011 — Cancel Incomplete Sale

**Priority:** MUST

The cashier must be able to cancel or clear an incomplete checkout before transaction completion.

No inventory must be affected.

---

# 7. Receipt Number Requirements

## REQ-RECNO-001 — Unique Receipt Number

**Priority:** MUST

Every completed sale must receive a unique human-readable receipt number.

Example:

`GP-000001`

---

## REQ-RECNO-002 — Receipt Number Persistence

**Priority:** MUST

Receipt numbering must remain consistent across application restarts.

---

## REQ-RECNO-003 — No Duplicate Receipt Numbers

**Priority:** MUST

Two completed sales must never share the same receipt number.

---

## REQ-RECNO-004 — Internal Sale Identifier

**Priority:** MUST

Every sale must also have an immutable internal unique identifier separate from the receipt number.

This identifier must be suitable for:

- Database relationships
- Google Sheets synchronization
- Duplicate prevention

---

# 8. Tax Requirements

## REQ-TAX-001 — Configurable Tax Rate

**Priority:** MUST

The sales-tax rate must be configurable through application settings.

The tax rate must not be hard-coded directly into checkout logic.

---

## REQ-TAX-002 — Single V1 Tax Rate

**Priority:** MUST

V1 assumes the configured tax rate applies uniformly to products sold through the POS.

---

## REQ-TAX-003 — Tax Preservation

**Priority:** MUST

Each completed sale must preserve the actual tax amount used at transaction time.

Changing the configured tax rate later must not modify historical transactions.

---

## REQ-TAX-004 — Currency Precision

**Priority:** MUST

All persisted monetary values and calculations must use integer cents rather than floating-point currency values.

The system must consistently produce correct cent-level values.

---

# 9. Payment Requirements

## REQ-PAY-001 — Cash Payment

**Priority:** MUST

The system must allow a transaction to be recorded as Cash.

---

## REQ-PAY-002 — Card Payment

**Priority:** MUST

The system must allow a transaction to be recorded as Card.

---

## REQ-PAY-003 — Manual Clover Flow

**Priority:** MUST

V1 must assume card processing occurs separately on the client's Clover terminal.

The POS does not need to authorize the card itself.

---

## REQ-PAY-004 — Clover Confirmation

**Priority:** MUST

Before recording a card transaction as completed, the cashier must explicitly confirm that Clover payment was successfully processed.

---

## REQ-PAY-005 — Payment Record

**Priority:** MUST

Every completed sale must have an associated payment record.

At minimum, it must preserve:

- Payment method
- Amount
- Sale ID
- Timestamp

---

## REQ-PAY-006 — Amount Tendered

**Priority:** MAY

Cash checkout may support entering the amount tendered.

---

## REQ-PAY-007 — Change Due

**Priority:** MAY

If amount tendered is implemented, the POS may calculate change due.

---

# 10. Customer Requirements

## REQ-CUST-001 — Create Customer

**Priority:** MUST

The system must allow creating a customer record.

Supported information:

- Name
- Phone number

---

## REQ-CUST-002 — Optional Customer

**Priority:** MUST

A standard retail sale must be able to complete without attaching a customer.

---

## REQ-CUST-003 — Search Customer

**Priority:** MUST

The cashier must be able to search existing customers locally.

Search must support:

- Name
- Phone number

---

## REQ-CUST-004 — Attach Customer to Sale

**Priority:** MUST

An existing or newly created customer may be attached to a checkout transaction.

---

## REQ-CUST-005 — Purchase History

**Priority:** MUST

The system must allow viewing sales previously associated with a customer.

---

## REQ-CUST-006 — Offline Customer Access

**Priority:** MUST

Customer creation, search, selection, and history lookup must work offline using local data.

---

# 11. Receipt Requirements

## REQ-REC-001 — Generate Receipt

**Priority:** MUST

Every completed sale must have a printable receipt representation.

---

## REQ-REC-002 — Receipt Content

**Priority:** MUST

The receipt must support:

- Go Phones - Alvin
- Business address
- Business phone
- Receipt number
- Date/time
- Customer information when present
- Itemized products
- Quantity
- Price
- Discounts
- Subtotal
- Tax
- Total
- Payment method
- Disclaimer/policy
- Thank-you message

---

## REQ-REC-003 — Historical Receipt Integrity

**Priority:** MUST

Reprinting an old receipt must use transaction-time sale data.

Changes to current product names or prices must not alter old receipts.

---

## REQ-REC-004 — Reprint Receipt

**Priority:** MUST

The user must be able to reprint a receipt from Sales History.

---

## REQ-REC-005 — Print Failure Isolation

**Priority:** MUST

Printer failure must never roll back or invalidate an already committed sale.

Example:

1. Sale successfully commits.
2. Printer is disconnected.
3. Printing fails.
4. Sale remains completed.
5. User may reprint later.

---

# 12. Printing Requirements

## REQ-PRINT-001 — Windows Printing

**Priority:** MUST

The application must support printing through Windows-compatible printers.

---

## REQ-PRINT-002 — Existing Printer Support

**Priority:** MUST

V1 must be usable with the client's current printer.

---

## REQ-PRINT-003 — Thermal-Ready Architecture

**Priority:** SHOULD

Receipt generation should be designed so 80mm or 58mm thermal printing can be added without changing transaction records.

---

## REQ-PRINT-004 — Printer Selection

**Priority:** SHOULD

The application should allow selection of the desired receipt printer.

---

## REQ-PRINT-005 — Missing Printer

**Priority:** MUST

The absence or failure of a configured printer must not prevent sale completion.

---

# 13. Sales History Requirements

## REQ-HIST-001 — View Sales

**Priority:** MUST

The user must be able to view completed and voided sales. A voided sale must remain historically visible and clearly identified as `VOIDED`.

---

## REQ-HIST-002 — View Sale Details

**Priority:** MUST

The user must be able to inspect:

- Receipt number
- Date/time
- Customer
- Products
- Quantities
- Prices
- Discounts
- Tax
- Total
- Payment method
- Sale status
- Void timestamp and reason when voided

---

## REQ-HIST-003 — Search Sales

**Priority:** MUST

Sales must be searchable using relevant identifiers such as:

- Receipt number
- Date
- Customer

---

## REQ-HIST-004 — Google Export Status

**Priority:** MUST

Sales History must expose whether a sale's Google Sheets export is:

- Pending
- Exported
- Failed

---

# 14. Daily Reporting Requirements

## REQ-REPORT-001 — Daily Transaction Count

**Priority:** MUST

The POS must report the number of non-voided completed sales for a selected day and expose voided transactions separately.

---

## REQ-REPORT-002 — Daily Gross Sales

**Priority:** MUST

The POS must report gross sales before discounts where applicable, excluding voided revenue.

---

## REQ-REPORT-003 — Daily Discounts

**Priority:** MUST

The POS must report total discounts for the selected day, excluding voided sales.

---

## REQ-REPORT-004 — Daily Tax

**Priority:** MUST

The POS must report total tax collected, excluding voided sales.

---

## REQ-REPORT-005 — Daily Net Sales

**Priority:** MUST

The POS must report final sales totals, excluding voided sales.

---

## REQ-REPORT-006 — Cash/Card Breakdown

**Priority:** MUST

Daily reporting must separately show:

- Cash total
- Card total

These totals must exclude voided sales.

---

## REQ-REPORT-007 — Local Reporting

**Priority:** MUST

Daily reports must be generated from SQLite.

Google Sheets must not be required.

---

# 15. Offline Requirements

## REQ-OFF-001 — Offline Checkout

**Priority:** MUST

The cashier must be able to complete a sale with the computer disconnected from the internet.

---

## REQ-OFF-002 — Offline Application Launch

**Priority:** MUST

The application must launch and remain usable without internet connectivity.

---

## REQ-OFF-003 — Offline Product Search

**Priority:** MUST

Products must remain searchable offline.

---

## REQ-OFF-004 — Offline Barcode Scan

**Priority:** MUST

Barcode lookup must operate from the local database.

---

## REQ-OFF-005 — Offline Customer Operations

**Priority:** MUST

Customer search and creation must continue offline.

---

## REQ-OFF-006 — Offline Reporting

**Priority:** MUST

Sales History and daily reporting must remain usable offline.

---

## REQ-OFF-007 — Offline Printing

**Priority:** MUST

Receipt generation and local printing must not depend on internet connectivity.

---

## REQ-OFF-008 — Restart While Offline

**Priority:** MUST

After completing transactions offline, the application must be able to close and reopen while still offline without losing those transactions.

---

## REQ-OFF-009 — Windows Restart While Offline

**Priority:** MUST

Locally committed sales must survive a computer restart without internet access.

---

# 16. Google Sheets Export Requirements

## REQ-GSHEET-001 — Export Completed Sale

**Priority:** MUST

Every committed sale must have exactly one durable local export job identified by the immutable Sale ID. Network delivery must remain paused while Google Sheets export is disabled or unconfigured.

---

## REQ-GSHEET-002 — Transactional Queue and Post-Commit Export

**Priority:** MUST

The sale's durable local export job must be created inside the same SQLite transaction as the sale. Network delivery to Google Sheets must occur only after that transaction commits successfully and only while the integration is enabled and configured.

---

## REQ-GSHEET-003 — Google Failure Isolation

**Priority:** MUST

Failure of:

- Internet
- Google authentication
- Google Sheets API
- Spreadsheet access
- API rate limits

must not prevent local sale completion.

---

## REQ-GSHEET-004 — Offline Queue

**Priority:** MUST

The export job must remain stored locally until it is successfully exported or deliberately retried/resolved.

---

## REQ-GSHEET-005 — Queue Persistence

**Priority:** MUST

Pending export jobs must survive:

- Application restart
- Windows restart
- Extended internet outage

---

## REQ-GSHEET-006 — Automatic Retry

**Priority:** MUST

Pending exports must automatically retry after connectivity becomes available while the integration is enabled and configured.

---

## REQ-GSHEET-007 — Duplicate Protection

**Priority:** MUST

Retrying an export must not create duplicate transaction records.

The internal Sale ID must be used as the synchronization identity.

---

## REQ-GSHEET-008 — One-Way Synchronization

**Priority:** MUST

V1 Google Sheets integration is:

`POS → Google Sheets`

Changes made manually inside Google Sheets must not automatically modify the POS database.

---

## REQ-GSHEET-009 — Sales Worksheet

**Priority:** MUST

The configured spreadsheet must support a Sales worksheet containing one row per transaction.

---

## REQ-GSHEET-010 — Sale Items Worksheet

**Priority:** MUST

The configured spreadsheet must support a Sale Items worksheet containing individual sold items.

---

## REQ-GSHEET-011 — Export Status

**Priority:** MUST

Each local sale must expose its Google Sheets synchronization status.

---

## REQ-GSHEET-012 — Manual Retry

**Priority:** SHOULD

A failed export should provide a manual retry operation.

---

## REQ-GSHEET-013 — Credential Protection

**Priority:** MUST

Google API credentials must never be hard-coded into renderer/frontend source code.

Credentials must never be committed to Git.

---

# 17. Local Database Requirements

## REQ-DB-001 — SQLite Primary Database

**Priority:** MUST

SQLite must serve as the local operational database for V1.

---

## REQ-DB-002 — Persistent Storage

**Priority:** MUST

Database information must persist across:

- Application restart
- Windows restart

---

## REQ-DB-003 — Database Transactions

**Priority:** MUST

Multi-step business operations such as checkout must use database transactions.

---

## REQ-DB-004 — Foreign-Key Integrity

**Priority:** MUST

Database relationships must enforce appropriate referential integrity.

---

## REQ-DB-005 — Schema Migrations

**Priority:** MUST

Database schema changes must be managed through versioned migrations.

The application must not depend on manually editing an installed database.

---

## REQ-DB-006 — No Renderer Direct Database Access

**Priority:** MUST

React renderer code must not directly open or manipulate the SQLite database.

Database access must occur through the Electron main process/application service boundary.

---

# 18. Backup Requirements

## REQ-BACKUP-001 — Manual Backup Capability

**Priority:** MUST

V1 must provide an owner-initiated method of backing up the local SQLite database.

---

## REQ-BACKUP-002 — Database Backup Integrity

**Priority:** MUST

Backup operations must not produce an inconsistent or partially written SQLite database.

---

## REQ-BACKUP-003 — Google Sheets Not Backup Replacement

**Priority:** MUST

Google Sheets sales exports must not be treated as a full backup of the POS database.

---

## REQ-BACKUP-004 — Restore Testing

**Priority:** MUST

V1 must have a documented restore procedure. Before production release, a database backup must be restored successfully in a test environment.

---

## REQ-BACKUP-005 — Recurring Automatic Backup

**Priority:** MUST

V1 must create recurring automatic backups using a SQLite-safe procedure. Backup work must not corrupt the operational database or silently interrupt checkout.

---

## REQ-BACKUP-006 — Backup Retention and Cleanup

**Priority:** MUST

Automatic backups must use a documented retention and cleanup policy so storage does not grow without bound. Cleanup must preserve backups required for an active migration or recovery case.

---

## REQ-BACKUP-007 — Backup Health and Failure Reporting

**Priority:** MUST

The application must expose the time and result of the latest automatic backup, warn when backup is overdue, and make backup failures visible through diagnostics and the durable audit trail.

---

## REQ-BACKUP-008 — Verified Pre-Migration Backup

**Priority:** MUST

Before any schema migration, the application must create and verify a SQLite-consistent backup. If backup creation or verification fails, the migration must not begin.

---

## REQ-BACKUP-009 — Backup Metadata

**Priority:** MUST

The system must retain enough local metadata to identify backup type, creation time, outcome, verification state, and failure details where applicable. This metadata supports backup-health display and recovery without making a backup copy part of the operational schema.

---

# 19. Authentication Requirements

## REQ-AUTH-001 — Shared Login

**Priority:** MUST

V1 must support one shared store login.

---

## REQ-AUTH-002 — Offline Login

**Priority:** MUST

The shared login must not require an internet authentication service every time the application launches.

---

## REQ-AUTH-003 — Credential Storage

**Priority:** MUST

Authentication secrets must not be stored as plaintext passwords.

---

# 20. Security Requirements

## REQ-SEC-001 — Renderer Isolation

**Priority:** MUST

Electron renderer code must not receive unrestricted Node.js access.

---

## REQ-SEC-002 — Controlled IPC

**Priority:** MUST

Renderer-to-main communication must use explicitly defined IPC interfaces.

---

## REQ-SEC-003 — Input Validation

**Priority:** MUST

Inputs crossing application boundaries must be validated.

---

## REQ-SEC-004 — No Hard-Coded Secrets

**Priority:** MUST

API secrets, Google credentials, passwords, or other credentials must not be committed to source control.

---

## REQ-SEC-005 — Least Privilege

**Priority:** MUST

Application components must receive only the permissions required for their functions.

---

# 21. Reliability Requirements

## REQ-REL-001 — Sale Durability

**Priority:** MUST

After the application confirms a sale is completed, the transaction must remain available after restart.

---

## REQ-REL-002 — Crash Safety

**Priority:** MUST

A crash during an incomplete checkout must not result in a partially committed sale.

---

## REQ-REL-003 — Duplicate Sale Prevention

**Priority:** MUST

UI retries or repeated input must not accidentally create duplicate completed sales.

---

## REQ-REL-004 — External Integration Isolation

**Priority:** MUST

Failure of Google Sheets or printing must not compromise local transaction integrity.

---

## REQ-REL-005 — Database Failure Handling

**Priority:** MUST

If the application cannot safely commit a local sale, checkout must fail clearly rather than claim success.

---

# 22. Performance Requirements

## REQ-PERF-001 — Product Search

**Priority:** SHOULD

Product search for the expected V1 inventory size should appear effectively immediate to the cashier.

---

## REQ-PERF-002 — Barcode Response

**Priority:** SHOULD

Scanning an existing product should add or identify the product without noticeable network-like delay.

---

## REQ-PERF-003 — Checkout Responsiveness

**Priority:** MUST

Sale completion must provide clear state feedback while processing.

The user must not be encouraged to repeatedly press Complete Sale.

---

# 23. Application Packaging Requirements

## REQ-PKG-001 — Windows Installer

**Priority:** MUST

V1 must be distributable as a Windows installer.

Example:

`GoPhonesPOS-Setup.exe`

---

## REQ-PKG-002 — No Developer Tooling Required

**Priority:** MUST

The production application must run without requiring:

- Node.js installation
- npm
- VS Code
- Git
- Development server

---

## REQ-PKG-003 — Local Database Location

**Priority:** MUST

The production database must be stored in an appropriate application-data directory rather than inside source-code or installation files that may be overwritten during updates.

---

# 24. Void Sale Requirements

## REQ-VOID-001 — Void a Completed Sale

**Priority:** MUST

The user must be able to void an accidentally completed sale. The original sale must remain historically visible with status `VOIDED`; it must never be silently deleted or replaced.

---

## REQ-VOID-002 — Void Reason and Time

**Priority:** MUST

A void must preserve the void timestamp and a required reason.

---

## REQ-VOID-003 — Atomic Inventory Reversal

**Priority:** MUST

Voiding a sale must restore its sold quantities through explicit reversing inventory movements linked to the original sale. The status change, void details, inventory updates, reversing movements, audit event, and advancement of the sale's existing Google Sheets export job must commit in one authoritative SQLite transaction or all roll back.

---

## REQ-VOID-004 — Double-Void Protection

**Priority:** MUST

A sale that is already `VOIDED` must not be voided again or restore inventory a second time.

---

## REQ-VOID-005 — Reporting Treatment

**Priority:** MUST

Reports must exclude voided sales from revenue, tax, discount, payment-method, and completed-sale totals while preserving separate visibility of the voided transaction.

---

## REQ-VOID-006 — Void Audit History

**Priority:** MUST

Every successful void must create a durable audit event linked to the original sale and its void reason.

---

## REQ-VOID-007 — Google Sheets Void Propagation

**Priority:** MUST

Google Sheets export must eventually reflect the authoritative `VOIDED` state by advancing and redelivering the sale's existing export job, updating rows identified by the immutable Sale ID. Voiding, retrying, or propagating a void must not create a second export job or logical sale.

---

## REQ-VOID-008 — Cash and Card/Clover Treatment

**Priority:** MUST

A recorded Cash or Card sale may be voided in the POS. For Card sales, the workflow must warn that Go Phones POS does not reverse or refund the separate Clover payment; any required Clover reversal or refund must be performed separately through Clover.

---

# 25. Audit Trail Requirements

## REQ-AUDIT-001 — Durable Local Audit Trail

**Priority:** MUST

V1 must keep a durable local audit trail for important business and system actions. Audit events are authoritative business records and are separate from rotating diagnostic logs.

---

## REQ-AUDIT-002 — Required Audit Events

**Priority:** MUST

The audit trail must record, where applicable:

- Sale completed
- Sale voided
- Price override
- Inventory adjustment
- Tax-setting change
- Business-setting change
- Google Sheets configuration change
- Backup success and failure
- Migration execution and outcome
- Application update installation

---

## REQ-AUDIT-003 — Audit Event Context

**Priority:** MUST

Each audit event must preserve a stable event ID, event type, timestamp, relevant entity identifiers, available actor or system context, and a reason or result where required. It may include a correlation ID for diagnostic tracing but must not store secrets or unnecessary customer/payment data.

---

## REQ-AUDIT-004 — Audit Consistency and History

**Priority:** MUST

Audit events for transactional business changes must commit with the corresponding SQLite operation. Historical audit events must not be silently rewritten or deleted.

---

# 26. Owner Data Export Requirements

## REQ-EXPORT-001 — Owner-Controlled CSV Export

**Priority:** MUST

The owner must be able to export CSV data for at least:

- Products and current inventory
- Customers
- Sales, including status
- Inventory movements

---

## REQ-EXPORT-002 — Export Only

**Priority:** MUST

V1 owner CSV capability is export only. CSV import, legacy-data migration, and bidirectional file synchronization are outside V1.

---

## REQ-EXPORT-003 — Export Failure Isolation

**Priority:** MUST

Creating or writing an owner export must be a read-only operation against authoritative business records. Export failure must not modify, delete, or invalidate SQLite data.

---

# 27. Application Update Requirements

## REQ-UPDATE-001 — Production Distribution Path

**Priority:** MUST

Production releases must follow this distribution model:

`Private source repository → CI-built and tested Windows release → code-signed build → generic HTTPS update feed hosted independently from the source repository → installed clients`

---

## REQ-UPDATE-002 — Versioning and Release Integrity

**Priority:** MUST

Production releases must use semantic versioning, pass release-blocking tests, and be code signed before publication. Update artifacts must be traceable to the corresponding source revision and build.

---

## REQ-UPDATE-003 — Automatic Update Discovery and Download

**Priority:** MUST

When internet access is available, the installed application must be able to check for approved updates and may download them in the background without blocking or materially degrading checkout.

---

## REQ-UPDATE-004 — User-Controlled Installation

**Priority:** MUST

After an approved update is ready, the user must be able to choose `Restart & Update` or defer with `Later`. The application must not force a restart during active use.

---

## REQ-UPDATE-005 — Active Checkout Protection

**Priority:** MUST

Update installation and restart must be deferred while a checkout is active, a sale transaction is in flight, or another exclusive database lifecycle operation is running.

---

## REQ-UPDATE-006 — Offline and Endpoint Failure Isolation

**Priority:** MUST

The currently installed version must continue supporting local sales while offline or when the update feed, download, or verification process fails. Update-service failure is a secondary failure and must not lock the POS.

---

## REQ-UPDATE-007 — Business-Data Preservation

**Priority:** MUST

Application binaries and business data must be stored separately. Installing or replacing application binaries must preserve the database, settings, audit trail, backup metadata where used, receipt sequence, and pending Google Sheets export jobs.

---

## REQ-UPDATE-008 — Safe Schema Migration

**Priority:** MUST

Schema changes must use ordered, versioned migrations. A required migration may start only after its pre-migration backup is verified; migration failure must stop safely, preserve recovery evidence and the backup, and prevent normal checkout against an unsafe schema.

---

## REQ-UPDATE-009 — Bad-Release Recovery

**Priority:** MUST

The production release process must define a tested recovery strategy for a bad application release or failed migration. Recovery must not replace the authoritative database with application files or silently discard newer business records.

---

## REQ-UPDATE-010 — Client and Hosting Independence

**Priority:** MUST

Normal client operation must not require the user to access GitHub, manage CI or update infrastructure, store a GitHub token or other feed API key, download builds manually, run migrations, or execute shell commands. The update feed must use generic HTTPS/static hosting without requiring a particular paid vendor.

---

# 28. Support and Diagnostics Requirements

## REQ-DIAG-001 — Diagnostic Status

**Priority:** MUST

Support & Diagnostics must show:

- Application version and useful build identifier
- Database schema version and database health
- Internet state
- Printer state where detectable
- Google Sheets configuration/connectivity state
- Pending and failed Google export counts
- Backup health
- Disk-space health
- Installation identifier

---

## REQ-DIAG-002 — Report a Problem and Activity History

**Priority:** MUST

V1 must provide `Report a Problem` and a friendly activity/error history that helps the user describe and inspect recent failures without requiring developer tools.

---

## REQ-DIAG-003 — Structured Diagnostic Logging

**Priority:** MUST

Technical logs must be structured, rotate according to a bounded retention policy, use stable error codes, and carry correlation IDs across checkout and secondary operations where useful.

---

## REQ-DIAG-004 — Support Bundle and Crash Evidence

**Priority:** MUST

The user must be able to export a support bundle containing the bounded logs, health snapshot, application/schema/build identifiers, and available crash evidence needed for support.

---

## REQ-DIAG-005 — Sensitive-Data Redaction

**Priority:** MUST

Logs, activity history, and support bundles must exclude plaintext passwords, Google/OAuth tokens, API secrets, raw authorization headers, card numbers, CVV, Clover credentials, and unnecessary customer personally identifiable information.

---

## REQ-DIAG-006 — Failure Severity

**Priority:** MUST

Critical local failures, including inability to open SQLite safely, inability to commit a sale, or an unsafe migration outcome, may block checkout and must be presented clearly. Secondary failures involving printing, Google Sheets, internet access, or the update endpoint must not invalidate a committed sale or block otherwise healthy local sales.

---

# 29. Health and Recovery Requirements

## REQ-HEALTH-001 — Operational Health Checks

**Priority:** MUST

The application must assess database/schema health, available disk space, backup recency, Google export backlog, and printer state where practical, and expose actionable warnings through Support & Diagnostics.

---

## REQ-HEALTH-002 — Clock-Anomaly Handling

**Priority:** MUST

The application must detect significant suspicious system-clock changes where practical and log or warn about them. A clock anomaly alone must not block local sales.

---

## REQ-HEALTH-003 — Sleep and Resume

**Priority:** MUST

After Windows sleep/resume, the application must re-evaluate secondary connectivity and device state without losing committed records or leaving checkout in a falsely completed state.

---

## REQ-HEALTH-004 — Crash and Abrupt-Termination Recovery

**Priority:** MUST

After an application crash, Windows restart, or abrupt termination/power loss, startup must recover from SQLite's committed state, discard partial transactions, preserve pending exports, and surface relevant crash evidence or health failures.

---

## REQ-HEALTH-005 — Offline Recovery

**Priority:** MUST

Losing and regaining connectivity must not require an application reinstall or manual data repair. Local workflows remain available offline, and pending secondary operations resume safely when their dependencies return.

---

# 30. Application Lifecycle Requirements

## REQ-APP-001 — Single Instance

**Priority:** MUST

Go Phones POS must run as a single-instance desktop application. Launching it while it is already running must focus or restore the existing instance instead of opening an independent second POS process.

---

## REQ-APP-002 — Maintenance Safety

**Priority:** MUST

The application must maintain an explicit safe/unsafe state for restart and exclusive database lifecycle work. Update installation, schema migration, and database restore must not start or interrupt the application while a checkout is active or a sale transaction is in flight.

---

# 31. Explicit V1 Exclusions

The following are not V1 requirements:

- Repair workflow
- Repair tickets
- Technician management
- Trade-ins
- IMEI tracking
- Serial-number tracking
- Accessory stock
- Detailed used-phone grading
- Multiple branches
- Individual staff accounts
- Manager/cashier permission hierarchy
- Direct Clover API integration
- Full returns/refunds
- Bidirectional Google Sheets synchronization
- CSV import or migration tooling
- E-commerce
- Customer portal
- Loyalty program
- Supplier management
- Purchase orders
- Accounting software integration

---

# 32. Production Acceptance Requirements

Go Phones POS V1 cannot be considered production-ready until the following end-to-end scenarios pass.

## ACCEPT-001 — Basic Cash Sale

1. Product has quantity 5.
2. Cashier adds product.
3. Cashier completes Cash sale for quantity 1.
4. Sale is stored.
5. Payment is stored.
6. Inventory becomes 4.
7. Receipt is generated.
8. Transaction appears in Sales History.

Expected:

**PASS**

---

## ACCEPT-002 — Negotiated Price

1. Product price is $599.
2. Cashier changes selling price to $550.
3. Sale completes.
4. Historical sale preserves both $599 and $550.
5. Discount information is correct.

Expected:

**PASS**

---

## ACCEPT-003 — Offline Sale

1. Disconnect computer from internet.
2. Launch POS.
3. Search product.
4. Create sale.
5. Complete payment.
6. Inventory updates.
7. Receipt generates.
8. Sale appears in history.

Expected:

**PASS**

---

## ACCEPT-004 — Offline Restart

1. Complete sale offline.
2. Close application.
3. Keep internet disconnected.
4. Reopen application.
5. Verify sale.
6. Verify inventory.

Expected:

**PASS**

---

## ACCEPT-005 — Google Sheets Deferred Export

1. Disconnect internet.
2. Complete sale.
3. Confirm sale succeeds.
4. Confirm export status is Pending.
5. Restart application.
6. Confirm Pending status remains.
7. Restore internet.
8. Export succeeds.
9. Confirm only one transaction exists in Google Sheets.

Expected:

**PASS**

---

## ACCEPT-006 — Google Sheets Failure

1. Make Google API unavailable or invalid.
2. Complete local sale.
3. Confirm transaction succeeds.
4. Confirm inventory updates.
5. Confirm receipt remains available.
6. Confirm export reports failure/pending.

Expected:

**PASS**

---

## ACCEPT-007 — Printer Failure

1. Disconnect printer.
2. Complete sale.
3. Printing fails.
4. Sale remains completed.
5. Reconnect printer.
6. Reprint historical receipt.

Expected:

**PASS**

---

## ACCEPT-008 — Duplicate Click Protection

1. Build valid checkout.
2. Trigger Complete Sale repeatedly.
3. Wait for processing.

Expected:

Exactly one completed sale exists.

---

## ACCEPT-009 — Insufficient Inventory

1. Product quantity is 1.
2. Attempt to sell quantity 2.

Expected:

Sale is rejected before commit.

---

## ACCEPT-010 — Product Mutation After Historical Sale

1. Sell product called `iPhone 15` for $600.
2. Change current product name and price.
3. View old sale.

Expected:

Historical sale still shows original transaction values.

---

# 33. Requirement Change Rule

Requirements should not be silently changed during implementation.

If a business requirement changes:

1. Update `PRODUCT_SCOPE.md` if scope is affected.
2. Update this document.
3. Preserve or retire the existing requirement identifier deliberately.
4. Determine database impact.
5. Determine migration impact.
6. Determine offline impact.
7. Update tests.
8. Implement only after the expected behavior is clear.

---

# 34. V1 Engineering Rule

The most important engineering rule for Go Phones POS is:

> A sale is successful only when the authoritative local SQLite transaction commits successfully.

Receipt printing, Google Sheets network delivery, internet connectivity, and other external integrations happen outside that transaction boundary. The local receipt-number assignment and durable export-job record belong inside it.

Core path:

`Checkout → Validate → SQLite Transaction → COMMIT → Sale Complete`

Post-commit operations:

`Sale Complete → Receipt Printing`

`Sale Complete → Google Sheets Delivery Attempt`

External failures must not retroactively invalidate a successfully committed local sale.
