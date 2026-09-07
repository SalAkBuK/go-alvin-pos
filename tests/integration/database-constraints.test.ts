import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDb } from '../helpers/database';

/**
 * Database-level constraint coverage (`DATA_MODEL.md §35, §53`;
 * `TEST_PLAN.md` TEST-DB-003..015). Everything here is enforced by SQLite
 * itself — not by a future TypeScript layer.
 */

const T = '2026-09-07T12:00:00.000Z';

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});

afterEach(() => {
  db.close();
});

// ── minimal valid row builders ───────────────────────────────────────────────

function insertProduct(id: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const row = {
    id,
    sku: null,
    barcode: null,
    name: 'Phone',
    brand: 'Brand',
    model: 'Model',
    condition: 'NEW',
    cost_price_cents: null,
    selling_price_cents: 19900,
    quantity_on_hand: 5,
    low_stock_threshold: null,
    is_active: 1,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO products
       (id, sku, barcode, name, brand, model, condition, cost_price_cents, selling_price_cents,
        quantity_on_hand, low_stock_threshold, is_active, created_at, updated_at)
     VALUES (@id, @sku, @barcode, @name, @brand, @model, @condition, @cost_price_cents,
             @selling_price_cents, @quantity_on_hand, @low_stock_threshold, @is_active, '${T}', '${T}')`,
  ).run(row);
  return id;
}

function insertCustomer(id: string): string {
  db.prepare(
    `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, 'Walk In', '${T}', '${T}')`,
  ).run(id);
  return id;
}

function insertSale(id: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const row = {
    id,
    receipt_number: `GP-${id}`,
    customer_id: null,
    customer_name_snapshot: null,
    customer_phone_snapshot: null,
    status: 'COMPLETED',
    subtotal_cents: 55000,
    taxable_amount_cents: 55000,
    tax_rate_bps: 825,
    tax_cents: 4538,
    total_cents: 59538,
    payment_method_snapshot: 'CASH',
    voided_at: null,
    void_reason: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sales
       (id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
        business_name_snapshot, business_address_snapshot, business_phone_snapshot,
        receipt_disclaimer_snapshot, receipt_footer_snapshot, status, subtotal_cents,
        taxable_amount_cents, tax_rate_bps, tax_cents, total_cents, payment_method_snapshot,
        created_at, completed_at, voided_at, void_reason)
     VALUES (@id, @receipt_number, @customer_id, @customer_name_snapshot, @customer_phone_snapshot,
             'Biz', 'Addr', '555', 'Disclaimer', 'Footer', @status, @subtotal_cents,
             @taxable_amount_cents, @tax_rate_bps, @tax_cents, @total_cents, @payment_method_snapshot,
             '${T}', '${T}', @voided_at, @void_reason)`,
  ).run(row);
  return id;
}

function insertSaleItem(id: string, saleId: string, productId: string): string {
  db.prepare(
    `INSERT INTO sale_items
       (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
        condition_snapshot, listed_price_cents, sold_price_cents, discount_cents, quantity,
        line_subtotal_cents, line_total_cents, created_at)
     VALUES (?, ?, ?, 'Phone', 'Brand', 'Model', 'NEW', 19900, 19900, 0, 1, 19900, 19900, '${T}')`,
  ).run(id, saleId, productId);
  return id;
}

function insertPayment(id: string, saleId: string): string {
  db.prepare(
    `INSERT INTO payments (id, sale_id, method, amount_cents, status, created_at)
     VALUES (?, ?, 'CASH', 59538, 'COMPLETED', '${T}')`,
  ).run(id, saleId);
  return id;
}

function insertSaleMovement(id: string, productId: string, saleId: string): string {
  db.prepare(
    `INSERT INTO inventory_movements
       (id, product_id, sale_id, movement_type, quantity_change, quantity_before, quantity_after, created_at)
     VALUES (?, ?, ?, 'SALE', -1, 5, 4, '${T}')`,
  ).run(id, productId, saleId);
  return id;
}

function insertExportJob(id: string, saleId: string): string {
  db.prepare(
    `INSERT INTO google_sheet_export_jobs (id, sale_id, status, target_sync_version, attempt_count, created_at, updated_at)
     VALUES (?, ?, 'PENDING', 1, 0, '${T}', '${T}')`,
  ).run(id, saleId);
  return id;
}

function insertCompletedCheckoutRequest(id: string, saleId: string): string {
  db.prepare(
    `INSERT INTO checkout_requests
       (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents, sale_id, status, created_at, completed_at)
     VALUES (?, 'fp', 'CASH', 59538, ?, 'COMPLETED', '${T}', '${T}')`,
  ).run(id, saleId);
  return id;
}

// ── TEST-DB-003 — foreign keys enforced ──────────────────────────────────────

