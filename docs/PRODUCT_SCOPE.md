# Go Phones POS — Product Scope

## 1. Product Name

**Go Phones POS**

Initial deployment location:

**Go Phones - Alvin**
1710 S Gordon St
Alvin, TX 77511
Phone: 281-824-0001

---

## 2. Purpose

Go Phones POS is a Windows desktop point-of-sale application for managing retail phone sales, phone inventory, customer records, payments, receipts, daily sales reporting, and external sales export.

The system must remain usable for core sales operations when the store has no internet connection.

The initial release is intentionally focused on retail sales. Repair management, trade-ins, multi-location management, and advanced device-level inventory tracking are outside the first release.

---

# 3. Primary V1 Goals

The first production version must allow the store to:

1. Add and manage phone inventory.
2. Search or scan products during checkout.
3. Create retail sales.
4. Change or negotiate item prices during checkout, from which a discount amount is derived for display (Section 11) — V1 has no separate discount mechanism.
5. Calculate sales tax.
6. Record Cash and Card payments.
7. Store optional customer information.
8. Automatically reduce inventory when a sale is completed.
9. Generate and print itemized receipts.
10. Reprint previous receipts.
11. View sales history.
12. View daily sales totals and payment breakdowns.
13. Continue completing sales while the internet is unavailable.
14. Store business data locally on the POS computer.
15. Support local backup without making internet connectivity a requirement for checkout.
16. Export completed sales to a configured Google Sheet when internet connectivity is available.
17. Queue Google Sheets exports while offline and automatically retry them later without creating duplicate records.
18. Clear an unfinished checkout and void an accidentally completed sale without deleting its history.
19. Maintain a durable audit trail for important business and system actions.
20. Create manual and recurring automatic SQLite-safe backups with retention, health reporting, and tested restore.
21. Export owner-controlled business data to CSV.
22. Detect updates automatically and download them in the background once found while online, and safely install approved updates without making updates a checkout dependency.
23. Provide built-in health, support, diagnostic, and sanitized support-bundle capabilities.
24. Durably record and surface a Clover-approved card charge whose local sale failed to commit, so it can be reconciled.

---

# 4. Target Platform

## V1 Platform

The application will initially support:

* Windows desktop/laptop computers
* Windows 10
* Windows 11

The application will be distributed as an installable desktop application.

Example:

`GoPhonesPOS-Setup.exe`

The application should not require the user to open a browser manually.

---

# 5. Proposed V1 Technology Direction

The intended architecture is:

* Electron
* React
* TypeScript
* SQLite
* Local-first data architecture
* Google Sheets API for secondary sales export

SQLite will act as the primary local operational database.

Core POS functionality must not depend on:

* An external server
* Google Sheets
* Google APIs
* Cloud availability
* Internet connectivity

Google Sheets is a secondary reporting/export destination only.

---

# 6. Business Model Supported in V1

The initial system supports one retail location:

**Go Phones - Alvin**

The store sells:

* New phones
* Used phones
* Refurbished phones

Product condition grading is not required.

Examples:

* iPhone 15 128GB — New
* iPhone 13 128GB — Used
* Samsung Galaxy S24 — Refurbished

---

# 7. Product and Inventory Scope

## Included

The system must allow authorized store users to:

* Create a phone product
* Edit a phone product
* Archive/deactivate a phone product
* Store a SKU
* Store a barcode
* Store product name
* Store brand
* Store model
* Store condition
* Store selling price
* Store cost price if configured
* Store available quantity
* Search products
* Scan products using a barcode scanner
* View current stock
* Detect low or zero stock
* Reduce inventory when a sale is completed
* Restore inventory through explicit reversing movements when a completed sale is voided

Initial expected inventory size is approximately 50 products/models.

## Inventory Tracking Model

V1 tracks inventory at the product quantity level.

Example:

`iPhone 15 128GB — Quantity: 4`

Individual physical phones do not need separate inventory records.

---

# 8. IMEI and Serial Number Tracking

IMEI and serial number tracking are explicitly outside V1.

The system does not need to:

* Store IMEI numbers
* Store device serial numbers
* Associate an IMEI with a transaction
* Track each physical handset individually

This capability may be introduced in a future version if the business requires it.

---

# 9. Accessories

Accessory inventory management is outside V1.

The system does not need to track stock quantities for:

* Cases
* Chargers
* Screen protectors
* Cables
* Headphones
* Other accessories

Future versions may add accessory inventory.

---

# 10. Checkout

The checkout interface must allow the cashier to:

