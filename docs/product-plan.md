# 产品化路线：可用 → 可商用 → 成熟（product-plan.md v0.2）

> 修订记录：**v0.2**（architect 子代理复审重写；依据：逐文件核实 `app/annota` Rust 源码 + `progress-2026-10-03-r4a.md` / `progress-2026-10-03-r4b.md` / `progress-2026-10-04-shell-plan.md` / `docs/r4b-plan.md` v0.1）← v0.1（2026-10-09 成熟度评估草稿）。
> 承接 [`roadmap.md`](roadmap.md)、[`r4-plan.md`](r4-plan.md)、[`r4b-plan.md`](r4b-plan.md)、[`implementation-plan.md`](implementation-plan.md)、`HANDOVER.md`（M8 待办）、`SECURITY.md`、`architecture.md`（ADR）。
> **v0.2 相对 v0.1 的六个修正**：① R4a 已完成、R4b 已接近完成且**未提交**——v0.1 把协作当 4–6 周未来工作，是本计划最大的事实错误；② 协作主决策已演进为 r4b-plan 的 **HubStore（CloudBase PG + RLS + GitHub OAuth）为默认、GitStore 降为进阶**，v0.1 引用旧的 r4-plan「GitStore 唯一」；③ release 404 不止「疑似」，已坐实三条缺失路由，且因 R4b 而升级为 P0；④ i18n 从可商用必要降级为可砍（中文垂类起点，非收钱前置）；⑤ P3-a 收窄：逐帧+插值+pack v2 一次迁移先做，polygon 降级后评；⑥ 出口验收全部改为可测 checklist，删掉「连续一周日用」式不可测标准。

---

## 0. 现状校准（执行前必读）

| 层 | 状态 | 证据 | v0.1 的误判 |
|---|---|---|---|
| R0/R1/R2/R3a | ✅ 完成 | `implementation-plan.md` 进度节 | — |
| **R4a 私组（GitStore）** | ✅ 六步完成，已提交 `7597510` | `progress-2026-10-03-r4a.md`（含真实 Gitee round-trip） | v0.1 P3-c C1 当作未来 4–6 周工作 |
| **R4b 托管后端（HubStore）** | ✅ R4b-1~5 完成、E2E 全 PASS；**未提交**（15+ 文件） | `progress-2026-10-03-r4b.md` §2–§6.6、§10 | v0.1 完全未提 |
| M1–M7（Tauri 壳） | ✅ 完成 | `progress-2026-10-04-shell-plan.md` | — |
| M8 | ⏳ 待办 | `HANDOVER.md` §235 | v0.1 已纳入 P1，保留 |

**默认后端决策（v0.2 以此为准）**：组后端默认 = **HubStore（CloudBase PG，浏览器直连 `app.rdb()` + RLS，OAuth 云函数仅做换票）**；GitStore 保留为「进阶：用我自己的 git 仓库」（`r4b-plan.md` v0.1，晚于 r4-plan v0.2，冲突处以 r4b-plan 为准；r4-plan 的 GitStore 设计对其进阶通道仍然有效）。ADR-1~6 不破：本地优先、匿名可读公开组、登录绑高意愿动作。

---

## P0 紧急插单（约 3–5 天，先于一切）

理由：R4b 是协作主线但**全部未提交**（`HANDOVER.md` §0：commit 是本仓库唯一留档手段，这是当前最大单点风险）；且 release 路由缺失使 R4b 前端在打包态直接 404。

| # | 事项 | 证据/位置 | 验收 | 工作量 |
|---|---|---|---|---|
| P0-1 | **提交 R4b 全部工作**（docs + cloudbase/ + vendor/ + src/group.js + group_hub 测试 + 两个 html） | `progress-2026-10-03-r4b.md` §10 清单 | 全量回归绿后 commit+push | 0.5 天 |
| P0-2 | **补 release 路由**：`/group.html`、`/cb-config.js`、`/vendor/cloudbase.full.js`（identity/group JS 已有路由，勿重复） | `sync_server.rs:148-170` 路由表缺这三条；`sync_server.rs:171-173` ServeDir 仅 debug；工作区 `index.html:408-411`、`group.html:10-12` 依赖 | 打 release 包：「组」screen 加载无 404、hub 建组动线真机跑通（v0.1「先实测确认」由此项闭环） | 1 天 |
| P0-3 | **userscript 注入 Publishable Key** | `progress-2026-10-03-r4b.md` §6.7（不注入则 B 站注入态用不了 hub 组——主场景断裂） | `build.py` 变体内联 PK；B 站注入态建组/同步 E2E | 0.5–1 天 |
| P0-4 | **mediaId 前缀归一收尾**（douyin/generic 裸 id vs `platform:id`） | `progress-2026-10-03-r4b.md` §9 遗留；bilibili 侧已修（§6.5 问题 3） | `groupsForMedia` 三平台匹配测试 + 注入态推送 E2E | 1 天 |
| P0-5 | R4b 档 2/3 验收记录落档 + `myGroups` 与本地注册表合并 | `progress-2026-10-03-r4b.md` §9 | 验收写进 `docs/progress-*.md`；我的组列表 hub+git 同源可见 | 0.5 天 |

