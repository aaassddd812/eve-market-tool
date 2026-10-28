// ===== 角色交易（买卖号）=====
// 宁静服：官方论坛 Marketplace › Character Bazaar 版块（https://forums.eveonline.com/c/marketplace/character-bazaar/60）。
// 论坛没有开放跨域，经本站击杀记录服务代理（kb_service.py 的 Bazaar）：/api/kb/bazaar（列表 / 搜索）、/api/kb/bazaar/topic?id=（帖子全部楼层）。
// 标题里的出售 / 收购 / 拍卖、技能点、价格由后端从标题解析；类型、技能点范围、隐藏已售在前端按已读取的帖子筛选。
// 帖子详情：楼层正文（白名单清洗后显示，默认显示中文机器翻译 /api/kb/bazaar/translate?id=，可切回原文）、技能展示链接、
// 发帖角色的 ESI 公开信息（出生日期、军团、安全等级）与估价（卖家报价 + 按吉他价拆成大型技能注入器的价值）。
// 排序：最新回复 / 最新发布的首屏是后台索引里近 3 个月的全部帖子（合并论坛第 1 页实时数据），加载更多再读更早的论坛页；技能点 / 价格 / 每技能点价格读后端索引（后台慢速读取近期帖子 1 楼解析出的数据）。
// 卖家贴了 qsna.eu 技能展示时，详情里分析角色定位、可开舰船、开某艘船还要多久（bazaar-skills.js）。
// 列表标题：中文模式下附带后端批量机器翻译的标题（title_zh），原文作副标题。
// 晨曦服改用网易藏宝阁的在售角色（bazaar-cbg.js），曙光服暂不支持。
// 地址栏：#bazaar · #bazaar/t/<帖子ID>（晨曦：#bazaar/c/<藏宝阁订单号>）
import { IS_TQ, SERVER } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';
import * as BS from './bazaar-skills.js?v=6';

let ctx;   // esc, formatNumber, formatISK, showToast, fetchESI, store, getLivePrices(ids) -> Map(id -> { sell, buy }), fitData() -> { data, FE }, closeDrawer
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s ?? '');
const STORE_KEY = 'eve-bazaar-v1';
const FORUM = 'https://forums.eveonline.com';
const KINDS = [['all', '全部'], ['wts', '出售'], ['wtb', '收购'], ['auction', '拍卖'], ['wtt', '交换'], ['sold', '已售 / 关闭']];
const INJECTOR = 40520, EXTRACTOR = 40519;   // 大型技能注入器（50 万技能点）、技能提取器
const KEEP_SP = 5;                           // 角色至少保留 500 万技能点，不能再提取
const ASK_NAME = { buyout: '一口价', start: '起拍价', ask: '卖家要价' };
const ORDERS = [['activity', '最新回复'], ['created', '最新发布'], ['sp:desc', '技能点从高到低'], ['sp:asc', '技能点从低到高'],
  ['price:asc', '价格从低到高'], ['price:desc', '价格从高到低'], ['ratio:asc', '每技能点价格从低到高'], ['ratio:desc', '每技能点价格从高到低']];
const INDEXED = new Set(['sp', 'price', 'ratio']);
const KIND_NAME = { wts: '出售', wtb: '收购', auction: '拍卖', wtt: '交换', sold: '已售' };
// 常见的技能展示 / 角色资料站：详情里单独列出
const SHOWCASE = [
  [/(^|\.)skillq\.net$/, 'SkillQ 技能'], [/(^|\.)eveskillboard\.com$/, 'EVE Skillboard'], [/skillboard/, '技能面板'],
  [/(^|\.)evewho\.com$/, 'EveWho'], [/(^|\.)zkillboard\.com$/, 'zKillboard'], [/(^|\.)eve-?(skills|board)/, '技能面板']
];

const S = {
  dir: 'desc', indexed: 0, ana: null,
  view: 'list', lang: /^en/i.test(document.documentElement.lang) ? 'en' : 'zh', order: 'activity', q: '', kind: 'all', spMin: '', spMax: '', hideClosed: true,
  topics: [], page: 0, more: false, loading: false, error: '', seq: 0, key: '',
  topic: null, topicErr: '', who: new Map(),   // 角色名 -> Promise<ESI 公开信息|null>
  zh: new Map(), zhErr: '',                     // 帖子 ID -> { title, posts: { 楼层: 中文 HTML } }
  need: []                                      // 技能要求筛选条件（bazaar-skills.js 的 needHtml / meets）
};
// 技能要求筛选用的数据：装配数据 + 各帖技能展示角色的技能等级（/api/kb/bazaar/skillset）
const NEED = { data: null, sets: null, pending: 0, at: 0, loading: null, err: false, match: new Map() };
function loadNeed() {
  if (!S.need.length || NEED.loading || NEED.err || (NEED.sets && Date.now() - NEED.at < 300e3)) return NEED.loading;
  NEED.loading = Promise.all([ctx.fitData(), api('/skillset')]).then(([fd, r]) => {
    NEED.data = fd.data;
    NEED.sets = new Map(Object.entries(r.topics).map(([k, chars]) => [Number(k), chars.map(([cid, name, sp, sk]) => ({ cid, name, sp, have: BS.parseSkills(sk) }))]));
    NEED.pending = r.pending || 0;
    NEED.at = Date.now();
  }).catch((e) => { NEED.err = true; ctx.showToast('技能数据读取失败：' + e.message, 'error'); }).finally(() => { NEED.loading = null; if (S.view === 'list') refreshList(); });
  return NEED.loading;
}

