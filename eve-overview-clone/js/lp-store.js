// ===== LP 商店 =====
// LP 商店：按军团浏览全部兑换项，计算每 LP 价值（ISK/LP）= (产物价值 − 所需物品成本 − ISK 费用) ÷ LP。
//          蓝图拷贝两种算法（估价设置「蓝图兑换品」）：制造后卖产物 =「产物价 × 流程数（扣税）− 材料价 × 流程数」（材料效率 0，材料计入花费）；
//          直接卖蓝图 = 公开合同里同种拷贝的最低每流程价 × 流程数（击杀记录服务 /api/kb/bpprices，仅宁静服；合同出售不扣销售税）。
//          制造按「制造」页的设置（industry.js 的 lpMake）：星系指数、设施与改装件的材料加成、安装费（含设施税与 SCC 附加费），并列出制造所需技能。
// 卖出税费：默认按技能（制造页的技能设置：会计学减销售税，产物挂卖单时加经纪人关系后的中介费，挂收单买材料也加中介费），也可手动填。
// 全服排行：所有 LP 商店兑换项（按 offer 去重）的 ISK/LP 排行，前列可用吉他行情精算。
// 比例：表格同时列出挂单比例（产物挂卖单，扣销售税和中介费）和收单比例（产物直接卖给收单，只扣销售税），
//      两个比例都能填区间（最低–最高）筛选，并显示各有多少项落在区间里（LP 商店和全服排行共用）。
// 我的 LP：ESI 角色忠诚点（esi-characters.read_loyalty.v1），按各军团最佳兑换估算价值。
// 物品商人：活动代币等在太空里的物品商人处兑换的配方，按代币列出能换什么、每个代币值多少 ISK，以及怎么换到这个代币（仅宁静服）。
// 价格：全服均价（一次请求，立即可用）或吉他卖单 / 收单（按物品逐个读取，有缓存）。
// 数据：lp-data.json 由 build_lp.mjs 生成（ESI /loyalty/stores + SDE 中文名）；item-trader.json 由 build_item_trader.mjs 生成（客户端兑换配方）。
import { SERVER, HUB, HUB_NAME, eveImage } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v18';
import { exportCsv, exportBtnHtml } from './csv-export.js?v=2';
let ctx;   // esc, formatISK, formatNumber, showToast, store, fetchESI, getHubPrices, getMarketPriceMap, esiAuthFetch, ensureEsiToken, hasEsiToken, closeDrawer
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-lp-v1';
const FORGE = HUB.id;   // 默认交易中心所在星域（吉他 / 曙光服为长征）
const LP_SCOPE = 'esi-characters.read_loyalty.v1';
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
const BPC_ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/bpc?size=${size}`;
const LOGO = (id, size = 32) => eveImage(`corporations/${id}/logo`, size);
const RANK_LIMIT = 200;
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];
const REFINE_TOP = 40;
// 物品商人兑换配方来自宁静服客户端资源；国服客户端的配方不同，暂时只有宁静服
const TRADE_URL = SERVER.id === 'tq' ? 'item-trader.json?v=1' : null;

const TABS = [
  ['store', 'LP 商店', '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9h18"/><path d="M9 20v-6h6v6"/>'],
  ['rank', '全服排行', '<path d="M3 20h18"/><path d="M6 16V10M12 16V5M18 16v-8"/>'],
  ['mine', '我的 LP', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'],
  ['trade', '物品商人', '<path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/>']
].filter(([k]) => k !== 'trade' || TRADE_URL);

const D = { loading: null, data: null, avg: new Map(), bpAll: null, bpLoading: null, offersByType: new Map(), corpById: new Map(), corpsByOffer: new Map(), history: new Map() };
const F = { tab: 'store', corp: 1000035, price: 'sell', mat: 'sell', tax: 3.4, taxMode: 'skill', kind: 'all', sort: 'iskSell', dir: 'desc', rng: null, faction: 'all', bp: 'make', token: 0, tSort: 'per', tDir: 'desc', tGroup: 'all' };
const S = { times: new Map(), q: '', rankQ: '', sideQ: '', tQ: '', open: new Set(), tOpen: new Set(), loadingJita: null, progress: '', refined: new Set(), mine: null, mineError: null, mineLoading: false, rendered: '', mkt: undefined, mktLoading: null };
const jita = new Map();   // 吉他行情 id -> { sell, buy }
// 制造页模块（industry.js）：蓝图制造的材料、安装费、所需技能与按技能的税费；加载完之前按旧算法（材料效率 0、无安装费、手动税费）
let IND = null, indLoading = null;
function loadInd() {
  if (!indLoading && ctx.industry) {
    indLoading = ctx.industry().then(async (m) => { await m.lpEnv(); IND = m; loadMkt(); })
      .catch(() => { indLoading = null; })
      .finally(() => { if ($('lpMain')?.dataset.ready && $('lpSettings')) { renderSettings(); refreshBody(); } });
  }
  return indLoading;
}
const skillTax = () => F.taxMode !== 'manual' && IND;
// 卖出税费 %（产物；side 为卖出方式，卖给收单不交中介费）与买材料的中介费 %
function sellTaxPct(side = F.price) {
  if (!skillTax()) return F.tax;
  const t = IND.lpSettings();
  return t.salesTax + (side === 'buy' ? 0 : t.brokerFee);
}
const buyFeePct = () => (skillTax() && F.mat === 'buy' ? IND.lpSettings().brokerFee : 0);
const pct = (x) => Math.round(x * 100) / 100;
const makeOf = (o) => (o.bp && IND ? IND.lpMake(o.bp[0], o.qty) : null);

export function initLp(context) {
  ctx = context;
  Object.assign(F, ctx.store.getJSON(STORE_KEY, {}) || {});
  if (F.sort === 'isk' || F.sort === 'iskLp') F.sort = F.price === 'buy' ? 'iskBuy' : 'iskSell';   // 旧版只有一列 ISK/LP
  if (!SORT_DIR[F.sort]) { F.sort = 'iskSell'; F.dir = 'desc'; }
  const r = F.rng || {};
  F.rng = Object.fromEntries(['sell', 'buy'].map((k) => [k, Array.isArray(r[k]) ? [0, 1].map((i) => String(r[k][i] ?? '')) : ['', '']]));
  if (F.dir !== 'asc' && F.dir !== 'desc') F.dir = SORT_DIR[F.sort];
  if (F.bp !== 'bpc' || !SERVER.kb) F.bp = 'make';
  if (!T_SORT_DIR[F.tSort]) { F.tSort = 'per'; F.tDir = 'desc'; }
  if (F.tDir !== 'asc' && F.tDir !== 'desc') F.tDir = T_SORT_DIR[F.tSort];
  if (F.tab === 'trade' && !TRADE_URL) F.tab = 'store';
  // 个人中心切换角色：「我的 LP」重新读取
  window.addEventListener('eve-account-change', () => { S.mine = null; S.mineError = null; });
}

// 表头排序（与市场中心订单簿一致）：点击表头按该列排序，再点一次反向；首次点击用该列更有用的方向
const SORT_DIR = { name: 'asc', lp: 'asc', iskCost: 'asc', req: 'asc', revenue: 'desc', profit: 'desc', iskSell: 'desc', iskBuy: 'desc', daily: 'desc', turnover: 'desc' };
const ratioOf = (v, side) => (v[side].missing ? null : v[side].iskLp);
const SORT_KEY = {
  lp: (r) => r.o.lp, iskCost: (r) => r.o.isk, req: (r) => r.v.reqCost + r.v.matCost,
  revenue: (r) => (r.v.missing ? null : r.v.revenue), profit: (r) => (r.v.missing ? null : r.v.profit),
  iskSell: (r) => ratioOf(r.v, 'sell'), iskBuy: (r) => ratioOf(r.v, 'buy'),
  daily: (r) => volOf(r.o)?.daily ?? null, turnover: (r) => volOf(r.o)?.isk ?? null
};
// trade：物品商人表格（排序单独记）
const sortTh = (key, label, cls = '', trade = false) => {
  const on = (trade ? F.tSort : F.sort) === key, dir = trade ? F.tDir : F.dir;
  return `<th class="sortable${cls ? ' ' + cls : ''}${on ? ' sorted' : ''}" data-lp-${trade ? 'tsort' : 'sort'}="${key}" data-dir="${on ? dir : ''}" aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}</th>`;
};
const save = () => ctx.store.setJSON(STORE_KEY, F);

// ---------- 数据 ----------
function loadData() {
  if (!D.loading) {
    D.loading = (async () => {
      const [data, avg] = await Promise.all([
        fetch(SERVER.lpData).then((r) => { if (!r.ok) throw new Error('LP 数据 ' + r.status); return r.json(); }),
        ctx.getMarketPriceMap().catch(() => new Map())
      ]);
      D.data = data;
      D.avg = avg;
      for (const c of data.corps) D.corpById.set(c.id, c);
      for (const [corp, ids] of Object.entries(data.stores)) {
        for (const id of ids) {
          if (!D.corpsByOffer.has(id)) D.corpsByOffer.set(id, []);
          D.corpsByOffer.get(id).push(Number(corp));
        }
      }
      if (!D.corpById.has(F.corp)) F.corp = data.corps[0]?.id;
    })().catch((error) => { D.loading = null; throw error; });
  }
  return D.loading;
}

const tName = (id) => D.data?.names[id] || TD.data?.names[id] || String(id);
const offer = (id) => {
  const o = D.data.offers[id];
  return { id: Number(id), type: o[0], qty: o[1], lp: o[2], isk: o[3], ak: o[4], req: o[5], bp: D.data.bp[o[0]] || null };
};
const corpName = (id) => D.corpById.get(id)?.name || String(id);

// 某个物品的单价：side = sell / buy / avg。先用交易中心实时行情（逐个读取），其次交易中心快照（与制造页利润排行同一份，全部物品），
// 都没有时回落到全服均价（标 ≈）。
// strict：产物卖给收单时只认收单价——行情读到了但没有收单就是卖不掉，不拿卖单价或均价代替（与制造页利润排行一致）
function price(id, side, strict) {
  if (side !== 'avg') {
    const j = jita.get(id);
    const live = j && (j.sell !== undefined || j.buy !== undefined) ? j : null;   // 读取失败的记成 {}
    const p = live ? live[side] : S.mkt?.get(id)?.[side];
    if (p > 0) return { v: p, src: live ? 'jita' : 'mkt' };
    if (strict && (live || S.mkt)) return { v: null, src: 'none' };
  }
  const a = D.avg.get(id);
  return a ? { v: a, src: 'avg' } : { v: null, src: null };
}
const prodStrict = () => F.price === 'buy';

// 公开合同里各蓝图的最低价：type_id -> [原图价, 拷贝每流程价]（只有宁静服有合同数据）
function loadBpAll() {
  if (D.bpAll || D.bpLoading || !SERVER.kb) return D.bpLoading;
  D.bpLoading = fetch('/api/kb/bpprices').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((j) => { D.bpAll = new Map(Object.entries(j.all || {}).map(([k, v]) => [Number(k), v])); })
    .finally(() => { D.bpLoading = null; if ($('lpMain')?.dataset.ready) refreshBody(); });
  return D.bpLoading;
}
const bpcRun = (o) => D.bpAll?.get(o.type)?.[1] ?? null;

// 估值时逐个取价并记下：缺价格（missing）、用了全服均价（approx，显示 ≈）、卖给收单但没有收单（noBuy）
function pricer() {
  const st = { missing: false, approx: false, noBuy: false };
  st.use = (id, side, strict) => {
    const p = price(id, side, strict);
    if (p.v == null) { st.missing = true; if (p.src === 'none') st.noBuy = true; }
    else if (side !== 'avg' && p.src === 'avg') st.approx = true;
    return p.v || 0;
  };
  return st;
}

// 兑换项估值；mode：蓝图兑换品按 make（制造后卖产物）还是 bpc（直接卖蓝图，合同价）算，默认跟估价设置。
// 产物按估价设置的卖出价算利润；另外按挂卖单（sell）和卖给收单（buy）各算一次 ISK/LP（表格的挂单比例 / 收单比例），花费只算一次
function valueOf(o, mode = F.bp) {
  const pc = pricer(), use = pc.use;
  // 税费只算在卖出的产物上；制造材料是买入成本，计入花费
  let matCost = 0, jobCost = 0, mk = null;
  if (o.bp && mode !== 'bpc') {
    mk = makeOf(o);
    // 有制造页数据时：材料按设施 / 改装件加成后的数量，另加安装费；否则材料效率 0、不计安装费
    if (mk) { matCost = mk.items.reduce((t, [m, q]) => t + use(m, F.mat) * q, 0); jobCost = mk.jobCost; }
    else matCost = o.bp[2].reduce((t, [m, q]) => t + use(m, F.mat) * q, 0) * o.qty;
  }
  const fee = 1 + buyFeePct() / 100;
  const reqCost = o.req.reduce((t, [m, q]) => t + use(m, F.mat) * q, 0) * fee;
  matCost *= fee;
  const cost = o.isk + reqCost + matCost + jobCost;
  // 产物按某种卖法（side = sell / buy / avg）的价值与利润；卖给收单时只认收单价
  const sale = (side) => {
    const sp = pricer();
    let unit, keep = 1 - sellTaxPct(side) / 100, bpcMissing = false;
    if (o.bp && mode === 'bpc') {
      unit = bpcRun(o);
      if (unit == null) { bpcMissing = true; unit = 0; }
      keep = 1;   // 合同出售不扣销售税
    } else if (o.bp) unit = sp.use(o.bp[0], side, side === 'buy') * o.bp[1];
    else unit = sp.use(o.type, side, side === 'buy');
    const revenue = unit * o.qty * keep, profit = revenue - cost;
    return { revenue, profit, iskLp: o.lp ? profit / o.lp : null, missing: pc.missing || sp.missing || bpcMissing, approx: pc.approx || sp.approx, noBuy: sp.noBuy };
  };
  const main = sale(F.price);
  return { ...main, reqCost, matCost, jobCost, mk, cost, mode: o.bp ? mode : null,
    sell: F.price === 'sell' ? main : sale('sell'), buy: F.price === 'buy' ? main : sale('buy') };
}

function offerTypes(o) {
  const ids = [o.bp ? o.bp[0] : o.type, ...o.req.map(([m]) => m)];
  if (o.bp) o.bp[2].forEach(([m]) => ids.push(m));
  return ids;
}

// 读取吉他行情（逐个物品），完成后重绘
function loadJita(ids, done) {
  const need = [...new Set(ids)].filter((id) => !jita.has(id));
  if (!need.length) return Promise.resolve();
  const run = (async () => {
    const map = await ctx.getHubPrices(need, (n, total) => {
      S.progress = `读取${HUB_NAME}行情 ${n}/${total}`;
      const el = document.querySelector('[data-lp-progress]');
      if (el) el.textContent = S.progress;
    }).catch(() => new Map());
    for (const id of need) jita.set(id, map.get(id) || {});
  })();
  S.loadingJita = run;
  return run.finally(() => {
    if (S.loadingJita === run) { S.loadingJita = null; S.progress = ''; }
    done?.();
  });
}

// 日均成交 / 日均成交额：优先用交易中心快照（与制造页利润排行共用，全部兑换品都有，可排序）；
// 快照读不到时退回逐个查 ESI 市场历史（只填表格前 25 行，不能排序）。成交额 = 30 天日均成交量 × 30 天成交均价
const pidOf = (o) => (o.bp ? o.bp[0] : o.type);
function volOf(o) {
  if (!S.mkt) return null;
  const m = S.mkt.get(pidOf(o));
  return m ? { daily: m.daily, isk: m.daily * (m.avg || 0) } : { daily: 0, isk: 0 };
}
function loadMkt() {
  if (S.mkt !== undefined || S.mktLoading || !IND?.lpMarket) return;
  S.mktLoading = IND.lpMarket().then((m) => { S.mkt = m || null; }).catch(() => { S.mkt = null; })
    .finally(() => { S.mktLoading = null; if ($('lpMain')?.dataset.ready && $('lpBody')) refreshBody(); });
}
const volCells = (o, i) => {
  const v = volOf(o), n = ctx.formatNumber;
  if (v) return `<td class="num lp-hide-sm">${v.daily ? n(v.daily >= 10 ? Math.round(v.daily) : Math.round(v.daily * 10) / 10) : '—'}</td><td class="num lp-hide-sm">${v.isk ? ctx.formatISK(v.isk) : '—'}</td>`;
  const pid = pidOf(o), wait = i < 25 ? '…' : '';
  return `<td class="num lp-hide-sm" data-lp-vol="${pid}">${wait}</td><td class="num lp-hide-sm" data-lp-turn="${pid}">${wait}</td>`;
};

async function dailyVolume(id) {
  if (D.history.has(id)) return D.history.get(id);
  const p = ctx.fetchESI(`/markets/${FORGE}/history/?type_id=${id}`).then((h) => {
    const last = (Array.isArray(h) ? h : []).slice(-30);
    return last.length ? { daily: last.reduce((t, x) => t + x.volume, 0) / last.length, isk: last.reduce((t, x) => t + x.volume * x.average, 0) / last.length } : { daily: 0, isk: 0 };
  }).catch(() => null);
  D.history.set(id, p);
  return p;
}

// 表格前若干行异步填入吉他 30 天日均成交量
function fillVolumes(body, rows) {
  if (S.mkt || S.mktLoading || (S.mkt === undefined && indLoading)) return;   // 快照里已有（或正在读，读完会重绘）
  const ids = [...new Set(rows.slice(0, 25).map((r) => (r.o.bp ? r.o.bp[0] : r.o.type)))];
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const v = await dailyVolume(id);
      body.querySelectorAll(`[data-lp-vol="${id}"]`).forEach((c) => { c.textContent = v?.daily ? ctx.formatNumber(Math.round(v.daily)) : '—'; });
      body.querySelectorAll(`[data-lp-turn="${id}"]`).forEach((c) => { c.textContent = v?.isk ? ctx.formatISK(v.isk) : '—'; });
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------- 入口 ----------
// 预加载（modern-app.js：悬停导航按钮或常用页面空闲时调用），只取数据不渲染，打开页面时直接用
export async function preload() {
  await loadData();
  if (F.tab === 'trade') { await loadTrade(); return; }
  // 默认的「LP 商店」标签页：顺便取当前军团商店里物品的交易中心行情（页面已打开时取完刷新）
  if (F.tab === 'store' && needsJita() && !S.loadingJita) await loadJita((D.data.stores[F.corp] || []).map(offer).flatMap(offerTypes), () => { if (F.tab === 'store' && $('lpBody')) refreshBody(); });
}

export async function showLp(hash = location.hash) {
  const main = $('lpMain');
  if (!D.data) main.innerHTML = skPage({ tabs: TABS.length, rows: 10 });
  await loadData();
  if (IND) IND.lpEnv().then(() => { if ($('lpSettings')) { renderSettings(); refreshBody(); } }).catch(() => {});   // 制造页的技能设置可能改过
  else loadInd();     // 制造页设置：蓝图制造的材料加成、安装费、所需技能，按技能的税费
  loadBpAll();   // 蓝图兑换品的合同价（详情里两种算法对比、「直接卖蓝图」模式用）
  const m = /^#lp(?:\/(store|rank|mine|trade))?(?:\/(\d+))?/.exec(hash || '');
  if (m?.[1] && (m[1] !== 'trade' || TRADE_URL)) F.tab = m[1];
  if (m?.[1] === 'store' && m[2] && D.corpById.has(Number(m[2]))) F.corp = Number(m[2]);
  if (F.tab === 'trade' && m?.[1] === 'trade' && m[2]) F.token = Number(m[2]);   // 数据读到后不是代币的换成默认（curToken）
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="ind-page lp-page">
        <div class="pi-head ind-head"><h2>LP 商店</h2></div>
        <div class="segmented ind-tabs ind-tabs-mobile" role="tablist">
          ${TABS.map(([k, l]) => `<button data-lp-tab="${k}">${l}</button>`).join('')}
        </div>
        <details class="pi-card ind-settings" id="lpSettings"></details>
        <div id="lpBody"></div>
      </section>`;
    main.addEventListener('click', onClick);
    main.addEventListener('change', onChange);
    main.addEventListener('input', onInput);
    const side = $('lpSide');
    side.addEventListener('click', onSideClick);
    // 图标最终没读到（涂装许可证等图片服务器上没有图标；/icon 失败换 /bp 重试的那次不会传到这里）：隐藏破图
    const hideBroken = (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); };
    main.addEventListener('error', hideBroken, true);
    side.addEventListener('error', hideBroken, true);
    let t = 0;
    $('lpSideSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.sideQ = e.target.value.trim(); renderSide(); }, 150); });
    renderSettings();
    renderTab();
    return;
  }
  // 切回本页：状态没变就保留当前页面（滚动位置、展开的行、输入框）
  if (S.rendered !== stateKey()) renderTab();
  else { setHash(); if (F.tab === 'mine' && !S.mine && !S.mineLoading && ctx.hasEsiToken()) renderTab(); }
}

