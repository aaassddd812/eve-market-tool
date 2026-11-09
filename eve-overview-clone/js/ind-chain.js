// ===== 制造：生产链（一路推到矿石与 P0）与层次图 =====
// 蓝图（制造 / 反应）之外再往下推两条链，计算器材料「自制」时按 industry.js 的 buildCost 逐级展开：
//   行星产品：pi-data.json 的工厂配方，P4 → P3 → P2 → P1 → P0（P0 没有配方，按市价或自己采）
//   矿物 / 卫星矿物 / 冰矿产物：reprocess-data.json 的化矿产出反推矿石。一种矿物可从多种矿石来、一种矿石又出多种矿物，
//     所以把所有「化矿」的材料合在一起解线性规划：最少花多少钱买矿石，化出来的每种材料都够用。
//     用对偶单纯形（变量少、约束都是 ≤ 价格，初始解就可行），对偶解就是每种材料的「化矿单价」，原问题解是各矿石数量；
//     矿石数量按化矿批量（portion）向上取整，多出来的副产物单列。化矿率统一按设置里的百分比（建筑、改装件、技能后的实际值）。
// 层次图：每种物品一个方块（同一物品多处用到时合并），按离产品的最远层数分列，连线表示「谁用到谁」；点方块的按钮切换买 / 造。
let X = null;   // industry.js 传入：ctx, BP, T, tName, matPrice, ICON, F

const ORE_SKILLS = new Set([60377, 60378, 60379, 60380, 60381, 46152, 46153, 46154, 46155, 46156, 18025, 12189]);
const S = { loading: null, pi: new Map(), tier: new Map(), ores: new Map(), oreOut: new Map(), depth: new Map() };   // oreOut：材料 -> 能化出它的矿石；depth：矿石的卖单分档

export function initChain(x) { X = x; }

export function loadChain() {
  if (!S.loading) {
    S.loading = Promise.all([
      fetch('pi-data.json?v=2').then((r) => (r.ok ? r.json() : Promise.reject(new Error('pi-data.json ' + r.status)))),
      fetch('reprocess-data.json?v=1').then((r) => (r.ok ? r.json() : Promise.reject(new Error('reprocess-data.json ' + r.status))))
    ]).then(([pi, rp]) => {
      for (const [, , out, outQty, inputs] of pi.schematics) S.pi.set(out, { outQty, inputs });
      for (const [id, c] of Object.entries(pi.commodities)) S.tier.set(Number(id), c[2]);
      for (const [id, [portion, skill, mats]] of Object.entries(rp.t)) {
        // 化矿批量为 1 的非冰矿是压矿改版前的「聚合高密度」批量压缩矿：市场上没有交易量，不参与选矿
        if (!ORE_SKILLS.has(skill) || (portion === 1 && skill !== 18025)) continue;
        const out = [];
        for (let i = 0; i < mats.length; i += 2) out.push([mats[i], mats[i + 1] / portion]);
        S.ores.set(Number(id), { portion, out });
        for (const [m] of out) { if (!S.oreOut.has(m)) S.oreOut.set(m, []); S.oreOut.get(m).push(Number(id)); }
      }
    }).catch((e) => { S.loading = null; throw e; });
  }
  return S.loading;
}
export const chainReady = () => S.ores.size > 0;

// 能往下推的方式：bp 蓝图、pi 行星配方、ore 化矿；都不能就是 null（只能买，或 P0 自己采）
export function kindOf(id) {
  if (X.BP(id)) return 'bp';
  if (S.pi.has(id)) return 'pi';
  if (S.oreOut.has(id)) return 'ore';
  return null;
}
export const piRecipe = (id) => S.pi.get(id);
export const piTier = (id) => S.tier.get(id);
// 价格要预读的矿石：能化出这些材料的全部矿石
export function oresFor(ids) {
  const out = new Set();
  for (const id of ids) for (const o of S.oreOut.get(id) || []) out.add(o);
  return [...out];
}

