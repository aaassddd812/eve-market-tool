// ===== 手机导航（≤768px）=====
// 顶栏的功能入口在手机上放不下（19 个），改成：
//   底部标签栏（按常见 App 的习惯，「我的」放最后）：市场中心、星图、击杀、「全部」、个人中心；当前页不在标签里时「全部」高亮。
//   「全部」弹出底部面板：按交易 / 战斗 / 工业 / 更多分组的功能宫格，以及顶栏收起的语言、主题、API 文档、定制按钮和「下载 App」（App 里隐藏）。
//   顶栏：当前页名称（左）+ 当前页侧栏按钮（市场是搜索图标，其他页是筛选图标，放右边）、服务器、购物车、预警（隐藏规则在 CSS 的 768px 断点里）。
//   页面里和顶栏同名的大标题（「估价」「合同」……）在手机上隐藏，见 markDupTitles。
//   输入框弹出键盘时隐藏底部标签栏。
//   二级页面（物品详情、倒卖排行、击杀详情 / 战报，以及从「全部」进入的各功能页）顶栏左边显示「‹」返回，点了等于浏览器后退；
//   只在能后退回本站上一页时显示（直接打开链接进来的没有上一页，靠底部标签栏切换）。
//   市场页的物品目录在手机上是从顶部出现的全屏搜索页（#sidebar.m-search，样式在 CSS），右上角「取消」关闭。
// 所有按钮都转发点击给顶栏原来的按钮，切换逻辑、高亮都沿用 modern-app.js（syncNavActive 调 syncMobileNav）。

const TABS = ['market', 'map', 'kb', '*', 'profile'];   // * 是「全部」
const ROOTS = new Set(['market', 'map', 'kb', 'profile']);   // 标签栏里的一级页面（个人中心的子页有自己的返回条）
const GROUPS = [
  ['交易', ['market', 'arb', 'appraisal', 'contracts', 'courier', 'lp', 'abyss', 'bazaar']],
  ['战斗', ['kb', 'sim', 'fit', 'war', 'sov', 'wh']],
  ['工业', ['industry', 'pi']],
  ['更多', ['map', 'ai', 'plaza', 'guide', 'profile']]
];
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>';
const keyOf = (btn) => (btn.hasAttribute('data-arb') ? 'arb' : btn.dataset.view);
const navBtns = () => [...document.querySelectorAll('.header-nav .nav-btn')].filter((b) => !b.hidden);
const GRID_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

let bar = null, sheet = null, title = null, back = null;
let curKey = '';
let depth = 0;   // 本站内能后退几步：pushState 时在 history.state 里记 mDepth
let byKey = new Map();   // 底栏 / 面板按钮 → 顶栏原按钮

// 复制顶栏按钮的图标和名称（名称由 i18n.js 自动翻译）
function copyOf(btn, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.mnav = keyOf(btn);
  b.innerHTML = btn.querySelector('svg').outerHTML + `<span>${btn.querySelector('span').textContent}</span>`;
  return b;
}

