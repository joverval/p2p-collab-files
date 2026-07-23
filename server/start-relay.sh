#!/bin/bash
export TURN_ENABLED="${TURN_ENABLED:-0}"
export TURN_PORT="${TURN_PORT:-3478}"
export TURN_SECRET="${TURN_SECRET:-}"
# TURN_HOST is auto-detected via public IP
cd /home/joverval/Projects/p2p-collab-files
if [ "$TURN_ENABLED" = "1" ]; then
  echo "Relay starting — TURN enabled"
else
  echo "Relay starting — TURN disabled"
fi
exec node server/ws-relay.js