# Go Phones POS — Data Model

## 1. Purpose

This document defines the V1 data model for Go Phones POS.

The model is designed around the following principles:

- SQLite is the authoritative local database.
- Core sales must work offline.
- Sale completion must be atomic.
- Historical transactions must remain immutable.
- Inventory changes must be auditable.
- Google Sheets export must be asynchronous and recoverable.
- Monetary calculations must be stored safely using integer cents.
- External integrations must not be required for local transaction integrity.

This document defines the logical schema.

The exact SQL migrations will be created later from this specification.

---

# 2. Data Model Overview

Primary entities:

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

High-level relationships:

```text
products
   │
   ├──────────────┐
   │              │
   ▼              ▼
sale_items   inventory_movements
   │              │
   └──────┬───────┘
          │
          ▼
        sales
          │
      ┌───┴────┐
      ▼        ▼
 customers   payments
      │
      │
      └──────────── optional relationship

sales
  │
  ▼
google_sheet_export_jobs
```

---

# 3. ID Strategy

Internal database entities should use stable unique identifiers.

For business-critical entities such as:

- Sales
- Customers
- Products
- Payments
- Export jobs

the preferred identifier is a UUID-style text identifier.

Example:

```text
550e8400-e29b-41d4-a716-446655440000
```

Benefits:

- Stable across future synchronization.
- Safe for Google Sheets export.
- Avoids collision when future multi-device support is introduced.
- Separates technical identity from human-facing receipt numbers.

SQLite may still use indexes internally for performance.

---

# 4. Timestamp Strategy

Timestamps should be stored consistently.

Preferred format:

```text
ISO 8601 UTC timestamp
```

Example:

```text
2026-09-06T20:14:52.321Z
```

Where local business date/time is needed, the application converts the stored timestamp for display.

The business location timezone should be configurable.

Initial store timezone:

```text
America/Chicago
```

because Go Phones - Alvin is located in Alvin, Texas.

Historical records must preserve their transaction timestamps.

---

# 5. Money Representation

All monetary values must be stored as integer cents.

Correct:

```text
59999
```

meaning:

```text
$599.99
```

Incorrect:

```text
599.99 FLOAT
```

Fields should use names such as:

```text
selling_price_cents
cost_price_cents
subtotal_cents
discount_cents
tax_cents
total_cents
```

This avoids floating-point rounding errors.

---

# 6. Percentage Representation

Tax rates should not be stored as floating-point percentages.

Preferred representation:

**basis points**

Example:

```text
825
```

means:

```text
8.25%
```

Formula:

```text
tax_rate_bps / 100 = percentage
```

Examples:

```text
825  = 8.25%
600  = 6.00%
1000 = 10.00%
```

Historical sales must preserve the tax rate applied at transaction time.

---

# 7. Products Table

Table:

```text
products
```

Purpose:

Stores the current sellable phone inventory catalog.

## Fields

```text
id
sku
barcode
name
brand
model
condition
cost_price_cents
selling_price_cents
quantity_on_hand
low_stock_threshold
is_active
created_at
updated_at
```

---

## Field Definitions

### id

Type:

```text
TEXT
```

Required:

Yes

Purpose:

Immutable internal Product ID.

Constraint:

```text
PRIMARY KEY
```

---

### sku

Type:

```text
TEXT
```

Required:

No

Purpose:

Store-defined stock keeping unit.

Constraint:

Should be unique when present.

---

### barcode

Type:

```text
TEXT
```

Required:

No

Purpose:

Barcode scanner lookup value.

Constraint:

Should be unique when present.

Barcode must be stored as text rather than a number because:

- Leading zeros may be significant.
- Some barcode formats exceed safe numeric ranges.
- Barcodes are identifiers, not quantities.

---

### name

Type:

```text
TEXT
```

Required:

Yes

Example:

```text
iPhone 15 128GB
```

---

### brand

Type:

```text
TEXT
```

Required:

Yes

Example:

```text
Apple
```

---

### model

Type:

```text
TEXT
```

Required:

Yes

Example:

```text
iPhone 15
```

---

### condition

Type:

```text
TEXT
```

Required:

Yes

Allowed V1 values:

```text
NEW
USED
REFURBISHED
```

---

### cost_price_cents

Type:

```text
INTEGER
```

Required:

No

Constraints:

```text
>= 0
```

Purpose:

Optional internal business cost.

This field should not normally appear on customer receipts.

---

### selling_price_cents

Type:

```text
INTEGER
```

Required:

Yes

Constraints:

```text
>= 0
```

Purpose:

Current listed selling price.

Historical sales must not depend on this value after a transaction completes.

---

### quantity_on_hand

Type:

```text
INTEGER
```

Required:

Yes

Default:

```text
0
```

Constraints:

```text
>= 0
```

V1 does not support negative inventory.

---

### low_stock_threshold

Type:

```text
INTEGER
```

Required:

No

Purpose:

Optional quantity at which the UI may warn about low stock.

---

### is_active

Type:

```text
INTEGER / BOOLEAN
```

Required:

Yes

Default:

```text
1
```

Meaning:

```text
1 = active
0 = archived
```

Archived products remain available to historical transaction records.

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

