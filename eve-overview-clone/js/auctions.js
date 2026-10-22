// ===== 公共拍卖合同（快递页的「拍卖」模式）=====
// 列表：ESI /contracts/public/{region_id}/（公开接口，按星域分页）筛出未过期的拍卖合同，缓存 10 分钟。
// 当前出价：/contracts/public/bids/{contract_id}/（公开），只为当前显示的合同读取，没有出价时返回 204。
// 详情：/contracts/public/items/{contract_id}/ 物品清单（按 ESI 全服均价估值）+ 出价记录；可在游戏里打开合同。

let ctx;   // esc, formatISK, formatPrice, formatNumber, fetchESI, resolveTypeNames, resolveStructures, officialName, valuation, marketRegions, regions, game, store
const S = { region: 0, list: null, loading: null, error: null, q: '', shown: 50, sort: 'expire', bids: new Map(), items: new Map(), at: 0 };
const cache = new Map();   // region -> { at, list }
const stations = new Map(); // 中文名称表里没有的 NPC 空间站（如曙光服独有的站）-> ESI 站名
const placeName = (id) => stations.get(id) || ctx.locationName(id);
const PAGE = 50;
const KEY = 'eve-auction-region';
const $ = (id) => document.getElementById(id);

export function initAuctions(context) {
  ctx = context;
  S.region = Number(ctx.store.get(KEY)) || ctx.regions[0].id;
}

const esc = (s) => ctx.esc(s);
function left(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '已结束';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24), m = Math.floor((ms % 3600e3) / 60e3);
  return d ? `${d} 天 ${h % 24} 小时` : h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
}

async function fetchRegion(region) {
  const hit = cache.get(region);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit;
  const url = (p) => `${ctx.esiBase}/contracts/public/${region}/?datasource=${ctx.datasource}&page=${p}`;
  const first = await fetch(url(1));
  if (first.status === 204) return { at: Date.now(), list: [] };
  if (!first.ok) throw new Error('ESI ' + first.status);
  const pages = Math.min(Number(first.headers.get('X-Pages')) || 1, 30);
  const all = [await first.json()];
  for (let p = 2; p <= pages; p += 4) {
    const batch = await Promise.all([p, p + 1, p + 2, p + 3].filter((n) => n <= pages).map((n) => fetch(url(n)).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
    all.push(...batch);
  }
  const now = Date.now();
  const list = all.flat().filter((c) => c.type === 'auction' && new Date(c.date_expired) > now);
  const entry = { at: Date.now(), list };
  cache.set(region, entry);
  return entry;
}

async function loadBids(list) {
  const todo = list.filter((c) => !S.bids.has(c.contract_id));
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const c = todo[i++];
      try {
        const res = await fetch(`${ctx.esiBase}/contracts/public/bids/${c.contract_id}/?datasource=${ctx.datasource}`);
        const bids = res.status === 204 ? [] : res.ok ? await res.json() : null;
        S.bids.set(c.contract_id, bids ? bids.sort((a, b) => b.amount - a.amount) : null);
      } catch { S.bids.set(c.contract_id, null); }
    }
  }));
}

