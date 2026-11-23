// ===== 模拟装配 =====
// 左侧浏览舰船 / 装备 / 弹药 / 无人机 / 植入体（按市场分组或搜索），中间是舰船槽位，右侧为属性统计。
// 技能可选「全部 5 级」或「已绑定角色的技能」；装配保存在本机，支持 EFT 文本导入导出与分享链接，
// 绑定 ESI 后可读取 / 保存游戏内的装配（esi-fittings.read_fittings.v1 / write_fittings.v1）。
// 智能装配（fit-auto.js）按目标与约束自动搜索装配；击杀记录装配（fit-kb.js）列出这艘船最近阵亡时的常见装配。
import * as FE from './fit-engine.js?v=v49';
import * as MU from './fit-mutate.js?v=v4';
import { initAutoFit, openAutoFit, openImplantAdvisor, counterFit, cancelCounterFit, aiAutoFit } from './fit-auto.js?v=v33';
import { initKbFits, openKbFits, openPlazaFits, commonFit } from './fit-kb.js?v=v30';
import { initSim, mountSim, pilotRow, pilotShipSearch, fitBody as simFitBody } from './fit-sim.js?v=v151';
import { initPlan, mountPlan, queuePlan, planQueue } from './skill-plan.js?v=v13';
import { initGraph, openGraph } from './fit-graph.js?v=v5';
import { skCards, skRows, skTitle, skPilot } from './skeleton.js?v=v18';
import { makeFloat, pinBtn, closeBtn } from './float-pop.js?v=3';
import { SERVER } from './server.js?v=s4';
import { serverExtra } from './server-extra.js?v=3';

let app;
const $ = (id) => document.getElementById(id);
const INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
const infoBtn = (id, tag = 'button') => tag === 'button'
  ? `<button type="button" class="fit-info-btn" data-fit-info="${id}" title="查看详情" aria-label="查看详情">${INFO_ICON}</button>`
  : `<span class="fit-info-btn" data-fit-info="${id}" role="button" title="查看详情" aria-label="查看详情">${INFO_ICON}</span>`;
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const DATA_URL = './fit-data.json?v=v22';
const SAVE_KEY = 'eve-fits-v1';
const CURRENT_KEY = 'eve-fit-current';
const SETTINGS_KEY = 'eve-fit-settings';
const CLOUD_KEY = 'eve-fit-cloud-' + SERVER.id;   // 曙光云计算：放进「云」的舰船
const CLOUD_BW = 100;
const ENV_KEY = 'eve-fit-env';   // 选中的天象（虫洞、风暴、泰坦天象发生器等）
const FLEET_KEY = 'eve-fit-fleet';   // 舰队里别人给的指挥脉冲波加成 [[弹药, 强度]]
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
  tab: 'ship', query: '', queries: {}, open: new Set(), slotFilter: null, onlyFits: true,
  selected: null,                 // { slot, index }：选中的装备（装填弹药用）
  chargeFor: new Set(), chargeShut: new Set(),   // 弹药页：只看勾选的这几种装备（类型 ID）能用的弹药（一个不选 = 全部），分组默认全展开（chargeShut = 手动收起的分组）
  infoSrc: null,                  // 详情弹窗是从装配里哪一项点开的（衍生替换用）
  skillMode: 'max', esi: null,
  prices: null,
  fitSrc: new Set(),              // 舰船页顶上的装配来源筛选（多选）：saved 我的装配 / esi 游戏装配 / plaza 广场；一个不选 = 全部舰船
  shipOpen: new Set()             // 舰船页展开了装配列表的舰船
};

// ---------- 入口 ----------
export function initFitting(context) {
  app = context;
  try { Object.assign(F, pick(app.store.getJSON(SETTINGS_KEY, {}), ['skillMode', 'onlyFits', 'tab'])); } catch { /* 默认设置 */ }
  try { const src = app.store.getJSON(SETTINGS_KEY, {}).fitSrc; if (Array.isArray(src)) F.fitSrc = new Set(src.filter((k) => FIT_SRC[k])); } catch { /* 默认不筛选 */ }
  if (F.skillMode === 'esi' && !app.hasEsiToken()) F.skillMode = 'max';
  try { FE.setCloud(app.store.getJSON(CLOUD_KEY, [])); } catch { /* 空云 */ }
  try { FE.setEnv(app.store.getJSON(ENV_KEY, [])); } catch { /* 没有天象 */ }
  try { FE.setFleet(app.store.getJSON(FLEET_KEY, [])); } catch { /* 没有舰队加成 */ }
  bindSidebar();
  initTypeInfo();
  initDrag();
  initModTip();
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
    fromCompact,
    sharePlaza: () => app.openPlazaFit?.(),
    hasEsi: () => app.hasEsiToken(),
    // 智能装配 / 智能植入体弹窗里选「按角色」：直接读取当前角色技能（装配页的技能模式不变）
    loadEsiLevels: async () => { if (!F.esi) F.esi = await app.getCharacterSkills(); return F.esi?.levels || null; },
    prices: () => F.prices,
    esc: app.esc, formatNumber: app.formatNumber, formatISK: app.formatISK, showToast: app.showToast, store: app.store
  };
  MU.initMutate(app, { data: () => F.data });
  initAutoFit(planCtx);
  initKbFits(planCtx);
  // 技能规划页（skill-plan.js）
  const planPageCtx = {
    get data() { return F.data; }, FE,
    getFit: () => F.fit, savedFits, normalize,
    hasEsi: () => app.hasEsiToken(),
    esiFetch: app.esiFetch, getEsiToken: app.getEsiToken, getImplants: app.getCharacterImplants, openEsiBind: app.openEsiBind,
    esc: app.esc, formatNumber: app.formatNumber, showToast: app.showToast, copyText: app.copyText, store: app.store
  };
  const toolCtx = {
    get data() { return F.data; }, FE,
    getFit: () => F.fit, getStats: () => F.stats, savedFits, parseEft, normalize, skills,
    hasEsi: () => app.hasEsiToken(),
    esiFits: loadEsiFitList,
    prices: () => app.getMarketPriceMap(),        // 全服均价（战场模拟的 ISK 交换比）
    esiSkills: () => app.getCharacterSkills(),    // 已绑定角色的技能（战场模拟某一方按角色技能）
    // 在装配页打开（战场模拟的装配详情）：先记下，切到装配页时载入
    openInFitting: (fit) => { pendingFit = fit; app.openFit(); },
    openBattles: () => app.openBattles(),   // 战场模拟「从真实会战导入」：去近 30 天会战列表选一场
    // 针对对方阵容的智能装配（战场模拟的装配详情）
    counterFit, cancelCounterFit,
    esc: app.esc, formatNumber: app.formatNumber, formatISK: app.formatISK, showToast: app.showToast, store: app.store
  };
  toolInit = () => { initSim(toolCtx); initGraph(toolCtx); initPlan(planPageCtx); toolInit = null; };
  $('fitEsiModal').addEventListener('input', (e) => { if (e.target.id === 'fitEsiSearch') renderEsiList(); });
  $('fitEsiShipOnly').addEventListener('change', renderEsiList);
  $('fitStats').addEventListener('change', (e) => { if (e.target.matches('[data-val-src]')) { app.valuation.set(e.target.value); renderStats(); renderBrowser(); } });
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function saveSettings() {
  app.store.setJSON(SETTINGS_KEY, { skillMode: F.skillMode, onlyFits: F.onlyFits, tab: F.tab, fitSrc: [...F.fitSrc] });
}

let toolInit = null;   // 装配数据到了再初始化战场模拟 / 伤害图表（它们需要读取本机装配）
function openTool(open, arg) {
  toolInit?.();
  open(arg);
}

// 战场模拟页（独立菜单，与装配页共用装配数据）；战场统计「战场模拟」先 queueSim 带入双方舰船
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
  // 突变质体数据：没有突变属性的深渊装备要靠它按原装备计算（击杀记录装配里常见）
  await MU.loadMuta().catch(() => {});
  const preset = pendingSim;
  pendingSim = null;
  mountSim(root, preset, restored && !preset);
}

// 驾驶模拟页（独立菜单）：开一艘船打 NPC，用战场模拟的引擎、3D 画面和装配计算
let pilotMod = null;
export async function showPilot(root) {
  if (!F.data && !root.dataset.ready && !root.children.length) { const t = app.store.getJSON('eve-pilot', null)?.tab; root.innerHTML = skPilot(['match', 'tut'].includes(t) ? t : 'solo'); }
  try {
    await ensureData();
  } catch (error) {
    root.innerHTML = '<p class="text-muted kb-empty">装配数据加载失败：' + app.esc(error.message) + '</p>';
    return;
  }
  toolInit?.();
  await MU.loadMuta().catch(() => {});
  if (!pilotMod) {
    pilotMod = await import('./pilot.js?v=v174');
    pilotMod.initPilot({ get data() { return F.data; }, FE, shipSearch: pilotShipSearch, savedFits, normalize,
      // 无人机一架都没激活时按带宽激活（不改原装配）
      pilotRow: (ship, fit, label, o) => pilotRow(ship, fit, label, (f) => { if (f?.drones?.length && !f.drones.some((d) => d.active)) autoActivateDrones(f); }, o),
      hasEsi: () => app.hasEsiToken(), esiFits: loadEsiFitList, getFit: () => F.fit,
      getImplants: () => app.getCharacterImplants(),   // 驾驶模拟：导入当前角色的植入体（ESI）
      prices: () => app.getMarketPriceMap(),   // 全服均价（货柜舱 / 残骸窗口的预估价格，客户端 GetAveragePrice）
      // 匹配对战：ESI 令牌（服务器用它核实角色、读真实技能）
      getEsiToken: () => app.getEsiToken(),
      // 「查看装配」：和战场模拟装配详情同一套内容；「在装配页打开」同战场模拟
      fitHtml: simFitBody, openInFitting: (fit) => { pendingFit = fit; app.openFit(); },
      esc: app.esc, formatNumber: app.formatNumber, showToast: app.showToast, store: app.store });
  }
  pilotMod.mountPilot(root);
}

// 技能规划（个人中心 · 技能页里的子页，用装配数据里的技能前置关系）
// opt.queue：把训练队列加为目标（技能页训练队列的「规划队列」）
export async function showPlan(root, restored = false, opt = null) {
  if (!F.data && !root.dataset.ready) root.innerHTML = skTitle(16) + skCards(4) + skRows(6);
  try {
    await ensureData();
  } catch (error) {
    root.innerHTML = '<p class="text-muted kb-empty">装配数据加载失败：' + app.esc(error.message) + '</p>';
    return;
  }
  toolInit?.();
  if (opt?.queue) planQueue();
  mountPlan(root, restored);
}

async function ensureData() {
  if (F.data) return F.data;
  if (!F.loading) F.loading = FE.loadFitData(DATA_URL);
  try { F.data = await F.loading; } catch (error) { F.loading = null; throw error; }
  return F.data;
}

// 其他页面（角色交易的技能分析）共用装配数据与引擎
export async function fitData() {
  return { data: await ensureData(), FE };
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
    MU.loadMuta().then(() => { if (F.fit) recompute(); }).catch(() => {});
    if (!loadPending() && !loadFromHash()) {
      const saved = app.store.getJSON(CURRENT_KEY, null);
      F.fit = saved && F.data.types.has(saved.ship) ? normalize(saved) : null;
    }
    if (F.skillMode === 'esi') await loadEsiSkills();
    renderBrowserTabs();
    renderBrowser();
    recompute();
    F.ready = true;
    pickViewOnce();
    return;
  }
  if (loadPending() || loadFromHash()) { recompute(); renderBrowser(); restored = false; }
  syncSkillMode(restored);
  pickViewOnce();
}

// ---------- 第一次进装配页：大框选显示方式（圆盘 / 列表），和原版一样 ----------
// 没选过（eve-fit-view 为空）才弹；电脑默认选中圆盘、手机默认列表；选完存起来，之后在装配上方的「列表 / 圆盘」切换
const PICK_PREVIEW = {
  radial: `<svg viewBox="0 0 200 200" aria-hidden="true"><defs><radialGradient id="fvpG" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#9fb4c8"/><stop offset="1" stop-color="#26303a"/></radialGradient></defs>
    <clipPath id="fvpClip"><circle cx="100" cy="100" r="88"/></clipPath>
    <circle cx="100" cy="100" r="92" fill="#0b0d0f"/><circle cx="100" cy="100" r="88" fill="url(#fvpG)"/>
    <image href="${IMG(24698, 'render', 256)}" x="12" y="12" width="176" height="176" clip-path="url(#fvpClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="100" cy="100" r="76" fill="none" stroke="rgba(10,12,14,.72)" stroke-width="26"/>
    ${[-130, -117, -104, -91, -78, -65, -38, -25, -12, 1, 52, 65, 78, 91, 148, 161, 174].map((a, i) => { const r = Math.PI / 180, a0 = (a) * r, a1 = (a + 10.5) * r, R0 = 64, R1 = 88;
      const pts = [[R1, a0], [R1, a1], [R0, a1], [R0, a0]].map(([R, t]) => `${(100 + R * Math.cos(t)).toFixed(1)},${(100 + R * Math.sin(t)).toFixed(1)}`).join(' ');
      return `<polygon points="${pts}" fill="${i < 6 || (i >= 6 && i < 8) ? 'rgba(30,232,60,.14)' : 'rgba(153,153,153,.1)'}" stroke="${i < 8 ? '#1ee83c' : '#777'}" stroke-width="1"/>`; }).join('')}
    <circle cx="100" cy="100" r="96" fill="none" stroke="#2b3138" stroke-width="3"/></svg>`,
  list: `<svg viewBox="0 0 200 200" aria-hidden="true"><rect x="8" y="8" width="184" height="184" rx="6" fill="#0b0d0f"/>
    ${['高槽', '中槽', '低槽'].map((h, g) => { const y0 = 18 + g * 60; return `<text x="18" y="${y0 + 8}" fill="#8b949e" font-size="9" font-weight="700">${h}</text>` +
      [0, 1, 2].map((k) => `<rect x="18" y="${y0 + 14 + k * 14}" width="10" height="10" rx="2" fill="${g === 2 ? '#a67c52' : '#5d8f6a'}"/><rect x="34" y="${y0 + 16 + k * 14}" width="${86 - k * 14}" height="6" rx="3" fill="#c9d1d9" opacity=".75"/><rect x="${130 - k * 14}" y="${y0 + 16 + k * 14}" width="40" height="6" rx="3" fill="#6e7681" opacity=".55"/>`).join(''); }).join('')}</svg>`
};
// 选择框里的预览用真的装配界面画：一艘装满的幼龙级（圆盘取 SVG，列表取槽位行），算完把装配状态换回去；出错时退回示意图
const PICK_SAMPLE = `[Drake, 预览]
Ballistic Control System II
Ballistic Control System II
Damage Control II
Co-Processor II
Multispectrum Shield Hardener II
Large Shield Extender II
Large Shield Extender II
10MN Afterburner II
Kinetic Shield Hardener II
Thermal Shield Hardener II
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Salvager I
Medium Core Defense Field Extender I
Medium Core Defense Field Extender I
Medium Core Defense Field Extender I`;
function pickPreviews() {
  const keep = { fit: F.fit, calc: F.calc, stats: F.stats, selected: F.selected, target: F.target, preview: F.preview };
  try {
    const { fit } = parseEft(PICK_SAMPLE);
    if (!fit) return PICK_PREVIEW;
    for (const s of FE.SLOTS) for (const m of fit.slots[s]) if (m && type(m.type)?.activatable && s !== 'low') m.state = 'active';
    const calc = FE.computeFit(F.data, fit, skills());
    const stats = calc && FE.fitStats(calc);
    if (!stats) return PICK_PREVIEW;
    Object.assign(F, { fit, calc, stats, selected: null, target: null, preview: null });
    const svg = /<svg viewBox="0 0 512 512"[\s\S]*<\/svg>/.exec(radialHtml(type(fit.ship), stats))?.[0];
    const rows = FE.SLOTS.map((s) => {
      const total = stats.slots[s] || 0;
      if (!total) return '';
      const r = [];
      for (let i = 0; i < total; i++) r.push(moduleRow(s, i, fit.slots[s][i], false));
      return `<section class="fit-slots"><h4>${FE.SLOT_NAME[s]}<span>${stats.used[s]} / ${fmt(total)}</span></h4>${r.join('')}</section>`;
    }).join('');
    return {
      radial: svg ? `<div class="fit-radial fvp-live" inert>${svg.replace(/id="fr(ShipClip|Vignette)"/g, 'id="fvp$1"').replace(/url\(#fr(ShipClip|Vignette)\)/g, 'url(#fvp$1)')}</div>` : PICK_PREVIEW.radial,
      list: `<div class="fvp-live fvp-list" inert>${rows}</div>`
    };
  } catch (error) {
    console.warn('装配视图预览失败', error);
    return PICK_PREVIEW;
  } finally {
    Object.assign(F, keep);
  }
}
function pickViewOnce() {
  let have = null;
  try { have = localStorage.getItem(VIEW_KEY); } catch { return; }   // 存不了就不弹（每次都会弹）
  if (have || $('fitViewPick') || $('fitView')?.hidden) return;      // 只对第一次进装配页（还没选过视图）的人弹
  let pick = MOBILE() ? 'list' : 'radial';
  const prev = pickPreviews();
  // 预览里是真的装配界面（带按钮），卡片不能再用 <button> 包
  const card = (k, title, sub, note) => `<div class="fvp-card${pick === k ? ' is-on' : ''}" data-fvp="${k}" role="button" tabindex="0" aria-pressed="${pick === k}">
      <span class="fvp-head"><b>${title}</b><small>${sub}</small><em>${note}</em></span>
      <div class="fvp-prev fvp-prev-${k}">${prev[k]}</div><span class="fvp-check" aria-hidden="true"></span></div>`;
  const box = document.createElement('div');
  box.className = 'modal fvp-modal';
  box.id = 'fitViewPick';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'fvpTitle');
  box.innerHTML = `<div class="modal-backdrop"></div>
    <div class="modal-content fvp-content">
      <div class="modal-header"><h3 id="fvpTitle">选择装配视图</h3></div>
      <div class="modal-body">
        <div class="fvp-cards">
          ${card('radial', '圆盘', '适合电脑和平板', '和游戏装配窗口一样的环形，舰船图在中间')}
          ${card('list', '列表', '适合手机', '按槽位一行一件，信息完整、方便快速改')}
        </div>
      </div>
      <div class="fvp-foot"><button type="button" class="btn btn-primary" data-fvp-save>保存并关闭</button></div>
    </div>`;
  const save = () => {
    try { localStorage.setItem(VIEW_KEY, pick); } catch { /* 忽略 */ }
    box.remove();
    document.removeEventListener('keydown', onKey, true);
    if (F.fit) renderFit();
  };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); } };
  box.addEventListener('click', (e) => {
    const c = e.target.closest('[data-fvp]');
    if (c) {
      pick = c.dataset.fvp;
      box.querySelectorAll('[data-fvp]').forEach((b) => { b.classList.toggle('is-on', b === c); b.setAttribute('aria-pressed', String(b === c)); });
      if (e.detail > 1) save();   // 双击直接保存
      return;
    }
    if (e.target.closest('[data-fvp-save]')) save();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  box.querySelector('[data-fvp-save]').focus();
}

// 绑定 / 解绑 ESI 后刷新技能来源
let lastEsi = null;
function syncSkillMode(restored = false) {
  const esi = app.hasEsiToken();
  if (esi !== lastEsi) restored = false;   // 期间绑定 / 解绑了 ESI，需要刷新技能选项
  lastEsi = esi;
  if (!esi) F.esi = null;
  if (F.skillMode === 'esi' && !esi) { F.skillMode = 'max'; recompute(); }
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
  if (F.data.modes.get(fit.ship)?.includes(f.mode)) fit.mode = f.mode;   // 舰船模式（战术驱逐舰等），没有就是第一个
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
  if (F.skillMode === 'custom' && F.data) return customLevels();
  return F.skillMode === 'esi' && F.esi ? F.esi.levels : 'max';
}

function recompute() {
  F.preview = null;
  // 点过的空槽位装上了东西、换了船：不再作为放置目标
  if (F.target && (!F.fit || F.fit.ship !== F.target.ship || F.fit.slots[F.target.slot]?.[F.target.index])) F.target = null;
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
      const set = F.tab === 'charge' && chargeForTypes().length ? F.chargeShut : F.open;
      if (set.has(id)) set.delete(id); else set.add(id);
      renderBrowser();
      return;
    }
    const src = e.target.closest('[data-fit-src]');
    if (src) {
      const k = src.dataset.fitSrc;
      if (F.fitSrc.has(k)) F.fitSrc.delete(k); else F.fitSrc.add(k);
      F.shipShut = new Set();
      saveSettings();
      renderBrowser();
      return;
    }
    const sx = e.target.closest('[data-fit-ship-x]');
    if (sx) {
      const id = Number(sx.dataset.fitShipX);
      const open = sx.getAttribute('aria-expanded') === 'true';
      F.shipShut = F.shipShut || new Set();
      if (open) { F.shipOpen.delete(id); F.shipShut.add(id); } else { F.shipOpen.add(id); F.shipShut.delete(id); }
      renderBrowser();
      return;
    }
    const sf = e.target.closest('[data-fit-sf]');
    if (sf) { const [k, ...rest] = sf.dataset.fitSf.split(':'); openSourceFit(k, rest.join(':')); return; }
    const cf = e.target.closest('[data-fit-charge-for]');
    if (cf) {
      // 多选：点一下勾上 / 取消；一个都不选就是全部
      const id = Number(cf.dataset.fitChargeFor);
      const next = new Set(chargeForTypes().map((t) => t.id));
      if (next.has(id)) next.delete(id); else next.add(id);
      setChargeFor(next);
      renderBrowser();
      return;
    }
    const slotTab = e.target.closest('[data-fit-slot-tab]');
    if (slotTab) {
      F.slotFilter = slotTab.dataset.fitSlotTab || null;
      if (F.target && F.target.slot !== F.slotFilter) { F.target = null; renderFit(); }
      renderBrowser();
      return;
    }
    const filter = e.target.closest('[data-fit-only]');
    if (filter) { F.onlyFits = filter.checked; saveSettings(); renderBrowser(); return; }
    const item = e.target.closest('[data-fit-type]');
    if (item) useType(Number(item.dataset.fitType));
  });
  // 悬停预览：鼠标停在装备上，就把它淡淡地放进点击后会装进的那一格，右侧属性显示装上后的变化
  const browser = $('fitBrowser');
  let hoverTimer = 0;
  browser.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const id = Number(e.target.closest('[data-fit-type]')?.dataset.fitType) || 0;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => previewType(id), id ? 60 : 120);
  });
  browser.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); previewType(0); });
}