依赖：无（P0-2 依赖 P0-1 的源码就位）。**P0 是 P1/P2 的前置，不与它们并行**。

---

## P1 可用收尾（约 2 周）— 「日常自己用不难受」

目标：可用度 80% → 100%。全部为已定位根因的确定性缺陷。

### P1-a M8 + 浏览器基本盘（约 1 周）

| # | 事项 | 证据/位置 | 验收 | 工作量 |
|---|---|---|---|---|
| 1 | **M8-1**：`app/browser/`（Electron）标注 deprecated、README/HANDOVER 更新、`build.py` 停发其 core.js | `HANDOVER.md` §235 | 构建产物不再含 browser 变体；文档一致 | 0.5 天 |
| 2 | **M8-2**：菜单精简收尾（「组管理」低频项收拢） | `HANDOVER.md` §238 | `pw dev/more-menu-check.mjs` 绿 | 0.5 天 |
| 3 | 前进/后退可用 | `public/index.html:252-253` 写死 disabled；需 nav 命令（注意 `main.rs:554-559` 已有仅放行 8793 的 `va_fetch`，可参照加 origin 约束） | B 站内跳转后可后退 | 1 天 |
| 4 | tab 标题真实化 | `tabs.rs:337` `"title": ""`；`tabs.rs:113` 历史写入也是空标题；需监听 `page-title-changed` 写回 | 标签条 + 历史列表有标题 | 1 天 |
| 5 | 查找计数 | `index.html:280` `find-count` 存在但无赋值（`window.find` 不返回计数） | 查找条显示 n/m | 1 天 |
| 6 | 缩放一致 | `main.rs:488-496` `set_zoom` 只 eval 当前 webview 的 `body.style.zoom`；切 tab/reload 即失 | 切 tab、reload 后缩放保持，标签数字正确 | 0.5 天 |
| 7 | `tab_move` 接线或删除 | `main.rs:537` 死命令（前端无拖拽排序）+ capabilities 白给权限 | 二选一：接拖拽排序，或删命令+权限条目 | 0.5 天 |
| 8 | agent 取活动 tab | `agent.rs:97` 写死 `get_webview("browser")`，改用 `tabs::active_webview` | 关闭首个 tab 后助手仍看到当前页 | 0.5 天 |

### P1-b 健壮性：消灭「静默残废」（约 1 周）

| # | 事项 | 证据/位置 | 验收 | 工作量 |
|---|---|---|---|---|
| 9 | 端口 8793 绑定失败→显式降级 | `sync_server.rs:177-183` 只 eprintln 后 return；工具栏显示 OFFLINE 但无原因 | 失败时工具栏明确报错并给出重试/换端口路径 | 0.5 天 |
| 10 | pack 损坏不再静默清零 | `sync_server.rs:1022-1036` `read_pack` 解析失败返回空 pack → `put_anno`（:463-471）覆盖即丢 | 损坏时保留 `.corrupt` 副本 + 接口返回 4xx + 前端告警，**不静默** | 1 天 |
| 11 | DB 两连败不 panic | `main.rs:1048-1051` `panic!` | 降级内存模式 + 启动横幅；有单测 | 0.5 天 |
| 12 | 前端吞错可见 | `index.html` 数十处 `.catch(() => {})` | 失败操作弹 toast（至少同步/导出/AI 三类主路径） | 1 天 |
| 13 | PENDING 写操作队列 TTL | `agent.rs:21-28` 只在确认/取消时移除 | 启动清空 + 30min TTL；有单测 | 0.5 天 |
| 14 | 仓库卫生 | `nohup.out`/`.DS_Store` 入 gitignore；`main.rs:1089-1133` 测试钩子移出 `main()`；`bridge_probe_reply` 调试通道收敛 | git status 干净；产线入口无测试代码 | 0.5 天 |

### P1-c AI 基本可用（约 2–3 天）

