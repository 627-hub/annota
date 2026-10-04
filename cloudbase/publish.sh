#!/bin/sh
# 发布 userscript 到 CloudBase 静态托管，供用户端自动更新（@updateURL/@downloadURL）。
# 用法：sh cloudbase/publish.sh
# 依赖：tcb CLI（已登录、已绑环境）
# 产物：dist/{annotate,annotate.gm,annotate.view}.user.js + dist/version.json
set -e
ENV_ID="tencentcloudtest-d2eg4lu85c76fb0"
TOPDIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1) 构建（每次构建 US_VER 递增，管理器才会判定有新版本）
python3 "$TOPDIR/build.py"

# 2) 上传脚本与版本顶标到静态托管根
for f in annotate.user.js annotate.gm.user.js annotate.view.user.js version.json; do
  tcb hosting deploy "$TOPDIR/dist/$f" "$f" -e "$ENV_ID"
done

echo "OK · 已发布。"
echo "观看端：https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com/annotate.view.user.js"
echo "版本顶标：https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com/version.json"
