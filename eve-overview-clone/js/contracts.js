// ===== 合同中心 =====
// 公开合同：击杀记录服务的公开合同存档（/api/kb/contracts，宁静服）。EVE Ref 每 30 分钟抓一次全服公开合同，服务逐份比对：
//   在售 = 最新快照里还在；推测成交 = 到期前消失（物品交换 / 快递为被接，拍卖为一口价；发起人手动删除也会这样，无法区分）或拍卖到期有出价；
//   过期 = 到期后消失且没人出价；撤单重发 = 同一发起人在同一份快照里发了物品完全相同的新合同。
// 我的合同（绑定 ESI）：个人 /characters/{id}/contracts/，军团 /corporations/{id}/contracts/（「军团合同」权限）。
//   ESI 没有联盟合同接口，「联盟」列出的是这两处里可见范围为联盟的合同（指派给联盟、但自己与军团都不是发起方 / 接受方的合同读不到）。

let ctx;   // esc, formatISK, formatPrice, formatNumber, fetchESI, resolveTypeNames, resolveNames, resolveStructures, officialName, locationName, loadNpcNames,
           // valuation, valuationCard, store, game, regions, marketRegions, loadMarketRegions, getTypeIndex, archive, esiAuthFetch, esiAuthFetchPaged,
           // hasEsiToken, tokenInfo, hasScopeGroup, scopeNeededHtml, openEsiBind, icon
const PAGE = 50;
const KEY = 'eve-contracts-page';
const PUBLIC_TABS = [['open', '在售'], ['done', '推测成交'], ['expired', '已过期'], ['repost', '撤单重发']];
const MY_TABS = [['me', '个人'], ['corp', '军团'], ['alliance', '联盟']];
const TYPE_ZH = { item_exchange: '物品交换', auction: '拍卖', courier: '快递', loan: '租借', unknown: '未知' };
const STATUS_ZH = { open: '在售', done: '推测成交', expired: '已过期', repost: '撤单重发' };
const ESI_STATUS_ZH = {
  outstanding: '待接受', in_progress: '进行中', finished_issuer: '已完成', finished_contractor: '已完成', finished: '已完成',
  cancelled: '已取消', rejected: '已拒绝', failed: '已失败', deleted: '已删除', reversed: '已撤销'
};
const AVAIL_ZH = { public: '公开', personal: '私人', corporation: '军团', alliance: '联盟' };
const SORTS = {
  open: [['issued', '最新发布'], ['expires', '即将到期'], ['price', '价格'], ['value', '估值'], ['ratio', '价格 ÷ 估值']],
  ended: [['ended', '最近结束'], ['price', '价格'], ['value', '估值'], ['ratio', '价格 ÷ 估值']]
};
const S = {
  tab: 'open', type: '', region: 0, q: '', item: '', itemIds: null, sort: '', order: 'desc',
  list: [], total: 0, counts: {}, snapshot: null, sold: null, loading: false, error: null, seq: 0,
  esi: new Map(),            // 'me' / 'corp' -> { list } | { error } | { scope: true }
  me: null,                  // { id, corp, alliance }
  names: new Map(), types: new Map(), detail: null
};
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s);
// 合同标题里常带 HTML 实体（&gt; 等），先还原再转义
const unent = (s) => String(s || '').replace(/&(lt|gt|amp|quot|#39);/g, (m, k) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[k]);

export function initContracts(context) {
  ctx = context;
  const saved = ctx.store.getJSON(KEY, {});
  if (PUBLIC_TABS.some(([k]) => k === saved.tab) || MY_TABS.some(([k]) => k === saved.tab)) S.tab = saved.tab;
  S.type = saved.type || '';
  S.region = Number(saved.region) || 0;
  if (!ctx.archive && isPublic()) S.tab = 'me';
}
const save = () => ctx.store.setJSON(KEY, { tab: S.tab, type: S.type, region: S.region });
const isPublic = (tab = S.tab) => PUBLIC_TABS.some(([k]) => k === tab);

// ---------------- 小工具
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) return left(iso);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
function left(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '已到期';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24);
  return d ? `剩 ${d} 天` : h ? `剩 ${h} 小时` : `剩 ${Math.max(1, Math.round(ms / 60e3))} 分钟`;
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const typeName = (id) => S.types.get(id) || ctx.typeName?.(id) || 'Type ' + id;
const nameOf = (id) => S.names.get(id) || (id ? '#' + id : '—');
function place(c) {
  const loc = c.location_id ?? c.start_location_id;
  const n = loc ? ctx.locationName(loc) : '';
  if (n && !/^\d+$/.test(n) && !n.startsWith('#') && !/^(建筑|位置) ?\d+/.test(n)) return n;
  return c.system_id ? (ctx.officialName(c.system_id) || '星系 ' + c.system_id) + ' · 玩家建筑' : (n || '—');
}
// 价格列：物品交换为价格（收购合同为报酬）；拍卖为最高出价 / 起拍价；快递为报酬
function priceOf(c) {
  if (c.status === 'done' && c.final != null) return c.final;
  if (c.type === 'courier') return c.reward;
  if (c.type === 'auction') return c.top_bid || c.price;
  return c.price || c.reward;
}

async function fillNames(ids) {
  const todo = [...new Set(ids.filter((id) => id && !S.names.has(id)))];
  if (!todo.length) return false;
  try {
    const { names } = await ctx.resolveNames(todo);
    for (const [k, v] of names) S.names.set(k, v);
  } catch { /* 名称读不到时显示 ID */ }
  todo.forEach((id) => { if (!S.names.has(id)) S.names.set(id, '#' + id); });
  return true;
}
async function fillTypes(ids) {
  const todo = [...new Set(ids.filter((id) => id && !S.types.has(id)))];
  if (!todo.length) return false;
  try {
    const m = await ctx.resolveTypeNames(todo);
    for (const [k, v] of m) S.types.set(Number(k), v);
  } catch { /* 显示 Type ID */ }
  return true;
}

// ---------------- 物品搜索：按市场目录名称匹配（完全相同优先，否则最多 50 种包含关键字的物品）
async function matchItems(text) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const index = await ctx.getTypeIndex();
  const exact = [], part = [];
  for (const [id, { type }] of index || []) {
    const n = String(type.name || '').toLowerCase();
    if (n === q) exact.push(id);
    else if (n.includes(q)) part.push(id);
  }
  return exact.length ? exact : part.slice(0, 50);
}

