/**
 * Shared Settings contract (Phase 2D.1 tax configuration + Phase 2D.2 business &
 * receipt configuration).
 *
 * Pure TypeScript types, dependency-free, so the same definitions bundle into
 * the main process, the sandboxed preload, and the renderer. These are the ONLY
 * settings shapes that cross the IPC boundary.
 *
 * SCOPE: the sales-tax rate (`REQ-TAX-001`, `POS_WORKFLOWS.md §68`) and the
 * business/receipt values a completed sale must freeze into its snapshots
 * (`DATA_MODEL.md §44-49`, `POS_WORKFLOWS.md §69`, `REQ-REC-002`). This is
 * deliberately NOT a general settings subsystem — there is no generic key/value
 * surface. Printer, Google Sheets, credentials, backups, updates, and
 * diagnostics are each their own later slice.
 *
 * The typed result envelope (`IpcResult` / `IpcError`) and error codes are
 * reused from `./products` — the shared cross-slice contract.
 */

/**
 * The currently configured sales-tax rate, or the fact that none is configured.
 * `taxRateBps` is basis points (`DATA_MODEL.md §6`): `825` = `8.25%`.
 */
export type TaxRateConfig =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly taxRateBps: number;
      /** ISO-8601 UTC timestamp of the last change to this setting. */
      readonly updatedAt: string;
    };

/** `settings:tax-update` payload. The renderer converts its percent field to bps first. */
export interface UpdateTaxRateInput {
  readonly taxRateBps: number;
}

// ── Business & receipt configuration (Phase 2D.2) ────────────────────────────

/**
 * The identity/receipt-policy fields a future sale freezes into
 * `sales.business_*_snapshot` / `sales.receipt_*_snapshot` (`DATA_MODEL.md
 * §44-49`).
 *
 * `businessName` is the canonically fixed store identity (`Go Phones - Alvin`,
 * `PRODUCT_SCOPE.md §6/§15`, `REQ-REC-002`, `DATA_MODEL.md §4`) — it is supplied
 * by the trusted layer, shown read-only, and is not in the
 * `POS_WORKFLOWS.md §69` "Change Business Information" list, so it is not
 * user-editable in V1.
 *
 * `businessAddress` and `businessPhone` are owner-entered and required — the
 * canon fixes no value and a blank identity is not a "configured blank" the way
 * a footer/disclaimer can be (`§44-49`). `receiptDisclaimer` and
 * `receiptFooter` may be configured blank (`§44-49`): `null` = never
 * configured, `''` = configured blank.
 */
export interface BusinessConfigValues {
  readonly businessName: string;
  readonly businessAddress: string | null;
  readonly businessPhone: string | null;
  readonly receiptDisclaimer: string | null;
  readonly receiptFooter: string | null;
}

/** Required identity fields that must be present for a canonically valid future sale. */
export const BUSINESS_REQUIRED_FIELDS = ['businessAddress', 'businessPhone'] as const;
export type BusinessRequiredField = (typeof BUSINESS_REQUIRED_FIELDS)[number];

/**
 * Current business/receipt configuration. `configured: true` means every value
 * a completed sale needs is present (the two required identity fields; a blank
 * footer/disclaimer does not block readiness). Phase 2E reads this and treats
 * `configured: false` as the typed "not ready for a sale" signal.
 */
export type BusinessConfig =
  | (BusinessConfigValues & {
      readonly configured: false;
      readonly missing: readonly BusinessRequiredField[];
    })
  | {
      readonly configured: true;
      readonly businessName: string;
      readonly businessAddress: string;
      readonly businessPhone: string;
      readonly receiptDisclaimer: string;
      readonly receiptFooter: string;
      /** ISO-8601 UTC timestamp of the last business-settings change. */
      readonly updatedAt: string;
    };

/**
 * `settings:business-update` payload. All four editable fields are sent on every
 * Save (the form always carries them); the trusted layer trims and validates.
 * `businessName` is deliberately absent — it is not editable.
 */
export interface UpdateBusinessConfigInput {
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly receiptDisclaimer: string;
  readonly receiptFooter: string;
}
