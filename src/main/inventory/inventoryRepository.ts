import type Database from 'better-sqlite3';
import type { InventoryMovementRecord } from '../../shared/products';

/**
 * Inventory-movement SQL (`ARCHITECTURE.md §12`, `DATA_MODEL.md §17`).
 *
 * Movements are immutable business records — this repository only inserts and
 * reads them, never updates or deletes. It opens no transaction of its own.
 */

interface MovementRow {
  readonly id: string;
  readonly product_id: string;
  readonly movement_type: InventoryMovementRecord['movementType'];
  readonly quantity_change: number;
  readonly quantity_before: number;
  readonly quantity_after: number;
  readonly reason: string | null;
  readonly created_at: string;
}

function toMovementRecord(row: MovementRow): InventoryMovementRecord {
  return {
    id: row.id,
    productId: row.product_id,
    movementType: row.movement_type,
    quantityChange: row.quantity_change,
    quantityBefore: row.quantity_before,
    quantityAfter: row.quantity_after,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export interface InsertMovementRow {
  readonly id: string;
  readonly productId: string;
  readonly saleId: string | null;
  readonly movementType: InventoryMovementRecord['movementType'];
  readonly reversesMovementId: string | null;
  readonly quantityChange: number;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

export function insertMovement(db: Database.Database, row: InsertMovementRow): void {
  db.prepare(
    `INSERT INTO inventory_movements
       (id, product_id, sale_id, movement_type, reverses_movement_id,
        quantity_change, quantity_before, quantity_after, reason, created_at)
     VALUES
       (@id, @productId, @saleId, @movementType, @reversesMovementId,
        @quantityChange, @quantityBefore, @quantityAfter, @reason, @createdAt)`,
  ).run(row);
}

export function findMovementById(
  db: Database.Database,
  id: string,
): InventoryMovementRecord | null {
  const row = db
    .prepare(
      `SELECT id, product_id, movement_type, quantity_change, quantity_before, quantity_after,
              reason, created_at
         FROM inventory_movements WHERE id = ?`,
    )
    .get(id) as MovementRow | undefined;
  return row ? toMovementRecord(row) : null;
}

/** Full movement history for one product, newest first (`created_at`, then `id` for a stable tiebreak). */
export function listMovementsForProduct(
  db: Database.Database,
  productId: string,
): readonly InventoryMovementRecord[] {
  const rows = db
    .prepare(
      `SELECT id, product_id, movement_type, quantity_change, quantity_before, quantity_after,
              reason, created_at
         FROM inventory_movements
        WHERE product_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(productId) as MovementRow[];
  return rows.map(toMovementRecord);
}
