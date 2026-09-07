# Go Phones POS — POS Workflows

## 1. Purpose

This document defines the primary V1 operational workflows for Go Phones POS.

The goal is to remove ambiguity before implementation by describing exactly how the application should behave during:

- Product setup
- Inventory setup
- Barcode scanning
- Customer lookup
- Checkout
- Price negotiation
- Cash payments
- Card payments through Clover
- Sale completion
- Receipt printing
- Offline operation
- Google Sheets export
- Voiding an accidentally completed sale
- Inventory adjustments
- Sales history
- Daily reporting
- Application restart and recovery
- Backup, update, and maintenance safety
- Support, diagnostics, and owner CSV export

These workflows must remain consistent with:

- `PRODUCT_SCOPE.md`
- `PRODUCT_REQUIREMENTS.md`
- `ARCHITECTURE.md`
- `DATA_MODEL.md`

---

# 2. Workflow Design Principle

The primary operational rule is:

> A sale is complete only after the local SQLite transaction commits successfully.

The authoritative local transaction is:

`Checkout → Validate → Allocate receipt number → Write sale, items, payment, inventory changes, movements, required audit events, checkout completion, and durable Google export job → Commit Locally → Sale Complete`

Secondary operations happen afterward:

`Sale Complete → Print Receipt`

`Sale Complete → Attempt Google Sheets API Export`

External failures must not invalidate an already committed sale.

---

# 3. Actor Definitions

## Cashier

V1 uses one shared store login.

The cashier may:

- Add products
- Search inventory
- Scan barcodes
- Create customers
- Create sales
- Override prices
- Record Cash payments
- Record Card payments
- Print receipts
- Reprint receipts
- View sales history
- View daily totals
- Clear an unfinished checkout
- Void an accidentally completed sale

---

## Store Owner / Manager

V1 does not require a separate account or permission level.

Operationally, the shared user may also:

- Change application settings
- Adjust inventory
- Configure tax
- Configure printer
- Configure Google Sheets export
- Create backups
- Export owner-controlled CSV files
- View health and diagnostics
- Install a ready application update

Future role separation is outside V1.

---

# 4. Application Startup Workflow

## Trigger

User launches Go Phones POS.

Example:

`GoPhonesPOS.exe`

## Expected Flow

1. Electron application starts.
2. Application acquires the single-instance lock before opening SQLite or starting background workers.
3. If another instance owns the lock, the launch request focuses/restores that existing window and this process exits.
4. The primary instance locates the local application-data directory.
5. SQLite is opened in startup/maintenance state and foreign-key enforcement is enabled.
6. Database and schema health are inspected before checkout becomes available.
7. If an existing initialized database has a pending migration, the application enters exclusive maintenance, creates and verifies a SQLite-consistent pre-migration backup (recording its evidence), and applies ordered versioned migrations only after verification succeeds. First-run creation of a brand-new empty database via `001_initial_schema` is bootstrap initialization and runs without a pre-migration backup, since there is no prior database state to preserve.
8. A backup, migration, or post-migration health failure stops safely before checkout, preserves recovery evidence, and shows recovery guidance.
9. Application services initialize after database/schema health is established.
10. Google Sheets export worker initializes and processes `PENDING` jobs only when integration is enabled and configured.
11. Main application window opens.
12. Shared login screen is displayed.
13. User authenticates locally.
14. POS home screen opens.

## Internet Requirement

None.

The application must successfully start while completely offline.

---

# 5. Startup With No Internet

## Scenario

The store computer has no internet access.

## Expected Behavior

The application must still:

- Start
- Open the local database
- Authenticate the shared user
- Load products
- Load customers
- Load sales history
- Allow checkout
- Allow printing
- Generate reports

Google Sheets synchronization should indicate:

`Offline / Pending`

or similar.

The application must not display a blocking error such as:

`Cannot connect to server`

unless a local system dependency is actually unavailable.

---

# 6. Critical Startup Failure

## Scenario

SQLite cannot be opened safely.

Examples:

- Database file inaccessible
- Severe database corruption
- Permissions prevent access

## Expected Behavior

The application must not enter normal checkout mode.

The UI should clearly indicate that local business data cannot be safely accessed.

Example:

`Go Phones POS cannot open the local database. Sales cannot be completed safely.`

The application must not pretend to be operational.

---

# 7. Shared Login Workflow

## Trigger

Application reaches login screen.

## Flow

1. User enters shared store password.
2. Application verifies the password locally.
3. Password verification does not require internet.
4. On success, application opens the POS.
5. On failure, user remains on login screen.

## Security Rule

Raw password must not be stored in plaintext; it is hashed with a salted, memory-hard algorithm (`ARCHITECTURE.md` Section 28).

---

# 7A. First-Run Credential Setup Workflow

## Trigger

Application reaches login and no shared credential has ever been created.

## Flow

1. Application shows a setup screen instead of a login prompt.
2. User enters and confirms a new shared password.
3. Password is hashed and stored; the POS home screen becomes reachable.
4. An `AUTH_CREDENTIAL_CHANGED` audit event is recorded.

No internet is required.

---

# 7B. Password Change Workflow

## Trigger

User selects `Settings → Change Password`.

## Flow

1. User enters the current password and a new password (with confirmation).
2. Application verifies the current password locally.
3. On success, the stored hash is replaced and an `AUTH_CREDENTIAL_CHANGED` audit event is recorded.
4. On failure, the existing password remains unchanged.

No internet is required.

---

# 7C. Forgotten Password Recovery Workflow

## Scenario

The shared password is forgotten and no one can log in.

## Expected Behavior

V1 has no online password reset (no email/SMS/cloud identity). Recovery follows a documented local procedure requiring direct physical/administrative access to the installed application (for example, a support-assisted local reset step) that clears the stored credential without touching business data, after which the application re-enters the first-run setup workflow (Section 7A) to establish a new shared password.

---

# 7D. Brute-Force Backoff Workflow

## Scenario

Repeated consecutive failed login attempts occur.

## Expected Behavior

After a small number of consecutive failures, the application imposes an increasing delay before the next attempt is accepted. The shared login is never permanently locked, since there is no alternate account or online reset path; a correct password is always eventually accepted once the current delay elapses.

---

# 8. Create Product Workflow

## Trigger

User selects:

`Products → Add Product`

## Required Inputs

- Product name
- Brand
- Model
- Condition
- Selling price
- Quantity

## Optional Inputs

- SKU
- Barcode
- Cost price
- Low-stock threshold

## Flow

1. User enters product information.
2. Renderer validates obvious input issues.
3. Product request is sent to the main/application layer.
4. Application validates all fields again.
5. Product ID is generated.
6. Product is inserted into SQLite.
7. If starting quantity is greater than zero, an `INITIAL_STOCK` inventory movement is created.
8. Transaction commits.
9. Product becomes immediately searchable.

## Example

