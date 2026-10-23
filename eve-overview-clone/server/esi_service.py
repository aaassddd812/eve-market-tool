#!/usr/bin/env python3
"""ESI 辅助服务：不接触任何用户令牌。

EVE SSO 采用纯前端 PKCE 授权，宁静服授权码换令牌、刷新令牌都由浏览器直接请求 login.eveonline.com，
令牌只保存在用户浏览器里。国服（晨曦 login.evepc.163.com、曙光 login-infinity.evepc.163.com）登录服务器不允许跨域，换令牌请求由本服务原样转发，
不记录、不保存请求与响应内容。

接口（全部仅监听 127.0.0.1，由 nginx 反代对外；带 ?server=serenity 为晨曦服、?server=infinity 为曙光服，不带为宁静服）：
  GET  /api/esi/config     公开的应用配置（Client ID、回调地址、权限列表），用于浏览器生成授权链接
  GET  /api/esi/sso/device （仅国服）向网易申请一次性设备 ID（网易登录必填；该接口只接受 esi.evepc.163.com 来源，浏览器无法直接请求）
  POST /api/esi/sso/token  （仅国服）把授权码 / 刷新令牌请求转发给网易登录服务器
  GET  /api/esi/structures 读取公开玩家建筑共享缓存（浏览器回传，24h 过期）
  POST /api/esi/structures 回传公开玩家建筑缓存，供其他浏览器直接读取（只含建筑 ID / 名称 / 星系 / 类型）
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "config.json"

with open(CONFIG_PATH, encoding="utf-8") as fh:
    CONFIG = json.load(fh)

# 浏览器生成授权链接所需的公开配置（Client ID 本来就会出现在授权链接里，不是机密）
# 网易没有开放第三方应用申请，晨曦服默认复用官方 ESI 网页自带的应用（国服工具普遍如此），回调到网易 ESI 页面，
# 用户复制地址栏粘贴回本站；以后有专属应用时可在 config.json 的 "serenity" / "infinity" 下覆盖。权限列表默认与宁静服相同
# 曙光服与晨曦用同一个官方应用和同一套设备 ID，只是登录域名不同
NETEASE_DEFAULT_CLIENT_ID = "bc90aa496a404724a93f41b4f4e97761"
NETEASE_DEFAULT_REDIRECT = "https://ali-esi.evepc.163.com/ui/oauth2-redirect.html"
NETEASE_TOKEN_URLS = {
    "serenity": "https://login.evepc.163.com/v2/oauth/token",
    "infinity": "https://login-infinity.evepc.163.com/v2/oauth/token",
}
SERVERS = ("tq", *NETEASE_TOKEN_URLS)
# 国服没有 zKillboard，个人战斗记录从 ESI 读最近的击杀邮件；网易官方应用支持这项权限，默认追加（宁静服用 zKillboard，不需要）
NETEASE_EXTRA_SCOPES = ("esi-killmails.read_killmails.v1",)
PUBLIC_CONFIG = {
    "tq": {
        "client_id": CONFIG["client_id"],
        "redirect_uri": CONFIG["redirect_uri"],
        "scopes": CONFIG["scopes"],
    },
}
for _name in NETEASE_TOKEN_URLS:
    _own = CONFIG.get(_name) or {}
    PUBLIC_CONFIG[_name] = {
        "client_id": _own.get("client_id") or NETEASE_DEFAULT_CLIENT_ID,
        "redirect_uri": _own.get("redirect_uri") or NETEASE_DEFAULT_REDIRECT,
        "scopes": list(dict.fromkeys([*(_own.get("scopes") or CONFIG["scopes"]), *NETEASE_EXTRA_SCOPES])),
    }
# 与网易官方 ESI 网页相同：每次授权前申请一个设备 ID，作为授权链接的 device_id
NETEASE_DEVICE_URL = "https://mpay-web.g.mkey.163.com/device/init?" + urllib.parse.urlencode({
    "game_id": "aecfu6bgiuaaaal2-g-ma79", "device_type": "PC", "system_name": "Windows",
    "system_version": "10", "resolution": "1920*1080", "device_model": "64",
})
TOKEN_FIELDS = ("grant_type", "code", "code_verifier", "refresh_token", "client_id", "redirect_uri")
TOKEN_RATE = 20                       # 同一 IP 每分钟最多转发次数
_token_lock = threading.Lock()
_token_hits: dict[str, list[float]] = {}

BASE_DIR = os.path.dirname(os.path.abspath(CONFIG_PATH))
STRUCTURES_BODY_LIMIT = 1_000_000      # 回传体积上限（实际约 100KB）
STRUCTURES_LIST_LIMIT = 5000          # 建筑条数上限
STRUCTURES_POST_INTERVAL = 30         # 同一 IP 两次回传的最小间隔（秒）
_structures_lock = threading.Lock()
_structures_last_post: dict[str, float] = {}


def structures_cache_path(server: str) -> str:
    return os.path.join(BASE_DIR, "structures-cache.json" if server == "tq" else f"structures-cache-{server}.json")


def load_structures_cache(server: str) -> dict:
    try:
        with open(structures_cache_path(server), encoding="utf-8") as fh:
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


def token_rate_ok(ip: str) -> bool:
    with _token_lock:
        now = time.time()
        hits = [t for t in _token_hits.get(ip, []) if now - t < 60]
        if len(hits) >= TOKEN_RATE:
            _token_hits[ip] = hits
            return False
        hits.append(now)
        _token_hits[ip] = hits
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

    def _client_ip(self) -> str:
        # 经 nginx 反代时取 X-Real-IP（只信任本机转发来的头）
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1"):
            return self.headers.get("X-Real-IP") or ip
        return ip

    def _route(self) -> tuple[str, str]:
        path, _, query = self.path.partition("?")
        server = urllib.parse.parse_qs(query).get("server", ["tq"])[0]
        return path, (server if server in SERVERS else "tq")

    def do_GET(self):
        path, server = self._route()
        if path == "/api/esi/structures":
            with _structures_lock:
                payload = load_structures_cache(server)
            return self._json(200, payload)
        if path == "/api/esi/config":
            return self._json(200, PUBLIC_CONFIG[server])
        if path == "/api/esi/sso/device" and server != "tq":
            return self._sso_device()
        return self._json(404, {"error": "not found"})

    def _sso_device(self):
        if not token_rate_ok(self._client_ip()):
            return self._json(429, {"error": "请求过于频繁，请稍后再试"})
        req = urllib.request.Request(NETEASE_DEVICE_URL, headers={
            "Origin": "https://esi.evepc.163.com", "User-Agent": "eve-esi-helper/2.1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                device_id = (json.loads(res.read()).get("device") or {}).get("id")
        except Exception:  # noqa: BLE001
            device_id = None
        if not device_id:
            return self._json(502, {"error": "网易设备初始化失败，请稍后重试"})
        return self._json(200, {"device_id": device_id})   # 只返回 ID，不返回设备密钥

    def _sso_token(self, raw: bytes, server: str):
        """国服换令牌：只转发必要字段，且 client_id 必须是本站应用，避免被当成通用代理。"""
        if not token_rate_ok(self._client_ip()):
            return self._json(429, {"error": "请求过于频繁，请稍后再试"})
        form = urllib.parse.parse_qs(raw.decode("utf-8", "replace"))
        fields = {k: form[k][0] for k in TOKEN_FIELDS if form.get(k)}
        if fields.get("client_id") != PUBLIC_CONFIG[server]["client_id"]:
            return self._json(400, {"error": "client_id 不匹配"})
        if fields.get("grant_type") not in ("authorization_code", "refresh_token"):
            return self._json(400, {"error": "不支持的 grant_type"})
        req = urllib.request.Request(
            NETEASE_TOKEN_URLS[server],
            data=urllib.parse.urlencode(fields).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "eve-esi-helper/2.1"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                status, body = res.status, res.read()
        except urllib.error.HTTPError as err:
            status, body = err.code, err.read()
        except Exception:  # noqa: BLE001
            return self._json(502, {"error": "无法连接" + ("晨曦" if server == "serenity" else "曙光") + "服登录服务器"})
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path, server = self._route()
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2_000_000:
            return self._json(413, {"error": "请求体过大"})
        raw = self.rfile.read(length) if length else b""

        if path == "/api/esi/sso/token":
            if server == "tq":
                return self._json(404, {"error": "宁静服请直接向 login.eveonline.com 换取令牌"})
            if length > 8192:
                return self._json(413, {"error": "请求体过大"})
            return self._sso_token(raw, server)

        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            return self._json(400, {"error": "请求格式错误"})

        if path == "/api/esi/structures":
            if length > STRUCTURES_BODY_LIMIT:
                return self._json(413, {"error": "缓存体积超出上限"})
            ip = self._client_ip()
            with _structures_lock:
                now = time.time()
                if now - _structures_last_post.get(ip + server, 0) < STRUCTURES_POST_INTERVAL:
                    return self._json(200, {"stored": False})
                if not valid_structures_payload(data):
                    return self._json(400, {"error": "缓存格式不符合要求"})
                current = load_structures_cache(server)
                if data["at"] > current.get("at", 0):
                    payload = {
                        "at": data["at"],
                        "list": data["list"],
                        "total": data.get("total"),
                        "denied": data.get("denied", 0),
                    }
                    cache_path = structures_cache_path(server)
                    tmp = cache_path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as fh:
                        json.dump(payload, fh, ensure_ascii=False)
                    os.replace(tmp, cache_path)
                    _structures_last_post[ip + server] = now
                    return self._json(200, {"stored": True})
                return self._json(200, {"stored": False})

        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # 只记录请求行
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {args[0] if args else ''}\n")


if __name__ == "__main__":
    # 监听地址可经 config.json 的 "host" 覆盖（默认 127.0.0.1 不变）——容器/反代部署时需要 0.0.0.0
    ThreadingHTTPServer((CONFIG.get("host", "127.0.0.1"), CONFIG["port"]), Handler).serve_forever()
