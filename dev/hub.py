#!/usr/bin/env python3
"""video-annotate · 一键入口（hub）

一条命令搞定：
  1) 探测本机地址，把同步地址烧进脚本（零配置）
  2) 构建 userscript（编辑 / GM / 观看）
  3) 起「单端口服务」（静态 + 同步 API 同一个端口）
  4) 生成入口页 dev/hub.html（含二维码）并打开；终端也打印二维码

可选：
  --tunnel   用 cloudflared 起一条 https 隧道（手机在任何网络/4G 都能用，且解决混合内容）

用法：python3 dev/hub.py [--tunnel]      （Ctrl+C 停止）
"""
import argparse
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist")
STORE = os.path.join(ROOT, "app", "service", "store")
PORT = int(os.environ.get("PORT", "8793"))     # 单端口：静态 + 同步
TUNNEL_LOG = "/tmp/va_tunnel.log"
_procs = []   # 本进程启的子进程（服务/隧道），退出时统一收


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def local_name():
    try:
        out = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True)
        n = out.stdout.strip()
        return (n + ".local") if n else None
    except Exception:
        return None


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def qr_svg(data):
    import qrcode
    import qrcode.image.svg
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=6, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


def qr_terminal(data):
    import qrcode
    qr = qrcode.QRCode(border=1)
    qr.add_data(data)
    qr.make()
    qr.print_ascii(invert=True)


def firewall_enabled():
    try:
        st = subprocess.run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"],
                            capture_output=True, text=True).stdout
        return "enabled" in st.lower()
    except Exception:
        return False


def stored_list():
    rows = []
    if os.path.isdir(STORE):
        for fn in sorted(os.listdir(STORE)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(STORE, fn), encoding="utf-8") as fh:
                    o = json.load(fh)
                rows.append(((o.get("media") or {}).get("videoId") or fn[:-5], len(o.get("entries", []))))
            except Exception:
                rows.append((fn[:-5], "?"))
    return rows


def write_syncurl(urls):
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(DIST, ".syncurl"), "w", encoding="utf-8") as f:
        f.write(json.dumps(urls, ensure_ascii=False))


def build():
    # 本地入口构建：允许把 dev/hub.py 探测到的同步候选（本机/LAN/隧道）烧进产物，实现零配置
    env = dict(os.environ, ANNOTA_LOCAL_SYNC="1")
    subprocess.run([sys.executable, os.path.join(ROOT, "build.py")], cwd=ROOT, check=True, env=env)


def http_ok(url, timeout=6):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_tunnel(port):
    exe = shutil.which("cloudflared")
    if not exe:
        return None
    try:
        os.remove(TUNNEL_LOG)
    except OSError:
        pass
    logf = open(TUNNEL_LOG, "w")
    proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:%d" % port],
                            stdout=logf, stderr=subprocess.STDOUT)
    _procs.append(proc)
    url = None
    for _ in range(60):
        time.sleep(1)
        try:
            with open(TUNNEL_LOG, encoding="utf-8", errors="ignore") as fh:
                txt = fh.read()
        except OSError:
            continue
        m = re.search(r"https://[-\w]+\.trycloudflare\.com", txt)
        if m:
            url = m.group(0)
            break
    return url