* Start a new sale
* Search for a product
* Scan a product barcode
* Add one or more products to the cart
* Change quantities
* Remove products
* View listed price
* Override selling price (the resulting discount is derived and displayed automatically; there is no separate discount step)
* Attach an optional customer
* View subtotal
* View discount amount
* View tax
* View final total
* Select payment method
* Complete the transaction
* Generate a receipt

---

# 11. Price Negotiation and Discounts

Go Phones allows price negotiation.

The cashier must therefore be able to change the selling price of an item during checkout.

Example:

Listed price:

`$599.00`

Negotiated selling price:

`$550.00`

The system should preserve enough information to distinguish between:

* Original/listed price
* Actual sold price
* Discount amount

V1 has no separate discount mechanism (no percentage discount, fixed-amount discount, coupon, or order-level discount). "Discount" is a derived, display-only value computed as `listed price - sold price` (clamped at zero if the negotiated price is above listing); the only pricing tool is per-item price negotiation described above.

Completed historical sales must retain the price charged at the time of sale even if the product price changes later.

---

# 12. Tax

V1 assumes the same configured sales-tax rate applies to all products.

The tax rate should be configurable in application settings rather than hard-coded.

The system must calculate:

* Subtotal
* Discount
* Taxable amount
* Tax
* Final total

Tax calculations must be preserved with each completed transaction.

---

# 13. Payment Methods

V1 supports:

* Cash
* Card

## Cash

The POS records the sale as a cash transaction.

V1 may also support:

* Amount tendered
* Change due

These fields are optional unless confirmed as necessary during implementation.

## Card

Card payments are processed using the store's existing Clover terminal.

For V1, Clover remains operationally separate from the Go Phones POS application.

Expected flow:

1. POS displays the transaction total.
2. Cashier manually processes that amount using Clover.
3. Clover approves or declines the payment.
4. Cashier confirms successful card payment inside Go Phones POS.
5. Go Phones POS records the transaction as Card.

Direct Clover API or terminal integration is not required in V1.

If the cashier confirms Clover approval but the local sale then fails to save (a SQLite commit failure), the customer may have already been charged even though no local sale exists. V1 must never fabricate a completed local sale to hide this, and must never pretend the Clover charge did not happen. The application durably records the checkout attempt, payment method, intended total, and the cashier's Clover-approval confirmation *before* attempting the local save, so that evidence survives the failure; it then clearly warns the cashier that the Clover charge may need to be checked, voided, or refunded separately in Clover, and tracks the incident in a local reconciliation queue until a person resolves it. This never involves an automated Clover API call — see `POS_WORKFLOWS.md` Sections 35A–35B and `DATA_MODEL.md` Sections 31–31B.

---

# 14. Customer Records

The business wants the ability to record customer information.

V1 should support:

* Customer name
* Customer phone number
* Purchase history

Customer attachment should be optional during standard checkout unless future business requirements change.

The system should allow users to:

* Create customer
* Search customer
* Select existing customer
* View customer's previous purchases

---

# 15. Receipts

Every successfully completed sale must generate an itemized receipt.

The receipt should support:

* Go Phones - Alvin business name
* Business address
* Business phone number
* Transaction/receipt number
* Date and time
* Customer details when available
* Each purchased item
* Quantity
* Item price
* Discounts
* Subtotal
* Tax
* Final total
* Payment method
* Return/warranty/disclaimer text
* Thank-you message
* Future website/social-media information

The receipt policy provided by the client should use the business name:

**Go Phones - Alvin**

The policy may be printed in smaller text to accommodate receipt size.

Receipt layout should be designed so thermal-printer support can be introduced without redesigning the transaction system.

---

# 16. Printing

The client currently has an existing printer and plans to add a thermal receipt printer.

V1 should therefore support standard Windows printing.

The architecture should allow later support for:

* 80mm thermal receipts
* 58mm thermal receipts
* Printer selection
* Automatic receipt printing
* Silent printing where appropriate

Printing failure must not invalidate a completed sale.

Example:

If the sale is successfully stored but the printer is disconnected, the sale remains valid and the receipt can be reprinted later.

---

# 17. Barcode Scanner

The client already owns a USB/Bluetooth barcode scanner.

V1 should support common scanners that behave as keyboard input devices.

Typical workflow:

1. Cursor is active in the POS scan input.
2. Scanner sends barcode characters.
3. Scanner sends Enter.
4. POS searches local inventory.
5. Matching product is added to the cart.

