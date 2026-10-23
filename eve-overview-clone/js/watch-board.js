// ===== 市场中心 ·「自选看板」（#watch）：收藏的物品同时看各交易中心价格，到价提醒 =====
// 物品就是市场中心的「收藏」（☆ / F 键）。每个物品一行：各交易中心最低卖价 / 最高收价（最便宜的卖价、最高的收价高亮）、
//   卖收价差、主交易中心日均成交，以及价格条（各中心卖价相对最低价的高低）。数据与单品「交易中心比价」相同（hub-compare.js，缓存 5 分钟）。
// 到价提醒：每个物品可设若干条「某交易中心 卖价 / 收价 ≤ / ≥ 某价」，看板开着或后台监控开着时每 5 分钟检查一次；
//   触发后网页提示（可选桌面通知、提示音），该条提醒停用，点「重新启用」再次监控。设置保存在本机。
import { loadHubs } from './hub-compare.js?v=v4';

let ctx = null;   // isGlobal, fetchESIPaged, regions, esc, formatISK, formatPrice, formatNumber, showToast, typeName, iconUrl, openItem, favorites, toggleFavorite, store, isActive
const KEY = 'eve-watch-board';
const POLL = 5 * 60e3;
const W = { alerts: {}, bg: false, notify: false, sound: false };
const S = { rows: new Map(), busy: false, at: 0, timer: 0, edit: 0 };

export function initWatchBoard(context) {
  ctx = context;
  Object.assign(W, ctx.store.getJSON(KEY, {}) || {});
  if (!W.alerts || typeof W.alerts !== 'object') W.alerts = {};
  if (W.bg && armedCount()) startBackground();
}
const save = () => ctx.store.setJSON(KEY, W);
const hubName = (r) => r.hub.name.split(' ')[0].replace(/海\d+$/, '') || r.name;
const armedCount = () => Object.values(W.alerts).flat().filter((a) => a.on).length;
export const hasArmedAlerts = () => armedCount() > 0;

async function loadAll(ids) {
  let i = 0;
  const work = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { S.rows.set(id, ctx.isGlobal(id) ? await loadGlobal(id) : await loadHubs(id)); } catch { S.rows.set(id, null); }
    }
  };
  await Promise.all([work(), work(), work()]);
  S.at = Date.now();
}

// 伊甸币等全服统一市场的物品：订单都在星域 19000001，不分交易中心
async function loadGlobal(id) {
  const orders = await ctx.fetchESIPaged(`/markets/19000001/orders/?order_type=all&type_id=${id}`);
  const sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price), buys = orders.filter((o) => o.is_buy_order).map((o) => o.price);
  const g = { region: { id: 19000001, name: '全服', hub: { name: '全服' } }, sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null, daily: 0, global: true };
  return ctx.regions.map((r) => ({ ...g, region: r, globalRow: true }));
}

export async function showWatchBoard(box) {
  const ids = ctx.favorites();
  if (!ids.length) { box.innerHTML = headHtml(ids) + '<div class="empty-state"><p>还没有收藏物品</p><p class="hint">在物品详情中点击 ☆ 或按 F 收藏，收藏的物品会出现在这里</p></div>'; return; }
  const missing = ids.filter((id) => !S.rows.has(id));
  if (missing.length || Date.now() - S.at > POLL) {
    if (!S.rows.size) box.innerHTML = headHtml(ids) + `<div class="pi-loading">读取 ${ids.length} 个物品在各交易中心的价格…</div>`;
    S.busy = true;
    await loadAll(Date.now() - S.at > POLL ? ids : missing);
    S.busy = false;
    checkAlerts();
    if (!ctx.isActive()) return;
  }
  draw(box);
  if (!S.timer) startBackground();
}

function headHtml(ids) {
  const chk = (k, label, title) => `<label class="pi-check" title="${title}"><input type="checkbox" data-wb-set="${k}"${W[k] ? ' checked' : ''}${k !== 'bg' && !W.bg ? ' disabled' : ''}><span>${label}</span></label>`;
  return `<div class="wb-head"><h2>自选看板</h2><span class="text-muted">${ids.length} 个收藏物品 · ${S.at ? '价格于 ' + new Date(S.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span>
    <span class="toolbar-spacer"></span><button class="btn btn-ghost btn-sm" data-wb-refresh ${S.busy ? 'disabled' : ''}>${S.busy ? '读取中…' : '刷新'}</button></div>
    <div class="wb-bar">${chk('bg', '离开看板也监控到价提醒', '看板关着时也每 5 分钟检查一次（网页开着才有效）')}${chk('notify', '桌面通知', '需要允许浏览器通知')}${chk('sound', '提示音', '触发时播放提示音')}
      <span class="text-muted">${armedCount() ? `${armedCount()} 条提醒监控中` : '点 🔔 给物品设到价提醒'}</span></div>`;
}

