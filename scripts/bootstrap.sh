#!/usr/bin/env bash
# bootstrap.sh — one-command setup for p2p-collab-files
#
# Clones the sibling @joverval/p2p-collab library, builds it,
# and installs app dependencies. Run once after cloning.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$PROJECT_DIR/../p2p-collab"

echo "=== Bootstrap p2p-collab-files ==="

# 1. Clone or update the sibling library
if [ -d "$LIB_DIR" ]; then
  echo "📦 Library already exists at $LIB_DIR — pulling latest..."
  cd "$LIB_DIR" && git pull
else
  echo "📦 Cloning @joverval/p2p-collab..."
  git clone https://github.com/joverval/p2p-collab.git "$LIB_DIR"
fi

# 2. Build the library
echo "🔨 Building @joverval/p2p-collab..."
cd "$LIB_DIR"
npm ci
npm run build

# 3. Install app dependencies + dompurify
echo "📦 Installing app dependencies..."
cd "$PROJECT_DIR"
npm ci

# 4. Verify
echo "✅ Bootstrap complete. Run: npm run dev"
npm run typecheck
echo "  TypeScript: OK"