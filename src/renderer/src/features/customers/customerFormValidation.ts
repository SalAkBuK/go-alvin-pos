import type { CreateCustomerInput, UpdateCustomerInput } from '../../../../shared/customers';

/**
 * Renderer-only, field-level customer form validation (task `§9`), following the
 * Phase 2B pattern.
 *
 * UX convenience only — `customerValidation.ts` in the main process re-validates
 * every payload and the SQLite constraints are the final backstop. Pure (no
 * React, no DOM) so the form and its tests share one code path.
 *
 * Phone deliberately has NO format rules here: any text is accepted, blank is
 * valid, and we never reject a number just because it uses spaces, parentheses,
 * `+`, or dashes. The one thing the trusted layer additionally enforces (a phone
 * value must contain at least one digit) is surfaced as a server error, not
 * pre-checked here.
 */

export interface CustomerFormFields {
  readonly name: string;
  readonly phone: string;
}

export type CustomerFieldName = 'name' | 'phone';
export type CustomerFormErrors = Partial<Record<CustomerFieldName | 'form', string>>;

export function validateCustomerField(
  field: CustomerFieldName,
  fields: CustomerFormFields,
): string | null {
  if (field === 'name') {
    return fields.name.trim() === '' ? 'A customer name is required.' : null;
  }
  return null; // phone: optional, no format rule
}

const CUSTOMER_FIELDS: readonly CustomerFieldName[] = ['name', 'phone'];

export interface CustomerFormValidation {
  readonly errors: CustomerFormErrors;
  /** Non-null only when `errors` is empty. */
  readonly payload: CreateCustomerInput & UpdateCustomerInput;
  readonly ok: boolean;
}

export function validateCustomerForm(fields: CustomerFormFields): CustomerFormValidation {
  const errors: CustomerFormErrors = {};
  for (const field of CUSTOMER_FIELDS) {
    const message = validateCustomerField(field, fields);
    if (message) {
      errors[field] = message;
    }
  }
  const phone = fields.phone.trim() === '' ? null : fields.phone.trim();
  return {
    errors,
    ok: Object.keys(errors).length === 0,
    payload: { name: fields.name.trim(), phone },
  };
}

/** Route a trusted-layer message to the field it concerns, else the general form error. */
export function mapCustomerServerError(message: string): {
  readonly field: CustomerFieldName | 'form';
  readonly message: string;
} {
  if (message === 'Enter a phone number that contains at least one digit.') {
    return { field: 'phone', message };
  }
  if (message.toLowerCase().includes('customer name')) {
    return { field: 'name', message };
  }
  return { field: 'form', message };
}
