// rotation-tokens.test.ts --- Unit tests for invite rotation, manual mode, single-use tokens, error states
// Relay-level tests use createRelayServer (in-memory, no live services).
// Client-level tests use vi.mock for SessionController.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../server/ws-relay.js';

// ════════════════════════════════════════════════════════════════
// Helpers for relay integration tests
// ════════════════════════════════════════════════════════════════

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Set up a one-shot listener that resolves when a message arrives. */
function expectMsg(ws: WebSocket, label = 'msg', timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${label}`)), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// ════════════════════════════════════════════════════════════════
// Part 1: Rotation trigger --- relay-level: token lifecycle
// ════════════════════════════════════════════════════════════════

describe('Rotation trigger', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  describe('peer-request triggers rotation (not onPeerJoin)', () => {
    it('submit-answer triggers peer-request to host with correct offerId', async () => {
      const host = await connectWs(port);

      // Store offer
      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'offer-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store-res');
      expect(storeRes.type).toBe('token');
      const token = storeRes.token;

      // Peer fetches the offer
      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token }));
      const fetchRes = await expectMsg(peer, 'fetch-res');
      expect(fetchRes.type).toBe('offer');

      // Set up host listener BEFORE sending submit-answer (relay sends peer-request synchronously)
      const hostPeerReq = expectMsg(host, 'peer-request');

      peer.send(JSON.stringify({
        type: 'submit-answer', token,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      const submitRes = await expectMsg(peer, 'submit-res');
      expect(submitRes.type).toBe('waiting-approval');

      const peerReq = await hostPeerReq;
      expect(peerReq.type).toBe('peer-request');
      expect(peerReq.offerId).toBe('offer-1');
      expect(peerReq.email).toBe('peer@test.com');
      expect(peerReq.answerB64).toBe('cGVlcmFuc3dlcg==');

      host.close();
      peer.close();
    });

    it('original offer token is consumed after host-approve', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'offer-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const token = storeRes.token;

      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token }));
      await expectMsg(peer, 'fetch');

      // Listen on host BEFORE submit-answer
      const hostPeerReq = expectMsg(host, 'peer-req');
      peer.send(JSON.stringify({
        type: 'submit-answer', token,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer, 'waiting');
      const peerReq = await hostPeerReq;

      // Listen on peer BEFORE host-approve
      const peerApproved = expectMsg(peer, 'approved');
      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'approve-ack');
      const approved = await peerApproved;
      expect(approved.type).toBe('approved');

      // Original offer token is now consumed
      const fetcher = await connectWs(port);
      fetcher.send(JSON.stringify({ type: 'fetch-offer', token }));
      const refetch = await expectMsg(fetcher, 'refetch');
      expect(refetch.type).toBe('error');

      host.close();
      peer.close();
      fetcher.close();
    });

    it('store-offer-next produces a fresh token after peer consumption', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'offer-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const oldToken = storeRes.token;
      const roomId = storeRes.roomId;

      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token: oldToken }));
      await expectMsg(peer, 'fetch');

      const hostPeerReq = expectMsg(host, 'peer-req');
      peer.send(JSON.stringify({
        type: 'submit-answer', token: oldToken,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer, 'waiting');
      const peerReq = await hostPeerReq;

      const peerApproved = expectMsg(peer, 'approved');
      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'ack');
      await peerApproved;

      // Rotate
      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'bmV3c2Rw', offerId: 'offer-2',
      }));
      const rotateRes = await expectMsg(host, 'rotate');
      expect(rotateRes.type).toBe('token');
      expect(rotateRes.token).toBeTruthy();
      expect(rotateRes.token).not.toBe(oldToken);

      // New token is fetchable
      const fetcher = await connectWs(port);
      fetcher.send(JSON.stringify({ type: 'fetch-offer', token: rotateRes.token }));
      const newFetch = await expectMsg(fetcher, 'new-fetch');
      expect(newFetch.type).toBe('offer');
      expect(newFetch.sdp).toBe('bmV3c2Rw');
      expect(newFetch.offerId).toBe('offer-2');

      host.close();
      peer.close();
      fetcher.close();
    });
  });

  describe('idempotent rotation', () => {
    it('two sequential store-offer-next produce distinct tokens', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'c2RwMQ==', offerId: 'idem-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const roomId = storeRes.roomId;

      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'c2RwMg==', offerId: 'idem-2',
      }));
      const rot1 = await expectMsg(host, 'rot1');
      expect(rot1.type).toBe('token');

      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'c2RwMw==', offerId: 'idem-3',
      }));
      const rot2 = await expectMsg(host, 'rot2');
      expect(rot2.type).toBe('token');
      expect(rot2.token).not.toBe(rot1.token);

      host.close();
    });

    it('each rotation token is independently fetchable', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'c2RwMQ==', offerId: 'ind-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const roomId = storeRes.roomId;

      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'c2RwMg==', offerId: 'ind-2',
      }));
      const rot1 = await expectMsg(host, 'rot1');

      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'c2RwMw==', offerId: 'ind-3',
      }));
      const rot2 = await expectMsg(host, 'rot2');

      const f1 = await connectWs(port);
      f1.send(JSON.stringify({ type: 'fetch-offer', token: rot1.token }));
      const f1r = await expectMsg(f1, 'f1');
      expect(f1r.type).toBe('offer');
      expect(f1r.sdp).toBe('c2RwMg==');
      f1.close();

      const f2 = await connectWs(port);
      f2.send(JSON.stringify({ type: 'fetch-offer', token: rot2.token }));
      const f2r = await expectMsg(f2, 'f2');
      expect(f2r.type).toBe('offer');
      expect(f2r.sdp).toBe('c2RwMw==');
      f2.close();

      host.close();
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Part 2: Manual mode --- client-side mocked tests
// ════════════════════════════════════════════════════════════════

// Hoisted mock: signaling-client in manual mode (connect fails)
vi.mock('../../src/shell/signaling-client', () => {
  function MockSignalingClient() {
    return {
      connect: vi.fn().mockRejectedValue(new Error('relay down')),
      request: vi.fn().mockRejectedValue(new Error('not connected')),
      send: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
      close: vi.fn(),
      fetchIceConfig: vi.fn().mockResolvedValue({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceCandidatePoolSize: 2,
        iceTransportPolicy: 'all' as RTCIceTransportPolicy,
      }),
      refreshIfNeeded: vi.fn().mockResolvedValue({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceCandidatePoolSize: 2,
        iceTransportPolicy: 'all' as RTCIceTransportPolicy,
      }),
    };
  }
  return { SignalingClient: MockSignalingClient, WsFactory: null };
});

// Hoisted mock: p2p-collab --- mockImplementation so each offerUrl() call is fresh
vi.mock('@joverval/p2p-collab', () => {
  let counter = 0;
  function MockP2PRoom(isHost: boolean, baseUrl: string, opts?: any) {
    const instance: any = {
      _isHost: isHost, _baseUrl: baseUrl, _opts: opts, _closed: false,
      offerUrl: vi.fn().mockImplementation(() => {
        const n = ++counter;
        return Promise.resolve({
          url: `${baseUrl}#sdp=${btoa(`offer-${n}`)}`,
          offerId: `offer-${n}`,
        });
      }),
      connectToHost: vi.fn().mockResolvedValue(`${baseUrl}#sdp=cGVlcmFuc3dlcg==`),
      acceptAnswer: vi.fn(),
      onMessage: vi.fn(),
      onPeerJoin: vi.fn(),
      broadcastExcept: vi.fn(),
      send: vi.fn(),
      sendToPeer: vi.fn(),
      close: vi.fn().mockImplementation(function (this: any) { instance._closed = true; }),
      getConnectionRoute: vi.fn().mockResolvedValue({ kind: 'direct' }),
    };
    return instance;
  }
  return { P2PRoom: MockP2PRoom };
});

