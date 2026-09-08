import { useState } from 'react';
import { PRODUCT_CONDITIONS } from '../../../../shared/products';
import type {
  CreateProductInput,
  ProductCondition,
  ProductRecord,
  UpdateProductInput,
} from '../../../../shared/products';
import { FormField } from './FormField';
import { mapProductServerError, validateProductField, validateProductForm } from './formValidation';
import type { ProductFieldName, ProductFormErrors, ProductFormFields } from './formValidation';

/**
 * Add / edit product form (`POS_WORKFLOWS.md §8, §10`).
 *
 * On create it collects every canonical create field including starting
 * quantity. On edit, quantity is intentionally absent — stock changes go
 * through Adjust Stock (`DATA_MODEL.md §40`).
 *
 * Field-level validation (Phase 2B UX polish) runs on blur and again on submit,
 * clears as the user corrects a field, and never fires on an untouched field.
 * It is not authoritative: `productValidation.ts` and the SQLite constraints
 * remain the source of truth, and a trusted-layer failure that maps to a field
 * (duplicate SKU/barcode) is shown next to that input.
 */

function initialFields(product?: ProductRecord): ProductFormFields {
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
  const [fields, setFields] = useState<ProductFormFields>(() => initialFields(product));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [touched, setTouched] = useState<Partial<Record<ProductFieldName, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  function shownError(field: ProductFieldName): string | undefined {
    if (field === 'sku' || field === 'barcode') {
      // Only ever a server-mapped error; always safe to show once present.
      return errors[field];
    }
    return touched[field] || submitAttempted ? errors[field] : undefined;
  }

  function setField(field: ProductFieldName, value: string) {
    const next = { ...fields, [field]: value };
    setFields(next);
    if (touched[field] || submitAttempted) {
      setErrors((prev) => ({
        ...prev,
        [field]: validateProductField(field, next, mode) ?? undefined,
      }));
    } else if (errors[field]) {
      // A server error on an otherwise-untouched field: clear it as the user edits.
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  function blurField(field: ProductFieldName) {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setErrors((prev) => ({
      ...prev,
      [field]: validateProductField(field, fields, mode) ?? undefined,
    }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitAttempted(true);

    const { errors: formErrors, payload } = validateProductForm(fields, mode);
    setErrors(formErrors);
    if (!payload) {
      return;
    }

    setBusy(true);
    const submitError =
      mode === 'create'
        ? await (onCreate?.(payload as CreateProductInput) ?? Promise.resolve<string | null>(null))
        : await (onUpdate?.(payload as UpdateProductInput) ?? Promise.resolve<string | null>(null));
    setBusy(false);

    if (submitError) {
      const mapped = mapProductServerError(submitError);
      if (mapped.field === 'form') {
        setErrors((prev) => ({ ...prev, form: mapped.message }));
      } else {
        setErrors((prev) => ({ ...prev, [mapped.field]: mapped.message }));
      }
    }
  }

  return (
    <form className="product-form" onSubmit={handleSubmit} noValidate>
      <h3>{mode === 'create' ? 'Add product' : `Edit ${product?.name ?? 'product'}`}</h3>

      <FormField
        label="Name"
        name="name"
        value={fields.name}
        onChange={(v) => setField('name', v)}
        onBlur={() => blurField('name')}
        error={shownError('name')}
      />
      <FormField
        label="Brand"
        name="brand"
        value={fields.brand}
        onChange={(v) => setField('brand', v)}
        onBlur={() => blurField('brand')}
        error={shownError('brand')}
      />
      <FormField
        label="Model"
        name="model"
        value={fields.model}
        onChange={(v) => setField('model', v)}
        onBlur={() => blurField('model')}
        error={shownError('model')}
      />

      <div className="form-field">
        <label htmlFor="condition">Condition</label>
        <select
          id="condition"
          value={fields.condition}
          onChange={(e) =>
            setFields((prev) => ({ ...prev, condition: e.target.value as ProductCondition }))
          }
        >
          {PRODUCT_CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {condition}
            </option>
          ))}
        </select>
      </div>

      <FormField
        label="Selling price (USD)"
        name="sellingPrice"
        value={fields.sellingPrice}
        onChange={(v) => setField('sellingPrice', v)}
        onBlur={() => blurField('sellingPrice')}
        error={shownError('sellingPrice')}
        inputMode="decimal"
        placeholder="599.00"
      />

      {mode === 'create' && (
        <FormField
          label="Starting quantity"
          name="quantity"
          value={fields.quantity}
          onChange={(v) => setField('quantity', v)}
          onBlur={() => blurField('quantity')}
          error={shownError('quantity')}
          inputMode="numeric"
        />
      )}

      <FormField
        label="Cost price (USD, optional)"
        name="costPrice"
        value={fields.costPrice}
        onChange={(v) => setField('costPrice', v)}
        onBlur={() => blurField('costPrice')}
        error={shownError('costPrice')}
        inputMode="decimal"
      />
      <FormField
        label="SKU (optional)"
        name="sku"
        value={fields.sku}
        onChange={(v) => setField('sku', v)}
        onBlur={() => blurField('sku')}
        error={shownError('sku')}
      />
      <FormField
        label="Barcode (optional)"
        name="barcode"
        value={fields.barcode}
        onChange={(v) => setField('barcode', v)}
        onBlur={() => blurField('barcode')}
        error={shownError('barcode')}
      />
      <FormField
        label="Low-stock threshold (optional)"
        name="lowStockThreshold"
        value={fields.lowStockThreshold}
        onChange={(v) => setField('lowStockThreshold', v)}
        onBlur={() => blurField('lowStockThreshold')}
        error={shownError('lowStockThreshold')}
        inputMode="numeric"
      />

      {errors.form && (
        <p className="product-form-error" role="alert">
          {errors.form}
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
