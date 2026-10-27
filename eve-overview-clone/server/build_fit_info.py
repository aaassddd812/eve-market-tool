#!/usr/bin/env python3
"""从 CCP 官方静态数据（SDE，JSON Lines 版）生成装配页「物品详情」用的 fit-info.json。

用法：
  python3 server/build_fit_info.py <sde.zip> fit-data.json fit-info.json

只收录 fit-data.json 里有的物品（先生成 fit-data.json）。打开详情弹窗时才加载，不影响装配页首屏。
输出格式：
  bonus: { 舰船ID: { s: [[技能ID, [加成...]], ...], r: [加成...], m: [加成...] } }
         s 为每升一级技能的加成，r 为特有加成，m 为其他加成；
         加成 = [数值或 null, 单位ID或 null, 中文说明, 英文说明]，说明里的物品链接写成 {物品ID|名称}
  var:   { 物品ID: 衍生母型ID }  同一母型的物品互为衍生（T1、T2、衍生、势力、死亡空间、官员……），母型自身也列出
"""

import json
import re
import sys
import zipfile

LINK = re.compile(r'<a href=["\']?showinfo:(\d+)["\']?>(.*?)</a>', re.S)
TAG = re.compile(r'<[^>]+>')


def read(z, name):
    with z.open(name) as fh:
        for line in fh:
            yield json.loads(line)


def text(v, lang):
    s = (v or {}).get(lang) or (v or {}).get('en') or ''
    s = LINK.sub(lambda m: '{%s|%s}' % (m.group(1), TAG.sub('', m.group(2)).replace('|', ' ').replace('}', ')')), s)
    return TAG.sub('', s).strip()


def bonus(b):
    v = b.get('bonus')
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return [v, b.get('unitID'), text(b.get('bonusText'), 'zh'), text(b.get('bonusText'), 'en')]


def main(src, fit_data, dst):
    z = zipfile.ZipFile(src)
    known = {int(k) for k in json.load(open(fit_data, encoding='utf-8'))['types']}
    out = {'bonus': {}, 'var': {}}
    for d in read(z, 'typeBonus.jsonl'):
        if d['_key'] not in known:
            continue
        e = {}
        skills = [[t['_key'], [bonus(b) for b in sorted(t['_value'], key=lambda b: b.get('importance', 0))]] for t in d.get('types', [])]
        if skills:
            e['s'] = skills
        for key, short in (('roleBonuses', 'r'), ('miscBonuses', 'm')):
            if d.get(key):
                e[short] = [bonus(b) for b in sorted(d[key], key=lambda b: b.get('importance', 0))]
        if e:
            out['bonus'][d['_key']] = e
    parents = set()
    for t in read(z, 'types.jsonl'):
        p = t.get('variationParentTypeID')
        if p and t['_key'] in known:
            out['var'][t['_key']] = p
            parents.add(p)
    for p in parents:
        if p in known:
            out['var'][p] = p
    with open(dst, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print(f"舰船加成 {len(out['bonus'])}，衍生关系 {len(out['var'])}")


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
