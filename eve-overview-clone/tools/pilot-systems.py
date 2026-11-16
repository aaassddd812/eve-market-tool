# 驾驶模拟的星系天体（跃迁目的地）：从 SDE 抽出几个真实星系的恒星、行星、卫星、小行星带、星门、空间站 → pilot-systems.json
#
# 用法：python3 tools/pilot-systems.py <SDE jsonl 目录> [输出文件]
#   SDE 目录里要有 mapSolarSystems / mapStars / mapPlanets / mapMoons / mapAsteroidBelts / mapStargates / npcStations / types / groups.jsonl
#   空间站中文名取自站点的 npc-names-zh.json（stations 表）
#
# 每张游戏星空（assets/eveui/sky/）配一个同一种族的真实星系；坐标以恒星为原点（米，和 SDE 一样）。
# 输出：{ systems: { 星空: { id, name, sec, con: 星座 ID（近处闪烁星精灵的随机种子，客户端 sceneManager._PrepareBackgroundLandscapes）, fight: 交战点（第一个星门外侧）, cel: [[名字, 组, 类型, x, y, z, 半径, 0 km 落点离中心距离, 英文名], …] } }, types: { 类型: 中文名 } }
#   英文名照客户端英文格式拼（SDE 英文名）：「Jita - Star」「Jita IV - Moon 4」「Jita IV - Asteroid Belt 1」「Stargate (Perimeter)」
#   「<卫星 / 行星> - <军团> <业务>」（useOperationName 为假时不带业务名）
#
# 0 km 落点（服务器决定，客户端代码里没有）：按公开资料的大致位置——
#   星门、空间站：在模型外缘（半径）再外 2.5 km；小行星带：就在那个点上；行星、卫星、恒星：表面外 10%（不精确，只为不落进天体里）
import json, os, sys

SDE = sys.argv[1] if len(sys.argv) > 1 else '/root/study/EVEonlineHelp/sde'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', 'pilot-systems.json')
SYSTEMS = {'a01': 30002187, 'c01': 30000145, 'g01': 30004967, 'm01': 30002544}   # 艾玛、新加达里、泛光之源、帕多尔
ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']
WANT = set(SYSTEMS.values())


def rows(name, keep=lambda r: True, quick=None):
    with open(os.path.join(SDE, name + '.jsonl'), encoding='utf-8') as f:
        for line in f:
            if quick and not any(q in line for q in quick):
                continue
            r = json.loads(line)
            if keep(r):
                yield r


zh = lambda n: (n or {}).get('zh') or (n or {}).get('en') or ''
en = lambda n: (n or {}).get('en') or ''
pos = lambda p: [p['x'], p['y'], p['z']]
quick = [f'"solarSystemID": {s}' for s in WANT]
systems = {r['_key']: r for r in rows('mapSolarSystems', lambda r: r['_key'] in WANT)}
names, names_en = {}, {}   # 星门目标星系的名字
for r in rows('mapSolarSystems'):
    names[r['_key']] = zh(r['name'])
    names_en[r['_key']] = en(r['name'])
stars = {r['solarSystemID']: r for r in rows('mapStars', lambda r: r['solarSystemID'] in WANT, quick)}
planets = [r for r in rows('mapPlanets', lambda r: r['solarSystemID'] in WANT, quick)]
moons = [r for r in rows('mapMoons', lambda r: r['solarSystemID'] in WANT, quick)]
belts = [r for r in rows('mapAsteroidBelts', lambda r: r['solarSystemID'] in WANT, quick)]
gates = [r for r in rows('mapStargates', lambda r: r['solarSystemID'] in WANT, quick)]
stations = [r for r in rows('npcStations', lambda r: r['solarSystemID'] in WANT, quick)]
need = {r.get('typeID') for r in [*planets, *moons, *belts, *gates, *stations, *stars.values()]}
types = {r['_key']: r for r in rows('types', lambda r: r['_key'] in need)}
corp_en = {r['_key']: en(r['name']) for r in rows('npcCorporations', lambda r: r['_key'] in {s['ownerID'] for s in stations})}
op_en = {r['_key']: en(r.get('operationName')) for r in rows('stationOperations')}
with open(os.path.join(HERE, '..', 'npc-names-zh.json'), encoding='utf-8') as f:
    st_names = json.load(f).get('stations', {})


