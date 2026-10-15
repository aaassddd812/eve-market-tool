// ===== 配置与常量 =====
const API_BASE = 'https://esi.evetech.net/latest';
const IMAGE_BASE = 'https://images.evetech.net/types';

// 星域名称取自 ESI /universe/regions/{id}/?language=zh；hub 为该星域主要交易中心空间站
const REGIONS = [
  { id: 10000002, name: '伏尔戈', en: 'The Forge', hub: { id: 60003760, name: '吉他 4-4' } },
  { id: 10000043, name: '多美', en: 'Domain', hub: { id: 60008494, name: '艾玛 VIII' } },
  { id: 10000032, name: '金纳泽', en: 'Sinq Laison', hub: { id: 60011866, name: '多迪谢 IX' } },
  { id: 10000030, name: '西玛特尔', en: 'Heimatar', hub: { id: 60004588, name: '伦斯 VI' } },
  { id: 10000042, name: '美特伯里斯', en: 'Metropolis', hub: { id: 60005686, name: '赫克 VIII' } }
];

// 空状态里的常用物品：PLEX、基础矿物、技能注入器
const QUICK_PICK_IDS = [44992, 34, 35, 36, 37, 38, 39, 40, 40520, 40519];
const ORDER_ROW_LIMIT = 100;
const RECENT_LIMIT = 30;
const MOBILE_QUERY = window.matchMedia('(max-width: 768px)');

// ===== 本地存储（隐私模式下可能抛错，统一兜底）=====
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
  },
  getJSON(key, fallback) {
    try { return JSON.parse(this.get(key)) ?? fallback; } catch { return fallback; }
  },
  setJSON(key, value) {
    this.set(key, JSON.stringify(value));
  }
};

// ===== 应用状态 =====
const state = {
  theme: document.documentElement.getAttribute('data-theme') || 'dark',
  currentView: 'market',
  selectedItem: null,
  regionId: REGIONS.some((r) => r.id === Number(store.get('eve-region'))) ? Number(store.get('eve-region')) : 10000002,
  catalog: null,
  categories: new Map(),
  childGroups: new Map(),   // parentId -> 子分类数组（已排序）
  typeIndex: new Map(),     // typeId -> { type, groupId }
  searchQuery: '',
  orders: [],
  history: [],
  priceData: null,
  locationCache: new Map(),
  esiToken: null,
  characterData: null,
  marketPriceMap: null,
  marketPricePromise: null,
  catalogReady: null,
  favorites: store.getJSON('eve-favorites', []),
  recent: store.getJSON('eve-recent', []),
  orderSort: {
    sell: { key: 'price', dir: 'asc' },
    buy: { key: 'price', dir: 'desc' }
  },
  hubOnly: store.get('eve-hub-only') === '1',
  chartDays: Number(store.get('eve-chart-days')) || 30,
  contentTab: store.get('eve-content-tab') || 'orders',
  loadSeq: 0,
  loadController: null
};

// ===== 工具函数 =====
const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function formatISK(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const num = parseFloat(value);
  const abs = Math.abs(num);
  if (abs >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 订单簿里的价格需要精确到分，交易时要直接粘贴进游戏
function formatPrice(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 统计卡片：百万以下保留两位小数便于比价，更大的数缩写
function formatStatPrice(value) {
  return Math.abs(value) < 1e6 ? formatPrice(value) : formatISK(value);
}

function formatNumber(value, decimals = 0) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: decimals });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function formatFullDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatTime(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(dateStr);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  star: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  chevron: '<svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'
};

// 第二个参数兼容旧调用 showToast(msg, 4000)
function showToast(message, kindOrDuration = 'info', duration = 2600) {
  let kind = kindOrDuration;
  if (typeof kindOrDuration === 'number') { duration = kindOrDuration; kind = 'info'; }
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = (ICONS[kind] || ICONS.info) + '<span></span>';
  el.querySelector('span').textContent = message;
  stack.appendChild(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(String(text));
    showToast(label + '：' + text, 'success', 1800);
  } catch {
    showToast('浏览器阻止了复制，请手动复制', 'error');
  }
}

async function fetchESI(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { 'Accept-Language': 'zh', ...options.headers }
  });
  if (!response.ok) throw new Error(`ESI ${response.status}`);
  return response.json();
}

// 市场订单接口分页（X-Pages），热门物品在大星域可能超过一页
async function fetchESIPaged(endpoint, options = {}) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const first = await fetch(`${API_BASE}${endpoint}${sep}page=1`, options);
  if (!first.ok) throw new Error(`ESI ${first.status}`);
  const pages = Math.min(Number(first.headers.get('X-Pages')) || 1, 20);
  const results = [await first.json()];
  if (pages > 1) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) =>
      fetchESI(`${endpoint}${sep}page=${i + 2}`, options)));
    results.push(...rest);
  }
  return results.flat();
}

// ===== 服务器状态 =====
async function loadServerStatus() {
  const el = $('serverStatus');
  try {
    const data = await fetchESI('/status/');
    el.classList.remove('offline');
    $('serverStatusText').textContent = '宁静 · ' + formatNumber(data.players) + ' 在线';
    el.title = '宁静服务器在线，开服时间 ' + new Date(data.start_time).toLocaleString('zh-CN', { hour12: false });
  } catch {
    el.classList.add('offline');
    $('serverStatusText').textContent = '宁静 · 无法连接';
    el.title = 'ESI 状态接口暂不可用';
  }
}

// ===== 主题切换 =====
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (priceChartInstance) renderChart();
}

function initTheme() {
  $('themeToggle').addEventListener('click', () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    store.set('eve-theme', next);
    applyTheme(next);
  });
}

// ===== 视图切换 =====
function initNavigation() {
  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
}

function switchView(view) {
  state.currentView = view;
  $$('.nav-btn').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $('marketView').hidden = view !== 'market';
  $('profileView').hidden = view !== 'profile';
  $('menuToggle').hidden = view !== 'market';
  closeDrawer();
  if (view === 'profile') loadProfile();
}

// ===== 侧边栏（桌面：可收起；移动端：抽屉）=====
function setSidebarCollapsed(sidebarId, reopenId, collapsed, storageKey) {
  $(sidebarId).classList.toggle('collapsed', collapsed);
  $(reopenId).hidden = !collapsed;
  if (storageKey) store.set(storageKey, collapsed ? '1' : '0');
}

function openDrawer() {
  $('sidebar').classList.add('drawer-open');
  $('sidebarBackdrop').hidden = false;
  setTimeout(() => $('itemSearch').focus(), 50);
}

function closeDrawer() {
  $('sidebar').classList.remove('drawer-open');
  $('sidebarBackdrop').hidden = true;
}

function toggleMarketSidebar() {
  if (MOBILE_QUERY.matches) {
    if ($('sidebar').classList.contains('drawer-open')) closeDrawer(); else openDrawer();
    return;
  }
  const collapsed = !$('sidebar').classList.contains('collapsed');
  setSidebarCollapsed('sidebar', 'sidebarReopen', collapsed, 'eve-sidebar-collapsed');
}

function initSidebar() {
  if (store.get('eve-sidebar-collapsed') === '1') setSidebarCollapsed('sidebar', 'sidebarReopen', true);
  if (store.get('eve-profile-sidebar-collapsed') === '1') setSidebarCollapsed('profileSidebar', 'profileSidebarReopen', true);

  $('sidebarCollapse').addEventListener('click', toggleMarketSidebar);
  $('sidebarReopen').addEventListener('click', toggleMarketSidebar);
  $('menuToggle').addEventListener('click', toggleMarketSidebar);
  $('sidebarBackdrop').addEventListener('click', closeDrawer);
  MOBILE_QUERY.addEventListener('change', closeDrawer);

  $('profileSidebarCollapse').addEventListener('click', () =>
    setSidebarCollapsed('profileSidebar', 'profileSidebarReopen', true, 'eve-profile-sidebar-collapsed'));
  $('profileSidebarReopen').addEventListener('click', () =>
    setSidebarCollapsed('profileSidebar', 'profileSidebarReopen', false, 'eve-profile-sidebar-collapsed'));

  $('profileNav').addEventListener('click', (event) => {
    const station = event.target.closest('[data-station-index]');
    const link = event.target.closest('[data-profile]');
    if (!link) return;
    switchProfileTab(link.dataset.profile, station?.dataset.stationIndex);
    if (station) {
      requestAnimationFrame(() => {
        const target = document.querySelector('.asset-group-row[data-station-index="' + station.dataset.stationIndex + '"]');
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
  });

  // 搜索
  const searchInput = $('itemSearch');
  const runSearch = debounce(() => {
    state.searchQuery = searchInput.value.trim();
    if (state.searchQuery) switchSidebarTab('catalog');
    renderCatalog();
  }, 150);
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        state.searchQuery = '';
        renderCatalog();
      } else {
        searchInput.blur();
        closeDrawer();
      }
      event.preventDefault();
    } else if (event.key === 'ArrowDown') {
      $('catalogTree').querySelector('.item-btn, .category-header')?.focus();
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const first = $('catalogTree').querySelector('.item-btn');
      if (first && state.searchQuery) first.click();
      event.preventDefault();
    }
  });

  // 侧栏标签
  $$('.sidebar-tabs .tab-btn').forEach((btn) => btn.addEventListener('click', () => switchSidebarTab(btn.dataset.tab)));

  $('collapseAllBtn').addEventListener('click', () => {
    $('catalogTree').querySelectorAll('.category.expanded').forEach((el) => setCategoryExpanded(el, false));
  });

  // 目录树、收藏、最近：统一事件委托
  $('catalogTree').addEventListener('click', onListClick);
  $('favoritesList').addEventListener('click', onListClick);
  $('recentList').addEventListener('click', onListClick);
  $('quickPicks').addEventListener('click', onListClick);
  $('catalogTree').addEventListener('keydown', onTreeKeydown);
}

