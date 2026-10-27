// 制造页的扩展功能（由 industry.js 调用，复用它的计算函数）：
// 计算器里的「解码器对比」（每种解码器的总成本 / 利润，标出最优）与「发明次数」（按二项分布，约 95% 把握拿到所需拷贝要发明几次）、
//   「材料效率影响」（ME 0–10 的成本与利润）、「研究与拷贝」（ME / TE 研究到目标等级、拷贝的时间与费用，以及研究后每流程省多少、几个流程回本）；
// 「制造规划」页：多个产品一起规划——组件可选自制并逐级展开汇总，扣除库存（ESI 资产或粘贴），产线启动清单（每个任务的流程数与时间），
//   按制造 / 反应产线数排出的时间轴，购物清单可复制；「库存可造」按现有材料反推能造什么（工业清库）；
// 「我的工业」蓝图的成本与每小时利润、一键加入规划；利润排行的「技能够造」「我有蓝图」筛选。
// 研究公式：第 n 级时间 = 蓝图基础研究时间 × 等级倍数[n] ÷ 105（倍数 105、250、595、1414、3360、8000、19000、45255、107700、256000），
//   技能冶金学（ME）/ 研究（TE）/ 科学（拷贝）每级 −5%、高级工业理论每级 −3%，工程复合体同制造的时间加成；
//   费用按产品 EIV × 2% × 时间倍数 ×（研究 / 拷贝指数 × (1 − 建筑减免) + 设施税 + 4% SCC）估算。
let X = null;   // industry.js 传入：ctx, D, F, C, BP, T, tName, invFor, job, invention, calc, matPrice, matFee, prodPrice, sellFee, loadJita, fmtTime, lvl, facilityFor, facTax, SCC, ICON, BP_ICON, selectProduct, renderTab, save, sysSec, secMul
const PLAN_KEY = 'eve-industry-plan';
const LEVEL_MUL = [0, 105, 250, 595, 1414, 3360, 8000, 19000, 45255, 107700, 256000];
const SK = { science: 3402, research: 3403, metallurgy: 3409, advIndustry: 3388 };
const P = { items: [], build: [], slots: 10, rslots: 10, lanes: 'manual', stock: 'none', paste: '', tab: 'plan' };
const FOLD = {};   // 计算器里折叠卡片的展开状态（本次会话内）
const S = { assets: null, assetsErr: null, assetsBusy: false, owned: null, ownedLoading: null, chars: null, charsLoading: null };   // chars：按人物分配产线时各角色的产线数与进行中的任务

export function initPlan(api) {
  X = api;
  Object.assign(P, X.ctx.store.getJSON(PLAN_KEY, {}) || {});
  P.items = (P.items || []).filter((it) => X.BP(it.pid));
}
const savePlan = () => X.ctx.store.setJSON(PLAN_KEY, { items: P.items, build: P.build, slots: P.slots, rslots: P.rslots, lanes: P.lanes, stock: P.stock, paste: P.paste, tab: P.tab });
export const planCount = () => P.items.length;

export function addToPlan(pid, { runs = 1, me = null, te = null, invent = null, dec = 0 } = {}) {
  const b = X.BP(pid);
  if (!b) return;
  const inv = b[5] === 'm' && X.invFor(pid);
  P.items.push({ pid, runs: Math.max(1, runs), me: b[5] === 'r' ? 0 : me ?? (inv && invent !== false ? null : X.F.me), te: b[5] === 'r' ? 0 : te ?? (inv && invent !== false ? null : X.F.te), invent: inv ? invent !== false : false, dec });
  savePlan();
  X.ctx.showToast(`已加入制造规划：${X.tName(pid)} ×${runs} 流程（共 ${P.items.length} 项）`, 'success', 2200);
}

// 用计算器同一套逻辑算一个产品（临时替换计算器状态）
function quote(pid, { runs, me = null, te = null, invent = true, dec = 0, build = null }) {
  const C = X.C;
  const keep = { pid: C.pid, runs: C.runs, me: C.me, te: C.te, invent: C.invent, dec: C.dec, build: C.build, bpMode: C.bpMode };
  Object.assign(C, { pid, runs, me, te, invent, dec, build: build ? new Set(build) : new Set(), bpMode: null });
  try { return X.calc(); } finally { Object.assign(C, keep); }
}

// ---------- 计算器扩展 ----------
// 至少 k 次成功、把握 conf 时需要的尝试次数（二项分布）
function attemptsFor(k, p, conf = 0.95) {
  if (p >= 1) return k;
  if (p <= 0) return Infinity;
  for (let n = k; n < k / p * 6 + 50; n++) {
    // P(X < k) = Σ_{i<k} C(n,i) p^i (1−p)^(n−i)，用对数递推避免溢出
    let logPmf = n * Math.log(1 - p), below = 0;
    for (let i = 0; i < k; i++) {
      below += Math.exp(logPmf);
      logPmf += Math.log((n - i) / (i + 1)) + Math.log(p / (1 - p));
    }
    if (1 - below >= conf) return n;
  }
  return Math.ceil(k / p * 2);
}

export function calcExtrasHtml(r) {
  return [r.inv ? decryptorHtml(r) : '', meHtml(r), researchHtml(r)].join('');
}