// 预览的放置位置：和点击时一样（点过的同类空槽位，否则第一个空位；槽位满了不预览）
function previewTarget(t) {
  if (!F.fit || !t || t.category !== FE.CAT.module || !t.slot || t.slot === 'sub') return null;
  if (F.target && F.target.slot === t.slot) return F.target;
  const index = freeIndex(t.slot);
  return index < 0 ? null : { slot: t.slot, index };
}
// 某类槽位第一个空位（没有返回 -1）
function freeIndex(slot) {
  const list = F.fit.slots[slot], total = F.stats?.slots[slot] || 0;
  const idx = list.findIndex((m, i) => !m && i < total);
  return idx >= 0 ? idx : list.length < total ? list.length : -1;
}

// 无人机 / 舰载机的悬停预览：和点击一样往挂舱（机库）里加 1 架（1 个中队），装不下就不预览
function previewDrone(t) {
  const fighter = t.category === FE.CAT.fighter;
  const res = F.stats.resources;
  const bay = fighter ? res.fighterBay : res.droneBay;
  const vol = (t.attrs.get(FE.AT.volume) || 0) * (fighter ? t.attrs.get(FE.AT.fighterSquadronSize) || 1 : 1);
  if (!bay.total || (vol && bay.used + vol > bay.total + 1e-6)) {
    if (F.preview) { F.preview = null; renderFit(); renderStats(); }
    return;
  }
  if (F.preview?.type === t.id && F.preview.drone) return;
  const fit = structuredClone(F.fit);
  const d = fit.drones.find((x) => x.type === t.id);
  if (d) d.count += 1;
  else fit.drones.push({ type: t.id, count: 1, active: 0 });
  autoActivateDrones(fit);
  const calc = FE.computeFit(F.data, fit, skills());
  const stats = calc && FE.fitStats(calc);
  if (!stats) return;
  F.preview = { type: t.id, drone: true, fighter, slot: null, index: -1, stats };
  renderFit();
  renderStats();
}

function previewType(id) {
  const t = id ? type(id) : null;
  if (F.fit && t && (t.category === FE.CAT.drone || t.category === FE.CAT.fighter)) return previewDrone(t);
  const tg = previewTarget(t);
  if (!tg || F.fit.slots[tg.slot][tg.index]?.type === id || FE.cannotFit(F.data, type(F.fit.ship), t)) {
    if (F.preview) { F.preview = null; renderFit(); renderStats(); }
    return;
  }
  if (F.preview?.type === id && F.preview.slot === tg.slot && F.preview.index === tg.index) return;
  const fit = structuredClone(F.fit);
  const list = fit.slots[tg.slot];
  const old = list[tg.index];
  const mod = { type: id, state: defaultState(t), charge: null };
  if (old?.charge && FE.chargeFits(t, type(old.charge))) mod.charge = old.charge;
  else mod.charge = list.find((m) => m && m.type === id && m.charge)?.charge || null;
  while (list.length < tg.index) list.push(null);
  list[tg.index] = mod;
  const calc = FE.computeFit(F.data, fit, skills());
  const stats = calc && FE.fitStats(calc);
  if (!stats) return;
  F.preview = { type: id, slot: tg.slot, index: tg.index, replace: Boolean(old), stats };
  renderFit();
  renderStats();
}

// 每个分类各记各的搜索词：切走时记下，切回来时填回去
function setTab(tab) {
  const input = $('fitSearch');
  if (input && tab !== F.tab) {
    F.queries[F.tab] = input.value;
    input.value = F.queries[tab] || '';
    F.query = input.value.trim().toLowerCase();
  }
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
  if (F.tab === 'ship' && F.fitSrc.size && !fitsOf(t.id).length) return false;
  const shipType = F.fit && type(F.fit.ship);
  if (F.tab === 'module') {
    if (F.slotFilter && t.slot !== F.slotFilter && !(F.slotFilter === 'rig' && !F.target && t.slot === 'sub')) return false;
    if (F.onlyFits && shipType) {
      if (FE.cannotFit(F.data, shipType, t)) return false;
      if (t.slot === 'sub' && !F.stats?.slots.sub) return false;
      if (t.slot && F.stats && !F.stats.slots[t.slot]) return false;
    }
  }
  if (F.tab === 'charge' && chargeForTypes().length) return chargeForTypes().some((m) => FE.chargeFits(m, t));
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

// 模糊搜索：整串包含 > 空格分开的几段都能对上 > 中文按字顺序出现（「损控」→ 损伤控制）/ 英文按单词首字母（「dcii」→ Damage Control II），越紧凑越靠前；
// 常用英文缩写（mwd、dda…）换成全名再搜一遍。返回 null 为不匹配
const SEARCH_ALIAS = {
  mwd: 'microwarpdrive', ab: 'afterburner', dc: 'damage control', dcu: 'damage control', dda: 'drone damage amplifier', bcs: 'ballistic control system',
  mjd: 'micro jump drive', lse: 'large shield extender', mse: 'medium shield extender', asb: 'ancillary shield booster', aar: 'ancillary armor repairer',
  eanm: 'energized adaptive nano membrane', tp: 'target painter', sebo: 'sensor booster', te: 'tracking enhancer', tc: 'tracking computer',
  dlu: 'drone link augmentor', nos: 'nosferatu', neut: 'energy neutralizer', scram: 'warp scrambler', disruptor: 'warp disruptor', web: 'stasis webifier',
  cap: 'capacitor', pdu: 'power diagnostic system', rcu: 'reactor control unit', mapc: 'micro auxiliary power core', ihs: 'inertial stabilizer',
  nano: 'nanofiber internal structure', od: 'overdrive injector system', mag: 'magnetic field stabilizer', gyro: 'gyrostabilizer', hs: 'heat sink'
};
const CJK = /[\u3400-\u9fff]/;
const ROMAN_WORD = /^(i|ii|iii|iv|v|x)$/;
function inOrder(n, chars) {
  let i = 0, first = -1, last = -1;
  for (const c of chars) { const k = n.indexOf(c, i); if (k < 0) return null; if (first < 0) first = k; last = k; i = k + 1; }
  return (last - first + 1 - chars.length) / (n.length + 1) + (first ? 0.3 : 0);
}
function scoreName(n, q) {
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    let loose = 0;
    for (const w of words) {
      if (n.includes(w)) continue;
      const k = CJK.test(w) && w.length > 1 ? inOrder(n, w) : null;
      if (k == null) return null;
      loose += 0.5 + k;
    }
    return 2 + loose;
  }
  if (CJK.test(q)) { const k = q.length > 1 ? inOrder(n, q) : null; return k == null ? null : 3 + k; }
  // 英文：单词首字母（罗马数字整个算），如 dcii → damage control ii
  const init = n.split(/[^a-z0-9]+/).filter(Boolean).map((w) => (ROMAN_WORD.test(w) ? w : w[0])).join('');
  if (q.length > 1 && init.startsWith(q)) return 2.5;
  if (q.length > 2 && init.includes(q)) return 3.5;
  return null;
}
function fuzzyScore(t, q) {
  // 整个就是缩写（lse）时只按全名搜，免得「lse」当子串匹配到 pulse
  const ex = q.split(/\s+/).map((w) => SEARCH_ALIAS[w] || w).join(' ');
  const qs = SEARCH_ALIAS[q] ? [ex] : ex !== q ? [q, ex] : [q];
  let best = null;
  for (const x of qs) {
    for (const raw of [t.name, t.en]) {
      if (!raw) continue;
      const sc = scoreName(raw.toLowerCase(), x);
      if (sc != null && (best == null || sc < best)) best = sc;
    }
  }
  return best;
}

function renderBrowser() {
  if (!F.data) return;
  const box = $('fitBrowser');
  if (F.tab === 'ship') buildFitIndex();
  const list = tabTypes().filter(visible);
  const head = [];
  // 弹药页最上面一排：已装上、要装弹药 / 脚本的装备图标，可多选，只看勾上的装备能用的弹药（全展开）；一个不选就是全部
  const cur = F.tab === 'charge' ? chargeForTypes() : [];
  if (F.tab === 'charge') {
    const mods = chargeModules(), on = new Set(cur.map((t) => t.id));
    if (mods.length) head.push(`<div class="fit-charge-mods">${mods.map(({ t, n }) => `<button type="button" class="fit-cm${on.has(t.id) ? ' active' : ''}" data-fit-charge-for="${t.id}" aria-pressed="${on.has(t.id)}" title="${app.esc(t.name)}${n > 1 ? ' × ' + n : ''}"><img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">${n > 1 ? `<em>${n}</em>` : ''}</button>`).join('')}</div>`);
    if (cur.length) head.push(`<p class="fit-charge-for">${cur.length === 1 ? `${app.esc(cur[0].name)} 可用的弹药` : `已选 ${cur.length} 种装备可用的弹药`}</p>`);
  }
  if (F.tab === 'ship') { loadFitSources(); buildFitIndex(); head.push(fitSrcBar()); }
  if ((F.tab === 'module' || F.tab === 'drone' || F.tab === 'charge') && !cur.length) {
    head.push(`<label class="fit-only"><input type="checkbox" data-fit-only${F.onlyFits ? ' checked' : ''}>只显示${F.tab === 'charge' ? '已装配武器可用的弹药' : '能装到当前舰船的'}</label>`);
  }
  // 装备按槽位筛选（点装配里的空槽位也会切到对应槽位）：和游戏装配浏览器一样是低 / 中 / 高槽、改装件四个图标按钮（改装件含子系统），
  // 再点一次已选中的取消筛选
  if (F.tab === 'module') {
    head.push(`<div class="fit-src-bar fit-slot-tabs" role="group" aria-label="按槽位筛选">${SLOT_FILTERS.map(([s, icon]) => {
      const on = F.slotFilter === s || (s === 'rig' && F.slotFilter === 'sub');
      const label = s === 'rig' ? '改装件 / 子系统' : FE.SLOT_NAME[s];
      return `<button type="button" class="fit-src${on ? ' active' : ''}" data-fit-slot-tab="${on ? '' : s}" aria-pressed="${on}" title="${label}" aria-label="${label}"><i class="fit-src-i fit-slot-i" style="-webkit-mask-image:url(${icon});mask-image:url(${icon})"></i></button>`;
    }).join('')}</div>`);
  }
  if (F.query) {
    const q = F.query;
    const hits = list.map((t) => [t, fuzzyScore(t, q)]).filter(([, sc]) => sc != null)
      .sort((a, b) => a[1] - b[1] || a[0].name.length - b[0].name.length)
      .slice(0, 200).map(([t]) => t);
    box.innerHTML = head.join('') + (hits.length ? '<div class="fit-list">' + hits.map(rowOf).join('') + '</div>' : `<p class="legend-empty">${F.tab === 'ship' && F.fitSrc.size ? '没有符合的舰船' : '没有匹配的物品'}</p>`);
    loadRowPrices();
    return;
  }
  // 按市场分组展示：只显示含可见物品的分组
  const count = new Map();
  const noMarket = [];
  for (const t of list) {
    // 不在市场出售的深渊装备（突变后的装备 / 无人机）不列出，要用就在装配行上「突变」
    if (!t.market || !F.data.markets.has(t.market)) { if (t.meta !== 15) noMarket.push(t); continue; }
    for (let m = F.data.markets.get(t.market); m; m = F.data.markets.get(m.parent)) count.set(m.id, (count.get(m.id) || 0) + 1);
  }
  const roots = [...F.data.markets.values()].filter((m) => !m.parent && count.get(m.id)).sort(byName);
  const typeSet = new Set(list.map((t) => t.id));
  const group = (m, depth) => {
    const key = 'm' + m.id;
    // 舰船页按装配来源筛选时分组全展开（筛出来的船不多）
    const open = F.tab === 'charge' && chargeForTypes().length ? !F.chargeShut.has(key) : F.open.has(key) || (roots.length === 1 && depth === 0) || (F.tab === 'ship' && F.fitSrc.size > 0);
    const kids = m.children.filter((c) => count.get(c.id)).sort(byName);
    const items = m.types.filter((t) => typeSet.has(t.id)).sort(byMeta);
    // 和市场目录一样：分类图标 + 计数胶囊 + 子级缩进连接线（个性化设置的「目录图标 / 连接线」开关同样生效）
    const ic = groupIcon(m);
    return `<div class="fit-group${open ? ' open' : ''}">
      <button class="fit-group-head" data-fit-group="${key}"><svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>${ic ? `<img class="tree-icon tree-cat-icon" src="${IMG(ic)}" alt="" width="20" height="20" loading="lazy" draggable="false">` : ''}<b>${app.esc(m.name)}</b><span>${count.get(m.id)}</span></button>
      ${open ? `<div class="fit-group-kids">${kids.map((c) => group(c, depth + 1)).join('') + (items.length ? `<div class="fit-list">${items.map(rowOf).join('')}</div>` : '')}</div>` : ''}
    </div>`;
  };
  box.innerHTML = head.join('') + (roots.length || noMarket.length
    ? roots.map((m) => group(m, 0)).join('') + (noMarket.length ? `<div class="fit-group open"><div class="fit-group-head is-static">其他（不在市场出售）<span>${noMarket.length}</span></div><div class="fit-list">${noMarket.sort(byMeta).slice(0, 300).map(itemRow).join('')}</div></div>` : '')
    : `<p class="legend-empty">${F.tab === 'charge' && F.onlyFits ? '先装上需要弹药的武器或装备' : F.tab === 'ship' && F.fitSrc.size ? fitSrcEmpty() : '没有可显示的物品'}</p>`);
  loadRowPrices();
}

// 市场分组图标：和市场目录同一个取法（分组含子分组里物品 ID 最小的那件的图标），按分组缓存
const groupIconCache = new Map();
function groupIcon(m) {
  if (!groupIconCache.has(m.id)) groupIconCache.set(m.id, Math.min(...m.types.map((t) => t.id), ...m.children.map(groupIcon).filter(Boolean), Infinity));
  const v = groupIconCache.get(m.id);
  return Number.isFinite(v) ? v : 0;
}
const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
const byMeta = (a, b) => (a.meta || 1) - (b.meta || 1) || a.name.localeCompare(b.name, 'zh');

// ---------- 舰船页：船下面展开这艘船的装配（我的装配 / 游戏装配 / 广场），像游戏装配窗口的「舰船与装配」----------
// 图标用游戏装配浏览器顶上的筛选按钮（hullAndHardwareTypeBrowser.py）：个人装配 = 人像，社区装配 = tabCommunityFits；网站保存的装配游戏里没有，用装配浏览器的舰船图标
const SRC_ICON = {
  saved: '<i class="fit-src-i" style="-webkit-mask-image:url(assets/eveui/classes/fitting/tabfittings.png);mask-image:url(assets/eveui/classes/fitting/tabfittings.png)"></i>',
  esi: '<i class="fit-src-i" style="-webkit-mask-image:url(assets/eveui/windowicons/member.png);mask-image:url(assets/eveui/windowicons/member.png)"></i>',
  plaza: '<i class="fit-src-i" style="-webkit-mask-image:url(assets/eveui/classes/fitting/tabcommunityfits.png);mask-image:url(assets/eveui/classes/fitting/tabcommunityfits.png)"></i>'
};
const FIT_SRC = { saved: '我的装配', esi: '游戏装配（ESI）', plaza: '广场装配' };
// 装备页的槽位筛选：游戏装配浏览器的筛选图标（res:/UI/Texture/classes/Fitting/filterIcon*.png），顺序同游戏
const SLOT_FILTERS = [['low', 'lowslot'], ['mid', 'mediumslot'], ['high', 'highslot'], ['rig', 'rigslot']].map(([s, f]) => [s, `assets/eveui/classes/fitting/filtericon${f}.png`]);
const FS = { esi: null, esiBusy: false, esiChar: 0, plaza: null, plazaAt: 0, plazaBusy: false };
function loadFitSources() {
  // 游戏装配：绑定了 ESI 才读（和「游戏装配」窗口同一份缓存）
  if (app.hasEsiToken() && !FS.esiBusy && FS.esi === null) {
    FS.esiBusy = true;
    loadEsiFitList().then((l) => { FS.esi = l; }).catch(() => { FS.esi = []; }).finally(() => { FS.esiBusy = false; if (F.tab === 'ship') renderBrowser(); });
  }
  // 广场：全部「装配」帖（最多 500 条），10 分钟刷新
  if (!FS.plazaBusy && Date.now() - FS.plazaAt > 600e3) {
    FS.plazaBusy = true;
    fetch(`/api/kb/plaza?server=${SERVER.id}&kind=fit`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => { FS.plaza = (j.items || []).filter((p) => p.data?.fit); FS.plazaAt = Date.now(); })
      .catch(() => { FS.plaza = FS.plaza || []; FS.plazaAt = Date.now() - 540e3; })   // 失败 1 分钟后再试
      .finally(() => { FS.plazaBusy = false; if (F.tab === 'ship') renderBrowser(); });
  }
}
// 舰船 → 全部来源的装配（每次渲染舰船页重建一次）
let fitIdx = null;
function buildFitIndex() {
  const idx = new Map();
  const add = (ship, x) => { if (!idx.has(ship)) idx.set(ship, []); idx.get(ship).push(x); };
  for (const f of savedFits()) add(f.ship, { src: 'saved', key: String(f.id), name: f.name || '未命名' });
  for (const f of FS.esi || []) add(f.ship, { src: 'esi', key: String(f.esiId), name: f.name || '未命名' });
  for (const p of FS.plaza || []) add(Number(p.data.ship), { src: 'plaza', key: String(p.id), name: p.title || p.data.fit.n || '未命名', by: p.name });
  fitIdx = idx;
  return idx;
}
// 这艘船的装配：按顶上选中的来源（一个不选 = 全部来源）
function fitsOf(ship) {
  const all = (fitIdx || buildFitIndex()).get(ship) || [];
  return F.fitSrc.size ? all.filter((x) => F.fitSrc.has(x.src)) : all;
}
function fitSrcBar() {
  const n = (k) => { let c = 0; for (const list of fitIdx.values()) if (list.some((x) => x.src === k)) c++; return c; };
  return `<div class="fit-src-bar" role="group" aria-label="只看有装配的舰船">${Object.entries(FIT_SRC).map(([k, label]) => {
    const off = k === 'esi' && !app.hasEsiToken();
    const busy = (k === 'esi' && FS.esiBusy) || (k === 'plaza' && FS.plazaBusy && !FS.plaza);
    const cnt = off || busy ? 0 : n(k);
    return `<button type="button" class="fit-src${F.fitSrc.has(k) ? ' active' : ''}" data-fit-src="${k}" aria-pressed="${F.fitSrc.has(k)}" title="只看有${label}的舰船${off ? '（需要先绑定 ESI）' : busy ? '（读取中）' : `：${cnt} 艘`}" aria-label="${label}"${off ? ' disabled' : ''}>${SRC_ICON[k]}${cnt ? `<em>${cnt}</em>` : ''}</button>`;
  }).join('')}</div>`;
}
const fitSrcEmpty = () => ([...F.fitSrc].some((k) => (k === 'esi' && FS.esiBusy) || (k === 'plaza' && FS.plazaBusy)) ? '读取中…' : '没有符合的舰船');
function rowOf(t) {
  if (F.tab !== 'ship') return itemRow(t);
  const fits = fitsOf(t.id);
  if (!fits.length) return itemRow(t);
  const open = F.shipOpen.has(t.id) || (F.fitSrc.size > 0 && !F.shipShut?.has(t.id));
  return `<div class="fit-ship-row${open ? ' open' : ''}">${itemRow(t)}<button type="button" class="fit-ship-x" data-fit-ship-x="${t.id}" aria-expanded="${open}" title="${fits.length} 套装配"><em>${fits.length}</em><svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button></div>
    ${open ? `<div class="fit-ship-fits">${fits.map((f) => `<button type="button" class="fit-sf" data-fit-sf="${f.src}:${app.esc(f.key)}" title="${app.esc(FIT_SRC[f.src] + (f.by ? ' · ' + f.by : ''))}"><i class="fit-sf-src is-${f.src}">${SRC_ICON[f.src]}</i><span class="notranslate">${app.esc(f.name)}</span>${f.by ? `<small class="notranslate">${app.esc(f.by)}</small>` : ''}</button>`).join('')}</div>` : ''}`;
}
// 点船下面的装配：打开它（同装配页其他打开方式）
function openSourceFit(src, key) {
  let fit = null;
  if (src === 'saved') fit = savedFits().find((f) => String(f.id) === key);
  else if (src === 'esi') fit = (FS.esi || []).find((f) => String(f.esiId) === key);
  else if (src === 'plaza') { const p = (FS.plaza || []).find((x) => String(x.id) === key); if (p) { fit = fromCompact(p.data.fit); if (!fit.name) fit.name = p.title || ''; } }
  if (!fit) { app.showToast('装配不存在或已删除', 'error'); return; }
  stashDraft(F.fit);
  F.fit = normalize(fit);
  if (src !== 'saved') F.fit.id = null;   // 游戏装配 / 广场装配：保存时存成新的「我的装配」
  F.selected = null;
  if (src !== 'saved') autoActivateDrones();
  recompute();
  renderBrowser();
}

function itemRow(t) {
  const meta = metaTag(t);
  const fitInfo = t.category === FE.CAT.module ? [t.attrs.get(FE.AT.cpu) ? `${fmt(t.attrs.get(FE.AT.cpu))} tf` : '', t.attrs.get(FE.AT.power) ? `${fmt(t.attrs.get(FE.AT.power))} MW` : '', t.attrs.get(FE.AT.upgradeCost) ? `校准 ${t.attrs.get(FE.AT.upgradeCost)}` : ''].filter(Boolean).join(' · ') : '';
  return `<button class="fit-item" data-fit-type="${t.id}" title="${app.esc(t.name + (t.en ? '\n' + t.en : ''))}">
    <img src="${IMG(t.id)}" alt="" width="24" height="24" loading="lazy" draggable="false">
    <span class="fit-item-name">${app.esc(t.name)}${fitInfo ? `<small>${fitInfo}</small>` : ''}</span>
    ${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}${t.market && t.category !== FE.CAT.ship ? `<span class="fit-item-price" data-fit-price="${t.id}">${priceText(t.id)}</span>` : ''}${infoBtn(t.id, 'span')}
  </button>`;
}

// ---------- 交易中心价格：左侧列表每个物品后面的最低卖价（舰船不列），详情里的最低卖 / 最高收 ----------
// 来源和右侧「估价」同一个交易中心（app.valuation，切换后列表与详情跟着变），价格有本地缓存；列表展开时只查看得到的物品
const HP = { region: null, map: new Map(), want: new Set(), timer: 0, waiters: [] };
function hubPrices() {
  const r = app.valuation.region();
  if (HP.region !== r.id) { HP.region = r.id; HP.map.clear(); }
  return HP.map;
}
const priceText = (id) => { const p = hubPrices().get(id); return !p ? '' : p.sell != null ? app.formatISK(p.sell) : '—'; };
// 要价格的物品攒一下（0.15 秒）一起查
function wantPrices(ids) {
  const map = hubPrices();
  for (const id of ids) if (!map.has(id)) HP.want.add(id);
  if (!HP.want.size) return Promise.resolve();
  const p = new Promise((res) => HP.waiters.push(res));
  clearTimeout(HP.timer);
  HP.timer = setTimeout(() => {
    const list = [...HP.want], waiters = HP.waiters, region = HP.region;
    HP.want.clear(); HP.waiters = [];
    app.valuation.items(list.map((id) => ({ type_id: id, quantity: 1 }))).then((v) => {
      if (HP.region === region) for (const id of list) HP.map.set(id, v.price(id));
    }).catch(() => {}).finally(() => waiters.forEach((w) => w()));
  }, 150);
  return p;
}
function loadRowPrices() {
  const els = [...$('fitBrowser').querySelectorAll('[data-fit-price]')];
  const ids = els.filter((el) => !el.textContent).map((el) => Number(el.dataset.fitPrice));
  if (!ids.length) return;
  wantPrices(ids).then(() => {
    for (const el of $('fitBrowser').querySelectorAll('[data-fit-price]')) el.textContent = priceText(Number(el.dataset.fitPrice));
  });
}
function infoPriceHtml(id) {
  const p = hubPrices().get(id);
  return `<span>最低卖</span><b class="is-sell">${p ? app.formatISK(p.sell) : '…'}</b><span>最高收</span><b class="is-buy">${p ? app.formatISK(p.buy) : '…'}</b>`;
}
async function fillInfoPrice(id) {
  await wantPrices([id]);
  const el = document.querySelector(`[data-fi-price="${id}"]`);
  if (el) el.innerHTML = infoPriceHtml(id);
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
  if (!F.fit || b.closest('.fi-pop')) return null;
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

// 物品详情：悬浮窗（float-pop.js）——点 ⓘ 打开，可拖动、不挡装配操作；窗口里的物品链接点击后在本窗口换内容
let infoFloat = null;
function initTypeInfo() {
  infoFloat = makeFloat({
    attr: 'fit-info',
    hover: false,
    className: 'fi-pop fi-modal',
    label: '物品详情',
    html: `<div class="modal-header" data-float-drag><h3>物品详情</h3><span class="toolbar-spacer"></span>${pinBtn()}${closeBtn()}</div>
      <div class="modal-body" id="fitInfoBody"></div>`,
    onOpen: (id, { anchor }) => openTypeInfo(id, anchor ? infoSource(anchor) : null),
    onClose: () => { $('fitInfoBody').dataset.open = ''; }
  });
  infoFloat.el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-fi-market]');
    if (m) { infoFloat.close(); app.openItem?.(Number(m.dataset.fiMarket)); return; }
    const fs = e.target.closest('[data-fi-fit]');
    if (fs) { infoFloat.close(); openShip(Number(fs.dataset.fiFit)); return; }
    const sw = e.target.closest('[data-fi-swap]');
    if (sw) { if (swapType(Number($('fitInfoBody').dataset.id), Number(sw.dataset.fiSwap))) infoFloat.close(); return; }
    const tab = e.target.closest('[data-fi-tab]');
    if (tab) infoFloat.el.querySelectorAll('[data-fi-tab], [data-fi-pane]').forEach((el) => el.classList.toggle('active', (el.dataset.fiTab || el.dataset.fiPane) === tab.dataset.fiTab));
  });
}