// ---------------- 公开合同存档
async function loadPublic(more) {
  const seq = ++S.seq;
  S.loading = true; S.error = null;
  if (!more) { S.list = []; S.total = 0; S.sold = null; }
  renderBody();
  const p = new URLSearchParams({ status: S.tab, limit: PAGE, offset: more ? S.list.length : 0 });
  if (S.type) p.set('type', S.type);
  if (S.region) p.set('region', S.region);
  if (S.q) p.set('q', S.q);
  if (S.itemIds) p.set('item', S.itemIds.join(','));
  if (S.sort) p.set('sort', S.sort);
  if (S.order === 'asc') p.set('order', 'asc');
  try {
    if (S.itemIds && !S.itemIds.length) throw new Error('没有找到名称包含「' + S.item + '」的物品');
    const r = await fetch('/api/kb/contracts?' + p);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    if (seq !== S.seq) return;
    S.list = more ? S.list.concat(data.list) : data.list;
    S.total = data.total; S.counts = data.counts || {}; S.snapshot = data.snapshot; S.sold = data.sold || null;
    const ids = data.list.flatMap((c) => (c.items || []).map((i) => i[0]).concat(c.main_type || []));
    await Promise.all([fillTypes(ids), ctx.loadNpcNames?.()]);
    fillNames(data.list.map((c) => c.issuer_id)).then((changed) => { if (changed && seq === S.seq) renderBody(); });
  } catch (error) {
    if (seq !== S.seq) return;
    S.error = error.message;
  }
  S.loading = false;
  renderTabs();
  renderBody();
}

function itemsSummary(c) {
  const given = (c.items || []).filter((i) => i[2]);
  const main = c.main_type || given[0]?.[0];
  if (c.type === 'courier') return { main: null, text: '快递合同', sub: '', vol: ctx.formatNumber(Math.round(c.volume || 0)) + ' m³', title: c.title };
  if (!main) {
    const want = (c.items || []).filter((i) => !i[2]);
    return want.length ? { main: want[0][0], text: '收购 ' + typeName(want[0][0]), sub: c.title } : { main: null, text: '（无物品）', sub: c.title };
  }
  const qty = given.find((i) => i[0] === main)?.[1] || 1;
  const kinds = c.n_items || given.length;
  return { main, text: typeName(main) + (qty > 1 ? ' ×' + ctx.formatNumber(qty) : ''), more: kinds > 1 ? kinds : 0, sub: c.title || '' };
}

