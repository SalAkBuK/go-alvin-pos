import { promises as dnsPromises } from 'node:dns';

/**
 * A genuinely bounded DNS resolution used only to decide whether a UNC
 * hostname (an alias such as `\\pos-backup-alias\Backups`) happens to resolve
 * back to one of this machine's own addresses (Phase 2L-C.2 remaining-
 * corrections fix).
 *
 * `dns.lookup()` goes through the OS resolver via libuv's threadpool, which —
 * like `fs.realpath()` — has no real cancellation: racing it with a timer
 * only abandons the JS promise while the underlying `getaddrinfo()` call
 * keeps running. `dns.promises.Resolver` instead uses Node's own c-ares
 * resolver, whose `cancel()` method genuinely aborts in-flight queries at the
 * network layer — a real bound, not a cosmetic one. No child process is
 * needed here: unlike the filesystem checks in `windowsDiskInspection.ts`,
 * this resolver has a built-in, real cancellation primitive.
 *
 * Resolution failing, timing out, or being unavailable is NEVER evidence that
 * a host is local — it only means this specific check cannot positively rule
 * a remote host in or out, so the caller must treat it as "not proven local"
 * and continue with the destination's other verification checks.
 */

export type BoundedHostnameResolutionResult =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly errorCode: 'RESOLUTION_TIMEOUT' | 'RESOLUTION_UNAVAILABLE' };

export interface HostnameResolver {
  resolve(hostname: string): Promise<BoundedHostnameResolutionResult>;
}

export interface BoundedHostnameResolverOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export function createBoundedHostnameResolver(
  options: BoundedHostnameResolverOptions = {},
): HostnameResolver {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async resolve(hostname): Promise<BoundedHostnameResolutionResult> {
      const resolver = new dnsPromises.Resolver({ timeout: timeoutMs });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        resolver.cancel(); // genuinely aborts in-flight c-ares queries — not cosmetic
      }, timeoutMs);

      try {
        const [v4, v6] = await Promise.all([
          resolver.resolve4(hostname).catch(() => [] as string[]),
          resolver.resolve6(hostname).catch(() => [] as string[]),
        ]);
        const addresses = [...v4, ...v6];
        if (addresses.length === 0) {
          return {
            ok: false,
            errorCode: timedOut ? 'RESOLUTION_TIMEOUT' : 'RESOLUTION_UNAVAILABLE',
          };
        }
        return { ok: true, addresses };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
