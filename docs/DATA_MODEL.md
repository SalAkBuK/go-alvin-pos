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

## Business-Day Semantics

- **Authoritative sale timestamp:** `sales.completed_at` (UTC) is the authoritative instant a sale is attributed to for reporting. `created_at` marks when the checkout began and is not used for date-bucketing.
- **UTC persistence:** every stored timestamp (`sales.created_at`/`completed_at`/`voided_at`, `checkout_requests.*`, `inventory_movements.created_at`, `audit_events.occurred_at`, etc.) is persisted as ISO 8601 UTC, never as a local-time string.
- **Business date derivation:** a sale's "business date" for reporting (Section 19 of `PRODUCT_SCOPE.md`, `REQ-REPORT-*`) is computed live, at query time, as the calendar date of `completed_at` converted into the **currently configured** `business_timezone` using standard IANA timezone conversion rules (midnight-to-midnight boundaries in that zone). Business date is never stored as a separate persisted column; it is always derived from the immutable UTC `completed_at` plus whatever `business_timezone` is configured *now*.
- **Timezone-change behavior:** because business date is derived at query time, changing the configured `business_timezone` changes which calendar day existing historical sales are reported under the next time reports are viewed. This is a deliberate, documented V1 simplification — Go Phones - Alvin is a single fixed physical location and is not expected to change its configured timezone in normal operation; if it ever does, historical day-buckets simply reflect the new zone going forward and backward consistently, rather than needing a re-bucketing migration.
- **DST behavior:** standard IANA DST rules apply with no special-casing. A sale timestamped during a "spring forward" gap or a "fall back" repeated hour is bucketed using the same deterministic local-time conversion the OS/timezone library produces for that UTC instant; V1 does not need custom handling because the store's operating hours make a transaction during the 1–2 AM transition window extremely unlikely, but the rule is fully deterministic regardless.
- **Late-void attribution:** voiding a sale never moves or edits its original `completed_at`. Reports for the sale's **original business date** simply exclude its revenue, discount, tax, and payment-method totals once it is `VOIDED` (Section 19 of `PRODUCT_SCOPE.md`, `REQ-VOID-005`) — a report re-run for that original date after the void reflects the correction automatically, since revenue reports always filter out `VOIDED` sales live rather than snapshotting a day's totals at completion time. The **void action itself** (as a distinct event, for audit/void-activity visibility, not as revenue) is associated with the business date of `voided_at`, so "voids that happened today" and "revenue earned today" are two independent, correctly-dated views. A sale voided on a later calendar day than it was completed therefore reduces the *original* sale-day's reported revenue retroactively (there is no separate "revenue adjustment" line on the void date) while appearing in the void-activity list on the date it was actually voided.

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

Unique when present. SKU is optional; when a product has no SKU the column stores `NULL`, not an empty string, so multiple SKU-less products never collide against a uniqueness constraint.

Normalization applied before storage and before the uniqueness check:

- Leading and trailing whitespace is trimmed.
- A value that is empty after trimming is stored as `NULL`.
- Comparison for uniqueness is case-sensitive on the trimmed value. V1 does not fold case, so `ABC-100` and `abc-100` are treated as distinct SKUs.

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

Unique when present, using the same normalization and `NULL`-on-blank rule as `sku`.

Barcode must be stored as text rather than a number because:

- Leading zeros may be significant.
- Some barcode formats exceed safe numeric ranges.
- Barcodes are identifiers, not quantities.

Normalization applied before storage and before lookup/uniqueness comparison:

