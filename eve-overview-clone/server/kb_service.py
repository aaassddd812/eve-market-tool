#!/usr/bin/env python3
"""击杀记录（KB）后端服务：收录新伊甸全部击杀邮件，按吉他中间价估值，提供列表 / 排行 / 统计接口。

数据来源
  - 历史：EVE Ref 每日击杀存档 https://data.everef.net/killmails/（完整 ESI 击杀邮件，每天约 1.4 万条）
  - 实时：zKillboard R2Z2 顺序推送（RedisQ 已于 2026-05-31 停用）；不可用时轮询 zKillboard 各星域最新击杀
  - 价格：ESI 伏尔戈市场全量订单，取吉他 4-4 最低卖价与最高收购价的中间值

接口（只读，仅监听 127.0.0.1，由 nginx 反代 /api/kb/）
  GET /api/kb/status                          数据覆盖范围与运行状态
  GET /api/kb/feed?cursor=&limit=&ship=&system=&region=&character=&corporation=&alliance=&side=
                                              击杀列表（最新在前）；side=kills|losses|all
                                              本地只保留 --days 天；带筛选条件时翻完本地记录后自动改为实时查询 zKillboard（不入库）
  GET /api/kb/live?after=N                    实时收录的新击杀（星图闪烁 / 弹幕），返回新的游标
  GET /api/kb/battles?window=60&min=20        疑似会战：时间窗（分钟）内同一星系被击毁舰船数 ≥ min（不含太空舱与 1000 万 ISK 以下的击杀）
  GET /api/kb/top?days=7&limit=8              指定天数内价值最高的损失
  GET /api/kb/summary?hours=24                指定小时内的总损失（含每小时分布）
  GET /api/kb/leaderboard?days=30&side=losses|kills&by=character|corporation|alliance&metric=value|count
  GET /api/kb/search?q=                       搜索人物 / 军团 / 联盟
  GET /api/kb/entity/<kind>/<id>?days=30      人物 / 军团 / 联盟统计（含成员明细）
  GET /api/kb/kill/<id>                       击杀邮件详情与逐项估价（原文按需取自 ESI，本地不保存）

用法
  python3 kb_service.py --db kb.sqlite [--port 8291] [--days 30] [--live auto|r2z2|poll|off] [--static DIR]
  --static 仅用于本地 / 演示环境：同时托管前端静态文件。
"""

import argparse
import collections
import concurrent.futures
import datetime as dt
import gzip
import io
import json
import logging
import mimetypes
import os
import sqlite3
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ESI = "https://esi.evetech.net/latest"
ZKILL = "https://zkillboard.com/api/"
R2Z2 = "https://r2z2.zkillboard.com/ephemeral/"   # https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)
R2Z2_GAP = 0.1              # 有数据时的请求间隔（官方限制每 IP 15 次 / 秒）
R2Z2_IDLE = 6               # 收到 404（暂无新击杀）后至少等待 6 秒，官方要求
EVEREF = "https://data.everef.net/killmails/{year}/killmails-{date}.tar.bz2"
UA = "EVE-Market-Tool KB service (+https://github.com/wbw5780/eve-market-tool)"
FORGE = 10000002
JITA_44 = 60003760
PRICE_TTL = 3600            # 价格每小时刷新
POLL_INTERVAL = 300         # 轮询模式：每轮间隔（秒）
POLL_GAP = 1.2              # 轮询模式：两次 zKillboard 请求的间隔（秒）
CACHE_TTL = 600             # 排行 / 统计结果缓存（秒）
KM_CACHE = 500              # 击杀详情内存缓存条数
ZKILL_GAP = 1.0             # 任意两次 zKillboard 请求的最小间隔（秒），轮询与用户查询共用
ZKILL_MAX_PAGE = 100        # zKillboard 每个查询最多翻到第 100 页（每页 200 条）
LIVE_BUFFER = 300           # 实时缓冲保留最近的新击杀条数
LIVE_MAX_AGE = 3 * 3600     # 发生超过 3 小时的击杀不进入实时推送
ARCHIVE_CACHE = 30          # 30 天以前的查询结果只放内存，缓存的 zKillboard 页数
BATTLE_CACHE = 5              # 会战结果缓存（秒），前端与实时击杀同为 6 秒轮询
BATTLE_MIN_VALUE = 10_000_000  # 会战只统计价值 ≥ 1000 万 ISK 的击杀（过滤小船 / 诱饵等刷数）

log = logging.getLogger("kb")


