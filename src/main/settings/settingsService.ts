import type Database from 'better-sqlite3';
import type { BusinessConfig, BusinessRequiredField, TaxRateConfig } from '../../shared/settings';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { AppError, appErrors } from '../shared/appError';
import {
  BUSINESS_NAME,
  readBusinessSettings,
  readTaxRateSetting,
  writeBusinessSettings,
  writeTaxRateBps,
} from './settingsRepository';
import type { BusinessSettingsRow } from './settingsRepository';
import { validateBusinessConfigUpdate, validateTaxRateUpdate } from './settingsValidation';

/**
 * Store configuration: the sales-tax rate (`REQ-TAX-001`, `POS_WORKFLOWS.md
 * §68`) and the business/receipt values a completed sale freezes into its
 * snapshots (`DATA_MODEL.md §44-49`, `POS_WORKFLOWS.md §69`, `REQ-REC-002`).
 *
 * Every `*update*` follows the canonical Change-*-Settings flow: validate, then
 * in ONE `BEGIN IMMEDIATE` transaction persist the `settings` row(s) and append
 * the required audit event (`TAX_SETTING_CHANGED` / `BUSINESS_SETTING_CHANGED`)
 * via the shared `appendAuditEvent`, so the `audit_sequence` counter is
 * allocated and rolls back exactly like everywhere else. If the setting write
 * or the audit insert fails, the whole thing rolls back — no partial state, no
 * consumed sequence value (`REQ-AUDIT-004`, `ARCHITECTURE.md §42.2`).
 *
 * First-time configuration is recorded with the same `*_CHANGED` event (there
 * is no separate "created" type; this mirrors `AUTH_CREDENTIAL_CHANGED`
 * covering first-run credential creation, `DATA_MODEL.md §36A`).
 *
 * Changing settings never touches historical `sales` rows — each sale keeps its
 * own snapshots (`REQ-TAX-003`, `REQ-SALE-009`). This service only writes the
 * `settings` and `audit_events` / `counters` rows. It creates no sale.
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
  getBusinessConfig(): BusinessConfig;
  updateBusinessConfig(raw: unknown): BusinessConfig;
}

function toTaxConfig(setting: { taxRateBps: number; updatedAt: string } | null): TaxRateConfig {
  return setting
    ? { configured: true, taxRateBps: setting.taxRateBps, updatedAt: setting.updatedAt }
    : { configured: false };
}

const BUSINESS_EDITABLE_KEYS = [
  'businessAddress',
  'businessPhone',
  'receiptDisclaimer',
  'receiptFooter',
] as const;
type BusinessEditableKey = (typeof BUSINESS_EDITABLE_KEYS)[number];

/**
 * Read the current business/receipt configuration directly, without a service
 * instance. Opens no transaction — safe to call inside another transaction, so
 * Phase 2E's Cash completion can gate a sale on `configured === true`
 * (`POS_WORKFLOWS.md §69`, `DATA_MODEL.md §44-49`, `REQ-REC-002`).
 */
export function readBusinessConfig(db: Database.Database): BusinessConfig {
  return toBusinessConfig(readBusinessSettings(db));
}

function toBusinessConfig(row: BusinessSettingsRow): BusinessConfig {
  const missing: BusinessRequiredField[] = [];
  if (row.businessAddress === null || row.businessAddress.trim() === '') {
    missing.push('businessAddress');
  }
  if (row.businessPhone === null || row.businessPhone.trim() === '') {
    missing.push('businessPhone');
  }

  if (missing.length > 0 || row.updatedAt === null) {
    return {
      configured: false,
      businessName: BUSINESS_NAME,
      businessAddress: row.businessAddress,
      businessPhone: row.businessPhone,
      receiptDisclaimer: row.receiptDisclaimer,
      receiptFooter: row.receiptFooter,
      missing,
    };
  }

  return {
    configured: true,
    businessName: BUSINESS_NAME,
    businessAddress: row.businessAddress as string,
    businessPhone: row.businessPhone as string,
    receiptDisclaimer: row.receiptDisclaimer ?? '',
    receiptFooter: row.receiptFooter ?? '',
    updatedAt: row.updatedAt,
  };
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { db, appVersion } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    getTaxRate(): TaxRateConfig {
      return toTaxConfig(readTaxRateSetting(db));
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
        throw new AppError('INTERNAL', 'The tax rate was saved but could not be read back.');
      }
      return toTaxConfig(saved);
    },

    getBusinessConfig(): BusinessConfig {
      return readBusinessConfig(db);
    },

    updateBusinessConfig(raw: unknown): BusinessConfig {
      const fields = validateBusinessConfigUpdate(raw);
      const occurredAt = now();

      const run = db.transaction(() => {
        const current = readBusinessSettings(db);

        // Which editable fields actually differ from what is stored. `null`
        // (never configured) and `''` (configured blank) are distinct states.
        const changed = BUSINESS_EDITABLE_KEYS.filter(
          (key) => (current[key] ?? null) !== fields[key],
        );
        if (changed.length === 0) {
          throw appErrors.businessSettingsUnchanged();
        }

        writeBusinessSettings(db, fields, occurredAt);

        const pick = (
          source: Record<BusinessEditableKey, string | null>,
        ): Record<string, string | null> =>
          Object.fromEntries(changed.map((key) => [key, source[key]]));

        appendAuditEvent(db, {
          eventType: 'BUSINESS_SETTING_CHANGED',
          occurredAt,
          actorType: 'USER',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'SETTING',
          subjectId: 'business_information',
          details: {
            changedFields: changed,
            previous: pick(current),
            next: pick(fields),
          },
        });
      });

      run.immediate();

      return toBusinessConfig(readBusinessSettings(db));
    },
  };
}
