/**
 * Single-instance behavior (ARCHITECTURE.md Sections 38, 42.4).
 *
 * The OS-level lock is owned by Electron (`app.requestSingleInstanceLock()`),
 * acquired in `src/main/index.ts` before any window or database work. This
 * helper is the pure, Electron-free part: what a first instance does with its
 * existing window when a second launch hands control back via `second-instance`.
 * Keeping it a pure function makes the focus/restore contract unit-testable
 * without launching Electron.
 */

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Bring an existing main window back to the foreground. Returns `true` when a
 * usable window was focused, `false` when there was nothing to focus.
 */
export function focusExistingWindow(window: FocusableWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return true;
}
