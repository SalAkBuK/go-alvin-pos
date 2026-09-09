import { describe, expect, it } from 'vitest';
import {
  buildSaleItemRows,
  buildSalesRow,
  neutralizeCell,
  SALES_HEADER,
  SALE_ITEMS_HEADER,
} from '../../src/main/google/exportSerialization';
import type { SaleExportRow, SaleItemExportRow } from '../../src/main/google/exportJobRepository';

/**
 * Phase 2J — cell serialization (`DATA_MODEL.md §26`; `REQ-GSHEET-014`;
 * `task §16`-`§19`, `§27` TEST-GSHEET-024/025). Pure string output.
 */

const sale: SaleExportRow = {
  sale_id: 's-1',
  receipt_number: 'GP-000001',
  customer_name_snapshot: 'Sam Buyer',
  customer_phone_snapshot: '(555) 123-4567',
  subtotal_cents: 59900,
  discount_cents: 4900,
  tax_rate_bps: 825,
  tax_cents: 4538,
  total_cents: 59538,
  payment_method_snapshot: 'CASH',
  status: 'COMPLETED',
  sync_version: 1,
  completed_at: '2026-09-08T17:42:00.000Z',
  voided_at: null,
  void_reason: null,
};

const item: SaleItemExportRow = {
  id: 'si-1',
  product_id: 'p-1',
  product_name_snapshot: 'iPhone 15',
  brand_snapshot: 'Apple',
  model_snapshot: 'iPhone 15',
  condition_snapshot: 'NEW',
  sku_snapshot: null,
  barcode_snapshot: null,
  quantity: 2,
  listed_price_cents: 59900,
  sold_price_cents: 55000,
  discount_cents: 9800,
  line_total_cents: 110000,
};

describe('neutralizeCell', () => {
  it('prefixes an apostrophe for = + - @ and leaves everything else', () => {
    expect(neutralizeCell('=1+1')).toBe("'=1+1");
    expect(neutralizeCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(neutralizeCell('-2')).toBe("'-2");
    expect(neutralizeCell('@handle')).toBe("'@handle");
    expect(neutralizeCell('Sam Buyer')).toBe('Sam Buyer');
    expect(neutralizeCell('599.00')).toBe('599.00');
    expect(neutralizeCell('')).toBe('');
  });
});

describe('headers', () => {
  it('are the canonical §26 columns in order', () => {
    expect(SALES_HEADER).toHaveLength(17);
    expect(SALES_HEADER[0]).toBe('Sale ID');
    expect(SALES_HEADER[13]).toBe('Sync Version');
    expect(SALES_HEADER[16]).toBe('Exported At');
    expect(SALE_ITEMS_HEADER).toHaveLength(15);
    expect(SALE_ITEMS_HEADER[0]).toBe('Sale Item ID');
    expect(SALE_ITEMS_HEADER[1]).toBe('Sale ID');
    expect(SALE_ITEMS_HEADER[14]).toBe('Line Total');
  });
});

describe('buildSalesRow', () => {
  it('formats every column; date/time in the business timezone; money non-negative decimals', () => {
    const row = buildSalesRow(sale, 'America/Chicago', '2026-09-08T18:00:00.000Z');
    expect(row).toEqual([
      's-1',
      'GP-000001',
      '2026-09-08',
      '12:42:00',
      'Sam Buyer',
      '(555) 123-4567',
      '599.00',
      '49.00',
      '8.25%',
      '45.38',
      '595.38',
      'Cash',
      'COMPLETED',
      '1',
      '',
      '',
      '2026-09-08T18:00:00.000Z',
    ]);
  });

  it('a VOIDED sale carries status + voided-at + reason', () => {
    const row = buildSalesRow(
      {
        ...sale,
        status: 'VOIDED',
        sync_version: 2,
        voided_at: '2026-09-09T01:00:00.000Z',
        void_reason: 'error',
      },
      'America/Chicago',
      '2026-09-09T02:00:00.000Z',
    );
    expect(row[12]).toBe('VOIDED');
    expect(row[13]).toBe('2');
    expect(row[14]).toBe('2026-09-09T01:00:00.000Z');
    expect(row[15]).toBe('error');
  });

  it('neutralizes a hostile customer name', () => {
    const row = buildSalesRow({ ...sale, customer_name_snapshot: '=HYPERLINK("x")' }, 'UTC', 'x');
    expect(row[4]).toBe('\'=HYPERLINK("x")');
  });
});

describe('buildSaleItemRows', () => {
  it('one 15-column row per item, neutralized, scoped by Sale ID', () => {
    const rows = buildSaleItemRows(sale, [item]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      'si-1',
      's-1',
      'GP-000001',
      'p-1',
      'iPhone 15',
      'Apple',
      'iPhone 15',
      'NEW',
      '',
      '',
      '2',
      '599.00',
      '550.00',
      '98.00',
      '1100.00',
    ]);
  });
});
