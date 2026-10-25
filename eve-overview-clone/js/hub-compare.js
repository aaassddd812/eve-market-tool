// 市场详情 ·「交易中心比价」：各交易中心（server.js 的 regions）当前最优卖价 / 收价、订单量与星域日均成交，
// 以及跨交易中心倒卖的税后利润（技能、税费与声望设置来自 trade-fees.js，全站共用）。
// 数据：ESI /markets/{region}/orders/（只取交易中心空间站内的订单）与 /markets/{region}/history/（星域 30 天日均），打开标签时才查，缓存 5 分钟。
// 倒卖方式 = 买入方式 × 卖出方式，自由组合：在 A「卖单收」直接买最低卖单（不付税费）、「收单收」按最高收价挂收单（付中介费）
// 或按近 N 天成交价挂收单（「中位价收 / 最低价收 / 最高价收」，付中介费）；运到 B 后「收单出」直接卖给最高收单（付销售税）、
// 「卖单出」按最低卖价挂卖单，或按近 N 天成交价挂卖单（「中位价出 / 最低价出 / 最高价出」，都付销售税 + 中介费）。A = B 为本地倒卖。
// 成交价（N = 24 小时 / 7 / 14 / 30 天，24 小时是最近一个完整交易日）：中位价 = 每天成交均价的中位数，最低 / 最高价 = 每天最低 / 最高成交价里最低 / 最高的（没成交的日子不算）。
// 现价偏离：按成交价挂单时，买入地现在的价格比挂单价高 20% 以上（收单排不上）或卖出地现价比挂单价低 20% 以上（卖不动）就标出来。
// 可做数量：直接成交按最优价 5% 以内的订单深度，挂单按该星域日均成交的 10%，两端取小。
// 运费（跨交易中心路线，与倒卖排行共用设置）：每件运费 = 包装体积 × 每立方运费 + 买入成本 × 抵押费率；每立方利润 = 每件利润 ÷ 包装体积。
//   体积来自 type-volume.json（build_volumes.mjs 由 SDE 生成）。运费默认 0（不计），可按快递报价填写。
// 全部物品一起比的排行在 hub-rank.js（数据由击杀记录服务汇总）。
// 我的建筑市场（struct-markets.js，需绑定 ESI）：勾选的玩家建筑排在交易中心后面一起算路线；建筑没有自己的成交历史，日均成交与均价用所在星域的。
let ctx = null;
const cache = new Map();   // typeId -> { at, promise }
const TTL = 5 * 60e3;
const DEPTH = 0.05;        // 最优价 5% 以内的订单算作可成交深度
const SHARE = 0.1;         // 挂单最多按日均成交的 10% 估算
// 挂单价要在星域 30 天成交均价附近才算数：远低于均价的收单、远高于均价的卖单（钓鱼单 / 没人成交的挂单）不作为挂单价
const BAND = [0.6, 1.4];
// 方式：[买入用卖单(s) / 收单(b) / 成交价][卖出用收单(b) / 卖单(s) / 成交价]，成交价：中位价(m) / 最低价(l) / 最高价(h)
const BUYS = [['s', '卖单收'], ['b', '收单收'], ['m', '中位价收'], ['l', '最低价收'], ['h', '最高价收']];
const SELLS = [['b', '收单出'], ['s', '卖单出'], ['m', '中位价出'], ['l', '最低价出'], ['h', '最高价出']];
const MODES = BUYS.flatMap(([a, al]) => SELLS.map(([b, bl]) => [a + b, `${al} · ${bl}`]));
const MED_DAYS = [1, 7, 14, 30];
const HIST = { m: '中位价', l: '最低价', h: '最高价' };
const DEV = 0.2;   // 现价偏离成交价 20% 以上标出来
export const daysLabel = (n) => (Number(n) === 1 ? '24 小时' : `${n} 天`);
export const usesHist = (mode) => /[mlh]/.test(mode);
const opts = { mode: 'sb', med: 7, sort: 'profit', m3: 0, collat: 0 };
try { Object.assign(opts, JSON.parse(localStorage.getItem('eve-hub-compare') || '{}')); } catch { /* 用默认 */ }
if (!MODES.some(([k]) => k === opts.mode)) opts.mode = 'sb';   // 旧设置 buy / sell
if (!MED_DAYS.includes(Number(opts.med))) opts.med = 7;
const persist = () => { try { localStorage.setItem('eve-hub-compare', JSON.stringify(opts)); } catch { /* 无痕模式 */ } };

