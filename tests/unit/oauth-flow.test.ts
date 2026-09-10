import { describe, expect, it, vi } from 'vitest';
import { runOAuthFlow } from '../../src/main/google/oauthFlow';
import { fakeLoopbackListener, fakeOAuthClient } from '../helpers/google';

/**
 * Phase 2J.1 — desktop OAuth flow mechanics (`ARCHITECTURE.md §27.1`-`§27.2`;
 * `TEST-GSHEET-026`, `-027`, `-028`, `-030`, `-031`). Fake OAuth client + fake
 * loopback listener — no browser, no network.
 */

function start(opts: {
  oauthClient?: ReturnType<typeof fakeOAuthClient>;
  listener?: ReturnType<typeof fakeLoopbackListener>;
  openExternal?: (url: string) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const oauthClient = opts.oauthClient ?? fakeOAuthClient();
  const controller = opts.listener ?? fakeLoopbackListener();
  const openedUrls: string[] = [];
  const promise = runOAuthFlow({
    oauthClient,
    openExternal:
      opts.openExternal ??
      ((url: string) => {
        openedUrls.push(url);
        return Promise.resolve();
      }),
    startListener: () => Promise.resolve(controller.listener),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { oauthClient, controller, openedUrls, promise };
}

async function waitForAuthUrl(oauthClient: ReturnType<typeof fakeOAuthClient>): Promise<string> {
  await vi.waitFor(() => expect(oauthClient.calls.authUrls.length).toBe(1));
  return oauthClient.calls.authUrls[0]!;
}

describe('runOAuthFlow — success (TEST-GSHEET-026, -027, -030)', () => {
  it('opens a PKCE S256 auth URL in the browser, verifies state, exchanges, closes the listener', async () => {
    const { oauthClient, controller, openedUrls, promise } = start({});
    const authUrl = await waitForAuthUrl(oauthClient);

    expect(openedUrls).toEqual([authUrl]);
    expect(authUrl).toContain('code_challenge=');
    expect(authUrl).toContain('code_challenge_method=S256');
    expect(authUrl).toContain('access_type=offline');
    expect(decodeURIComponent(authUrl)).toContain('https://www.googleapis.com/auth/drive.file');
    expect(decodeURIComponent(authUrl)).toContain('openid');
    expect(decodeURIComponent(authUrl)).toContain('email');
    expect(authUrl).not.toContain('auth/drive&');
    expect(authUrl).not.toContain('auth/spreadsheets');
    expect(authUrl).not.toContain('profile');
    expect(oauthClient.calls.pkce).toBe(1);

    controller.deliver({ code: 'auth-code-1', state: oauthClient.lastState! });
    const result = await promise;

    expect(result).toEqual({
      refreshToken: '1//fake-refresh-token',
      sub: '1234567890-google-subject',
      email: 'owner@example.com',
    });
    expect(oauthClient.calls.exchanges[0]).toMatchObject({
      code: 'auth-code-1',
      codeVerifier: oauthClient.lastPkce!.verifier,
      redirectUri: controller.listener.redirectUri,
    });
    expect(controller.respondedWith).toEqual(['success']);
    expect(controller.closed).toBe(true);
  });

  it('a fresh verifier + state per attempt', async () => {
    const first = start({});
    await waitForAuthUrl(first.oauthClient);
    first.controller.deliver({ code: 'c', state: first.oauthClient.lastState! });
    await first.promise;

    const second = start({ oauthClient: first.oauthClient });
    await vi.waitFor(() => expect(first.oauthClient.calls.authUrls.length).toBe(2));
    expect(first.oauthClient.calls.pkce).toBe(2);
    expect(first.oauthClient.lastPkce!.verifier).toBe('verifier-2');
    second.controller.deliver({ code: 'c', state: first.oauthClient.lastState! });
    await second.promise;
  });
});

describe('runOAuthFlow — failures close the listener (TEST-GSHEET-028, -031)', () => {
  it('state mismatch is rejected before the code is exchanged', async () => {
    const { oauthClient, controller, promise } = start({});
    await waitForAuthUrl(oauthClient);
    controller.deliver({ code: 'c', state: 'not-the-state' });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(oauthClient.calls.exchanges).toHaveLength(0);
    expect(controller.respondedWith).toEqual(['failure']);
    expect(controller.closed).toBe(true);
  });

  it('access denied is a Google-configuration failure', async () => {
    const { oauthClient, controller, promise } = start({});
    await waitForAuthUrl(oauthClient);
    controller.deliver({ error: 'access_denied', state: oauthClient.lastState! });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.respondedWith).toEqual(['failure']);
    expect(controller.closed).toBe(true);
  });

  it('a missing authorization code is rejected', async () => {
    const { oauthClient, controller, promise } = start({});
    await waitForAuthUrl(oauthClient);
    controller.deliver({ state: oauthClient.lastState! });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.closed).toBe(true);
  });

  it('token exchange failure closes the listener', async () => {
    const oauthClient = fakeOAuthClient({
      exchange: () => {
        throw new Error('invalid_grant');
      },
    });
    const { controller, promise } = start({ oauthClient });
    await waitForAuthUrl(oauthClient);
    controller.deliver({ code: 'c', state: oauthClient.lastState! });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.respondedWith).toEqual(['failure']);
    expect(controller.closed).toBe(true);
  });

  it('no refresh token (no offline access) is rejected', async () => {
    const oauthClient = fakeOAuthClient({ exchange: { refreshToken: null } });
    const { controller, promise } = start({ oauthClient });
    await waitForAuthUrl(oauthClient);
    controller.deliver({ code: 'c', state: oauthClient.lastState! });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.closed).toBe(true);
  });

  it('timeout rejects and closes the listener', async () => {
    const { controller, promise } = start({ timeoutMs: 5 });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.respondedWith).toEqual(['failure']);
    expect(controller.closed).toBe(true);
  });

  it('an abort signal cancels and closes the listener', async () => {
    const abort = new AbortController();
    const { oauthClient, controller, promise } = start({ signal: abort.signal });
    await waitForAuthUrl(oauthClient);
    abort.abort();
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
    expect(controller.closed).toBe(true);
  });

  it('a listener that cannot start is a Google-configuration failure', async () => {
    const promise = runOAuthFlow({
      oauthClient: fakeOAuthClient(),
      openExternal: () => Promise.resolve(),
      startListener: () => Promise.reject(new Error('EADDRINUSE')),
    });
    await expect(promise).rejects.toMatchObject({ code: 'GOOGLE_AUTHORIZATION_FAILED' });
  });
});