const stateKey = () => F.tab + ':' + (F.tab === 'store' ? F.corp : F.tab === 'trade' ? F.token : '');

function setHash() {
  if ($('lpView').hidden) return;   // 后台读完行情重绘时不改其他页面的地址
  const h = F.tab === 'store' ? `#lp/store/${F.corp}` : F.tab === 'trade' && F.token ? `#lp/trade/${F.token}` : `#lp/${F.tab}`;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + h);
}

function renderTab() {
  document.querySelectorAll('[data-lp-tab]').forEach((b) => b.classList.toggle('active', b.dataset.lpTab === F.tab));
  if (F.tab === 'trade' && TD.data) curToken();
  setHash();
  S.rendered = stateKey();
  renderSide();
  const body = $('lpBody');
  if (F.tab === 'store') renderStore(body);
  else if (F.tab === 'rank') renderRank(body);
  else if (F.tab === 'trade') renderTrade(body);
  else renderMine(body);
}

const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-lp-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const PRICE_ZH = { sell: HUB_NAME + '卖单', buy: HUB_NAME + '收单', avg: '全服均价' };
const BP_ZH = { make: '制造后卖产物', bpc: '直接卖蓝图（合同价）' };

// ---------- 设置 ----------
function renderSettings() {
  const el = $('lpSettings');
  el.innerHTML = `
    <summary><b>估价设置</b><span class="text-muted">产物按${PRICE_ZH[F.price]} · 材料按${PRICE_ZH[F.mat]} · 税费 ${pct(sellTaxPct())}%${skillTax() ? '（按技能）' : ''} · 蓝图${BP_ZH[F.bp]}</span></summary>
    <div class="ind-set-grid">
      <div class="pi-field"><label>产物卖出价</label>${seg('price', [['sell', PRICE_ZH.sell], ['buy', PRICE_ZH.buy], ['avg', PRICE_ZH.avg]], F.price)}
        </div>
      <div class="pi-field"><label>所需物品 / 蓝图材料买入价</label>${seg('mat', [['sell', PRICE_ZH.sell], ['buy', PRICE_ZH.buy], ['avg', PRICE_ZH.avg]], F.mat)}</div>
      <div class="pi-field"><label>卖出税费</label>${seg('taxMode', [['skill', '按技能'], ['manual', '手动']], F.taxMode === 'manual' ? 'manual' : 'skill')}
        ${F.taxMode === 'manual' ? `<div class="pi-inline"><input type="number" class="pi-input lp-tax" data-lp-tax min="0" max="30" step="0.1" value="${F.tax}"><span>%</span></div>`
          : IND ? (() => { const t = IND.lpSettings(); return `<small class="pi-hint">销售税 ${pct(t.salesTax)}%${F.price === 'buy' ? '' : ` + 中介费 ${pct(t.brokerFee)}%（挂卖单）`}${F.mat === 'buy' ? ` · 挂收单买材料加中介费 ${pct(t.brokerFee)}%` : ''} · ${t.skills === 'esi' ? '按角色技能' : t.skills === 'esi-missing' ? '未绑定角色，按全 5 级' : '技能全 5 级'}（<a href="#ind" class="kb-link">制造页设置</a>）</small>`; })()
          : '<small class="pi-hint">读取技能设置…</small>'}</div>
      <div class="pi-field"><label>蓝图制造</label>${IND ? (() => { const t = IND.lpSettings(); return `<span class="lp-make-set">${ctx.esc(t.sys)} · 制造指数 ${(t.idx * 100).toFixed(2)}% · ${ctx.esc(t.facName)} · 设施税 ${pct(t.facTax)}% + SCC 4%</span><small class="pi-hint">材料加成与安装费按<a href="#ind" class="kb-link">制造页的设置</a>，蓝图拷贝材料效率 0</small>`; })() : '<small class="pi-hint">读取制造设置…</small>'}</div>
      <div class="pi-field"><label>蓝图兑换品</label>${SERVER.kb ? seg('bp', [['make', BP_ZH.make], ['bpc', BP_ZH.bpc]], F.bp)
        : `<span class="text-muted">${ctx.esc(SERVER.full)}没有公开合同数据，蓝图按${BP_ZH.make}计算</span>`}</div>
    </div>`;
}

