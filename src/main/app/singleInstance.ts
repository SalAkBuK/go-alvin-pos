import type { ContextLogger } from './logger';

/**
 * Single-instance behavior (ARCHITECTURE.md Sections 38, 42.4;
 * SUPPORT_DIAGNOSTICS.md Section 34).
 *
 * The OS-level lock is owned by Electron (`app.requestSingleInstanceLock()`),
 * acquired in `src/main/index.ts` before any window or database work. This
 * helper is the pure, Electron-free part: what a first instance does with its
 * existing window when a second launch hands control back via `second-instance`.
 * Keeping it a pure function makes the focus/restore contract unit-testable
 * without launching Electron. A losing second instance never reaches this code
 * at all — it calls `app.quit()` from the `!app.requestSingleInstanceLock()`
 * branch before any database or service is created, so no independent database
 * ownership is ever possible from a second launch.
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

/**
 * Handle a second launch attempt: focus/restore the existing window and
 * record a safe structured lifecycle event (`SUPPORT_DIAGNOSTICS.md §34`).
 * Deliberately takes no `argv`/`workingDirectory` — those are never read, so
 * they can never be logged.
 */
export function handleSecondInstance(
  window: FocusableWindow | null,
  logger: ContextLogger,
): boolean {
  const focused = focusExistingWindow(window);
  logger.info('application', 'application.second_instance_detected', { focused });
  return focused;
}
