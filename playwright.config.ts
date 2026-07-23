import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/e2e.xml' }],
  ],
  use: {
    baseURL: 'http://localhost:8082',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: [
    {
      command: `VITE_P2P_TEST_API=true VITE_SIGNAL_WS_URL=ws://localhost:8083/ws VITE_SIGNAL_HTTP_URL=http://localhost:8083 VITE_ICE_MODE=${process.env.VITE_ICE_MODE || 'all'} npx vite --port 8082`,
      port: 8082,
      reuseExistingServer: !process.env.CI,
    },
  ],
});