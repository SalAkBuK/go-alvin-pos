export const UPDATE_INSTALL_E2E_RUN_PREFIX: string;
export const UPDATE_INSTALL_E2E_PROFILE_LEAF: string;
export const UPDATE_INSTALL_E2E_APP_ID: string;
export const UPDATE_INSTALL_E2E_PRODUCT_NAME: string;
export const UPDATE_INSTALL_E2E_PACKAGE_NAME: string;
export const PRODUCTION_APP_ID: string;
export const PRODUCTION_PRODUCT_NAME: string;
export const PRODUCTION_PACKAGE_NAME: string;
export const UPDATE_INSTALL_E2E_TRIGGER_FILE: string;
export const UPDATE_INSTALL_E2E_BUILD_ENV: string;
export const UPDATE_INSTALL_E2E_PROFILE_ENV: string;
export const UPDATE_INSTALL_E2E_RUNTIME_ENV: string;
export const RECEIPT_PREFIX: string;
export const RECEIPT_DIGITS: number;

export function formatReceiptNumber(value: number): string;
export function createRunRoot(): Promise<string>;
export function guardedProfilePath(runRoot: string): string;
export function guardedLocalAppData(runRoot: string): string;
export function isGuardedProfilePath(runRoot: string, candidate: string): boolean;
export function installedAppLaunchEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  runRoot: string,
  feedUrl: string,
): NodeJS.ProcessEnv;
export function buildE2eEnvironment(baseEnv: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv;
export function assertSafeRunRoot(runRoot: string, temporaryRoot?: string): string;
export function cleanupRunRoot(runRoot: string, temporaryRoot?: string): Promise<void>;
export function assertSafeInstallRoot(installRoot: string, localAppData: string): string;

export interface FixtureSeedResult {
  readonly receiptNumber: string;
  readonly receiptValue: number;
  readonly auditValue: number;
}
export function seedFixture(
  dbFile: string,
  options?: { appVersion?: string; now?: () => string },
): FixtureSeedResult;

export interface BusinessEvidence {
  readonly schemaVersion: number | null;
  readonly product: Record<string, unknown> | undefined;
  readonly customer: Record<string, unknown> | undefined;
  readonly sale: Record<string, unknown> | undefined;
  readonly saleItem: Record<string, unknown> | undefined;
  readonly payment: Record<string, unknown> | undefined;
  readonly movement: Record<string, unknown> | undefined;
  readonly auditEvent: Record<string, unknown> | undefined;
  readonly exportJob: { readonly status: string; readonly id: string } & Record<string, unknown>;
  readonly checkoutRequest: Record<string, unknown> | undefined;
  readonly setting: string | null;
  readonly businessTimezone: string | null;
  readonly receiptCounterValue: number;
  readonly auditCounterValue: number;
  readonly counts: {
    readonly products: number;
    readonly customers: number;
    readonly sales: number;
    readonly saleItems: number;
    readonly payments: number;
    readonly inventoryMovements: number;
    readonly auditEvents: number;
    readonly exportJobs: number;
    readonly checkoutRequests: number;
  };
  readonly integrityOk: boolean;
  readonly foreignKeysOk: boolean;
}
export function captureBusinessEvidence(dbFile: string): BusinessEvidence;
export function compareBusinessEvidence(
  before: BusinessEvidence,
  after: BusinessEvidence,
): string[];
export function allocateNextReceiptForContinuityCheck(dbFile: string): {
  readonly value: number;
  readonly receiptNumber: string;
};

export interface LogRecord {
  readonly event?: string;
  readonly context?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}
export function readAllLogRecords(logFile: string): Promise<LogRecord[]>;
export function readPackagedUpdaterEvidence(logFile: string): Promise<unknown[]>;
export function findEvent(records: LogRecord[], eventName: string): LogRecord[];
export function lastApplicationStart(records: LogRecord[]): LogRecord | null;
