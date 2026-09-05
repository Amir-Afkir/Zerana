import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { isPublicMapboxToken } from './site-token.mjs';

const token = (process.env.VITE_MAPBOX_API_KEY || '').trim();
if (token && !isPublicMapboxToken(token)) throw new Error('Only public Mapbox tokens may enter the preview build');

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: '/Zerana/v2/',
  publicDir: false,
  // Preserve the isolated environment prefix; expose only these two V1 build inputs.
  envPrefix: 'ZERANA_DEMO_',
  define: {
    'import.meta.env.VITE_MAPBOX_API_KEY': JSON.stringify(token),
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(process.env.VITE_BUILD_SHA || 'local'),
  },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../demo-dist/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
