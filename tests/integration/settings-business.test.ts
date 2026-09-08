import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createSettingsService } from '../../src/main/settings/settingsService';
import {
  BUSINESS_NAME,
  readBusinessSettings,
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
 * Business & receipt configuration integration tests against real SQLite
 * (`DATA_MODEL.md §44-49`, `§19-20`, `§36A`; `POS_WORKFLOWS.md §69`;
 * `REQ-REC-002`, `REQ-AUDIT-002/004`; task `§16`-`§20`).
 *
 * This phase configures the *source* values only. It creates no `sales` row and
 * does not implement receipt printing — `TEST-PRINT-005` / `TEST-REC-*` remain
 * for the sale/printing phases.
 */

const T0 = '2026-09-08T12:00:00.000Z';
const T1 = '2026-09-08T15:30:00.000Z';

function service(db: Database.Database, now: () => string = () => T0) {
  return createSettingsService({ db, appVersion: 'test-2d2', now });
}

function complete(overrides: Record<string, string> = {}) {
  return {
    businessAddress: '123 Main St, Alvin, TX 77511',
    businessPhone: '(281) 555-0100',
    receiptDisclaimer: 'All sales final. 30-day warranty on refurbished devices.',
    receiptFooter: 'Thank you for shopping with Go Phones!',
    ...overrides,
  };
}

function businessAuditRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT * FROM audit_events WHERE event_type = 'BUSINESS_SETTING_CHANGED' ORDER BY sequence",
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

describe('completeness', () => {
  it('a fresh DB reports incomplete with both identity fields missing', () => {
    const config = service(db).getBusinessConfig();
    expect(config.configured).toBe(false);
    expect(config).toMatchObject({
      configured: false,
      businessName: BUSINESS_NAME,
      businessAddress: null,
      businessPhone: null,
      receiptDisclaimer: null,
      receiptFooter: null,
      missing: ['businessAddress', 'businessPhone'],
    });
  });

  it('address present but phone missing → still incomplete', () => {
    // Seed just the address row directly to simulate a partial state.
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('business_address', '123 Main St', ?)",
    ).run(T0);
    const config = service(db).getBusinessConfig();
    expect(config.configured).toBe(false);
    expect(config.configured === false && config.missing).toEqual(['businessPhone']);
  });

  it('a blank footer/disclaimer does not block readiness', () => {
    const config = service(db).updateBusinessConfig(
      complete({ receiptDisclaimer: '', receiptFooter: '' }),
    );
    expect(config.configured).toBe(true);
    expect(config.configured === true && config.receiptDisclaimer).toBe('');
    expect(config.configured === true && config.receiptFooter).toBe('');
  });

  it('a complete configuration reports ready', () => {
    const config = service(db).updateBusinessConfig(complete());
    expect(config).toEqual({
      configured: true,
      businessName: BUSINESS_NAME,
      businessAddress: '123 Main St, Alvin, TX 77511',
      businessPhone: '(281) 555-0100',
      receiptDisclaimer: 'All sales final. 30-day warranty on refurbished devices.',
      receiptFooter: 'Thank you for shopping with Go Phones!',
      updatedAt: T0,
    });
  });
});