export function initHubCompare(context) {
  ctx = context;
  // 建筑勾选变化：清掉缓存，正开着的比价重画
  // 建筑订单后台刷新完：下次打开用新数据（不打断正在看的页面）
  ctx.structs?.onData?.(() => structCache.clear());
  ctx.structs?.on(() => {
    structCache.clear();
    if (lastBox?.isConnected && lastBox.dataset.type && lastBox.querySelector('.hc-wrap')) renderHubCompare(lastBox, Number(lastBox.dataset.type));
  });
}
let lastBox = null;

// 勾选的玩家建筑：每座一行，和交易中心同样的字段（星域历史与交易中心同星域时直接借用）
const structCache = new Map();   // typeId -> { at, promise }
const regionHist = new Map();    // `${region}:${type}` -> promise
function loadStructRows(typeId, hubs) {
  if (!ctx.structs?.count()) return Promise.resolve([]);
  const hit = structCache.get(typeId);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = ctx.structs.load().then((list) => Promise.all(list.map(async ({ s, byType }) => {
    const q = ctx.structs.quote(byType.get(typeId) || []);
    let hist = hubs.find((h) => h.region.id === s.region);
    if (!hist && s.region) {
      const k = s.region + ':' + typeId;
      if (!regionHist.has(k)) regionHist.set(k, ctx.fetchESI(`/markets/${s.region}/history/?type_id=${typeId}`).catch(() => null));
      const history = await regionHist.get(k);
      const recent = Array.isArray(history) ? history.slice(-30) : [];
      const vol = recent.reduce((n, d) => n + d.volume, 0);
      hist = { daily: vol / 30, avg: recent.length ? recent.reduce((n, d) => n + d.average * d.volume, 0) / (vol || 1) : null, stats: statsOf(recent.map((d) => [d.date, d.average, d.volume, d.lowest, d.highest])) };
    }
    return {
      region: { id: s.region, name: ctx.structs.regionName(s.region), hub: { id: s.id, name: s.label } },
      id: s.id, label: s.label, struct: true, failed: false, ...q, daily: hist?.daily || 0, avg: hist?.avg ?? null, stats: hist?.stats || {}
    };
  })));
  structCache.set(typeId, { at: Date.now(), promise });
  promise.catch(() => structCache.delete(typeId));
  return promise;
}

// 近 N 天成交价统计（hist：[[日期, 均价, 成交量, 最低, 最高]]，没成交的日子不算；1 天 = 最近一个有记录的交易日，ESI 只到昨天）
// → { 天数: { m: 中位价, l: 最低价, h: 最高价 } }
export function median(xs) {
  const a = xs.filter((v) => v != null).sort((x, y) => x - y);
  const n = a.length;
  return n ? (n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2) : null;
}
function statsOf(hist) {
  const out = {};
  const traded = hist.filter((d) => d[2]);
  const recent = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  const last = traded.reduce((m, d) => (d[0] > m ? d[0] : m), '');
  for (const n of MED_DAYS) {
    const since = n === 1 ? (last > recent ? last : '9') : new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
    const w = traded.filter((d) => (n === 1 ? d[0] >= since : d[0] > since));
    const lo = w.map((d) => d[3]).filter((v) => v), hi = w.map((d) => d[4]).filter((v) => v);
    out[n] = { m: median(w.map((d) => d[1])), l: lo.length ? Math.min(...lo) : null, h: hi.length ? Math.max(...hi) : null };
  }
  return out;
}

