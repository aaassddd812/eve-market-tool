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
    el.title = '宁静服务器在线 · ' + formatNumber(data.players) + ' 人 · 开服时间 ' + new Date(data.start_time).toLocaleString('zh-CN', { hour12: false });
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
  // 手机浏览器地址栏颜色跟随主题
  syncThemeColor();
  if (priceChartInstance) renderChart();
}

function syncThemeColor() {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', state.theme === 'light' ? '#f5f7fa' : '#0b0f17');
}

function initTheme() {
  syncThemeColor();   // 页面加载时主题已由 <head> 内联脚本设置，这里只同步地址栏颜色
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
  $('mapView').hidden = view !== 'map';
  $('kbView').hidden = view !== 'kb';
  $('menuToggle').hidden = !SIDEBARS[view];   // 击杀记录页没有侧栏
  $('menuToggle').title = { market: '物品目录', profile: '个人中心导航', map: '星图控制' }[view] || '';
  closeDrawer();
  if (view === 'profile') loadProfile();
  if (view === 'map') openStarMap();
  else {
    starMapModule?.hideStarMap();
    if (location.hash.startsWith('#map')) history.replaceState(null, '', location.pathname);
  }
  if (view === 'kb') openKbPage();
  else if (location.hash.startsWith('#kb')) history.replaceState(null, '', location.pathname);
}

// 击杀记录页：首次进入时加载
let kbPageModule = null;
// ===== 会战监测：全站提醒，击杀记录页与星图订阅 =====
let battlesPromise = null;
function initBattleWatch() {
  battlesPromise = import('./battles.js?v=v16r2').then((m) => {
    m.initBattles({ store, loadKillboard, esc, formatISK, officialName, openMapSystem, openKbSystem });
    return m;
  }).catch((error) => { console.error('会战监测加载失败:', error); return null; });
}

// 打开星图并定位到星系
function openMapSystem(id) {
  history.pushState(null, '', '#map=' + id);
  switchView('map');
}

// 打开击杀记录页并按星系筛选
async function openKbSystem(id) {
  switchView('kb');
  await openKbPage();
  kbPageModule?.filterBySystem(id);
}

// 进行中的调用复用同一个 Promise（例如会战提醒「击杀记录」按钮需要等页面就绪后再筛选）
let kbOpening = null;
function openKbPage() {
  if (!kbOpening) kbOpening = openKbPageImpl().finally(() => { kbOpening = null; });
  return kbOpening;
}

async function openKbPageImpl() {
  try {
    if (!kbPageModule) {
      kbPageModule = await import('./kb-page.js?v=v16r2');
      kbPageModule.initKbPage({
        esc, formatISK, formatNumber, officialName, loadNpcNames, resolveNames, resolveTypeNames,
        fetchESI, debounce, showToast, loadKillboard, openMapSystem,
        battles: () => battlesPromise,
        getNpcNames: () => state.npcNames,
        // 市场分类「舰船」下的全部舰船（搜索用）
        shipTypes: () => {
          if (!state.shipTypeList && state.catalog) {
            state.shipTypeList = [...state.typeIndex.values()]
              .filter(({ groupId }) => rootGroupId(groupId) === SHIP_ROOT_GROUP)
              .map(({ type }) => ({ id: type.id, name: type.name }));
          }
          return state.shipTypeList || [];
        }
      });
    }
    if (!state.catalog && state.catalogReady) await state.catalogReady;
    await kbPageModule.showKbPage();
  } catch (error) {
    console.error('击杀记录页加载失败:', error);
    showToast('击杀记录页加载失败：' + error.message, 'error', 4000);
  }
}

// 击杀记录模块：首次需要时加载
let killboardModule = null;
async function loadKillboard() {
  if (!killboardModule) {
    killboardModule = await import('./killboard.js?v=v14r1');
    killboardModule.initKillboard({
      esc, formatISK, formatNumber, loadNpcNames, officialName, resolveNames, resolveTypeNames, getMarketPriceMap
    });
  }
  return killboardModule;
}

// 星图模块较大，首次进入星图时才加载
let starMapModule = null;
async function openStarMap() {
  try {
    if (!starMapModule) {
      starMapModule = await import('./star-map.js?v=v16r3');
      starMapModule.initStarMap({
        fetchESI, esc, formatNumber, formatISK, loadNpcNames, officialName, resolveNames, resolveTypeNames,
        showToast, copyText, store, debounce, isTypingTarget, getMarketPriceMap,
        hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
        closeDrawer: () => { if (MOBILE_QUERY.matches) closeDrawer(); },
        battles: () => battlesPromise,
        getEsiToken: ensureEsiToken,
        loadKillboard,
        // 角色当前所在星系（需要 esi-location.read_location.v1）
        getMyLocation: async () => {
          const token = await ensureEsiToken();
          const loc = await esiAuthFetch('/characters/' + token.character_id + '/location/');
          return loc.solar_system_id;
        }
      });
    }
    await starMapModule.showStarMap();
  } catch (error) {
    console.error('星图加载失败:', error);
    showToast('星图加载失败：' + error.message, 'error', 4000);
  }
}

// ===== 侧边栏（桌面：可收起；移动端：抽屉）=====
function setSidebarCollapsed(sidebarId, reopenId, collapsed, storageKey) {
  $(sidebarId).classList.toggle('collapsed', collapsed);
  $(reopenId).hidden = !collapsed;
  if (storageKey) store.set(storageKey, collapsed ? '1' : '0');
}

// 两个视图的侧栏行为一致：桌面端收起/展开（记住状态），移动端为抽屉
const SIDEBARS = {
  market: { id: 'sidebar', reopen: 'sidebarReopen', key: 'eve-sidebar-collapsed' },
  profile: { id: 'profileSidebar', reopen: 'profileSidebarReopen', key: 'eve-profile-sidebar-collapsed' },
  map: { id: 'mapSidebar', reopen: 'mapSidebarReopen', key: 'eve-map-sidebar-collapsed' }
};

function currentSidebar() {
  return SIDEBARS[state.currentView] || SIDEBARS.market;
}

function openDrawer() {
  $(currentSidebar().id).classList.add('drawer-open');
  $('sidebarBackdrop').hidden = false;
  if (state.currentView === 'market') setTimeout(() => $('itemSearch').focus(), 50);
}

function closeDrawer() {
  Object.values(SIDEBARS).forEach((s) => $(s.id).classList.remove('drawer-open'));
  $('sidebarBackdrop').hidden = true;
}

function isDrawerOpen() {
  return Object.values(SIDEBARS).some((s) => $(s.id).classList.contains('drawer-open'));
}

function toggleSidebar(view = state.currentView) {
  const sb = SIDEBARS[view];
  if (!sb) return;
  if (MOBILE_QUERY.matches) {
    if ($(sb.id).classList.contains('drawer-open')) closeDrawer(); else openDrawer();
    return;
  }
  setSidebarCollapsed(sb.id, sb.reopen, !$(sb.id).classList.contains('collapsed'), sb.key);
}

const toggleMarketSidebar = () => toggleSidebar('market');

