// ===== 广场 =====（顶部导航「广场」，地址栏 #plaza）
// 玩家用本站绑定的 ESI 角色发帖，经击杀记录服务（kb_service.py 的 Plaza）保存：
//   招新：军团招新广告，服务器读角色所在军团（同一军团一条，发布人或 CEO 可改）；
//   组队：服务器读角色当前舰队，必须是舰队老板，附人数、常见舰船、所在星系；
//   集市：挂自己发起的公开合同（服务器从 ESI 读合同与物品清单），合同到期一起下架；
//   其他：自由发帖。
// GET /api/kb/plaza?server= 读全部未过期帖子；POST /api/kb/plaza/{save,delete,contracts} 带角色令牌；站长 IP 可删帖（admin/*）。
// 列表：「全部」按分类分区显示（每类最新几条 +「查看全部」），也可以切到单个分类或「我的」；发帖是单独一页，先选分类再填表。
// 地址栏：#plaza · #plaza/<类型> · #plaza/new[/<类型>] · #plaza/new/market/<合同ID>/<角色ID>（合同页「挂到广场」）· #plaza/recruit/corp/<军团ID> · #plaza/p/<帖子ID>
import { SERVER } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';

let ctx = null;   // esc, formatISK, formatNumber, showToast, copyText, store, accounts, accountToken, openEsiBind, game, resolveTypeNames, valuation, openTicket
const $ = (id) => document.getElementById(id);
const EN = window.I18N?.lang === 'en';
const tr = (t) => (EN && window.I18N.t ? window.I18N.t(t) : t);   // confirm 里的文字不走自动翻译
const STORE_KEY = 'eve-plaza-v1';
const KINDS = [['all', '全部'], ['recruit', '招新'], ['fleet', '组队'], ['market', '集市'], ['other', '其他'], ['mine', '我的']];
const KIND_NAME = Object.fromEntries(KINDS);
const POST_KINDS = ['recruit', 'fleet', 'market', 'other'];
const SECTION_MAX = 6;   // 「全部」里每类显示几条
// 分类图标：游戏客户端窗口图标原样显示（res:/ui/texture/windowicons/recruitment · fleet · market · chatchannels），底色同游戏里的深色。图标版权归 CCP。
const kindIcon = (k) => `<span class="pz-kicon"><img src="assets/plaza/${k}.png?v=1" alt="" width="64" height="64"></span>`;
const CT_TYPE = { item_exchange: '物品交换', auction: '拍卖', courier: '快递' };
const FLEET_SCOPE = 'esi-fleets.read_fleet.v1';
const IMG = (path, size = 64) => `https://images.evetech.net/${path}?size=${size}`;
const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

const S = {
  kind: 'all', view: 'list', q: '', tag: '', corp: 0, pid: 0,
  items: null, tags: {}, at: 0, loading: null, error: '',
  form: null,              // { kind, char, id?, contract? }：正在填写的发帖表单
  contracts: new Map(),    // 角色 ID -> { loading, items, error }
  names: new Map(), worth: new Map(), admin: false, char: 0, otherMax: 3
};

export function initPlaza(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {}) || {};
  if (KIND_NAME[saved.kind]) S.kind = saved.kind;
  if (saved.char) S.char = saved.char;
  // 站长入口：只有在 EVE_FEEDBACK_ADMIN_IPS 里的 IP 才返回 200
  fetch('/api/kb/plaza/admin/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => { S.admin = r.ok; if (S.admin && S.items) render(); }).catch(() => {});
}
const save = () => ctx.store.setJSON(STORE_KEY, { kind: S.kind, char: S.char });

function load(force = false) {
  if (S.loading) return S.loading;
  if (!force && S.items && Date.now() - S.at < 60e3) return Promise.resolve();
  S.loading = fetch(`/api/kb/plaza?server=${SERVER.id}`)
    .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; })
    .then((d) => { S.items = d.items || []; S.tags = d.tags || {}; S.otherMax = d.other_max || 3; S.at = Date.now(); S.error = ''; resolveItemNames(); })
    .catch((e) => { S.error = e.message; })
    .finally(() => { S.loading = null; });
  return S.loading;
}
export const preload = () => load();

async function post(op, char, body) {
  const token = await ctx.accountToken(char);
  const res = await fetch('/api/kb/plaza/' + op, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.access_token },
    body: JSON.stringify({ server: SERVER.id, character_id: char, ...body })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'HTTP ' + res.status);
  return out;
}

