import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createSalesHistoryService } from '../salesHistory/salesHistoryService';
import { createVoidService } from '../void/voidService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Sales History IPC channels (Phase 2G `REQ-HIST-001`-`REQ-HIST-004`,
 * `POS_WORKFLOWS.md §50`-`§51`; Phase 2H `REQ-VOID-001`-`REQ-VOID-008`,
 * `POS_WORKFLOWS.md §88`-`§91`).
 *
 *  - `sales-history:list` — the read-only list with optional receipt/customer
 *    text + a single business-date filter. Read-only.
 *  - `sales-history:get-by-id` — one sale's historical detail by immutable Sale ID.
 *  - `sales-history:void` — the one-time `COMPLETED → VOIDED` transition for one
 *    sale in a single authoritative transaction, then resolves with the freshly
 *    re-read detail so the renderer reloads authoritative state rather than
 *    fabricating it.
 *
 * Handlers are thin: resolve the authoritative connection, build the service,
 * call one method, return. Sender validation and typed-error mapping live in
 * `registerTrustedInvoke`. There is deliberately no generic query or mutation
 * capability — the renderer can only send a bounded search object, a Sale ID
 * string, or `{ saleId, reason }`, all re-validated in the trusted layer.
 */

export interface SalesHistoryIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
}

export function registerSalesHistoryIpcHandlers(context: SalesHistoryIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function connection() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return db.connection;
  }

  registerTrustedInvoke(IPC.salesHistoryList, trusted, (search) =>
    createSalesHistoryService({ db: connection() }).list(search),
  );
  registerTrustedInvoke(IPC.salesHistoryGetById, trusted, (saleId) =>
    createSalesHistoryService({ db: connection() }).getById(saleId),
  );
  registerTrustedInvoke(IPC.salesHistoryVoid, trusted, (input) => {
    const db = connection();
    const { saleId } = createVoidService({ db, appVersion: context.appVersion }).voidSale(input);
    // Reload authoritative persisted state so the renderer never fabricates the
    // post-void detail (`task §10`).
    return createSalesHistoryService({ db }).getById(saleId);
  });
}