async function openTypeInfo(id, src = null) {
  const t = infoType(id);
  if (!t) return;
  const body = $('fitInfoBody');
  const tabNow = body.dataset.open ? body.querySelector('[data-fi-tab].active')?.dataset.fiTab : null;
  const [names, info] = await Promise.all([dogmaNames(), fitInfo()]);
  if (infoFloat.id !== id) return;   // 读数据期间换了别的物品
  body.dataset.id = String(id);
  F.infoSrc = sourceType(src) === id ? src : null;
  body.innerHTML = infoHtml(t, names, info, tabNow, Boolean(F.infoSrc), DRAG_CATS.has(t.category) && !t.ext, true);
  body.dataset.open = '1';
  body.querySelector('.fi-panes').scrollTop = 0;
  if (t.market) fillInfoPrice(id);
  infoDesc(id).then((text) => {
    const el = $('fitInfoDesc');
    if (el && body.dataset.id === String(id)) el.textContent = text;
  });
}
// 物品描述（ESI，按界面语言）
function infoDesc(id) {
  const lang = window.I18N?.lang === 'en' ? 'en' : 'zh';
  return app.fetchESI(`/universe/types/${id}/`, { headers: { 'Accept-Language': lang } }).then((d) => {
    const text = String(d.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    return text || (lang === 'en' ? 'No description' : '没有描述');
  }).catch(() => '描述读取失败');
}
// 装配数据里没有的物品（矿物、蓝图、材料等，市场详情页打开）：按 ESI 的物品属性显示，没有加成 / 衍生
const EXT = new Map();   // id -> 物品（与装配数据同样的字段，ext = true）| Promise
const infoType = (id) => type(id) || (EXT.get(id)?.id ? EXT.get(id) : null);
function extType(id) {
  if (EXT.has(id)) return Promise.resolve(EXT.get(id));
  const lang = window.I18N?.lang === 'en' ? 'en' : 'zh';
  const get = (path) => app.fetchESI(path, { headers: { 'Accept-Language': lang } });
  const p = get(`/universe/types/${id}/`).then(async (d) => {
    const g = await get(`/universe/groups/${d.group_id}/`).catch(() => null);
    const attrs = new Map((d.dogma_attributes || []).map((a) => [a.attribute_id, a.value]));
    const t = { id, name: d.name || String(id), en: '', group: d.group_id, groupName: g?.name || '', category: g?.category_id, market: d.market_group_id || 0,
      meta: attrs.get(1692) || 1, attrs, effects: [], skills: FE.AT.reqSkills.map(([sk, l]) => [attrs.get(sk), attrs.get(l) || 0]).filter(([sk]) => sk), ext: true };
    EXT.set(id, t);
    return t;
  });
  EXT.set(id, p);
  p.catch(() => EXT.delete(id));
  return p;
}
// 其他页面（市场物品详情页）打开物品详情悬浮窗
export async function openInfo(id, anchor = null) {
  await ensureData();
  if (!type(id)) await extType(id);
  infoFloat.open(id, { anchor, pinned: true });
}
// 舰船在装配页查看：已在装配页就直接换船，否则记下、切到装配页时载入（有这艘船上次没保存的草稿就载入草稿）
const fitVisible = () => F.ready && !document.getElementById('fitView')?.hidden;
let pendingShip = 0;
export function openShip(id) {
  if (fitVisible()) { if (type(id)) setShip(id); return; }
  pendingShip = id;
  app.openFit();
}
function loadPendingShip() {
  const id = pendingShip;
  pendingShip = 0;
  if (!id || type(id)?.category !== FE.CAT.ship) return false;
  if (!F.fit) {
    const saved = app.store.getJSON(CURRENT_KEY, null);
    if (saved && F.data.types.has(saved.ship)) F.fit = normalize(saved);
  }
  if (F.fit?.ship !== id) {
    stashDraft(F.fit);
    const draft = takeDraft(id);
    F.fit = draft || newFit(id);
    if (draft) app.showToast(`已载入${type(id).name}上次未保存的装配`, 'info', 3000);
  }
  F.selected = null;
  F.slotFilter = null;
  if (F.tab === 'ship') { F.tab = 'module'; renderBrowserTabs(); }
  return true;
}

// 悬浮窗（float-detail.html）里的物品详情：主页面生成整页内容推过去（描述已填好，没有「替换」）
export async function typeDetail(id) {
  await ensureData();
  const t = type(id) || await extType(id).catch(() => null);
  if (!t) throw new Error('没有这个物品的数据');
  const [names, info, desc] = await Promise.all([dogmaNames(), fitInfo(), infoDesc(id), t.market ? Promise.race([wantPrices([id]), new Promise((r) => setTimeout(r, 4000))]) : null]);
  const html = infoHtml(t, names, info, null, false).replace('<div class="pi-loading">读取描述…</div>', app.esc(desc));
  return { title: t.name, html: `<div class="fi-pop fi-float">${html}</div>` };
}
function infoHtml(t, names, info, tabNow, canSwap, drag = false, inPage = false) {
  const id = t.id;
  const meta = metaTag(t);
  const isShip = t.category === FE.CAT.ship;
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
  return `<div class="fi-head">
      <img src="${IMG(id, isShip ? 'render' : 'icon', 128)}" alt="" width="72" height="72"${drag ? ` class="fi-drag" data-fit-drag="${id}" draggable="false" title="按住拖到装配的槽位上"` : ''}>
      <div class="fi-title"><span>${app.esc(F.data.groups.get(t.group)?.name || t.groupName || '')}${meta ? `<em class="fit-meta is-${meta[1]}">${meta[0]}</em>` : ''}${t.attrs.get(633) ? `<small>衍生等级 ${t.attrs.get(633)}</small>` : ''}</span>
        <h4>${app.esc(t.name)}</h4>${t.en && t.en !== t.name ? `<small translate="no">${app.esc(t.en)}</small>` : ''}
        ${t.market ? `<div class="fi-price" data-fi-price="${id}">${infoPriceHtml(id)}</div>` : ''}</div>
      <div class="fi-acts">${t.market ? `<button type="button" class="btn btn-ghost btn-sm" data-fi-market="${id}">市场价格</button>` : ''}
      ${inPage && isShip && !t.ext && !(F.fit?.ship === id && fitVisible()) ? `<button type="button" class="btn btn-ghost btn-sm" data-fi-fit="${id}">在装配页查看</button>` : ''}</div>
    </div>
    <div class="segmented fi-tabs">${tabs.map(([k, l]) => `<button type="button" data-fi-tab="${k}" class="${k === first ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="fi-panes">${pane('attrs', attrsHtml)}
    ${bonus ? pane('bonus', bonusHtml(bonus)) : ''}
    ${pane('skills', skillTreeHtml(t))}
    ${variants.length > 1 ? pane('var', variantsHtml(variants, id, canSwap)) : ''}
    ${pane('desc', '<div class="fi-desc" id="fitInfoDesc" translate="no"><div class="pi-loading">读取描述…</div></div>')}</div>`;
}

// 舰船加成与衍生关系（fit-info.json，server/build_fit_info.py 由 SDE 生成），第一次打开详情时加载
let fitInfoP = null;
// 国服独有舰船的加成在 cn-extra-<服>.json 的 fit.bonus（build_cn_extra.py 按效果生成）
const fitInfo = () => fitInfoP || (fitInfoP = Promise.all([fetch('./fit-info.json?v=1').then((r) => r.json()), serverExtra()])
  .then(([info, extra]) => (extra?.fit?.bonus ? { ...info, bonus: { ...info.bonus, ...extra.fit.bonus } } : info))
  .catch(() => { fitInfoP = null; return {}; }));
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
    : '<p class="fi-skill-note">按全 5 级显示</p>';
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
    // 装备 / 弹药 / 无人机等能直接拖到装配的槽位上（点击仍是打开详情）
    const drag = F.fit && DRAG_CATS.has(t.category) ? ` data-fit-drag="${t.id}" title="点击查看详情 · 按住拖到装配的槽位上"` : '';
    return `<div class="fi-var${t.id === current ? ' is-current' : ''}"><button type="button" class="fi-var-main" data-fit-info="${t.id}"${drag}>
      <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy" draggable="false">
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

// ---------- 拖放：左侧列表的物品、详情里的大图标按住拖到中间的槽位 ----------
// 鼠标按住移动 6px 开始拖；触屏长按 0.3 秒开始拖（不影响滚动列表）。能放的位置淡淡标出，指到的位置变蓝（放不了变红）
//   装备 / 子系统 → 同类槽位的那一格（有装备就替换，原来的弹药能用就留着）；弹药 → 那个装备；无人机 / 舰载机 / 植入体 → 对应区域
const DRAG_CATS = new Set([FE.CAT.module, FE.CAT.subsystem, FE.CAT.charge, FE.CAT.drone, FE.CAT.fighter, FE.CAT.implant]);
const DROP_KIND = { [FE.CAT.drone]: 'drone', [FE.CAT.fighter]: 'fighter', [FE.CAT.implant]: 'implant' };

// 某个元素作为 t 的放置位置：{ el 高亮的元素, ok 能不能放, apply 放下 }；不是放置位置返回 null
function dropTarget(t, node) {
  if (!node?.closest || !F.fit) return null;
  if (t.category === FE.CAT.module || t.category === FE.CAT.subsystem) {
    const el = node.closest('#fitMain [data-fit-mod], #fitMain [data-fit-empty]');
    if (!el) return null;
    const { slot, index } = el.dataset.fitMod ? parseRef(el.dataset.fitMod) : { slot: el.dataset.fitEmpty, index: Number(el.dataset.fitIdx) };
    const ok = slot === t.slot && !el.classList.contains('is-extra') && !FE.cannotFit(F.data, type(F.fit.ship), t);
    return { el, ok, apply: () => putModule(t, slot, index) };
  }
  if (t.category === FE.CAT.charge) {
    const el = node.closest('#fitMain [data-fit-mod]');
    if (!el) return null;
    const { slot, index } = parseRef(el.dataset.fitMod);
    const m = F.fit.slots[slot][index];
    return { el, ok: Boolean(m && FE.chargeFits(type(m.type), t)), apply: () => { m.charge = t.id; recompute(); } };
  }
  const kind = DROP_KIND[t.category];
  const el = kind && node.closest('#fitMain [data-fit-drop]');
  if (!el) return null;
  return { el, ok: el.dataset.fitDrop === kind, apply: () => useType(t.id) };
}

// 装备放到指定槽位（替换那一格）；子系统按类别替换，同 addModule
function putModule(t, slot, index) {
  const why = FE.cannotFit(F.data, type(F.fit.ship), t);
  if (why) { app.showToast(`${t.name}：${why}`, 'error'); return; }
  if (slot === 'sub') { addModule(t); return; }
  const list = F.fit.slots[slot];
  const old = list[index];
  const mod = { type: t.id, state: defaultState(t), charge: null };
  if (old?.charge && FE.chargeFits(t, type(old.charge))) mod.charge = old.charge;
  else mod.charge = list.find((m) => m && m.type === t.id && m.charge)?.charge || null;
  while (list.length < index) list.push(null);
  list[index] = mod;
  F.selected = { slot, index };
  recompute();
}

function initDrag() {
  let pend = null;   // 按下还没开始拖：{ t, x, y, id, timer, pop }
  let drag = null;   // 正在拖：{ t, ghost, hit, cands, pop }
  let eatClick = false;
  const source = (e) => e.target.closest?.('#fitBrowser [data-fit-type], [data-fit-drag]');
  const stopTouchScroll = (e) => { if (drag) e.preventDefault(); };
  const start = () => {
    const { t, x, y, pop } = pend;
    clearTimeout(pend.timer);
    pend = null;
    if (!F.fit) { app.showToast('请先选择一艘舰船', 'info'); return; }
    if (MOBILE()) app.closeDrawer?.();
    const ghost = document.createElement('img');
    ghost.className = 'fit-drag-ghost';
    ghost.src = IMG(t.id, 'icon', 64);
    ghost.alt = '';
    document.body.append(ghost);
    document.body.classList.add('fit-dragging');
    // 能放的位置先标出来
    const cands = [...document.querySelectorAll('#fitMain [data-fit-mod], #fitMain [data-fit-empty], #fitMain [data-fit-drop]')].filter((el) => dropTarget(t, el)?.ok && dropTarget(t, el).el === el);
    cands.forEach((el) => el.classList.add('fit-drop-cand'));
    // 从详情弹窗拖出来：弹窗变淡并让鼠标穿过去，下面被盖住的槽位也能放
    pop?.classList.add('fit-drag-from');
    drag = { t, ghost, hit: null, cands, pop };
    move(x, y);
  };
  const move = (x, y) => {
    drag.ghost.style.transform = `translate(${x - 20}px, ${y - 20}px)`;
    const hit = dropTarget(drag.t, document.elementFromPoint(x, y));
    if (drag.hit?.el !== hit?.el || drag.hit?.ok !== hit?.ok) {
      drag.hit?.el.classList.remove('fit-drop-ok', 'fit-drop-no');
      hit?.el.classList.add(hit.ok ? 'fit-drop-ok' : 'fit-drop-no');
    }
    drag.hit = hit;
  };
  const end = (drop) => {
    if (pend) { clearTimeout(pend.timer); pend = null; }
    if (!drag) return;
    const { t, ghost, hit, cands, pop } = drag;
    drag = null;
    ghost.remove();
    pop?.classList.remove('fit-drag-from');
    document.body.classList.remove('fit-dragging');
    cands.forEach((el) => el.classList.remove('fit-drop-cand'));
    hit?.el.classList.remove('fit-drop-ok', 'fit-drop-no');
    eatClick = true;
    setTimeout(() => { eatClick = false; }, 0);
    if (!drop || !hit) return;
    if (!hit.ok) { app.showToast(`${t.name}：${(F.fit && FE.cannotFit(F.data, type(F.fit.ship), t)) || '槽位不对'}`, 'error', 2400); return; }
    hit.apply();
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const src = source(e);
    if (!src || e.target.closest('.fit-info-btn')) return;
    const t = type(Number(src.dataset.fitType || src.dataset.fitDrag));
    if (!t || !DRAG_CATS.has(t.category)) return;
    pend = { t, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === 'touch', pop: src.closest('.fi-pop') };
    if (pend.touch) pend.timer = setTimeout(() => { if (pend) start(); }, 300);
  });
  document.addEventListener('pointermove', (e) => {
    if (drag) { move(e.clientX, e.clientY); return; }
    if (!pend || e.pointerId !== pend.id) return;
    const far = Math.hypot(e.clientX - pend.x, e.clientY - pend.y);
    if (pend.touch) { if (far > 10) { clearTimeout(pend.timer); pend = null; } return; }   // 触屏先移动了：是在滚动
    if (far > 6) { pend.x = e.clientX; pend.y = e.clientY; start(); }
  });
  document.addEventListener('pointerup', () => end(true));
  document.addEventListener('pointercancel', () => end(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) end(false); });
  document.addEventListener('touchmove', stopTouchScroll, { passive: false });
  // 拖完松手时的那次点击不算「点击添加」
  document.addEventListener('click', (e) => { if (eatClick) { e.stopPropagation(); e.preventDefault(); eatClick = false; } }, true);
  document.addEventListener('contextmenu', (e) => { if (drag || pend?.touch) e.preventDefault(); });
}

