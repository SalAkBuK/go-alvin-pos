import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';
import type { PosApi } from '../../src/shared/ipc';

describe('IPC contract', () => {
  it('exposes exactly the foundation, diagnostic, product/inventory, customer, checkout (review + cash + card), reconciliation, receipt, and settings (tax + business) channels', () => {
    expect(Object.keys(IPC).sort()).toEqual(
      [
        'appInfo',
        'databaseStatus',
        'diagnosticsGetSummary',
        'diagnosticsRun',
        'supportCreateReport',
        'supportExportBundle',
        'supportGetActivityHistory',
        'inventoryAdjust',
        'inventoryMovements',
        'nativeSqliteCheck',
        'productsArchive',
        'productsCreate',
        'productsFindByBarcode',
        'productsList',
        'productsSearch',
        'productsUpdate',
        'customersCreate',
        'customersUpdate',
        'customersList',
        'customersSearch',
        'customersGet',
        'customersPurchaseHistory',
        'checkoutReview',
        'checkoutCompleteCash',
        'checkoutBeginCard',
        'checkoutCompleteCard',
        'checkoutDeclineCard',
        'reconciliationList',
        'reconciliationResolve',
        'receiptsGetBySaleId',
        'salesHistoryList',
        'salesHistoryGetById',
        'salesHistoryVoid',
        'reportsDaily',
        'settingsTaxGet',
        'settingsTaxUpdate',
        'settingsBusinessGet',
        'settingsBusinessUpdate',
        'printingListPrinters',
        'printingGetConfig',
        'printingSelectPrinter',
        'printingPrintReceipt',
        'googleGetConfig',
        'googleConnect',
        'googleRetrySetup',
        'googleSetEnabled',
        'googleOpenSpreadsheet',
        'googleDisconnect',
        'googleRetryExport',
        'backupStatus',
        'backupStatusVerified',
        'backupCreateManual',
        'backupListRestoreCandidates',
        'backupInspectRestoreCandidate',
        'backupRestore',
        'backupBrowseRestoreCandidate',
        'backupConfigureOffDevice',
        'backupClearOffDevice',
        'backupOffDeviceConfiguration',
        'maintenanceStatus',
        'maintenanceCheckoutActivity',
        'updatesGetStatus',
        'updatesCheckNow',
        'updatesRestartAndInstall',
      ].sort(),
    );
  });

  it('every business channel is an explicit namespaced business capability', () => {
    // products:*, inventory:*, customers:*, checkout:*, settings:* are allowed; a generic data/SQL surface is not.
    const allowedNamespaces = [
      'app',
      'diagnostics',
      'products',
      'inventory',
      'customers',
      'checkout',
      'reconciliation',
      'receipts',
      'sales-history',
      'reports',
      'settings',
      'printing',
      'google',
      'backup',
      'maintenance',
      'support',
      'updates',
    ];
    for (const name of Object.values(IPC)) {
      const namespace = name.split(':')[0];
      expect(allowedNamespaces).toContain(namespace);
    }
  });

  it('uses stable, unique, namespaced channel names', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
    }
  });

  it('defines no generic database / shell / filesystem channel', () => {
    // Guards ARCHITECTURE.md §9: no `database:query`, `execute-sql`, `run-command`,
    // `read-any-file`, etc. Matches whole dangerous verbs/nouns, not substrings
    // (so `diagnostics:native-sqlite-check` and `products:find-by-barcode` are fine).
    const bannedPattern =
      /(^|[:-])(query|exec|execute|eval|command|shell|spawn|sql|readfile|writefile|read-file|write-file|fs)([:-]|$)/;
    for (const name of Object.values(IPC)) {
      expect(name.toLowerCase()).not.toMatch(bannedPattern);
    }
  });

  it('the preload surface (PosApi) is exactly the explicit product/inventory namespaces', () => {
    // Type-level guard made concrete: the shape must not grow an escape hatch
    // such as `raw`, `invoke`, `send`, `ipcRenderer`, or a SQL passthrough.
    const surface: Record<keyof PosApi, readonly string[]> = {
      app: ['getInfo'],
      diagnostics: ['checkNativeSqlite', 'databaseStatus', 'getSummary', 'run'],
      support: ['createReport', 'exportBundle', 'getActivityHistory'],
      products: ['create', 'update', 'archive', 'list', 'search', 'findByBarcode'],
      inventory: ['adjust', 'movements'],
      customers: ['create', 'update', 'list', 'search', 'get', 'purchaseHistory'],
      checkout: ['review', 'completeCash', 'beginCard', 'completeCard', 'declineCard'],
      reconciliation: ['list', 'resolve'],
      receipts: ['getBySaleId'],
      salesHistory: ['list', 'getById', 'voidSale'],
      // `reports` exposes only the read-only Daily Report — no generic query surface.
      reports: ['daily'],
      // `backup` exposes status + a no-argument manual backup + the two-stage
      // restore by opaque backupId, plus Phase 2L-C's no-argument OFF_DEVICE
      // setup (the main process owns the native dialogs) and Browse — no path,
      // destination, or filesystem surface.
      backup: [
        'status',
        'statusVerified',
        'createManual',
        'listRestoreCandidates',
        'inspectRestoreCandidate',
        'restore',
        'browseRestoreCandidate',
        'configureOffDevice',
        'clearOffDevice',
        'offDeviceConfiguration',
      ],
      // `maintenance` exposes read-only status + the one narrow draft-cart signal.
      maintenance: ['status', 'noteCheckoutActivity'],
      // `updates` exposes read-only status, a no-argument manual check, and a
      // no-argument restart-and-install request — the main process alone
      // decides READY/maintenance-safety; no URL, version, or path surface.
      updates: ['getStatus', 'checkNow', 'restartAndInstall'],
      // `settings` exposes only the tax and business sub-objects — no generic setter.
      settings: ['tax.get', 'tax.update', 'business.get', 'business.update'],
      // `printing` exposes only narrow capabilities — no generic settings/query surface.
      printing: ['listPrinters', 'getConfig', 'selectPrinter', 'printReceipt'],
      // `google` exposes only narrow capabilities — no credential/spreadsheet/HTTP surface.
      google: [
        'getConfig',
        'connect',
        'retrySetup',
        'setEnabled',
        'openSpreadsheet',
        'disconnect',
        'retryExport',
      ],
    };
    expect(Object.keys(surface).sort()).toEqual([
      'app',
      'backup',
      'checkout',
      'customers',
      'diagnostics',
      'google',
      'inventory',
      'maintenance',
      'printing',
      'products',
      'receipts',
      'reconciliation',
      'reports',
      'salesHistory',
      'settings',
      'support',
      'updates',
    ]);
    for (const methods of Object.values(surface)) {
      for (const method of methods) {
        expect(/^(raw|invoke|send|ipc|ipcRenderer|query|execute|set)$/i.test(method)).toBe(false);
      }
    }
  });
});
