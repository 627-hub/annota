#!/bin/bash
# 启动自建浏览器（Electron 壳）
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR/app/browser"
[ -d node_modules/electron ] || ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" npm install --no-audit --no-fund
exec ./node_modules/.bin/electron .
