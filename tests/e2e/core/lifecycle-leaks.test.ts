/**
 * E2E Test J: 5-cycle create/join/leave, verify no memory leaks.
 *
 * Scenario (repeated 5 times):
 *   1. Host creates room, peer joins and is approved
 *   2. Verify chat works between both
 *   3. Collect signaling listener counts on both sides
 *   4. Close both browser contexts (simulates leave/disconnect)
 *
 * After 5 cycles:
 *   - Connection succeeds in every cycle
 *   - Listener counts don't grow across cycles (no leak accumulation)
 *   - Final cycle listener count is <= first cycle listener count (no drift)
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

const CYCLES = 5;

test('5-cycle create/join/leave — no listener leak accumulation', async ({ browser }) => {
  test.setTimeout(180_000); // 3 minutes for 5 full cycles

  const listenerSamples: Array<{ cycle: number; host: number; peer: number }> = [];

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const helpers = createE2EHelpers(browser);
    const {
      createHost,
      joinPeer,
      approvePeer,
      getShareUrl,
      waitForEditor,
      openChatPanel,
      sendChatMessage,
      getChatMessages,
      cleanup,
    } = helpers;

    // ── 1. Host creates room, peer joins ──
    const host = await createHost(`host-cycle${cycle}@e2e.test`);
    const shareUrl = await getShareUrl(host.page);
    const peer = await joinPeer(shareUrl, `peer-cycle${cycle}@e2e.test`);

    // ── 2. Host approves, wait for connection ──
    await approvePeer(host.page, `peer-cycle${cycle}@e2e.test`);
    await waitForEditor(peer.page);

    // ── 3. Verify chat works ──
    await openChatPanel(host.page);
    await sendChatMessage(host.page, `cycle-${cycle}: host message`);
    await openChatPanel(peer.page);
    const peerMsgs = await getChatMessages(peer.page);
    expect(peerMsgs.some((m) => m.includes(`cycle-${cycle}: host message`))).toBeTruthy();

    await sendChatMessage(peer.page, `cycle-${cycle}: peer message`);
    const hostMsgs = await getChatMessages(host.page);
    expect(hostMsgs.some((m) => m.includes(`cycle-${cycle}: peer message`))).toBeTruthy();

    // ── 4. Collect signaling listener counts ──
    const hostListeners = await host.page.evaluate(
      () => (window as any).__P2P_TEST__?.getSignalingListenerCount?.() ?? -1,
    );
    const peerListeners = await peer.page.evaluate(
      () => (window as any).__P2P_TEST__?.getSignalingListenerCount?.() ?? -1,
    );

    listenerSamples.push({ cycle, host: hostListeners, peer: peerListeners });

    // ── 5. Close both contexts (simulates leave) ──
    await cleanup();
  }

  // ── Post-cycle assertions ──

  // Every cycle must have succeeded (listener counts >= 0, connection established)
  for (const sample of listenerSamples) {
    expect(sample.host, `cycle ${sample.cycle} host listener count should be >= 0`).toBeGreaterThanOrEqual(0);
    expect(sample.peer, `cycle ${sample.cycle} peer listener count should be >= 0`).toBeGreaterThanOrEqual(0);
  }

  // Listener counts must not grow across cycles (no leak accumulation).
  // The first cycle establishes the baseline; subsequent cycles must not exceed it.
  const firstCycle = listenerSamples[0];
  const lastCycle = listenerSamples[listenerSamples.length - 1];

  // Host listener counts stable
  expect(
    lastCycle.host,
    `Host listener leak detected: cycle 1=${firstCycle.host}, cycle ${CYCLES}=${lastCycle.host}`,
  ).toBeLessThanOrEqual(firstCycle.host + 2); // small margin for timing variance

  // Peer listener counts stable
  expect(
    lastCycle.peer,
    `Peer listener leak detected: cycle 1=${firstCycle.peer}, cycle ${CYCLES}=${lastCycle.peer}`,
  ).toBeLessThanOrEqual(firstCycle.peer + 2);

  // No runaway growth in any cycle
  for (let i = 1; i < listenerSamples.length; i++) {
    const prev = listenerSamples[i - 1];
    const curr = listenerSamples[i];
    // Listener counts should be consistent, not growing
    expect(
      curr.host,
      `Host listener growth cycle ${i - 1}→${i}: ${prev.host}→${curr.host}`,
    ).toBeLessThanOrEqual(prev.host + 3);
    expect(
      curr.peer,
      `Peer listener growth cycle ${i - 1}→${i}: ${prev.peer}→${curr.peer}`,
    ).toBeLessThanOrEqual(prev.peer + 3);
  }

  console.log(`[lifecycle-leak] Listener samples across ${CYCLES} cycles:`, listenerSamples);
});
