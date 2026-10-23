// ===== 行星工业规划 =====
// 选择地区（星域，或某星系周边若干跳）、角色数与技能，按吉他行情为每种产品（P1–P4）算出最优的行星分配，
// 给出每颗行星该放什么、预计日产量与收益，并生成游戏内可直接导入的殖民地模板（JSON）。
// ESI 只有读取殖民地的接口，不能写入模板，所以模板通过「复制到剪贴板」或「下载 .json」导入游戏。
// 数据：pi-data.json（build_pi.mjs 从 SDE 生成），map-data.json（星系、星门、星域）。
import { initPiEditor, openTemplateEditor, drawThumb, templateText, downloadTemplate, SPACING } from './pi-editor.js?v=v20r7';
import { angle } from './pi-globe.js?v=v19r12';
import { SERVER, HUB, HUB_NAME } from './server.js?v=s3';

let ctx;   // esc, formatISK, formatNumber, showToast, store, getHubPrices(ids) -> Map(id -> {sell, buy}), getMarketPriceMap
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-pi-form-v1';

// 指挥中心等级 0–5 的 [CPU, 电网]（指挥中心升级技能）
const CC_LEVELS = [[1675, 6000], [7057, 9000], [12136, 12000], [17215, 15000], [21315, 17000], [25415, 19000]];
const HEAD = [110, 550];               // 每个采集头 [CPU, 电网]
// 链接负载 [CPU, 电网]：长度 = 弧度 × 行星半径，所以同样的模板在大行星上更耗资源
const linkLoad = (radiusKm, rad = SPACING) => [Math.ceil(15 + 0.2 * rad * radiusKm), Math.ceil(10 + 0.15 * rad * radiusKm)];
const MAX_HEADS = 10;                  // 每个采集控制器最多 10 个采集头
const LP_CAP = 10000;                  // 发射平台容量 m³
const MAX_HUBS = 4;                    // 买料加工：每颗工厂星最多几个发射平台
// 买料加工：产品卖出、原料买入各不超过吉他日成交量的 F.share%（默认 10%），否则价格会被自己打穿；0 表示不限
const HUB_GAP = 0.15;                  // 多个发射平台之间的间距（弧度），两组设施互不重叠
// 海关出口税基数（每单位，按等级），进口为出口的一半
const TAX_BASE = [5, 400, 7200, 60000, 1200000];
// 资源丰度：每个采集头每小时平均产量（实际取决于热点位置与采集周期，仅作估算）
const RICHNESS = { low: [300, '低'], mid: [500, '中'], high: [750, '高'] };
const TIER_NAMES = ['P0 原材料', 'P1 基础产品', 'P2 精炼产品', 'P3 特种产品', 'P4 高级产品'];
const PLANET_COLORS = { T: '#5fbf6f', I: '#8fd3ff', G: '#e0bf62', O: '#4f8ff7', L: '#f06a3c', B: '#b9a47c', S: '#9a90e0', P: '#d36ad6' };
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
// 虫洞等级（SDE wormholeClassID）：1–6 = C1–C6，12 席拉，13 C13（碎裂），14–18 漂流者
const WH_CLASSES = [['1', 'C1'], ['2', 'C2'], ['3', 'C3'], ['4', 'C4'], ['5', 'C5'], ['6', 'C6'], ['13', 'C13'], ['12', '席拉'], ['d', '漂流者']];
const whKey = (cls) => (cls >= 14 && cls <= 18 ? 'd' : String(cls));
const whLabel = (cls) => WH_CLASSES.find(([k]) => k === whKey(cls))?.[1] || '虫洞';
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

const D = {
  loading: null,
  pi: null, map: null,
  ptByCode: {},          // 代码 -> 行星类型 { id, code, name, res, cc, ecu, basic, adv, ht, launchpad, storage }
  schemByOut: new Map(), // 产物 -> 配方 { id, cycle, out, outQty, inputs }
  sysById: new Map(),    // 星系 -> { id, name, sec, region, nbr:[] , planets:[{ code, radius, index }] }
  regions: []
};

const F = {               // 表单状态（保存在本地）
  mode: 'region', region: HUB.id, system: 0, jumps: 2,
  whCls: '4', whSystem: 0, // 虫洞：按等级，或指定一个星系（whSystem）
  sec: { high: true, low: true, null: true },
  chars: 1, perChar: 6, cc: 5,
  target: 0, rich: 'mid', tax: 10, price: 'sell',
  way: 'self',            // self 自产（采集）/ buy 买料加工
  inPrice: 'sell',        // 买料加工的原料价：sell 直接买卖单 / buy 挂收单
  restock: 24,            // 买料加工的补货周期（小时）
  share: 10               // 买料加工的成交量上限（占日成交 %），0 不限
};

const R = { area: null, plans: [], selected: 0, prices: new Map(), priceAt: 0, edits: new Map() };   // edits: 方案序号:模板 -> 修改后的模板

export function initPi(context) {
  ctx = context;
  Object.assign(F, ctx.store.getJSON(STORE_KEY, {}));
  F.sec = { high: true, low: true, null: true, ...F.sec };
}

// 模板编辑器需要的数据与工具
function editorEnv() {
  return {
    pi: D.pi, ptByCode: D.ptByCode, schemByOut: D.schemByOut, cName, tierOf,
    esc: ctx.esc, formatNumber: ctx.formatNumber, showToast: ctx.showToast,
    CC_LEVELS, HEAD, headRate, ICON
  };
}

function saveForm() { ctx.store.setJSON(STORE_KEY, F); }

// 虫洞页「行星工业规划」：按指定虫洞星系规划（之后进入行星工业页时生效）
export function useWormhole(systemId) {
  F.mode = 'wh';
  F.whSystem = systemId;
  saveForm();
  if ($('piMain')?.dataset.ready && D.pi) renderForm();
}