function initSidebar() {
  if (store.get('eve-sidebar-collapsed') === '1') setSidebarCollapsed('sidebar', 'sidebarReopen', true);
  if (store.get('eve-profile-sidebar-collapsed') === '1') setSidebarCollapsed('profileSidebar', 'profileSidebarReopen', true);
  if (store.get('eve-map-sidebar-collapsed') === '1') setSidebarCollapsed('mapSidebar', 'mapSidebarReopen', true);
  $('mapSidebarCollapse').addEventListener('click', () => toggleSidebar('map'));
  $('mapSidebarReopen').addEventListener('click', () => toggleSidebar('map'));

  $('sidebarCollapse').addEventListener('click', toggleMarketSidebar);
  $('sidebarReopen').addEventListener('click', toggleMarketSidebar);
  $('menuToggle').addEventListener('click', () => toggleSidebar());
  $('sidebarBackdrop').addEventListener('click', closeDrawer);
  MOBILE_QUERY.addEventListener('change', closeDrawer);
  $('emptySearchBtn').addEventListener('click', openDrawer);
  // 手机端：在抽屉上向左滑动关闭
  for (const sb of Object.values(SIDEBARS)) {
    const el = $(sb.id);
    let startX = null, startY = 0;
    el.addEventListener('touchstart', (e) => {
      if (!el.classList.contains('drawer-open') || e.touches.length !== 1) { startX = null; return; }
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      startX = null;
      if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) closeDrawer();
    }, { passive: true });
  }

  $('profileSidebarCollapse').addEventListener('click', () => toggleSidebar('profile'));
  $('profileSidebarReopen').addEventListener('click', () => toggleSidebar('profile'));

  // 「空间站资产」分组可折叠，状态持久化
  const setStationGroup = (open) => {
    $('stationGroup').classList.toggle('expanded', open);
    $('stationGroupToggle').setAttribute('aria-expanded', String(open));
    store.set('eve-station-group-open', open ? '1' : '0');
  };
  setStationGroup(store.get('eve-station-group-open') !== '0');
  $('stationGroupToggle').addEventListener('click', () => setStationGroup(!$('stationGroup').classList.contains('expanded')));

  $('profileNav').addEventListener('click', (event) => {
    const station = event.target.closest('[data-station-id]');
    const link = event.target.closest('[data-profile]');
    if (!link) return;
    switchProfileTab(link.dataset.profile, station?.dataset.stationId);
    if (MOBILE_QUERY.matches) closeDrawer();
  });

  // 资产总估值表：点击空间站进入该站；空间站页的返回按钮
  const openFromData = (target) => {
    const row = target.closest('[data-open-station]');
    if (row) { switchProfileTab('assets', row.dataset.openStation); return true; }
    if (target.closest('[data-back-assets]')) { switchProfileTab('assets'); return true; }
    const contract = target.closest('[data-contract-id]');
    if (contract) { openContract(Number(contract.dataset.contractId)); return true; }
    if (target.closest('[data-back-contracts]')) { openContract(null); return true; }
    const combatFilter = target.closest('[data-combat-filter]');
    if (combatFilter) { state.combatFilter = combatFilter.dataset.combatFilter; renderProfileTab('combat'); return true; }
    const ctype = target.closest('[data-ctype]');
    if (ctype) { state.contractView.type = ctype.dataset.ctype; renderProfileTab('contracts'); return true; }
    return false;
  };
  $('profileData').addEventListener('click', (event) => openFromData(event.target));
  $('profileData').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-station], [data-contract-id]')) {
      event.preventDefault();
      openFromData(event.target);
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
  syncLossesTab(entry.groupId);
  updateFavButton();
  pushRecent(typeId);

  if (updateHash) {
    const hash = `#type=${typeId}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
  }
  if (!same) $('mainContent').scrollTo({ top: 0 });
  await loadMarketData(typeId);
}

// 舰船（市场根分类「舰船」）才显示「近期损失」
const SHIP_ROOT_GROUP = 4;
function rootGroupId(groupId) {
  let group = state.categories.get(groupId);
  while (group?.parentId) group = state.categories.get(group.parentId);
  return group?.id;
}

function syncLossesTab(groupId) {
  const isShip = rootGroupId(groupId) === SHIP_ROOT_GROUP;
  $('lossesTab').hidden = !isShip;
  if (!isShip && state.contentTab === 'losses') switchContentTab('orders');
  else if (isShip && state.contentTab === 'losses') renderShipLosses(state.selectedItem.id);
}

// 舰船近期损失：zKillboard 最近 200 次损失，统计常用装配
async function renderShipLosses(typeId) {
  const body = $('lossesBody');
  body.innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取 zKillboard 近期损失…</div>';
  try {
    const kb = await loadKillboard();
    const kills = await kb.fetchZkill(`losses/shipTypeID/${typeId}/`);
    if (state.selectedItem?.id !== typeId || state.contentTab !== 'losses') return;
    await Promise.all([kb.prepareKills(kills.slice(0, 50)), kb.prepareFitNames(kills)]);
    if (state.selectedItem?.id !== typeId || state.contentTab !== 'losses') return;
    if (!kills.length) { body.innerHTML = '<p class="text-muted kb-empty">zKillboard 上没有该舰船的近期损失记录</p>'; return; }
    const values = kills.map((k) => k.zkb.totalValue).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const solo = kills.filter((k) => k.zkb.solo).length;
    const span = (new Date(kills[0].killmail_time) - new Date(kills[kills.length - 1].killmail_time)) / 86400e3;
    body.innerHTML =
      '<div class="valuation-grid station-grid">' +
        valuationCard('样本', kills.length + ' 次损失', '最近 ' + Math.max(1, Math.round(span)) + ' 天内') +
        valuationCard('损失价值中位数', formatISK(median) + ' ISK', '船体 + 装配 + 货物', 'is-sell') +
        valuationCard('平均损失价值', formatISK(avg) + ' ISK', '受少数高价值装配影响', 'is-order') +
        valuationCard('被单刷击毁', (solo / kills.length * 100).toFixed(0) + '%', solo + ' 次 1v1 损失') +
      '</div>' +
      '<h4 class="info-section-title section-gap">常用装配<small>（各模块出现在多少比例的损失中）</small></h4>' +
      kb.commonFitHtml(kb.commonFit(kills)) +
      '<h4 class="info-section-title section-gap">最近损失</h4><div class="kb-list">' + kb.killTableHtml(kills.slice(0, 50)) + '</div>' +
      '<p class="text-muted valuation-note">数据来自 zKillboard，点击记录查看完整装配与攻击者。</p>';
    kb.bindKillClicks(body.querySelector('.kb-list'), kills);
  } catch (error) {
    if (state.selectedItem?.id === typeId) body.innerHTML = '<p class="text-muted kb-empty">读取失败：' + esc(error.message) + '</p>';
  }
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
  await loadNpcNames();
  const ids = [...new Set(orders.map((o) => o.location_id))].filter((id) => id && !state.locationCache.has(id));
  // NPC 空间站用官方中文名；玩家建筑名称为玩家自定义，公开接口拿不到时显示 ID
  ids.forEach((id) => {
    const official = officialName(id);
    if (official) state.locationCache.set(id, official);
    else if (id >= 1e12) state.locationCache.set(id, '玩家建筑 #' + id);
  });
  const npc = ids.filter((id) => !state.locationCache.has(id));
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

// 数值后附带较小的单位；占位符（— / …）不加单位
function setStat(id, text, metaId, meta, unit = 'ISK') {
  const el = $(id);
  if (unit && text !== '—' && text !== '…') el.innerHTML = esc(text) + '<span class="unit">' + esc(unit) + '</span>';
  else el.textContent = text;
  if (metaId) $(metaId).textContent = meta;
}

// 卡片迷你图：values 按时间正序
function renderSparkline(svgId, values, type) {
  const svg = $(svgId);
  if (!svg) return;
  const data = values.filter((v) => Number.isFinite(v));
  if (data.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...data);
  const min = type === 'bar' ? 0 : Math.min(...data);
  const range = max - min || 1;
  const y = (v) => 30 - ((v - min) / range) * 28 - 1;
  if (type === 'bar') {
    const w = 100 / data.length;
    svg.innerHTML = data.map((v, i) => {
      const h = Math.max(1, ((v - min) / range) * 30);
      return `<rect class="spark-bar${i === data.length - 1 ? ' last' : ''}" x="${(i * w + w * 0.15).toFixed(2)}" y="${(30 - h).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6"/>`;
    }).join('');
  } else {
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * 100).toFixed(2)},${y(v).toFixed(2)}`);
    svg.innerHTML = `<path class="spark-area" d="M0,30 L${pts.join(' L')} L100,30 Z"/><path class="spark-line" d="M${pts.join(' L')}"/>`;
  }
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
    setStat('volumeValue', formatISK(avgVolume), 'volumeMeta', `近 ${recent.length} 天${trend}`, '件');
  } else {
    setStat('volumeValue', '—', 'volumeMeta', '暂无成交记录');
  }
  const chrono = recent.slice().reverse();
  renderSparkline('volumeSpark', chrono.map((d) => d.volume), 'bar');
  renderSparkline('priceSpark', chrono.map((d) => d.average), 'line');
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
    // 部分 NPC 舰船/武器在图片服务器上没有图标
    if (e.target.tagName === 'IMG' && e.target.closest('.search-hit, .mini-item, .quick-chip, .info-icon, .chip, .kb-fit-item, .kb-attacker, .kb-item, .kb-ship, .kb-common-row')) e.target.classList.add('broken');
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
  $('rangeTools').hidden = content !== 'chart' && content !== 'history';
  if (content === 'chart') renderChart();
  if (content === 'losses' && state.selectedItem) renderShipLosses(state.selectedItem.id);
}

