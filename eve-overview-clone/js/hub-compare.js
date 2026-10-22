// 市场详情 ·「交易中心比价」：各交易中心（server.js 的 regions）当前最优卖价 / 收价、订单量与星域日均成交，
// 以及跨交易中心倒卖的税后利润（技能、税费与声望设置来自 trade-fees.js，全站共用）。
// 数据：ESI /markets/{region}/orders/（只取交易中心空间站内的订单）与 /markets/{region}/history/（星域 30 天日均），打开标签时才查，缓存 5 分钟。
// 倒卖方式：在 A 直接买最低卖单（不付税费）→ 运到 B 后「卖给收单」（付销售税）或「挂卖单」（付销售税 + 中介费，按 B 当前最低卖价）；
// A = B 时为本地挂收单→挂卖单（买入也付中介费）。可做数量按价格 5% 以内的订单深度与 B 的日均成交（挂单只算 10%）估算，不含运费与风险。
let ctx = null;
const cache = new Map();   // typeId -> { at, promise }
const TTL = 5 * 60e3;
const DEPTH = 0.05;        // 最优价 5% 以内的订单算作可成交深度
const SHARE = 0.1;         // 挂卖单最多按日均成交的 10% 估算
const opts = { mode: 'buy', sort: 'profit' };
try { Object.assign(opts, JSON.parse(localStorage.getItem('eve-hub-compare') || '{}')); } catch { /* 用默认 */ }
const persist = () => { try { localStorage.setItem('eve-hub-compare', JSON.stringify(opts)); } catch { /* 无痕模式 */ } };

export function initHubCompare(context) { ctx = context; }

function load(typeId) {
  const hit = cache.get(typeId);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = Promise.all(ctx.regions.map(async (r) => {
    const [orders, history] = await Promise.all([
      ctx.fetchESIPaged(`/markets/${r.id}/orders/?order_type=all&type_id=${typeId}`).catch(() => null),
      ctx.fetchESI(`/markets/${r.id}/history/?type_id=${typeId}`).catch(() => null)
    ]);
    const hub = (orders || []).filter((o) => o.location_id === r.hub.id);
    const sells = hub.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
    const buys = hub.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
    const sell = sells[0]?.price ?? null, buy = buys[0]?.price ?? null;
    const recent = Array.isArray(history) ? history.slice(-30) : [];
    const days = recent.length ? (Date.now() - new Date(recent[0].date)) / 86400e3 : 0;
    const vol = recent.reduce((s, d) => s + d.volume, 0);
    return {
      region: r, failed: !orders, sell, buy,
      sellQty: sells.reduce((s, o) => s + o.volume_remain, 0),
      buyQty: buys.reduce((s, o) => s + o.volume_remain, 0),
      sellDepth: sell == null ? 0 : sells.filter((o) => o.price <= sell * (1 + DEPTH)).reduce((s, o) => s + o.volume_remain, 0),
      buyDepth: buy == null ? 0 : buys.filter((o) => o.price >= buy * (1 - DEPTH) && (o.min_volume || 1) <= 1).reduce((s, o) => s + o.volume_remain, 0),
      daily: days ? vol / Math.max(30, Math.min(days, 30)) : 0,   // 没成交的日子 ESI 不返回，按 30 天平均
      avg: recent.length ? recent.reduce((s, d) => s + d.average * d.volume, 0) / (vol || 1) : null
    };
  }));
  cache.set(typeId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(typeId));
  return promise;
}

function routes(hubs) {
  const f = ctx.TF.fees();
  const out = [];
  for (const a of hubs) {
    for (const b of hubs) {
      if (a === b) {
        if (a.buy == null || a.sell == null) continue;
        const cost = a.buy * (1 + f.broker);
        const unit = ctx.TF.flipProfit(a.buy, a.sell);
        out.push({ a, b, local: true, buyAt: a.buy, sellAt: a.sell, cost, unit, qty: Math.floor(a.daily * SHARE) });
        continue;
      }
      if (a.sell == null) continue;
      const instant = opts.mode === 'buy';
      const sellAt = instant ? b.buy : b.sell;
      if (sellAt == null) continue;
      const unit = sellAt * (1 - f.sales - (instant ? 0 : f.broker)) - a.sell;
      const cap = instant ? b.buyDepth : Math.floor(b.daily * SHARE);
      out.push({ a, b, buyAt: a.sell, sellAt, cost: a.sell, unit, qty: Math.min(a.sellDepth, cap) });
    }
  }
  for (const r of out) { r.margin = r.cost ? r.unit / r.cost : 0; r.total = r.unit > 0 ? r.unit * r.qty : 0; }
  const key = { profit: (r) => r.total, margin: (r) => r.margin, unit: (r) => r.unit }[opts.sort] || ((r) => r.total);
  return out.sort((x, y) => key(y) - key(x) || y.margin - x.margin);
}

