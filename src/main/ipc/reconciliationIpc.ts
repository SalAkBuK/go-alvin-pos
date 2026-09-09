import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createReconciliationService } from '../reconciliation/reconciliationService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Reconciliation Queue IPC channels (Phase 2F; `DATA_MODEL.md
 * §31B`; `POS_WORKFLOWS.md §35B`).
 *
 *  - `reconciliation:list` — unresolved *Card* incidents only. Read-only.
 *  - `reconciliation:resolve` — mark one incident resolved with a required note.
 *
 * There is deliberately no generic query capability and no way to create,
 * backdate, or delete a sale from here.
 */

export interface ReconciliationIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
}

export function registerReconciliationIpcHandlers(context: ReconciliationIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function service() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createReconciliationService({ db: db.connection });
  }

  registerTrustedInvoke(IPC.reconciliationList, trusted, () => service().list());
  registerTrustedInvoke(IPC.reconciliationResolve, trusted, (input) => service().resolve(input));
}
