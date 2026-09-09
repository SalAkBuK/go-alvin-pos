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

import type {
  BeginCardCheckoutRequest,
  BeginCardCheckoutResult,
  CheckoutReview,
  CheckoutReviewRequest,
  CompleteCardCheckoutRequest,
  CompleteCashSaleRequest,
  CompletedSaleResult,
  DeclineCardCheckoutRequest,
  DeclineCardCheckoutResult,
} from './checkout';
import type {
  PrinterConfig,
  PrinterDevice,
  PrintReceiptResult,
  SelectPrinterInput,
} from './printing';
import type { ReceiptRepresentation } from './receipt';
import type { ReconciliationEntry, ResolveReconciliationInput } from './reconciliation';
import type {
  SaleDetail,
  SalesHistoryEntry,
  SalesHistorySearch,
  VoidSaleInput,
} from './salesHistory';
import type {
  BusinessConfig,
  TaxRateConfig,
  UpdateBusinessConfigInput,
  UpdateTaxRateInput,
} from './settings';
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
  // Trusted recalculation of a temporary cart. Writes nothing.
  checkoutReview: 'checkout:review',

  // ── Phase 2E: Cash sale completion ─────────────────────────────────────────
  // The authoritative Cash sale transaction (Phase 1 durable request + Phase 2
  // sale). Cash only.
  checkoutCompleteCash: 'checkout:complete-cash',

  // ── Phase 2F: Manual Clover Card workflow + reconciliation ─────────────────
  // Three narrow Card capabilities and two reconciliation-queue capabilities.
  // There is still no generic `checkout:complete`. `begin-card` durably commits
  // Phase 1 Step A (PENDING_PAYMENT) before the cashier is sent to Clover;
  // `complete-card` runs Phase 1 Step B (approval confirmation) + the shared
  // Phase 2 sale transaction; `decline-card` records an explicit Clover decline.
  checkoutBeginCard: 'checkout:begin-card',
  checkoutCompleteCard: 'checkout:complete-card',
  checkoutDeclineCard: 'checkout:decline-card',
  reconciliationList: 'reconciliation:list',
  reconciliationResolve: 'reconciliation:resolve',

  // ── Phase 2E.1: Receipt representation & preview ───────────────────────────
  // Read-only assembly of one committed sale's receipt from its transaction-time
  // snapshots, addressed only by immutable Sale ID. Writes nothing. Physical
  // printing and reprint-from-history are NOT here.
  receiptsGetBySaleId: 'receipts:get-by-sale-id',

  // ── Phase 2G: Sales History + Transaction Detail ───────────────────────────
  // Read-only view model over committed local state (`sales` LEFT JOIN
  // `google_sheet_export_jobs`, `sale_items`, `payments`). `list` applies
  // receipt-number / customer-snapshot / business-date search in the trusted
  // layer; `get-by-id` assembles one sale's historical detail from its
  // snapshots. Writes nothing, emits no audit event, needs no network. There is
  // still no generic query surface, and "View Receipt" reuses
  // `receipts:get-by-sale-id`.
  salesHistoryList: 'sales-history:list',
  salesHistoryGetById: 'sales-history:get-by-id',
  // ── Phase 2H: Sale Void / Correction ──────────────────────────────────────
  // The one-time `COMPLETED → VOIDED` transition for one sale, launched from the
  // Sales History detail. One authoritative SQLite transaction (status + void
  // fields + sync_version, reversing inventory movements, export-job
  // advancement, `SALE_VOIDED` audit) or full rollback. Payload is only
  // `{ saleId, reason }`; no SQL, no timestamp, no Clover/network call.
  salesHistoryVoid: 'sales-history:void',

  // ── Phase 2D.1: Minimal tax configuration ──────────────────────────────────
  // The sales-tax rate only — NOT a generic settings surface. `tax-update` is
  // the sole settings write and it accepts only a basis-point tax rate.
  settingsTaxGet: 'settings:tax-get',
  settingsTaxUpdate: 'settings:tax-update',

  // ── Phase 2D.2: Minimal business & receipt configuration ───────────────────
  // The business address / phone and receipt disclaimer / footer only — the
  // source values a future sale freezes into its snapshots. Not a generic
  // settings surface; `business-update` accepts only those four fields.
  settingsBusinessGet: 'settings:business-get',
  settingsBusinessUpdate: 'settings:business-update',

  // ── Phase 2I: Physical Printing & Receipt Reprint ─────────────────────────
  // Four narrow capabilities. `list-printers` / `get-config` are read-only;
  // `select-printer` persists ONLY `settings.selected_printer` (a dedicated
  // path — still no generic settings setter); `print-receipt` takes ONLY an
  // immutable Sale ID, rebuilds the receipt from stored snapshots via the
  // existing ReceiptService, and submits it to the selected Windows printer.
  // Nothing on this surface creates or mutates any sale/payment/inventory/
  // export/receipt-number/void state, and nothing touches the network.
  printingListPrinters: 'printing:list-printers',
  printingGetConfig: 'printing:get-config',
  printingSelectPrinter: 'printing:select-printer',
  printingPrintReceipt: 'printing:print-receipt',
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
    /**
     * Complete a *Cash* sale for a reviewed cart: Phase 1 durably records the
     * checkout request, Phase 2 writes the sale, items, payment, inventory
     * deduction, movements, `PENDING` export job, and audit events in one
     * transaction. Idempotent for a repeated `requestId` + fingerprint; rejects
     * `CHECKOUT_DRIFT` if authoritative state changed since review.
     */
    completeCash(request: CompleteCashSaleRequest): Promise<IpcResult<CompletedSaleResult>>;
    /**
     * Phase 1 Step A for a reviewed *Card* checkout: durably commit a
     * `PENDING_PAYMENT` checkout request (payment method, intended total) and
     * return the trusted amount to process on Clover. Nothing is charged; the
     * renderer must not show any Clover instruction until this resolves `ok`.
     */
    beginCard(request: BeginCardCheckoutRequest): Promise<IpcResult<BeginCardCheckoutResult>>;
    /**
     * The cashier confirmed Clover approved (or is retrying a local save after a
     * commit failure). Commits Phase 1 Step B if still pending, then the shared
     * authoritative Phase 2 sale transaction. A failure after approval resolves
     * with `CARD_LOCAL_COMMIT_FAILURE` — the cashier must be warned about the
     * possible Clover charge, never told to simply try again.
     */
    completeCard(request: CompleteCardCheckoutRequest): Promise<IpcResult<CompletedSaleResult>>;
    /**
     * "Payment Declined / Cancel": best-effort terminal update of the same
     * pending Card request to `COMMIT_FAILED` / `CLOVER_DECLINED`. No sale, no
     * inventory change; the cart stays for the next attempt.
     */
    declineCard(request: DeclineCardCheckoutRequest): Promise<IpcResult<DeclineCardCheckoutResult>>;
  };
  readonly reconciliation: {
    /** Unresolved Card incidents only (`DATA_MODEL.md §31B`). Read-only. */
    list(): Promise<IpcResult<readonly ReconciliationEntry[]>>;
    /**
     * Mark one incident resolved with a required note. Records only that a
     * person reconciled it — never creates, edits, or backdates a sale.
     */
    resolve(input: ResolveReconciliationInput): Promise<IpcResult<ReconciliationEntry>>;
  };
  readonly receipts: {
    /**
     * Assemble one committed sale's printer-independent receipt representation
     * from its transaction-time snapshots (`sales` / `sale_items` / `payments`).
     * Read-only, local SQLite only, no network or printer. The renderer passes
     * only the immutable Sale ID; a sale that does not exist is `RECEIPT_NOT_FOUND`.
     */
    getBySaleId(saleId: string): Promise<IpcResult<ReceiptRepresentation>>;
  };
  readonly salesHistory: {
    /**
     * The Sales History list — newest completed sale first
     * (`completed_at DESC`, `receipt_number DESC` tie-break). Optional receipt /
     * customer text and a single business-date filter combine with AND; an empty
     * result is a normal empty state, never an error. Local SQLite only.
     */
    list(search?: SalesHistorySearch): Promise<IpcResult<readonly SalesHistoryEntry[]>>;
    /**
     * One sale's full historical detail, addressed only by immutable Sale ID and
     * assembled entirely from committed snapshots (`sales` / `sale_items` /
     * `payments` / the export job). An unknown / malformed id is `SALE_NOT_FOUND`.
     */
    getById(saleId: string): Promise<IpcResult<SaleDetail>>;
    /**
     * Void one `COMPLETED` sale with a required staff reason (`REQ-VOID-001`-
     * `REQ-VOID-008`; `POS_WORKFLOWS.md §88`-`§91`). One authoritative local
     * transaction — status → `VOIDED` + void metadata + `sync_version + 1`,
     * reversing inventory movements against current stock, the existing export
     * job advanced to `PENDING` for the new revision, and a `SALE_VOIDED` audit
     * event — or a full rollback. Rejects an already-voided sale
     * (`SALE_ALREADY_VOIDED`). Makes no Clover / network call. Resolves with the
     * freshly re-read authoritative {@link SaleDetail}.
     */
    voidSale(input: VoidSaleInput): Promise<IpcResult<SaleDetail>>;
  };
  readonly printing: {
    /**
     * Enumerate Windows printers as narrow {@link PrinterDevice} metadata. A
     * failure to enumerate is non-fatal — it never blocks a sale (`task §20`).
     */
    listPrinters(): Promise<IpcResult<readonly PrinterDevice[]>>;
    /** The locally-persisted printer selection plus its current availability. Read-only. */
    getConfig(): Promise<IpcResult<PrinterConfig>>;
    /**
     * Persist `settings.selected_printer` (dedicated path — not a generic
     * setter). Changes only *future* print attempts; never touches any existing
     * sale or historical receipt (`POS_WORKFLOWS.md §70`, `task §12`).
     */
    selectPrinter(input: SelectPrinterInput): Promise<IpcResult<PrinterConfig>>;
    /**
     * Print (or reprint) one committed sale's receipt on the selected printer.
     * The receipt is rebuilt in the trusted process from stored transaction-time
     * snapshots via the existing ReceiptService — the renderer passes only the
     * Sale ID. Read-only w.r.t. all business data; the same path serves the
     * Sale Complete "Print Receipt" and the Sales History "Reprint Receipt".
     * Typed failures: `PRINTER_NOT_CONFIGURED`, `PRINTER_UNAVAILABLE`,
     * `PRINT_FAILED` — a print failure is never a sale failure (`REQ-REC-005`).
     */
    printReceipt(saleId: string): Promise<IpcResult<PrintReceiptResult>>;
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
    /** Business identity + receipt policy only — no generic settings access. */
    readonly business: {
      get(): Promise<IpcResult<BusinessConfig>>;
      /**
       * Validate the four fields, persist them, and write one
       * `BUSINESS_SETTING_CHANGED` audit event in the same SQLite transaction.
       * Returns the resulting configuration.
       */
      update(input: UpdateBusinessConfigInput): Promise<IpcResult<BusinessConfig>>;
    };
  };
}
