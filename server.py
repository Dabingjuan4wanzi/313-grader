# -*- coding: utf-8 -*-
"""313 判卷本地服务：静态文件 + CORS 中转代理（供 AI Studio 识别通道使用）。
纯 Python 标准库，无需安装任何依赖。
用法：start-grader.bat 双击，或在当前目录命令行执行  python server.py
"""
import os
import sys
import json
import time
import socket
import urllib.request
import urllib.parse
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8080"))
PROXY_TIMEOUT = 60  # 中转请求超时（秒）

CORS = "*, GET,POST,OPTIONS"

def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("223.5.5.5", 80))  # 仅用于探测本机局域网 IP，不实际发包
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "127.0.0.1"

def proxy(target, method, headers, body):
    """把请求转发到 target，返回 (status, resp_headers, body_bytes)。"""
    req = urllib.request.Request(target, data=body, method=method)
    # 拷贝我们能转发的请求头（剔除 hop-by-hop 头）
    skip = {"host", "content-length", "connection", "accept-encoding", "origin", "referer"}
    for k, v in (headers or {}).items():
        if k.lower() not in skip and v is not None:
            req.add_header(k, v)
    if body is not None and "Content-Length" not in (headers or {}):
        req.add_header("Content-Length", str(len(body)))
    with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as r:
        data = r.read()
        out_headers = {}
        for k, v in r.getheaders():
            if k.lower() not in ("connection", "transfer-encoding"):
                out_headers.setdefault(k, v)
        return r.status, out_headers, data

class Handler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors_headers()
        self.send_header("Access-Control-Max-Age", "3600")
        self.end_headers()

    def cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Expose-Headers", "*")

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.rstrip("/") == "/proxy":
            self.handle_proxy("GET", None)
            return
        # 静态资源
        self.directory = ROOT
        self.path = parsed.path
        if parsed.path == "/" or parsed.path == "":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.rstrip("/") == "/proxy":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            self.handle_proxy("POST", body)
            return
        self.send_response(405)
        self.end_headers()

    def handle_proxy(self, method, body):
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = (qs.get("url") or [""])[0]
        if not target:
            self._json_resp(400, {"error": "缺少 url 参数"})
            return
        headers = dict(self.headers.items())
        if not (target.startswith("http://") or target.startswith("https://")):
            self._json_resp(400, {"error": "url 必须是 http(s) 开头"})
            return
        try:
            status, resp_headers, data = proxy(target, method, headers, body)
            self.send_response(status)
            self.cors_headers()
            for k, v in resp_headers.items():
                lk = k.lower()
                if lk.startswith("access-control-") or lk in ("connection", "transfer-encoding", "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self._json_resp(e.code, {"error": "上游返回 " + str(e.code)})
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            print("PROXY ERROR:", repr(e), flush=True)
            try:
                self._json_resp(502, {"error": "代理请求失败: " + str(e)})
            except Exception:
                pass

    def _json_resp(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass  # 安静一点

def main():
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    lan = get_lan_ip()
    print("=" * 50)
    print(" 313 判卷服务已启动")
    print(" 本机访问 :  http://127.0.0.1:{}".format(PORT))
    print(" 手机访问 :  http://{}:{}  (需同一 WiFi)".format(lan, PORT))
    print(" 按 Ctrl+C 停止")
    print("=" * 50)
    def open_browser():
        time.sleep(0.8)
        try:
            webbrowser.open("http://127.0.0.1:{}".format(PORT))
        except Exception:
            pass
    threading.Thread(target=open_browser, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")

if __name__ == "__main__":
    main()