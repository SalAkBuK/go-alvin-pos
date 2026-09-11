import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => electron);

import { createBackupFileDialogOpener } from '../../src/main/app/backupFileDialog';

/**
 * Phase 2L-C.4 — native "Browse for a backup file…" dialog wiring. The main
 * process owns `dialog.showOpenDialog` entirely; the renderer never sees this
 * module or a filesystem path (`backupIpc.ts` forwards only the resolved
 * string, or `null` on cancel, into the existing Browse-candidate pipeline).
 */

afterEach(() => vi.clearAllMocks());

describe('createBackupFileDialogOpener', () => {
  it('resolves null when the dialog is cancelled', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createBackupFileDialogOpener(() => null);
    expect(await open()).toBeNull();
  });

  it('resolves null when the dialog reports no cancellation but no selection', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    const open = createBackupFileDialogOpener(() => null);
    expect(await open()).toBeNull();
  });

  it('resolves the single selected path', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:\\Users\\owner\\Desktop\\backup.sqlite'],
    });
    const open = createBackupFileDialogOpener(() => null);
    expect(await open()).toBe('C:\\Users\\owner\\Desktop\\backup.sqlite');
  });

  it('requests single-file selection with a database file filter', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createBackupFileDialogOpener(() => null);
    await open();
    const options = electron.dialog.showOpenDialog.mock.calls[0]![0] as {
      properties: readonly string[];
      filters: ReadonlyArray<{ extensions: readonly string[] }>;
    };
    expect(options.properties).toEqual(['openFile']);
    expect(options.filters.some((f) => f.extensions.includes('sqlite'))).toBe(true);
  });

  it('attaches the dialog to the current main window when one exists', async () => {
    const fakeWindow = { id: 'main-window' };
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createBackupFileDialogOpener(() => fakeWindow as never);
    await open();
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(fakeWindow, expect.any(Object));
  });

  it('calls the window-less overload when no window is currently open', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createBackupFileDialogOpener(() => null);
    await open();
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(expect.any(Object));
    expect(electron.dialog.showOpenDialog.mock.calls[0]).toHaveLength(1);
  });
});