function publicRows() {
  const { formatISK } = ctx;
  return S.list.map((c) => {
    const it = itemsSummary(c);
    const price = priceOf(c);
    const ratio = c.value && price && c.type !== 'courier' ? price / c.value : null;
    const tag = ratio == null ? '' : `<span class="ct-ratio ${ratio <= 0.9 ? 'up' : ratio >= 1.2 ? 'down' : ''}" title="价格为估值（吉他中间价）的百分比">${ratio >= 10 ? '≥10×' : Math.round(ratio * 100) + '%'}</span>`;
    const priceSub = c.type === 'courier' ? '抵押 ' + formatISK(c.collateral)
      : c.type === 'auction' ? (c.status === 'done' ? (c.final === c.buyout ? '一口价' : '最高出价') : c.top_bid ? `${c.bids} 次出价` : '起拍价') + (c.buyout && c.status !== 'done' ? ' · 一口价 ' + formatISK(c.buyout) : '')
      : !c.price && c.reward ? '收购报酬' : '';
    const time = c.status === 'open' ? `<span>${esc(ago(c.issued))}</span><span class="cell-sub">${esc(left(c.expires))}</span>`
      : `<span>${esc(ago(c.ended))}</span><span class="cell-sub"><span>发布于</span> <span>${esc(ago(c.issued))}</span></span>`;
    return `<tr class="ct-row" data-ct="${c.contract_id}" tabindex="0">
      <td><div class="ct-item">${it.main ? `<img src="${ctx.icon(it.main)}" onerror="if(!this.dataset.bp){this.dataset.bp=1;this.src=this.src.replace('/icon','/bp')}" alt="" width="32" height="32" loading="lazy">` : '<span class="ct-noimg"></span>'}
        <span><b>${esc(it.text)}</b><span class="ct-show-sm"><span class="pill ct-type-${c.type}">${esc(TYPE_ZH[c.type] || c.type)}</span></span>${it.vol ? `<span class="cell-sub">${it.vol}${it.title ? ` · <span translate="no">${esc(unent(it.title))}</span>` : ''}</span>` : ''}${it.sub || it.more ? `<span class="cell-sub">${it.more ? `<span>等 ${it.more} 项</span>${it.sub ? ' · ' : ''}` : ''}${it.sub ? `<span translate="no">${esc(unent(it.sub))}</span>` : ''}</span>` : ''}</span></div></td>
      <td class="ct-hide-sm"><span class="pill ct-type-${c.type}">${esc(TYPE_ZH[c.type] || c.type)}</span>${S.tab !== c.status ? ` <span class="pill">${esc(STATUS_ZH[c.status] || c.status)}</span>` : ''}</td>
      <td class="ct-hide-sm"><span>${esc(place(c))}</span><span class="cell-sub">${esc(nameOf(c.issuer_id))}${c.for_corp ? ' · <span>军团</span>' : ''}</span></td>
      <td class="num"><strong>${price ? formatISK(price) : '—'}</strong>${priceSub ? `<span class="cell-sub">${esc(priceSub)}</span>` : ''}</td>
      <td class="num ct-hide-sm">${c.type === 'courier' ? '<span class="muted-cell">—</span>' : (c.value ? formatISK(c.value) : '—') + tag}</td>
      <td class="ct-time">${time}</td>
    </tr>`;
  }).join('');
}

function soldHtml() {
  const s = S.sold;
  if (!s) return '';
  const { formatISK, formatPrice } = ctx;
  return `<div class="ct-sold"><img src="${ctx.icon(s.type_id)}" onerror="if(!this.dataset.bp){this.dataset.bp=1;this.src=this.src.replace('/icon','/bp')}" alt="" width="32" height="32">
    <div><b>${esc(typeName(s.type_id))}</b><span>近 ${s.days} 天公开合同推测成交 ${s.count} 份（只卖这一种物品的合同）</span></div>
    <div class="ct-sold-num"><span>单价中位数</span><b>${formatPrice(s.median)} ISK</b><small>${formatISK(s.min)} – ${formatISK(s.max)}</small></div></div>`;
}

// ---------------- 我的合同（ESI）
async function myInfo() {
  const token = ctx.tokenInfo();
  if (!token?.character_id) return null;
  if (S.me?.id === token.character_id) return S.me;
  const ch = await ctx.esiAuthFetch(`/characters/${token.character_id}/`);
  S.me = { id: token.character_id, corp: ch.corporation_id, alliance: ch.alliance_id || null };
  return S.me;
}
async function loadEsi(kind, force) {
  if (!force && S.esi.has(kind)) return;
  S.esi.set(kind, { loading: true });
  renderBody();
  try {
    const me = await myInfo();
    let list;
    if (kind === 'corp' || kind === 'alliance') {
      const out = [];
      const mine = await ctx.esiAuthFetchPaged(`/characters/${me.id}/contracts/`).catch(() => []);
      mine.forEach((c) => out.push({ ...c, _src: 'me' }));
      if (ctx.hasScopeGroup('corpContracts')) {
        const corp = await ctx.esiAuthFetchPaged(`/corporations/${me.corp}/contracts/`);
        corp.forEach((c) => { if (!out.some((x) => x.contract_id === c.contract_id)) out.push({ ...c, _src: 'corp' }); });
      } else if (kind === 'corp') {
        S.esi.set(kind, { scope: true });
        renderBody();
        return;
      }
      list = kind === 'corp' ? out.filter((c) => c._src === 'corp' || c.availability === 'corporation' || c.issuer_corporation_id === me.corp && c.for_corporation)
        : out.filter((c) => c.availability === 'alliance');
    } else {
      list = (await ctx.esiAuthFetchPaged(`/characters/${me.id}/contracts/`)).map((c) => ({ ...c, _src: 'me' }));
    }
    list.sort((a, b) => new Date(b.date_issued) - new Date(a.date_issued));
    S.esi.set(kind, { list });
    await Promise.all([fillNames(list.flatMap((c) => [c.issuer_id, c.acceptor_id, c.assignee_id])), ctx.loadNpcNames?.()]);
    const structs = [...new Set(list.map((c) => c.start_location_id).filter((id) => id > 1e12))];
    if (structs.length) ctx.resolveStructures(structs).then(() => renderBody()).catch(() => {});
  } catch (error) {
    S.esi.set(kind, { error: error.status === 403 ? '没有权限读取（军团合同需要「军团合同」权限）' : error.message });
  }
  renderBody();
}

