#!/usr/bin/env python3
"""击杀记录（KB）后端服务：收录新伊甸全部击杀邮件，按吉他中间价估值，提供列表 / 排行 / 统计接口。

数据来源
  - 历史：EVE Ref 每日击杀存档 https://data.everef.net/killmails/（完整 ESI 击杀邮件，每天约 1.4 万条）
  - 实时：zKillboard R2Z2 顺序推送（RedisQ 已于 2026-05-31 停用）；不可用时轮询 zKillboard 各星域最新击杀
  - 价格：ESI 伏尔戈市场全量订单，取吉他 4-4 最低卖价与最高收购价的中间值
  - 旗舰等吉他没有卖单的物品：每 6 小时扫描全服公开合同，取扣除附带物品市场价后的最低价（合同价变化时重算相关历史击杀）
  - 国服（晨曦 / 曙光）：CEVE 市场 KM 广播队列 + 网易 ESI 击杀原文，各服一个库，从接入起累计（没有历史存档与 zKillboard）；
    估值用各自主贸易中心空间站的中间价（见 CN_KB）

接口（除钱包存档外只读，仅监听 127.0.0.1，由 nginx 反代 /api/kb/）
  GET /api/kb/status                          数据覆盖范围与运行状态
  GET /api/kb/feed?cursor=&limit=&ship=&system=&region=&character=&corporation=&alliance=&side=
                                              击杀列表（最新在前）；side=kills|losses|all
                                              本地只保留 --days 天；带筛选条件时翻完本地记录后自动改为实时查询 zKillboard（不入库）
  GET /api/kb/live?after=N                    实时收录的新击杀（星图闪烁 / 弹幕），返回新的游标
  GET /api/kb/br?systems=1,2&start=T&end=T     战场统计：指定星系与时间段（Unix 秒）内的全部玩家击杀及攻击者（前端按联盟分阵营统计）
  GET /api/kb/battles?window=60&min=20        疑似会战：时间窗（分钟）内同一星系被击毁舰船数 ≥ min（不含太空舱与 1000 万 ISK 以下的击杀）
  GET /api/kb/battles/history?days=30         最近 N 天全部疑似会战，含双方阵营划分、损失 / 击毁与战损比（缓存 10 分钟）
  GET /api/kb/top?days=7&limit=8              指定天数内价值最高的损失
  GET /api/kb/summary?hours=24                指定小时内的总损失（含每小时分布）
  GET /api/kb/leaderboard?days=30&side=losses|kills&by=character|corporation|alliance&metric=value|count
  GET /api/kb/search?q=                       搜索人物 / 军团 / 联盟
  GET /api/kb/entity/<kind>/<id>?days=30      人物 / 军团 / 联盟统计（含成员明细）
  GET /api/kb/kill/<id>                       击杀邮件详情与逐项估价（原文按需取自 ESI，本地不保存）
  GET /api/kb/shipfits?ship=ID&days=7[&limit=N][&kills=ID,…] 某型舰船最近 N 天（≤ 保留期）阵亡时的装配，相同装配合并计数（物品原文按需取自 ESI，提取结果存库）
  GET /api/kb/bazaar?page=&order=activity|created&q=   官方论坛角色交易版块（宁静服）帖子列表 / 搜索（代理，缓存 2 分钟）
  GET /api/kb/bazaar/topic?id=                帖子详情（全部楼层，最多 200 层）
  GET /api/kb/bazaar/translate?id=            帖子各楼层的中文机器翻译（Google 翻译，按原文缓存）
  GET /api/kb/bazaar/skills?id=               卖家贴的 qsna.eu 技能展示（技能 ID、等级、技能点）
  GET /api/kb/bazaar/cbg                      晨曦：网易藏宝阁在售与公示期角色（缓存 10 分钟）
  GET /api/kb/bazaar/cbg/detail?id=           藏宝阁角色详情：技能、钱包、安全等级、军团历史、舰船与装配
  GET /api/kb/bazaar/skillset                 宁静：索引里各帖技能展示角色的技能等级（列表按「能开什么船 / 技能几级」筛选）
  GET /api/kb/bazaar/cbg/skillset             晨曦：藏宝阁各角色的技能等级（后台每 10 分钟补齐）
                                              order=sp|price|ratio（&dir=asc）时列表来自后台索引：近期帖子的 1 楼里解析出的技能点 / 报价
  GET /api/kb/bpprices?types=1,2               公开合同里的蓝图价格：原图最低价、拷贝每流程最低价（各取最便宜 5 份）；
                                               不带 types 时返回全部蓝图的 [原图最低价, 拷贝每流程最低价]
                                               数据来自 EVE Ref 公开合同快照 https://data.everef.net/public-contracts/（每 30 分钟刷新）
  GET /api/kb/contracts?status=open|done|expired|repost|ended|all&type=&region=&item=&side=want&q=&issuer=&min=&max=&since=&sort=&order=&limit=&offset=
                                              公开合同存档（EVE Ref 每 30 分钟快照逐份比对）：在售 / 推测成交 / 过期 / 撤单重发；item 只查一种物品时附近 30 天成交单价
  GET /api/kb/contracts/<id>                  存档合同详情与物品
  GET /api/kb/contracts/status                存档进度与各状态数量
  GET /api/kb/couriers                        全服公开快递合同（同一份快照，字段同 ESI /contracts/public/{region_id}/，另带 region_id、start_system_id）
  GET /api/kb/obsvol?server=tq&type=ID&regions=  本站观察成交量：交易中心挂单相邻快照的减少量 / 到期前消失量，按 UTC 日期累计（保留 31 天）
  POST /api/kb/wallet/sync                    钱包成交存档：带浏览器的 ESI 令牌（Authorization），同步并返回某角色某物品的成交 / 税费 / 工业任务
  POST /api/kb/wallet/delete                  删除某角色的全部钱包存档（同样校验令牌）
  击杀相关接口（status / feed / live / br / battles / top / summary / leaderboard / search / entity / kill / shipfits）可带 server=serenity|infinity 查国服

用法
  python3 kb_service.py --db kb.sqlite [--port 8291] [--days 180] [--cn-days 0] [--live auto|r2z2|poll|off] [--static DIR]
  宁静服保留 --days 天（首次启动从 EVE Ref 补齐这么多天，约每天 13 MB）；国服 --cn-days 为 0 时永久保存。
  --static 仅用于本地 / 演示环境：同时托管前端静态文件。
"""

import argparse
import array
import bz2
import calendar
import collections
import concurrent.futures
import csv
import datetime as dt
import email.utils
import gzip
import hashlib
import html as html_lib
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
PILOTS_MAX = 200            # 本地频道名单分析：一次最多查多少名角色
PILOT_CACHE = 20000
# 开放接口不限额度；只有深渊装备导入 / 刷新（POST，会写入 MutaMarket 公开页面）按 IP 限流
# 深渊装备估价：代理 MutaMarket 公开 API（对方不允许浏览器跨域）。只用于宁静服；导入 / 刷新（POST）由用户点击触发、单独限流
MUTA_API = "https://mutamarket.com/api"
ABYSSAL_TTL = 6 * 3600          # 单件估价缓存
ABYSSAL_MODELS_TTL = 24 * 3600  # 各类型模型质量
ABYSSAL_POST_RATE = 10          # 每个 IP 每分钟最多导入 / 刷新次数
ABYSSAL_LIST_TTL = 300          # 在售列表（按筛选条件）缓存
ABYSSAL_TYPES_TTL = 7 * 86400   # 各深渊类型的属性范围（最好 / 最差），对方建议长期缓存
# 本站模型的特征：照搬 MutaMarket（MIT，github.com/MutaMarket/MutaMarket src/estimator/seed.rs）每类深渊装备用的 dogma 属性，
# 已换成属性 ID；他们的派生属性（采集速度等）不进模型
ABYSSAL_FEATURES = {
    47408: (147, 6, 50, 1223, 30, 554, 20),
    47702: (6, 50, 54, 30, 20),
    47732: (6, 50, 54, 105),
    47736: (6, 50, 54),
    47740: (147, 6, 50, 1223, 30, 554, 20),
    47745: (147, 6, 50, 1223, 30, 554, 20),
    47749: (6, 50, 1223, 30, 20),
    47753: (6, 50, 1223, 30, 20),
    47757: (6, 50, 1223, 30, 20),
    47769: (84, 6, 50, 73, 1211, 30),
    47773: (84, 6, 50, 73, 1211, 30),
    47777: (84, 6, 50, 73, 1211, 30),
    47781: (6, 50, 73, 1211, 30, 68),
    47785: (6, 50, 73, 1211, 30, 68),
    47789: (6, 50, 73, 1211, 30, 68),
    47793: (6, 50, 73, 1211, 30, 68),
    47800: (72, 50, 30, 983),
    47804: (72, 50, 30, 983),
    47808: (72, 50, 30, 983),
    47812: (1159, 50, 796, 30),
    47817: (1159, 50, 796, 30),
    47820: (1159, 50, 796, 30),
    47824: (6, 50, 97, 1897, 1896, 2044, 1180, 54, 30),
    47828: (6, 50, 97, 1897, 1896, 2044, 1180, 54, 30),
    47832: (6, 50, 97, 1897, 1896, 2044, 1180, 54, 30),
    47836: (6, 50, 73, 30, 1795, 68),
    47838: (6, 50, 73, 30, 1795, 68),
    47840: (6, 50, 73, 30, 1795, 68),
    47842: (84, 6, 50, 73, 30, 1795),
    47844: (84, 6, 50, 73, 30, 1795),
    47846: (84, 6, 50, 73, 30, 1795),
    48419: (6, 50, 2044, 1180, 54, 30, 90),
    48423: (6, 50, 2044, 1180, 54, 30, 90),
    48427: (6, 50, 2044, 1180, 54, 30, 90),
    48431: (67, 50, 2267, 30),
    48435: (67, 50, 2267, 30),
    48439: (67, 50, 2267, 30),
    49722: (50, 64, 204),
    49726: (50, 64, 204),
    49730: (50, 64, 204),
    49734: (50, 64, 204),
    49738: (847, 50, 1255, 213, 204),
    52227: (267, 268, 269, 270, 50, 271, 272, 273, 274, 974, 975, 976, 977),
    52230: (267, 268, 269, 270, 50, 73, 271, 272, 273, 274, 974, 975, 976, 977),
    56303: (6, 50, 54, 30, 105),
    56304: (6, 50, 54, 30, 105),
    56305: (6, 50, 1223, 30, 20),
    56306: (147, 6, 50, 1223, 30, 554, 20),
    56307: (84, 6, 50, 73, 1211, 30),
    56308: (84, 6, 50, 73, 30, 1795),
    56309: (6, 50, 73, 1211, 30, 68),
    56310: (6, 50, 73, 30, 1795, 68),
    56311: (6, 50, 2044, 1180, 54, 30, 90),
    56312: (6, 50, 97, 1897, 1896, 2044, 1180, 54, 30),
    56313: (50, 30, 2351, 2347, 2346, 2306, 2307, 2353),
    60478: (265, 64, 114, 508, 116, 158, 9, 117, 54, 263, 160, 37),
    60479: (265, 64, 114, 508, 116, 158, 9, 117, 54, 263, 160, 37),
    60480: (265, 64, 114, 508, 116, 158, 9, 117, 54, 263, 160, 37),
    60481: (265, 64, 114, 508, 116, 158, 9, 117, 54, 263, 160, 37),
    60482: (50, 1255, 30),
    60483: (50, 2337, 2335, 2338, 2336, 30),
    78621: (50, 64, 204),
    84434: (6, 50, 73, 114, 99, 30),
    84435: (6, 50, 73, 99, 30, 118),
    84436: (6, 50, 73, 99, 117, 30),
    84437: (6, 50, 73, 99, 116, 30),
    84438: (6, 50, 73, 114, 99, 30),
    84439: (6, 50, 73, 99, 30, 118),
    84440: (6, 50, 73, 99, 117, 30),
    84441: (6, 50, 73, 99, 116, 30),
    84442: (6, 50, 73, 114, 99, 30),
    84443: (6, 50, 73, 99, 30, 118),
    84444: (6, 50, 73, 99, 117, 30),
    84445: (6, 50, 73, 99, 116, 30),
    90460: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90467: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90474: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90483: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90487: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90493: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90498: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90502: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90524: (6, 50, 73, 54, 77, 5969, 5967, 3154, 3153, 30),
    90529: (6, 50, 73, 54, 77, 3154, 3153, 30),
    90593: (6, 50, 73, 54, 77, 3154, 3153, 30),
    90614: (73, 54, 37, 77, 3154, 3153),
    90618: (73, 54, 37, 77, 3154, 3153),
    90621: (73, 54, 37, 77, 3154, 3153),
    90622: (73, 54, 37, 77, 3154, 3153),
    97242: (848, 847, 50, 349, 351, 767),
    97243: (50, 20),
    97244: (848, 847, 50, 349, 351, 767),
    97245: (50, 459),
    97648: (84, 6, 50, 73, 2044, 54, 30),
    97657: (84, 6, 50, 73, 2044, 54, 30),
    97668: (84, 6, 50, 73, 2044, 54, 30),
    97675: (84, 6, 50, 73, 2044, 54, 30),
}
ABYSSAL_MIN_ROWS = 50          # 至少 50 条数据才训练（与 MutaMarket 相同）
ABYSSAL_TRAIN_EVERY = 6 * 3600
ABYSSAL_SORTS = {"price", "value", "fraction", "contract-date", "date-added"}
ABYSSAL_META_GROUPS = {"t1", "t2", "storyline", "faction", "officer", "deadspace"}
ABYSSAL_FLAGS = {"goldbar", "brownbar", "diamondbar", "item-exchange", "auction", "no-multi-item-contracts", "contracts-only", "in-jita", "without-other-items"}
PRICE_MAX_TYPES = 200       # prices 单次最多查询的物品种类
SHIPFIT_MAX = 300           # shipfits：每次最多分析的最近损失数
SHIPFIT_WORKERS = 16        # shipfits：并发向 ESI 取击杀原文
SHIPFIT_KILLS = 60          # shipfits?kills=：最多指定的击杀数
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
ARCHIVE_CACHE = 30          # 保留期以前的查询结果只放内存，缓存的 zKillboard 页数
BR_MAX_SYSTEMS = 30           # 战场统计：最多星系数
BR_MAX_HOURS = 72             # 战场统计：最长时间段
BR_MAX_KILLS = 5000           # 战场统计：最多击杀数
BR_CACHE_KEEP = 50            # 战场统计：内存中保留的查询结果数
BATTLE_CACHE = 5              # 会战结果缓存（秒），前端与实时击杀同为 6 秒轮询
BATTLE_MIN_VALUE = 10_000_000  # 会战只统计价值 ≥ 1000 万 ISK 的击杀（过滤小船 / 诱饵等刷数）
BATTLE_MIN_KILLS = 20           # 历史会战：60 分钟内同一星系击毁 ≥ 20 艘（与实时疑似会战默认口径相同）
BATTLE_GAP = 30 * 60            # 历史会战：同一星系相邻击杀间隔不超过 30 分钟算同一场
BATTLE_HISTORY_CACHE = 600      # 历史会战结果缓存（秒）
# 国服击杀：CEVE 市场的 KM 广播队列（长轮询，约 5 秒无新击杀返回空；id 为队列名，5 分钟没人读就作废），完整击杀邮件读网易 ESI；
# 估值用主贸易中心空间站的最低卖 / 最高收中间价
CN_KB = {
    "serenity": {"queue": "https://beta.ceve-market.org/api/public/kmqueue", "hub": (10000002, 60003760)},
    "infinity": {"queue": "https://inf.ceve-market.org/api/public/kmqueue", "hub": (10000016, 60000843)},
}
CN_PENDING = 5000             # 等待读取原文 / 估值的击杀最多缓存条数
CN_QUEUE_GAP = 1.0            # 两次读队列的最小间隔（秒）：连续有击杀时不长轮询，太快会被 429

log = logging.getLogger("kb")


