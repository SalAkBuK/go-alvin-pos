import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomerForm } from '../../src/renderer/src/features/customers/CustomerForm';
import {
  mapCustomerServerError,
  validateCustomerForm,
} from '../../src/renderer/src/features/customers/customerFormValidation';
import type { CustomerFormFields } from '../../src/renderer/src/features/customers/customerFormValidation';

/**
 * Phase 2C renderer form validation. `CustomerForm.handleSubmit` calls
 * `validateCustomerForm`; when `ok` is false it bails before any
 * `window.pos.customers.*` call, so exercising the pure module exercises the
 * exact gate.
 */

function fields(overrides: Partial<CustomerFormFields> = {}): CustomerFormFields {
  return { name: 'Jane Doe', phone: '', ...overrides };
}

describe('validateCustomerForm', () => {
  it('rejects a blank / whitespace-only name before IPC', () => {
    for (const name of ['', '   ', '\t']) {
      const result = validateCustomerForm(fields({ name }));
      expect(result.ok).toBe(false);
      expect(result.errors.name).toMatch(/required/i);
    }
  });

  it('accepts a name-only customer and trims the name', () => {
    const result = validateCustomerForm(fields({ name: '  Jane Doe  ', phone: '' }));
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ name: 'Jane Doe', phone: null });
  });

  it('accepts any phone text and never reformats it; blank phone → null', () => {
    for (const phone of ['(281) 824-0001', '281-824-0001', '+1 281 824 0001 x2', 'call the shop']) {
      const result = validateCustomerForm(fields({ phone }));
      expect(result.ok).toBe(true);
      expect(result.errors.phone).toBeUndefined();
      expect(result.payload.phone).toBe(phone.trim());
    }
    expect(validateCustomerForm(fields({ phone: '   ' })).payload.phone).toBeNull();
  });
});

describe('mapCustomerServerError', () => {
  it('routes the trusted no-digit phone error to the phone field', () => {
    expect(
      mapCustomerServerError('Enter a phone number that contains at least one digit.'),
    ).toEqual({
      field: 'phone',
      message: 'Enter a phone number that contains at least one digit.',
    });
  });

  it('routes a name message to the name field and anything else to the form', () => {
    expect(mapCustomerServerError('A customer name is required.').field).toBe('name');
    expect(mapCustomerServerError('Something went wrong. Please try again.').field).toBe('form');
  });
});

describe('CustomerForm is not noisy before interaction', () => {
  it('renders no field errors or aria-invalid on first render', () => {
    const html = renderToStaticMarkup(
      <CustomerForm mode="create" onSubmit={async () => null} onCancel={() => {}} />,
    );
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('class="field-error"');
    expect(html.toLowerCase()).toContain('novalidate');
    expect(html).toContain('Name');
    expect(html).toContain('Phone');
  });
});
