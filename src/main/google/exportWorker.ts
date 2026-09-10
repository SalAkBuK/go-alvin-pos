import type Database from 'better-sqlite3';
import type { Logger } from '../app/logger';
import { writeLastSuccessfulSync } from '../settings/googleSettingsRepository';
import type { GoogleAuthProvider } from './googleAuthProvider';
import {
  claimNextJob,
  markExported,
  readSaleItemsForExport,
  recordFailure,
  recoverStaleExporting,
} from './exportJobRepository';
import { buildSaleItemRows, buildSalesRow } from './exportSerialization';
import { upsertSaleItemRows, upsertSalesRow } from './exportUpsert';
import { classifyThrown, toLastError } from './googleRedaction';
import type { SheetsTransport } from './sheetsTransport';

/**
 * The background Google Sheets export worker (`ARCHITECTURE.md §23`-`§24`;
 * `POS_WORKFLOWS.md §44`-`§49`; `REQ-GSHEET-006`, `REQ-GSHEET-015`; `task §10`-
 * `§15`).
 *
 * A secondary, post-commit operation: it reads committed SQLite state and
 * converges the Google Sheet to it, one job at a time, on a non-overlapping
 * timer. It NEVER touches a sale / payment / inventory / receipt number, and a
 * Google failure never changes local state (`AGENTS.md` invariant 2 & 7).
 *
 * Convergence semantics (corrected `REQ-GSHEET-015`): a job is finalized only
 * when the revision written still equals `target_sync_version` (CAS); a stale or
 * ambiguous result is discarded and the job stays eligible for the newest
 * target; repeated idempotent upserts converge the row.
 */

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_EXPORTING_MS = 5 * 60_000;

export interface ExportContext {
  readonly spreadsheetId: string;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
  readonly businessTimezone: string;
  readonly auth: GoogleAuthProvider;
  /** Active OAuth credential generation this context was resolved for (auth-health attribution). */
  readonly credentialGeneration: number;
}

export interface ExportWorkerDeps {
  readonly db: Database.Database;
  readonly logger: Logger;
  /**
   * The resolved export context, or `null` when the integration is not
   * enabled-and-configured — in which case the worker makes NO network request
   * and does NOT change `attempt_count` (`task §6`, `TEST-GSHEET-018`).
   */
  readonly resolveContext: () => Promise<ExportContext | null>;
  /** Build a per-attempt transport bound to the abort signal (a fake in tests). */
  readonly createTransport: (ctx: ExportContext, signal: AbortSignal) => SheetsTransport;
  /**
   * Report the current generation's Google auth health after a definite export
   * outcome (`Correction A`): `'auth-failure'` on a definite `AUTH` failure,
   * `'ok'` after a successful authenticated Sheets write. Never called for an
   * `unknownOutcome`.
   */
  readonly reportAuthHealth?: (result: 'auth-failure' | 'ok', credentialGeneration: number) => void;
  /**
   * A definite structural failure of the configured spreadsheet target was
   * established (confirmed on the job's normal retry, `REQ-GSHEET-020`). The job
   * failure is already recorded per the normal rules before this fires; the
   * handler invalidates `google_spreadsheet_id` and moves the integration to
   * `Connected / setup incomplete`. The worker never creates a replacement.
   */
  readonly onStructuralTargetFailure?: (
    spreadsheetId: string,
    kind: 'NOT_FOUND' | 'PERMISSION',
    credentialGeneration: number,
  ) => void;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly staleExportingMs?: number;
}

export interface ExportWorker {
  start(): void;
  /** Synchronous, safe to call from `app.on('will-quit')` before the DB closes. */
  stopSync(): void;
  /** One full drain pass (stale recovery + claim/process until idle). For startup + tests. */
  runOnce(): Promise<void>;
  recoverStale(): number;
  readonly running: boolean;
}

