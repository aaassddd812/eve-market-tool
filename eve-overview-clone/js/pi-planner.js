// ===== 行星工业规划 =====
// 选择地区（星域，或某星系周边若干跳）、角色数与技能，按吉他行情为每种产品（P1–P4）算出最优的行星分配，
// 给出每颗行星该放什么、预计日产量与收益，并生成游戏内可直接导入的殖民地模板（JSON）。
// ESI 只有读取殖民地的接口，不能写入模板，所以模板通过「复制到剪贴板」或「下载 .json」导入游戏。
// 数据：pi-data.json（build_pi.mjs 从 SDE 生成），map-data.json（星系、星门、星域）。
import { initPiEditor, openTemplateEditor, drawThumb, templateText, downloadTemplate, SPACING } from './pi-editor.js?v=v19r16';
import { angle } from './pi-globe.js?v=v19r12';

let ctx;   // esc, formatISK, formatNumber, showToast, store, getHubPrices(ids) -> Map(id -> {sell, buy}), getMarketPriceMap
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-pi-form-v1';

// 指挥中心等级 0–5 的 [CPU, 电网]（指挥中心升级技能）
const CC_LEVELS = [[1675, 6000], [7057, 9000], [12136, 12000], [17215, 15000], [21315, 17000], [25415, 19000]];
const HEAD = [110, 550];               // 每个采集头 [CPU, 电网]
// 链接负载 [CPU, 电网]：长度 = 弧度 × 行星半径，所以同样的模板在大行星上更耗资源
const linkLoad = (radiusKm, rad = SPACING) => [Math.ceil(15 + 0.2 * rad * radiusKm), Math.ceil(10 + 0.15 * rad * radiusKm)];
const MAX_HEADS = 10;                  // 每个采集控制器最多 10 个采集头
// 海关出口税基数（每单位，按等级），进口为出口的一半
const TAX_BASE = [5, 400, 7200, 60000, 1200000];
// 资源丰度：每个采集头每小时平均产量（实际取决于热点位置与采集周期，仅作估算）
const RICHNESS = { low: [300, '低'], mid: [500, '中'], high: [750, '高'] };
const TIER_NAMES = ['P0 原材料', 'P1 基础产品', 'P2 精炼产品', 'P3 特种产品', 'P4 高级产品'];
const PLANET_COLORS = { T: '#5fbf6f', I: '#8fd3ff', G: '#e0bf62', O: '#4f8ff7', L: '#f06a3c', B: '#b9a47c', S: '#9a90e0', P: '#d36ad6' };
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
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
  mode: 'region', region: 10000002, system: 0, jumps: 2,
  sec: { high: true, low: true, null: true },
  chars: 1, perChar: 6, cc: 5,
  target: 0, rich: 'mid', tax: 10, price: 'sell'
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

