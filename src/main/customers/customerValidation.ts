import { appErrors } from '../shared/appError';

/**
 * Trusted application-layer customer validation (task `§3`; `DATA_MODEL.md §9`,
 * `REQ-CUST-007`).
 *
 * Authoritative regardless of what the renderer already checked. Names are
 * trimmed and required; phone is optional, trimmed, blank → `NULL`, and its
 * digits-only `phone_normalized` form is derived here. V1 imposes no phone
 * uniqueness and no phone-format rules beyond "must contain at least one digit
 * when a value is given" (so the `customers` CHECK constraints hold).
 */

export const NAME_MAX_LENGTH = 200;
export const PHONE_MAX_LENGTH = 60;

export interface ValidatedCustomerFields {
  readonly name: string;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
}

/** Digits-only representation used for search and `phone_normalized` (`DATA_MODEL.md §9`). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, '');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw appErrors.validation(`${label} contains unexpected field(s): ${unexpected.join(', ')}.`);
  }
}

function requireName(record: Record<string, unknown>): string {
  const raw = record['name'];
  if (typeof raw !== 'string') {
    throw appErrors.validation('A customer name is required.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw appErrors.validation('A customer name is required.');
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw appErrors.validation(`The customer name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

/** Optional phone: string | null | absent → trimmed value or `null`, plus its digits-only form. */
function resolvePhone(record: Record<string, unknown>): {
  phone: string | null;
  phoneNormalized: string | null;
} {
  const raw = record['phone'];
  if (raw === undefined || raw === null) {
    return { phone: null, phoneNormalized: null };
  }
  if (typeof raw !== 'string') {
    throw appErrors.validation('The phone number must be text.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { phone: null, phoneNormalized: null };
  }
  if (trimmed.length > PHONE_MAX_LENGTH) {
    throw appErrors.validation(`The phone number must be ${PHONE_MAX_LENGTH} characters or fewer.`);
  }
  const phoneNormalized = normalizePhone(trimmed);
  if (phoneNormalized.length === 0) {
    throw appErrors.validation('Enter a phone number that contains at least one digit.');
  }
  // The trimmed human-entered representation is preserved as-is; no reformatting.
  return { phone: trimmed, phoneNormalized };
}

const CUSTOMER_KEYS = ['name', 'phone'] as const;

export function validateCreateCustomer(raw: unknown): ValidatedCustomerFields {
  const record = asRecord(raw, 'The customer');
  rejectUnknownKeys(record, CUSTOMER_KEYS, 'The customer');
  const name = requireName(record);
  const { phone, phoneNormalized } = resolvePhone(record);
  return { name, phone, phoneNormalized };
}

export function validateUpdateCustomer(raw: unknown): ValidatedCustomerFields {
  // Same shape/rules as create; the service supplies the id separately.
  return validateCreateCustomer(raw);
}

export function validateCustomerId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('A customer must be selected.');
  }
  return raw.trim();
}

export function validateCustomerSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw appErrors.validation('A search term is required.');
  }
  return raw.trim();
}
