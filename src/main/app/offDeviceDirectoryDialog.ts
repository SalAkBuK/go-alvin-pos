import { dialog } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';

/**
 * Native off-device backup destination directory dialog
 * (`POS_WORKFLOWS.md §67B`; `PRODUCT_REQUIREMENTS.md REQ-BACKUP-010`).
 * Single-folder selection only. A cancelled dialog resolves `null` — never an
 * error. The selected path is returned only to the trusted main-process
 * caller (`backupIpc.ts`'s existing `configureOffDevice` handler), which
 * independently reverifies it through `offDeviceDestination.ts` before it is
 * ever persisted; it is never logged here.
 */
export function createOffDeviceDirectoryDialogOpener(
  getWindow: () => BrowserWindow | null,
): () => Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose an off-device backup destination…',
    properties: ['openDirectory', 'createDirectory'],
  };

  return async function showOffDeviceDirectoryDialog(): Promise<string | null> {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  };
}
