import { SALE_ITEMS_HEADER, SALES_HEADER } from './exportSerialization';
import { sheetRef } from './sheetsTransport';
import type { SheetsTransport } from './sheetsTransport';

/**
 * Idempotent upsert of one sale into the Sales worksheet and its items into the
 * Sale Items worksheet, keyed by the immutable Sale ID / Sale Item ID
 * (`DATA_MODEL.md §25`; `PRODUCT_SCOPE.md §22.6`; `task §16`-`§18`).
 *
 *  - 0 matches → append the row.
 *  - 1 match   → overwrite the full authoritative row (reverts manual edits).
 *  - >1 match  → overwrite every matching row so external duplicates converge;
 *               a diagnostic warning is emitted. Rows are NEVER deleted.
 *  - Genuinely empty worksheet → write the canonical header row first
 *    (`task §18`); a non-empty sheet's headers are never inferred as authority.
 */

export interface UpsertLog {
  warn(event: string, fields: Record<string, unknown>): void;
}

function matchRows(column: string[][], key: string): number[] {
  const rows: number[] = [];
  for (let i = 0; i < column.length; i += 1) {
    if (column[i]?.[0] === key) {
      rows.push(i + 1); // 1-based sheet row
    }
  }
  return rows;
}

export async function upsertSalesRow(
  transport: SheetsTransport,
  sheetName: string,
  saleId: string,
  row: string[],
  log: UpsertLog,
): Promise<void> {
  const column = await transport.getValues(sheetRef(sheetName, 'A:A'));
  if (column.length === 0) {
    await transport.append(sheetRef(sheetName, 'A1'), [SALES_HEADER as string[]]);
  }
  const matches = matchRows(column, saleId);
  if (matches.length === 0) {
    await transport.append(sheetRef(sheetName, 'A1'), [row]);
    return;
  }
  await transport.batchUpdate(
    matches.map((r) => ({ range: sheetRef(sheetName, `A${String(r)}`), values: [row] })),
  );
  if (matches.length > 1) {
    log.warn('google.export.duplicate_remote_ids', {
      sheet: 'Sales',
      saleId,
      matchCount: matches.length,
    });
  }
}

export async function upsertSaleItemRows(
  transport: SheetsTransport,
  sheetName: string,
  saleId: string,
  rows: string[][],
  log: UpsertLog,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const column = await transport.getValues(sheetRef(sheetName, 'A:A'));
  if (column.length === 0) {
    await transport.append(sheetRef(sheetName, 'A1'), [SALE_ITEMS_HEADER as string[]]);
  }
  const updates: Array<{ range: string; values: string[][] }> = [];
  const appends: string[][] = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = row[0] ?? '';
    const matches = matchRows(column, key);
    if (matches.length === 0) {
      appends.push(row);
    } else {
      for (const r of matches) {
        updates.push({ range: sheetRef(sheetName, `A${String(r)}`), values: [row] });
      }
      if (matches.length > 1) {
        duplicates += 1;
      }
    }
  }
  if (updates.length > 0) {
    await transport.batchUpdate(updates);
  }
  if (appends.length > 0) {
    await transport.append(sheetRef(sheetName, 'A1'), appends);
  }
  if (duplicates > 0) {
    log.warn('google.export.duplicate_remote_ids', {
      sheet: 'Sale Items',
      saleId,
      itemsWithDuplicates: duplicates,
    });
  }
}
