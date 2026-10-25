// ===== 快递合同 =====
// 全服公开快递合同：按距离、报酬、风险综合评分，侧栏筛选；点开看详情，「接受」通过 ESI 把合同链接发到已绑定角色的游戏邮箱
// （ESI 不能代为接受合同，游戏里打开邮件点链接即可在合同窗口接受）。
// 数据：宁静服优先用击杀记录服务的 /api/kb/couriers（EVE Ref 全服公开合同快照，约 30 分钟更新，一次请求）；
//       服务不可用或晨曦服时，浏览器直接逐个星域读取 ESI /contracts/public/{region_id}/ 并筛出快递合同。
// 路线：map-data.json 星门图上做广度优先搜索；「安全优先」时起终点都在高安则只走高安，走不通再用最短路线。
// 推荐用船：按体积、抵押与路线安全从工业舰 / 封锁运输舰 / 深空运输舰 / 货舰 / 跳货中挑选，装配与容量见 courier-ships.js；
//           路线经过低安 / 00 时默认跳货优先（可改），跳货另用跳跃规划算出跳跃次数与燃料。
import { SERVER, IS_TQ, HUB, HUB_NAME } from './server.js?v=s4';
import { SHIPS as HULLS, MODULES } from './courier-ships.js?v=v1';
import { planJumpRoute, canJumpInto } from './jump-planner.js?v=v15';

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, esiAuthFetch, openEftFit, hasEsiToken, tokenInfo, hasScope, officialName, loadNpcNames, resolveNames, resolveStructures, openEsiBind, openMapSystem, closeDrawer
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-courier-v1';
const MAIL_SCOPE = 'esi-mail.send_mail.v1';
const DATA_TTL = 30 * 60e3;
const CHAR_LOC_TTL = 60e3;
const PAGE = 100;
const POCHVEN = 10000070;
const SCAN_WORKERS = 8;

// 舰船容量：常见运输舰型的货舱上限（m³）
const SHIPS = [
  [0, '不限'],
  [5000, '≤ 5,000 m³（工业舰 / 小件）'],
  [13000, '≤ 13,000 m³（封锁运输舰）'],
  [62500, '≤ 62,500 m³（深空运输舰）'],
  [360000, '≤ 360,000 m³（跳跃货舰）'],
  [1300000, '≤ 1,300,000 m³（货舰）']
];
// 综合评分权重：每跳收益 / 报酬 / 取货距离 / 安全
const FOCUS = {
  balance: ['平衡', { v: 0.4, r: 0.2, d: 0.15, s: 0.25 }],
  profit: ['收益', { v: 0.5, r: 0.3, d: 0.05, s: 0.15 }],
  safe: ['安全', { v: 0.25, r: 0.1, d: 0.1, s: 0.55 }],
  near: ['就近', { v: 0.25, r: 0.1, d: 0.45, s: 0.2 }]
};
const SORTS = {
  score: ['综合推荐', (c) => -c.score],
  ipj: ['每跳收益', (c) => -(c.ipj ?? -1)],
  reward: ['报酬最高', (c) => -c.reward],
  pickup: ['离我最近', (c) => c.pickup ?? Infinity],
  risk: ['风险最低', (c) => c.risk],
  jumps: ['路线最短', (c) => c.route?.jumps ?? Infinity],
  collateral: ['抵押最低', (c) => c.collateral],
  volume: ['体积最小', (c) => c.volume],
  expire: ['即将过期', (c) => c.expires]
};
const DEFAULTS = { focus: 'balance', route: 'safe', sec: 'any', ship: 0, minReward: '', maxCollateral: '', maxPickup: '', region: 0, hideUnknown: false, sort: 'score', origin: null, lowShip: 'jf', race: 'auto' };

// ---------- 推荐用船 ----------
const RACES = [['auto', '自动'], ['caldari', '加达里'], ['gallente', '盖伦特'], ['amarr', '艾玛'], ['minmatar', '米玛']];
const LOW_SHIPS = [['jf', '跳货'], ['br', '封锁运输'], ['dst', '深空运输'], ['auto', '最小船']];
const LOW_TEXT = { jf: '跳货', br: '封锁运输舰', dst: '深空运输舰', auto: '能装下的最小船' };
const ROLES = {
  industrial: { name: 'T1 工业舰', short: '工业舰', why: '全高安路线、货值不高，便宜的 T1 工业舰就够用；被打掉损失也小' },
  br: { name: '封锁运输舰', short: '封锁运输', why: '货柜舱无法被扫描，能装隐秘行动隐形装置：隐形 + 微跃推进器起跳，在低安 / 00 也很难被拦住' },
  dst: { name: '深空运输舰', short: '深空运输', why: '舰队机库 62,500 m³、货物无法被扫描、血量高，可用微型跳跃引擎或隐形 + 微跃推进器摆脱拦截' },
  freighter: { name: '货舰', short: '货舰', why: '大体积只能用货舰；装得下时尽量多装强化舱隔壁提高血量，防自杀式攻击' },
  jf: { name: '跳跃货舰', short: '跳货', why: '路线经过低安 / 00：跳跃货舰用跳跃引擎直接跳到目的地附近，少走危险星门' }
};
const HIGH_VALUE = 3e8;          // 抵押 ≥ 3 亿视为高价值货物，高安也不用 T1 工业舰
const JDC = 5, JFC = 5, JF_SKILL = 5;
const FUEL_ZH = { 16274: '氦同位素', 17887: '氧同位素', 17888: '氮同位素', 17889: '氢同位素' };
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;

const F = { ...DEFAULTS };
const S = { list: null, at: null, loadedAt: 0, source: '', loading: null, error: null, progress: '', shown: PAGE, q: '', charSys: null, charAt: 0, charLoading: null, open: null, sent: new Set(), routeKey: '' };
let G = null;           // 星门图
let graphPromise = null;

export function initCourier(context) {
  ctx = context;
  Object.assign(F, ctx.store.getJSON(STORE_KEY, {}) || {});
  if (!FOCUS[F.focus]) F.focus = 'balance';
  if (!SORTS[F.sort]) F.sort = 'score';
}

const save = () => ctx.store.setJSON(STORE_KEY, F);
const esc = (s) => ctx.esc(s);

// ---------- 星图 ----------
function loadGraph() {
  if (!graphPromise) {
    graphPromise = fetch(SERVER.mapData).then((r) => r.json()).then((d) => {
      const n = d.systems.length;
      const g = {
        n, ids: new Int32Array(n), names: [], sec: new Float32Array(n), region: new Int32Array(n), cls: new Uint8Array(n), xyz: d.systems.map((s) => [s[2], s[3], s[4]]),
        index: new Map(), byName: new Map(), adj: d.systems.map(() => []), stationSys: new Map(),
        regionName: new Map(d.regions.map((r) => [r[0], r[1]]))
      };
      d.systems.forEach((s, i) => {
        g.ids[i] = s[0]; g.names[i] = s[1]; g.sec[i] = s[5]; g.region[i] = s[6];
        g.cls[i] = secClass(s[5], s[6]);
        g.index.set(s[0], i);
        if (s[6] < 11000000) g.byName.set(s[1].toLowerCase(), i);
        for (const st of s[11] || []) g.stationSys.set(st, s[0]);
      });
      for (const [a, b] of d.gates || []) { g.adj[a].push(b); g.adj[b].push(a); }
      G = g;
      return g;
    }).catch((error) => { graphPromise = null; throw error; });
  }
  return graphPromise;
}

