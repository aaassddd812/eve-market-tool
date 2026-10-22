// ===== 深渊市场（MutaMarket 数据）=====
// 参照 mutamarket.com 的公开功能：按深渊类型浏览在售装备（公开合同 + 卖家直接挂单）、按原装备等级 / 合同类型 / 价格 / 估价 /
// 每项属性范围 / 金条棕条筛选与排序；装备详情（估价面板、模型可信度、属性在范围中的位置、与各原装备对比、搜索相似）；
// 粘贴物品链接估价；各类型价格模型统计。
// 数据经本站击杀记录服务代理（kb_service.py 的 Abyssal）：/api/v1/abyssal/{types,list,modules/{id},appraise,models}。
// 地址栏：#abyss（上次的类型）· #abyss/t/<类型>?筛选（与 /api/v1/abyssal/list 的参数相同，可收藏分享）· #abyss/m/<物品ID> · #abyss/appraise · #abyss/stats
// 只有宁静服：价格来自宁静服合同。
import { SERVER, IS_TQ } from './server.js?v=s3';

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, resolveTypeNames, getHubPrices, fetchESI, game, openDynamicItem,
           // loadAbyssal() -> abyssal.js 模块, dogmaNames() -> { attrs, units }, fmtAttr(v, unit, units), closeDrawer
let A;     // abyssal.js（共用的估价卡片、时间格式）
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s);
const STORE_KEY = 'eve-abyss-v1';
const DEFAULT_TYPE = 52227;   // 深渊损伤控制
const ICON = (id, size = 64) => `https://images.evetech.net/types/${id}/icon?size=${size}`;

const D = { types: null, byId: new Map(), names: new Map(), dogma: null, muta: null };
const S = {
  view: 'market', type: 0, query: new URLSearchParams(), items: [], cursor: null, loading: false, error: '', seq: 0,
  item: null, search: '',
  bars: 'default', scores: false   // 显示设置：属性条按质体范围 / 类型范围 / 不显示；是否显示 roll 分数
};

// 派生属性（MutaMarket 计算，不是游戏里的属性）
const DERIVED = {
  5000000: '护盾回复速度', 5000001: '护盾回复效率', 5000002: '装甲维修速度', 5000003: '装甲维修效率',
  5000004: 'DPS 提升', 5000005: 'DPS 提升', 5000006: '有效采集速度', 5000007: '采集速度'
};
const META_GROUPS = [['', '全部'], ['t1', 'T1'], ['t2', 'T2'], ['storyline', '故事线'], ['faction', '势力'], ['deadspace', '死亡空间'], ['officer', '官员']];
const BARS = { 1: ['gold', '金条：达到该类型最好值'], 2: ['diamond', '钻石：荣耀质体上的最好值'], '-1': ['brown', '棕条：该类型最差值'] };
// 分类（按英文名归类，与 MutaMarket 的类别选择相近）
const CATS = [
  ['旗舰', /Capital|10000MN|50000MN|Siege/],
  ['推进', /Microwarpdrive|Afterburner/],
  ['电子战', /Webifier|Scrambler|Disruptor|Neutralizer|Nosferatu/],
  ['维修与防御', /Repairer|Shield Booster|Shield Extender|Armor Plates|Damage Control/],
  ['电容', /Cap Battery/],
  ['武器增强', /Stabilizer|Heat Sink|Gyrostabilizer|Radiation Sink|Ballistic|Vorton|Drone Damage Amplifier|Fighter Support/],
  ['无人机', /Drone|Tracking|Link/],
  ['采矿', /Min(ing|er)|Harvest|Scoop|Excavator/],
  ['炸弹', /Smartbomb/]
];
const catOf = (en) => (CATS.find(([, re]) => re.test(en)) || ['其他'])[0];

function load() {
  try { Object.assign(S, JSON.parse(ctx.store.get(STORE_KEY) || '{}')); } catch { /* 忽略 */ }
}
function save() { ctx.store.set(STORE_KEY, JSON.stringify({ type: S.type, bars: S.bars, scores: S.scores })); }

export function initAbyss(context) { ctx = context; load(); }

// ---------- 数据 ----------
async function api(path, init) {
  const res = await fetch('/api/v1/abyssal/' + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error?.message || 'HTTP ' + res.status); e.status = res.status; throw e; }
  return body;
}
async function loadBase() {
  if (D.types) return;
  const [r, dogma, mod] = await Promise.all([api('types'), ctx.dogmaNames(), ctx.loadAbyssal()]);
  A = mod;
  D.dogma = dogma;
  D.types = r.types.map((t) => ({ ...t, cat: catOf(t.name) }));
  for (const t of D.types) D.byId.set(t.id, t);
  await names(D.types.map((t) => t.id));
}
async function names(ids) {
  const todo = [...new Set(ids)].filter((id) => id && !D.names.has(id));
  if (!todo.length) return;
  const map = await ctx.resolveTypeNames(todo).catch(() => new Map());
  for (const id of todo) D.names.set(id, map.get(id) || '');
}
const nameOf = (id, fallback) => D.names.get(id) || fallback || 'Type ' + id;
function loadMuta() {
  if (!D.muta) D.muta = fetch('mutaplasmid-data.json?v=1').then((r) => r.json()).catch((e) => { D.muta = null; throw e; });
  return D.muta;
}