- Leading and trailing whitespace is trimmed (guards against stray characters some scanners append).
- A value that is empty after trimming is stored as `NULL`.
- Comparison is case-sensitive and byte-for-byte on the trimmed value; V1 does not attempt vendor-specific barcode-symbology normalization (e.g., UPC-A/EAN-13 equivalence). A scan must match a stored barcode exactly to locate a product.

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
<= 9_999_999 (i.e. $99,999.99)
```

Purpose:

Current listed selling price.

Historical sales must not depend on this value after a transaction completes.

The upper bound is a sanity ceiling, not a business limit expected to be reached by phone retail; it exists to reject fat-finger entry and to keep monetary arithmetic safely within integer range (see Section 41A, Numeric Bounds and Validation).

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

A blank or whitespace-only name is rejected; the trimmed value is stored.

---

### phone

Type:

```text
TEXT
```

Required:

No

Phone numbers must be stored as text. A customer record requires a name but does not require a phone number, so a walk-in customer can be recorded by name alone.

Normalization applied before storage:

- Leading/trailing whitespace is trimmed.
- A value that is empty after trimming is stored as `NULL`, not an empty string.
- The raw (human-formatted) value entered by the cashier is stored in `phone` as-is once trimmed; no reformatting (e.g., inserting dashes) is imposed.

---

### phone_normalized

Type:

```text
TEXT
```

Required:

No

Purpose:

A derived, digits-only representation of `phone` (non-digit characters such as spaces, dashes, and parentheses removed) used for search and lookup so that `(281) 824-0001` and `281-824-0001` match the same customer. Recomputed whenever `phone` changes. `NULL` when `phone` is `NULL`.

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

V1 does not enforce phone-number uniqueness. Two customers may share a phone number (for example, household members), and the system must not silently merge or reject a new customer record solely because a phone number already exists.

`phone_normalized` should be indexed for fast lookup; `name` should also be indexed.

Editing an existing customer's `name` or `phone` updates only the live customer record. It must never rewrite `customer_name_snapshot` or `customer_phone_snapshot` on any historical sale (see Section 44–49).

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

Required entries:

```text
receipt_number
audit_sequence
```

`audit_sequence` allocates the monotonic `sequence` value for `audit_events` (Section 36A) using the same read-increment-within-transaction pattern as `receipt_number`. V1 does not use generic business counters beyond these two.

---

# 31. Sale Completion Transaction

Completion is a two-phase durability design. Phase 1 durably records the checkout attempt in its own short-lived committed transaction(s) **before** the authoritative sale transaction (Phase 2) is attempted. For Card, Phase 1 is itself ordered into two independently committed steps so that a durable local record exists **before the cashier is ever instructed to process the card through Clover** — not merely before the authoritative sale transaction. This guarantees that even a total loss of SQLite availability at the worst possible moment (immediately after Clover approves) cannot leave a real Clover charge with zero durable local trace. See Section 31A for the reasoning.

## Phase 1, Step A — Pre-Payment Durable Record (independent, always durable, always first)

```text
BEGIN IMMEDIATE
```

1. Look up `request_id`. If a row already exists, verify its `request_fingerprint` matches; if it does not match, reject as an idempotency-key conflict and stop (see Section 34).
2. If no row exists: first verify the store's business identity is configured (Section 19; `POS_WORKFLOWS.md` Section 69) and the other preconditions for a completable sale hold (a tax rate is configured, the cart's products are active and in stock). If a precondition is already broken, stop with the specific error (`BUSINESS_NOT_CONFIGURED`, `TAX_RATE_NOT_CONFIGURED`, `PRODUCT_ARCHIVED`, `INSUFFICIENT_STOCK`) and create **no** row — a `SUBMITTED` row is never inserted for a checkout that cannot proceed. Otherwise insert a new `checkout_requests` row with the normalized `request_fingerprint`, `payment_method_snapshot`, and `intended_total_cents`, and:
   - For **Cash**, `status = SUBMITTED` immediately — there is no external payment step to await.
   - For **Card**, `status = PENDING_PAYMENT` — `clover_approved_confirmed_at` is left `NULL`; the POS does not yet know, and must not imply, whether Clover will approve anything.

For **Cash**, drift between the reviewed values and current authoritative state is **not** judged in Step A — Phase 2 is the single authoritative gate (Phase 2 step 5, Section 41B), and Step A only refuses to create a row when a sale plainly cannot be completed at all. For **Card**, Step A additionally performs one pre-payment check: the fingerprint recomputed from current authoritative state must equal the reviewed `request_fingerprint`. If it does not (a price or the tax rate changed since Checkout Review), Step A rejects with `CHECKOUT_DRIFT` and creates **no** row, *before* any Clover instruction is shown — so the POS never instructs Clover to charge an amount the cashier did not review, and `request_fingerprint` and `intended_total_cents` on a written row always describe the same reviewed transaction. This pre-payment safety check does **not** replace Phase 2 revalidation, which still runs after Clover approval as the final authoritative drift gate before sale commit.

```text
COMMIT
```

**This step must complete and commit before the cashier is instructed to process any amount through Clover.** It is intentionally small and unlikely to fail for the same reasons the larger sale transaction might fail (e.g., it does not touch product/inventory rows). If this step cannot commit, checkout must stop immediately: the cashier is warned and is **not** sent to Clover for this attempt, so no charge is put at risk without a durable local trace already existing.

## Phase 1, Step B — Payment Confirmation Record (Card only; skipped for Cash)

Only reached after the cashier has processed the reviewed total on Clover and Clover has responded.

```text
BEGIN IMMEDIATE
```

1. Re-read the existing `checkout_requests` row for `request_id` (already `PENDING_PAYMENT` from Step A).
2. Update it: set `clover_approved_confirmed_at` to the timestamp of the cashier's explicit confirmation that Clover approved the charge, and advance `status = SUBMITTED`.

```text
COMMIT
```

The application must never set `clover_approved_confirmed_at` or advance past `PENDING_PAYMENT` except in direct response to the cashier's explicit confirmation — the POS does not independently know whether Clover captured funds.

If this update cannot commit — Clover has already approved, the cashier has confirmed it, but the durable write recording that confirmation fails — the situation is handled exactly like a Phase 2 commit failure (Section 31A): the application treats the row as needing reconciliation rather than silently retrying the write and hoping. A `checkout_requests` row that remains `PENDING_PAYMENT` past a short staleness window (5 minutes, matching the stale-job default in `ARCHITECTURE.md` Section 49A) without advancing is therefore also surfaced in the Reconciliation Queue (Section 31B), because a stalled `PENDING_PAYMENT` row cannot be distinguished from "cashier hasn't gone to Clover yet" without giving it time to resolve naturally first.

For Cash, Step B does not exist — Step A already wrote `status = SUBMITTED` directly, since there is no external charge whose confirmation could be lost.

## Phase 2 — Attempt the authoritative sale (may fail; must not erase phase 1 evidence)

```text
BEGIN IMMEDIATE
```

1. Re-read the `checkout_requests` row for `request_id`. If its `status` is already `COMPLETED`, return the existing sale rather than proceeding (idempotent replay). Phase 2 only proceeds from `status = SUBMITTED`; a row still at `PENDING_PAYMENT` has not yet had its Card approval confirmed (Step B) and is not eligible for Phase 2.
2. Read required products.
3. Verify all products are active.
4. Verify quantities are sufficient, aggregating duplicate product IDs across cart lines first (Section 41A).
5. Calculate authoritative totals and compare them against the reviewed values captured in the request fingerprint; reject with a re-review error if authoritative values differ (Section 41B). A rejection here (or at steps 3–4: a product archived since review, stock now below the cart quantity) is a Phase 2 attempt that did not complete — it rolls the transaction back and is recorded exactly like any other Phase 2 failure (see "Phase 2 failure — record the outcome" below).
6. Generate Sale ID.
7. Generate the unique receipt number.
8. Insert sale.
9. Insert sale items.
10. Insert payment.
11. Update product quantities.
12. Insert inventory movements.
13. Insert the sale's Google Sheets export job, initially `PENDING`, regardless of whether synchronization is enabled.
14. Insert the durable `SALE_COMPLETED` event and any required `PRICE_OVERRIDE` audit events.
15. Update the existing `checkout_requests` row: `status = COMPLETED`, `sale_id`, `completed_at`.

```text
COMMIT
```

If any required step in Phase 2 fails, that transaction rolls back in full — no sale, no inventory change, no payment, no export job. The `checkout_requests` row from Phase 1, however, already committed independently and survives the rollback.

## Phase 2 failure — record the outcome

If Phase 2 rolls back, the application immediately performs one additional best-effort write, independent of the failed transaction: update the existing `checkout_requests` row to `status = COMMIT_FAILED` with `failure_code` and `failed_at`. If SQLite is reachable enough to have rolled back cleanly, this update is expected to succeed. If SQLite is not reachable at all (the underlying failure), the row from Phase 1 Step A (and, for Card, Step B) still exists from before the failure and remains durable evidence even though its `status` could not advance past `SUBMITTED`; diagnostics additionally record the failure per Section 31A.

"Phase 2 rolls back" here means **any** Phase 2 attempt that begins from an eligible (`SUBMITTED`) request and does not commit a sale — not only an unexpected or storage-level commit failure, but also a *trusted revalidation* rejection: checkout drift (Section 41B), a product archived or deleted since review, stock that has fallen below the cart quantity, a tax rate or business identity that is no longer configured, or a recalculated total that now exceeds the ceiling. Each rolls the authoritative transaction back with nothing written and is recorded on the same row the same way. The `failure_code` is the stable, specific reason: `SALE_COMMIT_FAILED` is reserved for an unexpected/storage-level failure, and a specific code (`CHECKOUT_DRIFT`, `INSUFFICIENT_STOCK`, `PRODUCT_ARCHIVED`, `BUSINESS_NOT_CONFIGURED`, `TAX_RATE_NOT_CONFIGURED`, …) records a trusted revalidation rejection (`SUPPORT_DIAGNOSTICS.md` Section 42). `SUBMITTED` therefore means *currently eligible for Phase 2*: a request that Phase 2 has rejected does not remain `SUBMITTED`. When the cashier re-reviews materially changed checkout content, that review computes a new fingerprint and the completion uses a **new `request_id`** (Section 34); the `COMMIT_FAILED` row is left as durable evidence of the superseded attempt. For a Cash request this row is terminal/retry evidence only — it is **not** an external-payment reconciliation case; Card reconciliation continues to be governed by payment method and Sections 31A–31B. A precondition that is already broken *before* Phase 1 (no tax rate, no business identity, an already-archived cart product) is rejected before the `SUBMITTED` row is created, so nothing is written and there is no row to mark.

This design means the four pieces of durable local evidence Priority 0 requires — checkout request, intended total, payment method, and cashier-confirmed Clover approval — are captured across Phase 1's two steps, each committed independently and in order *before* the corresponding external or internal action it protects (Step A before Clover is invoked; Step B before Phase 2 is attempted), and therefore survive any later failure.

---

# 31A. Card-Approved / Local-Commit-Failure Handling (Critical Reconciliation Case)

## The failure cases

**Case 1 — Phase 2 fails after approval is durably confirmed:**

1. Phase 1 Step A durably records the pending Card attempt (`PENDING_PAYMENT`) before Clover is invoked.
2. Cashier processes the reviewed total manually through Clover.
3. Clover approves and captures the charge.
4. Cashier confirms the Clover approval inside Go Phones POS; Phase 1 Step B durably records that confirmation (`SUBMITTED`).
5. The authoritative Phase 2 sale transaction (Section 31) fails to commit (disk full, unexpected constraint failure, abrupt storage failure, etc.).
6. The customer may have been charged by Clover, but no completed local sale exists.

**Case 2 — Step B itself cannot commit:**

1. Phase 1 Step A durably records the pending Card attempt (`PENDING_PAYMENT`) before Clover is invoked.
2. Cashier processes the reviewed total manually through Clover.
3. Clover approves and captures the charge.
4. Cashier confirms the Clover approval inside Go Phones POS, but the Step B durable write recording that confirmation fails.
5. The row is left at `PENDING_PAYMENT` with no record of the approval; the customer may have been charged, but the POS has no durable record that approval was ever confirmed.

Both cases converge on the same required behavior below; Case 2 is additionally surfaced by staleness (Section 31 Phase 1 Step B) rather than only by an explicit `COMMIT_FAILED` transition, since the failure occurs before a `COMMIT_FAILED` write can even be attempted with confidence.

Go Phones POS must never pretend the Clover charge did not happen, and must never fabricate a completed local sale to paper over the failure. It also does not call any Clover API — V1 has no direct Clover integration — so it cannot programmatically confirm or reverse the charge itself.

## Required behavior

- The `checkout_requests` row created in Phase 1 Step A (Section 31) — before Clover was ever invoked — is the durable local record of this incident. For a Card attempt it carries `payment_method_snapshot = CARD` and `intended_total_cents` from the moment it is created, gains `clover_approved_confirmed_at` once Step B succeeds, and after a Phase 2 failure is updated to `status = COMMIT_FAILED`. A row that never reaches Step B (Case 2) remains discoverable at `PENDING_PAYMENT` and is still surfaced once stale.
- The UI must immediately and unambiguously tell the cashier that (a) the local sale was **not** recorded, and (b) if Clover already showed approval, that charge may still be valid on the customer's card and must be checked/voided/refunded **separately and manually in Clover** — Go Phones POS performs no automatic reversal. Example required wording:

```text
Local sale could not be saved.

