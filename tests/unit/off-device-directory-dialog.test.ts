import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => electron);

import { createOffDeviceDirectoryDialogOpener } from '../../src/main/app/offDeviceDirectoryDialog';

/**
 * Phase 2L-C.5 integration fix — this hook was declared in `backupIpc.ts` /
 * `register.ts` since 2L-C.1 but never actually wired to a real Electron
 * dialog in `index.ts`; `backup:configure-off-device` silently behaved as an
 * always-cancelled dialog. This mirrors `backup-file-dialog.test.ts`'s
 * coverage for the analogous Browse dialog.
 */

afterEach(() => vi.clearAllMocks());

describe('createOffDeviceDirectoryDialogOpener', () => {
  it('resolves null when the dialog is cancelled', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createOffDeviceDirectoryDialogOpener(() => null);
    expect(await open()).toBeNull();
  });

  it('resolves the single selected directory', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\External Drive\\Backups'],
    });
    const open = createOffDeviceDirectoryDialogOpener(() => null);
    expect(await open()).toBe('D:\\External Drive\\Backups');
  });

  it('requests directory selection only', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createOffDeviceDirectoryDialogOpener(() => null);
    await open();
    const options = electron.dialog.showOpenDialog.mock.calls[0]![0] as {
      properties: readonly string[];
    };
    expect(options.properties).toContain('openDirectory');
  });

  it('attaches the dialog to the current main window when one exists', async () => {
    const fakeWindow = { id: 'main-window' };
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const open = createOffDeviceDirectoryDialogOpener(() => fakeWindow as never);
    await open();
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(fakeWindow, expect.any(Object));
  });
});
