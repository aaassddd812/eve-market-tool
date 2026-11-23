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
// 产线时间轴可以拖动微调：任务条拖到同类的另一条产线、或前后挪动，记下指定的产线（P.assign，自动拆出的批按「任务键#批号」单独记）
//   和想要的开工时间（P.prio，只用来排先后），重新排产时依赖关系照旧；双击任务条或「恢复自动安排」清掉。
// 「蓝图」统计：规划里每张要用的蓝图（成品 / 组件 / 反应 / 拷贝用的原图 / 发明用的 T1 拷贝 / 发明出来的 T2 拷贝）要多少流程、
//   按时间轴同时开几个任务（一张蓝图一次只能在一个任务里，同时开几个就要几张），和已绑定的各角色 + 军团蓝图（都读不到时用粘贴导入的）对比，
//   标出没有的、不够的；NPC 有卖原图的给出价格并能跳到「NPC 蓝图」看在哪买。
// 军团蓝图（esi-corporations.read_blueprints.v1，游戏里要董事职位）：/corporations/{id}/blueprints/，同样的蓝图（类型、ME、TE、流程、机库）合并计数；
//   机库分部名称读 /corporations/{id}/divisions/（有军团管理权限时），缓存 5 分钟。「只看我有的蓝图」也算上军团蓝图。
// 「我的工业」蓝图的成本与每小时利润、一键加入规划；利润排行的「技能够造」「我有蓝图」筛选。
// 研究公式：第 n 级时间 = 蓝图基础研究时间 × 等级倍数[n] ÷ 105（倍数 105、250、595、1414、3360、8000、19000、45255、107700、256000），
//   技能冶金学（ME）/ 研究（TE）/ 科学（拷贝）每级 −5%、高级工业理论每级 −3%，植入体 MY / RR / SC，工程复合体同制造的时间加成；
//   费用按产品 EIV × 2% × 时间倍数 ×（研究 / 拷贝指数 × (1 − 建筑减免) + 设施税 + 4% SCC）估算。
let X = null;   // industry.js 传入：ctx, D, F, C, BP, T, tName, invFor, job, invention, calc, matPrice, matFee, prodPrice, sellFee, loadJita, fmtTime, lvl, facilityFor, facTax, SCC, ICON, BP_ICON, selectProduct, renderTab, save, sysSec, secMul, myBp, npcBp（NPC 卖的原图 [价格, 军团]，没读完为 undefined）, loadNpc
const PLAN_KEY = 'eve-industry-plan';
const LEVEL_MUL = [0, 105, 250, 595, 1414, 3360, 8000, 19000, 45255, 107700, 256000];
const SK = { science: 3402, research: 3403, metallurgy: 3409, advIndustry: 3388 };
// assign：任务键（自动拆出的批为「任务键#批号」）→ 指定的产线（'c:人物 ID' = 这个人物任意空闲的线；'l:产线 ID' = 某条线）；
// prio：拖动时放下的开工时间（秒，只用来排先后）；charOff：不参与的人物；charMax：人物各类产线最多用几条；
// fix：手动分批，任务键（成品「t编号:0」、组件「c产品」）→ 拆成几个任务，不管开没开自动拆分都照它拆
const P = { items: [], build: [], slots: 10, rslots: 10, islots: 10, lanes: 'manual', auto: true, stock: 'none', stockLoc: 'all', running: true, copy: true, paste: '', tab: 'plan', assign: {}, prio: {}, fix: {}, charOff: [], charMax: {} };
const FOLD = {};   // 计算器里折叠卡片的展开状态（本次会话内）
const S = { assets: null, assetsErr: null, assetsBusy: false, owned: null, ownedLoading: null, chars: null, charsLoading: null, bpStock: null, bpStockLoading: null };   // bpStock：「蓝图」统计用的我有的蓝图   // chars：按人物分配产线时各角色的产线数与进行中的任务

export function initPlan(api) {
  X = api;
  Object.assign(P, X.ctx.store.getJSON(PLAN_KEY, {}) || {});
  P.items = (P.items || []).filter((it) => X.BP(it.pid));
  // 每个产品一个固定编号（任务键用，删掉前面的产品不会让指定的产线错位）
  let u = Math.max(0, ...P.items.map((it) => it.uid || 0));
  for (const it of P.items) if (!it.uid) it.uid = ++u;
  P.assign ||= {}; P.prio ||= {}; P.fix ||= {}; P.charOff ||= []; P.charMax ||= {};
  // 旧版的成品「分批」（it.split，只在关掉自动拆分时用，任务键是「t编号:批号」）改成手动分批，指定的产线跟着换成新的批键
  for (const it of P.items) {
    if (it.split > 1 && !P.auto) {
      P.fix[`t${it.uid}:0`] = it.split;
      for (const m of [P.assign, P.prio]) for (let k = 1; k <= it.split; k++) if (m[`t${it.uid}:${k}`] != null) { m[`t${it.uid}:0#${k}`] = m[`t${it.uid}:${k}`]; delete m[`t${it.uid}:${k}`]; }
    }
    delete it.split;
  }
}
const nextUid = () => Math.max(0, ...P.items.map((it) => it.uid || 0)) + 1;
const savePlan = () => X.ctx.store.setJSON(PLAN_KEY, { items: P.items, build: P.build, slots: P.slots, rslots: P.rslots, islots: P.islots, lanes: P.lanes, auto: P.auto, stock: P.stock, stockLoc: P.stockLoc, running: P.running, copy: P.copy, paste: P.paste, tab: P.tab, assign: P.assign, prio: P.prio, fix: P.fix, charOff: P.charOff, charMax: P.charMax });
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
    // 分批（手动分批 P.fix 或自动拆分）由排产时拆：拆成几个任务放到不同产线同时造，时间与安装费按流程数等比例分摊
    jobs.push({ key: `t${it.uid}:0`, pid: it.pid, runs: q.runs, secs: q.j.secs, cost: q.j.cost, act: q.act, depth: 0, me: q.me, te: q.te, top: i, cap: q.act === 'r' ? formulas(it.pid) : 0, fac: q.j.fac, facId: q.j.facId, mats: q.j.items.map((m) => m.id), per: q.j.items.map((m) => [m.id, m.qty / q.runs]) });
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
    jobs.push({ key: `c${id}`, pid: id, runs, secs: j.secs, cost: j.cost, act: b[5], depth: d, me, te, own: Boolean(own), cap: b[5] === 'r' ? formulas(id) : 0, extra: Math.floor(runs * b[1] - want), fac: j.fac, facId: j.facId, mats: j.items.map((m) => m.id), per: j.items.map((m) => [m.id, m.qty / runs]) });
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
// 读到的我有的反应配方张数（没读到 / 没有为 0）：配方不能拷贝，自动拆分同时开的反应任务不超过这个数
const formulas = (pid) => (S.bpStock?.ready ? S.bpStock.map.get(X.BP(pid)[0])?.bpo || 0 : 0);
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

