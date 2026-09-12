export interface StagedArtifacts {
  readonly version: string;
  readonly installerName: string;
  readonly blockmapName: string;
  readonly sha512: string;
  readonly size: number;
  readonly latestPath: string;
  readonly installerPath: string;
}

export function validateVersion(raw: unknown, options?: { production?: boolean }): string;
export function validatePackageReleaseVersion(
  packageVersion: string,
  releaseVersion: string,
): string;
export function validateTagVersion(tag: string, version: string): string;
export function validateSourceRevision(raw: unknown): string;
export function validateBuildTimestamp(raw: unknown): string;
export function validateProductionFeedUrl(raw: unknown): string;
export function validateSigningEnvironment(env?: Record<string, string | undefined>): {
  configured: true;
  publisherName: string;
};
export function expectedInstallerName(version: string): string;
export function inspectLatestMetadata(
  text: string,
  expectedVersion: string,
): Omit<StagedArtifacts, 'latestPath' | 'installerPath'>;
export function inspectBuildArtifacts(
  buildDir: string,
  expectedVersion: string,
): Promise<StagedArtifacts>;
export function stagePublicationBundle(input: {
  buildDir: string;
  outputDir: string;
  expectedVersion: string;
}): Promise<{ outputDir: string; files: string[]; artifacts: StagedArtifacts }>;
export function verifyPublicationBundle(
  directory: string,
  expectedVersion: string,
): Promise<{ files: string[]; artifacts: StagedArtifacts }>;
export function signatureResultGatesProduction(
  result: { status: string; publisherName: string } | null,
  expectedPublisher: string,
): true;
