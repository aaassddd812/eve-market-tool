// ===== 角色交易（曙光服：玩家自挂）=====
// 曙光服没有藏宝阁这类交易渠道：玩家选自己绑定了 ESI 的角色挂售，自填人民币价格和 QQ（只能是数字）。
// 经本站击杀记录服务（kb_service.py 的 CharSale）：
//   POST /api/kb/bazaar/sale/save|delete（带该角色的 ESI 令牌，服务器校验归属并读取技能 / 钱包等快照，令牌不保存）；
//   /api/kb/bazaar/sale：在售角色；/api/kb/bazaar/sale/detail?id=：详情（含技能）；/api/kb/bazaar/sale/skillset：技能等级（列表筛选用）。
// 挂单 30 天后自动下架，卖家重新提交即续期并刷新快照。技能分析与其他服共用 bazaar-skills.js。
// 地址栏：#bazaar · #bazaar/s/<角色ID> · #bazaar/sell
import { SERVER, HUB_NAME, eveImage } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';
import * as BS from './bazaar-skills.js?v=9';

let ctx;   // 另有 esiAccounts() -> [{ id, name }]、accountToken(id)、openEsiBind()、copyText(text, label)
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s ?? '');
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // confirm 里的文字不走自动翻译
const STORE_KEY = 'eve-bazaar-sale-v1';
const INJECTOR = 40520, EXTRACTOR = 40519;   // 大型技能注入器（50 万技能点）、技能提取器
const KEEP_SP = 5e6;                         // 角色至少保留 500 万技能点，不能再提取
const ORDERS = [['new:desc', '最新挂出'], ['sp:desc', '技能点从高到低'], ['sp:asc', '技能点从低到高'], ['price:asc', '价格从低到高'], ['price:desc', '价格从高到低'],
  ['ratio:asc', '每百万技能点价格从低到高'], ['ratio:desc', '每百万技能点价格从高到低']];

const C = {
  view: 'list', order: 'new:desc', spMin: '', spMax: '', q: '',
  items: [], days: 30, at: 0, loading: false, error: '',
  id: 0, detail: new Map(),   // 角色 ID -> Promise<详情>
  ana: null,                  // { id, tab, c, r, err }
  need: [],                   // 技能要求筛选条件（bazaar-skills.js 的 needHtml / meets）
  pick: 0, busy: false, msg: null
};
const NEED = { data: null, sets: null, at: 0, loading: null, err: false };
function loadNeed() {
  if (!C.need.length || NEED.loading || NEED.err || (NEED.sets && Date.now() - NEED.at < 120e3)) return NEED.loading;
  NEED.loading = Promise.all([ctx.fitData(), api('/skillset')]).then(([fd, r]) => {
    NEED.data = fd.data;
    NEED.sets = new Map(Object.entries(r.items).map(([k, [, , , sk]]) => [Number(k), BS.parseSkills(sk)]));
    NEED.at = Date.now();
  }).catch((e) => { NEED.err = true; ctx.showToast('技能数据读取失败：' + e.message, 'error'); }).finally(() => { NEED.loading = null; if (C.view === 'list') refreshList(); });
  return NEED.loading;
}

function load() {
  try { Object.assign(C, JSON.parse(ctx.store.get(STORE_KEY) || '{}')); } catch { /* 忽略 */ }
}
function save() { ctx.store.set(STORE_KEY, JSON.stringify({ order: C.order, spMin: C.spMin, spMax: C.spMax, need: C.need })); }

export function initSale(context) { ctx = context; load(); }

async function api(path) {
  const res = await fetch('/api/kb/bazaar/sale' + path + (path.includes('?') ? '&' : '?') + 'server=' + SERVER.id);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
  return body;
}
async function post(op, id, body) {
  const token = await ctx.accountToken(id);
  const res = await fetch('/api/kb/bazaar/sale/' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.access_token },
    body: JSON.stringify({ server: SERVER.id, character_id: id, ...body })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'HTTP ' + res.status);
  return out;
}

