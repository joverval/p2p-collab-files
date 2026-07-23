#!/bin/bash
export TURN_ENABLED=1
export TURN_HOST=$(curl -s ifconfig.me)
export TURN_PORT=3478
export TURN_USER=turnuser
export TURN_PASS=turnpass-p2p-collab
cd /home/joverval/Projects/p2p-collab-files
echo "Relay starting — TURN at ${TURN_HOST}:${TURN_PORT}"
exec node server/ws-relay.js