function initContentTabs() {
  $$('.tabs-header .tab-link').forEach((link) => link.addEventListener('click', () => switchContentTab(link.dataset.content)));
  // 「近期损失」只对舰船显示，启动时不恢复到该标签
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
        legend: { position: 'top', align: 'end', labels: { color: textColor, usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 14, font: { size: 12 } } },
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
    // 击杀记录页 / 星图的地址由各自页面处理；从其他页面后退到这些地址时切换过去
    if (location.hash.startsWith('#kb')) { if (state.currentView !== 'kb') switchView('kb'); return; }
    if (location.hash.startsWith('#map')) { if (state.currentView !== 'map') switchView('map'); return; }
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

// ===== 快捷键帮助 =====
function toggleShortcutHelp(show = $('shortcutModal').hidden) {
  $('shortcutModal').hidden = !show;
}

// ===== 全局快捷键 =====
function initShortcuts() {
  $('shortcutHelpBtn').addEventListener('click', () => toggleShortcutHelp(true));
  $('shortcutModal').addEventListener('click', (e) => {
    if (e.target.closest('.modal-backdrop, [data-close-shortcuts]')) toggleShortcutHelp(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('killModal').hidden) { killboardModule?.closeKillModal(); return; }
      if (!$('shortcutModal').hidden) { toggleShortcutHelp(false); return; }
      if (!$('esiModal').hidden) { closeEsiModal(); return; }
      if (isDrawerOpen()) { closeDrawer(); return; }
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || !$('esiModal').hidden || !$('killModal').hidden) return;
    if (event.key === '?') { toggleShortcutHelp(); event.preventDefault(); return; }
    if (event.key === '[') { toggleSidebar(); event.preventDefault(); return; }
    if (event.key === '/' && state.currentView === 'map') {
      if (MOBILE_QUERY.matches) openDrawer();
      $('mapSearch').focus();
      event.preventDefault();
      return;
    }
    if (state.currentView !== 'market') return;
    switch (event.key) {
      case '/':
        if (MOBILE_QUERY.matches) openDrawer();
        else if ($('sidebar').classList.contains('collapsed')) toggleMarketSidebar();
        $('itemSearch').focus();
        $('itemSearch').select();
        break;
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
  SkillTraining: '训练中', Impounded: '被扣押', LootContainer: '战利品箱',
  Unlocked: '未锁定', Locked: '已锁定', AssetSafety: '资产安全', CorpDeliveries: '军团交付仓',
  Implant: '植入体', Skill: '技能', SubSystemBay: '子系统舱', QuafeBay: '酷菲舱',
  StructureFuel: '建筑燃料仓', ShipOffline: '离线舰船', FighterBay: '铁骑舰载机库',
  BoosterBay: '增效剂舱', CorporationGoalDeliveries: '军团目标交付仓', InfrastructureHangar: '基础设施机库',
  MoonMaterialBay: '卫星材料舱', MobileDepotHold: '移动仓库舱', ColonyResourcesHold: '殖民地资源舱'
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
  // 「1.23B ISK」拆成数值 + 较小的单位
  const m = /^(.*\S)\s+(ISK)$/.exec(value);
  const shown = m ? m[1] + '<span class="unit">' + m[2] + '</span>' : value;
  return '<div class="valuation-card ' + kind + '"><span class="valuation-label">' + label + '</span><strong class="valuation-value">' + shown + '</strong><span class="valuation-detail">' + detail + '</span></div>';
}
const JOURNAL_REF_ZH = {
  player_donation: '玩家转账', market_transaction: '市场交易', transaction_tax: '交易税', broker_fee: '经纪费',
  contract_price: '合同金额', contract_collateral: '合同保证金', contract_reward: '合同报酬', contract_broker_fee: '合同经纪费',
  contract_sales_tax: '合同交易税', contract_deposit: '合同押金', contract_deposit_refund: '合同押金退还',
  bounty_prizes: '赏金', mission_reward: '任务报酬', mission_bonus: '任务奖金', agent_donation: '代理人赠予',
  office_rental_fee: '办公室租金', factory_rental_fee: '工厂租金', repair_bill: '维修费', cloning: '克隆费用',
  jump_clone_deposit: '跳跃克隆押金', insurance: '保险', war_fee: '战争费用', sovereignity_bill: '主权账单',
  structure_gate_jump: '建筑跳跃', asset_safety_wrapping: '资产安全转移', perfect_mission_escalation: '任务奖励',
  project_logistics_transport: '物流运输', industry_job_tax: '工业税', reprocessing_tax: '再处理税', planetary_import_tax: '行星进口税', planetary_export_tax: '行星出口税',
  agent_mission_reward: '任务报酬', agent_mission_time_bonus_reward: '任务时间奖励', agent_mission_collateral_paid: '任务抵押金',
  agent_mission_collateral_refunded: '任务抵押金退还', ess_escrow_transfer: 'ESS 托管转账', daily_goal_payouts: '每日目标奖励',
  corporate_reward_payout: '军团奖励', corporation_account_withdrawal: '军团账户取款', brokers_fee: '经纪费',
  manufacturing: '制造', researching_time_productivity: '时间效率研究', researching_material_productivity: '材料效率研究',
  copying: '拷贝', reaction: '反应', skill_purchase: '技能购买', item_trader_payment: '物品交易', market_escrow: '市场托管',
  market_fine_paid: '市场罚款', lp_store: 'LP 商店', kill_right_fee: '击杀权费用', medal_creation: '勋章制作',
  medal_issued: '颁发勋章', docking_fee: '停靠费', office_rental_fee_refund: '办公室租金退还', insurance_payout: '保险赔付'
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
// /universe/names/ 只返回英文，这里只用于玩家军团/联盟/角色等官方表里没有的名字。
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

// ===== 官方中文名称表（build_npc_names.mjs 由 CCP SDE 生成）=====
// NPC 空间站 / NPC 军团 / NPC 角色 / 星系 / 星座 / 星域；玩家自定义的名字不在表中，保留原名。
function loadNpcNames() {
  if (!state.npcNamesPromise) {
    state.npcNamesPromise = fetch('./npc-names-zh.json?v=v3r2')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => { state.npcNames = data; return data; })
      .catch((error) => {
        console.error('官方中文名称表加载失败:', error);
        state.npcNamesPromise = null;
        return null;
      });
  }
  return state.npcNamesPromise;
}

const NPC_TABLES = ['stations', 'systems', 'corporations', 'characters', 'constellations', 'regions'];

function officialName(id) {
  const data = state.npcNames;
  if (!data || !id) return null;
  const key = String(id);
  for (const table of NPC_TABLES) {
    const hit = data[table]?.[key];
    if (hit) return hit;
  }
  return null;
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
    else if (missing.length < 200) missing.push(id);
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

// 角色资产接口分页（X-Pages），每页 1000 条
async function esiAuthFetchPaged(path, maxPages = 20) {
  const token = await ensureEsiToken();
  const get = async (page) => {
    const url = ESI_BASE + path + (path.includes('?') ? '&' : '?') + 'datasource=tranquility&page=' + page;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token.access_token } });
    if (!res.ok) throw new Error('ESI ' + res.status);
    return res;
  };
  const first = await get(1);
  const pages = Math.min(Number(first.headers.get('X-Pages')) || 1, maxPages);
  const all = [await first.json()];
  for (let page = 2; page <= pages; page += 1) all.push(await (await get(page)).json());
  return all.flat();
}

// 资产可能装在舰船/集装箱里：沿 location_id 向上找到真正的位置（空间站/玩家建筑/星系）
function buildAssetLocations(assets) {
  const byItem = new Map(assets.map((a) => [a.item_id, a]));
  for (const asset of assets) {
    let cur = asset;
    let depth = 0;
    asset.parent = byItem.get(asset.location_id) || null;
    while (byItem.has(cur.location_id) && depth < 10) {
      cur = byItem.get(cur.location_id);
      depth += 1;
    }
    asset.rootId = Number(cur.location_id);
    asset.rootType = cur.location_type;
  }
}

const ASSET_SAFETY_ID = 2004;

// 位置名称：官方中文表（NPC 空间站/星系）→ 玩家建筑原名 → ID 兜底
function locationName(id) {
  const official = officialName(id);
  if (official) return official;
  if (id === ASSET_SAFETY_ID) return '资产安全';
  const known = state.esiNames?.get(Number(id));
  if (known) return known;
  return id >= 1e12 ? '玩家建筑 #' + id : '位置 #' + id;
}

// 玩家建筑名称需要 esi-universe.read_structures.v1 授权；没有该权限时保留 ID 显示
async function resolveStructureNames(ids) {
  const list = [...new Set(ids)].filter((id) => id >= 1e12).slice(0, 30);
  await Promise.all(list.map(async (id) => {
    try {
      const info = await esiAuthFetch('/universe/structures/' + id + '/');
      if (info?.name) state.esiNames.set(id, info.name);
    } catch { /* 无权限或无法访问 */ }
  }));
}

// 显示名：官方中文优先，玩家军团/联盟/角色保留原名
function displayName(id) {
  if (!id) return '—';
  return officialName(id) || state.esiNames?.get(Number(id)) || 'ID ' + id;
}

function loadProfile() {
  const token = state.esiToken || readEsiToken();
  if (!token) {
    $('profileEmpty').hidden = false;
    $('profileContent').hidden = true;
    renderProfileStationNav([]);
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
  $('profileChips').innerHTML = '';
  $('profileHeroStats').hidden = true;
  $('profileData').innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取角色数据…</div>';
  const paths = {
    character: '/characters/' + id + '/',
    wallet: '/characters/' + id + '/wallet/',
    skills: '/characters/' + id + '/skills/',
    orders: '/characters/' + id + '/orders/',
    journal: '/characters/' + id + '/wallet/journal/?page=1',
    location: '/characters/' + id + '/location/',
    ship: '/characters/' + id + '/ship/'
  };
  const [entries, assets] = await Promise.all([
    Promise.all(Object.entries(paths).map(async ([key, path]) => {
      try { return [key, await esiAuthFetch(path)]; } catch (error) { return [key, { __error: error.message }]; }
    })),
    esiAuthFetchPaged('/characters/' + id + '/assets/').catch((error) => ({ __error: error.message })),
    loadNpcNames()
  ]);
  state.characterData = Object.fromEntries(entries);
  state.contracts = null;
  state.contractItems.clear();
  state.contractBids.clear();
  state.characterData.assets = assets;
  const ch = state.characterData.character || {};
  const assetsList = Array.isArray(assets) ? assets : [];
  const ordersList = Array.isArray(state.characterData.orders) ? state.characterData.orders : [];
  const journalList = Array.isArray(state.characterData.journal) ? state.characterData.journal : [];
  buildAssetLocations(assetsList);

  // ── 名称解析：官方内容（NPC 空间站/军团/角色、星系、物品、种族血统）用官方中文；玩家自定义名字保留原名 ──
  state.esiNames = new Map();
  const entityIds = [
    ch.corporation_id, ch.alliance_id,
    ...journalList.flatMap((j) => [j.first_party_id, j.second_party_id])
  ].filter((eid) => eid && !officialName(eid));
  const entity = await resolveNames(entityIds);
  for (const [key, value] of entity.names) state.esiNames.set(key, value);

  await resolveStructureNames([
    ...assetsList.map((a) => a.rootId),
    ...ordersList.map((o) => o.location_id)
  ]);

  const typeNames = await resolveTypeNames([
    state.characterData.ship?.ship_type_id,
    ...ordersList.map((o) => o.type_id),
    ...assetsList.map((a) => a.type_id)
  ]);
  state.typeNames = typeNames;

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
      ch.race_faction_id = race?.alliance_id || null;      // 种族所属阵营，如 加达里 → 500001
      ch.bloodline_corp_id = bl?.corporation_id || null;   // 血统所属 NPC 军团
    } catch { /* 拿不到就不显示 */ }
  }
  state.locationIconType = await resolveLocationIconType(state.characterData.location);

  renderProfileHero();
  renderProfileStationNav(stationSummaries());
  renderProfileTab(activeProfileTab());
}

// ===== 游戏内图标（EVE 官方图片服务器）=====
const EVE_IMAGES = 'https://images.evetech.net';
const GAME_ICON = {
  capsule: 670,        // 太空舱：飞行员诞生
  skillbook: 3300,     // 技能书
  structure: 35832,    // 星城（玩家建筑类型需授权才能查询，统一用空堡图标）
  concord: 1000125     // 统合部
};

function gameImage(path, size = 64) {
  return EVE_IMAGES + '/' + path + '?size=' + size;
}

// 当前位置图标：空间站 → 空间站建筑类型；玩家建筑 → 星城；太空中 → 所在星系的恒星
async function resolveLocationIconType(loc) {
  if (!loc || loc.__error) return null;
  try {
    if (loc.station_id) return (await fetchESI('/universe/stations/' + loc.station_id + '/')).type_id;
    if (loc.structure_id) return GAME_ICON.structure;
    const system = await fetchESI('/universe/systems/' + loc.solar_system_id + '/');
    return (await fetchESI('/universe/stars/' + system.star_id + '/')).type_id;
  } catch {
    return null;
  }
}

// ===== 角色主视觉：军团/联盟/安全等级标签 + 关键数字 =====
const ICON_PATHS = {
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || '') + '</svg>';
}

// image 为图片服务器路径（如 corporations/1000035/logo）；没有可用的游戏图标时退回线条图标
function infoCard(image, label, value, wide = false, fallback = 'user') {
  const iconHtml = image
    ? `<div class="info-icon game"><img src="${gameImage(image)}" alt="" loading="lazy" width="40" height="40"></div>`
    : `<div class="info-icon">${icon(fallback)}</div>`;
  return `<div class="info-card${wide ? ' wide' : ''}">${iconHtml}<div class="info-text"><span>${label}</span><strong>${value}</strong></div></div>`;
}

function infoSection(title, body) {
  return `<section class="info-section"><h4 class="info-section-title">${title}</h4><div class="info-grid">${body}</div></section>`;
}

