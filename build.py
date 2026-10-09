#!/usr/bin/env python3
"""把 src/*.js 拼成 dist/annotate.user.js（无构建依赖，纯拼接）。

用法: python3 build.py
"""
import json
import os
import re
import hashlib
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DIST = os.path.join(HERE, "dist")
VERSION_PATH = os.path.join(HERE, "VERSION")
BUILD_TIME_PATH = os.path.join(DIST, ".buildtime")

# 发布基址：脚本自更新（@updateURL/@downloadURL）与版本探测都指向它。
# 默认 = CloudBase 静态托管域名；本地/分支发布可用 ANNOTA_DIST_BASE 覆盖。
DIST_BASE = os.environ.get("ANNOTA_DIST_BASE", "https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com").rstrip("/")

# US_VER（userscript 版本）每次构建递增：管理器据此判断「有新版」。
# BUILD_VER（构建号）时间戳：内容真变了才 +1，供脚本内「版本探测」比对（避免无意义重建触发提示）。
BASE_VERSION = "0.1.0"

HEADER_BASE = """// ==UserScript==
// @name         {name}
// @namespace    https://video-annotate.local/
// @version      {version}
// @description  给视频和网页内容添加可共享标注（框选、时间锚点、词条与同步）
// @author       Annota
// @match        *://*/*
// @updateURL    {base}/{file}
// @downloadURL  {base}/{file}
{grant}// @run-at       document-idle
// @noframes
// ==/UserScript==
// Annota · 内容标注层。Apple（macOS/iOS Safari）可使用免费开源的 Userscripts。
// 构建 build.py ｜ 自测 dev/demo.html ｜ 文档 README.md、docs/spec.md
"""

# 变体：编辑版（桌面）、GM 编辑版、观看版（手机，只读 + 自动同步）
VARIANTS = {
    "annotate.user.js": {"name": "Annota（编辑）", "grant": "// @grant        none\n", "config": ""},
    "annotate.gm.user.js": {"name": "Annota（编辑 · GM）", "grant": "// @grant        GM_xmlhttpRequest\n// @connect      *\n", "config": ""},
    "annotate.view.user.js": {"name": "Annota（只读观看端）", "grant": "// @grant        GM_xmlhttpRequest\n// @connect      *\n", "config": "window.VA_VIEW_ONLY=true;window.VA_AUTO_SYNC=true;\n"},
}

# 浏览器壳变体（Tauri 内联；无 userscript header/BOM，注入 browser-shell.js）
BROWSER_VARIANT = "annotate.browser.js"

PARTS = ["geometry.js", "textquote.js", "adapter.js", "media.js", "identity.js"]
# browser-shell.js 在 core.js 之前（core 启动时读取 window.VA_BROWSER_SHELL）
TAIL = ["design-tokens.js", "overlay-theme.js", "group.js", "export.js", "version-check.js", "browser-shell.js", "core.js"]
# 浏览器壳变体不装 version-check.js：那是 userscript 的自动更新探测，
# 浏览器端有 tauri-plugin-updater，二者不能混。
BROWSER_TAIL = ["design-tokens.js", "overlay-theme.js", "group.js", "export.js", "browser-shell.js", "core.js"]


def read_src(p):
    with open(os.path.join(SRC, p), encoding="utf-8") as f:
        return f.read().rstrip()


def read_pk():
    """读取发布用 Publishable Key（公开值）并内联进 userscript。

    优先级：环境变量 ANNOTA_CB_PK → app/service/cb-config.js（工作区/组页同一份来源）。
    缺省留空字符串：注入态读不到 key，hub 组不可用，但不影响其它功能。
    """
    pk = os.environ.get("ANNOTA_CB_PK", "").strip()
    if pk:
        return pk
    cfg = os.path.join(HERE, "app", "service", "cb-config.js")
    if os.path.exists(cfg):
        try:
            txt = open(cfg, encoding="utf-8").read()
            m = re.search(r'__ANNOTA_CB_PK__\s*=\s*["\']([^"\']*)["\']', txt)
            if m:
                return m.group(1).strip()
        except OSError:
            pass
    return ""


def bump_version():
    """每次构建递增 US_VER（patch 位）；返回 "BASE.<n>"。"""
    n = 0
    if os.path.exists(VERSION_PATH):
        try:
            n = int(open(VERSION_PATH, encoding="utf-8").read().strip())
        except (OSError, ValueError):
            n = 0
    n += 1
    with open(VERSION_PATH, "w", encoding="utf-8") as f:
        f.write("%d\n" % n)
    return "%s.%d" % (BASE_VERSION, n)


