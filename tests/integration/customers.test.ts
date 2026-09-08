import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createCustomerService } from '../../src/main/customers/customerService';
import { isAppError } from '../../src/main/shared/appError';
import {
  backupGateUnreachable,
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
} from '../helpers/database';

/**
 * Customers vertical-slice integration tests against real SQLite
 * (`TEST_PLAN.md` TEST-CUST-001/002/003/007/008/009 + task `§14`-`§16`).
 */

const T = '2026-09-08T12:00:00.000Z';

function service(db: Database.Database, now: () => string = () => T) {
  return createCustomerService({ db, now });
}

/**
 * Seed a canonical `sales` row directly (task `§8`, `§15`): purchase-history is a
 * read path over already-existing sales; no SaleService / checkout is built to
 * make this test possible.
 */
function seedSale(
  db: Database.Database,
  sale: {
    id: string;
    customerId: string;
    receiptNumber: string;
    completedAt: string;
    totalCents: number;
    paymentMethod?: 'CASH' | 'CARD';
    status?: 'COMPLETED' | 'VOIDED';
  },
): void {
  const status = sale.status ?? 'COMPLETED';
  db.prepare(
    `INSERT INTO sales
       (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
        business_name_snapshot, business_address_snapshot, business_phone_snapshot,
        receipt_disclaimer_snapshot, receipt_footer_snapshot, status, subtotal_cents,
        taxable_amount_cents, tax_rate_bps, tax_cents, total_cents, payment_method_snapshot,
        created_at, completed_at, voided_at, void_reason)
     VALUES
       (@id, @receipt, @customerId, 'Snapshot Name', NULL,
        'Biz', 'Addr', '555', 'Disclaimer', 'Footer', @status, @total,
        @total, 0, 0, @total, @method,
        @completedAt, @completedAt, @voidedAt, @voidReason)`,
  ).run({
    id: sale.id,
    receipt: sale.receiptNumber,
    customerId: sale.customerId,
    status,
    total: sale.totalCents,
    method: sale.paymentMethod ?? 'CASH',
    completedAt: sale.completedAt,
    voidedAt: status === 'VOIDED' ? sale.completedAt : null,
    voidReason: status === 'VOIDED' ? 'test void' : null,
  });
}

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});

afterEach(() => {
  db.close();
});

describe('TEST-CUST-001 — Create Customer', () => {
  it('persists a valid customer and returns a renderer-safe DTO', () => {
    const customer = service(db).create({ name: 'Jane Doe', phone: '(281) 824-0001' });
    expect(customer).toMatchObject({
      name: 'Jane Doe',
      phone: '(281) 824-0001',
      phoneNormalized: '2818240001',
      createdAt: T,
      updatedAt: T,
    });
    expect(customer.id).toMatch(/[0-9a-f-]{36}/);
    expect(db.prepare('SELECT COUNT(*) AS c FROM customers').get()).toMatchObject({ c: 1 });
  });

  it('trims the stored name', () => {
    const customer = service(db).create({ name: '   Spacey Name   ' });
    expect(customer.name).toBe('Spacey Name');
    const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(customer.id);
    expect(row).toEqual({ name: 'Spacey Name' });
  });
});

describe('TEST-CUST-008 — Customer Without Phone', () => {
  it('name-only customer is valid; phone and phone_normalized are NULL', () => {
    const customer = service(db).create({ name: 'No Phone' });
    expect(customer.phone).toBeNull();
    expect(customer.phoneNormalized).toBeNull();
    const row = db
      .prepare('SELECT phone, phone_normalized FROM customers WHERE id = ?')
      .get(customer.id);
    expect(row).toEqual({ phone: null, phone_normalized: null });
  });

  it('a blank / whitespace phone becomes NULL', () => {
    const customer = service(db).create({ name: 'Blank Phone', phone: '   ' });
    expect(customer.phone).toBeNull();
    expect(customer.phoneNormalized).toBeNull();
  });

  it('is still found by name search', () => {
    service(db).create({ name: 'Findable NoPhone' });
    expect(service(db).search({ query: 'findable' })).toHaveLength(1);
  });
});

