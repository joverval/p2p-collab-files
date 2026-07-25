// tests/e2e/global.setup.ts — Playwright global setup
// Starts the WebSocket relay on a dynamic port before E2E tests.
// Port is passed via RELAY_URL env var to both Vite (webServer) and test files.
//
// No hardcoded 8083. Each `playwright test` gets a fresh relay on a free port.

import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RELAY_SCRIPT = resolve(__dirname, '../../server/ws-relay.js');

let relayProcess: ChildProcess | null = null;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Relay on :${port} didn't become healthy within ${timeoutMs}ms`);
}

async function globalSetup(): Promise<void> {
  const port = await findFreePort();
  const relayUrl = `ws://localhost:${port}/ws`;
  const relayHttpUrl = `http://localhost:${port}`;

  relayProcess = spawn('node', [RELAY_SCRIPT], {
    env: { ...process.env, PORT: String(port), TURN_ENABLED: 'false', LOG_LEVEL: 'warn' },
    stdio: 'pipe',
    // ponytail: detach so relay doesn't inherit parent's stdio
    detached: true,
  });

  relayProcess.stdout?.resume();
  relayProcess.stderr?.resume();

  relayProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[globalSetup] relay on :${port} exited with code ${code}`);
    }
  });

  await waitForHealth(port);

  // Set env vars for webServer command and test files
  process.env.RELAY_URL = relayUrl;
  process.env.VITE_SIGNAL_WS_URL = relayUrl;
  process.env.VITE_SIGNAL_HTTP_URL = relayHttpUrl;

  console.log(`[globalSetup] relay ready on :${port}, RELAY_URL=${relayUrl}`);
}

async function globalTeardown(): Promise<void> {
  // ponytail: relay is detached process, kill the whole group
  if (relayProcess && relayProcess.pid) {
    try {
      process.kill(-relayProcess.pid, 'SIGTERM');
    } catch {
      relayProcess.kill('SIGTERM');
    }
    await new Promise(r => setTimeout(r, 500));
    if (!relayProcess.killed) {
      try {
        process.kill(-relayProcess.pid, 'SIGKILL');
      } catch {
        relayProcess.kill('SIGKILL');
      }
    }
  }
}

export default globalSetup;
export { globalTeardown };