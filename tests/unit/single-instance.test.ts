import { describe, expect, it, vi } from 'vitest';
import { focusExistingWindow } from '../../src/main/app/singleInstance';
import type { FocusableWindow } from '../../src/main/app/singleInstance';

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
