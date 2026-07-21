# p2p-collab-files

Real-time collaborative markdown editor built on [`@joverval/p2p-collab`](https://github.com/joverval/p2p-collab). Pure browser-to-browser — no servers, no accounts, no infrastructure.

## Features

- **P2P connections** via WebRTC data channels — no signaling server
- **Automatic handshake** via local WebSocket relay (development convenience)
- **Real-time sync** with [Yjs](https://github.com/yjs/yjs) CRDT
- **Markdown editing** with [CodeMirror 6](https://codemirror.net/) syntax highlighting
- **Multi-peer**: host can accept multiple peers simultaneously
- **File support**: host opens `.md` files from disk, peers can save local copies
- **Email identification**: each user identifies with an email, shown in chat and user list
- **Approve/reject**: host must approve each peer before they can join

## How it works

1. **Host** enters their email and clicks "Create Room" → gets a shareable URL
2. **Host** shares the URL with peers (Telegram, email, etc.)
3. **Peer** opens the URL, enters their email, and requests to join
4. **Host** approves (or rejects) the peer
5. Both can now edit the document in real-time and chat

The host is the authoritative source — all edits flow through the host, which broadcasts to all connected peers.

## Quick Start

```bash
git clone https://github.com/joverval/p2p-collab-files
cd p2p-collab-files
npm install
```

Start the WebSocket relay (for automated handshake):

```bash
npm run relay
```

In another terminal, start the dev server:

```bash
npm run dev
```

Open `http://localhost:8082/` in two browser tabs to test.

> **Note:** The WebSocket relay on port 8083 is a development convenience for automatic SDP exchange. In production, you'd replace this with any out-of-band signaling mechanism (QR codes, clipboard, messaging apps) since the underlying library uses URL-encoded SDP and needs no persistent server.

## Project Structure

```
├── index.html          # Single-page app
├── src/
│   ├── main.ts         # All app logic (UI, Yjs, CodeMirror, file access)
│   ├── style.css       # Dark theme styles
│   └── vite-env.d.ts   # Vite type declarations
├── server/
│   └── ws-relay.js     # WebSocket relay for automatic handshake
├── vendor/
│   ├── simple-peer.js  # simple-peer wrapper for Vite
│   └── simplepeer.min.js  # simple-peer browser build (CDN)
├── vite.config.ts      # Vite config (aliases for library + simple-peer)
└── package.json
```

## Architecture

```
┌─────────────────────────────────────────┐
│              p2p-collab-files            │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │CodeMirror│ │   Yjs    │ │  Chat   │  │
│  │  Editor  │ │  CRDT    │ │   UI    │  │
│  └────┬─────┘ └────┬─────┘ └────┬────┘  │
│       │             │            │       │
│  ┌────┴─────────────┴────────────┴────┐  │
│  │         Message Framing            │  │
│  │     (0x00 = chat, 0x01 = Yjs)     │  │
│  └────────────────┬───────────────────┘  │
│                   │                      │
├───────────────────┼──────────────────────┤
│  @joverval/p2p-collab (library)          │
│  ┌────────────────┴───────────────────┐  │
│  │     WebRTC + URL SDP signaling     │  │
│  └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Dependencies

- [`@joverval/p2p-collab`](https://github.com/joverval/p2p-collab) — WebRTC P2P transport
- [CodeMirror 6](https://codemirror.net/) — Code editor
- [Yjs](https://github.com/yjs/yjs) — CRDT for real-time collaboration
- [ws](https://github.com/websockets/ws) — WebSocket relay (dev only)

## License

MIT