import { defineConfig } from 'vite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: {
    headers: isolationHeaders,
    // Native sources/artifacts are rebuilt separately. Dropbox can lock their
    // many files during sync, and they do not participate in Vite HMR.
    watch: { ignored: ['**/vendor/**', '**/build/**'] },
  },
  preview: { headers: isolationHeaders },
  base: './', // static deploy anywhere (subdirectory-friendly)
  // The project lives inside a Dropbox folder; Dropbox's sync locks files in
  // node_modules/.vite mid-optimize (EBUSY on rename). Keep the dep cache in
  // the OS temp dir instead.
  cacheDir: join(tmpdir(), 'tnt-web-vite-cache'),
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        about: resolve('about.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
