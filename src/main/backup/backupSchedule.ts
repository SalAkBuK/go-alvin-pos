/**
 * Automatic-backup scheduling arithmetic (`DATA_MODEL.md §36B` "V1 Default
 * Cadence and Retention"; `ARCHITECTURE.md §46`; `POS_WORKFLOWS.md §65`,
 * `§100` step 5).
 *
 * Pure functions only — no timers, no I/O, no `Date.now()`. Due-ness is derived
 * from the last *successful* automatic backup and the configured business
 * timezone, so the process does not need to be alive at exactly 03:00: on the
 * next application opportunity (startup, resume, or the running scheduler tick)
 * the app simply asks "is today's backup still owed?".
 */

/** Canonical V1 defaults (used whenever no owner customization exists). */
export const AUTOMATIC_BACKUP_LOCAL_TIME = '03:00';
export const AUTOMATIC_BACKUP_MINUTE_OF_DAY = 3 * 60;
export const AUTOMATIC_RETENTION_DAYS = 14;
export const MANUAL_RETENTION_DAYS = 90;

interface LocalWallClock {
  /** `YYYY-MM-DD` calendar date in the business timezone. */
  readonly date: string;
  /** Minutes since local midnight in the business timezone. */
  readonly minuteOfDay: number;
}

/** The wall-clock calendar date + time-of-day of a UTC instant in an IANA zone. */
export function localWallClock(nowUtc: Date, timeZone: string): LocalWallClock {
  const parts = safeParts(nowUtc, timeZone) ?? safeParts(nowUtc, 'UTC')!;
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minuteOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return { date, minuteOfDay };
}

function safeParts(instant: Date, timeZone: string): Intl.DateTimeFormatPart[] | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
  } catch {
    return null;
  }
}

/** Whole days from calendar date `from` to `to` (`YYYY-MM-DD` strings). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

function utcMidnight(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export interface ScheduleInput {
  readonly now: Date;
  readonly timeZone: string;
  /** `completed_at` of the most recent successful AUTOMATIC backup, or `null`. */
  readonly lastSuccessfulCompletedAt: string | null;
}

/**
 * `true` when an automatic backup is owed (approved V1 rule, Phase 2L-B Item 1):
 *  - **never** succeeded → owed once local business time reaches 03:00 today,
 *    not before (a fresh install at 01:00 waits; `null` is NOT treated as
 *    "infinitely old" for the ≥ 2-day catch-up branch);
 *  - last success is today's business date → not owed;
 *  - last success is yesterday and local time < 03:00 → not owed;
 *  - last success is yesterday and local time ≥ 03:00 → owed;
 *  - last success is ≥ 2 business-calendar days behind → owed immediately,
 *    including before 03:00 (a whole scheduled window has already been missed).
 */
export function isAutomaticBackupDue(input: ScheduleInput): boolean {
  const { date: today, minuteOfDay } = localWallClock(input.now, input.timeZone);

  if (input.lastSuccessfulCompletedAt === null) {
    return minuteOfDay >= AUTOMATIC_BACKUP_MINUTE_OF_DAY;
  }

  const lastDate = localWallClock(new Date(input.lastSuccessfulCompletedAt), input.timeZone).date;
  const daysSince = calendarDaysBetween(lastDate, today);

  if (daysSince <= 0) {
    return false;
  }
  if (daysSince >= 2) {
    return true;
  }
  return minuteOfDay >= AUTOMATIC_BACKUP_MINUTE_OF_DAY;
}

/**
 * `true` when at least one full daily automatic backup window has been missed
 * and not caught up. This is a protection/health warning — never a claim that
 * the database has failed (`REQ-BACKUP-007`, `TEST-BACKUP-011`).
 */
export function isAutomaticBackupOverdue(input: ScheduleInput): boolean {
  if (input.lastSuccessfulCompletedAt === null) {
    return false;
  }
  const today = localWallClock(input.now, input.timeZone).date;
  const lastDate = localWallClock(new Date(input.lastSuccessfulCompletedAt), input.timeZone).date;
  return calendarDaysBetween(lastDate, today) >= 2;
}
