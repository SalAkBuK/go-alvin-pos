import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_TIMESTAMP_ENV,
  RELEASE_TAG_ENV,
  RELEASE_VERSION_ENV,
  SOURCE_REVISION_ENV,
  validateBuildTimestamp,
  validatePackageReleaseVersion,
  validateProductionFeedUrl,
  validateSigningEnvironment,
  validateSourceRevision,
  validateTagVersion,
  validateVersion,
  readPackageVersion,
} from './release-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function run(command, args, env = process.env) {
  console.log(`\n==> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const version = validateVersion(process.env[RELEASE_VERSION_ENV], { production: true });
validatePackageReleaseVersion(await readPackageVersion(repoRoot), version);
const tag = validateTagVersion(
  process.env[RELEASE_TAG_ENV] || git('describe', '--tags', '--exact-match'),
  version,
);
const head = validateSourceRevision(git('rev-parse', 'HEAD'));
const requestedRevision = validateSourceRevision(process.env[SOURCE_REVISION_ENV] || head);
if (head !== requestedRevision) throw new Error('Requested source revision does not match HEAD.');
if (git('rev-list', '-n', '1', tag).toLowerCase() !== head)
  throw new Error('Release tag does not point to HEAD.');
if (git('status', '--porcelain') !== '')
  throw new Error('Production release requires a clean working tree.');
validateProductionFeedUrl(process.env.GO_PHONES_UPDATE_FEED_URL);
validateSigningEnvironment(process.env);

const buildTimestamp = validateBuildTimestamp(
  process.env[BUILD_TIMESTAMP_ENV] || new Date().toISOString(),
);
const env = {
  ...process.env,
  [RELEASE_VERSION_ENV]: version,
  [RELEASE_TAG_ENV]: tag,
  [SOURCE_REVISION_ENV]: head,
  [BUILD_TIMESTAMP_ENV]: buildTimestamp,
};

for (const script of ['lint', 'typecheck', 'format:check', 'test', 'build']) {
  run('npm.cmd', ['run', script], env);
}
run(
  'node_modules\\.bin\\electron-builder.cmd',
  ['--win', 'nsis', '--publish', 'never', `--config.extraMetadata.version=${version}`],
  env,
);
run(process.execPath, ['scripts/stage-release.mjs', '--production'], env);
run(process.execPath, ['scripts/verify-release.mjs', '--production'], env);

console.log(
  `\nProduction release candidate ${version} (${head}) is verified and staged, but not published.`,
);
