#!/usr/bin/env python3
# 生成虫洞地点数据 eve-overview-clone/wh-sites.json（虫洞页「地点」用）
# 来源：
#   EVE University Wiki（https://wiki.eveuniversity.org/ ，CC BY-SA 4.0）——各等级可刷出的地点、战斗地点每波刷怪（Template:Npcwh）、
#     蓝色战利品价值（Template:Whisk）、气云 / 矿区产出表。本文件生成的数据同样按 CC BY-SA 4.0 提供，页面上注明出处并链接原页面。
#   Pathfinder signature_type.js（https://github.com/exodus4d/pathfinder ，MIT）——席拉与漂流者星系的战斗地点名称（Wiki 主表没有）。
#   CCP SDE（JSONL 版）——NPC / 气云 / 矿石的 typeID、官方中文名、单位体积，地点（dungeons）官方中文名；
#     NPC 战斗数据（按伤害类型的 DPS、各伤害类型 EHP、维修、网 / 扰 / 中和）直接由 SDE 属性计算，不用 Wiki 手填的数值。
#
# 用法：python3 build_whsites.py <SDE JSONL 解压目录> [Wiki 缓存文件，默认 whsites-cache.json；存在就不重新下载，删掉即重新抓取]
import json, os, re, sys, time, collections, urllib.request, urllib.parse

SDE = sys.argv[1] if len(sys.argv) > 1 else None
if not SDE:
    sys.exit("用法: python3 build_whsites.py <SDE JSONL 解压目录> [Wiki 缓存文件]")
CACHE = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "whsites-cache.json")
API = "https://wiki.eveuniversity.org/api.php"
PF_URL = "https://raw.githubusercontent.com/exodus4d/pathfinder/master/js/app/conf/signature_type.js"
UA = {"User-Agent": "eve-market-tool wh-sites builder (https://github.com/)"}
WIKI_BASE = "https://wiki.eveuniversity.org/"


def http(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8")


def wiki(params):
    return json.loads(http(API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})))


def fetch():
    """抓 Wormhole sites 分类下全部页面的 wikitext（MediaWiki API，每批 40 页）"""
    titles = [m["title"] for m in wiki({"action": "query", "list": "categorymembers", "cmtitle": "Category:Wormhole sites", "cmlimit": "500"})["query"]["categorymembers"]]
    titles = list(dict.fromkeys(titles + ["Wormhole sites", "Template:Npcwh", "Template:Whisk", "Perimeter Ambush Point(updated)", "Core Garrison(updated)"]))
    pages, redirects = {}, {}

    def get(batch):
        for i in range(0, len(batch), 40):
            r = wiki({"action": "query", "prop": "revisions", "rvprop": "content|timestamp|ids", "rvslots": "main", "titles": "|".join(batch[i:i + 40]), "redirects": "1"})
            for p in r["query"]["pages"]:
                if "revisions" in p:
                    rv = p["revisions"][0]
                    pages[p["title"]] = {"revid": rv["revid"], "timestamp": rv["timestamp"], "wikitext": rv["slots"]["main"]["content"]}
            for rd in r["query"].get("redirects", []):
                redirects[rd["from"]] = rd["to"]
            time.sleep(1)
    get(titles)
    # 主表里链接到、但没归进分类的地点页（如 Sizable Perimeter Reservoir）
    linked = re.findall(r"^\*\s*\[\[([^\]|]+)", pages.get("Wormhole sites", {}).get("wikitext", ""), re.M)
    get([t for t in dict.fromkeys(linked) if t not in pages and t not in redirects])
    return {"pages": pages, "redirects": redirects, "pathfinder": http(PF_URL)}


if os.path.exists(CACHE):
    cache = json.load(open(CACHE, encoding="utf-8"))
else:
    cache = fetch()
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
pages, redirects, PF_TEXT = cache["pages"], cache["redirects"], cache["pathfinder"]

def num(s):
    s = re.sub(r'\{\{[^{}]*\}\}', '', s or '').strip()
    m = re.search(r'-?[\d,]+(?:\.\d+)?', s)
    return float(m.group(0).replace(',', '')) if m else None

def intnum(s):
    v = num(s)
    return int(v) if v is not None and v == int(v) else v

