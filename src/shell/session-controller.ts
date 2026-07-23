// Session controller v1.2 — room creation, joining, promotion, failover
// Uses SignalingClient for permanent WS router. Separates roomId from offerToken.

import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import { encodeChat, encodeYjs, decodeMessage } from './protocol/message-envelope';
import type { Participant } from './participants/participants-controller';
import { SignalingClient } from './signaling-client';

export class SessionController {
  private signaling = new SignalingClient();
  private room: Room | null = null;
  private nextRoom: Room | null = null;
  private _token = '';
  private _roomId = '';
  private _currentOfferId = '';
  private _shareUrl = '';
  private _baseUrl: string;
  private _peerEmails = new Map<string, string>();
  private _pendingPeerEmail = '';
  private promotionInProgress = false;

  // Callbacks
  onLog?: (type: string, text: string) => void;
  onPendingRequest?: (email: string, token: string, offerId?: string, answerB64?: string) => void;
  onConnected?: (route: string) => void;
  onPeerJoin?: (peerEmail: string) => void;
  onPeerLeave?: (email: string) => void;
  onFeatureData?: (data: Uint8Array, peerId: string) => void;
  onControlMessage?: (text: string) => void;
  onChatMessage?: (sender: string, text: string) => void;
  onRoomState?: (peers: Participant[]) => void;
  onRoleChanged?: (isHost: boolean, hostEmail: string) => void;
  getEmail?: () => string;
  setConnected?: (v: boolean) => void;

  constructor() {
    this._baseUrl = window.location.href.split('#')[0];
  }

  get token(): string { return this._token; }
  get roomId(): string { return this._roomId; }
  get shareUrl(): string { return this._shareUrl; }
  get currentOfferId(): string { return this._currentOfferId; }
  get roomRef(): Room | null { return this.room; }
  get isConnected(): boolean { return this.room !== null; }

  // ── Host: create room ──
  async createRoom(email: string): Promise<boolean> {
    let useRelay = false;
    try { await this.signaling.connect(); useRelay = true; } catch { this.onLog?.('system', '⚠️ Relay unavailable — manual mode'); }

    // Fetch ICE config from relay (STUN first, TURN fallback)
    const rtcConfig = await this.signaling.fetchIceConfig();

    const r = new P2PRoom(true, this._baseUrl, {
      rtcConfig,
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      onPeerLeave: (peerId: string) => {
        const pe = this._peerEmails.get(peerId) || peerId;
        this._peerEmails.delete(peerId);
        this.onPeerLeave?.(pe);
      },
    });
    const { url, offerId } = await r.offerUrl();
    this._currentOfferId = offerId; this.room = r;
    const sdpB64 = url.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      const resp = await this.signaling.request({ type: 'store-offer', sdp: sdpB64, offerId, hostEmail: email });
      this._token = resp.token; this._roomId = resp.roomId;
      this._shareUrl = `${this._baseUrl}#${this._token}`;
    } else {
      this._shareUrl = `${this._baseUrl}#offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`;
    }

    // Permanent event listeners
    this.signaling.on('peer-request', (m: any) => {
      this.onLog?.('system', `📩 ${m.email} wants to join`);
      this.onPendingRequest?.(m.email, m.token, m.offerId, m.answerB64);
    });

