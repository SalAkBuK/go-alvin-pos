/// <reference types="vite/client" />
import type { PosApi } from '../../shared/ipc';

declare global {
  interface Window {
    /** Narrow typed IPC surface exposed by the preload bridge. */
    readonly pos: PosApi;
  }
}