function switchSidebarTab(tab) {
  $$('.sidebar-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.sidebar-content .tab-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `${tab}Pane`));
  $('catalogToolbar').hidden = tab !== 'catalog';
  if (tab === 'favorites') renderFavorites();
  if (tab === 'recent') renderRecent();
}

function onListClick(event) {
  const remove = event.target.closest('[data-unfav]');
  if (remove) {
    event.stopPropagation();
    toggleFavorite(Number(remove.dataset.unfav));
    return;
  }
  const header = event.target.closest('.category-header');
  if (header) {
    const category = header.parentElement;
    setCategoryExpanded(category, !category.classList.contains('expanded'));
    return;
  }
  const item = event.target.closest('[data-type-id]');
  if (item) {
    selectItem(Number(item.dataset.typeId));
    if (MOBILE_QUERY.matches) closeDrawer();
  }
}

// 目录树键盘导航：↑↓ 在可见项间移动，→ 展开，← 收起/回到父级
function onTreeKeydown(event) {
  const current = event.target.closest('.item-btn, .category-header');
  if (!current) return;
  const visible = [...$('catalogTree').querySelectorAll('.item-btn, .category-header')].filter((el) => el.offsetParent !== null);
  const index = visible.indexOf(current);
  const isHeader = current.classList.contains('category-header');
  const category = isHeader ? current.parentElement : null;
  switch (event.key) {
    case 'ArrowDown': visible[index + 1]?.focus(); break;
    case 'ArrowUp':
      if (index === 0) $('itemSearch').focus(); else visible[index - 1]?.focus();
      break;
    case 'ArrowRight':
      if (category && !category.classList.contains('expanded')) setCategoryExpanded(category, true);
      else visible[index + 1]?.focus();
      break;
    case 'ArrowLeft':
      if (category?.classList.contains('expanded')) setCategoryExpanded(category, false);
      else current.closest('.category-items')?.parentElement.querySelector(':scope > .category-header')?.focus();
      break;
    default: return;
  }
  event.preventDefault();
}

// ===== 目录加载 =====
async function loadCatalog() {
  try {
    const response = await fetch('./catalog.json?v=v2r7');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    state.catalog = await response.json();
    buildCatalogIndex();
    renderCatalog();
    renderQuickPicks();
    renderFavorites();
    renderRecent();
    $('catalogHint').textContent = `${state.catalog.groups.length.toLocaleString()} 个分类 · ${state.typeIndex.size.toLocaleString()} 个物品`;
  } catch (error) {
    console.error('加载目录失败:', error);
    $('catalogHint').textContent = '目录加载失败';
    $('catalogTree').innerHTML = '<div class="empty-state"><p>目录加载失败：' + esc(error.message) + '</p><button class="btn" id="retryCatalog">重试</button></div>';
    $('retryCatalog').addEventListener('click', () => {
      $('catalogTree').innerHTML = '<div class="skeleton-list"><i></i><i></i><i></i><i></i></div>';
      loadCatalog();
    });
  }
}

// 一次性建立父子关系与物品索引，避免渲染时对 2000+ 分类反复 filter
function buildCatalogIndex() {
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
  state.catalog.groups.forEach((group) => {
    state.categories.set(group.id, group);
    const parent = group.parentId || 0;
    if (!state.childGroups.has(parent)) state.childGroups.set(parent, []);
    state.childGroups.get(parent).push(group);
    group.types.forEach((type) => state.typeIndex.set(type.id, { type, groupId: group.id }));
  });
  state.childGroups.forEach((list) => list.sort(byName));
  // 递归统计每个分类（含子分类）下的物品总数
  const countOf = (group) => {
    if (group.total !== undefined) return group.total;
    group.total = group.types.length + (state.childGroups.get(group.id) || []).reduce((sum, child) => sum + countOf(child), 0);
    return group.total;
  };
  state.catalog.groups.forEach(countOf);
}

function renderCatalog() {
  const container = $('catalogTree');
  if (!state.catalog) return;
  if (state.searchQuery) {
    renderSearchResults(container);
    return;
  }
  const roots = state.childGroups.get(0) || [];
  container.innerHTML = roots.map((group) => renderCategoryShell(group)).join('') || '<div class="empty-state"><p>暂无分类数据</p></div>';
  if (state.selectedItem) revealInTree(state.selectedItem.id, false);
}

// 只渲染分类外壳，子节点在展开时才生成，首屏 DOM 从上万节点降到十几个
function renderCategoryShell(group) {
  if (!group.total) return '';
  return `<div class="category" data-id="${group.id}" role="treeitem" aria-expanded="false">
      <button class="category-header" type="button">
        ${ICONS.chevron}
        <span class="category-name">${esc(group.name)}</span>
        <span class="category-count">${group.total}</span>
      </button>
      <div class="category-items" role="group"></div>
    </div>`;
}

function setCategoryExpanded(category, expanded) {
  const items = category.querySelector(':scope > .category-items');
  if (expanded && !items.dataset.rendered) {
    const group = state.categories.get(Number(category.dataset.id));
    const children = state.childGroups.get(group.id) || [];
    items.innerHTML = children.map(renderCategoryShell).join('') +
      [...group.types].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((type) => renderItem(type)).join('');
    items.dataset.rendered = '1';
  }
  category.classList.toggle('expanded', expanded);
  category.setAttribute('aria-expanded', String(expanded));
}

function renderItem(type, extra = '') {
  const active = state.selectedItem?.id === type.id ? ' active' : '';
  return `<button class="item-btn${active}" type="button" data-type-id="${type.id}" title="${esc(type.name)} · Type ${type.id}">
      <span class="item-name">${extra || esc(type.name)}</span>
    </button>`;
}

// 展开目录树中物品所在的分类路径并滚动到可见
function revealInTree(typeId, scroll = true) {
  if (state.searchQuery) return;
  const entry = state.typeIndex.get(typeId);
  if (!entry) return;
  const chain = [];
  let group = state.categories.get(entry.groupId);
  while (group) {
    chain.unshift(group.id);
    group = group.parentId ? state.categories.get(group.parentId) : null;
  }
  let scope = $('catalogTree');
  for (const id of chain) {
    const category = scope.querySelector(`:scope > .category[data-id="${id}"], :scope > .category-items > .category[data-id="${id}"]`);
    if (!category) return;
    setCategoryExpanded(category, true);
    scope = category.querySelector(':scope > .category-items');
  }
  const btn = scope.querySelector(`:scope > .item-btn[data-type-id="${typeId}"]`);
  if (btn) {
    btn.classList.add('active');
    if (scroll) btn.scrollIntoView({ block: 'nearest' });
  }
}

function highlight(text, query) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query);
  if (at < 0 || !query) return esc(text);
  return esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + query.length)) + '</mark>' + esc(text.slice(at + query.length));
}

function renderSearchResults(container) {
  const query = state.searchQuery.toLowerCase();
  const idQuery = /^\d+$/.test(query) ? Number(query) : null;
  const results = [];
  state.catalog.groups.forEach((group) => {
    const groupHit = group.name.toLowerCase().includes(query);
    group.types.forEach((type) => {
      const name = type.name.toLowerCase();
      let score = -1;
      if (idQuery !== null && type.id === idQuery) score = 0;
      else if (name === query) score = 1;
      else if (name.startsWith(query)) score = 2;
      else if (name.includes(query)) score = 3;
      else if (groupHit) score = 4;
      if (score >= 0) results.push({ type, group, score });
    });
  });

  if (!results.length) {
    container.innerHTML = '<div class="empty-state"><p>未找到 “' + esc(state.searchQuery) + '”</p><p class="hint">试试更短的关键词或输入 Type ID</p></div>';
    return;
  }
  results.sort((a, b) => a.score - b.score || a.type.name.length - b.type.name.length || a.type.name.localeCompare(b.type.name, 'zh-CN'));
  const limit = 200;
  container.innerHTML = `<div class="search-summary">找到 ${results.length.toLocaleString()} 项${results.length > limit ? `，显示前 ${limit} 项` : ''}</div>` +
    results.slice(0, limit).map(({ type, group }) => {
      const active = state.selectedItem?.id === type.id ? ' active' : '';
      return `<button class="item-btn search-hit${active}" type="button" data-type-id="${type.id}" title="${esc(type.name)} · Type ${type.id}">
          <img src="${IMAGE_BASE}/${type.id}/icon?size=32" alt="" loading="lazy" width="24" height="24">
          <span class="hit-text">
            <span class="item-name">${highlight(type.name, query)}</span>
            <span class="item-sub">${highlight(group.name, query)}</span>
          </span>
        </button>`;
    }).join('');
}

// ===== 收藏 / 最近浏览 =====
function isFavorite(typeId) {
  return state.favorites.includes(typeId);
}

