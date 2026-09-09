import { useCallback, useEffect, useState } from 'react';
import type { GoogleConfig } from '../../../../shared/google';
import type { IpcResult } from '../../../../shared/products';
import { FormField } from '../../components/FormField';
import {
  describeConnection,
  describeExportState,
  describeLastSync,
  describeQueue,
  fieldsFromConfig,
  validateGoogleForm,
} from './googleConfig';
import type { GoogleFormFields } from './googleConfig';

/**
 * Settings → Google Sheets (`PRODUCT_SCOPE.md §22.8`; `POS_WORKFLOWS.md §71`-
 * `§72`; `REQ-GSHEET-011`-`REQ-GSHEET-013`; `task §8`).
 *
 * Non-secret configuration + the connect/disconnect lifecycle, all through the
 * narrow `window.pos.google.*` surface. The renderer never receives a private
 * key, token, `Authorization` header, or the encrypted blob. If OS secure
 * storage is unavailable the section says so and offers no plaintext path. A
 * disconnected / unconfigured integration never blocks a sale.
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

export function GoogleSheetsSection() {
  const [config, setConfig] = useState<GoogleConfig | null>(null);
  const [fields, setFields] = useState<GoogleFormFields>(fieldsFromConfig(null));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Google Sheets settings are unavailable in this context.');
      return;
    }
    try {
      const current = await unwrap(api.google.getConfig());
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

  const onSave = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setNotice(null);
      setFormError(null);
      const result = validateGoogleForm(fields);
      if (!result.payload) {
        setFieldErrors(result.errors as Record<string, string>);
        return;
      }
      setFieldErrors({});
      const api = pos();
      if (!api) {
        setFormError('Google Sheets settings are unavailable in this context.');
        return;
      }
      setBusy(true);
      try {
        const updated = await unwrap(api.google.updateConfig(result.payload));
        setConfig(updated);
        setFields(fieldsFromConfig(updated));
        setNotice('Google Sheets settings saved.');
      } catch (error) {
        setFormError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [fields],
  );

  const onConnect = useCallback(async () => {
    const api = pos();
    if (!api) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setFormError(null);
    try {
      const result = await unwrap(api.google.connect());
      setNotice(`Connected Google service account ${result.serviceAccountEmail}.`);
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const onDisconnect = useCallback(async () => {
    const api = pos();
    if (!api) {
      return;
    }
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Disconnect the Google service account?')
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setFormError(null);
    try {
      const updated = await unwrap(api.google.disconnect());
      setConfig(updated);
      setFields(fieldsFromConfig(updated));
      setNotice('Google service account disconnected. Pending exports are still saved locally.');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const secureStorageUnavailable = config !== null && !config.secureStorageAvailable;

  return (
    <section className="settings-page google-sheets-settings">
      <h3>Google Sheets</h3>
      <p className="field-hint">
        One-way export of completed sales to a Google Sheet you share with a service account. Google
        Sheets is a secondary copy — the local database is always authoritative, and a Google
        problem never affects a sale.
      </p>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      <dl className="settings-current">
        <div>
          <dt>Connection</dt>
          <dd>{describeConnection(config)}</dd>
        </div>
        <div>
          <dt>Export</dt>
          <dd>{describeExportState(config)}</dd>
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{describeLastSync(config)}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>{config ? describeQueue(config.queue) : '—'}</dd>
        </div>
      </dl>

      {secureStorageUnavailable ? (
        <p className="product-form-error" role="alert">
          Google Sheets credentials cannot be stored securely on this device.
        </p>
      ) : (
        <div className="product-form-actions">
          <button type="button" onClick={() => void onConnect()} disabled={busy}>
            {config?.connected ? 'Replace service account…' : 'Connect service account…'}
          </button>
          {config?.connected && (
            <button type="button" onClick={() => void onDisconnect()} disabled={busy}>
              Disconnect
            </button>
          )}
        </div>
      )}

      <form className="settings-form" onSubmit={(e) => void onSave(e)} noValidate>
        <label className="google-enabled-toggle">
          <input
            type="checkbox"
            checked={fields.enabled}
            onChange={(e) => setFields((f) => ({ ...f, enabled: e.target.checked }))}
          />
          Enable Google Sheets export
        </label>

        <FormField
          label="Spreadsheet ID or URL"
          name="googleSpreadsheetId"
          value={fields.spreadsheetId}
          onChange={(value) => setFields((f) => ({ ...f, spreadsheetId: value }))}
          onBlur={() => undefined}
          error={fieldErrors['spreadsheetId']}
          hint="Paste the sheet URL or just the ID (the part after /d/)."
        />
        <FormField
          label="Sales worksheet name"
          name="googleSalesSheet"
          value={fields.salesSheetName}
          onChange={(value) => setFields((f) => ({ ...f, salesSheetName: value }))}
          onBlur={() => undefined}
          error={fieldErrors['salesSheetName']}
        />
        <FormField
          label="Sale Items worksheet name"
          name="googleSaleItemsSheet"
          value={fields.saleItemsSheetName}
          onChange={(value) => setFields((f) => ({ ...f, saleItemsSheetName: value }))}
          onBlur={() => undefined}
          error={fieldErrors['saleItemsSheetName']}
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
            Save Google Sheets settings
          </button>
        </div>
      </form>
    </section>
  );
}
