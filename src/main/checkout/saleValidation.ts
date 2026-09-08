import { appErrors } from '../shared/appError';
import { validateCheckoutReviewRequest } from './checkoutValidation';

/**
 * Trusted validation of a `checkout:complete-cash` payload (`ARCHITECTURE.md
 * §30`, `DATA_MODEL.md §31`-`§34`, `§41B`).
 *
 * Structure only — authoritative money, stock, tax, and drift are the sale
 * service's job (it recomputes everything via `recalculateCheckout` and compares
 * the fingerprint). Card is explicitly rejected here: Phase 2E completes Cash
 * sales only, and a Card checkout request row must never be created by this
 * channel.
 */

/** A 64-character lowercase-hex SHA-256 digest, as produced by `computeCheckoutFingerprint`. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Upper bound on the renderer-generated request id. A UUID is 36 chars; this is
 * a generous ceiling that still rejects a pathological payload.
 */
export const REQUEST_ID_MAX_LENGTH = 200;

export interface ValidatedCompleteCashSale {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
  readonly checkout: ReturnType<typeof validateCheckoutReviewRequest>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The checkout completion request must be an object.');
  }
  return value as Record<string, unknown>;
}

const REQUEST_KEYS = ['requestId', 'reviewedFingerprint', 'checkout'] as const;

export function validateCompleteCashSale(raw: unknown): ValidatedCompleteCashSale {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(REQUEST_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The checkout completion request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const requestIdRaw = record['requestId'];
  if (typeof requestIdRaw !== 'string' || requestIdRaw.trim().length === 0) {
    throw appErrors.validation('The checkout request id is missing.');
  }
  const requestId = requestIdRaw.trim();
  if (requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw appErrors.validation('The checkout request id is not valid.');
  }

  const fingerprintRaw = record['reviewedFingerprint'];
  if (typeof fingerprintRaw !== 'string' || !FINGERPRINT_PATTERN.test(fingerprintRaw)) {
    throw appErrors.validation('The reviewed checkout fingerprint is missing or malformed.');
  }

  const checkout = validateCheckoutReviewRequest(record['checkout']);
  if (checkout.paymentMethod !== 'CASH') {
    throw appErrors.validation('Only Cash sales can be completed in this version.');
  }

  return { requestId, reviewedFingerprint: fingerprintRaw, checkout };
}
