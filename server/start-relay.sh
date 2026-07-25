#!/bin/bash
# p2p-collab relay startup — set TURN env vars from .env (production) or env (dev)
# Production: create server/.env with TURN_ENABLED=1, TURN_SECRET, TURN_HOST

cd /home/joverval/Projects/p2p-collab-files

# Source .env if present (production secrets)
if [ -f server/.env ]; then
  set -a; source server/.env; set +a
fi

export TURN_ENABLED="${TURN_ENABLED:-0}"
export TURN_PORT="${TURN_PORT:-3478}"
export TURN_SECRET="${TURN_SECRET:-}"
export TURN_HOST="${TURN_HOST:-}"

# Auto-detect TURN_HOST from public IP if TURN is enabled but host isn't set
if [ "$TURN_ENABLED" = "1" ] && [ -z "$TURN_HOST" ]; then
  TURN_HOST=$(curl -s --connect-timeout 5 ifconfig.me/ip 2>/dev/null || \
              curl -s --connect-timeout 5 icanhazip.com 2>/dev/null || \
              curl -s --connect-timeout 5 api.ipify.org 2>/dev/null || echo "")
  if [ -n "$TURN_HOST" ]; then
    export TURN_HOST
    echo "Auto-detected TURN_HOST: $TURN_HOST"
  fi
fi

if [ "$TURN_ENABLED" = "1" ]; then
  echo "Relay starting — TURN enabled ($TURN_HOST:$TURN_PORT)"
else
  echo "Relay starting — TURN disabled"
fi

exec node server/ws-relay.js