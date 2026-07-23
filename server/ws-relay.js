// p2p-collab WebSocket relay v2.0
// Stable rooms + per-participant tokens + promote-peer/commit-promotion
// Opaque token handshake with requestId echo for SignalingClient
// Backward compatible with v1.3 message format
// Exports createRelayServer factory for testability

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { validateIncoming, MAX_WS_PAYLOAD, MAX_OFFERS_PER_ROOM, MAX_PROMOTIONS_PER_ROOM } from './relay-schemas.js';
import { RateLimiter, IPTracker } from './rate-limiter.js';
import { generateTurnCredentials } from './auth.js';

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

// Rate limit defaults (from ADR-S6)
const DEFAULT_MAX_ROOMS_PER_IP = 10;
const DEFAULT_MAX_SOCKETS_PER_IP = 20;
const DEFAULT_MAX_OFFERS_PER_MIN = 30;
const DEFAULT_MAX_TURN_PER_MIN = 60;
const DEFAULT_MAX_PEERS_PER_ROOM = 50;

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
 * @param {number} [options.heartbeatInterval]  Heartbeat interval in ms. Default: 30s.
 * @param {object} [options.turnConfig]     TURN server config.
 * @param {number} [options.maxRoomsPerIP]  Max rooms per IP. Default: 10.
 * @param {number} [options.maxSocketsPerIP] Max WS connections per IP. Default: 20.
 * @param {number} [options.maxOffersPerMin] Max offers per IP per minute. Default: 30.
 * @param {number} [options.maxTurnPerMin]  Max /turn-credentials per IP per minute. Default: 60.
 * @param {number} [options.maxPeersPerRoom] Max peers per room. Default: 50.
 * @returns {{ server: http.Server, wss: WebSocketServer, start(port?: number): Promise<number>, stop(): Promise<void>, getState(): object }} */
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
    maxRoomsPerIP = DEFAULT_MAX_ROOMS_PER_IP,
    maxSocketsPerIP = DEFAULT_MAX_SOCKETS_PER_IP,
    maxOffersPerMin = DEFAULT_MAX_OFFERS_PER_MIN,
    maxTurnPerMin = DEFAULT_MAX_TURN_PER_MIN,
    maxPeersPerRoom = DEFAULT_MAX_PEERS_PER_ROOM,
    turnConfig: tc = null,
  } = options;

  // ── TURN config ──
  let TURN_ENABLED = false;
  let TURN_HOST = '';
  let TURN_PORT = 3478;
  let TURN_SECRET = '';
  let TURN_TTL = 3600;  // 60 min credential lifetime

  if (tc) {
    TURN_ENABLED = tc.enabled === true;
    TURN_HOST = tc.host || '';
    TURN_PORT = tc.port || 3478;
    TURN_SECRET = tc.secret || '';
    TURN_TTL = tc.ttl || 3600;
  } else {
    TURN_ENABLED = process.env.TURN_ENABLED === '1' || process.env.TURN_ENABLED === 'true';
    TURN_HOST = process.env.TURN_HOST || '';
    TURN_PORT = Number(process.env.TURN_PORT || 3478);
    TURN_SECRET = process.env.TURN_SECRET || '';
    TURN_TTL = Number(process.env.TURN_TTL || 3600);
  }

  if (TURN_ENABLED && !TURN_SECRET) {
    console.error('TURN_ENABLED=1 but TURN_SECRET not set. TURN disabled.');
    TURN_ENABLED = false;
  }

  if (TURN_ENABLED) {
    console.log(`TURN enabled: ${TURN_HOST}:${TURN_PORT} (HMAC-SHA1, ${TURN_TTL}s TTL, credentials rotate on relay restart)`);
  } else {
    console.log('TURN disabled — set TURN_ENABLED=1 and TURN_SECRET to enable');
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

  /** @type {Map<string, {roomId: string, role: string, createdAt: number, participantId?: string}>} */
  const tokenRoom = new Map();

  // ── Rate limiter instances ──
  const rateLimiter = new RateLimiter(60_000);
  const ipTracker = new IPTracker();

  function getRemoteIP(ws) {
    return ws._socket?.remoteAddress || 'unknown';
  }
  function getRemoteIPFromReq(req) {
    return req.socket?.remoteAddress || 'unknown';
  }

  // ── Privacy-safe logging ──
  // Never log SDP bodies, TURN creds, file content, chat content,
  // full invite URLs, raw tokens, or email addresses. Use opaque IDs
  // (roomId, participantId) where possible. Hash IPs and origins so
  // operators can still correlate without storing raw PII.
  function logSafe(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  }

  function createRoom(hostWs, hostEmail, creatorIP) {
    const roomId = genRoomId();
    const hostPid = genToken();
    const normalizedEmail = normalizeEmail(hostEmail) || 'host';
    const room = {
      roomId,
      hostWs,
      hostParticipantId: hostPid,
      participants: new Map(),
      offers: new Map(),
      promotionOffers: new Set(),
      created: clock(),
      members: new Map(),
      lastActivityAt: clock(),
      _creatorIP: creatorIP,
    };
    room.members.set(normalizedEmail, { participantId: hostPid, email: normalizedEmail, ws: hostWs, joinOrder: 1 });
    rooms.set(roomId, room);
    return room;
  }

  function normalizeEmail(email) {
    const trimmed = (email || '').trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 254) return null;
    // Reject control characters (ASCII 0-31 and DEL)
    if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }

  // ── Helpers ──
  function sendJson(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function respond(ws, base, requestId) {
    if (requestId) base.requestId = requestId;
    sendJson(ws, base);
  }

  // ── Identity helpers ──
  function getSenderInfo(ws) {
    for (const [roomId, room] of rooms) {
      for (const [pid, member] of room.members) {
        if (member.ws === ws) return { room, participantId: member.participantId, email: member.email };
      }
    }
    return null;
  }

  function getTokenInfo(token) {
    return tokenRoom.get(token) || null;
  }

  // ── Authorization guards ──
  function requireHost(ws, room, requestId) {
    const sender = getSenderInfo(ws);
    if (!sender) {
      respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not a room member' }, requestId);
      return false;
    }
    if (sender.participantId !== room.hostParticipantId) {
      respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Host only' }, requestId);
      return false;
    }
    return true;
  }

  function requirePromotionTarget(ws, room, requestId) {
    const sender = getSenderInfo(ws);
    if (!sender) {
      respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not a room member' }, requestId);
      return false;
    }
    const promotion = room._promotion;
    if (!promotion) {
      respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'No promotion in progress' }, requestId);
      return false;
    }
    // Authorize by participantId — no email lookup needed
    if (sender.participantId !== promotion.targetParticipantId) {
      respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not the promotion target' }, requestId);
      return false;
    }
    return true;
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
    console.log(`[failover] room ${room.roomId}: initiating auto promotion to ${candidate.participantId}`);

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
      console.log(`[failover] room ${room.roomId}: candidate ${candidate.participantId} timed out`);
      room.pendingPromotion = undefined;
      candidate._failed = true;
      initiateAutoFailover(room, departedHostEmail);
    }, candidateTimeout);

    room._promotion = { promotionId, targetEmail: candidate.email, targetParticipantId: candidate.participantId, oldHostEmail, _startedAt: clock() };
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
      // Rate limit per IP
      const ip = getRemoteIPFromReq(req);
      const ipKey = `turn:${ip}`;
      if (!rateLimiter.check(ipKey, maxTurnPerMin)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many requests' }));
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);

      const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.nextcloud.com:3478' },
      ];

      if (TURN_ENABLED) {
        // Time-limited HMAC-SHA1 credentials (coturn use-auth-secret mode)
        const creds = generateTurnCredentials(TURN_SECRET, TURN_TTL);
        iceServers.push({
          urls: [
            `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
            `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
          ],
          username: creds.username,
          credential: creds.password,
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

  // ── WebSocket server (noServer mode for path isolation) ──
  const wss = new WebSocketServer({ noServer: true });

  // Path-based WS upgrade with Origin validation
  server.on('upgrade', (request, socket, head) => {
    // Only serve WS on /ws path
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Origin validation
    const origin = request.headers.origin || '';
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && !origin) {
      console.warn('[security] WS upgrade rejected — no Origin header in production');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (origin && !allowedOrigins.includes(origin)) {
      console.warn(`[security] WS upgrade rejected — origin hash:${logSafe(origin)} not in allowlist`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Socket limit per IP
    const upgradeIP = request.socket?.remoteAddress || 'unknown';
    if (ipTracker.socketCount(upgradeIP) >= maxSocketsPerIP) {
      console.warn(`[security] WS upgrade rejected — IP hash:${logSafe(upgradeIP)} exceeded socket limit`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

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

    // Track socket per IP
    const wsIP = getRemoteIP(ws);
    ipTracker.trackSocket(wsIP, ws);

    ws.on('pong', () => {
      const meta = wsMeta.get(ws);
      if (meta) meta.lastPong = clock();
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      // Payload size check
      if (raw.byteLength > MAX_WS_PAYLOAD) {
        respond(ws, { type: 'error', code: 'PAYLOAD_TOO_LARGE', message: `Message exceeds ${MAX_WS_PAYLOAD} byte limit` });
        return;
      }

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        respond(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid JSON' });
        return;
      }

      const validation = validateIncoming(msg);
      if (!validation.ok) {
        respond(ws, { type: 'error', code: validation.error.code, message: validation.error.message }, msg.requestId);
        return;
      }

      const requestId = msg.requestId;

      switch (msg.type) {
        // ── store-offer (creates room) ──
        case 'store-offer': {
          const normalizedEmail = normalizeEmail(msg.hostEmail);
          if (!normalizedEmail) {
            respond(ws, { type: 'error', message: 'Invalid email: must be 254 chars max, no control characters' }, requestId);
            return;
          }

          // Room limit per IP
          const offerIP = getRemoteIP(ws);
          if (ipTracker.roomCount(offerIP) >= maxRoomsPerIP) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many rooms from this IP' }, requestId);
            return;
          }

          // Offer rate per IP
          const offerKey = `offer:${offerIP}`;
          if (!rateLimiter.check(offerKey, maxOffersPerMin)) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many offers, slow down' }, requestId);
            return;
          }

          const room = createRoom(ws, normalizedEmail, offerIP);
          ipTracker.trackRoom(offerIP, room.roomId);
          // Offer count per room
          if (room.offers.size >= MAX_OFFERS_PER_ROOM) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Room has too many outstanding offers' }, requestId);
            return;
          }
          const offerToken = genToken();
          room.offers.set(offerToken, { sdp: msg.sdp, offerId: msg.offerId });
          tokenRoom.set(offerToken, { roomId: room.roomId, role: 'host', createdAt: clock(), participantId: room.hostParticipantId });
          const hostToken = 'host:' + genToken();
          room.participants.set(hostToken, { ws, email: normalizedEmail, participantId: room.hostParticipantId, role: 'host' });
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

          // Peer limit per room
          if (ipTracker.peerCount(info.roomId) >= maxPeersPerRoom) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Room is full' }, requestId);
            return;
          }

          const normalizedEmail = normalizeEmail(msg.email);
          if (!normalizedEmail) {
            respond(ws, { type: 'error', message: 'Invalid email: must be 254 chars max, no control characters' }, requestId);
            return;
          }

          // Look up existing member to preserve participantId on reconnect
          const existingMember = room.members.get(normalizedEmail);
          const peerPid = existingMember ? existingMember.participantId : genToken();
          const peerToken = genToken();
          room.participants.set(peerToken, {
            ws,
            email: normalizedEmail,
            participantId: peerPid,
            role: 'peer',
            pendingRequestWs: ws,
            _pendingSince: clock(),
          });
          tokenRoom.set(peerToken, { roomId: info.roomId, role: 'peer', createdAt: clock(), participantId: peerPid });

          ipTracker.trackPeer(info.roomId, peerPid);

          if (!existingMember) {
            let maxOrder = 0;
            for (const [, m] of room.members) { if (m.joinOrder > maxOrder) maxOrder = m.joinOrder; }
            room.members.set(normalizedEmail, { participantId: peerPid, email: normalizedEmail, ws, joinOrder: maxOrder + 1 });
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

          if (!requireHost(ws, room, requestId)) return;
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

          if (!requireHost(ws, room, requestId)) return;
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

          // Authorization: the caller must be a room member
          const sender = getSenderInfo(ws);
          if (!sender || sender.room.roomId !== room.roomId) {
            respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not a room member' }, requestId);
            return;
          }

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

          if (!requireHost(ws, room, requestId)) return;

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

          // Offer count per room
          if (room.offers.size >= MAX_OFFERS_PER_ROOM) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Room has too many outstanding offers' }, requestId);
            return;
          }

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

          if (!requireHost(ws, room, requestId)) return;

          const normalizedTarget = normalizeEmail(msg.targetEmail);
          if (!normalizedTarget) {
            respond(ws, { type: 'error', message: 'Invalid target email: must be 254 chars max, no control characters' }, requestId);
            return;
          }

          // Resolve target by email from participants
          let target = undefined;
          let targetParticipantId = undefined;
          for (const [, p] of room.participants) {
            if (p.email === normalizedTarget && p.role === 'peer') {
              target = p;
              targetParticipantId = p.participantId;
              break;
            }
          }
          if (!target) { respond(ws, { type: 'error', message: 'Target peer not found' }, requestId); return; }

          const promotionId = genToken();
          const participantList = [];
          for (const [, p] of room.participants) {
            participantList.push({ email: p.email, isHost: p.role === 'host' });
          }

          const oldHost = [...room.participants.values()].find(p => p.role === 'host');
          const oldHostEmail = oldHost?.email || 'unknown';
          const oldHostParticipantId = oldHost?.participantId;

          sendJson(target.ws, {
            type: 'promotion-request',
            roomId: room.roomId,
            promotionId,
            targetEmail: normalizedTarget,
            targetParticipantId,
            oldHostEmail,
            participants: participantList,
            automatic: msg.automatic || false,
          });

          room._promotion = { promotionId, targetEmail: normalizedTarget, targetParticipantId, oldHostEmail, oldHostParticipantId, _startedAt: clock() };
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

          if (!requirePromotionTarget(ws, room, requestId)) return;

          // Offer count per room
          if (room.offers.size >= MAX_OFFERS_PER_ROOM) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Room has too many outstanding offers' }, requestId);
            return;
          }

          // Promotion offer count per room
          if (room.promotionOffers.size >= MAX_PROMOTIONS_PER_ROOM) {
            respond(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many active promotion offers' }, requestId);
            return;
          }

          const token = genToken();
          room.promotionOffers.add(token);
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

          if (!requirePromotionTarget(ws, room, requestId)) return;

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
            if (p.participantId === promotion.targetParticipantId) p.role = 'host';
            else if (p.participantId === promotion.oldHostParticipantId) p.role = 'peer';
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
          const departedHost = [...room.participants.values()]
            .find(p => p.ws === ws);
          const departedHostEmail = departedHost?.email || null;
          const departedHostPid = departedHost?.participantId || null;

          if (departedHostEmail) {
            console.log(`[failover] room ${roomId}: host ${departedHostPid} disconnected, starting ${gracePeriod/1000}s grace period`);
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
            if (p.participantId) ipTracker.untrackPeer(roomId, p.participantId);
            if (tokenRoom.get(token)?.role !== 'host') tokenRoom.delete(token);
          }
        }
      }
      wsMeta.delete(ws);
      ipTracker.untrackAllForWs(ws);
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

    // Expire individual tokens past their respective TTLs.
    // Offer tokens (role === 'host') use offerTTL; all others use tokenTTL.
    for (const [tk, info] of tokenRoom) {
      const ttl = info.role === 'host' ? offerTTL : tokenTTL;
      if (now - info.createdAt > ttl) {
        const room = rooms.get(info.roomId);
        if (room) {
          // Clean stale offer without deleting room
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
        tokenRoom.delete(tk);
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

      // Sweep orphaned offers: offers whose token no longer exists.
      // This covers tokens that were consumed (e.g. fetch-offer) but
      // not explicitly deleted from room.offers.
      for (const [offerKey] of room.offers) {
        if (!tokenRoom.has(offerKey)) {
          room.offers.delete(offerKey);
          room.promotionOffers.delete(offerKey);
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
        // Untrack from IP tracker
        ipTracker.roomPeers.delete(roomId);
        if (room._creatorIP) ipTracker.untrackRoom(room._creatorIP, roomId);
        rooms.delete(roomId);
      }
    }

    // Cleanup stale rate-limiter entries
    rateLimiter.cleanup();
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
