import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_BACKUP_LOCAL_TIME,
  calendarDaysBetween,
  isAutomaticBackupDue,
  isAutomaticBackupOverdue,
  localWallClock,
} from '../../src/main/backup/backupSchedule';

/**
 * Phase 2L — automatic-backup schedule arithmetic (`DATA_MODEL.md §36B` V1
 * cadence; adversarial tests 5, 6, 7). Pure functions, deterministic clock.
 */

const CHICAGO = 'America/Chicago';

describe('localWallClock', () => {
  it('converts a UTC instant to the business-timezone date + minute of day', () => {
    // 2026-09-10T07:30:00Z → 02:30 CDT (UTC-5) on 2026-09-10
    expect(localWallClock(new Date('2026-09-10T07:30:00Z'), CHICAGO)).toEqual({
      date: '2026-09-10',
      minuteOfDay: 150,
    });
  });

  it('rolls the local date back when UTC midnight is still the previous evening locally', () => {
    // 2026-09-10T02:00:00Z → 2026-09-09 21:00 CDT
    expect(localWallClock(new Date('2026-09-10T02:00:00Z'), CHICAGO).date).toBe('2026-09-09');
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(localWallClock(new Date('2026-09-10T07:30:00Z'), 'Not/AZone')).toEqual({
      date: '2026-09-10',
      minuteOfDay: 450,
    });
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole calendar days', () => {
    expect(calendarDaysBetween('2026-09-08', '2026-09-10')).toBe(2);
    expect(calendarDaysBetween('2026-09-10', '2026-09-10')).toBe(0);
  });
});

describe('isAutomaticBackupDue', () => {
  const now = new Date('2026-09-10T09:00:00Z'); // 04:00 CDT, past 03:00

  it('never backed up + local time >= 03:00 → due (Item 1)', () => {
    expect(isAutomaticBackupDue({ now, timeZone: CHICAGO, lastSuccessfulCompletedAt: null })).toBe(
      true,
    );
  });

  it('never backed up + local time < 03:00 → NOT due (fresh install at 01:00 waits, Item 1)', () => {
    const before3 = new Date('2026-09-10T07:00:00Z'); // 02:00 CDT
    expect(
      isAutomaticBackupDue({ now: before3, timeZone: CHICAGO, lastSuccessfulCompletedAt: null }),
    ).toBe(false);
  });

  it('never backed up is NOT treated as "infinitely old" — before 03:00 it is not force-due', () => {
    const oneMinuteBefore3 = new Date('2026-09-10T07:59:00Z'); // 02:59 CDT
    expect(
      isAutomaticBackupDue({
        now: oneMinuteBefore3,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: null,
      }),
    ).toBe(false);
  });

  it('is NOT due when today already has a successful automatic backup (adversarial 6)', () => {
    expect(
      isAutomaticBackupDue({
        now,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-10T08:05:00Z', // 03:05 CDT today
      }),
    ).toBe(false);
  });

  it('is due after 03:00 local when the last success was yesterday (adversarial 7)', () => {
    expect(
      isAutomaticBackupDue({
        now,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-09T08:05:00Z',
      }),
    ).toBe(true);
  });

  it('is NOT due before 03:00 local when the last success was yesterday', () => {
    const before3 = new Date('2026-09-10T07:00:00Z'); // 02:00 CDT
    expect(
      isAutomaticBackupDue({
        now: before3,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-09T08:05:00Z',
      }),
    ).toBe(false);
  });

  it('is due immediately (any time of day) when a full window was missed', () => {
    const before3 = new Date('2026-09-10T07:00:00Z'); // 02:00 CDT
    expect(
      isAutomaticBackupDue({
        now: before3,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-07T08:05:00Z', // 3 days ago
      }),
    ).toBe(true);
  });
});

describe('isAutomaticBackupOverdue', () => {
  const now = new Date('2026-09-10T09:00:00Z');

  it('is not overdue when never backed up (health shows "Never" instead)', () => {
    expect(
      isAutomaticBackupOverdue({ now, timeZone: CHICAGO, lastSuccessfulCompletedAt: null }),
    ).toBe(false);
  });

  it('is not overdue the day after a successful backup', () => {
    expect(
      isAutomaticBackupOverdue({
        now,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-09T08:05:00Z',
      }),
    ).toBe(false);
  });

  it('is overdue once two or more days have passed without a successful backup (TEST-BACKUP-011)', () => {
    expect(
      isAutomaticBackupOverdue({
        now,
        timeZone: CHICAGO,
        lastSuccessfulCompletedAt: '2026-09-08T08:05:00Z',
      }),
    ).toBe(true);
  });
});

it('exposes the canonical V1 default local time', () => {
  expect(AUTOMATIC_BACKUP_LOCAL_TIME).toBe('03:00');
});
