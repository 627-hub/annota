#!/usr/bin/env python3
"""video-annotate · 最小同步服务（标准库，无依赖）

接口（CORS 全开，供 userscript 在任意站点 fetch）：
  GET  /api/health
  GET  /api/list                   列出已存 mediaId
  GET  /api/anno/<key>            取标注 pack（无则返回空 entries）
  PUT  /api/anno/<key>            合并写入 pack（去重），返回合并后结果
                                 请求体含 "replace": true（或 ?replace=1）时整包替换
  POST /api/anno/<key>            同 PUT
  OPTIONS *                       预检

存储：app/service/store/<key>.json
用法：python3 app/service/sync_server.py   （默认 127.0.0.1:8793，PORT 可改）
"""
import base64
import datetime
import html
import json
import mimetypes
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))      # 仓库根（同时提供静态文件，便于一条隧道走天下）
STORE = os.path.join(HERE, "store")
NOTES_DIR = os.environ.get("NOTES_DIR") or os.path.join(HERE, "notes")   # 可指向 Obsidian 库目录
EXPORTS = os.environ.get("EXPORT_DIR") or os.path.join(HERE, "exports")   # 本地个人导出（截图卡 → Anki）
try:
    import anki_export
except ImportError:
    sys.path.insert(0, HERE)
    import anki_export
HOST = os.environ.get("HOST", "0.0.0.0")   # 默认监听全部网卡，便于手机访问；仅限可信局域网
PORT = int(os.environ.get("PORT", "8793"))
MAX_BODY = 8 * 1024 * 1024


_LOCKS = {}
_LOCK_GUARD = threading.Lock()


def key_lock(key):
    with _LOCK_GUARD:
        lk = _LOCKS.get(key)
        if lk is None:
            lk = _LOCKS[key] = threading.Lock()
        return lk


def key_to_file(key):
    safe = re.sub(r"[^\w.-]+", "_", key)[:120] or "_"
    return os.path.join(STORE, safe + ".json")


def valid_box(b):
    if not isinstance(b, dict):
        return False
    for k in ("x", "y", "w", "h"):
        v = b.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return False
    return True


def valid_quote(q):
    if not isinstance(q, dict):
        return False
    exact = q.get("exact")
    return isinstance(exact, str) and bool(exact.strip())


def valid_anchor(e):
    return valid_box(e.get("box")) or valid_quote(e.get("quote"))


def entry_has_content(e):
    # 通用批注：word 可空，标签/备注至少一个（§8.3 A）
    word = str(e.get("word") or "").strip()
    label = str(e.get("label") or "").strip()
    tags = e.get("tags") if isinstance(e.get("tags"), list) else []
    return bool(word or label or tags)


def to_float(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def iou(a, b):
    if not valid_box(a) or not valid_box(b):
        return 0.0
    ax2, ay2, bx2, by2 = a["x"] + a["w"], a["y"] + a["h"], b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    un = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / un if un > 0 else 0.0


def _tag_key(e):
    tags = e.get("tags") if isinstance(e.get("tags"), list) else []
    return ",".join(sorted(str(t).lower() for t in tags))


def same(e, o):
    if (e.get("word") or "") != (o.get("word") or ""):
        return False
    if not (e.get("word") or o.get("word")):
        # 无词条目：备注 + 标签共同区分（纯标签标注不被误并）
        if str(e.get("label") or "") != str(o.get("label") or ""):
            return False
        if _tag_key(e) != _tag_key(o):
            return False
    eb, ob = valid_box(e.get("box")), valid_box(o.get("box"))
    if eb and ob:
        if abs(to_float(e.get("t")) - to_float(o.get("t"))) >= 0.4:
            return False
        return iou(e.get("box"), o.get("box")) > 0.6
    eq, oq = valid_quote(e.get("quote")), valid_quote(o.get("quote"))
    if eq and oq:
        return e["quote"]["exact"] == o["quote"]["exact"]   # 文本锚点：同一段文字即同一标注
    return False


def merge_entries(a, b):
    out = []
    for e in list(a) + list(b):
        if not isinstance(e, dict) or not valid_anchor(e) or not entry_has_content(e):
            continue
        if any(same(e, o) for o in out):
            continue
        out.append(e)
    return out


def read_pack(key):
    p = key_to_file(key)
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"format": "video-annotate/0.1", "media": {"videoId": key}, "entries": []}


