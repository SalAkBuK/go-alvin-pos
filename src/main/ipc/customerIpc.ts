import { IPC } from '../../shared/ipc';
import type { CustomerSearchOptions } from '../../shared/customers';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createCustomerService } from '../customers/customerService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2C Customers IPC channels (task `§12`).
 *
 * Handlers are thin: resolve the authoritative connection, build the service,
 * call one method, return. Sender validation and typed-error mapping live in
 * `registerTrustedInvoke` — every channel below is sender-validated and returns
 * an `IpcResult` envelope. No channel exposes SQL, the connection, a path, or a
 * generic query surface.
 */

export interface CustomerIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
}

export function registerCustomerIpcHandlers(context: CustomerIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function customers() {
    const database = context.getDatabase();
    if (!database || database.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createCustomerService({ db: database.connection });
  }

  registerTrustedInvoke(IPC.customersCreate, trusted, (input) => customers().create(input));

  registerTrustedInvoke(IPC.customersUpdate, trusted, (id, input) => customers().update(id, input));

  registerTrustedInvoke(IPC.customersList, trusted, () => customers().list());

  registerTrustedInvoke(IPC.customersSearch, trusted, (options) =>
    customers().search(options as CustomerSearchOptions),
  );

  registerTrustedInvoke(IPC.customersGet, trusted, (id) => customers().get(id));

  registerTrustedInvoke(IPC.customersPurchaseHistory, trusted, (id) =>
    customers().purchaseHistory(id),
  );
}