describe('TEST-CUST-002 — Search Customer by Name', () => {
  it('substring, case-insensitive name match', () => {
    service(db).create({ name: 'Alice Johnson' });
    service(db).create({ name: 'Bob Smith' });
    expect(service(db).search({ query: 'john' })).toHaveLength(1);
    expect(service(db).search({ query: 'SMITH' })).toHaveLength(1);
    expect(service(db).search({ query: 'nobody' })).toHaveLength(0);
  });

  it('deterministic ordering: name then id', () => {
    service(db).create({ name: 'Zed' });
    service(db).create({ name: 'alpha' });
    service(db).create({ name: 'Mid' });
    expect(
      service(db)
        .list()
        .map((c) => c.name),
    ).toEqual(['alpha', 'Mid', 'Zed']);
  });
});

describe('TEST-CUST-003 / TEST-CUST-009 — Search Customer by Phone / Phone Normalization', () => {
  it('all common formats of the same number locate the same customer', () => {
    const created = service(db).create({ name: 'Phone Person', phone: '(281) 824-0001' });
    for (const term of ['281-824-0001', '2818240001', '(281) 824-0001', '281 824 0001']) {
      const results = service(db).search({ query: term });
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(created.id);
    }
  });

  it('a partial digit run matches as a substring of phone_normalized', () => {
    service(db).create({ name: 'Partial', phone: '281-824-0001' });
    expect(service(db).search({ query: '8240001' })).toHaveLength(1);
    expect(service(db).search({ query: '999' })).toHaveLength(0);
  });
});