export function initMobileNav() {
  const app = document.getElementById('app');
  const header = document.querySelector('.app-header');
  if (!app || !header || bar) return;
  const btns = [...document.querySelectorAll('.header-nav .nav-btn')];
  byKey = new Map(btns.map((b) => [keyOf(b), b]));

  // 顶栏：当前页名称
  title = document.createElement('span');
  title.className = 'mobile-title';
  header.querySelector('#menuToggle').after(title);
  back = document.createElement('button');
  back.type = 'button';
  back.className = 'icon-btn mobile-back';
  back.hidden = true;
  back.setAttribute('aria-label', '返回');
  back.title = '返回';
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  back.addEventListener('click', () => history.back());
  title.before(back);
  trackDepth();

  // 底部标签栏
  bar = document.createElement('nav');
  bar.className = 'mobile-tabbar';
  bar.setAttribute('aria-label', '主导航');
  for (const k of TABS) {
    if (k !== '*') { if (byKey.has(k)) bar.appendChild(copyOf(byKey.get(k), 'mtab')); continue; }
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'mtab';
    all.dataset.mnavAll = '';
    all.setAttribute('aria-haspopup', 'dialog');
    all.innerHTML = GRID_ICON + '<span>全部</span>';
    bar.appendChild(all);
  }
  app.appendChild(bar);

  // 「全部」面板
  sheet = document.createElement('div');
  sheet.className = 'msheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', '全部功能');
  const grouped = new Set(GROUPS.flatMap(([, ks]) => ks));
  const groups = GROUPS.map(([name, ks]) => [name, ks.filter((k) => byKey.has(k))]);
  const rest = [...byKey.keys()].filter((k) => !grouped.has(k));   // 以后新加的页面先放进「更多」
  groups[groups.length - 1][1].push(...rest);
  const grid = groups.filter(([, ks]) => ks.length).map(([name, ks]) =>
    `<div class="msheet-group"><h4 class="msheet-gtitle">${name}</h4><div class="msheet-grid">${ks.map((k) => copyOf(byKey.get(k), 'msheet-item').outerHTML).join('')}</div></div>`).join('');
  const act = (id, icon, label) => `<button type="button" class="msheet-act" data-mnav-act="${id}">${icon}<span>${label}</span></button>`;
  const svg = (id) => [...(document.getElementById(id)?.querySelectorAll('svg') || [])].map((x) => x.outerHTML).join('');   // 主题按钮有月亮 / 太阳两个图标，按主题显示一个
  sheet.innerHTML = `<div class="msheet-backdrop" data-mnav-close></div>
    <div class="msheet-panel"><div class="msheet-grab" data-mnav-close></div>
      ${grid}
      <div class="msheet-acts">
        ${act('langToggle', '<b class="msheet-lang notranslate" translate="no"></b>', '语言')}
        ${act('themeToggle', svg('themeToggle'), '切换主题')}
        ${act('prefsBtn', svg('prefsBtn'), '个性化设置')}
        ${act('contactBtn', svg('contactBtn'), '联系作者')}
        ${act('api', document.querySelector('.api-link svg')?.outerHTML || '', 'API 文档')}
        ${act('desktopDlBtn', svg('desktopDlBtn'), document.querySelector('#desktopDlBtn .dl-label')?.textContent || '下载 App')}
      </div></div>`;
  document.body.appendChild(sheet);

  const go = (k) => byKey.get(k)?.click();
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mnav], [data-mnav-all]');
    if (!t) return;
    if (t.dataset.mnavAll != null) openSheet();
    else go(t.dataset.mnav);
  });
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-mnav-close]')) { closeSheet(); return; }
    const t = e.target.closest('[data-mnav]');
    if (t) { closeSheet(); go(t.dataset.mnav); return; }
    const a = e.target.closest('[data-mnav-act]');
    if (!a) return;
    const id = a.dataset.mnavAct;
    if (id === 'api') { closeSheet(); window.open(document.querySelector('.api-link').href, '_blank', 'noopener'); return; }
    if (id !== 'themeToggle') closeSheet();   // 切换主题后留在面板里，马上能看到效果
    document.getElementById(id)?.click();
    paintLang();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) { e.stopImmediatePropagation(); closeSheet(); } }, true);

  // 弹出键盘时隐藏底部标签栏（手机浏览器会把标签栏顶到键盘上面，挡住输入框附近的内容）
  const typing = (el) => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]):not([type=color]), textarea, [contenteditable="true"]');
  document.addEventListener('focusin', (e) => { if (typing(e.target)) document.documentElement.classList.add('m-typing'); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!typing(document.activeElement)) document.documentElement.classList.remove('m-typing'); }, 80));

  // 页面重新渲染后再找一遍和顶栏同名的大标题
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; markDupTitles(); }); })
    .observe(document.querySelector('.app-body') || document.body, { childList: true, subtree: true });
  syncMobileNav();
}

