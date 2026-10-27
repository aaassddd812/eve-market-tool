// ===== 模拟装配 =====
// 左侧浏览舰船 / 装备 / 弹药 / 无人机 / 植入体（按市场分组或搜索），中间是舰船槽位，右侧为属性统计。
// 技能可选「全部 5 级」或「已绑定角色的技能」；装配保存在本机，支持 EFT 文本导入导出与分享链接，
// 绑定 ESI 后可读取 / 保存游戏内的装配（esi-fittings.read_fittings.v1 / write_fittings.v1）。
// 智能装配（fit-auto.js）按目标与约束自动搜索装配；击杀记录装配（fit-kb.js）列出这艘船最近阵亡时的常见装配。
import * as FE from './fit-engine.js?v=v24';
import * as MU from './fit-mutate.js?v=v3';
import { initAutoFit, openAutoFit, openImplantAdvisor } from './fit-auto.js?v=v26';
import { initKbFits, openKbFits } from './fit-kb.js?v=v26';
import { initSim, mountSim } from './fit-sim.js?v=v6';
import { initGraph, openGraph } from './fit-graph.js?v=v4';
import { skCards, skRows, skTitle } from './skeleton.js?v=v17';

let app;
const $ = (id) => document.getElementById(id);
const INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
const infoBtn = (id, tag = 'button') => tag === 'button'
  ? `<button type="button" class="fit-info-btn" data-fit-info="${id}" title="查看详情" aria-label="查看详情">${INFO_ICON}</button>`
  : `<span class="fit-info-btn" data-fit-info="${id}" role="button" title="查看详情" aria-label="查看详情">${INFO_ICON}</span>`;
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const DATA_URL = './fit-data.json?v=v21r3';
const SAVE_KEY = 'eve-fits-v1';
const CURRENT_KEY = 'eve-fit-current';
const SETTINGS_KEY = 'eve-fit-settings';
const DRAFTS_KEY = 'eve-fit-drafts';   // 每艘船上次没保存的装配（舰船 -> 装配），最多留 30 艘

const TABS = [
  ['ship', '舰船', [FE.CAT.ship]],
  ['module', '装备', [FE.CAT.module, FE.CAT.subsystem]],
  ['charge', '弹药', [FE.CAT.charge]],
  ['drone', '无人机', [FE.CAT.drone, FE.CAT.fighter]],
  ['implant', '植入体', [FE.CAT.implant]]
];
// 科技 I 里衍生等级 ≥ 1 的是衍生装备（紧凑型、持久型、受限型、聚焦型等），原版衍生等级为 0
const metaTag = (t) => META[t.meta] || (t.meta === 1 && t.attrs.get(633) > 0 ? ['衍生', 'derived'] : null);
const META = { 2: ['T2', 't2'], 3: ['故事线', 'story'], 4: ['势力', 'faction'], 5: ['官员', 'officer'], 6: ['死亡空间', 'deadspace'], 14: ['T3', 't3'], 15: ['深渊', 'abyssal'] };
const STATE_NAME = { offline: '离线', online: '在线', active: '激活', overload: '超载' };
const IMPLANT_SLOT = 331, BOOSTER_SLOT = 1087;

const F = {
  data: null, loading: null,
  fit: null, calc: null, stats: null,
  tab: 'ship', query: '', open: new Set(), slotFilter: null, onlyFits: true,
  selected: null,                 // { slot, index }：选中的装备（装填弹药用）
  infoSrc: null,                  // 详情弹窗是从装配里哪一项点开的（衍生替换用）
  skillMode: 'max', esi: null,
  prices: null
};

// ---------- 入口 ----------
export function initFitting(context) {
  app = context;
  try { Object.assign(F, pick(app.store.getJSON(SETTINGS_KEY, {}), ['skillMode', 'onlyFits', 'tab'])); } catch { /* 默认设置 */ }
  if (F.skillMode === 'esi' && !app.hasEsiToken()) F.skillMode = 'max';
  bindSidebar();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit-info]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openTypeInfo(Number(b.dataset.fitInfo), infoSource(b));
  }, true);
  $('fitMain').addEventListener('click', onMainClick);
  $('fitMain').addEventListener('change', onMainChange);
  $('fitMain').addEventListener('input', onMainInput);
  $('fitMain').addEventListener('contextmenu', onStateContext);
  $('fitModal').addEventListener('click', (e) => {
    if (e.target.closest('.modal-backdrop, [data-fit-modal-close]')) closeModal();
    if (e.target.closest('[data-fit-import-go]')) importText($('fitImportText').value);
  });
  $('fitEsiModal').addEventListener('click', onEsiModalClick);
  const planCtx = {
    get data() { return F.data; }, FE,
    getFit: () => F.fit,
    applyFit,
    esiLevels: () => F.esi?.levels || null,
    prices: () => F.prices,
    esc: app.esc, formatNumber: app.formatNumber, formatISK: app.formatISK, showToast: app.showToast, store: app.store
  };
  MU.initMutate(app, { data: () => F.data });
  initAutoFit(planCtx);
  initKbFits(planCtx);
  const toolCtx = {
    get data() { return F.data; }, FE,
    getFit: () => F.fit, getStats: () => F.stats, savedFits, parseEft, normalize, skills,
    hasEsi: () => app.hasEsiToken(),
    esiFits: loadEsiFitList,
    // 在装配页打开（模拟对打的装配详情）：先记下，切到装配页时载入
    openInFitting: (fit) => { pendingFit = fit; app.openFit(); },
    esc: app.esc, formatNumber: app.formatNumber, formatISK: app.formatISK, showToast: app.showToast, store: app.store
  };
  toolInit = () => { initSim(toolCtx); initGraph(toolCtx); toolInit = null; };
  $('fitEsiModal').addEventListener('input', (e) => { if (e.target.id === 'fitEsiSearch') renderEsiList(); });
  $('fitEsiShipOnly').addEventListener('change', renderEsiList);
  $('fitStats').addEventListener('change', (e) => { if (e.target.matches('[data-val-src]')) { app.valuation.set(e.target.value); renderStats(); } });
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function saveSettings() {
  app.store.setJSON(SETTINGS_KEY, { skillMode: F.skillMode, onlyFits: F.onlyFits, tab: F.tab });
}

let toolInit = null;   // 装配数据到了再初始化模拟对打 / 伤害图表（它们需要读取本机装配）
function openTool(open, arg) {
  toolInit?.();
  open(arg);
}

// 模拟对打页（独立菜单，与装配页共用装配数据）；战场统计「模拟对打」先 queueSim 带入双方舰船
let pendingSim = null;
export function queueSim(preset) {
  pendingSim = preset || null;
}
export async function showSim(root, restored = false) {
  if (!F.data && !root.dataset.ready) root.innerHTML = skTitle(16) + skCards(3) + skRows(6);
  try {
    await ensureData();
  } catch (error) {
    root.innerHTML = '<p class="text-muted kb-empty">装配数据加载失败：' + app.esc(error.message) + '</p>';
    return;
  }
  toolInit?.();
  const preset = pendingSim;
  pendingSim = null;
  mountSim(root, preset, restored && !preset);
}

async function ensureData() {
  if (F.data) return F.data;
  if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
  try { F.data = await F.loading; } catch (error) { F.loading = null; throw error; }
  return F.data;
}

// 空闲时预加载装配数据
export async function preloadFitting() {
  if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
  await F.loading.catch((error) => { F.loading = null; throw error; });
}

// restored：从其他页面切回，保留当前页面，不重新渲染
export async function showFitting(restored = false) {
  if (!F.ready) {
    if (!F.data) {
      $('fitMain').innerHTML = skTitle(20) + '<div class="fit-layout"><div>' + skRows(8) + '</div><div>' + skCards(4, 'fit-sk-cards') + '</div></div>';
      $('fitBrowser').innerHTML = skRows(12, { img: 24 });
    }
    try {
      await ensureData();
    } catch (error) {
      $('fitMain').innerHTML = '<p class="text-muted kb-empty">装配数据加载失败：' + app.esc(error.message) + '</p>';
      return;
    }
    app.getMarketPriceMap().then((m) => { F.prices = m; if (F.fit) renderStats(); }).catch(() => {});
    app.getInsurance?.().then((m) => { F.insurance = m; if (F.fit) renderStats(); }).catch(() => {});
    // 突变质体数据（约 18 KB 压缩后）：装备行的「突变」按钮在读到后出现
    MU.loadMuta().then(() => { if (F.fit) renderFit(); }).catch(() => {});
    if (!loadPending() && !loadFromHash()) {
      const saved = app.store.getJSON(CURRENT_KEY, null);
      F.fit = saved && F.data.types.has(saved.ship) ? normalize(saved) : null;
    }
    if (F.skillMode === 'esi') await loadEsiSkills();
    renderBrowserTabs();
    renderBrowser();
    recompute();
    F.ready = true;
    return;
  }
  if (loadPending() || loadFromHash()) { recompute(); renderBrowser(); restored = false; }
  syncSkillMode(restored);
}

// 绑定 / 解绑 ESI 后刷新技能来源
let lastEsi = null;
function syncSkillMode(restored = false) {
  const esi = app.hasEsiToken();
  if (esi !== lastEsi) restored = false;   // 期间绑定 / 解绑了 ESI，需要刷新技能选项
  lastEsi = esi;
  if (F.skillMode === 'esi' && !esi) { F.skillMode = 'max'; F.esi = null; recompute(); }
  else if (F.fit && !restored) renderFit();
}

// ---------- 装配数据结构 ----------
function emptySlots() {
  return { high: [], mid: [], low: [], rig: [], sub: [] };
}

function newFit(ship) {
  return { id: null, name: '', ship, slots: emptySlots(), drones: [], implants: [] };
}

function normalize(f) {
  const fit = newFit(f.ship);
  Object.assign(fit, { id: f.id || null, name: f.name || '' });
  for (const s of FE.SLOTS) fit.slots[s] = (f.slots?.[s] || []).map((m) => (m && F.data.types.has(m.type) ? { type: m.type, state: m.state || 'online', charge: F.data.types.has(m.charge) ? m.charge : null, ...cleanMut(m.mut, m.abyssal) } : null));
  fit.drones = (f.drones || []).filter((d) => F.data.types.has(d.type)).map((d) => ({ type: d.type, count: d.count || 1, active: d.active || 0 }));
  fit.implants = (f.implants || []).filter((id) => F.data.types.has(id));
  return fit;
}

function type(id) { return F.data.types.get(id); }

// 突变记录：原装备存在且属性是数字才保留
// 深渊参考估价（fit-mutate.js 算出）：{ value, src, item, include }
function cleanMut(mut, aby) {
  if (!mut || !F.data.types.has(mut.base)) return {};
  const attrs = Object.fromEntries(Object.entries(mut.attrs || {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [Number(k), v]));
  const out = { mut: { base: mut.base, mutator: mut.mutator, attrs } };
  if (aby && Number(aby.value) > 0) out.abyssal = { value: Number(aby.value), src: ['item', 'model'].includes(aby.src) ? aby.src : 'similar', item: Number(aby.item) || null, include: Boolean(aby.include) };
  return out;
}

function skills() {
  return F.skillMode === 'esi' && F.esi ? F.esi.levels : 'max';
}

function recompute() {
  if (F.fit) {
    F.calc = FE.computeFit(F.data, F.fit, skills());
    F.stats = F.calc ? FE.fitStats(F.calc) : null;
    app.store.setJSON(CURRENT_KEY, F.fit);
  } else {
    F.calc = F.stats = null;
  }
  renderFit();
  renderStats();
  if (F.onlyFits) renderBrowser();
}

// ---------- 浏览器（左侧）----------
function bindSidebar() {
  const input = $('fitSearch');
  input.addEventListener('input', app.debounce(() => { F.query = input.value.trim().toLowerCase(); renderBrowser(); }, 150));
  $('fitBrowserTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit-tab]');
    if (!b) return;
    setTab(b.dataset.fitTab);
  });
  $('fitBrowser').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-fit-group]');
    if (toggle) {
      const id = toggle.dataset.fitGroup;
      if (F.open.has(id)) F.open.delete(id); else F.open.add(id);
      renderBrowser();
      return;
    }
    const filter = e.target.closest('[data-fit-only]');
    if (filter) { F.onlyFits = filter.checked; saveSettings(); renderBrowser(); return; }
    const clear = e.target.closest('[data-fit-slot-clear]');
    if (clear) { F.slotFilter = null; renderBrowser(); return; }
    const item = e.target.closest('[data-fit-type]');
    if (item) useType(Number(item.dataset.fitType));
  });
}

function setTab(tab) {
  F.tab = tab;
  saveSettings();
  renderBrowserTabs();
  renderBrowser();
}