function esiStatus(c) {
  if (c.status === 'outstanding' && c.date_expired && new Date(c.date_expired) < new Date()) return ['expired', '已过期'];
  return [c.status, ESI_STATUS_ZH[c.status] || c.status];
}
function esiRows(list) {
  const { formatISK } = ctx;
  const q = S.q.toLowerCase();
  return list.filter((c) => (!S.type || c.type === S.type) && (!q || (c.title || '').toLowerCase().includes(q))).map((c) => {
    const [st, label] = esiStatus(c);
    const price = c.type === 'courier' ? c.reward : c.type === 'auction' ? c.price : c.price || c.reward;
    return `<tr class="ct-row" data-ct-esi="${c.contract_id}" tabindex="0">
      <td><div class="ct-item"><span class="ct-noimg"></span><span>${c.title ? `<b translate="no">${esc(unent(c.title))}</b>` : '<b>（无标题）</b>'}<span class="ct-show-sm"><span class="pill ct-type-${c.type}">${esc(TYPE_ZH[c.type] || c.type)}</span> <span class="pill status-${st}">${esc(label)}</span></span><span class="cell-sub">${esc(nameOf(c.issuer_id))} · ${esc(AVAIL_ZH[c.availability] || c.availability)}${c.assignee_id && c.availability !== 'public' ? ' → ' + esc(nameOf(c.assignee_id)) : ''}</span></span></div></td>
      <td class="ct-hide-sm"><span class="pill ct-type-${c.type}">${esc(TYPE_ZH[c.type] || c.type)}</span> <span class="pill status-${st}">${esc(label)}</span></td>
      <td class="ct-hide-sm"><span>${esc(ctx.locationName(c.start_location_id))}</span>${c.type === 'courier' && c.end_location_id ? `<span class="cell-sub">→ ${esc(ctx.locationName(c.end_location_id))}</span>` : ''}</td>
      <td class="num"><strong>${price ? formatISK(price) : '—'}</strong>${c.type === 'courier' ? `<span class="cell-sub">抵押 ${formatISK(c.collateral)}</span>` : ''}</td>
      <td class="num ct-hide-sm">${c.volume ? ctx.formatNumber(Math.round(c.volume)) + ' m³' : '—'}</td>
      <td class="ct-time"><span>${esc(ago(c.date_issued))}</span><span class="cell-sub">${c.status === 'outstanding' ? esc(left(c.date_expired)) : esc(fmtTime(c.date_completed || c.date_accepted || c.date_expired))}</span></td>
    </tr>`;
  }).join('');
}

// ---------------- 页面
function renderTabs() {
  const box = $('ctTabs');
  if (!box) return;
  const n = (k) => (S.counts[k] != null ? ` <small>${ctx.formatNumber(S.counts[k])}</small>` : '');
  box.innerHTML = `<div class="segmented ct-tabs" role="tablist" aria-label="公开合同">${PUBLIC_TABS.map(([k, l]) => `<button type="button" role="tab" data-ct-tab="${k}" class="${S.tab === k ? 'active' : ''}"${ctx.archive ? '' : ' disabled'}>${esc(l)}${n(k)}</button>`).join('')}</div>
    <div class="segmented ct-tabs" role="tablist" aria-label="我的合同">${MY_TABS.map(([k, l]) => `<button type="button" role="tab" data-ct-tab="${k}" class="${S.tab === k ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>`;
}

function regionOptions() {
  const hubs = ctx.regions.map((r) => [r.id, r.name]);
  const others = (ctx.marketRegions() || []).filter((r) => !ctx.regions.some((h) => h.id === r.id)).map((r) => [r.id, r.name]);
  const opt = ([id, n]) => `<option value="${id}"${id === S.region ? ' selected' : ''}>${esc(n)}</option>`;
  return `<option value="0"${!S.region ? ' selected' : ''}>全部星域</option><optgroup label="交易中心星域">${hubs.map(opt).join('')}</optgroup>` +
    (others.length ? `<optgroup label="其他星域">${others.map(opt).join('')}</optgroup>` : '');
}