function renderProfileHero() {
  const data = state.characterData || {};
  const ch = data.character || {};
  const chips = [];
  const logo = (path) => `<img src="${gameImage(path, 32)}" alt="" width="16" height="16">`;
  if (ch.corporation_id) chips.push(`<span class="chip" title="军团">${logo('corporations/' + ch.corporation_id + '/logo')}${esc(displayName(ch.corporation_id))}</span>`);
  if (ch.alliance_id) chips.push(`<span class="chip" title="联盟">${logo('alliances/' + ch.alliance_id + '/logo')}${esc(displayName(ch.alliance_id))}</span>`);
  if (ch.security_status !== undefined) {
    const sec = Number(ch.security_status);
    const cls = sec >= 0 ? 'sec-high' : sec > -5 ? 'sec-low' : 'sec-null';
    chips.push(`<span class="chip ${cls}" title="角色安全等级">${logo('corporations/' + GAME_ICON.concord + '/logo')}安全等级 ${sec.toFixed(2)}</span>`);
  }
  $('profileChips').innerHTML = chips.join('');
  $('profileCorp').textContent = chips.length ? '' : (ch.race_name || '');

  const stat = (label, value, sub = '') => `<div class="hero-stat"><span class="hero-stat-label">${label}</span><span class="hero-stat-value">${value}${sub ? '<span class="hero-stat-sub">' + sub + '</span>' : ''}</span></div>`;
  const assets = Array.isArray(data.assets) ? data.assets : null;
  const orders = Array.isArray(data.orders) ? data.orders : null;
  const skillsOk = data.skills && !data.skills.__error;
  const locations = assets ? new Set(assets.map((a) => a.rootId)).size : 0;
  const sells = orders ? orders.filter((o) => !o.is_buy_order).length : 0;
  $('profileHeroStats').innerHTML =
    stat('钱包余额', typeof data.wallet === 'number' ? formatISK(data.wallet) : '—', typeof data.wallet === 'number' ? 'ISK' : '') +
    stat('技能点', skillsOk ? formatISK(data.skills.total_sp) : '—', skillsOk ? 'SP' : '') +
    stat('资产', assets ? formatNumber(assets.length) + ' 项' : '—', assets ? locations + ' 个位置' : '') +
    stat('市场订单', orders ? orders.length + ' 笔' : '—', orders ? sells + ' 卖 · ' + (orders.length - sells) + ' 收' : '');
  $('profileHeroStats').hidden = false;
}

function typeName(typeId) {
  return state.typeNames?.get(Number(typeId)) || 'Type ' + typeId;
}

function activeProfileTab() {
  const active = document.querySelector('.profile-tabs .tab-link.active');
  return active ? active.dataset.profile : 'info';
}

function profileRow(cells, attrs = '') {
  return '<tr' + attrs + '>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
}

// ===== 资产估值：所选星域交易中心的最低卖价 / 最高收购价 =====
function valuationRegion() {
  const id = Number(store.get('eve-valuation-region')) || state.regionId;
  return REGIONS.find((r) => r.id === id) || REGIONS[0];
}

// regionId:typeId -> { sell, buy }，会话内缓存；点「刷新行情」清空
state.hubPriceCache = new Map();
state.profileStation = null; // 当前查看的空间站（null 表示资产总估值）

