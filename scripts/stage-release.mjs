import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_VERSION_ENV,
  assertPathInside,
  readPackageVersion,
  releaseFeedDirectory,
  stagePublicationBundle,
  validateVersion,
} from './release-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const version = production
  ? validateVersion(process.env[RELEASE_VERSION_ENV], { production: true })
  : validateVersion(process.env[RELEASE_VERSION_ENV] || (await readPackageVersion(repoRoot)));
const buildDir = assertPathInside(repoRoot, join(repoRoot, 'release'), 'Build directory');
const outputDir = assertPathInside(
  repoRoot,
  releaseFeedDirectory(repoRoot, version),
  'Feed directory',
);

const staged = await stagePublicationBundle({ buildDir, outputDir, expectedVersion: version });
console.log(`Staged generic HTTPS feed candidate for ${version}:`);
for (const name of staged.files) console.log(`  ${name}`);
