import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { InventoryAdjustmentResult } from '../../shared/products';
import { AppError, appErrors } from '../shared/appError';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import {
  findProductById,
  readCurrentQuantity,
  setProductQuantity,
} from '../products/productRepository';
import { validateAdjustment } from '../products/productValidation';
import { findMovementById, insertMovement } from './inventoryRepository';

/**
 * Manual inventory adjustment (`POS_WORKFLOWS.md §12`, `DATA_MODEL.md §17-18`,
 * `REQ-INV-006`, task `§10-12`).
 *
 * One authoritative transaction (`BEGIN IMMEDIATE`) does all of:
 *   re-read product → validate exists → read current authoritative quantity →
 *   compute new quantity → reject if negative → update `quantity_on_hand` →
 *   insert a `MANUAL_ADJUSTMENT` movement → insert an `INVENTORY_ADJUSTED`
 *   audit event.
 * All succeed together or the whole thing rolls back. The service NEVER trusts
 * a renderer-supplied previous quantity — `quantity_before` comes from SQLite.
 */

export interface InventoryServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  readonly now?: () => string;
}

export interface InventoryService {
  adjust(raw: unknown): InventoryAdjustmentResult;
}

export function createInventoryService(deps: InventoryServiceDeps): InventoryService {
  const { db, appVersion } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    adjust(raw: unknown): InventoryAdjustmentResult {
      const input = validateAdjustment(raw);
      const occurredAt = now();
      const movementId = randomUUID();

      const run = db.transaction((value: typeof input) => {
        const quantityBefore = readCurrentQuantity(db, value.productId);
        if (quantityBefore === null) {
          throw appErrors.productNotFound();
        }

        const quantityAfter =
          value.mode === 'delta' ? quantityBefore + value.delta : value.targetQuantity;
        const quantityChange = quantityAfter - quantityBefore;

        if (quantityChange === 0) {
          throw appErrors.adjustmentNoChange();
        }
        if (quantityAfter < 0) {
          throw appErrors.inventoryNegative();
        }

        setProductQuantity(db, value.productId, quantityAfter, occurredAt);

        insertMovement(db, {
          id: movementId,
          productId: value.productId,
          saleId: null,
          movementType: 'MANUAL_ADJUSTMENT',
          reversesMovementId: null,
          quantityChange,
          quantityBefore,
          quantityAfter,
          reason: value.reason,
          createdAt: occurredAt,
        });

        appendAuditEvent(db, {
          eventType: 'INVENTORY_ADJUSTED',
          occurredAt,
          actorType: 'USER',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'PRODUCT',
          subjectId: value.productId,
          reason: value.reason,
          details: {
            movementId,
            quantityBefore,
            quantityChange,
            quantityAfter,
            mode: value.mode,
          },
        });
      });

      run.immediate(input);

      const product = findProductById(db, input.productId);
      const movement = findMovementById(db, movementId);
      if (!product || !movement) {
        // Committed but unreadable — never expected; surface as a generic failure.
        throw new AppError('INTERNAL', 'The adjustment was saved but could not be read back.');
      }
      return { product, movement };
    },
  };
}
