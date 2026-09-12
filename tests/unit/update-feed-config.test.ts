import { describe, expect, it, vi } from 'vitest';
import {
  loadUpdateFeedConfig,
  parseUpdateFeedUrl,
  UPDATE_FEED_URL_ENV,
} from '../../src/main/updater/updateFeedConfig';

describe('parseUpdateFeedUrl (Phase 2N-A generic HTTPS feed contract)', () => {
  it('accepts a plain generic HTTPS URL', () => {
    expect(parseUpdateFeedUrl('https://updates.example.com/gophones-pos/')).toBe(
      'https://updates.example.com/gophones-pos/',
    );
  });

  it('rejects an empty value', () => {
    expect(() => parseUpdateFeedUrl('   ')).toThrow(/empty/);
  });

  it('rejects a non-URL string', () => {
    expect(() => parseUpdateFeedUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('rejects a plain HTTP (non-HTTPS) URL', () => {
    expect(() => parseUpdateFeedUrl('http://updates.example.com/')).toThrow(/https/);
  });

  it('rejects a GitHub API URL scheme just as any other — the contract has no vendor special-case', () => {
    // Not a GitHub-specific rejection; it is rejected only if it fails the
    // generic https+no-credentials contract, proving no hosting vendor is
    // hard-coded as required or forbidden.
    expect(parseUpdateFeedUrl('https://api.github.com/repos/acme/pos/releases')).toBe(
      'https://api.github.com/repos/acme/pos/releases',
    );
  });

  it('rejects a URL with embedded credentials (no auth token requirement/leak)', () => {
    expect(() => parseUpdateFeedUrl('https://user:token@updates.example.com/feed')).toThrow(
      /credentials/,
    );
  });
});

describe('loadUpdateFeedConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(loadUpdateFeedConfig({ env: {} })).toBeNull();
  });

  it('loads a valid URL from the environment variable', () => {
    const config = loadUpdateFeedConfig({
      env: { [UPDATE_FEED_URL_ENV]: 'https://updates.example.com/feed/' },
    });
    expect(config).toEqual({ url: 'https://updates.example.com/feed/' });
  });

  it('prefers an injected/embedded value over the environment variable', () => {
    const config = loadUpdateFeedConfig({
      env: { [UPDATE_FEED_URL_ENV]: 'https://env.example.com/feed/' },
      embedded: 'https://embedded.example.com/feed/',
    });
    expect(config).toEqual({ url: 'https://embedded.example.com/feed/' });
  });

  it('warns and returns null for an invalid configured URL, without echoing it back', () => {
    const onWarn = vi.fn();
    const config = loadUpdateFeedConfig({
      env: { [UPDATE_FEED_URL_ENV]: 'http://insecure.example.com/feed/' },
      onWarn,
    });
    expect(config).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).not.toContain('insecure.example.com');
  });
});