function secDisplay(sec) {
  if (sec > 0 && sec < 0.05) return 0.1;   // 与游戏一致：极低的正安等显示为 0.1
  return Math.max(0, Math.round(sec * 10) / 10);
}
// 0 高安 / 1 低安 / 2 00（波赫文按 00 算）
function secClass(sec, region) {
  if (region === POCHVEN) return 2;
  const d = secDisplay(sec);
  return d >= 0.5 ? 0 : d > 0 ? 1 : 2;
}
const SEC_CSS = ['sec-hi', 'sec-lo', 'sec-null'];
const secBadge = (i) => i == null || i < 0 ? '' : `<i class="cr-sec ${SEC_CSS[G.cls[i]]}">${secDisplay(G.sec[i]).toFixed(1)}</i>`;

// 广度优先搜索；hsOnly 时只经过高安星系
function bfs(src, hsOnly) {
  const dist = new Int16Array(G.n).fill(-1);
  const prev = new Int32Array(G.n).fill(-1);
  dist[src] = 0;
  const queue = [src];
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (const v of G.adj[u]) {
      if (dist[v] >= 0 || (hsOnly && G.cls[v] !== 0)) continue;
      dist[v] = dist[u] + 1;
      prev[v] = u;
      queue.push(v);
    }
  }
  return { dist, prev };
}

function walk(tree, to) {
  const path = [];
  for (let u = to; u >= 0; u = tree.prev[u]) path.push(u);
  return path.reverse();
}

// ---------- 数据 ----------
async function fetchSnapshot() {
  if (!IS_TQ) return null;
  try {
    const r = await fetch('/api/kb/couriers');
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.at && Array.isArray(d.list) ? d : null;
  } catch {
    return null;
  }
}

