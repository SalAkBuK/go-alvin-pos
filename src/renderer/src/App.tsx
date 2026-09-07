import { useEffect, useState } from 'react';
import type { AppInfo, DatabaseStatus } from '../../shared/ipc';
import { ProductsPage } from './features/products/ProductsPage';

/**
 * Application shell for the Phase 2B slice.
 *
 * The one implemented business area is Products + Inventory (`ProductsPage`).
 * A small status line keeps the database/runtime state visible; there is no
 * checkout, customers, sales, reporting, or settings UI yet.
 */

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
        /* status line is best-effort; product operations surface their own errors */
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
      </header>
      <h2>Products &amp; Inventory</h2>
      <ProductsPage />
    </main>
  );
}