function draw(box) {
  const { esc, formatNumber: num } = ctx;
  const px = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? ctx.formatISK(v) : ctx.formatPrice(v));
  const ids = ctx.favorites();
  const regions = ctx.regions;
  const head = regions.map((r) => `<th class="num" colspan="2">${esc(hubName(r))}</th>`).join('');
  const sub = regions.map(() => '<th class="num wb-sub">卖</th><th class="num wb-sub">收</th>').join('');
  const rows = ids.map((id) => {
    const hubs = S.rows.get(id);
    if (!hubs) return `<tr><td>${itemCell(id)}</td><td colspan="${regions.length * 2 + 3}" class="text-muted">读取失败</td></tr>`;
    const sells = hubs.map((h) => h.sell).filter((v) => v != null), buys = hubs.map((h) => h.buy).filter((v) => v != null);
    const minSell = sells.length ? Math.min(...sells) : null, maxBuy = buys.length ? Math.max(...buys) : null;
    const main = hubs[0];
    const spread = main.sell != null && main.buy != null ? (main.sell - main.buy) / main.sell : null;
    const maxSell = sells.length ? Math.max(...sells) : null;
    const bars = hubs.map((h) => {
      const w = h.sell == null || !maxSell ? 0 : Math.max(6, (h.sell / maxSell) * 100);
      return `<i class="wb-b c${hubs.indexOf(h)}${h.sell === minSell ? ' best' : ''}" style="height:${w.toFixed(0)}%" title="${esc(hubName(h.region))} 卖 ${px(h.sell)}"></i>`;
    }).join('');
    const al = (W.alerts[id] || []);
    const alertChips = al.map((a, i) => {
      const r = regions.find((x) => x.id === a.hub) || regions[0];
      return `<span class="wb-alert${a.on ? '' : ' hit'}" title="${a.hit ? '已于 ' + new Date(a.hit).toLocaleString('zh-CN', { hour12: false }) + ' 触发' : '监控中'}">${esc(hubName(r))} ${a.side === 'buy' ? '收' : '卖'} ${a.op === 'le' ? '≤' : '≥'} ${px(a.price)}
        ${a.on ? '' : `<button class="link-btn" data-wb-rearm="${id}:${i}">重新启用</button>`}<button class="wb-x" data-wb-del="${id}:${i}" title="删除">✕</button></span>`;
    }).join('');
    const editor = S.edit === id ? `<tr class="wb-edit"><td colspan="${regions.length * 2 + 4}"><div class="wb-form">
        <select class="input" data-wb-f="hub">${regions.map((r) => `<option value="${r.id}">${esc(hubName(r))}</option>`).join('')}</select>
        <select class="input" data-wb-f="side"><option value="sell">卖价</option><option value="buy">收价</option></select>
        <select class="input" data-wb-f="op"><option value="le">≤ 低于</option><option value="ge">≥ 高于</option></select>
        <input class="input" type="number" min="0" step="any" data-wb-f="price" value="${main.sell ?? main.buy ?? ''}" placeholder="价格">
        <button class="btn btn-primary btn-sm" data-wb-add="${id}">添加提醒</button><button class="btn btn-ghost btn-sm" data-wb-cancel>取消</button></div></td></tr>` : '';
    return `<tr>
      <td>${itemCell(id)}${alertChips ? `<div class="wb-alerts">${alertChips}</div>` : ''}</td>
      ${main.globalRow ? `<td class="num wb-global" colspan="${regions.length * 2}">全服统一市场 · 卖 <b>${px(main.sell)}</b> · 收 <b>${px(main.buy)}</b></td>`
        : hubs.map((h) => `<td class="num${h.sell != null && h.sell === minSell ? ' wb-best-s' : ''}">${px(h.sell)}</td><td class="num${h.buy != null && h.buy === maxBuy ? ' wb-best-b' : ''}">${px(h.buy)}</td>`).join('')}
      <td class="num pi-hide-sm">${spread != null ? (spread * 100).toFixed(1) + '%' : '—'}</td>
      <td class="num pi-hide-sm">${main.daily ? num(Math.round(main.daily)) : '—'}</td>
      <td class="wb-bars pi-hide-sm">${main.globalRow ? '' : bars}</td>
      <td class="wb-ops"><button class="wb-icon${al.some((a) => a.on) ? ' on' : ''}" data-wb-bell="${id}" title="到价提醒">🔔</button><button class="wb-icon" data-wb-unfav="${id}" title="取消收藏">✕</button></td>
    </tr>${editor}`;
  }).join('');
  box.innerHTML = headHtml(ids) + `<div class="pi-card wb-card"><div class="table-scroll"><table class="pi-table wb-table">
    <thead><tr><th rowspan="2">物品</th>${head}<th rowspan="2" class="num pi-hide-sm" title="${esc(hubName(regions[0]))}（卖 − 收）÷ 卖">卖收差</th><th rowspan="2" class="num pi-hide-sm" title="${esc(regions[0].name)}星域 30 天日均成交">日均量</th><th rowspan="2" class="pi-hide-sm">卖价对比</th><th rowspan="2"></th></tr>
    <tr>${sub}</tr></thead><tbody>${rows}</tbody></table></div></div>
    <p class="pi-note">绿色 = 最便宜的卖价，蓝色 = 最高的收价；只算交易中心空间站内的订单。点物品名打开市场详情</p>`;
}