// 物品包装体积（m³），首次用到时加载
let volumes = null;
export function loadVolumes() {
  if (!volumes) volumes = fetch('type-volume.json?v=1').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return volumes;
}
// 运费设置（比价与倒卖排行共用）
export const freight = () => ({ m3: Number(opts.m3) || 0, collat: Number(opts.collat) || 0 });
export function setFreight(m3, collat) {
  opts.m3 = Math.max(0, Number(m3) || 0);
  opts.collat = Math.max(0, Math.min(100, Number(collat) || 0));
  persist();
}
export function freightHtml(attr) {
  const fr = freight();
  return `<label class="pi-inline hc-freight" title="跨交易中心路线每件扣运费：包装体积 × 每立方运费 + 买入成本 × 抵押费率。按快递报价填写，0 表示不计">
    <span>运费</span><input type="number" class="pi-input pi-tax" min="0" step="50" value="${fr.m3}" data-${attr}-m3><span>ISK/m³ + 抵押</span>
    <input type="number" class="pi-input pi-tax" min="0" max="100" step="0.5" value="${fr.collat}" data-${attr}-collat><span>%</span></label>`;
}

// 自选看板（watch-board.js）共用
export { load as loadHubs };

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
      avg: recent.length ? recent.reduce((s, d) => s + d.average * d.volume, 0) / (vol || 1) : null,
      hist: recent.map((d) => [d.date, d.average, d.volume, d.lowest, d.highest]),   // 自选看板画走势、算涨跌
      stats: statsOf(recent.map((d) => [d.date, d.average, d.volume, d.lowest, d.highest]))
    };
  }));
  cache.set(typeId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(typeId));
  return promise;
}

