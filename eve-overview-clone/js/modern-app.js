// ===== 配置与常量 =====
const API_BASE = 'https://esi.evetech.net/latest';
const IMAGE_BASE = 'https://images.evetech.net/types';

const REGIONS = [
  { id: 10000002, name: '伏尔戈 (The Forge)' },
  { id: 10000043, name: '阿玛尔 (Domain)' },
  { id: 10000032, name: '吉勒西斯 (Sinq Laison)' },
  { id: 10000030, name: '米玛塔尔 (Heimatar)' },
  { id: 10000042, name: '米玛塔尔 (Metropolis)' }
];

// ===== 应用状态 =====
const state = {
  theme: localStorage.getItem('eve-theme') || 'light',
  currentView: 'market',
  selectedItem: null,
  regionId: parseInt(localStorage.getItem('eve-region')) || 10000002,
  catalog: null,
  categories: new Map(),
  searchQuery: '',
  orders: [],
  history: [],
  priceData: null,
  locationCache: new Map(),
  esiToken: localStorage.getItem('eve-esi-token') || null,
  characterData: null,
  marketPriceMap: null,
  catalogReady: null
};

// ===== 工具函数 =====
const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);

function formatISK(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const num = parseFloat(value);
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatNumber(value, decimals = 0) {
  if (!value || isNaN(value)) return '—';
  return parseFloat(value).toLocaleString('zh-CN', {
    maximumFractionDigits: decimals
  });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  });
}

function formatTime(dateStr) {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return formatDate(dateStr);
}

function showToast(message, duration = 3000) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

async function fetchESI(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Accept-Language': 'zh',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('ESI请求失败:', error);
    throw error;
  }
}

// ===== 主题切换 =====
function initTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);

  $('themeToggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('eve-theme', state.theme);
  });
}

// ===== 视图切换 =====
function initNavigation() {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });
}

function switchView(view) {
  state.currentView = view;

  // 更新导航按钮状态
  $$('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // 切换视图容器
  $('marketView').hidden = view !== 'market';
  $('profileView').hidden = view !== 'profile';

  // 加载对应视图数据
  if (view === 'profile') {
    loadProfile();
  }
}

// ===== 侧边栏 =====
function initSidebar() {
  // 搜索功能
  const searchInput = $('itemSearch');
  let searchTimeout;

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = e.target.value.trim();
      renderCatalog();
    }, 300);
  });

  // 收起/展开
  $('sidebarCollapse').addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.toggle('collapsed');
  });

  $('profileSidebarCollapse')?.addEventListener('click', () => {
    $('profileSidebar').classList.toggle('collapsed');
  });

  $('profileNav')?.addEventListener('click', (event) => {
    const station = event.target.closest('[data-station-index]');
    const link = event.target.closest('[data-profile]');
    if (!link) return;
    switchProfileTab(link.dataset.profile);
    if (station) {
      requestAnimationFrame(() => {
        const target = document.querySelector('.asset-group-row[data-station-index="' + station.dataset.stationIndex + '"]');
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
  });

  // 标签页切换
  $$('.sidebar-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;

      $$('.sidebar-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      $$('.sidebar-content .tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === `${tab}Pane`);
      });
    });
  });
}

function switchProfileTab(tab) {
  $$('.profile-tabs .tab-link').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab));
  $$('#profileNav .profile-nav-btn').forEach((link) => link.classList.toggle('active', link.dataset.profile === tab));
  if (state.characterData) renderProfileTab(tab);
}

function renderProfileStationNav(stations) {
  const nav = $('profileStationNav');
  if (!nav) return;
  if (!stations.length) {
    nav.innerHTML = '<span class="profile-nav-empty">暂无空间站资产</span>';
    return;
  }
  nav.innerHTML = stations.map((station, index) => '<button class="profile-nav-station" data-profile="assets" data-station-index="' + index + '">' + esc(station) + '</button>').join('');
}

// ===== 目录加载 =====
async function loadCatalog() {
  try {
    console.log('开始加载目录...');
    const response = await fetch('./catalog.json?v=v2r7');
    if (!response.ok) throw new Error('目录加载失败');

    state.catalog = await response.json();
    console.log('目录加载成功:', state.catalog.groups?.length, '个分类');

    // 构建分类索引
    state.catalog.groups.forEach(group => {
      state.categories.set(group.id, group);
    });

    renderCatalog();
    console.log('目录渲染完成');
  } catch (error) {
    console.error('加载目录失败:', error);
    $('catalogTree').innerHTML = '<div class="loading">目录加载失败: ' + error.message + '</div>';
  }
}

