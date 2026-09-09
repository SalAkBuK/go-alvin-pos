import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { insertMovement } from '../inventory/inventoryRepository';
import { readCurrentQuantity, setProductQuantity } from '../products/productRepository';
import { AppError, appErrors, isAppError } from '../shared/appError';
import {
  findSaleForVoid,
  listOriginalSaleMovements,
  markSaleVoided,
  requeueExportJobForVoid,
} from './voidRepository';
import { validateVoidSaleInput } from './voidValidation';

/**
 * The one-time completed-sale void (`REQ-VOID-001`-`REQ-VOID-008`;
 * `POS_WORKFLOWS.md §88`-`§91`; `ARCHITECTURE.md §42.1`; `DATA_MODEL.md §12`,
 * `§18`, `§23`, `§63`; `task §3`-`§8`).
 *
 * `voidSale` runs ONE authoritative `BEGIN IMMEDIATE` transaction that either
 * commits every void effect together or rolls all of them back:
 *
 *   1. load the sale; reject if missing (`SALE_NOT_FOUND`);
 *   2. reject if not `COMPLETED` — i.e. already `VOIDED` (`SALE_ALREADY_VOIDED`),
 *      enforced here AND by the `WHERE status = 'COMPLETED'` guard on the update
 *      and the `reverses_movement_id` UNIQUE index (`REQ-VOID-004`);
 *   3. `status = VOIDED`, `voided_at`, `void_reason`, `sync_version + 1`;
 *   4. for each original `SALE` movement: restore the sold quantity against the
 *      product's CURRENT authoritative quantity (never the historical
 *      `quantity_before`) and insert exactly one linked `VOID_REVERSAL`;
 *   5. advance + reschedule the sale's single existing export job to the new
 *      `sync_version` as `PENDING` (no second job; no network);
 *   6. append one `SALE_VOIDED` audit event (subject = the sale, reason = the
 *      staff reason);
 *   7. COMMIT.
 *
 * It never deletes or rewrites the sale's snapshots, items, payment, receipt
 * number, `completed_at`, or original `SALE` movements. It makes no Clover / no
 * network call and creates no refund or negative payment. The Card Clover
 * warning + acknowledgement is a renderer concern (`REQ-VOID-008`); by the time
 * this runs the cashier has confirmed.
 */

export interface VoidServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface VoidSaleResult {
  /** The validated Sale ID — the caller reloads authoritative detail with it. */
  readonly saleId: string;
}

export interface VoidService {
  voidSale(raw: unknown): VoidSaleResult;
}

export function createVoidService(deps: VoidServiceDeps): VoidService {
  const { db, appVersion } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    voidSale(raw: unknown): VoidSaleResult {
      const { saleId, reason } = validateVoidSaleInput(raw);
      const voidedAt = now();

      try {
        db.transaction(() => {
          const sale = findSaleForVoid(db, saleId);
          if (!sale) {
            throw appErrors.saleNotFound();
          }
          if (sale.status !== 'COMPLETED') {
            // Already VOIDED — the one-time transition has happened. Nothing is
            // touched (`REQ-VOID-004`, `POS_WORKFLOWS.md §91`).
            throw appErrors.saleAlreadyVoided();
          }

          const newSyncVersion = sale.sync_version + 1;

          const changed = markSaleVoided(db, {
            saleId,
            voidedAt,
            voidReason: reason,
            newSyncVersion,
          });
          if (changed !== 1) {
            // Lost a race for the one-time transition, or the row vanished.
            throw appErrors.saleAlreadyVoided();
          }

          // Restore inventory through explicit reversing movements linked to the
          // original SALE movements — against CURRENT stock, not the historical
          // pre-sale quantity (`task §5`; the product may have had legitimate
          // inventory activity since the sale).
          const originals = listOriginalSaleMovements(db, saleId);
          if (originals.length === 0) {
            // A committed sale always deducted at least one product
            // (`DATA_MODEL.md §13`, `§18`); a missing SALE movement is a stored
            // inconsistency — roll back rather than "void" nothing.
            throw new AppError(
              'VOID_COMMIT_FAILED',
              'The sale could not be voided because its original inventory movements are missing.',
            );
          }

          let reversalCount = 0;
          for (const movement of originals) {
            const before = readCurrentQuantity(db, movement.product_id);
            if (before === null) {
              throw appErrors.productNotFound();
            }
            // Original SALE `quantity_change` is negative; the reversal is its
            // opposite added to whatever the product holds right now.
            const restored = -movement.quantity_change;
            const after = before + restored;
            setProductQuantity(db, movement.product_id, after, voidedAt);
            insertMovement(db, {
              id: randomUUID(),
              productId: movement.product_id,
              saleId,
              movementType: 'VOID_REVERSAL',
              reversesMovementId: movement.id,
              quantityChange: restored,
              quantityBefore: before,
              quantityAfter: after,
              reason: null,
              createdAt: voidedAt,
            });
            reversalCount += 1;
          }

          // Advance + reschedule the existing export job for the new revision.
          const requeued = requeueExportJobForVoid(db, {
            saleId,
            targetSyncVersion: newSyncVersion,
            updatedAt: voidedAt,
          });
          if (requeued !== 1) {
            throw new AppError(
              'VOID_COMMIT_FAILED',
              'The sale could not be voided because its export job could not be advanced.',
            );
          }

          appendAuditEvent(db, {
            eventType: 'SALE_VOIDED',
            occurredAt: voidedAt,
            actorType: 'USER',
            outcome: 'SUCCESS',
            appVersion,
            subjectType: 'SALE',
            subjectId: saleId,
            reason,
            details: {
              receiptNumber: sale.receipt_number,
              paymentMethod: sale.payment_method_snapshot,
              newSyncVersion,
              reversalMovementCount: reversalCount,
            },
          });
        }).immediate();
      } catch (error) {
        if (isAppError(error)) {
          // Typed rejection (not found / already voided / a detected
          // inconsistency): the transaction rolled back with nothing written.
          throw error;
        }
        // Unexpected / storage failure — nothing from the void survived.
        throw appErrors.voidCommitFailed();
      }

      return { saleId };
    },
  };
}