function toggleFavorite(typeId) {
  if (isFavorite(typeId)) {
    state.favorites = state.favorites.filter((id) => id !== typeId);
    showToast('已取消收藏', 'info', 1500);
  } else {
    state.favorites = [typeId, ...state.favorites];
    showToast('已加入收藏', 'success', 1500);
  }
  store.setJSON('eve-favorites', state.favorites);
  renderFavorites();
  renderQuickPicks();
  updateFavButton();
}

function updateFavButton() {
  const btn = $('favToggle');
  const on = state.selectedItem ? isFavorite(state.selectedItem.id) : false;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? '取消收藏 (F)' : '加入收藏 (F)';
}

function miniItem(typeId, { removable = false } = {}) {
  const entry = state.typeIndex.get(typeId);
  if (!entry) return '';
  const group = state.categories.get(entry.groupId);
  const active = state.selectedItem?.id === typeId ? ' active' : '';
  return `<div class="mini-item${active}" data-type-id="${typeId}" role="button" tabindex="0">
      <img src="${IMAGE_BASE}/${typeId}/icon?size=32" alt="" loading="lazy" width="28" height="28">
      <span class="hit-text">
        <span class="item-name">${esc(entry.type.name)}</span>
        <span class="item-sub">${esc(group?.name || '')}</span>
      </span>
      ${removable ? `<button class="mini-remove" data-unfav="${typeId}" title="取消收藏" aria-label="取消收藏">${ICONS.close}</button>` : ''}
    </div>`;
}

function renderFavorites() {
  const count = state.favorites.length;
  $('favCount').hidden = !count;
  $('favCount').textContent = count;
  if (!state.catalog) return;
  $('favoritesList').innerHTML = count
    ? state.favorites.map((id) => miniItem(id, { removable: true })).join('')
    : `<div class="empty-state">${ICONS.star}<p>暂无收藏物品</p><p class="hint">在物品详情中点击 ☆ 或按 F 收藏</p></div>`;
}

function renderRecent() {
  if (!state.catalog) return;
  $('recentList').innerHTML = state.recent.length
    ? state.recent.map((id) => miniItem(id)).join('') + '<button class="link-btn clear-recent" id="clearRecent">清空最近浏览</button>'
    : '<div class="empty-state"><p>还没有浏览记录</p></div>';
  $('clearRecent')?.addEventListener('click', () => {
    state.recent = [];
    store.setJSON('eve-recent', []);
    renderRecent();
  });
}

function pushRecent(typeId) {
  state.recent = [typeId, ...state.recent.filter((id) => id !== typeId)].slice(0, RECENT_LIMIT);
  store.setJSON('eve-recent', state.recent);
  if ($('recentPane').classList.contains('active')) renderRecent();
}

function renderQuickPicks() {
  if (!state.catalog) return;
  const ids = [...new Set([...state.favorites.slice(0, 6), ...QUICK_PICK_IDS])].filter((id) => state.typeIndex.has(id)).slice(0, 12);
  $('quickPicks').innerHTML = ids.length
    ? '<div class="quick-title">常用物品</div><div class="quick-grid">' + ids.map((id) => {
      const { type } = state.typeIndex.get(id);
      return `<button class="quick-chip" data-type-id="${id}" title="Type ${id}"><img src="${IMAGE_BASE}/${id}/icon?size=32" alt="" width="20" height="20" loading="lazy">${esc(type.name)}</button>`;
    }).join('') + '</div>'
    : '';
}

// ===== 物品详情 =====
function setDetailVisible(visible) {
  $('emptyView').hidden = visible;
  $('detailView').hidden = !visible;
}

function renderBreadcrumb(groupId) {
  const parts = [];
  let group = state.categories.get(groupId);
  while (group) {
    parts.unshift(group);
    group = group.parentId ? state.categories.get(group.parentId) : null;
  }
  $('itemBreadcrumb').innerHTML = parts.map((g) => `<span>${esc(g.name)}</span>`).join('<span class="sep">›</span>');
}

