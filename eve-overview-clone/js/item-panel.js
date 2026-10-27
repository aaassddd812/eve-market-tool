// ===== 单物品行情窗口：内容 =====
// 四个标签：市场数据（挂单表格 / 深度图）、价格历史（年 / 月走势与表格）、成交与制造（全部已绑定角色）、简单数据统计。
// 行情最多同时看两个市场；PLEX 走全服统一市场。标签、视图、时间范围、市场等浏览偏好记在本地，切换物品后沿用。
// 成交记录由本站服务器按角色存档（POST /api/kb/wallet/sync，令牌只用于向 ESI 证明是本人并读取，服务器不保存令牌），
// ESI 只给最近 30 天，存档会越积越长。制造只取已完成（待领取 / 已交付）的制造与反应任务，数量 = 流程数 × 每流程产量。
// 历史图：日均价、7 日均价（最近 7 个自然日内有效日均价的平均）、最高 / 最低价带、星域成交量、本站观察量（相邻两次挂单快照之间减少的数量）；
// 自己的买入 / 卖出按天合并为一个点（数量相加、价格按数量加权），制造点借用第一个市场当天（缺价取最近一天）的均价。
// 缩放只改变图上可见的日期；明细筛选只改变明细列表，都不重算统计。

let ctx = null;   // esc, formatISK, formatPrice, formatNumber, cssVar, server, regions, globalRegion, isGlobal, regionOrders, regionHistory,
                  // locationName, resolveStructureNames, accounts, accountToken, openEsiBind, showToast, typeName
const PREF_KEY = 'eve-item-panel';
const TABS = [['market', '市场数据'], ['history', '价格历史'], ['trades', '成交与制造'], ['stats', '数据统计']];
const MAX_MKTS = 2;
const BOOK_MAX = 500;   // 每边最多显示的挂单数（框内滚动）
const MINE_TTL = 3 * 60e3;
const OBS_TTL = 10 * 60e3;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const MKT_COLOR = ['--accent-primary', '#f59e0b'];
const MAKE_COLOR = '#a78bfa';
const DAY = 86400e3;

const pref = (() => {
  const d = { tab: 'market', mview: 'table', hubOnly: true, range: 'year', hview: 'chart', tx: 'all', char: 0, mkts: [], off: [] };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return d; }
})();
const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch { /* 无痕模式 */ } };

const mineCache = new Map();   // typeId -> { at, promise }
const obsCache = new Map();    // typeId -> { at, promise }

export function initItemPanel(context) { ctx = context; }

const color = (v) => (v.startsWith('--') ? ctx.cssVar(v) : v);
const hubLabel = (r) => (r.hub?.name || r.name).split(' ')[0].replace(/海\d+$/, '');
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
// 图表画在 canvas 上，页面翻译管不到：图例和提示文字自己过一遍翻译
const tr = (s) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(String(s)) : String(s));
const px = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? ctx.formatISK(v) : ctx.formatPrice(v));

export function mountItemPanel(host, typeId) {
  const root = document.createElement('div');
  root.className = 'ipc';
  host.replaceChildren(root);
  const M = { id: typeId, root, alive: true, charts: [], more: false, zoom: null, global: ctx.isGlobal(typeId) };
  M.markets = () => {
    if (M.global) return [{ id: ctx.globalRegion, name: '全服市场', hub: null }];
    const valid = pref.mkts.map((id) => ctx.regions.find((r) => r.id === id)).filter(Boolean);
    return valid.length ? valid.slice(0, MAX_MKTS) : [ctx.regions[0]];
  };
  root.addEventListener('click', (e) => onClick(M, e));
  root.addEventListener('change', (e) => onChange(M, e));
  render(M);
  return { destroy: () => { M.alive = false; destroyCharts(M); } };
}

function destroyCharts(M) {
  M.charts.forEach((c) => c.destroy());
  M.charts = [];
}

function render(M) {
  destroyCharts(M);
  const { root } = M;
  const tab = TABS.some(([k]) => k === pref.tab) ? pref.tab : 'market';
  root.innerHTML = `<div class="ipc-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" data-ipc-tab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="ipc-main" data-ipc-main></div>`;
  const main = root.querySelector('[data-ipc-main]');
  if (tab === 'market') renderMarket(M, main);
  else if (tab === 'history') renderHistory(M, main);
  else if (tab === 'trades') renderTrades(M, main);
  else renderStats(M, main);
}

function marketPicker(M) {
  if (M.global) return '<span class="text-muted ipc-global">PLEX 全服统一市场</span>';
  const sel = M.markets().map((r) => r.id);
  return `<div class="ipc-mkts" title="最多同时看 ${MAX_MKTS} 个市场">${ctx.regions.map((r) => {
    const k = sel.indexOf(r.id);
    return `<button type="button" class="ipc-chip${k >= 0 ? ' active' : ''}" data-ipc-mkt="${r.id}">${k >= 0 && sel.length > 1 ? `<i style="background:${color(MKT_COLOR[k])}"></i>` : ''}${ctx.esc(hubLabel(r))}</button>`;
  }).join('')}</div>`;
}

const seg = (key, items, cur) => `<div class="segmented ipc-seg">${items.map(([v, l]) => `<button type="button" data-ipc-${key}="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;