function renderCatalog() {
  const container = $('catalogTree');

  if (!state.catalog) {
    console.log('目录数据为空');
    container.innerHTML = '<div class="loading">载入中...</div>';
    return;
  }

  // 如果有搜索查询，显示搜索结果
  if (state.searchQuery) {
    renderSearchResults(container);
    return;
  }

  // 渲染分类树
  const rootCategories = state.catalog.groups.filter(g => !g.parentId);
  console.log('根分类数量:', rootCategories.length);

  const html = rootCategories
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map(category => renderCategory(category))
    .filter(h => h) // 过滤空结果
    .join('');

  if (html) {
    container.innerHTML = html;
    // 绑定事件
    bindCategoryEvents();
    console.log('分类树渲染完成');
  } else {
    container.innerHTML = '<div class="loading">暂无分类数据</div>';
  }
}

function renderCategory(category, level = 0) {
  const children = state.catalog.groups.filter(g => g.parentId === category.id);
  const hasChildren = children.length > 0 || category.types.length > 0;

  if (!hasChildren) return '';

  const childrenHTML = [
    ...category.types.map(type => renderItem(type, category.id)),
    ...children.map(child => renderCategory(child, level + 1))
  ].join('');

  return `
    <div class="category" data-id="${category.id}">
      <div class="category-header">
        <svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <span class="category-name">${category.name}</span>
        <span class="category-count">${category.types.length}</span>
      </div>
      <div class="category-items">
        ${childrenHTML}
      </div>
    </div>
  `;
}

function renderItem(item, categoryId) {
  const isActive = state.selectedItem?.id === item.id ? 'active' : '';
  return `
    <button class="item-btn ${isActive}"
            data-type-id="${item.id}"
            data-category-id="${categoryId}"
            title="${item.name} (Type ${item.id})">
      ${item.name}
    </button>
  `;
}

function renderSearchResults(container) {
  const query = state.searchQuery.toLowerCase();
  const results = [];

  state.catalog.groups.forEach(group => {
    group.types.forEach(type => {
      if (type.name.toLowerCase().includes(query) ||
          group.name.toLowerCase().includes(query)) {
        results.push({ ...type, categoryId: group.id, categoryName: group.name });
      }
    });
  });

  if (results.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>未找到匹配项</p></div>';
    return;
  }

  const html = results.slice(0, 100).map(item => {
    const isActive = state.selectedItem?.id === item.id ? 'active' : '';
    return `
      <button class="item-btn ${isActive}"
              data-type-id="${item.id}"
              data-category-id="${item.categoryId}"
              title="${item.name} (${item.categoryName})">
        ${item.name}
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
          ${item.categoryName}
        </div>
      </button>
    `;
  }).join('');

  container.innerHTML = html +
    (results.length > 100 ? '<div class="loading">显示前100项...</div>' : '');

  bindCategoryEvents();
}

function bindCategoryEvents() {
  // 分类展开/收起
  $$('.category-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('expanded');
    });
  });

  // 物品选择
  $$('.item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const categoryId = parseInt(btn.dataset.categoryId);
      selectItem(typeId, categoryId);
    });
  });
}

// ===== 物品详情 =====
async function selectItem(typeId, categoryId) {
  const category = state.categories.get(categoryId);
  const type = category?.types.find(t => t.id === typeId);

  if (!type) return;

  state.selectedItem = { ...type, categoryId, categoryName: category.name };

  // 更新UI
  $$('.item-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.typeId) === typeId);
  });

  // 隐藏空状态，显示详情
  const emptyView = $('emptyView');
  const detailView = $('detailView');

  if (emptyView) emptyView.style.display = 'none';
  if (detailView) {
    detailView.style.display = 'block';
    detailView.hidden = false;
  }

  // 显示基本信息
  $('itemIcon').src = `${IMAGE_BASE}/${typeId}/icon?size=64`;
  $('itemCategory').textContent = category.name;
  $('itemTypeId').textContent = `Type ${typeId}`;
  $('itemName').textContent = type.name;
  $('regionTag').textContent = REGIONS.find(r => r.id === state.regionId)?.name || '未知区域';

  // 加载市场数据
  await loadMarketData(typeId);
}

