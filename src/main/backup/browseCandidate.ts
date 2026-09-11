import { randomBytes } from 'node:crypto';

/**
 * In-memory, main-process-owned registry for one "Browse for a backup file…"
 * selection (`DATA_MODEL.md §52A` unified restore discovery; Phase 2L-C).
 *
 * The renderer never receives or submits a filesystem path. A native-dialog
 * selection is verified once, then named only by an opaque token here. The
 * token is resolved back to its real path ONLY inside the trusted main
 * process, immediately before the full independent verification pipeline
 * runs again — the registry itself proves nothing about the file's current
 * validity, it only remembers where to look.
 *
 * Entries expire after `ttlMs` so a stale browsed selection from a much
 * earlier Settings visit cannot be replayed indefinitely; they are never
 * persisted across an app restart.
 */
export interface BrowseCandidateRegistry {
  /** Register a freshly verified selection and return its opaque token. */
  register(canonicalFilePath: string): string;
  /** Resolve a token to its real path, or `null` if unknown/expired. */
  resolve(token: string): string | null;
}

const BROWSE_TOKEN_PREFIX = 'browsed-';
const DEFAULT_TTL_MS = 30 * 60_000;

export function createBrowseCandidateRegistry(options?: {
  readonly ttlMs?: number;
  readonly now?: () => Date;
}): BrowseCandidateRegistry {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = options?.now ?? ((): Date => new Date());
  const entries = new Map<string, { readonly filePath: string; readonly expiresAt: number }>();

  return {
    register(canonicalFilePath): string {
      const token = `${BROWSE_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
      entries.set(token, { filePath: canonicalFilePath, expiresAt: now().getTime() + ttlMs });
      return token;
    },
    resolve(token): string | null {
      const entry = entries.get(token);
      if (!entry) return null;
      if (entry.expiresAt < now().getTime()) {
        entries.delete(token);
        return null;
      }
      return entry.filePath;
    },
  };
}

export function isBrowseCandidateToken(backupId: string): boolean {
  return backupId.startsWith(BROWSE_TOKEN_PREFIX);
}