async function selectItem(typeId, { updateHash = true } = {}) {
  const entry = state.typeIndex.get(typeId);
  if (!entry) return;
  const category = state.categories.get(entry.groupId);
  const same = state.selectedItem?.id === typeId;
  state.selectedItem = { ...entry.type, categoryId: entry.groupId, categoryName: category.name };

  $$('[data-type-id].active').forEach((el) => el.classList.remove('active'));
  $$(`[data-type-id="${typeId}"]`).forEach((el) => el.classList.add('active'));
  revealInTree(typeId);

  setDetailVisible(true);
  const icon = $('itemIcon');
  icon.classList.remove('broken');
  icon.src = `${IMAGE_BASE}/${typeId}/icon?size=64`;
  icon.alt = entry.type.name;
  $('itemName').textContent = entry.type.name;
  $('itemTypeId').textContent = `Type ${typeId}`;
  document.title = `${entry.type.name} · EVE 市场总览`;
  renderBreadcrumb(entry.groupId);
  updateFavButton();
  pushRecent(typeId);

  if (updateHash) {
    const hash = `#type=${typeId}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
  }
  if (!same) $('mainContent').scrollTo({ top: 0 });
  await loadMarketData(typeId);
}

function setLoading(loading) {
  $('detailView').classList.toggle('is-loading', loading);
  const btn = $('refreshBtn');
  btn.disabled = loading;
  btn.classList.toggle('spinning', loading);
}

async function loadMarketData(typeId) {
  // 快速切换物品时取消上一轮请求，并丢弃过期结果
  state.loadController?.abort();
  const controller = new AbortController();
  state.loadController = controller;
  const seq = ++state.loadSeq;
  const regionId = state.regionId;
  setLoading(true);
  $('updateTag').textContent = '更新中…';

  try {
    const [orders, history] = await Promise.all([
      fetchESIPaged(`/markets/${regionId}/orders/?order_type=all&type_id=${typeId}`, { signal: controller.signal }),
      fetchESI(`/markets/${regionId}/history/?type_id=${typeId}`, { signal: controller.signal }).catch((error) => {
        if (error.name === 'AbortError') throw error;
        return []; // 部分物品没有历史数据会返回 404
      })
    ]);
    if (seq !== state.loadSeq) return;

    state.orders = orders || [];
    state.history = (history || []).sort((a, b) => new Date(b.date) - new Date(a.date));

    renderStats();
    renderOrders();
    renderHistory();
    if (state.contentTab === 'chart') renderChart();
    $('updateTag').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLoading(false);

    // 地点名称与全服均价不阻塞首屏渲染
    resolveLocations(state.orders).then(() => { if (seq === state.loadSeq) renderOrders(); });
    getMarketPriceMap().then(() => { if (seq === state.loadSeq) renderAvgPrice(typeId); });
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.loadSeq) return;
    console.error('加载市场数据失败:', error);
    setLoading(false);
    $('updateTag').textContent = '加载失败';
    showToast('数据加载失败：' + error.message, 'error', 4000);
    state.orders = [];
    state.history = [];
    renderStats();
    renderOrders('加载失败，点击右上角刷新重试');
    renderHistory();
  }
}

async function resolveLocations(orders) {
  const ids = [...new Set(orders.map((o) => o.location_id))].filter((id) => id && !state.locationCache.has(id));
  ids.filter((id) => id >= 1e12).forEach((id) => state.locationCache.set(id, '玩家建筑 #' + id));
  const npc = ids.filter((id) => id < 1e12);
  for (let i = 0; i < npc.length; i += 500) {
    try {
      const names = await fetchESI('/universe/names/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(npc.slice(i, i + 500))
      });
      names.forEach((loc) => state.locationCache.set(loc.id, loc.name));
    } catch (error) {
      console.error('解析位置失败:', error);
    }
  }
}

function currentRegion() {
  return REGIONS.find((r) => r.id === state.regionId) || REGIONS[0];
}

function sideOrders(isBuy) {
  const hubId = currentRegion().hub.id;
  return state.orders.filter((o) => o.is_buy_order === isBuy && (!state.hubOnly || o.location_id === hubId));
}

function setStat(id, text, metaId, meta) {
  $(id).textContent = text;
  if (metaId) $(metaId).textContent = meta;
}

function renderStats() {
  const sells = sideOrders(false);
  const buys = sideOrders(true);
  const minSell = sells.length ? Math.min(...sells.map((o) => o.price)) : null;
  const maxBuy = buys.length ? Math.max(...buys.map((o) => o.price)) : null;
  const sum = (list) => list.reduce((s, o) => s + o.volume_remain, 0);
  state.bestPrices = { sell: minSell, buy: maxBuy };

  setStat('minSellPrice', minSell === null ? '—' : formatStatPrice(minSell), 'minSellMeta', sells.length ? `${sells.length} 单 · 共 ${formatISK(sum(sells))} 件` : '无卖单');
  setStat('maxBuyPrice', maxBuy === null ? '—' : formatStatPrice(maxBuy), 'maxBuyMeta', buys.length ? `${buys.length} 单 · 共 ${formatISK(sum(buys))} 件` : '无买单');
  $('minSellCard').title = minSell === null ? '' : `${formatPrice(minSell)} ISK · 点击复制`;
  $('maxBuyCard').title = maxBuy === null ? '' : `${formatPrice(maxBuy)} ISK · 点击复制`;

  if (minSell !== null && maxBuy !== null) {
    const spread = minSell - maxBuy;
    setStat('spreadValue', formatStatPrice(spread), 'spreadMeta', `${((spread / maxBuy) * 100).toFixed(2)}%${spread < 0 ? ' · 买卖倒挂' : ''}`);
  } else {
    setStat('spreadValue', '—', 'spreadMeta', '数据不足');
  }

  const recent = state.history.slice(0, 30);
  if (recent.length) {
    const avgVolume = recent.reduce((s, d) => s + d.volume, 0) / recent.length;
    const prev = state.history.slice(30, 60);
    let trend = '';
    if (prev.length) {
      const prevAvg = prev.reduce((s, d) => s + d.average, 0) / prev.length;
      const curAvg = recent.reduce((s, d) => s + d.average, 0) / recent.length;
      const pct = ((curAvg - prevAvg) / prevAvg) * 100;
      trend = ` · 均价${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%`;
    }
    setStat('volumeValue', formatISK(avgVolume), 'volumeMeta', `近 ${recent.length} 天${trend}`);
  } else {
    setStat('volumeValue', '—', 'volumeMeta', '暂无成交记录');
  }
  renderAvgPrice(state.selectedItem?.id);
}

function renderAvgPrice(typeId) {
  const map = state.marketPriceMap;
  if (!(map instanceof Map)) { setStat('avgPrice', '…', 'avgMeta', '读取中'); return; }
  const price = map.get(Number(typeId));
  setStat('avgPrice', price ? formatStatPrice(price) : '—', 'avgMeta', price ? `${formatPrice(price)} ISK` : '无全服均价');
}

function sortOrders(list, side) {
  const { key, dir } = state.orderSort[side];
  const sign = dir === 'asc' ? 1 : -1;
  const value = (o) => key === 'total' ? o.price * o.volume_remain : key === 'issued' ? new Date(o.issued).getTime() : o[key];
  return [...list].sort((a, b) => (value(a) - value(b)) * sign);
}

function locationCell(order) {
  const name = state.locationCache.get(order.location_id);
  const isHub = order.location_id === currentRegion().hub.id;
  const label = name || '载入中…';
  return `<td class="loc" title="${esc(name || 'ID ' + order.location_id)}">${isHub ? '<span class="hub-badge">枢纽</span>' : ''}${esc(label)}</td>`;
}

// 买单范围：station / solar_system / region，或数字跳数
function rangeLabel(range) {
  if (/^\d+$/.test(String(range))) return range + ' 跳';
  return zhLabel(ORDER_RANGE_ZH, range, range);
}

function renderOrderTable(side, emptyText) {
  const isBuy = side === 'buy';
  const all = sideOrders(isBuy);
  const list = sortOrders(all, side).slice(0, ORDER_ROW_LIMIT);
  const best = state.bestPrices?.[side];
  $(isBuy ? 'buyCount' : 'sellCount').textContent = all.length;
  $(isBuy ? 'buySubtitle' : 'sellSubtitle').textContent = all.length > ORDER_ROW_LIMIT ? `显示前 ${ORDER_ROW_LIMIT} 单 · 点击行复制价格` : '点击行复制价格';
  const body = $(isBuy ? 'buyOrdersBody' : 'sellOrdersBody');
  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${emptyText || (state.hubOnly ? '交易中心无' + (isBuy ? '买单' : '卖单') : '无' + (isBuy ? '买单' : '卖单'))}</td></tr>`;
  } else {
    body.innerHTML = list.map((o) => `<tr data-price="${o.price}"${o.price === best ? ' class="best"' : ''}>
        <td class="num price">${formatPrice(o.price)}</td>
        <td class="num">${formatNumber(o.volume_remain)}</td>
        <td class="num muted">${formatISK(o.price * o.volume_remain)}</td>
        ${locationCell(o)}
        <td class="num muted col-date">${isBuy ? esc(rangeLabel(o.range)) : formatTime(o.issued)}</td>
      </tr>`).join('');
  }
  $$(`th.sortable[data-side="${side}"]`).forEach((th) => {
    const active = th.dataset.key === state.orderSort[side].key;
    th.classList.toggle('sorted', active);
    th.dataset.dir = active ? state.orderSort[side].dir : '';
    th.setAttribute('aria-sort', active ? (state.orderSort[side].dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function renderOrders(emptyText) {
  renderOrderTable('sell', emptyText);
  renderOrderTable('buy', emptyText);
}

function initOrderTables() {
  $$('th.sortable').forEach((th) => {
    th.tabIndex = 0;
    const sort = () => {
      const side = th.dataset.side;
      const cur = state.orderSort[side];
      if (cur.key === th.dataset.key) cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
      else state.orderSort[side] = { key: th.dataset.key, dir: th.dataset.key === 'price' && side === 'sell' ? 'asc' : 'desc' };
      renderOrderTable(side);
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
  });
  ['sellOrdersBody', 'buyOrdersBody'].forEach((id) => $(id).addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-price]');
    if (row) copyText(formatPrice(Number(row.dataset.price)).replace(/,/g, ''), '价格已复制');
  }));
  $('minSellCard').addEventListener('click', () => {
    if (state.bestPrices?.sell != null) copyText(state.bestPrices.sell.toFixed(2), '最低卖价已复制');
  });
  $('maxBuyCard').addEventListener('click', () => {
    if (state.bestPrices?.buy != null) copyText(state.bestPrices.buy.toFixed(2), '最高买价已复制');
  });

  const hub = $('hubOnly');
  hub.checked = state.hubOnly;
  hub.addEventListener('change', () => {
    state.hubOnly = hub.checked;
    store.set('eve-hub-only', state.hubOnly ? '1' : '0');
    renderStats();
    renderOrders();
  });
}

function historyWindow() {
  return state.history.slice(0, state.chartDays);
}

function renderHistory() {
  const rows = historyWindow();
  $('historyTableBody').innerHTML = rows.length
    ? rows.map((day, i) => {
      const prev = rows[i + 1];
      const dir = prev ? (day.average > prev.average ? 'up' : day.average < prev.average ? 'down' : '') : '';
      return `<tr>
          <td>${formatFullDate(day.date)}</td>
          <td class="num ${dir}">${formatPrice(day.average)}</td>
          <td class="num">${formatPrice(day.highest)}</td>
          <td class="num">${formatPrice(day.lowest)}</td>
          <td class="num">${formatNumber(day.volume)}</td>
          <td class="num">${formatNumber(day.order_count)}</td>
        </tr>`;
    }).join('')
    : '<tr class="empty-row"><td colspan="6">暂无历史数据</td></tr>';
}

// ===== 区域选择 =====
function updateHubLabel() {
  $('hubOnlyLabel').textContent = '仅' + currentRegion().hub.name;
}

function initRegionSelect() {
  const select = $('regionSelect');
  select.innerHTML = REGIONS.map((r) => `<option value="${r.id}">${r.name} · ${r.hub.name.split(' ')[0]}</option>`).join('');
  select.value = state.regionId;
  updateHubLabel();
  select.addEventListener('change', () => {
    state.regionId = Number(select.value);
    store.set('eve-region', state.regionId);
    updateHubLabel();
    if (state.selectedItem) loadMarketData(state.selectedItem.id);
  });
}

function refreshCurrent() {
  if (state.selectedItem && !$('refreshBtn').disabled) loadMarketData(state.selectedItem.id);
}

function initDetailActions() {
  $('refreshBtn').addEventListener('click', refreshCurrent);
  $('favToggle').addEventListener('click', () => state.selectedItem && toggleFavorite(state.selectedItem.id));
  $('itemTypeId').addEventListener('click', () => state.selectedItem && copyText(state.selectedItem.id, 'Type ID 已复制'));
  $('copyNameBtn').addEventListener('click', () => state.selectedItem && copyText(state.selectedItem.name, '名称已复制'));
  $('itemIcon').addEventListener('error', (e) => e.target.classList.add('broken'));
  // 部分物品（蓝图、技能等）没有图标，隐藏破图
  document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && e.target.closest('.search-hit, .mini-item, .quick-chip')) e.target.classList.add('broken');
  }, true);
}

// ===== 内容标签页 =====
function switchContentTab(content) {
  state.contentTab = content;
  store.set('eve-content-tab', content);
  $$('.tabs-header .tab-link').forEach((l) => {
    const active = l.dataset.content === content;
    l.classList.toggle('active', active);
    l.setAttribute('aria-selected', String(active));
  });
  $$('.tabs-content .tab-content').forEach((pane) => pane.classList.toggle('active', pane.id === `${content}Content`));
  $('ordersTools').hidden = content !== 'orders';
  $('rangeTools').hidden = content === 'orders';
  if (content === 'chart') renderChart();
}

function initContentTabs() {
  $$('.tabs-header .tab-link').forEach((link) => link.addEventListener('click', () => switchContentTab(link.dataset.content)));
  if (!['orders', 'chart', 'history'].includes(state.contentTab)) state.contentTab = 'orders';
  switchContentTab(state.contentTab);

  const seg = $('rangeSeg');
  const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === state.chartDays));
  syncSeg();
  seg.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-days]');
    if (!btn) return;
    state.chartDays = Number(btn.dataset.days);
    store.set('eve-chart-days', state.chartDays);
    syncSeg();
    renderHistory();
    if (state.contentTab === 'chart') renderChart();
  });
}

let priceChartInstance = null;

