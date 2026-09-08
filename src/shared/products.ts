/**
 * Shared Products + Inventory contract (Phase 2B).
 *
 * Pure TypeScript types and string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY product/inventory shapes that cross the IPC
 * boundary — the renderer never sees a raw SQLite row, SQL text, or an
 * `Error`/stack. All monetary values are integer cents (`DATA_MODEL.md §5`).
 */

/** Canonical V1 product conditions (`DATA_MODEL.md §7`, `REQ-PROD-002`). */
export const PRODUCT_CONDITIONS = ['NEW', 'USED', 'REFURBISHED'] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

/**
 * A product as presented to the renderer. `lowStock` / `zeroStock` are derived
 * once here (`DATA_MODEL.md §13` / `REQ-PROD-007`) so every screen indicates the
 * same state; the renderer must not re-derive its own rule.
 */
export interface ProductRecord {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly costPriceCents: number | null;
  readonly sellingPriceCents: number;
  readonly quantityOnHand: number;
  readonly lowStockThreshold: number | null;
  readonly isActive: boolean;
  readonly lowStock: boolean;
  readonly zeroStock: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One immutable inventory-movement history row (`DATA_MODEL.md §17`). */
export interface InventoryMovementRecord {
  readonly id: string;
  readonly productId: string;
  readonly movementType: 'SALE' | 'VOID_REVERSAL' | 'MANUAL_ADJUSTMENT' | 'INITIAL_STOCK';
  readonly quantityChange: number;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** `products:create` payload — the canonical create fields (`POS_WORKFLOWS.md §8`). */
export interface CreateProductInput {
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPriceCents: number;
  readonly quantity: number;
  readonly sku?: string | null;
  readonly barcode?: string | null;
  readonly costPriceCents?: number | null;
  readonly lowStockThreshold?: number | null;
}

/**
 * `products:update` payload — editable metadata/pricing only. `quantityOnHand`
 * is deliberately absent: stock changes go through `inventory:adjust`
 * (`DATA_MODEL.md §40`, `POS_WORKFLOWS.md §10`).
 */
export interface UpdateProductInput {
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPriceCents: number;
  readonly costPriceCents: number | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly lowStockThreshold: number | null;
}

export interface ProductListOptions {
  /** Product-management screens may include archived rows; sellable search must not. */
  readonly includeArchived?: boolean;
}

export interface ProductSearchOptions extends ProductListOptions {
  readonly query: string;
}

/** Barcode lookup result — an unknown barcode is a typed, non-fatal outcome. */
export type ProductBarcodeLookup =
  { readonly found: true; readonly product: ProductRecord } | { readonly found: false };

/**
 * `inventory:adjust` payload. One explicit internal contract: the caller states
 * either a signed `delta` or an absolute `targetQuantity`; the service resolves
 * it against the authoritative current quantity (never a renderer-supplied
 * previous quantity). `reason` is required (`POS_WORKFLOWS.md §12`).
 */
export type InventoryAdjustmentInput = {
  readonly productId: string;
  readonly reason: string;
} & (
  | { readonly mode: 'delta'; readonly delta: number }
  | { readonly mode: 'target'; readonly targetQuantity: number }
);

export interface InventoryAdjustmentResult {
  readonly product: ProductRecord;
  readonly movement: InventoryMovementRecord;
}

/**
 * Stable structured error codes surfaced to the renderer. Never a raw SQLite
 * code. Shared across every business slice (products, inventory, customers).
 */
export const APP_ERROR_CODES = [
  'VALIDATION',
  'PRODUCT_NOT_FOUND',
  'DUPLICATE_BARCODE',
  'DUPLICATE_SKU',
  'INVENTORY_NEGATIVE',
  'ADJUSTMENT_NO_CHANGE',
  'CUSTOMER_NOT_FOUND',
  'DATABASE_UNAVAILABLE',
  'FORBIDDEN',
  'INTERNAL',
  // ── Phase 2D: Checkout review ──────────────────────────────────────────────
  /** A cart line references a product that is archived / no longer sellable. */
  'PRODUCT_ARCHIVED',
  /** Aggregated cart quantity for a product exceeds current `quantity_on_hand`. */
  'INSUFFICIENT_STOCK',
  /** No usable `tax_rate_bps` is configured in local settings. */
  'TAX_RATE_NOT_CONFIGURED',
  /** The recalculated checkout total exceeds the canonical ceiling (`DATA_MODEL.md §41A`). */
  'CHECKOUT_TOTAL_EXCEEDED',
  // ── Phase 2D.1: Minimal tax configuration ──────────────────────────────────
  /** The requested tax rate equals the currently configured one — no change to record. */
  'TAX_RATE_UNCHANGED',
  // ── Phase 2D.2: Minimal business & receipt configuration ───────────────────
  /** The submitted business/receipt details match what is already saved — nothing to record. */
  'BUSINESS_SETTINGS_UNCHANGED',
  // ── Phase 2E: Cash checkout / first real sale ──────────────────────────────
  /**
   * Authoritative state changed between review and completion (price, tax rate,
   * availability, stock, totals). The cashier must review the cart again. A
   * drift/validation rejection — no sale was attempted; distinct from
   * `SALE_COMMIT_FAILED` because the retry behaviour differs (`REQ-SALE-014`).
   */
  'CHECKOUT_DRIFT',
  /** The checkout request id was reused with a different fingerprint (`DATA_MODEL.md §34`). */
  'IDEMPOTENCY_CONFLICT',
  /** Store business/receipt configuration is incomplete, so no sale can be completed. */
  'BUSINESS_NOT_CONFIGURED',
  /**
   * The authoritative sale transaction (Phase 2) could not be committed to
   * SQLite. No sale, payment, inventory change, movement, export job, or audit
   * event was recorded (`POS_WORKFLOWS.md §35`, `SUPPORT_DIAGNOSTICS.md §42`).
   */
  'SALE_COMMIT_FAILED',
  /** The checkout request exists but is not in a state Cash Phase 2 can act on. */
  'CHECKOUT_REQUEST_INVALID',
  // ── Phase 2E.1: Receipt representation & preview ───────────────────────────
  /** No committed sale exists for the given Sale ID, so no receipt can be generated. */
  'RECEIPT_NOT_FOUND',
  /**
   * A committed sale exists but its stored rows do not satisfy a V1 receipt
   * invariant (missing items, missing/duplicate payment, payment total ≠ sale
   * total). Read-only detection — the sale itself is never touched.
   */
  'RECEIPT_DATA_INCONSISTENT',
] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface IpcError {
  readonly code: AppErrorCode;
  /** A complete, user-facing sentence. Contains no SQL, paths, or stack frames. */
  readonly message: string;
}

/** Every Phase 2B privileged IPC call resolves to this envelope — it never rejects for a business error. */
export type IpcResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };
