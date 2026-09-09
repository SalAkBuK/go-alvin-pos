import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrintingService } from '../../src/main/printing/printingService';
import { renderReceiptDocument } from '../../src/main/printing/receiptDocument';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { readSelectedPrinter } from '../../src/main/settings/printerSettingsRepository';
import { createVoidService } from '../../src/main/void/voidService';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import {
  auditCounter,
  buildCashRequest,
  countRows,
  productQuantity,
  receiptCounter,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
  T2,
} from '../helpers/checkout';
import { DEFAULT_PRINTER, fakePrintAdapter, printerDevice } from '../helpers/printing';

/**
 * Phase 2I — Physical Printing & Receipt Reprint.
 *
 * `TEST-PRINT-001`-`007`, `REQ-REC-004`-`REQ-REC-005`, `REQ-PRINT-001`-`005`,
 * `REQ-OFF-007`, `ACCEPT-007` (automated portion). The Electron/Windows print
 * boundary is a fake adapter (`task §6`); `HW-PRINT-001`-`004` remain manual.
 */

let db: Database.Database;

function sale(now: () => string = () => T0) {
  return createSaleService({ db, appVersion: 'test-2i', now });
}

function completeSale(
  lines: Parameters<typeof buildCashRequest>[1],
  options: { customerId?: string | null } = {},
  now: () => string = () => T0,
) {
  return sale(now).completeCashSale(buildCashRequest(db, lines, options));
}

function selectPrinter(deviceName: string, at = T0): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('selected_printer', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(deviceName, at);
}

/** A snapshot of every mutable business table + the two counters. */
function businessSnapshot(): Record<string, number> {
  return {
    sales: countRows(db, 'sales'),
    sale_items: countRows(db, 'sale_items'),
    payments: countRows(db, 'payments'),
    inventory_movements: countRows(db, 'inventory_movements'),
    google_sheet_export_jobs: countRows(db, 'google_sheet_export_jobs'),
    audit_events: countRows(db, 'audit_events'),
    checkout_requests: countRows(db, 'checkout_requests'),
    settings: countRows(db, 'settings'),
    receipt_counter: receiptCounter(db),
    audit_counter: auditCounter(db),
  };
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-PRINT-001 — basic print', () => {
  it('rebuilds the sale from stored snapshots, prints once, mutates nothing', async () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    const before = businessSnapshot();

    const printed = await createPrintingService({
      db,
      adapter,
      now: () => T1,
    }).printReceipt(result.saleId);

    expect(printed).toEqual({
      saleId: result.saleId,
      receiptNumber: 'GP-000001',
      deviceName: DEFAULT_PRINTER.deviceName,
      voided: false,
      acceptedAt: T1,
    });

    // The correct receipt representation reached the print boundary.
    expect(adapter.jobs).toHaveLength(1);
    const job = adapter.jobs[0]!;
    expect(job.deviceName).toBe(DEFAULT_PRINTER.deviceName);
    const expectedHtml = renderReceiptDocument(
      createReceiptService({ db }).getBySaleId(result.saleId),
    );
    expect(job.html).toBe(expectedHtml);
    expect(job.html).toContain('GP-000001');
    expect(job.html).toContain('Go Phones - Alvin');

    // Nothing was written.
    expect(businessSnapshot()).toEqual(before);
  });
});

describe('TEST-PRINT-002 — printer disconnected / failure isolation', () => {
  it('a print failure is reported separately and the committed sale is untouched', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    adapter.failPrintTimes = 1;
    const before = businessSnapshot();

    await expect(
      createPrintingService({ db, adapter }).printReceipt(result.saleId),
    ).rejects.toMatchObject({ code: 'PRINT_FAILED' });

    const row = db.prepare('SELECT status FROM sales WHERE id = ?').get(result.saleId) as {
      status: string;
    };
    expect(row.status).toBe('COMPLETED');
    expect(productQuantity(db, p.id)).toBe(4);
    expect(businessSnapshot()).toEqual(before);
  });

  it('a printer missing from the enumeration is PRINTER_UNAVAILABLE, not PRINT_FAILED', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    selectPrinter('Some_Removed_Printer');

    const adapter = fakePrintAdapter([DEFAULT_PRINTER]); // selected one not present
    await expect(
      createPrintingService({ db, adapter }).printReceipt(result.saleId),
    ).rejects.toMatchObject({ code: 'PRINTER_UNAVAILABLE' });
    expect(adapter.jobs).toHaveLength(0);
  });

  it('no selected printer is PRINTER_NOT_CONFIGURED and never invalidates the sale', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);

    const adapter = fakePrintAdapter();
    await expect(
      createPrintingService({ db, adapter }).printReceipt(result.saleId),
    ).rejects.toMatchObject({ code: 'PRINTER_NOT_CONFIGURED' });
    const row = db.prepare('SELECT status FROM sales WHERE id = ?').get(result.saleId) as {
      status: string;
    };
    expect(row.status).toBe('COMPLETED');
  });
});

describe('TEST-PRINT-003 — reprint after printer recovery', () => {
  it('a first failed print then a successful reprint creates no duplicate sale or receipt', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    adapter.failPrintTimes = 1;
    const service = createPrintingService({ db, adapter });
    const before = businessSnapshot();

    await expect(service.printReceipt(result.saleId)).rejects.toMatchObject({
      code: 'PRINT_FAILED',
    });
    const second = await service.printReceipt(result.saleId);
    expect(second.receiptNumber).toBe('GP-000001');
    expect(adapter.jobs).toHaveLength(1);

    // Same single sale, same single receipt number, nothing new.
    expect(businessSnapshot()).toEqual(before);
    expect(countRows(db, 'sales')).toBe(1);
  });
});

describe('TEST-PRINT-004 — wrong / unavailable selected printer', () => {
  it('persists the chosen identity but a later print reports a meaningful failure', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);

    const adapter = fakePrintAdapter([DEFAULT_PRINTER, printerDevice('OneNote')]);
    const service = createPrintingService({ db, adapter, now: () => T1 });

    const config = await service.selectPrinter({ deviceName: 'OneNote' });
    expect(config.selectedDeviceName).toBe('OneNote');
    expect(readSelectedPrinter(db)).toBe('OneNote');

    // Printer then disappears from the OS.
    adapter.printers = [DEFAULT_PRINTER];
    await expect(service.printReceipt(result.saleId)).rejects.toMatchObject({
      code: 'PRINTER_UNAVAILABLE',
    });
    const row = db.prepare('SELECT status FROM sales WHERE id = ?').get(result.saleId) as {
      status: string;
    };
    expect(row.status).toBe('COMPLETED');
  });
});

describe('TEST-PRINT-005 — historical receipt integrity', () => {
  it('reprint stays based on stored snapshots after products / customer / business / tax change', async () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Original Name',
      phone: '111-1111',
    });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
      customerId: customer.id,
    });
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    const service = createPrintingService({ db, adapter });
    await service.printReceipt(result.saleId);
    const firstHtml = adapter.jobs[0]!.html;

    createProductService({ db, now: () => T1 }).update(p.id, {
      name: 'iPhone 15 Clearance',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'USED',
      sellingPriceCents: 40000,
      costPriceCents: null,
      sku: null,
      barcode: null,
      lowStockThreshold: null,
    });
    createCustomerService({ db, now: () => T1 }).update(customer.id, {
      name: 'Changed Name',
      phone: '999-9999',
    });
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 600,
    });
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateBusinessConfig({
      businessAddress: 'NEW ADDRESS 456',
      businessPhone: '(555) 999-0000',
      receiptDisclaimer: 'NEW DISCLAIMER',
      receiptFooter: 'NEW FOOTER',
    });

    await service.printReceipt(result.saleId);
    const secondHtml = adapter.jobs[1]!.html;

    expect(secondHtml).toBe(firstHtml);
    expect(secondHtml).toContain('iPhone 15 128GB');
    expect(secondHtml).toContain('Original Name');
    expect(secondHtml).toContain('123 Main St, Alvin, TX 77511');
    expect(secondHtml).toContain('All sales final. 30-day warranty on refurbished devices.');
    expect(secondHtml).not.toContain('NEW ADDRESS 456');
    expect(secondHtml).not.toContain('Changed Name');
  });
});

describe('TEST-PRINT-006 — restart before reprint (file-backed DB)', () => {
  it('the selected printer and the historical receipt both survive a close / reopen', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gpp-print-'));
    const file = join(dir, 'pos.sqlite');

    let saleId: string;
    let receiptNumber: string;
    {
      const first = await createMigratedDb(file);
      seedTaxRate(first);
      seedBusiness(first);
      const p = createProductService({ db: first, now: () => T0 }).create({
        name: 'Reopen Phone',
        brand: 'Apple',
        model: 'iPhone 15',
        condition: 'NEW',
        sellingPriceCents: 59900,
        quantity: 3,
      });
      const review = buildCashRequest(first, [
        { productId: p.id, quantity: 1, soldPriceCents: 59900 },
      ]);
      const r = createSaleService({ db: first, appVersion: 't', now: () => T0 }).completeCashSale(
        review,
      );
      saleId = r.saleId;
      receiptNumber = r.receiptNumber;
      createPrintingService({ db: first, adapter: fakePrintAdapter() });
      first
        .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('selected_printer', ?, ?)`)
        .run(DEFAULT_PRINTER.deviceName, T0);
      first.close();
    }

    const reopened = await createMigratedDb(file);
    try {
      expect(readSelectedPrinter(reopened)).toBe(DEFAULT_PRINTER.deviceName);
      const adapter = fakePrintAdapter();
      const printed = await createPrintingService({
        db: reopened,
        adapter,
        now: () => T2,
      }).printReceipt(saleId);
      expect(printed.receiptNumber).toBe(receiptNumber);
      expect(adapter.jobs[0]!.html).toContain('Reopen Phone');
      expect(adapter.jobs[0]!.html).toContain(receiptNumber);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TEST-PRINT-007 — full receipt field verification', () => {
  it('every REQ-REC-002 field reaches the printed document', async () => {
    const a = seedProduct(db, { name: 'iPhone 15', sellingPriceCents: 59900, quantity: 9 });
    const b = seedProduct(db, { name: 'Pixel 9', sellingPriceCents: 50000, quantity: 9 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Pat Customer',
      phone: '555-9000',
    });
    const result = completeSale(
      [
        { productId: a.id, quantity: 1, soldPriceCents: 55000 }, // negotiated + discount
        { productId: b.id, quantity: 2, soldPriceCents: 52500 },
      ],
      { customerId: customer.id },
    );
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    await createPrintingService({ db, adapter }).printReceipt(result.saleId);
    const html = adapter.jobs[0]!.html;

    for (const fragment of [
      'Go Phones - Alvin',
      '123 Main St, Alvin, TX 77511',
      '(281) 555-0100',
      'GP-000001',
      'Pat Customer',
      '555-9000',
      'iPhone 15',
      'Pixel 9',
      'Qty 1 × $550.00',
      'Qty 2 × $525.00',
      'List: $599.00',
      'Discount: $49.00',
      'Subtotal',
      'Tax (8.25%)',
      'Total',
      'Payment: Cash',
      'All sales final. 30-day warranty on refurbished devices.',
      'Thank you for shopping with Go Phones!',
    ]) {
      expect(html).toContain(fragment);
    }
    // A local date label, not a raw ISO string.
    expect(html).toContain('Sep 8, 2026');
  });
});

describe('VOIDED receipt printing (task §8, §18)', () => {
  it('a voided sale still prints and clearly shows VOIDED + reason', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    createVoidService({ db, appVersion: 't' }).voidSale({
      saleId: result.saleId,
      reason: 'Rang up in error',
    });
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const adapter = fakePrintAdapter();
    const printed = await createPrintingService({ db, adapter }).printReceipt(result.saleId);
    expect(printed.voided).toBe(true);
    const html = adapter.jobs[0]!.html;
    expect(html).toContain('VOIDED');
    expect(html).toContain('Rang up in error');
  });
});

describe('offline / no-network on the print path (REQ-OFF-007)', () => {
  it('a print performs no fetch and touches no network global', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    selectPrinter(DEFAULT_PRINTER.deviceName);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      throw new Error(`network access is forbidden on the print path: ${String(args[0])}`);
    }) as typeof globalThis.fetch;
    try {
      const adapter = fakePrintAdapter();
      await createPrintingService({ db, adapter }).printReceipt(result.saleId);
      expect(fetchCalls).toBe(0);
      expect(adapter.jobs[0]!.html).not.toMatch(/https?:\/\//);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('selectPrinter side effects', () => {
  it('writes only settings.selected_printer — no audit event, no sale change', async () => {
    const p = seedProduct(db, { quantity: 5 });
    completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const before = businessSnapshot();

    const adapter = fakePrintAdapter([DEFAULT_PRINTER]);
    await createPrintingService({ db, adapter, now: () => T1 }).selectPrinter({
      deviceName: DEFAULT_PRINTER.deviceName,
    });

    const after = businessSnapshot();
    expect(after.audit_events).toBe(before.audit_events);
    expect(after.audit_counter).toBe(before.audit_counter);
    expect(after.sales).toBe(before.sales);
    // Exactly one settings row was added (`selected_printer`).
    expect(after.settings).toBe((before.settings ?? 0) + 1);
    expect(readSelectedPrinter(db)).toBe(DEFAULT_PRINTER.deviceName);
  });

  it('rejects a blank / malformed selection and an unknown Sale ID', async () => {
    const adapter = fakePrintAdapter();
    const service = createPrintingService({ db, adapter });
    await expect(service.selectPrinter({ deviceName: '  ' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(service.selectPrinter({ nope: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    selectPrinter(DEFAULT_PRINTER.deviceName);
    try {
      await service.printReceipt('does-not-exist');
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('RECEIPT_NOT_FOUND');
    }
  });
});
