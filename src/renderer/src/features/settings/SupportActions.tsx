import { useCallback, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { IpcResult } from '../../../../shared/products';
import { PROBLEM_CATEGORIES, PROBLEM_DESCRIPTION_MAX_LENGTH } from '../../../../shared/support';
import type {
  CreateProblemReportInput,
  ExportSupportBundleInput,
  ExportSupportBundleResult,
  ProblemCategory,
  ProblemReport,
} from '../../../../shared/support';

export const SUPPORT_REPORT_ERROR_MESSAGE =
  'The support report could not be created. Please try again. Your saved sales are unaffected.';
export const SUPPORT_EXPORT_ERROR_MESSAGE =
  'The support bundle could not be exported. Please try again. Your saved sales are unaffected.';

const RECEIPT_PATTERN = /^GP-[0-9]{6,12}$/;
const REPORT_ID_PATTERN = /^SPR-[0-9]{8}-[A-F0-9]{16}$/;

export const PROBLEM_CATEGORY_OPTIONS: readonly {
  readonly value: ProblemCategory;
  readonly label: string;
}[] = [
  { value: 'CHECKOUT', label: 'Making a sale' },
  { value: 'PRINTING', label: 'Printing' },
  { value: 'INVENTORY', label: 'Inventory' },
  { value: 'GOOGLE_SHEETS', label: 'Google Sheets' },
  { value: 'STARTUP', label: 'Starting the application' },
  { value: 'UPDATE', label: 'Updating' },
  { value: 'OTHER', label: 'Other' },
];

export interface SupportReportDraft {
  readonly description: string;
  readonly category: string;
  readonly receiptNumber: string;
}

export interface SupportReportValidation {
  readonly input: CreateProblemReportInput | null;
  readonly errors: SupportReportValidationErrors;
}

export interface SupportReportValidationErrors {
  description?: string;
  category?: string;
  receiptNumber?: string;
}

/** Client-side usability validation. The trusted D1 service remains authoritative. */
export function validateSupportReportDraft(draft: SupportReportDraft): SupportReportValidation {
  const description = draft.description.trim();
  const receiptNumber = draft.receiptNumber.trim().toUpperCase();
  const errors: SupportReportValidationErrors = {};

  if (description.length === 0) {
    errors.description = 'Enter a brief description of what happened.';
  } else if (description.length > PROBLEM_DESCRIPTION_MAX_LENGTH) {
    errors.description = `The description must be ${PROBLEM_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }

  if (!PROBLEM_CATEGORIES.includes(draft.category as ProblemCategory)) {
    errors.category = 'Choose what you were doing.';
  }

  if (receiptNumber !== '' && !RECEIPT_PATTERN.test(receiptNumber)) {
    errors.receiptNumber = 'Enter a receipt number like GP-000123.';
  }

  if (Object.keys(errors).length > 0) return { input: null, errors };

  return {
    input: {
      description,
      category: draft.category as ProblemCategory,
      receiptNumber: receiptNumber === '' ? null : receiptNumber,
    },
    errors,
  };
}

function safeReportId(value: unknown): string | null {
  return typeof value === 'string' && REPORT_ID_PATTERN.test(value) ? value : null;
}

export interface CreateSupportReportCallbacks {
  readonly onRunningChange: (running: boolean) => void;
  readonly onCreated: (supportReportId: string) => void;
  readonly onError: (message: string | null) => void;
}

/** Duplicate-safe report action that never forwards backend or exception text to UI state. */
export function createSupportReportAction(
  invoke: (input: CreateProblemReportInput) => Promise<IpcResult<ProblemReport>>,
  callbacks: CreateSupportReportCallbacks,
): {
  readonly run: (input: CreateProblemReportInput) => Promise<string | null>;
  readonly isRunning: () => boolean;
} {
  let running = false;

  return {
    isRunning: () => running,
    run: async (input) => {
      if (running) return null;
      running = true;
      callbacks.onRunningChange(true);
      callbacks.onError(null);
      try {
        const result = await invoke(input);
        if (!result.ok) throw new Error('support report unavailable');
        const supportReportId = safeReportId(result.data.supportReportId);
        if (supportReportId === null) throw new Error('invalid support report response');
        callbacks.onCreated(supportReportId);
        return supportReportId;
      } catch {
        callbacks.onError(SUPPORT_REPORT_ERROR_MESSAGE);
        return null;
      } finally {
        running = false;
        callbacks.onRunningChange(false);
      }
    },
  };
}

export interface ExportSupportBundleCallbacks {
  readonly onRunningChange: (running: boolean) => void;
  readonly onNotice: (message: string | null) => void;
  readonly onError: (message: string | null) => void;
}

/**
 * Calls only the narrow D1 export shape: an optional validated opaque report ID.
 * Source files, archive contents, and destination paths are never renderer inputs.
 */
export function createExportSupportBundleAction(
  invoke: (input: ExportSupportBundleInput) => Promise<IpcResult<ExportSupportBundleResult>>,
  callbacks: ExportSupportBundleCallbacks,
): {
  readonly run: (supportReportId?: string | null) => Promise<ExportSupportBundleResult | null>;
  readonly isRunning: () => boolean;
} {
  let running = false;

  return {
    isRunning: () => running,
    run: async (supportReportId = null) => {
      if (running) return null;
      const validatedReportId = supportReportId === null ? null : safeReportId(supportReportId);
      if (supportReportId !== null && validatedReportId === null) {
        callbacks.onError(SUPPORT_EXPORT_ERROR_MESSAGE);
        return null;
      }

      running = true;
      callbacks.onRunningChange(true);
      callbacks.onError(null);
      callbacks.onNotice(null);
      try {
        const result = await invoke({ supportReportId: validatedReportId });
        if (!result.ok) throw new Error('support bundle unavailable');
        callbacks.onNotice(
          result.data.status === 'CANCELLED'
            ? 'Export cancelled. No support bundle was saved.'
            : 'Support bundle exported successfully.',
        );
        return result.data;
      } catch {
        callbacks.onError(SUPPORT_EXPORT_ERROR_MESSAGE);
        return null;
      } finally {
        running = false;
        callbacks.onRunningChange(false);
      }
    },
  };
}

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') return null;
  return window.pos;
}

export interface SupportActionsViewProps {
  readonly draft: SupportReportDraft;
  readonly validationErrors?: SupportReportValidation['errors'];
  readonly creating?: boolean;
  readonly createdReportId?: string | null;
  readonly reportError?: string | null;
  readonly exporting?: boolean;
  readonly exportNotice?: string | null;
  readonly exportError?: string | null;
  readonly onDraftChange?: (draft: SupportReportDraft) => void;
  readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  readonly onExport?: () => void;
}

export function SupportActionsView({
  draft,
  validationErrors = {},
  creating = false,
  createdReportId = null,
  reportError = null,
  exporting = false,
  exportNotice = null,
  exportError = null,
  onDraftChange,
  onSubmit,
  onExport,
}: SupportActionsViewProps) {
  const descriptionError = validationErrors.description;
  const categoryError = validationErrors.category;
  const receiptError = validationErrors.receiptNumber;
  const displayedReportId = safeReportId(createdReportId);

  return (
    <section
      className="diagnostics-subsection support-actions"
      aria-labelledby="support-actions-heading"
    >
      <h4 id="support-actions-heading">Report a Problem</h4>
      <p className="field-hint">
        Create a local report with diagnostic information and recent sanitized logs. Reports do not
        include payment card data or saved credentials.
      </p>

      <form className="settings-form support-report-form" noValidate onSubmit={onSubmit}>
        <label htmlFor="support-description">What happened?</label>
        <textarea
          id="support-description"
          rows={5}
          required
          maxLength={PROBLEM_DESCRIPTION_MAX_LENGTH}
          value={draft.description}
          disabled={creating}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={descriptionError ? 'support-description-error' : undefined}
          onChange={(event) => onDraftChange?.({ ...draft, description: event.target.value })}
        />
        {descriptionError && (
          <p id="support-description-error" className="product-form-error" role="alert">
            {descriptionError}
          </p>
        )}

        <label htmlFor="support-category">What were you doing?</label>
        <select
          id="support-category"
          required
          value={draft.category}
          disabled={creating}
          aria-invalid={categoryError ? true : undefined}
          aria-describedby={categoryError ? 'support-category-error' : undefined}
          onChange={(event) => onDraftChange?.({ ...draft, category: event.target.value })}
        >
          <option value="">Choose a category</option>
          {PROBLEM_CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {categoryError && (
          <p id="support-category-error" className="product-form-error" role="alert">
            {categoryError}
          </p>
        )}

        <label htmlFor="support-receipt">Receipt number (optional)</label>
        <input
          id="support-receipt"
          type="text"
          placeholder="GP-000123"
          autoComplete="off"
          value={draft.receiptNumber}
          disabled={creating}
          aria-invalid={receiptError ? true : undefined}
          aria-describedby={receiptError ? 'support-receipt-error' : undefined}
          onChange={(event) => onDraftChange?.({ ...draft, receiptNumber: event.target.value })}
        />
        {receiptError && (
          <p id="support-receipt-error" className="product-form-error" role="alert">
            {receiptError}
          </p>
        )}

        {reportError && (
          <p className="product-form-error" role="alert">
            {reportError}
          </p>
        )}
        {displayedReportId && (
          <p className="products-notice" role="status">
            Support report created locally. Report ID: <code>{displayedReportId}</code>
          </p>
        )}

        <div className="product-form-actions">
          <button type="submit" disabled={creating}>
            {creating ? 'Creating report...' : 'Create Support Report'}
          </button>
        </div>
      </form>

      <div className="support-export-action" aria-labelledby="support-export-heading">
        <h4 id="support-export-heading">Export Support Bundle</h4>
        <p className="field-hint">
          Choose where to save a sanitized support bundle. You can export a general bundle, or a
          newly created report will be included automatically.
        </p>
        {exportError && (
          <p className="product-form-error" role="alert">
            {exportError}
          </p>
        )}
        {exportNotice && (
          <p className="products-notice" role="status">
            {exportNotice}
          </p>
        )}
        <div className="product-form-actions">
          <button type="button" onClick={onExport} disabled={exporting || creating}>
            {exporting ? 'Exporting support bundle...' : 'Export Support Bundle'}
          </button>
        </div>
      </div>
    </section>
  );
}

const EMPTY_DRAFT: SupportReportDraft = { description: '', category: '', receiptNumber: '' };

export function SupportActions() {
  const [draft, setDraft] = useState<SupportReportDraft>(EMPTY_DRAFT);
  const [validationErrors, setValidationErrors] = useState<SupportReportValidation['errors']>({});
  const [creating, setCreating] = useState(false);
  const [createdReportId, setCreatedReportId] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const reportAction = useRef(
    createSupportReportAction(
      async (input) => {
        const api = pos();
        if (!api) throw new Error('support unavailable');
        return api.support.createReport(input);
      },
      {
        onRunningChange: setCreating,
        onCreated: (supportReportId) => {
          setCreatedReportId(supportReportId);
          setReportError(null);
        },
        onError: setReportError,
      },
    ),
  ).current;

  const exportAction = useRef(
    createExportSupportBundleAction(
      async (input) => {
        const api = pos();
        if (!api) throw new Error('support unavailable');
        return api.support.exportBundle(input);
      },
      {
        onRunningChange: setExporting,
        onNotice: setExportNotice,
        onError: setExportError,
      },
    ),
  ).current;

  const onDraftChange = useCallback((next: SupportReportDraft) => {
    setDraft(next);
    setValidationErrors({});
    setReportError(null);
  }, []);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (reportAction.isRunning()) return;
      const validation = validateSupportReportDraft(draft);
      setValidationErrors(validation.errors);
      setReportError(null);
      if (validation.input === null) return;
      void reportAction.run(validation.input);
    },
    [draft, reportAction],
  );

  const onExport = useCallback(() => {
    if (reportAction.isRunning()) return;
    void exportAction.run(createdReportId);
  }, [createdReportId, exportAction, reportAction]);

  return (
    <SupportActionsView
      draft={draft}
      validationErrors={validationErrors}
      creating={creating}
      createdReportId={createdReportId}
      reportError={reportError}
      exporting={exporting}
      exportNotice={exportNotice}
      exportError={exportError}
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
      onExport={onExport}
    />
  );
}
