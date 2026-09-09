import { safeStorage } from 'electron';
import type { SecureCrypto } from './secureCrypto';

/**
 * The production {@link SecureCrypto}: Electron's `safeStorage`, preferring the
 * async APIs when the pinned runtime exposes them (`task §2`, `§10`). On
 * Windows this is DPAPI-backed and keyed to the Windows user account.
 *
 * There is deliberately no plaintext path: if encryption is unavailable, every
 * operation rejects and the caller keeps the integration disabled
 * (`DATA_MODEL.md §21`, `task §8`).
 *
 * This module is imported only from the main-process wiring, never from a
 * service or a test — tests inject a fake `SecureCrypto`.
 */
export function createElectronSecureCrypto(): SecureCrypto {
  return {
    async isAvailable(): Promise<boolean> {
      try {
        if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
          return await safeStorage.isAsyncEncryptionAvailable();
        }
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },

    async encrypt(plaintext: string): Promise<Buffer> {
      if (typeof safeStorage.encryptStringAsync === 'function') {
        return safeStorage.encryptStringAsync(plaintext);
      }
      return safeStorage.encryptString(plaintext);
    },

    async decrypt(ciphertext: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const decrypted = await safeStorage.decryptStringAsync(ciphertext);
        return { result: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
      }
      return { result: safeStorage.decryptString(ciphertext), shouldReEncrypt: false };
    },
  };
}
