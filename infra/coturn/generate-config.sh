#!/bin/bash
# Generate turnserver.conf from .env
set -euo pipefail

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example and edit it first."
  exit 1
fi

# Source .env
set -a; source .env; set +a

if [ "$TURN_SECRET" = "replace-me" ]; then
  echo "ERROR: Edit .env and set TURN_SECRET first."
  exit 1
fi

# Substitute variables
envsubst < turnserver.conf.template > generated-turnserver.conf

echo "✅ generated-turnserver.conf ready"
echo "   Run: docker compose up -d"