describe('duplicate phone numbers are allowed and stay separate (DATA_MODEL §10)', () => {
  it('two customers may share a phone; search returns both, nothing merges', () => {
    const a = service(db).create({ name: 'Household A', phone: '281-824-0001' });
    const b = service(db).create({ name: 'Household B', phone: '(281) 824-0001' });
    expect(a.id).not.toBe(b.id);

    const byPhone = service(db).search({ query: '2818240001' });
    expect(byPhone.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(db.prepare('SELECT COUNT(*) AS c FROM customers').get()).toMatchObject({ c: 2 });
  });
});

describe('editing a customer updates the live record and recomputes phone_normalized (REQ-CUST-007)', () => {
  it('editing the phone recomputes phone_normalized and bumps updated_at', () => {
    const created = createCustomerService({ db, now: () => T }).create({
      name: 'Editable',
      phone: '281-824-0001',
    });
    const later = '2026-09-09T09:00:00.000Z';
    const updated = createCustomerService({ db, now: () => later }).update(created.id, {
      name: 'Editable Renamed',
      phone: '(713) 555-9000 ext 2',
    });
    expect(updated.name).toBe('Editable Renamed');
    expect(updated.phone).toBe('(713) 555-9000 ext 2');
    expect(updated.phoneNormalized).toBe('71355590002');
    expect(updated.updatedAt).toBe(later);
    expect(updated.createdAt).toBe(T);
  });

  it('editing the phone to blank clears both phone and phone_normalized', () => {
    const created = service(db).create({ name: 'Clear Phone', phone: '2818240001' });
    const updated = service(db).update(created.id, { name: 'Clear Phone', phone: '   ' });
    expect(updated.phone).toBeNull();
    expect(updated.phoneNormalized).toBeNull();
    const row = db
      .prepare('SELECT phone, phone_normalized FROM customers WHERE id = ?')
      .get(created.id);
    expect(row).toEqual({ phone: null, phone_normalized: null });
  });

  it('rejects editing an unknown customer', () => {
    try {
      service(db).update('no-such-id', { name: 'x', phone: null });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CUSTOMER_NOT_FOUND');
    }
  });
});

describe('malformed payloads are rejected before any repository mutation', () => {
  it.each([
    ['blank name', { name: '   ' }],
    ['whitespace-only name', { name: '\t\n' }],
    ['missing name', { phone: '2818240001' }],
    ['non-string name', { name: 42 }],
    ['non-string phone', { name: 'X', phone: 5551234 }],
    ['phone with no digits', { name: 'X', phone: '---' }],
    ['unexpected field', { name: 'X', email: 'a@b.c' }],
    ['not an object', 'nope'],
  ])('rejects %s and writes nothing', (_label, payload) => {
    expect(() => service(db).create(payload as never)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS c FROM customers').get()).toMatchObject({ c: 0 });
  });

  it('create errors are typed VALIDATION AppErrors', () => {
    try {
      service(db).create({ name: '' });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('TEST-CUST-007 — Customer Purchase-History Lookup', () => {
  it('returns exactly the customer’s sales, newest first, excluding others; no mutation', () => {
    const a = service(db).create({ name: 'Customer A' });
    const b = service(db).create({ name: 'Customer B' });

    seedSale(db, {
      id: 'S1',
      customerId: a.id,
      receiptNumber: 'GP-000001',
      completedAt: '2026-09-01T10:00:00.000Z',
      totalCents: 10000,
    });
    seedSale(db, {
      id: 'S2',
      customerId: a.id,
      receiptNumber: 'GP-000002',
      completedAt: '2026-09-03T10:00:00.000Z',
      totalCents: 20000,
      paymentMethod: 'CARD',
    });
    seedSale(db, {
      id: 'S3',
      customerId: a.id,
      receiptNumber: 'GP-000003',
      completedAt: '2026-09-02T10:00:00.000Z',
      totalCents: 30000,
      status: 'VOIDED',
    });
    seedSale(db, {
      id: 'S4',
      customerId: b.id,
      receiptNumber: 'GP-000004',
      completedAt: '2026-09-05T10:00:00.000Z',
      totalCents: 40000,
    });

    const snapshotBefore = db
      .prepare('SELECT id, customer_id, total_cents FROM sales ORDER BY id')
      .all();

    const history = service(db).purchaseHistory(a.id);
    expect(history.map((h) => h.saleId)).toEqual(['S2', 'S3', 'S1']); // newest completed_at first
    expect(history.map((h) => h.receiptNumber)).toEqual(['GP-000002', 'GP-000003', 'GP-000001']);
    expect(history.find((h) => h.saleId === 'S3')).toMatchObject({ status: 'VOIDED' });
    expect(history.find((h) => h.saleId === 'S2')).toMatchObject({
      paymentMethod: 'CARD',
      totalCents: 20000,
    });

    // Customer B's sale is excluded.
    expect(history.some((h) => h.saleId === 'S4')).toBe(false);

    // Read-only: nothing changed.
    expect(db.prepare('SELECT id, customer_id, total_cents FROM sales ORDER BY id').all()).toEqual(
      snapshotBefore,
    );
  });

  it('a customer with no sales returns []', () => {
    const c = service(db).create({ name: 'No Sales' });
    expect(service(db).purchaseHistory(c.id)).toEqual([]);
  });

  it('rejects purchase-history for an unknown customer', () => {
    try {
      service(db).purchaseHistory('no-such-id');
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CUSTOMER_NOT_FOUND');
    }
  });
});

describe('REQ-CUST-006 / REQ-OFF-005 / task §16 — offline + restart persistence', () => {
  it('customer survives close/reopen; name and phone-normalized search still work', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });
      const created = createCustomerService({ db: conn, now: () => T }).create({
        name: 'Persisted Pat',
        phone: '(281) 824-0001',
      });
      conn.close();

      conn = openConfiguredConnection(file);
      const svc = createCustomerService({ db: conn });
      expect(svc.get(created.id)).toMatchObject({
        name: 'Persisted Pat',
        phoneNormalized: '2818240001',
      });
      expect(svc.search({ query: 'persisted' }).map((c) => c.id)).toEqual([created.id]);
      expect(svc.search({ query: '281-824-0001' }).map((c) => c.id)).toEqual([created.id]);
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});
