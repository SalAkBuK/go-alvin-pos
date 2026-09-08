/**
 * Shared Settings contract (Phase 2D.1 — minimal tax configuration).
 *
 * Pure TypeScript types, dependency-free, so the same definitions bundle into
 * the main process, the sandboxed preload, and the renderer. These are the ONLY
 * settings shapes that cross the IPC boundary.
 *
 * SCOPE: the sales-tax rate only (`REQ-TAX-001`, `POS_WORKFLOWS.md §68`). This
 * is deliberately NOT a general settings subsystem — there is no generic
 * key/value surface and no other setting is exposed. Business name, receipt
 * text, printer, Google Sheets, credentials, backups, updates, and diagnostics
 * are each their own later slice.
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
