#!/usr/bin/env python3
"""国服（晨曦 / 曙光）独有的舰船、装备、技能等：CCP 的 SDE 里没有，只能从网易 ESI 读取，生成 cn-extra-<服>.json。

用法：python3 server/build_cn_extra.py <SDE 解压目录> [serenity] [infinity] [--root 站点目录] [--cache 缓存目录] [--refresh-hours N]
  （默认在 eve-overview-clone 目录下读写；ESI 结果缓存在 server/.cn-cache/，重跑只请求新增的物品）
  --root：读 fit-data.json 等、写 cn-extra-<服>.json 与 i18n 的目录（定时任务直接指向线上静态目录）
  --refresh-hours N：距上次全量刷新超过 N 小时就忽略缓存重读全部物品（国服改了已有物品的数值也能跟上）
  文件只在内容变了时才写（先写临时文件再替换），没变不动；有更新时输出「已更新」。定时任务见 server/data_update.sh。

做法：
  1. 比较宁静与国服 /universe/types/ 的全部 ID，找出国服独有的物品，逐个读详情（中英文名、分组、市场分组、属性、效果）
  2. 装配数据里没有的效果和属性从 /dogma/effects/、/dogma/attributes/ 补上
  3. ESI 的效果修正不带「对哪个技能 / 分组的装备生效」，按效果名（如 ShipBonusMedHybridTurretDmg → 中型混合炮台）
     和 SDE 里同类修正推断；推断不出来的修正丢弃（少算一个加成，好过加错地方）
输出（结构与 catalog.json / fit-data.json / skill-data.json 一致，前端在切到对应服务器时合并）：
  catalog: { groups: [{ id, name, parentId, types: [{ id, name }] }] }   新市场分组（含缺失的上级）与已有分组里新增的物品
  fit:     { attrs, effects, groups, markets, types }                       只含 fit-data.json 里没有的条目
  skills:  { skills: { id: [中文名, 英文名, 分组, 倍数, 主属性, 副属性, 描述] }, groups: { id: 名称 } }
另把这些物品、分组的英文名并入 i18n/names-en.json（同时写一份 i18n/names-en-cn.json，build_names_en.py 重建时会再并入）。

曙光另有两套舰船加成（技能未发布，照样收录到 fit.types，不进技能页）：
  舰船适性（技能组 4160）：技能把数值加到舰船的 shipAdaption* 属性上，舰船再用自己的效果加到装甲 / 抗性等；
    描述写「解锁后」的只有 1 级（fit.adapt.max1），其余按 5 级
  云计算（技能组 4196）：把闲置舰船放进云计算后给当前舰船加成，效果直接改舰船属性；前端由玩家勾选放了哪些船才生效。
    fit.adapt.cloud: { 技能: [来源舰船, 对该级别全部种族(0/1), 带宽, 生效船级?] }；fit.adapt.hulls: { 种族船体技能: [种族, 级别] }
    生效船级（可省略）：技能描述写了「所有战列舰 / 所有舰船…」或官方公告写明的（CLOUD_FIX），为船级列表（不分种族）或 '*'（全部舰船）
    生效对象：与来源舰船同级别（按种族船体技能），T1 / T2 / 帝国海军型只对本族；特别版、海盗等非帝国海军势力（含三神裔、伊甸联合）对全部种族；
    官方列出过的舰船按官方表格（CLOUD_NEWS）。带宽：官方表格有的按表格，否则特别版（市场分组「特别版舰船」）40、非帝国海军势力 35、
    T2 30、帝国海军型 25、T1 20（T3 规则没写，按 35 本族）
另外 fit.patch: { 已有舰船: [{ 属性: 国服值 }, [国服效果列表]] }：宁静服也有的舰船在国服的属性值 / 效果不同时（适性属性与效果、数值调整）按国服覆盖；
限定舰船的装备只补可装配舰船属性（国服独有舰船加进名单）。
"""
import collections
import concurrent.futures as cf
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'server', '.cn-cache')
REFRESH = False   # True：本次运行忽略缓存，每个地址重读一次
TQ = 'https://esi.evetech.net/latest'
CN = 'https://ali-esi.evepc.163.com/latest'
FIT_CATS = {6, 7, 8, 16, 18, 20, 32, 87}    # 与 build_fit_data.py 相同
FUNCS = {'ItemModifier': 0, 'LocationModifier': 1, 'LocationGroupModifier': 2,
         'LocationRequiredSkillModifier': 3, 'OwnerRequiredSkillModifier': 4}
DOMAINS = {'itemID': 0, 'shipID': 1, 'charID': 2, 'otherID': 3, 'structureID': 4, 'targetID': 5, 'target': 5}
BASE_FIELDS = {'mass': 4, 'capacity': 38, 'volume': 161, 'radius': 162}
# 限定可装配舰船的属性（canFitShipGroup01… / canFitShipType1…，与 fit-engine.js 的 AT.canFitShipGroup / canFitShipType 相同）
CAN_FIT = {1298, 1299, 1300, 1301, 1872, 1879, 1880, 1881, 2065, 2396, 2476, 2477, 2478, 2479, 2480, 2481, 2482, 2483, 2484, 2485,
           1302, 1303, 1304, 1305, 1944, 2103, 2463, 2486, 2487, 2488, 2758}
