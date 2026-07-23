#!/bin/bash
export TURN_ENABLED=1
export TURN_HOST=181.43.195.152
export TURN_PORT=3478
export TURN_USER=turnuser
export TURN_PASS=turnpass-p2p-collab
cd /home/joverval/Projects/p2p-collab-files
exec node server/ws-relay.js