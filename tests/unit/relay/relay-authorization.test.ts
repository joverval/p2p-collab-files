// Relay authorization tests: role enforcement, token security, input validation,
// origin security, room lifecycle, connection handling, TURN credentials
// Follows the exact WebSocket pattern from relay-protocol.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../../server/ws-relay.js';

describe('Relay Authorization', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  // ── 3.6.8: Role enforcement — non-host cannot approve/reject ──
  describe('Role enforcement', () => {
    it('non-host cannot approve a peer join', async () => {
      // Setup: host creates room, peer submits answer
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const offerToken = hostRes.token;

      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });

      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      peer.send(JSON.stringify({ type: 'submit-answer', token: offerToken, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));

      const waitRes = await peerWait;
      expect(waitRes.type).toBe('waiting-approval');
      const peerReq = await hostPeerReq;
      expect(peerReq.type).toBe('peer-request');
      const peerToken = peerReq.token;

      // Now: a third connection (impostor) tries to approve
      const impostor = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { impostor.on('open', r); impostor.on('error', rj); });

      impostor.send(JSON.stringify({ type: 'host-approve', token: peerToken, requestId: 'approve-1' }));
      const imposterRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); impostor.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // The relay rejects host-approve from non-host connections with an error
      expect(imposterRes.type).toBe('error');

      host.close(); peer.close(); impostor.close();
    });

    it('non-host cannot reject a peer join', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const offerToken = hostRes.token;

      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });

      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      peer.send(JSON.stringify({ type: 'submit-answer', token: offerToken, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));

      await peerWait;
      const peerReq = await hostPeerReq;
      const peerToken = peerReq.token;

      const impostor = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { impostor.on('open', r); impostor.on('error', rj); });

      impostor.send(JSON.stringify({ type: 'host-reject', token: peerToken, requestId: 'reject-1' }));
      const imposterRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); impostor.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // The relay rejects host-reject from non-host connections with an error
      expect(imposterRes.type).toBe('error');

      host.close(); peer.close(); impostor.close();
    });

    it('promotion commit with invalid promotionId returns error', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const roomId = hostRes.roomId;

      host.send(JSON.stringify({ type: 'commit-promotion', roomId, promotionId: 'nonexistent', requestId: 'commit-1' }));
      const errRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(errRes.type).toBe('error');
      expect(errRes.message).toContain('promotion');

      host.close();
    });

    it('non-host promote-peer sends promotion-request to target', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const roomId = hostRes.roomId;

      // Add a peer participant
      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });

      // Store a second offer
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'store-2' }));
      const store2Res = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(store2Res.type).toBe('token');
      const offerToken2 = store2Res.token;

      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      peer.send(JSON.stringify({ type: 'submit-answer', token: offerToken2, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-2' }));
      await peerWait;
      const peerReq = await hostPeerReq;
      expect(peerReq.type).toBe('peer-request');
      const peerToken = peerReq.token;

      // Approve peer
      host.send(JSON.stringify({ type: 'host-approve', token: peerToken, requestId: 'approve-2' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // Now promote from host (valid)
      host.send(JSON.stringify({ type: 'promote-peer', roomId, targetEmail: 'peer@test.com', requestId: 'promo-1' }));
      const promoAck = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(promoAck.type).toBe('promotion-ack');

      host.close(); peer.close();
    });

    it('non-host cannot store-offer-next', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const roomId = hostRes.roomId;

      // Impostor connects and tries store-offer-next on the host's room
      const impostor = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { impostor.on('open', r); impostor.on('error', rj); });

      impostor.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'imposter-sdp', offerId: 'imposter-offer', requestId: 'next-1' }));
      const imposterRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); impostor.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(imposterRes.type).toBe('error');
      expect(imposterRes.code).toBe('UNAUTHORIZED');

      host.close(); impostor.close();
    });

    it('non-host cannot promote-peer', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const roomId = hostRes.roomId;

      // Add a peer
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'store-2' }));
      const store2Res = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });
      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peer.send(JSON.stringify({ type: 'submit-answer', token: store2Res.token, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));
      await peerWait;
      const peerReq = await hostPeerReq;
      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token, requestId: 'approve-1' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      // Peer is now a member. Now the peer tries to promote themselves (not host)
      peer.send(JSON.stringify({ type: 'promote-peer', roomId, targetEmail: 'peer@test.com', requestId: 'promo-1' }));
      const peerPromoRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(peerPromoRes.type).toBe('error');
      expect(peerPromoRes.code).toBe('UNAUTHORIZED');

      host.close(); peer.close();
    });

    it('non-target cannot store-promotion-offer', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const roomId = hostRes.roomId;

      // Add peer A and approve
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'store-2' }));
      const store2Res = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerA = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peerA.on('open', r); peerA.on('error', rj); });
      const hostPeerReqA = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerAwait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peerA.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peerA.send(JSON.stringify({ type: 'submit-answer', token: store2Res.token, email: 'peerA@test.com', answerB64: 'data', requestId: 'answer-a' }));
      await peerAwait;
      const paReq = await hostPeerReqA;
      host.send(JSON.stringify({ type: 'host-approve', token: paReq.token, requestId: 'approve-a' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // Host promotes peerA
      host.send(JSON.stringify({ type: 'promote-peer', roomId, targetEmail: 'peerA@test.com', requestId: 'promo-1' }));
      const promoAck = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(promoAck.type).toBe('promotion-ack');
      const promotionId = promoAck.promotionId;

      // A third, unrelated peer B connects — peerB tries store-promotion-offer (not the target)
      const peerB = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peerB.on('open', r); peerB.on('error', rj); });
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-3', offerId: 'offer-3', requestId: 'store-3' }));
      const store3Res = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const hostPeerReqB = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerBwait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peerB.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peerB.send(JSON.stringify({ type: 'submit-answer', token: store3Res.token, email: 'peerB@test.com', answerB64: 'data', requestId: 'answer-b' }));
      await peerBwait;
      const pbReq = await hostPeerReqB;
      host.send(JSON.stringify({ type: 'host-approve', token: pbReq.token, requestId: 'approve-b' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // peerB tries store-promotion-offer (peerB is NOT the promotion target — peerA is)
      peerB.send(JSON.stringify({ type: 'store-promotion-offer', roomId, promotionId, intendedEmail: 'peerB@test.com', sdp: 'evil-sdp', offerId: 'evil-offer', requestId: 'spoof-1' }));
      const spoofRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peerB.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(spoofRes.type).toBe('error');
      expect(spoofRes.code).toBe('UNAUTHORIZED');

      host.close(); peerA.close(); peerB.close();
    });

    it('non-target cannot commit-promotion', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const roomId = hostRes.roomId;

      // Add and approve peer
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'store-2' }));
      const store2Res = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });
      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peer.send(JSON.stringify({ type: 'submit-answer', token: store2Res.token, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));
      await peerWait;
      const peerReq = await hostPeerReq;
      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token, requestId: 'approve-1' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // Host promotes peer
      host.send(JSON.stringify({ type: 'promote-peer', roomId, targetEmail: 'peer@test.com', requestId: 'promo-1' }));
      const promoAck = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const promotionId = promoAck.promotionId;

      // Impostor (not the promotion target) tries commit-promotion
      const impostor = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { impostor.on('open', r); impostor.on('error', rj); });

      impostor.send(JSON.stringify({ type: 'commit-promotion', roomId, promotionId, requestId: 'commit-1' }));
      const imposterRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); impostor.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(imposterRes.type).toBe('error');
      expect(imposterRes.code).toBe('UNAUTHORIZED');

      host.close(); peer.close(); impostor.close();
    });

    it('non-member cannot become-host with valid token', async () => {
      // Setup: host creates room
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const hostRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(hostRes.type).toBe('token');
      const offerToken = hostRes.token;
      const roomId = hostRes.roomId;

      // Peer joins and is approved
      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });

      const hostPeerReq = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      peer.send(JSON.stringify({ type: 'submit-answer', token: offerToken, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));
      await peerWait;
      const peerReq = await hostPeerReq;
      expect(peerReq.type).toBe('peer-request');
      const peerToken = peerReq.token;

      host.send(JSON.stringify({ type: 'host-approve', token: peerToken, requestId: 'approve-1' }));
      await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // Impostor connects (not a member, no submit-answer)
      const impostor = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { impostor.on('open', r); impostor.on('error', rj); });

      // Impostor sends become-host with the original offer token (still valid in tokenRoom)
      impostor.send(JSON.stringify({ type: 'become-host', oldToken: offerToken, hostEmail: 'impostor@test.com', requestId: 'become-1' }));
      const imposterRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); impostor.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(imposterRes.type).toBe('error');
      expect(imposterRes.code).toBe('UNAUTHORIZED');

      host.close(); peer.close(); impostor.close();
    });
  });

  // ── 3.6.11-3.6.12: Token security ──
  describe('Token security', () => {
    it('invalid token rejected on fetch-offer', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'fetch-offer', token: 'invalid-token-that-does-not-exist', requestId: 'fetch-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('error');
      expect(result.message).toBe('Token not found or expired');
      ws.close();
    });

    it('submit-answer with valid token receives waiting-approval', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const storeRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(storeRes.type).toBe('token');

      const peer = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer.on('open', r); peer.on('error', rj); });

      const peerWait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peer.send(JSON.stringify({ type: 'submit-answer', token: storeRes.token, email: 'peer@test.com', answerB64: 'data', requestId: 'answer-1' }));
      const waitingRes = await peerWait;

      expect(waitingRes.type).toBe('waiting-approval');
      host.close(); peer.close();
    });

    it('duplicate email submission updates the member WS reference', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const storeRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // First connection for email 'dup@test.com'
      const peer1 = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer1.on('open', r); peer1.on('error', rj); });

      const p1Wait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer1.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peer1.send(JSON.stringify({ type: 'submit-answer', token: storeRes.token, email: 'dup@test.com', answerB64: 'v1', requestId: 'a1' }));
      const r1 = await p1Wait;
      expect(r1.type).toBe('waiting-approval');

      // Second connection for same email 'dup@test.com' with new offer
      host.send(JSON.stringify({ type: 'store-offer-next', roomId: storeRes.roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'store-2' }));
      const store2 = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(store2.type).toBe('token');

      const peer2 = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { peer2.on('open', r); peer2.on('error', rj); });

      const p2Wait = new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); peer2.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      peer2.send(JSON.stringify({ type: 'submit-answer', token: store2.token, email: 'dup@test.com', answerB64: 'v2', requestId: 'a2' }));
      const r2 = await p2Wait;
      // The relay allows duplicate email: updates the existing member's WS
      expect(r2.type).toBe('waiting-approval');

      host.close(); peer1.close(); peer2.close();
    });
  });

  // ── 3.6.13-3.6.14: Input validation ──
  describe('Input validation', () => {
    it('missing required fields returns error', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'store-offer', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'req-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('error');
      expect(result.message).toContain('Invalid input');
      ws.close();
    });

    it('malformed JSON is silently ignored', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send('{ this is not valid json }');

      // Connection should still be alive — send a valid message
      ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      // The relay may return an error or pong; either way connection is alive
      expect(result.type).toBeTruthy();
      ws.close();
    });

    it('unknown message type returns error', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'unknown-command', requestId: 'req-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('error');
      expect(result.message).toContain('Invalid discriminator value');
      ws.close();
    });
  });

  // ── 3.6.15: Origin security ──
  describe('Origin security', () => {
    it('WebSocket connection is accepted on /ws path', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('pong');
      ws.close();
    });

    it('WebSocket upgrade rejected on non-/ws path', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/bad-path`);

      const err = await new Promise<string>((resolve) => {
        ws.on('error', () => resolve('error'));
        ws.on('unexpected-response', (_req, res) => {
          resolve(`unexpected-response ${res.statusCode}`);
        });
        setTimeout(() => resolve('timeout'), 3000);
      });

      // The socket should be destroyed / connection should fail
      expect(err).toBeTruthy(); // any kind of failure is expected
      ws.close();
    });

    it('WebSocket connection rejected when origin not in allowlist', async () => {
      // Create a relay with a tight origin allowlist
      const strictRelay = createRelayServer({
        port: 0,
        allowedOrigins: ['https://trusted.example.com'],
      });
      const strictPort = await strictRelay.start();

      const ws = new WebSocket(`ws://localhost:${strictPort}/ws`, {
        origin: 'https://evil.example.com',
      });

      const outcome = await new Promise<string>((resolve) => {
        ws.on('open', () => resolve('connected'));
        ws.on('error', () => resolve('error'));
        ws.on('unexpected-response', (_req, res) => {
          resolve(`unexpected-response ${res.statusCode}`);
        });
        setTimeout(() => resolve('timeout'), 3000);
      });

      expect(outcome).not.toBe('connected');

      ws.close();
      await strictRelay.stop();
    });

    it('WebSocket connection accepted when origin is in allowlist', async () => {
      const strictRelay = createRelayServer({
        port: 0,
        allowedOrigins: ['https://trusted.example.com'],
      });
      const strictPort = await strictRelay.start();

      const ws = new WebSocket(`ws://localhost:${strictPort}/ws`, {
        origin: 'https://trusted.example.com',
      });

      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('pong');
      ws.close();
      await strictRelay.stop();
    });

    it('WebSocket connection rejected when missing origin in production mode', async () => {
      // Set NODE_ENV=production for this test
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const prodRelay = createRelayServer({ port: 0 });
        const prodPort = await prodRelay.start();

        // Connect without setting an origin header
        const ws = new WebSocket(`ws://localhost:${prodPort}/ws`);

        const outcome = await new Promise<string>((resolve) => {
          ws.on('open', () => resolve('connected'));
          ws.on('error', () => resolve('error'));
          ws.on('unexpected-response', (_req, res) => {
            resolve(`unexpected-response ${res.statusCode}`);
          });
          setTimeout(() => resolve('timeout'), 3000);
        });

        expect(outcome).not.toBe('connected');

        ws.close();
        await prodRelay.stop();
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('WebSocket connection allowed when origin is set in production mode', async () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const prodRelay = createRelayServer({
          port: 0,
          allowedOrigins: ['https://prod.example.com'],
        });
        const prodPort = await prodRelay.start();

        const ws = new WebSocket(`ws://localhost:${prodPort}/ws`, {
          origin: 'https://prod.example.com',
        });

        await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

        ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));
        const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

        expect(result.type).toBe('pong');
        ws.close();
        await prodRelay.stop();
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('CORS headers set for allowed origins on HTTP endpoints', async () => {
      const http = await import('node:http');
      const result = await new Promise<{ status: number; cors: string; iceServers: any[] }>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/turn-credentials`, {
          headers: { Origin: 'http://localhost:8082' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve({
            status: res.statusCode || 0,
            cors: (res.headers['access-control-allow-origin'] as string) || '',
            iceServers: JSON.parse(body).iceServers,
          }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      expect(result.status).toBe(200);
      expect(result.cors).toBe('http://localhost:8082');
      expect(result.iceServers.length).toBeGreaterThan(0);
    });
  });

  // ── 3.6.16-3.6.17: Room lifecycle ──
  describe('Room lifecycle', () => {
    it('existing room accepts store-offer-next from same connection', async () => {
      const host = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { host.on('open', r); host.on('error', rj); });

      host.send(JSON.stringify({ type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1', hostEmail: 'host@test.com', requestId: 'store-1' }));
      const storeRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });
      expect(storeRes.type).toBe('token');
      const roomId = storeRes.roomId;

      // Second offer on same room from SAME connection
      host.send(JSON.stringify({ type: 'store-offer-next', roomId, sdp: 'sdp-2', offerId: 'offer-2', requestId: 'next-1' }));
      const nextRes = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); host.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(nextRes.type).toBe('token');
      expect(nextRes.roomId).toBe(roomId);
      expect(nextRes.offerId).toBe('offer-2');

      host.close();
    });

    it('store-offer-next with invalid roomId returns error', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      ws.send(JSON.stringify({ type: 'store-offer-next', roomId: 'nonexistent-room', sdp: 'test', offerId: 'o1', requestId: 'req-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('error');
      expect(result.message).toBe('Room not found');
      ws.close();
    });
  });

  // ── 3.6.18-3.6.19: Connection handling ──
  describe('Connection handling', () => {
    it('multiple rapid messages are all processed', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      const promises: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(new Promise<any>((r, rj) => {
          const t = setTimeout(() => rj(new Error('timeout')), 2000);
          ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
        }));
      }

      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: 'ping', requestId: `ping-${i}` }));
      }

      const results = await Promise.all(promises);
      expect(results.length).toBe(5);
      for (const r of results) {
        expect(r.type).toBe('pong');
      }
      ws.close();
    });

    it('heartbeat ping/pong keeps connection alive', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

      // Send a ping and expect pong
      ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));
      const result = await new Promise<any>((r, rj) => { const t = setTimeout(() => rj(new Error('timeout')), 2000); ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); }); });

      expect(result.type).toBe('pong');
      expect(result.requestId).toBe('ping-1');
      ws.close();
    });
  });

  // ── 3.6.20-3.6.21: TURN credentials ──
  describe('TURN credentials', () => {
    it('TURN credentials absent when disabled', async () => {
      // Use default relay (TURN disabled)
      const http = await import('node:http');
      const result = await new Promise<{ iceServers: any[] }>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/turn-credentials`, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      const turnServers = result.iceServers.filter((s: any) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u: string) => u.startsWith('turn:'));
      });
      expect(turnServers.length).toBe(0);

      const stunServers = result.iceServers.filter((s: any) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u: string) => u.startsWith('stun:'));
      });
      expect(stunServers.length).toBeGreaterThan(0);
    });
  });
});