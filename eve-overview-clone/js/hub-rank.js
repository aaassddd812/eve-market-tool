// 市场中心 ·「倒卖排行」（#arb）：所有物品一起比交易中心差价，和 LP 商店全服排行一样按利润排序。
// 数据：击杀记录服务 GET /api/v1/hubs/arbitrage?server=，每 30 分钟汇总当前服务器五个交易中心的全部挂单
//      （每个物品每个交易中心：最低卖 / 最高收、最优价 5% 以内的深度）与星域日均成交（宁静服 EVE Ref 每日历史，国服逐个查 ESI，缓存 1 天）。
// 路线与利润的算法与单个物品的「交易中心比价」相同（hub-compare.js 的 calcRoutes），技能与税费用全站设置；每个物品只列筛选条件下最好的一条路线。
// 运费设置与单品比价共用（跨中心路线扣 包装体积 × 每立方运费 + 抵押费），可按每立方利润排序（适合按货舱容量选品）
import { calcRoutes, ROUTE_SORT, MODES, setHubMode, loadVolumes, freight, setFreight, freightHtml } from './hub-compare.js?v=v5';

let ctx = null;   // server, regions, esc, formatISK, formatPrice, formatNumber, TF, typeName, category, isGlobal, iconUrl, openItem
const LIMIT = 200;
const POLL = 4000;
const POLL_VOLUME = 20000;   // 服务器还在读成交量时，隔一会儿取一次新结果
const MIN_PROFIT = [[0, '不限'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿']];
const MIN_DAILY = [[0, '不限'], [10, '10'], [100, '100'], [1000, '1000']];
const F = { mode: 'sb', sort: 'profit', from: 0, to: 0, local: true, cat: 0, minProfit: 1e7, minDaily: 0 };
const S = { data: null, loading: null, error: null, q: '', timer: 0, rows: null, key: '', vols: {} };
try { Object.assign(F, JSON.parse(localStorage.getItem('eve-hub-rank') || '{}')); } catch { /* 用默认 */ }
const save = () => { try { localStorage.setItem('eve-hub-rank', JSON.stringify(F)); } catch { /* 无痕模式 */ } };

export function initHubRank(context) { ctx = context; }

async function load(force) {
  if (S.loading && !force) return S.loading;
  S.loading = (async () => {
    const res = await fetch(`/api/v1/hubs/arbitrage?server=${ctx.server}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'HTTP ' + res.status);
    return data;
  })();
  try {
    S.data = await S.loading;
    S.error = null;
    S.rows = null;
  } catch (e) {
    S.error = e.message;
  } finally {
    S.loading = null;
  }
}

// 服务端数组 → hub-compare 用的对象
function hubsOf(row, names) {
  const out = [];
  row.forEach((h, k) => {
    if (!h) return;
    out.push({ id: S.data.hubs[k], name: names[k], sell: h[0], buy: h[1], sellDepth: h[4], buyDepth: h[5], daily: h[6], avg: h[7] });
  });
  return out;
}

function compute() {
  const key = JSON.stringify([F, ctx.TF.summary(), S.data?.updated, freight()]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const names = S.data.hubs.map((id) => ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id);
  const score = ROUTE_SORT[F.sort] || ROUTE_SORT.profit;
  const fr = freight();
  const rows = [];
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    if (ctx.isGlobal(id)) continue;
    const cat = ctx.category(id);
    if (!cat || (F.cat && cat.id !== F.cat)) continue;
    let best = null;
    for (const r of calcRoutes(hubsOf(row, names), F.mode, f, { vol: S.vols[id] || 0, ...fr })) {
      if (r.unit <= 0 || !r.qty || r.total < F.minProfit) continue;
      if (F.from && r.a.id !== F.from) continue;
      if (F.to && r.b.id !== F.to) continue;
      if (!F.local && r.local) continue;
      if (F.minDaily && Math.max(r.a.daily || 0, r.b.daily || 0) < F.minDaily) continue;
      if (!best || score(r) > score(best) || (score(r) === score(best) && r.margin > best.margin)) best = r;
    }
    if (best) rows.push({ id, cat, r: best });
  }
  rows.sort((x, y) => score(y.r) - score(x.r) || y.r.margin - x.r.margin);
  S.rows = rows;
  S.key = key;
  return rows;
}

const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-hr-${k}="${v}" class="${String(F[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const select = (k, items) => `<select class="pi-input" data-hr-sel="${k}">${items.map(([v, l]) => `<option value="${v}"${String(F[k]) === String(v) ? ' selected' : ''}>${ctx.esc(String(l))}</option>`).join('')}</select>`;

function html() {
  const { esc, formatISK, formatPrice, formatNumber, TF } = ctx;
  const all = compute();
  const q = S.q.trim().toLowerCase();
  const list = q ? all.filter((x) => ctx.typeName(x.id).toLowerCase().includes(q) || String(x.id) === q) : all;
  const top = list.slice(0, LIMIT);
  const hubOpts = [[0, '全部'], ...S.data.hubs.map((id) => [id, ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id])];
  const cats = new Map();
  for (const x of Object.keys(S.data.types)) { const c = ctx.category(Number(x)); if (c) cats.set(c.id, c.name); }
  const catOpts = [[0, '全部分类'], ...[...cats].sort((a, b) => a[1].localeCompare(b[1], 'zh'))];
  const noVol = !all.length && F.mode !== 'sb' && Object.values(S.data.types).every((r) => r.every((h) => !h || h[6] == null));
  const name = (h) => esc(String(h.name));
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);   // 大额用 M / B，表格放得下
  const rows = top.map((x, i) => {
    const r = x.r;
    return `<tr data-hr-open="${x.id}" title="打开该物品的交易中心比价">
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}</small></span></div></td>
      <td>${r.local ? `${name(r.a)} <small class="hc-sub">本地</small>` : `${name(r.a)} <span class="hc-arrow">→</span> ${name(r.b)}`}</td>
      <td class="num pi-hide-sm">${px(r.buyAt)}</td>
      <td class="num pi-hide-sm">${px(r.sellAt)}</td>
      <td class="num up">+${px(r.unit)}</td>
      <td class="num up">${(r.margin * 100).toFixed(1)}%</td>
      <td class="num pi-hide-sm" title="${r.vol ? formatNumber(r.vol) + ' m³ / 件' : '体积未知'}">${r.perM3 != null ? formatISK(r.perM3) : '—'}</td>
      <td class="num">${formatNumber(r.qty)}</td>
      <td class="num pi-hide-sm">${formatISK(r.cost * r.qty)}</td>
      <td class="num up">${formatISK(r.total)}</td></tr>`;
  }).join('');
  return `<div class="hr-wrap">
    <div class="pi-card ind-rank-filters">
      <div class="hc-head"><h3>交易中心倒卖排行</h3><span class="toolbar-spacer"></span>
        <button class="btn btn-ghost btn-sm" data-hr-fees title="调整技能与税费">${esc(TF.summary())}</button>
        <button class="btn btn-ghost btn-sm" data-hr-reload>刷新</button></div>
      <div class="ind-rank-row">${seg('mode', MODES)}</div>
      <div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>分类</span>${select('cat', catOpts)}</div>
        <div class="pi-inline"><span>买入</span>${select('from', hubOpts)}</div>
        <div class="pi-inline"><span>卖出</span>${select('to', hubOpts)}</div>
        <label class="pi-inline hr-check"><input type="checkbox" data-hr-local ${F.local ? 'checked' : ''}><span>含本地倒卖</span></label>
      </div>
      <div class="ind-rank-row">
        <div class="pi-inline"><span>预计利润 ≥</span>${select('minProfit', MIN_PROFIT)}</div>
        <div class="pi-inline"><span>日均成交 ≥</span>${select('minDaily', MIN_DAILY)}</div>
        <div class="pi-inline"><span>排序</span>${seg('sort', [['profit', '预计利润'], ['margin', '利润率'], ['unit', '每件利润'], ['m3', '每立方利润']])}</div>
      </div>
      <div class="ind-rank-row">${freightHtml('hr')}</div>
      <p class="pi-note" title="可做数量：直接成交按最优价 5% 以内的订单深度，挂单按星域日均成交 10%，两端取小。日均成交是整个星域的 30 天平均；挂单价偏离 30 天成交均价太多（收单低于 60%、卖单高于 140%）的不算。">
        ${list.length} 个物品有利润${list.length > LIMIT ? `，显示前 ${LIMIT}` : ''} · ${freight().m3 || freight().collat ? '跨中心路线已扣运费' : '未计运费'} · 行情 ${S.data.updated ? new Date(S.data.updated).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'} 汇总${S.data.progress ? ` · <span title="读完后自动更新">服务器${esc(S.data.progress)}</span>` : ''}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table hr-table"><thead><tr>
      <th class="pi-hide-sm">#</th><th>物品</th><th>路线</th><th class="num pi-hide-sm">买入价</th><th class="num pi-hide-sm">卖出价</th><th class="num">每件利润</th><th class="num">利润率</th><th class="num pi-hide-sm">每立方</th><th class="num">可做数量</th><th class="num pi-hide-sm">投入</th><th class="num">预计利润</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="11" class="text-muted">${noVol ? '成交量还在读取中，挂单方式暂时算不出可做数量' : '没有符合条件的路线'}</td></tr>`}</tbody></table></div></div>
  </div>`;
}

function render(box) {
  if (!box.isConnected || box.hidden) return;
  clearTimeout(S.timer);
  if (S.error && !S.data) {
    box.innerHTML = `<div class="pi-card"><p class="text-muted">读取失败：${ctx.esc(S.error)}</p><button class="btn btn-ghost btn-sm" data-hr-reload>重试</button></div>`;
    return;
  }
  if (!S.data || S.data.loading) {
    box.innerHTML = `<div class="pi-card"><h3>交易中心倒卖排行</h3><div class="pi-loading">服务器正在汇总五个交易中心的全部挂单${S.data?.progress ? '：' + ctx.esc(S.data.progress) : '…'}</div><p class="pi-note">首次大约需要 1–3 分钟，之后每 30 分钟自动刷新</p></div>`;
    S.timer = setTimeout(async () => { await load(true); render(box); }, S.data ? POLL : 0);
    return;
  }
  const focus = document.activeElement?.matches?.('[data-hr-q]') ? document.activeElement.selectionStart : null;
  box.innerHTML = html();
  if (focus != null) { const inp = box.querySelector('[data-hr-q]'); inp.focus(); inp.setSelectionRange(focus, focus); }
  if (S.data.progress) poll(box);
}

// 结果有变化（成交量又读了一批、或读完）才重画，否则只更新进度文字
function poll(box) {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    const at = S.data.updated;
    await load(true);
    if (!box.isConnected || box.hidden) return;
    if (S.data?.updated !== at || !S.data?.progress) { render(box); return; }
    const note = box.querySelector('.pi-note span');
    if (note) note.textContent = '服务器' + S.data.progress;
    poll(box);
  }, POLL_VOLUME);
}

export async function showHubRank(box) {
  if (!box.dataset.bound) bind(box);
  S.vols = await loadVolumes();
  if (!S.data || S.data.loading) await load();
  render(box);
}

// 技能或税费改动后重算
export function refreshHubRank(box) {
  if (S.data && !S.data.loading && box && !box.hidden) render(box);
}

function bind(box) {
  box.dataset.bound = '1';
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hr-mode],[data-hr-sort]');
    if (b) {
      if (b.dataset.hrMode) F.mode = b.dataset.hrMode;
      if (b.dataset.hrSort) F.sort = b.dataset.hrSort;
      save(); render(box); return;
    }
    if (e.target.closest('[data-hr-fees]')) { ctx.TF.openFeeDialog(); return; }
    if (e.target.closest('[data-hr-reload]')) { load(true).then(() => render(box)); return; }
    const row = e.target.closest('[data-hr-open]');
    if (row) { setHubMode(F.mode); ctx.openItem(Number(row.dataset.hrOpen)); }
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-hr-sel]');
    if (sel) { F[sel.dataset.hrSel] = Number(sel.value); save(); render(box); return; }
    if (e.target.matches('[data-hr-local]')) { F.local = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-m3],[data-hr-collat]')) { setFreight(box.querySelector('[data-hr-m3]').value, box.querySelector('[data-hr-collat]').value); render(box); }
  });
  let t = 0;
  box.addEventListener('input', (e) => {
    if (!e.target.matches('[data-hr-q]')) return;
    S.q = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => render(box), 200);
  });
}
