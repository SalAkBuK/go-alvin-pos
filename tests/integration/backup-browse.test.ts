import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowseCandidateRegistry } from '../../src/main/backup/browseCandidate';
import { createSqliteSnapshot } from '../../src/main/backup/backupSnapshot';
import {
  resolveAndRevalidateCandidate,
  resolveBrowsedCandidate,
} from '../../src/main/backup/restoreCandidate';
import type { UnifiedCandidateSources } from '../../src/main/backup/restoreCandidate';
import { createMigratedDb, makeTempDir } from '../helpers/database';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2L-C.4 — Browse-for-backup candidate/token integration boundary.
 *
 * Exercises the real `resolveBrowsedCandidate` / `resolveAndRevalidateCandidate`
 * pipeline (the same independent verification 2L-C.3 already proves at the
 * `verifyBackupCandidate` level) end-to-end through a live, on-disk SQLite
 * file that sits OUTSIDE any managed backup directory — exactly what a native
 * "Browse for a backup file…" selection looks like. Does not re-derive every
 * `verifyBackupCandidate` rejection reason (`backup-discovery.test.ts` already
 * covers those); this proves the Browse-specific token/opacity/revalidation
 * behavior built on top of it.
 */

const TARGET_SCHEMA_VERSION = 1;

const tempDirs: TempDir[] = [];
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()!.cleanup();
});

function temp(prefix: string): TempDir {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function makeBrowsedFile(dir: string, name = 'my-backup.sqlite'): Promise<string> {
  const source = await createMigratedDb();
  const filePath = join(dir, name);
  try {
    await createSqliteSnapshot(source, filePath);
  } finally {
    source.close();
  }
  return filePath;
}

/**
 * A current-database stand-in whose configured managed roots do not exist, so
 * `resolveAndRevalidateCandidate` never finds a managed candidate or catalog
 * row and always falls through to the Browse-token branch under test.
 */
function noManagedSources(root: string): UnifiedCandidateSources {
  return { localBackupsRoot: join(root, 'no-managed-backups-here'), offDeviceBackupsRoot: null };
}

describe('Browse-for-backup candidate/token flow (Phase 2L-C.4)', () => {
  it('a validly Browse-selected file becomes an opaque, pathless restore candidate', async () => {
    const dir = temp('gpp-browse-valid-');
    const filePath = await makeBrowsedFile(dir.path);
    const registry = createBrowseCandidateRegistry();

    const candidate = await resolveBrowsedCandidate(filePath, registry);

    expect(candidate.sourceKind).toBe('BROWSED');
    expect(candidate.catalogued).toBe(false);
    expect(candidate.locationKind).toBe('LOCAL_DISK');
    expect(candidate.backupId).toMatch(/^browsed-[0-9a-f]{32}$/);

    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain(dir.path);
    expect(serialized).not.toContain(filePath);
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/backups\//);
  });

  it('rejects a corrupt (non-SQLite) file', async () => {
    const dir = temp('gpp-browse-corrupt-');
    const filePath = join(dir.path, 'corrupt.sqlite');
    await writeFile(filePath, 'not a sqlite file at all');
    const registry = createBrowseCandidateRegistry();

    await expect(resolveBrowsedCandidate(filePath, registry)).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
    });
  });

  it('rejects an unrelated SQLite database (no Go Phones schema)', async () => {
    const dir = temp('gpp-browse-unrelated-');
    const filePath = join(dir.path, 'unrelated.sqlite');
    const db = new Database(filePath);
    db.exec('CREATE TABLE some_other_app (id INTEGER PRIMARY KEY, note TEXT)');
    db.close();
    const registry = createBrowseCandidateRegistry();

    await expect(resolveBrowsedCandidate(filePath, registry)).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
    });
  });

  it('rejects a schema-incompatible file — Browse verification itself refuses it, so no token is ever minted for it', async () => {
    const dir = temp('gpp-browse-incompatible-');
    const filePath = await makeBrowsedFile(dir.path);
    // Simulate a schema newer than this build's target (exact-match policy).
    const tampered = new Database(filePath);
    tampered.prepare('UPDATE schema_migrations SET version = 2 WHERE version = 1').run();
    tampered.close();

    const registry = createBrowseCandidateRegistry();
    await expect(resolveBrowsedCandidate(filePath, registry)).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
    });
  });

  it('rejects an unknown / forged token — never partially trusted', async () => {
    const dir = temp('gpp-browse-unknown-token-');
    const registry = createBrowseCandidateRegistry();
    const currentDb = await createMigratedDb();
    try {
      await expect(
        resolveAndRevalidateCandidate(
          currentDb,
          noManagedSources(dir.path),
          registry,
          'browsed-0000000000000000000000000000dead',
          TARGET_SCHEMA_VERSION,
        ),
      ).rejects.toMatchObject({ code: 'RESTORE_CANDIDATE_NOT_FOUND' });
    } finally {
      currentDb.close();
    }
  });

  it('rejects an expired Browse token', async () => {
    const dir = temp('gpp-browse-expired-token-');
    const filePath = await makeBrowsedFile(dir.path);
    let nowMs = Date.parse('2026-09-11T10:00:00.000Z');
    const registry = createBrowseCandidateRegistry({ ttlMs: 1000, now: () => new Date(nowMs) });

    const browsed = await resolveBrowsedCandidate(filePath, registry);
    nowMs += 2000; // past the 1-second TTL

    const currentDb = await createMigratedDb();
    try {
      await expect(
        resolveAndRevalidateCandidate(
          currentDb,
          noManagedSources(dir.path),
          registry,
          browsed.backupId,
          TARGET_SCHEMA_VERSION,
        ),
      ).rejects.toMatchObject({ code: 'RESTORE_CANDIDATE_NOT_FOUND' });
    } finally {
      currentDb.close();
    }
  });

  it('rejects a candidate that was modified after Browse, before it is ever restored', async () => {
    const dir = temp('gpp-browse-modified-');
    const filePath = await makeBrowsedFile(dir.path);
    const registry = createBrowseCandidateRegistry();
    const browsed = await resolveBrowsedCandidate(filePath, registry);

    // Tamper with the exact file the token points at, after Browse verified it.
    await writeFile(filePath, 'tampered after browse, before restore');

    const currentDb = await createMigratedDb();
    try {
      await expect(
        resolveAndRevalidateCandidate(
          currentDb,
          noManagedSources(dir.path),
          registry,
          browsed.backupId,
          TARGET_SCHEMA_VERSION,
        ),
      ).rejects.toMatchObject({ code: 'RESTORE_CANDIDATE_INVALID' });
    } finally {
      currentDb.close();
    }
  });

  it('a still-valid browsed candidate revalidates successfully (the restore()-time re-check)', async () => {
    const dir = temp('gpp-browse-revalidate-ok-');
    const filePath = await makeBrowsedFile(dir.path);
    const registry = createBrowseCandidateRegistry();
    const browsed = await resolveBrowsedCandidate(filePath, registry);

    const currentDb = await createMigratedDb();
    try {
      const resolved = await resolveAndRevalidateCandidate(
        currentDb,
        noManagedSources(dir.path),
        registry,
        browsed.backupId,
        TARGET_SCHEMA_VERSION,
      );
      expect(resolved.candidate.backupId).toBe(browsed.backupId);
      expect(resolved.candidate.sourceKind).toBe('BROWSED');
      expect(resolved.row).toBeNull();
    } finally {
      currentDb.close();
    }
  });
});
