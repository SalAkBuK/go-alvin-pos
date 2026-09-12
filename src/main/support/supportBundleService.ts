import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DiagnosticSnapshot } from '../../shared/diagnostics';
import type { ExportSupportBundleResult, ProblemReport } from '../../shared/support';
import type { Logger } from '../app/logger';
import type { ProductionDatabase } from '../database/database';
import type { CrashEvidenceCollection } from '../diagnostics/crashEvidence';
import { collectRecentSanitizedLogs } from './recentLogs';
import { assertPrivacySafeText, sanitizeSupportText, sanitizeSupportValue } from './supportPrivacy';
import {
  validateCreateProblemReportInput,
  validateExportSupportBundleInput,
  validateSupportReportId,
} from './supportValidation';
import { createZipArchive } from './zipArchive';

const REPORT_FORMAT_VERSION = 1;
const BUNDLE_FORMAT_VERSION = 1;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

interface MigrationSummary {
  readonly available: boolean;
  readonly migrations: readonly {
    readonly version: number;
    readonly name: string;
    readonly appliedAt: string;
  }[];
  readonly issueCode: 'MIGRATION_HISTORY_UNAVAILABLE' | null;
}

export interface PreparedSupportBundle {
  readonly archive: Buffer;
  readonly suggestedFileName: string;
  readonly supportReportId: string | null;
  readonly createdAt: string;
}

export interface SupportBundleServiceDeps {
  readonly appVersion: string;
  readonly buildIdentifier?: string | null;
  readonly installationId: string;
  readonly reportsRoot: string;
  readonly logsRoot: string;
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly getDiagnostics: () => Promise<DiagnosticSnapshot>;
  readonly getCrashEvidence?: () => CrashEvidenceCollection;
  readonly now?: () => Date;
  readonly randomHex?: () => string;
}

export interface SupportBundleService {
  createProblemReport(raw: unknown): Promise<ProblemReport>;
  prepareBundle(raw?: unknown): Promise<PreparedSupportBundle>;
  writePreparedBundle(
    prepared: PreparedSupportBundle,
    destinationPath: string,
  ): Promise<ExportSupportBundleResult>;
}

function identifier(prefix: 'SPR' | 'SB', date: Date, randomHex: () => string): string {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const entropy = randomHex()
    .replace(/[^A-F0-9]/gi, '')
    .slice(0, 16)
    .toUpperCase();
  if (entropy.length !== 16) throw new Error('Support identifier entropy unavailable.');
  return `${prefix}-${day}-${entropy}`;
}

function reportPath(reportsRoot: string, reportId: string): string {
  return join(reportsRoot, `${validateSupportReportId(reportId)}.json`);
}

function jsonContent(value: unknown): Buffer {
  const sanitized = sanitizeSupportValue(value);
  const text = `${JSON.stringify(sanitized, null, 2)}\n`;
  assertPrivacySafeText(text);
  return Buffer.from(text, 'utf8');
}

async function writeAtomic(path: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function migrationSummary(database: ProductionDatabase | null): MigrationSummary {
  if (!database || database.closed) {
    return { available: false, migrations: [], issueCode: 'MIGRATION_HISTORY_UNAVAILABLE' };
  }
  try {
    const rows = database.connection
      .prepare(
        'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
      )
      .all() as Array<{ version: number; name: string; appliedAt: string }>;
    return {
      available: true,
      migrations: rows.map((row) => ({
        version: row.version,
        name: sanitizeSupportText(row.name),
        appliedAt: sanitizeSupportText(row.appliedAt),
      })),
      issueCode: null,
    };
  } catch {
    return { available: false, migrations: [], issueCode: 'MIGRATION_HISTORY_UNAVAILABLE' };
  }
}

function isProblemReport(value: unknown): value is ProblemReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ProblemReport>;
  try {
    validateSupportReportId(record.supportReportId);
  } catch {
    return false;
  }
  return (
    typeof record.description === 'string' &&
    typeof record.category === 'string' &&
    (record.receiptNumber === null || typeof record.receiptNumber === 'string') &&
    typeof record.createdAt === 'string' &&
    typeof record.appVersion === 'string' &&
    (record.schemaVersion === null || typeof record.schemaVersion === 'number') &&
    typeof record.installationId === 'string' &&
    typeof record.diagnostics === 'object' &&
    record.diagnostics !== null
  );
}