function needsJita() { return F.price !== 'avg' || F.mat !== 'avg'; }

function priceNote(rows) {
  if (!needsJita()) return '全服均价估算';
  if (S.loadingJita) return `<span data-lp-progress>${S.progress || `读取${HUB_NAME}行情…`}</span>${S.mkt ? '（暂用行情快照）' : '（暂用全服均价）'}`;
  const approx = rows.some((r) => r.v.approx || r.v.sell.approx || r.v.buy.approx);
  return HUB_NAME + '实时行情' + (approx ? '（≈ 为全服均价）' : '');
}

// ---------- 兑换项表格 ----------
function offerRow(r, i, { showCorp = false } = {}) {
  const { o, v } = r;
  const esc = ctx.esc, isk = ctx.formatISK;
  const open = S.open.has(o.id);
  const corps = D.corpsByOffer.get(o.id) || [];
  return `
    <tr data-lp-open="${o.id}" class="${open ? 'active' : ''}" title="点击展开明细">
      <td class="pi-rank lp-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${o.bp ? BPC_ICON(o.type) : ICON(o.type)}"${o.bp ? '' : ` data-item-pop="${o.type}"`} alt="" width="28" height="28" loading="lazy"><span>${esc(tName(o.type))}${o.qty > 1 ? `<small>×${ctx.formatNumber(o.qty)}</small>` : ''}${o.bp ? `<small class="ind-tag-bpc" title="${v.mode === 'bpc' ? '蓝图拷贝：按公开合同最低每流程价 × 流程数估算' : '蓝图拷贝：按产物价（扣税）− 材料价，乘流程数估算，材料效率 0'}">蓝图</small>` : ''}</span></div>
        ${showCorp ? `<div class="lp-corps">${esc(corpName(corps[0]))}${corps.length > 1 ? ` 等 ${corps.length} 家` : ''}</div>` : ''}</td>
      <td class="num">${ctx.formatNumber(o.lp)}</td>
      <td class="num lp-hide-md">${o.isk ? isk(o.isk) : '—'}</td>
      <td class="num lp-hide-md">${o.req.length || v.matCost ? isk(v.reqCost + v.matCost) : '—'}</td>
      <td class="num pi-hide-sm">${v.missing ? '—' : isk(v.revenue)}</td>
      <td class="num lp-hide-sm">${v.missing ? '—' : isk(v.profit)}</td>
      ${ratioCell(v.sell)}${ratioCell(v.buy)}
      ${volCells(o, i)}
    </tr>${open ? `<tr class="lp-detail-row"><td colspan="${COLS}">${offerDetail(o, v)}</td></tr>` : ''}`;
}
// 挂单比例 / 收单比例一格；没有收单的写明（卖给收单卖不掉）
function ratioCell(x) {
  if (x.missing || x.iskLp == null) return `<td class="num text-muted"${x.noBuy ? ' title="没有收单"' : ''}>—</td>`;
  return `<td class="num ${x.iskLp >= 0 ? 'pi-profit' : 'down'}">${x.approx ? '≈' : ''}${ctx.formatNumber(Math.round(x.iskLp))}</td>`;
}

// ---------- 复制采购清单（游戏「市场 → 批量购买」可直接粘贴）----------
// 每行「物品名<Tab>数量」；兑换次数默认 1。蓝图兑换项另可复制制造材料（材料效率 0，按兑换得到的全部流程）。
// 物品名是简体中文官方名，需游戏客户端也是简体中文才能识别。
const timesOf = (o) => S.times.get(o.id) || 1;
function buyItems(o, kind) {
  const n = timesOf(o);
  const sum = new Map();
  const add = (id, q) => sum.set(id, (sum.get(id) || 0) + q);
  if (kind !== 'mats') for (const [m, q] of o.req) add(m, q * n);
  const mk = kind !== 'req' && makeOf(o);
  if (mk) for (const [m, q] of mk.items) add(m, q * n);
  else if (kind !== 'req' && o.bp) for (const [m, q] of o.bp[2]) add(m, q * o.qty * n);
  return [...sum].map(([id, qty]) => ({ id, qty, name: tName(id) }));
}
const buyLines = (o, kind) => buyItems(o, kind).map((x) => `${x.name}\t${x.qty}`);
// 已读取「我的 LP」时：在可兑换这一项的军团里，按 LP 最多能换几次（ISK 与物品另算）
function myMax(o) {
  if (!S.mine || !o.lp) return 0;
  const corps = new Set(D.corpsByOffer.get(o.id) || []);
  const lp = Math.max(0, ...S.mine.filter((x) => corps.has(x.corporation_id)).map((x) => x.loyalty_points));
  return Math.floor(lp / o.lp);
}
function setTimes(id, n, box) {
  const o = offer(id);
  S.times.set(o.id, Math.min(10000, Math.max(1, Math.round(n) || 1)));
  const el = box?.closest('.lp-buy');
  if (el) el.outerHTML = buyListHtml(o);
}
function buyListHtml(o) {
  const n = timesOf(o);
  const mats = o.bp ? o.bp[2].length : 0;
  const tip = '复制后在游戏「市场 → 批量购买」里粘贴';
  const btn = (kind, label, count) => `<button type="button" class="lp-act" data-lp-copy="${kind}:${o.id}" title="${tip}"${count ? '' : ' disabled'}><span>${label}</span><small>${count} 项</small></button>`;
  // 制造材料只在按「制造后卖产物」算时才需要
  const make = o.bp && F.bp !== 'bpc';
  const cartKind = make && o.req.length ? 'all' : o.req.length ? 'req' : 'mats';
  return `<div class="lp-sec lp-buy"><h4>采购</h4>
    <div class="lp-times-row"><label class="lp-times"><span>兑换次数</span><input type="number" class="pi-input" min="1" max="10000" step="1" value="${n}" data-lp-times="${o.id}" aria-label="兑换次数"></label>
      ${myMax(o) ? `<button type="button" class="link-btn" data-lp-max="${o.id}">按我的 LP 最多 ${ctx.formatNumber(myMax(o))} 次</button>` : ''}</div>
    <ul class="lp-lines lp-need"><li><span>共需 LP</span><b>${ctx.formatNumber(o.lp * n)}</b></li><li><span>ISK</span><b>${ctx.formatISK(o.isk * n)}</b></li>${o.ak ? `<li><span>AK</span><b>${ctx.formatNumber(o.ak * n)}</b></li>` : ''}</ul>
    <div class="lp-acts">
      ${o.req.length || make ? `<button type="button" class="lp-act primary" data-lp-cart="${cartKind}:${o.id}"><span>加入购物车</span><small>${buyItems(o, cartKind).length} 项</small></button>` : ''}
      ${o.req.length ? btn('req', '复制兑换所需物品', o.req.length) : ''}
      ${make ? btn('mats', '复制制造材料', mats) : ''}
      ${make && o.req.length ? btn('all', '复制全部（合并同类）', buyLines(o, 'all').length) : ''}
    </div></div>`;
}

