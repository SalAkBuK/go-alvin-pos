import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createCardCheckoutService } from '../checkout/cardCheckoutService';
import { createCheckoutService } from '../checkout/checkoutService';
import { createReceiptService } from '../checkout/receiptService';
import { createSaleService } from '../checkout/saleService';
import type { MaintenanceCoordinator } from '../maintenance/maintenanceCoordinator';
import { appErrors, isAppError } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Checkout / Receipt IPC channels.
 *
 *  - `checkout:review` (Phase 2D) — read-only trusted recalculation of a
 *    temporary cart; writes nothing.
 *  - `checkout:complete-cash` (Phase 2E) — the authoritative *Cash* sale
 *    completion (Phase 1 durable request + Phase 2 sale transaction).
 *  - `checkout:begin-card` / `checkout:complete-card` / `checkout:decline-card`
 *    (Phase 2F) — the manual Clover Card workflow. `begin-card` commits Phase 1
 *    Step A before any Clover instruction; `complete-card` commits Step B +
 *    the shared Phase 2 sale transaction; `decline-card` records a Clover
 *    decline. There is still no `checkout:complete` catch-all.
 *  - `receipts:get-by-sale-id` (Phase 2E.1) — read-only assembly of one
 *    committed sale's receipt representation from its transaction-time
 *    snapshots. Writes nothing; no printing.
 *
 * Handlers stay thin; sender validation and typed-error mapping live in
 * `registerTrustedInvoke`.
 */

export interface CheckoutIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
  /**
   * Optional in tests. When present, the authoritative sale transactions run
   * inside `coordinator.runGuardedTransaction` so a restore's exclusive claim
   * sees `TRANSACTION_IN_FLIGHT` and defers (Phase 2L-B Item 4).
   */
  readonly coordinator?: MaintenanceCoordinator;
}

export function registerCheckoutIpcHandlers(context: CheckoutIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function database() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return db.connection;
  }

  /** Run a synchronous authoritative mutation through the coordinator's guarded primitive. */
  function guarded<T>(fn: () => T): T {
    return context.coordinator ? context.coordinator.runGuardedTransaction(fn) : fn();
  }

  function requestIdFrom(request: unknown): string | undefined {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return undefined;
    }
    const requestId = (request as Record<string, unknown>)['requestId'];
    return typeof requestId === 'string' && requestId.trim() !== '' ? requestId : undefined;
  }

  function completeWithDiagnostics<T extends { saleId: string; receiptNumber: string }>(
    request: unknown,
    paymentMethod: 'CASH' | 'CARD',
    complete: () => T,
  ): T {
    const startedAt = Date.now();
    const checkoutRequestId = requestIdFrom(request);
    try {
      const result = complete();
      context.logger.info('checkout', 'checkout.completed', {
        checkoutRequestId,
        saleId: result.saleId,
        receiptNumber: result.receiptNumber,
        paymentMethod,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : 'SALE_COMMIT_FAILED';
      const fields = {
        checkoutRequestId,
        paymentMethod,
        errorCode,
        durationMs: Date.now() - startedAt,
      };
      if (errorCode === 'SALE_COMMIT_FAILED' || errorCode === 'CARD_LOCAL_COMMIT_FAILURE') {
        context.logger.error('checkout', 'checkout.failed', fields);
      } else {
        context.logger.warn('checkout', 'checkout.validation_failed', fields);
      }
      throw error;
    }
  }

  registerTrustedInvoke(IPC.checkoutReview, trusted, (request) =>
    createCheckoutService({ db: database() }).review(request),
  );

  registerTrustedInvoke(IPC.checkoutCompleteCash, trusted, (request) =>
    completeWithDiagnostics(request, 'CASH', () =>
      guarded(() =>
        createSaleService({ db: database(), appVersion: context.appVersion }).completeCashSale(
          request,
        ),
      ),
    ),
  );

  const cardService = () =>
    createCardCheckoutService({ db: database(), appVersion: context.appVersion });

  registerTrustedInvoke(IPC.checkoutBeginCard, trusted, (request) =>
    guarded(() => cardService().beginCard(request)),
  );
  registerTrustedInvoke(IPC.checkoutCompleteCard, trusted, (request) =>
    completeWithDiagnostics(request, 'CARD', () =>
      guarded(() => cardService().completeCard(request)),
    ),
  );
  registerTrustedInvoke(IPC.checkoutDeclineCard, trusted, (request) =>
    guarded(() => cardService().declineCard(request)),
  );

  registerTrustedInvoke(IPC.receiptsGetBySaleId, trusted, (saleId) =>
    createReceiptService({ db: database() }).getBySaleId(saleId),
  );
}
