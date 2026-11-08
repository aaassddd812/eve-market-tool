#!/usr/bin/env python3
"""EVE 站点（eve.navexor.top）日活统计。

读 /var/log/nginx/eve.access.log 及其轮转文件，按北京时间自然日汇总：
请求数、独立 IP 总数、浏览器 UA 的请求数与独立 IP 数、程序端（KOOK/Electron 等）同上。
结果合并进 /opt/eve/stats/dau.json（同一天重算则覆盖，日志轮转掉的历史保留）。
中转切流后 remote_addr 是中转机 IP，真实用户 IP 取 xff 首段（无 xff 用 remote_addr）。
用法：dau_stats.py [show]   show = 只显示不写入
"""
import gzip, glob, json, os, re, sys
from datetime import datetime, timedelta, timezone

LOGS = sorted(glob.glob("/var/log/nginx/eve.access.log*"), reverse=True)
OUT = "/opt/eve/stats/dau.json"
CST = timezone(timedelta(hours=8))
BOT = re.compile(r"bot|spider|crawl|curl|wget|python|go-http|httpclient|axios|okhttp|monitor|headless|scrapy|java/|masscan|zgrab|deepseek-harness|skill-learning|eve-codex|eve-industry", re.I)
ELEC = re.compile(r"KOOK|Electron|discord", re.I)
LINE = re.compile(r"^(\S+) \S+ \S+ \[([^\]]+)\] \"(\S+)[^\"]*\" (\d+)")
XFF = re.compile(r"xff=\"([^\"]+)\"")

def run():
    days = {}
    for path in LOGS:
        op = gzip.open if path.endswith(".gz") else open
        try:
            with op(path, "rt", errors="replace") as f:
                for line in f:
                    m = LINE.match(line)
                    if not m:
                        continue
                    ip, ts, method = m.group(1), m.group(2), m.group(3)
                    xf = XFF.search(line)
                    if xf and xf.group(1) != "-":
                        ip = xf.group(1).split(",")[0].strip()
                    t = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z").astimezone(CST)
                    key = t.strftime("%Y-%m-%d")
                    d = days.setdefault(key, {"ips": set(), "bips": set(), "eips": set(),
                                              "req": 0, "breq": 0, "ereq": 0,
                                              "hmin": 24, "hmax": -1})
                    ua = line.rsplit('" xff=', 1)[0]
                    bot = bool(BOT.search(ua)) or method not in ("GET", "POST", "HEAD")
                    d["req"] += 1
                    d["ips"].add(ip)
                    d["hmin"] = min(d["hmin"], t.hour)
                    d["hmax"] = max(d["hmax"], t.hour)
                    if not bot:
                        if ELEC.search(ua):
                            d["ereq"] += 1
                            d["eips"].add(ip)
                        else:
                            d["breq"] += 1
                            d["bips"].add(ip)
        except OSError:
            continue
    today = datetime.now(CST).strftime("%Y-%m-%d")
    out = {"updated": datetime.now(timezone.utc).isoformat(), "days": {}}
    if os.path.exists(OUT):
        try:
            with open(OUT, "r", encoding="utf-8") as f:
                out["days"] = json.load(f).get("days", {})
        except (OSError, ValueError):
            pass
    for key, d in days.items():
        partial = d["hmin"] > 0 or (key == today and d["hmax"] < 23)
        out["days"][key] = {
            "requests": d["req"], "ips": len(d["ips"]),
            "browser_requests": d["breq"], "browser_ips": len(d["bips"]),
            "program_requests": d["ereq"], "program_ips": len(d["eips"]),
            "coverage": "%02d-%02d时" % (d["hmin"], d["hmax"]),
            "partial": partial,
        }
    if "show" not in sys.argv:
        tmp = OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(tmp, OUT)
    # 全站累计独立用户：把本次日志里出现的 IP 哈希并入永久档案（日志轮转不丢）
    total_path = "/opt/eve/stats/dau_total.json"
    try:
        import hashlib
        registry = {}
        if os.path.exists(total_path):
            with open(total_path, "r", encoding="utf-8") as f:
                registry = json.load(f)
        known = set(registry.get("ips", []))
        fresh = {hashlib.md5(ip.encode()).hexdigest() for d in days.values() for ip in d["bips"] | d["eips"]}
        registry["ips"] = sorted(known | fresh)
        registry["count"] = len(registry["ips"])
        registry["updated"] = out["updated"]
        tmp = total_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(registry, f)
        os.replace(tmp, total_path)
        print("累计独立用户(自2026-11-03起精确统计+回溯4天): %d" % registry["count"])
    except OSError:
        pass
    print("%-10s %8s %6s | %8s %8s | %8s %6s" % ("日期(北京)", "总请求", "总IP", "浏览器请求", "浏览器IP", "程序端请求", "程序端IP"))
    for key in sorted(out["days"])[-9:]:
        d = out["days"][key]
        print("%-10s %8d %6d | %8d %8d | %8d %6d%s" % (
            key, d["requests"], d["ips"], d["browser_requests"], d["browser_ips"],
            d["program_requests"], d["program_ips"], "  (不完整)" if d["partial"] else ""))

if __name__ == "__main__":
    run()