function decryptorHtml(r) {
  const { esc, formatISK: isk } = X.ctx;
  const ids = [0, ...Object.keys(X.D.data.decryptors).map(Number)];
  const rows = ids.map((dec) => {
    const q = quote(r.pid, { runs: r.runs, invent: true, dec, build: [...X.C.build] });
    const hours = q.j.secs / 3600;
    return { dec, q, ph: hours ? q.profit / hours : 0 };
  });
  const best = rows.reduce((a, b) => (b.q.profit > a.q.profit ? b : a));
  const bestPh = rows.reduce((a, b) => (b.ph > a.ph ? b : a));
  // 发明次数：要造 r.runs 个流程需要几份拷贝
  const inv = r.inv;
  const copies = Math.ceil(r.runs / inv.runs);
  const expect = Math.ceil(copies / inv.prob);
  const n95 = attemptsFor(copies, inv.prob);
  return `<div class="pi-card"><div class="pi-card-head"><h3>解码器对比</h3><span class="text-muted">按 ${r.runs} 个流程</span></div>
    <div class="pi-table-wrap"><table class="pi-table ind-dec-table"><thead><tr><th>解码器</th><th class="num">成功率</th><th class="num">拷贝流程</th><th class="num">ME / TE</th><th class="num pi-hide-sm">发明 / 流程</th><th class="num">单个成本</th><th class="num">总利润</th><th class="num pi-hide-sm">每小时利润</th><th></th></tr></thead><tbody>
    ${rows.map(({ dec, q, ph }) => `<tr class="${dec === X.C.dec ? 'active' : ''}">
      <td>${dec ? esc(X.tName(dec)) : '不使用'}${dec === best.dec ? ' <span class="ind-best">利润最高</span>' : ''}${dec === bestPh.dec && bestPh.dec !== best.dec ? ' <span class="ind-best">每小时最高</span>' : ''}</td>
      <td class="num">${(q.inv.prob * 100).toFixed(1)}%</td><td class="num">${q.inv.runs}</td><td class="num">${q.me} / ${q.te}</td>
      <td class="num pi-hide-sm">${isk(q.inv.perRun)}</td><td class="num">${isk(q.perUnit)}</td>
      <td class="num ${q.profit >= 0 ? 'up' : 'down'}">${isk(q.profit)}</td><td class="num pi-hide-sm">${isk(ph)}</td>
      <td>${dec === X.C.dec ? '<span class="text-muted">当前</span>' : `<button type="button" class="link-btn" data-plan-dec="${dec}">使用</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="pi-note">需 ${copies} 份拷贝，平均发明 ${expect} 次；95% 把握开 <b>${Number.isFinite(n95) ? n95 : '—'}</b> 次发明
      （${inv.dcs.map(([id, q]) => esc(X.tName(id)) + ' ×' + X.ctx.formatNumber(q * (Number.isFinite(n95) ? n95 : expect))).join('、')}${X.C.dec ? `，解码器 ×${Number.isFinite(n95) ? n95 : expect}` : ''}）</p></div>`;
}

function meHtml(r) {
  if (r.act !== 'm') return '';
  const { formatISK: isk } = X.ctx;
  const fee = 1 + X.matFee() / 100;
  const unit = X.prodPrice(r.pid) ?? 0;
  // 材料数量每个流程至少 1 个、按整批取整，流程数太少时看不出 ME 差别：至少按 10 个流程算
  const runs = Math.max(r.runs, 10), k = runs / r.runs;
  const rows = [];
  for (let me = 0; me <= 10; me++) {
    const j = X.job(r.pid, runs, me, r.te);
    const mats = j.items.reduce((t, it) => t + it.qty * (X.matPrice(it.id) ?? 0) * fee, 0);
    const total = mats + j.cost + (r.invCost + r.bpCost) * k;
    rows.push({ me, mats, total, profit: unit * j.out * (1 - X.sellFee() / 100) - total, out: j.out });
  }
  const base = rows[r.me]?.total ?? rows[0].total;
  return `<details class="pi-card ind-fold"${FOLD.me ? ' open' : ''} data-plan-fold="me"><summary><h3>材料效率影响</h3><span class="text-muted">按 ${runs} 个流程</span></summary>
    <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>ME</th><th class="num">材料费</th><th class="num">单个成本</th><th class="num">总利润</th><th class="num">比当前</th></tr></thead><tbody>
    ${rows.map((x) => `<tr class="${x.me === r.me ? 'active' : ''}"><td>${x.me}</td><td class="num">${isk(x.mats)}</td><td class="num">${isk(x.total / x.out)}</td><td class="num ${x.profit >= 0 ? 'up' : 'down'}">${isk(x.profit)}</td>
      <td class="num">${x.me === r.me ? '当前' : Math.abs(base - x.total) < 1 ? '—' : (base - x.total > 0 ? '省 ' : '多 ') + isk(Math.abs(base - x.total))}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

// 研究 / 拷贝的时间与费用
function scienceJob(pid, kind, mulSum) {
  const b = X.BP(pid);
  const res = X.D.data.res?.[b[0]];
  if (!res) return null;
  const fac = X.facilityFor('m');
  const eiv = b[3].reduce((t, [id, q]) => t + q * (X.D.adjusted.get(id) || 0), 0);
  const idxKey = { me: 'researching_material_efficiency', te: 'researching_time_efficiency', copy: 'copying' }[kind];
  const idx = (X.D.indices.get(X.F.sys) || {})[idxKey] || 0;
  const skill = kind === 'me' ? SK.metallurgy : kind === 'te' ? SK.research : SK.science;
  const timeMul = (1 - 0.05 * X.lvl(skill)) * (1 - 0.03 * X.lvl(SK.advIndustry)) * (1 - fac.te / 100);
  const base = kind === 'me' ? res[0] : kind === 'te' ? res[1] : res[2];
  const secs = base * mulSum * timeMul;
  const cost = eiv * 0.02 * mulSum * (idx * (1 - fac.cost / 100) + (X.facTax('m') + X.SCC) / 100);
  return { secs, cost, idx };
}
const levelSum = (from, to) => { let s = 0; for (let n = from + 1; n <= to; n++) s += LEVEL_MUL[n] / 105; return s; };

function researchHtml(r) {
  // 发明来的 T2 拷贝不能研究，只对原图显示
  if (r.act !== 'm' || r.inv || !X.D.data.res?.[X.BP(r.pid)[0]]) return '';
  const { formatISK: isk, formatNumber: num } = X.ctx;
  const R = X.C.research || (X.C.research = { me: 10, te: 20, copies: 1, runs: null });
  const curMe = Math.min(10, r.me), curTe = Math.min(20, r.te);
  const tme = Math.max(curMe, Math.min(10, R.me)), tte = Math.max(curTe, Math.min(20, R.te));
  const me = scienceJob(r.pid, 'me', levelSum(curMe, tme));
  const te = scienceJob(r.pid, 'te', levelSum(curTe / 2, tte / 2));
  const maxRuns = X.BP(r.pid)[4];
  const cruns = Math.max(1, Math.min(maxRuns, R.runs ?? maxRuns));
  const cp = scienceJob(r.pid, 'copy', cruns * R.copies);
  // 研究后每流程省下的材料费（全部购买口径）
  const fee = 1 + X.matFee() / 100;
  const perRunMats = (meLv) => X.job(r.pid, 100, meLv, r.te).items.reduce((t, it) => t + it.qty * (X.matPrice(it.id) ?? 0) * fee, 0) / 100;
  const save = perRunMats(curMe) - perRunMats(tme);
  const payback = save > 0 ? Math.ceil(me.cost / save) : null;
  return `<details class="pi-card ind-fold"${FOLD.research ? ' open' : ''} data-plan-fold="research"><summary><h3>研究与拷贝</h3><span class="text-muted">${X.F.fac === 'npc' ? 'NPC 空间站' : X.ctx.esc(X.D.data.structures[X.F.fac])}</span></summary>
    <div class="ind-research">
      <div class="ind-res-col"><h4>材料效率研究</h4>
        <div class="pi-inline"><span>ME ${curMe} →</span><input type="number" class="pi-input pi-tax" min="${curMe}" max="10" value="${tme}" data-plan-res="me"></div>
        <div class="ind-kv"><span>时间</span><b>${X.fmtTime(me.secs)}</b><span>费用（估）</span><b>${isk(me.cost)}</b><span>每流程省材料</span><b>${save > 0 ? isk(save) : '—'}</b><span>回本流程</span><b>${payback ? num(payback) : '—'}</b></div></div>
      <div class="ind-res-col"><h4>时间效率研究</h4>
        <div class="pi-inline"><span>TE ${curTe} →</span><input type="number" class="pi-input pi-tax" min="${curTe}" max="20" step="2" value="${tte}" data-plan-res="te"></div>
        <div class="ind-kv"><span>时间</span><b>${X.fmtTime(te.secs)}</b><span>费用（估）</span><b>${isk(te.cost)}</b><span>研究后制造时间</span><b>${X.fmtTime(X.job(r.pid, r.runs, r.me, tte).secs)}</b></div></div>
      <div class="ind-res-col"><h4>拷贝</h4>
        <div class="pi-inline"><span>份数</span><input type="number" class="pi-input pi-tax" min="1" max="1000" value="${R.copies}" data-plan-res="copies"><span>每份流程</span><input type="number" class="pi-input pi-tax" min="1" max="${maxRuns}" value="${cruns}" data-plan-res="runs"></div>
        <div class="ind-kv"><span>时间</span><b>${X.fmtTime(cp.secs)}</b><span>费用（估）</span><b>${isk(cp.cost)}</b><span>每流程</span><b>${isk(cp.cost / (cruns * R.copies))}</b></div></div>
    </div>
    <p class="pi-note">技能：冶金学 ${X.lvl(SK.metallurgy)} 级 · 研究 ${X.lvl(SK.research)} 级 · 科学 ${X.lvl(SK.science)} 级 · 高级工业理论 ${X.lvl(SK.advIndustry)} 级</p></details>`;
}

export function onCalcEvent(e) {
  const dec = e.target.closest?.('[data-plan-dec]');
  if (dec && e.type === 'click') { X.C.dec = Number(dec.dataset.planDec); X.C.me = null; X.C.te = null; return 'draw'; }
  const res = e.target.closest?.('[data-plan-res]');
  if (res && e.type === 'change') {
    const R = X.C.research || (X.C.research = { me: 10, te: 20, copies: 1, runs: null });
    R[res.dataset.planRes] = Math.max(0, Math.round(Number(res.value) || 0));
    FOLD.research = true;
    return 'draw';
  }
  const fold = e.target.closest?.('[data-plan-fold]');
  if (fold && e.type === 'toggle' && e.target === fold) FOLD[fold.dataset.planFold] = fold.open;
  return null;
}

// ---------- 库存 ----------
async function loadAssets(force) {
  if (S.assets && !force) return S.assets;
  if (S.assetsBusy) return null;
  S.assetsBusy = true;
  S.assetsErr = null;
  try {
    const token = await X.ctx.ensureEsiToken();
    const list = await X.ctx.esiAuthFetchPaged(`/characters/${token.character_id}/assets/`);
    const map = new Map();
    for (const a of list || []) if (!a.is_blueprint_copy) map.set(a.type_id, (map.get(a.type_id) || 0) + (a.quantity || 1));
    S.assets = map;
  } catch (e) {
    S.assetsErr = e.message;
  } finally {
    S.assetsBusy = false;
  }
  return S.assets;
}

let nameIndex = null;
function parsePaste(text) {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const [id, t] of Object.entries(X.D.data.types)) { nameIndex.set(t[0], Number(id)); if (t[1]) nameIndex.set(t[1].toLowerCase(), Number(id)); }
  }
  const map = new Map();
  const unknown = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let name, qty;
    const parts = line.split('\t').map((s) => s.trim());
    if (parts.length > 1) { name = parts[0]; qty = parts.slice(1).map((s) => s.replace(/[,\s]/g, '')).find((s) => /^\d+$/.test(s)); }
    else { const m = line.match(/^(.*?)\s*[x×*]?\s*([\d,]+)$/i); if (m) { name = m[1].trim(); qty = m[2].replace(/,/g, ''); } else name = line; }
    const id = nameIndex.get(name) ?? nameIndex.get(String(name).toLowerCase());
    if (!id) { unknown.push(name); continue; }
    map.set(id, (map.get(id) || 0) + Number(qty || 1));
  }
  return { map, unknown };
}

