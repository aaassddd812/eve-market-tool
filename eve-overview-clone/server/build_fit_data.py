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
"""

import json
import sys
import zipfile

CATEGORIES = {6, 7, 8, 16, 18, 20, 32}        # 舰船、装备、弹药、技能、无人机、植入体、子系统
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
    for t in read(z, 'types.jsonl'):
        g = groups.get(t['groupID'])
        if t.get('published') and g and g['categoryID'] in CATEGORIES and g.get('published', True):
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

    data = {'char': {str(k): v for k, v in sorted(char_attrs.items())}, 'attrs': out_attrs, 'effects': out_effects, 'groups': out_groups, 'markets': out_markets, 'types': out_types}
    with open(dst, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'types {len(out_types)} · effects {len(out_effects)} · attrs {len(out_attrs)} · groups {len(out_groups)} · markets {len(out_markets)}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
