// Signaling client v2 — permanent WS router with requestId + event subscriptions

import type { IceConfigProvider } from '../shared/types';

const WS_URL = import.meta.env.VITE_SIGNAL_WS_URL || 'wss://relay.joverval.cl';
const HTTP_URL = import.meta.env.VITE_SIGNAL_HTTP_URL || 'https://relay.joverval.cl';

export class SignalingClient implements IceConfigProvider {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private handlers = new Map<string, Set<(msg: any) => void>>();
  private connected = false;
  private _iceConfig: RTCConfiguration | null = null;
  private _iceConfigExpiry = 0; // epoch ms when credentials expire

  /** Validate that an incoming message has required fields for its type. Logs invalid messages. */
  static validateMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') { console.warn('[signaling] invalid message — not an object', msg); return false; }
    if (!msg.type) { console.warn('[signaling] invalid message — missing type', msg); return false; }
    // Validate known message types
    switch (msg.type) {
      case 'peer-request':
        if (!msg.email || !msg.token || !msg.offerId || !msg.answerB64) {
          console.warn('[signaling] invalid peer-request — missing required fields', msg);
          return false;
        }
        break;
      case 'approved':
        // no required fields beyond 'type'
        break;
      case 'promotion-request':
        if (!msg.oldHostEmail || !msg.roomId || !msg.promotionId) {
          console.warn('[signaling] invalid promotion-request — missing required fields', msg);
          return false;
        }
        break;
      case 'new-host':
        if (!msg.hostEmail || !msg.token) {
          console.warn('[signaling] invalid new-host — missing required fields', msg);
          return false;
        }
        break;
    }
    return true;
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(WS_URL);
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
      s.onopen = () => { clearTimeout(timer); this.ws = s; this.connected = true; resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
      s.onclose = () => { this.ws = null; this.connected = false; };
      s.onmessage = (e) => {
        try { const m = JSON.parse(e.data); if (SignalingClient.validateMessage(m)) this.dispatch(m); } catch {}
      };
    });
  }

  /** Fetch ICE servers from relay HTTP API. Cached — only fetches once per session. Tracks TTL from API response. */
  async fetchIceConfig(): Promise<RTCConfiguration> {
    if (this._iceConfig) return this._iceConfig;
    try {
      const resp = await fetch(`${HTTP_URL}/turn-credentials`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._iceConfig = {
        iceServers: data.iceServers || [],
        iceCandidatePoolSize: data.iceCandidatePoolSize ?? 2,
        iceTransportPolicy: (data.iceTransportPolicy as RTCIceTransportPolicy) || 'all',
      };
      // Track TTL from API response (default 3600s) to support refreshIfNeeded
      const ttlSeconds = data.ttl ?? 3600;
      this._iceConfigExpiry = Date.now() + ttlSeconds * 1000;
    } catch {
      // Fallback if relay API is unavailable — STUN only, no TURN
      this._iceConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
        iceCandidatePoolSize: 2,
        iceTransportPolicy: 'all',
      };
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

  private dispatch(m: any) {
    // Resolve pending request
    if (m.requestId && this.pending.has(m.requestId)) {
      const p = this.pending.get(m.requestId)!;
      clearTimeout(p.timer);
      this.pending.delete(m.requestId);
      if (m.type === 'error') { p.reject(new Error(m.message)); return; }
      p.resolve(m);
      return;
    }
    // Dispatch to event subscribers
    const subs = this.handlers.get(m.type);
    if (subs) subs.forEach(h => h(m));
  }

  request<T = any>(msg: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('Not connected')); return; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  send(msg: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(type: string, handler: (msg: any) => void): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  close() { this.ws?.close(); this.ws = null; this.connected = false; }
}