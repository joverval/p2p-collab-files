// Session controller v1.2 — room creation, joining, promotion, failover
// Uses SignalingClient for permanent WS router. Separates roomId from offerToken.

import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import { encodeChat, encodeYjs, decodeMessage } from './protocol/message-envelope';
import type { Participant } from './participants/participants-controller';
import { SignalingClient } from './signaling-client';

export type ConnectionState = 'idle' | 'signaling' | 'negotiating' | 'connected' | 'reconnecting' | 'failed' | 'closed';

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
  private promotionInProgress = false;
  private _connectionState: ConnectionState = 'idle';
  private _permanentHandlersRegistered = false;

  // Callbacks
  onLog?: (type: string, text: string) => void;
  onPendingRequest?: (email: string, token: string, offerId?: string, answerB64?: string) => void;
  onConnected?: (route: string) => void;
  onPeerJoin?: (peerId: string, peerEmail: string) => void;
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
    this.registerPermanentHandlers();
  }

  /** Register signaling event handlers that live for the entire session (called once in constructor). */
  private registerPermanentHandlers(): void {
    if (this._permanentHandlersRegistered) return;
    this._permanentHandlersRegistered = true;

    // Host side: peer join request
    this.signaling.on('peer-request', (m: any) => {
      this.onLog?.('system', `📩 ${m.email} wants to join`);
      this.onPendingRequest?.(m.email, m.token, m.offerId, m.answerB64);
    });

    // Peer side: host approval
    this.signaling.on('approved', () => {
      this._connectionState = 'connected';
      this.setConnected?.(true);
    });

    // Peer side: promotion request from old host
    this.signaling.on('promotion-request', (m: any) => this.handlePromotionRequest(m));

    // Peer side: new host after promotion failover
    this.signaling.on('new-host', async (m: any) => {
      this.onLog?.('system', `🔄 New host: ${m.hostEmail} — reconnecting...`);
      this._connectionState = 'reconnecting';
      if (this.room) { this.room.close(); this.room = null; }
      await this.signaling.refreshIfNeeded();
      const rtcConfig = await this.signaling.fetchIceConfig();
      this._connectionState = 'negotiating';
      const newPeer = new P2PRoom(false, this._baseUrl, {
        rtcConfig,
        onConnect: () => {
          this._connectionState = 'connected';
          this.setConnected?.(true);
          this.onRoleChanged?.(false, m.hostEmail);
          newPeer.getConnectionRoute().then(r => {
            const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
            this.onConnected?.(label);
          });
        },
        onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      });
      const offerData = await this.signaling.request({ type: 'fetch-offer', token: m.token });
      const aUrl = await newPeer.connectToHost(`${this._baseUrl}#sdp=${offerData.sdp}`);
      this.room = newPeer;
      const ab64 = aUrl.match(/#sdp=(.*)/)?.[1] || '';
      this.signaling.send({ type: 'submit-answer', token: m.token, email: this.getEmail?.() ?? '', answerB64: ab64 });
    });
  }

  get token(): string { return this._token; }
  get roomId(): string { return this._roomId; }
  get shareUrl(): string { return this._shareUrl; }
  get currentOfferId(): string { return this._currentOfferId; }
  get roomRef(): Room | null { return this.room; }
  get connectionState(): ConnectionState { return this._connectionState; }
  get isConnected(): boolean { return this._connectionState === 'connected'; }

  // ── Host: create room ──
  async createRoom(email: string): Promise<boolean> {
    let useRelay = false;
    try { await this.signaling.connect(); useRelay = true; } catch { this.onLog?.('system', '⚠️ Relay unavailable — manual mode'); }

    // Refresh ICE credentials if near expiry, then fetch
    await this.signaling.refreshIfNeeded();
    const rtcConfig = await this.signaling.fetchIceConfig();

    this._connectionState = 'negotiating';
    const r = new P2PRoom(true, this._baseUrl, {
      rtcConfig,
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      onPeerLeave: (peerId: string) => {
        const pe = this._peerEmails.get(peerId) || peerId;
        this._peerEmails.delete(peerId);
        this.onPeerLeave?.(pe);
      },
      onPeerConnect: (_peerId: string) => {
        this._connectionState = 'connected';
        this.setConnected?.(true);
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
          r.broadcastExcept(data);
        }
      }
    });

    r.onPeerJoin(async (peerId) => {
      const pe = peerId;
      this._peerEmails.set(peerId, pe);
      this.setConnected?.(true);
      this.onPeerJoin?.(peerId, pe);
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

  // ── Host: approve peer (validate, accept answer, signal relay) ──
  approvePeer(request: { email: string; token: string; offerId: string; answerB64: string }): void {
    // 1. Validate all fields
    if (!request.email || !request.token || !request.offerId || !request.answerB64) {
      this.onLog?.('system', 'ERROR: approvePeer missing required fields');
      return;
    }
    // 2. Accept the answer with exact offerId
    try {
      this.room?.acceptAnswer(request.offerId, `#sdp=${request.answerB64}`);
    } catch (err: any) {
      this.onLog?.('system', `ERROR: acceptAnswer failed: ${err.message}`);
      return;
    }
    // 3. Only after acceptAnswer succeeds, send host-approve via signaling
    this.signaling.send({ type: 'host-approve', token: request.token });
    this.onLog?.('system', `✅ Approved ${request.email}`);
  }

  // ── Host: reject ──
  rejectPeer(token: string) { this.signaling.send({ type: 'host-reject', token }); }

  // ── Host (manual mode): accept answer URL directly ──
  manualAcceptAnswer(signalUrl: string): void {
    const m = signalUrl.match(/#sdp=(.*)/);
    const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
    this.room?.acceptAnswer(this._currentOfferId, `#sdp=${b64}`);
  }

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

    // Refresh ICE credentials if near expiry, then fetch
    await this.signaling.refreshIfNeeded();
    const rtcConfig = await this.signaling.fetchIceConfig();

    this._connectionState = 'negotiating';
    const peer = new P2PRoom(false, this._baseUrl, {
      rtcConfig,
      onConnect: () => {
        this._connectionState = 'connected';
        this.setConnected?.(true);
        peer.getConnectionRoute().then(r => {
          const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
          this.onConnected?.(label);
        });
      },
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
    });
    const answerUrl = await peer.connectToHost(`${this._baseUrl}#sdp=${offerB64}`);
    this.room = peer;
    const answerB64 = answerUrl.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      this.signaling.send({ type: 'submit-answer', token: parsed, email, answerB64 });
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
  async promotePeer(targetEmail: string) {
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

    // Refresh ICE credentials if near expiry
    await this.signaling.refreshIfNeeded();
    const rtcConfig = await this.signaling.fetchIceConfig();
    this.nextRoom = new P2PRoom(true, this._baseUrl, {
      rtcConfig,
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

    // Commit — response IS the promotion-committed message
    try {
      const result = await this.signaling.request({
        type: 'commit-promotion', roomId: msg.roomId, promotionId: msg.promotionId,
        reconnectTokens,
      });
      // result.promotionId matches msg.promotionId — switch role now
      this.onLog?.('system', '✅ Now hosting the room');
      if (this.room) this.room.close();
      this.room = this.nextRoom;
      this.nextRoom = null;
      this._roomId = msg.roomId;
      this._connectionState = 'connected';
      this.setupRoomHandlers(this.room!, true);
      this.onRoleChanged?.(true, msg.hostEmail || this.getEmail?.() || '');
      this.promotionInProgress = false;
    } catch (err: any) {
      this.onLog?.('system', `❌ Commit failed: ${err.message}`);
      this.nextRoom?.close(); this.nextRoom = null;
      this.promotionInProgress = false;
    }
  }

  sendFeature(data: Uint8Array) { this.room?.send(encodeYjs(data)); }
  sendFeatureDataToPeer(peerId: string, data: Uint8Array) { this.room?.sendToPeer(peerId, encodeYjs(data)); }
  sendControl(msg: string) { this.room?.send(encodeChat(msg)); }
  sendChatMessage(text: string) {
    this.room?.send(encodeChat(text));
  }
  close() { this.room?.close(); this.signaling.close(); }
}