describe('first-time configuration', () => {
  it('inserts the four setting rows and one BUSINESS_SETTING_CHANGED audit event atomically', () => {
    service(db).updateBusinessConfig(complete());

    expect(readBusinessSettings(db)).toEqual({
      businessAddress: '123 Main St, Alvin, TX 77511',
      businessPhone: '(281) 555-0100',
      receiptDisclaimer: 'All sales final. 30-day warranty on refurbished devices.',
      receiptFooter: 'Thank you for shopping with Go Phones!',
      updatedAt: T0,
    });

    const rows = businessAuditRows(db);
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event['event_type']).toBe('BUSINESS_SETTING_CHANGED');
    expect(event['outcome']).toBe('SUCCESS');
    expect(event['actor_type']).toBe('USER');
    expect(event['subject_type']).toBe('SETTING');
    expect(event['subject_id']).toBe('business_information');
    expect(event['app_version']).toBe('test-2d2');
    expect(event['sequence']).toBe(1);
    const details = JSON.parse(event['details_json'] as string) as {
      changedFields: string[];
      previous: Record<string, unknown>;
      next: Record<string, unknown>;
    };
    expect(details.changedFields.sort()).toEqual([
      'businessAddress',
      'businessPhone',
      'receiptDisclaimer',
      'receiptFooter',
    ]);
    expect(details.previous).toEqual({
      businessAddress: null,
      businessPhone: null,
      receiptDisclaimer: null,
      receiptFooter: null,
    });
    expect(details.next['businessPhone']).toBe('(281) 555-0100');
    expect(auditCounter(db)).toBe(1);
  });

  it('records the first configuration with BUSINESS_SETTING_CHANGED (no separate "created" event)', () => {
    service(db).updateBusinessConfig(complete());
    expect(businessAuditRows(db).map((r) => r['event_type'])).toEqual(['BUSINESS_SETTING_CHANGED']);
  });
});

describe('updating an existing configuration', () => {
  it('persists only the changed field and records it with the prior value', () => {
    service(db, () => T0).updateBusinessConfig(complete());
    const updated = service(db, () => T1).updateBusinessConfig(
      complete({ businessPhone: '(281) 555-0199' }),
    );

    expect(updated.configured === true && updated.businessPhone).toBe('(281) 555-0199');
    expect(readBusinessSettings(db).updatedAt).toBe(T1);

    const rows = businessAuditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['sequence'])).toEqual([1, 2]);
    const details = JSON.parse(rows[1]!['details_json'] as string) as {
      changedFields: string[];
      previous: Record<string, unknown>;
      next: Record<string, unknown>;
    };
    expect(details.changedFields).toEqual(['businessPhone']);
    expect(details.previous).toEqual({ businessPhone: '(281) 555-0100' });
    expect(details.next).toEqual({ businessPhone: '(281) 555-0199' });
  });
});

describe('no-op save', () => {
  it('rejects re-saving identical details and writes no second audit event', () => {
    service(db).updateBusinessConfig(complete());
    try {
      service(db).updateBusinessConfig(complete());
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('BUSINESS_SETTINGS_UNCHANGED');
    }
    expect(businessAuditRows(db)).toHaveLength(1);
    expect(auditCounter(db)).toBe(1);
  });

  it('treats a re-save with the same blank footer as unchanged', () => {
    service(db).updateBusinessConfig(complete({ receiptFooter: '' }));
    expect(() => service(db).updateBusinessConfig(complete({ receiptFooter: '   ' }))).toThrow();
  });
});

describe('validation at the trusted boundary', () => {
  it.each([
    ['blank address', complete({ businessAddress: '   ' })],
    ['blank phone', complete({ businessPhone: '' })],
    ['phone with no digit', complete({ businessPhone: 'ask in store' })],
  ])('rejects %s with no persistence and no audit', (_label, payload) => {
    expect(() => service(db).updateBusinessConfig(payload)).toThrow();
    expect(readBusinessSettings(db)).toEqual({
      businessAddress: null,
      businessPhone: null,
      receiptDisclaimer: null,
      receiptFooter: null,
      updatedAt: null,
    });
    expect(businessAuditRows(db)).toHaveLength(0);
    expect(auditCounter(db)).toBe(0);
  });

  it('rejects an unknown key (renderer cannot mutate an unrelated setting)', () => {
    expect(() =>
      service(db).updateBusinessConfig({ ...complete(), selectedPrinter: 'HP' } as never),
    ).toThrow();
    expect(readTaxRateSetting(db)).toBeNull();
  });
});

