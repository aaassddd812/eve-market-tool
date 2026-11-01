#!/usr/bin/env python3
"""联盟锦标赛（AT）比赛记录：从 EVE_NT 赛事站（open.eve-nt.uk）取一届已打过的全部比赛，生成 at-data.json，给战场模拟的「AT 赛」用。

用法：python3 server/build_at.py [届别，默认 ATXXII] [--root 站点目录] [--cache 缓存目录]
  （默认写 eve-overview-clone/at-data.json，缓存在 server/.at-cache/；比赛打完就不会再变，重跑只取新打的场次）
  文件只在内容变了时才写（先写临时文件再替换）；有更新时输出「已更新」。决赛周每天打完后重跑一次即可。

数据来源：
  1. 阵容与胜负：赛事站公开的只读 MCP 接口 https://open.eve-nt.uk/mcp/portal（JSON-RPC，不需要 key）
     list_tournament_matches 列出全部场次，get_match 给出双方选手、船型（ship_id 就是游戏里的船型 ID）、是否存活、胜方
  2. 开打时间、禁船、旗舰：MCP 没有，从比赛网页 /portal/match/{id} 解析
  3. 船的分值：官方配队表格（Quick Composition Creator）的 New Static Values 工作表，英文船名经 ESI /universe/ids 换成船型 ID
  4. 实际装配：赛事站没有装配。决赛周在宁静服打，阵亡的船有击杀记录：按选手查 zKillboard 损失（同船型、开打后 40 分钟内），
     记下击杀 ID，网页用 /api/kb/shipfits?kills= 取装配；预选在 Thunderdome 比赛服、没有击杀记录，存活的船也没有
输出：
  { at, tournament, name, limit: 200, points: {船型: [分值, 重复加价]}, matches: [{ id, no, series, type, start, winner, bans: [[船型, 轮次, red|blue]],
      red: { id, name, ships: [[船型, 选手 ID, 选手名, 存活 1/0, 旗舰 1/0, 击杀 ID（只有决赛周阵亡且查到的）]] }, blue: {…} }] }
  matches 按开打时间从新到旧；type 为 feeder（预选，Thunderdome 比赛服）或 final（决赛周，宁静服）
"""
import html
import json
import os
import re
import sys
import time
import urllib.request

MCP = 'https://open.eve-nt.uk/mcp/portal'
PAGE = 'https://open.eve-nt.uk/portal/match/{}'
UA = 'eve-tool/1.0 (+https://eve.navexor.top)'
SHEET = 'https://docs.google.com/spreadsheets/d/1AVYlWlvuMKnA3yuqqDCcAkia8pvhpb9OBcM29WFw5rM/export?format=csv&gid=284772315'   # ATXXII
ESI_IDS = 'https://esi.evetech.net/latest/universe/ids/?datasource=tranquility'
ZKB = 'https://zkillboard.com/api/losses/characterID/{}/'
ROMAN = {'I': 1, 'V': 5, 'X': 10, 'L': 50}


class Mcp:
    def __init__(self):
        self.session = None
        self.seq = 0
        res = self._post({'jsonrpc': '2.0', 'id': self._id(), 'method': 'initialize',
                          'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'eve-tool', 'version': '1'}}})
        self.session = res.headers.get('Mcp-Session-Id')
        res.read()
        self._post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}).read()

    def _id(self):
        self.seq += 1
        return self.seq

    def _post(self, body):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'User-Agent': UA}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        req = urllib.request.Request(MCP, data=json.dumps(body).encode(), headers=headers, method='POST')
        return urllib.request.urlopen(req, timeout=60)

    def call(self, name, **args):
        for attempt in range(3):
            try:
                with self._post({'jsonrpc': '2.0', 'id': self._id(), 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}) as res:
                    data = json.loads(res.read())
                if 'error' in data:
                    raise RuntimeError(data['error'])
                return json.loads(data['result']['content'][0]['text'])
            except Exception:  # noqa: BLE001
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))


