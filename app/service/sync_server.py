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


def same(e, o):
    if (e.get("word") or "") != (o.get("word") or ""):
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
        if not isinstance(e, dict) or not e.get("word") or not valid_anchor(e):
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
        if path == "/api/health":
            return self._json(200, {"ok": True, "store": STORE, "host": HOST, "port": PORT})
        if path == "/api/ai":
            base, key, model = llm_conf()
            return self._json(200, {"ok": True, "configured": bool(key), "model": model, "base": base})
        if path == "/api/list":
            os.makedirs(STORE, exist_ok=True)
            return self._json(200, {"files": sorted(os.listdir(STORE))})
        key = self._key()
        if key:
            return self._json(200, read_pack(key))
        return self._static()

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
        self._put()

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
