import { appErrors } from '../shared/appError';
import { TAX_RATE_BPS_MAX } from './settingsRepository';

/**
 * Trusted application-layer validation for the tax-rate setting write
 * (`ARCHITECTURE.md §30`, `DATA_MODEL.md §20`, `POS_WORKFLOWS.md §68` step 1).
 *
 * The renderer converts its percent field to basis points and the renderer's
 * own checks are UX only; this is the authoritative gate. The persisted value
 * must ultimately be an integer basis-point count within the canonical
 * `0 .. 100000` bound (matching the `sales.tax_rate_bps` CHECK; `825` bps =
 * `8.25%`). Malformed input (`NaN`, `Infinity`, fractions, non-numbers, out of
 * range) is rejected outright, never coerced or clamped.
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
