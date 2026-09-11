/**
 * Shared maintenance-state contract (Phase 2L-B).
 *
 * The five canonical states of the one main-process maintenance coordinator
 * (`ARCHITECTURE.md §42.3`; `UPDATE_RELEASE_STRATEGY.md §16`). The renderer sees
 * these only for an application-level "sales temporarily unavailable" banner —
 * it is never authoritative.
 */
export type MaintenanceState =
  | 'SAFE'
  | 'CHECKOUT_ACTIVE'
  | 'TRANSACTION_IN_FLIGHT'
  | 'MIGRATION_IN_PROGRESS'
  | 'RESTORE_IN_PROGRESS';

/** The single narrow renderer→main maintenance input: draft-cart presence. */
export interface CheckoutActivityInput {
  readonly active: boolean;
}
