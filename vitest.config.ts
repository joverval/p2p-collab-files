import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/vite-env.d.ts', 'src/main.ts'],
      thresholds: {
        // Decision 6: 80% coverage gates
        'src/shell/protocol/': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/shell/': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
      reporter: ['text', 'lcov', 'json-summary'],
    },
    env: {
      VITE_P2P_TEST_API: 'true',
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
      '@joverval/p2p-collab': path.resolve(__dirname, '../p2p-collab/dist/index.js'),
    },
  },
});