// 一个物品在各交易中心之间的全部路线（hubs 元素需有 sell / buy / sellDepth / buyDepth / daily / avg，按成交价的方式还要 px = { m, l, h }）；全物品倒卖排行（hub-rank.js）共用
// ship（可选）：{ vol 包装体积, m3 每立方运费, collat 抵押费率 % }，只对跨中心路线扣运费
// 成交价（尤其每天的最低 / 最高价）常有乱价成交：偏离 30 天成交均价超出 BAND 的不用；没有均价也不用
const offBand = (p, avg) => !avg || p < avg * BAND[0] || p > avg * BAND[1];
export function calcRoutes(hubs, mode, f, ship = null) {
  const out = [];
  const bm = mode[0], sm = mode[1];
  const buyOrder = bm !== 's', sellOrder = sm !== 'b';   // 按成交价也是挂单：付中介费，可做数量按日均成交
  const histBuy = !!HIST[bm], histSell = !!HIST[sm];
  for (const a of hubs) {
    const buyAt = histBuy ? a.px?.[bm] ?? null : bm === 'b' ? a.buy : a.sell;
    if (histBuy && (buyAt == null || offBand(buyAt, a.avg))) continue;
    // 收单挂在成交价，但现在别人的收单（没有收单就看卖单）已经比它高很多：排不上队
    const curA = a.buy ?? a.sell;
    const devA = histBuy && buyAt && curA != null && curA > buyAt * (1 + DEV) ? curA / buyAt - 1 : 0;
    if (buyAt == null || (bm === 'b' && a.avg && buyAt < a.avg * BAND[0])) continue;
    const cost = buyAt * (1 + (buyOrder ? f.broker : 0));
    const buyCap = buyOrder ? Math.floor((a.daily || 0) * SHARE) : a.sellDepth;
    for (const b of hubs) {
      const sellAt = histSell ? b.px?.[sm] ?? null : sm === 's' ? b.sell : b.buy;
      if (histSell && (sellAt == null || offBand(sellAt, b.avg))) continue;
      if (sellAt == null || (sm === 's' && b.avg && sellAt > b.avg * BAND[1])) continue;
      const local = a === b;
      const shipCost = ship && !local ? (ship.vol || 0) * ship.m3 + cost * ship.collat / 100 : 0;
      const unit = sellAt * (1 - f.sales - (sellOrder ? f.broker : 0)) - cost - shipCost;
      const sellCap = sellOrder ? Math.floor((b.daily || 0) * SHARE) : b.buyDepth;
      const qty = Math.min(buyCap, sellCap);
      const vol = ship?.vol || 0;
      // 卖单挂在成交价，但现在卖出地的最低卖价（没有卖单就看收单）比它低很多：卖不动
      const curB = b.sell ?? b.buy;
      const devB = histSell && curB != null && curB < sellAt * (1 - DEV) ? 1 - curB / sellAt : 0;
      out.push({ a, b, local, buyAt, sellAt, cost, shipCost, unit, qty, vol, perM3: vol ? unit / vol : null, margin: cost ? unit / cost : 0, total: unit > 0 ? unit * qty : 0, devA, devB });
    }
  }
  return out;
}
export const ROUTE_SORT = { profit: (r) => r.total, margin: (r) => r.margin, unit: (r) => r.unit, m3: (r) => r.perM3 ?? -Infinity };
export { MODES, BUYS, SELLS, MED_DAYS, HIST };
// 现价偏离的提示文字（没有偏离返回空串）
export function devTip(r) {
  const out = [];
  if (r.devA) out.push(`买入地现在的价格比挂收单价高 ${Math.round(r.devA * 100)}%，收单可能排不上`);
  if (r.devB) out.push(`卖出地现在的最低卖价比挂卖单价低 ${Math.round(r.devB * 100)}%，可能卖不动`);
  return out.join('；');
}
// 从全物品排行点进来时沿用排行的倒卖方式与中位价天数
export function setHubMode(mode, med) {
  if (!MODES.some(([k]) => k === mode)) return;
  const m = MED_DAYS.includes(Number(med)) ? Number(med) : opts.med;
  if (opts.mode !== mode || opts.med !== m) { opts.mode = mode; opts.med = m; persist(); }
}
// 买入 / 卖出方式两组按钮 + 用到中位价时的天数（attr：data-{attr}-buy / -sell / -med；比价与排行共用）
export function modePicker(attr, mode, med) {
  const btns = (k, items, cur) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-${attr}-${k}="${v}" class="${cur === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="pi-inline hc-mode"><span>买入</span>${btns('buy', BUYS, mode[0])}</div>
    <div class="pi-inline hc-mode"><span>卖出</span>${btns('sell', SELLS, mode[1])}</div>
    ${usesHist(mode) ? `<div class="pi-inline hc-mode" title="中位价：每天成交均价的中位数；最低 / 最高价：每天最低 / 最高成交价里最低 / 最高的；24 小时是最近一个完整交易日，没成交的日子不算"><span>成交价取近</span>${btns('med', MED_DAYS.map((n) => [String(n), daysLabel(n)]), String(med))}</div>` : ''}`;
}
// 点了买入 / 卖出 / 天数按钮 → 新的 [方式, 天数]，没点到返回 null
export function modeClick(el, attr, mode, med) {
  const b = el.closest(`[data-${attr}-buy]`), s = el.closest(`[data-${attr}-sell]`), d = el.closest(`[data-${attr}-med]`);
  if (b) return [b.dataset[attr + 'Buy'] + mode[1], med];
  if (s) return [mode[0] + s.dataset[attr + 'Sell'], med];
  if (d) return [mode, Number(d.dataset[attr + 'Med'])];
  return null;
}

function routes(hubs, vol) {
  const key = ROUTE_SORT[opts.sort] || ROUTE_SORT.profit;
  const list = hubs.map((h) => ({ ...h, px: h.stats?.[opts.med] || null }));
  return calcRoutes(list, opts.mode, ctx.TF.fees(), { vol, ...freight() }).sort((x, y) => key(y) - key(x) || y.margin - x.margin);
}

function html(hubs, vol) {
  const { esc, formatISK, formatPrice, formatNumber, TF } = ctx;
  const f = TF.fees();
  const live = hubs.filter((h) => !h.failed);
  const minSell = Math.min(...live.map((h) => h.sell ?? Infinity));
  const maxBuy = Math.max(...live.map((h) => h.buy ?? -Infinity));
  const name = (h) => esc(h.label || h.region.hub.name.split(' ')[0].replace(/海\d+$/, '') || h.region.name);
  const num = (v) => v == null ? '<span class="muted-cell">—</span>' : formatPrice(v);
  const histCols = [...new Set([opts.mode[0], opts.mode[1]])].filter((c) => HIST[c]);
  const hubRows = hubs.map((h) => `<tr${h.struct ? ' class="hc-struct"' : ''}>
      <td><b>${name(h)}</b><small class="hc-sub">${h.struct ? '玩家建筑 · ' : ''}${esc(h.region.name)}</small></td>
      ${h.failed ? `<td colspan="${6 + histCols.length}" class="muted-cell">ESI 读取失败</td>` : `
      <td class="num ${h.sell != null && h.sell === minSell ? 'hc-best down' : ''}">${num(h.sell)}</td>
      <td class="num">${h.sellQty ? formatNumber(h.sellQty) : '—'}</td>
      <td class="num ${h.buy != null && h.buy === maxBuy ? 'hc-best up' : ''}">${num(h.buy)}</td>
      <td class="num">${h.buyQty ? formatNumber(h.buyQty) : '—'}</td>
      ${histCols.map((c) => `<td class="num">${num(h.stats?.[opts.med]?.[c] ?? null)}</td>`).join('')}
      <td class="num">${h.daily ? formatNumber(Math.round(h.daily)) : '—'}</td>
      <td class="num">${h.daily && h.avg ? formatISK(h.daily * h.avg) : '—'}</td>`}</tr>`).join('');
  const list = routes(live, vol);
  const fr = freight();
  const shipOn = fr.m3 > 0 || fr.collat > 0;
  const pos = list.filter((r) => r.unit > 0);
  const routeRows = list.slice(0, 20).map((r) => `<tr class="${r.unit > 0 ? '' : 'hc-loss'}">
      <td>${r.local ? `${name(r.a)} <small class="hc-sub">本地</small>` : `${name(r.a)} <span class="hc-arrow">→</span> ${name(r.b)}`}${devTip(r) ? ` <b class="hr-tag warn" title="${devTip(r)}">现价偏离</b>` : ''}</td>
      <td class="num">${formatPrice(r.buyAt)}</td>
      <td class="num">${formatPrice(r.sellAt)}</td>
      <td class="num ${r.unit > 0 ? 'up' : 'down'}">${(r.unit > 0 ? '+' : '') + formatPrice(r.unit)}</td>
      ${shipOn ? `<td class="num">${r.shipCost ? formatPrice(r.shipCost) : '—'}</td>` : ''}
      <td class="num ${r.unit > 0 ? 'up' : 'down'}">${(r.margin * 100).toFixed(1)}%</td>
      <td class="num">${r.perM3 != null ? formatISK(r.perM3) : '—'}</td>
      <td class="num">${r.qty ? formatNumber(r.qty) : '—'}</td>
      <td class="num">${r.total ? formatISK(r.total) : '—'}</td></tr>`).join('');
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-hc-${k}="${v}" class="${opts[k] === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="hc-wrap">
    <div class="hc-head"><h3>交易中心行情</h3><span class="toolbar-spacer"></span>
      <button class="btn btn-ghost btn-sm" data-hc-fees title="调整技能与税费">${esc(TF.summary())}</button>
      <button class="btn btn-ghost btn-sm" data-hc-reload>刷新</button>
      ${ctx.structs ? `<button class="btn btn-ghost btn-sm" data-hc-structs title="把你有权限的玩家建筑市场加入比价（需绑定 ESI）">玩家建筑市场${ctx.structs.count() ? `（${ctx.structs.count()}）` : ''}</button>` : ''}
      ${ctx.openRank ? '<button class="btn btn-ghost btn-sm" data-hc-rank title="所有物品一起比，按利润排行">全部物品排行</button>' : ''}</div>
    <div class="table-scroll"><table class="pc-mini-table hc-table"><thead><tr>
      <th>交易中心</th><th class="num">最低卖价</th><th class="num">卖单量</th><th class="num">最高收价</th><th class="num">收单量</th>${histCols.map((c) => `<th class="num">${daysLabel(opts.med)}${HIST[c]}</th>`).join('')}<th class="num">日均成交（星域）</th><th class="num">日均成交额</th>
    </tr></thead><tbody>${hubRows}</tbody></table></div>
    <div class="hc-head"><h3>倒卖利润（税后）</h3><span class="toolbar-spacer"></span>
      ${seg('sort', [['profit', '预计利润'], ['margin', '利润率'], ['unit', '每件利润'], ['m3', '每立方利润']])}</div>
    <div class="hc-ship hc-modes">${modePicker('hc', opts.mode, opts.med)}</div>
    <div class="hc-ship">${freightHtml('hc')}<span class="text-muted">包装体积 ${vol ? formatNumber(vol) + ' m³' : '未知'}</span></div>
    ${routeRows ? `<div class="table-scroll"><table class="pc-mini-table hc-table"><thead><tr>
      <th>路线（买入 → 卖出）</th><th class="num">买入价</th><th class="num">卖出价</th><th class="num">每件税后利润</th>${shipOn ? '<th class="num">每件运费</th>' : ''}<th class="num">利润率</th><th class="num">每立方利润</th><th class="num">可做数量</th><th class="num">预计利润</th>
    </tr></thead><tbody>${routeRows}</tbody></table></div>` : '<p class="text-muted">订单不足，算不出倒卖利润</p>'}
    <p class="hc-note" title="卖单收：直接买最低卖单；收单收：按最高收价挂收单（付中介费 ${TF.pct2(f.broker)}）；收单出：直接卖给最高收单（销售税 ${TF.pct2(f.sales)}）；卖单出：按最低卖价挂卖单（销售税 + 中介费）；中位价 / 最低价 / 最高价收出：按近 ${daysLabel(opts.med)}的成交价挂单（付中介费），成交价偏离 30 天均价超过 60%–140% 的不用（乱价成交），现价偏离挂单价 20% 以上标「现价偏离」。买入、卖出方式可以任意组合。可做数量：直接成交按最优价 5% 以内的订单深度，挂单按星域日均成交 10%；挂单价偏离星域 30 天成交均价太多（收单低于 60%、卖单高于 140%）的路线不列出。">${pos.length ? `${pos.length} 条路线有利润` : '没有盈利的路线'} · ${shipOn ? `跨中心路线已扣运费（${formatNumber(fr.m3)} ISK/m³ + 抵押 ${fr.collat}%）` : '未计运费'}</p>
  </div>`;
}