No vendor-specific scanner integration is required for V1 unless physical testing proves otherwise.

---

# 18. Sales History

The POS must retain completed transaction history.

Users should be able to:

* View previous sales
* Search sales
* View transaction details
* View purchased items
* View payment method
* View customer
* View total
* View Google Sheets export status
* Reprint receipt
* Void an accidentally completed sale once, with a required reason
* See the original sale, its `VOIDED` status, void timestamp, and void reason

Historical sales must not depend on the current product price or product description.

Sale records should preserve transaction-time information. Completed sales must never be silently rewritten or deleted. A V1 void changes only the sale's lifecycle state and adds the required void and reversal records.

---

# 19. Daily Closing and Reporting

V1 must provide simple operational reporting.

At minimum, users should be able to view:

* Number of non-voided completed transactions, with void visibility available separately
* Gross sales excluding voided revenue
* Discounts
* Tax collected
* Final sales total
* Cash sales total
* Card sales total

The system should support viewing totals for a selected day.

Local SQLite data must be used for authoritative reporting.

Google Sheets must not be required for daily totals or daily closing.

Advanced accounting and bookkeeping integrations are outside V1.

---

# 20. Offline Requirement

Offline operation is a critical product requirement.

The store must be able to complete sales when internet/Wi-Fi access is unavailable.

The following functionality must remain available offline:

* Application launch
* Product lookup
* Barcode scanning
* Inventory lookup
* Checkout
* Price overrides
* Discounts
* Tax calculation
* Cash transaction recording
* Card transaction recording after external Clover approval
* Customer lookup from locally stored data
* Customer creation
* Sale completion
* Inventory reduction
* Receipt generation
* Receipt printing
* Sales history
* Daily reporting

Internet availability must not be required to complete a sale.

Google Sheets export must automatically degrade into a queued/pending state while offline.

---

# 21. Local Data

The local POS database is the operational source of truth for V1.

Core business records will be stored locally using SQLite.

Examples:

* Products
* Customers
* Sales
* Sale items
* Payments
* Inventory movements
* Application settings
* Google Sheets export queue
* Export status records

Database operations involving sale completion and inventory changes must use transactions so partial sales cannot corrupt inventory state.

The system must never consider a Google Sheets export necessary for a local transaction to be valid.

---

# 22. Google Sheets Sales Export

V1 should support exporting completed sales to a configured Google Sheet for simple external reporting, visibility, and record keeping.

Google Sheets is a secondary reporting destination only.

The local SQLite database remains the operational source of truth.

A Google Sheets API failure, internet outage, authentication failure, API rate limit, spreadsheet outage, or synchronization failure must never prevent or invalidate a local sale.

---

## 22.1 Export Direction

V1 synchronization is one-way:

**Go Phones POS → Google Sheets**

Google Sheets must not update or control:

* Inventory
* Products
* Customers
* Sales
* Prices
* Discounts
* Tax settings
* Transaction status

Manual edits to Google Sheets must not silently modify the local POS database.

Bidirectional synchronization is explicitly outside V1.

---

## 22.2 Export Workflow

Expected workflow:

1. Cashier submits a sale.
2. The local SQLite transaction creates the sale and unique receipt number.
3. Sale items are stored locally.
4. Payment is stored locally.
5. Inventory is updated locally.
6. Inventory movement records are created.
7. A durable Google Sheets export job and required audit events are created locally.
8. The local database transaction commits successfully and the receipt becomes available for printing.
9. The user is told the local sale succeeded.
10. If internet is available, the post-commit export worker attempts export.
11. If the export succeeds, the job is marked Exported.
12. If the export fails, the job remains queued or Failed.
13. The system retries the export later.

Required architecture:

`Checkout → SQLite transaction (sale + durable export job) → completed local sale → Google Sheets worker/API`

The following architecture is prohibited:

`Checkout → Google Sheets → local sale`

Google Sheets availability must never sit on the critical checkout path.

---

## 22.3 Offline Export Behavior

When internet access is unavailable:

* Sales must continue normally.
* Inventory must continue updating.
* Receipts must continue working.
* Sales history must remain available.
* Daily reports must continue working.
* Google Sheets exports must remain pending locally.

Example:

`GP-000124 — Pending Export`

When connectivity returns:

`GP-000124 — Exported`

Pending exports must survive:

* Application restart
* Windows restart
* Internet outage
* Temporary Google API failure

---

## 22.4 Google Sheet Data

Each completed sale, including its current `COMPLETED` or `VOIDED` state, must export enough information for basic reporting and reconciliation. A void must update the rows identified by the immutable Sale ID rather than append a second logical sale.

