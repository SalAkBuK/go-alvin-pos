import { describe, expect, it } from 'vitest';
import { planRetention } from '../../src/main/backup/backupRetention';
import type { BackupRecordRow } from '../../src/main/backup/backupRecordsRepository';

/**
 * Phase 2L — retention planning (`REQ-BACKUP-006`; `DATA_MODEL.md §36B`;
 * `TEST-BACKUP-010`; adversarial 8). Pure decision function.
 */

const NOW = new Date('2026-09-10T12:00:00Z');

function rec(overrides: Partial<BackupRecordRow>): BackupRecordRow {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    backupType: 'AUTOMATIC',
    locationKind: 'LOCAL_DISK',
    status: 'COMPLETED',
    fileName: 'gophones-automatic-v1-x.sqlite',
    storagePath: '/b/automatic',
    sourceAppVersion: '0.1.0',
    sourceSchemaVersion: 1,
    targetAppVersion: null,
    sizeBytes: 4096,
    checksumSha256: 'a'.repeat(64),
    startedAt: '2026-09-10T00:00:00Z',
    completedAt: '2026-09-10T00:00:01Z',
    errorCode: null,
    ...overrides,
  };
}

const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('planRetention', () => {
  it('keeps automatic backups within 14 days and prunes older ones', () => {
    const fresh = rec({ id: 'fresh', completedAt: daysAgo(3) });
    const stale = rec({ id: 'stale', completedAt: daysAgo(20) });
    const plan = planRetention([fresh, stale], NOW);
    expect(plan.prune.map((r) => r.id)).toEqual(['stale']);
    expect(plan.keep.map((r) => r.id)).toEqual(['fresh']);
  });

  it('keeps manual backups for 90 days', () => {
    const within = rec({ id: 'm1', backupType: 'MANUAL', completedAt: daysAgo(60) });
    const beyond = rec({ id: 'm2', backupType: 'MANUAL', completedAt: daysAgo(120) });
    const plan = planRetention([within, beyond], NOW);
    expect(plan.prune.map((r) => r.id)).toEqual(['m2']);
  });

  it('never prunes a PRE_MIGRATION backup, however old (recovery evidence)', () => {
    const preMigration = rec({
      id: 'pm',
      backupType: 'PRE_MIGRATION',
      completedAt: daysAgo(400),
      targetAppVersion: '0.2.0',
    });
    const plan = planRetention([preMigration], NOW);
    expect(plan.prune).toEqual([]);
  });

  it('never prunes the only verified usable backup even when it is past policy', () => {
    const onlyOne = rec({ id: 'only', completedAt: daysAgo(30) });
    const plan = planRetention([onlyOne], NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.map((r) => r.id)).toEqual(['only']);
  });

  it('prunes old automatic backups but keeps the newest survivor when all are stale', () => {
    const a = rec({ id: 'a', completedAt: daysAgo(30) });
    const b = rec({ id: 'b', completedAt: daysAgo(25) });
    const c = rec({ id: 'c', completedAt: daysAgo(20) });
    const plan = planRetention([a, b, c], NOW);
    // c is the newest → survives; a and b pruned.
    expect(plan.prune.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(plan.keep.map((r) => r.id)).toEqual(['c']);
  });

  it('ignores FAILED rows (no file, failure evidence only)', () => {
    const failed = rec({
      id: 'f',
      status: 'FAILED',
      completedAt: null,
      errorCode: 'BACKUP_WRITE_FAILED',
    });
    const good = rec({ id: 'g', completedAt: daysAgo(1) });
    const plan = planRetention([failed, good], NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.map((r) => r.id)).toEqual(['g']);
  });

  describe('survivor protection is per location_kind (Phase 2L-C.1 fix)', () => {
    it('never deletes the last LOCAL_DISK backup merely because a naturally-later OFF_DEVICE pair survives', () => {
      // Exact audited scenario: a MANUAL local+off-device pair from the same
      // backup cycle, both aged past the 90-day MANUAL policy, no newer
      // manual backup since. The OFF_DEVICE row's completedAt is always
      // slightly later than its paired LOCAL_DISK row's (the off-device copy
      // step runs after the local backup commits) — a location-agnostic
      // "keep the newest" rule would otherwise delete the LOCAL_DISK row.
      const local = rec({
        id: 'local-manual',
        backupType: 'MANUAL',
        locationKind: 'LOCAL_DISK',
        completedAt: daysAgo(120),
      });
      const offDevice = rec({
        id: 'off-device-manual',
        backupType: 'MANUAL',
        locationKind: 'OFF_DEVICE',
        // Slightly later than `local`, exactly as the real off-device copy
        // step (which runs after the local commit) always produces.
        completedAt: new Date(new Date(daysAgo(120)).getTime() + 5_000).toISOString(),
      });
      const plan = planRetention([local, offDevice], NOW);
      expect(plan.keep.map((r) => r.id).sort()).toEqual(['local-manual', 'off-device-manual']);
      expect(plan.prune).toEqual([]);
    });

    it('never deletes the last OFF_DEVICE backup merely because a LOCAL_DISK survivor exists (reciprocal case)', () => {
      // A fresh LOCAL_DISK backup exists (well within policy), but the only
      // OFF_DEVICE backup is old and past policy with nothing newer copied
      // off-device since (e.g. the destination was unreachable for a while).
      // The LOCAL_DISK survivor must not excuse deleting the last OFF_DEVICE
      // recovery copy.
      const freshLocal = rec({
        id: 'fresh-local',
        backupType: 'AUTOMATIC',
        locationKind: 'LOCAL_DISK',
        completedAt: daysAgo(1),
      });
      const staleOffDevice = rec({
        id: 'stale-off-device',
        backupType: 'AUTOMATIC',
        locationKind: 'OFF_DEVICE',
        completedAt: daysAgo(20),
      });
      const plan = planRetention([freshLocal, staleOffDevice], NOW);
      expect(plan.keep.map((r) => r.id).sort()).toEqual(['fresh-local', 'stale-off-device']);
      expect(plan.prune).toEqual([]);
    });

    it('still prunes an over-age OFF_DEVICE row when a newer OFF_DEVICE survivor exists, independent of LOCAL_DISK', () => {
      const local = rec({ id: 'local', locationKind: 'LOCAL_DISK', completedAt: daysAgo(1) });
      const offDeviceOld = rec({
        id: 'off-old',
        locationKind: 'OFF_DEVICE',
        completedAt: daysAgo(20),
      });
      const offDeviceNew = rec({
        id: 'off-new',
        locationKind: 'OFF_DEVICE',
        completedAt: daysAgo(2),
      });
      const plan = planRetention([local, offDeviceOld, offDeviceNew], NOW);
      expect(plan.prune.map((r) => r.id)).toEqual(['off-old']);
      expect(plan.keep.map((r) => r.id).sort()).toEqual(['local', 'off-new']);
    });
  });
});
