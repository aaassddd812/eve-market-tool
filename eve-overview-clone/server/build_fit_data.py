#!/usr/bin/env python3
"""从 CCP 官方静态数据（SDE，JSON Lines 版）生成模拟装配用的 fit-data.json。

用法：
  1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip
  2. python3 server/build_fit_data.py <sde.zip> fit-data.json

只收录已发布的舰船、装备、弹药、无人机、子系统、技能与植入体，以及它们用到的属性和效果。
输出格式（数组尽量紧凑，前端 js/fit-engine.js 解析）：
  char:    { 属性: 值 }  角色本身的基础属性
  attrs:   { id: [默认值, 可叠加(0/1), 越高越好(0/1), 名称] }
  effects: { id: [名称, 分类, [[func, domain, 被修改属性, 修改属性, 运算, 分组或技能], ...]] }
  groups:  { id: [中文名, 分类] }
  markets: { id: [中文名, 父级] }
  types:   { id: [中文名, 英文名, 分组, 市场分组, 科技等级/派系等级, { 属性: 值 }, [效果], 默认效果] }
  env:     天象（星系环境 / 泰坦天象发生器 / 主权升级 / 活动），见 build_env
  dbuffs:  { id: [中文名, 英文名, 运算, 取最大(1)/最小(0), [[func, 被修改属性, 分组或技能], ...]] }  指挥脉冲波 / 天象发生器的舰队加成定义
"""

import json
import re
import sys
import zipfile

CATEGORIES = {6, 7, 8, 16, 18, 20, 32, 87}    # 舰船、装备、弹药、技能、无人机、植入体、子系统、铁骑舰载机
SHIP_MODES = 1306                             # 舰船模式（防御 / 狙击 / 高速）
FUNCS = {'ItemModifier': 0, 'LocationModifier': 1, 'LocationGroupModifier': 2,
         'LocationRequiredSkillModifier': 3, 'OwnerRequiredSkillModifier': 4}
DOMAINS = {'itemID': 0, 'shipID': 1, 'charID': 2, 'otherID': 3, 'structureID': 4, 'targetID': 5, 'target': 5}
# 类型基础字段对应的属性：质量、容量、体积、半径
BASE_FIELDS = {'mass': 4, 'capacity': 38, 'volume': 161, 'radius': 162}


def read(z, name):
    with z.open(name) as fh:
        for line in fh:
            yield json.loads(line)


def zh(value):
    if isinstance(value, dict):
        return value.get('zh') or value.get('en') or ''
    return value or ''


def en(value):
    if isinstance(value, dict):
        return value.get('en') or ''
    return value or ''


def num(v):
    return int(v) if float(v).is_integer() else round(v, 6)


