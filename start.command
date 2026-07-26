#!/bin/bash
set -e

TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE_BIN" ]; then
  for CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$CANDIDATE" ]; then
      NODE_BIN="$CANDIDATE"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "找不到 Node.js。請先從 https://nodejs.org/ 安裝 Node.js。"
  echo
  read -r -p "按 Enter 結束"
  exit 1
fi

cd "$TOOL_DIR"
export OPEN_BROWSER=1
exec "$NODE_BIN" "$TOOL_DIR/server.js"
