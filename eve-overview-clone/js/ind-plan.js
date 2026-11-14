// 制造页的扩展功能（由 industry.js 调用，复用它的计算函数）：
// 计算器里的「解码器对比」（每种解码器的总成本 / 利润，标出最优）与「发明次数」（按二项分布，约 95% 把握拿到所需拷贝要发明几次）、
//   「材料效率影响」（ME 0–10 的成本与利润）、「研究与拷贝」（ME / TE 研究到目标等级、拷贝的时间与费用，以及研究后每流程省多少、几个流程回本）；
// 「制造规划」页：多个产品一起规划——组件可选自制并逐级展开汇总，扣除库存（ESI 资产或粘贴），产线启动清单（每个任务的流程数与时间），
//   每个产品可以停用（it.off：已经造好挂单、只想留着看成本的），停用的照样算成本 / 利润，但不进购物清单、产线和合计，
//   正在造的产出（ESI 工业任务）抵库存、组件按自己蓝图的 ME / TE、每个任务在哪座建筑造与状态（可开工 / 缺料 / 等组件 / 等发明），
//   发明前先拷 T1 蓝图（每次发明用掉拷贝 1 个流程，P.copy），发明排在科研产线上（T2 成品等发明完成），
//   每个任务按开工顺序分库存算现在能开几个流程（可先开 N），库存可按位置筛选或按任务所在建筑分开算，购物清单含发明材料并列出送到哪座建筑；
//   按制造 / 反应产线数排出的时间轴（「自动拆分」：多流程的任务——成品和自制组件都算——按空闲产线自动拆成几批同时造），购物清单可复制；「库存可造」按现有材料反推能造什么（工业清库）；
// 「粘贴配装」：游戏装配窗口复制的 EFT 文本拆成舰船、装备、无人机 / 货舱物品，能造的按 件数 × 份数 ÷ 每流程产出（向上取整）加入规划，
//   已在规划里的产品直接加流程；没有蓝图的（势力、官员装备等）列出来。
// 军团蓝图（esi-corporations.read_blueprints.v1，游戏里要董事职位）：/corporations/{id}/blueprints/，同样的蓝图（类型、ME、TE、流程、机库）合并计数；
//   机库分部名称读 /corporations/{id}/divisions/（有军团管理权限时），缓存 5 分钟。「只看我有的蓝图」也算上军团蓝图。
// 「我的工业」蓝图的成本与每小时利润、一键加入规划；利润排行的「技能够造」「我有蓝图」筛选。
// 研究公式：第 n 级时间 = 蓝图基础研究时间 × 等级倍数[n] ÷ 105（倍数 105、250、595、1414、3360、8000、19000、45255、107700、256000），
//   技能冶金学（ME）/ 研究（TE）/ 科学（拷贝）每级 −5%、高级工业理论每级 −3%，植入体 MY / RR / SC，工程复合体同制造的时间加成；
//   费用按产品 EIV × 2% × 时间倍数 ×（研究 / 拷贝指数 × (1 − 建筑减免) + 设施税 + 4% SCC）估算。
let X = null;   // industry.js 传入：ctx, D, F, C, BP, T, tName, invFor, job, invention, calc, matPrice, matFee, prodPrice, sellFee, loadJita, fmtTime, lvl, facilityFor, facTax, SCC, ICON, BP_ICON, selectProduct, renderTab, save, sysSec, secMul, myBp
const PLAN_KEY = 'eve-industry-plan';
const LEVEL_MUL = [0, 105, 250, 595, 1414, 3360, 8000, 19000, 45255, 107700, 256000];
const SK = { science: 3402, research: 3403, metallurgy: 3409, advIndustry: 3388 };
// assign：任务键 → 指定的产线（'c:人物 ID' = 这个人物任意空闲的线；'l:产线 ID' = 某条线）；charOff：不参与的人物；charMax：人物各类产线最多用几条
const P = { items: [], build: [], slots: 10, rslots: 10, islots: 10, lanes: 'manual', auto: true, stock: 'none', stockLoc: 'all', running: true, copy: true, paste: '', tab: 'plan', assign: {}, charOff: [], charMax: {} };
const FOLD = {};   // 计算器里折叠卡片的展开状态（本次会话内）
const S = { assets: null, assetsErr: null, assetsBusy: false, owned: null, ownedLoading: null, chars: null, charsLoading: null };   // chars：按人物分配产线时各角色的产线数与进行中的任务

export function initPlan(api) {
  X = api;
  Object.assign(P, X.ctx.store.getJSON(PLAN_KEY, {}) || {});
  P.items = (P.items || []).filter((it) => X.BP(it.pid));
  // 每个产品一个固定编号（任务键用，删掉前面的产品不会让指定的产线错位）
  let u = Math.max(0, ...P.items.map((it) => it.uid || 0));
  for (const it of P.items) if (!it.uid) it.uid = ++u;
  P.assign ||= {}; P.charOff ||= []; P.charMax ||= {};
}
const nextUid = () => Math.max(0, ...P.items.map((it) => it.uid || 0)) + 1;
const savePlan = () => X.ctx.store.setJSON(PLAN_KEY, { items: P.items, build: P.build, slots: P.slots, rslots: P.rslots, islots: P.islots, lanes: P.lanes, auto: P.auto, stock: P.stock, stockLoc: P.stockLoc, running: P.running, copy: P.copy, paste: P.paste, tab: P.tab, assign: P.assign, charOff: P.charOff, charMax: P.charMax });
export const planCount = () => P.items.length;

function newItem(pid, { runs = 1, me = null, te = null, invent = null, dec = 0 } = {}) {
  const b = X.BP(pid);
  const inv = b[5] === 'm' && X.invFor(pid);
  return { uid: nextUid(), pid, runs: Math.max(1, runs), me: b[5] === 'r' ? 0 : me ?? (inv && invent !== false ? null : X.F.me), te: b[5] === 'r' ? 0 : te ?? (inv && invent !== false ? null : X.F.te), invent: inv ? invent !== false : false, dec };
}
export function addToPlan(pid, opts = {}) {
  if (!X.BP(pid)) return;
  const runs = opts.runs ?? 1;
  P.items.push(newItem(pid, opts));
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
  const act = kind === 'copy' ? 'c' : kind;
  const fac = X.facilityFor(act, pid);
  const eiv = b[3].reduce((t, [id, q]) => t + q * (X.D.adjusted.get(id) || 0), 0);
  const idxKey = { me: 'researching_material_efficiency', te: 'researching_time_efficiency', copy: 'copying' }[kind];
  const idx = (X.D.indices.get(fac.sys ?? X.F.sys) || {})[idxKey] || 0;
  const skill = kind === 'me' ? SK.metallurgy : kind === 'te' ? SK.research : SK.science;
  const timeMul = (1 - 0.05 * X.lvl(skill)) * (1 - 0.03 * X.lvl(SK.advIndustry)) * (1 - fac.te / 100) * (1 - X.impPct(kind === 'copy' ? 'c' : kind) / 100);
  const base = kind === 'me' ? res[0] : kind === 'te' ? res[1] : res[2];
  const secs = base * mulSum * timeMul;
  const cost = eiv * 0.02 * mulSum * (idx * (1 - fac.cost / 100) + (X.facTaxOf(fac, act) + X.SCC) / 100);
  return { secs, cost, idx, fac: fac.name, facId: fac.s?.id || null };
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
  return `<details class="pi-card ind-fold"${FOLD.research ? ' open' : ''} data-plan-fold="research"><summary><h3>研究与拷贝</h3><span class="text-muted">${X.ctx.esc(X.facilityFor('i', r.pid).name)}</span></summary>
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
    <p class="pi-note">技能：冶金学 ${X.lvl(SK.metallurgy)} 级 · 研究 ${X.lvl(SK.research)} 级 · 科学 ${X.lvl(SK.science)} 级 · 高级工业理论 ${X.lvl(SK.advIndustry)} 级${['me', 'te', 'c'].some((k) => X.impPct(k)) ? ` · 植入体 ${[['me', 'ME'], ['te', 'TE'], ['c', '拷贝']].filter(([k]) => X.impPct(k)).map(([k, l]) => `${l} −${X.impPct(k)}%`).join(' / ')}` : ''}</p></details>`;
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
    // 按所在位置（空间站 / 建筑）再分一份：容器、舰船里的东西往上找到最外层所在位置
    const byItem = new Map((list || []).map((a) => [a.item_id, a]));
    const rootLoc = (a) => { let x = a, n = 0; while (byItem.has(x.location_id) && n++ < 10) x = byItem.get(x.location_id); return x.location_id; };
    const loc = new Map();
    for (const a of list || []) {
      if (a.is_blueprint_copy) continue;
      const q = a.quantity || 1;
      map.set(a.type_id, (map.get(a.type_id) || 0) + q);
      const l = rootLoc(a);
      if (!loc.has(l)) loc.set(l, new Map());
      loc.get(l).set(a.type_id, (loc.get(l).get(a.type_id) || 0) + q);
    }
    S.assets = map;
    S.assetsLoc = loc;
    loadLocNames([...loc.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 25).map(([id]) => id));
  } catch (e) {
    S.assetsErr = e.message;
  } finally {
    S.assetsBusy = false;
  }
  return S.assets;
}

