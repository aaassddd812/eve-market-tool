// ===== 个人中心 · 交易记录与盈亏 =====
// 数据（都需要已有的授权，不用重新绑定）：
//   /characters/{id}/wallet/transactions/  成交明细（esi-wallet.read_character_wallet.v1，ESI 只给最近约 30 天、最多 2500 条）
//   /characters/{id}/wallet/journal/       钱包流水，统计实际缴纳的销售税（transaction_tax）与中介费（brokers_fee）
//   /characters/{id}/orders/history/       90 天内已结束的订单：过期 / 取消 / 全部成交（esi-markets.read_character_orders.v1）
// 物品盈亏按成交均价配对：配对数量 = min(买入量, 卖出量)，配对利润 = 配对数量 × (卖出均价 − 买入均价)；
// 净利润再减去同期实际缴纳的税费。只买没卖（囤货）或只卖没买（卖资产）的部分不计入配对利润。

let ctx;   // esc, formatISK, formatPrice, formatNumber, esiAuthFetch, esiAuthFetchPaged, resolveTypeNames, resolveNames,
           // resolveStructureNames, locationName, gameImage, valuationCard, tokenInfo, hasScope, selectItem, isActive
const S = { id: null, data: null, loading: null, view: 'items', q: '', sort: 'profit', dir: 'desc' };   // 点表头排序，同一列再点换方向
const ROW_LIMIT = 300;
const ORDER_STATE_ZH = { expired: '已过期', cancelled: '已取消' };

export function initTrades(context) {
  ctx = context;
  window.addEventListener('eve-account-change', () => { S.id = null; S.data = null; });
}

async function load(force) {
  const token = ctx.tokenInfo();
  const id = token.character_id;
  if (!force && S.id === id && S.data) return S.data;
  if (!force && S.id === id && S.loading) return S.loading;
  S.id = id;
  S.data = null;
  const loading = (async () => {
    const orderScope = ctx.hasScope('esi-markets.read_character_orders.v1');
    const [tx, journal, history] = await Promise.all([
      ctx.esiAuthFetch('/characters/' + id + '/wallet/transactions/'),
      ctx.esiAuthFetchPaged('/characters/' + id + '/wallet/journal/', 10).catch(() => []),
      orderScope ? ctx.esiAuthFetchPaged('/characters/' + id + '/orders/history/', 10).catch(() => []) : Promise.resolve([])
    ]);
    const transactions = (Array.isArray(tx) ? tx : []).sort((a, b) => new Date(b.date) - new Date(a.date));
    const orders = (Array.isArray(history) ? history : []).sort((a, b) => new Date(b.issued) - new Date(a.issued));
    const types = await ctx.resolveTypeNames([...transactions.map((t) => t.type_id), ...orders.map((o) => o.type_id)]);
    const clients = await ctx.resolveNames(transactions.map((t) => t.client_id)).catch(() => ({ names: new Map() }));
    await ctx.resolveStructureNames([...transactions.map((t) => t.location_id), ...orders.map((o) => o.location_id)]).catch(() => {});
    return { transactions, journal: Array.isArray(journal) ? journal : [], orders, types, clients: clients.names, orderScope };
  })();
  S.loading = loading;
  try {
    const data = await loading;
    if (S.loading === loading) S.data = data;
    return data;
  } finally {
    if (S.loading === loading) S.loading = null;
  }
}

