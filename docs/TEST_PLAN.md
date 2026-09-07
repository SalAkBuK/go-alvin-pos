# Go Phones POS — Test Plan

## 1. Purpose

This document defines the V1 testing strategy for Go Phones POS.

The objective is not merely to confirm that screens render or buttons respond.

The objective is to prove that:

- Sales are recorded correctly.
- Inventory remains consistent.
- Historical transactions remain stable.
- Offline operation works.
- Application restarts do not lose committed data.
- Google Sheets failures do not block checkout.
- Printing failures do not corrupt sales.
- Duplicate transaction creation is prevented.
- Database backups can actually be restored.
- Voids preserve history, restore inventory, and correct reporting atomically.
- Updates preserve business data and defer safely around checkout.
- Diagnostics are useful, durable where required, and privacy-safe.
- Owner CSV exports never mutate authoritative data.
- The application works with the client's real Windows hardware.

This document should remain aligned with:

- `PRODUCT_SCOPE.md`
- `PRODUCT_REQUIREMENTS.md`
- `ARCHITECTURE.md`
- `DATA_MODEL.md`
- `POS_WORKFLOWS.md`

---

# 2. Testing Principle

The most important V1 verification rule is:

> A sale is considered successful only when its authoritative SQLite transaction has committed successfully.

External operations such as:

- Printing
- Google Sheets API export
- Internet connectivity

must be tested separately from local sale integrity.

---

# 3. Test Levels

Go Phones POS V1 should use five main testing levels:

1. Unit tests
2. Database integration tests
3. Application/service integration tests
4. End-to-end application tests
5. Physical hardware and field tests

Each level verifies different risks.

---

# 4. Unit Tests

Unit tests verify isolated business logic without requiring Electron UI, physical devices, or external services.

Recommended targets include:

- Money calculations
- Tax calculations
- Discount calculations
- Inventory calculations
- Product validation
- Customer validation
- Receipt-number formatting
- Receipt calculations
- Export retry rules
- Export state transitions
- Domain rules

---

# 5. Unit Test Naming

Recommended naming convention:

```text
UNIT-TAX-001
UNIT-SALE-001
UNIT-INV-001
UNIT-PAY-001
UNIT-GSHEET-001
```

Test names should describe observable behavior.

Example:

```text
UNIT-TAX-001
8.25% tax on $550 produces the expected cent value.
```

---

# 6. Money Tests

## TEST-MONEY-001 — Integer Cents

Given:

```text
$599.99
```

Expected internal representation:

```text
59999
```

PASS if no floating-point representation is used for persisted money.

---

## TEST-MONEY-002 — Zero Value

Given:

```text
$0.00
```

Expected:

```text
0
```

---

## TEST-MONEY-003 — Invalid Negative Sale Price

Given:

```text
-$1.00
```

Expected:

Validation rejects the price.

---

## TEST-MONEY-004 — Repeated Calculation Stability

Run the same monetary calculation repeatedly.

Expected:

Identical cent-level result every time.

---

# 7. Tax Tests

## TEST-TAX-001 — Basic Tax Calculation

Given a known taxable amount and configured tax rate:

Expected:

Correct tax in integer cents.

---

## TEST-TAX-002 — Historical Tax Preservation

1. Complete sale using tax rate A.
2. Change configured tax rate to B.
3. Reload old sale.

Expected:

Old sale still contains tax rate A and original tax amount.

---

## TEST-TAX-003 — Tax Rounding

Test values that create fractional cents.

Expected:

The defined rounding rule is applied consistently.

The same rounding rule must be used in:

- Checkout
- Sales history
- Receipt
- Reports
- Google Sheets export

---

## TEST-TAX-004 — Renderer Cannot Override Tax

Manipulate or simulate incorrect renderer-submitted tax value.

Expected:

Trusted application layer recalculates authoritative tax.

---

# 8. Discount Tests

## TEST-DISC-001 — Simple Negotiated Price

Listed:

```text
$599
```

Sold:

```text
$550
```

Expected discount:

```text
$49
```

---

## TEST-DISC-002 — Quantity Two

Listed unit price:

```text
$599
```

Sold unit price:

```text
$550
```

Quantity:

```text
2
```

Expected:

```text
Listed total = $1,198
Sold total = $1,100
Discount = $98
```

---

## TEST-DISC-003 — No Discount

Listed price equals sold price.

Expected:

Discount = 0.

---

## TEST-DISC-004 — Negative Sold Price

Expected:

Rejected.

---

# 9. Product Tests

## TEST-PROD-001 — Create Product

Create valid product.

Expected:

- Product persists.
- Product appears in local search.
- Product survives application restart.

---

## TEST-PROD-002 — Initial Inventory Movement

Create product with quantity:

```text
5
```

Expected:

- Product quantity = 5
- `INITIAL_STOCK +5` movement exists

---

## TEST-PROD-003 — Duplicate Barcode

Create product A with barcode X.

Attempt product B with barcode X.

Expected:

Second product is rejected.

---

## TEST-PROD-004 — Duplicate SKU

If SKU uniqueness is enabled:

Create product A with SKU X.

Attempt product B with SKU X.

Expected:

Second product is rejected.

---

## TEST-PROD-005 — Archive Product

Archive existing product.

Expected:

- Historical references remain.
- Product no longer appears as normally sellable.
- Existing historical receipts remain correct.

---

## TEST-PROD-006 — Edit Historical Product

1. Sell product.
2. Rename current product.
3. Change current price.
4. View old sale.

Expected:

Historical sale shows original values.

---

# 10. Inventory Tests

## TEST-INV-001 — Single Quantity Deduction

Initial quantity:

```text
5
```

Sell:

```text
1
```

Expected:

```text
4
```

---

## TEST-INV-002 — Multiple Quantity Deduction

Initial:

```text
5
```

Sell:

```text
2
```

Expected:

```text
3
```

---

## TEST-INV-003 — Insufficient Stock

Available:

```text
1
```

Requested:

```text
2
```

Expected:

Sale rejected.

Inventory remains:

```text
1
```

---

## TEST-INV-004 — Zero Stock

Product quantity:

```text
0
```

Expected:

Product cannot be completed in a sale.

---

## TEST-INV-005 — Manual Adjustment Increase

Current:

```text
5
```

Adjustment:

```text
+2
```

Expected:

```text
7
```

Movement created:

```text
MANUAL_ADJUSTMENT +2
```

---

## TEST-INV-006 — Manual Adjustment Decrease

Current:

```text
5
```

Adjustment:

```text
-2
```

Expected:

```text
3
```

Movement exists.

---

## TEST-INV-007 — Invalid Negative Inventory

Current:

```text
1
```

Attempt adjustment:

```text
-2
```

Expected:

Rejected.

---

# 11. Sale Atomicity Tests

These are critical.

## TEST-ATOMIC-001 — Successful Sale

Sale transaction succeeds.

Expected all of the following exist together:

- Unique receipt number allocation
- Sale
- Sale items
- Payment
- Updated inventory
- Inventory movement
- Required sale-completed and, when applicable, price-override audit events
- Checkout request completion
- One durable `PENDING` Google export job; configuration gates network processing when integration is disabled

All are written inside the same authoritative SQLite transaction before commit.