| # | 事项 | 证据/位置 | 验收 | 工作量 |
|---|---|---|---|---|
| 15 | **in-app API key 入口**（体验级 P0） | key 只读环境变量（`agent.rs:42-44`）；设置 schema 无 apiKey（`sync_server.rs:317-324`）；UI 提示环境变量 | 设置页粘贴 → 存本机（macOS Keychain，keyring crate）；明示「仅存本机」；env 变量仍优先（开发者友好） | 1–2 天 |
| 16 | 模型/端点可配置 | `doubao-pro-32k` 硬编码（`agent.rs:18-19`）；baseUrl/model 已可走 settings（`agent.rs:53-60`）但 UI 未暴露 key | 设置页可配 baseUrl/model/key 三件套；删重复硬编码 | 0.5 天 |
| 17 | `media_id` 参数接线 | `main.rs:881` 描述自认「当前未使用」（`:803` 已有解析逻辑可复用） | 接线或从 schema 删除，二选一 | 0.5 天 |

**P1 出口验收（可测 checklist）**：① B 站视频页：后退/前进/标题/查找计数/缩放五项全过；② 故意写坏一个 pack 文件 → 启动后数据不丢、有告警；③ 占用 8793 启动 → 工具栏明示原因；④ 不设任何环境变量，纯 UI 粘贴 key → 助手可答一题；⑤ 全量回归（node --test + smoke×7 + cargo test + 4 个 pw 脚本）绿。

---

## P2 可商用底座（约 3–5 周）— 「敢收钱、敢公开分发」

目标：可商用度 25% → 60%。**S 包最先**（协作已上线，安全债随用户翻倍）。

### S 包：安全收口（约 1–1.5 周）

| # | 事项 | 证据/位置 | 验收 | 工作量 |
|---|---|---|---|---|
| S1 | 收敛远程页面命令授权 | `tauri.conf.json:11` `withGlobalTauri` + `:13` `csp:null`；`capabilities/default.json:13-19` 放行 `https://*/*` 且授 `capture_frame/write_clipboard/agent_run/install_update`（:21-46） | ① capabilities `remote.urls` 收窄为 8793 回环；② Rust 侧高危命令（截屏/剪贴板/agent/更新）加调用方 origin 校验，远程页面一律拒绝，本地页+用户显式信任站点放行；③ `SECURITY.md` 已知边界第一条改写 | 3–4 天 |
| S2 | 本地 REST 鉴权 + DNS rebinding 防护 | 路由 `sync_server.rs:148-170` 无中间件；`put_anno`（:463-471）不挑 Content-Type | 启动生成随机 token 写 settings；中间件校验 token + `Host`/`Origin` 白名单；`PUT` 只收 `application/json`；userscript/扩展通道同步带上（零配置场景降级为「首次配对弹确认」） | 2–3 天 |
| S3 | 数据损坏恢复（在 P1-b#10 之上） | 同左 | `.bak` 双写 + 启动自检 + 恢复提示 UI；pack 格式版本号 + 最小迁移框架（`format` 字段已存在，加 `user_version` 式迁移表） | 2 天 |

注：hub 组数据安全由 CloudBase RLS 承担（`r4b-plan.md` §2 已落地并真机验证越权拒绝），S2 只管本机 8793 面；两者不冲突，不做统一鉴权体系（过度设计）。

### O 包：可观测（约 3–4 天）

| # | 事项 | 验收 | 工作量 |
|---|---|---|---|
| O1 | `tracing` + 轮转文件日志替换全部 `println!/eprintln!` | `~/Library/Logs/annota/annota.log` 按级别可查 | 2 天 |
| O2 | panic hook + 崩溃报告本地落盘，上传 opt-in | 崩溃后下次启动提示「查看/发送报告」；与 O3 的「无遥测」表述一致（默认不传任何东西） | 1 天 |
| O3 | 无遥测承诺写进隐私页 + 设置页 | 文案可见 | 0.5 天 |

### R 包：发布链路端到端（约 1 周，含等待公证/签名）

| # | 事项 | 证据 | 验收 | 工作量 |
|---|---|---|---|---|
| R1 | updater 全链真机验证（含 macOS 公证） | endpoint 已配（`tauri.conf.json:21-26`，CloudBase 静态托管 latest.json）；公证已决策（`progress-2026-10-04-shell-plan.md` §0.6）但从未跑通 | 旧版装机 → 发新 tag → 自动收到更新 → 安装重启；公证日志留档 | 2–3 天 + 等待 |
| R2 | 版本号单一来源 | `tauri.conf.json:4` 0.1.0 vs userscript VERSION 计数器（`build.py`）两套 | 单一来源 + CI 校验一致 | 0.5 天 |
| R3 | CI 测试门禁 | `release.yml` 只静态检查；无 PR CI | 新增 ci.yml：cargo test + clippy -D warnings + fmt --check + node --test + `check-tauri-permissions.mjs`，push/PR 触发 | 1 天 |
| R4 | Windows 签名决策 + Linux 评估 | 仅 dmg/nsis；SmartScreen 已知（`SECURITY.md` §平台说明） | 拍板：签 OV 证书 或 下载页明示警示；Linux 明确做/不做 | 0.5 天 + 采购等待 |