// 浏览器直接读取 ESI：先取各星域第 1 页得到页数，再并发取其余页
async function scanEsi() {
  const regions = [...G.regionName.keys()].filter((id) => id < 11000000);
  const tasks = regions.map((id) => [id, 1]);
  const out = [];
  let done = 0, total = regions.length;
  const page = async (region, p) => {
    const url = `${SERVER.esi}/contracts/public/${region}/?datasource=${SERVER.datasource}&page=${p}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url).catch(() => null);
      if (res?.status === 204 || res?.status === 404) return;
      if (res?.ok) {
        const list = await res.json();
        if (p === 1) {
          const pages = Number(res.headers.get('X-Pages')) || 1;
          for (let i = 2; i <= pages; i++) tasks.push([region, i]);
          total += pages - 1;
        }
        for (const c of list) if (c.type === 'courier') out.push({ ...c, region_id: region });
        return;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  };
  const worker = async () => {
    while (tasks.length) {
      const [region, p] = tasks.shift();
      await page(region, p);
      done += 1;
      S.progress = `正在从 ESI 读取各星域公开合同… ${done} / ${total} 页`;
      const el = document.querySelector('.cr-progress');
      if (el) el.textContent = S.progress;
    }
  };
  await Promise.all(Array.from({ length: SCAN_WORKERS }, worker));
  return { at: new Date().toISOString(), list: out };
}

function loadContracts(force = false) {
  if (S.loading) return S.loading;
  if (!force && S.list && Date.now() - S.loadedAt < DATA_TTL) return Promise.resolve();
  S.error = null;
  S.loading = (async () => {
    await Promise.all([loadGraph(), ctx.loadNpcNames()]);
    let data = await fetchSnapshot();
    S.source = data ? 'snapshot' : 'esi';
    if (!data) {
      S.progress = '正在从 ESI 读取各星域公开合同…';
      renderMain();
      data = await scanEsi();
    }
    const now = Date.now();
    const list = data.list.filter((c) => !c.date_expired || Date.parse(c.date_expired) > now);
    // 玩家建筑：名称与星系来自本站建筑缓存 / 共享缓存 / 已绑定角色可见的建筑
    const structs = [...new Set(list.flatMap((c) => [c.start_location_id, c.end_location_id]).filter((id) => id >= 1e12))];
    const known = await ctx.resolveStructures(structs).catch(() => new Map());
    for (const c of list) {
      c.from = locInfo(c.start_location_id, c.start_system_id, known);
      c.to = locInfo(c.end_location_id, null, known);
      c.expires = c.date_expired ? Date.parse(c.date_expired) : Infinity;
    }
    S.list = list;
    S.at = data.at;
    S.loadedAt = now;
    S.routeKey = '';
    S.shown = PAGE;
  })().catch((error) => { S.error = error; }).finally(() => { S.loading = null; S.progress = ''; });
  return S.loading;
}

function locInfo(id, hintSys, structs) {
  if (id >= 60000000 && id < 64000000) {
    const sysId = G.stationSys.get(id);
    return { id, kind: 'station', name: ctx.officialName(id) || '空间站 ' + id, sys: sysId ? G.index.get(sysId) ?? -1 : -1, known: true };
  }
  if (id >= 1e12) {
    const info = structs.get(id);
    const sysId = info?.system || hintSys;
    const sys = sysId ? G.index.get(sysId) ?? -1 : -1;
    const name = info?.name || (sys >= 0 ? G.names[sys] + ' · 玩家建筑（名称不公开）' : '玩家建筑（名称与位置不公开）');
    return { id, kind: 'structure', name, sys, known: Boolean(info?.name) };
  }
  return { id, kind: 'unknown', name: '位置 ' + id, sys: -1, known: false };
}

// ---------- 角色位置 ----------
async function refreshCharLocation(force = false) {
  if (!ctx.hasEsiToken()) { S.charSys = null; return false; }
  if (!force && Date.now() - S.charAt < CHAR_LOC_TTL) return false;
  if (S.charLoading) return S.charLoading;
  S.charLoading = (async () => {
    try {
      const token = ctx.tokenInfo();
      const loc = await ctx.esiAuthFetch('/characters/' + token.character_id + '/location/');
      const changed = S.charSys !== loc.solar_system_id;
      S.charSys = loc.solar_system_id;
      return changed;
    } catch {
      return false;   // 没有位置权限：只能手动填写所在星系
    } finally {
      S.charAt = Date.now();
      S.charLoading = null;
    }
  })();
  return S.charLoading;
}

// 计算取货跳数的出发星系：手动填写优先，否则用角色当前位置
function originIndex() {
  const id = F.origin?.id || S.charSys;
  return id ? G.index.get(id) ?? -1 : -1;
}

// ---------- 评估 ----------
function computeRoutes() {
  const key = F.route + ':' + S.at;
  if (S.routeKey === key) return;
  S.routeKey = key;
  const byStart = new Map();
  for (const c of S.list) {
    c.route = null;
    if (c.from.sys < 0 || c.to.sys < 0) continue;
    if (!byStart.has(c.from.sys)) byStart.set(c.from.sys, []);
    byStart.get(c.from.sys).push(c);
  }
  for (const [src, list] of byStart) {
    const all = bfs(src, false);
    const hs = F.route === 'safe' && G.cls[src] === 0 ? bfs(src, true) : null;
    for (const c of list) {
      const dst = c.to.sys;
      const useHs = hs && hs.dist[dst] >= 0;
      if (!useHs && all.dist[dst] < 0) continue;
      const path = walk(useHs ? hs : all, dst);
      const count = [0, 0, 0];
      for (const i of path) count[G.cls[i]] += 1;
      c.route = { path, jumps: path.length - 1, hs: count[0], ls: count[1], ns: count[2], shortest: all.dist[dst], safe: Boolean(useHs) };
    }
  }
}

function evaluate() {
  computeRoutes();
  const o = originIndex();
  let dist = null;
  if (o >= 0) {
    const all = bfs(o, false).dist;
    dist = all;
    if (F.route === 'safe' && G.cls[o] === 0) {
      const hs = bfs(o, true).dist;
      dist = hs.map((d, i) => (d >= 0 ? d : all[i]));
    }
  }
  const w = FOCUS[F.focus][1];
  for (const c of S.list) {
    c.pickup = dist && c.from.sys >= 0 && dist[c.from.sys] >= 0 ? dist[c.from.sys] : null;
    const total = c.route ? c.route.jumps + (c.pickup || 0) : null;
    c.total = total;
    c.ipj = total == null ? null : c.reward / Math.max(1, total);
    c.factors = riskFactors(c);
    c.risk = Math.min(100, c.factors.reduce((s, f) => s + f.pts, 0));
    const v = c.ipj == null ? 0 : clamp((Math.log10(Math.max(c.ipj, 1)) - 5) / 2.3);
    const r = clamp((Math.log10(Math.max(c.reward, 1)) - 6) / 2.7);
    const d = c.pickup == null ? (o >= 0 ? 0 : 0.6) : clamp(1 - c.pickup / 25);
    const s = 1 - c.risk / 100;
    c.parts = { v, r, d, s };
    c.ship = recommend(c);
    c.score = Math.round(100 * (w.v * v + w.r * r + w.d * d + w.s * s) * (c.route ? 1 : 0.6));
  }
}

const clamp = (x) => Math.max(0, Math.min(1, x));

// 风险因素：每项 { text, pts }，合计封顶 100
function riskFactors(c) {
  const out = [];
  const r = c.route;
  if (!r) out.push({ text: c.from.sys < 0 || c.to.sys < 0 ? '起点或终点所在星系不明，无法规划路线' : '星门无法到达（需要跳跃引擎或虫洞）', pts: 30 });
  else {
    if (r.ns) out.push({ text: `途经 00 / 波赫文星系 ${r.ns} 个`, pts: 35 + Math.min(15, r.ns * 2) });
    if (r.ls) out.push({ text: `途经低安星系 ${r.ls} 个`, pts: 15 + Math.min(15, r.ls * 2) });
    if (F.route === 'safe' && !r.safe && G.cls[c.from.sys] === 0 && G.cls[c.to.sys] === 0) out.push({ text: '起终点都在高安，但没有全高安路线', pts: 5 });
  }
  const col = c.collateral;
  const colPts = col >= 5e9 ? 25 : col >= 2e9 ? 18 : col >= 1e9 ? 12 : col >= 5e8 ? 7 : col >= 1e8 ? 3 : 0;
  if (colPts) out.push({ text: `抵押 ${ctx.formatISK(col)} ISK：货物价值高，容易成为自杀式攻击的目标`, pts: colPts });
  for (const [loc, label] of [[c.from, '起点'], [c.to, '终点']]) {
    if (loc.kind !== 'structure') continue;
    if (!loc.known) out.push({ text: `${label}是名称不公开的玩家建筑，可能没有停靠权限`, pts: 15 });
    else out.push({ text: `${label}是玩家建筑，停靠权限可能被收回`, pts: 5 });
  }
  if (c.to.kind === 'structure' && col >= 5e8) out.push({ text: '大额抵押 + 玩家建筑终点：常见的快递骗局形式，接单前确认能停靠', pts: 10 });
  // 按每跳约 3 分钟估算（货舰在高安的平均用时），所需时间超过期限一半时提示
  if (c.total != null && c.days_to_complete && c.total * 3 > c.days_to_complete * 24 * 60 * 0.5) out.push({ text: `完成期限只有 ${c.days_to_complete} 天，路程偏紧`, pts: 10 });
  return out;
}

// 某用途下能装下这单的船：指定种族优先（装不下再看其他种族），自动时取有效血量最高的；
// 货舰 / 跳货在装得下的前提下尽量多装强化舱隔壁
function pickHull(role, volume) {
  const all = RACES.slice(1).map(([r]) => r);
  for (const races of F.race === 'auto' ? [all] : [[F.race], all]) {
    let best = null;
    for (const race of races) {
      const h = HULLS[role][race];
      let cand = null;
      if (h.variants) {
        for (let k = 3; k >= 0 && !cand; k--) if (h.variants[k].cap >= volume) cand = { ...h.variants[k] };
      } else {
        const cap = role === 'dst' ? h.fleet : h.cap;
        if (cap >= volume) cand = { cap, ehp: h.ehp, align: h.align };
      }
      if (cand && (!best || cand.ehp > best.ehp)) best = { ...cand, role, race, hull: h };
    }
    if (best) return best;
  }
  return null;
}

function recommend(c) {
  const v = c.volume, r = c.route;
  const risky = !r || r.ls > 0 || r.ns > 0;
  const ns = !r || r.ns > 0;
  let order;
  if (!risky) order = c.collateral >= HIGH_VALUE ? ['br', 'dst', 'freighter'] : ['industrial', 'dst', 'freighter'];
  else {
    const tail = ns ? [] : ['freighter'];
    order = {
      jf: ['jf', ...tail],
      br: ['br', 'jf', ...tail],
      dst: ns ? ['br', 'jf'] : ['dst', 'br', 'jf', ...tail],
      auto: ['br', ...(ns ? [] : ['dst']), 'jf', ...tail]
    }[F.lowShip] || ['jf', ...tail];
  }
  for (const role of order) {
    const p = pickHull(role, v);
    if (!p) continue;
    p.risky = risky;
    p.alts = ['br', 'dst', 'jf', 'freighter', 'industrial'].filter((x) => x !== role && (risky ? x !== 'industrial' && !(ns && x === 'freighter') : x !== 'jf'))
      .map((x) => pickHull(x, v)).filter(Boolean).slice(0, 2);
    return p;
  }
  const maxCap = (role) => Math.max(...Object.values(HULLS[role]).map((h) => h.variants ? h.variants[0].cap : role === 'dst' ? h.fleet : h.cap));
  return { none: true, text: v > maxCap('freighter') ? '体积超过任何货舰的容量，单艘船装不下' : `体积超过跳货最大容量（${ctx.formatNumber(maxCap('jf'))} m³），且路线经过 00：没有适合单艘船的方案` };
}

function fitSlots(p) {
  const h = p.hull;
  if (h.fit) return h.fit;
  const k = p.bulk ?? 0;
  return { low: [...Array(3 - k).fill('Expanded Cargohold II'), ...Array(k).fill('Reinforced Bulkheads II')] };
}

function fitEft(p) {
  const slots = fitSlots(p);
  const lines = [`[${p.hull.en}, 快递 · ${ROLES[p.role].name}]`];
  for (const s of ['low', 'mid', 'high', 'rig']) if (slots[s]?.length) lines.push(...slots[s], '');
  return lines.join('\n').trim() + '\n';
}

const riskLevel = (risk) => (risk < 15 ? ['低', 'risk-low'] : risk < 40 ? ['中', 'risk-mid'] : ['高', 'risk-high']);

// ---------- 筛选 ----------
function filtered() {
  const q = S.q.toLowerCase();
  const minReward = Number(F.minReward) * 1e6 || 0;
  const maxCol = F.maxCollateral === '' ? Infinity : Number(F.maxCollateral) * 1e6;
  const maxPickup = F.maxPickup === '' ? Infinity : Number(F.maxPickup);
  const list = S.list.filter((c) => {
    if (F.ship && c.volume > F.ship) return false;
    if (c.reward < minReward || c.collateral > maxCol) return false;
    if (F.region && c.region_id !== F.region) return false;
    if (F.hideUnknown && ((c.from.kind === 'structure' && !c.from.known) || (c.to.kind === 'structure' && !c.to.known))) return false;
    if (F.sec === 'hs' && (!c.route || c.route.ls || c.route.ns)) return false;
    if (F.sec === 'ls' && (!c.route || c.route.ns)) return false;
    if (maxPickup < Infinity && (c.pickup == null || c.pickup > maxPickup)) return false;
    if (q && !searchText(c).includes(q)) return false;
    return true;
  });
  const key = SORTS[F.sort][1];
  return list.sort((a, b) => key(a) - key(b) || b.score - a.score);
}

function searchText(c) {
  if (!c.search) {
    const parts = [c.from.name, c.to.name, c.title];
    for (const loc of [c.from, c.to]) if (loc.sys >= 0) parts.push(G.names[loc.sys], G.regionName.get(G.region[loc.sys]) || '');
    c.search = parts.join(' ').toLowerCase();
  }
  return c.search;
}

// ---------- 页面 ----------
// 预加载（modern-app.js：悬停导航按钮或常用页面空闲时调用），只取数据不渲染，打开页面时直接用
export const preload = () => loadContracts();

export async function showCourier() {
  const main = $('courierMain');
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="ind-page cr-page">
        <div class="pi-head cr-head">
          <h2 id="crTitle">快递合同</h2>
          <div class="segmented cr-mode" role="group" aria-label="合同类型">
            <button type="button" data-cr-mode="courier" class="active">快递</button><button type="button" data-cr-mode="auction">拍卖</button>
          </div>
          <span class="text-muted" id="crMeta"></span>
          <button type="button" class="btn btn-ghost cr-refresh" data-cr-refresh title="重新读取合同">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>刷新
          </button>
        </div>
        <div class="cr-toolbar">
          <span class="cr-count" id="crCount"></span>
          <label class="cr-sort">排序
            <select id="crSort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
          </label>
        </div>
        <div id="crList"></div>
        <div id="auctionPage" hidden></div>
      </section>`;
    main.addEventListener('click', onMainClick);
    $('crSort').addEventListener('change', (e) => { F.sort = e.target.value; S.shown = PAGE; save(); renderList(); });
    const side = $('courierSide');
    side.addEventListener('click', onSideClick);
    side.addEventListener('change', onSideChange);
    let t = 0;
    $('courierSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.shown = PAGE; renderList(); }, 150); });
    $('courierModal').addEventListener('click', onModalClick);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('courierModal').hidden) { e.stopImmediatePropagation(); closeDetail(); } }, true);
  }
  if (location.hash !== '#courier') history.replaceState(null, '', location.pathname + '#courier');
  const stale = !S.list || Date.now() - S.loadedAt >= DATA_TTL;
  if (stale) {
    renderMain();
    await loadContracts();
  }
  if (!F.origin) await refreshCharLocation();
  else refreshCharLocation();   // 手动位置时也读一次，供「角色位置」按钮使用
  renderAll();
}