function renderFilters() {
  const box = $('ctFilters');
  if (!box) return;
  const pub = isPublic();
  const sorts = SORTS[S.tab === 'open' ? 'open' : 'ended'];
  box.innerHTML = `
    <label class="select-wrap"><select data-ct-type aria-label="合同类型"><option value="">全部类型</option>${['item_exchange', 'auction', 'courier'].map((t) => `<option value="${t}"${S.type === t ? ' selected' : ''}>${TYPE_ZH[t]}</option>`).join('')}</select></label>
    ${pub ? `<label class="select-wrap"><select class="region-select" data-ct-region aria-label="星域">${regionOptions()}</select></label>
    <div class="search-box ct-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" data-ct-item placeholder="物品名称" value="${esc(S.item)}" autocomplete="off" aria-label="按物品筛选"></div>` : ''}
    <div class="search-box ct-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" data-ct-q placeholder="合同标题" value="${esc(S.q)}" autocomplete="off" aria-label="按合同标题筛选"></div>
    ${pub ? `<label class="select-wrap"><select data-ct-sort aria-label="排序">${sorts.map(([k, l]) => `<option value="${k}"${(S.sort || sorts[0][0]) === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <button type="button" class="btn btn-ghost ct-order" data-ct-order title="${S.order === 'asc' ? '从小到大' : '从大到小'}">${S.order === 'asc' ? '↑' : '↓'}</button>` : ''}
    <span class="toolbar-spacer"></span>
    <button type="button" class="btn btn-ghost" data-ct-reload>刷新</button>`;
}

function tableHead(pub) {
  return `<thead><tr><th>${pub ? '物品' : '合同'}</th><th class="ct-hide-sm">类型</th><th class="ct-hide-sm">地点</th><th class="num">价格</th><th class="num ct-hide-sm">${pub ? '估值' : '体积'}</th><th>${pub && S.tab !== 'open' ? '结束' : '发布'}</th></tr></thead>`;
}

function renderBody() {
  const box = $('ctBody');
  if (!box) return;
  if (isPublic()) {
    if (!ctx.archive) { box.innerHTML = '<div class="empty-state"><p>公开合同存档只有宁静服提供（需要本站服务端逐份比对 EVE Ref 快照）。</p></div>'; return; }
    const why = S.tab === 'done' ? '到期前从公开列表消失的合同（被接受，或发起人手动删除，ESI 无法区分），拍卖含到期有出价的'
      : S.tab === 'repost' ? '同一发起人删掉后马上重发了物品相同的合同，不算成交' : '';
    const note = `<p class="text-muted ct-note"><span>${S.snapshot ? `最新快照 ${esc(fmtTime(S.snapshot))} · ` : ''}共 ${ctx.formatNumber(S.total)} 份</span>${why ? ` · <span>${why}</span>` : ''}</p>`;
    if (S.error) { box.innerHTML = soldHtml() + `<p class="text-muted">读取失败：${esc(S.error)}</p>`; return; }
    if (!S.list.length) { box.innerHTML = S.loading ? '<div class="pi-loading">读取公开合同…</div>' : soldHtml() + note + '<p class="text-muted">没有符合条件的合同</p>'; return; }
    box.innerHTML = soldHtml() + note +
      `<div class="table-scroll"><table class="pc-mini-table ct-table">${tableHead(true)}<tbody>${publicRows()}</tbody></table></div>` +
      (S.list.length < S.total ? `<div class="au-more"><button class="btn btn-ghost" data-ct-more${S.loading ? ' disabled' : ''}>${S.loading ? '读取中…' : `再显示 ${Math.min(PAGE, S.total - S.list.length)} 份`}</button></div>` : '');
    return;
  }
  if (!ctx.hasEsiToken()) {
    box.innerHTML = '<div class="empty-state"><p>绑定 ESI 角色后可以查看个人、军团与联盟合同。</p><button class="btn btn-primary" data-ct-bind>绑定角色</button></div>';
    return;
  }
  const st = S.esi.get(S.tab);
  if (!st || st.loading) { box.innerHTML = '<div class="pi-loading">读取合同…</div>'; if (!st) loadEsi(S.tab); return; }
  if (st.scope) { box.innerHTML = ctx.scopeNeededHtml('corpContracts', '查看军团合同'); return; }
  if (st.error) { box.innerHTML = `<p class="text-muted">读取失败：${esc(st.error)}</p>`; return; }
  const note = S.tab === 'alliance'
    ? '<p class="text-muted ct-note">ESI 没有联盟合同接口：这里是个人与军团合同里可见范围为「联盟」的合同；指派给联盟、但你和军团都不是发起方或接受方的合同读不到。</p>'
    : S.tab === 'corp' ? '<p class="text-muted ct-note">军团发起、接受或指派给军团的合同（ESI 只返回 30 天内的合同与进行中的快递）。</p>'
      : '<p class="text-muted ct-note">你发起、接受或指派给你的合同（ESI 只返回 30 天内的合同）。</p>';
  const rows = esiRows(st.list);
  box.innerHTML = note + (rows ? `<div class="table-scroll"><table class="pc-mini-table ct-table">${tableHead(false)}<tbody>${rows}</tbody></table></div>` : '<p class="text-muted">没有合同</p>');
}

// ---------------- 详情
function modal() {
  let m = $('ctModal');
  if (m) return m;
  m = document.createElement('div');
  m.className = 'modal';
  m.id = 'ctModal';
  m.hidden = true;
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.innerHTML = `<div class="modal-backdrop" data-ct-close></div><div class="modal-content ct-modal">
    <div class="modal-header"><h3 id="ctTitle">合同</h3><button class="modal-close" data-ct-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <div class="modal-body" id="ctDetail"></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target.closest('[data-ct-close]')) { m.hidden = true; return; }
    const g = e.target.closest('[data-ct-game]');
    if (g) { ctx.game.contract(Number(g.dataset.ctGame)); return; }
    const j = e.target.closest('[data-ct-jump]');
    if (j) openPublic(Number(j.dataset.ctJump));
  });
  m.addEventListener('change', (e) => {
    if (e.target.closest('.val-src')) { ctx.valuation.set(e.target.value); if (S.detail) renderDetail(S.detail); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; } }, true);
  return m;
}

