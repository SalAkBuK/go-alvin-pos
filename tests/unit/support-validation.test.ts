import { describe, expect, it } from 'vitest';
import { PROBLEM_DESCRIPTION_MAX_LENGTH } from '../../src/shared/support';
import {
  validateCreateProblemReportInput,
  validateExportSupportBundleInput,
  validateSupportReportId,
} from '../../src/main/support/supportValidation';

describe('support request validation', () => {
  it('captures approved fields and normalizes an optional receipt number', () => {
    expect(
      validateCreateProblemReportInput({
        description: '  Receipt would not print.  ',
        category: 'PRINTING',
        receiptNumber: ' gp-000123 ',
      }),
    ).toEqual({
      description: 'Receipt would not print.',
      category: 'PRINTING',
      receiptNumber: 'GP-000123',
    });
  });

  it('enforces description, category, receipt, and exact payload bounds', () => {
    expect(() => validateCreateProblemReportInput({ description: '', category: 'OTHER' })).toThrow(
      /description/i,
    );
    expect(() =>
      validateCreateProblemReportInput({
        description: 'x'.repeat(PROBLEM_DESCRIPTION_MAX_LENGTH + 1),
        category: 'OTHER',
      }),
    ).toThrow(/characters or fewer/i);
    expect(() =>
      validateCreateProblemReportInput({ description: 'Issue', category: 'PAYMENT' }),
    ).toThrow(/category/i);
    expect(() =>
      validateCreateProblemReportInput({
        description: 'Issue',
        category: 'CHECKOUT',
        receiptNumber: '../gophones.sqlite',
      }),
    ).toThrow(/receipt number/i);
    expect(() =>
      validateCreateProblemReportInput({
        description: 'Issue',
        category: 'OTHER',
        destinationPath: 'C:\\evil',
      }),
    ).toThrow(/unexpected fields/i);
  });

  it('accepts only opaque report IDs in bundle requests', () => {
    const id = 'SPR-20260912-0123456789ABCDEF';
    expect(validateSupportReportId(id)).toBe(id);
    expect(validateExportSupportBundleInput({ supportReportId: id })).toEqual({
      supportReportId: id,
    });
    expect(validateExportSupportBundleInput(undefined)).toEqual({ supportReportId: null });
    expect(() => validateExportSupportBundleInput({ supportReportId: '../report' })).toThrow();
    expect(() => validateExportSupportBundleInput({ sourceFiles: ['main.log'] })).toThrow();
  });
});
