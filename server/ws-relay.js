// p2p-collab WebSocket relay + HTTP API
// Opaque token handshake with health/credentials endpoints

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8083);
const TOKEN_TTL = 5 * 60 * 1000;
const ALLOWED_ORIGINS = (process.env.APP_ORIGINS || 'https://joverval.cl,http://localhost:8082').split(',');
const TURN_HOST = process.env.TURN_HOST || 'openrelay.metered.ca';

// token storage (same as before)
const tokens = new Map();
const roles = new WeakMap();

function genToken() {
  return crypto.randomBytes(18).toString('base64url');
}

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokens) {
    if (now - data.created > TOKEN_TTL) {
      for (const pw of data.peersWs) pw.close();
      tokens.delete(token);
    }
  }
}, 60_000);

// ── HTTP server ──
const server = http.createServer((req, res) => {
  // CORS
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // TURN credentials (static OpenRelay for now; coturn time-limited later)
  if (req.method === 'GET' && req.url === '/turn-credentials') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            `turn:${TURN_HOST}:80?transport=udp`,
            `turn:${TURN_HOST}:80?transport=tcp`,
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
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

    switch (msg.type) {
      case 'store-offer': {
        const token = genToken();
        roles.set(ws, 'host');
        tokens.set(token, { sdp: msg.sdp, offerId: msg.offerId, hostWs: ws, peersWs: new Set(), created: Date.now() });
        ws.send(JSON.stringify({ type: 'token', token, offerId: msg.offerId }));
        break;
      }
      case 'fetch-offer': {
        const data = tokens.get(msg.token);
        if (!data) { ws.send(JSON.stringify({ type: 'error', message: 'Token not found or expired' })); return; }
        ws.send(JSON.stringify({ type: 'offer', sdp: data.sdp, offerId: data.offerId }));
        break;
      }
      case 'submit-answer': {
        const data = tokens.get(msg.token);
        if (!data) { ws.send(JSON.stringify({ type: 'error', message: 'Token not found' })); return; }
        roles.set(ws, 'peer');
        data.answerB64 = msg.answerB64; data.email = msg.email; data.pendingWs = ws;
        data.peersWs.add(ws);
        data.hostWs.send(JSON.stringify({ type: 'peer-request', token: msg.token, email: msg.email, offerId: data.offerId, answerB64: msg.answerB64 }));
        ws.send(JSON.stringify({ type: 'waiting-approval' }));
        break;
      }
      case 'host-approve': {
        const data = tokens.get(msg.token);
        if (!data || !data.pendingWs) return;
        data.pendingWs.send(JSON.stringify({ type: 'approved' }));
        data.pendingWs = undefined;
        break;
      }
      case 'host-reject': {
        const data = tokens.get(msg.token);
        if (!data || !data.pendingWs) return;
        data.pendingWs.send(JSON.stringify({ type: 'rejected', message: 'Host rejected' }));
        data.peersWs.delete(data.pendingWs);
        data.pendingWs.close();
        data.pendingWs = undefined;
        break;
      }
      case 'become-host': {
        const oldData = tokens.get(msg.oldToken);
        if (!oldData) { ws.send(JSON.stringify({ type: 'error', message: 'Old token not found' })); return; }
        for (const p of (msg.peers || [])) {
          if (p.isHost || p.email === msg.hostEmail) continue;
          const token = msg.peerTokens?.[p.email];
          if (!token) continue;
          for (const pw of oldData.peersWs) {
            if (pw.readyState === 1) pw.send(JSON.stringify({ type: 'new-host', token, hostEmail: msg.hostEmail }));
          }
        }
        oldData.hostWs = ws; roles.set(ws, 'host');
        for (const pw of oldData.peersWs) pw.close();
        oldData.peersWs.clear();
        ws.send(JSON.stringify({ type: 'become-ok', token: msg.oldToken }));
        break;
      }
      case 'store-offer-next': {
        const token = genToken();
        tokens.set(token, { sdp: msg.sdp, offerId: msg.offerId, hostWs: ws, peersWs: new Set(), created: Date.now() });
        ws.send(JSON.stringify({ type: 'token', token, offerId: msg.offerId }));
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const [token, data] of tokens) {
      data.peersWs.delete(ws);
      if (data.hostWs === ws) { data.hostWs = null; if (data.peersWs.size === 0) tokens.delete(token); }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Relay v1.3 listening on :${PORT} (HTTP + WS)`);
});