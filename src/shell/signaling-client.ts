// Signaling client — WebSocket relay connection management

const WS_URL = 'wss://relay.joverval.cl';

export class SignalingClient {
  ws: WebSocket | null = null;

  connect(timeoutMs = 3000): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(WS_URL);
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
      s.onopen = () => { clearTimeout(timer); this.ws = s; resolve(s); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
      s.onclose = () => { this.ws = null; };
    });
  }

  send(msg: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: (msg: any) => void) {
    if (this.ws) {
      this.ws.onmessage = (e) => {
        try { handler(JSON.parse(e.data)); } catch {}
      };
    }
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}