function html(hubs) {
  const { esc, formatISK, formatPrice, formatNumber, TF } = ctx;
  const f = TF.fees();
  const live = hubs.filter((h) => !h.failed);
  const minSell = Math.min(...live.map((h) => h.sell ?? Infinity));
  const maxBuy = Math.max(...live.map((h) => h.buy ?? -Infinity));
  const name = (h) => esc(h.region.hub.name.split(' ')[0].replace(/海\d+$/, '') || h.region.name);
  const num = (v) => v == null ? '<span class="muted-cell">—</span>' : formatPrice(v);
  const hubRows = hubs.map((h) => `<tr>
      <td><b>${name(h)}</b><small class="hc-sub">${esc(h.region.name)}</small></td>
      ${h.failed ? '<td colspan="6" class="muted-cell">ESI 读取失败</td>' : `
      <td class="num ${h.sell != null && h.sell === minSell ? 'hc-best down' : ''}">${num(h.sell)}</td>
      <td class="num">${h.sellQty ? formatNumber(h.sellQty) : '—'}</td>
      <td class="num ${h.buy != null && h.buy === maxBuy ? 'hc-best up' : ''}">${num(h.buy)}</td>
      <td class="num">${h.buyQty ? formatNumber(h.buyQty) : '—'}</td>
      <td class="num">${h.daily ? formatNumber(Math.round(h.daily)) : '—'}</td>
      <td class="num">${h.daily && h.avg ? formatISK(h.daily * h.avg) : '—'}</td>`}</tr>`).join('');
  const list = routes(live);
  const pos = list.filter((r) => r.unit > 0);
  const routeRows = list.slice(0, 20).map((r) => `<tr class="${r.unit > 0 ? '' : 'hc-loss'}">
      <td>${r.local ? `${name(r.a)} <small class="hc-sub">本地 · 挂收单→挂卖单</small>` : `${name(r.a)} <span class="hc-arrow">→</span> ${name(r.b)}`}</td>
      <td class="num">${formatPrice(r.buyAt)}</td>
      <td class="num">${formatPrice(r.sellAt)}</td>
      <td class="num ${r.unit > 0 ? 'up' : 'down'}">${(r.unit > 0 ? '+' : '') + formatPrice(r.unit)}</td>
      <td class="num ${r.unit > 0 ? 'up' : 'down'}">${(r.margin * 100).toFixed(1)}%</td>
      <td class="num">${r.qty ? formatNumber(r.qty) : '—'}</td>
      <td class="num">${r.total ? formatISK(r.total) : '—'}</td></tr>`).join('');
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-hc-${k}="${v}" class="${opts[k] === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="hc-wrap">
    <div class="hc-head"><h3>交易中心行情</h3><span class="toolbar-spacer"></span>
      <button class="btn btn-ghost btn-sm" data-hc-fees title="调整技能与税费">${esc(TF.summary())}</button>
      <button class="btn btn-ghost btn-sm" data-hc-reload>刷新</button></div>
    <div class="table-scroll"><table class="pc-mini-table hc-table"><thead><tr>
      <th>交易中心</th><th class="num">最低卖价</th><th class="num">卖单量</th><th class="num">最高收价</th><th class="num">收单量</th><th class="num">日均成交（星域）</th><th class="num">日均成交额</th>
    </tr></thead><tbody>${hubRows}</tbody></table></div>
    <div class="hc-head"><h3>倒卖利润（税后）</h3><span class="toolbar-spacer"></span>
      ${seg('mode', [['buy', '到货卖给收单'], ['sell', '到货挂卖单']])}
      ${seg('sort', [['profit', '预计利润'], ['margin', '利润率'], ['unit', '每件利润']])}</div>
    ${routeRows ? `<div class="table-scroll"><table class="pc-mini-table hc-table"><thead><tr>
      <th>路线（买入 → 卖出）</th><th class="num">买入价</th><th class="num">卖出价</th><th class="num">每件税后利润</th><th class="num">利润率</th><th class="num">可做数量</th><th class="num">预计利润</th>
    </tr></thead><tbody>${routeRows}</tbody></table></div>` : '<p class="text-muted">订单不足，算不出倒卖利润</p>'}
    <p class="hc-note" title="跨中心：买入地直接买最低卖单，到货后${opts.mode === 'buy' ? '卖给最高收单' : '按最低卖价挂卖单'}；本地：挂收单→挂卖单。可做数量按最优价 5% 以内的订单深度${opts.mode === 'buy' ? '' : '与日均成交 10%'}估算，日均成交为整个星域。">${pos.length ? `${pos.length} 条路线有利润` : '没有盈利的路线'} · 未计运费</p>
  </div>`;
}

export async function renderHubCompare(box, typeId) {
  if (!ctx.regions?.length) { box.innerHTML = '<p class="text-muted">当前服务器只有一个交易中心</p>'; return; }
  box.dataset.type = typeId;
  if (ctx.isGlobal?.(typeId)) { box.innerHTML = '<p class="text-muted">该物品是全服统一市场（不分星域与交易中心），没有交易中心差价</p>'; return; }
  box.innerHTML = ctx.skeleton();
  try {
    const hubs = await load(typeId);
    if (Number(box.dataset.type) !== typeId) return;
    box.innerHTML = html(hubs);
  } catch (e) {
    if (Number(box.dataset.type) === typeId) box.innerHTML = `<p class="text-muted">读取失败：${ctx.esc(e.message)}</p>`;
  }
  if (box.dataset.bound) return;
  box.dataset.bound = '1';
  box.addEventListener('click', (e) => {
    const id = Number(box.dataset.type);
    const m = e.target.closest('[data-hc-mode]');
    const s = e.target.closest('[data-hc-sort]');
    if (m || s) {
      if (m) opts.mode = m.dataset.hcMode;
      if (s) opts.sort = s.dataset.hcSort;
      persist();
      renderHubCompare(box, id);
      return;
    }
    if (e.target.closest('[data-hc-fees]')) { ctx.TF.openFeeDialog(); return; }
    if (e.target.closest('[data-hc-reload]')) { cache.delete(id); renderHubCompare(box, id); }
  });
}

// 技能或税费改动后重算（不重新查行情）
export function refreshHubCompare(box) {
  const id = Number(box?.dataset.type);
  if (id && cache.has(id) && box.querySelector('.hc-wrap')) renderHubCompare(box, id);
}
