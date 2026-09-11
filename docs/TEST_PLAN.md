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

## TEST-TAX-003 — Tax Rounding (Concrete Expected Values)

Using the fixed formula `tax_cents = floor((taxable_amount_cents × tax_rate_bps + 5000) / 10000)` (`DATA_MODEL.md` Section 42):

| `taxable_amount_cents` | `tax_rate_bps` | Expected `tax_cents` |
|---|---|---|
| 55000 | 825 | 4538 |
| 33 | 825 | 3 |
| 30 | 825 | 2 |
| 10 | 500 | 1 |
| 100 | 825 | 8 |
| 0 | 825 | 0 |

Expected:

Every row produces exactly the listed integer-cent value — no floating-point drift, and no alternate rounding (truncation or round-half-even) is applied.

The same rounding rule must be used in:

- Checkout
- Sales history
- Receipt
- Reports
- Google Sheets export

---

## TEST-TAX-005 — Tax Basis Uses Sold Price, Not Listed Price

Negotiate a price below listing, then verify the taxable amount.

Expected:

`taxable_amount_cents` is computed from `sold_price_cents × quantity`, never from `listed_price_cents`.

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

## TEST-DISC-005 — Sold Price Above Listed Price

Sold price greater than listed price, sale completed.

Expected:

Sale commits; `sale_items.discount_cents = 0` for that line (clamped, never negative).

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

SKU uniqueness is always enforced in V1 when a SKU is present (not a configurable toggle).

Create product A with SKU X.

Attempt product B with SKU X.

Expected:

Second product is rejected.

## TEST-PROD-004A — Multiple Products Without SKU/Barcode

Create two products, neither with a SKU or barcode.

Expected:

Both are accepted; a blank SKU/barcode is stored as absent, not as an empty string, so it never collides against the uniqueness constraint.

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

## TEST-PROD-007 — Product Condition Allowed Values

Attempt to create/edit products with `condition = NEW`, `USED`, and `REFURBISHED`, then attempt an unsupported value (e.g., `LIKE_NEW`).

Expected:

The three documented values succeed; the unsupported value is rejected at both the application layer and the database constraint.

---

## TEST-PROD-009 — Low Stock Indication

Set a product's `quantity_on_hand` at, above, and below its `low_stock_threshold`.

Expected:

The UI shows a `Low Stock` indicator only at or below the threshold; this is required behavior, not an optional visual enhancement.

---

## TEST-PROD-008 — Complete Product Edit Persistence

Edit every editable field in one operation: name, brand, model, condition, selling price, cost price, SKU, barcode, and low-stock threshold.

Expected:

All fields persist correctly, `updated_at` changes, and the product remains searchable with the new values after an application restart.

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

# 10A. Cart Interaction Tests

These validate `REQ-SALE-001` through `REQ-SALE-005`, `REQ-SALE-012`, and `REQ-SALE-013`, distinct from post-commit inventory tests (Section 10) since the cart is not yet a sale.

## TEST-CART-002 — Start New Sale

Select `New Sale`.

Expected:

An empty cart with no customer or payment selected is created; no `sales` row exists yet.

---

## TEST-CART-003 — Manually Add Cart Item

Search for a product and add it to the cart.

Expected:

The line appears with default unit price equal to the current listed price, quantity 1, and correct cart totals; no inventory change occurs yet.

---

## TEST-CART-004 — Remove Cart Item

Add two products to the cart, then remove one.

Expected:

Only the remaining item is present; totals recalculate; no inventory movement is created.

---

## TEST-CART-005 — Change Quantity

Add a product with stock of 5, then change its cart quantity to 3, then attempt to change it to 6.

Expected:

Quantity 3 is accepted and totals update; quantity 6 is rejected with a clear "only N available" message and the cart is not corrupted.

---

## TEST-CART-006 — Duplicate Product Line Aggregation

Add the same product to the cart twice as separate lines (e.g., once at listed price, once at a negotiated price), for a combined quantity that exceeds available stock only when summed.

Expected:

Stock validation aggregates both lines by product ID and rejects the checkout; splitting the quantity across two lines does not bypass the stock check.

---

## TEST-CART-007 — Quantity Bounds

Attempt cart quantities of `0`, a negative number, a fractional value (e.g., `1.5`), and `1000`.

Expected:

All are rejected; only positive integers from `1` to `999` are accepted per line.

---

## TEST-CART-008 — Monetary Bounds

Attempt a negotiated price and a full-sale total exceeding the documented ceilings (`DATA_MODEL.md` Section 41A).

Expected:

Both are rejected with a clear validation error before commit.

---

## TEST-CART-009 — Malformed Numeric Input

Submit a checkout payload with a non-numeric, `NaN`, or `Infinity` value in a quantity or price field.

Expected:

Rejected at the trusted application boundary regardless of what the renderer already validated.

---

## TEST-CART-010 — Negotiated Price Above Listed Price

Set a negotiated selling price higher than the listed price.

Expected:

The override is accepted; `discount_cents` for that line is `0` (clamped), not negative.

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

## TEST-IDEMP-005 — Reused Checkout Request ID With Different Fingerprint

1. Submit `request_id = ABC123` for cart A.
2. Before or after it completes, submit `request_id = ABC123` again for a materially different cart B (different items/prices).

Expected:

The second submission is rejected as an idempotency-key conflict; it does not silently apply cart B's content to cart A's sale, and does not create a second sale under the same request ID.

---

## TEST-IDEMP-006 — Checkout Drift Rejected at Commit

