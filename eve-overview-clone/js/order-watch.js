// ===== 个人中心 · 我的订单：改单小助手 + 订单变化报告 =====
// 改单小助手：每张挂单与同一地点的其他订单比价——
//   卖单：同一空间站 / 建筑里比我便宜的卖单；收单：同站收单，以及同星系范围不是「空间站」、或范围为「星域」的收单（跨星系的数字跳数范围不计，近似）。
//   有人比我好就标「被压」，建议价 = 对手价再让一档（游戏价格只保留 4 位有效数字，一档 = 10^(位数 − 4)），一键复制后到游戏里改单。
//   改单冷却：订单发布 / 上次修改后 5 分钟内不能再改（issued 即最后修改时间）。
//   星域订单：公开接口 /markets/{region}/orders/?type_id=&order_type=；玩家建筑：/markets/structures/{id}/（esi-markets.structure_markets.v1，整个建筑市场，缓存 5 分钟）。
// 订单变化报告：每次读取后把订单快照（剩余数量、价格）存在本机，下次和当前订单、/orders/history/（90 天已结束订单）对比，
//   列出新挂单、部分成交（成交数量 × 价格）、全部成交、过期、取消。
// 后台监控（默认关）：每 5 分钟检查一次，有订单新被压价时网页提示，可选桌面通知与提示音；关闭页面就停止。
//   也推送到企业微信 / 邮箱（alert-push.js，渠道在「预警 → 消息推送」里设置，这里只开关「订单被压价」这一种）。
// ESI 缓存：角色订单约 20 分钟、市场订单 5 分钟，所以「刷新」最快也是这个频率。
// 订单账本（本机，按角色）：每次读到订单都记一笔——新挂单（中介费）、改价（issued 变了，按 trade-fees.js 的改单费）、成交（剩余减少）。
//   费率按订单所在地点（brokerAt：按建筑单独填的 / 建筑默认 / NPC 技能声望）。两次读取之间改了多次只能记一次（ESI 缓存约 20 分钟）。
//   收单：每件成本 = 价格 + 累计费用 / 总量，和同站最低卖价扣税费后比，得剩余利润率；
//   卖单：每件到手 = 价格扣销售税 − 累计费用 / 总量，有收单成交记录时和平均收购成本比。
//   改单以价格变化为准（游戏里改单必须改价）。

import * as TF from './trade-fees.js?v=v7';
import * as AP from './alert-push.js?v=v14';
import { L } from './alert-mail.js?v=v8';

let ctx;   // esc, formatISK, formatPrice, formatNumber, showToast, copyText, addToCart, fetchESI, fetchESIPaged, esiAuthFetch, ensureEsiToken, hasEsiToken, hasScope, typeName, locationName, resolveTypeNames, selectItem, store, serverKey, isActive, openPush
const SET_KEY = 'eve-order-watch';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
const STRUCT_SCOPE = 'esi-markets.structure_markets.v1';
const HIST_SCOPE = 'esi-markets.read_character_orders.v1';
const POLL = 5 * 60e3;
const COOLDOWN = 5 * 60e3;
const SET = { bg: false, notify: false, sound: false };
const S = { orders: null, market: new Map(), structs: new Map(), region: new Map(), checkedAt: 0, busy: false, report: null, timer: 0, alerted: new Map(), charId: 0 };

export function initOrderWatch(context) {
  ctx = context;
  Object.assign(SET, ctx.store.getJSON(SET_KEY, {}) || {});
  if (SET.bg) startBackground();
}
const saveSet = () => ctx.store.setJSON(SET_KEY, SET);
const snapKey = (charId) => ctx.serverKey('eve-order-snap-' + charId);
const ledgerKey = (charId) => ctx.serverKey('eve-order-ledger-' + charId);
const LEDGER_DAYS = 120;   // 结束超过 120 天的订单从账本删掉

// 一档价格：保留 4 位有效数字的最小变动（不低于 0.01）
export function tick(price) {
  if (!(price > 0)) return 0.01;
  return Math.max(0.01, 10 ** (Math.floor(Math.log10(price)) - 3));
}
const roundTo = (v, step) => Math.round(v / step) * step;
function suggest(o, best) {
  const step = tick(best);
  let p = o.is_buy_order ? best + step : best - step;
  p = roundTo(p, tick(p));
  if (o.is_buy_order ? p <= best : p >= best) p = o.is_buy_order ? best + tick(p) : best - tick(p);   // 跨越位数时重算一档
  return Math.max(0.01, Number(p.toFixed(2)));
}

