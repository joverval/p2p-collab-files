import { defineConfig } from 'vite';
import path from 'path';

// For local dev, resolve to sibling p2p-collab repo.
// In CI/Pages, the npm package provides the library.
const localLib = path.resolve(__dirname, '../p2p-collab/dist/index.js');

export default defineConfig({
  base: './',
  server: { port: 8082 },
  define: { global: 'globalThis' },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
    },
  },
  optimizeDeps: {
    exclude: ['simple-peer'],
  },
});