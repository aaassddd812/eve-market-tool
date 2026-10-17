// ===== 制造 =====
// 制造计算器：任意可制造 / 反应产品的材料、时间、安装费、发明成本（T2）、利润；材料可选择自制（逐级展开），汇总购物清单；
//            推荐安装费最低的星系，显示吉他 30 天日均成交量。
// 利润排行：按全服均价估算全部产品的每流程利润与每小时利润，前列可用吉他实时行情精算并显示成交量。
// 制造地点：按星系工业指数排序（制造 / 发明 / 反应 / 研究），可按星域、周边跳数、安全等级筛选。
// 我的工业：ESI 工业任务（esi-industry.read_character_jobs.v1）与角色蓝图（esi-characters.read_blueprints.v1）。
// 蓝图价格：市场有售的原图用吉他卖价；市场没有的（拷贝、派系等）用公开合同最低价（击杀记录服务 /api/kb/bpprices，
//          数据来自 EVE Ref 公开合同快照）。可选择不计入、原图分摊到 N 个流程、或按拷贝每流程单价计入。
// 公式（与游戏一致）：
//   材料 = max(流程数, ⌈round(基础 × 流程数 × (1 − ME%) × 建筑加成 × 改装件加成, 2)⌉)
//   预估价值 EIV = Σ 基础材料数 × 调整价格 × 流程数
//   安装费 = EIV × 星系指数 × (1 − 建筑减免) + EIV × (设施税 + 4% SCC 附加费)
//   时间 = 基础 × 流程数 × (1 − TE%) × 建筑 × 改装件 × 技能（工业理论 4%/级、高级工业理论 3%/级；反应 4%/级）
//   发明成功率 = 基础 × (1 + 科学技能之和/30 + 加密技能/40) × 解码器倍数；发明安装费以产品 EIV 的 2% 为基数
import { SERVER } from './server.js?v=s1';
let ctx;   // esc, formatISK, formatNumber, formatPrice, showToast, copyText, store, fetchESI, getHubPrices, getCharacterSkills, esiAuthFetch, ensureEsiToken, hasEsiToken
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-industry-v1';
const RECENT_KEY = 'eve-industry-recent';
const SIDE_PANE_KEY = 'eve-industry-side-pane';
const JITA = 30000142, FORGE = 10000002;
const SCC = 4;           // SCC 附加费 %
const NPC_TAX = 0.25;    // NPC 空间站设施税 %
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
const BP_ICON = (id, size = 32, copy = false) => `https://images.evetech.net/types/${id}/${copy ? 'bpc' : 'bp'}?size=${size}`;
// 排行只收录能正常获得蓝图的产品：T1 / T2 / T3（以及建筑的 T1 / T2）；派系、故事线、官员、死亡空间等蓝图只能靠掉落或 LP
const RANK_METAS = new Set([0, 1, 2, 14, 53, 54]);
const SKILL = { industry: 3380, advIndustry: 3388, reactions: 45746, accounting: 16622, broker: 3446 };

// 设施：ME / TE / 安装费减免（%）与可进行的活动
const FACILITIES = {
  npc: { me: 0, te: 0, cost: 0, act: 'm' },
  35825: { me: 1, te: 15, cost: 3, act: 'm' },
  35826: { me: 1, te: 20, cost: 4, act: 'm' },
  35827: { me: 1, te: 30, cost: 5, act: 'm' },
  35835: { me: 0, te: 0, cost: 0, act: 'r' },
  35836: { me: 0, te: 25, cost: 0, act: 'r' }
};
const RIGS = [{ me: 0, te: 0, name: '无' }, { me: 2, te: 20, name: 'T1' }, { me: 2.4, te: 24, name: 'T2' }];
const secMul = (sec) => (sec >= 0.45 ? 1 : sec > 0 ? 1.9 : 2.1);   // 改装件加成随安全等级放大

// 利润排行分类（按物品大类）
const RANK_CATS = [
  ['all', '全部', null], ['ship', '舰船', [6]], ['module', '装备', [7, 32]], ['charge', '弹药', [8]],
  ['drone', '无人机', [18, 87]], ['comp', '组件 / 材料', [17, 4]], ['struct', '建筑', [65, 66, 22, 39, 40, 46]], ['implant', '植入体', [20]]
];
const ACT_ZH = { 1: '制造', 3: '时间效率研究', 4: '材料效率研究', 5: '拷贝', 8: '发明', 9: '反应', 11: '反应' };
const STATUS_ZH = { active: '进行中', paused: '暂停', ready: '可交付', delivered: '已交付', cancelled: '已取消', reverted: '已撤销' };

const D = { loading: null, data: null, sys: new Map(), regions: new Map(), jumpsFromJita: null, adjusted: new Map(), average: new Map(), indices: new Map(), skills: null, history: new Map(),
  bpc: new Map(), bpAll: null, bpUpdated: null };   // 蓝图合同价：蓝图 -> { o: 原图合同, c: 拷贝合同 }；bpAll：全部蓝图的 [原图最低, 拷贝每流程最低]
const F = {
  tab: 'calc', sys: JITA, fac: 'npc', rig: 0, rfac: 35836, rrig: 0, tax: 1,
  mat: 'sell', prod: 'sell', skills: 'all5', me: 10, te: 20, subMe: 10,
  scope: 'region', jumps: 10, sec: { high: true, low: true, null: false },
  rankCat: 'all', rankTech: 'all', rankAct: 'm', rankSort: 'ph', rankDir: 'desc', idx: 'manufacturing', whereSort: null, whereDir: 'asc'
};
const C = { pid: 0, runs: 1, me: null, te: null, dec: 0, invent: true, build: new Set(), bpMode: null, bpoRuns: 100 };
const SIDE = { q: '', open: new Set(), pane: 'catalog' };   // pane：侧栏标签 catalog 物品分类 / recent 最近查看
const R = { rows: [], refined: false, busy: false };
const jita = new Map();   // 吉他行情 id -> { sell, buy }

export function initIndustry(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {}) || {};
  Object.assign(F, saved);
  F.sec = { high: true, low: true, null: false, ...(saved.sec || {}) };
  if (ctx.store.get(SIDE_PANE_KEY) === 'recent') SIDE.pane = 'recent';
  if (F.rankSort === 'run') F.rankSort = 'profit';   // 旧版「每流程利润」按钮
  if (!RANK_SORT_DIR[F.rankSort]) { F.rankSort = 'ph'; F.rankDir = 'desc'; }
  if (!WHERE_SORT_DIR[F.whereSort]) { F.whereSort = F.idx || 'manufacturing'; F.whereDir = 'asc'; }
}

// 表头排序（与市场中心订单簿一致）：点击表头按该列排序，再点一次反向；首次点击用该列更有用的方向
const RANK_SORT_DIR = { name: 'asc', perUnit: 'asc', unit: 'desc', profit: 'desc', margin: 'desc', ph: 'desc' };
const WHERE_SORT_DIR = { name: 'asc', region: 'asc', manufacturing: 'asc', invention: 'asc', reaction: 'asc', copying: 'asc',
  researching_material_efficiency: 'asc', researching_time_efficiency: 'asc', jumps: 'asc', stations: 'desc' };
const sortTh = (attr, cur, dir, key, label, cls = '') => {
  const on = cur === key;
  return `<th class="sortable${cls ? ' ' + cls : ''}${on ? ' sorted' : ''}" data-${attr}="${key}" data-dir="${on ? dir : ''}" aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}</th>`;
};
const flipSort = (cur, curDir, key, defaults) => (cur === key ? (curDir === 'asc' ? 'desc' : 'asc') : defaults[key]);
const save = () => ctx.store.setJSON(STORE_KEY, F);

// ---------- 数据 ----------
function loadData() {
  if (!D.loading) {
    D.loading = (async () => {
      const [data, map, prices, indices] = await Promise.all([
        fetch('industry-data.json?v=2').then((r) => { if (!r.ok) throw new Error('industry-data.json ' + r.status); return r.json(); }),
        fetch('map-data.json').then((r) => { if (!r.ok) throw new Error('map-data.json ' + r.status); return r.json(); }),
        ctx.fetchESI('/markets/prices/').catch(() => []),
        ctx.fetchESI('/industry/systems/').catch(() => [])
      ]);
      D.data = data;
      const index = map.systems.map((s) => ({ id: s[0], name: s[1], sec: s[5], region: s[6], stations: (s[11] || []).length, nbr: [] }));
      for (const s of index) D.sys.set(s.id, s);
      for (const [a, b] of map.gates) { index[a].nbr.push(index[b].id); index[b].nbr.push(index[a].id); }
      for (const r of map.regions) D.regions.set(r[0], r[1]);
      for (const p of prices || []) {
        if (p.adjusted_price) D.adjusted.set(p.type_id, p.adjusted_price);
        if (p.average_price) D.average.set(p.type_id, p.average_price);
      }
      for (const s of indices || []) D.indices.set(s.solar_system_id, Object.fromEntries(s.cost_indices.map((c) => [c.activity, c.cost_index])));
      D.jumpsFromJita = bfs(JITA, 200);
    })().catch((e) => { D.loading = null; throw e; });
  }
  return D.loading;
}

