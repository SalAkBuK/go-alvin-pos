import { dialog } from 'electron';
import type { BrowserWindow, SaveDialogOptions } from 'electron';

/** Main-owned Save dialog: the renderer can neither choose nor observe a filesystem path. */
export function createSupportBundleSaveDialogOpener(
  getWindow: () => BrowserWindow | null,
): (suggestedFileName: string) => Promise<string | null> {
  return async function showSupportBundleSaveDialog(
    suggestedFileName: string,
  ): Promise<string | null> {
    const options: SaveDialogOptions = {
      title: 'Export Go Phones POS Support Bundle',
      defaultPath: suggestedFileName,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    };
    const win = getWindow();
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  };
}
