import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: '/Zerana/v2/',
  publicDir: false,
  envPrefix: 'ZERANA_DEMO_',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../demo-dist/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