### updated_at

Type:

```text
TEXT
```

Required:

Yes

---

# 8. Product Constraints

The products table should enforce:

- `id` is unique.
- `selling_price_cents >= 0`
- `cost_price_cents >= 0` when present.
- `quantity_on_hand >= 0`
- `condition` uses approved values.
- `barcode` is unique when present.
- `sku` is unique when present.

Products should generally be archived rather than hard-deleted once referenced by business records.

---

# 9. Customers Table

Table:

```text
customers
```

Purpose:

Stores optional customer information.

## Fields

```text
id
name
phone
created_at
updated_at
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
PRIMARY KEY
```

---

### name

Type:

```text
TEXT
```

Required:

Yes

---

### phone

Type:

```text
TEXT
```

Required:

Yes

Phone numbers must be stored as text.

The system should normalize phone numbers for search where practical.

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

### updated_at

Type:

```text
TEXT
```

Required:

Yes

---

# 10. Customer Constraints

V1 should not assume two customers can never share a phone number unless the business explicitly requires that restriction.

Phone should be indexed for fast lookup.

Potential normalized field may later be introduced:

```text
phone_normalized
```

if needed.

---

# 11. Sales Table

Table:

```text
sales
```

Purpose:

Stores one completed business transaction per row.

This is one of the most important tables in the system.

## Fields

```text
id
receipt_number
customer_id
customer_name_snapshot
customer_phone_snapshot
business_name_snapshot
business_address_snapshot
business_phone_snapshot
receipt_disclaimer_snapshot
receipt_footer_snapshot
status
sync_version
subtotal_cents
discount_cents
taxable_amount_cents
tax_rate_bps
tax_cents
total_cents
payment_method_snapshot
created_at
completed_at
voided_at
void_reason
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
PRIMARY KEY
```

Purpose:

Immutable internal Sale ID.

This ID is used for:

- Database relationships
- Google Sheets synchronization
- Duplicate prevention
- Future external integrations

---

### receipt_number

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
UNIQUE
```

Example:

```text
GP-000124
```

Human-readable identifier shown to staff and customers.

---

### customer_id

Type:

```text
TEXT
```

Required:

No

Foreign key:

```text
customers.id
```

Customer attachment is optional.

---

### status

Type:

```text
TEXT
```

Required:

Yes

Allowed V1 values:

```text
COMPLETED
VOIDED
```

No other sale states are in V1 scope.

---

### sync_version

Type:

```text
INTEGER
```

Required:

Yes

Default:

```text
1
```

Purpose:

Monotonic version of the sale state exported to Google Sheets. Voiding a sale increments this value so an in-flight or previously completed export cannot incorrectly mark stale data as current.

---

### subtotal_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Total before discount and tax.

---

### discount_cents

Type:

```text
INTEGER
```

Required:

Yes

Default:

```text
0
```

Purpose:

Total transaction discount.

---

### taxable_amount_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Amount tax was calculated against.

---

### tax_rate_bps

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Historical snapshot of the tax rate used.

---

### tax_cents

Type:

```text
INTEGER
```

Required:

Yes

---

### total_cents

Type:

```text
INTEGER
```

Required:

Yes

Expected relationship:

```text
taxable_amount_cents + tax_cents = total_cents
```

subject to the final chosen pricing formula.

---

### payment_method_snapshot

Type:

```text
TEXT
```

Required:

Yes

Allowed V1 values:

```text
CASH
CARD
```

The authoritative payment details still live in the payments table.

This field exists to simplify common queries and preserve transaction-time reporting.

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

### completed_at

Type:

```text
TEXT
```

Required:

Yes

---

### voided_at

Type:

```text
TEXT
```

Required:

Only when `status = VOIDED`.

Purpose:

Preserves when the completed sale was voided.

---

### void_reason

Type:

```text
TEXT
```

Required:

Only when `status = VOIDED`.

Purpose:

Preserves the required staff-entered reason for the void.

---

# 12. Sale Status Rules

A row in `sales` represents a committed business transaction.

Draft carts should not be stored in this table unless future requirements explicitly require saved carts.

For V1:

```text
cart != sale
```

A sale row should be created only during the final checkout transaction.

A committed sale may transition exactly once from `COMPLETED` to `VOIDED`. Voiding does not delete or rewrite its sale items, payment, receipt number, totals, or transaction-time snapshots. It records `voided_at` and `void_reason`, increments `sync_version`, and creates reversal and audit records in one authoritative SQLite transaction.

---

# 13. Sale Items Table

Table:

```text
sale_items
```

Purpose:

Stores individual products sold within a sale.

This table preserves transaction-time snapshots.

## Fields

```text
id
sale_id
product_id
product_name_snapshot
brand_snapshot
model_snapshot
condition_snapshot
sku_snapshot
barcode_snapshot
listed_price_cents
sold_price_cents
discount_cents
quantity
line_subtotal_cents
line_total_cents
created_at
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
PRIMARY KEY
```

---

### sale_id

Type:

```text
TEXT
```

Required:

Yes

Foreign key:

```text
sales.id
```

---

### product_id

Type:

```text
TEXT
```

Required:

Yes

Foreign key:

```text
products.id
```

---

### product_name_snapshot

Type:

```text
TEXT
```

Required:

Yes

Purpose:

Preserves the product name used at sale time.

---

### brand_snapshot

Type:

```text
TEXT
```

Required:

Yes

---

### model_snapshot

Type:

```text
TEXT
```

Required:

Yes

---

### condition_snapshot

Type:

```text
TEXT
```

Required:

Yes

---

### sku_snapshot

Type:

```text
TEXT
```

Required:

No

---

### barcode_snapshot

Type:

```text
TEXT
```

Required:

No

---

### listed_price_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Price before negotiation/override.

---

### sold_price_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Actual per-unit selling price.

---

### discount_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

Total discount applied to this line.

---

### quantity

Type:

```text
INTEGER
```

Required:

Yes

Constraint:

```text
> 0
```

---

### line_subtotal_cents

Type:

```text
INTEGER
```

Required:

Yes

Example:

```text
listed_price × quantity
```

---

### line_total_cents

Type:

```text
INTEGER
```

Required:

Yes

Example:

```text
sold_price × quantity
```

before tax, depending on final tax calculation strategy.

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

# 14. Historical Snapshot Rule

The sale item snapshot is critical.

Example:

At time of sale:

```text
Product:
iPhone 15
Listed Price:
$599
Sold Price:
$550
```

Three months later the current product becomes:

```text
Product:
iPhone 15 Clearance
Price:
$480
```

The old transaction must still show:

```text
iPhone 15
$599 listed
$550 sold
```

Therefore historical receipts must read from `sale_items`, not from the current `products` table for sale-time values.

---

# 15. Payments Table

Table:

```text
payments
```

Purpose:

Stores payment information associated with completed sales.

V1 stores exactly one payment per sale.

## Fields

```text
id
sale_id
method
amount_cents
status
created_at
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
PRIMARY KEY
```

---

### sale_id

Type:

```text
TEXT
```

Required:

Yes

Foreign key:

```text
sales.id
```

Constraint:

```text
UNIQUE
```

---

### method

Type:

```text
TEXT
```

Required:

Yes

Allowed V1 values:

```text
CASH
CARD
```

---

### amount_cents

Type:

```text
INTEGER
```

Required:

Yes

Constraint:

```text
>= 0
```

For normal V1 sales:

```text
amount_cents = sales.total_cents
```

---

### status

Type:

```text
TEXT
```

Required:

Yes

Allowed V1 value:

```text
COMPLETED
```

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

# 16. Payment Integrity Rules

A completed V1 sale must have a completed payment record.

A voided sale retains that original completed payment record unchanged; voiding does not mutate payment data.

For V1:

```text
SUM(completed payment amounts)
=
sales.total_cents
```

This should be validated during checkout.

---

# 17. Inventory Movements Table

Table:

```text
inventory_movements
```

Purpose:

Creates an audit trail for every change to inventory quantity.

The product's current quantity is stored in `products.quantity_on_hand`.

The movement table explains how that quantity changed.

## Fields

```text
id
product_id
sale_id
movement_type
reverses_movement_id
quantity_change
quantity_before
quantity_after
reason
created_at
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