// ---------- 数据 ----------
function loadData() {
  if (!D.loading) {
    D.loading = Promise.all([
      fetch('pi-data.json?v=2').then((r) => { if (!r.ok) throw new Error('pi-data.json ' + r.status); return r.json(); }),
      fetch(SERVER.mapData).then((r) => { if (!r.ok) throw new Error('星图数据 ' + r.status); return r.json(); })
    ]).then(([pi, map]) => {
      D.pi = pi;
      for (const [id, p] of Object.entries(pi.planetTypes)) D.ptByCode[p.code] = { ...p, id: Number(id) };
      for (const [id, cycle, out, outQty, inputs] of pi.schematics) D.schemByOut.set(out, { id, cycle, out, outQty, inputs });
      const index = [];
      for (const s of map.systems) {
        const sys = { id: s[0], name: s[1], sec: s[5], region: s[6], nbr: [], planets: [] };
        index.push(sys);
        D.sysById.set(sys.id, sys);
      }
      for (const [a, b] of map.gates) { index[a].nbr.push(index[b].id); index[b].nbr.push(index[a].id); }
      // 虫洞星系不在星图里：没有星门，安全等级按 -1.0
      for (const [id, name, cls] of pi.wh || []) D.sysById.set(id, { id, name, sec: -1, region: 0, wh: cls, nbr: [], planets: [] });
      for (const [id, codes, radii, idx] of pi.systems) {
        const sys = D.sysById.get(id);
        if (sys) sys.planets = [...codes].map((code, i) => ({ code, radius: radii[i], index: idx[i] }));
      }
      const used = new Set(map.systems.map((s) => s[6]));
      D.regions = map.regions.filter((r) => used.has(r[0])).map((r) => ({ id: r[0], name: r[1] }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    }).catch((e) => { D.loading = null; throw e; });
  }
  return D.loading;
}

const commodity = (id) => D.pi.commodities[id] || ['Type ' + id, '', 0, 0];
const cName = (id) => commodity(id)[0];
const tierOf = (id) => commodity(id)[2];

// 安全等级显示（与星图一致：0.0–0.05 之间显示为 0.1）
function secInfo(sec) {
  const d = sec > 0 && sec < 0.05 ? 0.1 : Math.max(0, Math.round(sec * 10) / 10);
  const cls = d >= 0.5 ? 'high' : d > 0 ? 'low' : 'null';
  const color = cls === 'high' ? 'var(--buy-color)' : cls === 'low' ? 'var(--warning)' : 'var(--sell-color)';
  return { text: sec < 0 && sec <= -0.99 ? '-1.0' : d.toFixed(1), cls, color };
}

function planetName(sys, p) { return `${sys.name} ${ROMAN[p.index] || p.index}`; }

// ---------- 地区 ----------
function bfs(start, maxJumps) {
  const seen = new Map([[start, 0]]);
  let frontier = [start];
  for (let j = 1; j <= maxJumps; j++) {
    const next = [];
    for (const s of frontier) for (const n of D.sysById.get(s)?.nbr || []) if (!seen.has(n)) { seen.set(n, j); next.push(n); }
    frontier = next;
  }
  return seen;
}

// 地区内全部可建殖民地的行星：[{ sys, planet, code, jumps }]
function collectArea() {
  let systems;
  if (F.mode === 'wh') {
    if (F.whSystem) {
      const sys = D.sysById.get(F.whSystem);
      if (!sys?.wh) return { error: '请重新选择虫洞星系' };
      systems = [{ sys, jumps: 0 }];
    } else {
      systems = [...D.sysById.values()].filter((s) => s.wh && whKey(s.wh) === F.whCls).map((sys) => ({ sys, jumps: null }));
    }
  } else if (F.mode === 'system') {
    if (!D.sysById.has(F.system)) return { error: '请先选择中心星系' };
    systems = [...bfs(F.system, F.jumps)].map(([id, jumps]) => ({ sys: D.sysById.get(id), jumps }));
  } else {
    systems = [...D.sysById.values()].filter((s) => s.region === F.region).map((sys) => ({ sys, jumps: null }));
  }
  if (F.mode !== 'wh') systems = systems.filter(({ sys }) => F.sec[secInfo(sys.sec).cls]);
  const planets = [];
  for (const { sys, jumps } of systems) for (const p of sys.planets) planets.push({ sys, planet: p, code: p.code, jumps });
  if (!planets.length) return { error: F.mode === 'wh' ? '这个虫洞没有可建殖民地的行星' : '所选地区（按安全等级过滤后）没有可建殖民地的行星' };
  const counts = {};
  for (const p of planets) counts[p.code] = (counts[p.code] || 0) + 1;
  // 每种 P0 原材料可采集的行星数
  const resCount = new Map();
  for (const [code, n] of Object.entries(counts)) for (const r of D.ptByCode[code].res) resCount.set(r, (resCount.get(r) || 0) + n);
  return { systems, planets, counts, resCount };
}

// ---------- 产能模型 ----------
const ccCap = () => CC_LEVELS[F.cc];
const headRate = () => RICHNESS[F.rich]?.[0] || 500;
const struct = (id) => D.pi.structures[id] || [0, 0];
const perHour = (s, qty) => qty * 3600 / s.cycle;

function fits(cpu, power) { const [c, p] = ccCap(); return cpu <= c && power <= p; }

// 采集星：所有采集头采同一种 P0，就地加工成 P1。采集头尽量多，受 CPU / 电网限制
// extra：同星另放的加工设施（混合方案，见 hostLoad），先扣掉它们的负载再放采集头
// raw：不建基础工业设施，直接出口 P0（个别 P0 比加工后的 P1 值钱）
function designExtractor(p0, code = 'B', radius = 5000, extra = null, raw = false) {
  const pt = D.ptByCode[code];
  const LINK = linkLoad(radius);
  const basic = D.schemByOut.get(p1Of(p0));
  const [lpC, lpP] = struct(pt.launchpad);
  const [eC, eP] = struct(pt.ecu);
  const [bC, bP] = struct(pt.basic);
  const bIn = perHour(basic, basic.inputs[0][1]);
  for (let h = MAX_HEADS * 3; h >= 1; h--) {
    const ecus = Math.ceil(h / MAX_HEADS);
    const p0h = h * headRate();
    const fac = raw ? 0 : Math.ceil(p0h / bIn);
    const links = ecus + fac;
    const cpu = lpC + ecus * eC + h * HEAD[0] + fac * bC + links * LINK[0] + (extra?.cpu || 0);
    const power = lpP + ecus * eP + h * HEAD[1] + fac * bP + links * LINK[1] + (extra?.power || 0);
    if (fits(cpu, power)) {
      return { kind: 'extract', p0, p1: basic.out, heads: h, ecus, fac, p0h, p1h: p0h / basic.inputs[0][1] * basic.outQty, cpu, power, extra };
    }
  }
  return null;
}

// 单星 P2：一颗行星上采两种 P0，加工成两种 P1 后直接合成 P2
function designSingleP2(p2, code, radius = 5000) {
  const pt = D.ptByCode[code];
  const LINK = linkLoad(radius);
  const s2 = D.schemByOut.get(p2);
  const [pa, pb] = s2.inputs.map(([p1]) => p0Of(p1));
  const basic = D.schemByOut.get(s2.inputs[0][0]);
  const bIn = perHour(basic, basic.inputs[0][1]);
  const [lpC, lpP] = struct(pt.launchpad);
  const [eC, eP] = struct(pt.ecu);
  const [bC, bP] = struct(pt.basic);
  const [aC, aP] = struct(pt.adv);
  for (let half = MAX_HEADS; half >= 1; half--) {
    const p0h = half * headRate();                 // 每种 P0
    const fac = Math.ceil(p0h / bIn);              // 每种 P1 的基础设施数
    const p1h = p0h / basic.inputs[0][1] * basic.outQty;
    const p2h = p1h / perHour(s2, s2.inputs[0][1]) * perHour(s2, s2.outQty);
    const adv = Math.ceil(p1h / perHour(s2, s2.inputs[0][1]));
    const links = 2 + 2 * fac + adv;
    const cpu = lpC + 2 * eC + 2 * half * HEAD[0] + 2 * fac * bC + adv * aC + links * LINK[0];
    const power = lpP + 2 * eP + 2 * half * HEAD[1] + 2 * fac * bP + adv * aP + links * LINK[1];
    if (fits(cpu, power)) return { kind: 'single', p2, p0s: [pa, pb], p1s: s2.inputs.map(([p1]) => p1), half, fac, adv, p0h, p1h, rate: p2h, cpu, power, code };
  }
  return null;
}

// P1 由哪种 P0 加工，P0 能加工成哪种 P1
function p0Of(p1) { return D.schemByOut.get(p1).inputs[0][0]; }
function p1Of(p0) { for (const s of D.schemByOut.values()) if (s.inputs.length === 1 && s.inputs[0][0] === p0) return s.out; return 0; }

// 产品 1 单位/小时所需：各配方的设施数（小数）与各 P1 的消耗速度
function demand(product) {
  const fac = new Map();     // 配方产物 -> 每小时需要的设施数
  const p1 = new Map();      // P1 -> 每小时消耗
  const walk = (out, rate) => {
    if (tierOf(out) <= 1) { p1.set(out, (p1.get(out) || 0) + rate); return; }
    const s = D.schemByOut.get(out);
    const n = rate / perHour(s, s.outQty);
    fac.set(out, (fac.get(out) || 0) + n);
    for (const [inp, q] of s.inputs) walk(inp, n * perHour(s, q));
  };
  walk(product, 1);
  return { fac, p1 };
}

function facClass(out) { const t = tierOf(out); return t === 4 ? 'ht' : t === 1 ? 'basic' : 'adv'; }

// 工厂星：在 F 颗工厂星上以 rate 单位/小时生产，返回每颗的设施数与负载；放不下返回 null
function factoryLayout(dem, rate, nPlanets, code, radius = 5000) {
  const pt = D.ptByCode[code];
  const LINK = linkLoad(radius);
  const [lpC, lpP] = struct(pt.launchpad);
  let cpu = lpC, power = lpP;
  const counts = [];
  for (const [out, n] of dem.fac) {
    const c = Math.ceil(n * rate / nPlanets - 1e-9);
    if (!c) continue;
    const [fc, fp] = struct(pt[facClass(out)]);
    cpu += c * (fc + LINK[0]);
    power += c * (fp + LINK[1]);
    counts.push([out, c]);
  }
  return fits(cpu, power) ? { counts, cpu, power } : null;
}

// 工厂星行星类型：P4 需要高科技工厂（只有贫瘠 / 温和行星有）；其余优先地区里数量最多的类型
function factoryCode(area, product) {
  const need = tierOf(product) === 4 || [...demandCache(product).fac.keys()].some((o) => tierOf(o) === 4);
  const codes = Object.keys(area.counts).filter((c) => !need || D.ptByCode[c].ht);
  return codes.sort((a, b) => area.counts[b] - area.counts[a])[0] || null;
}

// 混合方案：不单开工厂星，把加工设施平摊到 m 颗采集星上。
// 采集星卡在电网（采集头 110 CPU / 550 电网），CPU 大量富余；高级工厂 500 / 700，少放约 1 个采集头就能换 1 个，
// 而 1 个高级工厂每小时吃 80 个 P1，几颗采集星的产出只要几个工厂，单开一颗工厂星大多是空转。
// 返回每颗兼工厂的采集星要放的设施（不含发射平台）与负载
function hostLoad(dem, rate, m, radius) {
  const LINK = linkLoad(radius);
  const pt = D.ptByCode.B;   // 基础 / 高级工厂在各类行星上负载相同
  let cpu = 0, power = 0;
  const counts = [];
  for (const [out, n] of dem.fac) {
    const c = Math.ceil(n * rate / m - 1e-9);
    if (!c) continue;
    const [fc, fp] = struct(pt[facClass(out)]);
    cpu += c * (fc + LINK[0]);
    power += c * (fp + LINK[1]);
    counts.push([out, c]);
  }
  return { counts, cpu, power };
}

// 行星够不够分：每类行星最多建「数量 × 角色数」个殖民地（同一角色一颗行星只能建一个）。
// groups：[[可用行星类型, 殖民地数], ...]。Hall 定理按行星类型的子集检查（最多 8 类、256 个子集）：
// 只能建在子集 U 内的殖民地总数不超过 U 的容量。每组单独的容量都不小于殖民地总数时直接通过
function placer(area) {
  const total = F.chars * F.perChar;
  const types = Object.keys(area.counts);
  const bit = new Map(types.map((c, i) => [c, 1 << i]));
  const full = (1 << types.length) - 1;
  const capU = new Float64Array(full + 1);
  for (let U = 1; U <= full; U++) { const low = U & -U; capU[U] = capU[U ^ low] + area.counts[types[31 - Math.clz32(low)]] * F.chars; }
  const masks = new Map();
  const maskOf = (codes) => {
    let m = masks.get(codes);
    if (m === undefined) { m = 0; for (const c of codes) m |= bit.get(c) || 0; masks.set(codes, m); }
    return m;
  };
  const check = (groups) => {
    const ms = [], ns = [];
    let easy = true;
    for (const [codes, n] of groups) {
      if (n <= 0) continue;
      const m = maskOf(codes);
      if (!m) return false;
      ms.push(m); ns.push(n);
      if (capU[m] < total) easy = false;
    }
    if (easy) return true;
    for (let U = 1; U <= full; U++) {
      let need = 0;
      for (let i = 0; i < ms.length; i++) if ((ms[i] & ~U) === 0) need += ns[i];
      if (need > capU[U]) return false;
    }
    return true;
  };
  // 这些类型组合单独都放得下全部殖民地：怎么分都够，不用逐次检查
  check.loose = (codeLists) => codeLists.every((codes) => capU[maskOf(codes)] >= total);
  return check;
}

// 把 total 颗行星分给各种 P1（先分 m 颗兼工厂的，再分纯采集的），每次补给产出 / 需求比例最低的那种；返回能支撑的产品产量
// host 里没有的 P1 不能兼工厂（P4 需要高科技工厂，只有采集星能是贫瘠 / 温和行星的 P1 才行）
// ok(n, hosts)：行星够不够分（见 placer），不够时跳过这次分配
function allocate(p1s, dem, total, m, full, host, cap, ok = null) {
  const n = new Map(p1s.map((p1) => [p1, 0]));
  const hosts = new Map(p1s.map((p1) => [p1, 0]));
  const made = (p1) => (hosts.get(p1) ? hosts.get(p1) * host.get(p1).p1h : 0) + (n.get(p1) - hosts.get(p1)) * full.get(p1).p1h;
  const ratio = (p1) => made(p1) / dem.p1.get(p1);
  const caps = new Map(p1s.map((p1) => [p1, cap(p1)]));
  for (let i = 0; i < total; i++) {
    let pick = 0, low = Infinity;
    for (const p1 of p1s) {
      if (n.get(p1) >= caps.get(p1) || (i < m && !host.has(p1))) continue;
      const r = ratio(p1);
      if (r >= low) continue;
      if (ok) {
        n.set(p1, n.get(p1) + 1);
        if (i < m) hosts.set(p1, hosts.get(p1) + 1);
        const fine = ok(n, hosts);
        n.set(p1, n.get(p1) - 1);
        if (i < m) hosts.set(p1, hosts.get(p1) - 1);
        if (!fine) continue;
      }
      low = r; pick = p1;
    }
    if (!pick) { if (i < m) return null; break; }
    n.set(pick, n.get(pick) + 1);
    if (i < m) hosts.set(pick, hosts.get(pick) + 1);
  }
  return { n, hosts, rate: Math.min(...p1s.map(ratio)) };
}

function planHybrid(product, area, dem, p1s, exByP1, hostCodeByP1, total, cap, ok) {
  const hostP1s = p1s.filter((p1) => hostCodeByP1.get(p1));
  const radius = new Map(hostP1s.map((p1) => [p1, typicalRadius(area, [hostCodeByP1.get(p1)])]));
  let best = null;
  const ms = [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64, 96, 128, total])].filter((m) => m <= total);
  const designs = new Map();   // 设施负载取整后重复很多，缓存采集星设计与分配结果
  for (const m of ms) {
    const allocs = new Map();
    // 产量 r 时每颗兼工厂星要放的设施 → 还能放几个采集头 → 全部行星能支撑的产量
    const at = (r) => {
      const host = new Map();
      for (const p1 of hostP1s) {
        const load = hostLoad(dem, r, m, radius.get(p1));
        const key = p1 + ':' + load.cpu + ':' + load.power;
        if (!designs.has(key)) designs.set(key, designExtractor(p0Of(p1), hostCodeByP1.get(p1), radius.get(p1), load));
        const d = designs.get(key);
        if (d) host.set(p1, d);
      }
      if (!host.size) return null;
      const key = [...host].map(([p1, d]) => p1 + ':' + d.heads).join();
      if (!allocs.has(key)) allocs.set(key, allocate(p1s, dem, total, m, exByP1, host, cap, ok));
      const a = allocs.get(key);
      return a && { ...a, host };
    };
    const feasible = (r) => { const a = at(r); return a && a.rate >= r; };
    const top = at(0);
    if (!top) continue;
    let lo = 0, hi = top.rate;
    if (feasible(hi)) lo = hi;
    else for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (feasible(mid)) lo = mid; else hi = mid; }
    if (lo <= 0) continue;
    const a = at(lo);
    const plan = finish({ product, strategy: 'hybrid', extract: a.n, hosts: a.hosts, exByP1, hostByP1: a.host, m, hostCodeByP1, factories: 0, rate: lo, dem });
    if (!best || plan.profit > best.profit) best = plan;
  }
  return best;
}

