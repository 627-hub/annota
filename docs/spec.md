# 视频标注层 · Spec v0.1（`video-annotate`）

> 独立项目（从 `ielts-7.5` 拆出）。**主题：AI 应用 + 视频标注大模型。**
> **终局目标：用众包标注训出一个 JEV 式的 word↔region（词↔画面区域）决策模型。**
> 我们**不生产内容、不托管媒体**，只解决「标注 → 合并 → 分发 → 渲染 → 训练」的技术问题。
> 资产是用户投入时间不断积累并共享的**标注数据**；数据属于标注者，可导出、可自持、可不经中心节点交换。
>
> 语言学习（雅思词表 / SRS / Anki）只是**首个应用场景**，不是项目边界；
> 这些能力现成存在于姐妹仓库 `../ielts-7.5`，本项目**复用但不依赖**。

---

## 0. 一句话
给「别人的视频」加一层**可共享的词汇标注**：在任意网页 `<video>` 上把词锚到画面区域，众包共享；
积累的标注最终用于训练一个**给定帧 + 候选词表 → 判断「哪个词属于哪块区域」**的决策模型。

## 1. 愿景与立场
- 内容源 = 互联网上**已有**的优质视频，我们不动它。
- 价值 = 用户逐年积累的 **词 × 时刻 × 区域** 标注。数据归标注者所有。
- 去中心化：开放格式（对齐 W3C Web Annotation）、可导出、可自持；我们只出**协议与工具**。
- 类比：Anki 共享牌组、uBlock filter list、git 仓库——**轻协议 + 文件**，而非平台。

## 2. 目标 / 非目标

**目标**
1. 浏览器扩展：在任意 `<video>` 上叠层、拖框、绑词、AI 给建议、本地存、导入/导出/订阅标注包。
2. 观看端叠加：看原视频时浮出双语释义/词根/词源；一键收词进词库（接 SRS/Anki）。
3. 去中心化共享：只共享**标注数据**（不碰媒体），开放格式 + 客户端合并。
4. **模型终局**：用累积标注训练/评测 **JEV 式 word↔region 决策模型**（详见 §9）。

**非目标**
- 不生产/下载/再分发视频；不建媒体库。
- v1 不做中心化账号/社交平台；不承担 UGC 运营。
- 不做动作/多模态识别、不做全自动标注（AI 只提议，人确认）。
- 不做商用分发。

## 3. 核心概念
| 概念 | 含义 |
|---|---|
| **MediaRef** | 视频标识（platform + video_id + url + 原始分辨率），**不含媒体本身** |
| **Entry / Annotation** | 一条标注：`时刻 t + box + word(+label/pos)` |
| **Pack** | 一组标注（可带主题/词表/授权） |
| **Feed** | 可订阅的 Pack 来源（URL / 文件 / git） |
| **Overlay** | 观看端渲染层（热区 + 查词弹层） |

## 4. 数据模型（对齐 W3C Web Annotation）

采用 [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)：
`target` = 视频资源 + 时间/空间选择器；`body` = 词条。JSON-LD 序列化，
自定义词表用 `@context` 扩展（`va:`）。这样「共享/迁移/去中心化」直接继承标准。

