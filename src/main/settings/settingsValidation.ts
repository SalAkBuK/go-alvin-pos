import { appErrors } from '../shared/appError';
import type { UpdateBusinessConfigInput } from '../../shared/settings';
import {
  BUSINESS_ADDRESS_MAX_LENGTH,
  BUSINESS_PHONE_MAX_LENGTH,
  RECEIPT_DISCLAIMER_MAX_LENGTH,
  RECEIPT_FOOTER_MAX_LENGTH,
  TAX_RATE_BPS_MAX,
} from './settingsRepository';

/**
 * Trusted application-layer validation for the settings writes
 * (`ARCHITECTURE.md §30`, `DATA_MODEL.md §20`, `POS_WORKFLOWS.md §68`/`§69`).
 *
 * The renderer's own checks are UX only; this is the authoritative gate.
 * Malformed input (`NaN`, `Infinity`, fractions, non-numbers, wrong types,
 * unknown keys, out of range) is rejected outright, never coerced or clamped.
 */

export interface ValidatedTaxRateUpdate {
  readonly taxRateBps: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The tax-rate update must be an object.');
  }
  return value as Record<string, unknown>;
}

const ALLOWED_KEYS = ['taxRateBps'] as const;

export function validateTaxRateUpdate(raw: unknown): ValidatedTaxRateUpdate {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(ALLOWED_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The tax-rate update contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const value = record['taxRateBps'];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw appErrors.validation('The tax rate must be a number.');
  }
  if (!Number.isInteger(value)) {
    throw appErrors.validation('The tax rate must be a whole number of basis points.');
  }
  if (value < 0) {
    throw appErrors.validation('The tax rate cannot be negative.');
  }
  if (value > TAX_RATE_BPS_MAX) {
    throw appErrors.validation('The tax rate is above the maximum allowed.');
  }
  return { taxRateBps: value };
}

// ── Business & receipt configuration (Phase 2D.2) ────────────────────────────

const BUSINESS_KEYS = [
  'businessAddress',
  'businessPhone',
  'receiptDisclaimer',
  'receiptFooter',
] as const;

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const raw = record[key];
  if (typeof raw !== 'string') {
    throw appErrors.validation(`${label} must be text.`);
  }
  return raw.trim();
}

/**
 * Validate a `settings:business-update` payload. Returns the four trimmed
 * strings ready to persist.
 *
 * - `businessAddress` / `businessPhone` — required, non-blank after trim
 *   (`DATA_MODEL.md §44-49`: a blank identity is not a "configured blank" the
 *   way a footer/disclaimer is). The canon fixes no format; per the task, phone
 *   uses the existing repo rule "must contain at least one digit" and nothing
 *   more elaborate.
 * - `receiptDisclaimer` / `receiptFooter` — may be blank; a blank value is kept
 *   as the empty string (stored as the configured blank, not null).
 */
export function validateBusinessConfigUpdate(raw: unknown): UpdateBusinessConfigInput {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(BUSINESS_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The business details contain unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  const businessAddress = requireString(record, 'businessAddress', 'The business address');
  if (businessAddress.length === 0) {
    throw appErrors.validation('Enter the store address.');
  }
  if (businessAddress.length > BUSINESS_ADDRESS_MAX_LENGTH) {
    throw appErrors.validation(
      `The business address must be ${BUSINESS_ADDRESS_MAX_LENGTH} characters or fewer.`,
    );
  }

  const businessPhone = requireString(record, 'businessPhone', 'The business phone number');
  if (businessPhone.length === 0) {
    throw appErrors.validation('Enter the store phone number.');
  }
  if (!/[0-9]/.test(businessPhone)) {
    throw appErrors.validation('Enter a phone number that contains at least one digit.');
  }
  if (businessPhone.length > BUSINESS_PHONE_MAX_LENGTH) {
    throw appErrors.validation(
      `The business phone number must be ${BUSINESS_PHONE_MAX_LENGTH} characters or fewer.`,
    );
  }

  const receiptDisclaimer = requireString(record, 'receiptDisclaimer', 'The receipt disclaimer');
  if (receiptDisclaimer.length > RECEIPT_DISCLAIMER_MAX_LENGTH) {
    throw appErrors.validation(
      `The receipt disclaimer must be ${RECEIPT_DISCLAIMER_MAX_LENGTH} characters or fewer.`,
    );
  }

  const receiptFooter = requireString(record, 'receiptFooter', 'The receipt footer');
  if (receiptFooter.length > RECEIPT_FOOTER_MAX_LENGTH) {
    throw appErrors.validation(
      `The receipt footer must be ${RECEIPT_FOOTER_MAX_LENGTH} characters or fewer.`,
    );
  }

  return { businessAddress, businessPhone, receiptDisclaimer, receiptFooter };
}