// 按物品汇总买卖
function summarize(data) {
  const byType = new Map();
  let buyIsk = 0, sellIsk = 0, buyN = 0, sellN = 0;
  for (const t of data.transactions) {
    if (!byType.has(t.type_id)) byType.set(t.type_id, { id: t.type_id, buyQty: 0, buyIsk: 0, sellQty: 0, sellIsk: 0, last: t.date });
    const r = byType.get(t.type_id);
    const isk = t.quantity * t.unit_price;
    if (t.is_buy) { r.buyQty += t.quantity; r.buyIsk += isk; buyIsk += isk; buyN += 1; }
    else { r.sellQty += t.quantity; r.sellIsk += isk; sellIsk += isk; sellN += 1; }
  }
  for (const r of byType.values()) {
    r.avgBuy = r.buyQty ? r.buyIsk / r.buyQty : null;
    r.avgSell = r.sellQty ? r.sellIsk / r.sellQty : null;
    r.matched = Math.min(r.buyQty, r.sellQty);
    r.profit = r.matched ? r.matched * (r.avgSell - r.avgBuy) : null;
    r.margin = r.matched && r.avgBuy ? (r.avgSell - r.avgBuy) / r.avgBuy : null;
  }
  // 税费只统计成交记录覆盖的时间段
  const since = data.transactions.length ? new Date(data.transactions[data.transactions.length - 1].date).getTime() : Date.now();
  let tax = 0, broker = 0;
  for (const j of data.journal) {
    if (new Date(j.date).getTime() < since - 60e3) continue;
    if (j.ref_type === 'transaction_tax') tax += Math.abs(j.amount || 0);
    else if (j.ref_type === 'brokers_fee') broker += Math.abs(j.amount || 0);
  }
  const items = [...byType.values()];
  const profit = items.reduce((t, r) => t + (r.profit || 0), 0);
  return { items, buyIsk, sellIsk, buyN, sellN, tax, broker, profit, since };
}

const typeName = (data, id) => data.types.get(Number(id)) || 'Type ' + id;
const fmtTime = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const signed = (v) => `<strong class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${ctx.formatISK(v)}</strong>`;

function itemCell(data, id) {
  const { esc, gameImage } = ctx;
  return `<button class="link-btn trade-item" data-trade-type="${id}" title="在市场中心查看"><img src="${gameImage('types/' + id + '/icon', 32)}" data-item-pop="${id}" alt="" width="20" height="20" loading="lazy">${esc(typeName(data, id))}</button>`;
}

function itemsTable(data, sum) {
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  // 各列取值；null（只买入 / 只卖出没有利润）不论方向都排最后
  const getters = {
    name: (r) => typeName(data, r.id),
    buy: (r) => r.buyQty ? r.buyQty * r.avgBuy : null,
    sell: (r) => r.sellQty ? r.sellQty * r.avgSell : null,
    profit: (r) => r.profit,
    margin: (r) => r.margin,
    volume: (r) => r.buyIsk + r.sellIsk,
    recent: (r) => new Date(r.last).getTime()
  };
  const get = getters[S.sort] || getters.profit;
  const sign = S.dir === 'asc' ? 1 : -1;
  const q = S.q.toLowerCase();
  const list = sum.items.filter((r) => !q || typeName(data, r.id).toLowerCase().includes(q)).sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'zh') : x - y) * sign;
  });
  if (!list.length) return '<p class="text-muted">没有匹配的物品</p>';
  const th = (key, label) => {
    const on = S.sort === key;
    return `<th class="sortable${on ? ' sorted' : ''}" data-trade-sort="${key}" data-dir="${on ? S.dir : ''}" aria-sort="${on ? (S.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}</th>`;
  };
  return `<div class="table-scroll"><table class="pc-mini-table trade-table"><thead><tr>
      ${th('name', '物品')}${th('buy', '买入')}${th('sell', '卖出')}${th('profit', '配对利润')}${th('margin', '毛利率')}${th('volume', '成交额')}${th('recent', '最近成交')}
    </tr></thead><tbody>${list.slice(0, ROW_LIMIT).map((r) => `<tr>
      <td>${itemCell(data, r.id)}</td>
      <td>${r.buyQty ? formatNumber(r.buyQty) + ' × ' + formatPrice(r.avgBuy) : '<span class="muted-cell">—</span>'}</td>
      <td>${r.sellQty ? formatNumber(r.sellQty) + ' × ' + formatPrice(r.avgSell) : '<span class="muted-cell">—</span>'}</td>
      <td>${r.profit == null ? '<span class="muted-cell">' + (r.buyQty ? '只买入' : '只卖出') + '</span>' : signed(r.profit) + (r.matched < Math.max(r.buyQty, r.sellQty) ? `<span class="cell-sub">配对 ${formatNumber(r.matched)} 件</span>` : '')}</td>
      <td>${r.margin == null ? '<span class="muted-cell">—</span>' : `<span class="${r.margin >= 0 ? 'up' : 'down'}">${(r.margin * 100).toFixed(1)}%</span>`}</td>
      <td>${formatISK(r.buyIsk + r.sellIsk)}</td>
      <td>${esc(fmtTime(r.last))}</td></tr>`).join('')}</tbody></table></div>` +
    (list.length > ROW_LIMIT ? `<p class="text-muted valuation-note">只显示前 ${ROW_LIMIT} 种（共 ${list.length} 种）</p>` : '');
}

