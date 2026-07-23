// tests/unit/signaling/signaling-client.test.ts
// Tests C.1–C.11: SignalingClient with FakeWebSocket injection

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SignalingClient, type WsFactory } from '../../../src/shell/signaling-client';

// ── FakeWebSocket ──────────────────────────────────────────────

type FakeWSEventHandler = (ev?: any) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState: number = 0; // CONNECTING
  onopen: FakeWSEventHandler | null = null;
  onclose: FakeWSEventHandler | null = null;
  onerror: FakeWSEventHandler | null = null;
  onmessage: FakeWSEventHandler | null = null;

  sent: string[] = [];

  // Allow test to reference the instance so it can simulate events
  static instances: FakeWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  // Methods the test calls to simulate server behavior:
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ type: 'open' });
  }

  simulateError() {
    this.onerror?.({ type: 'error' });
  }

  simulateClose(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', type: 'close' });
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data), type: 'message' });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

// ── Helpers ────────────────────────────────────────────────────

function createClient(factory?: WsFactory) {
  // Reset instance tracking
  FakeWebSocket.instances = [];
  const wsFactory: WsFactory = factory ?? ((url) => new FakeWebSocket(url) as unknown as WebSocket);
  const client = new SignalingClient(wsFactory);
  return { client, factory: wsFactory, lastWs: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] };
}