SKILL_ATTRS = {'rank': 275, 'pri': 180, 'sec': 181}
ADAPT_GROUPS = {4160, 4196}   # 舰船适性、云计算（曙光）
CLOUD_GROUP = 4196
CLOUD_NEWS = 'https://evepc.163.com/shuguang/news/20231116/38678_1120400.html'
REQ_SKILLS = ('182', '183', '184', '1285', '1289', '1290')
HULL_RE = re.compile(r'^(Amarr|Caldari|Gallente|Minmatar|Precursor|ORE|Jove|Upwell|EDENCOM|Triglavian) (Frigate|Destroyer|Cruiser|Battlecruiser|Battleship|Carrier|Dreadnought|Titan|Force Auxiliary|Industrial|Hauler|Freighter|Strategic Cruiser|Tactical Destroyer)$')


# ---------- ESI（带磁盘缓存）----------
ERR_LOCK = threading.Lock()


def error_budget(headers):
    """ESI 错误额度（每分钟 100 次 4xx/5xx，超了整个 IP 被封，线上服务也读不了）：剩得少就等到重置"""
    remain, reset = (headers or {}).get('X-ESI-Error-Limit-Remain'), (headers or {}).get('X-ESI-Error-Limit-Reset')
    if remain is not None and int(remain) < 30:
        with ERR_LOCK:
            time.sleep(int(reset or 60) + 1)


def fetch(url):
    err = None
    for _ in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'EVE-Market-Tool build_cn_extra'}), timeout=30) as r:
                error_budget(r.headers)
                return json.load(r), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 420:   # 已经被限：等到重置再试
                with ERR_LOCK:
                    time.sleep(int(e.headers.get('X-ESI-Error-Limit-Reset') or 60) + 1)
            else:
                error_budget(e.headers)
            if e.code == 404:
                return None, None
            err = e
        except Exception as e:  # noqa: BLE001
            err = e
    print('请求失败', url, err, file=sys.stderr)
    return None, None


class Cache:
    def __init__(self, name):
        self.path = os.path.join(CACHE, name + '.json')
        self.data = json.load(open(self.path)) if os.path.exists(self.path) else {}
        self.seen = set()

    def many(self, urls, threads=16):
        todo = [u for u in dict.fromkeys(urls) if u not in self.data or (REFRESH and u not in self.seen)]
        self.seen.update(todo)
        with cf.ThreadPoolExecutor(threads) as ex:
            for u, (v, _) in zip(todo, ex.map(fetch, todo)):
                if v is not None:
                    if '/universe/types/' not in u:   # 分组 / 市场分组自带的成员列表用不上
                        v.pop('types', None)
                        v.pop('groups', None)
                    self.data[u] = v
        if todo:
            os.makedirs(CACHE, exist_ok=True)
            write_if_changed(self.path, self.data, compact=False)
        return [self.data.get(u) for u in urls]


def all_ids(base, ds):
    first, h = fetch(f'{base}/universe/types/?datasource={ds}&page=1')
    out = set(first)
    with cf.ThreadPoolExecutor(8) as ex:
        for x in ex.map(lambda p: fetch(f'{base}/universe/types/?datasource={ds}&page={p}')[0], range(2, int(h['x-pages']) + 1)):
            out |= set(x or [])
    return out


def probe(url_of, start, misses=10):
    """从 start 往后逐个试，连续 misses 个 404 就停（404 计入 ESI 错误额度，一次十几个）；返回 { ID: 详情 }"""
    out, n, i = {}, 0, start
    while n < misses:
        v, _ = fetch(url_of(i))
        if v is None:
            n += 1
        else:
            out[i], n = v, 0
        i += 1
    return out


def new_ids(base, ds, known):
    """网易的物品列表（/universe/types/）和市场分组列表更新慢，新船上线当天常常还没有，详情接口却已经能读：
    从已知最大的市场分组、国服独有物品 ID 往后试，新分组里的物品和新 ID 都算上"""
    groups, _ = fetch(f'{base}/markets/groups/?datasource={ds}')
    top = max([g for g in groups or [] if g < 30000] or [0])
    out = set()
    for v in probe(lambda g: f'{base}/markets/groups/{g}/?datasource={ds}', top + 1).values():
        out |= set(v.get('types', []))
    top = max([t for t in known | out if t < 1_000_000] or [0])
    out |= set(probe(lambda t: f'{base}/universe/types/{t}/?datasource={ds}', top + 1))
    return out


# ---------- 推断效果修正的技能 / 分组 ----------
ABBR = {'med': 'medium', 'dmg': 'damage', 'rof': 'rate', 'ac': 'autocannon', 'arty': 'artillery',
        'hm': 'heavy missile', 'lm': 'light missile', 'rk': 'rocket', 'ham': 'heavy assault missile',
        'mwd': 'microwarpdrive high speed maneuvering', 'microwarpdrive': 'microwarpdrive high speed maneuvering',
        'smartbomb': 'smart bomb', 'mjd': 'micro jump drive', 'abmwd': 'afterburner microwarpdrive high speed maneuvering',
        'lmhmham': 'light missile heavy missile heavy assault missile', 'pg': 'powergrid',
        'rockets': 'rocket', 'missiles': 'missile', 'torpedoes': 'torpedo', 'turrets': 'turret', 'lasers': 'laser',
        'blasters': 'blaster', 'railguns': 'railgun', 'drones': 'drone', 'beam': 'beam laser', 'pulse': 'pulse laser',
        'railgun': 'railgun hybrid', 'blaster': 'blaster hybrid', 'autocannon': 'autocannon projectile',
        'artillery': 'artillery projectile', 'laser': 'laser energy'}
