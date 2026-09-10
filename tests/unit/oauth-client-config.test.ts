import { describe, expect, it } from 'vitest';
import {
  loadOAuthClientConfig,
  parseOAuthClientConfig,
  OAUTH_CLIENT_JSON_ENV,
} from '../../src/main/google/oauthClientConfig';

/**
 * Phase 2J.1 — developer OAuth "Desktop app" client configuration
 * (`ARCHITECTURE.md §27.4`). Extracts ONLY `client_id` + `client_secret` from a
 * `installed` shape; a missing/invalid config never crashes startup.
 */

const DESKTOP_JSON = JSON.stringify({
  installed: {
    client_id: 'dev-client-id.apps.googleusercontent.com',
    client_secret: 'DEV-CLIENT-SECRET',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
  },
});

describe('parseOAuthClientConfig', () => {
  it('extracts only client_id + client_secret from an installed (Desktop) shape', () => {
    expect(parseOAuthClientConfig(DESKTOP_JSON)).toEqual({
      clientId: 'dev-client-id.apps.googleusercontent.com',
      clientSecret: 'DEV-CLIENT-SECRET',
    });
  });

  it('rejects a web client, a foreign endpoint, and missing fields', () => {
    expect(() => parseOAuthClientConfig(JSON.stringify({ web: { client_id: 'x' } }))).toThrow(
      /web client/i,
    );
    expect(() =>
      parseOAuthClientConfig(
        JSON.stringify({
          installed: { client_id: 'x', client_secret: 'y', token_uri: 'https://evil.example/t' },
        }),
      ),
    ).toThrow(/token endpoint/i);
    expect(() => parseOAuthClientConfig(JSON.stringify({ installed: { client_id: 'x' } }))).toThrow(
      /client_secret/i,
    );
    expect(() => parseOAuthClientConfig('not json')).toThrow();
  });
});

describe('loadOAuthClientConfig', () => {
  it('returns null (no throw) when nothing is configured', () => {
    expect(loadOAuthClientConfig({ env: {}, embedded: null })).toBeNull();
  });

  it('prefers a build-embedded value over the env file', () => {
    expect(
      loadOAuthClientConfig({
        env: { [OAUTH_CLIENT_JSON_ENV]: 'x' },
        readFile: () => DESKTOP_JSON,
        embedded: { clientId: 'embedded-id', clientSecret: 'embedded-secret' },
      }),
    ).toEqual({ clientId: 'embedded-id', clientSecret: 'embedded-secret' });
  });

  it('returns null and warns when the file cannot be read', () => {
    const warnings: string[] = [];
    const result = loadOAuthClientConfig({
      env: { [OAUTH_CLIENT_JSON_ENV]: 'C:/nope/missing.json' },
      readFile: () => {
        throw new Error('ENOENT');
      },
      onWarn: (m) => warnings.push(m),
      embedded: null,
    });
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not be read/i);
  });

  it('returns null and warns (no secret in the message) when the JSON is invalid', () => {
    const warnings: string[] = [];
    const result = loadOAuthClientConfig({
      env: { [OAUTH_CLIENT_JSON_ENV]: 'x' },
      readFile: () => JSON.stringify({ web: { client_id: 'DEV-CLIENT-SECRET' } }),
      onWarn: (m) => warnings.push(m),
      embedded: null,
    });
    expect(result).toBeNull();
    expect(warnings[0]).not.toContain('DEV-CLIENT-SECRET');
  });

  it('loads a valid external Desktop-client JSON', () => {
    const result = loadOAuthClientConfig({
      env: { [OAUTH_CLIENT_JSON_ENV]: 'x' },
      readFile: () => DESKTOP_JSON,
      embedded: null,
    });
    expect(result).toEqual({
      clientId: 'dev-client-id.apps.googleusercontent.com',
      clientSecret: 'DEV-CLIENT-SECRET',
    });
  });
});
