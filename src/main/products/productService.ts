import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  InventoryMovementRecord,
  ProductBarcodeLookup,
  ProductListOptions,
  ProductRecord,
  ProductSearchOptions,
  UpdateProductInput,
} from '../../shared/products';
import { appErrors } from '../shared/appError';
import type { AppError } from '../shared/appError';
import { listMovementsForProduct } from '../inventory/inventoryRepository';
import * as repo from './productRepository';
import {
  validateBarcodeQuery,
  validateCreateProduct,
  validateProductId,
  validateSearchQuery,
  validateUpdateProduct,
} from './productValidation';

/**
 * Product business behaviour and transactions (`ARCHITECTURE.md §10-11`,
 * `POS_WORKFLOWS.md §8-13`).
 *
 * The service validates every payload through `productValidation`, owns the
 * create/update/archive transactions, and enforces the rule that stock only
 * moves through an inventory movement (`DATA_MODEL.md §39-40`). It never
 * touches Electron, IPC, or the renderer, so it is unit-testable against a real
 * SQLite connection with no app running.
 */

export interface ProductServiceDeps {
  readonly db: Database.Database;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface ProductService {
  create(raw: unknown): ProductRecord;
  update(idRaw: unknown, raw: unknown): ProductRecord;
  archive(idRaw: unknown): ProductRecord;
  list(options?: ProductListOptions): readonly ProductRecord[];
  search(options: ProductSearchOptions): readonly ProductRecord[];
  findByBarcode(raw: unknown): ProductBarcodeLookup;
  movements(idRaw: unknown): readonly InventoryMovementRecord[];
}

function mapConstraintError(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE' || typeof message !== 'string') {
    return null;
  }
  if (message.includes('products.barcode')) {
    return appErrors.duplicateBarcode();
  }
  if (message.includes('products.sku')) {
    return appErrors.duplicateSku();
  }
  return null;
}

export function createProductService(deps: ProductServiceDeps): ProductService {
  const { db } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  function requireProduct(id: string): ProductRecord {
    const product = repo.findProductById(db, id);
    if (!product) {
      throw appErrors.productNotFound();
    }
    return product;
  }

  return {
    create(raw: unknown): ProductRecord {
      const input = validateCreateProduct(raw);
      const id = randomUUID();
      const createdAt = now();

      const run = db.transaction((value: typeof input) => {
        if (value.sku !== null && repo.skuExists(db, value.sku)) {
          throw appErrors.duplicateSku();
        }
        if (value.barcode !== null && repo.barcodeExists(db, value.barcode)) {
          throw appErrors.duplicateBarcode();
        }

        repo.insertProduct(db, {
          id,
          sku: value.sku,
          barcode: value.barcode,
          name: value.name,
          brand: value.brand,
          model: value.model,
          condition: value.condition,
          costPriceCents: value.costPriceCents,
          sellingPriceCents: value.sellingPriceCents,
          quantity: value.quantity,
          lowStockThreshold: value.lowStockThreshold,
          createdAt,
        });

        // Starting quantity > 0 → one INITIAL_STOCK movement, atomic with the
        // product insert (`DATA_MODEL.md §39`, task `§4-5`). Quantity 0 creates
        // no meaningless zero-change movement.
        if (value.quantity > 0) {
          db.prepare(
            `INSERT INTO inventory_movements
               (id, product_id, sale_id, movement_type, reverses_movement_id,
                quantity_change, quantity_before, quantity_after, reason, created_at)
             VALUES (?, ?, NULL, 'INITIAL_STOCK', NULL, ?, 0, ?, NULL, ?)`,
          ).run(randomUUID(), id, value.quantity, value.quantity, createdAt);
        }
      });

      try {
        run.immediate(input);
      } catch (error) {
        throw mapConstraintError(error) ?? error;
      }

      return requireProduct(id);
    },

    update(idRaw: unknown, raw: unknown): ProductRecord {
      const id = validateProductId(idRaw);
      const input: UpdateProductInput = validateUpdateProduct(raw);
      const updatedAt = now();

      const run = db.transaction((value: UpdateProductInput) => {
        requireProduct(id);
        if (value.sku !== null && repo.skuExists(db, value.sku, id)) {
          throw appErrors.duplicateSku();
        }
        if (value.barcode !== null && repo.barcodeExists(db, value.barcode, id)) {
          throw appErrors.duplicateBarcode();
        }
        repo.updateProduct(db, {
          id,
          name: value.name,
          brand: value.brand,
          model: value.model,
          condition: value.condition,
          sellingPriceCents: value.sellingPriceCents,
          costPriceCents: value.costPriceCents,
          sku: value.sku,
          barcode: value.barcode,
          lowStockThreshold: value.lowStockThreshold,
          updatedAt,
        });
      });

      try {
        run.immediate(input);
      } catch (error) {
        throw mapConstraintError(error) ?? error;
      }

      return requireProduct(id);
    },

    archive(idRaw: unknown): ProductRecord {
      const id = validateProductId(idRaw);
      const updatedAt = now();
      db.transaction(() => {
        requireProduct(id);
        repo.setProductActive(db, id, false, updatedAt);
      }).immediate();
      return requireProduct(id);
    },

    list(options?: ProductListOptions): readonly ProductRecord[] {
      return repo.listProducts(db, { includeArchived: options?.includeArchived ?? false });
    },

    search(options: ProductSearchOptions): readonly ProductRecord[] {
      const query = validateSearchQuery(options.query);
      return repo.searchProducts(db, {
        query,
        includeArchived: options.includeArchived ?? false,
      });
    },

    findByBarcode(raw: unknown): ProductBarcodeLookup {
      const barcode = validateBarcodeQuery(raw);
      const product = repo.findActiveByBarcode(db, barcode);
      return product ? { found: true, product } : { found: false };
    },

    movements(idRaw: unknown): readonly InventoryMovementRecord[] {
      const id = validateProductId(idRaw);
      requireProduct(id);
      return listMovementsForProduct(db, id);
    },
  };
}
