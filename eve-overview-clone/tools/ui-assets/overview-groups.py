# 总览设置「过滤条件 → 显示类型」的分类列表，照客户端 TabPresetPanel.GetListOfCategories：
#   tacticalConst.get_groups()：validCategories 里的物品组（弹药类只要 bombGroups），去掉 filterGroups；
#   state.GetNPCGroups()：海盗 / 任务 / 警察 / 统合部 / 海关 / 海军这些 NPC 组合并成一项，放进「非玩家角色」分类。
# 客户端源码里只有 invconst.groupXxx 名字（常量值在编译模块里），这里按 SDE 英文组名对上（去空格、不分大小写），对不上的打印出来。
# 只用 ast 读源文件，不执行。用法：
#   python3 -I tools/ui-assets/overview-groups.py <客户端 src> <本地化目录> <sde 目录> assets/eveui/overview-groups.json
# 数据版权归 CCP，仅供本站驾驶模拟画面使用。
import ast
import json
import os
import pickle
import re
import sys

SRC, LOC, SDE, OUT = sys.argv[1:5]


class Safe(pickle.Unpickler):
    def find_class(self, m, n):
        raise pickle.UnpicklingError(f'blocked {m}.{n}')


def load(p):
    with open(p, 'rb') as f:
        return Safe(f, encoding='utf-8').load()


labels = load(os.path.join(LOC, 'localization_fsd_main.pickle'))['labels']
LANG = {}
for n in ('zh', 'en-us'):
    x = load(os.path.join(LOC, f'localization_fsd_{n}.pickle'))
    LANG[n] = x[1] if isinstance(x, tuple) else x
LBL = {}
for mid, lab in labels.items():
    if isinstance(lab, dict):
        LBL[(lab.get('FullPath') or '') + '/' + (lab.get('label') or '')] = mid


def loc(path):
    m = LBL[path]
    get = lambda d: (lambda v: v[0] if isinstance(v, (tuple, list)) else v)(d.get(m))
    return [get(LANG['zh']), get(LANG['en-us'])]


groups = {}
for line in open(os.path.join(SDE, 'groups.jsonl'), encoding='utf-8'):
    g = json.loads(line)
    groups[g['_key']] = g
cats = {}
for line in open(os.path.join(SDE, 'categories.jsonl'), encoding='utf-8'):
    c = json.loads(line)
    cats[c['_key']] = c
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
by_group = {}
for gid, g in groups.items():
    by_group.setdefault(norm(g['name']['en']), gid)
by_cat = {norm(c['name']['en']): cid for cid, c in cats.items()}
CAT_ALIAS = {'sovereigntystructure': 'sovereigntystructures', 'orbital': 'orbitals'}
# SDE 改过名、或客户端常量带「Structure」前缀而 SDE 组名没有的（只收名字能一一对上的；其余照样打印出来，不猜）
GROUP_ALIAS = {
    'structureadministrationhub': 'administrationhub', 'structureadvertisementcenter': 'advertisementcenter',
    'structureobservatoryarray': 'observatoryarray', 'noninteractableasteroid': 'noninteractableasteroids',
    'invasionsanshanationbattleship': 'incursionsanshasnationbattleship', 'invasionsanshanationcapital': 'incursionsanshasnationcapital',
    'invasionsanshanationcruiser': 'incursionsanshasnationcruiser', 'invasionsanshanationfrigate': 'incursionsanshasnationfrigate',
    'invasionsanshanationindustrial': 'incursionsanshasnationindustrial',
}
miss = []


def const(node):
    """invconst.groupXxx / categoryXxx / 数字 → id"""
    if isinstance(node, ast.Constant):
        return node.value
    name = node.attr
    if name.startswith('category'):
        k = norm(name[8:])
        return by_cat.get(CAT_ALIAS.get(k, k)) or miss.append(name)
    k = norm(name[5:])
    gid = by_group.get(GROUP_ALIAS.get(k, k))
    if gid is None and k == 'structurelaboratory':   # SDE 有两个 Laboratory（母星 413、建筑 1405），这里是建筑那个
        gid = next((i for i, g in groups.items() if g['categoryID'] == by_cat['structure'] and norm(g['name']['en']) == 'laboratory'), None)
    if gid is None:
        miss.append(name)
    return gid


tc = ast.parse(open(os.path.join(SRC, 'eve/client/script/parklife/tacticalConst.py'), encoding='utf-8').read())
lists = {}
for node in tc.body:
    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('filterGroups', 'validCategories', 'bombGroups'):
        lists[node.targets[0].id] = {x for x in (const(e) for e in node.value.elts) if x is not None}

st = ast.parse(open(os.path.join(SRC, 'eve/client/script/parklife/state.py'), encoding='utf-8').read())
fn = next(n for n in ast.walk(st) if isinstance(n, ast.FunctionDef) and n.name == 'GetNPCGroups')
d = next(n for n in ast.walk(fn) if isinstance(n, ast.Assign)).value
npc = []   # [分类名, [[子项名, [组...]], ...]]
for ck, cv in zip(d.keys, d.values):
    subs = []
    for sk, sv in zip(cv.keys, cv.values):
        subs.append([loc(sk.args[0].value), sorted({x for x in (const(e) for e in sv.elts) if x is not None})])
    npc.append([loc(ck.args[0].value), subs])

CHARGE = by_cat['charge']
out = {}
for gid, g in groups.items():
    c = g['categoryID']
    if c == CHARGE and gid not in lists['bombGroups']:
        continue
    if c not in lists['validCategories'] or gid in lists['filterGroups']:
        continue
    hit = next(((cn, sn, ids) for cn, subs in npc for sn, ids in subs if gid in ids), None)
    if hit:
        cn, sn, ids = hit
        key = cn[0]
        out.setdefault(key, {'n': cn, 'g': []})
        item = [ids, sn[0], sn[1]]
        if item not in out[key]['g']:
            out[key]['g'].append(item)
    else:
        cat = cats[c]['name']
        out.setdefault(cat['en'], {'n': [cat.get('zh') or cat['en'], cat['en']], 'g': []})
        out[cat['en']]['g'].append([gid, g['name'].get('zh') or g['name']['en'], g['name']['en']])
res = sorted(out.values(), key=lambda x: x['n'][1].lower())
for c in res:
    c['g'].sort(key=lambda x: x[2].lower())
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'cats': res}, f, ensure_ascii=False, separators=(',', ':'))
print('categories', len(res), 'groups', sum(len(c['g']) for c in res), 'unresolved', len(miss))
print(sorted(set(miss)))
