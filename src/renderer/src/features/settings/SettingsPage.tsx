import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type { TaxRateConfig } from '../../../../shared/settings';
import { FormField } from '../../components/FormField';
import { BusinessConfigSection } from './BusinessConfigSection';
import { GoogleSheetsSection } from './GoogleSheetsSection';
import { PrinterSettingsSection } from './PrinterSettingsSection';
import { ReconciliationQueueSection } from './ReconciliationQueueSection';
import { formatBpsAsPercent, parsePercentToBps, validateTaxRatePercent } from './taxRate';

/**
 * Settings area — Phase 2D.1 (Tax Rate) + Phase 2D.2 (Business & Receipt).
 *
 * The minimum needed to make a real sale possible on a fresh install: a
 * configured sales-tax rate and the business/receipt values a completed sale
 * freezes into its snapshots. Nothing else lives here — printer, Google Sheets,
 * credentials, backups and diagnostics are each their own later slice.
 *
 * All persistence goes through `window.pos.settings.*` — the narrow typed
 * surface. The renderer never sees SQLite and cannot write an arbitrary
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

/** The "Current:" line. Exported for direct testing (this suite has no jsdom). */
export function describeCurrent(config: TaxRateConfig | null): string {
  if (config === null) {
    return 'Loading…';
  }
  return config.configured ? formatBpsAsPercent(config.taxRateBps) : 'Not configured';
}

export function SettingsPage() {
  const [config, setConfig] = useState<TaxRateConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Settings are unavailable in this context.');
      return;
    }
    try {
      const current = await unwrap(api.settings.tax.get());
      setConfig(current);
      setLoadError(null);
      if (current.configured) {
        setValue(formatBpsAsPercent(current.taxRateBps).replace('%', ''));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shownFieldError = touched || submitAttempted ? fieldError : undefined;

  const onChange = useCallback(
    (next: string) => {
      setValue(next);
      setNotice(null);
      setFormError(null);
      if (touched || submitAttempted) {
        setFieldError(validateTaxRatePercent(next) ?? undefined);
      }
    },
    [touched, submitAttempted],
  );

  const onBlur = useCallback(() => {
    setTouched(true);
    setFieldError(validateTaxRatePercent(value) ?? undefined);
  }, [value]);

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSubmitAttempted(true);
      setNotice(null);
      setFormError(null);

      const message = validateTaxRatePercent(value);
      if (message) {
        setFieldError(message);
        return;
      }

      const api = pos();
      if (!api) {
        setFormError('Settings are unavailable in this context.');
        return;
      }

      setBusy(true);
      try {
        const taxRateBps = parsePercentToBps(value);
        const updated = await unwrap(api.settings.tax.update({ taxRateBps }));
        setConfig(updated);
        setFieldError(undefined);
        if (updated.configured) {
          setNotice(`Tax rate saved. Checkout now uses ${formatBpsAsPercent(updated.taxRateBps)}.`);
          setValue(formatBpsAsPercent(updated.taxRateBps).replace('%', ''));
        }
      } catch (error) {
        setFormError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [value],
  );

  return (
    <>
      <section className="settings-page">
        <h3>Tax Rate</h3>

        {loadError && (
          <p className="product-form-error" role="alert">
            {loadError}
          </p>
        )}

        <dl className="settings-current">
          <div>
            <dt>Current</dt>
            <dd>{describeCurrent(config)}</dd>
          </div>
        </dl>

        {config !== null && !config.configured && (
          <p className="field-hint">
            Checkout review cannot calculate tax until a rate is configured here. Enter your store’s
            sales-tax rate to continue.
          </p>
        )}

        <form className="settings-form" onSubmit={onSubmit} noValidate>
          <FormField
            label="Sales-tax rate (%)"
            name="taxRatePercent"
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            error={shownFieldError}
            hint="Percentage with up to two decimals, e.g. 8.25"
            inputMode="decimal"
            placeholder="8.25"
          />

          {formError && (
            <p className="product-form-error" role="alert">
              {formError}
            </p>
          )}
          {notice && (
            <p className="products-notice" role="status">
              {notice}
            </p>
          )}

          <div className="product-form-actions">
            <button type="submit" disabled={busy}>
              {config?.configured ? 'Save tax rate' : 'Set tax rate'}
            </button>
          </div>
        </form>
      </section>

      <BusinessConfigSection />
      <PrinterSettingsSection />
      <GoogleSheetsSection />
      <ReconciliationQueueSection />
    </>
  );
}