SIZE = {'small', 'medium', 'large', 'capital', 'heavy', 'light'}
# 推断不出的国服效果（名字连写、fighter 是停用词）：效果名 -> 技能，只用于推断失败的技能修正
MANUAL = {
    'SerpentisModifiedBonustoFighterDamageandHP': 23069,                  # 诛日级：舰载机伤害、护盾
    'SerpentisModifiedBonustoSupportFighterWebRangeandStrength': 40573,   # 诛日级：后勤铁骑舰载机停滞缠绕距离、强度
}
STOP = {'ship', 'bonus', 'role', 'solar', 'flare', 'weapon', 'and', 'post', 'percent', 'location', 'modules',
        'requiring', 'owner', 'char', 'skill', 'set', 'operation', 'the', 'of', 'for', 'no', 'fighter', 'entity'}


def toks(name):
    name = re.sub(r'Auto[Cc]annon', 'Autocannon', name)
    out = []
    for p in re.findall(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+', name):
        p = p.lower()
        out += ABBR.get(p, p).split()
    return [t for t in out if t not in STOP]


def label_toks(label):
    return toks(re.sub(r'[^A-Za-z0-9 ]', ' ', label).title().replace(' ', ''))


class Inferer:
    def __init__(self, sde, extra_skills, extra_groups):
        def jl(name):
            with open(os.path.join(sde, name + '.jsonl')) as fh:
                for line in fh:
                    yield json.loads(line)
        groups = {g['_key']: g for g in jl('groups')}
        self.skills, self.gnames = {}, {k: g['name']['en'] for k, g in groups.items()}
        for t in jl('types'):
            if t.get('published') and groups.get(t['groupID'], {}).get('categoryID') == 16:
                self.skills[t['_key']] = t['name']['en']
        self.skills.update(extra_skills)
        self.gnames.update(extra_groups)
        self.ltoks = {(2, k): label_toks(v) for k, v in self.gnames.items()}
        self.ltoks.update({(3, k): label_toks(v) for k, v in self.skills.items()})
        # 签名（func, domain, 被修改属性, 运算）-> { 技能或分组: [含此修正的 SDE 效果名…] }
        self.sig = collections.defaultdict(lambda: collections.defaultdict(list))
        for e in jl('dogmaEffects'):
            for m in e.get('modifierInfo') or []:
                f = FUNCS.get(m.get('func'))
                extra = m.get('groupID') if f == 2 else m.get('skillTypeID') if f in (3, 4) else None
                if extra:
                    self.sig[(f, DOMAINS.get(m.get('domain'), 5), m.get('modifiedAttributeID'), m.get('operation'))][extra].append(e['name'])

    def lt(self, x, f):
        return self.ltoks.get((2 if f == 2 else 3, x), [])

    def strong(self, et, f):
        """效果名里完整出现的技能 / 分组名，按出现顺序；被更长的名字包含的去掉（除非这些词在效果名里出现了不止一次）"""
        pool = self.gnames if f == 2 else self.skills
        hits = []
        for x in pool:
            lt = self.lt(x, f)
            if lt and set(lt) <= set(et):
                hits.append((x, set(lt), min(et.index(t) for t in lt)))
        hits = [h for h in hits if not any(h[1] < o[1] for o in hits) or any(et.count(t) > 1 for t in h[1])]
        return [h[0] for h in sorted(hits, key=lambda h: h[2])]

    def score(self, et, x, f, names):
        lt = set(self.lt(x, f))
        s = 3 * len(lt & set(et)) / len(lt) if lt else 0
        best = max((len(set(et) & set(toks(n))) / max(1, len(set(et) | set(toks(n)))) for n in names), default=0)
        return s + best + 0.001 * len(names)

    def pick(self, et, f, cands):
        strong = self.strong(et, f)
        both = [x for x in strong if x in cands]
        if f != 2 and strong:
            return both or strong
        if both:
            return both
        ranked = sorted(cands, key=lambda x: -self.score(et, x, f, cands[x]))
        return [x for x in ranked if (set(self.lt(x, f)) - SIZE) and (set(self.lt(x, f)) - SIZE) <= set(et)][:1]

    def mods(self, effect):
        """返回 (修正列表, 推断不出而丢弃的条数)"""
        out, done, dropped = [], set(), 0
        et = toks(effect['name'])
        for m in effect.get('modifiers') or []:
            f = FUNCS.get(m.get('func'))
            if f is None:
                continue
            key = (f, DOMAINS.get(m.get('domain'), 5), m.get('modified_attribute_id', 0), m.get('modifying_attribute_id', 0), m.get('operator', 0))
            if key in done:          # ESI 常把同一条修正重复列出
                continue
            done.add(key)
            if f not in (2, 3, 4):
                out.append([*key, 0])
                continue
            cands = self.sig.get((key[0], key[1], key[2], key[4]), {})
            picks = self.pick(et, f, cands) or ([MANUAL[effect['name']]] if f in (3, 4) and effect['name'] in MANUAL else [])
            dropped += not picks
            out += [[*key, x] for x in picks]
        return out, dropped


# ---------- 云计算效果的修正对象 ----------
# 云计算技能的效果名是「…from17926Cruor…」这种，按名字推断常常落到技能自己或别的尺寸上；技能描述写清了加成对象，按描述定
# （分组 / 技能 ID 取自 SDE）。描述里认不出对象的修正丢弃（少算好过加错）
TURRET = {('S', 'E'): 3303, ('M', 'E'): 3306, ('L', 'E'): 3309, ('C', 'E'): 20327,
          ('S', 'H'): 3301, ('M', 'H'): 3304, ('L', 'H'): 3307, ('C', 'H'): 21666,
          ('S', 'P'): 3302, ('M', 'P'): 3305, ('L', 'P'): 3308, ('C', 'P'): 21667,
          ('S', 'X'): 47870, ('M', 'X'): 47871, ('L', 'X'): 47872, ('C', 'X'): 52998}
# 导弹：(描述里的写法, 技能, 发射器分组)，按顺序认、认到就从描述里去掉
MISSILE = ((r'超大型巡航和鱼雷', [32435, 21668], [1674, 524]), (r'超大型巡航', [32435], [1674]), (r'超大型鱼雷', [21668], [524]),
           (r'重型攻击', [25719], [771]), (r'重型快速', [], [1245]), (r'轻型快速', [], [511]),
           (r'重型(?:导弹|、|，|和)', [3324], [510]), (r'轻型导弹', [3321], [509]), (r'火箭', [3320], [507]),
           (r'巡航', [3326], [506]), (r'鱼雷', [3325], [508]))
ATTR_NEUT, ATTR_NOS, ATTR_SPEED = 97, 90, 51


def cloud_turrets(t):
    t = t.replace('超大型', '')
    sizes = [v for k, v in (('小型', 'S'), ('中型', 'M'), ('重型熵能', 'L'), ('大型', 'L')) if k in t]
    races = [v for k, v in (('能量', 'E'), ('激光', 'E'), ('混合', 'H'), ('射弹', 'P'), ('熵能', 'X'), ('先驱者炮', 'X'), ('先驱者武器', 'X')) if k in t]
    sizes = sizes or (['S', 'M', 'L', 'C'] if '所有炮台' in t else ['S', 'M', 'L'])
    races = races or ['E', 'H', 'P', 'X']
    return sorted({TURRET[(a, b)] for a in sizes for b in races})


def cloud_missiles(t, launcher):
    out = []
    for pat, skills, groups in MISSILE:
        if re.search(pat, t):
            out += groups if launcher else skills
            t = re.sub(pat, '', t)
    if not out and not launcher and re.search(r'导弹|Missile', t):
        out = [3319]   # 只说「导弹」：所有导弹都要「导弹发射器操作」
    return sorted(set(out))


def cloud_targets(f, attr, t):
    """云计算修正的对象：f 2 分组（舰船上的装备）、3 技能（舰船上的装备）、4 技能（角色的弹药、无人机、探针）"""
    if f == 2:
        if '突击损' in t:
            return [60]
        if attr == ATTR_NEUT:
            return [71]
        if attr == ATTR_NOS:
            return [68]
        if '停滞缠绕光束' in t:
            return [65]
        if '超级武器' in t:
            return [588]
        if '增效剂' in t:
            return [303]
        if attr == ATTR_SPEED and '发射' in t:
            return cloud_missiles(t, True)
        if '炮台' in t:
            return [53, 74, 55, 1986]
        return []
    if f == 3:
        if '加力燃烧器' in t:
            return [3450, 3454]
        if '分析仪' in t:
            return [13278, 21718]
        if '装甲指挥' in t:
            return [20494]
        if '护盾指挥' in t:
            return [3350]
        if '立体炸弹' in t:
            return [3421]
        if '远程装甲' in t or '远距装甲' in t:
            return [16069, 24568]
        if '远程护盾' in t:
            return [3422, 24571]
        if '护盾回充增量器' in t:
            return [3416, 21802] if '旗舰级' in t else [3416]
        if '装甲维修器' in t:
            return [3393]
        if re.search(r'炮台|炮|熵能|武器', t):
            return cloud_turrets(t)
        return []
    if f == 4:
        if '停滞缠绕无人机' in t:
            return [3435]   # 缠绕无人机要「推进阻扰」，别的无人机不要
        if '无人机' in t or '铁骑' in t:
            sized = [v for k, v in (('轻型', 24241), ('中型', 33699), ('重型', 3441)) if k in t]
            extra = [v for k, v in (('岗哨', 23594), ('铁骑', 23069)) if k in t]
            # 没说大小：「战斗无人机」是轻中重三种；只说「无人机」（没提岗哨）是全部无人机
            if not sized:
                sized = [24241, 33699, 3441] if '战斗' in t else [] if 23594 in extra else [3436]
            return sorted(set(sized + extra))
        if '探针' in t:
            return [3412]
        return cloud_missiles(t, False)
    return []


def cloud_mods(effect, text):
    """云计算效果的修正：结构同 Inferer.mods，对象按技能描述（text）定"""
    out, done, dropped = [], set(), 0
    for m in effect.get('modifiers') or []:
        f = FUNCS.get(m.get('func'))
        if f is None:
            continue
        key = (f, DOMAINS.get(m.get('domain'), 5), m.get('modified_attribute_id', 0), m.get('modifying_attribute_id', 0), m.get('operator', 0))
        if key in done:
            continue
        done.add(key)
        if f not in (2, 3, 4):
            out.append([*key, 0])
            continue
        picks = cloud_targets(f, key[2], text)
        dropped += not picks
        out += [[*key, x] for x in picks]
    return out, dropped


UPDATED = []


def write_if_changed(path, data, compact=True):
    """内容变了才写；先写临时文件再改名，线上读文件的请求不会读到写了一半的"""
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':') if compact else None)
    if os.path.exists(path) and open(path, encoding='utf-8').read() == text:
        return False
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return True


