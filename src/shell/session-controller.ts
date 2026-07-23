// Session controller v1.2 — room creation, joining, promotion, failover
// Uses SignalingClient for permanent WS router. Separates roomId from offerToken.

import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import { encodeChat, encodeStructuredChat, encodeYjs, decodeMessage } from './protocol/message-envelope';
import type { Participant } from './participants/participants-controller';
import { SignalingClient } from './signaling-client';

export type ConnectionState = 'idle' | 'signaling' | 'negotiating' | 'connected' | 'reconnecting' | 'failed' | 'closed';

/** Try to parse a received chat payload as a structured JSON envelope.
 *  Returns {sender, text, senderRole} on success, null on failure (plain text / control message). */
function tryParseChatEnvelope(raw: string): { sender: string; text: string; senderRole: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === 'chat' && typeof parsed.sender === 'string' && typeof parsed.text === 'string') {
      return { sender: parsed.sender, text: parsed.text, senderRole: parsed.senderRole || 'unknown' };
    }
  } catch { /* not JSON — plain text or control message */ }
  return null;
}

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
  private _isHost = false;
  private _processedPromotionIds = new Set<string>();
  private _roomStateVersion = 0;
  private _lastRoomStateVersion = 0;
  private _nextToken = '';

  // Callbacks
  onLog?: (type: string, text: string) => void;
  onPendingRequest?: (request: { email: string; token: string; offerId: string; answerB64: string }) => void;
  onConnected?: (route: string) => void;
  onPeerJoin?: (peerId: string, peerEmail: string) => void;
  onPeerLeave?: (email: string) => void;
  onFeatureData?: (data: Uint8Array, peerId: string) => void;
  onControlMessage?: (text: string) => void;
  onChatMessage?: (sender: string, text: string, senderRole?: string) => void;
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
      this.onPendingRequest?.({ email: m.email, token: m.token, offerId: m.offerId, answerB64: m.answerB64 });
    });

    // Peer side: host approval — relay approved, wait for actual P2P onConnect
    this.signaling.on('approved', () => {
      this.onLog?.('system', '👍 Host approved — waiting for P2P connection...');
    });

    // Peer side: promotion request from old host
    this.signaling.on('promotion-request', (m: any) => this.handlePromotionRequest(m));

    // Peer side: new host after promotion failover
    this.signaling.on('new-host', async (m: any) => {
      this.onLog?.('system', `🔄 New host: ${m.hostEmail} — reconnecting...`);
      this._connectionState = 'reconnecting';
      const oldRoom = this.room; // keep old room alive during transition
      await this.signaling.refreshIfNeeded();
      const rtcConfig = await this.signaling.fetchIceConfig();
      this._connectionState = 'negotiating';
      const newPeer = new P2PRoom(false, this._baseUrl, {
        rtcConfig,
        onConnect: () => {
          this._connectionState = 'connected';
          this.setConnected?.(true);
          this._lastRoomStateVersion = 0; // reset for new host's version counter
          // Now close old room — replacement is connected
          oldRoom?.close();
          this.onRoleChanged?.(false, m.hostEmail);
          newPeer.getConnectionRoute().then(r => {
            const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
            this.onConnected?.(label);
          });
        },
        onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      });
      const offerData = await this.signaling.request({ type: 'fetch-offer', token: m.token });
      const aUrl = await newPeer.connectToHost(`${this._baseUrl}#sdp=${offerData.sdp as string}`);
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
  get signalingListenerCount(): number { return this.signaling.listenerCount; }

  // ── Host: create room ──
  async createRoom(email: string): Promise<boolean> {
    this._isHost = true;
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
      this._token = resp.token as string; this._roomId = resp.roomId as string;
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
        } else if (d.text.startsWith('[SYNC]') || d.text.startsWith('[FILENAME]')) {
          this.onControlMessage?.(d.text);
        } else if (d.text.startsWith('[CHKSUM]') || d.text.startsWith('[ROOM]')) {
          // ignore — host is the authority for room state, checksums are internal
        } else {
          const envelope = tryParseChatEnvelope(d.text);
          if (envelope) {
            this.onChatMessage?.(envelope.sender, envelope.text, envelope.senderRole);
          } else {
            // backward compat: plain text from old clients
            this.onChatMessage?.(sender, d.text, 'unknown');
          }
          r.broadcastExcept(data);
        }
      }
    }

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
          this._token = resp.token as string;
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

    // Kick off pre-generation BEFORE acceptAnswer so it runs during WebRTC negotiation.
    // By the time onPeerJoin fires, _nextToken is ready for synchronous swap.
    if (this.room) {
      const r = this.room;
      r.offerUrl().then(({ url, offerId }) => {
        const sdp = url.match(/#sdp=(.*)/)?.[1] || '';
        return this.signaling.request({ type: 'store-offer-next', roomId: this._roomId, sdp, offerId });
      }).then(resp => {
        this._nextToken = resp.token as string;
      }).catch(err => this.onLog?.('system', `ERROR: ${(err as Error).message}`));
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

  // ── Host (manual mode): accept answer URL with explicit offerId ──
  manualAcceptAnswer(offerId: string, signalUrl: string): void {
    const m = signalUrl.match(/#sdp=(.*)/);
    const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
    this.room?.acceptAnswer(offerId, `#sdp=${b64}`);
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
    this._isHost = false;
    let useRelay = false, offerB64 = '';
    const isToken = !parsed.startsWith('manual:');
    if (isToken) { try { await this.signaling.connect(); useRelay = true; } catch {} }

    if (useRelay) {
      const data = await this.signaling.request({ type: 'fetch-offer', token: parsed });
      offerB64 = data.sdp as string; this._roomId = data.roomId as string;
    } else {
      const parts = parsed.split(':'); offerB64 = parts[2];
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
        else if (d.text.startsWith('[ROOM]')) {
          try {
            const rd = JSON.parse(d.text.slice(5));
            const v: number = rd.v ?? 0;
            if (v <= this._lastRoomStateVersion) return; // stale/duplicate
            this._lastRoomStateVersion = v;
            this.onRoomState?.(rd.peers);
          } catch {}
        }
        else if (d.text.startsWith('[FILENAME]') || d.text.startsWith('[SYNC]')) { this.onControlMessage?.(d.text); }
        else if (d.text.startsWith('[PROMOTE]')) { /* handled via relay promote-peer now */ }
        else {
          const envelope = tryParseChatEnvelope(d.text);
          if (envelope) {
            this.onChatMessage?.(envelope.sender, envelope.text, envelope.senderRole);
          } else {
            this.onChatMessage?.('Host', d.text, 'host');
          }
        }
      }
    });
  }

  // ── Promote peer ──
  async promotePeer(targetEmail: string) {
    if (this.promotionInProgress) return;
    this.promotionInProgress = true;
    this.onLog?.('system', `👑 Promoting ${targetEmail} to host...`);

    try {
      await this.signaling.request({ type: 'promote-peer', roomId: this._roomId, targetEmail });
      // Use response directly: promotion accepted by relay, old host transitions to peer now
      this.onRoleChanged?.(false, targetEmail);
      this.onLog?.('system', `📤 Promotion accepted — you are now a peer; ${targetEmail} is the new host`);
    } catch (err: any) {
      this.onLog?.('system', `❌ Promotion failed: ${err.message}`);
      this.promotionInProgress = false;
    }
  }

  // Called on target peer when receiving promotion-request
  private async handlePromotionRequest(msg: any) {
    if (!this.room) return;

    // Idempotency: skip duplicate promotion IDs (relay may re-send on reconnect)
    if (this._processedPromotionIds.has(msg.promotionId)) {
      this.onLog?.('system', `⏭️ Skipping duplicate promotion ${msg.promotionId}`);
      return;
    }
    this._processedPromotionIds.add(msg.promotionId);

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
      reconnectTokens[p.email] = resp.token as string;
    }

    // Commit — response IS the promotion-committed message
    try {
      await this.signaling.request({
        type: 'commit-promotion', roomId: msg.roomId, promotionId: msg.promotionId,
        reconnectTokens,
      });
      this.onLog?.('system', '✅ Now hosting the room');
      const oldRoom = this.room; // old peer connection — keep alive until new room ready
      this.room = this.nextRoom;
      this.nextRoom = null;
      this._roomId = msg.roomId;
      this._connectionState = 'connected';
      this._lastRoomStateVersion = 0; // reset for new host's version counter
      this.setupRoomHandlers(this.room!, true);
      // Close old peer connection AFTER new host room is ready
      oldRoom?.close();
      this.onRoleChanged?.(true, msg.hostEmail || this.getEmail?.() || '');
      this.promotionInProgress = false;
    } catch (err: any) {
      this.onLog?.('system', `❌ Commit failed: ${err.message}`);
      this.nextRoom?.close(); this.nextRoom = null;
      this.promotionInProgress = false;
    }
  }

  /** Broadcast canonical participant list to all peers. Host-only — peers receive via onRoomState.
   *  Includes a monotonic version so receivers can ignore duplicates/out-of-order messages. */
  broadcastRoomState(peers: Participant[]): void {
    if (!this.room) return;
    this._roomStateVersion++;
    this.room.send(encodeChat(`[ROOM]${JSON.stringify({ peers, v: this._roomStateVersion })}`));
  }

  sendFeature(data: Uint8Array) { this.room?.send(encodeYjs(data)); }
  sendFeatureDataToPeer(peerId: string, data: Uint8Array) { this.room?.sendToPeer(peerId, encodeYjs(data)); }
  sendControl(msg: string) { this.room?.send(encodeChat(msg)); }
  sendChatMessage(text: string) {
    const email = this.getEmail?.() ?? 'unknown';
    const role = this._isHost ? 'host' : 'peer';
    this.room?.send(encodeStructuredChat(email, role, text));
  }

  /** Close the room and signaling, reject pending operations, reset state. */
  close(): void {
    this._connectionState = 'closed';
    this.promotionInProgress = false;
    this.room?.close();
    this.room = null;
    this.nextRoom?.close();
    this.nextRoom = null;
    this.signaling.close();
  }
}