import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';

export const RELEASE_VERSION_ENV = 'GO_PHONES_RELEASE_VERSION';
export const RELEASE_TAG_ENV = 'GO_PHONES_RELEASE_TAG';
export const SOURCE_REVISION_ENV = 'GO_PHONES_BUILD_SOURCE_REVISION';
export const BUILD_TIMESTAMP_ENV = 'GO_PHONES_BUILD_TIMESTAMP';
export const UPDATE_FEED_URL_ENV = 'GO_PHONES_UPDATE_FEED_URL';
export const WINDOWS_PUBLISHER_ENV = 'GO_PHONES_WINDOWS_PUBLISHER_NAME';
export const SIGNING_CERTIFICATE_ENV = 'CSC_LINK';
export const SIGNING_PASSWORD_ENV = 'CSC_KEY_PASSWORD';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_REVISION = /^[0-9a-f]{7,40}$/i;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

export function validateVersion(raw, { production = false } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const match = SEMVER.exec(value);
  if (!match)
    throw new Error('Release version must be valid semantic versioning (MAJOR.MINOR.PATCH).');
  if (production && value !== `${match[1]}.${match[2]}.${match[3]}`) {
    throw new Error('Production release version must be exactly stable MAJOR.MINOR.PATCH.');
  }
  return value;
}

export function validatePackageReleaseVersion(packageVersion, releaseVersion) {
  const packageValue = validateVersion(packageVersion);
  const releaseValue = validateVersion(releaseVersion, { production: true });
  const packageIsDevelopment = packageValue.includes('-');
  if (!packageIsDevelopment && packageValue !== releaseValue) {
    throw new Error('Stable package version does not match the requested production release.');
  }
  return releaseValue;
}

export function validateTagVersion(tag, version) {
  const expected = `v${validateVersion(version, { production: true })}`;
  if (tag !== expected) throw new Error(`Release tag must exactly match ${expected}.`);
  return tag;
}

export function validateSourceRevision(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!SOURCE_REVISION.test(value)) {
    throw new Error('Source revision must be a 7-40 character hexadecimal Git commit SHA.');
  }
  return value.toLowerCase();
}

export function validateBuildTimestamp(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error('Build timestamp must be a valid ISO-compatible timestamp.');
  }
  return new Date(value).toISOString();
}

/** Keep this deliberately identical to the runtime updateFeedConfig contract. */
export function validateProductionFeedUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error(`${UPDATE_FEED_URL_ENV} is required for a production release.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${UPDATE_FEED_URL_ENV} must be a valid URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${UPDATE_FEED_URL_ENV} must use HTTPS.`);
  if (parsed.username || parsed.password) {
    throw new Error(`${UPDATE_FEED_URL_ENV} must not contain embedded credentials.`);
  }
  if (parsed.hostname.endsWith('.invalid') || parsed.hostname.includes('.invalid.')) {
    throw new Error(`${UPDATE_FEED_URL_ENV} must not use the local packaging fallback host.`);
  }
  return value;
}

/** Returns no credential values, so callers cannot accidentally serialize signing secrets. */
export function validateSigningEnvironment(env = process.env) {
  if (!env[SIGNING_CERTIFICATE_ENV]?.trim()) {
    throw new Error(`${SIGNING_CERTIFICATE_ENV} is required for a production release.`);
  }
  if (!env[SIGNING_PASSWORD_ENV]?.trim()) {
    throw new Error(`${SIGNING_PASSWORD_ENV} is required for a production release.`);
  }
  const publisherName = env[WINDOWS_PUBLISHER_ENV]?.trim();
  if (!publisherName) {
    throw new Error(`${WINDOWS_PUBLISHER_ENV} is required for publisher verification.`);
  }
  if (/[\r\n]/.test(publisherName) || publisherName.length > 200) {
    throw new Error(`${WINDOWS_PUBLISHER_ENV} is invalid.`);
  }
  return { configured: true, publisherName };
}

export function expectedInstallerName(version) {
  return `Go Phones POS Setup ${validateVersion(version)}.exe`;
}

function plainFileName(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || basename(value) !== value) {
    throw new Error(`${label} must be a plain file name.`);
  }
  return value;
}

