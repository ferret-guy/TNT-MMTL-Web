import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // static deploy anywhere (subdirectory-friendly)
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  // bem.mjs is emitted by emscripten with dynamic new URL('bem.wasm', import.meta.url);
  // it lives in public/ and is loaded at runtime by URL, never bundled.
  optimizeDeps: {
    exclude: [],
  },
});
