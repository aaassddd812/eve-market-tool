#!/usr/bin/env python3
"""EVE 站点实时访问大屏后端。

- 回放 /var/log/nginx/eve.access.log.1 + eve.access.log 预热最近 24 小时数据（滚动窗口），之后每秒 tail 增量
- IP 归属地走 ip-api.com 批量接口（免费档 15 批/分 × 100 IP），结果缓存到 geo.sqlite，只查新 IP
- 127.0.0.1:8377 提供 / (index.html)、/static/*、/api/stats
仅用标准库。
"""
import hashlib, json, os, re, sqlite3, threading, time, urllib.request, urllib.parse
from collections import Counter, deque
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
LOG = "/var/log/nginx/eve.access.log"
WARM_LOGS = [LOG + ".1", LOG]
DB = os.environ.get("EVE_SCREEN_GEO_DB") or os.path.join(BASE, "geo.sqlite")
HOST, PORT = "127.0.0.1", int(os.environ.get("EVE_SCREEN_PORT") or 8377)
CST = timezone(timedelta(hours=8))
DAU_TOTAL = "/opt/eve/stats/dau_total.json"
KNOWN_IPS = os.path.join(BASE, "known_ips.json")
NEW_EVENTS = os.path.join(BASE, "new_events.jsonl")   # 新 IP 发现时刻持久化，重启后 new_count_24h 不丢

