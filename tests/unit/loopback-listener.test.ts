import { describe, expect, it } from 'vitest';
import { startLoopbackListener, OAUTH_REDIRECT_PATH } from '../../src/main/google/loopbackListener';

/**
 * Phase 2J.1 — the real OAuth callback listener (`ARCHITECTURE.md §27.1`;
 * `TEST-GSHEET-029`, `-030`). Binds ONLY to `127.0.0.1` on an ephemeral port and
 * shuts down after use. The browser only ever sees a minimal local HTML page.
 */

describe('startLoopbackListener', () => {
  it('binds 127.0.0.1 on an ephemeral port and returns a matching redirect URI', async () => {
    const listener = await startLoopbackListener();
    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUri).toBe(
        `http://127.0.0.1:${String(listener.port)}${OAUTH_REDIRECT_PATH}`,
      );
    } finally {
      listener.close();
    }
  });

  it('resolves the callback with the query params and returns a body free of secrets', async () => {
    const listener = await startLoopbackListener();
    try {
      const resPromise = fetch(
        `${listener.redirectUri}?code=SECRET-AUTH-CODE&state=abc123&scope=x`,
      );
      const query = await listener.callback;
      expect(query).toEqual({ code: 'SECRET-AUTH-CODE', state: 'abc123', scope: 'x' });

      listener.respond('success');
      const body = await (await resPromise).text();
      expect(body).toContain('Google account connected');
      expect(body).not.toContain('SECRET-AUTH-CODE');
      expect(body).not.toContain('abc123');
    } finally {
      listener.close();
    }
  });

  it('a non-callback path gets a plain 404 and does not resolve the callback', async () => {
    const listener = await startLoopbackListener();
    try {
      const res = await fetch(`http://127.0.0.1:${String(listener.port)}/favicon.ico`);
      expect(res.status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it('close() stops the server — a later request fails to connect', async () => {
    const listener = await startLoopbackListener();
    const port = listener.port;
    listener.close();
    await new Promise((r) => setTimeout(r, 20));
    await expect(fetch(`http://127.0.0.1:${String(port)}${OAUTH_REDIRECT_PATH}`)).rejects.toThrow();
  });
});
