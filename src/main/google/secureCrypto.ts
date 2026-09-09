/**
 * The minimal OS-secure-storage boundary the Google credential store depends
 * on (`task §2` credential storage, `§10`). Injectable so the store is testable
 * without the Electron runtime (`safeStorage` needs a live `app`).
 *
 * The real implementation (`electronSafeStorage.ts`) wraps Electron's async
 * `safeStorage` APIs (`isAsyncEncryptionAvailable` / `encryptStringAsync` /
 * `decryptStringAsync`), which on Windows are DPAPI-backed and available once
 * the app is ready.
 */
export interface SecureCrypto {
  /** Whether OS-backed encryption can be used right now. `false` ⇒ no plaintext fallback. */
  isAvailable(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