function bfs(start, max) {
  const seen = new Map([[start, 0]]);
  let frontier = [start];
  for (let j = 1; j <= max && frontier.length; j++) {
    const next = [];
    for (const s of frontier) for (const n of D.sys.get(s)?.nbr || []) if (!seen.has(n)) { seen.set(n, j); next.push(n); }
    frontier = next;
  }
  return seen;
}

const T = (id) => D.data.types[id] || ['物品 ' + id, '', 0, 1, 0, 0];
const isBlueprint = (id) => D.data.groups[T(id)[2]]?.[1] === 9;
// 任意物品图标：蓝图用蓝图 / 拷贝图标
const anyIcon = (id, copy = false) => (isBlueprint(id) ? BP_ICON(id, 32, copy) : ICON(id));
const tName = (id) => T(id)[0];
const tCat = (id) => D.data.groups[T(id)[2]]?.[1] || 0;
const BP = (pid) => D.data.bp[pid];
const invFor = (pid) => (BP(pid) ? D.data.inv[BP(pid)[0]] : null);

function secInfo(sec) {
  const d = sec > 0 && sec < 0.05 ? 0.1 : Math.max(0, Math.round(sec * 10) / 10);
  const color = d >= 0.5 ? 'var(--buy-color)' : d > 0 ? 'var(--warning)' : 'var(--sell-color)';
  return { text: sec <= -0.99 ? '-1.0' : d.toFixed(1), color, cls: d >= 0.5 ? 'high' : d > 0 ? 'low' : 'null' };
}
const sysLabel = (id) => {
  const s = D.sys.get(id);
  if (!s) return ctx.esc('星系 ' + id);
  const sec = secInfo(s.sec);
  return `${ctx.esc(s.name)} <b style="color:${sec.color}">${sec.text}</b>`;
};

// ---------- 技能与价格 ----------
async function ensureSkills() {
  if (F.skills !== 'esi' || !ctx.hasEsiToken()) { D.skills = null; return; }
  try { D.skills = (await ctx.getCharacterSkills()).levels; } catch { D.skills = null; }
}
const lvl = (id) => (F.skills === 'esi' && D.skills ? D.skills.get(id) || 0 : 5);
const salesTax = () => 7.5 * (1 - 0.11 * lvl(SKILL.accounting));   // %
const brokerFee = () => Math.max(0, 3 - 0.3 * lvl(SKILL.broker));   // %

// 价格：优先吉他行情，没有时用全服均价
function price(id, side) {
  const j = jita.get(id);
  const v = side === 'buy' ? j?.buy : j?.sell;
  return v ?? j?.sell ?? j?.buy ?? D.average.get(id) ?? null;
}
const matPrice = (id) => price(id, F.mat === 'buy' ? 'buy' : 'sell');
const matFee = () => (F.mat === 'buy' ? brokerFee() : 0);           // 挂收单买材料要付中介费
const prodPrice = (id) => price(id, F.prod === 'buy' ? 'buy' : 'sell');
const sellFee = () => salesTax() + (F.prod === 'sell' ? brokerFee() : 0);

async function loadJita(ids, onProgress) {
  const need = [...new Set(ids)].filter((id) => !jita.has(id));
  if (!need.length) return;
  const map = await ctx.getHubPrices(need, onProgress).catch(() => new Map());
  for (const id of need) jita.set(id, map.get(id) || {});
}

async function dailyVolume(id) {
  if (D.history.has(id)) return D.history.get(id);
  const p = ctx.fetchESI(`/markets/${FORGE}/history/?type_id=${id}`).then((h) => {
    const last = (Array.isArray(h) ? h : []).slice(-30);
    if (!last.length) return { vol: 0, avg: null };
    return { vol: last.reduce((t, x) => t + x.volume, 0) / last.length, avg: last.reduce((t, x) => t + x.average, 0) / last.length };
  }).catch(() => null);
  D.history.set(id, p);
  return p;
}

// 公开合同里的蓝图价格（击杀记录服务未部署时返回空）
async function loadBpContracts(ids) {
  const need = ids.filter((id) => !D.bpc.has(id));
  if (!need.length) return;
  try {
    if (!SERVER.kb) throw new Error('晨曦服没有合同价格数据');
    const r = await fetch('/api/kb/bpprices?types=' + need.join(','));
    const j = r.ok ? await r.json() : {};
    D.bpUpdated = j.updated || D.bpUpdated;
    for (const id of need) D.bpc.set(id, j.types?.[id] || { o: [], c: [] });
  } catch { for (const id of need) D.bpc.set(id, { o: [], c: [] }); }
}
async function loadBpAll() {
  if (D.bpAll) return D.bpAll;
  try {
    if (!SERVER.kb) throw new Error('晨曦服没有合同价格数据');
    const r = await fetch('/api/kb/bpprices');
    const j = r.ok ? await r.json() : {};
    D.bpUpdated = j.updated || D.bpUpdated;
    D.bpAll = new Map(Object.entries(j.all || {}).map(([k, v]) => [Number(k), v]));
  } catch { D.bpAll = new Map(); }
  return D.bpAll;
}

// 产品对应蓝图的价格来源
function bpPrices(pid) {
  const bpId = BP(pid)[0];
  const onMarket = Boolean(BP(pid)[7]);
  const j = jita.get(bpId);
  const k = D.bpc.get(bpId) || { o: [], c: [] };
  return { bpId, onMarket, market: onMarket ? j?.sell ?? null : null, bpo: k.o, bpc: k.c };
}

// ---------- 计算 ----------
function facilityFor(act) {
  if (act === 'r') return { ...FACILITIES[F.rfac] || FACILITIES[35836], rig: RIGS[F.rrig] };
  return { ...FACILITIES[F.fac] || FACILITIES.npc, rig: RIGS[F.rig] };
}
const facTax = (act) => (act === 'm' && F.fac === 'npc' ? NPC_TAX : F.tax);
const sysSec = (id = F.sys) => D.sys.get(id)?.sec ?? 0.5;
const costIndex = (act, id = F.sys) => (D.indices.get(id) || {})[act === 'r' ? 'reaction' : 'manufacturing'] || 0;

// 一个任务的材料、EIV、安装费、时间
function job(pid, runs, me, te, sysId = F.sys) {
  const [, qty, time, mats, , act] = BP(pid);
  const fac = facilityFor(act);
  const sm = secMul(sysSec(sysId));
  const mul = (1 - fac.me / 100) * (1 - (fac.rig.me * sm) / 100);
  const items = mats.map(([id, base]) => ({
    id, base: base * runs,
    qty: Math.max(runs, Math.ceil(Math.round(base * runs * (1 - me / 100) * mul * 100) / 100))
  }));
  const eiv = mats.reduce((t, [id, base]) => t + base * runs * (D.adjusted.get(id) || 0), 0);
  const idx = costIndex(act, sysId);
  const gross = eiv * idx * (1 - fac.cost / 100);
  const taxes = eiv * (facTax(act) + SCC) / 100;
  const skillMul = act === 'r' ? 1 - 0.04 * lvl(SKILL.reactions) : (1 - 0.04 * lvl(SKILL.industry)) * (1 - 0.03 * lvl(SKILL.advIndustry));
  const secs = time * runs * (1 - te / 100) * (1 - fac.te / 100) * (1 - (fac.rig.te * sm) / 100) * skillMul;
  return { act, out: qty * runs, items, eiv, idx, gross, taxes, cost: gross + taxes, secs };
}

// 发明：每个 T2 流程分摊的发明成本
function invention(pid, decId = 0) {
  const inv = invFor(pid);
  if (!inv) return null;
  const [t1bp, base, runsPer, dcs, , skills] = inv;
  const dec = D.data.decryptors[decId] || [1, 0, 0, 0];
  const enc = skills.find(([id]) => /Encryption/i.test(T(id)[1]));
  const sci = skills.filter((s) => s !== enc);
  const prob = Math.min(1, base * (1 + sci.reduce((t, [id]) => t + lvl(id), 0) / 30 + (enc ? lvl(enc[0]) : 0) / 40) * dec[0]);
  const runs = Math.max(1, runsPer + dec[3]);
  const eivProduct = BP(pid)[3].reduce((t, [id, b]) => t + b * (D.adjusted.get(id) || 0), 0);
  const jobCost = eivProduct * 0.02 * ((D.indices.get(F.sys) || {}).invention || 0) + eivProduct * 0.02 * (facTax('m') + SCC) / 100;
  const dcCost = dcs.reduce((t, [id, q]) => t + q * (matPrice(id) ?? 0), 0);
  const decCost = decId ? matPrice(decId) ?? 0 : 0;
  const attempt = dcCost + decCost + jobCost;
  return { t1bp, prob, runs, me: 2 + dec[1], te: 4 + dec[2], dcs, dcCost, decCost, jobCost, attempt, perRun: attempt / (prob * runs) };
}