def main(src, dst):
    z = zipfile.ZipFile(src)
    groups = {g['_key']: g for g in read(z, 'groups.jsonl')}
    types = {}
    all_types = {}
    for t in read(z, 'types.jsonl'):
        all_types[t['_key']] = t
        g = groups.get(t['groupID'])
        # 战术驱逐舰等的舰船模式（分组 1306 舰船模式切换器）在 SDE 里是未发布的，但驾驶模拟 / 装配要用它的加成，照样收录
        if (t.get('published') or t['groupID'] == SHIP_MODES) and g and g['categoryID'] in CATEGORIES and g.get('published', True):
            types[t['_key']] = t
    CHARACTER = 1373                                  # 角色本身（同时锁定数、导弹伤害倍数等基础属性）
    dogma = {d['_key']: d for d in read(z, 'typeDogma.jsonl') if d['_key'] in types or d['_key'] == CHARACTER}
    char_attrs = {a['attributeID']: num(a['value']) for a in dogma.pop(CHARACTER, {}).get('dogmaAttributes', [])}
    effects_all = {e['_key']: e for e in read(z, 'dogmaEffects.jsonl')}
    attrs_all = {a['_key']: a for a in read(z, 'dogmaAttributes.jsonl')}
    markets_all = {m['_key']: m for m in read(z, 'marketGroups.jsonl')}

    used_effects, used_attrs = set(), set(BASE_FIELDS.values())
    out_types = {}
    for tid, t in types.items():
        d = dogma.get(tid, {})
        attrs = {a['attributeID']: num(a['value']) for a in d.get('dogmaAttributes', [])}
        for field, aid in BASE_FIELDS.items():
            if t.get(field) is not None and aid not in attrs:
                attrs[aid] = num(t[field])
        effs = [e['effectID'] for e in d.get('dogmaEffects', []) if e['effectID'] in effects_all]
        default = next((e['effectID'] for e in d.get('dogmaEffects', []) if e.get('isDefault')), 0)
        used_effects.update(effs)
        used_attrs.update(attrs)
        meta = t.get('metaGroupID') or 0
        out_types[tid] = [zh(t['name']), en(t['name']), t['groupID'], t.get('marketGroupID') or 0, meta,
                          {str(k): v for k, v in sorted(attrs.items())}, effs, default]

    out_effects = {}
    for eid in sorted(used_effects):
        e = effects_all[eid]
        mods = []
        for m in e.get('modifierInfo') or []:
            func = FUNCS.get(m.get('func'))
            if func is None:
                continue
            extra = m.get('groupID') if func == 2 else m.get('skillTypeID') if func in (3, 4) else 0
            mods.append([func, DOMAINS.get(m.get('domain'), 5), m.get('modifiedAttributeID', 0),
                         m.get('modifyingAttributeID', 0), m.get('operation', 0), extra or 0])
            used_attrs.update([m.get('modifiedAttributeID', 0), m.get('modifyingAttributeID', 0)])
        out_effects[eid] = [e['name'], e.get('effectCategoryID', 0), mods]

    out_attrs = {}
    for aid in sorted(used_attrs):
        a = attrs_all.get(aid)
        if a:
            out_attrs[aid] = [num(a.get('defaultValue', 0)), 1 if a.get('stackable', True) else 0,
                              1 if a.get('highIsGood', True) else 0, a.get('name', '')]

    env = build_env(z, all_types, groups, attrs_all, effects_all)
    dbuffs = build_dbuffs(z)
    used_attrs.update(m[1] for d in dbuffs.values() for m in d[4])
    used_attrs.update(m[2] for e in env['items'].values() for m in e[3])
    for aid in sorted(used_attrs - set(out_attrs)):
        a = attrs_all.get(aid)
        if a:
            out_attrs[aid] = [num(a.get('defaultValue', 0)), 1 if a.get('stackable', True) else 0,
                              1 if a.get('highIsGood', True) else 0, a.get('name', '')]

    used_attrs.update(char_attrs)
    used_groups = {t[2] for t in out_types.values()}
    out_groups = {gid: [zh(groups[gid]['name']), groups[gid]['categoryID']] for gid in sorted(used_groups)}

    used_markets = set()
    for t in out_types.values():
        mid = t[3]
        while mid and mid not in used_markets and mid in markets_all:
            used_markets.add(mid)
            mid = markets_all[mid].get('parentGroupID')
    out_markets = {mid: [zh(markets_all[mid]['name']), markets_all[mid].get('parentGroupID') or 0] for mid in sorted(used_markets)}

    data = {'char': {str(k): v for k, v in sorted(char_attrs.items())}, 'attrs': out_attrs, 'effects': out_effects, 'groups': out_groups, 'markets': out_markets, 'types': out_types, 'env': env, 'dbuffs': dbuffs}
    with open(dst, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'env {len(env["items"])} · types {len(out_types)} · effects {len(out_effects)} · attrs {len(out_attrs)} · groups {len(out_groups)} · markets {len(out_markets)}')


def build_dbuffs(z):
    out = {}
    for d in read(z, 'dbuffCollections.jsonl'):
        op = OPS.get(d.get('operationName'))
        mods = [[0, m['dogmaAttributeID'], 0] for m in d.get('itemModifiers', [])]
        mods += [[1, m['dogmaAttributeID'], 0] for m in d.get('locationModifiers', [])]
        mods += [[2, m['dogmaAttributeID'], m['groupID']] for m in d.get('locationGroupModifiers', [])]
        mods += [[3, m['dogmaAttributeID'], m['skillID']] for m in d.get('locationRequiredSkillModifiers', [])]
        if op is None or not mods:
            continue
        name = d.get('displayName') or {}
        out[d['_key']] = [name.get('zh') or name.get('en') or d.get('developerDescription', ''), name.get('en') or d.get('developerDescription', ''),
                          op, 1 if d.get('aggregateMode') == 'Maximum' else 0, mods]
    return out


