#!/usr/bin/env bash
# npm run build:wa-bridge: builds whatsapp-bridge/whatsapp-bridge, the binary the app starts for each live WhatsApp number.
set -euo pipefail
cd "$(dirname "$0")/../whatsapp-bridge"
want=$(awk '/^go /{print $2}' go.mod)
if ! command -v go >/dev/null; then
  echo "Go $want or newer is needed to build the WhatsApp bridge. Install it from https://go.dev/dl/ and run npm run build:wa-bridge again." >&2
  exit 1
fi
# github.com/mattn/go-sqlite3 is cgo, so the build needs a C compiler
if ! command -v "${CC:-cc}" >/dev/null; then
  echo "The WhatsApp bridge needs a C compiler (its SQLite driver uses cgo). Install one (Xcode Command Line Tools on a Mac, build-essential on Debian/Ubuntu) and try again." >&2
  exit 1
fi
CGO_ENABLED=1 go build -o whatsapp-bridge .
echo "Built $(pwd)/whatsapp-bridge"