---

### product_id

Type:

```text
TEXT
```

Required:

Yes

Foreign key:

```text
products.id
```

---

### sale_id

Type:

```text
TEXT
```

Required:

No

Foreign key:

```text
sales.id
```

Required for `SALE` and `VOID_REVERSAL` movements.

---

### movement_type

Type:

```text
TEXT
```

Required:

Yes

Required V1 values:

```text
SALE
VOID_REVERSAL
MANUAL_ADJUSTMENT
INITIAL_STOCK
```

No other inventory movement types are in V1 scope.

---

### reverses_movement_id

Type:

```text
TEXT
```

Required:

Only for `VOID_REVERSAL` movements.

Foreign key:

```text
inventory_movements.id
```

Constraint:

```text
UNIQUE when present
```

Purpose:

Links each void reversal to the original `SALE` movement and prevents the same stock deduction from being reversed twice.

---

### quantity_change

Type:

```text
INTEGER
```

Required:

Yes

Examples:

Sale:

```text
-1
```

Initial stock:

```text
+5
```

Manual correction:

```text
+2
```

Void reversal of a one-unit sale:

```text
+1
```

---

### quantity_before

Type:

```text
INTEGER
```

Required:

Yes

---

### quantity_after

Type:

```text
INTEGER
```

Required:

Yes

---

### reason

Type:

```text
TEXT
```

Required:

No

Useful for manual adjustments.

Example:

```text
Physical stock recount
```

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

# 18. Inventory Rules

Inventory must satisfy:

```text
quantity_after
=
quantity_before + quantity_change
```

For V1:

```text
quantity_after >= 0
```

Sale movements must be created in the same SQLite transaction as:

- Sale creation
- Sale item creation
- Payment creation
- Product quantity update

Voiding a sale must use one SQLite transaction to:

1. Verify the sale is `COMPLETED` and has not already been voided.
2. Set its status to `VOIDED`, store `voided_at` and `void_reason`, and increment `sync_version`.
3. Restore product quantities.
4. Insert one `VOID_REVERSAL` movement for each original `SALE` movement, linked through `reverses_movement_id`.
5. Requeue the sale's existing Google Sheets export job for the new `sync_version`.
6. Insert the durable `SALE_VOIDED` audit event.

