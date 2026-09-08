import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createCheckoutService } from '../checkout/checkoutService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2D Checkout review IPC channel (task `§13`).
 *
 * One channel only — `checkout:review` — and it is read-only: it recalculates a
 * temporary cart and returns the authoritative review + fingerprint. There is
 * deliberately no `checkout:complete` here; Phase 2D completes no sale. Sender
 * validation and typed-error mapping live in `registerTrustedInvoke`.
 */

export interface CheckoutIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
}

export function registerCheckoutIpcHandlers(context: CheckoutIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function checkout() {
    const database = context.getDatabase();
    if (!database || database.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createCheckoutService({ db: database.connection });
  }

  registerTrustedInvoke(IPC.checkoutReview, trusted, (request) => checkout().review(request));
}