def split_params(s):
    """split template params on top-level '|' (ignoring nested {{ }} and [[ ]])"""
    out, depth, cur = [], 0, ''
    i = 0
    while i < len(s):
        two = s[i:i+2]
        if two in ('{{', '[['): depth += 1; cur += two; i += 2; continue
        if two in ('}}', ']]'): depth -= 1; cur += two; i += 2; continue
        if s[i] == '|' and depth == 0: out.append(cur); cur = ''; i += 1; continue
        cur += s[i]; i += 1
    out.append(cur)
    return out

def find_templates(text, name):
    """yield (start, params[]) for every {{name|...}} with balanced braces"""
    pat = re.compile(r'\{\{\s*' + re.escape(name) + r'\s*\|', re.I)
    for m in pat.finditer(text):
        i, depth = m.start(), 0
        while i < len(text):
            if text.startswith('{{', i): depth += 1; i += 2; continue
            if text.startswith('}}', i):
                depth -= 1; i += 2
                if depth == 0: break
                continue
            i += 1
        inner = text[m.end():i-2]
        yield m.start(), [p.strip() for p in split_params(inner)]

def clean(s):
    s = re.sub(r'\{\{trigger\}\}', '', s or '', flags=re.I)
    s = re.sub(r'<br\s*/?>', ' ', s)
    s = re.sub(r"''+", '', s)
    s = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]*)\]\]', r'\1', s)
    return re.sub(r'\s+', ' ', s).strip()

# ---------------------------------------------------------------- Template:Npcwh -> NPC dictionary
EFFECT_ICONS = {'stasis_webifier': 'web', 'warp_disruptor': 'scram', 'energy_neutralizer': 'neut',
                'remote_armor_repair': 'remoteRep'}
HULL_ICONS = {'frigate': 'frigate', 'cruiser': 'cruiser', 'battleship': 'battleship', 'tower': 'sentry'}
npc_by_code, npcs = {}, {}
tpl = pages['Template:Npcwh']['wikitext']
cases = re.split(r'\n(?=\| [^\n=]+ = )', tpl)
for c in cases:
    m = re.match(r'\| ([^\n=]+) = (.*)', c, re.S)
    if not m: continue
    aliases = [a.strip() for a in m.group(1).split('|')]
    body = m.group(2)
    if '<tr>' not in body or 'Icon_ship_sig' not in body: continue
    tds = re.findall(r'<td[^>]*>(.*?)</td>', body, re.S)
    name = aliases[0]
    hull = next((v for k, v in HULL_ICONS.items() if f'icon_red_{k}' in tds[0]), None)
    eff_link = re.findall(r'image:icon_([a-z_]+?)(?:_i)?\.png\|[^|\]]*\|link=\|?([^\]]*)\]\]', tds[2])
    effects = sorted({EFFECT_ICONS[k] for k, _ in eff_link if k in EFFECT_ICONS})
    def after_icon(td):
        return re.sub(r'\[\[[^\]]*\]\]', ' ', td).strip()
    orbit = re.findall(r'([\d,.]+)\s*(km|m/s)', tds[6])
    turret = re.findall(r'([\d,.]+)', after_icon(tds[7]))
    missile = re.findall(r'([\d,.]+)', after_icon(tds[8]))
    rec = {'name': name, 'hull': hull, 'effects': effects,
           'signatureRadius': num(after_icon(tds[3])), 'maxVelocity': num(after_icon(tds[4])),
           'attackRangeKm': num(after_icon(tds[5])),
           'orbitKm': num(orbit[0][0]) if orbit else None, 'orbitVelocity': num(orbit[1][0]) if len(orbit) > 1 else None,
           'turretDps': num(turret[0]) if turret else None, 'missileDps': num(missile[0]) if missile else None,
           'ehp': num(after_icon(tds[9]))}
    npcs[name] = rec
    for a in aliases:
        npc_by_code.setdefault(a.lower(), name)   # #switch: first match wins (note 'awar' collision)

# ---------------------------------------------------------------- Template:Whisk -> blue loot per site
whisk = {}
for line in pages['Template:Whisk']['wikitext'].splitlines():
    m = re.match(r'\| ([^=]+?) = \*([\d,]+)', line)
    if m:
        v = int(m.group(2).replace(',', ''))
        for a in m.group(1).split('|'): whisk[a.strip().lower()] = v

