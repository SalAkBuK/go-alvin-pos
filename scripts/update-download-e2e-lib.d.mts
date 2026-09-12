export const UPDATE_E2E_VERSION_A: '0.1.100';
export const UPDATE_E2E_VERSION_B: '0.1.101';
export const UPDATE_E2E_RUN_PREFIX: string;
export const APP_DATA_DIRECTORY_NAME: 'GoPhonesPOS';

export interface IsolatedProfileLayout {
  readonly scenarioRoot: string;
  readonly localAppData: string;
  readonly roamingAppData: string;
  readonly expectedUserData: string;
}

export interface UpdaterEvidence {
  readonly state: string;
  readonly event: string;
  readonly availableVersion?: string;
  readonly failureCode?: string;
  readonly version?: string;
  readonly databaseReady?: boolean;
}

export interface RequestEvidence {
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly rangeRequested: boolean;
}

export function validateUpdateVersionPair(
  versionA: string,
  versionB: string,
): { versionA: string; versionB: string };
export function loopbackFeedUrl(port: number): string;
export function isolatedProfileLayout(runRoot: string, scenario: string): IsolatedProfileLayout;
export function isolatedLaunchEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  layout: IsolatedProfileLayout,
  feedUrl: string,
): NodeJS.ProcessEnv;
export function stagePackagedFeed(input: {
  buildDir: string;
  feedDir: string;
  version: string;
}): Promise<{
  outputDir: string;
  files: string[];
  artifacts: {
    version: string;
    installerName: string;
    blockmapName: string;
    sha512: string;
    size: number;
    latestPath: string;
    installerPath: string;
  };
}>;
export function createRequestRecorder(limit?: number): {
  record(entry: RequestEvidence): void;
  snapshot(): RequestEvidence[];
  clear(): void;
};
export function readPackagedUpdaterEvidence(logFile: string): Promise<UpdaterEvidence[]>;
export function observedUpdaterStates(evidence: UpdaterEvidence[]): string[];
export function waitForUpdaterState(input: {
  readEvidence: () => Promise<UpdaterEvidence[]>;
  targetState: string;
  rejectStates?: string[];
  timeoutMs: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<UpdaterEvidence[]>;
export function assertReadyEvidence(evidence: UpdaterEvidence[], expectedVersion: string): string[];
export function assertSafeRunRoot(runRoot: string, temporaryRoot?: string): string;
export function cleanupRunRoot(runRoot: string, temporaryRoot?: string): Promise<void>;