function load() {
  try { Object.assign(S, JSON.parse(ctx.store.get(STORE_KEY) || '{}')); } catch { /* 忽略 */ }
}
function save() { ctx.store.set(STORE_KEY, JSON.stringify({ lang: S.lang, order: S.order, dir: S.dir, kind: S.kind, spMin: S.spMin, spMax: S.spMax, hideClosed: S.hideClosed, need: S.need })); }

export function initBazaar(context) { ctx = context; load(); }
const IS_CBG = SERVER.id === 'serenity';
let CBG = null;
const cbgModule = () => (CBG ||= import('./bazaar-cbg.js?v=8').then((m) => { m.initCbg(ctx); return m; }));

async function api(path) {
  const res = await fetch('/api/kb/bazaar' + path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
  return body;
}

export async function preload() {
  if (IS_CBG) { (await cbgModule()).preload(); return; }
  if (!IS_TQ || S.topics.length) return;
  await fetchList(false, true).catch(() => {});
}

export async function showBazaar(hash) {
  const main = $('bazaarMain');
  if (IS_CBG) { (await cbgModule()).showCbg(hash || location.hash); return; }
  if (!main.dataset.ready) { main.dataset.ready = '1'; bind(); }
  if (!IS_TQ) {
    $('bazaarSide').innerHTML = '';
    $('bazaarSearch').disabled = true;
    main.innerHTML = '<div class="empty-state"><p>角色交易目前只支持宁静服（官方论坛 Character Bazaar）和晨曦服（网易藏宝阁）</p></div>';
    return;
  }
  route(hash || location.hash);
}

function route(hash) {
  const m = /^#bazaar\/t\/(\d+)/.exec(hash);
  if (m) {
    S.view = 'topic';
    renderSide();
    openTopic(Number(m[1]));
    if (!S.topics.length && !S.loading) fetchList(false, true);   // 侧栏的分类计数
    return;
  }
  // 从菜单进入时地址栏没有 #bazaar：补上，详情页「返回列表」/ 浏览器后退才能回到这里
  if (!location.hash.startsWith('#bazaar')) history.replaceState(null, '', location.pathname + location.search + '#bazaar');
  const back = S.view !== 'list';
  S.view = 'list';
  loadNeed();
  render();
  if (back) scroller()?.scrollTo(0, S.listTop || 0);   // 回到列表时恢复滚动位置
  const key = S.order + '|' + S.dir + '|' + S.q + '|' + S.lang;
  if (key !== S.key || (!S.topics.length && !S.loading)) fetchList(false);
}
const scroller = () => $('bazaarMain').closest('.kb-scroll');
function go(hash) {
  // 从列表点进详情：记下滚动位置；「返回列表」用浏览器后退，前进 / 后退记录保持一致
  S.fromList = S.view === 'list' && hash !== '#bazaar';
  if (S.fromList) S.listTop = scroller()?.scrollTop || 0;
  if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
  route(hash);
}

function render() {
  renderSide();
  const main = $('bazaarMain');
  if (S.view === 'list') main.innerHTML = listPage();
}

// ---------- 时间与数字 ----------
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  if (s < 86400 * 60) return Math.round(s / 86400) + ' 天前';
  return iso.slice(0, 10);
}
const fullTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
const spText = (v) => (v == null ? '' : (v >= 100 ? Math.round(v) : +v.toFixed(1)) + 'M SP');
const iskText = (v) => (v == null ? '' : +v.toFixed(1) + 'B ISK');

// ---------- 侧边栏：类型、排序、技能点范围、交易须知 ----------
function filtered() {
  const lo = S.spMin === '' ? null : Number(S.spMin), hi = S.spMax === '' ? null : Number(S.spMax);
  return S.topics.filter((t) => {
    if (t.pinned) return false;
    const done = t.closed || t.kind === 'sold';
    if (S.kind === 'sold') { if (!done) return false; }
    else {
      if (S.hideClosed && done) return false;
      if (S.kind !== 'all' && t.kind !== S.kind) return false;
    }
    if ((lo != null || hi != null) && (t.sp == null || (lo != null && t.sp < lo) || (hi != null && t.sp > hi))) return false;
    if (S.need.length) {
      // 技能要求：只看贴了 qsna.eu 技能展示的帖子，一帖多个角色时任一角色符合即可
      const ok = (NEED.sets?.get(t.id) || []).filter((c) => BS.meets(NEED.data, c.have, S.need));
      if (!ok.length) return false;
      NEED.match.set(t.id, ok);
    }
    return true;
  });
}

