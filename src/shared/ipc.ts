/**
 * Shared Main <-> Preload <-> Renderer IPC contract.
 *
 * This module is intentionally dependency-free (pure TypeScript types and
 * string constants) so it can be bundled into the main process (Node),
 * the sandboxed preload, and the renderer (browser) alike.
 *
 * SCOPE: foundation/diagnostic channels plus the Phase 2B Products + Inventory
 * slice and the Phase 2C Customers slice. Every business channel is an explicit,
 * narrow, business-named capability per ARCHITECTURE.md Sections 8-9 — never a
 * generic `database:query`, `execute-sql`, `read-file`, or `run-command`
 * surface. Checkout, sales, reports, backup, printing, and Google Sheets are
 * NOT defined yet.
 */

import type { CheckoutReview, CheckoutReviewRequest } from './checkout';
import type { TaxRateConfig, UpdateTaxRateInput } from './settings';
import type {
  CreateCustomerInput,
  CustomerPurchase,
  CustomerRecord,
  CustomerSearchOptions,
  UpdateCustomerInput,
} from './customers';
import type {
  CreateProductInput,
  InventoryAdjustmentInput,
  InventoryAdjustmentResult,
  InventoryMovementRecord,
  IpcResult,
  ProductBarcodeLookup,
  ProductListOptions,
  ProductRecord,
  ProductSearchOptions,
  UpdateProductInput,
} from './products';

export const IPC = {
  /** Static application/runtime identity for display and diagnostics. */
  appInfo: 'app:info',
  /**
   * Narrowly scoped scaffold verification: confirms the native better-sqlite3
   * binding loads and responds from the main process. This is NOT business
   * persistence and must never be turned into one.
   */
  nativeSqliteCheck: 'diagnostics:native-sqlite-check',
  /**
   * Read-only production-database health for startup-status display. Returns a
   * small status enum + schema version + failure code — never SQL, rows, paths,
   * or business data. It exists so a database that fails to initialize is
   * visible rather than silent.
   */
  databaseStatus: 'diagnostics:database-status',

  // ── Phase 2B: Products + Inventory ──────────────────────────────────────────
  productsCreate: 'products:create',
  productsUpdate: 'products:update',
  productsArchive: 'products:archive',
  productsList: 'products:list',
  productsSearch: 'products:search',
  productsFindByBarcode: 'products:find-by-barcode',
  inventoryAdjust: 'inventory:adjust',
  inventoryMovements: 'inventory:movements',

  // ── Phase 2C: Customers ────────────────────────────────────────────────────
  customersCreate: 'customers:create',
  customersUpdate: 'customers:update',
  customersList: 'customers:list',
  customersSearch: 'customers:search',
  customersGet: 'customers:get',
  customersPurchaseHistory: 'customers:purchase-history',

  // ── Phase 2D: Checkout review ──────────────────────────────────────────────
  // Trusted recalculation of a temporary cart. This does NOT complete a sale;
  // there is deliberately no `checkout:complete` channel in this phase.
  checkoutReview: 'checkout:review',

  // ── Phase 2D.1: Minimal tax configuration ──────────────────────────────────
  // The sales-tax rate only — NOT a generic settings surface. `tax-update` is
  // the sole settings write and it accepts only a basis-point tax rate.
  settingsTaxGet: 'settings:tax-get',
  settingsTaxUpdate: 'settings:tax-update',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly packaged: boolean;
}

export type NativeSqliteCheckResult =
  | {
      readonly ok: true;
      readonly sqliteVersion: string;
      readonly journalMode: string;
      readonly hasBackupApi: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface DatabaseStatus {
  /** `ready` = migrated + validated + connected; `unavailable` = init failed. */
  readonly state: 'ready' | 'unavailable' | 'initializing';
  readonly schemaVersion: number | null;
  /** Stable failure code when `state === 'unavailable'`, else `null`. */
  readonly failureCode: string | null;
}

/**
 * The shape exposed to the renderer as `window.pos` by the preload script.
 * Every method is an async, argument-validated request to the main process.
 */
export interface PosApi {
  readonly app: {
    getInfo(): Promise<AppInfo>;
  };
  readonly diagnostics: {
    checkNativeSqlite(): Promise<NativeSqliteCheckResult>;
    databaseStatus(): Promise<DatabaseStatus>;
  };
  readonly products: {
    create(input: CreateProductInput): Promise<IpcResult<ProductRecord>>;
    update(id: string, input: UpdateProductInput): Promise<IpcResult<ProductRecord>>;
    archive(id: string): Promise<IpcResult<ProductRecord>>;
    list(options?: ProductListOptions): Promise<IpcResult<readonly ProductRecord[]>>;
    search(options: ProductSearchOptions): Promise<IpcResult<readonly ProductRecord[]>>;
    findByBarcode(barcode: string): Promise<IpcResult<ProductBarcodeLookup>>;
  };
  readonly inventory: {
    adjust(input: InventoryAdjustmentInput): Promise<IpcResult<InventoryAdjustmentResult>>;
    movements(productId: string): Promise<IpcResult<readonly InventoryMovementRecord[]>>;
  };
  readonly customers: {
    create(input: CreateCustomerInput): Promise<IpcResult<CustomerRecord>>;
    update(id: string, input: UpdateCustomerInput): Promise<IpcResult<CustomerRecord>>;
    list(): Promise<IpcResult<readonly CustomerRecord[]>>;
    search(options: CustomerSearchOptions): Promise<IpcResult<readonly CustomerRecord[]>>;
    get(id: string): Promise<IpcResult<CustomerRecord>>;
    purchaseHistory(id: string): Promise<IpcResult<readonly CustomerPurchase[]>>;
  };
  readonly checkout: {
    /**
     * Trusted recalculation of a temporary cart: reloads authoritative product
     * state, validates it, computes the canonical review, and returns the
     * deterministic checkout fingerprint. Writes nothing.
     */
    review(request: CheckoutReviewRequest): Promise<IpcResult<CheckoutReview>>;
  };
  readonly settings: {
    /** The sales-tax rate only — no generic settings access. */
    readonly tax: {
      get(): Promise<IpcResult<TaxRateConfig>>;
      /**
       * Validate the rate, persist it, and write a `TAX_SETTING_CHANGED` audit
       * event in the same SQLite transaction. Returns the now-configured rate.
       */
      update(input: UpdateTaxRateInput): Promise<IpcResult<TaxRateConfig>>;
    };
  };
}