// 把一个任务拆成 n 批，流程数尽量平均；时间、安装费按流程数分摊。
// 材料按整单算（拆开后游戏里每个任务分别取整，每种材料最多多 1 个 / 批）
function splitJob(j, n) {
  if (n <= 1) return [j];
  return Array.from({ length: n }, (_, k) => {
    const runs = Math.floor(j.runs / n) + (k < j.runs % n ? 1 : 0);
    return { ...j, bkey: `${j.key}#${k + 1}`, runs, all: j.runs, secs: j.secs * runs / j.runs, cost: j.cost * runs / j.runs, extra: k ? 0 : j.extra, batch: k + 1, batches: n };
  });
}
// 自动拆分（同一层、同一种产线的任务）：目标时长 T = max(最长的单个流程, (这层总耗时 + 各产线还要忙的时间) ÷ 产线数)，
// 比 T 长的多流程任务拆成 ⌈耗时 ÷ T⌉ 批（不超过流程数、产线数，反应不超过我有的配方张数 j.cap）；
// other：这层同类产线上不参与自动拆分的任务（手动分批的、指定了产线的）的耗时，也算进总耗时
function autoSplit(list, ls, barrier, other = 0) {
  if (!list.length) return list;
  const busy = ls.reduce((t, l) => t + Math.max(0, l.t - barrier), 0);
  const total = list.reduce((t, j) => t + j.secs, 0) + busy + other;
  const T = Math.max(...list.map((j) => j.secs / j.runs), total / ls.length);
  return list.flatMap((j) => splitJob(j, Math.max(1, Math.min(j.runs, ls.length, j.cap || Infinity, Math.ceil(j.secs / T - 1e-9)))));
}