```text
Name: iPhone 15 128GB
Brand: Apple
Model: iPhone 15
Condition: NEW
Price: $599
Quantity: 5
Barcode: 123456789
```

Expected result:

```text
Product created
Stock = 5
INITIAL_STOCK movement = +5
```

---

# 9. Duplicate Barcode Workflow

## Scenario

User tries to create a product with a barcode already assigned to another product.

## Expected Behavior

Product creation must be rejected.

Example message:

`This barcode is already assigned to another product.`

Existing data must remain unchanged.

---

# 10. Edit Product Workflow

## Trigger

User opens an existing product and selects Edit.

## Editable Fields

- Name
- Brand
- Model
- Condition
- Selling price
- Cost price
- SKU
- Barcode
- Low-stock threshold

Quantity must not be changed through a generic product edit form unless the action creates an inventory movement.

## Flow

1. User modifies product information.
2. Application validates data.
3. Product is updated.
4. `updated_at` changes.
5. Historical sale data remains unchanged.

---

# 11. Archive Product Workflow

## Trigger

User selects:

`Archive Product`

## Flow

1. Application asks for confirmation.
2. Product `is_active` becomes false.
3. Product remains in SQLite.
4. Product remains referenced by historical sales.
5. Product is removed from normal checkout selection.

Hard deletion is not the default behavior.

---

# 12. Manual Inventory Adjustment Workflow

## Trigger

User selects:

`Adjust Stock`

## Inputs

- Product
- Adjustment amount or new quantity
- Reason

## Example

Current stock:

`5`

Physical recount:

`7`

Adjustment:

`+2`

Reason:

`Physical stock recount`

## Flow

1. User enters adjustment.
2. Application validates result.
3. New quantity must not become negative.
4. Inventory update and movement record occur in the same SQLite transaction.
5. `MANUAL_ADJUSTMENT` movement is created.
6. A durable inventory-adjustment audit event is inserted.
7. Transaction commits.
8. Product displays new quantity.

The application must never silently modify inventory quantity without creating a movement record.

---

# 13. Product Search Workflow

## Trigger

Cashier enters text in product search.

## Search Inputs

May include:

- Product name
- Brand
- Model
- SKU
- Barcode

## Flow

1. Renderer sends search request.
2. Application queries local SQLite.
3. Matching active products return.
4. Results display current price and stock.

## Internet Requirement

None.

---

# 14. Barcode Scan Workflow

## Trigger

Cashier scans a barcode.

## Flow

1. Barcode scanner sends keyboard characters.
2. Scanner terminates input, commonly with Enter.
3. POS captures barcode.
4. Application searches local product database.
5. If product exists and is active:
   - Product is added to cart or selected.
6. If already present in cart:
   - Quantity increments by 1, subject to stock availability.
7. Cart totals recalculate.

## Expected Response

Product lookup should feel immediate.

---

# 15. Unknown Barcode Workflow

## Scenario

Scanner reads a barcode that does not exist.

## Expected Behavior

The app displays a non-blocking message:

`No product found for this barcode.`

The cashier may:

- Search manually
- Scan another item
- Leave checkout

The current cart must remain intact.

---

# 16. Start New Sale Workflow

## Trigger

Cashier selects:

`New Sale`

## Initial State

```text
Cart = empty
Customer = none
Payment = none
```

No SQLite sale record is created yet.

The cart is temporary until checkout completion.

---

# 17. Add Product to Cart Workflow

## Flow

1. Cashier searches or scans a product.
2. Product is added to cart.
3. Default unit price equals current product selling price.
4. Quantity defaults to 1.
5. Current available inventory is checked.
6. Cart totals recalculate.

## Cart Item Should Display

- Product name
- Condition
- Quantity
- Listed price
- Actual selling price
- Discount
- Line total

---

# 18. Add Multiple Products Workflow

A sale may contain multiple products.

Example:

```text
iPhone 15
Qty 1
$550

Samsung S24
Qty 2
$480 each
```

The application must calculate transaction totals across all line items.

If the same product appears in more than one line (for example, added twice with different negotiated prices), stock validation aggregates their quantities by product ID and checks the combined total against available stock, so a cashier cannot bypass the stock check by splitting one product's quantity across lines (`DATA_MODEL.md` Section 41A).

---

# 19. Cart Quantity Change Workflow

## Trigger

Cashier changes quantity.

## Flow

1. New quantity is validated.
2. Quantity must be greater than zero.
3. Quantity must not exceed current available stock.
4. Cart totals update.

## Example

Stock:

`2`

Requested:

`3`

Expected:

`Only 2 are available.`

Sale must not complete with invalid quantity.

---

# 20. Remove Cart Item Workflow

## Trigger

Cashier selects Remove.

## Expected Behavior

Item is removed from temporary cart.

No inventory change occurs.

No inventory movement is created.

---

# 21. Price Negotiation Workflow

## Trigger

Cashier changes a cart item's selling price.

## Example

Listed:

`$599`

Negotiated:

`$550`

## Flow

1. Cashier edits selling price.
2. Application validates price is allowed.
3. Price must be a non-negative integer-cent value within the documented monetary bounds (`DATA_MODEL.md` Section 41A); it may be set below, equal to, or above the listed price.
4. Listed price remains visible.
5. Sold price becomes `$550`.
6. Discount is calculated from the difference and clamped at zero (never negative) if the sold price is above listing.
7. Cart totals update.

The historical sale must preserve both values after completion.

---

# 22. Discount Workflow

V1 primarily derives discounts from price negotiation.

Example:

```text
Listed Price = $599
Sold Price   = $550
Discount     = $49
```

For quantity 2:

```text
Listed Total = $1,198
Sold Total   = $1,100
Discount     = $98
```

The trusted application layer must recalculate these values before sale completion.

---

# 23. Customerless Sale Workflow

Customer data is optional.

## Flow

1. Cashier creates cart.
2. Cashier does not select customer.
3. Checkout proceeds normally.
4. Sale stores `customer_id = NULL`.
5. Receipt omits customer information.

---

# 24. Existing Customer Search Workflow

## Trigger

Cashier selects customer search.

## Search Inputs

- Name
- Phone number

## Flow

1. Search executes against local SQLite.
2. Matching customers display.
3. Cashier selects customer.
4. Customer attaches to current cart.

No internet is required.

---

# 25. Create Customer During Checkout

## Trigger

Customer does not already exist.

## Flow

1. Cashier selects Add Customer.
2. Enters:
   - Name
   - Phone
3. Customer is saved locally.
4. New customer is attached to current checkout.
5. Checkout continues.

Creating the customer must not require internet access.

---

# 26. Checkout Review Workflow

Before payment, checkout should display:

```text
Items
Listed subtotal
Discount
Taxable amount
Tax
Final total
Customer
Payment method
```

Cashier should have a clear opportunity to verify the transaction before completion.