# ---------------------------------------------------------------- class membership from "Wormhole sites" page
membership = collections.defaultdict(lambda: collections.defaultdict(list))  # class -> type -> [sites]
site_type, site_classes = {}, collections.defaultdict(set)
cls, sub = None, None
TYPE_MAP = {'cosmic anomalies': 'combat', 'data sites': 'data', 'relic sites': 'relic'}
def classes_from_heading(h):
    h = h.lower()
    if 'all classes' in h: return ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
    out = []
    for a, b in re.findall(r'c(\d)\s*-\s*c(\d)', h): out += [f'C{i}' for i in range(int(a), int(b)+1)]
    out += [f'C{x}' for x in re.findall(r'c(\d)\b(?!\s*-)', h) if f'C{x}' not in out]
    if 'shattered' in h: out.append('C13')
    return out
section_kind = None
for line in pages['Wormhole sites']['wikitext'].splitlines():
    m2 = re.match(r'^==\s*([^=]+?)\s*==$', line); m3 = re.match(r'^===\s*([^=]+?)\s*===$', line)
    if m2:
        h = m2.group(1)
        mc = re.match(r'Class (\d)', h)
        if mc: section_kind, cls = 'class', f'C{mc.group(1)}'
        elif h.startswith('Gas'): section_kind = 'gas'
        elif h.startswith('Ore'): section_kind = 'ore'
        elif h.startswith('Ice'): section_kind = 'ice'
        else: section_kind = None
        continue
    if m3:
        sub = m3.group(1); continue
    ml = re.match(r'^\*\s*\[\[([^\]|]+)', line)
    if not ml or not section_kind: continue
    site = redirects.get(ml.group(1), ml.group(1))
    if section_kind == 'class':
        t = TYPE_MAP.get(sub.lower()); targets = [cls]
    else:
        t = 'ore' if section_kind == 'ice' else section_kind; targets = classes_from_heading(sub)
    site_type[site] = t
    for c in targets:
        membership[c][t].append(site); site_classes[site].add(c)

# ---------------------------------------------------------------- Pathfinder signature_type.js (extra classes)
pf = PF_TEXT
def pf_obj(var):
    m = re.search(r'let ' + var + r' = (?:Object\.assign\(\{\}, (\w+), )?\{(.*?)\}\)?;', pf, re.S)
    if not m: return []
    names = re.findall(r"\d+:\s*'([^']+)'", m.group(2))
    if m.group(1): names = pf_obj(m.group(1)) + names
    return names
PF_CLASS = {'C12': 'Thera', 'C13': 'Shattered', 'C14': 'Drifter Sentinel', 'C15': 'Drifter Barbican',
            'C16': 'Drifter Vidette', 'C17': 'Drifter Conflux', 'C18': 'Drifter Redoubt'}
pathfinder = {}
for n in range(1, 19):
    entry = {}
    for kind, var in (('combat', 'Combat'), ('relic', 'Relic'), ('data', 'Data'), ('gas', 'Gas'), ('ore', 'Ore')):
        v = pf_obj(f'c{n}{var}')
        if v: entry[kind] = v
    if entry: pathfinder[f'C{n}'] = entry

# ---------------------------------------------------------------- SDE lookup (typeIDs, zh names, volumes)
groups = {}
for l in open(os.path.join(SDE, 'groups.jsonl')):
    g = json.loads(l); groups[g['_key']] = (g['name']['en'], g.get('categoryID'))
wanted = set(npcs) | {'Decloaked Transmission Relay'}
types_by_name = collections.defaultdict(list)
all_types = {}
def load_types(names):
    for l in open(os.path.join(SDE, 'types.jsonl')):
        m = re.search(r'"en": "([^"]*)"', l[l.find('"name"'):] if '"name"' in l else '')
        if not m or m.group(1) not in names: continue
        t = json.loads(l)
        types_by_name[t['name']['en']].append({'typeID': t['_key'], 'zh': t['name'].get('zh'), 'group': groups.get(t['groupID'], ('?', None))[0],
                                              'category': groups.get(t['groupID'], ('?', None))[1], 'volume': t.get('volume'), 'published': t.get('published', False)})