def build_number(body_text):
    """内容指纹（构建号）。与上次不同才递增 dist/.buildtime，作为脚本内版本探测的基准。"""
    digest = hashlib.sha1(body_text.encode("utf-8")).hexdigest()
    state = {}
    if os.path.exists(BUILD_TIME_PATH):
        try:
            state = json.load(open(BUILD_TIME_PATH, encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
    if not isinstance(state, dict):
        state = {}
    if state.get("hash") == digest and state.get("t"):
        return int(state["t"])
    stamp = int(datetime.now(timezone.utc).timestamp())
    with open(BUILD_TIME_PATH, "w", encoding="utf-8") as f:
        json.dump({"t": stamp, "hash": digest}, f)
    return stamp


def main():
    os.makedirs(DIST, exist_ok=True)
    body = []
    for p in PARTS:
        body.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))

    # 同步地址候选：默认「发布构建」烧空列表（避免把本机/LAN 拓扑写进发行物）。
    # 本地零配置调试时：`ANNOTA_LOCAL_SYNC=1 python3 build.py` 才会读 dev/hub.py 写入的 dist/.syncurl。
    spath = os.path.join(DIST, ".syncurl")
    if os.environ.get("ANNOTA_LOCAL_SYNC") == "1" and os.path.exists(spath):
        urls = open(spath, encoding="utf-8").read().strip() or "[]"
    else:
        urls = "[]"
    body.append("/* ===== data: sync urls ===== */\nwindow.VA_SYNC_URLS=%s;\n" % urls)

    # 注入态（B站/YouTube 等）没有宿主页的 window.__ANNOTA_CB_PK__，这里内联发布 PK，
    # 使观看端/编辑端脚本在真站点也能用 hub 组。PK 是公开值，随脚本分发无碍。
    pk = read_pk()
    if pk:
        body.append("/* ===== data: hub publishable key ===== */\nwindow.__ANNOTA_CB_PK__=%s;\n" % json.dumps(pk))

    for p in TAIL:
        body.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))

    body_text = "\n".join(body)

    # 版本：US_VER 每次构建递增（管理器自动更新）、BUILD_VER=内容构建号（脚本内版本探测）。
    us_ver = bump_version()
    build_ver = build_number(body_text)
    body_text = ("/* ===== data: build id ===== */\n"
                 "window.VA_BUILD=%d;\nwindow.VA_US_VER=%s;\nwindow.VA_DIST_BASE=%s;\n"
                 % (build_ver, json.dumps(us_ver), json.dumps(DIST_BASE))) + body_text

    for fn, meta in VARIANTS.items():
        header = HEADER_BASE.format(name=meta["name"], version=us_ver, grant=meta["grant"], base=DIST_BASE, file=fn) + meta.get("config", "")
        out = os.path.join(DIST, fn)
        # 前置 UTF-8 BOM：无 charset 响应头时也按 UTF-8 解码，避免中文乱码
        with open(out, "w", encoding="utf-8") as f:
            f.write("\ufeff" + header + "\n" + body_text)
        print("built:", os.path.relpath(out, HERE), os.path.getsize(out), "bytes", "· us_ver=%s build=%d" % (us_ver, build_ver))

    # 浏览器壳变体（Tauri 内联）：无 userscript header、无 BOM、无 version-check.js、
    # 烧本地同步地址（Tauri 本地服务 8793）、含 browser-shell.js 接缝。
    bbody = []
    for p in PARTS:
        bbody.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))
    bbody.append("/* ===== data: sync urls ===== */\nwindow.VA_SYNC_URLS=[\"http://127.0.0.1:8793\",\"http://localhost:8793\"];\n")
    if pk:
        bbody.append("/* ===== data: hub publishable key ===== */\nwindow.__ANNOTA_CB_PK__=%s;\n" % json.dumps(pk))
    for p in BROWSER_TAIL:
        bbody.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))
    browser_header = ("// Annota · 浏览器壳变体（Tauri 内联）。无 userscript 元数据；"
                      "无 version-check；含 browser-shell.js 接缝。\n")
    browser_out = os.path.join(DIST, BROWSER_VARIANT)
    with open(browser_out, "w", encoding="utf-8") as f:
        f.write(browser_header + "\n".join(bbody))
    print("built:", os.path.relpath(browser_out, HERE), os.path.getsize(browser_out), "bytes", "· browser variant")

    # MV3 扩展 的 core（与 userscript 共用同一份）。
    # M8-1：Electron 壳（app/browser）已冻结，不再生成其 core.js（保留末版在库）。
    for sub in ("extension",):
        d = os.path.join(HERE, "app", sub)
        if os.path.isdir(d):
            with open(os.path.join(d, "core.js"), "w", encoding="utf-8") as f:
                f.write(body_text)
            print("built:", os.path.relpath(os.path.join(d, "core.js"), HERE))

    # 版本探测顶标：脚本据此判断远端是否有新版（build 号更大）。
    write_version_json(build_ver, us_ver)


def write_version_json(build_ver, us_ver):
    payloads = {
        "version.json": {"build": build_ver, "usVersion": us_ver, "at": datetime.now(timezone.utc).isoformat()},
    }
    for name, obj in payloads.items():
        with open(os.path.join(DIST, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        print("built:", os.path.relpath(os.path.join(DIST, name), HERE), json.dumps(obj, ensure_ascii=False))


if __name__ == "__main__":
    main()