// ---------- 属性显示 ----------
// 显示值与原始值（毫秒显示为秒、倍率显示为百分比），与游戏和 MutaMarket 一致
function toShow(v, unit) {
  switch (unit) {
    case 101: return v / 1000;
    case 108: case 111: return (1 - v) * 100;
    case 109: return (v - 1) * 100;
    case 127: return v * 100;
    default: return v;
  }
}
function fromShow(v, unit) {
  switch (unit) {
    case 101: return v * 1000;
    case 108: case 111: return 1 - v / 100;
    case 109: return 1 + v / 100;
    case 127: return v / 100;
    default: return v;
  }
}
const attrName = (a) => DERIVED[a.id] || D.dogma.attrs[a.id]?.[0] || a.name;
const unitOf = (a) => D.dogma.attrs[a.id]?.[1] ?? a.unit_id;
const unitText = (a) => { const u = unitOf(a); return [101].includes(u) ? '秒' : [105, 108, 109, 111, 124, 127].includes(u) ? '%' : D.dogma.units[u] || a.unit || ''; };
const num = (x, d = 2) => Number(Number(x).toFixed(d)).toLocaleString('zh-CN');
function fmtVal(a, v) {
  const u = unitOf(a);
  return u >= 5000000 || !D.dogma.units[u] && ![101, 105, 108, 109, 111, 124, 127].includes(u) ? num(v) + (a.unit ? ' ' + a.unit : '') : ctx.fmtAttr(v, u, D.dogma.units);
}
function fmtDelta(a) {
  const u = unitOf(a);
  const d = toShow(a.value, u) - toShow(a.base_value, u);
  if (Math.abs(d) < 1e-9) return '±0';
  return (d > 0 ? '+' : '') + num(d) + (unitText(a) === '%' ? '%' : unitText(a) ? ' ' + unitText(a) : '');
}

// 属性条：按质体范围（-1 最差 … 0 原值 … 1 最好）或按整个深渊类型归一化
function barHtml(a) {
  if (S.bars === 'none') return '';
  const f = S.bars === 'type' ? a.fraction_type : a.fraction;
  if (f == null) return '<div class="aby-bar"></div>';
  const w = Math.min(Math.abs(f), 1) * 50;
  const band = S.bars === 'type' && Array.isArray(a.type_band) ? `<b style="left:${50 - a.type_band[0] * 50}%;right:${50 - a.type_band[1] * 50}%"></b>` : '';
  return `<div class="aby-bar">${band}<i class="${f >= 0 ? 'up' : 'down'}" style="${f >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></div>`;
}
const shownAttrs = (m) => m.attributes.filter((a) => !a.is_virtual);
function attrRow(a) {
  const f = a.fraction ?? 0;
  const bar = BARS[a.bar];
  const cls = bar ? bar[0] : Math.abs(f) < 1e-6 ? '' : f > 0 ? 'up' : 'down';
  return `<div class="aby-attr ${cls}"${bar ? ` title="${bar[1]}"` : ''}>
    <span class="aby-attr-name">${esc(attrName(a))}${a.is_derived ? '<em>推算</em>' : ''}</span>
    <span class="aby-attr-val">${esc(fmtVal(a, a.value))}</span>
    <span class="aby-attr-delta">${esc(fmtDelta(a))}${S.scores && a.fraction != null ? `<small>${f > 0 ? '+' : ''}${Math.round(f * 100)}</small>` : ''}</span>
    ${barHtml(a)}</div>`;
}
function priceHtml(m) {
  const c = m.contract;
  const extra = c ? (c.abyssal_modules_count || 1) - 1 + (c.non_abyssal_modules_count || 0) : 0;
  const kind = c ? (c.type === 'auction' ? '拍卖' : '交换') : m.listed ? '直售' : '';
  const price = c?.price ? ctx.formatISK(c.price) : m.listed ? '议价' : '—';
  return `<span class="aby-price">${kind ? `<em class="aby-kind ${c?.type === 'auction' ? 'auction' : ''}">${kind}</em>` : ''}<b>${price}</b>${extra > 0 ? `<em class="aby-plus" title="同一合同里还有 ${extra} 件其它物品，价格不是这一件的">+${extra}</em>` : ''}</span>
    <span class="aby-est" title="MutaMarket 模型估价">估 <b>${m.estimated_value ? ctx.formatISK(m.estimated_value) : '—'}</b></span>`;
}
function cardHtml(m, big = false) {
  const st = m.source_type || {};
  return `<article class="aby-mcard${big ? ' big' : ''}"${big ? '' : ` data-abyss-item="${m.item_id}" tabindex="0"`}>
    <header><img src="${ICON(st.id || m.type_id)}" alt="" width="36" height="36" loading="lazy">
      <div><b>${esc(nameOf(st.id, st.name))}</b><small>${esc(nameOf(m.mutaplasmid?.id, m.mutaplasmid?.name))}</small></div></header>
    <div class="aby-attrs">${shownAttrs(m).map(attrRow).join('')}</div>
    <footer>${priceHtml(m)}</footer></article>`;
}

// ---------- 入口与路由 ----------
export async function showAbyss(hash) {
  const main = $('abyssMain');
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    bind();
  }
  if (!IS_TQ || !SERVER.kb) {
    $('abyssSide').innerHTML = '';
    main.innerHTML = `<div class="empty-state"><p>深渊市场的数据来自 MutaMarket，只收录宁静服的合同与价格，${esc(SERVER.full)}暂不支持。</p></div>`;
    return;
  }
  if (!D.types) main.innerHTML = '<div class="pi-loading">载入深渊类型…</div>';
  try { await loadBase(); } catch (e) { main.innerHTML = `<div class="empty-state"><p>深渊数据载入失败：${esc(e.message)}</p></div>`; return; }
  route(hash || location.hash);
}

