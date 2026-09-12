import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_FEED_URL_ENV } from '../../src/main/updater/updateFeedConfig';

/**
 * Regression test for the Phase 2N-B download-path fix (`electron-builder.js`).
 *
 * Root cause (confirmed by reading `node_modules/electron-updater/out/AppUpdater.js`):
 * `getOrCreateDownloadHelper()` unconditionally reads `resources/app-update.yml`
 * for `updaterCacheDirName`, regardless of the runtime `setFeedURL()` call.
 * electron-builder only generates that file for an auto-updatable installer
 * target (`nsis` on Windows) — never for `dir`. Without an explicit `publish`
 * block, electron-builder also falls back to auto-detecting GitHub from
 * `package.json`'s `repository` field, which would bake a `provider: github`
 * config into that file.
 *
 * This test proves the STATIC CONFIGURATION itself (fast, cross-platform, no
 * Windows packaging needed) contains what the real download path requires
 * and nothing unsafe. `scripts/verify-packaging.mjs`'s `app-update.yml`
 * checks additionally prove the GENERATED file matches this configuration on
 * a real Windows build (`npm run dist:win`).
 */

interface ElectronBuilderConfig {
  readonly win?: { readonly target?: string | string[] };
  readonly publish?: Array<Record<string, unknown>>;
}

const require = createRequire(import.meta.url);
const configPath = join(__dirname, '..', '..', 'electron-builder.js');

/** Re-`require()`s the CJS config, bypassing Node's require cache so env-var changes take effect. */
function loadConfig(): ElectronBuilderConfig {
  delete require.cache[require.resolve(configPath)];
  return require(configPath) as ElectronBuilderConfig;
}

function targetsOf(config: ElectronBuilderConfig): string[] {
  const target = config.win?.target;
  if (target === undefined) return [];
  return Array.isArray(target) ? target : [target];
}

describe('electron-builder.js (Phase 2N-B download-path configuration)', () => {
  afterEach(() => {
    delete process.env[UPDATE_FEED_URL_ENV];
  });

  it('includes an auto-updatable installer target (nsis) — required for electron-builder to ever generate app-update.yml', () => {
    expect(targetsOf(loadConfig())).toContain('nsis');
  });

  it('still keeps the dir target so the existing fast `pack:win` dev loop is unaffected', () => {
    expect(targetsOf(loadConfig())).toContain('dir');
  });

  it("explicitly configures the generic provider — overriding electron-builder's GitHub-repository auto-detection", () => {
    const config = loadConfig();
    expect(Array.isArray(config.publish)).toBe(true);
    expect(config.publish).toHaveLength(1);
    const publishConfig = config.publish?.[0];
    expect(publishConfig?.provider).toBe('generic');
    // Never any of these — would mean a GitHub/vendor-specific config leaked in.
    expect(publishConfig).not.toHaveProperty('owner');
    expect(publishConfig).not.toHaveProperty('repo');
    expect(publishConfig).not.toHaveProperty('token');
  });

  it('the configured publish URL is always plain HTTPS with no embedded credentials, with or without the env var set', () => {
    delete process.env[UPDATE_FEED_URL_ENV];
    const unconfiguredUrl = loadConfig().publish?.[0]?.url;
    expect(unconfiguredUrl).toEqual(expect.stringMatching(/^https:\/\//));
    expect(unconfiguredUrl).not.toEqual(expect.stringMatching(/^https:\/\/[^/]*@/));

    process.env[UPDATE_FEED_URL_ENV] = 'https://updates.example.com/gophones-pos/';
    expect(loadConfig().publish?.[0]?.url).toBe('https://updates.example.com/gophones-pos/');
  });

  it('drift guard: the SAME env var name drives both the packaged app-update.yml url and the runtime setFeedURL() config — never two independent sources', () => {
    process.env[UPDATE_FEED_URL_ENV] = 'https://one-canonical-source.example.com/feed/';
    expect(loadConfig().publish?.[0]?.url).toBe('https://one-canonical-source.example.com/feed/');
    expect(UPDATE_FEED_URL_ENV).toBe('GO_PHONES_UPDATE_FEED_URL');
  });
});
