import { describe, expect, it } from 'vitest';
import { provisionSpreadsheet } from '../../src/main/google/spreadsheetProvisioning';
import { GoogleApiError } from '../../src/main/google/googleRedaction';
import { SALES_HEADER, SALE_ITEMS_HEADER } from '../../src/main/google/exportSerialization';
import { sheetRef } from '../../src/main/google/sheetsTransport';
import { fakeDrive, fakeSheetsStructure } from '../helpers/google';
import type { FakeDrive, FakeStructure } from '../helpers/google';

/**
 * Phase 2J.1 — the LOCKED provisioning mechanism (`ARCHITECTURE.md §27.5.1`;
 * `TEST-GSHEET-039`, `-040`, `-047`, `-048`, `-049`).
 */

const TOKEN = 'prov-abc';

function run(drive: FakeDrive, structures = new Map<string, FakeStructure>()) {
  return provisionSpreadsheet({
    drive,
    provisioningToken: TOKEN,
    makeStructureTransport: (id: string) => {
      let s = structures.get(id);
      if (!s) {
        s = fakeSheetsStructure([{ title: 'Sheet1' }]);
        structures.set(id, s);
      }
      return s;
    },
  });
}

describe('lookup before create; single tagged files.create (TEST-GSHEET-039)', () => {
  it('no match → one files.create carrying name + MIME + appProperties, then READY', async () => {
    const drive = fakeDrive();
    const result = await run(drive);
    expect(result.outcome).toBe('ready');
    expect(drive.calls.list).toBeGreaterThanOrEqual(1);
    expect(drive.calls.create).toBe(1);
    const created = drive.files[0]!;
    expect(created.appProperties['goPhonesPosIntegration']).toBe('salesSpreadsheet');
    expect(created.appProperties['goPhonesPosProvisioningToken']).toBe(TOKEN);
  });

  it('exactly one existing match → adopt, no create', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'existing-1');
    const result = await run(drive);
    expect(result).toMatchObject({ outcome: 'ready', spreadsheetId: 'existing-1' });
    expect(drive.calls.create).toBe(0);
  });
});

describe('worksheet convergence is idempotent (TEST-GSHEET-040)', () => {
  it('renames the default tab to Sales, adds Sale Items, writes + verifies both headers', async () => {
    const drive = fakeDrive();
    const structures = new Map<string, FakeStructure>();
    const result = await run(drive, structures);
    expect(result.outcome).toBe('ready');
    const s = [...structures.values()][0]!;
    const titles = s.worksheets.map((w) => w.title).sort();
    expect(titles).toEqual(['Sale Items', 'Sales']);
    expect(s.worksheets.find((w) => w.title === 'Sales')!.header).toEqual([...SALES_HEADER]);
    expect(s.worksheets.find((w) => w.title === 'Sale Items')!.header).toEqual([
      ...SALE_ITEMS_HEADER,
    ]);
    expect(s.calls.rename).toBe(1);
    expect(s.calls.add).toBe(1);

    // Re-run against the same structure — no new tabs, no duplicate headers.
    const before = { add: s.calls.add, rename: s.calls.rename, writeHeader: s.calls.writeHeader };
    await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      makeStructureTransport: () => s,
    });
    expect(s.calls.add).toBe(before.add);
    expect(s.calls.rename).toBe(before.rename);
    expect(s.calls.writeHeader).toBe(before.writeHeader);
    expect(s.worksheets.filter((w) => w.title === 'Sales')).toHaveLength(1);
    expect(s.worksheets.filter((w) => w.title === 'Sale Items')).toHaveLength(1);
  });

  it('an adopted spreadsheet with extra user tabs keeps them and only adds the missing canonical', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'adopted-x');
    const structure = fakeSheetsStructure([
      { title: 'My Notes' },
      { title: 'Sales', header: [...SALES_HEADER] },
    ]);
    const result = await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      makeStructureTransport: () => structure,
    });
    expect(result.outcome).toBe('ready');
    expect(structure.worksheets.map((w) => w.title).sort()).toEqual([
      'My Notes',
      'Sale Items',
      'Sales',
    ]);
    expect(structure.calls.rename).toBe(0);
  });
});

