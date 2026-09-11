import { dialog } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';

/**
 * Native "Browse for a backup file…" dialog (Phase 2L-C.4;
 * `POS_WORKFLOWS.md §67B`). Single-file selection only. A cancelled dialog
 * resolves `null` — never an error. The selected filesystem path is returned
 * only to the trusted main-process caller; it is never logged here, and the
 * renderer never sees it (the IPC layer forwards it straight into the
 * existing Browse-candidate verification pipeline and replies with a safe,
 * pathless DTO).
 */
export function createBackupFileDialogOpener(
  getWindow: () => BrowserWindow | null,
): () => Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Browse for a backup file…',
    properties: ['openFile'],
    filters: [
      { name: 'Go Phones POS backup', extensions: ['sqlite', 'db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };

  return async function showBackupFileDialog(): Promise<string | null> {
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
