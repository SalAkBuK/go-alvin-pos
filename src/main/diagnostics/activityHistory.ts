import type { ContextLogger, LogRecord } from '../app/logger';
import { collectRecentSanitizedLogRecords } from '../support/recentLogs';
import type { ActivityHistory, ActivityHistoryEntry } from '../../shared/activityHistory';

/**
 * Friendly activity/error history (`REQ-DIAG-002`; `PRODUCT_SCOPE.md §33`;
 * `POS_WORKFLOWS.md §94` step 1).
 *
 * This is NOT a second diagnostic logging system: it reads the SAME bounded,
 * rotating Phase 2M-A log files through `collectRecentSanitizedLogRecords`
 * (already sanitized once), then applies a second, narrower, explicit
 * allowlist that maps only known-safe `(event)` names into plain-language
 * copy. Any event not in the allowlist below is silently omitted — unmapped
 * technical events never reach the friendly feed, and no field from a raw
 * `context` object is ever forwarded verbatim.
 */

export const ACTIVITY_HISTORY_MAX_ENTRIES = 20;
/** Raw structured records considered before mapping/filtering — bounded so this can never scan unlimited log history. */
export const ACTIVITY_HISTORY_MAX_RECORDS_SCANNED = 300;

export interface ActivityHistoryServiceOptions {
  readonly logsRoot: string;
  readonly logger: ContextLogger;
  readonly now?: () => Date;
}

export interface ActivityHistoryService {
  getRecent(): Promise<ActivityHistory>;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function formatAvailableBytes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const gibibytes = value / 1024 ** 3;
  if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
  return `${Math.round(value / 1024 ** 2)} MB`;
}

/**
 * The explicit, narrow allowlist. Only events handled here can ever appear in
 * the friendly feed; everything else returns `null` and is dropped.
 */
