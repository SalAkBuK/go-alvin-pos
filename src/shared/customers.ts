/**
 * Shared Customers contract (Phase 2C).
 *
 * Pure TypeScript types, dependency-free, so the same definitions bundle into
 * the main process, the sandboxed preload, and the renderer. These are the ONLY
 * customer shapes that cross the IPC boundary — the renderer never sees a raw
 * SQLite row, SQL text, or an `Error`/stack.
 *
 * The typed result envelope (`IpcResult` / `IpcError`) and error codes are
 * reused from `./products` — they are the shared cross-slice contract, not
 * products-specific.
 */

/**
 * A customer as presented to the renderer (`DATA_MODEL.md §9`). `phone` keeps
 * the exact trimmed text the cashier entered; `phoneNormalized` is the derived
 * digits-only form used for search. Both are `null` together when no phone is
 * on file.
 */
export interface CustomerRecord {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `customers:create` payload. Name required; phone optional (name-only is valid). */
export interface CreateCustomerInput {
  readonly name: string;
  readonly phone?: string | null;
}

/** `customers:update` payload. Both fields editable; phone `null` clears it. */
export interface UpdateCustomerInput {
  readonly name: string;
  readonly phone: string | null;
}

export interface CustomerSearchOptions {
  /** Free text: matched as a name substring and, when it contains digits, against `phone_normalized`. */
  readonly query: string;
}

/**
 * One row of a customer's read-only purchase history (`REQ-CUST-005`). Derived
 * entirely from immutable `sales` rows keyed by `sales.customer_id`, never from
 * the customer's current name/phone.
 */
export interface CustomerPurchase {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly completedAt: string;
  readonly status: 'COMPLETED' | 'VOIDED';
  readonly totalCents: number;
  readonly paymentMethod: 'CASH' | 'CARD';
}
