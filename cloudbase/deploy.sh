#!/bin/sh
# 部署 auth-github 云函数并把密钥注入环境变量（明文不落盘、不进 history）
# 用法：sh cloudbase/deploy.sh
# 依赖：sec（github-oauth、cloudbase-custom-login-key）、tcb CLI（已登录、已绑环境）
set -e

ENV_ID="tencentcloudtest-d2eg4lu85c76fb0"
FN="auth-github"
FNDIR="$(cd "$(dirname "$0")/functions/$FN" && pwd)"
TOPDIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1) 部署代码（Event 云函数，在线安装依赖）
#    经 HTTP 网关以「云函数」方式访问（event.path/httpMethod/queryStringParameters），
#    路由上游类型须为 SCF —— 不要用 --httpFn（那是 Tencent Web 函数，需 scf_bootstrap）。
( cd "$FNDIR" && tcb fn deploy "$FN" -e "$ENV_ID" --force --runtime Nodejs18.15 --install-dependency true )

# 2) 写入 cloudbaserc.json（含密钥；临时文件，用完删）
#    密钥从 sec 读取，仅在本进程环境里传递
secenv GITHUB_CLIENT_SECRET=github-oauth TCB_CUSTOM_LOGIN_KEY=cloudbase-custom-login-key -- \
  sh -c '
    set -e
    cat > "'"$TOPDIR"'/cloudbaserc.json" <<EOF
{
  "envId": "'"$ENV_ID"'",
  "framework": { "name": "annota-auth" },
  "functions": [
    {
      "name": "'"$FN"'",
      "runtime": "Nodejs18.15",
      "timeout": 20,
      "envVariables": {
        "TCB_ENV": "'"$ENV_ID"'",
        "GITHUB_CLIENT_ID": "Ov23liPnpRSQnkmz04VT",
        "GITHUB_CLIENT_SECRET": "${GITHUB_CLIENT_SECRET}",
        "TCB_CUSTOM_LOGIN_KEY": "${TCB_CUSTOM_LOGIN_KEY}",
        "TCB_CUSTOM_LOGIN_KEY_ID": "dbc200e6-2b92-4cff-afa5-6cd8c4ffe556",
        "OAUTH_REDIRECT_BASE": "https://'"$ENV_ID"'-1414056833.ap-shanghai.app.tcloudbase.com"
      }
    }
  ]
}
EOF
    # 3) 推送配置（含密钥）
    tcb config update fn "'"$FN"'" -e "'"$ENV_ID"'"
    # 4) 清理含密钥的临时文件
    rm -f "'"$TOPDIR"'/cloudbaserc.json"
    echo "OK · 配置已推送，临时 cloudbaserc.json 已删除"
  '
