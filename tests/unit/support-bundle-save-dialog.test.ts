import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ dialog: { showSaveDialog: vi.fn() } }));
vi.mock('electron', () => electron);

import { createSupportBundleSaveDialogOpener } from '../../src/main/app/supportBundleSaveDialog';

afterEach(() => vi.clearAllMocks());

describe('support bundle Save dialog', () => {
  it('uses a ZIP-only Save dialog with the generated safe default name', async () => {
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    const open = createSupportBundleSaveDialogOpener(() => null);
    const suggested = 'GoPhonesPOS-Support-2026-09-12-SPR-20260912-0123456789ABCDEF.zip';
    expect(await open(suggested)).toBeNull();
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: suggested,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      }),
    );
  });

  it('keeps the selected path in the trusted caller and supports a current parent window', async () => {
    const win = { id: 1 };
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\Users\\owner\\Desktop\\support.zip',
    });
    const open = createSupportBundleSaveDialogOpener(() => win as never);
    expect(await open('safe.zip')).toBe('C:\\Users\\owner\\Desktop\\support.zip');
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith(win, expect.any(Object));
  });
});
