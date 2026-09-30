# 移动端测试

前提：手机与电脑**同一个 Wi‑Fi**。

## 一键（推荐）
电脑上：
```bash
python3 dev/hub.py
```
它会起好两个服务并打开**入口页**——**手机扫页面上的二维码**即安装（GM 版），同步地址已内置，装完直接标注 + `⇅ 同步`。

- iOS Safari：装免费的 **Userscripts**（或 Stay），并到 设置 → Safari → 扩展 → 打开、对所有网站始终允许。
- Android：Kiwi Browser / Firefox Android + Violentmonkey。

**最快验证**（连管理器都不用）：手机打开入口页上的「先试玩」链接（`http://<IP>:8793/dev/demo.html`），页内已内嵌脚本。

### 手机连不上局域网？跨网用隧道
```bash
python3 dev/hub.py --tunnel      # 用 cloudflared 起 https 隧道（手机在任何网络都能用）
```
- hub 会自检隧道是否可用；若提示「本机 DNS 解析失败」= `*.trycloudflare.com` 被污染（国内常见），手机多半也不通。
- 这种情况改用**国内隧道**（cpolar / natapp 等，需注册）或回到局域网（关手机 VPN）。

## 手动（拆开跑）
```bash
python3 app/service/sync_server.py   # 单端口 8793：静态文件 + 同步 API（绑 0.0.0.0）
```
访问：`http://<IP>:8793/dev/hub.html`（入口）、`/dev/demo.html`（试玩）、`/api/health`（连通性自测）。
本机 IP 用 `ipconfig getifaddr en1` 查（示例 `192.168.1.100`）。
> `dev/serve.py`（8792）是纯静态服务器，平时用不到。

### ⚠️ 路径 B 的同步限制（重要）
真实站点是 **https**，而同步服务是 **http://<局域网IP>** —— 这属于**混合内容**，浏览器会**拦截**（只有 `127.0.0.1`/`localhost` 被豁免，局域网 IP 不豁免）。
- 所以用**普通脚本**在路径 B 下：标注/本地存储可用，但「上传/下载」会被拦。
- 解决办法：装 **GM 变体脚本**（用扩展上下文发请求，绕过 CORS 与混合内容）：
  ```
  http://192.168.1.100:8793/dist/annotate.gm.user.js
  ```
  需要管理器支持 `GM_xmlhttpRequest`：Violentmonkey / Tampermonkey / Stay 支持；quoid Userscripts 不一定。
- 或者干脆用**路径 A（demo 页，http）**验证同步；或给同步服务配一个 https 地址（如 `cloudflared tunnel --url http://localhost:8793`）再把地址填成那个 https URL。

## 数据在哪里
标注存在**浏览器本地**（localStorage，按 mediaId）。跨设备靠「同步」或「⚙ 里的导出/导入文件」。
