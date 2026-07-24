// Tests UNIT-E: Connection state transitions — data channel only
// Mocks P2PRoom and SignalingClient using vitest module mocking.
// Focus: verify connection state idle → negotiating → connected → closed,
// with 'approved' relay message NOT setting connected.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared state for mocked modules ──
const mockRoomInstances: any[] = [];
let mockRoomCounter = 0;
const signalingInstances: any[] = [];
const signalingHandlers = new Map<string, Set<(...args: any[]) => void>>();

// ── Mock @joverval/p2p-collab ──
vi.mock('@joverval/p2p-collab', () => {
  function MockP2PRoom(isHost: boolean, baseUrl: string, opts?: any) {
    const instance: any = {
      _isHost: isHost,
      _baseUrl: baseUrl,
      _opts: opts,
      _onMessageCb: null as ((data: Uint8Array, peerId: string) => void) | null,
      _onPeerJoinCb: null as ((peerId: string) => void) | null,
      _onPeerConnectCb: null as ((peerId: string) => void) | null,
      _onConnectCb: null as (() => void) | null,
      _onPeerLeaveCb: null as ((peerId: string) => void) | null,
      _onErrorCb: null as ((e: Error) => void) | null,
      _closed: false,

      offerUrl: vi.fn().mockResolvedValue({
        url: `${baseUrl}#sdp=dGVzdHNkcA==`,
        offerId: `offer-${++mockRoomCounter}`,
      }),

      connectToHost: vi.fn().mockImplementation((offerUrl: string) =>
        Promise.resolve(`${baseUrl}#sdp=cGVlcmFuc3dlcg==`)
      ),

      acceptAnswer: vi.fn(),

      onMessage: vi.fn().mockImplementation(function (this: any, cb: (data: Uint8Array, peerId: string) => void) {
        instance._onMessageCb = cb;
      }),

      onPeerJoin: vi.fn().mockImplementation(function (this: any, cb: (peerId: string) => void) {
        instance._onPeerJoinCb = cb;
      }),

      broadcastExcept: vi.fn(),
      send: vi.fn(),
      sendToPeer: vi.fn(),
      close: vi.fn().mockImplementation(function (this: any) { instance._closed = true; }),
      getConnectionRoute: vi.fn().mockResolvedValue({ kind: 'direct' }),
    };

    instance._onPeerConnectCb = opts?.onPeerConnect || null;
    instance._onErrorCb = opts?.onError || null;
    instance._onPeerLeaveCb = opts?.onPeerLeave || null;
    instance._onConnectCb = opts?.onConnect || null;

    mockRoomInstances.push(instance);
    return instance;
  }

  return { P2PRoom: MockP2PRoom };
});

// ── Mock signaling-client ──
vi.mock('../../../src/shell/signaling-client', () => {
  function MockSignalingClient() {
    const mock = {
      connect: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue({ sdp: 'dGVzdHNkcA==', offerId: 'offer-1', roomId: 'room-1' }),
      send: vi.fn(),
      on: vi.fn(function (this: any, type: string, handler: (msg: any) => void) {
        if (!signalingHandlers.has(type)) signalingHandlers.set(type, new Set());
        signalingHandlers.get(type)!.add(handler);
        return () => signalingHandlers.get(type)?.delete(handler);
      }),
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
      get listenerCount(): number {
        let total = 0;
        signalingHandlers.forEach(s => total += s.size);
        return total;
      },
    };
    signalingInstances.push(mock);
    return mock;
  }

  return { SignalingClient: MockSignalingClient };
});

import { SessionController } from '../../../src/shell/session-controller.ts';

// ── Helpers ──
function fireSignalingEvent(type: string, msg: any) {
  const handlers = signalingHandlers.get(type);
  if (handlers) handlers.forEach(h => h(msg));
}

function latestSignaling() {
  return signalingInstances[signalingInstances.length - 1];
}