const orderKey = () => (INDEXED.has(S.order) ? S.order + ':' + S.dir : S.order);
function renderSide() {
  const side = $('bazaarSide');
  const counts = {};
  for (const t of S.topics) {
    if (t.pinned) continue;
    const k = t.closed || t.kind === 'sold' ? 'sold' : t.kind;
    counts[k] = (counts[k] || 0) + 1;
    if (k !== 'sold' || !S.hideClosed) counts.all = (counts.all || 0) + 1;
  }
  const kinds = KINDS.map(([k, name]) => `<button class="ind-side-item${S.kind === k && S.view === 'list' ? ' active' : ''}" data-bz-kind="${k}"><span>${name}</span><small>${counts[k] || 0}</small></button>`).join('');
  const rules = S.topics.find((t) => t.pinned);
  side.innerHTML = `
    <div class="ind-side-section"><h4>帖子类型<small>已读取 ${S.topics.filter((t) => !t.pinned).length} 帖</small></h4>${kinds}</div>
    <div class="ind-side-section bz-side-form">
      <h4>排序</h4>
      <select class="input bz-order" data-bz-order aria-label="排序">${ORDERS.map(([k, l]) => `<option value="${k}"${k === orderKey() ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${INDEXED.has(S.order) ? `<p class="bz-side-note">按 1 楼解析出的技能点 / 报价排序，只含已索引的 ${S.indexed} 个近期帖子（后台每 15 分钟补充），没写价格的不显示。</p>` : ''}
      <h4>技能点（百万）</h4>
      <div class="bz-range"><input class="input" type="number" min="0" step="any" data-bz-sp="spMin" value="${esc(S.spMin)}" placeholder="最低"><i>~</i><input class="input" type="number" min="0" step="any" data-bz-sp="spMax" value="${esc(S.spMax)}" placeholder="最高"></div>
      <label class="bz-check"><input type="checkbox" data-bz-hide${S.hideClosed ? ' checked' : ''}>隐藏已售出 / 已关闭</label>
    </div>
    ${BS.needHtml(S.need, S.need.length ? (NEED.sets ? `只在 ${NEED.sets.size} 个贴了 qsna.eu 技能展示的帖子里筛选${NEED.pending ? `（还有 ${NEED.pending} 个正在后台读取）` : ''}` : '正在读取技能数据…') : '只筛选贴了 qsna.eu 技能展示的帖子（约六成）')}
    <div class="ind-side-section bz-tips">
      <h4>交易须知</h4>
      <ul>
        <li>出售帖必须由被出售的角色本人发帖，买家应在游戏内给该角色发 EVE 邮件确认。</li>
        <li>只能用 ISK 交易，现金交易（RMT）违反用户协议，角色会被封禁。</li>
        <li>付款后卖家在账号管理页面发起「角色转移」，转移费用一般由卖家承担。</li>
        <li>付款前核对技能展示链接里的角色名、技能点与出生日期是否与帖子一致。</li>
      </ul>
      ${rules ? `<button class="link-btn" data-bz-topic="${rules.id}">版块规则（官方置顶帖）</button>` : ''}
    </div>`;
}

// ---------- 列表 ----------
function listPage() {
  const list = filtered();
  const title = S.q ? `搜索「${esc(S.q)}」` : '角色集市';
  return `<section class="pi-page bz-page">
    <div class="pi-head bz-head"><h2>${title}</h2><span class="text-muted">宁静服 · 官方论坛 Character Bazaar</span><span class="toolbar-spacer"></span>
      ${S.q ? '<button class="btn btn-ghost btn-sm" data-bz-clear>清除搜索</button>' : ''}
      <a class="btn btn-ghost btn-sm" href="${FORUM}/c/marketplace/character-bazaar/60" target="_blank" rel="noopener">论坛原版块 ↗</a></div>
    <div id="bazaarList">${listHtml(list)}</div>
  </section>`;
}
function listHtml(list = filtered()) {
  if (S.error && !S.topics.length) return `<div class="empty-state"><p>读取失败：${esc(S.error)}</p><button class="btn btn-sm" data-bz-retry>重试</button></div>`;
  if (!S.topics.length && S.loading) return skPage({ rows: 10 });
  if (S.need.length && !NEED.sets) return NEED.loading || loadNeed() ? '<div class="empty-state"><p>正在读取卖家的技能数据…</p></div>' : '<div class="empty-state"><p>技能数据读取失败</p><button class="btn btn-sm" data-bz-retry>重试</button></div>';
  const rows = list.map(rowHtml).join('');
  return `<div class="bz-count text-muted">显示 ${list.length} / ${S.topics.filter((t) => !t.pinned).length} 帖${S.loading ? ' · 读取中…' : ''}</div>
    ${rows ? `<div class="bz-list">${rows}</div>` : '<div class="empty-state"><p>已读取的帖子里没有符合条件的，可以加载更多或放宽筛选</p></div>'}
    ${S.more ? `<div class="aby-more"><button class="btn" data-bz-more ${S.loading ? 'disabled' : ''}>${S.loading ? '读取中…' : '加载更多'}</button></div>` : ''}
    ${S.error ? `<p class="down">${esc(S.error)}</p>` : ''}`;
}
function priceTitle(t) {
  return (t.asks || []).map(([k, v]) => `${ASK_NAME[k] || '报价'} ${iskText(v)}`).join('，') || '标题里的价格';
}
function kindBadge(t) {
  const k = t.closed && t.kind !== 'sold' ? 'sold' : t.kind;
  return k ? `<span class="bz-kind is-${k}">${t.closed && t.kind !== 'sold' ? '已关闭' : KIND_NAME[k]}</span>` : '';
}
const zhTitle = (t) => (S.lang === 'zh' && t.title_zh && t.title_zh !== t.title ? t.title_zh : '');
function rowHtml(t) {
  return `<a class="bz-row" href="#bazaar/t/${t.id}" data-bz-topic="${t.id}">
    ${t.avatar ? `<img class="bz-avatar" src="${esc(t.avatar)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer">` : '<span class="bz-avatar"></span>'}
    <div class="bz-row-main">
      <div class="bz-row-title">${kindBadge(t)}<span translate="no"${zhTitle(t) ? ` title="${esc(t.title)}"` : ''}>${esc(zhTitle(t) || t.title)}</span></div>
      ${zhTitle(t) ? `<div class="bz-row-en" translate="no">${esc(t.title)}</div>` : ''}
      <div class="bz-row-meta">${t.sp != null ? `<b class="bz-sp">${spText(t.sp)}</b>` : ''}${t.price != null ? `<b class="bz-isk" title="${esc(priceTitle(t))}">${iskText(t.price)}</b>` : t.isk != null ? `<b class="bz-isk">${iskText(t.isk)}</b>` : ''}
        ${t.ratio != null ? `<b class="bz-ratio" title="每个技能点的价格">${ctx.formatNumber(t.ratio)} ISK/SP</b>` : ''}${S.need.length && NEED.match.get(t.id) ? `<span class="bz-board is-ok" title="符合技能要求的角色">符合：<span translate="no">${esc(NEED.match.get(t.id).map((c) => c.name).join('、'))}</span></span>` : t.board ? '<span class="bz-board" title="卖家贴了 qsna.eu 技能展示，详情里可分析能开什么船">可分析技能</span>' : ''}
        ${t.author ? `<span translate="no">${esc(t.author)}</span>` : ''}<span title="${esc(fullTime(t.created_at))}">发布于 ${ago(t.created_at)}</span></div>
    </div>
    <div class="bz-row-stats"><span title="回复">${Math.max(0, (t.posts || 1) - 1)} 回复</span>${t.views != null ? `<span>${ctx.formatNumber(t.views)} 浏览</span>` : ''}
      <small title="${esc(fullTime(t.last_posted_at))}">${ago(t.last_posted_at)}${t.last_poster ? ' · <span translate="no">' + esc(t.last_poster) + '</span>' : ''}</small></div>
  </a>`;
}

async function fetchList(more, quiet = false) {
  const seq = ++S.seq;
  S.loading = true; S.error = '';
  if (!more) { S.topics = []; S.page = 0; S.more = false; S.key = S.order + '|' + S.dir + '|' + S.q + '|' + S.lang; }
  if (!quiet) refreshList();
  const page = more ? S.page + 1 : 0;
  try {
    const q = new URLSearchParams({ page, order: S.order });
    if (INDEXED.has(S.order)) q.set('dir', S.dir);
    if (S.q) q.set('q', S.q);
    if (S.lang === 'zh') q.set('zh', 1);
    const r = await api('?' + q);
    if (seq !== S.seq) return;
    const seen = new Set(S.topics.map((t) => t.id));
    S.topics = [...S.topics, ...r.topics.filter((t) => !seen.has(t.id))];
    S.page = page;
    S.more = r.more;
    S.indexed = r.indexed || 0;
  } catch (e) {
    if (seq !== S.seq) return;
    S.error = e.message;
  }
  S.loading = false;
  if (S.view === 'list') refreshList(); else renderSide();
}
function refreshList() {
  if (S.view !== 'list' || !$('bazaarList')) return;
  $('bazaarList').innerHTML = listHtml();
  renderSide();
}

// ---------- 帖子详情 ----------
async function openTopic(id) {
  const main = $('bazaarMain');
  if (S.topic?.id !== id) {
    S.topic = null; S.topicErr = '';
    main.innerHTML = skPage({ cards: 2, rows: 8 });
    try { S.topic = await api('/topic?id=' + id); } catch (e) { S.topicErr = e.message; }
    if (S.view !== 'topic' || !location.hash.startsWith('#bazaar/t/' + id)) return;
  }
  main.closest('.kb-scroll')?.scrollTo(0, 0);
  if (!S.topic) {
    main.innerHTML = `<div class="empty-state"><p>帖子读取失败：${esc(S.topicErr)}</p><button class="btn btn-sm" data-bz-back>返回列表</button></div>`;
    return;
  }
  main.innerHTML = topicHtml(S.topic);
  const op = S.topic.posts[0];
  if (op) whoCard(op.user, S.topic);
  if (S.lang === 'zh') loadZh(S.topic);
  if (S.topic.board) loadSkills(S.topic);
}

// ---------- 技能分析（qsna.eu）----------
async function loadSkills(t) {
  const box = $('bazaarAna');
  if (S.ana?.id !== t.id) {
    // 一帖卖多个角色时 1 楼有多个 qsna.eu 链接：全部读取，可切换
    const boards = t.boards?.length ? t.boards : [t.board];
    S.ana = { id: t.id, tab: 'role', cur: 0, chars: boards.map((cid) => ({ cid, r: null, c: null, err: '' })) };
    box.innerHTML = '<div class="pi-card bz-ana"><h3>技能分析</h3><p class="text-muted">正在读取卖家的技能与舰船数据…</p></div>';
    let fd = null;
    try { fd = await ctx.fitData(); } catch (e) { S.ana.chars.forEach((x) => { x.err = '装配数据加载失败：' + e.message; }); }
    BS.setHelpers({ esc: ctx.esc, formatNumber: ctx.formatNumber });
    if (fd) {
      await Promise.all(S.ana.chars.map(async (x) => {
        try {
          x.r = await api(`/skills?id=${t.id}&char=${x.cid}`);
          if (x.r.skills) x.c = BS.makeChar(fd.data, x.r);
          else x.err = 'qsna.eu 上这个角色的技能没有公开';
        } catch (e) { x.err = e.message; }
      }));
    }
  }
  if (S.topic?.id !== t.id) return;
  renderAna();
  refreshValue(t);
}
const curChar = () => S.ana?.chars[S.ana.cur];
function renderAna() {
  const box = $('bazaarAna');
  const x = curChar();
  if (!box || !x) return;
  const multi = S.ana.chars.length > 1;
  const picker = multi ? `<div class="segmented bz-chars" role="group" aria-label="选择角色">${S.ana.chars.map((y, i) =>
    `<button type="button" data-bz-char="${i}" class="${i === S.ana.cur ? 'active' : ''}"><span translate="no">${esc(y.r?.name || '角色 ' + (i + 1))}</span>${y.c ? ' · ' + (y.c.total / 1e6).toFixed(1) + 'M' : ''}</button>`).join('')}</div>` : '';
  if (!x.c) { box.innerHTML = `<div class="pi-card bz-ana"><div class="bz-ana-head"><h3>技能分析</h3>${picker}</div><p class="text-muted">${esc(x.err || '没有技能数据')}</p></div>`; return; }
  box.innerHTML = BS.analysisHtml(x.c, x.r, multi ? null : S.topic.posts[0]?.user?.replace(/_/g, ' '), S.ana.tab, picker);
}
function refreshValue(t) {
  valueHtml(t).then((html) => { const v = $('bazaarValue'); if (v && S.topic === t) v.innerHTML = '<h4>估价</h4>' + html; });
}

// 中文机器翻译：整帖一次读取，到了以后只替换各楼层正文
async function loadZh(t) {
  if (!S.zh.has(t.id)) {
    S.zhErr = '';
    setLangState('翻译中…');
    try { S.zh.set(t.id, await api('/translate?id=' + t.id)); } catch (e) { S.zhErr = e.message; }
  }
  if (S.topic?.id !== t.id || S.view !== 'topic') return;
  applyLang();
}
function setLangState(text) { const el = document.querySelector('.bz-lang-state'); if (el) el.textContent = text; }
function applyLang() {
  const t = S.topic, zh = S.lang === 'zh' ? S.zh.get(t.id) : null;
  for (const p of t.posts) {
    const el = document.querySelector(`#bz-post-${p.n} .bz-post-body`);
    const html = zh?.posts?.[p.n];
    if (el) el.innerHTML = clean(html || p.html);
    document.querySelector(`#bz-post-${p.n} .bz-mt`)?.toggleAttribute('hidden', !html);
  }
  const sub = document.querySelector('.bz-title-zh');
  if (sub) { sub.textContent = zh?.title || ''; sub.hidden = !zh?.title; }
  setLangState(S.lang === 'zh' ? (S.zhErr ? '翻译失败：' + S.zhErr : zh ? 'Google 机器翻译，仅供参考' : '') : '');
  document.querySelectorAll('[data-bz-lang]').forEach((b) => b.classList.toggle('active', b.dataset.bzLang === S.lang));
}