// ---------- 买料加工 ----------
// 从吉他买入半成品，在工厂星上加工成更高级的产品卖出；不采集，行星类型不限（P4 需要高科技工厂：贫瘠 / 温和）。
// 除了 CPU / 电网，还受发射平台容量限制：一个补货周期的原料（或产物）都要放得下，每个发射平台 10,000 m³。
// 放不下就加发射平台：每个发射平台带一组完整的加工链（中间产品不用在组间搬运），原料平均分到各组。
const vol = (id) => commodity(id)[3] || 0;
const inPriceOf = (id) => {
  const p = R.prices.get(id);
  return (F.inPrice === 'buy' ? p?.buy : p?.sell) ?? p?.avg ?? 0;
};

// 产品 1 单位/小时：buyTier 及以下的原料买入，其余自己加工
function buyDemand(product, buyTier) {
  const fac = new Map(), buy = new Map();
  const walk = (out, rate) => {
    if (out !== product && tierOf(out) <= buyTier) { buy.set(out, (buy.get(out) || 0) + rate); return; }
    const s = D.schemByOut.get(out);
    const n = rate / perHour(s, s.outQty);
    fac.set(out, (fac.get(out) || 0) + n);
    for (const [inp, q] of s.inputs) walk(inp, n * perHour(s, q));
  };
  walk(product, 1);
  return { fac, buy, buyTier };
}

// 一颗工厂星以 rate 单位/小时生产时的布局：hubs 个发射平台，每组设施数 = 需求 / 组数（向上取整）
function buyLayout(dem, rate, hubs, code, radius) {
  const pt = D.ptByCode[code];
  const LINK = linkLoad(radius);
  const [lpC, lpP] = struct(pt.launchpad);
  const hubLink = linkLoad(radius, HUB_GAP);
  let cpu = hubs * lpC + (hubs - 1) * hubLink[0], power = hubs * lpP + (hubs - 1) * hubLink[1];
  const counts = [];
  for (const [out, n] of dem.fac) {
    const c = Math.ceil(n * rate / hubs - 1e-9);
    if (!c) continue;
    if (!pt[facClass(out)]) return null;
    const [fc, fp] = struct(pt[facClass(out)]);
    cpu += hubs * c * (fc + LINK[0]);
    power += hubs * c * (fp + LINK[1]);
    counts.push([out, c]);
  }
  if (!fits(cpu, power)) return null;
  // 每个发射平台：补货时装满一个周期的原料，周期末换成等量时间的产物
  const inM3 = [...dem.buy].reduce((t, [id, q]) => t + q * rate * vol(id), 0);
  const outM3 = rate * vol(dem.product);
  if (Math.max(inM3, outM3) / hubs * F.restock > LP_CAP) return null;
  return { counts, cpu, power, inM3, outM3 };
}

// 一颗工厂星在给定买入层级、发射平台数下能达到的最大产量
function maxBuyRate(dem, hubs, code, radius) {
  let lo = 0, hi = 1;
  while (hi < 1e5 && buyLayout(dem, hi, hubs, code, radius)) { lo = hi; hi *= 2; }
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (buyLayout(dem, mid, hubs, code, radius)) lo = mid; else hi = mid; }
  return lo;
}

function planBuy(product, area) {
  const tier = tierOf(product);
  if (tier < 1) return { product, error: 'P0 不能加工得到' };
  const codes = Object.keys(area.counts).filter((c) => tier < 4 || D.ptByCode[c].ht);
  if (!codes.length) return { product, error: '地区内没有能建高科技工厂的贫瘠 / 温和行星' };
  const code = codes.sort((a, b) => area.counts[b] - area.counts[a])[0];
  const radius = typicalRadius(area, [code]);
  const avail = codes.reduce((n, c) => n + area.counts[c], 0) * F.chars;
  const planets = Math.min(F.chars * F.perChar, avail);
  const outPrice = priceOf(product);
  if (!outPrice) return { product, error: '缺少行情' };
  let best = null;
  for (let buyTier = tier - 1; buyTier >= Math.max(0, tier - 3); buyTier--) {
    const dem = { ...buyDemand(product, buyTier), product };
    if ([...dem.buy.keys()].some((id) => !inPriceOf(id))) continue;   // 买不到的原料
    // 每单位产品的利润：售价 − 原料 − 出口税 − 原料进口税
    const unitCost = [...dem.buy].reduce((t, [id, q]) => t + q * (inPriceOf(id) + importTax(id)), 0);
    const unit = outPrice - exportTax(product) - unitCost;
    for (let hubs = 1; hubs <= MAX_HUBS; hubs++) {
      const r = maxBuyRate(dem, hubs, code, radius);
      if (r <= 0) continue;
      const day = r * 24 * planets;
      const plan = {
        product, strategy: 'buy', buyTier, hubs, code, radius, dem, perRate: r, rate: r * planets, planets, factories: planets,
        revenue: day * outPrice,
        cost: day * [...dem.buy].reduce((t, [id, q]) => t + q * inPriceOf(id), 0),
        tax: day * (exportTax(product) + [...dem.buy].reduce((t, [id, q]) => t + q * importTax(id), 0)),
        profit: day * unit, unitCost, surplus: []
      };
      if (!best || plan.profit > best.profit) best = plan;
    }
  }
  if (!best) return { product, error: '放不下加工设施，或原料没有行情' };
  return best;
}

const demCache = new Map();
function demandCache(product) { if (!demCache.has(product)) demCache.set(product, demand(product)); return demCache.get(product); }

// ---------- 方案 ----------
function priceOf(id) {
  const p = R.prices.get(id);
  const v = F.price === 'buy' ? (p?.buy ?? null) : (p?.sell ?? null);
  return v ?? p?.avg ?? 0;
}
const exportTax = (id) => TAX_BASE[tierOf(id)] * F.tax / 100;
const importTax = (id) => exportTax(id) / 2;

function planProduct(product, area) {
  const total = F.chars * F.perChar;
  const tier = tierOf(product);
  const reasons = [];
  // P0：所有行星都采集，不加工直接出口
  if (tier === 0) {
    const avail = (area.resCount.get(product) || 0) * F.chars;
    if (!avail) return { product, error: `地区内没有可采集${cName(product)}的行星` };
    const code = bestCodeFor(area, [product]);
    const ex = designExtractor(product, code, typicalRadius(area, [code]), null, true);
    if (!ex) return { product, error: '指挥中心等级过低，放不下采集设施' };
    const n = Math.min(total, avail);
    return finish({ product, strategy: 'raw', extract: new Map([[product, n]]), factories: 0, rate: n * ex.p0h, ex });
  }
  // P1：所有行星都采集
  if (tier === 1) {
    const p0 = p0Of(product);
    const avail = (area.resCount.get(p0) || 0) * F.chars;
    if (!avail) return { product, error: `地区内没有可采集${cName(p0)}的行星` };
    const code = bestCodeFor(area, [p0]);
    const ex = designExtractor(p0, code, typicalRadius(area, [code]));
    if (!ex) return { product, error: '指挥中心等级过低，放不下采集设施' };
    const n = Math.min(total, avail);
    return finish({ product, strategy: 'extract', extract: new Map([[product, n]]), factories: 0, rate: n * ex.p1h, ex });
  }
  const dem = demandCache(product);
  const p1s = [...dem.p1.keys()];
  const missing = p1s.filter((p1) => !area.resCount.get(p0Of(p1)));
  const candidates = [];
  // 单星 P2
  if (tier === 2) {
    const s2 = D.schemByOut.get(product);
    const p0s = s2.inputs.map(([p1]) => p0Of(p1));
    const codes = Object.keys(area.counts).filter((c) => p0s.every((r) => D.ptByCode[c].res.includes(r)));
    if (codes.length) {
      const code = codes.sort((a, b) => area.counts[b] - area.counts[a])[0];
      const single = designSingleP2(product, code, typicalRadius(area, [code]));
      const avail = codes.reduce((n, c) => n + area.counts[c], 0) * F.chars;
      if (single) {
        const n = Math.min(total, avail);
        candidates.push(finish({ product, strategy: 'single', single, singleCodes: codes, singles: n, extract: new Map(), factories: 0, rate: n * single.rate }));
      }
    }
  }
  if (missing.length) {
    if (candidates.length) return candidates[0];
    return { product, error: '地区内缺少原材料：' + [...new Set(missing.map(p0Of))].map(cName).join('、') };
  }
  const fCode = factoryCode(area, product);
  const codeByP1 = new Map(p1s.map((p1) => [p1, bestCodeFor(area, [p0Of(p1)])]));
  const exByP1 = new Map(p1s.map((p1) => { const c = codeByP1.get(p1); return [p1, designExtractor(p0Of(p1), c, typicalRadius(area, [c]))]; }));
  const exOk = [...exByP1.values()].every(Boolean);
  // 混合方案（工厂摊到采集星上）。P4 需要高科技工厂，只有贫瘠 / 温和行星能建：只让能在这两类行星上采集的 P1 兼工厂
  const needHT = [...dem.fac.keys()].some((o) => tierOf(o) === 4);
  const hostCodeByP1 = new Map(p1s.map((p1) => [p1, needHT
    ? Object.keys(area.counts).filter((c) => D.ptByCode[c].ht && D.ptByCode[c].res.includes(p0Of(p1))).sort((a, b) => area.counts[b] - area.counts[a])[0] || null
    : codeByP1.get(p1)]));
  const fits2 = placer(area);
  const extCodes = new Map(p1s.map((p1) => [p1, Object.keys(area.counts).filter((c) => D.ptByCode[c].res.includes(p0Of(p1)))]));
  const hostCodes = new Map(p1s.map((p1) => [p1, needHT ? extCodes.get(p1).filter((c) => D.ptByCode[c].ht) : extCodes.get(p1)]));
  if (exOk && total >= p1s.length) {
    const ok = fits2.loose([...extCodes.values(), ...hostCodes.values()]) ? null : (n, hosts) => fits2(p1s.flatMap((p1) => [[extCodes.get(p1), n.get(p1) - hosts.get(p1)], [hostCodes.get(p1), hosts.get(p1)]]));
    const hy = planHybrid(product, area, dem, p1s, exByP1, hostCodeByP1, total, (p1) => (area.resCount.get(p0Of(p1)) || 0) * F.chars, ok);
    if (hy) candidates.push(hy);
  }
  if (!fCode) reasons.push('地区内没有能建高科技工厂的贫瘠 / 温和行星');
  else if (total < p1s.length + 1) reasons.push(`需要至少 ${p1s.length + 1} 颗行星（${p1s.length} 种 P1 各一颗采集星 + 1 颗工厂星）`);
  else {
    const fR = typicalRadius(area, [fCode]);
    if (!exOk) reasons.push('指挥中心等级过低，放不下采集设施');
    else {
      let best = null;
      const fCodes = Object.keys(area.counts).filter((c) => !D.ptByCode[fCode].ht || D.ptByCode[c].ht);
      const loose = fits2.loose([...extCodes.values(), fCodes]);
      for (let f = 1; f <= total - p1s.length; f++) {
        const n = new Map(p1s.map((p1) => [p1, 1]));
        const cap = (p1) => (area.resCount.get(p0Of(p1)) || 0) * F.chars;
        const ratio = (p1) => n.get(p1) * exByP1.get(p1).p1h / dem.p1.get(p1);
        const placeable = loose ? () => true : () => fits2([...p1s.map((p1) => [extCodes.get(p1), n.get(p1)]), [fCodes, f]]);
        if (!placeable()) continue;
        for (let left = total - f - p1s.length; left > 0; left--) {
          const pick = p1s.filter((p1) => n.get(p1) < cap(p1)).sort((a, b) => ratio(a) - ratio(b))
            .find((p1) => { n.set(p1, n.get(p1) + 1); const fine = placeable(); n.set(p1, n.get(p1) - 1); return fine; });
          if (!pick) break;
          n.set(pick, n.get(pick) + 1);
        }
        const rateE = Math.min(...p1s.map(ratio));
        // 工厂产能：二分找出 f 颗工厂星放得下的最大产量
        let lo = 0, hi = rateE;
        if (!factoryLayout(dem, hi, f, fCode, fR)) {
          for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (factoryLayout(dem, mid, f, fCode, fR)) lo = mid; else hi = mid; }
        } else lo = hi;
        const plan = finish({ product, strategy: 'chain', extract: n, exByP1, factories: f, fCode, fR, rate: lo, dem });
        if (!best || plan.profit > best.profit) best = plan;
      }
      if (best && best.rate > 0) candidates.push(best);
      else reasons.push('指挥中心等级过低，工厂星放不下所需设施');
    }
  }
  if (!candidates.length) return { product, error: reasons.join('；') || '无法规划' };
  return candidates.sort((a, b) => b.profit - a.profit)[0];
}