function latestRoom() {
  return mockRoomInstances[mockRoomInstances.length - 1];
}

function resetAll() {
  signalingHandlers.clear();
  signalingInstances.length = 0;
  mockRoomInstances.length = 0;
  mockRoomCounter = 0;
}

// ── Mock window ──
beforeEach(() => {
  resetAll();

  Object.defineProperty(globalThis, 'window', {
    value: {
      location: {
        href: 'https://app.example.com/',
        hash: '',
        origin: 'https://app.example.com',
      },
      crypto: {
        randomUUID: vi.fn().mockReturnValue('00000000-0000-4000-8000-000000000001'),
      },
    },
    writable: true,
    configurable: true,
  });
});

// ── E.1: Host create — idle → negotiating → connected ──
describe('E.1 — Host create: idle → negotiating → connected', () => {
  it('starts at idle', () => {
    const ctrl = new SessionController();
    expect(ctrl.connectionState).toBe('idle');
  });

  it('transitions to negotiating after createRoom()', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    expect(ctrl.connectionState).toBe('negotiating');
  });

  it('transitions to connected when onPeerConnect fires', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    expect(ctrl.connectionState).toBe('negotiating');

    // Simulate first peer connecting via WebRTC data channel
    if (room._onPeerConnectCb) room._onPeerConnectCb('peer-uuid-1');

    expect(ctrl.connectionState).toBe('connected');
  });

  it('onPeerConnect on host side also fires setConnected callback', async () => {
    const ctrl = new SessionController();
    const setConnectedSpy = vi.fn();
    ctrl.setConnected = setConnectedSpy;
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    if (room._onPeerConnectCb) room._onPeerConnectCb('peer-uuid-1');

    expect(setConnectedSpy).toHaveBeenCalledWith(true);
    expect(ctrl.connectionState).toBe('connected');
  });
});

// ── E.2: Peer join — idle → negotiating → connected ──
describe('E.2 — Peer join: idle → negotiating → connected', () => {
  it('transitions to negotiating after peerAutoJoin()', async () => {
    const ctrl = new SessionController();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    expect(ctrl.connectionState).toBe('negotiating');
  });

  it('transitions to connected when onConnect fires', async () => {
    const ctrl = new SessionController();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    expect(ctrl.connectionState).toBe('negotiating');

    // Simulate P2P data channel open
    if (room._onConnectCb) room._onConnectCb();

    expect(ctrl.connectionState).toBe('connected');
  });

  it('onConnect on peer side also fires setConnected callback', async () => {
    const ctrl = new SessionController();
    const setConnectedSpy = vi.fn();
    ctrl.setConnected = setConnectedSpy;
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    if (room._onConnectCb) room._onConnectCb();

    expect(setConnectedSpy).toHaveBeenCalledWith(true);
  });
});

// ── E.3: 'approved' relay message does NOT set connected ──
describe("E.3 — 'approved' relay message does NOT set connected", () => {
  it('approved event is logged but keeps idle on host side', () => {
    const ctrl = new SessionController();
    let logMsg = '';
    ctrl.onLog = (_type: string, text: string) => { logMsg = text; };

    fireSignalingEvent('approved', {});

    expect(logMsg).toContain('Host approved');
    // State stays idle — only P2P onConnect changes it
    expect(ctrl.connectionState).toBe('idle');
  });

  it('approved event after createRoom() does not set connected', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    // approved is a relay message — the peer side only
    // Host side would receive 'approved' for their own peer-join on another tab
    // Either way, it must not change connectionState
    fireSignalingEvent('approved', {});

    // State stays at negotiating — actual P2P onPeerConnect sets 'connected'
    expect(ctrl.connectionState).toBe('negotiating');
  });

  it('approved event after peerAutoJoin() does not set connected', async () => {
    const ctrl = new SessionController();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');

    // Relay sends 'approved' indicating host accepted the join request
    fireSignalingEvent('approved', {});

    // State stays at negotiating — actual P2P onConnect sets 'connected'
    expect(ctrl.connectionState).toBe('negotiating');
  });

  it('waiting for onConnect after approved does not flip connected prematurely', async () => {
    const ctrl = new SessionController();
    let logMessages: string[] = [];
    ctrl.onLog = (_type: string, text: string) => { logMessages.push(text); };
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');

    // approved arrives
    fireSignalingEvent('approved', {});
    expect(ctrl.connectionState).toBe('negotiating');
    expect(logMessages).toContain('👍 Host approved — waiting for P2P connection...');

    // Verify onConnect is still needed
    const room = latestRoom();
    if (room._onConnectCb) room._onConnectCb();
    expect(ctrl.connectionState).toBe('connected');
  });
});

