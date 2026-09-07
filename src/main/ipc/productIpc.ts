import { IPC } from '../../shared/ipc';
import type {
  InventoryAdjustmentInput,
  ProductListOptions,
  ProductSearchOptions,
} from '../../shared/products';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { appErrors } from '../shared/appError';
import { createInventoryService } from '../inventory/inventoryService';
import { createProductService } from '../products/productService';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2B Products + Inventory IPC channels (task `§15`).
 *
 * Handlers are thin: resolve the authoritative connection, build the service,
 * call one method, return. All sender validation and error mapping live in
 * `registerTrustedInvoke`. No channel exposes SQL, the connection, a path, or a
 * generic query surface.
 */

export interface ProductIpcContext {
  readonly logger: Logger;
  /** The one production database, or `null` when initialization failed. */
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
}

export function registerProductIpcHandlers(context: ProductIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function connection() {
    const database = context.getDatabase();
    if (!database || database.closed) {
      throw appErrors.databaseUnavailable();
    }
    return database.connection;
  }

  function products() {
    return createProductService({ db: connection() });
  }

  function inventory() {
    return createInventoryService({ db: connection(), appVersion: context.appVersion });
  }

  registerTrustedInvoke(IPC.productsCreate, trusted, (input) => products().create(input));

  registerTrustedInvoke(IPC.productsUpdate, trusted, (id, input) => products().update(id, input));

  registerTrustedInvoke(IPC.productsArchive, trusted, (id) => products().archive(id));

  registerTrustedInvoke(IPC.productsList, trusted, (options) =>
    products().list((options ?? undefined) as ProductListOptions | undefined),
  );

  registerTrustedInvoke(IPC.productsSearch, trusted, (options) =>
    products().search(options as ProductSearchOptions),
  );

  registerTrustedInvoke(IPC.productsFindByBarcode, trusted, (barcode) =>
    products().findByBarcode(barcode),
  );

  registerTrustedInvoke(IPC.inventoryAdjust, trusted, (input) =>
    inventory().adjust(input as InventoryAdjustmentInput),
  );

  registerTrustedInvoke(IPC.inventoryMovements, trusted, (productId) =>
    products().movements(productId),
  );
}