// 规划时用的行星半径：地区内这些类型行星半径的中位数（分配到具体行星后按实际半径重算模板）
function typicalRadius(area, codes) {
  const list = area.planets.filter((p) => codes.includes(p.code)).map((p) => p.planet.radius).sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : 5000;
}

// 采集某些 P0 时选用的行星类型：地区里数量最多的
function bestCodeFor(area, p0s) {
  return Object.keys(area.counts).filter((c) => p0s.every((r) => D.ptByCode[c].res.includes(r)))
    .sort((a, b) => area.counts[b] - area.counts[a])[0] || 'B';
}

// 汇总收益：产品 + 多余的 P1 都按吉他价格卖出，扣除海关税
function finish(plan) {
  const day = 24;
  let revenue = plan.rate * day * priceOf(plan.product);
  let tax = plan.rate * day * exportTax(plan.product);
  const surplus = [];
  if (plan.strategy === 'chain' || plan.strategy === 'hybrid') {
    // 混合方案里兼工厂星自产的 P1 有一部分可以就地加工、不过海关，这里仍按全部出口再进口计税（偏保守）
    for (const [p1, n] of plan.extract) {
      const h = plan.hosts?.get(p1) || 0;
      const made = (n - h) * plan.exByP1.get(p1).p1h + (h ? h * plan.hostByP1.get(p1).p1h : 0);
      const used = plan.rate * plan.dem.p1.get(p1);
      tax += made * day * exportTax(p1) + used * day * importTax(p1);   // 采集星出口全部 P1，工厂星进口所需部分
      const extra = Math.max(0, made - used);
      if (extra > 0.01) {
        surplus.push([p1, extra]);
        revenue += extra * day * priceOf(p1);
      }
    }
  }
  plan.planets = plan.strategy === 'single' ? plan.singles : [...plan.extract.values()].reduce((a, b) => a + b, 0) + plan.factories;
  plan.surplus = surplus;
  plan.revenue = revenue;
  plan.tax = tax;
  plan.profit = revenue - tax;
  return plan;
}

// ---------- 行星分配 ----------
// 以覆盖所需行星类型最多的星系为中心，按距离由近到远给每个角色分配行星；同一角色不能在同一颗行星上建两个殖民地
function assignPlanets(plan, area) {
  const roles = [];
  if (plan.strategy === 'buy') {
    const codes = Object.keys(area.counts).filter((c) => tierOf(plan.product) < 4 || D.ptByCode[c].ht);
    for (let i = 0; i < plan.planets; i++) roles.push({ kind: 'factory', product: plan.product, codes });
  } else if (plan.strategy === 'single') {
    for (let i = 0; i < plan.singles; i++) roles.push({ kind: 'single', product: plan.product, codes: plan.singleCodes });
  } else {
    for (const [p1, n] of plan.extract) {
      const p0 = plan.strategy === 'raw' ? p1 : p0Of(p1);
      const codes = Object.keys(area.counts).filter((c) => D.ptByCode[c].res.includes(p0));
      const h = plan.hosts?.get(p1) || 0;
      // 兼工厂的星：P4 只能放在能建高科技工厂的行星上
      const hostCodes = h && [...plan.dem.fac.keys()].some((o) => tierOf(o) === 4) ? codes.filter((c) => D.ptByCode[c].ht) : codes;
      for (let i = 0; i < n; i++) roles.push(i < h ? { kind: 'hybrid', product: p1, p0, codes: hostCodes } : { kind: 'extract', product: p1, p0, codes });
    }
    const fCodes = Object.keys(area.counts).filter((c) => plan.fCode && (!D.ptByCode[plan.fCode].ht || D.ptByCode[c].ht));
    for (let i = 0; i < plan.factories; i++) roles.push({ kind: 'factory', product: plan.product, codes: fCodes });
  }
  // 中心星系：周边 2 跳内能覆盖最多种角色需要的行星类型
  const needCodes = roles.map((r) => new Set(r.codes));
  let home = null, homeScore = -1;
  const sysList = area.systems.map((s) => s.sys).filter((s) => s.planets.length);
  const inArea = new Set(sysList.map((s) => s.id));
  for (const sys of sysList.slice(0, 600)) {
    const near = [...bfs(sys.id, 2).keys()].filter((id) => inArea.has(id));
    const codes = new Set(near.flatMap((id) => D.sysById.get(id).planets.map((p) => p.code)));
    const score = needCodes.filter((set) => [...set].some((c) => codes.has(c))).length * 100 + D.sysById.get(sys.id).planets.length;
    if (score > homeScore) { homeScore = score; home = sys; }
  }
  const dist = bfs(home.id, 60);
  // 由近到远；同一星系里优先小行星（链接短、省 CPU / 电网）。虫洞之间没有固定通道，只用中心这一个洞
  const planets = area.planets.filter((p) => F.mode !== 'wh' || p.sys.id === home.id).sort((a, b) => (dist.get(a.sys.id) ?? 99) - (dist.get(b.sys.id) ?? 99) || a.planet.radius - b.planet.radius);
  let chars = Array.from({ length: F.chars }, () => ({ used: new Set(), rows: [] }));
  // 选择余地小的角色先分配
  const order = roles.map((r, i) => i).sort((a, b) => roles[a].codes.length - roles[b].codes.length);
  let warnings = [];
  for (const i of order) {
    const role = roles[i];
    const ok = (p) => role.codes.includes(p.code);
    let placed = false;
    const charOrder = chars.map((c, ci) => ci).filter((ci) => chars[ci].rows.length < F.perChar).sort((a, b) => chars[a].rows.length - chars[b].rows.length);
    for (const ci of charOrder) {
      const c = chars[ci];
      const p = planets.find((x) => ok(x) && !c.used.has(planetName(x.sys, x.planet)));
      if (!p) continue;
      c.used.add(planetName(p.sys, p.planet));
      c.rows.push({ ...role, at: p, jumps: dist.get(p.sys.id) ?? null });
      placed = true;
      break;
    }
    if (!placed) warnings.push(role);
  }
  // 按顺序贪心可能分不完（行星少、几种殖民地抢同一类行星时），改用最大流重新分配
  if (warnings.length) {
    const flow = flowAssign(roles, planets, dist);
    if (flow.warnings.length < warnings.length) ({ chars, warnings } = flow);
  }
  const kindOrder = { single: 0, extract: 1, hybrid: 2, factory: 3 };
  for (const c of chars) c.rows.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.jumps ?? 0) - (b.jumps ?? 0));
  return { home, chars, warnings };
}

// 最大流分配：源 → 殖民地组（同种殖民地合并，容量 = 数量）→ 行星（可用类型）→ 汇（容量 = 角色数，每个角色一颗行星只建一个）。
// 行星按由近到远逐步放开，尽量用近的；每颗行星上的殖民地轮流分给各角色，保证同一角色不重复、每个角色数量平均
function flowAssign(roles, planets, dist) {
  const groups = [];
  const keyOf = (r) => r.kind + ':' + r.product + ':' + r.codes.join('');
  for (const r of roles) {
    let g = groups.find((x) => x.key === keyOf(r));
    if (!g) groups.push(g = { key: keyOf(r), role: r, n: 0 });
    g.n++;
  }
  const usable = planets.filter((p) => groups.some((g) => g.role.codes.includes(p.code)));
  let best = null;
  for (let size = Math.min(usable.length, roles.length); ; size = Math.min(usable.length, size * 2)) {
    const pool = usable.slice(0, size);
    // 节点：0 源，1..G 组，G+1..G+P 行星，G+P+1 汇
    const G = groups.length, P = pool.length, T = G + P + 1;
    const cap = new Map();
    const adj = Array.from({ length: T + 1 }, () => []);
    const edge = (a, b, c) => { cap.set(a + ',' + b, c); cap.set(b + ',' + a, cap.get(b + ',' + a) || 0); adj[a].push(b); adj[b].push(a); };
    groups.forEach((g, i) => edge(0, i + 1, g.n));
    groups.forEach((g, i) => pool.forEach((p, j) => { if (g.role.codes.includes(p.code)) edge(i + 1, G + 1 + j, F.chars); }));
    pool.forEach((p, j) => edge(G + 1 + j, T, F.chars));
    let total = 0;
    for (;;) {
      const prev = new Map([[0, -1]]);
      const queue = [0];
      while (queue.length && !prev.has(T)) {
        const a = queue.shift();
        for (const b of adj[a]) if (!prev.has(b) && cap.get(a + ',' + b) > 0) { prev.set(b, a); queue.push(b); }
      }
      if (!prev.has(T)) break;
      let push = Infinity;
      for (let b = T; b !== 0; b = prev.get(b)) push = Math.min(push, cap.get(prev.get(b) + ',' + b));
      for (let b = T; b !== 0; b = prev.get(b)) { const a = prev.get(b); cap.set(a + ',' + b, cap.get(a + ',' + b) - push); cap.set(b + ',' + a, cap.get(b + ',' + a) + push); }
      total += push;
    }
    best = { pool, groups, cap, G };
    if (total >= roles.length || size >= usable.length) break;
  }
  const chars = Array.from({ length: F.chars }, () => ({ used: new Set(), rows: [] }));
  const left = new Map(best.groups.map((g) => [g, g.n]));
  let k = 0;
  best.pool.forEach((p, j) => {
    best.groups.forEach((g, i) => {
      const used = best.cap.get((best.G + 1 + j) + ',' + (i + 1)) || 0;   // 反向边容量 = 流量
      for (let u = 0; u < used; u++) {
        const c = chars[k++ % F.chars];
        c.used.add(planetName(p.sys, p.planet));
        c.rows.push({ ...g.role, at: p, jumps: dist.get(p.sys.id) ?? null });
        left.set(g, left.get(g) - 1);
      }
    });
  });
  const warnings = best.groups.flatMap((g) => Array(Math.max(0, left.get(g))).fill(g.role));
  return { chars, warnings };
}

// ---------- 模板 ----------
// 游戏内殖民地模板格式：P 设施（H 采集头数、La 极角 / Lo 经度（弧度）、S 产物、T 设施类型）、L 链接、R 路由（索引从 1 开始）。
// 指挥中心不在模板里，玩家先放好指挥中心再载入模板；载入时游戏会把设施换成当前行星对应的类型。
// 游戏按角度判断间距：两个设施相距小于 0.012 弧度会被拒绝导入，所以布局用固定角度间距，与行星大小无关。
// 布局：发射平台在中心，6 条主辐条各放 1–5 个设施；再多时 6 条错开 30° 的辅辐条从第 2 圈开始放。
// 每个设施链接到辐条上的前一个设施，路由沿辐条走，最长 6 个设施（游戏上限 7）。
function slots(n) {
  const out = [];
  for (let depth = 1; depth <= 5 && out.length < n; depth++) {
    for (let k = 0; k < 6 && out.length < n; k++) out.push({ depth, theta: (Math.PI / 3) * k, parent: depth === 1 ? -1 : out.length - 6 });
  }
  const mainCount = out.length;
  for (let depth = 2; depth <= 5 && out.length < n; depth++) {
    for (let k = 0; k < 6 && out.length < n; k++) {
      out.push({ depth, theta: (Math.PI / 3) * k + Math.PI / 6, parent: depth === 2 ? -1 : out.length - 6 });
    }
  }
  return { list: out, mainCount };
}

