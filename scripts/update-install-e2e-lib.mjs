import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readPackagedUpdaterEvidence } from './update-download-e2e-lib.mjs';

const require = createRequire(import.meta.url);

/**
 * Phase 2N-E2 packaged update INSTALL E2E: real installed-A -> real
 * installed-B round trip, with real NSIS install/uninstall and a real
 * business-data fixture proven to survive the update.
 *
 * This deliberately reuses `update-download-e2e-lib.mjs` (Phase 2N-E1) for
 * everything that slice already proved safe: version validation, the
 * loopback HTTPS feed helpers, and the structured `main.log` reader. Nothing
 * here duplicates that logic.
 *
 * ## Identity duplication
 *
 * `UPDATE_INSTALL_E2E_APP_ID` / `UPDATE_INSTALL_E2E_PRODUCT_NAME` /
 * `UPDATE_INSTALL_E2E_PROFILE_LEAF` / `UPDATE_INSTALL_E2E_RUN_PREFIX` are
 * intentionally duplicated (not imported) from
 * `src/main/updater/updateInstallE2eConfig.ts` and `electron-builder.js` —
 * this file, those files, and the trigger's marker file name are each loaded
 * by a different toolchain (plain Node script, Vite/esbuild TS bundle,
 * electron-builder CLI) with no shared module resolution. Their equality is
 * asserted by `tests/unit/update-install-e2e.test.ts`.
 */

export const UPDATE_INSTALL_E2E_RUN_PREFIX = 'gpp-update-install-e2e-';
export const UPDATE_INSTALL_E2E_PROFILE_LEAF = 'GoPhonesPOS';
export const UPDATE_INSTALL_E2E_APP_ID = 'com.gophones.pos.update-e2e';
export const UPDATE_INSTALL_E2E_PRODUCT_NAME = 'Go Phones POS Update E2E';
export const UPDATE_INSTALL_E2E_PACKAGE_NAME = 'go-phones-pos-update-e2e';
export const PRODUCTION_APP_ID = 'com.gophones.pos';
export const PRODUCTION_PRODUCT_NAME = 'Go Phones POS';
export const PRODUCTION_PACKAGE_NAME = 'go-phones-pos';
export const UPDATE_INSTALL_E2E_TRIGGER_FILE = 'update-install-e2e.trigger';
export const UPDATE_INSTALL_E2E_BUILD_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_BUILD';
export const UPDATE_INSTALL_E2E_PROFILE_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_PROFILE';
export const UPDATE_INSTALL_E2E_RUNTIME_ENV = 'GO_PHONES_UPDATE_INSTALL_E2E_RUNTIME';
export const RECEIPT_PREFIX = 'GP-';
export const RECEIPT_DIGITS = 6;

export function formatReceiptNumber(value) {
  return `${RECEIPT_PREFIX}${String(value).padStart(RECEIPT_DIGITS, '0')}`;
}

function assertChildPath(parent, candidate, label) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`${label} must remain inside the packaged update-install E2E run root.`);
  }
  return resolve(candidate);
}

/** Create the unique temporary run root every other path in this run is scoped under. */
export async function createRunRoot() {
  return mkdtemp(join(tmpdir(), UPDATE_INSTALL_E2E_RUN_PREFIX));
}

/**
 * The single compile-time-baked business-data profile directory A and B
 * both resolve `userData` to (`updateInstallE2eConfig.ts`'s
 * `isGuardedUpdateInstallE2eProfile`: an absolute path ending in
 * `GoPhonesPOS`, with an ancestor segment starting with the E2E run prefix).
 */
export function guardedProfilePath(runRoot) {
  return assertChildPath(
    runRoot,
    join(runRoot, 'profile', UPDATE_INSTALL_E2E_PROFILE_LEAF),
    'E2E business-data profile',
  );
}

/** The `LOCALAPPDATA` value the installed app must be launched with so its runtime
 * cross-check (`updateInstallE2eRuntimeAllowed`) sees `<LOCALAPPDATA>\GoPhonesPOS`
 * equal the compile-time-baked profile above. */