function onClick(M, e) {
  const t = e.target;
  const tab = t.closest('[data-ipc-tab]');
  if (tab) { pref.tab = tab.dataset.ipcTab; savePref(); M.zoom = null; render(M); return; }
  const mkt = t.closest('[data-ipc-mkt]');
  if (mkt) {
    const id = Number(mkt.dataset.ipcMkt);
    let sel = M.markets().map((r) => r.id);
    if (sel.includes(id)) { if (sel.length > 1) sel = sel.filter((x) => x !== id); }
    else sel = sel.length >= MAX_MKTS ? [sel[0], id] : [...sel, id];
    pref.mkts = sel;
    savePref();
    render(M);
    return;
  }
  for (const k of ['mview', 'range', 'hview', 'tx']) {
    const b = t.closest(`[data-ipc-${k}]`);
    if (b) { pref[k] = b.dataset[`ipc${k[0].toUpperCase()}${k.slice(1)}`]; savePref(); if (k === 'range') M.zoom = null; render(M); return; }
  }
  if (t.closest('[data-ipc-more]')) { M.more = !M.more; render(M); return; }
  if (t.closest('[data-ipc-unzoom]')) { M.zoom = null; applyZoom(M); return; }
  if (t.closest('[data-ipc-bind]')) { ctx.openEsiBind(); return; }
  if (t.closest('[data-ipc-reload]')) { mineCache.delete(M.id); loadMine(M.id, true); render(M); return; }
  if (t.closest('[data-ipc-forget]')) { forgetMine(M); return; }
  const p = t.closest('[data-ipc-price]');
  if (p) navigator.clipboard?.writeText(p.dataset.ipcPrice).then(() => ctx.showToast('价格已复制', 'success', 1200), () => {});
}

function onChange(M, e) {
  if (e.target.matches('[data-ipc-hub]')) { pref.hubOnly = e.target.checked; savePref(); render(M); return; }
  if (e.target.matches('[data-ipc-char]')) { pref.char = Number(e.target.value); savePref(); render(M); }
}

// ---------- 市场数据 ----------
async function renderMarket(M, main) {
  main.innerHTML = `<div class="ipc-bar">${marketPicker(M)}<span class="toolbar-spacer"></span>
      ${M.global ? '' : `<label class="pi-inline ipc-check"><input type="checkbox" data-ipc-hub${pref.hubOnly ? ' checked' : ''}><span>只看交易中心空间站</span></label>`}
      ${seg('mview', [['table', '表格'], ['depth', '深度图']], pref.mview)}</div>
    <div data-ipc-out><div class="pi-loading">读取挂单…</div></div>`;
  const out = main.querySelector('[data-ipc-out]');
  const mkts = M.markets();
  let books;
  try {
    books = await Promise.all(mkts.map(async (r) => {
      const all = await ctx.regionOrders(M.id, r.id);
      const list = !M.global && pref.hubOnly ? all.filter((o) => o.location_id === r.hub.id) : all;
      return { r, sells: list.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price), buys: list.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price) };
    }));
  } catch (err) {
    if (M.alive) out.innerHTML = `<p class="text-muted">读取失败：${ctx.esc(err.message)}</p>`;
    return;
  }
  if (!M.alive || !out.isConnected) return;
  const ids = [...new Set(books.flatMap((b) => [...b.sells, ...b.buys].map((o) => o.location_id)).filter((id) => id >= 1e12))];
  if (ids.length && !pref.hubOnly) await ctx.resolveStructureNames(ids).catch(() => {});
  if (!M.alive || !out.isConnected) return;
  const sum = books.map(({ r, sells, buys }, k) => {
    const s = sells[0]?.price, b = buys[0]?.price;
    return `<div class="ipc-sum">${books.length > 1 ? `<span class="ipc-dot" style="background:${color(MKT_COLOR[k])}"></span>` : ''}<b>${ctx.esc(M.global ? r.name : hubLabel(r))}</b>
      <span>最低卖 <b class="sell">${px(s)}</b></span><span>最高收 <b class="buy">${px(b)}</b></span>
      <span>价差 <b>${s && b ? ((s - b) / s * 100).toFixed(1) + '%' : '—'}</b></span>
      <span>卖单 <b>${ctx.formatNumber(sells.reduce((t, o) => t + o.volume_remain, 0))}</b></span>
      <span>收单 <b>${ctx.formatNumber(buys.reduce((t, o) => t + o.volume_remain, 0))}</b></span></div>`;
  }).join('');
  if (pref.mview === 'depth') {
    out.innerHTML = `${sum}<div class="ipc-chart"><canvas></canvas></div>`;
    drawDepth(M, out.querySelector('canvas'), books);
    return;
  }
  const loc = !pref.hubOnly || M.global;
  const table = (list, buy) => {
    const rows = list.slice(0, BOOK_MAX);
    return `<div class="ipc-book-box"><table class="pi-table ipc-book"><thead><tr><th class="num">${buy ? '收购价' : '出售价'}</th><th class="num">剩余</th>${buy ? '<th class="num" title="单笔最少卖给这张收单的数量">最小量</th>' : ''}${loc ? '<th>地点</th>' : ''}</tr></thead>
      <tbody>${rows.map((o) => `<tr><td class="num ${buy ? 'buy' : 'sell'}"><button type="button" class="ipc-price" data-ipc-price="${o.price.toFixed(2)}" title="复制价格">${ctx.formatPrice(o.price)}</button></td>
        <td class="num">${ctx.formatNumber(o.volume_remain)}</td>${buy ? `<td class="num">${o.min_volume > 1 ? ctx.formatNumber(o.min_volume) : '1'}</td>` : ''}
        ${loc ? `<td class="ipc-loc">${ctx.esc(ctx.locationName(o.location_id))}</td>` : ''}</tr>`).join('') || `<tr><td colspan="4" class="text-muted">没有${buy ? '收单' : '卖单'}</td></tr>`}</tbody></table></div>`;
  };
  out.innerHTML = sum + books.map((b, k) => `${books.length > 1 ? `<h4 class="ipc-h"><span class="ipc-dot" style="background:${color(MKT_COLOR[k])}"></span>${ctx.esc(hubLabel(b.r))}</h4>` : ''}
    <div class="ipc-books">${table(b.sells, false)}${table(b.buys, true)}</div>`).join('');
}

