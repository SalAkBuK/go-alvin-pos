import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PosApi } from '../../src/shared/ipc';

/**
 * Phase 2L-C.4 — the actual `src/preload/index.ts` bridge, not just the
 * `PosApi` type. `tests/unit/ipc-contract.test.ts` only checks a hand-written
 * type-level mirror of `PosApi`; it cannot catch the preload module itself
 * failing to implement a declared method (as `backup.browseRestoreCandidate`,
 * `statusVerified`, `configureOffDevice`, `clearOffDevice`, and
 * `offDeviceConfiguration` all previously did — `tsc --noEmit` reported
 * `src/preload/index.ts(81,3): error TS2739 ... missing ... statusVerified,
 * configureOffDevice, clearOffDevice, offDeviceConfiguration,
 * browseRestoreCandidate`). This suite loads the real module and exercises
 * `window.pos.backup.*` at runtime.
 */

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => ({ ok: true, data: null })) },
}));
vi.mock('electron', () => electron);

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadExposedApi(): Promise<PosApi> {
  await import('../../src/preload/index');
  const calls = electron.contextBridge.exposeInMainWorld.mock.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('pos');
  return calls[0]![1] as PosApi;
}

describe('preload backup bridge', () => {
  it('exposes and forwards the two narrow diagnostics methods', async () => {
    const { IPC } = await import('../../src/shared/ipc');
    const api = await loadExposedApi();
    expect(Object.keys(api.diagnostics).sort()).toEqual(
      ['checkNativeSqlite', 'databaseStatus', 'getSummary', 'run'].sort(),
    );
    await api.diagnostics.getSummary();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.diagnosticsGetSummary);
    await api.diagnostics.run();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.diagnosticsRun);
  });

  it('exposes exactly the declared backup methods — no more, no fewer', async () => {
    const api = await loadExposedApi();
    expect(Object.keys(api.backup).sort()).toEqual(
      [
        'status',
        'createManual',
        'listRestoreCandidates',
        'inspectRestoreCandidate',
        'restore',
        'statusVerified',
        'configureOffDevice',
        'clearOffDevice',
        'offDeviceConfiguration',
        'browseRestoreCandidate',
      ].sort(),
    );
  });

  it('browseRestoreCandidate forwards to the browse channel with no arguments', async () => {
    const { IPC } = await import('../../src/shared/ipc');
    const api = await loadExposedApi();
    await api.backup.browseRestoreCandidate();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC.backupBrowseRestoreCandidate);
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(electron.ipcRenderer.invoke.mock.calls[0]).toHaveLength(1);
  });

  it('statusVerified / configureOffDevice / clearOffDevice / offDeviceConfiguration each forward to their own no-argument channel', async () => {
    const { IPC } = await import('../../src/shared/ipc');
    const api = await loadExposedApi();

    await api.backup.statusVerified();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupStatusVerified);

    await api.backup.configureOffDevice();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupConfigureOffDevice);

    await api.backup.clearOffDevice();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupClearOffDevice);

    await api.backup.offDeviceConfiguration();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupOffDeviceConfiguration);
  });

  it('restore surface (unchanged by this slice) still forwards correctly', async () => {
    const { IPC } = await import('../../src/shared/ipc');
    const api = await loadExposedApi();

    await api.backup.listRestoreCandidates();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupListRestoreCandidates);

    await api.backup.inspectRestoreCandidate({ backupId: 'b1' });
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.backupInspectRestoreCandidate,
      { backupId: 'b1' },
    );

    await api.backup.restore({ backupId: 'b1' });
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.backupRestore, {
      backupId: 'b1',
    });
  });
});