function stockMap() {
  if (P.stock === 'esi') return S.assets || new Map();
  if (P.stock === 'paste') return parsePaste(P.paste).map;
  return new Map();
}

// ---------- 规划计算 ----------
function planCompute() {
  const { BP, job } = X;
  const build = new Set(P.build);
  const stock = new Map(stockMap());
  const take = (id, q) => { const have = stock.get(id) || 0; const used = Math.min(have, q); if (used) stock.set(id, have - used); return q - used; };
  const jobs = [];
  const need = new Map();       // 自制中间产品 -> 需要数量
  const buy = new Map();        // 购买材料 -> { need, have }
  const depth = new Map();      // 自制中间产品的最大层级
  const items = P.items.map((it, i) => {
    const q = quote(it.pid, { runs: it.runs, me: it.me, te: it.te, invent: it.invent, dec: it.dec || 0, build: P.build });
    // 分批：拆成 n 个任务放到不同产线同时造（时间与安装费按流程数等比例分摊）
    const n = Math.max(1, Math.min(it.split || 1, q.runs));
    for (let k = 0; k < n; k++) {
      const runs = Math.floor(q.runs / n) + (k < q.runs % n ? 1 : 0);
      jobs.push({ pid: it.pid, runs, secs: q.j.secs * runs / q.runs, cost: q.j.cost * runs / q.runs, act: q.act, depth: 0, me: q.me, te: q.te, top: i, batch: n > 1 ? k + 1 : 0, batches: n });
    }
    return { it, q };
  });
  const walk = (pid, d) => {
    for (const [id] of BP(pid)[3]) if (build.has(id) && BP(id)) { if ((depth.get(id) ?? -1) < d) { depth.set(id, d); walk(id, d + 1); } }
  };
  for (const { it } of items) walk(it.pid, 1);
  const addNeed = (id, q) => {
    if (build.has(id) && BP(id) && depth.has(id)) need.set(id, (need.get(id) || 0) + q);
    else { const b = buy.get(id) || { need: 0 }; b.need += q; buy.set(id, b); }
  };
  for (const { q } of items) for (const it of q.j.items) addNeed(it.id, it.qty);
  // 中间产品按层级从浅到深处理：处理某层时，所有用到它的上层都已累计完需求
  const order = [...depth.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id, d] of order) {
    const want = take(id, need.get(id) || 0);
    if (want <= 0) continue;
    const b = BP(id);
    const runs = Math.ceil(want / b[1]);
    const me = b[5] === 'r' ? 0 : X.F.subMe;
    const j = job(id, runs, me, 0);
    jobs.push({ pid: id, runs, secs: j.secs, cost: j.cost, act: b[5], depth: d, me, te: 0, extra: Math.floor(runs * b[1] - want) });
    for (const m of j.items) addNeed(m.id, m.qty);
  }
  let matCost = 0;
  const shop = [];
  for (const [id, b] of buy) {
    b.need = Math.ceil(b.need - 1e-9);
    b.toBuy = take(id, b.need);
    b.have = b.need - b.toBuy;
    const unit = X.matPrice(id) ?? 0;
    matCost += b.toBuy * unit * (1 + X.matFee() / 100);
    shop.push({ id, ...b, unit });
  }
  shop.sort((a, b) => b.toBuy * b.unit - a.toBuy * a.unit);
  const install = jobs.reduce((t, j) => t + j.cost, 0);
  const invCost = items.reduce((t, { q }) => t + q.invCost, 0);
  const bpCost = items.reduce((t, { q }) => t + q.bpCost, 0);
  const revenue = items.reduce((t, { q }) => t + q.revenue, 0);
  const total = matCost + install + invCost + bpCost;
  return { items, jobs, shop, matCost, install, invCost, bpCost, revenue, total, profit: revenue - total, schedule: schedule(jobs) };
}