export function guardedLocalAppData(runRoot) {
  return join(runRoot, 'profile');
}

export function isGuardedProfilePath(runRoot, candidate) {
  const expected = guardedProfilePath(runRoot);
  return resolve(candidate) === expected;
}

/** Environment additions for launching the INSTALLED E2E executable (A, and
 * transitively B via process-tree inheritance through electron-updater's
 * NSIS relaunch — never used for the NSIS installer/uninstaller itself,
 * which must see the real per-user environment so it installs to the real,
 * genuinely distinct-by-name `%LOCALAPPDATA%\Programs\<E2E product name>`). */
export function installedAppLaunchEnvironment(baseEnv, runRoot, feedUrl) {
  const url = new URL(feedUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Packaged update-install E2E feed must be credential-free HTTPS.');
  }
  const environment = {
    ...baseEnv,
    LOCALAPPDATA: guardedLocalAppData(runRoot),
    GO_PHONES_UPDATE_FEED_URL: feedUrl,
    [UPDATE_INSTALL_E2E_RUNTIME_ENV]: '1',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/** Environment additions for the ELECTRON-BUILDER build (not app launch) of
 * an E2E-identity artifact. Both A's and B's build MUST pass the identical
 * `profile` value so their compiled-in `__UPDATE_INSTALL_E2E_PROFILE__`
 * matches and they therefore resolve the exact same business database. */
export function buildE2eEnvironment(baseEnv, profile) {
  return {
    ...baseEnv,
    [UPDATE_INSTALL_E2E_BUILD_ENV]: '1',
    [UPDATE_INSTALL_E2E_PROFILE_ENV]: profile,
  };
}

export function assertSafeRunRoot(runRoot, temporaryRoot = tmpdir()) {
  const resolvedRunRoot = resolve(runRoot);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (
    dirname(resolvedRunRoot) !== resolvedTemporaryRoot ||
    !resolvedRunRoot.split(sep).pop()?.startsWith(UPDATE_INSTALL_E2E_RUN_PREFIX)
  ) {
    throw new Error('Refusing to clean a path that is not a packaged update-install E2E run root.');
  }
  return resolvedRunRoot;
}

export async function cleanupRunRoot(runRoot, temporaryRoot = tmpdir()) {
  await rm(assertSafeRunRoot(runRoot, temporaryRoot), { recursive: true, force: true });
}

/** Refuse to touch any install location that is not the E2E product's own,
 * real, per-user install directory. electron-builder's per-user NSIS default
 * install directory is named from the PACKAGE name (package.json `name`),
 * never `productName` — confirmed empirically; using the product name here
 * would silently point this guard at production's own real per-user install
 * directory (`%LOCALAPPDATA%\Programs\go-phones-pos`) instead of the E2E
 * one. */
export function assertSafeInstallRoot(installRoot, localAppData) {
  const expected = resolve(localAppData, 'Programs', UPDATE_INSTALL_E2E_PACKAGE_NAME);
  if (resolve(installRoot) !== expected) {
    throw new Error('Refusing to install/uninstall/clean a path that is not the E2E install root.');
  }
  return expected;
}

// ── Fixture: deterministic, schema-valid business data seeded directly with
// better-sqlite3 against the E2E profile's own database, once installed A
// has run once (so the real migration created the schema). No app code is
// duplicated here — only INSERTs against the already-created canonical
// tables (`src/main/database/migrations/001_initial_schema.ts`). ──────────

const FIXTURE_PRODUCT_ID = 'e2e-fixture-product-0001';
const FIXTURE_CUSTOMER_ID = 'e2e-fixture-customer-0001';
const FIXTURE_SALE_ID = 'e2e-fixture-sale-0001';
const FIXTURE_SALE_ITEM_ID = 'e2e-fixture-sale-item-0001';
const FIXTURE_PAYMENT_ID = 'e2e-fixture-payment-0001';
const FIXTURE_MOVEMENT_ID = 'e2e-fixture-movement-0001';
const FIXTURE_AUDIT_EVENT_ID = 'e2e-fixture-audit-0001';
const FIXTURE_EXPORT_JOB_ID = 'e2e-fixture-export-job-0001';
const FIXTURE_CHECKOUT_REQUEST_ID = 'e2e-fixture-checkout-0001';
const FIXTURE_SETTING_KEY = 'e2e_fixture_marker';
const FIXTURE_SETTING_VALUE = 'phase-2n-e2';
const FIXTURE_SELLING_PRICE_CENTS = 9999;
const FIXTURE_TAX_RATE_BPS = 1000;
const FIXTURE_TAX_CENTS = 1000;
const FIXTURE_TOTAL_CENTS = FIXTURE_SELLING_PRICE_CENTS + FIXTURE_TAX_CENTS;
const FIXTURE_INITIAL_QUANTITY = 10;
const FIXTURE_POST_SALE_QUANTITY = FIXTURE_INITIAL_QUANTITY - 1;

function openDatabase(dbFile) {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Seed the deterministic V1 business-data fixture into a freshly-migrated
 * (schema-only) database. Idempotent guard: refuses to run twice. */
export function seedFixture(dbFile, { appVersion, now = () => new Date().toISOString() } = {}) {
  const db = openDatabase(dbFile);
  try {
    const existing = db.prepare('SELECT 1 FROM products WHERE id = ?').get(FIXTURE_PRODUCT_ID);
    if (existing) throw new Error('E2E fixture has already been seeded into this database.');

    const nowIso = now();
    const receiptCounter = db
      .prepare("SELECT value FROM counters WHERE key = 'receipt_number'")
      .get();
    const auditCounter = db
      .prepare("SELECT value FROM counters WHERE key = 'audit_sequence'")
      .get();
    if (!receiptCounter || !auditCounter)
      throw new Error('Counters are missing; schema not initialized.');
    const receiptValue = receiptCounter.value + 1;
    const auditValue = auditCounter.value + 1;
    const receiptNumber = formatReceiptNumber(receiptValue);

    const seed = db.transaction(() => {
      db.prepare(
        `INSERT INTO products
           (id, sku, barcode, name, brand, model, condition, cost_price_cents,
            selling_price_cents, quantity_on_hand, low_stock_threshold, is_active,
            created_at, updated_at)
         VALUES (@id, @sku, @barcode, @name, @brand, @model, @condition, @costPriceCents,
                 @sellingPriceCents, @quantityOnHand, @lowStockThreshold, 1, @createdAt, @updatedAt)`,
      ).run({
        id: FIXTURE_PRODUCT_ID,
        sku: 'E2E-SKU-0001',
        barcode: 'E2E-BARCODE-0001',
        name: 'E2E Fixture Phone',
        brand: 'E2E Brand',
        model: 'E2E Model',
        condition: 'NEW',
        costPriceCents: 5000,
        sellingPriceCents: FIXTURE_SELLING_PRICE_CENTS,
        quantityOnHand: FIXTURE_POST_SALE_QUANTITY,
        lowStockThreshold: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      db.prepare(
        `INSERT INTO customers (id, name, phone, phone_normalized, created_at, updated_at)
         VALUES (@id, @name, @phone, @phoneNormalized, @createdAt, @updatedAt)`,
      ).run({
        id: FIXTURE_CUSTOMER_ID,
        name: 'E2E Fixture Customer',
        phone: '555-555-0100',
        phoneNormalized: '5555550100',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      db.prepare(
        `INSERT INTO sales
           (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
            business_name_snapshot, business_address_snapshot, business_phone_snapshot,
            receipt_disclaimer_snapshot, receipt_footer_snapshot, status, sync_version,
            subtotal_cents, discount_cents, taxable_amount_cents, tax_rate_bps, tax_cents,
            total_cents, payment_method_snapshot, created_at, completed_at)
         VALUES (@id, @receiptNumber, @customerId, @customerNameSnapshot, @customerPhoneSnapshot,
                 @businessNameSnapshot, @businessAddressSnapshot, @businessPhoneSnapshot,
                 @receiptDisclaimerSnapshot, @receiptFooterSnapshot, 'COMPLETED', 1,
                 @subtotalCents, 0, @taxableAmountCents, @taxRateBps, @taxCents,
                 @totalCents, 'CASH', @createdAt, @completedAt)`,
      ).run({
        id: FIXTURE_SALE_ID,
        receiptNumber,
        customerId: FIXTURE_CUSTOMER_ID,
        customerNameSnapshot: 'E2E Fixture Customer',
        customerPhoneSnapshot: '555-555-0100',
        businessNameSnapshot: 'Go Phones POS E2E Fixture',
        businessAddressSnapshot: '1 E2E Test Way',
        businessPhoneSnapshot: '555-555-0000',
        receiptDisclaimerSnapshot: 'E2E fixture receipt — not a real sale.',
        receiptFooterSnapshot: 'Thank you (E2E fixture).',
        subtotalCents: FIXTURE_SELLING_PRICE_CENTS,
        taxableAmountCents: FIXTURE_SELLING_PRICE_CENTS,
        taxRateBps: FIXTURE_TAX_RATE_BPS,
        taxCents: FIXTURE_TAX_CENTS,
        totalCents: FIXTURE_TOTAL_CENTS,
        createdAt: nowIso,
        completedAt: nowIso,
      });

      db.prepare(
        `INSERT INTO sale_items
           (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
            condition_snapshot, sku_snapshot, barcode_snapshot, listed_price_cents,
            sold_price_cents, discount_cents, quantity, line_subtotal_cents, line_total_cents,
            created_at)
         VALUES (@id, @saleId, @productId, @productNameSnapshot, @brandSnapshot, @modelSnapshot,
                 'NEW', @skuSnapshot, @barcodeSnapshot, @listedPriceCents, @soldPriceCents, 0, 1,
                 @lineSubtotalCents, @lineTotalCents, @createdAt)`,
      ).run({
        id: FIXTURE_SALE_ITEM_ID,
        saleId: FIXTURE_SALE_ID,
        productId: FIXTURE_PRODUCT_ID,
        productNameSnapshot: 'E2E Fixture Phone',
        brandSnapshot: 'E2E Brand',
        modelSnapshot: 'E2E Model',
        skuSnapshot: 'E2E-SKU-0001',
        barcodeSnapshot: 'E2E-BARCODE-0001',
        listedPriceCents: FIXTURE_SELLING_PRICE_CENTS,
        soldPriceCents: FIXTURE_SELLING_PRICE_CENTS,
        lineSubtotalCents: FIXTURE_SELLING_PRICE_CENTS,
        lineTotalCents: FIXTURE_SELLING_PRICE_CENTS,
        createdAt: nowIso,
      });

      db.prepare(
        `INSERT INTO payments (id, sale_id, method, amount_cents, status, created_at)
         VALUES (@id, @saleId, 'CASH', @amountCents, 'COMPLETED', @createdAt)`,
      ).run({
        id: FIXTURE_PAYMENT_ID,
        saleId: FIXTURE_SALE_ID,
        amountCents: FIXTURE_TOTAL_CENTS,
        createdAt: nowIso,
      });

      db.prepare(
        `INSERT INTO inventory_movements
           (id, product_id, sale_id, movement_type, reverses_movement_id, quantity_change,
            quantity_before, quantity_after, reason, created_at)
         VALUES (@id, @productId, @saleId, 'SALE', NULL, -1, @quantityBefore, @quantityAfter,
                 NULL, @createdAt)`,
      ).run({
        id: FIXTURE_MOVEMENT_ID,
        productId: FIXTURE_PRODUCT_ID,
        saleId: FIXTURE_SALE_ID,
        quantityBefore: FIXTURE_INITIAL_QUANTITY,
        quantityAfter: FIXTURE_POST_SALE_QUANTITY,
        createdAt: nowIso,
      });

      db.prepare(
        `INSERT INTO audit_events
           (id, sequence, event_type, occurred_at, actor_type, actor_identifier, subject_type,
            subject_id, correlation_id, outcome, reason, details_json, app_version)
         VALUES (@id, @sequence, 'SALE_COMPLETED', @occurredAt, 'SYSTEM', @actorIdentifier,
                 'sale', @subjectId, NULL, 'SUCCESS', NULL, NULL, @appVersion)`,
      ).run({
        id: FIXTURE_AUDIT_EVENT_ID,
        sequence: auditValue,
        occurredAt: nowIso,
        actorIdentifier: 'update-install-e2e-fixture',
        subjectId: FIXTURE_SALE_ID,
        appVersion: appVersion ?? 'unknown',
      });

      db.prepare(
        `INSERT INTO google_sheet_export_jobs
           (id, sale_id, status, target_sync_version, exported_sync_version, attempt_count,
            next_attempt_at, last_attempt_at, exported_at, last_error, created_at, updated_at)
         VALUES (@id, @saleId, 'PENDING', 1, NULL, 0, NULL, NULL, NULL, NULL, @createdAt, @updatedAt)`,
      ).run({
        id: FIXTURE_EXPORT_JOB_ID,
        saleId: FIXTURE_SALE_ID,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      db.prepare(
        `INSERT INTO checkout_requests
           (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
            clover_approved_confirmed_at, sale_id, status, failure_code, resolution_status,
            resolution_note, created_at, completed_at, failed_at, resolved_at)
         VALUES (@requestId, @requestFingerprint, 'CASH', @intendedTotalCents, NULL, @saleId,
                 'COMPLETED', NULL, NULL, NULL, @createdAt, @completedAt, NULL, NULL)`,
      ).run({
        requestId: FIXTURE_CHECKOUT_REQUEST_ID,
        requestFingerprint: 'e2e-fixture-checkout-fingerprint-0001',
        intendedTotalCents: FIXTURE_TOTAL_CENTS,
        saleId: FIXTURE_SALE_ID,
        createdAt: nowIso,
        completedAt: nowIso,
      });

      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        FIXTURE_SETTING_KEY,
        FIXTURE_SETTING_VALUE,
        nowIso,
      );

      db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'receipt_number'").run(
        receiptValue,
        nowIso,
      );
      db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'audit_sequence'").run(
        auditValue,
        nowIso,
      );
    });
    seed();
    return { receiptNumber, receiptValue, auditValue };
  } finally {
    db.close();
  }
}

/** Read the exact logical facts REQ-UPDATE-007 requires to survive an
 * install: rows, values, counts — never raw file bytes. */
export function captureBusinessEvidence(dbFile) {
  const db = openDatabase(dbFile);
  try {
    const schemaVersion = db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get().version;
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(FIXTURE_PRODUCT_ID);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(FIXTURE_CUSTOMER_ID);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(FIXTURE_SALE_ID);
    const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(FIXTURE_SALE_ITEM_ID);
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(FIXTURE_PAYMENT_ID);
    const movement = db
      .prepare('SELECT * FROM inventory_movements WHERE id = ?')
      .get(FIXTURE_MOVEMENT_ID);
    const auditEvent = db
      .prepare('SELECT * FROM audit_events WHERE id = ?')
      .get(FIXTURE_AUDIT_EVENT_ID);
    const exportJob = db
      .prepare('SELECT * FROM google_sheet_export_jobs WHERE id = ?')
      .get(FIXTURE_EXPORT_JOB_ID);
    const checkoutRequest = db
      .prepare('SELECT * FROM checkout_requests WHERE request_id = ?')
      .get(FIXTURE_CHECKOUT_REQUEST_ID);
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(FIXTURE_SETTING_KEY);
    const businessTimezone = db
      .prepare("SELECT value FROM settings WHERE key = 'business_timezone'")
      .get();
    const receiptCounter = db
      .prepare("SELECT value FROM counters WHERE key = 'receipt_number'")
      .get();
    const auditCounter = db
      .prepare("SELECT value FROM counters WHERE key = 'audit_sequence'")
      .get();
    const counts = {
      products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      sales: db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
      saleItems: db.prepare('SELECT COUNT(*) AS n FROM sale_items').get().n,
      payments: db.prepare('SELECT COUNT(*) AS n FROM payments').get().n,
      inventoryMovements: db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n,
      auditEvents: db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
      exportJobs: db.prepare('SELECT COUNT(*) AS n FROM google_sheet_export_jobs').get().n,
      checkoutRequests: db.prepare('SELECT COUNT(*) AS n FROM checkout_requests').get().n,
    };
    const integrityCheck = db.pragma('integrity_check', { simple: true });
    const foreignKeyCheck = db.pragma('foreign_key_check');
    return {
      schemaVersion,
      product,
      customer,
      sale,
      saleItem,
      payment,
      movement,
      auditEvent,
      exportJob,
      checkoutRequest,
      setting: setting?.value ?? null,
      businessTimezone: businessTimezone?.value ?? null,
      receiptCounterValue: receiptCounter?.value ?? null,
      auditCounterValue: auditCounter?.value ?? null,
      counts,
      integrityOk: integrityCheck === 'ok',
      foreignKeysOk: Array.isArray(foreignKeyCheck) && foreignKeyCheck.length === 0,
    };
  } finally {
    db.close();
  }
}

/** Compare pre-update and post-update evidence and return every violated
 * expectation (empty array = fully preserved, no duplicates). */
export function compareBusinessEvidence(before, after) {
  const problems = [];
  const eq = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      problems.push(`${label} changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  };
  if (before.schemaVersion !== after.schemaVersion) {
    problems.push(`schema version changed: ${before.schemaVersion} -> ${after.schemaVersion}`);
  }
  eq('product row', before.product, after.product);
  eq('customer row', before.customer, after.customer);
  eq('sale row', before.sale, after.sale);
  eq('sale item row', before.saleItem, after.saleItem);
  eq('payment row', before.payment, after.payment);
  eq('inventory movement row', before.movement, after.movement);
  eq('audit event row', before.auditEvent, after.auditEvent);
  eq('checkout request row', before.checkoutRequest, after.checkoutRequest);
  eq('fixture setting', before.setting, after.setting);
  eq('business timezone setting', before.businessTimezone, after.businessTimezone);
  eq('receipt-number counter', before.receiptCounterValue, after.receiptCounterValue);
  eq('audit-sequence counter', before.auditCounterValue, after.auditCounterValue);
  if (after.exportJob?.status !== 'PENDING') {
    problems.push(`export job status is no longer PENDING: ${after.exportJob?.status}`);
  }
  eq('export job identity/target', before.exportJob?.id, after.exportJob?.id);
  for (const key of Object.keys(before.counts)) {
    if (before.counts[key] !== after.counts[key]) {
      problems.push(
        `row count for ${key} changed (possible duplicate): ${before.counts[key]} -> ${after.counts[key]}`,
      );
    }
  }
  if (!after.integrityOk) problems.push('post-update SQLite integrity_check failed');
  if (!after.foreignKeysOk)
    problems.push('post-update SQLite foreign_key_check reported violations');
  return problems;
}

/** Allocate and complete one more receipt directly (mirrors
 * `saleRepository.allocateReceiptNumber`'s read-increment) to prove the
 * counter continues from where B found it, not from zero. */
export function allocateNextReceiptForContinuityCheck(dbFile) {
  const db = openDatabase(dbFile);
  try {
    const counter = db.prepare("SELECT value FROM counters WHERE key = 'receipt_number'").get();
    const value = counter.value + 1;
    db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'receipt_number'").run(
      value,
      new Date().toISOString(),
    );
    return { value, receiptNumber: formatReceiptNumber(value) };
  } finally {
    db.close();
  }
}

// ── Log evidence (extends the E1 reader with install/maintenance/crash lines) ──

export async function readAllLogRecords(logFile) {
  let text;
  try {
    text = await readFile(logFile, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return records;
}

export { readPackagedUpdaterEvidence };

export function findEvent(records, eventName) {
  return records.filter((record) => record.event === eventName);
}

export function lastApplicationStart(records) {
  const starts = findEvent(records, 'application.started');
  return starts.length > 0 ? starts[starts.length - 1] : null;
}
