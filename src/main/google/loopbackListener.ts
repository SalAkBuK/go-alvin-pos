import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The temporary OAuth callback listener (`ARCHITECTURE.md §27.1`). Bound ONLY to
 * `127.0.0.1` on an OS-assigned ephemeral port — never `0.0.0.0`, `::`, or any
 * externally reachable interface. It exists for exactly one authorization
 * attempt and is always shut down afterward (`§27.2`).
 *
 * The browser only ever sees a minimal local HTML page — no code, token, email,
 * error body, verifier, or state (`callback response` rules).
 */

const BIND_ADDRESS = '127.0.0.1';
export const OAUTH_REDIRECT_PATH = '/oauth2callback';

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Go Phones POS</title>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem">' +
  '<h1>Google account connected</h1>' +
  '<p>You may close this tab and return to Go Phones POS.</p></body>';

const FAILURE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Go Phones POS</title>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem">' +
  '<h1>Google account could not be connected</h1>' +
  '<p>Return to Go Phones POS for details.</p></body>';

export interface LoopbackListener {
  /** The OS-assigned ephemeral port. */
  readonly port: number;
  /** `http://127.0.0.1:<port>/oauth2callback`. */
  readonly redirectUri: string;
  /**
   * Resolves with the callback query string parameters the first time a request
   * hits the redirect path. Rejects if the server errors. Never resolves on its
   * own — the caller races it against a timeout / abort.
   */
  readonly callback: Promise<Record<string, string>>;
  /** Write the final page the browser sees, then allow {@link close}. */
  respond(kind: 'success' | 'failure'): void;
  /** Stop listening and drop any held connection. Idempotent. */
  close(): void;
}

export type StartLoopbackListener = () => Promise<LoopbackListener>;

export const startLoopbackListener: StartLoopbackListener = () =>
  new Promise<LoopbackListener>((resolveListener, rejectListener) => {
    let heldResponse: ServerResponse | null = null;
    let settled = false;
    let resolveCallback!: (query: Record<string, string>) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<Record<string, string>>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${BIND_ADDRESS}`);
      if (url.pathname !== OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (settled) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);
        return;
      }
      settled = true;
      heldResponse = res;
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        query[key] = value;
      }
      resolveCallback(query);
    });

    server.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        rejectCallback(error);
      }
      rejectListener(error);
    });

    server.listen(0, BIND_ADDRESS, () => {
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') {
        server.close();
        rejectListener(new Error('The loopback listener did not receive a port.'));
        return;
      }
      const port = address.port;
      resolveListener({
        port,
        redirectUri: `http://${BIND_ADDRESS}:${String(port)}${OAUTH_REDIRECT_PATH}`,
        callback,
        respond(kind: 'success' | 'failure'): void {
          if (!heldResponse || heldResponse.writableEnded) {
            return;
          }
          heldResponse.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          heldResponse.end(kind === 'success' ? SUCCESS_HTML : FAILURE_HTML);
        },
        close(): void {
          try {
            if (heldResponse && !heldResponse.writableEnded) {
              heldResponse.end();
            }
          } catch {
            /* ignore */
          }
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
