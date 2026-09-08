/**
 * Shared Receipt contract (Phase 2E.1 — Receipt Representation & Preview).
 *
 * Pure TypeScript types, dependency-free, so the identical shape bundles into
 * the main process, the sandboxed preload, and the renderer. This is the ONLY
 * receipt shape that crosses the IPC boundary.
 *
 * A `ReceiptRepresentation` is a printer-independent rendering of ONE committed
 * sale, assembled entirely from transaction-time snapshots (`DATA_MODEL.md
 * §44-49`, `ARCHITECTURE.md §18`, `§34`; `REQ-REC-001`-`REQ-REC-003`;
 * `POS_WORKFLOWS.md §38`). It is deliberately reusable by every future consumer
 * — receipt preview (this slice), standard printing, 80 mm / 58 mm thermal
 * rendering, Sales History, and reprint — WITHOUT changing transaction storage
 * (`REQ-PRINT-003`).
 *
 * Every field below is read from `sales` / `sale_items` / `payments` for the
 * given Sale ID. The single exception is `businessTimezone` — see its doc.
 */

import type { PaymentMethod } from './checkout';
import type { ProductCondition } from './products';

export interface ReceiptBusiness {
  /** `sales.business_name_snapshot`. */
  readonly name: string;
  /** `sales.business_address_snapshot`. */
  readonly address: string;
  /** `sales.business_phone_snapshot`. */
  readonly phone: string;
}

export interface ReceiptCustomer {
  /** `sales.customer_name_snapshot` (required whenever a customer was attached). */
  readonly name: string;
  /** `sales.customer_phone_snapshot` — `null` when the customer had no phone. */
  readonly phone: string | null;
}

/** One sold line, every value a `sale_items` transaction-time snapshot. */
export interface ReceiptItem {
  readonly productName: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly quantity: number;
  /** Price before negotiation, at sale time. */
  readonly listedPriceCents: number;
  /** Actual per-unit price charged. */
  readonly soldPriceCents: number;
  /** `max(0, listed - sold) * quantity` — clamped at zero, never negative (`§41`). */
  readonly discountCents: number;
  /** `listed_price_cents * quantity`. */
  readonly lineSubtotalCents: number;
  /** `sold_price_cents * quantity`. */
  readonly lineTotalCents: number;
}

/** Transaction totals — all from the `sales` snapshot, never recalculated. */
export interface ReceiptTotals {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly taxRateBps: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface ReceiptPayment {
  readonly method: PaymentMethod;
  readonly amountCents: number;
}

export interface ReceiptRepresentation {
  readonly saleId: string;
  readonly receiptNumber: string;
  /**
   * V1 only ever produces `COMPLETED`. `VOIDED` is carried in the type so the
   * same representation serves a future void receipt (`DATA_MODEL.md §11`,
   * `§26`) without a reshape; this slice renders no void treatment.
   */
  readonly status: 'COMPLETED' | 'VOIDED';
  /** `sales.completed_at` — ISO-8601 UTC, the authoritative completion instant (`DATA_MODEL.md §4`). */
  readonly completedAt: string;
  /** `sales.voided_at` (ISO-8601 UTC) when `status = VOIDED`, else `null`. */
  readonly voidedAt: string | null;
  /** `sales.void_reason` when `status = VOIDED`, else `null`. */
  readonly voidReason: string | null;
  /**
   * IANA zone used to render `completedAt` as a local date/time — the ONE
   * deliberately-live value in the representation. `DATA_MODEL.md §4` requires
   * converting `completed_at` for local display but does not say whether a
   * receipt uses the current or a snapshotted zone; it defines the
   * current-configured-zone / derive-at-query-time rule only for
   * reporting/business-day bucketing. Phase 2E.1 reuses the *currently
   * configured* `business_timezone` as an implementation convention: no timezone
   * snapshot exists, no migration is warranted, the store is a single fixed
   * location, and it stays consistent with the reporting convention. Changing it
   * re-labels the same instant and alters no monetary or historical value.
   */
  readonly businessTimezone: string;
  readonly business: ReceiptBusiness;
  /** `null` when the sale had no customer attached — no placeholder is invented. */
  readonly customer: ReceiptCustomer | null;
  readonly items: readonly ReceiptItem[];
  readonly totals: ReceiptTotals;
  readonly payment: ReceiptPayment;
  /** `sales.receipt_disclaimer_snapshot` — a configured blank is `''` (`§44-49`); never invented text. */
  readonly disclaimer: string;
  /** `sales.receipt_footer_snapshot` — a configured blank is `''` (`§44-49`); never invented text. */
  readonly footer: string;
}