---

## TEST-ATOMIC-002 — Failure During Sale Item Insert

Artificially trigger failure after sale creation but before sale-item completion.

Expected:

ROLLBACK.

After transaction:

- No completed sale
- No inventory change
- No payment
- No movement
- No sale-completion or price-override audit event
- No export job

---

## TEST-ATOMIC-003 — Failure During Payment Insert

Artificially fail payment creation.

Expected:

Entire sale rolls back.

---

## TEST-ATOMIC-004 — Failure During Inventory Update

Artificially fail stock update.

Expected:

Entire sale rolls back.

---

## TEST-ATOMIC-005 — Failure During Export Job Insert

Artificially fail durable export-job creation inside the transaction, with Google Sheets processing enabled and disabled.

Expected:

Sale must roll back.

This preserves the guarantee that every committed sale has one durable export job.

---

## TEST-ATOMIC-006 — Failure During Required Audit Insert

Artificially fail the required sale-completed or price-override audit insertion.

Expected:

The sale, items, payment, inventory changes, movements, checkout completion, receipt allocation, audit events, and export job all roll back together.

---

# 12. Checkout Idempotency Tests

## TEST-IDEMP-001 — Double Click

Submit Complete Sale twice rapidly using the same checkout request ID.

Expected:

Exactly one sale.

---

## TEST-IDEMP-002 — Repeated IPC Submission

Send the same checkout request repeatedly.

Expected:

Same completed sale returned.

No duplicate receipt.

---

## TEST-IDEMP-003 — Retry After UI Timeout

1. Checkout completes locally.
2. Renderer behaves as though it did not receive response.
3. Same request is retried.

Expected:

Existing sale returned.

---

## TEST-IDEMP-004 — App Crash After Commit

1. Sale commits.
2. Application crashes before UI receives success.
3. Application restarts.
4. Original request is retried.

Expected:

No duplicate transaction.

---

# 13. Receipt Number Tests

## TEST-RECNO-001 — Unique Numbers

Complete multiple sales.

Expected:

Each receipt number is unique.

---

## TEST-RECNO-002 — Restart Persistence

1. Complete sale.
2. Restart app.
3. Complete another sale.

Expected:

No receipt number reuse.

---

## TEST-RECNO-003 — Transaction Failure

Trigger failed sale during receipt-number generation flow.

Expected:

No duplicate receipt number is produced later.

Any skipped number behavior must remain consistent with documented strategy.

---

## TEST-RECNO-004 — Duplicate Constraint

Artificially attempt duplicate receipt number.

Expected:

Database rejects it.

---

# 14. Customer Tests

## TEST-CUST-001 — Create Customer

Create valid customer.

Expected:

Customer persists locally.

---

## TEST-CUST-002 — Search Customer by Name

Expected:

Correct matches.

---

## TEST-CUST-003 — Search Customer by Phone

Expected:

Correct matches.

---

## TEST-CUST-004 — Customerless Sale

Complete sale without customer.

Expected:

Sale succeeds.

---

## TEST-CUST-005 — Customer Sale

Attach customer and complete sale.

Expected:

Customer relationship and snapshots saved.

---

## TEST-CUST-006 — Historical Customer Snapshot

1. Complete sale for Customer A.
2. Change customer's name or phone.
3. Reopen historical sale.

Expected:

Historical receipt uses the required transaction-time customer snapshot.

---

# 15. Cash Payment Tests

## TEST-CASH-001 — Basic Cash Sale

Complete cash transaction.

Expected:

- Payment method = CASH
- Payment amount = sale total
- Sale completes

---

## TEST-CASH-002 — Optional Tendered Amount

If implemented:

Total:

```text
$10
```

Tendered:

```text
$20
```

Expected:

```text
Change = $10
```

---

## TEST-CASH-003 — Insufficient Tender

If tendered amount feature is implemented:

Tendered less than total.

Expected:

Checkout cannot complete as fully paid.

---

# 16. Card / Clover Tests

## TEST-CARD-001 — Clover Approved

1. Select Card.
2. Confirm Clover payment approved.
3. Complete sale.

Expected:

Payment method = CARD.

---

## TEST-CARD-002 — Clover Declined

Select:

`Payment Declined / Cancel`

Expected:

- No sale
- No inventory change
- Cart remains

---

## TEST-CARD-003 — Card Confirmation Required

Attempt to complete Card sale without approval confirmation.

Expected:

Rejected.

---

## TEST-CARD-004 — Clover Integration Independence

Disconnect Clover or do not provide any Clover API access.

Expected:

POS application itself remains operational because V1 card handling is manual.

---

# 17. Barcode Tests

## TEST-SCAN-001 — Known Barcode

Scan configured barcode.

Expected:

Correct product found.

---

## TEST-SCAN-002 — Unknown Barcode

Expected:

Non-fatal "not found" state.

Cart preserved.

---

## TEST-SCAN-003 — Repeated Barcode

Scan same product twice.

Quantity increases to 2 if stock allows.

If stock does not allow the increase, the cart remains valid and shows the stock error.

---

## TEST-SCAN-004 — Barcode Leading Zero

Barcode:

```text
001234567890
```

Expected:

Leading zeros preserved.

---

## TEST-SCAN-005 — Scanner Offline

With Google Sheets integration enabled, disconnect internet.

Scan known product.

Expected:

Works normally.

---

# 18. Offline Tests

These are production-critical.

## TEST-OFF-001 — Launch Offline

1. Disconnect internet physically.
2. Launch POS.

Expected:

Application starts.

---

## TEST-OFF-002 — Login Offline

Expected:

Shared login works.

---

## TEST-OFF-003 — Product Search Offline

Expected:

Works.

---

## TEST-OFF-004 — Customer Search Offline

Expected:

Works.

---

## TEST-OFF-005 — Create Customer Offline

Expected:

Works.

---

## TEST-OFF-006 — Cash Sale Offline

Expected:

Full sale completes.

---

## TEST-OFF-007 — Card Recording Offline

Assuming Clover independently approves payment:

Expected:

POS can record approved Card sale.

---

## TEST-OFF-008 — Receipt Offline

Expected:

Receipt generation works.

---

## TEST-OFF-009 — Printing Offline

Expected:

Local printer works without internet.

---

## TEST-OFF-010 — Sales History Offline

Expected:

Available.

---

## TEST-OFF-011 — Daily Report Offline

Expected:

Generated from SQLite.

---

## TEST-OFF-012 — App Restart Offline

1. Complete offline sale.
2. Close app.
3. Remain offline.
4. Reopen app.

Expected:

Sale and stock remain correct.

---

## TEST-OFF-013 — Windows Restart Offline

1. Complete offline sale.
2. Restart Windows.
3. Keep internet disconnected.
4. Open POS.

Expected:

Committed state preserved.

---

# 19. Connectivity Transition Tests

## TEST-NET-001 — Online to Offline During Idle

Expected:

POS continues functioning.

---

## TEST-NET-002 — Online to Offline During Cart

1. Build cart while online.
2. Disconnect internet.
3. Complete sale.

Expected:

Sale succeeds locally.

---

## TEST-NET-003 — Offline to Online

Reconnect internet.

Expected:

Pending Google exports may resume.