function renderBrowserTabs() {
  $('fitBrowserTabs').innerHTML = TABS.map(([key, label]) => `<button data-fit-tab="${key}" class="${F.tab === key ? 'active' : ''}">${label}</button>`).join('');
}

// 当前标签页、筛选条件下可见的物品
function visible(t) {
  const shipType = F.fit && type(F.fit.ship);
  if (F.tab === 'module') {
    if (F.slotFilter && t.slot !== F.slotFilter) return false;
    if (F.onlyFits && shipType) {
      if (FE.cannotFit(F.data, shipType, t)) return false;
      if (t.slot === 'sub' && !F.stats?.slots.sub) return false;
      if (t.slot && F.stats && !F.stats.slots[t.slot]) return false;
    }
  }
  if (F.tab === 'charge' && F.onlyFits && F.fit) {
    const mods = fittedModules();
    if (!mods.some(({ m }) => FE.chargeFits(type(m.type), t))) return false;
  }
  if (F.tab === 'drone' && F.onlyFits && F.stats) {
    const res = F.stats.resources;
    if (t.category === FE.CAT.fighter ? !res.fighterBay.total : !res.droneBay.total) return false;
  }
  return true;
}

function tabTypes() {
  const cats = TABS.find(([k]) => k === F.tab)[2];
  return [...F.data.types.values()].filter((t) => cats.includes(t.category));
}

function renderBrowser() {
  if (!F.data) return;
  const box = $('fitBrowser');
  const list = tabTypes().filter(visible);
  const head = [];
  if (F.tab === 'module' || F.tab === 'charge' || F.tab === 'drone') {
    head.push(`<label class="fit-only"><input type="checkbox" data-fit-only${F.onlyFits ? ' checked' : ''}>只显示${F.tab === 'charge' ? '已装配武器可用的弹药' : '能装到当前舰船的'}</label>`);
  }
  if (F.tab === 'module' && F.slotFilter) head.push(`<div class="fit-slot-filter">只看${FE.SLOT_NAME[F.slotFilter]} <button class="link-btn" data-fit-slot-clear>显示全部</button></div>`);
  if (F.query) {
    const q = F.query;
    const hits = list.filter((t) => t.name.toLowerCase().includes(q) || t.en.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.length - b.name.length)
      .slice(0, 200);
    box.innerHTML = head.join('') + (hits.length ? '<div class="fit-list">' + hits.map(itemRow).join('') + '</div>' : '<p class="legend-empty">没有匹配的物品</p>');
    return;
  }
  // 按市场分组展示：只显示含可见物品的分组
  const count = new Map();
  const noMarket = [];
  for (const t of list) {
    if (!t.market || !F.data.markets.has(t.market)) { noMarket.push(t); continue; }
    for (let m = F.data.markets.get(t.market); m; m = F.data.markets.get(m.parent)) count.set(m.id, (count.get(m.id) || 0) + 1);
  }
  const roots = [...F.data.markets.values()].filter((m) => !m.parent && count.get(m.id)).sort(byName);
  const typeSet = new Set(list.map((t) => t.id));
  const group = (m, depth) => {
    const key = 'm' + m.id;
    const open = F.open.has(key) || (roots.length === 1 && depth === 0);
    const kids = m.children.filter((c) => count.get(c.id)).sort(byName);
    const items = m.types.filter((t) => typeSet.has(t.id)).sort(byMeta);
    return `<div class="fit-group${open ? ' open' : ''}">
      <button class="fit-group-head" data-fit-group="${key}" style="padding-left:${8 + depth * 12}px"><svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>${app.esc(m.name)}<span>${count.get(m.id)}</span></button>
      ${open ? kids.map((c) => group(c, depth + 1)).join('') + (items.length ? `<div class="fit-list" style="--depth:${depth + 1}">${items.map(itemRow).join('')}</div>` : '') : ''}
    </div>`;
  };
  box.innerHTML = head.join('') + (roots.length || noMarket.length
    ? roots.map((m) => group(m, 0)).join('') + (noMarket.length ? `<div class="fit-group open"><div class="fit-group-head is-static">其他（不在市场出售）<span>${noMarket.length}</span></div><div class="fit-list">${noMarket.sort(byMeta).slice(0, 300).map(itemRow).join('')}</div></div>` : '')
    : `<p class="legend-empty">${F.tab === 'charge' && F.onlyFits ? '先装上需要弹药的武器或装备' : '没有可显示的物品'}</p>`);
}

const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
const byMeta = (a, b) => (a.meta || 1) - (b.meta || 1) || a.name.localeCompare(b.name, 'zh');

function itemRow(t) {
  const meta = metaTag(t);
  const fitInfo = t.category === FE.CAT.module ? [t.attrs.get(FE.AT.cpu) ? `${fmt(t.attrs.get(FE.AT.cpu))} tf` : '', t.attrs.get(FE.AT.power) ? `${fmt(t.attrs.get(FE.AT.power))} MW` : '', t.attrs.get(FE.AT.upgradeCost) ? `校准 ${t.attrs.get(FE.AT.upgradeCost)}` : ''].filter(Boolean).join(' · ') : '';
  return `<button class="fit-item" data-fit-type="${t.id}" title="${app.esc(t.name + (t.en ? '\n' + t.en : ''))}">
    <img src="${IMG(t.id)}" alt="" width="24" height="24" loading="lazy">
    <span class="fit-item-name">${app.esc(t.name)}${fitInfo ? `<small>${fitInfo}</small>` : ''}</span>
    ${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}${infoBtn(t.id, 'span')}
  </button>`;
}

// ---------- 物品详情（舰船 / 装备 / 弹药 / 无人机）：类似游戏里的「显示信息」----------
// 属性中文名与单位来自 dogma-attr-zh.json，数值取物品本身的基础属性（不含技能与舰船加成）
let dogmaP = null;
const dogmaNames = () => dogmaP || (dogmaP = fetch('./dogma-attr-zh.json?v=1').then((r) => r.json()).catch(() => { dogmaP = null; return { attrs: {}, units: {} }; }));
const SKILL_REQ = [[182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288]];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const INFO_GROUPS = [
  ['装配', [14, 13, 12, 1137, 1132, 48, 11, 50, 30, 1153, 102, 101, 1547, 128, 38, 161, 4]],
  ['防御', [263, 479, 271, 272, 273, 274, 265, 267, 268, 269, 270, 9, 113, 111, 109, 110]],
  ['电容', [482, 55, 6]],
  ['导航', [37, 70, 552, 600, 1281]],
  ['锁定', [76, 564, 192, 208, 209, 210, 211]],
  ['无人机', [283, 1271]]
];
const SKIP_INFO = new Set([...SKILL_REQ.flat(), 633]);
function infoValue(id, v, unit, units) {
  const n = (x, d = 2) => Number(x.toFixed(d)).toLocaleString('zh-CN');
  switch (unit) {
    case 101: return n(v / 1000) + ' 秒';
    case 108: case 111: return n((1 - v) * 100) + '%';
    case 109: return n((v - 1) * 100) + '%';
    case 127: return n(v * 100) + '%';
    case 115: return app.esc(F.data.groups.get(v)?.name || String(v));
    case 116: return app.esc(type(v)?.name || String(v));
    case 117: return ['', '小型', '中型', '大型', '超大型'][v] || String(v);
    case 137: return v ? '是' : '否';
    default: {
      const u = { 9: 'm³', 8: 'm²' }[unit] || (unit !== 122 && unit !== 103 ? units[unit] : '');
      return n(v) + (!u ? '' : u === '%' ? '%' : ' ' + app.esc(u));
    }
  }
}
// 从装配里点开的详情记住来源（舰船 / 哪个槽位的装备 / 第几组无人机），衍生里的「替换」只换这一个
function infoSource(b) {
  if (!F.fit || b.closest('#fitInfoModal')) return null;
  if (b.closest('.fit-head-main')) return { kind: 'ship' };
  const row = b.closest('.fit-slot');
  if (row?.dataset.fitMod) return { kind: 'mod', ...parseRef(row.dataset.fitMod) };
  const drone = row?.querySelector('[data-fit-drone-remove]');
  if (drone) return { kind: 'drone', index: Number(drone.dataset.fitDroneRemove) };
  return null;
}
// 来源处现在装的物品（已被改动就不再能替换）
function sourceType(src) {
  if (!src || !F.fit) return null;
  if (src.kind === 'ship') return F.fit.ship;
  if (src.kind === 'mod') return F.fit.slots[src.slot]?.[src.index]?.type ?? null;
  return F.fit.drones[src.index]?.type ?? null;
}