What the cashier reviews here is exactly what the trusted application layer fingerprints and later re-validates at commit (`DATA_MODEL.md` Section 41B). If anything material changes between this review and Complete Sale — a price, the tax rate, product availability, or stock — the commit step rejects the attempt for re-review rather than silently completing with different values (Section 33).

---

# 27. Tax Calculation Workflow

## Flow

1. Application determines authoritative sold item totals.
2. Discounts are calculated.
3. Taxable amount is determined.
4. Configured tax rate is loaded.
5. Tax is calculated using the defined integer-cent rounding policy.
6. Final total is calculated.

Renderer totals are previews.

The trusted application layer recalculates final values during checkout completion.

---

# 28. Cash Payment Workflow

## Trigger

Cashier selects:

`Cash`

## Flow

1. POS displays final total.
2. Cashier receives payment.
3. Cashier confirms payment.
4. Checkout submission begins.
5. Local transaction executes.
6. Receipt number, sale, payment, inventory changes, movements, required audit events, checkout completion, and the durable Google Sheets export job are written together.
7. Sale commits.
8. Receipt becomes available.
9. Background Google Sheets export may begin.
10. Sale success screen displays.

## Example

```text
Total: $595.38
Payment: CASH
```

---

# 29. Optional Cash Tendered Workflow

If implemented:

```text
Total:
$595.38

Cash Received:
$600.00

Change Due:
$4.62
```

This is optional V1 functionality.

Failure to implement amount tendered must not block the required cash-payment workflow.

---

# 30. Card Payment Workflow — Clover V1

Clover remains separate from the POS.

## Trigger

Cashier selects:

`Card`

## Flow

1. POS finalizes the checkout review and displays the final amount.
2. Before the cashier is shown any instruction to use Clover, the trusted application layer generates the checkout request ID and fingerprint and durably commits Phase 1, Step A (`DATA_MODEL.md` Section 31): a `checkout_requests` row with the payment method (`CARD`), the reviewed total, and `status = PENDING_PAYMENT`. If this durable write fails, checkout stops here with a local-failure message and the cashier is **not** sent to Clover — no charge has been risked.
3. Only now does the POS instruct the cashier to process that exact amount on the Clover terminal.
4. Cashier enters/processes that amount on the Clover terminal.
5. Customer pays through Clover.
6. Clover independently approves or declines.
7. Cashier returns to Go Phones POS.
8. POS asks for explicit confirmation.

Example:

```text
Process $595.38 on Clover.

Was payment approved?

[Payment Approved]
[Payment Declined / Cancel]
```

9. Cashier selects `Payment Approved`.
10. The trusted application layer durably commits Phase 1, Step B (`DATA_MODEL.md` Section 31): the same `checkout_requests` row is updated with `clover_approved_confirmed_at` and `status = SUBMITTED`. If this update fails, follow Section 35A, Case 2 — the charge may have occurred but its confirmation could not be durably recorded, so the attempt surfaces in the Reconciliation Queue once stale.
11. Go Phones POS proceeds to Phase 2 (Section 33) and completes the local sale.
12. Payment record is stored as `CARD`.

---

# 31. Clover Declined Workflow

## Scenario

Clover declines the card.

## Expected Behavior

Cashier selects:

`Payment Declined / Cancel`

The POS must:

- Not create the sale
- Not reduce inventory
- Not create payment
- Not create inventory movements
- Keep the cart available

Because Phase 1, Step A (`DATA_MODEL.md` Section 31) already durably recorded this attempt as `PENDING_PAYMENT` before Clover was invoked, a decline/cancel must be recorded on that same row rather than left dangling: the trusted application layer performs a best-effort update to `status = COMMIT_FAILED` with `failure_code = CLOVER_DECLINED`. This is excluded from the Reconciliation Queue (`DATA_MODEL.md` Section 31B) — a decline is an expected outcome, not an incident, since no charge occurred.

Cashier may:

- Try another card (a new checkout request ID/fingerprint and a new Phase 1 Step A record are used for the new attempt)
- Select Cash (same — a new request under Cash's single-step Phase 1)
- Cancel the checkout

---

# 32. Card Payment Offline Consideration

Go Phones POS itself does not authorize card transactions.

If the internet is unavailable:

- POS must still function locally.
- Whether Clover can process the payment is controlled by Clover and merchant configuration.

If Clover successfully processes the payment, the cashier may record the card sale locally.

If Clover cannot process the payment, Go Phones POS must not falsely mark the card transaction as approved.

---

# 33. Complete Sale Workflow

This is the most critical workflow.

## Trigger

- **Cash:** Cashier confirms payment and selects Complete Sale.
- **Card:** Cashier selects `Payment Approved` (Section 30, step 9). Phase 1, Step A has already run earlier in Section 30, step 2, before Clover was ever invoked — this trigger begins with Phase 1, Step B.

## Renderer Behavior

- **Cash:** Generate checkout request ID and fingerprint here; disable Complete Sale; display processing state; send the checkout request to the trusted application layer for Phase 1 Step A + Phase 2.
- **Card:** The checkout request ID and fingerprint were already generated in Section 30, step 2. Selecting `Payment Approved` disables further input, displays processing state, and sends the existing request ID (with the Clover-approval confirmation) to the trusted application layer for Phase 1 Step B + Phase 2.

---

## Trusted Application Flow

Completion is two phases, and for Card, Phase 1 is itself two independently committed steps (`DATA_MODEL.md` Sections 31–31B; `ARCHITECTURE.md` Section 15A). This section covers whichever of these the trigger above requires:

### Phase 1, Step A — Pre-payment durable record (Card: already run in Section 30, step 2; Cash: runs here)

```text
BEGIN IMMEDIATE
```

1. Compute the checkout fingerprint over the reviewed cart, customer, tax rate, and totals (`DATA_MODEL.md` Section 41B).
2. Check checkout request ID; if it already exists with a different fingerprint, reject as a conflict.
3. Insert (or reuse) the `checkout_requests` row with the payment method and intended total, and `status = SUBMITTED` (Cash) or `status = PENDING_PAYMENT` (Card, before Clover is invoked).

```text
COMMIT
```

For Card, this step must complete before the cashier is ever instructed to process Clover (Section 30) — it does not happen here.

### Phase 1, Step B — Payment confirmation record (Card only; runs here, immediately after Payment Approved)

```text
BEGIN IMMEDIATE
```

1. Re-read the existing `checkout_requests` row (`status = PENDING_PAYMENT`).
2. Update it with the Clover-approval confirmation timestamp and `status = SUBMITTED`.

```text
COMMIT
```

If this update fails, follow Section 35A, Case 2, rather than proceeding to Phase 2.

### Phase 2 — Authoritative sale transaction (may fail without losing Phase 1 evidence)

```text
BEGIN IMMEDIATE
```

1. Determine whether the request already reached `COMPLETED`; if so, return the existing sale.
2. Load products from SQLite.
3. Verify products are active.
4. Aggregate duplicate product-ID cart lines and verify sufficient stock against the combined quantity.
5. Recalculate listed totals.
6. Recalculate sold totals.
7. Recalculate discounts (clamped at zero; Section 22).
8. Load the currently configured tax rate.
9. Calculate tax using the fixed rounding rule (`DATA_MODEL.md` Section 42).
10. Calculate final total.
11. Compare every recalculated value against the reviewed fingerprint (step 1 of Phase 1, Step A); if anything drifted — price, tax rate, availability, stock, or totals — reject with a re-review error instead of committing different values.
12. Validate payment information; for Card, the recalculated total must exactly equal the amount already recorded as `intended_total_cents`.
13. Generate Sale ID.
14. Generate receipt number.
15. Snapshot customer information.
16. Snapshot business information.
17. Snapshot receipt policy.
18. Insert sale.
19. Insert sale items.
20. Insert payment.
21. Reduce inventory.
22. Insert inventory movements.
23. Insert required `SALE_COMPLETED` and price-override audit events.
24. Insert the sale's durable Google Sheets export job as `PENDING`; when integration is disabled, configuration gates the worker from processing it.
25. Update the existing checkout-request row to `status = COMPLETED` with the Sale ID.

```text
COMMIT
```

If any required operation in Phase 2 fails:

```text
ROLLBACK
```

followed immediately by a separate best-effort update marking the same checkout-request row `COMMIT_FAILED` with a failure code (Section 35A). Phase 1's record is never lost, even though Phase 2 rolled back completely.

---

# 34. Successful Sale Result

After commit, the application may return:

```text
Sale completed
Receipt: GP-000124
Total: $595.38
```

Then secondary operations may begin.

---

# 35. Failed Local Sale Workflow

## Scenario

SQLite cannot safely complete the transaction.

Examples:

- Database write failure
- Constraint failure
- Unexpected stock mismatch

## Expected Behavior

Transaction rolls back.

The application must display:

`Sale could not be completed.`

It must not:

- Print a final receipt
- Report success
- Create partial inventory changes
- Queue Google export for a nonexistent sale

If the payment method was Card and the cashier had already confirmed Clover approval, follow Section 35A instead of a generic failure message — the cashier must be warned specifically about the possible Clover charge.

---

# 35A. Card Payment Local-Commit-Failure Workflow

## Scenario — Case 1: sale transaction fails after approval is confirmed

The cashier confirms Clover approved the card charge (Phase 1, Step B durably recorded that confirmation), but the authoritative local sale transaction (Section 33, Phase 2) then fails.

## Expected Behavior — Case 1

1. The trusted application layer has already durably recorded, before attempting the sale transaction, the checkout request, payment method (`CARD`), intended total (Phase 1, Step A — before Clover was ever invoked, Section 30), and the timestamp the cashier confirmed Clover approval (Phase 1, Step B). This record does not disappear when the sale transaction rolls back.
2. The application does not report the sale as completed and does not create any sale, payment, inventory, or export record.
3. The application updates the same checkout-request record to `COMMIT_FAILED` with a stable failure code.
4. The UI clearly and immediately warns the cashier, for example:

```text
Local sale could not be saved.

If you already saw "Approved" on Clover, that charge may still exist.
Do NOT run the card again.

Check this transaction in Clover directly. If it was charged and you
cannot complete the local sale, void or refund it in Clover.

This attempt has been recorded for reconciliation as CHK-83ac...
```

5. The application makes a best-effort durable `CARD_LOCAL_COMMIT_FAILURE` audit event; if SQLite cannot accept it, diagnostics preserve the failure evidence instead.
6. The cart remains available so the cashier can retry the same checkout once the underlying issue is resolved (e.g., disk space freed), without being asked to process the card through Clover again. A successful retry links to and closes the reconciliation entry automatically.
7. If the cashier instead completes the sale a different way (e.g., Cash) or abandons it, the reconciliation entry is left for manual resolution (Section 35B).

## Scenario — Case 2: the approval-confirmation write itself fails

The cashier confirms Clover approved the card charge, but the Phase 1, Step B durable write recording that confirmation fails — the `checkout_requests` row remains at `PENDING_PAYMENT` with no record that approval was ever confirmed, and Phase 2 is never reached.

## Expected Behavior — Case 2

1. The application shows the same cashier warning as Case 1 (step 4 above) — from the cashier's perspective, the outcome is identical: a possible Clover charge with no durable local confirmation.
2. Because Step B could not commit, there may be no reliable way to durably transition the row to `COMMIT_FAILED` at that moment either. The row is left at `PENDING_PAYMENT`.
3. A `PENDING_PAYMENT` row that has not advanced within the staleness window (`DATA_MODEL.md` Section 31, Phase 1 Step B) automatically appears in the Reconciliation Queue, exactly as a `COMMIT_FAILED` row would.
4. The cashier may retry once the underlying issue is resolved; a successful retry re-attempts Step B and then Phase 2 against the same row, closing the reconciliation entry automatically on success.

In both cases, Go Phones POS never calls a Clover API as part of this workflow; any reversal or refund is a manual, separate action the cashier performs directly in Clover.

---

# 35B. Reconciliation Queue Workflow

## Trigger

The shared user opens `Support & Diagnostics → Reconciliation Queue` (or an equivalent location).

## Display

Each unresolved entry shows the checkout attempt's timestamp, intended total, and Clover-approval confirmation time.

## Flow

1. The user checks the corresponding transaction directly in Clover.
2. The user takes whatever action Clover requires (nothing further, a void, or a refund) outside of Go Phones POS.
3. The user marks the entry resolved in Go Phones POS with a required note (e.g., `"Verified in Clover, sale re-entered as GP-000131"` or `"Voided in Clover, no local sale created"`).
4. Marking an entry resolved never creates, edits, or backdates a sale — it only records that a person reconciled the discrepancy.

An entry that is closed automatically by a successful retry (Section 35A) shows `"Completed on retry"` and the resulting sale.

---

# 36. Duplicate Complete Sale Workflow

## Scenario

Cashier double-clicks Complete Sale or submits the same checkout request again.

## Flow

First request:

```text
request_id = ABC123
→ Sale GP-000124
```

Second identical request:

```text
request_id = ABC123
```

Expected:

Return the existing completed sale.

Not:

Create another sale.

---

# 37. Sale Success Screen

After successful commit, show clear information.

Example:

```text
SALE COMPLETE

Receipt:
GP-000124

Total:
$595.38

Payment:
Cash

[Print Receipt]
[New Sale]
```

If Google export is pending:

```text
Google Sheets:
Pending
```

This must not make the sale appear unsuccessful.

---

# 38. Receipt Generation Workflow

Receipt data should be constructed from historical sale snapshots.

## Flow

1. Load sale.
2. Load sale items.
3. Load payment.
4. Use sale-time customer snapshots.
5. Use business snapshots.
6. Use disclaimer snapshot.
7. Generate receipt representation.

Receipt generation must not depend on internet connectivity.

---

# 39. Automatic Receipt Printing Workflow

If automatic printing is enabled:

```text
Sale commits
↓
Generate receipt
↓
Send to configured printer
```

Printing occurs after commit.

---

# 40. Print Failure Workflow

## Scenario

Printer is unavailable.

Examples:

- Printer unplugged
- Printer offline
- Driver error

## Expected Behavior

Sale remains completed.

Example message:

```text
Sale completed successfully.

Receipt could not be printed.

[Retry Print]
[Continue]
```

No duplicate transaction should be created when retrying print.

---

# 41. Receipt Reprint Workflow

## Trigger

User opens Sales History and selects Reprint.

## Flow

1. Load historical sale.
2. Generate receipt from stored snapshots.
3. Send receipt to selected printer.
4. Sale data remains unchanged.

Reprinting must never create a new sale.

---

# 42. Offline Sale Workflow

## Scenario

Internet is physically disconnected.

## Flow

1. Launch POS.
2. Login locally.
3. Search product locally.
4. Scan barcode locally.
5. Add customer if desired.
6. Build cart.
7. Override price if necessary.
8. Calculate tax locally.
9. Select payment.
10. Complete sale.
11. SQLite commits.
12. Inventory updates.
13. Receipt prints.
14. Google export job remains pending.

Expected:

Sale works normally.

---

# 43. Offline Google Export State

Example after completing three offline sales:

```text
GP-000124 — Pending
GP-000125 — Pending
GP-000126 — Pending
```

The presence of pending exports must not create a warning that implies the sales themselves failed.

---

# 44. Internet Reconnection Workflow

## Trigger

Internet becomes available again.

## Expected Flow

1. Export worker discovers pending jobs.
2. Export jobs are processed.
3. Google Sheets receives sales.
4. Successful jobs become `EXPORTED`.
5. Failed jobs remain retryable.

Checkout must remain usable while this happens.

---

# 45. Google Sheets Export Workflow

## For Each Pending Sale

1. Load local sale.
2. Load local sale items.
3. Verify export job state.
4. Prepare Sales worksheet record.
5. Prepare Sale Items worksheet records.
6. Send through Google Sheets API.
7. Confirm idempotency.
8. Mark export job `EXPORTED`.
9. Store exported timestamp.

---

# 46. Google Sheets Failure Workflow

## Scenario

Google API request fails.

Possible causes:

- No internet
- OAuth problem
- Rate limit
- Spreadsheet permissions
- Temporary Google outage

## Expected Behavior

Local sale remains unchanged.

Export job records:

- Failure
- Attempt count
- Last attempt
- Sanitized error

The job remains available for future retry.

---

# 47. Google Sheets Unknown Outcome Workflow

## Scenario

Application sends data to Google but loses connection before receiving the response.

The system cannot safely assume the data was not written.

## Expected Behavior

On retry, the exporter must check/use the immutable Sale ID to prevent duplicate rows.

The system must not blindly append duplicate transactions.

---

# 48. Google Sheets Manual Retry Workflow

## Trigger

User views failed export and selects:

`Retry Export`

## Flow

1. Export job returns to retryable state.
2. Worker attempts export.
3. On success:
   - Status becomes Exported.
4. On failure:
   - Error state is updated.

Retrying Google export must never recreate or modify the local sale.

---

# 49. Export Worker Startup Recovery

## Scenario

Application crashed while an export job was marked `EXPORTING`.

## On Next Startup

1. Detect stale exporting job.
2. Recover it safely to retryable state.
3. Run normal idempotent export logic.

The job must not remain permanently stuck.

---

# 50. Sales History Workflow

## Trigger

User opens:

`Sales History`

## Display

Each transaction should show relevant information such as:

- Receipt number
- Date/time
- Customer
- Total
- Payment method
- Google export status

---

# 51. Sales History Detail Workflow

## Trigger

User selects a sale.

## Display

- Receipt number
- Sale ID where appropriate
- Date/time
- Customer
- Products
- Quantity
- Listed price
- Sold price
- Discounts
- Subtotal
- Tax
- Total
- Payment method
- Google export status
- Receipt actions

Actions may include:

- Reprint Receipt
- Retry Google Export when applicable

---

# 52. Historical Product Change Workflow

## Scenario

A product is sold.

Later:

- Name changes
- Price changes
- Product is archived

## Expected Behavior

Old sales continue displaying sale-time snapshot data.

Historical transaction must not change.

---

# 53. Daily Report Workflow

## Trigger

User opens:

`Reports → Daily`

## Default

Current business day.

## Display

At minimum:

- Number of completed transactions
- Gross sales
- Discounts
- Tax collected
- Final sales total
- Cash total
- Card total

These values are calculated from local SQLite.

---

# 54. Historical Daily Report Workflow

User may select another date.

Application recalculates report from local sales records.

Google Sheets is not queried.

A sale's date is derived, at query time, from its authoritative `completed_at` (UTC) converted into the currently configured business timezone (`DATA_MODEL.md` Section 4). A sale voided after its original day has closed reduces that **original** day's reported revenue when the report is re-viewed — there is no separate revenue-adjustment line on the void date — while the void itself is dated by `voided_at` for audit/void-activity visibility, so "revenue for day X" and "voids that happened on day X" are independently correct.

---

# 55. Daily Closing Workflow

V1 daily closing is reporting-oriented.

Suggested workflow:

1. User opens Daily Report.
2. Reviews transaction count.
3. Reviews Cash total.
4. Reviews Card total.
5. Reviews discounts.
6. Reviews tax.
7. Reviews final sales.
8. Optionally prints or records totals manually.

V1 does not require a complex accounting close/lock procedure unless future requirements add one.

---

# 56. Google Sheets vs Local Report Mismatch

## Scenario

Some sales are still pending export.

Example:

Local SQLite:

`20 sales`

Google Sheets:

`18 sales`

Expected behavior:

Local POS report still shows:

`20 sales`

Google Sheets pending count may show:

`2`

The POS must never downgrade local reporting to match incomplete Google export state.

---

# 57. Application Close Workflow

## Trigger

User closes application.

## Expected Behavior

1. New writes stop safely.
2. Current SQLite operations finish or roll back.
3. Connections close cleanly.
4. Google worker may stop.
5. Pending Google jobs remain in SQLite.
6. Application exits.

The user must not be forced to wait for all Google Sheets exports to finish before closing.

---

# 58. Restart After Offline Sales

## Scenario

1. Internet disconnected.
2. Sale completed.
3. Application closes.
4. Application reopens while still offline.

Expected:

- Sale remains in history.
- Inventory remains reduced.
- Payment remains recorded.
- Receipt can be reprinted.
- Google export remains Pending.

---

# 59. Windows Restart Recovery

## Scenario

Same as above, but Windows itself restarts.

Expected behavior is identical.

Committed data must survive.

---

# 60. App Crash During Draft Checkout

## Scenario

Application crashes before sale submission.

Expected:

- No sale exists.
- No payment exists.
- Inventory remains unchanged.
- No Google export job exists.

The draft cart may be lost in V1 unless saved carts become a separate requirement.

---

# 61. App Crash During Local Sale Transaction

## Scenario

Application crashes before SQLite commit completes.

Expected:

SQLite transaction recovery must result in:

Either:

```text
Entire sale committed
```

or:

```text
Entire sale absent
```

Never a partial business transaction.

---

# 62. App Crash Immediately After Commit

## Scenario

SQLite commits successfully but application crashes before success screen appears.

Upon reopening:

- Sale exists.
- Inventory is updated.
- Payment exists.
- Export job exists.
- Checkout request is marked completed.

If the same checkout request is retried, the existing sale should be returned rather than duplicated.

---

# 63. Printer Retry After Restart

If a receipt failed to print before application shutdown:

1. Reopen application.
2. Open Sales History.
3. Select sale.
4. Reprint receipt.

No special printer retry state is required to preserve the transaction itself.

---

# 64. Google Export Retry After Restart

Pending Google export jobs automatically survive application restart because they are stored in SQLite.

On startup:

1. Export worker initializes.
2. Pending jobs are discovered.
3. Internet is available?
4. If yes, exports resume.
5. If no, jobs remain pending.

---

# 65. Backup Workflow

## Trigger

User initiates a manual backup, or the recurring automatic-backup schedule becomes due.

## Expected Flow

1. Application performs a SQLite-consistent snapshot/backup procedure (`DATA_MODEL.md` Section 54, "Backup and Recovery-Copy Safety Under WAL") — never a raw copy of the live main database file while connections/WAL activity may exist.
2. Backup copy is written to approved location.
3. Backup integrity is verified sufficiently to treat the copy as usable.
4. Local backup metadata records type, creation time, outcome, verification state, and sanitized failure details where applicable.
5. Backup health and last-successful-backup time are updated.
6. A durable success or failure audit event is recorded.
7. Retention cleanup removes only backups beyond the configured policy, preserves backups held for migration or recovery, and never removes the only verified usable backup.

Backup must not corrupt the active database.

---

# 66. Backup Failure Workflow

If backup fails:

- Normal sales should continue if SQLite itself is healthy.
- A visible backup-health warning should identify that protection is overdue or failing.
- The failure should be recorded in the durable audit trail and diagnostic log without exposing sensitive data.
- Automatic backup should retry according to policy without creating an overlapping backup operation.

Backup failure should not be confused with sale failure.

---

# 67. Restore Test Workflow

Before production release:

1. Create backup.
2. Copy backup to test environment.
3. Restore database.
4. Launch application.
5. Verify:
   - Products
   - Inventory
   - Customers
   - Sales
   - Payments
   - History
   - Pending exports

Restore must be demonstrated, not merely assumed.

A production restore is an exclusive maintenance operation. It must not start during an active or in-flight checkout, and normal database use must remain unavailable until restore validation completes or the original database is safely retained.

---

# 67A. Restore Database Workflow (Production Restore Safety)

## Trigger

The shared user selects `Restore Database` and chooses a backup to restore from.

## Expected Flow

1. Confirm no checkout is active or in flight; if one is, defer until idle (Section 102).
2. Preserve a SQLite-consistent snapshot/backup copy (`DATA_MODEL.md` Section 54, "Backup and Recovery-Copy Safety Under WAL" — not a raw file copy) of the **current** database before touching anything.
3. Read the selected backup's metadata: schema version, source app version, creation time, and its latest contained sale timestamp.
4. Compare the backup's latest sale timestamp against the current database's latest sale timestamp.
5. If the current database is newer, warn clearly, naming how many transactions and what date range would be lost, and require an explicit, unambiguous confirmation before proceeding. There is no default-confirmed or silent path when data would be lost.
6. Replace the active database with the backup only after any required confirmation.
7. Validate the restored database (schema version, foreign keys enabled, critical tables readable) before reopening checkout.
8. If validation fails, restore the pre-restore copy from step 2 and report a stable error code and recovery guidance.
9. On success, record the restore outcome in diagnostics and reopen checkout.

V1 restore is whole-database replace-or-abort; it does not attempt to merge records between the current database and the restored backup.

---

# 68. Change Tax Rate Workflow

## Trigger

User changes configured tax rate.

## Flow

1. Validate new rate.
2. Save the new setting and its durable audit event atomically.
3. Future transactions use new rate.
4. Historical transactions remain unchanged.

Existing sales retain their original tax-rate snapshot.

---

# 69. Change Business Information Workflow

## Trigger

User changes:

- Business phone
- Address
- Receipt footer
- Disclaimer

## Expected Behavior

The setting change and its durable audit event commit together. Future receipts use updated settings.

Historical receipts use their stored transaction-time snapshots.

---

# 70. Change Printer Workflow

## Trigger

User selects another printer in settings.

## Flow

1. Application lists available printers.
2. User selects printer.
3. Selection is saved locally.
4. Future print attempts use selected printer.

Changing printer does not modify receipt data.

---

# 71. Google Sheets Configuration Workflow

## Trigger

User enables Google Sheets export.

## Configuration May Include

- Authorized Google account / credential mechanism
- Spreadsheet ID
- Sales worksheet name
- Sale Items worksheet name

## Expected Behavior

1. Validate configuration.
2. Securely store required credentials.
3. Save non-secret settings and a durable configuration-change audit event atomically.
4. Test integration where appropriate.
5. Enable export worker.

If setup fails, local POS remains usable.

---

# 72. Disable Google Sheets Workflow

## Trigger

User disables Google Sheets export.

Expected:

- Checkout remains fully functional.
- Every committed sale still receives one durable export job.
- Network export attempts stop while integration is disabled; jobs needing synchronization remain `PENDING`.
- Existing local sales remain unchanged.
- Existing pending jobs must not be silently deleted.
- Enabling the integration makes represented sale states eligible for idempotent export.

---

# 73. Offline Indicator Workflow

The UI may display:

```text
Online
```

or:

```text
Offline
```

This status is informational only.

The status must not control whether local checkout is allowed.

---

# 74. Low Stock Workflow

If quantity reaches configured low-stock threshold:

Application must visually indicate:

`Low Stock`

This is a required V1 capability (`REQ-PROD-007`), consistent with `PRODUCT_SCOPE.md` Section 7 listing low/zero-stock detection as included functionality.

If quantity reaches zero:

Product must not be sellable without future explicit override functionality.

---

# 75. Out-of-Stock During Checkout

## Scenario

Product was added to cart when stock was available, but authoritative stock validation later finds insufficient quantity.

Expected:

Sale completion is rejected.

Example:

`Inventory changed. Only 1 unit remains available.`

No partial sale should be committed.

---

# 76. Invalid Price Workflow

Examples:

- Negative price
- Invalid text
- Unsupported currency value

Expected:

Application rejects the input before checkout completion.

---

# 77. Invalid Customer Data Workflow

If required customer fields are invalid:

- Customer creation is rejected.
- Cart remains available.
- Cashier may correct customer data or continue without attaching customer.

Customer failure must not destroy the current cart.

---

# 78. Receipt Disclaimer Workflow

The receipt should use the Go Phones - Alvin disclaimer approved for the client.

It should be rendered in smaller text where necessary.

Receipt generation should use the sale's stored disclaimer snapshot for historical reprints.

---

# 79. V1 Repair Policy Behavior

Although the store performs repairs, V1 has no repair workflow.

Therefore:

- Repair tickets are not created.
- Repair jobs are not tracked.
- Repair parts are not tracked.

The client-requested disclaimer may still appear on sales receipts.

---

# 80. Trade-In Request During V1

If business asks to perform trade-in through POS before scope changes:

The system should not improvise a hidden trade-in workflow.

Trade-in remains out of scope until:

- Product scope changes
- Requirements change
- Data model changes
- Workflows are defined
- Tests are added

---

# 81. IMEI Request During V1

IMEI is not required in V1.

Sale completion must not require:

- IMEI
- Serial number

Do not add hidden mandatory device identifiers during implementation.

---

# 82. Core Happy-Path Scenario

A representative successful sale:

```text
Launch application
↓
Login
↓
Scan iPhone 15
↓
Product added
↓
Listed price $599
↓
Cashier negotiates $550
↓
Select existing customer
↓
Tax calculated
↓
Customer chooses Cash
↓
Cashier confirms payment
↓
Complete Sale
↓
Inventory 5 → 4
↓
Inventory movement -1
↓
Payment stored
↓
Receipt GP-000124 created
↓
Google export job created
↓
SQLite transaction commits
↓
Receipt prints
↓
Sale appears in history
```

---

# 83. Core Offline Happy Path

```text
Disconnect Wi-Fi
↓
Launch application
↓
Login
↓
Scan product
↓
Create sale
↓
Complete Cash payment
↓
SQLite COMMIT
↓
Inventory updates
↓
Receipt prints
↓
Google export = Pending
↓
Close application
↓
Restart Windows
↓
Reopen application offline
↓
Sale still exists
↓
Inventory still correct
↓
Internet reconnects
↓
Google export completes
↓
No duplicate row
```

---

# 84. Core Failure Principle

Every failure falls into one of two categories.

## Local Critical Failure

Example:

```text
SQLite cannot commit
```

Result:

```text
SALE FAILS
```

---

## External / Secondary Failure

Examples:

```text
Printer fails
Google Sheets fails
Internet fails
```

Result:

```text
LOCAL SALE REMAINS SUCCESSFUL
```

This distinction must remain clear in implementation and UI messaging.

---

# 85. Workflow Definition of Done

The workflow specification is considered implemented correctly when the system can demonstrate:

1. Product creation.
2. Initial inventory creation.
3. Barcode lookup.
4. Cart creation.
5. Quantity changes.
6. Price override.
7. Customerless sale.
8. Customer-attached sale.
9. Cash payment.
10. Manual Clover card payment.
11. Atomic sale commit.
12. Inventory deduction.
13. Inventory movement creation.
14. Duplicate checkout protection.
15. Receipt generation.
16. Print failure isolation.
17. Receipt reprint.
18. Offline checkout.
19. Offline restart.
20. Windows restart persistence.
21. Google export queuing.
22. Google export retry.
23. Google duplicate prevention.
24. Daily local reporting.
25. Manual inventory adjustment.
26. Database backup.
27. Backup restore.
28. External failures without local transaction corruption.
29. Clear unfinished checkout.
30. Void with historical preservation and inventory reversal.
31. Void propagation to Google Sheets without a duplicate logical sale.
32. Recurring automatic backup and visible backup health.
33. Safe update discovery, deferral, and installation.
34. Support/problem reporting and privacy-safe bundle export.
35. Single-instance, sleep/resume, crash, disk, and clock recovery behavior.
36. Owner CSV export.
37. Durable audit events.
38. Maintenance exclusion during active checkout.
39. Card-approved / local-commit-failure evidence, warning, and reconciliation queue.
40. Restore safety: pre-restore recovery copy, newer-data detection, and required confirmation.
41. Checkout drift detection and rejection on material change between review and commit.
42. Shared-credential lifecycle: first-run setup, change, local recovery, brute-force backoff.

---

# 86. Core Workflow Rule

The central user-facing behavior of Go Phones POS is:

> The cashier should be able to sell a phone quickly and reliably without needing to understand the architecture underneath the system.

The central engineering behavior is:

> Every completed sale must first become a durable, internally consistent local transaction, including its durable Google export job, before printing, Google Sheets API calls, or any other external operation is attempted.

---

# 87. Clear Unfinished Checkout Workflow

## Trigger

Cashier selects `Clear Cart` or cancels checkout before the local sale transaction commits.

## Expected Behavior

1. Application asks for confirmation when the cart is non-empty.
2. On confirmation, temporary cart, customer selection, and payment selection are cleared.
3. No sale, payment, inventory movement, receipt number, or Google export job is created.
4. Inventory remains unchanged.

This action is distinct from voiding a completed sale.

---

# 88. Void Completed Sale Workflow

## Trigger

The shared store user opens a completed sale in Sales History and selects `Void Sale`.

## Expected Flow

1. Display the immutable original receipt, payment method, amount, and items.
2. Require a non-empty void reason and explicit confirmation.
3. Begin one authoritative SQLite transaction.
4. Verify the sale is currently completed and has not already been voided.
5. Set the sale state to `VOIDED` and preserve the void timestamp and reason without deleting or rewriting its original sale items or payment.
6. Restore inventory through explicit reversing inventory movements linked to the original sale.
7. Record a durable `SALE_VOIDED` audit event.
8. Advance and reschedule the sale's single durable export job as `PENDING` so the same Sale ID is upserted with the authoritative voided state. If integration is disabled, configuration gates the worker and no network request occurs.
9. Commit all local void effects together, or roll back all of them.

After commit, Sales History continues to show the original transaction as voided. Reports exclude its revenue, discounts, tax, and payment totals while preserving its visibility and audit history. Google Sheets synchronization must update the existing logical sale and must not append a second logical sale.

---

# 89. Cash Sale Void Workflow

For a completed Cash sale, the normal void workflow applies. The POS restores inventory and corrects reporting; any physical cash handling remains an operational store action.

---

# 90. Card / Clover Sale Void Workflow

Before confirming a Card sale void, display a clear warning:

```text
Voiding this POS sale does not refund or reverse the Clover payment.
Complete any required refund or reversal separately in Clover.
```

The user must explicitly acknowledge the warning. The POS then performs only its local void workflow. Direct Clover reversal and full return/refund workflows remain outside V1.

---

# 91. Double-Void Rejection Workflow

If a user tries to void a sale already in `VOIDED` state, the application rejects the request without changing inventory, movements, reporting, audit history, or export state. The existing void timestamp and reason remain unchanged.

---

# 92. Update Discovery and Download Workflow

When internet is available, the application may check the configured generic HTTPS release feed in the background.

1. If no approved update exists, normal operation continues.
2. If an approved update exists, the application automatically begins downloading it in the background while the POS remains usable. Whether/when the application checks is flexible (startup, periodic, or manual); once found while online, download is automatic and not merely optional.
3. A failed check or download produces a non-blocking status and diagnostic event; local sales continue.
4. When verification and download finish, the UI displays `Update Ready` with `Restart & Update` and `Later` actions.

Approved artifacts use semantic versions, are code signed, and remain traceable to the tested source revision and build.

Offline use never requires an update check. The installed version continues operating without GitHub access, client API keys, or manual build downloads.

---

# 93. Restart & Update Workflow

## Trigger

User selects `Restart & Update` for a verified ready update.

## Expected Flow

1. If a checkout is active or in flight, defer the restart and explain that the checkout must finish or be cleared first.
2. Stop new maintenance-sensitive work and reach a safe application boundary.
3. Restart into the verified, code-signed update.
4. Keep business data in its application-data location, separate from replaceable binaries.
5. If the schema changes, create and verify a pre-migration backup before applying versioned migrations.
6. If backup verification fails, do not begin migration; retain the current usable data and report the failure.
7. If migration fails, stop normal checkout, preserve the pre-migration backup, and show recovery guidance.
8. On success, reopen the application with sales, receipt numbering, settings, audit history, and pending Google export jobs preserved.
9. Record the update installation and any migration execution in the durable audit trail.

The user may choose `Later`; installation remains deferred without blocking sales. Restore and schema migration follow the same exclusive-maintenance rule and cannot interrupt active checkout.

If the installed release is defective, follow the tested bad-release recovery procedure. A code rollback must not replace business data, and migration recovery must preserve evidence and the verified backup without silently discarding newer authoritative records.

---

# 94. Report a Problem Workflow

## Trigger

User selects `Support & Diagnostics → Report a Problem`.

## Expected Flow

1. Show friendly recent activity and stable error codes.
2. Let the user enter a brief problem description.
3. Associate the report with the relevant correlation ID where available.
4. Offer local support-bundle generation.

Reporting a problem must not require checkout to stop and must work while offline; transmission to support, if later provided, is separate from bundle creation.

---

# 95. Export Support Bundle Workflow

1. Gather structured rotating logs, crash evidence, current health states, application/build version, schema version, installation identifier, and sanitized configuration metadata.
2. Exclude plaintext passwords, tokens, API secrets, authorization headers, card numbers, CVV, Clover credentials, and unnecessary customer data.
3. Create the bundle at a user-approved location.
4. Display success or a clear non-blocking failure.

Bundle creation must not mutate authoritative business records.

---

# 96. Health Status and Warning Workflow

Support & Diagnostics shows, at minimum:

- Application and build version
- Database schema and health
- Internet state
- Printer state where detectable
- Google Sheets state and pending/failed counts
- Backup health and last successful backup
- Disk-space health
- Installation identifier

SQLite open, schema, or transaction-safety failures may block checkout. Printer, internet, Google Sheets, update-service, backup, or diagnostic-export failures are secondary warnings and do not invalidate committed sales.

---

# 97. Low Storage Workflow

When free disk space crosses a warning threshold, display a clear warning, record a sanitized diagnostic event, and direct the user to free space or contact support. Do not automatically block sales solely because the warning threshold was crossed; block new writes only when the application cannot safely commit or preserve the local database.

---

# 98. Suspicious System-Clock Change Workflow

When a significant clock jump is detected, record the observed change and show a warning where useful. Continue local sales unless a separate local safety failure exists. Preserve durable identifiers and audit ordering metadata so clock anomalies do not cause duplicate sales, receipts, or exports.

---

# 99. Windows Sleep / Resume Workflow

After resume, the application rechecks database availability, connectivity, export-worker scheduling, backup schedule, disk space, and printer state where detectable. An in-flight SQLite transaction must resolve through normal commit/rollback guarantees. The user must not be shown sale success unless commit is confirmed.

---

# 100. Crash and Restart Recovery Workflow

On restart after an application crash or abrupt termination:

1. Preserve crash evidence for diagnostics.
2. Open SQLite and verify database/schema health before enabling checkout.
3. Recover transactions atomically through SQLite.
4. Recover stale Google export work safely and without duplicates.
5. Recalculate backup-overdue and other health states.
6. Continue offline when local health is safe.

If local database safety cannot be established, checkout remains blocked with a stable error code and recovery guidance.

---

# 101. Single-Instance Launch Workflow

If Go Phones POS is already running, a second launch request focuses and restores the existing window. It must not start another independent POS process, database lifecycle, migration runner, backup scheduler, or export worker.

---

# 102. Safe Maintenance Workflow

Restart & Update, schema migration, and database restore require a maintenance lock and exclusive database lifecycle control. The application must:

1. Detect any active or in-flight checkout.
2. Refuse or defer maintenance until that checkout finishes or is explicitly cleared.
3. Prevent new checkout submission once maintenance begins.
4. Complete or stop background work at a safe boundary.
5. Run the maintenance action once, with clear success or recovery status.

Maintenance must never silently abandon a cart or interrupt a sale transaction.

---

# 103. Owner CSV Export Workflow

The shared owner/manager user may export separate CSV files for:

- Products and current inventory
- Customers
- Sales, including void state where applicable
- Inventory movements, including void reversals

The user selects the dataset and destination. The application reads a consistent view from authoritative SQLite, writes a documented header row and deterministic values, and reports the result. CSV export is one-way only; V1 does not import CSV data. Export failure must not alter products, customers, sales, inventory, movements, or audit history.

---

# 104. Durable Audit Workflow

Important business and system actions create durable local audit events separate from rotating diagnostic logs. This includes sale completion, sale void, price override, inventory adjustment, tax and business-setting changes, Google Sheets configuration changes, backup success/failure, migration execution, update installation, shared-credential changes, and a Clover-approved card charge whose local commit failed (Section 35A). Audit records remain available after diagnostic log rotation and must avoid secrets and unnecessary customer/payment data.

---

# 105. Final Workflow Rule

The central user-facing behavior of Go Phones POS is:

> The cashier should be able to sell a phone quickly and reliably without needing to understand the architecture underneath the system.

The central engineering behavior is:

> Every completed sale or void must first become a durable, internally consistent local transaction before any related printing or external synchronization is attempted.
