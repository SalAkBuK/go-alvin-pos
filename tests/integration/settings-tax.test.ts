import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createCheckoutService } from '../../src/main/checkout/checkoutService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import {
  readConfiguredTaxRateBps,
  readTaxRateSetting,
} from '../../src/main/settings/settingsRepository';
import { isAppError } from '../../src/main/shared/appError';
import {
  backupGateUnreachable,
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
} from '../helpers/database';

/**
 * Tax-configuration integration tests against real SQLite
 * (`REQ-TAX-001`, `POS_WORKFLOWS.md §68`, `REQ-AUDIT-002/004/005`,
 * `DATA_MODEL.md §36A`; task `§13`-`§17`).
 */

const T0 = '2026-09-08T12:00:00.000Z';
const T1 = '2026-09-08T15:30:00.000Z';

function settings(db: Database.Database, now: () => string = () => T0) {
  return createSettingsService({ db, appVersion: 'test-2d1', now });
}

function seedProduct(db: Database.Database, sellingPriceCents = 55000, quantity = 5) {
  return createProductService({ db, now: () => T0 }).create({
    name: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents,
    quantity,
  });
}

function taxAuditRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT * FROM audit_events WHERE event_type = 'TAX_SETTING_CHANGED' ORDER BY sequence",
    )
    .all() as Array<Record<string, unknown>>;
}

function auditCounter(db: Database.Database): number {
  return (
    db.prepare("SELECT value FROM counters WHERE key = 'audit_sequence'").get() as {
      value: number;
    }
  ).value;
}

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});
afterEach(() => {
  db.close();
});

describe('first-time configuration', () => {
  it('inserts the setting and one TAX_SETTING_CHANGED audit event atomically', () => {
    const config = settings(db).updateTaxRate({ taxRateBps: 825 });
    expect(config).toEqual({ configured: true, taxRateBps: 825, updatedAt: T0 });

    expect(readTaxRateSetting(db)).toEqual({ taxRateBps: 825, updatedAt: T0 });
    expect(readConfiguredTaxRateBps(db)).toBe(825);

    const rows = taxAuditRows(db);
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event['event_type']).toBe('TAX_SETTING_CHANGED');
    expect(event['outcome']).toBe('SUCCESS');
    expect(event['actor_type']).toBe('USER');
    expect(event['subject_type']).toBe('SETTING');
    expect(event['subject_id']).toBe('tax_rate_bps');
    expect(event['app_version']).toBe('test-2d1');
    expect(event['occurred_at']).toBe(T0);
    expect(event['sequence']).toBe(1);
    expect(JSON.parse(event['details_json'] as string)).toEqual({
      setting: 'tax_rate_bps',
      previousTaxRateBps: null,
      newTaxRateBps: 825,
    });
    expect(auditCounter(db)).toBe(1);
  });

  it('records the first set with TAX_SETTING_CHANGED (there is no separate "created" event)', () => {
    settings(db).updateTaxRate({ taxRateBps: 700 });
    expect(taxAuditRows(db).map((r) => r['event_type'])).toEqual(['TAX_SETTING_CHANGED']);
  });
});

describe('changing an existing rate', () => {
  it('updates value + updated_at and appends a second audit event with the prior value', () => {
    settings(db, () => T0).updateTaxRate({ taxRateBps: 825 });
    const config = settings(db, () => T1).updateTaxRate({ taxRateBps: 700 });

    expect(config).toEqual({ configured: true, taxRateBps: 700, updatedAt: T1 });
    expect(readTaxRateSetting(db)).toEqual({ taxRateBps: 700, updatedAt: T1 });

    const rows = taxAuditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['sequence'])).toEqual([1, 2]);
    expect(JSON.parse(rows[1]!['details_json'] as string)).toEqual({
      setting: 'tax_rate_bps',
      previousTaxRateBps: 825,
      newTaxRateBps: 700,
    });
    expect(auditCounter(db)).toBe(2);
  });
});

describe('no-op save', () => {
  it('rejects setting the same rate and writes no second audit event', () => {
    settings(db).updateTaxRate({ taxRateBps: 825 });
    try {
      settings(db).updateTaxRate({ taxRateBps: 825 });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('TAX_RATE_UNCHANGED');
    }
    expect(taxAuditRows(db)).toHaveLength(1);
    expect(auditCounter(db)).toBe(1);
    expect(readTaxRateSetting(db)).toEqual({ taxRateBps: 825, updatedAt: T0 });
  });
});