# ---------------------------------------------------------------- HTTP 工具
def http_get(url, timeout=60, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        body = res.read()
        if res.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body, res.headers


def get_json(url, timeout=60, retries=3, **kw):
    for attempt in range(retries):
        try:
            body, headers = http_get(url, timeout=timeout, **kw)
            return json.loads(body) if body else None, headers
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                raise
            err = e
        except Exception as e:  # 网络错误：退避重试
            err = e
        time.sleep(1.5 * (attempt + 1))
    raise err


_zkill_lock = threading.Lock()
_zkill_last = [0.0]


def zkill_get(path):
    """串行请求 zKillboard，保证请求间隔"""
    with _zkill_lock:
        wait = _zkill_last[0] + ZKILL_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            data, _ = get_json(ZKILL + path, timeout=60, retries=2)
        finally:
            _zkill_last[0] = time.time()
    if isinstance(data, dict) and data.get("error"):
        raise ValueError(data["error"])
    return data


def resolve_names(ids, depth=0):
    """ESI 批量解析玩家角色 / 军团 / 联盟原名"""
    try:
        data, _ = get_json(f"{ESI}/universe/names/", data=json.dumps(ids).encode(),
                           headers={"Content-Type": "application/json"}, retries=2)
        return data or []
    except urllib.error.HTTPError:
        if len(ids) == 1 or depth > 10:
            return []
        mid = len(ids) // 2
        return resolve_names(ids[:mid], depth + 1) + resolve_names(ids[mid:], depth + 1)
    except Exception as e:
        log.warning("名称解析失败：%s", e)
        return []


def epoch(iso):
    return int(dt.datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp())


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- 存储
SCHEMA = """
PRAGMA auto_vacuum=INCREMENTAL;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS killmails(
  id INTEGER PRIMARY KEY, hash TEXT, time INTEGER, system_id INTEGER, region_id INTEGER,
  ship_type INTEGER, value REAL, attackers INTEGER, solo INTEGER, npc INTEGER,
  v_char INTEGER, v_corp INTEGER, v_alliance INTEGER,
  f_char INTEGER, f_corp INTEGER, f_alliance INTEGER, f_ship INTEGER);
CREATE INDEX IF NOT EXISTS km_value ON killmails(time, value);
CREATE INDEX IF NOT EXISTS km_vchar ON killmails(v_char, time);
CREATE INDEX IF NOT EXISTS km_vcorp ON killmails(v_corp, time);
CREATE INDEX IF NOT EXISTS km_valliance ON killmails(v_alliance, time);
CREATE INDEX IF NOT EXISTS km_ship ON killmails(ship_type, time);
CREATE INDEX IF NOT EXISTS km_system ON killmails(system_id, time);
CREATE INDEX IF NOT EXISTS km_region ON killmails(region_id, time);
-- 只保存玩家攻击者（NPC 不参与任何统计）
CREATE TABLE IF NOT EXISTS attackers(km INTEGER, time INTEGER, char INTEGER, corp INTEGER, alliance INTEGER, ship INTEGER);
CREATE INDEX IF NOT EXISTS att_char ON attackers(char, time);
CREATE INDEX IF NOT EXISTS att_corp ON attackers(corp, time);
CREATE INDEX IF NOT EXISTS att_alliance ON attackers(alliance, time);
CREATE INDEX IF NOT EXISTS att_km ON attackers(km);
CREATE TABLE IF NOT EXISTS names(id INTEGER PRIMARY KEY, name TEXT, category TEXT, lname TEXT);
CREATE TABLE IF NOT EXISTS prices(type_id INTEGER PRIMARY KEY, sell REAL, buy REAL, avg REAL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""


class Store:
    def __init__(self, path, system_regions, retention_days):
        self.path = path
        self.system_regions = system_regions
        self.retention = retention_days
        self.write_lock = threading.Lock()
        self.local = threading.local()
        conn = self.conn()
        if "raw" in {r[1] for r in conn.execute("PRAGMA table_info(killmails)")}:
            self.migrate(conn)
        conn.executescript(SCHEMA)
        conn.commit()
        self.prices = {}
        for type_id, sell, buy, avg in conn.execute("SELECT type_id, sell, buy, avg FROM prices"):
            self.prices[type_id] = (sell, buy, avg)
        self.known_names = {row[0] for row in conn.execute("SELECT id FROM names")}
        self.pending_names = set()
        self.cache = {}
        # 实时收录的新击杀（仅内存）：供星图闪烁与弹幕使用，按入库顺序编号
        self.live_buf = collections.deque(maxlen=LIVE_BUFFER)
        self.live_n = 0
        self.state = {"live_mode": None, "last_live": None, "prices_updated": self.meta("prices_updated"), "backfill": "等待中"}

    @staticmethod
    def migrate(conn):
        """旧版数据库瘦身：去掉击杀原文与 NPC 攻击者，多余索引，并开启增量回收"""
        log.info("正在精简旧版数据库（只需一次，可能需要几分钟）…")
        conn.executescript("""
            DROP INDEX IF EXISTS km_time;
            DROP INDEX IF EXISTS att_time;
            DROP INDEX IF EXISTS att_km;
            CREATE TABLE km_new(
              id INTEGER PRIMARY KEY, hash TEXT, time INTEGER, system_id INTEGER, region_id INTEGER,
              ship_type INTEGER, value REAL, attackers INTEGER, solo INTEGER, npc INTEGER,
              v_char INTEGER, v_corp INTEGER, v_alliance INTEGER,
              f_char INTEGER, f_corp INTEGER, f_alliance INTEGER, f_ship INTEGER);
            INSERT INTO km_new SELECT id, hash, time, system_id, region_id, ship_type, value, attackers, solo, npc,
              v_char, v_corp, v_alliance, f_char, f_corp, f_alliance, f_ship FROM killmails;
            DROP TABLE killmails;
            ALTER TABLE km_new RENAME TO killmails;
            CREATE TABLE att_new(km INTEGER, time INTEGER, char INTEGER, corp INTEGER, alliance INTEGER, ship INTEGER);
            INSERT INTO att_new SELECT km, time, char, corp, alliance, ship FROM attackers WHERE char IS NOT NULL;
            DROP TABLE attackers;
            ALTER TABLE att_new RENAME TO attackers;
        """)
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # VACUUM 的写入会先进 WAL，立即回写并截断
        log.info("数据库精简完成")

    def db_bytes(self):
        c = self.conn()
        return c.execute("PRAGMA page_count").fetchone()[0] * c.execute("PRAGMA page_size").fetchone()[0]

    def conn(self):
        c = getattr(self.local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            c.execute("PRAGMA busy_timeout=30000")
            c.execute("PRAGMA journal_size_limit=67108864")  # WAL 检查点后最多保留 64MB
            self.local.conn = c
        return c

    def meta(self, key, value=None):
        c = self.conn()
        if value is None:
            row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return row[0] if row else None
        with self.write_lock:
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (key, str(value)))
            c.commit()

    # ---------------- 估值：吉他最低卖价与最高收购价的中间值
    def price(self, type_id):
        p = self.prices.get(type_id)
        if not p:
            return 0.0
        sell, buy, avg = p
        if sell and buy:
            # 卖价远高于收价通常是挂单异常（如天价卖单），改用全服均价
            if sell > buy * 10 and avg:
                return avg
            return (sell + buy) / 2
        one = sell or buy
        if one and avg and one > avg * 10:
            return avg
        return one or avg or 0.0

    def item_value(self, item):
        qty = (item.get("quantity_destroyed") or 0) + (item.get("quantity_dropped") or 0)
        unit = 0.0 if item.get("singleton") == 2 else self.price(item["item_type_id"])  # 蓝图副本不计价
        total = unit * qty
        for child in item.get("items") or []:
            total += self.item_value(child)
        return total

    def km_value(self, km):
        v = km["victim"]
        return self.price(v["ship_type_id"]) + sum(self.item_value(it) for it in v.get("items") or [])

    # ---------------- 写入
    def ingest(self, kms, live=False):
        """kms: [(killmail dict, hash)]，返回新增条数；live=True 表示来自实时推送，新击杀会进入实时缓冲"""
        if not kms:
            return 0
        c = self.conn()
        added = 0
        with self.write_lock:
            existing = set()
            ids = [km["killmail_id"] for km, _ in kms]
            for chunk in range(0, len(ids), 900):
                part = ids[chunk:chunk + 900]
                existing |= {r[0] for r in c.execute(f"SELECT id FROM killmails WHERE id IN ({','.join('?' * len(part))})", part)}
            cutoff = time.time() - self.retention * 86400
            km_rows, att_rows = [], []
            for km, km_hash in kms:
                kid = km["killmail_id"]
                if kid in existing:
                    continue
                existing.add(kid)
                t = epoch(km["killmail_time"])
                if t < cutoff:
                    continue
                v = km["victim"]
                attackers = km.get("attackers") or []
                final = next((a for a in attackers if a.get("final_blow")), attackers[0] if attackers else {})
                players = [a for a in attackers if a.get("character_id")]
                km_rows.append((
                    kid, km_hash, t, km["solar_system_id"], self.system_regions.get(km["solar_system_id"]),
                    v["ship_type_id"], self.km_value(km), len(attackers), int(len(players) == 1), int(not players),
                    v.get("character_id"), v.get("corporation_id"), v.get("alliance_id"),
                    final.get("character_id"), final.get("corporation_id"), final.get("alliance_id"), final.get("ship_type_id")))
                for a in players:
                    att_rows.append((kid, t, a["character_id"], a.get("corporation_id"), a.get("alliance_id"), a.get("ship_type_id")))
                for eid in (v.get("character_id"), v.get("corporation_id"), v.get("alliance_id")):
                    if eid and eid not in self.known_names:
                        self.pending_names.add(eid)
                for a in players:
                    for eid in (a.get("character_id"), a.get("corporation_id"), a.get("alliance_id")):
                        if eid and eid not in self.known_names:
                            self.pending_names.add(eid)
            c.executemany("INSERT OR IGNORE INTO killmails VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", km_rows)
            c.executemany("INSERT INTO attackers VALUES(?,?,?,?,?,?)", att_rows)
            c.commit()
            added = len(km_rows)
            if live:
                fresh = time.time() - LIVE_MAX_AGE
                for row in km_rows:
                    if row[2] >= fresh:          # zKill 偶尔补录多年前的击杀，不当作“新击杀”推送
                        self.live_n += 1
                        self.live_buf.append((self.live_n, row_summary(row[:1] + row[2:])))
        return added

    def prune(self):
        cutoff = int(time.time() - self.retention * 86400)
        c = self.conn()
        with self.write_lock:
            n = c.execute("DELETE FROM killmails WHERE time < ?", (cutoff,)).rowcount
            c.execute("DELETE FROM attackers WHERE time < ?", (cutoff,))
            c.commit()
            c.execute("PRAGMA incremental_vacuum")  # 把删除腾出的空间还给磁盘
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if n:
            log.info("清理 %d 条超出保留期的击杀", n)


# ---------------------------------------------------------------- 后台任务
class Workers:
    def __init__(self, store, days, live_mode):
        self.store = store
        self.days = days
        self.live_mode = live_mode
        self.prices_ready = threading.Event()
        if store.prices:
            self.prices_ready.set()

    def start(self):
        for target in (self.price_loop, self.backfill, self.live_loop, self.names_loop):
            threading.Thread(target=target, daemon=True).start()

    # ---- 价格：伏尔戈全量订单 → 吉他 4-4 最低卖 / 最高收
    def refresh_prices(self):
        first, headers = get_json(f"{ESI}/markets/{FORGE}/orders/?order_type=all&page=1")
        pages = int(headers.get("X-Pages") or 1)
        orders = list(first)

        def page(n):
            data, _ = get_json(f"{ESI}/markets/{FORGE}/orders/?order_type=all&page={n}")
            return data

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            for data in pool.map(page, range(2, pages + 1)):
                orders.extend(data)
        sell, buy = {}, {}
        for o in orders:
            if o["location_id"] != JITA_44:
                continue
            t, p = o["type_id"], o["price"]
            if o["is_buy_order"]:
                if p > buy.get(t, 0):
                    buy[t] = p
            elif t not in sell or p < sell[t]:
                sell[t] = p
        avg_list, _ = get_json(f"{ESI}/markets/prices/")
        avg = {x["type_id"]: x.get("average_price") or x.get("adjusted_price") for x in avg_list}
        types = set(sell) | set(buy) | set(avg)
        prices = {t: (sell.get(t), buy.get(t), avg.get(t)) for t in types}
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM prices")
            c.executemany("INSERT INTO prices VALUES(?,?,?,?)", [(t, *v) for t, v in prices.items()])
            c.commit()
        self.store.prices = prices
        stamp = iso(time.time())
        self.store.meta("prices_updated", stamp)
        self.store.state["prices_updated"] = stamp
        log.info("价格已更新：%d 页订单，%d 种物品有吉他行情", pages, len(set(sell) | set(buy)))

    def price_loop(self):
        while True:
            try:
                self.refresh_prices()
                self.prices_ready.set()
            except Exception as e:
                log.warning("价格刷新失败：%s", e)
            if self.store.state["backfill"] == "完成":
                self.store.prune()  # 实时入库会持续写入，每小时清理一次超出保留期的击杀
            time.sleep(PRICE_TTL)

    # ---- 历史：EVE Ref 每日存档；每 6 小时检查一次新的一天（同时补齐实时数据在重启期间的缺口）
    def backfill(self):
        while True:
            try:
                self.backfill_once()
            except Exception:
                log.exception("历史导入失败")
            time.sleep(6 * 3600)

    def backfill_once(self):
        self.prices_ready.wait()
        today = dt.datetime.now(dt.timezone.utc).date()
        for back in range(self.days, 0, -1):
            day = today - dt.timedelta(days=back)
            key = f"everef:{day}"
            if self.store.meta(key):
                continue
            self.store.state["backfill"] = f"正在导入 {day}"
            try:
                body, _ = http_get(EVEREF.format(year=day.year, date=day.isoformat()), timeout=180)
            except urllib.error.HTTPError as e:
                log.warning("EVE Ref %s 不可用：%s", day, e)
                continue
            except Exception as e:
                log.warning("EVE Ref %s 下载失败：%s", day, e)
                continue
            batch, total = [], 0
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:bz2") as tar:
                for member in tar:
                    if not member.isfile() or not member.name.endswith(".json"):
                        continue
                    km = json.load(tar.extractfile(member))
                    batch.append((km, km.get("killmail_hash")))
                    if len(batch) >= 2000:
                        total += self.store.ingest(batch)
                        batch = []
            total += self.store.ingest(batch)
            self.store.meta(key, total)
            log.info("EVE Ref %s 导入 %d 条", day, total)
        self.store.prune()
        self.store.state["backfill"] = "完成"

    # ---- 实时：zKillboard R2Z2 优先，不可用时轮询各星域
    def live_loop(self):
        if self.live_mode == "off":
            self.store.state["live_mode"] = "off"
            return
        self.prices_ready.wait()
        mode = self.live_mode
        if mode == "auto":
            mode = "r2z2" if self.r2z2_sequence() else "poll"
        self.store.state["live_mode"] = mode
        log.info("实时数据：%s", "zKillboard R2Z2" if mode == "r2z2" else "轮询 zKillboard 各星域")
        (self.r2z2_loop if mode == "r2z2" else self.poll_loop)()

    def r2z2_sequence(self):
        """R2Z2 最新序号（每 51 条击杀更新一次）；不可用时返回 None"""
        try:
            data, _ = get_json(R2Z2 + "sequence.json", timeout=15, retries=2)
            return int(data["sequence"])
        except Exception as e:
            log.info("R2Z2 不可用（%s）", e)
            return None

    def r2z2_loop(self):
        # 序号文件只保留约 24 小时：重启后优先从上次位置继续，太旧则从最新位置开始（缺口由 EVE Ref 每日存档补齐）
        latest = self.r2z2_sequence() or 0
        saved = int(self.store.meta("r2z2_seq") or 0)
        seq = saved if saved and latest - saved < 10000 else latest
        log.info("R2Z2 从序号 %d 开始（上次 %s，最新 %d）", seq, saved or "无", latest)
        misses = 0
        while True:
            try:
                body, _ = http_get(f"{R2Z2}{seq}.json", timeout=20)
                item = json.loads(body)
                self.store.ingest([(item["esi"], item.get("hash"))], live=True)
                self.store.state["last_live"] = iso(time.time())
                self.store.state["r2z2_seq"] = seq
                seq += 1
                misses = 0
                if seq % 50 == 0:
                    self.store.meta("r2z2_seq", seq)
                time.sleep(R2Z2_GAP)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    misses += 1
                    # 连续 404 且最新序号已远超当前位置：说明这段序号已过期，跳到最新
                    if misses % 20 == 0:
                        latest = self.r2z2_sequence() or seq
                        if latest > seq + 100:
                            log.warning("R2Z2 序号 %d 已过期，跳到 %d", seq, latest)
                            seq = latest
                    self.store.meta("r2z2_seq", seq)
                    time.sleep(R2Z2_IDLE)
                elif e.code == 403:
                    log.warning("R2Z2 返回 403（可能被限流），60 秒后重试")
                    time.sleep(60)
                else:
                    log.warning("R2Z2 %s：%s", seq, e)
                    time.sleep(R2Z2_IDLE)
            except Exception as e:
                log.warning("R2Z2 %s：%s", seq, e)
                time.sleep(R2Z2_IDLE)

    def poll_loop(self):
        try:
            regions, _ = get_json(f"{ESI}/universe/regions/")
        except Exception:
            regions = list(set(self.store.system_regions.values()))
        targets = [f"regionID/{r}/" for r in sorted(regions) if r < 11000000] + ["w-space/"]
        while True:
            started = time.time()
            added = 0
            for path in targets:
                try:
                    data = zkill_get(path)
                    added += self.store.ingest([(k, (k.get("zkb") or {}).get("hash")) for k in data or []], live=True)
                except Exception as e:
                    log.debug("zKillboard %s：%s", path, e)
                time.sleep(POLL_GAP)
            self.store.state["last_live"] = iso(time.time())
            log.info("轮询完成：新增 %d 条", added)
            time.sleep(max(0, POLL_INTERVAL - (time.time() - started)))

    # ---- 名称：玩家角色 / 军团 / 联盟（ESI 批量接口，保留原名）
    def names_loop(self):
        while True:
            pending = list(self.store.pending_names)[:1000]
            if not pending:
                time.sleep(15)   # 没有待解析的名称时才休眠；有积压时连续处理
                continue
            resolved = resolve_names(pending)
            c = self.store.conn()
            with self.store.write_lock:
                c.executemany("INSERT OR REPLACE INTO names VALUES(?,?,?,?)",
                              [(r["id"], r["name"], r["category"], r["name"].lower()) for r in resolved])
                c.commit()
            for eid in pending:
                self.store.pending_names.discard(eid)
                self.store.known_names.add(eid)


# ---------------------------------------------------------------- 查询
SUMMARY_COLS = "id, time, system_id, region_id, ship_type, value, attackers, solo, npc, v_char, v_corp, v_alliance, f_char, f_corp, f_alliance, f_ship"
ENTITY_COL = {"character": ("v_char", "char"), "corporation": ("v_corp", "corp"), "alliance": ("v_alliance", "alliance")}


ZKILL_MOD = (("character", "characterID"), ("corporation", "corporationID"), ("alliance", "allianceID"),
             ("ship", "shipTypeID"), ("system", "solarSystemID"), ("region", "regionID"))


def zkill_path(q, side):
    """把列表筛选条件换成 zKillboard 查询路径；没有任何筛选时返回 None（zKillboard 不支持全局翻页）"""
    mods = "".join(f"{name}/{int(q[key])}/" for key, name in ZKILL_MOD if q.get(key))
    if not mods:
        return None
    entity = any(q.get(k) for k in ENTITY_COL)
    prefix = side + "/" if entity and side in ("kills", "losses") else ""
    return prefix + mods


def row_summary(r):
    return {
        "id": r[0], "time": iso(r[1]), "system_id": r[2], "region_id": r[3], "ship_type_id": r[4],
        "value": round(r[5] or 0, 2), "attackers": r[6], "solo": bool(r[7]), "npc": bool(r[8]),
        "victim": {"character_id": r[9], "corporation_id": r[10], "alliance_id": r[11]},
        "final": {"character_id": r[12], "corporation_id": r[13], "alliance_id": r[14], "ship_type_id": r[15]},
    }


class Api:
    def __init__(self, store):
        self.store = store
        self.km_cache = collections.OrderedDict()
        self.km_lock = threading.Lock()
        self.zk_pages = collections.OrderedDict()   # zKillboard 页缓存（仅内存）
        self.mem_names = {}                         # 30 天以前击杀涉及的名称（仅内存，不写库）

    def names_for(self, ids):
        ids = [i for i in set(ids) if i]
        out = {}
        c = self.store.conn()
        for chunk in range(0, len(ids), 900):
            part = ids[chunk:chunk + 900]
            for eid, name in c.execute(f"SELECT id, name FROM names WHERE id IN ({','.join('?' * len(part))})", part):
                out[eid] = name
        for eid in ids:
            if eid not in out and eid in self.mem_names:
                out[eid] = self.mem_names[eid]
        return out

    def with_names(self, kills, extra=()):
        ids = list(extra)
        for k in kills:
            ids += list(k["victim"].values()) + [k["final"]["character_id"], k["final"]["corporation_id"], k["final"]["alliance_id"]]
        return self.names_for(ids)

    def cached(self, key, fn, force=False):
        hit = self.store.cache.get(key)
        if hit and not force and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
        value = fn()
        self.store.cache[key] = (time.time(), value)
        return value

    def warm(self):
        """后台预先计算首页数据与全部排行榜组合（排行需要扫描约 30 天的攻击者记录，冷启动需数秒）"""
        while True:
            try:
                self.summary({"hours": "24"}, force=True)
                self.top({"days": "7", "limit": "8"}, force=True)
                for side in ("losses", "kills"):
                    for by in ENTITY_COL:
                        for metric in ("value", "count"):
                            self.leaderboard({"side": side, "by": by, "metric": metric, "days": "30", "limit": "20"}, force=True)
            except Exception:
                log.exception("预计算失败")
            time.sleep(CACHE_TTL - 60)

    # GET /status
    def status(self, q):
        c = self.store.conn()
        n, oldest, newest = c.execute("SELECT COUNT(*), MIN(time), MAX(time) FROM killmails").fetchone()
        return {"killmails": n, "oldest": iso(oldest) if oldest else None, "newest": iso(newest) if newest else None,
                "retention_days": self.store.retention, "db_mb": round(self.store.db_bytes() / 1048576, 1), **self.store.state}

    # GET /live?after=N：上次之后实时收录的新击杀（首次请求 after<0 时给出最近几条）
    def live(self, q):
        after = int(q.get("after", -1))
        buf = list(self.store.live_buf)
        latest = buf[-1][0] if buf else self.store.live_n
        if after < 0 or after > latest:           # 首次请求，或服务重启后编号重置
            items = buf[-min(int(q.get("initial", 3)), 10):]
        else:
            items = [x for x in buf if x[0] > after][-50:]
        kills = [k for _, k in items]
        return {"cursor": latest, "kills": kills, "names": self.with_names(kills)}

    # GET /battles?window=60&min=20：疑似会战（时间窗内同一星系被击毁的舰船数，不含太空舱、NPC 击杀与价值 < BATTLE_MIN_VALUE 的击杀）
    def battles(self, q):
        window = min(max(int(q.get("window", 60)), 5), 180)
        min_kills = min(max(int(q.get("min", 20)), 5), 2000)

        def run():
            c = self.store.conn()
            since = int(time.time() - window * 60)
            base = f"time >= ? AND npc = 0 AND ship_type NOT IN (670, 33328) AND value >= {BATTLE_MIN_VALUE}"
            rows = c.execute(f"""SELECT system_id, region_id, COUNT(*), SUM(value), MIN(time), MAX(time) FROM killmails
                                 WHERE {base} GROUP BY system_id HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC LIMIT 20""",
                             (since, min_kills)).fetchall()
            out, ids = [], []
            for sys_id, region, kills, value, start, end in rows:
                km_sql = f"SELECT id FROM killmails WHERE system_id = ? AND {base}"
                pilots = c.execute(f"""SELECT COUNT(*) FROM (
                                         SELECT char FROM attackers WHERE km IN ({km_sql})
                                         UNION SELECT v_char FROM killmails WHERE system_id = ? AND {base} AND v_char IS NOT NULL)""",
                                   (sys_id, since, sys_id, since)).fetchone()[0]
                # 主要势力：按参与击杀次数与损失合并排序（有联盟用联盟，否则用军团）
                sides = {}
                def side_of(eid, is_alliance):
                    return sides.setdefault(eid, {"id": eid, "kind": "alliance" if is_alliance else "corporation", "kills": 0, "losses": 0, "lost": 0.0})
                for eid, is_alliance, n in c.execute(f"""SELECT COALESCE(alliance, corp) e, alliance IS NOT NULL, COUNT(DISTINCT km) FROM attackers
                                                         WHERE km IN ({km_sql}) GROUP BY e""", (sys_id, since)):
                    if eid:
                        side_of(eid, is_alliance)["kills"] = n
                for eid, is_alliance, n, v in c.execute(f"""SELECT COALESCE(v_alliance, v_corp) e, v_alliance IS NOT NULL, COUNT(*), SUM(value) FROM killmails
                                                            WHERE system_id = ? AND {base} GROUP BY e""", (sys_id, since)):
                    if eid:
                        side = side_of(eid, is_alliance)
                        side["losses"], side["lost"] = n, round(v or 0, 2)
                top_sides = sorted(sides.values(), key=lambda x: x["kills"] + x["losses"], reverse=True)[:4]
                top = c.execute(f"SELECT id, ship_type, value FROM killmails WHERE system_id = ? AND {base} ORDER BY value DESC LIMIT 1",
                                (sys_id, since)).fetchone()
                ids += [x["id"] for x in top_sides]
                out.append({"system_id": sys_id, "region_id": region, "kills": kills, "value": round(value or 0, 2),
                            "start": iso(start), "end": iso(end), "pilots": pilots, "sides": top_sides,
                            "top": {"id": top[0], "ship_type_id": top[1], "value": round(top[2] or 0, 2)} if top else None})
            return {"window": window, "min": min_kills, "battles": out, "names": self.names_for(ids)}
        hit = self.store.cache.get(("battles", window, min_kills))
        if hit and time.time() - hit[0] < BATTLE_CACHE:   # 多个页面同时轮询时短时间内复用结果
            return hit[1]
        value = run()
        self.store.cache[("battles", window, min_kills)] = (time.time(), value)
        return value

    # GET /feed
    def feed(self, q):
        limit = min(int(q.get("limit", 50)), 200)
        where, args = [], []
        for key, col in (("ship", "ship_type"), ("system", "system_id"), ("region", "region_id")):
            if q.get(key):
                where.append(f"{col}=?")
                args.append(int(q[key]))
        side = q.get("side", "all")
        for kind, (vcol, acol) in ENTITY_COL.items():
            if q.get(kind):
                eid = int(q[kind])
                loss = f"{vcol}=?"
                kill = f"id IN (SELECT km FROM attackers WHERE {acol}=?)"
                if side == "losses":
                    where.append(loss); args.append(eid)
                elif side == "kills":
                    where.append(kill); args.append(eid)
                else:
                    where.append(f"({loss} OR {kill})"); args += [eid, eid]
        path = zkill_path(q, side)
        cursor = q.get("cursor") or ""
        if cursor.startswith("z:"):
            return self.archive(path, cursor, limit)
        base_where, base_args = list(where), list(args)
        if cursor:
            t, kid = (int(x) for x in cursor.split(":"))
            where.append("(time < ? OR (time = ? AND id < ?))")
            args += [t, t, kid]
        sql = f"SELECT {SUMMARY_COLS} FROM killmails {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY time DESC, id DESC LIMIT ?"
        rows = self.store.conn().execute(sql, args + [limit]).fetchall()
        kills = [row_summary(r) for r in rows]
        if len(rows) == limit:
            return {"kills": kills, "cursor": f"{rows[-1][1]}:{rows[-1][0]}", "names": self.with_names(kills)}
        # 本地（保留期内）已翻完：有筛选条件时转向 zKillboard 实时查询更早的记录，结果不落盘
        if not path:
            return {"kills": kills, "cursor": None, "names": self.with_names(kills), "notice": "global_end"}
        if rows:
            boundary = (rows[-1][1], rows[-1][0])
        elif cursor:
            boundary = tuple(int(x) for x in cursor.split(":"))
        else:
            boundary = (int(time.time()) + 3600, 2 ** 62)
        sql = f"SELECT COUNT(*) FROM killmails {'WHERE ' + ' AND '.join(base_where) if base_where else ''}"
        local = self.store.conn().execute(sql, base_args).fetchone()[0]
        start = f"z:0:{boundary[0]}:{boundary[1]}:{local}"
        if kills:
            return {"kills": kills, "cursor": start, "names": self.with_names(kills)}
        return self.archive(path, start, limit)

    # 30 天以前：向 zKillboard 查询，按吉他中间价重新估值，只放内存
    def zk_page(self, path, page):
        key = f"{path}page/{page}/"
        hit = self.zk_pages.get(key)
        if hit and time.time() - hit[0] < 3600:
            return hit[1]
        data = zkill_get(key) or []
        kms = sorted(data, key=lambda k: (epoch(k["killmail_time"]), k["killmail_id"]), reverse=True)
        with self.km_lock:
            self.zk_pages[key] = (time.time(), kms)
            while len(self.zk_pages) > ARCHIVE_CACHE:
                self.zk_pages.popitem(last=False)
        return kms

    def archive(self, path, cursor, limit):
        parts = cursor.split(":")
        page, bt, bid = int(parts[1]), int(parts[2]), int(parts[3])
        older = lambda k: (epoch(k["killmail_time"]), k["killmail_id"]) < (bt, bid)
        if page == 0:
            # 首次进入：按本地已有条数估算 zKillboard 页码，再前后微调到与本地衔接的那一页
            page = int(parts[4]) // 200 + 1 if len(parts) > 4 else 1
            forward = False
            for _ in range(8):
                if page > ZKILL_MAX_PAGE:
                    break
                kms = self.zk_page(path, page)
                if not kms:
                    break
                if not older(kms[-1]):
                    page, forward = page + 1, True      # 整页都比本地新，往后翻
                elif older(kms[0]) and page > 1 and not forward:
                    page -= 1                           # 整页都更旧，上一页可能还有衔接的记录
                else:
                    break
        out, notice, fetched = [], None, 0
        while len(out) < limit and fetched < 5:        # 单次请求最多翻 5 页，避免长时间占用 zKillboard
            fetched += 1
            if page > ZKILL_MAX_PAGE:
                notice = "zkill_limit"
                break
            kms = self.zk_page(path, page)
            take = [k for k in kms if older(k)]
            need = limit - len(out)
            out += take[:need]
            if len(take) > need:
                break                                   # 本页还有剩余，下次从这一页继续
            if len(kms) < 200:
                page = None                             # 最后一页
                break
            page += 1
        if out:
            bt, bid = epoch(out[-1]["killmail_time"]), out[-1]["killmail_id"]
        kills = [self.km_summary(k) for k in out]
        names = self.with_names(kills)
        missing = list({i for k in kills for i in (*k["victim"].values(), k["final"]["character_id"], k["final"]["corporation_id"], k["final"]["alliance_id"])
                        if i and i not in names})
        if missing:
            for r in resolve_names(missing[:1000]):
                self.mem_names[r["id"]] = r["name"]
                names[r["id"]] = r["name"]
            if len(self.mem_names) > 50000:
                self.mem_names.clear()
        more = page is not None and notice is None
        return {"kills": kills, "cursor": f"z:{page}:{bt}:{bid}" if more else None, "names": names, "notice": notice}

    def km_summary(self, km):
        with self.km_lock:
            self.km_cache[km["killmail_id"]] = km
            while len(self.km_cache) > KM_CACHE:
                self.km_cache.popitem(last=False)
        v = km["victim"]
        attackers = km.get("attackers") or []
        final = next((a for a in attackers if a.get("final_blow")), attackers[0] if attackers else {})
        players = [a for a in attackers if a.get("character_id")]
        return {
            "id": km["killmail_id"], "time": km["killmail_time"], "system_id": km["solar_system_id"],
            "region_id": self.store.system_regions.get(km["solar_system_id"]), "ship_type_id": v["ship_type_id"],
            "value": round(self.store.km_value(km), 2), "attackers": len(attackers), "solo": len(players) == 1, "npc": not players,
            "victim": {"character_id": v.get("character_id"), "corporation_id": v.get("corporation_id"), "alliance_id": v.get("alliance_id")},
            "final": {"character_id": final.get("character_id"), "corporation_id": final.get("corporation_id"),
                      "alliance_id": final.get("alliance_id"), "ship_type_id": final.get("ship_type_id")},
            "archive": True,
        }

    # GET /top
    def top(self, q, force=False):
        days = min(float(q.get("days", 7)), 60)
        limit = min(int(q.get("limit", 8)), 50)

        def run():
            rows = self.store.conn().execute(
                f"SELECT {SUMMARY_COLS} FROM killmails WHERE time >= ? ORDER BY value DESC LIMIT ?",
                (int(time.time() - days * 86400), limit)).fetchall()
            kills = [row_summary(r) for r in rows]
            return {"kills": kills, "names": self.with_names(kills)}
        return self.cached(("top", days, limit), run, force)

    # GET /summary
    def summary(self, q, force=False):
        hours = min(int(q.get("hours", 24)), 24 * 30)

        def run():
            now = int(time.time())
            since = now - hours * 3600
            c = self.store.conn()
            n, total = c.execute("SELECT COUNT(*), COALESCE(SUM(value), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
            buckets = [{"hour": iso(since + i * 3600), "count": 0, "value": 0.0} for i in range(hours)]
            for idx, cnt, val in c.execute(
                    "SELECT (time - ?) / 3600 AS b, COUNT(*), SUM(value) FROM killmails WHERE time >= ? GROUP BY b", (since, since)):
                if 0 <= idx < hours:
                    buckets[idx]["count"], buckets[idx]["value"] = cnt, round(val, 2)
            pods = c.execute("SELECT COUNT(*) FROM killmails WHERE time >= ? AND ship_type IN (670, 33328)", (since,)).fetchone()[0]
            regions = [{"region_id": r, "count": cnt, "value": round(v, 2)} for r, cnt, v in c.execute(
                "SELECT region_id, COUNT(*), SUM(value) FROM killmails WHERE time >= ? GROUP BY region_id ORDER BY SUM(value) DESC LIMIT 5", (since,))]
            return {"hours": hours, "count": n, "value": round(total, 2), "pods": pods, "buckets": buckets, "regions": regions}
        return self.cached(("summary", hours), run, force)

    # GET /leaderboard
    def leaderboard(self, q, force=False):
        days = min(float(q.get("days", 30)), 60)
        side = "kills" if q.get("side") == "kills" else "losses"
        by = q.get("by") if q.get("by") in ENTITY_COL else "character"
        metric = "count" if q.get("metric") == "count" else "value"
        limit = min(int(q.get("limit", 20)), 100)

        def run():
            since = int(time.time() - days * 86400)
            vcol, acol = ENTITY_COL[by]
            order = "n" if metric == "count" else "v"
            if side == "losses":
                sql = f"SELECT {vcol}, COUNT(*) n, SUM(value) v FROM killmails WHERE time >= ? AND {vcol} IS NOT NULL GROUP BY {vcol} ORDER BY {order} DESC LIMIT ?"
            else:
                # 只统计玩家攻击者；同一击杀中同军团 / 联盟的多人只计一次
                # 范围几乎覆盖全表，顺序扫描比走索引后逐行回表快数倍
                sql = f"""SELECT eid, COUNT(*) n, SUM(value) v FROM (
                            SELECT DISTINCT a.km, a.{acol} AS eid, k.value FROM attackers a NOT INDEXED JOIN killmails k ON k.id = a.km
                            WHERE a.time >= ? AND a.{acol} IS NOT NULL)
                          GROUP BY eid ORDER BY {order} DESC LIMIT ?"""
            rows = self.store.conn().execute(sql, (since, limit)).fetchall()
            names = self.names_for([r[0] for r in rows])
            return {"side": side, "by": by, "metric": metric, "days": days,
                    "rows": [{"id": r[0], "name": names.get(r[0]), "count": r[1], "value": round(r[2] or 0, 2)} for r in rows]}
        return self.cached(("lb", days, side, by, metric, limit), run, force)

    # GET /search
    def search(self, q):
        text = (q.get("q") or "").strip().lower()
        if len(text) < 2:
            return {"results": []}
        rows = self.store.conn().execute(
            "SELECT id, name, category FROM names WHERE lname LIKE ? AND category IN ('character','corporation','alliance') "
            "ORDER BY (lname = ?) DESC, (lname LIKE ?) DESC, length(name) LIMIT 30",
            (f"%{text}%", text, f"{text}%")).fetchall()
        return {"results": [{"id": r[0], "name": r[1], "category": r[2]} for r in rows]}

    # GET /entity/<kind>/<id>
    def entity(self, kind, eid, q):
        if kind not in ENTITY_COL:
            raise KeyError(kind)
        days = min(float(q.get("days", 30)), 60)

        def run():
            since = int(time.time() - days * 86400)
            vcol, acol = ENTITY_COL[kind]
            c = self.store.conn()
            losses, lost = c.execute(f"SELECT COUNT(*), COALESCE(SUM(value),0) FROM killmails WHERE {vcol}=? AND time >= ?", (eid, since)).fetchone()
            kills, destroyed = c.execute(
                f"SELECT COUNT(*), COALESCE(SUM(value),0) FROM killmails WHERE time >= ? AND id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ? AND char IS NOT NULL)",
                (since, eid, since)).fetchone()
            solo = c.execute(f"SELECT COUNT(*) FROM killmails WHERE time >= ? AND solo=1 AND id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ? AND char IS NOT NULL)",
                             (since, eid, since)).fetchone()[0]
            # 最后一击：击杀记录里的 final blow 归属（经攻击者索引过滤，避免全表扫描）
            fcol = "f_" + vcol[2:]
            final_blows = c.execute(f"SELECT COUNT(*) FROM killmails WHERE time >= ? AND {fcol}=? AND id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ?)",
                                    (since, eid, eid, since)).fetchone()[0]
            result = {"kind": kind, "id": eid, "days": days, "kills": kills, "losses": losses,
                      "destroyed": round(destroyed, 2), "lost": round(lost, 2), "solo_kills": solo, "final_blows": final_blows}
            # 成员明细：军团 → 人物；联盟 → 军团
            member = {"corporation": ("char", "v_char"), "alliance": ("corp", "v_corp")}.get(kind)
            if member:
                mcol, mv = member
                stats = {}
                for mid, n, v in c.execute(
                        f"""SELECT eid, COUNT(*), SUM(value) FROM (
                              SELECT DISTINCT a.km, a.{mcol} AS eid, k.value FROM attackers a JOIN killmails k ON k.id = a.km
                              WHERE a.{acol}=? AND a.time >= ? AND a.char IS NOT NULL AND a.{mcol} IS NOT NULL)
                            GROUP BY eid""", (eid, since)):
                    stats[mid] = {"id": mid, "kills": n, "destroyed": round(v or 0, 2), "losses": 0, "lost": 0.0}
                for mid, n, v in c.execute(f"SELECT {mv}, COUNT(*), SUM(value) FROM killmails WHERE {vcol}=? AND time >= ? AND {mv} IS NOT NULL GROUP BY {mv}", (eid, since)):
                    s = stats.setdefault(mid, {"id": mid, "kills": 0, "destroyed": 0.0, "losses": 0, "lost": 0.0})
                    s["losses"], s["lost"] = n, round(v or 0, 2)
                names = self.names_for(list(stats))
                for s in stats.values():
                    s["name"] = names.get(s["id"])
                result["members"] = sorted(stats.values(), key=lambda s: s["destroyed"], reverse=True)
            ships = c.execute(f"SELECT ship, COUNT(DISTINCT km) n FROM attackers WHERE {acol}=? AND time >= ? AND char IS NOT NULL AND ship IS NOT NULL GROUP BY ship ORDER BY n DESC LIMIT 8", (eid, since)).fetchall()
            result["ships_used"] = [{"ship_type_id": s, "count": n} for s, n in ships]
            lost_ships = c.execute(f"SELECT ship_type, COUNT(*) n FROM killmails WHERE {vcol}=? AND time >= ? GROUP BY ship_type ORDER BY n DESC LIMIT 8", (eid, since)).fetchall()
            result["ships_lost"] = [{"ship_type_id": s, "count": n} for s, n in lost_ships]
            regions = c.execute(f"SELECT region_id, COUNT(*) n FROM killmails WHERE time >= ? AND ({vcol}=? OR id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ?)) GROUP BY region_id ORDER BY n DESC LIMIT 8",
                                (since, eid, eid, since)).fetchall()
            result["regions"] = [{"region_id": r, "count": n} for r, n in regions]
            systems = c.execute(f"SELECT system_id, COUNT(*) n FROM killmails WHERE time >= ? AND ({vcol}=? OR id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ?)) GROUP BY system_id ORDER BY n DESC LIMIT 8",
                                (since, eid, eid, since)).fetchall()
            result["systems"] = [{"system_id": r, "count": n} for r, n in systems]
            result["name"] = self.names_for([eid]).get(eid)
            return result
        return self.cached(("entity", kind, eid, days), run)

    # GET /kill/<id>
    def kill(self, kid, q):
        row = self.store.conn().execute("SELECT value, hash FROM killmails WHERE id=?", (kid,)).fetchone()
        # 本地不存击杀原文（省空间），详情按需从 ESI 获取；ESI 的击杀邮件永不变化，放进内存缓存
        with self.km_lock:
            km = self.km_cache.get(kid)
            if km is not None:
                self.km_cache.move_to_end(kid)
        if not row:
            # 保留期以外的击杀：来自 zKillboard，只在内存中估值
            if km is None:
                data = zkill_get(f"killID/{kid}/")
                if not data:
                    raise KeyError(kid)
                km = data[0]
                with self.km_lock:
                    self.km_cache[kid] = km
            row = (self.store.km_value(km), (km.get("zkb") or {}).get("hash"))
        elif km is None:
            km, _ = get_json(f"{ESI}/killmails/{kid}/{row[1]}/", timeout=20, retries=2)
            with self.km_lock:
                self.km_cache[kid] = km
                while len(self.km_cache) > KM_CACHE:
                    self.km_cache.popitem(last=False)
        types = {km["victim"]["ship_type_id"]}
        dropped = destroyed = 0.0

        def walk(items):
            nonlocal dropped, destroyed
            for it in items:
                types.add(it["item_type_id"])
                unit = 0.0 if it.get("singleton") == 2 else self.store.price(it["item_type_id"])
                dropped += unit * (it.get("quantity_dropped") or 0)
                destroyed += unit * (it.get("quantity_destroyed") or 0)
                walk(it.get("items") or [])
        walk(km["victim"].get("items") or [])
        destroyed += self.store.price(km["victim"]["ship_type_id"])  # 船体视为摧毁
        ids = [km["victim"].get(k) for k in ("character_id", "corporation_id", "alliance_id")]
        for a in km.get("attackers") or []:
            ids += [a.get("character_id"), a.get("corporation_id"), a.get("alliance_id")]
        return {"killmail": km, "hash": row[1], "value": round(row[0] or 0, 2), "dropped": round(dropped, 2), "destroyed": round(destroyed, 2),
                "prices": {t: round(self.store.price(t), 2) for t in types}, "names": self.names_for(ids)}


# ---------------------------------------------------------------- HTTP 服务
def make_handler(api, static_dir):
    routes = {"status": api.status, "live": api.live, "battles": api.battles, "feed": api.feed, "top": api.top, "summary": api.summary,
              "leaderboard": api.leaderboard, "search": api.search}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        def send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
            gz = "gzip" in (self.headers.get("Accept-Encoding") or "") and len(body) > 1024
            if gz:
                body = gzip.compress(body, 5)
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if url.path.startswith("/api/kb/"):
                return self.api(url)
            if static_dir:
                return self.static(url.path)
            self.send_json(404, {"error": "not found"})

        def api(self, url):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            parts = [p for p in url.path[len("/api/kb/"):].split("/") if p]
            try:
                if len(parts) == 1 and parts[0] in routes:
                    return self.send_json(200, routes[parts[0]](q))
                if len(parts) == 3 and parts[0] == "entity":
                    return self.send_json(200, api.entity(parts[1], int(parts[2]), q))
                if len(parts) == 2 and parts[0] == "kill":
                    return self.send_json(200, api.kill(int(parts[1]), q))
                self.send_json(404, {"error": "not found"})
            except (KeyError, ValueError) as e:
                self.send_json(404 if isinstance(e, KeyError) else 400, {"error": str(e)})
            except Exception as e:
                log.exception("接口错误")
                self.send_json(500, {"error": str(e)})

        def static(self, path):
            rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
            # 只做路径规范化（不解析符号链接）：阻止 .. 越界，同时允许静态目录内的软链接
            root = os.path.abspath(static_dir)
            full = os.path.normpath(os.path.join(root, rel))
            if not full.startswith(root + os.sep) or not os.path.isfile(full):
                self.send_response(404)
                self.end_headers()
                return
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="EVE 击杀记录服务")
    parser.add_argument("--db", default="kb.sqlite")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8291)
    parser.add_argument("--days", type=int, default=30, help="历史导入与保留天数")
    parser.add_argument("--live", default="auto", choices=["auto", "r2z2", "redisq", "poll", "off"],
                        help="实时数据来源；redisq 已停用，等同 r2z2")
    parser.add_argument("--static", help="同时托管的前端静态目录（本地 / 演示环境）")
    parser.add_argument("--system-regions", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "system_regions.json"))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    with open(args.system_regions, encoding="utf-8") as fh:
        system_regions = {int(k): v for k, v in json.load(fh).items()}
    store = Store(args.db, system_regions, args.days + 1)
    Workers(store, args.days, "r2z2" if args.live == "redisq" else args.live).start()
    api = Api(store)
    threading.Thread(target=api.warm, daemon=True).start()
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(api, args.static))
    log.info("击杀记录服务已启动 http://%s:%d", args.bind, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