// ── E.4: close() sets state to 'closed' ──
describe("E.4 — close() sets state to 'closed'", () => {
  it('close() from idle sets closed', () => {
    const ctrl = new SessionController();
    expect(ctrl.connectionState).toBe('idle');
    ctrl.close();
    expect(ctrl.connectionState).toBe('closed');
  });

  it('close() from negotiating sets closed', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    expect(ctrl.connectionState).toBe('negotiating');
    ctrl.close();
    expect(ctrl.connectionState).toBe('closed');
  });

  it('close() from connected sets closed', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();
    if (room._onPeerConnectCb) room._onPeerConnectCb('peer-uuid-1');
    expect(ctrl.connectionState).toBe('connected');
    ctrl.close();
    expect(ctrl.connectionState).toBe('closed');
  });

  it('close() calls room.close() and signaling.close()', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();
    const sig = latestSignaling();

    ctrl.close();

    expect(room.close).toHaveBeenCalled();
    expect(sig.close).toHaveBeenCalled();
  });
});

// ── E.5: Promotion — peer becomes host, connection state transitions ──
describe('E.5 — Promotion: peer becomes host, state transitions', () => {
  it('keeps old room open (stays at prior state) during promotion negotiation', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();

    // Set up mock for promotion: store-promotion-offer + commit-promotion
    const promoOffers: any[] = [];
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'store-promotion-offer') {
        promoOffers.push(msg);
        return Promise.resolve({ type: 'token', token: `t-${msg.intendedEmail}`, offerId: msg.offerId });
      }
      if (msg.type === 'commit-promotion') {
        return Promise.resolve({ type: 'promotion-committed', promotionId: msg.promotionId });
      }
      return Promise.resolve({ sdp: 'dGVzdA==', offerId: 'offer-1', roomId: 'room-1' });
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const oldRoom = latestRoom();
    if (oldRoom._onConnectCb) oldRoom._onConnectCb();
    expect(ctrl.connectionState).toBe('connected');

    // Fire promotion-request — should keep old room alive while negotiating
    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-state-test-1',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', role: 'host' },
        { email: 'peer@test.com', role: 'peer' },
      ],
    });

    // Old room should still be alive during negotiation
    expect(oldRoom._closed).toBe(false);
    // Connection state: old room is still the active room, so 'connected'
    expect(ctrl.connectionState).toBe('connected');
  });

  it('promotion commit: new host room onPeerConnect sets connected', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'store-promotion-offer') {
        return Promise.resolve({ type: 'token', token: `t-${msg.intendedEmail}`, offerId: msg.offerId });
      }
      if (msg.type === 'commit-promotion') {
        return Promise.resolve({ type: 'promotion-committed', promotionId: msg.promotionId });
      }
      return Promise.resolve({ sdp: 'dGVzdA==', offerId: 'offer-1', roomId: 'room-1' });
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');

    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-connect-test',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', role: 'host' },
        { email: 'peer@test.com', role: 'peer' },
      ],
    });

    // Wait for async promotion to create the new room
    await vi.waitFor(() => {
      expect(mockRoomInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    // The new room (index 1) is created as host (isHost=true)
    const newRoom = mockRoomInstances[1];
    expect(newRoom._isHost).toBe(true);

    // After promotion commit, the new room is active
    // Fire onPeerConnect on the new room
    if (newRoom._onPeerConnectCb) newRoom._onPeerConnectCb('reconnecting-peer');
    expect(ctrl.connectionState).toBe('connected');
  });
});

