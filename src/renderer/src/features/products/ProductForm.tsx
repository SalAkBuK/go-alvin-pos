import { useState } from 'react';
import { PRODUCT_CONDITIONS } from '../../../../shared/products';
import type {
  CreateProductInput,
  ProductCondition,
  ProductRecord,
  UpdateProductInput,
} from '../../../../shared/products';
import { parseDollarsToCents, parseIntegerField } from './money';

/**
 * Add / edit product form (`POS_WORKFLOWS.md §8, §10`).
 *
 * On create it collects every canonical create field including starting
 * quantity. On edit, quantity is intentionally absent — stock changes go
 * through Adjust Stock (`DATA_MODEL.md §40`). Renderer validation here is only
 * for fast feedback; the trusted layer re-validates everything.
 */

interface FieldState {
  name: string;
  brand: string;
  model: string;
  condition: ProductCondition;
  sellingPrice: string;
  quantity: string;
  sku: string;
  barcode: string;
  costPrice: string;
  lowStockThreshold: string;
}

function initialState(product?: ProductRecord): FieldState {
  return {
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    model: product?.model ?? '',
    condition: product?.condition ?? 'NEW',
    sellingPrice: product ? (product.sellingPriceCents / 100).toFixed(2) : '',
    quantity: '0',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    costPrice: product?.costPriceCents != null ? (product.costPriceCents / 100).toFixed(2) : '',
    lowStockThreshold: product?.lowStockThreshold != null ? String(product.lowStockThreshold) : '',
  };
}

export interface ProductFormProps {
  readonly mode: 'create' | 'edit';
  readonly product?: ProductRecord;
  readonly onCreate?: (input: CreateProductInput) => Promise<string | null>;
  readonly onUpdate?: (input: UpdateProductInput) => Promise<string | null>;
  readonly onCancel: () => void;
}

export function ProductForm({ mode, product, onCreate, onUpdate, onCancel }: ProductFormProps) {
  const [fields, setFields] = useState<FieldState>(() => initialState(product));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof FieldState>(key: K, value: FieldState[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let submitError: string | null;
    try {
      setBusy(true);
      if (mode === 'create') {
        if (!onCreate) {
          return;
        }
        const create: CreateProductInput = {
          name: fields.name.trim(),
          brand: fields.brand.trim(),
          model: fields.model.trim(),
          condition: fields.condition,
          sellingPriceCents: parseDollarsToCents(fields.sellingPrice) ?? 0,
          quantity: parseIntegerField(fields.quantity) ?? 0,
          sku: fields.sku.trim() === '' ? null : fields.sku.trim(),
          barcode: fields.barcode.trim() === '' ? null : fields.barcode.trim(),
          costPriceCents: parseDollarsToCents(fields.costPrice),
          lowStockThreshold: parseIntegerField(fields.lowStockThreshold),
        };
        submitError = await onCreate(create);
      } else {
        if (!onUpdate) {
          return;
        }
        const update: UpdateProductInput = {
          name: fields.name.trim(),
          brand: fields.brand.trim(),
          model: fields.model.trim(),
          condition: fields.condition,
          sellingPriceCents: parseDollarsToCents(fields.sellingPrice) ?? 0,
          costPriceCents: parseDollarsToCents(fields.costPrice),
          sku: fields.sku.trim() === '' ? null : fields.sku.trim(),
          barcode: fields.barcode.trim() === '' ? null : fields.barcode.trim(),
          lowStockThreshold: parseIntegerField(fields.lowStockThreshold),
        };
        submitError = await onUpdate(update);
      }
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      setBusy(false);
      return;
    }

    setBusy(false);
    if (submitError) {
      setError(submitError);
    }
  }

  return (
    <form className="product-form" onSubmit={handleSubmit}>
      <h3>{mode === 'create' ? 'Add product' : `Edit ${product?.name ?? 'product'}`}</h3>

      <label>
        Name
        <input value={fields.name} onChange={(e) => set('name', e.target.value)} required />
      </label>
      <label>
        Brand
        <input value={fields.brand} onChange={(e) => set('brand', e.target.value)} required />
      </label>
      <label>
        Model
        <input value={fields.model} onChange={(e) => set('model', e.target.value)} required />
      </label>
      <label>
        Condition
        <select
          value={fields.condition}
          onChange={(e) => set('condition', e.target.value as ProductCondition)}
        >
          {PRODUCT_CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {condition}
            </option>
          ))}
        </select>
      </label>
      <label>
        Selling price (USD)
        <input
          inputMode="decimal"
          value={fields.sellingPrice}
          onChange={(e) => set('sellingPrice', e.target.value)}
          placeholder="599.00"
          required
        />
      </label>
      {mode === 'create' && (
        <label>
          Starting quantity
          <input
            inputMode="numeric"
            value={fields.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
        </label>
      )}
      <label>
        Cost price (USD, optional)
        <input
          inputMode="decimal"
          value={fields.costPrice}
          onChange={(e) => set('costPrice', e.target.value)}
        />
      </label>
      <label>
        SKU (optional)
        <input value={fields.sku} onChange={(e) => set('sku', e.target.value)} />
      </label>
      <label>
        Barcode (optional)
        <input value={fields.barcode} onChange={(e) => set('barcode', e.target.value)} />
      </label>
      <label>
        Low-stock threshold (optional)
        <input
          inputMode="numeric"
          value={fields.lowStockThreshold}
          onChange={(e) => set('lowStockThreshold', e.target.value)}
        />
      </label>

      {error && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}

      <div className="product-form-actions">
        <button type="submit" disabled={busy}>
          {mode === 'create' ? 'Create product' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