dungeons_zh = {}
for l in open(os.path.join(SDE, 'dungeons.jsonl')):
    d = json.loads(l); n = d.get('name', {})
    if n.get('en'): dungeons_zh.setdefault(n['en'], {'dungeonID': d['_key'], 'zh': n.get('zh'), 'archetypeID': d.get('archetypeID')})

# ---------------------------------------------------------------- parse each site page
def parse_count(s):
    s = clean(s).lower().replace('x', '')
    nums = [int(x) for x in re.findall(r'\d+', s)]
    if not nums: return None, None
    return min(nums), max(nums)

def parse_npcwh(text):
    waves, cur = [], None
    for _, p in find_templates(text, 'npcwh'):
        code = p[0].lower()
        if code in ('start', 'start2', 'end'): continue
        if code == 'wave':
            cur = {'label': clean(p[1] if len(p) > 1 else ''), 'npcs': []}; waves.append(cur); continue
        if cur is None: cur = {'label': 'Site NPCs', 'npcs': []}; waves.append(cur)
        name = npc_by_code.get(code, p[0])
        extra = p[2] if len(p) > 2 else ''
        cmin, cmax = parse_count(p[1] if len(p) > 1 else '')
        note = clean(extra)
        cur['npcs'].append({'name': name, 'countMin': cmin, 'countMax': cmax,
                            'trigger': '{{trigger}}' in extra.lower(),
                            'optional': bool(re.search(r'possible|may not|will spawn if', note, re.I)),
                            'note': note or None, 'effects': npcs.get(name, {}).get('effects', [])})
    return waves

def parse_npctable(text):
    """newer CMB-style pages: {{NPCTableHead|title}} {{NPCTableRow|class|count|name|point=|ewar=|ewar2=|trigger=|note=}}"""
    events = [(pos, 'head', p) for pos, p in find_templates(text, 'NPCTableHead')] + \
             [(pos, 'row', p) for pos, p in find_templates(text, 'NPCTableRow')] + \
             [(pos, 'head', p) for pos, p in find_templates(text, 'NPCTableSeparator')]
    waves, cur = [], None
    for _, kind, p in sorted(events, key=lambda e: e[0]):
        if kind == 'head': cur = {'label': clean(p[0]), 'npcs': []}; waves.append(cur); continue
        if cur is None: cur = {'label': 'Site NPCs', 'npcs': []}; waves.append(cur)
        pos = [x for x in p if '=' not in x.split('|')[0]]
        kv = dict(x.split('=', 1) for x in p if '=' in x.split('|')[0])
        kv = {k.strip(): v.strip() for k, v in kv.items()}
        if len(pos) < 3 or pos[0].lower() in ('structure', 'accl gate', 'hackable'): continue
        cmin, cmax = parse_count(pos[1])
        name = pos[2]
        mname = re.search(r'\(([^)]*)\)$', name)
        if mname and mname.group(1) in npcs: name = mname.group(1)
        eff = set()
        for v in (kv.get('ewar', ''), kv.get('ewar2', ''), kv.get('ewar3', '')):
            v = v.lower()
            if 'web' in v: eff.add('web')
            if 'neut' in v: eff.add('neut')
        if kv.get('point', '').lower() in ('scram', 'yes', 'point', 'disrupt'): eff.add('scram' if kv['point'].lower() == 'scram' else 'point')
        if re.search(r'remote rep', kv.get('note', ''), re.I): eff.add('remoteRep')
        cur['npcs'].append({'name': name, 'hullText': pos[0], 'countMin': cmin, 'countMax': cmax,
                            'trigger': bool(kv.get('trigger')), 'optional': bool(re.search(r'may not|possible', kv.get('note', ''), re.I)),
                            'note': clean('; '.join(x for x in (kv.get('trigger'), kv.get('note')) if x)) or None,
                            'effects': sorted(eff)})
    return waves

def parse_tables(text):
    tables = []
    for tm in re.finditer(r'\{\|(.*?)\n\|\}', text, re.S):
        body = tm.group(1)
        rows = re.split(r'\n\|-[^\n]*', body)
        headers = [re.sub(r'^.*\|\s*', '', h).strip() for h in re.findall(r'^!\s*(.*)$', rows[0] + '\n' + (rows[1] if len(rows) > 1 else ''), re.M)]
        data = []
        for r in rows[1:]:
            cells = [re.sub(r'^[^|]*style="[^"]*"\s*\|', '', c).strip() for c in re.findall(r'^\|(?![-}])(.*)$', r, re.M)]
            if cells: data.append(cells)
        tables.append((headers, data))
    return tables