export function createExportWorker(deps: ExportWorkerDeps): ExportWorker {
  const { db, logger, resolveContext, createTransport } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const staleExportingMs = deps.staleExportingMs ?? DEFAULT_STALE_EXPORTING_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let activeAbort: AbortController | null = null;
  const skip = new Set<string>();

  function recoverStale(): number {
    const nowIso = now();
    const staleBefore = new Date(Date.parse(nowIso) - staleExportingMs).toISOString();
    const recovered = recoverStaleExporting(db, { now: nowIso, staleBefore });
    if (recovered > 0) {
      logger.info('export', 'google.export.stale_exporting_recovered', { count: recovered });
    }
    return recovered;
  }

  async function processJob(
    ctx: ExportContext,
    job: { id: string; saleId: string; targetSyncVersion: number },
    sale: Parameters<typeof buildSalesRow>[0],
  ): Promise<void> {
    const written = job.targetSyncVersion;
    const controller = new AbortController();
    activeAbort = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const transport = createTransport(ctx, controller.signal);
      const items = readSaleItemsForExport(db, job.saleId);
      const upsertLog = {
        warn: (event: string, fields: Record<string, unknown>): void => {
          logger.warn('export', event, fields);
        },
      };
      logger.info('export', 'google.export.started', {
        saleId: job.saleId,
        exportJobId: job.id,
        targetSyncVersion: written,
      });

      try {
        await upsertSalesRow(
          transport,
          ctx.salesSheetName,
          job.saleId,
          buildSalesRow(sale, ctx.businessTimezone, now()),
          upsertLog,
        );
        await upsertSaleItemRows(
          transport,
          ctx.saleItemsSheetName,
          job.saleId,
          buildSaleItemRows(sale, items),
          upsertLog,
        );

        // The upserts above are successful authenticated Sheets operations —
        // clear any stale current-generation auth-health flag (`Correction A`).
        deps.reportAuthHealth?.('ok', ctx.credentialGeneration);

        const finalized = markExported(db, { id: job.id, writtenVersion: written, now: now() });
        if (finalized === 1) {
          const syncedAt = now();
          writeLastSuccessfulSync(db, syncedAt);
          logger.info('export', 'google.export.completed', {
            saleId: job.saleId,
            exportJobId: job.id,
            exportedSyncVersion: written,
          });
        } else {
          logger.info('export', 'google.export.stale_acknowledgment_discarded', {
            saleId: job.saleId,
            exportJobId: job.id,
            writtenVersion: written,
            reason: 'target advanced during export',
          });
        }
      } catch (error) {
        const classified = classifyThrown(error);
        if (classified.unknownOutcome) {
          // Ambiguous: Google may have applied the write. Do NOT record a
          // definite failure — leave the job EXPORTING for stale recovery so a
          // stale request can never be compounded with a newer one (`task §12`).
          logger.warn('export', 'google.export.unknown_outcome', {
            saleId: job.saleId,
            exportJobId: job.id,
            category: classified.category,
            httpStatus: classified.httpStatus,
          });
          return;
        }
        const result = recordFailure(db, {
          id: job.id,
          writtenVersion: written,
          now: now(),
          sanitizedError: toLastError(classified.category, classified.message),
        });

        // Current-generation auth health (`Correction A`): a definite AUTH
        // failure marks the active credential generation as needing
        // re-authorization. Historical job evidence is never rewritten.
        if (classified.category === 'AUTH') {
          deps.reportAuthHealth?.('auth-failure', ctx.credentialGeneration);
        }

        // Structural spreadsheet-target failure (`REQ-GSHEET-020`): only a
        // definite, machine-readable not-found / permission result, and only
        // after it is confirmed on the job's normal retry (attempt ≥ 2) so a
        // single transient blip is never misclassified. The job keeps its
        // failure/retry evidence; the target is then invalidated.
        if (
          classified.structuralTarget &&
          (classified.category === 'NOT_FOUND' || classified.category === 'PERMISSION') &&
          result.changed > 0 &&
          result.attemptCount >= 2
        ) {
          logger.warn('export', 'google.export.structural_target_failure', {
            saleId: job.saleId,
            exportJobId: job.id,
            category: classified.category,
            httpStatus: classified.httpStatus,
          });
          deps.onStructuralTargetFailure?.(
            ctx.spreadsheetId,
            classified.category,
            ctx.credentialGeneration,
          );
        }

        if (result.changed === 0) {
          logger.info('export', 'google.export.stale_acknowledgment_discarded', {
            saleId: job.saleId,
            exportJobId: job.id,
            writtenVersion: written,
            reason: 'target advanced before failure was recorded',
          });
        } else if (result.terminal) {
          logger.error('google', 'google.export.failed', {
            saleId: job.saleId,
            exportJobId: job.id,
            category: classified.category,
            httpStatus: classified.httpStatus,
            attemptCount: result.attemptCount,
          });
        } else {
          logger.warn('export', 'google.export.retry_scheduled', {
            saleId: job.saleId,
            exportJobId: job.id,
            category: classified.category,
            httpStatus: classified.httpStatus,
            attemptCount: result.attemptCount,
          });
        }
      }
    } finally {
      clearTimeout(timeout);
      activeAbort = null;
    }
  }

  async function runOnce(): Promise<void> {
    recoverStale();
    while (!stopping) {
      const ctx = await resolveContext();
      if (!ctx) {
        return;
      }
      const claim = claimNextJob(db, now(), [...skip]);
      if (claim.outcome === 'idle') {
        return;
      }
      if (claim.outcome === 'invariant') {
        logger.error('google', 'google.export.invariant_violation', {
          saleId: claim.saleId,
          exportJobId: claim.jobId,
          jobTargetVersion: claim.jobTargetVersion,
          saleSyncVersion: claim.saleSyncVersion,
        });
        skip.add(claim.jobId);
        continue;
      }
      await processJob(ctx, claim.job, claim.sale);
    }
  }

  function scheduleTick(delayMs: number): void {
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (stopping) {
      return;
    }
    try {
      await runOnce();
    } catch (error) {
      logger.error('google', 'google.export.tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopping) {
        scheduleTick(pollIntervalMs);
      }
    }
  }

  return {
    get running(): boolean {
      return timer !== null && !stopping;
    },

    start(): void {
      if (timer !== null || stopping) {
        return;
      }
      logger.info('export', 'google.export.worker_started', { pollIntervalMs });
      scheduleTick(0);
    },

    stopSync(): void {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Abort only OUR local wait for the response. An in-flight request is left
      // in whatever ambiguous state it is in: `abort()` cannot revoke a request
      // Google has already accepted, and Google may finish applying it after our
      // process exits. The claimed job is deliberately NOT returned to `PENDING`
      // here — a fast restart could otherwise re-claim and re-append it before
      // the first write is visible, creating a duplicate transaction row
      // (`REQ-GSHEET-007`, `TEST-GSHEET-014`). It stays `EXPORTING`; the 5-minute
      // startup stale-`EXPORTING` recovery (`DATA_MODEL.md §24`,
      // `POS_WORKFLOWS.md §49`, `TEST-DEFAULT-002`) makes it retryable
      // idempotently, exactly as after a crash.
      activeAbort?.abort();
    },

    runOnce,
    recoverStale,
  };
}
