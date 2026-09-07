import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';

describe('IPC contract', () => {
  it('exposes only the foundation channels', () => {
    expect(Object.keys(IPC).sort()).toEqual(['appInfo', 'nativeSqliteCheck']);
  });

  it('uses stable, unique, namespaced channel names', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
    }
  });

  it('defines no generic database / shell / filesystem channel', () => {
    // Guards ARCHITECTURE.md §9: no `database:query`, `execute-sql`, `run-command`,
    // `read-any-file`, etc. Matches whole dangerous verbs/nouns, not substrings
    // (so `diagnostics:native-sqlite-check` is fine).
    const bannedPattern =
      /(^|[:-])(query|exec|execute|eval|command|shell|spawn|sql|readfile|writefile|read-file|write-file|fs)([:-]|$)/;
    for (const name of Object.values(IPC)) {
      expect(name.toLowerCase()).not.toMatch(bannedPattern);
    }
  });
});