// 订单所在星域：ESI 订单自带 region_id；没有时由空间站 → 星系 → 星座反查
async function regionOf(o) {
  if (o.region_id) return o.region_id;
  if (o.location_id >= 1e12) return 0;
  if (S.region.has(o.location_id)) return S.region.get(o.location_id);
  try {
    const st = await ctx.fetchESI(`/universe/stations/${o.location_id}/`);
    const sys = await ctx.fetchESI(`/universe/systems/${st.system_id}/`);
    const con = await ctx.fetchESI(`/universe/constellations/${sys.constellation_id}/`);
    S.region.set(o.location_id, con.region_id);
    o.system_id = st.system_id;
    return con.region_id;
  } catch { return 0; }
}

async function marketFor(o) {
  if (o.location_id >= 1e12) {
    if (!ctx.hasScope(STRUCT_SCOPE)) return { err: '需要建筑市场权限' };
    const c = S.structs.get(o.location_id);
    if (c && Date.now() - c.at < POLL) return { list: c.list.filter((x) => x.type_id === o.type_id) };
    try {
      const list = await ctx.esiAuthFetchPaged(`/markets/structures/${o.location_id}/`);
      S.structs.set(o.location_id, { at: Date.now(), list });
      return { list: list.filter((x) => x.type_id === o.type_id) };
    } catch (e) { return { err: '建筑市场读取失败（' + e.message + '）' }; }
  }
  const region = await regionOf(o);
  if (!region) return { err: '找不到所在星域' };
  const key = `${region}:${o.type_id}:${o.is_buy_order ? 'buy' : 'sell'}`;
  const c = S.market.get(key);
  if (c && Date.now() - c.at < POLL) return { list: c.list };
  try {
    const list = await ctx.fetchESIPaged(`/markets/${region}/orders/?type_id=${o.type_id}&order_type=${o.is_buy_order ? 'buy' : 'sell'}`);
    S.market.set(key, { at: Date.now(), list });
    return { list };
  } catch (e) { return { err: '市场读取失败（' + e.message + '）' }; }
}

