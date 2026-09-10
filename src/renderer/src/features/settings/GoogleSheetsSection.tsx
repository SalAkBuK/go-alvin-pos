import { useCallback, useEffect, useState } from 'react';
import type { GoogleConfig } from '../../../../shared/google';
import type { IpcResult } from '../../../../shared/products';
import {
  canToggleEnabled,
  describeConnection,
  describeLastSync,
  describeSync,
  describeUnavailable,
  googleView,
} from './googleConfig';

/**
 * Settings → Google Sheets (`PRODUCT_SCOPE.md §22.8`; `POS_WORKFLOWS.md §71`-
 * `§72`; `REQ-GSHEET-016`-`REQ-GSHEET-019`).
 *
 * One-click `Connect Google Account`. No credential JSON picker, no spreadsheet
 * ID field, no worksheet-name fields, no service-account email. The renderer
 * calls only the narrow `window.pos.google.*` surface and receives sanitized
 * status; the OAuth flow runs entirely in the main process (system browser).
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setLoadError('Google Sheets settings are unavailable in this context.');
      return;
    }
    try {
      setConfig(await unwrap(api.google.getConfig()));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<GoogleConfig | void>, successNotice: string | null) => {
      setBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        const next = await action();
        if (next) {
          setConfig(next);
        } else {
          await load();
        }
        if (successNotice) {
          setNotice(successNotice);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const onConnect = useCallback(
    () =>
      void run(async () => {
        const api = pos();
        if (!api) {
          throw new Error('Google Sheets settings are unavailable in this context.');
        }
        return unwrap(api.google.connect());
      }, 'Google account connected.'),
    [run],
  );

  const onRetrySetup = useCallback(
    () =>
      void run(async () => {
        const api = pos();
        if (!api) {
          throw new Error('Google Sheets settings are unavailable in this context.');
        }
        return unwrap(api.google.retrySetup());
      }, 'Retried spreadsheet setup.'),
    [run],
  );

  const onDisconnect = useCallback(
    () =>
      void run(async () => {
        const api = pos();
        if (!api) {
          throw new Error('Google Sheets settings are unavailable in this context.');
        }
        return unwrap(api.google.disconnect());
      }, 'Google account disconnected. Pending exports are still saved locally.'),
    [run],
  );

  const onOpenSpreadsheet = useCallback(
    () =>
      void run(async () => {
        const api = pos();
        if (!api) {
          throw new Error('Google Sheets settings are unavailable in this context.');
        }
        await unwrap(api.google.openSpreadsheet());
      }, null),
    [run],
  );

  const onToggleEnabled = useCallback(
    (enabled: boolean) =>
      void run(
        async () => {
          const api = pos();
          if (!api) {
            throw new Error('Google Sheets settings are unavailable in this context.');
          }
          return unwrap(api.google.setEnabled({ enabled }));
        },
        enabled ? 'Export turned on.' : 'Export paused.',
      ),
    [run],
  );

  const view = googleView(config);

  return (
    <section className="settings-page google-sheets-settings">
      <h3>Google Sheets</h3>
      <p className="field-hint">
        Automatically keep a copy of your POS sales in your Google account. Google Sheets is a
        secondary copy — the local database is always authoritative, and a Google problem never
        affects a sale.
      </p>

      {loadError && (
        <p className="product-form-error" role="alert">
          {loadError}
        </p>
      )}

      {view === 'unavailable' && (
        <p className="product-form-error" role="alert">
          {describeUnavailable(config)}
        </p>
      )}

      {(view === 'disconnected' || view === 'setup-incomplete' || view === 'ready') && (
        <dl className="settings-current">
          <div>
            <dt>Connection</dt>
            <dd>{describeConnection(config)}</dd>
          </div>
          {view === 'ready' && (
            <>
              <div>
                <dt>Sales spreadsheet</dt>
                <dd>{config?.spreadsheetName ?? 'Go Phones POS Sales'}</dd>
              </div>
              <div>
                <dt>Sync</dt>
                <dd>{describeSync(config)}</dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>{describeLastSync(config)}</dd>
              </div>
            </>
          )}
          {view === 'setup-incomplete' && (
            <div>
              <dt>Setup</dt>
              <dd>{config?.setupIncompleteReason ?? 'Sales spreadsheet setup is not finished.'}</dd>
            </div>
          )}
        </dl>
      )}

      {actionError && (
        <p className="product-form-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}

      <div className="product-form-actions">
        {(view === 'disconnected' || view === 'loading') && (
          <button type="button" onClick={onConnect} disabled={busy || view === 'loading'}>
            Connect Google Account
          </button>
        )}
        {view === 'setup-incomplete' && (
          <>
            <button type="button" onClick={onRetrySetup} disabled={busy}>
              Retry Setup
            </button>
            <button type="button" onClick={onDisconnect} disabled={busy}>
              Disconnect Google Account
            </button>
          </>
        )}
        {view === 'ready' && (
          <>
            <button type="button" onClick={onOpenSpreadsheet} disabled={busy}>
              Open Spreadsheet
            </button>
            {canToggleEnabled(config) && (
              <button
                type="button"
                onClick={() => onToggleEnabled(!(config?.enabled ?? false))}
                disabled={busy}
              >
                {config?.enabled ? 'Pause export' : 'Turn export on'}
              </button>
            )}
            <button type="button" onClick={onDisconnect} disabled={busy}>
              Disconnect Google Account
            </button>
          </>
        )}
      </div>
    </section>
  );
}