describe('TEST-DB-003 — foreign keys enforced', () => {
  it('has PRAGMA foreign_keys ON', () => {
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
  });

  it('rejects a sale_item that references a missing sale', () => {
    insertProduct('P1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_items
             (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
              condition_snapshot, listed_price_cents, sold_price_cents, discount_cents, quantity,
              line_subtotal_cents, line_total_cents, created_at)
           VALUES ('SI1', 'NO-SUCH-SALE', 'P1', 'Phone', 'B', 'M', 'NEW', 100, 100, 0, 1, 100, 100, '${T}')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ── TEST-DB-004 — negative quantity rejected ─────────────────────────────────

describe('TEST-DB-004 — negative inventory rejected by the database', () => {
  it('rejects products.quantity_on_hand < 0', () => {
    expect(() => insertProduct('P1', { quantity_on_hand: -1 })).toThrow(/CHECK/i);
  });

  it('rejects an inventory movement whose quantity_after < 0', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, product_id, sale_id, movement_type, quantity_change, quantity_before, quantity_after, created_at)
           VALUES ('M1', ?, ?, 'SALE', -2, 1, -1, '${T}')`,
        )
        .run(p, s),
    ).toThrow(/CHECK/i);
  });
});

// ── TEST-DB-005 — duplicate receipt number ───────────────────────────────────

describe('TEST-DB-005 — duplicate receipt number rejected', () => {
  it('rejects two sales with the same receipt_number', () => {
    insertSale('S1', { receipt_number: 'GP-000001' });
    expect(() => insertSale('S2', { receipt_number: 'GP-000001' })).toThrow(/UNIQUE/i);
  });
});

// ── TEST-DB-006 — one export job per sale ────────────────────────────────────

describe('TEST-DB-006 — second export job for the same sale rejected', () => {
  it('rejects a duplicate google_sheet_export_jobs.sale_id', () => {
    const s = insertSale('S1');
    insertExportJob('J1', s);
    expect(() => insertExportJob('J2', s)).toThrow(/UNIQUE/i);
  });
});

// ── TEST-DB-009 — enum constraints ──────────────────────────────────────────

describe('TEST-DB-009 — documented enums enforced by SQLite', () => {
  it('rejects an unknown products.condition', () => {
    expect(() => insertProduct('P1', { condition: 'LIKE_NEW' })).toThrow(/CHECK/i);
  });

  it('rejects an unknown sales.status', () => {
    expect(() => insertSale('S1', { status: 'PENDING' })).toThrow(/CHECK/i);
  });

  it('rejects an unknown inventory_movements.movement_type', () => {
    const p = insertProduct('P1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, product_id, movement_type, quantity_change, quantity_before, quantity_after, created_at)
           VALUES ('M1', ?, 'RETURN', 1, 0, 1, '${T}')`,
        )
        .run(p),
    ).toThrow(/CHECK/i);
  });

  it('rejects an unknown payments.method', () => {
    const s = insertSale('S1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO payments (id, sale_id, method, amount_cents, status, created_at)
           VALUES ('PM1', ?, 'CHECK', 100, 'COMPLETED', '${T}')`,
        )
        .run(s),
    ).toThrow(/CHECK/i);
  });

  it('rejects an unknown google_sheet_export_jobs.status', () => {
    const s = insertSale('S1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO google_sheet_export_jobs (id, sale_id, status, target_sync_version, attempt_count, created_at, updated_at)
           VALUES ('J1', ?, 'DONE', 1, 0, '${T}', '${T}')`,
        )
        .run(s),
    ).toThrow(/CHECK/i);
  });
});

// ── TEST-DB-010 — foreign-key ON DELETE behaviour (§35) ──────────────────────

describe('TEST-DB-010 — ON DELETE behaviour matches DATA_MODEL §35', () => {
  it('sales.customer_id → SET NULL (sale survives, link cleared)', () => {
    const c = insertCustomer('C1');
    insertSale('S1', { customer_id: c, customer_name_snapshot: 'Walk In' });
    db.prepare('DELETE FROM customers WHERE id = ?').run(c);
    const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get('S1') as {
      customer_id: string | null;
    };
    expect(sale.customer_id).toBeNull();
  });

  it('sale_items.sale_id → RESTRICT', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleItem('SI1', s, p);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(s)).toThrow(/FOREIGN KEY/i);
  });

  it('sale_items.product_id → RESTRICT', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleItem('SI1', s, p);
    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(p)).toThrow(/FOREIGN KEY/i);
  });

  it('payments.sale_id → RESTRICT', () => {
    const s = insertSale('S1');
    insertPayment('PM1', s);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(s)).toThrow(/FOREIGN KEY/i);
  });

  it('inventory_movements.product_id → RESTRICT', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleMovement('M1', p, s);
    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(p)).toThrow(/FOREIGN KEY/i);
  });

  it('inventory_movements.sale_id → RESTRICT', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleMovement('M1', p, s);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(s)).toThrow(/FOREIGN KEY/i);
  });

  it('inventory_movements.reverses_movement_id → RESTRICT', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleMovement('M1', p, s);
    db.prepare(
      `INSERT INTO inventory_movements
         (id, product_id, sale_id, movement_type, reverses_movement_id, quantity_change, quantity_before, quantity_after, created_at)
       VALUES ('M2', ?, ?, 'VOID_REVERSAL', 'M1', 1, 4, 5, '${T}')`,
    ).run(p, s);
    expect(() => db.prepare('DELETE FROM inventory_movements WHERE id = ?').run('M1')).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('google_sheet_export_jobs.sale_id → CASCADE', () => {
    const s = insertSale('S1');
    insertExportJob('J1', s);
    db.prepare('DELETE FROM sales WHERE id = ?').run(s);
    const row = db.prepare('SELECT COUNT(*) AS count FROM google_sheet_export_jobs').get() as {
      count: number;
    };
    expect(row.count).toBe(0);
  });

  it('checkout_requests.sale_id → RESTRICT', () => {
    const s = insertSale('S1');
    insertCompletedCheckoutRequest('CHK1', s);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(s)).toThrow(/FOREIGN KEY/i);
  });
});