If you already saw "Approved" on Clover, that charge may still exist.
Do NOT run the card again.

Check this transaction in Clover directly. If it was charged and you
cannot complete the local sale, void or refund it in Clover.

This attempt has been recorded for reconciliation as CHK-83ac...
```

- A best-effort durable audit event `CARD_LOCAL_COMMIT_FAILURE` is written (Section 36A) referencing the `checkout_requests.request_id` as its subject whenever SQLite is reachable enough to accept it; if not, the diagnostic log is the required fallback per the existing audit-availability rule (Section 36A) and the friendly activity history still surfaces the failure using locally cached state.
- The failed attempt appears in a **Reconciliation Queue** (Section 31B) so it is not silently lost among ordinary diagnostics.
- The cashier may retry completing the same cart once the underlying local issue is resolved (e.g., disk space freed). A retry reuses the cart contents; it must not prompt the cashier to run the card through Clover a second time. If the retry succeeds, the resulting sale is linked back to the same `checkout_requests` row (Section 31, Phase 2 step 15), closing the reconciliation item automatically. If the cashier instead completes the sale as Cash or abandons it, the reconciliation entry is resolved manually (Section 31B).
- This condition is a Critical local failure for messaging purposes (Section 40, `ARCHITECTURE.md`) even though its root cause may be a transient local storage problem; it must never be presented as a successful sale.

## Explicitly out of scope

- No direct Clover API call, reversal, or refund is performed by Go Phones POS.
- No automatic detection of whether Clover actually captured the charge — the durable record reflects only what the cashier confirmed inside the POS.

---

# 31B. Reconciliation Queue

`checkout_requests` rows with `payment_method_snapshot = CARD` are surfaced together in a Reconciliation Queue view (Settings/Support area) until resolved when either:

- `status = COMMIT_FAILED` with a `failure_code` other than `CLOVER_DECLINED` (Phase 2 failed, or Step B's confirmation write failed and a best-effort `COMMIT_FAILED` transition succeeded), or
- `status = PENDING_PAYMENT` and the row has not advanced within the 5-minute staleness window (Section 31, Phase 1 Step B) — covering Case 2, where the confirmation write itself could not be recorded at all.

A `PENDING_PAYMENT` row that is not yet stale is a normal, healthy in-progress checkout and must not appear in the queue. A row explicitly resolved as declined/cancelled (`failure_code = CLOVER_DECLINED`, `POS_WORKFLOWS.md` Section 31) is not an incident — no charge occurred — and must not appear in the queue either. This reuses the existing `COMMIT_FAILED` status and `failure_code` field rather than introducing another status value: a decline is recorded the same way a commit failure is (a terminal, best-effort update to the Phase 1 row), and the queue simply distinguishes the two by `failure_code`.

Additional fields supporting this (see Section 33 for the full table):

```text
resolution_status
resolution_note
resolved_at
```

Resolution flow:

1. The shared user opens the queue and reviews the reviewed amount, timestamp, and Clover-approval confirmation time for the entry.
2. After checking Clover and taking any necessary manual action there (nothing, void, or refund), the user marks the entry resolved with a required note (e.g., `"Verified in Clover, sale re-entered as GP-000131"` or `"Voided in Clover, no local sale created"`).
3. Marking an entry resolved never creates, edits, or backdates a sale. It only records that a human reconciled the discrepancy.
4. An entry that later completes successfully via retry (Section 31A) is automatically marked resolved with `resolution_note = "Completed on retry"` and the linked `sale_id`.

The Reconciliation Queue is a durable local list, not a business record generator — it exists purely so a Clover charge with no matching local sale is never forgotten.

---

# 32. Checkout Idempotency

UI button disabling is not sufficient.

The database/application layer must enforce an idempotency key for checkout attempts, and that key's evidence must survive a failed sale attempt (Section 31).

Table:

```text
checkout_requests
```

Fields:

```text
request_id
request_fingerprint
payment_method_snapshot
intended_total_cents
clover_approved_confirmed_at
sale_id
status
failure_code
resolution_status
resolution_note
created_at
completed_at
failed_at
resolved_at
```

Purpose:

Prevents the same checkout request from generating multiple sales, and durably records enough evidence of a Card checkout attempt to support reconciliation if the local commit fails.

---

# 33. Checkout Requests Table

Required for V1 because duplicate sale prevention is a MUST requirement, and because Card-payment reconciliation evidence (Section 31A) must be captured independently of whether the sale transaction succeeds.

Table:

```text
checkout_requests
```

Fields:

```text
request_id
request_fingerprint
payment_method_snapshot
intended_total_cents
clover_approved_confirmed_at
sale_id
status
failure_code
resolution_status
resolution_note
created_at
completed_at
failed_at
resolved_at
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

