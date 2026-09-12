import { PROBLEM_CATEGORIES, PROBLEM_DESCRIPTION_MAX_LENGTH } from '../../shared/support';
import type {
  CreateProblemReportInput,
  ExportSupportBundleInput,
  ProblemCategory,
} from '../../shared/support';
import { appErrors } from '../shared/appError';

const REPORT_ID_PATTERN = /^SPR-[0-9]{8}-[A-F0-9]{16}$/;
const RECEIPT_PATTERN = /^GP-[0-9]{6,12}$/;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpected(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw appErrors.validation('The support request contains unexpected fields.');
  }
}

export function validateSupportReportId(value: unknown): string {
  if (typeof value !== 'string' || !REPORT_ID_PATTERN.test(value)) {
    throw appErrors.validation('That support report could not be found.');
  }
  return value;
}

export function validateCreateProblemReportInput(raw: unknown): CreateProblemReportInput {
  const record = recordOf(raw, 'The problem report');
  rejectUnexpected(record, ['description', 'category', 'receiptNumber']);

  if (typeof record['description'] !== 'string') {
    throw appErrors.validation('Enter a brief description of what happened.');
  }
  const description = record['description'].trim();
  if (description.length === 0) {
    throw appErrors.validation('Enter a brief description of what happened.');
  }
  if (description.length > PROBLEM_DESCRIPTION_MAX_LENGTH) {
    throw appErrors.validation(
      `The description must be ${PROBLEM_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    );
  }

  if (
    typeof record['category'] !== 'string' ||
    !PROBLEM_CATEGORIES.includes(record['category'] as ProblemCategory)
  ) {
    throw appErrors.validation('Choose a valid problem category.');
  }

  let receiptNumber: string | null = null;
  if (record['receiptNumber'] !== undefined && record['receiptNumber'] !== null) {
    if (typeof record['receiptNumber'] !== 'string') {
      throw appErrors.validation('Enter a receipt number like GP-000123.');
    }
    const normalized = record['receiptNumber'].trim().toUpperCase();
    if (normalized !== '' && !RECEIPT_PATTERN.test(normalized)) {
      throw appErrors.validation('Enter a receipt number like GP-000123.');
    }
    receiptNumber = normalized === '' ? null : normalized;
  }

  return {
    description,
    category: record['category'] as ProblemCategory,
    receiptNumber,
  };
}

export function validateExportSupportBundleInput(raw: unknown): ExportSupportBundleInput {
  if (raw === undefined || raw === null) return { supportReportId: null };
  const record = recordOf(raw, 'The support bundle request');
  rejectUnexpected(record, ['supportReportId']);
  const value = record['supportReportId'];
  return {
    supportReportId: value === undefined || value === null ? null : validateSupportReportId(value),
  };
}