async function loadMarketData(typeId) {
  try {
    // 显示加载状态
    $('minSellPrice').textContent = '载入中...';
    $('maxBuyPrice').textContent = '载入中...';
    $('spreadValue').textContent = '载入中...';
    $('avgPrice').textContent = '载入中...';

    // 并行请求数据
    const [orders, history, prices] = await Promise.all([
      fetchESI(`/markets/${state.regionId}/orders/?order_type=all&type_id=${typeId}`),
      fetchESI(`/markets/${state.regionId}/history/?type_id=${typeId}`),
      fetchESI('/markets/prices/')
    ]);

    state.orders = orders || [];
    state.history = (history || []).sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );
    state.priceData = prices?.find(p => p.type_id === typeId);

    // 解析位置名称
    await resolveLocations(state.orders);

    // 渲染数据
    renderStats();
    renderOrders();
    renderHistory();

    $('updateTag').textContent = formatTime(new Date());

    showToast('数据已更新');
  } catch (error) {
    console.error('加载市场数据失败:', error);
    showToast('数据加载失败: ' + error.message);

    $('minSellPrice').textContent = '—';
    $('maxBuyPrice').textContent = '—';
    $('spreadValue').textContent = '—';
    $('avgPrice').textContent = '—';
  }
}

async function resolveLocations(orders) {
  const locationIds = [...new Set(
    orders
      .map(o => o.location_id)
      .filter(id => id && id < 1000000000 && !state.locationCache.has(id))
  )];

  if (locationIds.length === 0) return;

  try {
    // 批量请求位置信息
    const locations = await fetchESI('/universe/names/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(locationIds)
    });

    locations.forEach(loc => {
      state.locationCache.set(loc.id, loc.name);
    });
  } catch (error) {
    console.error('解析位置失败:', error);
  }
}

function renderStats() {
  const sellOrders = state.orders.filter(o => !o.is_buy_order);
  const buyOrders = state.orders.filter(o => o.is_buy_order);

  // 最低卖价
  if (sellOrders.length > 0) {
    const minSell = Math.min(...sellOrders.map(o => o.price));
    $('minSellPrice').textContent = formatISK(minSell) + ' ISK';
    $('minSellMeta').textContent = `${sellOrders.length} 个卖单`;
  } else {
    $('minSellPrice').textContent = '—';
    $('minSellMeta').textContent = '无卖单';
  }

  // 最高买价
  if (buyOrders.length > 0) {
    const maxBuy = Math.max(...buyOrders.map(o => o.price));
    $('maxBuyPrice').textContent = formatISK(maxBuy) + ' ISK';
    $('maxBuyMeta').textContent = `${buyOrders.length} 个买单`;
  } else {
    $('maxBuyPrice').textContent = '—';
    $('maxBuyMeta').textContent = '无买单';
  }

  // 价差
  if (sellOrders.length > 0 && buyOrders.length > 0) {
    const minSell = Math.min(...sellOrders.map(o => o.price));
    const maxBuy = Math.max(...buyOrders.map(o => o.price));
    const spread = minSell - maxBuy;
    const spreadPercent = ((spread / maxBuy) * 100).toFixed(2);

    $('spreadValue').textContent = formatISK(spread) + ' ISK';
    $('spreadMeta').textContent = `${spreadPercent}% 价差`;
  } else {
    $('spreadValue').textContent = '—';
    $('spreadMeta').textContent = '数据不足';
  }

  // 全服均价
  if (state.priceData?.average_price) {
    $('avgPrice').textContent = formatISK(state.priceData.average_price) + ' ISK';
  } else {
    $('avgPrice').textContent = '—';
  }
}

function renderOrders() {
  const sellOrders = state.orders.filter(o => !o.is_buy_order)
    .sort((a, b) => a.price - b.price)
    .slice(0, 50);

  const buyOrders = state.orders.filter(o => o.is_buy_order)
    .sort((a, b) => b.price - a.price)
    .slice(0, 50);

  // 渲染卖单
  $('sellCount').textContent = sellOrders.length;
  $('sellOrdersBody').innerHTML = sellOrders.length > 0
    ? sellOrders.map(order => `
        <tr>
          <td>${formatISK(order.price)}</td>
          <td>${formatNumber(order.volume_remain)}</td>
          <td>${formatISK(order.price * order.volume_remain)}</td>
          <td>${state.locationCache.get(order.location_id) || `ID ${order.location_id}`}</td>
        </tr>
      `).join('')
    : '<tr class="empty-row"><td colspan="4">无卖单</td></tr>';

  // 渲染买单
  $('buyCount').textContent = buyOrders.length;
  $('buyOrdersBody').innerHTML = buyOrders.length > 0
    ? buyOrders.map(order => `
        <tr>
          <td>${formatISK(order.price)}</td>
          <td>${formatNumber(order.volume_remain)}</td>
          <td>${formatISK(order.price * order.volume_remain)}</td>
          <td>${state.locationCache.get(order.location_id) || `ID ${order.location_id}`}</td>
        </tr>
      `).join('')
    : '<tr class="empty-row"><td colspan="4">无买单</td></tr>';
}