A deterministic digest of the normalized checkout intent, composed as specified in Section 41B. Reusing a request ID with different checkout content must fail safely rather than return an unrelated sale.

---

### payment_method_snapshot

Type:

```text
TEXT
```

Required:

Yes

Allowed values:

```text
CASH
CARD
```

Recorded at Phase 1, Step A (Section 31) — before Clover is ever invoked for Card — so it survives a Step B or Phase 2 failure.

---

### intended_total_cents

Type:

```text
INTEGER
```

Required:

Yes

Purpose:

The final total the cashier reviewed and, for Card, the amount that will be processed on Clover. Recorded at Phase 1, Step A — before the cashier is sent to Clover — so it is available even if Clover approval is never confirmed or Phase 2 never produces a `sales` row. For Card these are the same value: Step A rejects the attempt (Section 31; `CHECKOUT_DRIFT`) if the reviewed fingerprint no longer matches current authoritative state, so `intended_total_cents` is only ever recorded when the current recalculated total *is* the reviewed total.

---

### clover_approved_confirmed_at

Type:

```text
TEXT
```

Required:

Only once `status` has advanced past `PENDING_PAYMENT` for a Card attempt (i.e., `SUBMITTED`, `COMPLETED`, or `COMMIT_FAILED` reached via a successful Step B). `NULL` while `status = PENDING_PAYMENT`, and always `NULL` for Cash.

Purpose:

Timestamp of the cashier's explicit confirmation that Clover approved the charge, captured by Phase 1 Step B — after Clover has responded but before Phase 2 is attempted. This is the durable evidence required by Section 31A. The application must never populate this field except in direct response to that confirmation.

---

### sale_id

Type:

```text
TEXT
```

Required:

Only when `status = COMPLETED`.

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
PENDING_PAYMENT
SUBMITTED
COMPLETED
COMMIT_FAILED
```

`PENDING_PAYMENT` exists only for Card and is written by Phase 1 Step A before the cashier is instructed to process Clover; it means "a checkout is durably on record, but no payment confirmation has been received yet." `SUBMITTED` is reached either directly (Cash, at Step A) or via Phase 1 Step B once Card approval is confirmed; it means the row is **currently eligible for Phase 2**. A successful Phase 2 commit advances the same row to `COMPLETED` with `sale_id`. A failed Phase 2 — or a failed Step B confirmation write — advances the same row to `COMMIT_FAILED` with `failure_code` where that transition itself can be durably written. "A failed Phase 2" is not only an unexpected/storage commit failure: a trusted revalidation rejection (checkout drift, insufficient stock, a product archived since review, tax rate or business identity no longer configured) also rolls the authoritative transaction back with nothing written and is recorded the same way, carrying a specific `failure_code` rather than `SALE_COMMIT_FAILED` (Section 31 "Phase 2 failure — record the outcome"; `SUPPORT_DIAGNOSTICS.md` Section 42). A row therefore does not stay `SUBMITTED` once Phase 2 has rejected it; re-reviewing materially changed content produces a new fingerprint and a new `request_id` (Section 34), and the `COMMIT_FAILED` row remains as evidence of the superseded attempt. For a Cash request, `COMMIT_FAILED` is terminal/retry evidence only and never by itself a reconciliation incident (Section 31B is Card-only). Unlike the sale transaction itself, none of these status transitions on the `checkout_requests` row are rolled back together with a failed sale/confirmation attempt — each is written as its own separate, best-effort or independently-committed update specifically so it survives.

No additional state is introduced beyond `PENDING_PAYMENT`: Cash checkout never uses it, and Card checkout only passes through it briefly between review and Clover approval.

---

### failure_code

Type:

```text
TEXT
```

Required:

Only when `status = COMMIT_FAILED`.

Purpose:

Stable, sanitized error code identifying why Phase 2 failed, why the Phase 1 Step B confirmation write failed, or (`CLOVER_DECLINED`) that the cashier explicitly recorded a Clover decline/cancel rather than a failure — see `SUPPORT_DIAGNOSTICS.md` error codes. `CLOVER_DECLINED` is excluded from the Reconciliation Queue (Section 31B); every other value represents a genuine incident.

---

### resolution_status

Type:

```text
TEXT
```

Required:

No

Allowed values:

```text
UNRESOLVED
RESOLVED
```

Only meaningful for a row surfaced in the Reconciliation Queue (Section 31B): `status = COMMIT_FAILED`, or `status = PENDING_PAYMENT` past the staleness window. Defaults to `UNRESOLVED`.

---

### resolution_note

Type:

```text
TEXT
```

Required:

Only when `resolution_status = RESOLVED`.

Purpose:

Staff-entered explanation of how a Card commit-failure incident was reconciled (Section 31B).

---

### created_at / completed_at / failed_at / resolved_at

Type:

```text
TEXT
```

Required:

`created_at` is always required. The others are required only when the corresponding state has been reached.

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

If the same request ID is submitted with a different `request_fingerprint`, the application must reject it as an idempotency-key conflict (Section 31, Phase 1, step 1).

If the same request ID is submitted again after a prior `COMMIT_FAILED` outcome, and the fingerprint matches, the application attempts Phase 2 again against the existing row (Section 31A retry behavior) rather than treating it as a conflict. This is the correct retry path for a transient/storage `COMMIT_FAILED` (`SALE_COMMIT_FAILED`) once the underlying problem clears. When the failure was a re-review rejection instead (the checkout content materially changed), the cashier re-reviews and that review carries a **new `request_id`** and a new fingerprint; the earlier `COMMIT_FAILED` row is not reused and stays as evidence of the superseded attempt. Submitting a *different* fingerprint against the earlier `request_id` remains an idempotency-key conflict.

---

# 35. Foreign Key Relationships

Expected relationships, with explicit `ON DELETE` behavior. V1 has no UI path that hard-deletes a product, customer, or sale (Section 36), so most of these actions are defensive rather than routinely exercised — but the action must still be unambiguous so a migration author never has to guess, and so historical sale data can never disappear as a side effect of deleting a product or customer.

| Relationship | `ON DELETE` | Rationale |
|---|---|---|
| `sales.customer_id → customers.id` | `SET NULL` | `customer_id` is already optional; the sale's `customer_name_snapshot`/`customer_phone_snapshot` independently preserve who the customer was, so losing the live link must not block or cascade-delete the sale. |
| `sale_items.sale_id → sales.id` | `RESTRICT` | Sale items must never be orphaned or silently cascade-deleted; sales are not hard-deleted in normal operation. |
| `sale_items.product_id → products.id` | `RESTRICT` | A product referenced by historical sale items cannot be deleted; it must be archived instead (Section 8, `is_active = 0`). |
| `payments.sale_id → sales.id` | `RESTRICT` | Payment history must never be dropped as a side effect of a sale row change. |
| `inventory_movements.product_id → products.id` | `RESTRICT` | Movement history must survive; archive the product instead of deleting it. |
| `inventory_movements.sale_id → sales.id` | `RESTRICT` | Preserves the link between a sale and its stock effects. |
| `inventory_movements.reverses_movement_id → inventory_movements.id` | `RESTRICT` | A reversed movement must remain in place for as long as its reversal exists. |
| `google_sheet_export_jobs.sale_id → sales.id` | `CASCADE` | The export job is secondary synchronization metadata, not a business record; if its sale were ever removed the job has no independent meaning. |
| `checkout_requests.sale_id → sales.id` | `RESTRICT` | Preserves idempotency and reconciliation evidence (Section 31A) tied to a completed sale. |

SQLite foreign key enforcement (`PRAGMA foreign_keys = ON`, Section 54) must be enabled for every connection, since SQLite does not enforce declared foreign keys by default.

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
sequence
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
CARD_LOCAL_COMMIT_FAILURE
AUTH_CREDENTIAL_CHANGED
```

```text
id       TEXT    PRIMARY KEY
sequence INTEGER NOT NULL UNIQUE
```

`id` remains the sole primary key and immutable event identity — a UUID-style text identifier, consistent with Section 3, used for foreign references, correlation, and lookup. `sequence` is a separate, strictly increasing local ordering field (`INTEGER NOT NULL UNIQUE`, not a second primary key — SQLite allows only one primary key per table) used purely as the authoritative **ordering** key for display, diagnostics, and any "what happened before what" question. `occurred_at` remains the wall-clock business timestamp used for reporting and is what a person reads, but it is not trusted for ordering because `SUPPORT_DIAGNOSTICS.md` Section 33 (clock-change awareness, `REQ-HEALTH-002`) anticipates a system clock that can jump backward or forward. `sequence` cannot jump: two events are ordered by `sequence` regardless of what `occurred_at` says. `sequence` is consulted specifically when wall-clock order is unreliable (a detected or suspected clock anomaly); ordinary chronological display may still present `occurred_at` for readability. No distributed/multi-device ordering scheme is introduced in V1 — this is purely a local monotonic counter, sufficient for a single-machine deployment.

`sequence` values are allocated the same way `receipt_number` values are (Section 29): a dedicated `counters` row (key `audit_sequence`) is read and incremented within the same SQLite transaction that inserts the `audit_events` row, and the incremented value becomes that row's `sequence`. When the audit event is part of a larger business transaction (e.g., `SALE_COMPLETED`), this counter increment is part of that same transaction and rolls back with it, exactly like the receipt-number counter — no `sequence` value is ever assigned to an event that does not durably commit. When an audit event is written independently (e.g., `BACKUP_COMPLETED`), the counter increment and the audit-event insert are committed together in their own small transaction. This reuses an existing, already-understood atomic-allocation mechanism rather than introducing a new one.

`actor_type` identifies `USER` or `SYSTEM`; `actor_identifier` may be null where V1's shared login cannot identify an individual. `subject_type` and `subject_id` identify the affected sale, product, setting, backup, migration, checkout request, or update when applicable. `correlation_id` links the event to related checkout, void, export, backup, migration, or update diagnostics. `details_json` may contain only schema-validated, sanitized context and must not contain secrets or unnecessary customer PII.

`id`, `sequence`, `event_type`, `occurred_at`, `actor_type`, `outcome`, and `app_version` are required. Allowed `outcome` values are `SUCCESS` and `FAILURE`; subject, correlation, reason, and detail fields are optional except where the workflow requires them. In particular, `SALE_VOIDED` requires the Sale ID as its subject and the staff-entered void reason, and `CARD_LOCAL_COMMIT_FAILURE` requires the `checkout_requests.request_id` as its subject.

For a lifecycle-marker event whose name describes the *start* of a multi-step process rather than its result — currently only `MIGRATION_STARTED` — `outcome` describes whether that discrete action (durably recording that the migration began) itself succeeded, which in practice is always `SUCCESS`; it makes no claim about the eventual migration result. The eventual result is separately and unambiguously recorded by the terminal event that follows: `MIGRATION_COMPLETED` (`outcome = SUCCESS`) or `MIGRATION_FAILED` (`outcome = FAILURE`). This is the same two-value `outcome` enum used everywhere else; no third value is introduced, and no `MIGRATION_STARTED` row is ever left to imply an in-progress migration eventually failed or succeeded — only its paired terminal event says that.

