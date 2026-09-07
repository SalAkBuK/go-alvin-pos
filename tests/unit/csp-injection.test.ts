import { describe, expect, it } from 'vitest';
import { CSP_META_TAG, injectCspIntoHtml, PRODUCTION_CSP } from '../../build/cspPlugin';

const SAMPLE_BUILT_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '    <title>Go Phones POS</title>',
  '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
  '    <link rel="stylesheet" crossorigin href="./assets/index-abc.css" />',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
].join('\n');

describe('injectCspIntoHtml', () => {
  it('inserts the CSP meta as the first child of <head>, before scripts/links/charset', () => {
    const out = injectCspIntoHtml(SAMPLE_BUILT_HTML);

    const headIdx = out.indexOf('<head>');
    const cspIdx = out.indexOf('http-equiv="Content-Security-Policy"');
    const scriptIdx = out.indexOf('<script');
    const charsetIdx = out.indexOf('<meta charset');

    expect(cspIdx).toBeGreaterThan(headIdx);
    expect(cspIdx).toBeLessThan(scriptIdx);
    expect(cspIdx).toBeLessThan(charsetIdx);
  });

  it('embeds exactly the intended policy and nothing looser', () => {
    const out = injectCspIntoHtml(SAMPLE_BUILT_HTML);

    expect(out).toContain(CSP_META_TAG);
    expect(out).toContain(`content="${PRODUCTION_CSP}"`);
    expect(PRODUCTION_CSP).toContain("default-src 'self'");
    expect(PRODUCTION_CSP).toContain("script-src 'self'");
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("base-uri 'none'");
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval');
    // script-src must stay strict ('self' only — no inline/eval)
    expect(PRODUCTION_CSP).toMatch(/script-src 'self'(;|$)/);
  });

  it('injects the policy exactly once', () => {
    const out = injectCspIntoHtml(SAMPLE_BUILT_HTML);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it('handles an opening <head> tag that carries attributes', () => {
    const out = injectCspIntoHtml('<html><head data-x="y"><script></script></head></html>');
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script'));
  });

  it('throws loudly when there is no <head> anchor', () => {
    expect(() => injectCspIntoHtml('<html><body>no head here</body></html>')).toThrow(/head/i);
  });
});