// hubs > 1（买料加工）：多个发射平台沿经线排开，各带一组设施（pin.hub 指定所属组），相邻发射平台之间连一条链接
function buildTemplate({ name, code, diam, pins, hubs = 1 }) {
  const pt = D.ptByCode[code];
  const R0 = diam / 2;
  const out = { CmdCtrLv: F.cc, Cmt: name.slice(0, 40), Diam: diam, L: [], P: [], Pln: pt.id, R: [] };
  const centers = Array.from({ length: hubs }, (_, k) => ({ th: Math.PI / 2, ph: Math.PI + (k - (hubs - 1) / 2) * HUB_GAP }));
  const path = new Map();
  const pos = [];
  centers.forEach((c, k) => {
    out.P.push({ H: 0, La: Number(c.th.toFixed(5)), Lo: Number(c.ph.toFixed(5)), S: null, T: pt.launchpad });
    pos.push(c);
    path.set(k + 1, [k + 1]);
    if (k) out.L.push({ D: k + 1, Lv: 0, S: k });
  });
  const placed = [];
  centers.forEach((c0, k) => {
    const hub = k + 1;
    const group = pins.filter((pin) => (pin.hub || 0) === k);
    const { list } = slots(Math.min(group.length, 54));
    const first = out.P.length + 1;
    group.slice(0, list.length).forEach((pin, i) => {
      const sl = list[i];
      const d = sl.depth * SPACING;
      const th = c0.th - d * Math.sin(sl.theta);
      const ph = c0.ph + (d * Math.cos(sl.theta)) / Math.sin(th);
      const idx = out.P.length + 1;
      out.P.push({ H: pin.heads || 0, La: Number(th.toFixed(5)), Lo: Number(ph.toFixed(5)), S: pin.product, T: pin.type });
      pos.push({ th: out.P[idx - 1].La, ph: out.P[idx - 1].Lo });
      const prev = sl.parent < 0 ? hub : first + sl.parent;
      out.L.push({ D: idx, Lv: 0, S: prev });
      path.set(idx, [...path.get(prev), idx]);
      const toPin = path.get(idx);
      const fromPin = toPin.slice().reverse();
      if (pin.heads) out.R.push({ P: fromPin, Q: Math.round(pin.heads * headRate()), T: pin.product });
      for (const [t, q] of pin.inputs || []) out.R.push({ P: toPin, Q: q, T: t });
      if (pin.outQty) out.R.push({ P: fromPin, Q: pin.outQty, T: pin.product });
      placed.push(pin);
    });
  });
  // 负载统计（链接按实际弧长计费）
  const [lc, lp] = struct(pt.launchpad);
  let cpu = lc * hubs, power = lp * hubs;
  for (const pin of placed) {
    const [c, p] = struct(pin.type);
    cpu += c + (pin.heads || 0) * HEAD[0];
    power += p + (pin.heads || 0) * HEAD[1];
  }
  for (const l of out.L) {
    const [c, p] = linkLoad(R0, angle(pos[l.S - 1], pos[l.D - 1]));
    cpu += c; power += p;
  }
  return { json: out, cpu, power };
}

function ecuPins(pt, p0, heads) {
  const pins = [];
  for (let left = heads; left > 0; left -= MAX_HEADS) pins.push({ type: pt.ecu, product: p0, heads: Math.min(MAX_HEADS, left) });
  return pins;
}
function factoryPins(pt, out, count) {
  const s = D.schemByOut.get(out);
  return Array.from({ length: count }, () => ({ type: pt[facClass(out)], product: out, inputs: s.inputs, outQty: s.outQty }));
}

// 方案里每种行星角色生成一个模板（同类角色共用）
function planTemplates(plan, assign) {
  const firstOf = (kind, product) => {
    for (const c of assign.chars) for (const r of c.rows) if (r.kind === kind && r.product === product) return r.at;
    return null;
  };
  const diamOf = (at) => (at ? at.planet.radius * 2 : 10000) || 10000;
  const list = [];
  if (plan.strategy === 'buy') {
    list.push(buyTemplate(plan, firstOf('factory', plan.product)));
    return list;
  }
  if (plan.strategy === 'single') {
    const at = firstOf('single', plan.product);
    const code = at?.code || plan.single.code;
    const pt = D.ptByCode[code];
    const s = designSingleP2(plan.product, code, diamOf(at) / 2) || plan.single;
    const pins = [
      ...plan.single.p0s.flatMap((p0) => ecuPins(pt, p0, s.half)),
      ...plan.single.p1s.flatMap((p1) => factoryPins(pt, p1, s.fac)),
      ...factoryPins(pt, plan.product, s.adv)
    ];
    list.push({ key: 'single', title: `单星 P2 · ${cName(plan.product)}`, code, ...buildTemplate({ name: `单星-${cName(plan.product)}`, code, diam: diamOf(at), pins }) , summary: `采集控制器 ×2（各 ${s.half} 头）· 基础工业 ×${2 * s.fac} · 高级工业 ×${s.adv}` });
  } else {
    for (const [p1, n] of plan.extract) {
      const hosts = plan.hosts?.get(p1) || 0;
      if (hosts) list.push(hybridTemplate(plan, p1, firstOf('hybrid', p1)));
      if (n === hosts) continue;
      const at = firstOf('extract', p1);
      const raw = plan.strategy === 'raw';
      const p0 = raw ? p1 : p0Of(p1);
      const code = at?.code || bestCodeFor(R.area, [p0]);
      const pt = D.ptByCode[code];
      const ex = designExtractor(p0, code, diamOf(at) / 2, null, raw) || designExtractor(p0, code, 1000, null, raw);
      const pins = [...ecuPins(pt, ex.p0, ex.heads), ...(raw ? [] : factoryPins(pt, p1, ex.fac))];
      list.push(raw
        ? { key: 'extract-' + p1, title: `采集 · ${cName(p0)}（直接出口）`, code, ...buildTemplate({ name: `采集-${cName(p0)}`, code, diam: diamOf(at), pins }), summary: `采集控制器 ×${ex.ecus}（共 ${ex.heads} 头）· 不加工` }
        : { key: 'extract-' + p1, title: `采集 · ${cName(ex.p0)} → ${cName(p1)}`, code, ...buildTemplate({ name: `采集-${cName(p1)}`, code, diam: diamOf(at), pins }), summary: `采集控制器 ×${ex.ecus}（共 ${ex.heads} 头）· 基础工业 ×${ex.fac}` });
    }
    if (plan.factories) {
      const at = firstOf('factory', plan.product);
      const code = at?.code || plan.fCode;
      const pt = D.ptByCode[code];
      const radius = diamOf(at) / 2;
      // 实际行星比规划时大、放不下时，按能放下的最大产量重算工厂数
      let layout = factoryLayout(plan.dem, plan.rate, plan.factories, code, radius);
      let note = '';
      if (!layout) {
        let lo = 0, hi = plan.rate;
        for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (factoryLayout(plan.dem, mid, plan.factories, code, radius)) lo = mid; else hi = mid; }
        layout = factoryLayout(plan.dem, lo, plan.factories, code, radius) || { counts: [] };
        note = `（这颗行星较大，链接更耗资源，产能约为规划的 ${Math.round((lo / plan.rate) * 100)}%）`;
      }
      const pins = layout.counts.sort((a, b) => tierOf(a[0]) - tierOf(b[0])).flatMap(([out, c]) => factoryPins(pt, out, c));
      list.push({ key: 'factory', title: `工厂 · ${cName(plan.product)}`, code, ...buildTemplate({ name: `工厂-${cName(plan.product)}`, code, diam: diamOf(at), pins }), summary: layout.counts.map(([out, c]) => `${cName(out)} ×${c}`).join(' · ') + note });
    }
  }
  return list;
}

// 买料加工的工厂星：实际行星比规划时大、放不下时按能放下的最大产量重算
function buyTemplate(plan, at) {
  const diam = (at ? at.planet.radius * 2 : 10000) || 10000;
  const code = at?.code || plan.code;
  const pt = D.ptByCode[code];
  let layout = buyLayout(plan.dem, plan.perRate, plan.hubs, code, diam / 2);
  let note = '';
  if (!layout) {
    let lo = 0, hi = plan.perRate;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (buyLayout(plan.dem, mid, plan.hubs, code, diam / 2)) lo = mid; else hi = mid; }
    layout = buyLayout(plan.dem, lo, plan.hubs, code, diam / 2) || { counts: [] };
    note = `（这颗行星较大，链接更耗资源，产能约为规划的 ${Math.round((lo / plan.perRate) * 100)}%）`;
  }
  const group = layout.counts.slice().sort((a, b) => tierOf(a[0]) - tierOf(b[0])).flatMap(([out, c]) => factoryPins(pt, out, c));
  const pins = Array.from({ length: plan.hubs }, (_, k) => group.map((pin) => ({ ...pin, hub: k }))).flat();
  return {
    key: 'factory', title: `买料加工 · ${cName(plan.product)}`, code,
    ...buildTemplate({ name: `加工-${cName(plan.product)}`, code, diam, pins, hubs: plan.hubs }),
    summary: (plan.hubs > 1 ? `发射平台 ×${plan.hubs}，每组：` : '') + layout.counts.map(([out, c]) => `${cName(out)} ×${c}`).join(' · ') + note
  };
}

// 混合方案里兼工厂的采集星：采集设施 + 平摊到这颗星的加工设施
function hybridTemplate(plan, p1, at) {
  const diam = (at ? at.planet.radius * 2 : 10000) || 10000;
  const code = at?.code || plan.hostCodeByP1.get(p1);
  const pt = D.ptByCode[code];
  let load = hostLoad(plan.dem, plan.rate, plan.m, diam / 2);
  let ex = designExtractor(p0Of(p1), code, diam / 2, load);
  let note = '';
  if (!ex) {   // 实际行星比规划时大、链接更耗资源：按能放下的最大加工量重算工厂数
    let lo = 0, hi = plan.rate;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (designExtractor(p0Of(p1), code, diam / 2, hostLoad(plan.dem, mid, plan.m, diam / 2))) lo = mid; else hi = mid; }
    load = hostLoad(plan.dem, lo, plan.m, diam / 2);
    ex = designExtractor(p0Of(p1), code, diam / 2, load) || designExtractor(p0Of(p1), code, 1000, { cpu: 0, power: 0 });
    note = `（这颗行星较大，链接更耗资源，加工产能约为规划的 ${Math.round((lo / plan.rate) * 100)}%）`;
  }
  const pins = [
    ...ecuPins(pt, ex.p0, ex.heads), ...factoryPins(pt, p1, ex.fac),
    ...load.counts.sort((a, b) => tierOf(a[0]) - tierOf(b[0])).flatMap(([out, c]) => factoryPins(pt, out, c))
  ];
  return {
    key: 'hybrid-' + p1, title: `采集 + 工厂 · ${cName(ex.p0)} → ${cName(p1)}`, code,
    ...buildTemplate({ name: `采集工厂-${cName(p1)}`, code, diam, pins }),
    summary: `采集控制器 ×${ex.ecus}（共 ${ex.heads} 头）· 基础工业 ×${ex.fac} · ` + load.counts.map(([out, c]) => `${cName(out)} ×${c}`).join(' · ') + note
  };
}

// 空白模板：一个发射平台，可导入已有模板再修改
function blankTemplate() {
  const pt = D.ptByCode.B;
  return { CmdCtrLv: F.cc, Cmt: '新模板', Diam: 10000, L: [], P: [{ H: 0, La: 1.5708, Lo: 3.14159, S: null, T: pt.launchpad }], Pln: pt.id, R: [] };
}

