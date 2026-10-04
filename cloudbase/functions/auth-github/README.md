# auth-github（云函数）

Annota 的 GitHub OAuth → CloudBase 自定义登录 ticket 服务。**唯一持有 secret 的服务端组件**。

> 部署形态：**Event 云函数**，经 HTTP 网关以「云函数」方式访问（`event.path` / `httpMethod` /
> `queryStringParameters`）。网关路由上游类型必须是 **SCF**（不是 WEB_SCF——那是需 `scf_bootstrap`
> 的 Tencent Web 函数）。部署用 `tcb fn deploy`（**不加 `--httpFn`**）。
>
> 回跳：优先 `ANNOTA_APP_URL`（若配置）；否则从 OAuth `state`（前端放入的 base64url 页面地址）解码后回跳，
> 因此从任意页面登录都能回到原页，不必固定回跳地址。

## 路由（HTTP 云函数，按 `event.path` 分发）

| 路径 | 说明 |
|---|---|
| `GET /auth/github/start` | 302 到 GitHub `authorize`（`scope=read:user user:email`） |
| `GET /auth/github/callback` | `code`→token→`/user` 取 id → 签 ticket；有 `ANNOTA_APP_URL` 则 302 回前端带 `?ticket=&uid=&name=`，否则返回 JSON |

## 环境变量（部署时注入，勿明文入库）

| 变量 | 说明 |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth App Client ID（`Ov23liPnpRSQnkmz04VT`） |
| `GITHUB_CLIENT_SECRET` | OAuth App Secret（本机 `sec` 条目 `github-oauth`） |
| `TCB_CUSTOM_LOGIN_KEY` | 自定义登录私钥 PEM（`sec` 条目 `cloudbase-custom-login-key`） |
| `TCB_CUSTOM_LOGIN_KEY_ID` | 私钥 ID（`dbc200e6-2b92-4cff-afa5-6cd8c4ffe556`） |
| `OAUTH_REDIRECT_BASE` | 可选，本函数公网 base；不填按请求 Host 推断 |
| `ANNOTA_APP_URL` | 可选，登录成功回跳的前端页 URL |

> 私钥默认走环境变量（不落盘）。仅本地调试时可放 `tcb_custom_login.json`（已在 `.gitignore`）。

## 部署

```sh
# secret 从 sec 注入（明文不进 shell history / 日志）
secenv GITHUB_CLIENT_SECRET=github-oauth TCB_CUSTOM_LOGIN_KEY=cloudbase-custom-login-key -- \
  tcb fn deploy auth-github -e tencentcloudtest-d2eg4lu85c76fb0
# 再在控制台/CLI 设置 GITHUB_CLIENT_ID / TCB_CUSTOM_LOGIN_KEY_ID / OAUTH_REDIRECT_BASE
```

## 回调地址（GitHub OAuth App 只允许填一条）

`https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.ap-shanghai.app.tcloudbase.com/auth/github/callback`

## 前端消费

拿到 `ticket` 后：`auth.customAuthProvider().signIn(ticket)`（见 `src/group.js`）。
