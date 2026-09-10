import { appErrors } from '../shared/appError';
import { isValidBusinessDate } from '../salesHistory/businessDate';

/**
 * Trusted application-layer validation for the `reports:daily` payload
 * (`task VALIDATION / IPC`). Authoritative regardless of what the renderer
 * already checked — the renderer is never the security boundary.
 *
 * The payload carries only an optional business date; there is no way to express
 * SQL, a column, an ordering, a range, or any raw predicate.
 */

export interface ValidatedDailyReportInput {
  /**
   * `YYYY-MM-DD` in the configured business timezone, or `null` meaning "the
   * current business day" (resolved in the service from the injected clock).
   */
  readonly businessDate: string | null;
}

const INPUT_KEYS = ['businessDate'] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The report request must be an object.');
  }
  return value as Record<string, unknown>;
}

/**
 * An OMITTED date means "current business day":
 *   - `undefined` / `null` request,
 *   - `{}` (no `businessDate` key),
 *   - `{ businessDate: null }`.
 *
 * An explicitly supplied `businessDate` is a real request for a specific day and
 * must be a valid `YYYY-MM-DD`. An empty or whitespace-only string is a
 * malformed date, not "today", and is rejected with `VALIDATION` — the renderer
 * clears the picker back to the omitted form, never sends `''`.
 */
export function validateDailyReportInput(raw: unknown): ValidatedDailyReportInput {
  if (raw === undefined || raw === null) {
    return { businessDate: null };
  }
  const record = asRecord(raw);

  const unexpected = Object.keys(record).filter(
    (key) => !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The report request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const rawDate = record['businessDate'];
  if (rawDate === undefined || rawDate === null) {
    return { businessDate: null };
  }
  if (typeof rawDate !== 'string' || !isValidBusinessDate(rawDate.trim())) {
    throw appErrors.validation('Enter a date as YYYY-MM-DD.');
  }
  return { businessDate: rawDate.trim() };
}