Checkout remains responsive.

---

## TEST-NET-004 — Flapping Connection

Repeatedly connect/disconnect internet.

Expected:

No local sale corruption.

Export queue remains consistent.

---

# 20. Google Sheets Tests

## TEST-GSHEET-001 — Successful Export

Complete online sale.

Expected:

- The durable export job commits atomically with the local sale.
- The Google Sheets API request occurs only after commit.
- Job becomes EXPORTED.

---

## TEST-GSHEET-002 — Sales Worksheet

Expected one transaction row.

Correct Sale ID.

Correct totals.

---

## TEST-GSHEET-003 — Sale Items Worksheet

Expected item rows correspond to sale.

Correct Sale ID and Sale Item IDs.

---

## TEST-GSHEET-004 — Multi-Item Sale

Complete transaction with multiple products.

Expected:

- One Sales row
- Correct number of Sale Items rows

---

## TEST-GSHEET-005 — Offline Queue

Disconnect internet.

Complete sale.

Expected:

Export job = PENDING.

---

## TEST-GSHEET-006 — Queue Persistence After App Restart

Complete offline sale.

Restart app.

Expected:

PENDING job remains.

---

## TEST-GSHEET-007 — Queue Persistence After Windows Restart

Same test using full Windows restart.

Expected:

Job remains.

---

## TEST-GSHEET-008 — Reconnect Export

Reconnect internet.

Expected:

Pending job eventually exports exactly once.

---

## TEST-GSHEET-009 — API Authentication Failure

Use invalid/expired credentials.

Expected:

- Local sale succeeds.
- Export does not.
- Error stored safely.
- No secret logged.

---

## TEST-GSHEET-010 — Spreadsheet Permission Failure

Remove spreadsheet access.

Expected:

Local POS unaffected.

Export fails visibly.

---

## TEST-GSHEET-011 — Spreadsheet Missing

Target spreadsheet unavailable.

Expected:

Local POS unaffected.

---

## TEST-GSHEET-012 — Worksheet Missing

Delete/rename configured worksheet.

Expected:

Export failure handled safely.

---

## TEST-GSHEET-013 — Rate Limit

Simulate Google rate limiting.

Expected:

Job retries later.

Checkout unaffected.

---

## TEST-GSHEET-014 — Timeout Before Response

Simulate request where Google may have accepted the data but application loses response.

Expected:

Retry does not duplicate transaction.

---

## TEST-GSHEET-015 — Manual Retry

Failed job manually retried.

Expected:

No duplicate.

---

## TEST-GSHEET-016 — Stale EXPORTING Recovery

1. Force job to EXPORTING.
2. Crash app.
3. Restart.

Expected:

Job becomes safely retryable.

---

## TEST-GSHEET-017 — Google Fully Unavailable

Block Google API completely.

Run POS for multiple sales.

Expected:

- Every local sale succeeds.
- Every export remains pending/failed appropriately.
- Reports use all local sales.
- No checkout degradation.

---

## TEST-GSHEET-018 — Integration Disabled at Sale Commit

Disable Google Sheets integration and complete a sale.

Expected:

- The sale and its one durable export job commit atomically.
- Job is `PENDING`, with network processing gated by the disabled configuration.
- No Google network request occurs.

---

## TEST-GSHEET-019 — Enable After Sales While Disabled

Complete sales while integration is disabled, then configure and enable it.

Expected:

Represented sale states become eligible and export idempotently by immutable Sale ID without creating additional jobs or logical sales.

---

# 21. Printing Tests

## TEST-PRINT-001 — Basic Print

Complete sale and print receipt.

Expected:

Correct transaction receipt.

---

## TEST-PRINT-002 — Printer Disconnected

Disconnect printer before sale.

Expected:

Sale completes.

Printing fails separately.

---

## TEST-PRINT-003 — Reprint After Printer Recovery

Reconnect printer.

Reprint historical receipt.

Expected:

Works.

---

## TEST-PRINT-004 — Wrong Printer

Select unavailable printer.

Expected:

Sale unaffected.

Meaningful print failure shown.

---

## TEST-PRINT-005 — Historical Receipt Integrity

1. Complete sale.
2. Change product price.
3. Change business settings.
4. Reprint old receipt.

Expected:

Stored historical snapshots are used.

---

## TEST-PRINT-006 — Application Restart Before Reprint

Sale completed.

App restarted.

Receipt reprinted.

Expected:

Correct historical data.

---

# 22. Reporting Tests

## TEST-REPORT-001 — Transaction Count

Create known number of completed sales.

Expected:

Correct count.

---

## TEST-REPORT-002 — Gross Sales

Expected:

Correct sum.

---

## TEST-REPORT-003 — Discounts

Expected:

Correct discount sum.

---

## TEST-REPORT-004 — Tax

Expected:

Correct tax sum.

---

## TEST-REPORT-005 — Final Sales

Expected:

Correct final totals.

---

## TEST-REPORT-006 — Cash/Card Breakdown

Create known mix.

Expected:

Correct separate totals.

---

## TEST-REPORT-007 — Pending Google Exports

Have local sales not yet exported.

Expected:

Local report still includes all completed sales.

---

# 23. Sales History Tests

## TEST-HIST-001 — View Completed Sale

Expected:

All transaction details available.

---

## TEST-HIST-002 — Receipt Search

Search by receipt number.

Expected:

Correct sale.

---

## TEST-HIST-003 — Customer Search

Expected:

Customer-associated sale found.

---

## TEST-HIST-004 — Historical Snapshot

Edit product after sale.

Expected:

Old sale unchanged.

---

## TEST-HIST-005 — Google Export State

Expected:

Correct Pending / Failed / Exported display.

---

# 24. Database Persistence Tests

## TEST-DB-001 — Application Restart

Committed data survives app restart.

---

## TEST-DB-002 — Windows Restart

Committed data survives OS restart.

---

## TEST-DB-003 — Foreign Keys Enabled

Attempt invalid relationship.

Expected:

Rejected.

---

## TEST-DB-004 — Invalid Negative Product Quantity

Direct or repository-level attempt.

Expected:

Rejected.

---

## TEST-DB-005 — Duplicate Receipt

Expected:

Rejected.

---

## TEST-DB-006 — Duplicate Export Job

Attempt second export job for same sale.

Expected:

Rejected.

---

## TEST-DB-007 — Migration Execution

Fresh database.

Expected:

All migrations apply in order.

---

## TEST-DB-008 — Migration Idempotence

Restart application.

Expected:

Applied migrations are not rerun.

---

# 25. Migration Upgrade Tests

Fresh-install tests are not enough.

For each future migration:

1. Create database at previous version.
2. Populate realistic data.
3. Upgrade application.
4. Apply new migration.
5. Verify existing data.
6. Verify new functionality.
7. Verify old receipts.
8. Verify inventory.
9. Verify pending export jobs.

No release should rely only on testing a newly created database.

---

# 26. Crash Tests

## TEST-CRASH-001 — Crash Before Commit

Kill application during incomplete checkout.

Expected:

No partial sale.

---

## TEST-CRASH-002 — Crash During Transaction

Artificially terminate process.

Expected:

SQLite recovery results in either full commit or rollback.

