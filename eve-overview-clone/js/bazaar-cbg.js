// ===== 角色交易（晨曦服：网易藏宝阁）=====
// 藏宝阁（https://eve.cbg.163.com）是网易官方的角色交易平台，用人民币交易，角色在网易账号之间转移。
// 页面没有开放跨域，经本站击杀记录服务代理（kb_service.py 的 Cbg）：
//   /api/kb/bazaar/cbg：在售 + 公示期的全部角色（晨曦一共只有几十个，一次读完，前端筛选排序）；
//   /api/kb/bazaar/cbg/detail?id=：角色详情（技能等级、钱包、安全等级、所在空间站、军团历史、舰船与装配）。
// 技能分析与宁静服共用 bazaar-skills.js（藏宝阁只给技能等级，技能点按等级推算）。
// 地址栏：#bazaar · #bazaar/c/<藏宝阁订单号>
import { HUB_NAME, eveImage } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';
import * as BS from './bazaar-skills.js?v=6';

let ctx;
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s ?? '');
const STORE_KEY = 'eve-bazaar-cbg-v1';
const CBG = 'https://eve.cbg.163.com';
const INJECTOR = 40520, EXTRACTOR = 40519;   // 大型技能注入器（50 万技能点）、技能提取器
const KEEP_SP = 5e6;                         // 角色至少保留 500 万技能点，不能再提取
const STATUS = [['all', '全部'], ['sale', '在售'], ['fair', '公示期']];
const STATUS_NAME = { sale: '在售', fair: '公示期' };
const ORDERS = [['sp:desc', '技能点从高到低'], ['sp:asc', '技能点从低到高'], ['price:asc', '价格从低到高'], ['price:desc', '价格从高到低'],
  ['ratio:asc', '每百万技能点价格从低到高'], ['ratio:desc', '每百万技能点价格从高到低'], ['left:asc', '即将结束']];
const SLOTS = [['highSlot', '高槽'], ['mediumSlot', '中槽'], ['lowSlot', '低槽'], ['rigSlot', '改装件'], ['subsystemSlot', '子系统']];

const C = {
  view: 'list', status: 'all', order: 'sp:desc', spMin: '', spMax: '', q: '',
  items: [], at: 0, loading: false, error: '',
  sn: 0, detail: new Map(),   // 订单号 -> Promise<详情>
  ana: null,                  // { id, tab, c, r, err }
  need: []                    // 技能要求筛选条件（bazaar-skills.js 的 needHtml / meets）
};
// 技能要求筛选用的数据：装配数据 + 各角色技能等级（/api/kb/bazaar/cbg/skillset，后台每 10 分钟补齐）
const NEED = { data: null, sets: null, pending: 0, at: 0, loading: null, err: false };
function loadNeed() {
  if (!C.need.length || NEED.loading || NEED.err || (NEED.sets && Date.now() - NEED.at < 120e3 && !NEED.pending)) return NEED.loading;
  NEED.loading = Promise.all([ctx.fitData(), api('/skillset')]).then(([fd, r]) => {
    NEED.data = fd.data;
    NEED.sets = new Map(Object.entries(r.items).map(([k, [, , , sk]]) => [Number(k), BS.parseSkills(sk)]));
    NEED.pending = r.pending || 0;
    NEED.at = Date.now();
  }).catch((e) => { NEED.err = true; ctx.showToast('技能数据读取失败：' + e.message, 'error'); }).finally(() => { NEED.loading = null; if (C.view === 'list') refreshList(); });
  return NEED.loading;
}

function load() {
  try { Object.assign(C, JSON.parse(ctx.store.get(STORE_KEY) || '{}')); } catch { /* 忽略 */ }
}
function save() { ctx.store.set(STORE_KEY, JSON.stringify({ status: C.status, order: C.order, spMin: C.spMin, spMax: C.spMax, need: C.need })); }

export function initCbg(context) { ctx = context; load(); }