describe('validation at the trusted boundary', () => {
  it.each([-1, 8.25, 100001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects taxRateBps %p with no persistence and no audit',
    (taxRateBps) => {
      expect(() => settings(db).updateTaxRate({ taxRateBps })).toThrow();
      expect(readTaxRateSetting(db)).toBeNull();
      expect(taxAuditRows(db)).toHaveLength(0);
      expect(auditCounter(db)).toBe(0);
    },
  );

  it('accepts zero as a valid configured rate', () => {
    const config = settings(db).updateTaxRate({ taxRateBps: 0 });
    expect(config).toEqual({ configured: true, taxRateBps: 0, updatedAt: T0 });
  });
});

describe('atomic setting + audit mutation (REQ-AUDIT-004)', () => {
  it('a failing audit insert rolls back the setting write and does not advance the sequence', () => {
    settings(db).updateTaxRate({ taxRateBps: 825 });
    const counterBefore = auditCounter(db);

    // Break audit_events so appendAuditEvent throws inside the transaction.
    db.exec('ALTER TABLE audit_events RENAME TO audit_events_x');
    try {
      expect(() => settings(db).updateTaxRate({ taxRateBps: 700 })).toThrow();
    } finally {
      db.exec('ALTER TABLE audit_events_x RENAME TO audit_events');
    }

    expect(readTaxRateSetting(db)).toEqual({ taxRateBps: 825, updatedAt: T0 }); // unchanged
    expect(taxAuditRows(db)).toHaveLength(1); // no second event
    expect(auditCounter(db)).toBe(counterBefore); // sequence not durably consumed

    // The next real change still gets sequence 2 — no skipped/duplicated value.
    settings(db, () => T1).updateTaxRate({ taxRateBps: 700 });
    expect(taxAuditRows(db).map((r) => r['sequence'])).toEqual([1, 2]);
  });

  it('audit details carry only safe configuration context (no secrets / PII)', () => {
    settings(db).updateTaxRate({ taxRateBps: 825 });
    const details = taxAuditRows(db)[0]!['details_json'] as string;
    expect(details).not.toMatch(/password|secret|token|card|phone|customer/i);
    expect(Object.keys(JSON.parse(details)).sort()).toEqual([
      'newTaxRateBps',
      'previousTaxRateBps',
      'setting',
    ]);
  });
});

describe('offline / restart persistence (task §14)', () => {
  it('a configured rate + its audit event survive close/reopen of the same file', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });

      createSettingsService({ db: conn, appVersion: 'test', now: () => T0 }).updateTaxRate({
        taxRateBps: 825,
      });
      conn.close();

      conn = openConfiguredConnection(file);
      expect(readTaxRateSetting(conn)).toEqual({ taxRateBps: 825, updatedAt: T0 });
      expect(createSettingsService({ db: conn, appVersion: 'test' }).getTaxRate()).toEqual({
        configured: true,
        taxRateBps: 825,
        updatedAt: T0,
      });
      expect(
        (
          conn
            .prepare("SELECT COUNT(*) c FROM audit_events WHERE event_type = 'TAX_SETTING_CHANGED'")
            .get() as { c: number }
        ).c,
      ).toBe(1);
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});

describe('interaction with Phase 2D checkout review (task §16)', () => {
  it('review is blocked until configured, then succeeds, then a rate change flows into a fresh review', () => {
    const product = seedProduct(db, 55000, 5);
    const checkout = createCheckoutService({ db });
    const line = { productId: product.id, quantity: 1, soldPriceCents: 55000 };

    try {
      checkout.review({ customerId: null, paymentMethod: 'CASH', lines: [line] });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('TAX_RATE_NOT_CONFIGURED');
    }

    settings(db).updateTaxRate({ taxRateBps: 825 });
    const first = checkout.review({ customerId: null, paymentMethod: 'CASH', lines: [line] });
    expect(first.taxRateBps).toBe(825);
    expect(first.taxCents).toBe(4538);
    expect(first.totalCents).toBe(59538);

    settings(db, () => T1).updateTaxRate({ taxRateBps: 700 });
    const second = checkout.review({ customerId: null, paymentMethod: 'CASH', lines: [line] });
    expect(second.taxRateBps).toBe(700);
    expect(second.taxCents).toBe(3850); // floor((55000*700 + 5000)/10000)
    expect(second.totalCents).toBe(58850);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('configuring / changing the tax rate creates no sale / payment / movement / checkout-request rows', () => {
    const product = seedProduct(db);
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    const before = {
      sales: count('sales'),
      payments: count('payments'),
      movements: count('inventory_movements'),
      checkoutRequests: count('checkout_requests'),
      exportJobs: count('google_sheet_export_jobs'),
    };

    settings(db).updateTaxRate({ taxRateBps: 825 });
    createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: product.id, quantity: 1, soldPriceCents: 55000 }],
    });
    settings(db, () => T1).updateTaxRate({ taxRateBps: 900 });

    expect({
      sales: count('sales'),
      payments: count('payments'),
      movements: count('inventory_movements'),
      checkoutRequests: count('checkout_requests'),
      exportJobs: count('google_sheet_export_jobs'),
    }).toEqual(before);
  });
});

describe('historical sale preservation — REQ-TAX-003 setting-change portion (task §15)', () => {
  it('changing the configured rate leaves a pre-existing sales row untouched', () => {
    // Seed a historical sale directly (Phase 2E sale completion does not exist yet).
    db.prepare(
      `INSERT INTO sales
         (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
          business_name_snapshot, business_address_snapshot, business_phone_snapshot,
          receipt_disclaimer_snapshot, receipt_footer_snapshot, status, subtotal_cents,
          taxable_amount_cents, tax_rate_bps, tax_cents, total_cents, payment_method_snapshot,
          created_at, completed_at, voided_at, void_reason)
       VALUES
         ('sale-1', 'GP-000001', NULL, NULL, NULL, 'Biz', 'Addr', '555', 'Disc', 'Foot',
          'COMPLETED', 55000, 55000, 825, 4538, 59538, 'CASH', @t, @t, NULL, NULL)`,
    ).run({ t: T0 });

    settings(db, () => T1).updateTaxRate({ taxRateBps: 700 });

    expect(
      db
        .prepare('SELECT tax_rate_bps, tax_cents, total_cents FROM sales WHERE id = ?')
        .get('sale-1'),
    ).toEqual({ tax_rate_bps: 825, tax_cents: 4538, total_cents: 59538 });
  });
});