def write_pack(key, pack):
    os.makedirs(STORE, exist_ok=True)
    p = key_to_file(key)
    fd, tmp = tempfile.mkstemp(dir=STORE, suffix=".part")   # 每次唯一临时名，避免并发写互相踩
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pack, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return p


# ---------- 批量导出：截图卡 → Anki（本地个人导出；共享 Pack 不含截图，见 architecture.md ADR-6）----------
def _esc(s):
    return html.escape(str(s if s is not None else ""))


def _shot_name(idx):
    return "annota_%s.png" % re.sub(r"[^\w.-]+", "_", str(idx))[:60]


def _deck_key(deck_id):
    return re.sub(r"[^\w.-]+", "_", str(deck_id))[:80] or "deck"


def _deck_tmp(deck_id):
    return os.path.join(EXPORTS, ".tmp", _deck_key(deck_id))


_LANG_TAGS = {"英语", "英文", "日语", "法语", "德语", "西班牙语", "韩语", "俄语",
              "雅思", "托福", "考研", "四六级", "专四", "专八", "英语学习", "语言学习"}
_LANG_TAG_PREFIX = ("英语", "日语", "法语", "德语", "韩语", "西班牙", "俄语", "葡萄牙")


def _is_lang_tag(t):
    t = str(t or "")
    return t in _LANG_TAGS or t.endswith("语") or any(t.startswith(p) for p in _LANG_TAG_PREFIX)


def _card_html(entry, media, t, idx, has_shot):
    raw_word = entry.get("word") or ""
    word = _esc(raw_word if str(raw_word).strip() else ((entry.get("tags") or ["标注"])[0]))
    label = _esc(entry.get("label"))
    pos = _esc(entry.get("pos"))
    tagstr = _esc(" ".join("#" + str(x) for x in (entry.get("tags") or [])))
    plat, title, url = _esc(media.get("platform")), _esc(media.get("title")), _esc(media.get("url"))
    # 正面 = 只看单词；背面 = 词 + 截图 + 释义/词性 + 来源
    front = '<div class="va-word">%s</div>' % word
    shot = ('<img src="%s">' % _shot_name(idx)) if has_shot else ''
    back = ('<div class="va-word">%s</div>%s<div class="va-meta">%s %s %s</div>'
            '<div class="va-src">%s · %s · %ss<br>%s</div>'
            % (word, shot, label, pos, tagstr, plat, title, t, url))
    return front, back