// 生产 units 个 pid 的成本：材料逐个按「购买」或「自制」（C.build 中的物品）计算，自制按比例分摊
function buildCost(pid, units, depth, sysId = F.sys) {
  const [, qty, , , , act] = BP(pid);
  const runs = Math.ceil(units / qty);
  const me = act === 'r' ? 0 : F.subMe;
  const j = job(pid, runs, me, 0, sysId);
  const share = units / (runs * qty);
  let cost = j.cost * share;
  const raw = new Map();
  for (const it of j.items) {
    const need = it.qty * share;
    if (depth < 6 && C.build.has(it.id) && BP(it.id)) {
      const sub = buildCost(it.id, need, depth + 1, sysId);
      cost += sub.cost;
      for (const [id, q] of sub.raw) raw.set(id, (raw.get(id) || 0) + q);
    } else {
      cost += need * (matPrice(it.id) ?? 0) * (1 + matFee() / 100);
      raw.set(it.id, (raw.get(it.id) || 0) + need);
    }
  }
  return { cost, raw, secs: j.secs * share };
}

// 完整的计算器结果
function calc() {
  const pid = C.pid;
  const b = BP(pid);
  const act = b[5];
  const inv = act === 'm' && C.invent ? invention(pid, C.dec) : null;
  // 蓝图成本：发明已计入拷贝成本时不再计；市场买不到原图、合同有拷贝时默认按拷贝单价
  const bp = bpPrices(pid);
  const bpoPrice = bp.market ?? bp.bpo[0]?.[0] ?? null;
  const bpcPerRun = bp.bpc[0]?.[0] ?? null;
  const autoMode = inv ? 'none' : !bp.onMarket && bpcPerRun != null ? 'bpc' : 'none';
  let bpMode = C.bpMode || autoMode;
  if (bpMode === 'bpc' && bpcPerRun == null) bpMode = 'none';
  if (bpMode === 'bpo' && bpoPrice == null) bpMode = 'none';
  // 默认 ME / TE：发明拷贝 > 按合同拷贝时取那份拷贝 > 设置里的默认值
  const bpcRow = bpMode === 'bpc' ? bp.bpc[0] : null;
  const me = act === 'r' ? 0 : C.me ?? (inv ? inv.me : bpcRow ? bpcRow[3] : F.me);
  const te = act === 'r' ? 0 : C.te ?? (inv ? inv.te : bpcRow ? bpcRow[4] : F.te);
  const runs = Math.max(1, C.runs);
  const j = job(pid, runs, me, te);
  const raw = new Map();
  let matCost = 0;
  const rows = j.items.map((it) => {
    const buyUnit = matPrice(it.id);
    const canBuild = Boolean(BP(it.id));
    const build = canBuild && C.build.has(it.id);
    let unitCost = (buyUnit ?? 0) * (1 + matFee() / 100);
    let sub = null;
    if (canBuild) {
      sub = buildCost(it.id, it.qty, 1);
      if (build) unitCost = sub.cost / it.qty;
    }
    if (build) for (const [id, q] of sub.raw) raw.set(id, (raw.get(id) || 0) + q);
    else raw.set(it.id, (raw.get(it.id) || 0) + it.qty);
    matCost += unitCost * it.qty;
    return { ...it, buyUnit, canBuild, build, unitCost, buildUnit: sub ? sub.cost / it.qty : null };
  });
  const invCost = inv ? inv.perRun * runs : 0;
  const bpCost = bpMode === 'bpc' ? bpcPerRun * runs : bpMode === 'bpo' ? (bpoPrice / Math.max(1, C.bpoRuns)) * runs : 0;
  const total = matCost + j.cost + invCost + bpCost;
  const unitPrice = prodPrice(pid);
  const revenue = (unitPrice ?? 0) * j.out * (1 - sellFee() / 100);
  const profit = revenue - total;
  const profitNoBp = profit + bpCost;
  const payback = bpoPrice != null && profitNoBp > 0 ? Math.ceil(bpoPrice / (profitNoBp / runs)) : null;
  return { pid, act, me, te, runs, j, rows, raw, matCost, inv, invCost, bp, bpoPrice, bpcPerRun, bpMode, bpCost, payback, total, unitPrice, revenue, profit, perUnit: total / j.out };
}

// ---------- 页面框架 ----------
// restored：从其他页面切回且地址未变，保留当前页面（输入、展开状态、滚动位置）
export async function showIndustry(hash = location.hash, restored = false) {
  const main = $('industryMain');
  const wasReady = Boolean(main.dataset.ready);
  if (!D.data) main.innerHTML = '<div class="pi-loading">载入制造数据…</div>';
  await loadData();
  await ensureSkills();
  const m = /^#ind(?:\/(calc|rank|where|mine))?(?:\/(\d+))?/.exec(hash || '');
  if (m?.[1]) F.tab = m[1];
  if (m?.[2] && BP(Number(m[2]))) selectProduct(Number(m[2]), false);
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="ind-page">
        <div class="pi-head ind-head">
          <h2>制造</h2>
        </div>
        <div class="segmented ind-tabs ind-tabs-mobile" id="indTabs" role="tablist">
          ${[['calc', '制造计算器'], ['rank', '利润排行'], ['where', '制造地点'], ['mine', '我的工业']].map(([k, l]) => `<button data-ind-tab="${k}">${l}</button>`).join('')}
        </div>
        <details class="pi-card ind-settings" id="indSettings"></details>
        <div id="indBody"></div>
      </section>`;
    main.addEventListener('click', onClick);
    main.addEventListener('change', onChange);
    main.addEventListener('input', onInput);
    main.addEventListener('focusout', () => setTimeout(() => { if (!main.contains(document.activeElement)) main.querySelectorAll('.kb-suggest').forEach((b) => { b.hidden = true; }); }, 150));
    const side = $('indSide');
    side.addEventListener('click', onSideClick);
    side.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.dataset?.sideKey) { if (d.open) { SIDE.open.add(d.dataset.sideKey); fillGroup(d); } else SIDE.open.delete(d.dataset.sideKey); }
    }, true);
    let t = 0;
    $('indSideSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { SIDE.q = e.target.value.trim(); renderSide(); }, 150); });
  }
  const esi = ctx.hasEsiToken();
  if (restored && wasReady && esi === lastEsi) { setHash(); return; }
  lastEsi = esi;
  renderSettings();
  renderTab();
}

let lastEsi = null;   // 上次渲染时是否已绑定 ESI（绑定状态变了要刷新技能与「我的工业」）

function setHash() {
  if ($('industryView').hidden) return;   // 后台读完行情重绘时不改其他页面的地址
  const h = F.tab === 'calc' && C.pid ? `#ind/calc/${C.pid}` : `#ind/${F.tab}`;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + h);
}

function renderTab() {
  document.querySelectorAll('[data-ind-tab]').forEach((b) => b.classList.toggle('active', b.dataset.indTab === F.tab));
  setHash();
  renderSide();
  const body = $('indBody');
  if (F.tab === 'calc') renderCalc(body);
  else if (F.tab === 'rank') renderRank(body);
  else if (F.tab === 'where') renderWhere(body);
  else renderMine(body);
}

// ---------- 设置 ----------
function renderSettings() {
  const el = $('indSettings');
  const open = el.open;
  const fac = facilityFor('m'), rfac = facilityFor('r');
  const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-ind-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const facOpts = [['npc', 'NPC 空间站'], ...[35825, 35826, 35827].map((id) => [id, D.data.structures[id]])];
  const rfacOpts = [35835, 35836].map((id) => [id, D.data.structures[id]]);
  const idx = D.indices.get(F.sys) || {};
  el.innerHTML = `
    <summary><b>制造设置</b><span class="text-muted">${sysLabel(F.sys)} · 制造指数 ${((idx.manufacturing || 0) * 100).toFixed(2)}% · ${F.fac === 'npc' ? 'NPC 空间站' : ctx.esc(D.data.structures[F.fac])}${F.fac !== 'npc' && F.rig ? ' + ' + RIGS[F.rig].name + ' 改装件' : ''} · 技能${F.skills === 'esi' ? (D.skills ? '按角色' : '（未绑定，按全 5 级）') : '全 5 级'}</span></summary>
    <div class="ind-set-grid">
      <div class="pi-field"><label>制造星系</label>
        <div class="search-box pi-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="indSys" placeholder="输入星系名" value="${ctx.esc(D.sys.get(F.sys)?.name || '')}" autocomplete="off" spellcheck="false"><div class="kb-suggest" id="indSysSuggest" hidden></div></div></div>
      <div class="pi-field"><label>制造设施</label>${seg('fac', facOpts, F.fac)}
        ${F.fac !== 'npc' ? `<div class="pi-inline"><span>改装件</span>${seg('rig', RIGS.map((r, i) => [i, r.name]), F.rig)}</div>` : ''}
        <small class="pi-hint">ME −${fac.me + fac.rig.me * secMul(sysSec())}% · TE −${(100 - (100 - fac.te) * (1 - fac.rig.te * secMul(sysSec()) / 100)).toFixed(1)}% · 安装费 −${fac.cost}%</small></div>
      <div class="pi-field"><label>反应设施</label>${seg('rfac', rfacOpts, F.rfac)}
        <div class="pi-inline"><span>改装件</span>${seg('rrig', RIGS.map((r, i) => [i, r.name]), F.rrig)}</div></div>
      <div class="pi-field"><label>税费</label>
        <div class="pi-inline"><span>建筑税</span><input type="number" class="pi-input pi-tax" min="0" max="50" step="0.1" value="${F.tax}" data-ind-num="tax"><span>%</span></div>
        <small class="pi-hint">卖出税 ${salesTax().toFixed(2)}% · 中介费 ${brokerFee().toFixed(2)}%</small></div>
      <div class="pi-field"><label>价格</label>
        <div class="pi-inline"><span>买材料</span>${seg('mat', [['sell', '吉他卖单'], ['buy', '挂收单']], F.mat)}</div>
        <div class="pi-inline"><span>卖产品</span>${seg('prod', [['sell', '挂卖单'], ['buy', '卖给收单']], F.prod)}</div></div>
      <div class="pi-field"><label>技能与蓝图</label>
        <div class="pi-inline"><span>技能</span>${seg('skills', [['all5', '全 5 级'], ['esi', '读取角色']], F.skills)}</div>
        <div class="pi-grid3">
          <div class="pi-num"><span>默认 ME</span><input type="number" class="pi-input" min="0" max="10" value="${F.me}" data-ind-num="me"></div>
          <div class="pi-num"><span>默认 TE</span><input type="number" class="pi-input" min="0" max="20" step="2" value="${F.te}" data-ind-num="te"></div>
          <div class="pi-num"><span>组件 ME</span><input type="number" class="pi-input" min="0" max="10" value="${F.subMe}" data-ind-num="subMe"></div>
        </div></div>
    </div>`;
  el.open = open;
}