import { SessionController } from '../../src/shell/session-controller';

describe('Manual mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));

    Object.defineProperty(globalThis, 'window', {
      value: {
        location: {
          href: 'https://app.example.com/',
          hash: '',
          origin: 'https://app.example.com',
        },
        crypto: { randomUUID: vi.fn().mockReturnValue('00000000-0000-4000-8000-000000000001') },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('new offer after accept', () => {
    it('rotateInvite produces a different offerId in manual mode', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      const firstOfferId = ctrl.currentOfferId;
      expect(firstOfferId).toBeTruthy();

      await ctrl.rotateInvite();
      const secondOfferId = ctrl.currentOfferId;

      expect(secondOfferId).toBeTruthy();
      expect(secondOfferId).not.toBe(firstOfferId);
    });

    it('manual mode share URL uses offer/sdp query format', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      expect(ctrl.shareUrl).toMatch(/^https:\/\/app\.example\.com\/#offer=/);
      expect(ctrl.shareUrl).toContain('&sdp=');
    });

    it('rotateInvite updates share URL with new offerId and sdp', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      const firstUrl = ctrl.shareUrl;
      await ctrl.rotateInvite();
      const secondUrl = ctrl.shareUrl;

      expect(secondUrl).not.toBe(firstUrl);
      expect(secondUrl).toMatch(/^https:\/\/app\.example\.com\/#offer=/);
      expect(secondUrl).toContain('&sdp=');
    });
  });

  describe('answer routed to correct offerId', () => {
    it('manualAcceptAnswer calls acceptAnswer with correct offerId', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      const offerId = ctrl.currentOfferId;

      ctrl.manualAcceptAnswer(offerId, `#sdp=${btoa('peer-answer-sdp')}`);
      const room = (ctrl as any).room;
      expect(room.acceptAnswer).toHaveBeenCalledWith(offerId, `#sdp=${btoa('peer-answer-sdp')}`);
    });

    it('manualAcceptAnswer with wrong offerId still delegates to room.acceptAnswer', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      ctrl.manualAcceptAnswer('wrong-offer-id', `#sdp=${btoa('peer-answer-sdp')}`);
      const room = (ctrl as any).room;
      expect(room.acceptAnswer).toHaveBeenCalledWith('wrong-offer-id', `#sdp=${btoa('peer-answer-sdp')}`);
    });
  });

  describe('invite change notification', () => {
    it('rotateInvite fires onInviteChanged with new token and share URL', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      const calls: [string, string][] = [];
      ctrl.onInviteChanged = (token, shareUrl) => calls.push([token, shareUrl]);

      await ctrl.createRoom('host@test.com');
      await ctrl.rotateInvite();

      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe(ctrl.token);
      expect(calls[0][1]).toBe(ctrl.shareUrl);
    });

    it('rotateInvite idempotent: returns false when in progress', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      (ctrl as any)._rotateInProgress = true;
      expect(await ctrl.rotateInvite()).toBe(false);
    });

    it('rotateInvite guard resets so sequential calls succeed', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      expect(await ctrl.rotateInvite()).toBe(true);
      expect((ctrl as any)._rotateInProgress).toBe(false);
      expect(await ctrl.rotateInvite()).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Part 3: Single-use --- relay-level: submit-answer once then blocked
// ════════════════════════════════════════════════════════════════

describe('Single-use token', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  it('submit-answer succeeds once', async () => {
    const host = await connectWs(port);

    host.send(JSON.stringify({
      type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'su-1',
      hostEmail: 'host@test.com',
    }));
    const storeRes = await expectMsg(host, 'store');
    const token = storeRes.token;

    const peer = await connectWs(port);
    peer.send(JSON.stringify({ type: 'fetch-offer', token }));
    await expectMsg(peer, 'fetch');

    peer.send(JSON.stringify({
      type: 'submit-answer', token,
      email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
    }));
    const submitRes = await expectMsg(peer, 'submit');
    expect(submitRes.type).toBe('waiting-approval');

    host.close();
    peer.close();
  });

  it('second submit-answer with same token returns OFFER_ALREADY_CLAIMED', async () => {
    const host = await connectWs(port);

    host.send(JSON.stringify({
      type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'su-2',
      hostEmail: 'host@test.com',
    }));
    const storeRes = await expectMsg(host, 'store');
    const token = storeRes.token;

    // First peer claims
    const peer1 = await connectWs(port);
    peer1.send(JSON.stringify({ type: 'fetch-offer', token }));
    await expectMsg(peer1, 'fetch1');

    // Set up host listener BEFORE sending submit-answer
    const hostPeerReq1 = expectMsg(host, 'peer-req1');
    peer1.send(JSON.stringify({
      type: 'submit-answer', token,
      email: 'peer1@test.com', answerB64: 'cGVlcmFuc3dlcg==',
    }));
    const submit1 = await expectMsg(peer1, 'submit1');
    expect(submit1.type).toBe('waiting-approval');
    await hostPeerReq1; // Drain peer-request

    // Second peer tries same token
    const peer2 = await connectWs(port);
    peer2.send(JSON.stringify({ type: 'fetch-offer', token }));
    await expectMsg(peer2, 'fetch2');
    peer2.send(JSON.stringify({
      type: 'submit-answer', token,
      email: 'peer2@test.com', answerB64: 'YW5vdGhlcg==',
    }));
    const submit2 = await expectMsg(peer2, 'submit2');
    expect(submit2.type).toBe('error');
    expect(submit2.code).toBe('OFFER_ALREADY_CLAIMED');

    host.close();
    peer1.close();
    peer2.close();
  });

  it('fetch-offer with consumed token returns error', async () => {
    const host = await connectWs(port);

    host.send(JSON.stringify({
      type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'su-3',
      hostEmail: 'host@test.com',
    }));
    const storeRes = await expectMsg(host, 'store');
    const token = storeRes.token;

    // Peer claims and submits
    const peer = await connectWs(port);
    peer.send(JSON.stringify({ type: 'fetch-offer', token }));
    await expectMsg(peer, 'fetch');

    const hostPeerReq = expectMsg(host, 'peer-req');
    peer.send(JSON.stringify({
      type: 'submit-answer', token,
      email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
    }));
    await expectMsg(peer, 'waiting');
    const peerReq = await hostPeerReq;

    // Host approves (consumes token)
    host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
    await expectMsg(host, 'ack');

    // New fetcher on fresh connection
    const fetcher = await connectWs(port);
    fetcher.send(JSON.stringify({ type: 'fetch-offer', token }));
    const fetchRes = await expectMsg(fetcher, 'refetch');
    expect(fetchRes.type).toBe('error');

    host.close();
    peer.close();
    fetcher.close();
  });
});

// ════════════════════════════════════════════════════════════════
// Part 4: Error states --- relay-level: consumed tokens rejected,
//          retry recovery, stale invite not valid
// ════════════════════════════════════════════════════════════════

describe('Error states', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  describe('consumed token produces error', () => {
    it('fetch-offer on consumed token returns error', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'es-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const token = storeRes.token;

      // Consume via submit + approve
      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token }));
      await expectMsg(peer, 'fetch');

      const hostPeerReq = expectMsg(host, 'peer-req');
      peer.send(JSON.stringify({
        type: 'submit-answer', token,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer, 'waiting');
      const peerReq = await hostPeerReq;

      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'ack');

      // Consumed token is rejected
      const fetcher2 = await connectWs(port);
      fetcher2.send(JSON.stringify({ type: 'fetch-offer', token }));
      const fetchRes = await expectMsg(fetcher2, 'refetch');
      expect(fetchRes.type).toBe('error');

      host.close();
      peer.close();
      fetcher2.close();
    });

    it('submit-answer on consumed token returns error', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'es-2',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const token = storeRes.token;

      // Consume via submit + approve
      const peer1 = await connectWs(port);
      peer1.send(JSON.stringify({ type: 'fetch-offer', token }));
      await expectMsg(peer1, 'fetch');

      const hostPeerReq = expectMsg(host, 'peer-req');
      peer1.send(JSON.stringify({
        type: 'submit-answer', token,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer1, 'waiting');
      const peerReq = await hostPeerReq;

      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'ack');

      // Second submit on same token
      const peer2 = await connectWs(port);
      peer2.send(JSON.stringify({
        type: 'submit-answer', token,
        email: 'peer2@test.com', answerB64: 'YW5vdGhlcg==',
      }));
      const submitRes = await expectMsg(peer2, 'submit2');
      expect(submitRes.type).toBe('error');

      host.close();
      peer1.close();
      peer2.close();
    });
  });

  describe('retry recovers', () => {
    it('store-offer-next works after original token is consumed', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'dGVzdHNkcA==', offerId: 'es-3',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const roomId = storeRes.roomId;

      // Consume original token
      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token: storeRes.token }));
      await expectMsg(peer, 'fetch');

      const hostPeerReq = expectMsg(host, 'peer-req');
      peer.send(JSON.stringify({
        type: 'submit-answer', token: storeRes.token,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer, 'waiting');
      const peerReq = await hostPeerReq;

      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'ack');

      // store-offer-next still works
      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'cmV0cnlzZHA=', offerId: 'es-retry',
      }));
      const rotateRes = await expectMsg(host, 'rotate');
      expect(rotateRes.type).toBe('token');
      expect(rotateRes.token).toBeTruthy();

      // New token is fetchable
      const fetcher = await connectWs(port);
      fetcher.send(JSON.stringify({ type: 'fetch-offer', token: rotateRes.token }));
      const fetchRes = await expectMsg(fetcher, 'new-fetch');
      expect(fetchRes.type).toBe('offer');
      expect(fetchRes.sdp).toBe('cmV0cnlzZHA=');

      host.close();
      peer.close();
      fetcher.close();
    });
  });

  describe('old invite not presented as valid', () => {
    it('consumed token rejected after store-offer-next adds fresh token', async () => {
      const host = await connectWs(port);

      host.send(JSON.stringify({
        type: 'store-offer', sdp: 'b2xkc2Rw', offerId: 'old-1',
        hostEmail: 'host@test.com',
      }));
      const storeRes = await expectMsg(host, 'store');
      const oldToken = storeRes.token;
      const roomId = storeRes.roomId;

      // Consume old token
      const peer = await connectWs(port);
      peer.send(JSON.stringify({ type: 'fetch-offer', token: oldToken }));
      await expectMsg(peer, 'fetch');

      const hostPeerReq = expectMsg(host, 'peer-req');
      peer.send(JSON.stringify({
        type: 'submit-answer', token: oldToken,
        email: 'peer@test.com', answerB64: 'cGVlcmFuc3dlcg==',
      }));
      await expectMsg(peer, 'waiting');
      const peerReq = await hostPeerReq;

      host.send(JSON.stringify({ type: 'host-approve', token: peerReq.token }));
      await expectMsg(host, 'ack');

      // Rotate: add fresh token
      host.send(JSON.stringify({
        type: 'store-offer-next', roomId,
        sdp: 'bmV3c2Rw', offerId: 'new-1',
      }));
      const rotateRes = await expectMsg(host, 'rotate');
      expect(rotateRes.type).toBe('token');

      // Old token rejected
      const fetcher2 = await connectWs(port);
      fetcher2.send(JSON.stringify({ type: 'fetch-offer', token: oldToken }));
      const oldFetch = await expectMsg(fetcher2, 'old-fetch');
      expect(oldFetch.type).toBe('error');

      // New token works (close and reconnect to avoid listener conflict)
      fetcher2.close();
      const fetcher3 = await connectWs(port);
      fetcher3.send(JSON.stringify({ type: 'fetch-offer', token: rotateRes.token }));
      const newFetchRes = await expectMsg(fetcher3, 'new-fetch');
      expect(newFetchRes.type).toBe('offer');
      expect(newFetchRes.sdp).toBe('bmV3c2Rw');

      host.close();
      peer.close();
      fetcher3.close();
    });
  });
});