If any step fails, the entire void transaction must roll back. A void never edits or deletes the original `SALE` movements.

---

# 19. Settings Table

Table:

```text
settings
```

Purpose:

Stores configurable non-secret application and business settings.

Possible fields:

```text
key
value
updated_at
```

or a structured schema if preferred during implementation.

Initial settings may include:

```text
business_name
business_address
business_phone
business_timezone
tax_rate_bps
receipt_footer
receipt_disclaimer
selected_printer
google_sheets_enabled
google_spreadsheet_id
google_sales_sheet_name
google_sale_items_sheet_name
```

Secrets must not necessarily be stored in this table.

---

# 20. Settings Key Rules

Settings should be validated according to type.

Examples:

```text
tax_rate_bps → integer
google_sheets_enabled → boolean
selected_printer → string
```

Business settings can be changed without altering historical sale data.

For example:

Changing:

```text
tax_rate_bps
```

must not modify existing `sales.tax_rate_bps`.

---

# 21. Sensitive Configuration

Credentials such as:

- Google API tokens
- OAuth refresh tokens
- Private keys
- Shared application authentication secrets

should not be stored as ordinary plaintext settings.

The exact secure storage method will be decided during implementation.

Potential Windows/Electron mechanisms may include OS-protected credential storage or encrypted local storage.

Secrets must never be:

- Committed to Git.
- Included in renderer bundles.
- Printed in logs.
- Exported to Google Sheets.

---

# 22. Google Sheets Export Jobs Table

Table:

```text
google_sheet_export_jobs
```

Purpose:

Persists asynchronous Google Sheets synchronization work.

Every completed sale must have exactly one durable export job, created inside its checkout transaction whether Google Sheets synchronization is enabled or disabled. The enabled setting controls network processing, not durable queue creation.

## Fields

```text
id
sale_id
status
target_sync_version
exported_sync_version
attempt_count
next_attempt_at
last_attempt_at
exported_at
last_error
created_at
updated_at
```

---

### id

Type:

```text
TEXT
```

Required:

Yes

Constraint:

```text
PRIMARY KEY
```

---

### sale_id

Type:

```text
TEXT
```

Required:

Yes

Foreign key:

```text
sales.id
```

Constraint:

```text
UNIQUE
```

This ensures at most one logical export job exists per sale.

---

### status

Type:

```text
TEXT
```

Required:

Yes

Allowed values:

```text
PENDING
EXPORTING
EXPORTED
FAILED
```

---

### target_sync_version

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

The `sales.sync_version` that the job must converge to in Google Sheets.

---

### exported_sync_version

Type:

```text
INTEGER
```

Required:

No

Purpose:

The most recent sale version confirmed in Google Sheets. A job is current only when this equals `target_sync_version` and its status is `EXPORTED`.

---

### attempt_count

Type:

```text
INTEGER
```

Required:

Yes

Default:

```text
0
```

---

### next_attempt_at

Type:

```text
TEXT
```

Required:

No

Purpose:

Allows controlled retry scheduling.

---

### last_attempt_at

Type:

```text
TEXT
```

Required:

No

---

### exported_at

Type:

```text
TEXT
```

Required:

No

---

### last_error

Type:

```text
TEXT
```

Required:

No

Purpose:

Stores sanitized diagnostic information.

Must not contain credentials or tokens.

---

### created_at

Type:

```text
TEXT
```

Required:

Yes

---

### updated_at

Type:

```text
TEXT
```

Required:

Yes

---

# 23. Google Export Job Lifecycle

Initial:

```text
PENDING
```

Worker claims job:

```text
EXPORTING
```

Success:

```text
EXPORTED
```

Temporary failure:

```text
PENDING
```

with:

```text
attempt_count + 1
next_attempt_at updated
last_error updated
```

Persistent or repeatedly failing jobs may become:

```text
FAILED
```

A manual retry may move:

```text
FAILED → PENDING
```

When a completed sale is voided, the same job row is updated in the void transaction: `target_sync_version` is set to the incremented `sales.sync_version` and status returns to `PENDING`. This happens even while synchronization is disabled. A worker may mark a job `EXPORTED` only if the version it wrote still equals the current target; otherwise it must remain pending for the newer version.

When synchronization is disabled, workers must pause network attempts and leave pending jobs durable without increasing retry counts. Enabling synchronization resumes eligible jobs and exports their current target revisions.

---

# 24. Crash Recovery for Export Jobs

If the application crashes while a job is:

```text
EXPORTING
```

the system must not leave it permanently stuck.

On startup, stale `EXPORTING` jobs should be safely recoverable.

Example:

```text
EXPORTING
↓
app restart
↓
recover stale job
↓
PENDING
↓
retry
```

Duplicate protection must remain in place.

---

# 25. Google Sheets Idempotency

The immutable `sales.id` must be exported into Google Sheets.

Example:

```text
sale_id
550e8400-e29b-41d4-a716-446655440000
```