### D 包：数据可信（约 1 周）

| # | 事项 | 验收 | 工作量 |
|---|---|---|---|
| D1 | **全量导入/恢复**（spec §2.2 承诺只做了导出半边） | 我的库：导入 pack 目录/整包 JSON → 合并进 store；「导出→换机→导入」演练脚本化 | 2–3 天 |
| D2 | 定期自动备份 | 每日快照留 N=7 份（复用 S3 `.bak` 机制） | 1 天 |
| D3 | SQLite 迁移框架 | `store.rs` 裸 `CREATE TABLE IF NOT EXISTS`（:85-96）→ `user_version` + 迁移脚本 | 1–2 天 |

### I 包：分发面（缩小版，约 2–3 天）

| # | 事项 | 验收 | 工作量 |
|---|---|---|---|
| I2 | 官网下载页闭环 | `pages.yml` 已有站点，补安装指引 + 平台检测 + SHA256 | 1 天 |
| I3 | 隐私政策 + EULA 最小版 | 链接进应用与官网 | 1 天 |
| ~~I1 i18n~~ | **降级为可砍**（见下） | — | — |

**P2 出口验收**：陌生用户从官网下载 → 装 → UI 录 key → 标注 → 导出 → 收自动更新，全程无人工救援；`SECURITY.md` 已知边界清零或有明确缓释；CI 门禁在跑。

---

## P3 成熟主线（约 2–3 个月 + 触发线）— 「差异化的成熟，不是 CVAT 复刻」

### P3-a 标注生产级（收窄版，约 2–3 周）

| # | 事项 | 验收 | 工作量 | 依赖 |
|---|---|---|---|---|
| A1 | **pack 格式 v2 一次迁移**：帧号可选字段 + 内嵌 label schema 声明 + 迁移框架（合并 v0.1 的 B 包，避免两次格式迁移） | v1 pack 无损升级；旧客户端读新包有明确报错而非静默 | 3–4 天 | S3 迁移框架 |
| A2 | 逐帧步进（←/→ 单帧、shift 十帧） | 帧精度定位，时间码显示帧号 | 2–3 天 | A1 |
| A3 | 关键帧插值（两点之间框线性插值，可开关） | 插值区间可编辑/打断 | 3–4 天 | A1 |
| A4 | shot 边界吸附（= roadmap R4c：边播采帧，不搬媒体） | 标注自动吸附镜头边界；`va:shot` 纯新增字段 | 1 周 | 无 |
| A5 | ~~polygon/polyline/keypoint~~ | **降级为后评**：学习闭环（word+box→Anki）用不到多边形；触发条件=出现非学习类付费客户 | — | — |
| A6 | 数据工作台增强（按视频/词聚合、批量编辑） | HANDOVER §235 待办；可并入 A1 之后的空档 | 2–3 天 | 可砍 |

### P3-b 协作层（R4 收尾 + 触发线，非 4–6 周新做）

| # | 事项 | 状态/依据 | 验收 | 工作量 |
|---|---|---|---|---|
| C1 | HubStore 默认通道验收 | R4b 已 E2E 通过（档 1/2/3），差验收记录与 userscript PK（在 P0 已排） | 档 1–5 全部有落档记录 | P0 已覆盖 |
| C2 | 公开组页发布 | hub 已有 `visibility:public` + 匿名 RLS 读；差静态托管发布与 W3C Collection 导出（roadmap R4b 横切） | 公开组页匿名可读、permalink 可分享；导出可被标准工具导入 | 1 周 |
| C3 | 评论线程 + @提及 | **密度触发**（同 R4d 触发线）；挂在 entry `comments[]`，不另起模型 | — | 触发后估 |
| C4 | 版本历史 UI | git 原生（fork/还原）对 GitStore 进阶通道免费；hub 通道后评 | — | 后评 |
| C5 | 角色三档 | hub 已有 owner/member；moderator 后评 | — | 后评 |

**R4d 触发线（roadmap §4 + r4-plan §3，全满足才做）**：≥3 真实组 且 单组周新增 ≥50 且 连续 2 周。未触发一行不写。

