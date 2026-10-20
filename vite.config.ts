import { defineConfig } from 'vite';

// JSX goes through Vite 8's built-in Oxc transform (vite.dev/guide/features).
// No @preact/preset-vite: it would pull in @babel/core.
export default defineConfig({
  base: '/dialin/',
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js is one lazily loaded chunk (≈ 635 kB, 165 kB gzip) used only by the 3D views.
    chunkSizeWarningLimit: 700,
  },
});