// 库存位置的名字：建筑（我的建筑 / 建筑名缓存 / 需要停靠权限的 ESI）、NPC 空间站（公开 ESI）；读完重画规划
async function loadLocNames(ids) {
  S.locNames = S.locNames || new Map();
  const map = X.ctx.structureNameMap?.();
  await Promise.all(ids.filter((id) => !S.locNames.has(id)).map(async (id) => {
    try {
      if (id > 1e12) {
        const n = map?.get(id)?.n || (await X.ctx.esiAuthFetch(`/universe/structures/${id}/`)).name;
        S.locNames.set(id, n);
      } else if (id >= 60000000 && id < 64000000) S.locNames.set(id, (await X.ctx.fetchESI(`/universe/stations/${id}/`)).name);
    } catch { /* 读不到名字就显示 ID */ }
  }));
  if (X.F.tab === 'plan') X.renderTab();
}
const locName = (id) => S.locNames?.get(id) || `位置 ${id}`;
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // textarea 的占位文字不走自动翻译
let nameIndex = null;
function nameId(name) {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const [id, t] of Object.entries(X.D.data.types)) { nameIndex.set(t[0], Number(id)); if (t[1]) nameIndex.set(t[1].toLowerCase(), Number(id)); }
  }
  return nameIndex.get(name) ?? nameIndex.get(String(name).toLowerCase());
}
function parsePaste(text) {
  const map = new Map();
  const unknown = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let name, qty;
    const parts = line.split('\t').map((s) => s.trim());
    if (parts.length > 1) { name = parts[0]; qty = parts.slice(1).map((s) => s.replace(/[,\s]/g, '')).find((s) => /^\d+$/.test(s)); }
    else { const m = line.match(/^(.*?)\s*[x×*]?\s*([\d,]+)$/i); if (m) { name = m[1].trim(); qty = m[2].replace(/,/g, ''); } else name = line; }
    const id = nameId(name);
    if (!id) { unknown.push(name); continue; }
    map.set(id, (map.get(id) || 0) + Number(qty || 1));
  }
  return { map, unknown };
}

// EFT 配装：[舰船, 名称]、每行一个装备（逗号后是装填的弹药，不算）、「名称 x数量」是无人机 / 货舱物品
function parseFit(text) {
  const need = new Map();
  const unknown = [];
  let ship = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/\s*\/offline$/i, '');
    if (!line || /^\[empty/i.test(line)) continue;
    let name, n = 1;
    const head = /^\[([^,\]]+)/.exec(line);
    if (head) { if (ship) continue; ship = true; name = head[1]; }
    else {
      const q = /^(.*?)\s+x(\d+)$/i.exec(line);
      if (q) { name = q[1]; n = Number(q[2]); } else name = line.split(',')[0];
    }
    name = name.trim();
    const id = nameId(name);
    if (!id) { unknown.push(name); continue; }
    need.set(id, (need.get(id) || 0) + n);
  }
  return { need, unknown };
}
function importFit(text, copies) {
  const { need, unknown } = parseFit(text);
  if (!need.size) { S.fitMsg = { error: '没有识别出物品，请粘贴游戏装配窗口「复制到剪贴板」的文本' }; return; }
  let added = 0;
  const noBp = [];
  for (const [id, n] of need) {
    const b = X.BP(id);
    if (!b) { noBp.push(id); continue; }
    const runs = Math.ceil(n * copies / (b[1] || 1));
    const it = P.items.find((x) => x.pid === id);
    if (it) it.runs += runs; else P.items.push(newItem(id, { runs }));
    added++;
  }
  savePlan();
  S.fitMsg = { added, noBp, unknown };
  if (added) S.fitOpen = false;
  if (added) X.ctx.showToast(`配装已加入规划：${added} 种产品`, 'success', 2200);
}
function fitPanel() {
  const esc = X.ctx.esc;
  const m = S.fitMsg;
  const msg = !m ? '' : m.error ? `<p class="ind-fit-msg down">${esc(m.error)}</p>`
    : [m.noBp.length ? `没有蓝图、要买：${m.noBp.map((id) => esc(X.tName(id))).join('、')}` : '', m.unknown.length ? `不认识：${m.unknown.map(esc).join('、')}` : ''].filter(Boolean).map((t) => `<p class="ind-fit-msg">${t}</p>`).join('');
  if (!S.fitOpen) return msg ? `<div class="ind-fit-res">${msg}</div>` : '';
  return `<div class="ind-fit-paste">
      <textarea class="pi-input ind-paste" data-plan-fittext rows="6" placeholder="${esc(tr('游戏装配窗口点「复制到剪贴板」，粘贴到这里'))}" aria-label="配装文本">${esc(S.fitText || '')}</textarea>
      <div class="ind-fit-row"><label class="pi-inline"><span>造几套</span><input type="number" class="pi-input pi-tax" min="1" max="1000" step="1" value="${S.fitN || 1}" data-plan-fitn aria-label="造几套"></label>
        <button type="button" class="btn btn-primary btn-sm" data-plan-fitadd>加入规划</button></div>${msg}</div>`;
}

function stockMap() {
  if (P.stock === 'esi') {
    if (P.stockLoc !== 'all' && P.stockLoc !== 'job' && S.assetsLoc) return S.assetsLoc.get(Number(P.stockLoc)) || new Map();
    return S.assets || new Map();
  }
  if (P.stock === 'paste') return parsePaste(P.paste).map;
  return new Map();
}