function renderAll() {
  renderSide();
  renderMain();
}

function renderMain() {
  const list = $('crList');
  if (!list) return;
  $('crSort').value = F.sort;
  if (S.loading || (!S.list && !S.error)) {
    $('crMeta').textContent = '';
    $('crCount').textContent = '';
    list.innerHTML = `<div class="pi-loading cr-progress">${esc(S.progress || '载入快递合同…')}</div>`;
    return;
  }
  if (S.error) {
    list.innerHTML = `<div class="empty-state cr-empty"><p>读取快递合同失败：${esc(S.error.message)}</p><button type="button" class="btn btn-primary" data-cr-refresh>重试</button></div>`;
    return;
  }
  const at = S.at ? new Date(S.at) : null;
  const src = S.source === 'snapshot' ? 'EVE Ref 全服快照' : 'ESI 各星域公开合同';
  $('crMeta').textContent = `全服公开快递合同 ${S.list.length} 份 · ${src}${at ? ' · ' + at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 更新' : ''}`;
  renderList();
}

function renderList() {
  const el = $('crList');
  if (!el || !S.list) return;
  evaluate();
  const rows = filtered();
  S.rows = rows;
  const o = originIndex();
  const total = rows.reduce((s, c) => s + c.reward, 0);
  $('crCount').innerHTML = `符合条件 <b>${rows.length}</b> 份 · 报酬合计 ${ctx.formatISK(total)} ISK` +
    (o >= 0 ? ` · 取货跳数从 <b>${esc(G.names[o])}</b> 算起` : ' · <span class="text-muted">填写所在星系或绑定 ESI 后可算取货跳数</span>');
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state cr-empty"><p>没有符合条件的快递合同，可以放宽左侧的筛选条件</p></div>';
    return;
  }
  const head = `<div class="cr-row cr-row-head" role="row">
    ${[['score', '评分', 0], ['', '路线', 1], ['', '推荐用船', 8], ['jumps', '跳数', 2], ['volume', '体积', 3], ['reward', '报酬', 4], ['collateral', '抵押', 5], ['ipj', '每跳', 6], ['risk', '风险', 7]]
      .map(([k, l, i]) => `<span class="cr-c${i}">${k ? `<button type="button" data-cr-sort="${k}" class="${F.sort === k ? 'active' : ''}">${l}</button>` : l}</span>`).join('')}
  </div>`;
  el.innerHTML = `<div class="cr-table" role="table">${head}${rows.slice(0, S.shown).map(rowHtml).join('')}</div>` +
    (rows.length > S.shown ? `<button type="button" class="btn btn-ghost cr-more" data-cr-more>显示更多（还有 ${rows.length - S.shown} 份）</button>` : '');
}

function locShort(loc) {
  if (loc.sys < 0) return `<span class="cr-loc"><b>${loc.kind === 'structure' ? '玩家建筑' : '未知'}</b><small>位置不明</small></span>`;
  return `<span class="cr-loc">${secBadge(loc.sys)}<b>${esc(G.names[loc.sys])}</b><small>${esc(G.regionName.get(G.region[loc.sys]) || '')}</small>${loc.kind === 'structure' ? '<em class="cr-tag" title="玩家建筑">建筑</em>' : ''}</span>`;
}

function shipCell(p) {
  if (!p || p.none) return `<span class="cr-noship" title="${esc(p?.text || '')}">无合适船</span>`;
  const title = `${ROLES[p.role].name} · ${p.hull.zh}${p.bulk != null ? ` · ${p.bulk} 个强化舱隔壁` : ''} · 容量 ${ctx.formatNumber(p.cap)} m³`;
  return `<img src="${ICON(p.hull.id)}" alt="" width="22" height="22" loading="lazy"><span title="${esc(title)}"><b>${ROLES[p.role].short}</b><small>${esc(p.hull.zh)}</small></span>`;
}