def parse_resources(text):
    out = []
    for headers, data in parse_tables(text):
        hl = [h.lower() for h in headers]
        if 'gas type' in hl:
            for c in data:
                row = dict(zip(hl, c))
                out.append({'kind': 'gas', 'name': clean(row.get('gas type')), 'units': intnum(row.get('units')),
                            'totalM3': intnum(row.get('total m3')), 'value': clean(row.get('value', '')) or None})
        elif 'ore type' in hl or 'ice type' in hl:
            for c in data:
                row = dict(zip(hl, c))
                size = clean(re.sub(r'\{\{Verify[^}]*\}\}', '', row.get('size (m3, each)', '')))
                out.append({'kind': 'ice' if 'ice type' in hl else 'ore', 'name': clean(row.get('ore type') or row.get('ice type')),
                            'asteroids': intnum(row.get('# of asteroids')), 'asteroidSizeM3': size or None,
                            'units': intnum(re.sub(r'\{\{Verify.*', '', row.get('site total (units)', ''))),
                            'totalM3': intnum(row.get('site total (m3)'))})
    return out

def blue_loot(text):
    for _, p in find_templates(text, 'whisk'):
        if p and p[0].lower() in whisk: return whisk[p[0].lower()]
    m = re.search(r'([\d][\d,.]*)\s*(million)?\s*ISK\s*(?:for|in)\s*Blue Loot', text, re.I) or \
        re.search(r'about\s*([\d.]+)\s*(million)\s*ISK in blue loot', text, re.I)
    if m:
        v = float(m.group(1).replace(',', ''))
        return int(v * 1e6) if m.group(2) else int(v)
    return None

sites = {}
for title, pg in pages.items():
    if not pg or title.startswith('Template:') or title in ('Wormhole sites',): continue
    text = pg['wikitext']
    if '(updated)' in title: continue  # drafts, used below as alt
    waves = parse_npcwh(text) or parse_npctable(text)
    res = parse_resources(text)
    t = site_type.get(title) or ('gas' if any(r['kind'] == 'gas' for r in res) else 'ore' if res else None)
    sites[title] = {'name': title, 'type': t, 'classes': sorted(site_classes.get(title, []), key=lambda c: int(c[1:])),
                    'nameZh': dungeons_zh.get(title, {}).get('zh'), 'dungeonID': dungeons_zh.get(title, {}).get('dungeonID'),
                    'blueLootIsk': blue_loot(text), 'waves': waves, 'resources': res,
                    'source': {'url': WIKI_BASE + title.replace(' ', '_'), 'revid': pg['revid'], 'timestamp': pg['timestamp']}}
for title, pg in pages.items():
    if pg and '(updated)' in title:
        base = re.sub(r'\s*\(updated\)', '', title)
        if base in sites:
            sites[base]['wavesDraft'] = parse_npctable(pg['wikitext'])
            sites[base]['draftSource'] = WIKI_BASE + title.replace(' ', '_')
            m = re.search(r'signature strength\s*=\s*([^\n|]+)', pg['wikitext'])
            if m: sites[base]['signatureStrength'] = m.group(1).strip()

# ---------------------------------------------------------------- typeIDs
# 2025 ore/ice rename: wiki still uses legacy variant names
LEGACY = {}
for base, t2, t3 in [('Arkonor', 'Crimson', 'Prime'), ('Bistot', 'Triclinic', 'Monoclinic'), ('Kernite', 'Luminous', 'Fiery'),
                     ('Gneiss', 'Iridescent', 'Prismatic'), ('Pyroxeres', 'Solid', 'Viscous'), ('Omber', 'Silvery', 'Golden')]:
    LEGACY[f'{t2} {base}'] = f'{base} II-Grade'; LEGACY[f'{t3} {base}'] = f'{base} III-Grade'
LEGACY.update({'Thick Blue Ice': 'Blue Ice IV-Grade', 'Enriched Clear Icicle': 'Clear Icicle IV-Grade',
               'Pristine White Glaze': 'White Glaze IV-Grade', 'Smooth Glacial Mass': 'Glacial Mass IV-Grade',
               'Autothysian Lancers': 'Autothysian Lancer'})