1. Cashier reviews a cart (fingerprint computed).
2. Before Complete Sale is pressed, change the configured tax rate (or archive one of the cart's products, or reduce its stock below the cart quantity).
3. Press Complete Sale using the original review.

Expected:

The commit is rejected with a re-review error rather than silently completing using the new tax rate/availability/stock; no sale, payment, or inventory change occurs.

If a durable checkout request had already been recorded for this attempt (`status = SUBMITTED`), it does not remain misleadingly `SUBMITTED`: it is best-effort advanced to `status = COMMIT_FAILED` with the stable re-review failure code (`CHECKOUT_DRIFT`, `INSUFFICIENT_STOCK`, or `PRODUCT_ARCHIVED`) and `failed_at` set (`DATA_MODEL.md` Sections 31, 33). A precondition that is already broken before the request is recorded (no tax rate, no business identity, an already-archived product) is rejected before any `checkout_requests` row is created. To retry, the cashier Reviews the cart again; that fresh review computes a new fingerprint and uses a **new `request_id`**, and can complete if current state is valid. The original drifted request stays `COMMIT_FAILED` as evidence of the superseded attempt.

---

## TEST-IDEMP-007 — Card Total Must Match Clover-Processed Amount

Force the authoritative recalculated total to differ from `checkout_requests.intended_total_cents` for a Card checkout (e.g., a price changed between review and commit).

Expected:

Commit is rejected rather than recording a Card sale for a different amount than the cashier processed on Clover.

---

## TEST-IDEMP-008 — Deterministic Fingerprint Ordering With Duplicate Product Lines

Compute `request_fingerprint` (`DATA_MODEL.md` Section 41B) for the following cart variants:

1. **Same product on multiple lines, different negotiated prices:** a cart with two lines for the same `product_id` — one at listed price, one at a negotiated price — plus one line for a different product.
2. **Same logical lines, different input order:** the identical set of line tuples from (1), but constructed/submitted with the lines added to the cart in the reverse order.
3. **A genuinely different cart:** the same lines as (1), but with one line's `quantity` (or `sold_price_cents`) changed.
4. **Exact duplicate lines:** two lines for the same `product_id` with identical `listed_price_cents`, `sold_price_cents`, and `quantity`, submitted in both possible input orders.

Expected:

- (1) and (2) produce the **identical** `request_fingerprint` — canonical ordering by `(product_id, listed_price_cents, sold_price_cents, quantity)` makes the fingerprint independent of incidental insertion order.
- (3) produces a **different** `request_fingerprint` from (1)/(2) — a genuine content difference is never masked by canonicalization.
- Both input orders in (4) produce the identical fingerprint, and the resulting sale still contains two distinct `sale_items` rows (canonicalization never merges or deduplicates lines), while stock validation still aggregates their combined quantity by `product_id` per `TEST-CART-006`.

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

## TEST-CUST-007 — Customer Purchase-History Lookup

Complete three sales for the same customer, plus one sale for a different customer.

Expected:

Viewing the first customer's purchase history returns exactly their three sales, correctly ordered, and excludes the other customer's sale.

---

## TEST-CUST-008 — Customer Without Phone

Create a customer with only a name, no phone number.

Expected:

Creation succeeds; the customer can still be attached to a sale and found by name search.

---

## TEST-CUST-009 — Phone Normalization Search

Create a customer with phone `(281) 824-0001`, then search using `281-824-0001` and `2818240001`.

Expected:

All three forms match the same customer via the normalized phone value.

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

1. Select Card. Verify `checkout_requests.status = PENDING_PAYMENT` commits before any Clover instruction is shown.
2. Confirm Clover payment approved. Verify `clover_approved_confirmed_at` is set and `status = SUBMITTED` before the sale transaction is attempted.
3. Complete sale.

Expected:

Payment method = CARD; the row reaches `status = COMPLETED`.

---

## TEST-CARD-002 — Clover Declined

Select Card, allow Phase 1 Step A to durably commit (`status = PENDING_PAYMENT`), then select:

`Payment Declined / Cancel`

Expected:

- No sale
- No inventory change
- Cart remains
- The existing `checkout_requests` row is updated to `status = COMMIT_FAILED`, `failure_code = CLOVER_DECLINED`
- The row does **not** appear in the Reconciliation Queue (a decline is not an incident)

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

## TEST-CARD-005 — Clover Approved, Local Commit Fails (Priority 0, Case 1)

1. Select Card; verify Phase 1 Step A durably commits (`status = PENDING_PAYMENT`) before any Clover instruction is shown.
2. Confirm Clover approval inside the POS; verify Phase 1 Step B durably commits (`clover_approved_confirmed_at` set, `status = SUBMITTED`).
3. Force the authoritative Phase 2 sale transaction to fail (e.g., simulated write failure).

Expected:

- No `sales`, `payments`, `inventory_movements`, or export-job row is created.
- The `checkout_requests` row from Phase 1 survives with `payment_method_snapshot = CARD`, the recorded `intended_total_cents`, and `clover_approved_confirmed_at`, and is updated to `status = COMMIT_FAILED`.
- The cashier is shown the specific Clover-review warning (`POS_WORKFLOWS.md` Section 35A), not a generic failure message.
- A `CARD_LOCAL_COMMIT_FAILURE` audit event exists (or, if SQLite is entirely unreachable, the diagnostic fallback captures it).
- The attempt appears in the Reconciliation Queue as unresolved.

---

## TEST-CARD-005A — Pre-Payment Record Committed Before Clover Is Invoked

Select Card and force SQLite to be unavailable exactly at Phase 1 Step A, before the cashier is shown any Clover instruction.

Expected:

- Checkout stops immediately with a local-failure message.
- The cashier is never instructed to process anything on Clover for this attempt — no charge is put at risk.
- No `checkout_requests` row exists for this attempt (Step A never committed), and none is expected, since nothing durable needed to survive an attempt that never reached Clover.

---

## TEST-CARD-005B — Approval Confirmation Write Fails (Priority 0, Case 2)

1. Select Card; allow Phase 1 Step A to commit (`status = PENDING_PAYMENT`).
2. Cashier processes the amount on Clover; Clover approves.
3. Cashier selects `Payment Approved`, but force the Phase 1 Step B durable write to fail before it commits.

Expected:

- The `checkout_requests` row remains at `status = PENDING_PAYMENT` with `clover_approved_confirmed_at` still `NULL`.
- No `sales`, `payments`, or export-job row is created; Phase 2 is never attempted.
- The cashier sees the same Clover-review warning as Case 1.
- The row does not yet appear in the Reconciliation Queue if still within the staleness window; once the staleness window elapses without further progress, it does appear (`TEST-CARD-005C`).

---

## TEST-CARD-005C — Stale PENDING_PAYMENT Surfaces in Reconciliation Queue

Following `TEST-CARD-005B`, advance time past the documented staleness window (`ARCHITECTURE.md` Section 49A) without further action.

Expected:

The row appears in the Reconciliation Queue exactly as a `COMMIT_FAILED` row would, even though it never reached `COMMIT_FAILED`.

---

## TEST-CARD-006 — Retry After Commit Failure Completes Without Re-Charging

Following `TEST-CARD-005`, resolve the underlying local issue and retry the same cart/request.

Expected:

The sale completes successfully, links to the original `checkout_requests` row (`status = COMPLETED`), and the reconciliation entry is automatically resolved with `"Completed on retry"`; the cashier is never prompted to process the card through Clover again.

---

## TEST-CARD-007 — Reconciliation Queue Manual Resolution

Following `TEST-CARD-005`, do not retry; instead mark the entry resolved with a note.

Expected:

The entry becomes `resolution_status = RESOLVED` with the required note; no sale is created or backdated as a result.

---

## TEST-CARD-008 — Pre-Payment Fingerprint Check Before Clover Is Invoked

1. Complete Checkout Review for a Card sale at a known total (e.g. `$595.38`).
2. Before `begin-card` runs, change authoritative state so the reviewed fingerprint no longer matches — raise the product's listed price, or change the configured `tax_rate_bps`.
3. Run `begin-card` with the original reviewed fingerprint.

Expected:

- `begin-card` is rejected with `CHECKOUT_DRIFT`.
- **No** `checkout_requests` row is created for the attempt.
- The cashier is never shown a Clover instruction / amount; no sale, payment, inventory, or export effect occurs; the cart, customer, and payment choice are retained and the stale review must be re-run. This is not a reconciliation entry — no card was processed.

If instead there is **no** drift (`begin-card` immediately follows Review), the `PENDING_PAYMENT` row is written with `request_fingerprint == reviewedFingerprint` and `intended_total_cents` equal to the reviewed total, and that same value is what `begin-card` returns and what the Clover instruction shows.

This pre-payment check does not replace Phase 2 revalidation: drift that first appears **after** Step A (between `begin-card` and Phase 2, e.g. `TEST-IDEMP-007`) is still detected by Phase 2 after Clover approval and handled as a Card reconciliation incident.

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

V1 authenticates to Google with a desktop OAuth flow and creates its own
spreadsheet (`ARCHITECTURE.md §27`, `REQ-GSHEET-016`–`REQ-GSHEET-020`).
Automated tests exercise the state machine, storage, redaction, and idempotency
against in-memory / fake OAuth and Google API layers. Behavior against the real
Google authorization server and Sheets/Drive APIs — including whether every
required call succeeds under the `drive.file` scope alone — remains **LIVE GOOGLE
VERIFICATION PENDING** until run against a real Google account and spreadsheet,
in the same way physical printing is covered by `HW-PRINT-*`.

The export-engine tests `TEST-GSHEET-001` through `TEST-GSHEET-025` remain valid
unchanged; the connection model does not alter the durable one-job-per-sale
lifecycle, retry/backoff, stale recovery, `target_sync_version` invariant,
convergence semantics, Sale-ID / Sale-Item-ID keys, formula neutralization, RAW
writes, or SQLite authority.

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

Simulate an expired/revoked OAuth credential (token refresh rejected by Google).

Expected:

- Local sale succeeds.
- Export does not.
- Error stored safely; the integration surfaces a re-authorization warning.
- Durable export jobs are retained.
- No secret (token, code, verifier) logged.

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

## TEST-GSHEET-020 — Reversed Export-Response Ordering (Stale-Write Race)

1. Complete a sale; the export worker begins sending its `COMPLETED` state (`sync_version = 1`, job `EXPORTING`).
2. While that request is still in flight, void the sale — `sync_version` becomes `2`, the job is requeued `PENDING` with `target_sync_version = 2`.
3. Let the `sync_version = 2` (`VOIDED`) request complete and be acknowledged first.
4. Then let the original, now-stale `sync_version = 1` (`COMPLETED`) request finally complete and return its response.

Expected:

- The stale `sync_version = 1` acknowledgment does not mark the job `EXPORTED` or current: the version it wrote (`1`) no longer equals `target_sync_version` (`2`), so the acknowledgment is discarded by the local export-job state machine and is not accepted as the current synchronized revision.
- The job remains eligible for `sync_version = 2`.
- A subsequent idempotent upsert for `target_sync_version = 2` converges the Google Sheets row to `VOIDED`.
- Final state: `exported_sync_version = 2`, `target_sync_version = 2`, job `EXPORTED`, Google Sheets row = `VOIDED`.

This test does not assert that the remote Google Sheets cell contents were never transiently `COMPLETED` during the adversarially reordered writes: V1 guarantees convergence to the current revision, not transient remote-byte ordering (`REQ-GSHEET-015`).

---

## TEST-GSHEET-021 — Void While Export Is Actively In Flight

Force a sale's export job into `EXPORTING` (mid-request) and, at that exact moment, void the sale.

Expected:

The void transaction still succeeds locally (it never waits on network export); the job is requeued to the new `target_sync_version = 2` as `PENDING`; when the original in-flight request eventually resolves it is treated as stale per `TEST-GSHEET-020` and cannot mark version `1` current or `EXPORTED`; a later idempotent upsert for `target_sync_version = 2` converges the Google Sheets row to `VOIDED` (`exported_sync_version = 2`).

---

## TEST-GSHEET-022 — Manual Google Sheet Row Modification or Deletion

After a sale exports successfully, manually edit or delete its row directly in the Google Sheet, then trigger a subsequent export-relevant action (e.g., voiding the sale, or a manual retry).

Expected:

The next export attempt re-upserts the row by immutable Sale ID (recreating it if deleted, or overwriting the manual edit) so the sheet converges to the authoritative SQLite state; SQLite itself is never read from, altered by, or made dependent on the manual edit — proving Sheets cannot alter authoritative local state (`REQ-GSHEET-008`).

---

## TEST-GSHEET-023 — Duplicate Sale IDs in the Sheet

Manually duplicate a Sale ID's row in the Sheet (simulating operator error or a sync anomaly), then trigger a subsequent export for that Sale ID.

Expected:

The export layer's use of Sale ID as the upsert key does not crash or corrupt local state; at minimum the local sale and SQLite state remain fully correct regardless of what the external sheet contains, since Sheets is never a read source (`REQ-GSHEET-008`, `DATA_MODEL.md` Section 50).

---

## TEST-GSHEET-024 — Complete Required Worksheet Columns

Export a multi-item sale and inspect both worksheets.

Expected:

Every column listed in `DATA_MODEL.md` Section 26 is present with correct values for both the Sales and Sale Items worksheets — no required column is missing or mislabeled.

---

## TEST-GSHEET-025 — Formula Injection Neutralization (Sheets)

Create a customer name and a product name each beginning with `=`, `+`, `-`, and `@` (e.g., `=1+1`, `+SUM(A1)`), then export a sale referencing them.

Expected:

Every such value is written to the Sheet neutralized (e.g., leading apostrophe) so it renders as literal text and is never interpreted as a formula by a spreadsheet application.

---

## TEST-GSHEET-026 — Connect Launches System-Browser Authorization

Select `Connect Google Account`.

Expected:

The authorization URL (Google account chooser / consent, scopes `drive.file`,
`openid`, `email`) is opened in the external system browser. No Google
sign-in/consent page is loaded in any application `BrowserWindow` or `<webview>`.

---

## TEST-GSHEET-027 — OAuth Uses PKCE

Inspect the authorization request and token exchange.

Expected:

The authorization request carries a PKCE `code_challenge` (S256); the token
exchange sends the matching `code_verifier`. No client secret is relied upon as
a confidential value.

---

## TEST-GSHEET-028 — OAuth State Mismatch Rejected

Deliver a loopback callback whose `state` does not match the value issued for the
attempt.

Expected:

The callback is rejected, no authorization code is exchanged, no credential is
stored, and the attempt ends as a Google-configuration failure.

---

## TEST-GSHEET-029 — Loopback Callback Is localhost-Only

Inspect the temporary callback listener.

Expected:

It binds only `127.0.0.1` / `localhost` on an ephemeral port — never `0.0.0.0`
or another interface. A request arriving from a non-loopback address is not
honored.

---

## TEST-GSHEET-030 — Listener Closes After Success

Complete a successful authorization.

Expected:

The temporary callback listener is closed and its port released immediately
after the code is received.

---

## TEST-GSHEET-031 — Listener Closes After Denial / Error / Timeout

Separately: user denies consent; token exchange fails; the callback never
arrives within the timeout.

Expected:

In every case the listener is closed, no credential is stored, and local sales
are unaffected.

---

## TEST-GSHEET-032 — Refresh Token Encrypted Through safeStorage

Connect successfully, then inspect the persisted credential representation.

Expected:

The refresh token exists only inside the encrypted credential wrapper file under
`userData` (operating-system `safeStorage`), never in the SQLite database and
never in plaintext on disk.

---

## TEST-GSHEET-033 — No Plaintext Fallback

Make operating-system secure storage unavailable, then attempt to connect.

Expected:

Connection does not complete, nothing is written in plaintext, and the UI states
that secure storage is unavailable.

---

## TEST-GSHEET-034 — Renderer Never Receives OAuth Credential Material

Inspect every value crossing IPC to the renderer during and after connect.

Expected:

No refresh token, access token, authorization code, PKCE verifier, ID token, raw
token response, or developer OAuth client configuration is ever sent to the
renderer. At most a display email, connection/setup state, and non-secret
spreadsheet metadata are exposed.

---

## TEST-GSHEET-035 — Tokens and Code Absent From Logs

Exercise a full connect, a token refresh, and a failed authorization while
capturing logs.

Expected:

Logs contain no refresh/access token, authorization code, PKCE verifier, ID
token, raw token response, or `Authorization` header.

---

## TEST-GSHEET-036 — Disconnect Invalidates Locally While Offline

With no internet, select `Disconnect Google Account`.

Expected:

Export is disabled, the active credential is invalidated locally and is
immediately unusable by the worker, and the local configuration change plus its
`GOOGLE_CONFIGURATION_CHANGED` audit commit atomically — without any successful
network revocation. Best-effort credential-file deletion and remote revocation
may be attempted but are not required.

---

## TEST-GSHEET-037 — Google Connection Failure Never Blocks Checkout

With authorization failing (or no internet), complete cash and card sales.

Expected:

All sales commit locally and print; each gets its one durable export job; no
checkout is delayed or blocked by the Google connection state.

---

## TEST-GSHEET-038 — Connected but Spreadsheet Setup Failed Is Recoverable

Force spreadsheet provisioning to fail after OAuth succeeds and the credential is
stored (fail at or before the Drive lookup, so no `files.create` is issued).

Expected:

State is `Connected / setup incomplete`: the account stays connected, `Retry
Setup` is offered, the worker makes no spreadsheet writes, durable export jobs
stay queued, and Google Sheets is not reported as ready. The state and its
sanitized reason persist across a restart. Explicit `Retry Setup` later completes
provisioning without re-authorizing the account.

---

## TEST-GSHEET-039 — Spreadsheet Created With One Tagged Drive `files.create`

Connect for the first time with provisioning available, capturing the sequence
of Google API calls and local configuration writes.

Expected:

- A durable local provisioning/idempotency token is generated **and persisted to
  local configuration before** any create attempt.
- A Drive `files.list` lookup (restricted under the `drive.file` authorization,
  filtering on the Go Phones POS `appProperties` marker + this token) is issued
  **before** any create call.
- With no existing match, the spreadsheet is created by a **single Drive
  `files.create` request** whose body carries, together: the display name, MIME
  type `application/vnd.google-apps.spreadsheet`, and app-private `appProperties`
  holding the marker **and** the provisioning token.
- Sheets `spreadsheets.create` is **never** called, and no separate
  `files.update` (or any later request) is used to attach the `appProperties`.
- The spreadsheet ID is stored as non-secret local configuration; the user
  supplies no spreadsheet.

---

## TEST-GSHEET-040 — Canonical Worksheets Converged Idempotently

After a spreadsheet ID is obtained, and again on a re-run of provisioning
(`Retry Setup`) against the same spreadsheet, inspect the Sheets API calls and
the resulting structure.

Expected:

- Existing worksheet titles/IDs are inspected **before** any worksheet is
  created.
- A canonical worksheet (`Sales`, `Sale Items`) is created only when missing;
  an existing canonical worksheet is reused, not duplicated.
- After an ambiguous add-worksheet response the application re-inspects rather
  than blindly adding a second worksheet in the same canonical role; a re-run
  never yields a duplicate `Sales` or `Sale Items` tab.
- Both worksheets exist with the `DATA_MODEL.md §26` columns and are verified
  before the integration is declared `Ready to sync`; if verification fails the
  state stays `Connected / setup incomplete`.

---

## TEST-GSHEET-041 — Client Enters No Spreadsheet ID or Worksheet Names

Walk the normal setup UI.

Expected:

There is no required field for a spreadsheet ID, a Sales worksheet name, or a
Sale Items worksheet name in the normal flow.

---

## TEST-GSHEET-042 — Open Spreadsheet Uses System Browser

Select `Open Spreadsheet`.

Expected:

The configured spreadsheet opens in the external system browser, not in an
application window.

---

## TEST-GSHEET-043 — Revoked / Invalid Refresh Token Leaves Sales Safe

After connecting, revoke access in the Google account (or corrupt the stored
token), then complete sales and run the worker.

Expected:

Local sales, inventory, receipts, and reporting are unaffected; export jobs
remain durable and retryable; the integration shows a re-authorization warning;
no secret is logged.

---

## TEST-GSHEET-044 — Restart Preserves a Valid Encrypted Connection

Connect, reach `Ready to sync`, restart the application.

Expected:

The connection and spreadsheet configuration are restored from the encrypted
wrapper and local settings; the worker resumes without re-authorization.

---

## TEST-GSHEET-045 — Credential Corruption / Generation Mismatch → Not Ready

Corrupt the encrypted wrapper, or leave its generation/version disagreeing with
the locally active marker.

Expected:

The integration resolves to a disconnected / not-ready state (never a false
"connected"); local sales are unaffected; the user can reconnect.

---

## TEST-GSHEET-046 — Export Engine Regression Under OAuth

Re-run `TEST-GSHEET-001` … `TEST-GSHEET-025` with the OAuth connection model and
an app-created spreadsheet.

Expected:

All pass unchanged — the durable one-job-per-sale lifecycle, retry/backoff,
stale `EXPORTING` recovery, `target_sync_version` invariant, convergence
semantics, Sale-ID / Sale-Item-ID upserts, void convergence, duplicate-remote-ID
tolerance, formula neutralization, and RAW writes are unaffected.

---

## TEST-GSHEET-047 — Ambiguous Spreadsheet Creation, Then Retry

Simulate: the application issues the tagged `files.create`, Google creates the
spreadsheet, the response is lost. The user retries setup.

Expected:

- The retry does **not** immediately issue another `files.create`.
- It re-runs the Drive `files.list` lookup with the **same durable provisioning
  token** and adopts the already-created spreadsheet's ID.
- Exactly one `Go Phones POS Sales` spreadsheet exists; no duplicate is created.
- Because the identifying `appProperties` were written by the original
  `files.create`, the spreadsheet is discoverable with no separate tagging step.

---

## TEST-GSHEET-048 — Ambiguous Spreadsheet Creation, Then Restart

As `TEST-GSHEET-047` but the application restarts (rather than an in-session
retry) before it learned the spreadsheet ID.

Expected:

The provisioning token and the "create attempted" marker, both persisted before
the create, survive the restart. On restart, automatic recovery runs the
`files.list` **lookup only** with that token, finds the existing tagged
spreadsheet, and adopts it. No duplicate spreadsheet is created; the integration
reaches `Ready to sync` after worksheet verification. (Startup recovery never
issues `files.create` — `TEST-GSHEET-052`.)

---

## TEST-GSHEET-049 — Multiple Provisioning-Token Matches → Safe Not-Ready

Simulate an abnormal condition in which the Drive `files.list` lookup returns
**more than one** spreadsheet carrying the Go Phones POS marker and the current
provisioning token.

Expected:

- Provisioning **stops**; the integration does not reach `Ready to sync`.
- The application surfaces a safe diagnostic / configuration state
  (`SUPPORT_DIAGNOSTICS.md §30`).
- No remote spreadsheet is deleted, and none is silently selected as
  authoritative; V1 defines no automatic selection among multiple matches.
- Local sales, inventory, receipts, and reporting are unaffected; durable export
  jobs stay queued.

---

## TEST-GSHEET-050 — Ordinary Setup-Incomplete Startup Does No Google Work

Reach `Connected / setup incomplete` with provisioning failed at/before the Drive
lookup (no `files.create` ever attempted — the "create attempted" marker is not
set). Close and relaunch the application with internet available; do **not**
select `Retry Setup`.

Expected:

- No Drive `files.list` and no `files.create` request is issued at startup.
- No worksheet is added, renamed, or written at startup.
- The state remains `Connected / setup incomplete` with its persisted sanitized
  reason; the UI still offers `Retry Setup`.
- Local sales and durable export jobs are unaffected.

---

## TEST-GSHEET-051 — Startup Recovery After an Attempted Create — Lookup + Adopt

Reach `Connected / setup incomplete` after a `files.create` was attempted and its
outcome was ambiguous ("create attempted" marker set; a tagged spreadsheet in
fact exists remotely under the durable token). Relaunch the application.

Expected:

- Startup issues **one** Drive `files.list` using the **same durable provisioning
  token** — and no `files.create`.
- Exactly one non-trashed match is found and adopted; canonical worksheet/header
  convergence completes; the integration reaches `Ready to sync`.
- No duplicate spreadsheet exists.

---

## TEST-GSHEET-052 — Startup Recovery With Zero Matches Does Not Create

As `TEST-GSHEET-051` but the `files.list` at startup returns **zero** matches
(e.g. the earlier ambiguous create never actually succeeded, or the file was
permanently removed).

Expected:

- Startup does **not** issue `files.create` and does not mutate any worksheet.
- The integration remains `Connected / setup incomplete` and offers
  `Retry Setup`.
- A later explicit `Retry Setup` runs the full canonical flow (lookup first,
  then a single tagged `files.create` on the still-zero-match result) and
  reaches `Ready to sync` after verification.

---

## TEST-GSHEET-053 — Transient Google Failure While Ready Preserves Setup

With the integration `Ready to sync`, complete a sale and let the export worker
hit a transient failure against the configured spreadsheet: separately a network
error, a timeout / aborted request, an HTTP 5xx, and an HTTP 429.

Expected:

- `google_spreadsheet_id` is unchanged and `setupState` stays `Ready to sync`.
- The export job follows the existing rules (definite-failure backoff/retry;
  `unknownOutcome` leaves the job `EXPORTING` for stale recovery).
- No `Retry Setup` prompt appears; local sale state is authoritative and
  unaffected.

---

## TEST-GSHEET-054 — Structural "Not Found" Failure → Ready to Setup Incomplete

With the integration `Ready to sync`, delete/trash the configured spreadsheet in
Google Drive. Complete a new sale and run the export worker until the structural
result is established.

Expected:

- The export job keeps its canonical failure/retry evidence (not discarded).
- `google_spreadsheet_id` is invalidated/cleared; `setupState` transitions
  `Ready to sync → Connected / setup incomplete` with a persisted sanitized
  reason that the Google spreadsheet needs attention.
- The OAuth connection is preserved; the owner is not disconnected or forced to
  re-authorize.
- The export worker makes no further spreadsheet export writes; durable export
  jobs stay queued.
- The UI visibly explains the spreadsheet needs attention and offers
  `Retry Setup`.
- Local sale / inventory / payment / receipt state is unchanged.

---

## TEST-GSHEET-055 — Structural Permission Failure (Auth Still Valid) → Setup Incomplete

As `TEST-GSHEET-054` but the failure is a definite loss of access to the
configured spreadsheet (the per-file grant was removed) while the OAuth
credential itself still refreshes successfully.

Expected:

- Same transition as `TEST-GSHEET-054`: `Ready to sync → Connected / setup
  incomplete`, spreadsheet target cleared, OAuth connection preserved,
  `Retry Setup` offered.
- The "needs re-authorization" signal is **not** raised — authentication for the
  current credential generation is still valid.

---

## TEST-GSHEET-056 — Retry Setup After a Deleted Spreadsheet

Following `TEST-GSHEET-054` (state `Connected / setup incomplete`, spreadsheet
target cleared), the owner selects `Retry Setup`.

Expected:

- No new sign-in: the existing OAuth credential is reused.
- The existing durable provisioning token is reused; Drive `files.list` runs
  first.
- Exactly one match → adopt; **no** match → a single canonical tagged
  `files.create` for a replacement; more than one match → remain `Connected /
  setup incomplete`.
- Canonical `Sales` and `Sale Items` worksheets and headers are converged and
  verified; the integration returns to `Ready to sync` **only after** full
  verification.
- The previously queued export jobs then deliver against the recovered
  spreadsheet with no duplicate logical rows.

---

## TEST-GSHEET-057 — Needs-Re-Authorization Reflects the Current Credential

Connect (generation A). Revoke the token so an export job fails and reaches
`FAILED` with an `AUTH:` error. Then select `Connect Google Account` and complete
a fresh authorization (generation B); provisioning is otherwise `Ready to sync`.

Expected:

- After the successful re-authorization, the integration does **not** report
  "needs re-authorization": the signal reflects credential generation B, which
  has never failed authentication.
- The historical `FAILED` job's `AUTH:` error is not, by itself, treated as
  evidence about generation B.
- Local sales and durable export jobs remain safe; the recovered credential can
  deliver the queued jobs.

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

## TEST-PRINT-007 — Full Receipt Field Verification

Complete a multi-item sale with a customer, a price override, and a non-zero discount, then generate its receipt.

Expected:

Every field required by `REQ-REC-002` is present and correct: business name/address/phone, receipt number, date/time, customer name and phone, each item with quantity/price/discount, subtotal, tax, total, payment method, disclaimer/policy text, and thank-you message.

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

## TEST-HIST-006 — Sales History Date Search

Complete sales on three different business dates, then search/filter Sales History for one specific date.

Expected:

Only sales whose derived business date (`DATA_MODEL.md` Section 4) matches the selected date are returned, using the configured business timezone rather than UTC calendar date.

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

This is first-run **bootstrap** of a brand-new empty database: `001_initial_schema` runs with no pre-migration backup and records no `backup_records` row, because no prior initialized database state exists to preserve and the backup-evidence tables do not exist yet. Backup-gated migration of an *already-initialized* database is covered by `TEST-BACKUP-012` / `TEST-BACKUP-013` and Section 25.

---

## TEST-DB-008 — Migration Idempotence

Restart application.

Expected:

Applied migrations are not rerun.

---

## TEST-DB-009 — Enum Constraint Enforcement

Attempt to insert/update rows with out-of-range values for `products.condition`, `sales.status`, `inventory_movements.movement_type`, `payments.method`, and `google_sheet_export_jobs.status`.

Expected:

Each is rejected by database constraint, not merely by application-layer convention.

---

## TEST-DB-010 — Foreign Key ON DELETE Behavior

For each relationship in `DATA_MODEL.md` Section 35, attempt to delete the referenced row (e.g., a product referenced by a sale item) directly against the database.

Expected:

Each relationship enforces its documented action (`RESTRICT`, `SET NULL`, or `CASCADE`) exactly; a product/customer referenced by historical data is never silently orphaned or cascade-deleted in a way that removes sale, payment, or movement history.

---

## TEST-DB-011 — One Payment Per Sale

Attempt to insert a second `payments` row for a sale that already has one.

Expected:

Rejected by the `payments.sale_id UNIQUE` constraint.

---

## TEST-DB-012 — Payment/Total Equality

Complete several sales, then verify `SUM(payments.amount_cents WHERE status = COMPLETED) = sales.total_cents` for each.

Expected:

Always equal; any artificial mismatch is rejected before commit.

---

## TEST-DB-013 — Line Arithmetic Constraints

For several completed sale items, verify `line_subtotal_cents = listed_price_cents × quantity` and `line_total_cents = sold_price_cents × quantity`.

Expected:

Always holds; an artificially inconsistent value is rejected before commit.

---

## TEST-DB-014 — Reversal Movement Uniqueness

Attempt to insert a second `VOID_REVERSAL` movement with the same `reverses_movement_id` as an existing one.

Expected:

Rejected by the `reverses_movement_id UNIQUE when present` constraint — a single `SALE` movement can be reversed at most once.

---

## TEST-DB-016 — Network/Cloud-Sync Database Path Warning

Configure (or simulate) the database directory as a known cloud-sync folder or a UNC network path.

Expected:

Support & Diagnostics surfaces a clear warning that crash-safety/locking guarantees are not assured on this filesystem (`DATA_MODEL.md` Section 54); this is a documented warning, not a runtime block, since detection cannot be exhaustive.

---

## TEST-DB-015 — Void Field Consistency

Attempt to persist a sale with `status = VOIDED` but a null `voided_at` or null `void_reason`, and separately a sale with `status = COMPLETED` but a non-null `voided_at`.

Expected:

Both are rejected; `voided_at`/`void_reason` are required together with, and only with, `status = VOIDED`.

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

Because the database is already an initialized database containing business data, each such migration is gated on a successfully created and verified pre-migration backup — with its evidence durably recorded — before its changes are applied (`REQ-BACKUP-008`, `TEST-BACKUP-012`); a failure of that backup, its verification, or the recording of its evidence must prevent the migration and fail startup safely (`TEST-BACKUP-013`).

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

# 26A. Concurrency Tests

V1 runs on one machine with a shared login, but Section 55 of `DATA_MODEL.md` requires database-level correctness that does not rely solely on "only one UI action happens at a time." These tests exercise that.

## TEST-CONC-001 — Concurrent Distinct Checkouts

Submit two different, valid checkout requests for different products at effectively the same time (e.g., from two rapid IPC calls).

Expected:

Both sales complete independently with distinct Sale IDs and receipt numbers; neither corrupts the other's inventory or totals.

---

## TEST-CONC-002 — Concurrent Stock Adjustment and Checkout

Simultaneously submit a manual inventory adjustment and a checkout for the same product, where the adjustment would make the checkout invalid (or vice versa) depending on ordering.

Expected:

SQLite's write-transaction serialization (`BEGIN IMMEDIATE`) resolves the two operations one at a time in some order; whichever runs second sees the other's committed effect, and `quantity_on_hand` never goes negative regardless of ordering.

---

## TEST-CONC-003 — Concurrent Receipt-Number Allocation

Submit multiple valid checkout requests concurrently.

Expected:

Every completed sale receives a unique, sequential receipt number with no duplicates and no gaps caused by a race condition (a gap caused by a genuinely rolled-back attempt remains acceptable per Section 29 of `DATA_MODEL.md`).

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

## TEST-BACKUP-002A — Backup Consistency Under Concurrent Writes (WAL Safety)

Start a backup (automatic, manual, or pre-migration) and, while it is in progress, complete a checkout transaction on the live database.

Expected:

- The resulting backup file is a transactionally consistent snapshot: it reflects either the state entirely before or entirely after the concurrent checkout, never a partial/torn mix of the two.
- The backup mechanism does not perform a raw copy of the live main `.sqlite` file while a connection/WAL activity could still be active (`DATA_MODEL.md` Section 54); a mere `wal_checkpoint` immediately followed by a file copy, with no protection against a writer opening a new transaction during the copy, is not sufficient and must not be the implemented mechanism.
- The live/operational database itself is completely unaffected by the backup process.

This test applies identically to automatic backups, manual backups, pre-migration backups, and the pre-restore recovery copy (`TEST-BACKUP-018`).

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
- The verified pre-migration backup and the original (unmigrated) database file remain intact and available; the application does not assume or perform an automatic binary/version rollback to reach this state.
- Recovery guidance and a stable error code are shown, directing the user toward a corrective release or the documented restore procedure (`UPDATE_RELEASE_STRATEGY.md` Section 30).

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

## TEST-BACKUP-020 — Off-Device vs. Local-Disk Backup Distinction

Create a same-disk automatic backup and a manually configured off-device backup.

Expected:

`backup_records.location_kind` correctly distinguishes the two; backup-health display never describes the same-disk backup as protecting against disk/device loss, and describes the off-device backup as the one that does.

---

## TEST-BACKUP-017 — Full Table-Set Restore Verification (General Fidelity Contract)

Populate every table listed in `DATA_MODEL.md` Section 52 (`products`, `customers`, `sales`, `sale_items`, `payments`, `inventory_movements`, `settings`, `google_sheet_export_jobs`, `checkout_requests`, `counters`, `audit_events`, `backup_records`, `schema_migrations`) with representative rows, back up, then restore into a test environment.

Expected:

The selected backup's contents restore faithfully: every canonical table's row count and content match the source exactly after restore — including the receipt-number counter, the `audit_sequence` counter, durable audit history, and every setting — not just the subset already covered by `TEST-BACKUP-004` through `TEST-BACKUP-006`. No row is appended, rewritten, or deleted in any table.

The sole V1 exception: when the restore triggers the restore-specific Google credential quarantine (`DATA_MODEL.md` Section 52A step 7; `ARCHITECTURE.md` Section 27.4), the **only** permitted post-restore SQLite delta is the single `settings` row `google_restore_reconnect_required`. Even then: no audit event is appended merely because quarantine was entered — `audit_events` and `counters.audit_sequence` still match the backup exactly — and every other setting, Google or otherwise, still matches the backup exactly. This is not a general permission for runtime/system-metadata mutation; it is this one named key, in this one named circumstance. `TEST-BACKUP-022` is the concrete integration scenario that proves this exact exception end-to-end through the production restore/Google lifecycle.

---

## TEST-BACKUP-022 — Google-Quarantine Branch of TEST-BACKUP-017

Back up a database with an active Google configuration (connected, a spreadsheet configured). Before restoring, change the external encrypted credential so it no longer safely matches the backup's Google configuration (e.g., connect a different account). Restore that backup through the production restore lifecycle (coordinator, swap, reopen, validate, `prepareRestoredCredentialState`).

Expected:

The restore triggers the quarantine named as `TEST-BACKUP-017`'s sole exception. Comparing the final live restored database against the selected backup, every canonical table and every setting other than `google_restore_reconnect_required` matches exactly, per `TEST-BACKUP-017`; `google_restore_reconnect_required` is absent from the backup and `true` in the restored database; no `GOOGLE_CONFIGURATION_CHANGED` or other audit event is appended merely for entering quarantine.

---

## TEST-BACKUP-018 — Restore Safety: Newer Local Data Detected

Take a backup, then complete additional sales, then attempt to restore the earlier backup. Include a variant where the system clock moves backward between the backup and the additional sales, and a variant where a later sale's `completed_at` coincides exactly with the candidate's latest sale.

Expected:

The application identifies the completed sales the current database holds that the candidate does not, by immutable Sale ID — not by comparing `completed_at` timestamps, so a clock moving backward or two sales sharing a timestamp cannot hide a sale — warns with the specific transaction count/date range that would be lost, and does not proceed without explicit confirmation; a pre-restore recovery copy of the current database is preserved regardless of the outcome (`DATA_MODEL.md` Section 52A).

---

## TEST-BACKUP-019 — Restore Validation Failure Falls Back to Pre-Restore Copy

Force the restored database to fail validation after replacement (e.g., simulate a truncated/corrupted backup file).

Expected:

The application restores the preserved pre-restore copy and reports a stable error code rather than leaving the database in the failed-validation state.

---

## TEST-BACKUP-021 — Generic Whole-Database Restore Confirmation

Take a backup with no sales completed after it, then change only non-sale business state (for example void an existing sale, adjust inventory, edit a product or customer, or change the tax rate), then attempt to restore the backup. Separately, attempt to restore a backup against which nothing changed at all.

Expected:

The first Restore Database attempt always returns a required confirmation, even though no completed sale would be lost — restore is never a silent or default-confirmed action. The confirmation states that the operation replaces the current database with the selected backup. A stale confirmation (anything in the material restore-state fingerprint changed since the warning was issued) is rejected and a fresh confirmation is issued; a confirmation reused when only secondary bookkeeping (Google export-job delivery state, Google connectivity settings, automatic-backup records, or backup/Google audit events) changed in between remains valid.

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

No plaintext password; a salted, memory-hard hash is used, not a fast unsalted hash.

---

## TEST-AUTH-005 — First-Run Credential Setup

Launch the application with no shared credential ever created.

Expected:

A setup (not login) screen is shown; the POS home screen is unreachable until a password is created and confirmed; an `AUTH_CREDENTIAL_CHANGED` audit event is recorded.

---

## TEST-AUTH-006 — Password Change

Change the shared password from Settings using the correct current password, then log out and back in with the new password.

Expected:

Change succeeds, the old password no longer works, the new one does, and an `AUTH_CREDENTIAL_CHANGED` audit event is recorded.

---

## TEST-AUTH-007 — Password Change Rejected With Wrong Current Password

Attempt to change the password while entering an incorrect current password.

Expected:

Rejected; the existing password remains unchanged.

---

## TEST-AUTH-008 — Local Recovery Does Not Require Internet or Online Identity

Exercise the documented local recovery procedure for a forgotten password.

Expected:

Recovery succeeds without any email/SMS/cloud-identity step and without internet access; business data is untouched; the application re-enters first-run setup afterward.

---

## TEST-AUTH-009 — Brute-Force Backoff Without Lockout

Submit repeated incorrect passwords in quick succession, then eventually submit the correct password.

Expected:

Each additional failure increases the delay before the next attempt is accepted; the correct password is always eventually accepted once its delay elapses — the shared login is never permanently locked.

---

## TEST-AUTH-010 — Restore Does Not Change Current Credential

Restore a SQLite backup created under a different shared password than the one currently configured.

Expected:

The restore does not change the currently configured login credential, because it is stored independently of the SQLite `settings` table.

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

Inspect renderer bundle and all runtime IPC traffic to the renderer.

Expected:

No Google secret or token — no OAuth refresh/access token, authorization code,
PKCE verifier, ID token, raw token response, or developer OAuth client
configuration.

---

## TEST-SEC-006 — Secrets in Git

Repository scan.

Expected:

No committed secrets.

---

## TEST-SEC-007 — Secrets in Logs

Trigger Google OAuth authorization failures, token-refresh failures, and
export errors.

Expected:

Logs contain no credentials or tokens — no refresh/access token, authorization
code, PKCE verifier, ID token, raw OAuth response, or `Authorization` header.

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

## HW-WIN-001 — Windows 10 Validation

Install and exercise the full acceptance matrix (Section 37) on a representative Windows 10 machine.

Expected:

Install, launch, checkout, printing, scanning, backup, and update behave identically to the documented requirements.

---

## HW-WIN-002 — Windows 11 Validation

Install and exercise the full acceptance matrix (Section 37) on a representative Windows 11 machine.

Expected:

Install, launch, checkout, printing, scanning, backup, and update behave identically to the documented requirements.

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
| Clover-approved / local-commit-failure evidence and warning | PASS |
| Reconciliation queue resolution and safe retry | PASS |
| Checkout drift detection and rejection | PASS |
| Restore safety: newer-data detection, confirmation, pre-restore copy | PASS |
| SQLite durability configuration (WAL/FULL/busy-timeout) verified under crash | PASS |
| Windows 10 explicit validation | PASS |
| Windows 11 explicit validation | PASS |
| Update feed/package/publisher tamper rejection | PASS |
| Formula injection neutralized in CSV and Google Sheets exports | PASS |
| Google Sheets stale-write/reversed-ordering race resolved | PASS |
| Shared-credential lifecycle (setup, change, recovery, backoff) | PASS |

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
- A Clover-approved card charge followed by a local commit failure is durably recorded, clearly warned, safely retryable, and tracked to resolution without ever appearing as a completed sale.
- Checkout drift between review and commit is detected and rejected rather than silently committed.
- Restore safety (pre-restore copy, newer-data detection, required confirmation) has been demonstrated, not merely assumed.
- SQLite durability configuration has been verified under simulated crash/abrupt-termination conditions.
- The Google Sheets stale-write/reversed-response-ordering race has been demonstrated to never regress a `VOIDED` row back to `COMPLETED`.
- Every MUST requirement in `PRODUCT_REQUIREMENTS.md` has at least one entry in the full traceability matrix (Section 57).

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
- No automatic binary/schema rollback is assumed or performed; recovery uses a corrective release or the documented restore procedure.

---

## TEST-UPDATE-014 — Tampered Update Feed Rejected

Serve a feed response with an invalid signature or tampered metadata.

Expected:

The client rejects it and does not install anything; the currently installed version continues operating normally.

---

## TEST-UPDATE-015 — Wrong Signing Publisher Rejected

Offer a package signed by a certificate that does not match the expected publisher identity.

Expected:

Installation is refused before any files are replaced.

---

## TEST-UPDATE-016 — Corrupted/Partial Package Rejected

Offer a truncated or checksum-mismatched package.

Expected:

Verification fails before installation begins; the currently installed version remains in use.

---

## TEST-UPDATE-017 — Certificate Rotation

Sign a release with a newly rotated, legitimate publisher certificate.

Expected:

The client trusts it through normal chain-of-trust verification without requiring a client-side code change, while a certificate that does not chain to the trusted publisher identity is still rejected.

---

## TEST-UPDATE-018 — Unsupported Signed-Version Downgrade Rejected

Offer a validly signed but older package whose schema is incompatible with the currently migrated database.

Expected:

The downgrade is refused outside of the documented recovery procedure (`UPDATE_RELEASE_STRATEGY.md` Section 31); the application does not silently apply an incompatible older version.

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

## TEST-REL-011 — Graceful Close During Active Sale, Backup, Restore, or Migration

Request application close while, in separate runs: (a) a checkout transaction is in flight, (b) an automatic backup is writing, (c) a restore is in progress, and (d) a migration is applying.

Expected:

In each case the in-progress SQLite operation is allowed to reach a safe commit/rollback boundary (or the close is deferred until it does) before the process exits; no partial sale, partial backup file, half-restored database, or half-applied migration is left behind, and the next launch finds a fully consistent, recoverable state.

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

## TEST-EXPORT-007 — Formula Injection Neutralization (CSV)

Create a customer and a product each with a name beginning with `=`, `+`, `-`, and `@`, then export Customers and Products CSV.

Expected:

Every such value is written neutralized (e.g., leading apostrophe) so opening the CSV in a spreadsheet application never executes it as a formula.

---

# 56. Durable Audit Tests

These tests validate `REQ-AUDIT-*`.

## TEST-AUDIT-001 — Required Business and System Actions

Complete and void a sale, override a price, adjust inventory, change tax/business settings, connect and disconnect a Google account, run successful and failed backups, execute a migration, and install an update.

Expected:

Each required action produces an appropriately typed durable local audit event with outcome and safe context. Google account connect, disconnect, re-authorization, and spreadsheet provisioning all use the single `GOOGLE_CONFIGURATION_CHANGED` type and carry no OAuth secrets in their details.

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

## TEST-AUDIT-005 — Durable Migration-Failure Audit

Force a schema migration to fail after its pre-migration backup has already been verified.

Expected:

A `MIGRATION_STARTED` event (`outcome = SUCCESS`, describing only that the start was recorded) and a subsequent `MIGRATION_FAILED` event (`outcome = FAILURE`) both exist and survive restart; if the database becomes briefly unwritable during the failure, the diagnostic log preserves the same evidence until the durable audit write can be confirmed, and the application never claims a successful audit write that did not happen.

---

## TEST-AUDIT-006 — Monotonic Sequence Survives Clock Anomaly

Record several audit events, then move the system clock backward, then record more events.

Expected:

Each event's `sequence` value strictly increases in true chronological order of creation regardless of what `occurred_at` reports; ordering by `sequence` never contradicts the real order of events.

---

## TEST-AUDIT-007 — `id` and `sequence` Are Independent Fields

Insert several audit events and inspect the schema and resulting rows.

Expected:

- `id` (TEXT) remains the sole `PRIMARY KEY` and is a stable UUID-style identity, independent of insertion order.
- `sequence` (INTEGER) is `NOT NULL` and `UNIQUE`, but is not itself a primary key — the schema does not declare two primary keys.
- Every `sequence` value traces back to an increment of `counters.audit_sequence` performed in the same transaction as the audit-event insert (Sections 29–30, 36A).

---

## TEST-AUDIT-008 — Sequence Allocation Rolls Back With Its Transaction

Force a transactional business change (e.g., a price override) to fail after its `audit_sequence` counter increment but before the transaction commits.

Expected:

The counter increment rolls back with the rest of the transaction — the next successfully committed audit event receives the next `sequence` value in order, with no permanently consumed/skipped value and no duplicate, mirroring the existing `receipt_number` rollback behavior (Section 29).

---

# 56A. Operational Defaults Tests

These verify the concrete V1 defaults fixed in `ARCHITECTURE.md` Section 49A, so tests remain deterministic rather than depending on an unstated value.

## TEST-DEFAULT-001 — Automatic Backup Cadence Default

With no cadence explicitly configured, advance the clock across a day boundary.

Expected:

An automatic backup runs at the documented default (03:00 local business time).

---

## TEST-DEFAULT-002 — Stale EXPORTING Timeout Default

Force a job into `EXPORTING` and hold it there past the documented 5-minute default without an update, then run a worker cycle/restart.

Expected:

The job is recovered to `PENDING` once the default timeout has elapsed, and not before.

---

## TEST-DEFAULT-003 — Export Retry Backoff Default

Force repeated export failures and record the delay between attempts.

Expected:

Backoff starts at 30 seconds and doubles up to the documented 30-minute cap.

---

## TEST-DEFAULT-004 — Retry-Exhausted Terminal Behavior Default

Force 10 consecutive export failures for the same job.

Expected:

The job becomes `FAILED` (still manually retryable) rather than continuing to retry indefinitely or being silently abandoned.

---

## TEST-DEFAULT-005 — Low-Disk Threshold Defaults

Simulate free disk space just above and just below the documented 2 GB warning and 500 MB critical thresholds.

Expected:

Health status transitions to `WARNING`/`CRITICAL` at exactly the documented defaults.

---

## TEST-DEFAULT-006 — Clock-Jump Threshold Default

Move the system clock by an amount just below and just above the documented 5-minute significant-change threshold.

Expected:

Only the change exceeding the threshold is logged/warned as significant.

---

# 57. Full V1 Traceability Matrix

This matrix supersedes the prior partial matrix (which covered only Void/Audit/Export/Update/Diagnostics/Backup/Health/App-lifecycle requirements against 52 of the 155 MUST requirements that existed at the time of the pre-implementation audit). It maps every MUST requirement in the current `PRODUCT_REQUIREMENTS.md` — 184 as of this remediation — to at least one primary verification path. A test listed as "primary" for a requirement may also validate others; this table records the strongest single link, not an exhaustive cross-reference.

| Requirement | Primary verification |
|---|---|
| `REQ-PROD-001` | `TEST-PROD-001` |
| `REQ-PROD-002` | `TEST-PROD-007` |
| `REQ-PROD-003` | `TEST-PROD-008`, `TEST-PROD-006` |
| `REQ-PROD-004` | `TEST-PROD-005` |
| `REQ-PROD-005` | `TEST-OFF-003`, `TEST-PERF-001` |
| `REQ-PROD-006` | `TEST-SCAN-001` |
| `REQ-PROD-007` | `TEST-PROD-009` |
| `REQ-PROD-008` | `TEST-PROD-003`, `TEST-PROD-004`, `TEST-PROD-004A` |
| `REQ-INV-001` | `TEST-INV-001` |
| `REQ-INV-002` | `TEST-INV-001`, `TEST-INV-002` |
| `REQ-INV-003` | `TEST-ATOMIC-001`, `TEST-ATOMIC-004` |
| `REQ-INV-004` | `TEST-INV-003`, `ACCEPT-009` |
| `REQ-INV-005` | `TEST-PROD-002`, `TEST-INV-005` |
| `REQ-SCAN-001` | `HW-SCAN-001` |
| `REQ-SCAN-002` | `TEST-SCAN-001` |
| `REQ-SCAN-003` | `TEST-SCAN-002` |
| `REQ-SCAN-004` | `TEST-SCAN-005`, `TEST-OFF-004` |
| `REQ-SALE-001` | `TEST-CART-002` |
| `REQ-SALE-002` | `TEST-CART-003` |
| `REQ-SALE-003` | `TEST-CART-004` |
| `REQ-SALE-004` | `TEST-CART-005` |
| `REQ-SALE-005` | `TEST-CART-010`, `ACCEPT-002` |
| `REQ-SALE-006` | `TEST-DISC-001`, `TEST-DISC-002` |
| `REQ-SALE-007` | `ACCEPT-001`, `ACCEPT-002` |
| `REQ-SALE-008` | `TEST-ATOMIC-001`, `ACCEPT-001` |
| `REQ-SALE-009` | `TEST-PROD-006`, `ACCEPT-010` |
| `REQ-SALE-010` | `TEST-IDEMP-001` through `TEST-IDEMP-004` |
| `REQ-SALE-011` | `TEST-CART-001` |
| `REQ-SALE-012` | `TEST-CART-006`, `TEST-IDEMP-008` |
| `REQ-SALE-013` | `TEST-CART-007`, `TEST-CART-008`, `TEST-CART-009` |
| `REQ-SALE-014` | `TEST-IDEMP-006`, `TEST-IDEMP-007`, `TEST-IDEMP-008`, `TEST-CARD-008` |
| `REQ-RECNO-001` | `TEST-RECNO-001` |
| `REQ-RECNO-002` | `TEST-RECNO-002` |
| `REQ-RECNO-003` | `TEST-RECNO-004` |
| `REQ-RECNO-004` | `TEST-RECNO-001` |
| `REQ-TAX-001` | `TEST-TAX-002` |
| `REQ-TAX-002` | `TEST-TAX-001` |
| `REQ-TAX-003` | `TEST-TAX-002` |
| `REQ-TAX-004` | `TEST-MONEY-001` |
| `REQ-TAX-005` | `TEST-TAX-003`, `TEST-TAX-005` |
| `REQ-PAY-001` | `TEST-CASH-001` |
| `REQ-PAY-002` | `TEST-CARD-001` |
| `REQ-PAY-003` | `TEST-CARD-004` |
| `REQ-PAY-004` | `TEST-CARD-003` |
| `REQ-PAY-005` | `TEST-DB-012` |
| `REQ-RECONCILE-001` | `TEST-CARD-005A`, `TEST-CARD-005`, `TEST-CARD-008` |
| `REQ-RECONCILE-002` | `TEST-CARD-005`, `TEST-CARD-005B` |
| `REQ-RECONCILE-003` | `TEST-CARD-005` |
| `REQ-RECONCILE-004` | `TEST-CARD-007`, `TEST-CARD-005C` |
| `REQ-RECONCILE-005` | `TEST-CARD-005` |
| `REQ-RECONCILE-006` | `TEST-CARD-006` |
| `REQ-CUST-001` | `TEST-CUST-001`, `TEST-CUST-008` |
| `REQ-CUST-007` | `TEST-CUST-009` |
| `REQ-CUST-002` | `TEST-CUST-004` |
| `REQ-CUST-003` | `TEST-CUST-002`, `TEST-CUST-003` |
| `REQ-CUST-004` | `TEST-CUST-005` |
| `REQ-CUST-005` | `TEST-CUST-007` |
| `REQ-CUST-006` | `TEST-OFF-004`, `TEST-OFF-005` |
| `REQ-REC-001` | `TEST-PRINT-001` |
| `REQ-REC-002` | `TEST-PRINT-007` |
| `REQ-REC-003` | `TEST-PRINT-005` |
| `REQ-REC-004` | `TEST-PRINT-003` |
| `REQ-REC-005` | `TEST-PRINT-002`, `ACCEPT-007` |
| `REQ-PRINT-001` | `TEST-PRINT-001`, `HW-PRINT-001` |
| `REQ-PRINT-002` | `HW-PRINT-001` |
| `REQ-PRINT-005` | `TEST-PRINT-004`, `ACCEPT-007` |
| `REQ-HIST-001` | `TEST-HIST-001` |
| `REQ-HIST-002` | `TEST-HIST-001` |
| `REQ-HIST-003` | `TEST-HIST-002`, `TEST-HIST-003`, `TEST-HIST-006` |
| `REQ-HIST-004` | `TEST-HIST-005` |
| `REQ-REPORT-001` | `TEST-REPORT-001` |
| `REQ-REPORT-002` | `TEST-REPORT-002` |
| `REQ-REPORT-003` | `TEST-REPORT-003` |
| `REQ-REPORT-004` | `TEST-REPORT-004` |
| `REQ-REPORT-005` | `TEST-REPORT-005` |
| `REQ-REPORT-006` | `TEST-REPORT-006` |
| `REQ-REPORT-007` | `TEST-REPORT-007`, `TEST-OFF-011` |
| `REQ-REPORT-008` | `TEST-HIST-006` |
| `REQ-REPORT-009` | `TEST-VOID-004` |
| `REQ-OFF-001` | `TEST-OFF-006`, `ACCEPT-003` |
| `REQ-OFF-002` | `TEST-OFF-001` |
| `REQ-OFF-003` | `TEST-OFF-003` |
| `REQ-OFF-004` | `TEST-OFF-004` |
| `REQ-OFF-005` | `TEST-OFF-005` |
| `REQ-OFF-006` | `TEST-OFF-010`, `TEST-OFF-011` |
| `REQ-OFF-007` | `TEST-OFF-009` |
| `REQ-OFF-008` | `TEST-OFF-012`, `ACCEPT-004` |
| `REQ-OFF-009` | `TEST-OFF-013` |
| `REQ-GSHEET-001` | `TEST-GSHEET-001`, `TEST-ATOMIC-005` |
| `REQ-GSHEET-002` | `TEST-GSHEET-018` |
| `REQ-GSHEET-003` | `TEST-GSHEET-009` through `TEST-GSHEET-013` |
| `REQ-GSHEET-004` | `TEST-GSHEET-005` |
| `REQ-GSHEET-005` | `TEST-GSHEET-006`, `TEST-GSHEET-007` |
| `REQ-GSHEET-006` | `TEST-GSHEET-008` |
| `REQ-GSHEET-007` | `TEST-GSHEET-014`, `TEST-GSHEET-015` |
| `REQ-GSHEET-008` | `TEST-GSHEET-022`, `TEST-GSHEET-023` |
| `REQ-GSHEET-009` | `TEST-GSHEET-002` |
| `REQ-GSHEET-010` | `TEST-GSHEET-003` |
| `REQ-GSHEET-011` | `TEST-HIST-005` |
| `REQ-GSHEET-013` | `TEST-SEC-005`, `TEST-SEC-007`, `TEST-GSHEET-032`, `TEST-GSHEET-034`, `TEST-GSHEET-035` |
| `REQ-GSHEET-014` | `TEST-GSHEET-025` |
| `REQ-GSHEET-015` | `TEST-GSHEET-020`, `TEST-GSHEET-021` |
| `REQ-GSHEET-016` | `TEST-GSHEET-026` through `TEST-GSHEET-035`, `TEST-GSHEET-037`, `TEST-GSHEET-057` |
| `REQ-GSHEET-017` | `TEST-GSHEET-039`, `TEST-GSHEET-040`, `TEST-GSHEET-041`, `TEST-GSHEET-042`, `TEST-GSHEET-047`, `TEST-GSHEET-048`, `TEST-GSHEET-049`, `TEST-GSHEET-050`, `TEST-GSHEET-051`, `TEST-GSHEET-052` |
| `REQ-GSHEET-018` | `TEST-GSHEET-038`, `TEST-GSHEET-040`, `TEST-GSHEET-044`, `TEST-GSHEET-045`, `TEST-GSHEET-049`, `TEST-GSHEET-050`, `TEST-GSHEET-052` |
| `REQ-GSHEET-019` | `TEST-GSHEET-036` |
| `REQ-GSHEET-020` | `TEST-GSHEET-053`, `TEST-GSHEET-054`, `TEST-GSHEET-055`, `TEST-GSHEET-056` |
| `REQ-DB-001` | `TEST-DB-001` |
| `REQ-DB-002` | `TEST-DB-001`, `TEST-DB-002` |
| `REQ-DB-003` | `TEST-ATOMIC-001` |
| `REQ-DB-004` | `TEST-DB-003`, `TEST-DB-010` |
| `REQ-DB-005` | `TEST-DB-007`, `TEST-DB-008` |
| `REQ-DB-006` | `TEST-SEC-001`, `TEST-SEC-002` |
| `REQ-DB-007` | `TEST-CRASH-002`, `TEST-REL-003` |
| `REQ-DB-008` | `TEST-DB-016` |
| `REQ-DB-009` | `TEST-DB-010` |
| `REQ-BACKUP-001` | `TEST-BACKUP-001` through `TEST-BACKUP-003` |
| `REQ-BACKUP-002` | `TEST-BACKUP-002`, `TEST-BACKUP-002A`, `TEST-BACKUP-003` |
| `REQ-BACKUP-003` | `TEST-BACKUP-016` |
| `REQ-BACKUP-004` | `TEST-BACKUP-003` through `TEST-BACKUP-006` |
| `REQ-BACKUP-005` | `TEST-BACKUP-008`, `TEST-BACKUP-009` |
| `REQ-BACKUP-006` | `TEST-BACKUP-010` |
| `REQ-BACKUP-007` | `TEST-BACKUP-009`, `TEST-BACKUP-011` |
| `REQ-BACKUP-008` | `TEST-BACKUP-012`, `TEST-BACKUP-013` |
| `REQ-BACKUP-009` | `TEST-BACKUP-015` |
| `REQ-BACKUP-010` | `TEST-BACKUP-020` |
| `REQ-BACKUP-011` | `TEST-BACKUP-017` through `TEST-BACKUP-019`, `TEST-BACKUP-021`, `TEST-BACKUP-022` |
| `REQ-AUTH-001` | `TEST-AUTH-001` |
| `REQ-AUTH-002` | `TEST-AUTH-003` |
| `REQ-AUTH-003` | `TEST-AUTH-004` |
| `REQ-AUTH-004` | `TEST-AUTH-005` |
| `REQ-AUTH-005` | `TEST-AUTH-006`, `TEST-AUTH-007` |
| `REQ-AUTH-006` | `TEST-AUTH-008` |
| `REQ-AUTH-007` | `TEST-AUTH-010` |
| `REQ-AUTH-008` | `TEST-AUTH-009` |
| `REQ-SEC-001` | `TEST-SEC-001` |
| `REQ-SEC-002` | `TEST-SEC-002` |
| `REQ-SEC-003` | `TEST-SEC-004`, `TEST-CART-009` |
| `REQ-SEC-004` | `TEST-SEC-006` |
| `REQ-SEC-005` | `TEST-SEC-003`, `TEST-GSHEET-027`, `TEST-GSHEET-029` |
| `REQ-REL-001` | `TEST-DB-001`, `ACCEPT-004` |
| `REQ-REL-002` | `TEST-CRASH-001` |
| `REQ-REL-003` | `TEST-IDEMP-001` |
| `REQ-REL-004` | `TEST-GSHEET-017`, `TEST-PRINT-002` |
| `REQ-REL-005` | `TEST-ATOMIC-002` |
| `REQ-PERF-003` | `TEST-PERF-003` |
| `REQ-PKG-001` | `TEST-INSTALL-001` |
| `REQ-PKG-002` | `TEST-INSTALL-002`, `TEST-INSTALL-003`, `TEST-INSTALL-004` |
| `REQ-PKG-003` | `TEST-INSTALL-005` |
| `REQ-VOID-001` | `TEST-VOID-001`, `TEST-VOID-002` |
| `REQ-VOID-002` | `TEST-VOID-001`, `TEST-VOID-005` |
| `REQ-VOID-003` | `TEST-VOID-003`, `TEST-VOID-010` |
| `REQ-VOID-004` | `TEST-VOID-006` |
| `REQ-VOID-005` | `TEST-VOID-004` |
| `REQ-VOID-006` | `TEST-VOID-001`, `TEST-VOID-010` |
| `REQ-VOID-007` | `TEST-VOID-007`, `TEST-GSHEET-020`, `TEST-GSHEET-021` |
| `REQ-VOID-008` | `TEST-VOID-008`, `TEST-VOID-009` |
| `REQ-AUDIT-001` | `TEST-AUDIT-002` |
| `REQ-AUDIT-002` | `TEST-AUDIT-001` |
| `REQ-AUDIT-003` | `TEST-AUDIT-003` |
| `REQ-AUDIT-004` | `TEST-AUDIT-004`, `TEST-AUDIT-005`, `TEST-VOID-010` |
| `REQ-AUDIT-005` | `TEST-AUDIT-006`, `TEST-AUDIT-007`, `TEST-AUDIT-008` |
| `REQ-EXPORT-001` | `TEST-EXPORT-001` through `TEST-EXPORT-004` |
| `REQ-EXPORT-002` | `TEST-EXPORT-006` |
| `REQ-EXPORT-003` | `TEST-EXPORT-005` |
| `REQ-EXPORT-004` | `TEST-EXPORT-007` |
| `REQ-UPDATE-001` | `TEST-UPDATE-010` |
| `REQ-UPDATE-002` | `TEST-UPDATE-012` |
| `REQ-UPDATE-003` | `TEST-UPDATE-003` |
| `REQ-UPDATE-004` | `TEST-UPDATE-004`, `TEST-UPDATE-005` |
| `REQ-UPDATE-005` | `TEST-UPDATE-004`, `TEST-REL-009` |
| `REQ-UPDATE-006` | `TEST-UPDATE-001`, `TEST-UPDATE-002` |
| `REQ-UPDATE-007` | `TEST-UPDATE-006`, `TEST-UPDATE-009` |
| `REQ-UPDATE-008` | `TEST-BACKUP-012`, `TEST-BACKUP-013`, `TEST-UPDATE-007`, `TEST-UPDATE-008` |
| `REQ-UPDATE-009` | `TEST-UPDATE-013` |
| `REQ-UPDATE-010` | `TEST-UPDATE-010`, `TEST-UPDATE-014` through `TEST-UPDATE-018` |
| `REQ-DIAG-001` | `TEST-DIAG-007` |
| `REQ-DIAG-002` | `TEST-DIAG-009` |
| `REQ-DIAG-003` | `TEST-DIAG-001`, `TEST-DIAG-002`, `TEST-DIAG-006` |
| `REQ-DIAG-004` | `TEST-DIAG-004`, `TEST-DIAG-008` |
| `REQ-DIAG-005` | `TEST-DIAG-003`, `TEST-DIAG-005` |
| `REQ-DIAG-006` | `TEST-DIAG-007`, `TEST-UPDATE-002`, `TEST-REL-007` |
| `REQ-HEALTH-001` | `TEST-DIAG-007`, `TEST-BACKUP-011`, `TEST-REL-006`, `TEST-REL-007` |
| `REQ-HEALTH-002` | `TEST-REL-008`, `TEST-DEFAULT-006` |
| `REQ-HEALTH-003` | `TEST-REL-002` |
| `REQ-HEALTH-004` | `TEST-CRASH-001` through `TEST-CRASH-005`, `TEST-REL-003`, `TEST-REL-004` |
| `REQ-HEALTH-005` | `TEST-OFF-001` through `TEST-OFF-013`, `TEST-NET-003`, `TEST-REL-005` |
| `REQ-APP-001` | `TEST-REL-001` |
| `REQ-APP-002` | `TEST-BACKUP-014`, `TEST-UPDATE-004`, `TEST-REL-009`, `TEST-REL-010`, `TEST-REL-011` |

Every MUST requirement above maps to at least one test. Where a requirement is already exercised end-to-end by a `Production Acceptance` (`ACCEPT-*`) or hardware (`HW-*`) scenario, that scenario is cited alongside or instead of a narrower unit/integration test.

---

# 58. Final Verification Rule

V1 verification succeeds only when sales and voids remain correct, durable, non-duplicated, recoverable, and supportable through offline use, external failures, updates, maintenance, restarts, and imperfect hardware without exposing sensitive data.
