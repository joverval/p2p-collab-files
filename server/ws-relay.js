// p2p-collab WebSocket relay v2.0
// Stable rooms + per-participant tokens + promote-peer/commit-promotion
// Opaque token handshake with requestId echo for SignalingClient
// Backward compatible with v1.3 message format
// Exports createRelayServer factory for testability

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const DEFAULT_PORT = Number(process.env.PORT || 8083);
const DEFAULT_TOKEN_TTL = 5 * 60 * 1000;           // 5 min for individual tokens
const DEFAULT_OFFER_TTL = 5 * 60 * 1000;           // 5 min for peer join offers
const DEFAULT_ROOM_INACTIVITY_TTL = 30 * 60 * 1000; // 30 min inactivity before room cleanup
const DEFAULT_PENDING_APPROVAL_TTL = 5 * 60 * 1000; // 5 min for host approval wait
const DEFAULT_PROMOTION_TTL = 30 * 1000;            // 30s for promotion commit window
const DEFAULT_ALLOWED_ORIGINS = (process.env.APP_ORIGINS || 'https://joverval.cl,http://localhost:8082').split(',');
const DEFAULT_GRACE_PERIOD = 10_000;       // 10s for host reconnect
const DEFAULT_CANDIDATE_TIMEOUT = 30_000;  // 30s for candidate to respond
const DEFAULT_HEARTBEAT_INTERVAL = 30_000;

/**
 * Creates a relay server instance. Does NOT auto-start.
 *
 * @param {object} options
 * @param {number} [options.port]           Port to listen on (0 = ephemeral). Default: process.env.PORT || 8083.
 * @param {() => number} [options.clock]    Injectable clock (for fake timers). Default: () => Date.now().
 * @param {() => string} [options.idGenerator]  Injectable ID generator. Default: crypto.randomBytes.
 * @param {string[]} [options.allowedOrigins]  CORS origins. Default: from APP_ORIGINS env.
 * @param {number} [options.tokenTTL]       Token TTL in ms. Default: 5 min.
 * @param {number} [options.offerTTL]        Offer TTL in ms. Default: 5 min.
 * @param {number} [options.roomInactivityTTL] Room inactivity TTL in ms. Default: 30 min.
 * @param {number} [options.pendingApprovalTTL] Pending approval TTL in ms. Default: 5 min.
 * @param {number} [options.promotionTTL]     Promotion commit TTL in ms. Default: 30s.
 * @param {number} [options.gracePeriod]    Grace period for host reconnect in ms. Default: 10s.
 * @param {number} [options.candidateTimeout]  Candidate response timeout in ms. Default: 30s.
 * @param {number} [options.heartbeatInterval]  Heartbeat interval in ms. Default: 30s.
 * @param {object} [options.turnConfig]     TURN server config.
 * @returns {{ server: http.Server, wss: WebSocketServer, start(port?: number): Promise<number>, stop(): Promise<void>, getState(): object }}
 */