The exporter must use this ID as the destination upsert key to prevent duplication during retries and later sale-state changes.

At minimum:

- Sales worksheet contains Sale ID.
- Sale Items worksheet contains Sale ID.
- Sale Item rows should also include Sale Item ID.

Export behavior must tolerate:

- Network timeout after Google accepted a request.
- App crash after Google accepted data.
- Manual retry.
- Automatic retry.
- Re-export after a sale is voided.

The implementation must not assume:

```text
"No HTTP response = nothing was written."
```

For a void, the exporter updates the existing sale row identified by Sale ID to `VOIDED` and updates its void metadata. It must not append a second logical sale. Sale-item rows remain the immutable original items and are likewise matched by Sale Item ID. Repeated attempts must converge to the current `sales.sync_version`.

---

# 26. Google Sheets Logical Schema

## Sales Worksheet

Required V1 columns:

```text
Sale ID
Receipt Number
Date
Time
Customer Name
Customer Phone
Subtotal
Discount
Tax Rate
Tax
Total
Payment Method
Status
Sync Version
Voided At
Void Reason
Exported At
```

One row per sale.

---

## Sale Items Worksheet

Required V1 columns:

```text
Sale Item ID
Sale ID
Receipt Number
Product ID
Product Name
Brand
Model
Condition
SKU
Barcode
Quantity
Listed Price
Sold Price
Discount
Line Total
```

One row per sold line item.

---

# 27. Schema Migrations Table

Table:

```text
schema_migrations
```

Purpose:

Tracks database migrations that have already been applied.

Suggested fields:

```text
version
name
applied_at
```

Example rows:

```text
1 | initial_schema | ...
2 | add_customer_phone_index | ...
```

Migration files may be named:

```text
001_initial_schema.sql
002_add_customer_phone_index.sql
003_add_export_jobs.sql
```

Applied migrations must never be run again automatically.

---

# 28. Receipt Number State

Receipt numbers must remain unique and sequential enough for human use.

Preferred V1 format:

```text
GP-000001
GP-000002
GP-000003
```

Receipt numbers should be generated transactionally.

Two simultaneous or repeated checkout attempts must not receive the same receipt number.

---

# 29. Receipt Counter Strategy

A dedicated `counters` table controls receipt numbering in V1:

```text
counters
```

Fields:

```text
key
value
updated_at
```

Example:

```text
receipt_number | 124
```

During checkout:

```text
BEGIN

Read receipt counter
Increment counter
Generate GP-000125
Create sale

COMMIT
```

If the transaction rolls back, the counter increment rolls back with it. The next successful sale may use that otherwise-uncommitted number; a committed receipt number is never reused.

---

# 30. Counters Table

The V1 table is:

```text
counters
```

Fields:

```text
key
value
updated_at
```

Required entry:

```text
receipt_number
```

V1 does not use generic business counters beyond the receipt number.

---

# 31. Sale Completion Transaction

The complete sale database operation should conceptually execute:

```text
BEGIN IMMEDIATE TRANSACTION
```

Then:

1. Look up the request ID and verify its request fingerprint.
2. Return the existing completed sale if the same request already completed; reject reuse with different request content.
3. Insert the checkout request as `PROCESSING` if it is new.
4. Read required products.
5. Verify all products are active.
6. Verify quantities are sufficient.
7. Calculate authoritative totals.
8. Generate Sale ID.
9. Generate the unique receipt number.
10. Insert sale.
11. Insert sale items.
12. Insert payment.
13. Update product quantities.
14. Insert inventory movements.
15. Insert the sale's Google Sheets export job, initially `PENDING`, regardless of whether synchronization is enabled.
16. Insert the durable `SALE_COMPLETED` event and any required `PRICE_OVERRIDE` audit events.
17. Link the checkout request to the sale and mark it `COMPLETED`.
18. Commit.

If any required step fails:

```text
ROLLBACK
```

---

# 32. Checkout Idempotency

UI button disabling is not sufficient.

The database/application layer must enforce an idempotency key for checkout attempts.

Table:

```text
checkout_requests
```

Fields:

```text
request_id
request_fingerprint
sale_id
status
created_at
completed_at
```

Purpose:

Prevents the same checkout request from generating multiple sales.

---

# 33. Checkout Requests Table

Required for V1 because duplicate sale prevention is a MUST requirement.

Table:

```text
checkout_requests
```

Fields:

```text
request_id
request_fingerprint
sale_id
status
created_at
completed_at
```

---

### request_id

Type:

```text
TEXT
```

Constraint:

```text
PRIMARY KEY
```

Generated by the renderer/application before final submission.

---

### request_fingerprint

Type:

```text
TEXT
```

Required:

Yes

Purpose:

A deterministic digest of the normalized checkout intent. Reusing a request ID with different checkout content must fail safely rather than return an unrelated sale.

---

### sale_id

Type:

```text
TEXT
```

Required:

At commit.

Foreign key:

```text
sales.id
```

Constraint:

```text
UNIQUE when present
```

---

### status

Allowed values:

```text
PROCESSING
COMPLETED
```

`PROCESSING` exists only inside the open sale transaction. A successful commit must persist `COMPLETED` with `sale_id`; rollback must leave neither the sale nor a committed processing request.