def land(group, radius):
    if group in (10, 15):
        return radius + 2500
    if group == 9:
        return 0
    return radius * 1.1


out = {}
for sky, sid in SYSTEMS.items():
    s = systems[sid]
    sname, sen = zh(s['name']), en(s['name'])
    star = stars[sid]
    cel = []
    add = lambda name, group, t, p, r, ename: cel.append([name, group, t, *[round(x) for x in p], round(r), round(land(group, r)), ename])
    add(f'{sname} - 恒星', 6, star['typeID'], [0, 0, 0], star['radius'], f'{sen} - Star')
    pname, pen = {}, {}
    for p in sorted((x for x in planets if x['solarSystemID'] == sid), key=lambda x: x['celestialIndex']):
        n = zh(p.get('uniqueName')) or f"{sname} {ROMAN[p['celestialIndex']]}"
        ne = en(p.get('uniqueName')) or f"{sen} {ROMAN[p['celestialIndex']]}"
        pname[p['_key']], pen[p['_key']] = n, ne
        add(n, 7, p['typeID'], pos(p['position']), p['radius'], ne)
    for m in sorted((x for x in moons if x['solarSystemID'] == sid), key=lambda x: (x['orbitID'], x['orbitIndex'])):
        n = f"{pname.get(m['orbitID'], sname)} - 卫星 {m['orbitIndex']}"
        ne = f"{pen.get(m['orbitID'], sen)} - Moon {m['orbitIndex']}"
        pname[m['_key']], pen[m['_key']] = n, ne
        add(n, 8, m.get('typeID', 14), pos(m['position']), m['radius'], ne)
    for b in sorted((x for x in belts if x['solarSystemID'] == sid), key=lambda x: (x['orbitID'], x['orbitIndex'])):
        add(f"{pname.get(b['orbitID'], sname)} - 小行星带 {b['orbitIndex']}", 9, b.get('typeID', 15), pos(b['position']), 0, f"{pen.get(b['orbitID'], sen)} - Asteroid Belt {b['orbitIndex']}")
    for g in gates:
        if g['solarSystemID'] != sid:
            continue
        d = g['destination']['solarSystemID']
        add(f"星门 ({names.get(d, '')})", 10, g['typeID'], pos(g['position']), types.get(g['typeID'], {}).get('radius', 2500), f"Stargate ({names_en.get(d, '')})")
    for st in stations:
        if st['solarSystemID'] != sid:
            continue
        ne = f"{pen.get(st['orbitID'], sen)} - {corp_en.get(st['ownerID'], '')}" + (f" {op_en.get(st['operationID'], '')}" if st.get('useOperationName') else '')
        add(st_names.get(str(st['_key'])) or f"{pname.get(st['orbitID'], sname)} - 空间站", 15, st['typeID'], pos(st['position']), types.get(st['typeID'], {}).get('radius', 20000), ne)
    # 交战点：第一个星门外侧 30 km（朝恒星方向），PVP 常在星门口
    g0 = next(c for c in cel if c[1] == 10)
    gp = g0[3:6]
    d = sum(x * x for x in gp) ** 0.5 or 1
    fight = [round(gp[k] - gp[k] / d * (g0[6] + 30000)) for k in range(3)]
    out[sky] = {'id': sid, 'name': sname, 'sec': round(s['securityStatus'], 2), 'con': s['constellationID'], 'fight': fight, 'cel': cel}
    print(sky, sname, len(cel), '个天体', '交战点在', g0[0], '外 30 km')

used = {c[2] for x in out.values() for c in x['cel']}
tnames = {str(t): zh(types[t].get('name')) for t in used if t in types}
tnames_en = {str(t): en(types[t].get('name')) for t in used if t in types}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'systems': out, 'types': tnames, 'typesEn': tnames_en}, f, ensure_ascii=False, separators=(',', ':'))
print('写入', OUT, os.path.getsize(OUT), '字节')
