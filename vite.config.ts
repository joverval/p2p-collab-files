import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',
  server: { port: 8082 },
  define: {
    global: 'globalThis',
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
      '@joverval/p2p-collab': path.resolve(__dirname, '../p2p-collab/dist/index.js'),
    },
  },
  optimizeDeps: {
    exclude: ['simple-peer'],
  },
});