### 4.1 单条 Annotation（示例）
```json
{
  "@context": ["http://www.w3.org/ns/anno.jsonld",
               {"va": "https://video-annotate.local/ns#"}],
  "id": "urn:uuid:5f0c...",
  "type": "Annotation",
  "created": "2026-09-30T12:00:00Z",
  "creator": {"type": "Person", "id": "urn:hash:ab12...", "name": "alice"},
  "motivation": "tagging",
  "body": {
    "type": "TextualBody",
    "purpose": "tagging",
    "value": "tractor",
    "va:word": "tractor", "va:label": "拖拉机", "va:pos": "n",
    "va:lexiconId": "ecdict:tractor"
  },
  "target": {
    "type": "Video",
    "id": "https://www.bilibili.com/video/BV1xx411c7mD",
    "va:media": {"platform": "bilibili", "videoId": "BV1xx411c7mD",
                    "intrinsic": {"w": 1920, "h": 1080}},
    "selector": [
      {"type": "FragmentSelector",
       "conformsTo": "http://www.w3.org/TR/media-frags/", "value": "t=12.4,13.2"},
      {"type": "va:BoxSelector",
       "va:space": "content-normalized",
       "va:x": 0.42, "va:y": 0.55, "va:w": 0.18, "va:h": 0.22}
    ]
  },
  "generator": {"id": "urn:tool:annotate-ext", "type": "Software"},
  "va:license": "CC-BY-4.0",
  "va:sig": "ed25519:..."
}
```
> 时间用标准 Media Fragments（`t=`）；空间用**归一化 box 自定义选择器**（见 §4.3）。
> 兼容：一条 Annotation 若要「点/轨迹」，用 `va:kind: point|span|track` 扩展。
> 时长：内部 `dur`（秒，默认 **1.0**）表示该词出现的时间长度；导出 W3C 时并入时间片段 `t=start,end`。
> 词条：`word/label/pos` 由本地词库（`dist/vocab.json`，雅思+托福 **11,821 词**）**中英联想**填充，人手可改。

### 4.2 Pack / Feed
Pack 用 `AnnotationCollection` 组织，Feed 是「一个可拉取的 Pack 列表」：
```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "AnnotationCollection",
  "id": "https://example.org/packs/farm.json",
  "label": "农场词汇 · B站片单",
  "creator": {"type": "Person", "name": "..."},
  "va:topic": "farm",
  "va:license": "CC-BY-4.0",
  "total": 128,
  "first": {"type": "AnnotationPage", "items": ["... 内联或引用 ..."]}
}
```
Feed 清单（订阅用）：
```json
{"type": "va:Feed", "name": "...", "author": "...",
 "packs": ["https://a/pack1.json", "https://b/pack2.json"]}
```

### 4.3 坐标规范（先定死，否则会漂）
- `box` 用**左上角 + 宽高**（`x,y,w,h`，均 0–1），按**视频内容区**归一化（去掉 letterbox 黑边），并记录 `intrinsic{w,h}`。
- 内容区算法：按 `<video>` 的 `object-fit`（`contain`/`cover`/`fill`/`none`/`scale-down`）与 `videoWidth/Height` 求实际内容矩形，再把 box 映射到该矩形。
- 渲染时按「视频元素 rect + 内容矩形」复投影 → 兼容全屏 / 画中画 / 缩放。
- **P0 即写单元测试**（`dev/geometry.test.mjs`）：letterbox/pillarbox/cover 映射、像素↔归一化往返、clamp、暂停帧零漂移。
- 说明：不存像素、不存媒体，只存归一化坐标。

## 5. 系统架构

### 5.1 交付形态：**userscript 为主 + MV3 扩展为辅**（三端通吃，不自建浏览器）
核心逻辑只写一次，把「宿主特权」藏在适配层后；同一份 core 分别打包成 userscript 与 MV3 扩展：

| 能力 | userscript | 需 MV3 扩展 |
|---|---|---|
| 叠层热区 + 查词（**观看**） | ✅ | |
| 拖框 / 点选（**标注**） | ✅ | |
| 本地存储（IndexedDB / `GM_setValue`） | ✅ | |
| Pack 导入导出 / 订阅 Feed | ✅ | |
| **抓当前帧喂 AI 建议**（`captureVisibleTab`） | ❌ | ✅ |
| 跨域精确取帧 | ⚠️ CORS/taint | ✅ 截标签页 |

宿主（**借现成，不自建**，均为免费）：桌面 Chrome/Firefox 用 Tampermonkey 或 Violentmonkey；
Android 用 Kiwi/Firefox；**Apple（macOS/iOS Safari）用免费开源的 Userscripts**
（**勿用付费的 Tampermonkey**；脚本 `@grant none`，管理器无关）→ 可看可标（无 AI 抓帧）。
详见 [`install.md`](install.md)。