function txTable(data) {
  const { esc, formatISK, formatPrice, formatNumber, locationName } = ctx;
  const q = S.q.toLowerCase();
  const list = data.transactions.filter((t) => !q || typeName(data, t.type_id).toLowerCase().includes(q));
  if (!list.length) return '<p class="text-muted">没有成交记录</p>';
  return `<div class="table-scroll"><table class="pc-mini-table trade-table"><thead><tr>
      <th>时间</th><th>物品</th><th>方向</th><th>数量</th><th>单价</th><th>金额</th><th>地点</th><th>对方</th>
    </tr></thead><tbody>${list.slice(0, ROW_LIMIT).map((t) => `<tr>
      <td>${esc(fmtTime(t.date))}</td>
      <td>${itemCell(data, t.type_id)}</td>
      <td>${t.is_buy ? '<span class="pill buy">买入</span>' : '<span class="pill sell">卖出</span>'}</td>
      <td>${formatNumber(t.quantity)}</td>
      <td>${formatPrice(t.unit_price)}</td>
      <td><strong class="${t.is_buy ? 'down' : 'up'}">${t.is_buy ? '−' : '+'}${formatISK(t.quantity * t.unit_price)}</strong></td>
      <td class="trade-loc">${esc(locationName(t.location_id))}</td>
      <td>${esc(data.clients.get(t.client_id) || ctx.officialName(t.client_id) || '—')}</td></tr>`).join('')}</tbody></table></div>` +
    (list.length > ROW_LIMIT ? `<p class="text-muted valuation-note">只显示最近 ${ROW_LIMIT} 笔（共 ${list.length} 笔）</p>` : '');
}