function chartBase() {
  const text = ctx.cssVar('--text-secondary'), grid = ctx.cssVar('--border-primary');
  return {
    text, grid,
    tooltip: { backgroundColor: ctx.cssVar('--bg-elevated'), titleColor: ctx.cssVar('--text-primary'), bodyColor: text, borderColor: grid, borderWidth: 1, padding: 10 },
    legend: { position: 'top', align: 'end', labels: { color: text, usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 12, font: { size: 11 } } }
  };
}

function drawDepth(M, canvas, books) {
  if (typeof Chart === 'undefined') { canvas.parentElement.innerHTML = '<p class="text-muted">图表库加载失败</p>'; return; }
  const B = chartBase();
  const s0 = books[0].sells[0]?.price, b0 = books[0].buys[0]?.price;
  const mid = s0 && b0 ? (s0 + b0) / 2 : s0 || b0;
  if (!mid) { canvas.parentElement.innerHTML = '<p class="text-muted">没有挂单</p>'; return; }
  const lo = mid * 0.7, hi = mid * 1.3;
  const cum = (list, inRange) => { let q = 0; const pts = []; for (const o of list) { if (!inRange(o.price)) break; q += o.volume_remain; pts.push({ x: o.price, y: q }); } return pts; };
  const sell = color('--sell-color'), buy = color('--buy-color');
  const ds = books.flatMap((b, k) => {
    const name = books.length > 1 ? tr(hubLabel(b.r)) + ' ' : '';
    const dash = k ? [5, 4] : [];
    return [
      { label: name + tr('卖单累计'), data: cum(b.sells, (p) => p <= hi), borderColor: sell, backgroundColor: sell + (k ? '10' : '26'), fill: 'origin', stepped: 'before', borderDash: dash, borderWidth: 1.5, pointRadius: 0 },
      { label: name + tr('收单累计'), data: cum(b.buys, (p) => p >= lo), borderColor: buy, backgroundColor: buy + (k ? '10' : '26'), fill: 'origin', stepped: 'before', borderDash: dash, borderWidth: 1.5, pointRadius: 0 }
    ];
  });
  M.charts.push(new Chart(canvas, {
    type: 'line',
    data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: B.legend,
        tooltip: { ...B.tooltip, callbacks: { title: (it) => ctx.formatPrice(it[0].parsed.x) + ' ISK', label: (c) => tr(`${c.dataset.label}：${ctx.formatNumber(c.parsed.y)}`) } }
      },
      scales: {
        x: { type: 'linear', min: lo, max: hi, grid: { color: B.grid }, ticks: { color: B.text, font: { size: 11 }, maxTicksLimit: 8, callback: (v) => ctx.formatISK(v) } },
        y: { beginAtZero: true, grid: { color: B.grid }, ticks: { color: B.text, font: { size: 11 }, callback: (v) => ctx.formatISK(v) } }
      }
    }
  }));
}

// ---------- 价格历史 ----------
function dayList(n) {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Array.from({ length: n }, (_, i) => utcDay(today - (n - 1 - i) * DAY));
}