// 记下每条历史在本站里的深度，用来判断「‹」返回能不能显示
function trackDepth() {
  const read = () => (typeof history.state?.mDepth === 'number' ? history.state.mDepth : null);
  depth = read() ?? 0;
  const plain = (st) => st == null || (typeof st === 'object' && !Array.isArray(st));
  const push = history.pushState, replace = history.replaceState;
  history.pushState = function (st, t, url) {
    const d = (read() ?? depth) + 1;
    if (plain(st)) { st = { ...(st || {}), mDepth: d }; depth = d; }
    const r = push.call(history, st, t, url);
    paintBack();
    return r;
  };
  history.replaceState = function (st, t, url) {
    if (plain(st)) st = { ...(st || {}), mDepth: read() ?? depth };
    const r = replace.call(history, st, t, url);
    paintBack();
    return r;
  };
  window.addEventListener('popstate', () => { depth = read() ?? 0; requestAnimationFrame(paintBack); });
}

// 当前是不是二级页面：标签栏一级页面之外的功能页；市场的物品详情 / 倒卖排行 / 自选看板；击杀的详情、战报、排行等
function isSub() {
  const h = location.hash;
  if (curKey === 'market') return /^#(type=|watch)/.test(h);
  if (curKey === 'kb') return h.startsWith('#kb/');
  return Boolean(curKey) && !ROOTS.has(curKey);
}
function paintBack() {
  if (!back) return;
  const show = depth > 0 && isSub();
  if (back.hidden === show) back.hidden = !show;
}

// 页面里和顶栏同名的大标题（各页 .pi-head / .ap-head / .sim-head-main 里的 h2）：手机上顶栏已经写了页名，不再重复
const DUP_SEL = '.pi-head > h2, .ap-head > h2, .sim-head-main > h2';
function markDupTitles() {
  if (!title) return;
  const t = title.textContent.trim();
  document.querySelectorAll(DUP_SEL).forEach((h) => {
    const dup = Boolean(t) && h.textContent.trim() === t;
    if (h.classList.contains('m-dup') !== dup) h.classList.toggle('m-dup', dup);
  });
}

function paintLang() {
  const el = sheet?.querySelector('.msheet-lang');
  if (el) el.textContent = document.getElementById('langToggle')?.textContent.trim() || 'EN';
}
function openSheet() {
  paintLang();
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet() {
  sheet.classList.remove('open');
  setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 200);
}

// 当前页高亮（modern-app.js 的 syncNavActive 每次切换后调用）
export function syncMobileNav() {
  if (!bar) return;
  const active = navBtns().find((b) => b.classList.contains('active'));
  const k = active ? keyOf(active) : '';
  // 顶栏入口被隐藏的（如只有一个交易中心的服务器没有倒卖排行），这里也隐藏
  document.querySelectorAll('.mtab[data-mnav], .msheet-item').forEach((b) => { b.hidden = Boolean(byKey.get(b.dataset.mnav)?.hidden); });
  bar.querySelectorAll('[data-mnav]').forEach((b) => b.classList.toggle('active', b.dataset.mnav === k));
  bar.querySelector('[data-mnav-all]').classList.toggle('active', Boolean(k) && !TABS.includes(k));
  sheet.querySelectorAll('[data-mnav]').forEach((b) => b.classList.toggle('active', b.dataset.mnav === k));
  title.textContent = active?.querySelector('span')?.textContent || '';
  curKey = k;
  paintBack();
  document.getElementById('sidebar')?.classList.toggle('m-search', k === 'market');
  // 侧栏按钮：市场页是物品目录（搜索），其他页是筛选 / 导航
  const menu = document.getElementById('menuToggle');
  const ico = k === 'market' ? 'search' : 'filter';
  if (menu && menu.dataset.mico !== ico) { menu.dataset.mico = ico; menu.innerHTML = ico === 'search' ? ICON_SEARCH : ICON_FILTER; }
  markDupTitles();
}