def write_hub_html(base, extra_hint=""):
    edit = base + "/dist/annotate.user.js"
    gm = base + "/dist/annotate.gm.user.js"
    view = base + "/dist/annotate.view.user.js"
    demo = base + "/dev/demo.html"
    rows = stored_list()
    import html as _html
    items = "".join("<li><code>%s</code> — %s 条</li>" % (_html.escape(str(k)), _html.escape(str(n))) for k, n in rows) or "<li>（暂无）</li>"
    html = """<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>video-annotate · 入口</title>
<style>
body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;background:#0b0e13;color:#e6edf3;margin:0;padding:26px;max-width:880px;margin:auto}
h1{font-size:20px;color:#f0b429;margin:0 0 4px}.sub{color:#8b949e;margin-bottom:18px}
.cards{display:flex;gap:18px;flex-wrap:wrap}
.card{background:#11161d;border:1px solid #222a34;border-radius:12px;padding:16px;flex:1;min-width:260px}
.card h2{font-size:15px;margin:0 0 10px}
a.btn{display:inline-block;background:#f0b429;color:#111;font-weight:600;border-radius:8px;padding:8px 14px;text-decoration:none;margin:4px 6px 4px 0}
a.ghost{background:transparent;color:#9ecbff;border:1px solid #2b3644}
svg{background:#fff;border-radius:8px;padding:6px}
code{color:#9ecbff;word-break:break-all}li{margin:3px 0}.status{color:#7ee787}
</style>
<h1>video-annotate</h1>
<div class="sub">入口：<code>%s</code> · <span class="status">运行中</span> %s</div>
<div class="cards">
  <div class="card">
    <h2>📱 手机 · 观看（扫码安装）</h2>
    %s
    <p><a class="btn ghost" href="%s">或点此安装观看端</a></p>
    <p class="sub">只读 + 打开即自动同步；手机不编辑。<br>需脚本管理器（Violentmonkey / Tampermonkey / Stay；iOS 可用 Userscripts）。</p>
  </div>
  <div class="card">
    <h2>💻 电脑 · 编辑（点击安装）</h2>
    <p><a class="btn" href="%s">安装脚本</a><a class="btn ghost" href="%s">编辑版(GM)</a></p>
    <p class="sub">装好后打开 B站/抖音视频即可标注；同步已内置，无需配置。</p>
  </div>
  <div class="card">
    <h2>▶ 先试玩（无需安装）</h2>
    <p><a class="btn" href="%s">打开 demo 页</a></p>
    <p class="sub">本机视频上直接拖框/联想/同步。</p>
  </div>
</div>
<h2 style="font-size:15px;margin-top:22px">已共享的标注</h2>
<ul>%s</ul>
<h2 style="font-size:15px;margin-top:18px">手机连不上？</h2>
<ul class="sub">
<li>① 关掉手机 <b>VPN</b>；② 与电脑同一 Wi‑Fi（别用访客网络）</li>
<li>或改用隧道模式：<code>python3 dev/hub.py --tunnel</code>（手机在任何网络都能用）</li>
</ul>
</html>""" % (base, extra_hint, qr_svg(view), view, edit, gm, demo, items)
    p = os.path.join(HERE, "hub.html")
    with open(p, "w", encoding="utf-8") as f:
        f.write(html)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tunnel", action="store_true", help="用 cloudflared 起 https 隧道（手机跨网可用）")
    a = ap.parse_args()

    ip, name = lan_ip(), local_name()
    local_base = "http://127.0.0.1:%d" % PORT

    # 先起服务（静态 + 同步同端口），隧道模式需要它已监听
    owned = _procs
    if not port_open(PORT):
        owned.append(subprocess.Popen([sys.executable, os.path.join(ROOT, "app", "service", "sync_server.py")], cwd=ROOT))
        time.sleep(1.0)

    tunnel_url, hint = None, ""
    if a.tunnel:
        print("启动隧道（cloudflared）…")
        tunnel_url = start_tunnel(PORT)
        if tunnel_url:
            print("隧道地址：", tunnel_url)
            if http_ok(tunnel_url + "/api/health"):
                hint = '· 隧道 <code>%s</code>（手机跨网可用）' % tunnel_url
            else:
                print("⚠ 本机 DNS 解析该隧道域名失败（可能被污染）→ 手机大概率也不通。")
                print("  建议：改用局域网（关手机 VPN），或在 DNS 干净的网络里再试 --tunnel。")
                hint = '· 隧道 <code>%s</code>（⚠ 本机 DNS 解析失败，手机可能也不通）' % tunnel_url
        else:
            print("⚠ 未取得隧道地址。装了 cloudflared 吗？  brew install cloudflared")
            hint = '· 隧道未启用（brew install cloudflared 后重试）'

    # 同步地址候选：隧道优先，其余本机
    urls = []
    if tunnel_url:
        urls.append(tunnel_url)
    urls += ["http://127.0.0.1:%d" % PORT, "http://%s:%d" % (ip, PORT)]
    if name:
        urls.append("http://%s:%d" % (name, PORT))
    write_syncurl(urls)
    print("同步候选：", urls)
    print("构建脚本…")
    build()

    # 入口页里的链接/二维码：局域网模式用 LAN IP（手机才打得到），隧道模式用隧道地址
    base_static = tunnel_url or ("http://%s:%d" % (ip, PORT))
    write_hub_html(base_static, hint)
    print("\n入口页（电脑）：", local_base + "/dev/hub.html")
    print("入口页（手机）：", base_static + "/dev/hub.html")
    print("手机观看安装：", base_static + "/dist/annotate.view.user.js")

    if firewall_enabled() and not tunnel_url:
        print("\n⚠ macOS 防火墙已开启。手机连不上先放行 python：")
        print("  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp %s" % sys.executable)

    print("\n手机扫码（观看端 · 只读）：")
    qr_terminal(base_static + "/dist/annotate.view.user.js")

    try:
        webbrowser.open(local_base + "/dev/hub.html")
    except Exception:
        pass

    print("\n运行中，Ctrl+C 停止。")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n停止…")
    finally:
        for pr in _procs:           # 只收自己起的服务/隧道，避免留下孤儿
            try: pr.terminate()
            except Exception: pass


if __name__ == "__main__":
    main()