// ---------- 规划计算 ----------
// 供应顺序：库存（资产 / 粘贴）+ 正在造的产出（ESI 工业任务，P.running）→ 自制组件 → 购买。
// 每个任务记下在哪座建筑造（job().fac），购物清单按用到它的建筑列出「送到」。
// T2 产品还要发明：按「发明进度」里还差的拷贝数、95% 把握算发明次数，排到科研产线上，成品等发明完成才开工；
// 数据核心、解码器列进购物清单（费用已含在发明成本里，不重复计入材料费）。
function planCompute() {
  const { BP, job } = X;
  const build = new Set(P.build);
  const stock = new Map(stockMap());
  if (P.running && S.running) for (const [id, q] of S.running) stock.set(id, (stock.get(id) || 0) + q);
  const take = (id, q) => { const have = stock.get(id) || 0; const used = Math.min(have, q); if (used) stock.set(id, have - used); return q - used; };
  const jobs = [];
  const need = new Map();       // 自制中间产品 -> 需要数量
  const buy = new Map();        // 购买材料 -> { need, have, to: Set(建筑) }
  const depth = new Map();      // 自制中间产品的最大层级
  const all = P.items.map((it, i) => {
    const q = quote(it.pid, { runs: it.runs, me: it.me, te: it.te, invent: it.invent, dec: it.dec || 0, build: P.build });
    if (it.off) return { it, q };
    // 分批：拆成 n 个任务放到不同产线同时造（时间与安装费按流程数等比例分摊）；自动拆分时先不拆，由排产按空闲产线拆
    const n = P.auto ? 1 : Math.max(1, Math.min(it.split || 1, q.runs));
    for (let k = 0; k < n; k++) {
      const runs = Math.floor(q.runs / n) + (k < q.runs % n ? 1 : 0);
      jobs.push({ key: `t${it.uid}:${n > 1 ? k + 1 : 0}`, pid: it.pid, runs, secs: q.j.secs * runs / q.runs, cost: q.j.cost * runs / q.runs, act: q.act, depth: 0, me: q.me, te: q.te, top: i, batch: n > 1 ? k + 1 : 0, batches: n, fac: q.j.fac, facId: q.j.facId, mats: q.j.items.map((m) => m.id), per: q.j.items.map((m) => [m.id, m.qty / q.runs]) });
    }
    // 发明任务
    if (q.inv) {
      const left = Math.max(0, Math.ceil(q.runs / q.inv.runs) - (it.invGot || 0));
      const n95 = left ? attemptsFor(left, q.inv.prob) : 0;
      if (Number.isFinite(n95) && n95 > 0) {
        const per = [...q.inv.dcs.map(([id, c]) => [id, c]), ...(it.dec ? [[it.dec, 1]] : [])];
        jobs.push({ key: `i${it.uid}`, pid: it.pid, bp: q.inv.t1bp, runs: n95, secs: q.inv.secs * n95, cost: q.inv.jobCost * n95, act: 'i', depth: -1, top: i, fac: q.inv.fac, facId: q.inv.facId, mats: per.map(([id]) => id), per, inv: true });
        // 每次发明用掉 T1 拷贝的 1 个流程：拷贝 ⌈次数 ÷ 每份最多流程⌉ 份（P.copy 关掉 = 已经有拷贝）
        const t1 = P.copy ? t1Prod(q.inv.t1bp) : null;
        const sj = t1 ? scienceJob(t1, 'copy', n95) : null;
        if (sj) {
          const max = Math.max(1, X.BP(t1)[4] || 1);
          jobs.push({ key: `y${it.uid}`, pid: it.pid, bp: q.inv.t1bp, runs: Math.ceil(n95 / max), copyRuns: Math.min(max, n95), secs: sj.secs, cost: sj.cost, act: 'c', depth: -2, top: i, fac: sj.fac, facId: sj.facId, mats: [], per: [], copy: true });
        }
        const inv = [...q.inv.dcs.map(([id, c]) => [id, c * n95]), ...(it.dec ? [[it.dec, n95]] : [])];
        for (const [id, c] of inv) { const b = buy.get(id) || { need: 0, to: new Set(), inv: true }; b.need += c; b.to.add(q.inv.fac); buy.set(id, b); }
      }
    }
    return { it, q };
  });
  const items = all.filter(({ it }) => !it.off);   // 启用的产品
  const walk = (pid, d) => {
    for (const [id] of BP(pid)[3]) if (build.has(id) && BP(id)) { if ((depth.get(id) ?? -1) < d) { depth.set(id, d); walk(id, d + 1); } }
  };
  for (const { it } of items) walk(it.pid, 1);
  const addNeed = (id, q, fac) => {
    if (build.has(id) && BP(id) && depth.has(id)) need.set(id, (need.get(id) || 0) + q);
    else { const b = buy.get(id) || { need: 0, to: new Set() }; b.need += q; b.to.add(fac); delete b.inv; buy.set(id, b); }
  };
  for (const { q } of items) for (const it of q.j.items) addNeed(it.id, it.qty, q.j.fac);
  // 中间产品按层级从浅到深处理：处理某层时，所有用到它的上层都已累计完需求
  const order = [...depth.entries()].sort((a, b) => a[1] - b[1]);
  const fromStock = new Map();   // 组件 -> 库存（含在造）抵掉的数量
  for (const [id, d] of order) {
    const total = need.get(id) || 0;
    const want = take(id, total);
    if (total - want > 0) fromStock.set(id, total - want);
    if (want <= 0) continue;
    const b = BP(id);
    const runs = Math.ceil(want / b[1]);
    const own = b[5] === 'r' ? null : ownedBp(id);
    const me = b[5] === 'r' ? 0 : own?.me ?? X.F.subMe, te = b[5] === 'r' ? 0 : own?.te ?? 0;
    const j = job(id, runs, me, te, undefined, 'comp');
    jobs.push({ key: `c${id}`, pid: id, runs, secs: j.secs, cost: j.cost, act: b[5], depth: d, me, te, own: Boolean(own), extra: Math.floor(runs * b[1] - want), fac: j.fac, facId: j.facId, mats: j.items.map((m) => m.id), per: j.items.map((m) => [m.id, m.qty / runs]) });
    for (const m of j.items) addNeed(m.id, m.qty, j.fac);
  }
  let matCost = 0;
  const shop = [];
  for (const [id, b] of buy) {
    b.need = Math.ceil(b.need - 1e-9);
    b.toBuy = take(id, b.need);
    b.have = b.need - b.toBuy;
    const unit = X.matPrice(id) ?? 0;
    if (!b.inv) matCost += b.toBuy * unit * (1 + X.matFee() / 100);   // 发明材料的费用在发明成本里
    shop.push({ id, ...b, to: [...b.to], unit });
  }
  shop.sort((a, b) => b.toBuy * b.unit - a.toBuy * a.unit);
  const install = jobs.reduce((t, j) => t + (j.inv ? 0 : j.cost), 0);   // 含拷贝费；发明费在发明成本里
  const invCost = items.reduce((t, { q }) => t + q.invCost, 0);
  const bpCost = items.reduce((t, { q }) => t + q.bpCost, 0);
  const revenue = items.reduce((t, { q }) => t + q.revenue, 0);
  const total = matCost + install + invCost + bpCost;
  const sch = schedule(jobs);
  jobStatus(sch.bars, new Set(jobs.filter((j) => j.depth > 0).map((j) => j.pid)));
  return { items: all, on: items, off: all.length - items.length, jobs, shop, fromStock, matCost, install, invCost, bpCost, revenue, total, profit: revenue - total, schedule: sch };
}
const t1Prod = (bpId) => {
  if (!S.prodOf) S.prodOf = new Map(Object.entries(X.D.data.bp).map(([pid, b]) => [b[0], Number(pid)]));
  return S.prodOf.get(bpId) || null;
};

// 每个任务现在能开几个流程：按开工顺序把库存（+ 在造产出）分给各任务，要买的材料每种算 ⌊剩余 ÷ 每流程用量⌋，取最小。
// 「按任务所在建筑」时只用那座建筑里的库存（ESI 资产按位置分）。要用的组件还要造的 → 等组件；T2 没发明完 → 等发明；发明没拷贝 → 等拷贝。
function jobStatus(bars, built) {
  const perLoc = P.stock === 'esi' && P.stockLoc === 'job' && S.assetsLoc;
  const base = new Map(perLoc ? [] : stockMap());
  if (P.running && S.running) for (const [id, q] of S.running) base.set(id, (base.get(id) || 0) + q);
  const pools = new Map();
  const pool = (j) => {
    if (!perLoc) return base;
    const key = j.facId || 0;
    if (!pools.has(key)) {
      const m = new Map(j.facId ? S.assetsLoc.get(j.facId) || [] : []);
      if (P.running && S.running) for (const [id, q] of S.running) m.set(id, (m.get(id) || 0) + q);
      pools.set(key, m);
    }
    return pools.get(key);
  };
  const tops = new Set(bars.filter((b) => b.inv).map((b) => b.top));
  const copies = new Set(bars.filter((b) => b.copy).map((b) => b.top));
  for (const j of bars.slice().sort((a, b) => a.start - b.start || b.depth - a.depth)) {
    if (j.copy) { j.status = 'ready'; j.can = j.runs; continue; }
    if (j.inv && copies.has(j.top)) { j.status = 'copy'; continue; }
    if (!j.inv && j.per.some(([id]) => built.has(id))) { j.status = 'wait'; continue; }
    if (!j.inv && j.depth === 0 && tops.has(j.top)) { j.status = 'invent'; continue; }
    const st = pool(j);
    let can = j.runs;
    const short = [];
    for (const [id, per] of j.per) {
      if (!(per > 0)) continue;
      const n = Math.floor((st.get(id) || 0) / per + 1e-9);
      if (n < j.runs) short.push(id);
      can = Math.min(can, n);
    }
    can = Math.max(0, can);
    for (const [id, per] of j.per) if (per > 0 && can) st.set(id, Math.max(0, (st.get(id) || 0) - per * can));
    j.can = can;
    j.short = short;
    j.status = can >= j.runs ? 'ready' : can > 0 ? 'part' : 'lack';
  }
}

