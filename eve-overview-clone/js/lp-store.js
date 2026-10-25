// ===== LP 商店 =====
// LP 商店：按军团浏览全部兑换项，计算每 LP 价值（ISK/LP）= (产物价值 − 所需物品成本 − ISK 费用) ÷ LP。
//          蓝图拷贝按「(产物价 − 材料价) × 数量」（材料效率 0）估值。
// 全服排行：所有 LP 商店兑换项（按 offer 去重）的 ISK/LP 排行，前列可用吉他行情精算。
// 我的 LP：ESI 角色忠诚点（esi-characters.read_loyalty.v1），按各军团最佳兑换估算价值。
// 价格：全服均价（一次请求，立即可用）或吉他卖单 / 收单（按物品逐个读取，有缓存）。
// 数据：lp-data.json 由 build_lp.mjs 生成（ESI /loyalty/stores + SDE 中文名）。
import { SERVER, HUB, HUB_NAME, eveImage } from './server.js?v=s4';
let ctx;   // esc, formatISK, formatNumber, showToast, store, fetchESI, getHubPrices, getMarketPriceMap, esiAuthFetch, ensureEsiToken, hasEsiToken, closeDrawer
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-lp-v1';
const FORGE = HUB.id;   // 默认交易中心所在星域（吉他 / 曙光服为长征）
const LP_SCOPE = 'esi-characters.read_loyalty.v1';
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
const BPC_ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/bpc?size=${size}`;
const LOGO = (id, size = 32) => eveImage(`corporations/${id}/logo`, size);
const RANK_LIMIT = 200;
const REFINE_TOP = 40;

const TABS = [
  ['store', 'LP 商店', '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9h18"/><path d="M9 20v-6h6v6"/>'],
  ['rank', '全服排行', '<path d="M3 20h18"/><path d="M6 16V10M12 16V5M18 16v-8"/>'],
  ['mine', '我的 LP', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>']
];

const D = { loading: null, data: null, avg: new Map(), offersByType: new Map(), corpById: new Map(), corpsByOffer: new Map(), history: new Map() };
const F = { tab: 'store', corp: 1000035, price: 'sell', mat: 'sell', tax: 3.4, kind: 'all', sort: 'iskLp', dir: 'desc', faction: 'all' };
const S = { times: new Map(), q: '', rankQ: '', sideQ: '', open: new Set(), loadingJita: null, progress: '', refined: new Set(), mine: null, mineError: null, mineLoading: false, rendered: '' };
const jita = new Map();   // 吉他行情 id -> { sell, buy }

export function initLp(context) {
  ctx = context;
  Object.assign(F, ctx.store.getJSON(STORE_KEY, {}) || {});
  if (F.sort === 'isk') F.sort = 'iskLp';                   // 旧版排序按钮
  if (!SORT_DIR[F.sort]) { F.sort = 'iskLp'; F.dir = 'desc'; }
  if (F.dir !== 'asc' && F.dir !== 'desc') F.dir = SORT_DIR[F.sort];
  // 个人中心切换角色：「我的 LP」重新读取
  window.addEventListener('eve-account-change', () => { S.mine = null; S.mineError = null; });
}

// 表头排序（与市场中心订单簿一致）：点击表头按该列排序，再点一次反向；首次点击用该列更有用的方向
const SORT_DIR = { name: 'asc', lp: 'asc', iskCost: 'asc', req: 'asc', revenue: 'desc', profit: 'desc', iskLp: 'desc' };
const SORT_KEY = {
  lp: (r) => r.o.lp, iskCost: (r) => r.o.isk, req: (r) => r.v.reqCost,
  revenue: (r) => (r.v.missing ? null : r.v.revenue), profit: (r) => (r.v.missing ? null : r.v.profit), iskLp: (r) => (r.v.missing ? null : r.v.iskLp)
};
const sortTh = (key, label, cls = '') => {
  const on = F.sort === key;
  return `<th class="sortable${cls ? ' ' + cls : ''}${on ? ' sorted' : ''}" data-lp-sort="${key}" data-dir="${on ? F.dir : ''}" aria-sort="${on ? (F.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}</th>`;
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

const tName = (id) => D.data.names[id] || String(id);
const offer = (id) => {
  const o = D.data.offers[id];
  return { id: Number(id), type: o[0], qty: o[1], lp: o[2], isk: o[3], ak: o[4], req: o[5], bp: D.data.bp[o[0]] || null };
};
const corpName = (id) => D.corpById.get(id)?.name || String(id);

