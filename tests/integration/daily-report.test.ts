import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDailyReportService } from '../../src/main/reports/dailyReportService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createVoidService } from '../../src/main/void/voidService';
import { createMigratedDb } from '../helpers/database';
import {
  buildCardRequest,
  buildCashRequest,
  seedBusiness,
  seedProduct,
  seedTaxRate,
} from '../helpers/checkout';
import type { CartLineIntent } from '../helpers/checkout';

/**
 * Phase 2K — Daily Report, generated entirely from authoritative local SQLite
 * (`REQ-REPORT-001`-`REQ-REPORT-009`; `POS_WORKFLOWS.md §53`-`§55`;
 * `PRODUCT_SCOPE.md §19`; `DATA_MODEL.md §4`; `TEST-REPORT-001`-`007`,
 * `TEST-OFF-011`, `TEST-VOID-004`, `TEST-HIST-006`). No network, injected clock.
 */

let db: Database.Database;

/** A completed CASH sale whose `completed_at` is exactly `at`. */
function cash(at: string, lines: readonly CartLineIntent[]): string {
  return createSaleService({ db, appVersion: 't', now: () => at }).completeCashSale(
    buildCashRequest(db, lines),
  ).saleId;
}

/** A completed CARD sale whose `completed_at` is exactly `at`. */
function card(at: string, lines: readonly CartLineIntent[]): string {
  const svc = createCardCheckoutService({ db, appVersion: 't', now: () => at });
  const req = buildCardRequest(db, lines);
  svc.beginCard(req);
  return svc.completeCard(req).saleId;
}

function voidSale(at: string, saleId: string): void {
  createVoidService({ db, appVersion: 't', now: () => at }).voidSale({
    saleId,
    reason: 'Rang up in error',
  });
}

function setTimezone(tz: string): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'business_timezone'").run(tz);
}