async function openPublic(id) {
  const m = modal();
  m.hidden = false;
  $('ctTitle').textContent = '合同 #' + id;
  $('ctTitle').setAttribute('translate', 'yes');
  $('ctDetail').innerHTML = '<div class="pi-loading">读取合同…</div>';
  try {
    const r = await fetch('/api/kb/contracts/' + id);
    const c = await r.json();
    if (!r.ok) throw new Error(r.status === 404 ? '存档里没有这份合同' : c.error || 'HTTP ' + r.status);
    let bids = null;
    if (c.type === 'auction' && c.status === 'open') {
      bids = await fetch(`${ctx.esiBase}/contracts/public/bids/${id}/?datasource=${ctx.datasource}`).then((x) => (x.status === 204 ? [] : x.ok ? x.json() : null)).catch(() => null);
    }
    await Promise.all([fillNames([c.issuer_id, c.issuer_corp]), fillTypes(c.items.map((i) => i.type_id))]);
    S.detail = { kind: 'public', c, items: c.items, bids };
    renderDetail(S.detail);
  } catch (error) {
    $('ctDetail').innerHTML = '<p class="text-muted">读取失败：' + esc(error.message) + '</p>';
  }
}

async function openEsi(c) {
  const m = modal();
  m.hidden = false;
  $('ctTitle').textContent = unent(c.title) || '合同 #' + c.contract_id;
  $('ctTitle').setAttribute('translate', c.title ? 'no' : 'yes');
  $('ctDetail').innerHTML = '<div class="pi-loading">读取合同物品…</div>';
  try {
    const me = await myInfo();
    const base = c._src === 'corp' ? `/corporations/${me.corp}/contracts/${c.contract_id}` : `/characters/${me.id}/contracts/${c.contract_id}`;
    const [items, bids] = await Promise.all([
      c.type === 'courier' ? [] : ctx.esiAuthFetch(base + '/items/').then((x) => x || []).catch(() => []),
      c.type === 'auction' ? ctx.esiAuthFetch(base + '/bids/').then((x) => x || []).catch(() => null) : null
    ]);
    await Promise.all([fillNames([c.issuer_id, c.issuer_corporation_id, c.acceptor_id, c.assignee_id]), fillTypes(items.map((i) => i.type_id))]);
    S.detail = { kind: 'esi', c, items: items.map((i) => ({ ...i, is_blueprint_copy: i.raw_quantity === -2 })), bids };
    renderDetail(S.detail);
  } catch (error) {
    $('ctDetail').innerHTML = '<p class="text-muted">读取失败：' + esc(error.message) + '</p>';
  }
}

function compareCard(label, price, value, noun) {
  if (!value || !price) return '';
  const diff = price - value, pct = (diff / value) * 100;
  return ctx.valuationCard(label, (diff <= 0 ? '低 ' : '高 ') + ctx.formatISK(Math.abs(diff)) + ' ISK',
    `${noun}为估值的 ${((price / value) * 100).toFixed(1)}%（${pct <= 0 ? '低' : '高'}${Math.abs(pct).toFixed(1)}%）`, diff <= 0 ? 'is-buy' : 'is-sell');
}