```
core/                    # 平台无关：坐标/渲染/合并/查词/存储抽象
  geometry.js            # 内容区坐标（可单测）
  adapter.js             # bilibili / douyin / generic
  core.js                # 叠层 + 拖框 + 绑词 + 导入导出
dist/annotate.user.js    # 脚本产物（三端）
app/extension/           # MV3 产物（桌面/Android；拿 captureVisibleTab）
service/ (FastAPI)       # /suggest /judge /score /enrich /anno
                         # P0 已落地最小版：app/service/sync_server.py（GET/PUT /api/anno/<key> + CORS，见 docs/sync.md）
```
数据层：本地存储为主 → 导出 Pack → 任意静态 URL/git → 他人订阅；**无中心亦可运转**。

## 6. 可复用的现有技术（不重造）
> 下表资产位于姐妹仓库 `../ielts-7.5`（该仓库已落地这些脚本/数据）。本项目**复用、按需 vendor**，不做硬依赖。
> 本项目自身只拥有「标注器 / 共享协议 / 决策模型」三块。

| 能力 | 现成资产（在 `../ielts-7.5`） | 复用方式 |
|---|---|---|
| 拖框/改大小/坐标导出 | `app/immersion/edit.html` | 移植为 overlay 框编辑器（含左上角固定） |
| 查词弹层/热区渲染 | `app/immersion/index.html`（`showPop`/`addAnchor`，中心点定位） | 抄结构 |
| 词库附义（释义/词根/词源/词族） | `assets/dict/lexicon.jsonl`、`ecdict.csv`、`assets/vocab/enrich.py`、`app/immersion/build_dict.py` | `/enrich` 直接调用 |
| 11,821 词表 + 音标/音频 | `assets/vocab/*.apkg`、`.cache/雅思.jsonl`、`audio/` | 词表补全 + 发音 |
| SRS / Anki 回写 | `app/vocab/lib/{srs,anki}.py`、`dictation.py` | 观看端「收词」进到期卡 |
| 语义检索（同义/搭配） | `app/rag`（BM25 + Ollama `bge-m3`） | 查词增强 |
| 质量/共识参考 | `zhiqin1998/bdc`（Bayesian Detector Combination） | 众包去噪 |
| 密钥 | `sec`（Keychain） | 云 API key |
| 追踪/分割算法 | `facebookresearch/co-tracker`、SAM2、GroundingDINO | **直接用，不自造** |

## 7. 要自造的轮子（无现成可复用）
1. **扩展 + 视频坐标映射**（MV3）：黑边/全屏/画中画/多分辨率/多平台播放器。← 最核心。
2. **抓帧**：`captureVisibleTab` 截标签页 → 裁到视频矩形（避开 canvas 跨域污染）。
3. **本地存储与包管理**：IndexedDB + Pack 导入导出/订阅。
4. **AI 建议编排**：帧 + **候选词表** → 云开放词表模型（GroundingDINO/OWLv2/CLIP/YOLO-World）→ 候选框。
5. **众包合并/去噪/信任**：W3C 标注按 `(media,t,box IoU,word)` 去重、投票、按标注者质量加权（借 BDC 思路）。
6. **去中心化分发**：Feed 清单 + 拉取/本地合并（文本 diff / CRDT-lite）。
7. **观看端学习闭环**：热区常显、收词、跳 SRS。
8. **平台适配器**（后置）：B站 → 抖音 DOM。

## 8. 共享与去中心化
- **数据归属**：每条带 `creator` + `va:license` + `va:sig`；用户可随时导出全部。
- **交换不依赖中心**：Pack 纯文本，托管任意静态位置；订阅 = 拉一个 JSON 清单。
- **合并即真值**：同视频多 Pack 客户端合并，冲突用 IoU + 词 + 作者质量投票，不做中央裁决。
- **信任分层**：默认只信自己；可订阅「可信来源」白名单。
- **隐私**：不采集观看行为；不强制账号；服务端不存媒体与用户轨迹。
- 我们提供的只有**工具与协议**（符合「互联网去中心化」定位）。

## 9. 模型路线（终局：JEV 式 word↔region 决策模型）

### 9.1 为什么是 JEV 式而非 JEPA
- **JEPA/V-JEPA 是自监督 backbone**（预测潜空间，不需要人工标注）——可当特征源，不是训练目标。
- **JEV 家族是结构化决策模型**（`TypeSafe Jev`/`OpenJev`/`NeoHorse-Jev-4B`/`Jev-Omni`/`PlayJev`）：
  `state + 应用定义候选 → prefill-only 概率`，原语 `Choice / Noul / Score`，**不生成文本**。