# ---------- 天象 ----------
# 输出 env：
#   items: { id: [中文名, 英文名, 分类, [[func, domain, 被修改属性, 运算, 数值, 分组或技能, 适用名单], ...], [[中文说明, 英文说明], ...]] }
#   lists: { 名单: [包含的舰船 ID 或 null（全部舰船）, 排除的舰船 ID] }
# 分类：wh 虫洞、storm 超阈限风暴、abyss 深渊天气、space 其他星系环境（三神裔入侵、波赫文等）、titan 泰坦天象发生器、sov 主权升级、fw 势力战争、event 活动
# 效果信标（虫洞、风暴、入侵）按类型自身的 dogma 效果（数值取信标属性）；泰坦天象发生器与星系范围效果（systemWideEffects）按 dbuff 定义（数值随 dbuff 给出）
WH_STAR = {'Pulsar': ['脉冲星', 'Pulsar'], 'Black Hole': ['黑洞', 'Black Hole'], 'Cataclysmic Variable': ['激变变星', 'Cataclysmic Variable'],
           'Magnetar': ['磁星', 'Magnetar'], 'Red Giant': ['红巨星', 'Red Giant'], 'Wolf Rayet': ['沃尔夫-拉叶星', 'Wolf-Rayet']}
ENV_SPACE = {52247: 'space', 52248: 'space', 52249: 'space', 74002: 'space', 54215: 'event'}
ENV_NAMES = {   # SDE 里没有正式名称（DO NOT TRANSLATE）的，两条合成一项
    'pochven': (['波赫文', 'Pochven'], 'space', [87164, 92460]),
    'minor': (['三神裔小胜星系', 'Triglavian Minor Victory'], 'space', [87177, 92459]),
    'election': (['盖伦特大选', 'Gallente Election'], 'event', [92269]),
    'cdayA': (['飞行员节 · 艾玛', 'Capsuleer Day · Amarr'], 'event', [93253]),
    'cdayC': (['飞行员节 · 加达里', 'Capsuleer Day · Caldari'], 'event', [93254]),
    'cdayM': (['飞行员节 · 米玛塔尔', 'Capsuleer Day · Minmatar'], 'event', [93255]),
}
ENV_FW = [92536, 92605, 92606, 92607, 90144, 90145, 90146, 90147]
TITAN_PG = 1815
# 深渊天气：信标类型名是开发代号（darkness_weather_1 …），正式名称取深渊环境分组 1983 里同种天气的类型；1～3 为强度档（弱 / 中 / 强）
ABYSS_WEATHER = {'darkness': 47863, 'electric_storm': 47865, 'caustic_toxin': 47862, 'xenon_gas': 47866, 'infernal': 47864}
ABYSS_LEVEL = [['弱', 'Weak'], ['中', 'Medium'], ['强', 'Strong']]
OPS = {'PreAssignment': -1, 'PreMul': 0, 'PreDiv': 1, 'ModAdd': 2, 'ModSub': 3, 'PostMul': 4, 'PostDiv': 5, 'PostPercent': 6, 'PostAssignment': 7}
# 主权中心的稳定发生器没有 dogma 数据，按游戏内说明（与深渊同名天气相似）
SOV = {
    87815: [[0, 1, 263, 6, 5, 0], [3, 1, 68, 6, 5, 3416], [0, 1, 482, 6, 10, 0]],     # 伽玛：护盾值 +5%、本地护盾回充量 +5%、电容容量 +10%
    87949: [[0, 1, 265, 6, 5, 0], [3, 1, 84, 6, 5, 3393]],                          # 等离子：装甲值 +5%、本地装甲维修量 +5%（超载加成 +10% 不计）
    87950: [[0, 1, 55, 5, 1.25, 0], [0, 1, 76, 6, 25, 0]],                          # 电力：电容回充速度 +25%、锁定距离 +25%
    87951: [[0, 1, 564, 6, 25, 0], [0, 1, 600, 2, 2, 0]],                           # 异种：扫描分辨率 +25%、跃迁速度 +2 AU/s
}
RESONANCE = {'shield': [271, 274, 273, 272], 'armor': [267, 270, 269, 268], 'hull': [113, 110, 109, 111]}
LAYER = {'shield': ['护盾', 'Shield'], 'armor': ['装甲', 'Armor'], 'hull': ['结构', 'Hull']}
DMG = [['电磁', 'EM'], ['热能', 'Thermal'], ['动能', 'Kinetic'], ['爆炸', 'Explosive']]