async function renderDetail(d) {
  const { c, items } = d;
  const body = $('ctDetail');
  const pub = d.kind === 'public';
  const given = items.filter((i) => i.is_included);
  const wanted = items.filter((i) => !i.is_included);
  const { formatISK, formatNumber } = ctx;
  body.innerHTML = '<div class="pi-loading">读取行情…</div>';
  const [vg, vw] = await Promise.all([ctx.valuation.items(given), wanted.length ? ctx.valuation.items(wanted) : null]);
  if (S.detail !== d) return;
  const top = d.bids?.length ? Math.max(...d.bids.map((b) => b.amount)) : (pub ? c.top_bid : 0);
  const price = pub ? priceOf({ ...c, top_bid: top || c.top_bid }) : c.type === 'courier' ? c.reward : c.type === 'auction' ? (top || c.price) : c.price || c.reward;
  const status = pub ? STATUS_ZH[c.status] : esiStatus(c)[1];
  const priceLabel = c.type === 'courier' ? '报酬' : c.type === 'auction' ? (pub && c.status === 'done' ? '成交价（推测）' : top ? '当前最高出价' : '起拍价') : pub && c.status === 'done' ? '成交价（推测）' : c.price ? '合同价格' : '收购报酬';
  const issued = pub ? c.issued : c.date_issued, expires = pub ? c.expires : c.date_expired;
  const kv = (k, v) => (v ? `<div class="kv"><span>${esc(k)}</span><strong>${v}</strong></div>` : '');
  const loc = pub ? c.location_id : c.start_location_id;
  const end = c.end_location_id && c.end_location_id !== loc ? c.end_location_id : null;
  const info =
    kv('标题', c.title ? `<span translate="no">${esc(unent(c.title))}</span>` : '') +
    kv('类别', esc(TYPE_ZH[c.type] || c.type)) +
    kv('状态', `<span class="pill${pub ? ' ct-st-' + c.status : ' status-' + esiStatus(c)[0]}">${esc(status)}</span>`) +
    (pub ? '' : kv('可见范围', `<span>${esc(AVAIL_ZH[c.availability] || c.availability)}</span>` + (c.for_corporation ? '<span>（代表军团）</span>' : ''))) +
    kv('发起人', esc(nameOf(c.issuer_id)) + (pub && c.for_corp ? '<span>（代表军团）</span>' : '')) +
    kv('发起军团', esc(nameOf(pub ? c.issuer_corp : c.issuer_corporation_id))) +
    (pub ? '' : kv('指派对象', c.assignee_id ? esc(nameOf(c.assignee_id)) : '') + kv('接受人', c.acceptor_id ? esc(nameOf(c.acceptor_id)) : '')) +
    kv(c.type === 'courier' ? '起点' : '地点', esc(pub ? place(c) : ctx.locationName(loc))) +
    kv('终点', end ? esc(ctx.locationName(end)) : '') +
    kv('完成期限', c.type === 'courier' && (c.days || c.days_to_complete) ? (c.days || c.days_to_complete) + ' 天' : '') +
    kv('体积', c.volume ? formatNumber(Math.round(c.volume)) + ' m³' : '') +
    kv('发布时间', esc(fmtTime(issued))) + kv('到期时间', esc(fmtTime(expires))) +
    (pub ? kv('最后见到', esc(fmtTime(c.last_seen))) + kv(c.status === 'open' ? '' : '消失于（快照）', c.status === 'open' ? '' : esc(fmtTime(c.ended))) : '') +
    (pub ? '' : kv('接受时间', esc(fmtTime(c.date_accepted))) + kv('完成时间', esc(fmtTime(c.date_completed))));
  const repost = pub && c.repost ? `<p class="ct-repost"><span>撤单后重发为</span> <button class="link-btn" data-ct-jump="${c.repost}">#${c.repost}</button>${c.repost_status ? ` <span class="pill ct-st-${c.repost_status}">${esc(STATUS_ZH[c.repost_status] || c.repost_status)}</span>` : ''}</p>`
    : pub && c.repost_of ? `<p class="ct-repost"><span>撤单重发自</span> <button class="link-btn" data-ct-jump="${c.repost_of}">#${c.repost_of}</button></p>` : '';
  let cards = ctx.valuationCard(priceLabel, price ? formatISK(price) + ' ISK' : '—',
    c.type === 'courier' ? '抵押 ' + formatISK(c.collateral) : c.type === 'auction' ? (c.buyout ? '一口价 ' + formatISK(c.buyout) : '没有一口价') + (d.bids ? ` · ${d.bids.length} 次出价` : c.bids ? ` · ${c.bids} 次出价` : '') : '', 'is-order');
  if (c.type !== 'courier') {
    // 只放一张对比卡：有成交中位价时对比它（不受挂单乱价影响），否则对比最低卖价
    if (vg.n) cards += ctx.valuation.cards(vg, '物品估值') + (vg.mid ? compareCard('对比成交价估值', price, vg.mid, '价格') : compareCard('对比卖价估值', price, vg.sell, '价格'));
    if (vw?.n) cards += ctx.valuation.cards(vw, '索取物品');
    if (given.length && !vg.n) cards += ctx.valuationCard('物品估值', '—', '蓝图副本没有市场价');
  }
  const row = (i, v) => {
    const p = i.is_blueprint_copy ? {} : v.price(i.type_id);
    const cell = (x, cls = '') => (x == null ? '<td class="num muted-cell">—</td>' : `<td class="num ${cls}">${formatISK(x * i.quantity)}</td>`);
    return `<tr><td><div class="ct-item"><img src="${ctx.icon(i.type_id)}" onerror="if(!this.dataset.bp){this.dataset.bp=1;this.src=this.src.replace('/icon','/bp')}" alt="" width="24" height="24" loading="lazy"><span>${esc(typeName(i.type_id))}${i.is_blueprint_copy ? ' <span class="pill">蓝图副本</span>' : ''}${i.runs > 0 || i.me || i.te ? `<span class="cell-sub">${i.runs > 0 ? i.runs + ' 流程 · ' : ''}ME ${i.me || 0} · TE ${i.te || 0}</span>` : ''}</span></div></td>
      <td class="num">${formatNumber(i.quantity)}</td>${cell(p.sell, 'down')}${cell(p.buy, 'up')}${ctx.valuation.hasMed() ? cell(p.mid, 'mid-cell') : ''}</tr>`;
  };
  const table = (list, v, title) => (list.length ? `<h4 class="info-section-title section-gap">${esc(title)}（${list.length}）</h4>
    <div class="table-scroll"><table class="pc-mini-table ct-items"><thead><tr><th>物品</th><th class="num">数量</th><th class="num">卖价估值</th><th class="num">收价估值</th>${ctx.valuation.hasMed() ? '<th class="num">成交价估值</th>' : ''}</tr></thead>
    <tbody>${list.sort((a, b) => (v.price(b.type_id).sell || 0) * b.quantity - (v.price(a.type_id).sell || 0) * a.quantity).map((i) => row(i, v)).join('')}</tbody></table></div>` : '');
  const open = pub ? c.status === 'open' : c.status === 'outstanding';
  body.innerHTML = repost +
    `<div class="valuation-grid ct-grid">${cards}</div>
    <div class="valuation-toolbar">${ctx.valuation.select('', vg.region)}<span class="toolbar-spacer"></span>${open ? `<button class="btn" data-ct-game="${c.contract_id}" title="需要「游戏内操作」权限，角色需在线">游戏内打开合同</button>` : ''}</div>
    <div class="kv-grid">${info}</div>
    ${c.type === 'courier' && pub ? '<p class="text-muted">公开快递合同的物品不对外公开</p>' : ''}
    ${table(given, vg, c.type === 'courier' ? '运送物品' : '提供物品')}${vw ? table(wanted, vw, '索取物品') : ''}
    ${d.bids?.length ? `<h4 class="info-section-title section-gap">出价记录（${d.bids.length}）</h4><div class="table-scroll"><table class="pc-mini-table"><thead><tr><th>出价</th><th>时间</th></tr></thead><tbody>${[...d.bids].sort((a, b) => b.amount - a.amount).map((b) => `<tr><td>${ctx.formatPrice(b.amount)} ISK</td><td>${esc(fmtTime(b.date_bid))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ---------------- 入口
export async function showContracts() {
  const main = $('ctMain');
  if (main.dataset.ready) {
    if (!isPublic() && !S.esi.has(S.tab)) renderBody();
    return;
  }
  main.dataset.ready = '1';
  main.innerHTML = `<section class="ct-page">
    <div class="ap-head"><h2>合同</h2><span class="text-muted">全服公开合同（含推测成交的历史合同）与我的个人 / 军团 / 联盟合同</span></div>
    <div class="ct-tabbar" id="ctTabs"></div>
    <div class="cr-toolbar ct-filters" id="ctFilters"></div>
    <div id="ctBody"></div></section>`;
  ctx.loadMarketRegions?.().then(() => { if (isPublic()) renderFilters(); }).catch(() => {});
  renderTabs();
  renderFilters();
  main.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-ct-tab]');
    if (tab && !tab.disabled) {
      const was = isPublic();
      S.tab = tab.dataset.ctTab;
      if (isPublic() && (!was || S.sort)) S.sort = '';
      save(); renderTabs(); renderFilters();
      if (isPublic()) loadPublic(); else renderBody();
      return;
    }
    if (e.target.closest('[data-ct-more]')) { loadPublic(true); return; }
    if (e.target.closest('[data-ct-order]')) { S.order = S.order === 'asc' ? 'desc' : 'asc'; renderFilters(); loadPublic(); return; }
    if (e.target.closest('[data-ct-reload]')) { if (isPublic()) loadPublic(); else loadEsi(S.tab, true); return; }
    if (e.target.closest('[data-ct-bind]')) { ctx.openEsiBind(); return; }
    const row = e.target.closest('[data-ct]');
    if (row) { openPublic(Number(row.dataset.ct)); return; }
    const er = e.target.closest('[data-ct-esi]');
    if (er) { const c = S.esi.get(S.tab)?.list?.find((x) => x.contract_id === Number(er.dataset.ctEsi)); if (c) openEsi(c); }
  });
  main.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.ct-row')) e.target.closest('.ct-row').click(); });
  main.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-ct-type]')) { S.type = t.value; save(); if (isPublic()) loadPublic(); else renderBody(); }
    else if (t.matches('[data-ct-region]')) { S.region = Number(t.value); save(); loadPublic(); }
    else if (t.matches('[data-ct-sort]')) { S.sort = t.value; loadPublic(); }
  });
  let timer = 0;
  main.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.matches('[data-ct-q], [data-ct-item]')) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (t.matches('[data-ct-q]')) { S.q = t.value.trim(); if (isPublic()) loadPublic(); else renderBody(); return; }
      S.item = t.value.trim();
      S.itemIds = await matchItems(S.item);
      loadPublic();
    }, 350);
  });
  if (isPublic()) loadPublic(); else renderBody();
}
