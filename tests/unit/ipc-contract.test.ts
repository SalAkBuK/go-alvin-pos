import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';
import type { PosApi } from '../../src/shared/ipc';

describe('IPC contract', () => {
  it('exposes exactly the foundation, diagnostic, and Phase 2B product/inventory channels', () => {
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
      ].sort(),
    );
  });

  it('every business channel is an explicit namespaced business capability', () => {
    // products:* and inventory:* are allowed; a generic data/SQL surface is not.
    const allowedNamespaces = ['app', 'diagnostics', 'products', 'inventory'];
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
    };
    expect(Object.keys(surface).sort()).toEqual(['app', 'diagnostics', 'inventory', 'products']);
    for (const methods of Object.values(surface)) {
      for (const method of methods) {
        expect(/^(raw|invoke|send|ipc|ipcRenderer|query|execute)$/i.test(method)).toBe(false);
      }
    }
  });
});
