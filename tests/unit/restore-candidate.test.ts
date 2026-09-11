import { describe, expect, it } from 'vitest';
import { createConfirmationTokenizer } from '../../src/main/backup/restoreCandidate';

/**
 * Phase 2L-B — confirmation token binding (Item 11). The loss calculation and
 * candidate revalidation are exercised end-to-end in `tests/integration/restore.test.ts`.
 */

describe('createConfirmationTokenizer', () => {
  const CHECKSUM = 'a'.repeat(64);
  const FP1 = 'f1';
  const FP2 = 'f2';
  const NOW = 1_000_000;

  it('accepts its own fresh token for the same (candidate, fingerprint)', () => {
    const t = createConfirmationTokenizer();
    const token = t.mint(CHECKSUM, FP1, NOW);
    expect(t.verify(token, CHECKSUM, FP1, NOW + 1000)).toBe(true);
  });

  it('rejects a token when the current-data fingerprint changed (Item 11 — stale confirmation)', () => {
    const t = createConfirmationTokenizer();
    const token = t.mint(CHECKSUM, FP1, NOW);
    expect(t.verify(token, CHECKSUM, FP2, NOW + 1000)).toBe(false);
  });

  it('rejects a token bound to a different candidate checksum', () => {
    const t = createConfirmationTokenizer();
    const token = t.mint(CHECKSUM, FP1, NOW);
    expect(t.verify(token, 'b'.repeat(64), FP1, NOW + 1000)).toBe(false);
  });

  it('rejects an expired token', () => {
    const t = createConfirmationTokenizer(1000);
    const token = t.mint(CHECKSUM, FP1, NOW);
    expect(t.verify(token, CHECKSUM, FP1, NOW + 2000)).toBe(false);
  });

  it('rejects undefined / malformed tokens and a token minted by a different process', () => {
    const t = createConfirmationTokenizer();
    const other = createConfirmationTokenizer();
    expect(t.verify(undefined, CHECKSUM, FP1, NOW)).toBe(false);
    expect(t.verify('not-a-token', CHECKSUM, FP1, NOW)).toBe(false);
    expect(t.verify(other.mint(CHECKSUM, FP1, NOW), CHECKSUM, FP1, NOW + 1)).toBe(false);
  });
});
