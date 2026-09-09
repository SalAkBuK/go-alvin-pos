import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createSalesHistoryService } from '../salesHistory/salesHistoryService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2G Sales History IPC channels (`REQ-HIST-001`-`REQ-HIST-004`;
 * `POS_WORKFLOWS.md §50`-`§51`).
 *
 *  - `sales-history:list` — the read-only list with optional receipt/customer
 *    text + a single business-date filter. Read-only.
 *  - `sales-history:get-by-id` — one sale's historical detail by immutable Sale ID.
 *
 * Handlers are thin: resolve the authoritative connection, build the service,
 * call one method, return. Sender validation and typed-error mapping live in
 * `registerTrustedInvoke`. There is deliberately no generic query capability —
 * the renderer can only send a bounded search object or a Sale ID string, both
 * re-validated in the trusted layer.
 */

export interface SalesHistoryIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
}

export function registerSalesHistoryIpcHandlers(context: SalesHistoryIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function service() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createSalesHistoryService({ db: db.connection });
  }

  registerTrustedInvoke(IPC.salesHistoryList, trusted, (search) => service().list(search));
  registerTrustedInvoke(IPC.salesHistoryGetById, trusted, (saleId) => service().getById(saleId));
}