function renderChart() {
  const canvas = $('priceChart');
  if (!canvas) return;
  const rows = historyWindow().slice().reverse(); // 时间正序
  $('chartEmpty').hidden = rows.length > 0;
  if (priceChartInstance) {
    priceChartInstance.destroy();
    priceChartInstance = null;
  }
  if (!rows.length || typeof Chart === 'undefined') {
    if (typeof Chart === 'undefined' && rows.length) {
      $('chartEmpty').hidden = false;
      $('chartEmpty').textContent = '图表库加载失败，请检查网络';
    }
    return;
  }

  const textColor = cssVar('--text-secondary');
  const gridColor = cssVar('--border-primary');
  const accent = cssVar('--accent-primary');
  const buy = cssVar('--buy-color');
  const sell = cssVar('--sell-color');
  const dense = rows.length > 60;

  priceChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: rows.map((d) => formatDate(d.date)),
      datasets: [
        {
          label: '平均价格', data: rows.map((d) => d.average), borderColor: accent,
          backgroundColor: accent + '22', borderWidth: 2, fill: true, tension: 0.3,
          pointRadius: dense ? 0 : 2, pointHoverRadius: 4, yAxisID: 'y', order: 0
        },
        {
          label: '最高价', data: rows.map((d) => d.highest), borderColor: buy, borderWidth: 1,
          borderDash: [4, 4], fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y', order: 0
        },
        {
          label: '最低价', data: rows.map((d) => d.lowest), borderColor: sell, borderWidth: 1,
          borderDash: [4, 4], fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y', order: 0
        },
        {
          label: '成交量', data: rows.map((d) => d.volume), type: 'bar',
          backgroundColor: textColor + '33', borderWidth: 0, yAxisID: 'y1', order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: textColor, usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 12 } } },
        tooltip: {
          backgroundColor: cssVar('--bg-elevated'), titleColor: cssVar('--text-primary'), bodyColor: textColor,
          borderColor: gridColor, borderWidth: 1, padding: 10,
          callbacks: {
            title: (items) => formatFullDate(rows[items[0].dataIndex].date),
            label: (ctx) => `${ctx.dataset.label}: ${ctx.dataset.yAxisID === 'y1' ? formatNumber(ctx.parsed.y) : formatPrice(ctx.parsed.y) + ' ISK'}`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 10, maxRotation: 0, font: { size: 11 } } },
        y: {
          position: 'left', grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 11 }, callback: (v) => formatISK(v) }
        },
        y1: {
          position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true,
          // 成交量柱只占下方约三分之一，避免遮住价格线
          suggestedMax: Math.max(...rows.map((d) => d.volume)) * 3,
          ticks: { color: textColor, font: { size: 11 }, callback: (v) => formatISK(v) }
        }
      }
    }
  });
}

// ===== 地址栏 hash：#type=34，支持分享链接与浏览器前进后退 =====
function typeFromHash() {
  const match = location.hash.match(/type=(\d+)/);
  return match ? Number(match[1]) : null;
}

function initHashRouting() {
  window.addEventListener('popstate', () => {
    const typeId = typeFromHash();
    if (typeId && typeId !== state.selectedItem?.id) {
      switchView('market');
      selectItem(typeId, { updateHash: false });
    } else if (!typeId) {
      state.selectedItem = null;
      setDetailVisible(false);
      document.title = 'EVE 市场总览';
    }
  });
}

// ===== 全局快捷键 =====
function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('esiModal').hidden) { closeEsiModal(); return; }
      if ($('sidebar').classList.contains('drawer-open')) { closeDrawer(); return; }
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || !$('esiModal').hidden) return;
    if (state.currentView !== 'market') return;
    switch (event.key) {
      case '/':
        if (MOBILE_QUERY.matches) openDrawer();
        else if ($('sidebar').classList.contains('collapsed')) toggleMarketSidebar();
        $('itemSearch').focus();
        $('itemSearch').select();
        break;
      case '[': toggleMarketSidebar(); break;
      case 'r': case 'R': refreshCurrent(); break;
      case 'f': case 'F': if (state.selectedItem) toggleFavorite(state.selectedItem.id); break;
      case '1': switchContentTab('orders'); break;
      case '2': switchContentTab('chart'); break;
      case '3': switchContentTab('history'); break;
      default: return;
    }
    event.preventDefault();
  });
}

// ===== 个人中心（ESI 经服务端 /api/esi/* 代理，凭据不落前端）=====
const ESI_API = '/api/esi';
const ESI_BASE = 'https://esi.evetech.net/latest';

function readEsiToken() {
  try { return JSON.parse(localStorage.getItem('eve-esi-token') || 'null'); } catch { return null; }
}

function writeEsiToken(token) {
  state.esiToken = token;
  if (token) localStorage.setItem('eve-esi-token', JSON.stringify(token));
  else localStorage.removeItem('eve-esi-token');
}

function setEsiStatus(message, kind) {
  const el = $('esiStatus');
  if (el) { el.textContent = message || ''; el.className = 'status-msg' + (kind ? ' ' + kind : ''); }
}

async function ensureEsiToken() {
  const token = state.esiToken || readEsiToken();
  if (!token || !token.access_token) throw new Error('尚未绑定 ESI');
  if (Date.now() > (token.expires_at || 0) - 60000) {
    const res = await fetch(ESI_API + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: token.refresh_token }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { writeEsiToken(null); throw new Error(data.error || '登录已过期，请重新绑定'); }
    const fresh = { ...token, ...data, expires_at: Date.now() + (data.expires_in || 1199) * 1000 };
    writeEsiToken(fresh);
    return fresh;
  }
  return token;
}

async function esiAuthFetch(path, options = {}) {
  const token = await ensureEsiToken();
  const url = ESI_BASE + path + (path.includes('?') ? '&' : '?') + 'datasource=tranquility';
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { Authorization: 'Bearer ' + token.access_token, 'Accept-Language': 'zh', ...(options.headers || {}) },
    body: options.body
  });
  if (!res.ok) throw new Error('ESI ' + res.status);
  return res.json();
}

// ===== 中文映射（官方中文，Accept-Language: zh 由 ESI 返回）=====
const GENDER_ZH = { male: '男', female: '女' };
// ESI 订单范围：数字表示跳数，其余为固定值
const ORDER_RANGE_ZH = { station: '空间站', solar_system: '星系', region: '整个星域' };
const ASSET_FLAG_ZH = {
  Hangar: '机库', HangarAll: '机库', Cargo: '货舱', DroneBay: '无人机舱', DroneBayHangar: '无人机舱',
  FleetHangar: '舰队机库', FrigateEscapeBay: '护卫舰逃生舱', FrigateEscapeBayHangar: '护卫舰逃生舱',
  Deliveries: '交付仓', OfficeFolder: '办公室', CorpSAG1: '军团机库1', CorpSAG2: '军团机库2',
  CorpSAG3: '军团机库3', CorpSAG4: '军团机库4', CorpSAG5: '军团机库5', CorpSAG6: '军团机库6',
  CorpSAG7: '军团机库7', ShipHangar: '舰船机库', CommandCenterHold: '指挥中心仓',
  PlanetaryCommodityHold: '行星货物仓', FuelBay: '燃料仓', SpecialFuelBay: '特殊燃料仓',
  OreHold: '矿石仓', GasHold: '气体仓', MineralHold: '矿物仓', IceProductHold: '冰制品仓',
  IntermediateProductHold: '中间品仓', AutoFit: '自动装配', Blocked: '已锁定',
  SkillTraining: '训练中', Impounded: '被扣押', LootContainer: '战利品箱'
};

// 全服均价表约 1 MB，整个会话只请求一次，并发调用共享同一个 Promise
function getMarketPriceMap() {
  if (state.marketPriceMap instanceof Map) return Promise.resolve(state.marketPriceMap);
  if (!state.marketPricePromise) {
    state.marketPricePromise = fetchESI('/markets/prices/')
      .then((prices) => new Map(
        (Array.isArray(prices) ? prices : [])
          .map((price) => [Number(price.type_id), Number(price.average_price)])
          .filter(([typeId, price]) => typeId > 0 && Number.isFinite(price) && price > 0)
      ))
      .catch(() => {
        state.marketPricePromise = null; // 失败允许下次重试
        return new Map();
      })
      .then((map) => {
        if (map.size) state.marketPriceMap = map;
        return map;
      });
  }
  return state.marketPricePromise;
}

