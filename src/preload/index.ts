import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { PosApi } from '../shared/ipc';

/**
 * Preload bridge (ARCHITECTURE.md Section 8).
 *
 * Runs in a sandboxed, context-isolated world. It exposes exactly one object,
 * `window.pos`, whose methods each forward to a single named IPC channel.
 *
 * It never exposes `ipcRenderer` (or `require`, `process`, `fs`, ...) to the
 * renderer, and offers no generic "send any message" / "run any SQL" method.
 * New capabilities must be added as explicit typed methods here and as matching
 * handlers in `src/main/ipc/register.ts`.
 */
const api: PosApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appInfo),
  },
  diagnostics: {
    checkNativeSqlite: () => ipcRenderer.invoke(IPC.nativeSqliteCheck),
    databaseStatus: () => ipcRenderer.invoke(IPC.databaseStatus),
    getSummary: () => ipcRenderer.invoke(IPC.diagnosticsGetSummary),
    run: () => ipcRenderer.invoke(IPC.diagnosticsRun),
  },
  support: {
    createReport: (input) => ipcRenderer.invoke(IPC.supportCreateReport, input),
    exportBundle: (input) => ipcRenderer.invoke(IPC.supportExportBundle, input),
    getActivityHistory: () => ipcRenderer.invoke(IPC.supportGetActivityHistory),
  },
  products: {
    create: (input) => ipcRenderer.invoke(IPC.productsCreate, input),
    update: (id, input) => ipcRenderer.invoke(IPC.productsUpdate, id, input),
    archive: (id) => ipcRenderer.invoke(IPC.productsArchive, id),
    list: (options) => ipcRenderer.invoke(IPC.productsList, options),
    search: (options) => ipcRenderer.invoke(IPC.productsSearch, options),
    findByBarcode: (barcode) => ipcRenderer.invoke(IPC.productsFindByBarcode, barcode),
  },
  inventory: {
    adjust: (input) => ipcRenderer.invoke(IPC.inventoryAdjust, input),
    movements: (productId) => ipcRenderer.invoke(IPC.inventoryMovements, productId),
  },
  customers: {
    create: (input) => ipcRenderer.invoke(IPC.customersCreate, input),
    update: (id, input) => ipcRenderer.invoke(IPC.customersUpdate, id, input),
    list: () => ipcRenderer.invoke(IPC.customersList),
    search: (options) => ipcRenderer.invoke(IPC.customersSearch, options),
    get: (id) => ipcRenderer.invoke(IPC.customersGet, id),
    purchaseHistory: (id) => ipcRenderer.invoke(IPC.customersPurchaseHistory, id),
  },
  checkout: {
    review: (request) => ipcRenderer.invoke(IPC.checkoutReview, request),
    completeCash: (request) => ipcRenderer.invoke(IPC.checkoutCompleteCash, request),
    beginCard: (request) => ipcRenderer.invoke(IPC.checkoutBeginCard, request),
    completeCard: (request) => ipcRenderer.invoke(IPC.checkoutCompleteCard, request),
    declineCard: (request) => ipcRenderer.invoke(IPC.checkoutDeclineCard, request),
  },
  reconciliation: {
    list: () => ipcRenderer.invoke(IPC.reconciliationList),
    resolve: (input) => ipcRenderer.invoke(IPC.reconciliationResolve, input),
  },
  receipts: {
    getBySaleId: (saleId) => ipcRenderer.invoke(IPC.receiptsGetBySaleId, saleId),
  },
  printing: {
    listPrinters: () => ipcRenderer.invoke(IPC.printingListPrinters),
    getConfig: () => ipcRenderer.invoke(IPC.printingGetConfig),
    selectPrinter: (input) => ipcRenderer.invoke(IPC.printingSelectPrinter, input),
    printReceipt: (saleId) => ipcRenderer.invoke(IPC.printingPrintReceipt, saleId),
  },
  google: {
    getConfig: () => ipcRenderer.invoke(IPC.googleGetConfig),
    connect: () => ipcRenderer.invoke(IPC.googleConnect),
    retrySetup: () => ipcRenderer.invoke(IPC.googleRetrySetup),
    setEnabled: (input) => ipcRenderer.invoke(IPC.googleSetEnabled, input),
    openSpreadsheet: () => ipcRenderer.invoke(IPC.googleOpenSpreadsheet),
    disconnect: () => ipcRenderer.invoke(IPC.googleDisconnect),
    retryExport: (input) => ipcRenderer.invoke(IPC.googleRetryExport, input),
  },
  salesHistory: {
    list: (search) => ipcRenderer.invoke(IPC.salesHistoryList, search),
    getById: (saleId) => ipcRenderer.invoke(IPC.salesHistoryGetById, saleId),
    voidSale: (input) => ipcRenderer.invoke(IPC.salesHistoryVoid, input),
  },
  reports: {
    daily: (input) => ipcRenderer.invoke(IPC.reportsDaily, input),
  },
  backup: {
    status: () => ipcRenderer.invoke(IPC.backupStatus),
    createManual: () => ipcRenderer.invoke(IPC.backupCreateManual),
    listRestoreCandidates: () => ipcRenderer.invoke(IPC.backupListRestoreCandidates),
    inspectRestoreCandidate: (input) =>
      ipcRenderer.invoke(IPC.backupInspectRestoreCandidate, input),
    restore: (input) => ipcRenderer.invoke(IPC.backupRestore, input),
    statusVerified: () => ipcRenderer.invoke(IPC.backupStatusVerified),
    configureOffDevice: () => ipcRenderer.invoke(IPC.backupConfigureOffDevice),
    clearOffDevice: () => ipcRenderer.invoke(IPC.backupClearOffDevice),
    offDeviceConfiguration: () => ipcRenderer.invoke(IPC.backupOffDeviceConfiguration),
    browseRestoreCandidate: () => ipcRenderer.invoke(IPC.backupBrowseRestoreCandidate),
  },
  maintenance: {
    status: () => ipcRenderer.invoke(IPC.maintenanceStatus),
    noteCheckoutActivity: (input) => ipcRenderer.invoke(IPC.maintenanceCheckoutActivity, input),
  },
  settings: {
    tax: {
      get: () => ipcRenderer.invoke(IPC.settingsTaxGet),
      update: (input) => ipcRenderer.invoke(IPC.settingsTaxUpdate, input),
    },
    business: {
      get: () => ipcRenderer.invoke(IPC.settingsBusinessGet),
      update: (input) => ipcRenderer.invoke(IPC.settingsBusinessUpdate, input),
    },
  },
};

contextBridge.exposeInMainWorld('pos', api);