// 产线：手动填条数，或按已绑定的各角色技能（大规模生产 / 高级大规模生产、大规模反应 / 高级大规模反应，各 +1 条/级）
// 并扣掉进行中的任务（产线到任务结束才空出来）
function laneDefs() {
  const manual = (kind, n) => Array.from({ length: Math.max(1, n) }, (_, i) => ({ t: 0, busy: 0, label: `${kind === 'r' ? '反应' : '制造'} ${i + 1}` }));
  const chars = P.lanes === 'chars' ? (S.chars || []).filter((c) => !c.err) : [];
  if (!chars.length) return { m: manual('m', P.slots), r: manual('r', P.rslots), byChar: false };
  const lanes = (kind) => chars.flatMap((c) => {
    const n = kind === 'r' ? c.r : c.m;
    const busy = (kind === 'r' ? c.busyR : c.busyM).slice().sort((a, b) => a - b);
    return Array.from({ length: n }, (_, i) => ({ t: busy[i] || 0, busy: busy[i] || 0, who: c.name, label: `${c.name} · ${kind === 'r' ? '反应' : '制造'} ${i + 1}` }));
  });
  const r = lanes('r');
  return { m: lanes('m'), r: r.length ? r : manual('r', P.rslots), byChar: true };
}

// 时间轴：深层（先要造的组件）先排，每层等上一层全部完成；每个任务放到最早空出来的产线
function schedule(jobs) {
  const defs = laneDefs();
  const lanes = { m: defs.m.map((l) => ({ ...l })), r: defs.r.map((l) => ({ ...l })) };
  const levels = [...new Set(jobs.map((j) => j.depth))].sort((a, b) => b - a);
  let barrier = 0;
  const out = [];
  for (const d of levels) {
    let levelEnd = barrier;
    const list = jobs.filter((j) => j.depth === d).sort((a, b) => b.secs - a.secs);
    for (const j of list) {
      const kind = j.act === 'r' ? 'r' : 'm';
      const ls = lanes[kind];
      let k = 0;
      for (let i = 1; i < ls.length; i++) if (Math.max(ls[i].t, barrier) < Math.max(ls[k].t, barrier)) k = i;
      const start = Math.max(ls[k].t, barrier);
      ls[k].t = start + j.secs;
      levelEnd = Math.max(levelEnd, ls[k].t);
      out.push({ ...j, kind, lane: k, laneLabel: ls[k].label, start, end: start + j.secs });
    }
    barrier = levelEnd;
  }
  // 已有任务占着的产线也画出来
  const busy = [];
  for (const kind of ['m', 'r']) lanes[kind].forEach((l, k) => { if (l.busy) busy.push({ kind, lane: k, laneLabel: l.label, end: l.busy }); });
  return { bars: out, busy, byChar: defs.byChar, span: Math.max(barrier, ...busy.map((b) => b.end)) };
}

async function loadChars() {
  const list = X.ctx.esiAccountList?.() || [];
  S.chars = await Promise.all(list.map(async (a) => {
    const c = { id: a.id, name: a.name, m: 1, r: 0, busyM: [], busyR: [], err: null, jobsErr: null };
    try {
      const sk = await X.ctx.esiAccountFetch(a.id, `/characters/${a.id}/skills/`);
      const L = new Map((sk.skills || []).map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0]));
      c.m = 1 + (L.get(3387) || 0) + (L.get(24625) || 0);
      c.r = L.get(45746) ? 1 + (L.get(45748) || 0) + (L.get(45749) || 0) : 0;   // 没有反应学技能不能做反应
    } catch (e) { c.err = e.status === 403 ? '未授权技能读取' : e.message; return c; }
    try {
      const jobs = await X.ctx.esiAccountFetch(a.id, `/characters/${a.id}/industry/jobs/`);
      const now = Date.now();
      for (const j of jobs || []) {
        if (j.status !== 'active' && j.status !== 'paused') continue;
        const left = Math.max(0, (new Date(j.end_date).getTime() - now) / 1000);
        if (!left) continue;
        if (j.activity_id === 1) c.busyM.push(left);
        else if (j.activity_id === 9 || j.activity_id === 11) c.busyR.push(left);
      }
    } catch (e) { c.jobsErr = e.status === 403 ? '未授权工业任务读取，按全部空闲算' : '工业任务读取失败，按全部空闲算'; }
    return c;
  }));
  return S.chars;
}

// ---------- 规划页 ----------
export async function renderPlan(body) {
  const tabs = `<div class="segmented ind-plan-tabs">${[['plan', '制造规划'], ['stock', '库存可造']].map(([k, l]) => `<button type="button" data-plan-tab="${k}" class="${P.tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  if (P.stock === 'esi' && !S.assets && !S.assetsErr && X.ctx.hasEsiToken()) {
    body.innerHTML = tabs + '<div class="pi-loading">读取角色资产…</div>';
    await loadAssets();
    if (X.F.tab !== 'plan') return;
  }
  if (P.tab === 'stock') { body.innerHTML = tabs + stockSourceHtml() + clearHtml(); return; }
  if (P.lanes === 'chars' && !S.chars && P.items.length && (X.ctx.esiAccountList?.() || []).length) {
    body.innerHTML = tabs + '<div class="pi-loading">读取各角色技能与工业任务…</div>';
    if (!S.charsLoading) S.charsLoading = loadChars().finally(() => { S.charsLoading = null; });
    await S.charsLoading;
    if (X.F.tab !== 'plan') return;
  }
  if (!P.items.length) {
    body.innerHTML = tabs + `<div class="pi-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/><path d="M17 15v6M14 18h6"/></svg>
      <p>还没有规划</p></div>` + stockSourceHtml();
    return;
  }
  body.innerHTML = tabs + `<div class="pi-loading" id="planLoading">读取行情…</div>`;
  const ids = new Set();
  const walk = (pid, d) => { ids.add(pid); for (const [id] of X.BP(pid)[3]) { ids.add(id); if (d < 5 && X.BP(id)) walk(id, d + 1); } };
  for (const it of P.items) {
    walk(it.pid, 0);
    const inv = X.invFor(it.pid);
    if (inv) { inv[3].forEach(([id]) => ids.add(id)); if (it.dec) ids.add(it.dec); }
  }
  await X.loadJita([...ids], (done, total) => { const el = document.getElementById('planLoading'); if (el) el.textContent = `读取行情 ${done}/${total}`; });
  if (X.F.tab !== 'plan' || P.tab !== 'plan') return;
  drawPlan(body, tabs);
}