    this.setupRoomHandlers(r, useRelay);
    return useRelay;
  }

  private setupRoomHandlers(r: Room, useRelay: boolean) {
    r.onMessage((data, peerId) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') {
        this.onFeatureData?.(data, peerId);
        r.broadcastExcept(data, peerId);
      } else {
        const sender = this._peerEmails.get(peerId) || peerId;
        if (d.text.startsWith('[EMAIL]')) {
          this._peerEmails.set(peerId, d.text.slice(7));
        } else if (d.text.startsWith('[ROOM]')) {
          try { const rd = JSON.parse(d.text.slice(5)); this.onRoomState?.(rd.peers); } catch {}
          r.broadcastExcept(encodeChat(d.text));
        } else if (d.text.startsWith('[SYNC]') || d.text.startsWith('[FILENAME]')) {
          this.onControlMessage?.(d.text);
        } else if (d.text.startsWith('[CHKSUM]')) {
          // ignore
        } else {
          this.onChatMessage?.(sender, d.text);
          r.broadcastExcept(encodeChat(`${sender}: ${d.text}`));
        }
      }
    });

    r.onPeerJoin(async (peerId) => {
      const pe = this._pendingPeerEmail || peerId;
      this._peerEmails.set(peerId, pe);
      this._pendingPeerEmail = '';
      this.setConnected?.(true);
      this.onPeerJoin?.(pe);
      if (useRelay) {
        try {
          const { url: nu, offerId: noi } = await r.offerUrl();
          this._currentOfferId = noi;
          const nuSdpB64 = nu.match(/#sdp=(.*)/)?.[1] || '';
          const resp = await this.signaling.request({ type: 'store-offer-next', roomId: this._roomId, sdp: nuSdpB64, offerId: noi });
          this._token = resp.token;
          this._shareUrl = `${this._baseUrl}#${this._token}`;
        } catch (err: any) { this.onLog?.('system', `ERROR: ${err.message}`); }
      }
    });
  }

  // ── Host: accept answer (manual or auto with explicit offerId) ──
  acceptAnswer(signalUrl: string, offerId?: string) {
    const m = signalUrl.match(/#sdp=(.*)/);
    const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
    this.room?.acceptAnswer(offerId || this._currentOfferId, `#sdp=${b64}`);
  }

  // ── Host: approve / reject ──
  approvePeer(token: string) { this.signaling.send({ type: 'host-approve', token }); }
  rejectPeer(token: string) { this.signaling.send({ type: 'host-reject', token }); }

  // ── Peer: parse URL ──
  parseRoomFromUrl(): string | null {
    const h = window.location.hash; if (!h) return null;
    const m = h.match(/^#([a-zA-Z0-9_-]+)$/); if (m) return m[1];
    const m2 = h.match(/^#offer=([^&]+)&sdp=(.+)$/); if (m2) return `manual:${m2[1]}:${decodeURIComponent(m2[2])}`;
    return null;
  }

  // ── Peer: join ──
  async peerAutoJoin(parsed: string, email: string): Promise<void> {
    let useRelay = false, offerB64 = '', offerId = '';
    const isToken = !parsed.startsWith('manual:');
    if (isToken) { try { await this.signaling.connect(); useRelay = true; } catch {} }

    if (useRelay) {
      const data = await this.signaling.request({ type: 'fetch-offer', token: parsed });
      offerB64 = data.sdp; offerId = data.offerId; this._roomId = data.roomId;
    } else {
      const parts = parsed.split(':'); offerId = parts[1]; offerB64 = parts[2];
    }

    // Fetch ICE config if not already cached
    const rtcConfig = await this.signaling.fetchIceConfig();

    const peer = new P2PRoom(false, this._baseUrl, {
      rtcConfig,
      onConnect: () => { import('./connection-diagnostics').then(m => m.getConnectionRoute(peer).then(r => this.onConnected?.(r))); },
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
    });
    const answerUrl = await peer.connectToHost(`${this._baseUrl}#sdp=${offerB64}`);
    this.room = peer;
    const answerB64 = answerUrl.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      this.signaling.send({ type: 'submit-answer', token: parsed, email, answerB64 });
      this.signaling.on('approved', () => { this.setConnected?.(true); });
      this.signaling.on('promotion-request', (m: any) => this.handlePromotionRequest(m));
      this.signaling.on('new-host', async (m: any) => {
        this.onLog?.('system', `🔄 New host: ${m.hostEmail} — reconnecting...`);
        if (this.room) { this.room.close(); this.room = null; }
        const rtcConfig = this.signaling.iceConfig || undefined;
        const newPeer = new P2PRoom(false, this._baseUrl, {
          ...(rtcConfig ? { rtcConfig } : {}),
          onConnect: () => import('./connection-diagnostics').then(mod => mod.getConnectionRoute(newPeer).then(r => this.onConnected?.(r))),
          onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
        });
        const offerData = await this.signaling.request({ type: 'fetch-offer', token: m.token });
        const aUrl = await newPeer.connectToHost(`${this._baseUrl}#sdp=${offerData.sdp}`);
        this.room = newPeer;
        const ab64 = aUrl.match(/#sdp=(.*)/)?.[1] || '';
        this.signaling.send({ type: 'submit-answer', token: m.token, email, answerB64: ab64 });
        this.signaling.on('approved', () => { this.setConnected?.(true); this.onRoleChanged?.(false, m.hostEmail); });
      });
    }

    peer.onMessage((data) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') { this.onFeatureData?.(data, 'host'); }
      else {
        if (d.text.startsWith('[USERS]')) { try { const ud = JSON.parse(d.text.slice(7)); this.onRoomState?.(ud.users); } catch {} }
        else if (d.text.startsWith('[ROOM]')) { try { const rd = JSON.parse(d.text.slice(5)); this.onRoomState?.(rd.peers); } catch {} }
        else if (d.text.startsWith('[FILENAME]') || d.text.startsWith('[SYNC]')) { this.onControlMessage?.(d.text); }
        else if (d.text.startsWith('[PROMOTE]')) { /* handled via relay promote-peer now */ }
        else { this.onChatMessage?.('Host', d.text); }
      }
    });
  }

  // ── Promote peer ──
  async promotePeer(targetEmail: string, users: Participant[], rtcConfig: any, getYDoc: () => any, getYText: () => any) {
    if (this.promotionInProgress) return;
    this.promotionInProgress = true;
    this.onLog?.('system', `👑 Promoting ${targetEmail} to host...`);

    try {
      const ack = await this.signaling.request({ type: 'promote-peer', roomId: this._roomId, targetEmail });
      this.onLog?.('system', '📤 Promotion request sent');
    } catch (err: any) {
      this.onLog?.('system', `❌ Promotion failed: ${err.message}`);
      this.promotionInProgress = false;
    }
  }

  // Called on target peer when receiving promotion-request
  private async handlePromotionRequest(msg: any) {
    if (!this.room) return;
    this.onLog?.('system', `👑 Promotion request from ${msg.oldHostEmail}`);

    // Use cached ICE config (fetched from relay on initial connect)
    const rtcConfig = this.signaling.iceConfig || undefined;
    this.nextRoom = new P2PRoom(true, this._baseUrl, {
      ...(rtcConfig ? { rtcConfig } : {}),
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
    });

    // Create reconnect offers for ALL participants (including previous host)
    const reconnectTokens: Record<string, string> = {};
    for (const p of (msg.participants || [])) {
      if (p.email === this.getEmail?.()) continue;
      const { url, offerId } = await this.nextRoom.offerUrl();
      const sdp = url.match(/#sdp=(.*)/)?.[1] || '';
      const resp = await this.signaling.request({
        type: 'store-promotion-offer', roomId: msg.roomId, promotionId: msg.promotionId,
        intendedEmail: p.email, sdp, offerId,
      });
      reconnectTokens[p.email] = resp.token;
    }

    // Commit
    try {
      await this.signaling.request({
        type: 'commit-promotion', roomId: msg.roomId, promotionId: msg.promotionId,
        reconnectTokens, requestId: crypto.randomUUID(),
      });
      // on promotion-committed, switch role
      this.signaling.on('promotion-committed', (m: any) => {
        if (m.promotionId === msg.promotionId) {
          this.onLog?.('system', '✅ Now hosting the room');
          if (this.room) this.room.close();
          this.room = this.nextRoom;
          this.nextRoom = null;
          this._roomId = msg.roomId;
          this.setupRoomHandlers(this.room!, true);
          this.onRoleChanged?.(true, msg.hostEmail || this.getEmail?.() || '');
          this.promotionInProgress = false;
        }
      });
    } catch (err: any) {
      this.onLog?.('system', `❌ Commit failed: ${err.message}`);
      this.nextRoom?.close(); this.nextRoom = null;
      this.promotionInProgress = false;
    }
  }

  get pendingPeerEmail() { return this._pendingPeerEmail; }
  set pendingPeerEmail(e: string) { this._pendingPeerEmail = e; }

  sendFeature(data: Uint8Array) { this.room?.send(data); }
  sendControl(msg: string) { this.room?.send(encodeChat(msg)); }
  sendChatMessage(text: string) {
    const prefix = this.getEmail?.() || 'anonymous';
    this.room?.send(encodeChat(`${prefix}: ${text}`));
  }
  close() { this.room?.close(); this.signaling.close(); }
}