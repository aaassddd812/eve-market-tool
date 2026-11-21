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
  GET /api/kb/gank?system=&days=30            高安疑似强爆：某星系的次数、各时段出现概率、主要团伙；不带 system 时为强爆最多的高安星系
  GET /api/kb/feed?cursor=&limit=&ship=&system=&constellation=&region=&character=&corporation=&alliance=&side=&min=&space=&solo=&npc=&gank=&sort=time|value&dir=desc|asc
                                              击杀列表（最新在前）；side=kills|losses|all
                                              本地只保留 --days 天；带筛选条件时翻完本地记录后自动改为实时查询 zKillboard（不入库）
  GET /api/kb/live?after=N                    实时收录的新击杀（星图闪烁 / 弹幕），返回新的游标
  GET /api/kb/br?systems=1,2&start=T&end=T     战场统计：指定星系与时间段（Unix 秒）内的全部玩家击杀及攻击者（前端按联盟分阵营统计）
  POST /api/kb/br/km[?server=]                 战场统计：按指定的击杀（粘贴的游戏内击杀链接、列表里选中的击杀）统计，body {kills: [[id, hash], …]}
  GET /api/kb/battles?window=60&min=20        疑似会战：时间窗（分钟）内同一星系被击毁舰船数 ≥ min（不含太空舱与 1000 万 ISK 以下的击杀）
  GET /api/kb/battles/history?days=30         最近 N 天全部疑似会战，含双方阵营划分、损失 / 击毁与战损比（缓存 10 分钟）
  GET /api/kb/battles/pilot?character=ID&days=180  这个人物最近 N 天参加过的会战（受本地保留期限制，返回实际天数）
  GET /api/kb/top?days=7&limit=8              指定天数内价值最高的损失
  GET /api/kb/summary?hours=24                指定小时内的总损失（含每小时分布）
  GET /api/kb/leaderboard?days=30&side=losses|kills&by=character|corporation|alliance&metric=value|count
  GET /api/kb/search?q=                       搜索人物 / 军团 / 联盟
  GET /api/kb/entity/<kind>/<id>?days=30      人物 / 军团 / 联盟统计（含成员明细）
  GET /api/kb/kill/<id>                       击杀邮件详情与逐项估价（原文按需取自 ESI，本地不保存）
  GET /api/kb/shipfits?ship=ID&days=7[&limit=N][&kills=ID,…] 某型舰船最近 N 天（≤ 保留期）阵亡时的装配，相同装配合并计数（入库时从原文提取存库；缺的按需取自 ESI）
  GET /api/kb/bazaar?page=&order=activity|created&q=   官方论坛角色交易版块（宁静服）帖子列表 / 搜索（代理，缓存 2 分钟）
  GET /api/kb/bazaar/topic?id=                帖子详情（全部楼层，最多 200 层）
  GET /api/kb/bazaar/translate?id=            帖子各楼层的中文机器翻译（Google 翻译，按原文缓存）
  GET /api/kb/bazaar/skills?id=               卖家贴的 qsna.eu 技能展示（技能 ID、等级、技能点）
  GET /api/kb/bazaar/cbg                      晨曦：网易藏宝阁在售与公示期角色（缓存 10 分钟）
  GET /api/kb/bazaar/cbg/detail?id=           藏宝阁角色详情：技能、钱包、安全等级、军团历史、舰船与装配
  GET /api/kb/bazaar/skillset                 宁静：索引里各帖技能展示角色的技能等级（列表按「能开什么船 / 技能几级」筛选）
  GET /api/kb/bazaar/cbg/skillset             晨曦：藏宝阁各角色的技能等级（后台每 10 分钟补齐）
  GET /api/kb/bazaar/sale?server=infinity     曙光：玩家自挂的在售角色（POST /api/kb/bazaar/sale/save|delete 带 ESI 令牌挂售 / 下架）
  GET /api/kb/bazaar/sale/detail?server=&id=  自挂角色详情（服务器从 ESI 读取的技能、钱包等快照）
  GET /api/kb/bazaar/sale/skillset?server=    自挂角色的技能等级
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
 POST /api/kb/sync/{register,pull,push,delete}  设置云同步：用户名 + 浏览器由密码派生的登录密钥；内容在浏览器里加密，服务器只存密文
  POST /api/kb/wallet/sync                    钱包成交存档：带浏览器的 ESI 令牌（Authorization），同步并返回某角色某物品的成交 / 税费 / 工业任务
  POST /api/kb/wallet/delete                  删除某角色的全部钱包存档（同样校验令牌）
  GET  /api/kb/wh/sos?server=&system=         虫洞求救：被困在虫洞里的玩家发布的求救（不带 system 时列出全部未过期的）
  POST /api/kb/wh/sos/{save,delete}           发布 / 撤下求救：带该角色的 ESI 令牌（需要位置权限），所在星系由服务器从 ESI 读取
  GET  /api/kb/plaza?server=&kind=&corp=&char=&id=  广场：招新 / 组队 / 集市 / 其他帖子（未过期的，最近更新的在前）
  POST /api/kb/plaza/{save,delete,contracts}  发帖 / 撤下 / 列出自己可挂的公开合同：带该角色的 ESI 令牌，军团、舰队、合同由服务器从 ESI 读取
  POST /api/kb/plaza/admin/{check,delete}     站长删帖：仅 EVE_FEEDBACK_ADMIN_IPS 里的 IP
  POST /api/kb/feedback                       提交工单（右上角「定制」）：{kind, text, contact, page}，存进 feedback 表，返回 id + 查看凭证；
                                              设了环境变量 EVE_FEEDBACK_WECOM（企业微信机器人 key 或完整地址）时同时推送给站长
  POST /api/kb/feedback/{mine,follow}         提交者查看自己的工单（状态、回复）/ 追加说明：凭 id + 凭证
  POST /api/kb/lite/ping                      收益助手（lite/ 独立程序）启动上报 {iid, ver, server}，统计使用人数
  GET  /api/kb/lite/stats                     收益助手使用人数：仅 EVE_FEEDBACK_ADMIN_IPS 里的 IP（命令行 --lite-stats 同样内容）
  POST /api/kb/feedback/admin/{check,list,reply,status}  站长查看全部工单、回复、改状态：仅 EVE_FEEDBACK_ADMIN_IPS 里的 IP
  GET  /api/kb/notice?server=                 站点公告：发给这个服（或全部服务器）、没撤回也没过截止时间的，最新的在前；网页没看过的弹窗提示
  POST /api/kb/notice/admin/{list,save,off,delete}  站长发布 / 修改 / 撤回 / 删除公告：和工单管理一样，站长 IP 或云同步站长账号
  POST /api/kb/hosted/{start,update,status,stop}  服务器托管预警：网页关掉后由本服务检查击杀预警 / 虫洞求救 / 订单被压价，推送到企业微信 / 邮箱
                                              （用户单独授权，刷新令牌与推送账号加密保存，凭证管理；见 Hosted）
 POST /api/kb/ai/{info,chat}                 AI 助手：本站模型（环境变量 EVE_AI_*）或玩家自己的接口，工具在浏览器里执行
  击杀相关接口（status / feed / live / br / battles / top / summary / leaderboard / search / entity / kill / shipfits）可带 server=serenity|infinity 查国服

用法
  python3 kb_service.py --db kb.sqlite [--port 8291] [--days 180] [--cn-days 0] [--live auto|r2z2|poll|off] [--static DIR]
  宁静服保留 --days 天（首次启动从 EVE Ref 补齐这么多天，约每天 13 MB）；国服 --cn-days 为 0 时永久保存。
  --static 仅用于本地 / 演示环境：同时托管前端静态文件。
  查看工单：python3 kb_service.py --db kb.sqlite --feedback 20（列出最近 20 条后退出）
  回复工单：python3 kb_service.py --db kb.sqlite --feedback-reply 12 "已修复，刷新即可" [--feedback-done]
"""

import argparse
import array
import base64
import bz2
import calendar
import collections
import concurrent.futures
import csv
import ctypes
import datetime as dt
import email.message
import email.utils
import functools
import gzip
import hashlib
import hmac
import html as html_lib
import io
import ipaddress
import json
import logging
import math
import mimetypes
mimetypes.add_type("image/webp", ".webp")
import os
import re
import secrets
import smtplib
import socket
import sqlite3
import ssl
import tarfile
import threading
import unicodedata
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


def extract_fit(km):
    """击杀邮件 → 阵亡装配 {槽位: [[物品, 数量], …]}（存 km_fits；入库时就提取，对战模拟查装配不用再向 ESI 取原文）"""
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
BR_KM_MAX = 1000              # 按击杀统计：一次最多多少条击杀
BR_KM_FETCH = 300             # 按击杀统计：库里没有、要向 ESI 取原文的最多多少条（带 hash 的）
BR_KM_ZKILL = 20              # 按击杀统计：库里没有、也没带 hash 的，宁静服最多向 zKillboard 查多少条（zKillboard 要排队，每条约 1 秒）
BR_KM_FAILS = 10              # 按击杀统计：ESI 连续失败这么多次就不再取（国服 ESI 每 IP 每分钟最多 100 次错误）
BR_KM_RATE = 20               # 按击杀统计：每 IP 每分钟次数（令牌桶）
BR_DMG_WAIT = 12              # 战场统计：旧击杀缺伤害时向 ESI 补，最多等这么多秒，没补完的在后台继续
BATTLE_CACHE = 5              # 会战结果缓存（秒），前端与实时击杀同为 6 秒轮询
BATTLE_MIN_VALUE = 10_000_000  # 会战只统计价值 ≥ 1000 万 ISK 的击杀（过滤小船 / 诱饵等刷数）
BATTLE_MIN_KILLS = 20           # 历史会战：60 分钟内同一星系击毁 ≥ 20 艘（与实时疑似会战默认口径相同）
BATTLE_GAP = 20 * 60            # 同一星系相邻击杀间隔不超过 20 分钟算同一场；实时会战 20 分钟没有新击杀即视为结束
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

# 内存：HTTP 服务每个请求开一个新线程，glibc 默认最多开 8×核数 个 malloc 分配区，线程轮流落在不同分配区里，
# 每个分配区都停在自己的峰值、碎片还不回系统，常驻内存只涨不降。启动时限制为 2 个分配区，并定期 malloc_trim。
try:
    LIBC = ctypes.CDLL("libc.so.6")
    LIBC.mallopt(-8, 2)            # M_ARENA_MAX
except (OSError, AttributeError):  # 非 glibc（macOS / Windows / musl）
    LIBC = None
MEM_UPKEEP = 600                   # 每 10 分钟清一次过期缓存并归还空闲内存


def rss_mb():
    try:
        with open("/proc/self/status") as fh:
            return next(int(l.split()[1]) // 1024 for l in fh if l.startswith("VmRSS:"))
    except (OSError, StopIteration):
        return 0


def mem_upkeep(stores):
    """清掉各库查询缓存里已过期的结果（缓存原先只在合同估价更新时整体清空，每 6 小时一次），再把空闲内存还给系统；每小时记一次内存。"""
    n = 0
    while True:
        time.sleep(MEM_UPKEEP)
        now = time.time()
        dropped = 0
        for st in stores:
            for k, (at, _) in list(st.cache.items()):
                if now - at > CACHE_TTL:
                    st.cache.pop(k, None)
                    dropped += 1
        if LIBC:
            LIBC.malloc_trim(0)
        n += 1
        if n % 6 == 0:
            log.info("内存 %d MB · 查询缓存 %s 条 · 本轮清掉过期 %d 条", rss_mb(), "/".join(str(len(st.cache)) for st in stores), dropped)


# ---------------------------------------------------------------- HTTP 工具
def http_get(url, timeout=60, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        body = res.read()
        if res.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body, res.headers


# 头像 / 图标中转：分享图片在浏览器里直连图片服务器常常很慢或卡住，失败时改走这里（只允许 EVE 官方与网易的图片地址）。
# 内存里按 LRU 缓存最近的图片（总共不超过 IMG_CACHE_BYTES），浏览器端再按 Cache-Control 缓存一周
IMG_PROXY_RE = re.compile(r"^https://(images\.evetech\.net/(characters|corporations|alliances|types)/\d+/(portrait|logo|icon|render|bp|bpc)(\?size=\d+)?"
                          r"|image\.evepc\.163\.com/(Character|Corporation|Alliance|Type|Render)/\d+_\d+\.(jpg|png))$")
IMG_CACHE_BYTES = 48 * 1024 * 1024


class ImageProxy:
    def __init__(self):
        self.cache = collections.OrderedDict()   # url -> (bytes, content-type)；失败的记 (None, 状态码) 5 分钟
        self.size = 0
        self.lock = threading.Lock()

    def get(self, url):
        if not IMG_PROXY_RE.match(url):
            raise ValueError("不支持的图片地址")
        with self.lock:
            hit = self.cache.get(url)
            if hit:
                self.cache.move_to_end(url)
                if hit[0] is not None or time.time() < hit[2]:
                    return hit[0], hit[1]
        code, body, ctype = 502, None, None
        for attempt in range(3):
            try:
                body, headers = http_get(url, timeout=12)
                ctype = headers.get("Content-Type") or "image/png"
                break
            except urllib.error.HTTPError as e:
                code = e.code
                if e.code == 404:
                    break
            except Exception:
                pass
            time.sleep(0.5 * (attempt + 1))
        with self.lock:
            old = self.cache.pop(url, None)
            if old and old[0]:
                self.size -= len(old[0])
            if body:
                self.cache[url] = (body, ctype, 0)
                self.size += len(body)
                while self.size > IMG_CACHE_BYTES and self.cache:
                    _, (b, _, _) = self.cache.popitem(last=False)
                    self.size -= len(b or b"")
            else:
                self.cache[url] = (None, code, time.time() + 300)
        return (body, ctype) if body else (None, code)


# ESI 中转：有些网络打得开本站却连不上 CCP 的 ESI / 登录服务器，浏览器直连失败时改走这里（js/esi-relay.js）。
# 只转发到下面几个地址、只带白名单里的请求头，令牌原样转发，不记录不保存。
# ESI 按出口 IP 统计错误次数（每分钟 100 次就封一阵），本服务自己也要用 ESI：剩余次数低于 RELAY_ERR_FLOOR 时暂停中转
RELAY_HOSTS = {
    "esi": "https://esi.evetech.net/",
    "cnesi": "https://ali-esi.evepc.163.com/",
    "login": "https://login.eveonline.com/v2/oauth/token",
    "zkill": ZKILL,           # zKillboard 接口（只读）：与本服务自己的 zKillboard 请求共用间隔，结果缓存 RELAY_ZKILL_TTL 秒
}
RELAY_PATH_RE = re.compile(r"^[A-Za-z0-9_\-/.]{1,300}$")
RELAY_REQ_HEADERS = ("Authorization", "Content-Type", "Accept", "Accept-Language", "If-None-Match", "X-Compatibility-Date", "X-Tenant")
RELAY_RES_HEADERS = ("Content-Type", "ETag", "Expires", "Last-Modified", "X-Pages", "Retry-After", "X-Esi-Error-Limit-Remain",
                     "X-Esi-Error-Limit-Reset", "X-Ratelimit-Group", "X-Ratelimit-Limit", "X-Ratelimit-Remaining", "X-Ratelimit-Used",
                     "X-Compatibility-Date", "Warning")
RELAY_RATE = 600            # 每个 IP 每分钟最多中转次数（市场订单翻页一次就几十个请求）
RELAY_LOGIN_RATE = 20       # 换令牌：每个 IP 每分钟
RELAY_BODY_LIMIT = 256 * 1024
RELAY_ERR_FLOOR = 20
RELAY_ZKILL_RATE = 90       # zKillboard 中转：每个 IP 每分钟（战场统计查旧时间段时一个星系一个月最多翻 60 页）
RELAY_ZKILL_TTL = 600
RELAY_ZKILL_WAIT = 40       # 排队等 zKillboard 间隔最多等这么久，超过返回 503（人多时不让请求一直挂着）


class EsiRelay:
    def __init__(self):
        self.lock = threading.Lock()
        self.pause_until = 0.0
        self.zk_cache = collections.OrderedDict()   # 网址 -> (时间, 响应体)

    def zkill(self, url):
        """zKillboard 中转：命中缓存直接返回；否则排队按 ZKILL_GAP 间隔请求（与 zkill_get 共用锁），返回 (状态码, 响应头列表, 响应体)"""
        with self.lock:
            hit = self.zk_cache.get(url)
            if hit and time.time() - hit[0] < RELAY_ZKILL_TTL:
                return 200, [("Content-Type", "application/json")], hit[1]
        if not _zkill_lock.acquire(timeout=RELAY_ZKILL_WAIT):
            return 503, [("Retry-After", "10")], None
        try:
            wait = _zkill_last[0] + ZKILL_GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            status, headers, data = self.forward("GET", url, {"Accept": "application/json"}, None)
        finally:
            _zkill_last[0] = time.time()
            _zkill_lock.release()
        if status == 200 and data is not None:
            with self.lock:
                self.zk_cache[url] = (time.time(), data)
                self.zk_cache.move_to_end(url)
                while len(self.zk_cache) > 300:
                    self.zk_cache.popitem(last=False)
        return status, headers, data

    def target(self, key, rest, query):
        base = RELAY_HOSTS.get(key)
        if not base:
            raise ValueError("不支持的中转地址")
        if key == "login":
            if rest:
                raise ValueError("不支持的中转地址")
            return base
        if not RELAY_PATH_RE.match(rest) or ".." in rest:
            raise ValueError("不支持的中转地址")
        return base + rest + ("?" + query if query else "")

    def forward(self, method, url, headers, body):
        """返回 (状态码, 响应头列表, 响应体)；连不上返回 (502, [], None)"""
        if url.startswith(RELAY_HOSTS["esi"]) and time.time() < self.pause_until:
            return 503, [("Retry-After", str(int(self.pause_until - time.time()) + 1))], None
        req = urllib.request.Request(url, data=body, method=method,
                                     headers={"User-Agent": UA, "Accept-Encoding": "gzip", **headers})
        try:
            res = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            res = e
        except Exception:  # noqa: BLE001
            return 502, [], None
        with res:
            data = res.read()
            if res.headers.get("Content-Encoding") == "gzip":
                data = gzip.decompress(data)
            remain = res.headers.get("X-Esi-Error-Limit-Remain")
            if remain and remain.isdigit() and int(remain) < RELAY_ERR_FLOOR:
                reset = res.headers.get("X-Esi-Error-Limit-Reset") or "60"
                with self.lock:
                    self.pause_until = time.time() + (int(reset) if reset.isdigit() else 60)
                log.warning("ESI 错误额度剩 %s，暂停中转 %s 秒", remain, reset)
            out = [(k, res.headers[k]) for k in RELAY_RES_HEADERS if res.headers.get(k)]
            return res.getcode(), out, data


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
# ---------------- 击杀估价口径：中间价（默认，value 列）/ 卖价（value_sell 列，旧记录后台补齐前为 NULL，退回中间价）
# 每个请求在 Handler.api 里按查询参数 price=sell 设好本线程的口径；SQL 里写 {V} / {KV}（k.别名）/ {SUMMARY_COLS}，格式化时按口径展开
PRICE_MODE = threading.local()


def sell_mode():
    return getattr(PRICE_MODE, "sell", False)


class _ByMode:
    """f-string 里按当前线程的估价口径展开成不同 SQL 片段"""
    def __init__(self, mid, sell):
        self.mid, self.sell = mid, sell

    def __format__(self, spec):
        return self.sell if sell_mode() else self.mid

    __str__ = lambda self: self.__format__("")


def keep_mode(fn):
    """交给后台线程的计算沿用当前请求的估价口径"""
    m = sell_mode()

    def run(*a, **k):
        PRICE_MODE.sell = m
        try:
            return fn(*a, **k)
        finally:
            PRICE_MODE.sell = False
    return run


V = _ByMode("value", "COALESCE(value_sell, value)")
KV = _ByMode("k.value", "COALESCE(k.value_sell, k.value)")


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
-- 只保存玩家攻击者（NPC 不参与任何统计）；dmg 为造成的伤害，旧数据为 NULL（战场统计用到时再向 ESI 补）
CREATE TABLE IF NOT EXISTS attackers(km INTEGER, time INTEGER, char INTEGER, corp INTEGER, alliance INTEGER, ship INTEGER, dmg INTEGER);
CREATE INDEX IF NOT EXISTS att_char ON attackers(char, time);
CREATE INDEX IF NOT EXISTS att_corp ON attackers(corp, time);
CREATE INDEX IF NOT EXISTS att_alliance ON attackers(alliance, time);
CREATE INDEX IF NOT EXISTS att_km ON attackers(km);
CREATE INDEX IF NOT EXISTS att_ship ON attackers(ship, time);
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
-- 星系内天体坐标（击杀位置找最近天体用；向 ESI 取一次后永久保存）：data = [[类型, ID, 名称, x, y, z, 星门目的星系], ...]
CREATE TABLE IF NOT EXISTS celestials(system_id INTEGER PRIMARY KEY, data TEXT);
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
        if "dmg" not in {r[1] for r in conn.execute("PRAGMA table_info(attackers)")}:
            conn.execute("ALTER TABLE attackers ADD COLUMN dmg INTEGER")
        # 卖价估值：新入库的击杀同时算好；旧记录由 Workers.sell_backfill_loop 逐条向 ESI 重取补齐
        if "value_sell" not in {r[1] for r in conn.execute("PRAGMA table_info(killmails)")}:
            conn.execute("ALTER TABLE killmails ADD COLUMN value_sell REAL")
        # 击杀列表按价值排序（/feed?sort=value）：中间价 / 卖价口径各一个索引（第一次建要扫一遍表）
        conn.execute("CREATE INDEX IF NOT EXISTS km_val ON killmails(value)")
        conn.execute("CREATE INDEX IF NOT EXISTS km_vsell ON killmails(COALESCE(value_sell, value))")
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

    # ---------------- 卖价估值：吉他（国服为本服交易中心）最低卖价
    def price_sell(self, type_id, contracts=True):
        p = self.prices.get(type_id)
        cp = self.contract_prices.get(type_id) if contracts else None
        if not p:
            return cp or 0.0
        sell, buy, avg = p
        if sell:
            # 天价卖单（远高于全服均价）当挂单异常，改用均价；和中间价口径的处理一致
            if avg and buy and sell > buy * 10 and sell > avg * 10:
                return avg
            return sell
        if cp:                                   # 不能上市场的物品（旗舰等）：公开合同最低价
            return cp
        if buy and avg and buy * 10 < avg:
            return avg
        return buy or avg or 0.0

    def price_by_mode(self, type_id, contracts=True):
        return self.price_sell(type_id, contracts) if sell_mode() else self.price(type_id, contracts)

    def item_value(self, item, price=None):
        price = price or self.price
        qty = (item.get("quantity_destroyed") or 0) + (item.get("quantity_dropped") or 0)
        unit = 0.0 if item.get("singleton") == 2 else price(item["item_type_id"])  # 蓝图副本不计价
        total = unit * qty
        for child in item.get("items") or []:
            total += self.item_value(child, price)
        return total

    def km_value(self, km, price=None):
        price = price or self.price
        v = km["victim"]
        return price(v["ship_type_id"]) + sum(self.item_value(it, price) for it in v.get("items") or [])

    def km_values(self, km):
        """(中间价估值, 卖价估值)"""
        return self.km_value(km), self.km_value(km, self.price_sell)

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
            km_rows, att_rows, fit_rows = [], [], []
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
                    v["ship_type_id"], *self.km_values(km), len(attackers), int(len(players) == 1), int(not players),
                    v.get("character_id"), v.get("corporation_id"), v.get("alliance_id"),
                    final.get("character_id"), final.get("corporation_id"), final.get("alliance_id"), final.get("ship_type_id")))
                for a in players:
                    att_rows.append((kid, t, a["character_id"], a.get("corporation_id"), a.get("alliance_id"), a.get("ship_type_id"), a.get("damage_done") or 0))
                # 原文带物品时顺便存下阵亡装配（没有 items 字段的不存，查装配时再向 ESI 取）
                if "items" in v:
                    fit_rows.append((kid, v["ship_type_id"], t, json.dumps(extract_fit(km), separators=(",", ":"))))
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
            c.executemany("INSERT OR IGNORE INTO killmails(id, hash, time, system_id, region_id, ship_type, value, value_sell, attackers, solo, npc, "
                          "v_char, v_corp, v_alliance, f_char, f_corp, f_alliance, f_ship) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", km_rows)
            c.executemany("INSERT INTO attackers(km, time, char, corp, alliance, ship, dmg) VALUES(?,?,?,?,?,?,?)", att_rows)
            c.executemany("INSERT OR REPLACE INTO km_fits(id, ship, time, fit) VALUES(?,?,?,?)", fit_rows)
            c.commit()
            added = len(km_rows)
            if live:
                fresh = time.time() - LIVE_MAX_AGE
                for row in km_rows:
                    if row[2] >= fresh:          # zKill 偶尔补录多年前的击杀，不当作“新击杀”推送
                        self.live_n += 1
                        # 带上 hash：击杀预警的游戏内邮件要用 killReport:ID:HASH 链接
                        # row：id, hash, time, …, value, value_sell, …；row_summary 要的是 id, time, …, value, attackers…（去掉 hash 与 value_sell）
                        self.live_buf.append((self.live_n, {**row_summary(row[:1] + row[2:7] + row[8:]), "value_sell": round(row[7] or 0, 2),
                                                            "hash": row[1], "att": live_att.get(row[0], ([], []))[0], "ao": live_att.get(row[0], ([], []))[1]}))
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
        for target in (self.price_loop, self.contract_loop, self.bp_contract_loop, self.backfill, self.live_loop, self.names_loop, self.sell_backfill_loop):
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
        fails = 0
        while True:
            try:
                self.refresh_prices()
                self.prices_ready.set()
                fails, wait = 0, PRICE_TTL
            except Exception as e:
                # 失败（常见于刚重启时 ESI 504 / 错误额度用完）不等满一小时：3、6、12 分钟……最多 30 分钟后重试，
                # 否则倒卖排行要一直卡在「等待后台价格任务」直到下一小时
                fails += 1
                wait = min(180 * 2 ** (fails - 1), 1800)
                log.warning("价格刷新失败：%s，%d 秒后重试", e, wait)
                arb = getattr(self.store, "arb", None)
                if arb:
                    with arb.lock:
                        st = arb.state.setdefault("tq", {"asked": 0, "running": False, "progress": "", "error": None})
                        if not arb.data.get("tq"):
                            st["progress"] = f"后台读取订单失败（{e}），约 {wait // 60} 分钟后自动重试"
            if self.store.state["backfill"] == "完成":
                self.store.prune()  # 实时入库会持续写入，每小时清理一次超出保留期的击杀
            time.sleep(wait)

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
                return kid, self.store.km_values(km), old
            except Exception:
                return kid, None, old

        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = [r for r in pool.map(revalue, rows) if r[1] is not None and abs(r[1][0] - r[2]) > 1]
        with self.store.write_lock:
            c.executemany("UPDATE killmails SET value = ?, value_sell = ? WHERE id = ?", [(round(v[0], 2), round(v[1], 2), kid) for kid, v, _ in results])
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

    # ---- 卖价估值补齐：value_sell 列加上之前入库的击杀（入库时只算了中间价，原文不保存）
    # 国际服先按天用 EVE Ref 存档整天补（一天一个包，比逐条请求 ESI 省得多），存档里没有的、以及国服，逐条向 ESI 取原文。
    # 按当前价格估值（不是入库那天的价格）；慢慢跑，不和实时收录抢资源
    def sell_backfill_loop(self):
        self.prices_ready.wait()
        time.sleep(120)
        while True:
            try:
                left = self.sell_backfill_once()
            except Exception:
                log.exception("卖价估值补齐失败")
                left = 1
            self.store.state["sell_backfill"] = f"剩 {left} 条" if left else "完成"
            time.sleep(600 if left else 6 * 3600)

    def sell_pending(self):
        return self.store.conn().execute("SELECT COUNT(*) FROM killmails WHERE value_sell IS NULL").fetchone()[0]

    def sell_update(self, rows):
        if not rows:
            return
        with self.store.write_lock:
            c = self.store.conn()
            c.executemany("UPDATE killmails SET value_sell = ? WHERE id = ? AND value_sell IS NULL", rows)
            c.commit()

    def sell_backfill_once(self):
        c = self.store.conn()
        if not self.sell_pending():
            return 0
        if self.store.server == "tq":
            days = [r[0] for r in c.execute("SELECT DISTINCT time / 86400 FROM killmails WHERE value_sell IS NULL ORDER BY 1 DESC")]
            for d in days:
                day = dt.date(1970, 1, 1) + dt.timedelta(days=d)
                if self.store.meta(f"sellfill:{day}"):
                    continue
                need = {r[0] for r in c.execute("SELECT id FROM killmails WHERE time >= ? AND time < ? AND value_sell IS NULL", (d * 86400, d * 86400 + 86400))}
                self.store.state["sell_backfill"] = f"按 EVE Ref 存档补 {day}（{len(need)} 条）"
                try:
                    body, _ = http_get(EVEREF.format(year=day.year, date=day.isoformat()), timeout=180)
                except Exception as e:
                    log.warning("卖价补齐：EVE Ref %s 不可用：%s", day, e)
                    continue
                rows = []
                with tarfile.open(fileobj=io.BytesIO(body), mode="r:bz2") as tar:
                    for member in tar:
                        if not member.isfile() or not member.name.endswith(".json"):
                            continue
                        km = json.load(tar.extractfile(member))
                        if km.get("killmail_id") in need:
                            rows.append((round(self.store.km_value(km, self.store.price_sell), 2), km["killmail_id"]))
                            if len(rows) >= 2000:
                                self.sell_update(rows)
                                rows = []
                self.sell_update(rows)
                del body
                self.store.meta(f"sellfill:{day}", 1)
                log.info("卖价估值补齐：%s 存档处理完", day)
                time.sleep(20)
        # 逐条：存档里没有的（当天存档还没出、zKill 后补录的）和国服
        # 限速：ESI killmails 组配额 3600/15 分钟，补算最多用一半，剩下的留给用户查击杀详情
        for _batch in range(20):                     # 单次最多 20 批（50 条/批），跑完回外层睡 10 分钟
            rows = c.execute("SELECT id, hash FROM killmails WHERE value_sell IS NULL AND hash IS NOT NULL ORDER BY time DESC LIMIT 50").fetchall()
            if not rows:
                break
            self.store.state["sell_backfill"] = f"逐条补，剩 {self.sell_pending()} 条"

            def one(r):
                try:
                    km, _ = get_json(self.store.esi_url(f"/killmails/{r[0]}/{r[1]}/"), timeout=20, retries=2)
                    return round(self.store.km_value(km, self.store.price_sell), 2), r[0]
                except Exception:
                    return None
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                got = [x for x in pool.map(one, rows) if x]
            self.sell_update(got)
            if len(got) < len(rows) // 2:
                break                                # ESI 大面积失败（多半是 429 限流）：睡满配额窗口再试
            time.sleep(15)
        # 没有 hash、取不到原文的只能按中间价（查询里 COALESCE 退回 value）
        return self.sell_pending()

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
        for target in (self.price_loop, self.queue_loop, self.ingest_loop, self.names_loop, self.sell_backfill_loop):
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
SUMMARY_COLS = _ByMode("id, time, system_id, region_id, ship_type, value, attackers, solo, npc, v_char, v_corp, v_alliance, f_char, f_corp, f_alliance, f_ship",
                       "id, time, system_id, region_id, ship_type, COALESCE(value_sell, value), attackers, solo, npc, v_char, v_corp, v_alliance, f_char, f_corp, f_alliance, f_ship")
ENTITY_COL = {"character": ("v_char", "char"), "corporation": ("v_corp", "corp"), "alliance": ("v_alliance", "alliance")}


# 疑似强爆（高安自杀式攻击）：受害者被玩家击毁，且某个攻击者在同一星系、前后 10 分钟内被 NPC（统合部 CONCORD）击毁。
# {k} 为外层 killmails 的别名；只认高安（安全等级 ≥ 0.45）星系，低安哨戒炮打死人的不算
GANK_EXISTS = ("({k}.npc=0 AND EXISTS(SELECT 1 FROM attackers ga JOIN killmails gx ON gx.v_char=ga.char AND gx.time BETWEEN {k}.time-600 AND {k}.time+600 "
               "WHERE ga.km={k}.id AND gx.system_id={k}.system_id AND gx.npc=1))")
GANK_DAYS = (7, 30, 90)
GANK_HOT_TTL = 3 * 3600
# 击杀列表的空间筛选：星系 ID 范围（K 空间 30xxxxxx、虫洞 31xxxxxx、深渊 32xxxxxx）
FEED_SPACE = {"k": (30000000, 30999999), "wh": (31000000, 31999999), "abyss": (32000000, 32999999)}
ZKILL_MOD = (("character", "characterID"), ("corporation", "corporationID"), ("alliance", "allianceID"),
             ("ship", "shipTypeID"), ("system", "solarSystemID"), ("constellation", "constellationID"), ("region", "regionID"))


def id_list(q, key):
    """查询参数里逗号分隔的 ID（击杀列表的多选筛选），最多 50 个"""
    return [int(x) for x in str(q.get(key) or "").split(",") if x.strip()][:50]


def zkill_path(q, side, ship_side="losses"):
    """把列表筛选条件换成 zKillboard 查询路径；没有任何筛选时返回 None（zKillboard 不支持全局翻页）。
    多选（同一类里多个，或地点 / 人物各混了几种）zKillboard 表达不了「或」，也返回 None，只查本地收录"""
    for group in (("ship",), ("system", "constellation", "region"), tuple(ENTITY_COL)):
        if sum(len(id_list(q, k)) for k in group) > 1:
            return None
    mods = "".join(f"{name}/{int(q[key])}/" for key, name in ZKILL_MOD if q.get(key))
    if not mods:
        return None
    entity = any(q.get(k) for k in ENTITY_COL)
    # zKillboard 的 kills/ losses/ 前缀对路径里全部实体（含 shipTypeID）一起生效；
    # 舰船要按方向筛（本地 ship 是受害者舰船 / ship_side=kills 是攻击者舰船），人物又要另一个方向时表达不了，只查本地
    if q.get("ship"):
        if entity and side in ("kills", "losses") and side != ship_side:
            return None
        if entity and side not in ("kills", "losses"):
            return None
        return ship_side + "/" + mods
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
        self.const_systems = {}                     # 星座 -> 星系列表（ESI，仅内存）
        self.mem_names = {}                         # 保留期以前击杀涉及的名称（仅内存，不写库）
        self.bh_lock, self.bh_busy, self.bh_cache = threading.Lock(), {}, {}   # 历史会战：同时只算一份；单独缓存，不随合同估价更新清空
        self.lb_full = collections.OrderedDict()    # 完整排行榜（分页用）：(days, side, by, metric) -> (时间, ids, 次数, 价值)
        self.lb_lock = threading.Lock()
        self.pilot_cache, self.pilot_lock = collections.OrderedDict(), threading.Lock()
        self.industry = None                        # 由 main 设置：星系安全等级（map-data.json）
        self.gank_hot, self.gank_busy, self.gank_lock = {}, set(), threading.Lock()

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
        key = (key, sell_mode())                 # 中间价 / 卖价两种口径分开缓存
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
                self.top({"days": "7", "limit": "14"}, force=True)   # 和击杀记录首页「最近 7 天最高损失」同一个缓存键
                for side in ("losses", "kills"):
                    for by in ENTITY_COL:
                        for metric in ("value", "count"):
                            self.leaderboard({"side": side, "by": by, "metric": metric, "days": "30", "limit": "20"}, force=True)
                # 卖价口径：首页两块也预先算好（排行按需再算）
                PRICE_MODE.sell = True
                try:
                    self.summary({"hours": "24"}, force=True)
                    self.top({"days": "7", "limit": "14"}, force=True)
                finally:
                    PRICE_MODE.sell = False
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
        if sell_mode():
            kills = [{**k, "value": k.get("value_sell", k["value"])} for k in kills]
        return {"cursor": latest, "kills": kills, "names": self.with_names(kills)}

    # GET /battles?window=60&min=20：疑似会战（时间窗内同一星系被击毁的舰船数，不含太空舱、NPC 击杀与价值 < BATTLE_MIN_VALUE 的击杀）；
    # 最后一次击杀超过 BATTLE_GAP（20 分钟）就算结束、不再列出
    def battles(self, q):
        window = min(max(int(q.get("window", 60)), 5), 180)
        min_kills = min(max(int(q.get("min", 20)), 5), 2000)

        def run():
            c = self.store.conn()
            window_since = int(time.time() - window * 60)
            base = f"time >= ? AND npc = 0 AND ship_type NOT IN (670, 33328) AND value >= {BATTLE_MIN_VALUE}"
            now = int(time.time())
            cand = c.execute(f"""SELECT system_id FROM killmails WHERE {base} GROUP BY system_id
                                 HAVING COUNT(*) >= ? AND MAX(time) >= ?""", (window_since, min_kills, now - BATTLE_GAP)).fetchall()
            # 20 分钟没有新击杀的会战已结束；还在打的只从最近一次间隔超过 20 分钟之后算起（之前那场不并进来）
            rows = []
            for (sys_id,) in cand:
                times = [t for (t,) in c.execute(f"SELECT time FROM killmails WHERE system_id = ? AND {base} ORDER BY time DESC", (sys_id, window_since))]
                start = times[0]
                for t in times[1:]:
                    if start - t > BATTLE_GAP:
                        break
                    start = t
                r = c.execute(f"""SELECT region_id, COUNT(*), SUM({V}), MIN(time), MAX(time) FROM killmails
                                  WHERE system_id = ? AND {base}""", (sys_id, start)).fetchone()
                if r[1] >= min_kills:
                    rows.append((sys_id, start) + tuple(r))
            rows = sorted(rows, key=lambda r: r[3], reverse=True)[:20]
            out, ids = [], []
            for sys_id, since, region, kills, value, start, end in rows:
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
                for eid, is_alliance, n, v in c.execute(f"""SELECT COALESCE(v_alliance, v_corp) e, v_alliance IS NOT NULL, COUNT(*), SUM({V}) FROM killmails
                                                            WHERE system_id = ? AND {base} GROUP BY e""", (sys_id, since)):
                    if eid:
                        side = side_of(eid, is_alliance)
                        side["losses"], side["lost"] = n, round(v or 0, 2)
                top_sides = sorted(sides.values(), key=lambda x: x["kills"] + x["losses"], reverse=True)[:4]
                top = c.execute(f"SELECT id, ship_type, {V} FROM killmails WHERE system_id = ? AND {base} ORDER BY {V} DESC LIMIT 1",
                                (sys_id, since)).fetchone()
                ids += [x["id"] for x in top_sides]
                out.append({"system_id": sys_id, "region_id": region, "kills": kills, "value": round(value or 0, 2),
                            "start": iso(start), "end": iso(end), "pilots": pilots, "sides": top_sides,
                            "top": {"id": top[0], "ship_type_id": top[1], "value": round(top[2] or 0, 2)} if top else None})
            return {"window": window, "min": min_kills, "battles": out, "names": self.names_for(ids)}
        hit = self.store.cache.get(("battles", window, min_kills, sell_mode()))
        if hit and time.time() - hit[0] < BATTLE_CACHE:   # 多个页面同时轮询时短时间内复用结果
            return hit[1]
        value = run()
        self.store.cache[("battles", window, min_kills, sell_mode())] = (time.time(), value)
        return value

    # GET /battles/history?days=30：最近 N 天全部疑似会战（同一星系相邻击杀间隔 ≤ 20 分钟连成一段，段内任意 60 分钟击毁 ≥ 20 艘才算；口径同 /battles）。
    # 阵营按「谁打谁」划分，口径同战场统计页（kb-br.js autoSides）：同一次击杀里一起出手的算友方，打了对方的算敌方，
    # 从人数最多的势力开始依次归入 A / B；对 A、B 两边都下过手的势力单独算 C 方（三方混战）；跟谁都没关系的算其他。
    # 每方统计势力、人数、损失（艘 / ISK）、击毁（艘 / ISK），战损比 = 击毁 ÷（击毁 + 损失）。结果缓存 10 分钟，过期后先返回旧结果、后台重算。
    def battle_history(self, q):
        days = min(max(int(q.get("days", 30)), 1), 30)
        key = ("battle_history", days, sell_mode())
        hit = self.bh_cache.get(key)
        if hit and time.time() - hit[0] < BATTLE_HISTORY_CACHE:
            return hit[1]
        if hit:
            with self.bh_lock:
                if not self.bh_busy.get(key):
                    self.bh_busy[key] = True
                    def bg():
                        try:
                            self.bh_cache[key] = (time.time(), self._battle_history(days))
                        finally:
                            self.bh_busy[key] = False
                    threading.Thread(target=keep_mode(bg), daemon=True).start()
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
        rows = c.execute(f"""SELECT id, time, system_id, region_id, ship_type, {V}, v_char, COALESCE(v_alliance, v_corp), v_alliance IS NOT NULL
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
            # 分队用的关系与人数按战场统计页的口径取：同一时间段（前后各放宽 10 分钟）该星系的全部玩家击杀，含太空舱与低价值击杀，
            # 这样列表里分出的几方和点进「战场统计」后自动分出的一致；损失 / 击毁统计仍只算会战口径的击杀
            t0 = seg[0][1] // 60 * 60 - 600
            t1 = -(-seg[-1][1] // 60) * 60 + 600
            full = c.execute(f"""SELECT id, v_char, COALESCE(v_alliance, v_corp), v_alliance IS NOT NULL, {V} FROM killmails
                                WHERE system_id = ? AND time >= ? AND time < ? AND npc = 0""", (seg[0][2], t0, t1)).fetchall()
            kms = [r[0] for r in full]
            att = collections.defaultdict(list)    # km -> [(char, 势力, 是否联盟)]
            for chunk in range(0, len(kms), 900):
                part = kms[chunk:chunk + 900]
                for km, ch, ent, is_al in c.execute(f"SELECT km, char, COALESCE(alliance, corp), alliance IS NOT NULL FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                    att[km].append((ch, ent, is_al))
            kind, inv, friend, enemy, chars, lost_by = {}, collections.Counter(), collections.Counter(), collections.Counter(), collections.defaultdict(set), collections.Counter()
            for km, v_char, v, v_al, val in full:
                if v:
                    kind[v] = v_al
                    inv[v] += 1
                    lost_by[v] += val or 0
                    if v_char:
                        chars[v].add(v_char)
                ents = set()
                for ch, ent, is_al in att[km]:
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
                if len(el) <= 60:
                    for a in range(len(el)):
                        for b in range(a + 1, len(el)):
                            friend[(el[a], el[b])] += 1
            pair = lambda x, y: (min(x, y), max(x, y))
            order = sorted(inv, key=lambda e: (-len(chars[e]), -lost_by[e]))
            side = {order[0]: 0} if order else {}
            def score(e, t):
                return sum(friend[pair(e, x)] - 2 * enemy[pair(e, x)] for x, st in side.items() if st == t and x != e)
            for rnd in range(3):
                changed = False
                for e in order:
                    if rnd == 0 and e in side:
                        continue
                    a, b = score(e, 0), score(e, 1)
                    t = (0 if a >= b else 1) if a > 0 or b > 0 else (1 if a < b else 0) if a < 0 or b < 0 else None
                    if t is not None and side.get(e) != t and e != order[0]:
                        side[e] = t
                        changed = True
                if not changed:
                    break
            def hostile_to(e, t):
                return sum(enemy[pair(e, x)] for x, st in side.items() if st == t and x != e)
            third = []
            for e in order[1:]:
                a, b = hostile_to(e, 0), hostile_to(e, 1)
                if a >= 3 and b >= 3 and min(a, b) >= 0.3 * max(a, b):
                    third.append(e)
            for e in third:
                side[e] = 2
            team_of = side
            teams = [[e for e in order if side.get(e) == t] for t in range(3)]
            stat = [{"losses": 0, "lost": 0.0, "kills": 0, "destroyed": 0.0, "ents": collections.Counter(), "e_kills": collections.Counter(), "e_losses": collections.Counter(), "e_lost": collections.Counter()} for _ in range(4)]
            for r in seg:
                vt = team_of.get(r[7], 3)
                s = stat[vt]
                s["losses"] += 1
                s["lost"] += r[5] or 0
                if r[7]:
                    s["e_losses"][r[7]] += 1
                    s["e_lost"][r[7]] += r[5] or 0
                hit_teams = set()
                for _, ent, _ in att[r[0]]:
                    if ent and ent != r[7]:
                        stat[team_of.get(ent, 3)]["e_kills"][ent] += 1 if ent not in hit_teams else 0
                        hit_teams.add(ent)
                for t in {team_of.get(e, 3) for e in hit_teams}:
                    if t != vt:
                        stat[t]["kills"] += 1
                        stat[t]["destroyed"] += r[5] or 0
            def team_json(t, members):
                s = stat[t]
                top = sorted(members, key=lambda e: (len(chars[e]), lost_by[e]), reverse=True)   # 同战场统计页：人数多的在前
                ids.extend(top[:4])
                return {"entities": [{"id": e, "kind": "alliance" if kind.get(e) else "corporation", "kills": s["e_kills"][e], "losses": s["e_losses"][e], "lost": round(s["e_lost"][e])} for e in top[:4]],
                        "n_entities": len(members), "pilots": len(set().union(*(chars[e] for e in members))) if members else 0,
                        "losses": s["losses"], "lost": round(s["lost"]), "kills": s["kills"], "destroyed": round(s["destroyed"])}
            others = [e for e in inv if e not in team_of]
            top = max(seg, key=lambda r: r[5] or 0)
            all_chars = set().union(*chars.values()) if chars else set()
            out.append({"system_id": seg[0][2], "region_id": seg[0][3], "start": iso(seg[0][1]), "end": iso(seg[-1][1]),
                        "kills": len(seg), "peak": peak, "value": round(sum(r[5] or 0 for r in seg)), "pilots": len(all_chars),
                        "teams": [team_json(t, teams[t]) for t in range(3 if teams[2] else 2)],
                        "third": {"n_entities": len(others), "losses": stat[3]["losses"], "lost": round(stat[3]["lost"])},
                        "top": {"id": top[0], "ship_type_id": top[4], "value": round(top[5] or 0)}})
        out.sort(key=lambda b: b["end"], reverse=True)
        return {"days": days, "updated": iso(int(time.time())), "min": BATTLE_MIN_KILLS, "gap_minutes": BATTLE_GAP // 60,
                "battles": out, "names": self.names_for(ids)}

    # GET /battles/pilot?character=ID&days=180：这个人物最近 N 天参加过的会战（口径同 /battles/history：同一星系相邻击杀间隔 ≤ 20 分钟连成一段，
    # 段内任意 60 分钟击毁 ≥ 20 艘）。先取他作为受害者 / 攻击者的击杀，按星系和时间聚成几簇，每簇只查该星系前后 6 小时的击杀来切段，
    # 他的击杀落在某段前后 10 分钟内就算参加了这场。天数受本地保留期限制（宁静服按 --days，国服永久），返回实际天数。结果缓存 10 分钟。
    def pilot_battles(self, q):
        cid = int(q.get("character") or 0)
        if cid <= 0:
            raise ValueError("缺少 character")
        days = min(max(int(q.get("days", 180)), 1), 180)
        if self.store.retention:
            days = min(days, self.store.retention)
        key = (cid, days, sell_mode())
        if not hasattr(self, "pb_cache"):
            self.pb_cache = collections.OrderedDict()   # 按人物缓存，最多 500 个
        hit = self.pb_cache.get(key)
        if hit and time.time() - hit[0] < BATTLE_HISTORY_CACHE:
            return hit[1]
        c = self.store.conn()
        since = int(time.time() - days * 86400)
        ev = []   # (时间, 星系, 击杀 id, 舰船, 是否损失, 价值, 势力, 势力是否联盟)
        for km, t, sysid, ship, val, ent, is_al in c.execute(f"""SELECT id, time, system_id, ship_type, {V}, COALESCE(v_alliance, v_corp), v_alliance IS NOT NULL FROM killmails
                                                          WHERE v_char = ? AND time >= ? AND npc = 0""", (cid, since)):
            ev.append((t, sysid, km, ship, True, val or 0, ent, is_al))
        for km, t, sysid, ship, ent, is_al in c.execute("""SELECT a.km, a.time, k.system_id, a.ship, COALESCE(a.alliance, a.corp), a.alliance IS NOT NULL FROM attackers a JOIN killmails k ON k.id = a.km
                                                     WHERE a.char = ? AND a.time >= ? AND k.npc = 0""", (cid, since)):
            ev.append((t, sysid, km, ship, False, 0, ent, is_al))
        ev.sort(key=lambda e: (e[1], e[0]))
        clusters, cur = [], []
        for e in ev:
            if cur and (e[1] != cur[-1][1] or e[0] - cur[-1][0] > 6 * 3600):
                clusters.append(cur)
                cur = []
            cur.append(e)
        if cur:
            clusters.append(cur)
        out, ids = [], []
        for cl in clusters:
            rows = c.execute(f"""SELECT id, time, system_id, region_id, ship_type, {V} FROM killmails
                                 WHERE system_id = ? AND time >= ? AND time <= ? AND npc = 0 AND ship_type NOT IN (670, 33328) AND value >= {BATTLE_MIN_VALUE}
                                 ORDER BY time""", (cl[0][1], cl[0][0] - 6 * 3600, cl[-1][0] + 6 * 3600)).fetchall()
            segs, seg = [], []
            for r in rows:
                if seg and r[1] - seg[-1][1] > BATTLE_GAP:
                    segs.append(seg)
                    seg = []
                seg.append(r)
            if seg:
                segs.append(seg)
            for seg in segs:
                if len(seg) < BATTLE_MIN_KILLS:
                    continue
                j, peak = 0, 0
                for i in range(len(seg)):
                    while seg[i][1] - seg[j][1] > 3600:
                        j += 1
                    peak = max(peak, i - j + 1)
                if peak < BATTLE_MIN_KILLS:
                    continue
                t0, t1 = seg[0][1] - 600, seg[-1][1] + 600
                mine = [e for e in cl if t0 <= e[0] <= t1]
                if not mine:
                    continue
                kms = [r[0] for r in seg]
                pilots = set()
                for chunk in range(0, len(kms), 900):
                    part = kms[chunk:chunk + 900]
                    pilots.update(ch for (ch,) in c.execute(f"SELECT DISTINCT char FROM attackers WHERE char IS NOT NULL AND km IN ({','.join('?' * len(part))})", part))
                    pilots.update(ch for (ch,) in c.execute(f"SELECT v_char FROM killmails WHERE v_char IS NOT NULL AND id IN ({','.join('?' * len(part))})", part))
                lost = [e for e in mine if e[4]]
                ships = collections.Counter(e[3] for e in mine if e[3] and e[3] not in (670, 33328))
                ent = collections.Counter((e[6], e[7]) for e in mine if e[6]).most_common(1)
                if ent:
                    ids.append(ent[0][0][0])
                out.append({"system_id": seg[0][2], "region_id": seg[0][3], "start": iso(seg[0][1]), "end": iso(seg[-1][1]),
                            "kills": len(seg), "peak": peak, "value": round(sum(r[5] or 0 for r in seg)), "pilots": len(pilots),
                            "me": {"kills": len({e[2] for e in mine if not e[4]}), "ships": [s for s, _ in ships.most_common(4)],
                                   "losses": [{"id": e[2], "ship_type_id": e[3], "value": round(e[5])} for e in lost[:6]],
                                   "lost": round(sum(e[5] for e in lost)),
                                   "entity": {"id": ent[0][0][0], "kind": "alliance" if ent[0][0][1] else "corporation"} if ent else None}})
        out.sort(key=lambda b: b["end"], reverse=True)
        value = {"days": days, "character": cid, "min": BATTLE_MIN_KILLS, "battles": out[:200], "names": self.names_for(ids)}
        self.pb_cache[key] = (time.time(), value)
        while len(self.pb_cache) > 500:
            self.pb_cache.popitem(last=False)
        return value

    # GET /br?systems=1,2,3&start=T&end=T：战场统计原始数据（时间为 Unix 秒）
    # 返回紧凑数组以减小体积：kills[i] = [id, time, system, ship, value, v_char, v_corp, v_alliance, [[char, corp, alliance, ship, 伤害], ...], 最后一击的角色]
    # dmg_missing：还没补到伤害的击杀数（补完前只缓存 15 秒，前端稍后刷新即可）
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
        key = ("br", tuple(systems), start, end, sell_mode())
        hit = self.store.cache.get(key)
        # 已经结束的时间段结果不会再变，缓存久一点；包含当前时间的只缓存 30 秒
        ttl = CACHE_TTL if end < time.time() - 3600 else 30
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        c = self.store.conn()
        marks = ",".join("?" * len(systems))
        rows = c.execute(f"""SELECT id, time, system_id, ship_type, {V}, v_char, v_corp, v_alliance, hash, f_char FROM killmails
                             WHERE system_id IN ({marks}) AND time >= ? AND time < ? AND npc = 0
                             ORDER BY time LIMIT ?""", (*systems, start, end, BR_MAX_KILLS + 1)).fetchall()
        truncated = len(rows) > BR_MAX_KILLS
        rows = rows[:BR_MAX_KILLS]
        kids = [r[0] for r in rows]

        def load_attackers():
            att = collections.defaultdict(list)
            for chunk in range(0, len(kids), 900):
                part = kids[chunk:chunk + 900]
                for km, char, corp, alliance, ship, dmg in c.execute(
                        f"SELECT km, char, corp, alliance, ship, dmg FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                    att[km].append([char, corp, alliance, ship, dmg])
            return att
        att = load_attackers()
        nodmg = [r for r in rows if r[8] and any(a[4] is None for a in att.get(r[0], ()))]
        if nodmg and self.fill_damage(nodmg):
            att = load_attackers()
        missing = sum(1 for r in rows if r[8] and any(a[4] is None for a in att.get(r[0], ())))
        ids = {x for lst in att.values() for a in lst for x in a[:3]}
        kills = []
        for r in rows:
            ids.update(r[5:8])
            kills.append([r[0], r[1], r[2], r[3], round(r[4] or 0, 2), r[5], r[6], r[7], att.get(r[0], []), r[9] or 0])
        value = {"systems": systems, "start": start, "end": end, "kills": kills, "truncated": truncated, "dmg_missing": missing,
                 "retention_days": self.store.retention, "names": self.names_for(ids)}
        self.store.cache[key] = (time.time() - (max(0, ttl - 15) if missing else 0), value)
        # 查询条件由用户决定，只保留最近的若干个结果，避免缓存无限增长
        br_keys = sorted((k for k in list(self.store.cache) if k[0] == "br"), key=lambda k: self.store.cache[k][0])
        for k in br_keys[:-BR_CACHE_KEEP]:
            self.store.cache.pop(k, None)
        return value

    # POST /br/km：按指定的击杀统计（粘贴的游戏内击杀链接、击杀列表里勾选的）。body {kills: [[id, hash 或 null], …]}
    # 返回和 /br 相同的紧凑数组；库里有的直接用（含伤害补齐），没有的：带 hash 的向 ESI 取原文（宁静服也认 zKillboard 缓存），
    # 不带 hash 的宁静服向 zKillboard 查少量几条。取到的原文只放内存缓存，不入库。没有玩家攻击者的（NPC 击杀）不统计。
    # not_found：没取到的击杀 ID；over：超出单次取原文上限没去取的条数；npc：跳过的 NPC 击杀条数
    def br_km(self, body):
        items = body.get("kills") if isinstance(body, dict) else None
        if not isinstance(items, list) or not items:
            raise ValueError("缺少击杀")
        want = {}
        for it in items[:BR_KM_MAX * 2]:
            try:
                kid = int(it[0] if isinstance(it, list) else it)
            except (TypeError, ValueError, IndexError):
                continue
            h = it[1] if isinstance(it, list) and len(it) > 1 else None
            h = h.lower() if isinstance(h, str) and re.fullmatch(r"[0-9a-fA-F]{40}", h) else None
            if kid > 0 and (kid not in want or (h and not want[kid])):
                want[kid] = h
        if not want:
            raise ValueError("没有认出击杀")
        if len(want) > BR_KM_MAX:
            raise ValueError(f"一次最多统计 {BR_KM_MAX} 条击杀")
        c = self.store.conn()
        kids = sorted(want)
        db = {}
        for i in range(0, len(kids), 900):
            part = kids[i:i + 900]
            for r in c.execute(f"""SELECT id, time, system_id, ship_type, {V}, v_char, v_corp, v_alliance, hash, f_char, npc FROM killmails
                                   WHERE id IN ({','.join('?' * len(part))})""", part):
                db[r[0]] = r
        npc = sum(1 for r in db.values() if r[10])
        rows = [r for r in db.values() if not r[10]]
        rid = [r[0] for r in rows]

        def load_attackers():
            att = collections.defaultdict(list)
            for i in range(0, len(rid), 900):
                part = rid[i:i + 900]
                for km, char, corp, alliance, ship, dmg in c.execute(
                        f"SELECT km, char, corp, alliance, ship, dmg FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                    att[km].append([char, corp, alliance, ship, dmg])
            return att
        att = load_attackers()
        nodmg = [r for r in rows if r[8] and any(a[4] is None for a in att.get(r[0], ()))]
        if nodmg and self.fill_damage(nodmg):
            att = load_attackers()
        missing = sum(1 for r in rows if r[8] and any(a[4] is None for a in att.get(r[0], ())))
        kills = [[r[0], r[1], r[2], r[3], round(r[4] or 0, 2), r[5], r[6], r[7], att.get(r[0], []), r[9] or 0] for r in rows]
        # 库里没有的：取原文（内存缓存 → ESI（带 hash）→ zKillboard（宁静服、不带 hash，限几条））
        rest = [k for k in kids if k not in db]
        not_found, over = [], 0
        cached = {}
        with self.km_lock:
            for k in rest:
                if k in self.km_cache:
                    cached[k] = self.km_cache[k]
        esi = [k for k in rest if k not in cached and want[k]]
        zk = [k for k in rest if k not in cached and not want[k]]
        if len(esi) > BR_KM_FETCH:
            over += len(esi) - BR_KM_FETCH
            esi = esi[:BR_KM_FETCH]
        if self.store.server != "tq":
            not_found += zk     # 国服没有 zKillboard，没有 hash 就取不到原文
            zk = []
        elif len(zk) > BR_KM_ZKILL:
            over += len(zk) - BR_KM_ZKILL
            zk = zk[:BR_KM_ZKILL]
        fails = [0]

        def get_esi(k):
            if fails[0] >= BR_KM_FAILS:
                return k, None
            try:
                km, _ = get_json(self.store.esi_url(f"/killmails/{k}/{want[k]}/"), timeout=20, retries=2, fatal=(400, 404, 422))
                fails[0] = 0
                return k, km if isinstance(km, dict) and km.get("victim") else None
            except Exception:
                fails[0] += 1
                return k, None
        got = dict(cached)
        if esi:
            with concurrent.futures.ThreadPoolExecutor(8) as pool:
                for k, km in pool.map(get_esi, esi):
                    if km:
                        got[k] = km
                    else:
                        not_found.append(k)
        for k in zk:
            data = zkill_get(f"killID/{k}/")
            km = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) and data[0].get("victim") else None
            if km:
                got[k] = km
            else:
                not_found.append(k)
        with self.km_lock:
            for k, km in got.items():
                self.km_cache[k] = km
                self.km_cache.move_to_end(k)
            while len(self.km_cache) > KM_CACHE:
                self.km_cache.popitem(last=False)
        for k, km in got.items():
            atts = km.get("attackers") or []
            players = [a for a in atts if a.get("character_id")]
            if not players:
                npc += 1
                continue
            v = km["victim"]
            fin = next((a for a in atts if a.get("final_blow")), atts[0])
            kills.append([k, epoch(km["killmail_time"]), km["solar_system_id"], v["ship_type_id"], round(self.store.km_value(km, self.store.price_by_mode), 2),
                          v.get("character_id"), v.get("corporation_id"), v.get("alliance_id"),
                          [[a["character_id"], a.get("corporation_id"), a.get("alliance_id"), a.get("ship_type_id"), a.get("damage_done") or 0] for a in players],
                          fin.get("character_id") or 0])
        kills.sort(key=lambda x: (x[1], x[0]))
        ids = set()
        for x in kills:
            ids.update(x[5:8])
            for a in x[8]:
                ids.update(a[:3])
        times = [x[1] for x in kills]
        return {"systems": sorted({x[2] for x in kills}), "start": min(times) if times else 0, "end": max(times) + 60 if times else 0,
                "kills": kills, "truncated": False, "dmg_missing": missing, "retention_days": self.store.retention, "names": self.names_for(ids),
                "km": True, "not_found": sorted(not_found), "over": over, "npc": npc}

    # GET /locate?system=ID&x=&y=&z=：击杀位置最近的天体（星门 / 空间站 / 行星 / 卫星 / 小行星带 / 恒星）及距离（米）
    def locate(self, q):
        sid = int(q["system"])
        x, y, z = float(q["x"]), float(q["y"]), float(q["z"])
        items = self.system_celestials(sid)
        if not items:
            return {"nearest": None}
        kind, cid, name, cx, cy, cz, dest = min(items, key=lambda it: (it[3] - x) ** 2 + (it[4] - y) ** 2 + (it[5] - z) ** 2)
        dist = ((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2) ** 0.5
        # rest：去掉开头星系名的部分（如「VII - Moon 2」），前端换成本地化的星系名再拼
        sys_name = next((it[2][:-len(" - Star")] for it in items if it[0] == "sun"), "")
        rest = name[len(sys_name):].strip() if sys_name and name.startswith(sys_name) else ""
        return {"nearest": {"kind": kind, "id": cid, "name": name, "rest": rest, "dest": dest, "distance": round(dist)}}

    def system_celestials(self, sid):
        if not hasattr(self, "celestial_cache"):
            self.celestial_cache = {}
            self.celestial_lock = threading.Lock()
        if sid in self.celestial_cache:
            return self.celestial_cache[sid]
        with self.celestial_lock:            # 同一时间只取一个星系，避免并发重复请求
            if sid in self.celestial_cache:
                return self.celestial_cache[sid]
            row = self.store.conn().execute("SELECT data FROM celestials WHERE system_id=?", (sid,)).fetchone()
            if row:
                self.celestial_cache[sid] = json.loads(row[0])
                return self.celestial_cache[sid]
            esi = self.store.esi_url
            info, _ = get_json(esi(f"/universe/systems/{sid}/"), timeout=20, retries=2)
            tasks = [("stargate", g) for g in info.get("stargates") or []] + [("station", st) for st in info.get("stations") or []]
            for pl in info.get("planets") or []:
                tasks.append(("planet", pl["planet_id"]))
                tasks += [("moon", m) for m in pl.get("moons") or []] + [("belt", b) for b in pl.get("asteroid_belts") or []]
            path = {"stargate": "stargates", "station": "stations", "planet": "planets", "moon": "moons", "belt": "asteroid_belts"}

            def fetch(t):
                kind, cid = t
                d, _ = get_json(esi(f"/universe/{path[kind]}/{cid}/"), timeout=20, retries=2)
                p = d.get("position") or {}
                return [kind, cid, d.get("name") or "", p.get("x", 0), p.get("y", 0), p.get("z", 0), (d.get("destination") or {}).get("system_id")]
            with concurrent.futures.ThreadPoolExecutor(SHIPFIT_WORKERS) as pool:
                items = list(pool.map(fetch, tasks))
            # 恒星在星系坐标原点
            items.append(["sun", info.get("star_id"), (info.get("name") or "") + " - Star", 0, 0, 0, None])
            with self.store.write_lock:
                c = self.store.conn()
                c.execute("INSERT OR REPLACE INTO celestials VALUES(?, ?)", (sid, json.dumps(items, separators=(",", ":"))))
                c.commit()
            self.celestial_cache[sid] = items
            return items

    def fill_damage(self, rows):
        """旧击杀没存攻击者伤害：向 ESI 取原文补上。最多等 BR_DMG_WAIT 秒，返回期间是否补到了；
        没补完的在后台继续（同一击杀不会重复取）"""
        if not hasattr(self, "dmg_pool"):
            self.dmg_pool = concurrent.futures.ThreadPoolExecutor(SHIPFIT_WORKERS)
            self.dmg_busy = set()
        store = self.store

        def fetch(kid, km_hash):
            try:
                km, _ = get_json(store.esi_url(f"/killmails/{kid}/{km_hash}/"), timeout=20, retries=2)
                done = [(a.get("damage_done") or 0, kid, a["character_id"]) for a in (km or {}).get("attackers") or [] if a.get("character_id")]
                if km:
                    with store.write_lock:
                        c = store.conn()
                        c.executemany("UPDATE attackers SET dmg=? WHERE km=? AND char=?", done)
                        c.execute("UPDATE attackers SET dmg=0 WHERE km=? AND dmg IS NULL", (kid,))   # 原文里对不上的，不再反复取
                        c.commit()
            except Exception:
                pass
            finally:
                self.dmg_busy.discard(kid)
        futs = []
        for r in rows:
            if r[0] in self.dmg_busy:
                continue
            self.dmg_busy.add(r[0])
            futs.append(self.dmg_pool.submit(fetch, r[0], r[8]))
        if not futs:
            return False
        concurrent.futures.wait(futs, timeout=BR_DMG_WAIT)
        return True

    # GET /feed
    def constellation_systems(self, cid):
        """星座包含的星系（库里只存了星系、星域，星座按 ESI 换成星系列表）"""
        if cid not in self.const_systems:
            srv = ARB_SERVERS.get(self.store.server, ARB_SERVERS["tq"])
            data, _ = get_json(f"{srv['esi']}/universe/constellations/{cid}/" + (f"?{srv['qs']}" if srv["qs"] else ""), timeout=20)
            self.const_systems[cid] = [int(x) for x in (data or {}).get("systems", [])]
        return self.const_systems[cid]

    def feed(self, q):
        limit = min(int(q.get("limit", 50)), 200)
        where, args = [], []
        marks = lambda n: ",".join("?" * n)
        ships = id_list(q, "ship")
        # 舰船筛选的方向：losses（默认）= 这型船被击毁；kills = 有人开这型船参与了击杀（玩家攻击者）
        ship_side = "kills" if q.get("ship_side") == "kills" else "losses"
        if ships and ship_side == "kills":
            where.append(f"id IN (SELECT km FROM attackers WHERE ship IN ({marks(len(ships))}))"); args += ships
        elif ships:
            where.append(f"ship_type IN ({marks(len(ships))})"); args += ships
        # 地点可多选（星系 / 星座 / 星域混选），任一个都算
        locs, loc_args = [], []
        systems = id_list(q, "system")
        for cid in id_list(q, "constellation"):
            systems += self.constellation_systems(cid)
        if systems or q.get("constellation"):
            systems = systems or [0]
            locs.append(f"system_id IN ({marks(len(systems))})"); loc_args += systems
        regions = id_list(q, "region")
        if regions:
            locs.append(f"region_id IN ({marks(len(regions))})"); loc_args += regions
        if locs:
            where.append("(" + " OR ".join(locs) + ")"); args += loc_args
        # 细筛选（只查本地收录的记录，不转向 zKillboard）：最低价值、单刷、排除 NPC 击杀、空间类型
        fine = False
        if q.get("min"):
            where.append(f"{V}>=?"); args.append(float(q["min"])); fine = True
        if q.get("solo") == "1":
            where.append("solo=1"); fine = True
        if q.get("npc") == "0":
            where.append("npc=0"); fine = True
        if q.get("gank") == "1":
            hs = self.highsec()
            where.append(GANK_EXISTS.format(k="killmails"))
            where.append(f"system_id IN ({','.join('?' * len(hs))})"); args += hs; fine = True
        space = FEED_SPACE.get(q.get("space") or "")
        if space:
            where.append("system_id BETWEEN ? AND ?"); args += list(space); fine = True
        # 人物 / 军团 / 联盟可多选，任一个参与（作为受害者或攻击者）都算
        side = q.get("side", "all")
        ents, ent_args = [], []
        for kind, (vcol, acol) in ENTITY_COL.items():
            eids = id_list(q, kind)
            if not eids:
                continue
            loss = f"{vcol} IN ({marks(len(eids))})"
            kill = f"id IN (SELECT km FROM attackers WHERE {acol} IN ({marks(len(eids))}))"
            if side == "losses":
                ents.append(loss); ent_args += eids
            elif side == "kills":
                ents.append(kill); ent_args += eids
            else:
                ents.append(f"{loss} OR {kill}"); ent_args += eids + eids
        if ents:
            where.append("(" + " OR ".join(ents) + ")"); args += ent_args
        # 开放接口（_local）只查本地保留期内的记录，不转向 zKillboard
        # 国服没有 zKillboard，只有本地收录的记录
        path = None if q.get("_local") or fine or self.store.server != "tq" else zkill_path(q, side, ship_side)
        cursor = q.get("cursor") or ""
        # 排序：默认时间从近到远（可以接着查 zKillboard）；按价值、时间从远到近只查本地保留期内的（游标 s:键值:id）
        sort = "value" if q.get("sort") == "value" else "time"
        asc = q.get("dir") == "asc"
        if sort == "value" or asc:
            col = f"{V}" if sort == "value" else "time"
            op, order = (">", "ASC") if asc else ("<", "DESC")
            if cursor:
                if not cursor.startswith("s:"):
                    raise ValueError("cursor 无效")
                _, key, kid = cursor.split(":")
                key = float(key) if sort == "value" else int(key)
                where.append(f"({col} {op} ? OR ({col} = ? AND id {op} ?))")
                args += [key, key, int(kid)]
            sql = f"SELECT {SUMMARY_COLS}, {col} FROM killmails {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {col} {order}, id {order} LIMIT ?"
            rows = self.store.conn().execute(sql, args + [limit]).fetchall()
            kills = [row_summary(r[:-1]) for r in rows]
            out = {"kills": kills, "cursor": f"s:{rows[-1][-1]!r}:{rows[-1][0]}" if len(rows) == limit else None, "names": self.with_names(kills)}
            if len(rows) < limit:
                out["notice"] = "sort_local" if self.store.server == "tq" else "global_end"
            return out
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
            "value": round(self.store.km_value(km, self.store.price_by_mode), 2), "attackers": len(attackers), "solo": len(players) == 1, "npc": not players,
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
                f"SELECT {SUMMARY_COLS} FROM killmails WHERE time >= ? ORDER BY {V} DESC LIMIT ?",
                (int(time.time() - days * 86400), limit)).fetchall()
            kills = [row_summary(r) for r in rows]
            return {"kills": kills, "names": self.with_names(kills)}
        return self.cached(("top", days, limit), run, force)

    # GET /summary
    # ---------- 高安强爆 ----------
    def highsec(self):
        """高安星系 ID 列表（读 map-data.json，读不到时为空）"""
        if getattr(self, "_highsec", None) is None:
            try:
                self._highsec = sorted(sid for sid, x in self.industry.map_systems().items() if x["sec"] >= 0.45)
            except Exception:
                log.exception("读取星系安全等级失败")
                return [0]
        return self._highsec or [0]

    def gank_span(self, days):
        """统计期实际覆盖的天数（库里最早的记录晚于统计期起点时按实际算）"""
        now = int(time.time())
        first = self.store.conn().execute("SELECT MIN(time) FROM killmails").fetchone()[0] or now
        since = max(now - days * 86400, first)
        return since, max(1, round((now - since) / 86400))

    # GET /gank?system=ID&days=30：某个高安星系的强爆统计——次数、价值、出现强爆的天数、各小时（UTC）出现强爆的天数、
    # 主要团伙（按联盟，没有联盟按军团）、常被打的舰船、最近几次；不带 system 时返回高安强爆最多的星系（后台算，缓存 3 小时）
    def gank(self, q):
        days = int(q.get("days", 30))
        if days not in GANK_DAYS:
            raise ValueError("days 只能是 7 / 30 / 90")
        if not q.get("system"):
            return self.gank_hotspots(days)
        sid = int(q["system"])
        since, span = self.gank_span(days)
        c = self.store.conn()
        rows = c.execute(f"SELECT k.id, k.time, {KV}, k.ship_type FROM killmails k WHERE k.system_id=? AND k.time>=? AND {GANK_EXISTS.format(k='k')} "
                         "ORDER BY k.time DESC", (sid, since)).fetchall()
        hours = [set() for _ in range(24)]
        week = [[0] * 24 for _ in range(7)]
        ships = collections.Counter()
        for _, t, _, ship in rows:
            g = time.gmtime(t)
            hours[g.tm_hour].add(t // 86400)
            week[(g.tm_wday + 1) % 7][g.tm_hour] += 1
            if ship not in (670, 33328):   # 太空舱（被强爆后顺手打掉的）不算进常被打的舰船
                ships[ship] += 1
        groups = {}
        ids = [r[0] for r in rows]
        for i in range(0, len(ids), 900):
            part = ids[i:i + 900]
            for km, t, corp, alliance, char in c.execute(f"SELECT km, time, corp, alliance, char FROM attackers WHERE km IN ({','.join('?' * len(part))})", part):
                key = ("alliance", alliance) if alliance else ("corporation", corp)
                if not key[1]:
                    continue
                gr = groups.setdefault(key, {"kms": set(), "chars": set(), "last": 0, "hours": [0] * 24})
                if km not in gr["kms"]:
                    gr["kms"].add(km)
                    gr["hours"][time.gmtime(t).tm_hour] += 1
                gr["chars"].add(char)
                gr["last"] = max(gr["last"], t)
        value = {r[0]: r[2] for r in rows}
        top = sorted(groups.items(), key=lambda x: -len(x[1]["kms"]))[:10]
        out_groups = [{"kind": k[0], "id": k[1], "count": len(g["kms"]), "pilots": len(g["chars"]), "last": g["last"],
                       "value": sum(value[x] for x in g["kms"]), "hours": g["hours"]} for k, g in top]
        recent = [{"id": r[0], "time": r[1], "value": r[2], "ship": r[3]} for r in rows[:8]]
        return {"system": sid, "days": days, "span": span, "count": len(rows), "value": sum(r[2] for r in rows),
                "days_hit": len({r[1] // 86400 for r in rows}), "hours": [len(h) for h in hours],
                "activity": {"max": max(max(w) for w in week), **{str(d): week[d] for d in range(7)}},
                "groups": out_groups, "ships": [[t, n] for t, n in ships.most_common(8)], "recent": recent,
                "names": self.names_for([g["id"] for g in out_groups])}

    def gank_hotspots(self, days):
        key = (days, sell_mode())
        hit = self.gank_hot.get(key)
        if hit and time.time() - hit[0] < GANK_HOT_TTL:
            return hit[1]
        with self.gank_lock:
            busy = key in self.gank_busy
            self.gank_busy.add(key)
        if not busy:
            def bg():
                try:
                    self.gank_hot[key] = (time.time(), self._gank_hotspots(days))
                except Exception:
                    log.exception("统计高安强爆热点失败")
                finally:
                    self.gank_busy.discard(key)
            threading.Thread(target=keep_mode(bg), daemon=True).start()
        return hit[1] if hit else {"computing": True}

    def _gank_hotspots(self, days):
        since, span = self.gank_span(days)
        hs = set(self.highsec())
        c = self.store.conn()
        # 从 NPC 击毁的玩家舰船出发，找同星系、前后几分钟内他参与的玩家击杀（比逐条判断全部击杀快得多）
        # CROSS JOIN 固定连接顺序：SQLite 自己选的顺序会全表扫 attackers，慢上百倍
        rows = c.execute(f"""SELECT DISTINCT k.id, k.system_id, k.time, {KV} FROM killmails x
            CROSS JOIN attackers a ON a.char=x.v_char AND a.time BETWEEN x.time-600 AND x.time+600
            CROSS JOIN killmails k ON k.id=a.km
            WHERE x.npc=1 AND x.v_char IS NOT NULL AND x.time>=? AND k.system_id=x.system_id AND k.npc=0""", (since - 600,)).fetchall()
        per = {}
        for kid, sid, t, v in rows:
            if sid not in hs or t < since:
                continue
            p = per.setdefault(sid, {"count": 0, "value": 0.0, "last": 0, "days": set()})
            p["count"] += 1
            p["value"] += v
            p["last"] = max(p["last"], t)
            p["days"].add(t // 86400)
        top = sorted(per.items(), key=lambda x: -x[1]["count"])[:30]
        return {"days": days, "span": span, "at": int(time.time()), "total": sum(p["count"] for p in per.values()),
                "systems": [{"id": sid, "count": p["count"], "value": p["value"], "last": p["last"], "days_hit": len(p["days"])} for sid, p in top]}

    def summary(self, q, force=False):
        hours = min(int(q.get("hours", 24)), 24 * 30)

        def run():
            now = int(time.time())
            since = now - hours * 3600
            c = self.store.conn()
            n, total = c.execute(f"SELECT COUNT(*), COALESCE(SUM({V}), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
            buckets = [{"hour": iso(since + i * 3600), "count": 0, "value": 0.0} for i in range(hours)]
            for idx, cnt, val in c.execute(
                    f"SELECT (time - ?) / 3600 AS b, COUNT(*), SUM({V}) FROM killmails WHERE time >= ? GROUP BY b", (since, since)):
                if 0 <= idx < hours:
                    buckets[idx]["count"], buckets[idx]["value"] = cnt, round(val, 2)
            pods = c.execute("SELECT COUNT(*) FROM killmails WHERE time >= ? AND ship_type IN (670, 33328)", (since,)).fetchone()[0]
            regions = [{"region_id": r, "count": cnt, "value": round(v, 2)} for r, cnt, v in c.execute(
                f"SELECT region_id, COUNT(*), SUM({V}) FROM killmails WHERE time >= ? GROUP BY region_id ORDER BY SUM({V}) DESC LIMIT 5", (since,))]
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
                n, total = c.execute(f"SELECT COUNT(*), COALESCE(SUM({V}), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
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
            return f"SELECT {vcol}, COUNT(*) n, SUM({V}) v FROM killmails WHERE time >= ? AND {vcol} IS NOT NULL GROUP BY {vcol} {tail}"
        return f"""SELECT eid, COUNT(*) n, SUM(value) v FROM (
                    SELECT DISTINCT a.km, a.{acol} AS eid, {KV} AS value FROM attackers a NOT INDEXED JOIN killmails k ON k.id = a.km
                    WHERE a.time >= ? AND a.{acol} IS NOT NULL)
                  GROUP BY eid {tail}"""

    # 完整排名（不限条数），供分页；只在内存里保留最近用过的几种组合
    def leaderboard_full(self, days, side, by, metric, force=False):
        key = (days, side, by, metric, sell_mode())
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
            n, total = c.execute(f"SELECT COUNT(*), COALESCE(SUM({V}), 0) FROM killmails WHERE time >= ?", (since,)).fetchone()
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
                  SELECT DISTINCT a.km, a.{acol} AS eid, {KV} AS value FROM attackers a JOIN killmails k ON k.id = a.km
                  WHERE a.{acol} IN ({marks}) AND a.time >= ?) GROUP BY eid""", (*ids, since))}
        losses = {eid: (n, v) for eid, n, v in c.execute(
            f"SELECT {vcol}, COUNT(*), SUM({V}) FROM killmails WHERE {vcol} IN ({marks}) AND time >= ? GROUP BY {vcol}", (*ids, since))}
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
            losses, lost = c.execute(f"SELECT COUNT(*), COALESCE(SUM({V}),0) FROM killmails WHERE {vcol}=? AND time >= ?", (eid, since)).fetchone()
            kills, destroyed = c.execute(
                f"SELECT COUNT(*), COALESCE(SUM({V}),0) FROM killmails WHERE time >= ? AND id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ? AND char IS NOT NULL)",
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
                              SELECT DISTINCT a.km, a.{mcol} AS eid, {KV} AS value FROM attackers a JOIN killmails k ON k.id = a.km
                              WHERE a.{acol}=? AND a.time >= ? AND a.char IS NOT NULL AND a.{mcol} IS NOT NULL)
                            GROUP BY eid""", (eid, since)):
                    stats[mid] = {"id": mid, "kills": n, "destroyed": round(v or 0, 2), "losses": 0, "lost": 0.0}
                for mid, n, v in c.execute(f"SELECT {mv}, COUNT(*), SUM({V}) FROM killmails WHERE {vcol}=? AND time >= ? AND {mv} IS NOT NULL GROUP BY {mv}", (eid, since)):
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
            # 最贵的击杀与损失（分享图片用）
            result["top_losses"] = [row_summary(r) for r in c.execute(
                f"SELECT {SUMMARY_COLS} FROM killmails WHERE {vcol}=? AND time >= ? ORDER BY {V} DESC LIMIT 5", (eid, since))]
            result["top_kills"] = [row_summary(r) for r in c.execute(
                f"SELECT {SUMMARY_COLS} FROM killmails WHERE time >= ? AND id IN (SELECT km FROM attackers WHERE {acol}=? AND time >= ? AND char IS NOT NULL) ORDER BY {V} DESC LIMIT 5",
                (since, eid, since))]
            result["names"] = self.with_names(result["top_kills"] + result["top_losses"])
            result["name"] = self.names_for([eid]).get(eid)
            return result
        return self.cached(("entity", kind, eid, days), run)

    # GET /api/v1/pilots?ids=1,2,3：本地频道名单分析，每名角色近 30 天的击杀 / 损失、单挑、平均同伙人数、开过的船、常去星系与最近一次击杀
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
                hit = self.pilot_cache.get((cid, sell_mode()))
                if hit and now - hit[0] < CACHE_TTL:
                    out[cid] = hit[1]
                else:
                    todo.append(cid)
        c = self.store.conn() if todo else None
        for cid in todo:
            sub = "SELECT km FROM attackers WHERE char=? AND time >= ?"
            kills, destroyed, solo, gang, last_k = c.execute(
                f"SELECT COUNT(*), COALESCE(SUM({V}),0), COALESCE(SUM(solo),0), AVG(attackers), MAX(time) FROM killmails WHERE time >= ? AND id IN ({sub})",
                (since, cid, since)).fetchone()
            losses, lost, last_l = c.execute(f"SELECT COUNT(*), COALESCE(SUM({V}),0), MAX(time) FROM killmails WHERE v_char=? AND time >= ?", (cid, since)).fetchone()
            # 全部开过的船（前端按舰船分组判断角色定位：诱导 / 轻拦 / 重拦 / 火力 / 后勤 / 特种；前 3 种显示为常用船）
            ships = c.execute("SELECT ship, COUNT(DISTINCT km) n FROM attackers WHERE char=? AND time >= ? AND ship IS NOT NULL GROUP BY ship ORDER BY n DESC LIMIT 40",
                              (cid, since)).fetchall()
            # 最近一次参与的击杀（前端用 ESI 原文里的坐标找最近天体：「星系 · 距星门 127 km」）
            lk = c.execute("SELECT k.id, k.hash, k.time, k.system_id FROM attackers a JOIN killmails k ON k.id = a.km WHERE a.char=? AND a.time >= ? ORDER BY a.time DESC LIMIT 1",
                           (cid, since)).fetchone()
            systems = c.execute(f"SELECT system_id, COUNT(*) n FROM killmails WHERE time >= ? AND (v_char=? OR id IN ({sub})) GROUP BY system_id ORDER BY n DESC LIMIT 3",
                                (since, cid, cid, since)).fetchall()
            # 最近 3 次损失（前端读 ESI 原文看装没装诱导力场发生器，判断是不是开诱导的）
            lr = c.execute("SELECT id, hash FROM killmails WHERE v_char=? AND time >= ? AND hash IS NOT NULL ORDER BY time DESC LIMIT 3", (cid, since)).fetchall()
            last = max(last_k or 0, last_l or 0)
            row = {"kills": kills, "losses": losses, "destroyed": round(destroyed), "lost": round(lost), "solo": solo,
                   "gang": round(gang, 1) if gang else None, "last": iso(last) if last else None,
                   "ships": [[s, n] for s, n in ships], "systems": [[s, n] for s, n in systems],
                   "last_kill": [lk[0], lk[1], iso(lk[2]), lk[3]] if lk and lk[1] else None,
                   "recent_losses": [[i, h] for i, h in lr]}
            out[cid] = row
            with self.pilot_lock:
                self.pilot_cache[(cid, sell_mode())] = (now, row)
                while len(self.pilot_cache) > PILOT_CACHE:
                    self.pilot_cache.popitem(last=False)
        return {"days": 30, "pilots": {str(cid): out[cid] for cid in ids}}

    # GET /kill/<id>
    # ---- 阵亡装配
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
            rows = conn.execute(f"SELECT id, hash, time, {V} FROM killmails WHERE ship_type=? AND id IN ({','.join('?' * len(kills))}) ORDER BY time DESC",
                                (ship, *kills)).fetchall()
            total = len(rows)
        else:
            total = conn.execute("SELECT COUNT(*) FROM killmails WHERE ship_type=? AND time>=?", (ship, since)).fetchone()[0]
            rows = conn.execute(f"SELECT id, hash, time, {V} FROM killmails WHERE ship_type=? AND time>=? ORDER BY time DESC LIMIT ?",
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
                return row, extract_fit(km)
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
                f"SELECT system_id, COUNT(*), SUM({V}), SUM(npc), MAX(time) FROM killmails "
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
        row = self.store.conn().execute("SELECT value, hash, value_sell FROM killmails WHERE id=?", (kid,)).fetchone()
        stored = row is not None
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
            row = (self.store.km_value(km, self.store.price_by_mode), (km.get("zkb") or {}).get("hash"), None)
        elif km is None:
            km, _ = get_json(self.store.esi_url(f"/killmails/{kid}/{row[1]}/"), timeout=20, retries=2)
            with self.km_lock:
                self.km_cache[kid] = km
                while len(self.km_cache) > KM_CACHE:
                    self.km_cache.popitem(last=False)
        # 已入库、还没补上卖价估值的：原文都拿到了，顺手补上（后台补齐任务就少一条）
        if stored and row[2] is None:
            sell = round(self.store.km_value(km, self.store.price_sell), 2)
            with self.store.write_lock:
                c = self.store.conn()
                c.execute("UPDATE killmails SET value_sell = ? WHERE id = ? AND value_sell IS NULL", (sell, kid))
                c.commit()
            row = (row[0], row[1], sell)
        if stored and sell_mode():
            row = (row[2], row[1], row[2])   # 卖价口径：用库里的卖价估值（入库时的价格），和列表里显示的一致
        price = self.store.price_by_mode
        types = {km["victim"]["ship_type_id"]}
        dropped = destroyed = 0.0

        def walk(items):
            nonlocal dropped, destroyed
            for it in items:
                types.add(it["item_type_id"])
                unit = 0.0 if it.get("singleton") == 2 else price(it["item_type_id"])
                dropped += unit * (it.get("quantity_dropped") or 0)
                destroyed += unit * (it.get("quantity_destroyed") or 0)
                walk(it.get("items") or [])
        walk(km["victim"].get("items") or [])
        destroyed += price(km["victim"]["ship_type_id"])  # 船体视为摧毁
        ids = [km["victim"].get(k) for k in ("character_id", "corporation_id", "alliance_id")]
        for a in km.get("attackers") or []:
            ids += [a.get("character_id"), a.get("corporation_id"), a.get("alliance_id")]
        return {"killmail": km, "hash": row[1], "value": round(row[0] or 0, 2), "dropped": round(dropped, 2), "destroyed": round(destroyed, 2),
                "prices": {t: round(price(t), 2) for t in types}, "price_mode": "sell" if sell_mode() else "mid", "names": self.names_for(ids)}


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

    def map_systems(self):
        """只读星系表（不触发成本指数的网络请求）"""
        with self.lock:
            if self.systems is None:
                m = self._load("map-data.json")
                self.systems = {x[0]: {"name": x[1], "sec": x[5], "region": x[6]} for x in m["systems"]}
                self.sys_by_name = {x[1].lower(): x[0] for x in m["systems"]}
                self.regions = {r[0]: r[1] for r in m["regions"]}
        return self.systems

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


# 频道翻译（POST /api/kb/translate，网页 intel.js 用）：自动识别原文语言，译成中文或英文；游戏名词用游戏内的名字。
#   名词：网页认出的星系名（terms，[[原文, 目标语言名], …]，每条消息一组）+ 术语表 GLOSSARY（舰船、装备、技能、常用缩写；译成英文时反查中文物品名）。
#   翻译服务：kb-service 数据库同目录有 youdao.json（{"app_key": "…", "app_secret": "…"}，有道智云文本翻译）就用有道，没有或出错用谷歌翻译。
#   先整句翻译一次拿到原文语言；含名词的消息再按原文语言翻译一次（谷歌：名词放进不翻译标记；有道：名词直接换成目标语言名）。不记日志，只在内存缓存译文。
CHAT_TR_GOOGLE = "https://translate.googleapis.com/translate_a/t?client=gtx"
CHAT_TR_YOUDAO = "https://openapi.youdao.com/api"
CHAT_TR_RATE = 30               # 每个 IP 每分钟最多请求次数
CHAT_TR_MAX = (40, 1000, 8000)  # 每次最多条数、每条最多字数、合计最多字数
CHAT_TR_KEYS = {"path": None}   # youdao.json 的路径（启动时按 --db 设置）
# 聊天里多半是普通英文的小写词：术语表不替换（super rare、starting capital、alpha / omega 账号除外）
CHAT_TR_STOP = {"super", "supers", "capital", "capitals", "caps", "clone", "clones", "null", "industrial", "industrials", "remap", "remaps", "unallocated"}
# 聊天里常见的游戏说法（不区分大小写，按词匹配）→ 国服叫法；译成中文时和术语表一起保留
CHAT_TERMS = {
    "vet": "老玩家", "vets": "老玩家", "veteran": "老玩家", "veterans": "老玩家", "dessie": "驱逐舰", "dessies": "驱逐舰", "dessy": "驱逐舰",
    "standing": "声望", "standings": "声望", "agent": "代理人", "agents": "代理人", "career agent": "职业代理人", "career agents": "职业代理人",
    "mission": "任务", "missions": "任务", "epic arc": "史诗任务线", "eve": "EVE", "fit": "装配", "fits": "装配", "fitting": "装配", "fittings": "装配",
    "bpo": "蓝图原件", "bpos": "蓝图原件", "bpo's": "蓝图原件", "bpc": "蓝图拷贝", "bpcs": "蓝图拷贝", "bpc's": "蓝图拷贝",
    "corp": "军团", "corps": "军团", "npc corp": "NPC 军团", "player corp": "玩家军团", "srp": "补损", "ship replacement": "舰船补损",
    "faction warfare": "势力战争", "fw": "势力战争", "site": "地点", "sites": "地点", "isk": "ISK", "neut": "中立", "neuts": "中立",
}
CHAT_TERMS_RE = re.compile(r"(?<![\w-])(?:" + "|".join(re.escape(k) for k in sorted(CHAT_TERMS, key=len, reverse=True)) + r")(?![\w-])", re.I)
_chat_tr_cache = collections.OrderedDict()
_chat_tr_lock = threading.Lock()
_chat_tr_pool = concurrent.futures.ThreadPoolExecutor(8)


def youdao_keys():
    path = CHAT_TR_KEYS["path"]
    try:
        with open(path) as fh:
            k = json.load(fh)
        return (k["app_key"], k["app_secret"]) if k.get("app_key") and k.get("app_secret") else None
    except Exception:  # noqa: BLE001  没有配置
        return None


def chat_protect(text, tl, pairs):
    """名词换成目标语言名：返回 (谷歌用的 HTML（名词在不翻译标记里）, 有道用的纯文本, 有没有名词)"""
    segs = [(text, False)]
    for src, dst in sorted(pairs, key=lambda x: len(x[0]), reverse=True):
        out = []
        for t, prot in segs:
            if prot or not src:
                out.append((t, prot))
                continue
            word = lambda c: re.match(r"[A-Za-z0-9]", c)   # 英文 / 数字开头结尾的按词匹配，中文按子串
            parts = re.split((r"(?<![\w-])" if word(src[0]) else "") + "(" + re.escape(src) + ")" + (r"(?![\w-])" if word(src[-1]) else ""), t, flags=re.I)
            for i, x in enumerate(parts):
                if i % 2:
                    out.append((dst, True))
                elif x:
                    out.append((x, False))
        segs = out
    html, plain, hit = [], [], False
    for t, prot in segs:
        if prot:
            hit = True
            html.append(f'<span class="notranslate">{html_lib.escape(t, quote=False)}</span>')
            plain.append(t)
            continue
        h = html_lib.escape(t, quote=False)
        g = GLOSSARY.sub(h, CHAT_TR_STOP) if tl == "zh-CN" else GLOSSARY.sub_en(h)
        if g != h:
            hit = True
        html.append(g)
        plain.append(html_lib.unescape(re.sub(r"<[^>]+>", "", g)))
    return "".join(html), "".join(plain), hit


def _google_tr(texts, tl, sl="auto", html=False):
    url = f"{CHAT_TR_GOOGLE}&sl={sl}&tl={tl}" + ("&format=html" if html else "")
    res, _ = get_json(url, timeout=15, retries=2, data=urllib.parse.urlencode([("q", x) for x in texts]).encode(),
                      headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"})
    out = []
    for item in (res if isinstance(res, list) else [res]):
        text, lang = (item[0], item[1] if len(item) > 1 else sl) if isinstance(item, list) else (item, sl)
        if isinstance(text, str) and html:
            text = re.sub(r"\s+([.,!?;:])", r"\1", html_lib.unescape(re.sub(r"<[^>]+>", "", text)))
        out.append([text if isinstance(text, str) else None, lang if isinstance(lang, str) else ""])
    return out


YOUDAO_LANG = {"zh-CHS": "zh-CN", "zh-CHT": "zh-TW"}


def _youdao_one(keys, text, tl, sl="auto"):
    key, secret = keys
    salt, now = os.urandom(8).hex(), str(int(time.time()))
    inp = text if len(text) <= 20 else text[:10] + str(len(text)) + text[-10:]
    sign = hashlib.sha256((key + inp + salt + now + secret).encode()).hexdigest()
    data = urllib.parse.urlencode({"q": text, "from": {"zh-CN": "zh-CHS", "zh-TW": "zh-CHT"}.get(sl, sl), "to": "zh-CHS" if tl == "zh-CN" else "en",
                                   "appKey": key, "salt": salt, "sign": sign, "signType": "v3", "curtime": now}).encode()
    res, _ = get_json(CHAT_TR_YOUDAO, timeout=15, retries=2, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    if not isinstance(res, dict) or str(res.get("errorCode")) != "0" or not res.get("translation"):
        raise RuntimeError(f"有道翻译返回错误 {res.get('errorCode') if isinstance(res, dict) else res}")
    lang = str(res.get("l") or "").split("2")[0]
    return [res["translation"][0], YOUDAO_LANG.get(lang, lang)]


def _youdao_tr(keys, texts, tl, sl="auto"):
    return list(_chat_tr_pool.map(lambda x: _youdao_one(keys, x, tl, sl), texts))


# ---------- 大模型翻译：玩家自己配置的接口（地址、Key、模型都由网页随请求带来，服务器不保存、不写日志）----------
# 协议：openai-chat（POST {base}/chat/completions）、openai-responses（POST {base}/responses）、anthropic（POST {base}/v1/messages）；
# 模型列表从上游取（GET {base}/models 或 {base}/v1/models）。只连公网地址、不跟随跳转，避免被用来访问服务器内网。
LLM_PROTOS = ("openai-chat", "openai-responses", "anthropic")
LLM_TIMEOUT = 60


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


_llm_opener = urllib.request.build_opener(_NoRedirect)


def llm_conf(c):
    if not isinstance(c, dict):
        raise ValueError("大模型设置不对")
    proto, base, key, model = c.get("proto"), str(c.get("base") or "").strip().rstrip("/"), str(c.get("key") or "").strip(), str(c.get("model") or "").strip()
    if proto not in LLM_PROTOS:
        raise ValueError("协议只能是 OpenAI Chat / OpenAI Responses / Anthropic")
    u = urllib.parse.urlparse(base)
    if u.scheme not in ("http", "https") or not u.hostname or len(base) > 300 or u.query or u.fragment:
        raise ValueError("接口地址不对：应为 https://… 开头的网址")
    if not key or len(key) > 500 or any(ch in key for ch in "\r\n"):
        raise ValueError("请填写 API Key")
    try:
        ips = [i[4][0] for i in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), type=socket.SOCK_STREAM)]
    except OSError as e:
        raise ValueError(f"找不到接口地址 {u.hostname}") from e
    if any(not ipaddress.ip_address(ip.split("%")[0]).is_global for ip in ips):
        raise ValueError("接口地址必须是公网地址")
    path = u.path.rstrip("/")
    if proto == "anthropic":   # 填 https://api.anthropic.com 或 …/v1 都行
        root = base[:-3] if path.endswith("/v1") else base
        api = root + "/v1"
    else:                      # OpenAI 兼容：没写版本路径时补 /v1
        api = base if re.search(r"/v\d+[a-z]*$", path) else base + "/v1"
    return {"proto": proto, "api": api, "key": key, "model": model[:200]}


def llm_open(conf, method, path, body=None, timeout=LLM_TIMEOUT, stream=False):
    """向上游发请求，返回响应对象（调用方负责关闭）；出错时抛 LlmError"""
    headers = {"User-Agent": UA, "Accept": "text/event-stream" if stream else "application/json"}
    if conf["proto"] == "anthropic":
        headers.update({"x-api-key": conf["key"], "anthropic-version": "2026-10-21"})
    else:
        headers["Authorization"] = "Bearer " + conf["key"]
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(conf["api"] + path, data=data, headers=headers, method=method)
    try:
        return _llm_opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        msg = ""
        try:
            err = json.loads(e.read(65536) or b"{}")
            msg = (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict) else err.get("error") or err.get("message")
        except Exception:  # noqa: BLE001
            pass
        hint = {401: "API Key 不对", 403: "没有权限", 404: "接口地址或模型不对", 429: "上游限流或额度不足"}.get(e.code, "")
        err = LlmError(f"上游返回 {e.code}{'（' + hint + '）' if hint else ''}{'：' + str(msg)[:200] if msg else ''}")
        try:   # 上游限流时给的等待秒数（AI 助手据此自动重试）
            err.retry = max(1, min(120, int(e.headers.get("Retry-After") or 0))) if e.code == 429 else 0
        except ValueError:
            err.retry = 0
        raise err from None
    except (urllib.error.URLError, OSError) as e:
        raise LlmError(f"连不上接口：{getattr(e, 'reason', e)}") from None


def llm_http(conf, method, path, body=None, timeout=LLM_TIMEOUT):
    with llm_open(conf, method, path, body, timeout) as res:
        try:
            raw = res.read(8 << 20)
        except OSError as e:
            raise LlmError(f"连不上接口：{e}") from None
    try:
        return json.loads(raw)
    except ValueError:
        raise LlmError("上游返回的不是 JSON（接口地址可能不对）") from None


def _sse(res):
    """逐个产出上游 SSE 事件的 data（JSON）"""
    data = []
    for raw in res:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
            continue
        if line or not data:
            continue
        text, data = "\n".join(data), []
        if text.strip() == "[DONE]":
            return
        try:
            ev = json.loads(text)
        except ValueError:
            continue
        if isinstance(ev, dict):
            yield ev
    if data and data[0].strip() != "[DONE]":
        try:
            yield json.loads("\n".join(data))
        except ValueError:
            pass


def _sse_error(ev):
    e = ev.get("error") or (ev.get("response") or {}).get("error") or ev
    msg = e.get("message") if isinstance(e, dict) else str(e)
    err = LlmError(f"上游出错：{str(msg or '未知错误')[:200]}")
    # 过载 / 限流：让浏览器等一会儿自动重试
    kind = f"{e.get('type', '')} {e.get('code', '')} {msg}".lower() if isinstance(e, dict) else str(msg).lower()
    if any(w in kind for w in ("overload", "rate_limit", "rate limit", "429", "529", "try again")):
        err.retry = 15
    return err


def llm_stream(conf, path, body, on_text, timeout):
    """流式调用上游：文字增量交给 on_text，结束后拼成与非流式相同结构的响应返回（三种协议共用后续解析）"""
    proto = conf["proto"]
    with llm_open(conf, "POST", path, body, timeout, stream=True) as res:
        try:
            if "json" in (res.headers.get("Content-Type") or ""):   # 上游不支持流式，直接给了完整结果
                return json.loads(res.read(8 << 20))
            if proto == "anthropic":
                blocks, stop, usage = {}, None, None
                for ev in _sse(res):
                    t = ev.get("type")
                    if t == "error":
                        raise _sse_error(ev)
                    if t == "content_block_start":
                        b = dict(ev.get("content_block") or {})
                        if b.get("type") == "tool_use":
                            b["_json"] = ""
                        blocks[ev.get("index", len(blocks))] = b
                    elif t == "content_block_delta":
                        b, d = blocks.setdefault(ev.get("index", 0), {"type": "text", "text": ""}), ev.get("delta") or {}
                        dt = d.get("type")
                        if dt == "text_delta":
                            b["text"] = b.get("text", "") + d.get("text", "")
                            on_text(d.get("text", ""))
                        elif dt == "input_json_delta":
                            b["_json"] = b.get("_json", "") + d.get("partial_json", "")
                        elif dt == "thinking_delta":
                            b["thinking"] = b.get("thinking", "") + d.get("thinking", "")
                        elif dt == "signature_delta":
                            b["signature"] = b.get("signature", "") + d.get("signature", "")
                    elif t == "message_delta":
                        stop = (ev.get("delta") or {}).get("stop_reason") or stop
                        usage = ev.get("usage") or usage
                content = []
                for i in sorted(blocks):
                    b = blocks[i]
                    if "_json" in b:
                        b["input"] = _ai_args(b.pop("_json") or "{}")
                    content.append(b)
                return {"content": content, "stop_reason": stop, "usage": usage}
            if proto == "openai-responses":
                final, items = None, []
                for ev in _sse(res):
                    t = ev.get("type")
                    if t in ("error", "response.failed"):
                        raise _sse_error(ev)
                    if t == "response.output_text.delta":
                        on_text(ev.get("delta") or "")
                    elif t == "response.output_item.done" and isinstance(ev.get("item"), dict):
                        items.append(ev["item"])
                    elif t in ("response.completed", "response.incomplete"):
                        final = ev.get("response") or {}
                final = final or {}
                if not final.get("output"):
                    final["output"] = items
                return final
            text, reasoning, calls, finish, usage = "", "", {}, None, None
            for ev in _sse(res):
                if ev.get("error"):
                    raise _sse_error(ev)
                usage = ev.get("usage") or usage
                for ch in ev.get("choices") or []:
                    d = ch.get("delta") or {}
                    if isinstance(d.get("content"), str) and d["content"]:
                        text += d["content"]
                        on_text(d["content"])
                    if isinstance(d.get("reasoning_content"), str):
                        reasoning += d["reasoning_content"]
                    for tc in d.get("tool_calls") or []:
                        c = calls.setdefault(tc.get("index", len(calls)), {"id": None, "type": "function", "function": {"name": "", "arguments": ""}})
                        f = tc.get("function") or {}
                        c["id"] = tc.get("id") or c["id"]
                        if f.get("name") and f["name"] != c["function"]["name"]:
                            c["function"]["name"] += f["name"]
                        c["function"]["arguments"] += f.get("arguments") or ""
                    finish = ch.get("finish_reason") or finish
            msg = {"content": text, "tool_calls": [calls[i] for i in sorted(calls)]}
            if reasoning:
                msg["reasoning_content"] = reasoning
            return {"choices": [{"message": msg, "finish_reason": finish}], "usage": usage}
        except (OSError, ValueError) as e:
            raise LlmError(f"上游连接中断：{e}") from None


class LlmError(RuntimeError):
    retry = 0


def llm_models(body):
    """上游的模型列表（id 排序）"""
    conf = llm_conf(body)
    ids, after = [], None
    for _ in range(10):   # Anthropic 分页：has_more / last_id
        q = "?limit=1000" + (f"&after_id={urllib.parse.quote(after)}" if after else "") if conf["proto"] == "anthropic" else ""
        res = llm_http(conf, "GET", "/models" + q)
        items = res.get("data") if isinstance(res, dict) else res
        ids += [str(m.get("id")) for m in items or [] if isinstance(m, dict) and m.get("id")]
        if not (isinstance(res, dict) and res.get("has_more") and res.get("last_id")):
            break
        after = res["last_id"]
    return {"models": sorted(set(ids))}


# 提示词尽量短：每次请求都要发；输出每行「序号<TAB>译文」，比 JSON 省 token
LLM_SYSTEM = {
    "zh-CN": "把 EVE Online 游戏聊天译成简体中文：像玩家聊天一样自然意译；游戏名词用国服叫法，「名词」里给的照用；角色名原样保留；"
             "缩写和错字按本意理解。每条输出一行：序号<TAB>译文；已是中文或无需翻译的只写序号。不要输出别的。",
    "en": "Translate EVE Online in-game chat into natural English, like players talk; use official English names for game terms "
          "(always use the given terms); keep character names unchanged. One line per message: index<TAB>translation; "
          "for messages already in English or needing no translation, write only the index. Output nothing else.",
}
LLM_LINE = re.compile(r"^\s*\[?(\d+)\]?[\t ]*[:：|.、\t-]?[\t ]*(.*)$")
# 译成中文时已经是中文的消息不发给模型（中文字为主、拉丁字母很少）
is_zh = lambda t: bool(re.search(r"[\u4e00-\u9fff]", t)) and len(re.findall(r"[A-Za-z]", t)) <= len(re.findall(r"[\u4e00-\u9fff]", t)) // 2


def llm_translate(conf, texts, tl, hints):
    user = ("名词：" if tl == "zh-CN" else "Terms: ") + "；".join(f"{a}={b}" for a, b in hints[:300]) + "\n" if hints else ""
    user += "\n".join(f"{i}\t{t}" for i, t in enumerate(texts))
    system = LLM_SYSTEM[tl]
    if conf["proto"] == "anthropic":
        res = llm_http(conf, "POST", "/messages", {"model": conf["model"], "max_tokens": 16000, "system": system, "messages": [{"role": "user", "content": user}]})
        res = res if isinstance(res, dict) else {}
        if res.get("stop_reason") == "refusal":
            raise LlmError("模型拒绝了这次翻译")
        out = "".join(b.get("text", "") for b in res.get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
    elif conf["proto"] == "openai-responses":
        res = llm_http(conf, "POST", "/responses", {"model": conf["model"], "instructions": system, "input": user})
        res = res if isinstance(res, dict) else {}
        out = res.get("output_text") if isinstance(res.get("output_text"), str) else "".join(
            c.get("text", "") for o in res.get("output") or [] if isinstance(o, dict) and o.get("type") == "message"
            for c in o.get("content") or [] if isinstance(c, dict) and c.get("type") in ("output_text", "text"))
    else:
        res = llm_http(conf, "POST", "/chat/completions", {"model": conf["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
        res = res if isinstance(res, dict) else {}
        msg = ((res.get("choices") or [{}])[0] or {}).get("message") or {}
        c = msg.get("content")
        out = c if isinstance(c, str) else "".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
    got, hit = [None] * len(texts), False
    for line in (out or "").replace("```", "").splitlines():
        m = LLM_LINE.match(line)
        if m and int(m.group(1)) < len(texts):
            hit = True
            got[int(m.group(1))] = [m.group(2).strip(), ""]
    if not hit:
        raise LlmError("模型没有按要求返回结果，换个模型试试")
    return [g or ["", ""] for g in got]


def chat_hints(text, tl, pairs):
    """给大模型的名词对照：网页带来的星系 / 人名 + 术语表 + 聊天常用说法里出现在消息中的"""
    out = list(pairs)
    if GLOSSARY.re is None:
        GLOSSARY.load()
    if tl == "zh-CN":
        for m in GLOSSARY.re.finditer(text) if GLOSSARY.re else []:
            w = m.group(0)
            zh = re.sub(r"<[^>]+>", "", GLOSSARY.sub(w, CHAT_TR_STOP))
            if zh != w:
                out.append((w, zh))
    else:
        out += [(m.group(0), GLOSSARY.rev[m.group(0)]) for m in (GLOSSARY.rev_re.finditer(text) if GLOSSARY.rev_re else [])]
    return out


def chat_translate(body):
    tl = body.get("tl")
    q = body.get("q")
    terms = body.get("terms") or []
    if tl not in ("zh-CN", "en") or not isinstance(q, list) or not 0 < len(q) <= CHAT_TR_MAX[0] \
            or not all(isinstance(x, str) and 0 < len(x) <= CHAT_TR_MAX[1] for x in q) or sum(map(len, q)) > CHAT_TR_MAX[2]:
        raise ValueError("请求体应为 JSON：{q: [文字…], tl: 'zh-CN' | 'en', terms: [[[原文, 译名], …], …]}")
    pairs = []
    for i in range(len(q)):
        t = terms[i] if isinstance(terms, list) and i < len(terms) and isinstance(terms[i], list) else []
        p = [(str(a)[:100], str(b)[:100]) for a, b in (x for x in t[:20] if isinstance(x, list) and len(x) == 2)]
        if tl == "zh-CN":
            p += [(w, CHAT_TERMS[w.lower()]) for w in dict.fromkeys(m.group(0) for m in CHAT_TERMS_RE.finditer(q[i]))]
        pairs.append(tuple(p))
    llm = llm_conf(body["llm"]) if body.get("llm") else None
    if llm and not llm["model"]:
        raise ValueError("请先选择模型")
    if llm:   # 大模型：一次整批翻译，名词对照放进提示词；按配置区分缓存
        ck = lambda i: (tl, q[i], pairs[i], llm["api"], llm["model"])
        with _chat_tr_lock:
            out = [_chat_tr_cache.get(ck(i)) for i in range(len(q))]
        for i in range(len(q)):
            if out[i] is None and tl == "zh-CN" and is_zh(q[i]):
                out[i] = ["", "zh-CN"]
        todo = [i for i in range(len(q)) if out[i] is None]
        if todo:
            hints = list(dict.fromkeys(h for i in todo for h in chat_hints(q[i], tl, pairs[i]) if h[0].lower() != h[1].lower()))
            res = llm_translate(llm, [q[i] for i in todo], tl, hints)
            with _chat_tr_lock:
                for i, v in zip(todo, res):
                    if v is not None:
                        out[i] = v
                        _chat_tr_cache[ck(i)] = v
                while len(_chat_tr_cache) > 20000:
                    _chat_tr_cache.popitem(last=False)
        return {"result": out, "via": "llm"}
    keys = youdao_keys()
    ck = lambda i: (tl, q[i], pairs[i])
    with _chat_tr_lock:
        out = [_chat_tr_cache.get(ck(i)) for i in range(len(q))]
    todo = [i for i in range(len(q)) if out[i] is None]
    if todo:
        def run(texts, sl="auto", html=False, plain=None):
            if keys:
                try:
                    return _youdao_tr(keys, plain or texts, tl, sl)
                except Exception as e:  # noqa: BLE001
                    log.warning("有道翻译失败，改用谷歌: %s", e)
            return _google_tr(texts, tl, sl, html)
        try:
            first = run([q[i] for i in todo])
            got = dict(zip(todo, first))
            # 含游戏名词、且不是目标语言的：按原文语言再翻一次，名词保留游戏内的名字
            again = {}
            for i in todo:
                text, lang = got.get(i) or [None, ""]
                if not text or not lang or lang[:2] == tl[:2]:
                    continue
                h, plain, hit = chat_protect(q[i], tl, pairs[i])
                if hit:
                    again.setdefault(lang, []).append((i, h, plain))
            for lang, items in again.items():
                res = run([h for _, h, _ in items], sl=lang, html=True, plain=[p for _, _, p in items])
                for (i, _, _), (text, _) in zip(items, res):
                    if text:
                        got[i] = [text, got[i][1]]
        except Exception as e:  # noqa: BLE001
            log.warning("频道翻译失败: %s", e)
            raise RuntimeError("翻译服务暂时不可用")
        with _chat_tr_lock:
            for i, v in got.items():
                if v and v[0]:
                    _chat_tr_cache[ck(i)] = v
            while len(_chat_tr_cache) > 20000:
                _chat_tr_cache.popitem(last=False)
        out = [o or got.get(i) for i, o in enumerate(out)]
    return {"result": [chat_tidy(o, tl) for o in out], "via": "youdao" if keys else "google"}


def chat_tidy(item, tl):
    """译成中文后：修正常见误译（公司 → 军团等，同集市翻译），中文和英文 / 数字之间加空格"""
    if not item or not item[0] or tl != "zh-CN":
        return item
    text = item[0]
    for a, b in ZH_FIX:
        text = text.replace(a, b)
    text = re.sub(r"([A-Za-z0-9])([\u4e00-\u9fff])", r"\1 \2", text)
    text = re.sub(r"([\u4e00-\u9fff])([A-Za-z0-9])", r"\1 \2", text)
    return [text, item[1]]


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
            # 反向（中文名 → 英文名，频道翻译译成英文时用）：只用装配数据里的物品名，按子串匹配，长的优先
            self.rev = {}
            for en, zh in names.items():
                if len(zh) >= 2:
                    self.rev.setdefault(zh, en)
            self.rev_re = re.compile("|".join(re.escape(zh) for zh in sorted(self.rev, key=len, reverse=True))) if self.rev else False
            log.info("游戏术语表：%d 条", len(terms))

    def sub(self, text, skip=()):
        """skip：这些写法原样不换（频道翻译里 super、capital 等小写词多半是普通英文）"""
        if self.re is None:
            self.load()
        if not self.re:
            return text
        def one(m):
            w = m.group(0)
            if w in skip:
                return w
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

    def sub_en(self, text):
        """中文物品名 → 英文名（标成不翻译）"""
        if self.re is None:
            self.load()
        if not self.rev_re:
            return text
        return self.rev_re.sub(lambda m: f'<span class="notranslate">{self.rev[m.group(0)]}</span>', text)


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
# sshare：近 30 天成交量里有多少比例成交在卖单一侧（改单推荐用，见 sell_share）
# scomp / bcomp：改单竞争——最优价 ARB_DEPTH 以内、近 ARB_COMP_HOURS 小时发布或改过价的卖单 / 收单张数（ESI 的 issued 是最后修改时间）
ARB_FIELDS = ["sell", "buy", "sell_qty", "buy_qty", "sell_depth", "buy_depth", "daily", "avg", "daily7", "daily1", "sshare", "scomp", "bcomp"]
ARB_COMP_HOURS = 24


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
def sell_share(days):
    """days：[(日期, 均价, 最低, 最高, 成交量)] → 卖单侧成交占比（按成交量加权）。
    ESI 每天只有成交均价，不分收单 / 卖单；把当天最低价近似当收单侧成交价、最高价当卖单侧，
    均价 = f × 最高 + (1 − f) × 最低，解出 f。最高等于最低（只有一种价）的日子不算。"""
    num = den = 0.0
    for d in days:
        avg, lo, hi, v = d[1], d[2], d[3], d[4] if len(d) > 4 else 0
        if not v or not lo or not hi or hi <= lo * 1.0001:
            continue
        num += min(1.0, max(0.0, (avg - lo) / (hi - lo))) * v
        den += v
    return round(num / den, 4) if den else None


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
            if "sshare" not in cols:
                c.execute("ALTER TABLE arb_volume ADD COLUMN sshare REAL")
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
                b[1].append((o["price"], o["volume_remain"], o.get("issued") or ""))
        else:
            b[0].append((o["price"], o["volume_remain"], o.get("issued") or ""))

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
        fresh = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=ARB_COMP_HOURS)).strftime("%Y-%m-%dT%H:%M:%S")   # issued 是 ISO 字符串，直接按字符串比
        for k, (rid, _) in enumerate(hubs):
            for t, (sells, buys) in books[rid].items():
                sells.sort()
                buys.sort(reverse=True)
                sell = sells[0][0] if sells else None
                buy = buys[0][0] if buys else None
                near_s = [o for o in sells if o[0] <= sell * (1 + ARB_DEPTH)] if sells else []
                near_b = [o for o in buys if o[0] >= buy * (1 - ARB_DEPTH)] if buys else []
                r = rows.setdefault(t, [None] * len(hubs))
                r[k] = [sell, buy, sum(o[1] for o in sells), sum(o[1] for o in buys),
                        sum(o[1] for o in near_s), sum(o[1] for o in near_b),
                        sum(1 for o in near_s if o[2] >= fresh), sum(1 for o in near_b if o[2] >= fresh)]
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
        return {(r, t): (d, a, d7, d1, ss, *m) for r, t, d, a, d7, d1, ss, *m in c.execute(f"SELECT region, type_id, daily, avg, daily7, daily1, sshare, {HIST_COLS} FROM arb_volume WHERE server=?", (server,))}

    def publish(self, server, hubs, rows, daily):
        types, full = {}, {}
        n = 5 + len(HIST_FIELDS)
        rnd = lambda v: round(v, 2) if v is not None else None
        for t, r in rows.items():
            out, out_full = [], []
            for k, (rid, _) in enumerate(hubs):
                h = r[k]
                if h is None:
                    out.append(None)
                    out_full.append(None)
                    continue
                d, a, d7, d1, ss, *m = (tuple(daily.get((rid, t)) or ()) + (None,) * n)[:n]
                base = [*h[:6], rnd(d), round(a, 2) if a else None, rnd(d7), rnd(d1), ss, h[6], h[7]]
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
            except Exception as e:             # 下载中断等：这一天先跳过，下次刷新再补（不能让整轮汇总停在「读取成交量」）
                log.warning("EVE Ref 市场历史 %s 读取失败：%s", key, e)
                continue
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
                    prices.setdefault(key, []).append((k, isk / v, *(lh or (None, None)), v))
        sinces = [keep[-n] if len(keep) >= n else keep[0] for n in ARB_HIST_DAYS] if keep else []
        stats = {key: hist_stats(ps, sinces) for key, ps in prices.items()}
        share = {key: sell_share(ps) for key, ps in prices.items()}
        # (30 天日均成交量, 成交均价, 7 天日均, 最近一天, 卖单侧占比, 中位价..., 最低价..., 最高价...)
        none = (None,) * len(HIST_FIELDS)
        return {k: (v / n, isk / v if v else None, v7 / n7, v1, share.get(k), *stats.get(k, none)) for k, (v, isk, v7, v1) in out.items()}

    def volumes_esi(self, server, cfg, rows, st, on_progress):
        """国服：逐个查 ESI 星域历史（库里缓存 1 天）；挂单额大的物品优先，每轮最多 ARB_HISTORY_BUDGET 次"""
        hubs = list(cfg["hubs"])
        c = self.store.conn()
        cached = {(r, t): (d, at, a, d7, d1, ss, *m) for r, t, d, at, a, d7, d1, ss, *m in c.execute(f"SELECT region, type_id, daily, at, avg, daily7, daily1, sshare, {HIST_COLS} FROM arb_volume WHERE server=?", (server,))}
        now = int(time.time())
        todo = []
        for t, r in rows.items():
            for k, rid in enumerate(hubs):
                h = r[k]
                if h is None:
                    continue
                hit = cached.get((rid, t))
                if hit and now - hit[1] < ARB_HISTORY_TTL and (hit[2] is not None or not hit[0]) and hit[3] is not None and hit[4] is not None \
                        and (hit[-1] is not None or not hit[0]) and (hit[5] is not None or not hit[0]):   # 旧记录没有中位价 / 卖单侧占比的重新读
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
            days = sorted((d["date"], d["average"], d.get("lowest"), d.get("highest"), d["volume"]) for d in (hist or []) if d["volume"])
            last = max(recent, key=lambda d: d["date"])["date"] if recent else ""
            sinces = [last if n == 1 else (today - dt.timedelta(days=n - 1)).isoformat() for n in ARB_HIST_DAYS]
            ss = sell_share([d for d in days if d[0] > cutoff])
            return rid, t, vol / ARB_DAYS, isk / vol if vol else None, vol7 / 7, vol1, ss, *hist_stats(days, sinces)
        out = {k: (v[0], *v[2:]) for k, v in cached.items()}
        got = []

        def flush():
            with self.store.write_lock:
                c.executemany(f"INSERT OR REPLACE INTO arb_volume(server, region, type_id, daily, at, avg, daily7, daily1, sshare, {HIST_COLS}) VALUES(?,?,?,?,?,?,?,?,?{',?' * len(HIST_FIELDS)})",
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
# 海盗叛乱（只有宁静）：CCP 官网 Frontlines 页面用的公开数据（CloudFront 缓存 150 秒；不允许浏览器跨域读，由这里中转），同一轮询里每 5 分钟读一次。
# 接口 GET /api/v1/fw/insurgency?server=：每个海盗势力当前（或刚结束）的一场叛乱：阶段、海盗 FOB、胜利所需星系数、各星系腐蚀 / 镇压进度。
#   官方数据的 startDateTime 是「预告」开始的时间（转入进行中后不变），endDateTime 一直是空的，游戏里进行中的叛乱也不显示结束时间；
#   所以这里记下每场叛乱各阶段第一次出现的时间：亲眼看到「预告 → 进行中」才给出 active_since（误差约一个轮询周期加 CDN 缓存），结束同理。
INSURGENCY_URL = "https://www.eveonline.com/api/warzone/insurgency"
INSURGENCY_KEEP = 120 * 86400
INSURGENCY_DONE = ("PIRATE_VICTORY", "ANTI_PIRATE_VICTORY", "NO_WINNER")


class FwTracker:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.cache = {}         # server -> 接口结果
        self.ins = None         # 海盗叛乱接口结果
        self.ins_lock = threading.Lock()
        c = store.conn()
        with store.write_lock:
            c.execute("CREATE TABLE IF NOT EXISTS fw_snap(server TEXT, system_id INTEGER, at INTEGER, vp INTEGER, threshold INTEGER, occupier INTEGER, contested TEXT,"
                      " PRIMARY KEY(server, system_id, at)) WITHOUT ROWID")
            c.execute("CREATE TABLE IF NOT EXISTS insurgency_seen(campaign INTEGER, state TEXT, at INTEGER, PRIMARY KEY(campaign, state)) WITHOUT ROWID")
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
            try:
                self.insurgency_fetch()
            except Exception as e:
                log.warning("海盗叛乱数据读取失败：%s", e)
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

    # ---------- 海盗叛乱（只有宁静）----------
    def insurgency_fetch(self):
        """读一次官网叛乱数据，记下每场叛乱各阶段第一次出现的时间，返回整理好的接口结果"""
        data, _ = get_json(INSURGENCY_URL, timeout=30, retries=2)
        if not isinstance(data, list):
            raise ValueError("叛乱数据格式不对")
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            c.executemany("INSERT OR IGNORE INTO insurgency_seen VALUES (?,?,?)",
                          [(x["campaignId"], x["state"], now) for x in data if x.get("campaignId") and x.get("state")])
            c.execute("DELETE FROM insurgency_seen WHERE at < ?", (now - INSURGENCY_KEEP,))
            c.commit()
        seen = collections.defaultdict(dict)
        ids = [x["campaignId"] for x in data if x.get("campaignId")]
        if ids:
            for cid, state, at in c.execute(f"SELECT campaign, state, at FROM insurgency_seen WHERE campaign IN ({','.join('?' * len(ids))})", ids):
                seen[cid][state] = at
        iso = lambda s: calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) if s else None
        campaigns = []
        for x in data:
            s = seen.get(x.get("campaignId"), {})
            state = x.get("state")
            # 前一阶段也在记录里，才说明亲眼看到了阶段变化；否则第一次出现的时间只是本站开始记录的时间
            active = s.get("ACTIVE") if "FORECAST" in s else None
            ended = s.get(state) if state in INSURGENCY_DONE and "ACTIVE" in s else None
            campaigns.append({
                "campaign_id": x.get("campaignId"), "pirate_faction_id": x.get("pirateFactionId"), "state": state,
                "forecast_start": iso(x.get("startDateTime")), "active_since": active, "ended": ended,
                "corruption_required": x.get("corruptionThresHold"), "suppression_required": x.get("suppressionThresHold"),
                "fob_system_id": (x.get("originSolarSystem") or {}).get("id"),
                "systems": [{"system_id": (i.get("solarSystem") or {}).get("id"),
                             "corruption": i.get("corruptionPercentage"), "corruption_stage": i.get("corruptionState"),
                             "suppression": i.get("suppressionPercentage"), "suppression_stage": i.get("suppressionState"),
                             "owner_faction_id": (i.get("solarSystem") or {}).get("ownerFactionId"),
                             "occupier_faction_id": (i.get("solarSystem") or {}).get("occupierFactionId")}
                            for i in x.get("insurgencies") or []]})
        out = {"server": "tq", "updated": now, "source": INSURGENCY_URL, "campaigns": campaigns}
        with self.lock:
            self.ins = out
        return out

    def insurgency(self, q):
        server = q.get("server") or "tq"
        if server not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        if server != "tq":
            return {"server": server, "updated": None, "campaigns": [], "note": "国服没有公开的叛乱数据"}
        with self.lock:
            hit = self.ins
        if hit and time.time() - hit["updated"] < FW_POLL + 60:
            return hit
        # 后台轮询没开（演示环境）或最近几次读失败：现读一次，失败就退回上一份
        with self.ins_lock:
            with self.lock:
                hit = self.ins
            if hit and time.time() - hit["updated"] < FW_POLL + 60:
                return hit
            try:
                return self.insurgency_fetch()
            except Exception as e:
                log.warning("海盗叛乱数据读取失败：%s", e)
                if hit:
                    return {**hit, "stale": True}
                raise ValueError("暂时读不到叛乱数据")


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


# ---------------------------------------------------------------- 设置云同步
# 个人中心「云同步」：浏览器把本站的本地设置（收藏、税费技能、规划、排除列表等，不含 ESI 令牌）加密后存到服务器，
# 换个浏览器用同一个用户名和密码登录就能取回，之后定时双向同步。
# 密码不出浏览器：浏览器用 PBKDF2(密码, 用户名) 派生出「登录密钥」和「加密密钥」，只把登录密钥发来；
# 服务器再对登录密钥加盐做 PBKDF2 后保存。数据用加密密钥 AES-GCM 加密，服务器看不到内容，忘记密码就无法解密。
# push 带上次拉到的版本号 base，与服务器当前版本不一致时返回 409 和最新内容，由浏览器合并后再提交。
SYNC_SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_user(user TEXT PRIMARY KEY, salt BLOB, hash BLOB, ver INTEGER, data TEXT, updated INTEGER, created INTEGER);
"""
SYNC_MAX = 4 * 1024 * 1024      # 一个账号最多存多少（加密后的 base64 文本）
SYNC_RATE = 30                  # 每个 IP 每分钟最多请求次数
SYNC_FAIL_MAX = 8               # 每个用户名 10 分钟内最多输错几次
SYNC_USER_RE = re.compile(r"[A-Za-z0-9_\-.\u4e00-\u9fff]{2,24}")
SYNC_AUTH_RE = re.compile(r"[0-9a-f]{64}")


class SettingsSync:
    def __init__(self, store):
        self.store = store
        self.fails = {}            # 用户名 -> [失败时间...]
        self.lock = threading.Lock()
        c = store.conn()
        with store.write_lock:
            c.executescript(SYNC_SCHEMA)
            c.commit()

    @staticmethod
    def digest(auth, salt):
        return hashlib.pbkdf2_hmac("sha256", bytes.fromhex(auth), salt, 100000)

    def params(self, body):
        user, auth = body.get("user"), body.get("auth")
        if not isinstance(user, str) or not SYNC_USER_RE.fullmatch(user):
            raise ValueError("用户名为 2–24 个字母、数字、汉字或 _ - .")
        if not isinstance(auth, str) or not SYNC_AUTH_RE.fullmatch(auth):
            raise ValueError("登录密钥无效")
        return user.lower(), auth

    def check(self, user, auth):
        """校验登录密钥，返回账号行（ver, data, updated）；用户不存在 / 密码错都抛 PermissionError"""
        now = time.time()
        with self.lock:
            recent = [t for t in self.fails.get(user, []) if now - t < 600]
            self.fails[user] = recent
            if len(recent) >= SYNC_FAIL_MAX:
                raise PermissionError("密码错误次数太多，请 10 分钟后再试")
        row = self.store.conn().execute("SELECT salt, hash, ver, data, updated FROM sync_user WHERE user=?", (user,)).fetchone()
        if not row or not hmac.compare_digest(self.digest(auth, row[0]), row[1]):
            with self.lock:
                self.fails.setdefault(user, []).append(now)
                if len(self.fails) > 20000:
                    self.fails = {k: v for k, v in self.fails.items() if v and now - v[-1] < 600}
            raise PermissionError("用户名或密码不对")
        with self.lock:
            self.fails.pop(user, None)
        return row[2], row[3], row[4]

    def register(self, body):
        user, auth = self.params(body)
        salt = os.urandom(16)
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            try:
                c.execute("INSERT INTO sync_user VALUES(?,?,?,?,?,?,?)", (user, salt, self.digest(auth, salt), 0, None, now, now))
                c.commit()
            except sqlite3.IntegrityError:
                raise ValueError("这个用户名已经有人用了")
        return {"user": user, "ver": 0, "data": None, "updated": now}

    def pull(self, body):
        user, auth = self.params(body)
        ver, data, updated = self.check(user, auth)
        if body.get("have") == ver:   # 浏览器手上已经是这个版本：不回传数据
            return {"user": user, "ver": ver, "same": True, "updated": updated}
        return {"user": user, "ver": ver, "data": data, "updated": updated}

    def push(self, body):
        user, auth = self.params(body)
        base, data = body.get("base"), body.get("data")
        if type(base) is not int or not isinstance(data, str) or not data or len(data) > SYNC_MAX:
            raise ValueError("data 应为不超过 4MB 的密文")
        ver, cur, updated = self.check(user, auth)
        if base != ver:
            return {"conflict": True, "user": user, "ver": ver, "data": cur, "updated": updated}
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            n = c.execute("UPDATE sync_user SET ver=?, data=?, updated=? WHERE user=? AND ver=?", (ver + 1, data, now, user, ver)).rowcount
            c.commit()
        if not n:   # 并发提交：让浏览器重新拉取合并
            ver, cur, updated = self.check(user, auth)
            return {"conflict": True, "user": user, "ver": ver, "data": cur, "updated": updated}
        return {"user": user, "ver": ver + 1, "updated": now}

    def delete(self, body):
        user, auth = self.params(body)
        self.check(user, auth)
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM sync_user WHERE user=?", (user,))
            c.commit()
        return {"deleted": True}


# ---------------------------------------------------------------- 自挂角色（曙光服角色交易）
# 曙光服没有藏宝阁这类交易渠道：玩家用本站绑定的 ESI 令牌挂售自己的角色，自填人民币价格和 QQ（不提供备注）。
# 令牌只用于本次请求（证明角色归属、读取技能 / 钱包等快照），不落盘、不写日志；快照由服务器从 ESI 读取，卖家无法改动。
# 挂单 SALE_DAYS 天后自动下架，卖家重新提交即续期并刷新快照
SALE_SERVERS = ("infinity",)
SALE_DAYS = 30
SALE_RATE = 20                  # 每个 IP 每分钟最多提交次数
SALE_PRICE_MAX = 10_000_000     # 价格上限（元）
SALE_QQ_RE = re.compile(r"[0-9]{1,32}")
SALE_SCHEMA = """
CREATE TABLE IF NOT EXISTS char_sale(server TEXT, char_id INTEGER, price INTEGER, qq TEXT, data TEXT, created INTEGER, updated INTEGER,
  PRIMARY KEY(server, char_id));
"""


class CharSale:
    def __init__(self, store, wallet):
        self.store, self.esi = store, wallet.esi
        c = store.conn()
        with store.write_lock:
            c.executescript(SALE_SCHEMA)
            c.commit()

    @staticmethod
    def server_of(v):
        if v not in SALE_SERVERS:
            raise ValueError("角色挂售只支持：" + " / ".join(SALE_SERVERS))
        return v

    def snapshot(self, server, char, token):
        """用令牌读技能（ESI 返回 200 才认为令牌属于这个角色），其余数据读不到就留空"""
        sk, _ = self.esi(server, f"/characters/{char}/skills/", token)

        def opt(path):
            try:
                return self.esi(server, path, token)[0]
            except (PermissionError, EsiUnavailable):
                return None
        cfg = ARB_SERVERS[server]
        try:
            pub, _ = get_json(f"{cfg['esi']}/characters/{char}/?{cfg['qs']}", timeout=20, retries=2)
        except Exception:
            raise EsiUnavailable("角色公开信息读取失败") from None
        loc, ship, clones = opt(f"/characters/{char}/location/"), opt(f"/characters/{char}/ship/"), opt(f"/characters/{char}/clones/")
        ids = [i for i in (pub.get("corporation_id"), pub.get("alliance_id"), (loc or {}).get("solar_system_id"), (ship or {}).get("ship_type_id")) if i]
        names = {r["id"]: r["name"] for r in resolve_names(ids, url=f"{cfg['esi']}/universe/names/?{cfg['qs']}")} if ids else {}
        skills = sorted(([x["skill_id"], x.get("trained_skill_level") or 0, x.get("skillpoints_in_skill") or 0] for x in (sk or {}).get("skills") or []), key=lambda x: x[0])
        return {
            "name": pub.get("name") or str(char), "birthday": pub.get("birthday"), "sec": pub.get("security_status"),
            "corp_id": pub.get("corporation_id"), "corp": names.get(pub.get("corporation_id")),
            "alliance_id": pub.get("alliance_id"), "alliance": names.get(pub.get("alliance_id")),
            "total_sp": (sk or {}).get("total_sp") or 0, "unallocated_sp": (sk or {}).get("unallocated_sp") or 0, "skills": skills,
            "attrs": opt(f"/characters/{char}/attributes/"), "isk": opt(f"/characters/{char}/wallet/"),
            "implants": opt(f"/characters/{char}/implants/"),
            "system": names.get((loc or {}).get("solar_system_id")), "ship_type": (ship or {}).get("ship_type_id"),
            "ship": names.get((ship or {}).get("ship_type_id")),
            "jump_clones": len((clones or {}).get("jump_clones") or []) if clones else None,
        }

    def save(self, body, token):
        server = self.server_of(body.get("server"))
        char, price, qq = body.get("character_id"), body.get("price"), body.get("qq")
        if type(char) is not int or char <= 0:
            raise ValueError("character_id 应为正整数")
        if type(price) is not int or not 0 < price <= SALE_PRICE_MAX:
            raise ValueError(f"价格应为 1–{SALE_PRICE_MAX} 的整数（元）")
        if not isinstance(qq, str) or not SALE_QQ_RE.fullmatch(qq):
            raise ValueError("QQ 号只能是数字")
        data = self.snapshot(server, char, token)
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            row = c.execute("SELECT created FROM char_sale WHERE server=? AND char_id=? AND updated>?", (server, char, now - SALE_DAYS * 86400)).fetchone()
            c.execute("INSERT OR REPLACE INTO char_sale(server, char_id, price, qq, data, created, updated) VALUES(?,?,?,?,?,?,?)",
                      (server, char, price, qq, json.dumps(data, ensure_ascii=False, separators=(",", ":")), row[0] if row else now, now))
            c.commit()
        return self.detail({"server": server, "id": str(char)})

    def delete(self, body, token):
        server = self.server_of(body.get("server"))
        char = body.get("character_id")
        if type(char) is not int or char <= 0:
            raise ValueError("character_id 应为正整数")
        self.esi(server, f"/characters/{char}/skills/", token)   # 校验令牌属于这个角色
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM char_sale WHERE server=? AND char_id=?", (server, char))
            c.commit()
        return {"ok": True}

    def rows(self, server, char=None):
        cut = int(time.time()) - SALE_DAYS * 86400
        sql = "SELECT char_id, price, qq, data, created, updated FROM char_sale WHERE server=? AND updated>?"
        args = (server, cut) if char is None else (server, cut, char)
        for cid, price, qq, data, created, updated in self.store.conn().execute(sql + (" AND char_id=?" if char is not None else ""), args):
            d = json.loads(data)
            yield {"id": cid, "price": price, "qq": qq, "created": created, "updated": updated,
                   "expires": updated + SALE_DAYS * 86400, **d}

    # GET /bazaar/sale?server=：在售角色（不含技能明细）
    def items(self, q):
        server = self.server_of(q.get("server") or "infinity")
        return {"items": [{k: v for k, v in r.items() if k not in ("skills", "attrs", "implants")} | {"sp": r["total_sp"]}
                          for r in self.rows(server)], "days": SALE_DAYS}

    # GET /bazaar/sale/detail?server=&id=
    def detail(self, q):
        server = self.server_of(q.get("server") or "infinity")
        cid = int(q.get("id") or 0)
        for r in self.rows(server, cid):
            return r
        raise KeyError("挂单不存在或已过期")

    # GET /bazaar/sale/skillset?server=：各角色技能等级（列表按「能开什么船 / 技能几级」筛选）
    def skillset(self, q):
        server = self.server_of(q.get("server") or "infinity")
        return {"items": {r["id"]: [r["id"], r["name"], r["total_sp"], ",".join(f"{i}:{lv}" for i, lv, _ in r["skills"])] for r in self.rows(server)},
                "pending": 0}


# ---------------------------------------------------------------- 虫洞求救
# 被困在虫洞里的玩家发求救：用本站绑定的 ESI 令牌（需要位置权限）证明角色归属，所在星系由服务器从 ESI 读取（只能在虫洞里发，不能替别人或别的星系发）。
# 每个角色同时只有一条，重新提交即更新并续期；SOS_HOURS 小时后自动过期。令牌只用于本次请求，不落盘、不写日志
SOS_HOURS = 48
SOS_RATE = 20                   # 每个 IP 每分钟最多提交次数
SOS_WORDS_MAX = 200
SOS_CONTACT_MAX = 60
SOS_REWARD_MAX = 1_000_000_000_000
SOS_SCHEMA = """
CREATE TABLE IF NOT EXISTS wh_sos(server TEXT, char_id INTEGER, name TEXT, corp_id INTEGER, system_id INTEGER, words TEXT, reward INTEGER,
  contact TEXT, created INTEGER, updated INTEGER, PRIMARY KEY(server, char_id));
CREATE INDEX IF NOT EXISTS wh_sos_system ON wh_sos(server, system_id);
"""


class WhSos:
    def __init__(self, store, wallet):
        self.store, self.esi = store, wallet.esi
        c = store.conn()
        with store.write_lock:
            c.executescript(SOS_SCHEMA)
            c.commit()

    @staticmethod
    def server_of(v):
        if v not in ARB_SERVERS:
            raise ValueError("server 只能是 " + " / ".join(ARB_SERVERS))
        return v

    @staticmethod
    def char_of(body):
        char = body.get("character_id")
        if type(char) is not int or char <= 0:
            raise ValueError("character_id 应为正整数")
        return char

    @staticmethod
    def text(v, limit, label):
        if v is None:
            return ""
        if not isinstance(v, str):
            raise ValueError(label + "应为文字")
        v = re.sub(r"[\x00-\x09\x0b-\x1f\x7f]", " ", v).strip()
        if len(v) > limit:
            raise ValueError(f"{label}最多 {limit} 个字")
        return v

    def location(self, server, char, token):
        """用令牌读角色位置（ESI 返回 200 才认为令牌属于这个角色）"""
        loc, _ = self.esi(server, f"/characters/{char}/location/", token)
        return int((loc or {}).get("solar_system_id") or 0)

    def save(self, body, token):
        server, char = self.server_of(body.get("server")), self.char_of(body)
        words = self.text(body.get("words"), SOS_WORDS_MAX, "留言")
        contact = self.text(body.get("contact"), SOS_CONTACT_MAX, "联系方式")
        reward = body.get("reward") or 0
        if type(reward) is not int or not 0 <= reward <= SOS_REWARD_MAX:
            raise ValueError("悬赏应为 0 到 1 万亿之间的整数（ISK）")
        system = self.location(server, char, token)
        if not 31000000 <= system < 32000000:
            raise ValueError("你的角色现在不在虫洞里，只能在被困的虫洞星系里发求救")
        cfg = ARB_SERVERS[server]
        try:
            pub, _ = get_json(f"{cfg['esi']}/characters/{char}/?{cfg['qs']}", timeout=20, retries=2)
        except Exception:
            raise EsiUnavailable("角色公开信息读取失败") from None
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            row = c.execute("SELECT created FROM wh_sos WHERE server=? AND char_id=? AND system_id=? AND updated>?",
                            (server, char, system, now - SOS_HOURS * 3600)).fetchone()
            c.execute("INSERT OR REPLACE INTO wh_sos(server, char_id, name, corp_id, system_id, words, reward, contact, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (server, char, pub.get("name") or str(char), pub.get("corporation_id"), system, words, reward, contact, row[0] if row else now, now))
            c.commit()
        return {"ok": True, "system_id": system, "expires": now + SOS_HOURS * 3600}

    def delete(self, body, token):
        server, char = self.server_of(body.get("server")), self.char_of(body)
        self.location(server, char, token)   # 校验令牌属于这个角色
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM wh_sos WHERE server=? AND char_id=?", (server, char))
            c.commit()
        return {"ok": True}

    # GET /wh/sos?server=&system=：未过期的求救，新的在前
    def items(self, q):
        server = self.server_of(q.get("server") or "tq")
        sql = "SELECT char_id, name, corp_id, system_id, words, reward, contact, created, updated FROM wh_sos WHERE server=? AND updated>?"
        args = [server, int(time.time()) - SOS_HOURS * 3600]
        if q.get("system"):
            sql += " AND system_id=?"
            args.append(int(q["system"]))
        rows = self.store.conn().execute(sql + " ORDER BY updated DESC LIMIT 200", args).fetchall()
        keys = ("char_id", "name", "corp_id", "system_id", "words", "reward", "contact", "created", "updated")
        return {"items": [dict(zip(keys, r)) | {"expires": r[8] + SOS_HOURS * 3600} for r in rows], "hours": SOS_HOURS}


# ---------------------------------------------------------------- 广场
# 玩家用本站绑定的 ESI 角色发帖，分四类（令牌只用于本次请求，不落盘、不写日志）：
#   招新 recruit：军团招新广告。服务器读角色公开信息确认所在军团，同一军团只保留一条；发布人或 CEO 可以修改 / 撤下，
#     发布人已经离开军团时其他成员可以接手。
#   组队 fleet：服务器读角色当前所在舰队，必须是舰队老板（能读 /fleets/{id}/）；附上人数、常见舰船与所在星系，每个角色一条。
#   集市 market：挂自己发起的公开合同（ESI 个人合同里 可见范围=公开、待接受、发起人是本人 的），保存物品清单快照，合同到期时一起过期。
#   其他 other：自由发帖，每个角色同时最多 PLAZA_OTHER_MAX 条。
#   装配 fit：分享装配页的装配（data.fit 为装配页分享链接同样的紧凑格式，data.ship 为舰船），每个角色同时最多 PLAZA_FIT_MAX 条；
#     装配页可按舰船读取（GET /plaza?kind=fit&ship=）一键套用。
# 重新提交即更新并顶到最前、续期。站长（EVE_FEEDBACK_ADMIN_IPS）可以删除任意帖子。
PLAZA_TTL = {"recruit": 30 * 86400, "fleet": 12 * 3600, "market": 30 * 86400, "other": 7 * 86400, "fit": 180 * 86400}
PLAZA_TAGS = {
    "recruit": ["新人友好", "PVP", "PVE", "工业", "挖矿", "虫洞", "00 区", "低安", "高安", "势力战争", "亚洲时区", "欧美时区"],
    "fleet": ["PVE", "PVP", "挖矿", "虫洞", "深渊", "运输", "新人带飞", "势力战争", "游荡"],
    "market": [],
    "other": ["求助", "交流", "求购", "出售", "服务"],
    "fit": ["PVE", "PVP", "刷怪", "深渊", "虫洞", "挖矿", "运输", "探索", "舰队", "单刷", "新人", "低成本"],
}
PLAZA_RATE = 20                 # 每个 IP 每分钟最多提交次数（含撤下、读合同）
PLAZA_POSTS = (2, 60)           # 发新帖：每个 IP 每 60 秒最多 2 条（编辑已有帖子不算）
PLAZA_TITLE_MAX = 60
PLAZA_TEXT_MAX = 1000
PLAZA_CONTACT_MAX = 80
PLAZA_OTHER_MAX = 3
PLAZA_FIT_MAX = 20
PLAZA_MARKET_MAX = 30
PLAZA_ITEMS_MAX = 200
PLAZA_SCHEMA = """
CREATE TABLE IF NOT EXISTS plaza(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT, kind TEXT, key TEXT, char_id INTEGER, name TEXT,
  corp_id INTEGER, alliance_id INTEGER, title TEXT, text TEXT, contact TEXT, tags TEXT, data TEXT, created INTEGER, updated INTEGER, expires INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS plaza_key ON plaza(server, kind, key);
CREATE INDEX IF NOT EXISTS plaza_list ON plaza(server, expires);
"""
# 违禁词：标题、内容、联系方式里出现就拒绝发帖并说出是哪个词。内置一份常见的（政治、色情、赌博、毒品、诈骗与现金交易、辱骂），
# 站长可在数据库同目录的 plaza-banned.txt 里追加（每行一个，# 开头是注释；文件改了下次发帖时自动重新读取，不用重启）。
# 比对前统一成小写半角并去掉空白、标点、零宽字符，「赌 博」「赌.博」「ＶＸ」这类写法也能认出来
PLAZA_BANNED = (
    # 政治
    "法轮功", "法輪功", "法轮大法", "六四事件", "天安门事件", "台独", "藏独", "疆独", "港独", "反共", "共匪",
    # 色情
    "色情", "约炮", "裸聊", "援交", "嫖娼", "卖淫", "黄片", "成人视频", "porn",
    # 赌博
    "赌博", "博彩", "菠菜", "百家乐", "时时彩", "六合彩", "网赌", "赌场", "棋牌充值",
    # 毒品、枪支
    "冰毒", "海洛因", "大麻", "k粉", "摇头丸", "毒品", "出售枪支", "仿真枪",
    # 诈骗、现金交易（游戏规则禁止现实货币交易 ISK / 代练）
    "刷单", "洗钱", "套现", "代开发票", "办证", "人民币收isk", "人民币出isk", "rmb收isk", "rmb出isk", "人民币交易", "rmb交易", "现金交易", "支付宝转账",
    "代练", "代刷", "低价plex", "plex代充", "rmt",
    # 辱骂
    "傻逼", "傻b", "煞笔", "操你妈", "草泥马", "你妈死了", "nmsl", "狗日的", "去死吧", "fuck", "nigger", "faggot",
)


class BannedWords:
    def __init__(self, path):
        self.path = path
        self.mtime = None
        self.extra = ()
        self.lock = threading.Lock()

    @staticmethod
    def norm(s):
        return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).lower())

    def words(self):
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = None
        with self.lock:
            if mtime != self.mtime:
                self.mtime, self.extra = mtime, ()
                if mtime is not None:
                    try:
                        with open(self.path, encoding="utf-8") as f:
                            self.extra = tuple(w for w in (self.norm(x) for x in f if not x.lstrip().startswith("#")) if w)
                    except (OSError, UnicodeDecodeError) as e:
                        log.warning("读取 %s 失败：%s", self.path, e)
            return PLAZA_BANNED_N + self.extra

    def check(self, *texts):
        t = self.norm(" ".join(x for x in texts if x))
        for w in self.words():
            if w in t:
                raise ValueError(f"内容含有违禁词「{w}」，请修改后再发")


PLAZA_BANNED_N = tuple(BannedWords.norm(w) for w in PLAZA_BANNED)

PLAZA_COLS = ("id", "kind", "char_id", "name", "corp_id", "alliance_id", "title", "text", "contact", "tags", "data", "created", "updated", "expires")


class Plaza:
    def __init__(self, store, wallet):
        self.store, self.wallet, self.esi = store, wallet, wallet.esi
        self.banned = BannedWords(os.path.join(os.path.dirname(os.path.abspath(store.path)), "plaza-banned.txt"))
        c = store.conn()
        with store.write_lock:
            c.executescript(PLAZA_SCHEMA)
            c.commit()

    def pub(self, server, path):
        cfg = ARB_SERVERS[server]
        try:
            data, _ = get_json(f"{cfg['esi']}{path}?{cfg['qs']}", timeout=20, retries=2)
            return data or {}
        except Exception:
            raise EsiUnavailable("ESI 公开信息读取失败") from None

    def names(self, server, ids):
        ids = [i for i in dict.fromkeys(ids) if i]
        if not ids:
            return {}
        cfg = ARB_SERVERS[server]
        return {r["id"]: r["name"] for r in resolve_names(ids, url=f"{cfg['esi']}/universe/names/?{cfg['qs']}")}

    def owner(self, server, char, token):
        """令牌属于这个角色（ESI 返回 200）才继续；返回角色公开信息"""
        self.esi(server, f"/characters/{char}/location/", token)
        return self.pub(server, f"/characters/{char}/")

    @staticmethod
    def kind_of(v):
        if v not in PLAZA_TTL:
            raise ValueError("kind 只能是 " + " / ".join(PLAZA_TTL))
        return v

    @staticmethod
    def tags_of(kind, v):
        if v is None:
            return []
        if not isinstance(v, list) or len(v) > 6 or any(t not in PLAZA_TAGS[kind] for t in v):
            raise ValueError("标签不在可选范围内")
        return list(dict.fromkeys(v))

    @staticmethod
    def fit_of(v):
        """装配页分享链接的紧凑格式：{s: 舰船, n: 名称, m: {槽位: [[装备, 弹药, 状态, 突变?] | 0]}, d: [[无人机, 数量, 激活]], i: [植入体]}"""
        bad = ValueError("装配数据无效，请在装配页重新选择")
        isint = lambda x: type(x) is int and 0 <= x < 2**31
        if not isinstance(v, dict) or not isint(v.get("s")) or not v["s"]:
            raise bad
        if len(json.dumps(v, separators=(",", ":"))) > 12000:
            raise ValueError("装配数据太大")
        out = {"s": v["s"]}
        name = v.get("n")
        if name is not None:
            out["n"] = WhSos.text(name, 60, "装配名称")
        m = v.get("m") or {}
        if not isinstance(m, dict) or any(k not in ("high", "mid", "low", "rig", "sub") for k in m):
            raise bad
        for slot, mods in m.items():
            if not isinstance(mods, list) or len(mods) > 12:
                raise bad
            for x in mods:
                if x != 0 and not (isinstance(x, list) and 3 <= len(x) <= 4 and all(isint(y) for y in x[:3]) and x[2] <= 3):
                    raise bad
        out["m"] = m
        d = v.get("d")
        if d is not None:
            if not isinstance(d, list) or len(d) > 20 or any(not (isinstance(x, list) and len(x) == 3 and all(isint(y) for y in x)) for x in d):
                raise bad
            out["d"] = d
        i = v.get("i")
        if i is not None:
            if not isinstance(i, list) or len(i) > 12 or not all(isint(y) for y in i):
                raise bad
            out["i"] = i
        return out

    @staticmethod
    def body_text(v):
        return re.sub(r"\n{3,}", "\n\n", WhSos.text(v, PLAZA_TEXT_MAX, "内容"))

    def row(self, server, pid):
        r = self.store.conn().execute(f"SELECT {', '.join(PLAZA_COLS)}, key FROM plaza WHERE server=? AND id=?", (server, pid)).fetchone()
        if not r:
            raise ValueError("帖子不存在或已删除")
        return dict(zip(PLAZA_COLS + ("key",), r))

    @staticmethod
    def out(r):
        return {**{k: r[k] for k in PLAZA_COLS}, "tags": json.loads(r["tags"] or "[]"), "data": json.loads(r["data"] or "{}")}

    def fleet(self, server, char, token):
        try:
            f, _ = self.esi(server, f"/characters/{char}/fleet/", token)
        except PermissionError:
            raise PermissionError("令牌无效或缺少「舰队」权限，请重新绑定这个角色并勾选舰队权限") from None
        except EsiUnavailable as e:
            if "404" in str(e):
                raise ValueError("这个角色现在不在舰队里：先在游戏里建好舰队再来挂") from None
            raise
        fid = (f or {}).get("fleet_id")
        try:
            info, _ = self.esi(server, f"/fleets/{fid}/", token)
            members, _ = self.esi(server, f"/fleets/{fid}/members/", token)
        except (PermissionError, EsiUnavailable) as e:
            if isinstance(e, EsiUnavailable) and "404" not in str(e):
                raise
            raise ValueError("只有舰队老板（建舰队的人）才能挂组队；可以请老板来挂，或在游戏里把老板转给自己") from None
        ships = {}
        for m in members or []:
            ships[m.get("ship_type_id")] = ships.get(m.get("ship_type_id"), 0) + 1
        try:
            loc, _ = self.esi(server, f"/characters/{char}/location/", token)
        except (PermissionError, EsiUnavailable):
            loc = None
        system = (loc or {}).get("solar_system_id")
        return {"fleet_id": fid, "free_move": bool((info or {}).get("is_free_move")), "members": len(members or []),
                "ships": sorted(([t, n] for t, n in ships.items() if t), key=lambda x: -x[1])[:6],
                "system_id": system, "system": self.names(server, [system]).get(system) if system else None}

    def my_contracts(self, server, char, token):
        now = time.time()
        out = []
        for c in self.wallet.pages(server, f"/characters/{char}/contracts/", token):
            if c.get("issuer_id") != char or c.get("availability") != "public" or c.get("status") != "outstanding":
                continue
            exp = epoch(c["date_expired"]) if c.get("date_expired") else 0
            if exp and exp > now and c.get("type") in ("item_exchange", "auction", "courier"):
                out.append(c | {"_exp": exp})
        return out

    def market(self, server, char, token, cid):
        c = next((x for x in self.my_contracts(server, char, token) if x.get("contract_id") == cid), None)
        if not c:
            raise ValueError("没找到这份合同：只能挂自己发起的、可见范围为公开、还没被接的合同（ESI 合同列表约 5 分钟更新一次）")
        items, _ = self.esi(server, f"/characters/{char}/contracts/{cid}/items/", token)
        loc_id, loc, system = c.get("start_location_id"), None, None
        try:
            if loc_id and loc_id < 100_000_000:
                st = self.pub(server, f"/universe/stations/{loc_id}/")
                loc, system = st.get("name"), st.get("system_id")
            elif loc_id:
                st, _ = self.esi(server, f"/universe/structures/{loc_id}/", token)
                loc, system = (st or {}).get("name"), (st or {}).get("solar_system_id")
        except (PermissionError, EsiUnavailable):
            pass
        rows = [[i.get("type_id"), i.get("quantity") or 1, 1 if i.get("is_included") else 0, 1 if i.get("raw_quantity") == -2 else 0] for i in items or []]
        data = {"contract_id": cid, "type": c.get("type"), "ctitle": c.get("title") or "", "price": c.get("price") or 0,
                "reward": c.get("reward") or 0, "collateral": c.get("collateral") or 0, "buyout": c.get("buyout") or 0,
                "volume": c.get("volume") or 0, "for_corp": bool(c.get("for_corporation")), "location_id": loc_id, "location": loc,
                "system_id": system, "system": self.names(server, [system]).get(system) if system else None,
                "end_location_id": c.get("end_location_id"), "n_items": len(rows), "items": rows[:PLAZA_ITEMS_MAX]}
        return data, int(c["_exp"])

    # POST /plaza/contracts：自己可以挂的公开合同（带令牌）
    def contracts(self, body, token):
        server, char = WhSos.server_of(body.get("server")), WhSos.char_of(body)
        posted = {k for (k,) in self.store.conn().execute("SELECT key FROM plaza WHERE server=? AND kind='market' AND char_id=? AND expires>?",
                                                          (server, char, int(time.time())))}
        return {"items": [{k: c.get(k) for k in ("contract_id", "type", "title", "price", "reward", "collateral", "volume", "date_expired")}
                          | {"posted": str(c["contract_id"]) in posted} for c in self.my_contracts(server, char, token)]}

    # POST /plaza/save：发帖 / 更新（同一军团招新、同一角色组队、同一份合同只保留一条）
    def save(self, body, token):
        server, char = WhSos.server_of(body.get("server")), WhSos.char_of(body)
        kind = self.kind_of(body.get("kind"))
        title = WhSos.text(body.get("title"), PLAZA_TITLE_MAX, "标题")
        text = self.body_text(body.get("text"))
        contact = WhSos.text(body.get("contact"), PLAZA_CONTACT_MAX, "联系方式")
        tags = self.tags_of(kind, body.get("tags"))
        self.banned.check(title, text, contact)
        now = int(time.time())
        expires = now + PLAZA_TTL[kind]
        pid = body.get("id")
        if pid is not None and (type(pid) is not int or pid <= 0):
            raise ValueError("id 应为正整数")
        c = self.store.conn()
        if kind == "fleet":
            data = self.fleet(server, char, token)
            pubinfo = self.pub(server, f"/characters/{char}/")
            key = str(char)
        elif kind == "market":
            cid = body.get("contract_id")
            if type(cid) is not int or cid <= 0:
                raise ValueError("请选择要挂的合同")
            data, expires = self.market(server, char, token, cid)
            pubinfo = self.pub(server, f"/characters/{char}/")
            key = str(cid)
            n = c.execute("SELECT COUNT(*) FROM plaza WHERE server=? AND kind='market' AND char_id=? AND expires>? AND key<>?", (server, char, now, key)).fetchone()[0]
            if n >= PLAZA_MARKET_MAX:
                raise ValueError(f"每个角色同时最多挂 {PLAZA_MARKET_MAX} 份合同")
        else:
            pubinfo = self.owner(server, char, token)
            if not text and not title:
                raise ValueError("请填写标题或内容")
        if kind == "recruit":
            corp = pubinfo.get("corporation_id") or 0
            if corp < 2_000_000:
                raise ValueError("这个角色在 NPC 军团里，不能发招新广告")
            ci = self.pub(server, f"/corporations/{corp}/")
            key = str(corp)
            old = c.execute("SELECT char_id, name FROM plaza WHERE server=? AND kind='recruit' AND key=? AND expires>?", (server, key, now)).fetchone()
            if old and old[0] != char and char != ci.get("ceo_id"):
                if self.pub(server, f"/characters/{old[0]}/").get("corporation_id") == corp:
                    raise ValueError(f"本军团的招新广告由 {old[1]} 发布，只有发布人或军团 CEO 可以修改")
            names = self.names(server, [ci.get("alliance_id")])
            data = {"corp_name": ci.get("name"), "ticker": ci.get("ticker"), "members": ci.get("member_count"), "ceo_id": ci.get("ceo_id"),
                    "alliance_id": ci.get("alliance_id"), "alliance_name": names.get(ci.get("alliance_id")), "tax": ci.get("tax_rate"),
                    "founded": ci.get("date_founded"), "url": (ci.get("url") or "")[:200]}
        elif kind in ("other", "fit"):
            data = {}
            if kind == "fit":
                fit = self.fit_of(body.get("fit"))
                data = {"ship": fit["s"], "fit": fit}
                if not title:
                    raise ValueError("请填写标题")
            if pid:
                r = self.row(server, pid)
                if r["kind"] != kind or r["char_id"] != char:
                    raise ValueError("只能修改自己发的帖子")
                key = r["key"]
            else:
                cap = PLAZA_FIT_MAX if kind == "fit" else PLAZA_OTHER_MAX
                n = c.execute("SELECT COUNT(*) FROM plaza WHERE server=? AND kind=? AND char_id=? AND expires>?", (server, kind, char, now)).fetchone()[0]
                if n >= cap:
                    raise ValueError(f"每个角色同时最多 {cap} 条，可以先撤下旧的")
                key = f"{char}:{now}:{secrets.token_hex(3)}"
        corp, alli = pubinfo.get("corporation_id"), pubinfo.get("alliance_id")
        nm = self.names(server, [corp, alli])
        data |= {"author_corp": nm.get(corp), "author_alliance": nm.get(alli)}
        vals = (char, pubinfo.get("name") or str(char), corp, alli, title, text, contact,
                json.dumps(tags, ensure_ascii=False), json.dumps(data, ensure_ascii=False, separators=(",", ":")), now, expires)
        with self.store.write_lock:
            c.execute("DELETE FROM plaza WHERE expires<?", (now - 7 * 86400,))
            old = c.execute("SELECT id FROM plaza WHERE server=? AND kind=? AND key=?", (server, kind, key)).fetchone()
            if old:
                c.execute("UPDATE plaza SET char_id=?, name=?, corp_id=?, alliance_id=?, title=?, text=?, contact=?, tags=?, data=?, updated=?, expires=? WHERE id=?",
                          vals + (old[0],))
                pid = old[0]
            else:
                pid = c.execute("INSERT INTO plaza(server, kind, key, char_id, name, corp_id, alliance_id, title, text, contact, tags, data, updated, expires, created) "
                                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (server, kind, key) + vals + (now,)).lastrowid
            c.commit()
        return self.out(self.row(server, pid))

    # POST /plaza/delete：发布人撤下（招新广告军团 CEO 也可以）
    def delete(self, body, token):
        server, char = WhSos.server_of(body.get("server")), WhSos.char_of(body)
        pid = body.get("id")
        if type(pid) is not int:
            raise ValueError("id 应为整数")
        r = self.row(server, pid)
        self.owner(server, char, token)
        if r["char_id"] != char and not (r["kind"] == "recruit" and self.pub(server, f"/corporations/{r['corp_id']}/").get("ceo_id") == char):
            raise ValueError("只能撤下自己发的帖子")
        return self.remove(server, pid)

    def remove(self, server, pid):
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM plaza WHERE server=? AND id=?", (server, pid))
            c.commit()
        return {"ok": True}

    # GET /plaza?server=&kind=&corp=&char=&id=：未过期的帖子，最近更新的在前
    def items(self, q):
        server = WhSos.server_of(q.get("server") or "tq")
        sql, args = f"SELECT {', '.join(PLAZA_COLS)} FROM plaza WHERE server=? AND expires>?", [server, int(time.time())]
        if q.get("kind"):
            sql += " AND kind=?"
            args.append(self.kind_of(q["kind"]))
        for k, col in (("corp", "corp_id"), ("char", "char_id"), ("id", "id"), ("ship", "json_extract(data, '$.ship')")):
            if q.get(k):
                sql += f" AND {col}=?"
                args.append(int(q[k]))
        rows = self.store.conn().execute(sql + " ORDER BY updated DESC LIMIT 500", args).fetchall()
        return {"items": [self.out(dict(zip(PLAZA_COLS, r))) for r in rows], "tags": PLAZA_TAGS,
                "ttl": PLAZA_TTL, "other_max": PLAZA_OTHER_MAX, "fit_max": PLAZA_FIT_MAX}


# ---------------------------------------------------------------- 预警推送（企业微信群机器人、电子邮件、Server酱等）
# 浏览器里的击杀预警 / 本地日志命中后，把要推送的内容交给本服务转发：
#   企业微信：浏览器不能跨域调群机器人接口，由这里转发到 qyapi.weixin.qq.com（只接受机器人 key，不接受任意地址）
#   Server酱、PushPlus、钉钉、飞书、Bark（PUSH_TOKEN）：同样只接受各自的 key / token，发到固定的官方地址
#   邮件：浏览器不能直连 SMTP。用户在网页上填自己的发件邮箱、授权码（只存在用户浏览器里），每次发信连同内容一起带过来，
#     这里登录用户的邮件服务器发给用户指定的一个收件地址；账号、授权码用完即丢，不保存、不写日志。
#     只连公网地址的常用邮件端口（不能拿来探测内网），只发一个收件人，必须加密连接。
# 内容只收标题和若干行文字（可带 http(s) 链接），排版在这里做，文字全部转义。
PUSH_RATE = 30                  # 每个 IP 每分钟最多请求次数（全部推送接口合计）
PUSH_WECOM_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PUSH_MAIL_RE = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}")
PUSH_HOST_RE = re.compile(r"(?=.{1,253}$)[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+")
PUSH_PORTS = (465, 587, 25, 2525)
PUSH_LINES = 30                 # 一条推送最多几行
PUSH_LINE_MAX = 300             # 每行最多几个字
PUSH_WECOM_GAP = 3              # 同一个机器人两条至少隔几秒（企业微信限每分钟 20 条）
PUSH_MAIL_GAP = 20              # 同一个发件账号两封至少隔几秒（浏览器按 60 秒合并，测试邮件不等）
PUSH_MAIL_IP_DAY = 300          # 同一个 IP 每天最多发几封
# 只填 key 的渠道：名称、key 格式、加签密钥格式（None = 没有加签）；两条至少隔几秒
PUSH_TOKEN = {
    "sct": ("Server酱", re.compile(r"SCT[0-9A-Za-z]{10,60}|sctp\d{1,12}t[0-9A-Za-z]{10,60}"), None),
    "pushplus": ("PushPlus", re.compile(r"[0-9a-f]{32}"), None),
    "dingtalk": ("钉钉", re.compile(r"[0-9a-f]{64}"), re.compile(r"SEC[0-9a-f]{64}")),
    "feishu": ("飞书", re.compile(r"(?:lark:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"), re.compile(r"[0-9A-Za-z]{10,64}")),
    "bark": ("Bark", re.compile(r"[0-9A-Za-z]{16,40}"), None),
}
PUSH_TOKEN_GAP = 3
PUSH_TEST_PRIVATE = os.environ.get("EVE_PUSH_TEST_SMTP") == "1"   # 仅本机测试：允许连内网 / 不加密的邮件服务器


class _PinnedSMTP:
    # 连到事先检查过的 IP（防止检查后域名解析变成内网地址），证书校验仍按原域名
    pin = None

    def _get_socket(self, host, port, timeout):
        return super()._get_socket(self.pin, port, timeout)


class _PinnedSMTPSSL(_PinnedSMTP, smtplib.SMTP_SSL):
    pass


class _PinnedSMTPPlain(_PinnedSMTP, smtplib.SMTP):
    pass


class AlertPush:
    def __init__(self):
        self.lock = threading.Lock()
        self.last = {}     # 机器人 key / 发件账号 -> 上次发送时间
        self.daily = {}    # (ip:IP, 日期, 种类) -> 次数

    # ---------- 公共 ----------
    @staticmethod
    def content(body):
        title = str(body.get("title") or "").strip()[:100]
        lines = body.get("lines")
        if not title or not isinstance(lines, list) or not lines:
            raise ValueError("缺少标题或内容")
        out = []
        for x in lines[:PUSH_LINES]:
            x = x if isinstance(x, dict) else {"text": x}
            text = str(x.get("text") or "").strip()[:PUSH_LINE_MAX]
            url = str(x.get("url") or "")
            if text:
                out.append((text, url if re.fullmatch(r"https?://[^\s<>\"']{1,500}", url) else ""))
        if not out:
            raise ValueError("缺少内容")
        return title, out, max(0, len(lines) - PUSH_LINES)

    def gap(self, key, seconds):
        now = time.time()
        with self.lock:
            wait = self.last.get(key, 0) + seconds - now
            if wait > 0:
                raise ValueError(f"发送太频繁，请 {int(wait) + 1} 秒后再试")
            self.last[key] = now
            if len(self.last) > 20000:
                self.last = {k: t for k, t in self.last.items() if now - t < 600}

    def count(self, key, kind, limit, msg):
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self.lock:
            n = self.daily.get((key, day, kind), 0)
            if n >= limit:
                raise ValueError(msg)
            if len(self.daily) > 50000:
                self.daily = {k: v for k, v in self.daily.items() if k[1] == day}
            self.daily[(key, day, kind)] = n + 1

    # ---------- 企业微信 ----------
    def wecom(self, body, ip=None):
        key = str(body.get("key") or "").strip().lower()
        if not PUSH_WECOM_RE.fullmatch(key):
            raise ValueError("机器人地址不对：应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…")
        title, lines, more = self.content(body)
        self.gap("wecom:" + key, PUSH_WECOM_GAP)
        md = [f"**{self.md(title)}**"] + [f"> [{self.md(t)}]({u})" if u else f"> {self.md(t)}" for t, u in lines]
        if more:
            md.append(f"> ……另有 {more} 条")
        text = "\n".join(md)
        while len(text.encode()) > 4000:   # 企业微信 markdown 最长 4096 字节
            md.pop(-1)
            text = "\n".join(md + ["> ……"])
        req = urllib.request.Request("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + key,
                                     data=json.dumps({"msgtype": "markdown", "markdown": {"content": text}}, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                res = json.load(r)
        except Exception as e:  # noqa: BLE001
            raise EsiUnavailable(f"连不上企业微信：{e}") from e
        code = res.get("errcode")
        if code:
            raise ValueError({93000: "机器人地址无效或已被移出群聊", 45009: "企业微信限流：同一个机器人每分钟最多 20 条",
                              40058: "内容格式不对"}.get(code, f"企业微信返回错误 {code}：{res.get('errmsg', '')}"))
        return {"ok": True}

    @staticmethod
    def md(s):
        # 企业微信 markdown 不认转义：会打乱格式的符号换成全角
        return s.translate(str.maketrans("[]<>*`", "［］＜＞＊｀"))

    # ---------- Server酱 / PushPlus / 钉钉 / 飞书 / Bark ----------
    def token(self, ch, body, ip=None):
        name, key_re, secret_re = PUSH_TOKEN[ch]
        key = str(body.get("key") or "").strip()
        if ch in ("pushplus", "dingtalk", "feishu"):
            key = key.lower()
        if not key_re.fullmatch(key):
            raise ValueError(f"{name} 的 key 不对")
        secret = str(body.get("secret") or "").strip()
        if secret and not (secret_re and secret_re.fullmatch(secret)):
            raise ValueError(f"{name} 的加签密钥不对")
        title, lines, more = self.content(body)
        self.gap(f"{ch}:{key}", PUSH_TOKEN_GAP)
        en = body.get("lang") == "en"
        more_text = (f"… and {more} more" if en else f"……另有 {more} 条") if more else ""
        md = [f"- [{self.md(t)}]({u})" if u else f"- {self.md(t)}" for t, u in lines] + ([more_text] if more else [])
        sign = None
        if ch == "sct":
            m = re.fullmatch(r"sctp(\d+)t.+", key)
            url = f"https://{m.group(1)}.push.ft07.com/send/{key}.send" if m else f"https://sctapi.ftqq.com/{key}.send"
            data = {"title": title, "desp": "\n".join(md)}
        elif ch == "pushplus":
            url, data = "https://www.pushplus.plus/send", {"token": key, "title": title, "content": "\n".join(md), "template": "markdown"}
        elif ch == "dingtalk":
            url = "https://oapi.dingtalk.com/robot/send?access_token=" + key
            if secret:
                ts = str(int(time.time() * 1000))
                sign = base64.b64encode(hmac.new(secret.encode(), f"{ts}\n{secret}".encode(), hashlib.sha256).digest()).decode()
                url += f"&timestamp={ts}&sign={urllib.parse.quote(sign)}"
            # 机器人「自定义关键词」安全设置：内容里带上 EVE
            data = {"msgtype": "markdown", "markdown": {"title": title, "text": f"#### {self.md(title)}\n\n" + "\n".join(md) + "\n\n— EVE Market"}}
        elif ch == "feishu":
            base = "https://open.larksuite.com" if key.startswith("lark:") else "https://open.feishu.cn"
            url = f"{base}/open-apis/bot/v2/hook/{key.removeprefix('lark:')}"
            rows = [[{"tag": "a", "text": t, "href": u}] if u else [{"tag": "text", "text": t}] for t, u in lines]
            rows += ([[{"tag": "text", "text": more_text}]] if more else []) + [[{"tag": "text", "text": "— EVE Market"}]]
            data = {"msg_type": "post", "content": {"post": {"en_us" if en else "zh_cn": {"title": title, "content": rows}}}}
            if secret:
                ts = str(int(time.time()))
                data.update(timestamp=ts, sign=base64.b64encode(hmac.new(f"{ts}\n{secret}".encode(), b"", hashlib.sha256).digest()).decode())
        else:
            # Bark 是系统通知，只放纯文字；点通知打开第一条的链接
            url = "https://api.day.app/push"
            data = {"device_key": key, "title": title, "body": "\n".join([t for t, _ in lines] + ([more_text] if more else [])), "group": "EVE Market"}
            link = next((u for _, u in lines if u), "")
            if link:
                data["url"] = link
        req = urllib.request.Request(url, data=json.dumps(data, ensure_ascii=False).encode(), headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                res = json.load(r)
        except urllib.error.HTTPError as e:
            try:
                res = json.load(e)
            except Exception:  # noqa: BLE001
                raise EsiUnavailable(f"{name} 返回 HTTP {e.code}") from e
        except Exception as e:  # noqa: BLE001
            raise EsiUnavailable(f"连不上{name}：{e}") from e
        if not isinstance(res, dict):
            raise EsiUnavailable(f"{name} 返回的内容不对")
        code = res.get("errcode", res.get("code", res.get("StatusCode", 0)))
        ok_code = 200 if ch in ("pushplus", "bark") else 0
        if code != ok_code:
            msg = str(res.get("errmsg") or res.get("msg") or res.get("message") or res.get("StatusMessage") or "")[:160]
            if ch == "dingtalk" and code == 310000:
                msg = "安全设置不通过：加签密钥不对，或者关键词没有设成 EVE（" + msg + "）"
            elif ch == "feishu" and code == 19021:
                msg = "签名校验失败：加签密钥不对"
            raise ValueError(f"{name}返回错误 {code}：{msg}")
        return {"ok": True}

    # ---------- 邮件（用户自己的发件邮箱）----------
    @staticmethod
    def resolve(host, port):
        # 只连公网地址：返回第一个可用的公网 IP
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as e:
            raise ValueError(f"找不到邮件服务器 {host}") from e
        ips = [i[4][0] for i in infos]
        if not PUSH_TEST_PRIVATE and any(not ipaddress.ip_address(ip.split("%")[0]).is_global for ip in ips):
            raise ValueError("邮件服务器地址不对")
        return ips[0]

    def mail(self, body, ip=None):
        smtp = body.get("smtp") if isinstance(body.get("smtp"), dict) else {}
        user = str(smtp.get("user") or "").strip()
        password = str(smtp.get("password") or "")
        host = str(smtp.get("host") or "").strip().lower().rstrip(".")
        sec = smtp.get("security") or "ssl"
        try:
            port = int(smtp.get("port") or (465 if sec == "ssl" else 587))
        except (TypeError, ValueError):
            port = 0
        to = str(body.get("to") or user).strip()
        if len(user) > 120 or not PUSH_MAIL_RE.fullmatch(user):
            raise ValueError("发件邮箱不对")
        if len(to) > 120 or not PUSH_MAIL_RE.fullmatch(to):
            raise ValueError("收件邮箱不对")
        if not password or len(password) > 200:
            raise ValueError("请填写授权码")
        if not PUSH_HOST_RE.fullmatch(host) or port not in PUSH_PORTS:
            raise ValueError("邮件服务器或端口不对")
        if sec not in ("ssl", "starttls") and not (PUSH_TEST_PRIVATE and sec == "none"):
            raise ValueError("只支持 SSL / STARTTLS 加密连接")
        title, lines, more = self.content(body)
        self.gap("mail:" + user.lower(), 0 if body.get("test") else PUSH_MAIL_GAP)
        self.count("ip:" + (ip or ""), "mail", PUSH_MAIL_IP_DAY, "今天发的预警邮件太多了，明天再试")
        en = body.get("lang") == "en"
        esc = html_lib.escape
        rows = "".join(f'<li style="margin:6px 0">{f"<a href={chr(34)}{esc(u)}{chr(34)}>{esc(t)}</a>" if u else esc(t)}</li>' for t, u in lines)
        html = (f'<p style="font-size:15px;font-weight:600">{esc(title)}</p><ul style="padding-left:18px;font-size:14px">{rows}</ul>'
                + ((f"<p>… and {more} more</p>" if en else f"<p>……另有 {more} 条</p>") if more else "")
                + ('<p style="color:#888;font-size:12px">From EVE Market alerts. Turn them off under the bell (top right) → Notifications.</p>' if en else
                   '<p style="color:#888;font-size:12px">来自 EVE Market 预警，可在网站右上角铃铛的「消息推送」里关闭。</p>'))
        msg = email.message.EmailMessage()
        msg["Subject"] = title
        msg["From"] = email.utils.formataddr(("EVE Market", user))
        msg["To"] = to
        msg["Date"] = email.utils.formatdate(localtime=True)
        msg["Message-ID"] = email.utils.make_msgid(domain=user.rsplit("@", 1)[-1])
        msg.set_content(html_lib.unescape(re.sub(r"<[^>]+>", "", html.replace("</li>", "\n").replace("</p>", "\n\n"))))
        msg.add_alternative(f'<div style="font-family:sans-serif;color:#222">{html}</div>', subtype="html")
        pin = self.resolve(host, port)
        stage = "connect"
        try:
            s = _PinnedSMTPSSL(timeout=20, context=ssl.create_default_context()) if sec == "ssl" else _PinnedSMTPPlain(timeout=20)
            s.pin = pin
            s._host = host   # 没在构造时连接，证书校验（SSL / STARTTLS）要用的域名得自己设
            with s:
                s.connect(host, port)
                if sec == "starttls":
                    s.starttls(context=ssl.create_default_context())
                stage = "login"
                if sec != "none":   # 不加密只在本机测试时允许，测试用的收信程序不要求登录
                    s.login(user, password)
                stage = "send"
                s.send_message(msg, from_addr=user, to_addrs=[to])
        except (smtplib.SMTPAuthenticationError, smtplib.SMTPServerDisconnected) as e:
            if stage == "connect" or (stage == "send" and isinstance(e, smtplib.SMTPServerDisconnected)):
                raise EsiUnavailable(f"连不上邮件服务器 {host}:{port}") from e
            # QQ 邮箱授权码不对时直接断开连接，不回登录失败
            raise ValueError("登录失败：发件邮箱或授权码不对（QQ / 163 等要用授权码，并在邮箱设置里开启 SMTP）") from e
        except smtplib.SMTPRecipientsRefused as e:
            raise ValueError("邮件服务器拒收这个收件地址") from e
        except smtplib.SMTPSenderRefused as e:
            raise ValueError(f"邮件服务器拒绝发信：{e.smtp_code} {e.smtp_error.decode(errors='replace')[:120]}") from e
        except smtplib.SMTPDataError as e:
            raise ValueError(f"邮件服务器拒收：{e.smtp_code} {e.smtp_error.decode(errors='replace')[:120]}") from e
        except ssl.SSLError as e:
            raise ValueError("加密连接失败，检查端口和加密方式（465 用 SSL，587 用 STARTTLS）") from e
        except (OSError, smtplib.SMTPException) as e:
            raise EsiUnavailable(f"连不上邮件服务器 {host}:{port}") from e
        return {"ok": True}


# ---------------------------------------------------------------- 服务器托管预警
# 网页关掉也要提醒时，用户可以把部分预警交给本服务在后台检查，命中后推送到企业微信 / 邮箱（AlertPush）。默认不开，用户在
# 「预警 → 微信 / 邮箱」里勾选要托管的预警、确认风险后单独授权一次（专用的 ESI 授权，和浏览器里绑定的令牌互不影响）。
#   击杀预警：人物关注、星域监控只用公开的实时击杀；按位置预警要读角色位置（esi-location.read_location.v1），
#     「角色离线时不提醒」读在线状态（esi-location.read_online.v1）。跳数按 map-data.json 的星门算。
#   虫洞求救：本服务自己的求救表，有新求救就推。
#   订单被压价：每 5 分钟读角色订单（esi-markets.read_character_orders.v1），同改单小助手的比价规则；玩家建筑里的订单要建筑市场权限。
#   会战：每分钟看一次疑似会战（/battles 同口径），到了用户设的提醒规模就推；同一星系 6 小时内只推一次（同 js/battles.js）。
#   到价提醒：自选看板里监控中的提醒（物品、交易中心、卖价 / 收价 ≤ / ≥ 某价），每 5 分钟用公开的星域订单检查（同 js/watch-board.js），
#     触发过的记下来不再推（网页上重新启用会换一个 key）。
#   角色提醒（同 js/char-alerts.js）：技能队列（练完、剩不到 24 小时、空了）、工业任务完成、行星开采器停了、订单全部成交 / 过期、
#     合同（我发的被接 / 完成 / 失败 / 被拒，拍卖有新出价，收到指定给我的合同）。都是和上次读到的比，刚开启时只记下现状、不推。
# 保存的东西：刷新令牌、企业微信机器人 key、邮箱账号和授权码、预警设置。整份加密后存进 hosted 表（密钥在数据库旁的 .hostkey 文件，
#   或环境变量 EVE_HOSTED_KEY），数据库单独泄露时读不出来；服务器本身被攻破时仍可能泄露，所以要用户确认风险。
#   刷新令牌每次使用都会更换，新的立刻写回。授权失效（用户在 CCP 撤销 / 改密码）时停掉要令牌的部分，网页上提示重新授权。
# 管理：开启时返回一个凭证（只存在用户浏览器里，服务器存它的哈希），凭证 + 角色 ID 才能查看状态、改设置、停止托管；
#   停止托管立即删除整行。凭证丢了（换浏览器 / 清缓存）可以重新授权开启，会覆盖原来的托管。
# POST /api/kb/hosted/start   {server, client_id, refresh_token, settings} → {secret, character_id, name, scopes}
# POST /api/kb/hosted/update  {server, character_id, secret, settings}
# POST /api/kb/hosted/status  {server, character_id, secret} → 各项状态、最近推送
# POST /api/kb/hosted/stop    {server, character_id, secret}
HOSTED_RATE = 20                # 每个 IP 每分钟最多请求次数
HOSTED_MAX = 2000               # 全站最多托管多少个角色
HOSTED_BODY_MAX = 65536
HOSTED_TICK = 3                 # 后台循环间隔（秒）
HOSTED_LOC_GAP = 60             # 读角色位置的间隔
HOSTED_ONLINE_GAP = 120         # 读在线状态的间隔
HOSTED_SOS_GAP = 60
HOSTED_ORDER_GAP = 300          # 订单比价间隔（市场订单 ESI 缓存 5 分钟）
HOSTED_ORDER_MAX = 120          # 一个角色最多比价多少张订单
HOSTED_SENT_KEEP = 20           # 状态里保留最近几条推送
HOSTED_PUSH_GAP = {"wecom": 5, "mail": 60, "sct": 60, "pushplus": 30, "dingtalk": 5, "feishu": 5, "bark": 5}
HOSTED_SRCS = ("kill", "sos", "order", "battle", "price", "skill", "job", "pi", "sold", "contract")
HOSTED_LABELS = {"kill": ("击杀预警", "Kill alert"), "sos": ("虫洞求救", "Wormhole SOS"), "order": ("订单被压价", "Order undercut"), "battle": ("会战", "Battle"),
                 "price": ("到价提醒", "Price alert"), "skill": ("技能队列", "Skill queue"), "job": ("工业任务", "Industry job"), "pi": ("行星开采", "PI extractor"),
                 "sold": ("订单成交", "Order filled"), "contract": ("合同", "Contract")}
HOSTED_PRICE_GAP = 300          # 到价提醒检查间隔（星域订单 ESI 缓存 5 分钟）
HOSTED_PRICE_MAX = 200          # 最多托管多少条到价提醒
# 角色提醒的检查间隔（秒，不短于 ESI 缓存：技能队列 2 分钟、工业 5 分钟、行星 10 分钟、订单 20 分钟、合同 5 分钟）
HOSTED_CHAR_GAP = {"skill": 600, "job": 300, "pi": 1800, "sold": 1200, "contract": 300}
HOSTED_SKILL_LOW = 24 * 3600    # 技能队列剩不到这么久就提醒
HOSTED_PI_MAX = 12              # 最多读几颗行星
HOSTED_BIDS_MAX = 5             # 最多查几个拍卖的出价
HOSTED_GONE_KEEP = 3 * 3600     # 订单不见了但历史里还没有（历史接口缓存 1 小时）：最多等这么久
HOSTED_ACT = {1: ("制造", "Manufacturing"), 3: ("时间效率研究", "TE research"), 4: ("材料效率研究", "ME research"), 5: ("复制", "Copying"),
              7: ("逆向工程", "Reverse engineering"), 8: ("发明", "Invention"), 9: ("反应", "Reaction"), 11: ("反应", "Reaction")}
HOSTED_CT = {"item_exchange": ("物品交换", "Item exchange"), "auction": ("拍卖", "Auction"), "courier": ("快递", "Courier"), "loan": ("借贷", "Loan")}
HOSTED_BATTLE_GAP = 60
HOSTED_BATTLE_WINDOW = 60
HOSTED_BATTLE_TTL = 6 * 3600
HOSTED_TIERS = (("large", 100, "大型会战", "Large battle"), ("medium", 50, "中型会战", "Medium battle"), ("small", BATTLE_MIN_KILLS, "小型会战", "Small battle"))
HOSTED_TOKEN_URLS = {"tq": "https://login.eveonline.com/v2/oauth/token",
                     "serenity": "https://login.evepc.163.com/v2/oauth/token",
                     "infinity": "https://login-infinity.evepc.163.com/v2/oauth/token"}
HOSTED_SCOPES = {"loc": "esi-location.read_location.v1", "online": "esi-location.read_online.v1",
                 "orders": "esi-markets.read_character_orders.v1", "struct": "esi-markets.structure_markets.v1",
                 "skill": "esi-skills.read_skillqueue.v1", "job": "esi-industry.read_character_jobs.v1", "pi": "esi-planets.manage_planets.v1",
                 "contract": "esi-contracts.read_character_contracts.v1", "names": "esi-universe.read_structures.v1"}
HOSTED_SCHEMA = """
CREATE TABLE IF NOT EXISTS hosted(server TEXT, char_id INTEGER, name TEXT, secret TEXT, blob TEXT, state TEXT,
  created INTEGER, updated INTEGER, PRIMARY KEY(server, char_id));
"""
HOSTED_URL_RE = re.compile(r"https://[^\s<>\"'{}]{1,300}")
HOSTED_PODS = (670, 33328)


def _isk(v):
    v = float(v or 0)
    for n, s in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(v) >= n:
            return f"{v / n:.2f}{s}"
    return f"{v:,.2f}".rstrip("0").rstrip(".")


def _price(v):
    return f"{float(v):,.2f}"


def _ts(v):
    """ESI 时间（2026-01-01T00:00:00Z）→ 秒；没有或格式不对返回 0"""
    try:
        return calendar.timegm(time.strptime(str(v)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, TypeError):
        return 0


class Hosted:
    def __init__(self, store, apis, industry, push, key_path):
        self.store, self.apis, self.industry, self.push = store, apis, industry, push
        self.key = self.load_key(key_path)
        c = store.conn()
        with store.write_lock:
            c.executescript(HOSTED_SCHEMA)
            c.commit()
        self.lock = threading.Lock()
        self.subs = {}            # (server, 角色) -> 运行中的托管（解密后的设置 + 运行状态）
        self.cursor = {}          # server -> 已处理到的实时击杀编号
        self.sos_seen = {}        # server -> 已处理到的求救更新时间
        self.sos_at = 0
        self.battle_at = 0
        self.graphs = {}          # server -> 星门图：(星系 ID -> 下标, 邻接表, 星系表)；曙光服用自己的 map-data-infinity.json
        self.names = None         # 物品 ID -> 中文名（load_names 读入）
        self.cn_names = {}        # 国服 -> { 宁静中文: 国服中文 }
        self.pool = concurrent.futures.ThreadPoolExecutor(4, thread_name_prefix="hosted")
        self.market = {}          # (server, 星域, 物品, buy|sell) -> (时间, 订单)；多个角色共用
        self.structs = {}         # (server, 建筑) -> (时间, 订单)
        self.station_region = {}  # (server, 空间站) -> (星系, 星域)
        self.loc_names = {}       # (server, 地点, en) -> 名称（空间站、建筑）
        self.planet_names = {}    # (server, 行星) -> 名称
        for server, char, name, blob, state in c.execute("SELECT server, char_id, name, blob, state FROM hosted"):
            try:
                self.subs[(server, char)] = self.runtime(server, char, name, self.open(blob), json.loads(state or "{}"))
            except Exception:  # noqa: BLE001
                log.warning("托管预警 %s:%s 读取失败，跳过", server, char)

    # ---------- 加密（HMAC-SHA256 计数器模式 + 校验）----------
    @staticmethod
    def load_key(path):
        env = os.environ.get("EVE_HOSTED_KEY")
        if env:
            return hashlib.sha256(env.encode()).digest()
        if os.path.exists(path):
            with open(path, "rb") as fh:
                return fh.read()
        key = secrets.token_bytes(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
        return key

    def stream(self, nonce, n):
        out = bytearray()
        i = 0
        while len(out) < n:
            out += hmac.new(self.key, b"enc" + nonce + i.to_bytes(8, "big"), hashlib.sha256).digest()
            i += 1
        return bytes(out[:n])

    def seal(self, obj):
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        nonce = secrets.token_bytes(16)
        ct = bytes(a ^ b for a, b in zip(raw, self.stream(nonce, len(raw))))
        tag = hmac.new(self.key, b"tag" + nonce + ct, hashlib.sha256).digest()[:16]
        return base64.b64encode(nonce + tag + ct).decode()

    def open(self, blob):
        data = base64.b64decode(blob)
        nonce, tag, ct = data[:16], data[16:32], data[32:]
        if not hmac.compare_digest(tag, hmac.new(self.key, b"tag" + nonce + ct, hashlib.sha256).digest()[:16]):
            raise ValueError("托管数据校验失败")
        return json.loads(bytes(a ^ b for a, b in zip(ct, self.stream(nonce, len(ct)))))

    # ---------- 设置 ----------
    @staticmethod
    def ids(v, limit, label):
        if not isinstance(v, list) or len(v) > limit or any(type(x) is not int or x <= 0 for x in v):
            raise ValueError(label + "格式不对")
        return v

    def clean(self, s):
        """校验浏览器传来的设置，只留下认识的字段"""
        try:
            return self._clean(s)
        except (TypeError, AttributeError, KeyError):
            raise ValueError("设置格式不对") from None

    def _clean(self, s):
        if not isinstance(s, dict):
            raise ValueError("缺少设置")
        src = [x for x in HOSTED_SRCS if x in (s.get("src") or [])]
        if not src:
            raise ValueError("至少选一种要托管的预警")
        ch = {}
        w = s.get("wecom") if isinstance(s.get("wecom"), dict) else None
        if w and w.get("key"):
            key = str(w["key"]).strip().lower()
            if not PUSH_WECOM_RE.fullmatch(key):
                raise ValueError("企业微信机器人 key 不对")
            ch["wecom"] = {"key": key, "use": [x for x in src if x in (w.get("use") or [])]}
        m = s.get("mail") if isinstance(s.get("mail"), dict) else None
        if m and m.get("user"):
            smtp = {k: m.get(k) for k in ("user", "password", "host", "port", "security")}
            if not all(isinstance(smtp[k], str) and 0 < len(smtp[k]) <= 200 for k in ("user", "password", "host")) or type(smtp["port"]) is not int \
                    or not PUSH_MAIL_RE.fullmatch(smtp["user"]) or smtp["port"] not in PUSH_PORTS or smtp["security"] not in (("ssl", "starttls", "none") if PUSH_TEST_PRIVATE else ("ssl", "starttls")):
                raise ValueError("邮箱设置不对")
            to = str(m.get("to") or smtp["user"])
            if not PUSH_MAIL_RE.fullmatch(to):
                raise ValueError("收件邮箱不对")
            ch["mail"] = {"smtp": smtp, "to": to, "use": [x for x in src if x in (m.get("use") or [])]}
        for k, (name, key_re, secret_re) in PUSH_TOKEN.items():
            t = s.get(k) if isinstance(s.get(k), dict) else None
            if not (t and t.get("key")):
                continue
            key, secret = str(t["key"]).strip(), str(t.get("secret") or "").strip()
            if not key_re.fullmatch(key) or (secret and not (secret_re and secret_re.fullmatch(secret))):
                raise ValueError(f"{name}设置不对")
            ch[k] = {"key": key, "secret": secret, "use": [x for x in src if x in (t.get("use") or [])]}
        if not any(c["use"] for c in ch.values()):
            raise ValueError("推送渠道都没有设置，或者没有勾选要推送的预警")
        out = {"src": src, "ch": ch, "lang": "en" if s.get("lang") == "en" else "zh"}
        for k in ("site", "killUrl"):
            v = str(s.get(k) or "")
            out[k] = v if HOSTED_URL_RE.fullmatch(v.replace("{id}", "0")) else ""
        k = s.get("kill") if isinstance(s.get("kill"), dict) else {}
        watch = []
        for e in (k.get("watch") or [])[:50]:
            if isinstance(e, dict) and type(e.get("id")) is int and e.get("kind") in ("character", "corporation", "alliance"):
                watch.append({"id": e["id"], "kind": e["kind"], "mode": e.get("mode") if e.get("mode") in ("both", "kills", "losses") else "both",
                              "name": str(e.get("name") or e["id"])[:60]})
        regions = [r for r in (k.get("regions") or [])[:20] if isinstance(r, dict) and type(r.get("id")) is int]
        out["kill"] = {"on": k.get("on") is True, "jumps": min(10, max(1, int(k.get("jumps") or 3))), "pods": k.get("pods") is not False,
                       "minValue": max(0, float(k.get("minValue") or 0)), "maxAge": max(0, int(k.get("maxAge") or 0)),
                       "ships": self.ids(k.get("ships") or [], 3000, "舰船类别"), "offlineMute": k.get("offlineMute") is not False,
                       "watchOn": k.get("watchOn") is True, "watch": watch,
                       "regionOn": k.get("regionOn") is True, "regions": [{"id": r["id"], "name": str(r.get("name") or r["id"])[:40]} for r in regions]}
        out["sos"] = {"rewardOnly": (s.get("sos") or {}).get("rewardOnly") is True}
        b = s.get("battle") if isinstance(s.get("battle"), dict) else {}
        out["battle"] = {"min": b.get("min") if b.get("min") in ("small", "medium", "large") else "small"}
        price = []
        for a in (s.get("price") or [])[:HOSTED_PRICE_MAX] if isinstance(s.get("price"), list) else []:
            if not isinstance(a, dict) or any(type(a.get(k)) is not int or a[k] <= 0 for k in ("type", "region")) or a.get("side") not in ("sell", "buy") \
                    or a.get("op") not in ("le", "ge") or type(a.get("price")) not in (int, float) or not a["price"] > 0:
                continue
            price.append({"key": str(a.get("key") or "")[:80], "type": a["type"], "region": a["region"], "global": a.get("global") is True,
                          "station": a["station"] if type(a.get("station")) is int else 0, "system": a["system"] if type(a.get("system")) is int else 0,
                          "side": a["side"], "op": a["op"], "price": float(a["price"])})
        out["price"] = price
        return out

    def runtime(self, server, char, name, cfg, state):
        return {"server": server, "char": char, "name": name, "cfg": cfg, "state": state, "access": "", "exp": 0, "dead": bool(state.get("token_error")),
                "range": {}, "loc_at": 0, "online_at": 0, "order_at": 0, "at": {}, "busy": set(), "queue": {k: [] for k in HOSTED_PUSH_GAP}, "last": dict.fromkeys(HOSTED_PUSH_GAP, 0),
                "dirty": False, "tlock": threading.Lock()}

    # ---------- 令牌 ----------
    @staticmethod
    def claims(access):
        part = access.split(".")[1]
        c = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        char = int(str(c.get("sub") or "").split(":")[-1] or 0)
        scp = c.get("scp") or []
        return char, str(c.get("name") or char), [scp] if isinstance(scp, str) else list(scp)

    @staticmethod
    def refresh(server, client_id, token):
        """用刷新令牌换新的访问令牌：返回 (访问令牌, 有效秒数, 新的刷新令牌)；令牌无效抛 PermissionError"""
        req = urllib.request.Request(HOSTED_TOKEN_URLS[server], method="POST",
                                     data=urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": token, "client_id": client_id}).encode(),
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "eve-market-hosted-alerts/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403):
                raise PermissionError("授权已失效") from None
            raise EsiUnavailable(f"登录服务器返回 {e.code}") from None
        except Exception as e:  # noqa: BLE001
            raise EsiUnavailable(f"连不上登录服务器：{type(e).__name__}") from None
        if not d.get("access_token"):
            raise PermissionError("授权已失效")
        return d["access_token"], int(d.get("expires_in") or 1199), d.get("refresh_token") or token

    def access(self, sub):
        with sub["tlock"]:   # 刷新令牌用一次就换，同一角色不能并发刷新
            return self._access(sub)

    def _access(self, sub):
        if sub["dead"]:
            raise PermissionError("授权已失效")
        if sub["access"] and sub["exp"] > time.time() + 60:
            return sub["access"]
        cfg = sub["cfg"]
        try:
            access, ttl, rt = self.refresh(sub["server"], cfg["client_id"], cfg["refresh"])
        except PermissionError:
            sub["dead"] = True
            sub["state"]["token_error"] = "授权已失效（在 CCP 撤销了授权或改了密码），请重新授权"
            sub["dirty"] = True
            raise
        sub["access"], sub["exp"] = access, time.time() + ttl
        if rt != cfg["refresh"]:   # 刷新令牌换了：马上写回，否则重启后用旧的会失败
            cfg["refresh"] = rt
            self.save_blob(sub)
        return access

    def esi(self, sub, path, **params):
        cfg = ARB_SERVERS[sub["server"]]
        url = f"{cfg['esi']}{path}?" + "&".join(x for x in (urllib.parse.urlencode(params), cfg["qs"]) if x)
        try:
            return get_json(url, timeout=30, retries=2, fatal=(400, 401, 403, 404), headers={"Authorization": "Bearer " + self.access(sub)})
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                sub["exp"] = 0
            raise EsiUnavailable(f"ESI 返回 {e.code}") from None

    def esi_pages(self, sub, path, **params):
        first, h = self.esi(sub, path, page=1, **params)
        out = list(first or [])
        for n in range(2, min(int(h.get("X-Pages") or 1), 20) + 1):
            out += self.esi(sub, path, page=n, **params)[0] or []
        return out

    def has(self, sub, scope):
        return HOSTED_SCOPES[scope] in sub["cfg"].get("scopes", [])

    # ---------- 存取 ----------
    def save_blob(self, sub):
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("UPDATE hosted SET blob=?, updated=? WHERE server=? AND char_id=?", (self.seal(sub["cfg"]), int(time.time()), sub["server"], sub["char"]))
            c.commit()

    def save_state(self, sub):
        sub["dirty"] = False
        try:
            state = json.dumps(sub["state"], ensure_ascii=False)
        except RuntimeError:   # 后台任务正在改：下一轮再存
            sub["dirty"] = True
            return
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("UPDATE hosted SET state=? WHERE server=? AND char_id=?", (state, sub["server"], sub["char"]))
            c.commit()

    def auth(self, body):
        server = WhSos.server_of(body.get("server"))
        char = WhSos.char_of(body)
        secret = str(body.get("secret") or "")
        row = self.store.conn().execute("SELECT secret FROM hosted WHERE server=? AND char_id=?", (server, char)).fetchone()
        if not row or not hmac.compare_digest(row[0], hashlib.sha256(secret.encode()).hexdigest()):
            raise PermissionError("没有找到这个角色的托管，或凭证不对（可能已在别的浏览器重新开启）")
        return server, char

    # ---------- 接口 ----------
    def start(self, body, ip=None):
        server = WhSos.server_of(body.get("server"))
        client_id, rt = str(body.get("client_id") or ""), str(body.get("refresh_token") or "")
        if not re.fullmatch(r"[0-9a-f]{32}", client_id) or not 10 < len(rt) < 4000:
            raise ValueError("缺少授权信息，请重新授权")
        settings = self.clean(body.get("settings"))
        with self.lock:
            if len(self.subs) >= HOSTED_MAX:
                raise ValueError("托管名额已满，请稍后再试")
        try:
            access, ttl, rt = self.refresh(server, client_id, rt)
        except PermissionError:
            raise ValueError("授权无效或已过期，请重新授权") from None
        char, name, scopes = self.claims(access)
        if not char:
            raise ValueError("授权里没有角色信息")
        cfg = {**settings, "client_id": client_id, "refresh": rt, "scopes": scopes}
        secret = secrets.token_urlsafe(24)
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("INSERT OR REPLACE INTO hosted(server, char_id, name, secret, blob, state, created, updated) VALUES(?,?,?,?,?,?,?,?)",
                      (server, char, name, hashlib.sha256(secret.encode()).hexdigest(), self.seal(cfg), "{}", now, now))
            c.commit()
        sub = self.runtime(server, char, name, cfg, {})
        sub["access"], sub["exp"] = access, time.time() + ttl
        with self.lock:
            self.subs[(server, char)] = sub
        log.info("托管预警开启 %s:%s %s", server, char, ",".join(settings["src"]))
        return {"ok": True, "secret": secret, "character_id": char, "name": name, "scopes": scopes}

    def update(self, body, ip=None):
        server, char = self.auth(body)
        settings = self.clean(body.get("settings"))
        with self.lock:
            sub = self.subs.get((server, char))
        if not sub:
            raise PermissionError("没有找到这个角色的托管")
        sub["cfg"] = {**sub["cfg"], **settings}
        sub["range"], sub["loc_at"], sub["online_at"], sub["order_at"], sub["at"] = {}, 0, 0, 0, {}
        self.save_blob(sub)
        return {"ok": True}

    def status(self, body, ip=None):
        server, char = self.auth(body)
        sub = self.subs.get((server, char))
        if not sub:
            raise PermissionError("没有找到这个角色的托管")
        st, cfg = sub["state"], sub["cfg"]
        return {"ok": True, "name": sub["name"], "src": cfg["src"], "scopes": cfg.get("scopes", []), "token_error": st.get("token_error") or "",
                "checked": st.get("checked", {}), "errors": st.get("errors", {}), "sent": st.get("sent", []),
                "system": st.get("system_name") or "", "online": st.get("online")}

    def stop(self, body, ip=None):
        server, char = self.auth(body)
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("DELETE FROM hosted WHERE server=? AND char_id=?", (server, char))
            c.commit()
        with self.lock:
            self.subs.pop((server, char), None)
        log.info("托管预警停止 %s:%s", server, char)
        return {"ok": True}

    # ---------- 后台 ----------
    def start_worker(self):
        threading.Thread(target=self.loop, daemon=True, name="hosted").start()

    def loop(self):
        for server, api in self.apis.items():
            self.cursor[server] = api.store.live_n
            self.sos_seen[server] = int(time.time())
        while True:
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                log.exception("托管预警出错")
            time.sleep(HOSTED_TICK)

    def tick(self):
        now = time.time()
        with self.lock:
            subs = list(self.subs.values())
        kills = {}
        for server, api in self.apis.items():
            buf = list(api.store.live_buf)
            last = self.cursor.get(server, 0)
            new = [k for n, k in buf if n > last]
            if buf:
                self.cursor[server] = buf[-1][0]
            if new:
                kills[server] = (new, api)
        sos = self.new_sos(now) if now - self.sos_at >= HOSTED_SOS_GAP else {}
        battles = self.new_battles(now, subs) if now - self.battle_at >= HOSTED_BATTLE_GAP else {}
        for sub in subs:
            cfg, srv = sub["cfg"], sub["server"]
            if "kill" in cfg["src"]:
                self.kill_upkeep(sub, now)
                if srv in kills:
                    self.kill_match(sub, *kills[srv])
            if "sos" in cfg["src"] and sos.get(srv):
                self.sos_match(sub, sos[srv])
            if "battle" in cfg["src"] and srv in battles:
                self.battle_match(sub, *battles[srv])
            if "order" in cfg["src"] and now - sub["order_at"] >= HOSTED_ORDER_GAP and "order" not in sub["busy"]:
                sub["order_at"] = now
                self.job(sub, "order", self.order_check)
            for src, fn, gap in self.char_jobs():
                # 到价提醒只用公开订单，授权失效也照查；角色提醒要令牌
                if src in cfg["src"] and (src == "price" or not sub["dead"]) and now - sub["at"].get(src, 0) >= gap and src not in sub["busy"]:
                    sub["at"][src] = now
                    self.job(sub, src, fn)
            self.flush(sub, now)
            if sub["dirty"]:
                self.save_state(sub)

    def char_jobs(self):
        return (("price", self.price_check, HOSTED_PRICE_GAP), ("skill", self.skill_check, HOSTED_CHAR_GAP["skill"]),
                ("job", self.job_check, HOSTED_CHAR_GAP["job"]), ("pi", self.pi_check, HOSTED_CHAR_GAP["pi"]),
                ("sold", self.sold_check, HOSTED_CHAR_GAP["sold"]), ("contract", self.contract_check, HOSTED_CHAR_GAP["contract"]))

    def job(self, sub, name, fn):
        sub["busy"].add(name)

        def run():
            try:
                fn(sub)
                sub["state"].setdefault("errors", {}).pop(name, None)
            except PermissionError as e:
                sub["state"].setdefault("errors", {})[name] = str(e)
            except Exception as e:  # noqa: BLE001
                sub["state"].setdefault("errors", {})[name] = str(e)[:200]
            finally:
                sub["state"].setdefault("checked", {})[name] = int(time.time())
                sub["dirty"] = True
                sub["busy"].discard(name)
        self.pool.submit(run)

    def mark(self, sub, src):
        sub["state"].setdefault("checked", {})[src] = int(time.time())
        sub["dirty"] = True

    def enqueue(self, sub, src, text, url=""):
        for ch, c in sub["cfg"]["ch"].items():
            if src in c["use"]:
                sub["queue"][ch].append((src, text, url))
        sent = sub["state"].setdefault("sent", [])
        sent.insert(0, [int(time.time()), src, text])
        del sent[HOSTED_SENT_KEEP:]
        sub["dirty"] = True

    def flush(self, sub, now):
        cfg = sub["cfg"]
        en = cfg["lang"] == "en"
        for ch, q in sub["queue"].items():
            if not q or now - sub["last"][ch] < HOSTED_PUSH_GAP[ch] or ch not in cfg["ch"]:
                continue
            items, sub["queue"][ch] = q[:PUSH_LINES], q[PUSH_LINES:]
            sub["last"][ch] = now
            kinds = {s for s, _, _ in items}
            title = (HOSTED_LABELS[next(iter(kinds))][en] if len(kinds) == 1 else ("Alerts" if en else "预警")) + (" (hosted)" if en else "（服务器托管）") \
                + ((f" ({len(items)})" if en else f"（{len(items)} 条）") if len(items) > 1 else "")
            body = {"title": title, "lines": [{"text": t, "url": u} for _, t, u in items], "lang": cfg["lang"]}
            c = cfg["ch"][ch]
            try:
                if ch == "wecom":
                    self.push.wecom({**body, "key": c["key"]})
                elif ch in PUSH_TOKEN:
                    self.push.token(ch, {**body, "key": c["key"], "secret": c["secret"]})
                else:
                    self.push.mail({**body, "smtp": c["smtp"], "to": c["to"]}, "hosted:" + str(sub["char"]))
                sub["state"].setdefault("errors", {}).pop("push_" + ch, None)
            except ValueError as e:
                if "太频繁" in str(e):
                    sub["queue"][ch] = items + sub["queue"][ch]
                    continue
                sub["state"].setdefault("errors", {})["push_" + ch] = str(e)[:200]
            except Exception as e:  # noqa: BLE001
                sub["state"].setdefault("errors", {})["push_" + ch] = str(e)[:200]
            sub["dirty"] = True

    # ---------- 名称、星图 ----------
    def load_names(self):
        """物品中文名（type-names-zh.json，缺的用 fit-data.json）、中文 → 英文（i18n/names-en.json）、虫洞星系名（wh-data.json）"""
        if self.names is not None:
            return
        zh, en, wh, cn = {}, {}, {}, {}
        for name, fn in (("fit-data.json", lambda d: zh.update({int(k): v[0] for k, v in d["types"].items()})),
                         ("type-names-zh.json", lambda d: zh.update({int(k): v for k, v in d.items()})),
                         ("i18n/names-en.json", en.update),
                         ("wh-data.json", lambda d: wh.update({x[0]: x[1] for x in d["systems"]}))):
            try:
                fn(self.industry._load(name))
            except Exception:  # noqa: BLE001
                log.warning("托管预警：读不到 %s，相关名称用 ID", name)
        # 国服订阅的中文消息：宁静中文与国服不同的名称换成国服的（cn-names-<服>.json，build_cn_extra.py 生成）
        for srv in ("serenity", "infinity"):
            try:
                cn[srv] = self.industry._load(f"cn-names-{srv}.json").get("names") or {}
            except Exception:  # noqa: BLE001
                cn[srv] = {}
        self.names, self.en_names, self.wh_names, self.cn_names = zh, en, wh, cn

    def tr(self, zh, en, server=None):
        if en:
            return self.en_names.get(zh, zh)
        return self.cn_names.get(server, {}).get(zh, zh) if server else zh

    def type_name(self, tid, en, server=None):
        self.load_names()
        n = self.names.get(tid)
        return self.tr(n, en, server) if n else f"Type {tid}"

    def map(self, server):
        server = "infinity" if server == "infinity" else "tq"
        if server not in self.graphs:
            m = self.industry._load("map-data-infinity.json" if server == "infinity" else "map-data.json")
            systems = m["systems"]
            adj = [[] for _ in systems]
            for a, b in m["gates"]:
                adj[a].append(b)
                adj[b].append(a)
            self.graphs[server] = ({s[0]: i for i, s in enumerate(systems)}, adj, systems)
        return self.graphs[server]

    def sys_name(self, server, sid, en=False):
        self.load_names()
        index, _, systems = self.map(server)
        i = index.get(sid)
        return self.tr(systems[i][1], en, server) if i is not None else self.wh_names.get(sid) or str(sid)

    def jumps_from(self, server, sid, limit):
        index, adj, systems = self.map(server)
        if sid not in index:
            return {sid: 0}
        dist = {index[sid]: 0}
        frontier = [index[sid]]
        for d in range(1, limit + 1):
            nxt = []
            for i in frontier:
                for j in adj[i]:
                    if j not in dist:
                        dist[j] = d
                        nxt.append(j)
            frontier = nxt
        return {systems[i][0]: d for i, d in dist.items()}

    # ---------- 击杀预警 ----------
    def kill_upkeep(self, sub, now):
        k = sub["cfg"]["kill"]
        if k["on"] and self.has(sub, "loc") and not sub["dead"] and now - sub["loc_at"] >= HOSTED_LOC_GAP and "loc" not in sub["busy"]:
            sub["loc_at"] = now
            self.job(sub, "loc", self.locate)
        if k["offlineMute"] and self.has(sub, "online") and not sub["dead"] and now - sub["online_at"] >= HOSTED_ONLINE_GAP and "online" not in sub["busy"]:
            sub["online_at"] = now
            self.job(sub, "online", lambda s: s["state"].__setitem__("online", (self.esi(s, f"/characters/{s['char']}/online/")[0] or {}).get("online") is not False))

    def locate(self, sub):
        loc, _ = self.esi(sub, f"/characters/{sub['char']}/location/")
        sid = int((loc or {}).get("solar_system_id") or 0)
        if sid and (sid != sub["state"].get("system") or not sub["range"]):
            sub["range"] = self.jumps_from(sub["server"], sid, sub["cfg"]["kill"]["jumps"])
            sub["state"]["system"], sub["state"]["system_name"] = sid, self.sys_name(sub["server"], sid, sub["cfg"]["lang"] == "en")

    def kill_match(self, sub, kills, api):
        cfg = sub["cfg"]
        k = cfg["kill"]
        en = cfg["lang"] == "en"
        if k["offlineMute"] and sub["state"].get("online") is False:
            return
        names = None
        ships = set(k["ships"])
        for x in kills:
            if k["maxAge"]:
                try:
                    t = calendar.timegm(time.strptime(x["time"][:19], "%Y-%m-%dT%H:%M:%S"))
                    if time.time() - t > k["maxAge"]:
                        continue
                except ValueError:
                    pass
            hit = None
            if k["watchOn"]:
                for e in k["watch"]:
                    col = {"corporation": "corporation_id", "alliance": "alliance_id"}.get(e["kind"], "character_id")
                    if e["mode"] != "kills" and x["victim"].get(col) == e["id"]:
                        hit = ("loss", e)
                        break
                    if e["mode"] != "losses" and (x["final"].get(col) == e["id"] or e["id"] in (x.get("att") if e["kind"] == "character" else x.get("ao")) or []):
                        hit = ("kill", e)
                        break
            region = None
            if not hit:
                pod = x["ship_type_id"] in HOSTED_PODS
                if (pod and not k["pods"]) or (x["value"] or 0) < k["minValue"] or (ships and not pod and x["ship_type_id"] not in ships):
                    continue
                if k["on"] and x["system_id"] in sub["range"]:
                    pass
                elif k["regionOn"] and any(r["id"] == x["region_id"] for r in k["regions"]):
                    region = next(r["name"] for r in k["regions"] if r["id"] == x["region_id"])
                else:
                    continue
            if names is None:
                names = api.with_names(kills)
            ship = self.type_name(x["ship_type_id"], en, sub["server"])
            victim = names.get(x["victim"].get("character_id")) or names.get(x["victim"].get("corporation_id")) or ""
            sysn = self.sys_name(sub["server"], x["system_id"], en)
            jumps = sub["range"].get(x["system_id"])
            jt = (f"{jumps} jump{'s' if jumps != 1 else ''}" if en else f"{jumps} 跳") if jumps is not None else ""
            whose = (f"{victim}'s " if en else f"{victim}的") if victim else ""
            if hit:
                role, e = hit
                if en:
                    text = f"{e['name']} lost a {ship} · {sysn}" if role == "loss" else f"{e['name']} killed {whose}{ship} · {sysn}"
                else:
                    text = f"关注的 {e['name']} 损失了{ship} · {sysn}" if role == "loss" else f"关注的 {e['name']} 参与击杀了{whose}{ship} · {sysn}"
            elif region:
                text = f"{region} · {sysn}: {whose}{ship} destroyed" if en else f"{region} · {sysn} {whose}{ship}被击毁"
            else:
                text = f"{sysn} ({jt}): {whose}{ship} destroyed" if en else f"{sysn}（{jt}）{whose}{ship}被击毁"
            extra = [f"{_isk(x['value'])} ISK" if x.get("value") else "",
                     (f"{x['attackers']} attacker{'s' if x['attackers'] != 1 else ''}" if en else f"{x['attackers']} 名攻击者") if x.get("attackers") else ""]
            text += "".join(" · " + e for e in extra if e)
            url = cfg["killUrl"].replace("{id}", str(x["id"])) if cfg.get("killUrl") else ""
            self.enqueue(sub, "kill", text, url)
        self.mark(sub, "kill")

    # ---------- 虫洞求救 ----------
    def new_sos(self, now):
        self.sos_at = now
        out = {}
        c = self.store.conn()
        for server in self.apis:
            seen = self.sos_seen.get(server, int(now))
            rows = c.execute("SELECT char_id, name, system_id, words, reward, contact, created, updated FROM wh_sos WHERE server=? AND created>? ORDER BY created",
                             (server, seen)).fetchall()
            if rows:
                self.sos_seen[server] = rows[-1][6]
                out[server] = rows
        return out

    def sos_match(self, sub, rows):
        cfg = sub["cfg"]
        en = cfg["lang"] == "en"
        for char, name, sid, words, reward, contact, *_ in rows:
            if char == sub["char"] or (cfg["sos"]["rewardOnly"] and not reward):
                continue
            sysn = self.sys_name(sub["server"], sid)
            text = (f"{self.tr(sysn, True)} · {name} needs help" if en else f"{sysn} · {name} 求救") + ((": " if en else "：") + words if words else "") \
                + ((f" · reward {_isk(reward)} ISK" if en else f" · 悬赏 {_isk(reward)} ISK") if reward else "") \
                + ((f" · contact: {contact}" if en else f" · 联系：{contact}") if contact else "")
            url = f"{cfg['site']}#wh/system/{urllib.parse.quote(sysn)}" if cfg.get("site") else ""
            self.enqueue(sub, "sos", text, url)
        self.mark(sub, "sos")

    # ---------- 会战 ----------
    def new_battles(self, now, subs):
        """各服务器当前的会战：{server: (会战列表, 名称)}；只查有人托管会战的服务器（接口自带 5 秒缓存）"""
        self.battle_at = now
        out = {}
        for server in {s["server"] for s in subs if "battle" in s["cfg"]["src"]}:
            api = self.apis.get(server)
            if not api:
                continue
            try:
                data = api.battles({"window": str(HOSTED_BATTLE_WINDOW), "min": str(BATTLE_MIN_KILLS)})
            except Exception:  # noqa: BLE001
                log.warning("托管预警：%s 会战读取失败", server)
                continue
            out[server] = (data.get("battles") or [], data.get("names") or {})
        return out

    def battle_match(self, sub, battles, names):
        # 每个托管各记一份已推送（星系 -> 时间；规模没到时不记，打大了再推）；刚开启时正在打的只记下、不推
        cfg = sub["cfg"]
        en = cfg["lang"] == "en"
        need = next(n for k, n, *_ in HOSTED_TIERS if k == cfg.get("battle", {}).get("min", "small"))
        first = "battles" not in sub["state"]
        done = sub["state"].setdefault("battles", {})
        now = int(time.time())
        for k in [k for k, t in done.items() if now - t > HOSTED_BATTLE_TTL]:
            del done[k]
        for b in battles:
            key = str(b["system_id"])
            if b["kills"] < need or key in done:
                continue
            done[key] = now
            if first:
                continue
            tier = next(t for t in HOSTED_TIERS if b["kills"] >= t[1] or t[0] == "small")
            index, _, systems = self.map(sub["server"])
            i = index.get(b["system_id"])
            region = self.region_names(sub["server"]).get(systems[i][6]) if i is not None else ""
            sysn = self.sys_name(sub["server"], b["system_id"], en)
            where = sysn + ((f" ({self.tr(region, True)})" if en else f"（{self.tr(region, False, sub['server'])}）") if region else "")
            sides = [names.get(str(x["id"])) or names.get(x["id"]) for x in b.get("sides", [])[:2]]
            sides = [x for x in sides if x]
            text = (f"{tier[3]} · {where} · {b['kills']} ships destroyed in {HOSTED_BATTLE_WINDOW} min · ~{b['pilots']} pilots · {_isk(b['value'])} ISK lost" if en
                    else f"{tier[2]} · {where} · {HOSTED_BATTLE_WINDOW} 分钟内击毁 {b['kills']} 艘 · 约 {b['pilots']} 人 · 损失 {_isk(b['value'])} ISK") \
                + (" · " + " vs ".join(sides) if sides else "")
            self.enqueue(sub, "battle", text, f"{cfg['site']}#map={b['system_id']}" if cfg.get("site") else "")
        sub["dirty"] = True
        self.mark(sub, "battle")

    def region_names(self, server):
        key = "regions:" + server
        if key not in self.graphs:
            m = self.industry._load("map-data-infinity.json" if server == "infinity" else "map-data.json")
            self.graphs[key] = {r[0]: r[1] for r in m["regions"]}
        return self.graphs[key]

    # ---------- 订单被压价（规则同 js/order-watch.js 的 analyze）----------
    def region_of(self, sub, o):
        if o.get("region_id"):
            return o["region_id"], o.get("system_id")
        key = (sub["server"], o["location_id"])
        if key not in self.station_region:
            cfg = ARB_SERVERS[sub["server"]]
            st, _ = get_json(f"{cfg['esi']}/universe/stations/{o['location_id']}/?{cfg['qs']}", timeout=20, retries=2)
            index, _, systems = self.map(sub["server"])
            i = index.get(st["system_id"])
            self.station_region[key] = (st["system_id"], systems[i][6] if i is not None else 0)
        sid, rid = self.station_region[key]
        return rid, sid

    def market_for(self, sub, o, buy):
        now = time.time()
        if o["location_id"] >= 10**12:
            if not self.has(sub, "struct"):
                return None
            key = (sub["server"], o["location_id"])
            hit = self.structs.get(key)
            if not hit or now - hit[0] > HOSTED_ORDER_GAP:
                hit = (now, self.esi_pages(sub, f"/markets/structures/{o['location_id']}/"))
                self.structs[key] = hit
            return [x for x in hit[1] if x["type_id"] == o["type_id"]]
        region, sid = self.region_of(sub, o)
        if not region:
            return None
        o["system_id"] = o.get("system_id") or sid
        return self.region_orders(sub["server"], region, o["type_id"], buy)

    def region_orders(self, server, region, type_id, buy):
        """星域里某物品的收单 / 卖单（公开接口，多个角色共用缓存 5 分钟）"""
        now = time.time()
        key = (server, region, type_id, buy)
        hit = self.market.get(key)
        if not hit or now - hit[0] > HOSTED_ORDER_GAP:
            cfg = ARB_SERVERS[server]
            out, page, pages = [], 1, 1
            while page <= min(pages, 20):
                data, h = get_json(f"{cfg['esi']}/markets/{region}/orders/?type_id={type_id}&order_type={'buy' if buy else 'sell'}&page={page}"
                                   + (f"&{cfg['qs']}" if cfg["qs"] else ""), timeout=30, retries=2)
                out += data or []
                pages, page = int(h.get("X-Pages") or 1), page + 1
            hit = (now, out)
            self.market[key] = hit
            if len(self.market) > 5000:
                self.market = {k: v for k, v in self.market.items() if now - v[0] < HOSTED_ORDER_GAP}
        return hit[1]

    def order_check(self, sub):
        if not self.has(sub, "orders"):
            raise PermissionError("授权里没有订单权限，请重新授权")
        en = sub["cfg"]["lang"] == "en"
        orders, _ = self.esi(sub, f"/characters/{sub['char']}/orders/")
        orders = (orders or [])[:HOSTED_ORDER_MAX]
        mine = {o["order_id"] for o in orders}
        alerted = sub["state"].setdefault("alerted", {})
        live = set()
        for o in orders:
            buy = bool(o.get("is_buy_order"))
            lst = self.market_for(sub, o, buy)
            if lst is None:
                continue
            sid = o.get("system_id") or next((x.get("system_id") for x in lst if x["location_id"] == o["location_id"]), None)
            rivals = [x["price"] for x in lst if x["order_id"] not in mine and bool(x.get("is_buy_order")) == buy and (
                (x["location_id"] == o["location_id"] or x.get("range") == "region" or (sid and x.get("system_id") == sid and x.get("range") != "station"))
                if buy else x["location_id"] == o["location_id"])]
            if not rivals:
                continue
            best = max(rivals) if buy else min(rivals)
            if not (best >= o["price"] if buy else best <= o["price"]):
                continue
            oid = str(o["order_id"])
            live.add(oid)
            if alerted.get(oid) == best:
                continue
            alerted[oid] = best
            name = self.type_name(o["type_id"], en, sub["server"])
            where = self.sys_name(sub["server"], sid, en) if sid else ""
            text = (f"{name}: {'buy' if buy else 'sell'} order {_price(o['price'])} undercut, best {_price(best)}" if en
                    else f"{name}：{'收单' if buy else '卖单'} {_price(o['price'])} 被压，对手 {_price(best)}") + (f" · {where}" if where else "")
            self.enqueue(sub, "order", text)
        for oid in list(alerted):
            if oid not in live:
                del alerted[oid]

    # ---------- 到价提醒（规则同 js/watch-board.js：交易中心空间站里的最低卖价 / 最高收价；全服统一市场的物品看整个星域）----------
    def price_check(self, sub):
        cfg = sub["cfg"]
        en = cfg["lang"] == "en"
        alerts = cfg.get("price") or []
        done = set(sub["state"].get("price_hit") or [])
        for a in alerts:
            if a["key"] in done:
                continue
            lst = self.region_orders(sub["server"], a["region"], a["type"], a["side"] == "buy")
            px = [x["price"] for x in lst if a["global"] or x["location_id"] == a["station"]]
            if not px:
                continue
            v = max(px) if a["side"] == "buy" else min(px)
            if not (v <= a["price"] if a["op"] == "le" else v >= a["price"]):
                continue
            done.add(a["key"])
            name = self.type_name(a["type"], en, sub["server"])
            hub = self.sys_name(sub["server"], a["system"], en) if a["system"] else ""
            op = "≤" if a["op"] == "le" else "≥"
            text = (f"{name}: {hub + ' ' if hub else ''}{'buy' if a['side'] == 'buy' else 'sell'} price {_price(v)} ({op} {_price(a['price'])})" if en
                    else f"{name}：{hub}{'收' if a['side'] == 'buy' else '卖'}价 {_price(v)}（{op} {_price(a['price'])}）")
            self.enqueue(sub, "price", text, f"{cfg['site']}#type={a['type']}" if cfg.get("site") else "")
        keys = {a["key"] for a in alerts}
        sub["state"]["price_hit"] = [k for k in done if k in keys]

    # ---------- 角色提醒（同 js/char-alerts.js）：和上次读到的比，刚开启时只记下现状 ----------
    def need(self, sub, scope):
        if not self.has(sub, scope):
            raise PermissionError("授权里没有这项权限，请重新授权")

    @staticmethod
    def who(sub, en=False):
        return sub["name"] + " · "

    def loc_name(self, sub, lid, en):
        """空间站 / 玩家建筑 / 星系名；读不到返回空"""
        if not lid:
            return ""
        if 30000000 <= lid < 33000000:
            return self.sys_name(sub["server"], lid, en)
        key = (sub["server"], lid, en)
        if key not in self.loc_names:
            name = ""
            try:
                if lid >= 10**12:
                    if self.has(sub, "names"):
                        name = (self.esi(sub, f"/universe/structures/{lid}/")[0] or {}).get("name") or ""
                elif 60000000 <= lid < 64000000:
                    cfg = ARB_SERVERS[sub["server"]]
                    st, _ = get_json(f"{cfg['esi']}/universe/stations/{lid}/?language={'en' if en else 'zh'}" + (f"&{cfg['qs']}" if cfg["qs"] else ""), timeout=20, retries=2)
                    name = (st or {}).get("name") or ""
            except Exception:  # noqa: BLE001
                return ""
            self.loc_names[key] = name
        return self.loc_names[key]

    def skill_check(self, sub):
        self.need(sub, "skill")
        en = sub["cfg"]["lang"] == "en"
        q, _ = self.esi(sub, f"/characters/{sub['char']}/skillqueue/")
        now = time.time()
        cur = {}
        for e in q or []:
            fin = _ts(e.get("finish_date"))
            if fin:
                cur[f"{e['skill_id']}:{e.get('finished_level', 0)}"] = fin
        end = max(cur.values(), default=0)
        st = sub["state"].get("skillq")
        sub["state"]["skillq"] = nxt = {"q": {k: t for k, t in cur.items() if t > now}, "low": bool(st and st.get("low")) and 0 < end - now < HOSTED_SKILL_LOW,
                                        "empty": end <= now}
        if st is None:
            nxt["low"] = 0 < end - now < HOSTED_SKILL_LOW
            return
        done = [k for k, t in st["q"].items() if cur.get(k, t) <= now]
        if done:
            names = [f"{self.type_name(int(k.split(':')[0]), en, sub['server'])} {'level ' if en else ''}{k.split(':')[1]}{'' if en else ' 级'}" for k in done[:8]]
            self.enqueue(sub, "skill", self.who(sub, en) + ("Skill trained: " if en else "技能练完：") + ("、" if not en else ", ").join(names)
                         + ((f" and {len(done) - 8} more" if en else f" 等 {len(done)} 个") if len(done) > 8 else ""))
        if nxt["empty"] and not st.get("empty"):
            paused = bool(q) and not cur   # 队列里有技能但没有完成时间：没在训练（如阿尔法克隆、欧米伽到期）
            self.enqueue(sub, "skill", self.who(sub, en) + (("Skill queue is paused" if paused else "Skill queue is empty") if en
                                                            else "技能队列没在训练" if paused else "技能队列已空，记得续上"))
        elif 0 < end - now < HOSTED_SKILL_LOW and not st.get("low"):
            h = max(1, round((end - now) / 3600))
            self.enqueue(sub, "skill", self.who(sub, en) + (f"Skill queue ends in {h} h" if en else f"技能队列 {h} 小时后练完，记得续上"))
            nxt["low"] = True

    def job_check(self, sub):
        self.need(sub, "job")
        en = sub["cfg"]["lang"] == "en"
        jobs, _ = self.esi(sub, f"/characters/{sub['char']}/industry/jobs/")
        now = time.time()
        ready = [j for j in jobs or [] if j.get("status") in ("active", "ready") and 0 < _ts(j.get("end_date")) <= now]
        seen = sub["state"].get("jobs")
        sub["state"]["jobs"] = [j["job_id"] for j in ready]
        if seen is None:
            return
        for j in [j for j in ready if j["job_id"] not in set(seen)]:
            act = HOSTED_ACT.get(j.get("activity_id"), ("工业任务", "Industry job"))[en]
            name = self.type_name(j.get("product_type_id") or j.get("blueprint_type_id"), en, sub["server"])
            where = self.loc_name(sub, j.get("facility_id") or j.get("station_id"), en)
            text = (f"{act} done: {name} ×{j.get('runs', 1)}" if en else f"{act}完成：{name} ×{j.get('runs', 1)}") + (f" · {where}" if where else "")
            self.enqueue(sub, "job", self.who(sub, en) + text)

    def planet_name(self, sub, pid, sid, en):
        key = (sub["server"], pid)
        if key not in self.planet_names:
            cfg = ARB_SERVERS[sub["server"]]
            try:
                self.planet_names[key] = (get_json(f"{cfg['esi']}/universe/planets/{pid}/?{cfg['qs']}", timeout=20, retries=2)[0] or {}).get("name") or ""
            except Exception:  # noqa: BLE001
                return self.sys_name(sub["server"], sid, en)
        name = self.planet_names[key]
        sysn_en = self.sys_name(sub["server"], sid, True)
        # ESI 的行星名是「英文星系名 + 罗马数字」，中文界面换成中文星系名
        return self.sys_name(sub["server"], sid, en) + name[len(sysn_en):] if name.startswith(sysn_en) else name or self.sys_name(sub["server"], sid, en)

    def pi_check(self, sub):
        self.need(sub, "pi")
        en = sub["cfg"]["lang"] == "en"
        planets, _ = self.esi(sub, f"/characters/{sub['char']}/planets/")
        now = time.time()
        stopped = {}
        for p in (planets or [])[:HOSTED_PI_MAX]:
            d, _ = self.esi(sub, f"/characters/{sub['char']}/planets/{p['planet_id']}/")
            for pin in (d or {}).get("pins", []):
                exp = _ts(pin.get("expiry_time"))
                if "extractor_details" in pin and exp and exp <= now:
                    stopped.setdefault(p["planet_id"], [p, []])[1].append(f"{p['planet_id']}:{pin['pin_id']}:{exp}")
        seen = sub["state"].get("pi")
        sub["state"]["pi"] = [k for _, keys in stopped.values() for k in keys]
        if seen is None:
            return
        seen = set(seen)
        for pid, (p, keys) in stopped.items():
            n = len([k for k in keys if k not in seen])
            if n:
                name = self.planet_name(sub, pid, p.get("solar_system_id"), en)
                self.enqueue(sub, "pi", self.who(sub, en) + (f"Extractor stopped: {name} ({n})" if en else f"行星开采器已停：{name}（{n} 个）"))

    def sold_check(self, sub):
        self.need(sub, "orders")
        en = sub["cfg"]["lang"] == "en"
        orders, _ = self.esi(sub, f"/characters/{sub['char']}/orders/")
        now = int(time.time())
        cur = {str(o["order_id"]): [o.get("volume_remain", 0), o["price"], o["type_id"], 1 if o.get("is_buy_order") else 0, o.get("volume_total", 0), o.get("location_id", 0)]
               for o in orders or []}
        prev = sub["state"].get("orders")
        sub["state"]["orders"] = cur
        if prev is None:
            return
        gone = sub["state"].setdefault("orders_gone", {})
        for oid, p in prev.items():
            if oid not in cur and oid not in gone:
                gone[oid] = p + [now]
        if not gone:
            return
        hist, _ = self.esi(sub, f"/characters/{sub['char']}/orders/history/")
        by = {str(h["order_id"]): h for h in hist or []}
        for oid, p in list(gone.items()):
            h = by.get(oid)
            if not h:
                if now - p[6] > HOSTED_GONE_KEEP:
                    del gone[oid]
                continue
            del gone[oid]
            if h.get("state") == "cancelled":
                continue
            name, side = self.type_name(p[2], en, sub["server"]), ("buy" if p[3] else "sell") if en else ("收单" if p[3] else "卖单")
            where = self.loc_name(sub, p[5], en)
            total, left, price = h.get("volume_total") or p[4], h.get("volume_remain", 0), h.get("price") or p[1]
            if left == 0:
                text = (f"Order filled: {name} {side} ×{total:,} @ {_price(price)} · {_isk(total * price)} ISK" if en
                        else f"订单全部成交：{name} {side} ×{total:,} @ {_price(price)} · 共 {_isk(total * price)} ISK")
            else:
                text = (f"Order expired: {name} {side} {left:,}/{total:,} left @ {_price(price)}" if en
                        else f"订单过期：{name} {side} 剩 {left:,}/{total:,} @ {_price(price)}")
            self.enqueue(sub, "sold", self.who(sub, en) + text + (f" · {where}" if where else ""))

    def contract_check(self, sub):
        self.need(sub, "contract")
        en = sub["cfg"]["lang"] == "en"
        me = sub["char"]
        cs, _ = self.esi(sub, f"/characters/{me}/contracts/")
        cs = [c for c in cs or [] if not c.get("for_corporation") and (c.get("issuer_id") == me or c.get("assignee_id") == me)]
        prev = sub["state"].get("contracts")
        sub["state"]["contracts"] = {str(c["contract_id"]): c.get("status") for c in cs}
        bids = sub["state"].setdefault("bids", {})
        live = set()
        out = []
        for c in cs:
            cid, status, mine = str(c["contract_id"]), c.get("status"), c.get("issuer_id") == me
            kind = HOSTED_CT.get(c.get("type"), ("合同", "Contract"))[en]
            title = c.get("title") or ""
            label = kind + (f" “{title}”" if en and title else f"「{title}」" if title else "")
            if mine and c.get("type") == "auction" and status == "outstanding" and len(live) < HOSTED_BIDS_MAX:
                live.add(cid)
                top = max((b.get("amount", 0) for b in self.esi(sub, f"/characters/{me}/contracts/{c['contract_id']}/bids/")[0] or []), default=0)
                if top > bids.get(cid, 0) and prev is not None and cid in prev:
                    out.append(f"New bid on {label}: {_isk(top)} ISK" if en else f"{label}有新出价：{_isk(top)} ISK")
                bids[cid] = max(top, bids.get(cid, 0))
            if prev is None:
                continue
            old = prev.get(cid)
            if not mine:
                if old is None and status == "outstanding":
                    price = c.get("reward") if c.get("type") == "courier" else c.get("price")
                    out.append((f"Contract assigned to you: {label}" if en else f"收到指定给你的合同：{label}") + (f" · {_isk(price)} ISK" if price else ""))
                continue
            if old is None or old == status:
                continue
            if c.get("type") == "courier":
                route = " → ".join(x for x in (self.loc_name(sub, c.get("start_location_id"), en), self.loc_name(sub, c.get("end_location_id"), en)) if x)
                msg = {"in_progress": ("Courier contract accepted", "快递合同被接了"), "finished": ("Courier contract delivered", "快递已送达"),
                       "failed": ("Courier contract failed", "快递合同失败"), "rejected": ("Courier contract rejected", "快递合同被拒绝")}.get(status)
                if msg:
                    out.append(f"{msg[0] if en else msg[1]}{'' if not title else (' “' + title + '”' if en else '「' + title + '」')}" + (f" · {route}" if route else ""))
            elif status in ("finished", "finished_issuer", "finished_contractor"):
                price = bids.get(cid) or c.get("price") if c.get("type") == "auction" else c.get("price")
                out.append((f"{label} completed" if en else f"{label}已完成") + (f" · {_isk(price)} ISK" if price else ""))
            elif status == "rejected":
                out.append(f"{label} rejected" if en else f"{label}被拒绝")
        for k in [k for k in bids if k not in live]:
            del bids[k]
        for t in out:
            self.enqueue(sub, "contract", self.who(sub, en) + t)


# ---------------------------------------------------------------- AI 助手
# 网页「AI 助手」页（js/ai.js）：玩家用自然语言提问，大模型按需调用工具（配船算属性、查会战 / 击杀 / 物价 / 走势、读自己的 ESI），
# 工具都在浏览器里执行（装配引擎、玩家的 ESI 令牌只在本机），服务器只负责把对话转成上游协议、带上系统提示词和工具定义。
# POST /api/kb/ai/info  → 本站是否配了模型、今天还剩多少次
# POST /api/kb/ai/chat  {messages, ctx, llm?} → 模型的一步：{text, calls: [{id, name, args}], raw, stop}；
#   浏览器执行 calls 后把结果作为 tool 消息追加，再请求下一步，直到没有 calls。
#   消息格式（与协议无关）：{role: user, text} / {role: assistant, text, calls, raw} / {role: tool, id, name, text}；
#   raw 是上游原样的回复（同一协议时原样回传，保留推理 / 思考内容）。
# 本站模型：环境变量 EVE_AI_PROTO（openai-chat / openai-responses / anthropic，默认 openai-chat）、EVE_AI_BASE、EVE_AI_KEY、EVE_AI_MODEL；
#   EVE_AI_DAILY 每个 IP 每天可调用模型的次数（一次提问通常要 2–6 次，默认 200），EVE_AI_TOTAL 全站每天合计上限（默认 5000）。
#   玩家也可以在网页里填自己的接口（随请求带来，服务器不保存、不写日志），不占本站额度。
AI_RATE = 12                    # 每个 IP 每分钟最多调用模型次数（用自己接口时 ×3）
AI_BODY_MAX = 800_000
AI_MSG_MAX = 120
AI_TEXT_MAX = 40_000            # 单条消息（含工具结果）最多字数
AI_TIMEOUT = 150
AI_MAX_TOKENS = 8000

AI_SYSTEM = """你是「EVE 市场总览」网站里的 AI 助手，帮 EVE Online 玩家解决问题：配船、查战况和击杀、看物价和走势、读取玩家授权的角色数据（ESI）。

工作方式：
- 先用工具查，再回答；数字（价格、属性、击杀数）必须来自工具结果，不要凭记忆编。工具出错就换个参数再试，或如实告诉玩家。
- 每一步都要调用模型，比较慢：尽量少走步骤。互不依赖的查询放在同一步里一起调用。
  不要用 search_items 确认名字：auto_fit / compute_fit / market_price 等工具自己能识别中英文名，认不出时结果里会给建议。
- 物品、舰船、星系名在回答里用国服中文名（工具结果里的名字），也可以括注英文。
- 配船：有明确要求时先用 auto_fit 自动搜索；要自己写装配时直接写英文 EFT 交给 compute_fit（英文名一定能认；中文名要和游戏里完全一致才行），认不出的名字结果里会给建议。
  对照玩家的要求（速度、DPS、EHP、电容、CPU / 能量栅格不能超、槽位够用）检查结果；不满足就调整后再算，直到满足或确认做不到。
  auto_fit 的最佳方案会自动展示；用 compute_fit 自己算出的装配，满意后要调用 show_fit 展示给玩家（玩家可以一键在装配页打开），回答里简要说明思路和关键属性。没有特别说明时按全 5 级技能算。
  击杀记录里有完整装配：玩家问实战里怎么配、击杀记录里有没有达到某指标的装配时用 kb_ship_fits（kb_kills 只有击杀概况，不含装配）。
  常识：加力燃烧器（Afterburner）有 1MN / 10MN / 100MN，微型跃迁推进器（Microwarpdrive）有 5MN / 50MN / 500MN。
- 角色：玩家可能在本站绑定了多个角色。「我的号 / 我哪个号…」先用 my_character 看有哪些角色，能不能开船用 my_characters_fly（会检查全部角色）；
  「找个 / 买个能开 X 的号」是在角色交易里找在售角色，用 bazaar_search。意思不清时两样都查，分开说明。
- 价格预估：用 market_history 看走势（成交均价、成交量、近期变化），结合游戏常识给出判断，并说明这只是参考。
- 角色数据（资产、技能、钱包、订单、工业等）：用 my_character / esi_get；玩家没绑定 ESI 时请他去「个人中心」绑定。
- 本站各页面的功能都有对应工具：路线 / 跳跃规划、制造成本与利润、LP 兑换、行星工业、虫洞、估价、合同、快递、倒卖、势力战争、主权规划（星系资源、升级件能否上线、劳动力运输、我的主权中心燃料）、教程、广场、人物情报等，能用工具算的就直接算，不要只给链接。
  结果里有 page_link 时，回答末尾附上「在本站打开」的链接，方便玩家看完整页面。
- 你只能查询，不能替玩家在游戏里做任何操作。工具真的覆盖不到的（如深渊装备估价），告诉玩家本站哪个页面能做并给出链接。
- 本站页面（回答里可以写成 Markdown 链接，点击直接打开）：
  市场中心（顶部第一项）：物品价格、订单、历史、自选，单个物品用 [名称](#type=物品ID)；[倒卖排行](#arb)：交易中心之间的差价利润；
  [星图](#map)：路线规划、星系信息、跳跃距离与疲劳、强爆热点；[击杀](#kb)：击杀记录、会战战报、人物 / 军团 / 联盟统计、排行；
  [装配](#fit)：模拟装配与属性、智能装配、击杀记录装配、广场装配；[战场模拟](#sim)：两支舰队按装配模拟交战；
  [行星工业](#pi)：行星开发规划与收益；[制造](#ind)：蓝图制造 / 发明成本与利润、我的工业任务；[LP 商店](#lp)：忠诚点兑换收益；
  [估价](#appr)：粘贴物品清单估价；[快递合同](#courier)；[合同](#contracts)：公开合同查询；[战争](#war)：势力战争与军团战争；
  [主权](#sov)：主权规划；[深渊装备](#abyss)：深渊装备市场与估价；[角色交易](#bazaar)：买卖角色；
  [虫洞](#wh)：虫洞星系、类型、天象、质量计算、席拉连接；[广场](#plaza)：军团招新、组队、集市；[教程](#guide)；
  个人中心（右上角）：绑定 ESI 角色（可多个）、资产、钱包、订单、技能、行星、挖矿等角色数据。
- 回答用玩家的语言，简洁，用 Markdown（列表、表格、粗体）。提到物品时可以写成 [名称](#type=物品ID) 的链接，点击会打开市场页。"""


def _ai_obj(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


_S = lambda d: {"type": "string", "description": d}
_I = lambda d: {"type": "integer", "description": d}
AI_TOOLS = [
    ("search_items", "按名称搜索物品 / 舰船 / 装备 / 弹药 / 无人机（中文或英文，支持部分名称），返回物品 ID、名称、分组。不确定准确名称时先搜。",
     _ai_obj({"query": _S("名称或关键词"), "kind": {"type": "string", "enum": ["any", "ship", "module", "charge", "drone", "implant"], "description": "类别，默认 any"},
              "limit": _I("最多返回几条，默认 15")}, ["query"])),
    ("compute_fit", "用本站装配引擎（与游戏规则一致）计算一套装配的属性：DPS、EHP、抗性、电容、速度、锁定、CPU / 能量栅格占用、问题提示。"
                    "eft 为 EFT 文本：第一行 [舰船名, 装配名]，之后按 低槽、中槽、高槽、改装件 分段（空行隔开），每行一个装备，"
                    "「装备名, 弹药名」表示装弹，「无人机名 x5」表示无人机，行尾加 /offline 表示离线。装备名中英文都行。"
                    "推进器、主动坦克等可激活的装备默认开启（速度就是开着推进器时的速度）。返回 fit_id，用于 show_fit。",
     _ai_obj({"eft": _S("EFT 格式的装配文本"), "skills": {"type": "string", "enum": ["max", "character"], "description": "技能：max 全 5 级（默认），character 按玩家已绑定角色的技能"}}, ["eft"])),
    ("auto_fit", "本站「智能装配」：按要求自动搜索整套装配（与游戏规则一致的装配引擎逐个试装，保证 CPU / 能量栅格 / 槽位装得下），"
                 "返回最好的 1–3 种方案（各带 fit_id 和属性），最好的方案会自动以卡片展示给玩家（不用再调用 show_fit）。"
                 "玩家给了要求（必装某装备、速度 / DPS / EHP 下限、侧重）时直接用它，比自己写 EFT 试错快得多；"
                 "结果不满意再用 compute_fit 微调。搜索在玩家浏览器里进行，可能要十几秒。",
     _ai_obj({"ship": _S("舰船名"), "required_modules": {"type": "array", "items": {"type": "string"}, "description": "必装的装备名（如 100MN Afterburner II），会先装好、不被替换"},
              "focus": {"type": "array", "items": {"type": "string", "enum": ["dps", "tank", "speed"]}, "description": "侧重，可多选，默认 dps"},
              "min_speed": {"type": "number", "description": "最低速度 m/s（推进器开启时）"}, "min_dps": {"type": "number", "description": "最低 DPS"},
              "min_ehp": {"type": "number", "description": "最低 EHP"}, "cap_stable": {"type": "boolean", "description": "要求电容稳定"},
              "weapon": {"type": "string", "enum": ["auto", "turret", "missile", "drone", "none"], "description": "武器类型，默认 auto"},
              "tank": {"type": "string", "enum": ["auto", "shield", "armor"], "description": "坦克类型，默认 auto"},
              "meta": {"type": "string", "enum": ["t1", "t2", "faction", "deadspace", "officer"], "description": "最高装备等级，默认 t2"},
              "budget_million": {"type": "number", "description": "装备预算（百万 ISK，不含船），0 不限"},
              "utilities": {"type": "array", "items": {"type": "string", "enum": ["point", "scram", "web", "neut", "cyno", "ewar"]}, "description": "功能装备：扰断、扰频、停滞网、中和、诱导、电子战；不填按舰船加成自动选"},
              "skills": {"type": "string", "enum": ["max", "character"]}}, ["ship"])),
    ("kb_ship_fits", "击杀记录里某型舰船最近阵亡时的实际装配（来自完整击杀邮件，相同装配合并），逐套用装配引擎算出速度、DPS、EHP 等"
                     "（全 5 级技能、推进器开启（装了多个时只开一个），不含植入体和超载），可按最低速度 / DPS / EHP 筛选并排序，第一套会自动以卡片展示。"
                     "玩家问实战里怎么配、击杀记录里有没有达到某指标的装配、参考别人的配法时用。",
     _ai_obj({"ship": _S("舰船名"), "days": _I("最近几天，默认 30"),
              "with_modules": {"type": "array", "items": {"type": "string"}, "description": "只看装了这些装备的装配（名称可不写型号，如 100MN Afterburner；推进装备会按它开启计算）"},
              "min_speed": {"type": "number", "description": "最低速度 m/s"},
              "min_dps": {"type": "number", "description": "最低 DPS"}, "min_ehp": {"type": "number", "description": "最低 EHP"},
              "sort": {"type": "string", "enum": ["count", "speed", "dps", "ehp"], "description": "排序：出现次数（默认）、速度、DPS、EHP"},
              "limit": _I("最多返回几套，默认 8")}, ["ship"])),
    ("show_fit", "把 compute_fit 算过的装配作为卡片展示给玩家，带「在装配页打开」按钮。auto_fit / kb_ship_fits 的第一套已自动展示，不用再调用；要展示其他方案时用。",
     _ai_obj({"fit_id": _S("compute_fit / auto_fit / kb_ship_fits 返回的 fit_id"), "title": _S("卡片标题，如「100MN 镰刀 · 2100 m/s」")}, ["fit_id"])),
    ("market_price", "物品当前价格：主交易中心（默认吉他）最低卖价 / 最高收价，以及全服均价。",
     _ai_obj({"items": {"type": "array", "items": {"type": "string"}, "description": "物品名称或 ID，最多 20 个"}}, ["items"])),
    ("market_history", "物品在某星域的每日成交历史（ESI）：近 7 / 30 / 90 天成交均价、最高 / 最低、日均成交量、涨跌幅和每周均价序列，用于判断走势、预估价格。",
     _ai_obj({"item": _S("物品名称或 ID"), "region": _S("星域名，默认主交易中心所在星域（如伏尔戈）"), "days": _I("看最近多少天，默认 90，最多 365")}, ["item"])),
    ("kb_battles", "本站收录的疑似会战（同一星系短时间内大量击毁）：时间、星系、击毁数、总损失、参战人数和双方阵营。时间是 UTC。",
     _ai_obj({"days": _I("最近几天，默认 2，最多 30"), "region": _S("只看某星域（可选）"), "min_kills": _I("最少击毁数（可选）"), "limit": _I("最多返回几场，默认 10")})),
    ("kb_kills", "查询本站收录的击杀记录（可组合筛选），返回最近的击杀：时间、星系、受害者舰船 / 人物 / 军团、价值、攻击者数（不含装配；要看装配用 kb_ship_fits）。",
     _ai_obj({"system": _S("星系名"), "region": _S("星域名"), "character": _S("人物名"), "corporation": _S("军团名"), "alliance": _S("联盟名"),
              "side": {"type": "string", "enum": ["all", "kills", "losses"], "description": "配合人物 / 军团 / 联盟：击杀还是损失"},
              "ship": _S("受害者舰船名"), "min_value": {"type": "number", "description": "最低价值（ISK）"},
              "space": {"type": "string", "enum": ["k", "wh", "abyss"], "description": "k 常规空间、wh 虫洞、abyss 深渊"},
              "solo": {"type": "boolean", "description": "只看单刷"}, "limit": _I("最多返回几条，默认 15，最多 50")})),
    ("kb_entity", "人物 / 军团 / 联盟最近的击杀统计：击杀与损失数量和价值、常开舰船、活跃星系、活跃时段。",
     _ai_obj({"name": _S("人物 / 军团 / 联盟名"), "kind": {"type": "string", "enum": ["any", "character", "corporation", "alliance"]}, "days": _I("最近几天，默认 30")}, ["name"])),
    ("gank_risk", "高安星系的疑似强爆统计：次数、出现强爆的天数比例、最危险的时段、主要强爆团伙。不带星系时返回强爆最多的高安星系。",
     _ai_obj({"system": _S("高安星系名（可选）"), "days": _I("7 / 30 / 90，默认 30")})),
    ("route_plan", "星门路线规划（与星图「路线规划」同一数据）：起点到终点的跳数、每个星系的安全等级与星域、高安强爆热点，"
                   "可加途经点（自动排最短顺序）、选最短 / 只走高安 / 少走高安、避开强爆热点。不填起点时用玩家角色当前位置。",
     _ai_obj({"from": _S("起点星系（可选，默认角色当前位置）"), "to": _S("终点星系"), "via": {"type": "array", "items": {"type": "string"}, "description": "途经星系（可选）"},
              "prefer": {"type": "string", "enum": ["shortest", "secure", "insecure"], "description": "shortest 最短（默认）、secure 只走高安、insecure 少走高安"},
              "avoid_gank": {"type": "boolean", "description": "避开高安强爆热点"}, "auto_order": {"type": "boolean", "description": "途经点自动排最短顺序（默认是）"},
              "character": _S("用哪个角色的当前位置作起点（可选）")}, ["to"])),
    ("jump_plan", "旗舰 / 跳货 / 黑隐等的跳跃规划（与星图「跳跃规划」同一算法）：按舰船跳跃距离和角色技能算逐跳光年、燃料用量与估价、跳跃冷却与疲劳、总耗时。"
                  "不填起点时用角色当前位置。",
     _ai_obj({"ship": _S("能跳跃的舰船名（如 渡神级 / Rhea / 夜神级 / 黑隐特勤舰名）"), "from": _S("起点星系（可选）"), "to": _S("终点星系"),
              "skills": {"type": "string", "enum": ["character", "max"], "description": "跳跃技能：character 按角色（默认，读不到时按全 5 级），max 全 5 级"},
              "character": _S("哪个角色（可选）"), "gates": {"type": "boolean", "description": "允许途中走星门（默认只跳跃）"}}, ["ship", "to"])),
    ("industry_cost", "制造 / 反应成本与利润（与本站「制造」计算器同一公式，技能全 5 级）：材料清单与价格、工作费、发明成本、总成本、单件成本、售价、利润、利润率、每小时利润。",
     _ai_obj({"product": _S("产品名或 ID（中英文都行）"), "runs": _I("流程数，默认 1"), "me": _I("材料效率（默认：能发明的按发明蓝图，否则 10）"), "te": _I("时间效率"),
              "system": _S("制造星系（默认吉他）"), "facility": {"type": "string", "enum": ["npc", "raitaru", "azbel", "sotiyo", "athanor", "tatara"], "description": "设施，默认 NPC 空间站"},
              "rig": _I("改装件 0 / 1（T1）/ 2（T2）"), "tax": {"type": "number", "description": "设施税 %"},
              "materials": {"type": "string", "enum": ["sell", "buy"], "description": "材料按卖价（默认）或收价买"}, "sell": {"type": "string", "enum": ["sell", "buy"], "description": "产品按卖价（默认）或收价卖"},
              "invention": {"type": "boolean", "description": "T2 计入发明成本（默认是）"}, "decryptor": _S("发明用的解码器（可选）")}, ["product"])),
    ("industry_profits", "制造 / 反应利润排行（与「制造」页利润排行同一数据）：按每小时利润 / 每流程利润 / 利润率排序。",
     _ai_obj({"activity": {"type": "string", "enum": ["manufacturing", "reaction"]}, "category": {"type": "string", "enum": ["all", "ship", "module", "charge", "drone", "component", "structure", "implant"]},
              "tech": {"type": "string", "enum": ["all", "1", "2", "3"]}, "sort": {"type": "string", "enum": ["profit_per_hour", "profit", "margin"]}, "limit": _I("默认 15"),
              "system": _S("制造星系"), "facility": _S("设施"), "rig": _I("改装件 0/1/2")})),
    ("industry_systems", "工业系统成本指数最低的星系（制造、发明、反应、拷贝、研究），可按安全等级和星域筛选。",
     _ai_obj({"activity": {"type": "string", "enum": ["manufacturing", "invention", "reaction", "copying", "researching_material_efficiency", "researching_time_efficiency"]},
              "security": _S("high / low / null，可逗号多选"), "region": _S("星域名（可选）"), "limit": _I("默认 15")})),
    ("lp_offers", "LP 商店兑换收益（与「LP 商店」页同一公式）：每 LP 能换多少 ISK，按 ISK/LP 从高到低。不填军团时在全部 LP 商店里找最好的。",
     _ai_obj({"corp": _S("NPC 军团名或势力名（可选）"), "item": _S("只看某个兑换物（可选）"), "limit": _I("默认 10"), "tax": {"type": "number", "description": "卖出税费 %，默认 3.4"}, "include_blueprints": {"type": "boolean", "description": "包含蓝图兑换项（默认不含）"}})),
    ("pi_info", "行星工业产品：等级、生产配方（输入、周期、产出）、交易中心价格、买原料加工的利润、所需原料能在哪些行星类型采集；page_link 可在「行星工业」页直接算整条链的日收益。",
     _ai_obj({"product": _S("行星产品名（P0–P4，中英文都行）")}, ["product"])),
    ("pi_colonies", "读取玩家（全部已绑定角色或指定角色）的行星殖民地：所在星系、行星类型、等级、采集器数量和到期时间（已停的）、在产什么。",
     _ai_obj({"character": _S("只看某个角色（可选）")})),
    ("wormhole_info", "虫洞：虫洞星系（等级、天象效果、固定洞及其去向 / 质量 / 寿命 / 能过的船、近 30 天击杀与活跃军团）、虫洞类型代码（如 H296）的数据、席拉 / 图尔努尔当前连接（欧服）。",
     _ai_obj({"system": _S("虫洞星系名如 J123456（可选）"), "wh_type": _S("虫洞类型代码（可选）"), "thera": {"type": "boolean", "description": "查席拉 / 图尔努尔连接"}})),
    ("sov_system", "主权星系资源（与「主权规划」页同一份 SDE 数据）：恒星电力、各行星装天钩能给的电力（气体 / 风暴 / 等离子）/ 劳动力（温和 / 贫瘠 / 海洋）/ 试剂（冰体出超离子冰、熔岩出岩浆气），当前主权联盟与军事 / 工业 / 战略等级。"
     "给 region 时列出星域内星系并按电力 / 劳动力 / 试剂排序（找适合装某升级件的星系）。",
     _ai_obj({"system": _S("星系名（可选）"), "systems": {"type": "array", "items": {"type": "string"}, "description": "多个星系（可选）"}, "region": _S("星域名（可选，给了就按星域排序）"),
              "sort": {"type": "string", "enum": ["power", "workforce", "ice", "gas"], "description": "星域排序，默认 power"}, "limit": _I("星域模式返回几个，默认 15")})),
    ("sov_upgrades", "全部主权中心升级件：耗电、劳动力、电力 / 劳动力产出、燃料种类、每小时消耗和启动燃料、互斥组，以及电力 / 劳动力 / 运输规则。",
     _ai_obj({})),
    ("sov_plan", "主权规划（与「主权规划」页的一键规划同一套规则）：给若干星系和各自要装的升级件（按优先级排列），算每个星系电力 / 劳动力是否够、哪些升级件能上线、燃料消耗。"
     "auto=true（默认）时自动补电力监控部门 / 劳动力机械工具，并在规划的星系间沿星门安排劳动力导出 / 导入 / 中转（同联盟，每个星系最多 3 个来源）。"
     "save_to_page=true 时把规划写入本站主权规划页（玩家要你保存或想在页面上继续调整时用）。",
     _ai_obj({"systems": {"type": "array", "description": "要规划的星系", "items": {"type": "object", "properties": {
                  "system": _S("星系名"), "upgrades": {"type": "array", "items": {"type": "string"}, "description": "升级件名（中英文都行，如 超级旗舰建造设施、Cynosural Suppression、三钛合金勘探阵列3），按优先级排列"},
                  "skyhooks_off": {"type": "array", "items": {"type": "string"}, "description": "不装天钩的行星（序号或罗马数字，如 VII），默认全装"}},
                  "required": ["system"], "additionalProperties": False}},
              "auto": {"type": "boolean", "description": "自动补产出件并安排劳动力运输，默认 true"}, "save_to_page": {"type": "boolean", "description": "写入主权规划页，默认 false"}}, ["systems"])),
    ("sov_my_hubs", "读取玩家当前角色所在军团的主权中心和天钩（ESI，宁静服，需军团董事 / 站点经理等职位）：各星系电力 / 劳动力分配、升级件及上线状态、燃料仓剩余可烧多久、劳动力运输设置、易损窗口；天钩是否在产出、试剂库存。",
     _ai_obj({"refresh": {"type": "boolean", "description": "重新从 ESI 读取（默认用已读的）"}})),
    ("appraise", "估价：粘贴的物品清单（游戏里复制的资产 / 合同 / 货柜内容，每行「名称 数量」）按交易中心最低卖价、最高收价合计。",
     _ai_obj({"text": _S("物品清单原文")}, ["text"])),
    ("contracts_search", "公开合同（本站收录的合同存档）：按物品、关键词、类型、星域、价格筛选；可看在售、已成交、已过期。查某物品的合同价、找便宜的船 / 装备时用。",
     _ai_obj({"item": _S("包含的物品（可选）"), "q": _S("标题关键词（可选）"), "type": {"type": "string", "enum": ["item_exchange", "auction", "courier"]}, "region": _S("星域（可选）"),
              "status": {"type": "string", "enum": ["open", "done", "expired", "ended", "all"], "description": "默认 open 在售"}, "min_price": {"type": "number"}, "max_price": {"type": "number"},
              "sort": {"type": "string", "enum": ["issued", "ended", "expires", "price", "value", "ratio", "volume"]}, "order": {"type": "string", "enum": ["asc", "desc"]},
              "want": {"type": "boolean", "description": "收购合同（对方要物品）"}, "limit": _I("默认 15")})),
    ("courier_contracts", "快递合同（跑货）：按每跳报酬排序，含起点到取货点的跳数、体积、抵押金。",
     _ai_obj({"from": _S("玩家所在星系（可选，用来算取货跳数）"), "region": _S("只看某星域（可选）"), "max_volume": {"type": "number", "description": "最大体积 m³"},
              "min_reward": {"type": "number"}, "max_collateral": {"type": "number"}, "limit": _I("默认 15")})),
    ("hub_arbitrage", "交易中心倒卖（与「倒卖排行」同一数据）：五大交易中心之间的差价机会，按可做的总利润排序。",
     _ai_obj({"mode": {"type": "string", "enum": ["instant", "sell_order"], "description": "instant 即买即卖（默认），sell_order 到卖出地挂单"},
              "min_daily_volume": _I("卖出地最低日成交量，默认 10"), "max_unit_price": {"type": "number", "description": "单价上限（可选）"}, "limit": _I("默认 15")})),
    ("faction_warfare", "势力战争现状：各势力人数、控制星系数、昨天 / 上周击杀与胜利点、可被夺取的星系。", _ai_obj({})),
    ("guides_search", "搜索本站教程（文字与视频）。新手问怎么玩、某玩法怎么入门时用。", _ai_obj({"q": _S("关键词（可选，不填列出全部）")})),
    ("guide_read", "读取一篇文字教程的正文。", _ai_obj({"id": _S("guides_search 返回的 id")}, ["id"])),
    ("plaza_search", "本站广场：军团招新、组队、集市、装配分享、其他帖子。", _ai_obj({"kind": {"type": "string", "enum": ["recruit", "fleet", "market", "fit", "other"]}, "q": _S("关键词（可选）"), "limit": _I("默认 15")})),
    ("pilot_intel", "人物情报（与「本地扫描」同一数据）：一批人物的军团 / 联盟、近 30 天击杀 / 损失、单挑、平均同伙人数、常用船、最近活跃。玩家贴本地频道名单问危险吗时用。",
     _ai_obj({"names": {"type": "array", "items": {"type": "string"}, "description": "人物名（最多 100 个）"}}, ["names"])),
    ("my_character", "玩家在本站绑定（ESI）的角色：不填 character 时列出全部已绑定角色的概况（名字、军团、联盟、钱包、位置、当前舰船、技能点，current 为当前选中的角色）；"
                     "玩家说「我的号 / 我的角色」时指的是这些角色，可能有多个。没有绑定时返回提示。",
     _ai_obj({"character": _S("只看某个角色（名字或 ID，可选）")})),
    ("my_characters_fly", "逐个检查玩家所有已绑定角色能不能开某艘船 / 某船级（如泰坦、无畏舰）/ 用某装备、某技能够不够几级，"
                          "按完整技能前置链判断；不能的给出还差哪些技能、差多少技能点、按角色属性要练多久。「我哪个号能开 X」「X 还要练多久」用它。",
     _ai_obj({"ship": _S("舰船名、船级名（泰坦、超级航母、无畏舰、航空母舰、战力辅助舰、黑隐特勤舰、掠夺舰…）或装备名"),
              "skills": {"type": "array", "items": {"type": "object", "properties": {"name": _S("技能名"), "level": _I("等级 1–5")}, "required": ["name"]}, "description": "另外要求的技能等级（可选）"}})),
    ("bazaar_search", "本站「角色交易」：搜索在售的角色（买号）。宁静服来自官方论坛 Character Bazaar（ISK 报价，按卖家贴的 qsna.eu 技能展示判断技能），"
                      "晨曦服来自网易藏宝阁（人民币），曙光服是玩家在本站自挂。price 的单位见结果里的 currency。可按能开某船 / 船级 / 用某装备、技能等级、技能点、价格筛选。"
                      "玩家说「找个能开 X 的号」「买个号」时用它；结果里的 link 是本站详情页。",
     _ai_obj({"can_fly": _S("能开的舰船名、船级名（如泰坦）或能用的装备名（可选）"),
              "skills": {"type": "array", "items": {"type": "object", "properties": {"name": _S("技能名"), "level": _I("等级 1–5")}, "required": ["name"]}, "description": "技能等级要求（可选）"},
              "min_sp_million": {"type": "number", "description": "最少技能点（百万）"}, "max_sp_million": {"type": "number", "description": "最多技能点（百万）"},
              "max_price": {"type": "number", "description": "最高价格：宁静按十亿 ISK（填 60 即 60B），晨曦 / 曙光按人民币元"},
              "sort": {"type": "string", "enum": ["price", "sp", "newest"], "description": "排序：价格从低到高（默认）、技能点从高到低、最新"},
              "limit": _I("最多返回几个，默认 10")})),
    ("esi_get", "用玩家的 ESI 授权读取角色数据（只读 GET）。path 例：/characters/{character_id}/assets/、/skills/、/skillqueue/、/wallet/journal/、"
                "/wallet/transactions/、/orders/、/industry/jobs/、/contracts/、/blueprints/、/mining/、/implants/、/clones/、/loyalty/points/、"
                "/killmails/recent/、/fittings/、/planets/、/standings/。{character_id} 会自动替换。结果里的 type_id 会附上中文名。"
                "结果很多时（如资产）用 search 按物品名过滤，或用 summary 按物品汇总数量并附估价（全服均价与交易中心卖价，按价值从高到低）。",
     _ai_obj({"path": _S("ESI 路径"), "character": _S("读哪个已绑定角色（名字或 ID，默认当前角色；多个角色时逐个调用）"), "search": _S("按物品 / 技能名过滤（中英文都行，可选）"), "summary": {"type": "boolean", "description": "按物品汇总数量（资产等列表）"},
              "limit": _I("最多返回几条，默认 50，最多 200")}, ["path"])),
]
AI_TOOL_NAMES = {t[0] for t in AI_TOOLS}


def ai_site_conf():
    key = (os.environ.get("EVE_AI_KEY") or "").strip()
    base = (os.environ.get("EVE_AI_BASE") or "").strip()
    if not key or not base:
        return None
    return {"proto": (os.environ.get("EVE_AI_PROTO") or "openai-chat").strip(), "base": base, "key": key, "model": (os.environ.get("EVE_AI_MODEL") or "").strip()}


def _ai_clean(v, limit):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v if isinstance(v, str) else "")[:limit]


def ai_messages(raw):
    """校验网页带来的对话（与协议无关的格式）"""
    if not isinstance(raw, list) or not 0 < len(raw) <= AI_MSG_MAX:
        raise ValueError("对话太长了，请点「新对话」重新开始")
    out = []
    for m in raw:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant", "tool"):
            raise ValueError("对话格式不对")
        if m["role"] == "user":
            text = _ai_clean(m.get("text"), AI_TEXT_MAX).strip()
            if text:
                out.append({"role": "user", "text": text})
        elif m["role"] == "tool":
            out.append({"role": "tool", "id": _ai_clean(m.get("id"), 200), "name": _ai_clean(m.get("name"), 64), "text": _ai_clean(m.get("text"), AI_TEXT_MAX) or "（空）"})
        else:
            calls = []
            for c in m.get("calls") or []:
                if isinstance(c, dict) and c.get("id") and c.get("name") in AI_TOOL_NAMES:
                    calls.append({"id": _ai_clean(c["id"], 200), "name": c["name"], "args": c.get("args") if isinstance(c.get("args"), dict) else {}})
            raw_ = m.get("raw") if isinstance(m.get("raw"), dict) else None
            out.append({"role": "assistant", "text": _ai_clean(m.get("text"), AI_TEXT_MAX), "calls": calls, "raw": raw_})
    if not out or out[0]["role"] != "user":
        raise ValueError("对话格式不对")
    # 工具调用与结果必须成对：没有结果的调用补一条「已取消」
    fixed = []
    for i, m in enumerate(out):
        fixed.append(m)
        if m["role"] == "assistant" and m["calls"]:
            have = {x["id"] for x in out[i + 1:] if x["role"] == "tool"}
            for c in m["calls"]:
                if c["id"] not in have:
                    fixed.append({"role": "tool", "id": c["id"], "name": c["name"], "text": "（已取消）"})
    return fixed


def ai_system(ctx):
    ctx = ctx if isinstance(ctx, dict) else {}
    lines = [AI_SYSTEM, "", "当前情况："]
    lines.append("- 现在是 UTC " + time.strftime("%Y-%m-%d %H:%M", time.gmtime()) + (f"（玩家所在时区 UTC{_ai_clean(ctx.get('tz'), 8)}）" if ctx.get("tz") else ""))
    srv = {"tq": "欧服（宁静 Tranquility）", "serenity": "国服晨曦（Serenity）", "infinity": "国服曙光（Infinity）"}.get(ctx.get("server"), "")
    if srv:
        lines.append("- 服务器：" + srv)
    char = _ai_clean(ctx.get("character"), 80)
    chars = [_ai_clean(x, 80) for x in (ctx.get("characters") or [])[:30] if isinstance(x, str)] if isinstance(ctx.get("characters"), list) else []
    if len(chars) > 1:
        lines.append(f"- 玩家在本站绑定了 {len(chars)} 个 ESI 角色：{'、'.join(chars)}（当前选中：{char or chars[0]}）")
    else:
        lines.append(f"- 玩家已绑定 ESI 角色：{char}" if char else "- 玩家还没有绑定 ESI 角色（读取角色数据的工具用不了）")
    if ctx.get("lang") == "en":
        lines.append("- 网页是英文界面：请用英文回答，名称用英文。")
    return "\n".join(lines)


def _ai_args(s):
    if isinstance(s, dict):
        return s
    try:
        v = json.loads(s or "{}")
        return v if isinstance(v, dict) else {"_raw": str(s)[:2000]}
    except ValueError:
        return {"_raw": str(s)[:2000]}


def ai_call(conf, path, body, on_text):
    return llm_stream(conf, path, {**body, "stream": True}, on_text, AI_TIMEOUT) if on_text else llm_http(conf, "POST", path, body, AI_TIMEOUT)


def ai_step(conf, system, msgs, on_text=None):
    """调用上游一次，返回 {text, calls, raw, stop, usage}；on_text 不为空时流式调用，文字增量逐段交给它"""
    proto, model = conf["proto"], conf["model"]
    same = lambda m: m.get("raw") and m["raw"].get("proto") == proto and m["raw"].get("data") is not None
    if proto == "anthropic":
        tools = [{"name": n, "description": d, "input_schema": p} for n, d, p in AI_TOOLS]
        out = []
        for m in msgs:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["text"]})
            elif m["role"] == "tool":
                block = {"type": "tool_result", "tool_use_id": m["id"], "content": m["text"]}
                if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) and out[-1]["content"] and out[-1]["content"][0].get("type") == "tool_result":
                    out[-1]["content"].append(block)
                else:
                    out.append({"role": "user", "content": [block]})
            else:
                if same(m) and isinstance(m["raw"]["data"], list):
                    content = m["raw"]["data"]
                else:
                    content = ([{"type": "text", "text": m["text"]}] if m["text"] else []) + [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]} for c in m["calls"]]
                out.append({"role": "assistant", "content": content or [{"type": "text", "text": "…"}]})
        res = ai_call(conf, "/messages", {"model": model, "max_tokens": AI_MAX_TOKENS, "system": system, "messages": out, "tools": tools}, on_text)
        res = res if isinstance(res, dict) else {}
        blocks = [b for b in res.get("content") or [] if isinstance(b, dict)]
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        calls = [{"id": b.get("id"), "name": b.get("name"), "args": b.get("input") if isinstance(b.get("input"), dict) else {}} for b in blocks if b.get("type") == "tool_use"]
        stop = res.get("stop_reason")
        if stop == "refusal":
            raise LlmError("模型拒绝回答这个问题")
        return {"text": text, "calls": calls, "raw": {"proto": proto, "data": blocks}, "stop": stop, "usage": res.get("usage")}
    if proto == "openai-responses":
        tools = [{"type": "function", "name": n, "description": d, "parameters": p} for n, d, p in AI_TOOLS]
        items = []
        for m in msgs:
            if m["role"] == "user":
                items.append({"role": "user", "content": m["text"]})
            elif m["role"] == "tool":
                items.append({"type": "function_call_output", "call_id": m["id"], "output": m["text"]})
            elif same(m) and isinstance(m["raw"]["data"], list):
                items += m["raw"]["data"]
            else:
                if m["text"]:
                    items.append({"role": "assistant", "content": m["text"]})
                items += [{"type": "function_call", "call_id": c["id"], "name": c["name"], "arguments": json.dumps(c["args"], ensure_ascii=False)} for c in m["calls"]]
        res = ai_call(conf, "/responses", {"model": model, "instructions": system, "input": items, "tools": tools, "store": False,
                                           "max_output_tokens": AI_MAX_TOKENS}, on_text)
        res = res if isinstance(res, dict) else {}
        output = [o for o in res.get("output") or [] if isinstance(o, dict)]
        text = "".join(c.get("text", "") for o in output if o.get("type") == "message" for c in o.get("content") or [] if isinstance(c, dict) and c.get("type") in ("output_text", "text"))
        calls = [{"id": o.get("call_id"), "name": o.get("name"), "args": _ai_args(o.get("arguments"))} for o in output if o.get("type") == "function_call"]
        # 回传时只留消息和工具调用，去掉服务器端 id（store=false 时上游不认；推理内容没有加密副本，不能回传）
        keep = [{k: v for k, v in o.items() if k not in ("id", "status")} for o in output if o.get("type") in ("message", "function_call")]
        return {"text": text, "calls": calls, "raw": {"proto": proto, "data": keep}, "stop": res.get("status"), "usage": res.get("usage")}
    tools = [{"type": "function", "function": {"name": n, "description": d, "parameters": p}} for n, d, p in AI_TOOLS]
    out = [{"role": "system", "content": system}]
    for m in msgs:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["text"]})
        elif m["role"] == "tool":
            out.append({"role": "tool", "tool_call_id": m["id"], "content": m["text"]})
        else:
            msg = {"role": "assistant", "content": m["text"] or None}
            if m["calls"]:
                msg["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"], ensure_ascii=False)}} for c in m["calls"]]
            if same(m) and isinstance(m["raw"]["data"], dict) and isinstance(m["raw"]["data"].get("reasoning_content"), str):
                msg["reasoning_content"] = m["raw"]["data"]["reasoning_content"]   # DeepSeek 等思考模式调用工具时要求回传
            out.append(msg)
    res = ai_call(conf, "/chat/completions", {"model": model, "messages": out, "tools": tools, "max_tokens": AI_MAX_TOKENS}, on_text)
    res = res if isinstance(res, dict) else {}
    choice = (res.get("choices") or [{}])[0] or {}
    msg = choice.get("message") or {}
    c = msg.get("content")
    text = c if isinstance(c, str) else "".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
    calls = [{"id": t.get("id"), "name": (t.get("function") or {}).get("name"), "args": _ai_args((t.get("function") or {}).get("arguments"))}
             for t in msg.get("tool_calls") or [] if isinstance(t, dict)]
    raw = {"reasoning_content": msg["reasoning_content"]} if isinstance(msg.get("reasoning_content"), str) else {}
    return {"text": text, "calls": calls, "raw": {"proto": proto, "data": raw}, "stop": choice.get("finish_reason"), "usage": res.get("usage")}


class Assistant:
    def __init__(self):
        self.daily = int(os.environ.get("EVE_AI_DAILY") or 200)
        self.total = int(os.environ.get("EVE_AI_TOTAL") or 5000)
        self.used, self.day, self.sum, self.lock = {}, "", 0, threading.Lock()
        site = ai_site_conf()
        self.site_model = site["model"] if site else ""
        if site:
            log.info("AI 助手：本站模型 %s（%s），每个 IP 每天 %d 次", site["model"], site["proto"], self.daily)

    @staticmethod
    def who(ip):
        """额度按 IP 计；IPv6 按 /64"""
        try:
            a = ipaddress.ip_address(ip)
            return str(ipaddress.ip_network(f"{ip}/64", strict=False)) if a.version == 6 else ip
        except ValueError:
            return ip

    def _roll(self):
        d = time.strftime("%Y-%m-%d", time.gmtime())
        if d != self.day:
            self.day, self.used, self.sum = d, {}, 0

    def info(self, ip):
        with self.lock:
            self._roll()
            left = max(0, self.daily - self.used.get(self.who(ip), 0)) if self.sum < self.total else 0
        return {"site": bool(ai_site_conf()), "model": self.site_model, "daily": self.daily, "left": left}

    def chat(self, body, ip, on_text=None):
        msgs = ai_messages(body.get("messages"))
        own = body.get("llm")
        if own:
            conf = llm_conf(own)
            if not conf["model"]:
                raise ValueError("请先选择模型")
        else:
            site = ai_site_conf()
            if not site:
                raise ValueError("本站还没有配置 AI 模型，可以在「设置」里填自己的接口")
            conf = llm_conf(site)
            with self.lock:
                self._roll()
                k = self.who(ip)
                if self.sum >= self.total:
                    raise LlmError("今天全站的 AI 额度已经用完了，明天再来，或在「设置」里填自己的接口")
                if self.used.get(k, 0) >= self.daily:
                    raise LlmError(f"今天的 {self.daily} 次额度已经用完了（UTC 0 点重置），也可以在「设置」里填自己的接口")
                self.used[k] = self.used.get(k, 0) + 1
                self.sum += 1
        try:
            res = ai_step(conf, ai_system(body.get("ctx")), msgs, on_text)
        except Exception:
            if not own:   # 上游出错不算次数
                with self.lock:
                    k = self.who(ip)
                    self.used[k] = max(0, self.used.get(k, 0) - 1)
                    self.sum = max(0, self.sum - 1)
            raise
        res["calls"] = [c for c in res["calls"] if c.get("id") and c.get("name")]
        if not own:
            with self.lock:
                res["left"] = max(0, self.daily - self.used.get(self.who(ip), 0))
        if len(json.dumps(res["raw"], ensure_ascii=False)) > 200_000:
            res["raw"] = None
        res.pop("usage", None)
        return res


# ---------------------------------------------------------------- 工单 / 反馈
# 右上角「定制」里提交：问题类型 + 内容 + 可选联系方式，存进 feedback 表（不记 IP）；按 IP 限流并限每日条数。
# 提交时返回一个随机凭证（库里只存哈希），浏览器记下 id + 凭证，用来查看自己的工单历史、处理状态和站长回复。
# 站长：设环境变量 EVE_FEEDBACK_ADMIN_IPS=<IP 或网段，逗号分隔>，从这些 IP 访问时网页「定制」里出现「工单管理」，
# 可查看全部工单、回复、改状态（管理接口只认这些 IP；依赖 nginx 设置 X-Real-IP，否则可被伪造）；
# 也可以用命令行 --feedback N（列出）/ --feedback-reply ID 文字 [--feedback-done]（回复）
FEEDBACK_KINDS = {"bug": "功能出错", "data": "数据不对", "feature": "新功能建议", "custom": "定制需求", "other": "其他"}
FEEDBACK_STATUS = {"open": "待处理", "doing": "处理中", "done": "已处理"}
FEEDBACK_TEXT_MAX = 2000
FEEDBACK_CONTACT_MAX = 100
FEEDBACK_RATE = 3               # 每个 IP 每分钟最多提交次数
FEEDBACK_POSTS = (2, 60)        # 新工单：每个 IP 每 60 秒最多 2 条（追加说明不算）
FEEDBACK_DAILY = 20             # 每个 IP 每天最多提交条数
FEEDBACK_MINE_MAX = 50          # 一次最多查多少条自己的工单
FEEDBACK_SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT, contact TEXT, page TEXT, server TEXT,
  lang TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS feedback_reply(id INTEGER PRIMARY KEY AUTOINCREMENT, fid INTEGER, admin INTEGER, text TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS feedback_reply_fid ON feedback_reply(fid);
"""


class Feedback:
    def __init__(self, store, push):
        self.store, self.push = store, push
        self.wecom = (os.environ.get("EVE_FEEDBACK_WECOM") or "").strip()
        m = re.search(r"key=([0-9a-fA-F-]{20,})", self.wecom)
        self.wecom = m.group(1) if m else self.wecom
        self.admin_nets = []
        for x in (os.environ.get("EVE_FEEDBACK_ADMIN_IPS") or "").replace(" ", "").split(","):
            if x:
                try:
                    self.admin_nets.append(ipaddress.ip_network(x, strict=False))
                except ValueError:
                    log.warning("EVE_FEEDBACK_ADMIN_IPS 里的 %s 不是有效的 IP / 网段，已忽略", x)
        c = store.conn()
        with store.write_lock:
            Feedback.migrate(c)
            c.commit()

    @staticmethod
    def migrate(c):
        c.executescript(FEEDBACK_SCHEMA)
        cols = {r[1] for r in c.execute("PRAGMA table_info(feedback)")}
        for col, typ in (("token", "TEXT"), ("status", "TEXT DEFAULT 'open'"), ("updated", "INTEGER")):
            if col not in cols:
                c.execute(f"ALTER TABLE feedback ADD COLUMN {col} {typ}")

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def clean(v, limit, label):
        if v is None:
            return ""
        if not isinstance(v, str):
            raise ValueError(label + "应为文字")
        v = re.sub(r"[\x00-\x09\x0b-\x1f\x7f]", " ", v).strip()
        if len(v) > limit:
            raise ValueError(f"{label}最多 {limit} 字")
        return v

    @staticmethod
    def fid_of(v):
        if type(v) is not int or v <= 0:
            raise ValueError("工单编号不对")
        return v

    def submit(self, body, ip):
        kind = body.get("kind")
        if kind not in FEEDBACK_KINDS:
            raise ValueError("请选择问题类型")
        text = self.clean(body.get("text"), FEEDBACK_TEXT_MAX, "反馈内容")
        if len(text) < 4:
            raise ValueError("反馈内容太短，请多写几个字")
        contact = self.clean(body.get("contact"), FEEDBACK_CONTACT_MAX, "联系方式")
        page = self.clean(body.get("page"), 300, "页面")
        server = body.get("server") if body.get("server") in ARB_SERVERS else ""
        lang = "en" if body.get("lang") == "en" else "zh"
        self.push.count("ip:" + ip, "feedback", FEEDBACK_DAILY, "今天提交的工单太多了，请明天再试或直接发邮件")
        token = secrets.token_urlsafe(18)
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            cur = c.execute("INSERT INTO feedback(kind, text, contact, page, server, lang, created, token, status, updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (kind, text, contact, page, server, lang, now, self.digest(token), "open", now))
            c.commit()
        fid = cur.lastrowid
        log.info("收到工单 #%s（%s）", fid, kind)
        if self.wecom:
            threading.Thread(target=self.notify, args=(fid, kind, text, contact, page), daemon=True).start()
        return {"ok": True, "id": fid, "token": token, "created": now}

    def notify(self, fid, kind, text, contact, page):
        lines = [{"text": f"类型：{FEEDBACK_KINDS[kind]}"}] + [{"text": x} for x in text.splitlines() if x.strip()][:12]
        if contact:
            lines.append({"text": "联系方式：" + contact})
        if page:
            lines.append({"text": "页面：" + page})
        try:
            self.push.wecom({"key": self.wecom, "title": f"新工单 #{fid}", "lines": lines})
        except Exception as e:  # noqa: BLE001
            log.warning("工单 #%s 推送企业微信失败：%s", fid, e)

    def rows(self, where, args, admin=False, limit=300):
        c = self.store.conn()
        rows = c.execute(f"SELECT id, kind, text, contact, page, server, lang, created, COALESCE(status, 'open'), COALESCE(updated, created) "
                         f"FROM feedback WHERE {where} ORDER BY id DESC LIMIT {int(limit)}", args).fetchall()
        if not rows:
            return []
        ids = [r[0] for r in rows]
        replies = collections.defaultdict(list)
        for fid, adm, text, created in c.execute(f"SELECT fid, admin, text, created FROM feedback_reply WHERE fid IN ({','.join('?' * len(ids))}) ORDER BY id",
                                                 ids):
            replies[fid].append({"admin": bool(adm), "text": text, "created": created})
        out = []
        for fid, kind, text, contact, page, server, lang, created, status, updated in rows:
            x = {"id": fid, "kind": kind, "text": text, "status": status, "created": created, "updated": updated, "replies": replies[fid]}
            if admin:
                x.update(contact=contact, page=page, server=server, lang=lang)
            out.append(x)
        return out

    # POST /feedback/mine {tickets: [{id, token}]}：自己提交过的工单（凭证不对的直接跳过）
    def mine(self, body):
        tickets = body.get("tickets")
        if not isinstance(tickets, list):
            raise ValueError("tickets 应为列表")
        want = {}
        for t in tickets[:FEEDBACK_MINE_MAX]:
            if isinstance(t, dict) and type(t.get("id")) is int and isinstance(t.get("token"), str) and len(t["token"]) <= 64:
                want[t["id"]] = self.digest(t["token"])
        if not want:
            return {"items": []}
        ok = [fid for fid, tok in self.store.conn().execute(
            f"SELECT id, token FROM feedback WHERE id IN ({','.join('?' * len(want))})", list(want)) if tok and hmac.compare_digest(tok, want[fid])]
        return {"items": self.rows(f"id IN ({','.join('?' * len(ok))})", ok) if ok else []}

    # 提交者追加说明（同样凭 id + 凭证）
    def follow(self, body):
        fid = self.fid_of(body.get("id"))
        token = body.get("token")
        text = self.clean(body.get("text"), FEEDBACK_TEXT_MAX, "回复内容")
        if not text:
            raise ValueError("请先写下回复内容")
        row = self.store.conn().execute("SELECT token FROM feedback WHERE id=?", (fid,)).fetchone()
        if not row or not row[0] or not isinstance(token, str) or not hmac.compare_digest(row[0], self.digest(token)):
            raise PermissionError
        self.add_reply(fid, False, text, "open")
        if self.wecom:
            threading.Thread(target=lambda: self.push.wecom({"key": self.wecom, "title": f"工单 #{fid} 有新回复", "lines": [{"text": x} for x in text.splitlines() if x.strip()][:12]}),
                             daemon=True).start()
        return {"ok": True}

    def add_reply(self, fid, admin, text, status=None):
        now = int(time.time())
        c = self.store.conn()
        with self.store.write_lock:
            if not c.execute("SELECT 1 FROM feedback WHERE id=?", (fid,)).fetchone():
                raise ValueError(f"没有工单 #{fid}")
            if text:
                c.execute("INSERT INTO feedback_reply(fid, admin, text, created) VALUES(?,?,?,?)", (fid, 1 if admin else 0, text, now))
            if status:
                c.execute("UPDATE feedback SET status=?, updated=? WHERE id=?", (status, now, fid))
            else:
                c.execute("UPDATE feedback SET updated=? WHERE id=?", (now, fid))
            c.commit()

    # ---------- 站长 ----------
    def admin_ok(self, ip, body):
        # 站长：白名单 IP（EVE_FEEDBACK_ADMIN_IPS），或云同步账号（EVE_FEEDBACK_ADMIN_USER，默认 wbw5780）的登录密钥
        if self.admin_ip(ip):
            return True
        want = (os.environ.get("EVE_FEEDBACK_ADMIN_USER") or "wbw5780").strip().lower()
        if not want or not isinstance(body, dict):
            return False
        try:
            user, auth = self.sync.params(body)
            return user == want and bool(self.sync.check(user, auth))
        except Exception:
            return False

    def admin_ip(self, ip):
        try:
            addr = ipaddress.ip_address(ip.split("%")[0])
        except ValueError:
            return False
        if addr.version == 6 and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        return any(addr in net for net in self.admin_nets)


    def admin(self, op, body):
        if op == "list":
            status = body.get("status")
            if status in FEEDBACK_STATUS:
                return {"items": self.rows("COALESCE(status, 'open')=?", (status,), True)}
            return {"items": self.rows("1", (), True)}
        fid = self.fid_of(body.get("id"))
        status = body.get("status")
        if status is not None and status not in FEEDBACK_STATUS:
            raise ValueError("状态不对")
        if op == "reply":
            text = self.clean(body.get("text"), FEEDBACK_TEXT_MAX, "回复内容")
            if not text and not status:
                raise ValueError("请先写下回复内容")
            self.add_reply(fid, True, text, status or "doing")
            return {"ok": True}
        if op == "status":
            if not status:
                raise ValueError("状态不对")
            self.add_reply(fid, True, "", status)
            return {"ok": True}
        raise ValueError("not found")

    @staticmethod
    def recent(db, n):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            rows = conn.execute("SELECT id, kind, text, contact, page, server, lang, created, COALESCE(status, 'open') FROM feedback ORDER BY id DESC LIMIT ?",
                                (n,)).fetchall()
            replies = collections.defaultdict(list)
            for fid, adm, text in conn.execute("SELECT fid, admin, text FROM feedback_reply ORDER BY id"):
                replies[fid].append((adm, text))
        except sqlite3.OperationalError:
            rows = []
        finally:
            conn.close()
        if not rows:
            print("还没有工单")
        for fid, kind, text, contact, page, server, lang, created, status in rows:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(created))
            print(f"#{fid}  {when}  [{FEEDBACK_KINDS.get(kind, kind)}] [{FEEDBACK_STATUS.get(status, status)}]  {server or '-'}/{lang}  {page or ''}")
            print("  " + text.replace("\n", "\n  "))
            if contact:
                print("  联系方式：" + contact)
            for adm, t in replies.get(fid, []):
                print(("  ↳ 站长：" if adm else "  ↳ 提交者：") + t.replace("\n", "\n    "))
            print()

    @staticmethod
    def reply_cli(db, fid, text, done):
        conn = sqlite3.connect(db)
        try:
            Feedback.migrate(conn)
            if not conn.execute("SELECT 1 FROM feedback WHERE id=?", (fid,)).fetchone():
                print(f"没有工单 #{fid}")
                return
            now = int(time.time())
            if text:
                conn.execute("INSERT INTO feedback_reply(fid, admin, text, created) VALUES(?,?,?,?)", (fid, 1, text, now))
            conn.execute("UPDATE feedback SET status=?, updated=? WHERE id=?", ("done" if done else "doing", now, fid))
            conn.commit()
            print(f"已回复工单 #{fid}（{'已处理' if done else '处理中'}）")
        finally:
            conn.close()


# ---------------------------------------------------------------- 站点公告
# 站长（EVE_FEEDBACK_ADMIN_IPS 里的 IP）在网页「联系 → 公告管理」里发布：标题 + 内容（可附英文版，英文界面优先显示），
# 发给全部服务器或指定的几个服（servers 为空 = 全部，以后新加的服也算在内）；可设截止时间（过了就不再显示），可撤回 / 恢复、删除。
# 访客打开网站时读 GET /api/kb/notice?server=，浏览器按「id:rev」记看过的，没看过的弹窗提示；
# 修改时勾「重新弹给所有人」会把 rev 加一，看过旧版的人也会再弹一次。
NOTICE_SERVERS = tuple(ARB_SERVERS)
NOTICE_TITLE_MAX = 60
NOTICE_TEXT_MAX = 2000
NOTICE_LIST = 20                # 公开接口最多返回几条
NOTICE_CACHE = 30               # 公开接口按服缓存秒数（每次打开网站都会读一次；站长改动时立即清掉）
NOTICE_SCHEMA = """
CREATE TABLE IF NOT EXISTS notice(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, title_en TEXT, body_en TEXT,
  servers TEXT, created INTEGER, updated INTEGER, until INTEGER, rev INTEGER DEFAULT 1, off INTEGER DEFAULT 0);
"""
NOTICE_COLS = "id, title, body, title_en, body_en, servers, created, updated, until, rev, off"


class Notice:
    def __init__(self, store):
        self.store = store
        self.cache = {}
        self.lock = threading.Lock()
        c = store.conn()
        with store.write_lock:
            c.executescript(NOTICE_SCHEMA)
            c.commit()

    @staticmethod
    def row(r):
        nid, title, body, title_en, body_en, servers, created, updated, until, rev, off = r
        return {"id": nid, "rev": rev or 1, "title": title, "body": body or "", "title_en": title_en or "", "body_en": body_en or "",
                "servers": [x for x in (servers or "").split(",") if x], "created": created, "updated": updated, "until": until,
                "off": bool(off)}

    def items(self, q):
        server = q.get("server") if q.get("server") in NOTICE_SERVERS else "tq"
        now = int(time.time())
        with self.lock:
            hit = self.cache.get(server)
            if hit and now - hit[0] < NOTICE_CACHE and (not hit[2] or now < hit[2]):
                return hit[1]
        rows = self.store.conn().execute(f"SELECT {NOTICE_COLS} FROM notice WHERE off=0 AND (until IS NULL OR until>?) ORDER BY created DESC, id DESC",
                                         (now,)).fetchall()
        items = []
        for r in map(self.row, rows):
            if not r["servers"] or server in r["servers"]:
                r.pop("off")
                items.append(r)
        items = items[:NOTICE_LIST]
        expire = min((x["until"] for x in items if x["until"]), default=0)   # 有公告快到截止时间：到点就不再用缓存
        out = {"server": server, "items": items}
        with self.lock:
            self.cache[server] = (now, out, expire)
        return out

    @staticmethod
    def nid_of(v):
        if type(v) is not int or v <= 0:
            raise ValueError("公告编号不对")
        return v

    def admin(self, op, body):
        c = self.store.conn()
        if op == "list":
            rows = c.execute(f"SELECT {NOTICE_COLS} FROM notice ORDER BY created DESC, id DESC LIMIT 100").fetchall()
            return {"items": [self.row(r) for r in rows], "servers": list(NOTICE_SERVERS), "now": int(time.time())}
        now = int(time.time())
        if op == "save":
            clean = Feedback.clean
            title = clean(body.get("title"), NOTICE_TITLE_MAX, "标题")
            text = clean(body.get("body"), NOTICE_TEXT_MAX, "内容")   # 保留换行，其余控制字符换成空格
            title_en = clean(body.get("title_en"), NOTICE_TITLE_MAX, "英文标题")
            body_en = clean(body.get("body_en"), NOTICE_TEXT_MAX, "英文内容")
            title, title_en = " ".join(title.split()), " ".join(title_en.split())   # 标题只占一行
            if len(title) < 2:
                raise ValueError("请先写标题")
            servers = body.get("servers") or []
            if not isinstance(servers, list) or any(x not in NOTICE_SERVERS for x in servers):
                raise ValueError("服务器不对")
            servers = [x for x in NOTICE_SERVERS if x in servers]
            if len(servers) == len(NOTICE_SERVERS):
                servers = []
            until = body.get("until")
            if until is not None and (type(until) is not int or until <= now):
                raise ValueError("截止时间应晚于现在")
            nid = body.get("id")
            with self.store.write_lock:
                if nid is None:
                    cur = c.execute("INSERT INTO notice(title, body, title_en, body_en, servers, created, updated, until, rev, off) VALUES(?,?,?,?,?,?,?,?,1,0)",
                                    (title, text, title_en, body_en, ",".join(servers), now, now, until))
                    nid = cur.lastrowid
                    log.info("发布公告 #%s：%s（%s）", nid, title, ",".join(servers) or "全部服务器")
                else:
                    nid = self.nid_of(nid)
                    bump = 1 if body.get("repop") is True else 0
                    cur = c.execute("UPDATE notice SET title=?, body=?, title_en=?, body_en=?, servers=?, updated=?, until=?, rev=COALESCE(rev, 1)+? WHERE id=?",
                                    (title, text, title_en, body_en, ",".join(servers), now, until, bump, nid))
                    if not cur.rowcount:
                        raise ValueError("没有这条公告")
                    log.info("修改公告 #%s%s", nid, "（重新弹窗）" if bump else "")
                c.commit()
        elif op in ("off", "delete"):
            nid = self.nid_of(body.get("id"))
            with self.store.write_lock:
                if op == "off":
                    cur = c.execute("UPDATE notice SET off=?, updated=? WHERE id=?", (1 if body.get("off") is not False else 0, now, nid))
                else:
                    cur = c.execute("DELETE FROM notice WHERE id=?", (nid,))
                if not cur.rowcount:
                    raise ValueError("没有这条公告")
                c.commit()
            log.info("%s公告 #%s", "删除" if op == "delete" else "撤回" if body.get("off") is not False else "恢复", nid)
        else:
            raise ValueError("not found")
        with self.lock:
            self.cache.clear()
        row = c.execute(f"SELECT {NOTICE_COLS} FROM notice WHERE id=?", (nid,)).fetchone()
        return {"ok": True, "item": self.row(row) if row else None}


# ---------------------------------------------------------------- 收益助手（lite/ 独立程序）使用人数
# 程序每次启动 POST /api/kb/lite/ping {iid, ver, server}：iid 是安装时随机生成的 ID（不含角色、账号信息，也不记 IP），
# 只用来数有多少台电脑在用、每天多少人打开。站长查看：GET /api/kb/lite/stats（仅 EVE_FEEDBACK_ADMIN_IPS），
# 或命令行 --lite-stats。按天的活跃记录保留 400 天。
LITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS lite_install(iid TEXT PRIMARY KEY, first INTEGER, last INTEGER, ver TEXT, server TEXT, starts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS lite_day(day TEXT, iid TEXT, PRIMARY KEY(day, iid)) WITHOUT ROWID;
"""
LITE_SERVERS = ("tq", "serenity", "infinity")


class LiteStats:
    def __init__(self, store):
        self.store = store
        c = store.conn()
        with store.write_lock:
            c.executescript(LITE_SCHEMA)
            c.commit()
        self.pruned = ""

    def ping(self, body):
        iid = str(body.get("iid") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}", iid):
            raise ValueError("iid 无效")
        ver = str(body.get("ver") or "")[:20]
        if not re.fullmatch(r"[0-9A-Za-z.+-]*", ver):
            ver = ""
        server = body.get("server") if body.get("server") in LITE_SERVERS else ""
        now = int(time.time())
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        c = self.store.conn()
        with self.store.write_lock:
            c.execute("INSERT INTO lite_install(iid, first, last, ver, server, starts) VALUES(?,?,?,?,?,1) "
                      "ON CONFLICT(iid) DO UPDATE SET last = excluded.last, ver = excluded.ver, server = excluded.server, starts = starts + 1",
                      (iid, now, now, ver, server))
            c.execute("INSERT OR IGNORE INTO lite_day(day, iid) VALUES(?, ?)", (day, iid))
            if self.pruned != day:
                self.pruned = day
                c.execute("DELETE FROM lite_day WHERE day < ?", (time.strftime("%Y-%m-%d", time.gmtime(now - 400 * 86400)),))
            c.commit()
        return {"ok": True}

    @staticmethod
    def summary(c):
        now = int(time.time())
        d = lambda n: time.strftime("%Y-%m-%d", time.gmtime(now - n * 86400))
        one = lambda sql, *a: c.execute(sql, a).fetchone()[0] or 0
        active = lambda n: one("SELECT COUNT(DISTINCT iid) FROM lite_day WHERE day > ?", d(n))
        return {
            "installs": one("SELECT COUNT(*) FROM lite_install"),
            "starts": one("SELECT SUM(starts) FROM lite_install"),
            "active": {"today": one("SELECT COUNT(*) FROM lite_day WHERE day = ?", d(0)), "7d": active(7), "30d": active(30)},
            "new": {"today": one("SELECT COUNT(*) FROM lite_install WHERE first >= ?", now - now % 86400),
                    "7d": one("SELECT COUNT(*) FROM lite_install WHERE first > ?", now - 7 * 86400),
                    "30d": one("SELECT COUNT(*) FROM lite_install WHERE first > ?", now - 30 * 86400)},
            "versions": dict(c.execute("SELECT ver, COUNT(*) FROM lite_install WHERE last > ? GROUP BY ver ORDER BY 2 DESC", (now - 30 * 86400,)).fetchall()),
            "servers": dict(c.execute("SELECT server, COUNT(*) FROM lite_install WHERE last > ? GROUP BY server ORDER BY 2 DESC", (now - 30 * 86400,)).fetchall()),
            "daily": [{"day": k, "active": v} for k, v in c.execute("SELECT day, COUNT(*) FROM lite_day WHERE day > ? GROUP BY day ORDER BY day", (d(30),))],
        }

    def stats(self):
        return self.summary(self.store.conn())

    @staticmethod
    def stats_cli(db):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            s = LiteStats.summary(conn)
        except sqlite3.OperationalError:
            print("还没有收益助手的使用记录")
            return
        finally:
            conn.close()
        print(f"安装总数 {s['installs']}，累计启动 {s['starts']} 次")
        print(f"活跃：今天 {s['active']['today']}，7 天 {s['active']['7d']}，30 天 {s['active']['30d']}")
        print(f"新增：今天 {s['new']['today']}，7 天 {s['new']['7d']}，30 天 {s['new']['30d']}")
        print("30 天内的版本：" + ("，".join(f"{k or '未知'} {v}" for k, v in s["versions"].items()) or "无"))
        print("30 天内的服务器：" + ("，".join(f"{k or '未知'} {v}" for k, v in s["servers"].items()) or "无"))
        for r in s["daily"]:
            print(f"  {r['day']}  {r['active']}")


class WindowLimiter:
    """按 IP 的滑动窗口：period 秒内最多 n 次（只记成功的操作：先 check，成功后 add）"""
    def __init__(self, n, period):
        self.n, self.period, self.hits, self.lock = n, period, {}, threading.Lock()

    def check(self, ip):
        """还能做就返回 0，否则返回要等几秒"""
        now = time.time()
        with self.lock:
            q = [t for t in self.hits.get(ip, ()) if t > now - self.period]
            if q:
                self.hits[ip] = q
            else:
                self.hits.pop(ip, None)
            return 0 if len(q) < self.n else int(q[0] + self.period - now) + 1

    def add(self, ip):
        now = time.time()
        with self.lock:
            self.hits.setdefault(ip, []).append(now)
            if len(self.hits) > 20000:
                self.hits = {k: v for k, v in self.hits.items() if v[-1] > now - self.period}


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
        (("fw", "insurgency"), "fw_insurgency", lambda q: api.fw.insurgency(q)),
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
KB_ROUTES = ("status", "live", "battles", "battles/history", "battles/pilot", "feed", "top", "summary", "leaderboard", "search", "br", "shipfits", "locate", "gank")
V1_KB_ROUTES = {"kills", "live", "top", "kill", "summary", "battles", "battle_report", "leaderboard", "entity", "pilots", "search", "ship_fits"}


def kb_routes(api):
    return {"status": api.status, "live": api.live, "battles": api.battles, "battles/history": api.battle_history, "battles/pilot": api.pilot_battles, "feed": api.feed, "top": api.top,
            "summary": api.summary, "leaderboard": api.leaderboard, "search": api.search, "br": api.br, "shipfits": api.shipfits, "locate": api.locate,
            "gank": api.gank}


def make_handler(api, static_dir, industry, abyssal, cn_apis=None, bazaar=None, cbg=None):
    apis = {"tq": api, **(cn_apis or {})}
    image_proxy = ImageProxy()
    v1 = open_routes(api, industry, abyssal)
    v1_cn = {s: open_routes(a, industry, abyssal) for s, a in (cn_apis or {}).items()}
    post_limiter = RateLimiter(ABYSSAL_POST_RATE)
    bazaar = bazaar or Bazaar()
    cbg = cbg or Cbg()
    routes = {**kb_routes(api), "bpprices": api.bpprices, "couriers": api.couriers,
              "contracts": lambda q: api.pc.list(q), "contracts/status": lambda q: api.pc.info(q), "obsvol": lambda q: api.obs.query(q),
              "bazaar": bazaar.topics, "bazaar/topic": bazaar.topic, "bazaar/translate": bazaar.translate, "bazaar/skills": bazaar.skills,
              "bazaar/cbg": cbg.items, "bazaar/cbg/detail": cbg.detail,
              "bazaar/skillset": bazaar.skillset, "bazaar/cbg/skillset": cbg.skillset,
              "bazaar/sale": lambda q: api.sale.items(q), "bazaar/sale/detail": lambda q: api.sale.detail(q),
              "bazaar/sale/skillset": lambda q: api.sale.skillset(q), "wh/sos": lambda q: api.sos.items(q),
              "plaza": lambda q: api.plaza.items(q), "notice": lambda q: api.notice.items(q)}
    kb = {s: kb_routes(a) for s, a in apis.items()}

    def kb_server(q):
        srv = q.get("server") or "tq"
        if srv not in apis:
            raise ValueError("server 只能是 " + " / ".join(apis))
        return srv
    wallet_limiter = RateLimiter(WALLET_RATE)
    sync_limiter = RateLimiter(SYNC_RATE)
    sale_limiter = RateLimiter(SALE_RATE)
    sos_limiter = RateLimiter(SOS_RATE)
    plaza_limiter = RateLimiter(PLAZA_RATE)
    plaza_posts = WindowLimiter(*PLAZA_POSTS)
    push_limiter = RateLimiter(PUSH_RATE)
    hosted_limiter = RateLimiter(HOSTED_RATE)
    feedback_limiter = RateLimiter(FEEDBACK_RATE)
    feedback_posts = WindowLimiter(*FEEDBACK_POSTS)
    feedback_read_limiter = RateLimiter(30)
    br_km_limiter = RateLimiter(BR_KM_RATE)
    lite_limiter = RateLimiter(6)          # 收益助手启动上报：每个 IP 每分钟 6 次（网吧 / 同一出口多台电脑也够）
    chat_tr_limiter = RateLimiter(CHAT_TR_RATE)
    ai_limiter = RateLimiter(AI_RATE * 3)
    assistant = Assistant()
    esi_relay = EsiRelay()
    relay_limiter = RateLimiter(RELAY_RATE)
    relay_login_limiter = RateLimiter(RELAY_LOGIN_RATE)
    relay_zkill_limiter = RateLimiter(RELAY_ZKILL_RATE)

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

        def sos(self, path):
            # 虫洞求救（同源调用，不带 CORS 头）；令牌只用于本次请求，不写日志
            op = path[len("/api/kb/wh/sos/"):]
            if op not in ("save", "delete"):
                return self.send_json(404, {"error": "not found"})
            ok, _, retry = sos_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            auth = self.headers.get("Authorization") or ""
            token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
            if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,4096}", token):
                return self.send_json(403, {"error": "令牌无效，请重新绑定这个角色"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 4096:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                return self.send_json(200, getattr(api.sos, op)(body, token))
            except PermissionError:
                return self.send_json(403, {"error": "令牌无效或缺少位置读取权限，请重新绑定这个角色并勾选位置权限"})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("虫洞求救错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def plaza(self, path):
            # 广场（同源调用，不带 CORS 头）：发帖 / 撤下 / 可挂的合同带角色令牌；admin/* 只认站长 IP；令牌只用于本次请求，不写日志
            op = path[len("/api/kb/plaza/"):]
            if op not in ("save", "delete", "contracts", "admin/check", "admin/delete"):
                return self.send_json(404, {"error": "not found"})
            ip = self.client_ip()
            if op.startswith("admin/") and not api.feedback.admin_ip(ip):
                return self.send_json(404, {"error": "not found"})
            ok, _, retry = plaza_limiter.take(ip)
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 32768:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                if op == "admin/check":
                    return self.send_json(200, {"ok": True})
                if op == "admin/delete":
                    pid = body.get("id")
                    if type(pid) is not int:
                        raise ValueError("id 应为整数")
                    log.info("站长删除广场帖子 %s", pid)
                    return self.send_json(200, api.plaza.remove(WhSos.server_of(body.get("server")), pid))
                auth = self.headers.get("Authorization") or ""
                token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
                if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,4096}", token):
                    return self.send_json(403, {"error": "令牌无效，请重新绑定这个角色"})
                if op == "save" and not (isinstance(body, dict) and body.get("id")):
                    wait = 0 if api.feedback.admin_ip(ip) else plaza_posts.check(ip)
                    if wait:
                        return self.send_json(429, {"error": f"发帖太频繁：每分钟最多 {PLAZA_POSTS[0]} 条，请 {wait} 秒后再试"}, {"Retry-After": str(wait)})
                    out = api.plaza.save(body, token)
                    plaza_posts.add(ip)
                    return self.send_json(200, out)
                return self.send_json(200, getattr(api.plaza, op)(body, token))
            except PermissionError as e:
                msg = e.args[0] if e.args and isinstance(e.args[0], str) else "令牌无效或缺少所需权限，请重新绑定这个角色"
                return self.send_json(403, {"error": msg})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("广场错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def sale(self, path):
            # 角色挂售（同源调用，不带 CORS 头）；令牌只用于本次请求，不写日志
            op = path[len("/api/kb/bazaar/sale/"):]
            if op not in ("save", "delete"):
                return self.send_json(404, {"error": "not found"})
            ok, _, retry = sale_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            auth = self.headers.get("Authorization") or ""
            token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
            if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,4096}", token):
                return self.send_json(403, {"error": "令牌无效，请重新绑定这个角色"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 8192:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                return self.send_json(200, getattr(api.sale, op)(body, token))
            except PermissionError:
                return self.send_json(403, {"error": "令牌无效或缺少技能读取权限，请重新绑定这个角色"})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("角色挂售错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def lite_ping(self):
            # 收益助手启动上报（程序走 Tauri HTTP，不受 CORS 限制，不带 CORS 头）
            ok, _, retry = lite_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": "too many requests"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 1024:
                    raise ValueError("请求体应为 JSON")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("请求体应为 JSON")
                return self.send_json(200, api.lite.ping(body))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception:
                log.exception("收益助手上报错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def feedback(self, path):
            # 工单（同源调用，不带 CORS 头）：提交 / 自己的历史 / 追加说明 / 站长管理
            op = path[len("/api/kb/feedback"):].strip("/")
            if op not in ("", "mine", "follow", "admin/check", "admin/list", "admin/reply", "admin/status"):
                return self.send_json(404, {"error": "not found"})
            ip = self.client_ip()
            admin = op.startswith("admin/")
            body = None
            if admin:
                # 管理操作先读 body：除了站长 IP，还认云同步账号（登录密钥在 body.user / body.auth 里）
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    if not 0 < length <= 16384:
                        raise ValueError
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError
                except ValueError:
                    return self.send_json(400, {"error": "请求体应为 JSON"})
                if not api.feedback.admin_ok(ip, body):
                    return self.send_json(404, {"error": "not found"})
            if op == "admin/check":   # 站长（IP 或云同步账号）能走到这里：网页据此显示「工单管理」
                return self.send_json(200, {"admin": True})
            if not admin:
                ok, _, retry = (feedback_read_limiter if op == "mine" else feedback_limiter).take(ip)
                if not ok:
                    return self.send_json(429, {"error": f"提交太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            if body is None:
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    if not 0 < length <= 16384:
                        raise ValueError
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError
                except ValueError:
                    return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                if admin:
                    return self.send_json(200, api.feedback.admin(op[6:], body))
                if op == "mine":
                    return self.send_json(200, api.feedback.mine(body))
                if op == "follow":
                    return self.send_json(200, api.feedback.follow(body))
                wait = 0 if api.feedback.admin_ip(ip) else feedback_posts.check(ip)
                if wait:
                    return self.send_json(429, {"error": f"提交太频繁：每分钟最多 {FEEDBACK_POSTS[0]} 条工单，请 {wait} 秒后再试"}, {"Retry-After": str(wait)})
                out = api.feedback.submit(body, ip)
                feedback_posts.add(ip)
                return self.send_json(200, out)
            except PermissionError:
                return self.send_json(403, {"error": "这条工单不是在这个浏览器提交的"})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception:
                log.exception("工单错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def br_km(self, q):
            # 战场统计 · 按指定的击杀（同源调用）：库里没有的要向 ESI 取原文，按 IP 限流
            ok, _, retry = br_km_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                srv = kb_server(q)
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 262144:
                    raise ValueError("请求体应为 JSON")
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    raise ValueError("请求体应为 JSON") from None
                return self.send_json(200, apis[srv].br_km(body))
            except ValueError as e:
                return self.send_json(400, {"error": str(e) or "请求体应为 JSON"})
            except Exception:
                log.exception("按击杀统计错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def notice(self, path):
            # 站点公告管理（同源调用）：和工单管理同一套站长判断（站长 IP，或云同步账号的登录密钥在 body.user / body.auth 里），别人看到 404
            op = path[len("/api/kb/notice/"):]
            if op not in ("admin/list", "admin/save", "admin/off", "admin/delete"):
                return self.send_json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 32768:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            if not api.feedback.admin_ok(self.client_ip(), body):
                return self.send_json(404, {"error": "not found"})
            try:
                return self.send_json(200, api.notice.admin(op[6:], body))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception:
                log.exception("公告错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def hosted(self, path):
            # 服务器托管预警；令牌、机器人 key、邮箱授权码不写日志
            op = path[len("/api/kb/hosted/"):]
            h = api.hosted
            ops = {"start": h.start, "update": h.update, "status": h.status, "stop": h.stop}
            if op not in ops:
                return self.send_json(404, {"error": "not found"})
            ip = self.client_ip()
            ok, _, retry = hosted_limiter.take(ip)
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= HOSTED_BODY_MAX:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                return self.send_json(200, ops[op](body, ip))
            except PermissionError as e:
                return self.send_json(403, {"error": str(e)})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("托管预警接口错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def push(self, path):
            # 预警推送（同源调用，不带 CORS 头）；机器人 key、邮箱账号、授权码不写日志
            op = path[len("/api/kb/push/"):]
            ops = {"wecom": api.push.wecom, "mail": api.push.mail, **{k: functools.partial(api.push.token, k) for k in PUSH_TOKEN}}
            if op not in ops:
                return self.send_json(404, {"error": "not found"})
            ip = self.client_ip()
            ok, _, retry = push_limiter.take(ip)
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 32768:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                return self.send_json(200, ops[op](body, ip))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except EsiUnavailable as e:
                return self.send_json(502, {"error": str(e)})
            except Exception:
                log.exception("预警推送错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def ai(self, chat):
            # AI 助手（同源调用）：对话与玩家自己的 API Key 不写日志、不保存。本站模型每分钟 AI_RATE 次，自己的接口 ×3
            # stream=true 时边收上游边转发（NDJSON：{"t": 文字增量} …，最后 {"done": 结果} 或 {"error": 原因}）；
            # 第一段文字到达前出错仍按普通 JSON 返回错误码（浏览器据此自动重试）
            ip = self.client_ip()
            started = False

            def line(obj):
                self.wfile.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
                self.wfile.flush()

            def on_text(t):
                nonlocal started
                if not t:
                    return
                if not started:
                    started = True
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("X-Accel-Buffering", "no")   # nginx 不缓冲，逐段送到浏览器
                    self.end_headers()
                line({"t": t})

            def fail(code, msg, headers=None):
                if not started:
                    return self.send_json(code, {"error": msg}, headers)
                try:
                    line({"error": msg})
                except OSError:
                    pass
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= AI_BODY_MAX:
                    raise ValueError("对话太长了，请点「新对话」重新开始" if length else "请求体应为 JSON")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("请求体应为 JSON")
                if not chat:
                    return self.send_json(200, assistant.info(ip))
                ok, _, retry = ai_limiter.take(ip, 1 if body.get("llm") else 3)
                if not ok:
                    return self.send_json(429, {"error": f"太频繁了，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
                res = assistant.chat(body, ip, on_text if body.get("stream") else None)
                return line({"done": res}) if started else self.send_json(200, res)
            except (BrokenPipeError, ConnectionResetError):
                return None   # 玩家点了停止
            except ValueError as e:
                return fail(400, str(e) or "请求体应为 JSON")
            except LlmError as e:
                return fail(503, str(e), {"Retry-After": str(e.retry)} if e.retry else None)
            except RuntimeError as e:
                return fail(503, str(e))
            except Exception:
                log.exception("AI 助手错误")
                return fail(500, "服务器内部错误")

        def chat_translate(self, models=False):
            # 频道翻译转发（同源调用，不带 CORS 头）；请求体（含玩家的大模型 API Key）不写日志、不保存；models：取大模型的模型列表
            ok, _, retry = chat_tr_limiter.take(self.client_ip())
            if not ok:
                return self.send_json(429, {"error": f"翻译太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 65536:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
                return self.send_json(200, llm_models(body) if models else chat_translate(body))
            except ValueError as e:
                return self.send_json(400, {"error": str(e) or "请求体应为 JSON"})
            except RuntimeError as e:
                return self.send_json(503, {"error": str(e)})
            except Exception:
                log.exception("频道翻译错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def sync(self, path):
            # 设置云同步（同源调用，不带 CORS 头）；请求体不写日志
            op = path[len("/api/kb/sync/"):]
            if op not in ("register", "pull", "push", "delete"):
                return self.send_json(404, {"error": "not found"})
            ok, _, retry = sync_limiter.take(self.client_ip(), 5 if op == "register" else 1)
            if not ok:
                return self.send_json(429, {"error": f"请求太频繁，请 {retry} 秒后再试"}, {"Retry-After": str(retry)})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= SYNC_MAX + 4096:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "请求体应为 JSON"})
            try:
                return self.send_json(200, getattr(api.sync, op)(body))
            except PermissionError as e:
                return self.send_json(403, {"error": str(e)})
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception:
                log.exception("云同步错误")
                return self.send_json(500, {"error": "服务器内部错误"})

        def do_POST(self):
            PRICE_MODE.sell = False
            # 钱包成交存档、设置云同步；其余是唯一的写入型开放接口：深渊装备导入 / 刷新估价（转发到 MutaMarket，按 IP 单独限流）
            url = urllib.parse.urlparse(self.path)
            if url.path.startswith("/api/kb/relay/"):
                return self.relay("POST")
            if url.path.startswith("/api/kb/wallet/"):
                return self.wallet(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/sync/"):
                return self.sync(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/bazaar/sale/"):
                return self.sale(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/wh/sos/"):
                return self.sos(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/plaza/"):
                return self.plaza(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/push/"):
                return self.push(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/hosted/"):
                return self.hosted(url.path.rstrip("/"))
            if url.path.rstrip("/") == "/api/kb/feedback" or url.path.startswith("/api/kb/feedback/"):
                return self.feedback(url.path.rstrip("/"))
            if url.path.startswith("/api/kb/notice/"):
                return self.notice(url.path.rstrip("/"))
            if url.path.rstrip("/") == "/api/kb/br/km":
                return self.br_km(dict(urllib.parse.parse_qsl(url.query)))
            if url.path.rstrip("/") == "/api/kb/lite/ping":
                return self.lite_ping()
            if url.path.rstrip("/") in ("/api/kb/translate", "/api/kb/translate/models"):
                return self.chat_translate(url.path.rstrip("/").endswith("/models"))
            if url.path.rstrip("/") in ("/api/kb/ai/info", "/api/kb/ai/chat"):
                return self.ai(url.path.rstrip("/").endswith("/chat"))
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

        def relay(self, method):
            url = urllib.parse.urlparse(self.path)
            key, _, rest = url.path[len("/api/kb/relay/"):].partition("/")
            try:
                target = esi_relay.target(key, rest, url.query)
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            ip = self.client_ip()
            if key == "zkill" and method != "GET":
                return self.send_json(405, {"error": "只支持读取"})
            ok, _, retry = (relay_login_limiter if key == "login" else relay_zkill_limiter if key == "zkill" else relay_limiter).take(ip)
            if not ok:
                return self.send_json(429, {"error": "中转请求过于频繁，请稍后再试"}, {"Retry-After": str(retry)})
            length = int(self.headers.get("Content-Length") or 0)
            if length > RELAY_BODY_LIMIT:
                return self.send_json(413, {"error": "请求体过大"})
            body = self.rfile.read(length) if length else (b"" if method in ("POST", "PUT") else None)
            headers = {k: self.headers[k] for k in RELAY_REQ_HEADERS if self.headers.get(k)}
            status, res_headers, data = esi_relay.zkill(target) if key == "zkill" else esi_relay.forward(method, target, headers, body)
            if data is None:
                msg = ("zKillboard 中转排队的人太多，请稍后再试" if key == "zkill" else "ESI 错误次数过多，中转暂停，请稍后再试") if status == 503 \
                    else "本站服务器也连不上 zKillboard，请稍后再试" if key == "zkill" else "本站服务器也连不上官方服务器，请稍后再试"
                return self.send_json(status, {"error": msg}, dict(res_headers))
            gz = "gzip" in (self.headers.get("Accept-Encoding") or "") and len(data) > 1024
            if gz:
                data = gzip.compress(data, 5)
            self.send_response(status)
            for k, v in res_headers:
                self.send_header(k, v)
            self.send_header("Cache-Control", "no-store")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_PUT(self):
            if self.path.startswith("/api/kb/relay/"):
                return self.relay("PUT")
            self.send_json(404, {"error": "not found"})

        def do_DELETE(self):
            if self.path.startswith("/api/kb/relay/"):
                return self.relay("DELETE")
            self.send_json(404, {"error": "not found"})

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            PRICE_MODE.sell = False                   # 长连接复用线程：每个请求从默认口径开始
            if url.path.startswith("/api/kb/relay/"):
                return self.relay("GET")
            if url.path == "/api/v1" or url.path.startswith("/api/v1/"):
                return self.open_api(url)
            if url.path == "/api/kb/img":
                return self.image(url)
            if url.path.rstrip("/") == "/api/kb/lite/stats":   # 收益助手使用人数：只给站长 IP，别人看到 404
                if not api.feedback.admin_ip(self.client_ip()):
                    return self.send_json(404, {"error": "not found"})
                return self.send_json(200, api.lite.stats())
            if url.path.startswith("/api/kb/"):
                return self.api(url)
            if static_dir:
                return self.static(url.path)
            self.send_json(404, {"error": "not found"})

        def api(self, url):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            parts = [p for p in url.path[len("/api/kb/"):].split("/") if p]
            key = "/".join(parts)
            PRICE_MODE.sell = q.get("price") == "sell"   # 击杀估价口径（站点全局设置），本请求内的查询都按它
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
                msg = str(e.args[0]) if isinstance(e, KeyError) and e.args else str(e)   # KeyError 的 str() 带引号
                self.send_json(404 if isinstance(e, KeyError) else 400, {"error": msg})
            except Exception as e:
                log.exception("接口错误")
                self.send_json(500, {"error": str(e)})

        def image(self, url):
            q = urllib.parse.parse_qs(url.query)
            try:
                body, ctype = image_proxy.get((q.get("u") or [""])[0])
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            if body is None:
                return self.send_json(ctype if ctype in (404,) else 502, {"error": "图片加载失败"}, {"Access-Control-Allow-Origin": "*"})
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=604800")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
    parser.add_argument("--lite", action="store_true", help="演示用：只读已有数据，不启动任何后台采集 / 轮询 / 预计算")
    parser.add_argument("--feedback", type=int, metavar="N", help="列出最近 N 条工单后退出")
    parser.add_argument("--feedback-reply", nargs=2, metavar=("ID", "TEXT"), help="回复工单后退出（状态改为处理中）")
    parser.add_argument("--feedback-done", action="store_true", help="与 --feedback-reply 一起用：同时标为已处理")
    parser.add_argument("--lite-stats", action="store_true", help="显示收益助手（lite/ 独立程序）的使用人数后退出")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.feedback:
        Feedback.recent(args.db, args.feedback)
        return
    if args.lite_stats:
        LiteStats.stats_cli(args.db)
        return
    if args.feedback_reply:
        Feedback.reply_cli(args.db, int(args.feedback_reply[0]), args.feedback_reply[1].strip(), args.feedback_done)
        return

    with open(args.system_regions, encoding="utf-8") as fh:
        system_regions = {int(k): v for k, v in json.load(fh).items()}
    store = Store(args.db, system_regions, args.days + 1)
    store.abyssal_model = AbyssalModel(store)
    store.arb = HubArbitrage(store)
    store.obs = ObsVolume(store)
    workers = Workers(store, args.days, "r2z2" if args.live == "redisq" else args.live)
    if not args.lite:
        workers.start()
    api = Api(store)
    api.arb = store.arb
    api.fw = FwTracker(store)
    api.mapk = MapKills(store)
    api.pc = ContractArchive(store, args.contract_db or os.path.join(os.path.dirname(os.path.abspath(args.db)), "contracts.sqlite"),
                             args.contract_backfill, args.contract_keep)
    if not args.lite:
        for job in (api.fw, api.mapk, api.pc):
            job.start()
        threading.Thread(target=api.warm, daemon=True).start()
        threading.Thread(target=lambda: (time.sleep(30), api.battle_history({"days": 30})), daemon=True).start()   # 历史会战先算好一份
    here = os.path.dirname(os.path.abspath(__file__))
    industry = Industry(store, [args.industry_dir, args.static, os.path.dirname(here), "/opt/eve/dist"])
    api.obs = store.obs
    api.wallet = Wallet(store, industry)
    api.industry = industry
    api.sync = SettingsSync(store)
    api.sale = CharSale(store, api.wallet)
    api.sos = WhSos(store, api.wallet)
    api.plaza = Plaza(store, api.wallet)
    api.push = AlertPush()
    api.feedback = Feedback(store, api.push)
    api.feedback.sync = api.sync
    api.notice = Notice(store)
    api.lite = LiteStats(store)
    abyssal = Abyssal(store)
    abyssal.model = store.abyssal_model
    cn_apis = {}
    cn_dir = args.cn_db_dir or os.path.dirname(os.path.abspath(args.db))
    queue = args.cn_queue or "emt-" + hashlib.md5(os.path.abspath(args.db).encode()).hexdigest()[:10]
    for name in [s.strip() for s in args.cn.split(",") if s.strip() and s.strip() != "off"]:
        if name not in CN_KB:
            parser.error(f"--cn 只能是 {' / '.join(CN_KB)}")
        cn_store = Store(os.path.join(cn_dir, f"kb-{name}.sqlite"), dict(system_regions), args.cn_days + 1 if args.cn_days else 0, server=name)
        cn_apis[name] = Api(cn_store)
        cn_apis[name].industry = industry
        if not args.lite:
            CnWorkers(cn_store, queue).start()
            threading.Thread(target=cn_apis[name].warm, daemon=True).start()
    GLOSSARY.dirs = [args.static, os.path.dirname(here), "/opt/eve/dist"]
    CHAT_TR_KEYS["path"] = os.path.join(os.path.dirname(os.path.abspath(args.db)), "youdao.json")
    bazaar, cbg = Bazaar(os.path.join(os.path.dirname(os.path.abspath(args.db)), "bazaar-index.json")), Cbg()
    if not args.lite:
        bazaar.start(), cbg.start()
    threading.Thread(target=mem_upkeep, args=([store] + [a.store for a in cn_apis.values()],), daemon=True).start()
    api.hosted = Hosted(store, {"tq": api, **cn_apis}, industry, api.push, os.path.abspath(args.db) + ".hostkey")
    api.hosted.start_worker()
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(api, args.static, industry, abyssal, cn_apis, bazaar, cbg))
    log.info("击杀记录服务已启动 http://%s:%d", args.bind, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