function renderHistory() {
  const recentHistory = state.history.slice(0, 30);

  $('historyTableBody').innerHTML = recentHistory.length > 0
    ? recentHistory.map(day => `
        <tr>
          <td>${formatDate(day.date)}</td>
          <td>${formatISK(day.average)}</td>
          <td>${formatISK(day.highest)}</td>
          <td>${formatISK(day.lowest)}</td>
          <td>${formatNumber(day.volume)}</td>
          <td>${formatNumber(day.order_count)}</td>
        </tr>
      `).join('')
    : '<tr class="empty-row"><td colspan="6">暂无历史数据</td></tr>';
}

// ===== 区域选择 =====
function initRegionSelect() {
  const select = $('regionSelect');

  REGIONS.forEach(region => {
    const option = document.createElement('option');
    option.value = region.id;
    option.textContent = region.name;
    select.appendChild(option);
  });

  select.value = state.regionId;

  select.addEventListener('change', () => {
    state.regionId = parseInt(select.value);
    localStorage.setItem('eve-region', state.regionId);

    if (state.selectedItem) {
      loadMarketData(state.selectedItem.id);
    }
  });
}

// ===== 刷新按钮 =====
function initRefreshButton() {
  $('refreshBtn').addEventListener('click', () => {
    if (state.selectedItem) {
      loadMarketData(state.selectedItem.id);
    }
  });
}

// ===== 内容标签页 =====
function initContentTabs() {
  $$('.tab-link').forEach(link => {
    link.addEventListener('click', () => {
      const content = link.dataset.content;
      if (!content) return;

      // 更新标签按钮状态
      link.parentElement.querySelectorAll('.tab-link').forEach(l => {
        l.classList.remove('active');
      });
      link.classList.add('active');

      // 切换内容
      $$('.tab-content').forEach(pane => {
        pane.classList.toggle('active', pane.id === `${content}Content`);
      });

      // 如果是图表标签，渲染图表
      if (content === 'chart') {
        renderChart();
      }
    });
  });
}

let priceChartInstance = null;

function renderChart() {
  const canvas = $('priceChart');

  if (!canvas) return;

  if (state.history.length === 0) {
    // 如果已有图表实例，先销毁
    if (priceChartInstance) {
      priceChartInstance.destroy();
      priceChartInstance = null;
    }
    return;
  }

  // 准备数据 - 最近30天
  const recentHistory = state.history.slice(-30).reverse();
  const dates = recentHistory.map(d => formatDate(d.date));
  const avgPrices = recentHistory.map(d => d.average);
  const highPrices = recentHistory.map(d => d.highest);
  const lowPrices = recentHistory.map(d => d.lowest);
  const volumes = recentHistory.map(d => d.volume);

  // 获取当前主题
  const isDark = state.theme === 'dark';
  const gridColor = isDark ? 'rgba(45, 55, 72, 0.5)' : 'rgba(226, 232, 240, 0.8)';
  const textColor = isDark ? '#94a3b8' : '#475569';

  // 如果已有图表实例，先销毁
  if (priceChartInstance) {
    priceChartInstance.destroy();
  }

  // 创建新图表
  priceChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: '平均价格',
          data: avgPrices,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          yAxisID: 'y'
        },
        {
          label: '最高价',
          data: highPrices,
          borderColor: '#10b981',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'y'
        },
        {
          label: '最低价',
          data: lowPrices,
          borderColor: '#ef4444',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'y'
        },
        {
          label: '成交量',
          data: volumes,
          type: 'bar',
          backgroundColor: 'rgba(100, 116, 139, 0.3)',
          borderColor: 'rgba(100, 116, 139, 0.5)',
          borderWidth: 1,
          yAxisID: 'y1',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: textColor,
            usePointStyle: true,
            padding: 15,
            font: {
              size: 12
            }
          }
        },
        tooltip: {
          backgroundColor: isDark ? 'rgba(30, 41, 59, 0.95)' : 'rgba(255, 255, 255, 0.95)',
          titleColor: textColor,
          bodyColor: textColor,
          borderColor: gridColor,
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.dataset.yAxisID === 'y1') {
                // 成交量
                label += formatNumber(context.parsed.y, 0);
              } else {
                // 价格
                label += formatISK(context.parsed.y) + ' ISK';
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: gridColor,
            drawBorder: false
          },
          ticks: {
            color: textColor,
            maxRotation: 45,
            minRotation: 0,
            font: {
              size: 11
            }
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: {
            color: gridColor,
            drawBorder: false
          },
          ticks: {
            color: textColor,
            font: {
              size: 11
            },
            callback: function(value) {
              return formatISK(value);
            }
          },
          title: {
            display: true,
            text: '价格 (ISK)',
            color: textColor,
            font: {
              size: 12,
              weight: 600
            }
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: {
            drawOnChartArea: false,
            drawBorder: false
          },
          ticks: {
            color: textColor,
            font: {
              size: 11
            },
            callback: function(value) {
              return formatNumber(value, 0);
            }
          },
          title: {
            display: true,
            text: '成交量',
            color: textColor,
            font: {
              size: 12,
              weight: 600
            }
          }
        }
      }
    }
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
const ORDER_RANGE_ZH = { '1': '本星系', '10': '星域(10%)', '20': '星域(20%)', '30': '星域(30%)', '40': '星域(40%)', station: '空间站', solar_system: '星系', region: '整个星域' };
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

