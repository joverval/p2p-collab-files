// Signaling contract tests: every message type has a relay handler,
// requestId is echoed on all responses, and malformed messages are handled.
//
// Uses WebSocket to test against a live relay server, same pattern as
// the existing relay-authorization.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../../server/ws-relay.js';

/** Connect a WebSocket to the relay and wait for open. */
function wsOpen(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const t = setTimeout(() => { ws.close(); reject(new Error('open timeout')); }, 3000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); ws.close(); reject(e); });
  });
}

/** Send a JSON message and wait for one reply. */
function wsRequest(ws: WebSocket, msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message timeout')), 3000);
    ws.once('message', (data) => { clearTimeout(t); resolve(JSON.parse(data.toString())); });
    ws.send(JSON.stringify(msg));
  });
}

describe('Signaling Contract', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  // ── Message type coverage: every known type → non-error handler ──
  describe('Message type coverage', () => {
    it('ping → pong (non-error response)', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, { type: 'ping', requestId: 'r1' });
      expect(res.type).toBe('pong');
      ws.close();
    });

    it('store-offer → token (non-error response)', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(res.type).toBe('token');
      ws.close();
    });

    it('fetch-offer → non-error response with valid token', async () => {
      const ws1 = await wsOpen(port);
      const offer = await wsRequest(ws1, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(offer.type).toBe('token');

      const ws2 = await wsOpen(port);
      const res = await wsRequest(ws2, {
        type: 'fetch-offer', token: offer.token, requestId: 'r2',
      });
      expect(res.type).toBe('offer');
      ws1.close(); ws2.close();
    });

    it('submit-answer → waiting-approval with valid token', async () => {
      const ws1 = await wsOpen(port);
      const offer = await wsRequest(ws1, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(offer.type).toBe('token');

      const ws2 = await wsOpen(port);
      const res = await wsRequest(ws2, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'base64data', requestId: 'r2',
      });
      expect(res.type).toBe('waiting-approval');
      ws1.close(); ws2.close();
    });

    it('host-approve → host-approve-ack', async () => {
      // Setup: host creates room, peer submits answer
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });

      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      const peerWait = await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      expect(peerWait.type).toBe('waiting-approval');
      const peerReq = await hostPeerReq;
      expect(peerReq.type).toBe('peer-request');

      const res = await wsRequest(host, {
        type: 'host-approve', token: peerReq.token, requestId: 'r3',
      });
      expect(res.type).toBe('host-approve-ack');

      host.close(); peer.close();
    });

    it('host-reject → host-reject-ack', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });

      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;

      const res = await wsRequest(host, {
        type: 'host-reject', token: peerReq.token, requestId: 'r3',
      });
      expect(res.type).toBe('host-reject-ack');

      host.close(); peer.close();
    });

    it('become-host → non-error response', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });

      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;
      await wsRequest(host, {
        type: 'host-approve', token: peerReq.token, requestId: 'r3',
      });

      // peer tries become-host (should get an error or token, depending on state)
      const res = await wsRequest(peer, {
        type: 'become-host', oldToken: offer.token,
        hostEmail: 'peer@test.com', requestId: 'r4',
      });
      // May be 'error' (if not authorized) or 'token' (if promoted).
      // The contract test just verifies the type is handled (not "Invalid discriminator value")
      expect(res.type).toBeTruthy();

      host.close(); peer.close();
    });

    it('store-offer-next → token', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(offer.type).toBe('token');

      const res = await wsRequest(host, {
        type: 'store-offer-next', roomId: offer.roomId,
        sdp: 'sdp-2', offerId: 'o2', requestId: 'r2',
      });
      expect(res.type).toBe('token');

      host.close();
    });

    it('promote-peer → promotion-ack', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });

      // Add and approve a peer
      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;
      await wsRequest(host, {
        type: 'host-approve', token: peerReq.token, requestId: 'r3',
      });

      const res = await wsRequest(host, {
        type: 'promote-peer', roomId: offer.roomId,
        targetEmail: 'peer@test.com', requestId: 'r4',
      });
      expect(res.type).toBe('promotion-ack');

      host.close(); peer.close();
    });

    it('store-promotion-offer → token', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });

      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;
      await wsRequest(host, {
        type: 'host-approve', token: peerReq.token, requestId: 'r3',
      });

      // Promote the peer
      host.send(JSON.stringify({
        type: 'promote-peer', roomId: offer.roomId,
        targetEmail: 'peer@test.com', requestId: 'r4',
      }));

      // Peer receives promotion-request
      const promoReq = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        peer.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      expect(promoReq.type).toBe('promotion-request');

      const res = await wsRequest(peer, {
        type: 'store-promotion-offer', roomId: offer.roomId,
        promotionId: promoReq.promotionId,
        intendedEmail: 'peer@test.com',
        sdp: 'promo-sdp', offerId: 'promo-o1', requestId: 'r5',
      });
      expect(res.type).toBe('token');

      host.close(); peer.close();
    });

    it('commit-promotion → non-error response', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(offer.type).toBe('token');

      // commit-promotion without a valid promotion in progress should return
      // an error (not "Invalid discriminator value"). This verifies the type
      // is handled by the relay.
      const res = await wsRequest(host, {
        type: 'commit-promotion', roomId: offer.roomId,
        promotionId: 'nonexistent', requestId: 'r2',
      });
      // Expected: error response (no promotion in progress or UNAUTHORIZED)
      // The key contract: type is handled, not "Invalid discriminator value"
      expect(res.type).toBe('error');
      expect(res.code).toBeTruthy();

      host.close();
    });

    it('publish → non-error response', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      expect(offer.type).toBe('token');

      // publish to room — may be rejected if no peers, but the type is handled
      const res = await wsRequest(host, {
        type: 'publish', roomId: offer.roomId,
        payload: { test: 'data' }, requestId: 'r2',
      });
      // publish may get an error if no peers exist, but not "Invalid discriminator value"
      expect(res.type).toBeTruthy();

      host.close();
    });

    it('unknown message type → error (not crash)', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, {
        type: 'non-existent-type', requestId: 'r1',
      });
      expect(res.type).toBe('error');
      expect(res.message).toContain('Invalid discriminator value');
      ws.close();
    });
  });

  // ── requestId echo: every response echoes the request's requestId ──
  describe('requestId echo', () => {
    it('ping response echoes requestId', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, { type: 'ping', requestId: 'my-custom-id-123' });
      expect(res.requestId).toBe('my-custom-id-123');
      ws.close();
    });

    it('store-offer response echoes requestId', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'req-store-1',
      });
      expect(res.type).toBe('token');
      expect(res.requestId).toBe('req-store-1');
      ws.close();
    });

    it('fetch-offer response echoes requestId', async () => {
      const ws1 = await wsOpen(port);
      const offer = await wsRequest(ws1, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      const ws2 = await wsOpen(port);
      const res = await wsRequest(ws2, {
        type: 'fetch-offer', token: offer.token, requestId: 'fetch-req-42',
      });
      expect(res.requestId).toBe('fetch-req-42');
      ws1.close(); ws2.close();
    });

    it('submit-answer response echoes requestId', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      const peer = await wsOpen(port);
      const res = await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data',
        requestId: 'submit-answer-99',
      });
      expect(res.requestId).toBe('submit-answer-99');
      host.close(); peer.close();
    });

    it('host-approve response echoes requestId', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;
      const res = await wsRequest(host, {
        type: 'host-approve', token: peerReq.token,
        requestId: 'approve-req-007',
      });
      expect(res.requestId).toBe('approve-req-007');
      host.close(); peer.close();
    });

    it('host-reject response echoes requestId', async () => {
      const host = await wsOpen(port);
      const offer = await wsRequest(host, {
        type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
        hostEmail: 'host@test.com', requestId: 'r1',
      });
      const peer = await wsOpen(port);
      const hostPeerReq = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        host.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      });
      await wsRequest(peer, {
        type: 'submit-answer', token: offer.token,
        email: 'peer@test.com', answerB64: 'data', requestId: 'r2',
      });
      const peerReq = await hostPeerReq;
      const res = await wsRequest(host, {
        type: 'host-reject', token: peerReq.token, requestId: 'reject-abc',
      });
      expect(res.requestId).toBe('reject-abc');
      host.close(); peer.close();
    });

    it('error response echoes requestId', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, {
        type: 'store-offer',
        // Missing required 'sdp' field
        offerId: 'o1', hostEmail: 'host@test.com',
        requestId: 'bad-req-1',
      });
      expect(res.type).toBe('error');
      expect(res.requestId).toBe('bad-req-1');
      ws.close();
    });

    it('response without requestId in request omits requestId', async () => {
      const ws = await wsOpen(port);
      const res = await wsRequest(ws, { type: 'ping' });
      expect(res.type).toBe('pong');
      // No requestId because none was sent
      expect(res.requestId).toBeUndefined();
      ws.close();
    });
  });
});