// 集市帖子里的物品名与估值（按全站估值来源的卖价，一次批量读）
async function resolveItemNames() {
  const market = (S.items || []).filter((p) => p.kind === 'market');
  const ids = [...new Set([...market.flatMap((p) => (p.data.items || []).map((i) => i[0])),
    ...(S.items || []).filter((p) => p.kind === 'fleet').flatMap((p) => (p.data.ships || []).map((x) => x[0]))])].filter((id) => !S.names.has(id));
  if (ids.length) {
    try { for (const [id, n] of await ctx.resolveTypeNames(ids)) S.names.set(id, n); } catch { /* 名称读不到就显示 ID */ }
  }
  const all = market.flatMap((p) => (p.data.items || []).filter((i) => i[2] && !i[3]).map((i) => ({ type_id: i[0], quantity: i[1] })));
  if (all.length) {
    try {
      const v = await ctx.valuation.items(all);
      for (const p of market) {
        const given = (p.data.items || []).filter((i) => i[2] && !i[3]);
        S.worth.set(p.id, given.reduce((t, i) => t + (v.price(i[0]).sell || 0) * i[1], 0) || null);
      }
    } catch { /* 估值失败不影响帖子 */ }
  }
  if (ids.length || all.length) paintList();
}

// ---------- 页面 ----------
export async function showPlaza(hash) {
  const main = $('plazaMain');
  route(hash || location.hash);
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `<section class="pi-page pz-page">
      <div class="pi-head"><h2>广场</h2>
        <div class="segmented pz-tabs" role="tablist">${KINDS.map(([k, l]) => `<button type="button" data-pz-kind="${k}">${l}</button>`).join('')}</div>
        <span class="toolbar-spacer"></span><button type="button" class="btn btn-primary btn-sm pz-new-btn" data-pz-new>${'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'}<span>发帖</span></button></div>
      <div id="pzBody">${skPage({ title: false, cards: 2, rows: 6 })}</div></section>`;
    main.addEventListener('click', onClick);
    main.addEventListener('input', onInput);
    main.addEventListener('change', onChange);
    main.addEventListener('submit', (e) => { if (e.target.matches('[data-pz-form]')) { e.preventDefault(); submit(e.target); } });
  }
  render();
  await load();
  render();
}