// 产线：手动填条数，或按已绑定的各角色技能（大规模生产 / 高级大规模生产、大规模反应 / 高级大规模反应，各 +1 条/级）
// 并扣掉进行中的任务（产线到任务结束才空出来）
function laneDefs() {
  const KIND = { m: '制造', r: '反应', i: '科研' };
  const manual = (kind, n) => Array.from({ length: Math.max(1, n) }, (_, i) => ({ id: `-:${kind}:${i + 1}`, t: 0, busy: 0, label: `${KIND[kind]} ${i + 1}` }));
  const chars = P.lanes === 'chars' ? (S.chars || []).filter((c) => !c.err && charOn(c.id)) : [];
  if (!chars.length) return { m: manual('m', P.slots), r: manual('r', P.rslots), i: manual('i', P.islots), byChar: false };
  const lanes = (kind) => chars.flatMap((c) => {
    const n = charLanes(c, kind);
    const busy = (kind === 'r' ? c.busyR : kind === 'i' ? c.busyI || [] : c.busyM).slice().sort((a, b) => a - b);
    return Array.from({ length: n }, (_, i) => ({ id: `${c.id}:${kind}:${i + 1}`, t: busy[i] || 0, busy: busy[i] || 0, who: c.id, label: `${c.name} · ${KIND[kind]} ${i + 1}` }));
  });
  const r = lanes('r');
  return { m: lanes('m'), r: r.length ? r : manual('r', P.rslots), i: lanes('i'), byChar: true };
}

// 人物参不参与、各类产线用几条（不超过技能给的条数）
const charOn = (id) => !P.charOff.includes(id);
const charLanes = (c, kind) => Math.max(0, Math.min(c[kind] || 0, P.charMax[c.id]?.[kind] ?? Infinity));

// 自动拆分（同一层、同一种产线的任务）：目标时长 T = max(最长的单个流程, (这层总耗时 + 各产线还要忙的时间) ÷ 产线数)，
// 比 T 长的多流程任务拆成 ⌈耗时 ÷ T⌉ 批（不超过流程数和产线数），流程数尽量平均；时间、安装费按流程数分摊。
// 材料按整单算（拆开后游戏里每个任务分别取整，每种材料最多多 1 个 / 批）
function autoSplit(list, ls, barrier) {
  if (!list.length) return list;
  const busy = ls.reduce((t, l) => t + Math.max(0, l.t - barrier), 0);
  const total = list.reduce((t, j) => t + j.secs, 0) + busy;
  const T = Math.max(...list.map((j) => j.secs / j.runs), total / ls.length);
  const out = [];
  for (const j of list) {
    const n = Math.max(1, Math.min(j.runs, ls.length, Math.ceil(j.secs / T - 1e-9)));
    if (n === 1) { out.push(j); continue; }
    for (let k = 0; k < n; k++) {
      const runs = Math.floor(j.runs / n) + (k < j.runs % n ? 1 : 0);
      out.push({ ...j, runs, secs: j.secs * runs / j.runs, cost: j.cost * runs / j.runs, extra: k ? 0 : j.extra, batch: k + 1, batches: n });
    }
  }
  return out;
}

// 时间轴：深层（先要造的组件）先排，每层等上一层全部完成；每个任务放到最早空出来的产线
function schedule(jobs) {
  const defs = laneDefs();
  const lanes = { m: defs.m.map((l) => ({ ...l })), r: defs.r.map((l) => ({ ...l })), i: defs.i.map((l) => ({ ...l })) };
  const kindOf = (j) => (j.inv || j.copy ? 'i' : j.act === 'r' ? 'r' : 'm');
  const out = [];
  // 手动指定的产线（P.assign）：只在指定的人物 / 那条线上挑；指定的已经不存在（人物不参与、条数改少、换了模式）→ 照常自动排并标出来
  const cand = (j) => {
    const a = P.assign[j.key], ls = lanes[kindOf(j)];
    if (!a) return null;
    const ok = ls.map((l, i) => i).filter((i) => (a.startsWith('l:') ? ls[i].id === a.slice(2) : String(ls[i].who) === a.slice(2)));
    return ok.length ? ok : [];
  };
  const place = (j, from) => {
    const kind = kindOf(j);
    const ls = lanes[kind];
    const c = cand(j);
    const pool = c?.length ? c : ls.map((l, i) => i);
    let k = pool[0];
    for (const i of pool) if (Math.max(ls[i].t, from) < Math.max(ls[k].t, from)) k = i;
    const start = Math.max(ls[k].t, from);
    ls[k].t = start + j.secs;
    out.push({ ...j, kind, lane: k, laneId: ls[k].id, laneLabel: ls[k].label, start, end: start + j.secs, pinned: Boolean(c?.length), lost: Boolean(c && !c.length) });
    return start + j.secs;
  };
  // 自动拆分：指定到某条线的不拆；指定到某个人物的只按他的线拆；其余按全部空闲产线拆
  const split = (list, kind, barrier) => {
    if (!P.auto || !list.length) return list;
    const free = [], res = [];
    for (const j of list) {
      const c = cand(j);
      if (!c?.length) free.push(j);
      else if (P.assign[j.key].startsWith('l:')) res.push(j);
      else res.push(...autoSplit([j], c.map((i) => lanes[kind][i]), barrier));
    }
    return [...autoSplit(free, lanes[kind], barrier), ...res];
  };
  // 发明一开始就在科研产线上做（和组件同时），记下每个产品发明完成的时间
  // 先拷贝 T1 蓝图，拷完才发明
  const invEnd = new Map(), copyEnd = new Map();
  const sci = (list) => (!lanes.i.length ? [] : split(list, 'i', 0)).sort((a, b) => b.secs - a.secs);
  for (const j of sci(jobs.filter((j) => j.copy))) copyEnd.set(j.top, Math.max(copyEnd.get(j.top) || 0, place(j, 0)));
  for (const j of sci(jobs.filter((j) => j.inv))) invEnd.set(j.top, Math.max(invEnd.get(j.top) || 0, place(j, copyEnd.get(j.top) || 0)));
  const levels = [...new Set(jobs.filter((j) => !j.inv && !j.copy).map((j) => j.depth))].sort((a, b) => b - a);
  let barrier = 0;
  for (const d of levels) {
    let levelEnd = barrier;
    let list = jobs.filter((j) => !j.inv && !j.copy && j.depth === d);
    if (P.auto) list = ['m', 'r'].flatMap((kind) => split(list.filter((j) => kindOf(j) === kind), kind, barrier));
    list.sort((a, b) => b.secs - a.secs);
    for (const j of list) levelEnd = Math.max(levelEnd, place(j, d === 0 ? Math.max(barrier, invEnd.get(j.top) || 0) : barrier));
    barrier = levelEnd;
  }
  // 已有任务占着的产线也画出来
  const busy = [];
  for (const kind of ['m', 'r', 'i']) lanes[kind].forEach((l, k) => { if (l.busy) busy.push({ kind, lane: k, laneLabel: l.label, end: l.busy }); });
  return { bars: out, busy, lanes, byChar: defs.byChar, noLab: !lanes.i.length && jobs.some((j) => j.inv || j.copy), span: Math.max(barrier, ...out.map((b) => b.end), ...busy.map((b) => b.end)) };
}

// 正在造的：各已绑定角色（没有多角色时用当前令牌）进行中 / 已完成未交付的制造、反应任务，产出算作库存
async function loadRunning() {
  const accounts = X.ctx.esiAccountList?.() || [];
  const list = accounts.length ? accounts.filter((a) => charOn(a.id)).map((a) => ({ id: a.id, get: (path) => X.ctx.esiAccountFetch(a.id, path) }))
    : X.ctx.hasEsiToken() ? [{ id: X.ctx.readToken()?.character_id, get: (path) => X.ctx.esiAuthFetch(path) }] : [];
  const map = new Map();
  let jobs = 0, fails = 0;
  await Promise.all(list.map(async (a) => {
    try {
      for (const j of (await a.get(`/characters/${a.id}/industry/jobs/`)) || []) {
        if (!['active', 'paused', 'ready'].includes(j.status) || ![1, 9, 11].includes(j.activity_id) || !j.product_type_id) continue;
        const qty = (j.runs || 1) * (X.BP(j.product_type_id)?.[1] || 1);
        map.set(j.product_type_id, (map.get(j.product_type_id) || 0) + qty);
        jobs += 1;
      }
    } catch { fails += 1; }
  }));
  S.running = map;
  S.runningInfo = { jobs, fails, chars: list.length };
  return map;
}