function route(hash) {
  const m = /^#abyss(?:\/(t|m)\/(\d+)|\/(appraise|stats))?(?:\?(.*))?$/.exec(hash) || [];
  if (m[1] === 'm') { S.view = 'item'; openItem(Number(m[2])); }
  else if (m[3]) { S.view = m[3]; render(); }
  else {
    S.view = 'market';
    const type = Number(m[2]) || S.type || DEFAULT_TYPE;
    const q = new URLSearchParams(m[4] || '');
    const changed = type !== S.type || q.toString() !== S.query.toString() || !S.items.length && !S.loading;
    S.type = D.byId.has(type) ? type : DEFAULT_TYPE;
    S.query = q;
    save();
    render();
    if (changed) fetchList(false);
  }
}
function go(hash, replace = false) {
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + hash);
  route(hash);
}
const marketHash = (type = S.type, q = S.query) => `#abyss/t/${type}${q.toString() ? '?' + q : ''}`;

function render() {
  renderSide();
  const main = $('abyssMain');
  if (S.view === 'stats') main.innerHTML = statsHtml();
  else if (S.view === 'appraise') renderAppraise(main);
  else if (S.view === 'market') main.innerHTML = marketHtml();
  else if (S.view === 'item') renderItem();
}

// ---------- 侧边栏：页面切换 + 类型选择 ----------
function renderSide() {
  const side = $('abyssSide');
  const nav = [['market', '在售市场'], ['appraise', '物品链接估价'], ['stats', '价格模型统计']].map(([k, name]) =>
    `<button class="ind-side-item${S.view === k || (k === 'market' && S.view === 'item') ? ' active' : ''}" data-abyss-nav="${k}"><span>${name}</span></button>`).join('');
  const q = S.search.trim().toLowerCase();
  const cats = new Map();
  for (const t of D.types) {
    if (q && !nameOf(t.id).toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) continue;
    if (!cats.has(t.cat)) cats.set(t.cat, []);
    cats.get(t.cat).push(t);
  }
  const order = [...CATS.map((c) => c[0]), '其他'];
  const cur = S.view === 'item' ? S.item?.type_id : S.type;
  const groups = order.filter((c) => cats.has(c)).map((c) => {
    const list = cats.get(c).sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id), 'zh-CN'));
    const open = q || list.some((t) => t.id === cur);
    return `<details class="ind-side-cat"${open ? ' open' : ''}><summary>${c}<small>${list.length}</small></summary><div class="ind-side-items">${list.map((t) =>
      `<button class="ind-side-item${t.id === cur && S.view !== 'stats' && S.view !== 'appraise' ? ' active' : ''}" data-abyss-type="${t.id}" title="${esc(t.name)}">
        <img src="${ICON(t.id, 32)}" alt="" width="20" height="20" loading="lazy"><span>${esc(nameOf(t.id, t.name))}</span></button>`).join('')}</div></details>`;
  }).join('');
  side.innerHTML = `<div class="ind-side-nav">${nav}</div><div class="ind-side-section">${groups || '<p class="ind-side-empty">没有匹配的深渊类型</p>'}</div>`;
}

// ---------- 在售市场 ----------
function modelBadge(t) {
  const m = t?.model;
  if (!m || m.r2 == null) return `<span class="aby-badge" title="MutaMarket 至少积累 50 笔成交才训练模型">暂无估价模型</span>`;
  return `<span class="aby-badge" title="R² ${m.r2.toFixed(3)} · 平均绝对误差 ${ctx.formatISK(m.mae)} · 训练于 ${A.fmtTime(m.last_trained_at)}">模型可信度 ${A.confidence(m.r2)} · 样本 ${ctx.formatNumber(m.data_count)} · 误差约 ${Math.round(m.nmae)}%</span>`;
}
const flagOn = (f) => (S.query.get('flags') || '').split(',').includes(f);
const rangeOf = (key) => { const v = S.query.get(key) || ''; const [lo, hi] = v.split('-'); return [lo ? Number(lo) / 1e6 : '', hi ? Number(hi) / 1e6 : '']; };
function attrFilters() {
  const map = new Map();
  for (const p of (S.query.get('attrs') || '').split(',').filter(Boolean)) {
    const m = /^(\d+):(-?[\d.]+)?~(-?[\d.]+)?$/.exec(p);
    if (m) map.set(Number(m[1]), [m[2] != null ? Number(m[2]) : null, m[3] != null ? Number(m[3]) : null]);
  }
  return map;
}

