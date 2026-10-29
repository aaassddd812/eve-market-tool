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
    fit.adapt.cloud: { 技能: [来源舰船, 对该级别全部种族(0/1), 带宽] }；fit.adapt.hulls: { 种族船体技能: [种族, 级别] }
    生效对象：与来源舰船同级别（按种族船体技能），T1 / T2 / 海军型只对本族；需要两族技能的（海盗船）对全部种族；
    官方列出过的舰船按官方表格（CLOUD_NEWS）。带宽：官方表格有的按表格，否则 T1 20、海军型 25、T2 30、其他势力 35
另外 fit.patch: { 已有舰船: [{ 属性: 国服值 }, [国服效果列表]] }：宁静服也有的舰船在国服的属性值 / 效果不同时（适性属性与效果、数值调整）按国服覆盖。
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
SKILL_ATTRS = {'rank': 275, 'pri': 180, 'sec': 181}
ADAPT_GROUPS = {4160, 4196}   # 舰船适性、云计算（曙光）
CLOUD_GROUP = 4196
CLOUD_NEWS = 'https://evepc.163.com/shuguang/news/20231116/38678_1120400.html'
REQ_SKILLS = ('182', '183', '184', '1285', '1289', '1290')
HULL_RE = re.compile(r'^(Amarr|Caldari|Gallente|Minmatar|Precursor|ORE|Jove|Upwell|EDENCOM|Triglavian) (Frigate|Destroyer|Cruiser|Battlecruiser|Battleship|Carrier|Dreadnought|Titan|Force Auxiliary|Industrial|Hauler|Freighter)$')


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
    for e, v in effects.items():
        mods, n = inf.mods(v)
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
    adapt = adapt_meta(ds, fit, out_types, zh, groups)
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
          f' · 新效果 {len(out_eff)}（丢弃无法推断的修正 {dropped} 条）· 新属性 {len(out_attrs)} · 舰船补丁 {len(patch)}'
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


def adapt_meta(ds, fit, out_types, zh, groups):
    """适性技能的等级上限、云计算技能的来源舰船 / 生效范围 / 带宽（没有这两组技能的服务器返回 None）"""
    adapt = [t for t in out_types if zh[t]['group_id'] in ADAPT_GROUPS]
    if not adapt:
        return None
    max1 = sorted(t for t in adapt if zh[t]['group_id'] != CLOUD_GROUP and '解锁' in (zh[t].get('description') or ''))
    category = lambda g: (fit['groups'].get(str(g)) or [0, (groups.get(g) or {}).get('category_id', 0)])[1]
    allt = {**{int(k): v for k, v in fit['types'].items()}, **out_types}
    ships = {t: v for t, v in allt.items() if category(v[2]) == 6}
    hulls = {t: list(m.groups()) for t, v in allt.items() if (m := HULL_RE.match(v[1] or ''))}
    table = cloud_table()
    by_name = sorted(((v[0], t) for t, v in ships.items()), key=lambda x: -len(x[0]))   # 长名优先：「磨难级海军型」先于「磨难级」
    cloud, unknown = {}, 0
    for t in adapt:
        if zh[t]['group_id'] != CLOUD_GROUP:
            continue
        src = next((sid for n, sid in by_name if zh[t]['name'].startswith(n)), None)
        if not src:
            unknown += 1
            continue
        v = ships[src]
        races = {hulls[int(v[5][k])][0] for k in REQ_SKILLS if v[5].get(k) and int(v[5][k]) in hulls}
        if v[0] in table:
            target, bw = table[v[0]]
            every = int(target.startswith('全部'))
        else:
            every = int(len(races) > 1)
            bw = {1: 20, 2: 30}.get(v[4], 25 if v[4] == 4 and len(races) == 1 else 35)
        cloud[t] = [src, every, bw]
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
