// ice-invite.test.ts — Unit tests for ICE fallback, TURN validation, rotateInvite
// No live servers — all network calls mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mock: SessionController tests need mocked SignalingClient
vi.mock('../../src/shell/signaling-client', () => {
  function MockSignalingClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation((msg: any) => {
        if (msg.type === 'store-offer') return Promise.resolve({ sdp: 'dGVzdHNkcA==', offerId: 'offer-1', roomId: 'room-1', token: 'tok-initial' });
        if (msg.type === 'store-offer-next') return Promise.resolve({ sdp: msg.sdp, offerId: msg.offerId, token: 'tok-rotated' });
        return Promise.resolve({ sdp: 'dGVzdHNkcA==', offerId: 'offer-1', roomId: 'room-1' });
      }),
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

// Hoisted mock: p2p-collab
vi.mock('@joverval/p2p-collab', () => {
  let counter = 0;
  function MockP2PRoom(isHost: boolean, baseUrl: string, opts?: any) {
    const instance: any = {
      _isHost: isHost, _baseUrl: baseUrl, _opts: opts, _closed: false,
      offerUrl: vi.fn().mockResolvedValue({
        url: `${baseUrl}#sdp=dGVzdHNkcA==`,
        offerId: `offer-${++counter}`,
      }),
      connectToHost: vi.fn().mockResolvedValue(`${baseUrl}#sdp=cGVlcmFuc3dlcg==`),
      acceptAnswer: vi.fn(),
      onMessage: vi.fn().mockImplementation(function (this: any, cb: any) { instance._onMessageCb = cb; }),
      onPeerJoin: vi.fn().mockImplementation(function (this: any, cb: any) { instance._onPeerJoinCb = cb; }),
      broadcastExcept: vi.fn(), send: vi.fn(), sendToPeer: vi.fn(),
      close: vi.fn().mockImplementation(function (this: any) { instance._closed = true; }),
      getConnectionRoute: vi.fn().mockResolvedValue({ kind: 'direct' }),
    };
    instance._onPeerConnectCb = opts?.onPeerConnect;
    instance._onErrorCb = opts?.onError;
    instance._onPeerLeaveCb = opts?.onPeerLeave;
    instance._onConnectCb = opts?.onConnect;
    return instance;
  }
  return { P2PRoom: MockP2PRoom };
});

// Static import gets the mock (for rotateInvite tests)
import { SessionController } from '../../src/shell/session-controller';

// ════════════════════════════════════════════════════════════════
// Part 1: ICE Fallback — uses vi.importActual for real SignalingClient
// ════════════════════════════════════════════════════════════════

describe('ICE fallback', () => {
  const relayResponse = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ],
    iceCandidatePoolSize: 2,
    ttl: 3600,
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  // ── Finite TTL on fallback ───────────────────────────────────
  describe('finite TTL on STUN fallback', () => {
    it('sets a finite expiry (not Infinity) when relay is unavailable', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockRejectedValueOnce(new Error('network error'));

      const client = new SignalingClient();
      await client.fetchIceConfig();

      expect(client.iceConfigSource).toBe('fallback');

      vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000);
      expect(client.iceConfig).not.toBeNull();

      const expiry = (client as any)._iceConfigExpiry;
      expect(expiry).toBeLessThan(Infinity);
      expect(expiry).toBeGreaterThan(0);
    });

    it('refreshIfNeeded re-fetches after fallback expiry', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockRejectedValueOnce(new Error('down'));
      const client = new SignalingClient();
      await client.fetchIceConfig();

      expect(client.iceConfigSource).toBe('fallback');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(relayResponse),
      } as Response);

      vi.advanceTimersByTime(6 * 60 * 1000);

      await client.refreshIfNeeded();
      expect(client.iceConfigSource).toBe('relay');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('refreshIfNeeded does NOT re-fetch when within TTL', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(relayResponse),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.iceConfigSource).toBe('relay');

      vi.advanceTimersByTime(60 * 1000);

      const config = await client.refreshIfNeeded();
      expect(config).not.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('source tracking', () => {
    it('reports "relay" from /turn-credentials', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(relayResponse),
      } as Response);

      const client = new SignalingClient();
      expect(client.iceConfigSource).toBeNull();

      await client.fetchIceConfig();
      expect(client.iceConfigSource).toBe('relay');
    });

    it('reports "fallback" when relay API is unreachable', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockRejectedValueOnce(new Error('offline'));

      const client = new SignalingClient();
      await client.fetchIceConfig();

      expect(client.iceConfigSource).toBe('fallback');
      expect(client.iceConfig).not.toBeNull();
    });

    it('source is null before first fetch', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      const client = new SignalingClient();
      expect(client.iceConfigSource).toBeNull();
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Part 2: TURN Validation — uses vi.importActual for real SignalingClient
// ════════════════════════════════════════════════════════════════

describe('TURN validation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('STUN-only config', () => {
    it('returns false when ICE servers are STUN-only', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
          iceCandidatePoolSize: 2,
          ttl: 3600,
        }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(false);
    });

    it('returns false when relay API fails (STUN fallback)', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockRejectedValueOnce(new Error('down'));

      const client = new SignalingClient();
      await client.fetchIceConfig();

      expect(client.iceConfigSource).toBe('fallback');
      expect(client.hasTurn).toBe(false);
    });
  });

  describe('TURN servers with credentials', () => {
    it('returns true when TURN has username + credential', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:turn.example.com:3478', username: 'turnuser', credential: 'turnpass' },
          ],
          ttl: 3600,
        }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(true);
    });

    it('returns true with turns: scheme', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          iceServers: [{ urls: 'turns:turn.example.com:5349', username: 'u', credential: 'c' }],
        }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(true);
    });
  });

  describe('TURN servers without credentials', () => {
    it('returns false when TURN has no credentials at all', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:turn.example.com:3478' },
          ],
          ttl: 3600,
        }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(false);
    });

    it('returns false when TURN has username but no credential', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'turnuser' }],
        }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('hasTurn false when iceConfig is null', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      const client = new SignalingClient();
      expect(client.hasTurn).toBe(false);
    });

    it('hasTurn false for empty iceServers', async () => {
      const { SignalingClient } = await vi.importActual<typeof import('../../src/shell/signaling-client')>('../../src/shell/signaling-client');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ iceServers: [], ttl: 3600 }),
      } as Response);

      const client = new SignalingClient();
      await client.fetchIceConfig();
      expect(client.hasTurn).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Part 3: rotateInvite — uses static mock of signaling-client
