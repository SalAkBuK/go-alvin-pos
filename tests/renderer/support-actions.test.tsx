import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PROBLEM_CATEGORY_OPTIONS,
  SUPPORT_EXPORT_ERROR_MESSAGE,
  SUPPORT_REPORT_ERROR_MESSAGE,
  SupportActions,
  SupportActionsView,
  createExportSupportBundleAction,
  createSupportReportAction,
  validateSupportReportDraft,
} from '../../src/renderer/src/features/settings/SupportActions';
import { PROBLEM_CATEGORIES, PROBLEM_DESCRIPTION_MAX_LENGTH } from '../../src/shared/support';
import type {
  CreateProblemReportInput,
  ExportSupportBundleResult,
  ProblemReport,
} from '../../src/shared/support';

const REPORT_ID = 'SPR-20260912-0123456789ABCDEF';
const RAW_SENSITIVE_DETAIL =
  'C:\\Users\\Owner\\AppData\\reports\\secret.json token=secret Jane Doe 281-555-0100';

function report(supportReportId: string = REPORT_ID): ProblemReport {
  return {
    supportReportId,
    description: 'The printer stopped responding.',
    category: 'PRINTING',
    receiptNumber: 'GP-000123',
    createdAt: '2026-09-12T10:00:00.000Z',
    appVersion: '1.2.3',
    schemaVersion: 1,
    installationId: 'INST-12345678',
    diagnostics: {} as ProblemReport['diagnostics'],
  };
}

function view(overrides: Partial<React.ComponentProps<typeof SupportActionsView>> = {}): string {
  return renderToStaticMarkup(
    <SupportActionsView
      draft={{ description: '', category: '', receiptNumber: '' }}
      {...overrides}
    />,
  );
}