function loadObs(id) {
  const hit = obsCache.get(id);
  if (hit && Date.now() - hit.at < OBS_TTL) return hit.promise;
  const regions = ctx.regions.map((r) => r.id).join(',');
  const promise = fetch(`/api/kb/obsvol?server=${ctx.server}&type=${id}&regions=${regions}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  obsCache.set(id, { at: Date.now(), promise });
  return promise;
}

async function historySeries(M, days) {
  const mkts = M.markets();
  const [hists, obs] = await Promise.all([Promise.all(mkts.map((r) => ctx.regionHistory(M.id, r.id).catch(() => []))), M.global ? null : loadObs(M.id)]);
  return mkts.map((r, k) => {
    const by = new Map((hists[k] || []).map((h) => [h.date, h]));
    const avg = days.map((d) => by.get(d)?.average ?? null);
    const ma = days.map((d, i) => {
      const w = [];
      for (let j = Math.max(0, i - 6); j <= i; j++) if (avg[j] != null) w.push(avg[j]);
      return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
    });
    // 7 日均价要用到窗口开头之前的日子：窗口第一周按完整历史补算
    const all = [...(hists[k] || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < Math.min(7, days.length); i++) {
      const end = Date.parse(days[i] + 'T00:00:00Z');
      const w = all.filter((h) => { const t = Date.parse(h.date + 'T00:00:00Z'); return t <= end && t > end - 7 * DAY; }).map((h) => h.average);
      ma[i] = w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
    }
    const o = obs?.regions?.[r.id] ? new Map(obs.regions[r.id].map(([d, a, b, c, e]) => [d, [a + b + c + e, a, b, c, e]])) : null;
    const obsSince = obs?.since?.[r.id] ? obs.since[r.id].slice(0, 10) : null;
    return {
      r, avg, ma,
      low: days.map((d) => by.get(d)?.lowest ?? null),
      high: days.map((d) => by.get(d)?.highest ?? null),
      vol: days.map((d) => by.get(d)?.volume ?? null),
      orders: days.map((d) => by.get(d)?.order_count ?? null),
      obs: o ? days.map((d) => (o.get(d)?.[0] ?? (obsSince && d >= obsSince ? 0 : null))) : null,
      obsDetail: o
    };
  });
}

async function renderHistory(M, main) {
  main.innerHTML = `<div class="ipc-bar">${marketPicker(M)}<span class="toolbar-spacer"></span>
      ${seg('range', [['year', '一年'], ['month', '30 天']], pref.range)}${seg('hview', [['chart', '图表'], ['table', '表格']], pref.hview)}</div>
    <div data-ipc-out><div class="pi-loading">读取历史…</div></div>`;
  const out = main.querySelector('[data-ipc-out]');
  const days = dayList(pref.range === 'month' ? 30 : 366);
  const series = await historySeries(M, days);
  if (!M.alive || !out.isConnected) return;
  const sumHtml = series.map((s, k) => {
    const valid = s.avg.map((v, i) => [v, i]).filter(([v]) => v != null);
    const last = valid[valid.length - 1];
    const lows = s.low.filter((v) => v != null), highs = s.high.filter((v) => v != null), vols = s.vol.filter((v) => v != null);
    const obs7 = s.obs ? s.obs.slice(-7).reduce((t, v) => t + (v || 0), 0) : null;
    return `<div class="ipc-sum">${series.length > 1 ? `<span class="ipc-dot" style="background:${color(MKT_COLOR[k])}"></span>` : ''}<b>${ctx.esc(M.global ? s.r.name : hubLabel(s.r))}</b>
      <span>均价 <b>${px(last?.[0])}</b>${last ? `<small class="text-muted"> ${days[last[1]].slice(5)}</small>` : ''}</span>
      <span>7 日均价 <b>${px(s.ma[s.ma.length - 1])}</b></span>
      <span>最高 <b>${px(highs.length ? Math.max(...highs) : null)}</b></span><span>最低 <b>${px(lows.length ? Math.min(...lows) : null)}</b></span>
      <span>日均成交 <b>${vols.length ? ctx.formatNumber(Math.round(vols.reduce((a, b) => a + b, 0) / days.length)) : '—'}</b></span>
      ${obs7 != null ? `<span title="本站最近 7 天在交易中心挂单快照里观察到的减少量">本站观察 7 天 <b>${ctx.formatNumber(obs7)}</b></span>` : ''}</div>`;
  }).join('');
  if (!series.some((s) => s.avg.some((v) => v != null))) { out.innerHTML = sumHtml + '<p class="text-muted ipc-empty">这段时间没有成交</p>'; return; }
  if (pref.hview === 'table') { out.innerHTML = sumHtml + historyTable(series, days); return; }
  out.innerHTML = `${sumHtml}<div class="ipc-chart ipc-chart-tall"><canvas></canvas></div>
    <div class="ipc-hint"><span class="text-muted">滚轮缩放，拖动平移，双击还原；点图例隐藏图层</span><button type="button" class="btn btn-ghost btn-sm ipc-unzoom" data-ipc-unzoom hidden>重置缩放</button></div>`;
  const canvas = out.querySelector('canvas');
  drawHistory(M, canvas, series, days, null);
  // 自己的买卖与制造：读到后叠加
  if (hasWalletAccount()) {
    loadMine(M.id).then((mine) => {
      if (!M.alive || !canvas.isConnected || !mine?.tx) return;
      destroyCharts(M);
      drawHistory(M, canvas, series, days, mine);
    }).catch(() => {});
  }
}

function historyTable(series, days) {
  const two = series.length > 1;
  const head = series.map((s) => `${two ? `<th colspan="${s.obs ? 6 : 5}" class="ipc-th-group">${ctx.esc(hubLabel(s.r))}</th>` : ''}`).join('');
  const cols = series.map((s) => `<th class="num">均价</th><th class="num">最低</th><th class="num">最高</th><th class="num">7 日均价</th><th class="num">成交量</th>${s.obs ? '<th class="num" title="本站挂单快照观察到的减少量">本站观察</th>' : ''}`).join('');
  const rows = [];
  for (let i = days.length - 1; i >= 0; i--) {
    if (!series.some((s) => s.avg[i] != null || s.obs?.[i])) continue;
    rows.push(`<tr><td>${days[i]}</td>${series.map((s) => `<td class="num">${px(s.avg[i])}</td><td class="num">${px(s.low[i])}</td><td class="num">${px(s.high[i])}</td><td class="num">${px(s.ma[i])}</td><td class="num">${s.vol[i] == null ? '—' : ctx.formatNumber(s.vol[i])}</td>${s.obs ? `<td class="num">${s.obs[i] == null ? '—' : ctx.formatNumber(s.obs[i])}</td>` : ''}`).join('')}</tr>`);
  }
  return `<div class="ipc-table-wrap"><table class="pi-table ipc-hist">${two ? `<thead><tr><th></th>${head}</tr>` : '<thead>'}<tr><th>日期（UTC）</th>${cols}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// 同一天同一方向的成交合并：数量相加、价格按数量加权
function markerSeries(mine, days, refAvg) {
  const idx = new Map(days.map((d, i) => [d, i]));
  const mk = () => ({ y: days.map(() => null), meta: days.map(() => null) });
  const buy = mk(), sell = mk(), make = mk();
  for (const t of mine.tx) {
    const i = idx.get(utcDay(t.date));
    if (i == null) continue;
    const s = t.buy ? buy : sell;
    const m = s.meta[i] || (s.meta[i] = { qty: 0, isk: 0, n: 0, chars: new Set() });
    m.qty += t.qty; m.isk += t.qty * t.price; m.n += 1; m.chars.add(t.name);
    s.y[i] = m.isk / m.qty;
  }
  const ref = (i) => { for (let j = i; j >= 0; j--) if (refAvg[j] != null) return refAvg[j]; for (let j = i + 1; j < refAvg.length; j++) if (refAvg[j] != null) return refAvg[j]; return null; };
  for (const j of mine.jobs) {
    const i = idx.get(utcDay(j.date));
    if (i == null) continue;
    const m = make.meta[i] || (make.meta[i] = { qty: 0, n: 0, chars: new Set() });
    m.qty += j.qty; m.n += 1; m.chars.add(j.name);
    make.y[i] = ref(i);
  }
  return { buy, sell, make };
}

function drawHistory(M, canvas, series, days, mine) {
  if (typeof Chart === 'undefined') { canvas.parentElement.innerHTML = '<p class="text-muted">图表库加载失败</p>'; return; }
  const B = chartBase();
  const dense = days.length > 60;
  const off = new Set(pref.off);
  const ds = [];
  series.forEach((s, k) => {
    const c = color(MKT_COLOR[k]);
    const name = series.length > 1 ? tr(hubLabel(s.r)) + ' ' : '';
    const base = { pointRadius: 0, pointHitRadius: 6, spanGaps: false, borderWidth: 1.5, tension: 0.2 };
    ds.push({ ...base, grp: `band${k}`, kind: 'low', label: name + tr('最高 / 最低价'), data: s.low, borderWidth: 0, fill: false });
    ds.push({ ...base, grp: `band${k}`, kind: 'high', first: true, label: name + tr('最高 / 最低价'), data: s.high, borderWidth: 0, backgroundColor: c + '22', borderColor: c + '22', fill: '-1', low: s.low });
    ds.push({ ...base, grp: `avg${k}`, kind: 'price', first: true, label: name + tr('日均价'), data: s.avg, borderColor: c, backgroundColor: c, pointRadius: dense ? 0 : 2 });
    ds.push({ ...base, grp: `ma${k}`, kind: 'price', first: true, label: name + tr('7 日均价'), data: s.ma, borderColor: c + 'aa', backgroundColor: c + 'aa', borderWidth: 1, borderDash: [6, 4], spanGaps: true });
    ds.push({ grp: `vol${k}`, kind: 'vol', first: true, type: 'bar', label: name + tr('成交量'), data: s.vol, yAxisID: 'y1', backgroundColor: c + '40', borderWidth: 0, barPercentage: 1, categoryPercentage: series.length > 1 ? 0.5 : 0.9 });
    if (s.obs) ds.push({ ...base, grp: `obs${k}`, kind: 'obs', first: true, label: name + tr('本站观察量'), data: s.obs, yAxisID: 'y1', borderColor: c, backgroundColor: c, borderWidth: 1, borderDash: [2, 3], detail: s.obsDetail, days });
  });
  if (mine) {
    const m = markerSeries(mine, days, series[0].avg);
    const tri = (grp, label, d, c, rot) => ({ grp, kind: 'mark', first: true, label, data: d.y, meta: d.meta, showLine: false, pointStyle: 'triangle', rotation: rot, pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: c, pointBorderColor: ctx.cssVar('--bg-secondary'), pointBorderWidth: 1, backgroundColor: c, borderColor: c, order: -1 });
    if (m.buy.y.some((v) => v != null)) ds.push(tri('buy', tr('我的买入'), m.buy, color('--buy-color'), 0));
    if (m.sell.y.some((v) => v != null)) ds.push(tri('sell', tr('我的卖出'), m.sell, color('--sell-color'), 180));
    if (m.make.y.some((v) => v != null)) ds.push(tri('make', tr('制造完成'), m.make, MAKE_COLOR, 0));
  }
  ds.forEach((d) => { d.hidden = off.has(d.grp); });
  const maxVol = Math.max(1, ...series.flatMap((s) => [...s.vol, ...(s.obs || [])].filter((v) => v != null)));
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels: days, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          ...B.legend,
          labels: { ...B.legend.labels, filter: (item, data) => data.datasets[item.datasetIndex].first },
          onClick: (e, item, legend) => {
            const grp = legend.chart.data.datasets[item.datasetIndex].grp;
            const hide = !off.has(grp);
            if (hide) off.add(grp); else off.delete(grp);
            legend.chart.data.datasets.forEach((d) => { if (d.grp === grp) d.hidden = hide; });
            pref.off = [...off];
            savePref();
            legend.chart.update('none');
          }
        },
        tooltip: {
          ...B.tooltip,
          filter: (it) => it.raw != null && it.dataset.kind !== 'low',
          callbacks: {
            title: (it) => `${it[0].label} (UTC)`,
            label: (c) => tr(tipLabel(c))
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: B.text, maxTicksLimit: 10, maxRotation: 0, font: { size: 11 }, callback(v) { const d = this.getLabelForValue(v); return dense ? d.slice(2, 7) : d.slice(5); } } },
        y: { position: 'left', grid: { color: B.grid }, ticks: { color: B.text, font: { size: 11 }, callback: (v) => ctx.formatISK(v) } },
        y1: { position: 'right', beginAtZero: true, suggestedMax: maxVol * 3, grid: { drawOnChartArea: false }, ticks: { color: B.text, font: { size: 11 }, callback: (v) => ctx.formatISK(v) } }
      }
    }
  });
  M.charts.push(chart);
  M.days = days.length;
  bindZoom(M, canvas, chart);
  applyZoom(M);
}

