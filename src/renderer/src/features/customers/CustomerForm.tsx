import { useState } from 'react';
import type { CustomerRecord } from '../../../../shared/customers';
import { FormField } from '../../components/FormField';
import {
  mapCustomerServerError,
  validateCustomerField,
  validateCustomerForm,
} from './customerFormValidation';
import type {
  CustomerFieldName,
  CustomerFormErrors,
  CustomerFormFields,
} from './customerFormValidation';

/**
 * Add / edit customer form (`POS_WORKFLOWS.md §25`, `REQ-CUST-001`).
 *
 * Name is required; phone is optional and free-form. Field-level validation
 * runs on blur and again on submit and never fires on an untouched field. It is
 * not authoritative — `customerValidation.ts` and the SQLite constraints remain
 * the source of truth; a trusted-layer failure that maps to a field is shown
 * next to that input.
 */

function initialFields(customer?: CustomerRecord): CustomerFormFields {
  return { name: customer?.name ?? '', phone: customer?.phone ?? '' };
}

export interface CustomerFormProps {
  readonly mode: 'create' | 'edit';
  readonly customer?: CustomerRecord;
  readonly onSubmit: (fields: { name: string; phone: string | null }) => Promise<string | null>;
  readonly onCancel: () => void;
}

export function CustomerForm({ mode, customer, onSubmit, onCancel }: CustomerFormProps) {
  const [fields, setFields] = useState<CustomerFormFields>(() => initialFields(customer));
  const [errors, setErrors] = useState<CustomerFormErrors>({});
  const [touched, setTouched] = useState<Partial<Record<CustomerFieldName, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  function shownError(field: CustomerFieldName): string | undefined {
    return touched[field] || submitAttempted ? errors[field] : undefined;
  }

  function setField(field: CustomerFieldName, value: string) {
    const next = { ...fields, [field]: value };
    setFields(next);
    if (touched[field] || submitAttempted) {
      setErrors((prev) => ({ ...prev, [field]: validateCustomerField(field, next) ?? undefined }));
    } else if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  function blurField(field: CustomerFieldName) {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setErrors((prev) => ({ ...prev, [field]: validateCustomerField(field, fields) ?? undefined }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitAttempted(true);

    const { errors: formErrors, ok, payload } = validateCustomerForm(fields);
    setErrors(formErrors);
    if (!ok) {
      return;
    }

    setBusy(true);
    const submitError = await onSubmit({ name: payload.name, phone: payload.phone });
    setBusy(false);

    if (submitError) {
      const mapped = mapCustomerServerError(submitError);
      if (mapped.field === 'form') {
        setErrors((prev) => ({ ...prev, form: mapped.message }));
      } else {
        setTouched((prev) => ({ ...prev, [mapped.field]: true }));
        setErrors((prev) => ({ ...prev, [mapped.field]: mapped.message }));
      }
    }
  }

  return (
    <form className="customer-form product-form" onSubmit={handleSubmit} noValidate>
      <h3>{mode === 'create' ? 'Add customer' : `Edit ${customer?.name ?? 'customer'}`}</h3>

      <FormField
        label="Name"
        name="customer-name"
        value={fields.name}
        onChange={(v) => setField('name', v)}
        onBlur={() => blurField('name')}
        error={shownError('name')}
      />
      <FormField
        label="Phone (optional)"
        name="customer-phone"
        value={fields.phone}
        onChange={(v) => setField('phone', v)}
        onBlur={() => blurField('phone')}
        error={shownError('phone')}
        inputMode="text"
        hint="Any format is fine — e.g. (281) 824-0001. Leave blank for a name-only customer."
      />

      {errors.form && (
        <p className="product-form-error" role="alert">
          {errors.form}
        </p>
      )}

      <div className="product-form-actions">
        <button type="submit" disabled={busy}>
          {mode === 'create' ? 'Create customer' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
