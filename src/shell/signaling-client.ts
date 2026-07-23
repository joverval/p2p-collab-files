// Signaling client v2 — permanent WS router with requestId + event subscriptions

import type { IceConfigProvider, OutgoingSignalMessage, IncomingSignalMessage, ErrorMessage, SignalingResponse } from '../shared/types';

const WS_URL = import.meta.env.VITE_SIGNAL_WS_URL || 'wss://relay.joverval.cl/ws';
const HTTP_URL = import.meta.env.VITE_SIGNAL_HTTP_URL || 'https://relay.joverval.cl';

export type WsFactory = (url: string) => WebSocket;

const DEFAULT_WS_FACTORY: WsFactory = (url) => new WebSocket(url);

export class SignalingClient implements IceConfigProvider {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: SignalingResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, Set<(msg: IncomingSignalMessage) => void>>();
  private _iceConfig: RTCConfiguration | null = null;
  private _iceConfigExpiry = 0; // epoch ms when credentials expire
  private wsFactory: WsFactory;

  constructor(wsFactory: WsFactory = DEFAULT_WS_FACTORY) {
    this.wsFactory = wsFactory;
  }

  /** Validate that an incoming message has required fields for its type. Logs invalid messages. */
  static validateMessage(msg: unknown): msg is IncomingSignalMessage {
    if (!msg || typeof msg !== 'object') { console.warn('[signaling] invalid message — not an object', msg); return false; }
    const m = msg as Record<string, unknown>;
    if (!m.type || typeof m.type !== 'string') { console.warn('[signaling] invalid message — missing type', msg); return false; }
    // Validate known message types
    switch (m.type) {
      case 'peer-request':
        if (!m.email || !m.token || !m.offerId || !m.answerB64) {
          console.warn('[signaling] invalid peer-request — missing required fields', msg);
          return false;
        }
        break;
      case 'approved':
        // no required fields beyond type
        break;
      case 'promotion-request':
        if (!m.oldHostEmail || !m.roomId || !m.promotionId) {
          console.warn('[signaling] invalid promotion-request — missing required fields', msg);
          return false;
        }
        break;
      case 'new-host':
        if (!m.hostEmail || !m.token) {
          console.warn('[signaling] invalid new-host — missing required fields', msg);
          return false;
        }
        break;
    }
    return true;
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.wsFactory(WS_URL);
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
      s.onopen = () => { clearTimeout(timer); this.ws = s; resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
      s.onclose = () => { this.ws = null; };
      s.onmessage = (e) => {
        try {
          const m: unknown = JSON.parse(e.data);
          if (SignalingClient.validateMessage(m)) this.dispatch(m);
        } catch { /* malformed JSON — ignore */ }
      };
    });
  }

  /** Apply VITE_ICE_MODE override to an RTCConfiguration. Extracted so it can be used in both relay API and fallback paths. */
  private applyIceMode(config: RTCConfiguration): RTCConfiguration {
    const iceMode = (import.meta as any).env?.VITE_ICE_MODE || 'all';
    if (iceMode === 'stun-only') {
      config.iceServers = (config.iceServers || [])
        .map(server => ({
          ...server,
          urls: Array.isArray(server.urls)
            ? server.urls.filter(u => typeof u === 'string' && u.startsWith('stun:'))
            : (typeof server.urls === 'string' && server.urls.startsWith('stun:') ? server.urls : []),
        }))
        .filter(server => {
          const urls = server.urls;
          return Array.isArray(urls) ? urls.length > 0 : urls !== '';
        });
      config.iceTransportPolicy = 'all';
    } else if (iceMode === 'turn-only') {
      config.iceTransportPolicy = 'relay';
    }
    // 'all' (default): no modification
    return config;
  }

  /** Fetch ICE servers from relay HTTP API. Cached — only fetches once per session. Tracks TTL from API response. */
  async fetchIceConfig(): Promise<RTCConfiguration> {
    if (this._iceConfig) return this._iceConfig;
    try {
      const resp = await fetch(`${HTTP_URL}/turn-credentials`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const config: RTCConfiguration = {
        iceServers: data.iceServers || [],
        iceCandidatePoolSize: data.iceCandidatePoolSize ?? 2,
        iceTransportPolicy: (data.iceTransportPolicy as RTCIceTransportPolicy) || 'all',
      };
      this._iceConfig = this.applyIceMode(config);
      // Track TTL from API response (default 3600s) to support refreshIfNeeded
      const ttlSeconds = data.ttl ?? 3600;
      this._iceConfigExpiry = Date.now() + ttlSeconds * 1000;
    } catch {
      // Fallback if relay API is unavailable — STUN only, no TURN
      const config: RTCConfiguration = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
        iceCandidatePoolSize: 2,
        iceTransportPolicy: 'all',
      };
      this._iceConfig = this.applyIceMode(config);
      this._iceConfigExpiry = Infinity; // STUN-only never expires
    }
    return this._iceConfig;
  }

  /** Re-fetch ICE config if within 5 minutes of credential expiry. */
  async refreshIfNeeded(): Promise<RTCConfiguration> {
    const fiveMin = 5 * 60 * 1000;
    if (Date.now() + fiveMin >= this._iceConfigExpiry) {
      this._iceConfig = null; // force re-fetch
      return this.fetchIceConfig();
    }
    return this._iceConfig!;
  }

  /** IceConfigProvider: get current config (may be null if never fetched). */
  async getConfig(): Promise<RTCConfiguration> {
    return this._iceConfig ?? this.fetchIceConfig();
  }

  get iceConfig(): RTCConfiguration | null { return this._iceConfig; }

  /** Count of active event subscribers (for test diagnostics). */
  get listenerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }

  private dispatch(m: IncomingSignalMessage) {
    const reqId = m.requestId;
    // Resolve pending request — every response with requestId is a SignalingResponse
    if (reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      if (m.type === 'error') { p.reject(new Error((m as ErrorMessage).message)); return; }
      p.resolve(m as SignalingResponse);
      return;
    }
    // Dispatch to event subscribers
    const subs = this.handlers.get(m.type);
    if (subs) subs.forEach(h => h(m));
  }

  /** Send a typed request and wait for a response.
   *  Returns SignalingResponse which has `requestId` + arbitrary response data. */
  request(msg: OutgoingSignalMessage, timeoutMs = 10000): Promise<SignalingResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('Not connected')); return; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  /** Send a message without expecting a response. */
  send(msg: OutgoingSignalMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Subscribe to a message type. Returns an unsubscribe function.
   *  Use the generic parameter `T` to narrow handler type when you know the exact message shape. */
  on<T extends IncomingSignalMessage = IncomingSignalMessage>(type: string, handler: (msg: T) => void): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const typedHandler = handler as (msg: IncomingSignalMessage) => void;
    this.handlers.get(type)!.add(typedHandler);
    return () => this.handlers.get(type)?.delete(typedHandler);
  }

  /** Reject all pending requests and close the WebSocket. Safe to call multiple times. */
  close(): void {
    // Reject every pending request so callers don't hang on a dead connection
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Signaling closed'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }
}