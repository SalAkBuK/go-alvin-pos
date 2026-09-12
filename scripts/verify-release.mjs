import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { extractFile } from '@electron/asar';
import {
  BUILD_TIMESTAMP_ENV,
  RELEASE_VERSION_ENV,
  SOURCE_REVISION_ENV,
  UPDATE_FEED_URL_ENV,
  WINDOWS_PUBLISHER_ENV,
  assertPathInside,
  readPackageVersion,
  releaseFeedDirectory,
  signatureResultGatesProduction,
  validateProductionFeedUrl,
  validateBuildTimestamp,
  validateSourceRevision,
  validateVersion,
  verifyPublicationBundle,
} from './release-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const version = production
  ? validateVersion(process.env[RELEASE_VERSION_ENV], { production: true })
  : validateVersion(process.env[RELEASE_VERSION_ENV] || (await readPackageVersion(repoRoot)));
const sourceRevision = production ? validateSourceRevision(process.env[SOURCE_REVISION_ENV]) : null;
const expectedBuildTimestamp = production
  ? validateBuildTimestamp(process.env[BUILD_TIMESTAMP_ENV])
  : null;
const expectedFeedUrl = production
  ? validateProductionFeedUrl(process.env[UPDATE_FEED_URL_ENV])
  : null;
const releaseDir = assertPathInside(repoRoot, join(repoRoot, 'release'), 'Build directory');
const feedDir = assertPathInside(
  repoRoot,
  releaseFeedDirectory(repoRoot, version),
  'Feed directory',
);

function pass(message) {
  console.log(`  PASS  ${message}`);
}

function runPackagingVerification() {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'verify-packaging.mjs'), '--require-installer'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.status !== 0) throw new Error('Existing Windows packaging verification failed.');
}

function authenticode(path) {
  const escaped = path.replaceAll("'", "''");
  const command = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    `$p = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }`,
    `[PSCustomObject]@{ status = [string]$s.Status; publisherName = $p } | ConvertTo-Json -Compress`,
  ].join('; ');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
    }).trim(),
  );
}

console.log(`verify-release: ${production ? 'production' : 'test'} candidate ${version}`);
runPackagingVerification();
pass('existing native-module and installer packaging checks');

const bundle = await verifyPublicationBundle(feedDir, version);
pass(`publication allowlist is self-consistent (${bundle.files.join(', ')})`);

const appUpdatePath = join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml');
const appUpdate = yaml.load(await readFile(appUpdatePath, 'utf8'));
if (!appUpdate || typeof appUpdate !== 'object' || appUpdate.provider !== 'generic') {
  throw new Error('Packaged app-update.yml is not configured for the generic provider.');
}
if (production && appUpdate.url !== expectedFeedUrl) {
  throw new Error('Packaged app-update.yml URL does not match the production feed URL.');
}
if (production) {
  const expectedPublisher = process.env[WINDOWS_PUBLISHER_ENV];
  const publishers = Array.isArray(appUpdate.publisherName)
    ? appUpdate.publisherName
    : [appUpdate.publisherName];
  if (!expectedPublisher || !publishers.includes(expectedPublisher)) {
    throw new Error('Packaged app-update.yml publisher does not match the production publisher.');
  }
}
pass('packaged app-update.yml uses the expected generic HTTPS feed');

const asarPath = join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
const mainBundle = extractFile(asarPath, join('out', 'main', 'index.js')).toString('utf8');
const packagedPackage = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
if (packagedPackage.version !== version) {
  throw new Error('Packaged application version does not match latest.yml/release version.');
}
const identityStart = mainBundle.indexOf('{"format":"GO_PHONES_BUILD_IDENTITY/v1"');
const identityEnd = identityStart < 0 ? -1 : mainBundle.indexOf("}'", identityStart);
if (identityStart < 0 || identityEnd < 0) {
  throw new Error('Packaged main bundle does not contain build identity support.');
}
const embeddedIdentity = JSON.parse(mainBundle.slice(identityStart, identityEnd + 1));
if (
  embeddedIdentity.version !== version ||
  !Number.isSafeInteger(embeddedIdentity.schemaVersion) ||
  embeddedIdentity.schemaVersion < 1
) {
  throw new Error('Packaged main bundle build version/schema identity is invalid.');
}
if (
  production &&
  (embeddedIdentity.sourceRevision !== sourceRevision ||
    embeddedIdentity.buildTimestamp !== expectedBuildTimestamp)
) {
  throw new Error('Packaged main bundle does not contain the expected version/source identity.');
}
pass('packaged app/package/update versions match and runtime identity requires no Git');

if (production) {
  const publisher = process.env[WINDOWS_PUBLISHER_ENV];
  if (!publisher) throw new Error(`${WINDOWS_PUBLISHER_ENV} is required.`);
  const installerSignature = authenticode(bundle.artifacts.installerPath);
  signatureResultGatesProduction(installerSignature, publisher);
  pass(`installer Authenticode signature is valid for publisher ${publisher}`);
  const appExe = join(releaseDir, 'win-unpacked', 'Go Phones POS.exe');
  signatureResultGatesProduction(authenticode(appExe), publisher);
  pass('packaged application executable Authenticode signature is valid');
} else {
  console.log('  SKIP  production Authenticode gate (test mode; no certificate is claimed)');
}

pass('release candidate verification complete');
