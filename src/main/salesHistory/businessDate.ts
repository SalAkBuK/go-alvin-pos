/**
 * Business-date derivation for Sales History filtering (`DATA_MODEL.md §4`,
 * "Business-Day Semantics"; `TEST-HIST-006`).
 *
 * A sale's authoritative instant is `sales.completed_at`, persisted as ISO-8601
 * UTC. Its *business date* for history is the calendar date of that instant
 * converted into the **currently configured** `business_timezone` using standard
 * IANA rules (midnight-to-midnight in that zone), computed live — never stored,
 * never the UTC calendar date.
 *
 * `Intl.DateTimeFormat` with a `timeZone` already applies DST-correct IANA
 * conversion (Node ships full ICU), so no timezone library and no DST
 * special-casing is needed (`DATA_MODEL.md §4` "DST behavior"; `task §10`). For
 * V1 scale we derive each candidate sale's business date this way in the trusted
 * application layer and compare strings, rather than computing DST-correct UTC
 * query boundaries.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `true` when `value` is a syntactically valid `YYYY-MM-DD` date that also
 * denotes a real calendar day (so `2026-02-30` is rejected).
 */
export function isValidBusinessDate(value: string): boolean {
  if (!YMD.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return (
    asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d
  );
}

/**
 * The calendar date (`YYYY-MM-DD`) of the UTC instant `completedAtIsoUtc` in
 * IANA zone `timeZone`.
 *
 * A malformed timestamp throws (a committed sale always has a valid
 * `completed_at`). A malformed/unknown `timeZone` falls back to the UTC calendar
 * date so filtering still produces a deterministic result rather than crashing.
 */
export function deriveBusinessDate(completedAtIsoUtc: string, timeZone: string): string {
  const instant = new Date(completedAtIsoUtc);
  if (Number.isNaN(instant.getTime())) {
    throw new Error('deriveBusinessDate received an invalid completed_at timestamp');
  }
  return formatYmdInZone(instant, timeZone) ?? formatYmdInZone(instant, 'UTC')!;
}

function formatYmdInZone(instant: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year === '' || month === '' || day === '') {
      return null;
    }
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}