// ---------- 最便宜的矿石组合 ----------
// needs：材料 -> 数量；rate：化矿率（0–1）。
// 买卖单价（材料按卖单买）时，读过交易中心卖单的矿石按实际挂单计价（setDepth）：挂单按价格分成几档，每档最多买这档的挂单量，
//   便宜的买完再买贵的，市场上没有这么多矿就不会选它；还没读过挂单的矿石先按最低卖价、数量不限，解出来用到的矿石列在 needDepth，
//   读完挂单后重解（industry.js）。材料按收单买时（自己挂收单）不限数量。
// 每种材料还可以直接按市价买（不限数量）：矿石不够、或化矿比直接买还贵时就直接买，数量记在 direct。
// 运费（F.oreM3，ISK/m³）：每件矿石、直接买的材料按包装体积加运费再比价（压缩矿体积小，运费高时会优先选），花费里含运费。
// 线性规划：min Σ 价格·买入量，s.t. 每种材料化出的量 ≥ 需求，0 ≤ 每档买入量 ≤ 挂单量。解它的对偶（约束都是 ≤ 价格，初始解可行）：
//   max Σ 需求·y − Σ 挂单量·z，s.t. 每一档 Σ 化出量·y − z ≤ 价格；y 是每种材料的「化矿单价」，原问题的解是松弛变量的检验数。
// 返回 { ores: Map 矿石 -> 数量, oreCost: Map 矿石 -> 花费, unit: Map 材料 -> 单价, cost, extra: Map 副产物, missing: 没有矿石能化出的材料,
//   direct: Map 材料 -> 直接买的数量, needDepth: 还没读挂单的矿石, depth: 是否按挂单计价, m3: 总体积, freight: 运费 }
const DEPTH_TIERS = 8;
const lpCache = new Map();
let depthVer = 0;
// 交易中心卖单 [[价格, 数量]…]（任意顺序）；null = 读不到，按最低卖价、数量不限
export function setDepth(id, orders) {
  if (!orders) { S.depth.set(id, null); depthVer++; return; }
  const list = orders.filter(([p, v]) => p > 0 && v > 0).sort((a, b) => a[0] - b[0]);
  const total = list.reduce((t, [, v]) => t + v, 0);
  const tiers = [];
  let cur = null;
  for (const [p, v] of list) {
    if (!cur) cur = { cost: 0, vol: 0 };
    cur.cost += p * v; cur.vol += v;
    if (cur.vol >= total / DEPTH_TIERS && tiers.length < DEPTH_TIERS - 1) { tiers.push([cur.cost / cur.vol, cur.vol]); cur = null; }
  }
  if (cur) tiers.push([cur.cost / cur.vol, cur.vol]);
  S.depth.set(id, { tiers, total });
  depthVer++;
}
export const hasDepth = (id) => S.depth.has(id);
export const depthTotal = (id) => S.depth.get(id)?.total ?? null;