async function fetchHubPrices(region, typeIds, onProgress) {
  const todo = typeIds.filter((t) => !state.hubPriceCache.has(region.id + ':' + t));
  let done = typeIds.length - todo.length;
  onProgress?.(done, typeIds.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const typeId = todo[cursor++];
      let entry = { sell: null, buy: null };
      try {
        const orders = await fetchESIPaged(`/markets/${region.id}/orders/?order_type=all&type_id=${typeId}`);
        for (const o of orders) {
          if (o.location_id !== region.hub.id) continue;
          if (o.is_buy_order) entry.buy = entry.buy === null ? o.price : Math.max(entry.buy, o.price);
          else entry.sell = entry.sell === null ? o.price : Math.min(entry.sell, o.price);
        }
      } catch { entry = { sell: null, buy: null, failed: true }; }
      state.hubPriceCache.set(region.id + ':' + typeId, entry);
      onProgress?.(++done, typeIds.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

function hubPrice(region, typeId) {
  return state.hubPriceCache.get(region.id + ':' + typeId);
}

// 按位置汇总资产，供侧栏站点树和表格分组使用
function stationSummaries() {
  const assets = Array.isArray(state.characterData?.assets) ? state.characterData.assets : [];
  const region = valuationRegion();
  const map = new Map();
  for (const a of assets) {
    if (!map.has(a.rootId)) map.set(a.rootId, { id: a.rootId, name: locationName(a.rootId), assets: [], sell: 0, buy: 0 });
    const group = map.get(a.rootId);
    group.assets.push(a);
    const p = a.is_blueprint_copy ? null : hubPrice(region, a.type_id);
    const qty = valuationQuantity(a.quantity);
    if (p?.sell != null) group.sell += p.sell * qty;
    if (p?.buy != null) group.buy += p.buy * qty;
  }
  return [...map.values()].sort((x, y) => y.sell - x.sell || y.assets.length - x.assets.length);
}

const ASSET_ROW_LIMIT = 500; // 单个空间站最多显示的行数（估值仍按全部物品计算）

// 装配槽位：HiSlot0 → 高槽 1，RigSlot2 → 改装件槽 3
const FITTING_SLOT_ZH = { Hi: '高槽', Med: '中槽', Lo: '低槽', Rig: '改装件槽', SubSystem: '子系统槽', Service: '服务槽' };

function assetFlagLabel(flag) {
  const m = /^(Hi|Med|Lo|Rig|SubSystem|Service)Slot(\d)$/.exec(flag || '');
  if (m) return FITTING_SLOT_ZH[m[1]] + ' ' + (Number(m[2]) + 1);
  return zhLabel(ASSET_FLAG_ZH, flag, flag || '');
}

function assetSlotLabel(asset) {
  const flag = assetFlagLabel(asset.location_flag);
  return asset.parent ? flag + ' · ' + typeName(asset.parent.type_id) : flag;
}

// 确保当前估价市场的行情已查询完毕；渲染已过期（切走/换站）时返回 null
async function ensureAssetPrices(box, assets, seq) {
  const region = valuationRegion();
  // 蓝图副本无法在市场出售；没有全服均价的物品基本不可交易，不发起行情查询
  const avgMap = await getMarketPriceMap();
  if (seq !== state.assetRenderSeq) return null;
  const qtyByType = new Map();
  assets.forEach((a) => { if (!a.is_blueprint_copy) qtyByType.set(a.type_id, (qtyByType.get(a.type_id) || 0) + valuationQuantity(a.quantity)); });
  const tradable = [...qtyByType.keys()].filter((t) => avgMap.size === 0 || avgMap.has(t))
    .sort((x, y) => (avgMap.get(y) || 0) * qtyByType.get(y) - (avgMap.get(x) || 0) * qtyByType.get(x))
    .slice(0, 1500);
  if (tradable.some((t) => !state.hubPriceCache.has(region.id + ':' + t))) {
    box.innerHTML = '<div class="loading-block"><span class="spinner"></span><span id="priceProgress">正在查询 ' + esc(region.hub.name) + ' 行情…</span></div>';
    await fetchHubPrices(region, tradable, (done, total) => {
      const el = $('priceProgress');
      if (el) el.textContent = '正在查询 ' + region.hub.name + ' 行情 ' + done + ' / ' + total;
    });
    if (seq !== state.assetRenderSeq) return null;
  }
  return { region, tradable };
}

function assetToolbar(region, extra = '') {
  return '<div class="valuation-toolbar">' + extra +
    '<span class="toolbar-spacer"></span>' +
    '<label class="select-wrap" title="估价使用的交易中心">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
      '<select id="valuationRegion" class="region-select" aria-label="估价市场">' +
        REGIONS.map((r) => `<option value="${r.id}"${r.id === region.id ? ' selected' : ''}>${esc(r.hub.name)} · ${esc(r.name)}</option>`).join('') +
      '</select></label>' +
    '<button class="btn" id="refreshPricesBtn" title="清除缓存并重新查询行情">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>刷新行情</span></button>' +
  '</div>';
}

// 估价市场选择 + 刷新行情；资产页与合同详情共用
function bindAssetToolbar(region, tab = 'assets') {
  $('valuationRegion').addEventListener('change', (e) => {
    store.set('eve-valuation-region', e.target.value);
    renderProfileTab(tab);
  });
  $('refreshPricesBtn').addEventListener('click', () => {
    for (const key of [...state.hubPriceCache.keys()]) if (key.startsWith(region.id + ':')) state.hubPriceCache.delete(key);
    renderProfileTab(tab);
  });
}

async function renderAssetsTab(box) {
  const data = state.characterData;
  const assets = Array.isArray(data.assets) ? data.assets : null;
  if (!assets) { box.innerHTML = '<p class="text-muted">资产读取失败或权限不足' + (data.assets?.__error ? '：' + esc(data.assets.__error) : '') + '</p>'; return; }
  if (!assets.length) { box.innerHTML = '<p class="text-muted">暂无资产记录</p>'; return; }

  const seq = (state.assetRenderSeq = (state.assetRenderSeq || 0) + 1);
  const ctx = await ensureAssetPrices(box, assets, seq);
  if (!ctx || activeProfileTab() !== 'assets') return;

  const groups = stationSummaries();
  const station = state.profileStation == null ? null : groups.find((g) => g.id === state.profileStation);
  if (!station) state.profileStation = null;
  renderProfileStationNav(groups);
  if (station) renderStationAssets(box, station, groups, ctx);
  else renderAssetsOverview(box, groups, ctx);
  bindAssetToolbar(ctx.region);
}

// 「资产估值」：总估值 + 各空间站汇总
function renderAssetsOverview(box, groups, { region, tradable }) {
  const data = state.characterData;
  const assets = data.assets;
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const sellOrders = orders.filter((o) => !o.is_buy_order);
  const buyOrders = orders.filter((o) => o.is_buy_order);
  const sellOrderTotal = sellOrders.reduce((s, o) => s + o.price * o.volume_remain, 0);
  const buyOrderTotal = buyOrders.reduce((s, o) => s + o.price * o.volume_remain, 0);
  const assetSell = groups.reduce((s, g) => s + g.sell, 0);
  const assetBuy = groups.reduce((s, g) => s + g.buy, 0);
  const nonBpc = assets.filter((a) => !a.is_blueprint_copy);
  const sellPriced = nonBpc.filter((a) => hubPrice(region, a.type_id)?.sell != null).length;
  const buyPriced = nonBpc.filter((a) => hubPrice(region, a.type_id)?.buy != null).length;
  const failed = tradable.filter((t) => hubPrice(region, t)?.failed).length;

  const rows = groups.map((g) => {
    const share = assetSell ? (g.sell / assetSell) * 100 : 0;
    return `<tr class="station-summary-row" data-open-station="${g.id}" tabindex="0" title="查看该空间站的资产">
        <td><span class="station-link">${esc(g.name)}</span></td>
        <td>${formatNumber(g.assets.length)}</td>
        <td class="down">${g.sell ? formatISK(g.sell) : '—'}</td>
        <td class="up">${g.buy ? formatISK(g.buy) : '—'}</td>
        <td><span class="share-bar"><i style="width:${share.toFixed(1)}%"></i></span>${share ? share.toFixed(1) + '%' : '—'}</td>
      </tr>`;
  }).join('');

  box.innerHTML =
    assetToolbar(region, '<h3 class="asset-view-title">资产总估值</h3>') +
    '<div class="valuation-grid">' +
      valuationCard('资产估值 · 最低卖价', formatISK(assetSell) + ' ISK', sellPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有卖单', 'is-sell') +
      valuationCard('资产估值 · 最高收价', formatISK(assetBuy) + ' ISK', buyPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有收单', 'is-buy') +
      valuationCard('我的卖单', formatISK(sellOrderTotal) + ' ISK', sellOrders.length + ' 笔 · 剩余数量 × 委托价', 'is-order') +
      valuationCard('我的收单', formatISK(buyOrderTotal) + ' ISK', buyOrders.length + ' 笔 · 剩余数量 × 委托价', 'is-order') +
      valuationCard('资产 + 订单合计', formatISK(assetSell + sellOrderTotal + buyOrderTotal) + ' ISK',
        '按收价：' + formatISK(assetBuy + sellOrderTotal + buyOrderTotal) + ' ISK · 不含钱包', 'is-total') +
    '</div>' +
    '<p class="text-muted valuation-note">价格取 ' + esc(region.hub.name) + ' 空间站内的最低卖单价与最高收购价；蓝图副本不可上架、无行情的物品不计入。共 ' +
      formatNumber(assets.length) + ' 项资产，分布在 ' + groups.length + ' 个位置。' +
      (failed ? ' <span class="down">' + failed + ' 种物品行情查询失败，可点「刷新行情」重试。</span>' : '') + '</p>' +
    '<div class="table-scroll"><table class="pc-mini-table station-summary"><thead><tr>' +
      '<th>空间站</th><th>物品数</th><th>卖价估值</th><th>收价估值</th><th>占比（按卖价）</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// 单个空间站：只显示本站物品与本站估值
function renderStationAssets(box, station, groups, { region }) {
  const total = groups.reduce((s, g) => s + g.sell, 0);
  const list = [...station.assets].sort((x, y) => {
    const px = x.is_blueprint_copy ? 0 : hubPrice(region, x.type_id)?.sell ?? 0;
    const py = y.is_blueprint_copy ? 0 : hubPrice(region, y.type_id)?.sell ?? 0;
    return py * valuationQuantity(y.quantity) - px * valuationQuantity(x.quantity);
  });
  const nonBpc = list.filter((a) => !a.is_blueprint_copy);
  const sellPriced = nonBpc.filter((a) => hubPrice(region, a.type_id)?.sell != null).length;
  const buyPriced = nonBpc.filter((a) => hubPrice(region, a.type_id)?.buy != null).length;
  const kinds = new Set(list.map((a) => a.type_id)).size;

  const rows = list.slice(0, ASSET_ROW_LIMIT).map((a) => {
    const qty = valuationQuantity(a.quantity);
    const p = a.is_blueprint_copy ? null : hubPrice(region, a.type_id);
    const name = typeName(a.type_id);
    return profileRow([
      esc(name) + (a.is_blueprint_copy ? ' <span class="pill">蓝图副本</span>' : ''),
      formatNumber(a.quantity ?? 1),
      p?.sell == null ? '<span class="muted-cell">—</span>' : formatPrice(p.sell),
      '<strong class="down">' + (p?.sell == null ? '—' : formatISK(p.sell * qty)) + '</strong>',
      p?.buy == null ? '<span class="muted-cell">—</span>' : formatPrice(p.buy),
      '<strong class="up">' + (p?.buy == null ? '—' : formatISK(p.buy * qty)) + '</strong>',
      esc(assetSlotLabel(a))
    ], ` data-filter="${esc(name.toLowerCase())}"`);
  }).join('');

  box.innerHTML =
    assetToolbar(region,
      '<button class="btn btn-ghost" data-back-assets title="返回资产总估值">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg><span>资产估值</span></button>' +
      '<h3 class="asset-view-title" title="' + esc(station.name) + '">' + esc(station.name) + '</h3>') +
    '<div class="valuation-grid station-grid">' +
      valuationCard('本站估值 · 最低卖价', formatISK(station.sell) + ' ISK', sellPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有卖单', 'is-sell') +
      valuationCard('本站估值 · 最高收价', formatISK(station.buy) + ' ISK', buyPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有收单', 'is-buy') +
      valuationCard('物品', formatNumber(list.length) + ' 项', kinds + ' 种物品') +
      valuationCard('占总资产', total ? ((station.sell / total) * 100).toFixed(1) + '%' : '—', '按最低卖价估值') +
    '</div>' +
    '<div class="station-filter search-box"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
      '<input type="search" id="stationFilter" placeholder="筛选本站物品" autocomplete="off" aria-label="筛选本站物品"></div>' +
    '<div class="table-scroll"><table class="pc-mini-table asset-table"><thead><tr>' +
      '<th>物品</th><th>数量</th><th>最低卖价</th><th>卖价估值</th><th>最高收价</th><th>收价估值</th><th>槽位</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (list.length > ASSET_ROW_LIMIT ? '<p class="text-muted valuation-note">另有 ' + (list.length - ASSET_ROW_LIMIT) + ' 项未显示（已计入本站估值）。</p>' : '');

  $('stationFilter').addEventListener('input', debounce((e) => {
    const q = e.target.value.trim().toLowerCase();
    box.querySelectorAll('.asset-table tbody tr').forEach((tr) => { tr.hidden = !!q && !tr.dataset.filter.includes(q); });
  }, 120));
}

async function renderProfileTab(tab) {
  const box = $('profileData');
  const data = state.characterData || {};
  const ch = data.character || {};
  if (ch.__error) { box.innerHTML = '<p class="text-muted">角色信息读取失败：' + esc(ch.__error) + '</p>'; return; }

  if (tab === 'info') {
    const skillsOk = data.skills && !data.skills.__error;
    const ship = data.ship && !data.ship.__error ? data.ship : null;
    const loc = data.location && !data.location.__error ? data.location : null;
    const skillCount = skillsOk ? (data.skills.skills || []).length : null;
    const where = loc ? displayName(loc.solar_system_id) + (loc.station_id ? ' · ' + locationName(loc.station_id) : loc.structure_id ? ' · ' + locationName(loc.structure_id) : '') : '未公开';
    const sec = ch.security_status;
    const corpLogo = ch.corporation_id ? 'corporations/' + ch.corporation_id + '/logo' : null;
    const charId = (state.esiToken || readEsiToken())?.character_id;
    box.innerHTML =
      infoSection('身份',
        infoCard(ch.race_faction_id ? 'corporations/' + ch.race_faction_id + '/logo' : null, '种族', esc(ch.race_name || '—')) +
        infoCard(ch.bloodline_corp_id ? 'corporations/' + ch.bloodline_corp_id + '/logo' : null, '血统', esc(ch.bloodline_name || '—'), false, 'users') +
        infoCard(charId ? 'characters/' + charId + '/portrait' : null, '性别', esc(zhLabel(GENDER_ZH, ch.gender, ch.gender || '—'))) +
        infoCard('types/' + GAME_ICON.capsule + '/icon', '生日', ch.birthday ? new Date(ch.birthday).toLocaleDateString('zh-CN') : '—') +
        (ch.title ? infoCard(corpLogo, '头衔', esc(ch.title), false, 'award') : '')) +
      infoSection('所属',
        infoCard(corpLogo, '军团', ch.corporation_id ? esc(displayName(ch.corporation_id)) : '—', false, 'building') +
        infoCard(ch.alliance_id ? 'alliances/' + ch.alliance_id + '/logo' : null, '联盟', ch.alliance_id ? esc(displayName(ch.alliance_id)) : '无', false, 'flag') +
        infoCard('corporations/' + GAME_ICON.concord + '/logo', '安全等级', sec !== undefined ? Number(sec).toFixed(2) : '—')) +
      infoSection('当前状态',
        infoCard(state.locationIconType ? 'types/' + state.locationIconType + '/icon' : null, '当前位置', esc(where), true, 'pin') +
        infoCard(ship ? 'types/' + ship.ship_type_id + '/icon' : null, '当前舰船', ship ? esc(typeName(ship.ship_type_id)) + (ship.ship_name ? '（' + esc(ship.ship_name) + '）' : '') : '未公开', false, 'rocket') +
        infoCard('types/' + GAME_ICON.skillbook + '/icon', '技能', skillCount === null ? '权限不足' : skillCount + ' 项'));
    return;
  }

  if (tab === 'assets') {
    await renderAssetsTab(box);
    return;
  }

  if (tab === 'contracts') {
    await renderContractsTab(box);
    return;
  }

  if (tab === 'combat') {
    await renderCombatTab(box);
    return;
  }

  if (tab === 'orders') {
    const orders = Array.isArray(data.orders) ? data.orders : null;
    if (!orders || !orders.length) { box.innerHTML = '<p class="text-muted">暂无有效市场订单</p>'; return; }
    box.innerHTML = '<div class="table-scroll"><table class="pc-mini-table orders-mini"><thead><tr><th>物品</th><th>方向</th><th>位置</th><th>范围</th><th>单价</th><th>剩余/总量</th></tr></thead><tbody>' +
      orders.map((o) => profileRow([
        esc(typeName(o.type_id)),
        o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>',
        esc(locationName(o.location_id)),
        esc(rangeLabel(o.range || '')),
        formatPrice(o.price),
        formatNumber(o.volume_remain) + ' / ' + formatNumber(o.volume_total)
      ])).join('') + '</tbody></table></div>';
    return;
  }

  if (tab === 'wallet') {
    const journal = Array.isArray(data.journal) ? data.journal : null;
    const walletOk = typeof data.wallet === 'number'; // ESI /wallet/ 直接返回余额数字
    const income = journal ? journal.filter((j) => j.amount > 0).reduce((t, j) => t + j.amount, 0) : 0;
    const spend = journal ? journal.filter((j) => j.amount < 0).reduce((t, j) => t + j.amount, 0) : 0;
    let html = '<div class="valuation-grid wallet-grid">' +
      valuationCard('钱包余额', walletOk ? formatPrice(data.wallet) + ' ISK' : '权限不足', '当前角色钱包') +
      valuationCard('近期收入', formatISK(income) + ' ISK', '最近 ' + (journal ? journal.length : 0) + ' 条流水', 'is-buy') +
      valuationCard('近期支出', formatISK(Math.abs(spend)) + ' ISK', '同一时间段', 'is-sell') +
      '</div>';
    if (journal && journal.length) {
      html += '<div class="table-scroll"><table class="pc-mini-table wallet-mini"><thead><tr><th>时间</th><th>类型</th><th>对方</th><th>金额</th></tr></thead><tbody>' +
        journal.slice(0, 50).map((j) => profileRow([
          j.date ? new Date(j.date).toLocaleString('zh-CN', { hour12: false }) : '',
          esc(zhLabel(JOURNAL_REF_ZH, j.ref_type, j.ref_type || '')),
          esc(displayName(j.first_party_id)),
          '<span class="' + (j.amount >= 0 ? 'up' : 'down') + '">' + (j.amount >= 0 ? '+' : '') + formatISK(j.amount) + '</span>'
        ])).join('') + '</tbody></table></div>' +
        (journal.length > 50 ? '<p class="text-muted">仅显示最近 50 条（共 ' + journal.length + ' 条）</p>' : '');
    } else {
      html += '<p class="text-muted">暂无钱包流水</p>';
    }
    box.innerHTML = html;
  }
}

// 与市场中心选物品一致：选中空间站只看本站，选「资产估值」看总估值
function switchProfileTab(tab, stationId) {
  state.profileStation = tab === 'assets' && stationId != null ? Number(stationId) : null;
  if (tab === 'contracts') state.contractView.id = null;
  $$('.profile-tabs .tab-link').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab));
  syncProfileNavActive(tab);
  document.querySelector('.profile-scroll')?.scrollTo({ top: 0 });
  if (state.characterData) renderProfileTab(tab);
}

function openContract(contractId) {
  state.contractView.id = contractId;
  document.querySelector('.profile-scroll')?.scrollTo({ top: 0 });
  renderProfileTab('contracts');
}

function syncProfileNavActive(tab = activeProfileTab()) {
  const station = state.profileStation;
  $$('#profileNav .profile-nav-btn').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab && station == null));
  $$('#profileNav .profile-nav-station').forEach((link) => link.classList.toggle('active', Number(link.dataset.stationId) === station));
}

// 侧栏「空间站资产」站点树：可整体折叠，按卖价估值排序
function renderProfileStationNav(stations) {
  const nav = $('profileStationNav');
  if (!nav) return;
  $('stationCount').textContent = stations.length;
  $('stationCount').hidden = !stations.length;
  if (!stations.length) {
    nav.innerHTML = '<span class="profile-nav-empty">' + (state.characterData ? '暂无空间站资产' : '绑定后显示空间站') + '</span>';
    return;
  }
  const hasPrices = stations.some((s) => s.sell > 0);
  nav.innerHTML = stations.map((s) =>
    `<button class="profile-nav-station" data-profile="assets" data-station-id="${s.id}" title="${esc(s.name)}">
        <span class="station-name">${esc(s.name)}</span>
        <span class="station-meta">${s.assets.length} 项${hasPrices && s.sell ? ' · ' + formatISK(s.sell) : ''}</span>
      </button>`).join('');
  syncProfileNavActive();
}

// ===== 合同查询 =====
// 类别与游戏内「合同」窗口一致：物品交换 / 拍卖 / 快递（租借为旧类型，有记录时才显示）
const CONTRACT_TYPE_ZH = { item_exchange: '物品交换', auction: '拍卖', courier: '快递', loan: '租借', unknown: '未知' };
const CONTRACT_TYPE_ORDER = ['item_exchange', 'auction', 'courier', 'loan', 'unknown'];
const CONTRACT_STATUS_ZH = {
  outstanding: '待接受', in_progress: '进行中', finished_issuer: '已完成', finished_contractor: '已完成',
  finished: '已完成', cancelled: '已取消', rejected: '已拒绝', failed: '已失败', deleted: '已删除', reversed: '已撤销'
};
const CONTRACT_AVAILABILITY_ZH = { public: '公开', personal: '私人', corporation: '军团', alliance: '联盟' };
// 状态筛选分组；「已过期」= 到期仍未被接受
const CONTRACT_STATUS_GROUPS = [
  ['all', '全部状态'], ['outstanding', '待接受'], ['in_progress', '进行中'], ['finished', '已完成'],
  ['expired', '已过期'], ['closed', '已取消 / 拒绝 / 失败']
];
const CONTRACT_ROLES = [['all', '全部合同'], ['issuer', '我发起的'], ['acceptor', '我接受的'], ['assignee', '指派给我的']];

state.contracts = null;              // 合同列表（或 { __error }）
state.contractItems = new Map();     // contract_id -> items
state.contractBids = new Map();      // contract_id -> bids
state.contractView = { type: 'all', status: 'all', role: 'all', id: null };

function myCharacterId() {
  return (state.esiToken || readEsiToken())?.character_id;
}

function contractStatusKey(c) {
  if (c.status === 'outstanding' && c.date_expired && new Date(c.date_expired) < new Date()) return 'expired';
  if (['finished', 'finished_issuer', 'finished_contractor'].includes(c.status)) return 'finished';
  if (['cancelled', 'rejected', 'failed', 'deleted', 'reversed'].includes(c.status)) return 'closed';
  return c.status;
}

function contractStatusPill(c) {
  const key = contractStatusKey(c);
  const text = key === 'expired' ? '已过期' : zhLabel(CONTRACT_STATUS_ZH, c.status, c.status);
  return `<span class="pill status-${key}">${esc(text)}</span>`;
}

function contractRoles(c, me) {
  const roles = [];
  if (c.issuer_id === me) roles.push('issuer');
  if (c.acceptor_id === me) roles.push('acceptor');
  if (c.assignee_id === me) roles.push('assignee');
  return roles;
}

// 合同金额摘要：物品交换看价格/报酬，快递看报酬，拍卖看起拍价/一口价
function contractAmount(c) {
  if (c.type === 'courier') return `<strong>${formatISK(c.reward)}</strong><span class="cell-sub">抵押 ${formatISK(c.collateral)}</span>`;
  if (c.type === 'auction') return `<strong>${formatISK(c.price)}</strong>${c.buyout ? `<span class="cell-sub">一口价 ${formatISK(c.buyout)}</span>` : ''}`;
  if (c.price > 0) return `<strong>${formatISK(c.price)}</strong>${c.reward > 0 ? `<span class="cell-sub">另付 ${formatISK(c.reward)}</span>` : ''}`;
  if (c.reward > 0) return `<strong class="up">+${formatISK(c.reward)}</strong><span class="cell-sub">发起方支付</span>`;
  return '<span class="muted-cell">—</span>';
}

function contractLocation(c) {
  if (c.type === 'courier' && c.end_location_id && c.end_location_id !== c.start_location_id) {
    return esc(locationName(c.start_location_id)) + ' <span class="route-arrow">→</span> ' + esc(locationName(c.end_location_id));
  }
  return esc(locationName(c.start_location_id));
}

async function loadContracts() {
  const me = myCharacterId();
  try {
    state.contracts = await esiAuthFetchPaged('/characters/' + me + '/contracts/');
  } catch (error) {
    state.contracts = { __error: error.message };
    return;
  }
  // 玩家/军团/联盟名称保留原名；地点用官方中文站名，玩家建筑尝试读取名称
  const parties = state.contracts.flatMap((c) => [c.issuer_id, c.acceptor_id, c.assignee_id, c.issuer_corporation_id])
    .filter((id) => id && !officialName(id) && !state.esiNames.has(id));
  const named = await resolveNames(parties);
  for (const [key, value] of named.names) state.esiNames.set(key, value);
  await resolveStructureNames(state.contracts.flatMap((c) => [c.start_location_id, c.end_location_id]));
}

async function renderContractsTab(box) {
  if (!state.contracts) {
    box.innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取合同记录…</div>';
    await loadContracts();
    if (activeProfileTab() !== 'contracts') return;
  }
  if (state.contracts.__error) {
    box.innerHTML = '<p class="text-muted">合同读取失败或权限不足：' + esc(state.contracts.__error) + '</p>';
    return;
  }
  const contract = state.contractView.id != null && state.contracts.find((c) => c.contract_id === state.contractView.id);
  if (contract) await renderContractDetail(box, contract);
  else { state.contractView.id = null; renderContractList(box); }
}

function renderContractList(box) {
  const me = myCharacterId();
  const view = state.contractView;
  const all = [...state.contracts].sort((a, b) => new Date(b.date_issued) - new Date(a.date_issued));
  const byRoleStatus = all.filter((c) =>
    (view.role === 'all' || contractRoles(c, me).includes(view.role)) &&
    (view.status === 'all' || contractStatusKey(c) === view.status));
  const counts = { all: byRoleStatus.length };
  byRoleStatus.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  const types = CONTRACT_TYPE_ORDER.filter((t) => t !== 'unknown' && t !== 'loan' || counts[t]);
  const list = byRoleStatus.filter((c) => view.type === 'all' || c.type === view.type);

  const select = (id, options, value) => `<select id="${id}" class="plain-select">` +
    options.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('') + '</select>';

  const rows = list.map((c) => {
    const roles = contractRoles(c, me);
    const roleText = roles.includes('issuer') ? '我发起' : roles.includes('acceptor') ? '我接受' : roles.includes('assignee') ? '指派给我' : '';
    const counterpart = roles.includes('issuer') ? (c.acceptor_id || c.assignee_id) : c.issuer_id;
    return `<tr class="contract-row" data-contract-id="${c.contract_id}" tabindex="0">
        <td><span class="pill type-${c.type}">${esc(zhLabel(CONTRACT_TYPE_ZH, c.type, c.type))}</span></td>
        <td class="contract-title"><strong><span class="pill type-${c.type} type-inline">${esc(zhLabel(CONTRACT_TYPE_ZH, c.type, c.type))}</span>${esc(c.title || '（无标题）')}</strong><span class="cell-sub">#${c.contract_id}${roleText ? ' · ' + roleText : ''}</span></td>
        <td>${contractStatusPill(c)}</td>
        <td>${counterpart ? esc(displayName(counterpart)) : '<span class="muted-cell">—</span>'}</td>
        <td class="num">${contractAmount(c)}</td>
        <td class="contract-loc">${contractLocation(c)}</td>
        <td class="num muted">${formatTime(c.date_issued)}</td>
      </tr>`;
  }).join('');

  box.innerHTML =
    '<div class="valuation-toolbar contract-toolbar">' +
      '<div class="segmented contract-types" role="group" aria-label="合同类别">' +
        `<button data-ctype="all" class="${view.type === 'all' ? 'active' : ''}">全部 <span class="seg-count">${counts.all}</span></button>` +
        types.map((t) => `<button data-ctype="${t}" class="${view.type === t ? 'active' : ''}">${CONTRACT_TYPE_ZH[t]} <span class="seg-count">${counts[t] || 0}</span></button>`).join('') +
      '</div>' +
      '<span class="toolbar-spacer"></span>' +
      select('contractRole', CONTRACT_ROLES, view.role) +
      select('contractStatus', CONTRACT_STATUS_GROUPS, view.status) +
    '</div>' +
    (list.length
      ? '<div class="table-scroll"><table class="pc-mini-table contract-table"><thead><tr>' +
          '<th>类别</th><th>合同</th><th>状态</th><th>对方</th><th class="num">金额</th><th>地点</th><th class="num">发布</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="text-muted">没有符合条件的合同</p>') +
    '<p class="text-muted valuation-note">共 ' + all.length + ' 份合同（ESI 返回最近 30 天内的合同记录）。点击合同查看物品与收卖估值。</p>';

  $('contractRole').addEventListener('change', (e) => { view.role = e.target.value; renderContractList(box); });
  $('contractStatus').addEventListener('change', (e) => { view.status = e.target.value; renderContractList(box); });
}

async function loadContractDetailData(c) {
  const me = myCharacterId();
  const jobs = [];
  if (!state.contractItems.has(c.contract_id)) {
    jobs.push(esiAuthFetch('/characters/' + me + '/contracts/' + c.contract_id + '/items/')
      .then((items) => state.contractItems.set(c.contract_id, items))
      .catch((error) => state.contractItems.set(c.contract_id, { __error: error.message })));
  }
  if (c.type === 'auction' && !state.contractBids.has(c.contract_id)) {
    jobs.push(esiAuthFetch('/characters/' + me + '/contracts/' + c.contract_id + '/bids/')
      .then((bids) => state.contractBids.set(c.contract_id, bids))
      .catch(() => state.contractBids.set(c.contract_id, [])));
  }
  await Promise.all(jobs);
  const items = state.contractItems.get(c.contract_id);
  if (Array.isArray(items)) {
    const missing = items.map((i) => i.type_id).filter((t) => !state.typeNames?.has(t));
    if (missing.length) {
      const names = await resolveTypeNames(missing);
      state.typeNames = state.typeNames || new Map();
      for (const [k, v] of names) state.typeNames.set(k, v);
    }
    const bidders = (state.contractBids.get(c.contract_id) || []).map((b) => b.bidder_id).filter((id) => !state.esiNames.has(id));
    if (bidders.length) {
      const named = await resolveNames(bidders);
      for (const [k, v] of named.names) state.esiNames.set(k, v);
    }
  }
}

// 估值：raw_quantity = -2 为蓝图副本，不能上架，不计入
function valueContractItems(items, region) {
  const sum = { sell: 0, buy: 0, sellPriced: 0, buyPriced: 0, count: 0 };
  for (const item of items) {
    if (item.raw_quantity === -2) continue;
    sum.count += 1;
    const p = hubPrice(region, item.type_id);
    if (p?.sell != null) { sum.sell += p.sell * item.quantity; sum.sellPriced += 1; }
    if (p?.buy != null) { sum.buy += p.buy * item.quantity; sum.buyPriced += 1; }
  }
  return sum;
}

// 合同价与估值比较：负数表示合同价低于估值
function compareCard(label, price, value, noun = '合同价') {
  if (!value) return valuationCard(label, '无行情', '物品没有可用行情');
  const diff = price - value;
  const pct = (diff / value) * 100;
  const text = (diff <= 0 ? '低 ' : '高 ') + formatISK(Math.abs(diff)) + ' ISK';
  return valuationCard(label, text, noun + '为估值的 ' + ((price / value) * 100).toFixed(1) + '%（' + (pct <= 0 ? '低' : '高') + Math.abs(pct).toFixed(1) + '%）', diff <= 0 ? 'is-buy' : 'is-sell');
}

function contractVerdict(price, given) {
  if (!price || !given.count || (!given.sell && !given.buy)) return '';
  if (given.buy && price <= given.buy) return '<span class="verdict good">低于最高收购价 · 买入后可直接卖给收单</span>';
  if (given.sell && price <= given.sell) return '<span class="verdict ok">低于市场最低卖价</span>';
  return '<span class="verdict bad">高于市场最低卖价</span>';
}

// 收购合同的结论：报酬与索取物品价值比较（站在接受方角度）
function requestVerdict(pay, wanted) {
  if (!pay || (!wanted.sell && !wanted.buy)) return '';
  if (wanted.sell && pay >= wanted.sell) return '<span class="verdict good">报酬高于最低卖价 · 从市场买入后交付即可获利</span>';
  if (wanted.buy && pay >= wanted.buy) return '<span class="verdict ok">报酬高于最高收购价</span>';
  return '<span class="verdict bad">报酬低于最高收购价 · 物品卖给收单更划算</span>';
}

async function renderContractDetail(box, c) {
  const region = valuationRegion();
  const needsData = !state.contractItems.has(c.contract_id) || (c.type === 'auction' && !state.contractBids.has(c.contract_id));
  if (needsData) {
    box.innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取合同物品…</div>';
    await loadContractDetailData(c);
    if (state.contractView.id !== c.contract_id || activeProfileTab() !== 'contracts') return;
  }
  const items = state.contractItems.get(c.contract_id);
  const itemList = Array.isArray(items) ? items : [];
  const typeIds = [...new Set(itemList.filter((i) => i.raw_quantity !== -2).map((i) => i.type_id))];
  if (typeIds.some((t) => !state.hubPriceCache.has(region.id + ':' + t))) {
    box.innerHTML = '<div class="loading-block"><span class="spinner"></span><span id="priceProgress">正在查询 ' + esc(region.hub.name) + ' 行情…</span></div>';
    await fetchHubPrices(region, typeIds, (done, total) => {
      const el = $('priceProgress');
      if (el) el.textContent = '正在查询 ' + region.hub.name + ' 行情 ' + done + ' / ' + total;
    });
    if (state.contractView.id !== c.contract_id || activeProfileTab() !== 'contracts') return;
  }

  const given = valueContractItems(itemList.filter((i) => i.is_included), region);     // 发起方提供
  const wanted = valueContractItems(itemList.filter((i) => !i.is_included), region);   // 发起方索取
  const bids = [...(state.contractBids.get(c.contract_id) || [])].sort((a, b) => b.amount - a.amount);
  const topBid = bids[0]?.amount || 0;

  // —— 估值卡片 ——
  let cards = '';
  if (c.type === 'courier') {
    const perM3 = c.volume ? c.reward / c.volume : 0;
    cards =
      valuationCard('报酬', formatISK(c.reward) + ' ISK', c.volume ? formatNumber(c.volume, 1) + ' m³ · ' + formatPrice(perM3) + ' ISK/m³' : '—', 'is-buy') +
      valuationCard('抵押金', formatISK(c.collateral) + ' ISK', '接受方需支付的保证金', 'is-order') +
      valuationCard('物品估值 · 最低卖价', formatISK(given.sell) + ' ISK', given.sellPriced + '/' + given.count + ' 项有卖单', 'is-sell') +
      valuationCard('物品估值 · 最高收价', formatISK(given.buy) + ' ISK', given.buyPriced + '/' + given.count + ' 项有收单', 'is-buy') +
      valuationCard('抵押金覆盖率', given.sell ? ((c.collateral / given.sell) * 100).toFixed(1) + '%' : '—', '抵押金 ÷ 物品卖价估值', c.collateral >= given.sell ? 'is-buy' : 'is-sell');
  } else if (!given.count && wanted.count) {
    // 收购合同：发起方只索取物品并支付报酬（或价格），比较报酬与索取物品的市场价值
    const pay = c.reward || c.price;
    cards =
      valuationCard(c.reward ? '发起方支付报酬' : '合同价格', formatISK(pay) + ' ISK', c.reward ? '接受方交付物品后获得' : '接受方支付') +
      valuationCard('索取物品 · 最低卖价', formatISK(wanted.sell) + ' ISK', wanted.sellPriced + '/' + wanted.count + ' 项在 ' + esc(region.hub.name) + ' 有卖单', 'is-sell') +
      valuationCard('索取物品 · 最高收价', formatISK(wanted.buy) + ' ISK', wanted.buyPriced + '/' + wanted.count + ' 项在 ' + esc(region.hub.name) + ' 有收单', 'is-buy') +
      (pay ? compareCard('报酬对比卖价估值', pay, wanted.sell, '报酬') + compareCard('报酬对比收价估值', pay, wanted.buy, '报酬') : '');
  } else {
    const price = c.type === 'auction' ? (topBid || c.price) : c.price;
    const priceLabel = c.type === 'auction' ? (topBid ? '当前最高出价' : '起拍价') : '合同价格';
    const priceDetail = c.type === 'auction'
      ? (c.buyout ? '一口价 ' + formatISK(c.buyout) + ' · ' : '') + bids.length + ' 次出价'
      : (c.reward > 0 ? '发起方另付报酬 ' + formatISK(c.reward) : '接受方支付');
    cards =
      valuationCard(priceLabel, formatISK(price) + ' ISK', priceDetail) +
      valuationCard('物品估值 · 最低卖价', formatISK(given.sell) + ' ISK', given.sellPriced + '/' + given.count + ' 项在 ' + esc(region.hub.name) + ' 有卖单', 'is-sell') +
      valuationCard('物品估值 · 最高收价', formatISK(given.buy) + ' ISK', given.buyPriced + '/' + given.count + ' 项在 ' + esc(region.hub.name) + ' 有收单', 'is-buy') +
      (given.count && price ? compareCard('对比卖价估值', price, given.sell, priceLabel) + compareCard('对比收价估值', price, given.buy, priceLabel) : '');
    if (wanted.count) {
      cards += valuationCard('索取物品 · 最低卖价', formatISK(wanted.sell) + ' ISK', '发起方要求接受方提供', 'is-order') +
        valuationCard('索取物品 · 最高收价', formatISK(wanted.buy) + ' ISK', wanted.buyPriced + '/' + wanted.count + ' 项有收单', 'is-order');
    }
  }

  // —— 合同信息 ——
  const kv = (k, v) => v ? `<div class="kv"><span>${k}</span><strong>${v}</strong></div>` : '';
  const date = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '';
  const info =
    kv('类别', esc(zhLabel(CONTRACT_TYPE_ZH, c.type, c.type))) +
    kv('状态', contractStatusPill(c)) +
    kv('可见范围', esc(zhLabel(CONTRACT_AVAILABILITY_ZH, c.availability, c.availability)) + (c.for_corporation ? '（代表军团）' : '')) +
    kv('发起人', esc(displayName(c.issuer_id))) +
    kv('发起军团', c.issuer_corporation_id ? esc(displayName(c.issuer_corporation_id)) : '') +
    kv('指派对象', c.assignee_id ? esc(displayName(c.assignee_id)) : '') +
    kv('接受人', c.acceptor_id ? esc(displayName(c.acceptor_id)) : '') +
    kv(c.type === 'courier' ? '起点' : '地点', esc(locationName(c.start_location_id))) +
    kv('终点', c.type === 'courier' && c.end_location_id ? esc(locationName(c.end_location_id)) : '') +
    kv('完成期限', c.type === 'courier' && c.days_to_complete ? c.days_to_complete + ' 天' : '') +
    kv('发布时间', date(c.date_issued)) +
    kv('到期时间', date(c.date_expired)) +
    kv('接受时间', date(c.date_accepted)) +
    kv('完成时间', date(c.date_completed));

  // —— 物品表 ——
  const itemRows = itemList.map((i) => {
    const bpc = i.raw_quantity === -2;
    const p = bpc ? null : hubPrice(region, i.type_id);
    return profileRow([
      `<span class="item-cell"><img src="${IMAGE_BASE}/${i.type_id}/icon?size=32" alt="" width="24" height="24" loading="lazy">${esc(typeName(i.type_id))}${bpc ? ' <span class="pill">蓝图副本</span>' : ''}</span>`,
      formatNumber(i.quantity),
      i.is_included ? '<span class="pill buy">提供</span>' : '<span class="pill sell">索取</span>',
      p?.sell == null ? '<span class="muted-cell">—</span>' : formatPrice(p.sell),
      '<strong class="down">' + (p?.sell == null ? '—' : formatISK(p.sell * i.quantity)) + '</strong>',
      p?.buy == null ? '<span class="muted-cell">—</span>' : formatPrice(p.buy),
      '<strong class="up">' + (p?.buy == null ? '—' : formatISK(p.buy * i.quantity)) + '</strong>'
    ]);
  }).join('');

  const bidRows = bids.map((b) => profileRow([esc(displayName(b.bidder_id)), formatPrice(b.amount) + ' ISK', date(b.date_bid)])).join('');

  box.innerHTML =
    assetToolbar(region,
      '<button class="btn btn-ghost" data-back-contracts title="返回合同列表">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg><span>合同列表</span></button>' +
      '<h3 class="asset-view-title" title="' + esc(c.title || '') + '">' +
        '<span class="pill type-' + c.type + '">' + esc(zhLabel(CONTRACT_TYPE_ZH, c.type, c.type)) + '</span> ' + esc(c.title || '（无标题）') + '</h3>') +
    (c.type === 'courier' ? ''
      : !given.count && wanted.count ? requestVerdict(c.reward || c.price, wanted)
      : contractVerdict(c.type === 'auction' ? (topBid || c.price) : c.price, given)) +
    '<div class="valuation-grid contract-grid">' + cards + '</div>' +
    '<div class="kv-grid">' + info + '</div>' +
    (Array.isArray(items)
      ? (itemList.length
        ? '<div class="table-scroll"><table class="pc-mini-table asset-table contract-items"><thead><tr>' +
            '<th>物品</th><th>数量</th><th>方向</th><th>最低卖价</th><th>卖价估值</th><th>最高收价</th><th>收价估值</th>' +
          '</tr></thead><tbody>' + itemRows + '</tbody></table></div>'
        : '<p class="text-muted">该合同没有物品</p>')
      : '<p class="text-muted">合同物品读取失败：' + esc(items?.__error || '') + '</p>') +
    (bids.length
      ? '<h4 class="info-section-title section-gap">出价记录</h4><div class="table-scroll"><table class="pc-mini-table bid-table"><thead><tr><th>出价人</th><th>出价</th><th>时间</th></tr></thead><tbody>' + bidRows + '</tbody></table></div>'
      : '') +
    '<p class="text-muted valuation-note">估值取 ' + esc(region.hub.name) + ' 空间站内的最低卖单价与最高收购价；「提供」为发起方给出的物品，「索取」为发起方要求接受方提供的物品，蓝图副本不计入。</p>';

  bindAssetToolbar(region, 'contracts');
}

// ===== 战斗记录（zKillboard）=====
state.combatFilter = 'all';

async function renderCombatTab(box) {
  const me = myCharacterId();
  box.innerHTML = '<div class="loading-block"><span class="spinner"></span>正在读取 zKillboard 战斗记录…</div>';
  let kb, kills, stats;
  try {
    kb = await loadKillboard();
    [kills, stats] = await Promise.all([
      kb.fetchZkill(`characterID/${me}/`),
      kb.fetchZkill(`stats/characterID/${me}/`).catch(() => null)
    ]);
    if (activeProfileTab() !== 'combat') return;
    await kb.prepareKills(kills);
  } catch (error) {
    box.innerHTML = '<p class="text-muted">战斗记录读取失败：' + esc(error.message) + '</p>';
    return;
  }
  if (activeProfileTab() !== 'combat') return;

  const isLoss = (k) => k.victim.character_id === me;
  const losses = kills.filter(isLoss);
  const wins = kills.filter((k) => !isLoss(k));
  const sum = (list) => list.reduce((t, k) => t + (k.zkb.totalValue || 0), 0);
  const filter = state.combatFilter;
  const shown = filter === 'kills' ? wins : filter === 'losses' ? losses : kills;

  // 生涯统计（zKillboard stats）；没有数据时用近期记录估算
  const lifetime = stats && stats.shipsDestroyed !== undefined;
  const destroyedIsk = lifetime ? stats.iskDestroyed || 0 : sum(wins);
  const lostIsk = lifetime ? stats.iskLost || 0 : sum(losses);
  const efficiency = destroyedIsk + lostIsk ? destroyedIsk / (destroyedIsk + lostIsk) * 100 : null;
  const cards =
    valuationCard(lifetime ? '生涯击杀' : '近期击杀', formatNumber(lifetime ? stats.shipsDestroyed || 0 : wins.length) + ' 艘', lifetime ? '单刷 ' + formatNumber(stats.soloKills || 0) + ' 次' : '最近 ' + kills.length + ' 条记录', 'is-buy') +
    valuationCard(lifetime ? '生涯损失' : '近期损失', formatNumber(lifetime ? stats.shipsLost || 0 : losses.length) + ' 艘', lifetime ? '单刷被杀 ' + formatNumber(stats.soloLosses || 0) + ' 次' : '', 'is-sell') +
    valuationCard('击毁价值', formatISK(destroyedIsk) + ' ISK', lifetime ? 'zKillboard 生涯统计' : '近期记录合计', 'is-buy') +
    valuationCard('损失价值', formatISK(lostIsk) + ' ISK', lifetime ? 'zKillboard 生涯统计' : '近期记录合计', 'is-sell') +
    valuationCard('ISK 效率', efficiency == null ? '—' : efficiency.toFixed(1) + '%',
      lifetime ? '危险度 ' + (stats.dangerRatio ?? '—') + '% · 团战 ' + (stats.gangRatio ?? '—') + '%' : '击毁 ÷（击毁 + 损失）', 'is-total');

  box.innerHTML =
    '<div class="valuation-grid">' + cards + '</div>' +
    '<div class="valuation-toolbar section-gap">' +
      '<div class="segmented" role="group" aria-label="战斗记录筛选">' +
        [['all', '全部', kills.length], ['kills', '击杀', wins.length], ['losses', '损失', losses.length]].map(([key, label, n]) =>
          `<button data-combat-filter="${key}" class="${filter === key ? 'active' : ''}">${label} <span class="seg-count">${n}</span></button>`).join('') +
      '</div>' +
      '<span class="toolbar-spacer"></span>' +
      `<a class="btn btn-ghost" href="https://zkillboard.com/character/${me}/" target="_blank" rel="noopener">在 zKillboard 查看 ↗</a>` +
    '</div>' +
    '<div class="kb-list">' + kb.killTableHtml(shown, { me, showSide: true }) + '</div>' +
    '<p class="text-muted valuation-note">数据来自 zKillboard（最近 200 条记录与生涯统计），缓存 5 分钟。点击记录查看装配与攻击者。</p>';
  kb.bindKillClicks(box.querySelector('.kb-list'), kills);
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
  initBattleWatch();
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
  if (location.hash.startsWith('#map')) switchView('map');   // 星图分享链接
  if (location.hash.startsWith('#kb')) switchView('kb');     // 击杀记录分享链接
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