function itemCell(id) {
  return `<button class="link-btn wb-item" data-wb-item="${id}"><img src="${ctx.iconUrl(id)}" alt="" width="24" height="24" loading="lazy">${ctx.esc(ctx.typeName(id))}</button>`;
}

export async function onClick(e, box) {
  const t = e.target;
  const item = t.closest('[data-wb-item]');
  if (item) { ctx.openItem(Number(item.dataset.wbItem)); return; }
  if (t.closest('[data-wb-refresh]')) { S.at = 0; S.rows.clear(); showWatchBoard(box); return; }
  const bell = t.closest('[data-wb-bell]');
  if (bell) { S.edit = S.edit === Number(bell.dataset.wbBell) ? 0 : Number(bell.dataset.wbBell); draw(box); return; }
  if (t.closest('[data-wb-cancel]')) { S.edit = 0; draw(box); return; }
  const add = t.closest('[data-wb-add]');
  if (add) {
    const form = add.closest('.wb-form');
    const v = (k) => form.querySelector(`[data-wb-f="${k}"]`).value;
    const price = Number(v('price'));
    if (!(price > 0)) { ctx.showToast('填一个价格', 'error'); return; }
    const id = Number(add.dataset.wbAdd);
    (W.alerts[id] ||= []).push({ hub: Number(v('hub')), side: v('side'), op: v('op'), price, on: true });
    S.edit = 0; save();
    const now = checkAlerts();
    if (!now) ctx.showToast('已添加到价提醒', 'success', 1600);
    if (!S.timer) startBackground();
    draw(box); return;
  }
  const del = t.closest('[data-wb-del]');
  if (del) { const [id, i] = del.dataset.wbDel.split(':').map(Number); W.alerts[id]?.splice(i, 1); if (!W.alerts[id]?.length) delete W.alerts[id]; save(); draw(box); return; }
  const re = t.closest('[data-wb-rearm]');
  if (re) { const [id, i] = re.dataset.wbRearm.split(':').map(Number); const a = W.alerts[id]?.[i]; if (a) { a.on = true; delete a.hit; save(); } draw(box); return; }
  const unfav = t.closest('[data-wb-unfav]');
  if (unfav) { ctx.toggleFavorite(Number(unfav.dataset.wbUnfav)); draw(box); }
}

export function onChange(e, box) {
  const t = e.target.closest('[data-wb-set]');
  if (!t) return;
  W[t.dataset.wbSet] = t.checked;
  if (t.dataset.wbSet === 'notify' && t.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  save();
  if (W.bg) startBackground();
  draw(box);
}

// ---------- 到价提醒 ----------
function checkAlerts() {
  const hits = [];
  for (const [id, list] of Object.entries(W.alerts)) {
    const hubs = S.rows.get(Number(id));
    if (!hubs) continue;
    for (const a of list) {
      if (!a.on) continue;
      const h = hubs.find((x) => x.region.id === a.hub);
      const v = h?.[a.side];
      if (v == null) continue;
      if (a.op === 'le' ? v <= a.price : v >= a.price) { a.on = false; a.hit = Date.now(); hits.push({ id: Number(id), a, v, h }); }
    }
  }
  if (!hits.length) return 0;
  save();
  const px = (v) => (Math.abs(v) >= 1e6 ? ctx.formatISK(v) : ctx.formatPrice(v));
  const text = hits.slice(0, 3).map((x) => `${ctx.typeName(x.id)} ${hubName(x.h.region)}${x.a.side === 'buy' ? '收' : '卖'}价 ${px(x.v)}`).join('、') + (hits.length > 3 ? ` 等 ${hits.length} 条` : '');
  ctx.showToast('到价提醒：' + text, 'success', 8000);
  if (W.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('EVE 到价提醒', { body: text, tag: 'eve-watch-board' }); } catch { /* 忽略 */ }
  }
  if (W.sound) beep();
  return hits.length;
}

function startBackground() {
  clearInterval(S.timer);
  S.timer = setInterval(async () => {
    const active = ctx.isActive();
    if (!active && !(W.bg && armedCount())) return;
    const ids = active ? ctx.favorites() : Object.keys(W.alerts).map(Number).filter((id) => W.alerts[id].some((a) => a.on));
    S.busy = true;
    await loadAll(ids);
    S.busy = false;
    checkAlerts();
    if (ctx.isActive()) draw(document.getElementById('watchBody'));
  }, POLL);
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 660; g.gain.value = 0.08;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.3);
    o.onended = () => ac.close();
  } catch { /* 忽略 */ }
}
