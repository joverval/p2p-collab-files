// Tests: Room state — snapshot publish/apply + host security
// Mocks P2PRoom and SignalingClient using vitest module mocking (same pattern as session-controller.test.ts)

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

import { SessionController } from '../../../src/shell/session-controller.ts';
import type { RoomSnapshot } from '../../../src/shared/types.ts';

// ── Helpers ──
function fireSignalingEvent(type: string, msg: any) {
  const handlers = signalingHandlers.get(type);
  if (handlers) handlers.forEach(h => h(msg));
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

// ── Build a [ROOM_STATE] message as it would appear on the wire ──
function makeRoomStateMessage(snapshot: RoomSnapshot): Uint8Array {
  const json = JSON.stringify(snapshot);
  const text = `[ROOM_STATE]${json}`;
  const encoded = new TextEncoder().encode(text);
  const data = new Uint8Array(1 + encoded.length);
  data[0] = 0x00; // encodeChat type byte
  data.set(encoded, 1);
  return data;
}

// ── Extract text payload from a send() call argument (Uint8Array from encodeChat) ──
function decodeSendText(data: Uint8Array): string {
  return new TextDecoder().decode(data.slice(1));
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

// ─────────────────────────────────────────────────
// 1. Host path: createRoom → publishRoomSnapshot
// ─────────────────────────────────────────────────
describe('Host: publishRoomSnapshot sends [ROOM_STATE]', () => {
  it('should call room.send with [ROOM_STATE] JSON after createRoom', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    // Find all send calls with [ROOM_STATE]
    const stateCalls = room.send.mock.calls.filter((c: any[]) => {
      const text = decodeSendText(c[0]);
      return text.startsWith('[ROOM_STATE]');
    });

    expect(stateCalls.length).toBeGreaterThanOrEqual(1);

    const stateText = decodeSendText(stateCalls[0][0]);
    const jsonPart = stateText.slice('[ROOM_STATE]'.length);
    const snap = JSON.parse(jsonPart);

    expect(snap.roomId).toBe('room-1');
    expect(snap.version).toBeGreaterThanOrEqual(1);
    expect(snap.hostParticipantId).toBe('host');
    expect(snap.participants).toHaveLength(1);
    expect(snap.participants[0].email).toBe('host@test.com');
    expect(snap.participants[0].role).toBe('host');
  });

  it('should increment version on each publishRoomSnapshot call', async () => {
    const ctrl = new SessionController();
    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    // Manually trigger publishRoomSnapshot (exposed indirectly)
    // Call broadcastRoomState which delegates to publishRoomSnapshot
    ctrl.broadcastRoomState([
      { email: 'host@test.com', role: 'host', participantId: 'host', connected: true, joinOrder: 1 },
      { email: 'peer@test.com', role: 'peer', participantId: 'peer1', connected: true, joinOrder: 2 },
    ]);

    const stateCalls = room.send.mock.calls.filter((c: any[]) => {
      const text = decodeSendText(c[0]);
      return text.startsWith('[ROOM_STATE]');
    });

    expect(stateCalls.length).toBeGreaterThanOrEqual(2);

    const v1 = JSON.parse(decodeSendText(stateCalls[0][0]).slice('[ROOM_STATE]'.length)).version;
    const v2text = decodeSendText(stateCalls[stateCalls.length - 1][0]);
    const v2snap = JSON.parse(v2text.slice('[ROOM_STATE]'.length));
    
    expect(v2snap.version).toBeGreaterThan(v1);
    expect(v2snap.participants).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────
// 2. Peer path: receive [ROOM_STATE] → applyRoomSnapshot
// ─────────────────────────────────────────────────
describe('Peer: receives [ROOM_STATE] → applyRoomSnapshot', () => {
  it('should accept valid snapshot (roomId match, version > last)', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    const snap: RoomSnapshot = {
      roomId: 'room-1',
      version: 5,
      hostParticipantId: 'host-1',
      participants: [
        { email: 'host@test.com', role: 'host', participantId: 'host-1', connected: true, joinOrder: 1 },
        { email: 'peer@test.com', role: 'peer', participantId: 'peer@test.com', connected: true, joinOrder: 2 },
      ],
    };

    const msg = makeRoomStateMessage(snap);
    if (room._onMessageCb) room._onMessageCb(msg, 'host-peer-id');

    expect(ctrl.onRoomState).toHaveBeenCalledTimes(1);
    expect(ctrl.onRoomState).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      version: 5,
    }));

    // Verify internal state was updated
    expect(ctrl.participants).toHaveLength(2);
    expect(ctrl.hostParticipantId).toBe('host-1');
  });

  it('should reject snapshot with wrong roomId', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    const snap: RoomSnapshot = {
      roomId: 'wrong-room-id',
      version: 10,
      hostParticipantId: 'intruder',
      participants: [
        { email: 'intruder@x.com', role: 'host', participantId: 'intruder', connected: true, joinOrder: 1 },
      ],
    };

    const msg = makeRoomStateMessage(snap);
    if (room._onMessageCb) room._onMessageCb(msg, 'host-peer-id');

    // applyRoomSnapshot rejects because roomId !== this._roomId
    expect(ctrl.onRoomState).not.toHaveBeenCalled();
    expect(ctrl.participants).toHaveLength(0);
  });

  it('should ignore stale version (version <= last)', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    // Apply v5 via wire message
    const snap5: RoomSnapshot = {
      roomId: 'room-1',
      version: 5,
      hostParticipantId: 'host-1',
      participants: [
        { email: 'host@test.com', role: 'host', participantId: 'host-1', connected: true, joinOrder: 1 },
      ],
    };
    const msg5 = makeRoomStateMessage(snap5);
    if (room._onMessageCb) room._onMessageCb(msg5, 'host-peer-id');
    expect(ctrl.onRoomState).toHaveBeenCalledTimes(1);

    // Now send stale v3 (version <= _lastRoomStateVersion which is 5)
    const snap3: RoomSnapshot = {
      roomId: 'room-1',
      version: 3,
      hostParticipantId: 'old-host',
      participants: [
        { email: 'old@test.com', role: 'host', participantId: 'old-host', connected: true, joinOrder: 1 },
      ],
    };
    const msg3 = makeRoomStateMessage(snap3);
    if (room._onMessageCb) room._onMessageCb(msg3, 'host-peer-id');

    // Stale: onRoomState count unchanged, participants unchanged
    expect(ctrl.onRoomState).toHaveBeenCalledTimes(1);
    expect(ctrl.participants[0].email).toBe('host@test.com');
  });

  it('should ignore same version (not > last)', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    const snap: RoomSnapshot = {
      roomId: 'room-1',
      version: 2,
      hostParticipantId: 'host-1',
      participants: [
        { email: 'host1@test.com', role: 'host', participantId: 'host-1', connected: true, joinOrder: 1 },
      ],
    };
    if (room._onMessageCb) room._onMessageCb(makeRoomStateMessage(snap), 'host-peer-id');
    expect(ctrl.onRoomState).toHaveBeenCalledTimes(1);

    // Same version again
    const snapSame: RoomSnapshot = {
      roomId: 'room-1',
      version: 2,
      hostParticipantId: 'host-2',
      participants: [
        { email: 'host2@test.com', role: 'host', participantId: 'host-2', connected: true, joinOrder: 1 },
      ],
    };
    if (room._onMessageCb) room._onMessageCb(makeRoomStateMessage(snapSame), 'host-peer-id');

    expect(ctrl.onRoomState).toHaveBeenCalledTimes(1);
    expect(ctrl.hostParticipantId).toBe('host-1'); // unchanged
  });

  it('should call onRoomState callback with correct snapshot data', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    const snap: RoomSnapshot = {
      roomId: 'room-1',
      version: 7,
      hostParticipantId: 'host-99',
      participants: [
        { email: 'alpha@test.com', role: 'host', participantId: 'host-99', connected: true, joinOrder: 1 },
        { email: 'beta@test.com', role: 'peer', participantId: 'peer-1', connected: true, joinOrder: 2 },
        { email: 'gamma@test.com', role: 'peer', participantId: 'peer-2', connected: false, joinOrder: 3 },
      ],
    };

    if (room._onMessageCb) room._onMessageCb(makeRoomStateMessage(snap), 'host-peer-id');

    expect(ctrl.onRoomState).toHaveBeenCalledWith(snap);

    // participants populated correctly
    expect(ctrl.participants).toHaveLength(3);
    expect(ctrl.participants.map(p => p.email)).toEqual(['alpha@test.com', 'beta@test.com', 'gamma@test.com']);
    expect(ctrl.hostParticipantId).toBe('host-99');
  });
});