function drawPlan(body, tabs) {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const r = planCompute();
  S.lastPlan = r;
  const icon = (id, s = 24) => `<img src="${X.ICON(id)}" alt="" width="${s}" height="${s}" loading="lazy">`;
  const buildable = new Map();
  for (const { q } of r.items) for (const m of q.rows) if (m.canBuild) buildable.set(m.id, true);
  for (const j of r.jobs) if (j.depth > 0) for (const [id] of X.BP(j.pid)[3]) if (X.BP(id)) buildable.set(id, true);
  const itemRows = r.items.map(({ it, q }, i) => `<tr>
      <td><div class="pi-prod">${icon(it.pid)}<span>${esc(X.tName(it.pid))}${q.inv ? '<small>发明</small>' : ''}</span></div></td>
      <td class="num"><input type="number" class="pi-input ind-plan-num" min="1" max="100000" value="${it.runs}" data-plan-item="${i}" data-k="runs"></td>
      <td class="num pi-hide-sm"><input type="number" class="pi-input ind-plan-num" min="1" max="50" value="${it.split || 1}" data-plan-item="${i}" data-k="split" title="拆成几个任务放到不同产线同时造"></td>
      <td class="num pi-hide-sm">${q.act === 'r' ? '—' : `<input type="number" class="pi-input ind-plan-num" min="0" max="10" value="${q.me}" data-plan-item="${i}" data-k="me"> / <input type="number" class="pi-input ind-plan-num" min="0" max="20" step="2" value="${q.te}" data-plan-item="${i}" data-k="te">`}</td>
      <td class="num">${num(q.j.out)}</td>
      <td class="num pi-hide-sm">${isk(q.total)}</td>
      <td class="num pi-hide-sm">${isk(q.revenue)}</td>
      <td class="num ${q.profit >= 0 ? 'up' : 'down'}">${isk(q.profit)}</td>
      <td class="ind-plan-act"><button type="button" class="link-btn" data-plan-open="${i}">计算器</button><button type="button" class="link-btn" data-plan-del="${i}">移除</button></td></tr>`).join('');
  const buildChips = [...buildable.keys()].sort((a, b) => X.tName(a).localeCompare(X.tName(b), 'zh')).map((id) => `<button type="button" class="ind-build-btn${P.build.includes(id) ? ' on' : ''}" data-plan-build="${id}">${esc(X.tName(id))}<small>${P.build.includes(id) ? '自制' : '购买'}</small></button>`).join('');
  const jobRows = r.schedule.bars.slice().sort((a, b) => a.start - b.start || b.depth - a.depth).map((j) => `<tr>
      <td><div class="pi-prod">${icon(j.pid, 20)}<span>${esc(X.tName(j.pid))}</span></div></td>
      <td>${j.act === 'r' ? '反应' : '制造'}${j.depth ? `<small class="hc-sub">组件 · 第 ${j.depth} 层${j.extra > 0 ? ` · 多出 ${num(j.extra)} 个` : ''}</small>` : j.batch ? `<small class="hc-sub">第 ${j.batch} / ${j.batches} 批</small>` : ''}</td>
      <td class="num">${num(j.runs)}</td><td class="num pi-hide-sm">${j.act === 'r' ? '—' : `${j.me} / ${j.te}`}</td>
      <td class="num">${X.fmtTime(j.secs)}</td><td class="num pi-hide-sm">${isk(j.cost)}</td>
      <td class="num pi-hide-sm">${esc(j.laneLabel)} 号线 · ${j.start ? X.fmtTime(j.start) + ' 后' : '立即'}</td></tr>`).join('');
  const isPi = (id) => [42, 43].includes(X.D.data.groups[X.T(id)[2]]?.[1]);   // 行星资源 / 行星产品
  const piShop = r.shop.filter((s) => s.toBuy && isPi(s.id));
  const shopRows = r.shop.map((s) => `<tr class="${s.toBuy ? '' : 'is-done'}"><td><div class="pi-prod">${icon(s.id, 20)}<span>${esc(X.tName(s.id))}${isPi(s.id) ? `<button type="button" class="ind-pi-link" data-plan-pi="${s.id}" title="在行星工业规划里算怎么自己产">行星工业</button>` : ''}</span></div></td>
      <td class="num">${num(s.need)}</td>${P.stock !== 'none' ? `<td class="num">${s.have ? num(s.have) : '—'}</td>` : ''}<td class="num"><b>${num(s.toBuy)}</b></td><td class="num">${isk(s.toBuy * s.unit)}</td></tr>`).join('');
  body.innerHTML = tabs + `
    <div class="pi-card pi-detail">
      <div class="pi-stats ind-stats">
        <div><span>材料（购买）</span><b>${isk(r.matCost)}</b></div>
        <div><span>安装费</span><b>${isk(r.install)}</b></div>
        ${r.invCost ? `<div><span>发明</span><b>${isk(r.invCost)}</b></div>` : ''}
        ${r.bpCost ? `<div><span>蓝图</span><b>${isk(r.bpCost)}</b></div>` : ''}
        <div><span>卖出所得</span><b>${isk(r.revenue)}</b></div>
        <div class="${r.profit >= 0 ? 'pi-stat-main' : 'ind-stat-loss'}"><span>总利润</span><b>${isk(r.profit)}</b></div>
        <div><span>全部完成约</span><b>${X.fmtTime(r.schedule.span)}</b></div>
      </div>
      <div class="pi-card-head"><h3>产品</h3><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-clear>清空规划</button></div>
      <div class="pi-table-wrap"><table class="pi-table ind-plan-items"><thead><tr><th>产品</th><th class="num">流程</th><th class="num pi-hide-sm" title="拆成几个任务放到不同产线同时造">分批</th><th class="num pi-hide-sm">ME / TE</th><th class="num">产出</th><th class="num pi-hide-sm">成本</th><th class="num pi-hide-sm">卖出</th><th class="num">利润</th><th></th></tr></thead><tbody>${itemRows}</tbody></table></div>
      ${buildChips ? `<div class="ind-plan-build"><span class="text-muted">组件（点击切换自制 / 购买）：</span><div>${buildChips}</div></div>` : ''}
    </div>
    ${inventHtml(r)}
    ${stockSourceHtml()}
    <div class="pi-card"><div class="pi-card-head"><h3>产线时间轴</h3>${lanesHtml()}</div>
      ${charsHtml()}
      ${ganttHtml(r.schedule)}</div>
    <div class="pi-card"><div class="pi-card-head"><h3>产线启动清单</h3><span class="text-muted">按开工顺序</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="jobs">复制清单</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>产品</th><th>类型</th><th class="num">流程</th><th class="num pi-hide-sm">ME / TE</th><th class="num">时间</th><th class="num pi-hide-sm">安装费</th><th class="num pi-hide-sm">安排</th></tr></thead><tbody>${jobRows}</tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>购物清单</h3><span class="text-muted">${r.shop.filter((s) => s.toBuy).length} 种要买${piShop.length ? ` · 其中行星工业产品 ${piShop.length} 种共 ${isk(piShop.reduce((t, x) => t + x.toBuy * x.unit, 0))}` : ''}</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="shop" title="可粘贴到游戏多重购买">复制清单</button><button type="button" class="btn btn-ghost btn-sm" data-plan-cart title="要买的材料加入购物车">加入购物车</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>材料</th><th class="num">需要</th>${P.stock !== 'none' ? '<th class="num">库存抵扣</th>' : ''}<th class="num">要买</th><th class="num">费用</th></tr></thead><tbody>${shopRows}</tbody></table></div></div>`;
}

function lanesHtml() {
  const accounts = X.ctx.esiAccountList?.() || [];
  const seg = accounts.length ? `<div class="segmented">${[['manual', '手动'], ['chars', `按人物（${accounts.length}）`]].map(([k, l]) => `<button type="button" data-plan-lanes="${k}" class="${P.lanes === k ? 'active' : ''}">${l}</button>`).join('')}</div>` : '';
  if (accounts.length && P.lanes === 'chars') return seg;
  return `${seg}<div class="pi-inline"><span>制造产线</span><input type="number" class="pi-input pi-tax" min="1" max="50" value="${P.slots}" data-plan-num="slots"><span>反应产线</span><input type="number" class="pi-input pi-tax" min="1" max="50" value="${P.rslots}" data-plan-num="rslots"></div>`;
}

