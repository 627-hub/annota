# 上下文桥（发给桌面豆包）+ 截图 + 笔记

> **设计结论：不在浏览器里做「第二个豆包」。** 桌面豆包/系统助手在通用问答、语音、悬浮球、全局热键上完胜；
> 我们只做**别人拿不到的上下文**：`画面截图 + 秒数 + 你的标注`，一键送进剪贴板，交给桌面豆包去问。

## 用法
- 工具条 **`📋 发豆包`**（一键）：把「当前画面截图 + 视频上下文（平台/链接/标题/进度/已标注词）」写成**富剪贴板**（text/plain + image/png）。
  → 切到桌面豆包，`Cmd/Ctrl+V` 粘贴即可提问（或按你的语音热键）。
- `⚙` 面板里还有：**`📷 截图`**（只复制画面）、**`📝 存笔记`**（见下）。

## 截图通道
自建浏览器 `capturePage`（原生，最稳）/ 扩展 `captureVisibleTab`（按视频区裁剪）/ 同源 canvas 兜底（跨域视频会 taint，B站不可用）。
截图**包含你画的标注框**（截的是渲染后画面）。

## 笔记（Markdown → Obsidian/Notebook）+ 数据沉淀
`📝 存笔记` → 生成
```
<NOTES_DIR>/<date>_<mediaId>.md     # frontmatter + 截图 + 生词表
<NOTES_DIR>/<date>_<mediaId>/shot.png
<NOTES_DIR>/data.jsonl              # 每行 {media, entries, chat, note}
```
接 Obsidian：`export NOTES_DIR="$HOME/Documents/你的库/video-annotate"` 再起 `dev/hub.py`。

## 接口（本地服务 8793）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai` | LLM 配置状态（备用） |
| POST | `/api/chat` | 转发到豆包/任意 OpenAI 兼容端点（**备用**：留给后续「动作型 AI / MCP」） |
| POST | `/api/note` | 存 Markdown 笔记 + 落 `data.jsonl` |

> `/api/chat` 暂时不用在 UI 上——通用聊天交给桌面豆包。它留给后续：**AI 建议框**、**自动讲解当前画面**、**把服务暴露成 MCP 让桌面 agent 直接读你的标注**。

## 后续
- **MCP**：把本地服务做成 MCP server，桌面豆包直接调用「查这个视频的标注/某秒的词」。
- **服务端 ASR**：若要在自建浏览器里做真语音输入（Electron 的 Web Speech 不可用）。
- **视觉模型**：若要 `/api/chat` 读图，`ARK_MODEL` 需选支持图片的豆包模型。