export function createRelayServer(options = {}) {
  const {
    port = DEFAULT_PORT,
    clock = () => Date.now(),
    idGenerator = () => crypto.randomBytes(18).toString('base64url'),
    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
    tokenTTL = DEFAULT_TOKEN_TTL,
    offerTTL = DEFAULT_OFFER_TTL,
    roomInactivityTTL = DEFAULT_ROOM_INACTIVITY_TTL,
    pendingApprovalTTL = DEFAULT_PENDING_APPROVAL_TTL,
    promotionTTL = DEFAULT_PROMOTION_TTL,
    gracePeriod = DEFAULT_GRACE_PERIOD,
    candidateTimeout = DEFAULT_CANDIDATE_TIMEOUT,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL,
    turnConfig: tc = null,
  } = options;

  // ── TURN config ──
  let TURN_ENABLED = false;
  let TURN_HOST = '';
  let TURN_PORT = 3478;
  let TURN_USER = '';
  let TURN_PASS = '';

  if (tc) {
    TURN_ENABLED = tc.enabled === true;
    TURN_HOST = tc.host || '';
    TURN_PORT = tc.port || 3478;
    TURN_USER = tc.user || '';
    TURN_PASS = tc.pass || '';
  } else {
    TURN_ENABLED = process.env.TURN_ENABLED === '1' || process.env.TURN_ENABLED === 'true';
    TURN_HOST = process.env.TURN_HOST || '';
    TURN_PORT = Number(process.env.TURN_PORT || 3478);
    TURN_USER = process.env.TURN_USER || '';
    TURN_PASS = process.env.TURN_PASS || '';
  }

  if (TURN_ENABLED && (!TURN_USER || !TURN_PASS)) {
    console.error('TURN_ENABLED=1 but TURN_USER/TURN_PASS not set. TURN disabled.');
    TURN_ENABLED = false;
  }

  // ── ID generation ──
  function genToken() {
    return idGenerator();
  }
  function genRoomId() {
    return idGenerator();
  }

  // ── Room state ──
  /** @type {Map<string, object>} */
  const rooms = new Map();

  /** @type {Map<string, {roomId: string, role: string, createdAt: number}>} */
  const tokenRoom = new Map();

  function createRoom(hostWs, hostEmail) {
    const roomId = genRoomId();
    const normalizedEmail = hostEmail ? hostEmail.trim().toLowerCase() : 'host';
    const room = {
      roomId,
      hostWs,
      participants: new Map(),
      offers: new Map(),
      created: clock(),
      members: new Map(),
      lastActivityAt: clock(),
    };
    room.members.set(normalizedEmail, { email: normalizedEmail, ws: hostWs, joinOrder: 1 });
    rooms.set(roomId, room);
    return room;
  }

  function normalizeEmail(email) {
    return (email || '').trim().toLowerCase();
  }

  // ── Message validation ──
  function validateMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return 'Missing or invalid type';

    switch (msg.type) {
      case 'store-offer':
        if (!msg.sdp) return 'store-offer: missing sdp';
        if (!msg.offerId) return 'store-offer: missing offerId';
        break;
      case 'fetch-offer':
        if (!msg.token) return 'fetch-offer: missing token';
        break;
      case 'submit-answer':
        if (!msg.token) return 'submit-answer: missing token';
        if (!msg.email) return 'submit-answer: missing email';
        if (!msg.answerB64) return 'submit-answer: missing answerB64';
        break;
      case 'host-approve':
      case 'host-reject':
        if (!msg.token) return `${msg.type}: missing token`;
        break;
      case 'become-host':
        if (!msg.oldToken) return 'become-host: missing oldToken';
        break;
      case 'store-offer-next':
        if (!msg.roomId) return 'store-offer-next: missing roomId';
        if (!msg.sdp) return 'store-offer-next: missing sdp';
        if (!msg.offerId) return 'store-offer-next: missing offerId';
        break;
      case 'promote-peer':
        if (!msg.roomId) return 'promote-peer: missing roomId';
        if (!msg.targetEmail) return 'promote-peer: missing targetEmail';
        break;
      case 'store-promotion-offer':
        if (!msg.roomId) return 'store-promotion-offer: missing roomId';
        if (!msg.sdp) return 'store-promotion-offer: missing sdp';
        if (!msg.offerId) return 'store-promotion-offer: missing offerId';
        break;
      case 'commit-promotion':
        if (!msg.roomId) return 'commit-promotion: missing roomId';
        if (!msg.promotionId) return 'commit-promotion: missing promotionId';
        break;
      case 'ping':
        break;
      default:
        return `Unknown message type: ${msg.type}`;
    }
    return null;
  }

  function sendJson(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function respond(ws, base, requestId) {
    if (requestId) base.requestId = requestId;
    sendJson(ws, base);
  }

  // ── Auto host failover ──
  function initiateAutoFailover(room, departedHostEmail) {
    const candidates = [];
    for (const [, member] of room.members) {
      if (member.email === departedHostEmail) continue;
      if (member._failed) continue;
      if (member.ws.readyState !== 1) continue;
      const isPeer = [...room.participants.values()].some(
        p => p.email === member.email && p.role === 'peer' && p.ws === member.ws
      );
      if (isPeer) {
        candidates.push(member);
      }
    }
    candidates.sort((a, b) => a.joinOrder - b.joinOrder);

    if (candidates.length === 0) {
      console.log(`[failover] room ${room.roomId}: no eligible candidates for failover`);
      return;
    }

    const candidate = candidates[0];
    console.log(`[failover] room ${room.roomId}: initiating auto promotion to ${candidate.email}`);

    const promotionId = genToken();
    const participantList = [];
    for (const [, p] of room.participants) {
      participantList.push({ email: p.email, isHost: p.role === 'host' });
    }

    const oldHostEmail = [...room.participants.values()].find(p => p.role === 'host')?.email || departedHostEmail;

    sendJson(candidate.ws, {
      type: 'promotion-request',
      roomId: room.roomId,
      promotionId,
      targetEmail: candidate.email,
      oldHostEmail,
      participants: participantList,
      automatic: true,
    });

    const timer = setTimeout(() => {
      console.log(`[failover] room ${room.roomId}: candidate ${candidate.email} timed out`);
      room.pendingPromotion = undefined;
      candidate._failed = true;
      initiateAutoFailover(room, departedHostEmail);
    }, candidateTimeout);

    room._promotion = { promotionId, targetEmail: candidate.email, oldHostEmail, _startedAt: clock() };
    room.pendingPromotion = { promotionId, targetEmail: candidate.email, candidateWs: candidate.ws, timer };
    room.lastActivityAt = clock();
  }

  // ── WebSocket heartbeat tracking ──
  const wsMeta = new WeakMap();

  // ── HTTP server ──
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), version: '2.0', rooms: rooms.size }));
      return;
    }

    if (req.method === 'GET' && req.url === '/turn-credentials') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);

      const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.nextcloud.com:3478' },
      ];

      if (TURN_ENABLED) {
        iceServers.push({
          urls: [
            `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
            `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
          ],
          username: TURN_USER,
          credential: TURN_PASS,
        });
      }

      res.end(JSON.stringify({
        iceServers,
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 2,
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // ── WebSocket server ──
  const wss = new WebSocketServer({ server });

  // Periodic heartbeat
  const hbInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        wsMeta.delete(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, heartbeatInterval);

  wss.on('close', () => clearInterval(hbInterval));

  wss.on('connection', (ws) => {
    wsMeta.set(ws, { lastPong: clock() });
    ws.isAlive = true;
    ws.on('pong', () => {
      const meta = wsMeta.get(ws);
      if (meta) meta.lastPong = clock();
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const validationError = validateMessage(msg);
      if (validationError) {
        respond(ws, { type: 'error', message: validationError }, msg.requestId);
        return;
      }

      const requestId = msg.requestId;

      switch (msg.type) {
        // ── store-offer (creates room) ──
        case 'store-offer': {
          const normalizedEmail = normalizeEmail(msg.hostEmail);
          const room = createRoom(ws, normalizedEmail);
          const offerToken = genToken();
          room.offers.set(offerToken, { sdp: msg.sdp, offerId: msg.offerId });
          tokenRoom.set(offerToken, { roomId: room.roomId, role: 'host', createdAt: clock() });
          const hostToken = 'host:' + genToken();
          room.participants.set(hostToken, { ws, email: normalizedEmail, role: 'host' });
          room.lastActivityAt = clock();
          respond(ws, { type: 'token', token: offerToken, roomId: room.roomId, offerId: msg.offerId }, requestId);
          break;
        }

        // ── fetch-offer ──
        case 'fetch-offer': {
          const info = tokenRoom.get(msg.token);
          if (!info) { respond(ws, { type: 'error', message: 'Token not found or expired' }, requestId); return; }
          const room = rooms.get(info.roomId);
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }
          const offer = room.offers.get(msg.token);
          if (!offer) { respond(ws, { type: 'error', message: 'Offer not found' }, requestId); return; }
          room.lastActivityAt = clock();
          respond(ws, { type: 'offer', sdp: offer.sdp, offerId: offer.offerId, roomId: room.roomId }, requestId);
          break;
        }

        // ── submit-answer ──
        case 'submit-answer': {
          const info = tokenRoom.get(msg.token);
          if (!info) { respond(ws, { type: 'error', message: 'Token not found' }, requestId); return; }
          const room = rooms.get(info.roomId);
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          const normalizedEmail = normalizeEmail(msg.email);

          const peerToken = genToken();
          room.participants.set(peerToken, {
            ws,
            email: normalizedEmail,
            role: 'peer',
            pendingRequestWs: ws,
            _pendingSince: clock(),
          });
          tokenRoom.set(peerToken, { roomId: info.roomId, role: 'peer', createdAt: clock() });

          const existingMember = room.members.get(normalizedEmail);
          if (!existingMember) {
            let maxOrder = 0;
            for (const [, m] of room.members) { if (m.joinOrder > maxOrder) maxOrder = m.joinOrder; }
            room.members.set(normalizedEmail, { email: normalizedEmail, ws, joinOrder: maxOrder + 1 });
          } else {
            existingMember.ws = ws;
          }
          room.lastActivityAt = clock();

          if (room.hostWs && room.hostWs.readyState === 1) {
            const offer = room.offers.get(msg.token);
            room.hostWs.send(JSON.stringify({
              type: 'peer-request',
              token: peerToken,
              email: normalizedEmail,
              offerId: offer?.offerId,
              answerB64: msg.answerB64,
              roomId: room.roomId,
            }));
          }
          respond(ws, { type: 'waiting-approval' }, requestId);
          break;
        }

        // ── host-approve ──
        case 'host-approve': {
          const info = tokenRoom.get(msg.token);
          if (!info) { respond(ws, { type: 'error', message: 'Token not found' }, requestId); return; }
          const room = rooms.get(info.roomId);
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }
          const participant = room.participants.get(msg.token);
          if (participant && participant.pendingRequestWs && participant.pendingRequestWs.readyState === 1) {
            respond(participant.pendingRequestWs, { type: 'approved' }, requestId);
          }
          if (participant) participant.pendingRequestWs = undefined;
          room.lastActivityAt = clock();
          respond(ws, { type: 'host-approve-ack' }, requestId);
          break;
        }

        // ── host-reject ──
        case 'host-reject': {
          const info = tokenRoom.get(msg.token);
          if (!info) { respond(ws, { type: 'error', message: 'Token not found' }, requestId); return; }
          const room = rooms.get(info.roomId);
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }
          const participant = room.participants.get(msg.token);
          if (participant) {
            if (participant.pendingRequestWs?.readyState === 1) {
              respond(participant.pendingRequestWs, { type: 'rejected', message: 'Host rejected' }, requestId);
            }
            room.participants.delete(msg.token);
            tokenRoom.delete(msg.token);
          }
          room.lastActivityAt = clock();
          respond(ws, { type: 'host-reject-ack' }, requestId);
          break;
        }

        // ── become-host (v1 failover) ──
        case 'become-host': {
          const info = tokenRoom.get(msg.oldToken);
          if (!info) { respond(ws, { type: 'error', message: 'Old token not found' }, requestId); return; }
          const room = rooms.get(info.roomId);
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = undefined; }
          if (room.pendingPromotion) {
            clearTimeout(room.pendingPromotion.timer);
            room.pendingPromotion = undefined;
          }

          for (const p of (msg.peers || [])) {
            if (p.isHost || p.email === msg.hostEmail) continue;
            const token = msg.peerTokens?.[p.email];
            if (!token) continue;
            for (const [, participant] of room.participants) {
              if (participant.email === p.email && participant.ws.readyState === 1) {
                sendJson(participant.ws, { type: 'new-host', token, hostEmail: msg.hostEmail });
              }
            }
          }
          room.hostWs = ws;
          room.lastActivityAt = clock();
          respond(ws, { type: 'become-ok', token: msg.oldToken }, requestId);
          break;
        }

        // ── store-offer-next ──
        case 'store-offer-next': {
          const room = msg.roomId ? rooms.get(msg.roomId) : null;
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          if (room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = undefined;
            console.log(`[failover] room ${room.roomId}: host reconnected during grace period, canceling failover`);
          }
          if (room.pendingPromotion) {
            clearTimeout(room.pendingPromotion.timer);
            room.pendingPromotion = undefined;
          }
          room.hostWs = ws;

          const nextToken = genToken();
          room.offers.set(nextToken, { sdp: msg.sdp, offerId: msg.offerId });
          tokenRoom.set(nextToken, { roomId: room.roomId, role: 'host', createdAt: clock() });
          room.lastActivityAt = clock();
          respond(ws, { type: 'token', token: nextToken, offerId: msg.offerId, roomId: room.roomId }, requestId);
          break;
        }

        // ═══════════════════════════════════════════
        // v2.0: Promotion flow
        // ═══════════════════════════════════════════

        // ── promote-peer ──
        case 'promote-peer': {
          const room = msg.roomId ? rooms.get(msg.roomId) : null;
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          const normalizedTarget = normalizeEmail(msg.targetEmail);

          let target = undefined;
          for (const [, p] of room.participants) {
            if (p.email === normalizedTarget && p.role === 'peer') { target = p; break; }
          }
          if (!target) { respond(ws, { type: 'error', message: 'Target peer not found' }, requestId); return; }

          const promotionId = genToken();
          const participantList = [];
          for (const [, p] of room.participants) {
            participantList.push({ email: p.email, isHost: p.role === 'host' });
          }

          const oldHostEmail = [...room.participants.values()].find(p => p.role === 'host')?.email || 'unknown';
          sendJson(target.ws, {
            type: 'promotion-request',
            roomId: room.roomId,
            promotionId,
            targetEmail: normalizedTarget,
            oldHostEmail,
            participants: participantList,
            automatic: msg.automatic || false,
          });

          room._promotion = { promotionId, targetEmail: normalizedTarget, oldHostEmail, _startedAt: clock() };
          if (msg.automatic) {
            room.pendingPromotion = { promotionId, targetEmail: normalizedTarget, candidateWs: target.ws, timer: null };
          }
          room.lastActivityAt = clock();
          respond(ws, { type: 'promotion-ack', promotionId }, requestId);
          break;
        }

        // ── store-promotion-offer ──
        case 'store-promotion-offer': {
          const room = msg.roomId ? rooms.get(msg.roomId) : null;
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          const token = genToken();
          room.offers.set(token, {
            sdp: msg.sdp,
            offerId: msg.offerId,
            intendedEmail: msg.intendedEmail,
          });
          tokenRoom.set(token, { roomId: room.roomId, role: 'peer', createdAt: clock() });

          room.lastActivityAt = clock();
          respond(ws, { type: 'token', token, offerId: msg.offerId, promotionId: msg.promotionId }, requestId);
          break;
        }

        // ── commit-promotion ──
        case 'commit-promotion': {
          const room = msg.roomId ? rooms.get(msg.roomId) : null;
          if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

          const promotion = room._promotion;
          if (!promotion || promotion.promotionId !== msg.promotionId) {
            respond(ws, { type: 'error', message: 'Invalid promotion' }, requestId);
            return;
          }

          const reconnectTokens = msg.reconnectTokens || {};
          for (const [, participant] of room.participants) {
            if (participant.role === 'host') continue;
            const token = reconnectTokens[participant.email];
            if (!token || participant.ws.readyState !== 1) continue;
            sendJson(participant.ws, {
              type: 'new-host',
              token,
              hostEmail: promotion.targetEmail,
            });
          }

          room.hostWs = ws;

          for (const [, p] of room.participants) {
            if (p.email === promotion.targetEmail) p.role = 'host';
            else if (p.email === promotion.oldHostEmail) p.role = 'peer';
          }

          if (room.pendingPromotion &&
              room.pendingPromotion.promotionId === msg.promotionId) {
            clearTimeout(room.pendingPromotion.timer);
            room.pendingPromotion = undefined;
          }

          room.lastActivityAt = clock();
          respond(ws, { type: 'promotion-committed', promotionId: msg.promotionId }, requestId);
          delete room._promotion;
          break;
        }

        // ── ping/pong ──
        case 'ping': {
          respond(ws, { type: 'pong' }, requestId);
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const [roomId, room] of rooms) {
        const wasHost = room.hostWs === ws;

        if (wasHost) {
          room.hostWs = null;
          const departedHostEmail = [...room.participants.values()]
            .find(p => p.ws === ws)?.email || null;

          if (departedHostEmail) {
            console.log(`[failover] room ${roomId}: host ${departedHostEmail} disconnected, starting ${gracePeriod/1000}s grace period`);
            room.graceTimer = setTimeout(() => {
              room.graceTimer = undefined;
              console.log(`[failover] room ${roomId}: grace period expired, initiating auto failover`);
              initiateAutoFailover(room, departedHostEmail);
            }, gracePeriod);
          }
        }

        for (const [token, p] of room.participants) {
          if (p.ws === ws) {
            room.participants.delete(token);
            if (tokenRoom.get(token)?.role !== 'host') tokenRoom.delete(token);
          }
        }
      }
      wsMeta.delete(ws);
    });
  });

  // ── Cleanup: expire tokens, stale rooms, pending approvals, and promotions ──
  function hasActiveSocket(room) {
    for (const [, p] of room.participants) {
      if (p.ws && p.ws.readyState === 1) return true;
    }
    return false;
  }

  const cleanupInterval = setInterval(() => {
    const now = clock();

    // Expire individual tokens past their TTL
    for (const [tk, info] of tokenRoom) {
      if (now - info.createdAt > tokenTTL) {
        tokenRoom.delete(tk);
        // Also clean up the corresponding participant if no other tokens reference it
        const room = rooms.get(info.roomId);
        if (room) {
          room.offers.delete(tk);
          const participant = room.participants.get(tk);
          if (participant && ![...tokenRoom.values()].some(v => {
            for (const [, p] of room.participants) {
              if (p === participant && p !== room.participants.get(tk)) return true;
            }
            return false;
          })) {
            room.participants.delete(tk);
          }
        }
      }
    }

    // Expire rooms based on inactivity
    for (const [roomId, room] of rooms) {
      // Expire pending approvals past their TTL
      for (const [tk, p] of room.participants) {
        if (p.pendingRequestWs && p._pendingSince) {
          if (now - p._pendingSince > pendingApprovalTTL) {
            if (p.pendingRequestWs.readyState === 1) {
              sendJson(p.pendingRequestWs, { type: 'error', message: 'Approval timed out' });
            }
            p.pendingRequestWs = undefined;
            p._pendingSince = undefined;
            room.participants.delete(tk);
            tokenRoom.delete(tk);
          }
        }
      }

      // Expire promotion if past TTL
      if (room._promotion && room._promotion._startedAt) {
        if (now - room._promotion._startedAt > promotionTTL) {
          delete room._promotion;
          if (room.pendingPromotion) {
            clearTimeout(room.pendingPromotion.timer);
            room.pendingPromotion = undefined;
          }
        }
      }

      // Skip active rooms (have connected sockets)
      if (hasActiveSocket(room)) {
        room.lastActivityAt = now; // bump activity to prevent premature expiry
        continue;
      }

      // Expire inactive rooms
      if (now - room.lastActivityAt > roomInactivityTTL) {
        if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = undefined; }
        if (room.pendingPromotion) {
          clearTimeout(room.pendingPromotion.timer);
          room.pendingPromotion = undefined;
        }
        for (const [, p] of room.participants) {
          try { p.ws.close(); } catch {}
          if (p.pendingRequestWs) try { p.pendingRequestWs.close(); } catch {}
        }
        for (const [tk, info] of tokenRoom) {
          if (info.roomId === roomId) tokenRoom.delete(tk);
        }
        rooms.delete(roomId);
      }
    }
  }, 60_000);

  return {
    server,
    wss,

    /** Start the server on the configured port. Returns the actual port. */
    start(portOverride) {
      return new Promise((resolve, reject) => {
        const p = portOverride !== undefined ? portOverride : port;
        server.listen(p, () => {
          const addr = server.address();
          if (!addr) return reject(new Error('Server failed to start'));
          resolve(typeof addr === 'string' ? p : addr.port);
        });
      });
    },

    /** Gracefully stop the relay. */
    stop() {
      return new Promise((resolve) => {
        clearInterval(hbInterval);
        clearInterval(cleanupInterval);
        // Terminate all connected clients so wss.close() doesn't hang
        for (const ws of wss.clients) {
          ws.terminate();
        }
        wss.close(() => server.close(() => resolve()));
      });
    },

    /** Expose internal state for test assertions. */
    getState() {
      return {
        rooms: new Map(rooms),
        tokenRoom: new Map(tokenRoom),
      };
    },
  };
}

// Auto-start when run directly (not when imported by tests)
if (!process.env.VITEST && !process.env.VITEST_WORKER_ID) {
  const relay = createRelayServer();
  relay.start().then(port => console.log(`Relay listening on port ${port}`));
}
