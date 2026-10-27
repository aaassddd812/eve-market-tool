// ===== 市场中心 ·「自选看板」（#watch）：收藏的物品同时看各交易中心价格，到价提醒 =====
// 物品就是市场中心的「收藏」（☆ / F 键）。默认卡片视图，每个物品一张卡：主交易中心最低卖 / 最高收、日 / 7 日涨跌与 30 天走势
//   （主星域每日成交均价）、各交易中心卖价比主中心高低、一句话结论（去哪买便宜 / 卖给哪的收单、现价比 30 日均价高低）、到价提醒离触发还差多少。
//   也可切到表格视图（各中心卖 / 收一目了然）。可按涨跌、偏离均价、成交额、最接近触发的提醒排序。数据与单品「交易中心比价」相同（hub-compare.js，缓存 5 分钟）。
// 到价提醒：每个物品可设若干条「某交易中心 卖价 / 收价 ≤ / ≥ 某价」（或一键「卖价跌 / 涨 5%、10%」），看板开着或后台监控开着时每 5 分钟检查一次；
//   触发后网页提示（可选桌面通知、提示音），该条提醒停用，点「重新启用」再次监控。设置保存在本机。
import { loadHubs } from './hub-compare.js?v=v13';

let ctx = null;   // isGlobal, fetchESI, fetchESIPaged, regions, esc, formatISK, formatPrice, formatNumber, showToast, typeName, iconUrl, openItem, favorites, toggleFavorite, store, isActive
const KEY = 'eve-watch-board';
const POLL = 5 * 60e3;
const W = { alerts: {}, bg: false, notify: false, sound: false, view: 'card', sort: 'fav' };
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
  const [orders, history] = await Promise.all([
    ctx.fetchESIPaged(`/markets/19000001/orders/?order_type=all&type_id=${id}`),
    ctx.fetchESI(`/markets/19000001/history/?type_id=${id}`).catch(() => null)
  ]);
  const recent = Array.isArray(history) ? history.slice(-30) : [];
  const vol = recent.reduce((s, d) => s + d.volume, 0);
  const sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price), buys = orders.filter((o) => o.is_buy_order).map((o) => o.price);
  const g = { region: { id: 19000001, name: '全服', hub: { name: '全服' } }, sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null, daily: vol / 30, avg: vol ? recent.reduce((s, d) => s + d.average * d.volume, 0) / vol : null, hist: recent.map((d) => [d.date, d.average, d.volume]), global: true };
  return ctx.regions.map((r) => ({ ...g, region: r, globalRow: true }));
}

export async function showWatchBoard(box) {
  const ids = ctx.favorites();
  if (!ids.length) { box.innerHTML = headHtml(ids) + '<div class="empty-state"><p>还没有收藏物品</p><p class="hint">物品详情点 ☆ 或按 F 收藏</p></div>'; return; }
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

const px = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? ctx.formatISK(v) : ctx.formatPrice(v));
const pct = (v, digits = 1) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(digits) + '%');
const pp = (v) => (Math.abs(v) * 100).toFixed(1) + '%';   // 不带正负号
const dir = (v) => (v == null || Math.abs(v) < 0.0005 ? '' : v > 0 ? 'up' : 'down');

// 一个物品的汇总：主交易中心当前价、日 / 7 日涨跌（星域每日成交均价）、与 30 日均价的偏离、各中心最低卖 / 最高收
function stats(hubs) {
  const main = hubs[0];
  const h = (main.hist || []).filter((d) => d[1] > 0);
  const last = h.at(-1), prev = h.at(-2), wk = h.length > 7 ? h.at(-8) : h[0];
  const live = hubs.filter((x) => !x.globalRow || x === main);
  const sells = live.filter((x) => x.sell != null), buys = live.filter((x) => x.buy != null);
  const bestS = sells.length ? sells.reduce((a, b) => (b.sell < a.sell ? b : a)) : null;
  const bestB = buys.length ? buys.reduce((a, b) => (b.buy > a.buy ? b : a)) : null;
  return {
    main, h,
    d1: last && prev ? last[1] / prev[1] - 1 : null,
    d7: last && wk && wk !== last ? last[1] / wk[1] - 1 : null,
    vsAvg: main.sell != null && main.avg ? main.sell / main.avg - 1 : null,
    spread: main.sell != null && main.buy != null ? (main.sell - main.buy) / main.sell : null,
    turnover: (main.daily || 0) * (main.avg || main.sell || 0),
    bestS, bestB
  };
}

