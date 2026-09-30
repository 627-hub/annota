# 安装与宿主选择

> **最简单**：在电脑上跑 `python3 dev/hub.py`，会打开**入口页**：
> 手机扫码安装、电脑点击安装、先试玩——同步地址已内置，装完即用。

---


> 本项目脚本 `@grant none`，**不依赖任何 GM 特权 API**，因此任意用户脚本管理器都能跑。
> **不要为 Apple 平台买 Tampermonkey**（App Store 付费）；用免费的 Userscripts。

## 宿主（借现成，不自建浏览器）
**火狐不是必须的**——每端任选一个免费管理器即可：

| 端 | 推荐（免费，任选其一） | 备注 |
|---|---|---|
| 桌面 Chrome / Edge | Tampermonkey 或 **Violentmonkey** | Chrome 138+ 需在 `chrome://extensions` 开「允许用户脚本」 |
| 桌面 Safari / macOS | **Userscripts**（开源 GPLv3） | 也可 Firefox + Violentmonkey（按喜好，非必须） |
| iOS / iPadOS Safari | **Userscripts** | 完全免费开源；替代付费的 Tampermonkey |
| iOS / iPadOS / macOS Safari（备选） | **Stay for Safari** | 免费下载 + Pro 终身 $4.99；GM API 覆盖更广 |
| Android | **Kiwi Browser** + Violentmonkey | 或 Firefox Android + Violentmonkey（二选一） |

## 三个变体（按角色选）
| 文件 | 用途 |
|---|---|
| `annotate.user.js` | **电脑 · 编辑**（默认） |
| `annotate.gm.user.js` | 电脑 · 编辑（GM 请求，跨 CORS/混合内容） |
| `annotate.view.user.js` | **手机 · 观看**：只读 + 打开即自动同步 |

### Apple 端：Userscripts vs Stay
- 两者都能跑本项目脚本（我们 `@grant none`，无需 GM 特权）。
- **Userscripts**：零成本、纯开源，默认选择。
- **Stay**：想要更省心的 iOS 管理（书签同步/下载/暗黑/广告拦截 + GM API 覆盖更广）时选它；Pro **$4.99 一次性**（免费版功能受限）。
- 不建议 Tampermonkey（Apple 端更贵且闭源）。

## 安装脚本
产物：`dist/annotate.user.js`
- **桌面管理器**：新建脚本 → 粘贴内容；或把文件拖入扩展页面。
- **Userscripts（iOS/macOS）**：两种方式
  1. 在 Safari 打开一个**以 `.user.js` 结尾**的 URL，点扩展图标 → 出现安装提示；
  2. 把 `annotate.user.js` 存进 Userscripts 的脚本目录。
- **iOS 必做**：设置 → Safari → 扩展 → Userscripts → 打开，并「对所有网站始终允许」。

## 本地自测（不需要任何管理器）
```bash
python3 build.py
python3 dev/serve.py
# 打开 http://127.0.0.1:8792/dev/demo.html （页面已直接引入 userscript）
# 安装用：http://127.0.0.1:8792/dist/annotate.user.js
```
> **中文乱码排查**：产物已带 UTF-8 BOM；本地务必用 `dev/serve.py`（对 `.js` 回 `charset=utf-8`）。
> 若从 URL 安装仍是乱码，说明该托管没给 charset —— 换 GitHub Raw（会带 `charset=utf-8`）或直接粘贴源码。

## 上线分发（后续）
把 `dist/annotate.user.js` 放到任意静态 URL（GitHub Raw / Gist / 自建），用户访问该 `.user.js` 链接即可安装——与「去中心化、不做平台」的定位一致。
