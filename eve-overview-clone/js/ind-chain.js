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
const S = { loading: null, pi: new Map(), tier: new Map(), ores: new Map(), oreOut: new Map() };   // oreOut：材料 -> 能化出它的矿石

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
        if (!ORE_SKILLS.has(skill)) continue;
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
// needs：材料 -> 数量；rate：化矿率（0–1）。返回 { ores: Map 矿石 -> 数量, unit: Map 材料 -> 化矿单价, cost, extra: Map 副产物, missing: 买不到矿的材料 }
const lpCache = new Map();
export function solveOres(needs, rate) {
  const mats = [...needs.keys()].filter((m) => needs.get(m) > 1e-9);
  const key = rate + '|' + mats.map((m) => m + ':' + Math.round(needs.get(m))).join(',') + '|' + mats.flatMap((m) => S.oreOut.get(m) || []).map((o) => X.matPrice(o) ?? '').join(',');
  if (lpCache.has(key)) return lpCache.get(key);
  const ores = oresFor(mats).filter((o) => (X.matPrice(o) ?? 0) > 0);
  const col = new Map(mats.map((m, j) => [m, j]));
  const missing = new Set(mats.filter((m) => !ores.some((o) => S.ores.get(o).out.some(([id]) => id === m))));
  const use = mats.filter((m) => !missing.has(m));
  const res = { ores: new Map(), unit: new Map(), cost: 0, extra: new Map(), missing };
  if (use.length && ores.length) {
    const nM = mats.length, nO = ores.length;
    // 对偶：max Σ d_j y_j，s.t. 每种矿石 Σ_j a_ij y_j ≤ p_i，y ≥ 0
    const rows = ores.map((o) => {
      const r = new Float64Array(nM + nO + 1);
      for (const [m, q] of S.ores.get(o).out) if (col.has(m) && !missing.has(m)) r[col.get(m)] = q * rate;
      return r;
    });
    ores.forEach((o, i) => { rows[i][nM + i] = 1; rows[i][nM + nO] = X.matPrice(o); });
    const obj = new Float64Array(nM + nO + 1);
    mats.forEach((m, j) => { if (!missing.has(m)) obj[j] = -needs.get(m); });
    const basis = ores.map((_, i) => nM + i);
    for (let iter = 0; iter < 5000; iter++) {
      let enter = -1;
      for (let j = 0; j < nM + nO; j++) if (obj[j] < -1e-9) { enter = j; break; }   // Bland 规则，避免循环
      if (enter < 0) break;
      let leave = -1, best = Infinity;
      for (let i = 0; i < nO; i++) {
        const a = rows[i][enter];
        if (a > 1e-12) { const t = rows[i][nM + nO] / a; if (t < best - 1e-12 || (Math.abs(t - best) <= 1e-12 && basis[i] < basis[leave])) { best = t; leave = i; } }
      }
      if (leave < 0) break;   // 无界（不会出现：每种材料都有矿石能化出）
      const pr = rows[leave], pv = pr[enter];
      for (let j = 0; j <= nM + nO; j++) pr[j] /= pv;
      for (let i = 0; i < nO; i++) {
        if (i === leave) continue;
        const f = rows[i][enter];
        if (f) for (let j = 0; j <= nM + nO; j++) rows[i][j] -= f * pr[j];
      }
      const f = obj[enter];
      for (let j = 0; j <= nM + nO; j++) obj[j] -= f * pr[j];
      basis[leave] = enter;
    }
    // 原问题解：松弛变量在目标行的系数；对偶解：基变量的值
    const y = new Float64Array(nM);
    basis.forEach((b, i) => { if (b < nM) y[b] = rows[i][nM + nO]; });
    let lpCost = 0;
    ores.forEach((o, i) => {
      const x = obj[nM + i];
      if (x <= 1e-9) return;
      const portion = S.ores.get(o).portion;
      const n = Math.ceil(x / portion - 1e-9) * portion;   // 按化矿批量取整
      res.ores.set(o, n);
      res.cost += n * X.matPrice(o);
      lpCost += x * X.matPrice(o);
    });
    const scale = lpCost > 0 ? res.cost / lpCost : 1;   // 取整多花的钱按比例摊到各材料单价
    mats.forEach((m, j) => { if (!missing.has(m)) res.unit.set(m, y[j] * scale); });
    const got = new Map();
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
    g.nodes.set(o, { id: o, kind: 'mine', make: false, need: n, cost: n * (X.matPrice(o) ?? 0), depth });
    for (const x of from) { if (!g.edges.has(x.id)) g.edges.set(x.id, new Set()); g.edges.get(x.id).add(o); }
  }
}
// 按层分列（层 = 离产品的最远距离）；每列按上级在各自列里的平均位置排序，减少连线交叉
function columns(g) {
  const cols = [];
  for (const n of g.nodes.values()) (cols[n.depth] = cols[n.depth] || []).push(n);
  const filled = cols.filter(Boolean);
  const pos = new Map();
  const parents = new Map();
  for (const [p, kids] of g.edges) for (const k of kids) { if (!parents.has(k)) parents.set(k, []); parents.get(k).push(p); }
  filled.forEach((col, ci) => {
    if (ci) {
      const score = (n) => { const ps = (parents.get(n.id) || []).filter((p) => pos.has(p)); return ps.length ? ps.reduce((t, p) => t + pos.get(p), 0) / ps.length : 2; };
      col.sort((a, b) => score(a) - score(b) || b.cost - a.cost);
    }
    col.forEach((n, i) => pos.set(n.id, i / Math.max(1, col.length - 1)));
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
  const head = (i, col) => i === 0 ? '产品' : col.every((n) => n.kind === 'mine') ? '矿石' : `第 ${i} 层`;
  const html = cols.map((col, i) => `<div class="ind-chain-col"><div class="ind-chain-colhead">${head(i, col)}</div>${col.map((n) => `
      <div class="ind-node k-${n.kind || 'leaf'}${n.make ? ' make' : ''}" data-node="${n.id}">
        <div class="ind-node-top"><img src="${X.ICON(n.id)}" data-item-pop="${n.id}" alt="" width="22" height="22" loading="lazy"><span class="ind-node-name" title="${esc(X.tName(n.id))}">${esc(X.tName(n.id))}</span><small class="ind-node-tag">${tag(n)}</small></div>
        <div class="ind-node-bot"><b>${num(Math.ceil(n.need - 1e-9))}</b><span>${isk(n.cost)}</span>${btn(n)}</div>
      </div>`).join('')}</div>`).join('');
  const notes = [];
  if (lp?.ores.size) notes.push(`化矿按${X.F.mat === 'buy' ? '收单' : '卖单'}价找最便宜的矿石组合，化矿率 ${reproc}%`);
  if (lp?.extra.size) notes.push('多出：' + [...lp.extra].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, q]) => `${esc(X.tName(m))} ${num(q)}`).join('、'));
  if (lp?.missing.size) notes.push('买不到矿石、按市价买：' + [...lp.missing].map((m) => esc(X.tName(m))).join('、'));
  return `<div class="pi-card ind-chain">
    <div class="pi-card-head"><h3>生产链</h3>
      <span class="ind-mat-bulk"><button type="button" class="btn btn-ghost" data-ind-deep="none">全部购买</button><button type="button" class="btn btn-ghost" data-ind-deep="bp">推到蓝图底层</button><button type="button" class="btn btn-ghost" data-ind-deep="all">推到矿石和 P0</button></span>
      <label class="pi-inline ind-reproc"><span>化矿率</span><input type="number" class="pi-input pi-tax" min="30" max="100" step="0.1" value="${reproc}" data-ind-num="reproc"><span>%</span></label></div>
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