Never partial business state.

---

## TEST-CRASH-003 — Crash Immediately After Commit

Expected after restart:

- Sale exists
- Stock correct
- Payment exists
- Export job exists

---

## TEST-CRASH-004 — Crash During Google Export

Expected:

Local sale safe.

Export retryable.

---

## TEST-CRASH-005 — Crash During Printing

Expected:

Sale safe.

Receipt reprintable.

---

# 27. Backup Tests

## TEST-BACKUP-001 — Create Backup

Expected:

Backup file created successfully.

---

## TEST-BACKUP-002 — Backup While Database Active

Perform backup with active application.

Expected:

Consistent backup.

No corruption.

---

## TEST-BACKUP-003 — Restore Backup

Restore backup into test environment.

Expected:

Application starts and data matches source.

---

## TEST-BACKUP-004 — Restore Inventory

Verify quantities.

---

## TEST-BACKUP-005 — Restore Sales

Verify transactions and receipts.

---

## TEST-BACKUP-006 — Restore Export Queue

Pending and failed jobs remain valid after restoration.

---

## TEST-BACKUP-007 — Invalid Backup Destination

Expected:

Backup failure shown.

POS sales remain operational.

---

## TEST-BACKUP-008 — Recurring Automatic Backup

Advance the configured schedule without manual action, including while a cart is active and while a sale request is in flight.

Expected:

- One SQLite-safe backup is created and verified.
- Last-successful-backup health is updated.
- A durable success audit event exists.
- Checkout is neither interrupted nor silently abandoned; backup work defers or proceeds only through SQLite-safe coordination.

---

## TEST-BACKUP-009 — Automatic Backup Failure

Make the automatic-backup destination unavailable.

Expected:

- Failure is visible in backup health.
- A durable failure audit event and sanitized diagnostic event exist.
- A healthy local database remains usable for sales.

---

## TEST-BACKUP-010 — Retention Cleanup

Create verified backups beyond the configured retention policy.

Expected:

- Only out-of-policy backups are removed.
- Backups held for active migration or recovery are preserved.
- The only verified usable backup is never removed.
- The active database is unchanged.

---

## TEST-BACKUP-011 — Backup Overdue Health

Prevent successful backup beyond the allowed interval.

Expected:

Support & Diagnostics shows an overdue warning without falsely reporting database failure.

---

## TEST-BACKUP-012 — Verified Pre-Migration Backup

Run an update that requires a schema migration.

Expected:

- A SQLite-safe backup is created and verified first.
- Migration begins only after verification succeeds.
- Backup and migration audit events exist.

---

## TEST-BACKUP-013 — Pre-Migration Backup Failure

Force backup creation or verification to fail.

Expected:

- Migration does not begin.
- Existing business data remains available under the prior compatible application state.
- Recovery guidance and a stable error code are shown.

---

## TEST-BACKUP-014 — Restore Maintenance Safety

Attempt restore during an active or in-flight checkout, then retry from an idle state.

Expected:

- Restore is rejected or deferred while checkout is active.
- Idle restore obtains exclusive database lifecycle control.
- Checkout remains unavailable until restored database validation succeeds or the original database is safely retained.

---

## TEST-BACKUP-015 — Backup Metadata

Run manual, automatic, successful, failed, and verified pre-migration backup attempts.

Expected:

Local metadata correctly records backup type, creation time, outcome, verification state, and sanitized failure details without storing backup contents in the operational schema.

---

## TEST-BACKUP-016 — Google Sheets Is Not a Backup

Export all eligible sales to Google Sheets, then evaluate restore capability using only those worksheets.

Expected:

The system and recovery documentation do not present Sheets as sufficient to restore products, customers, inventory, movements, settings, audits, receipt sequence, or queued work; a SQLite backup remains required.

---

# 28. Authentication Tests

## TEST-AUTH-001 — Correct Password

Expected:

Login succeeds.

---

## TEST-AUTH-002 — Incorrect Password

Expected:

Rejected.

---

## TEST-AUTH-003 — Offline Authentication

Disconnect internet.

Expected:

Login works.

---

## TEST-AUTH-004 — Password Storage

Inspect persisted credential representation.

Expected:

No plaintext password.

---

# 29. Security Tests

## TEST-SEC-001 — Node Access From Renderer

Expected:

Renderer does not have unrestricted Node access.

---

## TEST-SEC-002 — Arbitrary SQL Through IPC

Attempt to invoke generic SQL.

Expected:

No generic SQL IPC capability exists.

---

## TEST-SEC-003 — Arbitrary File Access

Expected:

Renderer cannot request unrestricted filesystem operations.

---

## TEST-SEC-004 — Invalid IPC Payload

Send malformed checkout payload.

Expected:

Rejected safely.

---

## TEST-SEC-005 — Google Secrets in Renderer

Inspect renderer bundle.

Expected:

No Google secret or token.

---

## TEST-SEC-006 — Secrets in Git

Repository scan.

Expected:

No committed secrets.

---

## TEST-SEC-007 — Secrets in Logs

Trigger Google/authentication errors.

Expected:

Logs contain no credentials or tokens.

---

# 30. Performance Tests

V1 has a small expected inventory, so these should remain pragmatic.

## TEST-PERF-001 — Product Search

With realistic inventory dataset:

Expected:

Search appears immediate.

---

## TEST-PERF-002 — Barcode Lookup

Expected:

No noticeable delay.

---

## TEST-PERF-003 — Checkout Completion

Expected:

UI provides immediate processing feedback.

No accidental second submission.

---

## TEST-PERF-004 — Export Queue Backlog

Create many pending export jobs.

Expected:

UI remains responsive while worker processes queue.

---

# 31. Installer Tests

## TEST-INSTALL-001 — Clean Windows Machine

Install application on machine without development tooling.

Expected:

Application installs and launches.

---

## TEST-INSTALL-002 — No Node.js

Expected:

Application works.

---

## TEST-INSTALL-003 — No Git

Expected:

Application works.

---

## TEST-INSTALL-004 — No VS Code

Expected:

Application works.

---

## TEST-INSTALL-005 — App Data Location

Expected:

SQLite database is stored in correct application-data location.

Not inside installation files.

---

## TEST-INSTALL-006 — Uninstall/Reinstall Data Behavior

Uninstall normally, then reinstall and inspect the application-data location.

Expected:

Ordinary uninstall preserves the business database. Data is removed only through a separate explicit user choice that clearly identifies the business data to be deleted.

---

# 32. Hardware Acceptance Tests

Automated tests cannot replace physical testing.

The final application must be tested with:

- Client's actual Windows PC or representative equivalent
- Client's USB/Bluetooth barcode scanner
- Client's current printer
- Thermal printer when acquired
- Clover terminal operational workflow

---

# 33. Scanner Hardware Tests

## HW-SCAN-001 — USB Scanner

Connect client's scanner.

Expected:

Known product lookup works.

---

## HW-SCAN-002 — Bluetooth Scanner

If scanner supports Bluetooth:

Expected:

Works with same workflow.

---

## HW-SCAN-003 — Rapid Scanning

Scan multiple products quickly.

Expected:

Inputs are not mixed or lost.

---

## HW-SCAN-004 — Scanner While Offline

Expected:

Works.

---

# 34. Printer Hardware Tests

## HW-PRINT-001 — Existing Printer

Print actual sales receipt.

Expected:

Readable and complete.

---

## HW-PRINT-002 — Printer Offline

Disconnect during use.

Expected:

Sale safe.

---

## HW-PRINT-003 — Reconnect

Expected:

Reprint works.

---

## HW-PRINT-004 — Thermal Printer

When acquired:

Test intended 80mm or 58mm width.

Verify:

- Item names
- Totals
- Disclaimer
- Thank-you message
- No critical clipping

---

# 35. Clover Operational Tests

No direct API integration is required in V1.

## HW-CLOVER-001 — Successful Card Sale

1. POS displays total.
2. Cashier processes same amount on Clover.
3. Clover approves.
4. Cashier confirms approval.
5. POS records sale.

Expected:

Correct.

---

## HW-CLOVER-002 — Declined Card

Expected:

No local sale until payment succeeds.

---

## HW-CLOVER-003 — Clover Unavailable

Expected:

Cash POS workflow remains available.

---

# 36. Real Offline Acceptance Test

This must use actual physical network disconnection.

Do not merely mock `navigator.onLine`.

Procedure:

1. Disconnect Wi-Fi.
2. Disconnect Ethernet if present.
3. Confirm internet is unavailable.
4. Launch Go Phones POS.
5. Login.
6. Search product.
7. Scan barcode.
8. Create customer.
9. Complete cash sale.
10. Print receipt.
11. Check inventory.
12. Check Sales History.
13. Check Daily Report.
14. Close app.
15. Restart Windows.
16. Open app while still offline.
17. Verify everything.
18. Reconnect internet.
19. Verify Google export.
20. Confirm no duplicates.

Expected:

PASS.

---

# 37. Production Acceptance Matrix

The following scenarios are mandatory release blockers.

| Test | Required |
|---|---|
| Product creation | PASS |
| Product persistence | PASS |
| Barcode scan | PASS |
| Cash sale | PASS |
| Card recording | PASS |
| Negotiated price | PASS |
| Inventory deduction | PASS |
| Insufficient stock rejection | PASS |
| Atomic rollback | PASS |
| Duplicate sale protection | PASS |
| Unique receipts | PASS |
| Customerless sale | PASS |
| Customer sale | PASS |
| Receipt generation | PASS |
| Receipt reprint | PASS |
| Printer failure isolation | PASS |
| Offline app launch | PASS |
| Offline sale | PASS |
| Offline app restart | PASS |
| Offline Windows restart | PASS |
| Google offline queue | PASS |
| Google retry | PASS |
| Google duplicate protection | PASS |
| Google failure isolation | PASS |
| Google job created while integration disabled | PASS |
| Daily reporting | PASS |
| Clear unfinished checkout | PASS |
| Completed-sale void and original history | PASS |
| Void inventory reversal and report correction | PASS |
| Card/Clover void warning | PASS |
| Google void propagation without duplicate logical sale | PASS |
| Manual and recurring automatic backup | PASS |
| Backup health and retention | PASS |
| Restore | PASS |
| Verified pre-migration backup | PASS |
| Update deferral during checkout | PASS |
| Update and migration recovery | PASS |
| Single-instance launch | PASS |
| Sleep/resume and abrupt-termination recovery | PASS |
| Low-disk and clock-anomaly handling | PASS |
| Diagnostics, log rotation, and redaction | PASS |
| Support bundle privacy | PASS |
| Durable audit trail | PASS |
| Owner CSV exports | PASS |
| Clean Windows install | PASS |
| Clean Windows update | PASS |
| Actual scanner test | PASS |
| Actual printer test | PASS |

Any failed MUST requirement blocks V1 production release.

---

# 38. Test Evidence

Important tests should produce evidence.

Examples:

- Automated test result
- Database query/result
- Screenshot where useful
- Log excerpt
- Physical test note
- Expected vs actual result

Critical acceptance tests should record:

```text
Test ID
Date
Application version
Database schema version
Device/environment
Expected result
Actual result
PASS/FAIL
Notes
```

---

# 39. Bug Severity

Suggested severity levels:

## P0 — Transaction Integrity

Examples:

- Duplicate sale
- Lost completed sale
- Incorrect inventory
- Partial transaction
- Database corruption

Release blocker.

---

## P1 — Critical Operational Failure

Examples:

- Cannot sell offline
- Cannot launch
- Cannot print/reprint at all
- Card/cash workflow unusable
- Google failure blocks sales

Release blocker.

---

## P2 — Significant Functional Issue

Examples:

- Search problem
- Incorrect report filtering
- Export retry UI broken but automatic retry works

Normally fix before V1.

---

## P3 — Minor

Examples:

- Cosmetic issue
- Non-critical wording
- Small alignment problem

Does not necessarily block release.

---

# 40. Regression Policy

Whenever a bug is fixed:

1. Add or update a test that reproduces the bug.
2. Confirm the test fails before the fix where practical.
3. Apply the fix.
4. Confirm the new test passes.
5. Run relevant regression suite.

Critical bugs must never rely only on manual memory.

---

# 41. Requirement Traceability

Tests should reference requirements where practical.

Example:

```text
TEST-OFF-006
Validates:
REQ-OFF-001
REQ-SALE-008
REQ-DB-003
REQ-REL-001
```

This allows us to answer:

> Which tests prove REQ-OFF-001?

instead of guessing later.

---

# 42. Test Automation Priorities

Automate aggressively where behavior is deterministic.

High-value automated targets:

- Money
- Tax
- Discounts
- Product validation
- Database transactions
- Checkout idempotency
- Inventory movements
- Receipt numbering
- Export queue persistence
- Void atomicity and reporting
- Backup scheduling and retention
- Update and migration state transitions
- Diagnostic redaction and support-bundle manifests
- Owner CSV serialization
- Reporting
- Database migrations

Physical hardware behavior remains partially manual.

---

# 43. Tests That Must Not Be Replaced by Mocks

Mocks are useful but insufficient for:

- SQLite persistence
- SQLite transaction rollback
- App restart persistence
- Windows restart persistence
- Actual barcode scanner
- Actual printer
- Real network disconnect
- Real packaged Windows installer
- Google Sheets integration acceptance

At least one real end-to-end path must verify each of these.

---

# 44. Test Data

Use deterministic test fixtures.

Example products:

```text
TEST-PHONE-001
iPhone 15 128GB
NEW
$599.00
Qty 5
```

```text
TEST-PHONE-002
Samsung Galaxy S24
USED
$450.00
Qty 3
```

Customer:

```text
Test Customer
555-0100
```

Avoid depending on real customer data during development testing.

---

# 45. Fresh Install Test Dataset

A fresh test install should begin with:

- Empty product catalog
- Empty customers
- Empty sales
- Empty export queue
- Valid default settings

Then populate known test data manually or via dedicated development fixtures.

Production application must not ship with test transactions.

---

# 46. Release Candidate Procedure

Before marking a build as V1 release candidate:

1. Build from clean repository state.
2. Run lint.
3. Run TypeScript checks.
4. Run unit tests.
5. Run database integration tests.
6. Run service integration tests.
7. Run packaged application tests.
8. Run offline acceptance tests.
9. Run Google Sheets tests.
10. Run printer tests.
11. Run barcode scanner tests.
12. Run manual/automatic backup and restore tests.
13. Run void, audit, diagnostics, and owner CSV export tests.
14. Run update, migration, and maintenance-safety tests.
15. Install and update on a clean Windows environment.
16. Complete representative Cash sale.
17. Complete representative Card sale.
18. Restart application.
19. Restart Windows.
20. Verify transaction persistence and recovery health.
21. Review logs and a support bundle for unexpected errors or sensitive data.
22. Record test evidence.

---

# 47. Client Pilot Test

Before broad production use, V1 should be installed in the actual store environment for a controlled pilot.

Pilot should verify:

- Normal product entry
- Actual scanner usage
- Actual printer
- Actual Clover operational flow
- Negotiated prices
- Customer entry
- Daily report
- Offline operation
- Google Sheet visibility

Any P0/P1 issue found during pilot blocks full production adoption.

---

# 48. Production Smoke Test

After final installation:

1. Launch application.
2. Login.
3. Search product.
4. Scan product.
5. Confirm printer.
6. Check Google configuration.
7. Complete controlled test sale or approved store transaction.
8. Confirm inventory.
9. Confirm receipt.
10. Confirm Google export.
11. Confirm reporting.

---

# 49. Test Plan Definition of Done

The test plan is considered satisfied for V1 only when:

- Every MUST requirement has at least one verification path.
- All production-blocking tests pass.
- Offline behavior has been physically verified.
- Sale atomicity has been tested.
- Duplicate-sale protection has been tested.
- SQLite persistence has been tested.
- Windows restart persistence has been tested.
- Printing failure isolation has been tested.
- Google failure isolation has been tested.
- Google duplicate protection has been tested.
- Clear-cart and void behavior have been tested, including reversal, reporting, and Google propagation.
- Every sale has one durable export job even while integration is disabled.
- Recurring automatic backup, retention, health, and verified pre-migration backup have been tested.
- Backup restoration has been demonstrated.
- Update deferral, data preservation, migration success/failure, and clean Windows update have been tested.
- Diagnostics, correlation, rotation, redaction, crash evidence, and support-bundle privacy have been tested.
- Single-instance, sleep/resume, low-disk, clock-change, and maintenance-safety behavior have been tested.
- Required durable audit events have been tested independently of diagnostic logs.
- All four owner CSV exports and failure isolation have been tested.
- Installer has been tested on a clean Windows environment.
- Client hardware has been tested.

---

# 50. Core Verification Rule

The most important V1 test is not:

> Does the interface look finished?

It is:

> Can Go Phones continue completing correct, durable, non-duplicated sales when the internet, printer, Google Sheets, or application itself behaves imperfectly?

If the answer is consistently yes, the core POS architecture is working as intended.

---

# 51. Clear Cart and Void Tests

These tests validate `REQ-VOID-*` and the related inventory, reporting, audit, and Google Sheets requirements.

## TEST-CART-001 — Clear Unfinished Checkout

Build a cart, attach a customer, select payment, then confirm `Clear Cart` before submission.

Expected:

- Temporary checkout state is cleared.
- Inventory remains unchanged.
- No sale, payment, receipt number, inventory movement, audit completion event, or Google export job is created.

This validates `REQ-SALE-011` and remains distinct from a completed-sale void.

---

## TEST-VOID-001 — Successful Void

Void a completed sale with a valid reason.

Expected:

- Sale state becomes `VOIDED`.
- Void timestamp and reason persist.
- A durable `SALE_VOIDED` audit event exists.
- The original sale remains visible in Sales History.

---

## TEST-VOID-002 — Original Transaction Retained

Capture the sale, item, payment, receipt, customer, business, and policy snapshots before voiding.

Expected:

Voiding does not delete or rewrite those original historical values.

---

## TEST-VOID-003 — Inventory Restoration and Reversing Movement

Sell two units, then void the sale.

Expected:

- Inventory returns by exactly two units.
- Explicit reversing inventory movement records exist and link to the original sale/void action.
- The original sale movements remain unchanged.

---

## TEST-VOID-004 — Report Correction and Visibility

Run reports before and after a void.

Expected:

- Voided revenue, discounts, tax, and Cash/Card totals are excluded appropriately.
- Transaction history and void status remain visible.

---

## TEST-VOID-005 — Reason Required and Persistent

Attempt a blank reason, then use a valid reason and restart the application.

Expected:

- Blank reason is rejected.
- Valid reason survives restart unchanged.

---

## TEST-VOID-006 — Double-Void Rejection

Void a sale, then submit a second void request.

Expected:

- Second request is rejected.
- Inventory is restored only once.
- No second reversing movement, audit event, or export job is created.
- Original void timestamp and reason remain unchanged.

---

## TEST-VOID-007 — Google Sheets Void Propagation

Test an already-exported sale, a pending sale, and a sale whose `PENDING` job is not being processed because integration is disabled; then void each.

Expected:

- The same immutable Sale ID is upserted with `VOIDED` state.
- Google Sheets contains no second logical sale.
- At most one durable export job exists for each sale.
- Offline or failed propagation remains retryable without blocking the local void.
- Disabled integration makes no network request but retains the advanced job as `PENDING` until enabled.

---

## TEST-VOID-008 — Card / Clover Warning

Start voiding a Card sale.

Expected:

- UI clearly states that the POS void does not refund or reverse Clover.
- Explicit acknowledgement is required.
- No Clover API call is attempted.
- Local void succeeds only after confirmation; any Clover action remains separate.

---

## TEST-VOID-009 — Cash Void

Void a Cash sale.

Expected:

Local state, inventory, reporting, export, and audit effects match the standard void workflow without suggesting an automated external refund.

---

## TEST-VOID-010 — Void Atomic Rollback

Force failure after the sale state update but before reversing movements, audit insertion, or export rescheduling completes.

Expected:

The entire void transaction rolls back: the sale remains completed, inventory and reports remain unchanged, and no partial audit/export state exists.

---

# 52. Application Update Tests

These tests validate `REQ-UPDATE-*`, `REQ-APP-*`, migration safety, and the V1 release strategy.

## TEST-UPDATE-001 — Offline Update Behavior

Launch and complete a sale with no internet.

Expected:

The installed version remains fully usable; update checks do not block startup, login, checkout, reporting, or printing.

---

## TEST-UPDATE-002 — Update Endpoint Failure Isolation

Make the configured HTTPS update endpoint unavailable or return an invalid response.

Expected:

A non-blocking update status and sanitized diagnostic event appear. Local sales remain available.

---

## TEST-UPDATE-003 — Background Download

Download an approved update while using the POS.

Expected:

The UI and checkout remain responsive, and installation does not begin automatically.

---

## TEST-UPDATE-004 — Active Checkout Prevents Restart

With a cart active and a checkout request in flight, select `Restart & Update`.

Expected:

Restart is deferred; the cart and transaction are not interrupted or lost.

---

## TEST-UPDATE-005 — Deferred Installation

Select `Later` when an update is ready, complete additional sales, then install from an idle state.

Expected:

Sales continue normally and the verified update remains available for later installation.