function regionOptions() {
  const hubs = ctx.regions.map((r) => [r.id, `${r.name}（${r.hub.name}）`]);
  const others = (ctx.marketRegions() || []).filter((r) => !ctx.regions.some((h) => h.id === r.id)).map((r) => [r.id, r.name]);
  return `<optgroup label="交易中心">${hubs.map(([id, n]) => `<option value="${id}"${id === S.region ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` +
    (others.length ? `<optgroup label="其他星域">${others.map(([id, n]) => `<option value="${id}"${id === S.region ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : '');
}

function sorted() {
  const q = S.q.toLowerCase();
  const list = (S.list || []).filter((c) => !q || (c.title || '').toLowerCase().includes(q));
  const bid = (c) => S.bids.get(c.contract_id)?.[0]?.amount ?? c.price;
  const by = {
    expire: (a, b) => new Date(a.date_expired) - new Date(b.date_expired),
    recent: (a, b) => new Date(b.date_issued) - new Date(a.date_issued),
    price: (a, b) => bid(b) - bid(a),
    buyout: (a, b) => (a.buyout || Infinity) - (b.buyout || Infinity)
  };
  return list.sort(by[S.sort] || by.expire);
}

function rowsHtml(list) {
  const { formatISK } = ctx;
  return list.map((c) => {
    const bids = S.bids.get(c.contract_id);
    const top = bids?.[0];
    const bidCell = bids === undefined ? '<span class="muted-cell">…</span>' : bids === null ? '<span class="muted-cell">—</span>'
      : top ? `<strong class="up">${formatISK(top.amount)}</strong><span class="cell-sub">${bids.length} 次出价</span>` : '<span class="muted-cell">暂无出价</span>';
    return `<tr class="au-row" data-au="${c.contract_id}" tabindex="0">
      <td><b>${esc(c.title || '（无标题）')}</b><span class="cell-sub">${esc(placeName(c.start_location_id))}</span></td>
      <td>${formatISK(c.price)}</td>
      <td>${bidCell}</td>
      <td>${c.buyout ? formatISK(c.buyout) : '<span class="muted-cell">—</span>'}</td>
      <td>${ctx.formatNumber(Math.round(c.volume || 0))} m³</td>
      <td>${esc(left(c.date_expired))}</td></tr>`;
  }).join('');
}

function renderList(box) {
  const body = box.querySelector('[data-au-body]');
  if (!body) return;
  if (S.loading) { body.innerHTML = '<div class="pi-loading">读取公开拍卖合同…</div>'; return; }
  if (S.error) { body.innerHTML = `<p class="text-muted">读取失败：${esc(S.error)}</p>`; return; }
  const list = sorted();
  box.querySelector('[data-au-count]').textContent = `${list.length} 份拍卖合同`;
  if (!list.length) { body.innerHTML = '<p class="text-muted">这个星域没有进行中的公开拍卖</p>'; return; }
  const shown = list.slice(0, S.shown);
  const th = (k, l) => `<th><button class="${S.sort === k ? 'active' : ''}" data-au-sort="${k}">${l}</button></th>`;
  body.innerHTML = `<div class="table-scroll"><table class="pc-mini-table trade-table au-table"><thead><tr>
      <th>合同 / 地点</th><th>起拍价</th>${th('price', '当前出价')}${th('buyout', '一口价')}<th>体积</th>${th('expire', '剩余时间')}
    </tr></thead><tbody>${rowsHtml(shown)}</tbody></table></div>` +
    (list.length > S.shown ? `<div class="au-more"><button class="btn btn-ghost" data-au-more>再显示 ${Math.min(PAGE, list.length - S.shown)} 份</button></div>` : '') +
    '';
  // 补读当前出价与地点名称
  const missing = shown.filter((c) => !S.bids.has(c.contract_id));
  if (missing.length) loadBids(missing).then(() => { if (box.isConnected) renderList(box); });
  const npc = [...new Set(shown.map((c) => c.start_location_id).filter((id) => id < 1e12 && !ctx.officialName(id) && !stations.has(id)))];
  if (npc.length) {
    npc.forEach((id) => stations.set(id, ctx.locationName(id)));
    Promise.all(npc.map((id) => ctx.fetchESI(`/universe/stations/${id}/?language=zh`).then((st) => stations.set(id, st.name)).catch(() => {})))
      .then(() => { if (box.isConnected) renderList(box); });
  }
  const locs = shown.map((c) => c.start_location_id).filter((id) => id >= 1e12);
  if (locs.length && !S.locsAsked?.has(locs.join())) {
    S.locsAsked = S.locsAsked || new Set();
    S.locsAsked.add(locs.join());
    ctx.resolveStructures(locs).then(() => { if (box.isConnected) renderList(box); }).catch(() => {});
  }
}

async function load(box, force) {
  if (force) cache.delete(S.region);
  S.loading = true; S.error = null; S.shown = PAGE;
  renderList(box);
  try {
    const { list, at } = await fetchRegion(S.region);
    S.list = list; S.at = at;
  } catch (error) { S.error = error.message; }
  S.loading = false;
  renderList(box);
}

async function openDetail(c) {
  let modal = $('auctionModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'auctionModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-au-close></div><div class="modal-content au-modal">
      <div class="modal-header"><h3 id="auTitle">拍卖合同</h3><button class="modal-close" data-au-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="auBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-au-close]')) { modal.hidden = true; return; }
      const g = e.target.closest('[data-au-game]');
      if (g) ctx.game.contract(Number(g.dataset.auGame));
    });
    // 切换估值价格来源后重绘当前合同
    modal.addEventListener('change', (e) => { if (e.target.matches('[data-val-src]')) { ctx.valuation.set(e.target.value); openDetail(modal.contract); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
  }
  modal.hidden = false;
  modal.contract = c;
  $('auTitle').textContent = c.title || '拍卖合同';
  const body = $('auBody');
  body.innerHTML = '<div class="pi-loading">读取合同物品与出价…</div>';
  try {
    const items = S.items.get(c.contract_id) || await fetch(`${ctx.esiBase}/contracts/public/items/${c.contract_id}/?datasource=${ctx.datasource}`).then((r) => (r.status === 204 ? [] : r.ok ? r.json() : Promise.reject(new Error('ESI ' + r.status))));
    S.items.set(c.contract_id, items);
    if (!S.bids.has(c.contract_id)) await loadBids([c]);
    const bids = S.bids.get(c.contract_id) || [];
    const types = await ctx.resolveTypeNames(items.map((i) => i.type_id));
    const given = items.filter((i) => i.is_included);
    const v = await ctx.valuation.items(given, (d, t) => { if (modal.contract === c && t > d) body.innerHTML = `<div class="pi-loading">读取${esc(ctx.valuation.region().hub.name)}行情 ${d}/${t}…</div>`; });
    if (modal.contract !== c || modal.hidden) return;
    const { formatISK, formatPrice, formatNumber } = ctx;
    const top = bids[0]?.amount || 0;
    body.innerHTML = `
      <div class="valuation-grid">
        ${ctx.valuationCard('当前出价', top ? formatISK(top) + ' ISK' : '暂无出价', top ? bids.length + ' 次出价' : '起拍价 ' + formatISK(c.price), 'is-buy')}
        ${ctx.valuationCard('一口价', c.buyout ? formatISK(c.buyout) + ' ISK' : '—', '')}
        ${ctx.valuation.cards(v)}
        ${ctx.valuationCard('剩余时间', left(c.date_expired), esc(placeName(c.start_location_id)))}
      </div>
      <div class="valuation-toolbar section-gap">${ctx.valuation.select('data-val-src', v.region)}<span class="toolbar-spacer"></span><button class="btn" data-au-game="${c.contract_id}" title="需要「游戏内操作」权限，角色需在线">游戏内打开合同</button></div>
      <h4 class="info-section-title">物品（${given.length}）</h4>
      <div class="table-scroll"><table class="pc-mini-table"><thead><tr><th>物品</th><th>数量</th><th>最低卖价合计</th><th>最高收价合计</th></tr></thead><tbody>${given.map((i) => {
        const p = i.is_blueprint_copy ? {} : v.price(i.type_id);
        const cell = (x) => (x == null ? '—' : formatISK(x * i.quantity));
        return `<tr><td>${esc(types.get(i.type_id) || 'Type ' + i.type_id)}${i.is_blueprint_copy ? ' <span class="pill">蓝图副本</span>' : ''}</td><td>${formatNumber(i.quantity)}</td>
        <td>${cell(p.sell)}</td><td>${cell(p.buy)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <h4 class="info-section-title">出价记录（${bids.length}）</h4>
      ${bids.length ? `<div class="table-scroll"><table class="pc-mini-table"><thead><tr><th>出价</th><th>时间</th></tr></thead><tbody>${bids.map((b) => `<tr><td>${formatPrice(b.amount)} ISK</td><td>${new Date(b.date_bid).toLocaleString('zh-CN', { hour12: false })}</td></tr>`).join('')}</tbody></table></div>` : '<p class="text-muted">还没有人出价</p>'}
      `;
  } catch (error) {
    body.innerHTML = '<p class="text-muted">读取失败：' + esc(error.message) + '</p>';
  }
}

export function renderAuctions(box) {
  if (!box.dataset.ready) {
    box.dataset.ready = '1';
    box.innerHTML = `
      <div class="cr-toolbar au-toolbar">
        <label class="select-wrap"><select class="region-select" data-au-region aria-label="星域">${regionOptions()}</select></label>
        <div class="search-box au-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-au-q placeholder="按合同标题筛选" autocomplete="off"></div>
        <span class="cr-count" data-au-count></span>
        <span class="toolbar-spacer"></span>
        <button class="btn btn-ghost" data-au-reload>刷新</button>
      </div>
      <div data-au-body></div>`;
    box.addEventListener('change', (e) => {
      if (e.target.matches('[data-au-region]')) { S.region = Number(e.target.value); ctx.store.set(KEY, String(S.region)); load(box); }
    });
    let t = 0;
    box.addEventListener('input', (e) => { if (e.target.matches('[data-au-q]')) { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.shown = PAGE; renderList(box); }, 150); } });
    box.addEventListener('click', (e) => {
      const sort = e.target.closest('[data-au-sort]');
      if (sort) { S.sort = sort.dataset.auSort; renderList(box); return; }
      if (e.target.closest('[data-au-more]')) { S.shown += PAGE; renderList(box); return; }
      if (e.target.closest('[data-au-reload]')) { load(box, true); return; }
      const row = e.target.closest('[data-au]');
      if (row) { const c = S.list?.find((x) => x.contract_id === Number(row.dataset.au)); if (c) openDetail(c); }
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const row = e.target.closest('[data-au]'); if (row) row.click(); } });
    load(box);
  } else if (!S.list && !S.loading) load(box);
}