need = set(npcs)
for s in sites.values():
    for w in s['waves'] + s.get('wavesDraft', []):
        for n in w['npcs']: need.add(n['name'])
    for r in s['resources']: need.add(r['name'])
load_types(need | {LEGACY.get(n, n) for n in need})
def pick(name, kind):
    name = LEGACY.get(name, name)
    c = types_by_name.get(name, [])
    if kind == 'npc': c = [x for x in c if x['category'] == 11] or c
    else: c = [x for x in c if x['published']] or c
    c = sorted(c, key=lambda x: x['typeID'])
    return c
unresolved = set()
for n, rec in npcs.items():
    c = pick(n, 'npc')
    rec['typeID'] = c[0]['typeID'] if c else None; rec['nameZh'] = c[0]['zh'] if c else None
    rec['altTypeIDs'] = [x['typeID'] for x in c[1:]]
for s in sites.values():
    for w in s['waves'] + s.get('wavesDraft', []):
        for n in w['npcs']:
            c = pick(n['name'], 'npc')
            n['typeID'] = c[0]['typeID'] if c else None
            n['nameZh'] = c[0]['zh'] if c else None
            if not c: unresolved.add(n['name'])
    for r in s['resources']:
        c = pick(r['name'], 'item')
        r['typeID'] = c[0]['typeID'] if c else None; r['nameZh'] = c[0]['zh'] if c else None
        r['unitVolume'] = c[0]['volume'] if c else None
        if r['name'] in LEGACY: r['currentName'] = LEGACY[r['name']]
        if not c: unresolved.add(r['name'])

# ---------------------------------------------------------------- 归类：Wiki 主表没有的席拉 / 漂流者战斗地点用 Pathfinder 补
for c in ("C12", "C14", "C15", "C16", "C17", "C18"):
    for name in pathfinder.get(c, {}).get("combat", []):
        site_classes[name].add(c)
        site_type.setdefault(name, "combat")
        membership[c]["combat"].append(name)
        if name in sites and not sites[name]["type"]:
            sites[name]["type"] = "combat"
for name, s in sites.items():
    s["classes"] = sorted(site_classes.get(name, []), key=lambda c: int(c[1:]))

# ---------------------------------------------------------------- NPC 战斗数据（SDE 属性）
attr_name = {}
for l in open(os.path.join(SDE, "dogmaAttributes.jsonl"), encoding="utf-8"):
    o = json.loads(l)
    attr_name[o["_key"]] = o["name"]
effect_name = {}
for l in open(os.path.join(SDE, "dogmaEffects.jsonl"), encoding="utf-8"):
    o = json.loads(l)
    effect_name[o["_key"]] = o["name"]
npc_ids = {n["typeID"] for s in sites.values() for w in s["waves"] for n in w["npcs"] if n.get("typeID")}
dogma = {}
for l in open(os.path.join(SDE, "typeDogma.jsonl"), encoding="utf-8"):
    o = json.loads(l)
    dogma[o["_key"]] = ({attr_name.get(a["attributeID"]): a["value"] for a in o.get("dogmaAttributes", [])},
                        {effect_name.get(e["effectID"]) for e in o.get("dogmaEffects", [])})
DMG = ("em", "thermal", "kinetic", "explosive")


