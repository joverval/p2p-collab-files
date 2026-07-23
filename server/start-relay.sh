#!/bin/bash
export TURN_ENABLED=1
export TURN_PORT=3478
export TURN_USER="${TURN_USER:-turnuser}"
export TURN_PASS="${TURN_PASS:-}"
# TURN_HOST is auto-detected by relay every 5min
cd /home/joverval/Projects/p2p-collab-files
echo "Relay starting — TURN enabled (auto-detect IP)"
exec node server/ws-relay.js