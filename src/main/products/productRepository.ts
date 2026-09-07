import type Database from 'better-sqlite3';
import type { ProductCondition, ProductRecord } from '../../shared/products';

/**
 * Product SQL, isolated behind a repository (`ARCHITECTURE.md §12`).
 *
 * Repositories own SQL and row shape; they never open transactions or make
 * business decisions — a service does that. Every function takes the connection
 * it should use, so the same function works standalone or inside a service's
 * open transaction.
 */

interface ProductRow {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly cost_price_cents: number | null;
  readonly selling_price_cents: number;
  readonly quantity_on_hand: number;
  readonly low_stock_threshold: number | null;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const SELECT_COLUMNS = `
  id, sku, barcode, name, brand, model, condition, cost_price_cents, selling_price_cents,
  quantity_on_hand, low_stock_threshold, is_active, created_at, updated_at
`;

/** Single source of the low-/zero-stock rule (`DATA_MODEL.md §13`, `REQ-PROD-007`). */
export function toProductRecord(row: ProductRow): ProductRecord {
  const lowStock =
    row.low_stock_threshold !== null && row.quantity_on_hand <= row.low_stock_threshold;
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    model: row.model,
    condition: row.condition,
    costPriceCents: row.cost_price_cents,
    sellingPriceCents: row.selling_price_cents,
    quantityOnHand: row.quantity_on_hand,
    lowStockThreshold: row.low_stock_threshold,
    isActive: row.is_active === 1,
    lowStock,
    zeroStock: row.quantity_on_hand === 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertProductRow {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly costPriceCents: number | null;
  readonly sellingPriceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold: number | null;
  readonly createdAt: string;
}

export function insertProduct(db: Database.Database, row: InsertProductRow): void {
  db.prepare(
    `INSERT INTO products
       (id, sku, barcode, name, brand, model, condition, cost_price_cents, selling_price_cents,
        quantity_on_hand, low_stock_threshold, is_active, created_at, updated_at)
     VALUES
       (@id, @sku, @barcode, @name, @brand, @model, @condition, @costPriceCents, @sellingPriceCents,
        @quantity, @lowStockThreshold, 1, @createdAt, @createdAt)`,
  ).run(row);
}

export interface UpdateProductRow {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPriceCents: number;
  readonly costPriceCents: number | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly lowStockThreshold: number | null;
  readonly updatedAt: string;
}

/** Updates editable metadata/pricing only — never `quantity_on_hand` (`DATA_MODEL.md §40`). */
export function updateProduct(db: Database.Database, row: UpdateProductRow): void {
  db.prepare(
    `UPDATE products SET
       name = @name, brand = @brand, model = @model, condition = @condition,
       selling_price_cents = @sellingPriceCents, cost_price_cents = @costPriceCents,
       sku = @sku, barcode = @barcode, low_stock_threshold = @lowStockThreshold,
       updated_at = @updatedAt
     WHERE id = @id`,
  ).run(row);
}

export function setProductActive(
  db: Database.Database,
  id: string,
  isActive: boolean,
  updatedAt: string,
): void {
  db.prepare('UPDATE products SET is_active = ?, updated_at = ? WHERE id = ?').run(
    isActive ? 1 : 0,
    updatedAt,
    id,
  );
}

export function setProductQuantity(
  db: Database.Database,
  id: string,
  quantity: number,
  updatedAt: string,
): void {
  db.prepare('UPDATE products SET quantity_on_hand = ?, updated_at = ? WHERE id = ?').run(
    quantity,
    updatedAt,
    id,
  );
}

export function findProductById(db: Database.Database, id: string): ProductRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM products WHERE id = ?`).get(id) as
    ProductRow | undefined;
  return row ? toProductRecord(row) : null;
}

/** Current authoritative quantity, or `null` if the product does not exist. */
export function readCurrentQuantity(db: Database.Database, id: string): number | null {
  const row = db.prepare('SELECT quantity_on_hand FROM products WHERE id = ?').get(id) as
    { quantity_on_hand: number } | undefined;
  return row ? row.quantity_on_hand : null;
}

export function skuExists(db: Database.Database, sku: string, excludeId?: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM products WHERE sku = ? AND (? IS NULL OR id <> ?) LIMIT 1')
    .get(sku, excludeId ?? null, excludeId ?? null);
  return row !== undefined;
}

export function barcodeExists(db: Database.Database, barcode: string, excludeId?: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM products WHERE barcode = ? AND (? IS NULL OR id <> ?) LIMIT 1')
    .get(barcode, excludeId ?? null, excludeId ?? null);
  return row !== undefined;
}

/** Exact, case-sensitive, byte-for-byte barcode match; active products only (`DATA_MODEL.md §6`). */
export function findActiveByBarcode(db: Database.Database, barcode: string): ProductRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM products WHERE barcode = ? AND is_active = 1`)
    .get(barcode) as ProductRow | undefined;
  return row ? toProductRecord(row) : null;
}

export function listProducts(
  db: Database.Database,
  options: { readonly includeArchived: boolean },
): readonly ProductRecord[] {
  const where = options.includeArchived ? '' : 'WHERE is_active = 1';
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM products ${where} ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as ProductRow[];
  return rows.map(toProductRecord);
}

/**
 * Deterministic offline search over name / brand / model / SKU / barcode
 * (`DATA_MODEL.md §38`, `REQ-PROD-005`). Substring match on the text fields,
 * exact match on SKU/barcode identifiers. No FTS, no fuzzy matching.
 */
export function searchProducts(
  db: Database.Database,
  options: { readonly query: string; readonly includeArchived: boolean },
): readonly ProductRecord[] {
  const term = options.query.trim();
  if (term.length === 0) {
    return listProducts(db, { includeArchived: options.includeArchived });
  }
  // Escape LIKE wildcards in user input; use an explicit ESCAPE clause.
  const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const contains = `%${escaped}%`;
  const activeClause = options.includeArchived ? '' : 'AND is_active = 1';
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM products
       WHERE (
         name  LIKE @contains ESCAPE '\\'
         OR brand LIKE @contains ESCAPE '\\'
         OR model LIKE @contains ESCAPE '\\'
         OR sku = @term
         OR barcode = @term
       )
       ${activeClause}
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all({ contains, term }) as ProductRow[];
  return rows.map(toProductRecord);
}
