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

import type { BackupHealth, ManualBackupResult, OffDeviceBackupConfiguration } from './backup';
import type { DiagnosticSnapshot } from './diagnostics';
import type { CheckoutActivityInput, MaintenanceState } from './maintenance';
import type {
  RestoreCandidate,
  RestoreCandidateInspection,
  RestoreOutcome,
  RestoreRequest,
} from './restore';
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
import type { GoogleConfig, GoogleSetEnabledInput, RetryExportInput } from './google';
import type {
  PrinterConfig,
  PrinterDevice,
  PrintReceiptResult,
  SelectPrinterInput,
} from './printing';
import type { ReceiptRepresentation } from './receipt';
import type { ReconciliationEntry, ResolveReconciliationInput } from './reconciliation';
import type { DailyReport, DailyReportInput } from './reports';
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
  /** Sanitized read-only health snapshot; does not run the deeper quick_check. */
  diagnosticsGetSummary: 'diagnostics:get-summary',
  /** Owner-initiated sanitized snapshot including the safe read-only quick_check. */
  diagnosticsRun: 'diagnostics:run',

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

  // ── Phase 2K: Daily Reports ───────────────────────────────────────────────
  // One read-only capability. `daily` recomputes a single business day's totals
  // live from local `sales` snapshots (`REQ-REPORT-001`-`REQ-REPORT-009`,
  // `POS_WORKFLOWS.md §53`-`§55`). Payload is only an optional `{ businessDate }`
  // (`YYYY-MM-DD`, current business day when omitted) — no SQL, no range, no
  // column, no ordering. Writes nothing, emits no audit event, never queries
  // Google Sheets.
  reportsDaily: 'reports:daily',
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

  // ── Phase 2J.1: Google OAuth onboarding + Sheets export ──────────────────
  // Narrow capabilities only. `get-config` is read-only; `connect` runs the
  // desktop OAuth flow entirely in the main process (system browser, PKCE,
  // localhost loopback) and then provisioning — nothing secret ever crosses
  // back to the renderer; `retry-setup` re-runs provisioning without a new
  // sign-in; `set-enabled` toggles the single `google_sheets_enabled` flag;
  // `open-spreadsheet` opens the configured spreadsheet in the system browser;
  // `disconnect` invalidates the credential locally (works offline);
  // `retry-export` moves one FAILED job back to PENDING by immutable Sale ID.
  // No credential JSON, spreadsheet-ID, worksheet-name, or generic HTTP surface.
  googleGetConfig: 'google:get-config',
  googleConnect: 'google:connect',
  googleRetrySetup: 'google:retry-setup',
  googleSetEnabled: 'google:set-enabled',
  googleOpenSpreadsheet: 'google:open-spreadsheet',
  googleDisconnect: 'google:disconnect',
  googleRetryExport: 'google:retry-export',

  // ── Phase 2L: Backup & Restore (backup-creation half) ─────────────────────
  // `status` is a read-only backup-health DTO. `create-manual` is the owner
  // `Back Up Now` and takes NO arguments — the renderer cannot pass a path,
  // destination, or backup id; the trusted layer owns the file location. There
  // is deliberately no restore / filesystem / destination channel here.
  backupStatus: 'backup:status',
  backupCreateManual: 'backup:create-manual',

  // ── Phase 2L-B: safe whole-database restore + maintenance coordinator ─────
  // `list-restore-candidates` / `inspect-restore-candidate` are read-only and
  // take only an opaque `{ backupId }`. `restore` runs the guarded whole-
  // database replace-or-abort (`{ backupId, confirmationToken? }`). The renderer
  // never sends a path, filename, `storage_path`, or SQL. `maintenance:status`
  // is a read-only coordinator-state read; `maintenance:checkout-activity` is
  // the ONLY renderer-mutable maintenance input (`{ active: boolean }` draft-
  // cart presence).
  backupListRestoreCandidates: 'backup:list-restore-candidates',
  backupInspectRestoreCandidate: 'backup:inspect-restore-candidate',
  backupRestore: 'backup:restore',
  maintenanceStatus: 'maintenance:status',
  maintenanceCheckoutActivity: 'maintenance:checkout-activity',

  // ── Phase 2L-C: OFF_DEVICE backup + unified discovery + Browse ────────────
  // `status-verified` is the live-reverified twin of `backup:status` — it
  // re-runs the OFF_DEVICE destination check before answering, so it is used
  // only for an explicit Settings-page load/refresh, never a tight poll.
  // `configure-off-device` / `clear-off-device` take NO renderer-supplied
  // path: the trusted main process owns the native directory dialog.
  // `browse-restore-candidate` takes NO argument either; a cancelled dialog
  // resolves `{ ok: true, data: null }`, never an error.
  backupStatusVerified: 'backup:status-verified',
  backupConfigureOffDevice: 'backup:configure-off-device',
  backupClearOffDevice: 'backup:clear-off-device',
  backupOffDeviceConfiguration: 'backup:off-device-configuration',
  backupBrowseRestoreCandidate: 'backup:browse-restore-candidate',
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
    getSummary(): Promise<IpcResult<DiagnosticSnapshot>>;
    run(): Promise<IpcResult<DiagnosticSnapshot>>;
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
  readonly reports: {
    /**
     * One business day's Daily Report (`REQ-REPORT-001`-`REQ-REPORT-009`;
     * `POS_WORKFLOWS.md §53`-`§55`), recomputed live from local `sales`
     * snapshots. Pass `{ businessDate: 'YYYY-MM-DD' }` for a specific day, or
     * omit / `{}` for the current business day (resolved in the trusted layer
     * from the configured `business_timezone`, not the browser clock). Revenue
     * totals and the completed count exclude `VOIDED` sales; voided sales are
     * returned as a separate count for the same original business date. Google
     * Sheets is never queried; a malformed date is `VALIDATION`.
     */
    daily(input?: DailyReportInput): Promise<IpcResult<DailyReport>>;
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
  readonly google: {
    /**
     * Current non-secret Google integration state (`setupState`, connected
     * account email for display, spreadsheet name, sync health, queue counts).
     * Never returns a token, refresh token, authorization code, ID token, or
     * OAuth client configuration.
     */
    getConfig(): Promise<IpcResult<GoogleConfig>>;
    /**
     * Run the desktop OAuth flow in the main process (system browser + PKCE +
     * `127.0.0.1` loopback), store the encrypted refresh token, then provision
     * the app's own spreadsheet. The renderer receives only sanitized status.
     */
    connect(): Promise<IpcResult<GoogleConfig>>;
    /** Re-run spreadsheet provisioning for a connected-but-not-ready account (no new sign-in). */
    retrySetup(): Promise<IpcResult<GoogleConfig>>;
    /** Turn Google Sheets export on/off. Enabling requires a ready-to-sync integration. */
    setEnabled(input: GoogleSetEnabledInput): Promise<IpcResult<GoogleConfig>>;
    /** Open the configured spreadsheet in the external system browser. */
    openSpreadsheet(): Promise<IpcResult<void>>;
    /**
     * Invalidate the Google credential locally (export off, active marker off,
     * stored spreadsheet id cleared) and best-effort delete the encrypted file
     * and revoke remotely. Works offline; pending export jobs stay durable.
     */
    disconnect(): Promise<IpcResult<GoogleConfig>>;
    /**
     * Manual "Retry Export" for a `FAILED` job (`REQ-GSHEET-012`): `FAILED →
     * PENDING`, `attempt_count = 0`, `next_attempt_at = now`, `last_error =
     * NULL`. Never touches the sale, payment, inventory, receipt number, or any
     * sync version.
     */
    retryExport(input: RetryExportInput): Promise<IpcResult<GoogleConfig>>;
  };
  readonly backup: {
    /**
     * Read-only backup health: the most recent automatic backup result and
     * time, the last successful automatic backup time, whether backup is
     * overdue (a protection warning — never a database-failure claim), the most
     * recent failure, and the protection level (`LOCAL_DISK_ONLY` in V1).
     */
    status(): Promise<IpcResult<BackupHealth>>;
    /**
     * Owner `Back Up Now`: create + verify one WAL-safe SQLite snapshot of the
     * local database on this computer, record its metadata and a durable audit
     * event, and run retention cleanup. Takes no arguments — the trusted layer
     * owns the destination. Resolves with the completed backup's file name and
     * size, or a typed `BACKUP_IN_PROGRESS` / `BACKUP_FAILED` error.
     */
    createManual(): Promise<IpcResult<ManualBackupResult>>;
    /** App-managed COMPLETED backups usable as restore candidates, newest first. */
    listRestoreCandidates(): Promise<IpcResult<readonly RestoreCandidate[]>>;
    /**
     * Read-only preview of one candidate by opaque `backupId`: metadata,
     * schema compatibility, and how many completed sales (with date range)
     * would be lost. Takes no lock and creates no copy.
     */
    inspectRestoreCandidate(input: {
      backupId: string;
    }): Promise<IpcResult<RestoreCandidateInspection>>;
    /**
     * Guarded whole-database restore. Acquires exclusive DB-lifecycle
     * ownership, quiesces background work, revalidates the candidate, takes a
     * verified pre-restore recovery copy, and — only with an explicit
     * `confirmationToken` when newer data would be lost — swaps + validates the
     * restored database, rolling back to the pre-restore copy on any failure.
     * Resolves `COMPLETED`, `CONFIRMATION_REQUIRED` (with a fresh token), or a
     * typed `RESTORE_*` error.
     */
    restore(input: RestoreRequest): Promise<IpcResult<RestoreOutcome>>;
    /**
     * Live-reverified backup health, including OFF_DEVICE protection status.
     * Re-runs the destination check before answering — use it for a Settings
     * page load/refresh, never a tight poll.
     */
    statusVerified(): Promise<IpcResult<BackupHealth>>;
    /**
     * Owner-initiated off-device setup: the trusted main process shows a
     * native directory dialog, verifies the selection proves genuine
     * device/disk-loss protection, and persists it. Takes no path argument.
     * A cancelled dialog resolves the unchanged current configuration.
     */
    configureOffDevice(): Promise<IpcResult<OffDeviceBackupConfiguration>>;
    /** Remove the configured off-device destination (does not touch its files). */
    clearOffDevice(): Promise<IpcResult<OffDeviceBackupConfiguration>>;
    /** Live-reverified off-device destination configuration, for display. */
    offDeviceConfiguration(): Promise<IpcResult<OffDeviceBackupConfiguration>>;
    /**
     * Native "Browse for a backup file…": shows a file-open dialog, verifies
     * the selection through the same independent pipeline every managed
     * candidate passes, and returns a one-time restore candidate. A
     * cancelled dialog resolves `data: null` — never an error.
     */
    browseRestoreCandidate(): Promise<IpcResult<RestoreCandidate | null>>;
  };
  readonly maintenance: {
    /** Current maintenance-coordinator state, for the app-level banner. Read-only. */
    status(): Promise<IpcResult<{ state: MaintenanceState }>>;
    /**
     * The only renderer-mutable maintenance input: whether a draft cart is
     * currently open in this renderer. Cannot set any exclusive/transaction
     * state. `{ active: false }` is honoured only from the WebContents that
     * owns the tracked draft cart. `{ active: true }` resolves `ok: false`
     * (`MAINTENANCE_IN_PROGRESS`) when a RESTORE / MIGRATION owner already
     * holds the exclusive lifecycle — the cart was NOT recorded as active and
     * must not be continued.
     */
    noteCheckoutActivity(input: CheckoutActivityInput): Promise<IpcResult<{ accepted: boolean }>>;
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
