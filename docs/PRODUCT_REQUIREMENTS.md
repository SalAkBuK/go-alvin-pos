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

## REQ-PROD-007 — Low Stock Indication

**Priority:** MUST

When a product's `quantity_on_hand` is at or below its configured `low_stock_threshold`, the application must visually indicate the low-stock condition. This is a required V1 capability, not an optional enhancement, consistent with `PRODUCT_SCOPE.md` Section 7 listing low/zero stock detection under included product/inventory functionality.

---

## REQ-PROD-008 — SKU and Barcode Uniqueness and Normalization

**Priority:** MUST

SKU and barcode are each optional but, when present, unique. Both are trimmed of leading/trailing whitespace before storage and before the uniqueness check; a value that is empty after trimming is stored as absent rather than an empty string, so multiple products may each have no SKU/barcode without colliding. Comparison for uniqueness is case-sensitive on the trimmed value.

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

## REQ-SALE-012 — Duplicate Line Aggregation

**Priority:** MUST

Before validating stock, the trusted application layer must aggregate cart lines that reference the same product ID and validate their combined quantity against available stock as a single total, so stock validation cannot be bypassed by splitting one product's quantity across multiple lines.

---

## REQ-SALE-013 — Quantity and Monetary Bounds

**Priority:** MUST

Quantity must be a positive integer; fractional or non-numeric quantity is rejected. Per-line and aggregated-per-product quantity is bounded (1–999 in V1's documented default). Per-unit prices and the sale total must be non-negative integers within V1's documented monetary ceilings (`DATA_MODEL.md` Section 41A). Malformed numeric input is rejected at the trusted application boundary regardless of what the renderer already validated. A negotiated selling price may be set above the listed price; the derived discount is clamped at zero rather than becoming negative.

---

## REQ-SALE-014 — Checkout Drift Detection

**Priority:** MUST

The trusted application layer must recompute every value the cashier reviewed (cart contents, quantities, selling prices, tax rate, product active/archived state, stock availability, and resulting totals) from current authoritative state immediately before commit, using the deterministic checkout fingerprint defined in `DATA_MODEL.md` Section 41B. If any recomputed value differs from what was reviewed, the checkout must be rejected for re-review rather than silently committed with different financial values. For Card payments, the amount the cashier processed on Clover must exactly equal the authoritative committed total or the sale is rejected.

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

## REQ-TAX-005 — Deterministic Rounding Rule

**Priority:** MUST

Tax is calculated once at the transaction level against the summed post-negotiation (sold-price) taxable amount, never per line, using integer arithmetic and round-half-up to the nearest cent: `tax_cents = floor((taxable_amount_cents × tax_rate_bps + 5000) / 10000)`. This is the single rounding rule used everywhere tax is displayed or persisted — checkout preview, the committed sale, sales history, receipts, reports, and the Google Sheets export. The exact formula and worked fractional-cent examples are defined in `DATA_MODEL.md` Section 42.

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

# 9A. Card-Approved / Local-Commit-Failure Reconciliation Requirements

## REQ-RECONCILE-001 — Durable Pre-Payment Checkout Evidence

**Priority:** MUST

For a Card checkout, the trusted application layer must durably record, in its own independently committed write, the checkout request identifier, request fingerprint, payment method, and intended total **before the cashier is instructed to process any amount through Clover** — not merely before the sale transaction. This record must survive a subsequent failure at any later step, including a failure to durably record the Clover approval confirmation itself. For Cash, this record is written directly before the sale transaction, since there is no external payment step to protect.

---

## REQ-RECONCILE-002 — Card Approval Confirmation Persisted Before Commit Attempt

**Priority:** MUST

For a Card checkout, the cashier's confirmation that Clover approved the charge must be captured in its own independently committed write to the existing pre-payment record (`REQ-RECONCILE-001`) after Clover responds and before the sale transaction is attempted, so that confirmation is not lost if the sale transaction subsequently fails. If this write itself fails, the checkout must not silently proceed to the sale transaction, and the unconfirmed attempt must remain discoverable for reconciliation (`REQ-RECONCILE-004`) rather than being lost.

---

## REQ-RECONCILE-003 — Local Commit Failure Must Not Be Hidden

**Priority:** MUST

If the authoritative sale transaction fails after a Card payment was confirmed approved on Clover, the application must not report the sale as completed and must not fabricate a completed local sale. It must clearly warn the cashier that the Clover charge may still be valid and that any required void or refund must be performed separately and manually in Clover; Go Phones POS performs no automated Clover reversal.

---

## REQ-RECONCILE-004 — Reconciliation Queue

**Priority:** MUST

A Card checkout attempt must appear in a local reconciliation queue until a person marks it resolved with a required note, or until a retry of the same checkout attempt completes the sale successfully, when either: (a) its local commit failed after Clover approval was confirmed, or (b) its Clover-approval confirmation itself could not be durably recorded and the attempt remains unconfirmed past a short staleness window. An attempt explicitly recorded as declined/cancelled is not an incident and must not appear in the queue.

---

## REQ-RECONCILE-005 — No Automated Clover Reversal

**Priority:** MUST

Go Phones POS must not call any Clover API to reverse, refund, or verify a charge as part of commit-failure handling. Direct Clover integration remains out of scope for V1 (`PRODUCT_SCOPE.md` Section 29).

---

## REQ-RECONCILE-006 — Safe Retry Without Re-Charging

**Priority:** MUST

After a Card commit failure, the cashier must be able to retry completing the same cart once the underlying local issue is resolved without being prompted to process the card through Clover again. A successful retry links to and resolves the original reconciliation entry.

---

# 10. Customer Requirements

## REQ-CUST-001 — Create Customer

**Priority:** MUST

The system must allow creating a customer record. Name is required (non-blank after trimming); phone number is optional so a customer can be recorded by name alone.

Supported information:

- Name (required)
- Phone number (optional)

---

## REQ-CUST-007 — Customer Field Normalization

**Priority:** MUST

Name and phone are trimmed of leading/trailing whitespace before storage; a phone value that is empty after trimming is stored as absent rather than an empty string. A digits-only normalized form of the phone number is derived and used for search so differently formatted entries of the same number match. Two customers may share the same phone number; V1 does not enforce phone uniqueness. Editing a customer's name or phone updates only the live record and never rewrites any historical sale's stored customer snapshot (`REQ-SALE-009`).

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

## REQ-REPORT-008 — Deterministic Business-Day Attribution

**Priority:** MUST

A sale's reporting date must be derived, at query time, from its authoritative `completed_at` (UTC) converted into the currently configured business timezone using standard IANA rules, including standard DST handling. Business date is never persisted as a separate stored column. The exact conversion rule and its behavior when the configured timezone changes are defined in `DATA_MODEL.md` Section 4.

---

## REQ-REPORT-009 — Late Void Attribution

**Priority:** MUST

Voiding a sale must never alter its original `completed_at`. Reports for the sale's original business date must exclude its revenue, discount, tax, and payment-method totals once voided, regardless of when the void itself occurs. The void action's own date-based visibility (for audit/void-activity views, not revenue) uses `voided_at`'s business date, which may differ from the original sale's business date.

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

Every committed sale must have exactly one durable local export job identified by the immutable Sale ID. Network delivery must remain paused while Google Sheets export is disabled, not connected, or connected but not yet ready to sync (`REQ-GSHEET-018`).

---

## REQ-GSHEET-002 — Transactional Queue and Post-Commit Export

**Priority:** MUST

The sale's durable local export job must be created inside the same SQLite transaction as the sale. Network delivery to Google Sheets must occur only after that transaction commits successfully and only while the integration is enabled, connected, and ready to sync (`REQ-GSHEET-018`).

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

Pending exports must automatically retry after connectivity becomes available while the integration is enabled, connected, and ready to sync (`REQ-GSHEET-018`).

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

V1 authenticates to Google with a desktop OAuth flow (`REQ-GSHEET-016`). The
sensitive long-lived credential is the OAuth **refresh token**.

- Google credentials must never be hard-coded into renderer/frontend source
  code, committed to Git, or included in renderer bundles.
- The refresh token must be stored only in the trusted main process, encrypted
  with the operating-system secure-storage mechanism, outside the SQLite
  database, with no plaintext fallback.
- The refresh token, access tokens, the authorization code, the PKCE verifier,
  ID tokens, and raw OAuth token responses must never be written to logs,
  included in support bundles, returned to the renderer, or exported to Google
  Sheets. Centralized redaction must cover all of them.
- The developer's OAuth client configuration is a build artifact, not a
  client-entered value, and must never be shown in Settings or logged. An
  installed desktop OAuth client is a public client; its configuration value
  must not be treated as equivalent to a refresh token or private key.

---

## REQ-GSHEET-014 — Formula Injection Neutralization

**Priority:** MUST

Any exported text field value beginning with `=`, `+`, `-`, or `@` must be neutralized before being written to Google Sheets, so that opening the sheet in a spreadsheet application cannot execute it as a formula.

---

## REQ-GSHEET-015 — Stale-Write Ordering Guarantee

**Priority:** MUST

V1 Google Sheets synchronization uses **convergence semantics**. The direct Google Sheets REST API provides no cross-request revision precondition / compare-and-set primitive for cell values, so V1 does not claim a mathematical guarantee that Google Sheet cell contents can never be transiently stale during an ambiguous or externally reordered network outcome. V1 instead guarantees, through the `sync_version` / `target_sync_version` / `exported_sync_version` design in `DATA_MODEL.md` Sections 22–25:

- SQLite remains authoritative; the Google Sheet is a secondary exported copy.
- An older export revision must never become the locally accepted / current synchronized revision after `target_sync_version` has advanced.
- A stale success or failure acknowledgment must not finalize or regress the export job: a worker may mark a job `EXPORTED` — setting `exported_sync_version` to the revision it just wrote — only if that revision still equals the job's current `target_sync_version`; otherwise the acknowledgment is discarded and the job stays pending.
- The job remains eligible for the newest `target_sync_version`.
- Repeated idempotent upserts keyed by the immutable Sale ID must converge the Google Sheet row to the current `sales.sync_version`.

---

## REQ-GSHEET-016 — Desktop OAuth Account Connection

**Priority:** MUST

V1 connects to Google with a **desktop (installed-app) OAuth 2.0
authorization-code flow**, not a service account. The store owner connects their
own Google account; the client is never required to use Google Cloud Console,
create an OAuth client or service account, import a credential file, copy a
service-account email, manually share a spreadsheet, or paste a spreadsheet ID
or worksheet name during normal setup. The developer owns the OAuth client.

The flow must:

- use the user's **external system browser** — the Google sign-in/consent page
  must never be rendered inside an application `BrowserWindow`, `<webview>`, or
  other embedded browser;
- use **PKCE**;
- use a cryptographically random OAuth `state` value and verify it on the
  callback;
- use a redirect on **`localhost` / `127.0.0.1` only, on an ephemeral port** —
  never a wildcard/all-interfaces bind;
- run a temporary callback listener that is shut down after success, denial,
  error, or timeout;
- handle browser-closed, access-denied, callback-never-arrives, `state`
  mismatch, token-exchange failure, loopback listener failure, and
  shutdown-during-authorization as **Google-configuration failures only** —
  never affecting local sale capability, inventory, receipts, reporting, or
  durable export jobs.

Scopes are limited to `https://www.googleapis.com/auth/drive.file` for business
data plus `openid` and `email` for showing the connected account. Broader Drive
or Sheets scopes must not be requested. The connected-account email is display
metadata only; any retained stable identifier is the OpenID Connect `sub` claim.

---

## REQ-GSHEET-017 — Automatic Spreadsheet Provisioning

**Priority:** MUST

Normal first-time setup must not require an existing spreadsheet. After OAuth
succeeds, the application creates and configures its **own** spreadsheet in the
owner's Google account, with the canonical `Sales` and `Sale Items` worksheets
(`DATA_MODEL.md §26`), and stores the resulting spreadsheet ID as non-secret
local configuration once creation succeeds. The client does not enter a
spreadsheet ID or worksheet names.

Provisioning must be safe under an **ambiguous creation outcome** (Google
creates the spreadsheet but the response is lost before the application learns
its ID, then the user retries or restarts): the application must not create
duplicate spreadsheets.

The V1 provisioning mechanism is **fixed** (`ARCHITECTURE.md §27.5.1`), not an
implementation choice:

- a durable local provisioning/idempotency token is generated and persisted
  **before** any create attempt and reused across every retry/restart;
- the spreadsheet is created with a **single Google Drive `files.create`
  request** carrying the display name, MIME type
  `application/vnd.google-apps.spreadsheet`, and app-private `appProperties`
  holding a stable Go Phones POS integration marker **and** the provisioning
  token — all in that one request. Sheets `spreadsheets.create`, and
  "create then attach `appProperties` separately", must not be used as the
  provisioning path;
- before creating, and again after any lost/ambiguous create response, the
  application searches Drive (`files.list`, restricted under the existing
  `drive.file` authorization) for a Sheets-MIME file whose `appProperties`
  carry the marker and this token, and **adopts** the single match instead of
  creating again;
- if more than one match is ever found, provisioning stops in a safe not-ready
  state; the application must not delete remote spreadsheets or guess which is
  authoritative;
- canonical worksheets are then created/verified **idempotently** via the Sheets
  API (inspect first, create only if missing, reuse if present, never
  double-add a canonical role after an ambiguous response), and the final
  structure is verified before **Ready to sync**.

Automatic recovery is bounded (`ARCHITECTURE.md §27.5.1` "Startup recovery
boundary"):

- **Explicit `Retry Setup`** (owner-initiated) runs the full sequence above,
  including the single tagged `files.create` on a zero-match result, reusing the
  existing OAuth credential and the existing durable provisioning token.
- **Application startup** performs Drive/Sheets work only when local recovery
  state records that a `files.create` was already attempted (a spreadsheet may
  exist remotely). Even then, startup runs **lookup only** — one `files.list`
  with the durable token; a single match is adopted and converged, more than one
  match remains `Connected / setup incomplete`, and a **zero-match result must
  not issue `files.create`**. For an ordinary `Connected / setup incomplete`
  state where no create was ever attempted, startup issues **no** Drive or
  Sheets request and does not mutate worksheets — recovery is only through
  explicit `Retry Setup`. Merely launching the application must never create or
  mutate files in the owner's Google Drive.

The Google Drive API is enabled as another API under the **same `drive.file`
scope** with no scope change. The user must be able to open the configured
spreadsheet from the POS with an explicit action that uses the system browser.

---

## REQ-GSHEET-018 — Connection and Setup State

**Priority:** MUST

The integration has three conceptual states — **Disconnected**,
**Connected / setup incomplete**, and **Ready to sync**. If OAuth succeeds and
the credential is stored but spreadsheet provisioning fails:

- the Google account remains connected; the owner must not have to reconnect it
  solely because provisioning failed;
- local sales, inventory, payments, receipts, and reporting are unaffected;
- the export worker performs no spreadsheet writes; existing durable export jobs
  remain queued;
- the UI offers a `Retry Setup` action;
- the application must not report Google Sheets as ready until the spreadsheet
  and both canonical worksheets are actually configured.

A `Connected / setup incomplete` state — and its sanitized reason — persists
across application restarts. Recovery is by explicit `Retry Setup`; automatic
startup recovery is bounded to lookup-only and only when a create was already
attempted (`REQ-GSHEET-017`, `ARCHITECTURE.md §27.5.1`).

The "needs re-authorization" health signal describes the **current active OAuth
credential generation**. A historical export-job authentication error recorded
under a superseded credential generation must not, by itself, mark a newer,
successfully-authorized credential as needing re-authorization
(`SUPPORT_DIAGNOSTICS.md §30`, `POS_WORKFLOWS.md §46`).

Network export delivery (`REQ-GSHEET-001`, `REQ-GSHEET-006`) is paused unless the
integration is **enabled, connected, and ready to sync**. A structural failure
of the configured spreadsheet after it was ready is handled by `REQ-GSHEET-020`.

---

## REQ-GSHEET-019 — Local Disconnect Without Network Dependency

**Priority:** MUST

`Disconnect Google Account` must:

- disable export;
- invalidate the active OAuth credential locally and make the refresh token
  immediately unusable by the export worker;
- commit the local configuration change and its audit event atomically;
- perform best-effort deletion of the encrypted credential wrapper afterward.

Remote Google token revocation may be attempted as a secondary network action,
but **successful remote revocation must not be required** for local disconnect
to succeed. A Google outage, revocation failure, or absent internet connection
must not prevent local disconnect. Network access must not be part of the local
configuration transaction.

---

## REQ-GSHEET-020 — Spreadsheet Target Recovery After a Structural Failure

**Priority:** MUST

A stored `google_spreadsheet_id` alone must not keep the integration in
**Ready to sync** after the application has obtained a **definite structural
failure** showing the configured remote spreadsheet can no longer be used
(`ARCHITECTURE.md §27.5.2`).

**Transient** Google failures (network outage, timeout / ambiguous response,
HTTP 5xx, rate limit) must **not** invalidate the spreadsheet configuration:
`google_spreadsheet_id` and the **Ready to sync** state are preserved, the
existing export retry / unknown-outcome rules apply, and the local sale is
unaffected.

When a **definite structural spreadsheet-target failure** is established (the
configured spreadsheet is definitely unavailable / not found, or the application
definitely no longer has permission to use it, or it can no longer satisfy the
canonical export-target contract):

- local sale / inventory / payment / receipt state is unchanged and the export
  job retains its canonical failure/retry evidence;
- the locally usable spreadsheet target (`google_spreadsheet_id`) is
  invalidated/cleared;
- the OAuth connection is preserved when the credential itself remains valid —
  the owner is **not** forced to disconnect or re-authorize;
- the integration transitions to **Connected / setup incomplete** with a
  persisted sanitized reason that the Google spreadsheet needs attention;
- the export worker makes no further spreadsheet export writes while setup is
  incomplete (jobs stay queued and durable);
- the UI visibly explains the spreadsheet needs attention and offers
  `Retry Setup`.

`Retry Setup` after a lost/deleted spreadsheet must: reuse the existing OAuth
connection; reuse the existing durable provisioning token; perform the canonical
Drive `files.list` lookup first; adopt on exactly one match; on **no** match, as
an owner-initiated action, create a replacement with the canonical single tagged
`files.create`; remain `Connected / setup incomplete` on more than one match;
converge and verify the canonical `Sales` and `Sale Items` worksheets and
headers; and return to **Ready to sync** only after full verification. The
export worker must **never** automatically create a replacement spreadsheet from
an export failure.

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

## REQ-DB-007 — SQLite Durability Configuration

**Priority:** MUST

SQLite must be configured with `journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`, and a `busy_timeout` (5000 ms default), and checkout transactions must use `BEGIN IMMEDIATE`. This configuration, and the reasoning behind it, is fixed in `DATA_MODEL.md` Section 54 rather than left to be decided during implementation, and is verified by the crash/abrupt-termination tests in `TEST_PLAN.md`.

---

## REQ-DB-008 — Supported Filesystem Assumption

**Priority:** MUST

The durability guarantees of `REQ-DB-007` apply only when the database file resides on a local, directly attached filesystem. The application must not claim equivalent crash-safety or locking guarantees for a database file located on a network drive/UNC path or inside a cloud-sync folder (OneDrive, Dropbox, Google Drive Desktop, etc.).

---

## REQ-DB-009 — Explicit Foreign-Key Actions

**Priority:** MUST

Every declared foreign key must specify an explicit `ON DELETE` action as defined in `DATA_MODEL.md` Section 35, so that deleting a product, customer, or any other referenced row can never cause historical sale, payment, or inventory-movement data to disappear.

---

# 18. Backup Requirements

## REQ-BACKUP-001 — Manual Backup Capability

**Priority:** MUST

V1 must provide an owner-initiated method of backing up the local SQLite database. When a verified off-device destination is configured, a manual backup must create and verify its normal local-disk recovery backup first, then best-effort copy that exact completed artifact off-device and independently verify the copy. Local success must be reported as success even if the protection copy fails, with the off-device failure reported separately.

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

V1 must create recurring automatic backups using a SQLite-safe procedure. Backup work must not corrupt the operational database or silently interrupt checkout. When a verified off-device destination is configured, the automatic workflow must create and verify the local-disk backup first, then copy that exact closed artifact off-device and verify the destination copy. It must not take two snapshots at different times. Pre-migration backups are always local-disk-only in V1 and never wait for or duplicate to off-device storage.

---

## REQ-BACKUP-006 — Backup Retention and Cleanup

**Priority:** MUST

Automatic backups must use a documented retention and cleanup policy so storage does not grow without bound. Cleanup must preserve backups required for an active migration or recovery case. V1 off-device retention is fixed, with no separate retention setting: automatic copies are retained for 14 days and manual copies for 90 days. Cleanup is confined to the exact configured app-managed off-device directory, removes only files and matching sidecars that pass app-managed identity/manifest rules, skips partial or unrelated files, preserves existing recovery holds and the only verified usable backup, and skips safely with visible health when the destination is unavailable.

---

## REQ-BACKUP-007 — Backup Health and Failure Reporting

**Priority:** MUST

The application must expose the time and result of the latest automatic backup, warn when backup is overdue, and make backup failures visible through diagnostics and the durable audit trail. Local-disk recovery health and optional off-device-protection health must remain separate. Off-device health distinguishes not configured, currently protected, and needs attention; attention must distinguish at least never succeeded, unavailable, stale, last copy failed, and destination verification failed. Stored configuration or an earlier success is never permanent proof that a destination is still off-device.

---

## REQ-BACKUP-008 — Verified Pre-Migration Backup

**Priority:** MUST

Before applying any schema migration to an **existing initialized database**, the application must create and verify a SQLite-consistent pre-migration backup, and durably record the required backup evidence, before any migration change (DDL) is applied. If backup creation, verification, or the durable recording of that evidence fails, the migration must not begin and startup must fail safely rather than expose an unsafe schema.

Initial creation of a brand-new empty database through the first migration (`001_initial_schema`) is **bootstrap initialization, not an upgrade**: it does not require a pre-migration recovery backup, because no prior authoritative database state exists to preserve and the tables that hold backup evidence do not exist until that first migration has run.

Once an initialized database exists, no schema migration may modify it without a verified pre-migration backup. This bootstrap exception is the only case in which a schema migration proceeds without one.

---

## REQ-BACKUP-009 — Backup Metadata

**Priority:** MUST

The system must retain enough local metadata to identify backup type, creation time, outcome, verification state, and failure details where applicable. This metadata supports backup-health display and recovery without making a backup copy part of the operational schema. Each physical local or off-device copy has its own metadata/result even when both contain the same logical snapshot and SHA-256. New off-device copies also have an atomically written, versioned, non-secret sidecar containing advisory identity, kind, time, source-version/schema, checksum, size, and location metadata. The sidecar is never a trust root: discovery recomputes file checksum and reads schema from SQLite, rejects or clearly marks conflicting claims, and remains backward-compatible with an otherwise valid older managed backup whose sidecar is absent.

---

## REQ-BACKUP-010 — Local Recovery vs. Device/Disk-Loss Protection

**Priority:** MUST

The application and its documentation must not describe a same-disk (default) backup as protecting against physical disk failure, computer loss, theft, or fire. V1 supports an optional, separately configurable off-device backup destination; the backup metadata (`REQ-BACKUP-009`) records whether a given backup is same-disk or off-device, and health/status displays state exactly what protection the currently configured backups provide.

For V1, a genuine accessible/writable UNC network destination may qualify. A local-filesystem destination qualifies only when trusted Windows inspection positively proves both a different physical disk from the operational database and USB/external device identity. A different drive letter, folder, partition, or internal physical disk does not qualify. A mapped network drive qualifies only if built-in Windows facilities positively resolve it as remote; unknown, unavailable, malformed, permission-denied, timed-out, or otherwise ambiguous inspection fails closed. The destination is reverified whenever an off-device copy is attempted.

Off-device configuration, verification, copy, retention, and health failures are isolated secondary failures. They must not block checkout, committed sales, local backup success, startup, migration, or local restore, and use the existing backup success/failure audit model rather than inventing a new audit-event type.

---

## REQ-BACKUP-011 — Safe Restore Workflow

**Priority:** MUST

Before replacing the active database with a backup, the application must: preserve a timestamped copy of the current (pre-restore) database; inspect the candidate backup's metadata (schema version, source app version, creation time); always require one explicit, unambiguous confirmation before replacing the active database, whether or not newer data is detected — restoring a backup is never a silent or default-confirmed action; detect and clearly warn, with the exact transaction count and date range, when the current database contains completed sales — identified by immutable Sale ID, never by comparing `completed_at` timestamps alone — that the backup does not; and validate the restored database before reopening checkout, falling back to the preserved pre-restore copy if validation fails. V1 restore is a whole-database replace-or-abort operation; it does not implement record-level merge between the current database and the restored backup.

The trusted restore-candidate view must unify live catalogued backups, valid preserved unreferenced files in known app-managed local roots, valid files in the configured app-managed off-device directory, and one backup explicitly selected by the owner through a native file-open dialog. Discovery must not insert reconstructed `backup_records` rows or otherwise mutate business SQLite. Managed-root discovery is non-recursive unless its defined layout requires otherwise, excludes partials, resolves canonical paths, and rejects traversal or reparse/symlink escape. The renderer receives safe metadata and opaque candidate IDs/tokens, never an arbitrary submitted or returned raw path.

Every source uses the same trusted verification pipeline before being offered as verified and again immediately before replacement: existence/readability, canonical resolved path, read-only SQLite open, `quick_check`, foreign-key check, `schema_migrations` and exact V1 schema compatibility, canonical critical-table readability, a fresh SHA-256, and comparison with any catalog or sidecar claim. An unrelated SQLite database is not a restore candidate merely because it opens. References to the same canonical physical file are deduplicated; byte-identical files in local and off-device locations remain separate physical candidates. Any material candidate change invalidates prior verification/confirmation and requires a fresh confirmation.

**Browse for a backup file...** must use the Electron main process's native open dialog. Selection does not configure off-device storage, trust a filename, create a `backup_records` row, or bypass universal restore confirmation. Whole-database restore faithfully rewinds ordinary SQLite settings, including off-device destination configuration, under `DATA_MODEL.md` Section 52A; the application must not silently reapply a newer off-device setting afterward.

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

Authentication secrets must not be stored as plaintext passwords. The shared password must be hashed using an industry-standard salted, memory-hard algorithm (e.g., bcrypt, scrypt, or Argon2); a fast unsalted hash (e.g., raw SHA-256/MD5) must not be used.

---

## REQ-AUTH-004 — First-Run Credential Setup

**Priority:** MUST

On first launch, when no shared credential exists yet, the application must present a setup screen requiring the shared password (with confirmation) to be created before the POS home screen is reachable. This does not require internet access. Credential creation records a durable `AUTH_CREDENTIAL_CHANGED` audit event.

---

## REQ-AUTH-005 — Password Change

**Priority:** MUST

The application must allow the shared password to be changed from Settings by entering the current password and a new password (with confirmation). This does not require internet access and records a durable `AUTH_CREDENTIAL_CHANGED` audit event.

---

## REQ-AUTH-006 — Local, Non-Online Recovery

**Priority:** MUST

V1 must define a documented local recovery procedure for a forgotten shared password that requires direct physical/administrative access to the installed application and does not introduce online account recovery (no email, SMS, or cloud identity service). Recovery resets the shared credential without deleting or altering business data.

---

## REQ-AUTH-007 — Reinstall and Restore Independence

**Priority:** MUST

Reinstalling the application while the existing application-data directory is preserved must continue to require the existing shared password. Restoring a SQLite database backup must not itself change the currently configured shared login credential, since the credential is stored independently of the SQLite settings table.

---

## REQ-AUTH-008 — Brute-Force Backoff

**Priority:** MUST

After repeated consecutive failed login attempts, the application must impose an increasing delay before the next attempt is accepted, without ever permanently locking out the shared login, since V1 has no alternate account or online reset path.

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
- Shared-credential creation/change
- A Clover-approved card charge whose local commit failed (`REQ-RECONCILE-001` through `REQ-RECONCILE-006`)

---

## REQ-AUDIT-003 — Audit Event Context

**Priority:** MUST

Each audit event must preserve a stable event ID, event type, timestamp, relevant entity identifiers, available actor or system context, and a reason or result where required. It may include a correlation ID for diagnostic tracing but must not store secrets or unnecessary customer/payment data.

---

## REQ-AUDIT-004 — Audit Consistency and History

**Priority:** MUST

Audit events for transactional business changes must commit with the corresponding SQLite operation. Historical audit events must not be silently rewritten or deleted.

For a lifecycle-marker event describing the start of a multi-step process (`MIGRATION_STARTED`), `outcome` describes only whether that start action was itself durably recorded (`SUCCESS`); it makes no claim about the eventual result of the process, which is recorded separately and unambiguously by its terminal event (`MIGRATION_COMPLETED` or `MIGRATION_FAILED`). No third `outcome` value is introduced for this case.

---

## REQ-AUDIT-005 — Monotonic Local Ordering

**Priority:** MUST

In addition to its wall-clock `occurred_at` timestamp, each audit event must carry a locally monotonically increasing sequence value that is never affected by system clock changes, so the true order of events remains determinable even across a significant clock anomaly (`REQ-HEALTH-002`). No distributed/multi-device ordering scheme is required in V1.

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

## REQ-EXPORT-004 — Formula Injection Neutralization

**Priority:** MUST

Any exported text field value beginning with `=`, `+`, `-`, or `@` must be neutralized (e.g., prefixed with a leading apostrophe) before being written to CSV, so that a spreadsheet application opening the export cannot execute it as a formula. This applies to every owner CSV export.

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

When internet access is available, the installed application must be able to check for approved updates. Once an approved update is discovered while online, the application must automatically begin downloading it in the background without blocking or materially degrading checkout. Whether and how often the application checks (at startup, periodically, or on manual request) is implementation-configurable; whether a discovered update downloads automatically is not — download begins automatically once an approved update is found.

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

Schema changes must use ordered, versioned migrations. A required migration of an existing initialized database may start only after its verified pre-migration backup and required durable evidence exist (`REQ-BACKUP-008`); migration failure must stop safely, preserve recovery evidence and the backup, and prevent normal checkout against an unsafe schema. (First-run creation of a brand-new empty database via `001_initial_schema` is bootstrap initialization and is exempt from the backup gate — see `REQ-BACKUP-008`.)

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

## ACCEPT-011 — Clover Approved, Local Commit Fails

1. Cashier selects Card and confirms Clover approval inside the POS.
2. The local sale transaction is forced to fail (e.g., simulated disk-write failure).

Expected:

No completed sale exists; the checkout attempt (payment method, intended total, Clover-approval confirmation) is durably recorded; the cashier is warned that the Clover charge may require separate review/void/refund in Clover; the attempt appears in the reconciliation queue.

---

## ACCEPT-012 — Restore Does Not Silently Discard Newer Data

1. Take a backup at time T.
2. Complete additional sales after T.
3. Attempt to restore the backup from T.

Expected:

The application identifies, by immutable Sale ID, the completed sales the current database holds that the backup does not, warns how many transactions would be lost and their date range, and requires explicit confirmation before proceeding; a pre-restore recovery copy is preserved regardless of the outcome.

---

## ACCEPT-013 — Restore Always Requires Confirmation, Even Without a Newer Sale

1. Take a backup at time T with no sales completed after it.
2. Without completing any further sale, change other business data (for example void an existing sale, adjust inventory, edit a product or customer, or change the tax rate).
3. Attempt to restore the backup from T.

Expected:

The application still requires one explicit confirmation before replacing the active database, even though no completed sale would be lost — the confirmation states that the operation replaces the current database with the selected backup. Restore never silently proceeds merely because no newer completed sale was detected.

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