function rowHtml(c) {
  const [lv, lvCls] = riskLevel(c.risk);
  const r = c.route;
  const jumps = r ? `<b>${r.jumps}</b><span class="cr-unit"> 跳</span>${c.pickup != null ? `<small>取货 ${c.pickup}</small>` : ''}` : '<span class="text-muted">—</span>';
  return `<button type="button" class="cr-row" data-cr-id="${c.contract_id}" role="row">
    <span class="cr-c0"><span class="cr-score" style="--p:${c.score}">${c.score}</span></span>
    <span class="cr-c1 cr-route">${locShort(c.from)}<span class="cr-arrow" aria-hidden="true">→</span>${locShort(c.to)}</span>
    <span class="cr-c8 cr-shipcell">${shipCell(c.ship)}</span>
    <span class="cr-c2 num">${jumps}</span>
    <span class="cr-c3 num">${ctx.formatNumber(c.volume)}<span class="cr-unit"> m³</span></span>
    <span class="cr-c4 num cr-reward">${ctx.formatISK(c.reward)}</span>
    <span class="cr-c5 num">${c.collateral ? ctx.formatISK(c.collateral) : '<span class="text-muted">无</span>'}</span>
    <span class="cr-c6 num">${c.ipj == null ? '—' : ctx.formatISK(c.ipj)}</span>
    <span class="cr-c7"><span class="cr-risk ${lvCls}" title="风险分 ${c.risk}">${lv}</span></span>
  </button>`;
}

