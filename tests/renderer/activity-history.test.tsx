import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_HISTORY_EMPTY_MESSAGE,
  ACTIVITY_HISTORY_ERROR_MESSAGE,
  ActivityHistoryList,
  ActivityHistorySection,
  createActivityHistoryFetchAction,
} from '../../src/renderer/src/features/settings/ActivityHistorySection';
import type { ActivityHistory, ActivityHistoryEntry } from '../../src/shared/activityHistory';
import type { IpcResult } from '../../src/shared/products';

const entries: readonly ActivityHistoryEntry[] = [
  {
    id: '2026-09-12T10:00:02.000Z#0',
    timestamp: '2026-09-12T10:00:02.000Z',
    severity: 'ERROR',
    title: 'A sale could not be saved',
    detail: 'The sale could not be completed. No sale was recorded for this attempt.',
    errorCode: 'SALE_COMMIT_FAILED',
  },
  {
    id: '2026-09-12T10:00:01.000Z#1',
    timestamp: '2026-09-12T10:00:01.000Z',
    severity: 'WARNING',
    title: 'Receipt could not be printed',
    detail: 'The sale was saved successfully, but the printer was unavailable.',
  },
  {
    id: '2026-09-12T10:00:00.000Z#2',
    timestamp: '2026-09-12T10:00:00.000Z',
    severity: 'INFO',
    title: 'Sale completed',
    detail: 'Sale GP-000123 was completed and saved.',
    receiptNumber: 'GP-000123',
  },
];

describe('ActivityHistoryList (presentational)', () => {
  it('renders the empty-state message when there are no entries', () => {
    const html = renderToStaticMarkup(<ActivityHistoryList entries={[]} />);
    expect(html).toContain(ACTIVITY_HISTORY_EMPTY_MESSAGE);
  });

  it('renders multiple entries with severity, title, detail, and timestamp', () => {
    const html = renderToStaticMarkup(<ActivityHistoryList entries={entries} />);
    expect(html).toContain('Needs attention');
    expect(html).toContain('Notice');
    expect(html).toContain('Info');
    expect(html).toContain('A sale could not be saved');
    expect(html).toContain('Receipt could not be printed');
    expect(html).toContain('Sale completed');
    expect(html).toContain('The sale was saved successfully, but the printer was unavailable.');
    expect(html).toContain('2026-09-12 10:00');
  });

  it('shows the safe receipt number and error code references without exposing anything else', () => {
    const html = renderToStaticMarkup(<ActivityHistoryList entries={entries} />);
    expect(html).toContain('Receipt GP-000123');
    expect(html).toContain('Error code: SALE_COMMIT_FAILED');
  });

  it('never renders raw technical context — only the friendly DTO fields', () => {
    const html = renderToStaticMarkup(<ActivityHistoryList entries={entries} />);
    expect(html).not.toContain('context');
    expect(html).not.toContain('stack');
    expect(html).not.toMatch(/[A-Z]:\\\\/);
  });
});

describe('ActivityHistorySection (first render)', () => {
  it('shows an honest loading state before any effect has run', () => {
    const html = renderToStaticMarkup(<ActivityHistorySection />);
    expect(html).toContain('Recent Activity');
    expect(html).toContain('Loading recent activity');
    expect(html).not.toContain('No recent issues or activity to show.');
  });
});

describe('createActivityHistoryFetchAction', () => {
  function callbacks() {
    const loadingChanges: boolean[] = [];
    const entriesSeen: Array<readonly ActivityHistoryEntry[]> = [];
    const errors: Array<string | null> = [];
    return {
      loadingChanges,
      entriesSeen,
      errors,
      onLoadingChange: (value: boolean) => loadingChanges.push(value),
      onEntries: (value: readonly ActivityHistoryEntry[]) => entriesSeen.push(value),
      onError: (value: string | null) => errors.push(value),
    };
  }

  it('publishes entries on success and clears loading/error', async () => {
    const cb = callbacks();
    const invoke = vi.fn((): Promise<IpcResult<ActivityHistory>> =>
      Promise.resolve({ ok: true, data: { generatedAt: '2026-09-12T10:00:00.000Z', entries } }),
    );
    const action = createActivityHistoryFetchAction(invoke, cb);
    await action.run();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(cb.loadingChanges).toEqual([true, false]);
    expect(cb.entriesSeen).toEqual([entries]);
    expect(cb.errors).toEqual([null]);
  });

  it('publishes only the fixed sanitized error message when the IPC call rejects with sensitive detail', async () => {
    const cb = callbacks();
    const invoke = vi.fn(() =>
      Promise.reject(new Error('C:\\Users\\Owner\\AppData\\gophones.sqlite token=secret')),
    );
    const action = createActivityHistoryFetchAction(invoke, cb);
    await action.run();

    expect(cb.errors).toEqual([null, ACTIVITY_HISTORY_ERROR_MESSAGE]);
    expect(cb.entriesSeen).toEqual([]);
    for (const message of cb.errors) {
      expect(message ?? '').not.toContain('AppData');
      expect(message ?? '').not.toContain('secret');
    }
  });

  it('publishes the fixed sanitized error when the IPC result itself is not ok', async () => {
    const cb = callbacks();
    const invoke = vi.fn((): Promise<IpcResult<ActivityHistory>> =>
      Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'raw backend detail' } }),
    );
    const action = createActivityHistoryFetchAction(invoke, cb);
    await action.run();

    expect(cb.errors.at(-1)).toBe(ACTIVITY_HISTORY_ERROR_MESSAGE);
    expect(cb.errors.some((message) => message?.includes('raw backend detail'))).toBe(false);
  });
});