function marketHtml() {
  const t = D.byId.get(S.type);
  const sort = S.query.get('sort') || 'date-added', order = S.query.get('order') || (sort === 'price' ? 'asc' : 'desc');
  const attrs = t.attributes.filter((a) => !a.is_virtual);
  const af = attrFilters();
  const sortOpts = [['date-added:desc', '最新上架'], ['contract-date:desc', '最新合同'], ['price:asc', '价格从低到高'], ['price:desc', '价格从高到低'], ['value:desc', '估价从高到低'], ['value:asc', '估价从低到高'],
    ['fraction:desc', '平均 roll 最好'],
    ...attrs.map((a) => [`${a.id}:${a.high_is_good ? 'desc' : 'asc'}`, `${attrName(a)} 最好`])];
  const contract = flagOn('auction') ? 'auction' : flagOn('item-exchange') ? 'item-exchange' : '';
  const bar = ['goldbar', 'diamondbar', 'brownbar'].find(flagOn) || '';
  const [pLo, pHi] = rangeOf('price'), [vLo, vHi] = rangeOf('value');
  const sel = (id, opts, cur) => `<select class="input" data-abyss-q="${id}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const attrInputs = attrs.map((a) => {
    const u = unitOf(a);
    const [lo, hi] = af.get(a.id) || [null, null];
    // 原始值 → 显示值（倒数类单位换算后大小反过来）
    let [showLo, showHi] = [lo, hi].map((v) => (v == null ? '' : String(+toShow(v, u).toFixed(4))));
    if ([108, 111].includes(u)) [showLo, showHi] = [showHi, showLo];
    const best = toShow(a.best, u), worst = toShow(a.worst, u);
    return `<label class="aby-af" title="该类型可能的范围：最差 ${num(worst)} · 最好 ${num(best)}"><span>${esc(attrName(a))}${a.is_derived ? '<em>推算</em>' : ''}<small>${esc(unitText(a))}</small></span>
      <input class="input" type="number" step="any" data-abyss-attr="${a.id}" data-side="lo" value="${showLo}" placeholder="${num(Math.min(best, worst))}">
      <i>~</i><input class="input" type="number" step="any" data-abyss-attr="${a.id}" data-side="hi" value="${showHi}" placeholder="${num(Math.max(best, worst))}"></label>`;
  }).join('');
  const nFilters = af.size;
  return `<section class="pi-page aby-page">
    <div class="pi-head aby-head"><img src="${ICON(t.id)}" alt="" width="40" height="40"><div><h2>${esc(nameOf(t.id, t.name))}</h2><span class="text-muted">${esc(t.name)}</span></div>
      ${modelBadge(t)}<span class="toolbar-spacer"></span><a class="btn btn-ghost btn-sm" href="https://mutamarket.com/modules/type/${t.id}" target="_blank" rel="noopener">MutaMarket 原站</a></div>
    <div class="pi-card aby-filters">
      <div class="aby-frow">
        <label><span>原装备</span>${sel('meta_group', META_GROUPS, S.query.get('meta_group') || '')}</label>
        <label><span>合同</span>${sel('contract', [['', '全部'], ['item-exchange', '物品交换'], ['auction', '拍卖']], contract)}</label>
        <label><span>星域</span>${sel('region', [['', '全部'], ...SERVER.regions.map((r) => [String(r.id), r.name])], S.query.get('region') || '')}</label>
        <label><span>极品</span>${sel('bar', [['', '不限'], ['goldbar', '金条（最好值）'], ['diamondbar', '钻石（荣耀最好值）'], ['brownbar', '棕条（最差值）']], bar)}</label>
        <label><span>排序</span>${sel('sort', sortOpts, `${sort}:${order}`)}</label>
      </div>
      <div class="aby-frow">
        <label class="aby-range"><span>价格（百万）</span><input class="input" type="number" min="0" step="any" data-abyss-range="price" data-side="lo" value="${pLo}" placeholder="最低"><i>~</i><input class="input" type="number" min="0" step="any" data-abyss-range="price" data-side="hi" value="${pHi}" placeholder="最高"></label>
        <label class="aby-range"><span>估价（百万）</span><input class="input" type="number" min="0" step="any" data-abyss-range="value" data-side="lo" value="${vLo}" placeholder="最低"><i>~</i><input class="input" type="number" min="0" step="any" data-abyss-range="value" data-side="hi" value="${vHi}" placeholder="最高"></label>
        <label class="aby-check"><input type="checkbox" data-abyss-flag="contracts-only"${flagOn('contracts-only') ? ' checked' : ''}>只看游戏合同</label>
        <label class="aby-check"><input type="checkbox" data-abyss-flag="no-multi-item-contracts"${flagOn('no-multi-item-contracts') ? ' checked' : ''}>只看单件合同</label>
        <label class="aby-check"><input type="checkbox" data-abyss-flag="in-jita"${flagOn('in-jita') ? ' checked' : ''}>吉他 4-4</label>
      </div>
      <details class="aby-adv"${nFilters ? ' open' : ''}><summary>属性范围${nFilters ? `<small>${nFilters} 项</small>` : ''}<span class="text-muted">空着表示不限；占位文字是该类型可能的范围</span></summary>
        <div class="aby-afs">${attrInputs}</div></details>
      <div class="aby-frow aby-display">
        <span class="text-muted">属性条</span>
        <div class="segmented">${[['default', '质体范围'], ['type', '类型范围'], ['none', '不显示']].map(([k, l]) => `<button type="button" data-abyss-bars="${k}" class="${S.bars === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <label class="aby-check"><input type="checkbox" data-abyss-scores${S.scores ? ' checked' : ''}>显示 roll 分数</label>
        <span class="toolbar-spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" data-abyss-reset>清除筛选</button>
      </div>
    </div>
    <div id="abyssList">${listHtml()}</div>
  </section>`;
}
function listHtml() {
  if (S.error && !S.items.length) return `<div class="empty-state"><p>读取失败：${esc(S.error)}</p><button class="btn btn-sm" data-abyss-retry>重试</button></div>`;
  if (!S.items.length) return S.loading ? '<div class="pi-loading">读取在售装备…</div>' : '<div class="empty-state"><p>没有符合条件的在售装备</p></div>';
  return `<div class="aby-count text-muted">已显示 ${S.items.length} 件 · 点卡片看详情 · 数据来自 <a href="https://mutamarket.com" target="_blank" rel="noopener">MutaMarket</a>，每 5 分钟更新</div>
    <div class="aby-grid">${S.items.map((m) => cardHtml(m)).join('')}</div>
    ${S.cursor ? `<div class="aby-more"><button class="btn" data-abyss-more ${S.loading ? 'disabled' : ''}>${S.loading ? '读取中…' : '加载更多'}</button></div>` : ''}
    ${S.error ? `<p class="down">${esc(S.error)}</p>` : ''}`;
}
async function fetchList(more) {
  const seq = ++S.seq;
  S.loading = true; S.error = '';
  if (!more) { S.items = []; S.cursor = null; }
  if ($('abyssList')) $('abyssList').innerHTML = listHtml();
  const q = new URLSearchParams(S.query);
  q.set('type', S.type);
  if (!q.get('sort')) { q.set('sort', 'date-added'); q.set('order', 'desc'); }
  if (more && S.cursor) q.set('cursor', S.cursor);
  try {
    const r = await api('list?' + q);
    if (seq !== S.seq) return;
    S.items = more ? [...S.items, ...r.items] : r.items;
    S.cursor = r.next_cursor;
    await names([...r.items.map((m) => m.source_type?.id), ...r.items.map((m) => m.mutaplasmid?.id)]);
  } catch (e) {
    if (seq !== S.seq) return;
    S.error = e.message;
  }
  if (seq !== S.seq) return;
  S.loading = false;
  if (S.view === 'market' && $('abyssList')) $('abyssList').innerHTML = listHtml();
}
// 筛选改动：更新地址栏（可收藏分享）并重新查询
function setQuery(mut) {
  const q = new URLSearchParams(S.query);
  mut(q);
  for (const [k, v] of [...q]) if (!v) q.delete(k);
  go(marketHash(S.type, q), true);
}
function setFlag(q, flag, on, group = []) {
  const set = new Set((q.get('flags') || '').split(',').filter(Boolean));
  for (const g of group) set.delete(g);
  if (on) set.add(flag); else set.delete(flag);
  q.set('flags', [...set].join(','));
}

// ---------- 装备详情 ----------
async function openItem(id) {
  S.item = S.items.find((m) => m.item_id === id) || null;
  render();
  try {
    const m = await api('modules/' + id);
    if (S.view !== 'item') return;
    S.item = m;
  } catch (e) {
    if (S.view !== 'item') return;
    if (!S.item) {
      renderSide();
      $('abyssMain').innerHTML = `<div class="empty-state"><p>${e.status === 404 ? 'MutaMarket 还没有收录这件装备。可以在「物品链接估价」粘贴它的游戏物品链接，查询后会自动收录。' : '读取失败：' + esc(e.message)}</p></div>`;
      return;
    }
  }
  await names([S.item.source_type?.id, S.item.mutaplasmid?.id, S.item.type_id]);
  if (S.view === 'item') render();
}
function confidenceRow(model) {
  if (!model || model.r2 == null) return '<div class="aby-kv"><span>估价模型</span><b>暂无（该类型成交不足 50 笔）</b></div>';
  return `<div class="aby-kv"><span>±</span><b>${Math.round(model.nmae)}%<small>该类型平均误差</small></b></div>
    <div class="aby-kv"><span>可信度</span><b>${A.confidence(model.r2)}<small>R² ${model.r2.toFixed(3)}</small></b></div>
    <div class="aby-kv"><span>平均绝对误差</span><b>${ctx.formatISK(model.mae)} ISK</b></div>
    <div class="aby-kv"><span>训练样本</span><b>${ctx.formatNumber(model.data_count)} 笔成交</b></div>
    <div class="aby-kv"><span>模型训练于</span><b>${A.fmtTime(model.last_trained_at)}</b></div>`;
}
function renderItem() {
  const main = $('abyssMain');
  const m = S.item;
  if (!m) { main.innerHTML = '<div class="pi-loading">读取装备…</div>'; return; }
  const t = D.byId.get(m.type_id);
  const c = m.contract;
  const model = m.model || t?.model;
  const link = `<url=showinfo:${m.type_id}//${m.item_id}>${nameOf(m.type_id, m.type_name)}</url>`;
  const ranges = new Map((t?.attributes || []).map((a) => [a.id, a]));
  const rows = shownAttrs(m).map((a) => {
    const r = ranges.get(a.id), u = unitOf(a);
    const f = a.fraction;
    const cls = BARS[a.bar]?.[0] || (f == null || Math.abs(f) < 1e-6 ? '' : f > 0 ? 'up' : 'down');
    return `<tr><td><label class="aby-check"><input type="checkbox" data-abyss-sim="${a.id}"${a.is_derived ? '' : ' checked'}>${esc(attrName(a))}${a.is_derived ? '<em>推算</em>' : ''}</label></td>
      <td class="num">${esc(fmtVal(a, a.base_value))}</td><td class="num"><b class="${cls}">${esc(fmtVal(a, a.value))}</b></td><td class="num ${cls}">${esc(fmtDelta(a))}</td>
      <td class="num">${f == null ? '—' : (f > 0 ? '+' : '') + Math.round(f * 100)}</td>
      <td class="num text-muted">${r ? `${num(toShow(r.worst, u))} ~ ${num(toShow(r.best, u))}` : '—'}</td></tr>`;
  }).join('');
  main.innerHTML = `<section class="pi-page aby-page">
    <div class="pi-head aby-head"><button class="btn btn-ghost btn-sm" data-abyss-back>← ${esc(nameOf(m.type_id, m.type_name))}</button><span class="toolbar-spacer"></span>
      <a class="btn btn-ghost btn-sm" href="${esc(m.source_url || 'https://mutamarket.com')}" target="_blank" rel="noopener">MutaMarket 原站</a></div>
    <div class="aby-detail">
      ${cardHtml(m, true)}
      <div class="pi-card aby-panel">
        <div class="aby-big"><span>模型估价</span><b data-abyss-copy="${m.estimated_value ? Math.round(m.estimated_value) : ''}" title="点击复制">${m.estimated_value ? ctx.formatISK(m.estimated_value) + ' ISK' : '暂无估价'}</b>
          <small>${m.estimated_value_updated_at ? '估于 ' + A.fmtTime(m.estimated_value_updated_at) : ''}</small></div>
        ${confidenceRow(model)}
        ${c ? `<div class="aby-kv"><span>${c.type === 'auction' ? '拍卖合同' : '交换合同'}</span><b>${c.price ? ctx.formatISK(c.price) + ' ISK' : '—'}${(c.abyssal_modules_count || 1) - 1 + (c.non_abyssal_modules_count || 0) > 0 ? `<small>合同里还有 ${(c.abyssal_modules_count || 1) - 1 + (c.non_abyssal_modules_count || 0)} 件其它物品</small>` : ''}</b></div>
          <div class="aby-kv"><span>发布人</span><b>${esc(c.issuer?.name || '—')}<small>${c.date_issued ? A.fmtTime(c.date_issued) + ' 发布' : ''}${c.date_expired ? ' · ' + A.fmtTime(c.date_expired) + ' 到期' : ''}</small></b></div>` : `<div class="aby-kv"><span>合同</span><b>${m.listed ? '卖家在 MutaMarket 直接挂售' : '目前不在公开合同上'}</b></div>`}
        ${m.creator ? `<div class="aby-kv"><span>制作者</span><b>${esc(m.creator.name)}</b></div>` : ''}
        <div class="aby-actions">
          <button class="btn btn-primary btn-sm" data-abyss-refresh>刷新估价</button>
          <button class="btn btn-sm" data-abyss-link="${esc(link)}">复制物品链接</button>
          ${c ? `<button class="btn btn-sm" data-abyss-contract="${c.id}">在游戏里打开合同</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-abyss-esi>ESI 原始属性</button>
        </div>
        <p class="text-muted aby-note">模型估价按真实单件合同成交价训练，可能偏差很大：先看下面相似装备实际挂多少。「刷新估价」会让 MutaMarket 从 ESI 重新读取这件装备。</p>
      </div>
    </div>
    <div class="pi-card aby-sim">
      <div class="pi-card-head"><h3>属性明细</h3><span class="text-muted">勾选属性后可搜索相似装备；roll 分数为在本突变质体范围中的位置（-100 最差 … 0 原值 … 100 最好）</span></div>
      <div class="table-scroll"><table class="pc-mini-table aby-table"><thead><tr><th>属性</th><th class="num">原装备</th><th class="num">突变后</th><th class="num">变化</th><th class="num">roll 分数</th><th class="num">该类型范围（最差 ~ 最好）</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="aby-actions aby-sim-bar">
        <label><span class="text-muted">允许偏差</span><select class="input" id="abyssTol">${[5, 10, 20, 30].map((v) => `<option value="${v}"${v === 10 ? ' selected' : ''}>±${v}%</option>`).join('')}</select></label>
        <button class="btn btn-sm" data-abyss-similar="price:asc">搜索最便宜的相似装备</button>
        <button class="btn btn-sm" data-abyss-similar="value:desc">搜索相似装备</button>
        <button class="btn btn-ghost btn-sm" data-abyss-type="${m.type_id}">搜索该类型</button>
      </div>
    </div>
    <div class="pi-card"><div class="pi-card-head"><h3>与各原装备对比</h3><span class="text-muted">这个突变质体能用在哪些装备上、它们的原始属性和吉他价格——看这件 roll 是否比直接买势力 / 官员装备划算</span></div>
      <div id="abyssSources"><div class="pi-loading">读取原装备…</div></div></div>
  </section>`;
  renderSources(m);
}
// 原装备对比：突变质体可用的全部原装备的属性（ESI）与吉他价格
async function renderSources(m) {
  const box = $('abyssSources');
  try {
    const raw = await loadMuta();
    const mu = raw.muta.find((x) => x[0] === m.mutaplasmid?.id);
    if (!mu) { box.innerHTML = '<p class="text-muted">本地没有这个突变质体的数据。</p>'; return; }
    const bases = mu[4];
    const [types, prices] = await Promise.all([
      Promise.all(bases.map((id) => ctx.fetchESI(`/universe/types/${id}/`).catch(() => null))),
      ctx.getHubPrices(bases).catch(() => new Map()),
      names(bases)
    ]);
    if (!box.isConnected) return;
    const attrs = shownAttrs(m).filter((a) => !a.is_derived);
    const rows = bases.map((id, i) => {
      const dogma = new Map((types[i]?.dogma_attributes || []).map((x) => [x.attribute_id, x.value]));
      const p = prices.get(id);
      const cells = attrs.map((a) => {
        const v = dogma.get(a.id);
        if (v == null) return '<td class="num">—</td>';
        // 这件的值比该原装备好还是差（按 SDE 的数值越大越好）
        const good = D.dogma.attrs[a.id]?.[2];
        const better = good ? a.value > v : a.value < v;
        const same = Math.abs(a.value - v) < 1e-9;
        return `<td class="num"><span class="${same ? '' : better ? 'up' : 'down'}" title="${same ? '与这件相同' : better ? '这件更好' : '这件更差'}">${esc(fmtVal(a, v))}</span></td>`;
      }).join('');
      return `<tr class="${id === m.source_type?.id ? 'active' : ''}"><td><div class="aby-src"><img src="${ICON(id, 32)}" alt="" width="20" height="20" loading="lazy">${esc(nameOf(id))}${id === m.source_type?.id ? '<em>本件原型</em>' : ''}</div></td>${cells}
        <td class="num">${p?.sell != null ? ctx.formatISK(p.sell) : '<span class="text-muted">无卖单</span>'}</td></tr>`;
    }).join('');
    box.innerHTML = `<div class="table-scroll"><table class="pc-mini-table aby-table"><thead><tr><th>原装备</th>${attrs.map((a) => `<th class="num">${esc(attrName(a))}</th>`).join('')}<th class="num">吉他最低卖价</th></tr></thead>
      <tbody><tr class="aby-self"><td><b>这件突变装备</b></td>${attrs.map((a) => `<td class="num"><b>${esc(fmtVal(a, a.value))}</b></td>`).join('')}<td class="num">${m.estimated_value ? '估 ' + ctx.formatISK(m.estimated_value) : '—'}</td></tr>${rows}</tbody></table></div>
      <p class="text-muted aby-note">绿色表示这件突变装备在该属性上比那件原装备好，红色表示更差。</p>`;
  } catch (e) {
    if (box.isConnected) box.innerHTML = `<p class="text-muted">原装备读取失败：${esc(e.message)}</p>`;
  }
}
// 相似装备：勾选的属性按「当前值 ± 该类型范围 × 偏差」作为筛选条件
function searchSimilar(sortOrder) {
  const m = S.item, t = D.byId.get(m.type_id);
  const tol = Number($('abyssTol')?.value || 10) / 100;
  const picked = [...document.querySelectorAll('[data-abyss-sim]:checked')].map((el) => Number(el.dataset.abyssSim));
  const ranges = new Map((t?.attributes || []).map((a) => [a.id, a]));
  const parts = [];
  for (const id of picked) {
    const a = m.attributes.find((x) => x.id === id), r = ranges.get(id);
    if (!a) continue;
    const span = r ? Math.abs(r.best - r.worst) : Math.abs(a.value) * 0.2;
    const d = span * tol;
    parts.push(`${id}:${+(a.value - d).toPrecision(8)}~${+(a.value + d).toPrecision(8)}`);
  }
  const [sort, order] = sortOrder.split(':');
  const q = new URLSearchParams({ sort, order });
  if (sort === 'price') q.set('flags', 'contracts-only');
  if (parts.length) q.set('attrs', parts.join(','));
  go(marketHash(m.type_id, q));
}
async function refreshItem() {
  const m = S.item;
  const btn = document.querySelector('[data-abyss-refresh]');
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
  try {
    S.item = await api('appraise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type_id: m.type_id, item_id: m.item_id, server: SERVER.id }) });
    ctx.showToast('估价已刷新', 'success');
  } catch (e) {
    ctx.showToast('刷新失败：' + e.message, 'error', 4000);
  }
  if (S.view === 'item') renderItem();
}

// ---------- 物品链接估价 ----------
function renderAppraise(main) {
  main.innerHTML = `<section class="pi-page aby-page">
    <div class="pi-head"><h2>物品链接估价</h2><span class="text-muted">游戏里把深渊装备拖进聊天框，复制后粘贴到这里（一次可以多件）</span></div>
    <div class="pi-card aby-paste"><textarea id="abyssPaste" class="ap-input" spellcheck="false" placeholder="<url=showinfo:48439//1056160153322>大型深渊电容器电池</url>"></textarea>
      <div class="aby-actions"><button class="btn btn-primary" data-abyss-appraise>查询</button><span class="text-muted">也可以在「估价」页和普通物品一起粘贴</span></div></div>
    <div id="abyssPasteResult"></div></section>`;
  const input = $('abyssPaste');
  input.value = S.paste || '';
  if (S.paste) A.mountList($('abyssPasteResult'), A.parseLinks(S.paste));
  input.addEventListener('paste', () => setTimeout(runAppraise, 0));
}
function runAppraise() {
  const text = $('abyssPaste').value;
  S.paste = text;
  const links = A.parseLinks(text);
  const out = $('abyssPasteResult');
  if (!links.length) { out.innerHTML = '<div class="empty-state"><p>没有找到物品链接（形如 showinfo:类型ID//物品ID）</p></div>'; return; }
  A.mountList(out, links);
}

// ---------- 价格模型统计 ----------
function statsHtml() {
  const rows = D.types.slice().sort((a, b) => (b.model?.data_count || 0) - (a.model?.data_count || 0)).map((t) => {
    const m = t.model;
    const ok = m && m.r2 != null;
    return `<tr data-abyss-type="${t.id}"><td><div class="aby-src"><img src="${ICON(t.id, 32)}" alt="" width="20" height="20" loading="lazy">${esc(nameOf(t.id, t.name))}</div></td>
      <td>${t.cat}</td><td class="num">${m ? ctx.formatNumber(m.data_count || 0) : '—'}</td>
      <td class="num">${ok ? A.confidence(m.r2) : '<span class="text-muted">暂无模型</span>'}</td><td class="num">${ok ? m.r2.toFixed(3) : '—'}</td>
      <td class="num">${ok ? Math.round(m.nmae) + '%' : '—'}</td><td class="num">${ok ? ctx.formatISK(m.mae) : '—'}</td><td class="num">${ok ? A.fmtTime(m.last_trained_at) : '—'}</td></tr>`;
  }).join('');
  const withModel = D.types.filter((t) => t.model?.r2 != null).length;
  return `<section class="pi-page aby-page">
    <div class="pi-head"><h2>价格模型统计</h2><span class="text-muted">${D.types.length} 种深渊装备，${withModel} 种有估价模型</span></div>
    <div class="pi-card"><p class="text-muted aby-note" style="margin:0 0 10px">MutaMarket 为每种深渊装备单独训练随机森林模型：输入是突变属性，标签是真实的单件合同成交价，至少 50 笔成交才训练。
      R² 是该类型整体拟合度（不是某件装备卖出该价的概率），平均误差（NMAE）是该类型预测的平均偏差比例。点一行查看该类型在售装备。</p>
      <div class="table-scroll"><table class="pc-mini-table aby-table aby-stats"><thead><tr><th>深渊装备</th><th>分类</th><th class="num">成交样本</th><th class="num">可信度</th><th class="num">R²</th><th class="num">平均误差</th><th class="num">平均绝对误差</th><th class="num">训练时间</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
}

// ---------- 事件 ----------
function bind() {
  const view = $('abyssView');
  $('abyssSearch').addEventListener('input', (e) => { S.search = e.target.value; renderSide(); });
  view.addEventListener('click', (e) => {
    const t = e.target;
    const nav = t.closest('[data-abyss-nav]');
    if (nav) { const k = nav.dataset.abyssNav; go(k === 'market' ? marketHash() : '#abyss/' + k); ctx.closeDrawer(); return; }
    const type = t.closest('[data-abyss-type]');
    if (type) { go(marketHash(Number(type.dataset.abyssType), new URLSearchParams())); ctx.closeDrawer(); return; }
    const item = t.closest('[data-abyss-item]');
    if (item) { go('#abyss/m/' + item.dataset.abyssItem); $('abyssMain').closest('.kb-scroll')?.scrollTo(0, 0); return; }
    if (t.closest('[data-abyss-more]')) { fetchList(true); return; }
    if (t.closest('[data-abyss-retry]')) { fetchList(false); return; }
    if (t.closest('[data-abyss-reset]')) { go(marketHash(S.type, new URLSearchParams()), true); return; }
    const bars = t.closest('[data-abyss-bars]');
    if (bars) { S.bars = bars.dataset.abyssBars; save(); $('abyssMain').innerHTML = marketHtml(); return; }
    if (t.closest('[data-abyss-back]')) { if (history.length > 1 && S.items.length) history.back(); else go(marketHash(S.item.type_id, new URLSearchParams())); return; }
    if (t.closest('[data-abyss-refresh]')) { refreshItem(); return; }
    const copy = t.closest('[data-abyss-copy]');
    if (copy && copy.dataset.abyssCopy) { ctx.copyText(copy.dataset.abyssCopy); return; }
    const link = t.closest('[data-abyss-link]');
    if (link) { ctx.copyText(link.dataset.abyssLink); return; }
    const ct = t.closest('[data-abyss-contract]');
    if (ct) { ctx.game.contract(Number(ct.dataset.abyssContract)); return; }
    if (t.closest('[data-abyss-esi]')) { ctx.openDynamicItem(S.item.type_id, S.item.item_id); return; }
    const sim = t.closest('[data-abyss-similar]');
    if (sim) { searchSimilar(sim.dataset.abyssSimilar); return; }
    if (t.closest('[data-abyss-appraise]')) { runAppraise(); return; }
  });
  view.addEventListener('keydown', (e) => {
    const item = e.target.closest?.('[data-abyss-item]');
    if (item && e.key === 'Enter') go('#abyss/m/' + item.dataset.abyssItem);
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-abyss-scores]')) { S.scores = t.checked; save(); $('abyssMain').innerHTML = marketHtml(); return; }
    if (t.matches('[data-abyss-q]')) {
      const k = t.dataset.abyssQ, v = t.value;
      setQuery((q) => {
        // 按价格排序时只看游戏合同：直接挂在 MutaMarket 上的多数没有标价，会全部排在最前
        if (k === 'sort') { const [s, o] = v.split(':'); q.set('sort', s); q.set('order', o); if (s === 'price') setFlag(q, 'contracts-only', true); }
        else if (k === 'contract') setFlag(q, v, Boolean(v), ['item-exchange', 'auction']);
        else if (k === 'bar') setFlag(q, v, Boolean(v), ['goldbar', 'diamondbar', 'brownbar']);
        else q.set(k, v);
      });
      return;
    }
    if (t.matches('[data-abyss-flag]')) { setQuery((q) => setFlag(q, t.dataset.abyssFlag, t.checked)); return; }
    if (t.matches('[data-abyss-range]')) {
      const key = t.dataset.abyssRange;
      const els = [...document.querySelectorAll(`[data-abyss-range="${key}"]`)];
      const [lo, hi] = els.map((el) => (el.value === '' ? '' : String(Math.round(Number(el.value) * 1e6))));
      setQuery((q) => q.set(key, lo || hi ? `${lo}-${hi}` : ''));
      return;
    }
    if (t.matches('[data-abyss-attr]')) {
      const id = Number(t.dataset.abyssAttr);
      const a = D.byId.get(S.type).attributes.find((x) => x.id === id);
      const u = unitOf(a);
      const els = [...document.querySelectorAll(`[data-abyss-attr="${id}"]`)];
      // 显示值 → 原始值；倒数类单位换算后大小反过来
      const vals = els.map((el) => (el.value === '' ? null : fromShow(Number(el.value), u)));
      let [lo, hi] = vals;
      if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
      else if ([108, 111].includes(u)) [lo, hi] = [hi, lo];
      const af = attrFilters();
      if (lo == null && hi == null) af.delete(id); else af.set(id, [lo, hi]);
      setQuery((q) => q.set('attrs', [...af].map(([k, [l, h]]) => `${k}:${l == null ? '' : +l.toPrecision(8)}~${h == null ? '' : +h.toPrecision(8)}`).join(',')));
    }
  });
}
