// Signaling client v2 — permanent WS router with requestId + event subscriptions

const WS_URL = 'wss://relay.joverval.cl';
const HTTP_URL = 'https://relay.joverval.cl';

export class SignalingClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private handlers = new Map<string, Set<(msg: any) => void>>();
  private connected = false;
  private _iceConfig: RTCConfiguration | null = null;

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(WS_URL);
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
      s.onopen = () => { clearTimeout(timer); this.ws = s; this.connected = true; resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
      s.onclose = () => { this.ws = null; this.connected = false; };
      s.onmessage = (e) => {
        try { const m = JSON.parse(e.data); this.dispatch(m); } catch {}
      };
    });
  }

  /** Fetch ICE servers from relay HTTP API. Cached — only fetches once per session. */
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
    }
    return this._iceConfig;
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