- 我们的标注（词↔区域↔时刻）**正是这类决策模型的监督数据**——这是众包标注的硬价值，也是终局。

### 9.2 任务定义（三种原语）
| 原语 | 输入 | 输出 | 用途 |
|---|---|---|---|
| **Choice** | 帧 + 候选词表 W（雅思子集） | W 上概率分布 | 给框找词 / 给词找框 |
| **Noul** | (frame, box, word) | `P(match)` | 校验：这个词和这个框匹配吗 |
| **Score** | annotation + context | 0–1 质量分 | 众包标注质量排序 |

### 9.3 AI 能力边界（诚实评估）
| 任务 | 现在能力 | 用于标注 |
|---|---|---|
| 开放词表检测（名词） | 强 | ✅ 首轮建议框 |
| 分割（SAM2/SAM3） | 强 | ✅ 点/框→掩膜 |
| 单镜头内点/区域跟踪（CoTracker3） | 强 | ✅ 段内跟随 |
| 跨镜头跟踪 / Re-ID | 弱 | ⚠️ 人工补 |
| 动作/动词的空间定位 | 弱 | ❌ 动词不是框 |
| 视频 VLM 描述/判定（16 帧级） | 粗粒度 | ⚠️ 只能粗判 |
| 抽象概念 / 教学价值 | 不行 | ❌ 人工 |

> 结论：**AI 只做「提议 + 打分」，不做「终审」**。云端易得检测/分割，**追踪需自建**。

### 9.4 三阶段
- **Phase A（现成模型）**：云开放词表检测 + CLIP 做 `/suggest`；人确认。**先跑通闭环、攒数据。**
- **Phase B（训决策/打分头）**：用累积标注训轻量 **JEV 式 head**（4B 级 prefill 决策，形态同 NeoHorse-Jev），
  骨干可冻结（DINOv2/SigLIP/V-JEPA 类）。任务 = §9.2 的 Choice/Noul/Score。
- **Phase C（评测与迭代）**：用众包一致性做标签，BDC 式加权去噪；发布模型卡与评测报告。

### 9.5 数据引擎闭环
```
有人看视频 → AI 提议 → 人确认（产出标注） → 众包合并去噪
     ↑                                                    │
     └────── 模型变好 → 提议更准 → 标注更快 ←── 训练 JEV 式 head
```
数据来源合法：只存标注，不存媒体；标注附 `license` 与 `creator`。

## 10. 里程碑
| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0** | **跨端 userscript 核心**（无 AI）：拖框绑词 + **词库中英联想** + **开始时间/时长可调** + 本地存储 + **一键 `⇅ 同步`（零配置）** + 文件导入导出 + 内容区坐标 + **`dev/hub.py` 一键入口（二维码）** | 一条命令起服务→扫码/点击装好→B站标注→`⇅ 同步`成功；单测通过 |
| **P1** | 包成 **MV3 扩展** + `/suggest`（云开放词表）+ `/enrich` 词库附义 | 给 `tractor` 出候选框；确认即附释义/词根 |
| **P2** | W3C 兼容 Pack/Feed + 文件/git 交换 + 客户端合并去重 | 两台机器离线交换并正确渲染 |
| **P3** | 观看端叠加（他人 Pack 在原视频上呈现） | 同视频看到他人标注并查词 |
| **P4** | 学习闭环：收词 → `../ielts-7.5` SRS/Anki；主题片单（只选片不制片） | 收词进入到期卡 |
| **P5** | 平台适配（B站→抖音） | B站可用；抖音降级可用 |
| **P6** | 轨迹/动作标注（CoTracker/SAM2 辅助） | 段内跟随可用 |
| **M（终局）** | Phase A→B→C：训出并评测 JEV 式 word↔region 决策模型 | §12 指标达标 + 模型卡 |

