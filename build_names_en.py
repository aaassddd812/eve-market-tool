#!/usr/bin/env python3
# 生成英文版用的「官方中文名 → 官方英文名」对照表 eve-overview-clone/i18n/names-en.json
# 来源：CCP 官方 SDE（JSONL 版，名称同时带 zh / en）；NPC 空间站中文名取 npc-names-zh.json（build_npc_names.mjs 生成），英文名取 ESI /universe/names
# 用法：
#   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
#   2. python3 build_names_en.py <SDE 解压目录>
# 英文模式下浏览器把站内数据（物品目录、星图、NPC 等）里与中文名完全相同的字符串换成英文名，页面上的游戏名称也按此表替换。
# 同一个中文名对应多个英文名时按下面的读取顺序取第一个（物品优先）。
import json, sys, os, urllib.request

sde = sys.argv[1] if len(sys.argv) > 1 else None
if not sde:
    sys.exit('用法: python3 build_names_en.py <SDE JSONL 解压目录>')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eve-overview-clone', 'i18n', 'names-en.json')

names = {}
def put(zh, en):
    if not zh or not en or zh == en or zh in names:
        return
    names[zh] = en

def read(file, field='name', keep=None):
    n = 0
    with open(os.path.join(sde, file + '.jsonl'), encoding='utf8') as f:
        for line in f:
            o = json.loads(line)
            if keep and not keep(o):
                continue
            v = o.get(field)
            if isinstance(v, dict):
                put((v.get('zh') or '').strip(), (v.get('en') or '').strip())
                n += 1
    return n

# 物品只取已发布的
print('types', read('types', keep=lambda o: o.get('published')))
for f in ['groups', 'categories', 'marketGroups', 'metaGroups']:
    print(f, read(f))
for f in ['mapRegions', 'mapConstellations', 'mapSolarSystems']:
    print(f, read(f))
for f in ['factions', 'npcCorporations', 'races', 'bloodlines', 'ancestries', 'stationOperations', 'stationServices', 'npcCorporationDivisions', 'corporationActivities', 'agentTypes']:
    print(f, read(f))
print('npcCharacters', read('npcCharacters'))
print('dogmaAttributes', read('dogmaAttributes', 'displayName'))
print('dogmaUnits', read('dogmaUnits', 'displayName'))
print('planetSchematics', read('planetSchematics'))

# NPC 空间站：中文名用 build_npc_names.mjs 按 SDE 规则拼出的 npc-names-zh.json，英文名用 ESI（ESI 站名只有英文）
zh_st = json.load(open(os.path.join(os.path.dirname(OUT), '..', 'npc-names-zh.json'), encoding='utf8'))['stations']
ids = [int(k) for k in zh_st]
def esi_names(batch, lang):
    req = urllib.request.Request(f'https://esi.evetech.net/latest/universe/names/?language={lang}', data=json.dumps(batch).encode(),
                                 headers={'Content-Type': 'application/json', 'Accept-Language': lang, 'User-Agent': 'EVE-Market-Tool build_names_en'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return {x['id']: x['name'] for x in json.load(r)}
st = 0
for i in range(0, len(ids), 1000):
    b = ids[i:i + 1000]
    en = esi_names(b, 'en')
    for k in b:
        if k in en:
            put(zh_st[str(k)], en[k]); st += 1
print('stations', st)

# 第二轮：站内数据文件里剩下的中文（未发布物品名、技能 / 星域 / 主权升级件等的官方描述）到 SDE 全量名称与描述里找
import glob, re
CJK = re.compile(r'[\u3400-\u9fff]')
full = {}
def scan(file, fields):
    with open(os.path.join(sde, file + '.jsonl'), encoding='utf8') as f:
        for line in f:
            o = json.loads(line)
            for fld in fields:
                v = o.get(fld)
                if isinstance(v, dict) and v.get('zh') and v.get('en'):
                    full.setdefault(v['zh'].strip(), v['en'].strip())
for file, fields in [('types', ['name', 'description']), ('mapRegions', ['description']), ('mapConstellations', ['description']), ('mapSolarSystems', ['description']),
                     ('factions', ['description', 'shortDescription']), ('npcCorporations', ['description']), ('groups', ['name']), ('marketGroups', ['description']),
                     ('dogmaAttributes', ['tooltipTitle', 'tooltipDescription']), ('races', ['description']), ('planetSchematics', ['name'])]:
    scan(file, fields)
need = set()
def walk(o):
    if isinstance(o, str):
        if CJK.search(o) and o not in names: need.add(o)
    elif isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
site = os.path.join(os.path.dirname(OUT), '..')
for f in glob.glob(os.path.join(site, '*.json')):
    walk(json.load(open(f, encoding='utf8')))
extra = 0
for zh in need:
    en = full.get(zh) or full.get(zh.strip())
    if en and en != zh:
        names[zh] = en; extra += 1
print('site extras', extra, 'of', len(need))

# 第三轮：按 ID 补（曙光服星图的中文译名与宁静服不同；没有中文名的市场分类显示为「市场组 N」）
def id_map(file):
    m = {}
    with open(os.path.join(sde, file + '.jsonl'), encoding='utf8') as f:
        for line in f:
            o = json.loads(line)
            v = o.get('name')
            if isinstance(v, dict) and v.get('en'): m[o['_key']] = v['en'].strip()
    return m
ids_sys, ids_con, ids_reg, ids_mg, ids_type = id_map('mapSolarSystems'), id_map('mapConstellations'), id_map('mapRegions'), id_map('marketGroups'), id_map('types')
byid = 0
def put_id(zh, en):
    global byid
    if zh and en and zh != en and zh not in names: names[zh] = en; byid += 1
for f in glob.glob(os.path.join(site, 'map-data*.json')):
    m = json.load(open(f, encoding='utf8'))
    for key, ref in [('systems', ids_sys), ('constellations', ids_con), ('regions', ids_reg)]:
        for row in m.get(key, []):
            put_id(row[1], ref.get(row[0]))
cat = json.load(open(os.path.join(site, 'catalog.json'), encoding='utf8'))
for g in cat['groups']:
    put_id(g.get('name'), ids_mg.get(g.get('id')))
    for t in g.get('types', []):
        put_id(t.get('name'), ids_type.get(t.get('id')))
print('by id', byid)

# 国服独有物品 / 分组的英文名（eve-overview-clone/server/build_cn_extra.py 从网易 ESI 读取）
cn_file = os.path.join(os.path.dirname(OUT), 'names-en-cn.json')
if os.path.exists(cn_file):
    for zh, en in json.load(open(cn_file, encoding='utf8')).items():
        put(zh, en)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf8') as f:
    json.dump(names, f, ensure_ascii=False, separators=(',', ':'))
print('total', len(names), 'bytes', os.path.getsize(OUT))
