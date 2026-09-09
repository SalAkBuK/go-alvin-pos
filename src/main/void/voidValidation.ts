import { VOID_REASON_MAX_LENGTH } from '../../shared/salesHistory';
import { appErrors } from '../shared/appError';

/**
 * Trusted application-layer validation for `sales-history:void` (`task §9`;
 * `REQ-VOID-002`; `DATA_MODEL.md §11` void-field CHECK). Authoritative regardless
 * of anything the renderer checked — the renderer is never the security boundary.
 *
 * The payload can express only a Sale ID and a free-text reason: there is no
 * timestamp, sync version, inventory field, SQL, or reason taxonomy to supply.
 */

export interface ValidatedVoidSaleInput {
  readonly saleId: string;
  /** Trimmed, non-empty, ≤ `VOID_REASON_MAX_LENGTH`. */
  readonly reason: string;
}

const KEYS = ['saleId', 'reason'] as const;

export function validateVoidSaleInput(raw: unknown): ValidatedVoidSaleInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw appErrors.validation('The void request must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(
    (key) => !KEYS.includes(key as (typeof KEYS)[number]),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The void request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const rawSaleId = record['saleId'];
  if (typeof rawSaleId !== 'string' || rawSaleId.trim().length === 0) {
    throw appErrors.validation('A sale must be selected to void.');
  }

  const rawReason = record['reason'];
  if (typeof rawReason !== 'string') {
    throw appErrors.validation('Enter a reason for voiding this sale.');
  }
  const reason = rawReason.trim();
  if (reason.length === 0) {
    throw appErrors.validation('Enter a reason for voiding this sale.');
  }
  if (reason.length > VOID_REASON_MAX_LENGTH) {
    throw appErrors.validation(
      `The void reason must be ${VOID_REASON_MAX_LENGTH} characters or fewer.`,
    );
  }

  return { saleId: rawSaleId.trim(), reason };
}