Audit events are append-only. Normal application workflows must not update or delete them. `SALE_COMPLETED` and any `PRICE_OVERRIDE` events must commit with checkout, and `SALE_VOIDED` must commit with the void and its reversing inventory movements. Other authoritative business changes must commit their corresponding audit event with the change whenever SQLite is available.

Migration execution records `MIGRATION_STARTED` before applying schema changes, then records `MIGRATION_COMPLETED` after success or `MIGRATION_FAILED` after rollback/recovery when the database remains writable. `UPDATE_INSTALLED` represents a successfully installed update; failed update attempts remain diagnostic-log events unless an authoritative state change occurs. `CARD_LOCAL_COMMIT_FAILURE` represents the Priority 0 reconciliation case defined in Section 31A and is written on a best-effort basis whenever SQLite can accept it. `AUTH_CREDENTIAL_CHANGED` covers both first-run shared-password creation and subsequent password changes (`ARCHITECTURE.md` Section 28).

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
location_kind
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

Allowed `location_kind` values:

```text
LOCAL_DISK
OFF_DEVICE
```

`location_kind` records whether the backup file was written to the same physical machine/disk (`LOCAL_DISK`, the V1 default for every automatic and pre-migration backup) or to a separately configured off-device destination (`OFF_DEVICE`, optional in V1 — e.g., a distinct external/USB drive or a network path the owner configures for manual/automatic backups). This distinction exists so backup health reporting and documentation never overstate what a given backup protects against (Section 23 of `PRODUCT_SCOPE.md`, Section 37 of `ARCHITECTURE.md`).

Allowed `status` values:

```text
COMPLETED
FAILED
```

Successful records require the file identity, source versions, size, checksum, `location_kind`, and completion timestamp. `target_app_version` is required for a pre-migration backup and may be null otherwise. Failed records require a stable, sanitized `error_code`; file metadata may be null when no valid backup was produced.

For a schema migration that modifies an **existing initialized database**, a pre-migration backup (`backup_type = PRE_MIGRATION`) must reach `COMPLETED` and its `backup_records` row must be durably recorded before that migration's changes (DDL) begin; if it cannot, the migration must not begin. The first migration (`001_initial_schema`), which creates a brand-new empty database, is **bootstrap initialization**: it is not preceded by a pre-migration backup and records no `backup_records` row, because `backup_records` — like every other table — does not exist until `001_initial_schema` has run, and there is no prior authoritative state to recover. Backup files live outside the active SQLite database so recovery remains possible if that database becomes unusable.

The backup record and matching `BACKUP_COMPLETED` or `BACKUP_FAILED` audit event must be committed together when SQLite is writable.

## V1 Default Cadence and Retention

- Automatic backups run daily at a configurable default time (`03:00` local business time).
- Automatic (`LOCAL_DISK`) backups are retained for the most recent 14 days; manual backups are retained for 90 days. Retention cleanup never removes the only verified usable backup, and never removes a backup still required for an active migration or recovery case (`REQ-BACKUP-006`).
- These defaults are configurable; the values above are the documented V1 defaults used when no other value is configured, so tests and behavior remain deterministic without requiring the owner to configure anything first.

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

V1 has no separate discount feature — no percentage discount, fixed-amount discount, coupon code, or order-level discount exists. "Discount" is a derived, display-only value computed as the difference between listed and sold price. The only pricing mechanism is negotiated per-line selling price (Section 5, `POS_WORKFLOWS.md` Section 21).

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

A negotiated selling price may be set below, equal to, or above the listed price (e.g., to correct a mispriced item); V1 does not reject an above-listed override. The discount is clamped at zero rather than becoming negative:

```text
line_discount_cents = max(0, listed_price_cents - sold_price_cents) × quantity
```

When `sold_price_cents > listed_price_cents`, `discount_cents = 0` for that line; there is no "negative discount" or markup concept surfaced to the customer.

The trusted application layer derives every discount value from listed and sold prices; it never trusts an arbitrary client-submitted discount or total.

---

# 41A. Numeric Bounds and Duplicate Line Aggregation

## Duplicate Line Aggregation

Before stock validation, the trusted application layer aggregates cart lines by `product_id`: if the same product appears in more than one line (for example, added twice with different negotiated prices), the quantities for that product are summed and validated against `quantity_on_hand` as a single total. A cashier cannot bypass the stock check by splitting one product's requested quantity across multiple cart lines. Each original line is still stored as its own `sale_items` row with its own `sold_price_cents`; only the *stock validation* is aggregated per product.

## Quantity Bounds

- Quantity must be a positive integer. Fractional or non-numeric quantity input is rejected at the trusted application boundary before it reaches SQLite.
- Per-line quantity is bounded at `1`–`999`. A request outside this range is rejected with a clear validation error rather than silently clamped.
- The aggregated per-product quantity (after duplicate-line aggregation, above) is subject to the same `999` ceiling in addition to the `quantity_on_hand` check.

## Monetary Bounds

- All persisted per-unit price fields (`selling_price_cents`, `cost_price_cents`, `listed_price_cents`, `sold_price_cents`) must be non-negative integers not exceeding `9,999,999` cents ($99,999.99).
- The sale-level total (`sales.total_cents`) must be a non-negative integer not exceeding `99,999,999` cents ($999,999.99). A cart that would exceed this ceiling is rejected before commit with a clear validation error rather than silently truncated.
- These ceilings exist to reject fat-finger entry and keep every monetary calculation safely within the JavaScript/SQLite safe-integer range; they are not expected to be reached by ordinary phone retail and may be revisited if the business genuinely needs higher values.
- Malformed numeric input (non-numeric strings, `NaN`, `Infinity`, values with more than two implied decimal places once converted to cents) is rejected at the trusted application boundary; the renderer must never be trusted to have already validated it.

---

# 41B. Checkout Fingerprint and Drift Detection

`checkout_requests.request_fingerprint` (Section 33) is a deterministic digest computed by the trusted application layer, immediately before Phase 1 (Section 31), over the normalized checkout intent the cashier reviewed:

```text
- customer_id (or null)
- cart lines, canonically ordered (see below): { product_id, listed_price_cents, sold_price_cents, quantity }
- reviewed tax_rate_bps
- reviewed subtotal_cents, discount_cents, taxable_amount_cents, tax_cents, total_cents
- payment_method
```

## Canonical Line Ordering

