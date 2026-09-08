import { useEffect, useState } from 'react';
import type { AppInfo, DatabaseStatus } from '../../shared/ipc';
import { CustomersPage } from './features/customers/CustomersPage';
import { ProductsPage } from './features/products/ProductsPage';

/**
 * Application shell.
 *
 * Implemented business areas: Products + Inventory (Phase 2B) and Customers
 * (Phase 2C). A small status line keeps the database/runtime state visible.
 * There is no checkout, sales, reporting, or settings UI yet.
 */

type Area = 'products' | 'customers';

interface ShellStatus {
  readonly info: AppInfo | null;
  readonly database: DatabaseStatus | null;
}

function describeDatabase(database: DatabaseStatus | null): string {
  if (!database) {
    return 'status unavailable';
  }
  if (database.state === 'ready') {
    return `ready — schema v${String(database.schemaVersion)}`;
  }
  if (database.state === 'initializing') {
    return 'initializing…';
  }
  return `unavailable — ${database.failureCode ?? 'unknown'}`;
}

export function App() {
  const [status, setStatus] = useState<ShellStatus>({ info: null, database: null });
  const [area, setArea] = useState<Area>('products');

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
      return;
    }
    let active = true;
    void Promise.all([window.pos.app.getInfo(), window.pos.diagnostics.databaseStatus()])
      .then(([info, database]) => {
        if (active) {
          setStatus({ info, database });
        }
      })
      .catch(() => {
        /* status line is best-effort; feature operations surface their own errors */
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <h1>Go Phones POS</h1>
        <p className="app-status">
          {status.info ? `${status.info.name} ${status.info.version}` : 'Go Phones POS'} · database{' '}
          {describeDatabase(status.database)}
        </p>
        <nav className="app-nav">
          <button
            type="button"
            aria-current={area === 'products'}
            onClick={() => setArea('products')}
          >
            Products &amp; Inventory
          </button>
          <button
            type="button"
            aria-current={area === 'customers'}
            onClick={() => setArea('customers')}
          >
            Customers
          </button>
        </nav>
      </header>
      {area === 'products' ? (
        <>
          <h2>Products &amp; Inventory</h2>
          <ProductsPage />
        </>
      ) : (
        <>
          <h2>Customers</h2>
          <CustomersPage />
        </>
      )}
    </main>
  );
}