function topicHtml(t) {
  const [op, ...replies] = t.posts;
  const links = op ? showcaseLinks(op.html) : [];
  return `<section class="pi-page bz-page">
    <div class="bz-topic-top"><button class="btn btn-ghost btn-sm" data-bz-back>← 返回列表</button>
      <div class="segmented" role="group" aria-label="正文语言">${[['zh', '中文翻译'], ['en', '英文原文']].map(([k, l]) => `<button type="button" data-bz-lang="${k}" class="${S.lang === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <small class="text-muted bz-lang-state"></small><span class="toolbar-spacer"></span>
      <a class="btn btn-ghost btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener">在论坛打开 ↗</a></div>
    <div class="pi-card bz-topic-head">
      <h2>${kindBadge(t)}<span translate="no">${esc(t.title)}</span></h2>
      <p class="bz-title-zh" translate="no" hidden></p>
      <div class="bz-row-meta">${t.sp != null ? `<b class="bz-sp">${spText(t.sp)}</b>` : ''}${t.isk != null ? `<b class="bz-isk">${iskText(t.isk)}</b>` : ''}
        <span title="${esc(fullTime(t.created_at))}">发布于 ${ago(t.created_at)}</span><span>${Math.max(0, (t.posts_count || 1) - 1)} 回复</span>${t.views != null ? `<span>${ctx.formatNumber(t.views)} 浏览</span>` : ''}
        <span title="${esc(fullTime(t.last_posted_at))}">最后回复 ${ago(t.last_posted_at)}</span></div>
      ${links.length ? `<div class="bz-links">${links.map(([href, name]) => `<a class="btn btn-sm" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>`).join('')}</div>` : ''}
    </div>
    ${t.board ? '<div id="bazaarAna"></div>' : ''}
    <div class="bz-topic-body">
      <div class="bz-posts">
        ${op ? postHtml(op, true) : ''}
        ${replies.length ? `<h3 class="bz-replies-h">回复 / 出价<small>${replies.length}${t.posts_count > t.posts.length ? ' / ' + (t.posts_count - 1) : ''}</small></h3>${replies.map((p) => postHtml(p)).join('')}` : ''}
      </div>
      <aside class="bz-who" id="bazaarWho"></aside>
    </div>
  </section>`;
}
function postHtml(p, first = false) {
  return `<article class="pi-card bz-post${first ? ' is-op' : ''}" id="bz-post-${p.n}">
    <header>${p.avatar ? `<img src="${esc(p.avatar)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <b translate="no">${esc(p.name || p.user)}</b>${first ? '<span class="bz-op">发帖人</span>' : ''}<span class="bz-mt" hidden>机器翻译</span>
      ${p.reply_to ? `<a class="text-muted" href="#bz-post-${p.reply_to}" data-bz-jump="${p.reply_to}">回复 #${p.reply_to}</a>` : ''}
      <span class="toolbar-spacer"></span><small class="text-muted" title="${esc(fullTime(p.created_at))}">#${p.n} · ${ago(p.created_at)}</small></header>
    <div class="bz-post-body" translate="no">${clean(p.html)}</div>
  </article>`;
}

// 论坛正文（Discourse 已渲染的 HTML）按白名单清洗：只保留排版标签，链接 / 图片只允许 http(s)，相对地址补成论坛地址
const KEEP = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'CODE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'HR', 'ASIDE', 'DIV', 'SPAN', 'DETAILS', 'SUMMARY', 'SMALL', 'SUP', 'SUB']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'VIDEO', 'AUDIO']);
function safeUrl(u) {
  try {
    const url = new URL(u, FORUM);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}
function clean(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      walk(el);
      if (!KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      const attrs = {};
      if (el.tagName === 'A') attrs.href = safeUrl(el.getAttribute('href'));
      if (el.tagName === 'IMG') {
        attrs.src = safeUrl(el.getAttribute('src'));
        if (!attrs.src) { el.remove(); continue; }
        attrs.alt = el.getAttribute('alt') || '';
        if (el.classList.contains('emoji')) attrs.class = 'emoji';
      }
      if (el.tagName === 'TD' || el.tagName === 'TH') for (const k of ['colspan', 'rowspan']) if (/^\d+$/.test(el.getAttribute(k) || '')) attrs[k] = el.getAttribute(k);
      if (el.tagName === 'ASIDE') attrs.class = 'bz-quote';
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
      if (el.tagName === 'IMG') { el.setAttribute('loading', 'lazy'); el.setAttribute('referrerpolicy', 'no-referrer'); }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function showcaseLinks(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = safeUrl(a.getAttribute('href'));
    if (!href) continue;
    const host = new URL(href).hostname.replace(/^www\./, '');
    const hit = SHOWCASE.find(([re]) => re.test(host));
    if (hit && !out.has(href)) out.set(href, hit[1]);
  }
  return [...out].slice(0, 6);
}

// 发帖角色：论坛用户名就是角色名（空格写成下划线），用 ESI 查公开资料
function lookup(name) {
  if (!S.who.has(name)) {
    S.who.set(name, (async () => {
      const ids = await ctx.fetchESI('/universe/ids/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([name]) });
      const id = ids.characters?.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id;
      if (!id) return null;
      const c = await ctx.fetchESI(`/characters/${id}/`);
      const names = await ctx.fetchESI('/universe/names/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([c.corporation_id, c.alliance_id].filter(Boolean)) }).catch(() => []);
      const nm = new Map(names.map((x) => [x.id, x.name]));
      return { id, ...c, corp: nm.get(c.corporation_id), alliance: nm.get(c.alliance_id) };
    })().catch(() => { S.who.delete(name); return null; }));
  }
  return S.who.get(name);
}
// 估价：卖家报价（标题 / 1 楼解析）+ 拆注入器价值：(技能点 - 500 万) / 50 万 支大型技能注入器 ×（注入器卖价 - 提取器卖价）
let PRICES = null;
function loadPrices() {
  if (!PRICES || Date.now() - PRICES.at > 300e3) PRICES = { at: Date.now(), p: ctx.getLivePrices([INJECTOR, EXTRACTOR]).catch(() => new Map()) };
  return PRICES.p;
}
async function valueHtml(t) {
  // 有技能展示时按所选角色的总技能点算；一帖多个角色时报价对应哪个角色说不准，只提示看正文
  const x = S.ana?.id === t.id ? curChar() : null;
  const multi = S.ana?.id === t.id && S.ana.chars.length > 1;
  const boardSp = x?.c ? x.c.total / 1e6 : null;
  const sp0 = boardSp ?? t.sp;
  const asks = multi ? [] : [...(t.asks || [])];
  if (!multi && t.isk != null && !asks.length) asks.push(['ask', t.isk]);
  const askRows = asks.map(([k, v]) => `<dt>${ASK_NAME[k] || '报价'}</dt><dd class="bz-isk">${ctx.formatISK(v * 1e9)} ISK</dd>`).join('');
  let sp = '';
  const who = multi && x?.r?.name ? `<dt>角色</dt><dd translate="no">${esc(x.r.name)}</dd>` : '';
  const diff = boardSp != null && t.sp != null && !multi && Math.abs(boardSp - t.sp) / boardSp > 0.05
    ? `<dd class="bz-who-sub">帖子写的是 ${spText(t.sp)}，与技能展示站的 ${spText(boardSp)} 不一致，请向卖家确认</dd>` : '';
  if (sp0 != null) {
    t = { ...t, sp: sp0 };
    const prices = await loadPrices();
    const inj = prices.get(INJECTOR)?.sell, ext = prices.get(EXTRACTOR)?.sell;
    const n = Math.max(0, Math.floor((t.sp - KEEP_SP) * 2));
    if (inj && ext) {
      const net = n * (inj - ext);
      const ratio = asks.map(([k, v]) => `<span>${ASK_NAME[k] || '报价'}是它的 ${(v * 1e9 / net).toFixed(2)} 倍</span>`).join('');
      sp = `<dt>技能点</dt><dd>${spText(t.sp)}</dd>
        <dt title="${n} 支大型技能注入器 × 吉他卖价，扣除同样数量技能提取器的成本">拆注入器估价</dt><dd class="bz-isk">${ctx.formatISK(net)} ISK</dd>
        <dd class="bz-who-sub"><span>可抽 ${+(t.sp - KEEP_SP).toFixed(1)}M SP = ${n} 支大型注入器（吉他卖价 ${ctx.formatISK(inj)}，提取器 ${ctx.formatISK(ext)}）</span>${ratio}</dd>`;
    } else sp = `<dt>技能点</dt><dd>${spText(t.sp)}</dd>`;
    sp += diff;
  }
  if (!askRows && !sp) return '<p class="text-muted">标题和 1 楼里没有找到技能点与报价，请看正文。</p>';
  return `${multi ? `<p class="text-muted bz-who-note">帖子里有 ${S.ana.chars.length} 个角色，报价请看正文；下面按技能分析里选中的角色估算。</p>` : ''}<dl>${who}${askRows}${sp}</dl><p class="text-muted bz-who-note">拆注入器价值是角色的「下限」参考；老角色、稀有技能、属性重置次数等通常有溢价。</p>`;
}

async function whoCard(user, t) {
  const box = $('bazaarWho');
  if (!box || !user) return;
  const name = user.replace(/_/g, ' ');
  box.innerHTML = `<div class="pi-card bz-who-card"><h4>发帖角色</h4><p class="text-muted">正在查询 <span translate="no">${esc(name)}</span>…</p></div>
    <div class="pi-card bz-who-card" id="bazaarValue"><h4>估价</h4><p class="text-muted">计算中…</p></div>`;
  refreshValue(t);
  const c = await lookup(name);
  if (!$('bazaarWho') || $('bazaarWho') !== box) return;
  const card = box.firstElementChild;
  if (!c) {
    card.innerHTML = `<h4>发帖角色</h4><p class="text-muted">ESI 找不到名为 <span translate="no">${esc(name)}</span> 的角色（论坛名可能与角色名不同），请谨慎交易。</p>`;
    return;
  }
  const age = c.birthday ? ((Date.now() - Date.parse(c.birthday)) / (365.25 * 86400e3)).toFixed(1) : '';
  const sec = Number(c.security_status || 0);
  card.innerHTML = `
    <h4>发帖角色</h4>
    <div class="bz-who-head"><img src="https://images.evetech.net/characters/${c.id}/portrait?size=128" alt="" width="64" height="64">
      <div><b translate="no">${esc(c.name)}</b><small>${c.birthday ? '创建于 ' + c.birthday.slice(0, 10) + (age ? `（${age} 年）` : '') : ''}</small></div></div>
    <dl>
      <dt>军团</dt><dd translate="no">${esc(c.corp || '—')}</dd>
      ${c.alliance ? `<dt>联盟</dt><dd translate="no">${esc(c.alliance)}</dd>` : ''}
      <dt>安全等级</dt><dd class="${sec < 0 ? 'down' : sec > 0 ? 'up' : ''}">${sec.toFixed(2)}</dd>
    </dl>
    <div class="bz-who-links">
      <a class="btn btn-sm" href="#kb/character/${c.id}">本站击杀记录</a>
      <a class="btn btn-ghost btn-sm" href="https://zkillboard.com/character/${c.id}/" target="_blank" rel="noopener">zKillboard ↗</a>
      <a class="btn btn-ghost btn-sm" href="https://evewho.com/character/${c.id}" target="_blank" rel="noopener">EveWho ↗</a>
    </div>
    <p class="text-muted bz-who-note">资料来自 ESI 公开信息。出售帖应由该角色本人发出，交易前请在游戏内邮件确认。</p>`;
}

// ---------- 事件 ----------
function bind() {
  const view = $('bazaarView');
  BS.bindAna(view, () => curChar()?.c, renderAna, (m) => ctx.showToast(m, 'error'));
  BS.bindNeed($('bazaarSide'), {
    get: () => S.need,
    set: (reqs) => { S.need = reqs; save(); NEED.match.clear(); if (S.view !== 'list') go('#bazaar'); else { refreshList(); loadNeed(); } },
    data: () => ctx.fitData().then((f) => f.data)
  });
  let timer = 0;
  $('bazaarSearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { S.q = e.target.value.trim(); if (S.view !== 'list') go('#bazaar'); else route('#bazaar'); }, 500);
  });
  view.addEventListener('click', (e) => {
    const t = e.target;
    const topic = t.closest('[data-bz-topic]');
    if (topic) { e.preventDefault(); go('#bazaar/t/' + topic.dataset.bzTopic); ctx.closeDrawer(); return; }
    const kind = t.closest('[data-bz-kind]');
    if (kind) { S.kind = kind.dataset.bzKind; save(); if (S.view !== 'list') go('#bazaar'); else render(); ctx.closeDrawer(); return; }
    const ch = t.closest('[data-bz-char]');
    if (ch && S.ana) { S.ana.cur = Number(ch.dataset.bzChar); renderAna(); refreshValue(S.topic); return; }
    const tab = t.closest('[data-bz-tab]');
    if (tab && S.ana) { S.ana.tab = tab.dataset.bzTab; renderAna(); return; }
    const train = t.closest('[data-bz-train]');
    if (train && S.ana) { BS.setTrainShip(Number(train.dataset.bzTrain)); S.ana.tab = 'train'; renderAna(); return; }
    if (t.closest('[data-bz-more]')) { fetchList(true); return; }
    if (t.closest('[data-bz-retry]')) { NEED.err = false; fetchList(false); return; }
    if (t.closest('[data-bz-clear]')) { S.q = ''; $('bazaarSearch').value = ''; route('#bazaar'); return; }
    if (t.closest('[data-bz-back]')) { if (S.fromList) { S.fromList = false; history.back(); } else go('#bazaar'); return; }
    const lang = t.closest('[data-bz-lang]');
    if (lang) { S.lang = lang.dataset.bzLang; save(); if (S.lang === 'zh' && S.topic) loadZh(S.topic); else applyLang(); return; }
    const jump = t.closest('[data-bz-jump]');
    if (jump) { e.preventDefault(); $('bz-post-' + jump.dataset.bzJump)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-bz-order]')) {
      const [o, d] = t.value.split(':');
      S.order = o; S.dir = d || 'desc'; save();
      if (S.view !== 'list') go('#bazaar'); else route('#bazaar');
      return;
    }
    if (t.matches('[data-bz-sp]')) { S[t.dataset.bzSp] = t.value; save(); if (S.view === 'list') refreshList(); return; }
    if (t.matches('[data-bz-hide]')) { S.hideClosed = t.checked; save(); if (S.view === 'list') refreshList(); }
  });
}