V1 allows the same `product_id` to appear on more than one cart line with different negotiated prices (Section 41A), so ordering lines by `product_id` alone is not sufficient — it does not define a stable relative order among lines that share a product ID, meaning the same logical cart could serialize differently (and therefore fingerprint differently) depending only on incidental renderer/cart insertion order.

Cart lines are instead sorted by the full stable tuple, applied in this fixed field order:

```text
(product_id, listed_price_cents, sold_price_cents, quantity)
```

This tuple is sorted ascending, field by field, exactly like a compound database `ORDER BY`. Because the sort key is derived entirely from each line's own content — never from insertion order, a client-side line index, or any other incidental detail — two carts containing the same multiset of line tuples always produce the identical sorted sequence and therefore the identical fingerprint, regardless of the order in which the cashier or renderer added them. Two carts whose line tuples actually differ in `product_id`, either price, or `quantity` sort differently (or contain a different tuple outright) and therefore fingerprint differently.

Lines with identical tuples (the same product added twice at the same price and quantity) remain two separate entries in the serialized sequence — canonical ordering never merges or deduplicates lines, and it never changes the fact that stock validation separately aggregates quantity by `product_id` (Section 41A) while the sale's individual line rows remain distinct in `sale_items`.

## Drift Detection

At Phase 2 (Section 31), the trusted application layer independently recalculates every one of these values from current authoritative state: current product `is_active`/`quantity_on_hand`, the currently configured `tax_rate_bps`, and the submitted line prices — canonically ordered the same way before comparison. If any recalculated authoritative value differs from the value captured in the reviewed fingerprint above — including a configured tax-rate change between review and submission, a product archived or price-changed after the cart was built, or a stock level that has since changed — Phase 2 rejects the attempt with a "checkout details changed, please review again" error rather than silently committing different financial values. The cashier must re-review the cart (a new fingerprint is computed) before retrying.

For Card payments this rule is strict: the `total_cents` the cashier actually processed on Clover (`checkout_requests.intended_total_cents`) must equal the authoritative recalculated `sales.total_cents` exactly, or Phase 2 is rejected rather than committing a sale for a different amount than was charged. For Card, this fingerprint equality is additionally enforced once **before** payment, at Phase 1 Step A (Section 31): if the fingerprint recomputed from current state does not match the reviewed fingerprint, Step A rejects with `CHECKOUT_DRIFT` before writing `PENDING_PAYMENT` or showing any Clover instruction, so the cashier is never told to process an amount Checkout Review did not show. The Phase 2 check above still runs afterward as the final gate.

---

# 42. Tax Calculation Model

Authoritative tax calculations must happen in trusted application/domain logic. Renderer-calculated totals are previews only.

## Calculation Basis

Tax is calculated **once, at the transaction level**, not per line. `sale_items` carries no per-line tax field; only `sales.tax_cents` exists. The taxable amount is the sum of every line's post-discount (sold-price) total across the whole sale:

```text
taxable_amount_cents = Σ (sold_price_cents × quantity)   for every line
```

Price negotiation/override is applied before tax: the taxable amount always uses `sold_price_cents` (the negotiated price), never `listed_price_cents`. There is no order-level discount to apply on top (Section 41), so no further discount step occurs between subtotal and taxable amount for V1.

## Rounding Rule

Tax is computed once against the transaction-level `taxable_amount_cents`, using integer arithmetic and **round-half-up** to the nearest cent (never floating point):

```text
tax_cents = floor( (taxable_amount_cents × tax_rate_bps + 5000) / 10000 )
```

`+ 5000` (half of the `10000` bps denominator) implements round-half-up in pure integer arithmetic: a fractional remainder of exactly `.5` cents rounds up. This is the one rounding rule used everywhere tax is shown or persisted — checkout preview, the committed sale, sales history, receipts, reports, and the Google Sheets export — so a receipt, a report, and the exported row are always consistent for the same sale.

```text
total_cents = taxable_amount_cents + tax_cents
```

## Worked Examples

| `taxable_amount_cents` | `tax_rate_bps` | Exact tax (cents) | `tax_cents` (rounded) |
|---|---|---|---|
| 55000 | 825 (8.25%) | 4537.5 | 4538 |
| 33 | 825 (8.25%) | 2.7225 | 3 |
| 30 | 825 (8.25%) | 2.475 | 2 |
| 10 | 500 (5.00%) | 0.50 (exact half-cent) | 1 |
| 100 | 825 (8.25%) | 8.25 | 8 |
| 0 | 825 (8.25%) | 0 | 0 |

The `10` / `500` bps row is the fractional-cent boundary case: an exact half-cent (`0.50`) rounds **up** to `1`, demonstrating round-half-up rather than round-half-even ("banker's rounding") or truncation.