function tipLabel(c) {
  const d = c.dataset, i = c.dataIndex;
  if (d.kind === 'high') return `${d.label}：${px(c.raw)} / ${px(d.low[i])}`;
  if (d.kind === 'vol') return `${d.label}：${ctx.formatNumber(c.raw)}`;
  if (d.kind === 'obs') {
    const x = d.detail?.get(d.days[i]);
    return x ? `${d.label}：${ctx.formatNumber(x[0])}（卖单减少 ${ctx.formatNumber(x[1] + x[3])} · 收单减少 ${ctx.formatNumber(x[2] + x[4])}）` : `${d.label}：0`;
  }
  if (d.kind === 'mark') {
    const m = d.meta[i];
    const who = [...m.chars].join('、');
    if (d.grp === 'make') return `${d.label}：${ctx.formatNumber(m.qty)} 件 · ${m.n} 个任务 · ${who}`;
    return `${d.label}：${ctx.formatNumber(m.qty)} 件 @ ${px(m.isk / m.qty)} · ${m.n} 笔 · ${who}`;
  }
  return `${d.label}：${px(c.raw)}`;
}

// 缩放：滚轮以指针处为中心放大 / 缩小，按住拖动平移，双击还原（只改可见日期）
function bindZoom(M, canvas, chart) {
  if (canvas.dataset.zoom) return;
  canvas.dataset.zoom = '1';
  const cur = () => M.zoom || [0, M.days - 1];
  canvas.addEventListener('wheel', (e) => {
    const c = M.charts[M.charts.length - 1];
    if (!c) return;
    e.preventDefault();
    const [a, b] = cur();
    const at = Math.min(b, Math.max(a, c.scales.x.getValueForPixel(e.offsetX) ?? (a + b) / 2));
    const span = Math.min(M.days - 1, Math.max(6, Math.round((b - a) * (e.deltaY > 0 ? 1.25 : 0.8))));
    let lo = Math.round(at - (at - a) / (b - a || 1) * span);
    lo = Math.max(0, Math.min(M.days - 1 - span, lo));
    M.zoom = span >= M.days - 1 ? null : [lo, lo + span];
    applyZoom(M);
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (M.zoom && e.button === 0) { drag = { x: e.clientX, z: M.zoom }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = M.charts[M.charts.length - 1];
    const per = c.chartArea.width / (drag.z[1] - drag.z[0] + 1);
    const shift = Math.round((drag.x - e.clientX) / per);
    const span = drag.z[1] - drag.z[0];
    const lo = Math.max(0, Math.min(M.days - 1 - span, drag.z[0] + shift));
    if (lo !== M.zoom[0]) { M.zoom = [lo, lo + span]; applyZoom(M); }
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('dblclick', () => { M.zoom = null; applyZoom(M); });
}

function applyZoom(M) {
  const c = M.charts[M.charts.length - 1];
  if (!c || !c.options.scales.y1) return;
  c.options.scales.x.min = M.zoom ? M.zoom[0] : undefined;
  c.options.scales.x.max = M.zoom ? M.zoom[1] : undefined;
  c.update('none');
  const btn = M.root.querySelector('[data-ipc-unzoom]');
  if (btn) btn.hidden = !M.zoom;
}

// ---------- 成交与制造（服务器存档，全部已绑定角色） ----------
const walletAccounts = () => ctx.accounts().filter((a) => a.scopes.includes(WALLET_SCOPE));
const hasWalletAccount = () => walletAccounts().length > 0;

function loadMine(id, force = false) {
  const hit = mineCache.get(id);
  if (!force && hit && Date.now() - hit.at < MINE_TTL) return hit.promise;
  const promise = (async () => {
    const accts = walletAccounts();
    const res = await Promise.all(accts.map(async (a) => {
      try {
        const token = await ctx.accountToken(a.id);
        const r = await fetch('/api/kb/wallet/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.access_token },
          body: JSON.stringify({ server: ctx.server, character_id: a.id, type_id: id, force })
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error?.message || body.error || 'HTTP ' + r.status);
        return { a, body };
      } catch (e) {
        return { a, error: e.message };
      }
    }));
    const tx = [], jobs = [], fees = [], status = [];
    for (const { a, body, error } of res) {
      status.push({ id: a.id, name: a.name, error: error || body.error, stale: body?.stale, synced: body?.synced_at, first: body?.first_date, n: body?.tx?.length || 0 });
      if (!body) continue;
      for (const [txId, date, qty, price, buy, loc] of body.tx || []) tx.push({ id: txId, char: a.id, name: a.name, date: date * 1000, qty, price, buy: !!buy, loc });
      for (const [jobId, date, qty, runs, act, st, loc] of body.jobs || []) jobs.push({ id: jobId, char: a.id, name: a.name, date: date * 1000, qty, runs, act, st, loc });
      for (const [date, kind, amount] of body.fees || []) fees.push({ char: a.id, date: date * 1000, kind, amount });
    }
    tx.sort((a, b) => b.date - a.date);
    jobs.sort((a, b) => b.date - a.date);
    const locs = [...new Set([...tx, ...jobs].map((x) => x.loc).filter((l) => l >= 1e12))];
    if (locs.length) await ctx.resolveStructureNames(locs).catch(() => {});
    return { tx, jobs, fees, status };
  })();
  mineCache.set(id, { at: Date.now(), promise });
  promise.catch(() => mineCache.delete(id));
  return promise;
}

async function forgetMine(M) {
  const accts = walletAccounts();
  if (!accts.length || !confirm(tr(`删除本站服务器上 ${accts.map((a) => a.name).join('、')} 的全部成交、税费与制造存档？\n（只删本站存档，不影响游戏；之后打开会重新从 ESI 读取最近 30 天）`))) return;
  let n = 0;
  for (const a of accts) {
    try {
      const token = await ctx.accountToken(a.id);
      const r = await fetch('/api/kb/wallet/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.access_token }, body: JSON.stringify({ server: ctx.server, character_id: a.id }) });
      if (r.ok) n += 1;
    } catch { /* 下面提示失败数 */ }
  }
  mineCache.clear();
  ctx.showToast(n === accts.length ? '已删除服务器存档' : `${accts.length - n} 个角色删除失败`, n === accts.length ? 'success' : 'error');
  if (M.alive) render(M);
}

function noAccount() {
  return `<div class="ipc-empty"><p class="text-muted">绑定 ESI（需要钱包权限）后显示自己各角色的买卖和制造记录</p><button type="button" class="btn btn-primary btn-sm" data-ipc-bind>绑定 ESI</button></div>`;
}

function statusLine(mine) {
  const first = mine.status.map((s) => s.first).filter(Boolean).sort()[0];
  const errs = mine.status.filter((s) => s.error);
  return `<div class="ipc-status text-muted"><span>${mine.status.length} 个角色${first ? ` · 存档自 ${first.slice(0, 10)}` : ''}</span>
      ${errs.length ? `<span class="down" title="${ctx.esc(errs.map((s) => `${s.name}：${s.error}`).join('\n'))}">${errs.length} 个角色读取失败${errs.every((s) => s.stale) ? '（显示存档）' : ''}</span>` : ''}
      <span class="toolbar-spacer"></span>
      <button type="button" class="btn btn-ghost btn-sm" data-ipc-reload title="立即从 ESI 同步（每个角色每分钟最多一次）">同步</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ipc-forget title="成交记录按角色存在本站服务器，便于积累超过 ESI 30 天的历史">删除存档</button></div>`;
}

async function renderTrades(M, main) {
  if (!hasWalletAccount()) { main.innerHTML = noAccount(); return; }
  main.innerHTML = '<div class="pi-loading">读取成交记录…</div>';
  const [mine, series] = await Promise.all([loadMine(M.id), historySeries(M, dayList(366)).catch(() => null)]);
  if (!M.alive || !main.isConnected) return;
  const chars = mine.status;
  const charSel = chars.length > 1 ? `<select class="pi-input ipc-select" data-ipc-char><option value="0">全部角色</option>${chars.map((c) => `<option value="${c.id}"${pref.char === c.id ? ' selected' : ''}>${ctx.esc(c.name)}</option>`).join('')}</select>` : '';
  const byChar = (x) => !pref.char || !chars.some((c) => c.id === pref.char) || x.char === pref.char;
  const rows = [
    ...(pref.tx === 'make' ? [] : mine.tx.filter((t) => byChar(t) && (pref.tx === 'all' || (pref.tx === 'buy') === t.buy)).map((t) => ({ ...t, k: t.buy ? 'buy' : 'sell' }))),
    ...(pref.tx === 'all' || pref.tx === 'make' ? mine.jobs.filter(byChar).map((j) => ({ ...j, k: 'make' })) : [])
  ].sort((a, b) => b.date - a.date);
  // 制造没有成交价：取第一个市场当天（缺价取最近一天）的历史均价作参考
  const days = dayList(366);
  const refAt = (t) => {
    const avg = series?.[0]?.avg;
    if (!avg) return null;
    let i = days.indexOf(utcDay(t));
    if (i < 0) i = avg.length - 1;
    for (let j = i; j >= 0; j--) if (avg[j] != null) return avg[j];
    return null;
  };
  const LABEL = { buy: '▲ 买入', sell: '▼ 卖出', make: '▲ 制造' };
  const shown = M.more ? rows : rows.slice(0, 200);
  main.innerHTML = `<div class="ipc-bar">${seg('tx', [['all', '全部'], ['buy', '买入'], ['sell', '卖出'], ['make', '制造']], pref.tx)}${charSel}</div>
    ${statusLine(mine)}
    ${rows.length ? `<div class="ipc-table-wrap"><table class="pi-table ipc-tx"><thead><tr><th>时间</th><th>类型</th><th>角色</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th>地点</th></tr></thead><tbody>
      ${shown.map((r) => {
        const ref = r.k === 'make' ? refAt(r.date) : null;
        return `<tr><td class="ipc-nowrap">${fmtTime(r.date)}</td><td><span class="ipc-kind ${r.k}">${LABEL[r.k]}</span></td><td>${ctx.esc(r.name)}</td>
        <td class="num">${ctx.formatNumber(r.qty)}${r.k === 'make' ? `<small class="text-muted" title="流程数"> ×${r.runs}</small>` : ''}</td>
        <td class="num">${r.k === 'make' ? `<span class="text-muted" title="第一个市场当天的历史均价">市场参考 ${px(ref)}</span>` : px(r.price)}</td>
        <td class="num">${r.k === 'make' ? '<span class="text-muted">不计入盈亏</span>' : `<span class="${r.buy ? 'down' : 'up'}">${r.buy ? '−' : '+'}${ctx.formatISK(r.qty * r.price)}</span>`}</td>
        <td class="ipc-loc">${r.loc ? ctx.esc(ctx.locationName(r.loc)) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${rows.length > shown.length || M.more ? `<button type="button" class="btn btn-ghost btn-sm ipc-more" data-ipc-more>${M.more ? '收起' : `显示全部（${ctx.formatNumber(rows.length)}）`}</button>` : ''}`
    : '<p class="text-muted ipc-empty">没有记录</p>'}`;
}

// ---------- 简单数据统计（口径同「交易记录」：配对数量 = min(买入量, 卖出量)，按买卖均价计算；制造不计入） ----------
function pairStats(tx, fees) {
  const s = { buyQty: 0, buyIsk: 0, sellQty: 0, sellIsk: 0, buyN: 0, sellN: 0 };
  for (const t of tx) {
    if (t.buy) { s.buyQty += t.qty; s.buyIsk += t.qty * t.price; s.buyN += 1; }
    else { s.sellQty += t.qty; s.sellIsk += t.qty * t.price; s.sellN += 1; }
  }
  s.avgBuy = s.buyQty ? s.buyIsk / s.buyQty : null;
  s.avgSell = s.sellQty ? s.sellIsk / s.sellQty : null;
  s.matched = Math.min(s.buyQty, s.sellQty);
  s.cost = s.matched && s.avgBuy != null ? s.matched * s.avgBuy : 0;
  s.income = s.matched && s.avgSell != null ? s.matched * s.avgSell : 0;
  s.tax = fees.filter((f) => f.kind === 'tax').reduce((t, f) => t + f.amount, 0);
  s.broker = fees.filter((f) => f.kind === 'broker').reduce((t, f) => t + f.amount, 0);
  s.fees = s.tax + s.broker;
  s.gross = s.income - s.cost;
  s.net = s.gross - s.fees;
  s.margin = s.cost ? s.gross / s.cost : null;
  return s;
}

async function renderStats(M, main) {
  if (!hasWalletAccount()) { main.innerHTML = noAccount(); return; }
  main.innerHTML = '<div class="pi-loading">读取成交记录…</div>';
  const mine = await loadMine(M.id);
  if (!M.alive || !main.isConnected) return;
  if (!mine.tx.length) { main.innerHTML = statusLine(mine) + '<p class="text-muted ipc-empty">没有这个物品的买卖记录</p>'; return; }
  const s = pairStats(mine.tx, mine.fees);
  const sign = (v) => `<b class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${ctx.formatISK(v)}</b>`;
  const card = (k, v, sub = '') => `<div class="ipc-card"><span>${k}</span>${v}${sub ? `<small class="text-muted">${sub}</small>` : ''}</div>`;
  const oldest = mine.tx[mine.tx.length - 1].date, made = mine.jobs.reduce((t, j) => t + j.qty, 0);
  const perChar = mine.status.map((c) => [c, pairStats(mine.tx.filter((t) => t.char === c.id), mine.fees.filter((f) => f.char === c.id))]).filter(([, x]) => x.buyN || x.sellN);
  main.innerHTML = `${statusLine(mine)}
    <div class="ipc-cards">
      ${card('配对数量', `<b>${ctx.formatNumber(s.matched)}</b>`, '买卖都有的部分')}
      ${card('成本', `<b>${ctx.formatISK(s.cost)}</b>`, `买入均价 ${px(s.avgBuy)}`)}
      ${card('收入', `<b>${ctx.formatISK(s.income)}</b>`, `卖出均价 ${px(s.avgSell)}`)}
      ${card('市场费用', `<b>${ctx.formatISK(s.fees)}</b>`, `税 ${ctx.formatISK(s.tax)} · 中介费 ${ctx.formatISK(s.broker)}`)}
      ${card('差额', sign(s.net), '收入 − 成本 − 费用')}
      ${card('毛利率', `<b class="${(s.margin || 0) >= 0 ? 'up' : 'down'}">${s.margin == null ? '—' : (s.margin * 100).toFixed(1) + '%'}</b>`, '（收入 − 成本）÷ 成本')}
    </div>
    <table class="pi-table ipc-kv"><tbody>
      <tr><td>买入</td><td class="num">${ctx.formatNumber(s.buyQty)} 件 · ${s.buyN} 笔</td><td class="num">${ctx.formatISK(s.buyIsk)}</td></tr>
      <tr><td>卖出</td><td class="num">${ctx.formatNumber(s.sellQty)} 件 · ${s.sellN} 笔</td><td class="num">${ctx.formatISK(s.sellIsk)}</td></tr>
      <tr><td>未配对</td><td class="num">${s.buyQty >= s.sellQty ? `多买 ${ctx.formatNumber(s.buyQty - s.sellQty)} 件` : `多卖 ${ctx.formatNumber(s.sellQty - s.buyQty)} 件`}</td><td class="num text-muted">不计入</td></tr>
      ${made ? `<tr><td>制造产出</td><td class="num">${ctx.formatNumber(made)} 件 · ${mine.jobs.length} 个任务</td><td class="num text-muted">不计入</td></tr>` : ''}
      <tr><td>统计区间</td><td class="num" colspan="2">${fmtTime(oldest)} 至今</td></tr>
    </tbody></table>
    ${perChar.length > 1 ? `<h4 class="ipc-h">按角色</h4><table class="pi-table ipc-kv"><thead><tr><th>角色</th><th class="num">买入</th><th class="num">卖出</th><th class="num">配对</th><th class="num">差额</th></tr></thead><tbody>
      ${perChar.map(([c, x]) => `<tr><td>${ctx.esc(c.name)}</td><td class="num">${ctx.formatNumber(x.buyQty)}</td><td class="num">${ctx.formatNumber(x.sellQty)}</td><td class="num">${ctx.formatNumber(x.matched)}</td><td class="num">${sign(x.net)}</td></tr>`).join('')}</tbody></table>` : ''}`;
}