def npc_stats(tid):
    a, eff = dogma.get(tid, ({}, set()))
    g = lambda k, d=0: a.get(k, d) or d
    out = {}
    # 伤害：炮台 = 伤害属性 × 伤害倍数 ÷ 射速；导弹 = 导弹类型的伤害属性 × 导弹伤害倍数 ÷ 发射间隔
    dps = [0.0] * 4
    if "targetAttack" in eff and g("speed"):
        for i, k in enumerate(DMG):
            dps[i] += g(k + "Damage") * g("damageMultiplier", 1) / (g("speed") / 1000)
    mt = int(g("entityMissileTypeID"))
    if "missileLaunchingForEntity" in eff and mt and g("missileLaunchDuration"):
        ma = dogma.get(mt, ({}, set()))[0]
        for i, k in enumerate(DMG):
            dps[i] += (ma.get(k + "Damage") or 0) * g("missileDamageMultiplier", 1) / (g("missileLaunchDuration") / 1000)
    out["dps"] = [round(x, 1) for x in dps]
    # 各伤害类型 EHP：护盾 / 装甲 / 结构各层 HP ÷ 该层抗性系数
    layers = (("shieldCapacity", "shield{}DamageResonance"), ("armorHP", "armor{}DamageResonance"), ("hp", "{}DamageResonance"))
    out["hp"] = [round(g(h)) for h, _ in layers]
    ehp = []
    for k in DMG:
        kk = k.capitalize()
        tot = 0
        for h, res in layers:
            r = a.get(res.format(kk if res.startswith(("shield", "armor")) else k))
            tot += g(h) / (r if r else 1)
        ehp.append(round(tot))
    out["ehp"] = ehp
    rep = []
    if g("entityArmorRepairAmount") and g("entityArmorRepairDuration"):
        rep.append(["armor", round(g("entityArmorRepairAmount") / (g("entityArmorRepairDuration") / 1000), 1)])
    if g("entityShieldBoostAmount") and g("entityShieldBoostDuration"):
        rep.append(["shield", round(g("entityShieldBoostAmount") / (g("entityShieldBoostDuration") / 1000), 1)])
    if g("npcRemoteArmorRepairAmount") and g("npcRemoteArmorRepairDuration"):
        rep.append(["remoteArmor", round(g("npcRemoteArmorRepairAmount") / (g("npcRemoteArmorRepairDuration") / 1000), 1)])
    if g("npcRemoteShieldBoostAmount") and g("npcRemoteShieldBoostDuration"):
        rep.append(["remoteShield", round(g("npcRemoteShieldBoostAmount") / (g("npcRemoteShieldBoostDuration") / 1000), 1)])
    out["rep"] = rep
    ew = {}
    if g("modifyTargetSpeedChance") and g("speedFactor"):
        ew["web"] = [round(g("speedFactor")), round(g("modifyTargetSpeedRange") / 1000)]
    if g("entityWarpScrambleChance") and g("warpScrambleStrength"):
        ew["scram"] = [round(g("warpScrambleStrength")), round(g("warpScrambleRange") / 1000)]
    if g("energyNeutralizerAmount") and g("energyNeutralizerDuration"):
        ew["neut"] = [round(g("energyNeutralizerAmount")), round(g("energyNeutralizerDuration") / 1000), round(g("energyNeutralizerRangeOptimal") / 1000)]
    out["ew"] = ew
    out["speed"] = round(g("maxVelocity"))
    out["sig"] = round(g("signatureRadius"))
    out["range"] = round(max(g("maxRange"), g("entityAttackRange")) / 1000)
    out["orbit"] = round(g("entityFlyRange") / 1000)
    return out


# ---------------------------------------------------------------- 文字翻译（波次标题与备注是固定的几种写法）
def zh_label(s):
    m = re.match(r"Wave (\d+)\s*(.*)$", s)
    if m:
        rest = m.group(2)
        rest = {"(70-90 km away)": "（距离 70–90 km）", "(50 km away)": "（距离 50 km）",
                "(Triggered randomly after 1-3 cans have been hacked or failed.)": "（破解或失败 1–3 个罐子后随机刷出）"}.get(rest, rest)
        return f"第 {m.group(1)} 波" + rest
    return {"1st Capital Escalation": "旗舰升级 第 1 波", "2nd Capital Escalation": "旗舰升级 第 2 波", "Site NPCs": "地点内的 NPC",
            "Structures": "建筑", "Defenders": "守卫", "Initial defenders": "初始守卫", "Site NPCs(104 DPS total)": "地点内的 NPC（总 DPS 约 104）",
            "Possible wandering rats": "可能有游荡的 NPC", "Wandering rats, can be present anywhere": "游荡 NPC，可能出现在任何位置",
            "Rats": "NPC", "Center group": "中间一组", "Left group": "左边一组", "Right group": "右边一组", "Or": "或者",
            "Wandering fleet, can be present in any pocket": "游荡舰队，可能出现在任一区域",
            "Defenders(15-100 km from warpin)": "守卫（距跃迁点 15–100 km）", "Central group(auto-aggro)": "中央一组（主动攻击）",
            "Second group": "第二组"}.get(s, s)