The V1 export includes:

* Internal Sale ID
* Receipt Number
* Sale Date
* Sale Time
* Customer Name
* Customer Phone
* Product Name
* SKU
* Barcode
* Condition
* Quantity
* Listed Price
* Sold Price
* Discount
* Subtotal
* Tax
* Transaction Total
* Payment Method
* Transaction Status
* Sync Version
* Void Timestamp and Reason when voided
* Export Timestamp

---

## 22.5 Spreadsheet Structure

The V1 structure uses two worksheets:

### Worksheet 1: Sales

One row per transaction.

Required columns:

* Sale ID
* Receipt Number
* Date
* Time
* Customer Name
* Customer Phone
* Subtotal
* Discount
* Tax
* Tax Rate
* Total
* Payment Method
* Status
* Sync Version
* Voided At
* Void Reason
* Exported At

### Worksheet 2: Sale Items

One row per item sold.

Required columns:

* Sale ID
* Sale Item ID
* Receipt Number
* Product ID
* Product Name
* Brand
* Model
* SKU
* Barcode
* Condition
* Quantity
* Listed Price
* Sold Price
* Discount
* Line Total

Using separate Sales and Sale Items worksheets avoids duplicating transaction-level totals across every product row.

The finalized logical spreadsheet schema is repeated with its synchronization fields in `DATA_MODEL.md`.

---

## 22.6 Duplicate Protection

Google Sheets export must be idempotent.

Every local sale must have a unique immutable internal Sale ID.

Example:

`550e8400-e29b-41d4-a716-446655440000`

A human-readable receipt number may separately be:

`GP-000124`

The internal Sale ID should be used for synchronization and duplicate detection.

Retrying an export must not create duplicate sales because of:

* Network interruption
* Application restart
* Request timeout
* Unknown API response
* Temporary Google failure
* Manual retry
* Automatic retry

---

## 22.7 Export Status

The application should track Google Sheets export status locally.

Possible states:

* Pending
* Exporting
* Exported
* Failed

The system should preserve where appropriate:

* Sale ID
* Export status
* Retry count
* Last attempt time
* Successful export time
* Last error message

Users should be able to identify whether a transaction has successfully reached Google Sheets.

A manual Retry Export action may be provided for failed exports.

---

## 22.8 Google Authentication and Credentials

Google Sheets integration must be configurable.

Configuration may include:

* Enable/disable Google Sheets export
* Target Spreadsheet ID
* Sales worksheet
* Sale Items worksheet
* Google API authentication
* Last successful synchronization time

Google credentials must:

* Never be hard-coded in React components
* Never be committed to Git
* Never be exposed to the renderer unnecessarily
* Be handled through the Electron/main-process integration layer or another secure local mechanism

The exact Google authentication method should be defined during architecture/design before implementation.

---

## 22.9 Google Sheets Role

Google Sheets is intended for:

* Owner visibility
* Simple external reporting
* Sales record review
* Convenient spreadsheet analysis
* Sharing business sales information where appropriate

Google Sheets is explicitly not intended to replace:

* SQLite
* Local inventory state
* Transaction integrity
* Offline storage
* Receipt history
* Primary POS reporting
* Primary sales records

---

# 23. Backup Strategy

The local POS database contains business-critical records and therefore must have a backup strategy.

V1 distinguishes two different guarantees, and does not conflate them:

1. **Local recovery backup** (the V1 default). Manual and recurring automatic SQLite-safe backups are written to the same computer/disk as the operational database. This protects against accidental deletion, application-level corruption, and a bad migration — recoverable failures where the machine and disk are still intact. It does **not** protect against loss of that machine or disk itself.
2. **Device/disk-loss protection** (optional in V1). Protecting against computer failure, disk failure, theft, or fire requires a backup copy stored somewhere other than the same disk — an external/USB drive or a configured network location. V1 supports configuring an additional off-device backup destination, but it is optional and not enabled by default; a backup is only device/disk-loss protection when the owner has actually configured and verified an off-device location for it.

V1 must provide manual and recurring automatic SQLite-safe backups. Documentation and in-app messaging must never describe a same-disk (default) backup as protecting against physical disk failure, device loss, or theft — only a verified off-device backup provides that protection.

Google Sheets export provides a secondary copy of sales information but must not be considered a complete database backup.

Google Sheets may not contain:

* Full product state
* Inventory history
* Application settings
* Full customer records
* Internal synchronization metadata
* Other local database information