// 明细表：一行物品 · 数量 · 价值（side 为空时不估价；nameHtml 可替换名称，如链到其他代币）；合计行；分组标题
function dRow(id, q, side, strict = false, nameHtml = null) {
  const p = side ? price(id, side, strict) : null;
  return `<tr><td><span class="lp-item"><img src="${ICON(id)}" data-item-pop="${id}" alt="" width="24" height="24" loading="lazy"><span>${nameHtml ?? ctx.esc(tName(id))}</span></span></td><td class="num">${ctx.formatNumber(q)}</td>
      <td class="num">${!p ? '' : p.v == null ? (p.src === 'none' ? '没有收单' : '无价格') : (side !== 'avg' && p.src === 'avg' ? '≈' : '') + ctx.formatISK(p.v * q)}</td></tr>`;
}
const dSum = (label, value, cls = '') => `<tr class="lp-sum${cls}"><td colspan="2">${label}</td><td class="num">${value}</td></tr>`;
const dHead = (label, extra = '') => `<tr class="lp-group"><td colspan="3">${label}${extra ? `<span class="lp-pill">${extra}</span>` : ''}</td></tr>`;

function offerDetail(o, v) {
  const esc = ctx.esc, isk = ctx.formatISK, num = ctx.formatNumber;
  const row = dRow, sum = dSum, head = dHead;
  const corps = D.corpsByOffer.get(o.id) || [];
  const pid = o.bp ? o.bp[0] : o.type;
  const good = (x) => (x.missing || x.iskLp == null ? '' : x.iskLp >= 0 ? ' up' : ' down');
  const tile = (label, value, sub = '', cls = '') => `<div class="lp-tile${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const tiles = `<div class="lp-tiles">
    ${tile('利润', v.missing ? '—' : isk(v.profit), `每次兑换${v.approx ? ' · ≈ 含全服均价' : ''}`, good(v))}
    ${tile('ISK/LP', v.missing || v.iskLp == null ? '—' : num(Math.round(v.iskLp)), `${num(o.lp)} LP`, good(v))}
    ${tile(o.bp && v.mode === 'bpc' ? '蓝图价值' : '产物价值', v.missing ? '—' : isk(v.revenue), o.bp && v.mode === 'bpc' ? '合同出售不扣税' : `已扣税费 ${pct(sellTaxPct())}%`)}
    ${tile('花费', isk(v.cost), `ISK ${isk(o.isk)}${o.req.length ? ' + 物品 ' + isk(v.reqCost) : ''}${v.matCost ? ' + 材料 ' + isk(v.matCost) : ''}${v.jobCost ? ' + 安装费 ' + isk(v.jobCost) : ''}`)}
  </div>`;
  // 蓝图：两种算法，点一下切换（与估价设置同步）
  let modes = '';
  if (o.bp) {
    const opt = (mode, title) => {
      const x = valueOf(o, mode);
      const off = mode === 'bpc' && !SERVER.kb;
      return `<button type="button" class="lp-mode${v.mode === mode ? ' active' : ''}" data-lp-set="bp" data-v="${mode}"${off ? ` disabled title="${esc(SERVER.full)}没有合同数据"` : ''}>
        <span class="lp-mode-title">${title}</span>
        <b class="lp-mode-val${good(x)}">${off ? '—' : mode === 'bpc' && !D.bpAll ? '读取合同价…' : x.missing ? (mode === 'bpc' ? '合同里没有在售' : x.noBuy ? '没有收单' : '缺少价格') : `${num(Math.round(x.iskLp))} <small>ISK/LP</small>`}</b></button>`;
    };
    modes = `<div class="lp-modes">${opt('make', '制造后卖产物')}${opt('bpc', '直接卖蓝图')}</div>`;
  }
  // 左：产出明细
  let rows = '';
  if (o.bp && v.mode !== 'bpc') {
    const [, pq, mats] = o.bp;
    const n = o.qty;
    const mk = v.mk;
    rows = head('产出', `${num(n)} 流程 · 材料效率 0`) + row(pid, pq * n, F.price, prodStrict()) + sum(`扣除税费 ${pct(sellTaxPct())}% 后`, v.missing ? '—' : isk(v.revenue))
      + head('制造材料', mk ? '含设施加成' : '') + (mk ? mk.items : mats.map(([m, q]) => [m, q * n])).map(([m, q]) => row(m, q, F.mat)).join('') + sum(`材料合计${buyFeePct() ? `（含中介费 ${pct(buyFeePct())}%）` : ''}`, isk(v.matCost));
    if (mk) {
      const t = IND.lpSettings();
      rows += head('制造安装费', `${esc(t.sys)} · 指数 ${(mk.idx * 100).toFixed(2)}%`)
        + `<tr><td>星系成本（预估价值 ${isk(mk.eiv)} × 指数${t.facName !== 'NPC 空间站' ? ' − 设施减免' : ''}）</td><td></td><td class="num">${isk(mk.gross)}</td></tr>`
        + `<tr><td>设施税 ${pct(t.facTax)}% + SCC 附加费 4%</td><td></td><td class="num">${isk(mk.taxes)}</td></tr>` + sum('安装费合计', isk(mk.jobCost));
      if (mk.skills.length) rows += head('制造所需技能', mk.skillsBy === 'esi' ? '按角色技能' : '按全 5 级') + mk.skills.map((k) => `<tr class="${k.have != null && k.have < k.need ? 'lp-skill-no' : ''}"><td>${esc(k.name)}</td><td class="num">${ROMAN[k.need]}</td><td class="num">${k.have >= k.need ? '<span class="up">✓</span>' : `<span class="down">${k.have ? '当前 ' + ROMAN[k.have] : '未学'}</span>`}</td></tr>`).join('');
    }
  } else if (o.bp) {
    const run = bpcRun(o);
    rows = head('直接卖蓝图', run != null ? `每流程 ${isk(run)}` : '') + `<tr><td><span class="lp-item"><img src="${BPC_ICON(o.type)}" alt="" width="24" height="24" loading="lazy"><span>${esc(tName(o.type))}</span></span></td><td class="num">${num(o.qty)} 流程</td><td class="num">${run == null ? '合同里没有在售' : isk(run * o.qty)}</td></tr>`;
  } else {
    rows = head('产出') + row(o.type, o.qty, F.price, prodStrict()) + sum(`扣除税费 ${pct(sellTaxPct())}% 后`, v.missing ? '—' : isk(v.revenue));
  }
  if (o.req.length) rows += head('兑换所需物品') + o.req.map(([m, q]) => row(m, q, F.mat)).join('') + sum(`物品合计${buyFeePct() ? `（含中介费 ${pct(buyFeePct())}%）` : ''}`, isk(v.reqCost));
  const main = `<div class="lp-sec lp-main"><table class="lp-dtable"><thead><tr><th>物品</th><th class="num">数量</th><th class="num">价值</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  // 右：采购 · 军团 · 市场
  const side = `<div class="lp-side">
    ${buyListHtml(o)}
    <div class="lp-sec"><h4>可兑换的军团 <span class="lp-pill">${corps.length}</span></h4><div class="lp-corp-list">${corps.map((c) => `<button type="button" class="chip" data-lp-corp="${c}">${esc(corpName(c))}</button>`).join('')}</div></div>
    <button type="button" class="lp-act lp-market-btn" data-lp-market="${pid}" title="${esc(tName(pid))}"><span>在市场中心查看${o.bp ? '产物' : ''}</span><span aria-hidden="true">→</span></button>
  </div>`;
  return `<div class="lp-detail2">${tiles}${modes}<div class="lp-body">${main}${side}</div></div>`;
}

const COLS = 11;
const tableHead = () => `<thead><tr><th class="lp-hide-sm">#</th>${sortTh('name', '兑换品')}${sortTh('lp', 'LP', 'num')}${sortTh('iskCost', 'ISK 费用', 'num lp-hide-md')}${sortTh('req', '物品 / 材料', 'num lp-hide-md')}${sortTh('revenue', '产物价值', 'num pi-hide-sm')}${sortTh('profit', '利润', 'num lp-hide-sm')}${sortTh('iskSell', '<span title="每 LP 换多少 ISK：产物挂卖单卖出">挂单比例</span>', 'num')}${sortTh('iskBuy', '<span title="每 LP 换多少 ISK：产物直接卖给收单">收单比例</span>', 'num')}${S.mkt ? sortTh('daily', `<span title="${HUB_NAME} 30 天日均成交量">日均成交</span>`, 'num lp-hide-sm') + sortTh('turnover', `<span title="${HUB_NAME} 30 天日均成交量 × 30 天成交均价">日均成交额</span>`, 'num lp-hide-sm') : '<th class="num lp-hide-sm">日均成交</th><th class="num lp-hide-sm">日均成交额</th>'}</tr></thead>`;

function sortRows(rows, trade = false) {
  const [sort, dir, keys, def] = trade ? [F.tSort, F.tDir, T_SORT_KEY, 'per'] : [F.sort, F.dir, SORT_KEY, 'iskSell'];
  const mul = dir === 'asc' ? 1 : -1;
  if (sort === 'name') return rows.sort((a, b) => mul * tName(a.o.type).localeCompare(tName(b.o.type), 'zh'));
  const key = (S.mkt || !['daily', 'turnover'].includes(sort) ? keys[sort] : null) || keys[def];
  // 没有价格的始终排在最后
  return rows.sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return mul * (x - y);
  });
}

function matchQ(o, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return tName(o.type).toLowerCase().includes(s) || (o.bp && tName(o.bp[0]).toLowerCase().includes(s)) || String(o.type) === q;
}

function filterBar(qKey, extra = '', n = null) {
  return `<div class="ind-rank-row">
      <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-lp-q="${qKey}" placeholder="筛选兑换品" value="${ctx.esc(S[qKey])}" spellcheck="false" aria-label="筛选兑换品"></div>
      <div class="pi-inline"><span>类型</span>${seg('kind', [['all', '全部'], ['item', '物品'], ['bp', '蓝图']], F.kind)}</div>
      ${extra}
    </div>${rangeBar(n)}`;
}

