# Coturn TURN server

Self-hosted TURN/STUN relay for p2p-collab-files. Used only when direct P2P ICE fails.

## Architecture

```
Mobile Peer                    Home Router              Mini-PC (coturn)
     │                            │                        │
     │── UDP 3478 ───────────────▶│── port forward ───────▶│
     │                            │                        │
     │── WebRTC relay ────────────────────────────────────▶│
```

TURN traffic is DTLS-encrypted end-to-end. The server cannot read content.

## Setup

### 1. DNS
Add A record: `turn.joverval.cl` → your public IP

### 2. Router port forwarding
Forward these ports to your mini-PC LAN IP:

| Protocol | External Port | Internal Port |
|----------|---------------|---------------|
| UDP | 3478 | 3478 |
| TCP | 3478 | 3478 |
| TCP | 5349 | 5349 |
| UDP | 49160-49259 | 49160-49259 |

### 3. Firewall
```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49259/udp
```

### 4. Generate secret
```bash
openssl rand -hex 32
```

### 5. Configure and start
```bash
cp .env.example .env
# Edit .env with your secret and domain
chmod +x generate-config.sh && ./generate-config.sh
docker compose up -d
docker compose logs -f coturn
```

### 6. Validate
```bash
# From outside your network:
nc -u -z YOUR_PUBLIC_IP 3478 && echo "UDP reachable"
curl -sI telnet://YOUR_PUBLIC_IP:3478 | head -1
```

## Cloudflare notes

- **Cloudflare Tunnel does NOT support UDP** — TURN needs direct port exposure
- **Cloudflare Spectrum** (paid) can proxy TCP 3478/5349 but NOT UDP relay ports
- DNS `turn.joverval.cl` should be **gray-clouded** (DNS only, not proxied) for UDP to work
- TCP TURN on 3478 CAN be proxied through Cloudflare (orange cloud) if needed

## Security

- Credentials are short-lived (600s nonce)
- Per-user quota: 12 allocations
- Total quota: 200 allocations
- No public admin interface
- Monitor with `docker compose logs`