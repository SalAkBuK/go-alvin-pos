import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';
import type { PosApi } from '../../src/shared/ipc';

describe('IPC contract', () => {
  it('exposes exactly the foundation, diagnostic, product/inventory, customer, checkout (review + cash + card), reconciliation, receipt, and settings (tax + business) channels', () => {
    expect(Object.keys(IPC).sort()).toEqual(
      [
        'appInfo',
        'databaseStatus',
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
        'settingsTaxGet',
        'settingsTaxUpdate',
        'settingsBusinessGet',
        'settingsBusinessUpdate',
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
      'settings',
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
      diagnostics: ['checkNativeSqlite', 'databaseStatus'],
      products: ['create', 'update', 'archive', 'list', 'search', 'findByBarcode'],
      inventory: ['adjust', 'movements'],
      customers: ['create', 'update', 'list', 'search', 'get', 'purchaseHistory'],
      checkout: ['review', 'completeCash', 'beginCard', 'completeCard', 'declineCard'],
      reconciliation: ['list', 'resolve'],
      receipts: ['getBySaleId'],
      salesHistory: ['list', 'getById'],
      // `settings` exposes only the tax and business sub-objects — no generic setter.
      settings: ['tax.get', 'tax.update', 'business.get', 'business.update'],
    };
    expect(Object.keys(surface).sort()).toEqual([
      'app',
      'checkout',
      'customers',
      'diagnostics',
      'inventory',
      'products',
      'receipts',
      'reconciliation',
      'salesHistory',
      'settings',
    ]);
    for (const methods of Object.values(surface)) {
      for (const method of methods) {
        expect(/^(raw|invoke|send|ipc|ipcRenderer|query|execute|set)$/i.test(method)).toBe(false);
      }
    }
  });
});
