import { useMemo, useState } from 'react';
import type { InventoryAdjustmentInput, ProductRecord } from '../../../../shared/products';
import { parseIntegerField, parseSignedInteger } from './money';

/**
 * Adjust Stock flow (`POS_WORKFLOWS.md §12`).
 *
 * Separate from ordinary product editing. Shows the product, its current
 * authoritative stock, the adjustment (delta or target), the required reason,
 * and a resulting-quantity preview. The trusted layer still recomputes from the
 * authoritative quantity — this preview is advisory only.
 */

export interface AdjustStockPanelProps {
  readonly product: ProductRecord;
  readonly onSubmit: (input: InventoryAdjustmentInput) => Promise<string | null>;
  readonly onCancel: () => void;
}

export function AdjustStockPanel({ product, onSubmit, onCancel }: AdjustStockPanelProps) {
  const [mode, setMode] = useState<'delta' | 'target'>('delta');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    try {
      if (value.trim() === '') {
        return null;
      }
      if (mode === 'delta') {
        return product.quantityOnHand + parseSignedInteger(value);
      }
      return parseIntegerField(value);
    } catch {
      return null;
    }
  }, [mode, value, product.quantityOnHand]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let input: InventoryAdjustmentInput;
    try {
      if (reason.trim() === '') {
        throw new Error('A reason is required.');
      }
      input =
        mode === 'delta'
          ? {
              productId: product.id,
              reason: reason.trim(),
              mode: 'delta',
              delta: parseSignedInteger(value),
            }
          : {
              productId: product.id,
              reason: reason.trim(),
              mode: 'target',
              targetQuantity: parseIntegerField(value) ?? 0,
            };
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }

    setBusy(true);
    const submitError = await onSubmit(input);
    setBusy(false);
    if (submitError) {
      setError(submitError);
    }
  }

  return (
    <form className="adjust-stock" onSubmit={handleSubmit}>
      <h3>Adjust stock — {product.name}</h3>
      <p className="adjust-stock-current">
        Current stock: <strong>{product.quantityOnHand}</strong>
      </p>

      <fieldset>
        <legend>Adjustment type</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'delta'}
            onChange={() => setMode('delta')}
          />
          Change by amount (e.g. +2 or -1)
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'target'}
            onChange={() => setMode('target')}
          />
          Set to a new total
        </label>
      </fieldset>

      <label>
        {mode === 'delta' ? 'Change amount' : 'New total quantity'}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={mode === 'delta' ? 'text' : 'numeric'}
          required
        />
      </label>

      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>

      {preview !== null && (
        <p className="adjust-stock-preview">
          Resulting quantity: <strong>{preview}</strong>
          {preview < 0 && ' — cannot go below zero'}
        </p>
      )}

      {error && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}

      <div className="product-form-actions">
        <button type="submit" disabled={busy}>
          Apply adjustment
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
