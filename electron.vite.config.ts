import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { productionCspPlugin } from './build/cspPlugin';
import { parseOAuthClientConfig } from './src/main/google/oauthClientConfig';

/**
 * Build-time embedding of the developer OAuth "Desktop app" public-client
 * configuration (`ARCHITECTURE.md §27.4`). If the build machine has
 * `GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON` pointing at the external Desktop-client
 * JSON, extract ONLY `clientId` + `clientSecret` and inline them into the MAIN
 * bundle (`out/` is gitignored). The raw JSON is never inlined, never printed,
 * and never reaches the renderer bundle. Without the env var the build produces
 * an empty string and the packaged app reports Google connection unavailable.
 */
function embeddedOAuthClientConfig(): string {
  const path = process.env['GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON'];
  if (!path || path.trim() === '') {
    return '';
  }
  try {
    const { clientId, clientSecret } = parseOAuthClientConfig(readFileSync(path.trim(), 'utf8'));
    return JSON.stringify({ clientId, clientSecret });
  } catch {
    console.warn(
      'GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON is set but could not be parsed; building without an embedded Google OAuth client.',
    );
    return '';
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __GOOGLE_OAUTH_CLIENT_CONFIG__: JSON.stringify(embeddedOAuthClientConfig()),
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react(), productionCspPlugin()],
  },
});
