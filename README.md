# p2p-collab-files

Real-time collaborative markdown editor. Browser-to-browser P2P using WebRTC and [Yjs](https://github.com/yjs/yjs) CRDT. Built on [`@joverval/p2p-collab`](https://github.com/joverval/p2p-collab).

**Live:** [joverval.cl/p2p-collab-files](https://joverval.cl/p2p-collab-files/)

## Features

- **P2P** — WebRTC data channels, no servers needed
- **Real-time sync** — Yjs CRDT with CodeMirror 6 editor
- **Multi-peer** — host can accept unlimited peers
- **Two modes** — automatic WS relay (dev) or manual copy-paste (prod)
- **File support** — host opens `.md` files, peers save local copies
- **Chat** — slide-in sidebar with per-user identification
- **User list** — see all connected users with emails
- **Sequence + checksum** — integrity verification with auto-sync on mismatch
- **Reconnection** — host auto-generates new invite on peer disconnect

## How it works

1. **Host** enters email → Create Room → copies invite link
2. **Host** shares link with peers (Telegram, email, etc.)
3. **Peer** opens link → enters email → connects
4. **Manual mode:** peer copies answer link → sends to host → host pastes it
5. **Relay mode (dev):** host approves peer → auto-connects
6. Everyone edits in real-time, chat in sidebar

## Quick Start

```bash
git clone https://github.com/joverval/p2p-collab-files
cd p2p-collab-files
npm install
```

**Development** (with automatic handshake):

```bash
npm run relay      # WebSocket relay on :8083
npm run dev        # Vite dev server on :8082
```

**Production** (GitHub Pages, manual mode):

```bash
npm run build      # outputs to dist/
```

The app auto-detects whether the relay is available and falls back to manual copy-paste.

## Project Structure

```
├── index.html              # Single-page app
├── src/
│   ├── main.ts             # All app logic
│   └── style.css           # Dark theme
├── server/
│   └── ws-relay.js         # Dev WebSocket relay
├── public/vendor/
│   └── simplepeer.min.js   # simple-peer browser build
├── vendor/
│   └── simple-peer.js      # simple-peer wrapper
├── vite.config.ts
└── .github/workflows/deploy.yml
```

## Protocol

Messages use a 1-byte prefix:
- `0x00` — Chat text
- `0x01` — Yjs CRDT update (includes 2-byte sequence number)

Internal protocol messages (hidden from chat):
- `[USERS]` — User list broadcast
- `[EMAIL]` — Peer email announcement
- `[FILENAME]` — Filename sync
- `[CHKSUM]` — SHA-256 checksum every 10 updates
- `[SYNC]` — Full state request

## Integrity

Every Yjs update carries a monotonically increasing **sequence number**. Every 10 updates, the host broadcasts a **SHA-256 checksum** of the full document. Peers validate both:

| Condition | Action |
|-----------|--------|
| Seq mismatch | Sync button turns red |
| Checksum mismatch | Auto-sync from host |

## License

MIT