export async function preload() {
  if (!C.items.length) await fetchList(true).catch(() => {});
}

export function showSale(hash) {
  const main = $('bazaarMain');
  if (!main.dataset.ready) { main.dataset.ready = '1'; bind(); }
  $('bazaarSearch').disabled = false;
  route(hash || location.hash);
}

function route(hash) {
  const m = /^#bazaar\/s\/(\d+)/.exec(hash);
  if (m) {
    C.view = 'detail';
    renderSide();
    openDetail(Number(m[1]));
    if (!C.items.length && !C.loading) fetchList(true);
    return;
  }
  if (hash.startsWith('#bazaar/sell')) {
    C.view = 'sell';
    renderSide();
    renderSell();
    if (!C.items.length && !C.loading) fetchList(true).then(() => { if (C.view === 'sell') renderSell(); });
    return;
  }
  if (!location.hash.startsWith('#bazaar')) history.replaceState(null, '', location.pathname + location.search + '#bazaar');
  const back = C.view !== 'list';
  C.view = 'list';
  loadNeed();
  render();
  if (back) scroller()?.scrollTo(0, C.listTop || 0);
  if (!C.loading && (!C.items.length || Date.now() - C.at > 120e3)) fetchList(false);
}
const scroller = () => $('bazaarMain').closest('.kb-scroll');
function go(hash) {
  C.fromList = C.view === 'list' && hash !== '#bazaar';
  if (C.fromList) C.listTop = scroller()?.scrollTop || 0;
  if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
  route(hash);
}
function render() {
  renderSide();
  if (C.view === 'list') $('bazaarMain').innerHTML = listPage();
}

