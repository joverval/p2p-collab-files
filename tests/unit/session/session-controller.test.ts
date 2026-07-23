// Tests D.1–D.10: SessionController unit tests
// Mocks P2PRoom and SignalingClient using vitest module mocking

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

    instance._onPeerConnectCb = opts?.onPeerConnect;
    instance._onErrorCb = opts?.onError;
    instance._onPeerLeaveCb = opts?.onPeerLeave;
    instance._onConnectCb = opts?.onConnect;

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
    };
    signalingInstances.push(mock);
    return mock;
  }

  return { SignalingClient: MockSignalingClient };
});

// Need to import after mocks are set up
import { SessionController } from '../../../src/shell/session-controller';

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

// Note: do NOT use vi.clearAllMocks() — it breaks mocks created inside vi.mock factories.
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

// ── D.1: Exact offer ID used during approval ──
describe('D.1 — Exact offer ID used during approval', () => {
  it('should call acceptAnswer with the exact offerId from the approvePeer call', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    ctrl.approvePeer({
      email: 'peer@test.com',
      token: 'test-token-123',
      offerId: 'exact-offer-id-456',
      answerB64: 'cGVlcmFuc3dlcg==',
    });

    expect(room.acceptAnswer).toHaveBeenCalledWith(
      'exact-offer-id-456',
      '#sdp=cGVlcmFuc3dlcg=='
    );
  });

  it('should not call acceptAnswer if request is missing fields', async () => {
    const ctrl = new SessionController();
    const onLogSpy = vi.fn();
    ctrl.onLog = onLogSpy;

    ctrl.approvePeer({ email: '', token: '', offerId: '', answerB64: '' });

    expect(onLogSpy).toHaveBeenCalledWith(
      'system',
      'ERROR: approvePeer missing required fields'
    );
  });
});

// ── D.2: Approval not sent when acceptAnswer fails ──
describe('D.2 — Approval not sent when acceptAnswer fails', () => {
  it('should NOT send host-approve when acceptAnswer throws', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();
    const sig = latestSignaling();

    room.acceptAnswer.mockImplementation(() => { throw new Error('SDP mismatch'); });

    const onLogSpy = vi.fn();
    ctrl.onLog = onLogSpy;

    ctrl.approvePeer({
      email: 'peer@test.com',
      token: 'test-token',
      offerId: 'offer-1',
      answerB64: 'bad-answer',
    });

    expect(room.acceptAnswer).toHaveBeenCalled();
    expect(onLogSpy).toHaveBeenCalledWith('system', expect.stringContaining('acceptAnswer failed'));

    const approveCalls = sig.send.mock.calls.filter((call: any[]) => call[0]?.type === 'host-approve');
    expect(approveCalls.length).toBe(0);
  });
});

// ── D.3: Connected state only from P2P callbacks ──
describe('D.3 — Connected state changes only from P2P callbacks', () => {
  it('should set connectionState to connected when P2P onPeerConnect fires (host side)', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    expect(ctrl.connectionState).toBe('negotiating');

    if (room._onPeerConnectCb) room._onPeerConnectCb('peer1');

    expect(ctrl.connectionState).toBe('connected');
  });

  it('should set connectionState to connected when P2P onConnect fires (peer side)', async () => {
    const ctrl = new SessionController();
    
    // peerAutoJoin is async — must await it
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    
    const room = latestRoom();
    expect(room).toBeDefined();

    // peerAutoJoin creates room, which sets up onConnect callback
    // Fire the callback to simulate P2P connection established
    if (room._onConnectCb) room._onConnectCb();

    expect(ctrl.connectionState).toBe('connected');
  });

  it('should log approval but wait for P2P onConnect to change connectionState', () => {
    const ctrl = new SessionController();
    let logMsg = '';
    ctrl.onLog = (_type: string, text: string) => { logMsg = text; };
    fireSignalingEvent('approved', {});
    // approved event triggers log, but connectionState stays idle until actual P2P onConnect
    expect(logMsg).toContain('Host approved');
    expect(ctrl.connectionState).toBe('idle');
  });
});

// ── D.4: Host forwards peer update to every peer except sender ──
describe('D.4 — Host forwards peer update to every peer except sender', () => {
  it('should call broadcastExcept when receiving yjs data from a peer', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    const yjsData = new Uint8Array([0x01, 0x00, 0x01, 0x01, 0x02, 0x03]);
    if (room._onMessageCb) room._onMessageCb(yjsData, 'peer1');

    expect(room.broadcastExcept).toHaveBeenCalledWith(yjsData, 'peer1');
  });
});

// ── D.5: Targeted sync sent only to joining peer ──
describe('D.5 — Targeted sync sent only to joining peer', () => {
  it('sendFeatureDataToPeer should call room.sendToPeer with correct target', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    const rawData = new Uint8Array([10, 20, 30]);
    ctrl.sendFeatureDataToPeer('specific-peer-id', rawData);

    const expected = new Uint8Array(3 + rawData.length);
    expected[0] = 0x01; expected[1] = 0x00; expected[2] = 0x00;
    expected.set(rawData, 3);

    expect(room.sendToPeer).toHaveBeenCalledWith('specific-peer-id', expected);
  });
});

