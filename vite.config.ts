import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  server: { port: 8082 },
  define: { global: 'globalThis' },
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