import { useEffect, useState } from 'react';
import type { AppInfo, DatabaseStatus } from '../../shared/ipc';
import type { MaintenanceState } from '../../shared/maintenance';
import { BrandLogo } from './components/BrandLogo';
import { CheckoutPage } from './features/checkout/CheckoutPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { SalesHistoryPage } from './features/history/SalesHistoryPage';
import { ProductsPage } from './features/products/ProductsPage';
import { DailyReportPage } from './features/reports/DailyReportPage';
import { SettingsPage } from './features/settings/SettingsPage';

/**
 * Application shell.
 *
 * Implemented business areas: Products + Inventory (Phase 2B), Customers
 * (Phase 2C), Checkout / New Sale (Phase 2D review + Phase 2E Cash completion +
 * Phase 2F manual Clover Card workflow), and a Settings area for the sales-tax
 * rate, business/receipt details (Phase 2D.1 / 2D.2), and the Card
 * Reconciliation Queue (Phase 2F). Sales History (Phase 2G) is a read-only list
 * with historical transaction detail and View Receipt. Reports (Phase 2K) is a
 * read-only Daily Report recomputed from local SQLite for a selected business
 * day. A small status line keeps the database/runtime state visible.
 */

type Area = 'checkout' | 'products' | 'customers' | 'history' | 'reports' | 'settings';

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
  const [area, setArea] = useState<Area>('checkout');
  const [maintenance, setMaintenance] = useState<MaintenanceState>('SAFE');

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

  // Application-level maintenance banner (secondary defence — the trusted main
  // process refuses DB-backed IPC during a restore regardless of the UI).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
      return;
    }
    let active = true;
    const poll = (): void => {
      void window.pos.maintenance
        .status()
        .then((result) => {
          if (active && result.ok) {
            setMaintenance(result.data.state);
          }
        })
        .catch(() => {
          /* ignore — best effort */
        });
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const restoring =
    maintenance === 'RESTORE_IN_PROGRESS' || maintenance === 'MIGRATION_IN_PROGRESS';

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-brand">
          <BrandLogo className="app-logo" />
          <h1>Go Phones POS</h1>
        </div>
        <p className="app-status">
          {status.info ? `${status.info.name} ${status.info.version}` : 'Go Phones POS'} · database{' '}
          {describeDatabase(status.database)}
        </p>
        {restoring && (
          <p className="app-maintenance-banner" role="status">
            Restoring database — sales are temporarily unavailable. This will finish in a moment.
          </p>
        )}
        <nav className="app-nav">
          <button
            type="button"
            aria-current={area === 'checkout'}
            onClick={() => setArea('checkout')}
          >
            New Sale
          </button>
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
          <button
            type="button"
            aria-current={area === 'history'}
            onClick={() => setArea('history')}
          >
            Sales History
          </button>
          <button
            type="button"
            aria-current={area === 'reports'}
            onClick={() => setArea('reports')}
          >
            Reports
          </button>
          <button
            type="button"
            aria-current={area === 'settings'}
            onClick={() => setArea('settings')}
          >
            Settings
          </button>
        </nav>
      </header>
      {area === 'checkout' && (
        <>
          <h2>New Sale</h2>
          <CheckoutPage />
        </>
      )}
      {area === 'products' && (
        <>
          <h2>Products &amp; Inventory</h2>
          <ProductsPage />
        </>
      )}
      {area === 'customers' && (
        <>
          <h2>Customers</h2>
          <CustomersPage />
        </>
      )}
      {area === 'history' && (
        <>
          <h2>Sales History</h2>
          <SalesHistoryPage />
        </>
      )}
      {area === 'reports' && (
        <>
          <h2>Reports</h2>
          <DailyReportPage />
        </>
      )}
      {area === 'settings' && (
        <>
          <h2>Settings</h2>
          <SettingsPage />
        </>
      )}
    </main>
  );
}