### 移动端子里程碑（不自建浏览器）
| 阶段 | 交付 | 说明 |
|---|---|---|
| **M0** | Android：Kiwi/Firefox 加载同一 userscript，观看+标注 | ≈0 额外代码，做适配测试 |
| **M1** | iOS：Safari 现成脚本管理器加载 userscript，**观看端优先** | 查词/收词/看他人标注；无 AI 抓帧 |
| **M2** | iOS 标注降级：手动拖框/点选 | 无 AI 建议；或「分享截图到桌面/服务」补 AI |
| **M3** | （可选）自建 webview 观看壳 | 仅当 iOS 在线叠层强需求且脚本管理器不满足时 |

## 11. 风险与合规
| 风险 | 对策 |
|---|---|
| 云侧无合适**开放词表**端点 | 先核实 SiliconFlow/HF/Replicate；无则自建小推理容器（顺带补 V6 部署） |
| canvas 跨域抓帧 | 用 `captureVisibleTab` 裁剪，不用 drawImage |
| 坐标漂移 | 内容区归一化 + intrinsic，P0 定死并测 |
| 平台 ToS/反爬 | 通用版先行，B站第二、抖音最后 |
| 移动端系统限制 | 不自建浏览器：Android 借扩展浏览器、iOS 借现成脚本管理器；仅 iOS 无 AI 抓帧 |
| 脚本管理器限额 / 站点 CSP 挡注入 | 适配层降级；备选 Safari 扩展（M3 自建 webview 兜底） |
| 两份产物（userscript/MV3）维护 | 共享 `core/`，仅构建差异 |
| 众包数据噪声 | 客户端投票 + 作者质量加权（BDC 思路） |
| 版权 | 不存媒体；Pack 内嵌 license/credit；非商用 |
| 训练数据量不足 | Phase A 先攒；head 用冻结骨干，小样本即可起步 |

## 12. 成功标准
- 标注一帧 ≤ 10 秒（含 AI 建议）；暂停帧坐标零漂移。
- Pack 可离线交换并在第二台机器正确渲染。
- 学习者能用同一 Pack 在原视频上查词并收词进 SRS。
- 全程不产生、不托管任何媒体文件。
- **模型**：`/suggest` Recall@5 ≥ X、`/judge` AUC ≥ Y（在自建评测集上），并发布模型卡。

## 13. 与本项目的关系
- 本项目从 `ielts-7.5` 拆出；`ielts-7.5` 的 `app/immersion`（农场导读片）留在原仓库并转遗留/暂停。
- immersion 唯一保留价值——「一词只出现一次 + 名/动/形配平」——在本项目转为**标注包的目标词集规则**（给视频指定目标词表）。
- 雅思词表、SRS/Anki 等仅作为**可选的下游消费者**，不是本项目的目标或依赖。

## 14. 未决
- Pack/Feed 的签名方案（ed25519 vs 简易 sha256+来源声明）。
- 云开放词表模型选型（P1 前核实）。
- 观看页：沿用 `immersion/index.html` 还是纯扩展内渲染。
- 自建评测集规模与协议（用于 §12 的模型指标）。

## 15. 扩展方向：多媒态 · 多平台 · 社交层（新）

**立场升级**：不止「数据标注市场」，更是「**内容之上的社交标注层**」——别人的内容不动，只加一层可共享标注。

- **多媒态（同一 schema 通吃）**
  | 媒态 | 选择器 | 落地成本 |
  |---|---|---|
  | 视频（已支持） | 时间片段 `t` + 区域 `box` | — |
  | **图片** | 仅 `box`（复用 `geometry.js`，`t/dur` 置空） | 低（第二个场景验证） |
  | **文章/网页** | 文字范围 `TextQuoteSelector`/`TextPositionSelector` + 评论 `motivation:"commenting"` | 中 |
- **多平台**：`bilibili / douyin / youtube / generic` → 增 **Facebook / X / Instagram**；同一 adapter 模式，难点是登录墙与反爬。
- **社交属性**：关注 / 发现 / 热门标注 / 幂等合并 → 需要轻后端与身份（可选去中心化 feed）。
- **结构性红利**：现数据模型 `entries[{box,word,…}]` 已是 W3C Web Annotation 子集 → 图片=去时间维、文章=换 selector、评论=换 body。**一套模型覆盖全部媒态**。
- **建议顺序**：图片标注 → 文章文字标注+评论 → 社交平台 adapter → 社会化（发现/关注/热门）。
