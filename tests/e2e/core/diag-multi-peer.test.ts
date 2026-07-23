/**
 * Diagnostic test: multi-peer with console capture
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

test('diag: multi-peer console capture', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    getShareUrl,
    waitForShareUrlChange,
    cleanup,
  } = createE2EHelpers(browser);

  // Capture all console messages from all pages
  const allLogs: string[] = [];

  // Create host with console capture
  const host = await createHost('host-diag@test.com', { initialContent: '# Test' });

  // Add console listener
  host.page.on('console', msg => {
    allLogs.push(`[HOST] ${msg.text()}`);
  });

  // First peer
  const shareUrl1 = await getShareUrl(host.page);
  const peer1 = await joinPeer(shareUrl1, 'peer1-diag@test.com');
  peer1.page.on('console', msg => {
    allLogs.push(`[P1] ${msg.text()}`);
  });
  
  await approvePeer(host.page, 'peer1-diag@test.com');
  await waitForEditor(peer1.page);

  // Second peer
  const shareUrl2 = await getShareUrl(host.page);
  const peer2 = await joinPeer(shareUrl2, 'peer2-diag@test.com');
  peer2.page.on('console', msg => {
    allLogs.push(`[P2] ${msg.text()}`);
  });

  // Wait a moment for submit-answer to propagate
  await peer2.page.waitForTimeout(1000);
  
  await approvePeer(host.page, 'peer2-diag@test.com');
  
  // Try waiting for editor
  try {
    await waitForEditor(peer2.page);
  } catch {
    // Ignore timeout, we want the logs
  }

  // Print all debug logs
  console.log('\n=== CONSOLE LOGS ===');
  for (const log of allLogs) {
    if (log.includes('[DEBUG P2P]') || log.includes('ERROR') || log.includes('error') || log.includes('offer') || log.includes('answer') || log.includes('peer-request') || log.includes('approved') || log.includes('token') || log.includes('store-offer') || log.includes('invite') || log.includes('share')) {
      console.log(log);
    }
  }

  // Log share URLs
  const hostShareUrl = await getShareUrl(host.page);
  console.log(`\n[DIAG] Host shareUrl: ${hostShareUrl}`);
  console.log(`[DIAG] shareUrl1 used for peer1: ${shareUrl1}`);
  console.log(`[DIAG] shareUrl2 used for peer2: ${shareUrl2}`);

  // Also check connection state
  const p2State = await peer2.page.evaluate(() => (window as any).__P2P_TEST__?.getConnectionState?.() ?? 'N/A');
  console.log(`[DIAG] Peer2 connection state: ${p2State}`);

  await cleanup();
});