---

### created_at

Required:

Yes

---

### completed_at

Required:

No

---

# 34. Checkout Duplicate Behavior

If the same:

```text
request_id
```

is submitted again after completion:

The application should return the already completed sale rather than create another one.

Conceptually:

```text
request A
↓
Sale GP-000125
↓
request A submitted again
↓
Return GP-000125
```

not:

```text
GP-000126
```

If the same request ID is submitted with a different `request_fingerprint`, the application must reject it as an idempotency-key conflict.

---

# 35. Foreign Key Relationships

Expected relationships:

```text
sales.customer_id
→ customers.id

sale_items.sale_id
→ sales.id

sale_items.product_id
→ products.id

payments.sale_id
→ sales.id

inventory_movements.product_id
→ products.id

inventory_movements.sale_id
→ sales.id

inventory_movements.reverses_movement_id
→ inventory_movements.id

google_sheet_export_jobs.sale_id
→ sales.id

checkout_requests.sale_id
→ sales.id
```

SQLite foreign key enforcement must be enabled.

---

# 36. Delete Strategy

Hard deletion should be limited.

## Products

If referenced by historical data:

```text
archive
```

rather than delete.

---

## Customers

Customer deletion behavior should be handled carefully.

For V1, customer records may be retained to preserve purchase history.

Future privacy requirements may introduce anonymization.

---

## Sales

Completed or voided sales must not be hard-deleted through normal UI operations. Apart from the controlled `COMPLETED` to `VOIDED` transition and its void metadata and sync version, historical sale fields are immutable.

---

## Sale Items

Must not be edited or independently deleted from completed or voided sales.

---

## Payments

Must not be edited or independently deleted from completed or voided sales.

---

## Inventory Movements

Inventory movements are immutable business records and must not be edited or deleted through normal UI operations.

---

# 36A. Audit Events Table

Table:

```text
audit_events
```

Purpose:

Stores the durable business and system audit trail independently of rotating diagnostic logs.

## Fields

```text
id
event_type
occurred_at
actor_type
actor_identifier
subject_type
subject_id
correlation_id
outcome
reason
details_json
app_version
```

Required V1 event types include:

```text
SALE_COMPLETED
SALE_VOIDED
PRICE_OVERRIDE
INVENTORY_ADJUSTED
TAX_SETTING_CHANGED
BUSINESS_SETTING_CHANGED
GOOGLE_CONFIGURATION_CHANGED
BACKUP_COMPLETED
BACKUP_FAILED
MIGRATION_STARTED
MIGRATION_COMPLETED
MIGRATION_FAILED
UPDATE_INSTALLED
```

`id` is the immutable primary key. `actor_type` identifies `USER` or `SYSTEM`; `actor_identifier` may be null where V1's shared login cannot identify an individual. `subject_type` and `subject_id` identify the affected sale, product, setting, backup, migration, or update when applicable. `correlation_id` links the event to related checkout, void, export, backup, migration, or update diagnostics. `details_json` may contain only schema-validated, sanitized context and must not contain secrets or unnecessary customer PII.

`id`, `event_type`, `occurred_at`, `actor_type`, `outcome`, and `app_version` are required. Allowed `outcome` values are `SUCCESS` and `FAILURE`; subject, correlation, reason, and detail fields are optional except where the workflow requires them. In particular, `SALE_VOIDED` requires the Sale ID as its subject and the staff-entered void reason.

Audit events are append-only. Normal application workflows must not update or delete them. `SALE_COMPLETED` and any `PRICE_OVERRIDE` events must commit with checkout, and `SALE_VOIDED` must commit with the void and its reversing inventory movements. Other authoritative business changes must commit their corresponding audit event with the change whenever SQLite is available.

Migration execution records `MIGRATION_STARTED` before applying schema changes, then records `MIGRATION_COMPLETED` after success or `MIGRATION_FAILED` after rollback/recovery when the database remains writable. `UPDATE_INSTALLED` represents a successfully installed update; failed update attempts remain diagnostic-log events unless an authoritative state change occurs.

---

# 36B. Backup Records Table

Table:

```text
backup_records
```

Purpose:

Records enough metadata to identify and validate automatic, manual, and pre-migration SQLite backups without storing backup contents in the database.

## Fields

```text
id
backup_type
status
file_name
storage_path
source_app_version
source_schema_version
target_app_version
size_bytes
checksum_sha256
started_at
completed_at
error_code
```

Allowed `backup_type` values:

```text
AUTOMATIC
MANUAL
PRE_MIGRATION
```

Allowed `status` values:

```text
COMPLETED
FAILED
```

Successful records require the file identity, source versions, size, checksum, and completion timestamp. `target_app_version` is required for a pre-migration backup and may be null otherwise. Failed records require a stable, sanitized `error_code`; file metadata may be null when no valid backup was produced.

A pre-migration backup must reach `COMPLETED` and its metadata must be durably recorded before its migration begins. Backup files live outside the active SQLite database so recovery remains possible if that database becomes unusable.

The backup record and matching `BACKUP_COMPLETED` or `BACKUP_FAILED` audit event must be committed together when SQLite is writable.

