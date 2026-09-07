import { useEffect, useState } from 'react';
import type { AppInfo, NativeSqliteCheckResult } from '../../shared/ipc';

/**
 * Intentionally minimal foundation renderer.
 *
 * It shows only that the application shell is running. The small
 * "foundation status" block below exercises the typed IPC bridge end to end
 * (renderer -> preload -> main -> better-sqlite3) so the scaffold's wiring is
 * visible; it is not POS UI and carries no business behavior.
 */

type FoundationState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: AppInfo; readonly sqlite: NativeSqliteCheckResult }
  | { readonly kind: 'error'; readonly message: string };

export function App() {
  const [state, setState] = useState<FoundationState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;

    void Promise.all([window.pos.app.getInfo(), window.pos.diagnostics.checkNativeSqlite()])
      .then(([info, sqlite]) => {
        if (active) {
          setState({ kind: 'ready', info, sqlite });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="app">
      <h1>Go Phones POS</h1>
      <p>Application foundation initialized.</p>
      <FoundationStatus state={state} />
    </main>
  );
}

function FoundationStatus({ state }: { state: FoundationState }) {
  if (state.kind === 'loading') {
    return <p className="foundation-status">Checking foundation&hellip;</p>;
  }

  if (state.kind === 'error') {
    return <p className="foundation-status">Foundation check failed: {state.message}</p>;
  }

  const { info, sqlite } = state;

  return (
    <section className="foundation-status">
      <strong>Foundation status</strong>
      <dl>
        <dt>App</dt>
        <dd>
          {info.name} {info.version}
        </dd>
        <dt>Runtime</dt>
        <dd>
          Electron {info.electron} &middot; Chromium {info.chrome} &middot; Node {info.node}
        </dd>
        <dt>Mode</dt>
        <dd>{info.packaged ? 'packaged' : 'development'}</dd>
        <dt>SQLite (main process)</dt>
        <dd>
          {sqlite.ok
            ? `ok — ${sqlite.sqliteVersion} (${sqlite.journalMode}, backup API ${
                sqlite.hasBackupApi ? 'present' : 'missing'
              })`
            : `unavailable — ${sqlite.error}`}
        </dd>
      </dl>
    </section>
  );
}