// 对每张订单算状态：lead 领先 / under 被压 / alone 只有我 / unknown
async function analyze(orders) {
  const mine = new Set(orders.map((o) => o.order_id));
  const out = [];
  let i = 0;
  const work = async () => {
    while (i < orders.length) {
      const o = orders[i++];
      const m = await marketFor(o);
      if (m.err) { out.push({ o, state: 'unknown', why: m.err }); continue; }
      // 收单的参考卖价：同一空间站 / 建筑别人的最低卖单（算剩余利润用）
      let sellRef = null;
      if (o.is_buy_order) {
        const ms = await marketFor({ ...o, is_buy_order: false });
        const sells = (ms.list || []).filter((x) => !x.is_buy_order && x.location_id === o.location_id && !mine.has(x.order_id));
        if (sells.length) sellRef = Math.min(...sells.map((x) => x.price));
      }
      const sys = o.system_id || m.list.find((x) => x.location_id === o.location_id)?.system_id;
      // 角色订单接口里卖单不带 is_buy_order 字段（undefined），市场接口是 false，比较前统一成布尔值
      const rivals = m.list.filter((x) => !mine.has(x.order_id) && !!x.is_buy_order === !!o.is_buy_order && (o.is_buy_order
        ? x.location_id === o.location_id || x.range === 'region' || (sys && x.system_id === sys && x.range !== 'station')
        : x.location_id === o.location_id));
      if (!rivals.length) { out.push({ o, state: 'alone', sellRef }); continue; }
      const best = o.is_buy_order ? Math.max(...rivals.map((x) => x.price)) : Math.min(...rivals.map((x) => x.price));
      const bestVol = rivals.filter((x) => x.price === best).reduce((t, x) => t + x.volume_remain, 0);
      const worse = o.is_buy_order ? best > o.price : best < o.price;
      const tie = best === o.price;
      out.push({ o, sellRef, best, bestVol, rivals: rivals.length, state: worse || tie ? 'under' : 'lead', tie, gap: Math.abs(best - o.price), sug: worse || tie ? suggest(o, best) : null,
        lead: !worse && !tie ? Math.abs(o.price - best) : 0 });
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  const order = { under: 0, unknown: 1, lead: 2, alone: 3 };
  return out.sort((a, b) => order[a.state] - order[b.state] || ctx.typeName(a.o.type_id).localeCompare(ctx.typeName(b.o.type_id), 'zh'));
}

// ---------- 订单账本 ----------
// L：{ o: { 订单号: { t 物品, b 收单, loc, tot 总量, h: [[时间, 价格, 剩余, 事件 new|mod|fill|end]], fee 中介费, rel 改单费, n 改单次数, end } },
//      cost: { 物品: [收购数量, 含费用的收购总额] } }
function loadLedger(charId) {
  const L = ctx.store.getJSON(ledgerKey(charId), null) || {};
  return { o: L.o || {}, cost: L.cost || {} };
}
function track(charId, orders) {
  const L = loadLedger(charId);
  const now = Date.now();
  const live = new Set();
  for (const o of orders) {
    const id = String(o.order_id);
    live.add(id);
    const rate = TF.brokerAt(o.location_id);
    let e = L.o[id];
    if (!e) {
      e = L.o[id] = { t: o.type_id, b: o.is_buy_order ? 1 : 0, loc: o.location_id, tot: o.volume_total, iss: o.issued, h: [[Date.parse(o.issued) || now, o.price, o.volume_remain, 'new']], fee: TF.brokerFee(rate, o.price * o.volume_total), rel: 0, n: 0 };
      if (o.volume_remain < o.volume_total) fill(L, e, o.volume_total - o.volume_remain, o.price, now);
      continue;
    }
    const last = e.h[e.h.length - 1];
    if (o.volume_remain < last[2]) fill(L, e, last[2] - o.volume_remain, last[1], now);
    if (o.price !== last[1]) {   // 游戏里改单一定改价（issued 也会变，但只看价格更稳）
      e.rel += TF.relistFee(rate, last[1], o.price, o.volume_remain);
      e.n += 1;
      e.iss = o.issued;
      e.h.push([Date.parse(o.issued) || now, o.price, o.volume_remain, 'mod']);
    } else if (o.volume_remain < last[2]) e.h.push([now, o.price, o.volume_remain, 'fill']);
  }
  for (const [id, e] of Object.entries(L.o)) {
    if (!live.has(id) && !e.end) { e.end = now; e.h.push([now, e.h[e.h.length - 1][1], e.h[e.h.length - 1][2], 'end']); }
    if (e.end && now - e.end > LEDGER_DAYS * 86400e3) delete L.o[id];
  }
  ctx.store.setJSON(ledgerKey(charId), L);
  return L;
}
// 收单成交：按成交件数分摊这张单的费用，记入该物品的平均收购成本
function fill(L, e, qty, price, now) {
  if (!e.b || qty <= 0) return;
  const c = L.cost[e.t] || [0, 0];
  L.cost[e.t] = [c[0] + qty, c[1] + qty * price];
  e.filled = (e.filled || 0) + qty;
}
const feesOf = (e) => (e ? e.fee + e.rel : 0);
// 物品的平均收购成本（含已付费用，按成交件数）
function avgCost(L, typeId) {
  const c = L.cost[typeId];
  if (!c || !c[0]) return null;
  const fees = Object.values(L.o).filter((e) => e.b && e.t === typeId && e.filled).reduce((t, e) => t + feesOf(e) * Math.min(1, e.filled / e.tot), 0);
  return (c[1] + fees) / c[0];
}

// ---------- 订单变化报告 ----------
async function buildReport(charId, orders) {
  const prev = ctx.store.getJSON(snapKey(charId), null);
  const snap = { at: Date.now(), o: Object.fromEntries(orders.map((o) => [o.order_id, [o.volume_remain, o.price, o.type_id, o.is_buy_order ? 1 : 0, o.volume_total]])) };
  ctx.store.setJSON(snapKey(charId), snap);
  if (!prev) return { first: true };
  const R = { since: prev.at, fresh: [], partial: [], moved: [], filled: [], expired: [], cancelled: [] };
  const now = new Set(orders.map((o) => String(o.order_id)));
  for (const o of orders) {
    const p = prev.o[o.order_id];
    if (!p) R.fresh.push(o);
    else if (o.volume_remain < p[0]) R.partial.push({ o, qty: p[0] - o.volume_remain, isk: (p[0] - o.volume_remain) * o.price });
    if (p && p[1] !== o.price) R.moved.push({ o, from: p[1] });
  }
  const gone = Object.entries(prev.o).filter(([id]) => !now.has(id));
  if (gone.length) {
    let hist = [];
    if (ctx.hasScope(HIST_SCOPE)) hist = await ctx.esiAuthFetch(`/characters/${charId}/orders/history/`).catch(() => []);
    const byId = new Map((Array.isArray(hist) ? hist : []).map((h) => [String(h.order_id), h]));
    for (const [id, p] of gone) {
      const h = byId.get(id);
      const remain = h ? h.volume_remain : null;
      const sold = p[0] - (remain ?? p[0]);
      const row = { id, type_id: p[2], buy: p[3], price: h?.price ?? p[1], qty: sold, isk: sold * (h?.price ?? p[1]), left: remain };
      if (h?.state === 'cancelled') R.cancelled.push(row);
      else if (h && remain === 0) R.filled.push({ ...row, qty: p[0], isk: p[0] * (h.price ?? p[1]) });
      else R.expired.push(row);   // 没有历史记录的（权限不足或还没同步）也算已结束
    }
  }
  R.empty = !R.fresh.length && !R.partial.length && !R.moved.length && !R.filled.length && !R.expired.length && !R.cancelled.length;
  return R;
}

function reportHtml(R) {
  const { esc, formatISK: isk, formatNumber: num } = ctx;
  if (!R) return '';
  if (R.first) return `<div class="ow-report"><b>订单变化</b><span class="text-muted">已记录，下次打开显示变化</span></div>`;
  const ago = fmtAgo(Date.now() - R.since);
  if (R.empty) return `<div class="ow-report"><b>订单变化</b><span class="text-muted">自 ${ago}前起无变化</span></div>`;
  const name = (id) => esc(ctx.typeName(id));
  const side = (buy) => (buy ? '<span class="pill buy">收</span>' : '<span class="pill sell">卖</span>');
  const sum = (list) => list.reduce((t, x) => t + (x.isk || 0), 0);
  const sec = (title, list, fmt, total) => (list.length ? `<div class="ow-rep-sec"><h4>${title} <small>${list.length}${total ? ' · ' + isk(total) : ''}</small></h4><ul>${list.slice(0, 12).map(fmt).join('')}${list.length > 12 ? `<li class="text-muted">… 等 ${list.length} 张</li>` : ''}</ul></div>` : '');
  return `<div class="ow-report"><div class="ow-rep-head"><b>订单变化</b><span class="text-muted">自 ${ago}前起</span></div><div class="ow-rep-grid">
    ${sec('部分成交', R.partial, (x) => `<li>${side(x.o.is_buy_order)} ${name(x.o.type_id)} ×${num(x.qty)} <span class="text-muted">@ ${ctx.formatPrice(x.o.price)}</span></li>`, sum(R.partial))}
    ${sec('全部成交', R.filled, (x) => `<li>${side(x.buy)} ${name(x.type_id)} ×${num(x.qty)} <span class="text-muted">@ ${ctx.formatPrice(x.price)}</span></li>`, sum(R.filled))}
    ${sec('改价', R.moved, (x) => `<li>${side(x.o.is_buy_order)} ${name(x.o.type_id)} <span class="text-muted">${ctx.formatPrice(x.from)} → ${ctx.formatPrice(x.o.price)}</span></li>`)}
    ${sec('新挂单', R.fresh, (o) => `<li>${side(o.is_buy_order)} ${name(o.type_id)} ×${num(o.volume_total)} <span class="text-muted">@ ${ctx.formatPrice(o.price)}</span></li>`)}
    ${sec('过期', R.expired, (x) => `<li>${side(x.buy)} ${name(x.type_id)}${x.qty ? ` 成交 ${num(x.qty)}` : ''}${x.left != null ? ` 剩 ${num(x.left)}` : ''}</li>`, sum(R.expired))}
    ${sec('取消', R.cancelled, (x) => `<li>${side(x.buy)} ${name(x.type_id)}${x.left != null ? ` 剩 ${num(x.left)}` : ''}</li>`)}
  </div></div>`;
}

function fmtAgo(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}

// ---------- 页面 ----------
// orders：个人中心已读取的 /characters/{id}/orders/（数组或 { __error }）
export async function renderOrders(box, orders, charId) {
  const { esc } = ctx;
  if (!Array.isArray(orders)) { box.innerHTML = `<p class="text-muted">订单读取失败：${esc(orders?.__error || '未知错误')}</p>`; return; }
  if (charId !== S.charId) { S.charId = charId; S.report = null; S.rows = null; }
  if (!S.report) S.report = await buildReport(charId, orders);
  if (S.tracked !== orders) { S.tracked = orders; S.ledger = track(charId, orders); }
  TF.setStructCandidates([...new Set(orders.map((o) => o.location_id).filter((id) => id >= 1e12))].map((id) => ({ id, name: ctx.locationName(id) })));
  if (!S.feeSub) S.feeSub = TF.onChange(() => { const b = document.getElementById('profileData'); if (S.rows && b && ctx.isActive()) draw(b); });
  if (!orders.length) { box.innerHTML = settingsHtml() + reportHtml(S.report) + '<p class="text-muted">暂无有效市场订单</p>'; return; }
  if (!S.rows || S.orders !== orders) {
    S.orders = orders;
    box.innerHTML = settingsHtml() + reportHtml(S.report) + `<div class="pi-loading">对比 ${orders.length} 张订单的同站价格…</div>`;
    await ctx.resolveTypeNames(orders.map((o) => o.type_id)).catch(() => {});
    S.rows = await analyze(orders);
    S.checkedAt = Date.now();
    rememberAlerted(S.rows);
    if (!ctx.isActive()) return;
  }
  draw(box);
}

function settingsHtml() {
  const chk = (k, label, title) => `<label class="pi-check" title="${title}"><input type="checkbox" data-ow-set="${k}"${SET[k] ? ' checked' : ''}${k !== 'bg' && !SET.bg ? ' disabled' : ''}><span>${label}</span></label>`;
  return `<div class="ow-bar"><button class="btn btn-ghost btn-sm" data-ow-refresh ${S.busy ? 'disabled' : ''}>${S.busy ? '检查中…' : '重新比价'}</button>
    <span class="text-muted">${S.checkedAt ? `比价于 ${new Date(S.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span><span class="toolbar-spacer"></span>
    <button class="btn btn-ghost btn-sm" data-ow-fees title="${TF.summary()}">税费设置</button>
    ${chk('bg', '后台监控被压价', '每 5 分钟检查一次（页面开着才有效），有订单新被压价时提醒')}${chk('notify', '桌面通知', '浏览器桌面通知，需要允许通知权限')}${chk('sound', '提示音', '被压价时播放提示音')}${pushHtml()}</div>`;
}
// 消息推送：已设置的渠道显示开关，都没设置就给一个去设置的按钮
function pushHtml() {
  const chs = AP.readyList();
  if (!chs.length) return '<button type="button" class="btn btn-ghost btn-sm" data-ow-push-set title="在「预警 → 消息推送」里设置企业微信、邮箱、Server酱、钉钉等">消息推送</button>';
  return chs.map(([ch, label]) => `<label class="pi-check" title="被压价时推送到${label}（在「预警 → 消息推送」里设置）"><input type="checkbox" data-ow-push="${ch}"${AP.uses(ch, 'order') ? ' checked' : ''}${SET.bg ? '' : ' disabled'}><span>${label}</span></label>`).join('');
}

function draw(box) {
  const { esc, formatPrice: px, formatNumber: num } = ctx;
  const rows = S.rows || [];
  const cnt = (s) => rows.filter((r) => r.state === s).length;
  const now = Date.now();
  const STATE = {
    under: (r) => `<span class="ow-state under">${r.tie ? '同价' : '被压 ' + px(r.gap)}</span>`,
    lead: (r) => `<span class="ow-state lead">领先 ${px(r.lead)}</span>`,
    alone: () => '<span class="ow-state alone">只有我</span>',
    unknown: (r) => `<span class="ow-state unknown" title="${esc(r.why || '')}">无法判断</span>`
  };
  const L = S.ledger || { o: {}, cost: {} };
  const f = TF.fees();
  const pct = (v) => (v * 100).toFixed(1) + '%';
  // 剩余利润率：收单 = 同站最低卖价扣税费 vs 收购价 + 分摊费用；卖单 = 到手单价 vs 平均收购成本
  const profitOf = (o, price, fees, sellRef) => {
    const rate = TF.brokerAt(o.location_id);
    if (o.is_buy_order) {
      if (sellRef == null) return null;
      const unit = price + fees / o.volume_total;
      return { m: (sellRef * (1 - f.sales - rate) - unit) / unit, tip: `每件成本 ${px(unit)}（含费用）· 同站最低卖价 ${px(sellRef)} 扣销售税与中介费后 ${px(sellRef * (1 - f.sales - rate))}` };
    }
    const net = price * (1 - f.sales) - fees / o.volume_total;
    const cost = avgCost(L, o.type_id);
    if (cost == null) return { net, tip: `每件到手 ${px(net)}（扣销售税与分摊费用）；没有这个物品的收单成交记录，算不了利润` };
    return { m: (net - cost) / cost, tip: `每件到手 ${px(net)} · 平均收购成本 ${px(cost)}（你的收单成交记录，含费用）` };
  };
  const marginHtml = (p) => {
    if (!p) return '—';
    if (p.m == null) return `<span class="text-muted" title="${esc(p.tip)}">到手 ${ctx.formatISK(p.net)}</span>`;
    return `<b class="ow-margin ${p.m <= 0 ? 'bad' : p.m < 0.05 ? 'thin' : 'ok'}" title="${esc(p.tip)}">${pct(p.m)}</b>`;
  };
  // 和估价页一样点价格复制（不带分隔符，方便粘贴到游戏里）
  const cp = (v) => `<span class="ap-cp" data-ow-cp="${Math.round(v * 100) / 100}" title="点击复制">${px(v)}</span>`;
  const EV = { new: '新挂单', mod: '改价', fill: '成交', end: '结束' };
  const body = rows.map((r) => {
    const o = r.o;
    const e = L.o[o.order_id];
    const fees = feesOf(e);
    const p = profitOf(o, o.price, fees, r.sellRef);
    // 按建议价改单：本次改单费与改后的利润率
    const rel = r.sug != null ? TF.relistFee(TF.brokerAt(o.location_id), o.price, r.sug, o.volume_remain) : 0;
    const after = r.sug != null ? profitOf(o, r.sug, fees + rel, r.sellRef) : null;
    const hist = S.open?.has(o.order_id) && e ? `<tr class="ow-hist"><td colspan="10"><ul>${e.h.map(([at, pr, left, ev]) => `<li><span class="text-muted">${new Date(at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> ${EV[ev] || ev} <b>${px(pr)}</b> 剩 ${num(left)}</li>`).join('')}</ul>
      <small class="text-muted"><span>中介费 ${ctx.formatISK(e.fee)} · 改单费 ${ctx.formatISK(e.rel)}（${e.n} 次）</span> · <span>两次读取之间多次改单只能记一次</span></small></td></tr>` : '';
    const cool = COOLDOWN - (now - Date.parse(o.issued || 0));
    return `<tr class="ow-${r.state}">
      <td><div class="ow-name-cell"><button class="link-btn ow-item" data-ow-item="${o.type_id}"><img src="https://images.evetech.net/types/${o.type_id}/icon?size=32" data-item-pop="${o.type_id}" alt="" width="20" height="20" loading="lazy">${esc(ctx.typeName(o.type_id))}</button><button type="button" class="ow-name-copy" data-ow-name="${o.type_id}" title="复制名称" aria-label="复制名称">${ICON_COPY}</button></div></td>
      <td>${o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>'}</td>
      <td class="pi-hide-sm ow-loc">${esc(ctx.locationName(o.location_id))}</td>
      <td class="num">${cp(o.price)}</td>
      <td class="num">${e ? `<button class="link-btn" data-ow-hist="${o.order_id}">${marginHtml(p)}</button>` : marginHtml(p)}</td>
      <td class="num">${r.best != null ? cp(r.best) + `<small class="text-muted"> ×${num(r.bestVol)}</small>` : '—'}</td>
      <td>${STATE[r.state](r)}</td>
      <td class="num">${r.sug != null ? `<button class="btn btn-ghost btn-sm ow-copy" data-ow-copy="${r.sug}" title="复制后在游戏里修改订单粘贴">${px(r.sug)}</button><small class="text-muted ow-cool">改单费 ${ctx.formatISK(rel)}${after?.m != null ? ` · 改后 ${pct(after.m)}` : ''}</small>${cool > 0 ? `<small class="text-muted ow-cool" title="订单修改后 5 分钟内不能再改">${Math.ceil(cool / 60e3)} 分钟后可改</small>` : ''}` : '—'}</td>
      <td class="num pi-hide-sm">${e ? `<button class="link-btn ow-fee" data-ow-hist="${o.order_id}" title="点开看这张单的记录">${ctx.formatISK(fees)}${e.n ? `<small> · 改 ${e.n} 次</small>` : ''}</button>` : '—'}</td>
      <td class="num pi-hide-sm">${num(o.volume_remain)} / ${num(o.volume_total)}</td></tr>${hist}`;
  }).join('');
  box.innerHTML = settingsHtml() + reportHtml(S.report) + `
    <div class="ow-sum"><span class="ow-state under">被压 ${cnt('under')}</span><span class="ow-state lead">领先 ${cnt('lead')}</span><span class="ow-state alone">只有我 ${cnt('alone')}</span>${cnt('unknown') ? `<span class="ow-state unknown">无法判断 ${cnt('unknown')}</span>` : ''}
      ${cnt('under') ? `<button type="button" class="btn btn-ghost btn-sm" data-ow-under-cart title="被压订单的物品一键加入购物车，在购物车里复制到游戏，就不用来回切换看哪些被压了">${ICON_CART}被压的加入购物车</button>` : ''}
      <span class="text-muted" title="对手价再让一档（4 位有效数字）">点价格复制</span></div>
    <div class="table-scroll"><table class="pc-mini-table ow-table"><thead><tr><th>物品</th><th>方向</th><th class="pi-hide-sm">位置</th><th class="num">我的价格</th><th class="num" title="收单：同站最低卖价扣税费后，比每件成本（含已付中介费与改单费）；卖单：每件到手比平均收购成本">剩余利润</th><th class="num">对手最优</th><th>状态</th><th class="num">建议价</th><th class="num pi-hide-sm">已付费用</th><th class="num pi-hide-sm">剩余 / 总量</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="pi-note" title="卖单只和同一空间站 / 建筑的卖单比；收单还算上星系 / 星域范围的收单">玩家建筑订单需「建筑市场」权限</p>`;
}

export async function onClick(e, box) {
  const t = e.target;
  const copy = t.closest('[data-ow-copy]');
  if (copy) { ctx.copyText(copy.dataset.owCopy, '已复制建议价 ' + copy.dataset.owCopy); return true; }
  const nm = t.closest('[data-ow-name]');
  if (nm) { ctx.copyText(ctx.typeName(Number(nm.dataset.owName)), '已复制名称'); return true; }
  if (t.closest('[data-ow-under-cart]')) {
    // 被压的订单的物品（同一物品只加一次，每种 1 件）
    const ids = [...new Set((S.rows || []).filter((r) => r.state === 'under').map((r) => r.o.type_id))];
    if (ids.length) ctx.addToCart(ids.map((id) => ({ id, name: ctx.typeName(id), qty: 1 })));
    return true;
  }
  const cp = t.closest('[data-ow-cp]');
  if (cp) { ctx.copyText(cp.dataset.owCp, '已复制 ' + cp.dataset.owCp); return true; }
  if (t.closest('[data-ow-fees]')) { TF.openFeeDialog(); return true; }
  if (t.closest('[data-ow-push-set]')) { ctx.openPush(); return true; }
  const hist = t.closest('[data-ow-hist]');
  if (hist) {
    S.open = S.open || new Set();
    const id = Number(hist.dataset.owHist);
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    draw(box);
    return true;
  }
  const item = t.closest('[data-ow-item]');
  if (item) { ctx.selectItem(Number(item.dataset.owItem)); return true; }
  if (t.closest('[data-ow-refresh]')) {
    S.market.clear(); S.structs.clear();
    S.busy = true; draw(box);
    S.rows = await analyze(S.orders || []);
    S.checkedAt = Date.now(); S.busy = false;
    rememberAlerted(S.rows);
    if (ctx.isActive()) draw(box);
    return true;
  }
  return false;
}

export function onChange(e, box) {
  const p = e.target.closest('[data-ow-push]');
  if (p) { AP.setUse(p.dataset.owPush, 'order', p.checked); return true; }
  const t = e.target.closest('[data-ow-set]');
  if (!t) return false;
  SET[t.dataset.owSet] = t.checked;
  if (t.dataset.owSet === 'notify' && t.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  saveSet();
  if (SET.bg) startBackground(); else stopBackground();
  if (S.rows) draw(box); else box.querySelector('.ow-bar')?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: settingsHtml() }).firstElementChild);
  return true;
}

// ---------- 后台监控 ----------
const alertKey = (r) => `${r.o.order_id}:${r.best}`;
function rememberAlerted(rows) {
  for (const r of rows) if (r.state === 'under') S.alerted.set(r.o.order_id, alertKey(r));
}
function startBackground() {
  stopBackground();
  S.timer = setInterval(backgroundCheck, POLL);
}
function stopBackground() { clearInterval(S.timer); S.timer = 0; }

async function backgroundCheck() {
  if (!ctx.hasEsiToken() || S.busy) return;
  try {
    S.busy = true;
    const token = await ctx.ensureEsiToken();
    const orders = await ctx.esiAuthFetch(`/characters/${token.character_id}/orders/`);
    if (!Array.isArray(orders)) return;
    await ctx.resolveTypeNames(orders.map((o) => o.type_id)).catch(() => {});
    S.market.clear(); S.structs.clear();
    const rows = await analyze(orders);
    const fresh = rows.filter((r) => r.state === 'under' && S.alerted.get(r.o.order_id) !== alertKey(r));
    S.orders = orders; S.rows = rows; S.checkedAt = Date.now(); S.charId = token.character_id;
    S.tracked = orders; S.ledger = track(token.character_id, orders);
    rememberAlerted(rows);
    if (fresh.length) notify(fresh);
  } catch { /* 下一轮再试 */ } finally { S.busy = false; }
}

function notify(list) {
  const text = list.slice(0, 3).map((r) => `${ctx.typeName(r.o.type_id)}（${r.o.is_buy_order ? '收' : '卖'} ${ctx.formatPrice(r.o.price)} → 对手 ${ctx.formatPrice(r.best)}）`).join('、') + (list.length > 3 ? ` 等 ${list.length} 张` : '');
  ctx.showToast('订单被压价：' + text, 'info', 8000);
  if (SET.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('EVE 订单被压价', { body: text, tag: 'eve-order-watch' }); } catch { /* 部分浏览器只允许 Service Worker 通知 */ }
  }
  if (SET.sound) beep();
  for (const r of list) {
    const o = r.o;
    AP.push('order', {
      sig: `order:${o.order_id}:${r.best}`,
      text: L(`${ctx.typeName(o.type_id)}：${o.is_buy_order ? '收单' : '卖单'} ${ctx.formatPrice(o.price)} 被压，对手 ${ctx.formatPrice(r.best)} · ${ctx.locationName(o.location_id)}`,
        `${ctx.typeName(o.type_id)}: ${o.is_buy_order ? 'buy' : 'sell'} order ${ctx.formatPrice(o.price)} undercut, best ${ctx.formatPrice(r.best)} · ${ctx.locationName(o.location_id)}`)
    });
  }
}
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.25);
    o.onended = () => ac.close();
  } catch { /* 忽略 */ }
}
export const watchState = () => ({ bg: SET.bg, under: (S.rows || []).filter((r) => r.state === 'under').length, at: S.checkedAt });
