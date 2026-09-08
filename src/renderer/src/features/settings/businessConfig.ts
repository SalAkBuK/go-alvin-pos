import type { BusinessConfig, UpdateBusinessConfigInput } from '../../../../shared/settings';

/**
 * Renderer-only field validation for the Business & Receipt settings form
 * (Phase 2D.2). UX convenience only — `settingsValidation.validateBusinessConfigUpdate`
 * in the main process is authoritative and re-checks every field.
 *
 * Business name is NOT here: it is the canonically fixed store identity, shown
 * read-only, and not part of the payload.
 *
 * Mirrors the ceilings in `settingsRepository.ts`.
 */

export const BUSINESS_ADDRESS_MAX_LENGTH = 500;
export const BUSINESS_PHONE_MAX_LENGTH = 60;
export const RECEIPT_DISCLAIMER_MAX_LENGTH = 2000;
export const RECEIPT_FOOTER_MAX_LENGTH = 500;

export interface BusinessFormFields {
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly receiptDisclaimer: string;
  readonly receiptFooter: string;
}

export type BusinessFieldName = keyof BusinessFormFields;
export type BusinessFormErrors = Partial<Record<BusinessFieldName | 'form', string>>;

/** Prefill the form from the current configuration (blank strings when unset). */
export function fieldsFromConfig(config: BusinessConfig): BusinessFormFields {
  return {
    businessAddress: config.businessAddress ?? '',
    businessPhone: config.businessPhone ?? '',
    receiptDisclaimer: config.receiptDisclaimer ?? '',
    receiptFooter: config.receiptFooter ?? '',
  };
}

export function validateBusinessField(
  field: BusinessFieldName,
  fields: BusinessFormFields,
): string | null {
  const value = fields[field].trim();
  switch (field) {
    case 'businessAddress':
      if (value === '') return 'Enter the store address.';
      if (value.length > BUSINESS_ADDRESS_MAX_LENGTH) {
        return `The address must be ${BUSINESS_ADDRESS_MAX_LENGTH} characters or fewer.`;
      }
      return null;
    case 'businessPhone':
      if (value === '') return 'Enter the store phone number.';
      if (!/[0-9]/.test(value)) return 'Enter a phone number that contains at least one digit.';
      if (value.length > BUSINESS_PHONE_MAX_LENGTH) {
        return `The phone number must be ${BUSINESS_PHONE_MAX_LENGTH} characters or fewer.`;
      }
      return null;
    case 'receiptDisclaimer':
      return value.length > RECEIPT_DISCLAIMER_MAX_LENGTH
        ? `The disclaimer must be ${RECEIPT_DISCLAIMER_MAX_LENGTH} characters or fewer.`
        : null;
    case 'receiptFooter':
      return value.length > RECEIPT_FOOTER_MAX_LENGTH
        ? `The footer must be ${RECEIPT_FOOTER_MAX_LENGTH} characters or fewer.`
        : null;
  }
}

const BUSINESS_FIELDS: readonly BusinessFieldName[] = [
  'businessAddress',
  'businessPhone',
  'receiptDisclaimer',
  'receiptFooter',
];

export interface BusinessFormValidation {
  readonly errors: BusinessFormErrors;
  /** Non-null only when `errors` is empty — trimmed, ready for the trusted layer. */
  readonly payload: UpdateBusinessConfigInput | null;
}

export function validateBusinessForm(fields: BusinessFormFields): BusinessFormValidation {
  const errors: BusinessFormErrors = {};
  for (const field of BUSINESS_FIELDS) {
    const message = validateBusinessField(field, fields);
    if (message) {
      errors[field] = message;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { errors, payload: null };
  }
  return {
    errors,
    payload: {
      businessAddress: fields.businessAddress.trim(),
      businessPhone: fields.businessPhone.trim(),
      receiptDisclaimer: fields.receiptDisclaimer.trim(),
      receiptFooter: fields.receiptFooter.trim(),
    },
  };
}

/** Human-readable list of what still needs entering, for the incomplete banner. */
export function describeMissing(config: BusinessConfig): string | null {
  if (config.configured) {
    return null;
  }
  const labels: Record<string, string> = {
    businessAddress: 'store address',
    businessPhone: 'store phone number',
  };
  const names = config.missing.map((key) => labels[key] ?? key);
  if (names.length === 0) {
    return 'Enter your store address and phone number to finish setup.';
  }
  return `Still needed before checkout can complete a sale: ${names.join(' and ')}.`;
}
