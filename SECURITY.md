# Security Policy

## Reporting a Vulnerability

Do NOT open a public issue. Send details to j@joverval.cl.

Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Any proposed fixes

Response within 48 hours. We will coordinate disclosure timing.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark:  |

## Security Model

p2p-collab-files uses WebRTC for direct P2P communication between browsers. A lightweight WebSocket relay handles signaling (offer/answer exchange). No file contents or document data pass through the relay.

- **Signaling relay:** WebSocket (wss://) with origin validation, Zod schema enforcement, per-operation authorization, and rate limiting
- **TURN:** Optional coturn relay with time-limited HMAC credentials (30-min TTL). Only activated when direct P2P fails.
- **WebRTC:** DTLS-SRTP encryption, browser-native
- **Client:** DOMPurify on all user-rendered content, textContent-only chat rendering, no innerHTML