// ---------- 页面 ----------
export async function showPi() {
  const main = $('piMain');
  if (!D.pi) main.innerHTML = '<div class="pi-loading">载入行星数据…</div>';
  await loadData();
  initPiEditor(editorEnv());
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="pi-page">
        <div class="pi-head">
          <h2>行星工业规划</h2>
          <button type="button" class="btn btn-ghost pi-colonies-entry" data-pi-colonies aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M5 12h14M12 5a10 10 0 0 1 0 14M12 5a10 10 0 0 0 0 14"/></svg><span>我的殖民地</span>
          </button>
          <button type="button" class="btn btn-ghost pi-editor-entry" data-pi-editor>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span>模板编辑器</span>
          </button>
        </div>
        <div class="pi-colonies" id="piColonies" hidden></div>
        <div class="pi-layout">
          <form class="pi-form" id="piForm" autocomplete="off"></form>
          <div class="pi-result" id="piResult">
            <div class="pi-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="7"/><ellipse cx="12" cy="12" rx="11" ry="3.6" transform="rotate(-20 12 12)"/></svg>
              <p>设置好地区和角色后，点「一键规划」</p>
            </div>
          </div>
        </div>
      </section>`;
    bind();
    main.querySelector('[data-pi-editor]').addEventListener('click', () => openTemplateEditor(blankTemplate(), { title: '模板编辑器' }));
    // 我的殖民地（ESI，需要「行星殖民地」权限）：展开时读取
    main.querySelector('[data-pi-colonies]').addEventListener('click', (e) => {
      const box = $('piColonies');
      box.hidden = !box.hidden;
      e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
      e.currentTarget.classList.toggle('active', !box.hidden);
      if (!box.hidden) ctx.renderColonies?.(box);
    });
    renderForm();
  }
  // 切回本页时保留表单与规划结果，不重新渲染
}

function renderForm() {
  const sys = D.sysById.get(F.system);
  const whSys = D.sysById.get(F.whSystem);
  const buy = F.way === 'buy';
  const products = (buy ? [1, 2, 3, 4] : [0, 1, 2, 3, 4]).map((t) => {
    const ids = Object.keys(D.pi.commodities).map(Number).filter((id) => tierOf(id) === t && (t === 0 || D.schemByOut.has(id)))
      .sort((a, b) => cName(a).localeCompare(cName(b), 'zh'));
    return `<optgroup label="${TIER_NAMES[t]}">${ids.map((id) => `<option value="${id}"${F.target === id ? ' selected' : ''}>${ctx.esc(cName(id))}</option>`).join('')}</optgroup>`;
  }).join('');
  const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, label]) => `<button type="button" data-pi-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${label}</button>`).join('')}</div>`;
  $('piForm').innerHTML = `
    <div class="pi-field">
      <label>方式</label>
      ${seg('way', [['self', '自产（采集）'], ['buy', '买料加工']], F.way)}
      ${buy ? `<small class="pi-hint">买入半成品加工后卖出</small>` : ''}
    </div>
    <div class="pi-field">
      <label>地区</label>
      ${seg('mode', [['region', '星域'], ['system', '星系周边'], ['wh', '虫洞']], F.mode)}
      ${F.mode === 'wh' ? `
        <div class="pi-inline pi-wh"><span>等级</span>${seg('whCls', WH_CLASSES, F.whSystem ? '' : F.whCls)}</div>
        <div class="search-box pi-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="piSystem" placeholder="或指定虫洞，如 J123456" value="${whSys ? ctx.esc(whSys.name) : ''}" spellcheck="false" aria-label="虫洞星系">
          <div class="kb-suggest" id="piSuggest" hidden></div>
        </div>
        <small class="pi-hint">${whSys ? `按 ${ctx.esc(whSys.name)}（${whLabel(whSys.wh)}，${whSys.planets.length} 颗行星）规划；点等级可改回按等级` : '按等级时综合该等级所有虫洞，行星分配取其中行星最齐的一个洞作示例；住在哪个洞就指定哪个'}</small>` : F.mode === 'region' ? `
        <select id="piRegion" class="pi-input">${D.regions.map((r) => `<option value="${r.id}"${r.id === F.region ? ' selected' : ''}>${ctx.esc(r.name)}</option>`).join('')}</select>` : `
        <div class="search-box pi-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="piSystem" placeholder="输入中心星系名" value="${sys ? ctx.esc(sys.name) : ''}" spellcheck="false" aria-label="中心星系">
          <div class="kb-suggest" id="piSuggest" hidden></div>
        </div>
        <div class="pi-inline"><span>范围</span>${seg('jumps', [[0, '本星系'], [1, '1 跳'], [2, '2 跳'], [3, '3 跳'], [5, '5 跳']], F.jumps)}</div>`}
      <div class="pi-checks"${F.mode === 'wh' ? ' hidden' : ''}>
        ${[['high', '高安'], ['low', '低安'], ['null', '00 / 波赫文']].map(([k, label]) => `<label class="pi-check sec-${k}"><input type="checkbox" data-pi-sec="${k}"${F.sec[k] ? ' checked' : ''}><span>${label}</span></label>`).join('')}
      </div>
    </div>
    <div class="pi-field">
      <label>角色与技能</label>
      <div class="pi-grid3">
        <div class="pi-num"><span>角色数</span><input type="number" class="pi-input" min="1" max="30" value="${F.chars}" data-pi-num="chars"></div>
        <div class="pi-num"><span>每角色行星</span><select class="pi-input" data-pi-num="perChar">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${F.perChar === n ? ' selected' : ''}>${n} 颗</option>`).join('')}</select></div>
        <div class="pi-num"><span>指挥中心</span><select class="pi-input" data-pi-num="cc">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${F.cc === n ? ' selected' : ''}>${n} 级</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="pi-field">
      <label>目标产品</label>
      <select id="piTarget" class="pi-input"><option value="0"${!F.target ? ' selected' : ''}>自动推荐（按日收益排序）</option>${products}</select>
    </div>
    <div class="pi-field">
      <label>估算参数</label>
      ${buy ? `
      <div class="pi-inline"><span>原料价</span>${seg('inPrice', [['sell', HUB_NAME + '卖单'], ['buy', HUB_NAME + '收单']], F.inPrice)}</div>
      <div class="pi-inline"><span>售价</span>${seg('price', [['sell', HUB_NAME + '卖单'], ['buy', HUB_NAME + '收单']], F.price)}</div>
      <div class="pi-inline"><span>补货周期</span>${seg('restock', [[12, '12 小时'], [24, '1 天'], [48, '2 天'], [72, '3 天']], F.restock)}</div>
      <div class="pi-inline"><span>成交上限</span>${seg('share', [[5, '5%'], [10, '10%'], [20, '20%'], [0, '不限']], F.share)}</div>` : `
      <div class="pi-inline"><span>资源丰度</span>${seg('rich', Object.entries(RICHNESS).map(([k, [, label]]) => [k, label]), F.rich)}</div>
      <div class="pi-inline"><span>价格</span>${seg('price', [['sell', HUB_NAME + '卖单'], ['buy', HUB_NAME + '收单']], F.price)}</div>`}
      <div class="pi-inline"><span>海关税率</span><input type="number" class="pi-input pi-tax" min="0" max="100" step="0.5" value="${F.tax}" data-pi-num="tax"><span>%</span></div>
      ${buy ? '' : `<small class="pi-hint">每个采集头每小时 ${RICHNESS.low[0]} / ${RICHNESS.mid[0]} / ${RICHNESS.high[0]} 单位</small>`}
    </div>
    <button type="submit" class="btn btn-primary pi-go">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>一键规划
    </button>`;
}

function bind() {
  const form = $('piForm');
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  form.addEventListener('click', (e) => {
    const set = e.target.closest('[data-pi-set]');
    if (set) {
      const key = set.dataset.piSet;
      F[key] = key === 'jumps' || key === 'restock' || key === 'share' ? Number(set.dataset.v) : set.dataset.v;
      if (key === 'way' && F.way === 'buy' && F.target && tierOf(F.target) === 0) F.target = 0;
      if (key === 'whCls') F.whSystem = 0;
      saveForm();
      renderForm();
      if (key !== 'mode' && R.area) run();
      return;
    }
    const pick = e.target.closest('[data-pi-pick]');
    if (pick) {
      if (F.mode === 'wh') F.whSystem = Number(pick.dataset.piPick);
      else F.system = Number(pick.dataset.piPick);
      saveForm();
      renderForm();
    }
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'piRegion') F.region = Number(t.value);
    else if (t.id === 'piTarget') F.target = Number(t.value);
    else if (t.dataset.piSec) F.sec[t.dataset.piSec] = t.checked;
    else if (t.dataset.piNum) {
      const lim = { chars: [1, 30], perChar: [1, 6], cc: [0, 5], tax: [0, 100] }[t.dataset.piNum];
      const v = Math.min(lim[1], Math.max(lim[0], Number(t.value) || 0));
      F[t.dataset.piNum] = t.dataset.piNum === 'tax' ? v : Math.round(v);
      t.value = F[t.dataset.piNum];
    } else return;
    saveForm();
  });
  form.addEventListener('input', (e) => { if (e.target.id === 'piSystem') suggest(e.target.value.trim()); });
  form.addEventListener('focusout', () => setTimeout(() => { if (!form.contains(document.activeElement)) $('piSuggest')?.setAttribute('hidden', ''); }, 150));
  $('piResult').addEventListener('click', onResultClick);
}

function suggest(q) {
  const box = $('piSuggest');
  if (!box) return;
  if (!q) { box.hidden = true; return; }
  const lower = q.toLowerCase();
  const hits = [];
  const wh = F.mode === 'wh';
  for (const s of D.sysById.values()) {
    if (Boolean(s.wh) !== wh || (wh && !s.planets.length)) continue;
    const name = s.name.toLowerCase();
    if (name.includes(lower)) hits.push([name.startsWith(lower) ? 0 : 1, s]);
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
  const regionName = (id) => D.regions.find((r) => r.id === id)?.name || '';
  box.innerHTML = hits.slice(0, 12).map(([, s]) => {
    const sec = s.wh ? { color: 'var(--accent-primary)', text: whLabel(s.wh) } : secInfo(s.sec);
    const codes = s.wh ? ' · ' + [...new Set(s.planets.map((p) => D.ptByCode[p.code].name))].join(' ') : '';
    return `<button type="button" class="kb-suggest-item" data-pi-pick="${s.id}"><i style="background:${sec.color}"></i><span>${ctx.esc(s.name)} <b style="color:${sec.color}">${sec.text}</b></span><small>${s.wh ? '虫洞' : ctx.esc(regionName(s.region))} · ${s.planets.length} 颗行星${codes}</small></button>`;
  }).join('') || `<div class="kb-suggest-group">没有匹配的${wh ? '虫洞（需有可建殖民地的行星）' : '星系'}</div>`;
  box.hidden = false;
}

// 全部 P0–P4 商品的吉他行情（失败时退回全服均价）
async function loadPrices() {
  if (R.prices.size && Date.now() - R.priceAt < 30 * 60e3) return;
  const ids = Object.keys(D.pi.commodities).map(Number);
  const [hub, avg] = await Promise.all([
    ctx.getHubPrices(ids, (done, total) => { const el = $('piProgress'); if (el) el.textContent = `读取${HUB_NAME}行情 ${done}/${total}`; }).catch(() => new Map()),
    ctx.getMarketPriceMap().catch(() => new Map())
  ]);
  R.prices = new Map(ids.map((id) => [id, { sell: hub.get(id)?.sell ?? null, buy: hub.get(id)?.buy ?? null, avg: avg.get(id) || 0 }]));
  R.priceAt = Date.now();
}

async function run() {
  const box = $('piResult');
  const area = collectArea();
  if (area.error) { box.innerHTML = `<div class="pi-empty"><p>${ctx.esc(area.error)}</p></div>`; return; }
  box.innerHTML = `<div class="pi-loading" id="piProgress">读取${HUB_NAME}行情…</div>`;
  try { await loadPrices(); } catch { /* 用已有行情 */ }
  R.area = area;
  demCache.clear();
  let plans;
  const plan = F.way === 'buy' ? planBuy : planProduct;
  if (F.target) plans = [plan(F.target, area)];
  else {
    plans = Object.keys(D.pi.commodities).map(Number).filter((id) => F.way === 'buy' ? D.schemByOut.has(id) : tierOf(id) === 0 || D.schemByOut.has(id))
      .map((id) => plan(id, area)).filter((p) => !p.error && p.profit > 0)
      .sort((a, b) => b.profit - a.profit);
  }
  if (F.way === 'buy' && F.share) {
    // 缩减后排名会变：直到前 20 名都按成交量核对过
    for (let todo; (todo = plans.slice(0, 20).filter((p) => !p.error && !p.depthChecked)).length;) {
      await applyMarketDepth(todo);
      plans = plans.filter((p) => p.error || p.profit > 0).sort((a, b) => b.profit - a.profit);
    }
  }
  R.plans = plans;
  R.selected = 0;
  R.edits.clear();
  renderResult();
  // 窄屏时结果在表单下方，滚动过去
  if (window.matchMedia('(max-width: 1100px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function areaSummary(area) {
  const whSys = D.sysById.get(F.whSystem);
  const label = F.mode === 'wh'
    ? (F.whSystem && whSys ? `${ctx.esc(whSys.name)}（${whLabel(whSys.wh)}）` : `${WH_CLASSES.find(([k]) => k === F.whCls)?.[1] || ''} 虫洞`)
    : F.mode === 'region'
      ? ctx.esc(D.regions.find((r) => r.id === F.region)?.name || '')
      : `${ctx.esc(D.sysById.get(F.system)?.name || '')} ${F.jumps ? F.jumps + ' 跳内' : ''}`;
  const chips = Object.entries(area.counts).sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `<span class="pi-ptype" style="--pt:${PLANET_COLORS[code]}"><i></i>${D.ptByCode[code].name} <b>${n}</b></span>`).join('');
  return `<div class="pi-area">
    <div class="pi-area-title"><b>${label}</b><span>${area.systems.length} 个星系 · ${area.planets.length} 颗行星 · ${F.chars} 个角色 × ${F.perChar} 颗 = ${F.chars * F.perChar} 个殖民地</span></div>
    <div class="pi-ptypes">${chips}</div>
  </div>`;
}

function strategyLabel(p) {
  if (p.strategy === 'single') return `单星 P2 × ${p.singles}`;
  if (p.strategy === 'extract') return `采集 × ${p.planets}`;
  if (p.strategy === 'raw') return `采集直接卖 × ${p.planets}`;
  if (p.strategy === 'buy') return `买 P${p.buyTier} 加工 × ${p.planets}${p.wanted ? ` / ${p.wanted}` : ''}${p.hubs > 1 ? `（各 ${p.hubs} 个发射平台）` : ''}`;
  if (p.strategy === 'hybrid') return `采集 × ${p.planets}（${p.m} 颗兼工厂）`;
  return `采集 × ${p.planets - p.factories} + 工厂 × ${p.factories}`;
}

const capBadge = (p) => ` <em class="pi-cap" title="卖出、买入各不超过${HUB_NAME}日成交的 ${F.share}%，只能用 ${p.planets} / ${p.wanted} 颗行星；多出的行星可以做别的产品">限成交量</em>`;

// 买料加工的多产品组合：每种产品受成交量限制只能用部分行星时，剩下的行星依次分给下一种产品。
// 按每颗行星的日收益从高到低分配（只用核对过成交量的方案），收益按行星数线性折算。
function buyCombo() {
  if (F.way !== 'buy' || F.target || !F.share) return null;
  let left = F.chars * F.perChar;
  const rows = [];
  const list = R.plans.map((p, i) => ({ p, i })).filter(({ p }) => !p.error && p.depthChecked && p.planets > 0 && p.profit > 0)
    .sort((a, b) => b.p.profit / b.p.planets - a.p.profit / a.p.planets);
  for (const { p, i } of list) {
    if (left <= 0) break;
    const n = Math.min(p.planets, left);
    rows.push({ p, i, n, profit: p.profit * n / p.planets });
    left -= n;
  }
  return rows.length > 1 ? { rows, left, total: rows.reduce((t, r) => t + r.profit, 0) } : null;
}

function comboHtml(combo) {
  if (!combo) return '';
  const all = F.chars * F.perChar;
  return `<div class="pi-card">
    <div class="pi-card-head"><h3>多产品组合</h3><span class="text-muted" title="单个产品受成交量限制用不满时，剩余行星分给下一种产品">${all} 个殖民地</span></div>
    <div class="pi-table-wrap"><table class="pi-table">
      <thead><tr><th>产品</th><th class="pi-hide-sm">方案</th><th class="num">行星</th><th class="num">日净收益</th></tr></thead>
      <tbody>${combo.rows.map((r) => `<tr class="${r.i === R.selected ? 'active' : ''}" data-pi-plan="${r.i}">
        <td><div class="pi-prod"><img src="${ICON(r.p.product)}" alt="" width="28" height="28" loading="lazy"><span>${ctx.esc(cName(r.p.product))}<small>P${tierOf(r.p.product)}</small></span></div></td>
        <td class="pi-hide-sm">买 P${r.p.buyTier} 加工</td><td class="num">${r.n}</td><td class="num pi-profit">${ctx.formatISK(r.profit)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>合计</td><td class="pi-hide-sm">${combo.left > 0 ? `<span class="text-muted">还有 ${combo.left} 颗行星没有合适的产品</span>` : ''}</td><td class="num">${all - combo.left}</td><td class="num pi-profit">${ctx.formatISK(combo.total)}</td></tr></tfoot>
    </table></div>
  </div>`;
}

function renderResult() {
  const box = $('piResult');
  const area = R.area;
  if (!R.plans.length) {
    box.innerHTML = areaSummary(area) + '<div class="pi-empty"><p>这个地区按当前条件没有可行的方案</p></div>';
    return;
  }
  if (R.plans.length === 1 && R.plans[0].error) {
    box.innerHTML = areaSummary(area) + `<div class="pi-empty"><p><b>${ctx.esc(cName(R.plans[0].product))}</b> 无法规划：${ctx.esc(R.plans[0].error)}</p></div>`;
    return;
  }
  const rows = R.plans.slice(0, 30).map((p, i) => `
    <tr class="${i === R.selected ? 'active' : ''}" data-pi-plan="${i}">
      <td class="pi-rank">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ICON(p.product)}" alt="" width="28" height="28" loading="lazy"><span>${ctx.esc(cName(p.product))}<small>P${tierOf(p.product)}</small></span></div></td>
      <td class="pi-hide-sm">${strategyLabel(p)}${p.wanted ? capBadge(p) : ''}</td>
      <td class="num">${ctx.formatNumber(Math.round(p.rate * 24))}</td>
      <td class="num pi-hide-sm">${ctx.formatISK(priceOf(p.product))}</td>
      <td class="num pi-profit">${ctx.formatISK(p.profit)}</td>
    </tr>`).join('');
  const priceNote = R.priceAt ? `行情 ${new Date(R.priceAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : '';
  box.innerHTML = `${areaSummary(area)}
    ${comboHtml(buyCombo())}
    ${R.plans.length > 1 ? `<div class="pi-card">
      <div class="pi-card-head"><h3>推荐产品</h3><span class="text-muted">${priceNote}</span></div>
      <div class="pi-table-wrap"><table class="pi-table">
        <thead><tr><th>#</th><th>产品</th><th class="pi-hide-sm">方案</th><th class="num">日产量</th><th class="num pi-hide-sm">单价</th><th class="num">日净收益</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>` : ''}
    <div id="piDetail"></div>`;
  renderDetail();
}

function renderDetail() {
  const plan = R.plans[R.selected];
  const el = $('piDetail');
  if (!plan || plan.error) { el.innerHTML = ''; return; }
  const assign = assignPlanets(plan, R.area);
  const templates = planTemplates(plan, assign).map((t) => R.edits.get(R.selected + ':' + t.key) || t);
  R.templates = templates;
  const icon = (id, s = 20) => `<img src="${ICON(id)}" alt="" width="${s}" height="${s}" loading="lazy">`;
  const fmtH = (v) => (v >= 100 ? ctx.formatNumber(Math.round(v)) : v.toFixed(1));

  // 生产链
  let chain = '';
  if (plan.strategy === 'buy') {
    const byTier = new Map();
    const add = (id, rate, bought) => { const t = tierOf(id); if (!byTier.has(t)) byTier.set(t, new Map()); const m = byTier.get(t); m.set(id, { rate: (m.get(id)?.rate || 0) + rate, bought }); };
    for (const [out, n] of plan.dem.fac) { const s = D.schemByOut.get(out); add(out, n * plan.rate * perHour(s, s.outQty), false); }
    for (const [id, q] of plan.dem.buy) add(id, q * plan.rate, true);
    chain = [...byTier.keys()].sort().map((t) => `<div class="pi-chain-row"><em>P${t}</em>${[...byTier.get(t)].map(([id, v]) => `<span class="${id === plan.product ? 'pi-chain-final' : v.bought ? 'pi-chain-buy' : ''}">${icon(id)}${ctx.esc(cName(id))} <b>${fmtH(v.rate)}/h</b>${v.bought ? '<small>买入</small>' : ''}</span>`).join('')}</div>`).join('');
  } else if (plan.strategy === 'single') {
    const s = plan.single;
    chain = `<div class="pi-chain-row">${s.p0s.map((p0) => `<span>${icon(p0)}${ctx.esc(cName(p0))} <b>${fmtH(s.p0h)}/h</b></span>`).join('')}</div>
      <div class="pi-chain-row">${s.p1s.map((p1) => `<span>${icon(p1)}${ctx.esc(cName(p1))} <b>${fmtH(s.p1h)}/h</b></span>`).join('')}</div>
      <div class="pi-chain-row"><span class="pi-chain-final">${icon(plan.product)}${ctx.esc(cName(plan.product))} <b>${fmtH(s.rate)}/h</b><small>每颗行星</small></span></div>`;
  } else {
    const byTier = new Map();
    const add = (id, rate) => { const t = tierOf(id); if (!byTier.has(t)) byTier.set(t, new Map()); byTier.get(t).set(id, (byTier.get(t).get(id) || 0) + rate); };
    if (plan.strategy === 'extract' || plan.strategy === 'raw') add(plan.product, plan.rate);
    else {
      add(plan.product, plan.rate);
      for (const [out, n] of plan.dem.fac) if (out !== plan.product) { const s = D.schemByOut.get(out); add(out, n * plan.rate * perHour(s, s.outQty)); }
      for (const [p1] of plan.extract) add(p1, plan.rate * plan.dem.p1.get(p1));
    }
    chain = [...byTier.keys()].sort().map((t) => `<div class="pi-chain-row"><em>P${t}</em>${[...byTier.get(t)].map(([id, r]) => `<span class="${id === plan.product ? 'pi-chain-final' : ''}">${icon(id)}${ctx.esc(cName(id))} <b>${fmtH(r)}/h</b></span>`).join('')}</div>`).join('');
  }
  const buyNote = plan.strategy === 'buy' ? (() => {
    const inDay = [...plan.dem.buy].reduce((t, [id, q]) => t + q * plan.rate * 24 * vol(id), 0);
    const outDay = plan.rate * 24 * vol(plan.product);
    return `<p class="pi-note" title="每 ${F.restock} 小时补货，每颗星 ${plan.hubs} 个发射平台（各 ${ctx.formatNumber(LP_CAP)} m³）；一次补货原料约 ${ctx.formatISK(plan.cost / 24 * F.restock)}">每天买入 ${ctx.formatNumber(Math.round(inDay))} m³ · 运出 ${ctx.formatNumber(Math.round(outDay))} m³ · 月净收益 ${ctx.formatISK(plan.profit * 30)}</p>
      ${plan.wanted ? `<p class="pi-note warn" title="卖出、买入各不超过日成交的 ${F.share}%；其余行星可做别的产品（见「多产品组合」）">受成交量限制，只用 ${plan.planets} / ${plan.wanted} 颗行星</p>` : ''}
      <p class="pi-note" id="piDepth"></p>`;
  })() : '';
  const surplus = buyNote + (plan.surplus.length ? `<p class="pi-note">另售 ${plan.surplus.map(([id, r]) => `${ctx.esc(cName(id))} ${ctx.formatNumber(Math.round(r * 24))}/天`).join('、')}</p>` : '')
    + (plan.strategy === 'raw' ? `<p class="pi-note">P0 体积大：每颗星每天约 ${ctx.formatNumber(Math.round(plan.rate / plan.planets * 24 * (commodity(plan.product)[3] || 0.01)))} m³</p>` : '')
    + (plan.strategy === 'hybrid' ? `<p class="pi-note" title="采集星电网吃紧、CPU 富余，每颗只少放一两个采集头；需要把其他 P1 运到这些星">加工设施平摊在 ${plan.m} 颗采集星上</p>` : '');

  // 行星分配
  const roleText = (r) => `${{ single: '单星', extract: '采集', hybrid: '采集+工厂', factory: '工厂' }[r.kind]} · ${cName(r.product)}`;
  const tplKey = (r) => r.kind === 'single' ? 'single' : r.kind === 'extract' || r.kind === 'hybrid' ? r.kind + '-' + r.product : 'factory';
  const regionName = (id) => D.regions.find((x) => x.id === id)?.name || '';
  const charBlocks = assign.chars.map((c, ci) => `
    <div class="pi-char">
      <div class="pi-char-head">角色 ${ci + 1}<span>${c.rows.length} / ${F.perChar} 颗</span></div>
      ${c.rows.map((r) => {
        const sec = r.at.sys.wh ? { color: 'var(--accent-primary)', text: whLabel(r.at.sys.wh) } : secInfo(r.at.sys.sec);
        return `<div class="pi-planet">
          <i class="pi-dot" style="--pt:${PLANET_COLORS[r.at.code]}" title="${D.ptByCode[r.at.code].name}"></i>
          <div class="pi-planet-main">
            <b>${ctx.esc(planetName(r.at.sys, r.at.planet))}</b> <span style="color:${sec.color}">${sec.text}</span>
            <small>${D.ptByCode[r.at.code].name} · ${r.at.sys.wh ? '虫洞' : ctx.esc(regionName(r.at.sys.region)) + (r.jumps ? ` · 距中心 ${r.jumps} 跳` : r.jumps === 0 ? ' · 中心星系' : '')}</small>
          </div>
          <button type="button" class="pi-role" data-pi-tpl-jump="${tplKey(r)}">${ctx.esc(roleText(r))}</button>
        </div>`;
      }).join('') || '<p class="text-muted">未分配</p>'}
    </div>`).join('');
  const warn = assign.warnings.length ? `<p class="pi-note warn">${assign.warnings.length} 个殖民地没有可用行星${F.mode === 'wh' && !F.whSystem ? '，指定所在虫洞可得到准确方案' : '，可扩大地区或增加角色'}</p>` : '';

  // 模板
  const [capC, capP] = ccCap();
  const tplCards = templates.map((t, i) => `
    <div class="pi-tpl" id="pi-tpl-${t.key}">
      <button type="button" class="pi-tpl-preview" data-pi-edit="${i}" title="预览 / 修改模板">
        <canvas class="pie-thumb" data-pi-thumb="${i}"></canvas>
        <span class="pi-tpl-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>预览 / 修改</span>
        ${t.edited ? '<span class="pi-tpl-edited">已修改</span>' : ''}
      </button>
      <div class="pi-tpl-head">
        <i class="pi-dot" style="--pt:${PLANET_COLORS[t.code]}"></i>
        <div><b>${ctx.esc(t.title)}</b><small>${ctx.esc(t.summary)}</small></div>
      </div>
      <div class="pi-bars">
        <div class="pi-bar"><span>CPU</span><div><i style="width:${Math.min(100, (t.cpu / capC) * 100).toFixed(1)}%"></i></div><b>${ctx.formatNumber(Math.round(t.cpu))} / ${ctx.formatNumber(capC)}</b></div>
        <div class="pi-bar"><span>电网</span><div><i style="width:${Math.min(100, (t.power / capP) * 100).toFixed(1)}%"></i></div><b>${ctx.formatNumber(Math.round(t.power))} / ${ctx.formatNumber(capP)}</b></div>
      </div>
      <div class="pi-tpl-actions">
        <button type="button" class="btn btn-primary" data-pi-copy="${i}">复制模板</button>
        <button type="button" class="btn btn-ghost" data-pi-download="${i}">下载 .json</button>
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="pi-card pi-detail">
      <div class="pi-detail-head">
        <img src="${ICON(plan.product, 64)}" alt="" width="48" height="48">
        <div><h3>${ctx.esc(cName(plan.product))}</h3><span class="text-muted">${TIER_NAMES[tierOf(plan.product)]} · ${strategyLabel(plan)}</span></div>
      </div>
      <div class="pi-stats">
        <div><span>日产量</span><b>${ctx.formatNumber(Math.round(plan.rate * 24))}</b></div>
        <div><span>日收入</span><b>${ctx.formatISK(plan.revenue)}</b></div>
        ${plan.strategy === 'buy' ? `<div><span>原料成本</span><b>${ctx.formatISK(plan.cost)}</b></div>` : ''}
        <div><span>海关税</span><b>${ctx.formatISK(plan.tax)}</b></div>
        <div class="pi-stat-main"><span>日净收益</span><b>${ctx.formatISK(plan.profit)}</b></div>
        ${plan.strategy === 'buy' ? '' : `<div><span>月净收益</span><b>${ctx.formatISK(plan.profit * 30)}</b></div>`}
      </div>
      <h4>生产链</h4>
      <div class="pi-chain">${chain}</div>
      ${surplus}
    </div>
    <div class="pi-card">
      <div class="pi-card-head"><h3>行星分配</h3><span class="text-muted">${F.mode === 'wh' ? (F.whSystem ? '' : '示例虫洞 ') : '中心 '}${ctx.esc(assign.home?.name || '')}</span></div>
      ${warn}
      <div class="pi-chars">${charBlocks}</div>
    </div>
    <div class="pi-card">
      <div class="pi-card-head"><h3>殖民地模板</h3><span class="text-muted">指挥中心 ${F.cc} 级</span></div>
      <div class="pi-tpls">${tplCards}</div>
      <div class="pi-howto">
        <b>导入游戏</b>
        <ol>
          <li>放置指挥中心并升到 ${F.cc} 级</li>
          ${plan.strategy === 'buy' ? `<li>在${HUB_NAME}买好原料，运到行星所在星系，通过海关办公室进口到发射平台（多个发射平台时平均分）</li>` : ''}
          <li>复制模板，游戏内「模板 → 导入与导出 → 从剪贴板载入」；或把 .json 放进 <code>文档\\EVE\\PlanetaryInteractionTemplates</code></li>
          ${plan.strategy === 'buy' ? '<li>提交后工厂会按路由自动从发射平台取料</li>' : '<li>摆放采集头、设定周期后提交</li>'}
        </ol>
      </div>
    </div>`;
  el.querySelectorAll('[data-pi-thumb]').forEach((c) => drawThumb(c, templates[Number(c.dataset.piThumb)].json));
  if (plan.strategy === 'buy') showDepth(plan);
}

// 市场深度：本方案日产量、日采购量占吉他（伏尔戈）近 30 天日均成交量的比例
const history = new Map();
function dailyVolume(id) {
  if (!history.has(id)) {
    history.set(id, (ctx.fetchESI ? ctx.fetchESI(`/markets/${HUB.id}/history/?type_id=${id}`) : Promise.reject(new Error('no esi')))
      .then((h) => { const last = (Array.isArray(h) ? h : []).slice(-30); return last.length ? last.reduce((t, x) => t + x.volume, 0) / 30 : 0; })
      .catch(() => { history.delete(id); return null; }));
  }
  return history.get(id);
}
// 买料加工：按吉他成交量限制行星数（每颗星的产量、采购量固定，按比例缩减）
async function applyMarketDepth(plans) {
  const ids = [...new Set(plans.filter((p) => !p.error).flatMap((p) => [p.product, ...p.dem.buy.keys()]))];
  let done = 0;
  const queue = ids.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      await dailyVolume(queue.shift());
      const el = $('piProgress');
      if (el) el.textContent = `读取${HUB_NAME}成交量 ${++done}/${ids.length}`;
    }
  }));
  for (const plan of plans) {
    if (plan.error) continue;
    plan.depthChecked = true;
    const perPlanet = plan.rate / plan.planets * 24;
    const items = [[plan.product, 1], ...plan.dem.buy];
    let cap = Infinity;
    for (const [id, q] of items) {
      const v = await dailyVolume(id);
      if (v != null) cap = Math.min(cap, Math.floor(v * F.share / 100 / (perPlanet * q)));
    }
    if (cap >= plan.planets) continue;
    const k = cap / plan.planets;
    plan.wanted = plan.planets;
    for (const key of ['rate', 'revenue', 'cost', 'tax', 'profit']) plan[key] *= k;
    plan.planets = plan.factories = cap;
  }
}

async function showDepth(plan) {
  const items = [[plan.product, plan.rate * 24, '卖出'], ...[...plan.dem.buy].map(([id, q]) => [id, q * plan.rate * 24, '买入'])];
  const vols = await Promise.all(items.map(([id]) => dailyVolume(id)));
  const el = $('piDepth');
  if (!el || R.plans[R.selected] !== plan) return;
  const parts = items.map(([id, n, verb], i) => {
    const v = vols[i];
    if (v == null) return null;
    const pct = v ? n / v * 100 : Infinity;
    return { text: `${verb}${cName(id)} ${ctx.formatNumber(Math.round(n))}/天，占${HUB_NAME}日成交 ${v ? (pct < 1 ? pct.toFixed(1) : Math.round(pct)) + '%' : '—（几乎没有成交）'}`, high: pct > 20 };
  }).filter(Boolean);
  if (!parts.length) return;
  const high = parts.some((p) => p.high);
  el.classList.toggle('warn', high);
  el.innerHTML = ctx.esc(parts.map((p) => p.text).join('；')) + (high ? '。占比过高时价格会被自己打穿，建议减少行星数或分散到几种产品' : '');
}

function onResultClick(e) {
  const row = e.target.closest('[data-pi-plan]');
  if (row) {
    R.selected = Number(row.dataset.piPlan);
    $('piResult').querySelectorAll('[data-pi-plan]').forEach((r) => r.classList.toggle('active', r.dataset.piPlan === row.dataset.piPlan));
    renderDetail();
    $('piDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const copy = e.target.closest('[data-pi-copy]');
  if (copy) {
    const t = R.templates[Number(copy.dataset.piCopy)];
    navigator.clipboard.writeText(templateText(t.json))
      .then(() => ctx.showToast(`已复制模板「${t.title}」，到游戏里从剪贴板载入`, 'success', 2600))
      .catch(() => ctx.showToast('浏览器阻止了复制，请改用下载', 'error'));
    return;
  }
  const dl = e.target.closest('[data-pi-download]');
  if (dl) {
    const t = R.templates[Number(dl.dataset.piDownload)];
    downloadTemplate(t.json);
    return;
  }
  const edit = e.target.closest('[data-pi-edit]');
  if (edit) {
    const i = Number(edit.dataset.piEdit);
    const t = R.templates[i];
    openTemplateEditor(t.json, {
      title: t.title,
      onSave: (json, info) => {
        Object.assign(t, { json, cpu: info.cpu, power: info.power, code: info.code, edited: true });
        R.edits.set(R.selected + ':' + t.key, t);
        renderDetail();
      }
    });
    return;
  }
  const jump = e.target.closest('[data-pi-tpl-jump]');
  if (jump) {
    const card = document.getElementById('pi-tpl-' + jump.dataset.piTplJump);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
  }
}
