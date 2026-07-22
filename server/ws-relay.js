// p2p-collab WebSocket relay — opaque token handshake
// v1.2: host failover support — peers keep WS open, notify-peers routing

import { WebSocketServer } from 'ws';

const PORT = 8083;
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

// token → {
//   sdp, offerId, hostWs,
//   peersWs: Set<WebSocket>,  // passive peers (for notification routing)
//   pendingWs?: WebSocket,    // peer waiting for approval
//   answerB64?, email?,
//   created: number
// }
const tokens = new Map();

// Track role per connection: 'host' | 'peer'
const roles = new WeakMap();

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
      for (const pw of data.peersWs) pw.close();
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
        roles.set(ws, 'host');
        tokens.set(token, {
          sdp: msg.sdp,
          offerId: msg.offerId,
          hostWs: ws,
          peersWs: new Set(),
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
        roles.set(ws, 'peer');
        data.answerB64 = msg.answerB64;
        data.email = msg.email;
        data.pendingWs = ws;
        // Track peer for notifications
        data.peersWs.add(ws);
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
        if (!data || !data.pendingWs) return;
        data.pendingWs.send(JSON.stringify({ type: 'approved' }));
        data.pendingWs = undefined;
        // peer WS stays open for failover notifications
        break;
      }

      // ── Host: reject peer ──
      case 'host-reject': {
        const data = tokens.get(msg.token);
        if (!data || !data.pendingWs) return;
        data.pendingWs.send(JSON.stringify({ type: 'rejected', message: 'Host rejected' }));
        data.peersWs.delete(data.pendingWs);
        data.pendingWs.close();
        data.pendingWs = undefined;
        break;
      }

      // ── Peer (becoming host): notify all peers on old token ──
      case 'notify-peers': {
        const data = tokens.get(msg.oldToken);
        if (!data) {
          ws.send(JSON.stringify({ type: 'error', message: 'Old token not found' }));
          return;
        }
        // Broadcast new-host to all passive peers
        for (const pw of data.peersWs) {
          if (pw !== ws && pw.readyState === 1) {
            pw.send(JSON.stringify({
              type: 'new-host',
              token: msg.newToken,
              hostEmail: msg.hostEmail,
            }));
          }
        }
        // Transfer host ownership
        data.hostWs = ws;
        roles.set(ws, 'host');
        ws.send(JSON.stringify({ type: 'notify-ok', count: data.peersWs.size }));
        break;
      }

      // ── Host: re-register for multi-peer ──
      case 'store-offer-next': {
        const token = genToken();
        tokens.set(token, {
          sdp: msg.sdp,
          offerId: msg.offerId,
          hostWs: ws,
          peersWs: new Set(),
          created: Date.now(),
        });
        ws.send(JSON.stringify({ type: 'token', token, offerId: msg.offerId }));
        break;
      }

      // ── Peer: keep-alive ping (optional, prevents idle timeout) ──
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    // Clean up: remove from peersWs sets, delete tokens with no host
    for (const [token, data] of tokens) {
      data.peersWs.delete(ws);
      // If host disconnected and no peers, delete token
      if (data.hostWs === ws) {
        data.hostWs = null;
        if (data.peersWs.size === 0) {
          tokens.delete(token);
        }
      }
    }
  });
});

console.log(`WS relay v1.2 listening on :${PORT}`);