// ---------- 侧栏 ----------
function renderSide() {
  const el = $('courierSide');
  if (!el || !G) return;
  const seg = (name, items) => `<div class="segmented cr-seg" role="group">${items.map(([v, l]) => `<button type="button" data-cr-set="${name}" data-v="${v}" class="${String(F[name]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const counts = new Map();
  for (const c of S.list || []) counts.set(c.region_id, (counts.get(c.region_id) || 0) + 1);
  const regions = [...counts.entries()].map(([id, n]) => [id, G.regionName.get(id) || String(id), n]).sort((a, b) => b[2] - a[2]);
  const charName = S.charSys && G.index.has(S.charSys) ? G.names[G.index.get(S.charSys)] : '';
  const originName = F.origin?.id && G.index.has(F.origin.id) ? G.names[G.index.get(F.origin.id)] : '';
  const originHint = F.origin ? `手动指定：${esc(originName)}` : charName ? `角色当前位置：${esc(charName)}` : ctx.hasEsiToken() ? '读不到角色位置（需要位置权限），可手动填写' : '未绑定 ESI，可手动填写所在星系';
  el.innerHTML = `
    <div class="ind-side-section cr-side-sec">
      <h4>评分侧重</h4>
      ${seg('focus', Object.entries(FOCUS).map(([k, [l]]) => [k, l]))}
    </div>
    <div class="ind-side-section cr-side-sec">
      <h4>我的位置 <small>用于计算取货跳数</small></h4>
      <div class="cr-origin">
        <input type="search" class="cr-input" id="crOrigin" list="crSystems" placeholder="输入星系名，如 ${HUB_NAME}" value="${esc(originName)}" autocomplete="off" spellcheck="false" aria-label="所在星系">
        ${F.origin && ctx.hasEsiToken() ? '<button type="button" class="btn btn-ghost" data-cr-charloc title="改用角色当前位置">角色位置</button>' : ''}
      </div>
      <p class="cr-hint">${originHint}</p>
      <datalist id="crSystems">${systemOptions()}</datalist>
    </div>
    <div class="ind-side-section cr-side-sec">
      <h4>路线</h4>
      ${seg('route', [['safe', '安全优先'], ['short', '最短']])}
      <h4>路线安全</h4>
      ${seg('sec', [['any', '不限'], ['ls', '不进 00'], ['hs', '仅高安']])}
    </div>
    <div class="ind-side-section cr-side-sec">
      <h4>推荐用船 <small>低安 / 00 路线优先用</small></h4>
      ${seg('lowShip', LOW_SHIPS)}
      <h4>种族偏好</h4>
      ${seg('race', RACES)}
      <p class="cr-hint">容量按全部技能 5 级计算</p>
    </div>
    <div class="ind-side-section cr-side-sec">
      <h4>舰船容量</h4>
      <select class="cr-input" data-cr-field="ship" aria-label="舰船容量">${SHIPS.map(([v, l]) => `<option value="${v}"${F.ship === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="cr-fields">
        <label>最低报酬<span><input type="number" class="cr-input" data-cr-field="minReward" min="0" step="1" placeholder="不限" value="${esc(F.minReward)}">百万</span></label>
        <label>最高抵押<span><input type="number" class="cr-input" data-cr-field="maxCollateral" min="0" step="10" placeholder="不限" value="${esc(F.maxCollateral)}">百万</span></label>
        <label>取货距离<span><input type="number" class="cr-input" data-cr-field="maxPickup" min="0" step="1" placeholder="不限" value="${esc(F.maxPickup)}">跳内</span></label>
      </div>
    </div>
    <div class="ind-side-section cr-side-sec">
      <h4>起点星域</h4>
      <select class="cr-input" data-cr-field="region" aria-label="起点星域">
        <option value="0">全部星域（${(S.list || []).length}）</option>
        ${regions.map(([id, name, n]) => `<option value="${id}"${F.region === id ? ' selected' : ''}>${esc(name)}（${n}）</option>`).join('')}
      </select>
      <label class="cr-check"><input type="checkbox" data-cr-field="hideUnknown"${F.hideUnknown ? ' checked' : ''}> 隐藏名称不公开的玩家建筑</label>
      <button type="button" class="btn btn-ghost cr-reset" data-cr-reset>重置筛选</button>
    </div>
    <details class="cr-help">
      <summary>评分怎么算</summary>
      <p><b>综合评分</b>（0–100）= 每跳收益、报酬大小、取货距离、安全四项按「评分侧重」加权。每跳收益 = 报酬 ÷（取货跳数 + 运送跳数）。</p>
      <p><b>风险</b>看路线经过的低安 / 00 星系、抵押金额（货值越高越容易被自杀式攻击）、是否为不公开的玩家建筑（可能无法停靠）以及完成期限是否紧张。</p>
      <p>快递合同里的货物不公开，抵押金额只能大致反映货值。</p>
    </details>`;
}

let systemOptionsHtml = '';
function systemOptions() {
  if (!systemOptionsHtml) systemOptionsHtml = [...G.byName.values()].map((i) => `<option value="${esc(G.names[i])}">`).join('');
  return systemOptionsHtml;
}

// 侧栏里的输入框 / 下拉框改动时只重绘列表，保留侧栏焦点
function update(side = true) {
  save();
  S.shown = PAGE;
  if (side) renderAll();
  else renderMain();
}

function onSideClick(e) {
  const set = e.target.closest('[data-cr-set]');
  if (set) {
    F[set.dataset.crSet] = set.dataset.v;
    update();
    return;
  }
  if (e.target.closest('[data-cr-charloc]')) {
    F.origin = null;
    refreshCharLocation(true).then(update);
    update();
    return;
  }
  if (e.target.closest('[data-cr-reset]')) {
    const { origin, sort } = F;
    Object.assign(F, DEFAULTS, { origin, sort });
    update();
  }
}

function onSideChange(e) {
  const t = e.target;
  if (t.id === 'crOrigin') {
    const v = t.value.trim().toLowerCase();
    if (!v) { F.origin = null; refreshCharLocation(true).then(update); update(); return; }
    let i = G.byName.get(v);
    if (i == null) {
      const hits = [...G.byName.entries()].filter(([name]) => name.startsWith(v));
      if (hits.length === 1) i = hits[0][1];
    }
    if (i == null) { ctx.showToast('找不到星系「' + t.value.trim() + '」', 'error'); return; }
    F.origin = { id: G.ids[i] };
    update();
    return;
  }
  const field = t.dataset.crField;
  if (!field) return;
  if (field === 'hideUnknown') F.hideUnknown = t.checked;
  else if (field === 'ship' || field === 'region') F[field] = Number(t.value) || 0;
  else F[field] = t.value === '' || Number(t.value) < 0 ? '' : t.value;
  update(false);
}

function onMainClick(e) {
  const mode = e.target.closest('[data-cr-mode]');
  if (mode) { setMode(mode.dataset.crMode); return; }
  if (e.target.closest('#auctionPage')) return;
  if (e.target.closest('[data-cr-refresh]')) {
    loadContracts(true).then(renderAll);
    renderMain();
    return;
  }
  const sort = e.target.closest('[data-cr-sort]');
  if (sort) { F.sort = sort.dataset.crSort; S.shown = PAGE; save(); renderMain(); return; }
  if (e.target.closest('[data-cr-more]')) { S.shown += PAGE; renderList(); return; }
  const row = e.target.closest('[data-cr-id]');
  if (row) openDetail(Number(row.dataset.crId));
}

// ---------- 详情 ----------
let returnFocus = null;
function openDetail(id) {
  const c = S.list?.find((x) => x.contract_id === id);
  if (!c) return;
  S.open = c;
  returnFocus = document.activeElement;
  $('courierModal').hidden = false;
  renderDetail(c);
  $('courierModal').querySelector('.modal-close')?.focus();
  // 发布人名称（玩家角色 / 军团名只有英文原名）
  ctx.resolveNames([c.issuer_id, c.issuer_corporation_id]).then(({ names }) => {
    if (S.open !== c) return;
    c.issuerName = names.get(c.issuer_id);
    c.corpName = names.get(c.issuer_corporation_id);
    const el = $('crIssuer');
    if (el) el.innerHTML = issuerHtml(c);
  }).catch(() => {});
}

function closeDetail() {
  $('courierModal').hidden = true;
  S.open = null;
  returnFocus?.focus?.();
}

// 快递 / 拍卖切换：拍卖模式隐藏快递筛选侧栏与列表，交给 auctions.js
function setMode(mode) {
  const auction = mode === 'auction';
  $('courierView').classList.toggle('au-mode', auction);
  document.querySelectorAll('[data-cr-mode]').forEach((b) => b.classList.toggle('active', b.dataset.crMode === mode));
  $('crTitle').textContent = auction ? '公开拍卖' : '快递合同';
  for (const el of [$('crList'), document.querySelector('.cr-toolbar:not(.au-toolbar)'), $('crMeta'), document.querySelector('.cr-refresh')]) if (el) el.hidden = auction;
  $('auctionPage').hidden = !auction;
  if (auction) ctx.renderAuctions($('auctionPage'));
}

function onModalClick(e) {
  if (e.target.closest('.modal-backdrop, [data-cr-close]')) { closeDetail(); return; }
  const c = S.open;
  if (!c) return;
  if (e.target.closest('[data-cr-mail]')) { sendMail(c, e.target.closest('[data-cr-mail]')); return; }
  if (e.target.closest('[data-cr-bind]')) { closeDetail(); ctx.openEsiBind(); return; }
  if (e.target.closest('[data-cr-game]')) { ctx.game.contract(c.contract_id); return; }
  if (e.target.closest('[data-cr-copy]')) { ctx.copyText(String(c.contract_id), '合同 ID 已复制'); return; }
  if (e.target.closest('[data-cr-fit-copy]') && c.ship && !c.ship.none) { copyEft(fitEft(c.ship)); return; }
  if (e.target.closest('[data-cr-fit-open]') && c.ship && !c.ship.none) {
    const text = fitEft(c.ship);
    closeDetail();
    ctx.openEftFit(text);
    return;
  }
  const map = e.target.closest('[data-cr-map]');
  if (map) { closeDetail(); ctx.openMapSystem(Number(map.dataset.crMap)); }
}

async function copyEft(text) {
  try {
    await navigator.clipboard.writeText(text);
    ctx.showToast('已复制 EFT 装配，可在游戏装配窗口或 Pyfa 中导入', 'success', 2500);
  } catch {
    ctx.showToast('浏览器阻止了复制', 'error');
  }
}

const issuerHtml = (c) => `${esc(c.issuerName || '角色 ' + c.issuer_id)}<small>${esc(c.corpName || '军团 ' + c.issuer_corporation_id)}${c.for_corporation ? ' · 代表军团发布' : ''}</small>`;

function remain(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '已过期';
  const m = Math.floor(ms / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d} 天 ${h % 24} 小时` : h ? `${h} 小时 ${m % 60} 分` : `${m} 分钟`;
}

function locBlock(loc, label) {
  const sys = loc.sys;
  const region = sys >= 0 ? G.regionName.get(G.region[sys]) || '' : '';
  return `<div class="cr-end">
    <span class="cr-end-label">${label}</span>
    <div class="cr-end-sys">${sys >= 0 ? `${secBadge(sys)}<button type="button" class="cr-link" data-cr-map="${G.ids[sys]}" title="在星图中查看">${esc(G.names[sys])}</button><small>${esc(region)}</small>` : '<b>星系不明</b>'}</div>
    <div class="cr-end-name">${loc.kind === 'structure' ? '<em class="cr-tag">玩家建筑</em>' : ''}${esc(loc.name)}</div>
  </div>`;
}

function renderDetail(c) {
  const [lv, lvCls] = riskLevel(c.risk);
  const r = c.route;
  const o = originIndex();
  $('courierTitle').textContent = '快递合同' + (c.title ? '：' + c.title : '');
  const stat = (label, value, sub = '') => `<div class="cr-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const routeText = r ? `${r.jumps} 跳${r.safe ? ' · 全高安' : r.jumps > r.shortest ? '' : ' · 最短'}` : '无法规划';
  const routeSub = r ? `经过高安 ${r.hs} · 低安 ${r.ls} · 00 ${r.ns} 个星系${F.route === 'safe' && r.safe && r.jumps > r.shortest ? ` · 最短 ${r.shortest} 跳` : ''}` : '';
  const hops = r ? r.path.map((i) => `<span class="cr-hop ${SEC_CSS[G.cls[i]]}-bg" title="${esc(G.names[i])} ${secDisplay(G.sec[i]).toFixed(1)}"></span>`).join('') : '';
  const names = r && r.path.length <= 60 ? r.path.map((i) => `<span class="cr-hop-name"><i class="${SEC_CSS[G.cls[i]]}-bg"></i>${esc(G.names[i])}</span>`).join('') : '';
  const token = ctx.hasEsiToken() ? ctx.tokenInfo() : null;
  const sent = S.sent.has(c.contract_id);
  const noScope = token && !ctx.hasScope(MAIL_SCOPE);
  const action = !token
    ? `<button type="button" class="btn btn-primary" data-cr-bind>绑定 ESI 后接受</button><p class="cr-hint">接受需要把合同链接发到你的游戏邮箱，请先绑定角色。</p>`
    : `<button type="button" class="btn btn-primary" data-cr-mail${sent ? ' disabled' : ''}>${sent ? '已发送到游戏邮箱' : '接受：发送到游戏邮箱'}</button>
       <button type="button" class="btn" data-cr-game title="需要「游戏内操作」权限，角色需在线">游戏内直接打开合同</button>
       <p class="cr-hint">${sent
         ? `已发送给 ${esc(token.character_name)}。在游戏里打开邮件，点击合同链接，在合同窗口点「接受」。`
         : `ESI 不能直接接受合同：点击后会给 <b>${esc(token.character_name)}</b> 发一封带合同链接的游戏邮件，在游戏里点链接即可接受。`}
       ${noScope ? '<br><span class="cr-warn">当前授权没有「发送邮件」权限（esi-mail.send_mail.v1），发送失败时请到个人中心重新绑定 ESI。</span>' : ''}</p>`;
  $('courierBody').innerHTML = `
    <div class="cr-detail">
      <div class="cr-ends">${locBlock(c.from, '取货')}<span class="cr-ends-arrow" aria-hidden="true">→</span>${locBlock(c.to, '送达')}</div>
      <div class="cr-stats">
        ${stat('报酬', ctx.formatISK(c.reward) + ' ISK', ctx.formatNumber(c.reward) + ' ISK')}
        ${stat('抵押', c.collateral ? ctx.formatISK(c.collateral) + ' ISK' : '无', c.collateral ? '报酬 / 抵押 ' + ((c.reward / c.collateral) * 100).toFixed(1) + '%' : '')}
        ${stat('体积', ctx.formatNumber(c.volume) + ' m³', c.volume ? '每 m³ ' + ctx.formatISK(c.reward / c.volume) + ' ISK' : '')}
        ${stat('运送路线', routeText, routeSub)}
        ${stat('取货距离', c.pickup != null ? c.pickup + ' 跳' : '—', o >= 0 ? '从 ' + esc(G.names[o]) : '未设置所在星系')}
        ${stat('每跳收益', c.ipj == null ? '—' : ctx.formatISK(c.ipj) + ' ISK', c.total != null ? '共 ' + c.total + ' 跳' : '')}
        ${stat('完成期限', c.days_to_complete + ' 天', '接受后开始计时')}
        ${stat('合同剩余', remain(c.expires - Date.now()), c.date_expired ? new Date(c.date_expired).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' 到期' : '')}
        <div class="cr-stat"><span>发布人</span><b id="crIssuer">${issuerHtml(c)}</b></div>
      </div>
      ${r ? `<div class="cr-section"><h4>路线 <small>${F.route === 'safe' ? '安全优先' : '最短路线'}</small></h4><div class="cr-hops">${hops}</div>${names ? `<div class="cr-hop-names">${names}</div>` : ''}</div>` : ''}
      ${shipSection(c)}
      <div class="cr-section">
        <h4>评估 <span class="cr-score" style="--p:${c.score}">${c.score}</span><span class="cr-risk ${lvCls}">风险${lv} · ${c.risk}</span></h4>
        <ul class="cr-factors">${c.factors.length ? c.factors.map((f) => `<li><span>${esc(f.text)}</span><b>+${f.pts}</b></li>`).join('') : '<li><span>全高安路线、抵押不高、起终点都是 NPC 空间站</span><b>0</b></li>'}</ul>
        <div class="cr-parts">${[['每跳收益', c.parts.v], ['报酬', c.parts.r], ['取货距离', c.parts.d], ['安全', c.parts.s]].map(([l, v]) => `<span><i style="--p:${Math.round(v * 100)}"></i>${l}</span>`).join('')}</div>
      </div>
      <div class="cr-actions">
        <div class="cr-action-main">${action}</div>
        <button type="button" class="btn btn-ghost" data-cr-copy>复制合同 ID</button>
      </div>
    </div>`;
  if (c.ship?.role === 'jf') setTimeout(() => renderJump(c), 30);   // 跳跃规划要几十毫秒，先显示弹窗
}

// ---------- 详情：推荐用船 ----------
const SLOT_ZH = { high: '高槽', mid: '中槽', low: '低槽', rig: '改装件' };

function shipSection(c) {
  const p = c.ship;
  if (!p) return '';
  if (p.none) return `<div class="cr-section"><h4>推荐用船</h4><p class="cr-noship-text">${esc(p.text)}</p></div>`;
  const role = ROLES[p.role];
  const slots = fitSlots(p);
  const fit = ['high', 'mid', 'low', 'rig'].filter((s) => slots[s]?.length).map((s) => {
    const counts = new Map();
    for (const n of slots[s]) counts.set(n, (counts.get(n) || 0) + 1);
    return `<div class="cr-fit-row"><span>${SLOT_ZH[s]}</span><div>${[...counts].map(([n, k]) => {
      const [id, zh] = MODULES[n] || [0, n];
      return `<span class="cr-mod">${id ? `<img src="${ICON(id)}" alt="" width="20" height="20" loading="lazy">` : ''}${esc(zh)}${k > 1 ? ` <b>×${k}</b>` : ''}</span>`;
    }).join('')}</div></div>`;
  }).join('');
  const hold = p.role === 'dst' ? '舰队机库' : '货柜舱';
  const reasons = [role.why];
  if (p.role === 'freighter' || p.role === 'jf') reasons.push(p.bulk ? `本单 ${ctx.formatNumber(c.volume)} m³：装 ${p.bulk} 个强化舱隔壁仍装得下${p.bulk < 3 ? `，其余 ${3 - p.bulk} 个用扩充货柜舱` : ''}` : '体积大，3 个低槽全用扩充货柜舱才装得下，血量最低，注意侦察');
  if (p.role === 'freighter' && p.risky) reasons.push('路线经过低安：货舰不能跳跃、起跳慢，非常容易被拦截，建议有侦察和护航，或改用跳货分趟');
  if (p.role === 'freighter' && !p.risky && c.collateral >= 1e9) reasons.push('抵押高：在' + HUB_NAME + '周边、乌克米等热门星系容易被自杀式攻击，可找队友用网子帮忙快速起跳');
  if (p.role === 'industrial' && c.collateral) reasons.push(`抵押 ${ctx.formatISK(c.collateral)}：货值不高，被打掉的可能小`);
  if (p.role === 'jf') reasons.push('跳跃货舰不能在高安启动跳跃引擎，也不能跳入高安：起点在高安时先走星门到低安，终点在高安时跳到附近低安再走星门');
  const alts = (p.alts || []).map((a) => `<span class="cr-alt"><img src="${ICON(a.hull.id)}" alt="" width="18" height="18" loading="lazy">${ROLES[a.role].name} · ${esc(a.hull.zh)}<small>${ctx.formatNumber(a.cap)} m³</small></span>`).join('');
  return `<div class="cr-section">
    <h4>推荐用船 <small>按全部技能 5 级计算${p.risky ? ' · 低安 / 00 路线优先用' + (LOW_TEXT[F.lowShip] || '') : ''}</small></h4>
    <div class="cr-ship">
      <img src="${ICON(p.hull.id, 64)}" alt="" width="56" height="56">
      <div class="cr-ship-main">
        <div class="cr-ship-name"><b>${esc(p.hull.zh)}</b><em class="cr-tag">${role.name}</em></div>
        <div class="cr-ship-stats">
          <span>${hold} <b>${ctx.formatNumber(p.cap)} m³</b></span>
          <span>本单占 <b>${Math.max(1, Math.round((c.volume / p.cap) * 100))}%</b></span>
          <span>有效血量 <b>${ctx.formatNumber(p.ehp)}</b></span>
          <span>起跳 <b>${p.align} 秒</b></span>
        </div>
        <ul class="cr-ship-why">${reasons.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="cr-fit">${fit}</div>
    ${p.role === 'jf' ? '<div class="cr-jump" id="crJump"><span class="text-muted">正在规划跳跃路线…</span></div>' : ''}
    <div class="cr-fit-actions">
      <button type="button" class="btn btn-ghost" data-cr-fit-open>去装配页查看</button>
      <button type="button" class="btn btn-ghost" data-cr-fit-copy>复制 EFT</button>
      ${alts ? `<span class="cr-alts">其他可选：${alts}</span>` : ''}
    </div>
  </div>`;
}

// 跳货路线：起点在高安时先走星门到最近的可跳跃星系，再用跳跃规划（最少跳跃次数，其次最短光年）
let jumpSystems = null;
function jumpGraph() {
  if (!jumpSystems) {
    jumpSystems = G.names.map((name, i) => ({ i, id: G.ids[i], name, x: G.xyz[i][0], y: G.xyz[i][1], z: G.xyz[i][2], sec: G.sec[i], region: G.region[i], nbr: G.adj[i] }));
  }
  return jumpSystems;
}

function planJf(c) {
  const p = c.ship;
  const from = c.from.sys, to = c.to.sys;
  if (from < 0 || to < 0) return { error: '起点或终点所在星系不明' };
  const systems = jumpGraph();
  let start = from;
  let before = [];
  if (!canJumpInto(systems[from])) {
    // 星门广度优先找最近的低安 / 00（可启动跳跃引擎）
    const t = bfs(from, false);
    let best = -1;
    for (let i = 0; i < G.n; i++) if (t.dist[i] > 0 && canJumpInto(systems[i]) && (best < 0 || t.dist[i] < t.dist[best])) best = i;
    if (best < 0) return { error: '起点附近没有可以启动跳跃引擎的星系' };
    before = walk(t, best);
    start = best;
  }
  if (start === to) return { before, legs: [], after: [] };
  const range = p.hull.range * (1 + 0.2 * JDC);
  const r = planJumpRoute(systems, start, to, { range });
  if (r.error) return { error: r.error };
  const after = r.gates.length ? [r.landing, ...r.gates] : [];
  const perLy = p.hull.fuel * (1 - 0.1 * JFC) * (1 - 0.1 * JF_SKILL);
  const fuel = r.legs.reduce((s, l) => s + Math.ceil(l.ly * perLy), 0);
  return { before, legs: r.legs, after, range, fuel, ly: r.legs.reduce((s, l) => s + l.ly, 0) };
}

function renderJump(c) {
  const el = $('crJump');
  if (!el || S.open !== c) return;
  const key = c.ship.hull.id + ':' + c.from.sys + ':' + c.to.sys;
  if (c.jf?.key !== key) c.jf = { key, plan: planJf(c) };
  const j = c.jf.plan;
  if (j.error) { el.innerHTML = `<span class="cr-warn">跳跃路线：${esc(j.error)}</span>`; return; }
  const sys = (i) => `${secBadge(i)}${esc(G.names[i])}`;
  const steps = [];
  if (j.before.length > 1) steps.push(`<li>星门 <b>${j.before.length - 1}</b> 跳到 ${sys(j.before[j.before.length - 1])}（起点在高安，不能启动跳跃引擎）</li>`);
  if (j.legs.length) steps.push(`<li>跳跃 <b>${j.legs.length}</b> 次：${j.legs.map((l) => `${sys(l.to)} <small>${l.ly.toFixed(1)} 光年</small>`).join(' → ')}</li>`);
  if (j.after.length > 1) steps.push(`<li>星门 <b>${j.after.length - 1}</b> 跳到 ${sys(j.after[j.after.length - 1])}（终点在高安，不能跳入）</li>`);
  const gates = c.route ? `，星门路线要 ${c.route.jumps} 跳` : '';
  el.innerHTML = `<h5>跳货路线 <small>跳跃距离 ${j.range?.toFixed(1) ?? '—'} 光年（跳跃引擎校准理论 5 级）${gates}</small></h5>
    <ol>${steps.join('') || '<li>起终点在同一星系</li>'}</ol>
    ${j.legs.length ? `<p class="cr-hint">共 ${j.ly.toFixed(1)} 光年，燃料约 <b>${ctx.formatNumber(j.fuel)}</b> 个${FUEL_ZH[c.ship.hull.fuelType] || '同位素'}（跳跃燃料节约、战略货舰操作均 5 级）</p>` : ''}`;
}

// ---------- 发送邮件 ----------
// 游戏内合同链接：<a href="contract:{星系ID}//{合同ID}">，收件人是已绑定角色自己
async function sendMail(c, btn) {
  const token = ctx.tokenInfo();
  if (!token) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '发送中…';
  const sysName = (loc) => (loc.sys >= 0 ? G.names[loc.sys] : '未知星系');
  const sysId = c.from.sys >= 0 ? G.ids[c.from.sys] : c.to.sys >= 0 ? G.ids[c.to.sys] : HUB.hub.system;
  const r = c.route;
  const [lv] = riskLevel(c.risk);
  const isk = (v) => ctx.formatNumber(v) + ' ISK';
  const lines = [
    `报酬：${isk(c.reward)}`,
    `抵押：${c.collateral ? isk(c.collateral) : '无'}`,
    `体积：${ctx.formatNumber(c.volume)} m³`,
    `路线：${r ? `${r.jumps} 跳（高安 ${r.hs} · 低安 ${r.ls} · 00 ${r.ns}）` : '无法规划'}`,
    `完成期限：${c.days_to_complete} 天`,
    c.date_expired ? `合同到期：${c.date_expired.replace('T', ' ').replace('Z', '')}（EVE 时间）` : '',
    `风险评估：${lv}（${c.risk}）`
  ].filter(Boolean);
  const body = `<font size="14">快递合同：在游戏中点击下方链接打开合同，在合同窗口接受。</font><br><br>` +
    `<a href="contract:${sysId}//${c.contract_id}">${esc(sysName(c.from))} → ${esc(sysName(c.to))}（合同 #${c.contract_id}）</a><br><br>` +
    `取货：${esc(c.from.name)}<br>送达：${esc(c.to.name)}<br><br>${lines.map(esc).join('<br>')}<br><br>由 EVE Market 快递页发送`;
  try {
    await ctx.esiAuthFetch('/characters/' + token.character_id + '/mail/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [{ recipient_id: token.character_id, recipient_type: 'character' }],
        subject: `快递：${sysName(c.from)} → ${sysName(c.to)} · 报酬 ${ctx.formatISK(c.reward)}`.slice(0, 150),
        body,
        approved_cost: 0
      })
    });
    S.sent.add(c.contract_id);
    ctx.showToast('已发送到 ' + token.character_name + ' 的游戏邮箱，在游戏里点邮件中的合同链接即可接受', 'success', 5000);
    if (S.open === c) renderDetail(c);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = label;
    const msg = error.status === 403 || /scope/i.test(error.esiError || '')
      ? '当前授权没有「发送邮件」权限，请到个人中心重新绑定 ESI 后再试'
      : '发送失败：' + (error.esiError || error.message);
    ctx.showToast(msg, 'error', 6000);
  }
}