function validSha512(value) {
  if (typeof value !== 'string' || !SHA512_BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').length === 64;
}

export function inspectLatestMetadata(text, expectedVersion) {
  const version = validateVersion(expectedVersion);
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('latest.yml must contain an object.');
  }
  if (parsed.version !== version)
    throw new Error('latest.yml version does not match the application version.');
  if (!Array.isArray(parsed.files) || parsed.files.length !== 1) {
    throw new Error('latest.yml must describe exactly one Windows installer.');
  }
  const file = parsed.files[0];
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error('latest.yml files entry is invalid.');
  }
  const installerName = plainFileName(file.url, 'latest.yml installer URL');
  if (installerName !== expectedInstallerName(version) || parsed.path !== installerName) {
    throw new Error(
      'latest.yml installer name/path does not match the expected application version.',
    );
  }
  if (!validSha512(file.sha512) || !validSha512(parsed.sha512) || file.sha512 !== parsed.sha512) {
    throw new Error('latest.yml SHA-512 metadata is invalid or inconsistent.');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('latest.yml installer size is invalid.');
  }
  return {
    version,
    installerName,
    blockmapName: `${installerName}.blockmap`,
    sha512: file.sha512,
    size: file.size,
  };
}

async function regularFile(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
  return info;
}

async function sha512Base64(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('base64');
}

export async function inspectBuildArtifacts(buildDir, expectedVersion) {
  const latestPath = join(buildDir, 'latest.yml');
  await regularFile(latestPath, 'latest.yml');
  const metadata = inspectLatestMetadata(await readFile(latestPath, 'utf8'), expectedVersion);
  const installerPath = join(buildDir, metadata.installerName);
  const installer = await regularFile(installerPath, 'installer');
  if (installer.size !== metadata.size)
    throw new Error('Installer size does not match latest.yml.');
  if ((await sha512Base64(installerPath)) !== metadata.sha512) {
    throw new Error('Installer SHA-512 does not match latest.yml.');
  }
  const blockmap = await regularFile(join(buildDir, metadata.blockmapName), 'installer blockmap');
  if (blockmap.size <= 0) throw new Error('Installer blockmap is empty.');
  return { ...metadata, latestPath, installerPath };
}

export async function stagePublicationBundle({ buildDir, outputDir, expectedVersion }) {
  const artifacts = await inspectBuildArtifacts(buildDir, expectedVersion);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const names = ['latest.yml', artifacts.installerName, artifacts.blockmapName];
  for (const name of names) await copyFile(join(buildDir, name), join(outputDir, name));
  return { outputDir, files: names, artifacts };
}

export async function verifyPublicationBundle(directory, expectedVersion) {
  const artifacts = await inspectBuildArtifacts(directory, expectedVersion);
  const expected = ['latest.yml', artifacts.installerName, artifacts.blockmapName].sort();
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Publication bundle contains missing, stale, or non-allowlisted files.');
  }
  const forbidden = actual.filter((name) =>
    /(?:\.pfx|\.p12|\.pem|\.key|\.env|\.sqlite(?:-(?:wal|shm))?|\.db|\.log|credential|secret)/i.test(
      name,
    ),
  );
  if (forbidden.length)
    throw new Error('Publication bundle contains a forbidden sensitive artifact.');
  return { files: actual, artifacts };
}

export function assertPathInside(parent, candidate, label) {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must be a child of the repository directory.`);
  }
  return candidatePath;
}

export function signatureResultGatesProduction(result, expectedPublisher) {
  if (!result || result.status !== 'Valid')
    throw new Error('Windows Authenticode signature is absent or invalid.');
  if (result.publisherName !== expectedPublisher) {
    throw new Error('Windows Authenticode publisher does not match the configured publisher.');
  }
  return true;
}

export async function readPackageVersion(repoRoot) {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  return validateVersion(pkg.version);
}

export function releaseFeedDirectory(repoRoot, version) {
  return join(repoRoot, 'release-feed', validateVersion(version));
}

export function scriptDirectory(metaUrl) {
  return dirname(new URL(metaUrl).pathname);
}