function mapRecord(record: LogRecord, id: string): ActivityHistoryEntry | null {
  const receiptNumber = safeString(record.correlationIds?.receiptNumber);
  const errorCode = safeString(record.errorCode ?? null);
  const base = { id, timestamp: record.timestamp };

  switch (record.event) {
    case 'checkout.completed':
      return {
        ...base,
        severity: 'INFO',
        title: 'Sale completed',
        detail: receiptNumber
          ? `Sale ${receiptNumber} was completed and saved.`
          : 'A sale was completed and saved.',
        ...(receiptNumber ? { receiptNumber } : {}),
      };

    case 'checkout.failed':
      return errorCode === 'CARD_LOCAL_COMMIT_FAILURE'
        ? {
            ...base,
            severity: 'ERROR',
            title: 'A card charge may need review',
            detail:
              'A card charge may have been approved, but the sale could not be saved locally. Check the Reconciliation Queue and Clover directly.',
            ...(errorCode ? { errorCode } : {}),
          }
        : {
            ...base,
            severity: 'ERROR',
            title: 'A sale could not be saved',
            detail: 'The sale could not be completed. No sale was recorded for this attempt.',
            ...(errorCode ? { errorCode } : {}),
          };

    case 'checkout.validation_failed':
      return {
        ...base,
        severity: 'WARNING',
        title: 'A sale attempt was stopped',
        detail:
          'The sale could not be completed due to a validation problem. No sale was recorded.',
        ...(errorCode ? { errorCode } : {}),
      };

    case 'printing.failed':
      return {
        ...base,
        severity: 'WARNING',
        title: 'Receipt could not be printed',
        detail: 'The sale was saved successfully, but the printer was unavailable.',
        ...(errorCode ? { errorCode } : {}),
      };

    case 'google.export.completed':
      return {
        ...base,
        severity: 'INFO',
        title: 'Google Sheets export completed',
        detail: 'Your sale was exported to Google Sheets.',
      };

    case 'google.export.failed':
      return {
        ...base,
        severity: 'ERROR',
        title: 'Google Sheets export failed',
        detail:
          'Your local sale is safe. Go Phones POS will keep retrying the export automatically.',
      };

    case 'google.export.retry_scheduled':
      return {
        ...base,
        severity: 'WARNING',
        title: 'Google Sheets export is delayed',
        detail: 'Your local sale is safe and will remain queued for export.',
      };

    case 'backup.failed':
      return {
        ...base,
        severity: 'ERROR',
        title: 'A backup attempt failed',
        detail:
          'Your sales data remains safe. Go Phones POS will try the backup again automatically.',
        ...(errorCode ? { errorCode } : {}),
      };

    case 'diagnostics.disk-space.low': {
      const critical = errorCode === 'DISK_SPACE_CRITICAL';
      const available = formatAvailableBytes(record.context['availableBytes']);
      return {
        ...base,
        severity: critical ? 'ERROR' : 'WARNING',
        title: critical ? 'Critically low disk space' : 'Low disk space',
        detail: available
          ? `Free up space soon to keep backups and local data safe. Available: ${available}.`
          : 'Free up space soon to keep backups and local data safe.',
        ...(errorCode ? { errorCode } : {}),
      };
    }

    case 'crash.evidence.recorded': {
      const eventType = safeString(record.context['eventType']);
      switch (eventType) {
        case 'unexpected_previous_termination':
          return {
            ...base,
            severity: 'WARNING',
            title: 'The application did not close normally last time',
            detail:
              'Go Phones POS may not have shut down cleanly last time (for example, a power loss or a forced shutdown). Your saved sales are safe.',
          };
        case 'main_process_uncaught_exception':
        case 'main_process_unhandled_rejection':
          return {
            ...base,
            severity: 'ERROR',
            title: 'The application recovered from an unexpected problem',
            detail:
              'Go Phones POS encountered an internal problem and restarted. Your saved sales are safe.',
          };
        case 'renderer_process_gone':
          return {
            ...base,
            severity: 'ERROR',
            title: 'The application display stopped responding',
            detail: 'The application window restarted automatically. Your saved sales are safe.',
          };
        case 'child_process_gone':
          return {
            ...base,
            severity: 'WARNING',
            title: 'A background component restarted',
            detail: 'This does not affect your saved sales.',
          };
        default:
          return null;
      }
    }

    case 'clock.change.detected': {
      const direction = safeString(record.context['direction']);
      return {
        ...base,
        severity: 'WARNING',
        title: 'A significant system clock change was detected',
        detail:
          direction === 'BACKWARD'
            ? 'The system clock moved backward unexpectedly. This is shown for reference only and does not affect your saved sales.'
            : 'The system clock moved forward unexpectedly. This is shown for reference only and does not affect your saved sales.',
      };
    }

    case 'support.report.creation-failed':
      return {
        ...base,
        severity: 'ERROR',
        title: 'A support report could not be created',
        detail: 'Please try again. Your saved sales are unaffected.',
      };

    case 'support.bundle.generation-failed':
    case 'support.bundle.export-failed':
      return {
        ...base,
        severity: 'WARNING',
        title: 'A support bundle export failed',
        detail: 'Please try again. Your saved sales are unaffected.',
      };

    default:
      return null;
  }
}

/** Reads bounded recent diagnostic history and maps only approved events into a user-friendly DTO. Fails open: any read/parse problem yields an empty history, never a thrown error. */
export function createActivityHistoryService(
  options: ActivityHistoryServiceOptions,
): ActivityHistoryService {
  const now = options.now ?? (() => new Date());

  return {
    async getRecent(): Promise<ActivityHistory> {
      try {
        const { records } = await collectRecentSanitizedLogRecords(
          options.logsRoot,
          ACTIVITY_HISTORY_MAX_RECORDS_SCANNED,
        );
        const entries: ActivityHistoryEntry[] = [];
        for (const [index, record] of records.entries()) {
          if (entries.length >= ACTIVITY_HISTORY_MAX_ENTRIES) break;
          const mapped = mapRecord(record, `${record.timestamp}#${index}`);
          if (mapped) entries.push(mapped);
        }
        return { generatedAt: now().toISOString(), entries };
      } catch {
        options.logger.warn('diagnostics', 'activity-history.unavailable', {});
        return { generatedAt: now().toISOString(), entries: [] };
      }
    },
  };
}