// 到价提醒离触发还差多少（当前价要变动的比例）
function alertGap(a, hubs) {
  const h = hubs?.find((x) => x.region.id === a.hub);
  const v = h?.[a.side];
  return v ? a.price / v - 1 : null;
}

function headHtml(ids) {
  const chk = (k, label, title) => `<label class="pi-check" title="${title}"><input type="checkbox" data-wb-set="${k}"${W[k] ? ' checked' : ''}${k !== 'bg' && !W.bg ? ' disabled' : ''}><span>${label}</span></label>`;
  const seg = (k, v, label) => `<button class="${W[k] === v ? 'active' : ''}" data-wb-${k}="${v}">${label}</button>`;
  return `<div class="wb-head"><h2>自选看板</h2><span class="text-muted">${ids.length} 个收藏物品 · ${S.at ? '价格于 ' + new Date(S.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span>
    <span class="toolbar-spacer"></span>
    ${ids.length ? `<select class="input wb-sort" data-wb-sort title="排序">${Object.entries(SORTS).map(([k, x]) => `<option value="${k}"${W.sort === k ? ' selected' : ''}>${x.label}</option>`).join('')}</select>
    <div class="segmented wb-seg">${seg('view', 'card', '卡片')}${seg('view', 'table', '表格')}</div>` : ''}
    <button class="btn btn-ghost btn-sm" data-wb-refresh ${S.busy ? 'disabled' : ''}>${S.busy ? '读取中…' : '刷新'}</button></div>
    <div class="wb-bar">${chk('bg', '后台监控到价', '看板关着时也每 5 分钟检查一次（网页开着才有效）')}${chk('notify', '桌面通知', '需要允许浏览器通知')}${chk('sound', '提示音', '触发时播放提示音')}
      <span class="text-muted">${armedCount() ? `${armedCount()} 条提醒监控中` : '点 🔔 给物品设到价提醒'}</span></div>`;
}

const SORTS = {
  fav: { label: '收藏顺序' },
  d7: { label: '7 日涨幅', key: (x) => x.d7 },
  d7r: { label: '7 日跌幅', key: (x) => (x.d7 == null ? null : -x.d7) },
  d1: { label: '日涨跌（绝对值）', key: (x) => (x.d1 == null ? null : Math.abs(x.d1)) },
  avg: { label: '低于 30 日均价', key: (x) => (x.vsAvg == null ? null : -x.vsAvg) },
  trade: { label: '日成交额', key: (x) => x.turnover || null },
  alert: { label: '最接近触发的提醒', key: (x) => (x.gap == null ? null : -x.gap) }
};

function sortedIds() {
  const ids = ctx.favorites();
  const sort = SORTS[W.sort];
  if (!sort?.key) return ids;
  const val = new Map(ids.map((id) => {
    const hubs = S.rows.get(id);
    if (!hubs) return [id, null];
    const st = stats(hubs);
    const gaps = (W.alerts[id] || []).filter((a) => a.on).map((a) => alertGap(a, hubs)).filter((g) => g != null).map(Math.abs);
    st.gap = gaps.length ? Math.min(...gaps) : null;
    return [id, sort.key(st)];
  }));
  return ids.slice().sort((a, b) => (val.get(b) ?? -Infinity) - (val.get(a) ?? -Infinity));
}

function draw(box) {
  const ids = sortedIds();
  box.innerHTML = headHtml(ids) + summaryHtml(ids) + (W.view === 'table' ? tableHtml(ids) : cardsHtml(ids));
}

// 顶部一行：7 日涨跌家数、已触发的提醒
function summaryHtml(ids) {
  let up = 0, down = 0, flat = 0;
  for (const id of ids) {
    const hubs = S.rows.get(id);
    const d7 = hubs ? stats(hubs).d7 : null;
    if (d7 == null) continue;
    if (d7 > 0.005) up++; else if (d7 < -0.005) down++; else flat++;
  }
  const hit = Object.values(W.alerts).flat().filter((a) => !a.on).length;
  if (!up && !down && !flat && !hit) return '';
  return `<div class="wb-summary"><span>近 7 日</span><b class="up">↑ ${up} 涨</b><b class="down">↓ ${down} 跌</b>${flat ? `<b class="text-muted">${flat} 持平</b>` : ''}
    ${hit ? `<span class="wb-sum-hit">🔔 ${hit} 条提醒已触发</span>` : ''}</div>`;
}

