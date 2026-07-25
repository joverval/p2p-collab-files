// Session controller v1.3 — room creation, joining, promotion, failover
// Uses SignalingClient for permanent WS router. Separates roomId from offerToken.
// Now owns canonical room snapshot — publishes [ROOM_STATE] on all state changes.

import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import { encodeChat, encodeStructuredChat, encodeYjs, decodeMessage } from './protocol/message-envelope';
import type { Participant } from './participants/participants-controller';
import type { RoomSnapshot } from '../shared/types';
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
  private _rotateInProgress = false;
  private _connectionState: ConnectionState = 'idle';
  private _permanentHandlersRegistered = false;
  private _isHost = false;
  private _processedPromotionIds = new Set<string>();
  private _roomStateVersion = 0;
  private _lastRoomStateVersion = 0;
  private _participants: Participant[] = [];
  private _hostEmail = '';
  private _localParticipantId = '';
  private _hostParticipantId = '';

  /** Log ICE diagnostic info, gracefully handling mocks / older Room impls. */
  private _logIceConfig(room: Room): void {
    try {
      const d = room.getIceConfigurationSummary();
      this.onLog?.('system', `🧊 ICE: mode=${d.mode} stun=${d.stunCount} turn=${d.turnCount} credentials=${d.hasTurnCredentials} policy=${d.transportPolicy}`);
    } catch { /* diagnostic-only — never fail on logging */ }
  }

  // ── Participant tracking (SessionController owns the canonical list) ──

  addParticipant(p: Participant): void {
    const idx = this._participants.findIndex(x => x.email === p.email);
    if (idx >= 0) this._participants[idx] = p;
    else this._participants.push(p);
  }

  removeParticipantByEmail(email: string): void {
    this._participants = this._participants.filter(p => p.email !== email);
  }

  replaceParticipants(peers: Participant[]): void {
    this._participants = [...peers];
  }

  /** Peer-side: apply a RoomSnapshot from the host, with version gate and roomId validation. */
  applyRoomSnapshot(snapshot: RoomSnapshot): void {
    if (snapshot.roomId && snapshot.roomId !== this._roomId) return;
    if (snapshot.version <= this._lastRoomStateVersion) return;
    this._lastRoomStateVersion = snapshot.version;
    this._participants = [...snapshot.participants];
    // Update host tracking from snapshot
    this._hostParticipantId = snapshot.hostParticipantId;
    const hostP = snapshot.participants.find(p => p.role === 'host');
    if (hostP) this._hostEmail = hostP.email;
    // Peer stays non-host; onRoleChanged fires if host changed
    this._isHost = false;
    this.onRoomState?.(snapshot);
  }

  get participants(): Participant[] { return this._participants; }

  // Callbacks
  onLog?: (type: string, text: string) => void;
  onPendingRequest?: (request: { email: string; token: string; offerId: string; answerB64: string }) => void;
  onConnected?: (route: string) => void;
  onPeerJoin?: (peerId: string, peerEmail: string) => void;
  onPeerLeave?: (email: string) => void;
  onFeatureData?: (data: Uint8Array, peerId: string) => void;
  onControlMessage?: (text: string) => void;
  onChatMessage?: (sender: string, text: string, senderRole?: string) => void;
  onRoomState?: (snapshot: RoomSnapshot) => void;
  onRoleChanged?: (isHost: boolean, hostEmail: string) => void;
  onInviteChanged?: (token: string, shareUrl: string) => void;
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
        trickle: true,
        iceMode: 'all',
        onConnect: () => {
          this._connectionState = 'connected';
          this.setConnected?.(true);
          this._lastRoomStateVersion = 0; // reset for new host's version counter
          // Now close old room — replacement is connected
          oldRoom?.close();
          this.onRoleChanged?.(false, m.hostEmail);
          this.publishRoomSnapshot();
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
      this._logIceConfig(newPeer);
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
  get localParticipantId(): string { return this._localParticipantId; }
  get hostParticipantId(): string { return this._hostParticipantId; }

  // ── Host: create room ──
  async createRoom(email: string): Promise<boolean> {
    this._isHost = true;
    this._hostEmail = email;
    this._hostParticipantId = 'host';
    this._localParticipantId = 'host';

    // Track host as first participant
    this._participants = [{ email, role: 'host', participantId: 'host', connected: true, joinOrder: 1 }];

    let useRelay = false;
    try { await this.signaling.connect(); useRelay = true; } catch { this.onLog?.('system', '⚠️ Relay unavailable — manual mode'); }

    // Refresh ICE credentials if near expiry, then fetch
    await this.signaling.refreshIfNeeded();
    const rtcConfig = await this.signaling.fetchIceConfig();

    this._connectionState = 'negotiating';
    const r = new P2PRoom(true, this._baseUrl, {
      rtcConfig,
      trickle: true,
      iceMode: 'all',
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      onPeerLeave: (peerId: string) => {
        const pe = this._peerEmails.get(peerId) || peerId;
        this._peerEmails.delete(peerId);
        this.removeParticipantByEmail(pe);
        this.publishRoomSnapshot();
        this.onPeerLeave?.(pe);
      },
      onPeerConnect: (_peerId: string) => {
        console.log('[DEBUG] onPeerConnect fired, peerId:', _peerId);
        // ponytail: visible debug — set page title to confirm this callback fires
        document.title = '[DEBUG] onPeerConnect: ' + _peerId;
        this._connectionState = 'connected';
        this.setConnected?.(true);
        this.publishRoomSnapshot();
        // ponytail: host route label, mirroring peer-side onConnect pattern
        console.log('[DEBUG] calling getConnectionRoute with peerId:', _peerId);
        r.getConnectionRoute(_peerId).then(route => {
          console.log('[DEBUG] getConnectionRoute resolved:', JSON.stringify(route));
          const label = route.kind === 'turn' ? 'TURN relay' : route.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
          console.log('[DEBUG] calling onConnected with label:', label);
          document.title = '[DEBUG] onConnected: ' + label;
          this.onConnected?.(label);
        }).catch(err => {
          console.error('[DEBUG] getConnectionRoute failed:', err);
          document.title = '[DEBUG] getConnectionRoute ERROR: ' + err;
        });
      },
    });
    const { url, offerId } = await r.offerUrl();
    this._currentOfferId = offerId; this.room = r;
    this._logIceConfig(r);
    const sdpB64 = url.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      const resp = await this.signaling.request({ type: 'store-offer', sdp: sdpB64, offerId, hostEmail: email });
      this._token = resp.token as string; this._roomId = resp.roomId as string;
      this._shareUrl = `${this._baseUrl}#${this._token}`;
    } else {
      this._shareUrl = `${this._baseUrl}#offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`;
    }

    this.setupRoomHandlers(r);
    this.publishRoomSnapshot();
    return useRelay;
  }

  private setupRoomHandlers(r: Room) {
    r.onMessage((data, peerId) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') {
        this.onFeatureData?.(data, peerId);
        r.broadcastExcept(data, peerId);
      } else if (d.type === 'chat-control') {
        const msg = d.control.message;
        const sender = msg.senderEmail || (this._peerEmails.get(peerId) || peerId);
        this.onChatMessage?.(sender, msg.text, msg.senderRole);
        r.broadcastExcept(data);
      } else {
        const sender = this._peerEmails.get(peerId) || peerId;
        if (d.text.startsWith('[EMAIL]')) {
          const email = d.text.slice(7);
          this._peerEmails.set(peerId, email);
          // Find participant by participantId (may have been added by onPeerJoin, or not yet)
          const p = this._participants.find(x => x.participantId === peerId);
          if (p) {
            p.email = email;
          } else {
            // onPeerJoin hasn't fired yet — add placeholder (onPeerJoin will set connected=true)
            this.addParticipant({ email, role: 'peer', participantId: peerId, connected: false, joinOrder: this._participants.length + 1 });
          }
          this.publishRoomSnapshot();
        } else if (d.text.startsWith('[SYNC]') || d.text.startsWith('[FILENAME]')) {
          this.onControlMessage?.(d.text);
        } else if (d.text.startsWith('[CHKSUM]') || d.text.startsWith('[ROOM_STATE]') || d.text.startsWith('[ROOM]') || d.text.startsWith('[USERS]')) {
          // Host is sole authority for room membership — reject state from peers
          if (d.text.startsWith('[ROOM_STATE]')) {
            console.warn('Protocol: host received room-state from peer (ignored)');
          }
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
    });

    r.onPeerJoin(async (peerId) => {
      // Use real email if [EMAIL] arrived before onPeerJoin (race condition fix)
      const pe = this._peerEmails.get(peerId) || peerId;
      this._peerEmails.set(peerId, pe);
      this.setConnected?.(true);
      // Upsert: update existing participant (from early [EMAIL]) or add new one
      const existing = this._participants.find(x => x.participantId === peerId);
      if (existing) {
        existing.email = pe;
        existing.connected = true;
      } else {
        this.addParticipant({ email: pe, role: 'peer', participantId: peerId, connected: true, joinOrder: this._participants.length + 1 });
      }
      this.publishRoomSnapshot();
      this.onPeerJoin?.(peerId, pe);
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
    // ponytail: rotate after token consumption, not ICE connect
    this.rotateInvite().catch(err => this.onLog?.('system', `ERROR: rotate failed: ${err.message}`));
  }

  // ── Host: reject ──
  rejectPeer(token: string) { this.signaling.send({ type: 'host-reject', token }); this.publishRoomSnapshot(); }

  // ── Host: rotate invite token (relay or manual) ──
  /** Generate a new offer, update the share URL, and fire onInviteChanged.
   *  Idempotent: skips if a rotation is already in progress.
   *  Returns true if a new invite was generated, false if skipped. */
  async rotateInvite(): Promise<boolean> {
    if (!this.room || !this._isHost) return false;
    if (this._rotateInProgress) return false;
    this._rotateInProgress = true;
    try {
      const { url: nu, offerId: noi } = await this.room.offerUrl();
      this._currentOfferId = noi;
      const nuSdpB64 = nu.match(/#sdp=(.*)/)?.[1] || '';
      this._shareUrl = '';
      this._token = '';
      if (this.signaling && this._roomId) {
        // ponytail: only store-offer-next when relay is active (has roomId)
        const resp = await this.signaling.request({
          type: 'store-offer-next',
          roomId: this._roomId,
          sdp: nuSdpB64,
          offerId: noi,
        });
        this._token = resp.token as string;
        this._shareUrl = `${this._baseUrl}#${this._token}`;
        this.onInviteChanged?.(this._token, this._shareUrl);
      } else {
        // Manual mode: no relay, use URL fragment directly
        this._shareUrl = `${this._baseUrl}#offer=${noi}&sdp=${encodeURIComponent(nuSdpB64)}`;
        this._token = `${noi}:${nuSdpB64}`;
        this.onInviteChanged?.(this._token, this._shareUrl);
      }
      return true;
    } catch (err: any) {
      this.onLog?.('system', `ERROR: rotateInvite failed: ${err.message}`);
      return false;
    } finally {
      this._rotateInProgress = false;
    }
  }

  // ── Host (manual mode): accept answer URL with explicit offerId ──
  manualAcceptAnswer(offerId: string, signalUrl: string): void {
    const m = signalUrl.match(/#sdp=(.*)/);
    const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
    this.room?.acceptAnswer(offerId, `#sdp=${b64}`);
    // ponytail: rotate after manual answer consumption
    this.rotateInvite().catch(err => this.onLog?.('system', `ERROR: rotate failed: ${err.message}`));
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
    this._localParticipantId = email;
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
      trickle: true,
      iceMode: 'all',
      onConnect: () => {
        this._connectionState = 'connected';
        this.setConnected?.(true);
        // ponytail: send email to host for participant list
        peer.send(encodeChat(`[EMAIL]${email}`));
        peer.getConnectionRoute().then(r => {
          const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
          this.onConnected?.(label);
        });
      },
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
    });
    const answerUrl = await peer.connectToHost(`${this._baseUrl}#sdp=${offerB64}`);
    this.room = peer;
    this._logIceConfig(peer);
    const answerB64 = answerUrl.match(/#sdp=(.*)/)?.[1] || '';

    if (useRelay) {
      this.signaling.send({ type: 'submit-answer', token: parsed, email, answerB64 });
    }

    peer.onMessage((data) => {
      if (!(data instanceof Uint8Array)) return;
      const d = decodeMessage(data);
      if (d.type === 'yjs') {
        this.onFeatureData?.(data, 'host');
      } else if (d.type === 'chat-control') {
        const msg = d.control.message;
        this.onChatMessage?.(msg.senderEmail || 'Host', msg.text, msg.senderRole);
      } else if (d.text.startsWith('[ROOM_STATE]')) {
        try {
          const snap: RoomSnapshot = JSON.parse(d.text.slice(12));
          this.applyRoomSnapshot(snap);
        } catch {}
      } else if (d.text.startsWith('[FILENAME]') || d.text.startsWith('[SYNC]')) {
        this.onControlMessage?.(d.text);
      } else if (d.text.startsWith('[PROMOTE]')) {
        /* handled via relay promote-peer now */
      } else {
        const envelope = tryParseChatEnvelope(d.text);
        if (envelope) {
          this.onChatMessage?.(envelope.sender, envelope.text, envelope.senderRole);
        } else {
          this.onChatMessage?.('Host', d.text, 'host');
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
      this._isHost = false;
      // Update own role in participants
      const self = this._participants.find(p => p.email === this.getEmail?.());
      if (self) self.role = 'peer';
      const target = this._participants.find(p => p.email === targetEmail);
      if (target) target.role = 'host';
      this.publishRoomSnapshot();
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
      trickle: true,
      iceMode: 'all',
      onError: (e: Error) => this.onLog?.('system', `ERROR: ${e.message}`),
      onPeerConnect: (_peerId: string) => {
        this._connectionState = 'connected';
        this.setConnected?.(true);
        this.publishRoomSnapshot();
      },
    });
    this._logIceConfig(this.nextRoom);

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
      this._isHost = true;
      this._hostParticipantId = 'host';
      this._localParticipantId = 'host';

      // Build participant list: self as new host + all reconnecting peers
      const selfEmail = this.getEmail?.() ?? '';
      this._participants = [
        { email: selfEmail, role: 'host', participantId: 'host', connected: true, joinOrder: 1 },
      ];
      for (const p of (msg.participants || [])) {
        if (p.email === selfEmail) continue;
        this._participants.push({
          email: p.email,
          role: 'peer',
          participantId: p.participantId || p.email,
          connected: false, // will reconnect via new-host event
          joinOrder: this._participants.length + 1,
        });
      }

      this._lastRoomStateVersion = 0; // reset for new host's version counter
      this.setupRoomHandlers(this.room!);
      // Close old peer connection AFTER new host room is ready
      oldRoom?.close();
      this.publishRoomSnapshot();
      this.onRoleChanged?.(true, msg.hostEmail || selfEmail);
      this.promotionInProgress = false;
    } catch (err: any) {
      this.onLog?.('system', `❌ Commit failed: ${err.message}`);
      this.nextRoom?.close(); this.nextRoom = null;
      this.promotionInProgress = false;
    }
  }

  /** Build a RoomSnapshot from current internal state. */
  private createRoomSnapshot(): RoomSnapshot {
    const hostP = this._participants.find(p => p.role === 'host');
    return {
      roomId: this._roomId,
      version: this._roomStateVersion,
      hostParticipantId: hostP?.participantId ?? this._hostEmail,
      participants: [...this._participants],
    };
  }

  /** Increment version, build snapshot, broadcast [ROOM_STATE] to all peers,
   *  and notify local callbacks. Accepts optional external peer list override. */
  publishRoomSnapshot(peers?: Participant[]): void {
    if (!this.room) return;
    this._roomStateVersion++;
    let snap: RoomSnapshot;
    if (peers) {
      this._participants = [...peers];
      snap = { roomId: this._roomId, version: this._roomStateVersion, hostParticipantId: this._participants.find(p => p.role === 'host')?.participantId ?? '', participants: [...peers] };
    } else {
      snap = this.createRoomSnapshot();
    }
    this.room.send(encodeChat(`[ROOM_STATE]${JSON.stringify(snap)}`));
    this.onRoomState?.(snap);
  }

  /** Backward-compat: accept external participant list, update internal state, publish snapshot. */
  broadcastRoomState(peers: Participant[]): void {
    this.publishRoomSnapshot(peers);
  }

  sendFeature(data: Uint8Array) { this.room?.send(encodeYjs(data)); }
  sendFeatureDataToPeer(peerId: string, data: Uint8Array) { this.room?.sendToPeer(peerId, encodeYjs(data)); }
  sendControl(msg: string) { this.room?.send(encodeChat(msg)); }
  sendChatMessage(text: string) {
    const email = this.getEmail?.() ?? 'unknown';
    const role = this._isHost ? 'host' : 'peer';
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.room?.send(encodeStructuredChat(id, this.localParticipantId, email, role, text, Date.now()));
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