export function solveOres(needs, rate) {
  const mats = [...needs.keys()].filter((m) => needs.get(m) > 1e-9);
  const useDepth = X.F.mat !== 'buy';
  const perM3 = Math.max(0, X.F.oreM3 || 0);
  const vol = (id) => (perM3 ? X.vol(id) || 0 : 0);
  const key = rate + '|' + useDepth + '|' + depthVer + '|' + perM3 + ':' + X.volReady() + '|' + mats.map((m) => m + ':' + Math.round(needs.get(m)) + ':' + (X.matPrice(m) ?? '')).join(',') + '|' + mats.flatMap((m) => S.oreOut.get(m) || []).map((o) => X.matPrice(o) ?? '').join(',');
  if (lpCache.has(key)) return lpCache.get(key);
  // 每一档：[矿石, 单价, 挂单量（Infinity = 不限）]
  const tiers = [];
  for (const o of oresFor(mats)) {
    const d = useDepth ? S.depth.get(o) : undefined;
    if (d) for (const [p, v] of d.tiers) tiers.push([o, p, v]);
    else if (d === undefined || d === null) { const p = X.matPrice(o); if (p > 0) tiers.push([o, p, Infinity]); }
  }
  const col = new Map(mats.map((m, j) => [m, j]));
  const missing = new Set(mats.filter((m) => !tiers.some(([o]) => S.ores.get(o).out.some(([id]) => id === m))));
  const res = { ores: new Map(), oreCost: new Map(), unit: new Map(), cost: 0, extra: new Map(), missing, direct: new Map(), needDepth: [], depth: useDepth, m3: 0, freight: 0 };
  const use = mats.filter((m) => !missing.has(m));
  if (use.length) {
    // 直接买材料的一行（价格 = 市价；没有市价的给一个很高的价，只在矿石不够时用）
    const direct = use.map((m) => [m, X.matPrice(m) > 0 ? X.matPrice(m) : 1e9]);
    const nM = mats.length, nR = tiers.length + direct.length;
    const capped = tiers.map((t, i) => (Number.isFinite(t[2]) ? i : -1)).filter((i) => i >= 0);
    const zCol = new Map(capped.map((i, k) => [i, nM + k]));
    const nZ = capped.length, W = nM + nZ + nR;   // 列：y | z | 松弛 | 右端
    const rows = [];
    tiers.forEach(([o, p], i) => {
      const r = new Float64Array(W + 1);
      for (const [m, q] of S.ores.get(o).out) if (col.has(m) && !missing.has(m)) r[col.get(m)] = q * rate;
      if (zCol.has(i)) r[zCol.get(i)] = -1;
      r[nM + nZ + i] = 1; r[W] = p + perM3 * vol(o);
      rows.push(r);
    });
    direct.forEach(([m, p], k) => {
      const r = new Float64Array(W + 1);
      r[col.get(m)] = 1; r[nM + nZ + tiers.length + k] = 1; r[W] = p + perM3 * vol(m);
      rows.push(r);
    });
    const obj = new Float64Array(W + 1);
    mats.forEach((m, j) => { if (!missing.has(m)) obj[j] = -needs.get(m); });
    capped.forEach((i, k) => { obj[nM + k] = tiers[i][2]; });
    const basis = rows.map((_, i) => nM + nZ + i);
    for (let iter = 0; iter < 20000; iter++) {
      let enter = -1;
      for (let j = 0; j < W; j++) if (obj[j] < -1e-9) { enter = j; break; }   // Bland 规则，避免循环
      if (enter < 0) break;
      let leave = -1, best = Infinity;
      for (let i = 0; i < nR; i++) {
        const a = rows[i][enter];
        if (a > 1e-12) { const t = rows[i][W] / a; if (t < best - 1e-12 || (Math.abs(t - best) <= 1e-12 && basis[i] < basis[leave])) { best = t; leave = i; } }
      }
      if (leave < 0) break;   // 无界（不会出现：每种材料都能直接买）
      const pr = rows[leave], pv = pr[enter];
      for (let j = 0; j <= W; j++) pr[j] /= pv;
      for (let i = 0; i < nR; i++) {
        if (i === leave) continue;
        const f = rows[i][enter];
        if (f) for (let j = 0; j <= W; j++) rows[i][j] -= f * pr[j];
      }
      const f = obj[enter];
      for (let j = 0; j <= W; j++) obj[j] -= f * pr[j];
      basis[leave] = enter;
    }
    // 原问题解：松弛变量在目标行的系数；对偶解：基变量的值
    const y = new Float64Array(nM);
    basis.forEach((b, i) => { if (b < nM) y[b] = rows[i][W]; });
    const bought = new Map();   // 矿石 -> [数量, 花费, 用到的最高单价]
    tiers.forEach(([o, p], i) => {
      const x = obj[nM + nZ + i];
      if (x <= 1e-9) return;
      const b = bought.get(o) || [0, 0, 0];
      bought.set(o, [b[0] + x, b[1] + x * p, Math.max(b[2], p)]);
    });
    let lpCost = 0;
    for (const [o, [x, cost, top]] of bought) {
      const portion = S.ores.get(o).portion;
      const n = Math.ceil(x / portion - 1e-9) * portion;   // 按化矿批量取整，多买的按用到的最高单价算
      const c = cost + (n - x) * top;
      res.ores.set(o, n); res.oreCost.set(o, c);
      res.cost += c; lpCost += cost + x * perM3 * vol(o);
      res.m3 += n * (X.vol(o) || 0);
      if (useDepth && S.depth.get(o) === undefined) res.needDepth.push(o);
    }
    direct.forEach(([m, p], k) => {
      const x = obj[nM + nZ + tiers.length + k];
      if (x > 1e-6) { const n = Math.ceil(x - 1e-6); res.direct.set(m, n); res.cost += n * p; lpCost += x * (p + perM3 * vol(m)); res.m3 += n * (X.vol(m) || 0); }
    });
    res.freight = res.m3 * perM3;
    res.cost += res.freight;
    const scale = lpCost > 0 ? res.cost / lpCost : 1;   // 取整多花的钱按比例摊到各材料单价
    mats.forEach((m, j) => { if (!missing.has(m)) res.unit.set(m, y[j] * scale); });
    const got = new Map(res.direct);
    for (const [o, n] of res.ores) for (const [m, q] of S.ores.get(o).out) got.set(m, (got.get(m) || 0) + n * q * rate);
    for (const [m, q] of got) { const left = q - (needs.get(m) || 0); if (left >= 1) res.extra.set(m, Math.floor(left)); }
  }
  lpCache.set(key, res);
  if (lpCache.size > 50) lpCache.delete(lpCache.keys().next().value);
  return res;
}
// 矿石 o 能化出材料 m 吗（层次图连线用）
export const oreYields = (o, m) => S.ores.get(o)?.out.some(([id]) => id === m) || false;