function valuationQuantity(quantity) {
  const value = Number(quantity);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function valuationCard(label, value, detail, kind = '') {
  return '<div class="valuation-card ' + kind + '"><span class="valuation-label">' + label + '</span><strong class="valuation-value">' + value + '</strong><span class="valuation-detail">' + detail + '</span></div>';
}
const JOURNAL_REF_ZH = {
  player_donation: '玩家转账', market_transaction: '市场交易', transaction_tax: '交易税', broker_fee: '经纪费',
  contract_price: '合同金额', contract_collateral: '合同保证金', contract_reward: '合同报酬', contract_broker_fee: '合同经纪费',
  contract_sales_tax: '合同交易税', contract_deposit: '合同押金', contract_deposit_refund: '合同押金退还',
  bounty_prizes: '赏金', mission_reward: '任务报酬', mission_bonus: '任务奖金', agent_donation: '代理人赠予',
  office_rental_fee: '办公室租金', factory_rental_fee: '工厂租金', repair_bill: '维修费', cloning: '克隆费用',
  jump_clone_deposit: '跳跃克隆押金', insurance: '保险', war_fee: '战争费用', sovereignity_bill: '主权账单',
  structure_gate_jump: '建筑跳跃', asset_safety_wrapping: '资产安全转移', perfect_mission_escalation: '任务奖励',
  project_logistics_transport: '物流运输', industry_job_tax: '工业税', reprocessing_tax: '再处理税', planetary_import_tax: '行星进口税', planetary_export_tax: '行星出口税'
};
function zhLabel(map, key, fallback) {
  const k = String(key ?? '');
  return map[k] || (fallback !== undefined ? fallback : k);
}

async function fetchNameBatch(list) {
  try {
    const res = await fetch(ESI_BASE + '/universe/names/?datasource=tranquility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// 分批 + 整批失败二分重试：单个坏 ID（血统/物品实例等）不会拖垮整批。
// 注意 /universe/names/ 不支持中文（NPC军团/星系返回英文），中文在管线后续单独升级。
async function resolveNames(ids) {
  const unique = [...new Set(ids.map(Number).filter((id) => id > 0))].slice(0, 2000);
  const names = new Map();
  const categories = new Map();
  async function resolveRange(start, end, depth) {
    const slice = unique.slice(start, end);
    if (!slice.length) return;
    const part = await fetchNameBatch(slice);
    if (Array.isArray(part) && part.length) {
      for (const item of part) {
        names.set(Number(item.id), item.name);
        categories.set(Number(item.id), item.category);
      }
      return;
    }
    if (depth < 2 && slice.length > 1) {
      const mid = start + Math.ceil((end - start) / 2);
      await resolveRange(start, mid, depth + 1);
      await resolveRange(mid, end, depth + 1);
    }
  }
  for (let i = 0; i < unique.length; i += 500) await resolveRange(i, Math.min(i + 500, unique.length), 0);
  return { names, categories };
}

// 物品中文名：本地目录（ESI language=zh 生成的官方中文）优先，缺的逐个走 /universe/types/{id}/?language=zh
function catalogTypeNames() {
  if (!state.catalogTypeMap) {
    state.catalogTypeMap = new Map();
    (state.catalog?.groups || []).forEach((group) => (group.types || []).forEach((t) => state.catalogTypeMap.set(Number(t.id), t.name)));
  }
  return state.catalogTypeMap;
}

async function resolveTypeNames(ids) {
  // 目录在首屏之后异步加载；个人中心需要中文物品名时再等待它，避免重复请求 ESI。
  if (!state.catalog && state.catalogReady) await state.catalogReady;
  const local = catalogTypeNames();
  const names = new Map();
  const missing = [];
  for (const id of [...new Set(ids.map(Number).filter(Boolean))]) {
    const hit = local.get(id);
    if (hit) names.set(id, hit);
    else if (missing.length < 120) missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10);
    const results = await Promise.all(chunk.map((id) =>
      fetch(ESI_BASE + '/universe/types/' + id + '/?datasource=tranquility&language=zh')
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ));
    results.forEach((info, idx) => { if (info?.name) names.set(chunk[idx], info.name); });
  }
  return names;
}

// 星系官方中文名（吉他 等）
async function upgradeSystemNamesZh(systemIds) {
  const names = new Map();
  const ids = [...new Set(systemIds.map(Number).filter(Boolean))].slice(0, 60);
  await Promise.all(ids.map(async (id) => {
    try {
      const info = await fetch(ESI_BASE + '/universe/systems/' + id + '/?datasource=tranquility&language=zh').then((r) => (r.ok ? r.json() : null));
      if (info?.name) names.set(id, info.name);
    } catch { /* 失败保留英文名 */ }
  }));
  return names;
}

// 静态表（种族/血统）带缓存，官方中文
async function universeTable(path) {
  state.universeTables = state.universeTables || {};
  if (!state.universeTables[path]) {
    state.universeTables[path] = fetch(ESI_BASE + path + '?datasource=tranquility', { headers: { 'Accept-Language': 'zh' } })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return state.universeTables[path];
}

// 位置 ID 解析：批量接口 → /assets/locations/ 兜底（支持船/集装箱等物品ID）→ 空间站补查。
// 结果写入共享的 names/categories；返回别名映射（物品ID → 星系ID）供中文升级使用。
async function resolveLocationNames(ids, me, names, categories) {
  const unique = [...new Set(ids.map(Number).filter((id) => id > 0))];
  const todo = unique.filter((id) => !names.has(id));
  if (todo.length) {
    const batch = await resolveNames(todo);
    for (const [key, value] of batch.names) {
      names.set(key, value);
      if (batch.categories.has(key)) categories.set(key, batch.categories.get(key));
    }
  }
  const sysAlias = new Map();
  const unresolved = unique.filter((id) => !names.has(id)).slice(0, 100);
  if (unresolved.length) {
    try {
      const locInfo = await esiAuthFetch('/characters/' + me + '/assets/locations/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unresolved)
      });
      const stationQuery = new Map();
      const systemQuery = new Map();
      for (const loc of (Array.isArray(locInfo) ? locInfo : [])) {
        const itemId = Number(loc.item_id);
        if (!itemId) continue;
        if (loc.station_name) names.set(itemId, loc.station_name);
        else if (loc.station_id) stationQuery.set(Number(loc.station_id), itemId);
        else if (loc.solar_system_name) names.set(itemId, loc.solar_system_name);
        else if (loc.solar_system_id) systemQuery.set(Number(loc.solar_system_id), itemId);
        else if (loc.structure_id) names.set(itemId, '玩家建筑 ' + loc.structure_id);
      }
      if (systemQuery.size) {
        const sys = await resolveNames([...systemQuery.keys()]);
        for (const [key, value] of sys.names) {
          names.set(key, value);
          if (sys.categories.has(key)) categories.set(key, sys.categories.get(key));
        }
        for (const [sysId, itemId] of systemQuery) {
          if (names.has(sysId)) { names.set(itemId, names.get(sysId)); sysAlias.set(itemId, sysId); }
        }
      }
      for (const [stationId, itemId] of [...stationQuery.entries()].slice(0, 80)) {
        try {
          const station = await fetch(ESI_BASE + '/universe/stations/' + stationId + '/?datasource=tranquility').then((r) => (r.ok ? r.json() : null));
          if (station?.name) names.set(itemId, station.name);
        } catch { /* 单站失败跳过 */ }
      }
    } catch { /* 解析失败则显示 ID */ }
  }
  return sysAlias;
}

function loadProfile() {
  const token = state.esiToken || readEsiToken();
  if (!token) {
    $('profileEmpty').hidden = false;
    $('profileContent').hidden = true;
    return;
  }
  $('profileEmpty').hidden = true;
  $('profileContent').hidden = false;
  // 已有数据时切回个人中心不重复请求，需要最新数据可点「刷新数据」
  if (state.characterData) { renderProfileTab(activeProfileTab()); return; }
  loadCharacterData().catch((err) => {
    $('profileData').innerHTML = '<p class="text-muted">' + esc(err.message) + '</p>';
    showToast(err.message, 'error', 4000);
    if (!(state.esiToken || readEsiToken())) loadProfile();
  });
}

async function loadCharacterData() {
  const token = await ensureEsiToken();
  const id = token.character_id;
  $('profileAvatar').src = 'https://images.evetech.net/characters/' + id + '/portrait?size=128';
  $('profileName').textContent = token.character_name || ('角色 ' + id);
  $('profileCorp').textContent = '数据读取中…';
  $('profileData').innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取角色数据…</div>';
  const paths = {
    character: '/characters/' + id + '/',
    wallet: '/characters/' + id + '/wallet/',
    skills: '/characters/' + id + '/skills/',
    assets: '/characters/' + id + '/assets/?page=1',
    orders: '/characters/' + id + '/orders/',
    journal: '/characters/' + id + '/wallet/journal/?page=1',
    location: '/characters/' + id + '/location/',
    ship: '/characters/' + id + '/ship/'
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    try { return [key, await esiAuthFetch(path)]; } catch (error) { return [key, { __error: error.message }]; }
  }));
  state.characterData = Object.fromEntries(entries);
  const ch = state.characterData.character || {};
  const assetsList = Array.isArray(state.characterData.assets) ? state.characterData.assets : [];
  const ordersList = Array.isArray(state.characterData.orders) ? state.characterData.orders : [];
  const journalList = Array.isArray(state.characterData.journal) ? state.characterData.journal : [];

  // ── 名称解析管线（物品/星系/种族血统取官方中文；军团/联盟/玩家名官方无中文，保留原名）──
  state.esiNames = new Map();
  state.esiCategories = new Map();
  // 实体池：军团/联盟/玩家/星系，走批量接口
  const entityIds = [
    ch.corporation_id, ch.alliance_id,
    state.characterData.location?.solar_system_id,
    ...journalList.flatMap((j) => [j.first_party_id, j.second_party_id].filter(Boolean))
  ];
  const entity = await resolveNames(entityIds);
  for (const [key, value] of entity.names) {
    state.esiNames.set(key, value);
    if (entity.categories.has(key)) state.esiCategories.set(key, entity.categories.get(key));
  }
  // 位置池：资产/订单的 location_id 可能是空间站、玩家建筑或物品（船/箱子），走兜底管线
  const sysAlias = await resolveLocationNames([
    ...assetsList.map((a) => a.location_id),
    ...ordersList.map((o) => o.location_id)
  ], id, state.esiNames, state.esiCategories);
  // 物品类型：本地中文目录 + ESI 单查兜底（都是官方中文）
  const typeNames = await resolveTypeNames([
    state.characterData.ship?.ship_type_id,
    ...ordersList.map((o) => o.type_id),
    ...assetsList.map((a) => a.type_id)
  ]);
  for (const [key, value] of typeNames) {
    state.esiNames.set(key, value);
    state.esiCategories.set(key, 'inventory_type');
  }
  // 星系升级为官方中文（含位置别名）
  const systemIds = [...state.esiCategories.entries()].filter(([, cat]) => cat === 'solar_system').map(([sid]) => sid);
  if (systemIds.length) {
    const zh = await upgradeSystemNamesZh(systemIds);
    for (const [sid, zhName] of zh) {
      state.esiNames.set(sid, zhName);
      for (const [alias, target] of sysAlias) if (target === sid) state.esiNames.set(alias, zhName);
    }
  }
  // 种族/血统不在批量接口支持范围，查静态全表
  if (ch.race_id || ch.bloodline_id) {
    try {
      const [races, bloodlines] = await Promise.all([
        universeTable('/universe/races/'), universeTable('/universe/bloodlines/')
      ]);
      const race = (Array.isArray(races) ? races : []).find((r) => r.race_id === ch.race_id);
      const bl = (Array.isArray(bloodlines) ? bloodlines : []).find((b) => b.bloodline_id === ch.bloodline_id);
      ch.race_name = race?.name || '';
      ch.bloodline_name = bl?.name || '';
    } catch { /* 拿不到就不显示 */ }
  }

  const nameOf = (nid) => state.esiNames.get(Number(nid)) || (nid ? 'ID ' + nid : '--');
  $('profileCorp').textContent = ch.corporation_id ? (nameOf(ch.corporation_id)) : (ch.race_name || '');
  renderProfileTab(activeProfileTab());
}

function activeProfileTab() {
  const active = document.querySelector('.profile-tabs .tab-link.active');
  return active ? active.dataset.profile : 'info';
}

function profileRow(cells) {
  return '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
}

async function renderProfileTab(tab) {
  const box = $('profileData');
  const data = state.characterData || {};
  const ch = data.character || {};
  if (ch.__error) { box.innerHTML = '<p class="text-muted">角色信息读取失败：' + esc(ch.__error) + '</p>'; return; }
  const names = state.esiNames || new Map();
  const nameOf = (id) => names.get(Number(id)) || (id ? 'ID ' + id : '--');
  const card = (label, value) => '<div class="info-card"><span>' + label + '</span><strong>' + value + '</strong></div>';

  if (tab === 'info') {
    const walletOk = data.wallet && !data.wallet.__error;
    const skillsOk = data.skills && !data.skills.__error;
    const assetsN = data.assets && !data.assets.__error ? data.assets.length : null;
    const ordersN = data.orders && !data.orders.__error ? data.orders.length : null;
    const ship = data.ship && !data.ship.__error ? data.ship : null;
    const loc = data.location && !data.location.__error ? data.location : null;
    const skillCount = skillsOk ? (data.skills.skills || []).length : null;
    const totalSp = skillsOk ? data.skills.total_sp : null;
    box.innerHTML = '<div class="info-grid">' +
      card('种族', esc(ch.race_name || '—')) +
      card('血统', esc(ch.bloodline_name || '—')) +
      card('性别', esc(zhLabel(GENDER_ZH, ch.gender, ch.gender || '—'))) +
      card('生日', ch.birthday ? new Date(ch.birthday).toLocaleDateString('zh-CN') : '—') +
      card('军团', ch.corporation_id ? esc(nameOf(ch.corporation_id)) : '—') +
      card('联盟', ch.alliance_id ? esc(nameOf(ch.alliance_id)) : '无') +
      card('当前位置', loc ? esc(nameOf(loc.solar_system_id)) : '未公开') +
      card('当前舰船', ship ? esc(nameOf(ship.ship_type_id)) : '未公开') +
      card('安全等级', ch.security_status !== undefined ? Number(ch.security_status).toFixed(2) : '—') +
      card('技能', skillCount === null ? '权限不足' : (skillCount + ' 项 / ' + (totalSp ? totalSp.toLocaleString('zh-CN') : '0') + ' SP')) +
      card('钱包余额', walletOk ? formatISK(data.wallet.balance) + ' ISK' : '权限不足') +
      card('资产 / 订单', (assetsN === null ? '?' : assetsN) + ' / ' + (ordersN === null ? '?' : ordersN)) +
      '</div>' +
      (ch.title ? '<p class="text-muted">头衔：' + esc(ch.title) + '</p>' : '');
    return;
  }

  if (tab === 'assets') {
    const assets = data.assets && !data.assets.__error ? data.assets : null;
    if (!assets) { renderProfileStationNav([]); box.innerHTML = '<p class="text-muted">资产读取失败或权限不足</p>'; return; }
    if (!assets.length) { renderProfileStationNav([]); box.innerHTML = '<p class="text-muted">暂无资产记录</p>'; return; }
    const orders = data.orders && !data.orders.__error ? data.orders : [];
    if (!(state.marketPriceMap instanceof Map)) box.innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取全服均价…</div>';
    const marketPrices = await getMarketPriceMap();
    if (activeProfileTab() !== 'assets') return;
    const pricedAssets = assets.map((asset) => {
      const marketPrice = marketPrices.get(Number(asset.type_id));
      const value = marketPrice === undefined ? null : valuationQuantity(asset.quantity) * marketPrice;
      return { asset, marketPrice, value };
    });
    const pricedAssetCount = pricedAssets.filter((row) => row.value !== null).length;
    const assetTotal = pricedAssets.reduce((sum, row) => sum + (row.value ?? 0), 0);
    const sellOrders = orders.filter((order) => !order.is_buy_order);
    const buyOrders = orders.filter((order) => order.is_buy_order);
    const buyTotal = buyOrders.reduce((sum, order) => sum + Number(order.price || 0) * Number(order.volume_remain || 0), 0);
    const sellValuations = sellOrders.map((order) => {
      const marketPrice = marketPrices.get(Number(order.type_id));
      return marketPrice === undefined ? null : marketPrice * Number(order.volume_remain || 0);
    });
    const pricedSellCount = sellValuations.filter((value) => value !== null).length;
    const sellTotal = sellValuations.reduce((sum, value) => sum + (value ?? 0), 0);
    const orderTotal = buyTotal + sellTotal;
    const combinedTotal = assetTotal + orderTotal;
    const assetValueText = pricedAssetCount ? formatISK(assetTotal) + ' ISK' : '暂无行情';
    const sellValueText = sellOrders.length && !pricedSellCount ? '暂无行情' : formatISK(sellTotal) + ' ISK';
    const orderValueText = orders.length && !buyOrders.length && !pricedSellCount ? '暂无行情' : formatISK(orderTotal) + ' ISK';
    const combinedValueText = pricedAssetCount || buyOrders.length || pricedSellCount ? formatISK(combinedTotal) + ' ISK' : '暂无行情';
    const shown = assets.slice(0, 200);
    const groups = new Map();
    shown.forEach((asset, index) => {
      const row = pricedAssets[index];
      const station = nameOf(asset.location_id);
      if (!groups.has(station)) groups.set(station, []);
      groups.get(station).push(row);
    });
    let assetRows = '';
    const stations = [...groups.keys()];
    for (const [stationIndex, station] of stations.entries()) {
      const rows = groups.get(station);
      const groupTotal = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
      const groupPriced = rows.filter((row) => row.value !== null).length;
      assetRows += '<tr class="asset-group-row" data-station-index="' + stationIndex + '"><td colspan="5"><strong>' + esc(station) + '</strong><span>' + rows.length + ' 项 · ' + (groupPriced ? formatISK(groupTotal) + ' ISK' : '暂无行情') + '</span></td></tr>';
      assetRows += rows.map(({ asset, marketPrice, value }) => profileRow([
        esc(nameOf(asset.type_id)) + (asset.is_blueprint_copy ? '（蓝图副本）' : ''),
        (asset.quantity ?? 1).toLocaleString('zh-CN'),
        marketPrice === undefined ? '<span class="muted-cell">暂无行情</span>' : formatISK(marketPrice) + ' ISK',
        value === null ? '<span class="muted-cell">—</span>' : formatISK(value) + ' ISK',
        esc(zhLabel(ASSET_FLAG_ZH, asset.location_flag, asset.location_flag || ''))
      ])).join('');
    }
    renderProfileStationNav(stations);
    box.innerHTML = '<div class="valuation-grid">' +
      valuationCard('资产市场估值', assetValueText, pricedAssetCount + '/' + assets.length + ' 项有 ESI 全服均价', 'is-primary') +
      valuationCard('卖单市场估值', sellValueText, pricedSellCount + '/' + sellOrders.length + ' 笔按市场均价', 'is-sell') +
      valuationCard('买单占用资金', formatISK(buyTotal) + ' ISK', buyOrders.length + ' 笔按剩余数量 × 委托价', 'is-buy') +
      valuationCard('买卖订单合计', orderValueText, '卖单按市场均价，买单按委托价') +
      valuationCard('资产 + 订单合计', combinedValueText, '不含钱包余额', 'is-total') +
      '</div>' +
      '<p class="text-muted valuation-note">资产按空间站/位置分组；市场单价来自 ESI 全服均价，缺少行情的项目不计入估值。当前接口读取资产第一页' + (assets.length > 200 ? '，表格仅显示前 200 项' : '') + '。</p>' +
      '<div class="table-scroll"><table class="pc-mini-table asset-table"><thead><tr><th>物品</th><th>数量</th><th>市场单价</th><th>市场估值</th><th>槽位</th></tr></thead><tbody>' + assetRows + '</tbody></table></div>' +
      (assets.length > 200 ? '<p class="text-muted">共读取 ' + assets.length + ' 项，表格仅显示前 200 项。</p>' : '');
    return;
  }

  if (tab === 'orders') {
    const orders = data.orders && !data.orders.__error ? data.orders : null;
    if (!orders || !orders.length) { box.innerHTML = '<p class="text-muted">暂无有效市场订单</p>'; return; }
    box.innerHTML = '<div class="table-scroll"><table class="pc-mini-table orders-mini"><thead><tr><th>物品</th><th>方向</th><th>位置</th><th>范围</th><th>单价</th><th>剩余/总量</th></tr></thead><tbody>' +
      orders.map((o) => profileRow([
        esc(nameOf(o.type_id)),
        o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>',
        esc(nameOf(o.location_id)),
        esc(rangeLabel(o.range || '')),
        formatPrice(o.price),
        formatNumber(o.volume_remain) + ' / ' + formatNumber(o.volume_total)
      ])).join('') + '</tbody></table></div>';
    return;
  }

  if (tab === 'wallet') {
    const journal = data.journal && !data.journal.__error ? data.journal : null;
    const walletOk = data.wallet && !data.wallet.__error;
    let html = '<div class="info-grid"><div class="info-card"><span>钱包余额</span><strong>' + (walletOk ? formatISK(data.wallet.balance) + ' ISK' : '权限不足') + '</strong></div></div>';
    if (journal && journal.length) {
      html += '<div class="table-scroll"><table class="pc-mini-table wallet-mini"><thead><tr><th>时间</th><th>类型</th><th>对方</th><th>金额</th></tr></thead><tbody>' +
        journal.slice(0, 50).map((j) => profileRow([
          j.date ? new Date(j.date).toLocaleString('zh-CN', { hour12: false }) : '',
          esc(zhLabel(JOURNAL_REF_ZH, j.ref_type, j.ref_type || '')),
          esc(nameOf(j.first_party_id)),
          '<span class="' + (j.amount >= 0 ? 'up' : 'down') + '">' + (j.amount >= 0 ? '+' : '') + formatISK(j.amount) + '</span>'
        ])).join('') + '</tbody></table></div>' +
        (journal.length > 50 ? '<p class="text-muted">仅显示最近 50 条（共 ' + journal.length + ' 条）</p>' : '');
    } else {
      html += '<p class="text-muted">暂无钱包流水</p>';
    }
    box.innerHTML = html;
  }
}

function switchProfileTab(tab, stationIndex) {
  $$('.profile-tabs .tab-link').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab));
  $$('#profileNav .profile-nav-btn').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab && stationIndex === undefined));
  $$('#profileNav .profile-nav-station').forEach((link) => link.classList.toggle('active', link.dataset.stationIndex === stationIndex));
  if (state.characterData) renderProfileTab(tab);
}

