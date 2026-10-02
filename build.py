#!/usr/bin/env python3
"""把 src/*.js 拼成 dist/annotate.user.js（无构建依赖，纯拼接）。

用法: python3 build.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DIST = os.path.join(HERE, "dist")
VERSION = "0.1.0"

HEADER_BASE = """// ==UserScript==
// @name         {name}
// @namespace    https://video-annotate.local/
// @version      {version}
// @description  给视频和网页内容添加可共享标注（框选、时间锚点、词条与同步）
// @author       Annota
// @match        *://*/*
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

PARTS = ["geometry.js", "textquote.js", "adapter.js", "media.js"]
TAIL = ["design-tokens.js", "overlay-theme.js", "core.js"]


def read_src(p):
    with open(os.path.join(SRC, p), encoding="utf-8") as f:
        return f.read().rstrip()


def main():
    os.makedirs(DIST, exist_ok=True)
    body = []
    for p in PARTS:
        body.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))

    # 烧入同步地址候选（由 dev/hub.py 写入 dist/.syncurl），实现零配置
    spath = os.path.join(DIST, ".syncurl")
    urls = open(spath, encoding="utf-8").read().strip() if os.path.exists(spath) else "[]"
    body.append("/* ===== data: sync urls ===== */\nwindow.VA_SYNC_URLS=%s;\n" % urls)

    for p in TAIL:
        body.append("/* ===== src/%s ===== */\n%s\n" % (p, read_src(p)))

    for fn, meta in VARIANTS.items():
        header = HEADER_BASE.format(name=meta["name"], version=VERSION, grant=meta["grant"]) + meta.get("config", "")
        out = os.path.join(DIST, fn)
        # 前置 UTF-8 BOM：无 charset 响应头时也按 UTF-8 解码，避免中文乱码
        with open(out, "w", encoding="utf-8") as f:
            f.write("\ufeff" + header + "\n" + "\n".join(body))
        print("built:", os.path.relpath(out, HERE), os.path.getsize(out), "bytes")

    # MV3 扩展 / 自建浏览器壳 的 core（与 userscript 共用同一份）
    for sub in ("extension", "browser"):
        d = os.path.join(HERE, "app", sub)
        if os.path.isdir(d):
            with open(os.path.join(d, "core.js"), "w", encoding="utf-8") as f:
                f.write("\n".join(body))
            print("built:", os.path.relpath(os.path.join(d, "core.js"), HERE))


if __name__ == "__main__":
    main()
