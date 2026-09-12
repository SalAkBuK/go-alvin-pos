import { useEffect, useState } from 'react';
import type {
  ActivityHistory,
  ActivityHistoryEntry,
  ActivityHistorySeverity,
} from '../../../../shared/activityHistory';
import type { IpcResult } from '../../../../shared/products';
import { formatDiagnosticTimestamp } from './SupportDiagnosticsSection';

/**
 * Settings → Support & Diagnostics → Recent Activity (`REQ-DIAG-002`;
 * `PRODUCT_SCOPE.md §33`; `POS_WORKFLOWS.md §94` step 1).
 *
 * Renders only the pre-sanitized, plain-language `ActivityHistoryEntry` DTO
 * the main process returns — never a raw log line, stack trace, or path.
 * Placed above `Report a Problem` so recent activity is visible before the
 * user describes what happened, without requiring the report to reference it.
 */

export const ACTIVITY_HISTORY_ERROR_MESSAGE =
  'Recent activity could not be loaded right now. Your saved sales are unaffected.';
export const ACTIVITY_HISTORY_EMPTY_MESSAGE = 'No recent issues or activity to show.';

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') return null;
  return window.pos;
}

function severityLabel(severity: ActivityHistorySeverity): string {
  switch (severity) {
    case 'ERROR':
      return 'Needs attention';
    case 'WARNING':
      return 'Notice';
    case 'INFO':
      return 'Info';
  }
}

export interface ActivityHistoryFetchCallbacks {
  readonly onLoadingChange: (loading: boolean) => void;
  readonly onEntries: (entries: readonly ActivityHistoryEntry[]) => void;
  readonly onError: (message: string | null) => void;
}

/**
 * One guarded fetch action, shared by the component and its tests (same shape
 * as `createManualDiagnosticsAction` in `SupportDiagnosticsSection.tsx`). The
 * fixed error text never echoes a rejected IPC payload or thrown exception, so
 * a path, stack, or secret cannot become UI copy.
 */
export function createActivityHistoryFetchAction(
  invoke: () => Promise<IpcResult<ActivityHistory>>,
  callbacks: ActivityHistoryFetchCallbacks,
): { run: () => Promise<void> } {
  return {
    run: async () => {
      callbacks.onLoadingChange(true);
      callbacks.onError(null);
      try {
        const result = await invoke();
        if (!result.ok) throw new Error('activity history unavailable');
        callbacks.onEntries(result.data.entries);
      } catch {
        callbacks.onError(ACTIVITY_HISTORY_ERROR_MESSAGE);
      } finally {
        callbacks.onLoadingChange(false);
      }
    },
  };
}

export interface ActivityHistoryListProps {
  readonly entries: readonly ActivityHistoryEntry[];
}

export function ActivityHistoryList({ entries }: ActivityHistoryListProps) {
  if (entries.length === 0) {
    return <p role="status">{ACTIVITY_HISTORY_EMPTY_MESSAGE}</p>;
  }
  return (
    <ul className="activity-history-list">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={`activity-history-item activity-history-${entry.severity.toLowerCase()}`}
        >
          <div className="activity-history-item-header">
            <span
              className={`activity-history-badge activity-history-badge-${entry.severity.toLowerCase()}`}
            >
              {severityLabel(entry.severity)}
            </span>
            <time dateTime={entry.timestamp}>{formatDiagnosticTimestamp(entry.timestamp)}</time>
          </div>
          <p className="activity-history-title">{entry.title}</p>
          <p className="activity-history-detail">{entry.detail}</p>
          {(entry.receiptNumber ?? entry.errorCode) && (
            <p className="activity-history-meta">
              {entry.receiptNumber && <span>Receipt {entry.receiptNumber}</span>}
              {entry.receiptNumber && entry.errorCode && ' · '}
              {entry.errorCode && <span>Error code: {entry.errorCode}</span>}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ActivityHistorySection() {
  const [entries, setEntries] = useState<readonly ActivityHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const action = createActivityHistoryFetchAction(
      async () => {
        const api = pos();
        if (!api) throw new Error('unavailable');
        return api.support.getActivityHistory();
      },
      {
        onLoadingChange: (value) => {
          if (active) setLoading(value);
        },
        onEntries: (value) => {
          if (active) setEntries(value);
        },
        onError: (value) => {
          if (active) setError(value);
        },
      },
    );
    void action.run();
    return () => {
      active = false;
    };
  }, []);

  return (
    <section
      className="diagnostics-subsection activity-history"
      aria-labelledby="activity-history-heading"
    >
      <h4 id="activity-history-heading">Recent Activity</h4>
      <p className="field-hint">
        Recent sale, printing, backup, and export activity in plain language. This does not show
        file paths, credentials, or raw technical logs.
      </p>
      {loading && <p role="status">Loading recent activity...</p>}
      {!loading && error && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && entries !== null && <ActivityHistoryList entries={entries} />}
    </section>
  );
}
