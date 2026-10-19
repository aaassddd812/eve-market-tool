import { skCards, skRows, skToolbar, skTitle } from './skeleton.js?v=v16r7';
import * as TF from './trade-fees.js?v=v2';
import { SERVER, SERVER_LIST, IS_TQ, HUB_NAME, NO_KB_MESSAGE, setServer, serverKey, esiUrl, eveImage, kbSiteLink } from './server.js?v=s3';

// ===== 配置与常量 =====
const IMAGE_BASE = 'https://images.evetech.net/types';

// 主要交易中心（按服务器，定义在 server.js）：REGIONS[0] 是全站默认价格基准
const REGIONS = SERVER.regions;

// 「当前位置」得到的星域保存在这里：{ id, name, system }
const LOC_REGION_KEY = 'eve-loc-region';
// 市场范围：'all' 全宇宙（默认）/ 'loc' 当前位置 / 星域 ID
const MARKET_REGION_KEY = 'eve-market-region';

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
  // 市场范围：regionId 0 = 全宇宙；locMode = 角色当前所在星域（含可读的玩家建筑订单）
  locMode: store.get(MARKET_REGION_KEY) === 'loc' && Boolean(locRegion()),
  regionId: store.get(MARKET_REGION_KEY) === 'loc' && locRegion() ? locRegion().id : Number(store.get(MARKET_REGION_KEY)) || 0,
  marketRegions: [],        // 全部星域 { id, name }（map-data.json）
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
  hubOnly: store.get('eve-hub-only-v2') === '1',
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
  const url = endpoint.startsWith('http') ? endpoint : esiUrl(endpoint);
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
  const first = await fetch(esiUrl(`${endpoint}${sep}page=1`), options);
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
    $('serverStatusText').textContent = formatNumber(data.players) + ' 在线';
    el.title = SERVER.full + '在线 · ' + formatNumber(data.players) + ' 人 · 开服时间 ' + new Date(data.start_time).toLocaleString('zh-CN', { hour12: false }) + ' · 点击切换服务器';
  } catch {
    el.classList.add('offline');
    $('serverStatusText').textContent = '无法连接';
    el.title = SERVER.full + ' ESI 状态接口暂不可用 · 点击切换服务器';
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

// 各视图在地址栏里的 hash 前缀（市场中心为空或 #type=）
const VIEW_HASH = { map: '#map', kb: '#kb', fit: '#fit', pi: '#pi', industry: '#ind', lp: '#lp', appraisal: '#appr', courier: '#courier', war: '#war' };
const VIEW_IDS = { market: 'marketView', profile: 'profileView', map: 'mapView', kb: 'kbView', fit: 'fitView', pi: 'piView', industry: 'industryView', lp: 'lpView', appraisal: 'appraisalView', courier: 'courierView', war: 'warView' };
// 离开视图时记住地址栏 hash 与滚动位置，切回来时恢复，页面保持离开前的样子
const viewHashes = {};
const viewScroll = {};

function ownsHash(view, hash) {
  if (view === 'market') return !hash || hash.startsWith('#type=');
  return Boolean(VIEW_HASH[view]) && hash.startsWith(VIEW_HASH[view]);
}

// 隐藏（display: none）会丢失滚动位置，记下视图内所有滚动过的元素
function saveScroll(view) {
  const root = $(VIEW_IDS[view]);
  if (!root) return [];
  return [...root.querySelectorAll('*')].filter((el) => el.scrollTop || el.scrollLeft).map((el) => [el, el.scrollTop, el.scrollLeft]);
}

function restoreScroll(list) {
  for (const [el, top, left] of list || []) {
    if (!el.isConnected) continue;
    if (!el.scrollTop) el.scrollTop = top;
    if (!el.scrollLeft) el.scrollLeft = left;
  }
}

// 页面内部改地址（选中星系、切换标签等）时随时记下当前视图的 hash；后退 / 前进到别的视图时也不会丢
function noteViewHash() {
  if (ownsHash(state.currentView, location.hash)) viewHashes[state.currentView] = location.hash;
}
function initViewHashTracking() {
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn].bind(history);
    history[fn] = (...args) => { orig(...args); noteViewHash(); };
  }
  window.addEventListener('popstate', noteViewHash);
  noteViewHash();
}

function switchView(view) {
  const prev = state.currentView;
  if (prev !== view) viewScroll[prev] = saveScroll(prev);
  // restored：回到离开时的状态，各页面据此不再重新渲染
  let restored = prev === view;
  const hashMatches = ownsHash(view, location.hash);
  if (hashMatches && prev !== view && viewHashes[view] === location.hash) restored = true;
  state.currentView = view;
  if (!hashMatches) {
    restored = view in viewHashes || (!VIEW_HASH[view] && view !== 'market');
    history.replaceState(null, '', location.pathname + location.search + (viewHashes[view] || ''));
  }
  $$('.nav-btn').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    if (active && MOBILE_QUERY.matches) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // 手机导航可横向滑动
  });
  for (const [v, id] of Object.entries(VIEW_IDS)) $(id).hidden = v !== view;
  $('menuToggle').hidden = !SIDEBARS[view];   // 击杀记录页没有侧栏
  $('menuToggle').title = { market: '物品目录', profile: '个人中心导航', map: '星图控制', fit: '装配浏览器', industry: '制造导航', lp: 'LP 商店导航', courier: '快递筛选' }[view] || '';
  closeDrawer();
  if (prev !== view) {
    restoreScroll(viewScroll[view]);
    requestAnimationFrame(() => restoreScroll(viewScroll[view]));
  }
  if (view === 'profile') {
    if (!(restored && state.characterData && (state.esiToken || readEsiToken()))) loadProfile();
  }
  if (view === 'map') openStarMap();
  else starMapModule?.hideStarMap();
  if (view === 'kb') openKbPage(restored);
  if (view === 'fit') openFitting(restored);
  if (view === 'pi') openPi();
  if (view === 'industry') openIndustry(restored);
  if (view === 'lp') openLp();
  if (view === 'appraisal') openAppraisal();
  if (view === 'courier') openCourier();
  if (view === 'war') openWar();
}

// 战争（势力战争 + 军团战争）：首次进入时加载
let warLoading = null;
async function openWar() {
  try {
    if (!warLoading) warLoading = import('./war.js?v=v4').then((m) => {
      m.initWar({ esc, formatISK, formatNumber, fetchESI, resolveNames, officialName, eveImage, valuationCard, loadKillboard, killmailWithValue, getMarketPriceMap, openMapSystem });
      return m;
    }).catch((error) => { warLoading = null; throw error; });
    const m = await warLoading;
    await m.showWar(location.hash);
  } catch (error) {
    showToast('战争页加载失败：' + error.message, 'error', 4000);
  }
}

// 默认交易中心（吉他；曙光服为索巴色基）最低卖价 / 最高收购价：Map(id -> { sell, buy })
async function getJitaPrices(ids, onProgress) {
  const jita = REGIONS[0];
  await fetchHubPrices(jita, ids, onProgress);
  return new Map(ids.map((id) => [id, hubPrice(jita, id)]).filter(([, v]) => v && !v.failed));
}

// 制造：首次进入时加载
let industryLoading = null;
function loadIndustryModule() {
  if (!industryLoading) industryLoading = import('./industry.js?v=v28').then((m) => {
    m.initIndustry({
      esc, formatISK, formatNumber, formatPrice, showToast, copyText, store, fetchESI,
      getHubPrices: getJitaPrices, getCharacterSkills, esiAuthFetch, ensureEsiToken,
      hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
      closeDrawer: () => { if (MOBILE_QUERY.matches) closeDrawer(); }
    });
    return m;
  }).catch((error) => { industryLoading = null; throw error; });
  return industryLoading;
}

async function openIndustry(restored = false) {
  try {
    const m = await loadIndustryModule();
    await m.showIndustry(location.hash.startsWith('#ind') ? location.hash : '#ind', restored);
  } catch (error) {
    console.error('制造页加载失败:', error);
    showToast('制造页加载失败：' + error.message, 'error', 4000);
  }
}

// LP 商店：首次进入时加载
let lpLoading = null;
function loadLpModule() {
  if (!lpLoading) lpLoading = import('./lp-store.js?v=v5').then((m) => {
    m.initLp({
      esc, formatISK, formatNumber, showToast, store, fetchESI, getMarketPriceMap, esiAuthFetch, ensureEsiToken,
      getHubPrices: getJitaPrices,
      hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
      closeDrawer: () => { if (MOBILE_QUERY.matches) closeDrawer(); }
    });
    return m;
  }).catch((error) => { lpLoading = null; throw error; });
  return lpLoading;
}

async function openLp() {
  try {
    const m = await loadLpModule();
    await m.showLp(location.hash.startsWith('#lp') ? location.hash : '#lp');
  } catch (error) {
    console.error('LP 商店加载失败:', error);
    showToast('LP 商店加载失败：' + error.message, 'error', 4000);
  }
}

// 快递推荐用船「去装配页查看」：切到装配页并载入 EFT 装配；后退回到快递页
async function openEftFit(text) {
  try {
    (await loadFittingModule()).queueEftFit(text);
  } catch (error) {
    showToast('模拟装配加载失败：' + error.message, 'error', 4000);
    return false;
  }
  history.pushState(null, '', location.pathname + '#fit');
  switchView('fit');
  return true;
}

// 快递合同：首次进入时加载
let courierLoading = null;
async function openCourier() {
  try {
    if (!courierLoading) courierLoading = import('./courier.js?v=v5').then((m) => {
      m.initCourier({
        esc, formatISK, formatNumber, showToast, copyText, store, esiAuthFetch, officialName, loadNpcNames, resolveNames, openMapSystem, openEftFit, game: gameActions,
        // 公开拍卖（快递页的「拍卖」模式，auctions.js 首次切换时加载）
        renderAuctions: async (box) => {
          const a = await import('./auctions.js?v=v2');
          if (!box.dataset.init) {
            box.dataset.init = '1';
            loadMarketRegions().catch(() => {});
            a.initAuctions({
              esc, formatISK, formatPrice, formatNumber, fetchESI, resolveTypeNames, officialName, getMarketPriceMap, valuationCard, locationName, store, game: gameActions,
              esiBase: ESI_BASE, datasource: SERVER.datasource, regions: REGIONS, marketRegions: () => state.marketRegions,
              resolveStructures: (ids) => resolveStructureNames(ids)
            });
          }
          a.renderAuctions(box);
        },
        hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
        tokenInfo: () => state.esiToken || readEsiToken(),
        hasScope: (scope) => hasScope(state.esiToken || readEsiToken(), scope),
        // 玩家建筑名称与所在星系（本地缓存 → 共享缓存 → 已绑定角色可见的建筑）
        resolveStructures: async (ids) => {
          await resolveStructureNames(ids);
          const map = structureNameMap();
          return new Map(ids.map((id) => [id, map.get(id)]).filter(([, v]) => v?.n).map(([id, v]) => [id, { name: v.n, system: v.s }]));
        },
        openEsiBind: () => { switchView('profile'); openEsiModal(); }
      });
      return m;
    }).catch((error) => { courierLoading = null; throw error; });
    await (await courierLoading).showCourier();
  } catch (error) {
    console.error('快递页加载失败:', error);
    showToast('快递页加载失败：' + error.message, 'error', 4000);
  }
}

// 估价（市场 / 化矿）：首次进入时加载
let appraisalLoading = null;
async function openAppraisal() {
  try {
    if (!appraisalLoading) appraisalLoading = import('./appraisal.js?v=v8').then((m) => {
      m.initAppraisal({
        esc, formatISK, formatNumber, showToast, copyText, store, fetchESIPaged, getMarketPriceMap,
        getTypeIndex: async () => { if (!state.catalog && state.catalogReady) await state.catalogReady; return state.typeIndex; },
        regions: REGIONS,
        hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
        getCharacterSkills, getCharacterImplants,
        openEsiBind: () => { switchView('profile'); openEsiModal(); }
      });
      return m;
    }).catch((error) => { appraisalLoading = null; throw error; });
    const m = await appraisalLoading;
    if (!location.hash.startsWith('#appr')) history.replaceState(null, '', location.pathname + '#appr');
    m.showAppraisal();
  } catch (error) {
    console.error('估价页加载失败:', error);
    showToast('估价页加载失败：' + error.message, 'error', 4000);
  }
}

// 行星工业规划：首次进入时加载
let piLoading = null;
function loadPiModule() {
  if (!piLoading) piLoading = import('./pi-planner.js?v=v31').then((m) => {
    m.initPi({
      esc, formatISK, formatNumber, showToast, store, getMarketPriceMap, fetchESI,
      // 我的殖民地（pi-colonies.js，展开时才加载）
      renderColonies: async (box) => {
        const c = await import('./pi-colonies.js?v=v2');
        c.initColonies({
          esc, formatISK, formatNumber, esiAuthFetch, fetchESI, resolveTypeNames, officialName, gameImage, valuationCard, getMarketPriceMap,
          hasScopeGroup, scopeNeededHtml, openMapSystem, tokenInfo: () => state.esiToken || readEsiToken()
        });
        await c.renderColonies(box);
      },
      // 默认交易中心最低卖价 / 最高收购价
      getHubPrices: getJitaPrices
    });
    return m;
  }).catch((error) => { piLoading = null; throw error; });
  return piLoading;
}

async function openPi() {
  try {
    const m = await loadPiModule();
    if (!location.hash.startsWith('#pi')) history.replaceState(null, '', location.pathname + '#pi');
    await m.showPi();
  } catch (error) {
    console.error('行星工业加载失败:', error);
    showToast('行星工业加载失败：' + error.message, 'error', 4000);
  }
}

// 模拟装配：模块与数据（约 450 KB 压缩后）首屏后空闲时预加载，或首次进入时加载
let fittingLoading = null;
function loadFittingModule() {
  if (!fittingLoading) fittingLoading = import('./fitting.js?v=v33').then((m) => {
    m.initFitting({
      esc, formatNumber, formatISK, showToast, copyText, store, debounce, getMarketPriceMap, getInsurance,
      getCharacterSkills, getCharacterImplants, esiFetch: esiAuthFetch, getEsiToken: ensureEsiToken,
      hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
      openDrawer: () => { if (MOBILE_QUERY.matches) openDrawer(); },
      closeDrawer: () => { if (MOBILE_QUERY.matches) closeDrawer(); }
    });
    return m;
  }).catch((error) => { fittingLoading = null; throw error; });
  return fittingLoading;
}

async function openFitting(restored = false) {
  try {
    const m = await loadFittingModule();
    if (!location.hash.startsWith('#fit')) history.replaceState(null, '', location.pathname + '#fit');
    await m.showFitting(restored);
  } catch (error) {
    console.error('模拟装配加载失败:', error);
    showToast('模拟装配加载失败：' + error.message, 'error', 4000);
  }
}