// ---------- 数据 ----------
function loadData() {
  if (!D.loading) {
    D.loading = Promise.all([
      fetch('pi-data.json?v=1').then((r) => { if (!r.ok) throw new Error('pi-data.json ' + r.status); return r.json(); }),
      fetch('map-data.json').then((r) => { if (!r.ok) throw new Error('map-data.json ' + r.status); return r.json(); })
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
  if (F.mode === 'system') {
    if (!D.sysById.has(F.system)) return { error: '请先选择中心星系' };
    systems = [...bfs(F.system, F.jumps)].map(([id, jumps]) => ({ sys: D.sysById.get(id), jumps }));
  } else {
    systems = [...D.sysById.values()].filter((s) => s.region === F.region).map((sys) => ({ sys, jumps: null }));
  }
  systems = systems.filter(({ sys }) => F.sec[secInfo(sys.sec).cls]);
  const planets = [];
  for (const { sys, jumps } of systems) for (const p of sys.planets) planets.push({ sys, planet: p, code: p.code, jumps });
  if (!planets.length) return { error: '所选地区（按安全等级过滤后）没有可建殖民地的行星' };
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
function designExtractor(p0, code = 'B', radius = 5000) {
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
    const fac = Math.ceil(p0h / bIn);
    const links = ecus + fac;
    const cpu = lpC + ecus * eC + h * HEAD[0] + fac * bC + links * LINK[0];
    const power = lpP + ecus * eP + h * HEAD[1] + fac * bP + links * LINK[1];
    if (fits(cpu, power)) {
      return { kind: 'extract', p0, p1: basic.out, heads: h, ecus, fac, p0h, p1h: p0h / basic.inputs[0][1] * basic.outQty, cpu, power };
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
  if (!fCode) reasons.push('地区内没有能建高科技工厂的贫瘠 / 温和行星');
  else if (total < p1s.length + 1) reasons.push(`需要至少 ${p1s.length + 1} 颗行星（${p1s.length} 种 P1 各一颗采集星 + 1 颗工厂星）`);
  else {
    const exByP1 = new Map(p1s.map((p1) => { const c = bestCodeFor(area, [p0Of(p1)]); return [p1, designExtractor(p0Of(p1), c, typicalRadius(area, [c]))]; }));
    const fR = typicalRadius(area, [fCode]);
    if ([...exByP1.values()].some((e) => !e)) reasons.push('指挥中心等级过低，放不下采集设施');
    else {
      let best = null;
      for (let f = 1; f <= total - p1s.length; f++) {
        const n = new Map(p1s.map((p1) => [p1, 1]));
        const cap = (p1) => (area.resCount.get(p0Of(p1)) || 0) * F.chars;
        const ratio = (p1) => n.get(p1) * exByP1.get(p1).p1h / dem.p1.get(p1);
        for (let left = total - f - p1s.length; left > 0; left--) {
          const pick = p1s.filter((p1) => n.get(p1) < cap(p1)).sort((a, b) => ratio(a) - ratio(b))[0];
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
  if (plan.strategy === 'chain') {
    for (const [p1, n] of plan.extract) {
      const made = n * plan.exByP1.get(p1).p1h;
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
  if (plan.strategy === 'single') {
    for (let i = 0; i < plan.singles; i++) roles.push({ kind: 'single', product: plan.product, codes: plan.singleCodes });
  } else {
    for (const [p1, n] of plan.extract) {
      const p0 = p0Of(p1);
      const codes = Object.keys(area.counts).filter((c) => D.ptByCode[c].res.includes(p0));
      for (let i = 0; i < n; i++) roles.push({ kind: 'extract', product: p1, p0, codes });
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
  // 由近到远；同一星系里优先小行星（链接短、省 CPU / 电网）
  const planets = area.planets.slice().sort((a, b) => (dist.get(a.sys.id) ?? 99) - (dist.get(b.sys.id) ?? 99) || a.planet.radius - b.planet.radius);
  const chars = Array.from({ length: F.chars }, () => ({ used: new Set(), rows: [] }));
  // 选择余地小的角色先分配
  const order = roles.map((r, i) => i).sort((a, b) => roles[a].codes.length - roles[b].codes.length);
  const warnings = [];
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
  const kindOrder = { single: 0, extract: 1, factory: 2 };
  for (const c of chars) c.rows.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.jumps ?? 0) - (b.jumps ?? 0));
  return { home, chars, warnings };
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

function buildTemplate({ name, code, diam, pins }) {
  const pt = D.ptByCode[code];
  const R0 = diam / 2;
  const out = { CmdCtrLv: F.cc, Cmt: name.slice(0, 40), Diam: diam, L: [], P: [], Pln: pt.id, R: [] };
  const hub = 1;
  const c0 = { th: Math.PI / 2, ph: Math.PI };
  out.P.push({ H: 0, La: Number(c0.th.toFixed(5)), Lo: Number(c0.ph.toFixed(5)), S: null, T: pt.launchpad });
  const { list } = slots(Math.min(pins.length, 54));
  const path = new Map([[hub, [hub]]]);
  const pos = [c0];
  pins.slice(0, list.length).forEach((pin, i) => {
    const sl = list[i];
    const d = sl.depth * SPACING;
    const th = c0.th - d * Math.sin(sl.theta);
    const ph = c0.ph + (d * Math.cos(sl.theta)) / Math.sin(th);
    const idx = out.P.length + 1;
    out.P.push({ H: pin.heads || 0, La: Number(th.toFixed(5)), Lo: Number(ph.toFixed(5)), S: pin.product, T: pin.type });
    pos.push({ th: out.P[idx - 1].La, ph: out.P[idx - 1].Lo });
    const prev = sl.parent < 0 ? hub : sl.parent + 2;
    out.L.push({ D: idx, Lv: 0, S: prev });
    path.set(idx, [...path.get(prev), idx]);
    const toPin = path.get(idx);
    const fromPin = toPin.slice().reverse();
    if (pin.heads) out.R.push({ P: fromPin, Q: Math.round(pin.heads * headRate()), T: pin.product });
    for (const [t, q] of pin.inputs || []) out.R.push({ P: toPin, Q: q, T: t });
    if (pin.outQty) out.R.push({ P: fromPin, Q: pin.outQty, T: pin.product });
  });
  // 负载统计（链接按实际弧长计费）
  let [cpu, power] = struct(pt.launchpad);
  for (const pin of pins.slice(0, list.length)) {
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
    for (const [p1] of plan.extract) {
      const at = firstOf('extract', p1);
      const code = at?.code || bestCodeFor(R.area, [p0Of(p1)]);
      const pt = D.ptByCode[code];
      const ex = designExtractor(p0Of(p1), code, diamOf(at) / 2) || designExtractor(p0Of(p1), code, 1000);
      const pins = [...ecuPins(pt, ex.p0, ex.heads), ...factoryPins(pt, p1, ex.fac)];
      list.push({ key: 'extract-' + p1, title: `采集 · ${cName(ex.p0)} → ${cName(p1)}`, code, ...buildTemplate({ name: `采集-${cName(p1)}`, code, diam: diamOf(at), pins }), summary: `采集控制器 ×${ex.ecus}（共 ${ex.heads} 头）· 基础工业 ×${ex.fac}` });
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
          <span class="text-muted">选择地区与角色技能，一键算出每种产品的最优行星分配与收益，并生成可导入游戏的殖民地模板</span>
          <button type="button" class="btn btn-ghost pi-editor-entry" data-pi-editor>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span>模板编辑器</span>
          </button>
        </div>
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
  }
  renderForm();
}

function renderForm() {
  const sys = D.sysById.get(F.system);
  const products = [1, 2, 3, 4].map((t) => {
    const ids = Object.keys(D.pi.commodities).map(Number).filter((id) => tierOf(id) === t && D.schemByOut.has(id))
      .sort((a, b) => cName(a).localeCompare(cName(b), 'zh'));
    return `<optgroup label="${TIER_NAMES[t]}">${ids.map((id) => `<option value="${id}"${F.target === id ? ' selected' : ''}>${ctx.esc(cName(id))}</option>`).join('')}</optgroup>`;
  }).join('');
  const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, label]) => `<button type="button" data-pi-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${label}</button>`).join('')}</div>`;
  $('piForm').innerHTML = `
    <div class="pi-field">
      <label>地区</label>
      ${seg('mode', [['region', '星域'], ['system', '星系周边']], F.mode)}
      ${F.mode === 'region' ? `
        <select id="piRegion" class="pi-input">${D.regions.map((r) => `<option value="${r.id}"${r.id === F.region ? ' selected' : ''}>${ctx.esc(r.name)}</option>`).join('')}</select>` : `
        <div class="search-box pi-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="piSystem" placeholder="输入中心星系名" value="${sys ? ctx.esc(sys.name) : ''}" spellcheck="false" aria-label="中心星系">
          <div class="kb-suggest" id="piSuggest" hidden></div>
        </div>
        <div class="pi-inline"><span>范围</span>${seg('jumps', [[0, '本星系'], [1, '1 跳'], [2, '2 跳'], [3, '3 跳'], [5, '5 跳']], F.jumps)}</div>`}
      <div class="pi-checks">
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
      <small class="pi-hint">每角色行星数 = 星际整合等级 + 1；指挥中心等级 = 指挥中心升级技能等级</small>
    </div>
    <div class="pi-field">
      <label>目标产品</label>
      <select id="piTarget" class="pi-input"><option value="0"${!F.target ? ' selected' : ''}>自动推荐（按日收益排序）</option>${products}</select>
    </div>
    <div class="pi-field">
      <label>估算参数</label>
      <div class="pi-inline"><span>资源丰度</span>${seg('rich', Object.entries(RICHNESS).map(([k, [, label]]) => [k, label]), F.rich)}</div>
      <div class="pi-inline"><span>价格</span>${seg('price', [['sell', '吉他卖单'], ['buy', '吉他收单']], F.price)}</div>
      <div class="pi-inline"><span>海关税率</span><input type="number" class="pi-input pi-tax" min="0" max="100" step="0.5" value="${F.tax}" data-pi-num="tax"><span>%</span></div>
      <small class="pi-hint">资源丰度按每个采集头每小时 ${RICHNESS.low[0]} / ${RICHNESS.mid[0]} / ${RICHNESS.high[0]} 单位估算，实际取决于热点位置和采集周期</small>
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
      F[key] = key === 'jumps' ? Number(set.dataset.v) : set.dataset.v;
      saveForm();
      renderForm();
      if (key !== 'mode' && R.area) run();
      return;
    }
    const pick = e.target.closest('[data-pi-pick]');
    if (pick) {
      F.system = Number(pick.dataset.piPick);
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
  for (const s of D.sysById.values()) {
    const name = s.name.toLowerCase();
    if (name.includes(lower)) hits.push([name.startsWith(lower) ? 0 : 1, s]);
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
  const regionName = (id) => D.regions.find((r) => r.id === id)?.name || '';
  box.innerHTML = hits.slice(0, 12).map(([, s]) => {
    const sec = secInfo(s.sec);
    return `<button type="button" class="kb-suggest-item" data-pi-pick="${s.id}"><i style="background:${sec.color}"></i><span>${ctx.esc(s.name)} <b style="color:${sec.color}">${sec.text}</b></span><small>${ctx.esc(regionName(s.region))} · ${s.planets.length} 颗行星</small></button>`;
  }).join('') || '<div class="kb-suggest-group">没有匹配的星系</div>';
  box.hidden = false;
}

// 全部 P0–P4 商品的吉他行情（失败时退回全服均价）
async function loadPrices() {
  if (R.prices.size && Date.now() - R.priceAt < 30 * 60e3) return;
  const ids = Object.keys(D.pi.commodities).map(Number);
  const [hub, avg] = await Promise.all([
    ctx.getHubPrices(ids, (done, total) => { const el = $('piProgress'); if (el) el.textContent = `读取吉他行情 ${done}/${total}`; }).catch(() => new Map()),
    ctx.getMarketPriceMap().catch(() => new Map())
  ]);
  R.prices = new Map(ids.map((id) => [id, { sell: hub.get(id)?.sell ?? null, buy: hub.get(id)?.buy ?? null, avg: avg.get(id) || 0 }]));
  R.priceAt = Date.now();
}

async function run() {
  const box = $('piResult');
  const area = collectArea();
  if (area.error) { box.innerHTML = `<div class="pi-empty"><p>${ctx.esc(area.error)}</p></div>`; return; }
  box.innerHTML = '<div class="pi-loading" id="piProgress">读取吉他行情…</div>';
  try { await loadPrices(); } catch { /* 用已有行情 */ }
  R.area = area;
  demCache.clear();
  let plans;
  if (F.target) plans = [planProduct(F.target, area)];
  else {
    plans = Object.keys(D.pi.commodities).map(Number).filter((id) => tierOf(id) >= 1 && D.schemByOut.has(id))
      .map((id) => planProduct(id, area)).filter((p) => !p.error && p.profit > 0)
      .sort((a, b) => b.profit - a.profit);
  }
  R.plans = plans;
  R.selected = 0;
  R.edits.clear();
  renderResult();
  // 窄屏时结果在表单下方，滚动过去
  if (window.matchMedia('(max-width: 1100px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function areaSummary(area) {
  const label = F.mode === 'region'
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
  return `采集 × ${p.planets - p.factories} + 工厂 × ${p.factories}`;
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
      <td class="pi-hide-sm">${strategyLabel(p)}</td>
      <td class="num">${ctx.formatNumber(Math.round(p.rate * 24))}</td>
      <td class="num pi-hide-sm">${ctx.formatISK(priceOf(p.product))}</td>
      <td class="num pi-profit">${ctx.formatISK(p.profit)}</td>
    </tr>`).join('');
  const priceNote = R.priceAt ? `行情 ${new Date(R.priceAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : '';
  box.innerHTML = `${areaSummary(area)}
    ${R.plans.length > 1 ? `<div class="pi-card">
      <div class="pi-card-head"><h3>推荐产品</h3><span class="text-muted">按日净收益排序 · ${priceNote}</span></div>
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
  if (plan.strategy === 'single') {
    const s = plan.single;
    chain = `<div class="pi-chain-row">${s.p0s.map((p0) => `<span>${icon(p0)}${ctx.esc(cName(p0))} <b>${fmtH(s.p0h)}/h</b></span>`).join('')}</div>
      <div class="pi-chain-row">${s.p1s.map((p1) => `<span>${icon(p1)}${ctx.esc(cName(p1))} <b>${fmtH(s.p1h)}/h</b></span>`).join('')}</div>
      <div class="pi-chain-row"><span class="pi-chain-final">${icon(plan.product)}${ctx.esc(cName(plan.product))} <b>${fmtH(s.rate)}/h</b><small>每颗行星</small></span></div>`;
  } else {
    const byTier = new Map();
    const add = (id, rate) => { const t = tierOf(id); if (!byTier.has(t)) byTier.set(t, new Map()); byTier.get(t).set(id, (byTier.get(t).get(id) || 0) + rate); };
    if (plan.strategy === 'extract') add(plan.product, plan.rate);
    else {
      add(plan.product, plan.rate);
      for (const [out, n] of plan.dem.fac) if (out !== plan.product) { const s = D.schemByOut.get(out); add(out, n * plan.rate * perHour(s, s.outQty)); }
      for (const [p1] of plan.extract) add(p1, plan.rate * plan.dem.p1.get(p1));
    }
    chain = [...byTier.keys()].sort().map((t) => `<div class="pi-chain-row"><em>P${t}</em>${[...byTier.get(t)].map(([id, r]) => `<span class="${id === plan.product ? 'pi-chain-final' : ''}">${icon(id)}${ctx.esc(cName(id))} <b>${fmtH(r)}/h</b></span>`).join('')}</div>`).join('');
  }
  const surplus = plan.surplus.length ? `<p class="pi-note">多余的 P1 直接出售：${plan.surplus.map(([id, r]) => `${ctx.esc(cName(id))} ${ctx.formatNumber(Math.round(r * 24))}/天`).join('、')}（已计入收益）</p>` : '';

  // 行星分配
  const roleText = (r) => `${{ single: '单星', extract: '采集', factory: '工厂' }[r.kind]} · ${cName(r.product)}`;
  const tplKey = (r) => r.kind === 'single' ? 'single' : r.kind === 'extract' ? 'extract-' + r.product : 'factory';
  const regionName = (id) => D.regions.find((x) => x.id === id)?.name || '';
  const charBlocks = assign.chars.map((c, ci) => `
    <div class="pi-char">
      <div class="pi-char-head">角色 ${ci + 1}<span>${c.rows.length} / ${F.perChar} 颗</span></div>
      ${c.rows.map((r) => {
        const sec = secInfo(r.at.sys.sec);
        return `<div class="pi-planet">
          <i class="pi-dot" style="--pt:${PLANET_COLORS[r.at.code]}" title="${D.ptByCode[r.at.code].name}"></i>
          <div class="pi-planet-main">
            <b>${ctx.esc(planetName(r.at.sys, r.at.planet))}</b> <span style="color:${sec.color}">${sec.text}</span>
            <small>${D.ptByCode[r.at.code].name} · ${ctx.esc(regionName(r.at.sys.region))}${r.jumps ? ` · 距中心 ${r.jumps} 跳` : r.jumps === 0 ? ' · 中心星系' : ''}</small>
          </div>
          <button type="button" class="pi-role" data-pi-tpl-jump="${tplKey(r)}">${ctx.esc(roleText(r))}</button>
        </div>`;
      }).join('') || '<p class="text-muted">未分配</p>'}
    </div>`).join('');
  const warn = assign.warnings.length ? `<p class="pi-note warn">有 ${assign.warnings.length} 个殖民地找不到合适的行星（同一角色不能在同一颗行星上建两个殖民地），可扩大地区或增加角色。</p>` : '';

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
        <div><span>海关税</span><b>${ctx.formatISK(plan.tax)}</b></div>
        <div class="pi-stat-main"><span>日净收益</span><b>${ctx.formatISK(plan.profit)}</b></div>
        <div><span>月净收益</span><b>${ctx.formatISK(plan.profit * 30)}</b></div>
      </div>
      <h4>生产链</h4>
      <div class="pi-chain">${chain}</div>
      ${surplus}
    </div>
    <div class="pi-card">
      <div class="pi-card-head"><h3>行星分配</h3><span class="text-muted">中心星系 ${ctx.esc(assign.home?.name || '')}，按距离由近到远</span></div>
      ${warn}
      <div class="pi-chars">${charBlocks}</div>
    </div>
    <div class="pi-card">
      <div class="pi-card-head"><h3>殖民地模板</h3><span class="text-muted">指挥中心 ${F.cc} 级 · 同类行星共用一个模板</span></div>
      <div class="pi-tpls">${tplCards}</div>
      <div class="pi-howto">
        <b>导入游戏</b>
        <ol>
          <li>在行星上放置指挥中心并升级到 ${F.cc} 级；</li>
          <li>点「复制模板」，在游戏的行星界面打开「模板」→「导入与导出」→「从剪贴板载入」；</li>
          <li>或点「下载 .json」，把文件放进 <code>文档\\EVE\\PlanetaryInteractionTemplates</code>（使用 OneDrive 时在 <code>OneDrive\\文档\\EVE\\…</code>），在游戏里刷新模板列表；</li>
          <li>放好后给采集控制器摆放采集头、设定采集周期，再提交。</li>
        </ol>
        <p class="pi-note">ESI 只提供读取殖民地的接口，不能把模板写进游戏，所以需要手动导入。模板中的设施会自动换成当前行星对应的类型。</p>
      </div>
    </div>`;
  el.querySelectorAll('[data-pi-thumb]').forEach((c) => drawThumb(c, templates[Number(c.dataset.piThumb)].json));
}

function onResultClick(e) {
  const row = e.target.closest('[data-pi-plan]');
  if (row) {
    R.selected = Number(row.dataset.piPlan);
    $('piResult').querySelectorAll('[data-pi-plan]').forEach((r) => r.classList.toggle('active', r === row));
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