def num(v):
    return int(v) if float(v).is_integer() else round(v, 6)


def clean_en(name, zh):
    return '' if not name or name == zh or re.fullmatch(r'item \d+', name) else name


def build(ds, sde, tq_ids):
    fit = json.load(open(os.path.join(ROOT, 'fit-data.json')))
    catalog = json.load(open(os.path.join(ROOT, 'catalog.json')))
    skill_data = json.load(open(os.path.join(ROOT, 'skill-data.json')))
    cache = Cache(ds)
    q = f'datasource={ds}'
    listed = all_ids(CN, ds) - tq_ids
    extra = sorted(listed | (new_ids(CN, ds, listed) - tq_ids))
    zh = dict(zip(extra, cache.many([f'{CN}/universe/types/{t}/?{q}&language=zh' for t in extra])))
    zh = {k: v for k, v in zh.items() if v and (v.get('published') or v.get('group_id') in ADAPT_GROUPS)}
    ids = sorted(zh)
    en = dict(zip(ids, cache.many([f'{CN}/universe/types/{t}/?{q}&language=en' for t in ids])))
    gids = sorted({t['group_id'] for t in zh.values()})
    groups = dict(zip(gids, cache.many([f'{CN}/universe/groups/{g}/?{q}&language=zh' for g in gids])))
    groups_en = dict(zip(gids, cache.many([f'{CN}/universe/groups/{g}/?{q}&language=en' for g in gids])))
    # 市场分组：物品所在分组及其全部上级
    markets, markets_en, todo = {}, {}, {t['market_group_id'] for t in zh.values() if t.get('market_group_id')}
    while todo:
        ms = sorted(todo - set(markets))
        for m, v, v_en in zip(ms, cache.many([f'{CN}/markets/groups/{m}/?{q}&language=zh' for m in ms]),
                              cache.many([f'{CN}/markets/groups/{m}/?{q}&language=en' for m in ms])):
            markets[m] = v or {'name': str(m)}
            markets_en[m] = v_en or {}
        todo = {v.get('parent_group_id') for v in markets.values() if v.get('parent_group_id')} - set(markets)

    names_en = {}

    def name_en(zh_name, en_name):
        e = clean_en(en_name, zh_name)
        if e:
            names_en.setdefault(zh_name, e)

    for t in ids:
        name_en(zh[t]['name'], (en.get(t) or {}).get('name'))
    for g in gids:
        if groups[g]:
            name_en(groups[g]['name'], (groups_en.get(g) or {}).get('name'))
    for m in markets:
        name_en(markets[m]['name'], markets_en[m].get('name'))

    # 物品目录
    cat_groups = {g['id']: g for g in catalog['groups']}
    out_cat = {}
    for t in ids:
        m = zh[t].get('market_group_id')
        if not m:
            continue
        chain = m
        while chain and chain not in cat_groups and chain not in out_cat:
            out_cat[chain] = {'id': chain, 'name': markets[chain]['name'], 'parentId': markets[chain].get('parent_group_id') or None, 'types': []}
            chain = markets[chain].get('parent_group_id')
        if m not in out_cat:
            out_cat[m] = {'id': m, 'name': cat_groups[m]['name'], 'parentId': cat_groups[m].get('parentId'), 'types': [], 'merge': True}
        out_cat[m]['types'].append({'id': t, 'name': zh[t]['name']})
    for g in out_cat.values():
        g['types'].sort(key=lambda x: x['id'])

    # 装配数据
    fit_ids = [t for t in ids if groups.get(zh[t]['group_id']) and groups[zh[t]['group_id']]['category_id'] in FIT_CATS]
    # 宁静服也有的舰船：读国服的属性与效果，不同的地方作补丁
    ship_ids = sorted(int(k) for k, v in fit['types'].items() if fit['groups'].get(str(v[2]), [0, 0])[1] == 6)
    cn_ships = {t: v for t, v in zip(ship_ids, cache.many([f'{CN}/universe/types/{t}/?{q}&language=zh' for t in ship_ids])) if v}
    eff_ids = sorted({e['effect_id'] for d in [*(zh[t] for t in fit_ids), *cn_ships.values()] for e in d.get('dogma_effects', [])} - {int(k) for k in fit['effects']})
    effects = {e: v for e, v in zip(eff_ids, cache.many([f'{CN}/dogma/effects/{e}/?{q}' for e in eff_ids])) if v}
    attr_ids = {a['attribute_id'] for d in [*(zh[t] for t in fit_ids), *cn_ships.values()] for a in d.get('dogma_attributes', [])} | set(BASE_FIELDS.values())
    for v in effects.values():
        for m in v.get('modifiers', []):
            attr_ids.update([m.get('modified_attribute_id', 0), m.get('modifying_attribute_id', 0)])
    attr_ids = sorted(attr_ids - {int(k) for k in fit['attrs']} - {0})
    attrs = {a: v for a, v in zip(attr_ids, cache.many([f'{CN}/dogma/attributes/{a}/?{q}' for a in attr_ids])) if v}

    cn_skills = {t: clean_en((en.get(t) or {}).get('name'), zh[t]['name']) or zh[t]['name'] for t in ids if groups.get(zh[t]['group_id'], {}).get('category_id') == 16}
    cn_groups = {g: (groups_en.get(g) or {}).get('name') or '' for g in gids}
    inf = Inferer(sde, cn_skills, cn_groups)
    out_eff, dropped = {}, 0
    # 云计算技能的效果：按技能名和描述定修正对象
    cloud_text = collections.defaultdict(str)
    for t in fit_ids:
        if zh[t]['group_id'] == CLOUD_GROUP:
            for x in zh[t].get('dogma_effects', []):
                # 只看描述（技能名常和描述对不上，如「断崖级能量武器伤害」实际是射弹炮台）；描述没有中文时才加上名字
                desc = (zh[t].get('description') or '').strip()
                cloud_text[x['effect_id']] += desc if re.search(r'[\u4e00-\u9fff]', desc) else f"{zh[t]['name']} {desc}"
    for e, v in effects.items():
        mods, n = cloud_mods(v, cloud_text[e]) if e in cloud_text else inf.mods(v)
        dropped += n
        out_eff[e] = [v['name'], v.get('effect_category', 0), mods]
    out_attrs = {a: [num(v.get('default_value', 0)), 1 if v.get('stackable', True) else 0, 1 if v.get('high_is_good', True) else 0, v.get('name', '')] for a, v in attrs.items()}

    out_types = {}
    for t in fit_ids:
        d = zh[t]
        a = {x['attribute_id']: num(x['value']) for x in d.get('dogma_attributes', [])}
        for field, aid in BASE_FIELDS.items():
            if d.get(field) is not None and aid not in a:
                a[aid] = num(d[field])
        effs = [x['effect_id'] for x in d.get('dogma_effects', []) if str(x['effect_id']) in fit['effects'] or x['effect_id'] in out_eff]
        dflt = next((x['effect_id'] for x in d.get('dogma_effects', []) if x.get('is_default')), 0)
        out_types[t] = [d['name'], clean_en((en.get(t) or {}).get('name'), d['name']), d['group_id'], d.get('market_group_id') or 0,
                        int(a.get(1692, 0)), {str(k): v for k, v in sorted(a.items())}, effs, dflt]
    patch = {}
    for t, d in cn_ships.items():
        old = fit['types'][str(t)]
        a = {str(x['attribute_id']): num(x['value']) for x in d.get('dogma_attributes', [])}
        dflt = lambda k: (fit['attrs'].get(k) or out_attrs.get(int(k)) or [0])[0]
        # 宁静服没有、值又等于默认值的属性（如 ESI 多列的 charge / shieldCharge = 0）不用补
        changed = {k: v for k, v in sorted(a.items(), key=lambda kv: int(kv[0])) if old[5].get(k) != v and (k in old[5] or v != dflt(k))}
        effs = [x['effect_id'] for x in d.get('dogma_effects', []) if str(x['effect_id']) in fit['effects'] or x['effect_id'] in out_eff]
        if changed or sorted(effs) != sorted(old[6]):
            patch[t] = [changed, effs if sorted(effs) != sorted(old[6]) else None]
    # 宁静服也有、限定舰船的装备：国服常把独有舰船加进可装配名单（如 ★提亚玛特级能装重型熵能分解者），只补这几项属性
    can_fit_ids = sorted(int(k) for k, v in fit['types'].items() if fit['groups'].get(str(v[2]), [0, 0])[1] != 6 and any(str(x) in v[5] for x in CAN_FIT))
    for t, d in zip(can_fit_ids, cache.many([f'{CN}/universe/types/{t}/?{q}&language=zh' for t in can_fit_ids])):
        if not d:
            continue
        old = fit['types'][str(t)][5]
        a = {str(x['attribute_id']): num(x['value']) for x in d.get('dogma_attributes', []) if x['attribute_id'] in CAN_FIT}
        changed = {k: v for k, v in sorted(a.items(), key=lambda kv: int(kv[0])) if old.get(k) != v}
        if changed:
            patch[t] = [changed, None]
    adapt = adapt_meta(ds, fit, out_types, zh, groups, markets)
    used_groups = {v[2] for v in out_types.values()} - {int(k) for k in fit['groups']}
    out_groups = {g: [groups[g]['name'], groups[g]['category_id']] for g in sorted(used_groups)}
    out_markets = {}
    for v in out_types.values():
        m = v[3]
        while m and str(m) not in fit['markets'] and m not in out_markets:
            mg = markets.get(m)
            if not mg:
                break
            out_markets[m] = [mg['name'], mg.get('parent_group_id') or 0]
            m = mg.get('parent_group_id')

    # 技能页
    have_sg = {int(k) for k in skill_data['groups']}
    sk = {}
    for t in fit_ids:
        if groups[zh[t]['group_id']]['category_id'] != 16 or zh[t]['group_id'] in ADAPT_GROUPS:   # 适性 / 云计算不进技能页
            continue
        v = out_types[t]
        a = {int(k): x for k, x in v[5].items()}
        sk[t] = [v[0], v[1] or v[0], v[2], int(a.get(SKILL_ATTRS['rank'], 1)), int(a.get(SKILL_ATTRS['pri'], 0)), int(a.get(SKILL_ATTRS['sec'], 0)), zh[t].get('description', '')]
    sk_groups = {g: groups[g]['name'] for g in sorted({v[2] for v in sk.values()} - have_sg)}

    data = {'server': ds,
            'catalog': {'groups': list(out_cat.values())},
            'fit': {'attrs': out_attrs, 'effects': out_eff, 'groups': out_groups, 'markets': out_markets, 'types': out_types,
                    'patch': patch, **({'adapt': adapt} if adapt else {})},
            'skills': {'skills': sk, 'groups': sk_groups}}
    if write_if_changed(os.path.join(ROOT, f'cn-extra-{ds}.json'), data):
        UPDATED.append(ds)
    ships = sum(1 for v in out_types.values() if out_groups.get(v[2], [0, 0])[1] == 6 or fit['groups'].get(str(v[2]), [0, 0])[1] == 6)
    print(f'{ds}: 独有物品 {len(ids)} · 目录分组 {len(out_cat)} · 装配物品 {len(out_types)}（舰船 {ships}）· 技能 {len(sk)}'
          f' · 新效果 {len(out_eff)}（丢弃无法推断的修正 {dropped} 条）· 新属性 {len(out_attrs)} · 补丁 {len(patch)}'
          + (f' · 适性 1 级技能 {len(adapt["max1"])} · 云计算 {len(adapt["cloud"])}' if adapt else ''))
    return names_en