function ordersTable(data) {
  const { esc, formatPrice, formatNumber, locationName } = ctx;
  if (!data.orderScope) return '<p class="text-muted">无订单权限，需重新绑定 ESI</p>';
  const q = S.q.toLowerCase();
  const list = data.orders.filter((o) => !q || typeName(data, o.type_id).toLowerCase().includes(q));
  if (!list.length) return '<p class="text-muted">90 天内没有已结束的订单</p>';
  return `<div class="table-scroll"><table class="pc-mini-table trade-table"><thead><tr>
      <th>挂单时间</th><th>物品</th><th>方向</th><th>单价</th><th>成交 / 总量</th><th>状态</th><th>地点</th>
    </tr></thead><tbody>${list.slice(0, ROW_LIMIT).map((o) => {
      const filled = o.volume_total - o.volume_remain;
      const state = o.volume_remain === 0 ? '<span class="up">全部成交</span>' : esc(ORDER_STATE_ZH[o.state] || o.state || '—') + (filled ? '<span class="cell-sub">部分成交</span>' : '');
      return `<tr>
      <td>${esc(fmtTime(o.issued))}</td>
      <td>${itemCell(data, o.type_id)}</td>
      <td>${o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>'}</td>
      <td>${formatPrice(o.price)}</td>
      <td>${formatNumber(filled)} / ${formatNumber(o.volume_total)}</td>
      <td>${state}</td>
      <td class="trade-loc">${esc(locationName(o.location_id))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function render(box, data) {
  const { esc, formatISK, formatNumber, valuationCard } = ctx;
  const sum = summarize(data);
  const fees = sum.tax + sum.broker;
  const days = Math.max(1, Math.round((Date.now() - sum.since) / 86400e3));
  const views = [['items', '物品盈亏', sum.items.length], ['tx', '成交明细', data.transactions.length], ['orders', '历史订单', data.orders.length]];
  box.innerHTML =
    '<div class="valuation-grid">' +
      valuationCard('买入总额', formatISK(sum.buyIsk) + ' ISK', formatNumber(sum.buyN) + ' 笔成交', 'is-sell') +
      valuationCard('卖出总额', formatISK(sum.sellIsk) + ' ISK', formatNumber(sum.sellN) + ' 笔成交', 'is-buy') +
      valuationCard('已缴税费', formatISK(fees) + ' ISK', '销售税 ' + formatISK(sum.tax) + ' · 中介费 ' + formatISK(sum.broker)) +
      valuationCard('配对利润', (sum.profit >= 0 ? '' : '−') + formatISK(Math.abs(sum.profit)) + ' ISK', '', sum.profit >= 0 ? 'is-buy' : 'is-sell') +
      valuationCard('扣税费后', (sum.profit - fees >= 0 ? '' : '−') + formatISK(Math.abs(sum.profit - fees)) + ' ISK', '', 'is-total') +
    '</div>' +
    '<div class="valuation-toolbar section-gap">' +
      '<div class="segmented" role="group" aria-label="交易记录视图">' +
        views.map(([key, label, n]) => `<button data-trade-view="${key}" class="${S.view === key ? 'active' : ''}">${label} <span class="seg-count">${n}</span></button>`).join('') +
      '</div>' +
      '<div class="station-filter search-box trade-filter"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
        `<input type="search" data-trade-q placeholder="筛选物品" autocomplete="off" aria-label="筛选物品" value="${esc(S.q)}"></div>` +
      '<span class="toolbar-spacer"></span>' +
      '<button class="btn btn-ghost" data-trade-reload>刷新</button>' +
    '</div>' +
    `<div data-trade-body>${S.view === 'tx' ? txTable(data) : S.view === 'orders' ? ordersTable(data) : itemsTable(data, sum)}</div>` +
    `<p class="text-muted valuation-note" title="ESI 只提供最近约 30 天、最多 2500 条；配对利润按买卖均价，不含库存；税费取钱包流水实缴">最近 ${days} 天 · ${formatNumber(data.transactions.length)} 笔成交</p>`;
}

function bind(box) {
  if (box.dataset.tradesBound) return;
  box.dataset.tradesBound = '1';
  box.addEventListener('click', (e) => {
    if (!ctx.isActive() || !S.data) return;
    const view = e.target.closest('[data-trade-view]');
    if (view) { S.view = view.dataset.tradeView; render(box, S.data); return; }
    const sort = e.target.closest('[data-trade-sort]');
    if (sort) { sortBy(box, sort.dataset.tradeSort); return; }
    const type = e.target.closest('[data-trade-type]');
    if (type) { ctx.selectItem(Number(type.dataset.tradeType)); return; }
    if (e.target.closest('[data-trade-reload]')) renderTrades(box, true);
  });
  box.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-trade-sort]')) { e.preventDefault(); sortBy(box, e.target.dataset.tradeSort); }
  });
  box.addEventListener('input', (e) => {
    if (!ctx.isActive() || !S.data || !e.target.matches('[data-trade-q]')) return;
    S.q = e.target.value.trim();
    const body = box.querySelector('[data-trade-body]');
    const sum = summarize(S.data);
    body.innerHTML = S.view === 'tx' ? txTable(S.data) : S.view === 'orders' ? ordersTable(S.data) : itemsTable(S.data, sum);
  });
}

export async function renderTrades(box, force = false) {
  bind(box);
  if (!ctx.hasScope('esi-wallet.read_character_wallet.v1')) {
    box.innerHTML = '<p class="text-muted" title="esi-wallet.read_character_wallet.v1">无钱包权限，需重新绑定 ESI</p>';
    return;
  }
  if (!S.data || force) box.innerHTML = '<div class="pi-loading">读取中…</div>';
  try {
    const data = await load(force);
    if (ctx.isActive() && ctx.tokenInfo()?.character_id === S.id) render(box, data);
  } catch (error) {
    if (ctx.isActive()) box.innerHTML = '<p class="text-muted">交易记录读取失败：' + ctx.esc(error.message) + '</p>';
  }
}

// 点表头：换列时物品名按升序、其他按降序，同一列再点换方向
function sortBy(box, key) {
  S.dir = S.sort === key ? (S.dir === 'asc' ? 'desc' : 'asc') : (key === 'name' ? 'asc' : 'desc');
  S.sort = key;
  render(box, S.data);
  box.querySelector(`th[data-trade-sort="${key}"]`)?.focus({ preventScroll: true });
}
