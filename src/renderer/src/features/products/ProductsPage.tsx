import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateProductInput,
  InventoryAdjustmentInput,
  InventoryMovementRecord,
  IpcResult,
  ProductRecord,
  UpdateProductInput,
} from '../../../../shared/products';
import { AdjustStockPanel } from './AdjustStockPanel';
import { formatCents } from './money';
import { ProductForm } from './ProductForm';

/**
 * Product-management area (task `§17`). Deliberately a focused screen, not an
 * application-shell redesign and not checkout UI.
 *
 * All persistence goes through `window.pos.products.*` / `window.pos.inventory.*`
 * — the narrow typed preload surface. The renderer never sees SQLite.
 */

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; product: ProductRecord }
  | { kind: 'adjust'; product: ProductRecord };

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

/** Unwrap an `IpcResult`: return `data` on success, or throw the typed message. */
async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
}

export function ProductsPage() {
  const [products, setProducts] = useState<readonly ProductRecord[]>([]);
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [barcode, setBarcode] = useState('');
  const [barcodeResult, setBarcodeResult] = useState<string | null>(null);

  const [movements, setMovements] = useState<readonly InventoryMovementRecord[]>([]);

  const refresh = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoading(false);
      setListError('Product data is unavailable in this context.');
      return;
    }
    setLoading(true);
    try {
      const data =
        query.trim() === ''
          ? await unwrap(api.products.list({ includeArchived }))
          : await unwrap(api.products.search({ query, includeArchived }));
      setProducts(data);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query, includeArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(
    async (input: CreateProductInput): Promise<string | null> => {
      const api = pos();
      if (!api) return 'Product data is unavailable in this context.';
      try {
        const created = await unwrap(api.products.create(input));
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
    async (id: string, input: UpdateProductInput): Promise<string | null> => {
      const api = pos();
      if (!api) return 'Product data is unavailable in this context.';
      try {
        const updated = await unwrap(api.products.update(id, input));
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

  const handleArchive = useCallback(
    async (product: ProductRecord) => {
      const api = pos();
      if (!api) return;
      const confirmed = window.confirm(
        `Archive “${product.name}”? It will no longer appear as sellable stock, but historical sales keep it.`,
      );
      if (!confirmed) return;
      try {
        await unwrap(api.products.archive(product.id));
        setNotice(`Archived “${product.name}”.`);
        await refresh();
      } catch (error) {
        setListError(error instanceof Error ? error.message : String(error));
      }
    },
    [refresh],
  );

  const handleAdjust = useCallback(
    async (input: InventoryAdjustmentInput): Promise<string | null> => {
      const api = pos();
      if (!api) return 'Product data is unavailable in this context.';
      try {
        const { product } = await unwrap(api.inventory.adjust(input));
        setNotice(`Stock for “${product.name}” is now ${product.quantityOnHand}.`);
        setView({ kind: 'list' });
        await refresh();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [refresh],
  );

  const lookupBarcode = useCallback(async () => {
    const api = pos();
    if (!api || barcode.trim() === '') return;
    try {
      const result = await unwrap(api.products.findByBarcode(barcode));
      setBarcodeResult(
        result.found
          ? `${result.product.name} — ${formatCents(result.product.sellingPriceCents)} — stock ${result.product.quantityOnHand}`
          : 'No product found for this barcode.',
      );
    } catch (error) {
      setBarcodeResult(error instanceof Error ? error.message : String(error));
    }
  }, [barcode]);

  const openAdjust = useCallback(async (product: ProductRecord) => {
    const api = pos();
    setView({ kind: 'adjust', product });
    if (api) {
      try {
        setMovements(await unwrap(api.inventory.movements(product.id)));
      } catch {
        setMovements([]);
      }
    }
  }, []);

  const summary = useMemo(() => {
    const active = products.filter((p) => p.isActive);
    const low = active.filter((p) => p.lowStock).length;
    const zero = active.filter((p) => p.zeroStock).length;
    return { total: products.length, low, zero };
  }, [products]);

  if (view.kind === 'add') {
    return (
      <ProductForm
        mode="create"
        onCreate={handleCreate}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'edit') {
    return (
      <ProductForm
        mode="edit"
        product={view.product}
        onUpdate={(input) => handleUpdate(view.product.id, input)}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'adjust') {
    return (
      <div>
        <AdjustStockPanel
          product={view.product}
          onSubmit={handleAdjust}
          onCancel={() => setView({ kind: 'list' })}
        />
        <section className="movement-history">
          <h4>Inventory movement history</h4>
          {movements.length === 0 ? (
            <p>No movements recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Type</th>
                  <th>Change</th>
                  <th>Before → After</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td>{m.createdAt}</td>
                    <td>{m.movementType}</td>
                    <td>{m.quantityChange > 0 ? `+${m.quantityChange}` : m.quantityChange}</td>
                    <td>
                      {m.quantityBefore} → {m.quantityAfter}
                    </td>
                    <td>{m.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  }

  return (
    <section className="products-page">
      <header className="products-toolbar">
        <input
          type="search"
          placeholder="Search name, brand, model, SKU or barcode"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
        <button type="button" onClick={() => setView({ kind: 'add' })}>
          Add product
        </button>
      </header>

      <div className="barcode-lookup">
        <input
          placeholder="Scan or type a barcode"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void lookupBarcode();
            }
          }}
        />
        <button type="button" onClick={() => void lookupBarcode()}>
          Find by barcode
        </button>
        {barcodeResult && <span className="barcode-result">{barcodeResult}</span>}
      </div>

      <p className="products-summary">
        {summary.total} shown · {summary.low} low stock · {summary.zero} out of stock
      </p>

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
        <table className="products-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Brand / model</th>
              <th>Condition</th>
              <th>Price</th>
              <th>Stock</th>
              <th>State</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id} className={product.isActive ? '' : 'archived-row'}>
                <td>{product.name}</td>
                <td>
                  {product.brand} {product.model}
                </td>
                <td>{product.condition}</td>
                <td>{formatCents(product.sellingPriceCents)}</td>
                <td>{product.quantityOnHand}</td>
                <td>
                  {!product.isActive && <span className="tag tag-archived">Archived</span>}
                  {product.zeroStock && <span className="tag tag-zero">Out of stock</span>}
                  {product.lowStock && !product.zeroStock && (
                    <span className="tag tag-low">Low stock</span>
                  )}
                </td>
                <td className="row-actions">
                  <button type="button" onClick={() => setView({ kind: 'edit', product })}>
                    Edit
                  </button>
                  <button type="button" onClick={() => void openAdjust(product)}>
                    Adjust stock
                  </button>
                  {product.isActive && (
                    <button type="button" onClick={() => void handleArchive(product)}>
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={7}>No products.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