// ---------- 数字与时间 ----------
const spText = (v) => (v == null ? '' : (v / 1e6 >= 100 ? Math.round(v / 1e6) : +(v / 1e6).toFixed(1)) + 'M SP');
const yuan = (v) => (v == null ? '' : '¥' + ctx.formatNumber(Math.round(v)));
const ratioOf = (t) => (t.price != null && t.sp ? t.price / (t.sp / 1e6) : null);   // 每百万技能点多少元
function ago(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
const daysLeft = (t) => Math.max(0, Math.ceil((t.expires - Date.now() / 1000) / 86400));
const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—');

// ---------- 侧边栏 ----------
function filtered() {
  const lo = C.spMin === '' ? null : Number(C.spMin) * 1e6, hi = C.spMax === '' ? null : Number(C.spMax) * 1e6;
  const q = C.q.toLowerCase();
  const list = C.items.filter((t) => (lo == null || (t.sp ?? 0) >= lo) && (hi == null || (t.sp ?? 0) <= hi)
    && (!q || (t.name || '').toLowerCase().includes(q))
    && (!C.need.length || (NEED.sets?.has(t.id) && BS.meets(NEED.data, NEED.sets.get(t.id), C.need))));
  const [k, d] = C.order.split(':');
  const val = (t) => (k === 'ratio' ? ratioOf(t) : k === 'new' ? t.created : t[k]);
  const sign = d === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x - y) * sign;
  });
}
function renderSide() {
  $('bazaarSide').innerHTML = `
    <div class="ind-side-section"><button class="btn btn-primary bz-sell-btn" data-sale-sell>挂售我的角色</button></div>
    <div class="ind-side-section bz-side-form">
      <h4>排序<small>共 ${C.items.length} 个角色</small></h4>
      <select class="input bz-order" data-sale-order aria-label="排序">${ORDERS.map(([k, l]) => `<option value="${k}"${k === C.order ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <h4>技能点（百万）</h4>
      <div class="bz-range"><input class="input" type="number" min="0" step="any" data-sale-sp="spMin" value="${esc(C.spMin)}" placeholder="最低"><i>~</i><input class="input" type="number" min="0" step="any" data-sale-sp="spMax" value="${esc(C.spMax)}" placeholder="最高"></div>
    </div>
    ${BS.needHtml(C.need, C.need.length ? (NEED.sets ? `已读取 ${NEED.sets.size} 个角色的技能` : '正在读取技能数据…') : '按各角色的技能等级判断')}
    <div class="ind-side-section bz-tips">
      <h4>交易须知</h4>
      <ul>
        <li>角色由玩家自行挂售，本站只展示信息，不参与交易。</li>
        <li>技能、钱包等资料由本站通过 ESI 读取，卖家无法修改。</li>
        <li>交易前请核实对方身份，谨防诈骗。</li>
      </ul>
    </div>`;
}

// ---------- 列表 ----------
function listPage() {
  return `<section class="pi-page bz-page">
    <div class="pi-head bz-head"><h2>${C.q ? `搜索「${esc(C.q)}」` : '角色交易'}</h2><span class="text-muted">曙光服 · 玩家挂售</span><span class="toolbar-spacer"></span>
      ${C.q ? '<button class="btn btn-ghost btn-sm" data-sale-clear>清除搜索</button>' : ''}
      <button class="btn btn-ghost btn-sm" data-sale-retry ${C.loading ? 'disabled' : ''}>刷新</button></div>
    <div id="bazaarList">${listHtml()}</div>
  </section>`;
}
function listHtml() {
  if (C.error && !C.items.length) return `<div class="empty-state"><p>读取失败：${esc(C.error)}</p><button class="btn btn-sm" data-sale-retry>重试</button></div>`;
  if (!C.items.length && C.loading) return skPage({ rows: 8 });
  if (!C.items.length) return '<div class="empty-state"><p>还没有人挂售角色</p><button class="btn btn-primary btn-sm" data-sale-sell>挂售我的角色</button></div>';
  if (C.need.length && !NEED.sets) return NEED.err ? '<div class="empty-state"><p>技能数据读取失败</p><button class="btn btn-sm" data-sale-retry>重试</button></div>' : '<div class="empty-state"><p>正在读取各角色的技能数据…</p></div>';
  const list = filtered();
  return `<div class="bz-count text-muted">显示 ${list.length} / ${C.items.length} 个角色${C.loading ? ' · 刷新中…' : ''}</div>
    ${list.length ? `<div class="bz-list">${list.map(rowHtml).join('')}</div>` : '<div class="empty-state"><p>没有符合条件的角色，可以放宽筛选</p></div>'}
    ${C.error ? `<p class="down">${esc(C.error)}</p>` : ''}`;
}
const avatar = (id, size, px) => `<img class="bz-avatar" src="${esc(eveImage(`characters/${id}/portrait`, size))}" alt="" width="${px}" height="${px}" loading="lazy" referrerpolicy="no-referrer">`;
function rowHtml(t) {
  const r = ratioOf(t);
  return `<a class="bz-row" href="#bazaar/s/${t.id}" data-sale-id="${t.id}">
    ${avatar(t.id, 64, 36)}
    <div class="bz-row-main">
      <div class="bz-row-title"><span class="bz-kind is-wts">出售</span><span translate="no">${esc(t.name)}</span></div>
      <div class="bz-row-meta"><b class="bz-sp">${spText(t.sp)}</b><b class="bz-isk">${yuan(t.price)}</b>
        ${r != null ? `<b class="bz-ratio" title="每百万技能点的价格">${r.toFixed(1)} 元/百万SP</b>` : ''}
        ${t.sec != null ? `<span class="${t.sec < 0 ? 'down' : ''}">安全等级 ${t.sec.toFixed(2)}</span>` : ''}${t.isk != null ? `<span>钱包 ${ctx.formatISK(t.isk)} ISK</span>` : ''}</div>
    </div>
    <div class="bz-row-stats"><span>挂出</span><small>${ago(t.created)}</small></div>
  </a>`;
}

async function fetchList(quiet) {
  C.loading = true; C.error = '';
  if (!quiet) refreshList();
  try {
    const r = await api('');
    C.items = r.items || [];
    C.days = r.days || 30;
    C.at = Date.now();
  } catch (e) { C.error = e.message; }
  C.loading = false;
  if (C.view === 'list') refreshList(); else renderSide();
}
function refreshList() {
  if (C.view !== 'list' || !$('bazaarList')) return;
  $('bazaarList').innerHTML = listHtml();
  $('bazaarMain').querySelectorAll('[data-sale-retry]').forEach((b) => { b.disabled = C.loading; });
  renderSide();
}

// ---------- 角色详情 ----------
function getDetail(id) {
  if (!C.detail.has(id)) C.detail.set(id, api('/detail?id=' + id).catch((e) => { C.detail.delete(id); throw e; }));
  return C.detail.get(id);
}
async function openDetail(id) {
  const main = $('bazaarMain');
  C.id = id;
  main.innerHTML = skPage({ cards: 2, rows: 8 });
  let d;
  try { d = await getDetail(id); } catch (e) {
    if (C.id !== id || C.view !== 'detail') return;
    main.innerHTML = `<div class="empty-state"><p>角色读取失败：${esc(e.message)}</p><button class="btn btn-sm" data-sale-back>返回列表</button></div>`;
    return;
  }
  if (C.id !== id || C.view !== 'detail') return;
  main.closest('.kb-scroll')?.scrollTo(0, 0);
  main.innerHTML = detailHtml(d);
  loadSkills(d);
  valueHtml(d).then((html) => { const v = $('saleValue'); if (v && C.id === id) v.innerHTML = '<h4>估价</h4>' + html; });
}

function detailHtml(d) {
  const mine = ctx.esiAccounts().some((a) => a.id === d.id);
  const r = ratioOf({ price: d.price, sp: d.total_sp });
  const dd = (label, v, cls = '') => `<dt>${label}</dt><dd class="${cls}">${v}</dd>`;
  return `<section class="pi-page bz-page">
    <div class="bz-topic-top"><button class="btn btn-ghost btn-sm" data-sale-back>← 返回列表</button><span class="toolbar-spacer"></span>
      ${mine ? `<button class="btn btn-ghost btn-sm" data-sale-edit="${d.id}">编辑挂单</button>` : ''}</div>
    <div class="pi-card bz-topic-head">
      <div class="bz-who-head">${avatar(d.id, 128, 64)}
        <div><h2><span class="bz-kind is-wts">出售</span><span translate="no">${esc(d.name)}</span></h2>
          <small><span>挂出</span> ${ago(d.created)} · <span>资料更新于</span> ${ago(d.updated)} · ${daysLeft(d)} <span>天后下架</span></small></div></div>
      <div class="bz-row-meta"><b class="bz-isk">${yuan(d.price)}</b><b class="bz-sp">${spText(d.total_sp)}</b>
        ${d.unallocated_sp ? `<span>未分配 ${ctx.formatNumber(d.unallocated_sp)} SP</span>` : ''}${r != null ? `<b class="bz-ratio">${r.toFixed(1)} 元/百万SP</b>` : ''}</div>
      <div class="bz-sale-contact">
        <span class="bz-sale-qq"><em>QQ</em><b translate="no">${esc(d.qq)}</b></span>
        <button class="btn btn-sm" data-sale-copy="${esc(d.qq)}">复制</button>
      </div>
    </div>
    <div id="bazaarAna"></div>
    <div class="bz-topic-body">
      <div class="bz-posts"></div>
      <aside class="bz-who">
        <div class="pi-card bz-who-card"><h4>角色资料</h4><dl>
          ${dd('创建日期', esc(dateOf(d.birthday)))}
          ${dd('军团', `<span translate="no">${esc(d.corp || '—')}</span>`)}
          ${d.alliance ? dd('联盟', `<span translate="no">${esc(d.alliance)}</span>`) : ''}
          ${dd('安全等级', d.sec != null ? Number(d.sec).toFixed(2) : '—', d.sec < 0 ? 'down' : d.sec > 0 ? 'up' : '')}
          ${dd('钱包', d.isk != null ? ctx.formatISK(d.isk) + ' ISK' : '—')}
          ${d.system ? dd('所在星系', `<span translate="no">${esc(d.system)}</span>`) : ''}
          ${d.ship ? dd('当前舰船', esc(d.ship)) : ''}
          ${d.jump_clones != null ? dd('跳跃克隆', d.jump_clones) : ''}
          ${dd('已分配技能点', ctx.formatNumber((d.total_sp || 0) - (d.unallocated_sp || 0)))}
          ${dd('未分配技能点', ctx.formatNumber(d.unallocated_sp || 0))}
        </dl><p class="text-muted bz-who-note">数据由本站通过 ESI 读取，卖家无法修改。</p></div>
        <div class="pi-card bz-who-card" id="saleValue"><h4>估价</h4><p class="text-muted">计算中…</p></div>
      </aside>
    </div>
  </section>`;
}

async function loadSkills(d) {
  const box = $('bazaarAna');
  if (C.ana?.id !== d.id) {
    C.ana = { id: d.id, tab: 'role', c: null, r: { name: d.name, source: 'ESI', skills: d.skills, total_sp: d.total_sp }, err: '' };
    box.innerHTML = '<div class="pi-card bz-ana"><h3>技能分析</h3><p class="text-muted">正在加载装配数据…</p></div>';
    BS.setHelpers({ esc: ctx.esc, formatNumber: ctx.formatNumber });
    try {
      const fd = await ctx.fitData();
      if (d.skills?.length) C.ana.c = BS.makeChar(fd.data, C.ana.r); else C.ana.err = '没有这个角色的技能数据';
    } catch (e) { C.ana.err = '装配数据加载失败：' + e.message; }
  }
  if (C.id === d.id) renderAna();
}
function renderAna() {
  const box = $('bazaarAna');
  if (!box || !C.ana) return;
  box.innerHTML = C.ana.c ? BS.analysisHtml(C.ana.c, C.ana.r, null, C.ana.tab)
    : `<div class="pi-card bz-ana"><h3>技能分析</h3><p class="text-muted">${esc(C.ana.err || '没有技能数据')}</p></div>`;
}

// 估价：拆成大型技能注入器在交易中心的价值（ISK），和卖家的人民币价格放在一起参考
let PRICES = null;
function loadPrices() {
  if (!PRICES || Date.now() - PRICES.at > 300e3) PRICES = { at: Date.now(), p: ctx.getLivePrices([INJECTOR, EXTRACTOR]).catch(() => new Map()) };
  return PRICES.p;
}
async function valueHtml(d) {
  const prices = await loadPrices();
  const inj = prices.get(INJECTOR)?.sell, ext = prices.get(EXTRACTOR)?.sell;
  const n = Math.max(0, Math.floor((d.total_sp - KEEP_SP) / 5e5));
  const net = inj && ext ? n * (inj - ext) : null;
  return `<dl>
    <dt>卖家要价</dt><dd class="bz-isk">${yuan(d.price)}</dd>
    <dt>总技能点</dt><dd>${spText(d.total_sp)}</dd>
    ${net != null ? `<dt title="${n} 支大型技能注入器 × ${esc(HUB_NAME)}卖价，扣除同样数量技能提取器的成本">拆注入器估价</dt><dd class="bz-isk">${ctx.formatISK(net)} ISK</dd>
    <dd class="bz-who-sub">可抽 ${+((d.total_sp - KEEP_SP) / 1e6).toFixed(1)}M SP = ${n} 支大型注入器（${esc(HUB_NAME)}卖价 ${ctx.formatISK(inj)}，提取器 ${ctx.formatISK(ext)}）</dd>
    ${d.price ? `<dd class="bz-who-sub">相当于每 1 元买 ${ctx.formatISK(net / d.price)} ISK 的技能点</dd>` : ''}` : ''}
  </dl><p class="text-muted bz-who-note">拆注入器价值是角色的「下限」参考；老角色、稀有技能、舰船资产等通常有溢价。</p>`;
}

// ---------- 挂售 ----------
function renderSell() {
  const main = $('bazaarMain');
  const accounts = ctx.esiAccounts();
  const head = `<div class="bz-topic-top"><button class="btn btn-ghost btn-sm" data-sale-back>← 返回列表</button></div>`;
  if (!accounts.length) {
    main.innerHTML = `<section class="pi-page bz-page">${head}<div class="empty-state"><p>挂售角色需要先绑定这个角色的 ESI</p><button class="btn btn-primary btn-sm" data-sale-bind>绑定 ESI</button></div></section>`;
    return;
  }
  if (!accounts.some((a) => a.id === C.pick)) C.pick = accounts[0].id;
  const listed = new Map(C.items.map((t) => [t.id, t]));
  const cur = listed.get(C.pick);
  const picks = accounts.map((a) => {
    const t = listed.get(a.id);
    return `<label class="bz-sell-char${a.id === C.pick ? ' active' : ''}"><input type="radio" name="saleChar" value="${a.id}"${a.id === C.pick ? ' checked' : ''}>
      ${avatar(a.id, 64, 36)}<span><b translate="no">${esc(a.name)}</b><small>${t ? `在售 ${yuan(t.price)} · ${daysLeft(t)} 天后下架` : '未挂售'}</small></span></label>`;
  }).join('');
  const msg = C.msg ? `<p class="bz-sell-msg ${C.msg.ok ? 'up' : 'down'}">${esc(C.msg.text)}</p>` : '';
  main.innerHTML = `<section class="pi-page bz-page">${head}
    <div class="pi-card bz-sell">
      <h2>挂售我的角色</h2>
      <div class="bz-sell-chars" role="radiogroup" aria-label="选择角色">${picks}</div>
      <form class="bz-sell-form" data-sale-form novalidate>
        <label><span>价格（元）</span><input class="input" name="price" type="number" min="1" max="10000000" step="1" inputmode="numeric" required value="${cur ? cur.price : ''}" placeholder="例如 3000"></label>
        <label><span>QQ</span><input class="input" name="qq" type="text" inputmode="numeric" pattern="[0-9]+" autocomplete="off" required value="${esc(cur?.qq || '')}" placeholder="只能填数字"></label>
        <div class="bz-sell-actions">
          <button class="btn btn-primary" type="submit"${C.busy ? ' disabled' : ''}>${cur ? '更新挂单' : '挂售'}</button>
          ${cur ? `<button class="btn btn-ghost" type="button" data-sale-del${C.busy ? ' disabled' : ''}>下架</button><a class="btn btn-ghost" href="#bazaar/s/${cur.id}" data-sale-id="${cur.id}">查看</a>` : ''}
        </div>
        ${msg}
        <p class="sp-hint">技能、钱包等资料由本站通过 ESI 读取。${C.days} 天后自动下架，更新一次即可续期。</p>
      </form>
    </div>
  </section>`;
}
function sellError(text) { C.msg = { ok: false, text }; renderSell(); }
async function submitSell(form) {
  const price = form.price.value.trim(), qq = form.qq.value.trim();
  if (!/^\d+$/.test(price) || Number(price) < 1 || Number(price) > 1e7) return sellError('价格请填 1–10000000 的整数（元）');
  if (!/^\d+$/.test(qq)) return sellError('QQ 号只能填数字');
  const id = C.pick;
  C.busy = true; C.msg = null; renderSell();
  try {
    const d = await post('save', id, { price: Number(price), qq });
    C.detail.set(id, Promise.resolve(d));
    const row = { ...d, sp: d.total_sp };
    C.items = [row, ...C.items.filter((t) => t.id !== id)];
    C.msg = { ok: true, text: '已挂售，资料已更新' };
    NEED.at = 0;
  } catch (e) { C.msg = { ok: false, text: e.message }; }
  C.busy = false;
  if (C.view === 'sell') renderSell();
}
async function deleteSell() {
  const id = C.pick;
  if (!confirm(tr('确定下架这个角色吗？'))) return;
  C.busy = true; C.msg = null; renderSell();
  try {
    await post('delete', id, {});
    C.items = C.items.filter((t) => t.id !== id);
    C.detail.delete(id);
    C.msg = { ok: true, text: '已下架' };
    NEED.at = 0;
  } catch (e) { C.msg = { ok: false, text: e.message }; }
  C.busy = false;
  if (C.view === 'sell') renderSell();
}

// ---------- 事件 ----------
function bind() {
  const view = $('bazaarView');
  const search = $('bazaarSearch');
  BS.bindAna(view, () => C.ana?.c, renderAna, (m) => ctx.showToast(m, 'error'));
  BS.bindNeed($('bazaarSide'), {
    get: () => C.need,
    set: (reqs) => { C.need = reqs; save(); if (C.view !== 'list') go('#bazaar'); else { loadNeed(); refreshList(); } },
    data: () => ctx.fitData().then((f) => f.data)
  });
  search.placeholder = '搜索角色名';
  let timer = 0;
  search.addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { C.q = e.target.value.trim(); if (C.view !== 'list') go('#bazaar'); else render(); }, 300);
  });
  view.addEventListener('click', (e) => {
    const t = e.target;
    const row = t.closest('[data-sale-id]');
    if (row) { e.preventDefault(); go('#bazaar/s/' + row.dataset.saleId); ctx.closeDrawer(); return; }
    if (t.closest('[data-sale-sell]')) { C.msg = null; go('#bazaar/sell'); ctx.closeDrawer(); return; }
    const edit = t.closest('[data-sale-edit]');
    if (edit) { C.pick = Number(edit.dataset.saleEdit); C.msg = null; go('#bazaar/sell'); return; }
    const copy = t.closest('[data-sale-copy]');
    if (copy) { ctx.copyText(copy.dataset.saleCopy, 'QQ 号已复制'); return; }
    if (t.closest('[data-sale-bind]')) { ctx.openEsiBind(); return; }
    if (t.closest('[data-sale-del]')) { deleteSell(); return; }
    const tab = t.closest('[data-bz-tab]');
    if (tab && C.ana) { C.ana.tab = tab.dataset.bzTab; renderAna(); return; }
    const train = t.closest('[data-bz-train]');
    if (train && C.ana) { BS.setTrainShip(Number(train.dataset.bzTrain)); C.ana.tab = 'train'; renderAna(); return; }
    if (t.closest('[data-sale-retry]')) { NEED.err = false; NEED.at = 0; loadNeed(); fetchList(false); return; }
    if (t.closest('[data-sale-clear]')) { C.q = ''; $('bazaarSearch').value = ''; render(); return; }
    if (t.closest('[data-sale-back]')) { if (C.fromList) { C.fromList = false; history.back(); } else go('#bazaar'); }
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'saleChar') { C.pick = Number(t.value); C.msg = null; renderSell(); return; }
    if (t.matches('[data-sale-order]')) { C.order = t.value; save(); if (C.view !== 'list') go('#bazaar'); else render(); return; }
    if (t.matches('[data-sale-sp]')) { C[t.dataset.saleSp] = t.value; save(); if (C.view === 'list') refreshList(); }
  });
  // QQ 输入框：只留数字
  view.addEventListener('input', (e) => { if (e.target.name === 'qq' && /\D/.test(e.target.value)) e.target.value = e.target.value.replace(/\D/g, ''); });
  view.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-sale-form]')) return;
    e.preventDefault();
    if (!C.busy) submitSell(e.target);
  });
}