// 时间轴：深层（先要造的组件）先排，每层等上一层全部完成；每个任务放到最早空出来的产线。
// 拖动过的任务（P.prio）：先照常排一遍，再按「拖到的开工时间 / 其他任务排出的开工时间」排先后重放一遍（开工仍取那条线最早空出来的时候）
const bk = (j) => j.bkey || j.key;
function schedule(jobs) {
  const first = scheduleOnce(jobs, null);
  if (!first.bars.some((b) => P.prio[bk(b)] != null)) return first;
  return scheduleOnce(jobs, new Map(first.bars.map((b) => [bk(b), P.prio[bk(b)] ?? b.start])));
}
function scheduleOnce(jobs, order) {
  const defs = laneDefs();
  const lanes = { m: defs.m.map((l) => ({ ...l })), r: defs.r.map((l) => ({ ...l })), i: defs.i.map((l) => ({ ...l })) };
  const kindOf = (j) => (j.inv || j.copy ? 'i' : j.act === 'r' ? 'r' : 'm');
  const out = [];
  // 手动指定的产线（P.assign）：只在指定的人物 / 那条线上挑；指定的已经不存在（人物不参与、条数改少、换了模式）→ 照常自动排并标出来
  const pinOf = (j) => P.assign[bk(j)] || P.assign[j.key];
  const cand = (j) => {
    const a = pinOf(j), ls = lanes[kindOf(j)];
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
    out.push({ ...j, bkey: bk(j), kind, lane: k, laneId: ls[k].id, laneLabel: ls[k].label, start, end: start + j.secs, pinned: Boolean(c?.length), lost: Boolean(c && !c.length) });
    return start + j.secs;
  };
  // 手动分批（P.fix）的照填的拆；其余自动拆分：指定到某条线的不拆；指定到某个人物的只按他的线拆；其余按全部空闲产线拆
  const split = (list, kind, barrier) => {
    if (!list.length) return list;
    const free = [], res = [];
    for (const j of list) {
      const n = P.fix[j.key];
      if (n) res.push(...splitJob(j, Math.min(n, j.runs)).map((b) => ({ ...b, fixed: true })));
      else if (!P.auto) res.push(j);
      else {
        const c = cand(j);
        if (!c?.length) free.push(j);
        else if (pinOf(j).startsWith('l:')) res.push(j);
        else res.push(...autoSplit([j], c.map((i) => lanes[kind][i]), barrier));
      }
    }
    return [...autoSplit(free, lanes[kind], barrier, res.reduce((t, j) => t + j.secs, 0)), ...res];
  };
  // 发明一开始就在科研产线上做（和组件同时），记下每个产品发明完成的时间
  // 先拷贝 T1 蓝图，拷完才发明
  const invEnd = new Map(), copyEnd = new Map();
  // 先后：有拖动过的按 order（同一时间时拖动过的在前），否则长的先排
  const cmp = order ? (a, b) => (order.get(bk(a)) ?? Infinity) - (order.get(bk(b)) ?? Infinity) || (P.prio[bk(b)] != null) - (P.prio[bk(a)] != null) || b.secs - a.secs
    : (a, b) => b.secs - a.secs;
  const sci = (list) => (!lanes.i.length ? [] : split(list, 'i', 0)).sort(cmp);
  for (const j of sci(jobs.filter((j) => j.copy))) copyEnd.set(j.top, Math.max(copyEnd.get(j.top) || 0, place(j, 0)));
  for (const j of sci(jobs.filter((j) => j.inv))) invEnd.set(j.top, Math.max(invEnd.get(j.top) || 0, place(j, copyEnd.get(j.top) || 0)));
  const levels = [...new Set(jobs.filter((j) => !j.inv && !j.copy).map((j) => j.depth))].sort((a, b) => b - a);
  let barrier = 0;
  for (const d of levels) {
    let levelEnd = barrier;
    let list = jobs.filter((j) => !j.inv && !j.copy && j.depth === d);
    list = ['m', 'r'].flatMap((kind) => split(list.filter((j) => kindOf(j) === kind), kind, barrier));
    list.sort(cmp);
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

// 「蓝图」统计用的我有的蓝图：已绑定的各角色（参与规划的；只有当前令牌时用它）+ 军团蓝图，角色蓝图都没读到时用粘贴导入的。
// 按蓝图类型汇总原图张数、拷贝张数、拷贝剩余流程（ESI quantity > 0 是一叠没动过的原图）
const BP_SCOPE = 'esi-characters.read_blueprints.v1';
async function loadBpStock() {
  const ctx = X.ctx;
  const accounts = (ctx.esiAccountList?.() || []).filter((a) => charOn(a.id));
  const list = [];
  const src = { chars: 0, noScope: 0, fail: 0, corp: false, pasted: false };
  const read = async (id, token) => {
    if (!ctx.hasScope(token, BP_SCOPE)) { src.noScope += 1; return; }
    try { list.push(...((await ctx.esiAuthFetchPaged(`/characters/${id}/blueprints/`, 20, id)) || [])); src.chars += 1; } catch { src.fail += 1; }
  };
  if (accounts.length) await Promise.all(accounts.map((a) => read(a.id, a)));
  else if (ctx.hasEsiToken()) { const tk = ctx.readToken(); await read(tk.character_id, tk); }
  const corp = await loadCorpBps();
  if (corp?.list) { list.push(...corp.list); src.corp = true; }
  const pasted = src.chars ? null : pastedBps();
  if (pasted) { list.push(...pasted.list); src.pasted = true; }
  const map = new Map();
  for (const b of list) {
    const n = b.quantity > 0 ? b.quantity : 1;
    const h = map.get(b.type_id) || { bpo: 0, bpc: 0, runs: 0 };
    if (b.runs === -1) h.bpo += n; else { h.bpc += n; h.runs += Math.max(0, b.runs || 0) * n; }
    map.set(b.type_id, h);
  }
  S.bpStock = { map, src, ready: Boolean(src.chars || src.corp || src.pasted) };
  return S.bpStock;
}

// ---------- 规划页 ----------
const planTabs = () => `<div class="segmented ind-plan-tabs">${[['plan', '制造规划'], ['stock', '库存可造']].map(([k, l]) => `<button type="button" data-plan-tab="${k}" class="${P.tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
export async function renderPlan(body) {
  const tabs = planTabs();
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
  // 「蓝图」统计：各角色 + 军团蓝图、NPC 卖的原图，后台读，读完重画
  if (P.items.length && !S.bpStock && !S.bpStockLoading && (X.ctx.hasEsiToken() || (X.ctx.esiAccountList?.() || []).length || pastedBps())) {
    S.bpStockLoading = loadBpStock().catch(() => { S.bpStock = { map: new Map(), src: { chars: 0, noScope: 0, fail: 1 }, ready: false }; })
      .finally(() => { S.bpStockLoading = null; if (X.F.tab === 'plan' && P.tab === 'plan') X.renderTab(); });
  }
  if (P.items.length && X.npcBp(0) === undefined && !S.npcWait) { S.npcWait = true; X.loadNpc().then(() => { if (X.F.tab === 'plan' && P.tab === 'plan') X.renderTab(); }); }
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
      <td class="num pi-hide-sm">${fixInput(`t${it.uid}:0`, r.schedule.bars.find((b) => b.key === `t${it.uid}:0`), q.runs)}</td>
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
      <td class="num">${num(j.runs)}${j.inv ? ' 次' : j.copy ? ' 份' : ''}</td>
      <td class="num pi-hide-sm ind-fix">${j.batch > 1 ? '' : `${fixInput(j.key, j, j.all ?? j.runs)}<small class="hc-sub">${P.fix[j.key] ? (P.auto ? `<button type="button" class="link-btn" data-plan-unfix="${esc(j.key)}" title="清掉手动分批，按自动拆分">恢复自动</button>` : `<button type="button" class="link-btn" data-plan-unfix="${esc(j.key)}" title="清掉手动分批，这个任务不拆">改回不拆</button>`) : P.auto ? (j.cap ? `自动 · 有 ${num(j.cap)} 张配方` : '自动') : '不拆'}</small>`}</td><td class="num pi-hide-sm">${j.act === 'r' || j.inv || j.copy ? '—' : `${j.me} / ${j.te}${j.own ? '<small class="hc-sub">我的蓝图</small>' : ''}`}</td>
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
      <div class="pi-table-wrap"><table class="pi-table ind-plan-items"><thead><tr><th title="停用的产品照样显示成本和利润，但不计入购物清单、产线和合计">启用</th><th>产品</th><th class="num">流程</th><th class="num pi-hide-sm" title="拆成几个任务放到不同产线同时造。空着 = 自动（灰色数字是自动拆出的批数）；填了就照填的拆，清空恢复自动">分批</th><th class="num pi-hide-sm">ME / TE</th><th class="num">产出</th><th class="num pi-hide-sm">成本</th><th class="num pi-hide-sm">卖出</th><th class="num">利润</th><th></th></tr></thead><tbody>${itemRows}</tbody></table></div>
      ${buildChips ? `<div class="ind-plan-build"><span class="text-muted">组件（点击切换自制 / 购买）：</span><div>${buildChips}</div></div>` : ''}
    </div>
    ${inventHtml(r)}
    ${bpHtml(r)}
    ${stockSourceHtml()}
    <div class="pi-card"><div class="pi-card-head"><h3>产线时间轴</h3>${lanesHtml()}${unpinHtml(r.schedule)}</div>
      ${charsHtml()}
      ${ganttHtml(r.schedule)}</div>
    <div class="pi-card"><div class="pi-card-head"><h3>产线启动清单</h3><span class="text-muted">按开工顺序</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="jobs">复制清单</button></div>
      <div class="pi-table-wrap"><table class="pi-table ind-jobs"><thead><tr><th>产品</th><th>类型</th><th class="num">流程</th><th class="num pi-hide-sm" title="这个任务拆成几个同时造。空着 = 自动（灰色数字是自动拆出的批数）；填了就照填的拆，清空恢复自动">分批</th><th class="num pi-hide-sm">ME / TE</th><th class="num">时间</th><th class="num pi-hide-sm">安装费</th>${facs.size > 1 ? '<th class="pi-hide-sm">地点</th>' : ''}<th class="num pi-hide-sm">安排</th><th>状态</th></tr></thead><tbody>${jobRows}</tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>购物清单</h3><span class="text-muted">${r.shop.filter((s) => s.toBuy).length} 种要买${piShop.length ? ` · 其中行星工业产品 ${piShop.length} 种共 ${isk(piShop.reduce((t, x) => t + x.toBuy * x.unit, 0))}` : ''}</span><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-plan-copy="shop" title="可粘贴到游戏多重购买">复制清单</button><button type="button" class="btn btn-ghost btn-sm" data-plan-cart title="要买的材料加入购物车">加入购物车</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>材料</th><th class="num">需要</th>${deduct ? '<th class="num">库存抵扣</th>' : ''}<th class="num">要买</th><th class="num">费用</th>${shopFacs.size > 1 ? '<th class="pi-hide-sm">送到</th>' : ''}</tr></thead><tbody>${shopRows}</tbody></table></div>
      ${r.fromStock.size ? `<p class="pi-note">组件用库存${P.running && S.running?.size ? ' / 在造产出' : ''}抵掉：${[...r.fromStock].map(([id, q]) => `${esc(X.tName(id))} ×${num(q)}`).join('、')}</p>` : ''}</div>`;
  S.body = body;
  bindGantt(body);
}

// 分批输入框（成品表、启动清单共用）：填了 = 手动分批（P.fix）；空着 = 自动，灰色数字是排产自动拆出的批数。
// bar：这个任务排出来的一批（没排上为空）；runs：任务总流程数（最多拆这么多批）
function fixInput(key, bar, runs) {
  const { esc } = X.ctx;
  const v = P.fix[key], now = bar?.batches || 1;
  const tip = v ? '手动分批：清空恢复自动' : !P.auto ? '没开自动拆分：不填就不拆，填几就拆成几个任务同时造'
    : bar?.cap ? `自动拆成 ${now} 批，反应配方不能拷贝，同时开的不超过你有的 ${bar.cap} 张；填几就拆成几个任务同时造` : `自动拆成 ${now} 批；填几就拆成几个任务同时造`;
  return `<input type="number" class="pi-input ind-plan-num" min="1" max="${Math.max(1, Math.min(50, runs))}" value="${v || ''}" placeholder="${now}" data-plan-fix="${esc(key)}" title="${esc(tip)}" aria-label="分批">`;
}

// 任务安排在哪：自动；按人物时可指定人物（他任意空闲的线）或某条线；手动条数时可指定某条线
function assignSel(j, lanes) {
  const { esc } = X.ctx;
  const ls = lanes[j.kind] || [];
  const k = bk(j), cur = P.assign[k] || P.assign[j.key] || '';
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
  return `<select class="pi-input ind-assign-sel" data-plan-assign="${esc(k)}" title="指定这个任务在哪个人物 / 哪条产线上造">${html}</select>`;
}

function lanesHtml() {
  const accounts = X.ctx.esiAccountList?.() || [];
  const auto = `<label class="pi-inline" title="多流程的任务（成品和自制组件）按空闲产线自动拆成几批同时造，尽量缩短总时间；反应配方不能拷贝，读到配方张数时同时开的反应不超过张数。填了「分批」的照填的拆，关掉后没填的都不拆"><input type="checkbox" class="ka-switch" data-plan-auto${P.auto ? ' checked' : ''}><span>自动拆分</span></label>`;
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

// ---------- 蓝图统计 ----------
// 规划要用的蓝图按蓝图类型合并：runs 制造 / 反应流程，copyJobs / copies 拷贝任务数和要拷的份数（拷贝只能用原图），
// invRuns 发明要用掉的 T1 拷贝流程（没排拷贝任务时要自己已有），t2 发明出来的 T2 拷贝；
// par 按时间轴同时在做的任务数（一张蓝图一次只能在一个任务里，同时开几个就要几张）
const maxOverlap = (spans) => {
  const ev = spans.flatMap(([s, e]) => [[s, 1], [e, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0, m = 0;
  for (const [, d] of ev) { c += d; m = Math.max(m, c); }
  return m;
};
function bpNeeds(r) {
  const map = new Map();
  const get = (bpId, pid) => {
    if (!map.has(bpId)) map.set(bpId, { bpId, pid, uses: new Set(), forIds: new Set(), runs: 0, copyJobs: 0, copies: 0, invAll: 0, invRuns: 0, t2: null, spans: [] });
    return map.get(bpId);
  };
  for (const { it, q } of r.on) {
    if (!q.inv) continue;
    const e = get(X.BP(it.pid)[0], it.pid);
    const need = Math.ceil(q.runs / q.inv.runs);
    e.uses.add('t2');
    e.t2 ||= { need: 0, runs: 0, left: 0, per: q.inv.runs };
    e.t2.need += need; e.t2.runs += q.runs; e.t2.left += Math.max(0, need - (it.invGot || 0));
  }
  for (const j of r.jobs) {
    if (j.copy || j.inv) {
      const e = get(j.bp, t1Prod(j.bp) || j.pid);
      e.uses.add('inv');
      e.forIds.add(j.pid);
      if (j.copy) { e.copyJobs += 1; e.copies += j.runs; } else e.invAll += j.runs;
      continue;
    }
    if (j.depth === 0 && r.items[j.top]?.q.inv) continue;   // T2 成品用发明出来的拷贝（上面算了）
    const e = get(X.BP(j.pid)[0], j.pid);
    e.uses.add(j.act === 'r' ? 'r' : j.depth > 0 ? 'comp' : 'prod');
    e.runs += j.runs;
  }
  for (const b of r.schedule.bars) {
    if (b.inv || (!b.copy && b.depth === 0 && r.items[b.top]?.q.inv)) continue;
    const e = map.get(b.copy ? b.bp : X.BP(b.pid)[0]);
    if (e) e.spans.push([b.start, b.end]);
  }
  for (const e of map.values()) {
    if (!e.copyJobs) e.invRuns = e.invAll;   // 没排拷贝任务：发明用的拷贝要自己已经有
    e.par = Math.max(e.runs || e.copyJobs ? 1 : 0, maxOverlap(e.spans));
  }
  return [...map.values()];
}
// 我有的够不够（h 为空 = 没读到我有的蓝图）；miss：none 完全没有、short 有但不够；
// buy：反应配方还要买几张（配方不能拷贝，同时开几个任务就要几张）
const BP_TIP = {
  slots: '一张蓝图一次只能在一个任务里，同时开几个任务就要几张。可以用原图多拷几份，或者在「产线启动清单」把分批调少',
  react: '反应配方不能拷贝，同时开几个反应任务就要几张配方。可以再买几张，或者在「产线启动清单」把分批调少',
  orig: '拷贝只能用原图',
  runs: '拷贝剩下的流程加起来不够'
};
function bpState(e, h) {
  const num = X.ctx.formatNumber;
  if (e.t2 && e.uses.size === 1) {
    if (h && h.runs >= e.t2.runs) return { text: '已够', cls: 'up', tip: '已有的 T2 拷贝流程够了，可以在「发明进度」里填上已成功的张数，就不用再发明' };
    return e.t2.left ? { text: `发明 ${num(e.t2.left)} 张`, cls: '', tip: '在「发明进度」里按 95% 把握算了要发明几次' } : { text: '已够', cls: 'up', tip: '已经发明够了' };
  }
  if (!h) return null;
  if (e.uses.has('r')) {
    if (!h.bpo) return { text: '还没有', cls: 'down', miss: 'none', buy: Math.max(1, e.par), tip: e.par > 1 ? BP_TIP.react : '' };
    if (e.par <= h.bpo) return { text: '已够', cls: 'up' };
    return { text: `还差 ${num(e.par - h.bpo)} 张配方`, cls: 'warn', miss: 'short', buy: e.par - h.bpo, tip: BP_TIP.react };
  }
  if (!h.bpo && !h.bpc) return { text: '还没有', cls: 'down', miss: 'none' };
  const short = [], tips = [];
  if (e.copyJobs && !h.bpo) { short.push('缺原图'); tips.push(BP_TIP.orig); }
  const copyNeed = (h.bpo ? 0 : e.runs) + e.invRuns;   // 要用拷贝出的流程：没有原图时的制造流程 + 发明用掉的
  const runsShort = copyNeed > h.runs;
  if (runsShort) { short.push(`拷贝还差 ${num(copyNeed - h.runs)} 流程`); tips.push(BP_TIP.runs); }
  if (e.par > h.bpo + h.bpc && !(runsShort && !h.bpo)) { short.push(`还差 ${num(e.par - h.bpo - h.bpc)} 张蓝图`); tips.push(BP_TIP.slots); }
  if (!short.length) return { text: '已够', cls: 'up' };
  return { text: short.join(' · '), parts: short, cls: short[0] === '缺原图' ? 'down' : 'warn', miss: 'short', tip: tips.join(' · ') };
}
// 蓝图名：英文界面直接用英文名（T2 蓝图不在英文名称表里，按中文逐段翻会拼错），并标上不翻译
const bpName = (id) => (window.I18N?.lang === 'en' && X.T(id)?.[1]) || X.tName(id);
function bpHtml(r) {
  const { esc, formatISK: isk, formatNumber: num } = X.ctx;
  const list = bpNeeds(r);
  if (!list.length) return '';
  const st = S.bpStock, ready = Boolean(st?.ready), src = st?.src || {};
  const rows = list.map((e) => {
    const h = ready ? st.map.get(e.bpId) || { bpo: 0, bpc: 0, runs: 0 } : null;
    return { e, h, s: bpState(e, h) };
  });
  const rank = (x) => (x.s?.miss === 'none' ? 0 : x.s?.miss === 'short' ? 1 : x.s?.cls === 'up' ? 3 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || bpName(a.e.bpId).localeCompare(bpName(b.e.bpId), 'zh'));
  const none = rows.filter((x) => x.s?.miss === 'none'), short = rows.filter((x) => x.s?.miss === 'short');
  S.lastBps = [...none, ...short];
  const npcOf = (x) => (x.s?.miss === 'none' || x.s?.buy || x.s?.text.includes('缺原图') ? X.npcBp(x.e.bpId) || null : null);
  // 缺的 NPC 有卖的：原图买一张（再拷贝），反应配方按还差的张数买
  const npc = rows.map((x) => [npcOf(x), x.s?.buy || 1]).filter(([n]) => n);
  const USE = { prod: '成品', comp: '组件', r: '反应', inv: '发明用', t2: '发明得到' };
  const dots = (list) => list.filter(Boolean).map((x) => `<span>${x}</span>`).join(' · ');   // 每段单独翻译（整行一起翻会被宽泛的句式误配）
  const body = rows.map(({ e, h, s }) => {
    const t2 = e.t2 && e.uses.size === 1;
    const need = t2 ? `拷贝 ${num(e.t2.need)} 张<small class="hc-sub">每张 ${num(e.t2.per)} 流程</small>`
      : [e.runs ? `${num(e.runs)} 流程${e.par > 1 ? `<small class="hc-sub">同时 ${num(e.par)} 个任务</small>` : ''}` : '',
        e.copyJobs ? `原图${e.par > 1 && !e.runs ? ` ${num(e.par)} 张` : ''}<small class="hc-sub">拷 ${num(e.copies)} 份给发明</small>` : '',
        e.invRuns ? `拷贝 ${num(e.invRuns)} 流程<small class="hc-sub">发明 ${num(e.invRuns)} 次</small>` : ''].filter(Boolean).join('<br>');
    const have = !ready ? (S.bpStockLoading ? '…' : '—') : !h.bpo && !h.bpc ? '—'
      : [h.bpo ? `${e.uses.has('r') ? '配方' : '原图'} ×${num(h.bpo)}` : '', h.bpc ? `拷贝 ×${num(h.bpc)}<small class="hc-sub">共 ${num(h.runs)} 流程</small>` : ''].filter(Boolean).join('<br>');
    const n = npcOf({ e, s });
    return `<tr>
      <td><div class="pi-prod"><img src="${X.BP_ICON(e.bpId, 32, t2)}" alt="" width="24" height="24" loading="lazy"><span translate="no">${esc(bpName(e.bpId))}</span></div></td>
      <td class="pi-hide-sm">${Object.keys(USE).filter((u) => e.uses.has(u)).map((u) => USE[u] + (u === 'inv' ? `<small class="hc-sub">${[...e.forIds].map((id) => esc(X.tName(id))).join(' · ')}</small>` : '')).join('<br>')}</td>
      <td class="num">${need}</td><td class="num">${have}</td>
      <td class="${s?.cls || ''}"${s?.tip ? ` title="${esc(s.tip)}"` : ''}>${s ? (s.parts ? dots(s.parts) : s.text) : '—'}${n ? `<small class="hc-sub"><button type="button" class="link-btn" data-npc-bp="${e.bpId}" title="在「NPC 蓝图」里看哪些空间站有卖">NPC 卖 ${isk(n[0])}${s.buy > 1 ? ` × ${num(s.buy)}` : ''}</button></small>` : s?.miss === 'none' && X.invFor(e.pid) ? '<small class="hc-sub">可以发明</small>' : ''}</td></tr>`;
  }).join('');
  const head = dots([`用到 ${num(list.length)} 种`, ...(ready ? (none.length || short.length ? [none.length ? `缺 ${num(none.length)} 种` : '', short.length ? `${num(short.length)} 种不够` : ''] : ['都有了']) : [S.bpStockLoading ? '读取蓝图…' : ''])]);
  const who = src.chars ? (src.corp ? `按 ${num(src.chars)} 个角色和军团的蓝图算` : `按 ${num(src.chars)} 个角色的蓝图算`)
    : src.pasted ? (src.corp ? '按粘贴的蓝图列表和军团的蓝图算' : '按粘贴的蓝图列表算') : src.corp ? '按军团的蓝图算' : '';
  const warn = [src.noScope ? (X.server === 'infinity' ? '曙光服不支持蓝图权限' : `${num(src.noScope)} 个角色没授权读取蓝图`) : '', src.fail ? `${num(src.fail)} 个角色读取失败` : ''];
  const notes = [
    ready ? `<p class="pi-note">${dots([who, ...warn])}</p>`
      : !S.bpStockLoading ? `<p class="pi-note">${dots([...warn, X.server === 'infinity' ? '在「我的工业」粘贴游戏里的蓝图列表，就能对比出缺几张' : '绑定 ESI 并授权读取蓝图，或者在「我的工业」粘贴游戏里的蓝图列表，就能对比出缺几张'])} <button type="button" class="link-btn" data-ind-tab="mine">去粘贴</button></p>` : '',
    rows.some((x) => x.e.par > 1 && !x.e.uses.has('r')) ? `<p class="pi-note">${BP_TIP.slots}</p>` : '',
    rows.some((x) => x.e.par > 1 && x.e.uses.has('r')) ? `<p class="pi-note">${BP_TIP.react}</p>` : '',
    npc.length ? `<p class="pi-note">${npc.some(([, k]) => k > 1) ? `缺的原图和配方 NPC 有卖 ${num(npc.length)} 种，买够共 ${isk(npc.reduce((t, [n, k]) => t + n[0] * k, 0))}（配方按还差的张数算）`
      : `缺的原图 NPC 有卖 ${num(npc.length)} 种，各买一张共 ${isk(npc.reduce((t, [n]) => t + n[0], 0))}`}</p>` : ''
  ].join('');
  return `<div class="pi-card"><div class="pi-card-head"><h3>蓝图</h3><span class="text-muted">${head}</span><span class="toolbar-spacer"></span>${st && !S.bpStockLoading ? '<button type="button" class="btn btn-ghost btn-sm" data-plan-bpreload>重新读取</button>' : ''}${S.lastBps.length ? '<button type="button" class="btn btn-ghost btn-sm" data-plan-copy="bps" title="复制没有的和不够的蓝图">复制缺的</button>' : ''}</div>
    <div class="pi-table-wrap"><table class="pi-table ind-bp-table"><thead><tr><th>蓝图</th><th class="pi-hide-sm">用途</th><th class="num">需要</th><th class="num">我有</th><th>状态</th></tr></thead><tbody>${body}</tbody></table></div>${notes}</div>`;
}

// 时间轴：用到的每类产线全部列出来（空的线也能拖进去）；任务条可以拖动（见 bindGantt）
function ganttHtml(sch) {
  const { esc } = X.ctx;
  if (!sch.span) return '<p class="text-muted">没有任务</p>';
  const kinds = ['i', 'r', 'm'].filter((k) => sch.bars.some((b) => b.kind === k) || sch.busy.some((b) => b.kind === k));
  const ticks = 6;
  const axis = Array.from({ length: ticks + 1 }, (_, i) => `<span style="left:${(i / ticks) * 100}%">${X.fmtTime(sch.span * i / ticks)}</span>`).join('');
  const bar = (b) => {
    const k = bk(b), pin = Boolean(P.assign[k] || P.prio[k] != null);
    // 每段先各自翻译再拼（整句交给自动翻译会被「{0} 小时{1}」这类宽泛句式误配）
    const tip = [`${b.copy ? '拷贝 ' + X.tName(b.bp) + ' ' : b.inv ? '发明 ' : ''}${X.tName(b.pid)} ×${b.runs}${b.inv ? ' 次' : b.copy ? ' 份' : ''}`, X.fmtTime(b.secs), b.fac,
      pin ? '拖动可换产线、调整先后，双击恢复自动' : '拖动可换产线、调整先后'].filter(Boolean).map((x) => esc(tr(x))).join(' · ');
    return `<i class="ind-gantt-bar ${b.copy ? 'cp' : b.inv ? 'inv' : 'd' + Math.min(b.depth, 3)}${pin ? ' is-pin' : ''}" data-bk="${esc(k)}" style="left:${(b.start / sch.span) * 100}%;width:${Math.max(0.6, (b.secs / sch.span) * 100)}%" title="${tip}">${b.copy ? '拷贝 · ' : b.inv ? '发明 · ' : ''}${esc(X.tName(b.pid))}</i>`;
  };
  const rows = kinds.flatMap((kind) => sch.lanes[kind].map((l, i) => {
    const busy = sch.busy.find((b) => b.kind === kind && b.lane === i)?.end || 0;
    return `<div class="ind-gantt-row" data-lane="${esc(l.id)}" data-kind="${kind}"><span class="ind-gantt-label" title="${esc(l.label)}">${esc(l.label)}</span><div class="ind-gantt-track">
      ${busy ? `<i class="ind-gantt-bar busy" style="left:0;width:${Math.max(0.6, (busy / sch.span) * 100)}%" title="已有任务 · ${X.fmtTime(busy)} 后空出">已有任务</i>` : ''}
      ${sch.bars.filter((b) => b.kind === kind && b.lane === i).map(bar).join('')}</div></div>`;
  }));
  return `<div class="ind-gantt${sch.byChar ? ' by-char' : ''}" data-span="${sch.span}">${rows.join('')}
    <div class="ind-gantt-row"><span class="ind-gantt-label"></span><div class="ind-gantt-axis">${axis}</div></div></div>
    ${sch.noLab ? '<p class="pi-note warn">没有角色能做科研，发明没排进时间轴</p>' : ''}`;
}
// 拖动过 / 指定过产线的任务还在规划里时，给「恢复自动安排」
function unpinHtml(sch) {
  const on = sch.bars.some((b) => P.assign[bk(b)] || P.assign[b.key] || P.prio[bk(b)] != null);
  return on ? '<button type="button" class="btn btn-ghost btn-sm" data-plan-unpin title="清掉拖动和指定的产线，全部按自动排">恢复自动安排</button>' : '';
}

// 时间轴拖动：鼠标按住拖（移动 4 像素以上才算拖），触屏长按 0.35 秒再拖（不然就是滚动页面）。
// 只能放到同类产线（制造 / 反应 / 科研）；放下时记下产线和条的左端对应的开工时间，然后重画
function bindGantt(body) {
  if (body.__gantt) return;
  body.__gantt = true;
  let d = null;
  const start = () => {
    d.on = true;
    d.bar.classList.add('is-drag');
    body.classList.add('ind-gantt-dragging');
    try { d.bar.setPointerCapture(d.id); } catch { /* 忽略 */ }
  };
  body.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.ind-gantt-bar[data-bk]');
    if (!bar || e.button > 0 || d) return;
    const track = bar.parentElement, row = bar.closest('.ind-gantt-row');
    const br = bar.getBoundingClientRect(), tr = track.getBoundingClientRect();
    d = { bar, track, row, kind: row.dataset.kind, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, left: br.left - tr.left, width: br.width, on: false, target: null, touch: e.pointerType === 'touch', timer: 0 };
    if (d.touch) d.timer = setTimeout(() => { if (d && !d.on) start(); }, 350);
    else e.preventDefault();   // 鼠标拖动时不选中文字
  });
  body.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.on) {
      if (d.touch) { if (Math.hypot(dx, dy) > 8) { clearTimeout(d.timer); d = null; } return; }   // 长按前就动了：是在滚动
      if (Math.hypot(dx, dy) < 4) return;
      start();
    }
    const rows = [...d.bar.closest('.ind-gantt').querySelectorAll('.ind-gantt-row[data-lane]')];
    const hit = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom; });
    const ok = hit && hit.dataset.kind === d.kind ? hit : null;
    if (d.target !== ok) { d.target?.classList.remove('is-drop'); ok?.classList.add('is-drop'); d.target = ok; }
    d.dx = Math.max(-d.left, Math.min(d.track.clientWidth - d.left - d.width, dx));
    const y = (ok || d.row).getBoundingClientRect().top - d.row.getBoundingClientRect().top;
    d.bar.style.transform = `translate(${d.dx}px, ${y}px)`;
  });
  const finish = (e, commit) => {
    if (!d || e.pointerId !== d.id) return;
    clearTimeout(d.timer);
    const x = d;
    d = null;
    if (!x.on) return;
    body.classList.remove('ind-gantt-dragging');
    x.target?.classList.remove('is-drop');
    if (!commit || !x.target) { x.bar.style.transform = ''; x.bar.classList.remove('is-drag'); return; }
    const span = Number(x.bar.closest('.ind-gantt').dataset.span) || 0;
    const k = x.bar.dataset.bk;
    P.assign[k] = 'l:' + x.target.dataset.lane;
    P.prio[k] = Math.max(0, (x.left + x.dx) / Math.max(1, x.track.clientWidth) * span);
    savePlan();
    redrawPlan();
  };
  body.addEventListener('pointerup', (e) => finish(e, true));
  body.addEventListener('pointercancel', (e) => finish(e, false));
  body.addEventListener('touchmove', (e) => { if (d?.on) e.preventDefault(); }, { passive: false });   // 拖动时不滚动页面
  body.addEventListener('contextmenu', (e) => { if (d && e.target.closest('.ind-gantt-bar[data-bk]')) e.preventDefault(); });
  body.addEventListener('dblclick', (e) => {
    const bar = e.target.closest('.ind-gantt-bar[data-bk]');
    const k = bar?.dataset.bk;
    if (!k || (!P.assign[k] && P.prio[k] == null)) return;
    delete P.assign[k];
    delete P.prio[k];
    savePlan();
    redrawPlan();
  });
}
// 只重画规划（不重读行情，页面不闪）
function redrawPlan() {
  if (S.body?.isConnected && X.F.tab === 'plan' && P.tab === 'plan') drawPlan(S.body, planTabs());
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
    if (del) { const [it] = P.items.splice(Number(del.dataset.planDel), 1); if (it) delete P.fix[`t${it.uid}:0`]; savePlan(); return 'plan'; }
    if (t.closest('[data-plan-clear]')) { if (confirm('清空制造规划？')) { P.items = []; P.fix = {}; savePlan(); return 'plan'; } return 'none'; }
    const unfix = t.closest('[data-plan-unfix]');
    if (unfix) { delete P.fix[unfix.dataset.planUnfix]; savePlan(); return 'plan'; }
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
    if (t.closest('[data-plan-unpin]')) { P.assign = {}; P.prio = {}; savePlan(); return 'plan'; }
    if (t.closest('[data-plan-bpreload]')) { S.bpStock = null; S.corpBps = null; return 'plan'; }
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
      const kind = copy.dataset.planCopy;
      const text = kind === 'bps' ? (S.lastBps || []).map((x) => `${bpName(x.e.bpId)}\t${x.s.text.split(' · ').map(tr).join(' · ')}`).join('\n')
        : kind === 'shop'
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
      const lim = { runs: [1, 100000], me: [0, 10], te: [0, 20], invTry: [0, 100000], invGot: [0, 100000] }[k];
      it[k] = Math.min(lim[1], Math.max(lim[0], Math.round(Number(t.value) || 0)));
      savePlan();
      return 'plan';
    }
    if (t.matches('[data-plan-fix]')) {
      const v = Math.round(Number(t.value) || 0);
      if (v > 0) P.fix[t.dataset.planFix] = Math.min(50, v); else delete P.fix[t.dataset.planFix];
      savePlan();
      return 'plan';
    }
    const n = t.closest('[data-plan-num]');
    if (n) { P[n.dataset.planNum] = Math.min(100, Math.max(1, Math.round(Number(t.value) || 1))); savePlan(); return 'plan'; }
    if (t.matches('[data-plan-paste]')) { P.paste = t.value; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-loc]')) { P.stockLoc = t.value; savePlan(); return 'plan'; }
    if (t.matches('[data-plan-assign]')) {
      const k = t.dataset.planAssign;
      if (t.value) P.assign[k] = t.value;
      else { delete P.assign[k]; delete P.prio[k]; delete P.assign[k.split('#')[0]]; }   // 自动安排：连同拖动的先后、整个任务的指定一起清掉
      savePlan();
      return 'plan';
    }
    if (t.matches('[data-plan-charon]')) {
      const id = Number(t.dataset.planCharon);
      P.charOff = t.checked ? P.charOff.filter((x) => x !== id) : [...new Set([...P.charOff, id])];
      S.running = null; S.bpStock = null;   // 在造的任务、蓝图统计要按参与的人物重读
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
  S.owned = null; S.ownedBps = null; S.ownedLoading = null; S.ownedErr = null; S.mineLoaded = false; S.bpStock = null;
}

export const owned = (pid) => Boolean(S.owned?.has(pid));
export const ownedBp = (pid) => S.ownedBps?.get(pid) || null;
export const ownedState = () => ({ ready: Boolean(S.owned), err: S.ownedErr, count: S.owned?.size || 0 });
