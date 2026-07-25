# p2p-collab-files

Real-time collaborative markdown editor. Browser-to-browser P2P using WebRTC, [Yjs](https://github.com/yjs/yjs) CRDT, and CodeMirror 6 with Monokai theme. Built on [`@joverval/p2p-collab`](https://github.com/joverval/p2p-collab).

**Live:** [joverval.cl/p2p-collab-files](https://joverval.cl/p2p-collab-files/)

## Features

- **P2P WebRTC** — direct browser-to-browser data channels
- **Relay-assisted handshake** — automatic connection via WebSocket relay (`wss://relay.joverval.cl`)
- **Manual fallback** — copy-paste URLs for offline/GitHub Pages mode
- **Real-time sync** — Yjs CRDT with CodeMirror 6 editor (Monokai theme)
- **Multi-peer** — host-star topology, unlimited peers
- **Chat** — per-sender email identification, structured message protocol
- **Participant list** — room snapshot with host/peer roles, auto-updates
- **TURN fallback** — app-provided short-lived TURN credentials for restrictive networks
- **File support** — host opens `.md` files, peers save local copies
- **Security** — CSP hardened, XSS protected (textContent + DOMPurify), no secrets in frontend

## Quick Start

```bash
git clone https://github.com/joverval/p2p-collab-files
cd p2p-collab-files
npm install
```

**Development** (with relay auto-handshake):

```bash
npm run relay      # WebSocket relay on :8083
npm run dev        # Vite dev server on :8082
```

**Production** (GitHub Pages, manual mode):

```bash
npm run build      # outputs to dist/
```

The app auto-detects relay availability and falls back to manual copy-paste.

## How It Works

1. **Host** enters email → Create Room → gets invite link
2. **Host** shares link with peer
3. **Peer** opens link, enters email, submits answer
4. **Relay mode:** host approves → auto-connects via WebSocket handshake
5. **Manual mode:** peer copies answer URL → host pastes it → connects
6. Everyone edits in real-time, chat in sidebar

## Project Structure

```
├── index.html              # Single-page app with CSP meta tag
├── src/
│   ├── app.ts              # Composition root — wires controllers
│   ├── style.css           # Dark theme + Monokai editor
│   ├── shared/
│   │   ├── types.ts        # RoomSnapshot, ChatMessage, Participant
│   │   ├── dom.ts          # DOM utilities
│   │   └── dompurify-config.ts
│   ├── shell/
│   │   ├── session-controller.ts  # Room lifecycle, invites, TURN
│   │   ├── signaling-client.ts    # WebSocket relay client
│   │   ├── chat/                  # ChatController + message display
│   │   ├── participants/          # ParticipantsController + user list
│   │   ├── panels/                # PanelController — chat/users tabs
│   │   └── protocol/              # Message envelope, control messages
│   └── features/
│       └── markdown/              # CodeMirror 6 + Yjs + preview
├── server/
│   └── ws-relay.js         # WebSocket signaling relay
├── tests/
│   ├── unit/               # vitest + jsdom + mocked P2PRoom
│   └── e2e/                # Playwright browser tests
├── .github/workflows/      # CI (test.yml) + deploy (deploy.yml)
└── public/                 # favicon + vendor
```

## Protocol

Messages use a 1-byte prefix:

| Prefix | Purpose |
|--------|---------|
| `0x00` | Chat message (structured `ChatMessage`) |
| `0x01` | Yjs CRDT update |
| Control | `room-state` (RoomSnapshot), `chat`, `peer-request` |

## Testing

```bash
npm run typecheck     # TypeScript
npm run test:unit     # vitest (fast, mocked, no live servers)
npm run test:e2e      # Playwright (browser integration)
npm run test:smoke    # Relay protocol smoke (real WebSocket, no browser)
```

Tests use `vitest + jsdom + createMockRoom()` for unit coverage. Playwright E2E reserved for full browser flows only.

## Security

- **Content Security Policy** (meta tag): strict `script-src`, `connect-src`, `object-src 'none'`
- **XSS prevention:** `textContent` for user text, `DOMPurify` for markdown preview
- **No secrets in frontend:** TURN credentials are short-lived, fetched server-side, never in source
- **OPSEC:** `.hermes/`, `.cursorrules`, agent configs gitignored — never expose dev toolchain

## Infrastructure

- **Relay:** `wss://relay.joverval.cl` (WebSocket + `/turn-credentials` + `/healthz`)
- **Deploy:** GitHub Actions → GitHub Pages (CI must pass: typecheck, unit tests, build)
- **Monitoring:** GoatCounter analytics

## License

MIT