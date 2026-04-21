#!/bin/bash
# JARVIS — full build & start
# Builds UI (Vite), then starts the backend (tsx).
# Used by: manual start, jarvis_reset, any restart flow.

set -e

JARVIS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$JARVIS_DIR"

echo "▸ Building UI..."
(cd ui && npm run build) 2>&1 | tail -3

echo "▸ Starting JARVIS..."
exec npx tsx src/main.ts