// ---------- 使用物品 ----------
function useType(id) {
  const t = type(id);
  if (!t) return;
  if (t.category === FE.CAT.ship) { setShip(id); if (MOBILE()) app.closeDrawer?.(); return; }
  if (!F.fit) { app.showToast('请先选择一艘舰船', 'info'); setTab('ship'); return; }
  if (t.category === FE.CAT.module || t.category === FE.CAT.subsystem) addModule(t);
  else if (t.category === FE.CAT.charge) loadCharge(t);
  else if (t.category === FE.CAT.drone) addDrone(t);
  else if (t.category === FE.CAT.fighter) addFighter(t);
  else if (t.category === FE.CAT.implant) addImplant(t);
  if (MOBILE()) app.closeDrawer?.();
}

const MOBILE = () => window.matchMedia('(max-width: 768px)').matches;
// 装备显示方式：list（按槽位分组的列表）/ radial（圆盘：舰船图在中间，槽位绕成一圈，和游戏装配窗口相似）
const VIEW_KEY = 'eve-fit-view';
const fitView = () => { try { return localStorage.getItem(VIEW_KEY) === 'radial' ? 'radial' : 'list'; } catch { return 'list'; } };

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
  // 点过某个空槽位：装到那一格
  if (F.target && F.target.slot === slot && slot !== 'sub') { putModule(t, slot, F.target.index); return; }
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
  const idx = freeIndex(slot);
  if (idx < 0) { app.showToast(`${FE.SLOT_NAME[slot]}已满`, 'error'); return; }
  // 同类武器自动装填与已装同型号相同的弹药
  const twin = list.find((m) => m && m.type === t.id && m.charge);
  if (twin) mod.charge = twin.charge;
  list[idx] = mod;
  F.selected = { slot, index: idx };
  recompute();
}

