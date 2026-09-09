import { SALES_HISTORY_QUERY_MAX_LENGTH } from '../../shared/salesHistory';
import { appErrors } from '../shared/appError';
import { isValidBusinessDate } from './businessDate';

/**
 * Trusted application-layer validation for the Sales History surface (`task §37`,
 * `§38`). Authoritative regardless of what the renderer already checked — the
 * renderer is never the security boundary.
 *
 * The search payload carries only a free-text term and an optional business
 * date; there is no way to express SQL, a column name, an ordering, or a raw
 * predicate.
 */

export interface ValidatedHistorySearch {
  /** Trimmed; `''` means "no text filter". */
  readonly query: string;
  /** `YYYY-MM-DD` in the configured business timezone, or `null` for "no date filter". */
  readonly businessDate: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The Sales History search must be an object.');
  }
  return value as Record<string, unknown>;
}

const SEARCH_KEYS = ['query', 'businessDate'] as const;

/** `undefined` / `null` / `{}` all mean "no filters". */
export function validateHistorySearch(raw: unknown): ValidatedHistorySearch {
  if (raw === undefined || raw === null) {
    return { query: '', businessDate: null };
  }
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !SEARCH_KEYS.includes(key as (typeof SEARCH_KEYS)[number]),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The Sales History search contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  let query = '';
  const rawQuery = record['query'];
  if (rawQuery !== undefined && rawQuery !== null) {
    if (typeof rawQuery !== 'string') {
      throw appErrors.validation('The search term must be text.');
    }
    query = rawQuery.trim();
    if (query.length > SALES_HISTORY_QUERY_MAX_LENGTH) {
      throw appErrors.validation(
        `The search term must be ${SALES_HISTORY_QUERY_MAX_LENGTH} characters or fewer.`,
      );
    }
  }

  let businessDate: string | null = null;
  const rawDate = record['businessDate'];
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (typeof rawDate !== 'string' || !isValidBusinessDate(rawDate.trim())) {
      throw appErrors.validation('Enter a date as YYYY-MM-DD.');
    }
    businessDate = rawDate.trim();
  }

  return { query, businessDate };
}

export function validateHistorySaleId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('A sale must be selected to view its details.');
  }
  return raw.trim();
}