NOTE_ZH = {
    "(Will spawn if a Talocan relic can spawns.)": "刷出塔洛坎遗迹罐时才出现", "(Will spawn if a Talocan relic can spawn.)": "刷出塔洛坎遗迹罐时才出现",
    "(Possible additional spawn)": "可能额外刷出", "(Next wave is triggered by failing a hack on one of the cans.)": "破解罐子失败会刷出下一波",
    "Trigger to complete site": "击毁后地点完成", "(Trigger to finish site)": "击毁后地点完成", "Respawns every few minutes": "每隔几分钟重刷",
    "May not always spawn": "不一定出现", "(May not always appear)": "不一定出现", "Locked": "锁定状态", "on aggression": "受到攻击时出现",
    "(Next wave is triggered by hacking any one of the cans.)": "破解任一罐子会刷出下一波", "Respawns quickly": "很快重刷",
    "500km point (5) and web (-10%), 40km neut (6/gj)": "500 km 反跳（5 点）、网 −10%，40 km 中和（6 GJ）"}
TYPE_ZH = {"combat": "战斗", "data": "数据", "relic": "遗迹", "gas": "气云", "ore": "矿区"}

# ---------------------------------------------------------------- 输出（前端用的精简结构）
npc_out = {}
site_out = {}
for name, s in sites.items():
    if not s["classes"] or not s["type"]:
        continue
    waves = []
    for w in s["waves"]:
        rows = []
        for n in w["npcs"]:
            tid = n.get("typeID")
            if tid and tid not in npc_out:
                npc_out[tid] = {"name": n["name"], "zh": n.get("nameZh"), **npc_stats(tid)}
            flags = ("t" if n["trigger"] else "") + ("o" if n["optional"] else "")
            # [typeID, 英文名, 最少, 最多, 标记（t 触发下一波 / o 可能不出现）, 备注, 英文备注]
            rows.append([tid, n["name"], n["countMin"], n["countMax"], flags, NOTE_ZH.get(n["note"] or "", n["note"] or ""), n["note"] or ""])
        if rows:
            # [标题, 行, 英文标题]
            waves.append([zh_label(w["label"]), rows, w["label"]])
    # [种类, typeID, 中文名, 数量, 总体积, 小行星数, 英文名（2025 年改名后的现名）]
    res = [[r["kind"], r.get("typeID"), r.get("nameZh") or r.get("currentName") or r["name"], r.get("units"), r.get("totalM3"), r.get("asteroids"), r.get("currentName") or r["name"]]
           for r in s["resources"]]
    site_out[name] = {"zh": s["nameZh"], "type": s["type"], "classes": [int(c[1:]) for c in s["classes"]], "loot": s["blueLootIsk"],
                      "waves": waves, "res": res, "url": s["source"]["url"] if name in pages else None}
# 没有 Wiki 页面、只知道名字的地点（Pathfinder 补的席拉 / 漂流者战斗地点）
for name, cls in site_classes.items():
    if name not in site_out and site_type.get(name):
        site_out[name] = {"zh": dungeons_zh.get(name, {}).get("zh"), "type": site_type[name], "classes": sorted(int(c[1:]) for c in cls),
                          "loot": None, "waves": [], "res": [], "url": None}
out = {
    "generatedAt": time.strftime("%Y-%m-%d"),
    "license": "CC BY-SA 4.0",
    "sources": [["EVE University Wiki", WIKI_BASE + "Wormhole_sites", "CC BY-SA 4.0"],
                ["Pathfinder", "https://github.com/exodus4d/pathfinder", "MIT"], ["CCP SDE", "https://developers.eveonline.com/static-data", ""]],
    "sites": site_out,
    "npcs": npc_out
}
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eve-overview-clone", "wh-sites.json")
json.dump(out, open(target, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
by = collections.Counter(s["type"] for s in site_out.values())
print(f"地点 {len(site_out)}（{', '.join(f'{TYPE_ZH[k]} {v}' for k, v in by.items())}），有波次 {sum(1 for s in site_out.values() if s['waves'])}，"
      f"NPC {len(npc_out)}，未匹配名称 {sorted(unresolved)} → {target}（{os.path.getsize(target) // 1024} KB）")
