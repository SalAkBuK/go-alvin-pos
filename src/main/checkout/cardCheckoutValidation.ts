import { appErrors } from '../shared/appError';
import { validateCheckoutReviewRequest } from './checkoutValidation';
import type { ValidatedCheckoutRequest } from './checkoutValidation';
import { REQUEST_ID_MAX_LENGTH } from './saleValidation';

/**
 * Trusted validation of the Phase 2F Card channel payloads (`ARCHITECTURE.md
 * §30`; `DATA_MODEL.md §31`-`§34`, `§41B`; task Phase 2F `§7`, `§11`, `§12`).
 *
 * Structure only — authoritative money, stock, tax, drift, and the Card total
 * invariant are the service's job. Cash is explicitly rejected on every Card
 * channel: a Cash checkout must never be routed through `begin-card` /
 * `complete-card` / `decline-card`, and a Card request row must never be created
 * or advanced by the Cash channel.
 */

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The card checkout request must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireRequestId(record: Record<string, unknown>): string {
  const raw = record['requestId'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('The checkout request id is missing.');
  }
  const requestId = raw.trim();
  if (requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw appErrors.validation('The checkout request id is not valid.');
  }
  return requestId;
}

function requireFingerprint(record: Record<string, unknown>): string {
  const raw = record['reviewedFingerprint'];
  if (typeof raw !== 'string' || !FINGERPRINT_PATTERN.test(raw)) {
    throw appErrors.validation('The reviewed checkout fingerprint is missing or malformed.');
  }
  return raw;
}

export interface ValidatedCardCheckout {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
  readonly checkout: ValidatedCheckoutRequest;
}

const CARD_CHECKOUT_KEYS = ['requestId', 'reviewedFingerprint', 'checkout'] as const;

/** `checkout:begin-card` and `checkout:complete-card` share this shape. */
export function validateCardCheckout(raw: unknown): ValidatedCardCheckout {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(CARD_CHECKOUT_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The card checkout request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const requestId = requireRequestId(record);
  const reviewedFingerprint = requireFingerprint(record);
  const checkout = validateCheckoutReviewRequest(record['checkout']);
  if (checkout.paymentMethod !== 'CARD') {
    throw appErrors.validation('Only a Card checkout can use this action.');
  }
  return { requestId, reviewedFingerprint, checkout };
}

export interface ValidatedDeclineCard {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
}

const DECLINE_KEYS = ['requestId', 'reviewedFingerprint'] as const;

/** `checkout:decline-card` — no cart body, just the attempt identity. */
export function validateDeclineCard(raw: unknown): ValidatedDeclineCard {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(DECLINE_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The card decline request contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }
  return {
    requestId: requireRequestId(record),
    reviewedFingerprint: requireFingerprint(record),
  };
}