// 击杀详情「去装配页查看」：切到装配页并载入击杀时的装配；后退回到原页面
async function openKillFit(kill) {
  try {
    if (!await (await loadFittingModule()).queueKillFit(kill)) {
      showToast('这个目标不是可装配的舰船', 'info', 3000);
      return false;
    }
  } catch (error) {
    showToast('模拟装配加载失败：' + error.message, 'error', 4000);
    return false;
  }
  history.pushState(null, '', location.pathname + '#fit');
  switchView('fit');
  return true;
}

// 击杀记录页：首屏后空闲时预加载，或首次进入时加载
let kbPageModule = null;
// ===== 会战监测：全站提醒，击杀记录页与星图订阅 =====
let battlesPromise = null;
function initBattleWatch() {
  if (!SERVER.kb) return;
  battlesPromise = import('./battles.js?v=v19r17').then((m) => {
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

// 国服没有击杀数据源：击杀记录页只显示说明
function renderNoKbPage() {
  const box = $('kbView').querySelector('.kb-scroll');
  if (box.dataset.noKb) return;
  box.dataset.noKb = '1';
  box.innerHTML = '<div class="empty-state server-unsupported">' +
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' +
    '<p>' + esc(NO_KB_MESSAGE) + '</p>' +
    '<p class="hint">zKillboard 与本站击杀记录服务只收录宁静服的击杀邮件</p>' +
    '<div class="server-unsupported-actions">' +
      (SERVER.kbSite ? `<a class="btn btn-primary" href="${SERVER.kbSite.url}/" target="_blank" rel="noopener">打开${esc(SERVER.kbSite.name)} ↗</a>` : '') +
      (SERVER.kbExtra || []).map((x) => `<a class="btn btn-ghost" href="${x.url}" target="_blank" rel="noopener">打开${esc(x.name)} ↗</a>`).join('') +
      '<button class="btn btn-ghost" type="button" data-switch-server="tq">切换到宁静服</button>' +
    '</div>' +
  '</div>';
}

// ===== 服务器切换（顶栏）=====
function initServerSwitch() {
  const btn = $('serverStatus'), menu = $('serverMenu');
  $('serverName').textContent = SERVER.name;
  document.documentElement.dataset.server = SERVER.id;
  if (!SERVER.kb && !SERVER.kbSite) $$('[data-profile="combat"]').forEach((el) => { el.hidden = true; });   // 没有战斗记录数据也没有外部击杀站
  if (SERVER.tokenProxy) {
    // 网易登录服务器不允许浏览器跨域请求令牌，只能经本站转发，如实说明
    $('esiPrivacyNote').textContent = '使用网易官方 ESI 网页的授权应用登录。' + SERVER.full + '登录服务器不允许浏览器直接换取令牌，这一步经本站原样转发给网易登录服务器，本站不记录、不保存；令牌只保存在本机。';
    $('esiCallbackNote').textContent = '登录后会停在网易 ESI 页面（ali-esi.evepc.163.com），立即复制地址栏完整地址（包含 code）粘贴到这里，授权码几分钟内就会失效。';
  }
  menu.innerHTML = SERVER_LIST.map((x) =>
    `<button type="button" role="menuitemradio" aria-checked="${x.id === SERVER.id}" data-switch-server="${x.id}">` +
      `<b>${esc(x.full)}</b><small>${esc(x.sub)}</small></button>`).join('');
  const toggle = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('[aria-checked="true"]')?.focus();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(menu.hidden); });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#serverMenu')) toggle(false);
    const pick = e.target.closest('[data-switch-server]');
    if (!pick) return;
    if (pick.dataset.switchServer === SERVER.id) { toggle(false); return; }
    setServer(pick.dataset.switchServer);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { toggle(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
}

// 进行中的调用复用同一个 Promise（例如会战提醒「击杀记录」按钮需要等页面就绪后再筛选）
let kbOpening = null;
function openKbPage(restored = false) {
  if (!kbOpening) kbOpening = openKbPageImpl(restored).finally(() => { kbOpening = null; });
  return kbOpening;
}

let kbPageLoading = null;
function loadKbPageModule() {
  if (!kbPageLoading) kbPageLoading = import('./kb-page.js?v=v28').then((m) => {
    m.initKbPage({
      esc, formatISK, formatNumber, officialName, loadNpcNames, resolveNames, resolveTypeNames,
      fetchESI, debounce, showToast, copyText, loadKillboard, openMapSystem,
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
    kbPageModule = m;
    return m;
  }).catch((error) => { kbPageLoading = null; throw error; });
  return kbPageLoading;
}

async function openKbPageImpl(restored) {
  if (!SERVER.kb) { renderNoKbPage(); return; }
  try {
    await loadKbPageModule();
    if (!state.catalog && state.catalogReady) await state.catalogReady;
    await kbPageModule.showKbPage(restored);
  } catch (error) {
    console.error('击杀记录页加载失败:', error);
    showToast('击杀记录页加载失败：' + error.message, 'error', 4000);
  }
}

// 击杀记录模块：首次需要时加载
let killboardModule = null;
let killboardLoading = null;
function loadKillboard() {
  if (!killboardLoading) killboardLoading = import('./killboard.js?v=v24').then((m) => {
    m.initKillboard({
      esc, formatISK, formatNumber, loadNpcNames, officialName, resolveNames, resolveTypeNames, getMarketPriceMap, openKillFit, getInsurance
    });
    killboardModule = m;
    return m;
  }).catch((error) => { killboardLoading = null; throw error; });
  return killboardLoading;
}

// 星图模块较大：首屏后空闲时预加载，或首次进入星图时加载
let starMapModule = null;
let starMapLoading = null;
function loadStarMapModule() {
  if (!starMapLoading) starMapLoading = import('./star-map.js?v=v29').then((m) => {
    m.initStarMap({
      fetchESI, esc, formatNumber, formatISK, loadNpcNames, officialName, resolveNames, resolveTypeNames,
      showToast, copyText, store, debounce, isTypingTarget, getMarketPriceMap,
      hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
      closeDrawer: () => { if (MOBILE_QUERY.matches) closeDrawer(); },
      battles: () => battlesPromise,
      getEsiToken: ensureEsiToken,
      getCharacterSkills,
      getCharacterStandings,
      getFatigue,
      game: gameActions,
      loadKillboard,
      // 角色当前所在星系（需要 esi-location.read_location.v1）
      getMyLocation: async () => {
        const token = await ensureEsiToken();
        const loc = await esiAuthFetch('/characters/' + token.character_id + '/location/');
        return loc.solar_system_id;
      }
    });
    starMapModule = m;
    return m;
  }).catch((error) => { starMapLoading = null; throw error; });
  return starMapLoading;
}

async function openStarMap() {
  try {
    await loadStarMapModule();
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
  map: { id: 'mapSidebar', reopen: 'mapSidebarReopen', key: 'eve-map-sidebar-collapsed' },
  fit: { id: 'fitSidebar', reopen: 'fitSidebarReopen', key: 'eve-fit-sidebar-collapsed' },
  industry: { id: 'indSidebar', reopen: 'indSidebarReopen', key: 'eve-ind-sidebar-collapsed' },
  lp: { id: 'lpSidebar', reopen: 'lpSidebarReopen', key: 'eve-lp-sidebar-collapsed' },
  courier: { id: 'courierSidebar', reopen: 'courierSidebarReopen', key: 'eve-courier-sidebar-collapsed' }
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
  if (store.get('eve-fit-sidebar-collapsed') === '1') setSidebarCollapsed('fitSidebar', 'fitSidebarReopen', true);
  if (store.get('eve-ind-sidebar-collapsed') === '1') setSidebarCollapsed('indSidebar', 'indSidebarReopen', true);
  if (store.get('eve-lp-sidebar-collapsed') === '1') setSidebarCollapsed('lpSidebar', 'lpSidebarReopen', true);
  if (store.get('eve-courier-sidebar-collapsed') === '1') setSidebarCollapsed('courierSidebar', 'courierSidebarReopen', true);
  $('courierSidebarCollapse').addEventListener('click', () => toggleSidebar('courier'));
  $('courierSidebarReopen').addEventListener('click', () => toggleSidebar('courier'));
  $('lpSidebarCollapse').addEventListener('click', () => toggleSidebar('lp'));
  $('lpSidebarReopen').addEventListener('click', () => toggleSidebar('lp'));
  $('indSidebarCollapse').addEventListener('click', () => toggleSidebar('industry'));
  $('indSidebarReopen').addEventListener('click', () => toggleSidebar('industry'));
  $('fitSidebarCollapse').addEventListener('click', () => toggleSidebar('fit'));
  $('fitSidebarReopen').addEventListener('click', () => toggleSidebar('fit'));
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
    const dyn = target.closest('[data-dyn]');
    if (dyn) { const [t, i] = dyn.dataset.dyn.split(':').map(Number); openDynamicItem(t, i); return true; }
    const gc = target.closest('[data-game-contract]');
    if (gc) { gameActions.contract(Number(gc.dataset.gameContract)); return true; }
    if (target.closest('[data-esi-rebind]')) { openEsiModal(); return true; }
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
  $$('#sidebar .sidebar-tabs .tab-btn').forEach((btn) => btn.addEventListener('click', () => switchSidebarTab(btn.dataset.tab)));

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
  $$('#sidebar .sidebar-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('#sidebar .sidebar-content .tab-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `${tab}Pane`));
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
  const isShip = SERVER.kb && rootGroupId(groupId) === SHIP_ROOT_GROUP;
  $('lossesTab').hidden = !isShip;
  if (!isShip && state.contentTab === 'losses') switchContentTab('orders');
  else if (isShip && state.contentTab === 'losses') renderShipLosses(state.selectedItem.id);
}

// 舰船近期损失：zKillboard 最近 200 次损失，统计常用装配
async function renderShipLosses(typeId) {
  const body = $('lossesBody');
  body.innerHTML = skCards(4, 'station-grid') + skTitle(14) + skRows(6, { img: 24 }) + skTitle(10) + skRows(8);
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

// 伊甸币（PLEX）是全服统一市场：ESI 把所有订单与成交历史都归在星域 19000001（GPMR-01），普通星域查不到。
// 订单上的空间站仍是挂单的真实地点，但在任何地方都能直接买卖，所以不分星域、不按交易中心筛选。
const GLOBAL_MARKET_REGION = 19000001;
const GLOBAL_MARKET_TYPES = new Set([44992]);

async function loadMarketData(typeId) {
  // 快速切换物品时取消上一轮请求，并丢弃过期结果
  state.loadController?.abort();
  const controller = new AbortController();
  state.loadController = controller;
  const seq = ++state.loadSeq;
  const globalMarket = GLOBAL_MARKET_TYPES.has(Number(typeId));
  state.globalMarket = globalMarket;
  const regionId = globalMarket ? GLOBAL_MARKET_REGION : state.regionId;
  setLoading(true);
  $('updateTag').textContent = '更新中…';

  try {
    const [orders, history] = regionId ? await Promise.all([
      fetchESIPaged(`/markets/${regionId}/orders/?order_type=all&type_id=${typeId}`, { signal: controller.signal }),
      fetchESI(`/markets/${regionId}/history/?type_id=${typeId}`, { signal: controller.signal }).catch((error) => {
        if (error.name === 'AbortError') throw error;
        return []; // 部分物品没有历史数据会返回 404
      })
    ]) : await fetchUniverseMarket(typeId, controller.signal, (done, total) => { if (seq === state.loadSeq) $('updateTag').textContent = `更新中… ${done}/${total} 个星域`; });
    if (seq !== state.loadSeq) return;

    state.orders = orders || [];
    state.history = (history || []).sort((a, b) => new Date(b.date) - new Date(a.date));

    renderStats();
    renderOrders();
    renderHistory();
    if (state.contentTab === 'chart') renderChart();
    $('updateTag').textContent = (globalMarket ? '全服统一市场 · ' : '') + '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('updateTag').title = globalMarket ? '伊甸币全服统一交易：订单不分星域，所列空间站只是挂单地点' : '';
    setLoading(false);

    // 地点名称与全服均价不阻塞首屏渲染。全宇宙订单多，只解析最便宜的卖单 / 最高的买单所在地（列表默认按价格排序）
    const named = regionId ? state.orders : [
      ...state.orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price).slice(0, 200),
      ...state.orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price).slice(0, 200)
    ];
    resolveLocations(named).then(() => { if (seq === state.loadSeq) renderOrders(); });
    loadStructureOrders(typeId, seq);
    refreshCharJumps().then((changed) => { if (changed && seq === state.loadSeq) renderOrders(); });
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

// 全宇宙：ESI 订单只能按星域查，逐个星域查询后合并；
// 价格历史取该物品订单最多的 12 个星域按日期汇总（成交量相加，均价按成交量加权，最高 / 最低取极值），其余星域成交很少
async function fetchUniverseMarket(typeId, signal, onProgress) {
  const regions = await loadMarketRegions();
  const counts = new Map();
  const orders = [];
  let done = 0;
  const queue = regions.map((r) => r.id);
  onProgress(0, regions.length);
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const list = await fetchESIPaged(`/markets/${id}/orders/?order_type=all&type_id=${typeId}`, { signal });
        if (list.length) { counts.set(id, list.length); orders.push(...list); }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
      onProgress(++done, regions.length);
    }
  }));
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  const lists = await Promise.all(top.map((id) => fetchESI(`/markets/${id}/history/?type_id=${typeId}`, { signal }).catch((error) => {
    if (error.name === 'AbortError') throw error;
    return [];
  })));
  const byDate = new Map();
  for (const h of lists.flat()) {
    const d = byDate.get(h.date);
    if (!d) { byDate.set(h.date, { date: h.date, volume: h.volume, order_count: h.order_count, highest: h.highest, lowest: h.lowest, sum: h.average * h.volume }); continue; }
    d.volume += h.volume;
    d.order_count += h.order_count;
    d.highest = Math.max(d.highest, h.highest);
    d.lowest = Math.min(d.lowest, h.lowest);
    d.sum += h.average * h.volume;
  }
  const history = [...byDate.values()].map(({ sum, ...d }) => ({ ...d, average: d.volume ? sum / d.volume : (d.highest + d.lowest) / 2 }));
  return [orders, history];
}

async function resolveLocations(orders) {
  await loadNpcNames();
  const ids = [...new Set(orders.map((o) => o.location_id))].filter((id) => id && !state.locationCache.has(id));
  // NPC 空间站用官方中文名；玩家建筑名称为玩家自定义，公开接口拿不到时显示 ID
  ids.forEach((id) => {
    const official = officialName(id);
    if (official) state.locationCache.set(id, official);
  });
  const structures = ids.filter((id) => id >= 1e12);
  if (structures.length) {
    await resolveStructureNames(structures);
    // 查不到名称时至少显示所在星系（订单里带 system_id）
    const systemOf = new Map(orders.map((o) => [o.location_id, o.system_id]));
    for (const id of structures) {
      const sys = officialName(systemOf.get(id));
      state.locationCache.set(id, structureNameOf(id) || (sys ? sys + ' · 玩家建筑（名称不公开）' : '玩家建筑（名称不公开）'));
    }
  }
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

// 角色当前所在星域（绑定 ESI 后点「当前位置」）：选择器里单独一项，不限交易中心，显示整个星域的订单
function locRegion() {
  const loc = store.getJSON(serverKey(LOC_REGION_KEY), null);
  return loc?.id ? { id: loc.id, name: loc.name, hub: null, here: loc.system, loc: true } : null;
}

const UNIVERSE = { id: 0, name: '全宇宙', hub: null, all: true };

// 全部星域（宁静 / 晨曦 70 个、曙光 59 个，含只有玩家建筑市场的 00 星域；虫洞、深渊没有市场）
let marketRegionsPromise = null;
function loadMarketRegions() {
  if (!marketRegionsPromise) {
    marketRegionsPromise = fetch(SERVER.mapData).then((r) => r.json()).then((d) => {
      const used = new Set(d.systems.map((sys) => sys[6]));
      state.marketRegions = d.regions.filter((r) => used.has(r[0])).map((r) => ({ id: r[0], name: r[1] }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return state.marketRegions;
    }).catch((error) => { marketRegionsPromise = null; throw error; });
  }
  return marketRegionsPromise;
}

// ===== 玩家建筑市场（选了具体星域时）=====
// 星域订单接口只含开放公共市场的建筑；其他建筑要用角色授权逐个读 /markets/structures/{id}/
// （esi-markets.structure_markets.v1，且角色要有该建筑的停靠权限，否则 403）。
// 只有铁壁 / 星城（含势力版）能装市场模块。建筑市场接口不分物品，读一次整个建筑缓存 5 分钟，换物品不再请求。
const MARKET_STRUCTURE_TYPES = new Set([35833, 35834, 40340, 47512, 47513, 47514, 47515, 47516]);
const STRUCT_MARKET_SCOPE = 'esi-markets.structure_markets.v1';
const STRUCT_MARKET_TTL = 5 * 60e3;
const STRUCT_MARKET_MAX_PAGES = 50;       // 超过 5 万条订单的大型市场跳过（这类一般是公开市场，订单已在星域订单里）
const structMarkets = new Map();          // 建筑 ID -> { at, promise }
let publicMarketIds = null;
let systemRegionPromise = null;

function hasScope(token, scope) {
  const list = Array.isArray(token?.scopes) ? token.scopes : String(token?.scopes || '').split(/\s+/);
  return list.includes(scope);
}

// ===== 额外权限（绑定时按需勾选）=====
// 基础权限来自服务器配置；以下功能的权限在绑定框里勾选后追加到授权链接。
// 宁静服：本站在 CCP 开发者后台注册的应用必须也开了这些权限，否则 CCP 会拒绝授权，此时取消勾选即可。
const SCOPE_GROUPS = [
  { id: 'ui', name: '游戏内操作', desc: '设为目的地、写入自动导航、在游戏里打开市场 / 合同窗口', scopes: ['esi-ui.write_waypoint.v1', 'esi-ui.open_window.v1'] },
  { id: 'fatigue', name: '跳跃疲劳', desc: '旗舰跳跃规划读取角色当前的跳跃疲劳', scopes: ['esi-characters.read_fatigue.v1'] },
  { id: 'planets', name: '行星殖民地', desc: '行星工业页显示我的殖民地、提取器到期时间与仓库存量', scopes: ['esi-planets.manage_planets.v1'] },
  { id: 'research', name: '研究代理人', desc: '个人中心显示研究代理人累计的研究点数', scopes: ['esi-characters.read_agents_research.v1'] },
  { id: 'fleet', name: '舰队', desc: '个人中心显示当前舰队成员、舰船与位置分布（需舰队指挥）', scopes: ['esi-fleets.read_fleet.v1'] },
  { id: 'corp', name: '军团管理', desc: '军团钱包、订单、工业任务、建筑燃料、月矿、资产（需相应军团职位）',
    scopes: ['esi-characters.read_corporation_roles.v1', 'esi-wallet.read_corporation_wallets.v1', 'esi-markets.read_corporation_orders.v1',
      'esi-industry.read_corporation_jobs.v1', 'esi-corporations.read_structures.v1', 'esi-industry.read_corporation_mining.v1',
      'esi-assets.read_corporation_assets.v1', 'esi-corporations.read_divisions.v1'] }
];
const SCOPE_GROUP_KEY = 'eve-esi-scope-groups';
function selectedScopeGroups() {
  const saved = store.get(SCOPE_GROUP_KEY);
  return saved == null ? SCOPE_GROUPS.map((g) => g.id) : saved.split(',').filter(Boolean);
}
function renderScopeGroups(focus) {
  const chosen = new Set(selectedScopeGroups());
  if (focus) chosen.add(focus);
  $('scopeGroupList').innerHTML = SCOPE_GROUPS.map((g) => `<label class="scope-group${g.id === focus ? ' focus' : ''}">
      <input type="checkbox" value="${g.id}"${chosen.has(g.id) ? ' checked' : ''}><span><b>${esc(g.name)}</b><small>${esc(g.desc)}</small></span></label>`).join('');
  updateScopeGroupCount();
  if (focus) $('scopeGroups').open = true;
}
function updateScopeGroupCount() {
  const n = $('scopeGroupList').querySelectorAll('input:checked').length;
  $('scopeGroupCount').textContent = `已选 ${n} / ${SCOPE_GROUPS.length} 项`;
}
function chosenExtraScopes() {
  const ids = [...$('scopeGroupList').querySelectorAll('input:checked')].map((i) => i.value);
  store.set(SCOPE_GROUP_KEY, ids.join(','));
  return SCOPE_GROUPS.filter((g) => ids.includes(g.id)).flatMap((g) => g.scopes);
}
// 当前角色是否有某组权限
function hasScopeGroup(id) {
  const token = state.esiToken || readEsiToken();
  const g = SCOPE_GROUPS.find((x) => x.id === id);
  return Boolean(token && g && g.scopes.every((sc) => hasScope(token, sc)));
}
// 缺权限时的提示块（按钮打开绑定框并勾上这一组）
function scopeNeededHtml(id, what) {
  const g = SCOPE_GROUPS.find((x) => x.id === id);
  return `<div class="empty-state scope-needed"><p>${esc(what || g.desc)}需要「${esc(g.name)}」权限，当前角色的授权里没有。重新授权时勾选这一项即可（同一角色只更新令牌）。</p>
    <button class="btn btn-primary" data-scope-rebind="${id}">重新授权</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope-rebind]');
  if (b) { if (state.currentView !== 'profile') switchView('profile'); openEsiModal(b.dataset.scopeRebind); }
});

// ===== 游戏内操作（esi-ui.*）：网页上点一下，游戏客户端里生效（角色需在线）=====
async function gameUi(path, params, okText) {
  if (!hasScopeGroup('ui')) { openEsiModal('ui'); showToast('需要「游戏内操作」权限：请重新授权并勾选这一项', 'error', 4000); return false; }
  try {
    await esiAuthFetch(path + '?' + new URLSearchParams(params), { method: 'POST' });
    showToast(okText, 'success');
    return true;
  } catch (error) {
    showToast('游戏内操作失败：' + error.message + '（角色需要在线）', 'error', 4000);
    return false;
  }
}
const gameActions = {
  // 设为目的地（clear=true）或添加途经点；id 可以是星系或空间站 / 建筑
  waypoint: (id, { clear = true, first = false, name = '' } = {}) => gameUi('/ui/autopilot/waypoint/',
    { destination_id: id, clear_other_waypoints: clear, add_to_beginning: first }, clear ? `已在游戏里设为目的地${name ? '：' + name : ''}` : `已添加途经点${name ? '：' + name : ''}`),
  // 整条路线写入自动导航：第一个清空原有航点，其余依次追加
  route: async (ids, name = '') => {
    if (!ids.length) return false;
    for (let i = 0; i < ids.length; i++) {
      if (!hasScopeGroup('ui')) return gameUi('/ui/autopilot/waypoint/', {}, '');
      try {
        await esiAuthFetch('/ui/autopilot/waypoint/?' + new URLSearchParams({ destination_id: ids[i], clear_other_waypoints: i === 0, add_to_beginning: false }), { method: 'POST' });
      } catch (error) { showToast('写入自动导航失败：' + error.message + '（角色需要在线）', 'error', 4000); return false; }
    }
    showToast(`已写入自动导航：${ids.length} 个航点${name ? ' · ' + name : ''}`, 'success');
    return true;
  },
  market: (typeId) => gameUi('/ui/openwindow/marketdetails/', { type_id: typeId }, '已在游戏里打开市场详情'),
  contract: (contractId) => gameUi('/ui/openwindow/contract/', { contract_id: contractId }, '已在游戏里打开合同窗口'),
  info: (targetId) => gameUi('/ui/openwindow/information/', { target_id: targetId }, '已在游戏里打开信息窗口')
};

// 星系 → 星域（map-data.json 与星图共用缓存）
function systemRegions() {
  if (!systemRegionPromise) {
    systemRegionPromise = fetch(SERVER.mapData).then((r) => r.json())
      .then((d) => new Map(d.systems.map((sys) => [sys[0], sys[6]])))
      .catch((error) => { systemRegionPromise = null; throw error; });
  }
  return systemRegionPromise;
}

// 本星域内可能有市场的玩家建筑：公开市场建筑列表 + 本地已知的建筑（资产、订单、跳跃规划搜索过的），按所在星系筛选
async function regionMarketStructures(regionId, onStatus) {
  if (!publicMarketIds) publicMarketIds = fetchESI('/universe/structures/?filter=market').catch(() => { publicMarketIds = null; return []; });
  const [regions, ids] = await Promise.all([systemRegions(), publicMarketIds, loadSharedStructures()]);
  const map = structureNameMap();
  const unknown = ids.filter((id) => !map.has(id));
  if (unknown.length) {
    onStatus(`识别玩家建筑所在星系（${unknown.length} 座，首次较慢）…`);
    await resolveStructureNames(unknown);
  }
  const pub = new Set(ids);
  return [...new Set([...ids, ...map.keys()])].filter((id) => {
    const v = map.get(id);
    return v?.s && regions.get(v.s) === regionId && (pub.has(id) || MARKET_STRUCTURE_TYPES.has(v.t));
  });
}

// 读取一座建筑的全部订单，按物品分组；无权限返回 { denied }，订单太多返回 { tooBig }
function structureMarket(id) {
  const hit = structMarkets.get(id);
  if (hit && Date.now() - hit.at < STRUCT_MARKET_TTL) return hit.promise;
  const entry = { at: Date.now() };
  entry.promise = (async () => {
    const token = await ensureEsiToken();
    const get = (page) => fetch(`${ESI_BASE}/markets/structures/${id}/?datasource=${SERVER.datasource}&page=${page}`, { headers: { Authorization: 'Bearer ' + token.access_token } });
    const first = await get(1);
    if (first.status === 403 || first.status === 404) return { denied: true };
    if (!first.ok) throw new Error('ESI ' + first.status);
    const pages = Number(first.headers.get('X-Pages')) || 1;
    if (pages > STRUCT_MARKET_MAX_PAGES) return { tooBig: true };
    const lists = [await first.json()];
    for (let p = 2; p <= pages; p += 4) {
      const batch = Array.from({ length: Math.min(4, pages - p + 1) }, (_, i) => get(p + i).then((r) => (r.ok ? r.json() : [])));
      lists.push(...await Promise.all(batch));
    }
    const byType = new Map();
    for (const o of lists.flat()) {
      if (!byType.has(o.type_id)) byType.set(o.type_id, []);
      byType.get(o.type_id).push(o);
    }
    return { byType };
  })().catch((error) => { structMarkets.delete(id); throw error; });
  structMarkets.set(id, entry);
  return entry.promise;
}

// 选了具体星域（含当前位置）时：把本星域可读的玩家建筑订单并入订单簿（按订单号去重，公开市场建筑的订单本来就在星域订单里）
async function loadStructureOrders(typeId, seq) {
  const note = $('structOrdersNote');
  const show = (text, warn = false) => {
    if (seq !== state.loadSeq) return;
    note.textContent = text;
    note.classList.toggle('warn', warn);
    note.hidden = !text;
  };
  const token = state.esiToken || readEsiToken();
  if (!state.regionId || state.globalMarket || !token?.access_token) return show('');   // 全宇宙不读玩家建筑（星域太多）；全服统一市场的订单已全部在星域订单里
  if (!hasScope(token, STRUCT_MARKET_SCOPE)) return show('玩家建筑里的订单需要「建筑市场」授权（esi-markets.structure_markets.v1），重新绑定 ESI 后可查看', true);
  try {
    show('查找本星域的玩家建筑市场…');
    const ids = await regionMarketStructures(state.regionId, show);
    if (seq !== state.loadSeq) return;
    if (!ids.length) return show('本星域没有找到可读取的玩家建筑市场');
    let done = 0;
    const results = [];
    const queue = ids.slice();
    show(`读取玩家建筑订单 0/${ids.length}`);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        results.push([id, await structureMarket(id).catch(() => null)]);
        show(`读取玩家建筑订单 ${++done}/${ids.length}`);
      }
    }));
    if (seq !== state.loadSeq) return;
    const known = new Set(state.orders.map((o) => o.order_id));
    const map = structureNameMap();
    let readable = 0, withOrders = 0, added = 0, denied = 0, big = 0, failed = 0;
    for (const [id, r] of results) {
      if (!r) { failed++; continue; }
      if (r.denied) { denied++; continue; }
      if (r.tooBig) { big++; continue; }
      readable++;
      const list = r.byType.get(typeId) || [];
      if (list.length) withOrders++;
      for (const o of list) {
        if (known.has(o.order_id)) continue;
        known.add(o.order_id);
        state.orders.push({ ...o, system_id: map.get(id)?.s });
        added++;
      }
    }
    if (added) {
      renderStats();
      renderOrders();
      resolveLocations(state.orders).then(() => { if (seq === state.loadSeq) renderOrders(); });
    }
    show(`玩家建筑：读取 ${readable} 座市场，${withOrders} 座有本物品订单${added ? `（星域订单之外另有 ${added} 条，已并入）` : ''}`
      + (denied ? `；${denied} 座没有停靠权限` : '') + (big ? `；${big} 座订单过多跳过` : '') + (failed ? `；${failed} 座读取失败` : ''));
  } catch (error) {
    show('读取玩家建筑订单失败：' + error.message, true);
  }
}

function currentRegion() {
  if (state.locMode) return locRegion() || UNIVERSE;
  if (!state.regionId) return UNIVERSE;
  return REGIONS.find((r) => r.id === state.regionId)
    || { id: state.regionId, name: state.marketRegions.find((r) => r.id === state.regionId)?.name || '星域 ' + state.regionId, hub: null };
}

// 「仅交易中心」：全宇宙时为五大交易中心，选了有交易中心的星域时为该交易中心
function sideOrders(isBuy) {
  const region = currentRegion();
  const hubs = region.all ? new Set(REGIONS.map((r) => r.hub.id)) : region.hub ? new Set([region.hub.id]) : null;
  return state.orders.filter((o) => o.is_buy_order === isBuy && (!state.hubOnly || !hubs || state.globalMarket || hubs.has(o.location_id)));
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
    // 税后倒卖利润：挂收单买入付中介费，挂卖单卖出付销售税 + 中介费（技能与税费设置全站共用）
    const f = TF.fees();
    const cost = maxBuy * (1 + f.broker);
    const profit = TF.flipProfit(maxBuy, minSell);
    setStat('spreadValue', (profit > 0 ? '+' : '') + formatStatPrice(profit), 'spreadMeta',
      `利润率 ${((profit / cost) * 100).toFixed(1)}% · ${spread < 0 ? '买卖倒挂' : '价差 ' + formatStatPrice(spread)}`);
    $('spreadValue').classList.toggle('down', profit < 0);
    $('spreadCard').title = `买卖价差 ${formatPrice(spread)} ISK（${((spread / maxBuy) * 100).toFixed(2)}%）\n每件税后利润 ${formatPrice(profit)} ISK\n按 ${formatPrice(maxBuy)} 挂收单买入（+中介费 ${TF.pct2(f.broker)}），按 ${formatPrice(minSell)} 挂卖单卖出（−销售税 ${TF.pct2(f.sales)} −中介费 ${TF.pct2(f.broker)}）\n${TF.skillSummary()} · 点击调整技能与税费`;
  } else {
    setStat('spreadValue', '—', 'spreadMeta', '数据不足');
    $('spreadValue').classList.remove('down');
    $('spreadCard').title = '点击调整技能与税费';
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
  let { key, dir } = state.orderSort[side];
  if (key === 'jumps' && !state.jumps) ({ key, dir } = { key: 'price', dir: side === 'sell' ? 'asc' : 'desc' });   // 解绑 ESI 后退回按价格
  const sign = dir === 'asc' ? 1 : -1;
  const best = side === 'sell' ? 1 : -1;
  if (key === 'jumps') {
    // 同样跳数时价格更优的在前；到不了的（虫洞、未知星系）排最后
    const jumps = new Map(list.map((o) => [o, orderJumps(o)]));
    return [...list].sort((a, b) => {
      const ja = jumps.get(a), jb = jumps.get(b);
      if (ja !== jb) return ja === Infinity ? 1 : jb === Infinity ? -1 : (ja - jb) * sign;
      return (a.price - b.price) * best;
    });
  }
  const value = (o) => key === 'total' ? o.price * o.volume_remain : key === 'issued' ? new Date(o.issued).getTime() : o[key];
  return [...list].sort((a, b) => (value(a) - value(b)) * sign);
}

// ===== 距角色跳数（绑定 ESI 时）=====
// 角色位置缓存 1 分钟；星门图来自 map-data.json，从角色所在星系做一次广度优先搜索得到到各星系的最少跳数
const CHAR_LOC_TTL = 60e3;
const charLoc = { key: '', at: 0, promise: null };
let gateGraphPromise = null;

function gateGraph() {
  if (!gateGraphPromise) {
    gateGraphPromise = fetch(SERVER.mapData).then((r) => r.json()).then((d) => {
      const index = new Map(d.systems.map((sys, i) => [sys[0], i]));
      const adj = d.systems.map(() => []);
      for (const [a, b] of d.gates || []) { adj[a].push(b); adj[b].push(a); }
      return { index, adj, systems: d.systems };
    }).catch((error) => { gateGraphPromise = null; throw error; });
  }
  return gateGraphPromise;
}

function bfsJumps(graph, from) {
  const dist = new Int16Array(graph.adj.length).fill(-1);
  const start = graph.index.get(from);
  if (start == null) return dist;
  dist[start] = 0;
  const queue = [start];
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (const v of graph.adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; queue.push(v); }
  }
  return dist;
}

function orderJumps(o) {
  const j = state.jumps;
  const i = j && j.index.get(o.system_id);
  const d = i == null ? -1 : j.dist[i];
  return d < 0 ? Infinity : d;
}

// 返回 true 表示跳数有变化，需要重绘订单表
function refreshCharJumps() {
  const token = state.esiToken || readEsiToken();
  if (!token?.access_token) {
    const had = Boolean(state.jumps);
    state.jumps = null;
    return Promise.resolve(had);
  }
  const key = serverKey(String(token.character_id));
  if (charLoc.key === key && (charLoc.promise || Date.now() - charLoc.at < CHAR_LOC_TTL)) return charLoc.promise || Promise.resolve(false);
  charLoc.key = key;
  charLoc.promise = (async () => {
    try {
      const [loc, graph] = await Promise.all([esiAuthFetch('/characters/' + token.character_id + '/location/'), gateGraph()]);
      if (charLoc.key !== key) return false;
      charLoc.at = Date.now();
      if (state.jumps?.key === key && state.jumps.systemId === loc.solar_system_id) return false;
      const i = graph.index.get(loc.solar_system_id);
      state.jumps = { key, systemId: loc.solar_system_id, name: i == null ? '' : graph.systems[i][1], index: graph.index, dist: bfsJumps(graph, loc.solar_system_id) };
      updateJumpsColumn();
      return true;
    } catch (error) {
      // 没有位置权限或请求失败：不显示跳数，1 分钟后再试
      charLoc.at = Date.now();
      const had = Boolean(state.jumps);
      state.jumps = null;
      updateJumpsColumn();
      return had;
    } finally {
      charLoc.promise = null;
    }
  })();
  return charLoc.promise;
}

function updateJumpsColumn() {
  const j = state.jumps;
  document.querySelector('.orders-container')?.classList.toggle('has-jumps', Boolean(j));
  $$('th.col-jumps').forEach((th) => {
    th.title = j ? `到角色所在星系 ${j.name || ''} 的最少星门跳数，点击按由近到远排序` : '';
  });
}

function jumpsCell(o) {
  const d = state.jumps ? orderJumps(o) : null;
  const text = d == null ? '' : d === Infinity ? '—' : d + '<span class="jumps-unit"> 跳</span>';
  const title = d === 0 ? ' title="就在角色所在星系"' : d === Infinity ? ' title="星门无法到达"' : '';
  return `<td class="num col-jumps${d === 0 ? ' is-here' : ''}"${title}>${text}</td>`;
}

// 地点前标注类型：NPC 空间站 / 玩家建筑（玩家建筑 ID ≥ 1e12）
function locationCell(order) {
  const name = state.locationCache.get(order.location_id);
  const isStructure = order.location_id >= 1e12;
  const badge = isStructure ? '<span class="loc-badge is-player">玩家建筑</span>' : '<span class="loc-badge">NPC建筑</span>';
  const label = name ? (isStructure ? name.replace('玩家建筑（名称不公开）', '名称不公开') : name) : '载入中…';
  return `<td class="loc" title="${esc(name || 'ID ' + order.location_id)}">${badge}${esc(label)}</td>`;
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
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${emptyText || (state.hubOnly ? '交易中心无' + (isBuy ? '买单' : '卖单') : '无' + (isBuy ? '买单' : '卖单'))}</td></tr>`;
  } else {
    body.innerHTML = list.map((o) => `<tr data-price="${o.price}"${o.price === best ? ' class="best"' : ''}>
        <td class="num price">${formatPrice(o.price)}</td>
        <td class="num">${formatNumber(o.volume_remain)}</td>
        <td class="num muted col-total">${formatISK(o.price * o.volume_remain)}</td>
        ${locationCell(o)}
        ${jumpsCell(o)}
        <td class="num muted col-date">${isBuy ? esc(rangeLabel(o.range)) : formatTime(o.issued)}</td>
      </tr>`).join('');
  }
  const unnamed = list.filter((o) => !state.locationCache.has(o.location_id) && !pendingLocations.has(o.location_id));
  if (unnamed.length) {
    unnamed.forEach((o) => pendingLocations.add(o.location_id));
    const seq = state.loadSeq;
    resolveLocations(unnamed).finally(() => {
      unnamed.forEach((o) => pendingLocations.delete(o.location_id));
      if (seq === state.loadSeq) renderOrderTable(side);
    });
  }
  $$(`th.sortable[data-side="${side}"]`).forEach((th) => {
    const active = th.dataset.key === state.orderSort[side].key;
    th.classList.toggle('sorted', active);
    th.dataset.dir = active ? state.orderSort[side].dir : '';
    th.setAttribute('aria-sort', active ? (state.orderSort[side].dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

const pendingLocations = new Set();

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
      else state.orderSort[side] = { key: th.dataset.key, dir: (th.dataset.key === 'price' && side === 'sell') || th.dataset.key === 'jumps' ? 'asc' : 'desc' };
      renderOrderTable(side);
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
  });
  // 其他页面动态生成的可排序表头（制造、LP 商店、击杀成员等）：键盘 Enter / 空格触发点击
  document.addEventListener('keydown', (e) => {
    const th = e.target.closest?.('th.sortable:not([data-side])');
    if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); th.click(); }
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
  $('spreadCard').addEventListener('click', () => TF.openFeeDialog());

  const hub = $('hubOnly');
  hub.checked = state.hubOnly;
  hub.addEventListener('change', () => {
    state.hubOnly = hub.checked;
    store.set('eve-hub-only-v2', state.hubOnly ? '1' : '0');
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
  const region = currentRegion();
  $('hubOnlyLabel').textContent = region.all ? '仅五大交易中心' : region.hub ? '仅' + region.hub.name : state.locMode ? '整个星域（当前位置）' : '仅交易中心（本星域未设）';
  $('hubOnly').disabled = !region.all && !region.hub;
}

function renderRegionOptions() {
  const select = $('regionSelect');
  const loc = locRegion();
  const others = state.marketRegions.filter((r) => !REGIONS.some((h) => h.id === r.id));
  // 选中的星域还没载入列表时先补一项，避免显示成别的
  if (state.regionId && !state.locMode && !REGIONS.some((r) => r.id === state.regionId) && !others.some((r) => r.id === state.regionId)) others.unshift(currentRegion());
  select.innerHTML = '<option value="all">全宇宙（所有星域）</option>'
    + (loc ? `<option value="loc">当前位置 · ${esc(loc.name)}（${esc(loc.here || '')}）</option>` : '')
    + `<optgroup label="主要交易中心">${REGIONS.map((r) => `<option value="${r.id}">${esc(r.name)} · ${esc(r.hub.name.split(' ')[0])}</option>`).join('')}</optgroup>`
    + (others.length ? `<optgroup label="其他星域">${others.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</optgroup>` : '');
  select.value = state.locMode ? 'loc' : state.regionId ? String(state.regionId) : 'all';
}

function initRegionSelect() {
  const select = $('regionSelect');
  renderRegionOptions();
  updateHubLabel();
  loadMarketRegions().then(renderRegionOptions).catch(() => {});
  select.addEventListener('change', () => {
    state.locMode = select.value === 'loc';
    state.regionId = state.locMode ? locRegion().id : Number(select.value) || 0;
    store.set(MARKET_REGION_KEY, select.value);
    updateHubLabel();
    if (state.selectedItem) loadMarketData(state.selectedItem.id);
  });
  $('locRegionBtn').addEventListener('click', useLocationRegion);
  updateLocRegionBtn();
}

// 绑定 ESI 后才显示「当前位置」
function updateLocRegionBtn() {
  const btn = $('locRegionBtn');
  if (btn) btn.hidden = !(state.esiToken || readEsiToken())?.access_token;
}

// 读取角色所在星系 → 星座 → 星域，切换市场到该星域（需要 esi-location.read_location.v1）
async function useLocationRegion() {
  const btn = $('locRegionBtn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const token = await ensureEsiToken();
    let loc;
    try {
      loc = await esiAuthFetch('/characters/' + token.character_id + '/location/');
    } catch (error) {
      if (error.status === 403 || error.status === 401) throw new Error('当前授权没有位置权限，请在个人中心重新绑定 ESI');
      throw error;
    }
    const sys = await fetchESI(`/universe/systems/${loc.solar_system_id}/?language=zh`);
    const con = await fetchESI(`/universe/constellations/${sys.constellation_id}/`);
    const regionId = con.region_id;
    if (regionId >= 11000000) throw new Error(`${sys.name} 在虫洞里，虫洞没有市场`);
    const name = REGIONS.find((r) => r.id === regionId)?.name || (await fetchESI(`/universe/regions/${regionId}/?language=zh`)).name;
    store.setJSON(serverKey(LOC_REGION_KEY), { id: regionId, name, system: sys.name });
    state.locMode = true;
    state.regionId = regionId;
    store.set(MARKET_REGION_KEY, 'loc');
    renderRegionOptions();
    updateHubLabel();
    showToast(`已切换到 ${name}（${token.character_name || '角色'}在 ${sys.name}）`, 'success', 2600);
    if (state.selectedItem) loadMarketData(state.selectedItem.id);
  } catch (error) {
    showToast('获取当前位置失败：' + error.message, 'error', 4000);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function refreshCurrent() {
  if (state.selectedItem && !$('refreshBtn').disabled) loadMarketData(state.selectedItem.id);
}

function initDetailActions() {
  $('refreshBtn').addEventListener('click', refreshCurrent);
  $('gameMarketBtn').addEventListener('click', () => state.selectedItem && gameActions.market(state.selectedItem.id));
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
  initViewHashTracking();
  window.addEventListener('popstate', () => {
    // 击杀记录页 / 星图的地址由各自页面处理；从其他页面后退到这些地址时切换过去
    if (location.hash.startsWith('#kb')) { if (state.currentView !== 'kb') switchView('kb'); return; }
    if (location.hash.startsWith('#map')) { if (state.currentView !== 'map') switchView('map'); return; }
    if (location.hash.startsWith('#fit')) { if (state.currentView !== 'fit') switchView('fit'); return; }
    if (location.hash.startsWith('#pi')) { if (state.currentView !== 'pi') switchView('pi'); return; }
    if (location.hash.startsWith('#ind')) { if (state.currentView !== 'industry') switchView('industry'); else openIndustry(); return; }
    if (location.hash.startsWith('#lp')) { if (state.currentView !== 'lp') switchView('lp'); else openLp(); return; }
    if (location.hash.startsWith('#appr')) { if (state.currentView !== 'appraisal') switchView('appraisal'); return; }
    if (location.hash.startsWith('#courier')) { if (state.currentView !== 'courier') switchView('courier'); return; }
    if (location.hash.startsWith('#war')) { if (state.currentView !== 'war') switchView('war'); return; }
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

// ===== 个人中心 =====
// EVE SSO 使用纯前端 PKCE 授权：授权码换令牌、刷新令牌都由浏览器直接请求 login.eveonline.com，
// 令牌只保存在本机 localStorage，本站服务器全程接触不到。服务器只提供公开的应用配置（Client ID、回调地址、权限列表）。
const ESI_API = '/api/esi';
const ESI_BASE = SERVER.esi;
const SSO_BASE = SERVER.sso;
const SERVER_QS = IS_TQ ? '' : '?server=' + SERVER.id;   // 本站接口按服务器区分（宁静服不带参数，兼容旧版）
const PKCE_KEY = 'eve-esi-pkce';          // 授权中的 state -> { verifier, at }（回调可能落在新标签页，所以放 localStorage）
const PKCE_TTL = 15 * 60e3;

function readEsiToken() {
  try { return JSON.parse(localStorage.getItem(serverKey('eve-esi-token')) || 'null'); } catch { return null; }
}

// 多账号：eve-esi-token 是当前使用的角色，eve-esi-accounts 保存所有已绑定角色的令牌（按服务器分开）
const ACCOUNTS_KEY = serverKey('eve-esi-accounts');
function readEsiAccounts() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch { /* 忽略 */ }
  if (!Array.isArray(list)) list = [];
  list = list.filter((a) => a?.character_id && a.access_token);
  // 旧版只存了一个令牌：并入列表
  const active = state.esiToken || readEsiToken();
  if (active?.character_id && !list.some((a) => a.character_id === active.character_id)) list.unshift(active);
  return list;
}

function writeEsiAccounts(list) {
  try {
    if (list.length) localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
    else localStorage.removeItem(ACCOUNTS_KEY);
  } catch { /* 忽略 */ }
}

// 先 writeEsiToken(null) 再调用，否则当前令牌会被当作旧版单令牌重新并入
function removeEsiAccount(id) {
  writeEsiAccounts(readEsiAccounts().filter((a) => a.character_id !== id));
}

function writeEsiToken(token) {
  // 新绑定或刷新后的令牌同步进账号列表（先读列表，旧版单令牌才能在被覆盖前并入）
  const list = readEsiAccounts();
  if (token?.character_id) {
    const i = list.findIndex((a) => a.character_id === token.character_id);
    if (i >= 0) list[i] = token; else list.push(token);
  }
  writeEsiAccounts(list);
  state.esiToken = token;
  if (token) localStorage.setItem(serverKey('eve-esi-token'), JSON.stringify(token));
  else localStorage.removeItem(serverKey('eve-esi-token'));
  updateLocRegionBtn();
  if (!token && state.jumps) { state.jumps = null; charLoc.key = ''; updateJumpsColumn(); renderOrders(); }
}

function setEsiStatus(message, kind) {
  const el = $('esiStatus');
  if (el) { el.textContent = message || ''; el.className = 'status-msg' + (kind ? ' ' + kind : ''); }
}

// ---------- SSO（浏览器直连 CCP）----------
let ssoConfigPromise = null;
function ssoConfig() {
  if (!ssoConfigPromise) {
    ssoConfigPromise = fetch(ESI_API + '/config' + SERVER_QS).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.client_id) throw new Error(data.error || '读取应用配置失败 ' + res.status);
      return data;
    }).catch((error) => { ssoConfigPromise = null; throw error; });
  }
  return ssoConfigPromise;
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(size) {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  if (crypto.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return sha256Fallback(data);   // 非 HTTPS 页面没有 crypto.subtle
}

// 纯 JS SHA-256（仅在非安全上下文中使用）
function sha256Fallback(data) {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length, total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  new DataView(buf.buffer).setUint32(total - 4, len * 8);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    const view = new DataView(buf.buffer, off, 64);
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  H.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
}

function readPkce() {
  try {
    const all = JSON.parse(localStorage.getItem(PKCE_KEY) || '{}');
    const now = Date.now();
    for (const k of Object.keys(all)) if (!(now - all[k].at < PKCE_TTL)) delete all[k];
    return all;
  } catch { return {}; }
}

function writePkce(all) {
  try {
    if (Object.keys(all).length) localStorage.setItem(PKCE_KEY, JSON.stringify(all));
    else localStorage.removeItem(PKCE_KEY);
  } catch { /* 忽略 */ }
}

// 直接向 CCP 请求令牌（授权码 / 刷新令牌）；CCP 对部分错误返回 HTML 页面，统一转成可读的提示
async function ssoToken(params) {
  const cfg = await ssoConfig();
  let res;
  try {
    // 网易 SSO 不支持跨域，经本站原样转发；宁静服浏览器直连 CCP
    res = await fetch(SERVER.tokenProxy ? ESI_API + '/sso/token' + SERVER_QS : SSO_BASE + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: cfg.client_id })
    });
  } catch {
    throw new Error('无法连接 EVE 登录服务器，请检查网络后重试');
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* HTML 错误页 */ }
  if (!res.ok || !data.access_token) {
    // 网易登录服务器对无效 / 过期的授权码只返回 500 和一句通用错误
    const netease = !IS_TQ && res.status === 500 ? '授权码无效或已过期（网易授权码几分钟内失效，请重新登录后尽快粘贴）' : '';
    const reason = data.error_description || data.error || netease || (text.startsWith('<') ? '授权码无效或已被使用' : 'HTTP ' + res.status);
    const error = new Error(reason);
    error.status = res.status;
    throw error;
  }
  return data;
}

// 从 access_token（JWT）读取角色身份与权限；令牌由浏览器经 HTTPS 直接从 CCP 取得
function tokenIdentity(accessToken, clientId) {
  const part = accessToken.split('.')[1] || '';
  const json = decodeURIComponent(escape(atob(part.replace(/-/g, '+').replace(/_/g, '/'))));
  const claims = JSON.parse(json);
  const aud = [].concat(claims.aud || []);
  if (clientId && aud.length && !aud.includes(clientId)) throw new Error('令牌不属于本应用');
  const id = Number(String(claims.sub || '').split(':').pop());
  if (!id) throw new Error('令牌中没有角色信息');
  return { character_id: id, character_name: claims.name || '角色 ' + id, scopes: [].concat(claims.scp || []) };
}

function tokenRecord(data, base = {}) {
  return { ...base, access_token: data.access_token, refresh_token: data.refresh_token || base.refresh_token,
    expires_in: data.expires_in, expires_at: Date.now() + (data.expires_in || 1199) * 1000 };
}

// 同时有多个请求发现令牌过期时只刷新一次（CCP 的刷新令牌用一次就会更换，并发刷新会让后一个失败）
let refreshing = null;
async function ensureEsiToken() {
  const token = state.esiToken || readEsiToken();
  if (!token || !token.access_token) throw new Error('尚未绑定 ESI');
  if (Date.now() <= (token.expires_at || 0) - 60000) return token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const data = await ssoToken({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
        const fresh = tokenRecord(data, token);
        try { Object.assign(fresh, tokenIdentity(data.access_token)); } catch { /* 保留原身份 */ }
        writeEsiToken(fresh);
        return fresh;
      } catch (error) {
        // 只有 CCP 明确拒绝（4xx）时才清除令牌；网络错误保留，下次再试
        if (error.status >= 400 && error.status < 500) {
          writeEsiToken(null);
          removeEsiAccount(token.character_id);
          throw new Error('登录已过期，请重新绑定（' + error.message + '）');
        }
        throw error;
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

// 已绑定角色的技能等级（skill_id -> 生效等级），缓存 10 分钟；跳跃规划与模拟装配共用
let skillCache = null;   // { id, at, promise }
function getCharacterSkills() {
  const token = state.esiToken || readEsiToken();
  if (!token?.access_token) return Promise.reject(new Error('尚未绑定 ESI'));
  const id = token.character_id;
  if (skillCache && skillCache.id === id && Date.now() - skillCache.at < 10 * 60e3) return skillCache.promise;
  const promise = (async () => {
    const data = state.characterData?.skills && !state.characterData.skills.__error && myCharacterId() === id
      ? state.characterData.skills
      : await esiAuthFetch('/characters/' + id + '/skills/');
    // active_skill_level 为当前生效等级（Alpha 克隆受限时低于已训练等级）
    const levels = new Map((data.skills || []).map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0]));
    return { id, name: token.character_name || ('角色 ' + id), levels };
  })();
  skillCache = { id, at: Date.now(), promise };
  promise.catch(() => { if (skillCache?.promise === promise) skillCache = null; });
  return promise;
}

// 已绑定角色的基础声望（from_id -> standing，不含社交技能加成），缓存 10 分钟；交易税费与星图代理人共用
// 需要 esi-characters.read_standings.v1
let standingCache = null;   // { id, at, promise }
function getCharacterStandings() {
  const token = state.esiToken || readEsiToken();
  if (!token?.access_token) return Promise.reject(new Error('尚未绑定 ESI'));
  const id = token.character_id;
  if (standingCache && standingCache.id === id && Date.now() - standingCache.at < 10 * 60e3) return standingCache.promise;
  const promise = (async () => {
    if (!hasScope(token, 'esi-characters.read_standings.v1')) throw new Error('授权里没有声望权限，请重新绑定 ESI');
    const list = await esiAuthFetch('/characters/' + id + '/standings/');
    return { id, name: token.character_name || ('角色 ' + id), map: new Map((list || []).map((x) => [x.from_id, x.standing])) };
  })();
  standingCache = { id, at: Date.now(), promise };
  promise.catch(() => { if (standingCache?.promise === promise) standingCache = null; });
  return promise;
}

// 角色当前的跳跃疲劳（需要「跳跃疲劳」权限）：{ minutes 剩余分钟, expires }；没有权限时返回 null
async function getFatigue() {
  if (!hasScopeGroup('fatigue')) return null;
  const token = await ensureEsiToken();
  const f = await esiAuthFetch('/characters/' + token.character_id + '/fatigue/');
  const expires = f.jump_fatigue_expire_date ? new Date(f.jump_fatigue_expire_date).getTime() : 0;
  return { minutes: Math.max(0, (expires - Date.now()) / 60e3), expires, lastJump: f.last_jump_date || null };
}

// 舰船保险（公开接口 /insurance/prices/）：type_id -> [{ name, cost, payout }]，按赔付从低到高
let insurancePromise = null;
const INSURANCE_ZH = { Basic: '基础', Standard: '标准', Bronze: '青铜', Silver: '白银', Gold: '黄金', Platinum: '铂金' };
function getInsurance() {
  if (!insurancePromise) {
    insurancePromise = fetchESI('/insurance/prices/?language=en').then((list) => new Map((list || []).map((x) => [x.type_id,
      (x.levels || []).map((l) => ({ name: INSURANCE_ZH[l.name] || l.name, cost: l.cost, payout: l.payout })).sort((a, b) => a.payout - b.payout)])))
      .catch((error) => { insurancePromise = null; throw error; });
  }
  return insurancePromise;
}

// NPC 空间站所属军团及该军团的阵营（中介费按这两项声望计算）
// ESI 的 NPC 军团资料没有阵营字段，军团 -> 阵营取 SDE 生成的 npc-corp-faction.json（build_npc.mjs）
const stationOwners = new Map();
let corpFactionPromise = null;
function stationOwner(stationId) {
  if (!stationOwners.has(stationId)) {
    if (!corpFactionPromise) corpFactionPromise = fetch('./npc-corp-faction.json?v=2').then((r) => r.json()).catch(() => { corpFactionPromise = null; return { corps: {}, factions: {} }; });
    const p = (async () => {
      const [st, table] = await Promise.all([fetchESI('/universe/stations/' + stationId + '/'), corpFactionPromise]);
      const faction = table.corps[st.owner] || 0;
      return { corp: st.owner, faction, factionName: table.factions[faction] || '' };
    })();
    p.catch(() => stationOwners.delete(stationId));
    stationOwners.set(stationId, p);
  }
  return stationOwners.get(stationId);
}

// 已绑定角色当前的植入体（需要 esi-clones.read_implants.v1）
async function getCharacterImplants() {
  const token = await ensureEsiToken();
  return esiAuthFetch('/characters/' + token.character_id + '/implants/');
}

async function esiAuthFetch(path, options = {}) {
  const token = await ensureEsiToken();
  const url = ESI_BASE + path + (path.includes('?') ? '&' : '?') + 'datasource=' + SERVER.datasource;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { Authorization: 'Bearer ' + token.access_token, 'Accept-Language': 'zh', ...(options.headers || {}) },
    body: options.body
  });
  if (!res.ok) {
    // 保留 ESI 返回的错误说明（如缺少授权范围、装配数量已满）
    const error = new Error('ESI ' + res.status);
    error.status = res.status;
    error.esiError = await res.json().then((d) => d.error || '', () => '');
    throw error;
  }
  return res.status === 204 ? null : res.json();
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

// 估值卡片里的税后金额（技能与税费设置见 trade-fees.js）
const netLine = (label, v) => '<span class="valuation-net">' + label + ' <b>' + formatISK(v) + '</b></span>';
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
    const res = await fetch(ESI_BASE + '/universe/names/?datasource=' + SERVER.datasource, {
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
      fetch(ESI_BASE + '/universe/types/' + id + '/?datasource=' + SERVER.datasource + '&language=zh')
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
    state.universeTables[path] = fetch(ESI_BASE + path + '?datasource=' + SERVER.datasource, { headers: { 'Accept-Language': 'zh' } })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return state.universeTables[path];
}

// 角色资产接口分页（X-Pages），每页 1000 条
async function esiAuthFetchPaged(path, maxPages = 20) {
  const token = await ensureEsiToken();
  const get = async (page) => {
    const url = ESI_BASE + path + (path.includes('?') ? '&' : '?') + 'datasource=' + SERVER.datasource + '&page=' + page;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token.access_token } });
    if (!res.ok) { const error = new Error('ESI ' + res.status); error.status = res.status; throw error; }
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

// 位置名称：官方中文表（NPC 空间站/星系）→ 玩家建筑游戏内名称 → ID 兜底
function locationName(id) {
  const official = officialName(id);
  if (official) return official;
  if (id === ASSET_SAFETY_ID) return '资产安全';
  const known = structureNameOf(id) || state.esiNames?.get(Number(id));
  if (known) return known;
  return id >= 1e12 ? '玩家建筑（名称不公开）' : '位置 #' + id;
}

// ===== 玩家建筑名称 =====
// 玩家建筑名称是玩家自定义的，来源依次为：本地名称缓存 → 跳跃规划读过的建筑列表 → 服务器共享的公开建筑缓存
// → 带授权读取 /universe/structures/{id}/（需 esi-universe.read_structures.v1，且角色有权查看）。
// 查不到的建筑记一天，避免反复请求消耗 ESI 错误额度。
const STRUCTURE_NAMES_KEY = serverKey('eve-structure-names-v1');
const STRUCTURE_NAME_TTL = 7 * 86400e3;
const STRUCTURE_MISS_TTL = 86400e3;
let structureNames = null;   // id -> { n: 名称, s: 星系, t: 类型, at }，n 为空表示查不到
let sharedStructuresPromise = null;

function structureNameMap() {
  if (structureNames) return structureNames;
  structureNames = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(STRUCTURE_NAMES_KEY) || '{}');
    const now = Date.now();
    for (const [id, v] of Object.entries(raw)) {
      if (v && now - v.at < (v.n ? STRUCTURE_NAME_TTL : STRUCTURE_MISS_TTL)) structureNames.set(Number(id), v);
    }
  } catch { /* 忽略 */ }
  // 跳跃规划读过的公开 / 内部建筑列表（本地缓存 24 小时）
  try {
    const c = JSON.parse(localStorage.getItem(serverKey('eve-public-structures-v1')) || 'null');
    if (c && Array.isArray(c.list)) {
      for (const st of [...c.list, ...(c.private || [])]) {
        if (st?.id && st.name) structureNames.set(st.id, { n: st.name, s: st.system, t: st.type, at: c.at || Date.now() });
      }
    }
  } catch { /* 忽略 */ }
  return structureNames;
}

function saveStructureNames() {
  try {
    const obj = {};
    for (const [id, v] of structureNameMap()) obj[id] = v;
    localStorage.setItem(STRUCTURE_NAMES_KEY, JSON.stringify(obj));
  } catch { /* 忽略 */ }
}

function structureNameOf(id) {
  if (!(id >= 1e12)) return null;
  return structureNameMap().get(Number(id))?.n || null;
}

// 服务器共享缓存（其他用户读过的公开建筑），不需要授权，未部署时静默跳过
function loadSharedStructures() {
  if (!sharedStructuresPromise) {
    sharedStructuresPromise = fetch('/api/esi/structures' + SERVER_QS)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!c || !Array.isArray(c.list)) return;
        const map = structureNameMap();
        for (const st of c.list) if (st?.id && st.name && !map.get(st.id)?.n) map.set(st.id, { n: st.name, s: st.system, t: st.type, at: c.at || Date.now() });
      })
      .catch(() => {});
  }
  return sharedStructuresPromise;
}

// 解析一批建筑名称；未绑定 ESI 时只用缓存与共享数据。返回是否有新名称（调用方据此重绘）
async function resolveStructureNames(ids) {
  const map = structureNameMap();
  let list = [...new Set(ids.map(Number))].filter((id) => id >= 1e12 && !map.has(id));
  if (!list.length) return false;
  await loadSharedStructures();
  list = list.filter((id) => !map.has(id));
  const token = state.esiToken || readEsiToken();
  if (list.length && token) {
    const queue = list.slice(0, 300);
    let stop = false;
    const worker = async () => {
      while (queue.length && !stop) {
        const id = queue.shift();
        try {
          const info = await esiAuthFetch('/universe/structures/' + id + '/');
          map.set(id, { n: info?.name || '', s: info?.solar_system_id, t: info?.type_id, at: Date.now() });
        } catch (error) {
          // 403 = 无权查看；401 或其他错误（授权失效、网络）不记缓存，并停止本批请求
          if (/ESI 403/.test(error.message)) map.set(id, { n: '', at: Date.now() });
          else stop = true;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }
  saveStructureNames();
  return ids.some((id) => structureNameOf(id));
}

// 显示名：官方中文优先，玩家军团/联盟/角色保留原名
function displayName(id) {
  if (!id) return '—';
  return officialName(id) || state.esiNames?.get(Number(id)) || 'ID ' + id;
}

function loadProfile() {
  let token = state.esiToken || readEsiToken();
  // 当前角色被解绑或令牌失效时，自动换到下一个已绑定角色
  if (!token) {
    const next = readEsiAccounts()[0];
    if (next) { writeEsiToken(next); resetCharacterState(); token = next; }
  }
  renderEsiAccounts();
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
  $('profileAvatar').src = eveImage('characters/' + id + '/portrait', 128);
  $('profileName').textContent = token.character_name || ('角色 ' + id);
  $('profileCorp').textContent = '数据读取中…';
  $('profileChips').innerHTML = '';
  $('profileHeroStats').hidden = true;
  $('profileData').innerHTML = skCards(5) + skTitle(12) + skRows(6) + skTitle(16) + skRows(4);
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
  if (myCharacterId() !== id) return;   // 读取期间切换了角色，丢弃旧角色的数据
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
    ...ordersList.map((o) => o.location_id),
    state.characterData.location?.structure_id || 0
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
  const data = state.characterData;
  state.locationIconType = await resolveLocationIconType(data.location);
  if (state.characterData !== data) return;   // 读取期间切换了角色

  renderProfileHero();
  renderProfileStationNav(stationSummaries());
  renderProfileTab(activeProfileTab());
  prefetchAssetPrices();
  prefetchProfileTabs();
}

// 读完角色数据后，空闲时在后台读取战斗记录（zKillboard，缓存 5 分钟）与合同，打开对应标签页时直接显示
function prefetchProfileTabs() {
  const data = state.characterData;
  whenIdle(async () => {
    if (state.characterData !== data) return;   // 已解绑或重新读取
    const me = myCharacterId();
    if (SERVER.kb) try {
      const kb = await loadKillboard();
      const [kills] = await Promise.all([
        kb.fetchZkill(`characterID/${me}/`),
        kb.fetchZkill(`stats/characterID/${me}/`).catch(() => null)
      ]);
      await kb.prepareKills(kills);
    } catch { /* 后台预取失败不提示，打开战斗记录时会重试 */ }
    if (state.characterData === data && !state.contracts) loadContracts().catch(() => {});
  }, 4000);
}

// 浏览器空闲时执行（不支持 requestIdleCallback 时延迟执行）
function whenIdle(fn, timeout = 3000) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => fn(), { timeout });
  else window.setTimeout(fn, Math.min(timeout, 1500));
}

// ===== 游戏内图标（EVE 官方图片服务器）=====
const GAME_ICON = {
  capsule: 670,        // 太空舱：飞行员诞生
  skillbook: 3300,     // 技能书
  structure: 35832,    // 星城（玩家建筑类型需授权才能查询，统一用空堡图标）
  concord: 1000125     // 统合部
};

function gameImage(path, size = 64) {
  return eveImage(path, size);
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

// regionId:typeId -> { sell, buy, at }；保存在本地 12 小时，重新打开页面不必重查。点「刷新行情」清空当前市场
const HUB_PRICE_KEY = serverKey('eve-hub-prices-v2');   // v2：伊甸币改查全服统一市场，旧缓存里是空价格
const HUB_PRICE_TTL = 12 * 3600e3;
state.hubPriceCache = loadHubPriceCache();
state.hubPriceInflight = new Map();   // 正在查询的物品，后台预取与页面渲染共用同一请求
state.profileStation = null; // 当前查看的空间站（null 表示资产总估值）

function loadHubPriceCache() {
  const map = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(HUB_PRICE_KEY) || '{}');
    const now = Date.now();
    for (const [key, [sell, buy, at]] of Object.entries(raw)) {
      if (now - at < HUB_PRICE_TTL) map.set(key, { sell, buy, at });
    }
  } catch { /* 忽略 */ }
  return map;
}

function saveHubPriceCache() {
  try {
    const obj = {};
    for (const [key, v] of state.hubPriceCache) if (!v.failed) obj[key] = [v.sell, v.buy, v.at || Date.now()];
    localStorage.setItem(HUB_PRICE_KEY, JSON.stringify(obj));
  } catch { /* 存储已满或隐私模式：只保留会话内缓存 */ }
}

// 当前市场行情中最早的查询时间（用于提示行情新旧）
function hubPriceTime(region, typeIds) {
  let oldest = Infinity;
  for (const t of typeIds) {
    const at = state.hubPriceCache.get(region.id + ':' + t)?.at;
    if (at && at < oldest) oldest = at;
  }
  return Number.isFinite(oldest) ? oldest : null;
}

async function fetchHubPrices(region, typeIds, onProgress) {
  const keyOf = (t) => region.id + ':' + t;
  const todo = typeIds.filter((t) => !state.hubPriceCache.has(keyOf(t)) && !state.hubPriceInflight.has(keyOf(t)));
  const waiting = typeIds.map((t) => state.hubPriceInflight.get(keyOf(t))).filter(Boolean);
  let done = typeIds.length - todo.length - waiting.length;
  onProgress?.(done, typeIds.length);
  waiting.forEach((p) => p.then(() => onProgress?.(++done, typeIds.length)));
  const resolvers = new Map();
  for (const t of todo) state.hubPriceInflight.set(keyOf(t), new Promise((res) => resolvers.set(t, res)));
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const typeId = todo[cursor++];
      let entry = { sell: null, buy: null, at: Date.now() };
      try {
        const global = GLOBAL_MARKET_TYPES.has(Number(typeId));   // 伊甸币：全服统一市场，不限交易中心
        const orders = await fetchESIPaged(`/markets/${global ? GLOBAL_MARKET_REGION : region.id}/orders/?order_type=all&type_id=${typeId}`);
        for (const o of orders) {
          if (!global && o.location_id !== region.hub.id) continue;
          if (o.is_buy_order) entry.buy = entry.buy === null ? o.price : Math.max(entry.buy, o.price);
          else entry.sell = entry.sell === null ? o.price : Math.min(entry.sell, o.price);
        }
      } catch { entry = { sell: null, buy: null, failed: true }; }
      state.hubPriceCache.set(keyOf(typeId), entry);
      state.hubPriceInflight.delete(keyOf(typeId));
      resolvers.get(typeId)();
      onProgress?.(++done, typeIds.length);
    }
  };
  await Promise.all([...Array.from({ length: 8 }, worker), ...waiting]);
  if (todo.length) saveHubPriceCache();
}

// 需要查询行情的资产物品：蓝图副本无法出售；没有全服均价的物品基本不可交易。按估算价值排序，最多 1500 种
async function tradableAssetTypes(assets) {
  const avgMap = await getMarketPriceMap();
  const qtyByType = new Map();
  assets.forEach((a) => { if (!a.is_blueprint_copy) qtyByType.set(a.type_id, (qtyByType.get(a.type_id) || 0) + valuationQuantity(a.quantity)); });
  return [...qtyByType.keys()].filter((t) => avgMap.size === 0 || avgMap.has(t))
    .sort((x, y) => (avgMap.get(y) || 0) * qtyByType.get(y) - (avgMap.get(x) || 0) * qtyByType.get(x))
    .slice(0, 1500);
}

// 绑定后读完角色数据，浏览器空闲时在后台算好资产估值所需行情；打开资产页时直接用缓存
function prefetchAssetPrices() {
  const assets = state.characterData?.assets;
  if (!Array.isArray(assets) || !assets.length) return;
  const run = async () => {
    try {
      if (state.characterData?.assets !== assets) return;   // 已解绑或重新读取
      const region = valuationRegion();
      const tradable = await tradableAssetTypes(assets);
      if (tradable.some((t) => !state.hubPriceCache.has(region.id + ':' + t))) await fetchHubPrices(region, tradable);
      if (state.characterData?.assets === assets) renderProfileStationNav(stationSummaries());
    } catch { /* 后台预取失败不提示，打开资产页时会重试 */ }
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 5000 });
  else window.setTimeout(run, 1500);
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

// ===== 突变装备（深渊）：/dogma/dynamic/items/{type_id}/{item_id}/ =====
// 每件突变装备属性不同，资产里只能看到型号；按 item_id 读真实属性，与原型装备（source_type_id）的属性逐项对比。
// 属性中文名与单位来自 dogma-attr-zh.json（build_dogma_names.mjs 由 SDE 生成）。击杀邮件里没有 item_id，无法读取。
const isMutated = (name, a) => a.is_singleton && /深渊|Abyssal/.test(name) && !/纤维|Filament/.test(name);
let dogmaNamesPromise = null;
const dogmaNames = () => dogmaNamesPromise || (dogmaNamesPromise = fetch('./dogma-attr-zh.json?v=1').then((r) => r.json()).catch(() => { dogmaNamesPromise = null; return { attrs: {}, units: {} }; }));
const SKIP_UNITS = new Set([115, 116, 117, 119, 129, 136, 137, 140, 141, 142]);
function fmtAttr(v, unit, units) {
  const n = (x, d = 2) => Number(x.toFixed(d)).toLocaleString('zh-CN');
  switch (unit) {
    case 101: return n(v / 1000) + ' 秒';
    case 108: case 111: return n((1 - v) * 100) + '%';
    case 109: return n((v - 1) * 100) + '%';
    case 127: return n(v * 100) + '%';
    default: return n(v) + (units[unit] ? ' ' + units[unit] : '');
  }
}
async function openDynamicItem(typeId, itemId) {
  let modal = $('dynModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'dynModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-dyn-close></div><div class="modal-content dyn-modal">
      <div class="modal-header"><h3 id="dynTitle">突变属性</h3><button class="modal-close" data-dyn-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="dynBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-dyn-close]')) modal.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
  }
  modal.hidden = false;
  const body = $('dynBody');
  body.innerHTML = '<div class="pi-loading">读取突变属性…</div>';
  try {
    const [dyn, names] = await Promise.all([fetchESI(`/dogma/dynamic/items/${typeId}/${itemId}/`), dogmaNames()]);
    const [source, typeNames] = await Promise.all([
      fetchESI(`/universe/types/${dyn.source_type_id}/`).catch(() => null),
      resolveTypeNames([typeId, dyn.source_type_id, dyn.mutator_type_id])
    ]);
    const base = new Map((source?.dogma_attributes || []).map((x) => [x.attribute_id, x.value]));
    const rows = dyn.dogma_attributes.map((x) => ({ id: x.attribute_id, value: x.value, base: base.get(x.attribute_id), meta: names.attrs[x.attribute_id] }))
      .filter((r) => r.meta && !SKIP_UNITS.has(r.meta[1]) && r.base !== undefined)
      // 负值属性（如缠绕光束的速度加成 -50%）按绝对值比较：幅度越大效果越强
      .map((r) => ({ ...r, diff: !r.base ? 0 : r.base < 0 ? (Math.abs(r.value) - Math.abs(r.base)) / Math.abs(r.base) : (r.value - r.base) / Math.abs(r.base) }))
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const changed = rows.filter((r) => Math.abs(r.diff) > 1e-6);
    const creator = dyn.created_by ? (await resolveNames([dyn.created_by]).catch(() => ({ names: new Map() }))).names.get(dyn.created_by) : '';
    $('dynTitle').textContent = typeNames.get(typeId) || '突变属性';
    const row = (r) => {
      // 百分比类单位（108/111）数值越小越好显示时取反
      const better = r.meta[2] ? r.diff > 0 : r.diff < 0;
      const cls = Math.abs(r.diff) < 1e-6 ? '' : better ? 'up' : 'down';
      return `<tr><td>${esc(r.meta[0])}</td><td>${esc(fmtAttr(r.base, r.meta[1], names.units))}</td><td><b class="${cls}">${esc(fmtAttr(r.value, r.meta[1], names.units))}</b></td>
        <td class="${cls}">${Math.abs(r.diff) < 1e-6 ? '—' : (r.diff > 0 ? '+' : '') + (r.diff * 100).toFixed(1) + '%'}</td></tr>`;
    };
    body.innerHTML = `<p class="dyn-meta">原型：<b>${esc(typeNames.get(dyn.source_type_id) || dyn.source_type_id)}</b> · 突变质体：${esc(typeNames.get(dyn.mutator_type_id) || dyn.mutator_type_id)}${creator ? ' · 制作者：' + esc(creator) : ''}</p>
      <div class="table-scroll"><table class="pc-mini-table"><thead><tr><th>属性</th><th>原型</th><th>突变后</th><th>变化</th></tr></thead><tbody>${changed.map(row).join('')}</tbody></table></div>
      ${rows.length > changed.length ? `<details class="dyn-more"><summary>未变化的属性（${rows.length - changed.length}）</summary><table class="pc-mini-table"><tbody>${rows.filter((r) => !changed.includes(r)).map(row).join('')}</tbody></table></details>` : ''}
      <p class="text-muted valuation-note">绿色表示比原型更好，红色表示更差（按 SDE 的「数值越大越好」判断）。</p>`;
  } catch (error) {
    body.innerHTML = '<p class="text-muted">突变属性读取失败：' + esc(error.message) + '</p>';
  }
}

function assetSlotLabel(asset) {
  const flag = assetFlagLabel(asset.location_flag);
  return asset.parent ? flag + ' · ' + typeName(asset.parent.type_id) : flag;
}

// 确保当前估价市场的行情已查询完毕；渲染已过期（切走/换站）时返回 null
async function ensureAssetPrices(box, assets, seq) {
  const region = valuationRegion();
  const tradable = await tradableAssetTypes(assets);
  if (seq !== state.assetRenderSeq) return null;
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
    '<button class="btn btn-ghost" id="tradeFeeBtn" title="技能与交易税费：估值卡片的税后金额按此计算">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg><span>' + esc(TF.summary()) + '</span></button>' +
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
  $('tradeFeeBtn')?.addEventListener('click', () => TF.openFeeDialog());
  $('refreshPricesBtn').addEventListener('click', () => {
    for (const key of [...state.hubPriceCache.keys()]) if (key.startsWith(region.id + ':')) state.hubPriceCache.delete(key);
    saveHubPriceCache();
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
  const priceAt = hubPriceTime(region, tradable);

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
      valuationCard('资产估值 · 最低卖价', formatISK(assetSell) + ' ISK', sellPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有卖单' + netLine('挂卖单税后', assetSell * TF.netSell()), 'is-sell') +
      valuationCard('资产估值 · 最高收价', formatISK(assetBuy) + ' ISK', buyPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有收单' + netLine('卖给收单税后', assetBuy * TF.netBuy()), 'is-buy') +
      valuationCard('我的卖单', formatISK(sellOrderTotal) + ' ISK', sellOrders.length + ' 笔 · 剩余数量 × 委托价' + netLine('全部成交税后', sellOrderTotal * TF.netBuy()), 'is-order') +
      valuationCard('我的收单', formatISK(buyOrderTotal) + ' ISK', buyOrders.length + ' 笔 · 剩余数量 × 委托价', 'is-order') +
      valuationCard('资产 + 订单合计', formatISK(assetSell + sellOrderTotal + buyOrderTotal) + ' ISK',
        '按收价：' + formatISK(assetBuy + sellOrderTotal + buyOrderTotal) + ' ISK · 不含钱包', 'is-total') +
    '</div>' +
    '<p class="text-muted valuation-note">价格取 ' + esc(region.hub.name) + ' 空间站内的最低卖单价与最高收购价；蓝图副本不可上架、无行情的物品不计入。共 ' +
      formatNumber(assets.length) + ' 项资产，分布在 ' + groups.length + ' 个位置。' +
      (priceAt ? '行情查询于 ' + new Date(priceAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '，本地缓存 12 小时。' : '') +
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
      esc(name) + (a.is_blueprint_copy ? ' <span class="pill">蓝图副本</span>' : '') +
        (isMutated(name, a) ? ` <button class="pill dyn-btn" data-dyn="${a.type_id}:${a.item_id}" title="查看这件突变装备的真实属性">突变属性</button>` : ''),
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
      valuationCard('本站估值 · 最低卖价', formatISK(station.sell) + ' ISK', sellPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有卖单' + netLine('挂卖单税后', station.sell * TF.netSell()), 'is-sell') +
      valuationCard('本站估值 · 最高收价', formatISK(station.buy) + ' ISK', buyPriced + '/' + nonBpc.length + ' 项在 ' + esc(region.hub.name) + ' 有收单' + netLine('卖给收单税后', station.buy * TF.netBuy()), 'is-buy') +
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
  box.dataset.skills = '';   // 技能页的训练队列异步返回时，只在仍停留在技能页时重绘

  if (tab === 'skills') {
    try {
      const m = await loadSkillsModule();
      await m.renderSkills(box, data, (state.esiToken || readEsiToken())?.character_id);
    } catch (error) {
      box.innerHTML = '<p class="text-muted">技能页加载失败：' + esc(error.message) + '</p>';
    }
    return;
  }

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

  if (['clones', 'mining', 'research', 'fleet', 'corp'].includes(tab)) {
    try {
      const m = await loadMoreModule();
      if (activeProfileTab() === tab) await m.renderMore(tab, box);
    } catch (error) {
      box.innerHTML = '<p class="text-muted">页面加载失败：' + esc(error.message) + '</p>';
    }
    return;
  }

  if (tab === 'trades') {
    try {
      const m = await loadTradesModule();
      if (activeProfileTab() === 'trades') await m.renderTrades(box);
    } catch (error) {
      box.innerHTML = '<p class="text-muted">交易记录加载失败：' + esc(error.message) + '</p>';
    }
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

// 个人中心 · 技能：首次打开时加载
let skillsLoading = null;
function loadSkillsModule() {
  if (!skillsLoading) skillsLoading = import('./skills-page.js?v=v21').then((m) => {
    m.initSkills({ esc, formatNumber, esiAuthFetch, store });
    return m;
  }).catch((error) => { skillsLoading = null; throw error; });
  return skillsLoading;
}

// 个人中心 · 克隆 / 挖矿 / 研究 / 舰队 / 军团：首次打开时加载
let moreLoading = null;
function loadMoreModule() {
  if (!moreLoading) moreLoading = import('./profile-more.js?v=v1').then((m) => {
    m.initProfileMore({
      esc, formatISK, formatPrice, formatNumber, fetchESI, esiAuthFetch, esiAuthFetchPaged, resolveTypeNames, resolveNames,
      resolveStructureNames, locationName, officialName, gameImage, valuationCard, getCharacterSkills, getMarketPriceMap,
      openMapSystem, game: gameActions, hasScopeGroup, scopeNeededHtml,
      tokenInfo: () => state.esiToken || readEsiToken(),
      hasScope: (scope) => hasScope(state.esiToken || readEsiToken(), scope),
      isActive: (tab) => state.currentView === 'profile' && activeProfileTab() === tab
    });
    return m;
  }).catch((error) => { moreLoading = null; throw error; });
  return moreLoading;
}

// 个人中心 · 交易记录与盈亏：首次打开时加载
let tradesLoading = null;
function loadTradesModule() {
  if (!tradesLoading) tradesLoading = import('./trades.js?v=v1').then((m) => {
    m.initTrades({
      esc, formatISK, formatPrice, formatNumber, esiAuthFetch, esiAuthFetchPaged, resolveTypeNames, resolveNames,
      resolveStructureNames, locationName, officialName, gameImage, valuationCard,
      tokenInfo: () => state.esiToken || readEsiToken(),
      hasScope: (scope) => hasScope(state.esiToken || readEsiToken(), scope),
      selectItem: (typeId) => { switchView('market'); selectItem(typeId); },
      isActive: () => state.currentView === 'profile' && activeProfileTab() === 'trades'
    });
    return m;
  }).catch((error) => { tradesLoading = null; throw error; });
  return tradesLoading;
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

// 进行中的读取复用同一个 Promise（后台预取与打开合同页可能同时触发）
function loadContracts() {
  if (!state.contractsLoading) state.contractsLoading = loadContractsImpl().finally(() => { state.contractsLoading = null; });
  return state.contractsLoading;
}

async function loadContractsImpl() {
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
  if (!state.contracts || state.contractsLoading) {
    box.innerHTML = skCards(4, 'contract-grid') + skToolbar(4) + skRows(10);
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
    box.innerHTML = skCards(4, 'contract-grid') + skTitle(10) + skRows(8, { img: 24 });
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
        '<span class="pill type-' + c.type + '">' + esc(zhLabel(CONTRACT_TYPE_ZH, c.type, c.type)) + '</span> ' + esc(c.title || '（无标题）') + '</h3>' +
      `<button class="btn btn-ghost" data-game-contract="${c.contract_id}" title="在游戏里打开这个合同（需要「游戏内操作」权限，角色需在线）">游戏内打开</button>`) +
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

// ===== 国服战斗记录：zKillboard 不收录国服，改从 ESI 读角色最近的击杀邮件 =====
// /characters/{id}/killmails/recent/（esi-killmails.read_killmails.v1）给出击杀 ID 与 hash，
// 再逐个读公开的 /killmails/{id}/{hash}/。价值按 ESI 全服均价估算（舰船 + 物品，蓝图副本不计），格式与 zKillboard 一致以复用击杀列表与详情。
const KILLMAIL_SCOPE = 'esi-killmails.read_killmails.v1';
const esiKillCache = new Map();   // killmail_id -> 带估值的击杀（击杀邮件不会变）
let esiCombat = null;             // { id, at, promise }

function killmailWithValue(km, hash, prices) {
  let dropped = 0;
  let destroyed = prices.get(km.victim.ship_type_id) || 0;
  const walk = (items) => {
    for (const it of items || []) {
      const p = it.singleton === 2 ? 0 : prices.get(it.item_type_id) || 0;
      dropped += p * (it.quantity_dropped || 0);
      destroyed += p * (it.quantity_destroyed || 0);
      walk(it.items);
    }
  };
  walk(km.victim.items);
  const players = (km.attackers || []).filter((a) => a.character_id).length;
  return { ...km, zkb: { hash, totalValue: dropped + destroyed, droppedValue: dropped, destroyedValue: destroyed,
    solo: players === 1, npc: players === 0, awox: false, locationID: null, valueLabel: '按 ESI 全服均价估值' } };
}

function loadEsiKills() {
  const me = myCharacterId();
  if (esiCombat && esiCombat.id === me && Date.now() - esiCombat.at < 5 * 60e3) return esiCombat.promise;
  const promise = (async () => {
    const refs = (await esiAuthFetchPaged('/characters/' + me + '/killmails/recent/', 4)).slice(0, 200);
    const prices = await getMarketPriceMap();
    const kills = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < refs.length) {
        const ref = refs[cursor++];
        let kill = esiKillCache.get(ref.killmail_id);
        if (!kill) {
          try {
            kill = killmailWithValue(await fetchESI(`/killmails/${ref.killmail_id}/${ref.killmail_hash}/`), ref.killmail_hash, prices);
            esiKillCache.set(ref.killmail_id, kill);
          } catch { continue; }
        }
        kills.push(kill);
      }
    }));
    return kills.sort((a, b) => new Date(b.killmail_time) - new Date(a.killmail_time));
  })();
  esiCombat = { id: me, at: Date.now(), promise };
  promise.catch(() => { if (esiCombat?.promise === promise) esiCombat = null; });
  return promise;
}

async function renderEsiCombat(box) {
  const me = myCharacterId();
  const link = kbSiteLink('pilot', me);
  const siteBtn = link ? `<a class="btn btn-ghost" href="${link}" target="_blank" rel="noopener">在${esc(SERVER.kbSite.name)}查看 ↗</a>` : '';
  if (!hasScope(state.esiToken || readEsiToken(), KILLMAIL_SCOPE)) {
    box.innerHTML = '<div class="empty-state"><p>' + esc(SERVER.full) + '没有 zKillboard，站内战斗记录改从 ESI 读取，需要击杀记录权限（' + KILLMAIL_SCOPE + '）。' +
      '当前授权里没有这项权限，请重新授权当前角色（重新生成授权链接并登录，同一角色只会更新令牌）。</p>' +
      '<div class="empty-actions"><button class="btn btn-primary" data-esi-rebind>重新授权</button>' + siteBtn + '</div></div>';
    return;
  }
  box.innerHTML = skCards(6) + skToolbar(3) + skRows(10);
  let kb, kills;
  try {
    kb = await loadKillboard();
    kills = await loadEsiKills();
    if (activeProfileTab() !== 'combat' || myCharacterId() !== me) return;
    await kb.prepareKills(kills);
  } catch (error) {
    if (activeProfileTab() === 'combat') box.innerHTML = '<p class="text-muted">战斗记录读取失败：' + esc(error.message) + '</p>';
    return;
  }
  if (activeProfileTab() !== 'combat' || myCharacterId() !== me) return;
  const isLoss = (k) => k.victim.character_id === me;
  const losses = kills.filter(isLoss);
  const wins = kills.filter((k) => !isLoss(k));
  const finalBlows = wins.filter((k) => (k.attackers || []).some((a) => a.final_blow && a.character_id === me)).length;
  const solo = wins.filter((k) => k.zkb.solo).length;
  const sum = (list) => list.reduce((t, k) => t + (k.zkb.totalValue || 0), 0);
  const destroyedIsk = sum(wins), lostIsk = sum(losses);
  const efficiency = destroyedIsk + lostIsk ? destroyedIsk / (destroyedIsk + lostIsk) * 100 : null;
  const filter = state.combatFilter;
  const shown = filter === 'kills' ? wins : filter === 'losses' ? losses : kills;
  box.innerHTML =
    '<div class="valuation-grid">' +
      valuationCard('近期参与击杀', formatNumber(wins.length) + ' 艘', '单刷 ' + formatNumber(solo) + ' 次', 'is-buy') +
      valuationCard('最后一击', formatNumber(finalBlows) + ' 次', '参与击杀中', 'is-buy') +
      valuationCard('近期损失', formatNumber(losses.length) + ' 艘', '', 'is-sell') +
      valuationCard('击毁价值', formatISK(destroyedIsk) + ' ISK', '按全服均价估算', 'is-buy') +
      valuationCard('损失价值', formatISK(lostIsk) + ' ISK', '按全服均价估算', 'is-sell') +
      valuationCard('ISK 效率', efficiency == null ? '—' : efficiency.toFixed(1) + '%', '击毁 ÷（击毁 + 损失）', 'is-total') +
    '</div>' +
    '<div class="valuation-toolbar section-gap">' +
      '<div class="segmented" role="group" aria-label="战斗记录筛选">' +
        [['all', '全部', kills.length], ['kills', '参与击杀', wins.length], ['losses', '损失', losses.length]].map(([key, label, n]) =>
          `<button data-combat-filter="${key}" class="${filter === key ? 'active' : ''}">${label} <span class="seg-count">${n}</span></button>`).join('') +
      '</div>' +
      '<span class="toolbar-spacer"></span>' + siteBtn +
    '</div>' +
    '<div class="kb-list">' + kb.killTableHtml(shown, { me, showSide: true }) + '</div>' +
    '<p class="text-muted valuation-note">数据来自 ' + esc(SERVER.full) + ' ESI（角色最近的击杀邮件，最多 200 条），缓存 5 分钟；价值按 ESI 全服均价估算，与击杀网站的估值可能不同。点击记录查看装配与攻击者。</p>';
  kb.bindKillClicks(box.querySelector('.kb-list'), kills);
}

async function renderCombatTab(box) {
  const me = myCharacterId();
  if (!SERVER.kb) { await renderEsiCombat(box); return; }
  box.innerHTML = skCards(6) + skToolbar(3) + skRows(10);
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
  const finalBlows = wins.filter((k) => (k.attackers || []).some((a) => a.final_blow && a.character_id === me)).length;
  const sum = (list) => list.reduce((t, k) => t + (k.zkb.totalValue || 0), 0);
  const filter = state.combatFilter;
  const shown = filter === 'kills' ? wins : filter === 'losses' ? losses : kills;

  // 生涯统计（zKillboard stats）；没有数据时用近期记录估算
  const lifetime = stats && stats.shipsDestroyed !== undefined;
  const destroyedIsk = lifetime ? stats.iskDestroyed || 0 : sum(wins);
  const lostIsk = lifetime ? stats.iskLost || 0 : sum(losses);
  const efficiency = destroyedIsk + lostIsk ? destroyedIsk / (destroyedIsk + lostIsk) * 100 : null;
  const cards =
    valuationCard(lifetime ? '生涯参与击杀' : '近期参与击杀', formatNumber(lifetime ? stats.shipsDestroyed || 0 : wins.length) + ' 艘', lifetime ? '单刷 ' + formatNumber(stats.soloKills || 0) + ' 次' : '最近 ' + kills.length + ' 条记录', 'is-buy') +
    // zKillboard 生涯统计不含最后一击次数，只能按已读取的近期记录统计
    valuationCard('最后一击', formatNumber(finalBlows) + ' 次', '最近 ' + formatNumber(wins.length) + ' 次参与击杀中', 'is-buy') +
    valuationCard(lifetime ? '生涯损失' : '近期损失', formatNumber(lifetime ? stats.shipsLost || 0 : losses.length) + ' 艘', lifetime ? '单刷被杀 ' + formatNumber(stats.soloLosses || 0) + ' 次' : '', 'is-sell') +
    valuationCard('击毁价值', formatISK(destroyedIsk) + ' ISK', lifetime ? 'zKillboard 生涯统计' : '近期记录合计', 'is-buy') +
    valuationCard('损失价值', formatISK(lostIsk) + ' ISK', lifetime ? 'zKillboard 生涯统计' : '近期记录合计', 'is-sell') +
    valuationCard('ISK 效率', efficiency == null ? '—' : efficiency.toFixed(1) + '%',
      lifetime ? '危险度 ' + (stats.dangerRatio ?? '—') + '% · 团战 ' + (stats.gangRatio ?? '—') + '%' : '击毁 ÷（击毁 + 损失）', 'is-total');

  box.innerHTML =
    '<div class="valuation-grid">' + cards + '</div>' +
    '<div class="valuation-toolbar section-gap">' +
      '<div class="segmented" role="group" aria-label="战斗记录筛选">' +
        [['all', '全部', kills.length], ['kills', '参与击杀', wins.length], ['losses', '损失', losses.length]].map(([key, label, n]) =>
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
// 国服（晨曦 / 曙光）：网易登录需要一个设备 ID，由本站向网易申请（网易接口只接受官方页面来源，浏览器不能直接请求）
async function neteaseDevice() {
  const res = await fetch(ESI_API + '/sso/device' + SERVER_QS).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || !data.device_id) throw new Error(data.error || '网易设备初始化失败，请稍后重试');
  return { device_id: data.device_id };
}

async function generateAuthLink() {
  const btn = $('generateAuthBtn');
  btn.disabled = true;
  setEsiStatus('正在生成授权链接…');
  try {
    const cfg = await ssoConfig();
    // PKCE：verifier 只保存在本机，CCP 换令牌时校验，授权码被截获也无法使用
    const verifier = randomToken(48);
    const challenge = b64url(await sha256(verifier));
    const device = SERVER.needDevice ? await neteaseDevice() : {};
    const authState = randomToken(24);
    const pending = readPkce();
    pending[authState] = { verifier, at: Date.now(), server: SERVER.id };
    writePkce(pending);
    const url = SSO_BASE + '/authorize?' + new URLSearchParams({
      response_type: 'code',
      redirect_uri: cfg.redirect_uri,
      client_id: cfg.client_id,
      scope: [...new Set([...(cfg.scopes || []), ...chosenExtraScopes()])].join(' '),
      state: authState,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...SERVER.authParams,
      ...device
    });
    $('authLink').value = url;
    $('openAuthBtn').href = url;
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
    const pending = readPkce();
    const entry = pending[cbState];
    if (!entry) throw new Error('授权状态无效或已过期：请在本浏览器重新生成授权链接并登录（链接 15 分钟内有效）');
    let data;
    try {
      const extra = SERVER.manualCallback ? { redirect_uri: (await ssoConfig()).redirect_uri } : {};   // 网易换令牌要求带回调地址
      data = await ssoToken({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, ...extra });
    } catch (error) {
      throw new Error('CCP 拒绝了授权（' + error.message + '）。若提示授权码已使用，请重新生成授权链接并登录');
    } finally {
      delete pending[cbState];
      writePkce(pending);
    }
    const cfg = await ssoConfig();
    // 国服复用的是网易官方 ESI 网页的应用，令牌受众不是本站，不做核对
    const identity = tokenIdentity(data.access_token, IS_TQ ? cfg.client_id : null);
    const existed = readEsiAccounts().some((a) => a.character_id === identity.character_id);
    writeEsiToken({ ...tokenRecord(data), ...identity });
    $('callbackUrl').value = '';
    $('authLinkBox').hidden = true;
    setEsiStatus('');
    closeEsiModal();
    showToast((existed ? '已更新授权：' : '已绑定：') + identity.character_name, 'success');
    resetCharacterState();
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
  // 授权时选的服务器与当前不同（例如在另一个标签页切换过）：先切回授权时的服务器
  const pending = readPkce()[params.get('state')];
  if (pending?.server && pending.server !== SERVER.id) { setServer(pending.server); return; }
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

// ---------- 多账号切换 ----------
// 换角色后清掉按角色缓存的数据（角色数据、技能、跳数、各页面的「我的」数据）
function resetCharacterState() {
  state.characterData = null;
  state.profileStation = null;
  skillCache = null;
  standingCache = null;
  esiCombat = null;
  TF.resetCharacter();
  renderProfileStationNav([]);
  if (state.jumps || charLoc.key) {
    state.jumps = null;
    charLoc.key = '';
    updateJumpsColumn();
    if (state.orders) renderOrders();
  }
  window.dispatchEvent(new CustomEvent('eve-account-change'));
}

function switchEsiAccount(id) {
  if (id === myCharacterId()) return;
  const account = readEsiAccounts().find((a) => a.character_id === id);
  if (!account) return;
  writeEsiToken(account);
  resetCharacterState();
  loadProfile();
  showToast('已切换到 ' + (account.character_name || '角色 ' + id), 'success');
}

function renderEsiAccounts() {
  const box = $('profileAccounts');
  if (!box) return;
  const list = readEsiAccounts();
  const current = myCharacterId();
  box.hidden = !list.length;
  box.innerHTML = list.map((a) => {
    const active = a.character_id === current;
    return `<button type="button" class="account-chip${active ? ' active' : ''}" data-account="${a.character_id}" aria-pressed="${active}" title="${active ? '当前角色' : '切换到 ' + esc(a.character_name || '')}">
      <img src="${eveImage('characters/' + a.character_id + '/portrait', 64)}" alt="" width="24" height="24" loading="lazy"><span>${esc(a.character_name || '角色 ' + a.character_id)}</span></button>`;
  }).join('') + `<button type="button" class="account-chip account-add" data-account-add title="再绑定一个角色">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>添加角色</span></button>`;
}

function openEsiModal(scopeFocus) {
  modalReturnFocus = document.activeElement;
  renderScopeGroups(typeof scopeFocus === 'string' ? scopeFocus : null);
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
  $('scopeGroupList').addEventListener('change', () => { updateScopeGroupCount(); $('authLinkBox').hidden = true; });
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
    const token = state.esiToken || readEsiToken();
    const name = token?.character_name || '当前角色';
    const others = readEsiAccounts().length > 1;
    if (!window.confirm(`确定解绑 ${name}？本地保存的该角色 ESI 令牌将被清除。` + (others ? '解绑后自动切换到其它已绑定角色。' : ''))) return;
    writeEsiToken(null);
    if (token?.character_id) removeEsiAccount(token.character_id);
    resetCharacterState();
    loadProfile();
    showToast(`已解绑 ${name}，本地令牌已清除`, 'success');
  });
  $('profileAccounts')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-account-add]')) { openEsiModal(); return; }
    const chip = e.target.closest('[data-account]');
    if (chip) switchEsiAccount(Number(chip.dataset.account));
  });
  $$('.profile-tabs .tab-link').forEach((link) => link.addEventListener('click', () => switchProfileTab(link.dataset.profile)));
}


// ===== 击杀预警（kill-alert.js）：开启后才加载模块并开始检测 =====
const KILL_ALERT_KEY = serverKey('eve-kill-alert-v1');
let killAlertModule = null;
function loadKillAlert() {
  if (!killAlertModule) killAlertModule = import('./kill-alert.js?v=v3').then((m) => {
    m.initKillAlert({
      esc, formatISK, showToast, esiAuthFetch, gateGraph, bfsJumps, resolveTypeNames, resolveNames, officialName, eveImage,
      tokenInfo: () => state.esiToken || readEsiToken(),
      hasScope: (scope) => hasScope(state.esiToken || readEsiToken(), scope),
      openEsiBind: () => { switchView('profile'); openEsiModal(); },
      openKill: async (id) => { if (!id) return; const kb = await loadKillboard(); kb.openServiceKill(id); }
    });
    const sync = () => {
      const st = m.status();
      const btn = $('killAlertBtn');
      btn.classList.toggle('on', st.on);
      btn.title = '击杀预警：' + st.text;
    };
    m.onChange(sync);
    sync();
    return m;
  }).catch((error) => { killAlertModule = null; throw error; });
  return killAlertModule;
}
function initKillAlerts() {
  $('killAlertBtn').addEventListener('click', () => loadKillAlert().then((m) => m.openPanel()).catch((e) => showToast('击杀预警加载失败：' + e.message, 'error')));
  // 已开启的话页面打开即开始检测
  let on = false;
  try { const t = JSON.parse(localStorage.getItem(KILL_ALERT_KEY) || '{}'); on = t.on === true || (t.watchOn === true && t.watch?.length > 0); } catch { /* 忽略 */ }
  if (on) loadKillAlert().catch(() => {});
}

// ===== 初始化应用 =====
function init() {
  initKillAlerts();
  TF.initTradeFees({
    esc, showToast, getCharacterSkills, getCharacterStandings, stationOwner, officialName,
    hasEsiToken: () => Boolean((state.esiToken || readEsiToken())?.access_token),
    openEsiBind: () => { switchView('profile'); openEsiModal(); }
  });
  // 技能或税费改动：刷新市场详情的倒卖利润与资产估值
  TF.onChange(() => {
    if (state.selectedItem && state.orders) renderStats();
    if (state.characterData && activeProfileTab() === 'assets') renderProfileTab('assets');
  });
  initTheme();
  initServerSwitch();
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
  if (location.hash.startsWith('#fit')) switchView('fit');   // 装配分享链接
  if (location.hash.startsWith('#pi')) switchView('pi');     // 行星工业
  if (location.hash.startsWith('#ind')) switchView('industry');   // 制造
  if (location.hash.startsWith('#lp')) switchView('lp');          // LP 商店
  if (location.hash.startsWith('#appr')) switchView('appraisal'); // 估价
  if (location.hash.startsWith('#courier')) switchView('courier'); // 快递合同
  if (location.hash.startsWith('#war')) switchView('war'); // 战争
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
        preloadPages();
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

// 首屏与目录加载完后，空闲时依次预取击杀记录页与星图（模块 + 数据），用户点开时直接显示；省流量模式下不预取
function preloadPages() {
  if (navigator.connection?.saveData) return;
  whenIdle(async () => {
    if (SERVER.kb) try {
      const kbPage = await loadKbPageModule();
      await kbPage.prefetchKbHome();
    } catch { /* 未部署击杀记录服务等：打开页面时再处理 */ }
    whenIdle(async () => {
      try {
        const map = await loadStarMapModule();
        await map.preloadStarMap();
      } catch { /* 打开星图时会重试并提示 */ }
      whenIdle(async () => {
        try { await (await loadFittingModule()).preloadFitting(); } catch { /* 打开装配页时会重试并提示 */ }
      }, 8000);
    }, 5000);
  }, 3000);
}

// 启动应用
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