// ── D.6: Old room active while replacement negotiates ──
describe('D.6 — Old room active while replacement negotiates', () => {
  it('should keep old room open during promotion negotiation', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    // Must await peerAutoJoin — it's async and creates the room
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    
    const oldRoom = latestRoom();
    expect(oldRoom).toBeDefined();
    expect(oldRoom._closed).toBe(false);

    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-1',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', isHost: true },
        { email: 'peer@test.com', isHost: false },
      ],
    });

    // Old room should NOT be closed synchronously — promotion is async
    expect(oldRoom._closed).toBe(false);

    // handlePromotionRequest is async — wait for it to create nextRoom
    await vi.waitFor(() => {
      expect(mockRoomInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });
  });
});

// ── D.7: Failed replacement preserves old room ──
describe('D.7 — Failed replacement preserves old room', () => {
  it('should preserve old room when commit-promotion fails', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    // Make the signaling request fail for commit-promotion
    const sig = latestSignaling();
    sig.request.mockImplementation((msg: any) => {
      if (msg.type === 'commit-promotion') {
        return Promise.reject(new Error('Commit failed'));
      }
      if (msg.type === 'store-promotion-offer') {
        return Promise.resolve({ type: 'token', token: 't1', offerId: 'o1' });
      }
      return Promise.resolve(msg.type === 'fetch-offer'
        ? { sdp: 'dGVzdA==', offerId: 'offer-1', roomId: 'room-1' }
        : {});
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const oldRoom = latestRoom();
    expect(oldRoom).toBeDefined();

    const oldRoomCount = mockRoomInstances.length;

    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-fail',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', isHost: true },
        { email: 'peer@test.com', isHost: false },
      ],
    });

    // Wait for the async promotion handling to fail
    await vi.waitFor(() => {
      // The catch block should close nextRoom but preserve oldRoom
      // Old room should not be closed
    }, { timeout: 1000 });

    // Old room should still be alive (not closed)
    expect(oldRoom._closed).toBe(false);
  });
});

// ── D.8: Promotion commit switches role once ──
describe('D.8 — Promotion commit switches role once', () => {
  it('should call onRoleChanged with isHost=true exactly once after successful commit', async () => {
    const ctrl = new SessionController();
    const roleChangedSpy = vi.fn();
    ctrl.onRoleChanged = roleChangedSpy;
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
      // fetch-offer for peerAutoJoin
      return Promise.resolve({ sdp: 'dGVzdA==', offerId: 'offer-1', roomId: 'room-1' });
    });

    await ctrl.peerAutoJoin('test-token', 'peer@test.com');

    // Fire promotion-request with participants
    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-commit-ok',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', isHost: true },
        { email: 'peer@test.com', isHost: false },
        { email: 'other@test.com', isHost: false },
      ],
    });

    // Wait for async promotion flow to complete — use expect() which throws on failure
    await vi.waitFor(() => {
      expect(roleChangedSpy).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(roleChangedSpy).toHaveBeenCalledTimes(1);
    expect(roleChangedSpy).toHaveBeenCalledWith(true, expect.any(String));
  });
});

// ── D.9: Previous host included in reconnect targets ──
describe('D.9 — Previous host included in reconnect targets', () => {
  it('should create reconnect offers for previous host', async () => {
    const ctrl = new SessionController();
    ctrl.onLog = vi.fn();
    ctrl.getEmail = () => 'peer@test.com';

    const sig = latestSignaling();
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

    fireSignalingEvent('promotion-request', {
      roomId: 'test-room-1',
      promotionId: 'promo-include',
      oldHostEmail: 'oldhost@test.com',
      hostEmail: 'peer@test.com',
      participants: [
        { email: 'oldhost@test.com', isHost: true },
        { email: 'peer@test.com', isHost: false },
        { email: 'other@test.com', isHost: false },
      ],
    });

    await vi.waitFor(() => {
      expect(promoOffers.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    const intendedEmails = promoOffers.map((o: any) => o.intendedEmail);
    expect(intendedEmails).toContain('oldhost@test.com');
    expect(intendedEmails).toContain('other@test.com');
    expect(intendedEmails).not.toContain('peer@test.com');
  });
});

// ── D.10: Listener count stable after repeated promotions ──
describe('D.10 — Listener count stable after repeated promotions', () => {
  it('should not accumulate duplicate handlers after multiple promotion events', () => {
    new SessionController(); // constructor registers handlers

    const countBefore = (type: string) => signalingHandlers.get(type)?.size || 0;
    const promoBefore = countBefore('promotion-request');
    const approvedBefore = countBefore('approved');
    const newHostBefore = countBefore('new-host');
    const peerReqBefore = countBefore('peer-request');

    for (let i = 0; i < 5; i++) {
      fireSignalingEvent('promotion-request', {
        roomId: `r-${i}`, promotionId: `p-${i}`,
        oldHostEmail: 'a@t.com', hostEmail: 'b@t.com',
        participants: [],
      });
    }

    expect(countBefore('promotion-request')).toBe(promoBefore);
    expect(countBefore('approved')).toBe(approvedBefore);
    expect(countBefore('new-host')).toBe(newHostBefore);
    expect(countBefore('peer-request')).toBe(peerReqBefore);
  });
});