---

## TEST-UPDATE-006 — Business-Data Preservation

Populate products, customers, sales, voids, audit history, settings, and receipt snapshots, then update.

Expected:

Replaceable binaries change while business data in the application-data location remains intact.

---

## TEST-UPDATE-007 — Migration Success

Install an update requiring a migration after a verified pre-migration backup.

Expected:

- Migrations run once in version order.
- Schema health passes before checkout reopens.
- Historical data and audit events remain valid.

---

## TEST-UPDATE-008 — Migration Failure

Force a migration failure.

Expected:

- Normal checkout does not open against unsafe schema state.
- Pre-migration backup is preserved.
- Failure is reported with recovery guidance and a stable error code.
- Destructive migration retry is not automatic.

---

## TEST-UPDATE-009 — Pending Work Survives Update

Before update, create pending/failed Google export jobs and note the next receipt sequence. Update and restart.

Expected:

Jobs remain retryable without duplication, and subsequent receipts do not reuse a number.

---

## TEST-UPDATE-010 — Clean Windows Update Path

On a representative clean Windows installation, update through the configured generic HTTPS feed.

Expected:

The verified code-signed update installs without GitHub access, client API keys, shell commands, development tools, or manual build download.

---

## TEST-UPDATE-011 — Update Audit Event

Complete an update installation, with and without a schema migration.

Expected:

Durable update-installation and applicable migration audit events identify versions and outcomes without secrets.

---

## TEST-UPDATE-012 — Release Integrity and Provenance

Inspect a release offered through the production update path.

Expected:

- Version follows semantic versioning.
- Windows artifact is code signed and passes release-blocking verification.
- Artifact metadata traces to the tested source revision and build.
- Untrusted or unverifiable artifacts are rejected without blocking the installed POS.

---

## TEST-UPDATE-013 — Bad-Release Recovery

Exercise the documented recovery procedure for a defective binary and a failed schema-changing release.

Expected:

- Recovery uses verified artifacts and preserves authoritative business data.
- Application-file replacement does not replace the database.
- Migration evidence and backup remain available.
- Newer committed business records are not silently discarded.

---

# 53. Support and Diagnostics Tests

These tests validate `REQ-DIAG-*`, `REQ-HEALTH-*`, and privacy requirements.

## TEST-DIAG-001 — Structured Logging

Trigger representative checkout, printer, Google, backup, update, and database events.

Expected:

Technical logs use consistent structured fields, timestamps, severity, stable event/error codes, and correlation IDs where applicable.

---

## TEST-DIAG-002 — Log Rotation

Exceed configured log size/age limits.

Expected:

Logs rotate and clean up according to policy without deleting durable audit events or business records.

---

## TEST-DIAG-003 — Sensitive-Data Redaction

Exercise authentication, Google authorization, Card/Clover, customer, update, and support error paths using sentinel secrets and PII.

Expected:

No plaintext password, token, API secret, authorization header, card number, CVV, Clover credential, or unnecessary customer PII appears in logs or UI history.

---

## TEST-DIAG-004 — Support Bundle Generation

Generate a bundle while online and offline.

Expected:

Bundle contains relevant rotated logs, crash evidence, versions, installation identifier, health states, and sanitized configuration metadata at the selected destination.

---

## TEST-DIAG-005 — Support-Bundle Privacy

Scan the generated bundle using known sentinel secrets and customer/payment data.

Expected:

Secrets and unnecessary PII are absent; only documented diagnostic content is included.

---

## TEST-DIAG-006 — Correlation Across Sale Failure

Force one checkout transaction to fail and another to succeed.

Expected:

Each flow has a distinct correlation ID consistently represented across renderer boundary, transaction, error, and support history without exposing payment/customer details.

---

## TEST-DIAG-007 — Health States

Exercise healthy and unhealthy database/schema, internet, printer, Google queue, backup, and disk-space states.

Expected:

Support & Diagnostics reports application/build version, schema, installation ID, accurate health states, and pending/failed export counts. Only unsafe local database states block checkout.

---

## TEST-DIAG-008 — Crash Evidence

Cause a controlled application crash, restart, and generate a support bundle.

Expected:

Sanitized crash evidence survives restart and appears in friendly history and the bundle without corrupting local state.

---

## TEST-DIAG-009 — Report a Problem Offline

Open `Report a Problem` offline and enter a description.

Expected:

Recent friendly activity, stable error code, and relevant correlation ID can be reviewed and a local support bundle can be generated without internet.

---

# 54. Health, Reliability, and Maintenance Tests

These tests validate `REQ-HEALTH-*`, `REQ-APP-*`, and related reliability requirements.

## TEST-REL-001 — Single Instance

Launch Go Phones POS twice.

Expected:

The second launch focuses/restores the existing window. Only one database lifecycle, migration runner, backup scheduler, and export worker are active.

---

## TEST-REL-002 — Windows Sleep / Resume

Sleep during idle, cart entry, and controlled transaction/export activity, then resume.

Expected:

Database, connectivity, worker schedules, backup health, disk, and printer state are rechecked. No success is shown without confirmed commit and no duplicate sale/export occurs.

---

## TEST-REL-003 — Abrupt Termination / Power Loss

Terminate the application at controlled points before, during, and immediately after commit, then restart.

Expected:

SQLite contains either the full authoritative transaction or none of it. Committed work remains durable and idempotent retry does not duplicate it.

---

## TEST-REL-004 — Windows Restart Recovery

Restart Windows with completed sales, a void, and pending export work.

Expected:

All committed state persists, pending work remains retryable, and checkout reopens after local health checks.

---

## TEST-REL-005 — Offline Recovery

Crash or restart while offline, then reopen without reconnecting.

Expected:

Healthy local checkout, history, reports, receipt reprint, and queued exports remain available.

---

## TEST-REL-006 — Low-Disk Warning

Cross the configured warning threshold while database writes remain safe.

Expected:

A clear warning and sanitized diagnostic event appear; local sales are not blocked solely by the warning threshold.

---

## TEST-REL-007 — Disk Exhaustion Safety

Force a controlled local write failure caused by insufficient disk space.

Expected:

The transaction rolls back, checkout reports a critical local failure, no success is shown, and existing committed data remains intact.

---

## TEST-REL-008 — Suspicious Clock Change

Move the system clock significantly forward and backward between operations.

Expected:

The anomaly is warned/logged, local sales continue when otherwise safe, and durable IDs prevent duplicate sales, receipts, audits, or exports.

---

## TEST-REL-009 — Exclusive Maintenance During Checkout

Attempt Restart & Update, migration, and restore during active and in-flight checkout.

Expected:

Each action is rejected or deferred until a safe idle boundary; no cart or transaction is silently abandoned.

---

## TEST-REL-010 — Maintenance Lock

Begin an allowed maintenance action and attempt a second maintenance action and new checkout.

Expected:

Only one maintenance action runs, new checkout is unavailable until safe completion, and status clearly reports success or recovery state.

---

# 55. Owner CSV Export Tests

These tests validate `REQ-EXPORT-*`.

## TEST-EXPORT-001 — Products and Inventory CSV

Export products/current inventory.

Expected:

Documented headers, stable product identifiers, active/archive state, and current quantities match a consistent SQLite view.

