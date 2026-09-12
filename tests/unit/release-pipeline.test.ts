import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectedInstallerName,
  inspectBuildArtifacts,
  inspectLatestMetadata,
  signatureResultGatesProduction,
  stagePublicationBundle,
  validateProductionFeedUrl,
  validatePackageReleaseVersion,
  validateSigningEnvironment,
  validateSourceRevision,
  validateTagVersion,
  validateVersion,
  verifyPublicationBundle,
} from '../../scripts/release-lib.mjs';

const roots: string[] = [];
const INSTALLER_CONTENT = 'installer';
const SHA512 = createHash('sha512').update(INSTALLER_CONTENT).digest('base64');

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gpp-release-test-'));
  roots.push(root);
  return root;
}

function writeCandidate(root: string, version = '1.2.3') {
  const build = join(root, 'release');
  mkdirSync(build, { recursive: true });
  const installer = expectedInstallerName(version);
  writeFileSync(join(build, installer), INSTALLER_CONTENT);
  writeFileSync(join(build, `${installer}.blockmap`), 'blockmap');
  writeFileSync(
    join(build, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${installer}`,
      `    sha512: ${SHA512}`,
      '    size: 9',
      `path: ${installer}`,
      `sha512: ${SHA512}`,
      "releaseDate: '2026-09-12T12:00:00.000Z'",
      '',
    ].join('\n'),
  );
  return { build, installer };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production release identity', () => {
  it('accepts stable semantic versions and keeps development prereleases out of production', () => {
    expect(validateVersion('1.2.3', { production: true })).toBe('1.2.3');
    expect(validateVersion('0.1.0-foundation')).toBe('0.1.0-foundation');
    expect(() => validateVersion('0.1.0-foundation', { production: true })).toThrow(/stable/);
    expect(() => validateVersion('1.2.3+ci.1', { production: true })).toThrow(/exactly stable/);
    expect(() => validateVersion('version-one', { production: true })).toThrow(/semantic/);
  });

  it('allows an explicit first release over a development package but rejects stable package drift', () => {
    expect(validatePackageReleaseVersion('0.1.0-foundation', '1.0.0')).toBe('1.0.0');
    expect(validatePackageReleaseVersion('1.2.3', '1.2.3')).toBe('1.2.3');
    expect(() => validatePackageReleaseVersion('1.2.4', '1.2.3')).toThrow(/does not match/);
  });

  it('requires the immutable vX.Y.Z tag to match the release version', () => {
    expect(validateTagVersion('v1.2.3', '1.2.3')).toBe('v1.2.3');
    expect(() => validateTagVersion('v1.2.4', '1.2.3')).toThrow(/v1\.2\.3/);
  });

  it('accepts only bounded hexadecimal source revisions', () => {
    expect(validateSourceRevision('A'.repeat(40))).toBe('a'.repeat(40));
    expect(() => validateSourceRevision('main')).toThrow(/Git commit SHA/);
    expect(() => validateSourceRevision(`abc1234/C:\\private`)).toThrow(/Git commit SHA/);
  });
});

describe('production feed URL and signing contract', () => {
  it('requires plain HTTPS, rejects credentials, and rejects the local fallback', () => {
    expect(validateProductionFeedUrl('https://updates.example.com/pos/')).toBe(
      'https://updates.example.com/pos/',
    );
    expect(() => validateProductionFeedUrl('')).toThrow(/required/);
    expect(() => validateProductionFeedUrl('http://updates.example.com/')).toThrow(/HTTPS/);
    expect(() => validateProductionFeedUrl('https://user:token@updates.example.com/')).toThrow(
      /credentials/,
    );
    expect(() =>
      validateProductionFeedUrl('https://updates.invalid.example/gophones-pos/'),
    ).toThrow(/fallback/);
  });

  it('fails closed without conventional signing credentials and never returns their values', () => {
    expect(() => validateSigningEnvironment({})).toThrow(/CSC_LINK/);
    expect(() =>
      validateSigningEnvironment({ CSC_LINK: 'secret-certificate', CSC_KEY_PASSWORD: '' }),
    ).toThrow(/CSC_KEY_PASSWORD/);
    const result = validateSigningEnvironment({
      CSC_LINK: 'secret-certificate',
      CSC_KEY_PASSWORD: 'secret-password',
      GO_PHONES_WINDOWS_PUBLISHER_NAME: 'Go Phones LLC',
    });
    expect(result).toEqual({ configured: true, publisherName: 'Go Phones LLC' });
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  it('gates production on a valid signature and exact configured publisher', () => {
    expect(
      signatureResultGatesProduction(
        { status: 'Valid', publisherName: 'Go Phones LLC' },
        'Go Phones LLC',
      ),
    ).toBe(true);
    expect(() =>
      signatureResultGatesProduction({ status: 'NotSigned', publisherName: '' }, 'Go Phones LLC'),
    ).toThrow(/absent or invalid/);
    expect(() =>
      signatureResultGatesProduction(
        { status: 'Valid', publisherName: 'Someone Else' },
        'Go Phones LLC',
      ),
    ).toThrow(/publisher/);
  });
});

describe('electron-updater artifact metadata and allowlisted staging', () => {
  it('validates electron-builder metadata and stages only installer/update files', async () => {
    const root = tempRoot();
    const { build, installer } = writeCandidate(root);
    for (const name of ['source.zip', 'sales.sqlite', 'private.pfx', '.env', 'application.log']) {
      writeFileSync(join(build, name), 'forbidden');
    }
    const output = join(root, 'feed', '1.2.3');
    const staged = await stagePublicationBundle({
      buildDir: build,
      outputDir: output,
      expectedVersion: '1.2.3',
    });
    expect(staged.files.sort()).toEqual(['latest.yml', installer, `${installer}.blockmap`].sort());
    const verified = await verifyPublicationBundle(output, '1.2.3');
    expect(verified.files).not.toContain('sales.sqlite');
    expect(readFileSync(join(output, installer), 'utf8')).toBe('installer');
  });

  it('rejects missing latest.yml and a missing installer', async () => {
    const root = tempRoot();
    await expect(inspectBuildArtifacts(root, '1.2.3')).rejects.toThrow(/latest\.yml.*missing/);
    const { build, installer } = writeCandidate(root);
    rmSync(join(build, installer));
    await expect(inspectBuildArtifacts(build, '1.2.3')).rejects.toThrow(/installer.*missing/);
  });

  it('rejects metadata version mismatch and a missing referenced blockmap', async () => {
    const root = tempRoot();
    const { build, installer } = writeCandidate(root);
    await expect(inspectBuildArtifacts(build, '1.2.4')).rejects.toThrow(/version/);
    rmSync(join(build, `${installer}.blockmap`));
    await expect(inspectBuildArtifacts(build, '1.2.3')).rejects.toThrow(/blockmap.*missing/);
  });

  it('rejects malformed checksum metadata and stale files in an already-staged feed', async () => {
    const root = tempRoot();
    const { build } = writeCandidate(root);
    const latest = readFileSync(join(build, 'latest.yml'), 'utf8');
    expect(() => inspectLatestMetadata(latest.replace(SHA512, 'not-a-checksum'), '1.2.3')).toThrow(
      /SHA-512/,
    );
    const output = join(root, 'feed');
    await stagePublicationBundle({ buildDir: build, outputDir: output, expectedVersion: '1.2.3' });
    writeFileSync(join(output, 'Go Phones POS Setup 1.2.2.exe'), 'stale');
    await expect(verifyPublicationBundle(output, '1.2.3')).rejects.toThrow(/stale/);
  });
});
