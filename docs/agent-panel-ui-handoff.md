# 1.6 / 1.8 UI 契约（给 gpt-6-luna）

后端与运行时设置逻辑已经实现。**只改前端**，不要改 `app/annota/src/*.rs`、Tauri 权限或 Rust API。

建议修改文件：

- `src/core.js`：SidePanel「助手」tab 的 DOM/交互；如需编辑运行时逻辑，先与现有 settings/agent helper 对齐。
- `src/overlay-theme.js`：助手聊天、审计卡样式（继续在 Shadow DOM 内）。
- `app/service/index.html`：1.6 设置页面控件与请求。
- 完成后运行 `python3 build.py`，生成 `dist/*`、`app/browser/core.js`、`app/extension/core.js`。

## 1.8 内置 agent 面板

### 调用

经 Annota bridge 调 Tauri 命令，不走 HTTP：

```js
const result = await window.__ANNOTA__.agentRun(messages);
// result.message: 最终 assistant 消息
// result.messages: 可继续回传的会话（不含 system prompt；截图 data 已脱敏）
// result.audit: [{ id, name, arguments, result }]
```

`messages` 为 OpenAI chat 格式，例如：

```js
[{ role: 'user', content: '第 2 秒画面里有哪些词？' }]
```

后端会自行循环最多 6 轮 tool call，并返回最终消息与审计数组。Panel 可以在本地保存 `result.messages`，下次发送时追加 user 消息后重新调用 `agentRun`。

### 工具与确认

Agent 工具：`capture_frame`、`words_at`、`navigate`、`open_annotations`、`copy_to_clipboard`、`propose_annotation`、`start_annotation`。

- 工具调用审计在 `result.audit` 中；记录为 `{id, name, arguments, result}`。完成对话后据此渲染可折叠审计卡。截图审计结果只含尺寸/字节数，不含 base64。
- `propose_annotation`、`start_annotation`、`copy_to_clipboard` 的 `result` 含 `{needs_confirmation:true, confirm_id}`。显示「确认 / 取消」：
  - 确认：`await window.__ANNOTA__.agentConfirm(confirm_id)`，把返回值写回该审计卡。
  - 取消：`await window.__ANNOTA__.agentCancel(confirm_id)`。
- 其他工具直接执行；错误结果为 `{error: "…"}`。
- 后端也发 `annota-agent-tool` 事件，但当前 UI 用 `result.audit` 足够，无须事件监听。
- 全部动态内容用 `textContent`，不要把模型回复或工具结果拼进 `innerHTML`。

### 截图视觉输入

`capture_frame` 的图像会作为 `image_url` data URL 发给支持视觉的 OpenAI-compatible 模型；返回 UI 的 history/audit 会移除图像数据。`ANNOTA_CHAT_IMAGES=0` 可关闭视觉输入。

### 空态与错误

- 模型未配置时，Tauri invoke 会以「未配置模型密钥：请设置 `LLM_API_KEY`（或 `ARK_API_KEY`）」拒绝；显示友好的设置提示，不显示堆栈。
- 环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（兼容 `ARK_BASE_URL`、`ARK_API_KEY`、`ARK_MODEL`）。

## 1.6 设置页面

### 设置 API

本地服务 `127.0.0.1:8793`：

- `GET /api/settings` → `{ok:true, settings:{sync, shortcuts, dictUrlTemplate, ai}}`
- `PUT /api/settings` → 请求体直接传同样的 `settings` 对象；成功回 `{ok:true, settings}`，校验失败回 HTTP 400 + `{error}`。
- `GET /api/ai` → `{ok:true, configured, model, base, baseUrl}`。`base` 与 `baseUrl` 相同，`model` 为运行时生效值。

默认设置：

```json
{
  "sync": { "address": "", "auto": false },
  "shortcuts": { "annotate": "alt+d", "panel": "alt+l", "overlay": "alt+s" },
  "dictUrlTemplate": "",
  "ai": { "baseUrl": "", "model": "" }
}
```

- `sync.address`：空字符串表示自动探测；非空必须是 http(s) URL。
- `sync.auto`：是否在每个视频页加载后自动同步；只读观看端始终自动同步。
- `shortcuts`：`alt` / `ctrl` / `meta` / `shift` 修饰键 + 单个字母/数字/F1–F12，例如 `ctrl+shift+a`；空字符串表示禁用。Esc 保留作关闭键。
- `dictUrlTemplate`：空字符串使用 Cambridge 默认；非空必须是含 `{word}` 的有效 http(s) URL。
- `ai.baseUrl` / `ai.model`：可在设置页改 endpoint 与模型名；空字符串回退到 `LLM_*` / `ARK_*` 环境变量，再回退默认值。
- API key 仍只从 `LLM_API_KEY` / `ARK_API_KEY` 环境变量读取；**不要新增密钥输入框或写入设置文件/localStorage**。

core.js 已从本地设置缓存与 `/api/settings` 读取这几个值，并使用同步开关/快捷键/词典模板。设置页面要做的事是 GET 初始化表单、编辑后 PUT 整个对象、展示校验错误与保存状态。

### UI 内容

- SidePanel 增加「助手」tab，与时间轴/词汇/来源并列。
- 设置页增加：同步地址、自动同步开关、三个快捷键编辑、词典 URL 模板、AI Base URL/模型名与配置状态；数据导出/外观/MCP 地址保留。
- 沿用现有琥珀色 `#F5A623` + 深色玻璃设计；注入态继续 Shadow DOM 隔离。
- 窄屏助手面板沿用现有 bottom-sheet 行为；聊天列表必须可滚动，发送框固定底部。

## 验收

- [ ] 提问「第 2 秒画面里有哪些词？」可调 `words_at`，显示答案与工具审计卡。
- [ ] 提问需要看画面的内容时，能调 `capture_frame` 并传递图像。
- [ ] 写操作先出现确认卡；取消不执行，确认才调用 `agentConfirm`。
- [ ] 无模型密钥时显示友好空态；不在 UI/存储中收集 API key。
- [ ] 设置页保存后刷新仍在；新打开的视频页读取设置并应用。
- [ ] 运行 `python3 build.py`、`node --test dev/geometry.test.mjs`、`node dev/smoke.mjs`。
