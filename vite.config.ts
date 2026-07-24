import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import path from 'path';

let commitSHA = 'dev';
try {
  commitSHA = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // no git history (CI shallow clone without fetch-depth: 0, or non-git env)
}

export default defineConfig({
  base: './',
  server: { port: 8082 },
  define: {
    global: 'globalThis',
    __COMMIT_SHA__: JSON.stringify(commitSHA),
  },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
      },
  },
  optimizeDeps: {
    exclude: ['simple-peer'],
  },
});