export async function renderHubCompare(box, typeId) {
  if (!ctx.regions?.length) { box.innerHTML = '<p class="text-muted">当前服务器只有一个交易中心</p>'; return; }
  box.dataset.type = typeId;
  lastBox = box;
  if (ctx.isGlobal?.(typeId)) { box.innerHTML = '<p class="text-muted">该物品是全服统一市场（不分星域与交易中心），没有交易中心差价</p>'; return; }
  box.innerHTML = ctx.skeleton();
  try {
    const [hubs, vols] = await Promise.all([load(typeId), loadVolumes()]);
    if (Number(box.dataset.type) !== typeId) return;
    box.innerHTML = html(hubs, vols[typeId] || 0);
    // 玩家建筑读得慢（整座建筑的订单），先显示交易中心，读完再补上
    if (ctx.structs?.count()) {
      const rows = await loadStructRows(typeId, hubs).catch(() => []);
      if (Number(box.dataset.type) === typeId && rows.length) box.innerHTML = html([...hubs, ...rows], vols[typeId] || 0);
    }
  } catch (e) {
    if (Number(box.dataset.type) === typeId) box.innerHTML = `<p class="text-muted">读取失败：${ctx.esc(e.message)}</p>`;
  }
  if (box.dataset.bound) return;
  box.dataset.bound = '1';
  box.addEventListener('click', (e) => {
    const id = Number(box.dataset.type);
    const m = modeClick(e.target, 'hc', opts.mode, opts.med);
    const s = e.target.closest('[data-hc-sort]');
    if (m || s) {
      if (m) [opts.mode, opts.med] = m;
      if (s) opts.sort = s.dataset.hcSort;
      persist();
      renderHubCompare(box, id);
      return;
    }
    if (e.target.closest('[data-hc-fees]')) { ctx.TF.openFeeDialog(); return; }
    if (e.target.closest('[data-hc-rank]')) { ctx.openRank(); return; }
    if (e.target.closest('[data-hc-structs]')) { ctx.structs.open(); return; }
    if (e.target.closest('[data-hc-reload]')) { cache.delete(id); structCache.delete(id); renderHubCompare(box, id); }
  });
  box.addEventListener('change', (e) => {
    if (!e.target.matches('[data-hc-m3],[data-hc-collat]')) return;
    setFreight(box.querySelector('[data-hc-m3]').value, box.querySelector('[data-hc-collat]').value);
    renderHubCompare(box, Number(box.dataset.type));
  });
}

// 技能或税费改动后重算（不重新查行情）
export function refreshHubCompare(box) {
  const id = Number(box?.dataset.type);
  if (id && cache.has(id) && box.querySelector('.hc-wrap')) renderHubCompare(box, id);
}
