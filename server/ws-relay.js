// p2p-collab WebSocket relay v2.0 — stable rooms + one-time offers
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8083);
const TOKEN_TTL = 5 * 60 * 1000;
const ALLOWED_ORIGINS = (process.env.APP_ORIGINS || 'https://joverval.cl,http://localhost:8082').split(',');
const TURN_HOST = process.env.TURN_HOST || 'openrelay.metered.ca';

function randomId(bytes) { return crypto.randomBytes(bytes || 18).toString('base64url'); }
function normEmail(e) { return String(e).trim().toLowerCase(); }

const rooms = new Map();
const offers = new Map();
const wsMeta = new WeakMap();

setInterval(() => {
  const now = Date.now();
  for (const [token, o] of offers) { if (now - o.created > TOKEN_TTL) offers.delete(token); }
  for (const [roomId, r] of rooms) {
    if (now - r.lastActivityAt > 30 * 60 * 1000) {
      for (const [, ws] of r.members) ws.close();
      rooms.delete(roomId);
    }
  }
}, 60_000);

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, offers: offers.size }));
    return;
  }
  if (req.method === 'GET' && req.url === '/turn-credentials') {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
        { urls: [`turn:${TURN_HOST}:80?transport=udp`, `turn:${TURN_HOST}:80?transport=tcp`], username: 'openrelayproject', credential: 'openrelayproject' },
      ],
      iceTransportPolicy: 'all', iceCandidatePoolSize: 2,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'store-offer': {
        const roomId = randomId(), token = randomId();
        const email = normEmail(msg.hostEmail || 'host');
        rooms.set(roomId, { roomId, hostEmail: email, hostWs: ws, members: new Map(), pendingPromotion: null, createdAt: Date.now(), lastActivityAt: Date.now() });
        offers.set(token, { token, roomId, sdp: msg.sdp, offerId: msg.offerId, hostWs: ws, created: Date.now() });
        wsMeta.set(ws, { roomId, email, isHost: true });
        ws.send(JSON.stringify({ type: 'token', token, roomId, offerId: msg.offerId, requestId: msg.requestId }));
        break;
      }
      case 'store-offer-next': {
        const room = rooms.get(msg.roomId);
        if (!room || room.hostWs !== ws) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid room' })); return; }
        const token = randomId();
        offers.set(token, { token, roomId: msg.roomId, sdp: msg.sdp, offerId: msg.offerId, hostWs: ws, intendedEmail: msg.intendedEmail, promotionId: msg.promotionId, created: Date.now() });
        ws.send(JSON.stringify({ type: 'token', token, roomId: msg.roomId, offerId: msg.offerId, requestId: msg.requestId }));
        room.lastActivityAt = Date.now();
        break;
      }
      case 'fetch-offer': {
        const o = offers.get(msg.token);
        if (!o) { ws.send(JSON.stringify({ type: 'error', message: 'Token not found' })); return; }
        ws.send(JSON.stringify({ type: 'offer', sdp: o.sdp, offerId: o.offerId, roomId: o.roomId, requestId: msg.requestId }));
        break;
      }
      case 'submit-answer': {
        const o = offers.get(msg.token);
        if (!o) { ws.send(JSON.stringify({ type: 'error', message: 'Token not found' })); return; }
        o.answerB64 = msg.answerB64; o.email = msg.email; o.pendingWs = ws;
        const room = rooms.get(o.roomId);
        if (room) {
          room.hostWs.send(JSON.stringify({ type: 'peer-request', token: msg.token, roomId: o.roomId, email: msg.email, offerId: o.offerId, answerB64: msg.answerB64, promotionId: o.promotionId }));
          room.lastActivityAt = Date.now();
        }
        ws.send(JSON.stringify({ type: 'waiting-approval', requestId: msg.requestId }));
        break;
      }
      case 'host-approve': {
        const o = offers.get(msg.token);
        if (!o || !o.pendingWs) return;
        o.pendingWs.send(JSON.stringify({ type: 'approved', requestId: msg.requestId }));
        const room = rooms.get(o.roomId);
        if (room) {
          room.members.set(normEmail(o.email || o.pendingEmail || ''), o.pendingWs);
          wsMeta.set(o.pendingWs, { roomId: o.roomId, email: normEmail(o.email || ''), isHost: false });
          room.lastActivityAt = Date.now();
        }
        o.pendingWs = undefined;
        break;
      }
      case 'host-reject': {
        const o = offers.get(msg.token);
        if (!o || !o.pendingWs) return;
        o.pendingWs.send(JSON.stringify({ type: 'rejected', message: 'Host rejected' }));
        o.pendingWs.close(); o.pendingWs = undefined;
        break;
      }
      case 'promote-peer': {
        const room = rooms.get(msg.roomId);
        if (!room || room.hostWs !== ws) { ws.send(JSON.stringify({ type: 'error', message: 'Not host' })); return; }
        if (room.pendingPromotion) { ws.send(JSON.stringify({ type: 'error', message: 'Promotion in progress' })); return; }
        const targetEmail = normEmail(msg.targetEmail), targetWs = room.members.get(targetEmail);
        if (!targetWs) { ws.send(JSON.stringify({ type: 'error', message: 'Target not in room' })); return; }
        const promotionId = randomId();
        room.pendingPromotion = { promotionId, oldHostEmail: room.hostEmail, targetEmail, createdAt: Date.now() };
        targetWs.send(JSON.stringify({ type: 'promotion-request', roomId: msg.roomId, promotionId, oldHostEmail: room.hostEmail, targetEmail,
          participants: Array.from(room.members.entries()).map(([em]) => ({ email: em, isHost: em === room.hostEmail })),
        }));
        ws.send(JSON.stringify({ type: 'promotion-ack', promotionId, requestId: msg.requestId }));
        room.lastActivityAt = Date.now();
        break;
      }
      case 'store-promotion-offer': {
        const room = rooms.get(msg.roomId);
        if (!room || !room.pendingPromotion || room.pendingPromotion.promotionId !== msg.promotionId) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid promotion' })); return; }
        const token = randomId();
        offers.set(token, { token, roomId: msg.roomId, sdp: msg.sdp, offerId: msg.offerId, hostWs: ws, intendedEmail: msg.intendedEmail, promotionId: msg.promotionId, created: Date.now() });
        ws.send(JSON.stringify({ type: 'token', token, roomId: msg.roomId, offerId: msg.offerId, requestId: msg.requestId }));
        room.lastActivityAt = Date.now();
        break;
      }
      case 'commit-promotion': {
        const room = rooms.get(msg.roomId);
        if (!room || !room.pendingPromotion || room.pendingPromotion.promotionId !== msg.promotionId) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid promotion' })); return; }
        const prom = room.pendingPromotion, tokens = msg.reconnectTokens || {};
        for (const [email, token] of Object.entries(tokens)) {
          const o = offers.get(token);
          if (!o || o.roomId !== msg.roomId || o.promotionId !== msg.promotionId || o.intendedEmail !== email) { ws.send(JSON.stringify({ type: 'error', message: `Token mismatch for ${email}` })); return; }
        }
        const oldHostWs = room.hostWs, oldHostEmail = prom.oldHostEmail;
        room.hostWs = ws; room.hostEmail = prom.targetEmail;
        room.members.set(oldHostEmail, oldHostWs); room.members.delete(prom.targetEmail);
        wsMeta.set(ws, { roomId: msg.roomId, email: prom.targetEmail, isHost: true });
        wsMeta.set(oldHostWs, { roomId: msg.roomId, email: oldHostEmail, isHost: false });
        for (const [email, token] of Object.entries(tokens)) {
          const peerWs = room.members.get(email);
          if (peerWs && peerWs.readyState === WebSocket.OPEN) peerWs.send(JSON.stringify({ type: 'new-host', roomId: msg.roomId, promotionId: msg.promotionId, hostEmail: prom.targetEmail, token }));
        }
        ws.send(JSON.stringify({ type: 'promotion-committed', roomId: msg.roomId, promotionId: msg.promotionId, requestId: msg.requestId }));
        room.pendingPromotion = null; room.lastActivityAt = Date.now();
        break;
      }
      case 'ping': { ws.send(JSON.stringify({ type: 'pong' })); break; }
    }
  });
  ws.on('close', () => {
    const meta = wsMeta.get(ws);
    if (meta) { const room = rooms.get(meta.roomId); if (room) { room.members.delete(meta.email); if (meta.isHost) room.hostWs = null; } }
    for (const [token, o] of offers) { if (o.hostWs === ws || o.pendingWs === ws) offers.delete(token); }
  });
});

server.listen(PORT, () => console.log(`Relay v2.0 on :${PORT}`));