describe('ambiguous create (TEST-GSHEET-047, -048)', () => {
  it('an unknownOutcome create error re-runs the lookup once and adopts if now discoverable', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      drive.seedProvisioned(TOKEN, 'adopted-after-ambiguous');
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const result = await run(drive);
    expect(result).toMatchObject({ outcome: 'ready', spreadsheetId: 'adopted-after-ambiguous' });
    expect(drive.calls.create).toBe(1);
  });

  it('an unknownOutcome create that stays unconfirmed → incomplete (no second create)', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const result = await run(drive);
    expect(result.outcome).toBe('incomplete');
    expect(drive.calls.create).toBe(1);
  });

  it('a definite create failure → incomplete', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      throw new GoogleApiError('PERMISSION', 'forbidden', { httpStatus: 403 });
    };
    const result = await run(drive);
    expect(result.outcome).toBe('incomplete');
  });
});

describe('multiple matches → safe stop (TEST-GSHEET-049)', () => {
  it('never creates, never deletes, never selects', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'a');
    drive.seedProvisioned(TOKEN, 'b');
    const result = await run(drive);
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') {
      expect(result.reason).toMatch(/more than one/i);
    }
    expect(drive.calls.create).toBe(0);
    expect(drive.files).toHaveLength(2);
  });
});

describe('create-attempt marker ordering (Correction B crash boundary)', () => {
  it('onCreateAttempt fires exactly once, BEFORE the Drive files.create request', async () => {
    const drive = fakeDrive();
    const order: string[] = [];
    drive.onCreate = () => order.push('create');
    await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      makeStructureTransport: () => fakeSheetsStructure([{ title: 'Sheet1' }]),
      onCreateAttempt: () => {
        order.push('marker');
      },
    });
    expect(order).toEqual(['marker', 'create']);
  });

  it('onCreateAttempt is NOT called when an existing spreadsheet is adopted', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'existing-1');
    let marked = 0;
    await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      makeStructureTransport: () =>
        fakeSheetsStructure([{ title: 'Sales' }, { title: 'Sale Items' }]),
      onCreateAttempt: () => {
        marked += 1;
      },
    });
    expect(marked).toBe(0);
    expect(drive.calls.create).toBe(0);
  });
});

describe('bounded startup recovery — allowCreate:false (TEST-GSHEET-051, -052)', () => {
  it('exactly one match → adopt + converge + READY, no create', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'remote-1');
    const structure = fakeSheetsStructure([{ title: 'Sheet1' }]);
    const result = await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      allowCreate: false,
      makeStructureTransport: () => structure,
    });
    expect(result).toMatchObject({ outcome: 'ready', spreadsheetId: 'remote-1' });
    expect(drive.calls.create).toBe(0);
  });

  it('zero matches → incomplete, NO files.create, NO worksheet mutation', async () => {
    const drive = fakeDrive();
    const structure = fakeSheetsStructure([{ title: 'Sheet1' }]);
    let marked = 0;
    const result = await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      allowCreate: false,
      onCreateAttempt: () => {
        marked += 1;
      },
      makeStructureTransport: () => structure,
    });
    expect(result.outcome).toBe('incomplete');
    expect(drive.calls.create).toBe(0);
    expect(marked).toBe(0);
    expect(structure.calls.add).toBe(0);
    expect(structure.calls.rename).toBe(0);
    expect(structure.calls.writeHeader).toBe(0);
  });

  it('more than one match → incomplete, safe stop, no selection/deletion/create', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned(TOKEN, 'dup-a');
    drive.seedProvisioned(TOKEN, 'dup-b');
    const result = await provisionSpreadsheet({
      drive,
      provisioningToken: TOKEN,
      allowCreate: false,
      makeStructureTransport: () => fakeSheetsStructure(),
    });
    expect(result.outcome).toBe('incomplete');
    expect(drive.calls.create).toBe(0);
    expect(drive.files).toHaveLength(2);
  });
});

describe('sheetRef — A1 encoding', () => {
  it('leaves a bare identifier unquoted and quotes names with spaces', () => {
    expect(sheetRef('Sales', 'A:A')).toBe('Sales!A:A');
    expect(sheetRef('Sale Items', 'A5')).toBe("'Sale Items'!A5");
    expect(sheetRef("Bob's Sheet", 'A1')).toBe("'Bob''s Sheet'!A1");
  });
});