def fetch_page(mid):
    req = urllib.request.Request(PAGE.format(mid), headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode('utf-8', 'replace')


def load_points():
    """{船型 ID: [分值, 重复加价]}：表格第 6–10 列是 船名, 类别, 分值, 船体, 重复加价；读不到返回 None（沿用旧数据）"""
    import csv
    import io
    try:
        req = urllib.request.Request(SHEET, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as res:
            rows = [r for r in csv.reader(io.StringIO(res.read().decode('utf-8'))) if len(r) > 9 and r[5].strip() and r[7].strip().isdigit()]
        names = {r[5].strip(): [int(r[7]), int(r[9] or 0)] for r in rows}
        req = urllib.request.Request(ESI_IDS, data=json.dumps(list(names)).encode(), headers={'User-Agent': UA, 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=60) as res:
            ids = {x['name']: x['id'] for x in json.loads(res.read()).get('inventory_types', [])}
        miss = [n for n in names if n not in ids]
        if miss:
            print(f'  分值表里找不到船型：{", ".join(miss)}', file=sys.stderr)
        return {str(ids[n]): v for n, v in names.items() if n in ids}
    except Exception as e:  # noqa: BLE001
        print(f'  分值表读取失败：{e}', file=sys.stderr)
        return None


def find_kills(m):
    """决赛周：给阵亡的船补上击杀 ID（第 6 项；查过没找到记 0，下次重跑再查）。返回是否有改动"""
    if m['type'] != 'final' or not m['start']:
        return False
    t0 = time.mktime(time.strptime(m['start'], '%Y-%m-%dT%H:%M:00Z')) - time.timezone
    changed = False
    for s in m['red']['ships'] + m['blue']['ships']:
        if s[3] or (len(s) > 5 and s[5]):
            continue
        km = 0
        try:
            req = urllib.request.Request(ZKB.format(s[1]), headers={'User-Agent': UA, 'Accept-Encoding': 'identity'})
            with urllib.request.urlopen(req, timeout=60) as res:
                for k in json.loads(res.read()):
                    v = k.get('victim', {})
                    t = time.mktime(time.strptime(k['killmail_time'], '%Y-%m-%dT%H:%M:%SZ')) - time.timezone
                    if v.get('character_id') == s[1] and v.get('ship_type_id') == s[0] and t0 - 300 <= t <= t0 + 2400:
                        km = k['killmail_id']
                        break
        except Exception as e:  # noqa: BLE001
            print(f'  zKillboard {s[2]}：{e}', file=sys.stderr)
        time.sleep(1.2)
        s[5:] = [km]
        changed = changed or bool(km)
    return changed


def parse_page(text):
    """开打时间（ISO，UTC）、禁船 [[船型, 轮次, 颜色]]、旗舰选手 ID 集合"""
    start = None
    m = re.search(r'Match started</span>\s*<span class="timing-value">([^<]+)</span>', text)
    if m:
        t = html.unescape(m.group(1)).replace('·', '').replace('UTC', '').split()
        try:
            start = time.strftime('%Y-%m-%dT%H:%M:00Z', time.strptime(' '.join(t), '%b %d, %Y %H:%M'))
        except ValueError:
            start = None
    bans = []
    for chip in re.findall(r'<a class="ban-chip".*?</a>', text, re.S):
        ship = re.search(r'/types/(\d+)/', chip)
        rnd = re.search(r'ban-round-badge[^>]*>R(\d+)<', chip)
        color = re.search(r'team-dot-(red|blue)', chip)
        if ship:
            bans.append([int(ship.group(1)), int(rnd.group(1)) if rnd else 0, color.group(1) if color else ''])
    flags = {int(x) for x in re.findall(r'portal/pilots/(\d+)"[^>]*>[^<]*</a>\s*<span[^>]*title="Flagship"', text)}
    return start, bans, flags


def roman(s):
    n = 0
    for a, b in zip(s, s[1:] + ' '):
        v = ROMAN.get(a, 0)
        n += -v if ROMAN.get(b, 0) > v else v
    return n


def main():
    args = sys.argv[1:]
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d   # noqa: E731
    here = os.path.dirname(os.path.abspath(__file__))
    root = opt('--root', os.path.dirname(here))
    cache_dir = opt('--cache', os.path.join(here, '.at-cache'))
    short = next((a for a in args if not a.startswith('--') and a not in (opt('--root', None), opt('--cache', None))), 'ATXXII')
    os.makedirs(cache_dir, exist_ok=True)

    mcp = Mcp()
    tour = mcp.call('get_tournament', short_name=short)
    tid = tour.get('id') or tour.get('tournament_id')
    listed, page = [], 1
    while True:
        part = mcp.call('list_tournament_matches', tournament_id=tid, page=page, per_page=50)
        listed += part['matches']
        if not part.get('has_more'):
            break
        page += 1

    matches = []
    for i, row in enumerate(listed):
        path = os.path.join(cache_dir, f'{row["id"]}.json')
        if os.path.exists(path):
            with open(path) as fh:
                out = json.load(fh)
            if find_kills(out):
                with open(path, 'w') as fh:
                    json.dump(out, fh, ensure_ascii=False)
            matches.append(out)
            continue
        m = mcp.call('get_match', id=row['id'])
        if m.get('winner') not in ('red', 'blue'):
            continue   # 还没打完
        start, bans, flags = parse_page(fetch_page(row['id']))
        side = lambda s: {   # noqa: E731
            'id': m[s]['alliance_id'], 'name': m[s]['name'],
            'ships': [[p['ship_id'], p['player_id'], p['player_name'], 1 if p.get('survival') == 'survived' else 0, 1 if p['player_id'] in flags else 0]
                      for p in m[s]['participants'] if p.get('ship_id')]
        }
        out = {'id': m['id'], 'no': m.get('match_no'), 'series': m.get('series_no'), 'type': m.get('type'), 'start': start,
               'winner': m['winner'], 'bans': bans, 'red': side('red'), 'blue': side('blue')}
        find_kills(out)
        with open(path, 'w') as fh:
            json.dump(out, fh, ensure_ascii=False)
        matches.append(out)
        print(f'  {i + 1}/{len(listed)} #{out["id"]} {out["red"]["name"]} vs {out["blue"]["name"]}', file=sys.stderr)
        time.sleep(0.3)

    matches.sort(key=lambda x: (x['start'] or '', x['id']), reverse=True)
    num = roman(short[2:]) if short.startswith('AT') else 0
    target = os.path.join(root, 'at-data.json')
    points = load_points()
    if points is None:
        try:
            with open(target) as fh:
                points = json.load(fh).get('points')
        except (OSError, ValueError):
            points = None
    data = {'tournament': short, 'name': f'第 {num} 届联盟锦标赛' if num else short, 'limit': 200, 'points': points or {}, 'matches': matches}
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    try:
        with open(target) as fh:
            old = json.load(fh)
        old.pop('at', None)
        if old == json.loads(text):
            print(f'{short}：{len(matches)} 场，没有变化')
            return
    except (OSError, ValueError):
        pass
    data['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    tmp = target + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, target)
    print(f'{short}：{len(matches)} 场，已更新 {target}')


if __name__ == '__main__':
    main()
