import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createCheckoutService } from '../checkout/checkoutService';
import { createReceiptService } from '../checkout/receiptService';
import { createSaleService } from '../checkout/saleService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Checkout / Receipt IPC channels.
 *
 *  - `checkout:review` (Phase 2D) — read-only trusted recalculation of a
 *    temporary cart; writes nothing.
 *  - `checkout:complete-cash` (Phase 2E) — the authoritative *Cash* sale
 *    completion (Phase 1 durable request + Phase 2 sale transaction). There is
 *    deliberately no Card completion channel and no `checkout:complete` catch-all.
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

  registerTrustedInvoke(IPC.checkoutReview, trusted, (request) =>
    createCheckoutService({ db: database() }).review(request),
  );

  registerTrustedInvoke(IPC.checkoutCompleteCash, trusted, (request) =>
    createSaleService({ db: database(), appVersion: context.appVersion }).completeCashSale(request),
  );

  registerTrustedInvoke(IPC.receiptsGetBySaleId, trusted, (saleId) =>
    createReceiptService({ db: database() }).getBySaleId(saleId),
  );
}