# ---------------------------------------------------------------- HTTP 工具
def http_get(url, timeout=60, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        body = res.read()
        if res.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body, res.headers


def get_json(url, timeout=60, retries=3, fatal=(400, 404), **kw):
    """fatal：遇到这些 HTTP 状态码不重试，直接抛出（带令牌的 ESI 请求要把 401 / 403 当作结果）"""
    for attempt in range(retries):
        try:
            body, headers = http_get(url, timeout=timeout, **kw)
            return json.loads(body) if body else None, headers
        except urllib.error.HTTPError as e:
            if e.code in fatal:
                raise
            err = e
            if e.code == 429:                   # ESI 限流：按 Retry-After 等待
                time.sleep(min(int(e.headers.get("Retry-After") or 10), 60))
                continue
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


def resolve_names(ids, depth=0, url=None):
    """ESI 批量解析玩家角色 / 军团 / 联盟原名；url：国服用网易 ESI（带 datasource）"""
    try:
        data, _ = get_json(url or f"{ESI}/universe/names/", data=json.dumps(ids).encode(),
                           headers={"Content-Type": "application/json"}, retries=2)
        return data or []
    except urllib.error.HTTPError:
        if len(ids) == 1 or depth > 10:
            return []
        mid = len(ids) // 2
        return resolve_names(ids[:mid], depth + 1, url) + resolve_names(ids[mid:], depth + 1, url)
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
-- 本站深渊估价模型的训练数据：EVE Ref 公开合同快照里只卖一件深渊装备的物品交换合同（attrs 为该件全部 dogma 属性 JSON）；
-- gone = 1：到期前从快照消失（疑似成交），2：到期后消失
CREATE TABLE IF NOT EXISTS abyssal_contracts(contract_id INTEGER PRIMARY KEY, item_id INTEGER, type_id INTEGER, source_type_id INTEGER, mutator_type_id INTEGER,
  price REAL, issued INTEGER, expires INTEGER, first_seen INTEGER, last_seen INTEGER, gone INTEGER DEFAULT 0, attrs TEXT);
CREATE INDEX IF NOT EXISTS abyssal_contracts_type ON abyssal_contracts(type_id);
CREATE INDEX IF NOT EXISTS abyssal_contracts_item ON abyssal_contracts(item_id);
-- ESI 单件突变属性（不会变，永久缓存）
CREATE TABLE IF NOT EXISTS abyssal_dyn(item_id INTEGER PRIMARY KEY, type_id INTEGER, source_type_id INTEGER, mutator_type_id INTEGER, attrs TEXT);
-- 训练好的模型（pickle 的树数组）与交叉验证指标
CREATE TABLE IF NOT EXISTS abyssal_models(type_id INTEGER PRIMARY KEY, model BLOB, stats TEXT, trained_at INTEGER);
-- 阵亡装配：从击杀原文提取的各槽位物品（JSON），供 shipfits 统计常见装配
CREATE TABLE IF NOT EXISTS km_fits(id INTEGER PRIMARY KEY, ship INTEGER, time INTEGER, fit TEXT);
CREATE INDEX IF NOT EXISTS kmfit_ship ON km_fits(ship, time);
"""


class Store:
    def __init__(self, path, system_regions, retention_days, server="tq"):
        self.path = path
        self.server = server                     # tq / serenity / infinity：各服务器一个库，击杀 ID 互不相干
        self.system_regions = system_regions
        self.retention = retention_days          # 0 = 永久保存（国服默认）
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
        if not self.meta("created"):
            self.meta("created", iso(time.time()))
        self.state = {"live_mode": None, "last_live": None, "prices_updated": self.meta("prices_updated"), "hub_prices_updated": self.meta("hub_prices_updated"), "backfill": "等待中"}
        if server != "tq":
            self.state.update(backfill=None, since=self.meta("created"))   # 国服没有历史存档，从接入起累计

    def esi_url(self, path, **params):
        """本服务器的 ESI 地址（国服走网易 ESI，带 datasource）"""
        cfg = ARB_SERVERS[self.server]
        qs = "&".join([*(f"{k}={v}" for k, v in params.items()), *([cfg["qs"]] if cfg["qs"] else [])])
        return f"{cfg['esi']}{path}" + (f"?{qs}" if qs else "")

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
            cutoff = time.time() - self.retention * 86400 if self.retention else 0
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
                    live_att[kid] = ([a["character_id"] for a in players][:500],
                                     list(dict.fromkeys(x for a in players for x in (a.get("corporation_id"), a.get("alliance_id")) if x))[:200])
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
                        self.live_buf.append((self.live_n, {**row_summary(row[:1] + row[2:]), "hash": row[1], "att": live_att.get(row[0], ([], []))[0], "ao": live_att.get(row[0], ([], []))[1]}))
        return added

    def prune(self):
        if not self.retention:
            return
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
    def region_orders(self, rid, handle):
        """逐页读取星域全部订单交给 handle，返回页数"""
        first, headers = get_json(self.store.esi_url(f"/markets/{rid}/orders/", order_type="all", page=1))
        handle(first or [])
        pages = int(headers.get("X-Pages") or 1)

        def page(n):
            data, _ = get_json(self.store.esi_url(f"/markets/{rid}/orders/", order_type="all", page=n))
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
        books = {h: {} for h in HUB_STATIONS}        # 交易中心挂单明细，给倒卖排行用（宁静服不再单独读订单）
        obs = getattr(self.store, "obs", None)
        snap = obs.snapshot("tq") if obs else None   # 本站观察成交量：交易中心挂单快照

        def handle(orders):
            for o in orders:
                t, p = o["type_id"], o["price"]
                h = station_hub.get(o["location_id"])
                if h:
                    HubArbitrage.add_order(books[h], o)
                    if snap:
                        snap.add(o, h)
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
        arb = getattr(self.store, "arb", None)
        # 有交易中心星域没读成功时丢弃本轮快照（保留上一份），否则没读到的订单会被当成消失
        if snap and not set(failed) & set(HUB_STATIONS):
            try:
                obs.commit(snap)
            except Exception:
                log.exception("观察成交量统计失败")
        del snap
        if arb and not set(failed) & set(HUB_STATIONS):
            threading.Thread(target=arb.ingest, args=("tq", books), daemon=True).start()

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
            contracts, times = {}, {}
            for c in rows("contracts.csv"):
                if c["type"] == "courier" and not (c["date_expired"] and epoch(c["date_expired"]) < now):
                    couriers.append(courier_row(c))
                if c["type"] != "item_exchange" or c.get("for_corporation") == "true":
                    continue
                price = float(c["price"] or 0)
                if price <= 0 or (c["date_expired"] and epoch(c["date_expired"]) < now):
                    continue
                contracts[c["contract_id"]] = (price, int(c["system_id"] or 0))
                times[c["contract_id"]] = (int(epoch(c["date_issued"])) if c["date_issued"] else 0, int(epoch(c["date_expired"])) if c["date_expired"] else 0)
            items = collections.defaultdict(list)
            for it in rows("contract_items.csv"):
                if it["contract_id"] in contracts:
                    items[it["contract_id"]].append(it)
            # 本站深渊估价模型的训练数据：只卖一件深渊装备的合同
            model = getattr(self.store, "abyssal_model", None)
            if model:
                single = {}
                for cid, lst in items.items():
                    it = lst[0]
                    if len(lst) == 1 and it["is_included"] == "true" and it["item_id"] and int(it["type_id"] or 0) in ABYSSAL_FEATURES:
                        single[it["item_id"]] = (cid, int(it["type_id"]))
                try:
                    dyn = {d["item_id"]: d for d in rows("contract_dynamic_items.csv") if d["item_id"] in single}
                    attrs = collections.defaultdict(dict)
                    for a in rows("contract_dynamic_items_dogma_attributes.csv"):
                        if a["item_id"] in dyn:
                            attrs[a["item_id"]][a["attribute_id"]] = float(a["value"])
                    batch = []
                    for item_id, d in dyn.items():
                        cid, tid = single[item_id]
                        if attrs.get(item_id):
                            batch.append((int(cid), int(item_id), tid, int(d["source_type_id"] or 0), int(d["mutator_type_id"] or 0),
                                          contracts[cid][0], *times[cid], attrs[item_id]))
                    model.ingest(batch, now)
                except Exception:
                    log.exception("深渊模型训练数据读取失败")
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
            resolved = resolve_names(pending, url=self.store.esi_url("/universe/names/"))
            c = self.store.conn()
            with self.store.write_lock:
                c.executemany("INSERT OR REPLACE INTO names VALUES(?,?,?,?)",
                              [(r["id"], r["name"], r["category"], r["name"].lower()) for r in resolved])
                c.commit()
            for eid in pending:
                self.store.pending_names.discard(eid)
                self.store.known_names.add(eid)


class CnWorkers(Workers):
    """国服（晨曦 / 曙光）：没有历史存档与 zKillboard，只收录接入后 KM 广播队列里的新击杀"""
    def __init__(self, store, queue):
        super().__init__(store, 0, "kmqueue")
        self.queue = queue
        self.pending = collections.deque(maxlen=CN_PENDING)

    def start(self):
        for target in (self.price_loop, self.queue_loop, self.ingest_loop, self.names_loop):
            threading.Thread(target=target, daemon=True).start()

    def refresh_prices(self):
        region, station = CN_KB[self.store.server]["hub"]
        sell, buy = {}, {}

        def handle(orders):
            for o in orders:
                if o["location_id"] != station:
                    continue
                t, p = o["type_id"], o["price"]
                if o["is_buy_order"]:
                    if p > buy.get(t, 0):
                        buy[t] = p
                elif t not in sell or p < sell[t]:
                    sell[t] = p

        pages = self.region_orders(region, handle)
        avg_list, _ = get_json(self.store.esi_url("/markets/prices/"))
        avg = {x["type_id"]: x.get("average_price") or x.get("adjusted_price") for x in avg_list}
        prices = {t: (sell.get(t), buy.get(t), avg.get(t)) for t in set(sell) | set(buy) | set(avg)}
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM prices")
            c.executemany("INSERT INTO prices VALUES(?,?,?,?)", [(t, *v) for t, v in prices.items()])
            c.commit()
        self.store.prices = prices
        stamp = iso(time.time())
        self.store.meta("prices_updated", stamp)
        self.store.state["prices_updated"] = stamp
        log.info("[%s] 价格已更新：%d 页订单，%d 种物品有交易中心行情", self.store.server, pages, len(set(sell) | set(buy)))
        self.prices_ready.set()

    def price_loop(self):
        while True:
            try:
                self.refresh_prices()
            except Exception as e:
                log.warning("[%s] 价格刷新失败：%s", self.store.server, e)
            self.store.prune()
            time.sleep(PRICE_TTL)

    # 队列只能单线程读（同一队列并发读取结果不确定）；读到就先放进 pending，估值与入库在 ingest_loop 里做，价格没好时也不让队列过期
    def queue_loop(self):
        url = f"{CN_KB[self.store.server]['queue']}?id={urllib.parse.quote(self.queue)}"
        self.store.state["live_mode"] = "kmqueue"
        log.info("[%s] 实时数据：KM 广播队列 %s", self.store.server, self.queue)
        started = 0.0
        while True:
            time.sleep(max(0.0, started + CN_QUEUE_GAP - time.time()))
            started = time.time()
            try:
                data, _ = get_json(url, timeout=40, retries=1)
                km = (data or {}).get("killmail")
            except Exception as e:
                log.warning("[%s] KM 广播队列：%s", self.store.server, e)
                time.sleep(15)
                continue
            if km and km.get("kill_id") and km.get("hash"):
                self.pending.append(km)

    def ingest_loop(self):
        self.prices_ready.wait()
        while True:
            if not self.pending:
                time.sleep(1)
                continue
            s = self.pending.popleft()
            try:
                km, _ = get_json(self.store.esi_url(f"/killmails/{int(s['kill_id'])}/{s['hash']}/"), timeout=20, retries=3)
            except Exception as e:
                s["_tries"] = s.get("_tries", 0) + 1
                if s["_tries"] < 5:
                    self.pending.append(s)
                log.warning("[%s] 击杀 %s 原文读取失败：%s", self.store.server, s.get("kill_id"), e)
                time.sleep(5)
                continue
            sid = km.get("solar_system_id")
            if sid and sid not in self.store.system_regions and s.get("region_id"):
                self.store.system_regions[sid] = int(s["region_id"])   # 本地星系表是宁静服的，缺的用广播里的星域补上
            try:
                self.store.ingest([(km, s["hash"])], live=True)
                self.store.state["last_live"] = iso(time.time())
            except Exception:
                log.exception("[%s] 击杀 %s 入库失败", self.store.server, s.get("kill_id"))


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
        self.mem_names = {}                         # 保留期以前击杀涉及的名称（仅内存，不写库）
        self.bh_lock, self.bh_busy, self.bh_cache = threading.Lock(), {}, {}   # 历史会战：同时只算一份；单独缓存，不随合同估价更新清空
        self.lb_full = collections.OrderedDict()    # 完整排行榜（分页用）：(days, side, by, metric) -> (时间, ids, 次数, 价值)
        self.lb_lock = threading.Lock()
        self.pilot_cache, self.pilot_lock = collections.OrderedDict(), threading.Lock()

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

    # GET /battles/history?days=30：最近 N 天全部疑似会战（同一星系相邻击杀间隔 ≤ 30 分钟连成一段，段内任意 60 分钟击毁 ≥ 20 艘才算；口径同 /battles）。
    # 双方阵营按「谁打谁」划分：同一次击杀里一起出手的算友方，打了对方的算敌方，从参与最多的势力开始依次归队；两边都没有关系的算第三方。
    # 每方统计势力、人数、损失（艘 / ISK）、击毁（艘 / ISK），战损比 = 击毁 ÷（击毁 + 损失）。结果缓存 10 分钟，过期后先返回旧结果、后台重算。
    def battle_history(self, q):
        days = min(max(int(q.get("days", 30)), 1), 30)
        key = ("battle_history", days)
        hit = self.bh_cache.get(key)
        if hit and time.time() - hit[0] < BATTLE_HISTORY_CACHE:
            return hit[1]
        if hit:
            with self.bh_lock:
                if not self.bh_busy.get(days):
                    self.bh_busy[days] = True
                    def bg():
                        try:
                            self.bh_cache[key] = (time.time(), self._battle_history(days))
                        finally:
                            self.bh_busy[days] = False
                    threading.Thread(target=bg, daemon=True).start()
            return hit[1]
        with self.bh_lock:
            hit = self.bh_cache.get(key)   # 另一个请求可能刚算完
            if hit and time.time() - hit[0] < BATTLE_HISTORY_CACHE:
                return hit[1]
            value = self._battle_history(days)
            self.bh_cache[key] = (time.time(), value)
            return value

    def _battle_history(self, days):
        c = self.store.conn()
        since = int(time.time() - days * 86400)
        rows = c.execute(f"""SELECT id, time, system_id, region_id, ship_type, value, v_char, COALESCE(v_alliance, v_corp), v_alliance IS NOT NULL
                             FROM killmails WHERE time >= ? AND npc = 0 AND ship_type NOT IN (670, 33328) AND value >= {BATTLE_MIN_VALUE}
                             ORDER BY system_id, time""", (since,)).fetchall()
        # 按星系切段
        segs, cur = [], []
        for r in rows:
            if cur and (r[2] != cur[-1][2] or r[1] - cur[-1][1] > BATTLE_GAP):
                segs.append(cur)
                cur = []
            cur.append(r)
        if cur:
            segs.append(cur)
        window = 3600
        battles = []
        for seg in segs:
            if len(seg) < BATTLE_MIN_KILLS:
                continue
            j, peak = 0, 0
            for i in range(len(seg)):
                while seg[i][1] - seg[j][1] > window:
                    j += 1
                peak = max(peak, i - j + 1)
            if peak >= BATTLE_MIN_KILLS:
                battles.append((seg, peak))
        out, ids = [], []
        for seg, peak in battles:
            kms = [r[0] for r in seg]
            att = collections.defaultdict(list)    # km -> [(char, 势力, 是否联盟)]
            for chunk in range(0, len(kms), 900):
                part = kms[chunk:chunk + 900]
                for km, ch, ent, is_al in c.execute(f"SELECT km, char, COALESCE(alliance, corp), alliance IS NOT NULL FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                    att[km].append((ch, ent, is_al))
            kind, inv, friend, enemy, chars = {}, collections.Counter(), collections.Counter(), collections.Counter(), collections.defaultdict(set)
            for r in seg:
                v = r[7]
                if v:
                    kind[v] = r[8]
                    inv[v] += 1
                    if r[6]:
                        chars[v].add(r[6])
                ents = set()
                for ch, ent, is_al in att[r[0]]:
                    if ent:
                        kind[ent] = is_al
                        ents.add(ent)
                        if ch:
                            chars[ent].add(ch)
                ents.discard(v)
                for e in ents:
                    inv[e] += 1
                    if v:
                        enemy[(min(e, v), max(e, v))] += 1
                el = sorted(ents)
                if len(el) <= 30:
                    for a in range(len(el)):
                        for b in range(a + 1, len(el)):
                            friend[(el[a], el[b])] += 1
            rel = lambda e, team: sum(friend[(min(e, t), max(e, t))] - enemy[(min(e, t), max(e, t))] for t in team)
            teams, team_of = [[], []], {}
            for e, _ in inv.most_common():
                if not teams[0]:
                    t = 0
                else:
                    s0, s1 = rel(e, teams[0]), rel(e, teams[1])
                    if not teams[1]:
                        t = 0 if s0 > 0 else 1 if s0 < 0 else None
                    else:
                        t = None if s0 == s1 == 0 else (0 if s0 >= s1 else 1)
                if t is not None:
                    teams[t].append(e)
                    team_of[e] = t
            stat = [{"losses": 0, "lost": 0.0, "kills": 0, "destroyed": 0.0, "ents": collections.Counter(), "e_kills": collections.Counter(), "e_losses": collections.Counter(), "e_lost": collections.Counter()} for _ in range(3)]
            for r in seg:
                vt = team_of.get(r[7], 2)
                s = stat[vt]
                s["losses"] += 1
                s["lost"] += r[5] or 0
                if r[7]:
                    s["e_losses"][r[7]] += 1
                    s["e_lost"][r[7]] += r[5] or 0
                hit_teams = set()
                for _, ent, _ in att[r[0]]:
                    if ent and ent != r[7]:
                        stat[team_of.get(ent, 2)]["e_kills"][ent] += 1 if ent not in hit_teams else 0
                        hit_teams.add(ent)
                for t in {team_of.get(e, 2) for e in hit_teams}:
                    if t != vt:
                        stat[t]["kills"] += 1
                        stat[t]["destroyed"] += r[5] or 0
            def team_json(t, members):
                s = stat[t]
                top = sorted(members, key=lambda e: inv[e], reverse=True)
                ids.extend(top[:4])
                return {"entities": [{"id": e, "kind": "alliance" if kind.get(e) else "corporation", "kills": s["e_kills"][e], "losses": s["e_losses"][e], "lost": round(s["e_lost"][e])} for e in top[:4]],
                        "n_entities": len(members), "pilots": len(set().union(*(chars[e] for e in members))) if members else 0,
                        "losses": s["losses"], "lost": round(s["lost"]), "kills": s["kills"], "destroyed": round(s["destroyed"])}
            others = [e for e in inv if e not in team_of]
            top = max(seg, key=lambda r: r[5] or 0)
            all_chars = set().union(*chars.values()) if chars else set()
            out.append({"system_id": seg[0][2], "region_id": seg[0][3], "start": iso(seg[0][1]), "end": iso(seg[-1][1]),
                        "kills": len(seg), "peak": peak, "value": round(sum(r[5] or 0 for r in seg)), "pilots": len(all_chars),
                        "teams": [team_json(0, teams[0]), team_json(1, teams[1])],
                        "third": {"n_entities": len(others), "losses": stat[2]["losses"], "lost": round(stat[2]["lost"])},
                        "top": {"id": top[0], "ship_type_id": top[4], "value": round(top[5] or 0)}})
        out.sort(key=lambda b: b["end"], reverse=True)
        return {"days": days, "updated": iso(int(time.time())), "min": BATTLE_MIN_KILLS, "gap_minutes": BATTLE_GAP // 60,
                "battles": out, "names": self.names_for(ids)}

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
        # 国服没有 zKillboard，只有本地收录的记录
        path = None if q.get("_local") or self.store.server != "tq" else zkill_path(q, side)
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

    # 保留期以前：向 zKillboard 查询，按吉他中间价重新估值，只放内存
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

    # GET /api/v1/pilots?ids=1,2,3：本地频道名单分析，每名角色近 30 天的击杀 / 损失、单挑、平均同伙人数、常用船与常去星系
    def pilots(self, q):
        ids = list(dict.fromkeys(int(x) for x in str(q.get("ids", "")).split(",") if x.strip().isdigit()))
        if not ids:
            raise ValueError("缺少 ids")
        if len(ids) > PILOTS_MAX:
            raise ValueError(f"ids 最多 {PILOTS_MAX} 个")
        now = time.time()
        since = int(now - 30 * 86400)
        out, todo = {}, []
        with self.pilot_lock:
            for cid in ids:
                hit = self.pilot_cache.get(cid)
                if hit and now - hit[0] < CACHE_TTL:
                    out[cid] = hit[1]
                else:
                    todo.append(cid)
        c = self.store.conn() if todo else None
        for cid in todo:
            sub = "SELECT km FROM attackers WHERE char=? AND time >= ?"
            kills, destroyed, solo, gang, last_k = c.execute(
                f"SELECT COUNT(*), COALESCE(SUM(value),0), COALESCE(SUM(solo),0), AVG(attackers), MAX(time) FROM killmails WHERE time >= ? AND id IN ({sub})",
                (since, cid, since)).fetchone()
            losses, lost, last_l = c.execute("SELECT COUNT(*), COALESCE(SUM(value),0), MAX(time) FROM killmails WHERE v_char=? AND time >= ?", (cid, since)).fetchone()
            ships = c.execute("SELECT ship, COUNT(DISTINCT km) n FROM attackers WHERE char=? AND time >= ? AND ship IS NOT NULL GROUP BY ship ORDER BY n DESC LIMIT 3",
                              (cid, since)).fetchall()
            systems = c.execute(f"SELECT system_id, COUNT(*) n FROM killmails WHERE time >= ? AND (v_char=? OR id IN ({sub})) GROUP BY system_id ORDER BY n DESC LIMIT 3",
                                (since, cid, cid, since)).fetchall()
            last = max(last_k or 0, last_l or 0)
            row = {"kills": kills, "losses": losses, "destroyed": round(destroyed), "lost": round(lost), "solo": solo,
                   "gang": round(gang, 1) if gang else None, "last": iso(last) if last else None,
                   "ships": [[s, n] for s, n in ships], "systems": [[s, n] for s, n in systems]}
            out[cid] = row
            with self.pilot_lock:
                self.pilot_cache[cid] = (now, row)
                while len(self.pilot_cache) > PILOT_CACHE:
                    self.pilot_cache.popitem(last=False)
        return {"days": 30, "pilots": {str(cid): out[cid] for cid in ids}}

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
        days = max(1, min(int(q.get("days", 7)), self.store.retention or 3650))
        # limit：只分析最近若干次损失（对战模拟一次要查很多种船，用较小的值）
        limit = max(10, min(int(q.get("limit") or SHIPFIT_MAX), SHIPFIT_MAX))
        # kills：只分析这些击杀（对战模拟按一场会战里这型船的实际损失取装配），最多 SHIPFIT_KILLS 个
        kills = sorted({int(x) for x in str(q.get("kills") or "").split(",") if x.strip().isdigit()})[:SHIPFIT_KILLS]
        key = f"shipfits:{ship}:{days}:{limit}:{hashlib.md5(','.join(map(str, kills)).encode()).hexdigest() if kills else ''}"
        return self.cached(key, lambda: self._shipfits(ship, days, limit, kills))

    def _shipfits(self, ship, days, limit=SHIPFIT_MAX, kills=None):
        since = int(time.time() - days * 86400)
        conn = self.store.conn()
        if kills:
            rows = conn.execute(f"SELECT id, hash, time, value FROM killmails WHERE ship_type=? AND id IN ({','.join('?' * len(kills))}) ORDER BY time DESC",
                                (ship, *kills)).fetchall()
            total = len(rows)
        else:
            total = conn.execute("SELECT COUNT(*) FROM killmails WHERE ship_type=? AND time>=?", (ship, since)).fetchone()[0]
            rows = conn.execute("SELECT id, hash, time, value FROM killmails WHERE ship_type=? AND time>=? ORDER BY time DESC LIMIT ?",
                                (ship, since, limit)).fetchall()
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
                km, _ = get_json(self.store.esi_url(f"/killmails/{row[0]}/{row[1]}/"), timeout=20, retries=2)
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

    # 开放接口 GET /api/v1/prices?types=&hub=：最低卖价、最高收购价、全服均价与本站估价，
    # 以及该交易中心近 1 / 7 / 14 / 30 天成交中位价 med（倒卖排行汇总里有的物品；hub=all 用吉他的）
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
        med = self.store.arb.medians(hub or FORGE) if getattr(self.store, "arb", None) else (lambda t: None)
        out = {}
        for t in dict.fromkeys(ids):
            sell, buy, avg = self.store.prices.get(t) or (None, None, None)
            if table is not None:
                sell, buy = table.get(t) or (None, None)
            est = self.store.price(t)
            out[str(t)] = {"sell": sell, "buy": buy, "average": round(avg, 2) if avg else None, "estimate": round(est, 2) if est else None, "med": med(t)}
        updated = self.store.state.get("prices_updated" if table is None else "hub_prices_updated")
        return {"hub": "all" if hub == 0 else hub, "updated": updated, "types": out}

    # 虫洞：击杀邮件里的星系 ID 31000000–31999999 是虫洞空间（ESI 的星系击杀统计不含虫洞，只能从击杀记录统计）
    def wh_activity(self, q):
        """GET /api/v1/wormholes/activity?days=1|7|30：各虫洞星系的击杀数、总价值、被 NPC 击毁数、最近一次击杀"""
        days = int(q.get("days") or 7)
        if days not in (1, 7, 30):
            raise ValueError("days 只能是 1 / 7 / 30")

        def build():
            since = int(time.time()) - days * 86400
            rows = self.store.conn().execute(
                "SELECT system_id, COUNT(*), SUM(value), SUM(npc), MAX(time) FROM killmails "
                "WHERE time >= ? AND system_id >= 31000000 AND system_id < 32000000 GROUP BY system_id", (since,)).fetchall()
            return {"days": days, "updated": iso(time.time()), "fields": ["kills", "value", "npc_kills", "last"],
                    "systems": {str(r[0]): [r[1], round(r[2] or 0), r[3] or 0, iso(r[4])] for r in rows}}
        return self.cached(("wh_activity", days), build)

    def wh_system(self, sid, q):
        """GET /api/v1/wormholes/systems/{id}：近 30 天击杀统计、按 UTC 小时分布、出现最多的军团 / 联盟（推测常驻）、最近 20 次击杀"""
        if not 31000000 <= sid < 32000000:
            raise ValueError("不是虫洞星系")

        def build():
            c = self.store.conn()
            since = int(time.time()) - 30 * 86400
            rows = c.execute(f"SELECT {SUMMARY_COLS} FROM killmails WHERE system_id=? AND time >= ? ORDER BY time DESC, id DESC", (sid, since)).fetchall()
            hours = [0] * 24
            corps, alliances = collections.Counter(), collections.Counter()
            for r in rows:
                hours[time.gmtime(r[1]).tm_hour] += 1
                if r[10]:
                    corps[r[10]] += 1
                if r[11]:
                    alliances[r[11]] += 1
            ids = [r[0] for r in rows]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                ph = ",".join("?" * len(chunk))
                # 每次击杀里同一军团 / 联盟只算一次
                for (corp,) in c.execute(f"SELECT corp FROM (SELECT DISTINCT km, corp FROM attackers WHERE km IN ({ph}) AND corp)", chunk):
                    corps[corp] += 1
                for (alliance,) in c.execute(f"SELECT alliance FROM (SELECT DISTINCT km, alliance FROM attackers WHERE km IN ({ph}) AND alliance)", chunk):
                    alliances[alliance] += 1
            recent = [row_summary(r) for r in rows[:20]]
            top_c, top_a = corps.most_common(8), alliances.most_common(5)
            names = self.with_names(recent, [x for x, _ in top_c + top_a])
            return {"system_id": sid, "days": 30, "kills": len(rows), "value": round(sum(r[5] or 0 for r in rows)),
                    "npc_kills": sum(1 for r in rows if r[8]), "last": iso(rows[0][1]) if rows else None, "hours_utc": hours,
                    "corporations": [{"id": x, "count": n} for x, n in top_c], "alliances": [{"id": x, "count": n} for x, n in top_a],
                    "recent": recent, "names": names}
        return self.cached(("wh_system", sid), build)

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
                if q.get("_local") or self.store.server != "tq":   # 开放接口只查保留期内的击杀；国服没有 zKillboard
                    raise KeyError(kid)
                data = zkill_get(f"killID/{kid}/")
                if not data:
                    raise KeyError(kid)
                km = data[0]
                with self.km_lock:
                    self.km_cache[kid] = km
            row = (self.store.km_value(km), (km.get("zkb") or {}).get("hash"))
        elif km is None:
            km, _ = get_json(self.store.esi_url(f"/killmails/{kid}/{row[1]}/"), timeout=20, retries=2)
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


# ---------------------------------------------------------------- 角色交易（晨曦：网易藏宝阁）
CBG = "https://eve.cbg.163.com"
CBG_TTL = 600             # 列表 / 详情缓存秒数
CBG_UA = "Mozilla/5.0 (compatible; EVE-Market-Tool)"
CBG_ROW_RE = re.compile(r'<tr class="[^"]*" data-serverid="(\d+)" data-game_ordersn="(\d+)">(.*?)</tr>', re.S)


def cbg_num(text):
    """藏宝阁的数字：1.35亿 / 2504.01万 / 0.0"""
    m = re.search(r"(-?[\d.]+)\s*(亿|万)?", text or "")
    if not m:
        return None
    return float(m.group(1)) * {"亿": 1e8, "万": 1e4}.get(m.group(2), 1)


class Cbg:
    """网易藏宝阁（晨曦）在售与公示期角色：列表页与详情页都是服务端渲染的 HTML，详情页里嵌着角色数据 EquipData（技能、钱包、舰船…）"""

    def __init__(self):
        self.cache = {}
        self.lock = threading.Lock()
        self.skills = {}   # 订单号 -> [角色ID, 角色名, 总技能点, "技能ID:等级,…"]（列表按技能要求筛选用）
        self.ids = []      # 最近一次列表里的订单号

    def start(self):
        threading.Thread(target=self.run, daemon=True, name="cbg").start()
        return self

    def run(self):
        """后台每 10 分钟读一遍列表和全部角色详情（晨曦只有几十个角色），备好技能等级"""
        time.sleep(30)
        while True:
            try:
                for it in self.items({})["items"]:
                    if it["id"] not in self.skills:
                        try:
                            self.detail({"id": it["id"]})
                        except (KeyError, RuntimeError):
                            pass
                        time.sleep(1)
            except Exception:
                log.exception("藏宝阁后台读取出错")
            time.sleep(CBG_TTL)

    def skillset(self, q):
        with self.lock:
            out = {sn: self.skills[sn] for sn in self.ids if sn in self.skills}
        return {"items": out, "pending": len(self.ids) - len(out)}

    def get(self, path):
        now = time.time()
        hit = self.cache.get(path)
        if hit and now - hit[0] < CBG_TTL:
            return hit[1]
        try:
            body, _ = http_get(CBG + path, timeout=20, headers={"User-Agent": CBG_UA})
            text = body.decode("utf-8", "replace")
        except Exception as e:
            if hit:
                return hit[1]
            log.warning("藏宝阁读取失败 %s: %s", path, e)
            raise RuntimeError("网易藏宝阁暂时无法访问，请稍后再试")
        with self.lock:
            if len(self.cache) > 300:
                for k in sorted(self.cache, key=lambda k: self.cache[k][0])[:150]:
                    del self.cache[k]
            self.cache[path] = (now, text)
        return text

    @staticmethod
    def rows(html, status):
        out = []
        for server, sn, body in CBG_ROW_RE.findall(html):
            tds = re.findall(r"<td>(.*?)</td>", body, re.S)
            text = lambda i: re.sub(r"<[^>]+>|\s+", " ", tds[i]).strip() if i < len(tds) else ""
            pop = dict(re.findall(r"<p[^>]*>\s*([^：<]+?)\s*：\s*([^<]*)</p>", body))
            cid = re.search(r"/Character/(\d+)_", body)
            price = re.search(r"mapPriceColor\(([\d.]+)", body)
            out.append({"id": int(sn), "server": int(server), "status": status, "name": html_lib.unescape(text(1)),
                        "character_id": int(cid.group(1)) if cid else None,
                        "sp": cbg_num(text(2)), "price": float(price.group(1)) if price else None, "left": text(5),
                        "sec": cbg_num(pop.get("安全等级")), "isk": cbg_num(pop.get("I S K"))})
        return out

    def items(self, q):
        """在售 + 公示期的全部角色（藏宝阁晨曦一共只有几十个，整页读完）"""
        out, seen = [], set()
        for path, status in (("/?page={}", "sale"), ("/cbg/query.py?act=fair_show&page={}", "fair")):
            for page in range(1, 21):
                got = [r for r in self.rows(self.get(path.format(page)), status) if r["id"] not in seen]
                if not got:
                    break
                seen.update(r["id"] for r in got)
                out += got
        self.ids = [r["id"] for r in out]
        return {"items": out, "source": CBG}

    def detail(self, q):
        sn = int(q.get("id") or 0)
        if sn <= 0:
            raise ValueError("缺少 id")
        html = self.get(f"/cbg/query.py?act=detail&serverid=1&game_ordersn={sn}")
        m = re.search(r"var EquipData = (\{.*?\});\s*\n", html, re.S)
        if not m:
            raise KeyError("藏宝阁上找不到这个角色（可能已售出或下架）")
        d = json.loads(m.group(1))
        dd = {re.sub(r"\s+", "", k): re.sub(r"<[^>]+>|\s+", " ", v).strip()
              for k, v in re.findall(r"<dt>([^<]*?)：?</dt>\s*<dd[^>]*>(.*?)</dd>", html, re.S)}
        price = re.search(r"<dt>价格：</dt>.*?mapPriceColor\(([\d.]+)", html, re.S)
        slot = lambda s, k: [[x.get("itemTypeId"), x.get("itemTypeName")] for x in s.get(k) or []]
        total = (d.get("totalAllocatedSkillPoint") or 0) + (d.get("totalUnallocatedSkillPoint") or 0)
        sk = ",".join(f"{x['skillTypeId']}:{x.get('level') or 0}" for g in d.get("learnedSkills") or [] for x in g.get("skills") or [] if x.get("skillTypeId"))
        with self.lock:
            self.skills[sn] = [d.get("characterId"), d.get("characterName"), total, sk]
        return {"id": sn, "url": f"{CBG}/cbg/query.py?act=detail&serverid=1&game_ordersn={sn}", "source": "网易藏宝阁",
                "name": d.get("characterName"), "character_id": d.get("characterId"), "price": float(price.group(1)) if price else None,
                "status": dd.get("状态"), "left": dd.get("出售剩余时间") or dd.get("公示剩余时间"), "seller": dd.get("卖家"),
                "total_sp": (d.get("totalAllocatedSkillPoint") or 0) + (d.get("totalUnallocatedSkillPoint") or 0),
                "allocated_sp": d.get("totalAllocatedSkillPoint"), "unallocated_sp": d.get("totalUnallocatedSkillPoint"),
                "isk": d.get("iskInWallet"), "sec": d.get("securityLevel"), "station": d.get("stationName"),
                "corp_history": d.get("corpHistory") or [],
                "skills": [[x["skillTypeId"], x.get("level") or 0, 0] for g in d.get("learnedSkills") or [] for x in g.get("skills") or []],
                "ships": [{"type": x.get("shipTypeId"), "name": x.get("shipTypeName"), "jumps": x.get("jumpCount"),
                           "slots": {k: slot(x, k) for k in ("highSlot", "mediumSlot", "lowSlot", "rigSlot", "subsystemSlot")}}
                          for x in d.get("shipsToShow") or []],
                "items": [[x.get("itemTypeId"), x.get("itemTypeName"), x.get("quantity") or x.get("count")] for x in d.get("itemsToShow") or []]}


# ---------------------------------------------------------------- 角色交易（宁静服官方论坛 Character Bazaar）
FORUM = "https://forums.eveonline.com"
BAZAAR_CAT = (60, "marketplace/character-bazaar")   # Marketplace 下的角色交易版块
BAZAAR_TTL = 120          # 列表 / 帖子缓存秒数（论坛对匿名访问有频率限制）
BAZAAR_MAX_POSTS = 200    # 帖子详情最多读取的楼层数（拍卖帖出价很多）
BAZAAR_CRAWL_PAGES = 20      # 后台索引读取论坛列表的页数（每页 30 帖，约覆盖近 3 个月）
BAZAAR_CRAWL_GAP = 900    # 两轮索引的间隔（秒）
BAZAAR_KEEP_DAYS = 120    # 索引里保留最近 N 天有回复的帖子
QSNA_RE = re.compile(r"qsna\.eu/eve/characters/(\d+)", re.I)   # 卖家最常用的技能展示站，有公开的 ESI 格式技能接口
SP_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*x?\s*(?:m|mil|mill|million|kk)\b\.?\s*(sp|skill)?", re.I)
BODY_SP_RE = re.compile(r"skill\s*points?\s*(?:total)?\s*[:：=-]?\s*(\d+(?:[.,]\d+)?)\s*(?:m|mil|million|kk)\b", re.I)
# 帖子正文里的报价：一口价 / 起拍价 / 要价（单位 B）
ASK_RE = re.compile(r"(buy\s*-?\s*out|\bb/?o\b|start(?:ing)?\s*(?:bid|at|price)?|bidding\s+(?:at|from)|opening\s+bid|asking(?:\s+price)?|price|selling\s+(?:it\s+)?for)"
                    r"[^0-9\n]{0,25}?(\d+(?:[.,]\d+)?)\s*(?:b|bil|bill|billion|bn)\b", re.I)
TRANSLATE_URL = "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN&format=html"   # 固定英文：术语先换成中文后自动检测会误判
# 机器翻译后修正的 EVE 术语
# 机器翻译后修正的常见误译（只改不翻译标记以外的文字，官方名称不受影响）
ZH_FIX = [("杀戮权", "击杀权"), ("跳跃克隆体", "远距克隆"), ("跳跃克隆", "远距克隆"), ("NPC 公司", "NPC 军团"), ("NPC公司", "NPC 军团"), ("公司", "军团"),
          ("干净秒", "安全等级干净"), ("清洁秒", "安全等级干净"), ("重映射", "属性重置"), ("帐户", "账号"), ("账户", "账号"), ("安全状态", "安全等级"),
          ("试点", "飞行员"), ("挖掘机", "采掘者"), ("秘密行动", "隐形特勤舰"), ("黑行动", "黑隐特勤舰"), ("传真飞行员", "战力辅助舰飞行员"), ("传真", "战力辅助舰"),
          ("侦察船", "侦察舰"), ("跳跃货船", "战略货舰"), ("跳跃货轮", "战略货舰"), ("货轮", "货舰"), ("盾牌", "护盾"), ("中共", "CCP")]


def zh_fix(html):
    parts = re.split(r'(<span class="notranslate">.*?</span>)', html, flags=re.S)
    for i in range(0, len(parts), 2):
        for a, b in ZH_FIX:
            parts[i] = parts[i].replace(a, b)
    # 技能名后的等级：翻译会吞掉空格（采掘者操作V → 采掘者操作 V）
    return re.sub(r"(</span>)\s*([IV]{1,3}|[1-5])(?![\w-])", r"\1 \2", "".join(parts))


AMOUNT_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:b|bil|bill|billion|bn|kkk|m|mil|mill|million|kk)\b(?:\s*(?:isk|sp))?", re.I)


# 游戏术语：常用缩写与船级（区分大小写，整词匹配）。舰船、技能、植入体等的官方中文名由 EveGlossary 从装配数据读取
EVE_TERMS = {
    "BS": "战列舰", "BC": "战列巡洋舰", "BCs": "战列巡洋舰", "HAC": "重型突击巡洋舰", "HACs": "重型突击巡洋舰", "HIC": "重型拦截巡洋舰", "HICs": "重型拦截巡洋舰",
    "Dictor": "拦截舰", "Dictors": "拦截舰", "Interdictor": "拦截舰", "Interdictors": "拦截舰", "FAX": "战力辅助舰", "Fax": "战力辅助舰", "FAXes": "战力辅助舰",
    "Force Auxiliary": "战力辅助舰", "Force Auxiliaries": "战力辅助舰", "Dread": "无畏舰", "Dreads": "无畏舰", "Dreadnought": "无畏舰", "Dreadnoughts": "无畏舰",
    "Lancer": "枪骑兵级无畏舰", "Lancers": "枪骑兵级无畏舰", "Carrier": "航空母舰", "Carriers": "航空母舰", "Super": "超级航母", "Supers": "超级航母",
    "Supercarrier": "超级航母", "Supercarriers": "超级航母", "Titan": "泰坦", "Titans": "泰坦", "Blops": "黑隐特勤舰", "BLOPS": "黑隐特勤舰", "BlOps": "黑隐特勤舰",
    "CovOps": "隐形特勤舰", "Cov Ops": "隐形特勤舰", "T3": "T3", "T3C": "战略巡洋舰", "T3Cs": "战略巡洋舰", "T3D": "战术驱逐舰", "T3Ds": "战术驱逐舰",
    "Strategic Cruiser": "战略巡洋舰", "Strategic Cruisers": "战略巡洋舰", "Tactical Destroyer": "战术驱逐舰", "Tactical Destroyers": "战术驱逐舰",
    "Logi": "后勤", "Logistics": "后勤", "Recon": "侦察舰", "Recons": "侦察舰", "Marauder": "掠夺舰", "JF": "战略货舰", "JFs": "战略货舰",
    "Jump Freighter": "战略货舰", "Jump Freighters": "战略货舰", "Freighter": "货舰", "Freighters": "货舰", "Cyno": "诱导力场", "Cynos": "诱导力场",
    "Covert Cyno": "隐秘诱导力场", "Capital": "旗舰", "Capitals": "旗舰", "Caps": "旗舰", "Exhumer": "采掘者", "Barge": "采矿驳船", "Barges": "采矿驳船",
    "Mining Barge": "采矿驳船", "Interceptor": "截击舰", "Bomber": "隐形轰炸舰", "Bombers": "隐形轰炸舰", "Stealth Bomber": "隐形轰炸舰", "Stealth Bombers": "隐形轰炸舰",
    "Command Ship": "指挥舰", "Command Ships": "指挥舰", "Command Destroyer": "指挥驱逐舰", "Command Destroyers": "指挥驱逐舰",
    "Battleship": "战列舰", "Battleships": "战列舰", "Battlecruiser": "战列巡洋舰", "Battlecruisers": "战列巡洋舰", "Cruiser": "巡洋舰", "Cruisers": "巡洋舰",
    "Destroyer": "驱逐舰", "Destroyers": "驱逐舰", "Frigate": "护卫舰", "Frigates": "护卫舰", "Assault Frigate": "突击护卫舰", "Assault Frigates": "突击护卫舰",
    "Heavy Assault Cruiser": "重型突击巡洋舰", "Heavy Assault Cruisers": "重型突击巡洋舰", "Logistics Cruiser": "后勤舰", "Logistics Cruisers": "后勤舰",
    "DST": "深层空间运输舰", "DSTs": "深层空间运输舰", "Blockade Runner": "偷运舰", "Blockade Runners": "偷运舰", "Hauler": "运输舰", "Haulers": "运输舰",
    "Industrial": "运输舰", "Industrials": "运输舰", "Jump Clone": "远距克隆", "Jump Clones": "远距克隆", "Remap": "属性重置", "Remaps": "属性重置",
    "remap": "属性重置", "remaps": "属性重置", "Bonus Remap": "额外属性重置", "Kill Rights": "击杀权", "Kill rights": "击杀权", "kill rights": "击杀权",
    "Security Status": "安全等级", "Security status": "安全等级", "security status": "安全等级", "Sec Status": "安全等级", "sec status": "安全等级",
    "NPC corp": "NPC 军团", "NPC Corp": "NPC 军团", "Omega": "欧米伽", "Alpha": "阿尔法", "Abyss": "深渊", "Abyssal": "深渊", "Incursion": "入侵", "Incursions": "入侵",
    "Wormhole": "虫洞", "Wormholes": "虫洞", "WH": "虫洞", "Nullsec": "00 区", "nullsec": "00 区", "Null": "00 区", "Lowsec": "低安", "lowsec": "低安",
    "Highsec": "高安", "highsec": "高安", "Hisec": "高安", "Ratting": "刷怪", "ratting": "刷怪", "Skill Injector": "技能注入器", "Skill Extractor": "技能提取器",
    "Large Skill Injector": "大型技能注入器", "Unallocated SP": "未分配技能点", "unallocated SP": "未分配技能点", "Unallocated": "未分配",
    "Implants": "植入体", "implants": "植入体", "Implant": "植入体", "Clone": "克隆", "Clones": "克隆", "Character Transfer": "角色转移", "character transfer": "角色转移",
    "CCP": "CCP", "ccp": "CCP", "Quantum Anomaly": "Quantum Anomaly", "SkillQ": "SkillQ", "SKILLQ": "SkillQ", "PLEX": "PLEX", "Plex": "PLEX",
    "killrights": "击杀权", "Killrights": "击杀权", "kill right": "击杀权", "Kill Right": "击杀权", "KR": "击杀权",
    "SKILLQ overview": "SkillQ 技能概览", "Skillq overview": "SkillQ 技能概览", "jita": "吉他",
    "Positive sec": "安全等级为正", "positive sec": "安全等级为正", "Positive Sec": "安全等级为正", "clean sec": "安全等级干净", "Clean sec": "安全等级干净",
    "Positive Wallet": "钱包余额为正", "Positive wallet": "钱包余额为正", "positive wallet": "钱包余额为正",
    "EVE": "EVE", "Eve": "EVE", "EVE Time": "EVE 时间", "Eve Time": "EVE 时间", "Char": "角色", "char": "角色", "Toon": "角色", "toon": "角色",
    "Jita": "吉他", "JITA": "吉他", "Dodixie": "多迪谢", "Rens": "伦斯", "Hek": "赫克", "Perimeter": "皮尔米特",
    "Shield": "护盾", "Armor": "装甲", "Armour": "装甲", "Hull": "结构", "Skills": "技能", "Skill Points": "技能点",
    "Amarr": "艾玛", "Caldari": "加达里", "Gallente": "盖伦特", "Minmatar": "米玛塔尔", "Triglavian": "三神裔", "ORE": "ORE",
    "Cyno Alt": "诱导力场小号", "Cyno Alts": "诱导力场小号", "alt": "小号", "alts": "小号", "Alt": "小号", "Alts": "小号",
}
# 小写写法（论坛里很常见）
EVE_TERMS.update({w: EVE_TERMS[w.capitalize()] for w in (
    "cyno", "cynos", "dread", "dreads", "dreadnought", "dreadnoughts", "carrier", "carriers", "super", "supers", "supercarrier", "supercarriers",
    "titan", "titans", "fax", "logi", "logistics", "recon", "recons", "marauder", "freighter", "freighters", "battleship", "battleships",
    "battlecruiser", "battlecruisers", "cruiser", "cruisers", "destroyer", "destroyers", "frigate", "frigates", "exhumer", "barge", "barges",
    "hauler", "haulers", "bomber", "bombers", "interceptor", "wormhole", "wormholes", "clone", "clones", "capital", "capitals", "caps",
    "blops", "dictor", "dictors", "interdictor", "interdictors", "omega", "alpha", "incursion", "incursions", "industrial", "industrials")})
# 单个英文词的舰船名里容易和普通英文混淆的，不替换
EVE_STOP = {"Sin", "Hel", "Lif", "Burst", "Probe", "Prospect", "Omen", "Moa", "Curse", "Vigil", "Echo", "Hound", "Wolf", "Hawk", "Venture", "Guardian", "Legion", "Retribution", "Vengeance"}


class EveGlossary:
    """游戏术语 → 国服官方中文名（翻译前替换并标成不翻译）：装配数据里的舰船、技能、植入体（单词名区分大小写），
    多个词的装备 / 弹药 / 无人机 / 舰载机名（不区分大小写），以及 EVE_TERMS 里的缩写与船级"""

    def __init__(self, dirs):
        self.dirs = dirs
        self.re = None
        self.exact, self.lower = {}, {}
        self.skills = {}   # 技能英文名（小写）-> 中文名：后面跟着等级时按技能名，否则按船级（去掉「操作」）
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if self.re is not None:
                return
            names = {}
            for d in self.dirs:
                path = os.path.join(d or "", "fit-data.json")
                if d and os.path.exists(path):
                    with open(path) as fh:
                        fd = json.load(fh)
                    cat = {int(k): v[1] for k, v in fd["groups"].items()}
                    for zh, en, group, *_ in fd["types"].values():
                        c = cat.get(group)
                        if not en or not zh or en == zh:
                            continue
                        if c == 16:
                            self.skills[en.lower()] = zh
                        multi = " " in en
                        if c in (6, 16, 20) or (c in (7, 8, 18, 87, 32) and multi):
                            if not multi and (en in EVE_STOP or len(en) < 4):
                                continue
                            names[en] = zh
                    break
            terms = {**names, **EVE_TERMS}
            for en, zh in terms.items():   # 多个词的不区分大小写，单个词区分（避免和普通英文混淆）
                if " " in en:
                    self.lower[en.lower()] = zh
                else:
                    self.exact[en] = zh
            alts = sorted(terms, key=len, reverse=True)
            pat = "|".join(f"(?i:{re.escape(en)})" if " " in en else re.escape(en) for en in alts)
            self.re = re.compile(r"(?<![\w-])(?:" + pat + r")(?![\w-])") if alts else False
            log.info("游戏术语表：%d 条", len(terms))

    def sub(self, text):
        if self.re is None:
            self.load()
        if not self.re:
            return text
        def one(m):
            w = m.group(0)
            leveled = re.match(r"\s*(?:[IV]{1,3}|[1-5])(?![\w-])", m.string[m.end():])
            skill = self.skills.get(w.lower())
            if skill and leveled:      # Gallente Titan V：技能
                zh = skill
            else:                      # Gallente Titan pilot：船级
                zh = self.exact.get(w) or self.lower.get(w.lower())
                if zh and zh == skill and zh.endswith("操作"):
                    zh = zh[:-2]
            return f'<span class="notranslate">{zh}</span>' if zh else w
        return self.re.sub(one, text)


GLOSSARY = EveGlossary([])


def zh_prep(html, keep=()):
    """翻译前：链接文字不翻译；游戏术语换成官方中文名；ISK / 技能点数额不翻译（否则 95Bil 会被译成「95比尔」）"""
    # 网址样式的链接文字不翻译，其余链接文字照常翻译
    html = re.sub(r"(<a\b[^>]*>)((?:https?://|www\.)[^<]*)(</a>)", r'\1<span class="notranslate">\2</span>\3', html, flags=re.I)
    out, skip = [], 0
    for part in re.split(r"(<[^>]+>)", html):
        if part.startswith("<"):
            # 已标成不翻译的内容（链接文字）里不再替换
            if re.match(r'<span class="notranslate">', part):
                skip += 1
            elif part == "</span>" and skip:
                skip -= 1
            out.append(part)
        elif skip:
            out.append(part)
        else:
            text = GLOSSARY.sub(part)
            for name in keep:   # 发帖人等角色名原样保留
                text = re.sub(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", lambda m: f'<span class="notranslate">{m.group(0)}</span>', text)
            out.append("".join(p if p.startswith("<") else AMOUNT_RE.sub(lambda m: f'<span class="notranslate">{m.group(0)}</span>', p)
                               for p in re.split(r"(<[^>]+>)", text)))
    return "".join(out)
ISK_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:b|bil|bill|billion|bn)\b(?!\s*sp)", re.I)


def bazaar_kind(title):
    t = title.lower()
    if re.search(r"\bsold\b|\bclosed\b|\bwithdrawn\b", t):
        return "sold"
    if re.search(r"\bwtb\b|\bbuying\b|looking for", t):
        return "wtb"
    if re.search(r"\bwtt\b|\btrade\b", t):
        return "wtt"
    if "auction" in t:
        return "auction"
    if re.search(r"\bwts\b|\bselling\b|\bsale\b|\bsell\b", t):
        return "wts"
    return ""


def bazaar_sp(title):
    """标题里的技能点（百万）：优先取后面跟着 SP 的数字"""
    best = None
    for m in SP_RE.finditer(title):
        if re.match(r"\s*isk", title[m.end():], re.I):
            continue
        v = float(m.group(1).replace(",", "."))
        if not 0.5 <= v <= 700:
            continue
        if m.group(2):
            return v
        best = best if best is not None else v
    return best


def bazaar_ts(iso):
    try:
        return dt.datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def bazaar_boards(html):
    """1 楼里的 qsna.eu 角色（一帖卖多个角色时有多个），按出现顺序去重，最多 8 个"""
    return list(dict.fromkeys(int(x) for x in QSNA_RE.findall(html or "")))[:8]


def board_sp(d):
    """qsna.eu 角色数据里的总技能点"""
    info = ((d or {}).get("esiData") or {}).get("skills_info") or {}
    return info.get("total_sp") or sum(s.get("skillpoints_in_skill") or 0 for s in info.get("skills") or [])


def board_skills(d):
    """qsna.eu 角色数据里的技能，压成「技能ID:等级,…」（列表按技能要求筛选用）"""
    info = ((d or {}).get("esiData") or {}).get("skills_info") or {}
    return ",".join(f"{x['skill_id']}:{x.get('trained_skill_level') or 0}" for x in info.get("skills") or [] if x.get("skill_id"))


def bazaar_text(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def bazaar_asks(text):
    """正文里的报价：[[buyout|start|ask, 十亿 ISK]]，每种取第一个"""
    out = {}
    for m in ASK_RE.finditer(text):
        w = m.group(1).lower()
        kind = "buyout" if w.startswith(("buy", "b/o", "bo")) else "start" if w.startswith(("start", "bidding", "opening")) else "ask"
        v = float(m.group(2).replace(",", "."))
        if kind not in out and 0.1 <= v <= 5000:
            out[kind] = v
    return [[k, v] for k, v in out.items()]


def bazaar_isk(title):
    for m in ISK_RE.finditer(title):
        v = float(m.group(1).replace(",", "."))
        if 0.1 <= v <= 5000:
            return v
    return None


def bazaar_price(row):
    """排序用的价格（十亿 ISK）：一口价 > 要价 > 起拍价 > 标题里的数字"""
    asks = dict(row.get("asks") or [])
    return asks.get("buyout") or asks.get("ask") or asks.get("start") or row.get("isk")


class Bazaar:
    """官方论坛角色交易版块的只读代理（论坛没有开放跨域）：列表 / 搜索 / 帖子详情，短时缓存。
    后台线程慢速读取近期帖子的 1 楼，提取技能点、报价、技能展示链接，存成索引（按技能点 / 价格 / 每技能点价格排序用）"""

    def __init__(self, path=None):
        self.cache = {}
        self.lock = threading.Lock()
        self.zh = collections.OrderedDict()   # 正文 md5 -> 中文译文
        self.path = path
        self.index = {}                       # 帖子 ID -> { row 列表行, sp, asks, board, at }
        self.boards = {}                      # 技能展示站角色 ID -> (时间, 数据)
        self.pages_done = 0                   # 本次启动后索引已读完的论坛列表页数
        if path and os.path.exists(path):
            try:
                with open(path) as fh:
                    self.index = {int(k): v for k, v in json.load(fh).items()}
            except (OSError, ValueError):
                log.warning("角色交易索引读取失败，重新建立")

    def start(self):
        threading.Thread(target=self.run, daemon=True, name="bazaar").start()
        return self

    def run(self):
        time.sleep(20)
        while True:
            try:
                self.crawl()
            except Exception:
                log.exception("角色交易索引出错")
            time.sleep(BAZAAR_CRAWL_GAP)

    def crawl(self):
        cid, slug = BAZAAR_CAT
        for page in range(BAZAAR_CRAWL_PAGES):
            d = self.fetch(f"/c/{slug}/{cid}/l/latest.json?page={page}")
            users = {u["id"]: u for u in d.get("users") or []}
            for t in (d.get("topic_list") or {}).get("topics") or []:
                if t.get("pinned") or t.get("category_id") != cid:
                    continue
                row = self.topic_row(t, users)
                ix = self.index.get(t["id"])
                if ix and ix.get("at", 0) > time.time() - 3 * 86400 and ("chars" in ix or not ix.get("board")):   # 1 楼三天内读过：只更新列表信息
                    ix["row"] = row
                    continue
                try:
                    info = self.op_info(self.fetch(f"/t/{t['id']}.json"))
                except RuntimeError:
                    continue
                # 技能展示站：总技能点（标题和正文都没写时用）与各角色的技能等级（按技能要求筛选用）
                info["chars"] = []
                for b in info.pop("boards"):
                    try:
                        bd = self.board_data(b)
                    except RuntimeError:
                        continue
                    if b == info["board"]:
                        info["board_sp"] = round(board_sp(bd) / 1e6, 1) or None
                    if sk := board_skills(bd):
                        info["chars"].append([b, bd.get("characterName") or "", board_sp(bd), sk])
                    time.sleep(1)
                with self.lock:
                    self.index[t["id"]] = {"row": row, **info}
                time.sleep(2)
            self.save()   # 每页存一次，重启不丢进度
            self.pages_done = max(self.pages_done, page + 1)
            self.zh_titles([t["title"] for t in (d.get("topic_list") or {}).get("topics") or [] if t.get("title")])   # 标题译文提前备好
            if not (d.get("topic_list") or {}).get("more_topics_url"):
                break
        cutoff = time.time() - BAZAAR_KEEP_DAYS * 86400
        with self.lock:
            for k in [k for k, v in self.index.items() if bazaar_ts(v["row"].get("last_posted_at")) < cutoff]:
                del self.index[k]
        self.save()
        log.info("角色交易索引：%d 帖", len(self.index))

    def save(self):
        if not self.path:
            return
        with self.lock:
            data = json.dumps(self.index, ensure_ascii=False, separators=(",", ":"))
        tmp = self.path + ".tmp"
        with open(tmp, "w") as fh:
            fh.write(data)
        os.replace(tmp, self.path)

    @staticmethod
    def op_info(d):
        posts = (d.get("post_stream") or {}).get("posts") or []
        html = posts[0].get("cooked") or "" if posts and posts[0].get("post_number") == 1 else ""
        text = bazaar_text(html)
        m = BODY_SP_RE.search(text)
        boards = bazaar_boards(html)
        return {"sp": float(m.group(1).replace(",", ".")) if m else None, "asks": bazaar_asks(text),
                "board": boards[0] if boards else None, "boards": boards, "at": time.time()}

    def merge(self, row):
        """列表行补上索引里的技能点、报价、技能展示站，并算出排序字段"""
        ix = self.index.get(row["id"]) or {}
        row = {**row, "sp": row.get("sp") or ix.get("sp") or ix.get("board_sp"), "asks": ix.get("asks") or [], "board": ix.get("board")}
        row["price"] = bazaar_price(row)
        row["ratio"] = round(row["price"] * 1000 / row["sp"]) if row["price"] and row["sp"] else None   # 每技能点多少 ISK
        return row

    def fetch(self, path):
        now = time.time()
        with self.lock:
            hit = self.cache.get(path)
        if hit and now - hit[0] < BAZAAR_TTL:
            return hit[1]
        try:
            data, _ = get_json(FORUM + path, timeout=20, retries=2, headers={"Accept": "application/json"})
        except Exception as e:
            if hit:            # 论坛暂时不可用（含 429）：返回旧数据
                return hit[1]
            log.warning("论坛读取失败 %s: %s", path, e)
            raise RuntimeError("官方论坛暂时无法访问，请稍后再试")
        with self.lock:
            if len(self.cache) > 500:
                for k in sorted(self.cache, key=lambda k: self.cache[k][0])[:250]:
                    del self.cache[k]
            self.cache[path] = (now, data)
        return data

    @staticmethod
    def avatar(tpl, size=64):
        if not tpl:
            return None
        url = tpl.replace("{size}", str(size))
        return url if url.startswith("http") else FORUM + url

    def topic_row(self, t, users):
        op = next((p.get("user_id") for p in t.get("posters") or [] if "Original Poster" in (p.get("description") or "")), None)
        u = users.get(op) or {}
        title = t.get("title") or ""
        pinned = bool(t.get("pinned"))
        return {"id": t["id"], "title": title, "slug": t.get("slug"), "kind": bazaar_kind(title) or ("" if pinned else "wts"),   # 没写前缀的基本都是出售
                "sp": bazaar_sp(title), "isk": bazaar_isk(title),
                "created_at": t.get("created_at"), "last_posted_at": t.get("last_posted_at") or t.get("bumped_at"),
                "posts": t.get("posts_count") or 0, "views": t.get("views"), "likes": t.get("like_count"),
                "closed": bool(t.get("closed") or t.get("archived")), "pinned": pinned,
                "author": u.get("name") or (u.get("username") or "").replace("_", " ") or None, "avatar": self.avatar(u.get("avatar_template")),
                "last_poster": (t.get("last_poster_username") or "").replace("_", " ") or None}

    def topics(self, q):
        page = max(0, min(int(q.get("page") or 0), 200))
        order = q.get("order") or "activity"
        if order not in ("activity", "created", "sp", "price", "ratio"):
            raise ValueError("order 只能是 activity / created / sp / price / ratio")
        term = (q.get("q") or "").strip()[:100]
        cid, slug = BAZAAR_CAT
        if order in ("sp", "price", "ratio"):
            # 按技能点 / 价格 / 每技能点价格：从索引里排（只含后台已读过 1 楼的近期帖子）
            asc = q.get("dir") == "asc"
            with self.lock:
                rows = [self.merge(v["row"]) for v in self.index.values()]
            rows = [r for r in rows if r[order] is not None and not r["closed"] and r["kind"] in ("wts", "auction")
                    and (not term or term.lower() in r["title"].lower())]
            rows.sort(key=lambda r: r[order], reverse=not asc)
            out = {"page": page, "more": len(rows) > (page + 1) * 30, "forum": f"{FORUM}/c/{slug}/{cid}", "indexed": len(self.index),
                   "topics": rows[page * 30:(page + 1) * 30]}
            return self.with_zh(out) if q.get("zh") else out
        if term:
            sq = f"{term} #{slug.split('/')[1]} order:{'latest_topic' if order == 'created' else 'latest'}"
            d = self.fetch("/search.json?" + urllib.parse.urlencode({"q": sq, "page": page + 1}))
            # 搜索结果的主题不带发帖人：用命中的帖子补（优先 1 楼）
            ops = {}
            for p in sorted(d.get("posts") or [], key=lambda p: p.get("post_number") or 0, reverse=True):
                ops[p.get("topic_id")] = p
            rows = []
            for t in d.get("topics") or []:
                if t.get("category_id") != cid:
                    continue
                p = ops.get(t["id"]) if (ops.get(t["id"]) or {}).get("post_number") == 1 else None
                rows.append(self.topic_row({**t, "posters": [{"user_id": 0, "description": "Original Poster"}] if p else []},
                                           {0: {"name": p.get("name"), "username": p.get("username"), "avatar_template": p.get("avatar_template")}} if p else {}))
            more = bool((d.get("grouped_search_result") or {}).get("more_full_page_results"))
        elif page == 0 and self.index:
            # 首屏：后台索引里的全部近期帖子（约 3 个月）+ 论坛第 1 页的实时数据，一次给全
            key = "created_at" if order == "created" else "last_posted_at"
            qs = {"order": "created", "ascending": "false"} if order == "created" else {}
            d = self.fetch(f"/c/{slug}/{cid}/l/latest.json?" + urllib.parse.urlencode(qs))
            users = {u["id"]: u for u in d.get("users") or []}
            tl = d.get("topic_list") or {}
            live = {t["id"]: self.topic_row(t, users) for t in tl.get("topics") or [] if t.get("category_id") == cid}
            with self.lock:
                rows = {k: v["row"] for k, v in self.index.items()}
            rows.update(live)
            rows = [r for r in rows.values() if r.get("pinned")] + sorted([r for r in rows.values() if not r.get("pinned")], key=lambda r: bazaar_ts(r.get(key)), reverse=True)
            more = bool(tl.get("more_topics_url"))
        else:
            # 加载更多：首屏已含索引本轮读过的前几页，接着读更早的论坛页（重复的帖子前端会去掉）
            fp = page + max(0, self.pages_done - 1) if self.index else page
            qs = {"page": fp, **({"order": "created", "ascending": "false"} if order == "created" else {})}
            d = self.fetch(f"/c/{slug}/{cid}/l/latest.json?" + urllib.parse.urlencode(qs))
            users = {u["id"]: u for u in d.get("users") or []}
            tl = d.get("topic_list") or {}
            rows = [self.topic_row(t, users) for t in tl.get("topics") or [] if t.get("category_id") == cid]
            more = bool(tl.get("more_topics_url"))
        out = {"page": page, "more": more, "forum": f"{FORUM}/c/{slug}/{cid}", "indexed": len(self.index), "topics": [self.merge(r) for r in rows]}
        return self.with_zh(out) if q.get("zh") else out

    def topic(self, q):
        tid = int(q.get("id") or 0)
        if tid <= 0:
            raise ValueError("缺少 id")
        d = self.fetch(f"/t/{tid}.json")
        if d.get("category_id") != BAZAAR_CAT[0]:
            raise KeyError("不是角色交易版块的帖子")
        ps = d.get("post_stream") or {}
        posts = list(ps.get("posts") or [])
        have = {p["id"] for p in posts}
        rest = [i for i in (ps.get("stream") or []) if i not in have][:max(0, BAZAAR_MAX_POSTS - len(posts))]
        for i in range(0, len(rest), 50):
            chunk = rest[i:i + 50]
            more = self.fetch(f"/t/{tid}/posts.json?" + "&".join("post_ids[]=%d" % x for x in chunk))
            posts += (more.get("post_stream") or {}).get("posts") or []
        title = d.get("title") or ""
        op_html = posts[0].get("cooked") or "" if posts and posts[0].get("post_number") == 1 else ""
        op = bazaar_text(op_html)
        body_sp = BODY_SP_RE.search(op)
        boards = bazaar_boards(op_html)
        return {"id": tid, "title": title, "url": f"{FORUM}/t/{d.get('slug') or 'topic'}/{tid}", "kind": bazaar_kind(title),
                "sp": bazaar_sp(title) or (float(body_sp.group(1).replace(",", ".")) if body_sp else None), "isk": bazaar_isk(title), "asks": bazaar_asks(op),
                "board": boards[0] if boards else None, "boards": boards, "created_at": d.get("created_at"), "last_posted_at": d.get("last_posted_at"),
                "posts_count": d.get("posts_count"), "views": d.get("views"), "closed": bool(d.get("closed") or d.get("archived")),
                "posts": [{"n": p.get("post_number"), "user": p.get("username"), "name": p.get("name") or (p.get("username") or "").replace("_", " "), "avatar": self.avatar(p.get("avatar_template")),
                           "created_at": p.get("created_at"), "updated_at": p.get("updated_at"), "reply_to": p.get("reply_to_post_number"),
                           "likes": next((a.get("count") for a in p.get("actions_summary") or [] if a.get("id") == 2), 0),
                           "html": p.get("cooked") or ""} for p in sorted(posts, key=lambda p: p.get("post_number") or 0)]}

    def translate(self, q):
        """帖子各楼层的中文机器翻译（Google 翻译，保留 HTML 标签）：只翻译本版块帖子，译文按原文缓存"""
        t = self.topic(q)
        key = lambda h: hashlib.md5(h.encode()).hexdigest()
        keep = sorted({n for p in t["posts"] for n in (p.get("name"), (p.get("user") or "").replace("_", " ")) if n and len(n) >= 3}, key=len, reverse=True)[:60]
        todo = [p["html"] for p in t["posts"] if p["html"] and key(p["html"]) not in self.zh]
        batch, size = [], 0
        for h in todo + [None]:
            if h is not None and (not batch or size + len(h) < 30000):
                batch.append(h)
                size += len(h)
                continue
            if batch:
                body = urllib.parse.urlencode([("q", zh_prep(x, keep)) for x in batch]).encode()
                try:
                    res, _ = get_json(TRANSLATE_URL, timeout=30, retries=2, data=body,
                                      headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"})
                except Exception as e:
                    log.warning("翻译失败: %s", e)
                    raise RuntimeError("翻译服务暂时不可用")
                for src, zh in zip(batch, res or []):
                    zh = zh[0] if isinstance(zh, list) else zh
                    if isinstance(zh, str):
                        zh = zh_fix(zh)
                        with self.lock:
                            self.zh[key(src)] = zh
                            while len(self.zh) > 20000:
                                self.zh.popitem(last=False)
            batch, size = ([h], len(h)) if h is not None else ([], 0)
        return {"id": t["id"], "title": self.zh_title(t["title"]),
                "posts": {p["n"]: self.zh.get(key(p["html"])) for p in t["posts"] if p["html"]}}

    def skills(self, q):
        """卖家在 1 楼贴的 qsna.eu 技能展示：读其公开接口（ESI 格式的技能列表），缓存 30 分钟"""
        t = self.topic(q)
        cid = int(q.get("char") or 0) or t.get("board")
        if not cid or cid not in t.get("boards"):
            return {"source": None, "skills": None}
        d = self.board_data(cid)
        esi = d.get("esiData") or {}
        skills = [[s["skill_id"], s.get("trained_skill_level") or 0, s.get("skillpoints_in_skill") or 0]
                  for s in (esi.get("skills_info") or {}).get("skills") or [] if s.get("skill_id")]
        info = esi.get("public_info") or {}
        return {"source": "qsna.eu", "url": f"https://www.qsna.eu/eve/characters/{cid}/information", "character_id": cid,
                "name": d.get("characterName") or info.get("name"), "birthday": info.get("birthday"), "updated_at": d.get("updatedAt"),
                "total_sp": board_sp(d), "unallocated_sp": (esi.get("skills_info") or {}).get("unallocated_sp"),
                "implants": esi.get("implants_info") or [], "skills": skills if skills else None}

    def skillset(self, q):
        """索引里各帖技能展示角色的技能等级：{帖子ID: [[角色ID, 角色名, 总技能点, "技能ID:等级,…"], …]}"""
        with self.lock:
            out = {k: v["chars"] for k, v in self.index.items() if v.get("chars")}
            pending = sum(1 for v in self.index.values() if v.get("board") and "chars" not in v)
        return {"topics": out, "pending": pending}

    def board_data(self, cid):
        hit = self.boards.get(cid)
        if not hit or time.time() - hit[0] > 1800:
            try:
                d, _ = get_json(f"https://www.qsna.eu/api/eve/characters/{cid}", timeout=30, retries=2, headers={"Accept": "application/json"})
            except Exception as e:
                if not hit:
                    log.warning("qsna.eu 读取失败 %s: %s", cid, e)
                    raise RuntimeError("技能展示站 qsna.eu 暂时无法访问")
                d = hit[1]
            hit = (time.time(), d)
            with self.lock:
                self.boards[cid] = hit
                while len(self.boards) > 500:
                    self.boards.pop(next(iter(self.boards)))
        return hit[1] or {}

    def zh_titles(self, titles):
        """列表里的帖子标题：未翻译过的一次批量翻译（失败就不显示译文）"""
        todo = [t for t in dict.fromkeys(titles) if "t:" + t not in self.zh]
        for i in range(100, len(todo), 100):   # 一次最多翻 100 条
            self.zh_titles(todo[i:i + 100])
        todo = todo[:100]
        if todo:
            esc = lambda t: zh_prep(t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            try:
                res, _ = get_json(TRANSLATE_URL, timeout=20, retries=1, data=urllib.parse.urlencode([("q", esc(t)) for t in todo]).encode(),
                                  headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"})
                for t, zh in zip(todo, res or []):
                    zh = zh[0] if isinstance(zh, list) else zh
                    if isinstance(zh, str):
                        with self.lock:
                            self.zh["t:" + t] = html_lib.unescape(re.sub(r"<[^>]+>", "", zh_fix(zh))).strip()
            except Exception as e:
                log.warning("标题翻译失败: %s", e)
        return [self.zh.get("t:" + t) for t in titles]

    def with_zh(self, out):
        if q_zh := [r["title"] for r in out["topics"]]:
            for r, zh in zip(out["topics"], self.zh_titles(q_zh)):
                r["title_zh"] = zh
        return out

    def zh_title(self, title):
        k = "t:" + title
        if k not in self.zh:
            try:
                src = zh_prep(title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
                res, _ = get_json(TRANSLATE_URL, timeout=15, retries=1, data=urllib.parse.urlencode({"q": src}).encode(),
                                  headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"})
                zh = res[0][0] if isinstance(res[0], list) else res[0]
                zh = html_lib.unescape(re.sub(r"<[^>]+>", "", zh_fix(zh)))
                self.zh[k] = zh
            except Exception:
                return None
        return self.zh[k]


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


# ---------------------------------------------------------------- 本站深渊估价模型
# 算法照搬 MutaMarket 的估价器（MIT 许可，github.com/MutaMarket/MutaMarket src/estimator/forest.rs）：
# 每个深渊类型一个随机森林回归（自助采样的 CART 树取平均，每次分裂考虑全部特征，max_depth 20、min_samples_leaf 2），
# 在 ln(1 + 价格) 上拟合，5 折连续分组交叉验证得到 R² / MAE / NMAE。
# 不同之处：MutaMarket 的训练数据是他们记录的真实单件成交（会员数据，不公开），训练好的模型也只存在他们的数据库里；
# 本站用 EVE Ref 公开合同快照（约 30 分钟一份）里只卖一件深渊装备的合同：到期前消失的（疑似成交）权重加倍，
# 仍在挂的按挂牌价，所以整体偏向挂牌价。树的数量 100（他们 300），没有用原装备市场价做锚点。
# 只在 MutaMarket 没有这件装备（或是装配里自定义的属性）时使用。
class Forest:
    """numpy 随机森林；每棵树存成平铺数组：feature（-1 为叶）、threshold、left、right、value"""
    MAX_DEPTH, MIN_LEAF = 20, 2

    def __init__(self, trees):
        self.trees = trees

    @classmethod
    def fit(cls, X, y, n_trees=100, seed=42):
        import numpy as np
        rng = np.random.default_rng(seed)
        n = len(y)
        return cls([cls._tree(X, y, rng.integers(0, n, n)) for _ in range(n_trees)])

    @classmethod
    def _tree(cls, X, y, rows):
        import numpy as np
        feat, thr, left, right, val = [], [], [], [], []
        stack = [(rows, 0, -1, False)]
        while stack:
            idx, depth, parent, is_right = stack.pop()
            node = len(feat)
            ys = y[idx]
            mean = float(ys.mean())
            feat.append(-1); thr.append(0.0); left.append(0); right.append(0); val.append(mean)
            if parent >= 0:
                (right if is_right else left)[parent] = node
            n = len(idx)
            if depth >= cls.MAX_DEPTH or n < 2 * cls.MIN_LEAF or float(ys.var()) <= 1e-12:
                continue
            best, total = None, float(ys.sum())
            for f in range(X.shape[1]):
                xs = X[idx, f]
                order = np.argsort(xs, kind="stable")
                xs, yo = xs[order], ys[order]
                cl = np.cumsum(yo)[:-1]
                nl = np.arange(1, n)
                ok = (xs[1:] > xs[:-1] + 1e-7) & (nl >= cls.MIN_LEAF) & (n - nl >= cls.MIN_LEAF)
                if not ok.any():
                    continue
                proxy = np.where(ok, cl * cl / nl + (total - cl) ** 2 / (n - nl), -np.inf)
                i = int(proxy.argmax())
                if best is None or proxy[i] > best[0]:
                    t = xs[i] / 2 + xs[i + 1] / 2
                    best = (proxy[i], f, xs[i] if t == xs[i + 1] else t)
            if best is None:
                continue
            _, f, t = best
            feat[node], thr[node] = f, float(t)
            mask = X[idx, f] <= t
            stack.append((idx[~mask], depth + 1, node, True))
            stack.append((idx[mask], depth + 1, node, False))
        return (np.array(feat, dtype=np.int16), np.array(thr), np.array(left, dtype=np.int32), np.array(right, dtype=np.int32), np.array(val))

    def predict(self, X):
        import numpy as np
        out = np.zeros(len(X))
        rows = np.arange(len(X))
        for feat, thr, left, right, val in self.trees:
            node = np.zeros(len(X), dtype=np.int64)
            for _ in range(self.MAX_DEPTH + 1):
                f = feat[node]
                leaf = f < 0
                if leaf.all():
                    break
                go_left = X[rows, np.maximum(f, 0)] <= thr[node]
                node = np.where(leaf, node, np.where(go_left, left[node], right[node]))
            out += val[node]
        return out / len(self.trees)


def fit_abyssal(X, y):
    """在子进程里跑（训练是纯 numpy 小运算，放在服务进程里会长时间占住 GIL）：5 折交叉验证 + 全量训练"""
    import numpy as np
    n = len(y)
    # 5 折连续分组交叉验证（与 MutaMarket 相同），指标按 ISK 计算
    r2s, maes, nmaes, start = [], [], [], 0
    for fold in range(5):
        size = n // 5 + (fold < n % 5)
        test = np.arange(start, start + size)
        start += size
        train = np.setdiff1d(np.arange(n), test)
        pred = np.expm1(Forest.fit(X[train], y[train], n_trees=40).predict(X[test]))
        truth = np.expm1(y[test])
        ss = ((truth - truth.mean()) ** 2).sum()
        r2s.append(1 - ((truth - pred) ** 2).sum() / ss if ss else 0.0)
        mae = float(np.abs(truth - pred).mean())
        maes.append(mae)
        nmaes.append(mae / truth.mean() * 100 if truth.mean() else 0.0)
    return Forest.fit(X, y).trees, {"r2": float(np.mean(r2s)), "mae": float(np.mean(maes)), "nmae": float(np.mean(nmaes))}


class AbyssalModel:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.models = {}       # type_id -> (Forest, stats)
        self.trained_at = 0
        try:
            import numpy  # noqa: F401
            self.enabled = True
        except ImportError:
            self.enabled = False
            log.warning("没有 numpy：本站深渊估价模型不可用")
        if self.enabled:
            self.load()

    def load(self):
        import pickle
        for type_id, blob, stats in self.store.conn().execute("SELECT type_id, model, stats FROM abyssal_models"):
            try:
                self.models[type_id] = (Forest(pickle.loads(blob)), json.loads(stats))
            except Exception:
                log.warning("深渊模型 %s 读取失败", type_id)

    # ---- 训练数据：每份合同快照调用一次
    def ingest(self, rows, now):
        """rows: [(contract_id, item_id, type_id, source, mutator, price, issued, expires, attrs dict)]"""
        conn = self.store.conn()
        now = int(now)
        conn.executemany(
            """INSERT INTO abyssal_contracts(contract_id, item_id, type_id, source_type_id, mutator_type_id, price, issued, expires, first_seen, last_seen, gone, attrs)
               VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
               ON CONFLICT(contract_id) DO UPDATE SET price = excluded.price, last_seen = excluded.last_seen, gone = 0""",
            [(c, i, t, s, m, p, iss, exp, now, now, json.dumps(a, separators=(",", ":"))) for c, i, t, s, m, p, iss, exp, a in rows])
        if len(rows) > 500:   # 快照不完整时不判断谁消失了
            conn.execute("UPDATE abyssal_contracts SET gone = CASE WHEN expires > last_seen + 3600 THEN 1 ELSE 2 END WHERE gone = 0 AND last_seen < ?", (now,))
        conn.execute("DELETE FROM abyssal_contracts WHERE last_seen < ?", (now - 180 * 86400,))
        # 属性顺便存进单件缓存
        conn.executemany("INSERT OR IGNORE INTO abyssal_dyn(item_id, type_id, source_type_id, mutator_type_id, attrs) VALUES(?,?,?,?,?)",
                         [(i, t, s, m, json.dumps(a, separators=(",", ":"))) for c, i, t, s, m, p, iss, exp, a in rows])
        conn.commit()
        log.info("深渊模型训练数据：本次 %d 份单件合同", len(rows))
        if self.enabled and time.time() - self.trained_at > ABYSSAL_TRAIN_EVERY:
            self.trained_at = time.time()
            threading.Thread(target=self.train_all, daemon=True).start()

    def dataset(self, type_id):
        import numpy as np
        feats = ABYSSAL_FEATURES[type_id]
        rows = self.store.conn().execute(
            "SELECT price, gone, attrs FROM abyssal_contracts WHERE type_id = ? AND gone IN (0, 1) AND price >= 100000 ORDER BY contract_id", (type_id,)).fetchall()
        X, y, sold, listed = [], [], 0, 0
        for price, gone, attrs in rows:
            a = json.loads(attrs)
            x = [float(a.get(str(f), 0.0)) for f in feats]
            for _ in range(2 if gone == 1 else 1):   # 疑似成交权重加倍
                X.append(x); y.append(price)
            sold += gone == 1
            listed += gone == 0
        if not y:
            return None
        X, y = np.array(X), np.log1p(np.array(y))
        # 去掉离谱的挂牌价：对数价格偏离中位数超过 3.5 个 MAD
        med = np.median(y)
        mad = np.median(np.abs(y - med)) * 1.4826
        if mad > 0:
            keep = np.abs(y - med) <= 3.5 * mad
            X, y = X[keep], y[keep]
        return X, y, sold, listed

    def train_type(self, type_id, pool):
        import pickle
        data = self.dataset(type_id)
        if not data or len(data[1]) < ABYSSAL_MIN_ROWS:
            with self.lock:
                self.models.pop(type_id, None)
            conn = self.store.conn()
            conn.execute("DELETE FROM abyssal_models WHERE type_id = ?", (type_id,))
            conn.commit()
            return False
        X, y, sold, listed = data
        trees, metrics = pool.submit(fit_abyssal, X, y).result()
        stats = {"data_count": len(y), "sold": int(sold), "listed": int(listed), **metrics,
                 "trained_at": int(time.time()), "features": list(ABYSSAL_FEATURES[type_id])}
        conn = self.store.conn()
        conn.execute("INSERT OR REPLACE INTO abyssal_models(type_id, model, stats, trained_at) VALUES(?,?,?,?)",
                     (type_id, pickle.dumps(trees), json.dumps(stats), stats["trained_at"]))
        conn.commit()
        with self.lock:
            self.models[type_id] = (Forest(trees), stats)
        return True

    def train_all(self):
        import multiprocessing
        t0, ok = time.time(), 0
        with concurrent.futures.ProcessPoolExecutor(1, mp_context=multiprocessing.get_context("spawn")) as pool:
            for type_id in ABYSSAL_FEATURES:
                try:
                    ok += self.train_type(type_id, pool)
                except Exception:
                    log.exception("深渊模型 %s 训练失败", type_id)
        log.info("深渊模型：%d / %d 种已训练，用时 %.0f 秒", ok, len(ABYSSAL_FEATURES), time.time() - t0)

    def predict(self, type_id, attrs):
        import numpy as np
        with self.lock:
            m = self.models.get(type_id)
        if not m:
            return None, None
        forest, stats = m
        x = np.array([[float(attrs.get(f, attrs.get(str(f), 0.0))) for f in ABYSSAL_FEATURES[type_id]]])
        return float(np.expm1(forest.predict(x)[0])), stats

    def stats(self, q=None):
        """GET /api/v1/abyssal/estimator：本站模型各类型的数据量与交叉验证指标"""
        with self.lock:
            rows = [{"type_id": t, **s} for t, (_, s) in sorted(self.models.items())]
        counts = dict(self.store.conn().execute("SELECT type_id, COUNT(*) FROM abyssal_contracts WHERE gone IN (0, 1) GROUP BY type_id").fetchall())
        return {"enabled": self.enabled, "models": rows, "data": {str(k): v for k, v in counts.items()},
                "features": {str(k): list(v) for k, v in ABYSSAL_FEATURES.items()}}

    # ---- 单件属性：本站缓存 → ESI
    def dynamic(self, type_id, item_id):
        row = self.store.conn().execute("SELECT type_id, source_type_id, mutator_type_id, attrs FROM abyssal_dyn WHERE item_id = ?", (item_id,)).fetchone()
        if row:
            return {"type_id": row[0], "source_type_id": row[1], "mutator_type_id": row[2], "attrs": json.loads(row[3])}
        try:
            d, _ = get_json(f"{ESI}/dogma/dynamic/items/{type_id}/{item_id}/", timeout=20, retries=2)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                raise KeyError("ESI 读不到这件装备的突变属性")
            raise
        attrs = {str(a["attribute_id"]): a["value"] for a in d.get("dogma_attributes") or []}
        conn = self.store.conn()
        conn.execute("INSERT OR IGNORE INTO abyssal_dyn(item_id, type_id, source_type_id, mutator_type_id, attrs) VALUES(?,?,?,?,?)",
                     (item_id, type_id, d.get("source_type_id"), d.get("mutator_type_id"), json.dumps(attrs, separators=(",", ":"))))
        conn.commit()
        return {"type_id": type_id, "source_type_id": d.get("source_type_id"), "mutator_type_id": d.get("mutator_type_id"), "attrs": attrs}


def abyssal_estimate(abyssal, model, body):
    """POST /api/v1/abyssal/estimate {items: [{type_id, item_id} | {type_id, attrs: {属性ID: 值}}], mutamarket: true}
    每件：有 item_id 时先看 MutaMarket（只读，不导入），没有估价再用本站模型；只给属性时直接用本站模型"""
    items = body.get("items")
    if not isinstance(items, list) or not 0 < len(items) <= 50:
        raise ValueError("items 应为 1 ~ 50 件")
    use_muta = body.get("mutamarket", True) is not False
    abyssal.check_server(body.get("server"))

    def one(it):
        try:
            type_id = int(it.get("type_id"))
        except (TypeError, ValueError, AttributeError):
            return {"error": "需要 type_id"}
        out = {"type_id": type_id}
        item_id = it.get("item_id")
        attrs = it.get("attrs")
        if item_id is not None:
            try:
                item_id = int(item_id)
            except (TypeError, ValueError):
                return {**out, "error": "item_id 无效"}
            out["item_id"] = item_id
            if use_muta:
                try:
                    m = abyssal.module({}, item_id)
                    if m.get("estimated_value"):
                        return {**out, "value": m["estimated_value"], "source": "mutamarket", "model": m.get("model"),
                                "updated_at": m.get("estimated_value_updated_at"), "source_url": m.get("source_url")}
                except (KeyError, RuntimeError):
                    pass
            try:
                attrs = model.dynamic(type_id, item_id)["attrs"]
            except KeyError as e:
                return {**out, "error": str(e.args[0])}
            except Exception:
                return {**out, "error": "ESI 暂时读不到属性"}
        if not isinstance(attrs, dict):
            return {**out, "error": "需要 item_id 或 attrs"}
        if type_id not in ABYSSAL_FEATURES:
            return {**out, "error": "不是深渊装备"}
        if not model.enabled:
            return {**out, "error": "本站模型不可用"}
        value, stats = model.predict(type_id, attrs)
        if value is None:
            return {**out, "value": None, "source": "model", "error": "该类型数据不足，暂无本站模型"}
        return {**out, "value": value, "source": "model", "model": {k: stats[k] for k in ("data_count", "sold", "listed", "r2", "mae", "nmae", "trained_at")}}

    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        return {"results": list(pool.map(one, items))}


# ---------------------------------------------------------------- 开放接口
# ---------------------------------------------------------------- 交易中心倒卖排行
# 各服务器五个交易中心的全部挂单汇总（每个物品每个交易中心：最低卖 / 最高收、挂单量、最优价 5% 以内的深度）与所在星域日均成交，
# 前端按用户的技能与税费算各种买入 / 卖出组合的路线与利润（含近 24 小时 / 7 / 14 / 30 天成交中位价、最低价、最高价，hist=1 才返回）。宁静服直接用后台价格任务每小时读到的全部订单（不重复请求 ESI）；
# 国服第一次被请求时才开始抓取，之后每 30 分钟刷新，6 小时没人看就停。
# 日均成交：宁静服读 EVE Ref 每日市场历史（全星域全物品一个文件）；国服没有这种存档，按物品逐个查 ESI 历史（缓存 1 天，挂单额大的优先，每轮最多 ARB_HISTORY_BUDGET 次、24 分钟）。
# 每轮先用已知成交量发布一次结果，成交量读完再更新
ARB_TTL = 30 * 60
ARB_IDLE = 6 * 3600
ARB_DEPTH = 0.05
ARB_DAYS = 30
ARB_HISTORY_BUDGET = 12000
ARB_HISTORY_TTL = 86400
# 成交价统计的天数（1 = 最近一个完整交易日）：近 N 天每日成交均价的中位数、每日最低价里最低的、每日最高价里最高的
# （倒卖「中位价 / 最低价 / 最高价」收出用）。数据量大，接口加 hist=1 才返回这些字段
ARB_HIST_DAYS = (1, 7, 14, 30)
HIST_FIELDS = [f"{p}{k}" for p in ("med", "low", "high") for k in ARB_HIST_DAYS]
HIST_COLS = ", ".join(HIST_FIELDS)
ARB_FIELDS = ["sell", "buy", "sell_qty", "buy_qty", "sell_depth", "buy_depth", "daily", "avg", "daily7", "daily1"]


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def hist_stats(days, sinces):
    """days：[(日期, 均价, 最低, 最高)]（只含有成交的日子）；sinces：每个窗口的起始日期（含）→ (中位价..., 最低价..., 最高价...)"""
    med, low, high = [], [], []
    for s0 in sinces:
        w = [d for d in days if s0 and d[0] >= s0]
        med.append(median([d[1] for d in w]))
        lo = [d[2] for d in w if d[2]]
        hi = [d[3] for d in w if d[3]]
        low.append(min(lo) if lo else None)
        high.append(max(hi) if hi else None)
    return (*med, *low, *high)
EVEREF_HISTORY = "https://data.everef.net/market-history/{year}/market-history-{date}.csv.bz2"
NETEASE_ESI = "https://ali-esi.evepc.163.com/latest"
ARB_SERVERS = {
    "tq": {"esi": ESI, "qs": "", "hubs": HUB_STATIONS},
    "serenity": {"esi": NETEASE_ESI, "qs": "datasource=serenity", "hubs": HUB_STATIONS},
    "infinity": {"esi": NETEASE_ESI, "qs": "datasource=infinity",
                 "hubs": {10000016: 60000843, 10000002: 60003760, 10000043: 60006399, 10000032: 60001866, 10000030: 60004611}},
}


class HubArbitrage:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.data = {}          # server -> 最新快照（接口返回的结构）
        self.data_hist = {}     # server -> 同上，另带成交价统计字段（hist=1）
        self.state = {}         # server -> {"asked", "running", "progress", "error"}
        self.everef = {}        # 日期 -> {(星域, 物品): 成交量}（宁静服，只留交易中心星域）
        c = store.conn()
        with store.write_lock:
            c.execute("CREATE TABLE IF NOT EXISTS arb_volume(server TEXT, region INTEGER, type_id INTEGER, daily REAL, at INTEGER, avg REAL, PRIMARY KEY(server, region, type_id)) WITHOUT ROWID")
            cols = [r[1] for r in c.execute("PRAGMA table_info(arb_volume)")]
            if "avg" not in cols:
                c.execute("ALTER TABLE arb_volume ADD COLUMN avg REAL")
            if "daily7" not in cols:
                c.execute("ALTER TABLE arb_volume ADD COLUMN daily7 REAL")
            if "daily1" not in cols:
                c.execute("ALTER TABLE arb_volume ADD COLUMN daily1 REAL")
            for k in HIST_FIELDS:
                if k not in cols:
                    c.execute(f"ALTER TABLE arb_volume ADD COLUMN {k} REAL")
            c.commit()
        self.losses = (0, {})   # (时间, {舰船 type_id: 近 7 天被击毁艘数})，宁静服击杀库统计

    def ship_losses(self):
        """近 7 天各舰船被击毁数（击杀库，30 分钟缓存），「按销量选品」看舰船消耗用"""
        at, data = self.losses
        if time.time() - at < ARB_TTL:
            return data
        since = int(time.time()) - 7 * 86400
        try:
            rows = self.store.conn().execute("SELECT ship_type, COUNT(*) FROM killmails WHERE time >= ? AND ship_type IS NOT NULL GROUP BY ship_type", (since,)).fetchall()
            data = {str(t): n for t, n in rows}
        except Exception as e:
            log.warning("舰船损失统计失败：%s", e)
        self.losses = (time.time(), data)
        return data

    def medians(self, region):
        """宁静服倒卖汇总里某交易中心各物品近 1 / 7 / 14 / 30 天成交中位价：返回 t -> {"1": 价, "7": …} 或 None（还没汇总 / 没有成交）"""
        d = self.data_hist.get("tq")
        if not d or region not in d["hubs"]:
            return lambda t: None
        k, base, types = d["hubs"].index(region), len(ARB_FIELDS), d["types"]

        def get(t):
            row = types.get(str(t))
            h = row[k] if row else None
            if not h:
                return None
            m = {str(days): h[base + i] for i, days in enumerate(ARB_HIST_DAYS) if h[base + i] is not None}
            return m or None
        return get

    @staticmethod
    def add_order(book, o):
        b = book.setdefault(o["type_id"], ([], []))
        if o["is_buy_order"]:
            if (o.get("min_volume") or 1) <= 1:
                b[1].append((o["price"], o["volume_remain"]))
        else:
            b[0].append((o["price"], o["volume_remain"]))

    def snapshot(self, q):
        server = q.get("server") or "tq"
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        with self.lock:
            st = self.state.setdefault(server, {"asked": 0, "running": False, "progress": "", "error": None})
            st["asked"] = time.time()
            if server == "tq" and not self.data.get(server):
                st["progress"] = st["progress"] or "等待后台价格任务读完全部订单（服务启动后约 10 分钟）"
            elif server != "tq" and not st["running"]:
                st["running"] = True
                threading.Thread(target=self.loop, args=(server,), daemon=True).start()
            data = (self.data_hist if q.get("hist") == "1" else self.data).get(server)
        if not data:
            return {"server": server, "loading": True, "progress": st["progress"] or "排队中", "error": st["error"]}
        out = {**data, "progress": st["progress"]}
        if server == "tq":
            out["losses7"] = self.ship_losses()
        return out

    def loop(self, server):
        while True:
            try:
                self.refresh(server)
                self.state[server]["error"] = None
            except Exception as e:
                log.warning("倒卖排行（%s）刷新失败：%s", server, e)
                self.state[server]["error"] = str(e)
            time.sleep(ARB_TTL)
            with self.lock:
                if time.time() - self.state[server]["asked"] > ARB_IDLE:
                    self.state[server]["running"] = False
                    return

    def url(self, cfg, path, **params):
        qs = "&".join([*(f"{k}={v}" for k, v in params.items()), *([cfg["qs"]] if cfg["qs"] else [])])
        return f"{cfg['esi']}{path}?{qs}"

    def refresh(self, server):
        cfg = ARB_SERVERS[server]
        st = self.state[server]
        hubs = list(cfg["hubs"].items())
        station_hub = {stn: rid for rid, stn in hubs}
        books = {rid: {} for rid, _ in hubs}           # 星域 -> 物品 -> ([卖单], [收单])，元素 (价格, 数量)
        obs = getattr(self.store, "obs", None)
        snap = obs.snapshot(server) if obs else None   # 本站观察成交量（国服只在这个循环运行时有数据）

        def handle(orders):
            for o in orders:
                rid = station_hub.get(o["location_id"])
                if rid is not None:
                    self.add_order(books[rid], o)
                    if snap:
                        snap.add(o, rid)

        for i, (rid, _) in enumerate(hubs):
            first, headers = get_json(self.url(cfg, f"/markets/{rid}/orders/", order_type="all", page=1))
            handle(first or [])
            pages = int(headers.get("X-Pages") or 1)

            def page(n, rid=rid):
                data, _ = get_json(self.url(cfg, f"/markets/{rid}/orders/", order_type="all", page=n))
                return data or []
            with concurrent.futures.ThreadPoolExecutor(8) as pool:
                for n, data in enumerate(pool.map(page, range(2, pages + 1)), 2):
                    handle(data)
                    st["progress"] = f"读取订单：第 {i + 1}/{len(hubs)} 个交易中心 {n}/{pages} 页"
        if snap:                                       # 读取失败时上面已抛出，不会提交不完整的快照
            try:
                obs.commit(snap)
            except Exception:
                log.exception("观察成交量统计失败（%s）", server)
            del snap
        self.ingest(server, books)

    def ingest(self, server, books):
        """books：星域 -> 物品 -> ([卖单], [收单])；宁静服由后台价格任务每小时送来，国服由 refresh 自己读"""
        cfg = ARB_SERVERS[server]
        hubs = list(cfg["hubs"].items())
        st = self.state.setdefault(server, {"asked": 0, "running": False, "progress": "", "error": None})
        rows = {}
        for k, (rid, _) in enumerate(hubs):
            for t, (sells, buys) in books[rid].items():
                sells.sort()
                buys.sort(reverse=True)
                sell = sells[0][0] if sells else None
                buy = buys[0][0] if buys else None
                r = rows.setdefault(t, [None] * len(hubs))
                r[k] = [sell, buy, sum(v for _, v in sells), sum(v for _, v in buys),
                        sum(v for p, v in sells if p <= sell * (1 + ARB_DEPTH)) if sells else 0,
                        sum(v for p, v in buys if p >= buy * (1 - ARB_DEPTH)) if buys else 0, None]
        del books
        # 先用已有的成交量发布一次（直接成交的方式马上能用），读完成交量再更新
        known = self.known_volumes(server)
        self.publish(server, hubs, rows, known)
        st["progress"] = "读取成交量"
        log.info("倒卖排行（%s）订单已汇总：%d 种物品", server, len(rows))
        if server == "tq":
            daily = self.volumes_everef(cfg)
        else:
            daily = self.volumes_esi(server, cfg, rows, st, lambda d: self.publish(server, hubs, rows, d))
        self.publish(server, hubs, rows, daily)
        st["progress"] = ""

    def known_volumes(self, server):
        if server == "tq":
            return self.everef_daily() if self.everef else {}
        c = self.store.conn()
        return {(r, t): (d, a, d7, d1, *m) for r, t, d, a, d7, d1, *m in c.execute(f"SELECT region, type_id, daily, avg, daily7, daily1, {HIST_COLS} FROM arb_volume WHERE server=?", (server,))}

    def publish(self, server, hubs, rows, daily):
        types, full = {}, {}
        n = 4 + len(HIST_FIELDS)
        rnd = lambda v: round(v, 2) if v is not None else None
        for t, r in rows.items():
            out, out_full = [], []
            for k, (rid, _) in enumerate(hubs):
                h = r[k]
                if h is None:
                    out.append(None)
                    out_full.append(None)
                    continue
                d, a, d7, d1, *m = (tuple(daily.get((rid, t)) or ()) + (None,) * n)[:n]
                base = [*h[:6], rnd(d), round(a, 2) if a else None, rnd(d7), rnd(d1)]
                out.append(base)
                out_full.append(base + [rnd(v) for v in m])
            types[str(t)] = out
            full[str(t)] = out_full
        meta = {"server": server, "updated": iso(time.time()), "hubs": [rid for rid, _ in hubs], "volume_ready": len(daily)}
        self.data[server] = {**meta, "fields": ARB_FIELDS, "types": types}
        self.data_hist[server] = {**meta, "fields": ARB_FIELDS + HIST_FIELDS, "types": full}

    def volumes_everef(self, cfg):
        """EVE Ref 最近 30 天每日市场历史 → 交易中心星域日均成交（没有成交的日子不在文件里，按 30 天平均）"""
        regions = set(cfg["hubs"])
        today = dt.datetime.now(dt.timezone.utc).date()
        days = [today - dt.timedelta(days=d) for d in range(1, ARB_DAYS + 3)]
        for d in days:
            key = d.isoformat()
            if key in self.everef:
                continue
            try:
                body, _ = http_get(EVEREF_HISTORY.format(year=d.year, date=key), timeout=120)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue                   # 当天文件还没生成
                raise
            vol = {}
            rd = csv.DictReader(io.StringIO(bz2.decompress(body).decode()))
            for row in rd:
                rid = int(row["region_id"])
                if rid in regions:
                    v = int(float(row["volume"]))
                    vol[(rid, int(row["type_id"]))] = (v, v * float(row["average"] or 0), float(row.get("lowest") or 0), float(row.get("highest") or 0))
            if not vol:
                continue                       # 文件已建但还没有数据（只有表头），下次刷新再读
            self.everef[key] = vol
        keep = sorted(self.everef)[-ARB_DAYS:]
        for k in list(self.everef):
            if k not in keep:
                del self.everef[k]
        return self.everef_daily()

    def everef_daily(self):
        keep = sorted(self.everef)
        last7 = set(keep[-7:])
        last1 = keep[-1] if keep else None
        out = {}
        for k in keep:
            for key, (v, isk, *_) in self.everef[k].items():
                o = out.get(key) or (0, 0, 0, 0)
                out[key] = (o[0] + v, o[1] + isk, o[2] + (v if k in last7 else 0), o[3] + (v if k == last1 else 0))
        n = max(len(keep), 1)
        n7 = max(len(last7), 1)
        # 每天的成交均价 / 最低 / 最高，算近 N 天成交价统计（没成交的日子不算）
        prices = {}
        for k in keep:
            for key, (v, isk, *lh) in self.everef[k].items():
                if v:
                    prices.setdefault(key, []).append((k, isk / v, *(lh or (None, None))))
        sinces = [keep[-n] if len(keep) >= n else keep[0] for n in ARB_HIST_DAYS] if keep else []
        stats = {key: hist_stats(ps, sinces) for key, ps in prices.items()}
        # (30 天日均成交量, 成交均价, 7 天日均, 最近一天, 中位价..., 最低价..., 最高价...)
        none = (None,) * len(HIST_FIELDS)
        return {k: (v / n, isk / v if v else None, v7 / n7, v1, *stats.get(k, none)) for k, (v, isk, v7, v1) in out.items()}

    def volumes_esi(self, server, cfg, rows, st, on_progress):
        """国服：逐个查 ESI 星域历史（库里缓存 1 天）；挂单额大的物品优先，每轮最多 ARB_HISTORY_BUDGET 次"""
        hubs = list(cfg["hubs"])
        c = self.store.conn()
        cached = {(r, t): (d, at, a, d7, d1, *m) for r, t, d, at, a, d7, d1, *m in c.execute(f"SELECT region, type_id, daily, at, avg, daily7, daily1, {HIST_COLS} FROM arb_volume WHERE server=?", (server,))}
        now = int(time.time())
        todo = []
        for t, r in rows.items():
            for k, rid in enumerate(hubs):
                h = r[k]
                if h is None:
                    continue
                hit = cached.get((rid, t))
                if hit and now - hit[1] < ARB_HISTORY_TTL and (hit[2] is not None or not hit[0]) and hit[3] is not None and hit[4] is not None \
                        and (hit[-1] is not None or not hit[0]):   # 旧记录没有中位价的重新读
                    continue
                weight = (h[0] or 0) * h[2] + (h[1] or 0) * h[3]
                todo.append((-weight, rid, t))
        todo.sort()
        todo = todo[:ARB_HISTORY_BUDGET]
        deadline = time.time() + ARB_TTL * 0.8          # 本轮读不完的留到下一轮

        def one(item):
            _, rid, t = item
            if time.time() > deadline:
                return None
            try:
                hist, _ = get_json(self.url(cfg, f"/markets/{rid}/history/", type_id=t), retries=2)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    return None
                hist = []
            except Exception:
                return None
            today = dt.datetime.now(dt.timezone.utc).date()
            cutoff = (today - dt.timedelta(days=ARB_DAYS)).isoformat()
            cutoff7 = (today - dt.timedelta(days=7)).isoformat()
            vol = sum(d["volume"] for d in (hist or []) if d["date"] > cutoff)
            isk = sum(d["volume"] * d["average"] for d in (hist or []) if d["date"] > cutoff)
            vol7 = sum(d["volume"] for d in (hist or []) if d["date"] > cutoff7)
            cutoff1 = (today - dt.timedelta(days=2)).isoformat()     # 最近一个完整交易日（ESI 一般到昨天）
            recent = [d for d in (hist or []) if d["date"] > cutoff1]
            vol1 = max(recent, key=lambda d: d["date"])["volume"] if recent else 0
            days = sorted((d["date"], d["average"], d.get("lowest"), d.get("highest")) for d in (hist or []) if d["volume"])
            last = max(recent, key=lambda d: d["date"])["date"] if recent else ""
            sinces = [last if n == 1 else (today - dt.timedelta(days=n - 1)).isoformat() for n in ARB_HIST_DAYS]
            return rid, t, vol / ARB_DAYS, isk / vol if vol else None, vol7 / 7, vol1, *hist_stats(days, sinces)
        out = {k: (v[0], *v[2:]) for k, v in cached.items()}
        got = []

        def flush():
            with self.store.write_lock:
                c.executemany(f"INSERT OR REPLACE INTO arb_volume(server, region, type_id, daily, at, avg, daily7, daily1, {HIST_COLS}) VALUES(?,?,?,?,?,?,?,?{',?' * len(HIST_FIELDS)})",
                              [(server, rid, t, d, now, *rest) for rid, t, d, *rest in got])
                c.commit()
            out.update({(rid, t): (d, *rest) for rid, t, d, *rest in got})
            got.clear()
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            for n, res in enumerate(pool.map(one, todo), 1):
                if res:
                    got.append(res)
                if n % 100 == 0:
                    st["progress"] = f"读取成交量 {n}/{len(todo)}"
                if n % 1000 == 0:
                    flush()
                    on_progress(out)
        flush()
        return out


# ---------------------------------------------------------------- 星系击杀 24 小时
# ESI /universe/system_kills/ 只有「过去 1 小时」的快照（约每小时更新一次）；游戏星图显示的是 24 小时。
# 后台每 10 分钟看一次三个服的快照，按 Last-Modified 存下每一份（保留 26 小时），
# 接口 GET /api/v1/map/kills?server= 把最近 24 份快照累加：{ hours, from, to, systems: { 星系ID: [舰船, 太空舱, NPC] } }。
MAPK_POLL = 10 * 60
MAPK_KEEP = 26 * 3600


# ---------------------------------------------------------------- 公开合同存档
# EVE Ref 每 30 分钟抓一次全服公开合同（https://data.everef.net/public-contracts/history/），每份快照都处理：新合同连同物品存库，
# 上一份还在、这一份不见了的合同按到期时间判断——到期前消失：物品交换 / 快递视为已被接（推测成交；发起人手动删除也会这样，ESI 无法区分），
# 拍卖视为一口价成交；到期后消失：拍卖有出价按最高出价成交，否则算过期。同一发起人在同一份快照里新发了物品完全相同的合同，算「撤单重发」。
# 首次启动先按小时补最近 --contract-backfill 天的历史快照，之后跟着最新快照走；已结束的合同保留 --contract-keep 天。
# 数据放在单独的 SQLite（默认与 --db 同目录的 contracts.sqlite），不占用击杀库的写锁。
PC_HISTORY = "https://data.everef.net/public-contracts/history/{y}/{d}/"
PC_POLL = 600                   # 每 10 分钟看一次有没有新快照
PC_LIST_MAX = 100
PC_SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS pc(contract_id INTEGER PRIMARY KEY, type TEXT, status TEXT, region_id INTEGER, system_id INTEGER,
  location_id INTEGER, end_location_id INTEGER, issuer_id INTEGER, issuer_corp INTEGER, for_corp INTEGER, title TEXT,
  price REAL, reward REAL, collateral REAL, buyout REAL, volume REAL, days INTEGER, issued INTEGER, expires INTEGER,
  first_seen INTEGER, last_seen INTEGER, ended INTEGER, final REAL, bids INTEGER, top_bid REAL, value REAL, want REAL,
  n_items INTEGER, main_type INTEGER, repost INTEGER);
CREATE INDEX IF NOT EXISTS pc_status ON pc(status, ended);
CREATE INDEX IF NOT EXISTS pc_issued ON pc(status, issued);
CREATE INDEX IF NOT EXISTS pc_issuer ON pc(issuer_id);
CREATE TABLE IF NOT EXISTS pc_items(contract_id INTEGER, type_id INTEGER, quantity INTEGER, inc INTEGER, bpc INTEGER, runs INTEGER, me INTEGER, te INTEGER);
CREATE INDEX IF NOT EXISTS pc_items_c ON pc_items(contract_id);
CREATE INDEX IF NOT EXISTS pc_items_t ON pc_items(type_id, contract_id);
CREATE TABLE IF NOT EXISTS pc_meta(key TEXT PRIMARY KEY, value TEXT);
"""
PC_COLS = ("contract_id, type, status, region_id, system_id, location_id, end_location_id, issuer_id, issuer_corp, for_corp, title, price, reward, "
           "collateral, buyout, volume, days, issued, expires, first_seen, last_seen, ended, final, bids, top_bid, value, want, n_items, main_type, repost")
PC_SORT = {"issued": "issued", "ended": "ended", "expires": "expires", "price": "COALESCE(final, CASE type WHEN 'courier' THEN reward ELSE price END)",
           "value": "value", "ratio": "(COALESCE(final, price) / NULLIF(value, 0))", "volume": "volume"}


class ContractArchive:
    def __init__(self, store, path, backfill_days=3, keep_days=90):
        self.store = store
        self.path = path
        self.backfill_days = backfill_days
        self.keep = keep_days * 86400
        self.local = threading.local()
        self.lock = threading.Lock()
        self.state = {"snapshot": None, "processed": 0, "backfill": "等待中"}
        c = self.conn()
        c.executescript(PC_SCHEMA)
        c.commit()
        self.status = dict(c.execute("SELECT contract_id, status FROM pc"))   # 内存里的合同状态，判断新增 / 消失 / 重新出现
        self.state["snapshot"] = self.meta("last_snapshot")
        self.counts = None

    def conn(self):
        c = getattr(self.local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            c.execute("PRAGMA busy_timeout=30000")
            self.local.conn = c
        return c

    def meta(self, key, value=None):
        c = self.conn()
        if value is None:
            row = c.execute("SELECT value FROM pc_meta WHERE key=?", (key,)).fetchone()
            return row[0] if row else None
        c.execute("INSERT OR REPLACE INTO pc_meta VALUES(?, ?)", (key, str(value)))
        c.commit()

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                self.catch_up()
            except Exception:
                log.exception("公开合同存档失败")
            time.sleep(PC_POLL)

    @staticmethod
    def snapshot_files(day):
        """某天（UTC）的全部快照：[(时间戳, 地址)]"""
        url = PC_HISTORY.format(y=day.year, d=day.isoformat())
        try:
            body, _ = http_get(url, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            raise
        out = []
        for m in re.finditer(r'href="([^"]*public-contracts-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.v2\.tar\.bz2)"', body.decode("utf-8", "replace")):
            ts = epoch(f"{m.group(2)}T{m.group(3)}:{m.group(4)}:{m.group(5)}")
            out.append((ts, urllib.parse.urljoin(url, m.group(1))))
        return sorted(set(out))

    def catch_up(self):
        last = int(self.meta("last_ts") or 0)
        today = dt.datetime.now(dt.timezone.utc).date()
        start = today - dt.timedelta(days=self.backfill_days) if not last else dt.datetime.fromtimestamp(last, dt.timezone.utc).date()
        files = []
        day = start
        while day <= today:
            files += [f for f in self.snapshot_files(day) if f[0] > last]
            day += dt.timedelta(days=1)
        for i, (ts, url) in enumerate(files):
            # 补历史时按小时取（相邻快照不到 55 分钟的跳过），最后一份总是处理
            if i < len(files) - 1 and last and ts - last < 55 * 60 and time.time() - ts > 2 * 3600:
                continue
            self.state["backfill"] = "完成" if i == len(files) - 1 else f"正在补 {iso(ts)}（{i + 1}/{len(files)}）"
            try:
                body, _ = http_get(url, timeout=300)
            except Exception as e:
                log.warning("合同快照下载失败 %s：%s", url, e)
                continue
            self.ingest(body, ts)
            last = ts
            self.meta("last_ts", ts)
        self.state["backfill"] = "完成"

    def ingest(self, body, ts):
        started = time.time()
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:bz2") as tar:
            members = {m.name.rsplit("/", 1)[-1]: m for m in tar.getmembers()}

            def rows(name):
                return csv.DictReader(io.TextIOWrapper(tar.extractfile(members[name]), encoding="utf-8"))
            try:
                meta = json.load(tar.extractfile(members["meta.json"]))
                ts = epoch(meta.get("scrape_end") or iso(ts))
            except Exception:
                pass
            snap = {int(r["contract_id"]): r for r in rows("contracts.csv")}
            bids = {}
            if "contract_bids.csv" in members:
                for b in rows("contract_bids.csv"):
                    cid, amt = int(b["contract_id"]), float(b["amount"] or 0)
                    n, top = bids.get(cid, (0, 0))
                    bids[cid] = (n + 1, max(top, amt))
            open_ids = [cid for cid, st in self.status.items() if st == "open"]
            # 抓取不完整的快照（合同数骤降）不判断消失，避免把大批合同误记为成交
            partial = len(open_ids) > 5000 and len(snap) < len(open_ids) * 0.85
            new = [cid for cid in snap if cid not in self.status]
            new_set = set(new)
            items = collections.defaultdict(list)
            if new:
                for it in rows("contract_items.csv"):
                    cid = int(it["contract_id"])
                    if cid in new_set:
                        items[cid].append(it)
        num = lambda r, k: float(r.get(k) or 0)
        intv = lambda v: int(float(v)) if v not in (None, "") else None
        c = self.conn()
        with self.lock:
            ins, ins_items = [], []
            sig_new = collections.defaultdict(dict)    # 发起人 -> {物品签名: 新合同}
            for cid in new:
                r = snap[cid]
                its = items.get(cid, [])
                value = want = 0.0
                main, best = None, -1.0
                sig = []
                for it in its:
                    tid, qty = int(it["type_id"]), int(it["quantity"] or 1)
                    inc = it["is_included"] == "true"
                    bpc = it.get("is_blueprint_copy") == "true"
                    v = 0.0 if bpc else self.store.price(tid) * qty
                    if inc:
                        value += v
                        if v > best:
                            main, best = tid, v
                    else:
                        want += v
                    sig.append((tid, qty, inc))
                    ins_items.append((cid, tid, qty, int(inc), int(bpc), intv(it.get("runs")), intv(it.get("material_efficiency")), intv(it.get("time_efficiency"))))
                n, top = bids.get(cid, (0, None))
                issuer = int(r["issuer_id"] or 0)
                sig_new[issuer][tuple(sorted(sig))] = cid
                ins.append((cid, r["type"], "open", intv(r.get("region_id")), intv(r.get("system_id")), intv(r.get("start_location_id")),
                            intv(r.get("end_location_id")), issuer, intv(r.get("issuer_corporation_id")), int(r.get("for_corporation") == "true"),
                            r.get("title") or "", num(r, "price"), num(r, "reward"), num(r, "collateral"), num(r, "buyout") or None, num(r, "volume"),
                            intv(r.get("days_to_complete")), epoch(r["date_issued"]) if r.get("date_issued") else None,
                            epoch(r["date_expired"]) if r.get("date_expired") else None, ts, ts, None, None, n, top,
                            round(value, 2), round(want, 2), len(its), main, None))
            c.executemany(f"INSERT OR REPLACE INTO pc({PC_COLS}) VALUES({','.join('?' * 30)})", ins)
            c.executemany("INSERT INTO pc_items VALUES(?,?,?,?,?,?,?,?)", ins_items)
            # 重新出现（上一份抓漏了）：恢复为在售
            back = [cid for cid in snap if self.status.get(cid) not in (None, "open")]
            if back:
                c.executemany("UPDATE pc SET status='open', ended=NULL, final=NULL, repost=NULL WHERE contract_id=?", [(x,) for x in back])
            ended = {}
            if not partial:
                gone = [cid for cid in open_ids if cid not in snap]
                for chunk in range(0, len(gone), 900):
                    part = gone[chunk:chunk + 900]
                    q = f"SELECT contract_id, type, issuer_id, expires, price, reward, buyout, bids, top_bid FROM pc WHERE contract_id IN ({','.join('?' * len(part))})"
                    for cid, typ, issuer, exp, price, reward, buyout, nb, top in c.execute(q, part).fetchall():
                        if exp and exp <= ts + 60:
                            ended[cid] = ("done", top, None) if typ == "auction" and nb else ("expired", None, None)
                            continue
                        repost = None
                        if issuer in sig_new:
                            sig = tuple(sorted((t, q_, bool(i)) for t, q_, i in c.execute("SELECT type_id, quantity, inc FROM pc_items WHERE contract_id=?", (cid,))))
                            repost = sig_new[issuer].get(sig)
                        if repost:
                            ended[cid] = ("repost", None, repost)
                        elif typ == "auction" and not buyout:
                            ended[cid] = ("expired", None, None)      # 没有一口价的拍卖不能提前买走，只能是发起人撤掉
                        else:
                            ended[cid] = ("done", buyout if typ == "auction" else (reward if typ == "courier" else price), None)
                c.executemany("UPDATE pc SET status=?, final=?, repost=?, ended=? WHERE contract_id=?",
                              [(st, fin, rp, ts, cid) for cid, (st, fin, rp) in ended.items()])
            # 在售合同：更新最后出现时间与拍卖出价
            c.execute("UPDATE pc SET last_seen=? WHERE status='open'", (ts,))
            c.executemany("UPDATE pc SET bids=?, top_bid=? WHERE contract_id=?", [(n, top, cid) for cid, (n, top) in bids.items() if cid in snap])
            cut = ts - self.keep
            old = [x[0] for x in c.execute("SELECT contract_id FROM pc WHERE status!='open' AND ended < ?", (cut,))]
            for chunk in range(0, len(old), 900):
                part = old[chunk:chunk + 900]
                c.execute(f"DELETE FROM pc_items WHERE contract_id IN ({','.join('?' * len(part))})", part)
                c.execute(f"DELETE FROM pc WHERE contract_id IN ({','.join('?' * len(part))})", part)
            c.commit()
            for cid in new:
                self.status[cid] = "open"
            for cid in back:
                self.status[cid] = "open"
            for cid, (st, _, _) in ended.items():
                self.status[cid] = st
            for cid in old:
                self.status.pop(cid, None)
            self.counts = None
        self.meta("last_snapshot", iso(ts))
        self.state["snapshot"] = iso(ts)
        self.state["processed"] += 1
        kinds = collections.Counter(v[0] for v in ended.values())
        log.info("公开合同快照 %s：%d 份在售，新增 %d，结束 %s%s（%.1f 秒）", iso(ts), len(snap), len(new),
                 dict(kinds) or 0, "，快照不完整未判断消失" if partial else "", time.time() - started)

    # ---------------- 查询
    @staticmethod
    def row(r):
        d = dict(zip([x.strip() for x in PC_COLS.split(",")], r))
        for k in ("issued", "expires", "first_seen", "last_seen", "ended"):
            d[k] = iso(d[k]) if d[k] else None
        d["for_corp"] = bool(d["for_corp"])
        return d

    def summary(self):
        with self.lock:
            if self.counts is None:
                self.counts = dict(self.conn().execute("SELECT status, COUNT(*) FROM pc GROUP BY status").fetchall())
            return self.counts

    def list(self, q):
        where, args = [], []
        status = q.get("status") or "open"
        if status == "ended":
            where.append("status IN ('done','expired','repost')")
        elif status != "all":
            if status not in ("open", "done", "expired", "repost"):
                raise ValueError("status 只能是 open / done / expired / repost / ended / all")
            where.append("status=?")
            args.append(status)
        if q.get("type"):
            if q["type"] not in ("item_exchange", "auction", "courier"):
                raise ValueError("type 只能是 item_exchange / auction / courier")
            where.append("type=?")
            args.append(q["type"])
        for key, col in (("region", "region_id"), ("system", "system_id"), ("issuer", "issuer_id"), ("location", "location_id")):
            if q.get(key):
                where.append(f"{col}=?")
                args.append(int(q[key]))
        items = [int(x) for x in (q.get("item") or "").split(",") if x.strip().isdigit()][:200]
        if items:
            want = q.get("side") == "want"
            where.append(f"contract_id IN (SELECT contract_id FROM pc_items WHERE type_id IN ({','.join('?' * len(items))}) AND inc=?)")
            args += items + [0 if want else 1]
        if q.get("q"):
            where.append("title LIKE ?")
            args.append("%" + q["q"].replace("%", "") + "%")
        price = PC_SORT["price"]
        if q.get("min"):
            where.append(f"{price} >= ?")
            args.append(float(q["min"]))
        if q.get("max"):
            where.append(f"{price} <= ?")
            args.append(float(q["max"]))
        if q.get("since"):
            where.append("COALESCE(ended, issued) >= ?")
            args.append(int(time.time()) - int(float(q["since"]) * 86400))
        sort = q.get("sort") or ("ended" if status in ("done", "expired", "repost", "ended") else "issued")
        if sort not in PC_SORT:
            raise ValueError("sort 只能是 " + " / ".join(PC_SORT))
        order = "ASC" if q.get("order") == "asc" else "DESC"
        limit = max(1, min(PC_LIST_MAX, int(q.get("limit") or 50)))
        offset = max(0, int(q.get("offset") or 0))
        cond = (" WHERE " + " AND ".join(where)) if where else ""
        c = self.conn()
        total = c.execute(f"SELECT COUNT(*) FROM pc{cond}", args).fetchone()[0]
        rows = [self.row(r) for r in c.execute(f"SELECT {PC_COLS} FROM pc{cond} ORDER BY {PC_SORT[sort]} {order} NULLS LAST, contract_id DESC LIMIT ? OFFSET ?",
                                                args + [limit, offset])]
        if rows:
            ids = [r["contract_id"] for r in rows]
            its = collections.defaultdict(list)
            for cid, tid, qty, inc in c.execute(f"SELECT contract_id, type_id, quantity, inc FROM pc_items WHERE contract_id IN ({','.join('?' * len(ids))})", ids):
                its[cid].append([tid, qty, inc])
            for r in rows:
                lst = its.get(r["contract_id"], [])
                r["items"] = lst[:8]
        out = {"total": total, "offset": offset, "list": rows, "snapshot": self.state["snapshot"], "counts": self.summary()}
        # 只查一种物品时：近 30 天「只卖这一种物品」的推测成交合同，给出单价中位数
        if len(items) == 1 and q.get("side") != "want":
            since = int(time.time()) - 30 * 86400
            units = sorted(fin / qty for fin, qty in c.execute(
                "SELECT p.final, SUM(i.quantity) FROM pc p JOIN pc_items i ON i.contract_id=p.contract_id "
                "WHERE p.status='done' AND p.type!='courier' AND p.ended>=? AND p.contract_id IN (SELECT contract_id FROM pc_items WHERE type_id=? AND inc=1) "
                "GROUP BY p.contract_id HAVING COUNT(*)=SUM(i.type_id=?) AND SUM(i.inc)=COUNT(*) AND SUM(i.bpc)=0", (since, items[0], items[0])) if fin and qty)
            if units:
                out["sold"] = {"type_id": items[0], "count": len(units), "median": units[len(units) // 2], "min": units[0], "max": units[-1], "days": 30}
        return out

    def detail(self, cid):
        c = self.conn()
        r = c.execute(f"SELECT {PC_COLS} FROM pc WHERE contract_id=?", (cid,)).fetchone()
        if not r:
            raise KeyError(cid)
        d = self.row(r)
        d["items"] = [dict(zip(("type_id", "quantity", "is_included", "is_blueprint_copy", "runs", "me", "te"), (t, q, bool(i), bool(b), ru, me, te)))
                      for t, q, i, b, ru, me, te in c.execute("SELECT type_id, quantity, inc, bpc, runs, me, te FROM pc_items WHERE contract_id=?", (cid,))]
        if d["repost"]:
            d["repost_status"] = self.status.get(d["repost"])
        prev = c.execute("SELECT contract_id FROM pc WHERE repost=?", (cid,)).fetchone()
        if prev:
            d["repost_of"] = prev[0]
        return d

    def info(self, q=None):
        return {**self.state, "counts": self.summary()}


class MapKills:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.cache = {}
        c = store.conn()
        with store.write_lock:
            c.execute("CREATE TABLE IF NOT EXISTS map_kill_snap(server TEXT, at INTEGER, data TEXT, PRIMARY KEY(server, at)) WITHOUT ROWID")
            c.commit()

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            for server in ARB_SERVERS:
                try:
                    self.poll(server)
                except Exception as e:
                    log.warning("星系击杀快照（%s）失败：%s", server, e)
            time.sleep(MAPK_POLL)

    def poll(self, server):
        cfg = ARB_SERVERS[server]
        url = f"{cfg['esi']}/universe/system_kills/" + (f"?{cfg['qs']}" if cfg["qs"] else "")
        data, headers = get_json(url, timeout=30)
        if data is None:
            return
        try:
            at = int(email.utils.parsedate_to_datetime(headers.get("Last-Modified")).timestamp())
        except Exception:
            return
        c = self.store.conn()
        if c.execute("SELECT 1 FROM map_kill_snap WHERE server=? AND at=?", (server, at)).fetchone():
            return
        packed = {str(x["system_id"]): [x.get("ship_kills") or 0, x.get("pod_kills") or 0, x.get("npc_kills") or 0] for x in data}
        with self.store.write_lock:
            c.execute("INSERT OR REPLACE INTO map_kill_snap VALUES (?,?,?)", (server, at, json.dumps(packed, separators=(",", ":"))))
            c.execute("DELETE FROM map_kill_snap WHERE at < ?", (at - MAPK_KEEP,))
            c.commit()
        with self.lock:
            self.cache.pop(server, None)

    def totals(self, q):
        server = q.get("server") or "tq"
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        with self.lock:
            hit = self.cache.get(server)
        if hit:
            return hit
        rows = self.store.conn().execute("SELECT at, data FROM map_kill_snap WHERE server=? ORDER BY at DESC LIMIT 24", (server,)).fetchall()
        systems = {}
        for _, data in rows:
            for sid, v in json.loads(data).items():
                t = systems.setdefault(sid, [0, 0, 0])
                t[0] += v[0]; t[1] += v[1]; t[2] += v[2]
        # 每份快照是它之前 1 小时的数据：覆盖范围从最早一份往前 1 小时到最新一份
        out = {"server": server, "hours": len(rows), "from": (rows[-1][0] - 3600) if rows else None, "to": rows[0][0] if rows else None, "systems": systems}
        with self.lock:
            self.cache[server] = out
        return out


# ---------------------------------------------------------------- 势力战争趋势
# 后台每 5 分钟看一次三个服的 /fw/systems/（ESI 约 30 分钟更新一次），按 Last-Modified 记下每个星系的胜利点快照（保留 3 天）。
# 接口 GET /api/v1/fw/trend?server=：各星系最近 6 小时胜利点推进速度（最小二乘，占领方变了就从变化后算起）、
#   按这个速度到达阈值的预计小时数、进入「可被夺取」的时间、最近一次易主时间。只是按趋势估算，游戏里没有公开的倒计时。
FW_POLL = 5 * 60
FW_KEEP = 3 * 86400
FW_WINDOW = 6 * 3600


class FwTracker:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.cache = {}         # server -> 接口结果
        c = store.conn()
        with store.write_lock:
            c.execute("CREATE TABLE IF NOT EXISTS fw_snap(server TEXT, system_id INTEGER, at INTEGER, vp INTEGER, threshold INTEGER, occupier INTEGER, contested TEXT,"
                      " PRIMARY KEY(server, system_id, at)) WITHOUT ROWID")
            c.commit()

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            for server in ARB_SERVERS:
                try:
                    self.poll(server)
                except Exception as e:
                    log.warning("势力战争快照（%s）失败：%s", server, e)
            time.sleep(FW_POLL)

    def poll(self, server):
        cfg = ARB_SERVERS[server]
        url = f"{cfg['esi']}/fw/systems/" + (f"?{cfg['qs']}" if cfg["qs"] else "")
        data, headers = get_json(url, timeout=30)
        if not data:
            return
        try:
            at = int(email.utils.parsedate_to_datetime(headers.get("Last-Modified")).timestamp())
        except Exception:
            at = int(time.time())
        c = self.store.conn()
        last = c.execute("SELECT MAX(at) FROM fw_snap WHERE server=?", (server,)).fetchone()[0]
        if last and at <= last:
            return
        with self.store.write_lock:
            c.executemany("INSERT OR REPLACE INTO fw_snap VALUES (?,?,?,?,?,?,?)",
                          [(server, s["solar_system_id"], at, s.get("victory_points") or 0, s.get("victory_points_threshold") or 0,
                            s.get("occupier_faction_id"), s.get("contested")) for s in data])
            c.execute("DELETE FROM fw_snap WHERE at < ?", (at - FW_KEEP,))
            c.commit()
        with self.lock:
            self.cache.pop(server, None)

    def trend(self, q):
        server = q.get("server") or "tq"
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        with self.lock:
            hit = self.cache.get(server)
        if hit:
            return hit
        rows = self.store.conn().execute("SELECT system_id, at, vp, threshold, occupier, contested FROM fw_snap WHERE server=? ORDER BY system_id, at", (server,)).fetchall()
        by = collections.defaultdict(list)
        for sid, *rest in rows:
            by[sid].append(rest)
        ats = sorted({r[1] for r in rows})
        systems = {}
        for sid, snaps in by.items():
            now_at, vp, thr, occ, state = snaps[-1]
            # 最近一次易主：往前找占领方不同的快照
            flipped = None
            for i in range(len(snaps) - 1, 0, -1):
                if snaps[i - 1][3] != snaps[i][3]:
                    flipped = snaps[i][0]
                    break
            vuln = None
            if state == "vulnerable":
                vuln = now_at
                for s in reversed(snaps):
                    if s[4] != "vulnerable" or s[3] != occ:
                        break
                    vuln = s[0]
            pts = [(s[0], s[1]) for s in snaps if s[0] >= now_at - FW_WINDOW and s[0] >= (flipped or 0)]
            rate = None
            if len(pts) >= 2 and pts[-1][0] - pts[0][0] >= 25 * 60:
                n = len(pts)
                mx = sum(p[0] for p in pts) / n
                my = sum(p[1] for p in pts) / n
                den = sum((p[0] - mx) ** 2 for p in pts)
                rate = sum((p[0] - mx) * (p[1] - my) for p in pts) / den * 3600 if den else None
            eta = None
            if rate and thr and state != "vulnerable":
                eta = (thr - vp) / rate if rate > 0 else (-vp / rate if vp > 0 else None)   # 负速度：多久回落到 0
            systems[sid] = {"rate": round(rate) if rate is not None else None, "eta": round(eta, 2) if eta is not None and eta >= 0 else None,
                            "pts": len(pts), "vuln_since": vuln, "flipped": flipped}
        out = {"server": server, "updated": ats[-1] if ats else None, "since": ats[0] if ats else None, "snapshots": len(ats),
               "window_hours": FW_WINDOW // 3600, "systems": systems}
        with self.lock:
            self.cache[server] = out
        return out


# ---------------------------------------------------------------- 本站观察成交量
# 每次读到交易中心挂单快照，按 order_id 与上一份对比：剩余数量减少的部分计入 dec，到期前消失的订单的剩余数量计入 gone
# （成交完或撤单，无法区分）；新出现的订单不计。上一份快照只放内存（array 紧凑存储），重启后第一份只作基准
OBS_KEEP_DAYS = 31


class ObsSnapshot:
    """一份交易中心挂单快照（收集中）：region_ids 为该服务器交易中心星域，顺序即星域序号"""
    def __init__(self, server, region_ids):
        self.server = server
        self.regions = list(region_ids)
        self.index = {rid: k for k, rid in enumerate(self.regions)}
        self.ids, self.remain, self.types = array.array("q"), array.array("l"), array.array("l")
        self.flags, self.expires = array.array("b"), array.array("l")   # 星域序号 × 2 + 收单标记；到期 Unix 秒
        self.read_at = {}          # 星域序号 -> 第一次读到该星域挂单的时间（判断「到期前消失」用）

    def add(self, o, rid):
        k = self.index[rid]
        if k not in self.read_at:
            self.read_at[k] = time.time()
        s = o["issued"]
        issued = calendar.timegm((int(s[:4]), int(s[5:7]), int(s[8:10]), int(s[11:13]), int(s[14:16]), int(s[17:19])))
        self.ids.append(o["order_id"])
        self.remain.append(o["volume_remain"])
        self.types.append(o["type_id"])
        self.flags.append(k * 2 + bool(o["is_buy_order"]))
        self.expires.append(issued + int(o.get("duration") or 0) * 86400)

    def sorted(self):
        """按 order_id 排序并去重（翻页期间订单移动可能被读到两次），返回 (ids, remain, types, flags, expires)"""
        out = tuple(array.array(a.typecode) for a in (self.ids, self.remain, self.types, self.flags, self.expires))
        src = (self.ids, self.remain, self.types, self.flags, self.expires)
        last = None
        for i in sorted(range(len(self.ids)), key=self.ids.__getitem__):
            if self.ids[i] == last:
                continue
            last = self.ids[i]
            for a, b in zip(out, src):
                a.append(b[i])
        return out


class ObsVolume:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.prev = {}             # server -> (星域列表, 排序后的快照数组)
        self.pruned = None         # 上次清理旧数据的日期
        c = store.conn()
        with store.write_lock:
            c.execute("CREATE TABLE IF NOT EXISTS obs_volume(server TEXT, region INTEGER, type_id INTEGER, day TEXT, sell_dec INTEGER, buy_dec INTEGER, "
                      "sell_gone INTEGER, buy_gone INTEGER, PRIMARY KEY(server, region, type_id, day)) WITHOUT ROWID")
            # 每个服务器每个星域：第一次有对比结果的时间、最近一次快照时间（Unix 秒）
            c.execute("CREATE TABLE IF NOT EXISTS obs_state(server TEXT, region INTEGER, since INTEGER, last INTEGER, PRIMARY KEY(server, region)) WITHOUT ROWID")
            c.commit()

    def snapshot(self, server):
        return ObsSnapshot(server, ARB_SERVERS[server]["hubs"])

    def commit(self, snap):
        """一份完整快照（全部交易中心星域都读成功）与上一份对比，结果累加进 obs_volume"""
        now = time.time()
        cur = snap.sorted()
        n_new = len(cur[0])
        snap.ids = snap.remain = snap.types = snap.flags = snap.expires = None
        with self.lock:
            prev = self.prev.get(snap.server)
            self.prev[snap.server] = (snap.regions, cur)
        if prev and prev[0] != snap.regions:
            prev = None
        agg = {}                   # (星域序号, 物品) -> [卖单减少, 收单减少, 卖单消失, 收单消失]
        if prev:
            pi, pr, pt, pf, pe = prev[1]
            ni, nr = cur[0], cur[1]
            present = {f >> 1 for f in cur[3]}      # 本轮一单都没有的星域不算消失（防止异常的空结果）
            j, nn = 0, len(ni)
            for i in range(len(pi)):
                oid = pi[i]
                while j < nn and ni[j] < oid:
                    j += 1
                f = pf[i]
                if j < nn and ni[j] == oid:
                    d = pr[i] - nr[j]
                    if d <= 0:
                        continue
                    k = f & 1
                elif f >> 1 in present and pe[i] > snap.read_at.get(f >> 1, now):
                    d, k = pr[i], 2 + (f & 1)
                else:
                    continue
                v = agg.get((f >> 1, pt[i]))
                if v is None:
                    v = agg[(f >> 1, pt[i])] = [0, 0, 0, 0]
                v[k] += d
        day = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%d")
        rows = [(snap.server, snap.regions[k], t, day, *v) for (k, t), v in agg.items()]
        c = self.store.conn()
        with self.store.write_lock:
            c.executemany("INSERT INTO obs_volume VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server, region, type_id, day) DO UPDATE SET "
                          "sell_dec = sell_dec + excluded.sell_dec, buy_dec = buy_dec + excluded.buy_dec, "
                          "sell_gone = sell_gone + excluded.sell_gone, buy_gone = buy_gone + excluded.buy_gone", rows)
            c.executemany("INSERT INTO obs_state VALUES(?,?,?,?) ON CONFLICT(server, region) DO UPDATE SET "
                          "since = COALESCE(since, excluded.since), last = excluded.last",
                          [(snap.server, rid, int(now) if prev else None, int(now)) for rid in snap.regions])
            if self.pruned != day:
                cutoff = dt.datetime.fromtimestamp(now - OBS_KEEP_DAYS * 86400, dt.timezone.utc).strftime("%Y-%m-%d")
                c.execute("DELETE FROM obs_volume WHERE day < ?", (cutoff,))
                self.pruned = day
            c.commit()
        log.info("观察成交量（%s）：%d 条交易中心挂单%s", snap.server, n_new, f"，{len(rows)} 种物品 / 星域有变化" if prev else "（基准快照）")

    def query(self, q):
        server = q.get("server") or "tq"
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        try:
            type_id = int(q.get("type") or "")
            hubs = list(ARB_SERVERS[server]["hubs"])
            regions = [int(x) for x in q["regions"].split(",") if x.strip()] if q.get("regions") else hubs
        except ValueError:
            raise ValueError("type / regions 应为数字") from None
        if type_id <= 0 or not regions or len(regions) > len(hubs) or not set(regions) <= set(hubs):
            raise ValueError("type 或 regions 无效（regions 只能是该服务器的交易中心星域）")
        regions = list(dict.fromkeys(regions))
        cutoff = dt.datetime.fromtimestamp(time.time() - (OBS_KEEP_DAYS - 1) * 86400, dt.timezone.utc).strftime("%Y-%m-%d")
        c = self.store.conn()
        marks = ",".join("?" * len(regions))
        out = {"server": server, "since": {}, "last": {}, "regions": {str(r): [] for r in regions}}
        for rid, since, last in c.execute(f"SELECT region, since, last FROM obs_state WHERE server=? AND region IN ({marks})", (server, *regions)):
            out["since"][str(rid)] = iso(since) if since else None
            out["last"][str(rid)] = iso(last) if last else None
        for rid, *row in c.execute(f"SELECT region, day, sell_dec, buy_dec, sell_gone, buy_gone FROM obs_volume WHERE server=? AND type_id=? AND day >= ? "
                                   f"AND region IN ({marks}) ORDER BY day", (server, type_id, cutoff, *regions)):
            out["regions"][str(rid)].append(row)
        return out


# ---------------------------------------------------------------- 钱包成交存档
# 浏览器把自己的 ESI 令牌带过来，服务器代为读取钱包成交 / 税费 / 订单 / 工业任务并长期存档（ESI 只给最近 30 天左右）。
# 令牌只用于本次请求，不落盘、不写日志；内存里只记令牌哈希 -> 已校验的角色
WALLET_SYNC_GAP = 15 * 60       # 同一角色两次同步的最小间隔
WALLET_FORCE_GAP = 60           # 手动强制同步的最小间隔
WALLET_AUTH_TTL = 15 * 60       # 令牌校验结果缓存
WALLET_RATE = 30                # 每个 IP 每分钟最多请求次数
WALLET_PAGES_MAX = 100          # 分页接口最多读多少页
WALLET_SCHEMA = """
CREATE TABLE IF NOT EXISTS wallet_tx(server TEXT, tx_id INTEGER, char_id INTEGER, date INTEGER, type_id INTEGER, qty INTEGER, price REAL,
  is_buy INTEGER, location_id INTEGER, client_id INTEGER, PRIMARY KEY(server, tx_id));
CREATE INDEX IF NOT EXISTS wallet_tx_type ON wallet_tx(server, char_id, type_id);
-- 交易税（context_id = 成交 tx_id）与中介费（context_id = 订单 order_id），amount 为正数
CREATE TABLE IF NOT EXISTS wallet_fee(server TEXT, ref_id INTEGER, char_id INTEGER, date INTEGER, kind TEXT, amount REAL, context_id INTEGER, PRIMARY KEY(server, ref_id));
CREATE INDEX IF NOT EXISTS wallet_fee_ctx ON wallet_fee(server, char_id, context_id);
CREATE TABLE IF NOT EXISTS wallet_order(server TEXT, order_id INTEGER, char_id INTEGER, type_id INTEGER, PRIMARY KEY(server, order_id));
-- 制造（1）/ 反应（9、11）任务，只存已完成（delivered / ready）；qty = 流程 × 每流程产量
CREATE TABLE IF NOT EXISTS ind_job(server TEXT, job_id INTEGER, char_id INTEGER, product_type_id INTEGER, activity_id INTEGER, runs INTEGER, qty INTEGER,
  status TEXT, date INTEGER, location_id INTEGER, PRIMARY KEY(server, job_id));
CREATE INDEX IF NOT EXISTS ind_job_type ON ind_job(server, char_id, product_type_id);
-- 每个角色最近一次同步时间、存档最早成交时间、令牌权限（位：1 订单，2 工业任务）
CREATE TABLE IF NOT EXISTS wallet_sync(server TEXT, char_id INTEGER, at INTEGER, first_date INTEGER, scopes INTEGER, PRIMARY KEY(server, char_id));
"""
WALLET_TABLES = ("wallet_tx", "wallet_fee", "wallet_order", "ind_job", "wallet_sync")


class EsiUnavailable(Exception):
    """ESI 读取失败（5xx / 超时等），与令牌无效（PermissionError）区分"""


class Wallet:
    def __init__(self, store, industry=None):
        self.store, self.industry = store, industry
        self.lock = threading.Lock()
        self.auth = {}             # sha256(令牌) -> (server, 角色, 过期时间)
        self.char_locks = {}       # (server, 角色) -> 锁：同一角色的同步串行，避免并发重复读 ESI
        c = store.conn()
        with store.write_lock:
            c.executescript(WALLET_SCHEMA)
            c.commit()

    @staticmethod
    def params(body):
        server = body.get("server")
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        char, type_id = body.get("character_id"), body.get("type_id")
        if type(char) is not int or char <= 0 or (type_id is not None and (type(type_id) is not int or type_id <= 0)):
            raise ValueError("character_id / type_id 应为正整数")
        return server, char, type_id, body.get("force") is True

    def esi(self, server, path, token, **params):
        cfg = ARB_SERVERS[server]
        qs = urllib.parse.urlencode(params)
        url = f"{cfg['esi']}{path}?" + "&".join(x for x in (qs, cfg["qs"]) if x)
        try:
            return get_json(url, timeout=30, retries=2, fatal=(400, 401, 403, 404), headers={"Authorization": f"Bearer {token}"})
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise PermissionError(e.code) from None
            raise EsiUnavailable(f"ESI 返回 {e.code}") from None
        except Exception as e:
            raise EsiUnavailable(f"ESI 读取失败：{type(e).__name__}") from None

    def pages(self, server, path, token, **params):
        first, headers = self.esi(server, path, token, page=1, **params)
        out = list(first or [])
        for n in range(2, min(int(headers.get("X-Pages") or 1), WALLET_PAGES_MAX) + 1):
            data, _ = self.esi(server, path, token, page=n, **params)
            out += data or []
        return out

    def char_lock(self, server, char):
        with self.lock:
            now = time.time()
            if len(self.auth) > 10000:
                self.auth = {k: v for k, v in self.auth.items() if v[2] > now}
            return self.char_locks.setdefault((server, char), threading.Lock())

    def verify(self, key, server, char, token):
        """用令牌读钱包成交：ESI 返回 200 才认为令牌属于这个角色。返回成交列表"""
        try:
            tx, _ = self.esi(server, f"/characters/{char}/wallet/transactions/", token)
        except PermissionError:
            self.auth.pop(key, None)
            raise
        self.auth[key] = (server, char, time.time() + WALLET_AUTH_TTL)
        return tx or []

    def authed(self, key, server, char):
        a = self.auth.get(key)
        return bool(a) and a[0] == server and a[1] == char and a[2] > time.time()

    def sync(self, body, token):
        server, char, type_id, force = self.params(body)
        key = hashlib.sha256(token.encode()).hexdigest()
        c = self.store.conn()
        stale = None
        with self.char_lock(server, char):
            row = c.execute("SELECT at FROM wallet_sync WHERE server=? AND char_id=?", (server, char)).fetchone()
            now = time.time()
            due = row is None or now - row[0] >= WALLET_SYNC_GAP or (force and now - row[0] >= WALLET_FORCE_GAP)
            authed = self.authed(key, server, char)
            if due or not authed:
                try:
                    tx = self.verify(key, server, char, token)
                    if due:
                        self.fetch(server, char, token, tx)
                except EsiUnavailable as e:
                    # 没法确认身份（令牌没校验过）或还没有存档时不返回数据
                    if row is None or not self.authed(key, server, char):
                        raise
                    stale = str(e)
        out = self.result(server, char, type_id)
        if stale:
            out.update(stale=True, error=stale)
        return out

    def fetch(self, server, char, token, tx):
        """读取并存档：成交（已读到）、税费、订单物品、工业任务"""
        base = f"/characters/{char}"
        tx_rows = [(server, t["transaction_id"], char, epoch(t["date"]), t["type_id"], t["quantity"], t["unit_price"], int(bool(t.get("is_buy"))),
                    t.get("location_id"), t.get("client_id")) for t in tx]
        self.write(server, char, tx_rows)            # 成交先存（后面的读取失败也不丢）
        fees = [(server, e["id"], char, epoch(e["date"]), "tax" if e["ref_type"] == "transaction_tax" else "broker", abs(e.get("amount") or 0), e.get("context_id"))
                for e in self.pages(server, base + "/wallet/journal/", token) if e.get("ref_type") in ("transaction_tax", "brokers_fee")]
        scopes = 3
        orders = []
        try:
            for path in ("/orders/", "/orders/history/"):
                orders += [(server, o["order_id"], char, o["type_id"]) for o in self.pages(server, base + path, token)]
        except PermissionError:                     # 缺 esi-markets.read_character_orders.v1
            scopes &= ~1
        jobs = []
        try:
            data, _ = self.esi(server, base + "/industry/jobs/", token, include_completed="true")
            bp = {}
            if self.industry:
                try:
                    if self.industry.data is None:
                        self.industry.ensure()
                    bp = self.industry.data["bp"]
                except Exception as e:
                    log.warning("钱包同步：读取蓝图数据失败：%s", e)
            for j in data or []:
                if j.get("activity_id") in (1, 9, 11) and j.get("status") in ("delivered", "ready") and j.get("product_type_id"):
                    runs = j.get("runs") or 0
                    per = (bp.get(j["product_type_id"]) or [None, 1])[1] or 1
                    jobs.append((server, j["job_id"], char, j["product_type_id"], j["activity_id"], runs, runs * per, j["status"],
                                 epoch(j["end_date"]) if j.get("end_date") else None, j.get("output_location_id") or j.get("station_id")))
        except PermissionError:                     # 缺 esi-industry.read_character_jobs.v1
            scopes &= ~2
        self.write(server, char, tx_rows, fees, orders, jobs, scopes)
        log.info("钱包同步（%s 角色 %d）：成交 %d、税费 %d、订单 %d、工业任务 %d", server, char, len(tx_rows), len(fees), len(orders), len(jobs))

    def write(self, server, char, tx, fees=(), orders=(), jobs=(), scopes=None):
        c = self.store.conn()
        with self.store.write_lock:
            c.executemany("INSERT OR IGNORE INTO wallet_tx VALUES(?,?,?,?,?,?,?,?,?,?)", tx)
            c.executemany("INSERT OR IGNORE INTO wallet_fee VALUES(?,?,?,?,?,?,?)", fees)
            c.executemany("INSERT OR IGNORE INTO wallet_order VALUES(?,?,?,?)", orders)
            c.executemany("INSERT INTO ind_job VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(server, job_id) DO UPDATE SET "
                          "status = excluded.status, date = excluded.date, runs = excluded.runs, qty = excluded.qty, location_id = excluded.location_id", jobs)
            if scopes is not None:
                first = c.execute("SELECT MIN(date) FROM wallet_tx WHERE server=? AND char_id=?", (server, char)).fetchone()[0]
                c.execute("INSERT INTO wallet_sync VALUES(?,?,?,?,?) ON CONFLICT(server, char_id) DO UPDATE SET "
                          "at = excluded.at, first_date = excluded.first_date, scopes = excluded.scopes", (server, char, int(time.time()), first, scopes))
            c.commit()

    def result(self, server, char, type_id):
        c = self.store.conn()
        row = c.execute("SELECT at, first_date, scopes FROM wallet_sync WHERE server=? AND char_id=?", (server, char)).fetchone()
        at, first, scopes = row or (None, None, 3)
        out = {"character_id": char, "synced_at": iso(at) if at else None, "first_date": iso(first) if first else None,
               "scopes": {"orders": bool(scopes & 1), "jobs": bool(scopes & 2)}}
        if type_id:
            out["tx"] = [list(r) for r in c.execute("SELECT tx_id, date, qty, price, is_buy, location_id FROM wallet_tx WHERE server=? AND char_id=? AND type_id=? "
                                                     "ORDER BY date, tx_id", (server, char, type_id))]
            out["fees"] = [list(r) for r in c.execute(
                "SELECT f.date, f.kind, f.amount FROM wallet_fee f JOIN wallet_tx t ON t.server = f.server AND t.tx_id = f.context_id "
                "WHERE f.server=? AND f.char_id=? AND f.kind='tax' AND t.type_id=? "
                "UNION ALL SELECT f.date, f.kind, f.amount FROM wallet_fee f JOIN wallet_order o ON o.server = f.server AND o.order_id = f.context_id "
                "WHERE f.server=? AND f.char_id=? AND f.kind='broker' AND o.type_id=? ORDER BY 1",
                (server, char, type_id, server, char, type_id))]
            out["jobs"] = [list(r) for r in c.execute("SELECT job_id, date, qty, runs, activity_id, status, location_id FROM ind_job "
                                                       "WHERE server=? AND char_id=? AND product_type_id=? ORDER BY date, job_id", (server, char, type_id))]
        return out

    def delete(self, body, token):
        server, char, _, _ = self.params(body)
        key = hashlib.sha256(token.encode()).hexdigest()
        with self.char_lock(server, char):
            if not self.authed(key, server, char):
                self.verify(key, server, char, token)
            c = self.store.conn()
            with self.store.write_lock:
                n = sum(c.execute(f"DELETE FROM {t} WHERE server=? AND char_id=?", (server, char)).rowcount for t in WALLET_TABLES)
                c.commit()
        log.info("钱包存档已删除（%s 角色 %d）：%d 行", server, char, n)
        return {"deleted": n}


class RateLimiter:
    """按 IP 的令牌桶：容量 rate，每秒恢复 rate / 60 个（用于深渊装备导入、钱包存档）"""
    def __init__(self, rate):
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
        (("hubs", "arbitrage"), "hub_arbitrage", lambda q: api.arb.snapshot(q)),
        (("fw", "trend"), "fw_trend", lambda q: api.fw.trend(q)),
        (("map", "kills"), "map_kills", lambda q: api.mapk.totals(q)),
        (("wormholes", "activity"), "wh_activity", api.wh_activity),
        (("wormholes", "systems", "{n}"), "wh_system", lambda q, sid: api.wh_system(sid, q)),
        (("contracts",), "contracts", lambda q: api.pc.list(q)),
        (("contracts", "status"), "contracts_status", lambda q: api.pc.info(q)),
        (("contracts", "{n}"), "contract", lambda q, cid: api.pc.detail(cid)),
        (("kills",), "kills", lambda q: {k: v for k, v in api.feed(local(q)).items() if k != "notice"}),
        (("kills", "live"), "live", api.live),
        (("kills", "top"), "top", api.top),
        (("kills", "{n}"), "kill", lambda q, kid: api.kill(kid, local(q))),
        (("stats", "summary"), "summary", api.summary),
        (("battles",), "battles", api.battles),
        (("battle-report",), "battle_report", api.br),
        (("leaderboard",), "leaderboard", api.leaderboard),
        (("entities", "{s}", "{n}"), "entity", entity),
        (("pilots",), "pilots", api.pilots),
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
        (("abyssal", "estimator"), "abyssal_estimator", lambda q: abyssal.model.stats(q)),
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
# 击杀相关接口按 ?server= 分到各服务器的库（其余接口的 server 参数含义不变）
KB_ROUTES = ("status", "live", "battles", "battles/history", "feed", "top", "summary", "leaderboard", "search", "br", "shipfits")
V1_KB_ROUTES = {"kills", "live", "top", "kill", "summary", "battles", "battle_report", "leaderboard", "entity", "pilots", "search", "ship_fits"}


def kb_routes(api):
    return {"status": api.status, "live": api.live, "battles": api.battles, "battles/history": api.battle_history, "feed": api.feed, "top": api.top,
            "summary": api.summary, "leaderboard": api.leaderboard, "search": api.search, "br": api.br, "shipfits": api.shipfits}


def make_handler(api, static_dir, industry, abyssal, cn_apis=None, bazaar=None, cbg=None):
    apis = {"tq": api, **(cn_apis or {})}
    v1 = open_routes(api, industry, abyssal)
    v1_cn = {s: open_routes(a, industry, abyssal) for s, a in (cn_apis or {}).items()}
    post_limiter = RateLimiter(ABYSSAL_POST_RATE)
    bazaar = bazaar or Bazaar()
    cbg = cbg or Cbg()
    routes = {**kb_routes(api), "bpprices": api.bpprices, "couriers": api.couriers,
              "contracts": lambda q: api.pc.list(q), "contracts/status": lambda q: api.pc.info(q), "obsvol": lambda q: api.obs.query(q),
              "bazaar": bazaar.topics, "bazaar/topic": bazaar.topic, "bazaar/translate": bazaar.translate, "bazaar/skills": bazaar.skills,
              "bazaar/cbg": cbg.items, "bazaar/cbg/detail": cbg.detail,
              "bazaar/skillset": bazaar.skillset, "bazaar/cbg/skillset": cbg.skillset}
    kb = {s: kb_routes(a) for s, a in apis.items()}

    def kb_server(q):
        srv = q.get("server") or "tq"
        if srv not in apis:
            raise ValueError("server 只能是 " + " / ".join(apis))
        return srv
    wallet_limiter = RateLimiter(WALLET_RATE)

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
            cors = {"Access-Control-Allow-Origin": "*"}
            err = lambda code, msg, extra=None: self.send_json(code, {"error": {"code": code, "message": msg}}, {**cors, **(extra or {})})
            if not fn:
                return err(404, "接口不存在，文档见 /api.html")
            srv = q.get("server") or "tq"
            if name in V1_KB_ROUTES and srv != "tq":
                if srv not in v1_cn:
                    return err(400, "server 只能是 " + " / ".join(apis))
                name, fn, args = match_route(v1_cn[srv], parts)
            try:
                return self.send_json(200, fn(q, *args), cors)
            except KeyError as e:
                if name in ("kill", "contract", "entity", "industry_blueprint", "industry_cost", "abyssal_module", "abyssal_list"):
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

        def wallet(self, path):
            # 钱包成交存档（同源调用，不带 CORS 头）；令牌只在本次请求里使用，不写日志
            if path not in ("/api/kb/wallet/sync", "/api/kb/wallet/delete"):
                return self.send_json(404, {"error": "not found"})
            ok, _, retry = wallet_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            auth = self.headers.get("Authorization") or ""
            token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
            if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,4096}", token):
                return self.send_json(403, {"error": "令牌无效或缺少钱包权限"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 4096:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON：{server, character_id, type_id, force}"})
            try:
                fn = api.wallet.sync if path.endswith("/sync") else api.wallet.delete
                return self.send_json(200, fn(body, token))
            except PermissionError:
                return self.send_json(403, {"error": "令牌无效或缺少钱包权限"})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("钱包存档错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def do_POST(self):
            # 钱包成交存档；其余是唯一的写入型开放接口：深渊装备导入 / 刷新估价（转发到 MutaMarket，按 IP 单独限流）
            url = urllib.parse.urlparse(self.path)
            if url.path.startswith("/api/kb/wallet/"):
                return self.wallet(url.path.rstrip("/"))
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Retry-After"}
            err = lambda code, msg, extra=None: self.send_json(code, {"error": {"code": code, "message": msg}}, {**cors, **(extra or {})})
            path = url.path.rstrip("/")
            if path not in ("/api/v1/abyssal/appraise", "/api/v1/abyssal/estimate"):
                return err(404, "接口不存在，文档见 /api.html")
            estimate = path.endswith("/estimate")
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= (65536 if estimate else 4096):
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return err(400, "请求体应为 JSON：{items: [...]}" if estimate else "请求体应为 JSON：{type_id, item_id}")
            if not estimate:   # 只读估价不限；导入 / 刷新会写入 MutaMarket，按 IP 限流
                ok, _, retry = post_limiter.take(self.client_ip())
                if not ok:
                    return err(429, f"查询太频繁，请 {retry} 秒后再试", {"Retry-After": str(retry)})
            try:
                return self.send_json(200, abyssal_estimate(abyssal, abyssal.model, body) if estimate else abyssal.appraise(body), cors)
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
            key = "/".join(parts)
            try:
                if key in KB_ROUTES:
                    return self.send_json(200, kb[kb_server(q)][key](q))
                if key in routes:      # battles/history 这类两段路径也在表里
                    return self.send_json(200, routes[key](q))
                if len(parts) == 3 and parts[0] == "entity":
                    return self.send_json(200, apis[kb_server(q)].entity(parts[1], int(parts[2]), q))
                if len(parts) == 2 and parts[0] == "kill":
                    return self.send_json(200, apis[kb_server(q)].kill(int(parts[1]), q))
                if len(parts) == 2 and parts[0] == "contracts" and parts[1].isdigit():
                    return self.send_json(200, api.pc.detail(int(parts[1])))
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
    parser.add_argument("--days", type=int, default=180, help="宁静服历史导入与保留天数")
    parser.add_argument("--live", default="auto", choices=["auto", "r2z2", "redisq", "poll", "off"],
                        help="实时数据来源；redisq 已停用，等同 r2z2")
    parser.add_argument("--static", help="同时托管的前端静态目录（本地 / 演示环境）")
    parser.add_argument("--industry-dir", help="制造接口读取 industry-data.json / map-data.json 的目录（默认依次找 --static、仓库前端目录、/opt/eve/dist）")
    parser.add_argument("--system-regions", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "system_regions.json"))
    parser.add_argument("--contract-db", help="公开合同存档数据库（默认与 --db 同目录的 contracts.sqlite）")
    parser.add_argument("--contract-backfill", type=int, default=3, help="首次启动补多少天的历史合同快照（按小时）")
    parser.add_argument("--contract-keep", type=int, default=90, help="已结束的公开合同保留天数")
    parser.add_argument("--cn", default="serenity,infinity", help="同时收录哪些国服的击杀（逗号分隔，off 关闭）")
    parser.add_argument("--cn-days", type=int, default=0, help="国服击杀保留天数（0 = 永久保存）")
    parser.add_argument("--cn-db-dir", help="国服击杀库目录（默认与 --db 同目录，文件名 kb-<服务器>.sqlite）")
    parser.add_argument("--cn-queue", help="KM 广播队列名（默认按 --db 路径生成；同一台机器上的两个实例不能共用，否则会互相抢走击杀）")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    with open(args.system_regions, encoding="utf-8") as fh:
        system_regions = {int(k): v for k, v in json.load(fh).items()}
    store = Store(args.db, system_regions, args.days + 1)
    store.abyssal_model = AbyssalModel(store)
    store.arb = HubArbitrage(store)
    store.obs = ObsVolume(store)
    Workers(store, args.days, "r2z2" if args.live == "redisq" else args.live).start()
    api = Api(store)
    api.arb = store.arb
    api.fw = FwTracker(store)
    api.fw.start()
    api.mapk = MapKills(store)
    api.mapk.start()
    api.pc = ContractArchive(store, args.contract_db or os.path.join(os.path.dirname(os.path.abspath(args.db)), "contracts.sqlite"),
                             args.contract_backfill, args.contract_keep)
    api.pc.start()
    threading.Thread(target=api.warm, daemon=True).start()
    threading.Thread(target=lambda: (time.sleep(30), api.battle_history({"days": 30})), daemon=True).start()   # 历史会战先算好一份
    here = os.path.dirname(os.path.abspath(__file__))
    industry = Industry(store, [args.industry_dir, args.static, os.path.dirname(here), "/opt/eve/dist"])
    api.obs = store.obs
    api.wallet = Wallet(store, industry)
    abyssal = Abyssal(store)
    abyssal.model = store.abyssal_model
    cn_apis = {}
    cn_dir = args.cn_db_dir or os.path.dirname(os.path.abspath(args.db))
    queue = args.cn_queue or "emt-" + hashlib.md5(os.path.abspath(args.db).encode()).hexdigest()[:10]
    for name in [s.strip() for s in args.cn.split(",") if s.strip() and s.strip() != "off"]:
        if name not in CN_KB:
            parser.error(f"--cn 只能是 {' / '.join(CN_KB)}")
        cn_store = Store(os.path.join(cn_dir, f"kb-{name}.sqlite"), dict(system_regions), args.cn_days + 1 if args.cn_days else 0, server=name)
        CnWorkers(cn_store, queue).start()
        cn_apis[name] = Api(cn_store)
        threading.Thread(target=cn_apis[name].warm, daemon=True).start()
    GLOSSARY.dirs = [args.static, os.path.dirname(here), "/opt/eve/dist"]
    bazaar = Bazaar(os.path.join(os.path.dirname(os.path.abspath(args.db)), "bazaar-index.json")).start()
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(api, args.static, industry, abyssal, cn_apis, bazaar, Cbg().start()))
    log.info("击杀记录服务已启动 http://%s:%d", args.bind, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
