// p2p-collab WebSocket relay v2.0
// Stable rooms + per-participant tokens + promote-peer/commit-promotion
// Opaque token handshake with requestId echo for SignalingClient
// Backward compatible with v1.3 message format

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8083);
const TOKEN_TTL = 5 * 60 * 1000;
const ALLOWED_ORIGINS = (process.env.APP_ORIGINS || 'https://joverval.cl,http://localhost:8082').split(',');

function genToken() {
  return crypto.randomBytes(18).toString('base64url');
}
function genRoomId() {
  return crypto.randomBytes(12).toString('base64url');
}

// ── Room state ──

/** @type {Map<string, {roomId: string, hostWs: WebSocket|null, participants: Map<string,{ws:WebSocket,email:string,role:string,pendingRequestWs?:WebSocket}>, offers: Map<string,{sdp:string,offerId:string,intendedEmail?:string}>, created: number}>} */
const rooms = new Map();

/** @type {Map<string, {roomId: string, role: string}>} */
const tokenRoom = new Map();

function createRoom(hostWs) {
  const roomId = genRoomId();
  const room = { roomId, hostWs, participants: new Map(), offers: new Map(), created: Date.now() };
  rooms.set(roomId, room);
  return room;
}

function sendJson(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function respond(ws, base, requestId) {
  if (requestId) base.requestId = requestId;
  sendJson(ws, base);
}

// Cleanup expired rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.created > TOKEN_TTL) {
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

// ── HTTP server ──
const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
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
    res.end(JSON.stringify({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.nextcloud.com:3478' },
      ],
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

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const requestId = msg.requestId;

    switch (msg.type) {
      // ── store-offer (creates room) ──
      case 'store-offer': {
        const room = createRoom(ws);
        const offerToken = genToken();
        room.offers.set(offerToken, { sdp: msg.sdp, offerId: msg.offerId });
        tokenRoom.set(offerToken, { roomId: room.roomId, role: 'host' });
        // Register host as participant
        const hostToken = 'host:' + genToken();
        room.participants.set(hostToken, { ws, email: msg.hostEmail || 'Host', role: 'host' });
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
        respond(ws, { type: 'offer', sdp: offer.sdp, offerId: offer.offerId, roomId: room.roomId }, requestId);
        break;
      }

      // ── submit-answer ──
      case 'submit-answer': {
        const info = tokenRoom.get(msg.token);
        if (!info) { respond(ws, { type: 'error', message: 'Token not found' }, requestId); return; }
        const room = rooms.get(info.roomId);
        if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

        // Generate unique peer token for approve/reject
        const peerToken = genToken();
        room.participants.set(peerToken, {
          ws,
          email: msg.email,
          role: 'peer',
          pendingRequestWs: ws,
        });
        tokenRoom.set(peerToken, { roomId: info.roomId, role: 'peer' });

        // Notify host with the peer-specific token
        if (room.hostWs && room.hostWs.readyState === 1) {
          const offer = room.offers.get(msg.token);
          room.hostWs.send(JSON.stringify({
            type: 'peer-request',
            token: peerToken,
            email: msg.email,
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
        if (!info) return;
        const room = rooms.get(info.roomId);
        if (!room) return;
        const participant = room.participants.get(msg.token);
        if (participant && participant.pendingRequestWs && participant.pendingRequestWs.readyState === 1) {
          respond(participant.pendingRequestWs, { type: 'approved' });
        }
        if (participant) participant.pendingRequestWs = undefined;
        break;
      }

      // ── host-reject ──
      case 'host-reject': {
        const info = tokenRoom.get(msg.token);
        if (!info) return;
        const room = rooms.get(info.roomId);
        if (!room) return;
        const participant = room.participants.get(msg.token);
        if (participant) {
          if (participant.pendingRequestWs?.readyState === 1) {
            respond(participant.pendingRequestWs, { type: 'rejected', message: 'Host rejected' });
          }
          room.participants.delete(msg.token);
          tokenRoom.delete(msg.token);
        }
        break;
      }

      // ── become-host (v1 failover) ──
      case 'become-host': {
        const info = tokenRoom.get(msg.oldToken);
        if (!info) { respond(ws, { type: 'error', message: 'Old token not found' }, requestId); return; }
        const room = rooms.get(info.roomId);
        if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }

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
        respond(ws, { type: 'become-ok', token: msg.oldToken }, requestId);
        break;
      }

      // ── store-offer-next ──
      case 'store-offer-next': {
        const room = msg.roomId ? rooms.get(msg.roomId) : null;
        if (!room) { respond(ws, { type: 'error', message: 'Room not found' }, requestId); return; }
        const nextToken = genToken();
        room.offers.set(nextToken, { sdp: msg.sdp, offerId: msg.offerId });
        tokenRoom.set(nextToken, { roomId: room.roomId, role: 'host' });
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

        let target = undefined;
        for (const [, p] of room.participants) {
          if (p.email === msg.targetEmail && p.role === 'peer') { target = p; break; }
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
          targetEmail: msg.targetEmail,
          oldHostEmail,
          participants: participantList,
        });

        room._promotion = { promotionId, targetEmail: msg.targetEmail, oldHostEmail };
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
        tokenRoom.set(token, { roomId: room.roomId, role: 'peer' });

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

        respond(ws, { type: 'promotion-committed', promotionId: msg.promotionId }, requestId);
        delete room._promotion;
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const [roomId, room] of rooms) {
      if (room.hostWs === ws) room.hostWs = null;
      for (const [token, p] of room.participants) {
        if (p.ws === ws) {
          room.participants.delete(token);
          // Only delete tokenRoom entry if it's a peer (host tokens are synthetic)
          if (tokenRoom.get(token)?.role !== 'host') tokenRoom.delete(token);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Relay v2.0 listening on :${PORT} (HTTP + WS)`);
});