function spark(h, cls) {
  if (h.length < 2) return '<div class="wb-spark empty">暂无成交记录</div>';
  const vals = h.map((d) => d[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || hi || 1;
  const t0 = new Date(h[0][0]).getTime(), t1 = new Date(h.at(-1)[0]).getTime(), tw = t1 - t0 || 1;
  const pts = h.map((d) => [((new Date(d[0]).getTime() - t0) / tw) * 100, 28 - ((d[1] - lo) / span) * 24 - 2]);
  const line = pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
  return `<div class="wb-spark ${cls}" title="${ctx.esc(h[0][0])} ~ ${ctx.esc(h.at(-1)[0])} 每日成交均价"><svg viewBox="0 0 100 30" preserveAspectRatio="none">
      <polygon points="0,30 ${line} 100,30" class="area"/><polyline points="${line}" class="line" vector-effect="non-scaling-stroke"/></svg>
    <span class="lo">30 日低 ${px(lo)}</span><span class="hi">高 ${px(hi)}</span></div>`;
}

function cardsHtml(ids) {
  const { esc, formatNumber: num } = ctx;
  const cards = ids.map((id) => {
    const hubs = S.rows.get(id);
    const al = W.alerts[id] || [];
    const ops = `<div class="wb-ops"><button class="wb-icon${al.some((a) => a.on) ? ' on' : ''}" data-wb-bell="${id}" title="到价提醒">🔔</button><button class="wb-icon" data-wb-unfav="${id}" title="取消收藏">✕</button></div>`;
    if (!hubs) return `<div class="pi-card wb-c"><div class="wb-c-head">${itemCell(id)}${ops}</div><p class="text-muted">读取失败，稍后点刷新重试</p></div>`;
    const st = stats(hubs), { main } = st;
    const trend = st.d7 == null ? '' : st.d7 > 0.005 ? 'up' : st.d7 < -0.005 ? 'down' : '';
    const chg = (v, label) => `<span class="wb-chg ${dir(v)}"><small>${label}</small>${v == null ? '—' : (v > 0 ? '▲' : v < 0 ? '▼' : '') + pp(v)}</span>`;
    const mainName = main.globalRow ? '全服' : hubName(main.region);
    let hubsHtml = '';
    if (!main.globalRow && (st.bestS || st.bestB)) {
      hubsHtml = `<div class="wb-hubs"><div class="wb-hr wb-hr-h"><span></span><span>最低卖</span><span>比${esc(mainName)}</span><span>最高收</span></div>${hubs.map((x) => {
        const diff = x.sell != null && main.sell != null && x !== main ? x.sell / main.sell - 1 : null;
        return `<div class="wb-hr"><span>${esc(hubName(x.region))}</span>
          <span class="${x === st.bestS ? 'wb-best-s' : ''}">${px(x.sell)}</span>
          <span class="${diff == null ? 'text-muted' : diff < -0.0005 ? 'up' : diff > 0.0005 ? 'down' : 'text-muted'}">${x === main ? '基准' : pct(diff)}</span>
          <span class="${x === st.bestB ? 'wb-best-b' : ''}">${px(x.buy)}</span></div>`;
      }).join('')}</div>`;
    }
    // 一句话结论：去哪买最便宜、卖给哪个中心的收单最划算
    const tips = [];
    if (st.bestS && st.bestS !== main && main.sell != null && st.bestS.sell < main.sell * 0.99) tips.push(`在<b>${esc(hubName(st.bestS.region))}</b>买比${esc(mainName)}便宜 ${pp(1 - st.bestS.sell / main.sell)}`);
    if (st.bestB && st.bestB !== main && main.buy != null && st.bestB.buy > main.buy * 1.01) tips.push(`卖给<b>${esc(hubName(st.bestB.region))}</b>收单多得 ${pp(st.bestB.buy / main.buy - 1)}`);
    if (st.vsAvg != null && Math.abs(st.vsAvg) >= 0.03) tips.push(`现价比 30 日均价${st.vsAvg < 0 ? '<b class="up">低</b>' : '<b class="down">高</b>'} ${pp(st.vsAvg)}`);
    const alerts = al.map((a, i) => {
      const r = ctx.regions.find((x) => x.id === a.hub) || ctx.regions[0];
      const gap = a.on ? alertGap(a, hubs) : null;
      return `<span class="wb-alert${a.on ? '' : ' hit'}" title="${a.hit ? '已于 ' + new Date(a.hit).toLocaleString('zh-CN', { hour12: false }) + ' 触发' : '监控中'}">${esc(hubName(r))} ${a.side === 'buy' ? '收' : '卖'} ${a.op === 'le' ? '≤' : '≥'} ${px(a.price)}
        ${a.on ? (gap != null ? `<em>还差 ${pct(gap)}</em>` : '') : `<em>已触发</em><button class="link-btn" data-wb-rearm="${id}:${i}">重新启用</button>`}<button class="wb-x" data-wb-del="${id}:${i}" title="删除">✕</button></span>`;
    }).join('');
    return `<div class="pi-card wb-c${al.some((a) => !a.on) ? ' fired' : ''}">
      <div class="wb-c-head">${itemCell(id)}${ops}</div>
      <div class="wb-price"><div><small>${esc(mainName)}最低卖</small><b>${px(main.sell)}</b><span class="text-muted">收 ${px(main.buy)}${st.spread != null ? ` · 价差 ${pp(st.spread)}` : ''}</span></div>
        <div class="wb-chgs">${chg(st.d1, '日')}${chg(st.d7, '7 日')}</div></div>
      ${spark(st.h, trend)}
      ${hubsHtml}
      ${tips.length ? `<p class="wb-tip">${tips.join('；')}</p>` : ''}
      <div class="wb-c-foot"><span>日均成交 ${main.daily ? num(Math.round(main.daily)) : '—'}</span><span>日成交额 ${st.turnover ? ctx.formatISK(st.turnover) : '—'}</span></div>
      ${alerts ? `<div class="wb-alerts">${alerts}</div>` : ''}
      ${S.edit === id ? editorHtml(id, main) : ''}
    </div>`;
  }).join('');
  return `<div class="wb-grid">${cards}</div>
    <p class="pi-note" title="涨跌按${ctx.regions[0] ? ctx.esc(ctx.regions[0].name) : '主'}星域每日成交均价算；只算交易中心空间站内的订单">绿 = 最低卖价，蓝 = 最高收价</p>`;
}

function editorHtml(id, main) {
  const { esc } = ctx;
  const quick = main.sell != null ? [['le', 0.95, '卖价跌 5%'], ['le', 0.9, '跌 10%'], ['ge', 1.05, '涨 5%'], ['ge', 1.1, '涨 10%']]
    .map(([op, k, label]) => `<button class="btn btn-ghost btn-sm" data-wb-quick="${id}:${op}:${k}">${label}</button>`).join('') : '';
  return `<div class="wb-form">${quick ? `<div class="wb-quick"><span class="text-muted">快速设置（${esc(hubName(main.region))}）</span>${quick}</div>` : ''}
    <div class="wb-quick"><select class="input" data-wb-f="hub">${ctx.regions.map((r) => `<option value="${r.id}">${esc(hubName(r))}</option>`).join('')}</select>
    <select class="input" data-wb-f="side"><option value="sell">卖价</option><option value="buy">收价</option></select>
    <select class="input" data-wb-f="op"><option value="le">≤ 低于</option><option value="ge">≥ 高于</option></select>
    <input class="input" type="number" min="0" step="any" data-wb-f="price" value="${main.sell ?? main.buy ?? ''}" placeholder="价格">
    <button class="btn btn-primary btn-sm" data-wb-add="${id}">添加</button><button class="btn btn-ghost btn-sm" data-wb-cancel>取消</button></div></div>`;
}

function tableHtml(ids) {
  const { esc, formatNumber: num } = ctx;
  const regions = ctx.regions;
  const head = regions.map((r) => `<th class="num" colspan="2">${esc(hubName(r))}</th>`).join('');
  const sub = regions.map(() => '<th class="num wb-sub">卖</th><th class="num wb-sub">收</th>').join('');
  const rows = ids.map((id) => {
    const hubs = S.rows.get(id);
    if (!hubs) return `<tr><td>${itemCell(id)}</td><td colspan="${regions.length * 2 + 4}" class="text-muted">读取失败</td></tr>`;
    const st = stats(hubs), { main } = st;
    const al = W.alerts[id] || [];
    return `<tr${S.edit === id ? ' class="wb-editing"' : ''}>
      <td>${itemCell(id)}</td>
      ${main.globalRow ? `<td class="num wb-global" colspan="${regions.length * 2}">全服统一市场 · 卖 <b>${px(main.sell)}</b> · 收 <b>${px(main.buy)}</b></td>`
        : hubs.map((h) => `<td class="num${h === st.bestS ? ' wb-best-s' : ''}">${px(h.sell)}</td><td class="num${h === st.bestB ? ' wb-best-b' : ''}">${px(h.buy)}</td>`).join('')}
      <td class="num ${dir(st.d1)}">${pct(st.d1)}</td>
      <td class="num ${dir(st.d7)}">${pct(st.d7)}</td>
      <td class="num pi-hide-sm">${st.spread != null ? (st.spread * 100).toFixed(1) + '%' : '—'}</td>
      <td class="num pi-hide-sm">${main.daily ? num(Math.round(main.daily)) : '—'}</td>
      <td class="wb-ops"><button class="wb-icon${al.some((a) => a.on) ? ' on' : ''}" data-wb-bell="${id}" title="到价提醒${al.length ? '（' + al.length + ' 条）' : ''}">🔔</button><button class="wb-icon" data-wb-unfav="${id}" title="取消收藏">✕</button></td>
    </tr>${S.edit === id ? `<tr class="wb-edit"><td colspan="${regions.length * 2 + 6}">${editorHtml(id, main)}</td></tr>` : ''}`;
  }).join('');
  return `<div class="pi-card wb-card"><div class="table-scroll"><table class="pi-table wb-table">
    <thead><tr><th rowspan="2">物品</th>${head}<th rowspan="2" class="num" title="主星域每日成交均价，最近一天比前一天">日</th><th rowspan="2" class="num" title="主星域每日成交均价，最近一天比 7 天前">7 日</th><th rowspan="2" class="num pi-hide-sm" title="${esc(hubName(regions[0]))}（卖 − 收）÷ 卖">卖收差</th><th rowspan="2" class="num pi-hide-sm" title="${esc(regions[0].name)}星域 30 天日均成交">日均量</th><th rowspan="2"></th></tr>
    <tr>${sub}</tr></thead><tbody>${rows}</tbody></table></div></div>
    <p class="pi-note" title="只算交易中心空间站内的订单">绿 = 最低卖价，蓝 = 最高收价</p>`;
}

function itemCell(id) {
  return `<button class="link-btn wb-item" data-wb-item="${id}"><img src="${ctx.iconUrl(id)}" data-item-pop="${id}" alt="" width="24" height="24" loading="lazy">${ctx.esc(ctx.typeName(id))}</button>`;
}

export async function onClick(e, box) {
  const t = e.target;
  const item = t.closest('[data-wb-item]');
  if (item) { ctx.openItem(Number(item.dataset.wbItem)); return; }
  if (t.closest('[data-wb-refresh]')) { S.at = 0; S.rows.clear(); showWatchBoard(box); return; }
  const bell = t.closest('[data-wb-bell]');
  if (bell) { S.edit = S.edit === Number(bell.dataset.wbBell) ? 0 : Number(bell.dataset.wbBell); draw(box); return; }
  if (t.closest('[data-wb-cancel]')) { S.edit = 0; draw(box); return; }
  const view = t.closest('[data-wb-view]');
  if (view) { W.view = view.dataset.wbView; save(); draw(box); return; }
  const quick = t.closest('[data-wb-quick]');
  if (quick) {
    const [id, op, k] = quick.dataset.wbQuick.split(':');
    const main = S.rows.get(Number(id))?.[0];
    if (main?.sell == null) return;
    addAlert(Number(id), { hub: main.region.id, side: 'sell', op, price: Number((main.sell * Number(k)).toPrecision(4)) }, box);
    return;
  }
  const add = t.closest('[data-wb-add]');
  if (add) {
    const form = add.closest('.wb-form');
    const v = (k) => form.querySelector(`[data-wb-f="${k}"]`).value;
    const price = Number(v('price'));
    if (!(price > 0)) { ctx.showToast('填一个价格', 'error'); return; }
    addAlert(Number(add.dataset.wbAdd), { hub: Number(v('hub')), side: v('side'), op: v('op'), price }, box);
    return;
  }
  const del = t.closest('[data-wb-del]');
  if (del) { const [id, i] = del.dataset.wbDel.split(':').map(Number); W.alerts[id]?.splice(i, 1); if (!W.alerts[id]?.length) delete W.alerts[id]; save(); draw(box); return; }
  const re = t.closest('[data-wb-rearm]');
  if (re) { const [id, i] = re.dataset.wbRearm.split(':').map(Number); const a = W.alerts[id]?.[i]; if (a) { a.on = true; delete a.hit; save(); } draw(box); return; }
  const unfav = t.closest('[data-wb-unfav]');
  if (unfav) { ctx.toggleFavorite(Number(unfav.dataset.wbUnfav)); draw(box); }
}

function addAlert(id, a, box) {
  (W.alerts[id] ||= []).push({ ...a, on: true });
  S.edit = 0; save();
  const now = checkAlerts();
  if (!now) ctx.showToast('已添加到价提醒', 'success', 1600);
  if (!S.timer) startBackground();
  draw(box);
}

export function onChange(e, box) {
  if (e.target.matches('[data-wb-sort]')) { W.sort = e.target.value; save(); draw(box); return; }
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
