# 进展 · 2026-10-12（插件生态 v2：运行时 zip 安装 + 插件仓 + 气泡 UX 修复）

> 承接 [`plugins.md`](plugins.md)（插件协议，单一事实源）与 [`product-plan.md`](product-plan.md)。
> 本批把插件从「构建期 API」推到「运行时安装的独立生态」：类 Chrome 扩展的 zip 包 + 本地安装 +
> 工作区管理页 + 独立插件仓 `annota-plugins`；另修了 OCR review 与编辑气泡截断两个遗留问题。

## 已完成（主仓 `feature/plugin-module`，9 个 commit，未 push）

| Commit | 内容 | 关键实现 |
|---|---|---|
| `8a0c5d4` chore(ci) | 删失效 Python 单测 + nullglob 兜底 | `.github/workflows/ci.yml` |
| `89c278e` 插件框架 v1 | Annota 底座 + 插件契约 v1（构建期） | `src/core.js` 插件注册表 / `pluginHook` 接缝 |
| `2a13a7f` anki_export | 导出能力重写为插件（apkg 单路径） | `plugins/anki_export` |
| `371b0cf` ielts 联动 | 雅思词库联动首版（构建期内置形态） | 查词行 + 词义块 |
| `5fa97de` 运行时装载层 | **zip 安装**：manifest 校验 / token / 原子升级含失败回滚 / 保留 id 扫描跳过 / from 字段净化；每插件独立 `initialization_script` 在 ANNOTATE_JS 之前注入 | `app/annota/src/plugins.rs`、`tabs.rs`；路由在 guard/限流 layer 前 |
| `22ac993` 管理页 | 工作区「插件管理」两阶段安装（dry_run 预检 → 确认）+ overlay 菜单入口 | `app/service/index.html` `#screen-plugins` |
| `31289b2` ielts 外移 | ielts 前端移到插件仓，仓库里只留协议实现说明 | `docs/plugins.md` |
| `bd14700` OCR 修复 | 12 medium + 点名 low 全修（含**升级失败数据丢失**等真 bug） | `plugins.rs` 回滚 / 测试加固 |
| `af6f514` 截图刷新 | overlay-check 跑通后自动更新（菜单含插件管理入口） | `docs/assets/` |

OCR review 结果文件按约定保留在 `/tmp/ocr_*.txt`（deepseek-flash，`--audience agent`）。

## 本批未提交（真机验证已通过，待 commit）

| 仓库 | 文件 | 内容 |
|---|---|---|
| 主仓 | `src/core.js` (+36) | `placePop()`：气泡挂载后按实测宽高二次钳入视口（修「高气泡顶出屏幕底、保存修改被截断」）；`.va-pop-head` pointer 拖拽移动气泡（按钮区除外） |
| 主仓 | `src/overlay-theme.js` | `.va-pop-head` 加 `cursor:move / user-select:none / touch-action:none` |
| 主仓 | `dev/smoke-export.mjs` (+14) | 桩应答 `/api/settings`——修 smoke 被本机 8793 真 app 清空 `va:syncUrl` 导致打错目标 |
| 主仓 | `app/service/index.html` | 插件启停/卸载文案改准确（刷新/新开标签页才生效） |
| 主仓 | `dist/*` + `VERSION`(0.1.0.58) + `extension/core.js` | 重编产物 |
| 插件仓 | `plugins/ielts/main.js` + `manifest.json` v0.1.1 | 雅思词义块改插到「查词」行**正下方**（原来 append 到长气泡末尾，落到屏幕外看不见） |

未跟踪：`app/service/plugins/`（运行时安装产物，建议加 gitignore）、`docs/discord-welcome.md`（用户文件）。

## 真机验证（2026-10-12）

- **装载流**：`dry_run` 预检 / 非法包 403 / 安装落盘 `app/service/plugins/`（`plugins.json` + `.bak`）/ 升级 / 卸载 ✅
- **管理页**（pw 直连真后端）：安装 → 启停 → 重装 → 卸载 全流程 7/7 ✅
- **词库端点**：真词库 7002 词 + 词源富化（`abandon` 有词根词源，`blossom/birdlike` 不在表内按设计静默）✅
- **MCP 窗口截图**：插件页渲染、菜单入口、装好的插件列表均正确 ✅
- **用户手动确认**：
  1. 雅思块在查词行下方可见（v0.1.1 热重装后）✅
  2. **气泡头部可拖拽移动** ✅
  3. 编辑气泡完整在屏内，`保存修改` 不再被截断（placePop 生效）✅

JS 全套（`*.test.mjs` + smoke）/ shell-drift / `cargo check` 全绿。

## 待办

1. **提交本批改动**：主仓（core.js / overlay-theme / smoke-export / index.html / dist 产物）+ 插件仓 ielts v0.1.1；是否 push 等拍板（主仓 12 个 commit 尚未 push）。
2. `app/service/plugins/` 加进 `.gitignore`。
3. UX 待拍板：词汇块悬停显示（demo 式，现在是常显）；词表未命中的轻提示。
4. 在线插件目录（仓库 zip 源一键安装）→ v3；本地 zip 自装已可用。
5. `HANDOVER.md` 的「最近提交」行仍停在 `7f5e859`，下次更新交接时一并刷新。