// ── TEST-DB-011 — one payment per sale ──────────────────────────────────────

describe('TEST-DB-011 — second payment for the same sale rejected', () => {
  it('rejects a duplicate payments.sale_id', () => {
    const s = insertSale('S1');
    insertPayment('PM1', s);
    expect(() => insertPayment('PM2', s)).toThrow(/UNIQUE/i);
  });
});

// ── TEST-DB-013 — line arithmetic constraints ───────────────────────────────

describe('TEST-DB-013 — sale-item line arithmetic enforced', () => {
  it('rejects line_subtotal_cents != listed_price_cents * quantity', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_items
             (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
              condition_snapshot, listed_price_cents, sold_price_cents, discount_cents, quantity,
              line_subtotal_cents, line_total_cents, created_at)
           VALUES ('SI1', ?, ?, 'Phone', 'B', 'M', 'NEW', 100, 100, 0, 2, 999, 200, '${T}')`,
        )
        .run(s, p),
    ).toThrow(/CHECK/i);
  });
});

// ── TEST-DB-014 — one reversal per original movement ────────────────────────

describe('TEST-DB-014 — second reversal for the same movement rejected', () => {
  it('rejects a duplicate reverses_movement_id', () => {
    const p = insertProduct('P1');
    const s = insertSale('S1');
    insertSaleMovement('M1', p, s);
    db.prepare(
      `INSERT INTO inventory_movements
         (id, product_id, sale_id, movement_type, reverses_movement_id, quantity_change, quantity_before, quantity_after, created_at)
       VALUES ('M2', ?, ?, 'VOID_REVERSAL', 'M1', 1, 4, 5, '${T}')`,
    ).run(p, s);
    expect(() =>
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, product_id, sale_id, movement_type, reverses_movement_id, quantity_change, quantity_before, quantity_after, created_at)
           VALUES ('M3', ?, ?, 'VOID_REVERSAL', 'M1', 1, 5, 6, '${T}')`,
        )
        .run(p, s),
    ).toThrow(/UNIQUE/i);
  });
});

// ── TEST-DB-015 — void-field / status consistency ──────────────────────────

describe('TEST-DB-015 — void-field consistency enforced', () => {
  it('rejects status=VOIDED with a null voided_at / void_reason', () => {
    expect(() =>
      insertSale('S1', { status: 'VOIDED', voided_at: null, void_reason: null }),
    ).toThrow(/CHECK/i);
  });

  it('rejects status=COMPLETED with a non-null voided_at', () => {
    expect(() => insertSale('S1', { status: 'COMPLETED', voided_at: T, void_reason: 'x' })).toThrow(
      /CHECK/i,
    );
  });

  it('accepts a well-formed VOIDED sale', () => {
    expect(() =>
      insertSale('S1', { status: 'VOIDED', voided_at: T, void_reason: 'customer returned item' }),
    ).not.toThrow();
  });
});

// ── SKU / barcode uniqueness model (§6) ────────────────────────────────────

describe('SKU / barcode uniqueness model (§6)', () => {
  it('allows many products with no SKU and no barcode', () => {
    expect(() => {
      insertProduct('P1');
      insertProduct('P2');
      insertProduct('P3');
    }).not.toThrow();
  });

  it('rejects a duplicate SKU when present', () => {
    insertProduct('P1', { sku: 'ABC-100' });
    expect(() => insertProduct('P2', { sku: 'ABC-100' })).toThrow(/UNIQUE/i);
  });

  it('treats SKUs case-sensitively', () => {
    insertProduct('P1', { sku: 'ABC-100' });
    expect(() => insertProduct('P2', { sku: 'abc-100' })).not.toThrow();
  });

  it('rejects a blank / untrimmed SKU (must be NULL when blank)', () => {
    expect(() => insertProduct('P1', { sku: '' })).toThrow(/CHECK/i);
    expect(() => insertProduct('P2', { sku: '  X  ' })).toThrow(/CHECK/i);
  });
});