def export_card(payload):
    deck_id = payload.get("deck_id") or "deck"
    idx = payload.get("idx")
    if idx is None:
        raise ValueError("idx 必填")
    # 每次导出是新一批：首卡到来时清空上一批，避免残留旧卡（按 idx 命名会串数据）
    if idx == 0:
        shutil.rmtree(os.path.join(_deck_tmp(deck_id), "cards"), ignore_errors=True)
        shutil.rmtree(os.path.join(_deck_tmp(deck_id), "media"), ignore_errors=True)
    d = os.path.join(_deck_tmp(deck_id), "cards")
    os.makedirs(d, exist_ok=True)
    shot = payload.get("screenshot")
    has_shot = False
    if isinstance(shot, str) and shot.startswith("data:image") and "," in shot:
        try:
            blob = base64.b64decode(shot.split(",", 1)[1])
        except Exception:
            blob = b""
        if blob:
            md = os.path.join(_deck_tmp(deck_id), "media")
            os.makedirs(md, exist_ok=True)
            with open(os.path.join(md, _shot_name(idx)), "wb") as f:
                f.write(blob)
            has_shot = True
    rec = {"idx": idx, "entry": payload.get("entry") or {}, "media": payload.get("media") or {},
           "has_shot": has_shot, "t": to_float((payload.get("entry") or {}).get("t"))}
    with open(os.path.join(d, _deck_key(idx) + ".json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False)
    return {"has_shot": has_shot, "done": len([x for x in os.listdir(d) if x.endswith(".json")])}


def export_finalize(payload):
    deck_id = payload.get("deck_id") or "deck"
    deck_name = (payload.get("deck_name") or "Annota").strip() or "Annota"
    cdir = os.path.join(_deck_tmp(deck_id), "cards")
    if not os.path.isdir(cdir):
        raise ValueError("没有可导出的卡片（先调 /api/export/card）")
    recs, skipped = [], 0
    for fn in os.listdir(cdir):
        if fn.endswith(".json"):
            try:
                with open(os.path.join(cdir, fn), encoding="utf-8") as f:
                    recs.append(json.load(f))
            except Exception:
                skipped += 1   # 损坏卡：跳过并计数（不静默吞掉）
    recs.sort(key=lambda r: to_float(r.get("idx")))
    media_dir = os.path.join(_deck_tmp(deck_id), "media")
    os.makedirs(EXPORTS, exist_ok=True)
    # 文件名：annota_<视频号>.apkg（视频号取自首卡 media；不掺中文 deck 名，避免被洗成下划线）
    mid_raw = ""
    if recs:
        m0 = recs[0].get("media") or {}
        mid_raw = str(m0.get("mediaId") or m0.get("videoId") or "")
    if not mid_raw:
        mid_raw = deck_id
    mid = mid_raw.replace(":", "_")
    mid = re.sub(r"[^\w.-]+", "", mid).strip("._")[:80] or "video"
    out = os.path.join(EXPORTS, "annota_%s.apkg" % mid)
    notes, media_files = [], []
    for r in recs:
        e, m, idx = r.get("entry") or {}, r.get("media") or {}, r.get("idx", 0)
        front, back = _card_html(e, m, r.get("t", 0), idx, bool(r.get("has_shot")))
        if r.get("has_shot"):
            p = os.path.join(media_dir, _shot_name(idx))
            if os.path.exists(p):
                with open(p, "rb") as f:
                    media_files.append((_shot_name(idx), f.read()))
        # 标签：固定 annota + 只保留用户选的语言学习类 tag（英语学习/雅思…）
        lang_tags = [str(x) for x in (e.get("tags") or []) if _is_lang_tag(x)]
        tags = ["annota"] + lang_tags
        mid = m.get("mediaId") or m.get("videoId") or ""
        notes.append({"guid": anki_export.guid_for(mid, e.get("id") or idx),
                      "front": front, "back": back, "tags": tags,
                      "sort": e.get("word") or ""})
    anki_export.build_apkg(out, deck_name, notes, media=media_files)
    return {"path": out, "url": "/exports/" + os.path.basename(out),
            "cards": len(notes), "media": len(media_files), "skipped": skipped}


class Handler(BaseHTTPRequestHandler):
    server_version = "video-annotate-sync/0.1"

    def _cors(self):
        # 只反射本机/局域网来源（file://、扩展、localhost、私网 IP），避免任意站点跨源调用写/对话/笔记接口
        origin = self.headers.get("Origin") or ""
        if origin == "null" or re.match(r"^(chrome-extension|moz-extension|safari-web-extension)://", origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        else:
            host = ""
            try:
                host = urllib.parse.urlparse(origin).hostname or ""
            except Exception:
                host = ""
            if host in ("localhost", "127.0.0.1", "::1") or re.match(r"^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.", host):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _key(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/anno/(.+)$", path)
        return urllib.parse.unquote(m.group(1)) if m else None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _html(self, code, page):
        body = page.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _landing(self):
        os.makedirs(STORE, exist_ok=True)
        items = ""
        for fn in sorted(os.listdir(STORE)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(STORE, fn)
            try:
                with open(p, encoding="utf-8") as f:
                    o = json.load(f)
                key = (o.get("media") or {}).get("videoId") or fn[:-5]
                n = len(o.get("entries", []))
            except Exception:
                key, n = fn[:-5], "?"
            items += '<li><code>%s</code> — %s 条 <a href="/api/anno/%s">json</a></li>' % (
                html.escape(str(key)), n, urllib.parse.quote(str(key)))
        if not items:
            items = "<li>（暂无）</li>"
        page = """<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>video-annotate · 同步服务</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;background:#0b0e13;color:#e6edf3;
margin:0;padding:28px;max-width:720px}h1{font-size:19px;color:#f0b429}code{color:#9ecbff}
li{margin:4px 0}a{color:#58a6ff}.k{color:#8b949e}</style>
<h1>video-annotate · 同步服务</h1>
<p>状态：<b style="color:#7ee787">运行中</b>　存储：<code>%s</code></p>
<p>API：<code>GET/PUT /api/anno/&lt;mediaId&gt;</code>，<code>GET /api/list</code>，<code>GET /api/health</code></p>
<h2 style="font-size:15px">已存标注</h2><ul>%s</ul>
<p class="k">手机自测：同一 Wi‑Fi 下打开 <code>http://&lt;本机IP&gt;:8792/dev/demo.html</code><br>
脚本内 <code>⚙ → 同步地址</code> 填 <code>http://&lt;本机IP&gt;:8793</code></p>
</html>""" % (html.escape(STORE), items)
        return self._html(200, page)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", ""):
            if os.path.isfile(os.path.join(ROOT, "dev", "hub.html")):
                return self._static()          # 已有一键入口页 → 直接给
            return self._landing()
        if path in ("/console", "/console/"):
            return self._serve_console()
        if path == "/api/health":
            return self._json(200, {"ok": True, "store": STORE, "host": HOST, "port": PORT})
        if path == "/api/ai":
            base, key, model = llm_conf()
            return self._json(200, {"ok": True, "configured": bool(key), "model": model, "base": base})
        if path == "/api/list":
            os.makedirs(STORE, exist_ok=True)
            return self._json(200, {"files": sorted(os.listdir(STORE))})
        if path.startswith("/exports/"):
            return self._serve_export(path)
        key = self._key()
        if key:
            return self._json(200, read_pack(key))
        return self._static()

    def _serve_console(self):
        fp = os.path.join(HERE, "console.html")
        if not os.path.isfile(fp):
            return self._json(404, {"error": "console not found"})
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_export(self, path):
        name = os.path.basename(urllib.parse.unquote(path))
        fp = os.path.normpath(os.path.join(EXPORTS, name))
        if not (fp == EXPORTS or fp.startswith(EXPORTS + os.sep)) or not os.path.isfile(fp):
            return self._json(404, {"error": "not found"})
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path in ("", "/"):
            path = "/dev/hub.html"
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        # 目录边界校验：必须真在 ROOT 之下（挡掉 /repo-secrets 这类前缀兄弟目录）
        if fp != ROOT and not fp.startswith(ROOT + os.sep):
            return self._json(404, {"error": "not found"})
        if not os.path.isfile(fp):
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        if ctype.startswith("text/") or fp.endswith((".js", ".json", ".svg")):
            if "charset" not in ctype:
                ctype += "; charset=utf-8"
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        self._put()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/chat":
            return self._chat()
        if path == "/api/note":
            return self._note()
        if path == "/api/export/card":
            return self._export(export_card)
        if path == "/api/export/finalize":
            return self._export(export_finalize)
        self._put()

    def _export(self, fn):
        raw, err = self._body()
        if err:
            return self._json(413, {"ok": False, "error": err})
        try:
            payload = json.loads(raw) if raw else {}
            return self._json(200, {"ok": True, **fn(payload)})
        except Exception as e:
            return self._json(400, {"ok": False, "error": str(e)})

    def _body(self):
        """统一读体：带上限与负长度保护；返回 (data, err)"""
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > MAX_BODY:
            return None, "body too large"
        return (self.rfile.read(n).decode("utf-8") if n else ""), None

    def _note(self):
        raw, err = self._body()
        if err:
            return self._json(413, {"ok": False, "error": err})
        try:
            rec = json.loads(raw) if raw else {}
            p = save_note(rec)
            return self._json(200, {"ok": True, "path": p, "dir": NOTES_DIR})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})

    def _chat(self):
        raw, err = self._body()
        if err:
            return self._json(413, {"ok": False, "error": err})
        try:
            req = json.loads(raw) if raw else {}
            messages = req.get("messages") or []
            if not isinstance(messages, list) or not messages:
                return self._json(400, {"ok": False, "error": "messages 必填"})
            return self._json(200, {"ok": True, "text": llm_chat(messages)})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})

    def _put(self):
        key = self._key()
        if not key:
            return self._json(404, {"error": "bad path"})
        raw, err = self._body()
        if err:
            return self._json(413, {"error": err})
        try:
            incoming = json.loads(raw) if raw else {}
            if not isinstance(incoming, dict):
                return self._json(400, {"error": "bad body"})
        except Exception as e:
            return self._json(400, {"error": "bad json: %s" % e})

        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        replace = bool(incoming.get("replace")) or bool(query.get("replace"))

        try:
            with key_lock(key):        # 同 key 读-合并-写原子，避免并发丢写
                cur = read_pack(key)
                if replace:            # 整包替换：只保留本次提交的 entries（仍过滤/去重）
                    entries = merge_entries([], incoming.get("entries", []) or [])
                else:
                    entries = merge_entries(cur.get("entries", []), incoming.get("entries", []) or [])
                media = incoming.get("media") or cur.get("media") or {"videoId": key}
                fmt = incoming.get("format") or cur.get("format") or "video-annotate/0.1"
                pack = {"format": fmt, "media": media, "entries": entries}
                write_pack(key, pack)
        except Exception as e:
            return self._json(500, {"error": "merge failed: %s" % e})
        return self._json(200, pack)

    def log_message(self, fmt, *args):
        sys.stderr.write("[sync] %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


# ---------- 笔记导出（Markdown → Obsidian/Notebook）+ 数据沉淀 ----------
def render_note(title, media, entries, chat, img_rel, created):
    created = created or datetime.datetime.now().isoformat(timespec="seconds")
    L = ["---",
         "title: %s" % title.replace("\n", " "),
         "source: %s" % (media.get("url") or ""),
         "media: %s" % (media.get("mediaId") or media.get("videoId") or ""),
         "platform: %s" % (media.get("platform") or ""),
         "type: %s" % (media.get("type") or "video"),
         "created: %s" % created,
         "tags: [video-annotate, language, %s]" % (media.get("platform") or "video"),
         "---", "", "# %s" % title, ""]
    if img_rel:
        L += ["![%s](%s)" % (title, img_rel), ""]
    timed = (media.get("type") or "video") == "video"
    if entries:
        if timed:
            L += ["## 生词（标注）", "", "| 词 | 释义 | 词性 | 时刻(s) | 时长(s) |", "|---|---|---|---|---|"]
        else:
            L += ["## 生词（标注）", "", "| 词 | 释义 | 词性 | 锚点 |", "|---|---|---|---|"]
        for e in entries:
            if timed:
                L.append("| %s | %s | %s | %s | %s |" % (
                    e.get("word", ""), (e.get("label") or "").replace("|", "/"), e.get("pos", ""), e.get("t", ""), e.get("dur", "")))
            else:
                anchor = ((e.get("quote") or {}).get("exact") or "区域标注").replace("|", "/").replace("\n", " ")
                L.append("| %s | %s | %s | %s |" % (
                    e.get("word", ""), (e.get("label") or "").replace("|", "/"), e.get("pos", ""), anchor))
        L.append("")
    if chat:
        L += ["## 与豆包对话", ""]
        for m in chat:
            who = {"user": "我", "assistant": "豆包", "system": "系统"}.get(m.get("role"), m.get("role"))
            c = m.get("content")
            if not isinstance(c, str):
                c = json.dumps(c, ensure_ascii=False)
            L += ["**%s**：%s" % (who, c.replace("\n", "\n  ")), ""]
    return "\n".join(L) + "\n"


def save_note(rec):
    media = rec.get("media") or {}
    title = (rec.get("title") or "未命名").strip() or "未命名"
    entries = rec.get("entries") or []
    chat = rec.get("chat") or []
    shot = rec.get("screenshot")
    mid = media.get("videoId") or rec.get("mediaId") or "video"
    key = re.sub(r"[^\w.-]+", "_", str(mid))[:80] or "video"
    date = datetime.date.today().isoformat()
    os.makedirs(NOTES_DIR, exist_ok=True)
    sub = "%s_%s" % (date, key)
    img_rel = ""
    if isinstance(shot, str) and shot.startswith("data:image"):
        adir = os.path.join(NOTES_DIR, sub)
        os.makedirs(adir, exist_ok=True)
        parts = shot.split(",", 1)
        if len(parts) != 2 or not parts[1]:
            img_rel = ""
        else:
            with open(os.path.join(adir, "shot.png"), "wb") as f:
                f.write(base64.b64decode(parts[1]))
        img_rel = sub + "/shot.png"
    npath = os.path.join(NOTES_DIR, sub + ".md")
    with open(npath, "w", encoding="utf-8") as f:
        f.write(render_note(title, media, entries, chat, img_rel, rec.get("created")))
    with open(os.path.join(NOTES_DIR, "data.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"created": rec.get("created") or datetime.datetime.now().isoformat(timespec="seconds"),
                            "media": media, "entries": entries, "chat": chat,
                            "note": os.path.basename(npath)}, ensure_ascii=False) + "\n")
    return npath


# ---------- LLM 代理（豆包/火山方舟，或任意 OpenAI 兼容端点）----------
def sec_get(name):
    try:
        r = subprocess.run(["sec", "get", name], capture_output=True, text=True, timeout=8)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def llm_conf():
    base = os.environ.get("LLM_BASE_URL") or os.environ.get("ARK_BASE_URL") or "https://ark.cn-beijing.volces.com/api/v3"
    key = (os.environ.get("LLM_API_KEY") or os.environ.get("ARK_API_KEY")
           or sec_get("ark") or sec_get("doubao"))
    model = os.environ.get("LLM_MODEL") or os.environ.get("ARK_MODEL") or "doubao-pro-32k"
    return base.rstrip("/"), key, model


def llm_chat(messages):
    base, key, model = llm_conf()
    if not key:
        raise RuntimeError("未配置密钥：`sec set ark`（或在服务端设 ARK_API_KEY）")
    body = json.dumps({"model": model, "messages": messages, "temperature": 0.6}).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode("utf-8"))
    text = ""
    try:
        text = data["choices"][0]["message"]["content"]
    except Exception:
        text = json.dumps(data, ensure_ascii=False)[:800]
    return text


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    os.makedirs(STORE, exist_ok=True)
    with Server((HOST, PORT), Handler) as httpd:
        print("video-annotate sync  →  http://127.0.0.1:%d  (store=%s)" % (PORT, STORE))
        if HOST == "0.0.0.0":
            print("  手机可访问（同一 Wi-Fi）:  http://%s:%d" % (lan_ip(), PORT))
            print("  注意：绑定 0.0.0.0 会把标注暴露给局域网，仅在可信网络使用。")
        httpd.serve_forever()