async function loadChars() {
  const list = X.ctx.esiAccountList?.() || [];
  S.chars = await Promise.all(list.map(async (a) => {
    const c = { id: a.id, name: a.name, m: 1, r: 0, i: 1, busyM: [], busyR: [], busyI: [], err: null, jobsErr: null };
    try {
      const sk = await X.ctx.esiAccountFetch(a.id, `/characters/${a.id}/skills/`);
      const L = new Map((sk.skills || []).map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0]));
      c.m = 1 + (L.get(3387) || 0) + (L.get(24625) || 0);
      c.r = L.get(45746) ? 1 + (L.get(45748) || 0) + (L.get(45749) || 0) : 0;   // 没有反应学技能不能做反应
      c.i = 1 + (L.get(3406) || 0) + (L.get(24624) || 0);   // 实验室操作 / 高级实验室操作
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
        else c.busyI.push(left);   // 研究、拷贝、发明
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
  if (P.running && !S.running && X.ctx.hasEsiToken() && P.items.length) {
    body.innerHTML = tabs + '<div class="pi-loading">读取正在造的任务…</div>';
    if (!S.runningLoading) S.runningLoading = loadRunning().finally(() => { S.runningLoading = null; });
    await S.runningLoading;
    if (X.F.tab !== 'plan') return;
  }
  // 自己的蓝图（组件按它的 ME / TE 算）：后台读，读完重画
  if (!S.owned && (X.ctx.hasEsiToken() || pastedBps()) && !S.ownedLoading) loadOwned().then(() => { if (X.F.tab === 'plan' && P.tab === 'plan') X.renderTab(); }).catch(() => {});
  if (P.lanes === 'chars' && !S.chars && P.items.length && (X.ctx.esiAccountList?.() || []).length) {
    body.innerHTML = tabs + '<div class="pi-loading">读取各角色技能与工业任务…</div>';
    if (!S.charsLoading) S.charsLoading = loadChars().finally(() => { S.charsLoading = null; });
    await S.charsLoading;
    if (X.F.tab !== 'plan') return;
  }
  if (!P.items.length) {
    body.innerHTML = tabs + `<div class="pi-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/><path d="M17 15v6M14 18h6"/></svg>
      <p>还没有规划</p><button type="button" class="btn btn-ghost btn-sm" data-plan-fit>粘贴配装</button></div>` + fitPanel() + stockSourceHtml();
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
  for (const { q } of r.on) for (const m of q.rows) if (m.canBuild) buildable.set(m.id, true);
  for (const j of r.jobs) if (j.depth > 0) for (const [id] of X.BP(j.pid)[3]) if (X.BP(id)) buildable.set(id, true);
  const itemRows = r.items.map(({ it, q }, i) => `<tr class="${it.off ? 'is-done' : ''}">
      <td class="ind-plan-on"><input type="checkbox" class="ka-switch" data-plan-on="${i}"${it.off ? '' : ' checked'} title="${it.off ? '已停用：不计入购物清单、产线和合计' : '启用：计入购物清单、产线和合计'}" aria-label="启用"></td>
      <td><div class="pi-prod">${icon(it.pid)}<span>${esc(X.tName(it.pid))}${q.inv ? '<small>发明</small>' : ''}</span></div></td>
      <td class="num"><input type="number" class="pi-input ind-plan-num" min="1" max="100000" value="${it.runs}" data-plan-item="${i}" data-k="runs"></td>
      <td class="num pi-hide-sm">${P.auto ? '<span class="text-muted" title="按空闲产线自动拆分（在「产线时间轴」里可以关掉）">自动</span>' : `<input type="number" class="pi-input ind-plan-num" min="1" max="50" value="${it.split || 1}" data-plan-item="${i}" data-k="split" title="拆成几个任务放到不同产线同时造">`}</td>
      <td class="num pi-hide-sm">${q.act === 'r' ? '—' : `<input type="number" class="pi-input ind-plan-num" min="0" max="10" value="${q.me}" data-plan-item="${i}" data-k="me"> / <input type="number" class="pi-input ind-plan-num" min="0" max="20" step="2" value="${q.te}" data-plan-item="${i}" data-k="te">`}</td>
      <td class="num">${num(q.j.out)}</td>
      <td class="num pi-hide-sm">${isk(q.total)}</td>
      <td class="num pi-hide-sm">${isk(q.revenue)}</td>
      <td class="num ${q.profit >= 0 ? 'up' : 'down'}">${isk(q.profit)}</td>
      <td class="ind-plan-act"><button type="button" class="link-btn" data-plan-open="${i}">计算器</button><button type="button" class="link-btn" data-plan-del="${i}">移除</button></td></tr>`).join('');
  const buildChips = [...buildable.keys()].sort((a, b) => X.tName(a).localeCompare(X.tName(b), 'zh')).map((id) => `<button type="button" class="ind-build-btn${P.build.includes(id) ? ' on' : ''}" data-plan-build="${id}">${esc(X.tName(id))}<small>${P.build.includes(id) ? '自制' : '购买'}</small></button>`).join('');
  const STATUS = { ready: ['可开工', 'up'], part: ['可先开', 'warn'], lack: ['缺料', 'down'], wait: ['等组件', ''], invent: ['等发明', ''], copy: ['等拷贝', ''] };
  const tipOf = (j) => ({ ready: j.copy ? '拷贝不用材料' : '材料齐了（库存 / 在造已抵扣）', part: `库存够先开 ${j.can} 个流程，还缺：${(j.short || []).map((id) => X.tName(id)).join('、')}`,
    lack: `还缺：${(j.short || []).map((id) => X.tName(id)).join('、')}`, wait: '要用的组件还没造好', invent: '拷贝还没发明出来', copy: 'T1 蓝图拷贝还没拷好' }[j.status] || '');
  const facs = new Set(r.schedule.bars.map((j) => j.fac).filter(Boolean));
  const jobRows = r.schedule.bars.slice().sort((a, b) => a.start - b.start || b.depth - a.depth).map((j) => {
    let [st, cls] = STATUS[j.status] || ['', ''];
    if (j.status === 'part') st = `可先开 ${num(j.can)}`;
    return `<tr>
      <td><div class="pi-prod">${j.inv || j.copy ? `<img src="${X.BP_ICON ? X.BP_ICON(j.bp, 32, true) : X.ICON(j.pid)}" alt="" width="20" height="20" loading="lazy">` : icon(j.pid, 20)}<span>${esc(j.inv || j.copy ? X.tName(j.bp) : X.tName(j.pid))}</span></div></td>
      <td>${j.copy ? `拷贝<small class="hc-sub">${esc(X.tName(j.pid))} 发明用 · 每份 ${num(j.copyRuns)} 流程${j.batch ? ` · 第 ${j.batch} / ${j.batches} 批` : ''}</small>` : j.inv ? `发明<small class="hc-sub">${esc(X.tName(j.pid))}${j.batch ? ` · 第 ${j.batch} / ${j.batches} 批` : ''}</small>` : `${j.act === 'r' ? '反应' : '制造'}${j.depth ? `<small class="hc-sub">组件 · 第 ${j.depth} 层${j.batch ? ` · 第 ${j.batch} / ${j.batches} 批` : ''}${j.extra > 0 ? ` · 多出 ${num(j.extra)} 个` : ''}</small>` : j.batch ? `<small class="hc-sub">第 ${j.batch} / ${j.batches} 批</small>` : ''}`}</td>
      <td class="num">${num(j.runs)}${j.inv ? ' 次' : j.copy ? ' 份' : ''}</td><td class="num pi-hide-sm">${j.act === 'r' || j.inv || j.copy ? '—' : `${j.me} / ${j.te}${j.own ? '<small class="hc-sub">我的蓝图</small>' : ''}`}</td>
      <td class="num">${X.fmtTime(j.secs)}</td><td class="num pi-hide-sm">${isk(j.cost)}</td>
      ${facs.size > 1 ? `<td class="pi-hide-sm">${esc(j.fac || '')}</td>` : ''}
      <td class="pi-hide-sm ind-assign">${assignSel(j, r.schedule.lanes)}<small class="hc-sub${j.lost ? ' warn' : ''}">${j.lost ? '指定的产线已不可用，已自动安排 · ' : ''}${esc(j.laneLabel)} · ${j.start ? X.fmtTime(j.start) + ' 后' : '立即'}</small></td>
      <td class="${cls}" title="${esc(tipOf(j))}">${st}</td></tr>`;
  }).join('');
  const isPi = (id) => [42, 43].includes(X.D.data.groups[X.T(id)[2]]?.[1]);   // 行星资源 / 行星产品
  const piShop = r.shop.filter((s) => s.toBuy && isPi(s.id));
  const shopFacs = new Set(r.shop.flatMap((s) => s.to).filter(Boolean));
  const deduct = P.stock !== 'none' || (P.running && S.running?.size);
  const shopRows = r.shop.map((s) => `<tr class="${s.toBuy ? '' : 'is-done'}"><td><div class="pi-prod">${icon(s.id, 20)}<span>${esc(X.tName(s.id))}${s.inv ? '<small title="发明用，费用已算在发明成本里">发明</small>' : ''}${isPi(s.id) ? `<button type="button" class="ind-pi-link" data-plan-pi="${s.id}" title="在行星工业规划里算怎么自己产">行星工业</button>` : ''}</span></div></td>
      <td class="num">${num(s.need)}</td>${deduct ? `<td class="num">${s.have ? num(s.have) : '—'}</td>` : ''}<td class="num"><b>${num(s.toBuy)}</b></td><td class="num">${isk(s.toBuy * s.unit)}</td>${shopFacs.size > 1 ? `<td class="pi-hide-sm ind-shop-to">${esc(s.to.join('、'))}</td>` : ''}</tr>`).join('');
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
      <div class="pi-card-head"><h3>产品</h3>${r.off ? `<span class="text-muted">已停用 ${r.off} 项，不计入购物清单、产线和合计</span>` : ''}<span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-fit title="把游戏里的配装拆成能造的舰船和装备加入规划">粘贴配装</button><button type="button" class="btn btn-ghost btn-sm" data-plan-clear>清空规划</button></div>
      ${fitPanel()}
      <div class="pi-table-wrap"><table class="pi-table ind-plan-items"><thead><tr><th title="停用的产品照样显示成本和利润，但不计入购物清单、产线和合计">启用</th><th>产品</th><th class="num">流程</th><th class="num pi-hide-sm" title="拆成几个任务放到不同产线同时造">分批</th><th class="num pi-hide-sm">ME / TE</th><th class="num">产出</th><th class="num pi-hide-sm">成本</th><th class="num pi-hide-sm">卖出</th><th class="num">利润</th><th></th></tr></thead><tbody>${itemRows}</tbody></table></div>
      ${buildChips ? `<div class="ind-plan-build"><span class="text-muted">组件（点击切换自制 / 购买）：</span><div>${buildChips}</div></div>` : ''}
    </div>
    ${inventHtml(r)}
    ${stockSourceHtml()}
    <div class="pi-card"><div class="pi-card-head"><h3>产线时间轴</h3>${lanesHtml()}</div>
      ${charsHtml()}
      ${ganttHtml(r.schedule)}</div>
    <div class="pi-card"><div class="pi-card-head"><h3>产线启动清单</h3><span class="text-muted">按开工顺序</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="jobs">复制清单</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>产品</th><th>类型</th><th class="num">流程</th><th class="num pi-hide-sm">ME / TE</th><th class="num">时间</th><th class="num pi-hide-sm">安装费</th>${facs.size > 1 ? '<th class="pi-hide-sm">地点</th>' : ''}<th class="num pi-hide-sm">安排</th><th>状态</th></tr></thead><tbody>${jobRows}</tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>购物清单</h3><span class="text-muted">${r.shop.filter((s) => s.toBuy).length} 种要买${piShop.length ? ` · 其中行星工业产品 ${piShop.length} 种共 ${isk(piShop.reduce((t, x) => t + x.toBuy * x.unit, 0))}` : ''}</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="shop" title="可粘贴到游戏多重购买">复制清单</button><button type="button" class="btn btn-ghost btn-sm" data-plan-cart title="要买的材料加入购物车">加入购物车</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>材料</th><th class="num">需要</th>${deduct ? '<th class="num">库存抵扣</th>' : ''}<th class="num">要买</th><th class="num">费用</th>${shopFacs.size > 1 ? '<th class="pi-hide-sm">送到</th>' : ''}</tr></thead><tbody>${shopRows}</tbody></table></div>
      ${r.fromStock.size ? `<p class="pi-note">组件用库存${P.running && S.running?.size ? ' / 在造产出' : ''}抵掉：${[...r.fromStock].map(([id, q]) => `${esc(X.tName(id))} ×${num(q)}`).join('、')}</p>` : ''}</div>`;
}

// 任务安排在哪：自动；按人物时可指定人物（他任意空闲的线）或某条线；手动条数时可指定某条线
function assignSel(j, lanes) {
  const { esc } = X.ctx;
  const ls = lanes[j.kind] || [];
  const cur = P.assign[j.key] || '';
  const opt = (v, l) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  const whos = [...new Set(ls.map((l) => l.who).filter((w) => w != null))];
  let html = opt('', '自动安排');
  if (whos.length) {
    for (const w of whos) {
      const mine = ls.filter((l) => l.who === w);
      const name = S.chars?.find((c) => c.id === w)?.name || String(w);
      html += `<optgroup label="${esc(name)}">${opt('c:' + w, `${name} · 任意空闲的线`)}${mine.map((l) => opt('l:' + l.id, l.label)).join('')}</optgroup>`;
    }
  } else html += ls.map((l) => opt('l:' + l.id, l.label)).join('');
  // 指定的已经不在了：仍显示出来，方便改回
  if (cur && !html.includes(`value="${esc(cur)}" selected`)) html += `<option value="${esc(cur)}" selected>（已不可用）</option>`;
  return `<select class="pi-input ind-assign-sel" data-plan-assign="${esc(j.key)}" title="指定这个任务在哪个人物 / 哪条产线上造${j.batches > 1 ? '（同一任务拆出的各批一起）' : ''}">${html}</select>`;
}

function lanesHtml() {
  const accounts = X.ctx.esiAccountList?.() || [];
  const auto = `<label class="pi-inline" title="多流程的任务（成品和自制组件）按空闲产线自动拆成几批同时造，尽量缩短总时间；关掉后成品按「分批」手动拆，组件不拆"><input type="checkbox" class="ka-switch" data-plan-auto${P.auto ? ' checked' : ''}><span>自动拆分</span></label>`;
  const seg = accounts.length ? `<div class="segmented">${[['manual', '手动'], ['chars', `按人物（${accounts.length}）`]].map(([k, l]) => `<button type="button" data-plan-lanes="${k}" class="${P.lanes === k ? 'active' : ''}">${l}</button>`).join('')}</div>` : '';
  if (accounts.length && P.lanes === 'chars') return auto + seg;
  return `${auto}${seg}<div class="pi-inline"><span>制造产线</span><input type="number" class="pi-input pi-tax" min="1" max="50" value="${P.slots}" data-plan-num="slots"><span>反应产线</span><input type="number" class="pi-input pi-tax" min="1" max="50" value="${P.rslots}" data-plan-num="rslots"><span>科研产线</span><input type="number" class="pi-input pi-tax" min="1" max="100" value="${P.islots}" data-plan-num="islots"></div>`;
}

function charsHtml() {
  if (P.lanes !== 'chars' || !(X.ctx.esiAccountList?.() || []).length) return '';
  const { esc } = X.ctx;
  if (!S.chars) return '<p class="text-muted">读取中…</p>';
  // 每个人物：参不参与（不参与的产线不排、在造的任务不抵库存）；各类产线用几条（最多到技能给的条数）
  const lane = (c, k, name, busy) => (c[k] ? `<label class="ind-char-n">${name}<input type="number" class="pi-input ind-plan-num" min="0" max="${c[k]}" value="${charLanes(c, k)}" data-plan-charmax="${c.id}" data-k="${k}"${charOn(c.id) ? '' : ' disabled'}><small>/ ${c[k]} 条${busy.length ? `，${Math.min(busy.length, c[k])} 条在忙` : ''}</small></label>` : `<span class="ind-char-n text-muted">不能${name}</span>`);
  const rows = S.chars.map((c) => c.err
    ? `<li class="is-err"><b>${esc(c.name)}</b><span>${esc(c.err)}，不参与分配</span></li>`
    : `<li class="${charOn(c.id) ? '' : 'is-off'}"><label class="ind-char-on"><input type="checkbox" class="ka-switch" data-plan-charon="${c.id}"${charOn(c.id) ? ' checked' : ''}><b>${esc(c.name)}</b></label>
      <span>${charOn(c.id) ? `${lane(c, 'm', '制造', c.busyM)}${lane(c, 'i', '科研', c.busyI || [])}${lane(c, 'r', '反应', c.busyR)}${c.jobsErr ? `<small>${esc(c.jobsErr)}</small>` : ''}` : '<span class="text-muted">不参与：产线不排任务，在造的任务也不抵库存</span>'}</span></li>`).join('');
  const noR = S.chars.every((c) => c.err || !charOn(c.id) || !charLanes(c, 'r'));
  return `<ul class="ind-chars">${rows}</ul><p class="pi-note">${noR ? `无人能做反应，按手动 ${P.rslots} 条算。` : ''}<button type="button" class="link-btn" data-plan-chars>重新读取</button></p>`;
}

// 发明进度：已经发明了多少次、成功几张，按二项分布估算还要再发明几次
function inventHtml(r) {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const list = r.items.map(({ it, q }, i) => ({ it, q, i })).filter((x) => x.q.inv && !x.it.off);
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
  return `<div class="pi-card"><div class="pi-card-head"><h3>发明进度</h3><span class="text-muted">按 95% 把握算还要发明几次</span><span class="toolbar-spacer"></span><label class="pi-inline" title="每次发明用掉 T1 蓝图拷贝的 1 个流程。打开：规划里加上拷贝任务（时间和费用）；关掉：已经有足够的拷贝"><input type="checkbox" class="ka-switch" data-plan-copyon${P.copy ? ' checked' : ''}><span>自己拷 T1 蓝图</span></label></div>
    <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>产品</th><th class="num">需要拷贝</th><th class="num">已发明</th><th class="num">已成功</th><th class="num pi-hide-sm">成功率</th><th class="num">进度</th><th class="num">还要发明</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function ganttHtml(sch) {
  const { esc } = X.ctx;
  if (!sch.span) return '<p class="text-muted">没有任务</p>';
  const lanes = new Map();
  const laneOf = (b) => { const key = b.kind + b.lane; if (!lanes.has(key)) lanes.set(key, { kind: b.kind, lane: b.lane, label: b.laneLabel, bars: [], busy: 0 }); return lanes.get(key); };
  for (const b of sch.bars) laneOf(b).bars.push(b);
  for (const b of sch.busy) laneOf(b).busy = b.end;
  const ORD = { i: 0, r: 1, m: 2 };
  const list = [...lanes.values()].sort((a, b) => (a.kind === b.kind ? a.lane - b.lane : ORD[a.kind] - ORD[b.kind]));
  const ticks = 6;
  const axis = Array.from({ length: ticks + 1 }, (_, i) => `<span style="left:${(i / ticks) * 100}%">${X.fmtTime(sch.span * i / ticks)}</span>`).join('');
  return `<div class="ind-gantt${sch.byChar ? ' by-char' : ''}">${list.map((l) => `<div class="ind-gantt-row"><span class="ind-gantt-label" title="${esc(l.label)}">${esc(l.label)}</span><div class="ind-gantt-track">
      ${l.busy ? `<i class="ind-gantt-bar busy" style="left:0;width:${Math.max(0.6, (l.busy / sch.span) * 100)}%" title="已有任务 · ${X.fmtTime(l.busy)} 后空出">已有任务</i>` : ''}
      ${l.bars.map((b) => `<i class="ind-gantt-bar ${b.copy ? 'cp' : b.inv ? 'inv' : 'd' + Math.min(b.depth, 3)}" style="left:${(b.start / sch.span) * 100}%;width:${Math.max(0.6, (b.secs / sch.span) * 100)}%" title="${b.copy ? '拷贝 ' + esc(X.tName(b.bp)) + ' ' : b.inv ? '发明 ' : ''}${esc(X.tName(b.pid))} ×${b.runs}${b.inv ? ' 次' : b.copy ? ' 份' : ''} · ${X.fmtTime(b.secs)}${b.fac ? ' · ' + esc(b.fac) : ''}">${b.copy ? '拷贝 · ' : b.inv ? '发明 · ' : ''}${esc(X.tName(b.pid))}</i>`).join('')}</div></div>`).join('')}
    <div class="ind-gantt-row"><span class="ind-gantt-label"></span><div class="ind-gantt-axis">${axis}</div></div></div>
    <p class="pi-note">组件逐层先造${sch.bars.some((b) => b.inv) ? `，${sch.bars.some((b) => b.copy) ? '先拷 T1 蓝图再发明，' : ''}发明和组件同时在科研产线上做，T2 成品等发明完成才开工` : ''}${P.auto ? '，多流程的任务按空闲产线自动拆批' : ''}${sch.byChar ? '，已扣除进行中的任务' : ''}${sch.noLab ? '。没有角色能做科研，发明没排进时间轴' : ''}</p>`;
}

function stockSourceHtml() {
  const { esc } = X.ctx;
  const esi = X.ctx.hasEsiToken();
  const seg = `<div class="segmented">${[['none', '不扣'], ...(esi ? [['esi', '我的资产（ESI）']] : []), ['paste', '粘贴清单']].map(([k, l]) => `<button type="button" data-plan-stock="${k}" class="${P.stock === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  let extra = '';
  if (P.stock === 'esi') {
    const locs = S.assetsLoc ? [...S.assetsLoc.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 25) : [];
    const locSel = locs.length > 1 ? `<label class="pi-inline" title="只用某个位置的库存；「按任务所在建筑」时每个任务只算它那座建筑里的货（判断能不能开工），购物清单仍按全部库存扣"><span>位置</span><select class="pi-input" data-plan-loc>
        <option value="all"${P.stockLoc === 'all' ? ' selected' : ''}>全部位置</option><option value="job"${P.stockLoc === 'job' ? ' selected' : ''}>按任务所在建筑</option>
        ${locs.map(([id, m]) => `<option value="${id}"${String(P.stockLoc) === String(id) ? ' selected' : ''}>${esc(locName(id))}（${m.size} 种）</option>`).join('')}</select></label>` : '';
    extra = S.assetsErr ? `<p class="pi-note warn">资产读取失败：${esc(S.assetsErr)}</p>` : S.assets ? `<div class="pi-inline ind-stock-loc">${locSel}<span class="pi-note">已读取 ${S.assets.size} 种物品 <button type="button" class="link-btn" data-plan-assets>重新读取</button></span></div>` : '';
  }
  if (P.stock === 'paste') {
    const { map, unknown } = parsePaste(P.paste);
    extra = `<textarea class="pi-input ind-paste" data-plan-paste rows="5" placeholder="每行「物品名  数量」，可直接粘贴游戏仓库 / 机库里复制的物品列表">${esc(P.paste)}</textarea>
      <p class="pi-note">识别 ${map.size} 种${unknown.length ? `，${unknown.length} 行没认出（${esc(unknown.slice(0, 5).join('、'))}${unknown.length > 5 ? ' 等' : ''}）` : ''}</p>`;
  }
  const ri = S.runningInfo;
  const running = esi && P.tab !== 'stock' ? `<label class="pi-inline" title="各角色进行中、已完成还没交付的制造 / 反应任务，产出当作库存先抵扣组件和材料"><input type="checkbox" class="ka-switch" data-plan-running${P.running ? ' checked' : ''}><span>算上正在造的${P.running && ri ? `（${ri.jobs} 个任务 · ${S.running.size} 种产出${ri.fails ? ` · ${ri.fails} 个角色读取失败` : ''}）` : ''}</span></label>${P.running && ri ? '<button type="button" class="link-btn" data-plan-rerun>重新读取</button>' : ''}` : '';
  return `<div class="pi-card ind-stock"><div class="pi-card-head"><h3>库存</h3>${seg}${P.tab === 'stock' ? '' : '<span class="text-muted">从购物清单中扣除</span>'}<span class="toolbar-spacer"></span>${running}</div>${extra}</div>`;
}

// 工业清库：现有材料能造什么
function clearHtml() {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const stock = stockMap();
  if (!stock.size) return '<div class="pi-card"><p class="text-muted">先选择库存来源</p></div>';
  const mulOf = (pid) => { const fac = X.facilityFor('m', pid); return (1 - fac.me / 100) * (1 - (fac.rig.me * X.secMul(X.sysSec(fac.sys))) / 100); };
  const full = [], part = [];
  for (const key of Object.keys(X.D.data.bp)) {
    const pid = Number(key);
    const b = X.BP(pid);
    if (b[5] !== 'm' || !b[3].some(([id]) => stock.has(id))) continue;
    if (!b[7] && !X.invFor(pid)) continue;   // 蓝图拿不到（派系等）
    const unit = X.prodPrice(pid);
    if (!unit || b[3].some(([id]) => !X.matPrice(id))) continue;
    const me = X.invFor(pid) ? 2 : X.F.me;
    const mul = mulOf(pid);
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
    if (t.closest('[data-plan-fit]')) { S.fitOpen = !S.fitOpen; S.fitMsg = null; return 'plan'; }
    const fa = t.closest('[data-plan-fitadd]');
    if (fa) {
      const box = fa.closest('.ind-fit-paste');
      S.fitText = box.querySelector('[data-plan-fittext]').value;
      S.fitN = Math.min(1000, Math.max(1, Math.round(Number(box.querySelector('[data-plan-fitn]').value) || 1)));
      importFit(S.fitText, S.fitN);
      if (!S.fitOpen) S.fitText = '';
      return 'plan';
    }
    const on = t.closest('[data-plan-on]');
    if (on) { const it = P.items[Number(on.dataset.planOn)]; if (on.checked) delete it.off; else it.off = true; savePlan(); return 'plan'; }
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
    if (t.matches('[data-plan-auto]')) { P.auto = t.checked; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-copyon]')) { P.copy = t.checked; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-running]')) { P.running = t.checked; savePlan(); return 'plan'; }
    if (t.closest('[data-plan-rerun]')) { S.running = null; return 'plan'; }
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
        : S.lastPlan.schedule.bars.slice().sort((a, b) => a.start - b.start).map((j) => `${j.inv || j.copy ? X.tName(j.bp) : X.tName(j.pid)}\t${j.runs} ${j.inv ? '次' : j.copy ? `份 × ${j.copyRuns} 流程` : '流程'}\t${j.copy ? '拷贝' : j.inv ? '发明' : j.act === 'r' ? '反应' : '制造'}\t${X.fmtTime(j.secs)}\t${j.laneLabel}\t${j.fac || ''}`).join('\n');
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
    if (n) { P[n.dataset.planNum] = Math.min(100, Math.max(1, Math.round(Number(t.value) || 1))); savePlan(); return 'plan'; }
    if (t.matches('[data-plan-paste]')) { P.paste = t.value; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-loc]')) { P.stockLoc = t.value; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-assign]')) { if (t.value) P.assign[t.dataset.planAssign] = t.value; else delete P.assign[t.dataset.planAssign]; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-charon]')) {
      const id = Number(t.dataset.planCharon);
      P.charOff = t.checked ? P.charOff.filter((x) => x !== id) : [...new Set([...P.charOff, id])];
      S.running = null;   // 在造的任务要按参与的人物重读
      savePlan();
      return 'plan';
    }
    if (t.matches('[data-plan-charmax]')) {
      const id = Number(t.dataset.planCharmax), c = S.chars?.find((x) => x.id === id);
      const k = t.dataset.k, v = Math.max(0, Math.min(c?.[k] ?? 50, Math.round(Number(t.value) || 0)));
      P.charMax[id] = { ...(P.charMax[id] || {}), [k]: v };
      if (c && v >= c[k]) delete P.charMax[id][k];   // 用满 = 不限制（技能升级后自动跟上）
      savePlan();
      return 'plan';
    }
  }
  return null;
}