BOT = re.compile(r"bot|spider|crawl|curl|wget|python|go-http|httpclient|axios|okhttp|monitor|headless|scrapy|java/|masscan|zgrab", re.I)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d+) \S+ "([^"]*)" "([^"]*)"')
XFF = re.compile(r'xff="([^"]+)"')
STATIC_EXT = re.compile(r"\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|glb|gltf|bin|ktx2)$", re.I)
NUM_SEG = re.compile(r"/\d+(?:\.\d+)*")   # 路径里的纯数字段（物品/击杀/人物 ID）
SERVER_PARAM = re.compile(r"[?&]server=([A-Za-z]+)")
SERVERS = {"serenity": "宁静", "infinity": "晨曦", "tq": "曙光"}
OLD_DOMAIN, NEW_DOMAIN = "eve-tools.top", "eve.navexor.top"
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

# geojson 里的省级名称；ip-api 的 regionName 可能是 "湖北" / "上海市" / 英文，统一映射过来
PROVINCES = ["北京市", "天津市", "河北省", "山西省", "内蒙古自治区", "辽宁省", "吉林省", "黑龙江省", "上海市",
             "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省", "广东省",
             "广西壮族自治区", "海南省", "重庆市", "四川省", "贵州省", "云南省", "西藏自治区", "陕西省", "甘肃省",
             "青海省", "宁夏回族自治区", "新疆维吾尔自治区", "台湾省", "香港特别行政区", "澳门特别行政区"]
PINYIN = {"beijing": "北京市", "tianjin": "天津市", "hebei": "河北省", "shanxi": "山西省", "inner mongolia": "内蒙古自治区",
          "liaoning": "辽宁省", "jilin": "吉林省", "heilongjiang": "黑龙江省", "shanghai": "上海市", "jiangsu": "江苏省",
          "zhejiang": "浙江省", "anhui": "安徽省", "fujian": "福建省", "jiangxi": "江西省", "shandong": "山东省",
          "henan": "河南省", "hubei": "湖北省", "hunan": "湖南省", "guangdong": "广东省", "guangxi": "广西壮族自治区",
          "hainan": "海南省", "chongqing": "重庆市", "sichuan": "四川省", "guizhou": "贵州省", "yunnan": "云南省",
          "tibet": "西藏自治区", "shaanxi": "陕西省", "gansu": "甘肃省", "qinghai": "青海省", "ningxia": "宁夏回族自治区",
          "xinjiang": "新疆维吾尔自治区"}
COUNTRY_ALIAS = {"德意志联邦共和国": "德国", "俄罗斯联邦": "俄罗斯", "大韩民国": "韩国", "美利坚合众国": "美国",
                 "大不列颠及北爱尔兰联合王国": "英国", "朝鲜民主主义人民共和国": "朝鲜"}
SPECIAL_CC = {"HK": "香港特别行政区", "MO": "澳门特别行政区", "TW": "台湾省"}


def norm_province(region):
    r = (region or "").strip()
    if not r:
        return None
    for p in PROVINCES:
        if r == p or r.startswith(p[:2]) and (p[:2] not in ("内蒙", "黑龙") or r.startswith(p[:3])):
            return p
    return PINYIN.get(r.lower())


def short_province(p):
    """地图/排行用全称，展示流用短名。"""
    for suf in ("特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"):
        if p.endswith(suf):
            return p[: -len(suf)]
    return p


def is_private(ip):
    if ":" in ip:
        return ip.startswith(("fc", "fd", "fe80", "::1"))
    try:
        a, b = (int(x) for x in ip.split(".")[:2])
    except ValueError:
        return True
    return a in (0, 10, 127) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or (a == 100 and 64 <= b <= 127)


def is_public_ipv4(ip):
    """仅接受公网 IPv4：拒绝私有段、保留段、回环、链路本地、CGNAT、组播等。"""
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b, c, d = (int(x) for x in parts)
    except ValueError:
        return False
    for x in (a, b, c, d):
        if x < 0 or x > 255:
            return False
    if a == 0 or a == 10 or a == 127:
        return False
    if a == 172 and 16 <= b <= 31:
        return False
    if a == 192 and b == 168:
        return False
    if a == 100 and 64 <= b <= 127:          # CGNAT 100.64.0.0/10
        return False
    if a == 169 and b == 254:                # 链路本地 169.254.0.0/16
        return False
    if a == 192 and b == 0 and c == 0:        # IETF 协议分配
        return False
    if a == 192 and b == 0 and c == 2:        # TEST-NET-1
        return False
    if a == 198 and b == 51 and c == 100:     # TEST-NET-2
        return False
    if a == 203 and b == 0 and c == 113:      # TEST-NET-3
        return False
    if a == 198 and 18 <= b <= 19:            # 基准测试 198.18.0.0/15
        return False
    if a >= 224:                              # 组播/保留/受限广播
        return False
    if a == 255 and b == 255 and c == 255 and d == 255:
        return False
    return True


def mask_ip(ip):
    if ":" in ip:
        parts = ip.split(":")
        return ":".join(parts[:2]) + ":*:*"
    p = ip.split(".")
    return "%s.%s.*.*" % (p[0], p[1]) if len(p) == 4 else "*"


_ts_cache = {}


def parse_ts(s):
    """'03/Nov/2026:08:15:04 +0000' -> epoch 秒（带缓存，比 strptime 快很多）。"""
    v = _ts_cache.get(s)
    if v is None:
        try:
            dt = datetime(int(s[7:11]), MONTHS[s[3:6]], int(s[0:2]), int(s[12:14]), int(s[15:17]), int(s[18:20]))
            sign = 1 if s[21] == "+" else -1
            off = sign * (int(s[22:24]) * 3600 + int(s[24:26]) * 60)
            v = int(dt.replace(tzinfo=timezone.utc).timestamp()) - off
        except (ValueError, KeyError, IndexError):
            v = -1
        if len(_ts_cache) > 20000:
            _ts_cache.clear()
        _ts_cache[s] = v
    return v


# ---------------------------------------------------------------- 归属地

class Geo:
    """ip -> (country, cc, region)。内存缓存 + sqlite 持久化；后台线程批量查新 IP。"""

    # ip-api 批量接口（免费档 15 批/分，每批 ≤100 个 IP）；countryCode 用于判定国内/港澳台
    FIELDS = "status,country,countryCode,regionName,city,query"
    INTERVAL = 4.0

    def __init__(self):
        self.lock = threading.Lock()
        self.resolved = 0
        self.cache = {}
        self.queue = deque()
        self.queued = set()
        self.event = threading.Event()
        self.db = sqlite3.connect(DB, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS geo (ip TEXT PRIMARY KEY, status TEXT, country TEXT, cc TEXT,"
                        " region TEXT, city TEXT, ts INTEGER)")
        self.db.commit()
        for ip, st, country, cc, region in self.db.execute("SELECT ip,status,country,cc,region FROM geo"):
            self.cache[ip] = (country or "", cc or "", region or "") if st == "success" else ("", "", "")

    def get(self, ip):
        return self.cache.get(ip)

    def want(self, ip, front=False):
        if ip in self.cache or ip in self.queued:
            return
        if is_private(ip):
            self.cache[ip] = ("", "", "内网")
            return
        with self.lock:
            self.queued.add(ip)
            (self.queue.appendleft if front else self.queue.append)(ip)
        self.event.set()

    def _save(self, rows):
        self.db.executemany("INSERT OR REPLACE INTO geo VALUES (?,?,?,?,?,?,?)", rows)
        self.db.commit()

    def run(self):
        """批量解析：每 4 秒凑一批（≤100 个，不满也发），滑动 60 秒内最多 15 批（免费档上限）。"""
        url = "http://ip-api.com/batch?lang=zh-CN&fields=" + self.FIELDS
        sent = deque()          # 最近 60 秒内各批次的发送时刻
        next_at = 0.0
        while True:
            self.event.wait()
            now = time.time()
            while sent and sent[0] <= now - 60:
                sent.popleft()
            delay = max(next_at - now, (sent[0] + 60 - now) if len(sent) >= 15 else 0)
            if delay > 0:
                time.sleep(delay)
                continue
            with self.lock:
                batch = [self.queue.popleft() for _ in range(min(100, len(self.queue)))]
                if not self.queue:
                    self.event.clear()
            if not batch:
                continue
            sent.append(time.time())
            next_at = time.time() + self.INTERVAL
            try:
                req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                             headers={"User-Agent": "eve-screen/1.0", "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = json.loads(r.read().decode())
                    rl, ttl = r.headers.get("X-Rl"), r.headers.get("X-Ttl")
                if not isinstance(data, list):
                    raise ValueError("unexpected response: %r" % (data,))
                now, rows = int(time.time()), []
                for ip, d in zip(batch, data):
                    st = d.get("status", "fail")
                    rows.append((ip, st, d.get("country", ""), d.get("countryCode", ""), d.get("regionName", ""),
                                 d.get("city", ""), now))
                    self.cache[ip] = (d.get("country", ""), d.get("countryCode", ""), d.get("regionName", "")) \
                        if st == "success" else ("", "", "")
                self._save(rows)
                with self.lock:
                    self.queued.difference_update(batch)
                self.resolved += len(rows)
                if rl is not None and ttl is not None and int(rl) <= 0:
                    next_at = max(next_at, time.time() + int(ttl) + 1)
            except Exception as e:  # 网络/限流：放回队头稍后重试
                print("geo batch failed (%d ips): %s" % (len(batch), e), flush=True)
                with self.lock:
                    self.queue.extendleft(reversed(batch))
                self.event.set()
                next_at = time.time() + (60 if "429" in str(e) else 10)


# ---------------------------------------------------------------- 真实 IP 映射（WebRTC 泄露）

class RealIPMap:
    """访客浏览器经 WebRTC 泄露的公网 IP 上报后，建立『日志里看到的 IP（代理出口）→ 真实 IP』映射。

    - key：本次上报请求自身的客户端 IP（xff 首段优先，否则 remote_addr），与日志统计口径一致
    - 每 key 每分钟最多记 5 次；条目 12 小时滚动过期
    """

    def __init__(self, geo=None):
        self.lock = threading.Lock()
        self.geo = geo
        self.map = {}          # key_ip -> (real_ip, ts)
        self.hits = {}         # key_ip -> deque[float]  （每分钟速率）
        self._last_clean = 0

    def record(self, key_ip, real_ip):
        now = time.time()
        with self.lock:
            dq = self.hits.get(key_ip)
            if dq is None:
                dq = self.hits[key_ip] = deque()
            while dq and dq[0] < now - 60:
                dq.popleft()
            if len(dq) >= 5:
                return False
            dq.append(now)
            self.map[key_ip] = (real_ip, now)
        if self.geo is not None:
            self.geo.want(real_ip, front=True)
        return True

    def resolve(self, key_ip):
        """归属地查询 / 去重前的替换：有映射且为公网真实 IP → 用真实 IP，否则原样。"""
        v = self.map.get(key_ip)
        return v[0] if v else key_ip

    def info(self, key_ip):
        """(real_ip, proxied)：仅当映射存在且真实 IP 与 key 不同才算『代理』。"""
        v = self.map.get(key_ip)
        if v and v[0] != key_ip:
            return v[0], True
        return None, False

    def proxied_count(self):
        with self.lock:
            return sum(1 for k, (r, _ts) in self.map.items() if r != k)

    def cleanup(self):
        now = time.time()
        if now - self._last_clean < 60:
            return
        self._last_clean = now
        cut = now - 12 * 3600
        with self.lock:
            for k in [k for k, (_r, ts) in self.map.items() if ts < cut]:
                del self.map[k]
            for k in [k for k, dq in self.hits.items() if not dq or dq[-1] < cut]:
                del self.hits[k]


# ---------------------------------------------------------------- 历史已知 IP

def ip_hash(ip):
    return hashlib.md5(ip.encode()).hexdigest()


class KnownIPs:
    """全历史已知 IP（md5 哈希）：dau_total.json 的 ips ∪ known_ips.json ∪ 运行期出现的 IP。

    check(ip)：不在集合中 → 记为新 IP（返回 True），加入内存集合并排队写回 known_ips.json。
    调用方需持有 Stats.lock（feed 内调用）。
    """

    def __init__(self):
        self.set = set()
        self.pending = []
        self.new_times = deque()      # 新 IP 被发现的时刻（用于 new_count_24h）
        for path in (DAU_TOTAL, KNOWN_IPS):
            try:
                with open(path) as f:
                    d = json.load(f)
                arr = d.get("ips", []) if isinstance(d, dict) else d
                self.set.update(x for x in arr if isinstance(x, str))
            except Exception as e:
                print("known ips skip %s: %s" % (path, e), flush=True)
        try:                                      # 重放持久化的新 IP 时刻（只留近48h）
            import time as _t
            lim = _t.time() - 48 * 3600
            keep = []
            with open(NEW_EVENTS) as f:
                for line in f:
                    try: ts = float(line.strip())
                    except ValueError: continue
                    if ts >= lim: keep.append(ts)
            self.new_times.extend(sorted(keep))
            with open(NEW_EVENTS, "w") as f:      # 顺手裁剪文件
                f.writelines("%.3f\n" % t for t in keep)
        except Exception:
            pass

    def check(self, ip, t):
        h = ip_hash(ip)
        if h in self.set:
            return False
        self.set.add(h)
        self.pending.append(h)
        self.new_times.append(t)
        try:
            with open(NEW_EVENTS, "a") as f:
                f.write("%.3f\n" % t)
        except Exception:
            pass
        return True

    def count_since(self, lim):
        while self.new_times and self.new_times[0] < lim:
            self.new_times.popleft()
        return len(self.new_times)

    def flush(self):
        """把新增哈希并入 known_ips.json：先读后写（原子替换），失败静默（下次再试）。"""
        if not self.pending:
            return
        add = self.pending
        self.pending = []
        try:
            try:
                with open(KNOWN_IPS) as f:
                    cur = json.load(f)
                if not isinstance(cur, list):
                    cur = []
            except FileNotFoundError:
                cur = []
            have = set(cur)
            cur.extend(h for h in add if h not in have)
            tmp = KNOWN_IPS + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cur, f)
            os.replace(tmp, KNOWN_IPS)
        except Exception:
            self.pending = add + self.pending


# ---------------------------------------------------------------- 统计

class Bucket:
    """一段时间内的增量统计；同一结构既用作分钟桶，也用作滚动 24 小时汇总（加桶/减桶）。"""
    __slots__ = ("ip", "pages", "dom_ip", "dom_req", "srv", "srv_ip", "req")

    def __init__(self):
        self.ip = Counter()                                   # ip -> 请求数
        self.pages = Counter()
        self.dom_ip = {"old": Counter(), "new": Counter()}    # ip -> 次数（len 即去重访客）
        self.dom_req = Counter()
        self.srv = Counter()
        self.srv_ip = {k: Counter() for k in SERVERS.values()}
        self.req = 0


def _sub(total, part):
    for k, v in part.items():
        n = total[k] - v
        if n > 0:
            total[k] = n
        else:
            del total[k]


class Stats:
    """滚动最近 24 小时（WINDOW 秒）统计。

    - 分钟桶 mins[epoch//60]，喂入时同时累加到 tot；桶过期时从 tot 减掉，所以 tot 恒为窗口内汇总
    - 小时图用绝对小时桶 hours[epoch//3600]，保留最近 24 个整点（北京时间与 UTC 整点对齐）
    - 峰值在线：每分钟记录 5 分钟滑窗在线人数，取窗口内最大值
    """
    WINDOW = 24 * 3600

    def __init__(self, geo, realip, known):
        self.geo = geo
        self.realip = realip
        self.known = known
        self.lock = threading.Lock()
        self.seq = 0
        self.mins = {}
        self.tot = Bucket()
        self.hour_ips = {}
        self.hour_req = Counter()
        self.minute_ips = {}           # 分钟 -> 访客集合（用于回放后重算在线峰值，只保留最近 10 分钟）
        self.online_by_min = {}        # 分钟 -> 该分钟观测到的最大在线
        self.last_seen = {}
        self.recent = deque(maxlen=30)
        self.req_times = deque()

    def feed(self, line):
        m = LINE.match(line)
        if not m:
            return
        ip, ts, method, url, status, ref, ua = m.groups()
        if BOT.search(ua) or method not in ("GET", "POST", "HEAD"):
            return
        if url.startswith("/screen"):  # 大屏自身的轮询不计入
            return
        xf = XFF.search(line, m.end())
        if xf and xf.group(1) != "-":
            ip = xf.group(1).split(",")[0].strip()
        t = parse_ts(ts)
        if t < 0:
            return
        now = int(time.time())
        # 历史新 IP 判定：以真实 IP 映射后的最终 IP 为准；回放的全部日志也并入已知集合
        final_ip = self.realip.resolve(ip)
        is_new = self.known.check(final_ip, t)
        hidx = t // 3600
        if hidx < now // 3600 - 23:
            return
        self.hour_ips.setdefault(hidx, set()).add(ip)
        self.hour_req[hidx] += 1
        if t < now - self.WINDOW:
            return
        path = url.split("?", 1)[0]
        mi = t // 60
        b = self.mins.get(mi)
        if b is None:
            b = self.mins[mi] = Bucket()
        tot = self.tot
        for x in (b, tot):
            x.ip[ip] += 1
            x.req += 1
        if t > self.last_seen.get(ip, 0):
            self.last_seen[ip] = t
        self.minute_ips.setdefault(mi, set()).add(ip)
        self.req_times.append(t)
        sm = SERVER_PARAM.search(url)
        if sm and sm.group(1).lower() in SERVERS:
            name = SERVERS[sm.group(1).lower()]
            for x in (b, tot):
                x.srv[name] += 1
                x.srv_ip[name][ip] += 1
        dk = "old" if OLD_DOMAIN in ref else "new" if NEW_DOMAIN in ref else None
        if dk:
            for x in (b, tot):
                x.dom_ip[dk][ip] += 1
                x.dom_req[dk] += 1
        if not STATIC_EXT.search(path):
            np_ = NUM_SEG.sub("/*", path)   # /api/kb/kill/123 -> /api/kb/kill/*，动态 ID 聚合
            b.pages[np_] += 1
            tot.pages[np_] += 1
            self.seq += 1
            self.recent.append((self.seq, ip, url, t, is_new))
        self.geo.want(ip)

    def expire(self, now):
        cut = (now - self.WINDOW) // 60      # 分钟桶起点早于 now-24h 的整桶移出窗口
        tot = self.tot
        for mi in [k for k in self.mins if k < cut]:
            b = self.mins.pop(mi)
            _sub(tot.ip, b.ip)
            _sub(tot.pages, b.pages)
            _sub(tot.dom_req, b.dom_req)
            _sub(tot.srv, b.srv)
            for k in b.dom_ip:
                _sub(tot.dom_ip[k], b.dom_ip[k])
            for k in b.srv_ip:
                _sub(tot.srv_ip[k], b.srv_ip[k])
            tot.req -= b.req
        hcut = now // 3600 - 23
        for h in [h for h in self.hour_ips if h < hcut]:
            del self.hour_ips[h]
            self.hour_req.pop(h, None)
        for k in [k for k in self.online_by_min if k < cut]:
            del self.online_by_min[k]
        lim = now - self.WINDOW
        if len(self.last_seen) > len(tot.ip) + 500:
            for k in [k for k, v in self.last_seen.items() if v < lim]:
                del self.last_seen[k]

    def online(self, now):
        lim = now - 300
        return sum(1 for v in self.last_seen.values() if v > lim)

    def recompute_peak(self):
        """回放后按分钟桶重算每分钟的在线人数（5 分钟滑窗）。"""
        for mm in self.minute_ips:
            u = set()
            for k in range(mm - 4, mm + 1):
                u |= self.minute_ips.get(k, set())
            self.online_by_min[mm] = max(self.online_by_min.get(mm, 0), len(u))
        cut = int(time.time()) // 60 - 10
        for k in [k for k in self.minute_ips if k < cut]:
            del self.minute_ips[k]

    def peak(self):
        if not self.online_by_min:
            return 0, None
        mm = max(self.online_by_min, key=lambda k: (self.online_by_min[k], k))
        return self.online_by_min[mm], mm * 60

    def tick(self):
        now = int(time.time())
        with self.lock:
            while self.req_times and self.req_times[0] < now - 60:
                self.req_times.popleft()
            self.expire(now)
            on = self.online(now)
            mi = now // 60
            if on > self.online_by_min.get(mi, 0):
                self.online_by_min[mi] = on
            cut = mi - 10
            for k in [k for k in self.minute_ips if k < cut]:
                del self.minute_ips[k]
            self.known.flush()
        self.realip.cleanup()

    def region_of(self, ip):
        g = self.geo.get(ip)
        if not g:
            return None
        country, cc, region = g
        if region == "内网":
            return "内网"
        if cc == "CN":
            p = norm_province(region)
            return short_province(p) if p else (country or "中国")
        if cc in SPECIAL_CC:
            return short_province(SPECIAL_CC[cc])
        return COUNTRY_ALIAS.get(country, country) or None

    def snapshot(self):
        now = int(time.time())
        with self.lock:
            tot = self.tot
            # 以泄露为准：归属地查询与去重前，先把日志 IP 替换为真实 IP
            real_req = Counter()
            for ip, n in tot.ip.items():
                real_req[self.realip.resolve(ip)] += n
            prov_u, prov_r, ctry = Counter(), Counter(), Counter()
            unknown = 0
            for ip, n in real_req.items():
                g = self.geo.get(ip)
                if not g or g[2] == "内网" or not (g[0] or g[1]):
                    unknown += 1
                    continue
                country, cc, region = g
                p = SPECIAL_CC.get(cc) or (norm_province(region) if cc == "CN" else None)
                if cc == "CN" and not p:
                    p = "未知省份"
                if p:
                    prov_u[p] += 1
                    prov_r[p] += n
                else:
                    ctry[COUNTRY_ALIAS.get(country, country) or cc] += 1
            req60 = sum(1 for x in self.req_times if x >= now - 60)
            recent = []
            for s, ip, url, t, is_new in reversed(self.recent):
                real_raw, proxied = self.realip.info(ip)
                recent.append({
                    "id": s, "ip": mask_ip(ip),
                    "real_ip": mask_ip(real_raw) if real_raw else None,
                    "proxied": proxied,
                    "is_new": is_new,
                    "region": self.region_of(real_raw or ip) or "查询中",
                    "url": url[:120], "t": datetime.fromtimestamp(t, CST).strftime("%H:%M:%S")})
            today = datetime.fromtimestamp(now, CST).date()
            hourly = []
            for h in range(now // 3600 - 23, now // 3600 + 1):
                dt = datetime.fromtimestamp(h * 3600, CST)
                hourly.append({"hour": dt.hour, "date": dt.strftime("%Y-%m-%d"),
                               "day": "today" if dt.date() == today else "yesterday",
                               "users": len(self.hour_ips.get(h, ())), "requests": self.hour_req.get(h, 0)})
            peak, peak_t = self.peak()
            total_srv = sum(tot.srv.values())
            return {
                "date": today.strftime("%Y-%m-%d"),
                "window_hours": self.WINDOW // 3600,
                "window_start": datetime.fromtimestamp(now - self.WINDOW, CST).strftime("%Y-%m-%d %H:%M:%S"),
                "updated": datetime.fromtimestamp(now, CST).strftime("%Y-%m-%d %H:%M:%S"),
                "today_users": len(real_req),
                "today_requests": tot.req,
                "proxied_count": self.realip.proxied_count(),
                "req_per_sec": round(req60 / 60.0, 2),
                "online_now": self.online(now),
                "peak_online": peak,
                "peak_time": datetime.fromtimestamp(peak_t, CST).strftime("%H:%M") if peak_t else None,
                "peak_day": ("today" if datetime.fromtimestamp(peak_t, CST).date() == today else "yesterday")
                if peak_t else None,
                "geo_pending": len(self.geo.queued),
                "geo_unknown": unknown,
                "provinces": [{"name": k, "users": v, "requests": prov_r[k]} for k, v in prov_u.most_common()],
                "countries": [{"name": k, "users": v} for k, v in ctry.most_common()],
                "recent": recent,
                "new_count_24h": self.known.count_since(now - self.WINDOW),
                "total_users": len(self.known.set),
                "hourly": hourly,
                "top_pages": [{"path": p, "count": c} for p, c in tot.pages.most_common()],
                "domain": {"old": len(tot.dom_ip["old"]), "new": len(tot.dom_ip["new"]),
                           "old_requests": tot.dom_req["old"], "new_requests": tot.dom_req["new"]},
                "servers": {k: tot.srv.get(k, 0) for k in SERVERS.values()},
                "server_users": {k: len(v) for k, v in tot.srv_ip.items()},
                "servers_total": total_srv,
            }


# ---------------------------------------------------------------- 日志读取

def warmup(stats):
    pos, ino = 0, None
    for path in WARM_LOGS:
        try:
            with open(path, "r", errors="replace") as f:
                with stats.lock:
                    for line in f:
                        stats.feed(line)
                if path == LOG:
                    pos, ino = f.tell(), os.fstat(f.fileno()).st_ino
        except OSError as e:
            print("warmup skip %s: %s" % (path, e), flush=True)
    with stats.lock:
        stats.recompute_peak()
        stats.expire(int(time.time()))
        stats.known.flush()
        # 最近出现的 IP 优先查归属地
        for ip, _ in sorted(stats.last_seen.items(), key=lambda x: -x[1])[:200]:
            if ip in stats.geo.queued:
                with stats.geo.lock:
                    try:
                        stats.geo.queue.remove(ip)
                        stats.geo.queue.appendleft(ip)
                    except ValueError:
                        pass
    return pos, ino


def tail(stats, pos, ino):
    f, buf = None, ""
    while True:
        try:
            if f is None:
                f = open(LOG, "r", errors="replace")
                st = os.fstat(f.fileno())
                if st.st_ino == ino and st.st_size >= pos:
                    f.seek(pos)
                ino = st.st_ino
            chunk = f.read()
            if chunk:
                buf += chunk
                lines = buf.split("\n")
                buf = lines.pop()
                with stats.lock:
                    for line in lines:
                        stats.feed(line)
            # 轮转（inode 变化）或截断：读完旧文件后重开
            try:
                st = os.stat(LOG)
                if st.st_ino != ino or st.st_size < f.tell():
                    rest = f.read()
                    if rest:
                        with stats.lock:
                            for line in (buf + rest).split("\n"):
                                stats.feed(line)
                    buf = ""
                    f.close()
                    f, pos = None, 0
                    continue
            except FileNotFoundError:
                pass
        except Exception as e:
            print("tail error: %s" % e, flush=True)
            if f:
                f.close()
            f, pos, ino = None, 0, None
            time.sleep(4)
        stats.tick()
        time.sleep(1)


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "eve-screen"
    stats = None
    realip = None
    _cache = (0, b"")

    def log_message(self, *a):
        pass

    def client_ip(self):
        """本次请求自身的客户端 IP：X-Forwarded-For 首段优先，否则直连地址。"""
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
        return self.client_address[0]

    def send(self, code, body, ctype, cache="no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/realip":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > 512:
                return self.send(400, b'{"ok":false,"err":"bad length"}', "application/json; charset=utf-8")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
                ip = str(data.get("ip", "")).strip()
            except Exception:
                return self.send(400, b'{"ok":false,"err":"bad json"}', "application/json; charset=utf-8")
            if not is_public_ipv4(ip):
                return self.send(400, b'{"ok":false,"err":"bad ip"}', "application/json; charset=utf-8")
            ok = self.realip.record(self.client_ip(), ip)
            body = json.dumps({"ok": ok}).encode()
            return self.send(200 if ok else 429, body, "application/json; charset=utf-8")
        self.send(404, b"not found", "text/plain")

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(BASE, "index.html"), "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/stats":
            t, body = Handler._cache
            if time.time() - t > 1:
                body = json.dumps(self.stats.snapshot(), ensure_ascii=False).encode()
                Handler._cache = (time.time(), body)
            return self.send(200, body, "application/json; charset=utf-8")
        if path.startswith("/static/"):
            name = os.path.basename(path)
            fp = os.path.join(STATIC, name)
            if name and os.path.isfile(fp):
                ctype = {"js": "application/javascript", "json": "application/json", "css": "text/css",
                         "svg": "image/svg+xml"}.get(
                    name.rsplit(".", 1)[-1], "application/octet-stream")
                with open(fp, "rb") as f:
                    return self.send(200, f.read(), ctype, "public, max-age=86400")
        if path == "/robots.txt":
            return self.send(200, b"User-agent: *\nDisallow: /\n", "text/plain")
        self.send(404, b"not found", "text/plain")


def main():
    geo = Geo()
    realip = RealIPMap(geo)
    known = KnownIPs()
    stats = Stats(geo, realip, known)
    t0 = time.time()
    pos, ino = warmup(stats)
    print("warmup done in %.1fs: users=%d geo_cached=%d geo_queue=%d known_ips=%d new_24h=%d" % (
        time.time() - t0, len(stats.tot.ip), len(geo.cache), len(geo.queue), len(known.set),
        known.count_since(time.time() - Stats.WINDOW)), flush=True)
    threading.Thread(target=geo.run, daemon=True).start()
    threading.Thread(target=tail, args=(stats, pos, ino), daemon=True).start()
    Handler.stats = stats
    Handler.realip = realip
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("listening on %s:%d" % (HOST, PORT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