function charsHtml() {
  if (P.lanes !== 'chars' || !(X.ctx.esiAccountList?.() || []).length) return '';
  const { esc } = X.ctx;
  if (!S.chars) return '<p class="text-muted">读取中…</p>';
  const rows = S.chars.map((c) => c.err
    ? `<li class="is-err"><b>${esc(c.name)}</b><span>${esc(c.err)}，不参与分配</span></li>`
    : `<li><b>${esc(c.name)}</b><span>制造 ${c.m} 条${c.busyM.length ? `（${Math.min(c.busyM.length, c.m)} 条在忙）` : ''} · ${c.r ? `反应 ${c.r} 条${c.busyR.length ? `（${Math.min(c.busyR.length, c.r)} 条在忙）` : ''}` : '不能反应'}${c.jobsErr ? ` · <small>${esc(c.jobsErr)}</small>` : ''}</span></li>`).join('');
  const noR = S.chars.every((c) => c.err || !c.r);
  return `<ul class="ind-chars">${rows}</ul><p class="pi-note">${noR ? `无人能做反应，按手动 ${P.rslots} 条算。` : ''}<button type="button" class="link-btn" data-plan-chars>重新读取</button></p>`;
}

// 发明进度：已经发明了多少次、成功几张，按二项分布估算还要再发明几次
function inventHtml(r) {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const list = r.items.map(({ it, q }, i) => ({ it, q, i })).filter((x) => x.q.inv);
  if (!list.length) return '';
  const rows = list.map(({ it, q, i }) => {
    const need = Math.ceil(q.runs / q.inv.runs);
    const got = Math.min(it.invGot || 0, 100000), tried = it.invTry || 0;
    const left = Math.max(0, need - got);
    const n95 = left ? attemptsFor(left, q.inv.prob) : 0;
    const real = tried ? got / tried : null;
    return `<tr>
      <td><div class="pi-prod"><img src="${X.ICON(it.pid)}" alt="" width="20" height="20" loading="lazy"><span>${esc(X.tName(it.pid))}</span></div></td>
      <td class="num">${num(need)}<small class="hc-sub">每张 ${q.inv.runs} 流程</small></td>
      <td class="num"><input type="number" class="pi-input ind-plan-num" min="0" max="100000" value="${tried}" data-plan-item="${i}" data-k="invTry"></td>
      <td class="num"><input type="number" class="pi-input ind-plan-num" min="0" max="100000" value="${got}" data-plan-item="${i}" data-k="invGot"></td>
      <td class="num pi-hide-sm">${(q.inv.prob * 100).toFixed(1)}%${real != null ? `<small class="hc-sub ${real >= q.inv.prob ? 'up' : 'down'}">实际 ${(real * 100).toFixed(1)}%</small>` : ''}</td>
      <td class="num">${left ? `还差 ${num(left)} 张` : '<span class="up">已够</span>'}</td>
      <td class="num">${left ? `${num(n95)} 次<small class="hc-sub">约 ${isk(n95 * q.inv.attempt)}</small>` : '—'}</td></tr>`;
  }).join('');
  return `<div class="pi-card"><div class="pi-card-head"><h3>发明进度</h3><span class="text-muted">按 95% 把握算还要发明几次</span></div>
    <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>产品</th><th class="num">需要拷贝</th><th class="num">已发明</th><th class="num">已成功</th><th class="num pi-hide-sm">成功率</th><th class="num">进度</th><th class="num">还要发明</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function ganttHtml(sch) {
  const { esc } = X.ctx;
  if (!sch.span) return '<p class="text-muted">没有任务</p>';
  const lanes = new Map();
  const laneOf = (b) => { const key = b.kind + b.lane; if (!lanes.has(key)) lanes.set(key, { kind: b.kind, lane: b.lane, label: b.laneLabel, bars: [], busy: 0 }); return lanes.get(key); };
  for (const b of sch.bars) laneOf(b).bars.push(b);
  for (const b of sch.busy) laneOf(b).busy = b.end;
  const list = [...lanes.values()].sort((a, b) => (a.kind === b.kind ? a.lane - b.lane : a.kind === 'r' ? -1 : 1));
  const ticks = 6;
  const axis = Array.from({ length: ticks + 1 }, (_, i) => `<span style="left:${(i / ticks) * 100}%">${X.fmtTime(sch.span * i / ticks)}</span>`).join('');
  return `<div class="ind-gantt${sch.byChar ? ' by-char' : ''}">${list.map((l) => `<div class="ind-gantt-row"><span class="ind-gantt-label" title="${esc(l.label)}">${esc(l.label)}</span><div class="ind-gantt-track">
      ${l.busy ? `<i class="ind-gantt-bar busy" style="left:0;width:${Math.max(0.6, (l.busy / sch.span) * 100)}%" title="已有任务 · ${X.fmtTime(l.busy)} 后空出">已有任务</i>` : ''}
      ${l.bars.map((b) => `<i class="ind-gantt-bar d${Math.min(b.depth, 3)}" style="left:${(b.start / sch.span) * 100}%;width:${Math.max(0.6, (b.secs / sch.span) * 100)}%" title="${esc(X.tName(b.pid))} ×${b.runs} · ${X.fmtTime(b.secs)}">${esc(X.tName(b.pid))}</i>`).join('')}</div></div>`).join('')}
    <div class="ind-gantt-row"><span class="ind-gantt-label"></span><div class="ind-gantt-axis">${axis}</div></div></div>
    <p class="pi-note">组件逐层先造${sch.byChar ? '，已扣除进行中的任务' : ''}</p>`;
}

function stockSourceHtml() {
  const { esc } = X.ctx;
  const esi = X.ctx.hasEsiToken();
  const seg = `<div class="segmented">${[['none', '不扣'], ...(esi ? [['esi', '我的资产（ESI）']] : []), ['paste', '粘贴清单']].map(([k, l]) => `<button type="button" data-plan-stock="${k}" class="${P.stock === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  let extra = '';
  if (P.stock === 'esi') extra = S.assetsErr ? `<p class="pi-note warn">资产读取失败：${esc(S.assetsErr)}</p>` : S.assets ? `<p class="pi-note">已读取 ${S.assets.size} 种物品 <button type="button" class="link-btn" data-plan-assets>重新读取</button></p>` : '';
  if (P.stock === 'paste') {
    const { map, unknown } = parsePaste(P.paste);
    extra = `<textarea class="pi-input ind-paste" data-plan-paste rows="5" placeholder="每行「物品名  数量」，可直接粘贴游戏仓库 / 机库里复制的物品列表">${esc(P.paste)}</textarea>
      <p class="pi-note">识别 ${map.size} 种${unknown.length ? `，${unknown.length} 行没认出（${esc(unknown.slice(0, 5).join('、'))}${unknown.length > 5 ? ' 等' : ''}）` : ''}</p>`;
  }
  return `<div class="pi-card ind-stock"><div class="pi-card-head"><h3>库存</h3>${seg}${P.tab === 'stock' ? '' : '<span class="text-muted">从购物清单中扣除</span>'}</div>${extra}</div>`;
}

// 工业清库：现有材料能造什么
function clearHtml() {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const stock = stockMap();
  if (!stock.size) return '<div class="pi-card"><p class="text-muted">先选择库存来源</p></div>';
  const fac = X.facilityFor('m');
  const mul = (1 - fac.me / 100) * (1 - (fac.rig.me * X.secMul(X.sysSec())) / 100);
  const full = [], part = [];
  for (const key of Object.keys(X.D.data.bp)) {
    const pid = Number(key);
    const b = X.BP(pid);
    if (b[5] !== 'm' || !b[3].some(([id]) => stock.has(id))) continue;
    if (!b[7] && !X.invFor(pid)) continue;   // 蓝图拿不到（派系等）
    const unit = X.prodPrice(pid);
    if (!unit || b[3].some(([id]) => !X.matPrice(id))) continue;
    const me = X.invFor(pid) ? 2 : X.F.me;
    const per = b[3].map(([id, q]) => ({ id, q: q * (1 - me / 100) * mul, have: stock.get(id) || 0, price: X.matPrice(id) ?? 0 }));
    const value = per.reduce((t, m) => t + m.q * m.price, 0);
    if (!value) continue;
    const runs = Math.floor(Math.min(...per.map((m) => m.have / m.q)));
    const out = unit * b[1] * (1 - X.sellFee() / 100);
    if (runs >= 1) {
      const used = value * runs;
      full.push({ pid, runs, used, out: out * runs, profit: (out - value) * runs - X.job(pid, runs, me, X.F.te).cost });
    } else {
      const covered = per.reduce((t, m) => t + Math.min(m.have, m.q) * m.price, 0);
      const missing = per.filter((m) => m.have < m.q);
      part.push({ pid, cover: covered / value, missingCost: missing.reduce((t, m) => t + (m.q - m.have) * m.price, 0), missing, out });
    }
  }
  full.sort((a, b) => b.used - a.used);
  part.sort((a, b) => b.cover - a.cover || a.missingCost - b.missingCost);
  const icon = (id) => `<img src="${X.ICON(id)}" alt="" width="24" height="24" loading="lazy">`;
  const prod = (pid) => `<div class="pi-prod">${icon(pid)}<span>${esc(X.tName(pid))}${X.invFor(pid) ? '<small>T2</small>' : ''}</span></div>`;
  return `<div class="pi-card"><div class="pi-card-head"><h3>库存直接能造</h3><span class="text-muted">${full.length} 种 · 蓝图 ME ${X.F.me}</span></div>
      <div class="pi-table-wrap ind-rank-wrap"><table class="pi-table"><thead><tr><th>产品</th><th class="num">最多流程</th><th class="num">用掉库存</th><th class="num pi-hide-sm">产出价值</th><th class="num">利润（含安装费）</th><th></th></tr></thead><tbody>
      ${full.slice(0, 60).map((x) => `<tr><td>${prod(x.pid)}</td><td class="num">${num(x.runs)}</td><td class="num">${isk(x.used)}</td><td class="num pi-hide-sm">${isk(x.out)}</td><td class="num ${x.profit >= 0 ? 'up' : 'down'}">${isk(x.profit)}</td>
        <td class="ind-plan-act"><button type="button" class="link-btn" data-plan-add="${x.pid}" data-runs="${x.runs}">加入规划</button><button type="button" class="link-btn" data-ind-pick="${x.pid}">计算器</button></td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">现有材料凑不齐任何产品的一个流程</td></tr>'}
      </tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>差一点能造</h3><span class="text-muted">库存已覆盖一半以上</span></div>
      <div class="pi-table-wrap ind-rank-wrap"><table class="pi-table"><thead><tr><th>产品</th><th class="num">库存覆盖</th><th class="num">补齐要花</th><th class="pi-hide-sm">缺</th><th></th></tr></thead><tbody>
      ${part.filter((x) => x.cover >= 0.5).slice(0, 40).map((x) => `<tr><td>${prod(x.pid)}</td><td class="num">${(x.cover * 100).toFixed(0)}%</td><td class="num">${isk(x.missingCost)}</td>
        <td class="pi-hide-sm ind-missing">${x.missing.slice(0, 4).map((m) => `${esc(X.tName(m.id))} ×${num(Math.ceil(m.q - m.have))}`).join('、')}${x.missing.length > 4 ? ' 等' : ''}</td>
        <td class="ind-plan-act"><button type="button" class="link-btn" data-plan-add="${x.pid}" data-runs="1">加入规划</button><button type="button" class="link-btn" data-ind-pick="${x.pid}">计算器</button></td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">没有</td></tr>'}
      </tbody></table></div></div>`;
}

// ---------- 规划页事件 ----------
export function onPlanEvent(e) {
  const t = e.target;
  if (e.type === 'click') {
    const tab = t.closest('[data-plan-tab]');
    if (tab) { P.tab = tab.dataset.planTab; savePlan(); return 'plan'; }
    const st = t.closest('[data-plan-stock]');
    if (st) { P.stock = st.dataset.planStock; savePlan(); if (P.stock === 'esi' && !S.assets) S.assetsErr = null; return 'plan'; }
    if (t.closest('[data-plan-assets]')) { S.assets = null; S.assetsErr = null; return 'plan'; }
    const add = t.closest('[data-plan-add]');
    if (add) { addToPlan(Number(add.dataset.planAdd), { runs: Number(add.dataset.runs) || 1, me: add.dataset.me != null ? Number(add.dataset.me) : null, te: add.dataset.te != null ? Number(add.dataset.te) : null, invent: add.dataset.me != null ? false : null }); return P.tab === 'stock' || X.F.tab !== 'plan' ? 'none' : 'plan'; }
    const del = t.closest('[data-plan-del]');
    if (del) { P.items.splice(Number(del.dataset.planDel), 1); savePlan(); return 'plan'; }
    if (t.closest('[data-plan-clear]')) { if (confirm('清空制造规划？')) { P.items = []; savePlan(); return 'plan'; } return 'none'; }
    const open = t.closest('[data-plan-open]');
    if (open) {
      const it = P.items[Number(open.dataset.planOpen)];
      X.selectProduct(it.pid, false);
      Object.assign(X.C, { runs: it.runs, me: it.me, te: it.te, invent: it.invent, dec: it.dec || 0, build: new Set(P.build) });
      return 'calc';
    }
    const ln = t.closest('[data-plan-lanes]');
    if (ln) { P.lanes = ln.dataset.planLanes; savePlan(); return 'plan'; }
    if (t.closest('[data-plan-chars]')) { S.chars = null; return 'plan'; }
    const pi = t.closest('[data-plan-pi]');
    if (pi) { location.hash = '#pi/' + pi.dataset.planPi; return 'none'; }
    const bld = t.closest('[data-plan-build]');
    if (bld) { const id = Number(bld.dataset.planBuild); P.build = P.build.includes(id) ? P.build.filter((x) => x !== id) : [...P.build, id]; savePlan(); return 'plan'; }
    if (t.closest('[data-plan-cart]') && S.lastPlan) {
      X.ctx.addToCart(S.lastPlan.shop.filter((s) => s.toBuy).map((s) => ({ id: s.id, qty: s.toBuy, name: X.tName(s.id) })));
      return 'none';
    }
    const copy = t.closest('[data-plan-copy]');
    if (copy && S.lastPlan) {
      const text = copy.dataset.planCopy === 'shop'
        ? S.lastPlan.shop.filter((s) => s.toBuy).map((s) => `${X.tName(s.id)}\t${s.toBuy}`).join('\n')
        : S.lastPlan.schedule.bars.slice().sort((a, b) => a.start - b.start).map((j) => `${X.tName(j.pid)}\t${j.runs} 流程\t${j.act === 'r' ? '反应' : '制造'}\t${X.fmtTime(j.secs)}\t${j.laneLabel}`).join('\n');
      navigator.clipboard.writeText(text).then(() => X.ctx.showToast('已复制', 'success')).catch(() => X.ctx.showToast('浏览器阻止了复制', 'error'));
      return 'none';
    }
  } else if (e.type === 'change') {
    const item = t.closest('[data-plan-item]');
    if (item) {
      const it = P.items[Number(item.dataset.planItem)];
      const k = item.dataset.k;
      const lim = { runs: [1, 100000], me: [0, 10], te: [0, 20], split: [1, 50], invTry: [0, 100000], invGot: [0, 100000] }[k];
      it[k] = Math.min(lim[1], Math.max(lim[0], Math.round(Number(t.value) || 0)));
      savePlan();
      return 'plan';
    }
    const n = t.closest('[data-plan-num]');
    if (n) { P[n.dataset.planNum] = Math.min(50, Math.max(1, Math.round(Number(t.value) || 1))); savePlan(); return 'plan'; }
    if (t.matches('[data-plan-paste]')) { P.paste = t.value; savePlan(); return 'plan'; }
  }
  return null;
}

// ---------- 我的工业：蓝图成本与利润 ----------
export async function mineBlueprintRows(bps, rerender) {
  const prodOf = new Map(Object.entries(X.D.data.bp).map(([pid, b]) => [b[0], Number(pid)]));
  const rows = bps.map((b) => {
    const pid = prodOf.get(b.type_id);
    if (!pid || X.BP(pid)[5] !== 'm') return { b, pid };
    const me = b.material_efficiency, te = b.time_efficiency;
    const j = X.job(pid, 1, me, te);
    if (j.items.some((it) => X.matPrice(it.id) == null)) return { b, pid };
    const cost = j.items.reduce((t, it) => t + it.qty * X.matPrice(it.id) * (1 + X.matFee() / 100), 0) + j.cost;
    const unit = X.prodPrice(pid);
    const profit = unit != null ? unit * j.out * (1 - X.sellFee() / 100) - cost : null;
    return { b, pid, perUnit: cost / j.out, profit, ph: profit != null ? profit / (j.secs / 3600) : null };
  });
  // 行情：先用全服均价，后台读交易中心行情后再刷新一次
  if (!S.mineLoaded && rerender) {
    S.mineLoaded = true;
    const ids = new Set();
    for (const r of rows) if (r.pid) { ids.add(r.pid); X.BP(r.pid)[3].forEach(([id]) => ids.add(id)); }
    X.loadJita([...ids].slice(0, 1500)).then(rerender).catch(() => {});
  }
  return rows;
}

// ---------- 利润排行筛选 ----------
export function skillOk(pid) {
  const b = X.BP(pid);
  const reqs = [...(b[6] || []), ...((b[5] === 'm' && X.invFor(pid)?.[5]) || [])];
  return reqs.every(([id, level]) => X.lvl(id) >= level);
}
function ownedFrom(list) {
  const prodOf = new Map(Object.entries(X.D.data.bp).map(([pid, b]) => [b[0], Number(pid)]));
  const set = new Set(list.map((b) => prodOf.get(b.type_id)).filter(Boolean));
  // T2：有对应 T1 蓝图也算（可以发明）
  for (const [pid] of Object.entries(X.D.data.bp)) { const inv = X.invFor(Number(pid)); if (inv && set.has(prodOf.get(inv[0]))) set.add(Number(pid)); }
  return set;
}
export function loadOwned() {
  if (!S.ownedLoading) S.ownedLoading = fetchOwned();
  return S.ownedLoading;
}
async function fetchOwned() {
  try {
    const token = await X.ctx.ensureEsiToken();
    // 曙光服登录不支持蓝图权限，令牌里没有就不去请求（与「我的工业」一致）
    if (token.scopes && ![].concat(token.scopes).join(' ').includes('esi-characters.read_blueprints.v1')) throw new Error('未授权蓝图读取权限');
    const list = await X.ctx.esiAuthFetchPaged(`/characters/${token.character_id}/blueprints/`);
    S.owned = ownedFrom(list || []);
  } catch (e) {
    // ESI 读不到时用粘贴导入的蓝图
    const pasted = pastedBps();
    if (pasted) { S.owned = ownedFrom(pasted.list); return S.owned; }
    S.owned = new Set();
    S.ownedErr = e.message;
  }
  return S.owned;
}
// ---------- 粘贴导入游戏蓝图 ----------
// 曙光服登录不支持蓝图权限，或不想授权时：从游戏里复制蓝图列表（工业窗口蓝图页 / 机库，Ctrl+A、Ctrl+C）粘贴进来。
// 每行认出蓝图名（中文或英文，取最长匹配），名字后面的数字依次当作 ME（0–10）、TE（0–20）、剩余流程；
// 带「拷贝 / Copy」或有流程数的算拷贝，带「原图 / Original」或没有流程数的算原图；「×3」「x3」为数量。
// 结果与 ESI 蓝图同一格式（runs = -1 为原图），按服务器分开保存。
const bpsKey = () => 'eve-industry-bps-' + X.server;
let bpNames = null;
export function parseBlueprintPaste(text) {
  if (!bpNames) {
    bpNames = [];
    const seen = new Set();
    for (const b of Object.values(X.D.data.bp)) {
      if (seen.has(b[0])) continue;
      seen.add(b[0]);
      const t = X.T(b[0]);
      if (t[0]) bpNames.push([t[0], b[0]]);
      if (t[1]) bpNames.push([t[1].toLowerCase(), b[0]]);
    }
    bpNames.sort((a, b) => b[0].length - a[0].length);
  }
  const list = [];
  const unknown = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    const hit = bpNames.find(([n]) => low.includes(n));
    if (!hit) { if (/[\p{L}]{2,}/u.test(line)) unknown.push(line.slice(0, 40)); continue; }
    const at = low.indexOf(hit[0]);
    const rest = line.slice(at + hit[0].length);
    let qty = 1;
    const qm = rest.match(/[x×]\s*(\d+)/i) || line.slice(0, at).match(/(\d+)\s*[x×]/i);
    if (qm) qty = Number(qm[1]) || 1;
    const nums = rest.replace(/[x×]\s*\d+/gi, ' ').replace(/(\d),(\d{3})/g, '$1$2').match(/-?\d+/g)?.map(Number) || [];
    const me = nums[0] != null && nums[0] >= 0 && nums[0] <= 10 ? nums[0] : 0;
    const te = nums[1] != null && nums[1] >= 0 && nums[1] <= 20 ? nums[1] : 0;
    const copyWord = /拷贝|副本|\bcopy\b|\bbpc\b/i.test(line);
    const origWord = /原图|\boriginal\b|\bbpo\b/i.test(line);
    const runsNum = nums[2] != null && nums[2] > 0 ? nums[2] : null;
    const isCopy = copyWord || (!origWord && runsNum != null);
    list.push({ type_id: hit[1], material_efficiency: me, time_efficiency: te, runs: isCopy ? runsNum || 1 : -1, quantity: qty, pasted: true });
  }
  return { list, unknown };
}
export const pastedBps = () => {
  const v = X.ctx.store.getJSON(bpsKey(), null);
  return Array.isArray(v?.list) ? v : null;
};
export function savePastedBps(list) {
  if (list?.length) X.ctx.store.setJSON(bpsKey(), { list, at: Date.now() });
  else X.ctx.store.remove(bpsKey());
  S.owned = null; S.ownedLoading = null; S.ownedErr = null; S.mineLoaded = false;
}

export const owned = (pid) => Boolean(S.owned?.has(pid));
export const ownedState = () => ({ ready: Boolean(S.owned), err: S.ownedErr, count: S.owned?.size || 0 });
