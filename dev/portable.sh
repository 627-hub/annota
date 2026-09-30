#!/bin/bash
# video-annotate · 便携启动器（桌面「下载即用」）
# 用系统里现有的 Chromium 系浏览器，自动带上本扩展启动——无需商店、无需 Tampermonkey。
#   bash dev/portable.sh                      # 打开一个空白页
#   bash dev/portable.sh https://www.bilibili.com/video/BVxxxx
#
# 注意：部分较新版 Chrome 稳定版可能忽略 --load-extension；优先用 Chromium / Edge / Brave / Vivaldi。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$DIR/app/extension"
PROFILE="${VA_PROFILE:-$HOME/.video-annotate-profile}"

BIN=""
for c in "Chromium" "Google Chrome" "Microsoft Edge" "Brave Browser" "Vivaldi"; do
  for p in "/Applications/$c.app/Contents/MacOS/$c" "$HOME/Applications/$c.app/Contents/MacOS/$c"; do
    if [ -x "$p" ]; then BIN="$p"; break 2; fi
  done
done
if [ -z "$BIN" ]; then
  echo "未找到 Chromium 系浏览器。请安装 Chromium / Chrome / Edge / Brave 之一。"
  exit 1
fi

echo "浏览器: $BIN"
echo "扩展  : $EXT"
echo "资料夹: $PROFILE（独立，不影响你日常浏览器）"
exec "$BIN" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --disable-extensions-except="$EXT" \
  --no-first-run --no-default-browser-check \
  "${@:-about:blank}"