Example end-to-end (matches Section 61's example sale): `taxable_amount_cents = 55000`, `tax_rate_bps = 825` → `tax_cents = 4538` → `total_cents = 59538`.

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

By default every V1 backup (`backup_records.location_kind = LOCAL_DISK`) is written to the same physical machine as the operational database. This protects against accidental deletion, application-level corruption, and a bad migration, but it does **not** protect against loss of the machine or its disk (theft, fire, hardware failure) — see `PRODUCT_SCOPE.md` Section 23 and `ARCHITECTURE.md` Section 37 for the exact guarantee split and the optional off-device (`OFF_DEVICE`) configuration.

---

# 52A. Restore Safety

A whole-database restore is a destructive operation and must not silently discard newer business records than the backup being restored. The trusted application layer:

1. Before touching the active database, creates a SQLite-consistent snapshot/backup copy (Section 54, "Backup and Recovery-Copy Safety Under WAL" — not a raw copy of the live main file) of the **current** (pre-restore) database at a timestamped recovery location (e.g., `gophones-pre-restore-<timestamp>.sqlite`) so today's state is never lost even if the wrong backup is chosen.
2. Reads the candidate backup's metadata (`backup_records`, or the equivalent metadata embedded alongside a backup file selected from outside `backup_records`, e.g., one copied in from an external drive) — its schema version, source app version, and creation timestamp — without yet replacing anything.
3. Compares the backup's creation timestamp and the latest `sales.completed_at` it contains against the **current** database's latest `sales.completed_at`. If the current database contains completed sales newer than the backup, the restore would discard them.
4. If the current database is newer, the UI clearly warns the user how many transactions (and their date range) would be lost, and requires an explicit, unambiguous confirmation before proceeding — restoring an older backup over newer data is never a silent or default-confirmed action.
5. Only after confirmation does the trusted layer replace the active database with the backup, then validates the restored database (schema version, foreign keys, critical tables readable) before reopening checkout.
6. If restored-database validation fails, the pre-restore recovery copy from step 1 is used to restore the original database, and the failure is reported with a stable error code.

V1 does not implement record-level merge between the current database and a restored backup — this is a whole-database replace-or-abort operation, not a reconciliation feature. The pre-restore recovery copy (step 1) is the safety net if the wrong backup is selected or validation fails. Restore is an exclusive maintenance operation (`ARCHITECTURE.md` Section 42.3) and cannot begin during an active or in-flight checkout.

---

# 53. Data Integrity Constraints

The database should enforce as many invariants as reasonably possible.

Examples:

```text
product quantity >= 0
prices >= 0 and <= 9,999,999 cents (Section 41A)
sale total >= 0 and <= 99,999,999 cents (Section 41A)
payment amount >= 0
sale item quantity > 0 and <= 999 (Section 41A)
receipt number UNIQUE
barcode UNIQUE when present (trimmed, blank -> NULL; Section 7)
SKU UNIQUE when present (trimmed, blank -> NULL; Section 7)
one export job per sale
one payment per sale
one checkout request per completed sale
one reversal per original sale movement
VOIDED sales require voided_at and void_reason
audit events are append-only
audit_events.sequence NOT NULL and UNIQUE, allocated only via the counters.audit_sequence pattern (Sections 29-30, 36A)
condition/status/movement_type/payment method restricted to their documented enum values (Sections 7, 11, 15, 17)
```

Application logic supplements these constraints.

---

# 54. SQLite Configuration

The product promises crash/power-loss safety (`REQ-REL-002`, `REQ-HEALTH-004`), so V1 fixes a concrete SQLite durability policy rather than leaving it to be decided during implementation:

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA synchronous = FULL
PRAGMA busy_timeout = 5000
```

- **Journal mode: WAL.** Write-ahead logging allows readers (e.g., reports, sales history) to proceed without blocking on the writer used by checkout, and gives well-understood crash-recovery semantics.
- **Synchronous: FULL.** V1 prioritizes durability over raw write throughput given the expected transaction volume (~50 products, modest daily sale count). `FULL` ensures a checkout commit is flushed to durable storage before the application reports success, so a power loss immediately after a reported commit cannot lose that transaction. `NORMAL` is not used in V1 because, in WAL mode, `NORMAL` can lose the most recent commits after a power loss (though the database itself remains structurally consistent); that trade-off is unacceptable for a POS whose central invariant is that a reported sale is never lost.
- **Busy timeout: 5000 ms.** Since Section 55 already requires checkout to acquire a write transaction (`BEGIN IMMEDIATE`) even though V1 is single-machine/single-user, a 5-second busy timeout absorbs brief contention (e.g., a backup or export-worker read) without surfacing a spurious failure to the cashier.
- **Checkout transactions** use `BEGIN IMMEDIATE` (Sections 31, 55) so a writer acquires the write lock up front rather than discovering a conflict mid-transaction.
- **Checkpointing.** WAL is checkpointed automatically by SQLite's default auto-checkpoint behavior. This keeps the WAL file bounded during normal operation, but a manual checkpoint immediately before a copy is **not**, by itself, a safe backup mechanism (see below) — a writer (checkout) could still open and begin a new transaction between the checkpoint and the copy finishing, since nothing blocks it.

## Backup and Recovery-Copy Safety Under WAL

> A backup or pre-restore recovery copy must be created using a SQLite-consistent snapshot/backup procedure. Copying only the live main database file while SQLite connections/WAL activity may exist is prohibited.

Because V1 runs in WAL mode, the durable state of the database is split across the main `.sqlite` file and its `-wal`/`-shm` companion files, and a writer can begin a new transaction between a checkpoint and a naive file copy. Copying only the main `.sqlite` file — even immediately after a `wal_checkpoint` — is not guaranteed to be transactionally consistent and is prohibited as a backup mechanism for automatic, manual, and pre-migration backups, and for the pre-restore recovery copy (Section 52A).

A valid mechanism is either of the following:

- **The SQLite Online Backup API**, exposed by the selected binding (`better-sqlite3`'s `Database.prototype.backup()`, confirmed present and callable in Section 3 of `ARCHITECTURE.md`) — the intended V1 mechanism, producing a transactionally consistent copy while the database remains open and usable, including under concurrent read/write activity. The actual backup workflow (scheduling, retries, verification) is not implemented until the backup feature itself is built; this section only fixes which mechanism it must use; or
- **A raw file copy taken only after the database connection has been safely quiesced or closed** and any WAL content has been fully checkpointed back into the main file (`PRAGMA wal_checkpoint(TRUNCATE)` followed by verifying the WAL is empty, with no writer permitted to open a new transaction until the copy completes) — this is only safe for a maintenance-window operation (e.g., during exclusive backup/restore/migration coordination, `ARCHITECTURE.md` Section 42.3), never as a "copy the file while checkout might still be running" shortcut.

This rule applies identically to:

- Automatic backups (Section 36B, `backup_type = AUTOMATIC`)
- Manual backups (`backup_type = MANUAL`)
- Pre-migration backups (`backup_type = PRE_MIGRATION`)
- The pre-restore recovery copy (Section 52A, step 1)

The existing WAL + `synchronous = FULL` durability policy for the live operational database is unchanged by this rule — this section governs how a *separate copy* of the database is produced, not how the operational database itself is written.

## Supported Filesystem Assumption

These guarantees hold only when the database file resides on a **local, directly attached filesystem** (an internal or directly connected external drive using NTFS or an equivalent locally-mounted filesystem) on the machine running Go Phones POS, per the application-data location rules in `ARCHITECTURE.md` Section 13. V1 explicitly does **not** promise equivalent crash-safety or locking guarantees when the database file's directory is:

- A network drive or UNC path (SMB/NFS), where `fsync`/locking semantics are not reliably guaranteed by the network filesystem.
- A folder synchronized by cloud-sync software (OneDrive, Dropbox, Google Drive Desktop, etc.), where a background sync process can read or move the file out from under SQLite's locking model and corrupt the WAL/database pairing.

The installer and startup health check should avoid placing the database inside a known cloud-sync folder; this is a documented V1 constraint rather than an enforced runtime block, and is a candidate `SUPPORT_DIAGNOSTICS.md` health warning if a sync-folder path is detected.

This SQLite configuration decision is covered by the crash/abrupt-termination tests in `TEST_PLAN.md` (`TEST-CRASH-*`, `TEST-REL-003`) rather than left as an implementation-time assumption.

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