Therefore SQLite database backup remains a separate requirement. Backups require bounded retention or cleanup, visible health and failure reporting, and a restore procedure tested before production. Every schema migration requires a successfully created and verified pre-migration backup; if that backup or the migration fails, normal startup must stop safely rather than expose an unsafe database.

A more advanced cloud backup system may be introduced in a future release.

---

# 24. Authentication

V1 supports one shared store login.

Individual employee accounts and permission systems are not required.

Future versions may introduce:

* Employee accounts
* Manager role
* Cashier role
* Permissions
* Audit attribution

---

# 25. Repairs

Go Phones performs phone repairs.

However, repair-management functionality is outside the initial product scope.

V1 does not need:

* Repair tickets
* Technician assignment
* Repair status tracking
* Repair intake
* Repair device records
* Repair part tracking
* Repair payment workflow

The provided repair/warranty disclaimer may still appear on receipts as requested by the client.

Repair management may become a future module.

---

# 26. Trade-Ins

Trade-in functionality is explicitly excluded from V1.

The system does not need to:

* Evaluate trade-in devices
* Calculate trade-in credit
* Add traded devices to inventory
* Apply trade-in value to a sale

This may be considered in a future release.

---

# 27. Multi-Location Support

V1 supports one store location only.

The system does not need:

* Branch management
* Cross-store inventory
* Per-location employees
* Transfers between stores
* Centralized multi-location reporting

The architecture should avoid unnecessary assumptions that would make future multi-location support impossible, but no multi-location functionality should be built in V1.

---

# 28. Existing Data Migration

No existing product, sales, or customer database needs to be imported.

The client wants a fresh start.

Initial inventory will be entered into the new system.

Therefore V1 does not require:

* CSV migration tooling
* Customer migration
* Historical transaction migration
* Legacy database conversion

---

# 29. Explicitly Out of Scope for V1

The following features must not be implemented unless the scope is formally changed:

* Repair management
* Repair tickets
* Technician management
* Repair parts inventory
* Trade-ins
* IMEI tracking
* Serial-number tracking
* Accessory inventory tracking
* Device grading
* Multiple branches
* Employee-specific accounts
* Role-based permissions
* Direct Clover integration
* Automated Clover reversal/refund
* Full or partial returns, refunds, and exchanges
* Bidirectional Google Sheets synchronization
* Using Google Sheets as the primary database
* Remote inventory editing through Google Sheets
* Online e-commerce
* Online customer portal
* Accounting integration
* Historical-data migration
* CSV import/migration tooling
* Advanced CRM
* Loyalty program
* SMS marketing
* Email marketing
* Supplier management
* Purchase orders
* Advanced financial accounting
* Cloud-required checkout
* Microservices or Kubernetes
* Always-online backend
* Enterprise observability infrastructure

---

# 30. Core Product Principle

The primary operational workflow is:

**Add inventory → find/scan phone → create sale → negotiate price if needed → select Cash/Card → atomically record sale/payment/inventory/export work in SQLite → commit locally → print receipt → export sale to Google Sheets when connectivity permits**

Everything in V1 should support this workflow.

Features that do not materially support this workflow should be deferred unless required for:

* Reliability
* Data integrity
* Security
* Offline operation
* Backup
* Compliance

---

# 31. Critical Architectural Principle

A completed local sale must never depend on an external integration.

The system should always prioritize:

**Local transaction integrity first.**

External operations happen afterward.

Correct:

`Sale + durable Google export job → SQLite COMMIT → Receipt / Google Sheets worker`

Incorrect:

`Sale → Google API → Wait → SQLite`

This principle applies to current and future external integrations.

---

# 32. V1 Definition of Done

V1 is considered ready for production only when the following can be demonstrated on a real Windows computer:

