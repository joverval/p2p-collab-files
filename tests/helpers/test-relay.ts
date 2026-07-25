// tests/helpers/test-relay.ts — Dynamic port relay fixture for integration tests
//
// Every test file gets its own relay instance on a unique port.
// No more EADDRINUSE, no more tests killing each other's servers.
//
// Usage:
//   import { startTestRelay, stopTestRelay } from '../helpers/test-relay';
//   beforeAll(async () => await startTestRelay());
//   afterAll(async () => await stopTestRelay());

import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const RELAY_SCRIPT = resolve(__dirname, '../../server/ws-relay.js');

let relayProcess: ChildProcess | null = null;
let relayPort: number = 0;

/** Find a free port by asking the OS */
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

/** Wait for relay /healthz to respond */
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

export async function startTestRelay(): Promise<{ port: number; url: string }> {
  if (relayProcess) return { port: relayPort, url: `http://localhost:${relayPort}` };

  relayPort = await findFreePort();

  relayProcess = spawn('node', [RELAY_SCRIPT], {
    env: { ...process.env, PORT: String(relayPort), TURN_ENABLED: 'false' },
    stdio: 'pipe',
  });

  // ponytail: consume pipe buffers so subprocess doesn't block on >64KB output
  relayProcess.stdout?.resume();
  relayProcess.stderr?.resume();

  relayProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[test-relay] relay on :${relayPort} exited with code ${code}`);
    }
  });

  await waitForHealth(relayPort);
  console.log(`[test-relay] relay ready on :${relayPort}`);
  return { port: relayPort, url: `http://localhost:${relayPort}` };
}

export async function stopTestRelay(): Promise<void> {
  if (!relayProcess) return;
  const p = relayProcess;
  relayProcess = null;
  relayPort = 0;
  p.kill('SIGTERM');
  // Give it a moment to shut down
  await new Promise(r => setTimeout(r, 500));
  if (!p.killed) p.kill('SIGKILL');
}

export function getRelayPort(): number {
  return relayPort;
}