// ---------- 比例区间 ----------
// F.rng = { sell: [最低, 最高], buy: [...] }，存输入框原文（打到一半的「-」不会被清掉），用的时候再解析；空 = 不限
const RNG_ZH = { sell: '挂单比例', buy: '收单比例' };
const rngNum = (t) => { const x = String(t).replace(/[,，\s]/g, ''); return x && Number.isFinite(Number(x)) ? Number(x) : null; };
function rngOf(side) {
  const [a, b] = F.rng[side].map(rngNum);
  return a != null && b != null && a > b ? [b, a] : [a, b];
}
const rngOn = (side) => rngOf(side).some((x) => x != null);
// 按表格显示的整数比较（显示 1,500 的算进 1500 起的区间）
function inRng(side, v) {
  const [a, b] = rngOf(side), x = ratioOf(v, side);
  if (x == null) return false;
  const r = Math.round(x);
  return (a == null || r >= a) && (b == null || r <= b);
}
// 按区间筛选（list 已按类型 / 搜索 / 势力筛过）；n 记下各区间内的项数：sell / buy 各自满足的、both 两个都满足的（= 表格行数）
function ranged(list) {
  const on = { sell: rngOn('sell'), buy: rngOn('buy') };
  const n = { sell: 0, buy: 0, both: 0, on };
  const rows = list.filter((r) => {
    const s = !on.sell || inRng('sell', r.v), b = !on.buy || inRng('buy', r.v);
    if (on.sell && s) n.sell++;
    if (on.buy && b) n.buy++;
    return s && b;
  });
  n.both = rows.length;
  return Object.assign(rows, { n });
}
function rangeBar(n) {
  if (!n) return '';
  const box = (side) => {
    const [a, b] = F.rng[side];
    const inp = (i, v, ph) => `<input type="text" inputmode="decimal" class="pi-input lp-rng-in" data-lp-rng="${side}:${i}" value="${ctx.esc(v)}" placeholder="${ph}" aria-label="${RNG_ZH[side]}${ph}" spellcheck="false" autocomplete="off">`;
    return `<div class="pi-inline lp-rng"><span title="${side === 'sell' ? '每 LP 换多少 ISK：产物挂卖单卖出' : '每 LP 换多少 ISK：产物直接卖给收单'}">${RNG_ZH[side]}</span>${inp(0, a, '下限')}<span class="lp-rng-dash">–</span>${inp(1, b, '上限')}${n.on[side] ? `<b class="lp-rng-n">${n[side]} 项</b>` : ''}</div>`;
  };
  return `<div class="ind-rank-row lp-rngs">${box('sell')}${box('buy')}
      ${n.on.sell && n.on.buy ? `<span class="lp-rng-both">同时满足 ${n.both} 项</span>` : ''}
      ${n.on.sell || n.on.buy ? '<button type="button" class="link-btn" data-lp-rng-clear>清除</button>' : ''}
    </div>`;
}

const kindOk = (o) => F.kind === 'all' || (F.kind === 'bp' ? !!o.bp : !o.bp);

// ---------- LP 商店 ----------
function storeRows() {
  const ids = D.data.stores[F.corp] || [];
  return sortRows(ranged(ids.map(offer).filter((o) => kindOk(o) && matchQ(o, S.q)).map((o) => ({ o, v: valueOf(o) }))));
}

function renderStore(body) {
  const corp = D.corpById.get(F.corp);
  const all = (D.data.stores[F.corp] || []).map(offer);
  if (needsJita() && !S.loadingJita) {
    const ids = all.flatMap(offerTypes);
    if (ids.some((id) => !jita.has(id))) loadJita(ids, () => { if (F.tab === 'store') refreshBody(); });
  }
  const mine = S.mine?.find((x) => x.corporation_id === F.corp);
  const rows = storeRows();
  body.innerHTML = `
    <div class="pi-card lp-store-head">
      <img src="${LOGO(F.corp, 64)}" alt="" width="48" height="48">
      <div><h3>${ctx.esc(corp?.name || '')}</h3>
        <p class="text-muted">${ctx.esc(D.data.factions[corp?.faction] || '')} · ${all.length} 个兑换项${mine ? ` · 你有 <b>${ctx.formatNumber(mine.loyalty_points)}</b> LP` : ''}</p></div>
    </div>
    <div class="pi-card ind-rank-filters">
      ${filterBar('q', '', rows.n)}
      <p class="pi-note">${priceNote(rows)}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">${tableHead()}
      <tbody>${rows.map((r, i) => offerRow(r, i)).join('') || `<tr><td colspan="${COLS}" class="text-muted">没有符合条件的兑换项</td></tr>`}</tbody></table></div></div>`;
  fillVolumes(body, rows);
}

// ---------- 全服排行 ----------
function rankRows() {
  const fac = F.faction === 'all' ? null : Number(F.faction);
  const list = [];
  for (const id of Object.keys(D.data.offers)) {
    const o = offer(id);
    if (!o.lp || !kindOk(o) || !matchQ(o, S.rankQ)) continue;
    if (fac && !(D.corpsByOffer.get(o.id) || []).some((c) => D.corpById.get(c)?.faction === fac)) continue;
    list.push({ o, v: valueOf(o) });
  }
  return sortRows(ranged(list));
}