def build_env(z, all_types, groups, attrs_all, effects_all):
    dogma = {d['_key']: d for d in read(z, 'typeDogma.jsonl')}
    dbuffs = {d['_key']: d for d in read(z, 'dbuffCollections.jsonl')}
    wide = {d['_key']: d for d in read(z, 'systemWideEffects.jsonl')}
    type_lists = {d['_key']: d for d in read(z, 'typeLists.jsonl')}
    lists = {}

    def elig(list_id):
        """适用名单：全部舰船返回 0；否则登记并返回名单 ID"""
        tl = type_lists.get(list_id)
        if not tl:
            return 0
        inc = tl.get('includedTypeIDs')
        exc = tl.get('excludedTypeIDs') or []
        if not inc and not exc and 6 in (tl.get('includedCategoryIDs') or []):
            return 0
        lists[list_id] = [sorted(inc) if inc else None, sorted(exc)]
        return list_id

    def beacon_mods(tid):
        d = dogma.get(tid, {})
        vals = {a['attributeID']: a['value'] for a in d.get('dogmaAttributes', [])}
        out = []
        for e in d.get('dogmaEffects', []):
            for m in (effects_all.get(e['effectID']) or {}).get('modifierInfo') or []:
                func = FUNCS.get(m.get('func'))
                src = m.get('modifyingAttributeID')
                if func is None or src not in vals:
                    continue
                extra = m.get('groupID') if func == 2 else m.get('skillTypeID') if func in (3, 4) else 0
                out.append([func, DOMAINS.get(m.get('domain'), 5), m['modifiedAttributeID'], m.get('operation', 0), num(vals[src]), extra or 0, 0])
        return out

    def buff_mods(buff_id, value, list_id=0):
        b = dbuffs.get(buff_id)
        op = OPS.get(b and b.get('operationName'))
        if op is None:
            return []
        out = [[0, 1, m['dogmaAttributeID'], op, num(value), 0, list_id] for m in b.get('itemModifiers', [])]
        out += [[1, 1, m['dogmaAttributeID'], op, num(value), 0, list_id] for m in b.get('locationModifiers', [])]
        out += [[2, 1, m['dogmaAttributeID'], op, num(value), m['groupID'], list_id] for m in b.get('locationGroupModifiers', [])]
        out += [[3, 1, m['dogmaAttributeID'], op, num(value), m['skillID'], list_id] for m in b.get('locationRequiredSkillModifiers', [])]
        return out

    def wide_mods(tid):
        w = wide.get(tid)
        if not w or not w.get('dbuffs'):
            return []
        lid = elig(w.get('eligibleTypeListID'))
        return [m for x in w['dbuffs'] for m in buff_mods(x['_key'], x['_value'], lid)]

    items = {}
    for tid, t in sorted(all_types.items()):
        n = en(t['name'])
        m = re.match(r'Class (\d) (.+) Effects$', n)
        if t['groupID'] == 920 and m and m.group(2) in WH_STAR:
            star = WH_STAR[m.group(2)]
            items[tid] = [f'C{m.group(1)} {star[0]}', f'C{m.group(1)} {star[1]}', 'wh', beacon_mods(tid) + wide_mods(tid)]
        elif t['groupID'] == 920 and 'Metaliminal' in n and 'Yoiul' not in n:
            items[tid] = [zh(t['name']), n, 'storm', beacon_mods(tid) + wide_mods(tid)]
        elif tid in ENV_SPACE:
            items[tid] = [zh(t['name']), n, ENV_SPACE[tid], beacon_mods(tid) + wide_mods(tid)]
        elif tid in ENV_FW:
            items[tid] = [zh(t['name']), n, 'fw', beacon_mods(tid) + wide_mods(tid)]
        elif (m := re.match(r'(\w+)_weather_([123])$', n)) and m.group(1) in ABYSS_WEATHER:
            # 每个天气信标两组加成：属性 2468 / 2470 是 dbuff ID，2469 / 2471 是数值（同泰坦天象发生器）
            vals = {a['attributeID']: a['value'] for a in dogma.get(tid, {}).get('dogmaAttributes', [])}
            mods = []
            for ida, va in ((2468, 2469), (2470, 2471)):
                if vals.get(ida):
                    mods += buff_mods(int(vals[ida]), vals.get(va, 0))
            w, lv = all_types[ABYSS_WEATHER[m.group(1)]]['name'], ABYSS_LEVEL[int(m.group(2)) - 1]
            items[tid] = [f'{zh(w)} · {lv[0]}', f'{en(w)} · {lv[1]}', 'abyss', mods]
        elif t['groupID'] == TITAN_PG and t.get('published'):
            vals = {a['attributeID']: a['value'] for a in dogma.get(tid, {}).get('dogmaAttributes', [])}
            mods = []
            for ida, va in ((2468, 2469), (2470, 2471), (2472, 2473), (2536, 2537)):
                if vals.get(ida):
                    mods += buff_mods(int(vals[ida]), vals.get(va, 0))
            items[tid] = [zh(t['name']), n, 'titan', mods]
        elif tid in SOV:
            items[tid] = [zh(t['name']), n, 'sov', [m + [0] for m in SOV[tid]]]
    for key, (names, cat, ids) in ENV_NAMES.items():
        mods = [m for i in ids for m in beacon_mods(i) + wide_mods(i)]
        items[ids[0]] = [names[0], names[1], cat, mods]
    items = {k: v for k, v in items.items() if v[3]}

    # 说明文字：同一对象、同一运算与数值的合并（同一层的四种抗性 → 全抗性；同一伤害类型的三层抗性 → 该类型抗性）
    def aname(aid, lang):
        a = attrs_all.get(aid) or {}
        if a.get('name') == 'disallowCloaking':
            return '不能隐形' if lang == 'zh' else 'Cloaking disabled'
        if re.match(r'(ship|elite|role)Bonus', a.get('name', '')):   # 舰船技能加成（势力战争战术中继站）
            return '舰船技能加成' if lang == 'zh' else 'Ship skill bonuses'
        dn = a.get('displayName') or {}
        return (dn.get(lang) or dn.get('en') or a.get('name') or str(aid)).strip()

    def tname(tid, lang):
        t = all_types.get(tid)
        return (zh(t['name']) if lang == 'zh' else en(t['name'])) if t else str(tid)

    def gname(gid, lang):
        g = groups.get(gid)
        return (zh(g['name']) if lang == 'zh' else en(g['name'])) if g else str(gid)

    res_of = {aid: (layer, i) for layer, ids in RESONANCE.items() for i, aid in enumerate(ids)}
    for e in items.values():
        groups_ = {}
        for f, d, aid, op, v, extra, lid in e[3]:
            groups_.setdefault((f, extra, op, v, lid), []).append(aid)
        desc = []
        for (f, extra, op, v, lid), aids in groups_.items():
            pct = (v - 1) * 100 if op == 4 else (1 / v - 1) * 100 if op == 5 and v else v if op == 6 else None
            texts = []
            res = [a for a in aids if a in res_of]
            other = [a for a in aids if a not in res_of]
            labels = []
            layers = {}
            for a in res:
                layers.setdefault(res_of[a][0], set()).add(res_of[a][1])
            types_ = {}
            for a in res:
                types_.setdefault(res_of[a][1], set()).add(res_of[a][0])
            if res:
                if all(len(x) == 4 for x in layers.values()):
                    labels += [[LAYER[l][0] + '全抗性', LAYER[l][1] + ' resistances'] for l in layers]
                elif all(len(x) == 3 for x in types_.values()):
                    labels += [[DMG[i][0] + '抗性', DMG[i][1] + ' resistance'] for i in types_]
                else:
                    labels += [[LAYER[res_of[a][0]][0] + DMG[res_of[a][1]][0] + '抗性', LAYER[res_of[a][0]][1] + ' ' + DMG[res_of[a][1]][1] + ' resistance'] for a in res]
            for a in other:
                lb = [aname(a, 'zh'), aname(a, 'en')]
                if lb not in labels:
                    labels.append(lb)
            for zl, el in labels:
                is_res = '抗性' in zl and other == [] or zl.endswith('抗性') and res
                if zl == '不能隐形':
                    vs = ''
                elif pct is not None:
                    val = -pct if is_res else pct
                    vs = f'{val:+g}%'
                elif op == 2:
                    vs = f'{v:+g}'
                else:
                    vs = f'= {v:g}'
                scope_z = scope_e = ''
                if f == 2:
                    scope_z, scope_e = gname(extra, 'zh') + ' · ', gname(extra, 'en') + ' · '
                elif f in (3, 4):
                    scope_z, scope_e = tname(extra, 'zh') + ' · ', tname(extra, 'en') + ' · '
                who_z = who_e = ''
                if lid:
                    inc = lists[lid][0]
                    if inc and len(inc) <= 2:
                        who_z = '（仅' + '、'.join(tname(i, 'zh') for i in inc) + '）'
                        who_e = ' (' + ', '.join(tname(i, 'en') for i in inc) + ' only)'
                    elif inc:
                        who_z, who_e = f'（仅 {len(inc)} 种舰船）', f' ({len(inc)} ships only)'
                    else:
                        who_z, who_e = '（三神裔舰船除外）', ' (except Triglavian ships)'
                line = [f'{scope_z}{zl} {vs}'.strip() + who_z, f'{scope_e}{el} {vs}'.strip() + who_e]
                if line not in desc:
                    desc.append(line)
        e.append(desc)
    return {'items': items, 'lists': lists}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