// ─────────────────────────────────────────────────
// 3. Host security: host ignores [ROOM_STATE] from peer
// ─────────────────────────────────────────────────
describe('Host security: ignores [ROOM_STATE] from peer', () => {
  it('should call console.warn and NOT apply peer room-state', async () => {
    const ctrl = new SessionController();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctrl.onRoomState = vi.fn();

    await ctrl.createRoom('host@test.com');
    const room = latestRoom();

    const roomStateCallsBefore = ctrl.onRoomState.mock.calls.length;

    // Simulate a malicious peer sending [ROOM_STATE] to the host
    const snap: RoomSnapshot = {
      roomId: 'room-1',
      version: 99,
      hostParticipantId: 'attacker',
      participants: [
        { email: 'attacker@x.com', role: 'host', participantId: 'attacker', connected: true, joinOrder: 1 },
      ],
    };

    const msg = makeRoomStateMessage(snap);
    if (room._onMessageCb) room._onMessageCb(msg, 'malicious-peer-id');

    // Host MUST warn AND NOT apply the peer's snapshot
    expect(warnSpy).toHaveBeenCalledWith('Protocol: host received room-state from peer (ignored)');

    // onRoomState should NOT be called for the peer's fake snapshot
    // (the count stays at what it was after initial publishRoomSnapshot)
    expect(ctrl.onRoomState).toHaveBeenCalledTimes(roomStateCallsBefore);

    // Participants should still be the original host, not the attacker
    expect(ctrl.participants[0].email).toBe('host@test.com');
    expect(ctrl.participants[0].role).toBe('host');

    warnSpy.mockRestore();
  });

  it('should NOT warn for [ROOM_STATE] sent by host itself (publishRoomSnapshot)', async () => {
    const ctrl = new SessionController();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ctrl.createRoom('host@test.com');

    // publishRoomSnapshot was called during createRoom — it sends via room.send,
    // NOT through onMessage handler. console.warn should NOT fire.
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────
// 4. Edge cases
// ─────────────────────────────────────────────────
describe('Room state edge cases', () => {
  it('should handle empty participants snapshot', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    const snap: RoomSnapshot = {
      roomId: 'room-1',
      version: 1,
      hostParticipantId: '',
      participants: [],
    };

    if (room._onMessageCb) room._onMessageCb(makeRoomStateMessage(snap), 'host-peer-id');

    expect(ctrl.onRoomState).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1', version: 1 }));
    expect(ctrl.participants).toHaveLength(0);
  });

  it('should handle malformed JSON gracefully (no crash)', async () => {
    const ctrl = new SessionController();
    ctrl.onRoomState = vi.fn();
    await ctrl.peerAutoJoin('test-token', 'peer@test.com');
    const room = latestRoom();

    // Send a [ROOM_STATE] with non-JSON payload (simulates corruption)
    const text = '[ROOM_STATE]not-json{{{';
    const encoded = new TextEncoder().encode(text);
    const data = new Uint8Array(1 + encoded.length);
    data[0] = 0x00;
    data.set(encoded, 1);

    // Should NOT throw — the try/catch in peerAutoJoin's onMessage handler catches it
    expect(() => {
      if (room._onMessageCb) room._onMessageCb(data, 'host-peer-id');
    }).not.toThrow();

    // onRoomState should not have been called (JSON parse failed)
    expect(ctrl.onRoomState).not.toHaveBeenCalled();
  });
});