// 某个物品的单价：side = sell / buy / avg；吉他价缺失时回落到全服均价
function price(id, side) {
  if (side !== 'avg') {
    const p = jita.get(id)?.[side];
    if (p) return { v: p, src: 'jita' };
  }
  const a = D.avg.get(id);
  return a ? { v: a, src: 'avg' } : { v: null, src: null };
}

// 兑换项估值
function valueOf(o) {
  let missing = false, approx = false;
  const use = (id, side) => {
    const p = price(id, side);
    if (p.v == null) missing = true;
    else if (side !== 'avg' && p.src === 'avg') approx = true;
    return p.v || 0;
  };
  let unit;
  if (o.bp) {
    const [pid, pq, mats] = o.bp;
    unit = use(pid, F.price) * pq - mats.reduce((t, [m, q]) => t + use(m, F.mat) * q, 0);
  } else unit = use(o.type, F.price);
  const revenue = unit * o.qty * (1 - F.tax / 100);
  const reqCost = o.req.reduce((t, [m, q]) => t + use(m, F.mat) * q, 0);
  const cost = o.isk + reqCost;
  const profit = revenue - cost;
  return { revenue, reqCost, cost, profit, iskLp: o.lp ? profit / o.lp : null, missing, approx };
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

async function dailyVolume(id) {
  if (D.history.has(id)) return D.history.get(id);
  const p = ctx.fetchESI(`/markets/${FORGE}/history/?type_id=${id}`).then((h) => {
    const last = (Array.isArray(h) ? h : []).slice(-30);
    return last.length ? last.reduce((t, x) => t + x.volume, 0) / last.length : 0;
  }).catch(() => null);
  D.history.set(id, p);
  return p;
}

// 表格前若干行异步填入吉他 30 天日均成交量
function fillVolumes(body, rows) {
  const ids = [...new Set(rows.slice(0, 25).map((r) => (r.o.bp ? r.o.bp[0] : r.o.type)))];
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const v = await dailyVolume(id);
      body.querySelectorAll(`[data-lp-vol="${id}"]`).forEach((c) => { c.textContent = v == null ? '—' : ctx.formatNumber(Math.round(v)); });
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------- 入口 ----------
export async function showLp(hash = location.hash) {
  const main = $('lpMain');
  if (!D.data) main.innerHTML = '<div class="pi-loading">载入 LP 商店数据…</div>';
  await loadData();
  const m = /^#lp(?:\/(store|rank|mine))?(?:\/(\d+))?/.exec(hash || '');
  if (m?.[1]) F.tab = m[1];
  if (m?.[1] === 'store' && m[2] && D.corpById.has(Number(m[2]))) F.corp = Number(m[2]);
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

const stateKey = () => F.tab + ':' + (F.tab === 'store' ? F.corp : '');

function setHash() {
  if ($('lpView').hidden) return;   // 后台读完行情重绘时不改其他页面的地址
  const h = F.tab === 'store' ? `#lp/store/${F.corp}` : `#lp/${F.tab}`;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + h);
}

function renderTab() {
  document.querySelectorAll('[data-lp-tab]').forEach((b) => b.classList.toggle('active', b.dataset.lpTab === F.tab));
  setHash();
  S.rendered = stateKey();
  renderSide();
  const body = $('lpBody');
  if (F.tab === 'store') renderStore(body);
  else if (F.tab === 'rank') renderRank(body);
  else renderMine(body);
}

const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-lp-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const PRICE_ZH = { sell: HUB_NAME + '卖单', buy: HUB_NAME + '收单', avg: '全服均价' };

// ---------- 设置 ----------
function renderSettings() {
  const el = $('lpSettings');
  el.innerHTML = `
    <summary><b>估价设置</b><span class="text-muted">产物按${PRICE_ZH[F.price]} · 材料按${PRICE_ZH[F.mat]} · 税费 ${F.tax}%</span></summary>
    <div class="ind-set-grid">
      <div class="pi-field"><label>产物卖出价</label>${seg('price', [['sell', PRICE_ZH.sell], ['buy', PRICE_ZH.buy], ['avg', PRICE_ZH.avg]], F.price)}
        </div>
      <div class="pi-field"><label>所需物品 / 蓝图材料买入价</label>${seg('mat', [['sell', PRICE_ZH.sell], ['buy', PRICE_ZH.buy], ['avg', PRICE_ZH.avg]], F.mat)}</div>
      <div class="pi-field"><label>卖出税费（%）</label><input type="number" class="pi-input lp-tax" data-lp-tax min="0" max="30" step="0.1" value="${F.tax}">
        </div>
    </div>`;
}

function needsJita() { return F.price !== 'avg' || F.mat !== 'avg'; }

function priceNote(rows) {
  if (!needsJita()) return '价格为全服均价（CCP 每日更新），仅供快速比较';
  if (S.loadingJita) return `<span data-lp-progress>${S.progress || `读取${HUB_NAME}行情…`}</span>（暂用全服均价）`;
  const approx = rows.some((r) => r.v.approx);
  return HUB_NAME + '实时行情' + (approx ? `（部分物品没有${HUB_NAME}挂单，用全服均价代替，标 ≈）` : '');
}

// ---------- 兑换项表格 ----------
function offerRow(r, i, { showCorp = false } = {}) {
  const { o, v } = r;
  const esc = ctx.esc, isk = ctx.formatISK;
  const pid = o.bp ? o.bp[0] : o.type;
  const open = S.open.has(o.id);
  const corps = D.corpsByOffer.get(o.id) || [];
  const cls = v.iskLp == null || v.missing ? '' : v.iskLp >= 0 ? 'pi-profit' : 'down';
  return `
    <tr data-lp-open="${o.id}" class="${open ? 'active' : ''}" title="点击展开明细">
      <td class="pi-rank lp-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${o.bp ? BPC_ICON(o.type) : ICON(o.type)}" alt="" width="28" height="28" loading="lazy"><span>${esc(tName(o.type))}${o.qty > 1 ? `<small>×${ctx.formatNumber(o.qty)}</small>` : ''}${o.bp ? '<small class="ind-tag-bpc" title="蓝图拷贝：按（产物价 − 材料价）× 数量估算，材料效率 0">蓝图</small>' : ''}</span></div>
        ${showCorp ? `<div class="lp-corps">${esc(corpName(corps[0]))}${corps.length > 1 ? ` 等 ${corps.length} 家` : ''}</div>` : ''}</td>
      <td class="num">${ctx.formatNumber(o.lp)}</td>
      <td class="num lp-hide-md">${o.isk ? isk(o.isk) : '—'}</td>
      <td class="num lp-hide-md">${o.req.length ? isk(v.reqCost) : '—'}</td>
      <td class="num pi-hide-sm">${v.missing ? '—' : isk(v.revenue)}</td>
      <td class="num lp-hide-sm">${v.missing ? '—' : isk(v.profit)}</td>
      <td class="num ${cls}">${v.missing || v.iskLp == null ? '—' : (v.approx ? '≈' : '') + ctx.formatNumber(Math.round(v.iskLp))}</td>
      <td class="num lp-hide-sm" data-lp-vol="${pid}">${i < 25 ? '…' : ''}</td>
    </tr>${open ? `<tr class="lp-detail-row"><td colspan="9">${offerDetail(o, v)}</td></tr>` : ''}`;
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
  if (kind !== 'req' && o.bp) for (const [m, q] of o.bp[2]) add(m, q * o.qty * n);
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
  const btn = (kind, label, count) => `<button type="button" class="btn btn-ghost" data-lp-copy="${kind}:${o.id}"${count ? '' : ' disabled'}>${label}${count ? `（${count} 项）` : ''}</button>`;
  return `<div class="lp-buy"><h4>复制采购清单 <small>粘贴到游戏「市场 → 批量购买」即可一次买齐</small></h4>
    <label class="lp-times">兑换次数 <input type="number" class="pi-input" min="1" max="10000" step="1" value="${n}" data-lp-times="${o.id}" aria-label="兑换次数"></label>
    ${myMax(o) ? `<button type="button" class="link-btn" data-lp-max="${o.id}">按我的 LP 最多 ${ctx.formatNumber(myMax(o))} 次</button>` : ''}
    <p class="pi-note">共需 LP <b>${ctx.formatNumber(o.lp * n)}</b> · ISK <b>${ctx.formatISK(o.isk * n)}</b>${o.ak ? ` · AK <b>${ctx.formatNumber(o.ak * n)}</b>` : ''}</p>
    <div class="lp-buy-btns">
      ${o.req.length ? btn('req', '复制兑换所需物品', o.req.length) : '<span class="text-muted">这个兑换不需要额外物品</span>'}
      ${o.bp ? btn('mats', '复制制造材料', mats) : ''}
      ${o.bp && o.req.length ? btn('all', '复制全部（合并同类）', buyLines(o, 'all').length) : ''}
      ${o.req.length || o.bp ? `<button type="button" class="btn btn-ghost" data-lp-cart="${o.bp && o.req.length ? 'all' : o.req.length ? 'req' : 'mats'}:${o.id}" title="${o.bp && o.req.length ? '兑换所需物品与制造材料' : o.req.length ? '兑换所需物品' : '制造材料'}加入购物车">加入购物车</button>` : ''}
    </div></div>`;
}

function offerDetail(o, v) {
  const esc = ctx.esc, isk = ctx.formatISK;
  const line = (id, q, side) => {
    const p = price(id, side);
    return `<li><img src="${ICON(id)}" alt="" width="20" height="20" loading="lazy"><span>${esc(tName(id))} × ${ctx.formatNumber(q)}</span><b>${p.v == null ? '无价格' : (side !== 'avg' && p.src === 'avg' ? '≈' : '') + isk(p.v * q)}</b></li>`;
  };
  const corps = D.corpsByOffer.get(o.id) || [];
  const parts = [];
  parts.push(`<div><h4>花费</h4><ul class="lp-lines"><li><span>LP</span><b>${ctx.formatNumber(o.lp)}</b></li><li><span>ISK</span><b>${isk(o.isk)}</b></li>${o.ak ? `<li><span>分析师点数（AK）</span><b>${ctx.formatNumber(o.ak)}</b></li>` : ''}${o.req.map(([m, q]) => line(m, q, F.mat)).join('')}</ul></div>`);
  if (o.bp) {
    const [pid, pq, mats] = o.bp;
    parts.push(`<div><h4>制造（每流程用量，共 ${ctx.formatNumber(o.qty)} 流程，材料效率 0）</h4><ul class="lp-lines">${line(pid, pq, F.price)}${mats.map(([m, q]) => line(m, q, F.mat)).join('')}</ul></div>`);
  } else {
    parts.push(`<div><h4>产出</h4><ul class="lp-lines">${line(o.type, o.qty, F.price)}<li><span>扣除税费 ${F.tax}%</span><b>${v.missing ? '—' : isk(v.revenue)}</b></li></ul></div>`);
  }
  parts.push(buyListHtml(o));
  parts.push(`<div><h4>可兑换的军团（${corps.length}）</h4><div class="lp-corp-list">${corps.map((c) => `<button type="button" class="chip" data-lp-corp="${c}">${esc(corpName(c))}</button>`).join('')}</div>
    <p class="pi-note"><button type="button" class="btn btn-ghost" data-lp-market="${o.bp ? o.bp[0] : o.type}">在市场中心查看产物</button></p></div>`);
  return `<div class="lp-detail">${parts.join('')}</div>`;
}

const tableHead = () => `<thead><tr><th class="lp-hide-sm">#</th>${sortTh('name', '兑换品')}${sortTh('lp', 'LP', 'num')}${sortTh('iskCost', 'ISK 费用', 'num lp-hide-md')}${sortTh('req', '所需物品', 'num lp-hide-md')}${sortTh('revenue', '产物价值', 'num pi-hide-sm')}${sortTh('profit', '利润', 'num lp-hide-sm')}${sortTh('iskLp', 'ISK/LP', 'num')}<th class="num lp-hide-sm">日均成交</th></tr></thead>`;

function sortRows(rows) {
  const mul = F.dir === 'asc' ? 1 : -1;
  if (F.sort === 'name') return rows.sort((a, b) => mul * tName(a.o.type).localeCompare(tName(b.o.type), 'zh'));
  const key = SORT_KEY[F.sort] || SORT_KEY.iskLp;
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

function filterBar(qKey, extra = '') {
  return `<div class="ind-rank-row">
      <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-lp-q="${qKey}" placeholder="筛选兑换品" value="${ctx.esc(S[qKey])}" spellcheck="false" aria-label="筛选兑换品"></div>
      <div class="pi-inline"><span>类型</span>${seg('kind', [['all', '全部'], ['item', '物品'], ['bp', '蓝图']], F.kind)}</div>
      ${extra}
    </div>`;
}

const kindOk = (o) => F.kind === 'all' || (F.kind === 'bp' ? !!o.bp : !o.bp);

// ---------- LP 商店 ----------
function storeRows() {
  const ids = D.data.stores[F.corp] || [];
  return sortRows(ids.map(offer).filter((o) => kindOk(o) && matchQ(o, S.q)).map((o) => ({ o, v: valueOf(o) })));
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
      ${filterBar('q')}
      <p class="pi-note">${priceNote(rows)}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">${tableHead()}
      <tbody>${rows.map((r, i) => offerRow(r, i)).join('') || '<tr><td colspan="9" class="text-muted">没有符合条件的兑换项</td></tr>'}</tbody></table></div></div>`;
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
  return sortRows(list);
}

function renderRank(body) {
  const rows = rankRows();
  const top = rows.slice(0, RANK_LIMIT);
  const facOpts = [['all', '全部势力'], ...Object.entries(D.data.factions)];
  const sel = `<div class="pi-inline"><span>势力</span><select class="pi-input lp-faction" data-lp-faction>${facOpts.map(([v, l]) => `<option value="${v}"${String(F.faction) === String(v) ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('')}</select></div>`;
  const refineIds = top.slice(0, REFINE_TOP).flatMap((r) => offerTypes(r.o));
  const refined = !needsJita() || refineIds.every((id) => jita.has(id));
  body.innerHTML = `
    <div class="pi-card ind-rank-filters">
      ${filterBar('rankQ', sel)}
      <p class="pi-note">${needsJita() && !refined && !S.loadingJita ? '全服均价估算' : priceNote(top.slice(0, REFINE_TOP))}
        ${needsJita() && !refined ? `<button class="btn btn-ghost ind-refine" data-lp-refine ${S.loadingJita ? 'disabled' : ''}>${S.loadingJita ? '精算中…' : `用${HUB_NAME}行情精算前 ${REFINE_TOP} 名`}</button>` : ''}
        · 共 ${rows.length} 项${rows.length > RANK_LIMIT ? `，显示前 ${RANK_LIMIT}` : ''}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap lp-table-wrap"><table class="pi-table lp-table">${tableHead()}
      <tbody>${top.map((r, i) => offerRow(r, i, { showCorp: true })).join('') || '<tr><td colspan="9" class="text-muted">没有符合条件的兑换项</td></tr>'}</tbody></table></div></div>`;
  fillVolumes(body, top);
}

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
      ? `当前 ESI 授权不包含 ${LP_SCOPE}，请在个人中心重新绑定（服务端也需开启该授权范围）。`
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
    body.innerHTML = '<div class="pi-card"><p class="text-muted">在「个人中心」绑定角色后查看 LP 余额</p></div>';
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
  const focus = document.activeElement?.dataset?.lpQ;
  const caret = focus ? document.activeElement.selectionStart : null;
  renderTab();
  if (scroller) scroller.scrollTop = top;
  if (focus) {
    const input = document.querySelector(`[data-lp-q="${focus}"]`);
    input?.focus();
    if (caret != null) input?.setSelectionRange(caret, caret);
  }
}

// ---------- 侧栏 ----------
function renderSide() {
  const el = $('lpSide');
  if (!el || !D.data) return;
  const nav = `<nav class="ind-side-nav">${TABS.map(([k, l, icon]) => `<button type="button" class="profile-nav-btn${F.tab === k ? ' active' : ''}" data-side-tab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>${l}</button>`).join('')}</nav>`;
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
      `<div class="ind-side-section"><h4>兑换品 <small>${items.length >= 40 ? '前 40 个' : items.length}</small></h4>${items.map((o) => `<button type="button" class="ind-side-item" data-side-item="${ctx.esc(tName(o.type))}"><img src="${o.bp ? BPC_ICON(o.type) : ICON(o.type)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(tName(o.type))}</span><small>${(D.corpsByOffer.get(o.id) || []).length} 家</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的兑换品</p>'}</div>`;
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
  const set = e.target.closest('[data-lp-set]');
  if (set) {
    F[set.dataset.lpSet] = set.dataset.v;
    save();
    if (['price', 'mat'].includes(set.dataset.lpSet)) renderSettings();
    refreshBody();
    return;
  }
  if (e.target.closest('[data-lp-refine]')) {
    const ids = rankRows().slice(0, REFINE_TOP).flatMap((r) => offerTypes(r.o));
    loadJita(ids, () => { if (F.tab === 'rank') refreshBody(); });
    refreshBody();
    return;
  }
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
  const key = e.target.dataset?.lpQ;
  if (!key) return;
  S[key] = e.target.value.trim();
  clearTimeout(qTimer);
  qTimer = setTimeout(refreshBody, 200);
}