// 弹药页顶部那排：当前装配里要装弹药的装备（同型号只列一次）
function chargeModules() {
  if (!F.fit) return [];
  const seen = new Map();
  for (const { m } of fittedModules()) {
    const t = type(m.type);
    if (t && !seen.has(t.id) && FE.AT.chargeGroups.some((a) => t.attrs.get(a))) seen.set(t.id, { t, n: 0, charge: m.charge });
    if (seen.has(m.type)) seen.get(m.type).n++;
  }
  return [...seen.values()];
}
// 当前勾选的装备类型（已经不在装配里的不算）
function chargeForTypes() {
  if (!F.chargeFor.size || !F.fit) return [];
  const fitted = new Set(fittedModules().map(({ m }) => m.type));
  return [...F.chargeFor].filter((id) => fitted.has(id)).map(type).filter(Boolean);
}
// ids：Set / 数组 / 单个类型 ID（从装配里跳过来时只勾这一个）
function setChargeFor(ids) {
  F.chargeFor = new Set(ids == null ? [] : typeof ids === 'number' ? [ids] : ids);
  F.chargeShut.clear();
  F.queries.charge = '';
  if (F.tab === 'charge' && F.query) { F.query = ''; $('fitSearch').value = ''; }
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
  // 弹药页勾选了装备时：只装填勾上的、能用这种弹药的装备
  const sel = F.selected && F.fit.slots[F.selected.slot][F.selected.index];
  const ft = new Set(chargeForTypes().filter((m) => FE.chargeFits(m, t)).map((m) => m.id));
  const targets = ft.size ? mods.filter(({ m }) => ft.has(m.type))
    : sel && FE.chargeFits(type(sel.type), t) ? mods.filter(({ m }) => m.type === sel.type) : mods;
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
function autoActivateDrones(fit = F.fit) {
  const calc = FE.computeFit(F.data, fit, skills());
  const limit = calc.char.attr(FE.AT.maxActiveDrones);
  let bw = calc.ship.attr(FE.AT.droneBandwidth);
  let n = 0;
  let tubes = calc.ship.attr(FE.AT.fighterTubes);
  const role = { light: calc.ship.attr(FE.AT.fighterLightSlots), support: calc.ship.attr(FE.AT.fighterSupportSlots), heavy: calc.ship.attr(FE.AT.fighterHeavySlots) };
  for (const d of fit.drones.filter(isFighter)) {
    const t = type(d.type);
    const r = t.attrs.get(FE.AT.fighterIsHeavy) ? 'heavy' : t.attrs.get(FE.AT.fighterIsSupport) ? 'support' : 'light';
    d.active = 0;
    while (d.active < d.count && tubes > 0 && role[r] > 0) { d.active++; tubes--; role[r]--; }
  }
  for (const d of fit.drones.filter((x) => !isFighter(x))) {
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

// 空装配页的热门舰船宫格（舰船渲染大图），点一下开始装配
const HOT_SHIPS = [32880, 587, 593, 16240, 626, 621, 24698, 17715, 12005, 638, 645, 29984];
function shipGrid() {
  const ships = HOT_SHIPS.map((id) => type(id)).filter(Boolean);
  if (!ships.length) return '';
  return `<section class="fit-hot"><h4>热门舰船</h4><div class="fit-hot-grid">${ships.map((t) => `<button type="button" class="fit-hot-card" data-fit-pick-ship="${t.id}">
      <img src="${IMG(t.id, 'render', 256)}" alt="" width="256" height="256" loading="lazy" draggable="false"><span>${app.esc(t.name)}</span></button>`).join('')}</div></section>`;
}

// ---------- 中间：装配 ----------
function renderFit() {
  const box = $('fitMain');
  if (!F.data) return;
  if (!F.fit) {
    box.innerHTML = `<div class="fit-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="M12 22V12M4 7l8 5 8-5"/></svg>
      <h3><span class="desktop-only">从左侧选择一艘舰船开始装配</span><span class="mobile-only">选择一艘舰船开始装配</span></h3>
      <p class="mobile-only"><button class="btn btn-primary drawer-open-btn" data-open-drawer>打开舰船列表</button></p>
      <p class="fit-empty-tools"><button class="btn btn-ghost" data-fit-sim>战场模拟</button></p>
      <p>也可以 <button class="link-btn" data-fit-import>导入 EFT 文本</button>${app.hasEsiToken() ? '、<button class="link-btn" data-fit-esi-list>读取游戏内装配</button>、<button class="link-btn" data-fit-cur-ship>导入当前舰船</button>' : ''}${savedFits().length ? ` 或打开 <select class="plain-select" data-fit-open><option value="">我的装配…</option>${savedFits().map((f) => `<option value="${f.id}">${app.esc(f.name || type(f.ship)?.name || '未命名')}</option>`).join('')}</select>` : ''}</p>
      ${shipGrid()}
    </div>`;
    if (MOBILE() && !shipGrid()) app.openDrawer?.();   // 有热门舰船宫格时不自动弹出列表，直接点宫格
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
  // 「全部 5 级」时，绑定了角色就顺便对照角色技能，列出这套装配用到、角色还没练到 5 级的
  if (F.skillMode === 'max' && bound && !F.esi) loadEsiQuiet();
  const impact = F.skillMode === 'max' && bound && F.esi ? skillImpact() : null;
  const notFive = impact ? FE.missingSkills(F.data, F.fit, F.esi.levels, impact) : [];
  const gaps = missing.length ? missing : notFive;
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
          <button class="btn btn-ghost fit-plan-btn" data-fit-pz title="其他玩家在广场分享的这艘船的装配，也可以把当前装配发到广场">广场装配</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-graph title="有效 DPS 随距离、目标速度、信号半径变化的曲线（类似 Pyfa 的图表）">伤害图表</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-sim title="打开「战场模拟」页：两方舰队按装配模拟交战">战场模拟</button>
          <button class="btn btn-ghost fit-plan-btn" data-fit-skillplan title="按角色技能规划开这艘船、用好这套装配要练的技能">技能规划</button>
        </div>
        <div class="fit-action-row">
          <button class="btn btn-ghost" data-fit-new title="新建空装配">新建</button>
          <button class="btn btn-ghost" data-fit-import title="粘贴 EFT 格式文本">导入</button>
          <button class="btn btn-ghost" data-fit-export title="复制为 EFT 格式（可导入游戏或 Pyfa）">导出</button>
          <button class="btn btn-ghost" data-fit-share title="复制分享链接">分享</button>
          <button class="btn btn-ghost" data-fit-pz-post title="把当前装配发到广场「装配」分类，供其他玩家借鉴">分享到广场</button>
          <button class="btn btn-ghost" data-fit-cart title="舰船、装备、弹药、无人机和植入体加入购物车（突变装备按原装备 + 突变质体）">加入购物车</button>
          <button class="btn btn-ghost" data-fit-esi-list title="${bound ? '读取已绑定角色在游戏里保存的装配' : '需要先绑定 ESI'}"${bound ? '' : ' disabled'}>游戏装配</button>
          <button class="btn btn-ghost" data-fit-cur-ship title="${bound ? '读取角色现在开着的船和船上的装配（资产数据最多晚 1 小时）' : '需要先绑定 ESI'}"${bound ? '' : ' disabled'}>当前舰船</button>
          <button class="btn btn-ghost" data-fit-esi-save title="${bound ? '通过 ESI 保存到游戏装配窗口（个人装配）' : '需要先绑定 ESI'}"${bound ? '' : ' disabled'}>存到游戏</button>
          ${F.fit.id ? '<button class="btn btn-ghost danger" data-fit-delete title="删除已保存的装配">删除</button>' : ''}
        </div>
      </div>
    </div>
    <div class="fit-skillbar">
      <span>技能</span>
      <div class="segmented" role="group" aria-label="技能来源">
        <button data-fit-skill="max" class="${F.skillMode === 'max' ? 'active' : ''}">全部 5 级</button>
        <button data-fit-skill="custom" class="${F.skillMode === 'custom' ? 'active' : ''}" title="把影响这套装配的技能逐个设成想要的等级">自定义</button>
        <button data-fit-skill="esi" class="${F.skillMode === 'esi' ? 'active' : ''}"${bound ? '' : ' disabled title="需要先绑定 ESI"'}>${F.esi && F.skillMode === 'esi' ? app.esc(F.esi.name) + ' 的技能' : '按 ESI 角色'}</button>
      </div>
      <div class="segmented fit-view-seg" role="group" aria-label="装备显示方式">
        <button data-fit-view="list" class="${fitView() === 'list' ? 'active' : ''}">列表</button>
        <button data-fit-view="radial" class="${fitView() === 'radial' ? 'active' : ''}">圆盘</button>
      </div>
      <span class="fit-bulk"><button class="link-btn" data-fit-all="on" title="主动装备全部激活">全部开启</button><button class="link-btn" data-fit-all="off" title="主动装备全部停用">全部关闭</button><button class="link-btn danger" data-fit-clear title="清空全部装备、弹药和无人机">清空装备</button></span>
      ${F.skillMode === 'custom' ? `<button type="button" class="btn btn-ghost btn-sm" data-fit-csk-open>设置技能等级${(() => { const lv = customLevels(); const n = [...new Set([...(CIMPACT.set || []), ...requiredLevels().keys()])].filter((id) => (lv.get(id) ?? 5) < 5).length; return n ? `（${n} 项低于 5 级）` : ''; })()}</button>` : ''}
      ${missing.length ? skillPop(missing, `缺少 ${missing.length} 项技能`, '缺少的技能')
        : notFive.length ? skillPop(notFive, `还有 ${notFive.length} 项没到 5 级`, `${F.esi.name} 还没到 5 级的技能`)
        : F.skillMode === 'esi' && F.esi ? '<span class="fit-ok">技能满足</span>' : impact ? '<span class="fit-ok">影响属性的技能都已 5 级</span>' : ''}
    </div>
    ${modeHtml()}
    ${fitView() === 'radial' ? radialHtml(shipType, st) : problemsHtml(st.problems) + slotRows}
    ${dronesHtml()}
    ${implantsHtml(bound)}
    ${cloudHtml()}
    ${envHtml()}
    ${fleetHtml()}
    ${gaps.length ? `<section class="fit-slots"><h4>${missing.length ? '缺少的技能' : '还没到 5 级的技能'}<span>${gaps.length}</span></h4><div class="fit-skill-list">${gaps.map((m) => `<span>${app.esc(m.type?.name || '')} <b>${m.have} → ${m.need}</b> ${spText(spGap(m))}</span>`).join('')}</div></section>` : ''}`;
}

// 练到需要的等级还差多少技能点（每级累计 250 × 倍数 × √32^(等级-1)；已有技能点含正在练的那一级的进度）
const spForLevel = (rank, level) => (level <= 0 ? 0 : Math.ceil(250 * rank * Math.pow(Math.sqrt(32), level - 1)));
function spGap(m) {
  const rank = m.type?.attrs?.get(275) || 1;
  const have = Math.max(spForLevel(rank, m.have), F.esi?.sp?.get(m.type?.id) || 0);
  return Math.max(0, spForLevel(rank, m.need) - have);
}
const spText = (n) => (n >= 1e6 ? `${fmt(n / 1e6, 2)}M` : n >= 1e3 ? `${fmt(n / 1e3, 0)}k` : String(n));
// 技能缺口的标签：鼠标移上去（或键盘聚焦）弹出列表
function skillPop(list, label, title) {
  const items = list.map((m) => ({ ...m, gap: spGap(m) })).sort((a, b) => b.gap - a.gap);
  const total = items.reduce((a, m) => a + m.gap, 0);
  const rows = items.map((m) => `<span class="fit-skill-line"><span>${app.esc(m.type?.name || String(m.type))}</span><span class="fit-skill-lv">${'<i class="on"></i>'.repeat(m.have)}${'<i></i>'.repeat(m.need - m.have)}<em>${m.have} → ${m.need}</em><small>${spText(m.gap)}</small></span></span>`).join('');
  return `<span class="fit-skill-pop" tabindex="0"><span class="fit-missing">${label} · 差 ${spText(total)} 技能点</span><span class="fit-skill-card" role="tooltip"><b>${app.esc(title)}<span>共差 ${fmt(total, 0)} 技能点</span></b>${rows}</span></span>`;
}

// 曙光云计算：选择放进「云」的舰船，同船级（T1 / T2 / 帝国海军型还要同种族）的舰船获得它们的云计算技能加成；带宽上限 100，装满即止
// 舰船模式（战术驱逐舰、贼鸥号、蛇鹈号）：同时只处在一个模式，图标取自游戏舰船界面的模式按钮
const MODE_ICON = ['defense', 'sharpshooter', 'propulsion'];
function modeHtml() {
  const list = F.data.modes.get(F.fit.ship) || [];
  if (!list.length) return '';
  const cur = FE.modeOf(F.data, F.fit);
  return `<section class="fit-slots"><h4>舰船模式<span>驾驶时 Shift + 1 / 2 / 3 切换</span></h4>
    <div class="segmented fit-modes" role="group" aria-label="舰船模式">${list.map((id, k) => (id ? `<button type="button" data-fit-mode="${id}" class="${id === cur ? 'active' : ''}" aria-pressed="${id === cur}"><i class="fit-mode-ic is-${MODE_ICON[k]}"></i>${app.esc(FE.modeLabel(F.data, id))}</button>` : '')).join('')}</div></section>`;
}
function cloudHtml() {
  if (!F.data.cloud?.size) return '';
  const info = FE.cloudInfo(F.data, F.fit.ship);
  const used = info.reduce((n, c) => n + c.bw, 0);
  const inCloud = new Set(info.map((c) => c.ship.id));
  const byClass = new Map();
  for (const id of F.data.cloud.keys()) {
    const t = type(id);
    if (!t || inCloud.has(id)) continue;
    const g = F.data.groups.get(t.group)?.name || '';
    if (!byClass.has(g)) byClass.set(g, []);
    byClass.get(g).push(t);
  }
  const options = [...byClass].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([g, list]) => `<optgroup label="${app.esc(g)}">${list.sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((t) => { const bw = F.data.cloud.get(t.id).bw; return `<option value="${t.id}"${used + bw > CLOUD_BW ? ' disabled' : ''}>${app.esc(t.name)}（带宽 ${bw}）</option>`; }).join('')}</optgroup>`).join('');
  const rows = info.map((c) => `<div class="fit-slot fit-cloud-row"><img src="${IMG(c.ship.id)}" alt="" width="28" height="28" loading="lazy"><span class="fit-slot-name">${app.esc(c.ship.name)}<small>带宽 ${c.bw}</small></span>
    <span class="fit-cloud-skills">${c.skills.map((k) => `<span class="${k.active ? 'is-on' : ''}" title="${cloudScope(k)}"><i>${app.esc(k.type?.name || '')}</i><b>${k.active ? '生效' : '不适用'}</b></span>`).join('')}</span>
    ${infoBtn(c.ship.id)}<button class="fit-remove" data-fit-cloud-remove="${c.ship.id}" aria-label="移除">×</button></div>`).join('');
  return `<section class="fit-slots"><h4>云计算<span class="${used > CLOUD_BW ? 'is-over' : ''}">带宽 ${used} / ${CLOUD_BW}${used > CLOUD_BW ? '（超出）' : ''}</span></h4>
    ${rows}<div class="fit-slot is-empty"><select class="plain-select" data-fit-cloud-add aria-label="加入云计算的舰船"><option value="">${used >= CLOUD_BW ? '带宽已满' : `加入云计算的舰船…（剩余带宽 ${CLOUD_BW - used}）`}</option>${options}</select></div></section>`;
}

// 天象：星系环境（虫洞 / 超阈限风暴 / 三神裔入侵等，同时只有一个）、泰坦天象发生器、主权稳定发生器（同时只有一个）、势力战争与活动效果
// 选中的对所有装配生效（智能装配、战场模拟也按它算）
const ENV_CATS = [['wh', '虫洞'], ['storm', '超阈限风暴'], ['abyss', '深渊天气'], ['space', '星系环境'], ['titan', '泰坦天象发生器'], ['sov', '主权升级'], ['fw', '势力战争'], ['event', '活动']];
const ENV_ONE = { wh: 'system', storm: 'system', abyss: 'system', space: 'system', sov: 'sov' };   // 同组只能选一个，选新的替换旧的
const ENV_SHOW = 6;   // 效果超过这么多条时折叠
const envOpen = new Set();
const envName = (e) => (window.I18N?.lang === 'en' ? e.en || e.name : e.name);
function envHtml() {
  if (!F.data.env?.size) return '';
  const en = window.I18N?.lang === 'en';
  const info = FE.envInfo(F.data, F.fit.ship);
  const chosen = new Set(info.map((e) => e.id));
  const catName = Object.fromEntries(ENV_CATS);
  const rows = info.map((e) => {
    const desc = e.desc.map((d) => d[en ? 1 : 0]);
    const all = envOpen.has(e.id) || desc.length <= ENV_SHOW + 1;
    return `<div class="fit-slot fit-cloud-row fit-env-row"><span class="fit-env-cat">${catName[e.cat] || ''}</span><span class="fit-slot-name" translate="no">${app.esc(envName(e))}</span>
    <span class="fit-env-state${e.active ? ' is-on' : ''}">${e.active ? '生效' : '不适用'}</span>
    <span class="fit-cloud-skills fit-env-desc" translate="no">${(all ? desc : desc.slice(0, ENV_SHOW)).map((d) => `<span>${app.esc(d)}</span>`).join('')}${all ? '' : `<button type="button" class="link-btn" data-fit-env-more="${e.id}">另 ${desc.length - ENV_SHOW} 项</button>`}</span>
    <button class="fit-remove" data-fit-env-remove="${e.id}" aria-label="移除">×</button></div>`;
  }).join('');
  const byCat = new Map(ENV_CATS.map(([k]) => [k, []]));
  for (const e of F.data.env.values()) if (!chosen.has(e.id)) byCat.get(e.cat)?.push(e);
  const options = ENV_CATS.filter(([k]) => byCat.get(k).length).map(([k, l]) => `<optgroup label="${l}">${byCat.get(k)
    .sort((a, b) => envName(a).localeCompare(envName(b), en ? 'en' : 'zh')).map((e) => `<option value="${e.id}">${app.esc(envName(e))}</option>`).join('')}</optgroup>`).join('');
  return `<section class="fit-slots"><h4>天象<span>${info.length ? `${info.length} 项 · 对所有装配生效` : '虫洞、风暴、泰坦天象发生器、主权升级、活动'}</span></h4>
    ${rows}<div class="fit-slot is-empty"><select class="plain-select" data-fit-env-add aria-label="添加天象"><option value="">添加天象…</option>${options}</select></div></section>`;
}
function saveEnv(ids) {
  FE.setEnv(ids);
  app.store.setJSON(ENV_KEY, ids);
  recompute();
}
function addEnv(id) {
  const e = F.data.env.get(id);
  if (!e) return;
  const one = ENV_ONE[e.cat];
  saveEnv([...FE.getEnv().filter((x) => { const o = F.data.env.get(x); return o && (!one || ENV_ONE[o.cat] !== one); }), id]);
}

// 舰队加成：舰队里别人开的指挥脉冲波（满技能；强度可选指挥舰 / 全部舰船里最强（旗舰）/ 普通船，前两档带心灵链接）
// 本船自己开着、装了弹药的脉冲波也对自己生效；同一种加成只取最强的
const FLEET_MODES = [['cs', '指挥舰'], ['max', '最强'], ['basic', '普通船']];
const FLEET_MODE_TIP = { cs: '指挥舰 + 心灵链接，满技能（采矿、远征按能给的最强舰船）', max: '全部舰船里最强（多为旗舰）+ 心灵链接，满技能', basic: '没有舰船加成、不带心灵链接，满技能' };
function fleetHtml() {
  if (!F.data.dbuffs?.size) return '';
  const list = FE.getFleet();
  const own = F.fit.slots.high.filter((m) => m && m.charge && m.state === 'active' && type(m.type)?.group === FE.BURST_GROUP).length;
  const rows = list.map(([c, mode], i) => {
    const b = FE.fleetBoost(F.data, c, mode);
    const by = b ? [type(b.ship)?.name, b.link && type(b.link)?.name].filter(Boolean).join(' + ') : '';
    return `<div class="fit-slot fit-cloud-row fit-env-row"><img src="${IMG(c)}" alt="" width="28" height="28" loading="lazy"><span class="fit-slot-name">${app.esc(type(c)?.name || '')}${by ? `<small title="按这艘船给的加成计算">${app.esc(by)}</small>` : ''}</span>
    <div class="segmented fit-fleet-mode" role="group" aria-label="加成强度">${FLEET_MODES.map(([k, l]) => `<button type="button" data-fit-fleet-mode="${i}" data-v="${k}" class="${mode === k ? 'active' : ''}" title="${FLEET_MODE_TIP[k]}">${l}</button>`).join('')}</div>
    <span class="fit-cloud-skills fit-env-desc" translate="no">${FE.buffText(F.data, b?.buffs || []).map((d) => `<span>${app.esc(d)}</span>`).join('')}</span>
    <button class="fit-remove" data-fit-fleet-remove="${i}" aria-label="移除">×</button></div>`;
  }).join('');
  const chosen = new Set(list.map(([c]) => c));
  const groups = new Map(FE.BURST_CHARGES.map((g) => [g, []]));
  for (const t of F.data.types.values()) if (t.market && groups.has(t.group) && !chosen.has(t.id)) groups.get(t.group).push(t);
  const options = [...groups].filter(([, l]) => l.length).map(([g, l]) => `<optgroup label="${app.esc(F.data.groups.get(g)?.name || '')}">${l.map((t) => `<option value="${t.id}">${app.esc(t.name)}</option>`).join('')}</optgroup>`).join('');
  return `<section class="fit-slots"><h4>舰队加成<span>${own ? `本船开着 ${own} 个指挥脉冲波，也计入 · ` : ''}同种加成取最强</span></h4>
    ${rows}<div class="fit-slot is-empty"><select class="plain-select" data-fit-fleet-add aria-label="添加指挥脉冲波加成"><option value="">添加指挥脉冲波加成…</option>${options}</select></div></section>`;
}
function saveFleet(list) {
  FE.setFleet(list);
  app.store.setJSON(FLEET_KEY, list);
  recompute();
}

// 云计算技能的生效对象：写明了船级的按船级（不分种族），否则同船级
const HULL_ZH = { Frigate: '护卫舰', Destroyer: '驱逐舰', Cruiser: '巡洋舰', Battlecruiser: '战列巡洋舰', Battleship: '战列舰', Industrial: '工业舰', Freighter: '货舰', Carrier: '航空母舰', Dreadnought: '无畏舰', Titan: '泰坦', Colossus: '巨像', 'Strategic Cruiser': '战略巡洋舰', 'Tactical Destroyer': '战术驱逐舰' };
const cloudScope = (k) => k.cls === '*' ? '全部舰船' : k.cls ? k.cls.map((c) => HULL_ZH[c] || c).join(' · ') : k.every ? '同船级全部种族' : '同船级同种族';

function saveCloud(ids) {
  FE.setCloud(ids);
  app.store.setJSON(CLOUD_KEY, ids);
  recompute();
}

function problemsHtml(list) {
  if (!list.length) return '';
  return `<div class="fit-problems">${list.map((p) => `<p class="is-${p.level}">${app.esc(p.text)}</p>`).join('')}</div>`;
}

function moduleRow(slot, index, m, extra) {
  const pv = F.preview && F.preview.slot === slot && F.preview.index === index ? type(F.preview.type) : null;
  if (pv) return `<div class="fit-slot is-ghost"><img src="${IMG(pv.id)}" alt="" width="28" height="28"><span class="fit-slot-name"><span class="fit-slot-title">${app.esc(pv.name)}</span></span></div>`;
  const target = F.target && F.target.slot === slot && F.target.index === index;
  const empty = `<div class="fit-slot is-empty${extra ? ' is-extra' : ''}${target ? ' is-target' : ''}" data-fit-empty="${slot}" data-fit-idx="${index}"><span class="fit-slot-icon"></span><span>${extra ? '超出槽位' : target ? (MOBILE() ? '在列表里选择要装进这一格的装备' : '在左侧选择要装进这一格的装备') : '空' + FE.SLOT_NAME[slot]}</span></div>`;
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
    <span class="fit-slot-name"><span class="fit-slot-title">${app.esc(t.name)}${m.mut ? `<em class="fit-mut-tag" title="${app.esc(MU.mutSummary(m))}">突变</em>` : MU.isBareAbyssal(m) ? '<em class="fit-mut-tag warn" title="来自游戏装配或击杀邮件，没有突变属性，按原装备（优先科技 II）的属性计算">未设属性</em>' : ''}</span>${item && moduleNote(item) ? `<small>${moduleNote(item)}</small>` : ''}</span>
    ${!fixed && MU.canMutate(m) ? `<button class="fit-mut-btn${m.mut ? ' on' : ''}" data-fit-mut="${slot}:${index}" title="${m.mut ? '修改突变属性' : '突变成深渊装备并自定义属性'}">${m.mut ? '改属性' : '突变'}</button>` : ''}
    ${ct ? `<span class="fit-charge" title="${app.esc(ct.name)} × ${FE.chargeCount(t, ct)}"><img src="${IMG(ct.id)}" alt="" width="20" height="20" loading="lazy">${app.esc(shortName(ct.name))}<button data-fit-uncharge="${slot}:${index}" aria-label="卸下弹药">×</button></span>`
      : needsCharge ? `<button class="fit-charge is-empty" data-fit-pick-charge="${slot}:${index}">装填弹药</button>` : ''}
    ${olBtn}${stateBtn}${infoBtn(t.id)}
    <button class="fit-remove" data-fit-remove="${slot}:${index}" title="移除" aria-label="移除">×</button>
  </div>`;
}

// 圆盘视图（和游戏装配窗口相似）：舰船渲染图铺满圆心，外面一圈半透明黑色环带，每个槽位是环带上的一块扇形；高槽在上、中槽在右、低槽在下、改装件和子系统在左。在线的装备扇形是绿色，激活更亮，超载橙色，离线灰色。
// 最外一圈细黑环上：左边 CPU、右边能量栅格、下边校准值的刻度条，右上 / 左上的小圆点是发射器 / 炮台安装座（实心 = 已用）。
// 装备和弹药图标都正着放（不跟着圆周转，否则右边横着、下面倒着）。整个圆盘是一个 SVG；槽位是 <g data-fit-mod / data-fit-empty>，点击、拖放沿用列表的逻辑（点装备选中，点空槽在左侧选装备）。
// 选中的装备在圆盘下面显示完整的一行（状态、超载、弹药、突变、移除）。超限警告也放在圆盘下面，出现 / 消失时圆盘不会上下跳。
const RG = { c: 256, ship: 226, band: 196, bandW: 50, tileIn: 173, tileOut: 219, outer: 239, step: 11.5, tile: 10.4 };
const RADIAL_START = { high: null, mid: -38, low: 52, rig: 148, sub: 190 };   // 各组第一个槽位的理想起始角度（顺时针，3 点钟为 0）；高槽以正上方居中
// 槽位排布：先按理想角度放，和前一组挨上就顺延，绕一圈撞到高槽就从后往前挤；还放不下（T3 巡洋舰装满子系统后槽位很多）就整体缩小格子再排。
// 返回 { k: 缩放, start: { 组: 起始角度 } }
function radialLayout(counts) {
  const order = FE.SLOTS.filter((x) => counts[x] > 0);
  const GAP = 3;
  for (let k = 1; k > 0.4; k *= 0.96) {
    const step = RG.step * k, tile = RG.tile * k;
    const span = (x) => (counts[x] - 1) * step + tile;
    const start = {};
    let prevEnd = null, first = null;
    for (const x of order) {
      let a = x === 'high' ? -90 - span(x) / 2 : RADIAL_START[x] ?? -90;
      if (first != null) { while (a < first) a += 360; if (prevEnd != null && a < prevEnd + GAP) a = prevEnd + GAP; }
      start[x] = a;
      if (first == null) first = a;
      prevEnd = a + span(x);
    }
    // 最后一组越过了第一组（绕一圈）：从后往前挤
    let limit = first + 360 - GAP;
    for (let i = order.length - 1; i > 0; i--) {
      const x = order[i];
      if (start[x] + span(x) > limit) start[x] = limit - span(x);
      limit = start[x] - GAP;
    }
    const ok = order.every((x, i) => i === 0 || start[x] >= start[order[i - 1]] + span(order[i - 1]) + GAP - 1e-6);
    if (ok) return { k, start };
  }
  return { k: 0.4, start: Object.fromEntries(order.map((x, i) => [x, -90 + i * 72])) };
}
const rad = (a) => a * Math.PI / 180;
const pt = (r, a) => [RG.c + r * Math.cos(rad(a)), RG.c + r * Math.sin(rad(a))];
const f2 = (v) => v.toFixed(2);
function sector(r0, r1, a0, a1) {
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${f2(x0)} ${f2(y0)}A${r1} ${r1} 0 0 1 ${f2(x1)} ${f2(y1)}L${f2(x2)} ${f2(y2)}A${r0} ${r0} 0 0 0 ${f2(x3)} ${f2(y3)}Z`;
}
function arcPath(r, a0, a1) {
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
  return `M${f2(x0)} ${f2(y0)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${f2(x1)} ${f2(y1)}`;
}
// 外环上的资源刻度条：从 a0 填到 a1 方向，按比例
function gauge(kind, label, v, a0, a1, unit) {
  const pct = v.total ? Math.min(1, v.used / v.total) : (v.used ? 1 : 0);
  const over = v.used > v.total + 1e-6;
  const tip = `${label} ${fmt(v.used, 1)} / ${fmt(v.total, 1)}${unit}`;
  return `<g class="fr-gauge fr-g-${kind}${over ? ' is-over' : ''}"><title>${tip}</title>
    <path class="fr-g-base" d="${arcPath(RG.outer, a0, a1)}"/>
    ${pct > 0 ? `<path class="fr-g-fill" d="${arcPath(RG.outer, a0, a0 + (a1 - a0) * pct)}"/>` : ''}</g>`;
}
function hardpoints(kind, label, v, a0, dir) {
  if (!v.total && !v.used) return '';
  const n = Math.max(v.total, v.used);
  let dots = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(RG.outer, a0 + dir * i * 3.6);
    dots += `<circle cx="${f2(x)}" cy="${f2(y)}" r="3.4" class="${i < v.used ? (i >= v.total ? 'is-over' : 'is-used') : ''}"/>`;
  }
  return `<g class="fr-hp fr-hp-${kind}"><title>${label} ${v.used} / ${fmt(v.total)}</title>${dots}</g>`;
}
function radialHtml(shipType, st) {
  const r = st.resources;
  const tiles = [];
  const counts = Object.fromEntries(FE.SLOTS.map((s) => [s, Math.max(st.slots[s] || 0, F.fit.slots[s].length)]));
  const L = radialLayout(counts);
  for (const s of FE.SLOTS) {
    const total = st.slots[s] || 0;
    const list = F.fit.slots[s];
    for (let i = 0; i < counts[s]; i++) tiles.push(radialSlot(s, i, list[i], i >= total, L.start[s] + i * RG.step * L.k, L.k));
  }
  const sel = F.selected && F.fit.slots[F.selected.slot]?.[F.selected.index] ? F.selected : null;
  return `<section class="fit-radial-wrap">
    <div class="fit-radial">
      <svg viewBox="0 0 512 512" class="fr-svg">
        <defs>
          <clipPath id="frShipClip"><circle cx="256" cy="256" r="${RG.ship}"/></clipPath>
          <radialGradient id="frVignette" cx="50%" cy="50%" r="50%"><stop offset="72%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/></radialGradient>
        </defs>
        <image href="${IMG(shipType.id, 'render', 512)}" x="${256 - RG.ship}" y="${256 - RG.ship}" width="${RG.ship * 2}" height="${RG.ship * 2}" clip-path="url(#frShipClip)" preserveAspectRatio="xMidYMid slice"/>
        <circle cx="256" cy="256" r="${RG.ship}" fill="url(#frVignette)"/>
        <circle cx="256" cy="256" r="${RG.band}" class="fr-band" stroke-width="${RG.bandW}"/>
        <circle cx="256" cy="256" r="${RG.outer}" class="fr-outer"/>
        ${gauge('cpu', 'CPU', r.cpu, 140, 220, ' tf')}
        ${gauge('power', '能量栅格', r.power, 40, -40, ' MW')}
        ${r.calibration.total ? gauge('cal', '校准值', r.calibration, 112, 68, '') : ''}
        ${hardpoints('launcher', '发射器安装座', r.launchers, -72, 1)}
        ${hardpoints('turret', '炮台安装座', r.turrets, -108, -1)}
        ${tiles.join('')}
      </svg>
    </div>
    <div class="fit-radial-legend"><span><i class="lg-cpu"></i>CPU ${fmt(r.cpu.used, 1)} / ${fmt(r.cpu.total, 1)}</span><span><i class="lg-power"></i>能量栅格 ${fmt(r.power.used, 1)} / ${fmt(r.power.total, 1)}</span>${r.calibration.total ? `<span><i class="lg-cal"></i>校准值 ${fmt(r.calibration.used, 0)} / ${fmt(r.calibration.total, 0)}</span>` : ''}</div>
    ${problemsHtml(st.problems)}
    <div class="fit-radial-sel">${sel ? moduleRow(sel.slot, sel.index, F.fit.slots[sel.slot][sel.index], sel.index >= (st.slots[sel.slot] || 0)) : `<p class="fit-radial-tip">${MOBILE() ? '点圆盘上的装备调整状态、弹药或移除；点空槽添加装备' : '点圆盘上的装备调整状态、弹药或移除；点空槽后在左侧选装备，也可以直接拖到槽位上'}</p>`}</div>
  </section>`;
}
function radialSlot(slot, index, m, extra, a0, k = 1) {
  const a1 = a0 + RG.tile * k, mid = (a0 + a1) / 2;
  const d = sector(RG.tileIn, RG.tileOut, a0, a1);
  const target = F.target && F.target.slot === slot && F.target.index === index;
  // 左侧装备悬停预览：和列表视图一样，把它淡淡地放进点击后会装进的那一格（灰色）
  const pv = F.preview && F.preview.slot === slot && F.preview.index === index ? type(F.preview.type) : null;
  if (pv) {
    const [gx, gy] = pt((RG.tileIn + RG.tileOut) / 2 + 1, mid);
    const g = 40 * Math.min(1, k + 0.08);
    return `<g class="fr-slot fr-ghost"><path class="fr-tile" d="${d}"/><image class="fr-icon" href="${IMG(pv.id, 'icon', 64)}" x="${f2(gx - g / 2)}" y="${f2(gy - g / 2)}" width="${f2(g)}" height="${f2(g)}"/></g>`;
  }
  if (!m) return `<g class="fr-slot is-empty${extra ? ' is-error' : ''}${target ? ' is-target' : ''}" data-fit-empty="${slot}" data-fit-idx="${index}" role="button" tabindex="0"><title>${extra ? '超出槽位' : '空' + FE.SLOT_NAME[slot]}</title><path class="fr-tile" d="${d}"/></g>`;
  const t = type(m.type);
  const item = F.calc.modules.find((q) => q.slot === slot && q.index === index);
  const err = extra || F.stats.problems.some((q) => q.module === item && q.level === 'error');
  const sel = F.selected && F.selected.slot === slot && F.selected.index === index;
  const ct = m.charge && type(m.charge);
  const [ix, iy] = pt((RG.tileIn + RG.tileOut) / 2 + 1, mid);
  const S = 40 * Math.min(1, k + 0.08);   // 格子缩小时图标跟着缩，不压到隔壁
  let charge = '';
  if (ct) {
    const [cx, cy] = pt(RG.tileIn - 15, mid);
    charge = `<image href="${IMG(ct.id)}" x="${f2(cx - 10)}" y="${f2(cy - 10)}" width="20" height="20" class="fr-charge"/>`;
  }
  // 和原版一样：被动装备在格子四角画小三角，主动装备在格子内沿画一条梯形；颜色随状态（灰 = 在线，绿 = 激活，红 = 超载，离线整体变暗）
  const marks = t.activatable ? activeBar(a0, a1) : passiveMarks(a0, a1);
  const st = m.state === 'overload' ? 'overload' : m.state === 'active' ? 'active' : m.state === 'offline' ? 'offline' : 'online';
  return `<g class="fr-slot fr-mod is-${st}${sel ? ' is-selected' : ''}${err ? ' is-error' : ''}" data-fit-mod="${slot}:${index}" role="button" tabindex="0" aria-label="${app.esc(t.name)}${ct ? ' · ' + app.esc(ct.name) : ''}">
    <path class="fr-tile" d="${d}"/>${marks}
    <image class="fr-icon" href="${IMG(t.id, 'icon', 64)}" x="${f2(ix - S / 2)}" y="${f2(iy - S / 2)}" width="${S}" height="${S}"/>${charge}${radialActs(slot, index, m, t, a0, a1)}</g>`;
}
const poly = (pts) => `M${pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join('L')}Z`;
// 主动装备：内沿中间一条梯形（底边贴着内弧）
function activeBar(a0, a1) {
  const r0 = RG.tileIn + 1.5, r1 = RG.tileIn + 6;
  return `<path class="fr-mark" d="${poly([pt(r0, a0 + 1.3), pt(r1, a0 + 2.7), pt(r1, a1 - 2.7), pt(r0, a1 - 1.3)])}"/>`;
}
// 被动装备：四个角各一个小三角
function passiveMarks(a0, a1) {
  const dIn = 1.8, len = 5.5;
  const tri = (r, dir, a, side) => {   // r：所在弧的半径，dir：往格子里的方向（+1 向外 / -1 向内），a：角所在的边，side：沿弧往格子里的方向
    const rr = r + dir * dIn, aa = a + side * (dIn / r) * 57.3;
    return poly([pt(rr, aa), pt(rr, aa + side * (len / r) * 57.3), pt(rr + dir * len * 0.55, aa)]);
  };
  return `<path class="fr-mark" d="${tri(RG.tileOut, -1, a0, 1)}${tri(RG.tileOut, -1, a1, -1)}${tri(RG.tileIn, 1, a0, 1)}${tri(RG.tileIn, 1, a1, -1)}"/>`;
}
// 悬停（或选中）时，从槽位往圆心方向竖排浮出的小图标（和原版圆盘一致）：卸下装备、卸下弹药（有弹药时）、离线 / 上线。
// 图标始终正立；点击沿用列表的 data-fit-remove / data-fit-uncharge，离线切换用 data-fit-offline
const RA_ICON = {
  remove: '<path d="M-0.9 -2.9A4.4 4.4 0 1 1 -0.9 2.9M3.2 0H-5.6M-3.6 -2L-5.6 0L-3.6 2" class="fr-act-line"/>',
  uncharge: '<path d="M-0.9 -2.9A4.4 4.4 0 1 1 -0.9 2.9M-1.6 0H-5.6M-3.6 -2L-5.6 0L-3.6 2" class="fr-act-line"/><path d="M2.1 2.1V-0.5Q2.1 -2.4 2.9 -2.9Q3.7 -2.4 3.7 -0.5V2.1Z" class="fr-act-fill"/>',
  offline: '<path d="M0 -5.2V-0.6M-2.9 -3.6A4.6 4.6 0 1 0 2.9 -3.6" class="fr-act-line fr-act-pw"/>',
};
function radialActs(slot, index, m, t, a0, a1) {
  const ref = `${slot}:${index}`;
  const acts = [['remove', '卸下装备']];
  if (m.charge) acts.push(['uncharge', '卸下弹药']);
  if (slot !== 'rig' && slot !== 'sub') acts.push(['offline', m.state === 'offline' ? '上线' : '离线']);
  const mid = (a0 + a1) / 2;
  // 透明的扇形垫在图标列下面，鼠标从槽位移到图标上时不会中途丢掉悬停
  const pad = `<path class="fr-act-pad" d="${sector(RG.tileIn - 16 - (acts.length - 1) * 13, RG.tileIn + 1, a0, a1)}"/>`;
  return `<g class="fr-acts">${pad}${acts.map(([k, label], i) => {
    const [x, y] = pt(RG.tileIn - 9 - i * 13, mid);
    return `<g class="fr-act" data-fit-${k}="${ref}" transform="translate(${f2(x)} ${f2(y)})"><title>${label}</title><circle r="6.6" class="fr-act-hit"/>${RA_ICON[k]}</g>`;
  }).join('')}</g>`;
}

function shortName(name) {
  return name.length > 14 ? name.slice(0, 13) + '…' : name;
}

// 装备行下的小字：武器 DPS 与射程，或修理量
function moduleNote(item) {
  const w = F.stats.weapons.find((x) => x.module === item);
  if (w) return `${w.dps.toFixed(1)} DPS · ${dist(w.range)}${w.falloff ? ' + ' + dist(w.falloff) : ''}`;
  // 采矿器：最终数值（含突变、晶体、技能、船体、舰队脉冲）
  const mn = F.stats.mining.miners.find((x) => x.module === item);
  if (mn) return `单次 ${fmt(mn.amount)} m³ · 循环 ${mn.cycle.toFixed(1)} 秒 · ${mn.yps.toFixed(1)} m³/s`;
  // 探针发射器：装填探针的扫描强度（手机上没有悬停提示，直接写在行里）
  if (item.type.group === PROBE_LAUNCHER_GROUP && item.charge?.attr(AT_PROBE_STRENGTH)) return `扫描强度 ${Math.round(item.charge.attr(AT_PROBE_STRENGTH))} 点`;
  return '';
}

// 探针发射器（游戏 const.groupScanProbeLauncher）与探针的扫描强度属性（baseSensorStrength，已算技能、发射器、改装件、植入体、舰船加成）
const PROBE_LAUNCHER_GROUP = 481, AT_PROBE_STRENGTH = 1371;

// 已装配的主动装备（开启 / 超载时）悬停显示最终属性（含技能、舰船、超载与舰队加成），和游戏里装备栏的悬停提示一样
// 只列这件装备本身带的效果属性；伤害只在装备自身有伤害时显示（末日武器、立体炸弹），炮台导弹另显示 DPS
const TIP_ATTRS = [114, 118, 117, 116, 64, 51, 54, 158, 160, 99, 2263, 2279, 2264, 2265, 2280, 1839, 2262, 2259, 2260, 2428, 2427, 105, 20, 796, 554, 97, 90, 68, 84, 83, 67, 309, 566, 238, 239, 240, 241, 984, 987, 986, 985, 1034, 77, 73, 6, 714, 1795];
async function modTipHtml(ref) {
  if (!F.fit || !F.calc) return '';
  const { slot, index } = parseRef(ref);
  const m = F.fit.slots[slot]?.[index];
  const t = m && type(m.type);
  // 探针发射器和游戏一样不管开没开都显示（游戏装备栏悬停提示里的扫描强度）
  const probe = t?.group === PROBE_LAUNCHER_GROUP && m.charge;
  if (!t || (t.activatable && m.state !== 'active' && m.state !== 'overload' && !probe)) return '';
  const item = F.calc.modules.find((x) => x.slot === slot && x.index === index);
  if (!item) return '';
  const names = await dogmaNames();
  if (!t.activatable) return passiveTipHtml(t, m, item, names);
  const rows = [];
  const w = F.stats.weapons.find((x) => x.module === item);
  if (w) rows.push(['DPS', w.dps.toFixed(1)], ['齐射伤害', app.formatNumber(Math.round(w.volley))]);
  // 导弹、末日武器（审判之日等）的射程不在装备属性里：导弹按弹药算，末日武器为锁定距离
  if (w && !t.attrs.get(FE.AT.maxRange)) rows.push(['射程', dist(w.range)]);
  for (const a of TIP_ATTRS) {
    if (!t.attrs.get(a) || !names.attrs[a]) continue;
    // 末日武器的「最大速度加成 -100%」就是开火后无法移动，改看「无法移动持续时间」
    if (a === 20 && t.attrs.get(2428)) continue;
    const v = item.attr(a);
    if (!v) continue;
    const [label, unit, highGood] = names.attrs[a];
    // 和装备基础属性比：变好标绿、变差标红。基础值为负的（减速、抗性加成、感应抑阻等）绝对值越大越强
    const base = t.attrs.get(a);
    const better = base < 0 ? Math.abs(v) > Math.abs(base) : highGood ? v > base : v < base;
    const cls = Math.abs(v - base) <= Math.abs(base) * 1e-6 ? '' : better ? 'is-up' : 'is-down';
    const fuel = a === 714 && type(item.attr(713));
    // 长枪 / 收割者等持续伤害的末日武器：装备上的伤害是每跳伤害
    const tick = FE.DAMAGE.includes(a) && t.attrs.get(2264) ? '（每跳）' : '';
    rows.push([fuel ? `${label}（${fuel.name}）` : label + tick, unit === 1 ? dist(v) : fuel ? app.formatNumber(v) : infoValue(a, v, unit, names.units), cls]);
  }
  const probeHtml = probe && item.charge ? probeTipHtml(item.charge, names) : '';
  if (!rows.length && !probeHtml) return '';
  const dl = (list) => `<dl>${list.map(([k, v, cls]) => `<dt>${app.esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
  return `<div class="fit-mtip-head"><img src="${IMG(t.id)}" alt="" width="24" height="24"><b>${app.esc(t.name)}</b>${m.state === 'overload' ? '<em>超载</em>' : m.state === 'offline' ? '<em>离线</em>' : ''}</div>
    ${rows.length ? dl(rows) : ''}${w && item.charge ? chargeTipHtml(w, item.charge, names, dl) : ''}${probeHtml}`;
}
// 探针发射器悬停提示里的探针一节：和游戏一样显示「扫描强度基数：N 点」（取整），比探针基础值高标绿；
// 单独的「N 点」不能加通用翻译（别处的「点」是几点钟），英文直接写 points
function probeTipHtml(c, names) {
  const v = c.attr(AT_PROBE_STRENGTH), base = c.type.attrs.get(AT_PROBE_STRENGTH);
  if (!v) return '';
  const cls = Math.abs(v - base) <= Math.abs(base) * 1e-6 ? '' : v > base ? 'is-up' : 'is-down';
  return `<div class="fit-mtip-sub"><img src="${IMG(c.type.id)}" alt="" width="20" height="20"><span>已装填</span><b>${app.esc(c.type.name)}</b></div>
    <dl><dt>${app.esc(names.attrs[AT_PROBE_STRENGTH]?.[0] || '扫描强度')}</dt><dd${cls ? ` class="${cls}"` : ''}>${Math.round(v)}${window.I18N?.lang === 'en' ? ' points' : ' 点'}</dd></dl>`;
}
// 武器悬停提示里的「弹药」一节：每发各类伤害（已乘炮台伤害倍数或导弹伤害技能、递增），
// 以及弹药自身受技能 / 舰船 / 装备加成后的属性（导弹、炸弹的飞行速度、飞行时间、爆炸半径、爆炸速度）；和弹药基础属性比，变好标绿、变差标红。
// 炮台弹药的射程、跟踪、电容等倍数已经算进上面的装备属性
const CHARGE_TIP_ATTRS = [37, 281, 654, 653];
function chargeTipHtml(w, c, names, dl) {
  const rows = [];
  FE.DAMAGE.forEach((a, i) => { if (w.dmg?.[i] > 0) rows.push([`${names.attrs[a]?.[0] || a}（每发）`, app.formatNumber(Math.round(w.dmg[i] * 10) / 10)]); });
  for (const a of CHARGE_TIP_ATTRS) {
    const base = c.type.attrs.get(a);
    if (!base || !names.attrs[a]) continue;
    const v = c.attr(a);
    const [label, unit, highGood] = names.attrs[a];
    const cls = Math.abs(v - base) <= Math.abs(base) * 1e-6 ? '' : (highGood ? v > base : v < base) ? 'is-up' : 'is-down';
    rows.push([label, unit === 1 ? dist(v) : infoValue(a, v, unit, names.units), cls]);
  }
  if (!rows.length) return '';
  return `<div class="fit-mtip-sub"><img src="${IMG(c.type.id)}" alt="" width="20" height="20"><span>已装填</span><b>${app.esc(c.type.name)}</b></div>${dl(rows)}`;
}
// 无人机 / 舰载机的悬浮窗：伤害（已算技能、船体和装备加成）、射程、速度、耐久、带宽等；变好标绿、变差标红（和基础属性比）
const DRONE_TIP_ATTRS = [64, 51, 54, 158, 160, 37, 508, 620, 552, 263, 265, 9, 77, 1272];
async function droneTipHtml(i) {
  if (!F.fit || !F.calc) return '';
  const d = F.fit.drones[i];
  const item = F.calc.drones[i];
  const t = d && type(d.type);
  if (!t || !item) return '';
  const names = await dogmaNames();
  const fighter = t.category === FE.CAT.fighter;
  const rows = [];
  if (!fighter) {
    const dmg = FE.DAMAGE.map((a) => (item.attr(a) || 0) * (item.attr(FE.AT.damageMultiplier) || 1)).reduce((x, y) => x + y, 0);
    const cycle = (item.attr(FE.AT.speed) || 0) / 1000;
    if (dmg && cycle) {
      rows.push(['每架 DPS', (dmg / cycle).toFixed(1)]);
      if (d.active) rows.push([`激活 ${d.active} 架合计`, (dmg / cycle * d.active).toFixed(1) + ' DPS']);
      rows.push(['每架齐射伤害', app.formatNumber(Math.round(dmg))]);
    }
  } else {
    rows.push(['每中队架数', String(t.attrs.get(FE.AT.fighterSquadronSize) || 1)]);
  }
  for (const a of DRONE_TIP_ATTRS) {
    if (!t.attrs.get(a) || !names.attrs[a]) continue;
    const v = item.attr(a);
    if (!v) continue;
    const [label, unit, highGood] = names.attrs[a];
    const base = t.attrs.get(a);
    const better = base < 0 ? Math.abs(v) > Math.abs(base) : highGood ? v > base : v < base;
    const cls = Math.abs(v - base) <= Math.abs(base) * 1e-6 ? '' : better ? 'is-up' : 'is-down';
    rows.push([label, unit === 1 ? dist(v) : infoValue(a, v, unit, names.units), cls]);
  }
  if (!rows.length) return '';
  return `<div class="fit-mtip-head"><img src="${IMG(t.id)}" alt="" width="24" height="24"><b>${app.esc(t.name)}</b></div>
    <dl>${rows.map(([k, v, cls]) => `<dt>${app.esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
}
// 被动装备（伤害控制以外的扩展器、伤害增幅、改装件等）的悬浮窗：列出它自己的加成属性（已算技能），跳过装配、元等级这类无关属性
const PASSIVE_SKIP = new Set([...INFO_GROUPS[0][1], ...SKIP_INFO, 9, 422, 1692, 1768, 1211, 1212, 1271, 1544, 1298, 1299, 1300, 1301, 1872, 1879, 1880, 1881, 2113]);
function passiveTipHtml(t, m, item, names) {
  const rows = [];
  for (const [a, base] of t.attrs) {
    const n = names.attrs[a];
    if (!n || !base || PASSIVE_SKIP.has(a) || [115, 116, 119, 129, 136, 137, 140, 142].includes(n[1])) continue;
    const v = item.attr(a) ?? base;
    const [label, unit, highGood] = n;
    const better = base < 0 ? Math.abs(v) > Math.abs(base) : highGood ? v > base : v < base;
    const cls = Math.abs(v - base) <= Math.abs(base) * 1e-6 ? '' : better ? 'is-up' : 'is-down';
    rows.push([label, unit === 1 ? dist(v) : infoValue(a, v, unit, names.units), cls]);
    if (rows.length >= 10) break;
  }
  if (!rows.length) return '';
  return `<div class="fit-mtip-head"><img src="${IMG(t.id)}" alt="" width="24" height="24"><b>${app.esc(t.name)}</b>${m.state === 'offline' ? '<em>离线</em>' : ''}</div>
    <dl>${rows.map(([k, v, cls]) => `<dt>${app.esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
}
function initModTip() {
  const tip = document.createElement('div');
  tip.className = 'fit-mtip';
  tip.hidden = true;
  document.body.append(tip);
  let timer = 0, cur = null, mx = 0, my = 0;
  const hide = () => { clearTimeout(timer); cur = null; tip.hidden = true; };
  // 跟着鼠标：放在指针右下方，超出窗口就翻到左边 / 上方
  const place = () => {
    const tw = tip.offsetWidth, th = tip.offsetHeight, G = 16;
    let x = mx + G, y = my + G;
    if (x + tw > innerWidth - 8) x = mx - tw - G;
    if (y + th > innerHeight - 8) y = my - th - G;
    tip.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.max(8, y))}px)`;
  };
  document.addEventListener('pointermove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (cur && !tip.hidden) place();
  }, { passive: true });
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const row = e.target.closest?.('#fitMain [data-fit-mod], #fitMain [data-fit-drone-row]');
    if (row && row === cur) return;
    hide();
    if (!row || document.body.classList.contains('fit-dragging')) return;
    cur = row;
    timer = setTimeout(async () => {
      const html = row.dataset.fitDroneRow != null ? await droneTipHtml(Number(row.dataset.fitDroneRow)) : await modTipHtml(row.dataset.fitMod);
      if (cur !== row || !row.isConnected || !html) return;
      tip.innerHTML = html;
      tip.hidden = false;
      place();
    }, 250);
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
}

function dist(m) {
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' km' : Math.round(m) + ' m';
}

function droneRow(d, i, fighter) {
  const t = type(d.type);
  const size = fighter ? t.attrs.get(FE.AT.fighterSquadronSize) || 1 : 1;
  const unit = fighter ? '中队' : '架';
  return `<div class="fit-slot fit-drone" data-fit-drone-row="${i}">
    <img src="${IMG(t.id)}" alt="" width="28" height="28" loading="lazy">
    <span class="fit-slot-name">${app.esc(t.name)}<small>${fighter ? `每中队 ${size} 架 · 出击 ${d.active} / ${d.count}` : `激活 ${d.active} / ${d.count}`}</small></span>
    <span class="fit-stepper" title="数量（${unit}）"><button data-fit-drone="${i}:count:-1" aria-label="减少">−</button><b>${d.count}</b><button data-fit-drone="${i}:count:1" aria-label="增加">+</button></span>
    <span class="fit-stepper is-active" title="${fighter ? '出击中队' : '激活数量'}"><button data-fit-drone="${i}:active:-1" aria-label="减少">−</button><b>${d.active}</b><button data-fit-drone="${i}:active:1" aria-label="增加">+</button></span>
    ${infoBtn(t.id)}
    <button class="fit-remove" data-fit-drone-remove="${i}" title="移除" aria-label="移除">×</button>
  </div>`;
}

// 悬停预览中的无人机 / 舰载机：挂舱里多一行淡淡的「名称 +1」
function droneGhost(fighter) {
  const pv = F.preview?.drone && F.preview.fighter === fighter ? type(F.preview.type) : null;
  if (!pv) return '';
  const has = F.fit.drones.some((d) => d.type === pv.id);
  return `<div class="fit-slot is-ghost"><img src="${IMG(pv.id)}" alt="" width="28" height="28"><span class="fit-slot-name"><span class="fit-slot-title">${app.esc(pv.name)}</span><small>${has ? '再加 1 ' + (fighter ? '个中队' : '架') : '+1 ' + (fighter ? '个中队' : '架')}</small></span></div>`;
}

function dronesHtml() {
  const res = F.stats.resources;
  let html = '';
  const drones = F.fit.drones.map((d, i) => [d, i]).filter(([d]) => !isFighter(d));
  const fighters = F.fit.drones.map((d, i) => [d, i]).filter(([d]) => isFighter(d));
  if (res.droneBay.total || drones.length) {
    html += `<section class="fit-slots" data-fit-drop="drone"><h4>无人机<span>挂舱 ${fmt(res.droneBay.used)} / ${fmt(res.droneBay.total)} m³ · 带宽 ${fmt(res.bandwidth.used)} / ${fmt(res.bandwidth.total)}</span></h4>
      ${drones.map(([d, i]) => droneRow(d, i, false)).join('')}${droneGhost(false)}<div class="fit-slot is-empty" data-fit-empty-drone><span class="fit-slot-icon"></span><span>${MOBILE() ? '点这里从「无人机」中添加' : '从左侧「无人机」中添加'}</span></div></section>`;
  }
  if (res.fighterBay.total || fighters.length) {
    const roles = [['fighterLight', '轻型'], ['fighterSupport', '支援'], ['fighterHeavy', '重型']].filter(([k]) => res[k].total).map(([k, l]) => `${l} ${res[k].used}/${res[k].total}`).join(' · ');
    html += `<section class="fit-slots" data-fit-drop="fighter"><h4>舰载机<span>机库 ${fmt(res.fighterBay.used)} / ${fmt(res.fighterBay.total)} m³ · 发射管 ${res.fighterTubes.used} / ${res.fighterTubes.total}${roles ? ' · ' + roles : ''}</span></h4>
      ${fighters.map(([d, i]) => droneRow(d, i, true)).join('')}${droneGhost(true)}<div class="fit-slot is-empty" data-fit-empty-drone><span class="fit-slot-icon"></span><span>${MOBILE() ? '点这里从「无人机」中添加舰载机' : '从左侧「无人机」中添加舰载机'}</span></div></section>`;
  }
  return html;
}

function implantsHtml(bound) {
  const rows = F.fit.implants.map((id) => {
    const t = type(id);
    const slot = t.attrs.get(IMPLANT_SLOT);
    return `<div class="fit-slot"><img src="${IMG(id)}" alt="" width="28" height="28" loading="lazy"><span class="fit-slot-name">${app.esc(t.name)}<small>${slot ? '植入体槽位 ' + slot : '增效剂'}</small></span>${infoBtn(id)}<button class="fit-remove" data-fit-implant-remove="${id}" aria-label="移除">×</button></div>`;
  }).join('');
  return `<section class="fit-slots" data-fit-drop="implant"><h4>植入体 / 增效剂<span><button class="link-btn" data-fit-imp>智能推荐</button>${bound ? '<button class="link-btn" data-fit-my-implants>导入当前角色的植入体</button>' : ''}</span></h4>
    ${rows}<div class="fit-slot is-empty" data-fit-empty-implant><span class="fit-slot-icon"></span><span>${MOBILE() ? '点这里从「植入体」中添加' : '从左侧「植入体」中添加'}</span></div></section>`;
}

// ---------- 右侧：属性 ----------
// 属性用游戏内图标（tools/attr-icons.mjs 从客户端资源取到 assets/attr/），文字放在悬停提示里
const SENSOR_ICON = { 雷达: 'radar', 光雷达: 'ladar', 磁力: 'magnet', 引力: 'gravi' };
const ico = (k, label) => `<span class="fit-ico" title="${label}"><img src="assets/attr/${k}.png?v=1" alt="${label}" width="18" height="18" loading="lazy"></span>`;
// 图标 + 名称 / 数值的两列格子（名称小字在上，悬停也显示）；cells：[图标, 名称, 数值, 数值的 class, 占满一行]，假值跳过
const ivs = (cells) => `<div class="fit-ivs">${cells.filter(Boolean).map(([k, label, val, cls, wide]) => `<div class="fit-iv${wide ? ' is-wide' : ''}" title="${label}" data-k="${label}">${ico(k, label)}<span class="fit-iv-txt"><small>${label}</small><b class="${cls || ''}">${val}</b></span></div>`).join('')}</div>`;
function renderStats() {
  const box = $('fitStats');
  if (!box) return;
  if (!F.fit || !F.stats) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  refreshFitValue();
  box.innerHTML = statsHtml(F.preview?.stats || F.stats);
  if (F.preview) markStatDiff(box, statsHtml(F.stats));
}

// 预览时与当前装配逐项比较：变好标绿、变差标红，悬停看原来的数值
const LOWER_BETTER = new Set(['CPU', '能量栅格', '校准值', '起跳时间', '信号半径', '质量', '充能时间', '消耗 / 峰值回充', '残渣']);
const NO_DIFF = new Set(['炮台安装座', '发射器安装座']);
function statNum(text) {
  let m;
  if ((m = /([\d.]+)\s*小时\s*(\d+)\s*分/.exec(text))) return m[1] * 3600 + m[2] * 60;
  if ((m = /(\d+)\s*分\s*(\d+)\s*秒/.exec(text))) return m[1] * 60 + Number(m[2]);
  if ((m = /([\d.]+)\s*km/.exec(text))) return m[1] * 1000;
  m = /-?[\d,]*\.?\d+/.exec(text);
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
}
function markStatDiff(box, baseHtml) {
  const base = document.createElement('div');
  base.innerHTML = baseHtml;
  const keyed = (root) => {
    const map = new Map();
    root.querySelectorAll('[data-k]').forEach((el) => map.set('k:' + el.dataset.k, el.querySelector('b')));
    root.querySelectorAll('.fit-stat-block h4').forEach((h) => { const b = h.querySelector('b'); if (b) map.set('h:' + h.firstChild.textContent.trim(), b); });
    root.querySelectorAll('.fit-resist tbody tr').forEach((tr, r) => tr.querySelectorAll('td').forEach((td, c) => map.set(`r:${r}:${c}`, td)));
    return map;
  };
  const before = keyed(base);
  for (const [key, el] of keyed(box)) {
    const old = before.get(key);
    if (!el || !old || old.textContent === el.textContent) continue;
    const label = key.slice(2);
    if (NO_DIFF.has(label)) continue;
    let better;
    if (key === 'h:电容') {
      const a = old.textContent.includes('稳定'), b = el.textContent.includes('稳定');
      better = a !== b ? b : statNum(el.textContent) > statNum(old.textContent);
    } else {
      const a = statNum(old.textContent), b = statNum(el.textContent);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
      better = LOWER_BETTER.has(label) ? b < a : b > a;
    }
    el.classList.add(better ? 'fit-diff-up' : 'fit-diff-down');
    el.title = '装上前：' + old.textContent.trim();
  }
}

function statsHtml(s) {
  const r = s.resources;
  const bar = (label, v, unit = '', digits = 1) => {
    const pct = v.total ? Math.min(100, v.used / v.total * 100) : (v.used ? 100 : 0);
    const over = v.used > v.total + 1e-6;
    return `<div class="fit-bar${over ? ' is-over' : ''}" data-k="${label[1]}"><div class="fit-bar-head"><span>${ico(label[0], label[1])}${label[1]}</span><b>${fmt(v.used, digits)} / ${fmt(v.total, digits)}${unit}</b></div><i style="width:${pct.toFixed(1)}%"></i></div>`;
  };
  const resRow = (label, values) => `<tr><th>${label}</th>${values.map((v) => `<td style="--r:${(v * 100).toFixed(0)}%">${(v * 100).toFixed(1)}%</td>`).join('')}</tr>`;
  const d = s.defense;
  const cap = s.capacitor;
  const v = F.val;
  return `
    <section class="fit-stat-block">
      <h4>装配资源</h4>
      ${bar(['cpu', 'CPU'], r.cpu, ' tf')}
      ${bar(['power', '能量栅格'], r.power, ' MW')}
      ${r.calibration.total ? bar(['calibration', '校准值'], r.calibration, '', 0) : ''}
      ${ivs([
        ['turret', '炮台安装座', `${r.turrets.used} / ${fmt(r.turrets.total)}`, r.turrets.used > r.turrets.total ? 'bad' : ''],
        ['launcher', '发射器安装座', `${r.launchers.used} / ${fmt(r.launchers.total)}`, r.launchers.used > r.launchers.total ? 'bad' : '']
      ])}
    </section>
    <section class="fit-stat-block">
      <h4>火力<b>${s.weapon.total.toFixed(1)} DPS</b></h4>
      ${ivs([
        ['turret', '炮台', s.weapon.turret.toFixed(1)],
        ['launcher', '导弹', s.weapon.missile.toFixed(1)],
        ['drone', '无人机', s.weapon.drone.toFixed(1)],
        (s.weapon.fighter || r.fighterBay.total) && ['fighter', '舰载机', s.weapon.fighter.toFixed(1)],
        ['damage', '齐射伤害', app.formatNumber(Math.round(s.weapon.volley))]
      ])}
      ${s.weapon.total ? `<div class="fit-dmg">${['em', 'th', 'ki', 'ex'].map((k, i) => `<i class="is-${k}" style="flex:${s.weapon.types[i] || 0.0001}" title="${['电磁', '热能', '动能', '爆炸'][i]} ${(s.weapon.types[i] / s.weapon.total * 100).toFixed(0)}%"></i>`).join('')}</div>` : ''}
    </section>
    ${s.mining.total ? `<section class="fit-stat-block">
      <h4>采矿<b>${s.mining.total.toFixed(1)} m³/s</b></h4>
      ${ivs([
        ['mining', '每小时产量', `${app.formatNumber(Math.round(s.mining.total * 3600))} m³`],
        s.mining.drones && ['drone', '无人机', `${s.mining.drones.toFixed(1)} m³/s`],
        s.mining.drones && ['mining', '采矿器', `${s.mining.modules.toFixed(1)} m³/s`],
        ['waste', '残渣', `${s.mining.waste.toFixed(1)} m³/s`, s.mining.waste ? 'bad' : '']
      ])}
      <p class="fit-hint">含突变属性、晶体、技能、船体和舰队加成（大鱼的采矿脉冲在装配的「舰队加成」里添加），暴击按期望值计入</p>
    </section>` : ''}
    <section class="fit-stat-block">
      <h4>防御<b>${app.formatNumber(Math.round(d.ehp))} EHP</b></h4>
      <table class="fit-resist">
        <thead><tr><th></th><th class="is-em">${ico('em', '电磁')}</th><th class="is-th">${ico('th', '热能')}</th><th class="is-ki">${ico('ki', '动能')}</th><th class="is-ex">${ico('ex', '爆炸')}</th><th>HP</th></tr></thead>
        <tbody>
          ${resRow(ico('shield', '护盾'), d.shield.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.shield.hp))}</td></tr>`)}
          ${resRow(ico('armor', '装甲'), d.armor.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.armor.hp))}</td></tr>`)}
          ${resRow(ico('hull', '结构'), d.hull.resist).replace('</tr>', `<td class="hp">${app.formatNumber(Math.round(d.hull.hp))}</td></tr>`)}
        </tbody>
      </table>
      ${ivs([
        ['recharge', '护盾自然回充峰值', `${d.passiveRegen.toFixed(1)} HP/s`, '', true],
        d.reps.shield && ['shield', '护盾主动回充', `${d.reps.shield.toFixed(1)} HP/s · ${d.repsEhp.shield.toFixed(1)} EHP/s`, '', true],
        d.reps.armor && ['repair', '装甲维修', `${d.reps.armor.toFixed(1)} HP/s · ${d.repsEhp.armor.toFixed(1)} EHP/s`, '', true],
        d.reps.hull && ['hull', '结构维修', `${d.reps.hull.toFixed(1)} HP/s`, '', true]
      ])}
      <p class="fit-hint">EHP 按四种伤害各 25% 计算</p>
    </section>
    <section class="fit-stat-block">
      <h4>电容<b class="${cap.stable ? 'good' : 'bad'}">${cap.stable ? '稳定 ' + (cap.level * 100).toFixed(1) + '%' : '可维持 ' + duration(cap.lasts)}</b></h4>
      ${ivs([
        ['cap', '容量', `${app.formatNumber(Math.round(cap.capacity))} GJ`],
        ['recharge', '充能时间', duration(cap.recharge)],
        ['power', '消耗 / 峰值回充', `${cap.usage.toFixed(1)} / ${cap.peak.toFixed(1)} GJ/s`, cap.usage > cap.peak ? 'bad' : '', true]
      ])}
    </section>
    <section class="fit-stat-block">
      <h4>机动</h4>
      ${ivs([
        ['velocity', '最大速度', `${fmt(s.navigation.velocity)} m/s`],
        ['agility', '起跳时间', `${s.navigation.align.toFixed(2)} 秒`],
        ['warp', '跃迁速度', `${fmt(s.navigation.warp, 2)} AU/s`],
        ['sig', '信号半径', `${fmt(s.navigation.signature)} m`],
        ['mass', '质量', `${app.formatNumber(Math.round(s.navigation.mass))} kg`, '', true]
      ])}
    </section>
    <section class="fit-stat-block">
      <h4>锁定</h4>
      ${ivs([
        ['range', '锁定距离', dist(s.targeting.range)],
        ['scanres', '扫描分辨率', `${fmt(s.targeting.scanRes)} mm`],
        ['targets', '最大锁定数', fmt(s.targeting.maxTargets)],
        [SENSOR_ICON[s.targeting.sensorType] || 'radar', `${s.targeting.sensorType}感应强度`, fmt(s.targeting.sensor)],
        (r.droneBay.total || r.bandwidth.total || r.fighterBay.total) && ['drone', '无人机控制距离', dist(s.targeting.droneControl || 0)]
      ])}
    </section>
    <section class="fit-stat-block">
      <h4>其他</h4>
      ${ivs([['cargo', '货柜舱', `${fmt(s.cargo)} m³`]])}
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
  if ((x = el('[data-fit-offline]'))) {
    const { slot, index } = parseRef(x.dataset.fitOffline);
    const m = F.fit.slots[slot][index];
    m.state = m.state === 'offline' ? defaultState(type(m.type)) : 'offline';
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
  if (el('[data-fit-skillplan]')) { queuePlan({ ship: F.fit.ship, fit: F.fit, label: F.fit.name ? `装配：${F.fit.name}` : '装配页当前装配' }); app.openPlan(); return; }
  if ((x = el('[data-fit-graph]'))) { openTool(openGraph); return; }
  if ((x = el('[data-fit-all]'))) { setAllStates(x.dataset.fitAll === 'on'); return; }
  if ((x = el('[data-fit-mode]'))) { F.fit.mode = Number(x.dataset.fitMode); recompute(); return; }
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
  if ((x = el('[data-fit-pick-ship]'))) { setShip(Number(x.dataset.fitPickShip)); return; }
  if ((x = el('[data-fit-uncharge]'))) {
    const { slot, index } = parseRef(x.dataset.fitUncharge);
    F.fit.slots[slot][index].charge = null;
    recompute();
    return;
  }
  if ((x = el('[data-fit-pick-charge]'))) {
    F.selected = parseRef(x.dataset.fitPickCharge);
    setChargeFor(F.fit.slots[F.selected.slot][F.selected.index]?.type);
    setTab('charge');
    if (F.query) { F.query = ''; $('fitSearch').value = ''; renderBrowser(); }
    renderFit();
    if (MOBILE()) app.openDrawer?.();
    return;
  }
  if ((x = el('[data-fit-empty]'))) {
    const slot = x.dataset.fitEmpty;
    const idx = Number(x.dataset.fitIdx);
    const same = F.target && F.target.slot === slot && F.target.index === idx;
    // 点空槽位：侧栏只看这类槽位，点的装备装进这一格；再点一次同一格取消选中（筛选保留，在侧栏切回「全部」）
    F.target = x.classList.contains('is-extra') || same ? null : { slot, index: idx, ship: F.fit.ship };
    if (F.target) F.slotFilter = slot;
    renderFit();
    renderBrowser();
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
    if (F.tab === 'charge') {
      // 在弹药页点装配里的装备：要装弹药的就切到它能用的弹药
      const mt = F.selected && type(F.fit.slots[ref.slot][ref.index]?.type);
      if (mt && FE.AT.chargeGroups.some((a) => mt.attrs.get(a))) setChargeFor(mt.id);
      renderBrowser();
    }
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
  if ((x = el('[data-fit-fleet-remove]'))) { saveFleet(FE.getFleet().filter((_, i) => i !== Number(x.dataset.fitFleetRemove))); return; }
  if ((x = el('[data-fit-fleet-mode]'))) { saveFleet(FE.getFleet().map((f, i) => (i === Number(x.dataset.fitFleetMode) ? [f[0], x.dataset.v] : f))); return; }
  if ((x = el('[data-fit-env-remove]'))) { saveEnv(FE.getEnv().filter((id) => id !== Number(x.dataset.fitEnvRemove))); return; }
  if ((x = el('[data-fit-env-more]'))) { envOpen.add(Number(x.dataset.fitEnvMore)); recompute(); return; }
  if ((x = el('[data-fit-cloud-remove]'))) { saveCloud(FE.cloudInfo(F.data, F.fit.ship).map((c) => c.ship.id).filter((id) => id !== Number(x.dataset.fitCloudRemove))); return; }
  if ((x = el('[data-fit-implant-remove]'))) { F.fit.implants = F.fit.implants.filter((id) => id !== Number(x.dataset.fitImplantRemove)); recompute(); return; }
  if ((x = el('[data-fit-view]'))) {
    try { localStorage.setItem(VIEW_KEY, x.dataset.fitView); } catch { /* 忽略 */ }
    renderFit();
    return;
  }
  if (el('[data-fit-csk-open]')) { openCsk(); return; }
  if ((x = el('[data-fit-skill]'))) {
    const mode = x.dataset.fitSkill;
    if (mode === F.skillMode) return;
    F.skillMode = mode;
    saveSettings();
    if (mode === 'esi') await loadEsiSkills();
    recompute();
    if (mode === 'custom') openCsk();
    return;
  }
  if (el('[data-fit-my-implants]')) { importMyImplants(); return; }
  if (el('[data-fit-save]')) { saveFit(); return; }
  if (el('[data-fit-new]')) { stashDraft(F.fit); F.fit = null; F.selected = null; app.store.setJSON(CURRENT_KEY, null); recompute(); setTab('ship'); return; }
  if (el('[data-fit-delete]')) { deleteFit(); return; }
  if (el('[data-fit-import]')) { openModal(); return; }
  if (el('[data-fit-export]')) { app.copyText(toEft(F.fit), '已复制 EFT 文本'); return; }
  if (el('[data-fit-pz-post]')) { app.openPlazaFit?.(); return; }
  if (el('[data-fit-share]')) { app.copyText(shareUrl(), '分享链接已复制'); return; }
  if (el('[data-fit-cart]')) { app.addToCart(fitShoppingList(F.fit)); return; }
  if (el('[data-fit-esi-list]')) { openEsiModal(); return; }
  if ((x = el('[data-fit-cur-ship]'))) { importCurrentShip(x); return; }
  if (el('[data-fit-auto]')) { openAutoFit(); return; }
  if (el('[data-fit-imp]')) { openImplantAdvisor(); return; }
  if (el('[data-fit-kb]')) { openKbFits(); return; }
  if (el('[data-fit-pz]')) { openPlazaFits(); return; }
  if ((x = el('[data-fit-esi-save]'))) { saveToGame(x); return; }
}

function onMainChange(e) {
  const fleet = e.target.closest('[data-fit-fleet-add]');
  if (fleet && fleet.value) { saveFleet([...FE.getFleet(), [Number(fleet.value), 'cs']]); return; }
  const env = e.target.closest('[data-fit-env-add]');
  if (env && env.value) { addEnv(Number(env.value)); return; }
  const cloud = e.target.closest('[data-fit-cloud-add]');
  if (cloud && cloud.value) { saveCloud([...FE.cloudInfo(F.data, F.fit.ship).map((c) => c.ship.id), Number(cloud.value)]); return; }
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

// 「全部 5 级」时哪些技能会影响当前装配的属性（FE.skillAffects 逐个技能重算，每批 24 个让出主线程，算完重绘）；
// 按装配内容缓存，没算完时返回 null（技能栏先不显示「没到 5 级」）。只算角色还没到 5 级的技能
const IMPACT = { key: '', set: null, job: 0 };

// ---------- 自定义技能等级（技能来源「自定义」） ----------
// 用户改过的等级存在本机（所有装配共用）；没改过的按 5 级。实际等级不低于这套装配的要求（舰船 / 装备 / 弹药 / 无人机 / 植入体
// 需要的技能及其前置），换了要求更高的装备会自动抬上去，用户的设置保留不动。
const CUSTOM_KEY = 'eve-fit-custom-skills';
let customMap = null;
function customSaved() {
  if (!customMap) {
    customMap = new Map();
    try { for (const [k, v] of Object.entries(app.store.getJSON(CUSTOM_KEY, {}) || {})) if (v >= 0 && v <= 5) customMap.set(Number(k), Math.round(v)); } catch { /* 坏数据就当没有 */ }
  }
  return customMap;
}
const saveCustom = () => app.store.setJSON(CUSTOM_KEY, Object.fromEntries(customSaved()));
// 这套装配要求的最低等级：技能 id -> 等级
function requiredLevels(fit = F.fit) {
  if (!fit || !F.data) return new Map();
  return new Map(FE.missingSkills(F.data, fit, new Map()).filter((x) => x.type).map((x) => [x.type.id, x.need]));
}
function customLevels(fit = F.fit) {
  const req = requiredLevels(fit);
  const saved = customSaved();
  return new Map(F.data.skills.map((t) => [t.id, Math.max(saved.get(t.id) ?? 5, req.get(t.id) || 0)]));
}
// 影响这套装配属性的技能（所有带效果的技能逐个降到 0 级试算，分批让出主线程；装配不变时用缓存）
const CIMPACT = { key: '', set: null, job: 0 };
function customImpact() {
  const f = F.fit;
  const key = JSON.stringify([f.ship, FE.SLOTS.map((s) => (f.slots?.[s] || []).map((m) => (m ? [m.type, m.charge || 0, m.state || '', m.mut ? JSON.stringify(m.mut) : ''] : 0))), f.drones, f.implants]);
  if (CIMPACT.key === key) return CIMPACT.set;
  CIMPACT.key = key; CIMPACT.set = null;
  const job = ++CIMPACT.job;
  const fit = structuredClone(f);
  const ids = F.data.skills.filter((t) => t.effects?.length).map((t) => t.id);
  const out = new Set();
  let ctx = null, i = 0;
  const step = () => {
    if (job !== CIMPACT.job) return;
    ctx ||= FE.skillImpactCtx(F.data, fit);
    for (const id of FE.skillAffects(ctx, ids.slice(i, i + 24))) out.add(id);
    i += 24;
    if (i < ids.length) { setTimeout(step, 0); return; }
    CIMPACT.set = out;
    if (F.fit && F.skillMode === 'custom') { renderFit(); renderCsk(); }
  };
  setTimeout(step, 0);
  return null;
}
// 自定义技能弹窗：按技能分组列出影响这套装配的技能和装配要求的技能，每个技能 5 个点，点第 n 个点就是 n 级
// （再点当前等级的那个点降一级；低于装配要求的点锁住）
function cskBodyHtml() {
  const impact = customImpact();
  const req = requiredLevels();
  const levels = customLevels();
  const ids = new Set([...(impact || []), ...req.keys()]);
  const groups = new Map();
  for (const id of ids) {
    const t = type(id);
    if (!t) continue;
    const g = F.data.groups.get(t.group)?.name || '其他';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const low = [...ids].filter((id) => (levels.get(id) ?? 5) < 5).length;
  const body = [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([g, list]) => `<div class="fit-csk-group"><h5>${app.esc(g)}</h5>${list.sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((t) => {
    const min = req.get(t.id) || 0, lv = levels.get(t.id);
    const dots = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="fit-dot${n <= lv ? ' on' : ''}${n <= min ? ' lock' : ''}" data-fit-csk-dot="${t.id}:${n}" title="${n <= min ? `这套装配至少要 ${min} 级` : n + ' 级'}" aria-label="${n} 级"></button>`).join('');
    return `<div class="fit-csk${lv < 5 ? ' is-low' : ''}" title="${impact && !impact.has(t.id) ? '只是前置要求，本身不影响属性' : ''}"><span class="fit-csk-name">${app.esc(t.name)}</span><span class="fit-dots">${dots}</span><b class="fit-csk-lv">${lv}</b></div>`;
  }).join('')}</div>`).join('');
  return `<div class="fit-csk-acts"><button type="button" class="btn btn-ghost btn-sm" data-fit-csk-all="5">全部 5 级</button><button type="button" class="btn btn-ghost btn-sm" data-fit-csk-all="min">全部降到装配要求</button>${app.hasEsiToken() ? '<button type="button" class="btn btn-ghost btn-sm" data-fit-csk-all="esi">按 ESI 角色填入</button>' : ''}
      <span class="text-muted">${impact ? `${ids.size} 项${low ? `，${low} 项低于 5 级` : ''}` : '正在找影响这套装配的技能…'}</span></div>
    <p class="fit-hint">点第几个点就是几级，再点一次降一级；锁住的点是这套装配的最低要求。改动对所有装配生效，存在本机</p>
    ${body || (impact ? '<p class="text-muted">这套装配没有用到可调的技能</p>' : '')}`;
}
function renderCsk() {
  const m = $('fitCskModal');
  if (m && !m.hidden && F.fit) $('fitCskBody').innerHTML = cskBodyHtml();
}
function openCsk() {
  let modal = $('fitCskModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitCskModal';
    modal.className = 'modal fa-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-fit-csk-close></div><div class="modal-content fit-csk-content">
      <div class="modal-header"><h3>自定义技能等级</h3><button class="modal-close" data-fit-csk-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="fitCskBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onCskClick);
  }
  modal.hidden = false;
  renderCsk();
}
async function onCskClick(e) {
  const el = (sel) => e.target.closest(sel);
  let x;
  if (el('[data-fit-csk-close]')) { $('fitCskModal').hidden = true; return; }
  if ((x = el('[data-fit-csk-dot]'))) {
    const [id, n] = x.dataset.fitCskDot.split(':').map(Number);
    const min = requiredLevels().get(id) || 0;
    const cur = customLevels().get(id);
    const lv = Math.max(min, n === cur ? n - 1 : n);
    if (lv === cur) return;
    customSaved().set(id, lv);
    saveCustom();
    recompute();
    renderCsk();
    return;
  }
  if ((x = el('[data-fit-csk-all]'))) {
    const how = x.dataset.fitCskAll;
    const ids = [...new Set([...(CIMPACT.set || []), ...requiredLevels().keys()])];
    const m = customSaved();
    if (how === 'esi') {
      if (!F.esi) await loadEsiQuiet2();
      if (!F.esi) { app.showToast('读取角色技能失败', 'error'); return; }
      for (const id of ids) m.set(id, F.esi.levels.get(id) || 0);
    } else for (const id of ids) m.set(id, how === '5' ? 5 : 0);   // 降到 0 后按装配要求自动抬到最低
    saveCustom();
    recompute();
    renderCsk();
  }
}
function skillImpact() {
  const f = F.fit;
  const key = JSON.stringify([f.ship, FE.SLOTS.map((s) => (f.slots?.[s] || []).map((m) => (m ? [m.type, m.charge || 0, m.state || '', m.mut ? JSON.stringify(m.mut) : ''] : 0))), f.drones, f.implants, F.esi.id]);
  if (IMPACT.key === key) return IMPACT.set;
  IMPACT.key = key; IMPACT.set = null;
  const job = ++IMPACT.job;
  const fit = structuredClone(f), levels = F.esi.levels;
  const ids = F.data.skills.filter((t) => (levels.get(t.id) || 0) < 5 && t.effects?.length).map((t) => t.id);
  const out = new Set();
  let ctx = null, i = 0;
  const step = () => {
    if (job !== IMPACT.job) return;
    ctx ||= FE.skillImpactCtx(F.data, fit);
    for (const id of FE.skillAffects(ctx, ids.slice(i, i + 24))) out.add(id);
    i += 24;
    if (i < ids.length) { setTimeout(step, 0); return; }
    IMPACT.set = out;
    if (F.fit && F.skillMode === 'max') renderFit();
  };
  setTimeout(step, 0);
  return null;
}

// 「全部 5 级」模式下静默读角色技能（失败不提示，只是不显示还没到 5 级的技能）
let esiQuiet = null, esiQuietAt = 0;
function loadEsiQuiet() {
  if (esiQuiet || Date.now() - esiQuietAt < 300000) return;
  esiQuietAt = Date.now();
  esiQuiet = app.getCharacterSkills().then((r) => { F.esi = r || null; if (F.esi && F.fit && F.skillMode === 'max') renderFit(); }).catch(() => {}).finally(() => { esiQuiet = null; });
}

async function loadEsiQuiet2() {
  try { F.esi = await app.getCharacterSkills(); } catch { F.esi = null; }
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
  if (F.tab === 'ship') renderBrowser();
}

function deleteFit() {
  if (!F.fit.id || !confirm(`删除已保存的装配「${F.fit.name || type(F.fit.ship).name}」？`)) return;
  app.store.setJSON(SAVE_KEY, savedFits().filter((x) => x.id !== F.fit.id));
  F.fit.id = null;
  app.showToast('已删除', 'success');
  renderFit();
  if (F.tab === 'ship') renderBrowser();
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
    if (t.group === FE.GROUP_SHIP_MODE) { fit.mode = t.id; continue; }   // 舰船模式（Pyfa 等工具导出的 EFT 里可能有）
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
const ESI_SCOPE_HINT = '授权缺少装配权限，请重新绑定 ESI';
const esiList = { charId: null, fits: null, loading: false, error: '', ship: null };   // ship：分类视图里点开的舰船
// 分类视图的船级（按舰船分组归类，没列到的归「其他」）
const ESI_CLASSES = [
  ['护卫舰', [25, 237, 324, 830, 831, 834, 893, 1283, 1527]], ['驱逐舰', [420, 541, 1305, 1534]],
  ['巡洋舰', [26, 358, 832, 833, 894, 906, 963, 1972]], ['战列巡洋舰', [419, 540, 1201]], ['战列舰', [27, 898, 900]],
  ['旗舰', [30, 485, 547, 659, 1538, 4594, 5120]], ['工业舰 / 采矿船', [28, 380, 463, 513, 543, 883, 902, 941, 1202, 4902]],
];
const esiClassOf = (t) => ESI_CLASSES.findIndex(([, g]) => g.includes(t?.group));

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

// ---------- 当前舰船（ESI /ship/ + 资产）----------
// 资产里船上的物品 location_id 指向舰船物品 ID，位置标记与游戏装配相同；已装填的弹药与装备同一槽位标记
async function shipFit() {
  const cur = await app.getCurrentShip();
  const items = [], charges = [];
  for (const it of cur.items) {
    const t = type(it.type_id), where = parseFlag(it.location_flag);
    if (where.slot && t?.category === FE.CAT.charge) { charges.push([where, t.id]); continue; }
    if (where.slot || where.bay === 'DroneBay' || where.bay === 'FighterBay') items.push({ type_id: it.type_id, flag: it.location_flag, quantity: it.quantity });
  }
  const r = fromEsiFit({ ship_type_id: cur.ship_type_id, name: cur.ship_name || '', items });
  if (r.error) return r;
  for (const [w, id] of charges) {
    const m = w.slot !== 'sub' && r.fit.slots[w.slot][w.index];
    if (m && FE.chargeFits(type(m.type), type(id))) m.charge = id;
  }
  return r;
}

async function importCurrentShip(btn) {
  btn.disabled = true;
  try {
    const r = await shipFit();
    if (r.error) { app.showToast(r.error, 'error'); return; }
    stashDraft(F.fit);
    F.fit = r.fit;
    F.selected = null;
    autoActivateDrones();
    recompute();
    app.showToast(r.skipped ? `已导入当前舰船，${r.skipped} 项暂不支持已忽略` : '已导入当前舰船（资产数据最多晚 1 小时）', r.skipped ? 'info' : 'success', 4000);
  } catch (error) {
    app.showToast('读取当前舰船失败：' + esiErrorText(error), 'error', 4000);
  } finally {
    btn.disabled = false;
  }
}

// 倒卖排行「按当前舰船规划」：当前舰船装配后的货舱容量（按角色技能，读不到时按全 5 级）
export async function currentShipCargo() {
  const data = await ensureData();
  const r = await shipFit();
  if (r.error) throw new Error(r.error);
  let levels = 'max';
  try { levels = (await app.getCharacterSkills()).levels; } catch { /* 按全 5 级 */ }
  const calc = FE.computeFit(data, r.fit, levels);
  const cargo = calc ? FE.fitStats(calc).cargo : type(r.fit.ship)?.attrs.get(FE.AT.capacity) || 0;
  return { ship: r.fit.ship, shipName: type(r.fit.ship)?.name || '', name: r.fit.name, cargo };
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

// 击杀详情里的圆盘：用装配页同一套圆盘画出这艘船击杀时的装配（只看，不能点；悬停显示装备名），顺带给出舰船分组名（「拦截舰」等）。
// 算的时候临时换掉装配页的状态，算完换回去，不影响装配页正在编辑的装配
export async function killRadial(km) {
  const data = await ensureData();
  const ship = data.types.get(km.victim.ship_type_id);
  const group = ship ? data.groups.get(ship.group)?.name || '' : '';
  if (!ship || ship.category !== FE.CAT.ship) return { group, svg: '' };
  const keep = { fit: F.fit, calc: F.calc, stats: F.stats, selected: F.selected, target: F.target, preview: F.preview };
  try {
    const r = fromKillmail(km);
    if (r.error) return { group, svg: '' };
    const calc = FE.computeFit(data, r.fit, 'max');
    const stats = calc && FE.fitStats(calc);
    if (!stats) return { group, svg: '' };
    Object.assign(F, { fit: r.fit, calc, stats, selected: null, target: null, preview: null });
    let svg = /<svg viewBox="0 0 512 512"[\s\S]*<\/svg>/.exec(radialHtml(ship, stats))?.[0] || '';
    svg = svg.replace(/id="fr(ShipClip|Vignette)"/g, 'id="km$1"').replace(/url\(#fr(ShipClip|Vignette)\)/g, 'url(#km$1)')
      .replace(/ data-fit-[a-z-]+="[^"]*"| role="button"| tabindex="0"/g, '')
      .replace(/(<g class="fr-slot fr-mod[^"]*" aria-label="([^"]*)">)/g, '$1<title>$2</title>');
    return { group, svg };
  } catch (error) {
    console.warn('击杀圆盘失败', error);
    return { group, svg: '' };
  } finally {
    Object.assign(F, keep);
  }
}

// 其他页面（快递推荐用船）带来的 EFT 装配：同样先记下，进入装配页时载入
let pendingEft = null;
export function queueEftFit(text) {
  pendingEft = text;
}

// 战场模拟「在装配页打开」带来的装配
let pendingFit = null;
function loadPendingFit() {
  if (!pendingFit) return false;
  stashDraft(F.fit);
  F.fit = normalize(pendingFit);
  pendingFit = null;
  F.selected = null;
  autoActivateDrones();
  app.showToast('已在装配页打开', 'success');
  return true;
}

function loadPending() {
  return loadPendingFit() || loadPendingKill() || loadPendingEft() || loadPendingShip();
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
  app.showToast('已载入推荐装配「' + (fit.name || '') + '」', 'success', 3500);
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
  app.showToast(r.skipped ? `已载入击杀装配，${r.skipped} 项暂不支持已忽略` : '已载入击杀装配', r.skipped ? 'info' : 'success', 3500);
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
  esiList.ship = null;
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
  let list = esiList.fits.filter((f) => !shipOnly || f.ship_type_id === ship).filter((f) => !q || f.name.toLowerCase().includes(q) || (type(f.ship_type_id)?.name || '').toLowerCase().includes(q) || (type(f.ship_type_id)?.en || '').toLowerCase().includes(q));
  $('fitEsiCount').textContent = `${esiList.fits.length} / 500`;
  if (!list.length) {
    const text = !esiList.fits.length ? '游戏里还没有个人装配'
      : shipOnly && !q ? `游戏里没有${type(ship)?.name || '这艘船'}的个人装配`
        : '没有匹配的装配';
    box.innerHTML = `<p class="fit-esi-empty">${app.esc(text)}</p>`;
    return;
  }
  // 看全部且没搜索时分类显示：船级 → 有装配的舰船（点开）→ 装配
  if (!shipOnly && !q && !esiList.ship) {
    const byShip = new Map();
    for (const f of list) byShip.set(f.ship_type_id, (byShip.get(f.ship_type_id) || 0) + 1);
    const classes = ESI_CLASSES.map(([name]) => ({ name, ships: [] })).concat({ name: '其他', ships: [] });
    for (const [id, n] of byShip) { const t = type(id), k = esiClassOf(t); classes[k < 0 ? classes.length - 1 : k].ships.push({ id, t, n }); }
    box.innerHTML = classes.filter((c) => c.ships.length).map((c) => `<section class="fit-esi-class">
      <h4>${c.name}<small>${c.ships.length} 艘 · ${c.ships.reduce((x, y) => x + y.n, 0)} 套</small></h4>
      <div class="fit-esi-ships">${c.ships.sort((a, b) => (F.data.groups.get(a.t?.group)?.name || '').localeCompare(F.data.groups.get(b.t?.group)?.name || '', 'zh') || (a.t?.name || '').localeCompare(b.t?.name || '', 'zh')).map((x) => `<button type="button" class="fit-esi-ship" data-esi-ship="${x.id}">
        <img src="${IMG(x.id, 'icon', 32)}" alt="" width="32" height="32" loading="lazy"><span><b>${app.esc(x.t?.name || '未知舰船 ' + x.id)}</b><small>${app.esc(F.data.groups.get(x.t?.group)?.name || '')} · ${x.n} 套</small></span></button>`).join('')}</div>
    </section>`).join('');
    return;
  }
  const back = !shipOnly && !q && esiList.ship ? `<button type="button" class="link-btn fit-esi-back" data-esi-back>‹ 全部舰船</button>` : '';
  if (back) list = list.filter((f) => f.ship_type_id === esiList.ship);
  if (back && !list.length) { esiList.ship = null; renderEsiList(); return; }   // 这艘船的装配删光了
  box.innerHTML = back + list.map((f) => {
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
  if ((x = el('[data-esi-ship]'))) { esiList.ship = Number(x.dataset.esiShip); renderEsiList(); $('fitEsiBody').scrollTop = 0; return; }
  if (el('[data-esi-back]')) { esiList.ship = null; renderEsiList(); return; }
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
    app.showToast(r.skipped ? `已打开，${r.skipped} 项暂不支持已忽略` : '已打开游戏装配', r.skipped ? 'info' : 'success', 3500);
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

// 紧凑格式（分享链接、广场「装配」帖子共用）
function toCompact(f) {
  return JSON.parse(JSON.stringify({
    s: f.ship, n: f.name || undefined,
    m: Object.fromEntries(FE.SLOTS.filter((s) => f.slots[s].length).map((s) => [s, f.slots[s].map((m) => (m ? [m.type, m.charge || 0, STATE_CODE[m.state], ...(m.mut ? [[m.mut.base, m.mut.mutator, m.mut.attrs]] : [])] : 0))])),
    d: f.drones.length ? f.drones.map((d) => [d.type, d.count, d.active]) : undefined,
    i: f.implants.length ? f.implants : undefined,
    o: f.mode || undefined
  }));
}
function fromCompact(c) {
  const fit = newFit(c.s);
  fit.name = c.n || '';
  for (const s of FE.SLOTS) fit.slots[s] = (c.m?.[s] || []).map((x) => (x ? { type: x[0], charge: x[1] || null, state: CODE_STATE[x[2]] || 'online', ...(x[3] ? { mut: { base: x[3][0], mutator: x[3][1], attrs: x[3][2] } } : {}) } : null));
  fit.drones = (c.d || []).map(([t, count, active]) => ({ type: t, count, active }));
  fit.implants = c.i || [];
  if (c.o) fit.mode = c.o;
  return fit;
}
// 广场发「装配」帖：当前装配（紧凑格式）与摘要；没有装配时为 null
// 还没进过装配页时读上次保存的当前装配
export async function currentFit() {
  const data = await ensureData();
  let fit = F.fit, stats = F.stats;
  if (!F.ready) {
    const saved = app.store.getJSON(CURRENT_KEY, null);
    fit = saved && data.types.has(saved.ship) ? normalize(saved) : null;
    try { const c = fit && FE.computeFit(data, fit); stats = c ? FE.fitStats(c) : null; } catch { stats = null; }
  }
  if (!fit) return null;
  const mods = FE.SLOTS.reduce((n, s) => n + fit.slots[s].filter(Boolean).length, 0);
  return { fit: toCompact(fit), ship: fit.ship, shipName: type(fit.ship)?.name || '', name: fit.name || '', mods, dps: stats?.weapon.total || 0 };
}
// AI 助手（ai.js）：按 EFT 文本算装配属性；skillMode 'character' 按已绑定角色的技能（读不到时按全 5 级）
// 返回 { fit, compact, stats, calc, data, unknown, missing } 或 { error }
export async function aiFit(eft, skillMode = 'max') {
  const data = await ensureData();
  const r = parseEft(String(eft || ''));
  if (r.error) return { error: r.error };
  let levels = 'max';
  if (skillMode === 'character' && app.hasEsiToken()) {
    try { levels = (await app.getCharacterSkills()).levels; } catch { /* 按全 5 级 */ }
  }
  const keep = F.fit;
  F.fit = r.fit;
  try { autoActivateDrones(); } finally { F.fit = keep; }
  const calc = FE.computeFit(data, r.fit, levels);
  if (!calc) return { error: '无法计算这艘船' };
  return {
    fit: r.fit, compact: toCompact(r.fit), stats: FE.fitStats(calc), calc, data, unknown: r.unknown,
    missing: levels === 'max' ? [] : FE.missingSkills(data, r.fit, levels).map((x) => `${x.type?.name || x.type} ${x.have}→${x.need}`)
  };
}

// AI 助手：智能装配（必装装备 + 侧重 + 最低要求），返回最好的几种方案，每种带 EFT 文本供 aiFit 计算
export async function aiAuto(opts) {
  await ensureData();
  let skills = 'max';
  if (opts.skills === 'character' && app.hasEsiToken()) {
    try { skills = (await app.getCharacterSkills()).levels; } catch { /* 按全 5 级 */ }
  }
  const out = await aiAutoFit({ ...opts, skills });
  return out.results.slice(0, 3).map((x) => ({ fit: x.fit, met: x.r.met, eft: toEft(x.fit) }));
}
export const aiAutoCancel = cancelCounterFit;
// AI 助手：击杀记录里这型船最近阵亡时的实际装配（同装配合并，按出现次数），每套带 EFT 文本供 aiFit 计算
export async function aiKbFits(ship, days = 30) {
  await ensureData();
  const r = await commonFit(ship, { days, limit: 300, top: 300 });
  return (r?.list || []).map((x) => ({ n: x.n, last: x.last, value: x.value, kill: x.kill, eft: toEft({ ...x.fit, name: `击杀记录 ×${x.n}` }) }));
}

// 广场「装配」帖子「在装配页打开」：进入装配页时载入
export function queueCompactFit(c) {
  pendingFit = fromCompact(c);
}

function shareUrl() {
  const compact = toCompact(F.fit);
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
    const fit = fromCompact(c);
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
