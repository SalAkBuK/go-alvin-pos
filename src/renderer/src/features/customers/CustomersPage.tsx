import { useCallback, useEffect, useState } from 'react';
import type {
  CustomerPurchase,
  CustomerRecord,
  UpdateCustomerInput,
} from '../../../../shared/customers';
import type { IpcResult } from '../../../../shared/products';
import { CustomerForm } from './CustomerForm';

/**
 * Customers area (task `§10`). A focused screen — list/search, add, edit, and a
 * read-only detail view with purchase history. No checkout or customer-selection
 * UI. All persistence goes through `window.pos.customers.*`; the renderer never
 * sees SQLite.
 */

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; customer: CustomerRecord }
  | { kind: 'detail'; customer: CustomerRecord };

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CustomersPage() {
  const [customers, setCustomers] = useState<readonly CustomerRecord[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<readonly CustomerPurchase[] | null>(null);

  const refresh = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoading(false);
      setListError('Customer data is unavailable in this context.');
      return;
    }
    setLoading(true);
    try {
      const data =
        query.trim() === ''
          ? await unwrap(api.customers.list())
          : await unwrap(api.customers.search({ query }));
      setCustomers(data);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(
    async (fields: { name: string; phone: string | null }): Promise<string | null> => {
      const api = pos();
      if (!api) return 'Customer data is unavailable in this context.';
      try {
        const created = await unwrap(api.customers.create(fields));
        setNotice(`Created “${created.name}”.`);
        setView({ kind: 'list' });
        await refresh();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [refresh],
  );

  const handleUpdate = useCallback(
    async (id: string, input: UpdateCustomerInput): Promise<string | null> => {
      const api = pos();
      if (!api) return 'Customer data is unavailable in this context.';
      try {
        const updated = await unwrap(api.customers.update(id, input));
        setNotice(`Saved changes to “${updated.name}”.`);
        setView({ kind: 'list' });
        await refresh();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [refresh],
  );

  const openDetail = useCallback(async (customer: CustomerRecord) => {
    const api = pos();
    setView({ kind: 'detail', customer });
    setHistory(null);
    if (api) {
      try {
        setHistory(await unwrap(api.customers.purchaseHistory(customer.id)));
      } catch {
        setHistory([]);
      }
    }
  }, []);

  if (view.kind === 'add') {
    return (
      <CustomerForm
        mode="create"
        onSubmit={handleCreate}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'edit') {
    return (
      <CustomerForm
        mode="edit"
        customer={view.customer}
        onSubmit={(fields) => handleUpdate(view.customer.id, fields)}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'detail') {
    const { customer } = view;
    return (
      <section className="customer-detail">
        <button type="button" onClick={() => setView({ kind: 'list' })}>
          ← Back to customers
        </button>
        <h3>{customer.name}</h3>
        <dl>
          <dt>Phone</dt>
          <dd>{customer.phone ?? 'No phone on file'}</dd>
        </dl>
        <button type="button" onClick={() => setView({ kind: 'edit', customer })}>
          Edit customer
        </button>

        <h4>Purchase history</h4>
        {history === null && <p>Loading…</p>}
        {history !== null && history.length === 0 && <p>No purchases yet.</p>}
        {history !== null && history.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Completed (UTC)</th>
                <th>Status</th>
                <th>Total</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {history.map((purchase) => (
                <tr key={purchase.saleId}>
                  <td>{purchase.receiptNumber}</td>
                  <td>{purchase.completedAt}</td>
                  <td>{purchase.status}</td>
                  <td>{formatUsd(purchase.totalCents)}</td>
                  <td>{purchase.paymentMethod}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  return (
    <section className="customers-page">
      <header className="products-toolbar">
        <input
          type="search"
          placeholder="Search by name or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={() => setView({ kind: 'add' })}>
          Add customer
        </button>
      </header>

      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}
      {listError && (
        <p className="product-form-error" role="alert">
          {listError}
        </p>
      )}
      {loading && <p>Loading…</p>}

      {!loading && (
        <table className="customers-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id}>
                <td>{customer.name}</td>
                <td>{customer.phone ?? <span className="muted">No phone</span>}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => void openDetail(customer)}>
                    View
                  </button>
                  <button type="button" onClick={() => setView({ kind: 'edit', customer })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={3}>No customers.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
