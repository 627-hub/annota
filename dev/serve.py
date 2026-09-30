#!/usr/bin/env python3
"""本地开发服务器：为 .js / .html 等显式带上 charset=utf-8，避免中文乱码。

用法: python3 dev/serve.py   (默认 127.0.0.1:8792)
"""
import functools
import http.server
import os
import socket
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = os.environ.get("HOST", "127.0.0.1")   # 默认仅本机；手机访问需显式 HOST=0.0.0.0（仅可信局域网）
PORT = int(os.environ.get("PORT", "8792"))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
    }

    def guess_type(self, path):
        t = super().guess_type(path)
        if t.startswith("text/") and "charset" not in t:
            t += "; charset=utf-8"
        return t


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


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
    os.chdir(ROOT)
    with Server((HOST, PORT), functools.partial(Handler, directory=ROOT)) as httpd:
        print("serving %s  →  http://127.0.0.1:%d" % (ROOT, PORT))
        if HOST == "0.0.0.0":
            print("  手机可访问（同一 Wi-Fi）:  http://%s:%d/dev/demo.html" % (lan_ip(), PORT))
        httpd.serve_forever()