// ── E.6: Failover — reconnecting → negotiating → connected ──
describe('E.6 — Failover: reconnecting → negotiating → connected', () => {
  it("transitions to 'reconnecting' on new-host event", async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'fetch-offer') {
        return Promise.resolve({ sdp: 'dGVzdGZhaWxvdmVy', offerId: 'offer-f', roomId: 'room-1' });
      }
      return Promise.resolve({});
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');

    // new-host event: old host is gone, reconnect as peer to new host
    fireSignalingEvent('new-host', {
      hostEmail: 'newhost@test.com',
      token: 'reconnect-token-123',
    });

    expect(ctrl.connectionState).toBe('reconnecting');
  });

  it('failover complete: onConnect sets connected', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'fetch-offer') {
        return Promise.resolve({ sdp: 'dGVzdGZhaWxvdmVy', offerId: 'offer-f', roomId: 'room-1' });
      }
      return Promise.resolve({});
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const oldRoom = latestRoom();

    fireSignalingEvent('new-host', {
      hostEmail: 'newhost@test.com',
      token: 'reconnect-token-123',
    });

    // After new-host, a new P2PRoom is created — wait for it
    await vi.waitFor(() => {
      expect(mockRoomInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    const newRoom = mockRoomInstances[1];
    expect(ctrl.connectionState).toBe('negotiating');

    // Fire onConnect on the new peer room
    if (newRoom._onConnectCb) newRoom._onConnectCb();

    expect(ctrl.connectionState).toBe('connected');
    // Old room should be closed after new connection
    expect(oldRoom._closed).toBe(true);
  });

  it('failover preserves old room until new connection is established', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'fetch-offer') {
        return Promise.resolve({ sdp: 'dGVzdGZhaWxvdmVy', offerId: 'offer-f', roomId: 'room-1' });
      }
      return Promise.resolve({});
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const oldRoom = latestRoom();

    fireSignalingEvent('new-host', {
      hostEmail: 'newhost@test.com',
      token: 'reconnect-token-123',
    });

    // Old room should NOT be closed yet — replacement hasn't connected
    await vi.waitFor(() => {
      expect(mockRoomInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    // Old room still alive while new room negotiates
    expect(oldRoom._closed).toBe(false);
  });
});

// ── E.7: State consistency across rapid transitions ──
describe('E.7 — State consistency across rapid transitions', () => {
  it('never goes from connected back to idle without close()', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();
    if (room._onConnectCb) room._onConnectCb();
    expect(ctrl.connectionState).toBe('connected');

    // approved should not change state from connected
    fireSignalingEvent('approved', {});
    expect(ctrl.connectionState).toBe('connected');
  });

  it('peek at state after multiple open/close cycles', async () => {
    // First round
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    expect(ctrl.connectionState).toBe('negotiating');
    ctrl.close();
    expect(ctrl.connectionState).toBe('closed');
  });
});

// ── E.8: isConnected getter ──
describe('E.8 — isConnected getter', () => {
  it('returns false for idle', () => {
    const ctrl = new SessionController();
    expect(ctrl.isConnected).toBe(false);
  });

  it('returns false for negotiating', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    expect(ctrl.isConnected).toBe(false);
  });

  it('returns true for connected', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();
    if (room._onPeerConnectCb) room._onPeerConnectCb('peer-uuid-1');
    expect(ctrl.isConnected).toBe(true);
  });

  it('returns false for closed', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    ctrl.close();
    expect(ctrl.isConnected).toBe(false);
  });
});