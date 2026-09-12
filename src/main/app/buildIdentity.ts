export interface BuildIdentity {
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly sourceRevision: string | null;
  readonly buildTimestamp: string | null;
  readonly buildIdentifier: string | null;
}

interface EmbeddedBuildIdentity {
  readonly version?: unknown;
  readonly schemaVersion?: unknown;
  readonly sourceRevision?: unknown;
  readonly buildTimestamp?: unknown;
}

const SOURCE_REVISION = /^[0-9a-f]{7,40}$/i;

/**
 * Converts compile-time metadata into the only safe identity shape exposed at runtime.
 * Invalid/mismatched metadata is discarded rather than reported as trustworthy.
 */
export function parseBuildIdentity(
  embeddedJson: string,
  runtimeVersion: string,
  runtimeSchemaVersion: number,
): BuildIdentity {
  let embedded: EmbeddedBuildIdentity = {};
  try {
    const parsed: unknown = JSON.parse(embeddedJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      embedded = parsed as EmbeddedBuildIdentity;
    }
  } catch {
    // Development builds intentionally have no trusted source identity.
  }

  const versionMatches = embedded.version === runtimeVersion;
  const schemaMatches = embedded.schemaVersion === runtimeSchemaVersion;
  const sourceRevision =
    versionMatches &&
    schemaMatches &&
    typeof embedded.sourceRevision === 'string' &&
    SOURCE_REVISION.test(embedded.sourceRevision)
      ? embedded.sourceRevision.toLowerCase()
      : null;
  const buildTimestamp =
    versionMatches &&
    schemaMatches &&
    typeof embedded.buildTimestamp === 'string' &&
    Number.isFinite(Date.parse(embedded.buildTimestamp))
      ? new Date(embedded.buildTimestamp).toISOString()
      : null;

  return {
    appVersion: runtimeVersion,
    schemaVersion: runtimeSchemaVersion,
    sourceRevision,
    buildTimestamp,
    buildIdentifier: sourceRevision
      ? `${runtimeVersion}+${sourceRevision.slice(0, 12)}.schema${runtimeSchemaVersion}`
      : null,
  };
}

declare const __GO_PHONES_BUILD_IDENTITY__: string | undefined;

/** Uses bundled constants only; the installed application never invokes Git. */
export function loadBuildIdentity(runtimeVersion: string, schemaVersion: number): BuildIdentity {
  const embedded =
    typeof __GO_PHONES_BUILD_IDENTITY__ === 'string' ? __GO_PHONES_BUILD_IDENTITY__ : '{}';
  return parseBuildIdentity(embedded, runtimeVersion, schemaVersion);
}