async function openTypeInfo(id, src = null) {
  const t = type(id);
  if (!t) return;
  let modal = $('fitInfoModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'fitInfoModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-fi-close></div><div class="modal-content fi-modal">
      <div class="modal-header"><h3>物品详情</h3><button class="modal-close" data-fi-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="fitInfoBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-fi-close]')) { modal.hidden = true; return; }
      const m = e.target.closest('[data-fi-market]');
      if (m) { modal.hidden = true; app.openItem?.(Number(m.dataset.fiMarket)); return; }
      const sw = e.target.closest('[data-fi-swap]');
      if (sw) { if (swapType(Number(body.dataset.id), Number(sw.dataset.fiSwap))) modal.hidden = true; return; }
      const tab = e.target.closest('[data-fi-tab]');
      if (tab) modal.querySelectorAll('[data-fi-tab], [data-fi-pane]').forEach((el) => el.classList.toggle('active', (el.dataset.fiTab || el.dataset.fiPane) === tab.dataset.fiTab));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
  }
  const body = $('fitInfoBody');
  const tabNow = modal.hidden ? null : modal.querySelector('[data-fi-tab].active')?.dataset.fiTab;
  const meta = metaTag(t);
  const isShip = t.category === FE.CAT.ship;
  const [names, info] = await Promise.all([dogmaNames(), fitInfo()]);
  if (!modal.hidden && body.dataset.id === String(id)) return;
  body.dataset.id = String(id);
  F.infoSrc = sourceType(src) === id ? src : null;
  const rows = new Map();
  for (const [aid, v] of t.attrs) {
    const a = names.attrs[aid];
    if (!a || SKIP_INFO.has(aid) || [119, 129, 136, 140, 142].includes(a[1])) continue;
    rows.set(aid, `<div class="fi-attr"><span>${app.esc(a[0])}</span><b>${infoValue(aid, v, a[1], names.units)}</b></div>`);
  }
  const used = new Set();
  const sections = INFO_GROUPS.map(([label, ids]) => {
    const list = ids.filter((x) => rows.has(x)).map((x) => { used.add(x); return rows.get(x); });
    return list.length ? `<section class="fi-sec"><h4>${label}</h4><div class="fi-grid">${list.join('')}</div></section>` : '';
  }).join('');
  const rest = [...rows].filter(([x]) => !used.has(x)).map(([, h]) => h);
  const attrsHtml = sections + (rest.length ? `<section class="fi-sec"><h4>${sections ? '其他' : '属性'}</h4><div class="fi-grid">${rest.join('')}</div></section>` : '') || '<p class="text-muted">没有可显示的属性</p>';
  const bonus = info.bonus?.[id];
  const variants = variantsOf(id, info);
  const tabs = [['attrs', '属性'], ...(bonus ? [['bonus', '加成']] : []), ['skills', `技能需求${t.skills.length ? ` ${t.skills.length}` : ''}`], ...(variants.length > 1 ? [['var', `衍生 ${variants.length}`]] : []), ['desc', '描述']];
  // 替换后重新打开新物品时停在原来的标签页
  const first = tabs.some(([k]) => k === tabNow) ? tabNow : bonus && isShip ? 'bonus' : 'attrs';
  const pane = (key, html) => `<div class="fi-pane${key === first ? ' active' : ''}" data-fi-pane="${key}">${html}</div>`;
  body.innerHTML = `<div class="fi-head">
      <img src="${IMG(id, isShip ? 'render' : 'icon', 128)}" alt="" width="72" height="72">
      <div class="fi-title"><span>${app.esc(F.data.groups.get(t.group)?.name || '')}${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}${t.attrs.get(633) ? `<small>衍生等级 ${t.attrs.get(633)}</small>` : ''}</span>
        <h4>${app.esc(t.name)}</h4>${t.en && t.en !== t.name ? `<small translate="no">${app.esc(t.en)}</small>` : ''}</div>
      ${t.market ? `<button type="button" class="btn btn-ghost btn-sm" data-fi-market="${id}">市场价格</button>` : ''}
    </div>
    <div class="segmented fi-tabs">${tabs.map(([k, l]) => `<button type="button" data-fi-tab="${k}" class="${k === first ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="fi-panes">${pane('attrs', attrsHtml)}
    ${bonus ? pane('bonus', bonusHtml(bonus)) : ''}
    ${pane('skills', skillTreeHtml(t))}
    ${variants.length > 1 ? pane('var', variantsHtml(variants, id, Boolean(F.infoSrc))) : ''}
    ${pane('desc', '<div class="fi-desc" id="fitInfoDesc" translate="no"><div class="pi-loading">读取描述…</div></div>')}</div>`;
  modal.hidden = false;
  body.querySelector('.fi-panes').scrollTop = 0;
  const lang = window.I18N?.lang === 'en' ? 'en' : 'zh';
  app.fetchESI(`/universe/types/${id}/`, { headers: { 'Accept-Language': lang } }).then((d) => {
    const el = $('fitInfoDesc');
    if (!el || body.dataset.id !== String(id)) return;
    const text = String(d.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    el.textContent = text || (lang === 'en' ? 'No description' : '没有描述');
  }).catch(() => { const el = $('fitInfoDesc'); if (el && body.dataset.id === String(id)) el.textContent = '描述读取失败'; });
}

// 舰船加成与衍生关系（fit-info.json，server/build_fit_info.py 由 SDE 生成），第一次打开详情时加载
let fitInfoP = null;
const fitInfo = () => fitInfoP || (fitInfoP = fetch('./fit-info.json?v=1').then((r) => r.json()).catch(() => { fitInfoP = null; return {}; }));
const BONUS_UNIT = { 105: '%', 104: 'x', 139: '+', 1: ' m', 144: ' AU/s' };

// 加成说明：{物品ID|名称} 换成可点开详情的链接，其余文字转义
function bonusText(raw) {
  return String(raw).split(/(\{\d+\|[^}]*\})/).map((part) => {
    const m = /^\{(\d+)\|([^}]*)\}$/.exec(part);
    if (!m) return app.esc(part);
    return type(Number(m[1])) ? `<button type="button" class="fi-link" data-fit-info="${m[1]}">${app.esc(m[2])}</button>` : `<span>${app.esc(m[2])}</span>`;
  }).join('');
}
function bonusLines(list) {
  const en = window.I18N?.lang === 'en';
  return list.map(([v, unit, zh, enText]) => {
    const val = v == null ? '' : unit === 139 ? '+' + fmt(v) : fmt(v) + (BONUS_UNIT[unit] || '');
    return `<li>${val ? `<b class="fi-bonus-val">${val}</b>` : '<b class="fi-bonus-val is-dot">·</b>'}<span>${bonusText(en ? enText : zh)}</span></li>`;
  }).join('');
}
function bonusHtml(b) {
  // 整块不经页面翻译（说明文字自带中英文），标题也按界面语言直接输出
  const en = window.I18N?.lang === 'en';
  const esi = F.skillMode === 'esi' && F.esi;
  // 标题后 5 个格子是当前技能等级（全 5 级 / ESI 角色）
  const level = (id) => {
    const h = esi ? F.esi.levels.get(id) || 0 : 5;
    const tip = en ? `Current level ${h}${esi ? ` (${F.esi.name})` : ' (all level V)'}` : `当前 ${h} 级${esi ? `（${F.esi.name}）` : '（全 5 级）'}`;
    return `<span class="fi-boxes${h >= 5 ? ' is-max' : ''}" title="${app.esc(tip)}">${Array.from({ length: 5 }, (_, i) => `<i class="${i < h ? 'on' : ''}"></i>`).join('')}</span>`;
  };
  const skillHead = (id) => (en ? `${app.esc(type(id)?.en || 'Skill ' + id)} bonus (per skill level)` : `${app.esc(type(id)?.name || '技能 ' + id)}每升一级`) + level(id);
  const parts = (b.s || []).map(([skill, list]) => `<section class="fi-sec"><h4 class="fi-bonus-head">${skillHead(skill)}</h4><ul class="fi-bonus">${bonusLines(list)}</ul></section>`);
  if (b.r) parts.push(`<section class="fi-sec"><h4>${en ? 'Role bonus' : '特有加成'}</h4><ul class="fi-bonus">${bonusLines(b.r)}</ul></section>`);
  if (b.m) parts.push(`<section class="fi-sec"><h4>${en ? 'Misc bonus' : '其他加成'}</h4><ul class="fi-bonus">${bonusLines(b.m)}</ul></section>`);
  return `<div translate="no">${parts.join('')}</div>`;
}

// 技能需求：和游戏一样展开前置技能树，每个技能 5 个格子；已有等级按当前技能设置（全 5 级 / ESI 角色）
function skillTreeHtml(t) {
  if (!t.skills.length) return '<p class="text-muted">不需要技能</p>';
  const esi = F.skillMode === 'esi' && F.esi;
  const have = (s) => (esi ? F.esi.levels.get(s) || 0 : 5);
  let missing = 0;
  const rowsOf = (tt, depth, path) => tt.skills.map(([s, need]) => {
    const st = type(s);
    const h = have(s);
    if (h < need) missing++;
    const boxes = Array.from({ length: 5 }, (_, i) => `<i class="${i < h ? 'on' : i < need ? 'need' : ''}"></i>`).join('');
    const row = `<div class="fi-skill${h >= need ? ' ok' : ' miss'}" style="--d:${depth}">
      <button type="button" class="fi-link" data-fit-info="${s}">${app.esc(st?.name || '技能 ' + s)}</button>
      <span class="fi-boxes" title="需要 ${need} 级 · 当前 ${h} 级">${boxes}</span><b>${ROMAN[need] || need}</b></div>`;
    return row + (st && !path.has(s) && depth < 8 ? rowsOf(st, depth + 1, new Set([...path, s])) : '');
  }).join('');
  const tree = rowsOf(t, 0, new Set([t.id]));
  const head = esi
    ? (missing ? `<p class="fi-skill-note miss">按 ${app.esc(F.esi.name)} 的技能：还差 ${missing} 项</p>` : `<p class="fi-skill-note ok">按 ${app.esc(F.esi.name)} 的技能：全部满足</p>`)
    : `<p class="fi-skill-note">按全 5 级显示${app.hasEsiToken() ? '，在装配页「技能」切到「按 ESI 角色」可看自己的等级' : ''}</p>`;
  return head + `<div class="fi-skill-tree">${tree}</div>`;
}

// 衍生：同一母型的全部物品（T1、衍生、T2、故事线、势力、死亡空间、官员……）
const VAR_ORDER = { 1: 0, 2: 2, 3: 3, 4: 4, 6: 5, 5: 6, 14: 7, 15: 8 };
function variantsOf(id, info) {
  const v = info.var || {};
  const parent = v[id];
  if (!parent) return [];
  const rank = (t) => (t.meta === 1 && t.attrs.get(633) > 0 ? 1 : VAR_ORDER[t.meta] ?? 9);
  return Object.keys(v).filter((k) => v[k] === parent).map((k) => type(Number(k))).filter(Boolean)
    .sort((a, b) => rank(a) - rank(b) || (a.attrs.get(633) || 0) - (b.attrs.get(633) || 0) || a.name.localeCompare(b.name, 'zh'));
}
function variantsHtml(list, current, swappable) {
  return `<div class="fi-vars">${list.map((t) => {
    const meta = metaTag(t) || (t.meta === 1 ? ['T1', 't1'] : null);
    const res = t.category === FE.CAT.module ? [t.attrs.get(FE.AT.cpu) ? `${fmt(t.attrs.get(FE.AT.cpu))} tf` : '', t.attrs.get(FE.AT.power) ? `${fmt(t.attrs.get(FE.AT.power))} MW` : ''].filter(Boolean).join(' · ') : '';
    return `<div class="fi-var${t.id === current ? ' is-current' : ''}"><button type="button" class="fi-var-main" data-fit-info="${t.id}">
      <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
      <span class="fi-var-name">${app.esc(t.name)}${res ? `<small>${res}</small>` : ''}</span>
      ${t.attrs.get(633) ? `<small class="fi-var-ml">衍生等级 ${t.attrs.get(633)}</small>` : ''}
      ${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}
    </button>${swappable && t.id !== current ? `<button type="button" class="btn btn-ghost btn-sm fi-var-swap" data-fi-swap="${t.id}">替换</button>` : ''}</div>`;
  }).join('')}</div>`;
}

// 衍生里的「替换」：把打开详情的那一个（舰船 / 槽位里的装备 / 那组无人机）换成选中的衍生；
// 换船和左侧选船一样：有这艘船上次的装配就载入，没有就从空船开始
function swapType(from, to) {
  const src = F.infoSrc;
  const a = type(from), b = type(to);
  if (!a || !b || sourceType(src) !== from) return false;
  const f = F.fit;
  if (src.kind === 'ship') { F.infoSrc = null; setShip(to); return true; }
  if (src.kind === 'mod') {
    const m = f.slots[src.slot][src.index];
    const why = FE.cannotFit(F.data, type(f.ship), b);
    if (why) { app.showToast(`${b.name}：${why}`, 'error'); return false; }
    Object.assign(m, { type: to, state: m.state === 'offline' ? 'offline' : defaultState(b) });
    delete m.mut; delete m.abyssal;
    if (m.charge && !FE.chargeFits(b, type(m.charge))) m.charge = null;
  } else {
    const d = f.drones[src.index];
    const same = f.drones.find((x) => x.type === to);
    if (same) { same.count += d.count; f.drones.splice(src.index, 1); } else d.type = to;
    autoActivateDrones();
  }
  F.infoSrc = null;
  F.selected = null;
  recompute();
  trimSlots();
  app.showToast(`已把 ${a.name} 替换为 ${b.name}`, 'success', 1800);
  return true;
}

function fmt(v, d = 1) {
  return Number.isInteger(v) ? app.formatNumber(v) : v.toFixed(d).replace(/\.0+$/, '');
}

// ---------- 使用物品 ----------
function useType(id) {
  const t = type(id);
  if (!t) return;
  if (t.category === FE.CAT.ship) { setShip(id); return; }
  if (!F.fit) { app.showToast('请先选择一艘舰船', 'info'); setTab('ship'); return; }
  if (t.category === FE.CAT.module || t.category === FE.CAT.subsystem) addModule(t);
  else if (t.category === FE.CAT.charge) loadCharge(t);
  else if (t.category === FE.CAT.drone) addDrone(t);
  else if (t.category === FE.CAT.fighter) addFighter(t);
  else if (t.category === FE.CAT.implant) addImplant(t);
  if (MOBILE()) app.closeDrawer?.();
}

const MOBILE = () => window.matchMedia('(max-width: 768px)').matches;

// ---------- 每艘船的草稿 ----------
// 换船、打开已保存的装配、新建、导入前，把当前装配记为这艘船的草稿（只记有装备且与已保存版本不同的）；
// 换回这艘船时载入草稿，没有草稿就从空船开始；保存装配后清掉这艘船的草稿
const fitBody = (f) => JSON.stringify([f.name || '', FE.SLOTS.map((s) => (f.slots[s] || []).filter(Boolean)), f.drones || [], f.implants || []]);
function isUnsaved(f) {
  if (!f || (!FE.SLOTS.some((s) => f.slots[s].some(Boolean)) && !f.drones.length)) return false;
  const saved = f.id && savedFits().find((x) => x.id === f.id);
  return !saved || fitBody(normalize(saved)) !== fitBody(f);
}
function drafts() {
  const d = app.store.getJSON(DRAFTS_KEY, {});
  return d && typeof d === 'object' ? d : {};
}
function stashDraft(f) {
  if (!isUnsaved(f)) return;   // 已保存或空的不记，也不覆盖这艘船之前的草稿
  const d = drafts();
  d[f.ship] = { ...JSON.parse(JSON.stringify(f)), at: Date.now() };
  const keep = Object.entries(d).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 30);
  app.store.setJSON(DRAFTS_KEY, Object.fromEntries(keep));
}
function dropDraft(ship) {
  const d = drafts();
  if (d[ship]) { delete d[ship]; app.store.setJSON(DRAFTS_KEY, d); }
}
function takeDraft(ship) {
  const f = drafts()[ship];
  return f ? normalize(f) : null;
}

function setShip(id) {
  if (F.fit?.ship === id) { if (F.tab === 'ship') setTab('module'); return; }
  stashDraft(F.fit);
  const draft = takeDraft(id);
  F.fit = draft || newFit(id);
  if (draft) app.showToast(`已载入${type(id).name}上次未保存的装配`, 'info', 3000);
  F.selected = null;
  F.slotFilter = null;
  recompute();
  trimSlots();
  if (F.tab === 'ship') setTab('module');
}

// 舰船槽位变化（换船、子系统）后，超出部分若为空位则去掉
function trimSlots() {
  if (!F.stats) return;
  let changed = false;
  for (const s of FE.SLOTS) {
    const list = F.fit.slots[s];
    while (list.length > F.stats.slots[s] && list[list.length - 1] == null) { list.pop(); changed = true; }
  }
  if (changed) recompute();
}

function defaultState(t) {
  return t.activatable ? 'active' : 'online';
}

function addModule(t) {
  const why = FE.cannotFit(F.data, type(F.fit.ship), t);
  if (why) { app.showToast(`${t.name}：${why}`, 'error'); return; }
  const slot = t.slot;
  const list = F.fit.slots[slot];
  const mod = { type: t.id, state: defaultState(t), charge: null };
  if (slot === 'sub') {
    // 子系统：同一类（核心 / 防御 / 攻击 / 推进）只能装一个，替换已有的
    const kind = t.attrs.get(FE.AT.subSystemSlot);
    const idx = list.findIndex((m) => m && type(m.type).attrs.get(FE.AT.subSystemSlot) === kind);
    if (idx >= 0) list[idx] = mod; else list.push(mod);
    recompute();
    trimSlots();
    return;
  }
  const total = F.stats?.slots[slot] || 0;
  let idx = list.findIndex((m, i) => !m && i < total);
  if (idx < 0 && list.length < total) idx = list.length;
  if (idx < 0) { app.showToast(`${FE.SLOT_NAME[slot]}已满`, 'error'); return; }
  // 同类武器自动装填与已装同型号相同的弹药
  const twin = list.find((m) => m && m.type === t.id && m.charge);
  if (twin) mod.charge = twin.charge;
  list[idx] = mod;
  F.selected = { slot, index: idx };
  recompute();
}

function fittedModules() {
  const out = [];
  for (const s of FE.SLOTS) F.fit.slots[s].forEach((m, i) => { if (m) out.push({ m, slot: s, index: i }); });
  return out;
}

function loadCharge(t) {
  const mods = fittedModules().filter(({ m }) => FE.chargeFits(type(m.type), t));
  if (!mods.length) { app.showToast(`没有能装填 ${t.name} 的装备`, 'error'); return; }
  // 选中了某个装备：装填同型号的全部装备；否则装填所有能用的
  const sel = F.selected && F.fit.slots[F.selected.slot][F.selected.index];
  const targets = sel && FE.chargeFits(type(sel.type), t) ? mods.filter(({ m }) => m.type === sel.type) : mods;
  targets.forEach(({ m }) => { m.charge = t.id; });
  app.showToast(`已为 ${targets.length} 个装备装填 ${t.name}`, 'success', 1800);
  recompute();
}

function addDrone(t) {
  const d = F.fit.drones.find((x) => x.type === t.id);
  const bay = F.stats.resources.droneBay;
  const vol = t.attrs.get(FE.AT.volume) || 0;
  if (vol && bay.used + vol > bay.total + 1e-6) { app.showToast('无人机挂舱容量不足', 'error'); return; }
  if (d) d.count += 1;
  else F.fit.drones.push({ type: t.id, count: 1, active: 0 });
  autoActivateDrones();
  recompute();
}

const isFighter = (d) => type(d.type)?.category === FE.CAT.fighter;

// 在带宽与同时操作上限内尽量激活无人机；舰载机在发射管与轻型 / 支援 / 重型位内尽量出击
function autoActivateDrones() {
  const calc = FE.computeFit(F.data, F.fit, skills());
  const limit = calc.char.attr(FE.AT.maxActiveDrones);
  let bw = calc.ship.attr(FE.AT.droneBandwidth);
  let n = 0;
  let tubes = calc.ship.attr(FE.AT.fighterTubes);
  const role = { light: calc.ship.attr(FE.AT.fighterLightSlots), support: calc.ship.attr(FE.AT.fighterSupportSlots), heavy: calc.ship.attr(FE.AT.fighterHeavySlots) };
  for (const d of F.fit.drones.filter(isFighter)) {
    const t = type(d.type);
    const r = t.attrs.get(FE.AT.fighterIsHeavy) ? 'heavy' : t.attrs.get(FE.AT.fighterIsSupport) ? 'support' : 'light';
    d.active = 0;
    while (d.active < d.count && tubes > 0 && role[r] > 0) { d.active++; tubes--; role[r]--; }
  }
  for (const d of F.fit.drones.filter((x) => !isFighter(x))) {
    const per = type(d.type).attrs.get(FE.AT.droneBandwidthUsed) || 0;
    d.active = 0;
    while (d.active < d.count && n < limit && (per === 0 || bw >= per - 1e-6)) { d.active++; n++; bw -= per; }
  }
}

// 一键开 / 关：主动装备全部激活或全部停用（停用 = 在线不激活）；离线的装备开启时恢复在线
function setAllStates(on) {
  for (const { m, slot } of fittedModules()) {
    if (slot === 'rig' || slot === 'sub') continue;
    const t = type(m.type);
    if (on) m.state = t.activatable ? 'active' : 'online';
    else if (t.activatable) m.state = 'online';
  }
  recompute();
}

// 清空装备（保留舰船、子系统与植入体）
function clearModules() {
  if (!fittedModules().some(({ slot }) => slot !== 'sub') && !F.fit.drones.length) return;
  if (!confirm('清空全部装备、弹药和无人机？')) return;
  for (const s of ['high', 'mid', 'low', 'rig']) F.fit.slots[s] = [];
  F.fit.drones = [];
  F.selected = null;
  recompute();
  app.showToast('已清空装备', 'success', 1500);
}

// 右键装备状态按钮：切换超载
function onStateContext(e) {
  const x = e.target.closest('[data-fit-state]');
  if (!x) return;
  e.preventDefault();
  const { slot, index } = parseRef(x.dataset.fitState);
  const m = F.fit.slots[slot][index];
  if (!type(m.type).overloadable) return;
  m.state = m.state === 'overload' ? 'active' : 'overload';
  recompute();
}

// 智能装配 / 击杀记录装配：替换当前装配（无人机按带宽自动激活）
function applyFit(fit) {
  if (F.fit && F.fit.ship !== fit.ship) stashDraft(F.fit);
  F.fit = normalize(fit);
  F.selected = null;
  autoActivateDrones();
  recompute();
  renderBrowser();
}

// 舰载机按中队添加（每个中队满编）
function addFighter(t) {
  const res = F.stats.resources;
  if (!res.fighterBay.total) { app.showToast('这艘船没有舰载机机库', 'error'); return; }
  const vol = (t.attrs.get(FE.AT.volume) || 0) * (t.attrs.get(FE.AT.fighterSquadronSize) || 1);
  if (res.fighterBay.used + vol > res.fighterBay.total + 1e-6) { app.showToast('舰载机机库容量不足', 'error'); return; }
  const d = F.fit.drones.find((x) => x.type === t.id);
  if (d) d.count += 1;
  else F.fit.drones.push({ type: t.id, count: 1, active: 0 });
  autoActivateDrones();
  recompute();
}

function addImplant(t) {
  const slotAttr = t.attrs.has(IMPLANT_SLOT) ? IMPLANT_SLOT : BOOSTER_SLOT;
  const slot = t.attrs.get(slotAttr);
  F.fit.implants = F.fit.implants.filter((id) => type(id).attrs.get(slotAttr) !== slot || !type(id).attrs.has(slotAttr));
  F.fit.implants.push(t.id);
  recompute();
}

// ---------- 中间：装配 ----------
function renderFit() {
  const box = $('fitMain');
  if (!F.data) return;
  if (!F.fit) {
    box.innerHTML = `<div class="fit-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="M12 22V12M4 7l8 5 8-5"/></svg>
      <h3>从左侧选择一艘舰船开始装配</h3>
      <p class="fit-empty-tools"><button class="btn btn-ghost" data-fit-sim>模拟对打</button></p>
      <p>也可以 <button class="link-btn" data-fit-import>导入 EFT 文本</button>${app.hasEsiToken() ? '、<button class="link-btn" data-fit-esi-list>读取游戏内装配</button>' : ''}${savedFits().length ? ` 或打开 <select class="plain-select" data-fit-open><option value="">我的装配…</option>${savedFits().map((f) => `<option value="${f.id}">${app.esc(f.name || type(f.ship)?.name || '未命名')}</option>`).join('')}</select>` : ''}</p>
    </div>`;
    if (MOBILE()) app.openDrawer?.();
    return;
  }
  const shipType = type(F.fit.ship);
  const st = F.stats;
  const saved = savedFits();
  const bound = app.hasEsiToken();
  const slotRows = FE.SLOTS.map((s) => {
    const total = st.slots[s] || 0;
    const list = F.fit.slots[s];
    const n = Math.max(total, list.length);
    if (!n) return '';
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(moduleRow(s, i, list[i], i >= total));
    return `<section class="fit-slots"><h4>${FE.SLOT_NAME[s]}<span>${st.used[s]} / ${fmt(total)}</span></h4>${rows.join('')}</section>`;
  }).join('');
  const missing = F.skillMode === 'esi' && F.esi ? FE.missingSkills(F.data, F.fit, F.esi.levels) : [];
  box.innerHTML = `
    <div class="fit-head">
      <img class="fit-ship-img" src="${IMG(shipType.id, 'render', 128)}" alt="" width="88" height="88">
      <div class="fit-head-main">
        <span class="fit-ship-group">${app.esc(F.data.groups.get(shipType.group)?.name || '')}</span>
        <h2>${app.esc(shipType.name)}${infoBtn(shipType.id)}</h2>
        <input class="fit-name" id="fitName" value="${app.esc(F.fit.name)}" placeholder="装配名称" maxlength="60" aria-label="装配名称">
      </div>
      <div class="fit-actions">
        <button class="btn btn-primary" data-fit-save>${F.fit.id ? '保存' : '保存装配'}</button>
        <select class="plain-select" data-fit-open aria-label="我的装配"><option value="">我的装配${saved.length ? `（${saved.length}）` : ''}</option>${saved.map((f) => `<option value="${f.id}"${f.id === F.fit.id ? ' selected' : ''}>${app.esc(f.name || type(f.ship)?.name || '未命名')} · ${app.esc(type(f.ship)?.name || '')}</option>`).join('')}</select>
        <div class="fit-action-row fit-plan-row">
          <button class="btn btn-ghost fit-plan-btn" data-fit-auto title="按目标与约束自动装配">智能装配</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-imp title="装备不动，按目标推荐植入体">智能植入体</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-kb title="这艘船最近阵亡时的常见装配">击杀记录装配</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-graph title="有效 DPS 随距离、目标速度、信号半径变化的曲线（类似 Pyfa 的图表）">伤害图表</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-sim title="打开「模拟对打」页：两方舰队按装配模拟交战">模拟对打</button>
        </div>
        <div class="fit-action-row">
          <button class="btn btn-ghost" data-fit-new title="新建空装配">新建</button>
          <button class="btn btn-ghost" data-fit-import title="粘贴 EFT 格式文本">导入</button>
          <button class="btn btn-ghost" data-fit-export title="复制为 EFT 格式（可导入游戏或 Pyfa）">导出</button>
          <button class="btn btn-ghost" data-fit-share title="复制分享链接">分享</button>
          <button class="btn btn-ghost" data-fit-cart title="舰船、装备、弹药、无人机和植入体加入购物车（突变装备按原装备 + 突变质体）">加入购物车</button>
          <button class="btn btn-ghost" data-fit-esi-list title="${bound ? '读取已绑定角色在游戏里保存的装配' : '需要先绑定 ESI'}"${bound ? '' : ' disabled'}>游戏装配</button>
          <button class="btn btn-ghost" data-fit-esi-save title="${bound ? '通过 ESI 保存到游戏装配窗口（个人装配）' : '需要先绑定 ESI'}"${bound ? '' : ' disabled'}>存到游戏</button>
          ${F.fit.id ? '<button class="btn btn-ghost danger" data-fit-delete title="删除已保存的装配">删除</button>' : ''}
        </div>
      </div>
    </div>
    <div class="fit-skillbar">
      <span>技能</span>
      <div class="segmented" role="group" aria-label="技能来源">
        <button data-fit-skill="max" class="${F.skillMode === 'max' ? 'active' : ''}">全部 5 级</button>
        <button data-fit-skill="esi" class="${F.skillMode === 'esi' ? 'active' : ''}"${bound ? '' : ' disabled title="需要先绑定 ESI"'}>${F.esi && F.skillMode === 'esi' ? app.esc(F.esi.name) + ' 的技能' : '按 ESI 角色'}</button>
      </div>
      <span class="fit-bulk"><button class="link-btn" data-fit-all="on" title="主动装备全部激活">全部开启</button><button class="link-btn" data-fit-all="off" title="主动装备全部停用">全部关闭</button><button class="link-btn danger" data-fit-clear title="清空全部装备、弹药和无人机">清空装备</button></span>
      ${missing.length ? `<span class="fit-missing" title="${app.esc(missing.map((m) => `${m.type?.name || m.type} ${m.have} → ${m.need} 级`).join('\n'))}">缺少 ${missing.length} 项技能</span>` : F.skillMode === 'esi' && F.esi ? '<span class="fit-ok">技能满足</span>' : ''}
    </div>
    ${problemsHtml(st.problems)}
    ${slotRows}
    ${dronesHtml()}
    ${implantsHtml(bound)}
    ${missing.length ? `<section class="fit-slots"><h4>缺少的技能<span>${missing.length}</span></h4><div class="fit-skill-list">${missing.map((m) => `<span>${app.esc(m.type?.name || '')} <b>${m.have} → ${m.need}</b></span>`).join('')}</div></section>` : ''}`;
}

function problemsHtml(list) {
  if (!list.length) return '';
  return `<div class="fit-problems">${list.map((p) => `<p class="is-${p.level}">${app.esc(p.text)}</p>`).join('')}</div>`;
}

function moduleRow(slot, index, m, extra) {
  const empty = `<div class="fit-slot is-empty${extra ? ' is-extra' : ''}" data-fit-empty="${slot}"><span class="fit-slot-icon"></span><span>${extra ? '超出槽位' : '空' + FE.SLOT_NAME[slot]}</span></div>`;
  if (!m) return empty;
  const t = type(m.type);
  const item = F.calc.modules.find((x) => x.slot === slot && x.index === index);
  const sel = F.selected && F.selected.slot === slot && F.selected.index === index;
  const ct = m.charge && type(m.charge);
  const fixed = slot === 'rig' || slot === 'sub';
  const err = F.stats.problems.some((p) => p.module === item && p.level === 'error');
  const needsCharge = FE.AT.chargeGroups.some((a) => t.attrs.get(a));
  // 状态：主动装备显示 激活 / 已关闭 / 超载，被动装备显示 在线；离线时整行变暗
  const off = t.activatable && m.state === 'online';
  const label = m.state === 'offline' ? '离线' : m.state === 'overload' ? '超载' : m.state === 'active' ? '激活' : off ? '已关闭' : '在线';
  const stateBtn = fixed ? '' : `<button class="fit-state-pill s-${off ? 'off' : m.state}" data-fit-state="${slot}:${index}" title="点击${t.activatable ? '开启 / 关闭' : '在线 / 离线'} · Shift 点击离线" aria-label="切换状态">${label}</button>`;
  const olBtn = !fixed && t.overloadable ? `<button class="fit-ol-btn${m.state === 'overload' ? ' on' : ''}" data-fit-overload="${slot}:${index}" title="${m.state === 'overload' ? '关闭超载' : '超载'}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2s5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z"/></svg>超载</button>` : '';
  return `<div class="fit-slot${sel ? ' is-selected' : ''}${err || extra ? ' is-error' : ''} is-${off ? 'off' : m.state}" data-fit-mod="${slot}:${index}">
    <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
    <span class="fit-slot-name"><span class="fit-slot-title">${app.esc(t.name)}${m.mut ? `<em class="fit-mut-tag" title="${app.esc(MU.mutSummary(m))}">突变</em>` : MU.isBareAbyssal(m) ? '<em class="fit-mut-tag warn" title="来自游戏装配或击杀邮件，没有突变属性，按默认值计算">未设属性</em>' : ''}</span>${item && moduleNote(item) ? `<small>${moduleNote(item)}</small>` : ''}</span>
    ${!fixed && MU.canMutate(m) ? `<button class="fit-mut-btn${m.mut ? ' on' : ''}" data-fit-mut="${slot}:${index}" title="${m.mut ? '修改突变属性' : '突变成深渊装备并自定义属性'}">${m.mut ? '改属性' : '突变'}</button>` : ''}
    ${ct ? `<span class="fit-charge" title="${app.esc(ct.name)} × ${FE.chargeCount(t, ct)}"><img src="${IMG(ct.id)}" alt="" width="20" height="20" loading="lazy">${app.esc(shortName(ct.name))}<button data-fit-uncharge="${slot}:${index}" aria-label="卸下弹药">×</button></span>`
      : needsCharge ? `<button class="fit-charge is-empty" data-fit-pick-charge="${slot}:${index}">装填弹药</button>` : ''}
    ${olBtn}${stateBtn}${infoBtn(t.id)}
    <button class="fit-remove" data-fit-remove="${slot}:${index}" title="移除" aria-label="移除">×</button>
  </div>`;
}

function shortName(name) {
  return name.length > 14 ? name.slice(0, 13) + '…' : name;
}

// 装备行下的小字：武器 DPS 与射程，或修理量
function moduleNote(item) {
  const w = F.stats.weapons.find((x) => x.module === item);
  if (w) return `${w.dps.toFixed(1)} DPS · ${dist(w.range)}${w.falloff ? ' + ' + dist(w.falloff) : ''}`;
  return '';
}

function dist(m) {
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' km' : Math.round(m) + ' m';
}

function droneRow(d, i, fighter) {
  const t = type(d.type);
  const size = fighter ? t.attrs.get(FE.AT.fighterSquadronSize) || 1 : 1;
  const unit = fighter ? '中队' : '架';
  return `<div class="fit-slot fit-drone">
    <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
    <span class="fit-slot-name">${app.esc(t.name)}<small>${fighter ? `每中队 ${size} 架 · 出击 ${d.active} / ${d.count}` : `激活 ${d.active} / ${d.count}`}</small></span>
    <span class="fit-stepper" title="数量（${unit}）"><button data-fit-drone="${i}:count:-1" aria-label="减少">−</button><b>${d.count}</b><button data-fit-drone="${i}:count:1" aria-label="增加">+</button></span>
    <span class="fit-stepper is-active" title="${fighter ? '出击中队' : '激活数量'}"><button data-fit-drone="${i}:active:-1" aria-label="减少">−</button><b>${d.active}</b><button data-fit-drone="${i}:active:1" aria-label="增加">+</button></span>
    ${infoBtn(t.id)}
    <button class="fit-remove" data-fit-drone-remove="${i}" title="移除" aria-label="移除">×</button>
  </div>`;
}

function dronesHtml() {
  const res = F.stats.resources;
  let html = '';
  const drones = F.fit.drones.map((d, i) => [d, i]).filter(([d]) => !isFighter(d));
  const fighters = F.fit.drones.map((d, i) => [d, i]).filter(([d]) => isFighter(d));
  if (res.droneBay.total || drones.length) {
    html += `<section class="fit-slots"><h4>无人机<span>挂舱 ${fmt(res.droneBay.used)} / ${fmt(res.droneBay.total)} m³ · 带宽 ${fmt(res.bandwidth.used)} / ${fmt(res.bandwidth.total)}</span></h4>
      ${drones.map(([d, i]) => droneRow(d, i, false)).join('') || '<div class="fit-slot is-empty" data-fit-empty-drone><span class="fit-slot-icon"></span><span>从左侧「无人机」中添加</span></div>'}</section>`;
  }
  if (res.fighterBay.total || fighters.length) {
    const roles = [['fighterLight', '轻型'], ['fighterSupport', '支援'], ['fighterHeavy', '重型']].filter(([k]) => res[k].total).map(([k, l]) => `${l} ${res[k].used}/${res[k].total}`).join(' · ');
    html += `<section class="fit-slots"><h4>舰载机<span>机库 ${fmt(res.fighterBay.used)} / ${fmt(res.fighterBay.total)} m³ · 发射管 ${res.fighterTubes.used} / ${res.fighterTubes.total}${roles ? ' · ' + roles : ''}</span></h4>
      ${fighters.map(([d, i]) => droneRow(d, i, true)).join('') || '<div class="fit-slot is-empty" data-fit-empty-drone><span class="fit-slot-icon"></span><span>从左侧「无人机」中添加舰载机</span></div>'}</section>`;
  }
  return html;
}

function implantsHtml(bound) {
  const rows = F.fit.implants.map((id) => {
    const t = type(id);
    const slot = t.attrs.get(IMPLANT_SLOT);
    return `<div class="fit-slot"><img src="${IMG(id)}" alt="" width="28" height="28" loading="lazy"><span class="fit-slot-name">${app.esc(t.name)}<small>${slot ? '植入体槽位 ' + slot : '增效剂'}</small></span><button class="fit-remove" data-fit-implant-remove="${id}" aria-label="移除">×</button></div>`;
  }).join('');
  return `<section class="fit-slots"><h4>植入体 / 增效剂<span><button class="link-btn" data-fit-imp>智能推荐</button>${bound ? '<button class="link-btn" data-fit-my-implants>导入当前角色的植入体</button>' : ''}</span></h4>
    ${rows || '<div class="fit-slot is-empty" data-fit-empty-implant><span class="fit-slot-icon"></span><span>从左侧「植入体」中添加</span></div>'}</section>`;
}

// ---------- 右侧：属性 ----------
function renderStats() {
  const box = $('fitStats');
  if (!box) return;
  if (!F.fit || !F.stats) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const s = F.stats;
  const r = s.resources;
  const bar = (label, v, unit = '', digits = 1) => {
    const pct = v.total ? Math.min(100, v.used / v.total * 100) : (v.used ? 100 : 0);
    const over = v.used > v.total + 1e-6;
    return `<div class="fit-bar${over ? ' is-over' : ''}"><div class="fit-bar-head"><span>${label}</span><b>${fmt(v.used, digits)} / ${fmt(v.total, digits)}${unit}</b></div><i style="width:${pct.toFixed(1)}%"></i></div>`;
  };
  const resRow = (label, values) => `<tr><th>${label}</th>${values.map((v) => `<td style="--r:${(v * 100).toFixed(0)}%">${(v * 100).toFixed(1)}%</td>`).join('')}</tr>`;
  const d = s.defense;
  const cap = s.capacitor;
  refreshFitValue();
  const v = F.val;
  box.innerHTML = `
    <section class="fit-stat-block">
      <h4>装配资源</h4>
      ${bar('CPU', r.cpu, ' tf')}
      ${bar('能量栅格', r.power, ' MW')}
      ${r.calibration.total ? bar('校准值', r.calibration, '', 0) : ''}
      <div class="fit-kv"><span>炮台安装座</span><b class="${r.turrets.used > r.turrets.total ? 'bad' : ''}">${r.turrets.used} / ${fmt(r.turrets.total)}</b></div>
      <div class="fit-kv"><span>发射器安装座</span><b class="${r.launchers.used > r.launchers.total ? 'bad' : ''}">${r.launchers.used} / ${fmt(r.launchers.total)}</b></div>
    </section>
    <section class="fit-stat-block">
      <h4>火力<b>${s.weapon.total.toFixed(1)} DPS</b></h4>
      <div class="fit-kv"><span>炮台</span><b>${s.weapon.turret.toFixed(1)}</b></div>
      <div class="fit-kv"><span>导弹</span><b>${s.weapon.missile.toFixed(1)}</b></div>
      <div class="fit-kv"><span>无人机</span><b>${s.weapon.drone.toFixed(1)}</b></div>
      ${s.weapon.fighter || r.fighterBay.total ? `<div class="fit-kv"><span>舰载机</span><b>${s.weapon.fighter.toFixed(1)}</b></div>` : ''}
      <div class="fit-kv"><span>齐射伤害</span><b>${app.formatNumber(Math.round(s.weapon.volley))}</b></div>
      ${s.weapon.total ? `<div class="fit-dmg">${['em', 'th', 'ki', 'ex'].map((k, i) => `<i class="is-${k}" style="flex:${s.weapon.types[i] || 0.0001}" title="${['电磁', '热能', '动能', '爆炸'][i]} ${(s.weapon.types[i] / s.weapon.total * 100).toFixed(0)}%"></i>`).join('')}</div>` : ''}
    </section>
    <section class="fit-stat-block">
      <h4>防御<b>${app.formatNumber(Math.round(d.ehp))} EHP</b></h4>
      <table class="fit-resist">
        <thead><tr><th></th><th class="is-em">电磁</th><th class="is-th">热能</th><th class="is-ki">动能</th><th class="is-ex">爆炸</th><th>HP</th></tr></thead>
        <tbody>
          ${resRow('护盾', d.shield.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.shield.hp))}</td></tr>`)}
          ${resRow('装甲', d.armor.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.armor.hp))}</td></tr>`)}
          ${resRow('结构', d.hull.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.hull.hp))}</td></tr>`)}
        </tbody>
      </table>
      <div class="fit-kv"><span>护盾自然回充峰值</span><b>${d.passiveRegen.toFixed(1)} HP/s</b></div>
      ${d.reps.shield ? `<div class="fit-kv"><span>护盾主动回充</span><b>${d.reps.shield.toFixed(1)} HP/s · ${d.repsEhp.shield.toFixed(1)} EHP/s</b></div>` : ''}
      ${d.reps.armor ? `<div class="fit-kv"><span>装甲维修</span><b>${d.reps.armor.toFixed(1)} HP/s · ${d.repsEhp.armor.toFixed(1)} EHP/s</b></div>` : ''}
      ${d.reps.hull ? `<div class="fit-kv"><span>结构维修</span><b>${d.reps.hull.toFixed(1)} HP/s</b></div>` : ''}
      <p class="fit-hint">EHP 按四种伤害各 25% 计算</p>
    </section>
    <section class="fit-stat-block">
      <h4>电容<b class="${cap.stable ? 'good' : 'bad'}">${cap.stable ? '稳定 ' + (cap.level * 100).toFixed(1) + '%' : '可维持 ' + duration(cap.lasts)}</b></h4>
      <div class="fit-kv"><span>容量</span><b>${app.formatNumber(Math.round(cap.capacity))} GJ</b></div>
      <div class="fit-kv"><span>充能时间</span><b>${duration(cap.recharge)}</b></div>
      <div class="fit-kv"><span>消耗 / 峰值回充</span><b>${cap.usage.toFixed(1)} / ${cap.peak.toFixed(1)} GJ/s</b></div>
    </section>
    <section class="fit-stat-block">
      <h4>机动</h4>
      <div class="fit-kv"><span>最大速度</span><b>${fmt(s.navigation.velocity)} m/s</b></div>
      <div class="fit-kv"><span>起跳时间</span><b>${s.navigation.align.toFixed(2)} 秒</b></div>
      <div class="fit-kv"><span>跃迁速度</span><b>${fmt(s.navigation.warp, 2)} AU/s</b></div>
      <div class="fit-kv"><span>信号半径</span><b>${fmt(s.navigation.signature)} m</b></div>
      <div class="fit-kv"><span>质量</span><b>${app.formatNumber(Math.round(s.navigation.mass))} kg</b></div>
    </section>
    <section class="fit-stat-block">
      <h4>锁定</h4>
      <div class="fit-kv"><span>锁定距离</span><b>${dist(s.targeting.range)}</b></div>
      <div class="fit-kv"><span>扫描分辨率</span><b>${fmt(s.targeting.scanRes)} mm</b></div>
      <div class="fit-kv"><span>最大锁定数</span><b>${fmt(s.targeting.maxTargets)}</b></div>
      <div class="fit-kv"><span>${s.targeting.sensorType}感应强度</span><b>${fmt(s.targeting.sensor)}</b></div>
    </section>
    <section class="fit-stat-block">
      <h4>其他</h4>
      <div class="fit-kv"><span>货柜舱</span><b>${fmt(s.cargo)} m³</b></div>
    </section>
    ${v ? `<section class="fit-stat-block">
      <h4>估价</h4>
      <div class="fit-val-src">${app.valuation.select('data-val-src', v.region)}</div>
      <div class="fit-kv"><span>最低卖价</span><b>${app.formatISK(v.sell)} ISK</b></div>
      <div class="fit-kv"><span>最高收价</span><b>${app.formatISK(v.buy)} ISK</b></div>
      ${v.aby?.n ? `<div class="fit-kv"><span>深渊参考估价</span><b>${app.formatISK(v.aby.all)} ISK</b></div>` : ''}
      <p class="fit-note">${v.aby?.n ? (v.aby.included ? `含 ${v.aby.included} 件深渊参考估价` : `${v.aby.n} 件深渊估价未计入`) : ''}${v.sellN < v.n ? `${v.aby?.n ? ' · ' : ''}${v.n - v.sellN} 种无卖单` : ''}</p>
    </section>` : ''}
    ${insuranceBlock()}`;
}

