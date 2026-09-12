import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClockWatcher,
  SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS,
} from '../../src/main/diagnostics/clockWatcher';
import { createCapturingLogger } from '../helpers/database';

/** A controllable pair of wall-clock/monotonic clocks for deterministic tests. */
function fakeClocks(startWallMs: number, startMonotonicMs = 0) {
  let wall = startWallMs;
  let monotonic = startMonotonicMs;
  return {
    now: () => wall,
    monotonicNow: () => monotonic,
    /** Advance both clocks by the same real amount of elapsed time. */
    advanceBoth(ms: number) {
      wall += ms;
      monotonic += ms;
    },
    /** Advance only the wall clock — simulates a manual/NTP clock change. */
    advanceWallOnly(ms: number) {
      wall += ms;
    },
  };
}

const START = Date.parse('2026-09-12T12:00:00.000Z');

describe('createClockWatcher (significant clock-jump detection — Phase 2M-E2A)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not report ordinary elapsed time below the 5-minute threshold', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    clocks.advanceBoth(2 * 60 * 1000);
    expect(watcher.checkNow()).toBeNull();
    expect(capture.records).toEqual([]);
  });

  it('reports a forward jump exceeding 5 minutes', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    clocks.advanceWallOnly(10 * 60 * 1000);
    const event = watcher.checkNow();

    expect(event?.direction).toBe('FORWARD');
    expect(event?.differenceMs).toBeGreaterThan(SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS);
    expect(capture.records).toEqual([
      {
        level: 'warn',
        category: 'application',
        event: 'clock.change.detected',
        fields: {
          previousObservedTime: new Date(START).toISOString(),
          currentObservedTime: new Date(START + 10 * 60 * 1000).toISOString(),
          differenceMs: 10 * 60 * 1000,
          direction: 'FORWARD',
        },
      },
    ]);
  });

  it('reports a backward jump exceeding 5 minutes', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    clocks.advanceWallOnly(-10 * 60 * 1000);
    const event = watcher.checkNow();

    expect(event?.direction).toBe('BACKWARD');
    expect(event?.differenceMs).toBeLessThan(-SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS);
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]?.level).toBe('warn');
  });

  it('follows the canonical boundary: exactly 5 minutes is not significant, one millisecond more is', () => {
    const atThreshold = fakeClocks(START);
    const atCapture = createCapturingLogger();
    const atWatcher = createClockWatcher({ logger: atCapture.logger, ...atThreshold });
    atThreshold.advanceWallOnly(SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS);
    expect(atWatcher.checkNow()).toBeNull();
    expect(atCapture.records).toEqual([]);

    const overThreshold = fakeClocks(START);
    const overCapture = createCapturingLogger();
    const overWatcher = createClockWatcher({ logger: overCapture.logger, ...overThreshold });
    overThreshold.advanceWallOnly(SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS + 1);
    expect(overWatcher.checkNow()).not.toBeNull();
  });

  it('does not falsely report a clock change for a long sleep where monotonic time tracked it', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    // An 8-hour overnight sleep where the monotonic clock happened to advance
    // by the same real amount — indistinguishable from ordinary elapsed time.
    clocks.advanceBoth(8 * 60 * 60 * 1000);
    expect(watcher.checkNow()).toBeNull();
    expect(capture.records).toEqual([]);
  });

  it('resetBaseline absorbs an elapsed-sleep gap instead of comparing across it (resume rebaselining)', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    // Simulate a real sleep: only the wall clock jumps forward (monotonic
    // clocks commonly do not advance across an OS suspend), which the resume
    // handler absorbs via resetBaseline() BEFORE any comparison happens.
    clocks.advanceWallOnly(2 * 60 * 60 * 1000);
    watcher.resetBaseline();
    expect(capture.records).toEqual([]);

    // Normal operation resumes: a small elapsed gap afterward is not significant.
    clocks.advanceBoth(30 * 1000);
    expect(watcher.checkNow()).toBeNull();
    expect(capture.records).toEqual([]);
  });

  it('a detected clock change only carries diagnostic timestamps/numbers — no audit/sequence/business fields', () => {
    const clocks = fakeClocks(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({ logger: capture.logger, ...clocks });

    clocks.advanceWallOnly(20 * 60 * 1000);
    const event = watcher.checkNow();

    expect(Object.keys(event ?? {}).sort()).toEqual(
      ['currentObservedTime', 'differenceMs', 'direction', 'previousObservedTime'].sort(),
    );
  });

  it('start/stopSync run a non-overlapping recurring check and can be stopped cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const capture = createCapturingLogger();
    const watcher = createClockWatcher({
      logger: capture.logger,
      intervalMs: 1000,
      now: () => Date.now(),
      monotonicNow: () => Date.now(),
    });

    expect(watcher.running).toBe(false);
    watcher.start();
    expect(watcher.running).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(capture.records).toEqual([]);

    watcher.stopSync();
    expect(watcher.running).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(capture.records).toEqual([]);
  });
});