async function getMarketPriceMap() {
  if (state.marketPriceMap instanceof Map) return state.marketPriceMap;
  try {
    const prices = await fetchESI('/markets/prices/');
    state.marketPriceMap = new Map(
      (Array.isArray(prices) ? prices : [])
        .map((price) => [Number(price.type_id), Number(price.average_price)])
        .filter(([typeId, price]) => typeId > 0 && Number.isFinite(price) && price > 0)
    );
  } catch {
    state.marketPriceMap = new Map();
  }
  return state.marketPriceMap;
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
  loadCharacterData().catch((err) => showToast(err.message, 4000));
}

async function loadCharacterData() {
  const token = await ensureEsiToken();
  const id = token.character_id;
  $('profileAvatar').src = 'https://images.evetech.net/characters/' + id + '/portrait?size=128';
  $('profileName').textContent = token.character_name || ('角色 ' + id);
  $('profileCorp').textContent = '数据读取中…';
  $('profileData').innerHTML = '<p class="text-muted">正在读取角色数据…</p>';
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

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
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
    const marketPrices = await getMarketPriceMap();
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
      '<table class="pc-mini-table asset-table"><thead><tr><th>物品</th><th>数量</th><th>市场单价</th><th>市场估值</th><th>槽位</th></tr></thead><tbody>' + assetRows + '</tbody></table>' +
      (assets.length > 200 ? '<p class="text-muted">共读取 ' + assets.length + ' 项，表格仅显示前 200 项。</p>' : '');
    return;
  }

  if (tab === 'orders') {
    const orders = data.orders && !data.orders.__error ? data.orders : null;
    if (!orders || !orders.length) { box.innerHTML = '<p class="text-muted">暂无有效市场订单</p>'; return; }
    box.innerHTML = '<table class="pc-mini-table"><thead><tr><th>物品</th><th>方向</th><th>位置</th><th>范围</th><th>单价</th><th>剩余/总量</th></tr></thead><tbody>' +
      orders.map((o) => profileRow([
        esc(nameOf(o.type_id)),
        o.is_buy_order ? '收购' : '出售',
        esc(nameOf(o.location_id)),
        esc(zhLabel(ORDER_RANGE_ZH, o.range, o.range || '')),
        formatISK(o.price),
        o.volume_remain + ' / ' + o.volume_total
      ])).join('') + '</tbody></table>';
    return;
  }

  if (tab === 'wallet') {
    const journal = data.journal && !data.journal.__error ? data.journal : null;
    const walletOk = data.wallet && !data.wallet.__error;
    let html = '<div class="info-grid"><div class="info-card"><span>钱包余额</span><strong>' + (walletOk ? formatISK(data.wallet.balance) + ' ISK' : '权限不足') + '</strong></div></div>';
    if (journal && journal.length) {
      html += '<table class="pc-mini-table"><thead><tr><th>时间</th><th>类型</th><th>对方</th><th>金额</th></tr></thead><tbody>' +
        journal.slice(0, 50).map((j) => profileRow([
          j.date ? new Date(j.date).toLocaleString('zh-CN', { hour12: false }) : '',
          esc(zhLabel(JOURNAL_REF_ZH, j.ref_type, j.ref_type || '')),
          esc(nameOf(j.first_party_id)),
          (j.amount >= 0 ? '+' : '') + formatISK(j.amount)
        ])).join('') + '</tbody></table>' +
        (journal.length > 50 ? '<p class="text-muted">仅显示最近 50 条（共 ' + journal.length + ' 条）</p>' : '');
    } else {
      html += '<p class="text-muted">暂无钱包流水</p>';
    }
    box.innerHTML = html;
  }
}

