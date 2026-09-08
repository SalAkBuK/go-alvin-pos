import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type { BusinessConfig } from '../../../../shared/settings';
import { FormField } from '../../components/FormField';
import {
  describeMissing,
  fieldsFromConfig,
  validateBusinessField,
  validateBusinessForm,
} from './businessConfig';
import type { BusinessFieldName, BusinessFormErrors, BusinessFormFields } from './businessConfig';

/**
 * Settings → Business & Receipt (Phase 2D.2).
 *
 * The store identity and receipt-policy values a completed sale will freeze
 * into its snapshots (`DATA_MODEL.md §44-49`). Business name is the canonically
 * fixed identity and is shown read-only; address and phone are required;
 * disclaimer and footer may be left blank.
 *
 * All persistence goes through `window.pos.settings.business.*` — the narrow
 * typed surface. The renderer never sees SQLite and cannot write an arbitrary
 * setting key.
 */

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

const EMPTY_FIELDS: BusinessFormFields = {
  businessAddress: '',
  businessPhone: '',
  receiptDisclaimer: '',
  receiptFooter: '',
};

/** The "Status:" line. Exported for direct testing (this suite has no jsdom). */
export function describeBusinessStatus(config: BusinessConfig | null): string {
  if (config === null) {
    return 'Loading…';
  }
  return config.configured ? 'Configured' : 'Incomplete';
}

export function BusinessConfigSection() {
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fields, setFields] = useState<BusinessFormFields>(EMPTY_FIELDS);
  const [errors, setErrors] = useState<BusinessFormErrors>({});
  const [touched, setTouched] = useState<Partial<Record<BusinessFieldName, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Settings are unavailable in this context.');
      return;
    }
    try {
      const current = await unwrap(api.settings.business.get());
      setConfig(current);
      setFields(fieldsFromConfig(current));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function shownError(field: BusinessFieldName): string | undefined {
    return touched[field] || submitAttempted ? errors[field] : undefined;
  }

  const setField = useCallback(
    (field: BusinessFieldName, value: string) => {
      setNotice(null);
      const next = { ...fields, [field]: value };
      setFields(next);
      if (touched[field] || submitAttempted) {
        setErrors((prev) => ({
          ...prev,
          [field]: validateBusinessField(field, next) ?? undefined,
        }));
      }
    },
    [fields, touched, submitAttempted],
  );

  const blurField = useCallback(
    (field: BusinessFieldName) => {
      setTouched((prev) => ({ ...prev, [field]: true }));
      setErrors((prev) => ({
        ...prev,
        [field]: validateBusinessField(field, fields) ?? undefined,
      }));
    },
    [fields],
  );

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSubmitAttempted(true);
      setNotice(null);

      const { errors: formErrors, payload } = validateBusinessForm(fields);
      setErrors(formErrors);
      if (!payload) {
        return;
      }

      const api = pos();
      if (!api) {
        setErrors((prev) => ({ ...prev, form: 'Settings are unavailable in this context.' }));
        return;
      }

      setBusy(true);
      try {
        const updated = await unwrap(api.settings.business.update(payload));
        setConfig(updated);
        setFields(fieldsFromConfig(updated));
        setErrors({});
        setNotice(
          updated.configured
            ? 'Business and receipt details saved.'
            : 'Saved. Enter the remaining required details to finish setup.',
        );
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          form: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setBusy(false);
      }
    },
    [fields],
  );

  const missingText = config ? describeMissing(config) : null;

  return (
    <section className="settings-page">
      <h3>Business &amp; Receipt</h3>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      <dl className="settings-current">
        <div>
          <dt>Status</dt>
          <dd>{describeBusinessStatus(config)}</dd>
        </div>
        <div>
          <dt>Business name</dt>
          <dd>{config ? config.businessName : '—'}</dd>
        </div>
      </dl>

      {missingText && (
        <p className="field-hint" role="status">
          {missingText}
        </p>
      )}

      <form className="settings-form" onSubmit={onSubmit} noValidate>
        <p className="field-hint">
          Business name is fixed for this store and appears on every receipt. Address and phone are
          required; the disclaimer and footer may be left blank.
        </p>

        <FormField
          label="Business address"
          name="businessAddress"
          value={fields.businessAddress}
          onChange={(v) => setField('businessAddress', v)}
          onBlur={() => blurField('businessAddress')}
          error={shownError('businessAddress')}
          multiline
          rows={2}
        />
        <FormField
          label="Business phone"
          name="businessPhone"
          value={fields.businessPhone}
          onChange={(v) => setField('businessPhone', v)}
          onBlur={() => blurField('businessPhone')}
          error={shownError('businessPhone')}
          inputMode="text"
        />
        <FormField
          label="Receipt disclaimer (optional)"
          name="receiptDisclaimer"
          value={fields.receiptDisclaimer}
          onChange={(v) => setField('receiptDisclaimer', v)}
          onBlur={() => blurField('receiptDisclaimer')}
          error={shownError('receiptDisclaimer')}
          hint="Return / warranty / policy text approved for the store. May be left blank."
          multiline
          rows={4}
        />
        <FormField
          label="Receipt footer / thank-you message (optional)"
          name="receiptFooter"
          value={fields.receiptFooter}
          onChange={(v) => setField('receiptFooter', v)}
          onBlur={() => blurField('receiptFooter')}
          error={shownError('receiptFooter')}
          multiline
          rows={2}
        />

        {errors.form && (
          <p className="product-form-error" role="alert">
            {errors.form}
          </p>
        )}
        {notice && (
          <p className="products-notice" role="status">
            {notice}
          </p>
        )}

        <div className="product-form-actions">
          <button type="submit" disabled={busy}>
            Save business details
          </button>
        </div>
      </form>
    </section>
  );
}