function renderRank(body) {
  const rows = rankRows();
  const top = rows.slice(0, RANK_LIMIT);
  const facOpts = [['all', '全部势力'], ...Object.entries(D.data.factions)];
  const sel = `<div class="pi-inline"><span>势力</span><select class="pi-input lp-faction" data-lp-faction>${facOpts.map(([v, l]) => `<option value="${v}"${String(F.faction) === String(v) ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('')}</select></div>`;
  const refineIds = top.slice(0, REFINE_TOP).flatMap((r) => offerTypes(r.o));
  const refined = !needsJita() || refineIds.every((id) => jita.has(id));
  const someLive = top.slice(0, REFINE_TOP).some((r) => jita.has(pidOf(r.o)));   // 精算过（排名变了还有没精算的）
  body.innerHTML = `
    <div class="pi-card ind-rank-filters">
      ${filterBar('rankQ', sel, rows.n)}
      <p class="pi-note">${needsJita() && !refined && !S.loadingJita && !someLive ? (S.mkt ? `${HUB_NAME}行情快照` : '全服均价估算') : priceNote(top.slice(0, REFINE_TOP))}
        ${needsJita() && !refined ? `<button class="btn btn-ghost ind-refine" data-lp-refine ${S.loadingJita ? 'disabled' : ''}>${S.loadingJita ? '精算中…' : `用${HUB_NAME}行情精算前 ${REFINE_TOP} 名`}</button>` : ''}
        · 共 ${rows.length} 项${rows.length > RANK_LIMIT ? `，显示前 ${RANK_LIMIT}` : ''}
        ${rows.length ? exportBtnHtml('data-lp-export') : ''}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">${tableHead()}
      <tbody>${top.map((r, i) => offerRow(r, i, { showCorp: true })).join('') || `<tr><td colspan="${COLS}" class="text-muted">没有符合条件的兑换项</td></tr>`}</tbody></table></div></div>`;
  fillVolumes(body, top);
}

// 用交易中心实时行情精算前 REFINE_TOP 名：精算后排名会变（比如卖给收单时没有收单的掉下去），新进前列的再精算，最多 5 轮
async function refineRank() {
  if (S.loadingJita) return;
  for (let round = 0; round < 5; round++) {
    const ids = rankRows().slice(0, REFINE_TOP).flatMap((r) => offerTypes(r.o)).filter((id) => !jita.has(id));
    if (!ids.length) break;
    const run = loadJita(ids, () => { if (F.tab === 'rank') refreshBody(); });
    if (F.tab === 'rank') refreshBody();
    await run;
  }
}

// 导出 CSV：当前筛选与排序下的全部兑换项（不只显示的前 RANK_LIMIT 名）；ISK 为原始数值，无价格的留空
function exportRank() {
  const src = (v) => (v.missing ? (v.noBuy ? '没有收单' : '无价格') : needsJita() && !v.approx ? HUB_NAME + '行情' : '全服均价');
  const val = (v, k) => (v.missing ? null : v[k]);
  const corps = (o) => D.corpsByOffer.get(o.id) || [];
  const n = exportCsv('LP 全服排行', [
    ['#', (r) => r.i + 1],
    ['兑换品', (r) => tName(r.o.type)],
    ['Type ID', (r) => r.o.type],
    ['数量', (r) => r.o.qty],
    ['蓝图', (r) => (r.o.bp ? '是' : '否')],
    ['军团', (r) => corpName(corps(r.o)[0])],
    ['可兑换军团数', (r) => corps(r.o).length],
    ['LP', (r) => r.o.lp],
    ['ISK 费用', (r) => r.o.isk],
    ['所需物品', (r) => r.v.reqCost],
    ['制造材料', (r) => r.v.matCost],
    ['制造安装费', (r) => r.v.jobCost],
    ['产物价值', (r) => val(r.v, 'revenue')],
    ['利润', (r) => val(r.v, 'profit')],
    ['ISK/LP', (r) => val(r.v, 'iskLp')],
    ['挂单比例', (r) => ratioOf(r.v, 'sell')],
    ['收单比例', (r) => ratioOf(r.v, 'buy')],
    ['日均成交', (r) => (volOf(r.o) ? Math.round(volOf(r.o).daily * 10) / 10 : null)],
    ['日均成交额', (r) => (volOf(r.o) ? Math.round(volOf(r.o).isk) : null)],
    ['价格来源', (r) => src(r.v)]
  ], rankRows().map((r, i) => ({ ...r, i })));
  ctx.showToast(`已导出 ${n} 行`, 'success', 1800);
}

// ---------- 物品商人 ----------
// 活动代币（血色收割的变异血液样本、帝国战役凭证等）在太空里的物品商人处兑换，ESI 没有这份列表；配方取自客户端（item-trader.json）。
// 表里是客户端的全部配方，哪个商人现在开放哪些由服务器决定（生成时已去掉含未发布物品的旧活动配方）。
// 每个代币价值 =（交付物品价值（扣税）− 其他所需物品 − ISK）÷ 所需代币数；「获得方式」是交付这个代币的配方，按每个代币的成本排。
const TD = { loading: null, data: null, uses: new Map(), gets: new Map(), byId: new Map() };
// 客户端物品商人窗口的分组名（recipeUtil.py）；客户端不认识的分组归入「其他」
const TRADE_GROUP = { SHIP_BLUEPRINTS: '舰船蓝图', MODULES_AMMO: '装备和弹药蓝图', SKINR: 'SKINR组件', SKILLBOOKS: '技能书', DRONES: '无人机', SKINS: '涂装', BOOSTERS: '增效剂', BACKGROUNDS: '背景', MUTAPLASMIDS: '突变质体' };
const tradeGroup = (g) => TRADE_GROUP[g] || '其他';
const T_SORT_DIR = { name: 'asc', tq: 'asc', other: 'asc', revenue: 'desc', per: 'desc', daily: 'desc', turnover: 'desc' };
const T_SORT_KEY = {
  tq: (r) => r.v.tq, other: (r) => r.v.other,
  revenue: (r) => (r.v.missing ? null : r.v.revenue), per: (r) => (r.v.missing ? null : r.v.per),
  daily: (r) => volOf(r.o)?.daily ?? null, turnover: (r) => volOf(r.o)?.isk ?? null
};

function loadTrade() {
  if (!TD.loading && TRADE_URL) {
    TD.loading = fetch(TRADE_URL).then((r) => { if (!r.ok) throw new Error('物品商人数据 ' + r.status); return r.json(); }).then((d) => {
      const add = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
      for (const [id, group, isk, ins, outs] of d.recipes) {
        const r = { id, group, isk, ins, outs };
        TD.byId.set(id, r);
        ins.forEach(([t]) => add(TD.uses, t, r));
        outs.forEach(([t]) => { if (d.tokens[t]) add(TD.gets, t, r); });
      }
      TD.data = d;
    }).catch((error) => { TD.loading = null; throw error; });
  }
  return TD.loading || Promise.resolve();
}
// 当前代币：没选过或数据里没有时用兑换项最多的那个
function curToken() {
  if (!TD.uses.has(F.token)) F.token = [...TD.uses].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 0;
  return F.token;
}
const tradeTypes = (r) => [...r.ins, ...r.outs].map(([id]) => id);
// 名称：是其他代币时链到那个代币
const tokLink = (id, cur) => (id !== cur && TD.uses.has(id) ? `<button type="button" class="lp-tok-link" data-lp-token="${id}" title="查看这个代币能换什么">${ctx.esc(tName(id))}</button>` : ctx.esc(tName(id)));

// 用代币兑换一次：交付物品价值（扣税）、除这个代币以外的花费（其他物品含中介费 + ISK）、每个代币价值
function tradeValue(r, token) {
  const pc = pricer();
  const revenue = r.outs.reduce((t, [id, q]) => t + pc.use(id, F.price, prodStrict()) * q, 0) * (1 - sellTaxPct() / 100);
  const other = r.ins.filter(([id]) => id !== token).reduce((t, [id, q]) => t + pc.use(id, F.mat) * q, 0) * (1 + buyFeePct() / 100) + r.isk;
  const tq = r.ins.find(([id]) => id === token)?.[1] || 0;
  return { revenue, other, tq, per: tq ? (revenue - other) / tq : null, missing: pc.missing, approx: pc.approx, noBuy: pc.noBuy };
}
// 换到这个代币：所需物品（含中介费）+ ISK，摊到每个代币
function tradeCost(r, token) {
  const pc = pricer();
  const cost = r.ins.reduce((t, [id, q]) => t + pc.use(id, F.mat) * q, 0) * (1 + buyFeePct() / 100) + r.isk;
  const oq = r.outs.find(([id]) => id === token)?.[1] || 0;
  return { cost, oq, per: oq ? cost / oq : null, missing: pc.missing, approx: pc.approx };
}

// 说明文字：转义后把 [[sys:星系ID|名称]] 换成星图链接
const descHtml = (s) => ctx.esc(s).replace(/\[\[sys:(\d+)\|([^\]]*)\]\]/g, '<a href="#map=$1" class="kb-link">$2</a>');

const tradeHead = () => `<thead><tr><th class="lp-hide-sm">#</th>${sortTh('name', '兑换品', '', true)}${sortTh('tq', '所需代币', 'num', true)}${sortTh('other', '其他花费', 'num lp-hide-md', true)}${sortTh('revenue', '交付价值', 'num pi-hide-sm', true)}${sortTh('per', '每个代币价值', 'num', true)}${S.mkt ? sortTh('daily', `<span title="${HUB_NAME} 30 天日均成交量">日均成交</span>`, 'num lp-hide-sm', true) + sortTh('turnover', `<span title="${HUB_NAME} 30 天日均成交量 × 30 天成交均价">日均成交额</span>`, 'num lp-hide-sm', true) : '<th class="num lp-hide-sm">日均成交</th><th class="num lp-hide-sm">日均成交额</th>'}</tr></thead>`;

function tradeRow({ r, v, o }, i, token) {
  const esc = ctx.esc, isk = ctx.formatISK, num = ctx.formatNumber;
  const open = S.tOpen.has(r.id);
  const others = r.ins.filter(([id]) => id !== token);
  const extra = [...others.map(([id, q]) => `${esc(tName(id))} ×${num(q)}`), ...(r.isk ? [`ISK ${isk(r.isk)}`] : [])];
  const cls = v.missing || v.per == null ? '' : v.per >= 0 ? 'pi-profit' : 'down';
  return `
    <tr data-lp-topen="${r.id}" class="${open ? 'active' : ''}" title="点击展开明细">
      <td class="pi-rank lp-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ICON(o.type)}" data-item-pop="${o.type}" alt="" width="28" height="28" loading="lazy"><span>${r.outs.map(([id, q]) => esc(tName(id)) + (q > 1 ? `<small>×${num(q)}</small>` : '')).join('、')}<small class="lp-grp">${tradeGroup(r.group)}</small></span></div>
        ${extra.length ? `<div class="lp-corps">另需 ${extra.join('、')}</div>` : ''}</td>
      <td class="num">${num(v.tq)}</td>
      <td class="num lp-hide-md">${extra.length ? isk(v.other) : '—'}</td>
      <td class="num pi-hide-sm">${v.missing ? '—' : isk(v.revenue)}</td>
      <td class="num ${cls}">${v.missing || v.per == null ? (v.noBuy ? '没有收单' : '—') : (v.approx ? '≈' : '') + isk(v.per)}</td>
      ${volCells(o, i)}
    </tr>${open ? `<tr class="lp-detail-row"><td colspan="8">${tradeDetail(r, v, token)}</td></tr>` : ''}`;
}

function tradeDetail(r, v, token) {
  const isk = ctx.formatISK, num = ctx.formatNumber;
  const good = v.missing || v.per == null ? '' : v.per >= 0 ? ' up' : ' down';
  const tile = (label, value, sub = '', cls = '') => `<div class="lp-tile${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const others = r.ins.filter(([id]) => id !== token);
  const tiles = `<div class="lp-tiles">
    ${tile('每个代币价值', v.missing || v.per == null ? '—' : isk(v.per), `${num(v.tq)} × ${ctx.esc(tName(token))}${v.approx ? ' · ≈ 含全服均价' : ''}`, good)}
    ${tile('交付价值', v.missing ? '—' : isk(v.revenue), `已扣税费 ${pct(sellTaxPct())}%`)}
    ${tile('其他花费', others.length || r.isk ? isk(v.other) : '—', others.length && r.isk ? '物品 + ISK' : others.length ? '其他物品' : r.isk ? 'ISK' : '只需代币')}
    ${(() => {
      // 对比：不兑换、直接把代币卖掉（按产物卖出价，扣税费）
      const p = price(token, F.price, prodStrict());
      return p.v == null ? tile('直接卖代币', '—', p.src === 'none' ? '没有收单' : '市场上没有价格')
        : tile('直接卖代币', isk(p.v * (1 - sellTaxPct() / 100)), `每个${p.src === 'avg' && F.price !== 'avg' ? ' · ≈ 含全服均价' : ''} · 已扣税费 ${pct(sellTaxPct())}%`);
    })()}
  </div>`;
  let rows = dHead('物品交付') + r.outs.map(([id, q]) => dRow(id, q, F.price, prodStrict(), tokLink(id, token))).join('') + dSum(`扣除税费 ${pct(sellTaxPct())}% 后`, v.missing ? '—' : isk(v.revenue));
  rows += dHead('需要物品') + dRow(token, v.tq, null) + others.map(([id, q]) => dRow(id, q, F.mat, false, tokLink(id, token))).join('')
    + (r.isk ? `<tr><td>ISK</td><td></td><td class="num">${isk(r.isk)}</td></tr>` : '')
    + (others.length || r.isk ? dSum(`其他花费${others.length && buyFeePct() ? `（物品含中介费 ${pct(buyFeePct())}%）` : ''}`, isk(v.other)) : '');
  const main = `<div class="lp-sec lp-main"><table class="lp-dtable"><thead><tr><th>物品</th><th class="num">数量</th><th class="num">价值</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const tip = '复制后在游戏「市场 → 批量购买」里粘贴';
  const side = `<div class="lp-side">
    <div class="lp-sec lp-buy"><h4>采购</h4><div class="lp-acts">
      <button type="button" class="lp-act primary" data-lp-tcart="${r.id}"><span>所需物品加入购物车</span><small>${r.ins.length} 项</small></button>
      <button type="button" class="lp-act" data-lp-tcopy="${r.id}" title="${tip}"><span>复制所需物品</span><small>${r.ins.length} 项</small></button>
    </div></div>
    <button type="button" class="lp-act lp-market-btn" data-lp-market="${r.outs[0][0]}" title="${ctx.esc(tName(r.outs[0][0]))}"><span>在市场中心查看交付物品</span><span aria-hidden="true">→</span></button>
  </div>`;
  return `<div class="lp-detail2">${tiles}<div class="lp-body">${main}${side}</div></div>`;
}

// 获得方式：交付这个代币的配方（多是战役上交：矿石、情报换凭证），按每个代币成本从低到高
function getsCard(token) {
  const list = (TD.gets.get(token) || []).map((r) => ({ r, v: tradeCost(r, token) }))
    .sort((a, b) => (a.v.missing - b.v.missing) || (a.v.per ?? 0) - (b.v.per ?? 0));
  if (!list.length) return '';
  const esc = ctx.esc, isk = ctx.formatISK, num = ctx.formatNumber;
  return `<div class="pi-card"><div class="pi-card-head"><h3>获得方式</h3><span class="text-muted">在物品商人处用下面的物品换${esc(tName(token))}</span></div>
    <div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">
      <thead><tr><th class="lp-hide-sm">#</th><th>需要物品</th><th class="num">交付数量</th><th class="num">花费</th><th class="num">每个代币成本</th></tr></thead>
      <tbody>${list.map(({ r, v }, i) => `
        <tr><td class="pi-rank lp-hide-sm">${i + 1}</td>
          <td><div class="pi-prod"><img src="${ICON(r.ins[0][0])}" data-item-pop="${r.ins[0][0]}" alt="" width="28" height="28" loading="lazy"><span>${r.ins.map(([id, q]) => tokLink(id, token) + `<small>×${num(q)}</small>`).join('、')}${r.isk ? `<small>ISK ${isk(r.isk)}</small>` : ''}</span></div></td>
          <td class="num">${num(v.oq)}</td>
          <td class="num">${v.missing ? '—' : isk(v.cost)}</td>
          <td class="num">${v.missing || v.per == null ? '—' : (v.approx ? '≈' : '') + isk(v.per)}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderTrade(body) {
  if (!TD.data) {
    body.innerHTML = '<div class="pi-loading">读取物品商人数据…</div>';
    loadTrade().then(() => { if (F.tab === 'trade') refreshBody(); })
      .catch((error) => { if (F.tab === 'trade' && $('lpBody') === body) body.innerHTML = `<div class="pi-card"><p class="text-muted">物品商人数据读取失败：${ctx.esc(error.message)}</p></div>`; });
    return;
  }
  const token = curToken();
  const uses = TD.uses.get(token) || [];
  const gets = TD.gets.get(token) || [];
  if (needsJita() && !S.loadingJita) {
    const ids = [token, ...uses.flatMap(tradeTypes), ...gets.flatMap(tradeTypes)];
    if (ids.some((id) => !jita.has(id))) loadJita(ids, () => { if (F.tab === 'trade') refreshBody(); });
  }
  const groups = [...new Set(uses.map((r) => tradeGroup(r.group)))].sort((a, b) => a.localeCompare(b, 'zh'));
  if (F.tGroup !== 'all' && !groups.includes(F.tGroup)) F.tGroup = 'all';
  const q = S.tQ.toLowerCase();
  const rows = sortRows(uses
    .filter((r) => (F.tGroup === 'all' || tradeGroup(r.group) === F.tGroup) && (!q || tradeTypes(r).some((id) => tName(id).toLowerCase().includes(q))))
    .map((r) => ({ r, v: tradeValue(r, token), o: { type: r.outs[0][0], bp: null } })), true);
  const info = TD.data.tokens[token] || [];
  const desc = window.I18N?.lang === 'en' ? info[2] || info[1] : info[1];
  const isk = ctx.formatISK;
  const quote = (side) => { const p = price(token, side, true); return p.v == null ? '—' : (p.src === 'avg' ? '≈' : '') + isk(p.v); };
  body.innerHTML = `
    <div class="pi-card lp-store-head lp-tok-head">
      <img src="${ICON(token, 64)}" data-item-pop="${token}" alt="" width="48" height="48">
      <div><h3>${ctx.esc(tName(token))}</h3>
        <p class="text-muted lp-tok-meta">${info[0] ? `<span>${ctx.esc(info[0])}</span>` : ''}<span>${uses.length} 个兑换项</span>${gets.length ? `<span>${gets.length} 种获得方式</span>` : ''}<span>${HUB_NAME}卖单 <b>${quote('sell')}</b></span><span>${HUB_NAME}收单 <b>${quote('buy')}</b></span></p>
        ${desc ? `<p class="lp-tok-desc">${descHtml(desc)}</p>` : ''}</div>
    </div>
    <div class="pi-card ind-rank-filters">
      <div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-lp-q="tQ" placeholder="筛选兑换品" value="${ctx.esc(S.tQ)}" spellcheck="false" aria-label="筛选兑换品"></div>
        ${groups.length > 1 ? `<div class="pi-inline lp-tgroups"><span>分组</span>${seg('tGroup', [['all', '全部'], ...groups.map((g) => [g, g])], F.tGroup)}</div>` : ''}
      </div>
      <p class="pi-note">${priceNote(rows)} · 配方取自游戏客户端，哪个物品商人现在开放哪些兑换以游戏里为准</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">${tradeHead()}
      <tbody>${rows.map((x, i) => tradeRow(x, i, token)).join('') || '<tr><td colspan="8" class="text-muted">没有符合条件的兑换项</td></tr>'}</tbody></table></div></div>
    ${getsCard(token)}`;
  fillVolumes(body, rows);
}

function openToken(id, q = '') {
  F.token = id;
  F.tab = 'trade';
  F.tGroup = 'all';
  S.tQ = q;
  save();
  renderTab();
  document.querySelector('#lpView .kb-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
}

const tradeLines = (r) => r.ins.map(([id, q]) => `${tName(id)}\t${q}`);

// ---------- 我的 LP ----------
async function loadMine() {
  S.mineLoading = true;
  S.mineError = null;
  try {
    const token = await ctx.ensureEsiToken();
    const list = await ctx.esiAuthFetch('/characters/' + token.character_id + '/loyalty/points/');
    S.mine = (Array.isArray(list) ? list : []).sort((a, b) => b.loyalty_points - a.loyalty_points);
  } catch (error) {
    S.mineError = error.status === 403 || /scope/i.test(error.esiError || '')
      ? `授权缺少 ${LP_SCOPE}，请重新绑定 ESI`
      : '读取失败：' + error.message;
  } finally {
    S.mineLoading = false;
  }
}

function bestOffer(corp) {
  let best = null;
  for (const id of D.data.stores[corp] || []) {
    const o = offer(id);
    if (o.bp || !o.lp) continue;
    const v = valueOf(o);
    if (v.missing || v.iskLp == null) continue;
    if (!best || v.iskLp > best.v.iskLp) best = { o, v };
  }
  return best;
}

function renderMine(body) {
  if (!ctx.hasEsiToken()) {
    body.innerHTML = '<div class="pi-card"><p class="text-muted">需要先绑定 ESI</p></div>';
    return;
  }
  if (!S.mine && !S.mineError) {
    body.innerHTML = '<div class="pi-loading">读取角色忠诚点…</div>';
    if (!S.mineLoading) loadMine().then(() => { if (F.tab === 'mine') refreshBody(); });
    return;
  }
  if (S.mineError) {
    body.innerHTML = `<div class="pi-card"><p class="text-muted">${ctx.esc(S.mineError)}</p><p class="pi-note"><button class="btn btn-ghost" data-lp-mine-reload>重试</button></p></div>`;
    return;
  }
  const rows = S.mine.map((x) => ({ ...x, best: D.corpById.has(x.corporation_id) ? bestOffer(x.corporation_id) : null }));
  const total = rows.reduce((t, r) => t + (r.best ? r.best.v.iskLp * r.loyalty_points : 0), 0);
  body.innerHTML = `
    <div class="pi-card lp-mine-summary">
      <div><span class="text-muted">LP 总数</span><b>${ctx.formatNumber(rows.reduce((t, r) => t + r.loyalty_points, 0))}</b></div>
      <div><span class="text-muted">按最佳兑换估值</span><b class="pi-profit">${ctx.formatISK(total)}</b></div>
      <div><span class="text-muted">军团</span><b>${rows.length}</b></div>
      <button class="btn btn-ghost" data-lp-mine-reload>刷新</button>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table">
      <thead><tr><th>军团</th><th class="num">LP</th><th>最佳兑换（物品）</th><th class="num">ISK/LP</th><th class="num">估值</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr data-lp-corp="${r.corporation_id}" title="打开该军团的 LP 商店">
          <td><div class="pi-prod"><img src="${LOGO(r.corporation_id)}" alt="" width="28" height="28" loading="lazy"><span>${ctx.esc(corpName(r.corporation_id))}</span></div></td>
          <td class="num">${ctx.formatNumber(r.loyalty_points)}</td>
          <td>${r.best ? ctx.esc(tName(r.best.o.type)) : '<span class="text-muted">无可估价兑换项</span>'}</td>
          <td class="num pi-profit">${r.best ? (r.best.v.approx ? '≈' : '') + ctx.formatNumber(Math.round(r.best.v.iskLp)) : '—'}</td>
          <td class="num">${r.best ? ctx.formatISK(r.best.v.iskLp * r.loyalty_points) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="text-muted">该角色还没有任何 LP</td></tr>'}</tbody></table></div></div>`;
}

// 仅重绘主体，保留滚动位置
function refreshBody() {
  const scroller = document.querySelector('#lpView .kb-scroll');
  const top = scroller?.scrollTop || 0;
  // 正在输入的搜索框 / 比例区间框重绘后接着输入
  const ae = document.activeElement, ds = ae?.dataset || {};
  const focus = ds.lpQ ? `[data-lp-q="${ds.lpQ}"]` : ds.lpRng ? `[data-lp-rng="${ds.lpRng}"]` : null;
  const caret = focus ? ae.selectionStart : null;
  renderTab();
  if (scroller) scroller.scrollTop = top;
  if (focus) {
    const input = document.querySelector(focus);
    input?.focus();
    if (caret != null) input?.setSelectionRange(caret, caret);
  }
}

// ---------- 侧栏 ----------
function renderSide() {
  const el = $('lpSide');
  if (!el || !D.data) return;
  const nav = `<nav class="ind-side-nav">${TABS.map(([k, l, icon]) => `<button type="button" class="profile-nav-btn${F.tab === k ? ' active' : ''}" data-side-tab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>${l}</button>`).join('')}</nav>`;
  const search = $('lpSideSearch');
  const ph = F.tab === 'trade' ? ['搜索代币 / 兑换品', '搜索代币或兑换品'] : ['搜索军团 / 兑换品', '搜索军团或兑换品'];
  if (search && search.dataset.mode !== F.tab) { search.dataset.mode = F.tab; search.placeholder = ph[0]; search.setAttribute('aria-label', ph[1]); }
  if (F.tab === 'trade') { renderTradeSide(el, nav); return; }
  const item = (c) => `<button type="button" class="ind-side-item${F.tab === 'store' && c.id === F.corp ? ' active' : ''}" data-side-corp="${c.id}"><img src="${LOGO(c.id)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(c.name)}</span><small>${(D.data.stores[c.id] || []).length}</small></button>`;
  if (S.sideQ) {
    const q = S.sideQ.toLowerCase();
    const corps = D.data.corps.filter((c) => c.name.toLowerCase().includes(q));
    const items = [];
    for (const id of Object.keys(D.data.offers)) {
      const o = offer(id);
      if (items.length < 40 && tName(o.type).toLowerCase().includes(q) && !items.some((x) => x.type === o.type)) items.push(o);
    }
    el.innerHTML = nav +
      `<div class="ind-side-section"><h4>军团 <small>${corps.length}</small></h4>${corps.map(item).join('') || '<p class="ind-side-empty">没有匹配的军团</p>'}</div>` +
      `<div class="ind-side-section"><h4>兑换品 <small>${items.length >= 40 ? '前 40 个' : items.length}</small></h4>${items.map((o) => `<button type="button" class="ind-side-item" data-side-item="${ctx.esc(tName(o.type))}"><img src="${o.bp ? BPC_ICON(o.type) : ICON(o.type)}"${o.bp ? '' : ` data-item-pop="${o.type}"`} alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(tName(o.type))}</span><small>${(D.corpsByOffer.get(o.id) || []).length} 家</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的兑换品</p>'}</div>`;
    return;
  }
  const byFaction = new Map();
  for (const c of D.data.corps) {
    const k = c.faction || 0;
    if (!byFaction.has(k)) byFaction.set(k, []);
    byFaction.get(k).push(c);
  }
  const cur = D.corpById.get(F.corp)?.faction || 0;
  const tree = [...byFaction.entries()].map(([fid, list]) => `
    <details class="ind-side-cat"${fid === cur ? ' open' : ''}>
      <summary>${ctx.esc(D.data.factions[fid] || '其他')}<small>${list.length}</small></summary>
      <div class="ind-side-items">${list.map(item).join('')}</div>
    </details>`).join('');
  // 重绘时保留已展开的势力
  const opened = new Set([...el.querySelectorAll('.ind-side-cat[open] > summary')].map((s) => s.firstChild?.textContent));
  el.innerHTML = nav + `<div class="ind-side-section"><h4>按势力浏览</h4>${tree}</div>`;
  el.querySelectorAll('.ind-side-cat > summary').forEach((s) => { if (opened.has(s.firstChild?.textContent)) s.parentElement.open = true; });
}

// 物品商人侧栏：代币按市场分组（血色收割资产、活动资产…），分组按兑换项总数排；搜索时列出匹配的代币和兑换品
function renderTradeSide(el, nav) {
  if (!TD.data) {
    el.innerHTML = nav + '<p class="ind-side-empty">读取物品商人数据…</p>';
    loadTrade().then(() => { if (F.tab === 'trade') renderSide(); }).catch(() => {});
    return;
  }
  const esc = ctx.esc;
  curToken();
  const n = (id) => TD.uses.get(id).length;
  const item = (id) => `<button type="button" class="ind-side-item${id === F.token ? ' active' : ''}" data-side-token="${id}"><img src="${ICON(id)}" alt="" width="22" height="22" loading="lazy"><span>${esc(tName(id))}</span><small>${n(id)}</small></button>`;
  const all = [...TD.uses.keys()].sort((a, b) => n(b) - n(a) || tName(a).localeCompare(tName(b), 'zh'));
  if (S.sideQ) {
    const q = S.sideQ.toLowerCase();
    const toks = all.filter((id) => tName(id).toLowerCase().includes(q));
    const items = [];
    const seen = new Set();
    for (const r of TD.byId.values()) {
      for (const [o] of r.outs) {
        if (items.length < 40 && !seen.has(o) && tName(o).toLowerCase().includes(q)) { seen.add(o); items.push([o, r.ins[0][0]]); }
      }
    }
    el.innerHTML = nav +
      `<div class="ind-side-section"><h4>代币 <small>${toks.length}</small></h4>${toks.map(item).join('') || '<p class="ind-side-empty">没有匹配的代币</p>'}</div>` +
      `<div class="ind-side-section"><h4>兑换品 <small>${items.length >= 40 ? '前 40 个' : items.length}</small></h4>${items.map(([o, t]) => `<button type="button" class="ind-side-item" data-side-titem="${t}" data-q="${esc(tName(o))}" title="${esc(tName(t))}"><img src="${ICON(o)}" data-item-pop="${o}" alt="" width="22" height="22" loading="lazy"><span>${esc(tName(o))}</span><small>${esc(tName(t))}</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的兑换品</p>'}</div>`;
    return;
  }
  const byGroup = new Map();
  for (const id of all) {
    const g = TD.data.tokens[id]?.[0] || '其他';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(id);
  }
  const total = (list) => list.reduce((t, id) => t + n(id), 0);
  const cur = TD.data.tokens[F.token]?.[0] || '其他';
  const opened = new Set([...el.querySelectorAll('.ind-side-cat[open] > summary')].map((s) => s.firstChild?.textContent));
  el.innerHTML = nav + `<div class="ind-side-section"><h4>代币</h4>${[...byGroup].sort((a, b) => total(b[1]) - total(a[1])).map(([g, list]) => `
    <details class="ind-side-cat"${g === cur ? ' open' : ''}>
      <summary>${esc(g)}<small>${list.length}</small></summary>
      <div class="ind-side-items">${list.map(item).join('')}</div>
    </details>`).join('')}</div>`;
  el.querySelectorAll('.ind-side-cat > summary').forEach((s) => { if (opened.has(s.firstChild?.textContent)) s.parentElement.open = true; });
}

function openCorp(id) {
  F.corp = id;
  F.tab = 'store';
  S.q = '';
  save();
  renderTab();
  document.querySelector('#lpView .kb-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function onSideClick(e) {
  const tab = e.target.closest('[data-side-tab]');
  if (tab) { F.tab = tab.dataset.sideTab; save(); renderTab(); ctx.closeDrawer?.(); return; }
  const corp = e.target.closest('[data-side-corp]');
  if (corp) { openCorp(Number(corp.dataset.sideCorp)); ctx.closeDrawer?.(); return; }
  const tok = e.target.closest('[data-side-token]');
  if (tok) { openToken(Number(tok.dataset.sideToken)); ctx.closeDrawer?.(); return; }
  const tItem = e.target.closest('[data-side-titem]');
  if (tItem) { openToken(Number(tItem.dataset.sideTitem), tItem.dataset.q || ''); ctx.closeDrawer?.(); return; }
  const it = e.target.closest('[data-side-item]');
  if (it) { F.tab = 'rank'; F.faction = 'all'; S.rankQ = it.dataset.sideItem; save(); renderTab(); ctx.closeDrawer?.(); }
}

// ---------- 事件 ----------
function onClick(e) {
  const tab = e.target.closest('[data-lp-tab]');
  if (tab) { F.tab = tab.dataset.lpTab; save(); renderTab(); return; }
  const sort = e.target.closest('[data-lp-sort]');
  if (sort) {
    const k = sort.dataset.lpSort;
    F.dir = F.sort === k ? (F.dir === 'asc' ? 'desc' : 'asc') : SORT_DIR[k];
    F.sort = k;
    save();
    refreshBody();
    return;
  }
  const tSort = e.target.closest('[data-lp-tsort]');
  if (tSort) {
    const k = tSort.dataset.lpTsort;
    F.tDir = F.tSort === k ? (F.tDir === 'asc' ? 'desc' : 'asc') : T_SORT_DIR[k];
    F.tSort = k;
    save();
    refreshBody();
    return;
  }
  const tok = e.target.closest('[data-lp-token]');
  if (tok) { openToken(Number(tok.dataset.lpToken)); return; }
  const tCart = e.target.closest('[data-lp-tcart]');
  if (tCart) {
    const r = TD.byId.get(Number(tCart.dataset.lpTcart));
    if (r) ctx.addToCart(r.ins.map(([id, qty]) => ({ id, qty, name: tName(id) })));
    return;
  }
  const tCopy = e.target.closest('[data-lp-tcopy]');
  if (tCopy) {
    const r = TD.byId.get(Number(tCopy.dataset.lpTcopy));
    if (r) ctx.copyText(tradeLines(r).join('\n'), `已复制 ${r.ins.length} 项，在游戏市场「批量购买」里粘贴`);
    return;
  }
  const tRow = e.target.closest('[data-lp-topen]');
  if (tRow) {
    const id = Number(tRow.dataset.lpTopen);
    if (S.tOpen.has(id)) S.tOpen.delete(id); else S.tOpen.add(id);
    refreshBody();
    return;
  }
  const set = e.target.closest('[data-lp-set]');
  if (set) {
    F[set.dataset.lpSet] = set.dataset.v;
    save();
    if (['price', 'mat', 'bp', 'taxMode'].includes(set.dataset.lpSet)) renderSettings();
    if (set.dataset.lpSet === 'bp') loadBpAll();
    refreshBody();
    return;
  }
  if (e.target.closest('[data-lp-rng-clear]')) { F.rng = { sell: ['', ''], buy: ['', ''] }; save(); refreshBody(); return; }
  if (e.target.closest('[data-lp-refine]')) { refineRank(); return; }
  if (e.target.closest('[data-lp-export]')) { exportRank(); return; }
  if (e.target.closest('[data-lp-mine-reload]')) { S.mine = null; S.mineError = null; refreshBody(); return; }
  const max = e.target.closest('[data-lp-max]');
  if (max) { const o = offer(max.dataset.lpMax); setTimes(o.id, myMax(o), max); return; }
  const cart = e.target.closest('[data-lp-cart]');
  if (cart) {
    const [kind, id] = cart.dataset.lpCart.split(':');
    const o = offer(id);
    if (o) ctx.addToCart(buyItems(o, kind));
    return;
  }
  const copy = e.target.closest('[data-lp-copy]');
  if (copy) {
    const [kind, id] = copy.dataset.lpCopy.split(':');
    const o = offer(id);
    if (!o) return;
    const lines = buyLines(o, kind);
    ctx.copyText(lines.join('\n'), `已复制 ${lines.length} 项${timesOf(o) > 1 ? `（× ${timesOf(o)} 次兑换）` : ''}，在游戏「批量购买」里粘贴`);
    return;
  }
  const market = e.target.closest('[data-lp-market]');
  if (market) { location.hash = '#type=' + market.dataset.lpMarket; return; }
  const corp = e.target.closest('[data-lp-corp]');
  if (corp) { openCorp(Number(corp.dataset.lpCorp)); return; }
  const row = e.target.closest('[data-lp-open]');
  if (row) {
    const id = Number(row.dataset.lpOpen);
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    refreshBody();
  }
}

function onChange(e) {
  if (e.target.matches('[data-lp-times]')) { setTimes(e.target.dataset.lpTimes, Number(e.target.value), e.target); return; }
  if (e.target.matches('[data-lp-faction]')) { F.faction = e.target.value; save(); refreshBody(); return; }
  if (e.target.matches('[data-lp-tax]')) {
    const v = Number(e.target.value);
    F.tax = Number.isFinite(v) ? Math.min(30, Math.max(0, v)) : 0;
    save();
    renderSettings();
    $('lpSettings').open = true;
    refreshBody();
  }
}

let qTimer = 0;
function onInput(e) {
  const rng = e.target.dataset?.lpRng;
  if (rng) {
    const [side, i] = rng.split(':');
    F.rng[side][Number(i)] = e.target.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { save(); refreshBody(); }, 300);
    return;
  }
  const key = e.target.dataset?.lpQ;
  if (!key) return;
  S[key] = e.target.value.trim();
  clearTimeout(qTimer);
  qTimer = setTimeout(refreshBody, 200);
}
