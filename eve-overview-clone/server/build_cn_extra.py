#!/usr/bin/env python3
"""国服（晨曦 / 曙光）独有的舰船、装备、技能等：CCP 的 SDE 里没有，只能从网易 ESI 读取，生成 cn-extra-<服>.json。

用法：python3 server/build_cn_extra.py <SDE 解压目录> [serenity] [infinity]
  （在 eve-overview-clone 目录下运行；ESI 结果缓存在 server/.cn-cache/，重跑只请求新增的物品）

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
"""
import collections
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'server', '.cn-cache')
TQ = 'https://esi.evetech.net/latest'
CN = 'https://ali-esi.evepc.163.com/latest'
FIT_CATS = {6, 7, 8, 16, 18, 20, 32, 87}    # 与 build_fit_data.py 相同
FUNCS = {'ItemModifier': 0, 'LocationModifier': 1, 'LocationGroupModifier': 2,
         'LocationRequiredSkillModifier': 3, 'OwnerRequiredSkillModifier': 4}
DOMAINS = {'itemID': 0, 'shipID': 1, 'charID': 2, 'otherID': 3, 'structureID': 4, 'targetID': 5, 'target': 5}
BASE_FIELDS = {'mass': 4, 'capacity': 38, 'volume': 161, 'radius': 162}
SKILL_ATTRS = {'rank': 275, 'pri': 180, 'sec': 181}


# ---------- ESI（带磁盘缓存）----------
def fetch(url):
    err = None
    for _ in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'EVE-Market-Tool build_cn_extra'}), timeout=30) as r:
                return json.load(r), r.headers
        except urllib.error.HTTPError as e:
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

    def many(self, urls, threads=16):
        todo = [u for u in dict.fromkeys(urls) if u not in self.data]
        with cf.ThreadPoolExecutor(threads) as ex:
            for u, (v, _) in zip(todo, ex.map(fetch, todo)):
                if v is not None:
                    if '/universe/types/' not in u:   # 分组 / 市场分组自带的成员列表用不上
                        v.pop('types', None)
                        v.pop('groups', None)
                    self.data[u] = v
        if todo:
            os.makedirs(CACHE, exist_ok=True)
            json.dump(self.data, open(self.path, 'w'), ensure_ascii=False)
        return [self.data.get(u) for u in urls]


def all_ids(base, ds):
    first, h = fetch(f'{base}/universe/types/?datasource={ds}&page=1')
    out = set(first)
    with cf.ThreadPoolExecutor(8) as ex:
        for x in ex.map(lambda p: fetch(f'{base}/universe/types/?datasource={ds}&page={p}')[0], range(2, int(h['x-pages']) + 1)):
            out |= set(x or [])
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
            strong = self.strong(et, f)
            both = [x for x in strong if x in cands]
            if f != 2 and strong:
                picks = both or strong
            elif both:
                picks = both
            else:
                ranked = sorted(cands, key=lambda x: -self.score(et, x, f, cands[x]))
                picks = [x for x in ranked if (set(self.lt(x, f)) - SIZE) and (set(self.lt(x, f)) - SIZE) <= set(et)][:1]
            dropped += not picks
            out += [[*key, x] for x in picks]
        return out, dropped


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
    extra = sorted(all_ids(CN, ds) - tq_ids)
    zh = dict(zip(extra, cache.many([f'{CN}/universe/types/{t}/?{q}&language=zh' for t in extra])))
    zh = {k: v for k, v in zh.items() if v and v.get('published')}
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
    eff_ids = sorted({e['effect_id'] for t in fit_ids for e in zh[t].get('dogma_effects', [])} - {int(k) for k in fit['effects']})
    effects = {e: v for e, v in zip(eff_ids, cache.many([f'{CN}/dogma/effects/{e}/?{q}' for e in eff_ids])) if v}
    attr_ids = {a['attribute_id'] for t in fit_ids for a in zh[t].get('dogma_attributes', [])} | set(BASE_FIELDS.values())
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
        if groups[zh[t]['group_id']]['category_id'] != 16:
            continue
        v = out_types[t]
        a = {int(k): x for k, x in v[5].items()}
        sk[t] = [v[0], v[1] or v[0], v[2], int(a.get(SKILL_ATTRS['rank'], 1)), int(a.get(SKILL_ATTRS['pri'], 0)), int(a.get(SKILL_ATTRS['sec'], 0)), zh[t].get('description', '')]
    sk_groups = {g: groups[g]['name'] for g in sorted({v[2] for v in sk.values()} - have_sg)}

    data = {'server': ds,
            'catalog': {'groups': list(out_cat.values())},
            'fit': {'attrs': out_attrs, 'effects': out_eff, 'groups': out_groups, 'markets': out_markets, 'types': out_types},
            'skills': {'skills': sk, 'groups': sk_groups}}
    with open(os.path.join(ROOT, f'cn-extra-{ds}.json'), 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    ships = sum(1 for v in out_types.values() if out_groups.get(v[2], [0, 0])[1] == 6 or fit['groups'].get(str(v[2]), [0, 0])[1] == 6)
    print(f'{ds}: 独有物品 {len(ids)} · 目录分组 {len(out_cat)} · 装配物品 {len(out_types)}（舰船 {ships}）· 技能 {len(sk)}'
          f' · 新效果 {len(out_eff)}（丢弃无法推断的修正 {dropped} 条）· 新属性 {len(out_attrs)}')
    return names_en


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sde = sys.argv[1]
    servers = sys.argv[2:] or ['serenity', 'infinity']
    tq_ids = all_ids(TQ, 'tranquility')
    names = {}
    for ds in servers:
        for k, v in build(ds, sde, tq_ids).items():
            names.setdefault(k, v)
    cn_path = os.path.join(ROOT, 'i18n', 'names-en-cn.json')
    old = json.load(open(cn_path)) if os.path.exists(cn_path) else {}
    old.update(names)
    json.dump(old, open(cn_path, 'w'), ensure_ascii=False, separators=(',', ':'))
    main_path = os.path.join(ROOT, 'i18n', 'names-en.json')
    full = json.load(open(main_path))
    added = 0
    for k, v in old.items():
        if k not in full:
            full[k] = v
            added += 1
    json.dump(full, open(main_path, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'英文名：国服独有 {len(old)} 条，新并入 names-en.json {added} 条')


if __name__ == '__main__':
    main()
