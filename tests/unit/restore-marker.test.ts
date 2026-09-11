import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  clearRestoreMarker,
  readRestoreMarker,
  writeRestoreMarker,
} from '../../src/main/maintenance/restoreMarker';

/** Phase 2L-B — crash-consistent restore marker (Item 13). */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gpp-marker-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const marker = {
  version: 1 as const,
  preRestoreFileName: 'gophones-pre-restore-v1-2026-09-10T09-00-00-000Z-abcd1234.sqlite',
  startedAt: '2026-09-10T09:00:00.000Z',
};

it('round-trips a valid marker (atomic write, no leftover .tmp)', () => {
  writeRestoreMarker(dir, marker);
  const read = readRestoreMarker(dir);
  expect(read).toEqual({ present: true, marker });
  // Only the final file exists.
  expect(() => readFileSync(join(dir, 'restore-in-progress.json'))).not.toThrow();
  expect(() => readFileSync(join(dir, 'restore-in-progress.json.tmp'))).toThrow();
});

it('reports absent when there is no marker', () => {
  expect(readRestoreMarker(dir)).toEqual({ present: false });
});

it('reports corrupt for unparseable JSON', () => {
  writeFileSync(join(dir, 'restore-in-progress.json'), '{ not json');
  expect(readRestoreMarker(dir)).toEqual({ present: true, corrupt: true });
});

it('reports corrupt for a coherent-but-wrong shape', () => {
  writeFileSync(
    join(dir, 'restore-in-progress.json'),
    JSON.stringify({ version: 1, preRestoreFileName: '../etc/passwd', startedAt: 'x' }),
  );
  expect(readRestoreMarker(dir)).toEqual({ present: true, corrupt: true });
});

it('clear removes the marker and any .tmp', () => {
  writeRestoreMarker(dir, marker);
  clearRestoreMarker(dir);
  expect(readRestoreMarker(dir)).toEqual({ present: false });
});