---

## TEST-EXPORT-002 — Customers CSV

Export customers including values containing commas, quotes, and line breaks.

Expected:

Rows use correct CSV escaping and match authoritative customer data.

---

## TEST-EXPORT-003 — Sales CSV

Export completed and voided sales.

Expected:

Immutable Sale ID, receipt number, totals, payment method, state, and void metadata where applicable are represented consistently without turning a void into a second sale.

---

## TEST-EXPORT-004 — Inventory Movements CSV

Export initial stock, sale, manual adjustment, and void-reversal movements.

Expected:

Movement identifiers, products, quantities, types, timestamps, and sale links match SQLite.

---

## TEST-EXPORT-005 — Export Failure Isolation

Make the destination unwritable or interrupt file creation.

Expected:

Failure is clearly reported and no authoritative product, customer, sale, inventory, movement, or audit record changes. No partial file is presented as a successful export.

---

## TEST-EXPORT-006 — Export-Only Surface

Inspect the owner CSV UI and trusted application interfaces.

Expected:

No CSV import, legacy migration, or bidirectional file-synchronization operation is exposed in V1.

---

# 56. Durable Audit Tests

These tests validate `REQ-AUDIT-*`.

## TEST-AUDIT-001 — Required Business and System Actions

Complete and void a sale, override a price, adjust inventory, change tax/business/Google settings, run successful and failed backups, execute a migration, and install an update.

Expected:

Each required action produces an appropriately typed durable local audit event with outcome and safe context.

---

## TEST-AUDIT-002 — Audit Durability and Separation

Create audit events, rotate/delete eligible diagnostic logs, and restart Windows.

Expected:

Audit events persist independently of diagnostic logs and remain queryable in chronological/business context.

---

## TEST-AUDIT-003 — Audit Privacy

Exercise audited actions with sentinel secrets and customer/payment data.

Expected:

Audit records contain no secret and no unnecessary customer/payment detail.

---

## TEST-AUDIT-004 — Transactional Audit Consistency and Immutability

Force audit insertion failure during a transactional price override, inventory adjustment, setting change, and void; then attempt to edit or delete an existing audit event.

Expected:

- The corresponding business change rolls back when its required audit event cannot commit.
- Historical audit events cannot be silently rewritten or deleted.

---

# 57. New V1 Traceability Matrix

| Requirement | Primary verification |
|---|---|
| `REQ-VOID-001` | `TEST-VOID-001`, `TEST-VOID-002` |
| `REQ-VOID-002` | `TEST-VOID-001`, `TEST-VOID-005` |
| `REQ-VOID-003` | `TEST-VOID-003`, `TEST-VOID-010` |
| `REQ-VOID-004` | `TEST-VOID-006` |
| `REQ-VOID-005` | `TEST-VOID-004` |
| `REQ-VOID-006` | `TEST-VOID-001`, `TEST-VOID-010` |
| `REQ-VOID-007` | `TEST-VOID-007` |
| `REQ-VOID-008` | `TEST-VOID-008`, `TEST-VOID-009` |
| `REQ-AUDIT-001` | `TEST-AUDIT-002` |
| `REQ-AUDIT-002` | `TEST-AUDIT-001` |
| `REQ-AUDIT-003` | `TEST-AUDIT-003` |
| `REQ-AUDIT-004` | `TEST-AUDIT-004`, `TEST-VOID-010` |
| `REQ-EXPORT-001` | `TEST-EXPORT-001` through `TEST-EXPORT-004` |
| `REQ-EXPORT-002` | `TEST-EXPORT-006` |
| `REQ-EXPORT-003` | `TEST-EXPORT-005` |
| `REQ-UPDATE-001` | `TEST-UPDATE-010` |
| `REQ-UPDATE-002` | `TEST-UPDATE-012` |
| `REQ-UPDATE-003` | `TEST-UPDATE-003` |
| `REQ-UPDATE-004` | `TEST-UPDATE-004`, `TEST-UPDATE-005` |
| `REQ-UPDATE-005` | `TEST-UPDATE-004`, `TEST-REL-009` |
| `REQ-UPDATE-006` | `TEST-UPDATE-001`, `TEST-UPDATE-002` |
| `REQ-UPDATE-007` | `TEST-UPDATE-006`, `TEST-UPDATE-009` |
| `REQ-UPDATE-008` | `TEST-BACKUP-012`, `TEST-BACKUP-013`, `TEST-UPDATE-007`, `TEST-UPDATE-008` |
| `REQ-UPDATE-009` | `TEST-UPDATE-013` |
| `REQ-UPDATE-010` | `TEST-UPDATE-010` |
| `REQ-DIAG-001` | `TEST-DIAG-007` |
| `REQ-DIAG-002` | `TEST-DIAG-009` |
| `REQ-DIAG-003` | `TEST-DIAG-001`, `TEST-DIAG-002`, `TEST-DIAG-006` |
| `REQ-DIAG-004` | `TEST-DIAG-004`, `TEST-DIAG-008` |
| `REQ-DIAG-005` | `TEST-DIAG-003`, `TEST-DIAG-005` |
| `REQ-DIAG-006` | `TEST-DIAG-007`, `TEST-UPDATE-002`, `TEST-REL-007` |
| `REQ-BACKUP-001` | `TEST-BACKUP-001` through `TEST-BACKUP-003` |
| `REQ-BACKUP-002` | `TEST-BACKUP-002`, `TEST-BACKUP-003` |
| `REQ-BACKUP-003` | `TEST-BACKUP-016` |
| `REQ-BACKUP-004` | `TEST-BACKUP-003` through `TEST-BACKUP-006` |
| `REQ-BACKUP-005` | `TEST-BACKUP-008`, `TEST-BACKUP-009` |
| `REQ-BACKUP-006` | `TEST-BACKUP-010` |
| `REQ-BACKUP-007` | `TEST-BACKUP-009`, `TEST-BACKUP-011` |
| `REQ-BACKUP-008` | `TEST-BACKUP-012`, `TEST-BACKUP-013` |
| `REQ-BACKUP-009` | `TEST-BACKUP-015` |
| `REQ-HEALTH-001` | `TEST-DIAG-007`, `TEST-BACKUP-011`, `TEST-REL-006`, `TEST-REL-007` |
| `REQ-HEALTH-002` | `TEST-REL-008` |
| `REQ-HEALTH-003` | `TEST-REL-002` |
| `REQ-HEALTH-004` | `TEST-CRASH-001` through `TEST-CRASH-005`, `TEST-REL-003`, `TEST-REL-004` |
| `REQ-HEALTH-005` | `TEST-OFF-001` through `TEST-OFF-013`, `TEST-NET-003`, `TEST-REL-005` |
| `REQ-APP-001` | `TEST-REL-001` |
| `REQ-APP-002` | `TEST-BACKUP-014`, `TEST-UPDATE-004`, `TEST-REL-009`, `TEST-REL-010` |

Unrelated existing test IDs remain unchanged.

---

# 58. Final Verification Rule

V1 verification succeeds only when sales and voids remain correct, durable, non-duplicated, recoverable, and supportable through offline use, external failures, updates, maintenance, restarts, and imperfect hardware without exposing sensitive data.