describe('Report a Problem form', () => {
  it('renders bounded, labelled fields and only friendly D1 category choices', () => {
    const html = renderToStaticMarkup(<SupportActions />);
    expect(html).toContain('Report a Problem');
    expect(html).toContain('What happened?');
    expect(html).toContain('What were you doing?');
    expect(html).toContain('Receipt number (optional)');
    expect(html).toContain(`maxLength="${PROBLEM_DESCRIPTION_MAX_LENGTH}"`);
    expect(html).toContain('Create Support Report');
    expect(html).not.toContain('aria-invalid');

    expect(PROBLEM_CATEGORY_OPTIONS.map((option) => option.value)).toEqual(PROBLEM_CATEGORIES);
    for (const option of PROBLEM_CATEGORY_OPTIONS) expect(html).toContain(option.label);
    expect(html).not.toContain('Crash');
    expect(html).not.toContain('Activity Log');
  });

  it('requires a non-blank description and an allowed category', () => {
    const missing = validateSupportReportDraft({
      description: '   ',
      category: '',
      receiptNumber: '',
    });
    expect(missing.input).toBeNull();
    expect(missing.errors.description).toMatch(/brief description/i);
    expect(missing.errors.category).toMatch(/choose/i);

    const tooLong = validateSupportReportDraft({
      description: 'x'.repeat(PROBLEM_DESCRIPTION_MAX_LENGTH + 1),
      category: 'CHECKOUT',
      receiptNumber: '',
    });
    expect(tooLong.input).toBeNull();
    expect(tooLong.errors.description).toContain(String(PROBLEM_DESCRIPTION_MAX_LENGTH));

    const unsupported = validateSupportReportDraft({
      description: 'Something happened.',
      category: 'ARBITRARY_CATEGORY',
      receiptNumber: '',
    });
    expect(unsupported.input).toBeNull();
    expect(unsupported.errors.category).toMatch(/choose/i);
  });

  it('accepts an omitted receipt and normalizes a supported optional receipt', () => {
    expect(
      validateSupportReportDraft({
        description: ' Checkout did not finish. ',
        category: 'CHECKOUT',
        receiptNumber: '',
      }).input,
    ).toEqual({
      description: 'Checkout did not finish.',
      category: 'CHECKOUT',
      receiptNumber: null,
    });

    expect(
      validateSupportReportDraft({
        description: 'Receipt would not print.',
        category: 'PRINTING',
        receiptNumber: ' gp-000123 ',
      }).input,
    ).toEqual({
      description: 'Receipt would not print.',
      category: 'PRINTING',
      receiptNumber: 'GP-000123',
    });

    const invalid = validateSupportReportDraft({
      description: 'Receipt would not print.',
      category: 'PRINTING',
      receiptNumber: '..\\private\\sale.json',
    });
    expect(invalid.input).toBeNull();
    expect(invalid.errors.receiptNumber).toContain('GP-000123');
  });

  it('creates a report once and publishes only its validated opaque ID', async () => {
    const input: CreateProblemReportInput = {
      description: 'Receipt would not print.',
      category: 'PRINTING',
      receiptNumber: 'GP-000123',
    };
    const invoke = vi.fn(async () => ({ ok: true as const, data: report() }));
    const running: boolean[] = [];
    const created: string[] = [];
    const errors: Array<string | null> = [];
    const action = createSupportReportAction(invoke, {
      onRunningChange: (value) => running.push(value),
      onCreated: (value) => created.push(value),
      onError: (value) => errors.push(value),
    });

    await expect(action.run(input)).resolves.toBe(REPORT_ID);
    expect(invoke).toHaveBeenCalledWith(input);
    expect(created).toEqual([REPORT_ID]);
    expect(running).toEqual([true, false]);
    expect(errors).toEqual([null]);

    const html = view({ createdReportId: created[0]! });
    expect(html).toContain('Support report created locally');
    expect(html).toContain(REPORT_ID);
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('secret.json');
  });

  it('does not render an untrusted report identifier as confirmation', () => {
    const html = view({ createdReportId: RAW_SENSITIVE_DETAIL });
    expect(html).not.toContain('Support report created locally');
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('token=secret');
  });

  it('blocks a duplicate submission while report creation is pending', async () => {
    let resolve!: (value: { readonly ok: true; readonly data: ProblemReport }) => void;
    const pending = new Promise<{ readonly ok: true; readonly data: ProblemReport }>((done) => {
      resolve = done;
    });
    const invoke = vi.fn(() => pending);
    const action = createSupportReportAction(invoke, {
      onRunningChange: () => undefined,
      onCreated: () => undefined,
      onError: () => undefined,
    });
    const input: CreateProblemReportInput = {
      description: 'Checkout stopped.',
      category: 'CHECKOUT',
      receiptNumber: null,
    };

    const first = action.run(input);
    await expect(action.run(input)).resolves.toBeNull();
    expect(action.isRunning()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ ok: true, data: report() });
    await expect(first).resolves.toBe(REPORT_ID);
    expect(action.isRunning()).toBe(false);

    const html = view({ creating: true });
    expect(html).toContain('Creating report...');
    expect(html).toContain('disabled=""');
  });

  it.each([
    [
      'a rejected IPC result',
      async () => ({
        ok: false as const,
        error: { code: 'INTERNAL' as const, message: RAW_SENSITIVE_DETAIL },
      }),
    ],
    ['a thrown exception', async () => Promise.reject(new Error(RAW_SENSITIVE_DETAIL))],
    [
      'an unsafe returned ID',
      async () => ({ ok: true as const, data: report(RAW_SENSITIVE_DETAIL) }),
    ],
  ])('shows a fixed safe failure for %s', async (_case, invoke) => {
    const errors: Array<string | null> = [];
    const action = createSupportReportAction(invoke, {
      onRunningChange: () => undefined,
      onCreated: () => undefined,
      onError: (value) => errors.push(value),
    });

    await expect(
      action.run({ description: 'Problem.', category: 'OTHER', receiptNumber: null }),
    ).resolves.toBeNull();
    expect(errors.at(-1)).toBe(SUPPORT_REPORT_ERROR_MESSAGE);
    const html = view({ reportError: errors.at(-1) ?? null });
    expect(html).toContain('support report could not be created');
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('secret.json');
    expect(html).not.toContain('token=secret');
    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('281-555-0100');
  });
});

