import type Database from 'better-sqlite3';
import type { TaxRateConfig } from '../../shared/settings';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { AppError, appErrors } from '../shared/appError';
import { readTaxRateSetting, writeTaxRateBps } from './settingsRepository';
import { validateTaxRateUpdate } from './settingsValidation';

/**
 * Tax-rate configuration (`REQ-TAX-001`, `POS_WORKFLOWS.md §68`,
 * `DATA_MODEL.md §36A`, `ARCHITECTURE.md §42.2`; `REQ-AUDIT-002`,
 * `REQ-AUDIT-004`).
 *
 * `getTaxRate()` is a plain read. `updateTaxRate()` follows the canonical
 * Change Tax Rate flow: validate the new rate, then in ONE `BEGIN IMMEDIATE`
 * transaction persist `settings.tax_rate_bps` and append a `TAX_SETTING_CHANGED`
 * audit event (reusing the shared `appendAuditEvent`, so the `audit_sequence`
 * counter is allocated and rolls back exactly like everywhere else). If either
 * the setting write or the audit insert fails, the whole thing rolls back — no
 * partial state, no consumed sequence value.
 *
 * The first successful configuration of the rate is recorded with the same
 * `TAX_SETTING_CHANGED` event (there is no separate "created" event type; this
 * mirrors `AUTH_CREDENTIAL_CHANGED` covering first-run credential creation,
 * `DATA_MODEL.md §36A`), carrying `previousTaxRateBps: null`.
 *
 * Changing the rate never touches historical `sales` rows — each sale keeps its
 * own `tax_rate_bps` / `tax_cents` / `total_cents` snapshot (`REQ-TAX-003`).
 * This service only writes the `settings` and `audit_events`/`counters` rows.
 */

export interface SettingsServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface SettingsService {
  getTaxRate(): TaxRateConfig;
  updateTaxRate(raw: unknown): TaxRateConfig;
}

function toConfig(setting: { taxRateBps: number; updatedAt: string } | null): TaxRateConfig {
  return setting
    ? { configured: true, taxRateBps: setting.taxRateBps, updatedAt: setting.updatedAt }
    : { configured: false };
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { db, appVersion } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    getTaxRate(): TaxRateConfig {
      return toConfig(readTaxRateSetting(db));
    },

    updateTaxRate(raw: unknown): TaxRateConfig {
      const { taxRateBps } = validateTaxRateUpdate(raw);
      const occurredAt = now();

      const run = db.transaction(() => {
        const current = readTaxRateSetting(db);
        if (current && current.taxRateBps === taxRateBps) {
          // No-op save: reject rather than write a misleading "changed" audit
          // event, mirroring the inventory service's ADJUSTMENT_NO_CHANGE.
          throw appErrors.taxRateUnchanged();
        }

        writeTaxRateBps(db, taxRateBps, occurredAt);

        appendAuditEvent(db, {
          eventType: 'TAX_SETTING_CHANGED',
          occurredAt,
          actorType: 'USER',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'SETTING',
          subjectId: 'tax_rate_bps',
          details: {
            setting: 'tax_rate_bps',
            previousTaxRateBps: current ? current.taxRateBps : null,
            newTaxRateBps: taxRateBps,
          },
        });
      });

      run.immediate();

      const saved = readTaxRateSetting(db);
      if (!saved) {
        // Committed but unreadable — never expected.
        throw new AppError('INTERNAL', 'The tax rate was saved but could not be read back.');
      }
      return toConfig(saved);
    },
  };
}