// ════════════════════════════════════════════════════════════════

describe('rotateInvite', () => {
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

  describe('generates new token', () => {
    it('returns true on success and updates shareUrl', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');

      const oldToken = ctrl.token;
      expect(oldToken).toBeTruthy();
      expect(ctrl.shareUrl).toBeTruthy();

      const result = await ctrl.rotateInvite();

      expect(result).toBe(true);
      expect(ctrl.token).toBeTruthy();
      expect(ctrl.token).not.toBe(oldToken);
    });

    it('fires onInviteChanged with new token and share URL', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      const inviteChangedCalls: [string, string][] = [];
      ctrl.onInviteChanged = (token, shareUrl) => inviteChangedCalls.push([token, shareUrl]);

      await ctrl.createRoom('host@test.com');
      await ctrl.rotateInvite();

      expect(inviteChangedCalls.length).toBe(1);
      expect(inviteChangedCalls[0][0]).toBe(ctrl.token);
      expect(inviteChangedCalls[0][1]).toBe(ctrl.shareUrl);
    });
  });

  describe('relay mode', () => {
    it('calls store-offer-next via signaling.request', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');

      const sig = (ctrl as any).signaling;
      sig.request.mockClear();

      await ctrl.rotateInvite();

      const storeNextCall = sig.request.mock.calls.find(
        (call: any[]) => call[0]?.type === 'store-offer-next'
      );
      expect(storeNextCall).toBeDefined();
      expect(storeNextCall[0].roomId).toBeTruthy();
      expect(storeNextCall[0].sdp).toBeTruthy();
    });
  });

  describe('manual mode', () => {
    it('generates manual-style share URL when no relay (no roomId)', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      const sig = (ctrl as any).signaling;
      sig.connect.mockRejectedValueOnce(new Error('relay down'));

      await ctrl.createRoom('host@test.com');
      (ctrl as any)._roomId = '';

      const result = await ctrl.rotateInvite();
      expect(result).toBe(true);
      expect(ctrl.shareUrl).toMatch(/^https:\/\/app\.example\.com\/#offer=/);
      expect(ctrl.shareUrl).toContain('&sdp=');
    });

    it('fires onInviteChanged in manual mode', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      const sig = (ctrl as any).signaling;
      sig.connect.mockRejectedValueOnce(new Error('relay down'));

      const inviteChangedCalls: [string, string][] = [];
      ctrl.onInviteChanged = (token, shareUrl) => inviteChangedCalls.push([token, shareUrl]);

      await ctrl.createRoom('host@test.com');
      (ctrl as any)._roomId = '';

      await ctrl.rotateInvite();

      expect(inviteChangedCalls.length).toBe(1);
      expect(inviteChangedCalls[0][1]).toMatch(/^https:\/\/app\.example\.com\/#offer=/);
    });
  });

  describe('idempotent', () => {
    it('returns false when rotation already in progress', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');
      (ctrl as any)._rotateInProgress = true;

      expect(await ctrl.rotateInvite()).toBe(false);
    });

    it('resets guard after completion so second call succeeds', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');

      expect(await ctrl.rotateInvite()).toBe(true);
      expect((ctrl as any)._rotateInProgress).toBe(false);
      expect(await ctrl.rotateInvite()).toBe(true);
    });

    it('returns false when not host', async () => {
      const ctrl = new SessionController();
      expect(await ctrl.rotateInvite()).toBe(false);
    });

    it('returns false when room is null', async () => {
      const ctrl = new SessionController();
      (ctrl as any)._isHost = true;
      (ctrl as any).room = null;
      expect(await ctrl.rotateInvite()).toBe(false);
    });

    it('resets guard even on failure', async () => {
      const ctrl = new SessionController();
      ctrl.onLog = vi.fn();
      ctrl.getEmail = () => 'host@test.com';

      await ctrl.createRoom('host@test.com');

      const room = (ctrl as any).room;
      room.offerUrl.mockRejectedValueOnce(new Error('offer failed'));

      expect(await ctrl.rotateInvite()).toBe(false);
      expect((ctrl as any)._rotateInProgress).toBe(false);
    });
  });
});