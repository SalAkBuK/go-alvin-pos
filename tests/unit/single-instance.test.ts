import { describe, expect, it, vi } from 'vitest';
import { focusExistingWindow, handleSecondInstance } from '../../src/main/app/singleInstance';
import type { FocusableWindow } from '../../src/main/app/singleInstance';
import { createCapturingLogger } from '../helpers/database';

function fakeWindow(overrides: Partial<FocusableWindow> = {}): FocusableWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

describe('focusExistingWindow (single-instance behavior)', () => {
  it('returns false when there is no window', () => {
    expect(focusExistingWindow(null)).toBe(false);
  });

  it('returns false when the window is destroyed', () => {
    const window = fakeWindow({ isDestroyed: () => true });
    expect(focusExistingWindow(window)).toBe(false);
    expect(window.focus).not.toHaveBeenCalled();
  });

  it('restores a minimized window, then shows and focuses it', () => {
    const window = fakeWindow({ isMinimized: () => true });
    expect(focusExistingWindow(window)).toBe(true);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('shows and focuses a visible window without restoring it', () => {
    const window = fakeWindow();
    expect(focusExistingWindow(window)).toBe(true);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});

describe('handleSecondInstance (lifecycle diagnostics — Phase 2M-E2A)', () => {
  it('focuses the existing window and records a safe second-instance event', () => {
    const window = fakeWindow();
    const capture = createCapturingLogger();

    const focused = handleSecondInstance(window, capture.logger);

    expect(focused).toBe(true);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(capture.records).toEqual([
      {
        level: 'info',
        category: 'application',
        event: 'application.second_instance_detected',
        fields: { focused: true },
      },
    ]);
  });

  it('records focused:false and never throws when there is no window to restore', () => {
    const capture = createCapturingLogger();

    const focused = handleSecondInstance(null, capture.logger);

    expect(focused).toBe(false);
    expect(capture.records).toEqual([
      {
        level: 'info',
        category: 'application',
        event: 'application.second_instance_detected',
        fields: { focused: false },
      },
    ]);
  });

  it('never logs anything beyond the boolean focused flag (no argv/path leakage)', () => {
    const capture = createCapturingLogger();

    handleSecondInstance(fakeWindow(), capture.logger);

    const [record] = capture.records;
    expect(Object.keys(record?.fields ?? {})).toEqual(['focused']);
  });

  // `handleSecondInstance` takes only a window + logger — it has no database
  // reference at all, so it cannot open or own a database connection. A losing
  // second instance never reaches this function in the first place: it exits
  // via `app.quit()` from the `!app.requestSingleInstanceLock()` branch in
  // `src/main/index.ts`, before any database or service is created.
  it('has no database dependency, so a second instance cannot acquire independent database ownership', () => {
    const capture = createCapturingLogger();
    expect(() => handleSecondInstance(fakeWindow(), capture.logger)).not.toThrow();
    expect(handleSecondInstance.length).toBe(2);
  });
});