describe('atomic setting + audit mutation (REQ-AUDIT-004)', () => {
  it('a failing audit insert rolls back all four setting writes and does not advance the sequence', () => {
    service(db).updateBusinessConfig(complete());
    const counterBefore = auditCounter(db);
    const before = readBusinessSettings(db);

    db.exec('ALTER TABLE audit_events RENAME TO audit_events_x');
    try {
      expect(() =>
        service(db, () => T1).updateBusinessConfig(complete({ businessAddress: 'New Address' })),
      ).toThrow();
    } finally {
      db.exec('ALTER TABLE audit_events_x RENAME TO audit_events');
    }

    expect(readBusinessSettings(db)).toEqual(before); // no partial field update
    expect(businessAuditRows(db)).toHaveLength(1);
    expect(auditCounter(db)).toBe(counterBefore);

    service(db, () => T1).updateBusinessConfig(complete({ businessAddress: 'New Address' }));
    expect(businessAuditRows(db).map((r) => r['sequence'])).toEqual([1, 2]);
  });

  it('audit details carry only safe configuration context (no secrets / customer PII)', () => {
    service(db).updateBusinessConfig(complete());
    const details = businessAuditRows(db)[0]!['details_json'] as string;
    expect(details).not.toMatch(/password|secret|token|card number|ssn/i);
    expect(Object.keys(JSON.parse(details)).sort()).toEqual(['changedFields', 'next', 'previous']);
  });
});

describe('offline / restart persistence', () => {
  it('a configured business + its audit event survive close/reopen of the same file', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });

      createSettingsService({ db: conn, appVersion: 'test', now: () => T0 }).updateBusinessConfig(
        complete(),
      );
      conn.close();

      conn = openConfiguredConnection(file);
      const config = createSettingsService({ db: conn, appVersion: 'test' }).getBusinessConfig();
      expect(config.configured).toBe(true);
      expect(config.configured === true && config.businessAddress).toBe(
        '123 Main St, Alvin, TX 77511',
      );
      expect(
        (
          conn
            .prepare(
              "SELECT COUNT(*) c FROM audit_events WHERE event_type = 'BUSINESS_SETTING_CHANGED'",
            )
            .get() as { c: number }
        ).c,
      ).toBe(1);
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});

describe('interaction with Phase 2D.1 tax settings', () => {
  it('a business-settings change does not touch tax_rate_bps', () => {
    service(db).updateTaxRate({ taxRateBps: 825 });
    service(db, () => T1).updateBusinessConfig(complete());
    expect(readTaxRateSetting(db)).toEqual({ taxRateBps: 825, updatedAt: T0 });
  });

  it('a tax-settings change does not touch the business settings', () => {
    service(db).updateBusinessConfig(complete());
    const before = readBusinessSettings(db);
    service(db, () => T1).updateTaxRate({ taxRateBps: 700 });
    expect(readBusinessSettings(db)).toEqual(before);
  });
});

describe('historical sale preservation (setting-change portion of REQ-SALE-009)', () => {
  it('changing business settings leaves a pre-existing sales row snapshot untouched', () => {
    db.prepare(
      `INSERT INTO sales
         (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
          business_name_snapshot, business_address_snapshot, business_phone_snapshot,
          receipt_disclaimer_snapshot, receipt_footer_snapshot, status, subtotal_cents,
          taxable_amount_cents, tax_rate_bps, tax_cents, total_cents, payment_method_snapshot,
          created_at, completed_at, voided_at, void_reason)
       VALUES
         ('sale-1', 'GP-000001', NULL, NULL, NULL,
          'Go Phones - Alvin', 'Old Address', 'Old Phone', 'Old Disclaimer', 'Old Footer',
          'COMPLETED', 55000, 55000, 825, 4538, 59538, 'CASH', @t, @t, NULL, NULL)`,
    ).run({ t: T0 });

    service(db, () => T1).updateBusinessConfig(complete());

    expect(
      db
        .prepare(
          `SELECT business_name_snapshot, business_address_snapshot, business_phone_snapshot,
                  receipt_disclaimer_snapshot, receipt_footer_snapshot
             FROM sales WHERE id = 'sale-1'`,
        )
        .get(),
    ).toEqual({
      business_name_snapshot: 'Go Phones - Alvin',
      business_address_snapshot: 'Old Address',
      business_phone_snapshot: 'Old Phone',
      receipt_disclaimer_snapshot: 'Old Disclaimer',
      receipt_footer_snapshot: 'Old Footer',
    });
  });
});
