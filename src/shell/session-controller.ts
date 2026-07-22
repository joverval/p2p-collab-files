// Session controller — room creation, joining, failover, signaling
// Extracted from main.ts createRoom / peerAutoJoin / becomeHost

import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import { encodeChat, encodeYjs, decodeMessage } from './protocol/message-envelope';
import type { Participant } from './participants/participants-controller';

const WS_URL = 'wss://relay.joverval.cl';

export class SessionController {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private _token = '';
  private _currentOfferId = '';
  private _shareUrl = '';
  private _baseUrl: string;

  // Callbacks set by app.ts
  onLog?: (type: string, text: string) => void;
  onStatus?: (state: 'disconnected'|'connecting'|'connected'|'error', text: string) => void;
  onPendingRequest?: (email: string, token: string, offerId?: string, answerB64?: string) => () => void;
  onConnected?: (route: string) => void;
  onPeerJoin?: (peerEmail: string) => void;
  onPeerLeave?: (email: string) => void;
  onFeatureData?: (data: Uint8Array, peerId: string) => void;
  onControlMessage?: (text: string) => void;
  onChatMessage?: (sender: string, text: string) => void;
  onRoomState?: (peers: Participant[], token: string) => void;
  getEmail?: () => string;
  getIsHost?: () => boolean;
  getIsConnected?: () => boolean;
  setConnected?: (v: boolean) => void;

  constructor() {
    this._baseUrl = window.location.href.split('#')[0];
  }

  get token(): string { return this._token; }
  get shareUrl(): string { return this._shareUrl; }
  get currentOfferId(): string { return this._currentOfferId; }
  get roomRef(): Room | null { return this.room; }
  set pendingPeerEmail(e: string) { /* handled externally */ }