function report(businessDate: string | null, now = '2026-09-08T18:00:00.000Z') {
  return createDailyReportService({ db, now: () => now }).daily(
    businessDate === null ? {} : { businessDate },
  );
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
  // A large stock so every helper sale succeeds; price is overridden per line.
  seedProduct(db, { quantity: 10_000, sellingPriceCents: 100_000 });
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

const P = () => (db.prepare('SELECT id FROM products LIMIT 1').get() as { id: string }).id;
const line = (soldPriceCents: number, quantity = 1): CartLineIntent => ({
  productId: P(),
  quantity,
  soldPriceCents,
});

// ── TEST-REPORT-001..006 — the locked accounting semantics ───────────────────

describe('TEST-REPORT-001 — completed transaction count (non-voided)', () => {
  it('counts only non-voided COMPLETED sales on the selected business day', () => {
    cash('2026-09-08T13:00:00.000Z', [line(10_000)]);
    cash('2026-09-08T14:00:00.000Z', [line(20_000)]);
    card('2026-09-08T15:00:00.000Z', [line(30_000)]);
    const voided = cash('2026-09-08T16:00:00.000Z', [line(40_000)]);
    voidSale('2026-09-08T17:00:00.000Z', voided);
    // A sale on a different business day must not leak in.
    cash('2026-09-09T13:00:00.000Z', [line(99_000)]);

    const r = report('2026-09-08');
    expect(r.completedTransactionCount).toBe(3);
    expect(r.voidedTransactionCount).toBe(1);
  });
});

describe('TEST-REPORT-002/003/004/005 — gross / discounts / tax / final, voids excluded', () => {
  it('sums the stored snapshot columns for non-voided COMPLETED sales only', () => {
    // list 100_000, sold 90_000 → discount 10_000 per unit.
    cash('2026-09-08T13:00:00.000Z', [line(90_000, 2)]); // gross 200_000, disc 20_000
    card('2026-09-08T14:00:00.000Z', [line(100_000, 1)]); // gross 100_000, disc 0
    const voided = cash('2026-09-08T15:00:00.000Z', [line(50_000, 1)]);
    voidSale('2026-09-08T16:00:00.000Z', voided);

    const rows = db
      .prepare(
        `SELECT status, subtotal_cents, discount_cents, tax_cents, total_cents
           FROM sales ORDER BY completed_at`,
      )
      .all() as Array<{
      status: string;
      subtotal_cents: number;
      discount_cents: number;
      tax_cents: number;
      total_cents: number;
    }>;
    const live = rows.filter((x) => x.status === 'COMPLETED');
    const sum = (k: keyof (typeof live)[number]) =>
      live.reduce((acc, x) => acc + (x[k] as number), 0);

    const r = report('2026-09-08');
    expect(r.grossSalesCents).toBe(sum('subtotal_cents'));
    expect(r.discountCents).toBe(sum('discount_cents'));
    expect(r.taxCents).toBe(sum('tax_cents'));
    expect(r.totalSalesCents).toBe(sum('total_cents'));
    // The voided sale contributed to none of them.
    expect(r.grossSalesCents).toBeGreaterThan(0);
    expect(rows.some((x) => x.status === 'VOIDED')).toBe(true);
  });
});

describe('TEST-REPORT-006 — cash / card breakdown; sum equals final sales', () => {
  it('separates the totals and cash + card === final sales', () => {
    cash('2026-09-08T13:00:00.000Z', [line(70_000)]);
    cash('2026-09-08T14:00:00.000Z', [line(30_000)]);
    card('2026-09-08T15:00:00.000Z', [line(90_000)]);
    const voidedCard = card('2026-09-08T16:00:00.000Z', [line(12_345)]);
    voidSale('2026-09-08T17:00:00.000Z', voidedCard);

    const r = report('2026-09-08');
    const cashTotal = (
      db
        .prepare(
          "SELECT COALESCE(SUM(total_cents),0) t FROM sales WHERE status='COMPLETED' AND payment_method_snapshot='CASH'",
        )
        .get() as { t: number }
    ).t;
    const cardTotal = (
      db
        .prepare(
          "SELECT COALESCE(SUM(total_cents),0) t FROM sales WHERE status='COMPLETED' AND payment_method_snapshot='CARD'",
        )
        .get() as { t: number }
    ).t;
    expect(r.cashTotalCents).toBe(cashTotal);
    expect(r.cardTotalCents).toBe(cardTotal);
    // edge test 11 — V1 payment methods are exactly CASH | CARD.
    expect(r.cashTotalCents + r.cardTotalCents).toBe(r.totalSalesCents);
  });
});

// ── TEST-REPORT-007 / TEST-OFF-011 — Google export independence, offline ─────

describe('TEST-REPORT-007 / TEST-OFF-011 — pending Google exports & offline', () => {
  it('local completed sales are all included regardless of export state, with fetch forced to throw', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('no network in a report test');
    });
    const a = cash('2026-09-08T13:00:00.000Z', [line(10_000)]);
    const b = cash('2026-09-08T13:30:00.000Z', [line(20_000)]);
    cash('2026-09-08T14:00:00.000Z', [line(30_000)]);
    card('2026-09-08T14:30:00.000Z', [line(40_000)]);

    // 2 of the 4 jobs are still pending / failed — must not change the report.
    db.prepare("UPDATE google_sheet_export_jobs SET status='FAILED' WHERE sale_id=?").run(a);
    db.prepare("UPDATE google_sheet_export_jobs SET status='EXPORTING' WHERE sale_id=?").run(b);

    const r = report('2026-09-08');
    expect(r.completedTransactionCount).toBe(4);
    const expected = (
      db
        .prepare("SELECT COALESCE(SUM(total_cents),0) t FROM sales WHERE status='COMPLETED'")
        .get() as { t: number }
    ).t;
    expect(r.totalSalesCents).toBe(expected);
  });
});

// ── TEST-VOID-004 / REQ-REPORT-009 — late-void attribution ──────────────────

describe('TEST-VOID-004 — report correction and visibility across a late void', () => {
  it("a Monday sale voided Wednesday leaves Monday's revenue corrected and Wednesday untouched", () => {
    const monday = '2026-09-07T14:00:00.000Z'; // Mon, business date 2026-09-07
    const wednesday = '2026-09-09T15:00:00.000Z';
    const saleId = cash(monday, [line(90_000)]);
    // An unrelated Wednesday sale so Wednesday's report is non-empty either way.
    cash('2026-09-09T13:00:00.000Z', [line(25_000)]);

    const mondayBefore = report('2026-09-07');
    expect(mondayBefore.completedTransactionCount).toBe(1);
    expect(mondayBefore.totalSalesCents).toBeGreaterThan(0);
    expect(mondayBefore.voidedTransactionCount).toBe(0);
    const wednesdayBefore = report('2026-09-09');

    voidSale(wednesday, saleId);

    const mondayAfter = report('2026-09-07');
    expect(mondayAfter.completedTransactionCount).toBe(0);
    expect(mondayAfter.grossSalesCents).toBe(0);
    expect(mondayAfter.discountCents).toBe(0);
    expect(mondayAfter.taxCents).toBe(0);
    expect(mondayAfter.totalSalesCents).toBe(0);
    expect(mondayAfter.cashTotalCents).toBe(0);
    expect(mondayAfter.cardTotalCents).toBe(0);
    // still visible, separately, on its ORIGINAL business day
    expect(mondayAfter.voidedTransactionCount).toBe(1);

    // Wednesday's revenue is unchanged — no negative adjustment on the void date.
    const wednesdayAfter = report('2026-09-09');
    expect(wednesdayAfter.totalSalesCents).toBe(wednesdayBefore.totalSalesCents);
    expect(wednesdayAfter.completedTransactionCount).toBe(
      wednesdayBefore.completedTransactionCount,
    );
    expect(wednesdayAfter.voidedTransactionCount).toBe(0);

    // The transaction and its VOIDED status are retained in the sales table.
    expect(db.prepare('SELECT status FROM sales WHERE id=?').get(saleId)).toEqual({
      status: 'VOIDED',
    });
  });
});

