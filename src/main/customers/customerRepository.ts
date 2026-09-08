import type Database from 'better-sqlite3';
import type { CustomerPurchase, CustomerRecord } from '../../shared/customers';

/**
 * Customer SQL, isolated behind a repository (`ARCHITECTURE.md §12`).
 *
 * Repositories own SQL and row shape; they open no transactions and make no
 * business decisions. Every function takes the connection it should use.
 */

interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly phone_normalized: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const SELECT_COLUMNS = 'id, name, phone, phone_normalized, created_at, updated_at';

export function toCustomerRecord(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    phoneNormalized: row.phone_normalized,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertCustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
  readonly createdAt: string;
}

export function insertCustomer(db: Database.Database, row: InsertCustomerRow): void {
  db.prepare(
    `INSERT INTO customers (id, name, phone, phone_normalized, created_at, updated_at)
     VALUES (@id, @name, @phone, @phoneNormalized, @createdAt, @createdAt)`,
  ).run(row);
}

export interface UpdateCustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
  readonly updatedAt: string;
}

export function updateCustomer(db: Database.Database, row: UpdateCustomerRow): void {
  db.prepare(
    `UPDATE customers
       SET name = @name, phone = @phone, phone_normalized = @phoneNormalized, updated_at = @updatedAt
     WHERE id = @id`,
  ).run(row);
}

export function findCustomerById(db: Database.Database, id: string): CustomerRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM customers WHERE id = ?`).get(id) as
    CustomerRow | undefined;
  return row ? toCustomerRecord(row) : null;
}

/** Deterministic ordering: name (case-insensitive) then id (`task §7`). */
export function listCustomers(db: Database.Database): readonly CustomerRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM customers ORDER BY name COLLATE NOCASE ASC, id ASC`)
    .all() as CustomerRow[];
  return rows.map(toCustomerRecord);
}

/**
 * Local offline search (`DATA_MODEL.md §38`, `REQ-CUST-003`, `REQ-OFF-005`).
 * Name is a substring match; when the query contains digits they are matched as
 * a substring of `phone_normalized`, so `(281) 824-0001`, `281-824-0001`, and
 * `2818240001` all locate the same customer. Same-phone customers stay separate
 * rows — nothing merges them.
 */
export function searchCustomers(
  db: Database.Database,
  options: { readonly nameQuery: string; readonly phoneDigits: string },
): readonly CustomerRecord[] {
  const name = options.nameQuery.trim();
  const digits = options.phoneDigits;

  if (name.length === 0 && digits.length === 0) {
    return listCustomers(db);
  }

  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (name.length > 0) {
    params['nameContains'] = `%${name.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    clauses.push(`name LIKE @nameContains ESCAPE '\\'`);
  }
  if (digits.length > 0) {
    params['phoneContains'] = `%${digits}%`;
    clauses.push('phone_normalized LIKE @phoneContains');
  }

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM customers
       WHERE ${clauses.join(' OR ')}
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all(params) as CustomerRow[];
  return rows.map(toCustomerRecord);
}

interface SaleHistoryRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly completed_at: string;
  readonly status: 'COMPLETED' | 'VOIDED';
  readonly total_cents: number;
  readonly payment_method_snapshot: 'CASH' | 'CARD';
}

/**
 * Read-only purchase history for one customer (`REQ-CUST-005`). Reads immutable
 * `sales` rows keyed by `sales.customer_id`; newest completed sale first, id as
 * the deterministic tie-break. Never mutates anything.
 */
export function listPurchaseHistory(
  db: Database.Database,
  customerId: string,
): readonly CustomerPurchase[] {
  const rows = db
    .prepare(
      `SELECT id, receipt_number, completed_at, status, total_cents, payment_method_snapshot
         FROM sales
        WHERE customer_id = ?
        ORDER BY completed_at DESC, id DESC`,
    )
    .all(customerId) as SaleHistoryRow[];
  return rows.map((row) => ({
    saleId: row.id,
    receiptNumber: row.receipt_number,
    completedAt: row.completed_at,
    status: row.status,
    totalCents: row.total_cents,
    paymentMethod: row.payment_method_snapshot,
  }));
}