export function createSupportBundleService(deps: SupportBundleServiceDeps): SupportBundleService {
  const now = deps.now ?? (() => new Date());
  const randomHex = deps.randomHex ?? (() => randomBytes(8).toString('hex'));

  async function createProblemReport(raw: unknown): Promise<ProblemReport> {
    const input = validateCreateProblemReportInput(raw);
    const created = now();
    const supportReportId = identifier('SPR', created, randomHex);
    try {
      const diagnostics = sanitizeSupportValue(await deps.getDiagnostics()) as DiagnosticSnapshot;
      const report: ProblemReport = {
        supportReportId,
        description: sanitizeSupportText(input.description),
        category: input.category,
        receiptNumber: input.receiptNumber ?? null,
        createdAt: created.toISOString(),
        appVersion: deps.appVersion,
        schemaVersion: diagnostics.components.database.schemaVersion,
        installationId: deps.installationId,
        diagnostics,
      };
      await writeAtomic(reportPath(deps.reportsRoot, supportReportId), jsonContent(report));
      deps.logger.info('diagnostics', 'support.report.created', { supportReportId });
      return report;
    } catch (error) {
      deps.logger.error('diagnostics', 'support.report.creation-failed', {
        supportReportId,
        errorCode: 'SUPPORT_REPORT_CREATE_FAILED',
      });
      throw error;
    }
  }

  async function loadProblemReport(supportReportId: string): Promise<ProblemReport> {
    const raw = await readFile(reportPath(deps.reportsRoot, supportReportId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isProblemReport(parsed) || parsed.supportReportId !== supportReportId) {
      throw new Error('Invalid stored support report.');
    }
    return sanitizeSupportValue(parsed) as ProblemReport;
  }

  async function prepareBundle(raw?: unknown): Promise<PreparedSupportBundle> {
    const input = validateExportSupportBundleInput(raw);
    const created = now();
    const supportReportId = input.supportReportId ?? null;
    const correlationId = supportReportId ?? identifier('SB', created, randomHex);
    try {
      const diagnostics = sanitizeSupportValue(await deps.getDiagnostics()) as DiagnosticSnapshot;
      const report = supportReportId ? await loadProblemReport(supportReportId) : null;
      const logs = await collectRecentSanitizedLogs(deps.logsRoot);
      const crashEvidence = deps.getCrashEvidence?.() ?? {
        records: [],
        inspectedFiles: 0,
        issues: [],
      };
      const migrations = migrationSummary(deps.getDatabase());
      const entries = [
        {
          name: 'support-info.json',
          content: jsonContent({
            formatVersion: BUNDLE_FORMAT_VERSION,
            generatedAt: created.toISOString(),
            supportReportId,
            bundleCorrelationId: correlationId,
            application: {
              version: deps.appVersion,
              buildIdentifier: deps.buildIdentifier ?? null,
              schemaVersion: diagnostics.components.database.schemaVersion,
              installationId: deps.installationId,
            },
            privacy: {
              sanitized: true,
              databaseIncluded: false,
              oauthWrapperIncluded: false,
              arbitraryFilesIncluded: false,
            },
          }),
        },
        { name: 'diagnostics.json', content: jsonContent(diagnostics) },
        { name: 'migration-history.json', content: jsonContent(migrations) },
        { name: 'backup-status.json', content: jsonContent(diagnostics.components.backup) },
        {
          name: 'export-queue-summary.json',
          content: jsonContent({
            enabled: diagnostics.components.google.enabled,
            setupState: diagnostics.components.google.setupState,
            needsReauthorization: diagnostics.components.google.needsReauthorization,
            pending: diagnostics.components.google.pendingExports,
            exporting: diagnostics.components.google.exportingExports,
            failed: diagnostics.components.google.failedExports,
            lastSuccessfulExportAt: diagnostics.components.google.lastSuccessfulExportAt,
            issueCode: diagnostics.components.google.issueCode,
          }),
        },
        {
          name: 'bundle-manifest.json',
          content: jsonContent({
            formatVersion: BUNDLE_FORMAT_VERSION,
            logCollection: {
              includedRecords: logs.includedRecords,
              inspectedFiles: logs.inspectedFiles,
              issues: logs.issues,
              maxBytes: 1024 * 1024,
              maxFiles: 5,
            },
            optionalSections: {
              problemReport: report !== null,
              recentLogs: logs.includedRecords > 0,
              migrationHistory: migrations.available,
              crashEvidence: crashEvidence.records.length > 0,
            },
            crashEvidenceCollection: {
              includedRecords: crashEvidence.records.length,
              inspectedFiles: crashEvidence.inspectedFiles,
              issues: crashEvidence.issues,
            },
          }),
        },
        ...(logs.includedRecords > 0
          ? [{ name: 'recent-app.log', content: Buffer.from(logs.content, 'utf8') }]
          : []),
        ...(report
          ? [
              {
                name: 'problem-report.json',
                content: jsonContent({ formatVersion: REPORT_FORMAT_VERSION, ...report }),
              },
            ]
          : []),
        ...(crashEvidence.records.length > 0
          ? [
              {
                name: 'crash-evidence.json',
                content: jsonContent({
                  formatVersion: 1,
                  records: crashEvidence.records,
                }),
              },
            ]
          : []),
      ];

      for (const entry of entries) assertPrivacySafeText(entry.content.toString('utf8'));
      const archive = createZipArchive(entries, created);
      if (archive.length > MAX_BUNDLE_BYTES) throw new Error('Support bundle exceeds safe limit.');
      const suggestedFileName = `GoPhonesPOS-Support-${created.toISOString().slice(0, 10)}-${correlationId}.zip`;
      deps.logger.info('diagnostics', 'support.bundle.generated', {
        supportReportId,
        correlationId,
      });
      return {
        archive,
        suggestedFileName,
        supportReportId,
        createdAt: created.toISOString(),
      };
    } catch (error) {
      deps.logger.error('diagnostics', 'support.bundle.generation-failed', {
        supportReportId,
        correlationId,
        errorCode: 'SUPPORT_BUNDLE_GENERATION_FAILED',
      });
      throw error;
    }
  }

  async function writePreparedBundle(
    prepared: PreparedSupportBundle,
    destinationPath: string,
  ): Promise<ExportSupportBundleResult> {
    try {
      await writeAtomic(destinationPath, prepared.archive);
      deps.logger.info('diagnostics', 'support.bundle.exported', {
        supportReportId: prepared.supportReportId,
        fileName: sanitizeSupportText(basename(destinationPath)),
        sizeBytes: prepared.archive.length,
      });
      return {
        status: 'COMPLETED',
        fileName: basename(destinationPath),
        supportReportId: prepared.supportReportId,
        createdAt: prepared.createdAt,
        sizeBytes: prepared.archive.length,
      };
    } catch (error) {
      deps.logger.error('diagnostics', 'support.bundle.export-failed', {
        supportReportId: prepared.supportReportId,
        errorCode: 'SUPPORT_BUNDLE_EXPORT_FAILED',
      });
      throw error;
    }
  }

  return { createProblemReport, prepareBundle, writePreparedBundle };
}