// ---------- 我的工业：蓝图成本与利润 ----------
export async function mineBlueprintRows(bps, rerender, tag = 'char') {
  const prodOf = new Map(Object.entries(X.D.data.bp).map(([pid, b]) => [b[0], Number(pid)]));
  const rows = bps.map((b) => {
    const pid = prodOf.get(b.type_id);
    if (!pid || X.BP(pid)[5] !== 'm') return { b, pid };
    const me = b.material_efficiency, te = b.time_efficiency;
    const j = X.job(pid, 1, me, te);
    if (j.items.some((it) => X.matPrice(it.id) == null)) return { b, pid };
    // 拷贝且填过「我买的蓝图」：加上每流程的蓝图成本（原图视为已有，不计）
    const bpRun = b.runs > 0 ? X.myBp(pid)?.perRun ?? 0 : 0;
    const cost = j.items.reduce((t, it) => t + it.qty * X.matPrice(it.id) * (1 + X.matFee() / 100), 0) + j.cost + bpRun;
    const unit = X.prodPrice(pid);
    const profit = unit != null ? unit * j.out * (1 - X.sellFee() / 100) - cost : null;
    return { b, pid, perUnit: cost / j.out, profit, ph: profit != null ? profit / (j.secs / 3600) : null };
  });
  // 行情：先用全服均价，后台读交易中心行情后再刷新一次
  S.mineLoaded = S.mineLoaded || new Set();
  if (!S.mineLoaded.has(tag) && rerender) {
    S.mineLoaded.add(tag);
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
  // 每个产品自己最好的一张蓝图（先比 ME 再比 TE），规划和计算器里自制组件按它算
  S.ownedBps = new Map();
  for (const b of list) {
    const pid = prodOf.get(b.type_id);
    if (!pid) continue;
    const cur = S.ownedBps.get(pid);
    const me = b.material_efficiency || 0, te = b.time_efficiency || 0;
    if (!cur || me > cur.me || (me === cur.me && te > cur.te)) S.ownedBps.set(pid, { me, te, bpo: b.runs === -1 });
  }
  // T2：有对应 T1 蓝图也算（可以发明）
  for (const [pid] of Object.entries(X.D.data.bp)) { const inv = X.invFor(Number(pid)); if (inv && set.has(prodOf.get(inv[0]))) set.add(Number(pid)); }
  return set;
}
export const CORP_BP_SCOPE = 'esi-corporations.read_blueprints.v1';
const CORP_TTL = 5 * 60e3;
// 返回 { list, divisions: Map(分部号 -> 名称), corp } 或 { error, noScope }
export function loadCorpBps(force = false) {
  const tk = X.ctx.readToken();
  if (!tk?.access_token) return Promise.resolve(null);
  if (!X.ctx.hasScope(tk, CORP_BP_SCOPE)) return Promise.resolve({ error: '没有军团蓝图权限', noScope: true });
  const cid = tk.character_id;
  const hit = S.corpBps;
  if (!force && hit && hit.cid === cid && Date.now() - hit.at < CORP_TTL) return hit.promise;
  const promise = (async () => {
    const corp = (await X.ctx.fetchESI(`/characters/${cid}/`)).corporation_id;
    const [rows, div] = await Promise.all([
      X.ctx.esiAuthFetchPaged(`/corporations/${corp}/blueprints/`, 50),
      X.ctx.hasScope(tk, 'esi-corporations.read_divisions.v1') ? X.ctx.esiAuthFetch(`/corporations/${corp}/divisions/`).catch(() => null) : null
    ]);
    const merged = new Map();
    for (const b of rows || []) {
      const d = /^CorpSAG(\d)$/.exec(b.location_flag || '')?.[1];
      const division = d ? Number(d) : 0;   // 0：容器里或其他位置
      const k = [b.type_id, b.material_efficiency, b.time_efficiency, b.runs, division].join('|');
      const n = b.quantity > 0 ? b.quantity : 1;
      const m = merged.get(k);
      if (m) m.quantity += n; else merged.set(k, { ...b, quantity: n, division });
    }
    const divisions = new Map((div?.hangar || []).map((h) => [h.division, h.name || '']));
    return { corp, list: [...merged.values()], divisions };
  })().catch((e) => ({ error: /403|forbidden|role/i.test(e.message) ? '读取被拒绝：需要军团董事职位' : e.message }));
  S.corpBps = { cid, at: Date.now(), promise };
  return promise;
}
export function loadOwned() {
  if (!S.ownedLoading) S.ownedLoading = fetchOwned();
  return S.ownedLoading;
}
async function fetchOwned() {
  const corp = (await loadCorpBps()) || {};   // 军团蓝图也算「我有的」
  try {
    const token = await X.ctx.ensureEsiToken();
    // 曙光服登录不支持蓝图权限，令牌里没有就不去请求（与「我的工业」一致）
    if (token.scopes && ![].concat(token.scopes).join(' ').includes('esi-characters.read_blueprints.v1')) throw new Error('未授权蓝图读取权限');
    const list = await X.ctx.esiAuthFetchPaged(`/characters/${token.character_id}/blueprints/`);
    S.owned = ownedFrom([...(list || []), ...(corp.list || [])]);
  } catch (e) {
    // ESI 读不到时用粘贴导入的蓝图
    const pasted = pastedBps();
    if (pasted || corp.list) { S.owned = ownedFrom([...(pasted?.list || []), ...(corp.list || [])]); return S.owned; }
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
  S.owned = null; S.ownedBps = null; S.ownedLoading = null; S.ownedErr = null; S.mineLoaded = false;
}

export const owned = (pid) => Boolean(S.owned?.has(pid));
export const ownedBp = (pid) => S.ownedBps?.get(pid) || null;
export const ownedState = () => ({ ready: Boolean(S.owned), err: S.ownedErr, count: S.owned?.size || 0 });
