import type { Migration } from '../types';

/**
 * Canonical V1 initial schema (`DATA_MODEL.md`).
 *
 * This migration creates the **complete** V1 logical data model — every table,
 * constraint, index, and deterministic seed row the canonical spec defines —
 * not merely what the next UI slice needs. The feature services that use these
 * tables (products, checkout, void, export worker, backup, …) are NOT part of
 * this phase; only the persistence structure is.
 *
 * Field types, `CHECK`/enum constraints, foreign-key `ON DELETE` actions
 * (`DATA_MODEL.md §35`), the SKU/barcode "unique when present, NULL when blank,
 * case-sensitive" rule (`§6`), and the required indexes (`§37`) all come from
 * the canonical spec.
 */

const SCHEMA_SQL = /* sql */ `
-- ── Migration history (§27) ───────────────────────────────────────────────────
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
);

-- ── Counters (§29, §30) ───────────────────────────────────────────────────────
-- 'value' is the last allocated value; the next allocation is value + 1.
CREATE TABLE counters (
  key        TEXT    PRIMARY KEY,
  value      INTEGER NOT NULL CHECK (value >= 0),
  updated_at TEXT    NOT NULL
);

-- ── Products (§7, §8) ─────────────────────────────────────────────────────────
CREATE TABLE products (
  id                  TEXT    PRIMARY KEY,
  sku                 TEXT    CHECK (sku IS NULL OR (sku = trim(sku) AND length(sku) > 0)),
  barcode             TEXT    CHECK (barcode IS NULL OR (barcode = trim(barcode) AND length(barcode) > 0)),
  name                TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  brand               TEXT    NOT NULL CHECK (length(trim(brand)) > 0),
  model               TEXT    NOT NULL CHECK (length(trim(model)) > 0),
  condition           TEXT    NOT NULL CHECK (condition IN ('NEW', 'USED', 'REFURBISHED')),
  cost_price_cents    INTEGER CHECK (cost_price_cents IS NULL OR (cost_price_cents >= 0 AND cost_price_cents <= 9999999)),
  selling_price_cents INTEGER NOT NULL CHECK (selling_price_cents >= 0 AND selling_price_cents <= 9999999),
  quantity_on_hand    INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  low_stock_threshold INTEGER CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
-- Unique only when present, so multiple NULL SKUs/barcodes never collide (§6).
-- Default BINARY collation keeps the comparison case-sensitive (§6).
CREATE UNIQUE INDEX ux_products_sku ON products (sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX ux_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_name ON products (name);
CREATE INDEX idx_products_brand ON products (brand);
CREATE INDEX idx_products_model ON products (model);
CREATE INDEX idx_products_is_active ON products (is_active);

-- ── Customers (§9, §10) ───────────────────────────────────────────────────────
CREATE TABLE customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone            TEXT CHECK (phone IS NULL OR (phone = trim(phone) AND length(phone) > 0)),
  phone_normalized TEXT CHECK (
                     phone_normalized IS NULL
                     OR (length(phone_normalized) > 0 AND phone_normalized NOT GLOB '*[^0-9]*')
                   ),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- phone_normalized exists exactly when phone exists (§9).
  CHECK ((phone IS NULL) = (phone_normalized IS NULL))
);
CREATE INDEX idx_customers_phone_normalized ON customers (phone_normalized);
CREATE INDEX idx_customers_name ON customers (name);

-- ── Sales (§11, §12, §44-49) ──────────────────────────────────────────────────
CREATE TABLE sales (
  id                          TEXT    PRIMARY KEY,
  receipt_number              TEXT    NOT NULL UNIQUE,
  customer_id                 TEXT    REFERENCES customers (id) ON DELETE SET NULL,
  customer_name_snapshot      TEXT,
  customer_phone_snapshot     TEXT,
  business_name_snapshot      TEXT    NOT NULL,
  business_address_snapshot   TEXT    NOT NULL,
  business_phone_snapshot     TEXT    NOT NULL,
  receipt_disclaimer_snapshot TEXT    NOT NULL,
  receipt_footer_snapshot     TEXT    NOT NULL,
  status                      TEXT    NOT NULL CHECK (status IN ('COMPLETED', 'VOIDED')),
  sync_version                INTEGER NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  subtotal_cents              INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents              INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  taxable_amount_cents        INTEGER NOT NULL CHECK (taxable_amount_cents >= 0),
  tax_rate_bps                INTEGER NOT NULL CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 100000),
  tax_cents                   INTEGER NOT NULL CHECK (tax_cents >= 0),
  total_cents                 INTEGER NOT NULL CHECK (total_cents >= 0 AND total_cents <= 99999999),
  payment_method_snapshot     TEXT    NOT NULL CHECK (payment_method_snapshot IN ('CASH', 'CARD')),
  created_at                  TEXT    NOT NULL,
  completed_at                TEXT    NOT NULL,
  voided_at                   TEXT,
  void_reason                 TEXT,
  -- Void-field consistency (§53, TEST-DB-015).
  CHECK (
    (status = 'COMPLETED' AND voided_at IS NULL AND void_reason IS NULL)
    OR
    (status = 'VOIDED' AND voided_at IS NOT NULL AND void_reason IS NOT NULL AND length(trim(void_reason)) > 0)
  ),
  -- Customer snapshot consistency (§44-49): when a customer is attached, the
  -- name snapshot is required. The reverse is NOT enforced — an ON DELETE SET
  -- NULL on customer_id (§35) deliberately keeps the snapshots so historical
  -- receipts survive the customer being deleted. The phone snapshot may be NULL
  -- because a customer's phone is optional (§9, TEST-CUST-008).
  CHECK (
    customer_id IS NULL
    OR (customer_name_snapshot IS NOT NULL AND length(trim(customer_name_snapshot)) > 0)
  ),
  -- Transaction-level total relationship (§42).
  CHECK (total_cents = taxable_amount_cents + tax_cents)
);
CREATE INDEX idx_sales_completed_at ON sales (completed_at);
CREATE INDEX idx_sales_customer_id ON sales (customer_id);
CREATE INDEX idx_sales_status ON sales (status);

-- ── Sale items (§13, §14, §41) ────────────────────────────────────────────────
CREATE TABLE sale_items (
  id                    TEXT    PRIMARY KEY,
  sale_id               TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
  product_id            TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  product_name_snapshot TEXT    NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
  brand_snapshot        TEXT    NOT NULL,
  model_snapshot        TEXT    NOT NULL,
  condition_snapshot    TEXT    NOT NULL CHECK (condition_snapshot IN ('NEW', 'USED', 'REFURBISHED')),
  sku_snapshot          TEXT,
  barcode_snapshot      TEXT,
  listed_price_cents    INTEGER NOT NULL CHECK (listed_price_cents >= 0 AND listed_price_cents <= 9999999),
  sold_price_cents      INTEGER NOT NULL CHECK (sold_price_cents >= 0 AND sold_price_cents <= 9999999),
  discount_cents        INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  quantity              INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 999),
  line_subtotal_cents   INTEGER NOT NULL CHECK (line_subtotal_cents >= 0),
  line_total_cents      INTEGER NOT NULL CHECK (line_total_cents >= 0),
  created_at            TEXT    NOT NULL,
  -- Line arithmetic (§13, §41, TEST-DB-013).
  CHECK (line_subtotal_cents = listed_price_cents * quantity),
  CHECK (line_total_cents = sold_price_cents * quantity),
  CHECK (discount_cents = max(0, listed_price_cents - sold_price_cents) * quantity)
);
CREATE INDEX idx_sale_items_sale_id ON sale_items (sale_id);
CREATE INDEX idx_sale_items_product_id ON sale_items (product_id);

-- ── Payments (§15, §16) ───────────────────────────────────────────────────────
CREATE TABLE payments (
  id           TEXT    PRIMARY KEY,
  sale_id      TEXT    NOT NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT,
  method       TEXT    NOT NULL CHECK (method IN ('CASH', 'CARD')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 99999999),
  status       TEXT    NOT NULL CHECK (status IN ('COMPLETED')),
  created_at   TEXT    NOT NULL
);

-- ── Inventory movements (§17, §18) ────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id                   TEXT    PRIMARY KEY,
  product_id           TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  sale_id              TEXT    REFERENCES sales (id) ON DELETE RESTRICT,
  movement_type        TEXT    NOT NULL CHECK (movement_type IN ('SALE', 'VOID_REVERSAL', 'MANUAL_ADJUSTMENT', 'INITIAL_STOCK')),
  reverses_movement_id TEXT    REFERENCES inventory_movements (id) ON DELETE RESTRICT,
  quantity_change      INTEGER NOT NULL CHECK (quantity_change <> 0),
  quantity_before      INTEGER NOT NULL CHECK (quantity_before >= 0),
  quantity_after       INTEGER NOT NULL CHECK (quantity_after >= 0),
  reason               TEXT,
  created_at           TEXT    NOT NULL,
  CHECK (quantity_after = quantity_before + quantity_change),
  -- sale_id is required for SALE / VOID_REVERSAL and absent otherwise (§17).
  CHECK (
    (movement_type IN ('SALE', 'VOID_REVERSAL') AND sale_id IS NOT NULL)
    OR
    (movement_type IN ('MANUAL_ADJUSTMENT', 'INITIAL_STOCK') AND sale_id IS NULL)
  ),
  -- reverses_movement_id is present exactly for VOID_REVERSAL (§17).
  CHECK (
    (movement_type = 'VOID_REVERSAL' AND reverses_movement_id IS NOT NULL)
    OR
    (movement_type <> 'VOID_REVERSAL' AND reverses_movement_id IS NULL)
  )
);
-- One reversal per original movement (§17, §53, TEST-DB-014).
CREATE UNIQUE INDEX ux_inventory_movements_reverses
  ON inventory_movements (reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX idx_inventory_movements_product_id ON inventory_movements (product_id);
CREATE INDEX idx_inventory_movements_sale_id ON inventory_movements (sale_id);
CREATE INDEX idx_inventory_movements_created_at ON inventory_movements (created_at);

-- ── Settings (§19, §20) ───────────────────────────────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- ── Google Sheets export jobs (§22, §23) ──────────────────────────────────────
CREATE TABLE google_sheet_export_jobs (
  id                    TEXT    PRIMARY KEY,
  sale_id               TEXT    NOT NULL UNIQUE REFERENCES sales (id) ON DELETE CASCADE,
  status                TEXT    NOT NULL CHECK (status IN ('PENDING', 'EXPORTING', 'EXPORTED', 'FAILED')),
  target_sync_version   INTEGER NOT NULL CHECK (target_sync_version >= 1),
  exported_sync_version INTEGER CHECK (exported_sync_version IS NULL OR exported_sync_version >= 1),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       TEXT,
  last_attempt_at       TEXT,
  exported_at           TEXT,
  last_error            TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE INDEX idx_gsej_status ON google_sheet_export_jobs (status);
CREATE INDEX idx_gsej_next_attempt_at ON google_sheet_export_jobs (next_attempt_at);

-- ── Checkout requests (§32, §33, §34) ─────────────────────────────────────────
CREATE TABLE checkout_requests (
  request_id                   TEXT    PRIMARY KEY,
  request_fingerprint          TEXT    NOT NULL CHECK (length(request_fingerprint) > 0),
  payment_method_snapshot      TEXT    NOT NULL CHECK (payment_method_snapshot IN ('CASH', 'CARD')),
  intended_total_cents         INTEGER NOT NULL CHECK (intended_total_cents >= 0 AND intended_total_cents <= 99999999),
  clover_approved_confirmed_at TEXT,
  sale_id                      TEXT    REFERENCES sales (id) ON DELETE RESTRICT,
  status                       TEXT    NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'SUBMITTED', 'COMPLETED', 'COMMIT_FAILED')),
  failure_code                 TEXT,
  resolution_status            TEXT    CHECK (resolution_status IS NULL OR resolution_status IN ('UNRESOLVED', 'RESOLVED')),
  resolution_note              TEXT,
  created_at                   TEXT    NOT NULL,
  completed_at                 TEXT,
  failed_at                    TEXT,
  resolved_at                  TEXT,
  -- PENDING_PAYMENT is Card-only (§33).
  CHECK (status <> 'PENDING_PAYMENT' OR payment_method_snapshot = 'CARD'),
  -- sale_id / completed_at present exactly when COMPLETED (§33).
  CHECK ((status = 'COMPLETED') = (sale_id IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  -- failure_code / failed_at present exactly when COMMIT_FAILED (§33).
  CHECK ((status = 'COMMIT_FAILED') = (failure_code IS NOT NULL)),
  CHECK ((status = 'COMMIT_FAILED') = (failed_at IS NOT NULL)),
  -- Clover confirmation timestamp only for Card, and never while PENDING_PAYMENT (§33).
  CHECK (
    clover_approved_confirmed_at IS NULL
    OR (payment_method_snapshot = 'CARD' AND status <> 'PENDING_PAYMENT')
  ),
  -- Resolution note + timestamp required exactly when RESOLVED (§33).
  CHECK (
    resolution_status IS NULL
    OR resolution_status <> 'RESOLVED'
    OR (resolution_note IS NOT NULL AND length(trim(resolution_note)) > 0 AND resolved_at IS NOT NULL)
  )
);
-- One checkout request per completed sale (§33 "UNIQUE when present", §53).
CREATE UNIQUE INDEX ux_checkout_requests_sale_id
  ON checkout_requests (sale_id) WHERE sale_id IS NOT NULL;

-- ── Audit events (§36A, §53) ──────────────────────────────────────────────────
CREATE TABLE audit_events (
  id               TEXT    PRIMARY KEY,
  sequence         INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
  event_type       TEXT    NOT NULL CHECK (event_type IN (
                     'SALE_COMPLETED', 'SALE_VOIDED', 'PRICE_OVERRIDE', 'INVENTORY_ADJUSTED',
                     'TAX_SETTING_CHANGED', 'BUSINESS_SETTING_CHANGED', 'GOOGLE_CONFIGURATION_CHANGED',
                     'BACKUP_COMPLETED', 'BACKUP_FAILED', 'MIGRATION_STARTED', 'MIGRATION_COMPLETED',
                     'MIGRATION_FAILED', 'UPDATE_INSTALLED', 'CARD_LOCAL_COMMIT_FAILURE', 'AUTH_CREDENTIAL_CHANGED'
                   )),
  occurred_at      TEXT    NOT NULL,
  actor_type       TEXT    NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
  actor_identifier TEXT,
  subject_type     TEXT,
  subject_id       TEXT,
  correlation_id   TEXT,
  outcome          TEXT    NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  reason           TEXT,
  details_json     TEXT    CHECK (details_json IS NULL OR json_valid(details_json)),
  app_version      TEXT    NOT NULL
);
CREATE INDEX idx_audit_events_event_type ON audit_events (event_type);
CREATE INDEX idx_audit_events_occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_audit_events_subject ON audit_events (subject_type, subject_id);
CREATE INDEX idx_audit_events_correlation_id ON audit_events (correlation_id);
-- Append-only (§53): normal workflows must never update or delete audit rows.
CREATE TRIGGER trg_audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
CREATE TRIGGER trg_audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- ── Backup records (§36B) ─────────────────────────────────────────────────────
CREATE TABLE backup_records (
  id                    TEXT    PRIMARY KEY,
  backup_type           TEXT    NOT NULL CHECK (backup_type IN ('AUTOMATIC', 'MANUAL', 'PRE_MIGRATION')),
  location_kind         TEXT    NOT NULL CHECK (location_kind IN ('LOCAL_DISK', 'OFF_DEVICE')),
  status                TEXT    NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  file_name             TEXT,
  storage_path          TEXT,
  source_app_version    TEXT,
  source_schema_version INTEGER,
  target_app_version    TEXT,
  size_bytes            INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256       TEXT,
  started_at            TEXT    NOT NULL,
  completed_at          TEXT,
  error_code            TEXT,
  -- A COMPLETED record carries full file identity + provenance (§36B).
  CHECK (
    status <> 'COMPLETED'
    OR (
      file_name IS NOT NULL AND storage_path IS NOT NULL AND source_app_version IS NOT NULL
      AND source_schema_version IS NOT NULL AND size_bytes IS NOT NULL
      AND checksum_sha256 IS NOT NULL AND completed_at IS NOT NULL
    )
  ),
  -- A FAILED record carries a stable error code (§36B).
  CHECK (status <> 'FAILED' OR error_code IS NOT NULL),
  -- target_app_version is required for a completed pre-migration backup (§36B).
  CHECK (backup_type <> 'PRE_MIGRATION' OR status <> 'COMPLETED' OR target_app_version IS NOT NULL)
);
CREATE INDEX idx_backup_records_backup_type ON backup_records (backup_type);
CREATE INDEX idx_backup_records_status ON backup_records (status);
CREATE INDEX idx_backup_records_completed_at ON backup_records (completed_at);
`;

/**
 * Deterministic seed rows for a fresh V1 database (§8, §30, §4):
 *
 * - `counters`: `receipt_number` and `audit_sequence` start at 0, so the first
 *   allocation is 1 (§29-30, §36A).
 * - `settings`: only `business_timezone` — its initial value is explicitly
 *   documented (`§4`: "Initial store timezone: America/Chicago"). No other
 *   setting has a spec-defined value, so none is seeded; first-run setup (a
 *   later slice) populates the rest.
 *
 * No sample/business data is inserted — a fresh install begins empty.
 */
const SEED_MARKER =
  'seed:counters(receipt_number=0,audit_sequence=0);settings(business_timezone=America/Chicago)';

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema',
  fingerprint: `${SCHEMA_SQL}\n${SEED_MARKER}`,
  run(db, ctx) {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO counters (key, value, updated_at) VALUES (?, 0, ?)').run(
      'receipt_number',
      ctx.now,
    );
    db.prepare('INSERT INTO counters (key, value, updated_at) VALUES (?, 0, ?)').run(
      'audit_sequence',
      ctx.now,
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'business_timezone',
      'America/Chicago',
      ctx.now,
    );
  },
};