### P3-c AI 护城河（R3b + R5，触发条件不变）

前置（implementation-plan R3b）：① 模型选型定；② 数据基线（工作台产出标注量达标）。**这是自认护城河，也是唯一不该无限押后的 AI 主线。**

| # | 事项 | 验收 | 工作量 |
|---|---|---|---|
| E1 | AI 建议框（`/suggest`）：标注点向两端对齐镜头 + 候选框 | 人工确认率 ≥50%（roadmap R3b 线），样本 ≥100 条 | 2–3 周 |
| E2 | AI 找词（画面语境 → 候选 word/label） | Recall@5 达标（先建评测集，≥200 条） | 2 周 |
| E3 | agent loop 增强（流式 + 真多端点；现 `agent.rs` `stream:false`、多端点半成品） | 流式输出 + 端点可配 | 1 周 | 依赖 P1-c |
| E4 | JEV 式轻量 head（word↔region） | 模型卡发布（roadmap R5） | 持续 |

### P3-d 商业化壳（触发后）

组织/SSO/计费、Pack 订阅市场（roadmap R4 远期）——等 C 线有真实小组密度再排期（roadmap §1 教训：消费者级开放社交注释层必死，密度靠组织者造）。

---

## 最短可商用路径 与 可砍项

```
最短路径（约 4–5 周可收钱）：
  P0（3–5 天）→ P1-b#10/11 + P1-c#15（2 天）→ S 包（1–1.5 周）→ D1（2–3 天）
  → R1+R2+R3（约 1 周）→ I2+I3（2 天）
  = 安全 + 数据可信 + 自动更新 + 下载页，四件事齐了就能对种子用户收费。

可砍（砍了不影响最短路径）：
  i18n（I1）            — 中文垂类起点，英文界面不是收钱前置；有非中文用户再提
  O 包可观测            — 可推迟到第一个付费用户投诉前；O3 无遥测承诺保留（一句话成本）
  Windows 签名（R4）    — 可「下载页警示」缓释一个季度
  A5 polygon / A6 工作台 / C3 评论 / C4 版本历史 / P3-d 商业化壳
                        — 全部有触发条件或付费信号，不预设
```

## 依赖总览

```
P0（3–5天，插队）──┬── P1 可用收尾（2周）──┬── S 安全（1–1.5周）──┬── P3-a 格式v2/逐帧/插值
                  │   ├─ P1-a M8+基本盘    │   ├─ O 可观测      │   ├─ P3-b C2 公开组页
                  │   ├─ P1-b 健壮性       │   ├─ R 发布链路     │   ├─ P3-c AI（触发线）
                  │   └─ P1-c AI 可用      │   ├─ D 数据可信     │   └─ P3-d 商业化（密度触发）
                  │                        │   └─ I 分发面       │
                  └── P0-2/3/4 是 R4b 线上化的前置 ──────────────┘
P2 内 O/R 可与 S 并行；D 依赖 S3；I 依赖 R1。P3-a 依赖 S3；P3-c E3 依赖 P1-c。
```

## 风险与止损

| 风险 | 应对 |
|---|---|
| R4b 未提交期间工作区被污染/丢失 | P0-1 最先做，半天内落地 |
| S1 收窄远程授权破坏现有用户工作流 | 升级时把历史访问站点导入信任白名单并明示；高危命令对远程页面默认拒绝是底线，不让步 |
| S2 token 把「零配置 LAN 同步」变繁琐 | 首配对弹确认 + 记住设备；userscript 场景保留无 token 降级档（仅回环+Host 校验） |
| R4 协作没有密度（roadmap §1 教训） | 密度起点锁定一个垂直群（IELTS，接 `../ielts-7.5`）；C2 公开组页是唯一主动增长动作，其余全部触发线 gate |
| AI 数据量不够 | E1/E2 先建评测集再开发；达不到线就继续打磨 A 线，不硬上模型 |
| 单人推进节奏失控 | 每包有硬验收；P2 超 5 周先砍 O/I，不砍 S/D1/R1 |

## 未决（要拍板）

1. **商业形态**（P2 开工前拍）：独立桌面付费 license vs 免费+组协作订阅？影响 I3 文案、C2 节奏、P3-d 与否。倾向：前者先行（本地优先叙事与 license 天然契合），协作订阅等有密度再说。
2. Windows 签名采购 or 暂缓（R4）。
3. polygon 需求真实性：建议先问 10 个种子用户再排 A5（防止按 CVAT 功能表自我膨胀——roadmap §2 的既定防线）。
