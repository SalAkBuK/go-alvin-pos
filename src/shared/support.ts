import type { DiagnosticSnapshot } from './diagnostics';

/** Narrow, user-selectable V1 problem categories (`SUPPORT_DIAGNOSTICS.md §19`). */
export const PROBLEM_CATEGORIES = [
  'CHECKOUT',
  'PRINTING',
  'INVENTORY',
  'GOOGLE_SHEETS',
  'STARTUP',
  'UPDATE',
  'OTHER',
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

export const PROBLEM_DESCRIPTION_MAX_LENGTH = 4_000;

/** Renderer input contains data only: never a path, archive name, or source-file selection. */
export interface CreateProblemReportInput {
  readonly description: string;
  readonly category: ProblemCategory;
  readonly receiptNumber?: string | null;
}

/** A locally persisted, privacy-sanitized report. No business row or remote service is involved. */
export interface ProblemReport {
  readonly supportReportId: string;
  readonly description: string;
  readonly category: ProblemCategory;
  readonly receiptNumber: string | null;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly schemaVersion: number | null;
  readonly installationId: string;
  readonly diagnostics: DiagnosticSnapshot;
}

/** The only optional selector for bundle export; the trusted process resolves the report file. */
export interface ExportSupportBundleInput {
  readonly supportReportId?: string | null;
}

export type ExportSupportBundleResult =
  | { readonly status: 'CANCELLED' }
  | {
      readonly status: 'COMPLETED';
      readonly fileName: string;
      readonly supportReportId: string | null;
      readonly createdAt: string;
      readonly sizeBytes: number;
    };