// ===== ESI 绑定 =====
// ===== ESI 绑定 =====
async function generateAuthLink() {
  setEsiStatus('正在生成授权链接…');
  try {
    const res = await fetch(ESI_API + '/auth-url');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('服务端 ' + res.status));
    $('authLink').value = data.url;
    $('openAuthBtn').href = data.url;
    $('authLinkBox').hidden = false;
    setEsiStatus('授权链接已生成，打开完成登录后把地址栏完整地址粘贴到下方绑定', 'success');
  } catch (error) {
    setEsiStatus('生成失败：' + error.message, 'error');
  }
}

async function bindEsiCallback() {
  const raw = $('callbackUrl').value.trim();
  if (!raw) { setEsiStatus('请粘贴登录后的完整回调地址', 'error'); return; }
  let params;
  try { params = new URL(raw, location.href).searchParams; } catch { setEsiStatus('地址格式不正确', 'error'); return; }
  if (params.get('error')) { setEsiStatus('授权失败：' + params.get('error'), 'error'); return; }
  const code = params.get('code');
  const cbState = params.get('state');
  if (!code || !cbState) { setEsiStatus('回调地址缺少 code 或 state', 'error'); return; }
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
    $('esiModal').hidden = true;
    showToast('已绑定：' + (data.character_name || '角色'));
    loadProfile();
  } catch (error) {
    setEsiStatus(error.message || '绑定失败', 'error');
  }
}

// OAuth 回调落地：授权后 CCP 跳回 https://eve.navexor.top/?code=…&state=…
// 自动弹开绑定框、填入回调地址并清掉地址栏参数，用户只需点「绑定」
function handleEsiCallbackRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const callbackUrl = location.href;
  history.replaceState(null, '', location.pathname);
  $('esiModal').hidden = false;
  $('callbackUrl').value = callbackUrl;
  if (params.has('error')) {
    setEsiStatus('授权失败：' + (params.get('error_description') || params.get('error')), 'error');
  } else {
    setEsiStatus('检测到授权回调，请点击「绑定」完成 ESI 绑定', 'success');
  }
}

function initESIModal() {
  $('bindEsiBtn').addEventListener('click', () => { $('esiModal').hidden = false; });
  $('closeEsiModal').addEventListener('click', () => { $('esiModal').hidden = true; });
  $('esiModal').querySelector('.modal-backdrop').addEventListener('click', () => { $('esiModal').hidden = true; });
  $('generateAuthBtn').addEventListener('click', generateAuthLink);
  $('bindCallbackBtn').addEventListener('click', bindEsiCallback);
  $('copyAuthBtn').addEventListener('click', async () => {
    const value = $('authLink').value;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); showToast('授权链接已复制'); }
    catch { showToast('浏览器阻止了复制，请手动选择复制'); }
  });
  $('refreshProfileBtn').addEventListener('click', () => {
    loadCharacterData().then(() => showToast('角色数据已刷新')).catch((e) => showToast(e.message, 4000));
  });
  $('unbindEsiBtn').addEventListener('click', () => {
    writeEsiToken(null);
    state.characterData = null;
    renderProfileStationNav([]);
    loadProfile();
    showToast('已解绑，本地令牌已清除');
  });
  $$('.profile-tabs .tab-link').forEach((link) => link.addEventListener('click', () => switchProfileTab(link.dataset.profile)));
}


// ===== 初始化应用 =====
async function init() {
  console.log('EVE Market - 现代化版本');

  initTheme();
  initNavigation();
  initSidebar();
  initRegionSelect();
  initRefreshButton();
  initContentTabs();
  initESIModal();
  handleEsiCallbackRedirect();

  // 目录有约 1.18 MB，放到首屏绘制之后加载，不阻塞个人中心和基础页面。
  state.catalogReady = new Promise((resolve) => {
    const start = () => { loadCatalog().finally(resolve); };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(start, { timeout: 1200 });
    } else {
      window.setTimeout(start, 0);
    }
  });
  loadProfile();

  console.log('应用初始化完成');
}

// 启动应用
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
