import type { Plugin } from 'vite';

/**
 * Production Content-Security-Policy for the packaged renderer
 * (ARCHITECTURE.md Sections 6, 29).
 *
 * `frame-ancestors` is intentionally omitted: it is ignored when delivered via
 * `<meta>` and would have to be sent as a response header. A `file://` desktop
 * window cannot be framed anyway.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`;

/** Matches the opening `<head>` tag (with or without attributes). */
const HEAD_OPEN_TAG = /<head(?:\s[^>]*)?>/i;

/**
 * Insert {@link CSP_META_TAG} as the very first child of `<head>`, before any
 * script/style/resource. Throws if the anchor is missing so a build can never
 * silently ship an unprotected renderer.
 */
export function injectCspIntoHtml(html: string): string {
  if (!HEAD_OPEN_TAG.test(html)) {
    throw new Error(
      'inject-production-csp: no opening <head> tag found in the renderer entry HTML; ' +
        'cannot place the Content-Security-Policy meta tag deterministically.',
    );
  }
  return html.replace(HEAD_OPEN_TAG, (headTag) => `${headTag}\n    ${CSP_META_TAG}`);
}

/**
 * electron-vite renderer plugin. Runs only for `build` (production); the dev
 * server is served from `http://localhost` and does not receive this policy.
 */
export function productionCspPlugin(): Plugin {
  return {
    name: 'go-phones-pos:inject-production-csp',
    apply: 'build',
    transformIndexHtml: {
      // `post` guarantees the bundle <script>/<link> tags are already present,
      // so anchoring to `<head>` places the CSP strictly before them.
      order: 'post',
      handler: (html: string): string => injectCspIntoHtml(html),
    },
  };
}
