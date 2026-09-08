import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createCheckoutService } from '../../src/main/checkout/checkoutService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import type { CompleteCashSaleRequest } from '../../src/shared/checkout';
import type { CreateProductInput } from '../../src/shared/products';

/**
 * Shared fixtures for the Phase 2E Cash-checkout integration suites. Everything
 * runs against a real migrated SQLite database via `createMigratedDb`.
 */

export const T0 = '2026-09-08T12:00:00.000Z';
export const T1 = '2026-09-08T15:30:00.000Z';
export const T2 = '2026-09-09T09:00:00.000Z';

export function seedTaxRate(db: Database.Database, bps = 825, at = T0): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('tax_rate_bps', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(bps), at);
}

export function seedBusiness(db: Database.Database, at = T0): void {
  createSettingsService({ db, appVersion: 'test', now: () => at }).updateBusinessConfig({
    businessAddress: '123 Main St, Alvin, TX 77511',
    businessPhone: '(281) 555-0100',
    receiptDisclaimer: 'All sales final. 30-day warranty on refurbished devices.',
    receiptFooter: 'Thank you for shopping with Go Phones!',
  });
}

export function seedProduct(
  db: Database.Database,
  overrides: Partial<CreateProductInput> = {},
  at = T0,
) {
  return createProductService({ db, now: () => at }).create({
    name: 'iPhone 15 128GB',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity: 5,
    ...overrides,
  });
}

export interface CartLineIntent {
  readonly productId: string;
  readonly quantity: number;
  readonly soldPriceCents: number;
}

/**
 * Run a trusted review for the given intent and return a ready
 * `checkout:complete-cash` payload (fresh `requestId`, the trusted fingerprint,
 * and the echoed intent) — exactly what the renderer would send.
 */
export function buildCashRequest(
  db: Database.Database,
  lines: readonly CartLineIntent[],
  options: { readonly customerId?: string | null } = {},
): CompleteCashSaleRequest {
  const checkout = {
    customerId: options.customerId ?? null,
    paymentMethod: 'CASH' as const,
    lines: lines.map((l) => ({ ...l })),
  };
  const review = createCheckoutService({ db }).review(checkout);
  return { requestId: randomUUID(), reviewedFingerprint: review.fingerprint, checkout };
}

export function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

export function receiptCounter(db: Database.Database): number {
  return (
    db.prepare("SELECT value FROM counters WHERE key = 'receipt_number'").get() as { value: number }
  ).value;
}

export function auditCounter(db: Database.Database): number {
  return (
    db.prepare("SELECT value FROM counters WHERE key = 'audit_sequence'").get() as { value: number }
  ).value;
}

export function productQuantity(db: Database.Database, productId: string): number {
  return (
    db.prepare('SELECT quantity_on_hand n FROM products WHERE id = ?').get(productId) as {
      n: number;
    }
  ).n;
}

export function auditRows(
  db: Database.Database,
  eventType: string,
): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM audit_events WHERE event_type = ? ORDER BY sequence')
    .all(eventType) as Array<Record<string, unknown>>;
}