---

# 37. Indexes

Recommended indexes include:

```text
products(barcode)
products(sku)
products(name)
products(brand)
products(model)
products(is_active)

customers(phone)
customers(name)

sales(receipt_number)
sales(completed_at)
sales(customer_id)
sales(status)

sale_items(sale_id)
sale_items(product_id)

payments(sale_id)

inventory_movements(product_id)
inventory_movements(sale_id)
inventory_movements(reverses_movement_id)
inventory_movements(created_at)

google_sheet_export_jobs(status)
google_sheet_export_jobs(next_attempt_at)

checkout_requests(request_id)

audit_events(event_type)
audit_events(occurred_at)
audit_events(subject_type, subject_id)
audit_events(correlation_id)

backup_records(backup_type)
backup_records(status)
backup_records(completed_at)
```

Indexes should be added based on real query patterns and not excessively.

---

# 38. Search Strategy

For the expected V1 scale of approximately 50 initial products, conventional indexed SQLite queries are sufficient.

No external search engine is required.

Product lookup examples:

```text
barcode exact match
SKU exact match
name contains
brand contains
model contains
```

Customer lookup examples:

```text
phone
name
```

---

# 39. Initial Stock Behavior

When a product is created with:

```text
quantity_on_hand > 0
```

the system should create an:

```text
INITIAL_STOCK
```

inventory movement.

Example:

```text
Product:
iPhone 15

Initial quantity:
5

Movement:
+5 INITIAL_STOCK
```

This keeps the inventory audit trail consistent from the beginning.

---

# 40. Product Quantity Editing

Directly editing:

```text
products.quantity_on_hand
```

without an inventory movement is prohibited.

If the user changes stock from:

```text
5 → 7
```

the application must create:

```text
MANUAL_ADJUSTMENT +2
```

The repository/application layer should enforce this rule.

---

# 41. Discount Model

V1 primarily supports negotiated item pricing.

Example:

```text
Listed:
$599

Sold:
$550
```

Per-item discount:

```text
$49
```

For quantity 2:

```text
Listed total:
$1198

Sold total:
$1100

Discount:
$98
```

The system should derive line discount from listed and sold prices rather than trusting arbitrary client-submitted totals.

---

# 42. Tax Calculation Model

Authoritative tax calculations must happen in trusted application/domain logic.

Renderer-calculated totals are previews only.

Example conceptual calculation:

```text
line total
↓
sum transaction taxable amount
↓
apply tax_rate_bps
↓
round using defined cent-level rule
↓
tax_cents
```

The exact rounding policy should be defined in implementation and covered by tests.

---

# 43. Authoritative Calculations

The main/application layer must recalculate:

- Listed subtotal
- Actual subtotal
- Discount
- Taxable amount
- Tax
- Total

before committing the sale.

The renderer must never be trusted to send final authoritative monetary values.

---

# 44–49. Mandatory V1 Sale Snapshots and Final Sales Fields

Every V1 sale must capture the transaction-time customer, business, receipt-policy, tax-rate, and payment-method values needed to reconstruct the original receipt. Current `customers`, `settings`, or `products` rows must never be used in place of these snapshots when rendering historical receipts.

The V1 `sales` table fields are:

```text
id
receipt_number

customer_id
customer_name_snapshot
customer_phone_snapshot

business_name_snapshot
business_address_snapshot
business_phone_snapshot
receipt_disclaimer_snapshot
receipt_footer_snapshot

status
sync_version

subtotal_cents
discount_cents
taxable_amount_cents
tax_rate_bps
tax_cents
total_cents

payment_method_snapshot

created_at
completed_at
voided_at
void_reason
```

When no customer is attached, `customer_id`, `customer_name_snapshot`, and `customer_phone_snapshot` are null. When a customer is attached, all three are required. Business and receipt-policy snapshots are required for every sale; a configured blank footer or disclaimer is stored as the transaction-time blank value rather than null.

These snapshots are intentionally duplicated because historical receipt integrity takes priority over normalization. They become immutable when checkout commits, along with the original sale items, payment, monetary totals, receipt number, and completion timestamp. The controlled void transition changes only `status`, `sync_version`, `voided_at`, and `void_reason`.

---

# 50. Data Ownership

Authoritative ownership:

```text
Products
→ SQLite

Inventory
→ SQLite

Customers
→ SQLite

Sales
→ SQLite

Payments
→ SQLite

Sales History
→ SQLite

Daily Reporting
→ SQLite

Audit Trail
→ SQLite

Backup Metadata
→ SQLite

Google Sheets
→ Secondary exported copy
```

Google Sheets must never be queried to determine whether a local sale exists.

---

# 51. Google Sheets Is Not a Restore Source

The application must not assume the complete SQLite database can be reconstructed from Google Sheets.

Google Sheets intentionally contains only exported sales/reporting information.

It may omit:

- Settings
- Inventory movement history
- Full application state
- Export queue metadata
- Authentication information
- Backup metadata
- Internal database relationships

SQLite backup remains independently required.

---

# 52. Backup Scope

The SQLite backup must include all database tables required to restore operational state.

At minimum:

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

---

# 53. Data Integrity Constraints

