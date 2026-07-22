// p2p-collab WebSocket relay — opaque token handshake
// Stores SDP offers under 12-char tokens, relays answers to host, auto-cleans on connect/close

import { WebSocketServer } from 'ws';

const PORT = 8083;
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

// token → { sdp, offerId, hostWs, answerB64?, email?, peerWs? }
const tokens = new Map();

const wss = new WebSocketServer({ port: PORT });

function genToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 12; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// Cleanup expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokens) {
    if (now - data.created > TOKEN_TTL) {
      if (data.peerWs) data.peerWs.close();
      tokens.delete(token);
    }
  }
}, 60_000);

wss.on('connection', (ws) => {

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── Host: store SDP offer under a token ──
      case 'store-offer': {
        const token = genToken();
        tokens.set(token, {
          sdp: msg.sdp,
          offerId: msg.offerId,
          hostWs: ws,
          created: Date.now(),
        });
        ws.send(JSON.stringify({ type: 'token', token, offerId: msg.offerId }));
        break;
      }

      // ── Peer: fetch SDP offer by token ──
      case 'fetch-offer': {
        const data = tokens.get(msg.token);
        if (!data) {
          ws.send(JSON.stringify({ type: 'error', message: 'Token not found or expired' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'offer', sdp: data.sdp, offerId: data.offerId }));
        break;
      }

      // ── Peer: submit answer to host ──
      case 'submit-answer': {
        const data = tokens.get(msg.token);
        if (!data) {
          ws.send(JSON.stringify({ type: 'error', message: 'Token not found' }));
          return;
        }
        // Store answer + peer info
        data.answerB64 = msg.answerB64;
        data.email = msg.email;
        data.peerWs = ws;
        // Forward to host
        data.hostWs.send(JSON.stringify({
          type: 'peer-request',
          token: msg.token,
          email: msg.email,
          offerId: data.offerId,
          answerB64: msg.answerB64,
        }));
        ws.send(JSON.stringify({ type: 'waiting-approval' }));
        break;
      }

      // ── Host: approve peer ──
      case 'host-approve': {
        const data = tokens.get(msg.token);
        if (!data || !data.peerWs) return;
        data.peerWs.send(JSON.stringify({ type: 'approved' }));
        break;
      }

      // ── Host: reject peer ──
      case 'host-reject': {
        const data = tokens.get(msg.token);
        if (!data || !data.peerWs) return;
        data.peerWs.send(JSON.stringify({ type: 'rejected', message: 'Host rejected' }));
        data.peerWs.close();
        break;
      }

      // ── Host: delete token after connection ──
      case 'delete-offer': {
        const data = tokens.get(msg.token);
        if (data) tokens.delete(msg.token);
        break;
      }

      // ── Host: re-register for multi-peer (new offer under same host WS) ──
      case 'store-offer-next': {
        const token = genToken();
        tokens.set(token, {
          sdp: msg.sdp,
          offerId: msg.offerId,
          hostWs: ws,
          created: Date.now(),
        });
        ws.send(JSON.stringify({ type: 'token', token, offerId: msg.offerId }));
        break;
      }
    }
  });

  ws.on('close', () => {
    // Clean up tokens owned by this connection
    for (const [token, data] of tokens) {
      if (data.hostWs === ws || data.peerWs === ws) {
        tokens.delete(token);
      }
    }
  });
});

console.log(`WS relay listening on :${PORT}`);