async function api(path) {
  const res = await fetch('/api/kb/bazaar/cbg' + path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
  return body;
}

export async function preload() {
  if (!C.items.length) await fetchList(true).catch(() => {});
}

export function showCbg(hash) {
  const main = $('bazaarMain');
  if (!main.dataset.ready) { main.dataset.ready = '1'; bind(); }
  route(hash || location.hash);
}

function route(hash) {
  const m = /^#bazaar\/c\/(\d+)/.exec(hash);
  if (m) {
    C.view = 'detail';
    renderSide();
    openDetail(Number(m[1]));
    if (!C.items.length && !C.loading) fetchList(true);
    return;
  }
  // 从菜单进入时地址栏没有 #bazaar：补上，详情页「返回列表」/ 浏览器后退才能回到这里
  if (!location.hash.startsWith('#bazaar')) history.replaceState(null, '', location.pathname + location.search + '#bazaar');
  const back = C.view !== 'list';
  C.view = 'list';
  loadNeed();
  render();
  if (back) scroller()?.scrollTo(0, C.listTop || 0);   // 回到列表时恢复滚动位置
  if (!C.loading && (!C.items.length || Date.now() - C.at > 600e3)) fetchList(false);
}
const scroller = () => $('bazaarMain').closest('.kb-scroll');
function go(hash) {
  // 从列表点进详情：记下滚动位置；「返回列表」用浏览器后退，前进 / 后退记录保持一致
  C.fromList = C.view === 'list' && hash !== '#bazaar';
  if (C.fromList) C.listTop = scroller()?.scrollTop || 0;
  if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
  route(hash);
}
function render() {
  renderSide();
  if (C.view === 'list') $('bazaarMain').innerHTML = listPage();
}

// ---------- 数字 ----------
const spText = (v) => (v == null ? '' : (v / 1e6 >= 100 ? Math.round(v / 1e6) : +(v / 1e6).toFixed(1)) + 'M SP');
const yuan = (v) => (v == null ? '' : '¥' + ctx.formatNumber(Math.round(v)));
const EN_UI = /^en/i.test(document.documentElement.lang);
// 剩余时间原样是「11天17时」：英文界面换成「11d 17h」，并且不让逐词翻译拆开
const leftText = (s) => `<span translate="no">${esc(EN_UI ? (s || '').replace(/(\d+)\s*天/g, '$1d ').replace(/(\d+)\s*(小时|时)/g, '$1h ').replace(/(\d+)\s*分/g, '$1m').trim() : s)}</span>`;
const ratioOf = (t) => (t.price != null && t.sp ? t.price / (t.sp / 1e6) : null);   // 每百万技能点多少元
// 剩余时间「11天17时」「7时31分」-> 分钟
function leftMin(s) {
  if (!s) return Infinity;
  let m = 0;
  for (const [, n, u] of s.matchAll(/(\d+)\s*(天|时|小时|分)/g)) m += Number(n) * ({ 天: 1440, 时: 60, 小时: 60, 分: 1 }[u]);
  return m || Infinity;
}

// ---------- 侧边栏 ----------
function filtered() {
  const lo = C.spMin === '' ? null : Number(C.spMin) * 1e6, hi = C.spMax === '' ? null : Number(C.spMax) * 1e6;
  const q = C.q.toLowerCase();
  const list = C.items.filter((t) => (C.status === 'all' || t.status === C.status)
    && (lo == null || (t.sp ?? 0) >= lo) && (hi == null || (t.sp ?? 0) <= hi)
    && (!q || (t.name || '').toLowerCase().includes(q))
    && (!C.need.length || (NEED.sets?.has(t.id) && BS.meets(NEED.data, NEED.sets.get(t.id), C.need))));
  const [k, d] = C.order.split(':');
  const val = (t) => (k === 'ratio' ? ratioOf(t) : k === 'left' ? leftMin(t.left) : t[k]);
  const sign = d === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x - y) * sign;
  });
}
function renderSide() {
  const counts = { all: C.items.length };
  for (const t of C.items) counts[t.status] = (counts[t.status] || 0) + 1;
  $('bazaarSide').innerHTML = `
    <div class="ind-side-section"><h4>交易状态<small>共 ${C.items.length} 个角色</small></h4>${STATUS.map(([k, name]) =>
      `<button class="ind-side-item${C.status === k && C.view === 'list' ? ' active' : ''}" data-cbg-status="${k}"><span>${name}</span><small>${counts[k] || 0}</small></button>`).join('')}</div>
    <div class="ind-side-section bz-side-form">
      <h4>排序</h4>
      <select class="input bz-order" data-cbg-order aria-label="排序">${ORDERS.map(([k, l]) => `<option value="${k}"${k === C.order ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <h4>技能点（百万）</h4>
      <div class="bz-range"><input class="input" type="number" min="0" step="any" data-cbg-sp="spMin" value="${esc(C.spMin)}" placeholder="最低"><i>~</i><input class="input" type="number" min="0" step="any" data-cbg-sp="spMax" value="${esc(C.spMax)}" placeholder="最高"></div>
    </div>
    ${BS.needHtml(C.need, C.need.length ? (NEED.sets ? `已读取 ${NEED.sets.size} 个角色的技能${NEED.pending ? `，还有 ${NEED.pending} 个正在后台读取` : ''}` : '正在读取技能数据…') : '按藏宝阁里各角色的技能等级判断')}
    <div class="ind-side-section bz-tips">
      <h4>交易须知</h4>
      <ul>
        <li>藏宝阁是网易官方的角色交易平台，价格为人民币，付款与角色转移都在藏宝阁内完成。</li>
        <li>公示期的角色还不能购买，公示结束后才开始出售。</li>
        <li>技能、钱包、舰船等数据来自藏宝阁的角色快照，以藏宝阁页面为准。</li>
        <li>不要通过私下转账等方式交易，以免被骗。</li>
      </ul>
      <a class="link-btn" href="${CBG}/" target="_blank" rel="noopener">网易藏宝阁 ↗</a>
    </div>`;
}

// ---------- 列表 ----------
function listPage() {
  return `<section class="pi-page bz-page">
    <div class="pi-head bz-head"><h2>${C.q ? `搜索「${esc(C.q)}」` : '角色交易'}</h2><span class="text-muted">晨曦服 · 网易藏宝阁</span><span class="toolbar-spacer"></span>
      ${C.q ? '<button class="btn btn-ghost btn-sm" data-cbg-clear>清除搜索</button>' : ''}
      <button class="btn btn-ghost btn-sm" data-cbg-retry ${C.loading ? 'disabled' : ''}>刷新</button>
      <a class="btn btn-ghost btn-sm" href="${CBG}/" target="_blank" rel="noopener">藏宝阁 ↗</a></div>
    <div id="bazaarList">${listHtml()}</div>
  </section>`;
}
function listHtml() {
  if (C.error && !C.items.length) return `<div class="empty-state"><p>读取失败：${esc(C.error)}</p><button class="btn btn-sm" data-cbg-retry>重试</button></div>`;
  if (!C.items.length && C.loading) return skPage({ rows: 10 });
  if (C.need.length && !NEED.sets) return NEED.err ? '<div class="empty-state"><p>技能数据读取失败</p><button class="btn btn-sm" data-cbg-retry>重试</button></div>' : '<div class="empty-state"><p>正在读取各角色的技能数据…</p></div>';
  const list = filtered();
  return `<div class="bz-count text-muted">显示 ${list.length} / ${C.items.length} 个角色${C.loading ? ' · 刷新中…' : ''}</div>
    ${list.length ? `<div class="bz-list">${list.map(rowHtml).join('')}</div>` : '<div class="empty-state"><p>没有符合条件的角色，可以放宽筛选</p></div>'}
    ${C.error ? `<p class="down">${esc(C.error)}</p>` : ''}`;
}
const badge = (status) => `<span class="bz-kind ${status === 'fair' ? 'is-auction' : 'is-wts'}">${STATUS_NAME[status] || status}</span>`;
function rowHtml(t) {
  const r = ratioOf(t);
  return `<a class="bz-row" href="#bazaar/c/${t.id}" data-cbg-sn="${t.id}">
    ${t.character_id ? `<img class="bz-avatar" src="${esc(eveImage(`characters/${t.character_id}/portrait`, 64))}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">` : '<span class="bz-avatar"></span>'}
    <div class="bz-row-main">
      <div class="bz-row-title">${badge(t.status)}<span translate="no">${esc(t.name)}</span></div>
      <div class="bz-row-meta">${t.sp != null ? `<b class="bz-sp">${spText(t.sp)}</b>` : ''}${t.price != null ? `<b class="bz-isk">${yuan(t.price)}</b>` : ''}
        ${r != null ? `<b class="bz-ratio" title="每百万技能点的价格">${r.toFixed(1)} 元/百万SP</b>` : ''}
        ${t.sec != null ? `<span class="${t.sec < 0 ? 'down' : ''}">安全等级 ${t.sec.toFixed(2)}</span>` : ''}${t.isk != null ? `<span>钱包 ${ctx.formatISK(t.isk)} ISK</span>` : ''}</div>
    </div>
    <div class="bz-row-stats"><span>${t.status === 'fair' ? '公示剩余' : '剩余'}</span><small>${t.left ? leftText(t.left) : '—'}</small></div>
  </a>`;
}

async function fetchList(quiet) {
  C.loading = true; C.error = '';
  if (!quiet) refreshList();
  try {
    const r = await api('');
    C.items = r.items || [];
    C.at = Date.now();
  } catch (e) { C.error = e.message; }
  C.loading = false;
  if (C.view === 'list') { refreshList(); $('bazaarMain').querySelector('[data-cbg-retry]')?.removeAttribute('disabled'); } else renderSide();
}
function refreshList() {
  if (C.view !== 'list' || !$('bazaarList')) return;
  $('bazaarList').innerHTML = listHtml();
  renderSide();
}

// ---------- 角色详情 ----------
function getDetail(sn) {
  if (!C.detail.has(sn)) C.detail.set(sn, api('/detail?id=' + sn).catch((e) => { C.detail.delete(sn); throw e; }));
  return C.detail.get(sn);
}
async function openDetail(sn) {
  const main = $('bazaarMain');
  C.sn = sn;
  main.innerHTML = skPage({ cards: 2, rows: 8 });
  let d;
  try { d = await getDetail(sn); } catch (e) {
    if (C.sn !== sn || C.view !== 'detail') return;
    main.innerHTML = `<div class="empty-state"><p>角色读取失败：${esc(e.message)}</p><button class="btn btn-sm" data-cbg-back>返回列表</button></div>`;
    return;
  }
  if (C.sn !== sn || C.view !== 'detail') return;
  main.closest('.kb-scroll')?.scrollTo(0, 0);
  main.innerHTML = detailHtml(d);
  loadSkills(d);
  valueHtml(d).then((html) => { const v = $('cbgValue'); if (v && C.sn === sn) v.innerHTML = '<h4>估价</h4>' + html; });
}

function detailHtml(d) {
  const row = C.items.find((t) => t.id === d.id);
  // 公示页里也会出现已经上架的角色：以详情页的状态为准
  const status = /公示/.test(d.status || '') ? 'fair' : /上架|出售/.test(d.status || '') ? 'sale' : row?.status || 'sale';
  return `<section class="pi-page bz-page">
    <div class="bz-topic-top"><button class="btn btn-ghost btn-sm" data-cbg-back>← 返回列表</button><span class="toolbar-spacer"></span>
      <a class="btn btn-ghost btn-sm" href="${esc(d.url)}" target="_blank" rel="noopener">在藏宝阁打开 ↗</a></div>
    <div class="pi-card bz-topic-head">
      <div class="bz-who-head">${d.character_id ? `<img src="${esc(eveImage(`characters/${d.character_id}/portrait`, 128))}" alt="" width="64" height="64" referrerpolicy="no-referrer">` : ''}
        <div><h2>${badge(status)}<span translate="no">${esc(d.name)}</span></h2><small>${d.status ? `<span translate="no">${esc(d.status)}</span>` : ''}${d.left ? ` · <span>剩余</span> ${leftText(d.left)}` : ''}${d.seller ? ` · <span>卖家</span> <span translate="no">${esc(d.seller)}</span>` : ''}</small></div></div>
      <div class="bz-row-meta">${d.price != null ? `<b class="bz-isk">${yuan(d.price)}</b>` : ''}<b class="bz-sp">${spText(d.total_sp)}</b>
        ${d.unallocated_sp ? `<span>未分配 ${ctx.formatNumber(d.unallocated_sp)} SP</span>` : ''}${ratioOf({ price: d.price, sp: d.total_sp }) != null ? `<b class="bz-ratio">${ratioOf({ price: d.price, sp: d.total_sp }).toFixed(1)} 元/百万SP</b>` : ''}</div>
    </div>
    <div id="bazaarAna"></div>
    <div class="bz-topic-body">
      <div class="bz-posts">${shipsHtml(d)}${corpHtml(d)}</div>
      <aside class="bz-who">
        <div class="pi-card bz-who-card"><h4>角色资料</h4><dl>
          <dt>钱包</dt><dd>${d.isk != null ? ctx.formatISK(d.isk) + ' ISK' : '—'}</dd>
          <dt>安全等级</dt><dd class="${d.sec < 0 ? 'down' : d.sec > 0 ? 'up' : ''}">${d.sec != null ? Number(d.sec).toFixed(2) : '—'}</dd>
          <dt>所在空间站</dt><dd translate="no">${esc(d.station || "—")}</dd>
          <dt>已分配技能点</dt><dd>${ctx.formatNumber(d.allocated_sp || 0)}</dd>
          <dt>未分配技能点</dt><dd>${ctx.formatNumber(d.unallocated_sp || 0)}</dd>
        </dl><p class="text-muted bz-who-note">数据来自网易藏宝阁的角色快照。</p></div>
        <div class="pi-card bz-who-card" id="cbgValue"><h4>估价</h4><p class="text-muted">计算中…</p></div>
      </aside>
    </div>
  </section>`;
}

// 装配：同名装备合并成「× 数量」
function fitList(list) {
  const m = new Map();
  for (const [id, name] of list) { const x = m.get(id) || { name, n: 0 }; x.n++; m.set(id, x); }
  return [...m].map(([id, x]) => `<span><img src="https://images.evetech.net/types/${id}/icon?size=32" alt="" width="20" height="20" loading="lazy">${esc(x.name)}${x.n > 1 ? ` <b>×${x.n}</b>` : ''}</span>`).join('');
}
function shipsHtml(d) {
  if (!d.ships?.length) return '';
  return `<div class="pi-card bz-cbg-ships"><h3 class="bz-replies-h">展示的舰船<small>${d.ships.length}</small></h3>
    ${d.ships.map((s) => `<details class="bz-cbg-ship"><summary><img src="https://images.evetech.net/types/${s.type}/icon?size=32" alt="" width="28" height="28" loading="lazy"><b>${esc(s.name)}</b>
      ${s.jumps ? `<small class="text-muted">距离 ${s.jumps} 跳</small>` : ''}</summary>
      ${SLOTS.filter(([k]) => s.slots?.[k]?.length).map(([k, l]) => `<div class="bz-cbg-slot"><h4>${l}</h4><div class="bz-ships">${fitList(s.slots[k])}</div></div>`).join('') || '<p class="text-muted">没有装配</p>'}
    </details>`).join('')}</div>`;
}
function corpHtml(d) {
  const list = [...(d.corp_history || [])].sort((a, b) => b.startTime - a.startTime);
  if (!list.length) return '';
  return `<div class="pi-card bz-cbg-corps"><h3 class="bz-replies-h">军团历史<small>${list.length}</small></h3>
    <ol>${list.map((c) => `<li><img src="${esc(eveImage(`corporations/${c.corpId}/logo`, 32))}" alt="" width="20" height="20" loading="lazy" referrerpolicy="no-referrer"><span>${esc(c.corpName)}</span>
      <small class="text-muted">${c.startTime ? new Date(c.startTime * 1000).toLocaleDateString('zh-CN') + ' 加入' : ''}</small></li>`).join('')}</ol></div>`;
}

async function loadSkills(d) {
  const box = $('bazaarAna');
  if (C.ana?.id !== d.id) {
    C.ana = { id: d.id, tab: 'role', c: null, r: { name: d.name, url: d.url, source: '网易藏宝阁', skills: d.skills, total_sp: d.total_sp }, err: '' };
    box.innerHTML = '<div class="pi-card bz-ana"><h3>技能分析</h3><p class="text-muted">正在加载装配数据…</p></div>';
    BS.setHelpers({ esc: ctx.esc, formatNumber: ctx.formatNumber });
    try {
      const fd = await ctx.fitData();
      if (d.skills?.length) C.ana.c = BS.makeChar(fd.data, C.ana.r); else C.ana.err = '藏宝阁没有这个角色的技能数据';
    } catch (e) { C.ana.err = '装配数据加载失败：' + e.message; }
  }
  if (C.sn === d.id) renderAna();
}
function renderAna() {
  const box = $('bazaarAna');
  if (!box || !C.ana) return;
  box.innerHTML = C.ana.c ? BS.analysisHtml(C.ana.c, C.ana.r, null, C.ana.tab)
    : `<div class="pi-card bz-ana"><h3>技能分析</h3><p class="text-muted">${esc(C.ana.err || '没有技能数据')}</p></div>`;
}

// 估价：拆成大型技能注入器在交易中心的价值（ISK），和藏宝阁的人民币价格放在一起参考
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
    ${d.price != null ? `<dt>藏宝阁价格</dt><dd class="bz-isk">${yuan(d.price)}</dd>` : ''}
    <dt>总技能点</dt><dd>${spText(d.total_sp)}</dd>
    ${net != null ? `<dt title="${n} 支大型技能注入器 × ${esc(HUB_NAME)}卖价，扣除同样数量技能提取器的成本">拆注入器估价</dt><dd class="bz-isk">${ctx.formatISK(net)} ISK</dd>
    <dd class="bz-who-sub">可抽 ${+((d.total_sp - KEEP_SP) / 1e6).toFixed(1)}M SP = ${n} 支大型注入器（${esc(HUB_NAME)}卖价 ${ctx.formatISK(inj)}，提取器 ${ctx.formatISK(ext)}）</dd>
    ${d.price ? `<dd class="bz-who-sub">相当于每 1 元买 ${ctx.formatISK(net / d.price)} ISK 的技能点</dd>` : ''}` : ''}
    ${d.isk ? `<dt>钱包 ISK</dt><dd>${ctx.formatISK(d.isk)} ISK</dd>` : ''}
  </dl><p class="text-muted bz-who-note">拆注入器价值是角色的「下限」参考；老角色、稀有技能、舰船资产等通常有溢价。</p>`;
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
    const sn = t.closest('[data-cbg-sn]');
    if (sn) { e.preventDefault(); go('#bazaar/c/' + sn.dataset.cbgSn); ctx.closeDrawer(); return; }
    const st = t.closest('[data-cbg-status]');
    if (st) { C.status = st.dataset.cbgStatus; save(); if (C.view !== 'list') go('#bazaar'); else render(); ctx.closeDrawer(); return; }
    const tab = t.closest('[data-bz-tab]');
    if (tab && C.ana) { C.ana.tab = tab.dataset.bzTab; renderAna(); return; }
    const train = t.closest('[data-bz-train]');
    if (train && C.ana) { BS.setTrainShip(Number(train.dataset.bzTrain)); C.ana.tab = 'train'; renderAna(); return; }
    if (t.closest('[data-cbg-retry]')) { NEED.err = false; NEED.at = 0; loadNeed(); fetchList(false); return; }
    if (t.closest('[data-cbg-clear]')) { C.q = ''; $('bazaarSearch').value = ''; render(); return; }
    if (t.closest('[data-cbg-back]')) { if (C.fromList) { C.fromList = false; history.back(); } else go('#bazaar'); }
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-cbg-order]')) { C.order = t.value; save(); if (C.view !== 'list') go('#bazaar'); else render(); return; }
    if (t.matches('[data-cbg-sp]')) { C[t.dataset.cbgSp] = t.value; save(); if (C.view === 'list') refreshList(); }
  });
}