function renderProfileStationNav(stations) {
  const nav = $('profileStationNav');
  if (!nav) return;
  if (!stations.length) {
    nav.innerHTML = '<span class="profile-nav-empty">暂无空间站资产</span>';
    return;
  }
  nav.innerHTML = stations.map((station, index) => '<button class="profile-nav-station" data-profile="assets" data-station-index="' + index + '" title="' + esc(station) + '">' + esc(station) + '</button>').join('');
}

// ===== ESI 绑定 =====
async function generateAuthLink() {
  const btn = $('generateAuthBtn');
  btn.disabled = true;
  setEsiStatus('正在生成授权链接…');
  try {
    const res = await fetch(ESI_API + '/auth-url');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('服务端 ' + res.status));
    $('authLink').value = data.url;
    $('openAuthBtn').href = data.url;
    $('authLinkBox').hidden = false;
    setEsiStatus('授权链接已生成：点击「打开」登录，完成后把地址栏完整地址粘贴到第 2 步', 'success');
  } catch (error) {
    setEsiStatus('生成失败：' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function bindEsiCallback() {
  const raw = $('callbackUrl').value.trim();
  if (!raw) { setEsiStatus('请粘贴登录后的完整回调地址', 'error'); $('callbackUrl').focus(); return; }
  let params;
  try { params = new URL(raw, location.href).searchParams; } catch { setEsiStatus('地址格式不正确', 'error'); return; }
  if (params.get('error')) { setEsiStatus('授权失败：' + params.get('error'), 'error'); return; }
  const code = params.get('code');
  const cbState = params.get('state');
  if (!code || !cbState) { setEsiStatus('回调地址缺少 code 或 state', 'error'); return; }
  const btn = $('bindCallbackBtn');
  btn.disabled = true;
  setEsiStatus('正在绑定…');
  try {
    const res = await fetch(ESI_API + '/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state: cbState })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('绑定失败 ' + res.status));
    writeEsiToken({ ...data, expires_at: Date.now() + (data.expires_in || 1199) * 1000 });
    $('callbackUrl').value = '';
    $('authLinkBox').hidden = true;
    setEsiStatus('');
    closeEsiModal();
    showToast('已绑定：' + (data.character_name || '角色'), 'success');
    state.characterData = null;
    switchView('profile');
  } catch (error) {
    setEsiStatus(error.message || '绑定失败', 'error');
  } finally {
    btn.disabled = false;
  }
}

// OAuth 回调落地：授权后 CCP 跳回 https://eve.navexor.top/?code=…&state=…
// 自动弹开绑定框、填入回调地址并清掉地址栏参数，用户只需点「绑定」
function handleEsiCallbackRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const callbackUrl = location.href;
  history.replaceState(null, '', location.pathname + location.hash);
  openEsiModal();
  $('callbackUrl').value = callbackUrl;
  if (params.has('error')) {
    setEsiStatus('授权失败：' + (params.get('error_description') || params.get('error')), 'error');
  } else {
    setEsiStatus('检测到授权回调，请点击「绑定」完成 ESI 绑定', 'success');
    $('bindCallbackBtn').focus();
  }
}

let modalReturnFocus = null;

function openEsiModal() {
  modalReturnFocus = document.activeElement;
  $('esiModal').hidden = false;
  requestAnimationFrame(() => $('generateAuthBtn').focus());
}

function closeEsiModal() {
  $('esiModal').hidden = true;
  modalReturnFocus?.focus?.();
}

function initESIModal() {
  $('bindEsiBtn').addEventListener('click', openEsiModal);
  $('closeEsiModal').addEventListener('click', closeEsiModal);
  $('esiModal').querySelector('.modal-backdrop').addEventListener('click', closeEsiModal);
  $('generateAuthBtn').addEventListener('click', generateAuthLink);
  $('bindCallbackBtn').addEventListener('click', bindEsiCallback);
  $('callbackUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') bindEsiCallback(); });
  $('copyAuthBtn').addEventListener('click', () => {
    const value = $('authLink').value;
    if (value) copyText(value, '授权链接已复制');
  });
  $('refreshProfileBtn').addEventListener('click', () => {
    const btn = $('refreshProfileBtn');
    btn.disabled = true;
    btn.classList.add('spinning');
    loadCharacterData()
      .then(() => showToast('角色数据已刷新', 'success'))
      .catch((e) => showToast(e.message, 'error', 4000))
      .finally(() => { btn.disabled = false; btn.classList.remove('spinning'); });
  });
  $('unbindEsiBtn').addEventListener('click', () => {
    if (!window.confirm('确定解绑当前角色？本地保存的 ESI 令牌将被清除。')) return;
    writeEsiToken(null);
    state.characterData = null;
    renderProfileStationNav([]);
    loadProfile();
    showToast('已解绑，本地令牌已清除', 'success');
  });
  $$('.profile-tabs .tab-link').forEach((link) => link.addEventListener('click', () => switchProfileTab(link.dataset.profile)));
}


// ===== 初始化应用 =====
function init() {
  initTheme();
  initNavigation();
  initSidebar();
  initRegionSelect();
  initDetailActions();
  initOrderTables();
  initContentTabs();
  initESIModal();
  initHashRouting();
  initShortcuts();
  handleEsiCallbackRedirect();
  renderFavorites();
  loadServerStatus();
  setInterval(loadServerStatus, 5 * 60 * 1000);

  // 目录约 1.18 MB，放到首屏绘制之后加载，不阻塞个人中心和基础页面。
  state.catalogReady = new Promise((resolve) => {
    const start = () => {
      loadCatalog().finally(() => {
        resolve();
        const typeId = typeFromHash();
        if (typeId && state.typeIndex.has(typeId)) selectItem(typeId, { updateHash: false });
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(start, { timeout: 800 });
    } else {
      window.setTimeout(start, 0);
    }
  });
  loadProfile();
}

// 启动应用
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