// ---------- 层次图 ----------
// G：{ root, nodes: Map id -> { id, kind, make, need, cost, depth, mined }, edges: Map 上级 -> Set 下级 }
export function newGraph(root, out, cost) {
  const g = { root, nodes: new Map(), edges: new Map() };
  g.nodes.set(root, { id: root, kind: 'bp', make: true, need: out, cost, depth: 0 });
  return g;
}
export function addEdge(g, parent, id, units, cost, depth, kind, make) {
  let n = g.nodes.get(id);
  if (!n) { n = { id, kind, make, need: 0, cost: 0, depth }; g.nodes.set(id, n); }
  n.need += units; n.cost += cost; n.depth = Math.max(n.depth, depth);
  if (!g.edges.has(parent)) g.edges.set(parent, new Set());
  g.edges.get(parent).add(id);
}
// 化矿结果接到图上：矿石放在用到它的材料的下一层
export function addOres(g, lp) {
  for (const [o, n] of lp.ores) {
    const from = [...g.nodes.values()].filter((x) => x.kind === 'ore' && x.make && oreYields(o, x.id));
    const depth = Math.max(0, ...from.map((x) => x.depth)) + 1;
    g.nodes.set(o, { id: o, kind: 'mine', make: false, need: n, cost: lp.oreCost.get(o) ?? n * (X.matPrice(o) ?? 0), depth });
    for (const x of from) { if (!g.edges.has(x.id)) g.edges.set(x.id, new Set()); g.edges.get(x.id).add(o); }
  }
}
// 按层分列：先按离产品的最远距离分层，再把同一类的物品（同级行星产品、矿物、矿石、只能买的材料）拉到同一列（取这一类里最深的一层），
// 下级始终在上级右边；每列里按类型分组（蓝图组件按物品分组），组内按上级在各自列里的平均位置排序，减少连线交叉
function groupOf(g, n) {
  if (n.id === g.root) return 'root';
  if (n.kind === 'mine') return 'mine';
  if (n.kind === 'pi' || (!n.kind && piTier(n.id) === 0)) return 'pi' + piTier(n.id);
  if (n.kind === 'ore') return 'mat';
  if (!n.kind) return 'leaf';
  return null;   // 蓝图组件按层数自然排
}
const GROUP_ORDER = ['root', 'bp', 'pi4', 'pi3', 'pi2', 'pi1', 'pi0', 'mat', 'leaf', 'mine'];
function columns(g) {
  const depth = new Map([...g.nodes.values()].map((n) => [n.id, n.depth]));
  const groups = new Map();
  for (const n of g.nodes.values()) { const k = groupOf(g, n); if (k && k !== 'root') { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n.id); } }
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (const ids of groups.values()) {
      const d = Math.max(...ids.map((id) => depth.get(id)));
      for (const id of ids) if (depth.get(id) < d) { depth.set(id, d); moved = true; }
    }
    for (const [p, kids] of g.edges) for (const k of kids) if (depth.has(p) && depth.has(k) && depth.get(k) <= depth.get(p)) { depth.set(k, depth.get(p) + 1); moved = true; }
    if (!moved) break;
  }
  const cols = [];
  for (const n of g.nodes.values()) (cols[depth.get(n.id)] = cols[depth.get(n.id)] || []).push(n);
  const filled = cols.filter(Boolean);
  const pos = new Map();
  const parents = new Map();
  for (const [p, kids] of g.edges) for (const k of kids) { if (!parents.has(k)) parents.set(k, []); parents.get(k).push(p); }
  const rank = (n) => { const k = groupOf(g, n) || 'bp'; return GROUP_ORDER.indexOf(k) * 1e6 + (k === 'bp' ? X.T(n.id)[2] || 0 : 0); };
  filled.forEach((col, ci) => {
    const score = (n) => { const ps = (parents.get(n.id) || []).filter((p) => pos.has(p)); return ps.length ? ps.reduce((t, p) => t + pos.get(p), 0) / ps.length : 2; };
    if (ci) col.sort((a, b) => rank(a) - rank(b) || score(a) - score(b) || b.cost - a.cost);
    col.forEach((n, i) => pos.set(n.id, i / Math.max(1, col.length - 1)));
    col.forEach((n) => { n.col = groupOf(g, n) || 'bp'; });
  });
  return filled;
}