function sysSuggest(q) {
  const box = $('indSysSuggest');
  if (!box) return;
  if (!q) { box.hidden = true; return; }
  const lower = q.toLowerCase();
  const hits = [];
  for (const s of D.sys.values()) if (s.name.toLowerCase().includes(lower)) hits.push(s);
  hits.sort((a, b) => (a.name.toLowerCase().startsWith(lower) ? 0 : 1) - (b.name.toLowerCase().startsWith(lower) ? 0 : 1) || a.name.length - b.name.length);
  box.innerHTML = hits.slice(0, 10).map((s) => {
    const idx = D.indices.get(s.id) || {};
    return `<button type="button" class="kb-suggest-item" data-ind-sys="${s.id}"><i style="background:${secInfo(s.sec).color}"></i><span>${sysLabel(s.id)}</span><small>${ctx.esc(D.regions.get(s.region) || '')} · 制造 ${((idx.manufacturing || 0) * 100).toFixed(2)}%</small></button>`;
  }).join('') || '<div class="kb-suggest-group">没有匹配的星系</div>';
  box.hidden = false;
}

// ---------- 制造计算器 ----------
function productHits(q, limit = 14) {
  const lower = q.toLowerCase();
  const out = [];
  for (const pid of Object.keys(D.data.bp)) {
    const t = T(pid);
    const zh = t[0].toLowerCase(), en = t[1].toLowerCase();
    if (zh.includes(lower) || en.includes(lower)) out.push([zh === lower || en === lower ? 0 : zh.startsWith(lower) || en.startsWith(lower) ? 1 : 2, Number(pid)]);
    if (out.length > 600) break;
  }
  return out.sort((a, b) => a[0] - b[0] || tName(a[1]).length - tName(b[1]).length).slice(0, limit).map((x) => x[1]);
}

function productSuggest(q) {
  const box = $('indProdSuggest');
  if (!box) return;
  if (!q.trim()) { box.hidden = true; return; }
  const hits = productHits(q.trim());
  box.innerHTML = hits.map((pid) => {
    const b = BP(pid);
    const g = D.data.groups[T(pid)[2]];
    return `<button type="button" class="kb-suggest-item" data-ind-pick="${pid}"><img src="${ICON(pid)}" alt="" width="24" height="24" loading="lazy"><span>${ctx.esc(tName(pid))}</span><small>${ctx.esc(g?.[0] || '')} · ${b[5] === 'r' ? '反应' : invFor(pid) ? '发明 + 制造' : '制造'}</small></button>`;
  }).join('') || '<div class="kb-suggest-group">没有可制造的匹配物品</div>';
  box.hidden = false;
}

function selectProduct(pid, render = true) {
  if (C.pid !== pid) { C.build = new Set(); C.me = null; C.te = null; C.dec = 0; C.runs = 1; C.invent = true; C.bpMode = null; }
  const recent = [pid, ...(ctx.store.getJSON(RECENT_KEY, []) || []).filter((x) => x !== pid && BP(x))].slice(0, 12);
  ctx.store.setJSON(RECENT_KEY, recent);
  C.pid = pid;
  F.tab = 'calc';
  if (render) renderTab();
}

async function renderCalc(body) {
  const esc = ctx.esc;
  body.innerHTML = `
    <div class="ind-search-row">
      <div class="search-box ind-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" id="indProd" placeholder="搜索要制造的物品" autocomplete="off" spellcheck="false"><div class="kb-suggest" id="indProdSuggest" hidden></div></div>
    </div>
    <div id="indCalc">${C.pid ? '<div class="pi-loading" id="indCalcLoading">读取吉他行情…</div>' : `<div class="pi-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 20h20M4 20V9l5 3V9l5 3V6l6 4v10"/></svg><p>搜索要制造的物品</p></div>`}</div>`;
  if (!C.pid) return;
  // 吉他行情：产品、全部材料（含可自制材料的下级）、数据核心与解码器
  const ids = new Set([C.pid]);
  const walk = (pid, depth) => {
    for (const [id] of BP(pid)[3]) { ids.add(id); if (depth < 4 && BP(id)) walk(id, depth + 1); }
  };
  walk(C.pid, 0);
  const inv = invFor(C.pid);
  if (inv) { inv[3].forEach(([id]) => ids.add(id)); Object.keys(D.data.decryptors).forEach((id) => ids.add(Number(id))); }
  const bpId = BP(C.pid)[0];
  if (BP(C.pid)[7]) ids.add(bpId);   // 市场有售的原图
  await Promise.all([
    loadJita([...ids], (done, total) => { const el = $('indCalcLoading'); if (el) el.textContent = `读取吉他行情 ${done}/${total}`; }),
    loadBpContracts([bpId])
  ]);
  if (F.tab !== 'calc' || !$('indCalc')) return;
  drawCalc();
  dailyVolume(C.pid).then((h) => { const el = $('indVol'); if (el && h) el.innerHTML = `${ctx.formatNumber(Math.round(h.vol))}<small> 件/天</small>`; else if (el) el.textContent = '—'; });
}

