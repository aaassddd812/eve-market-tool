// ===== 个人中心 · 我的订单：改单小助手 + 订单变化报告 =====
// 改单小助手：每张挂单与同一地点的其他订单比价——
//   卖单：同一空间站 / 建筑里比我便宜的卖单；收单：同站收单，以及同星系范围不是「空间站」、或范围为「星域」的收单（跨星系的数字跳数范围不计，近似）。
//   有人比我好就标「被压」，建议价 = 对手价再让一档（游戏价格只保留 4 位有效数字，一档 = 10^(位数 − 4)），一键复制后到游戏里改单。
//   改单冷却：订单发布 / 上次修改后 5 分钟内不能再改（issued 即最后修改时间）。
//   星域订单：公开接口 /markets/{region}/orders/?type_id=&order_type=；玩家建筑：/markets/structures/{id}/（esi-markets.structure_markets.v1，整个建筑市场，缓存 5 分钟）。
// 订单变化报告：每次读取后把订单快照（剩余数量、价格）存在本机，下次和当前订单、/orders/history/（90 天已结束订单）对比，
//   列出新挂单、部分成交（成交数量 × 价格）、全部成交、过期、取消。
// 后台监控（默认关）：每 5 分钟检查一次，有订单新被压价时网页提示，可选桌面通知与提示音；关闭页面就停止。
// ESI 缓存：角色订单约 20 分钟、市场订单 5 分钟，所以「刷新」最快也是这个频率。

let ctx;   // esc, formatISK, formatPrice, formatNumber, showToast, copyText, fetchESI, fetchESIPaged, esiAuthFetch, ensureEsiToken, hasEsiToken, hasScope, typeName, locationName, resolveTypeNames, selectItem, store, serverKey, isActive
const SET_KEY = 'eve-order-watch';
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
      const sys = o.system_id || m.list.find((x) => x.location_id === o.location_id)?.system_id;
      const rivals = m.list.filter((x) => !mine.has(x.order_id) && x.is_buy_order === o.is_buy_order && (o.is_buy_order
        ? x.location_id === o.location_id || x.range === 'region' || (sys && x.system_id === sys && x.range !== 'station')
        : x.location_id === o.location_id));
      if (!rivals.length) { out.push({ o, state: 'alone' }); continue; }
      const best = o.is_buy_order ? Math.max(...rivals.map((x) => x.price)) : Math.min(...rivals.map((x) => x.price));
      const bestVol = rivals.filter((x) => x.price === best).reduce((t, x) => t + x.volume_remain, 0);
      const worse = o.is_buy_order ? best > o.price : best < o.price;
      const tie = best === o.price;
      out.push({ o, best, bestVol, rivals: rivals.length, state: worse || tie ? 'under' : 'lead', tie, gap: Math.abs(best - o.price), sug: worse || tie ? suggest(o, best) : null,
        lead: !worse && !tie ? Math.abs(o.price - best) : 0 });
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  const order = { under: 0, unknown: 1, lead: 2, alone: 3 };
  return out.sort((a, b) => order[a.state] - order[b.state] || ctx.typeName(a.o.type_id).localeCompare(ctx.typeName(b.o.type_id), 'zh'));
}

// ---------- 订单变化报告 ----------
async function buildReport(charId, orders) {
  const prev = ctx.store.getJSON(snapKey(charId), null);
  const snap = { at: Date.now(), o: Object.fromEntries(orders.map((o) => [o.order_id, [o.volume_remain, o.price, o.type_id, o.is_buy_order ? 1 : 0, o.volume_total]])) };
  ctx.store.setJSON(snapKey(charId), snap);
  if (!prev) return { first: true };
  const R = { since: prev.at, fresh: [], partial: [], filled: [], expired: [], cancelled: [] };
  const now = new Set(orders.map((o) => String(o.order_id)));
  for (const o of orders) {
    const p = prev.o[o.order_id];
    if (!p) R.fresh.push(o);
    else if (o.volume_remain < p[0]) R.partial.push({ o, qty: p[0] - o.volume_remain, isk: (p[0] - o.volume_remain) * o.price });
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
  R.empty = !R.fresh.length && !R.partial.length && !R.filled.length && !R.expired.length && !R.cancelled.length;
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
    ${chk('bg', '后台监控被压价', '每 5 分钟检查一次（页面开着才有效），有订单新被压价时提醒')}${chk('notify', '桌面通知', '浏览器桌面通知，需要允许通知权限')}${chk('sound', '提示音', '被压价时播放提示音')}</div>`;
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
  const body = rows.map((r) => {
    const o = r.o;
    const cool = COOLDOWN - (now - Date.parse(o.issued || 0));
    return `<tr class="ow-${r.state}">
      <td><button class="link-btn ow-item" data-ow-item="${o.type_id}"><img src="https://images.evetech.net/types/${o.type_id}/icon?size=32" data-item-pop="${o.type_id}" alt="" width="20" height="20" loading="lazy">${esc(ctx.typeName(o.type_id))}</button></td>
      <td>${o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>'}</td>
      <td class="pi-hide-sm ow-loc">${esc(ctx.locationName(o.location_id))}</td>
      <td class="num">${px(o.price)}</td>
      <td class="num">${r.best != null ? px(r.best) + `<small class="text-muted"> ×${num(r.bestVol)}</small>` : '—'}</td>
      <td>${STATE[r.state](r)}</td>
      <td class="num">${r.sug != null ? `<button class="btn btn-ghost btn-sm ow-copy" data-ow-copy="${r.sug}" title="复制后在游戏里修改订单粘贴">${px(r.sug)}</button>${cool > 0 ? `<small class="text-muted ow-cool" title="订单修改后 5 分钟内不能再改">${Math.ceil(cool / 60e3)} 分钟后可改</small>` : ''}` : '—'}</td>
      <td class="num pi-hide-sm">${num(o.volume_remain)} / ${num(o.volume_total)}</td></tr>`;
  }).join('');
  box.innerHTML = settingsHtml() + reportHtml(S.report) + `
    <div class="ow-sum"><span class="ow-state under">被压 ${cnt('under')}</span><span class="ow-state lead">领先 ${cnt('lead')}</span><span class="ow-state alone">只有我 ${cnt('alone')}</span>${cnt('unknown') ? `<span class="ow-state unknown">无法判断 ${cnt('unknown')}</span>` : ''}
      <span class="text-muted" title="对手价再让一档（4 位有效数字）">点建议价复制</span></div>
    <div class="table-scroll"><table class="pc-mini-table ow-table"><thead><tr><th>物品</th><th>方向</th><th class="pi-hide-sm">位置</th><th class="num">我的价格</th><th class="num">对手最优</th><th>状态</th><th class="num">建议价</th><th class="num pi-hide-sm">剩余 / 总量</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="pi-note" title="卖单只和同一空间站 / 建筑的卖单比；收单还算上星系 / 星域范围的收单">玩家建筑订单需「建筑市场」权限</p>`;
}

export async function onClick(e, box) {
  const t = e.target;
  const copy = t.closest('[data-ow-copy]');
  if (copy) { ctx.copyText(copy.dataset.owCopy, '已复制建议价 ' + copy.dataset.owCopy); return true; }
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