function route(hash) {
  const m = /^#plaza\/?(\w+)?\/?([^/?]+)?\/?([^/?]+)?\/?([^/?]+)?/.exec(hash);
  if (!m) return;
  S.corp = 0; S.pid = 0; S.view = 'list';
  if (m[1] === 'p' && m[2]) { S.pid = Number(m[2]); return; }
  // 发帖页：#plaza/new/<类型>/<合同ID>/<角色ID>；旧地址 #plaza/<类型>/new/<合同ID>/<角色ID> 同样认
  const newPage = m[1] === 'new' ? [m[2], m[3], m[4]] : m[2] === 'new' ? [m[1], m[3], m[4]] : null;
  if (newPage) {
    S.view = 'new';
    if (POST_KINDS.includes(newPage[0])) openForm(newPage[0], { contract: Number(newPage[1]) || 0, char: Number(newPage[2]) || 0 });
    else S.form = null;
    return;
  }
  S.kind = KIND_NAME[m[1]] ? m[1] : m[1] ? S.kind : 'all';
  if (m[1] === 'recruit' && m[2] === 'corp') S.corp = Number(m[3]) || 0;
}
function setHash() {
  const h = S.view === 'new' ? `#plaza/new${S.form ? '/' + S.form.kind : ''}` : S.pid ? `#plaza/p/${S.pid}` : S.corp ? `#plaza/recruit/corp/${S.corp}` : S.kind === 'all' ? '#plaza' : `#plaza/${S.kind}`;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

function render() {
  const body = $('pzBody');
  if (!body) return;
  const shown = S.view === 'new' ? '' : S.pid ? S.items?.find((p) => p.id === S.pid)?.kind || S.kind : S.kind;
  document.querySelectorAll('.pz-tabs [data-pz-kind]').forEach((b) => b.classList.toggle('active', b.dataset.pzKind === shown));
  document.querySelector('.pz-new-btn')?.classList.toggle('hidden', S.view === 'new');
  setHash();
  if (S.view === 'new') {
    body.innerHTML = newPageHtml();
    if (S.form?.kind === 'market') loadContracts(S.form.char);
    return;
  }
  body.innerHTML = `<div id="pzList">${listHtml()}</div>`;
}

// 发帖页：先选分类（修改已有帖子时分类固定），再填表
function newPageHtml() {
  const { esc } = ctx;
  const f = S.form;
  const editing = Boolean(f?.id);
  const pick = POST_KINDS.map((k) => `<button type="button" class="pz-pick${f?.kind === k ? ' active' : ''}" data-pz-pick="${k}"${editing && f.kind !== k ? ' disabled' : ''}>
      ${kindIcon(k)}<b>${esc(KIND_NAME[k])}</b></button>`).join('');
  return `<div class="pz-new-page">
      <div class="pz-new-head"><button type="button" class="btn btn-ghost btn-sm" data-pz-back>← 返回广场</button><h3>${editing ? '修改帖子' : '发帖'}</h3></div>
      <div class="pz-new-body">
        <div class="pz-picks" role="radiogroup" aria-label="分类">${pick}</div>
        <div class="pi-card pz-new-form">${f ? formHtml() : '<div class="pz-new-hint">选择要发布到的分类</div>'}</div>
      </div>
    </div>`;
}
function paintList() {
  const box = $('pzList');
  if (box) box.innerHTML = listHtml();
}

const myIds = () => new Set((ctx.accounts?.() || []).map((a) => a.id));
const matchQ = (p) => {
  const q = S.q.trim().toUpperCase();
  if (!q) return true;
  const d = p.data || {};
  return [p.title, p.text, p.name, p.contact, d.corp_name, d.ticker, d.alliance_name, d.author_corp, d.system, d.location, d.ctitle,
    ...(p.tags || []), ...(d.items || []).map((i) => S.names.get(i[0]))].some((t) => t && String(t).toUpperCase().includes(q));
};

function listHtml() {
  const { esc } = ctx;
  if (!S.items) return S.error ? `<div class="pi-card"><p class="text-muted">广场读取失败：${esc(S.error)}</p></div>` : `<div class="pi-card"><div class="pi-loading">读取广场…</div></div>`;
  const mine = myIds();
  let list;
  if (S.kind === 'all' && !S.pid) return allHtml(mine);
  if (S.pid) list = S.items.filter((p) => p.id === S.pid);
  else if (S.kind === 'mine') list = S.items.filter((p) => mine.has(p.char_id) || (p.kind === 'recruit' && mine.has(p.data?.ceo_id)));
  else list = S.items.filter((p) => p.kind === S.kind && (!S.corp || p.corp_id === S.corp));
  const total = list.length;
  if (!S.pid) list = list.filter((p) => matchQ(p) && (!S.tag || (p.tags || []).includes(S.tag)));
  const tags = S.kind !== 'mine' ? S.tags[S.kind] || [] : [];
  const head = S.pid ? `<div class="pi-card pz-filters"><div class="pz-filter-row"><button type="button" class="btn btn-ghost btn-sm" data-pz-kind="${esc(list[0]?.kind || S.kind)}">← 返回${esc(KIND_NAME[list[0]?.kind || S.kind])}</button></div></div>`
    : `<div class="pi-card pz-filters">
      <div class="pz-filter-row">
        ${searchBox()}
        ${tags.length ? `<div class="wh-chips">${['', ...tags].map((t) => `<button type="button" class="wh-chip${S.tag === t ? ' active' : ''}" data-pz-tag="${esc(t)}">${t ? esc(t) : '全部'}</button>`).join('')}</div>` : ''}
        <span class="toolbar-spacer"></span>${S.corp ? '<button type="button" class="btn btn-ghost btn-sm" data-pz-kind="recruit">看全部招新</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" data-pz-reload>刷新</button>
      </div></div>`;
  if (!list.length) {
    const empty = total ? '没有匹配的帖子' : S.kind === 'mine' ? '你还没有发过帖子' : S.corp ? '这个军团现在没有招新广告' : `现在还没有${KIND_NAME[S.kind]}帖子`;
    return head + `<div class="pi-card pz-empty"><p class="text-muted">${empty}</p>${!total && S.kind !== 'mine' ? `<button type="button" class="btn btn-primary btn-sm" data-pz-new="${S.kind}">发第一条</button>` : ''}</div>`;
  }
  return head + `<div class="pz-grid">${list.map((p) => cardHtml(p, mine)).join('')}</div>`;
}

const searchBox = () => `<div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
  <input type="search" data-pz-q placeholder="搜索标题、内容、军团、星系、物品" value="${ctx.esc(S.q)}" spellcheck="false" autocomplete="off" aria-label="搜索广场"></div>`;

// 「全部」：按分类分区，每类最新 SECTION_MAX 条
function allHtml(mine) {
  const { esc } = ctx;
  const q = S.q.trim();
  const sections = POST_KINDS.map((k) => {
    const all = S.items.filter((p) => p.kind === k);
    const list = all.filter(matchQ);
    const body = list.length ? `<div class="pz-grid">${list.slice(0, SECTION_MAX).map((p) => cardHtml(p, mine)).join('')}</div>`
      : `<div class="pz-sec-empty"><span class="text-muted">${q && all.length ? '没有匹配的帖子' : `现在还没有${KIND_NAME[k]}帖子`}</span>${q && all.length ? '' : `<button type="button" class="link-btn" data-pz-new="${k}">发一条</button>`}</div>`;
    return `<section class="pz-sec">
      <div class="pz-sec-head">${kindIcon(k)}<h3>${esc(KIND_NAME[k])}</h3><span class="pz-count">${q ? `${list.length} / ${all.length}` : all.length}</span>
        <span class="toolbar-spacer"></span>${all.length ? `<button type="button" class="link-btn" data-pz-kind="${k}">查看全部${KIND_NAME[k]} →</button>` : ''}</div>
      ${body}</section>`;
  }).join('');
  return `<div class="pi-card pz-filters"><div class="pz-filter-row">${searchBox()}<span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-pz-reload>刷新</button></div></div>${sections}`;
}

function ago(ts) {
  const m = (Date.now() / 1000 - ts) / 60;
  return m < 60 ? Math.max(1, Math.round(m)) + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
}
function left(ts) {
  const h = (ts - Date.now() / 1000) / 3600;
  return h < 1 ? '不到 1 小时后下架' : h < 48 ? Math.round(h) + ' 小时后下架' : Math.round(h / 24) + ' 天后下架';
}

function cardHtml(p, mine) {
  const { esc, formatISK, formatNumber } = ctx;
  const d = p.data || {};
  const own = mine.has(p.char_id) || (p.kind === 'recruit' && mine.has(d.ceo_id));
  const author = `<span class="pz-author"><img src="${IMG(`characters/${p.char_id}/portrait`, 32)}" alt="" width="20" height="20" loading="lazy"><b class="notranslate">${esc(p.name)}</b>${d.author_corp && p.kind !== 'recruit' ? `<small class="notranslate">${esc(d.author_corp)}</small>` : ''}</span>`;
  const tags = (p.tags || []).length ? `<div class="pz-tags">${p.tags.map((t) => `<span class="pz-tag">${esc(t)}</span>`).join('')}</div>` : '';
  const text = p.text ? `<p class="pz-text notranslate">${esc(p.text)}</p>` : '';
  const contact = p.contact ? `<div class="pz-contact"><span>联系：</span><b class="notranslate">${esc(p.contact)}</b><button type="button" class="link-btn" data-pz-copy="${esc(p.contact)}">复制</button></div>` : '';
  let head = '', facts = [], extra = '', game = '';
  if (p.kind === 'recruit') {
    head = `<img class="pz-logo" src="${IMG(`corporations/${p.corp_id}/logo`, 64)}" alt="" width="48" height="48" loading="lazy">
      <div class="pz-head-main"><a class="pz-name notranslate" href="#kb/corporation/${p.corp_id}">${esc(d.corp_name || '')}${d.ticker ? ` <small>[${esc(d.ticker)}]</small>` : ''}</a>
        ${d.alliance_name ? `<small class="notranslate">${esc(d.alliance_name)}</small>` : '<small>无联盟</small>'}</div>`;
    if (d.members != null) facts.push(`<span>${formatNumber(d.members)} 名成员</span>`);
    if (d.tax != null) facts.push(`<span>税率 ${Math.round(d.tax * 1000) / 10}%</span>`);
    if (d.founded) facts.push(`<span>成立于 ${esc(String(d.founded).slice(0, 10))}</span>`);
    game = `<button type="button" class="btn btn-ghost btn-sm" data-pz-info="${p.corp_id}" title="需要「游戏内操作」权限，角色需在线">游戏内查看军团</button>`;
  } else if (p.kind === 'fleet') {
    head = `<img class="pz-logo round" src="${IMG(`characters/${p.char_id}/portrait`, 64)}" alt="" width="48" height="48" loading="lazy">
      <div class="pz-head-main">${p.title ? `<b class="pz-name notranslate">${esc(p.title)}</b>` : '<b class="pz-name">组队</b>'}<small><span>舰队老板</span> <span class="notranslate">${esc(p.name)}</span>${d.author_corp ? ` · <span class="notranslate">${esc(d.author_corp)}</span>` : ''}</small></div>`;
    facts.push(`<span>${formatNumber(d.members || 0)} 人</span>`);
    if (d.system) facts.push(`<span><span>在</span> <b class="notranslate">${esc(d.system)}</b></span>`);
    if (d.free_move) facts.push('<span>自由移动</span>');
    if ((d.ships || []).length) extra = `<div class="pz-ships">${d.ships.map(([t, n]) => `<span title="${esc(S.names.get(t) || '')}"><img src="${ICON(t)}" data-item-pop="${t}" alt="" width="24" height="24" loading="lazy">×${n}</span>`).join('')}</div>`;
    game = `<button type="button" class="btn btn-ghost btn-sm" data-pz-info="${p.char_id}" title="在游戏里打开舰队老板的人物信息，可以直接私聊；需要「游戏内操作」权限">游戏内找老板</button>`;
  } else if (p.kind === 'market') {
    const price = d.type === 'courier' ? d.reward : d.price;
    const worth = S.worth.get(p.id);
    head = `<span class="pz-ct-type pz-ct-${esc(d.type)}">${esc(CT_TYPE[d.type] || d.type)}</span>
      <div class="pz-head-main"><b class="pz-name notranslate">${esc(p.title || d.ctitle || '（无标题）')}</b><small>${d.system ? `<span class="notranslate">${esc(d.location || d.system)}</span>` : '<span>地点未知</span>'}</small></div>
      <div class="pz-price"><b>${formatISK(price || 0)}</b><small>${d.type === 'courier' ? '报酬' : d.type === 'auction' ? (d.buyout ? '起拍 · 一口价 ' + formatISK(d.buyout) : '起拍价') : 'ISK'}</small></div>`;
    if (worth) facts.push(`<span title="提供物品按估值来源的最低卖价合计">物品估值 ${formatISK(worth)}</span>`);
    if (d.type === 'courier') facts.push(`<span>抵押 ${formatISK(d.collateral || 0)}</span>`, `<span>${formatNumber(Math.round(d.volume || 0))} m³</span>`);
    const items = (d.items || []).filter((i) => i[2]);
    const wanted = (d.items || []).filter((i) => !i[2]);
    const itemRow = (i) => `<li><img src="${ICON(i[0])}"${i[3] ? '' : ` data-item-pop="${i[0]}"`} alt="" width="24" height="24" loading="lazy"><span class="notranslate">${esc(S.names.get(i[0]) || 'Type ' + i[0])}</span>${i[3] ? '<small>拷贝</small>' : ''}<b>×${formatNumber(i[1])}</b></li>`;
    if (d.type !== 'courier' && items.length) extra = `<ul class="pz-items">${items.slice(0, 6).map(itemRow).join('')}</ul>${d.n_items > 6 ? `<small class="text-muted">共 ${d.n_items} 项</small>` : ''}`;
    if (wanted.length) extra += `<div class="pz-wanted"><span>索取：</span><ul class="pz-items">${wanted.slice(0, 4).map(itemRow).join('')}</ul></div>`;
    game = `<button type="button" class="btn btn-ghost btn-sm" data-pz-contract="${d.contract_id}" title="需要「游戏内操作」权限，角色需在线">游戏内打开合同</button>`;
  } else {
    head = `<img class="pz-logo round" src="${IMG(`characters/${p.char_id}/portrait`, 64)}" alt="" width="48" height="48" loading="lazy">
      <div class="pz-head-main"><b class="pz-name notranslate">${esc(p.title || '')}</b><small class="notranslate">${esc(p.name)}${d.author_corp ? ' · ' + esc(d.author_corp) : ''}</small></div>`;
  }
  const title = p.kind === 'recruit' && p.title ? `<h4 class="pz-title notranslate">${esc(p.title)}</h4>` : '';
  const actions = [game,
    own ? `<button type="button" class="btn btn-ghost btn-sm" data-pz-edit="${p.id}">${p.kind === 'fleet' || p.kind === 'market' ? '更新' : '修改'}</button><button type="button" class="btn btn-ghost btn-sm" data-pz-del="${p.id}">撤下</button>` : '',
    S.admin && !own ? `<button type="button" class="btn btn-ghost btn-sm pz-admin" data-pz-admin-del="${p.id}">站长删除</button>` : ''].join('');
  return `<article class="pz-card pz-${p.kind}${S.pid === p.id ? ' focus' : ''}">
    <div class="pz-head">${head}</div>
    ${title}${tags}${facts.length ? `<div class="pz-facts">${facts.join('')}</div>` : ''}${extra}${text}${contact}
    ${actions.trim() ? `<div class="pz-actions">${actions}</div>` : ''}
    <div class="pz-foot">${p.kind === 'recruit' || p.kind === 'market' ? author : ''}<span class="pz-time" title="${esc(left(p.expires))}">${ago(p.updated)}</span>
      <span class="toolbar-spacer"></span>
      <button type="button" class="link-btn" data-pz-link="${p.id}">复制链接</button>
      <button type="button" class="link-btn" data-pz-report="${p.id}">举报</button></div>
  </article>`;
}

// ---------- 发帖表单 ----------
function openForm(kind, extra = {}) {
  const chars = ctx.accounts?.() || [];
  const ok = (id) => chars.some((a) => a.id === id);
  S.form = { kind, ...extra, char: ok(extra.char) ? extra.char : ok(S.char) ? S.char : chars[0]?.id || 0 };
}

function formHtml() {
  const { esc } = ctx;
  const f = S.form;
  const chars = ctx.accounts?.() || [];
  const close = '<button type="button" class="btn btn-ghost btn-sm" data-pz-back>取消</button>';
  if (!chars.length) {
    return `<div class="pz-form"><p class="text-muted">发帖要先绑定角色（服务器用角色的 ESI 授权确认军团、舰队和合同）</p>
      <div><button type="button" class="btn btn-primary btn-sm" data-pz-bind>绑定角色</button></div></div>`;
  }
  const old = f.id ? S.items?.find((p) => p.id === f.id) : null;
  const val = (k) => esc(old?.[k] ?? '');
  const charSel = `<label class="pz-field"><span>角色</span><select class="pi-input" name="char" data-pz-char>${chars.map((a) => `<option value="${a.id}"${a.id === f.char ? ' selected' : ''}>${esc(a.name)}${f.kind === 'fleet' && !a.scopes.includes(FLEET_SCOPE) ? '（缺少舰队权限）' : ''}</option>`).join('')}</select></label>`;
  const tagList = S.tags[f.kind] || [];
  const tags = tagList.length ? `<div class="pz-field"><span>标签</span><div class="wh-chips">${tagList.map((t) => `<label class="wh-chip pz-check"><input type="checkbox" name="tags" value="${esc(t)}"${old?.tags?.includes(t) ? ' checked' : ''}>${esc(t)}</label>`).join('')}</div></div>` : '';
  const ph = {
    recruit: ['一句话介绍，比如：XX 军团招新，00 刷怪包教包会', '军团介绍：活动内容、所在星域、时区、对新人的要求、福利……'],
    fleet: ['舰队目的，比如：C5 刷怪缺 2 个后勤', '要什么船、要不要语音、怎么分战利品、多久结束……'],
    market: ['可不填，默认用合同标题', '补充说明，比如：可小刀、支持批量……'],
    other: ['标题', '内容']
  }[f.kind];
  const textarea = `<textarea class="pi-input" name="text" rows="${f.kind === 'market' ? 2 : 4}" maxlength="1000" placeholder="${esc(EN ? tr(ph[1]) : ph[1])}">${val('text')}</textarea>`;
  let middle = '';
  if (f.kind === 'market') {
    const st = S.contracts.get(f.char);
    const list = !st || st.loading ? '<div class="pi-loading">读取你的公开合同…</div>'
      : st.error ? `<p class="text-muted">合同读取失败：${esc(st.error)}</p>`
        : !st.items.length ? '<p class="text-muted">这个角色现在没有可以挂的合同：只能挂自己发起的、可见范围为公开、还没被接的合同（ESI 合同列表约 5 分钟更新一次）</p>'
          : `<div class="pz-ct-pick">${st.items.map((c) => `<label class="pz-ct-opt${f.contract === c.contract_id ? ' active' : ''}"><input type="radio" name="contract" value="${c.contract_id}"${f.contract === c.contract_id ? ' checked' : ''}>
              <span class="pz-ct-type pz-ct-${esc(c.type)}">${esc(CT_TYPE[c.type] || c.type)}</span><b class="notranslate">${esc(c.title || '（无标题）')}</b>
              <span class="pz-ct-opt-price">${ctx.formatISK((c.type === 'courier' ? c.reward : c.price) || 0)}</span>${c.posted ? '<small class="pz-tag">已挂出</small>' : ''}</label>`).join('')}</div>`;
    middle = `<div class="pz-field"><span>合同</span>${list}</div>`;
  }
  return `<form class="pz-form" data-pz-form>
    <div class="pz-form-grid">${charSel}
      <label class="pz-field pz-wide"><span>标题</span><input class="pi-input" name="title" maxlength="60" value="${val('title')}" placeholder="${esc(ph[0])}"></label></div>
    ${middle}${tags}
    <label class="pz-field"><span>内容</span>${textarea}</label>
    <label class="pz-field"><span>联系方式</span><input class="pi-input" name="contact" maxlength="80" value="${val('contact')}" placeholder="游戏内频道 / 邮件 / QQ 群（可不填）"></label>
    <div class="pz-form-foot"><span class="toolbar-spacer"></span>${close}<button type="submit" class="btn btn-primary btn-sm">${f.id ? '保存' : '发帖'}</button></div>
  </form>`;
}

function loadContracts(char, force = false) {
  if (!char) return;
  const hit = S.contracts.get(char);
  if (hit && (hit.loading || (!force && hit.items))) return;
  const st = { loading: true };
  S.contracts.set(char, st);
  post('contracts', char, {})
    .then((d) => { st.items = d.items || []; })
    .catch((e) => { st.error = e.message; })
    .finally(() => {
      st.loading = false;
      if (S.form?.kind === 'market' && S.form.char === char) {
        if (!S.form.contract && st.items?.length === 1) S.form.contract = st.items[0].contract_id;
        rerenderForm();
      }
    });
}
// 只重画表单（保留已填的文字）
function rerenderForm() {
  const form = document.querySelector('[data-pz-form]');
  if (!form) { render(); return; }
  const keep = Object.fromEntries(['title', 'text', 'contact'].map((k) => [k, form.elements[k]?.value]));
  const tags = [...form.querySelectorAll('[name=tags]:checked')].map((x) => x.value);
  form.outerHTML = formHtml();
  const nf = document.querySelector('[data-pz-form]');
  for (const [k, v] of Object.entries(keep)) if (v != null && nf.elements[k]) nf.elements[k].value = v;
  nf.querySelectorAll('[name=tags]').forEach((x) => { x.checked = tags.includes(x.value); });
}

async function submit(form) {
  const f = S.form;
  const fd = new FormData(form);
  const char = Number(fd.get('char'));
  const body = { kind: f.kind, title: String(fd.get('title') || '').trim(), text: String(fd.get('text') || '').trim(), contact: String(fd.get('contact') || '').trim(), tags: fd.getAll('tags') };
  if (f.kind === 'market') {
    body.contract_id = Number(fd.get('contract')) || 0;
    if (!body.contract_id) { ctx.showToast('请选择要挂的合同', 'info'); return; }
  }
  if (f.kind === 'other' && f.id) body.id = f.id;
  if ((f.kind === 'recruit' || f.kind === 'other') && !body.title && !body.text) { ctx.showToast('请填写标题或内容', 'info'); return; }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = '正在提交…';
  try {
    const p = await post('save', char, body);
    S.char = char; save();
    S.form = null;
    S.contracts.delete(char);
    S.items = [p, ...(S.items || []).filter((x) => x.id !== p.id)];
    S.kind = p.kind; S.view = 'list'; S.pid = 0; S.corp = 0; S.q = ''; S.tag = '';
    ctx.showToast(f.id || p.created !== p.updated ? '已更新' : '已发布', 'success');
    render();
    resolveItemNames();
  } catch (e) {
    btn.disabled = false; btn.textContent = f.id ? '保存' : '发帖';
    ctx.showToast('提交失败：' + e.message, 'error', 6000);
  }
}

async function remove(p) {
  if (!confirm(tr('确定撤下这条帖子？'))) return;
  const mine = myIds();
  const char = mine.has(p.char_id) ? p.char_id : p.data?.ceo_id;
  try {
    await post('delete', char, { id: p.id });
    S.items = S.items.filter((x) => x.id !== p.id);
    ctx.showToast('已撤下', 'success');
    render();
  } catch (e) {
    ctx.showToast('撤下失败：' + e.message, 'error', 5000);
  }
}
async function adminRemove(p) {
  if (!confirm(tr('站长删除这条帖子？'))) return;
  try {
    const res = await fetch('/api/kb/plaza/admin/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server: SERVER.id, id: p.id }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    S.items = S.items.filter((x) => x.id !== p.id);
    render();
  } catch (e) {
    ctx.showToast('删除失败：' + e.message, 'error', 5000);
  }
}

// ---------- 事件 ----------
const toTop = () => $('plazaMain')?.closest('.kb-scroll')?.scrollTo({ top: 0 });
function onClick(e) {
  const t = e.target;
  const kind = t.closest('[data-pz-kind]');
  if (kind) { S.kind = kind.dataset.pzKind; S.view = 'list'; S.pid = 0; S.corp = 0; S.tag = ''; save(); render(); toTop(); return; }
  const nw = t.closest('[data-pz-new]');
  if (nw) {
    // 发帖页：从某个分类点进来时直接选好这个分类
    const k = nw.dataset.pzNew || (POST_KINDS.includes(S.kind) ? S.kind : '');
    S.view = 'new'; S.pid = 0;
    if (k) openForm(k); else S.form = null;
    render(); toTop();
    return;
  }
  const pick = t.closest('[data-pz-pick]');
  if (pick) {
    if (S.form?.kind === pick.dataset.pzPick) return;
    openForm(pick.dataset.pzPick, { char: S.form?.char });
    render();
    return;
  }
  if (t.closest('[data-pz-back]')) { S.view = 'list'; S.form = null; render(); toTop(); return; }
  if (t.closest('[data-pz-bind]')) { ctx.openEsiBind?.(); return; }
  if (t.closest('[data-pz-reload]')) { load(true).then(render); return; }
  const tag = t.closest('[data-pz-tag]');
  if (tag) { S.tag = tag.dataset.pzTag; paintList(); return; }
  const find = (attr) => { const el = t.closest(`[${attr}]`); return el ? S.items?.find((p) => p.id === Number(el.getAttribute(attr))) : null; };
  const copy = t.closest('[data-pz-copy]');
  if (copy) { ctx.copyText(copy.dataset.pzCopy, '联系方式已复制'); return; }
  const link = find('data-pz-link');
  if (link) { ctx.copyText(location.origin + location.pathname + '#plaza/p/' + link.id, '帖子链接已复制'); return; }
  const info = t.closest('[data-pz-info]');
  if (info) { ctx.game.info(Number(info.dataset.pzInfo)); return; }
  const ct = t.closest('[data-pz-contract]');
  if (ct) { ctx.game.contract(Number(ct.dataset.pzContract)); return; }
  const rep = find('data-pz-report');
  if (rep) { ctx.openTicket?.('other', `举报广场帖子 #${rep.id}（${KIND_NAME[rep.kind]} · ${rep.name}${rep.title ? ' · ' + rep.title : ''}）\n原因：`); return; }
  const edit = find('data-pz-edit');
  if (edit) {
    const mine = myIds();
    const char = mine.has(edit.char_id) ? edit.char_id : edit.data?.ceo_id;
    S.view = 'new'; S.pid = 0;
    openForm(edit.kind, { char, id: edit.id, contract: edit.data?.contract_id || 0 });   // id：表单里带出原来的文字
    render(); toTop();
    return;
  }
  const del = find('data-pz-del');
  if (del) { remove(del); return; }
  const adel = find('data-pz-admin-del');
  if (adel) adminRemove(adel);
}

function onChange(e) {
  if (e.target.matches('[data-pz-char]')) {
    S.form.char = Number(e.target.value);
    S.form.contract = 0;
    if (S.form.kind === 'market') { loadContracts(S.form.char); rerenderForm(); }
    return;
  }
  if (e.target.matches('[name=contract]')) {
    S.form.contract = Number(e.target.value);
    e.target.closest('.pz-ct-pick')?.querySelectorAll('.pz-ct-opt').forEach((l) => l.classList.toggle('active', l.contains(e.target)));
  }
}

let qTimer = 0;
function onInput(e) {
  if (!e.target.matches('[data-pz-q]')) return;
  S.q = e.target.value;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const pos = e.target.selectionStart;
    paintList();
    const inp = document.querySelector('[data-pz-q]');
    if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
  }, 200);
}

// 击杀记录的军团页：有招新广告时显示入口（返回帖子或 null）
export async function recruitOf(corpId) {
  await load();
  return S.items?.find((p) => p.kind === 'recruit' && p.corp_id === Number(corpId)) || null;
}
