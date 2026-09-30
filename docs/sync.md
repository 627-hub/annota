# 同步

**傻瓜式**：工具条只有一个 **`⇅ 同步`** —— 一次完成「拉取 → 本地合并 → 回传」，双向 union，不用想上传还是下载。
需要单独控制时，`⚙` 面板里有「仅上传 / 仅下载」。

## 零配置
`dev/hub.py` 会把本机地址烧进脚本（`window.VA_SYNC_URLS`，含 `127.0.0.1` / 局域网 IP / `.local`），运行期自动探测可用者——**装完即用，不用填地址**。
想手动指定：`⚙ → 同步地址`（留空=自动）。

## 三个脚本变体
| 文件 | grant | 适用 |
|---|---|---|
| `dist/annotate.user.js` | `none` | 电脑·编辑；请求走 `fetch`（受 CORS/混合内容限制） |
| `dist/annotate.gm.user.js` | `GM_xmlhttpRequest` | 电脑·编辑（GM）；绕过 CORS 与混合内容 |
| `dist/annotate.view.user.js` | `GM_xmlhttpRequest` | **手机·观看**：只读 + 打开即自动同步 |

> 同步失败先看是不是「https 页面 → http 局域网地址」被按混合内容拦了：换 GM 变体，或改用 https 终结点。

## 启动同步服务
```bash
python3 app/service/sync_server.py     # 默认 http://127.0.0.1:8793
```
- 纯标准库，无依赖；数据落在 `app/service/store/<mediaId>.json`（已 gitignore）。
- CORS 全开；`GET/PUT /api/anno/<mediaId>`；`PUT` 走**去重合并**（同词 + `|Δt|<0.4s` + `IoU>0.6`）。

## 配置同步地址
工具条 `⚙` → 「同步地址」填服务地址（默认 `http://127.0.0.1:8793`）→ 保存 → 点「测试」应显示「同步可用 ✓」。地址存在浏览器 `localStorage`（`va:syncUrl`）。

## 语义
| 动作 | 请求 | 行为 |
|---|---|---|
| 上传 | `PUT /api/anno/<key>` | 服务端与已有合并去重，回传合并结果；客户端采用合并结果 |
| 下载 | `GET /api/anno/<key>` | 客户端本地合并去重（同上传的规则） |

## 去中心化说明
标注是纯文本 pack（`{format, media, entries}`）。除本地服务外，也可把 pack 放到任意静态 URL（GitHub Raw / Gist / 自建），用「导入文件」或订阅的方式共享——与项目「不做中心平台」的定位一致。

## 已知限制
- `https` 页面 → `http://127.0.0.1` 的 fetch：Chrome 视为「可信来源」不拦；个别 Safari 版本可能拦（此时换 https 服务或用 MV3 扩展的 `GM_xmlhttpRequest`，见 P1）。
- 同步是「整包合并」，暂无鉴权/多人编辑冲突的细粒度处理（后续接 P2 的 W3C 容器与去噪）。
