import { useMemo, useState } from 'react';
import type { InventoryAdjustmentInput, ProductRecord } from '../../../../shared/products';
import { FormField } from '../../components/FormField';
import {
  resultingQuantity,
  validateAdjustmentField,
  validateAdjustmentForm,
} from './formValidation';
import type { AdjustmentFieldName, AdjustmentFormErrors } from './formValidation';

/**
 * Adjust Stock flow (`POS_WORKFLOWS.md §12`).
 *
 * Separate from ordinary product editing. Shows the product, its current
 * authoritative stock, the adjustment (delta or target), the required reason,
 * and a resulting-quantity preview.
 *
 * Field-level validation (Phase 2B UX polish) runs on blur and again on submit
 * and mirrors the current trusted behaviour: a signed integer in delta mode, a
 * non-negative integer in target mode, no zero-change, and no result below
 * zero. The trusted layer still recomputes everything from the authoritative
 * quantity — this preview and these checks are advisory only.
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
  const [errors, setErrors] = useState<AdjustmentFormErrors>({});
  const [touched, setTouched] = useState<Partial<Record<AdjustmentFieldName, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = product.quantityOnHand;
  const fields = { mode, value, reason };

  const preview = useMemo(
    () => resultingQuantity({ mode, value }, current),
    [mode, value, current],
  );
  const previewInvalid = preview !== null && preview < 0;

  function shownError(field: AdjustmentFieldName): string | undefined {
    return touched[field] || submitAttempted ? errors[field] : undefined;
  }

  function revalidate(field: AdjustmentFieldName, nextFields: typeof fields) {
    setErrors((prev) => ({
      ...prev,
      [field]: validateAdjustmentField(field, nextFields, current) ?? undefined,
    }));
  }

  function changeValue(next: string) {
    setValue(next);
    if (touched.value || submitAttempted) {
      revalidate('value', { mode, value: next, reason });
    }
  }

  function changeReason(next: string) {
    setReason(next);
    if (touched.reason || submitAttempted) {
      revalidate('reason', { mode, value, reason: next });
    }
  }

  function changeMode(next: 'delta' | 'target') {
    setMode(next);
    if (touched.value || submitAttempted) {
      revalidate('value', { mode: next, value, reason });
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitAttempted(true);

    const { errors: formErrors, ok } = validateAdjustmentForm(fields, current);
    setErrors(formErrors);
    if (!ok) {
      return;
    }

    const input: InventoryAdjustmentInput =
      mode === 'delta'
        ? {
            productId: product.id,
            reason: reason.trim(),
            mode: 'delta',
            delta: Number(value.trim()),
          }
        : {
            productId: product.id,
            reason: reason.trim(),
            mode: 'target',
            targetQuantity: Number(value.trim()),
          };

    setBusy(true);
    const submitError = await onSubmit(input);
    setBusy(false);
    if (submitError) {
      setErrors((prev) => ({ ...prev, form: submitError }));
    }
  }

  return (
    <form className="adjust-stock" onSubmit={handleSubmit} noValidate>
      <h3>Adjust stock — {product.name}</h3>
      <p className="adjust-stock-current">
        Current stock: <strong>{current}</strong>
      </p>

      <fieldset>
        <legend>Adjustment type</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'delta'}
            onChange={() => changeMode('delta')}
          />
          Change by amount (e.g. +2 or -1)
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'target'}
            onChange={() => changeMode('target')}
          />
          Set to a new total
        </label>
      </fieldset>

      <FormField
        label={mode === 'delta' ? 'Change amount' : 'New total quantity'}
        name="adjustment-value"
        value={value}
        onChange={changeValue}
        onBlur={() => {
          setTouched((prev) => ({ ...prev, value: true }));
          revalidate('value', fields);
        }}
        error={shownError('value')}
        inputMode={mode === 'delta' ? 'text' : 'numeric'}
      />

      <FormField
        label="Reason"
        name="adjustment-reason"
        value={reason}
        onChange={changeReason}
        onBlur={() => {
          setTouched((prev) => ({ ...prev, reason: true }));
          revalidate('reason', fields);
        }}
        error={shownError('reason')}
      />

      {preview !== null && (
        <p
          className={`adjust-stock-preview${previewInvalid ? ' adjust-stock-preview-invalid' : ''}`}
          role={previewInvalid ? 'alert' : undefined}
        >
          Resulting quantity: <strong>{preview}</strong>
          {previewInvalid && ' — stock cannot go below zero'}
        </p>
      )}

      {errors.form && (
        <p className="product-form-error" role="alert">
          {errors.form}
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