// ── Additional required edge tests ─────────────────────────────────────────

describe('edge — empty day, customer attachment, created_at vs completed_at', () => {
  it('1. an empty selected day is valid and all-zero', () => {
    const r = report('2026-01-01');
    expect(r).toMatchObject({
      completedTransactionCount: 0,
      voidedTransactionCount: 0,
      grossSalesCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalSalesCents: 0,
      cashTotalCents: 0,
      cardTotalCents: 0,
    });
    for (const v of Object.values(r)) {
      expect(v === null || v === undefined || Number.isNaN(v as number)).toBe(false);
    }
  });

  it('2. a customerless sale is included normally', () => {
    cash('2026-09-08T13:00:00.000Z', [line(10_000)]); // buildCashRequest attaches no customer
    const r = report('2026-09-08');
    expect(r.completedTransactionCount).toBe(1);
    expect(r.totalSalesCents).toBeGreaterThan(0);
  });

  it('3. reporting uses completed_at, never created_at', () => {
    // Force created_at (checkout began) onto a different business day than completed_at.
    const saleId = cash('2026-09-08T13:00:00.000Z', [line(10_000)]);
    db.prepare("UPDATE sales SET created_at='2026-09-05T09:00:00.000Z' WHERE id=?").run(saleId);
    expect(report('2026-09-05').completedTransactionCount).toBe(0);
    expect(report('2026-09-08').completedTransactionCount).toBe(1);
  });
});

describe('edge — timezone boundaries (America/Chicago, CDT = UTC-5 in September)', () => {
  it('4. UTC calendar date differs from the Chicago business date — local wins', () => {
    // 02:00Z on 09-07 (UTC) is 21:00 on 09-06 in Chicago.
    cash('2026-09-07T02:00:00.000Z', [line(10_000)]);
    expect(report('2026-09-07').completedTransactionCount).toBe(0); // UTC date, wrong
    expect(report('2026-09-06').completedTransactionCount).toBe(1); // Chicago date, right
  });

  it('5. sales just before and just after Chicago midnight land on different report days', () => {
    cash('2026-09-07T04:30:00.000Z', [line(11_100)]); // 23:30 CDT 09-06
    cash('2026-09-07T05:30:00.000Z', [line(22_200)]); // 00:30 CDT 09-07
    expect(report('2026-09-06').completedTransactionCount).toBe(1);
    expect(report('2026-09-07').completedTransactionCount).toBe(1);
    expect(report('2026-09-06').totalSalesCents).not.toBe(report('2026-09-07').totalSalesCents);
  });

  it('6. DST spring-forward day (2026-03-08) — deterministic attribution', () => {
    cash('2026-03-08T07:00:00.000Z', [line(10_000)]); // 01:00 CST
    cash('2026-03-08T09:00:00.000Z', [line(20_000)]); // 03:00 CDT (02:00–03:00 local skipped)
    const r = report('2026-03-08');
    expect(r.completedTransactionCount).toBe(2);
    expect(report('2026-03-07').completedTransactionCount).toBe(0);
    expect(report('2026-03-09').completedTransactionCount).toBe(0);
  });

  it('7. DST fall-back day (2026-11-01) — the repeated local hour is not double-counted or misbucketed', () => {
    cash('2026-11-01T06:30:00.000Z', [line(10_000)]); // 01:30 CDT (first pass)
    cash('2026-11-01T07:30:00.000Z', [line(20_000)]); // 01:30 CST (second pass)
    const r = report('2026-11-01');
    expect(r.completedTransactionCount).toBe(2);
    expect(report('2026-10-31').completedTransactionCount).toBe(0);
    expect(report('2026-11-02').completedTransactionCount).toBe(0);
  });
});

