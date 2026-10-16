// ===== 模拟装配 =====
// 左侧浏览舰船 / 装备 / 弹药 / 无人机 / 植入体（按市场分组或搜索），中间是舰船槽位，右侧为属性统计。
// 技能可选「全部 5 级」或「已绑定角色的技能」；装配保存在本机，支持 EFT 文本导入导出与分享链接。
import * as FE from './fit-engine.js?v=v1r1';
import { skCards, skRows, skTitle } from './skeleton.js?v=v16r7';

let app;
const $ = (id) => document.getElementById(id);
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const DATA_URL = './fit-data.json?v=v1r1';
const SAVE_KEY = 'eve-fits-v1';
const CURRENT_KEY = 'eve-fit-current';
const SETTINGS_KEY = 'eve-fit-settings';

const TABS = [
  ['ship', '舰船', [FE.CAT.ship]],
  ['module', '装备', [FE.CAT.module, FE.CAT.subsystem]],
  ['charge', '弹药', [FE.CAT.charge]],
  ['drone', '无人机', [FE.CAT.drone]],
  ['implant', '植入体', [FE.CAT.implant]]
];
const META = { 2: ['T2', 't2'], 3: ['故事线', 'story'], 4: ['势力', 'faction'], 5: ['官员', 'officer'], 6: ['死亡空间', 'deadspace'], 14: ['T3', 't3'], 15: ['深渊', 'abyssal'] };
const STATE_NAME = { offline: '离线', online: '在线', active: '激活', overload: '超载' };
const IMPLANT_SLOT = 331, BOOSTER_SLOT = 1087;

const F = {
  data: null, loading: null,
  fit: null, calc: null, stats: null,
  tab: 'ship', query: '', open: new Set(), slotFilter: null, onlyFits: true,
  selected: null,                 // { slot, index }：选中的装备（装填弹药用）
  skillMode: 'max', esi: null,
  prices: null
};

// ---------- 入口 ----------
export function initFitting(context) {
  app = context;
  try { Object.assign(F, pick(app.store.getJSON(SETTINGS_KEY, {}), ['skillMode', 'onlyFits', 'tab'])); } catch { /* 默认设置 */ }
  if (F.skillMode === 'esi' && !app.hasEsiToken()) F.skillMode = 'max';
  bindSidebar();
  $('fitMain').addEventListener('click', onMainClick);
  $('fitMain').addEventListener('change', onMainChange);
  $('fitMain').addEventListener('input', onMainInput);
  $('fitModal').addEventListener('click', (e) => {
    if (e.target.closest('.modal-backdrop, [data-fit-modal-close]')) closeModal();
    if (e.target.closest('[data-fit-import-go]')) importText($('fitImportText').value);
  });
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function saveSettings() {
  app.store.setJSON(SETTINGS_KEY, { skillMode: F.skillMode, onlyFits: F.onlyFits, tab: F.tab });
}

// 空闲时预加载装配数据
export async function preloadFitting() {
  if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
  await F.loading.catch((error) => { F.loading = null; throw error; });
}

export async function showFitting() {
  if (!F.data) {
    $('fitMain').innerHTML = skTitle(20) + '<div class="fit-layout"><div>' + skRows(8) + '</div><div>' + skCards(4, 'fit-sk-cards') + '</div></div>';
    $('fitBrowser').innerHTML = skRows(12, { img: 24 });
    try {
      if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
      F.data = await F.loading;
    } catch (error) {
      F.loading = null;
      $('fitMain').innerHTML = '<p class="text-muted kb-empty">装配数据加载失败：' + app.esc(error.message) + '</p>';
      return;
    }
    app.getMarketPriceMap().then((m) => { F.prices = m; if (F.fit) renderStats(); }).catch(() => {});
    if (!loadFromHash()) {
      const saved = app.store.getJSON(CURRENT_KEY, null);
      F.fit = saved && F.data.types.has(saved.ship) ? normalize(saved) : null;
    }
    if (F.skillMode === 'esi') await loadEsiSkills();
    renderBrowserTabs();
    renderBrowser();
    recompute();
    return;
  }
  if (loadFromHash()) { recompute(); renderBrowser(); }
  syncSkillMode();
}

// 绑定 / 解绑 ESI 后刷新技能来源
function syncSkillMode() {
  if (F.skillMode === 'esi' && !app.hasEsiToken()) { F.skillMode = 'max'; F.esi = null; recompute(); }
  else if (F.fit) renderFit();
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
  for (const s of FE.SLOTS) fit.slots[s] = (f.slots?.[s] || []).map((m) => (m && F.data.types.has(m.type) ? { type: m.type, state: m.state || 'online', charge: F.data.types.has(m.charge) ? m.charge : null } : null));
  fit.drones = (f.drones || []).filter((d) => F.data.types.has(d.type)).map((d) => ({ type: d.type, count: d.count || 1, active: d.active || 0 }));
  fit.implants = (f.implants || []).filter((id) => F.data.types.has(id));
  return fit;
}

function type(id) { return F.data.types.get(id); }

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
  if (F.tab === 'drone' && F.onlyFits && F.stats && !F.stats.resources.droneBay.total) return false;
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
  const meta = META[t.meta];
  const fitInfo = t.category === FE.CAT.module ? [t.attrs.get(FE.AT.cpu) ? `${fmt(t.attrs.get(FE.AT.cpu))} tf` : '', t.attrs.get(FE.AT.power) ? `${fmt(t.attrs.get(FE.AT.power))} MW` : '', t.attrs.get(FE.AT.upgradeCost) ? `校准 ${t.attrs.get(FE.AT.upgradeCost)}` : ''].filter(Boolean).join(' · ') : '';
  return `<button class="fit-item" data-fit-type="${t.id}" title="${app.esc(t.name + (t.en ? '\n' + t.en : ''))}">
    <img src="${IMG(t.id)}" alt="" width="24" height="24" loading="lazy">
    <span class="fit-item-name">${app.esc(t.name)}${fitInfo ? `<small>${fitInfo}</small>` : ''}</span>
    ${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}
  </button>`;
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
  else if (t.category === FE.CAT.implant) addImplant(t);
  if (MOBILE()) app.closeDrawer?.();
}

