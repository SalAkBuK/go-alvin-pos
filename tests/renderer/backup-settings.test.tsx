import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROTECTION_TEXT,
  describeAutomaticSchedule,
  describeBackupWarning,
  describeLastAutomatic,
  formatBackupTimestamp,
} from '../../src/renderer/src/features/settings/backup';
import { BackupSection } from '../../src/renderer/src/features/settings/BackupSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import type { BackupHealth } from '../../src/shared/backup';

/**
 * Phase 2L — Settings → Backup & Restore. No jsdom: the presentation helpers are
 * pure, plus first-render markup.
 */

const base: BackupHealth = {
  lastAutomatic: { outcome: 'COMPLETED', at: '2026-09-10T08:00:00.000Z' },
  lastSuccessfulAutomaticAt: '2026-09-10T08:00:00.000Z',
  overdue: false,
  lastFailure: null,
  protection: 'LOCAL_DISK_ONLY',
  automaticEnabled: true,
  schedule: { cadence: 'DAILY', atLocalTime: '03:00' },
};

describe('describeLastAutomatic', () => {
  it('shows Loading, Never, a timestamp, and a failure', () => {
    expect(describeLastAutomatic(null)).toBe('Loading…');
    expect(describeLastAutomatic({ ...base, lastAutomatic: null })).toBe('Never');
    expect(describeLastAutomatic(base)).toBe('2026-09-10 08:00 UTC');
    expect(
      describeLastAutomatic({
        ...base,
        lastAutomatic: {
          outcome: 'FAILED',
          at: '2026-09-10T08:00:00.000Z',
          errorCode: 'BACKUP_WRITE_FAILED',
        },
      }),
    ).toMatch(/^Failed at 2026-09-10 08:00 UTC$/);
  });
});

describe('describeBackupWarning — never a database-failure claim', () => {
  it('is null when healthy', () => {
    expect(describeBackupWarning(base)).toBeNull();
  });

  it('warns about overdue protection without saying the database failed', () => {
    const msg = describeBackupWarning({ ...base, overdue: true })!;
    expect(msg).toMatch(/overdue/i);
    expect(msg).toMatch(/not a database problem/i);
    expect(msg.toLowerCase()).not.toContain('corrupt');
  });

  it('explains a never-completed backup as an unprotected state', () => {
    const msg = describeBackupWarning({
      ...base,
      overdue: true,
      lastAutomatic: null,
      lastSuccessfulAutomaticAt: null,
    })!;
    expect(msg).toMatch(/not yet protected/i);
  });

  it('surfaces a recent failure calmly', () => {
    const msg = describeBackupWarning({
      ...base,
      lastAutomatic: {
        outcome: 'FAILED',
        at: '2026-09-10T08:00:00.000Z',
        errorCode: 'BACKUP_WRITE_FAILED',
      },
    })!;
    expect(msg).toMatch(/Sales are unaffected/i);
  });
});

describe('protection wording (REQ-BACKUP-010 / TEST-BACKUP-020)', () => {
  it('never claims same-disk backups survive computer or disk loss', () => {
    expect(LOCAL_PROTECTION_TEXT).toMatch(/do not protect against loss/i);
    expect(LOCAL_PROTECTION_TEXT).toMatch(/computer or its disk/i);
  });
});

describe('describeAutomaticSchedule', () => {
  it('states the canonical daily 03:00 default', () => {
    expect(describeAutomaticSchedule(base)).toBe('On — daily at 03:00 (store time)');
  });
});

describe('formatBackupTimestamp', () => {
  it('renders an ISO instant as a stable UTC wall-clock string', () => {
    expect(formatBackupTimestamp('2026-09-10T14:03:05.123Z')).toBe('2026-09-10 14:03 UTC');
  });
});

describe('first-render markup', () => {
  it('BackupSection renders the heading, protection statement, and Back Up Now', () => {
    const html = renderToStaticMarkup(<BackupSection />);
    expect(html).toContain('Backup &amp; Restore');
    expect(html).toContain('Back Up Now');
    expect(html).toContain('do NOT protect against loss');
  });

  it('SettingsPage includes the Backup section', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Backup &amp; Restore');
  });
});