The database should enforce as many invariants as reasonably possible.

Examples:

```text
product quantity >= 0
prices >= 0
sale total >= 0
payment amount >= 0
sale item quantity > 0
receipt number UNIQUE
barcode UNIQUE when present
SKU UNIQUE when present
one export job per sale
one payment per sale
one checkout request per completed sale
one reversal per original sale movement
VOIDED sales require voided_at and void_reason
audit events are append-only
```

Application logic supplements these constraints.

---

# 54. SQLite Configuration

The implementation should explicitly configure SQLite.

Expected configuration should include:

```text
PRAGMA foreign_keys = ON
```

A suitable journaling mode such as WAL may be evaluated during implementation for durability and application behavior.

Any SQLite configuration decision must be covered by actual testing rather than assumed.

---

# 55. Transaction Isolation

Checkout must acquire an appropriate write transaction before validating and mutating stock.

This protects against future concurrent operations inside the application.

Even though V1 uses a single local machine and shared login, database-level correctness should not rely solely on the assumption that only one UI action happens at a time.

---

# 56. Application Restart Guarantees

After SQLite reports a successful commit:

The following must survive application restart:

- Sale
- Sale items
- Payment
- Inventory changes
- Inventory movement
- Receipt number
- Google export job
- Checkout request completion
- Audit events
- Void status, reason, timestamp, and reversing movements when applicable

---

# 57. Windows Restart Guarantees

The same committed state must survive a complete Windows restart.

No critical transaction data may live only in:

- React state
- temporary memory
- export worker memory
- application cache

---

# 58. Data Model Non-Goals

V1 does not require tables for:

- Repairs
- Repair tickets
- Technicians
- Repair parts
- Trade-ins
- IMEI records
- Serial numbers
- Accessory inventory
- Employees
- Roles
- Branches
- Suppliers
- Purchase orders
- Loyalty programs
- Clover transactions
- Accounting ledgers

These must not be introduced unless scope changes.

---

# 59. Proposed Final Table List

The preferred V1 database contains:

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

This is enough to support the current V1 requirements without introducing unnecessary domain complexity.

---

# 60. Core Data Invariant

The central data invariant is:

> If a sale is marked completed or voided, all authoritative transaction records, audit events, and inventory changes associated with that state must already be durably committed to SQLite.

Therefore this state is invalid:

```text
sale exists
inventory not updated
```

This state is also invalid:

```text
inventory updated
sale missing
```

This state is valid:

```text
Sale
+
Sale Items
+
Payment
+
Inventory Updates
+
Inventory Movements
+
Export Job
+
Checkout Request Completion
+
Audit Events

COMMITTED TOGETHER
```

---

# 61. Example Completed Sale

Example product before checkout:

```text
Product ID:
P-123

Name:
iPhone 15 128GB

Listed price:
59900

Quantity:
5
```

Checkout:

```text
Quantity:
1

Negotiated sold price:
55000

Tax:
4538

Final total:
59538

Payment:
CASH
```

After completion:

```text
sales
------
GP-000124
total = 59538

sale_items
----------
iPhone 15 128GB
listed = 59900
sold = 55000
qty = 1

payments
--------
CASH
59538

products
--------
quantity = 4

inventory_movements
-------------------
-1 SALE

google_sheet_export_jobs
------------------------
PENDING

checkout_requests
-----------------
COMPLETED

audit_events
------------
SALE_COMPLETED
```

Everything above is committed in the same authoritative local transaction.

---

# 62. Data Model Definition of Success

The data model is successful when the following can occur reliably:

```text
Product quantity = 5

Cashier submits checkout
        ↓
SQLite transaction begins
        ↓
All values validated
        ↓
Sale inserted
        ↓
Sale items inserted
        ↓
Payment inserted
        ↓
Inventory changes 5 → 4
        ↓
Movement -1 recorded
        ↓
Export job recorded
        ↓
SALE_COMPLETED audit event recorded
        ↓
Checkout request completed
        ↓
COMMIT
```

Then:

```text
Application closes
Windows restarts
Internet remains disconnected
Application reopens
```

and the system still shows:

```text
Sale exists
Receipt exists
Inventory = 4
Payment exists
Export = Pending
```

Once internet returns:

```text
Pending export
↓
Google Sheets
↓
Exported
```

with no duplicate sale created locally or in the export destination.

---

# 63. Data Model Definition of a Successful Void

Given the completed example above, a successful void performs:

```text
BEGIN IMMEDIATE TRANSACTION
        ↓
Verify status = COMPLETED
        ↓
Set status = VOIDED
Store voided_at and void_reason
Increment sync_version
        ↓
Restore inventory 4 → 5
        ↓
Record +1 VOID_REVERSAL linked to the original -1 SALE movement
        ↓
Set the existing export job target to the new sync_version and PENDING
        ↓
Record SALE_VOIDED audit event
        ↓
COMMIT
```

After restart, the original sale, items, payment, receipt number, totals, and `SALE` movement remain unchanged; the void metadata, reversing movement, restored stock, and audit event remain durable. Google Sheets retry updates the row keyed by the existing Sale ID until it shows `VOIDED`, without appending another logical sale.