describe('SignalingClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── C.1 Connection success ──────────────────────────────────
  describe('C.1 — Connection success', () => {
    it('resolves when WebSocket opens', async () => {
      const { client, lastWs } = createClient();
      const promise = client.connect(5000);
      lastWs().simulateOpen();
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ── C.2 Connection failure ──────────────────────────────────
  describe('C.2 — Connection failure', () => {
    it('rejects on WebSocket error', async () => {
      const { client, lastWs } = createClient();
      const promise = client.connect(5000);
      lastWs().simulateError();
      await expect(promise).rejects.toThrow('WS connection failed');
    });
  });

  // ── C.3 Connection timeout ──────────────────────────────────
  describe('C.3 — Connection timeout', () => {
    it('rejects after timeout', async () => {
      const { client } = createClient();
      const promise = client.connect(100);
      vi.advanceTimersByTime(101);
      await expect(promise).rejects.toThrow('timeout');
    });
  });

  // ── C.4 Request IDs are unique ──────────────────────────────
  describe('C.4 — Request IDs are unique', () => {
    it('each request gets a unique ID', async () => {
      const { client, lastWs } = createClient();

      // Connect first
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const ids = new Set<string>();
      // Fire several requests and capture the IDs from sent data
      const req1 = client.request({ type: 'test' });
      const req2 = client.request({ type: 'test' });
      const req3 = client.request({ type: 'test' });

      // Resolve them so they don't timeout
      for (const msg of lastWs().sent) {
        const parsed = JSON.parse(msg);
        ids.add(parsed.requestId);
        // Simulate response to clean up
        lastWs().simulateMessage({ type: 'ok', requestId: parsed.requestId });
      }

      await Promise.all([req1, req2, req3]);
      expect(ids.size).toBe(3);
    });
  });

  // ── C.5 Responses resolve only matching request ─────────────
  describe('C.5 — Responses resolve only matching request', () => {
    it('response with matching requestId resolves that request', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const req1 = client.request({ type: 'ping' });
      const req2 = client.request({ type: 'ping' });

      // Parse sent messages
      const msg1 = JSON.parse(lastWs().sent[0]);
      const msg2 = JSON.parse(lastWs().sent[1]);

      // Resolve req2 first
      lastWs().simulateMessage({ type: 'pong', requestId: msg2.requestId });
      const result2 = await req2;
      expect(result2.type).toBe('pong');

      // req1 should not be resolved yet
      // Resolve req1
      lastWs().simulateMessage({ type: 'pong', requestId: msg1.requestId });
      const result1 = await req1;
      expect(result1.type).toBe('pong');
    });

    it('response with wrong requestId does not resolve', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      let resolved = false;
      const reqPromise = client.request({ type: 'ping' }, 500);
      reqPromise.then(() => { resolved = true; }).catch(() => {});

      // Get the correct requestId from sent data
      const parsed = JSON.parse(lastWs().sent[0]);
      const correctId = parsed.requestId;

      // Send a response with a different requestId — should NOT resolve
      lastWs().simulateMessage({ type: 'pong', requestId: 'wrong-id' });

      // Advance past microtasks but not past timeout
      await vi.advanceTimersByTimeAsync(100);
      expect(resolved).toBe(false);

      // Now resolve correctly
      lastWs().simulateMessage({ type: 'pong', requestId: correctId });
      const result = await reqPromise;
      expect(result.type).toBe('pong');
    });
  });

  // ── C.6 Unsolicited events go to subscribers ────────────────
  describe('C.6 — Unsolicited events go to subscribers', () => {
    it('event without requestId is dispatched to subscribers', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const events: any[] = [];
      client.on('peer-joined', (msg) => events.push(msg));

      lastWs().simulateMessage({ type: 'peer-joined', peerId: 'abc' });

      expect(events.length).toBe(1);
      expect(events[0].peerId).toBe('abc');
    });

    it('multiple subscribers all receive the event', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const results1: any[] = [];
      const results2: any[] = [];
      client.on('chat', (msg) => results1.push(msg));
      client.on('chat', (msg) => results2.push(msg));

      lastWs().simulateMessage({ type: 'chat', text: 'hello' });

      expect(results1.length).toBe(1);
      expect(results2.length).toBe(1);
      expect(results1[0].text).toBe('hello');
      expect(results2[0].text).toBe('hello');
    });
  });

  // ── C.7 Error response rejects request ──────────────────────
  describe('C.7 — Error response rejects request', () => {
    it('message with type=error rejects the pending request', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const req = client.request({ type: 'bad-action' });
      const parsed = JSON.parse(lastWs().sent[0]);

      lastWs().simulateMessage({ type: 'error', requestId: parsed.requestId, message: 'something went wrong' });

      await expect(req).rejects.toThrow('something went wrong');
    });
  });

  // ── C.8 Timeout removes pending state ───────────────────────
  describe('C.8 — Timeout removes pending state', () => {
    it('request timeout rejects and removes pending entry', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const req = client.request({ type: 'slow' }, 50);
      vi.advanceTimersByTime(51);

      await expect(req).rejects.toThrow('timeout');

      // After timeout, a late response with that requestId should be treated as unsolicited
      const lateEvents: any[] = [];
      client.on('slow-response', (msg) => lateEvents.push(msg));

      const parsed = JSON.parse(lastWs().sent[0]);
      lastWs().simulateMessage({ type: 'slow-response', requestId: parsed.requestId });

      expect(lateEvents.length).toBe(1);
    });
  });

  // ── C.9 Close rejects all pending requests ──────────────────
  describe('C.9 — Close rejects all pending requests', () => {
    it('close() rejects all outstanding requests', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const req1 = client.request({ type: 'task1' });
      const req2 = client.request({ type: 'task2' });

      client.close();

      // All pending requests are rejected immediately
      await expect(req1).rejects.toThrow('Signaling closed');
      await expect(req2).rejects.toThrow('Signaling closed');

      // New requests should fail with 'Not connected'
      await expect(client.request({ type: 'task3' })).rejects.toThrow('Not connected');
    });
  });

  // ── C.10 Unsubscribe removes handlers ───────────────────────
  describe('C.10 — Unsubscribe removes handlers', () => {
    it('returned unsubscribe function removes the handler', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const events: any[] = [];
      const unsub = client.on('update', (msg) => events.push(msg));

      lastWs().simulateMessage({ type: 'update', data: 'first' });
      expect(events.length).toBe(1);

      // Unsubscribe
      unsub();

      lastWs().simulateMessage({ type: 'update', data: 'second' });
      expect(events.length).toBe(1); // Still 1, not incremented
    });
  });

  // ── C.11 Repeated reconnect does not duplicate handlers ─────
  describe('C.11 — Repeated reconnect does not duplicate handlers', () => {
    it('connecting multiple times does not attach duplicate onmessage handlers', async () => {
      const { client } = createClient();

      // Connect first time
      let connPromise = client.connect();
      FakeWebSocket.instances[0].simulateOpen();
      await connPromise;

      const events: any[] = [];
      client.on('notification', (msg) => events.push(msg));

      // Close and reconnect
      client.close();
      connPromise = client.connect();
      FakeWebSocket.instances[1].simulateOpen();
      await connPromise;

      // Send a notification through the new WebSocket
      FakeWebSocket.instances[1].simulateMessage({ type: 'notification', value: 42 });

      expect(events.length).toBe(1); // Only one handler fire, not duplicated
      expect(events[0].value).toBe(42);
    });
  });

  // ── C.12 Malformed JSON does not crash ──────────────────────
  describe('C.12 — Malformed JSON does not crash', () => {

  // ── C.13 fetchIceConfig caching and refresh ─────────────────
  describe('C.13 — fetchIceConfig caches and refreshes near expiry', () => {
    it('caches ICE config and only re-fetches near expiry', async () => {
      // Override global fetch for this test
      let fetchCalls = 0;
      const originalFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          iceCandidatePoolSize: 2,
          iceTransportPolicy: 'all',
          ttl: 3600,
        }),
      });

      try {
        const { client, lastWs } = createClient();
        const connPromise = client.connect();
        lastWs().simulateOpen();
        await connPromise;

        // First call: should fetch
        const config1 = await client.fetchIceConfig();
        expect(config1.iceServers).toBeDefined();
        expect(config1.iceServers!.length).toBeGreaterThan(0);

        // Second call: should use cache (no fetch)
        const config2 = await client.fetchIceConfig();
        expect(config2).toBe(config1); // same reference = cached

        // refreshIfNeeded before expiry: should return cached
        const config3 = await client.refreshIfNeeded();
        expect(config3).toBe(config1);

        // Advance time past the refresh threshold (5 min before expiry = 55 min after fetch)
        // TTL is 3600s, refresh threshold is 300s, so at 3301s it should re-fetch
        vi.advanceTimersByTime(3301 * 1000);

        // Now refreshIfNeeded should re-fetch (but fetchIceConfig still cached until refreshIfNeeded is called)
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            iceServers: [{ urls: 'stun:stun2.l.google.com:19302' }],
            iceCandidatePoolSize: 2,
            iceTransportPolicy: 'all',
            ttl: 3600,
          }),
        });

        const config4 = await client.refreshIfNeeded();
        // Should have re-fetched with new servers
        const servers = config4.iceServers as { urls: string }[];
        expect(servers[0].urls).toBe('stun:stun2.l.google.com:19302');
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    });

    it('fetchIceConfig falls back to STUN on HTTP failure', async () => {
      const originalFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      try {
        const { client, lastWs } = createClient();
        const connPromise = client.connect();
        lastWs().simulateOpen();
        await connPromise;

        const config = await client.fetchIceConfig();
        // Should have fallback STUN servers
        expect(config.iceServers).toBeDefined();
        expect(config.iceServers!.length).toBeGreaterThan(0);
        const stunUrls = config.iceServers!.map((s: any) => {
          const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
          return urls.filter((u: string) => u.startsWith('stun:'));
        }).flat();
        expect(stunUrls.length).toBeGreaterThan(0);
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    });
  });
    it('invalid JSON in onmessage is caught silently', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      // This should not throw
      expect(() => {
        lastWs().simulateMessage('not valid json {{{');
      }).not.toThrow();
    });

    it('null/undefined messages do not crash', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      expect(() => {
        lastWs().simulateMessage(null);
      }).not.toThrow();

      expect(() => {
        lastWs().simulateMessage(undefined);
      }).not.toThrow();
    });

    it('messages missing type field are validated and ignored', async () => {
      const { client, lastWs } = createClient();
      const connPromise = client.connect();
      lastWs().simulateOpen();
      await connPromise;

      const events: any[] = [];
      client.on('something', (msg) => events.push(msg));

      // This should not dispatch to subscribers due to validateMessage
      lastWs().simulateMessage({ foo: 'bar' });

      expect(events.length).toBe(0);
    });

    it('validateMessage rejects non-object messages', () => {
      expect(SignalingClient.validateMessage(null)).toBe(false);
      expect(SignalingClient.validateMessage(undefined)).toBe(false);
      expect(SignalingClient.validateMessage('string')).toBe(false);
      expect(SignalingClient.validateMessage(42)).toBe(false);
    });
  });

  // ── fetchIceConfig caching (C.11) ──
  describe('fetchIceConfig caching', () => {
    it('caches ICE config and only fetches once', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] }),
      });

      const client = new SignalingClient(() => new FakeWebSocket('wss://test') as unknown as WebSocket);
      const config1 = await client.fetchIceConfig();
      const config2 = await client.fetchIceConfig();

      // Second call returns cached, no second fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(config1).toBe(config2); // same object reference
      expect(config1.iceServers).toBeDefined();
    });

    it('refreshIfNeeded does not refetch when TTL is far away', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ iceServers: [{ urls: 'stun:stun.example.com:3478' }], ttl: 86400 }),
      });

      const client = new SignalingClient(() => new FakeWebSocket('wss://test') as unknown as WebSocket);
      await client.fetchIceConfig();
      await client.refreshIfNeeded();

      // TTL is 86400s away, so no refetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});