const MOBILE = () => window.matchMedia('(max-width: 768px)').matches;

function setShip(id) {
  const old = F.fit;
  const fit = newFit(id);
  if (old) {
    fit.name = old.name;
    // 换船时保留仍能装配的装备、无人机与植入体
    const shipType = type(id);
    let dropped = 0;
    for (const s of FE.SLOTS) {
      for (const m of old.slots[s]) {
        if (!m) continue;
        if (s === 'sub' || FE.cannotFit(F.data, shipType, type(m.type))) { dropped++; continue; }
        fit.slots[s].push(m);
      }
    }
    fit.drones = old.drones;
    fit.implants = old.implants;
    const kept = FE.SLOTS.reduce((n, s) => n + fit.slots[s].length, 0);
    if (kept || dropped) app.showToast(`已更换为 ${shipType.name}` + (kept ? `，保留 ${kept} 件装备` : '') + (dropped ? `，移除 ${dropped} 件不能装配的` : ''), 'info', 3000);
  }
  F.fit = fit;
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

// 在带宽与同时操作上限内尽量激活
function autoActivateDrones() {
  const calc = FE.computeFit(F.data, F.fit, skills());
  const limit = calc.char.attr(FE.AT.maxActiveDrones);
  let bw = calc.ship.attr(FE.AT.droneBandwidth);
  let n = 0;
  for (const d of F.fit.drones) {
    const per = type(d.type).attrs.get(FE.AT.droneBandwidthUsed) || 0;
    d.active = 0;
    while (d.active < d.count && n < limit && (per === 0 || bw >= per - 1e-6)) { d.active++; n++; bw -= per; }
  }
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
      <p>也可以 <button class="link-btn" data-fit-import>导入 EFT 文本</button>${savedFits().length ? ` 或打开 <select class="plain-select" data-fit-open><option value="">我的装配…</option>${savedFits().map((f) => `<option value="${f.id}">${app.esc(f.name || type(f.ship)?.name || '未命名')}</option>`).join('')}</select>` : ''}</p>
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
        <h2>${app.esc(shipType.name)}</h2>
        <input class="fit-name" id="fitName" value="${app.esc(F.fit.name)}" placeholder="装配名称" maxlength="60" aria-label="装配名称">
      </div>
      <div class="fit-actions">
        <button class="btn btn-primary" data-fit-save>${F.fit.id ? '保存' : '保存装配'}</button>
        <select class="plain-select" data-fit-open aria-label="我的装配"><option value="">我的装配${saved.length ? `（${saved.length}）` : ''}</option>${saved.map((f) => `<option value="${f.id}"${f.id === F.fit.id ? ' selected' : ''}>${app.esc(f.name || type(f.ship)?.name || '未命名')} · ${app.esc(type(f.ship)?.name || '')}</option>`).join('')}</select>
        <div class="fit-action-row">
          <button class="btn btn-ghost" data-fit-new title="新建空装配">新建</button>
          <button class="btn btn-ghost" data-fit-import title="粘贴 EFT 格式文本">导入</button>
          <button class="btn btn-ghost" data-fit-export title="复制为 EFT 格式（可导入游戏或 Pyfa）">导出</button>
          <button class="btn btn-ghost" data-fit-share title="复制分享链接">分享</button>
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
  const states = ['offline', 'online', ...(t.activatable ? ['active'] : []), ...(t.overloadable ? ['overload'] : [])];
  const needsCharge = FE.AT.chargeGroups.some((a) => t.attrs.get(a));
  return `<div class="fit-slot${sel ? ' is-selected' : ''}${err || extra ? ' is-error' : ''} is-${m.state}" data-fit-mod="${slot}:${index}">
    ${fixed ? '<span class="fit-state-btn is-static"></span>' : `<button class="fit-state-btn is-${m.state}" data-fit-state="${slot}:${index}" title="${STATE_NAME[m.state]}（点击切换：${states.map((s) => STATE_NAME[s]).join(' → ')}）" aria-label="切换状态"><i></i></button>`}
    <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
    <span class="fit-slot-name">${app.esc(t.name)}${item && moduleNote(item) ? `<small>${moduleNote(item)}</small>` : ''}</span>
    ${ct ? `<span class="fit-charge" title="${app.esc(ct.name)} × ${FE.chargeCount(t, ct)}"><img src="${IMG(ct.id)}" alt="" width="20" height="20" loading="lazy">${app.esc(shortName(ct.name))}<button data-fit-uncharge="${slot}:${index}" aria-label="卸下弹药">×</button></span>`
      : needsCharge ? `<button class="fit-charge is-empty" data-fit-pick-charge="${slot}:${index}">装填弹药</button>` : ''}
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

function dronesHtml() {
  const res = F.stats.resources;
  if (!res.droneBay.total && !F.fit.drones.length) return '';
  const rows = F.fit.drones.map((d, i) => {
    const t = type(d.type);
    return `<div class="fit-slot fit-drone">
      <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
      <span class="fit-slot-name">${app.esc(t.name)}<small>激活 ${d.active} / ${d.count}</small></span>
      <span class="fit-stepper" title="数量"><button data-fit-drone="${i}:count:-1" aria-label="减少">−</button><b>${d.count}</b><button data-fit-drone="${i}:count:1" aria-label="增加">+</button></span>
      <span class="fit-stepper is-active" title="激活数量"><button data-fit-drone="${i}:active:-1" aria-label="少激活一架">−</button><b>${d.active}</b><button data-fit-drone="${i}:active:1" aria-label="多激活一架">+</button></span>
      <button class="fit-remove" data-fit-drone-remove="${i}" title="移除" aria-label="移除">×</button>
    </div>`;
  }).join('');
  return `<section class="fit-slots"><h4>无人机<span>挂舱 ${fmt(res.droneBay.used)} / ${fmt(res.droneBay.total)} m³ · 带宽 ${fmt(res.bandwidth.used)} / ${fmt(res.bandwidth.total)}</span></h4>
    ${rows || '<div class="fit-slot is-empty" data-fit-empty-drone><span class="fit-slot-icon"></span><span>从左侧「无人机」中添加</span></div>'}</section>`;
}

function implantsHtml(bound) {
  const rows = F.fit.implants.map((id) => {
    const t = type(id);
    const slot = t.attrs.get(IMPLANT_SLOT);
    return `<div class="fit-slot"><img src="${IMG(id)}" alt="" width="28" height="28" loading="lazy"><span class="fit-slot-name">${app.esc(t.name)}<small>${slot ? '植入体槽位 ' + slot : '增效剂'}</small></span><button class="fit-remove" data-fit-implant-remove="${id}" aria-label="移除">×</button></div>`;
  }).join('');
  return `<section class="fit-slots"><h4>植入体 / 增效剂<span>${bound ? '<button class="link-btn" data-fit-my-implants>导入当前角色的植入体</button>' : ''}</span></h4>
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
  const price = fitPrice();
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
      ${price ? `<div class="fit-kv"><span>估价（全服均价）</span><b>${app.formatISK(price)} ISK</b></div>` : ''}
    </section>`;
}

function duration(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + ' 小时 ' + Math.round(sec % 3600 / 60) + ' 分';
  if (sec >= 60) return Math.floor(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒';
  return sec.toFixed(1) + ' 秒';
}

function fitPrice() {
  if (!F.prices?.size || !F.fit) return 0;
  const p = (id) => F.prices.get(id) || 0;
  let total = p(F.fit.ship);
  for (const { m } of fittedModules()) {
    total += p(m.type);
    if (m.charge) total += p(m.charge) * FE.chargeCount(type(m.type), type(m.charge));
  }
  for (const d of F.fit.drones) total += p(d.type) * d.count;
  for (const id of F.fit.implants) total += p(id);
  return total;
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
    const states = ['offline', 'online', ...(t.activatable ? ['active'] : []), ...(t.overloadable ? ['overload'] : [])];
    m.state = states[(states.indexOf(m.state) + 1) % states.length];
    recompute();
    return;
  }
  if ((x = el('[data-fit-remove]'))) {
    const { slot, index } = parseRef(x.dataset.fitRemove);
    F.fit.slots[slot][index] = null;
    if (slot === 'sub') F.fit.slots.sub = F.fit.slots.sub.filter(Boolean);
    F.selected = null;
    recompute();
    trimSlots();
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
      const bay = F.stats.resources.droneBay, vol = type(d.type).attrs.get(FE.AT.volume) || 0;
      if (bay.used + vol > bay.total + 1e-6) { d.count -= 1; app.showToast('无人机挂舱容量不足', 'error'); return; }
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
  if (el('[data-fit-new]')) { F.fit = null; F.selected = null; app.store.setJSON(CURRENT_KEY, null); recompute(); setTab('ship'); return; }
  if (el('[data-fit-delete]')) { deleteFit(); return; }
  if (el('[data-fit-import]')) { openModal(); return; }
  if (el('[data-fit-export]')) { app.copyText(toEft(F.fit), '已复制 EFT 文本，可在游戏装配窗口或 Pyfa 中导入'); return; }
  if (el('[data-fit-share]')) { app.copyText(shareUrl(), '分享链接已复制'); return; }
}

function onMainChange(e) {
  const open = e.target.closest('[data-fit-open]');
  if (open && open.value) {
    const f = savedFits().find((x) => x.id === open.value);
    if (f) { F.fit = normalize(f); F.selected = null; recompute(); }
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

function toEft(fit) {
  const en = (id) => type(id)?.en || type(id)?.name || '';
  const lines = [`[${en(fit.ship)}, ${fit.name || en(fit.ship)}]`];
  for (const s of EFT_ORDER) {
    const list = fit.slots[s];
    if (!list.length && s === 'sub') continue;
    for (const m of list) {
      if (!m) { lines.push(`[Empty ${{ low: 'Low', mid: 'Med', high: 'High', rig: 'Rig', sub: 'Subsystem' }[s]} slot]`); continue; }
      lines.push(en(m.type) + (m.charge ? ', ' + en(m.charge) : '') + (m.state === 'offline' ? ' /OFFLINE' : ''));
    }
    lines.push('');
  }
  if (fit.drones.length) { fit.drones.forEach((d) => lines.push(`${en(d.type)} x${d.count}`)); lines.push(''); }
  fit.implants.forEach((id) => lines.push(en(id)));
  return lines.join('\n').trim() + '\n';
}

function importText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const head = lines.findIndex((l) => /^\[.+\]$/.test(l) && !/^\[empty/i.test(l));
  if (head < 0) { app.showToast('没有找到 [舰船, 名称] 开头的 EFT 文本', 'error'); return; }
  const [shipName, ...rest] = lines[head].slice(1, -1).split(',');
  const ship = findType(shipName);
  if (!ship || ship.category !== FE.CAT.ship) { app.showToast('无法识别舰船：' + shipName.trim(), 'error'); return; }
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
    const [modName, chargeName] = line.split(',').map((x) => x.trim());
    const t = findType(modName);
    if (!t) { unknown.push(modName); continue; }
    if (t.category === FE.CAT.implant) { fit.implants.push(t.id); continue; }
    if (!t.slot) continue;
    const ct = chargeName ? findType(chargeName) : null;
    fit.slots[t.slot].push({ type: t.id, state: offline ? 'offline' : defaultState(t), charge: ct?.id || null });
  }
  F.fit = fit;
  F.selected = null;
  autoActivateDrones();
  recompute();
  closeModal();
  app.showToast(unknown.length ? `已导入，${unknown.length} 项无法识别：${unknown.slice(0, 3).join('、')}` : '已导入装配', unknown.length ? 'info' : 'success', 4000);
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

// ---------- 分享链接 ----------
// #fit=<base64url(JSON)>：舰船、各槽位 [装备, 弹药, 状态]、无人机、植入体
const STATE_CODE = { offline: 0, online: 1, active: 2, overload: 3 };
const CODE_STATE = ['offline', 'online', 'active', 'overload'];

function shareUrl() {
  const f = F.fit;
  const compact = {
    s: f.ship, n: f.name || undefined,
    m: Object.fromEntries(FE.SLOTS.filter((s) => f.slots[s].length).map((s) => [s, f.slots[s].map((m) => (m ? [m.type, m.charge || 0, STATE_CODE[m.state]] : 0))])),
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
    for (const s of FE.SLOTS) fit.slots[s] = (c.m?.[s] || []).map((x) => (x ? { type: x[0], charge: x[1] || null, state: CODE_STATE[x[2]] || 'online' } : null));
    fit.drones = (c.d || []).map(([t, count, active]) => ({ type: t, count, active }));
    fit.implants = c.i || [];
    F.fit = normalize(fit);
    history.replaceState(null, '', location.pathname + '#fit');
    app.showToast('已打开分享的装配', 'success');
    return true;
  } catch {
    app.showToast('分享链接无效', 'error');
    return false;
  }
}