  // ── Signaling ──
  async wsConnect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(WS_URL);
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 3000);
      s.onopen = () => { clearTimeout(timer); this.ws = s; resolve(s); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
      s.onclose = () => { this.ws = null; };
    });
  }

  // ── Host: create room ──
  async createRoom(email: string): Promise<boolean> {
    this.onLog?.('system', 'Creating room...');
    let useRelay = false;
    try {
      await this.wsConnect();
      useRelay = true;
    } catch { this.onLog?.('system', '⚠️ Relay unavailable — manual mode'); }

    const r = new P2PRoom(true, this._baseUrl, {
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      onPeerLeave: (peerId: string) => {
        const email = (this as any)._peerEmails?.get(peerId) || peerId;
        this.onPeerLeave?.(email);
      },
    });
    const { url, offerId } = await r.offerUrl();
    this._currentOfferId = offerId;
    this.room = r;
    const sdpB64 = url.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      this._token = await new Promise<string>(resolve => {
        this.ws!.onmessage = e => {
          const m = JSON.parse(e.data);
          if (m.type === 'token') resolve(m.token);
        };
        this.ws!.send(JSON.stringify({ type: 'store-offer', sdp: sdpB64, offerId }));
      });
      this._shareUrl = `${this._baseUrl}#${this._token}`;
    } else {
      this._shareUrl = `${this._baseUrl}#offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`;
    }

    if (useRelay) {
      this.ws!.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.type === 'peer-request') {
          this.onLog?.('system', `📩 ${m.email} wants to join`);
          this.onPendingRequest?.(m.email, m.token || '', m.offerId, m.answerB64);
        }
      };
    }

    // Message handler
    r.onMessage((data, peerId) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') {
        this.onFeatureData?.(data, peerId);
        r.broadcastExcept(data, peerId);
      } else {
        const sender = (this as any)._peerEmails?.get(peerId) || peerId;
        // Control messages
        if (d.text.startsWith('[EMAIL]')) {
          const pe = d.text.slice(7);
          (this as any)._peerEmails?.set(peerId, pe);
        } else if (d.text.startsWith('[ROOM]')) {
          try { const rd = JSON.parse(d.text.slice(5)); this.onRoomState?.(rd.peers, rd.token); } catch {}
          r.broadcastExcept(encodeChat(d.text), undefined);
        } else if (d.text.startsWith('[SYNC]') || d.text.startsWith('[FILENAME]')) {
          this.onControlMessage?.(d.text);
        } else if (d.text.startsWith('[CHKSUM]')) {
          // ignore
        } else {
          this.onChatMessage?.(sender, d.text);
          r.broadcastExcept(encodeChat(`${sender}: ${d.text}`), undefined);
        }
      }
    });

    r.onPeerJoin(async (peerId) => {
      const pe = (this as any)._pendingPeerEmail || peerId;
      (this as any)._peerEmails?.set(peerId, pe);
      this.setConnected?.(true);
      this.onPeerJoin?.(pe);
      // Generate new offer for next peer
      try {
        const { url: nu, offerId: noi } = await r.offerUrl();
        this._currentOfferId = noi;
        const nuSdpB64 = nu.match(/#sdp=(.*)/)?.[1] || '';
        if (useRelay) {
          this._token = await new Promise<string>(resolve => {
            const tmp = this.ws!.onmessage;
            this.ws!.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'token') { this.ws!.onmessage = tmp; resolve(m.token); } };
            this.ws!.send(JSON.stringify({ type: 'store-offer-next', sdp: nuSdpB64, offerId: noi }));
          });
          this._shareUrl = `${this._baseUrl}#${this._token}`;
        } else {
          this._shareUrl = `${this._baseUrl}#offer=${noi}&sdp=${encodeURIComponent(nuSdpB64)}`;
        }
      } catch (err: any) { this.onLog?.('system', `ERROR: ${err.message}`); }
    });

    return useRelay;
  }

  // ── Host: accept answer (manual mode) ──
  acceptAnswer(signalUrl: string) {
    const m = signalUrl.match(/#sdp=(.*)/);
    const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
    this.room?.acceptAnswer(this._currentOfferId, `#sdp=${b64}`);
  }

  // ── Host: approve / reject ──
  approvePeer(token: string) {
    this.ws?.send(JSON.stringify({ type: 'host-approve', token }));
  }

  rejectPeer(token: string) {
    this.ws?.send(JSON.stringify({ type: 'host-reject', token }));
  }

  // ── Peer: parse URL ──
  parseRoomFromUrl(): string | null {
    const h = window.location.hash;
    if (!h) return null;
    const m = h.match(/^#([a-zA-Z0-9_-]+)$/);
    if (m) return m[1];
    const m2 = h.match(/^#offer=([^&]+)&sdp=(.+)$/);
    if (m2) return `manual:${m2[1]}:${decodeURIComponent(m2[2])}`;
    return null;
  }

  // ── Peer: join room ──
  async peerAutoJoin(parsed: string, email: string): Promise<'relay' | 'manual' | 'error'> {
    let useRelay = false, offerB64 = '', offerId = '';
    const isToken = !parsed.startsWith('manual:');

    if (isToken) {
      try { await this.wsConnect(); useRelay = true; } catch {}
      if (useRelay) {
        const data: any = await new Promise((resolve, reject) => {
          this.ws!.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'offer') resolve(m); if (m.type === 'error') reject(new Error(m.message)); };
          this.ws!.send(JSON.stringify({ type: 'fetch-offer', token: parsed }));
          setTimeout(() => reject(new Error('timeout')), 5000);
        });
        offerB64 = data.sdp; offerId = data.offerId;
      }
    } else {
      const parts = parsed.split(':');
      offerId = parts[1]; offerB64 = parts[2];
    }

    const peer = new P2PRoom(false, this._baseUrl, {
      onConnect: () => { import('./connection-diagnostics').then(m => m.getConnectionRoute(peer).then(r => this.onConnected?.(r))); },
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
    });
    const answerUrl = await peer.connectToHost(`${this._baseUrl}#sdp=${offerB64}`);
    this.room = peer;
    const answerB64 = answerUrl.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay && isToken) {
      this.ws!.send(JSON.stringify({ type: 'submit-answer', token: parsed, email, answerB64 }));
      this.onLog?.('system', 'Waiting for host approval...');
      this.ws!.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.type === 'approved') {
          this.setConnected?.(true);
          this.ws!.onmessage = e2 => {
            const m2 = JSON.parse(e2.data);
            if (m2.type === 'new-host') {
              this.onLog?.('system', `🔄 New host: ${m2.hostEmail} — reconnecting...`);
              // Reconnection logic (simplified)
            }
          };
        } else if (m.type === 'rejected') {
          this.onLog?.('system', `❌ Rejected: ${m.message}`);
        }
      };
    }

    // Peer message handler
    peer.onMessage((data) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') {
        this.onFeatureData?.(data, 'host');
      } else {
        if (d.text.startsWith('[USERS]')) {
          try { const ud = JSON.parse(d.text.slice(7)); } catch {}
        } else if (d.text.startsWith('[ROOM]')) {
          try { const rd = JSON.parse(d.text.slice(5)); this.onRoomState?.(rd.peers, rd.token); } catch {}
        } else if (d.text.startsWith('[FILENAME]')) {
          this.onControlMessage?.(d.text);
        } else if (d.text.startsWith('[CHKSUM]')) {
          // ignore
        } else if (d.text.startsWith('[PROMOTE]')) {
          this.onControlMessage?.(d.text);
        } else {
          this.onChatMessage?.('Host', d.text);
        }
      }
    });

    return useRelay && isToken ? 'relay' : 'manual';
  }

  // ── Shared ──
  sendFeature(data: Uint8Array) {
    this.room?.send(data);
  }

  sendControl(msg: string) {
    this.room?.send(encodeChat(msg));
  }

  close() {
    this.room?.close();
    this.ws?.close();
  }
}