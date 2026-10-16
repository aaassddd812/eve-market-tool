#!/usr/bin/env python3
"""ESI 辅助服务：不接触任何用户令牌。

EVE SSO 采用纯前端 PKCE 授权，授权码换令牌、刷新令牌都由浏览器直接请求 login.eveonline.com，
令牌只保存在用户浏览器里。本服务只提供公开信息：

接口（全部仅监听 127.0.0.1，由 nginx 反代对外）：
  GET  /api/esi/config     公开的应用配置（Client ID、回调地址、权限列表），用于浏览器生成授权链接
  GET  /api/esi/structures 读取公开玩家建筑共享缓存（浏览器回传，24h 过期）
  POST /api/esi/structures 回传公开玩家建筑缓存，供其他浏览器直接读取（只含建筑 ID / 名称 / 星系 / 类型）
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "config.json"

with open(CONFIG_PATH, encoding="utf-8") as fh:
    CONFIG = json.load(fh)

# 浏览器生成授权链接所需的公开配置（Client ID 本来就会出现在授权链接里，不是机密）
PUBLIC_CONFIG = {
    "client_id": CONFIG["client_id"],
    "redirect_uri": CONFIG["redirect_uri"],
    "scopes": CONFIG["scopes"],
}

STRUCTURES_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(CONFIG_PATH)), "structures-cache.json")
STRUCTURES_BODY_LIMIT = 1_000_000      # 回传体积上限（实际约 100KB）
STRUCTURES_LIST_LIMIT = 5000          # 建筑条数上限
STRUCTURES_POST_INTERVAL = 30         # 同一 IP 两次回传的最小间隔（秒）
_structures_lock = threading.Lock()
_structures_last_post: dict[str, float] = {}


def load_structures_cache() -> dict:
    try:
        with open(STRUCTURES_CACHE_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("list"), list):
            return data
    except Exception:  # noqa: BLE001
        pass
    return {"at": 0, "list": []}


def valid_structures_payload(data) -> bool:
    if not isinstance(data, dict):
        return False
    items = data.get("list")
    if not isinstance(data.get("at"), (int, float)) or not isinstance(items, list):
        return False
    if not items or len(items) > STRUCTURES_LIST_LIMIT:
        return False
    for item in items:
        if not isinstance(item, dict):
            return False
        name = item.get("name")
        if not isinstance(item.get("id"), int) or not isinstance(item.get("system"), int) or not isinstance(item.get("type"), int):
            return False
        if not isinstance(name, str) or not name or len(name) > 200:
            return False
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "eve-esi-helper/2.0"

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/esi/structures":
            with _structures_lock:
                payload = load_structures_cache()
            return self._json(200, payload)
        if path == "/api/esi/config":
            return self._json(200, PUBLIC_CONFIG)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2_000_000:
            return self._json(413, {"error": "请求体过大"})
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "请求格式错误"})

        if self.path == "/api/esi/structures":
            if length > STRUCTURES_BODY_LIMIT:
                return self._json(413, {"error": "缓存体积超出上限"})
            ip = self.client_address[0]
            with _structures_lock:
                now = time.time()
                if now - _structures_last_post.get(ip, 0) < STRUCTURES_POST_INTERVAL:
                    return self._json(200, {"stored": False})
                if not valid_structures_payload(data):
                    return self._json(400, {"error": "缓存格式不符合要求"})
                current = load_structures_cache()
                if data["at"] > current.get("at", 0):
                    payload = {
                        "at": data["at"],
                        "list": data["list"],
                        "total": data.get("total"),
                        "denied": data.get("denied", 0),
                    }
                    tmp = STRUCTURES_CACHE_PATH + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as fh:
                        json.dump(payload, fh, ensure_ascii=False)
                    os.replace(tmp, STRUCTURES_CACHE_PATH)
                    _structures_last_post[ip] = now
                    return self._json(200, {"stored": True})
                return self._json(200, {"stored": False})

        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # 只记录请求行
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {args[0] if args else ''}\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", CONFIG["port"]), Handler).serve_forever()
