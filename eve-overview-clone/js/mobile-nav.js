// ===== 手机导航（≤768px）=====
// 顶栏的功能入口在手机上放不下（19 个），改成：
//   底部标签栏：市场中心、倒卖排行、星图、击杀 + 「全部」；当前页不在这四个里时「全部」高亮。
//   「全部」弹出底部面板：全部功能宫格，以及顶栏收起的语言、主题、API 文档、定制按钮。
//   顶栏只留 ☰（当前页侧栏）、当前页名称、服务器、购物车、预警（隐藏规则在 CSS 的 768px 断点里）。
// 所有按钮都转发点击给顶栏原来的按钮，切换逻辑、高亮都沿用 modern-app.js（syncNavActive 调 syncMobileNav）。

const TABS = ['market', 'arb', 'map', 'kb'];
const keyOf = (btn) => (btn.hasAttribute('data-arb') ? 'arb' : btn.dataset.view);
const navBtns = () => [...document.querySelectorAll('.header-nav .nav-btn')].filter((b) => !b.hidden);
const GRID_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

let bar = null, sheet = null, title = null;
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

  // 底部标签栏
  bar = document.createElement('nav');
  bar.className = 'mobile-tabbar';
  bar.setAttribute('aria-label', '主导航');
  for (const k of TABS) if (byKey.has(k)) bar.appendChild(copyOf(byKey.get(k), 'mtab'));
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'mtab';
  all.dataset.mnavAll = '';
  all.setAttribute('aria-haspopup', 'dialog');
  all.innerHTML = GRID_ICON + '<span>全部</span>';
  bar.appendChild(all);
  app.appendChild(bar);

  // 「全部」面板
  sheet = document.createElement('div');
  sheet.className = 'msheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', '全部功能');
  const grid = btns.map((b) => copyOf(b, 'msheet-item').outerHTML).join('');
  const act = (id, icon, label) => `<button type="button" class="msheet-act" data-mnav-act="${id}">${icon}<span>${label}</span></button>`;
  const svg = (id) => [...(document.getElementById(id)?.querySelectorAll('svg') || [])].map((x) => x.outerHTML).join('');   // 主题按钮有月亮 / 太阳两个图标，按主题显示一个
  sheet.innerHTML = `<div class="msheet-backdrop" data-mnav-close></div>
    <div class="msheet-panel"><div class="msheet-grab" data-mnav-close></div>
      <div class="msheet-grid">${grid}</div>
      <div class="msheet-acts">
        ${act('langToggle', '<b class="msheet-lang notranslate" translate="no"></b>', '语言')}
        ${act('themeToggle', svg('themeToggle'), '切换主题')}
        ${act('contactBtn', svg('contactBtn'), '联系作者')}
        ${act('api', document.querySelector('.api-link svg')?.outerHTML || '', 'API 文档')}
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
  syncMobileNav();
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
}
