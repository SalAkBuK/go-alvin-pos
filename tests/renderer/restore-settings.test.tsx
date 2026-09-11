import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  describeCandidate,
  describeIncompatible,
  describeNewerDataLoss,
  mergeBrowsedCandidate,
} from '../../src/renderer/src/features/settings/restore';
import { RestoreSection } from '../../src/renderer/src/features/settings/RestoreSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import type { NewerDataLoss, RestoreCandidate } from '../../src/shared/restore';

/**
 * Phase 2L-B — Settings → Restore Database presentation (no jsdom), extended
 * in Phase 2L-C.4 with the Browse-for-a-backup-file entry point.
 */

const candidate: RestoreCandidate = {
  backupId: 'b1',
  backupType: 'MANUAL',
  createdAt: '2026-09-10T08:00:00.000Z',
  sourceAppVersion: '0.1.0',
  schemaVersion: 1,
  sizeBytes: 40960,
  locationKind: 'LOCAL_DISK',
  sourceKind: 'MANAGED',
  catalogued: true,
};

const browsedCandidate: RestoreCandidate = {
  backupId: 'browsed-abc123',
  backupType: 'MANUAL',
  createdAt: '2026-09-11T09:00:00.000Z',
  sourceAppVersion: '0.1.0',
  schemaVersion: 1,
  sizeBytes: 20480,
  locationKind: 'LOCAL_DISK',
  sourceKind: 'BROWSED',
  catalogued: false,
};

describe('describeCandidate', () => {
  it('shows type, time, app + schema version, size — no absolute path', () => {
    const text = describeCandidate(candidate);
    expect(text).toMatch(/Manual backup/);
    expect(text).toMatch(/2026-09-10 08:00 UTC/);
    expect(text).toMatch(/schema v1/);
    expect(text).not.toMatch(/[A-Za-z]:\\|\/backups\//);
  });
});

describe('describeIncompatible', () => {
  it('explains older / newer rejection', () => {
    expect(describeIncompatible('SCHEMA_OLDER')).toMatch(/older version/i);
    expect(describeIncompatible('SCHEMA_NEWER')).toMatch(/newer version/i);
  });
});

describe('describeNewerDataLoss — exact count + date range (TEST-BACKUP-018)', () => {
  it('names the transaction count and the date range', () => {
    const loss: NewerDataLoss = {
      transactionCount: 3,
      earliestCompletedAt: '2026-09-08T10:00:00.000Z',
      latestCompletedAt: '2026-09-10T18:00:00.000Z',
    };
    const text = describeNewerDataLoss(loss);
    expect(text).toMatch(/replaces your entire current database/i);
    expect(text).toMatch(/3 newer completed transactions/);
    expect(text).toMatch(/2026-09-08 – 2026-09-10/);
    expect(text).toMatch(/cannot be recovered/i);
  });

  it('handles a single-day, single-transaction loss', () => {
    const text = describeNewerDataLoss({
      transactionCount: 1,
      earliestCompletedAt: '2026-09-09T10:00:00.000Z',
      latestCompletedAt: '2026-09-09T12:00:00.000Z',
    });
    expect(text).toMatch(/1 newer completed transaction \(2026-09-09\)/);
  });
});

describe('first-render markup', () => {
  it('RestoreSection renders the heading and the replacement warning; Cancel is default wording', () => {
    const html = renderToStaticMarkup(<RestoreSection />);
    expect(html).toContain('Restore Database');
    expect(html).toContain('replaces your');
    expect(html).toContain('recovery copy of your current data is kept');
  });

  it('RestoreSection renders the Browse-for-a-backup-file entry point (Phase 2L-C.4)', () => {
    const html = renderToStaticMarkup(<RestoreSection />);
    expect(html).toContain('Browse for a backup file');
    // No raw filesystem path ever appears in the first-render markup.
    expect(html).not.toMatch(/[A-Za-z]:\\|\/backups\//);
  });

  it('SettingsPage includes the Restore section', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Restore Database');
  });
});

describe('mergeBrowsedCandidate (TEST-BACKUP: Browse for a backup file)', () => {
  it('places a freshly browsed candidate first, ahead of the managed list', () => {
    const merged = mergeBrowsedCandidate([candidate], browsedCandidate);
    expect(merged).toEqual([browsedCandidate, candidate]);
  });

  it('starts a list when none has loaded yet (null)', () => {
    expect(mergeBrowsedCandidate(null, browsedCandidate)).toEqual([browsedCandidate]);
  });

  it('replaces its own previous entry instead of duplicating it (re-browsing the same file)', () => {
    const staleBrowsed = { ...browsedCandidate, sizeBytes: 1 };
    const merged = mergeBrowsedCandidate([staleBrowsed, candidate], browsedCandidate);
    expect(merged).toEqual([browsedCandidate, candidate]);
  });

  it('never mutates the input array (a cancelled dialog is safe: the caller simply never calls this)', () => {
    const original = [candidate];
    const merged = mergeBrowsedCandidate(original, browsedCandidate);
    expect(original).toEqual([candidate]);
    expect(merged).not.toBe(original);
  });
});
