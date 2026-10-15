#!/usr/bin/env python3
"""EVE SSO 后端代理：Client ID / Secret 只保存在服务器配置里。

接口（全部仅监听 127.0.0.1，由 nginx 反代对外）：
  GET  /api/esi/auth-url   生成授权链接（服务端生成 state + PKCE verifier 并暂存）
  POST /api/esi/bind       {code, state} 换取令牌并返回角色身份
  POST /api/esi/refresh    {refresh_token} 刷新令牌
"""

import base64
import hashlib
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "config.json"

with open(CONFIG_PATH, encoding="utf-8") as fh:
    CONFIG = json.load(fh)

SSO = "https://login.eveonline.com/v2/oauth"
SCOPES = " ".join(CONFIG["scopes"])
STATE_TTL = 15 * 60  # 授权链接 15 分钟内有效

# state -> {verifier, created_at}
pending = {}


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def http_form(url: str, data: dict) -> tuple[int, dict]:
    body_data = dict(data)
    request_headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if CONFIG.get("client_secret"):
        # 凭证只放在 Basic 头；CCP 不允许头和请求体同时携带 client 凭证
        body_data.pop("client_id", None)
        basic = base64.b64encode(
            f"{CONFIG['client_id']}:{CONFIG['client_secret']}".encode()
        ).decode()
        request_headers["Authorization"] = f"Basic {basic}"
    body = urllib.parse.urlencode(body_data).encode()
    request = urllib.request.Request(url, data=body, method="POST")
    for key, value in request_headers.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        if "<" in detail:  # CCP 对无效授权码会渲染 HTML 错误页，替换为友好提示
            reason = "授权码无效或已被使用"
        else:
            try:
                parsed = json.loads(detail)
                reason = parsed.get("error_description") or parsed.get("error")
            except ValueError:
                reason = detail or str(exc)
        raise CcpError(exc.code, reason) from exc


class CcpError(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def jwt_payload(token: str) -> dict:
    """解码 access_token 的 JWT 载荷（仅用于展示角色名，不做签名校验）。"""
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part))
    except Exception:  # noqa: BLE001
        return {}


def sweep_expired():
    now = time.time()
    for key in [k for k, v in pending.items() if now - v["created_at"] > STATE_TTL]:
        pending.pop(key, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "eve-esi-proxy/1.0"

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] != "/api/esi/auth-url":
            return self._json(404, {"error": "not found"})
        sweep_expired()
        verifier = b64url(secrets.token_bytes(48))
        challenge = b64url(hashlib.sha256(verifier.encode()).digest())
        state = b64url(secrets.token_bytes(24))
        pending[state] = {"verifier": verifier, "created_at": time.time()}
        query = urllib.parse.urlencode({
            "response_type": "code",
            "redirect_uri": CONFIG["redirect_uri"],
            "client_id": CONFIG["client_id"],
            "scope": SCOPES,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        })
        return self._json(200, {"url": f"{SSO}/authorize?{query}"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "请求格式错误"})

        if self.path == "/api/esi/bind":
            code = (data.get("code") or "").strip()
            state = (data.get("state") or "").strip()
            entry = pending.pop(state, None)
            if not code or not state or not entry:
                return self._json(400, {"error": "授权状态无效或已过期。请重新生成授权链接并重新登录后再绑定。"})
            if time.time() - entry["created_at"] > STATE_TTL:
                return self._json(400, {"error": "授权链接已过期，请重新生成并重新登录。"})
            try:
                _, payload = http_form(f"{SSO}/token", {
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": CONFIG["client_id"],
                    "redirect_uri": CONFIG["redirect_uri"],
                    "code_verifier": entry["verifier"],
                })
            except CcpError as exc:
                return self._json(400, {"error": f"CCP 拒绝了授权（{exc.reason}）。若提示 code 已使用，请重新生成授权链接并重新登录。"})
            except Exception as exc:  # noqa: BLE001
                return self._json(502, {"error": f"OAuth 请求失败：{exc}"})
            if not payload.get("access_token"):
                return self._json(502, {"error": "CCP 未返回访问令牌，请重试。"})
            # 优先用 /verify 拿角色身份；失败时从 JWT 兜底，不丢弃已到手的令牌
            identity = {}
            try:
                verify = urllib.request.Request(f"{SSO}/verify")
                verify.add_header("Authorization", f"Bearer {payload['access_token']}")
                with urllib.request.urlopen(verify, timeout=20) as response:
                    identity = json.loads(response.read().decode())
            except Exception:  # noqa: BLE001
                claims = jwt_payload(payload["access_token"])
                sub = str(claims.get("sub", ""))
                identity = {
                    "CharacterID": int(sub.split(":")[0]) if sub.split(":")[0].isdigit() else None,
                    "CharacterName": claims.get("name") or "未知角色",
                }
            return self._json(200, {
                "access_token": payload.get("access_token"),
                "refresh_token": payload.get("refresh_token"),
                "expires_in": payload.get("expires_in", 1199),
                "character_id": identity.get("CharacterID"),
                "character_name": identity.get("CharacterName"),
                "scopes": identity.get("Scopes", ""),
            })

        if self.path == "/api/esi/refresh":
            refresh_token = (data.get("refresh_token") or "").strip()
            if not refresh_token:
                return self._json(400, {"error": "缺少 refresh_token。"})
            try:
                _, payload = http_form(f"{SSO}/token", {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": CONFIG["client_id"],
                })
            except CcpError as exc:
                return self._json(400, {"error": f"令牌刷新被拒绝（{exc.reason}），请重新绑定。"})
            except Exception as exc:  # noqa: BLE001
                return self._json(502, {"error": f"刷新请求失败：{exc}"})
            return self._json(200, payload)

        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # 不记录令牌等敏感内容
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {args[0] if args else ''}\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", CONFIG["port"]), Handler).serve_forever()