describe('edge — current business day & timezone changes', () => {
  it('8. the default (no date) uses the configured timezone, not the UTC/machine date', () => {
    cash('2026-09-07T02:00:00.000Z', [line(10_000)]); // Chicago business date 2026-09-06
    // "now" is 02:00Z on 09-07 → Chicago 21:00 on 09-06 → current business day 2026-09-06.
    const r = createDailyReportService({
      db,
      now: () => '2026-09-07T02:00:00.000Z',
    }).daily({});
    expect(r.businessDate).toBe('2026-09-06');
    expect(r.isToday).toBe(true);
    expect(r.completedTransactionCount).toBe(1);
  });

  it('9. changing business_timezone re-buckets historical sales at query time', () => {
    cash('2026-09-07T02:00:00.000Z', [line(10_000)]);
    expect(report('2026-09-06').completedTransactionCount).toBe(1); // Chicago
    expect(report('2026-09-07').completedTransactionCount).toBe(0);

    setTimezone('UTC');
    expect(report('2026-09-06').completedTransactionCount).toBe(0);
    expect(report('2026-09-07').completedTransactionCount).toBe(1); // now UTC calendar day
    expect(report('2026-09-07').businessTimezone).toBe('UTC');
  });

  it('10. a late void changes the ORIGINAL day; the void date gets no negative adjustment', () => {
    const saleId = cash('2026-09-06T20:00:00.000Z', [line(90_000)]); // Chicago 15:00 09-06
    expect(report('2026-09-06').totalSalesCents).toBeGreaterThan(0);
    voidSale('2026-09-10T18:00:00.000Z', saleId); // voided_at business date 2026-09-10
    expect(report('2026-09-06').totalSalesCents).toBe(0);
    expect(report('2026-09-06').voidedTransactionCount).toBe(1);
    // Nothing negative anywhere on the void date.
    expect(report('2026-09-10').totalSalesCents).toBe(0);
    expect(report('2026-09-10').completedTransactionCount).toBe(0);
    expect(report('2026-09-10').voidedTransactionCount).toBe(0);
  });
});

describe('edge — large values, Google down, restart, DTO shape', () => {
  it('12. large but valid integer-cent values aggregate exactly', () => {
    cash('2026-09-08T13:00:00.000Z', [line(9_000_000)]);
    cash('2026-09-08T14:00:00.000Z', [line(8_500_000)]);
    card('2026-09-08T15:00:00.000Z', [line(7_250_000)]);
    const expectedTotal = (
      db.prepare("SELECT SUM(total_cents) t FROM sales WHERE status='COMPLETED'").get() as {
        t: number;
      }
    ).t;
    const r = report('2026-09-08');
    expect(r.totalSalesCents).toBe(expectedTotal);
    expect(Number.isSafeInteger(r.totalSalesCents)).toBe(true);
    expect(r.cashTotalCents + r.cardTotalCents).toBe(r.totalSalesCents);
  });

  it('13. Google completely unavailable — report still works', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    cash('2026-09-08T13:00:00.000Z', [line(10_000)]);
    expect(report('2026-09-08').completedTransactionCount).toBe(1);
  });

  it('15. the DTO carries only primitive values — no DB handle or raw statement', () => {
    cash('2026-09-08T13:00:00.000Z', [line(10_000)]);
    const r = report('2026-09-08');
    expect(Object.keys(r).sort()).toEqual(
      [
        'businessDate',
        'businessTimezone',
        'isToday',
        'completedTransactionCount',
        'voidedTransactionCount',
        'grossSalesCents',
        'discountCents',
        'taxCents',
        'totalSalesCents',
        'cashTotalCents',
        'cardTotalCents',
      ].sort(),
    );
    for (const value of Object.values(r)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });
});

describe('edge 14 — app restart yields the same report from the same SQLite data', () => {
  it('a file-backed DB closed and reopened produces an identical report', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gpp-report-'));
    const file = join(dir, 'pos.sqlite');
    let firstReport;
    try {
      {
        const first = await createMigratedDb(file);
        const savedDb = db;
        db = first;
        seedTaxRate(first);
        seedBusiness(first);
        seedProduct(first, { quantity: 100, sellingPriceCents: 100_000 });
        cash('2026-09-08T13:00:00.000Z', [line(30_000)]);
        card('2026-09-08T14:00:00.000Z', [line(45_000)]);
        const voided = cash('2026-09-08T15:00:00.000Z', [line(12_000)]);
        voidSale('2026-09-08T16:00:00.000Z', voided);
        firstReport = report('2026-09-08');
        first.close();
        db = savedDb;
      }
      const reopened = await createMigratedDb(file);
      const savedDb = db;
      db = reopened;
      try {
        expect(report('2026-09-08')).toEqual(firstReport);
      } finally {
        reopened.close();
        db = savedDb;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