const KIND_LABEL = { bp: '蓝图', pi: '行星', ore: '矿物', mine: '矿石' };
export function graphHtml(g, { reproc, lp }) {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const cols = columns(g);
  const btn = (n) => {
    if (n.id === g.root || n.kind === 'mine') return '';
    if (!n.kind) return '';
    const label = n.make ? (n.kind === 'ore' ? '化矿' : '自制') : '购买';
    return `<button type="button" class="ind-node-btn${n.make ? ' on' : ''}" data-ind-build="${n.id}" title="${n.make ? '改为直接购买' : n.kind === 'ore' ? '改为买矿石化矿' : '改为自己造'}">${label}</button>`;
  };
  const tag = (n) => {
    if (n.id === g.root) return '产品';
    if (n.kind === 'pi') return 'P' + (piTier(n.id) ?? '');
    if (n.kind === 'bp') return X.BP(n.id)[5] === 'r' ? '反应' : '制造';
    if (!n.kind && piTier(n.id) === 0) return 'P0';
    return KIND_LABEL[n.kind] || '材料';
  };
  const GROUP_LABEL = { mine: '矿石', mat: '矿物', leaf: '购买', pi4: 'P4', pi3: 'P3', pi2: 'P2', pi1: 'P1', pi0: 'P0' };
  const head = (i, col) => {
    if (i === 0) return '产品';
    const ks = [...new Set(col.map((n) => n.col))];
    return ks.length === 1 && GROUP_LABEL[ks[0]] ? GROUP_LABEL[ks[0]] : `第 ${i} 层`;
  };
  const html = cols.map((col, i) => `<div class="ind-chain-col"><div class="ind-chain-colhead">${head(i, col)}</div>${col.map((n, j) => `
      <div class="ind-node k-${n.kind || 'leaf'}${n.make ? ' make' : ''}${j && col[j - 1].col !== n.col ? ' grp' : ''}" data-node="${n.id}">
        <div class="ind-node-top"><img src="${X.ICON(n.id)}" data-item-pop="${n.id}" alt="" width="22" height="22" loading="lazy"><span class="ind-node-name" title="${esc(X.tName(n.id))}">${esc(X.tName(n.id))}</span><small class="ind-node-tag">${tag(n)}</small></div>
        <div class="ind-node-bot"><b>${num(Math.ceil(n.need - 1e-9))}</b><span>${isk(n.cost)}</span>${btn(n)}</div>
      </div>`).join('')}</div>`).join('');
  const notes = [];
  if (lp?.ores.size) notes.push(lp.depth ? `化矿按${X.HUB}卖单的实际挂单量找最便宜的矿石组合（便宜的挂单买完再买贵的），化矿率 ${reproc}%` : `化矿按收单价找最便宜的矿石组合，化矿率 ${reproc}%`);
  if (lp?.needDepth.length) notes.push('正在读取矿石挂单…');
  if (lp?.m3 && X.F.oreM3) notes.push(`运输 ${num(Math.round(lp.m3))} m³，运费 ${isk(lp.freight)}（已计入成本）`);
  if (lp?.direct.size) notes.push('直接买（矿石不够或化矿更贵）：' + [...lp.direct].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, q]) => `${esc(X.tName(m))} ${num(q)}`).join('、'));
  if (lp?.extra.size) notes.push('多出：' + [...lp.extra].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, q]) => `${esc(X.tName(m))} ${num(q)}`).join('、'));
  if (lp?.missing.size) notes.push('买不到矿石、按市价买：' + [...lp.missing].map((m) => esc(X.tName(m))).join('、'));
  return `<div class="pi-card ind-chain">
    <div class="pi-card-head"><h3>生产链</h3>
      <span class="ind-mat-bulk"><button type="button" class="btn btn-ghost" data-ind-deep="none">全部购买</button><button type="button" class="btn btn-ghost" data-ind-deep="bp">推到蓝图底层</button><button type="button" class="btn btn-ghost" data-ind-deep="all">推到矿石和 P0</button></span>
      <label class="pi-inline ind-reproc"><span>化矿率</span><input type="number" class="pi-input pi-tax" min="30" max="100" step="0.1" value="${reproc}" data-ind-num="reproc"><span>%</span></label>
      <label class="pi-inline ind-reproc" title="买矿石、矿物运到化矿 / 制造地点的运费，按包装体积计；0 表示不计。运费高时会优先选压缩矿"><span>运费</span><input type="number" class="pi-input pi-tax" min="0" step="10" value="${X.F.oreM3 || 0}" data-ind-num="oreM3"><span>ISK/m³</span></label></div>
    <div class="ind-chain-wrap"><svg class="ind-chain-lines" aria-hidden="true"></svg><div class="ind-chain-cols">${html}</div></div>
    ${notes.length ? `<p class="pi-note">${notes.join(' · ')}</p>` : ''}
  </div>`;
}

// 连线：上级方块右边中点 → 下级方块左边中点（布局完成后量位置再画）
export function drawLines(root, g) {
  const wrap = root.querySelector('.ind-chain-wrap');
  const svg = wrap?.querySelector('.ind-chain-lines');
  if (!svg) return;
  const box = wrap.getBoundingClientRect();
  const at = new Map([...wrap.querySelectorAll('[data-node]')].map((el) => [Number(el.dataset.node), el.getBoundingClientRect()]));
  const w = wrap.scrollWidth, h = wrap.scrollHeight;
  svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const paths = [];
  for (const [p, kids] of g.edges) {
    const a = at.get(p);
    if (!a) continue;
    for (const k of kids) {
      const b = at.get(k);
      if (!b || b.left <= a.left) continue;
      const x1 = a.right - box.left + wrap.scrollLeft, y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left + wrap.scrollLeft, y2 = b.top + b.height / 2 - box.top;
      const mx = (x1 + x2) / 2;
      const make = g.nodes.get(k)?.make || g.nodes.get(k)?.kind === 'mine';
      paths.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="${make ? 'on' : ''}"/>`);
    }
  }
  svg.innerHTML = paths.join('');
}