function fmtTime(secs) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.round((secs % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

function drawCalc() {
  const el = $('indCalc');
  if (!el || !C.pid) return;
  const esc = ctx.esc, isk = ctx.formatISK, num = ctx.formatNumber;
  const r = calc();
  const b = BP(r.pid);
  const t = T(r.pid);
  const g = D.data.groups[t[2]];
  const icon = (id, s = 24) => `<img src="${ICON(id)}" alt="" width="${s}" height="${s}" loading="lazy">`;
  const margin = r.revenue ? (r.profit / r.revenue) * 100 : 0;
  const hours = r.j.secs / 3600;
  const tl = { 1: 'T1', 2: 'T2', 3: 'T3' }[t[3]] || '';
  const meta = D.data.metas[t[4]] || '';
  const decOpts = Object.entries(D.data.decryptors).map(([id, d]) => `<option value="${id}"${C.dec === Number(id) ? ' selected' : ''}>${esc(tName(id))}（成功率 ×${d[0]}，ME ${d[1] >= 0 ? '+' : ''}${d[1]}，TE ${d[2] >= 0 ? '+' : ''}${d[2]}，流程 ${d[3] >= 0 ? '+' : ''}${d[3]}）</option>`).join('');

  // 材料表（可自制的材料可展开）
  const matRows = r.rows.map((m) => {
    const cheaper = m.canBuild && m.buildUnit != null && m.buyUnit != null ? (m.buildUnit < m.buyUnit * (1 + matFee() / 100) ? 'build' : 'buy') : null;
    return `<tr class="${m.build ? 'is-build' : ''}">
      <td><div class="pi-prod">${icon(m.id)}<span>${esc(tName(m.id))}</span></div></td>
      <td class="num">${num(m.base)}</td>
      <td class="num"><b>${num(m.qty)}</b></td>
      <td class="num">${m.buyUnit != null ? ctx.formatPrice(m.buyUnit) : '<span class="text-muted">无报价</span>'}</td>
      <td class="num">${isk(m.unitCost * m.qty)}</td>
      <td>${m.canBuild ? `<button type="button" class="ind-build-btn${m.build ? ' on' : ''}" data-ind-build="${m.id}" title="自制单价 ${isk(m.buildUnit)}">${m.build ? '自制' : '购买'}<small>${cheaper === 'build' ? '自制更省' : cheaper === 'buy' ? '购买更省' : ''}</small></button>` : ''}</td>
    </tr>`;
  }).join('');

  // 购物清单（自制展开到最底层）
  const shopping = [...r.raw.entries()].map(([id, q]) => [id, Math.ceil(q - 1e-9)]).sort((a, b) => (matPrice(b[0]) ?? 0) * b[1] - (matPrice(a[0]) ?? 0) * a[1]);
  const shopRows = shopping.map(([id, q]) => `<tr><td><div class="pi-prod">${icon(id, 20)}<span>${esc(tName(id))}</span></div></td><td class="num">${num(q)}</td><td class="num">${isk(q * (matPrice(id) ?? 0))}</td></tr>`).join('');
  R.shopping = shopping;

  // 发明
  let invHtml = '';
  if (r.inv) {
    invHtml = `<div class="pi-card"><div class="pi-card-head"><h3>发明</h3><span class="text-muted">${esc(tName(r.inv.t1bp))} → T2 蓝图拷贝</span></div>
      <div class="ind-inv">
        <label class="pie-row ind-inv-dec"><span>解码器</span><select class="pi-input" data-ind-calc="dec"><option value="0">不使用</option>${decOpts}</select></label>
        <div class="ind-kv"><span>成功率</span><b>${(r.inv.prob * 100).toFixed(1)}%</b><span>每份拷贝流程</span><b>${r.inv.runs}</b><span>拷贝 ME / TE</span><b>${r.inv.me} / ${r.inv.te}</b></div>
        <div class="ind-kv"><span>数据核心</span><b>${isk(r.inv.dcCost)}</b><span>解码器</span><b>${isk(r.inv.decCost)}</b><span>发明安装费</span><b>${isk(r.inv.jobCost)}</b></div>
        <div class="ind-kv"><span>每次尝试</span><b>${isk(r.inv.attempt)}</b><span>摊到每流程</span><b class="ind-hl">${isk(r.inv.perRun)}</b><span>数据核心</span><b>${r.inv.dcs.map(([id, q]) => esc(tName(id)) + ' ×' + q).join('、')}</b></div>
      </div></div>`;
  }

  // 去哪里造：同一任务在候选星系的安装费
  const jumps = (id) => D.jumpsFromJita.get(id) ?? 999;
  const cands = candidates(r.act).map((sid) => ({ sid, cost: job(r.pid, r.runs, r.me, r.te, sid).cost })).sort((a, b) => a.cost - b.cost || jumps(a.sid) - jumps(b.sid)).slice(0, 8);
  const whereRows = cands.map((c) => {
    const s = D.sys.get(c.sid);
    const idx = costIndex(r.act, c.sid);
    const save = r.j.cost - c.cost;
    return `<tr data-ind-sys-pick="${c.sid}" title="设为制造星系"><td>${sysLabel(c.sid)}</td><td class="pi-hide-sm">${ctx.esc(D.regions.get(s.region) || '')}</td><td class="num">${(idx * 100).toFixed(2)}%</td><td class="num">${D.jumpsFromJita.get(c.sid) ?? '—'}</td><td class="num pi-hide-sm">${s.stations || '—'}</td><td class="num">${isk(c.cost)}</td><td class="num ${save > 0 ? 'up' : ''}">${save > 0 ? '省 ' + isk(save) : '—'}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="pi-card pi-detail">
      <div class="pi-detail-head ind-prod-head">
        <img src="${ICON(r.pid, 64)}" alt="" width="52" height="52">
        <div><h3>${esc(t[0])} <small class="text-muted">${esc(t[1])}</small></h3>
          <span class="text-muted">${esc(g?.[0] || '')} · ${tl}${meta && meta !== '一级科技' && meta !== '二级科技' ? ' · ' + esc(meta) : ''} · ${r.act === 'r' ? '反应' : '制造'}${b[1] > 1 ? ' · 每流程 ' + b[1] + ' 个' : ''}</span></div>
        <a class="btn btn-ghost ind-market" href="#type=${r.pid}">市场行情</a>
      </div>
      <div class="ind-inputs">
        <div class="pi-num"><span>流程数</span><input type="number" class="pi-input" min="1" max="100000" value="${r.runs}" data-ind-calc="runs"></div>
        ${r.act === 'm' ? `<div class="pi-num"><span>蓝图 ME</span><input type="number" class="pi-input" min="0" max="10" value="${r.me}" data-ind-calc="me"></div>
        <div class="pi-num"><span>蓝图 TE</span><input type="number" class="pi-input" min="0" max="20" step="2" value="${r.te}" data-ind-calc="te"></div>` : ''}
        ${invFor(r.pid) ? `<label class="pi-check ind-invent"><input type="checkbox" data-ind-calc="invent"${C.invent ? ' checked' : ''}><span>计入发明成本（没有 T2 原图时勾选）</span></label>` : ''}
      </div>
      <div class="pi-stats ind-stats">
        <div><span>单个成本</span><b>${isk(r.perUnit)}</b></div>
        <div><span>${F.prod === 'sell' ? '吉他卖价' : '吉他收价'}</span><b>${r.unitPrice != null ? isk(r.unitPrice) : '无报价'}</b></div>
        <div class="${r.profit >= 0 ? 'pi-stat-main' : 'ind-stat-loss'}"><span>总利润</span><b>${isk(r.profit)}</b></div>
        <div><span>利润率</span><b>${margin.toFixed(1)}%</b></div>
        <div><span>制造时间</span><b>${fmtTime(r.j.secs)}</b></div>
        <div><span>每小时利润</span><b>${isk(hours ? r.profit / hours : 0)}</b></div>
        <div><span>日均成交（吉他）</span><b id="indVol">…</b></div>
      </div>
      <div class="ind-breakdown">
        <span>材料 <b>${isk(r.matCost)}</b></span>
        <span>安装费 <b>${isk(r.j.cost)}</b></span>
        ${r.inv ? `<span>发明 <b>${isk(r.invCost)}</b></span>` : ''}
        ${r.bpCost ? `<span>蓝图 <b>${isk(r.bpCost)}</b></span>` : ''}
        <span>卖出所得 <b>${isk(r.revenue)}</b></span>
      </div>
    </div>
    <div class="pi-card"><div class="pi-card-head"><h3>材料</h3></div>
      <div class="pi-table-wrap"><table class="pi-table ind-mats"><thead><tr><th>材料</th><th class="num">基础</th><th class="num">实际</th><th class="num">单价</th><th class="num">小计</th><th></th></tr></thead><tbody>${matRows}</tbody></table></div></div>
    ${invHtml}
    ${bpCard(r)}
    <div class="pi-card"><div class="pi-card-head"><h3>去哪里造最省钱</h3>
      <div class="segmented ind-scope">${[['region', '同星域'], ['near', '周边 10 跳'], ['high', '全部高安'], ['all', '全宇宙']].map(([k, l]) => `<button data-ind-set="scope" data-v="${k}" class="${F.scope === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>星系</th><th class="pi-hide-sm">星域</th><th class="num">${r.act === 'r' ? '反应' : '制造'}指数</th><th class="num">距吉他</th><th class="num pi-hide-sm">NPC 站</th><th class="num">安装费</th><th class="num">比当前</th></tr></thead><tbody>${whereRows || '<tr><td colspan="7" class="text-muted">没有符合条件的星系</td></tr>'}</tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>购物清单</h3>
      <button class="btn btn-ghost ind-copy" data-ind-copy title="可粘贴到游戏多重购买">复制清单</button></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>材料</th><th class="num">数量</th><th class="num">费用</th></tr></thead><tbody>${shopRows}</tbody></table></div></div>`;
}

// 蓝图价格卡片
function bpCard(r) {
  const esc = ctx.esc, isk = ctx.formatISK;
  const bp = r.bp;
  const sysName = (id) => (id ? D.sys.get(id)?.name || '星系 ' + id : '玩家建筑');
  const bpoRows = bp.bpo.slice(0, 3).map((o) => `<li><b>${isk(o[0])}</b><span>ME ${o[1]} / TE ${o[2]} · ${esc(sysName(o[4]))}</span></li>`).join('');
  const bpcRows = bp.bpc.slice(0, 3).map((c) => `<li><b>${isk(c[0])}<small> / 流程</small></b><span>${c[1]} 流程共 ${isk(c[2])} · ME ${c[3]} / TE ${c[4]} · ${esc(sysName(c[6]))}</span></li>`).join('');
  const modeOpts = [['none', '不计入'], ['bpo', '原图分摊'], ['bpc', '按拷贝单价']]
    .filter(([k]) => k === 'none' || (k === 'bpo' ? r.bpoPrice != null : r.bpcPerRun != null));
  return `<div class="pi-card"><div class="pi-card-head"><h3>蓝图</h3></div>
    <div class="ind-bp">
      <div class="ind-bp-col"><h4>市场原图</h4>${bp.onMarket ? (bp.market != null ? `<p class="ind-bp-price">${isk(bp.market)}</p>` : '<p class="text-muted">无卖单</p>') : '<p class="text-muted">不出售</p>'}</div>
      <div class="ind-bp-col"><h4>合同原图</h4>${bpoRows ? `<ul>${bpoRows}</ul>` : '<p class="text-muted">无</p>'}</div>
      <div class="ind-bp-col"><h4>合同拷贝</h4>${bpcRows ? `<ul>${bpcRows}</ul>` : '<p class="text-muted">无</p>'}</div>
    </div>
    <div class="ind-bp-mode">
      <span>蓝图成本</span>
      <div class="segmented">${modeOpts.map(([k, l]) => `<button data-ind-bpmode="${k}" class="${r.bpMode === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${r.bpMode === 'bpo' ? `<label class="pi-inline"><span>分摊到</span><input type="number" class="pi-input pi-tax" min="1" max="1000000" value="${C.bpoRuns}" data-ind-calc="bpoRuns"><span>个流程</span></label>` : ''}
      <span class="text-muted">${r.payback ? `原图 ${ctx.formatNumber(r.payback)} 流程回本` : ''}</span>
    </div>
  </div>`;
}

function candidates(act) {
  const cur = D.sys.get(F.sys);
  let list = [...D.indices.keys()].filter((id) => D.sys.has(id));
  if (F.scope === 'region' && cur) list = list.filter((id) => D.sys.get(id).region === cur.region);
  else if (F.scope === 'near') { const near = bfs(F.sys, 10); list = list.filter((id) => near.has(id)); }
  else if (F.scope === 'high') list = list.filter((id) => secInfo(D.sys.get(id).sec).cls === 'high');
  if (act === 'r') list = list.filter((id) => secInfo(D.sys.get(id).sec).cls !== 'high');
  return list;
}

// ---------- 利润排行 ----------
function rankRows() {
  const cat = RANK_CATS.find((c) => c[0] === F.rankCat)?.[2];
  const rows = [];
  for (const key of Object.keys(D.data.bp)) {
    const pid = Number(key);
    const b = BP(pid);
    if (b[5] !== F.rankAct) continue;
    const t = T(pid);
    if (cat && !cat.includes(tCat(pid))) continue;
    if (F.rankTech !== 'all' && String(t[3]) !== F.rankTech) continue;
    // 蓝图要能获得：T1 / 反应配方在 NPC 市场出售，T2 / T3 能发明，其余（派系等）要在公开合同里买得到拷贝
    const contractBpc = D.bpAll?.get(b[0])?.[1] ?? null;
    const needBpc = !b[7] && !invFor(pid);
    if (needBpc ? contractBpc == null : !RANK_METAS.has(t[4])) continue;
    const unit = prodPrice(pid);
    if (!unit) continue;
    // 均价远高于 CCP 调整价格的，多是成交极少、价格被拉高的物品
    const adj = D.adjusted.get(pid);
    if (!jita.has(pid) && adj && unit > adj * 6 && unit - adj > 1e6) continue;
    if (b[3].some(([id]) => matPrice(id) == null)) continue;
    const inv = b[5] === 'm' ? invention(pid, 0) : null;
    const me = b[5] === 'r' ? 0 : inv ? inv.me : F.me, te = b[5] === 'r' ? 0 : inv ? inv.te : F.te;
    const j = job(pid, 1, me, te);
    const mats = j.items.reduce((s, it) => s + it.qty * matPrice(it.id) * (1 + matFee() / 100), 0);
    const cost = mats + j.cost + (inv ? inv.perRun : 0) + (needBpc ? contractBpc : 0);
    const revenue = unit * j.out * (1 - sellFee() / 100);
    const profit = revenue - cost;
    // 利润率超过 90% 的基本是有价无市（成本远低于挂单价），不参与排行
    if (revenue && profit / revenue > 0.9) continue;
    rows.push({ pid, unit, cost, perUnit: cost / j.out, profit, margin: revenue ? profit / revenue : 0, ph: profit / (j.secs / 3600), secs: j.secs, inv: Boolean(inv), bpc: needBpc });
  }
  const key = F.rankSort, mul = F.rankDir === 'asc' ? 1 : -1;
  if (key === 'name') return rows.sort((a, b) => mul * tName(a.pid).localeCompare(tName(b.pid), 'zh'));
  return rows.sort((a, b) => mul * (a[key] - b[key]));
}

function renderRank(body) {
  const esc = ctx.esc, isk = ctx.formatISK;
  if (!D.bpAll) {
    body.innerHTML = '<div class="pi-loading">读取公开合同蓝图价格…</div>';
    loadBpAll().then(() => { if (F.tab === 'rank') renderRank(body); });
    return;
  }
  const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-ind-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  R.rows = rankRows();
  const top = R.rows.slice(0, 100);
  const rows = top.map((x, i) => `
    <tr data-ind-pick="${x.pid}" title="打开制造计算器">
      <td class="pi-rank">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ICON(x.pid)}" alt="" width="28" height="28" loading="lazy"><span>${esc(tName(x.pid))}<small>${{ 1: 'T1', 2: 'T2', 3: 'T3' }[T(x.pid)[3]] || ''}</small>${x.bpc ? '<small class="ind-tag-bpc" title="NPC 市场不卖这张蓝图，成本已计入公开合同里最便宜的拷贝（每流程）">合同拷贝</small>' : ''}</span></div></td>
      <td class="num pi-hide-sm">${isk(x.perUnit)}</td>
      <td class="num pi-hide-sm">${isk(x.unit)}</td>
      <td class="num">${isk(x.profit)}</td>
      <td class="num pi-hide-sm">${(x.margin * 100).toFixed(1)}%</td>
      <td class="num ${x.ph >= 0 ? 'pi-profit' : 'down'}">${isk(x.ph)}</td>
      <td class="num" data-ind-vol="${x.pid}">…</td>
    </tr>`).join('');
  body.innerHTML = `
    <div class="pi-card ind-rank-filters">
      <div class="pi-inline"><span>类别</span>${seg('rankCat', RANK_CATS.map(([k, l]) => [k, l]), F.rankCat)}</div>
      <div class="ind-rank-row">
        <div class="pi-inline"><span>活动</span>${seg('rankAct', [['m', '制造'], ['r', '反应']], F.rankAct)}</div>
        <div class="pi-inline"><span>科技</span>${seg('rankTech', [['all', '全部'], ['1', 'T1'], ['2', 'T2'], ['3', 'T3']], F.rankTech)}</div>
      </div>
      <p class="pi-note">${R.refined ? '前 30 名为吉他实时价，其余为全服均价' : '全服均价估算'}
        <button class="btn btn-ghost ind-refine" data-ind-refine ${R.busy ? 'disabled' : ''}>${R.busy ? '精算中…' : '用吉他行情精算前 30 名'}</button></p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap ind-rank-wrap"><table class="pi-table">
      <thead><tr><th>#</th>${[['name', '产品', ''], ['perUnit', '单个成本', 'num pi-hide-sm'], ['unit', '单价', 'num pi-hide-sm'], ['profit', '每流程利润', 'num'], ['margin', '利润率', 'num pi-hide-sm'], ['ph', '每小时利润', 'num']]
        .map(([k, l, c]) => sortTh('ind-sort', F.rankSort, F.rankDir, k, l, c)).join('')}<th class="num">日均成交</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="text-muted">没有符合条件的产品</td></tr>'}</tbody></table></div></div>`;
  // 前 25 行的成交量
  let i = 0;
  const ids = top.slice(0, 25).map((x) => x.pid);
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const h = await dailyVolume(id);
      const cell = body.querySelector(`[data-ind-vol="${id}"]`);
      if (cell) cell.textContent = h ? ctx.formatNumber(Math.round(h.vol)) : '—';
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]);
  body.querySelectorAll('[data-ind-vol]').forEach((c, k) => { if (k >= 25) c.textContent = ''; });
}

async function refineRank() {
  if (R.busy) return;
  R.busy = true;
  renderTab();
  const top = R.rows.slice(0, 30);
  const ids = new Set();
  for (const x of top) {
    ids.add(x.pid);
    BP(x.pid)[3].forEach(([id]) => ids.add(id));
    const inv = invFor(x.pid);
    if (inv) inv[3].forEach(([id]) => ids.add(id));
  }
  await loadJita([...ids], (done, total) => { const b = document.querySelector('[data-ind-refine]'); if (b) b.textContent = `读取吉他行情 ${done}/${total}`; });
  R.busy = false;
  R.refined = true;
  if (F.tab === 'rank') renderTab();
}

// ---------- 制造地点 ----------
function renderWhere(body) {
  const esc = ctx.esc;
  const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-ind-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const INDEX = [['manufacturing', '制造'], ['invention', '发明'], ['reaction', '反应'], ['copying', '拷贝'], ['researching_material_efficiency', 'ME 研究'], ['researching_time_efficiency', 'TE 研究']];
  let list = [...D.indices.entries()].filter(([id]) => D.sys.has(id)).map(([id, idx]) => ({ id, s: D.sys.get(id), idx }));
  list = list.filter((x) => F.sec[secInfo(x.s.sec).cls]);
  if (F.scope === 'region') list = list.filter((x) => x.s.region === D.sys.get(F.sys)?.region);
  else if (F.scope === 'near') { const near = bfs(F.sys, F.jumps); list = list.filter((x) => near.has(x.id)); }
  if (F.whereSort === 'reaction') list = list.filter((x) => secInfo(x.s.sec).cls !== 'high');   // 反应只能在低安 / 00
  const jumps = (id) => D.jumpsFromJita.get(id) ?? 999;
  const ws = F.whereSort, mul = F.whereDir === 'asc' ? 1 : -1;
  const cmp = ws === 'name' ? (a, b) => a.s.name.localeCompare(b.s.name, 'zh')
    : ws === 'region' ? (a, b) => (D.regions.get(a.s.region) || '').localeCompare(D.regions.get(b.s.region) || '', 'zh')
    : ws === 'jumps' ? (a, b) => jumps(a.id) - jumps(b.id)
    : ws === 'stations' ? (a, b) => (a.s.stations || 0) - (b.s.stations || 0)
    : (a, b) => (a.idx[ws] || 0) - (b.idx[ws] || 0);
  list.sort((a, b) => mul * cmp(a, b) || jumps(a.id) - jumps(b.id));
  const rows = list.slice(0, 150).map((x, i) => `
    <tr data-ind-sys-pick="${x.id}" class="${x.id === F.sys ? 'active' : ''}" title="设为制造星系">
      <td class="pi-rank">${i + 1}</td><td>${sysLabel(x.id)}</td><td class="pi-hide-sm">${esc(D.regions.get(x.s.region) || '')}</td>
      ${INDEX.map(([k]) => `<td class="num${k === F.whereSort ? ' ind-hl' : ''}${['copying', 'researching_material_efficiency', 'researching_time_efficiency'].includes(k) ? ' pi-hide-sm' : ''}">${((x.idx[k] || 0) * 100).toFixed(2)}%</td>`).join('')}
      <td class="num">${D.jumpsFromJita.get(x.id) ?? '—'}</td><td class="num pi-hide-sm">${x.s.stations || '—'}</td>
    </tr>`).join('');
  body.innerHTML = `
    <div class="pi-card ind-rank-filters">
      <div class="ind-rank-row">
        <div class="pi-inline"><span>范围</span>${seg('scope', [['region', '同星域'], ['near', '周边'], ['all', '全宇宙']], F.scope === 'high' ? 'all' : F.scope)}</div>
        ${F.scope === 'near' ? `<div class="pi-inline"><span>跳数</span>${seg('jumps', [[5, '5'], [10, '10'], [15, '15'], [20, '20']], F.jumps)}</div>` : ''}
        <div class="pi-checks">${[['high', '高安'], ['low', '低安'], ['null', '00']].map(([k, l]) => `<label class="pi-check sec-${k}"><input type="checkbox" data-ind-sec="${k}"${F.sec[k] ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
      </div>
    </div>
    <div class="pi-card"><div class="pi-table-wrap ind-rank-wrap"><table class="pi-table">
      <thead><tr><th>#</th>${sortTh('ind-wsort', F.whereSort, F.whereDir, 'name', '星系')}${sortTh('ind-wsort', F.whereSort, F.whereDir, 'region', '星域', 'pi-hide-sm')}${INDEX.map(([k, l]) => sortTh('ind-wsort', F.whereSort, F.whereDir, k, l, 'num' + (['copying', 'researching_material_efficiency', 'researching_time_efficiency'].includes(k) ? ' pi-hide-sm' : ''))).join('')}${sortTh('ind-wsort', F.whereSort, F.whereDir, 'jumps', '距吉他', 'num')}${sortTh('ind-wsort', F.whereSort, F.whereDir, 'stations', 'NPC 站', 'num pi-hide-sm')}</tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="text-muted">没有符合条件的星系</td></tr>'}</tbody></table></div></div>`;
}

// ---------- 我的工业 ----------
async function renderMine(body) {
  if (!ctx.hasEsiToken()) {
    body.innerHTML = '<div class="pi-empty"><p>绑定 ESI 后可查看角色的工业任务与蓝图</p></div>';
    return;
  }
  body.innerHTML = '<div class="pi-loading">读取工业任务与蓝图…</div>';
  const token = await ctx.ensureEsiToken();
  const id = token.character_id;
  const [jobs, bps] = await Promise.all([
    ctx.esiAuthFetch(`/characters/${id}/industry/jobs/?include_completed=true`).catch((e) => ({ error: e.message })),
    ctx.esiAuthFetch(`/characters/${id}/blueprints/`).catch((e) => ({ error: e.message }))
  ]);
  if (F.tab !== 'mine') return;
  const esc = ctx.esc, num = ctx.formatNumber;
  const name = (tid) => D.data.types[tid]?.[0] || '物品 ' + tid;
  const now = Date.now();
  let jobsHtml;
  if (jobs.error) jobsHtml = `<p class="text-muted">工业任务读取失败：${esc(jobs.error)}</p>`;
  else if (!jobs.length) jobsHtml = '<p class="text-muted">最近没有工业任务</p>';
  else {
    const order = { active: 0, ready: 1, paused: 2 };
    const list = jobs.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(a.end_date) - new Date(b.end_date));
    jobsHtml = `<div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>活动</th><th>蓝图 / 产品</th><th class="num">流程</th><th>状态</th><th class="num">剩余时间</th><th class="num pi-hide-sm">安装费</th></tr></thead><tbody>${list.slice(0, 100).map((j) => {
      const left = new Date(j.end_date).getTime() - now;
      const done = j.status === 'active' && left <= 0;
      const pid = j.product_type_id || j.blueprint_type_id;
      return `<tr${BP(pid) ? ` data-ind-pick="${pid}"` : ''}><td>${ACT_ZH[j.activity_id] || '活动 ' + j.activity_id}</td>
        <td><div class="pi-prod"><img src="${anyIcon(pid, j.activity_id === 5 || j.activity_id === 8)}" alt="" width="24" height="24" loading="lazy"><span>${esc(name(pid))}</span></div></td>
        <td class="num">${num(j.runs)}</td>
        <td><span class="ind-status ${done ? 'ready' : j.status}">${done ? '可交付' : STATUS_ZH[j.status] || j.status}</span></td>
        <td class="num">${j.status === 'active' && left > 0 ? fmtTime(left / 1000) : '—'}</td>
        <td class="num pi-hide-sm">${j.cost ? ctx.formatISK(j.cost) : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  let bpsHtml;
  if (bps.error) {
    bpsHtml = `<p class="text-muted">蓝图读取失败：${esc(bps.error)}</p><p class="pi-note">需要蓝图读取权限，开通后重新绑定 ESI。</p>`;
  } else if (!bps.length) bpsHtml = '<p class="text-muted">没有蓝图</p>';
  else {
    const prodOf = new Map(Object.entries(D.data.bp).map(([pid, b]) => [b[0], Number(pid)]));
    const list = bps.slice().sort((a, b) => name(a.type_id).localeCompare(name(b.type_id), 'zh'));
    bpsHtml = `<div class="pi-table-wrap ind-rank-wrap"><table class="pi-table"><thead><tr><th>蓝图</th><th>类型</th><th class="num">ME</th><th class="num">TE</th><th class="num">剩余流程</th><th class="num pi-hide-sm">数量</th></tr></thead><tbody>${list.map((b) => {
      const pid = prodOf.get(b.type_id);
      return `<tr${pid ? ` data-ind-pick="${pid}" data-me="${b.material_efficiency}" data-te="${b.time_efficiency}"` : ''}>
        <td><div class="pi-prod"><img src="${BP_ICON(b.type_id, 32, b.runs !== -1)}" alt="" width="24" height="24" loading="lazy"><span>${esc(name(b.type_id))}</span></div></td>
        <td>${b.runs === -1 ? '原图' : '拷贝'}</td><td class="num">${b.material_efficiency}</td><td class="num">${b.time_efficiency}</td>
        <td class="num">${b.runs === -1 ? '∞' : num(b.runs)}</td><td class="num pi-hide-sm">${b.quantity > 0 ? num(b.quantity) : 1}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  body.innerHTML = `
    <div class="pi-card"><div class="pi-card-head"><h3>工业任务</h3></div>${jobsHtml}</div>
    <div class="pi-card"><div class="pi-card-head"><h3>我的蓝图</h3></div>${bpsHtml}</div>`;
}

// ---------- 侧栏 ----------
const SIDE_TABS = [
  ['calc', '制造计算器', '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h3M13 12h3M8 16h3M13 16h3"/>'],
  ['rank', '利润排行', '<path d="M3 20h18"/><path d="M6 16V10M12 16V5M18 16v-8"/>'],
  ['where', '制造地点', '<circle cx="12" cy="10" r="3"/><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/>'],
  ['mine', '我的工业', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>']
];

// 分组 -> 产品；大类按利润排行的分类归并，其余归「其他」
let groupIndex = null;
function sideIndex() {
  if (groupIndex) return groupIndex;
  const byGroup = new Map();
  for (const key of Object.keys(D.data.bp)) {
    const gid = T(key)[2];
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(Number(key));
  }
  const cats = RANK_CATS.filter(([k]) => k !== 'all').map(([k, label, ids]) => ({ key: k, label, ids, groups: [] }));
  const other = { key: 'other', label: '其他', ids: null, groups: [] };
  for (const [gid, list] of byGroup) {
    const catId = D.data.groups[gid]?.[1];
    const cat = cats.find((c) => c.ids.includes(catId)) || other;
    list.sort((a, b) => tName(a).localeCompare(tName(b), 'zh'));
    cat.groups.push({ gid, name: D.data.groups[gid]?.[0] || '分组 ' + gid, list });
  }
  groupIndex = [...cats, other].filter((c) => c.groups.length);
  for (const c of groupIndex) c.groups.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return groupIndex;
}

function sideItem(pid) {
  return `<button type="button" class="ind-side-item${pid === C.pid ? ' active' : ''}" data-side-pick="${pid}"><img src="${ICON(pid)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(tName(pid))}</span>${BP(pid)[5] === 'r' ? '<small>反应</small>' : invFor(pid) ? '<small>T2</small>' : ''}</button>`;
}

function renderSide() {
  const el = $('indSide');
  if (!el || !D.data) return;
  const nav = `<nav class="ind-side-nav">${SIDE_TABS.map(([k, l, icon]) => `<button type="button" class="profile-nav-btn${F.tab === k ? ' active' : ''}" data-side-tab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>${l}</button>`).join('')}</nav>`;
  if (SIDE.q) {
    const hits = productHits(SIDE.q, 60);
    el.innerHTML = nav + `<div class="ind-side-section"><h4>搜索结果 <small>${hits.length >= 60 ? '前 60 个' : hits.length + ' 个'}</small></h4>${hits.map(sideItem).join('') || '<p class="ind-side-empty">没有可制造的匹配物品</p>'}</div>`;
    return;
  }
  const recent = (ctx.store.getJSON(RECENT_KEY, []) || []).filter((x) => BP(x));
  // 与市场中心一致：「物品分类」与「最近查看」是两个独立的标签
  const tabs = `<div class="sidebar-tabs ind-side-tabs" role="tablist">${[['catalog', '物品分类'], ['recent', '最近查看']].map(([k, l]) => `<button type="button" class="tab-btn${SIDE.pane === k ? ' active' : ''}" data-side-pane="${k}" role="tab" aria-selected="${SIDE.pane === k}">${l}</button>`).join('')}</div>`;
  if (SIDE.pane === 'recent') {
    el.innerHTML = nav + tabs + (recent.length
      ? `<div class="ind-side-section">${recent.map(sideItem).join('')}<button type="button" class="link-btn clear-recent" data-side-clear>清空最近查看</button></div>`
      : '<div class="empty-state"><p>还没有查看记录</p></div>');
    return;
  }
  const tree = sideIndex().map((c) => {
    const n = c.groups.reduce((t, g) => t + g.list.length, 0);
    return `<details class="ind-side-cat" data-side-key="c:${c.key}"${SIDE.open.has('c:' + c.key) ? ' open' : ''}>
      <summary>${ctx.esc(c.label)}<small>${n}</small></summary>
      ${c.groups.map((g) => `<details class="ind-side-group" data-side-key="g:${g.gid}"${SIDE.open.has('g:' + g.gid) ? ' open' : ''}><summary>${ctx.esc(g.name)}<small>${g.list.length}</small></summary><div class="ind-side-items" data-gid="${g.gid}"></div></details>`).join('')}
    </details>`;
  }).join('');
  el.innerHTML = nav + tabs + `<div class="ind-side-section">${tree}</div>`;
  el.querySelectorAll('.ind-side-group[open]').forEach(fillGroup);
}

// 分组展开时才渲染物品（装备类有上千件）
function fillGroup(d) {
  const box = d.querySelector?.(':scope > .ind-side-items');
  if (!box || box.childElementCount) return;
  const gid = Number(box.dataset.gid);
  for (const c of sideIndex()) {
    const g = c.groups.find((x) => x.gid === gid);
    if (g) { box.innerHTML = g.list.map(sideItem).join(''); return; }
  }
}

function onSideClick(e) {
  const pane = e.target.closest('[data-side-pane]');
  if (pane) { SIDE.pane = pane.dataset.sidePane; ctx.store.set(SIDE_PANE_KEY, SIDE.pane); renderSide(); return; }
  if (e.target.closest('[data-side-clear]')) { ctx.store.setJSON(RECENT_KEY, []); renderSide(); return; }
  const tab = e.target.closest('[data-side-tab]');
  if (tab) { F.tab = tab.dataset.sideTab; save(); renderTab(); ctx.closeDrawer?.(); return; }
  const pick = e.target.closest('[data-side-pick]');
  if (pick) {
    selectProduct(Number(pick.dataset.sidePick), false);
    renderTab();
    ctx.closeDrawer?.();
    document.querySelector('#industryView .kb-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ---------- 事件 ----------
function onClick(e) {
  const tab = e.target.closest('[data-ind-tab]');
  if (tab) { F.tab = tab.dataset.indTab; save(); renderTab(); return; }
  const rs = e.target.closest('[data-ind-sort]');
  if (rs) { const k = rs.dataset.indSort; F.rankDir = flipSort(F.rankSort, F.rankDir, k, RANK_SORT_DIR); F.rankSort = k; save(); renderTab(); return; }
  const ws = e.target.closest('[data-ind-wsort]');
  if (ws) {
    const k = ws.dataset.indWsort;
    F.whereDir = flipSort(F.whereSort, F.whereDir, k, WHERE_SORT_DIR);
    F.whereSort = k;
    save();
    renderTab();
    return;
  }
  const set = e.target.closest('[data-ind-set]');
  if (set) {
    const k = set.dataset.indSet;
    let v = set.dataset.v;
    if (['rig', 'rrig', 'jumps'].includes(k)) v = Number(v);
    if (['fac', 'rfac'].includes(k) && v !== 'npc') v = Number(v);
    F[k] = v;
    if (k === 'rankAct' && v === 'r') F.rankTech = 'all';
    save();
    if (k === 'skills') { ensureSkills().then(() => { renderSettings(); refresh(); }); return; }
    renderSettings();
    refresh();
    return;
  }
  const pickSys = e.target.closest('[data-ind-sys]');
  if (pickSys) { F.sys = Number(pickSys.dataset.indSys); save(); renderSettings(); refresh(); return; }
  const rowSys = e.target.closest('[data-ind-sys-pick]');
  if (rowSys) { F.sys = Number(rowSys.dataset.indSysPick); save(); renderSettings(); refresh(); ctx.showToast('已设为制造星系：' + (D.sys.get(F.sys)?.name || ''), 'success', 1600); return; }
  const pick = e.target.closest('[data-ind-pick]');
  if (pick) {
    const pid = Number(pick.dataset.indPick);
    selectProduct(pid, false);
    if (pick.dataset.me != null) { C.me = Number(pick.dataset.me); C.te = Number(pick.dataset.te); C.invent = false; }
    renderTab();
    document.querySelector('#industryView .kb-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const build = e.target.closest('[data-ind-build]');
  if (build) {
    const id = Number(build.dataset.indBuild);
    if (C.build.has(id)) C.build.delete(id); else C.build.add(id);
    drawCalc();
    return;
  }
  if (e.target.closest('[data-ind-copy]')) {
    const text = (R.shopping || []).map(([id, q]) => `${tName(id)}\t${q}`).join('\n');
    navigator.clipboard.writeText(text).then(() => ctx.showToast(`已复制 ${R.shopping.length} 种材料`, 'success')).catch(() => ctx.showToast('浏览器阻止了复制', 'error'));
    return;
  }
  if (e.target.closest('[data-ind-refine]')) refineRank();
  const mode = e.target.closest('[data-ind-bpmode]');
  if (mode) { C.bpMode = mode.dataset.indBpmode; C.me = null; C.te = null; drawCalc(); }
}

function refresh() {
  if (F.tab === 'calc') { if (C.pid && $('indCalc')) drawCalc(); else renderTab(); }
  else renderTab();
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.indNum) {
    const lim = { tax: [0, 50], me: [0, 10], te: [0, 20], subMe: [0, 10] }[t.dataset.indNum];
    F[t.dataset.indNum] = Math.min(lim[1], Math.max(lim[0], Number(t.value) || 0));
    t.value = F[t.dataset.indNum];
    save(); renderSettings(); refresh();
  } else if (t.dataset.indSec) {
    F.sec[t.dataset.indSec] = t.checked; save(); refresh();
  } else if (t.dataset.indCalc) {
    const k = t.dataset.indCalc;
    if (k === 'invent') { C.invent = t.checked; C.me = null; C.te = null; }
    else if (k === 'dec') { C.dec = Number(t.value); C.me = null; C.te = null; }
    else if (k === 'runs') C.runs = Math.max(1, Math.min(100000, Math.round(Number(t.value) || 1)));
    else if (k === 'me') C.me = Math.max(0, Math.min(10, Math.round(Number(t.value) || 0)));
    else if (k === 'te') C.te = Math.max(0, Math.min(20, Math.round(Number(t.value) || 0)));
    else if (k === 'bpoRuns') C.bpoRuns = Math.max(1, Math.min(1000000, Math.round(Number(t.value) || 1)));
    drawCalc();
  }
}

let suggestTimer = 0;
function onInput(e) {
  const t = e.target;
  clearTimeout(suggestTimer);
  if (t.id === 'indSys') suggestTimer = setTimeout(() => sysSuggest(t.value.trim()), 120);
  else if (t.id === 'indProd') suggestTimer = setTimeout(() => productSuggest(t.value), 120);
}
