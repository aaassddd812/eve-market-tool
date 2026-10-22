#!/usr/bin/env python3
"""击杀记录（KB）后端服务：收录新伊甸全部击杀邮件，按吉他中间价估值，提供列表 / 排行 / 统计接口。

数据来源
  - 历史：EVE Ref 每日击杀存档 https://data.everef.net/killmails/（完整 ESI 击杀邮件，每天约 1.4 万条）
  - 实时：zKillboard R2Z2 顺序推送（RedisQ 已于 2026-05-31 停用）；不可用时轮询 zKillboard 各星域最新击杀
  - 价格：ESI 伏尔戈市场全量订单，取吉他 4-4 最低卖价与最高收购价的中间值
  - 旗舰等吉他没有卖单的物品：每 6 小时扫描全服公开合同，取扣除附带物品市场价后的最低价（合同价变化时重算相关历史击杀）

接口（只读，仅监听 127.0.0.1，由 nginx 反代 /api/kb/）
  GET /api/kb/status                          数据覆盖范围与运行状态
  GET /api/kb/feed?cursor=&limit=&ship=&system=&region=&character=&corporation=&alliance=&side=
                                              击杀列表（最新在前）；side=kills|losses|all
                                              本地只保留 --days 天；带筛选条件时翻完本地记录后自动改为实时查询 zKillboard（不入库）
  GET /api/kb/live?after=N                    实时收录的新击杀（星图闪烁 / 弹幕），返回新的游标
  GET /api/kb/br?systems=1,2&start=T&end=T     战场统计：指定星系与时间段（Unix 秒）内的全部玩家击杀及攻击者（前端按联盟分阵营统计）
  GET /api/kb/battles?window=60&min=20        疑似会战：时间窗（分钟）内同一星系被击毁舰船数 ≥ min（不含太空舱与 1000 万 ISK 以下的击杀）
  GET /api/kb/top?days=7&limit=8              指定天数内价值最高的损失
  GET /api/kb/summary?hours=24                指定小时内的总损失（含每小时分布）
  GET /api/kb/leaderboard?days=30&side=losses|kills&by=character|corporation|alliance&metric=value|count
  GET /api/kb/search?q=                       搜索人物 / 军团 / 联盟
  GET /api/kb/entity/<kind>/<id>?days=30      人物 / 军团 / 联盟统计（含成员明细）
  GET /api/kb/kill/<id>                       击杀邮件详情与逐项估价（原文按需取自 ESI，本地不保存）
  GET /api/kb/shipfits?ship=ID&days=7          某型舰船最近 N 天（≤ 保留期）阵亡时的装配，相同装配合并计数（物品原文按需取自 ESI，提取结果存库）
  GET /api/kb/bpprices?types=1,2               公开合同里的蓝图价格：原图最低价、拷贝每流程最低价（各取最便宜 5 份）；
                                               不带 types 时返回全部蓝图的 [原图最低价, 拷贝每流程最低价]
                                               数据来自 EVE Ref 公开合同快照 https://data.everef.net/public-contracts/（每 30 分钟刷新）
  GET /api/kb/couriers                        全服公开快递合同（同一份快照，字段同 ESI /contracts/public/{region_id}/，另带 region_id、start_system_id）

用法
  python3 kb_service.py --db kb.sqlite [--port 8291] [--days 30] [--live auto|r2z2|poll|off] [--static DIR]
  --static 仅用于本地 / 演示环境：同时托管前端静态文件。
"""

import argparse
import array
import collections
import concurrent.futures
import csv
import datetime as dt
import gzip
import io
import json
import logging
import math
import mimetypes
import os
import re
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
EVEREF_CONTRACTS = "https://data.everef.net/public-contracts/public-contracts-latest.v2.tar.bz2"
BP_CONTRACT_TTL = 1800      # 蓝图合同价 / 快递合同每 30 分钟刷新（快照约每 30 分钟更新）
BP_CONTRACT_KEEP = 5        # 每种蓝图的原图 / 拷贝各保留最便宜的几份合同
BP_MAX_TYPES = 300          # bpprices 单次最多查询的蓝图种类
API_RATE = 1000             # 开放接口：每个 IP 每分钟可用的请求额度（令牌桶，容量同此值）
API_COST = {"ship_fits": 10, "battle_report": 5, "industry_profits": 5, "abyssal_module": 2, "abyssal_list": 3}   # 开销大的接口一次消耗多个额度
# 深渊装备估价：代理 MutaMarket 公开 API（对方不允许浏览器跨域）。只用于宁静服；导入 / 刷新（POST）由用户点击触发、单独限流
MUTA_API = "https://mutamarket.com/api"
ABYSSAL_TTL = 6 * 3600          # 单件估价缓存
ABYSSAL_MODELS_TTL = 24 * 3600  # 各类型模型质量
ABYSSAL_POST_RATE = 10          # 每个 IP 每分钟最多导入 / 刷新次数
ABYSSAL_LIST_TTL = 300          # 在售列表（按筛选条件）缓存
ABYSSAL_TYPES_TTL = 7 * 86400   # 各深渊类型的属性范围（最好 / 最差），对方建议长期缓存
ABYSSAL_SORTS = {"price", "value", "fraction", "contract-date", "date-added"}
ABYSSAL_META_GROUPS = {"t1", "t2", "storyline", "faction", "officer", "deadspace"}
ABYSSAL_FLAGS = {"goldbar", "brownbar", "diamondbar", "item-exchange", "auction", "no-multi-item-contracts", "contracts-only", "in-jita", "without-other-items"}
PRICE_MAX_TYPES = 200       # prices 单次最多查询的物品种类
SHIPFIT_MAX = 300           # shipfits：每次最多分析的最近损失数
SHIPFIT_WORKERS = 16        # shipfits：并发向 ESI 取击杀原文
# 击杀邮件物品 flag → 槽位（模块与装填的弹药同 flag；区分由前端按物品类别完成）
FIT_FLAGS = [("high", range(27, 35)), ("mid", range(19, 27)), ("low", range(11, 19)), ("rig", range(92, 100)),
             ("sub", range(125, 133)), ("drone", (87,)), ("fighter", (158,))]
UA = "EVE-Market-Tool KB service (+https://github.com/wbw5780/eve-market-tool)"
FORGE = 10000002
JITA_44 = 60003760
# 四族贸易中心（星域 → 交易中心空间站），开放接口 prices 的 hub 参数用星域 ID；全宇宙用 all（库里记作 0）
HUB_STATIONS = {10000002: 60003760, 10000043: 60008494, 10000032: 60011866, 10000030: 60004588, 10000042: 60005686}
PRICE_TTL = 3600            # 价格每小时刷新
CONTRACT_TTL = 6 * 3600     # 公开合同估价每 6 小时刷新
CONTRACT_MIN_VOLUME = 500_000   # 只看体积 ≥ 50 万 m³ 的物品交换合同（旗舰 / 建筑等）
CONTRACT_MIN_PRICE = 3e8        # 且售价 ≥ 3 亿
POLL_INTERVAL = 300         # 轮询模式：每轮间隔（秒）
POLL_GAP = 1.2              # 轮询模式：两次 zKillboard 请求的间隔（秒）
CACHE_TTL = 600             # 排行 / 统计结果缓存（秒）
KM_CACHE = 500              # 击杀详情内存缓存条数
ZKILL_GAP = 1.0             # 任意两次 zKillboard 请求的最小间隔（秒），轮询与用户查询共用
ZKILL_MAX_PAGE = 100        # zKillboard 每个查询最多翻到第 100 页（每页 200 条）
LIVE_BUFFER = 300           # 实时缓冲保留最近的新击杀条数
LIVE_MAX_AGE = 3 * 3600     # 发生超过 3 小时的击杀不进入实时推送
ARCHIVE_CACHE = 30          # 30 天以前的查询结果只放内存，缓存的 zKillboard 页数
BR_MAX_SYSTEMS = 30           # 战场统计：最多星系数
BR_MAX_HOURS = 72             # 战场统计：最长时间段
BR_MAX_KILLS = 5000           # 战场统计：最多击杀数
BR_CACHE_KEEP = 50            # 战场统计：内存中保留的查询结果数
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
-- 各贸易中心与全宇宙（hub = 0）的最低卖价 / 最高收购价
CREATE TABLE IF NOT EXISTS hub_prices(hub INTEGER, type_id INTEGER, sell REAL, buy REAL, PRIMARY KEY(hub, type_id)) WITHOUT ROWID;
-- 吉他没有卖单的物品（主要是旗舰）：全服公开合同里扣除附带物品后的最低价
CREATE TABLE IF NOT EXISTS contract_prices(type_id INTEGER PRIMARY KEY, price REAL, contract_id INTEGER, region_id INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
-- 深渊装备估价（MutaMarket 单件结果，按 item_id 缓存；data 为本站归一化后的 JSON）
CREATE TABLE IF NOT EXISTS abyssal(item_id INTEGER PRIMARY KEY, type_id INTEGER, data TEXT, fetched_at INTEGER);
-- 阵亡装配：从击杀原文提取的各槽位物品（JSON），供 shipfits 统计常见装配
CREATE TABLE IF NOT EXISTS km_fits(id INTEGER PRIMARY KEY, ship INTEGER, time INTEGER, fit TEXT);
CREATE INDEX IF NOT EXISTS kmfit_ship ON km_fits(ship, time);
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
        self.adjusted = {}
        for type_id, sell, buy, avg in conn.execute("SELECT type_id, sell, buy, avg FROM prices"):
            self.prices[type_id] = (sell, buy, avg)
        self.hub_prices = {}
        for hub, type_id, sell, buy in conn.execute("SELECT hub, type_id, sell, buy FROM hub_prices"):
            self.hub_prices.setdefault(hub, {})[type_id] = (sell, buy)
        self.contract_prices = dict(conn.execute("SELECT type_id, price FROM contract_prices"))
        # 公开合同里的蓝图：type_id -> {"o": [[价格, ME, TE, 合同, 星系]], "c": [[每流程价, 流程, 价格, ME, TE, 合同, 星系]]}（仅内存）
        self.bp_contracts = {}
        self.couriers = {"at": None, "list": []}
        self.known_names = {row[0] for row in conn.execute("SELECT id FROM names")}
        self.pending_names = set()
        self.cache = {}
        # 实时收录的新击杀（仅内存）：供星图闪烁与弹幕使用，按入库顺序编号
        self.live_buf = collections.deque(maxlen=LIVE_BUFFER)
        self.live_n = 0
        self.state = {"live_mode": None, "last_live": None, "prices_updated": self.meta("prices_updated"), "hub_prices_updated": self.meta("hub_prices_updated"), "backfill": "等待中"}

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
    def price(self, type_id, contracts=True):
        p = self.prices.get(type_id)
        cp = self.contract_prices.get(type_id) if contracts else None
        if not p:
            return cp or 0.0
        sell, buy, avg = p
        if sell and buy:
            # 卖价远高于收价通常是挂单异常（如天价卖单），改用全服均价
            if sell > buy * 10 and avg:
                return avg
            return (sell + buy) / 2
        # 吉他没有卖单（旗舰等不能上市场的物品）：优先用公开合同最低价，收购单多为钓鱼低价
        if not sell and cp:
            return cp
        if not sell and buy and avg and buy * 10 < avg:
            return avg
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
            live_att = {}                        # 实时缓冲用：每条击杀全部玩家攻击者的角色 ID（击杀预警的人物关注要判断「参与击杀」）
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
                if live:
                    live_att[kid] = [a["character_id"] for a in players][:500]
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
                        # 带上 hash：击杀预警的游戏内邮件要用 killReport:ID:HASH 链接
                        self.live_buf.append((self.live_n, {**row_summary(row[:1] + row[2:]), "hash": row[1], "att": live_att.get(row[0], [])}))
        return added

    def prune(self):
        cutoff = int(time.time() - self.retention * 86400)
        c = self.conn()
        with self.write_lock:
            n = c.execute("DELETE FROM killmails WHERE time < ?", (cutoff,)).rowcount
            c.execute("DELETE FROM attackers WHERE time < ?", (cutoff,))
            c.execute("DELETE FROM km_fits WHERE time < ?", (cutoff,))
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
        for target in (self.price_loop, self.contract_loop, self.bp_contract_loop, self.backfill, self.live_loop, self.names_loop):
            threading.Thread(target=target, daemon=True).start()

    # ---- 价格：伏尔戈全量订单 → 吉他 4-4 最低卖 / 最高收；随后读全宇宙订单 → 其余贸易中心与全宇宙的最低卖 / 最高收
    @staticmethod
    def region_orders(rid, handle):
        """逐页读取星域全部订单交给 handle，返回页数"""
        first, headers = get_json(f"{ESI}/markets/{rid}/orders/?order_type=all&page=1")
        handle(first or [])
        pages = int(headers.get("X-Pages") or 1)

        def page(n):
            data, _ = get_json(f"{ESI}/markets/{rid}/orders/?order_type=all&page={n}")
            return data or []

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            for data in pool.map(page, range(2, pages + 1)):
                handle(data)
        return pages

    def refresh_prices(self):
        uni_sell, uni_buy = {}, {}                        # 全宇宙
        hub_sell = {h: {} for h in HUB_STATIONS}
        hub_buy = {h: {} for h in HUB_STATIONS}
        station_hub = {st: h for h, st in HUB_STATIONS.items()}

        def handle(orders):
            for o in orders:
                t, p = o["type_id"], o["price"]
                h = station_hub.get(o["location_id"])
                if o["is_buy_order"]:
                    if p > uni_buy.get(t, 0):
                        uni_buy[t] = p
                    if h and p > hub_buy[h].get(t, 0):
                        hub_buy[h][t] = p
                else:
                    if t not in uni_sell or p < uni_sell[t]:
                        uni_sell[t] = p
                    if h and (t not in hub_sell[h] or p < hub_sell[h][t]):
                        hub_sell[h][t] = p

        pages = self.region_orders(FORGE, handle)
        sell, buy = hub_sell[FORGE], hub_buy[FORGE]
        avg_list, _ = get_json(f"{ESI}/markets/prices/")
        avg = {x["type_id"]: x.get("average_price") or x.get("adjusted_price") for x in avg_list}
        self.store.adjusted = {x["type_id"]: x["adjusted_price"] for x in avg_list if x.get("adjusted_price")}   # 制造任务的 EIV 用
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
        self.prices_ready.set()

        # 其余星域：某个星域读取失败时跳过（全宇宙价格少了这个星域），不影响吉他价格
        regions, _ = get_json(f"{ESI}/universe/regions/")
        failed = []
        for rid in regions:
            if rid >= 11000000 or rid == FORGE:
                continue
            try:
                pages += self.region_orders(rid, handle)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    failed.append(rid)
            except Exception:
                failed.append(rid)
        hubs = {0: (uni_sell, uni_buy), **{h: (hub_sell[h], hub_buy[h]) for h in HUB_STATIONS}}
        rows = [(h, t, sl.get(t), bl.get(t)) for h, (sl, bl) in hubs.items() for t in set(sl) | set(bl)]
        with self.store.write_lock:
            c.execute("DELETE FROM hub_prices")
            c.executemany("INSERT INTO hub_prices VALUES(?,?,?,?)", rows)
            c.commit()
        self.store.hub_prices = {h: {t: (sl.get(t), bl.get(t)) for t in set(sl) | set(bl)} for h, (sl, bl) in hubs.items()}
        stamp = iso(time.time())
        self.store.meta("hub_prices_updated", stamp)
        self.store.state["hub_prices_updated"] = stamp
        log.info("贸易中心 / 全宇宙价格已更新：共 %d 页订单，%d 种物品%s", pages, len(set(uni_sell) | set(uni_buy)),
                 f"，{len(failed)} 个星域读取失败" if failed else "")

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

    # ---- 公开合同估价：吉他没有卖单的物品（旗舰、部分建筑）用全服公开合同的最低价
    # 只看体积大、售价高的物品交换合同；合同里恰好一件「吉他无卖单」的物品，扣除其余附带物品的市场价后作为它的价格
    def refresh_contracts(self):
        regions, _ = get_json(f"{ESI}/universe/regions/")
        regions = [r for r in regions if r < 11000000]       # 新伊甸 k 空间（虫洞没有公开合同）

        def region_contracts(rid):
            out = []
            try:
                first, headers = get_json(f"{ESI}/contracts/public/{rid}/?page=1")
            except Exception:
                return out
            pages = int(headers.get("X-Pages") or 1)
            batch = [first or []]
            for n in range(2, pages + 1):
                try:
                    batch.append(get_json(f"{ESI}/contracts/public/{rid}/?page={n}")[0] or [])
                except Exception:
                    break
            for page in batch:
                for c in page:
                    if c.get("type") == "item_exchange" and (c.get("volume") or 0) >= CONTRACT_MIN_VOLUME and (c.get("price") or 0) >= CONTRACT_MIN_PRICE:
                        c["region_id"] = rid
                        out.append(c)
            return out

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            contracts = [c for part in pool.map(region_contracts, regions) for c in part]

        # 合同内容不会变，跨轮次缓存
        cache = getattr(self, "contract_items", {})
        todo = [c["contract_id"] for c in contracts if c["contract_id"] not in cache]

        def items(cid):
            try:
                return cid, get_json(f"{ESI}/contracts/public/items/{cid}/")[0] or []
            except Exception:
                return cid, None

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            for cid, its in pool.map(items, todo):
                if its is not None:
                    cache[cid] = its
        live = {c["contract_id"] for c in contracts}
        self.contract_items = {k: v for k, v in cache.items() if k in live}

        best = {}
        for c in contracts:
            its = self.contract_items.get(c["contract_id"])
            if not its or any(not it.get("is_included") for it in its):
                continue                                     # 跳过同时要求对方提供物品的合同
            no_sell = [it for it in its if not (self.store.prices.get(it["type_id"]) or (None,))[0]]
            if len(no_sell) != 1 or no_sell[0].get("quantity", 1) != 1:
                continue
            hull = no_sell[0]["type_id"]
            extra = sum(self.store.price(it["type_id"], contracts=False) * (it.get("quantity") or 1) for it in its if it is not no_sell[0])
            net = c["price"] - extra
            if net < c["price"] * 0.5:
                continue                                     # 附带物品占大头，估不准
            if hull not in best or net < best[hull][0]:
                best[hull] = (net, c["contract_id"], c["region_id"])

        old = dict(self.store.contract_prices)
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM contract_prices")
            c.executemany("INSERT INTO contract_prices VALUES(?,?,?,?,?)", [(t, round(v[0], 2), v[1], v[2], now) for t, v in best.items()])
            c.commit()
        self.store.contract_prices = {t: round(v[0], 2) for t, v in best.items()}
        changed = [t for t, v in best.items() if not old.get(t) or abs(v[0] - old[t]) > old[t] * 0.05]
        fixed = self.revalue_hulls(changed)
        self.store.cache.clear()
        self.store.meta("contracts_updated", iso(now))
        log.info("公开合同估价：%d 个大额合同，%d 种物品有合同价（新增 %d），修正 %d 条历史击杀估值",
                 len(contracts), len(best), len(set(best) - set(old)), fixed)

    def revalue_hulls(self, types):
        """合同价变化（首次或变动超过 5%）的船型：已入库的击杀重新读取击杀邮件，按当前价格重新估值"""
        c = self.store.conn()
        ids = list(types)
        if not ids:
            return 0
        rows = []
        for chunk in range(0, len(ids), 900):
            part = ids[chunk:chunk + 900]
            rows += c.execute(f"SELECT id, hash, value FROM killmails WHERE ship_type IN ({','.join('?' * len(part))}) AND hash IS NOT NULL",
                              part).fetchall()

        def revalue(row):
            kid, km_hash, old = row
            try:
                km, _ = get_json(f"{ESI}/killmails/{kid}/{km_hash}/", timeout=20, retries=2)
                return kid, self.store.km_value(km), old
            except Exception:
                return kid, None, old

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = [r for r in pool.map(revalue, rows) if r[1] is not None and abs(r[1] - r[2]) > 1]
        with self.store.write_lock:
            c.executemany("UPDATE killmails SET value = ? WHERE id = ?", [(round(v, 2), kid) for kid, v, _ in results])
            c.commit()
        return len(results)

    def contract_loop(self):
        self.prices_ready.wait()                             # 扣除附带物品需要市场价
        while True:
            try:
                self.refresh_contracts()
            except Exception:
                log.exception("公开合同估价失败")
            time.sleep(CONTRACT_TTL)

    # ---- 蓝图合同价：EVE Ref 公开合同快照（全服物品交换合同及其物品，约 6 MB）
    # 只看「只卖一张蓝图、不要求对方附带物品」的合同：原图按总价、拷贝按每流程单价各取最便宜的几份
    # 同一份快照里的全服公开快递合同（约数百份）原样提供给前端快递页
    def refresh_bp_contracts(self):
        body, _ = http_get(EVEREF_CONTRACTS, timeout=180)
        now = time.time()
        couriers = []
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:bz2") as tar:
            def rows(name):
                member = next(m for m in tar.getmembers() if m.name.endswith(name))
                return csv.DictReader(io.TextIOWrapper(tar.extractfile(member), encoding="utf-8"))
            try:
                meta = json.load(tar.extractfile(next(m for m in tar.getmembers() if m.name.endswith("meta.json"))))
            except Exception:
                meta = {}
            contracts = {}
            for c in rows("contracts.csv"):
                if c["type"] == "courier" and not (c["date_expired"] and epoch(c["date_expired"]) < now):
                    couriers.append(courier_row(c))
                if c["type"] != "item_exchange" or c.get("for_corporation") == "true":
                    continue
                price = float(c["price"] or 0)
                if price <= 0 or (c["date_expired"] and epoch(c["date_expired"]) < now):
                    continue
                contracts[c["contract_id"]] = (price, int(c["system_id"] or 0))
            items = collections.defaultdict(list)
            for it in rows("contract_items.csv"):
                if it["contract_id"] in contracts:
                    items[it["contract_id"]].append(it)
        bpo, bpc = collections.defaultdict(list), collections.defaultdict(list)
        for cid, lst in items.items():
            if len(lst) != 1:
                continue
            it = lst[0]
            if it["is_included"] != "true" or it["is_blueprint_copy"] not in ("true", "false") or int(it["quantity"] or 1) != 1:
                continue
            price, system = contracts[cid]
            tid, me, te = int(it["type_id"]), int(it["material_efficiency"] or 0), int(it["time_efficiency"] or 0)
            if it["is_blueprint_copy"] == "true":
                runs = int(it["runs"] or 0)
                if runs > 0:
                    bpc[tid].append([round(price / runs, 2), runs, price, me, te, int(cid), system])
            else:
                bpo[tid].append([price, me, te, int(cid), system])
        result = {}
        for tid in set(bpo) | set(bpc):
            result[tid] = {"o": sorted(bpo.get(tid, []))[:BP_CONTRACT_KEEP], "c": sorted(bpc.get(tid, []))[:BP_CONTRACT_KEEP]}
        self.store.bp_contracts = result
        self.store.state["bp_contracts_updated"] = iso(now)
        self.store.couriers = {"at": meta.get("scrape_end") or iso(now), "list": couriers}
        log.info("快递合同：%d 份", len(couriers))
        log.info("蓝图合同价：%d 份合同，%d 种蓝图", sum(len(v) for v in bpo.values()) + sum(len(v) for v in bpc.values()), len(result))

    def bp_contract_loop(self):
        while True:
            try:
                self.refresh_bp_contracts()
            except Exception:
                log.exception("蓝图合同价读取失败")
            time.sleep(BP_CONTRACT_TTL)

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


def courier_row(c):
    """EVE Ref 快照的一行快递合同 → 与 ESI /contracts/public/{region_id}/ 相同的字段（另带起点星系 / 星域）"""
    num = lambda k: float(c.get(k) or 0)
    row = {
        "contract_id": int(c["contract_id"]), "start_location_id": int(c["start_location_id"] or 0),
        "end_location_id": int(c["end_location_id"] or 0), "reward": num("reward"), "collateral": num("collateral"),
        "volume": round(num("volume"), 2), "days_to_complete": int(c.get("days_to_complete") or 0),
        "date_issued": c.get("date_issued") or None, "date_expired": c.get("date_expired") or None,
        "issuer_id": int(c.get("issuer_id") or 0), "issuer_corporation_id": int(c.get("issuer_corporation_id") or 0),
        "title": c.get("title") or "", "region_id": int(c.get("region_id") or 0),
    }
    if c.get("system_id"):
        row["start_system_id"] = int(c["system_id"])
    if c.get("for_corporation") == "true":
        row["for_corporation"] = True
    return row


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
        self.lb_full = collections.OrderedDict()    # 完整排行榜（分页用）：(days, side, by, metric) -> (时间, ids, 次数, 价值)
        self.lb_lock = threading.Lock()

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

    # GET /br?systems=1,2,3&start=T&end=T：战场统计原始数据（时间为 Unix 秒）
    # 返回紧凑数组以减小体积：kills[i] = [id, time, system, ship, value, v_char, v_corp, v_alliance, [[char, corp, alliance, ship], ...]]
    def br(self, q):
        systems = sorted({int(x) for x in str(q.get("systems", "")).split(",") if x.strip()})
        if not systems:
            raise ValueError("缺少星系")
        if len(systems) > BR_MAX_SYSTEMS:
            raise ValueError(f"最多选择 {BR_MAX_SYSTEMS} 个星系")
        start, end = int(q["start"]), int(q["end"])
        if end <= start:
            raise ValueError("结束时间必须晚于开始时间")
        if end - start > BR_MAX_HOURS * 3600:
            raise ValueError(f"时间段最长 {BR_MAX_HOURS} 小时")
        key = ("br", tuple(systems), start, end)
        hit = self.store.cache.get(key)
        # 已经结束的时间段结果不会再变，缓存久一点；包含当前时间的只缓存 30 秒
        ttl = CACHE_TTL if end < time.time() - 3600 else 30
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        c = self.store.conn()
        marks = ",".join("?" * len(systems))
        rows = c.execute(f"""SELECT id, time, system_id, ship_type, value, v_char, v_corp, v_alliance FROM killmails
                             WHERE system_id IN ({marks}) AND time >= ? AND time < ? AND npc = 0
                             ORDER BY time LIMIT ?""", (*systems, start, end, BR_MAX_KILLS + 1)).fetchall()
        truncated = len(rows) > BR_MAX_KILLS
        rows = rows[:BR_MAX_KILLS]
        att = collections.defaultdict(list)
        ids = set()
        kids = [r[0] for r in rows]
        for chunk in range(0, len(kids), 900):
            part = kids[chunk:chunk + 900]
            for km, char, corp, alliance, ship in c.execute(
                    f"SELECT km, char, corp, alliance, ship FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                att[km].append([char, corp, alliance, ship])
                ids.update((char, corp, alliance))
        kills = []
        for r in rows:
            ids.update(r[5:8])
            kills.append([r[0], r[1], r[2], r[3], round(r[4] or 0, 2), r[5], r[6], r[7], att.get(r[0], [])])
        value = {"systems": systems, "start": start, "end": end, "kills": kills, "truncated": truncated,
                 "retention_days": self.store.retention, "names": self.names_for(ids)}
        self.store.cache[key] = (time.time(), value)
        # 查询条件由用户决定，只保留最近的若干个结果，避免缓存无限增长
        br_keys = sorted((k for k in list(self.store.cache) if k[0] == "br"), key=lambda k: self.store.cache[k][0])
        for k in br_keys[:-BR_CACHE_KEEP]:
            self.store.cache.pop(k, None)
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
        # 开放接口（_local）只查本地保留期内的记录，不转向 zKillboard
        path = None if q.get("_local") else zkill_path(q, side)
        cursor = q.get("cursor") or ""
        if cursor.startswith("z:"):
            if not path:
                raise ValueError("cursor 无效")
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
        if "offset" in q or q.get("q"):
            return self.leaderboard_page(days, side, by, metric, q, force)
        limit = min(int(q.get("limit", 20)), 100)
        detail = q.get("detail") in ("1", "true")

        def run():
            since = int(time.time() - days * 86400)
            sql = self.leaderboard_sql(side, by, metric)
            rows = self.store.conn().execute(sql, (since, limit)).fetchall()
            out = [{"id": r[0], "count": r[1], "value": round(r[2] or 0, 2)} for r in rows]
            result = {"side": side, "by": by, "metric": metric, "days": days, "rows": out}
            extra_ids = []
            if detail and out:
                extra_ids = self.leaderboard_detail(out, by, side, since)
                c = self.store.conn()
                n, total = c.execute("SELECT COUNT(*), COALESCE(SUM(value), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
                result["total"] = {"count": n, "value": round(total, 2)}
            names = self.names_for([r["id"] for r in out] + extra_ids)
            for r in out:
                r["name"] = names.get(r["id"])
            if detail:
                result["names"] = {str(i): names[i] for i in extra_ids if names.get(i)}
            return result
        return self.cached(("lb", days, side, by, metric, limit, detail), run, force)

    @staticmethod
    def leaderboard_sql(side, by, metric, limit=True):
        vcol, acol = ENTITY_COL[by]
        order = "n" if metric == "count" else "v"
        tail = f"ORDER BY {order} DESC" + (" LIMIT ?" if limit else "")
        if side == "losses":
            return f"SELECT {vcol}, COUNT(*) n, SUM(value) v FROM killmails WHERE time >= ? AND {vcol} IS NOT NULL GROUP BY {vcol} {tail}"
        return f"""SELECT eid, COUNT(*) n, SUM(value) v FROM (
                    SELECT DISTINCT a.km, a.{acol} AS eid, k.value FROM attackers a NOT INDEXED JOIN killmails k ON k.id = a.km
                    WHERE a.time >= ? AND a.{acol} IS NOT NULL)
                  GROUP BY eid {tail}"""

    # 完整排名（不限条数），供分页；只在内存里保留最近用过的几种组合
    def leaderboard_full(self, days, side, by, metric, force=False):
        key = (days, side, by, metric)
        with self.lb_lock:
            hit = self.lb_full.get(key)
            if hit and not force and time.time() - hit[0] < CACHE_TTL:
                self.lb_full.move_to_end(key)
                return hit[1]
            since = int(time.time() - days * 86400)
            ids, counts, values = array.array("q"), array.array("q"), array.array("d")
            for eid, n, v in self.store.conn().execute(self.leaderboard_sql(side, by, metric, limit=False), (since,)):
                ids.append(eid)
                counts.append(n)
                values.append(v or 0)
            self.lb_full[key] = (time.time(), (ids, counts, values))
            while len(self.lb_full) > 12:
                self.lb_full.popitem(last=False)
            return ids, counts, values

    # GET /leaderboard?offset=&limit=&q= ：分页的完整排行榜，每条带排名与附加数据；q 按名称筛选（排名不变）
    def leaderboard_page(self, days, side, by, metric, q, force=False):
        offset = max(0, int(q.get("offset", 0) or 0))
        limit = min(max(int(q.get("limit", 20) or 20), 1), 100)
        text = (q.get("q") or "").strip().lower()

        def run():
            ids, counts, values = self.leaderboard_full(days, side, by, metric, force)
            c = self.store.conn()
            if text:
                match = {r[0] for r in c.execute("SELECT id FROM names WHERE lname LIKE ? AND category = ?", (f"%{text}%", by))}
                idx = [i for i, eid in enumerate(ids) if eid in match]
            else:
                idx = range(len(ids))
            out = [{"rank": i + 1, "id": ids[i], "count": counts[i], "value": round(values[i], 2)} for i in idx[offset:offset + limit]]
            since = int(time.time() - days * 86400)
            extra = self.leaderboard_detail(out, by, side, since) if out else []
            first = {"id": ids[0], "count": counts[0], "value": round(values[0], 2)} if ids else None
            names = self.names_for([r["id"] for r in out] + extra + ([first["id"]] if first else []))
            for r in out:
                r["name"] = names.get(r["id"])
            if first:
                first["name"] = names.get(first["id"])
            n, total = c.execute("SELECT COUNT(*), COALESCE(SUM(value), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
            return {"side": side, "by": by, "metric": metric, "days": days, "offset": offset, "limit": limit, "q": text,
                    "entities": len(ids), "matched": len(idx), "first": first,
                    "side_total": {"count": int(sum(counts)), "value": round(sum(values), 2)},
                    "total": {"count": n, "value": round(total, 2)}, "rows": out,
                    "names": {str(i): names[i] for i in extra if names.get(i)}}
        return self.cached(("lbp", days, side, by, metric, offset, limit, text), run, force)

    # 完整排行榜的附加数据：另一侧的击杀 / 损失、最近所属军团与联盟、最常用 / 最常损失的舰船
    def leaderboard_detail(self, out, by, side, since):
        vcol, acol = ENTITY_COL[by]
        c = self.store.conn()
        ids = [r["id"] for r in out]
        marks = ",".join("?" * len(ids))
        kills = {eid: (n, v) for eid, n, v in c.execute(
            f"""SELECT eid, COUNT(*), SUM(value) FROM (
                  SELECT DISTINCT a.km, a.{acol} AS eid, k.value FROM attackers a JOIN killmails k ON k.id = a.km
                  WHERE a.{acol} IN ({marks}) AND a.time >= ?) GROUP BY eid""", (*ids, since))}
        losses = {eid: (n, v) for eid, n, v in c.execute(
            f"SELECT {vcol}, COUNT(*), SUM(value) FROM killmails WHERE {vcol} IN ({marks}) AND time >= ? GROUP BY {vcol}", (*ids, since))}
        # 最近一次出现时的所属（受害者与攻击者两边取较晚的一条；SQLite 的 MAX() 聚合会带出同一行的其它列）
        aff = {}
        if by != "alliance":
            up = ("v_corp", "v_alliance", "corp", "alliance") if by == "character" else (None, "v_alliance", None, "alliance")
            vsel = ", ".join(x or "NULL" for x in up[:2])
            asel = ", ".join(x or "NULL" for x in up[2:])
            for eid, corp, ally, t in c.execute(f"SELECT {vcol}, {vsel}, MAX(time) FROM killmails WHERE {vcol} IN ({marks}) AND time >= ? GROUP BY {vcol}", (*ids, since)):
                aff[eid] = (t, corp, ally)
            for eid, corp, ally, t in c.execute(f"SELECT {acol}, {asel}, MAX(time) FROM attackers WHERE {acol} IN ({marks}) AND time >= ? GROUP BY {acol}", (*ids, since)):
                if eid not in aff or t > aff[eid][0]:
                    aff[eid] = (t, corp, ally)
        # 排行这一侧最常见的舰船：损失榜看损失的舰船，击杀榜看攻击时驾驶的舰船（太空舱除外）
        if side == "losses":
            ship_sql = f"SELECT {vcol}, ship_type, COUNT(*) n FROM killmails WHERE {vcol} IN ({marks}) AND time >= ? AND ship_type NOT IN (670, 33328) GROUP BY {vcol}, ship_type"
        else:
            ship_sql = f"SELECT {acol}, ship, COUNT(DISTINCT km) n FROM attackers WHERE {acol} IN ({marks}) AND time >= ? AND ship IS NOT NULL AND ship NOT IN (0, 670, 33328) GROUP BY {acol}, ship"
        ships = {}
        for eid, ship, n in c.execute(ship_sql, (*ids, since)):
            ships.setdefault(eid, []).append((n, ship))
        extra = set()
        for r in out:
            k, l = kills.get(r["id"], (0, 0)), losses.get(r["id"], (0, 0))
            r.update(kills=k[0], destroyed=round(k[1] or 0, 2), losses=l[0], lost=round(l[1] or 0, 2))
            if r["id"] in aff:
                _, corp, ally = aff[r["id"]]
                if corp:
                    r["corporation_id"] = corp
                    extra.add(corp)
                if ally:
                    r["alliance_id"] = ally
                    extra.add(ally)
            top = sorted(ships.get(r["id"], []), reverse=True)[:3]
            if top:
                r["ships"] = [{"ship_type_id": t, "count": n} for n, t in top]
        return list(extra)

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
    # ---- 阵亡装配
    @staticmethod
    def extract_fit(km):
        groups = {}
        for it in km["victim"].get("items") or []:
            flag = it.get("flag")
            slot = next((name for name, flags in FIT_FLAGS if flag in flags), None)
            if not slot:
                continue
            qty = (it.get("quantity_destroyed") or 0) + (it.get("quantity_dropped") or 0)
            g = groups.setdefault(slot, {})
            g[it["item_type_id"]] = g.get(it["item_type_id"], 0) + qty
        return {k: sorted([t, n] for t, n in v.items()) for k, v in groups.items()}

    def shipfits(self, q):
        ship = int(q["ship"])
        days = max(1, min(int(q.get("days", 7)), self.store.retention))
        return self.cached(f"shipfits:{ship}:{days}", lambda: self._shipfits(ship, days))

    def _shipfits(self, ship, days):
        since = int(time.time() - days * 86400)
        conn = self.store.conn()
        total = conn.execute("SELECT COUNT(*) FROM killmails WHERE ship_type=? AND time>=?", (ship, since)).fetchone()[0]
        rows = conn.execute("SELECT id, hash, time, value FROM killmails WHERE ship_type=? AND time>=? ORDER BY time DESC LIMIT ?",
                            (ship, since, SHIPFIT_MAX)).fetchall()
        have = {}
        if rows:
            ids = [r[0] for r in rows]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for kid, fit in conn.execute(f"SELECT id, fit FROM km_fits WHERE id IN ({','.join('?' * len(chunk))})", chunk):
                    have[kid] = json.loads(fit)
        todo = [r for r in rows if r[0] not in have and r[1]]

        def fetch(row):
            try:
                km, _ = get_json(f"{ESI}/killmails/{row[0]}/{row[1]}/", timeout=20, retries=2)
                return row, self.extract_fit(km)
            except Exception:
                return row, None
        if todo:
            with concurrent.futures.ThreadPoolExecutor(SHIPFIT_WORKERS) as pool:
                fetched = [x for x in pool.map(fetch, todo) if x[1] is not None]
            with self.store.write_lock:
                c = self.store.conn()
                c.executemany("INSERT OR REPLACE INTO km_fits(id, ship, time, fit) VALUES(?,?,?,?)",
                              [(row[0], ship, row[2], json.dumps(fit, separators=(",", ":"))) for row, fit in fetched])
                c.commit()
            for row, fit in fetched:
                have[row[0]] = fit
        # 相同装配合并（只看槽位里的装备与弹药、无人机；货柜舱不计）
        groups = {}
        for kid, _, t, value in rows:
            fit = have.get(kid)
            if not fit or not any(fit.get(s) for s in ("high", "mid", "low", "rig", "sub")):
                continue
            key = json.dumps(fit, sort_keys=True)
            g = groups.setdefault(key, {"fit": fit, "n": 0, "last": 0, "value": 0.0, "ids": []})
            g["n"] += 1
            g["value"] += value or 0
            g["last"] = max(g["last"], t)
            if len(g["ids"]) < 5:
                g["ids"].append(kid)
        fits = sorted(groups.values(), key=lambda g: (-g["n"], -g["last"]))
        for g in fits:
            g["value"] = round(g["value"] / g["n"])
        return {"ship": ship, "days": days, "total": total, "scanned": len(rows), "fits": fits}

    # 开放接口 GET /api/v1/prices?types=&hub=：最低卖价、最高收购价、全服均价与本站估价
    # hub 默认吉他；可选四族贸易中心所在星域 ID（10000043 艾玛 / 10000032 多迪谢 / 10000030 伦斯 / 10000042 赫克）或 all（全宇宙）
    def prices(self, q):
        ids = [int(x) for x in str(q.get("types", "")).split(",") if x.strip().isdigit()]
        if not ids:
            raise ValueError("缺少 types")
        if len(ids) > PRICE_MAX_TYPES:
            raise ValueError(f"types 最多 {PRICE_MAX_TYPES} 个")
        hub = str(q.get("hub") or FORGE)
        hub = 0 if hub == "all" else int(hub) if hub.isdigit() else -1
        if hub != 0 and hub not in HUB_STATIONS:
            raise ValueError("hub 只能是 all 或 " + " / ".join(map(str, HUB_STATIONS)))
        table = None if hub == FORGE else self.store.hub_prices.get(hub, {})
        out = {}
        for t in dict.fromkeys(ids):
            sell, buy, avg = self.store.prices.get(t) or (None, None, None)
            if table is not None:
                sell, buy = table.get(t) or (None, None)
            est = self.store.price(t)
            out[str(t)] = {"sell": sell, "buy": buy, "average": round(avg, 2) if avg else None, "estimate": round(est, 2) if est else None}
        updated = self.store.state.get("prices_updated" if table is None else "hub_prices_updated")
        return {"hub": "all" if hub == 0 else hub, "updated": updated, "types": out}

    def couriers(self, q):
        """全服公开快递合同（EVE Ref 快照，约 30 分钟更新）；服务刚启动还没读到快照时 list 为空、at 为 null"""
        return self.store.couriers

    def bpprices(self, q):
        data = self.store.bp_contracts
        updated = self.store.state.get("bp_contracts_updated")
        if q.get("types"):
            ids = [int(x) for x in q["types"].split(",") if x.strip().isdigit()][:BP_MAX_TYPES]
            return {"updated": updated, "types": {str(t): data[t] for t in ids if t in data}}
        # 全部蓝图的最低价（利润排行用）
        return {"updated": updated, "all": {str(t): [v["o"][0][0] if v["o"] else None, v["c"][0][0] if v["c"] else None] for t, v in data.items()}}

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
                if q.get("_local"):   # 开放接口只查保留期内的击杀
                    raise KeyError(kid)
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


# ---------------------------------------------------------------- 制造计算（开放接口用，公式与前端 js/industry.js 一致，技能按全 5 级）
IND_FACILITIES = {   # 名称 -> (建筑类型, 材料效率 %, 时间效率 %, 安装费减免 %, 活动)
    "npc": (None, 0, 0, 0, "m"), "raitaru": (35825, 1, 15, 3, "m"), "azbel": (35826, 1, 20, 4, "m"), "sotiyo": (35827, 1, 30, 5, "m"),
    "athanor": (35835, 0, 0, 0, "r"), "tatara": (35836, 0, 25, 0, "r"),
}
IND_RIGS = [(0, 0), (2, 20), (2.4, 24)]   # 无 / T1 / T2 改装件：材料效率 %、时间效率 %
IND_SCC = 4                # SCC 附加费 %
IND_NPC_TAX = 0.25         # NPC 空间站设施税 %
IND_SALES_TAX = 7.5 * (1 - 0.11 * 5)   # 销售税 %（会计学 5 级）
IND_BROKER = 3 - 0.3 * 5               # 中介费 %（中介关系学 5 级）
IND_RANK_METAS = {0, 1, 2, 14, 53, 54}
IND_CATS = {"ship": [6], "module": [7, 32], "charge": [8], "drone": [18, 87], "component": [17, 4], "structure": [65, 66, 22, 39, 40, 46], "implant": [20]}
IND_INDEX_TTL = 3600
JITA_SYSTEM = 30000142
IND_SYSTEM_ALIASES = {"jita": 30000142, "perimeter": 30000144, "amarr": 30002187, "dodixie": 30002659, "rens": 30002510, "hek": 30002053}   # 星图数据只有中文名


class Industry:
    def __init__(self, store, dirs):
        self.store, self.dirs = store, dirs
        self.data = self.systems = self.regions = None
        self.indices, self.indices_at, self.lock = {}, 0, threading.Lock()
        self.rank_cache = {}

    def _load(self, name):
        for d in self.dirs:
            path = os.path.join(d, name) if d else None
            if path and os.path.isfile(path):
                with open(path, encoding="utf-8") as fh:
                    return json.load(fh)
        raise RuntimeError(f"找不到 {name}（用 --industry-dir 指定前端目录）")

    def ensure(self):
        with self.lock:
            if self.data is None:
                d = self._load("industry-data.json")
                self.data = {"bp": {int(k): v for k, v in d["bp"].items()}, "inv": {int(k): v for k, v in d["inv"].items()},
                             "types": {int(k): v for k, v in d["types"].items()}, "groups": {int(k): v for k, v in d["groups"].items()},
                             "decryptors": {int(k): v for k, v in d["decryptors"].items()}}
                m = self._load("map-data.json")
                self.systems = {x[0]: {"name": x[1], "sec": x[5], "region": x[6]} for x in m["systems"]}
                self.sys_by_name = {x[1].lower(): x[0] for x in m["systems"]}
                self.regions = {r[0]: r[1] for r in m["regions"]}
            if time.time() - self.indices_at > IND_INDEX_TTL:
                try:
                    rows, _ = get_json(f"{ESI}/industry/systems/")
                    self.indices = {r["solar_system_id"]: {c["activity"]: c["cost_index"] for c in r["cost_indices"]} for r in rows}
                    self.indices_at = time.time()
                    self.rank_cache.clear()
                except Exception as e:
                    log.warning("成本指数获取失败：%s", e)
                    self.indices_at = time.time() - IND_INDEX_TTL + 300   # 5 分钟后再试
            if not self.store.adjusted:
                try:
                    rows, _ = get_json(f"{ESI}/markets/prices/")
                    self.store.adjusted = {x["type_id"]: x["adjusted_price"] for x in rows if x.get("adjusted_price")}
                except Exception as e:
                    log.warning("调整价格获取失败：%s", e)

    # ---- 基础
    def name(self, tid):
        t = self.data["types"].get(tid)
        return {"id": tid, "name": t[0] if t else None, "name_en": t[1] if t else None}

    def category(self, tid):
        t = self.data["types"].get(tid)
        return self.data["groups"].get(t[2], [None, 0])[1] if t else 0

    def price(self, tid, side="sell"):
        sell, buy, avg = self.store.prices.get(tid) or (None, None, None)
        v = buy if side == "buy" else sell
        return v if v is not None else sell if sell is not None else buy if buy is not None else avg

    def system(self, value):
        if value in (None, ""):
            return JITA_SYSTEM
        v = str(value).strip()
        sid = int(v) if v.isdigit() else self.sys_by_name.get(v.lower()) or IND_SYSTEM_ALIASES.get(v.lower())
        if sid not in self.systems:
            raise ValueError(f"未知星系：{value}")
        return sid

    def product(self, value):
        if value in (None, ""):
            raise ValueError("缺少 product")
        v = str(value).strip()
        if v.isdigit() and int(v) in self.data["bp"]:
            return int(v)
        if v.isdigit():
            # 也可以传蓝图 ID
            for pid, b in self.data["bp"].items():
                if b[0] == int(v):
                    return pid
            raise KeyError(v)
        low = v.lower()
        for pid in self.data["bp"]:
            t = self.data["types"].get(pid)
            if t and (t[0].lower() == low or t[1].lower() == low):
                return pid
        raise KeyError(v)

    def settings(self, q, act):
        fac_name = (q.get("facility") or "").lower()
        if fac_name and fac_name not in IND_FACILITIES:
            raise ValueError("facility 只能是 " + " / ".join(IND_FACILITIES))
        fac = IND_FACILITIES.get(fac_name) or IND_FACILITIES["npc" if act == "m" else "tatara"]
        if not fac_name or fac[4] != act:   # 没指定或设施做不了这种活动时用默认：制造 NPC 空间站，反应塔塔拉
            fac_name, fac = ("npc", IND_FACILITIES["npc"]) if act == "m" else ("tatara", IND_FACILITIES["tatara"])
        rig = int(q.get("rig", 0))
        if rig not in (0, 1, 2):
            raise ValueError("rig 只能是 0 / 1 / 2")
        if fac_name == "npc":
            rig = 0
        tax = float(q["tax"]) if q.get("tax") not in (None, "") else (IND_NPC_TAX if fac_name == "npc" else 1.0)
        return {"facility": fac_name, "fac": fac, "rig": rig, "tax": tax}

    def job(self, pid, runs, me, te, sid, st):
        _, qty, base_time, mats, _, act = self.data["bp"][pid][:6]
        fac, (rig_me, rig_te) = st["fac"], IND_RIGS[st["rig"]]
        sec = self.systems.get(sid, {}).get("sec", 0.5)
        sm = 1 if sec >= 0.45 else 1.9 if sec > 0 else 2.1   # 改装件加成随安全等级放大
        mul = (1 - fac[1] / 100) * (1 - rig_me * sm / 100)
        items = [{"id": tid, "qty": max(runs, math.ceil(round(base * runs * (1 - me / 100) * mul * 100) / 100))} for tid, base in mats]
        eiv = sum(base * runs * (self.store.adjusted.get(tid) or 0) for tid, base in mats)
        idx = (self.indices.get(sid) or {}).get("reaction" if act == "r" else "manufacturing", 0)
        gross = eiv * idx * (1 - fac[3] / 100)
        taxes = eiv * (st["tax"] + IND_SCC) / 100
        skill = (1 - 0.04 * 5) if act == "r" else (1 - 0.04 * 5) * (1 - 0.03 * 5)
        secs = base_time * runs * (1 - te / 100) * (1 - fac[2] / 100) * (1 - rig_te * sm / 100) * skill
        return {"act": act, "out": qty * runs, "items": items, "eiv": eiv, "index": idx, "gross": gross, "taxes": taxes, "cost": gross + taxes, "secs": secs}

    def invention(self, pid, dec_id, sid, st, mat_side):
        inv = self.data["inv"].get(self.data["bp"][pid][0])
        if not inv:
            return None
        t1bp, base, runs_per, dcs, _, skills = inv
        dec = self.data["decryptors"].get(dec_id, [1, 0, 0, 0]) if dec_id else [1, 0, 0, 0]
        n_enc = sum(1 for tid, _ in skills if "Encryption" in (self.data["types"].get(tid, ["", ""])[1]))
        n_sci = len(skills) - n_enc
        prob = min(1, base * (1 + n_sci * 5 / 30 + n_enc * 5 / 40) * dec[0])
        runs = max(1, runs_per + dec[3])
        eiv = sum(b * (self.store.adjusted.get(tid) or 0) for tid, b in self.data["bp"][pid][3])
        idx = (self.indices.get(sid) or {}).get("invention", 0)
        job_cost = eiv * 0.02 * idx + eiv * 0.02 * (st["tax"] + IND_SCC) / 100
        dc_cost = sum(q * (self.price(tid, mat_side) or 0) for tid, q in dcs)
        dec_cost = (self.price(dec_id, mat_side) or 0) if dec_id else 0
        attempt = dc_cost + dec_cost + job_cost
        return {"t1_blueprint": t1bp, "probability": round(prob, 4), "runs_per_copy": runs, "me": 2 + dec[1], "te": 4 + dec[2],
                "datacores": [{**self.name(tid), "qty": q} for tid, q in dcs], "decryptor": self.name(dec_id) if dec_id else None,
                "cost_per_attempt": round(attempt, 2), "cost_per_run": round(attempt / (prob * runs), 2)}

    # ---- 接口
    def search(self, q):
        self.ensure()
        text = (q.get("q") or "").strip().lower()
        if len(text) < 1:
            raise ValueError("缺少 q")
        out = []
        for pid, b in self.data["bp"].items():
            t = self.data["types"].get(pid)
            if t and (text in t[0].lower() or text in t[1].lower()):
                out.append({**self.name(pid), "blueprint_id": b[0], "activity": "reaction" if b[5] == "r" else "manufacturing",
                            "_rank": (t[0].lower() != text and t[1].lower() != text, len(t[0]))})
        out.sort(key=lambda x: x.pop("_rank"))
        return {"results": out[:30]}

    def blueprint(self, q, pid_value):
        self.ensure()
        pid = self.product(pid_value)
        bpid, qty, t, mats, max_runs, act, skills, on_market = self.data["bp"][pid]
        inv = self.data["inv"].get(bpid)
        return {"product": self.name(pid), "blueprint": self.name(bpid), "activity": "reaction" if act == "r" else "manufacturing",
                "output_per_run": qty, "time_per_run": t, "max_runs": max_runs, "blueprint_on_market": bool(on_market),
                "materials": [{**self.name(tid), "qty": n} for tid, n in mats], "skills": [{**self.name(tid), "level": lv} for tid, lv in skills],
                "invention": {"t1_blueprint": self.name(inv[0]), "base_probability": inv[1], "runs_per_copy": inv[2],
                              "datacores": [{**self.name(tid), "qty": n} for tid, n in inv[3]], "time": inv[4],
                              "skills": [{**self.name(tid), "level": lv} for tid, lv in inv[5]]} if inv else None}

    def cost(self, q):
        self.ensure()
        pid = self.product(q.get("product"))
        b = self.data["bp"][pid]
        act = b[5]
        st = self.settings(q, act)
        sid = self.system(q.get("system"))
        mat_side = "buy" if q.get("materials") == "buy" else "sell"
        sell_side = "buy" if q.get("sell") == "buy" else "sell"
        runs = max(1, min(int(q.get("runs", 1)), 100000))
        dec_id = int(q.get("decryptor") or 0)
        inv = self.invention(pid, dec_id, sid, st, mat_side) if act == "m" and q.get("invention", "1") != "0" else None
        me = 0 if act == "r" else float(q["me"]) if q.get("me") not in (None, "") else inv["me"] if inv else 10
        te = 0 if act == "r" else float(q["te"]) if q.get("te") not in (None, "") else inv["te"] if inv else 20
        if not (0 <= me <= 10 and 0 <= te <= 20):
            raise ValueError("me 范围 0–10，te 范围 0–20")
        j = self.job(pid, runs, me, te, sid, st)
        fee = IND_BROKER if mat_side == "buy" else 0
        mats, missing = [], []
        for it in j["items"]:
            unit = self.price(it["id"], mat_side)
            if unit is None:
                missing.append(it["id"])
            mats.append({**self.name(it["id"]), "qty": it["qty"], "unit_price": unit, "total": round((unit or 0) * it["qty"] * (1 + fee / 100), 2)})
        mat_cost = sum(m["total"] for m in mats)
        # 蓝图：能发明的计发明成本；市场买不到原图、合同有拷贝的按合同拷贝每流程单价
        bpc = (self.store.bp_contracts.get(b[0]) or {}).get("c") or []
        bp_cost = bpc[0][0] * runs if not inv and not b[7] and bpc else 0
        inv_cost = inv["cost_per_run"] * runs if inv else 0
        total = mat_cost + j["cost"] + inv_cost + bp_cost
        unit_price = self.price(pid, sell_side)
        sell_fee = IND_SALES_TAX + (IND_BROKER if sell_side == "sell" else 0)
        revenue = (unit_price or 0) * j["out"] * (1 - sell_fee / 100)
        sysinfo = self.systems[sid]
        return {
            "product": self.name(pid), "activity": "reaction" if act == "r" else "manufacturing", "runs": runs, "output": j["out"], "me": me, "te": te,
            "system": {"id": sid, "name": sysinfo["name"], "security": round(sysinfo["sec"], 2), "cost_index": j["index"]},
            "facility": st["facility"], "rig": st["rig"], "facility_tax": st["tax"], "prices": {"materials": mat_side, "product": sell_side, "updated": self.store.state.get("prices_updated")},
            "materials": mats, "missing_prices": missing,
            "material_cost": round(mat_cost, 2), "job_cost": round(j["cost"], 2), "eiv": round(j["eiv"], 2),
            "invention": inv, "invention_cost": round(inv_cost, 2), "blueprint_cost": round(bp_cost, 2),
            "total_cost": round(total, 2), "cost_per_unit": round(total / j["out"], 2),
            "product_price": unit_price, "sales_fees_percent": round(sell_fee, 2), "revenue": round(revenue, 2),
            "profit": round(revenue - total, 2), "margin": round((revenue - total) / revenue, 4) if revenue else None,
            "time_seconds": round(j["secs"]), "profit_per_hour": round((revenue - total) / (j["secs"] / 3600), 2) if j["secs"] else None,
        }

    def profits(self, q):
        self.ensure()
        act = "r" if q.get("activity") == "reaction" else "m"
        cat = q.get("category") or "all"
        if cat != "all" and cat not in IND_CATS:
            raise ValueError("category 只能是 all / " + " / ".join(IND_CATS))
        tech = q.get("tech") or "all"
        sort = q.get("sort") if q.get("sort") in ("profit_per_hour", "profit", "margin") else "profit_per_hour"
        limit = max(1, min(int(q.get("limit", 50)), 200))
        sid = self.system(q.get("system"))
        st = self.settings(q, act)
        liquid = q.get("liquid", "1") != "0"
        key = (act, cat, tech, sort, sid, st["facility"], st["rig"], st["tax"], liquid, self.store.state.get("prices_updated"))
        hit = self.rank_cache.get(key)
        if not hit or time.time() - hit[0] > CACHE_TTL:
            rows = []
            cats = IND_CATS.get(cat)
            for pid, b in self.data["bp"].items():
                if b[5] != act:
                    continue
                t = self.data["types"].get(pid)
                if not t or (cats and self.category(pid) not in cats) or (tech != "all" and str(t[3]) != tech):
                    continue
                inv_ok = b[0] in self.data["inv"]
                bpc = (self.store.bp_contracts.get(b[0]) or {}).get("c") or []
                need_bpc = not b[7] and not inv_ok
                if (not bpc) if need_bpc else t[4] not in IND_RANK_METAS:
                    continue
                unit = self.price(pid)
                if not unit:
                    continue
                sell, buy, _ = self.store.prices.get(pid) or (None, None, None)
                adj = self.store.adjusted.get(pid)
                if sell is None and buy is None and adj and unit > adj * 6 and unit - adj > 1e6:
                    continue
                # 有价无市：吉他要同时有卖单和收单，且卖价不超过收价 3 倍
                if liquid and (sell is None or buy is None or sell > buy * 3):
                    continue
                if any(self.price(tid) is None for tid, _ in b[3]):
                    continue
                inv = self.invention(pid, 0, sid, st, "sell") if act == "m" else None
                me, te = (0, 0) if act == "r" else (inv["me"], inv["te"]) if inv else (10, 20)
                j = self.job(pid, 1, me, te, sid, st)
                mats = sum(it["qty"] * self.price(it["id"]) for it in j["items"])
                cost = mats + j["cost"] + (inv["cost_per_run"] if inv else 0) + (bpc[0][0] if need_bpc else 0)
                revenue = unit * j["out"] * (1 - (IND_SALES_TAX + IND_BROKER) / 100)
                profit = revenue - cost
                if revenue and profit / revenue > 0.9:   # 利润率过高的多是有价无市
                    continue
                rows.append({**self.name(pid), "output": j["out"], "unit_price": unit, "cost": round(cost, 2), "profit": round(profit, 2),
                             "margin": round(profit / revenue, 4) if revenue else 0, "time_seconds": round(j["secs"]),
                             "profit_per_hour": round(profit / (j["secs"] / 3600), 2) if j["secs"] else 0, "invention": bool(inv), "contract_bpc": need_bpc})
            rows.sort(key=lambda r: r[sort], reverse=True)
            hit = (time.time(), rows)
            self.rank_cache[key] = hit
            while len(self.rank_cache) > 50:
                self.rank_cache.pop(next(iter(self.rank_cache)))
        return {"activity": "reaction" if act == "r" else "manufacturing", "system": sid, "facility": st["facility"], "rig": st["rig"],
                "sort": sort, "liquid": liquid, "total": len(hit[1]), "rows": hit[1][:limit]}

    def cost_indices(self, q):
        self.ensure()
        activity = q.get("activity") or "manufacturing"
        acts = ("manufacturing", "invention", "reaction", "copying", "researching_material_efficiency", "researching_time_efficiency")
        if activity not in acts:
            raise ValueError("activity 只能是 " + " / ".join(acts))
        secs = set((q.get("security") or "high,low,null").split(","))
        region = int(q["region"]) if q.get("region") else None
        limit = max(1, min(int(q.get("limit", 50)), 500))
        cls = lambda sec: "high" if sec >= 0.45 else "low" if sec > 0 else "null"
        rows = []
        for sid, idx in self.indices.items():
            s = self.systems.get(sid)
            if not s or cls(s["sec"]) not in secs or (region and s["region"] != region) or (activity == "reaction" and cls(s["sec"]) == "high"):
                continue
            rows.append({"id": sid, "name": s["name"], "security": round(s["sec"], 2), "region_id": s["region"], "region": self.regions.get(s["region"]),
                         "cost_index": idx.get(activity, 0), "indices": idx})
        rows.sort(key=lambda r: r["cost_index"])
        return {"activity": activity, "total": len(rows), "systems": rows[:limit]}


# ---------------------------------------------------------------- 深渊装备估价
class Abyssal:
    """MutaMarket 深渊装备估价代理：每个深渊类型一个随机森林模型（真实单件合同成交价训练），按 item_id 估价。
    GET 只读本站缓存 / 对方已有的装备；POST 会让对方从 ESI 导入 / 刷新这件装备（对方公开页面会出现它），只在用户点击时调用。"""

    def __init__(self, store):
        self.store = store
        self.sem = threading.Semaphore(2)            # 同时最多 2 个上游请求
        self.lock = threading.Lock()
        self.inflight = {}                           # item_id -> Event，合并同一件的并发请求
        self.models_at, self.models_map = 0, {}
        self.missing = collections.OrderedDict()     # 对方没有的 item_id -> 时间（10 分钟内不重复问）
        self.lists = collections.OrderedDict()       # 上游路径 -> (时间, 结果)
        self.types_at, self.types_list = 0, []

    @staticmethod
    def check_server(server):
        if (server or "tq") != "tq":
            raise ValueError("深渊估价只支持宁静服（MutaMarket 的价格来自宁静服合同）")

    def upstream(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/json"}
        if data:
            headers["Content-Type"] = "application/json"
        with self.sem:
            try:
                raw, _ = http_get(MUTA_API + path, timeout=30, data=data, headers=headers)
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = json.loads(e.read() or b"{}").get("message") or ""
                except Exception:
                    pass
                if e.code == 404:
                    raise KeyError("MutaMarket 还没有这件装备")
                if e.code in (400, 422):
                    raise ValueError("MutaMarket 无法导入这件装备" + (f"：{detail}" if detail else "（物品链接无效或 ESI 读不到）"))
                if e.code == 429:
                    raise RuntimeError("MutaMarket 请求过于频繁，请稍后再试")
                raise RuntimeError(f"MutaMarket 暂不可用（HTTP {e.code}）")
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError("MutaMarket 暂不可用（连接超时）")
        return json.loads(raw)

    def model_stats(self):
        now = time.time()
        if now - self.models_at > ABYSSAL_MODELS_TTL or not self.models_map:
            try:
                rows = self.upstream("/estimator-statistics")
                self.models_map = {r["type_id"]: {"data_count": r.get("data_count"), "r2": r.get("r2"), "mae": r.get("mae"),
                                                  "nmae": r.get("nmae"), "last_trained_at": r.get("last_trained_at")} for r in rows if r.get("type_id")}
                self.models_at = now
            except Exception:
                if not self.models_map:
                    raise
                self.models_at = now - ABYSSAL_MODELS_TTL + 600   # 失败时沿用旧数据，10 分钟后再试
        return self.models_map

    def normalize(self, d):
        value = d.get("estimated_value")
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            value = None
        try:
            model = self.model_stats().get(d["type"]["id"])
        except Exception:
            model = None
        c = d.get("contract") or None
        ref = lambda x: {"id": x.get("id"), "name": x.get("name")} if x else None
        num = lambda v: v if isinstance(v, (int, float)) and math.isfinite(v) else None
        return {
            "v": 2,
            "item_id": d["id"], "type_id": d["type"]["id"], "type_name": d["type"].get("name"),
            "source_type": {"id": (d.get("source_type") or {}).get("id"), "name": (d.get("source_type") or {}).get("name"),
                            "meta_group": (d.get("source_type") or {}).get("meta_group")},
            "creator": ref(d.get("creator")),
            # 各属性在突变质体范围内的平均位置（-1 最差 … 1 最好）
            "average_fraction": num(d.get("average_fraction")),
            # 没有合同、由卖家直接挂在 MutaMarket 上
            "listed": bool(d.get("public_asset")),
            "mutaplasmid": {"id": (d.get("mutaplasmid") or {}).get("id"), "name": (d.get("mutaplasmid") or {}).get("name")},
            "estimated_value": value, "estimated_value_updated_at": d.get("estimated_value_updated_at"),
            # 真实突变属性（派生 / 虚拟属性只供展示，不能当成装备属性）
            # fraction：在本突变质体范围内的位置，-1 最差 … 0 原值 … 1 最好；fraction_type：按整个深渊类型（所有质体）归一化；
            # bar：1 达到该类型最好值（金条）/ 2 荣耀质体上的最好值（钻石）/ -1 最差值（棕条）
            "attributes": [{"id": a.get("id"), "name": a.get("display_name") or a.get("name"), "key": a.get("name"), "value": a.get("value"), "base_value": a.get("base_value"),
                            "unit": (a.get("unit") or {}).get("display_name"), "unit_id": (a.get("unit") or {}).get("id"),
                            "fraction": num(a.get("fraction")), "fraction_type": num(a.get("fraction_type")), "type_band": a.get("type_band"),
                            "bar": a.get("bar") or 0, "derived": bool(a.get("is_derived") or a.get("is_virtual")),
                            "is_derived": bool(a.get("is_derived")), "is_virtual": bool(a.get("is_virtual"))}
                           for a in d.get("mutated_attributes") or []],
            "contract": {"id": c.get("id"), "type": c.get("type"), "price": c.get("price"), "abyssal_modules_count": c.get("abyssal_modules_count"),
                         "non_abyssal_modules_count": c.get("non_abyssal_modules_count"), "plex_count": c.get("plex_count"),
                         "asking_for_items": c.get("asking_for_items"), "issuer": ref(c.get("issuer")),
                         "date_issued": c.get("date_issued"), "date_expired": c.get("date_expired")} if c else None,
            "model": model,
            "source_url": "https://mutamarket.com/modules/" + d["slug"] if d.get("slug") else None,
        }

    def save(self, out):
        now = int(time.time())
        out["fetched_at"] = now
        self.store.conn().execute("INSERT OR REPLACE INTO abyssal(item_id, type_id, data, fetched_at) VALUES(?,?,?,?)",
                                  (out["item_id"], out["type_id"], json.dumps(out, ensure_ascii=False), now))
        self.store.conn().commit()
        return out

    def cached(self, item_id):
        row = self.store.conn().execute("SELECT data, fetched_at FROM abyssal WHERE item_id=?", (item_id,)).fetchone()
        return (json.loads(row[0]), row[1]) if row else (None, 0)

    def once(self, item_id, fn):
        """同一件装备的并发请求只发一次上游"""
        with self.lock:
            ev = self.inflight.get(item_id)
            mine = ev is None
            if mine:
                ev = self.inflight[item_id] = threading.Event()
        if not mine:
            ev.wait(35)
            hit, _ = self.cached(item_id)
            if hit:
                return hit
        try:
            return fn()
        finally:
            if mine:
                with self.lock:
                    self.inflight.pop(item_id, None)
                ev.set()

    def module(self, q, item_id):
        """GET /api/v1/abyssal/modules/{item_id}：本站缓存或对方已有的结果；对方没有时 404（不会自动导入）"""
        self.check_server(q.get("server"))
        hit, at = self.cached(item_id)
        if hit and hit.get("v") == 2 and time.time() - at < ABYSSAL_TTL:
            return hit
        miss = self.missing.get(item_id)
        if not hit and miss and time.time() - miss < 600:
            raise KeyError("MutaMarket 还没有这件装备")

        def fetch():
            try:
                return self.save(self.normalize(self.upstream(f"/modules/{item_id}")["data"]))
            except KeyError:
                self.missing[item_id] = time.time()
                while len(self.missing) > 5000:
                    self.missing.popitem(last=False)
                raise
            except RuntimeError:
                if hit:   # 上游不可用时返回旧结果
                    return {**hit, "stale": True}
                raise
        return self.once(item_id, fetch)

    def appraise(self, body):
        """POST /api/v1/abyssal/appraise {type_id, item_id, server}：让对方从 ESI 导入 / 刷新并估价"""
        self.check_server(body.get("server"))
        try:
            type_id, item_id = int(body["type_id"]), int(body["item_id"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("需要 type_id 和 item_id")
        if not (0 < type_id < 2 ** 31 and 0 < item_id < 2 ** 53):
            raise ValueError("物品 ID 超出有效范围")
        hit, at = self.cached(item_id)
        if hit and time.time() - at < 600:   # 10 分钟内刚查过，不重复导入
            return hit
        self.missing.pop(item_id, None)
        return self.once(item_id, lambda: self.save(self.normalize(self.upstream("/modules", {"type_id": type_id, "item_id": item_id})["data"])))

    def models(self, q):
        """GET /api/v1/abyssal/models：各深渊类型的模型质量（训练样本数、R²、平均误差）"""
        return {"models": [{"type_id": k, **v} for k, v in sorted(self.model_stats().items())]}

    def types(self, q):
        """GET /api/v1/abyssal/types：全部深渊类型、各突变属性的最好 / 最差值，以及模型质量"""
        now = time.time()
        if now - self.types_at > ABYSSAL_TYPES_TTL or not self.types_list:
            try:
                rows = self.upstream("/abyssal-type-statistics")
                by = collections.OrderedDict()
                for r in rows:
                    t = r.get("type") or {}
                    e = by.setdefault(r["type_id"], {"id": r["type_id"], "name": t.get("name"), "attributes": []})
                    a = r.get("attribute") or {}
                    e["attributes"].append({"id": r["attribute_id"], "key": a.get("name"), "name": a.get("display_name") or a.get("name"),
                                            "unit": (a.get("unit") or {}).get("display_name"), "unit_id": (a.get("unit") or {}).get("id"),
                                            "high_is_good": bool(r.get("high_is_good")), "best": r.get("best"), "worst": r.get("worst"),
                                            "is_derived": bool(r.get("is_derived")), "is_virtual": bool(r.get("is_virtual"))})
                self.types_list, self.types_at = list(by.values()), now
            except Exception:
                if not self.types_list:
                    raise
                self.types_at = now - ABYSSAL_TYPES_TTL + 600
        try:
            models = self.model_stats()
        except Exception:
            models = {}
        return {"types": [{**t, "model": models.get(t["id"])} for t in self.types_list]}

    @staticmethod
    def list_path(q):
        """把本站的查询参数换成对方的 URL 段（见 mutamarket.com/documentation/api-filtering），逐项校验"""
        try:
            type_id = int(q.get("type", ""))
        except ValueError:
            raise ValueError("需要 type（深渊装备类型 ID）")
        if not 0 < type_id < 2 ** 31:
            raise ValueError("type 无效")
        segs = ["type", str(type_id)]
        sort = q.get("sort") or "price"
        if sort not in ABYSSAL_SORTS and not re.fullmatch(r"\d{1,9}", sort):
            raise ValueError("sort 只能是 price / value / fraction / contract-date / date-added 或属性 ID")
        order = q.get("order") or ("asc" if sort == "price" else "desc")
        if order not in ("asc", "desc"):
            raise ValueError("order 只能是 asc / desc")
        segs += ["sort", sort, order]
        mg = q.get("meta_group")
        if mg:
            if mg not in ABYSSAL_META_GROUPS:
                raise ValueError("meta_group 无效")
            segs += ["meta-group", mg]
        flags = [f for f in (q.get("flags") or "").split(",") if f]
        for f in flags:
            if f not in ABYSSAL_FLAGS:
                raise ValueError(f"不支持的筛选：{f}")
            segs.append(f)
        big = 10 ** 15
        for key, seg in (("price", "contract-price"), ("value", "estimated-value")):
            v = q.get(key)
            if v:
                m = re.fullmatch(r"(\d{1,15})?-(\d{1,15})?", v)
                if not m or not (m.group(1) or m.group(2)):
                    raise ValueError(f"{key} 格式：最小-最大（ISK）")
                segs += [seg, f"{m.group(1) or 0}-{m.group(2) or big}"]
        # attrs=属性ID:最小~最大,...（属性可能为负值，所以范围用 ~ 分隔）
        for part in [p for p in (q.get("attrs") or "").split(",") if p][:12]:
            m = re.fullmatch(r"(\d{1,9}):(-?\d+(?:\.\d+)?)?~(-?\d+(?:\.\d+)?)?", part)
            if not m or (m.group(2) is None and m.group(3) is None):
                raise ValueError("attrs 格式：属性ID:最小~最大")
            segs += ["attributes", m.group(1), f"{m.group(2) if m.group(2) is not None else -big}-{m.group(3) if m.group(3) is not None else big}"]
        path = "/modules/" + "/".join(segs)
        params = {}
        if q.get("region"):
            if not re.fullmatch(r"1\d{7}", q["region"]):
                raise ValueError("region 无效")
            params["region_id"] = q["region"]
        if q.get("cursor"):
            if not re.fullmatch(r"[A-Za-z0-9+/=_-]{1,200}", q["cursor"]):
                raise ValueError("cursor 无效")
            params["cursor"] = q["cursor"]
        return path + ("?" + urllib.parse.urlencode(params) if params else "")

    def list(self, q):
        """GET /api/v1/abyssal/list：某深渊类型在售（合同与直接挂单）的装备，每页 100 件，按 next_cursor 翻页"""
        self.check_server(q.get("server"))
        path = self.list_path(q)
        now = time.time()
        with self.lock:
            hit = self.lists.get(path)
        if hit and now - hit[0] < ABYSSAL_LIST_TTL:
            return hit[1]
        try:
            raw = self.upstream(path)
        except KeyError:
            raise KeyError("没有这个深渊装备类型")
        except RuntimeError:
            if hit:
                return {**hit[1], "stale": True}
            raise
        items = [self.normalize(d) for d in raw.get("data") or []]
        # 顺便存进单件缓存，打开详情不必再问上游
        conn = self.store.conn()
        conn.executemany("INSERT OR REPLACE INTO abyssal(item_id, type_id, data, fetched_at) VALUES(?,?,?,?)",
                         [(x["item_id"], x["type_id"], json.dumps({**x, "fetched_at": int(now)}, ensure_ascii=False), int(now)) for x in items])
        conn.commit()
        out = {"items": items, "next_cursor": (raw.get("meta") or {}).get("next_cursor"), "fetched_at": int(now)}
        with self.lock:
            self.lists[path] = (now, out)
            while len(self.lists) > 300:
                self.lists.popitem(last=False)
        return out


# ---------------------------------------------------------------- 开放接口
class RateLimiter:
    """按 IP 的令牌桶：容量 API_RATE，每秒恢复 API_RATE / 60 个"""
    def __init__(self, rate=API_RATE):
        self.rate, self.buckets, self.lock = rate, {}, threading.Lock()

    def take(self, ip, cost=1):
        now = time.time()
        with self.lock:
            tokens, last = self.buckets.get(ip, (self.rate, now))
            tokens = min(self.rate, tokens + (now - last) * self.rate / 60)
            ok = tokens >= cost
            if ok:
                tokens -= cost
            self.buckets[ip] = (tokens, now)
            if len(self.buckets) > 20000:   # 清掉已经回满的桶
                self.buckets = {k: v for k, v in self.buckets.items() if v[0] + (now - v[1]) * self.rate / 60 < self.rate}
            retry = 0 if ok else int((cost - tokens) * 60 / self.rate) + 1
            return ok, int(tokens), retry


def open_routes(api, industry, abyssal=None):
    """开放接口路由：(路径分段模式, 名称, 处理函数)；{n} 为数字参数，{s} 为字符串参数。文档见 api.html"""
    local = lambda q: {**q, "_local": "1"}

    def entity(q, kind, eid):
        if kind not in ENTITY_COL:
            raise ValueError("kind 只能是 character / corporation / alliance")
        return api.entity(kind, eid, q)

    def bp_prices(q):
        if not q.get("types"):
            raise ValueError("缺少 types")
        return api.bpprices(q)
    return [
        ((), "index", lambda q: {"name": "EVE Market 开放 API", "version": "v1", "docs": "/api.html",
                                 "endpoints": [("/api/v1/" + "/".join(p)).replace("{n}", "{id}").replace("{s}", "{product}" if p[0] == "industry" else "{kind}")
                                               for p, *_ in open_routes(api, industry, abyssal)[1:]]}),
        (("status",), "status", lambda q: {k: v for k, v in api.status(q).items() if k not in ("r2z2_seq",)}),
        (("prices",), "prices", api.prices),
        (("blueprints", "prices"), "bp_prices", bp_prices),
        (("kills",), "kills", lambda q: {k: v for k, v in api.feed(local(q)).items() if k != "notice"}),
        (("kills", "live"), "live", api.live),
        (("kills", "top"), "top", api.top),
        (("kills", "{n}"), "kill", lambda q, kid: api.kill(kid, local(q))),
        (("stats", "summary"), "summary", api.summary),
        (("battles",), "battles", api.battles),
        (("battle-report",), "battle_report", api.br),
        (("leaderboard",), "leaderboard", api.leaderboard),
        (("entities", "{s}", "{n}"), "entity", entity),
        (("search",), "search", api.search),
        (("ships", "{n}", "fits"), "ship_fits", lambda q, ship: api.shipfits({**q, "ship": str(ship)})),
        (("industry", "search"), "industry_search", industry.search),
        (("industry", "blueprints", "{s}"), "industry_blueprint", lambda q, v: industry.blueprint(q, v)),
        (("industry", "cost"), "industry_cost", industry.cost),
        (("industry", "profits"), "industry_profits", industry.profits),
        (("industry", "systems"), "industry_systems", industry.cost_indices),
    ] + ([
        (("abyssal", "modules", "{n}"), "abyssal_module", abyssal.module),
        (("abyssal", "models"), "abyssal_models", abyssal.models),
        (("abyssal", "types"), "abyssal_types", abyssal.types),
        (("abyssal", "list"), "abyssal_list", abyssal.list),
    ] if abyssal else [])


def match_route(routes, parts):
    for pattern, name, fn in routes:
        if len(pattern) != len(parts):
            continue
        args = []
        for want, got in zip(pattern, parts):
            if want == "{n}":
                if not got.isdigit():
                    break
                args.append(int(got))
            elif want == "{s}":
                args.append(got)
            elif want != got:
                break
        else:
            return name, fn, args
    return None, None, None


# ---------------------------------------------------------------- HTTP 服务
def make_handler(api, static_dir, industry, abyssal):
    v1 = open_routes(api, industry, abyssal)
    limiter = RateLimiter()
    post_limiter = RateLimiter(ABYSSAL_POST_RATE)
    routes = {"status": api.status, "live": api.live, "battles": api.battles, "feed": api.feed, "top": api.top, "summary": api.summary,
              "leaderboard": api.leaderboard, "search": api.search, "br": api.br, "bpprices": api.bpprices, "shipfits": api.shipfits, "couriers": api.couriers}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        def send_json(self, code, obj, headers=None):
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
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            # 开放接口的跨域预检
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()

        def client_ip(self):
            # 经 nginx 反代时取 X-Real-IP / X-Forwarded-For
            return (self.headers.get("X-Real-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
                    or self.client_address[0])

        def open_api(self, url):
            parts = [p for p in url.path[len("/api/v1"):].split("/") if p]
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items() if not k.startswith("_")}
            name, fn, args = match_route(v1, parts)
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After"}
            err = lambda code, msg, extra=None: self.send_json(code, {"error": {"code": code, "message": msg}}, {**cors, **(extra or {})})
            if not fn:
                return err(404, "接口不存在，文档见 /api.html")
            ok, left, retry = limiter.take(self.client_ip(), API_COST.get(name, 1))
            cors.update({"X-RateLimit-Limit": str(API_RATE), "X-RateLimit-Remaining": str(left)})
            if not ok:
                return err(429, f"请求过于频繁，请 {retry} 秒后再试", {"Retry-After": str(retry)})
            try:
                return self.send_json(200, fn(q, *args), cors)
            except KeyError as e:
                if name in ("kill", "entity", "industry_blueprint", "industry_cost", "abyssal_module", "abyssal_list"):
                    if name == "abyssal_module":
                        return err(404, str(e.args[0]) if e.args else "MutaMarket 没有这件装备")
                    return err(404, "找不到" + ("该产品的蓝图" if name.startswith("industry") else ""))
                return err(400, f"缺少或无效的参数：{e}")
            except RuntimeError as e:
                return err(503, str(e))
            except ValueError as e:
                return err(400, str(e) or "参数无效")
            except Exception:
                log.exception("开放接口错误 %s", url.path)
                return err(500, "服务器内部错误")

        def do_POST(self):
            # 唯一的写入型开放接口：深渊装备导入 / 刷新估价（转发到 MutaMarket，按 IP 单独限流）
            url = urllib.parse.urlparse(self.path)
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Retry-After"}
            err = lambda code, msg, extra=None: self.send_json(code, {"error": {"code": code, "message": msg}}, {**cors, **(extra or {})})
            if url.path.rstrip("/") != "/api/v1/abyssal/appraise":
                return err(404, "接口不存在，文档见 /api.html")
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 4096:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return err(400, "请求体应为 JSON：{type_id, item_id}")
            ok, left, retry = post_limiter.take(self.client_ip())
            if not ok:
                return err(429, f"查询太频繁，请 {retry} 秒后再试", {"Retry-After": str(retry)})
            try:
                return self.send_json(200, abyssal.appraise(body), cors)
            except KeyError as e:
                return err(404, str(e.args[0]) if e.args else "MutaMarket 没有这件装备")
            except ValueError as e:
                return err(400, str(e))
            except RuntimeError as e:
                return err(503, str(e))
            except Exception:
                log.exception("深渊估价错误")
                return err(500, "服务器内部错误")

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if url.path == "/api/v1" or url.path.startswith("/api/v1/"):
                return self.open_api(url)
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
    parser.add_argument("--industry-dir", help="制造接口读取 industry-data.json / map-data.json 的目录（默认依次找 --static、仓库前端目录、/opt/eve/dist）")
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
    here = os.path.dirname(os.path.abspath(__file__))
    industry = Industry(store, [args.industry_dir, args.static, os.path.dirname(here), "/opt/eve/dist"])
    abyssal = Abyssal(store)
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(api, args.static, industry, abyssal))
    log.info("击杀记录服务已启动 http://%s:%d", args.bind, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