def cloud_table():
    """官方「获得云计算能力的舰船」表：舰船中文名 -> (对象, 带宽)"""
    import html as H
    try:
        req = urllib.request.Request(CLOUD_NEWS, headers={'User-Agent': 'Mozilla/5.0'})
        page = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
    except Exception as e:  # noqa: BLE001
        print('云计算官方表读取失败', e, file=sys.stderr)
        return {}
    cells = [H.unescape(re.sub(r'<[^>]+>', '', c)).strip() for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', page, re.S)]
    out = {}
    for i in range(0, len(cells) - 3, 4):
        ship, _, bw, target = cells[i:i + 4]
        if bw.isdigit():
            out[ship] = (target, int(bw))
    return out


# 官方公告里写明的带宽 / 生效对象（游戏数据里没有，技能描述也没写的）：舰船中文名 -> (带宽或 None, 船级列表 / '*' 全部舰船 / None)
CLOUD_FIX = {
    '狂怒守卫者级': (40, ['Cruiser', 'Battlecruiser']),   # 2022-09-30 典藏宝箱公告：所有巡洋级别、带宽 40；之后「向上兼容一级」到战列巡洋舰
    '复仇女神级': (None, ['Cruiser', 'Battlecruiser']),   # 惩戒女神级（旧译名），2022-11-07：对所有巡洋和战列巡洋级别船体
    '传道者级': (None, ['Cruiser', 'Battlecruiser']),     # 2022-12-01：对所有巡洋和战列巡洋级别船体
    '加百列级': (None, ['Colossus', 'Dreadnought', 'Titan']),   # 2023-12-20：对巨像、无畏舰、长枪无畏舰、泰坦有效
    '变色龙级': (40, None),                               # 2024-04-09：★变色龙级的带宽「相比原版从 40 降低到了 30」
    '★变色龙级': (30, None),
}
CLASS_ZH = (('战列巡洋', 'Battlecruiser'), ('战列', 'Battleship'), ('巡洋', 'Cruiser'), ('驱逐', 'Destroyer'), ('护卫', 'Frigate'),
            ('工业', 'Industrial'), ('货舰', 'Freighter'), ('无畏', 'Dreadnought'), ('泰坦', 'Titan'), ('舰船', '*'))


def cloud_scope(desc):
    """技能描述里写了「所有战列舰的…」「所有巡洋、战列巡洋舰的…」「所有舰船释放的…」：返回船级列表或 '*'，没写返回 None（按同船级）"""
    m = re.search(r'所有([^，。的上]+?)(?:的|释放|上)', desc or '')
    if not m:
        return None
    out = []
    for part in re.split(r'[、和与及]', m.group(1)):
        hit = next((en for zh, en in CLASS_ZH if zh in part), None)
        if hit == '*':
            return '*'
        if hit and hit not in out:
            out.append(hit)
    return out or None


VARIANT = ('海军型', '舰队型')   # 「探索级海军型…」的来源是「探索级舰队型」，不能当成「探索级」
FACTION_WORDS = {'imperial', 'republic', 'federation', 'federal', 'caldari', 'state', 'navy', 'fleet', 'issue', 'n'}


def cloud_src_en(name, ships):
    """中文名对不上（旧译名「惩戒级」= 复仇级、「共和舰队火尾鸡」等）时按英文名找来源舰船：
    舰船英文名除势力词外的词都要出现在技能名里，且技能名第一个词属于舰船名；命中词多的优先（Slicer Navy → 帝国海军切割机级）"""
    words = re.findall(r"[a-z0-9]+", (name or '').lower())
    first = next((w for w in words if w != 'n'), None)
    have, best = set(words), None
    for sid, v in ships.items():
        sw = set(re.findall(r"[a-z0-9]+", (v[1] or '').lower()))
        core = sw - FACTION_WORDS
        if not core or not core <= have or first not in sw:
            continue
        score = (len(sw & have), -len(sw - have))
        if best is None or score > best[0]:
            best = (score, sid)
    return best and best[1]


EMPIRE = {'Amarr', 'Caldari', 'Gallente', 'Minmatar'}


def adapt_meta(ds, fit, out_types, zh, groups, markets):
    """适性技能的等级上限、云计算技能的来源舰船 / 生效范围 / 带宽（没有这两组技能的服务器返回 None）"""
    adapt = [t for t in out_types if zh[t]['group_id'] in ADAPT_GROUPS]
    if not adapt:
        return None
    max1 = sorted(t for t in adapt if zh[t]['group_id'] != CLOUD_GROUP and '解锁' in (zh[t].get('description') or ''))
    category = lambda g: (fit['groups'].get(str(g)) or [0, (groups.get(g) or {}).get('category_id', 0)])[1]
    allt = {**{int(k): v for k, v in fit['types'].items()}, **out_types}
    ships = {t: v for t, v in allt.items() if category(v[2]) == 6}
    hulls = {t: list(m.groups()) for t, v in allt.items() if (m := HULL_RE.match(v[1] or ''))}
    hulls.update({t: ['', 'Colossus'] for t, v in allt.items() if v[1] == 'Colossus'})   # 曙光的旗舰船级「巨像」，不分种族
    table = cloud_table()
    market_name = lambda m: (fit['markets'].get(str(m)) or [(markets.get(m) or {}).get('name', '')])[0]
    # 长名优先：「磨难级海军型」先于「磨难级」；技能名也常省掉「级」（「达玛维克装甲值…」）
    by_name = sorted(((n, t) for t, v in ships.items() for n in {v[0], v[0].removesuffix('级')} if len(n) > 1), key=lambda x: -len(x[0]))
    cloud, unknown = {}, 0
    for t in adapt:
        if zh[t]['group_id'] != CLOUD_GROUP:
            continue
        name = zh[t]['name']
        src = next((sid for n, sid in by_name if name.startswith(n) and not name[len(n):].lstrip('级').startswith(VARIANT)), None)
        src = src or cloud_src_en(out_types[t][1], ships)
        if not src:
            unknown += 1
            continue
        v = ships[src]
        races = {hulls[int(v[5][k])][0] for k in REQ_SKILLS if v[5].get(k) and int(v[5][k]) in hulls} - {''}
        row = table.get(v[0]) or table.get(v[0].replace('鲛', '蛟').replace('萨', '撒'))   # 公告和游戏里个别字写法不同
        if row:
            target, bw = row
            every = int(target.startswith('全部'))
        elif market_name(v[3]).startswith('特别版'):   # 典藏 / 活动船，四族通用
            every, bw = 1, 40
        elif v[4] == 2:
            every, bw = int(len(races) > 1), 30
        elif not races or not races <= EMPIRE or len(races) > 1:   # 海盗、三神裔、伊甸联合等非帝国海军势力
            every, bw = 1, 35
        elif v[4] == 4 and re.search(r'Navy|Fleet', v[1] or ''):   # 帝国海军型 / 舰队型
            every, bw = 0, 25
        elif v[4] == 4:   # 单族的其他势力船
            every, bw = 1, 35
        elif v[4] in (0, 1):   # T1（宁静服数据里部分 T1 没有元组）
            every, bw = 0, 20
        else:   # T3
            every, bw = 0, 35
        fix_bw, scope = CLOUD_FIX.get(v[0], (None, None))
        scope = scope or cloud_scope(zh[t].get('description'))
        # 来源舰船没有任何船体技能（赛季船、游艇等），也没写对象：按全部舰船（同系列的星耀级写的就是「所有舰船」）
        if not scope and not any(v[5].get(k) and int(v[5][k]) in hulls for k in REQ_SKILLS):
            scope = '*'
        cloud[t] = [src, every, fix_bw or bw] + ([scope] if scope else [])
    if unknown:
        print(f'{ds}: {unknown} 个云计算技能找不到来源舰船（多为没有名称的 CloudComputingBoundItem），不生效')
    return {'max1': max1, 'cloud': cloud, 'hulls': hulls}


def main():
    global ROOT, CACHE, REFRESH
    import argparse
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument('sde')
    ap.add_argument('servers', nargs='*', default=['serenity', 'infinity'])
    ap.add_argument('--root')
    ap.add_argument('--cache')
    ap.add_argument('--refresh-hours', type=float, default=0)
    args = ap.parse_args()
    ROOT = os.path.abspath(args.root or ROOT)
    CACHE = os.path.abspath(args.cache or CACHE)
    sde, servers = args.sde, args.servers or ['serenity', 'infinity']
    stamp = os.path.join(CACHE, 'last-refresh')
    if args.refresh_hours and (not os.path.exists(stamp) or time.time() - os.path.getmtime(stamp) > args.refresh_hours * 3600):
        REFRESH = True
        print('全量刷新：忽略缓存重读全部物品')
    tq_ids = all_ids(TQ, 'tranquility')
    if len(tq_ids) < 10000:   # 宁静 ESI 没读到：国服物品会全被当成独有，宁可这次不更新
        sys.exit('宁静 ESI 物品列表读取失败，本次不更新')
    names = {}
    for ds in servers:
        for k, v in build(ds, sde, tq_ids).items():
            names.setdefault(k, v)
    cn_path = os.path.join(ROOT, 'i18n', 'names-en-cn.json')
    old = json.load(open(cn_path)) if os.path.exists(cn_path) else {}
    old.update(names)
    write_if_changed(cn_path, old)
    main_path = os.path.join(ROOT, 'i18n', 'names-en.json')
    full = json.load(open(main_path))
    added = 0
    for k, v in old.items():
        if k not in full:
            full[k] = v
            added += 1
    if added:
        write_if_changed(main_path, full)
    print(f'英文名：国服独有 {len(old)} 条，新并入 names-en.json {added} 条')
    if REFRESH:
        os.makedirs(CACHE, exist_ok=True)
        open(stamp, 'w').close()
    print('已更新：' + '、'.join(UPDATED) if UPDATED else '没有变化')


if __name__ == '__main__':
    main()
