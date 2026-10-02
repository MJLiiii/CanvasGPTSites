#!/usr/bin/env bash
# Fetches the upstream Python server this port is derived from, pinned to the
# commit the port was written against. The checkout is reference material only
# (gitignored) and is never bundled.
set -euo pipefail

UPSTREAM_REPO="https://github.com/vishalsachdev/canvas-mcp.git"
UPSTREAM_SHA="14fb51d0b1337707867494213e59509453bf5558"
DEST="$(cd "$(dirname "$0")/.." && pwd)/.upstream/canvas-mcp"

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$(dirname "$DEST")"
  git clone "$UPSTREAM_REPO" "$DEST"
fi
git -C "$DEST" fetch origin "$UPSTREAM_SHA"
git -C "$DEST" checkout --detach "$UPSTREAM_SHA"
echo "upstream canvas-mcp at $UPSTREAM_SHA in $DEST"