// 舰船保险：各档保费与赔付（ESI /insurance/prices/），净赔付 = 赔付 − 保费
function insuranceBlock() {
  const levels = F.insurance?.get(F.fit?.ship)?.filter((l) => l.payout > 0);
  if (!levels?.length) return '';
  return `<section class="fit-stat-block">
      <h4>保险（12 周）</h4>
      ${levels.map((l) => `<div class="fit-kv"><span>${app.esc(l.name)}</span><b title="保费 ${app.formatISK(l.cost)} · 赔付 ${app.formatISK(l.payout)}">${app.formatISK(l.cost)} → ${app.formatISK(l.payout)}</b></div>`).join('')}
      
    </section>`;
}

function duration(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + ' 小时 ' + Math.round(sec % 3600 / 60) + ' 分';
  if (sec >= 60) return Math.floor(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒';
  return sec.toFixed(1) + ' 秒';
}

// 装配估价：按所选交易中心（或全宇宙）的最低卖 / 最高收，装配变化或切换来源时重新查询后重绘
let valSeq = 0;
function refreshFitValue() {
  if (!F.fit) return;
  const list = [{ type_id: F.fit.ship, quantity: 1 }];
  for (const { m } of fittedModules()) {
    list.push({ type_id: m.type, quantity: 1 });
    if (m.charge) list.push({ type_id: m.charge, quantity: FE.chargeCount(type(m.type), type(m.charge)) });
  }
  for (const d of F.fit.drones) list.push({ type_id: d.type, quantity: d.count });
  for (const id of F.fit.implants) list.push({ type_id: id, quantity: 1 });
  // 突变装备勾选了「计入装配总价」的深渊参考估价（市场上没有这些单件的挂单价）
  const aby = fittedModules().filter(({ m }) => m.mut && m.abyssal?.value);
  const abyIn = aby.filter(({ m }) => m.abyssal.include).reduce((t, { m }) => t + m.abyssal.value, 0);
  const abyAll = aby.reduce((t, { m }) => t + m.abyssal.value, 0);
  const key = app.valuation.region().id + '|' + list.map((i) => i.type_id + 'x' + i.quantity).join(',') + '|' + abyIn + '/' + abyAll;
  if (F.valKey === key) return;
  F.valKey = key;
  const seq = ++valSeq;
  app.valuation.items(list).then((v) => {
    if (seq !== valSeq) return;
    F.val = { ...v, sell: v.sell + abyIn, buy: v.buy + abyIn, aby: { n: aby.length, included: aby.filter(({ m }) => m.abyssal.include).length, value: abyIn, all: abyAll } };
    renderStats();
  }).catch(() => {});
}

// ---------- 交互 ----------
function parseRef(v) {
  const [slot, index] = v.split(':');
  return { slot, index: Number(index) };
}

async function onMainClick(e) {
  const el = (sel) => e.target.closest(sel);
  let x;
  if ((x = el('[data-fit-state]'))) {
    const { slot, index } = parseRef(x.dataset.fitState);
    const m = F.fit.slots[slot][index];
    const t = type(m.type);
    // 点击开 / 关：主动装备在激活与在线之间切换，被动装备在在线与离线之间切换；按住 Shift 切换离线
    if (e.shiftKey) m.state = m.state === 'offline' ? defaultState(t) : 'offline';
    else if (t.activatable) m.state = m.state === 'active' || m.state === 'overload' ? 'online' : 'active';
    else m.state = m.state === 'offline' ? 'online' : 'offline';
    recompute();
    return;
  }
  if ((x = el('[data-fit-overload]'))) {
    const { slot, index } = parseRef(x.dataset.fitOverload);
    const m = F.fit.slots[slot][index];
    m.state = m.state === 'overload' ? 'active' : 'overload';
    recompute();
    return;
  }
  if ((x = el('[data-fit-sim]'))) { app.openSim(); return; }
  if ((x = el('[data-fit-graph]'))) { openTool(openGraph); return; }
  if ((x = el('[data-fit-all]'))) { setAllStates(x.dataset.fitAll === 'on'); return; }
  if ((x = el('[data-fit-clear]'))) { clearModules(); return; }
  if ((x = el('[data-fit-remove]'))) {
    const { slot, index } = parseRef(x.dataset.fitRemove);
    F.fit.slots[slot][index] = null;
    if (slot === 'sub') F.fit.slots.sub = F.fit.slots.sub.filter(Boolean);
    F.selected = null;
    recompute();
    trimSlots();
    return;
  }
  if ((x = el('[data-fit-mut]'))) {
    const { slot, index } = parseRef(x.dataset.fitMut);
    const m = F.fit.slots[slot][index];
    MU.openMutate(m, ({ type: t, mut, abyssal }) => {
      const cur = F.fit.slots[slot][index];
      if (!cur) return;
      cur.type = t;
      if (mut) cur.mut = mut; else delete cur.mut;
      if (mut && abyssal) cur.abyssal = abyssal; else delete cur.abyssal;
      recompute();
      app.showToast(mut ? '已应用突变属性' : '已恢复为原装备', 'success');
    }).catch((e) => app.showToast('突变质体数据加载失败：' + e.message, 'error'));
    return;
  }
  if ((x = el('[data-fit-uncharge]'))) {
    const { slot, index } = parseRef(x.dataset.fitUncharge);
    F.fit.slots[slot][index].charge = null;
    recompute();
    return;
  }
  if ((x = el('[data-fit-pick-charge]'))) {
    F.selected = parseRef(x.dataset.fitPickCharge);
    F.query = '';
    $('fitSearch').value = '';
    setTab('charge');
    renderFit();
    if (MOBILE()) app.openDrawer?.();
    return;
  }
  if ((x = el('[data-fit-empty]'))) {
    F.slotFilter = x.dataset.fitEmpty;
    setTab('module');
    if (MOBILE()) app.openDrawer?.();
    return;
  }
  if (el('[data-fit-empty-drone]')) { setTab('drone'); if (MOBILE()) app.openDrawer?.(); return; }
  if (el('[data-fit-empty-implant]')) { setTab('implant'); if (MOBILE()) app.openDrawer?.(); return; }
  if ((x = el('[data-fit-mod]')) && !el('button')) {
    const ref = parseRef(x.dataset.fitMod);
    F.selected = F.selected && F.selected.slot === ref.slot && F.selected.index === ref.index ? null : ref;
    renderFit();
    if (F.tab === 'charge') renderBrowser();
    return;
  }
  if ((x = el('[data-fit-drone]'))) {
    const [i, field, delta] = x.dataset.fitDrone.split(':');
    const d = F.fit.drones[Number(i)];
    d[field] = Math.max(field === 'count' ? 1 : 0, d[field] + Number(delta));
    if (field === 'count' && Number(delta) > 0) {
      const fighter = isFighter(d);
      const bay = fighter ? F.stats.resources.fighterBay : F.stats.resources.droneBay;
      const vol = (type(d.type).attrs.get(FE.AT.volume) || 0) * (fighter ? type(d.type).attrs.get(FE.AT.fighterSquadronSize) || 1 : 1);
      if (bay.used + vol > bay.total + 1e-6) { d.count -= 1; app.showToast(fighter ? '舰载机机库容量不足' : '无人机挂舱容量不足', 'error'); return; }
    }
    d.active = Math.min(d.active, d.count);
    recompute();
    return;
  }
  if ((x = el('[data-fit-drone-remove]'))) { F.fit.drones.splice(Number(x.dataset.fitDroneRemove), 1); recompute(); return; }
  if ((x = el('[data-fit-implant-remove]'))) { F.fit.implants = F.fit.implants.filter((id) => id !== Number(x.dataset.fitImplantRemove)); recompute(); return; }
  if ((x = el('[data-fit-skill]'))) {
    const mode = x.dataset.fitSkill;
    if (mode === F.skillMode) return;
    F.skillMode = mode;
    saveSettings();
    if (mode === 'esi') await loadEsiSkills();
    recompute();
    return;
  }
  if (el('[data-fit-my-implants]')) { importMyImplants(); return; }
  if (el('[data-fit-save]')) { saveFit(); return; }
  if (el('[data-fit-new]')) { stashDraft(F.fit); F.fit = null; F.selected = null; app.store.setJSON(CURRENT_KEY, null); recompute(); setTab('ship'); return; }
  if (el('[data-fit-delete]')) { deleteFit(); return; }
  if (el('[data-fit-import]')) { openModal(); return; }
  if (el('[data-fit-export]')) { app.copyText(toEft(F.fit), '已复制 EFT 文本，可在游戏装配窗口或 Pyfa 中导入'); return; }
  if (el('[data-fit-share]')) { app.copyText(shareUrl(), '分享链接已复制'); return; }
  if (el('[data-fit-cart]')) { app.addToCart(fitShoppingList(F.fit)); return; }
  if (el('[data-fit-esi-list]')) { openEsiModal(); return; }
  if (el('[data-fit-auto]')) { openAutoFit(); return; }
  if (el('[data-fit-imp]')) { openImplantAdvisor(); return; }
  if (el('[data-fit-kb]')) { openKbFits(); return; }
  if ((x = el('[data-fit-esi-save]'))) { saveToGame(x); return; }
}

function onMainChange(e) {
  const open = e.target.closest('[data-fit-open]');
  if (open && open.value) {
    const f = savedFits().find((x) => x.id === open.value);
    if (f) { stashDraft(F.fit); F.fit = normalize(f); F.selected = null; recompute(); }
  }
}

function onMainInput(e) {
  if (e.target.id === 'fitName' && F.fit) {
    F.fit.name = e.target.value;
    app.store.setJSON(CURRENT_KEY, F.fit);
  }
}

async function loadEsiSkills() {
  try {
    F.esi = await app.getCharacterSkills();
  } catch (error) {
    F.esi = null;
    F.skillMode = 'max';
    app.showToast('读取角色技能失败：' + error.message + '，已改用全部 5 级', 'error', 4000);
  }
}

async function importMyImplants() {
  try {
    const ids = await app.getCharacterImplants();
    const valid = ids.filter((id) => F.data.types.has(id));
    F.fit.implants = valid;
    app.showToast(valid.length ? `已导入 ${valid.length} 个植入体` : '当前角色没有植入体', 'success');
    recompute();
  } catch (error) {
    app.showToast('读取植入体失败：' + error.message, 'error');
  }
}

// ---------- 保存 ----------
function savedFits() {
  const list = app.store.getJSON(SAVE_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveFit() {
  const list = savedFits();
  if (!F.fit.name.trim()) F.fit.name = type(F.fit.ship).name;
  if (!F.fit.id) F.fit.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const copy = JSON.parse(JSON.stringify({ ...F.fit, at: Date.now() }));
  const i = list.findIndex((x) => x.id === F.fit.id);
  if (i >= 0) list[i] = copy; else list.unshift(copy);
  app.store.setJSON(SAVE_KEY, list);
  app.store.setJSON(CURRENT_KEY, F.fit);
  dropDraft(F.fit.ship);   // 保存后这艘船就没有遗留的草稿了
  app.showToast('装配已保存在本机浏览器', 'success');
  renderFit();
}

function deleteFit() {
  if (!F.fit.id || !confirm(`删除已保存的装配「${F.fit.name || type(F.fit.ship).name}」？`)) return;
  app.store.setJSON(SAVE_KEY, savedFits().filter((x) => x.id !== F.fit.id));
  F.fit.id = null;
  app.showToast('已删除', 'success');
  renderFit();
}

// ---------- EFT 导入导出 ----------
const EFT_ORDER = ['low', 'mid', 'high', 'rig', 'sub'];

// 购物清单：舰船 + 各槽位装备（突变装备 = 原装备 + 突变质体）+ 每件武器 1 组弹药（按装填量）+ 无人机 + 植入体
function fitShoppingList(fit) {
  const out = new Map();
  const add = (id, n = 1) => { const t = type(id); if (id && t) out.set(id, { id, qty: (out.get(id)?.qty || 0) + n, name: t.name, en: t.en }); };
  add(fit.ship);
  for (const s of FE.SLOTS) for (const m of fit.slots[s] || []) {
    if (!m) continue;
    if (m.mut) { add(m.mut.base); add(m.mut.mutator); } else add(m.type);
    if (m.charge) add(m.charge, FE.chargeCount(type(m.type), type(m.charge)) || 1);
  }
  for (const d of fit.drones) add(d.type, d.count || 1);
  for (const id of fit.implants || []) add(id);
  return [...out.values()];
}

function toEft(fit) {
  const en = (id) => type(id)?.en || type(id)?.name || '';
  const lines = [`[${en(fit.ship)}, ${fit.name || en(fit.ship)}]`];
  const mw = MU.eftWriter(en);   // 突变装备：装备行写原装备名 [n]，文末附突变段（与 Pyfa 相同）
  for (const s of EFT_ORDER) {
    const list = fit.slots[s];
    if (!list.length && s === 'sub') continue;
    for (const m of list) {
      if (!m) { lines.push(`[Empty ${{ low: 'Low', mid: 'Med', high: 'High', rig: 'Rig', sub: 'Subsystem' }[s]} slot]`); continue; }
      lines.push(mw.name(m) + (m.charge ? ', ' + en(m.charge) : '') + (m.state === 'offline' ? ' /OFFLINE' : ''));
    }
    lines.push('');
  }
  if (fit.drones.length) { fit.drones.forEach((d) => lines.push(`${en(d.type)} x${d.count}`)); lines.push(''); }
  fit.implants.forEach((id) => lines.push(en(id)));
  const tail = mw.tail();
  return lines.join('\n').trim() + '\n' + (tail ? '\n' + tail + '\n' : '');
}

async function importText(text) {
  if (/^\s*\[\d+\]\s/m.test(text)) await MU.loadMuta().catch(() => {});   // 有突变段时先读突变质体数据
  const r = parseEft(text);
  if (r.error) { app.showToast(r.error, 'error'); return; }
  const { fit, unknown } = r;
  stashDraft(F.fit);
  F.fit = fit;
  F.selected = null;
  autoActivateDrones();
  recompute();
  closeModal();
  app.showToast(unknown.length ? `已导入，${unknown.length} 项无法识别：${unknown.slice(0, 3).join('、')}` : '已导入装配', unknown.length ? 'info' : 'success', 4000);
}

// EFT 文本 → { fit, unknown } 或 { error }
function parseEft(text) {
  const { lines, refs } = MU.eftReader(text.split(/\r?\n/).map((l) => l.trim()), findType);
  const head = lines.findIndex((l) => /^\[.+\]$/.test(l) && !/^\[empty/i.test(l));
  if (head < 0) return { error: '没有找到 [舰船, 名称] 开头的 EFT 文本' };
  const [shipName, ...rest] = lines[head].slice(1, -1).split(',');
  const ship = findType(shipName);
  if (!ship || ship.category !== FE.CAT.ship) return { error: '无法识别舰船：' + shipName.trim() };
  const fit = newFit(ship.id);
  fit.name = rest.join(',').trim();
  const unknown = [];
  for (const raw of lines.slice(head + 1)) {
    if (!raw || /^\[empty/i.test(raw)) continue;
    const offline = /\/offline$/i.test(raw);
    const line = raw.replace(/\s*\/offline$/i, '');
    const qty = /^(.*?)\s+x(\d+)$/i.exec(line);
    if (qty) {
      const t = findType(qty[1]);
      if (t?.category === FE.CAT.drone) fit.drones.push({ type: t.id, count: Number(qty[2]), active: 0 });
      else if (!t) unknown.push(qty[1]);
      continue;
    }
    const [rawName, chargeName] = line.split(',').map((x) => x.trim());
    const { name: modName, ref } = MU.splitRef(rawName);
    let t = findType(modName);
    if (!t) { unknown.push(modName); continue; }
    const mut = ref != null ? MU.mutFromRef(refs.get(ref), t.id) : null;
    if (mut) t = type(mut.type) || t;
    if (t.category === FE.CAT.implant) { fit.implants.push(t.id); continue; }
    if (!t.slot) continue;
    const ct = chargeName ? findType(chargeName) : null;
    fit.slots[t.slot].push({ type: t.id, state: offline ? 'offline' : defaultState(t), charge: ct?.id || null, ...(mut ? { mut: mut.mut } : {}) });
  }
  return { fit, unknown };
}

function findType(name) {
  return F.data.byName.get(String(name || '').trim().toLowerCase()) || null;
}

function openModal() {
  $('fitModal').hidden = false;
  $('fitImportText').value = '';
  setTimeout(() => $('fitImportText').focus(), 30);
}

function closeModal() {
  $('fitModal').hidden = true;
}

// ---------- 游戏内装配（ESI）----------
// 槽位标记：新版 ESI 为字符串（HiSlot0…），旧版为数字 flag，两种都识别；保存时写字符串
const ESI_SLOT = { high: ['HiSlot', 27], mid: ['MedSlot', 19], low: ['LoSlot', 11], rig: ['RigSlot', 92], sub: ['SubSystemSlot', 125] };
const ESI_SLOT_COUNT = { high: 8, mid: 8, low: 8, rig: 3, sub: 4 };
const ESI_NUM_FLAG = { 5: 'Cargo', 87: 'DroneBay', 158: 'FighterBay' };
const ESI_SCOPE_HINT = '当前授权没有装配权限，请在「ESI 绑定」中解绑后重新绑定';
const esiList = { charId: null, fits: null, loading: false, error: '' };

function parseFlag(flag) {
  if (typeof flag === 'number') {
    for (const [slot, [, start]] of Object.entries(ESI_SLOT)) {
      if (flag >= start && flag < start + ESI_SLOT_COUNT[slot]) return { slot, index: flag - start };
    }
    return { bay: ESI_NUM_FLAG[flag] || 'Other' };
  }
  const m = /^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystemSlot)(\d+)$/.exec(flag || '');
  if (m) return { slot: Object.keys(ESI_SLOT).find((k) => ESI_SLOT[k][0] === m[1]), index: Number(m[2]) };
  return { bay: flag || 'Other' };
}

function esiErrorText(error) {
  if (error.status === 401 || error.status === 403) return ESI_SCOPE_HINT;
  return error.esiError || error.message;
}

// ESI 装配 → 本工具的装配；弹药在游戏装配里放在货舱，按能否装填分配给装备
function fromEsiFit(f) {
  if (!F.data.types.has(f.ship_type_id)) return { error: '不支持的舰船' };
  const fit = newFit(f.ship_type_id);
  fit.name = f.name || '';
  const cargo = [];
  let skipped = 0;
  for (const it of f.items || []) {
    const t = type(it.type_id);
    if (!t) { skipped++; continue; }
    const where = parseFlag(it.flag);
    if (where.slot) {
      if (t.slot !== where.slot) { skipped++; continue; }
      fit.slots[where.slot][where.index] = { type: t.id, state: defaultState(t), charge: null };
    } else if (where.bay === 'DroneBay' && t.category === FE.CAT.drone) {
      const d = fit.drones.find((x) => x.type === t.id);
      if (d) d.count += it.quantity || 1; else fit.drones.push({ type: t.id, count: it.quantity || 1, active: 0 });
    } else if (where.bay === 'FighterBay' && t.category === FE.CAT.fighter) {
      // 游戏里按架数记，这里按满编中队计
      const n = Math.max(1, Math.ceil((it.quantity || 1) / (t.attrs.get(FE.AT.fighterSquadronSize) || 1)));
      const d = fit.drones.find((x) => x.type === t.id);
      if (d) d.count += n; else fit.drones.push({ type: t.id, count: n, active: 0 });
    } else if (where.bay === 'Cargo' && t.category === FE.CAT.charge) {
      cargo.push(t);
    } else if (where.bay !== 'Cargo') {
      skipped++;
    }
  }
  for (const s of FE.SLOTS) fit.slots[s] = Array.from(fit.slots[s], (m) => m || null);
  fit.slots.sub = fit.slots.sub.filter(Boolean);
  for (const s of FE.SLOTS) {
    for (const m of fit.slots[s]) {
      if (!m) continue;
      const c = cargo.find((ct) => FE.chargeFits(type(m.type), ct));
      if (c) m.charge = c.id;
    }
  }
  return { fit, skipped };
}

// ---------- 击杀邮件 → 装配 ----------
// 击杀详情「去装配页查看」：先记下，进入装配页时载入
// 返回 false 表示这艘船（如建筑、太空舱外的物体）不能装配，不跳转
let pendingKill = null;
export async function queueKillFit(km) {
  if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
  const data = await F.loading.catch((error) => { F.loading = null; throw error; });
  if (!data.types.has(km.victim.ship_type_id)) return false;
  pendingKill = km;
  return true;
}

// 其他页面（快递推荐用船）带来的 EFT 装配：同样先记下，进入装配页时载入
let pendingEft = null;
export function queueEftFit(text) {
  pendingEft = text;
}

// 模拟对打「在装配页打开」带来的装配
let pendingFit = null;
function loadPendingFit() {
  if (!pendingFit) return false;
  stashDraft(F.fit);
  F.fit = normalize(pendingFit);
  pendingFit = null;
  F.selected = null;
  autoActivateDrones();
  app.showToast('已在装配页打开，可点「保存」存到本机', 'success');
  return true;
}

function loadPending() {
  return loadPendingFit() || loadPendingKill() || loadPendingEft();
}

function loadPendingEft() {
  if (!pendingEft) return false;
  const r = parseEft(pendingEft);
  pendingEft = null;
  if (r.error) { app.showToast('无法载入装配：' + r.error, 'error', 4000); return false; }
  const { fit } = r;
  stashDraft(F.fit);
  F.fit = fit;
  F.selected = null;
  autoActivateDrones();
  history.replaceState(null, '', location.pathname + '#fit');
  app.showToast('已载入推荐装配「' + (fit.name || '') + '」，可点「保存」存到本机', 'success', 3500);
  return true;
}

function loadPendingKill() {
  if (!pendingKill) return false;
  const km = pendingKill;
  pendingKill = null;
  const r = fromKillmail(km);
  if (r.error) { app.showToast('无法载入这次击杀的装配：' + r.error, 'error', 4000); return false; }
  stashDraft(F.fit);
  F.fit = r.fit;
  F.selected = null;
  autoActivateDrones();
  history.replaceState(null, '', location.pathname + '#fit');
  app.showToast(r.skipped ? `已载入击杀装配，${r.skipped} 项暂不支持已忽略` : '已载入击杀装配，可点「保存」存到本机', r.skipped ? 'info' : 'success', 3500);
  return true;
}

// 击杀邮件的物品与游戏装配同用数字 flag；已装填的弹药与装备同一 flag，货舱物品不计入装配
const KILL_FIGHTER_TUBES = [159, 163];   // 已出击的舰载机
const KILL_IMPLANT_FLAG = 89;
function fromKillmail(km) {
  const v = km.victim;
  const items = [];
  const charges = [];
  const implants = [];
  for (const it of v.items || []) {
    const t = type(it.item_type_id);
    const qty = (it.quantity_dropped || 0) + (it.quantity_destroyed || 0) || 1;
    if (it.flag === KILL_IMPLANT_FLAG) { if (t) implants.push(t.id); continue; }
    const flag = it.flag >= KILL_FIGHTER_TUBES[0] && it.flag <= KILL_FIGHTER_TUBES[1] ? 158 : it.flag;
    const where = parseFlag(flag);
    if (where.slot && t?.category === FE.CAT.charge) { charges.push([where, t.id]); continue; }
    if (where.slot || where.bay === 'DroneBay' || where.bay === 'FighterBay') items.push({ type_id: it.item_type_id, flag, quantity: qty });
  }
  const r = fromEsiFit({ ship_type_id: v.ship_type_id, name: `击杀 #${km.killmail_id}`, items });
  if (r.error) return r;
  for (const [w, id] of charges) {
    const m = w.slot !== 'sub' && r.fit.slots[w.slot][w.index];
    if (m && FE.chargeFits(type(m.type), type(id))) m.charge = id;
  }
  r.fit.implants = implants;
  return r;
}

// 本工具的装配 → ESI 装配（POST 请求体）；每个装备按满弹药量在货舱放一份弹药
function toEsiFit(fit) {
  const items = [];
  const charges = new Map();
  for (const s of FE.SLOTS) {
    (s === 'sub' ? fit.slots.sub.filter(Boolean) : fit.slots[s]).forEach((m, i) => {
      if (!m) return;
      items.push({ type_id: m.type, flag: ESI_SLOT[s][0] + i, quantity: 1 });
      if (m.charge) charges.set(m.charge, (charges.get(m.charge) || 0) + FE.chargeCount(type(m.type), type(m.charge)));
    });
  }
  for (const d of fit.drones) {
    const t = type(d.type);
    if (t?.category === FE.CAT.fighter) items.push({ type_id: d.type, flag: 'FighterBay', quantity: d.count * (t.attrs.get(FE.AT.fighterSquadronSize) || 1) });
    else items.push({ type_id: d.type, flag: 'DroneBay', quantity: d.count });
  }
  for (const [id, qty] of charges) items.push({ type_id: id, flag: 'Cargo', quantity: qty });
  const name = (fit.name.trim() || type(fit.ship).name).slice(0, 50);
  return { name, description: '由 EVE Market 模拟装配保存', ship_type_id: fit.ship, items };
}

async function saveToGame(btn) {
  if (!F.fit) return;
  const body = toEsiFit(F.fit);
  if (!body.items.length) { app.showToast('装配是空的', 'error'); return; }
  btn.disabled = true;
  try {
    const token = await app.getEsiToken();
    await app.esiFetch(`/characters/${token.character_id}/fittings/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    esiList.fits = null;
    const note = F.fit.implants.length ? '（游戏装配不保存植入体）' : '';
    app.showToast(`已保存到 ${token.character_name || '角色'} 的游戏装配：${body.name}${note}`, 'success', 4000);
  } catch (error) {
    app.showToast('保存到游戏失败：' + esiErrorText(error), 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

async function openEsiModal() {
  $('fitEsiModal').hidden = false;
  $('fitEsiSearch').value = '';
  $('fitEsiShipOnly').checked = true;   // 每次打开默认只看当前选择的舰船
  await loadEsiFits();
}

function closeEsiModal() {
  $('fitEsiModal').hidden = true;
}

// 对战模拟用：已绑定角色的游戏装配（转换成本工具的装配；与「游戏装配」弹窗共用列表）
async function loadEsiFitList() {
  const token = await app.getEsiToken();
  if (!(esiList.fits && esiList.charId === token.character_id)) {
    try {
      const list = await app.esiFetch(`/characters/${token.character_id}/fittings/`);
      Object.assign(esiList, { charId: token.character_id, fits: list || [], error: '' });
    } catch (error) {
      throw new Error(esiErrorText(error));
    }
  }
  return esiList.fits.map((f) => { const r = fromEsiFit(f); return r.error ? null : { ...r.fit, esiId: f.fitting_id, name: f.name }; }).filter(Boolean);
}

async function loadEsiFits(force = false) {
  let token;
  try { token = await app.getEsiToken(); } catch (error) { esiList.error = error.message; renderEsiList(); return; }
  if (!force && esiList.fits && esiList.charId === token.character_id) { renderEsiList(); return; }
  Object.assign(esiList, { charId: token.character_id, fits: null, loading: true, error: '' });
  $('fitEsiTitle').textContent = `${token.character_name || '角色'} 的游戏装配`;
  renderEsiList();
  try {
    const list = await app.esiFetch(`/characters/${token.character_id}/fittings/`);
    esiList.fits = (list || []).sort((a, b) => (type(a.ship_type_id)?.name || '').localeCompare(type(b.ship_type_id)?.name || '', 'zh') || a.name.localeCompare(b.name, 'zh'));
  } catch (error) {
    esiList.error = esiErrorText(error);
  }
  esiList.loading = false;
  renderEsiList();
}

function renderEsiList() {
  const box = $('fitEsiBody');
  if (esiList.loading) { box.innerHTML = skRows(6, { img: 32 }); return; }
  if (esiList.error) { box.innerHTML = `<p class="fit-esi-empty">${app.esc(esiList.error)}</p>`; return; }
  if (!esiList.fits) { box.innerHTML = ''; return; }
  const q = $('fitEsiSearch').value.trim().toLowerCase();
  // 选了舰船时默认只列这艘船的装配；没选舰船时列全部，不显示开关
  const ship = F.fit?.ship;
  $('fitEsiShipOnlyLabel').hidden = !ship;
  const shipOnly = ship && $('fitEsiShipOnly').checked;
  const list = esiList.fits.filter((f) => !shipOnly || f.ship_type_id === ship).filter((f) => !q || f.name.toLowerCase().includes(q) || (type(f.ship_type_id)?.name || '').toLowerCase().includes(q) || (type(f.ship_type_id)?.en || '').toLowerCase().includes(q));
  $('fitEsiCount').textContent = `${esiList.fits.length} / 500`;
  if (!list.length) {
    const text = !esiList.fits.length ? '游戏里还没有保存的个人装配'
      : shipOnly && !q ? `游戏里没有保存${type(ship)?.name || '这艘船'}的个人装配，可取消「只看当前舰船」查看全部`
        : '没有匹配的装配';
    box.innerHTML = `<p class="fit-esi-empty">${app.esc(text)}</p>`;
    return;
  }
  box.innerHTML = list.map((f) => {
    const ship = type(f.ship_type_id);
    const mods = (f.items || []).filter((it) => parseFlag(it.flag).slot).length;
    return `<div class="fit-esi-row">
      <img src="${IMG(f.ship_type_id, 'icon', 32)}" alt="" width="32" height="32" loading="lazy">
      <div class="fit-esi-main"><b>${app.esc(f.name)}</b><span>${app.esc(ship?.name || '未知舰船 ' + f.ship_type_id)} · ${mods} 个装备</span></div>
      <button class="btn btn-ghost" data-esi-open="${f.fitting_id}"${ship ? '' : ' disabled'}>打开</button>
      <button class="btn btn-ghost danger" data-esi-delete="${f.fitting_id}" title="从游戏中删除这个装配">删除</button>
    </div>`;
  }).join('');
}

async function onEsiModalClick(e) {
  const el = (sel) => e.target.closest(sel);
  let x;
  if (el('.modal-backdrop, [data-fit-esi-close]')) { closeEsiModal(); return; }
  if (el('[data-fit-esi-refresh]')) { loadEsiFits(true); return; }
  if ((x = el('[data-esi-open]'))) {
    const f = esiList.fits.find((it) => it.fitting_id === Number(x.dataset.esiOpen));
    const r = f && fromEsiFit(f);
    if (!r || r.error) { app.showToast(r?.error || '装配不存在', 'error'); return; }
    stashDraft(F.fit);
    F.fit = r.fit;
    F.selected = null;
    autoActivateDrones();
    recompute();
    closeEsiModal();
    app.showToast(r.skipped ? `已打开，${r.skipped} 项暂不支持已忽略` : '已打开游戏装配，可点「保存」存到本机', r.skipped ? 'info' : 'success', 3500);
    return;
  }
  if ((x = el('[data-esi-delete]'))) {
    const id = Number(x.dataset.esiDelete);
    const f = esiList.fits.find((it) => it.fitting_id === id);
    if (!f || !confirm(`从游戏中删除装配「${f.name}」？此操作无法撤销。`)) return;
    x.disabled = true;
    try {
      const token = await app.getEsiToken();
      await app.esiFetch(`/characters/${token.character_id}/fittings/${id}/`, { method: 'DELETE' });
      esiList.fits = esiList.fits.filter((it) => it.fitting_id !== id);
      renderEsiList();
      app.showToast('已从游戏中删除', 'success');
    } catch (error) {
      x.disabled = false;
      app.showToast('删除失败：' + esiErrorText(error), 'error', 5000);
    }
  }
}

// ---------- 分享链接 ----------
// #fit=<base64url(JSON)>：舰船、各槽位 [装备, 弹药, 状态]、无人机、植入体
const STATE_CODE = { offline: 0, online: 1, active: 2, overload: 3 };
const CODE_STATE = ['offline', 'online', 'active', 'overload'];

function shareUrl() {
  const f = F.fit;
  const compact = {
    s: f.ship, n: f.name || undefined,
    m: Object.fromEntries(FE.SLOTS.filter((s) => f.slots[s].length).map((s) => [s, f.slots[s].map((m) => (m ? [m.type, m.charge || 0, STATE_CODE[m.state], ...(m.mut ? [[m.mut.base, m.mut.mutator, m.mut.attrs]] : [])] : 0))])),
    d: f.drones.length ? f.drones.map((d) => [d.type, d.count, d.active]) : undefined,
    i: f.implants.length ? f.implants : undefined
  };
  const json = new TextEncoder().encode(JSON.stringify(compact));
  let bin = '';
  json.forEach((b) => { bin += String.fromCharCode(b); });
  return location.origin + location.pathname + '#fit=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadFromHash() {
  const m = /^#fit=([\w-]+)/.exec(location.hash);
  if (!m) return false;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    const fit = newFit(c.s);
    fit.name = c.n || '';
    for (const s of FE.SLOTS) fit.slots[s] = (c.m?.[s] || []).map((x) => (x ? { type: x[0], charge: x[1] || null, state: CODE_STATE[x[2]] || 'online', ...(x[3] ? { mut: { base: x[3][0], mutator: x[3][1], attrs: x[3][2] } } : {}) } : null));
    fit.drones = (c.d || []).map(([t, count, active]) => ({ type: t, count, active }));
    fit.implants = c.i || [];
    stashDraft(F.fit);
    F.fit = normalize(fit);
    history.replaceState(null, '', location.pathname + '#fit');
    app.showToast('已打开分享的装配', 'success');
    return true;
  } catch {
    app.showToast('分享链接无效', 'error');
    return false;
  }
}