describe('Export Support Bundle', () => {
  it('renders the general export action and concise privacy wording', () => {
    const html = view();
    expect(html).toContain('Export Support Bundle');
    expect(html).toContain('sanitized support bundle');
    expect(html).toContain('payment card data');
    expect(html).toContain('saved credentials');
    expect(html).not.toContain('recent-app.log');
    expect(html).not.toContain('diagnostics.json');
  });

  it('exports without a report using only the D1 null report selector', async () => {
    const completed: ExportSupportBundleResult = {
      status: 'COMPLETED',
      fileName: 'GoPhonesPOS-Support.zip',
      supportReportId: null,
      createdAt: '2026-09-12T10:00:00.000Z',
      sizeBytes: 2048,
    };
    const invoke = vi.fn(async () => ({ ok: true as const, data: completed }));
    const notices: Array<string | null> = [];
    const action = createExportSupportBundleAction(invoke, {
      onRunningChange: () => undefined,
      onNotice: (value) => notices.push(value),
      onError: () => undefined,
    });

    await expect(action.run()).resolves.toBe(completed);
    expect(invoke).toHaveBeenCalledWith({ supportReportId: null });
    expect(notices.at(-1)).toBe('Support bundle exported successfully.');
  });

  it('uses a newly created safe report ID in the next export', async () => {
    let createdReportId: string | null = null;
    const create = createSupportReportAction(async () => ({ ok: true, data: report() }), {
      onRunningChange: () => undefined,
      onCreated: (value) => {
        createdReportId = value;
      },
      onError: () => undefined,
    });
    await create.run({ description: 'Problem.', category: 'OTHER', receiptNumber: null });

    const exportInvoke = vi.fn(async () => ({
      ok: true as const,
      data: { status: 'CANCELLED' as const },
    }));
    const exportAction = createExportSupportBundleAction(exportInvoke, {
      onRunningChange: () => undefined,
      onNotice: () => undefined,
      onError: () => undefined,
    });
    await exportAction.run(createdReportId);
    expect(exportInvoke).toHaveBeenCalledWith({ supportReportId: REPORT_ID });
  });

  it('treats native Save cancellation as a neutral completed interaction', async () => {
    const notices: Array<string | null> = [];
    const errors: Array<string | null> = [];
    const action = createExportSupportBundleAction(
      async () => ({ ok: true, data: { status: 'CANCELLED' } }),
      {
        onRunningChange: () => undefined,
        onNotice: (value) => notices.push(value),
        onError: (value) => errors.push(value),
      },
    );

    await expect(action.run()).resolves.toEqual({ status: 'CANCELLED' });
    expect(notices.at(-1)).toBe('Export cancelled. No support bundle was saved.');
    expect(errors).toEqual([null]);
    const html = view({ exportNotice: notices.at(-1) ?? null });
    expect(html).toContain('Export cancelled');
    expect(html).not.toContain('role="alert"');
  });

  it('shows export progress and a safe success confirmation without paths', () => {
    const busy = view({ exporting: true });
    expect(busy).toContain('Exporting support bundle...');
    expect(busy).toContain('disabled=""');

    const done = view({ exportNotice: 'Support bundle exported successfully.' });
    expect(done).toContain('Support bundle exported successfully');
    expect(done).not.toContain('GoPhonesPOS-Support.zip');
    expect(done).not.toContain('AppData');
  });

  it.each([
    [
      'a rejected IPC result',
      async () => ({
        ok: false as const,
        error: { code: 'INTERNAL' as const, message: RAW_SENSITIVE_DETAIL },
      }),
    ],
    ['a thrown exception', async () => Promise.reject(new Error(RAW_SENSITIVE_DETAIL))],
  ])('shows a fixed safe export failure for %s', async (_case, invoke) => {
    const errors: Array<string | null> = [];
    const action = createExportSupportBundleAction(invoke, {
      onRunningChange: () => undefined,
      onNotice: () => undefined,
      onError: (value) => errors.push(value),
    });
    await expect(action.run()).resolves.toBeNull();
    expect(errors.at(-1)).toBe(SUPPORT_EXPORT_ERROR_MESSAGE);
    const html = view({ exportError: errors.at(-1) ?? null });
    expect(html).toContain('support bundle could not be exported');
    expect(html).not.toContain('AppData');
    expect(html).not.toContain('secret.json');
    expect(html).not.toContain('token=secret');
    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('281-555-0100');
  });

  it('rejects arbitrary renderer source/path values without invoking export', async () => {
    const invoke = vi.fn();
    const errors: Array<string | null> = [];
    const action = createExportSupportBundleAction(invoke, {
      onRunningChange: () => undefined,
      onNotice: () => undefined,
      onError: (value) => errors.push(value),
    });

    await expect(
      action.run({ sourceFiles: ['C:\\private\\database.sqlite'] } as unknown as string),
    ).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(errors.at(-1)).toBe(SUPPORT_EXPORT_ERROR_MESSAGE);
  });
});