1. Application installs successfully.
2. Application starts without development tooling.
3. User can create phone inventory.
4. Existing products can be searched.
5. Barcode scanning works with the client's scanner.
6. Cashier can create a sale.
7. Cashier can override a product price.
8. Discounts calculate correctly.
9. Tax calculates correctly.
10. Cash payment can be recorded.
11. Card payment can be recorded after Clover processing.
12. Inventory decreases correctly after a sale.
13. Completed sales remain available after restarting the application.
14. Receipts can be printed.
15. Previous receipts can be reprinted.
16. Daily totals can be viewed.
17. Customer information can be saved and retrieved.
18. Core sales continue with Wi-Fi physically disabled.
19. Restarting the application while offline does not prevent operation.
20. Failed printing does not destroy or duplicate a sale.
21. Repeated clicking of Complete Sale does not create duplicate transactions.
22. Database operations remain consistent after application restart.
23. Basic SQLite backup behavior has been tested.
24. Completed online sales export successfully to Google Sheets.
25. Sales completed while offline remain queued for Google Sheets export.
26. Pending exports survive application restart.
27. Pending exports successfully export after connectivity returns.
28. Retried Google Sheets exports do not create duplicate transaction records.
29. Google Sheets failure does not prevent checkout.
30. Google Sheets export status can be inspected locally.
31. Google credentials are not exposed in frontend/renderer code.
32. The application has been tested using the client's actual Windows environment.
33. The application has been tested with the client's barcode scanner.
34. The application has been tested with the client's existing printer.
35. The application remains usable if Google Sheets is completely unavailable.
36. An unfinished checkout can be cleared without changing inventory.
37. An accidental completed sale can be voided once; its history and reason remain visible and inventory is restored by reversing movements.
38. Voided revenue is excluded from operational totals and the same logical sale is updated in Google Sheets.
39. Manual and automatic backups, retention, failure reporting, health visibility, and restore are tested.
40. Owner CSV exports work for products/inventory, customers, sales, and inventory movements without changing authoritative data.
41. Updates are discovered and downloaded in the background, can be deferred, and cannot restart during active checkout.
42. Code-signed updates from the independent HTTPS feed preserve business data and use verified pre-migration backups.
43. Support & Diagnostics reports required health state, produces redacted rotating logs and support bundles, and retains crash evidence.
44. A second launch focuses/restores the existing application instance.
45. Sleep/resume, abrupt termination, Windows restart, clock anomalies, low storage, and offline recovery behave safely.
46. A Clover-approved card charge followed by a local commit failure is durably recorded with payment method, intended total, and approval confirmation, clearly warns the cashier to check Clover separately, and never appears as a completed local sale.
47. A whole-database restore preserves a pre-restore recovery copy, warns and requires explicit confirmation before overwriting business data newer than the selected backup, and never silently discards those newer records.

---

# 33. Void, Audit, Export, Updates, and Support

V1 includes clear/cancel for an unfinished checkout and a one-time void for an accidentally completed sale. Voiding requires a reason, preserves the original transaction and payment history, records a timestamp and durable audit event, and restores stock through explicit reversing inventory movements in the same authoritative transaction. A Cash void is an internal POS correction. For a Card sale, the POS must warn that any Clover reversal or refund is a separate manual action; Go Phones POS does not perform it.

Full returns, partial returns, exchanges, and refund processing remain outside V1.

The durable audit trail covers sale completion and void, price override, inventory adjustment, tax and business setting changes, Google Sheets configuration changes, backup success/failure, migration execution, application update installation, shared-credential changes, and a Clover-approved card charge whose local commit failed. Rotating diagnostic logs are separate from this audit history.

Owner-controlled CSV export is required for products/inventory, customers, sales, and inventory movements. It is export only; V1 does not include CSV import or migration tooling.

V1 application updates follow this path:

`Private source repository → CI-built/tested Windows release → code-signed build → independent generic HTTPS update feed → installed clients`

Clients do not need GitHub access or tokens, CI access, API keys, manual downloads during normal use, shell commands, migration operation, or update-infrastructure administration. Update discovery and failure are secondary; installed software continues offline. Installation occurs only through a maintenance-safe `Restart & Update` flow and never interrupts active checkout.

V1 includes built-in Support & Diagnostics with version/build/schema identity, database, internet, printer where detectable, Google queue, backup, disk-space, update and installation health; Report a Problem; friendly activity history; structured rotating logs; stable error codes and correlation IDs; health checks; crash evidence; and sanitized support bundles. Significant clock changes may warn but do not automatically block sales. Critical local persistence failures may block unsafe checkout; secondary failures do not invalidate committed sales.

Go Phones POS is single-instance. A second launch focuses/restores the existing instance. Windows sleep/resume, application crash/restart, Windows restart, abrupt termination/power loss, and offline recovery must preserve or safely recover authoritative committed state.

---

# 34. Scope Change Rule

Any request for functionality listed under **Out of Scope for V1** should be treated as a new scope decision rather than silently added during development.

Before adding such functionality, determine:

* Business value
* Technical impact
* Data-model impact
* Offline impact
* Security impact
* Testing requirements
* Effect on delivery scope

The `PRODUCT_SCOPE.md` document must be updated before implementation begins.
