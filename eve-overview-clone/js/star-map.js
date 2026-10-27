// ===== 星图（旧版 3D 星图）=====
// 静态数据：map-data.json（build_map.mjs 由 CCP SDE 生成，星系真实三维坐标）
// 实时数据：ESI 公开接口（主权、击杀、跳跃、入侵、势力战争、路线），无需授权
// 渲染：three.js（WebGL），星系名与星域名绘制在叠加的 2D 画布上
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import * as JP from './jump-planner.js?v=v15';
import { SERVER, HUB, HUB_NAME, NO_KB_MESSAGE, serverKey, esiUrl, eveImage } from './server.js?v=s4';

let app;               // 主程序提供的工具函数
let canvas, labels, lg; // WebGL 画布、标签画布及其 2D 上下文
let renderer, scene, camera, controls;
let starPoints, focusPoints, gateLinesInner, gateLinesCross, routeLine;

const M = {
  ready: null,
  systems: [],         // { i, id, name, x, y, z, sec, region, constellation, faction, star, planets, stations, nbr: [] }
  byId: new Map(),
  regions: new Map(),  // id -> { id, name, faction, description, cx, cy, cz, systems: [] }
  constellations: new Map(),
  factions: {},
  gates: [],
  live: { sov: new Map(), kills: new Map(), jumps: new Map(), incursions: [], fw: new Map(), adm: new Map(), campaigns: [], names: new Map(), loadedAt: 0 },
  myLocation: null,    // 当前角色所在星系（system index）
  distance: null,      // { origin, hops: Int16Array }
  layer: 'security',
  selected: null,      // system index
  hover: null,
  highlight: null,     // Set<system index>：颜色说明中点选的高亮
  highlightKey: null,
  route: [],           // system index 数组
  routeStops: [],      // 星门路线的途经点 + 终点（星系 ID），写入游戏自动导航用
  dirty: true,
  running: false,
  tween: null,
  screen: null,        // Float32Array [x, y, depth] 每个星系的屏幕坐标（每帧更新，用于命中测试与标签）
  size: { w: 0, h: 0, dpr: 1 },
  view: '3d',          // 星图视图：3d（默认）/ 2d（游戏 2D 星图排布，俯视）
  morph: null          // 2D / 3D 切换过渡 { t0, dur, from, to, cur }
};
const VIEW_KEY = 'eve-map-view';
try { if (localStorage.getItem(VIEW_KEY) === '2d') M.view = '2d'; } catch { /* 忽略 */ }

const LIVE_TTL = 10 * 60e3;    // 实时数据缓存 10 分钟
const MAP_BG = '#05080d';

// 图层分组：基础 / 势力 / 活动（活动类为过去 1 小时数据）
const LAYER_GROUPS = [
  ['基础', [['security', '安全等级'], ['region', '星域'], ['distance', '跳数距离'], ['stations', 'NPC 空间站'], ['planets', '行星资源']]],
  ['势力', [['sov', '势力划分'], ['adm', '军事指数'], ['campaigns', '主权争夺'], ['fw', '势力战争']]],
  ['活动', [['kills', '舰船击毁'], ['pods', '太空舱击毁'], ['npc', 'NPC 击杀'], ['jumps', '跳跃'], ['incursions', '入侵']]],
  ['工业', [['industry', '工业成本指数']]]
];
// 活动类（击杀、跳跃）来自 ESI 每小时快照，与游戏内实时滚动的统计会有出入
const HOURLY = new Set(['kills', 'pods', 'npc', 'jumps']);
// 工业成本指数（ESI /industry/systems/，约每小时更新）：按活动分别着色
const IND_ACTS = [['manufacturing', '制造'], ['researching_time_efficiency', '时间效率研究'], ['researching_material_efficiency', '材料效率研究'], ['copying', '拷贝'], ['invention', '发明'], ['reaction', '反应']];
const IND = { promise: null, map: null, at: 0, act: 'manufacturing' };
try { IND.act = localStorage.getItem('eve-map-ind') || IND.act; } catch { /* 忽略 */ }
const LAYERS = LAYER_GROUPS.flatMap(([, list]) => list);
const LAYER_HINT = {
  security: '游戏内安全等级配色', region: '每个星域一种颜色', distance: `与选中星系的星门跳数（未选择时以${HUB_NAME}为起点）`,
  stations: '星系内 NPC 空间站数量', planets: '星系里能提取所选资源（或所选类型）的行星数量', sov: 'ESI 实时主权：NPC 阵营 / 玩家联盟', adm: '主权枢纽的军事指数（ADM），1–6，越高越难攻破',
  campaigns: '正在进行的主权争夺战', fw: '势力战争占领方与战况',
  kills: '过去 1 小时被击毁的玩家舰船（不含太空舱）', pods: '过去 1 小时被击毁的太空舱', npc: '过去 24 小时被击杀的 NPC 舰船（刷怪活跃度，与游戏星图一致）', jumps: '过去 1 小时的星门跳跃次数',
  incursions: '萨沙入侵影响的星系', industry: '星系内该项工业活动的系统成本指数：越多人在这里开工越高，越低越省安装费'
};
const CAMPAIGN_TYPE_ZH = { tcu_defense: '领土控制器防御', ihub_defense: '主权枢纽防御', station_defense: '空间站防御', station_freeport: '空间站自由港' };
const JITA_ID = HUB.hub.system;   // 默认起点：吉他（曙光服为索巴色基）
const DISTANCE_BUCKETS = [[0, 0, '起点'], [1, 1, '1 跳'], [2, 2, '2 跳'], [3, 3, '3 跳'], [4, 5, '4–5 跳'], [6, 10, '6–10 跳'], [11, 20, '11–20 跳'], [21, Infinity, '20 跳以上']];
const DISTANCE_COLORS = ['#ffffff', '#4fd1ff', '#3fb7f0', '#3a9ae0', '#5a7fd6', '#7a64c8', '#8a4fa8', '#5a3a70'];
const ADM_COLORS = { 1: '#e5484d', 2: '#f07a3a', 3: '#f2b134', 4: '#c9d33a', 5: '#7ad151', 6: '#30c88a' };

// 游戏内常用的安全等级配色
const SEC_COLORS = {
  '1.0': '#2fefef', '0.9': '#48f0c0', '0.8': '#00ef47', '0.7': '#00f000', '0.6': '#8fef2f',
  '0.5': '#efef00', '0.4': '#d77700', '0.3': '#f06000', '0.2': '#f04800', '0.1': '#d73000', '0.0': '#f00000'
};
const SEC_KEYS = Object.keys(SEC_COLORS);

// 主要阵营配色；其他阵营与玩家联盟按 ID 生成稳定的颜色
const FACTION_COLORS = {
  500001: '#4a9fdc', 500002: '#c8553d', 500003: '#d9a93a', 500004: '#4fb37a', 500005: '#9b7bd4',
  500006: '#8fb3d9', 500007: '#b8865b', 500008: '#c79a2f', 500010: '#7f8c8d', 500011: '#a0522d',
  500012: '#6c7a89', 500014: '#9e6b8e', 500015: '#5d8aa8', 500019: '#7bc043', 500026: '#d03a3a'
};
const NONE_COLOR = '#3a4352';
const DIM_COLOR = '#1f2632';

const ISOTOPE_ZH = { 16274: '氦同位素', 17887: '氧同位素', 17888: '氮同位素', 17889: '氢同位素' };
const ROUTE_COLORS = { gate: 0xffc400, jump: 0xff7a45 };
const ROUTE_FLAGS = [['shortest', '最短路线'], ['secure', '安全优先'], ['insecure', '低安优先']];
const FW_STATE_ZH = { uncontested: '未争夺', contested: '争夺中', vulnerable: '可被夺取', captured: '已被占领' };
const INCURSION_STATE_ZH = { established: '已建立', mobilizing: '动员中', withdrawing: '撤退中' };

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);

function secDisplay(sec) {
  if (sec > 0 && sec < 0.05) return 0.1;   // 与游戏一致：极低的正安等显示为 0.1
  return Math.max(0, Math.round(sec * 10) / 10);
}

function secColor(sec) {
  return SEC_COLORS[secDisplay(sec).toFixed(1)];
}

function secClass(sec) {
  const d = secDisplay(sec);
  return d >= 0.5 ? '高安' : d > 0 ? '低安' : '00';
}

function hashColor(id) {
  const h = (Number(id) * 137.508) % 360;
  return `hsl(${h.toFixed(0)}, 62%, 58%)`;
}

function factionColor(id) {
  return FACTION_COLORS[id] || hashColor(id);
}

function heat(value, max, hue) {
  if (!value) return DIM_COLOR;
  const t = Math.min(1, Math.log1p(value) / Math.log1p(max || 1));
  const light = 32 + t * 36;
  return `hsl(${hue}, ${70 + t * 25}%, ${light.toFixed(0)}%)`;
}

function ownerOf(s) {
  const sov = M.live.sov.get(s.id);
  if (sov?.alliance_id) return { kind: 'alliance', id: sov.alliance_id };
  if (sov?.faction_id) return { kind: 'faction', id: sov.faction_id };
  return null;
}

function ownerName(owner) {
  if (!owner) return '无主';
  if (owner.kind === 'faction') return M.factions[owner.id]?.name || '阵营 ' + owner.id;
  return M.live.names.get(owner.id) || '联盟 ' + owner.id;
}

function ownerLogo(owner, size = 32) {
  if (!owner) return '';
  const path = owner.kind === 'faction' ? `corporations/${owner.id}/logo` : `alliances/${owner.id}/logo`;
  return eveImage(path, size);
}

function regionName(id) { return M.regions.get(id)?.name || ''; }
function constellationName(id) { return M.constellations.get(id)?.name || ''; }

// ---------- 数据 ----------
async function loadStatic() {
  const res = await fetch(SERVER.mapData);
  if (!res.ok) throw new Error('星图数据加载失败 HTTP ' + res.status);
  const data = await res.json();
  M.factions = data.factions;
  for (const [id, name, faction, description] of data.regions) {
    M.regions.set(id, { id, name, faction, description, cx: 0, cy: 0, cz: 0, systems: [] });
  }
  for (const [id, name, region] of data.constellations) M.constellations.set(id, { id, name, region });
  // x / y / z 为真实三维坐标（光年计算用）；rx / ry / rz 为当前画面坐标，3D 时等于真实坐标，2D 时为游戏 2D 星图的平面排布
  // 星图数据没有 2D 坐标的服务器（曙光）只有 3D
  M.has2d = data.systems[0]?.[12] != null;
  if (!M.has2d) M.view = '3d';
  M.systems = data.systems.map(([id, name, x, y, z, sec, region, constellation, faction, star, planets, stations, p2], i) =>
    ({ i, id, name, x, y, z, sec, region, constellation, faction, star, planets, stations, nbr: [], lower: name.toLowerCase(),
      p2: p2 ? [p2[0], 0, p2[1]] : [x, y, z], rx: x, ry: y, rz: z }));
  for (const s of M.systems) {
    M.byId.set(s.id, s);
    const r = M.regions.get(s.region);
    if (r) { r.systems.push(s.i); r.cx += s.x; r.cy += s.y; r.cz += s.z; }
  }
  for (const r of M.regions.values()) {
    if (r.systems.length) { r.cx /= r.systems.length; r.cy /= r.systems.length; r.cz /= r.systems.length; }
  }
  M.gates = data.gates;
  for (const [a, b] of M.gates) { M.systems[a].nbr.push(b); M.systems[b].nbr.push(a); }
  M.screen = new Float32Array(M.systems.length * 3);
  setRenderPositions(M.view === '2d' ? 1 : 0, false);
}

// ---------- 2D / 3D ----------
// t：0 = 3D，1 = 2D，切换时在两者之间插值做过渡动画
function setRenderPositions(t, apply = true) {
  for (const s of M.systems) {
    s.rx = s.x + (s.p2[0] - s.x) * t;
    s.ry = s.y * (1 - t);
    s.rz = s.z + (s.p2[2] - s.z) * t;
  }
  for (const r of M.regions.values()) {
    let x = 0, y = 0, z = 0;
    for (const i of r.systems) { const s = M.systems[i]; x += s.rx; y += s.ry; z += s.rz; }
    const n = r.systems.length || 1;
    r.rcx = x / n; r.rcy = y / n; r.rcz = z / n;
  }
  if (!apply || !starPoints) return;
  const pos = starPoints.geometry.attributes.position;
  for (const s of M.systems) pos.setXYZ(s.i, s.rx, s.ry, s.rz);
  pos.needsUpdate = true;
  for (const [lines, same] of [[gateLinesInner, true], [gateLinesCross, false]]) {
    const lp = lines.geometry.attributes.position;
    let n = 0;
    for (const [a, b] of M.gates) {
      const sa = M.systems[a], sb = M.systems[b];
      if ((sa.region === sb.region) !== same) continue;
      lp.setXYZ(n++, sa.rx, sa.ry, sa.rz);
      lp.setXYZ(n++, sb.rx, sb.ry, sb.rz);
    }
    lp.needsUpdate = true;
    lines.geometry.computeBoundingSphere();
  }
  starPoints.geometry.computeBoundingSphere();
  updateRouteLine();
  invalidate();
}

// 2D：俯视、不能旋转，左键平移；3D：左键旋转、右键平移
function applyControlMode() {
  const flat = M.view === '2d';
  controls.enableRotate = !flat;
  controls.mouseButtons = { LEFT: flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  $('mapTopView').hidden = flat;
  const btn = $('mapViewToggle');
  btn.hidden = !M.has2d;
  btn.textContent = flat ? '3D' : '2D';
  btn.title = flat ? '切换到 3D 星图 (V)' : '切换到 2D 星图 (V)';
  btn.setAttribute('aria-pressed', String(flat));
  $('mapHint').textContent = flat ? '拖动平移 · 滚轮缩放 · 双击聚焦' : '拖动旋转 · 右键平移 · 滚轮缩放 · 双击聚焦';
}

function setView(view) {
  if (!M.has2d || (view === M.view && !M.morph)) return;
  M.view = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* 忽略 */ }
  applyControlMode();
  const from = M.morph ? M.morph.cur : view === '2d' ? 0 : 1, to = view === '2d' ? 1 : 0;
  // 镜头按切换后的坐标定位：有选中星系时对准它（保持距离），否则显示全部；2D 为正上方俯视，3D 恢复斜视
  setRenderPositions(to, false);
  if (M.selected != null) {
    const sel = M.systems[M.selected];
    flyTo(new THREE.Vector3(sel.rx, sel.ry, sel.rz), camera.position.distanceTo(controls.target), view === '2d' ? TOP_DIR : OVERVIEW_DIR);
  } else fitAll();
  setRenderPositions(from, false);
  M.tween.dur = 700;
  M.morph = { t0: performance.now(), dur: 700, from, to, cur: from };
}

function stepMorph() {
  const m = M.morph;
  const t = Math.min(1, (performance.now() - m.t0) / m.dur);
  m.cur = m.from + (m.to - m.from) * easeInOut(t);
  setRenderPositions(m.cur);
  if (t >= 1) M.morph = null;
}

// 读 ESI 并记下数据生成时间（Last-Modified），用于提示「快照截至几点」
async function fetchStamped(path, key) {
  const res = await fetch(esiUrl(path), { headers: { 'Accept-Language': 'zh' } });
  if (!res.ok) throw new Error('ESI ' + res.status);
  const at = Date.parse(res.headers.get('last-modified') || '');
  if (at) M.live[key] = at;
  return res.json();
}
// NPC 击杀：有 24 小时累计时用它，否则用 ESI 过去 1 小时
const npcKills = (id) => (M.live.npc24 ? M.live.npc24.get(id) || 0 : M.live.kills.get(id)?.npc_kills || 0);
const npcSpan = () => (M.live.npc24 ? (M.live.npc24Info.hours >= 24 ? '24 小时' : `近 ${M.live.npc24Info.hours} 小时`) : '1 小时');
const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
function hourlyNote() {
  if (M.layer === 'npc' && M.live.npc24) {
    const h = M.live.npc24Info.hours;
    return `过去 ${h >= 24 ? 24 : h} 小时累计（本站每小时存一份 ESI 快照再相加，截至 ${hhmm(M.live.npc24Info.to)}）` + (h < 24 ? '；服务刚开始记录，满 24 小时后与游戏一致' : '');
  }
  const at = M.layer === 'jumps' ? M.live.jumpsAt : M.live.killsAt;
  return at ? `ESI 每小时更新一次快照（这份截至 ${hhmm(at)}），游戏内是实时滚动统计，数字会有出入` : 'ESI 每小时更新一次快照，游戏内是实时滚动统计，数字会有出入';
}

function loadIndustry() {
  if (!IND.promise) IND.promise = fetchStamped('/industry/systems/', 'indAt').then((list) => {
    IND.map = new Map(list.map((x) => [x.solar_system_id, Object.fromEntries(x.cost_indices.map((c) => [c.activity, c.cost_index]))]));
    if (M.layer === 'industry') { computeLayer(); renderLayerList(); renderLegend(); }
    const box = $('mapIndBlock');
    if (box && M.selected != null) box.outerHTML = industryHtml(M.systems[M.selected]);
  }).catch((e) => { IND.promise = null; console.error('工业指数加载失败', e); });
  return IND.promise;
}
const pct = (v) => (v * 100).toFixed(v < 0.1 ? 2 : 1) + '%';
function industryHtml(s) {
  const c = IND.map?.get(s.id);
  if (!IND.map) return '<div id="mapIndBlock" class="map-ind"><p class="map-info-note">读取工业成本指数…</p></div>';
  if (!c) return '<div id="mapIndBlock" class="map-ind"></div>';
  return `<div id="mapIndBlock" class="map-ind"><div class="map-ind-head">工业成本指数</div><div class="map-ind-grid">${IND_ACTS.map(([k, l]) => `<span${k === IND.act && M.layer === 'industry' ? ' class="on"' : ''}><em>${l}</em><b>${c[k] != null ? pct(c[k]) : '—'}</b></span>`).join('')}</div></div>`;
}
function indOptions() {
  return `<select class="region-select map-pi-pick" data-ind-pick aria-label="工业活动">${IND_ACTS.map(([k, l]) => `<option value="${k}"${IND.act === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` +
    (IND.map ? '' : '<p class="layer-hint">读取工业成本指数…</p>');
}

// 进行中的请求复用同一个 Promise（空闲预取与打开星图可能同时触发）
let liveInflight = null;
function loadLive(force = false, quiet = false) {
  if (!force && Date.now() - M.live.loadedAt < LIVE_TTL) return Promise.resolve();
  if (!liveInflight) liveInflight = loadLiveImpl(quiet).finally(() => { liveInflight = null; });
  return liveInflight;
}

async function loadLiveImpl(quiet) {
  const results = await Promise.allSettled([
    app.fetchESI('/sovereignty/map/'),
    fetchStamped('/universe/system_kills/', 'killsAt'),
    fetchStamped('/universe/system_jumps/', 'jumpsAt'),
    app.fetchESI('/incursions/'),
    app.fetchESI('/fw/systems/'),
    app.fetchESI('/sovereignty/structures/'),
    app.fetchESI('/sovereignty/campaigns/'),
    fetch('/api/v1/map/kills?server=' + SERVER.id).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]);
  const [sov, kills, jumps, incursions, fw, structures, campaigns, k24] = results;
  // NPC 击杀按 24 小时（与游戏星图一致）：本站后端把 ESI 每小时快照累加；没有后端时退回 1 小时
  const d24 = k24.status === 'fulfilled' && k24.value?.hours ? k24.value : null;
  M.live.npc24 = d24 ? new Map(Object.entries(d24.systems).map(([id, v]) => [Number(id), v[2]])) : null;
  M.live.npc24Info = d24 ? { hours: d24.hours, to: d24.to * 1000 } : null;
  if (structures.status === 'fulfilled') {
    M.live.adm = new Map();
    for (const st of structures.value) {
      const prev = M.live.adm.get(st.solar_system_id);
      if (!prev || (st.vulnerability_occupancy_level || 0) > (prev.vulnerability_occupancy_level || 0)) M.live.adm.set(st.solar_system_id, st);
    }
  }
  if (campaigns.status === 'fulfilled') M.live.campaigns = campaigns.value;
  if (sov.status === 'fulfilled') M.live.sov = new Map(sov.value.map((x) => [x.system_id, x]));
  if (kills.status === 'fulfilled') M.live.kills = new Map(kills.value.map((x) => [x.system_id, x]));
  if (jumps.status === 'fulfilled') M.live.jumps = new Map(jumps.value.map((x) => [x.system_id, x.ship_jumps]));
  if (incursions.status === 'fulfilled') M.live.incursions = incursions.value;
  if (fw.status === 'fulfilled') M.live.fw = new Map(fw.value.map((x) => [x.solar_system_id, x]));
  const failed = results.slice(0, 7).filter((r) => r.status === 'rejected').length;
  if (failed && !quiet) app.showToast(failed + ' 项实时数据加载失败，部分着色方式可能没有数据', 'error');

  // 玩家联盟名称保留原名
  const alliances = [...new Set([
    ...[...M.live.sov.values()].map((x) => x.alliance_id),
    ...M.live.campaigns.map((c) => c.defender_id)
  ].filter(Boolean))].filter((id) => !M.live.names.has(id));
  if (alliances.length) {
    const named = await app.resolveNames(alliances);
    for (const [k, v] of named.names) M.live.names.set(k, v);
  }
  M.live.loadedAt = Date.now();
  $('mapUpdated').textContent = '实时数据更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 来源 ESI';
}

// ---------- 颜色 / 图层 ----------
let layerCache = null;   // { max, colors: [] }

// 数值类图层的取值函数（用于热度着色与排行）
// 行星资源（pi-data.json，与行星工业规划共用）：每个星系的行星类型代码串，按所选 P0 资源 / 行星类型计数
const PI = { promise: null, data: null, bySystem: new Map(), pick: 'res:2073' };
try { PI.pick = localStorage.getItem('eve-map-pi') || PI.pick; } catch { /* 忽略 */ }
function loadPiData() {
  if (!PI.promise) PI.promise = fetch('./pi-data.json?v=2').then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))).then((d) => {
    PI.data = d;
    for (const [id, codes] of d.systems) PI.bySystem.set(id, codes);
    if (M.layer === 'planets') { computeLayer(); renderLayerList(); renderLegend(); }
  }).catch((e) => { PI.promise = null; console.error('行星数据加载失败', e); });
  return PI.promise;
}
function piCount(s) {
  const codes = PI.bySystem.get(s.id);
  if (!codes || !PI.data) return 0;
  if (PI.wantKey !== PI.pick) {
    const [kind, v] = PI.pick.split(':');
    PI.want = new Set(Object.values(PI.data.planetTypes).filter((t) => (kind === 'type' ? t.code === v : t.res.includes(Number(v)))).map((t) => t.code));
    PI.wantKey = PI.pick;
  }
  const want = PI.want;
  let n = 0;
  for (const c of codes) if (want.has(c)) n++;
  return n;
}
function piOptions() {
  if (!PI.data) return '<p class="layer-hint">读取行星数据…</p>';
  const res = Object.entries(PI.data.commodities).filter(([, c]) => c[2] === 0).sort((a, b) => a[1][0].localeCompare(b[1][0], 'zh-CN'));
  const types = Object.values(PI.data.planetTypes);
  return `<select class="region-select map-pi-pick" data-pi-pick aria-label="行星资源">
    <optgroup label="P0 资源">${res.map(([id, c]) => `<option value="res:${id}"${PI.pick === 'res:' + id ? ' selected' : ''}>${app.esc(c[0])}</option>`).join('')}</optgroup>
    <optgroup label="行星类型">${types.map((t) => `<option value="type:${t.code}"${PI.pick === 'type:' + t.code ? ' selected' : ''}>${app.esc(t.name)}</option>`).join('')}</optgroup></select>`;
}

const LAYER_METRIC = {
  planets: piCount,
  kills: (s) => M.live.kills.get(s.id)?.ship_kills || 0,
  pods: (s) => M.live.kills.get(s.id)?.pod_kills || 0,
  industry: (s) => (IND.map?.get(s.id)?.[IND.act] || 0) * 100,   // 百分比
  npc: (s) => npcKills(s.id),
  jumps: (s) => M.live.jumps.get(s.id) || 0,
  stations: (s) => s.stations.length
};

// 星门跳数：从起点做广度优先搜索
function computeDistances() {
  const origin = M.selected ?? M.byId.get(JITA_ID)?.i ?? 0;
  if (M.distance?.origin === origin) return;
  const hops = new Int16Array(M.systems.length).fill(-1);
  hops[origin] = 0;
  const queue = [origin];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of M.systems[cur].nbr) if (hops[n] < 0) { hops[n] = hops[cur] + 1; queue.push(n); }
  }
  M.distance = { origin, hops };
}

function computeLayer() {
  const colors = new Array(M.systems.length);
  let max = 0;
  const metric = LAYER_METRIC[M.layer];
  if (metric) for (const s of M.systems) max = Math.max(max, metric(s));
  if (M.layer === 'distance') computeDistances();
  const campaignSystems = new Map(M.live.campaigns.map((c) => [c.solar_system_id, c]));
  const infested = new Map();
  for (const inc of M.live.incursions) for (const id of inc.infested_solar_systems) infested.set(id, inc);
  for (const s of M.systems) {
    let c;
    switch (M.layer) {
      case 'sov': { const o = ownerOf(s); c = o ? (o.kind === 'faction' ? factionColor(o.id) : hashColor(o.id)) : NONE_COLOR; break; }
      case 'kills': c = heat(metric(s), max, 8); break;
      case 'pods': c = heat(metric(s), max, 350); break;
      case 'industry': c = heat(metric(s), max, 270); break;
      case 'npc': c = heat(metric(s), max, 32); break;
      case 'jumps': c = heat(metric(s), max, 190); break;
      case 'stations': c = heat(metric(s), max, 48); break;
      case 'planets': c = heat(metric(s), max, 140); break;
      case 'region': c = hashColor(s.region * 7 + 3); break;
      case 'distance': { const h = M.distance.hops[s.i]; c = h < 0 ? DIM_COLOR : DISTANCE_COLORS[DISTANCE_BUCKETS.findIndex(([lo, hi]) => h >= lo && h <= hi)]; break; }
      case 'adm': { const a = M.live.adm.get(s.id); c = a ? ADM_COLORS[Math.min(6, Math.max(1, Math.floor(a.vulnerability_occupancy_level || 1)))] : DIM_COLOR; break; }
      case 'campaigns': c = campaignSystems.has(s.id) ? '#ff6b3d' : DIM_COLOR; break;
      case 'incursions': c = infested.has(s.id) ? '#b45cff' : DIM_COLOR; break;
      case 'fw': { const f = M.live.fw.get(s.id); c = f ? factionColor(f.occupier_faction_id) : DIM_COLOR; break; }
      default: c = secColor(s.sec);
    }
    colors[s.i] = c;
  }
  layerCache = { max, colors, infested };
  applyColors();
}

function setLayer(layer) {
  M.layer = layer;
  if (layer === 'planets' && !PI.data) loadPiData();
  if (layer === 'industry' && !IND.map) loadIndustry();
  M.highlight = null;
  M.highlightKey = null;
  computeLayer();
  renderLayerList();
  renderLegend();
  invalidate();
}

// ---------- 场景 ----------
// 星系点：圆形光点，近大远小，颜色随图层变化
// boost：0 普通，1 悬停（变大变亮），2 选中（更大，亮白核心 + 光晕）
const STAR_VERTEX = `
  attribute float size;
  attribute float boost;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vBoost;
  uniform float scale;
  void main() {
    vColor = color;
    vBoost = boost;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(size * scale / -mv.z, 2.6, 16.0) * (1.0 + boost * 1.1) + boost * 6.0;
    gl_Position = projectionMatrix * mv;
  }`;
const STAR_FRAGMENT = `
  varying vec3 vColor;
  varying float vBoost;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    if (vBoost < 0.5) {
      float core = smoothstep(1.0, 0.0, d);
      gl_FragColor = vec4(vColor * (0.7 + 0.6 * core), smoothstep(1.0, 0.64, d));
      return;
    }
    // 高亮：实心亮核 + 向外衰减的光晕
    float coreEdge = vBoost > 1.5 ? 0.34 : 0.42;
    float core = smoothstep(coreEdge + 0.08, coreEdge, d);
    float halo = pow(1.0 - d, 2.2) * (vBoost > 1.5 ? 0.85 : 0.55);
    vec3 col = mix(vColor * 1.25, vec3(1.0), core * (vBoost > 1.5 ? 0.55 : 0.3));
    gl_FragColor = vec4(col, max(core, halo));
  }`;

const FOCUS_MAX = 2 + 24;               // 悬停 + 选中 + 会战星系（会战接口最多返回 20 个）

function buildScene() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(MAP_BG, 1);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.5, 8000);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = 2;
  controls.maxDistance = 2600;
  controls.rotateSpeed = 0.6;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.addEventListener('change', invalidate);

  // 背景星空
  const bg = new Float32Array(2400 * 3);
  for (let n = 0; n < 2400; n++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = 3500;
    const k = Math.sqrt(1 - u * u);
    bg.set([r * k * Math.cos(t), r * u, r * k * Math.sin(t)], n * 3);
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(bg, 3));
  scene.add(new THREE.Points(bgGeo, new THREE.PointsMaterial({ color: 0x8090a8, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false })));

  // 星门连接：星域内 / 跨星域
  const inner = [], cross = [];
  for (const [a, b] of M.gates) {
    const sa = M.systems[a], sb = M.systems[b];
    (sa.region === sb.region ? inner : cross).push(sa.rx, sa.ry, sa.rz, sb.rx, sb.ry, sb.rz);
  }
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const lineGeo = (arr) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return geo; };
  gateLinesInner = new THREE.LineSegments(lineGeo(inner), lineMat(0x6e82a0, 0.32));
  gateLinesCross = new THREE.LineSegments(lineGeo(cross), lineMat(0x9678d2, 0.42));
  scene.add(gateLinesInner, gateLinesCross);

  // 星系
  const n = M.systems.length;
  const pos = new Float32Array(n * 3);
  M.systems.forEach((s) => pos.set([s.rx, s.ry, s.rz], s.i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n).fill(2.4), 1));
  geo.setAttribute('boost', new THREE.BufferAttribute(new Float32Array(n), 1));
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 900 } },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    depthWrite: false
  });
  starPoints = new THREE.Points(geo, starMaterial);
  scene.add(starPoints);

  // 悬停 / 选中 / 会战的星系单独画在最上层，高亮的光点不会被相邻星系遮住
  const focusGeo = new THREE.BufferGeometry();
  focusGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FOCUS_MAX * 3), 3));
  focusGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FOCUS_MAX * 3), 3));
  focusGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(FOCUS_MAX).fill(2.4), 1));
  focusGeo.setAttribute('boost', new THREE.BufferAttribute(new Float32Array(FOCUS_MAX), 1));
  focusPoints = new THREE.Points(focusGeo, starMaterial.clone());
  focusPoints.material.depthTest = false;
  focusPoints.material.uniforms = starMaterial.uniforms;   // 共享缩放参数
  focusPoints.renderOrder = 10;
  focusPoints.frustumCulled = false;
  scene.add(focusPoints);

  // 路线：带宽度的线
  routeLine = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffc400, linewidth: 3, transparent: true, opacity: 0.95, depthTest: false }));
  routeLine.visible = false;
  routeLine.renderOrder = 9;
  scene.add(routeLine);
}

// 根据当前着色方式与颜色说明中的高亮更新星系颜色
const tmpColor = new THREE.Color();
// 本地日志的敌情标记（intel.js）：星系 ID -> { clear }；有人报敌情标红并放大，报平安标绿
const INTEL_HOSTILE = '#ff3b3b', INTEL_CLEAR = '#3ddc84';
function applyColors() {
  if (!starPoints || !layerCache) return;
  const colors = starPoints.geometry.attributes.color;
  const sizes = starPoints.geometry.attributes.size;
  const hl = M.highlight;
  for (const s of M.systems) {
    const dim = hl && !hl.has(s.i);
    const intel = M.intel?.get(s.id);
    tmpColor.setStyle(intel ? (intel.clear ? INTEL_CLEAR : INTEL_HOSTILE) : dim ? DIM_COLOR : layerCache.colors[s.i]);
    colors.setXYZ(s.i, tmpColor.r, tmpColor.g, tmpColor.b);
    sizes.setX(s.i, intel ? (intel.clear ? 3.6 : 5) : dim ? 1.6 : hl ? 3.2 : 2.4);
  }
  colors.needsUpdate = true;
  sizes.needsUpdate = true;
  invalidate();
}

function updateRouteLine() {
  if (!routeLine) return;   // 场景尚未建立（初始化时恢复上次的规划方式）
  if (M.route.length < 2) { routeLine.visible = false; invalidate(); return; }
  const pts = [];
  for (const i of M.route) { const s = M.systems[i]; pts.push(s.rx, s.ry, s.rz); }
  routeLine.geometry.dispose();
  routeLine.geometry = new LineGeometry();
  routeLine.geometry.setPositions(pts);
  routeLine.computeLineDistances();
  routeLine.visible = true;
  invalidate();
}

// ---------- 相机 ----------
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// 平滑飞向目标点；保持当前视角方向，只改变焦点与距离
function flyTo(target, distance, direction) {
  const dir = direction ? direction.clone().normalize() : camera.position.clone().sub(controls.target).normalize();
  M.tween = {
    t0: performance.now(), dur: 650,
    fromTarget: controls.target.clone(), toTarget: target.clone(),
    fromPos: camera.position.clone(), toPos: target.clone().add(dir.multiplyScalar(distance))
  };
  invalidate();
}

function stepTween() {
  const tw = M.tween;
  const t = Math.min(1, (performance.now() - tw.t0) / tw.dur);
  const e = easeInOut(t);
  controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
  camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
  if (t >= 1) M.tween = null;
}

function fitTo(indices, padding = 1.15, direction) {
  if (!indices.length) return;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const i of indices) { const s = M.systems[i]; box.expandByPoint(v.set(s.rx, s.ry, s.rz)); }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 6);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
  flyTo(sphere.center, (radius / Math.sin(fit / 2)) * padding, direction);
}

// 默认视角：从南方上空斜看整个新伊甸，接近旧版游戏星图
const OVERVIEW_DIR = new THREE.Vector3(0, 1.35, 1);
const TOP_DIR = new THREE.Vector3(0, 1, 0.0001);
function fitAll(direction = M.view === '2d' ? TOP_DIR : OVERVIEW_DIR) {
  fitTo(M.systems.map((s) => s.i), 0.7, direction);
}

function topView() {
  fitTo(M.systems.map((s) => s.i), 0.78, TOP_DIR);
}

function dolly(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const len = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  flyTo(controls.target.clone(), len);
}

const NARROW = window.matchMedia('(max-width: 768px)');
// instant：直接移过去，不播放飞行动画（「我的位置」按钮用，且保持当前缩放）
function centerOn(i, maxDistance = 45, instant = false) {
  const s = M.systems[i];
  const dist = Math.min(camera.position.distanceTo(controls.target), maxDistance);
  const target = new THREE.Vector3(s.rx, s.ry, s.rz);
  if (NARROW.matches) {
    // 手机端信息面板是底部卡片（约占下半屏）：把焦点沿屏幕向下移，让星系显示在上方 1/4 处
    const dir = camera.position.clone().sub(controls.target).normalize();
    const up = camera.up.clone().sub(dir.clone().multiplyScalar(camera.up.dot(dir))).normalize();
    const visible = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    target.sub(up.multiplyScalar(visible * 0.25));
  }
  if (instant) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    M.tween = null;
    controls.target.copy(target);
    camera.position.copy(target).add(dir.multiplyScalar(dist));
    invalidate();
    return;
  }
  flyTo(target, dist);
}

// ---------- 渲染 ----------
function invalidate() {
  M.dirty = true;
}

function resize() {
  const rect = $('mapStage').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  M.size = { w: rect.width, h: rect.height, dpr };
  renderer.setPixelRatio(dpr);
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  starPoints.material.uniforms.scale.value = rect.height * dpr * 0.9;
  routeLine.material.resolution.set(rect.width, rect.height);
  labels.width = Math.round(rect.width * dpr);
  labels.height = Math.round(rect.height * dpr);
  invalidate();
}

function loop() {
  if (!M.running) return;
  requestAnimationFrame(loop);
  if (M.tween) stepTween();
  if (M.morph) stepMorph();
  const moved = controls.update();
  if (moved || M.dirty || M.tween || M.morph || M.flashes.length || M.battles.length) render();
}

const proj = new THREE.Vector3();
function project(x, y, z) {
  proj.set(x, y, z).project(camera);
  return [(proj.x + 1) / 2 * M.size.w, (1 - proj.y) / 2 * M.size.h, proj.z];
}

// 把悬停 / 选中 / 会战的星系写入高亮层（会战星系与选中同样效果；同一个星系只画一次）
function battleSystems() {
  const out = [];
  for (const b of M.battles) { const s = M.byId.get(b.system_id); if (s) out.push(s.i); }
  return out;
}

function updateFocus() {
  const geo = focusPoints.geometry;
  const pos = geo.attributes.position, col = geo.attributes.color, boost = geo.attributes.boost;
  const items = [];
  const seen = new Set();
  const add = (i, b) => { if (i != null && !seen.has(i) && items.length < FOCUS_MAX) { seen.add(i); items.push([i, b]); } };
  add(M.selected, 2);
  for (const i of battleSystems()) add(i, 2);
  add(M.hover, 1);
  items.forEach(([i, b], n) => {
    const s = M.systems[i];
    pos.setXYZ(n, s.rx, s.ry, s.rz);
    // 被颜色说明淡化的星系高亮时恢复当前着色
    tmpColor.setStyle(layerCache ? layerCache.colors[i] : '#ffffff');
    col.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
    boost.setX(n, b);
  });
  pos.needsUpdate = col.needsUpdate = boost.needsUpdate = true;
  geo.setDrawRange(0, items.length);
}

function render() {
  M.dirty = false;
  updateFocus();
  renderer.render(scene, camera);

  // 每个星系的屏幕坐标：命中测试与标签共用
  for (const s of M.systems) {
    const [sx, sy, sz] = project(s.rx, s.ry, s.rz);
    M.screen[s.i * 3] = sx;
    M.screen[s.i * 3 + 1] = sy;
    M.screen[s.i * 3 + 2] = sz;
  }
  drawLabels();
  drawBattles();
  drawFlashes();
}

function onScreen(i, margin = 0) {
  const x = M.screen[i * 3], y = M.screen[i * 3 + 1], z = M.screen[i * 3 + 2];
  return z > -1 && z < 1 && x > -margin && x < M.size.w + margin && y > -margin && y < M.size.h + margin;
}

// 标签：远处显示星域名，靠近后显示星系名（按距离挑选最近的若干个）
// 标签避让：与已放置的标签重叠时跳过
let placed = [];
function place(x, y, width, height) {
  for (const r of placed) {
    if (x < r[2] && x + width > r[0] && y < r[3] && y + height > r[1]) return false;
  }
  placed.push([x, y, x + width, y + height]);
  return true;
}

function drawLabels() {
  const { w, h, dpr } = M.size;
  lg.setTransform(dpr, 0, 0, dpr, 0, 0);
  lg.clearRect(0, 0, w, h);
  placed = [];
  const font = getComputedStyle(document.body).fontFamily;
  const dist = camera.position.distanceTo(controls.target);
  const hl = M.highlight;

  // 势力战争：争夺中的星系画圈
  if (M.layer === 'fw') {
    lg.lineWidth = 1.5;
    for (const f of M.live.fw.values()) {
      if (f.contested === 'uncontested') continue;
      const s = M.byId.get(f.solar_system_id);
      if (!s || !onScreen(s.i)) continue;
      lg.beginPath();
      lg.arc(M.screen[s.i * 3], M.screen[s.i * 3 + 1], 7, 0, Math.PI * 2);
      lg.strokeStyle = f.contested === 'vulnerable' ? '#ff4d4d' : '#ffd24d';
      lg.stroke();
    }
  }

  lg.textBaseline = 'middle';
  // 我的位置：在星系上方显示标记
  if (M.myLocation != null && onScreen(M.myLocation)) {
    const x = M.screen[M.myLocation * 3], y = M.screen[M.myLocation * 3 + 1];
    lg.font = `600 11px ${font}`;
    lg.textAlign = 'center';
    const text = '我的位置';
    const tw = lg.measureText(text).width + 12;
    lg.fillStyle = '#4f8ff7';
    lg.beginPath();
    lg.roundRect(x - tw / 2, y - 30, tw, 18, 9);
    lg.fill();
    lg.beginPath();
    lg.moveTo(x - 4, y - 12.5); lg.lineTo(x + 4, y - 12.5); lg.lineTo(x, y - 7);
    lg.fill();
    lg.fillStyle = '#ffffff';
    lg.fillText(text, x, y - 21);
    place(x - tw / 2, y - 30, tw, 18);
  }
  // 星系名：靠近时显示离镜头最近的星系；选中/悬停/路线上的星系总是显示（并优先放置）
  const battleIdx = battleSystems();
  const always = new Set([M.selected, M.hover, ...M.route, ...battleIdx].filter((i) => i != null));
  const systemLabel = (i, force) => {
    if (!onScreen(i)) return;
    const s = M.systems[i];
    const sx = M.screen[i * 3] + 7, sy = M.screen[i * 3 + 1];
    const showSec = dist < 50 || always.has(i);
    const width = lg.measureText(s.name).width + (showSec ? 26 : 0);
    if (!place(sx, sy - 7, width, 14) && !force) return;
    const faded = hl && !hl.has(i) && !always.has(i);
    lg.fillStyle = 'rgba(0, 0, 0, 0.6)';
    lg.fillText(s.name, sx + 1, sy + 1);
    lg.fillStyle = faded ? 'rgba(200, 210, 225, 0.3)' : always.has(i) ? '#ffffff' : 'rgba(215, 224, 238, 0.88)';
    lg.fillText(s.name, sx, sy);
    if (showSec) {
      lg.fillStyle = secColor(s.sec);
      lg.fillText(secDisplay(s.sec).toFixed(1), sx + lg.measureText(s.name).width + 4, sy);
    }
  };
  lg.textAlign = 'left';
  lg.font = `11px ${font}`;
  for (const i of [M.selected, M.hover]) if (i != null) systemLabel(i, true);
  for (const i of battleIdx) systemLabel(i, true);
  for (const i of M.route) systemLabel(i, false);
  // 会战星系：与选中一样显示星门相邻星系的名称
  for (const i of battleIdx) if (onScreen(i)) for (const n of M.systems[i].nbr) systemLabel(n, false);
  // 选中星系后：星门相邻的星系与屏幕上附近的星系也显示名称（不必放大或逐个点击）
  if (M.selected != null && onScreen(M.selected)) {
    const sx = M.screen[M.selected * 3], sy = M.screen[M.selected * 3 + 1];
    for (const n of M.systems[M.selected].nbr) systemLabel(n, false);
    const near = [];
    for (const s of M.systems) {
      if (s.i === M.selected || !onScreen(s.i)) continue;
      const d = (M.screen[s.i * 3] - sx) ** 2 + (M.screen[s.i * 3 + 1] - sy) ** 2;
      if (d < 200 * 200) near.push([d, s.i]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, i] of near.slice(0, 40)) systemLabel(i, false);
  }

  // 星域名：星系多的星域优先
  const regionAlpha = THREE.MathUtils.clamp((dist - 60) / 220, 0, 1);
  if (regionAlpha > 0.02) {
    lg.textAlign = 'center';
    lg.font = `600 12px ${font}`;
    const regions = [...M.regions.values()].filter((r) => r.systems.length).sort((a, b) => b.systems.length - a.systems.length);
    for (const r of regions) {
      const [sx, sy, sz] = project(r.rcx, r.rcy, r.rcz);
      if (sz <= -1 || sz >= 1 || sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20) continue;
      const width = lg.measureText(r.name).width;
      if (!place(sx - width / 2 - 3, sy - 8, width + 6, 16)) continue;
      lg.fillStyle = `rgba(0, 0, 0, ${0.6 * regionAlpha})`;
      lg.fillText(r.name, sx + 1, sy + 1);
      lg.fillStyle = `rgba(220, 228, 240, ${(hl ? 0.35 : 0.8) * regionAlpha})`;
      lg.fillText(r.name, sx, sy);
    }
  }

  // 放大到中等距离后显示星系名：离屏幕中心近的优先（视线焦点），再按碰撞避让放置
  const picks = [];
  if (dist < 220) {
    const cx = w / 2, cy = h / 2;
    for (const s of M.systems) {
      if (!onScreen(s.i, 20)) continue;
      const d = (M.screen[s.i * 3] - cx) ** 2 + (M.screen[s.i * 3 + 1] - cy) ** 2;
      picks.push([d, s.i]);
    }
    picks.sort((a, b) => a[0] - b[0]);
  }
  const limit = dist < 40 ? 300 : dist < 80 ? 200 : dist < 140 ? 120 : 60;
  lg.textAlign = 'left';
  lg.font = `11px ${font}`;
  for (const [, i] of picks.slice(0, limit)) if (!always.has(i)) systemLabel(i, false);
}

// ---------- 命中测试（屏幕空间，取最近且离镜头更近的星系）----------
function systemAt(px, py) {
  let best = null, bestScore = 14 * 14;
  for (const s of M.systems) {
    const z = M.screen[s.i * 3 + 2];
    if (z <= -1 || z >= 1) continue;
    const dx = M.screen[s.i * 3] - px, dy = M.screen[s.i * 3 + 1] - py;
    const d = dx * dx + dy * dy;
    if (d < bestScore) { bestScore = d; best = s.i; }
  }
  return best;
}

// ---------- 交互 ----------
function bindCanvas() {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.offsetX, y: e.offsetY, button: e.button };
    canvas.classList.add('dragging');
    $('mapTooltip').hidden = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down) return;
    const i = systemAt(e.offsetX, e.offsetY);
    if (i !== M.hover) {
      M.hover = i;
      canvas.style.cursor = i == null ? 'grab' : 'pointer';
      invalidate();
    }
    showTooltip(i, e.offsetX, e.offsetY);
  });
  window.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    if (!down) return;
    const moved = Math.abs(e.offsetX - down.x) + Math.abs(e.offsetY - down.y);
    if (moved < 5 && down.button === 0 && e.target === canvas) {
      const i = systemAt(e.offsetX, e.offsetY);
      if (i != null) selectSystem(i, false);
    }
    down = null;
  });
  canvas.addEventListener('pointerleave', () => { if (!down) { M.hover = null; $('mapTooltip').hidden = true; invalidate(); } });
  canvas.addEventListener('dblclick', (e) => {
    const i = systemAt(e.offsetX, e.offsetY);
    if (i != null) centerOn(i, 25);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  $('mapZoomIn').addEventListener('click', () => dolly(0.6));
  $('mapZoomOut').addEventListener('click', () => dolly(1 / 0.6));
  $('mapZoomReset').addEventListener('click', () => fitAll());
  $('mapTopView').addEventListener('click', topView);
  $('mapViewToggle').addEventListener('click', () => setView(M.view === '2d' ? '3d' : '2d'));
  applyControlMode();
  $('mapMyLocation').addEventListener('click', locateMe);
  new ResizeObserver(() => { if (!$('mapView').hidden) resize(); }).observe($('mapStage'));
}

function showTooltip(i, x, y) {
  const tip = $('mapTooltip');
  if (i == null) { tip.hidden = true; return; }
  const s = M.systems[i];
  const owner = ownerOf(s);
  let extra = '';
  if (M.layer === 'kills' || M.layer === 'pods' || M.layer === 'npc') { const k = M.live.kills.get(s.id); extra = `舰船 ${k ? k.ship_kills : 0} · 太空舱 ${k ? k.pod_kills : 0}（1 小时）· NPC ${app.formatNumber(npcKills(s.id))}（${npcSpan()}）`; }
  else if (M.layer === 'industry') { const v = IND.map?.get(s.id)?.[IND.act]; extra = `${IND_ACTS.find(([k]) => k === IND.act)[1]} ${v != null ? pct(v) : '—'}`; }
  else if (M.layer === 'jumps') extra = `跳跃 ${M.live.jumps.get(s.id) || 0}`;
  else if (M.layer === 'stations') extra = `${s.stations.length} 座 NPC 空间站`;
  else if (M.layer === 'distance') { const h = M.distance?.hops[s.i]; extra = h == null || h < 0 ? '无法到达' : `距 ${M.systems[M.distance.origin].name} ${h} 跳`; }
  else if (M.layer === 'adm') { const a = M.live.adm.get(s.id); extra = a ? `军事指数 ${(a.vulnerability_occupancy_level || 0).toFixed(1)} · ${ownerName(owner)}` : '无主权枢纽'; }
  else if (M.layer === 'campaigns') { const c = M.live.campaigns.find((x) => x.solar_system_id === s.id); extra = c ? zh(CAMPAIGN_TYPE_ZH, c.event_type) : ''; }
  else if (M.layer === 'sov' || M.layer === 'fw') extra = ownerName(owner);
  tip.innerHTML = `<strong>${app.esc(s.name)}</strong> <span style="color:${secColor(s.sec)}">${secDisplay(s.sec).toFixed(1)}</span>` +
    `<span>${app.esc(regionName(s.region))}${extra ? ' · ' + app.esc(extra) : ''}</span>`;
  tip.hidden = false;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + pad, M.size.w - rect.width - 8) + 'px';
  tip.style.top = Math.min(y + pad, M.size.h - rect.height - 8) + 'px';
}

// ---------- 侧栏：星系着色 / 颜色说明 / 搜索 / 路线 ----------
function renderLayerList() {
  $('layerList').innerHTML = LAYER_GROUPS.map(([title, list]) =>
    `<div class="layer-group-title">${title}</div><div class="layer-group">` +
    list.map(([key, label]) => `<button class="layer-btn${M.layer === key ? ' active' : ''}" data-layer="${key}" title="${LAYER_HINT[key]}">${label}</button>`).join('') +
    '</div>').join('') +
    `<p class="layer-hint">${LAYER_HINT[M.layer]}</p>` + (M.layer === 'planets' ? piOptions() : M.layer === 'industry' ? indOptions() : '');
  $('layerSummary').textContent = LAYERS.find(([k]) => k === M.layer)?.[1] || '';
}

// ---------- 侧栏分区折叠（星系着色 / 颜色说明 / 路线规划），状态持久化 ----------
const PANEL_DEFAULT = { layers: true, legend: false, route: false };
function bindPanels() {
  const saved = { ...PANEL_DEFAULT, ...app.store.getJSON('eve-map-panels', {}) };
  document.querySelectorAll('#mapSidebar .map-panel.collapsible').forEach((panel) => {
    setPanel(panel.dataset.panel, saved[panel.dataset.panel], false);
    panel.querySelector('.map-panel-toggle').addEventListener('click', () => setPanel(panel.dataset.panel, !panel.classList.contains('expanded')));
  });
}

function setPanel(name, open, persist = true) {
  const panel = document.querySelector(`#mapSidebar .map-panel[data-panel="${name}"]`);
  if (!panel) return;
  panel.classList.toggle('expanded', open);
  panel.querySelector('.map-panel-toggle').setAttribute('aria-expanded', String(open));
  if (persist) {
    const state = { ...PANEL_DEFAULT, ...app.store.getJSON('eve-map-panels', {}), [name]: open };
    app.store.setJSON('eve-map-panels', state);
  }
}

function legendRow({ color, logo, label, count, key, systemIndex, sub }) {
  const attrs = key ? ` data-hl="${app.esc(key)}"` : systemIndex != null ? ` data-sys="${systemIndex}"` : '';
  const active = key && M.highlightKey === key ? ' active' : '';
  return `<button class="legend-row${active}"${attrs}>
      ${logo ? `<img src="${logo}" alt="" width="20" height="20" loading="lazy">` : `<i style="background:${color}"></i>`}
      <span class="legend-label">${app.esc(label)}${sub ? `<small>${app.esc(sub)}</small>` : ''}</span>
      ${count != null ? `<span class="legend-count">${count}</span>` : ''}
    </button>`;
}

const legendSets = new Map();   // 颜色说明高亮 key -> Set<system index>

function renderLegend() {
  legendSets.clear();
  const box = $('mapLegend');
  const rows = [];
  const add = (key, set) => legendSets.set(key, set);

  if (M.layer === 'security') {
    const counts = {};
    for (const s of M.systems) { const k = secDisplay(s.sec).toFixed(1); counts[k] = (counts[k] || 0) + 1; }
    for (const k of SEC_KEYS) {
      const set = new Set(M.systems.filter((s) => secDisplay(s.sec).toFixed(1) === k).map((s) => s.i));
      add('sec:' + k, set);
      rows.push(legendRow({ color: SEC_COLORS[k], label: k + (k === '0.0' ? ' 及以下（00）' : Number(k) >= 0.5 ? ' 高安' : ' 低安'), count: counts[k] || 0, key: 'sec:' + k }));
    }
  } else if (M.layer === 'sov') {
    const owners = new Map();
    for (const s of M.systems) {
      const o = ownerOf(s);
      const key = o ? o.kind + ':' + o.id : 'none';
      if (!owners.has(key)) owners.set(key, { owner: o, set: new Set() });
      owners.get(key).set.add(s.i);
    }
    const sorted = [...owners.entries()].sort((a, b) => b[1].set.size - a[1].set.size);
    const section = (title, list) => {
      if (!list.length) return;
      rows.push(`<div class="legend-group">${title}</div>`);
      for (const [key, { owner, set }] of list) {
        add(key, set);
        rows.push(legendRow({ logo: owner ? ownerLogo(owner) : null, color: NONE_COLOR, label: ownerName(owner), count: set.size, key }));
      }
    };
    section('NPC 阵营', sorted.filter(([key]) => key.startsWith('faction')));
    section('玩家联盟', sorted.filter(([key]) => key.startsWith('alliance')));
    section('其他', sorted.filter(([key]) => key === 'none'));
  } else if (LAYER_METRIC[M.layer]) {
    const value = LAYER_METRIC[M.layer];
    const hue = { kills: 8, pods: 350, npc: 32, jumps: 190, stations: 48, planets: 140, industry: 270 }[M.layer];
    const isInd = M.layer === 'industry';
    const show = (v) => (isInd ? v.toFixed(v < 10 ? 2 : 1) + '%' : app.formatNumber(Math.round(v)));
    // 分段色块（对数刻度）
    const steps = (isInd ? [0.14, 1, 2, 5, 10, layerCache.max] : [0, 1, 5, 20, 100, layerCache.max]).filter((v, n, arr) => n === 0 || (v <= layerCache.max && v > arr[n - 1]));
    rows.push('<div class="legend-steps">' + steps.map((v) => `<span><i style="background:${heat(v, layerCache.max, hue)}"></i>${show(v)}</span>`).join('') + '</div>');
    if (HOURLY.has(M.layer)) rows.push(`<p class="legend-note">${hourlyNote()}</p>`);
    if (isInd) {
      rows.push(`<div class="legend-group">${IND_ACTS.find(([k]) => k === IND.act)[1]} · 成本指数最高的星系</div>`);
      if (IND.at || M.live.indAt) rows.push(`<p class="legend-note">ESI 约每小时更新（这份截至 ${hhmm(M.live.indAt)}）；多数星系为最低 0.14%</p>`);
    } else {
      const total = M.systems.reduce((t, s) => t + value(s), 0);
      const title = { kills: '舰船击毁 · 1 小时', pods: '太空舱击毁 · 1 小时', npc: 'NPC 击杀 · ' + npcSpan(), jumps: '星门跳跃 · 1 小时', stations: 'NPC 空间站', planets: '可用行星' }[M.layer];
      rows.push(`<div class="legend-group">${title} · 合计 ${app.formatNumber(total)}</div>`);
    }
    const top = [...M.systems].sort((a, b) => value(b) - value(a)).slice(0, 12).filter((s) => value(s) > 0);
    for (const s of top) rows.push(legendRow({ color: layerCache.colors[s.i], label: s.name, sub: regionName(s.region), count: show(value(s)), systemIndex: s.i }));
  } else if (M.layer === 'region') {
    const regions = [...M.regions.values()].filter((r) => r.systems.length).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const r of regions) {
      const key = 'region:' + r.id;
      add(key, new Set(r.systems));
      rows.push(legendRow({ color: hashColor(r.id * 7 + 3), label: r.name, count: r.systems.length, key }));
    }
  } else if (M.layer === 'distance') {
    const origin = M.systems[M.distance.origin];
    rows.push(`<div class="legend-group">起点：<b>${app.esc(origin.name)}</b>${M.selected == null ? '（点击星系可更换起点）' : ''}</div>`);
    DISTANCE_BUCKETS.forEach(([lo, hi, label], n) => {
      const set = new Set(M.systems.filter((s) => M.distance.hops[s.i] >= lo && M.distance.hops[s.i] <= hi).map((s) => s.i));
      add('dist:' + n, set);
      rows.push(legendRow({ color: DISTANCE_COLORS[n], label, count: set.size, key: 'dist:' + n }));
    });
    const unreachable = new Set(M.systems.filter((s) => M.distance.hops[s.i] < 0).map((s) => s.i));
    if (unreachable.size) { add('dist:none', unreachable); rows.push(legendRow({ color: DIM_COLOR, label: '星门无法到达', count: unreachable.size, key: 'dist:none' })); }
  } else if (M.layer === 'adm') {
    rows.push('<div class="legend-group">军事指数越高，主权枢纽越难被攻破</div>');
    for (let level = 6; level >= 1; level--) {
      const set = new Set(M.systems.filter((s) => Math.floor(M.live.adm.get(s.id)?.vulnerability_occupancy_level || 0) === level).map((s) => s.i));
      add('adm:' + level, set);
      rows.push(legendRow({ color: ADM_COLORS[level], label: '指数 ' + level, count: set.size, key: 'adm:' + level }));
    }
    const none = new Set(M.systems.filter((s) => !M.live.adm.has(s.id)).map((s) => s.i));
    add('adm:none', none);
    rows.push(legendRow({ color: DIM_COLOR, label: '无主权枢纽', count: none.size, key: 'adm:none' }));
  } else if (M.layer === 'campaigns') {
    if (!M.live.campaigns.length) rows.push('<p class="legend-empty">当前没有主权争夺战</p>');
    for (const c of [...M.live.campaigns].sort((a, b) => new Date(a.start_time) - new Date(b.start_time))) {
      const sys = M.byId.get(c.solar_system_id);
      if (!sys) continue;
      const started = new Date(c.start_time);
      const when = started > new Date() ? '开始于 ' + started.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '进行中';
      rows.push(legendRow({
        logo: eveImage(`alliances/${c.defender_id}/logo`, 32),
        label: sys.name + ' · ' + zh(CAMPAIGN_TYPE_ZH, c.event_type),
        sub: `防守方 ${M.live.names.get(c.defender_id) || c.defender_id} · 防守 ${((c.defender_score || 0) * 100).toFixed(0)}% / 进攻 ${((c.attackers_score || 0) * 100).toFixed(0)}% · ${when}`,
        systemIndex: sys.i
      }));
    }
  } else if (M.layer === 'incursions') {
    if (!M.live.incursions.length) rows.push('<p class="legend-empty">当前没有入侵</p>');
    for (const inc of M.live.incursions) {
      const set = new Set(inc.infested_solar_systems.map((id) => M.byId.get(id)?.i).filter((i) => i != null));
      const key = 'inc:' + inc.constellation_id;
      add(key, set);
      const staging = M.byId.get(inc.staging_solar_system_id);
      rows.push(legendRow({
        logo: `https://images.evetech.net/corporations/${inc.faction_id}/logo?size=32`,
        label: constellationName(inc.constellation_id) + ' · ' + regionName(M.constellations.get(inc.constellation_id)?.region),
        sub: `${zh(INCURSION_STATE_ZH, inc.state)} · 影响力 ${(inc.influence * 100).toFixed(0)}%${inc.has_boss ? ' · 首领出现' : ''}${staging ? ' · 集结：' + staging.name : ''}`,
        count: set.size, key
      }));
    }
  } else if (M.layer === 'fw') {
    const byFaction = new Map();
    for (const f of M.live.fw.values()) {
      const s = M.byId.get(f.solar_system_id);
      if (!s) continue;
      if (!byFaction.has(f.occupier_faction_id)) byFaction.set(f.occupier_faction_id, new Set());
      byFaction.get(f.occupier_faction_id).add(s.i);
    }
    rows.push('<div class="legend-group">占领方</div>');
    for (const [fid, set] of [...byFaction.entries()].sort((a, b) => b[1].size - a[1].size)) {
      add('fw:' + fid, set);
      rows.push(legendRow({ logo: `https://images.evetech.net/corporations/${fid}/logo?size=32`, label: M.factions[fid]?.name || fid, count: set.size, key: 'fw:' + fid }));
    }
    const contested = [...M.live.fw.values()].filter((f) => f.contested !== 'uncontested');
    const vulnerable = new Set(contested.filter((f) => f.contested === 'vulnerable').map((f) => M.byId.get(f.solar_system_id)?.i).filter((i) => i != null));
    const fighting = new Set(contested.filter((f) => f.contested === 'contested').map((f) => M.byId.get(f.solar_system_id)?.i).filter((i) => i != null));
    add('fw:vulnerable', vulnerable);
    add('fw:contested', fighting);
    rows.push('<div class="legend-group">战况</div>');
    rows.push(legendRow({ color: '#ffd24d', label: '争夺中（黄圈）', count: fighting.size, key: 'fw:contested' }));
    rows.push(legendRow({ color: '#ff4d4d', label: '可被夺取（红圈）', count: vulnerable.size, key: 'fw:vulnerable' }));
  }
  box.innerHTML = rows.join('') + (M.highlight ? '<button class="link-btn legend-clear" data-hl-clear>取消高亮</button>' : '');
  $('legendSummary').textContent = M.highlight ? `已高亮 ${M.highlight.size} 个星系` : '';
}

function zh(map, key) { return map[key] || key; }

function toggleHighlight(key) {
  if (M.highlightKey === key) {
    M.highlight = null;
    M.highlightKey = null;
  } else {
    // 星域高亮也可以从星域详情面板触发，此时颜色说明里不一定有对应的集合
    const regionMatch = /^region:(\d+)$/.exec(key);
    M.highlight = legendSets.get(key) || (regionMatch ? new Set(M.regions.get(Number(regionMatch[1]))?.systems || []) : null);
    M.highlightKey = key;
    if (M.highlight?.size) fitTo([...M.highlight], 1.2);
  }
  renderLegend();
  applyColors();
}

// ---------- NPC 人物（npc-data.json，build_npc.mjs 由 SDE 生成）----------
// ESI 查不到 NPC 的位置，代理人驻地来自 SDE。首次搜索或打开星系面板时才加载（约 360 KB gzip）
const AGENT_TYPE = { 3: '新手教程', 4: '研究', 5: '统合部', 6: '故事线', 7: '故事线', 8: '活动', 9: '势力战争', 10: '史诗任务', 11: '向导', 12: '职业', 13: '纹章' };
const NPC = { promise: null, list: null, byId: new Map(), bySystem: new Map(), divisions: {}, corpFaction: {} };
let agentFocus = null;   // 从搜索结果点进来的 NPC：{ id, system }，星系面板里高亮

function loadNpcData() {
  if (!NPC.promise) {
    NPC.promise = fetch('./npc-data.json?v=2').then((res) => {
      if (!res.ok) throw new Error('NPC 数据加载失败 HTTP ' + res.status);
      return res.json();
    }).then((d) => {
      NPC.divisions = d.divisions || {};
      NPC.corpFaction = d.corpFaction || {};
      // 空间站所在星系以本服星图为准（曙光服星图重排过）
      const stationSystem = new Map();
      for (const sys of M.systems) for (const st of sys.stations) stationSystem.set(st, sys.id);
      NPC.list = d.npcs.map(([id, name, en, corp, station, system, type, division, level, locator, ceo]) =>
        ({ id, name, en, corp, station, system: stationSystem.get(station) || system, type, division, level, locator, ceo, lower: (name + ' ' + en).toLowerCase() }));
      for (const n of NPC.list) {
        NPC.byId.set(n.id, n);
        if (!NPC.bySystem.has(n.system)) NPC.bySystem.set(n.system, []);
        NPC.bySystem.get(n.system).push(n);
      }
    }).catch((error) => { NPC.promise = null; throw error; });
  }
  return NPC.promise;
}

// ---------- 代理人可用性（角色声望）----------
// 能否接某级代理人的任务，看对代理人本人 / 其军团 / 其阵营三者中最高的有效声望：
//   2 级 ≥ 1.0、3 级 ≥ 3.0、4 级 ≥ 5.0、5 级 ≥ 7.0，1 级不限；三者任何一项 ≤ −2.0 都不能接。
// 有效声望 = 基础声望 + (10 − 基础声望) × 4% × 技能等级：负声望用外交学，正声望用人脉关系学（海盗阵营用犯罪关系学）。
// 只判断普通代理人与研究代理人（研究还要求对应研究技能），故事线、史诗任务等另有规则。
const AGENT_NEED = [0, -Infinity, 1, 3, 5, 7];
const SOCIAL = { connections: 3359, diplomacy: 3357, criminal: 3361 };
const PIRATE_FACTIONS = new Set([500010, 500011, 500012, 500019, 500020]);
let agentAccess = null;   // { id, map, levels } 或 { id, error }
let agentAccessLoading = null;

function loadAgentAccess() {
  if (!app.hasEsiToken() || !app.getCharacterStandings) return Promise.resolve(null);
  if (!agentAccessLoading) {
    agentAccessLoading = Promise.all([app.getCharacterStandings(), app.getCharacterSkills().catch(() => null)])
      .then(([st, skills]) => { agentAccess = { id: st.id, map: st.map, levels: skills?.id === st.id ? skills.levels : new Map() }; })
      .catch((error) => { agentAccess = { error: error.message }; })
      .finally(() => { agentAccessLoading = null; });
  }
  return agentAccessLoading;
}

function effectiveStanding(raw, faction) {
  const lv = (id) => agentAccess.levels.get(id) || 0;
  const skill = raw < 0 ? lv(SOCIAL.diplomacy) : PIRATE_FACTIONS.has(faction) ? lv(SOCIAL.criminal) : lv(SOCIAL.connections);
  return raw + (10 - raw) * 0.04 * skill;
}

// 返回 { ok, best, need } 或 null（不判断）
function agentAvailability(n) {
  if (!agentAccess?.map || ![2, 4].includes(n.type) || !n.level) return null;
  const faction = NPC.corpFaction[n.corp] || 0;
  const values = [n.id, n.corp, faction].filter(Boolean).map((id) => effectiveStanding(agentAccess.map.get(id) || 0, faction));
  const best = Math.max(...values);
  const need = AGENT_NEED[n.level] ?? 7;
  const blocked = values.some((v) => v <= -2);
  return { ok: !blocked && best >= need, best, need, blocked };
}

function availabilityHtml(n) {
  const a = agentAvailability(n);
  if (!a) return '';
  if (a.blocked) return '<em class="agent-no">声望过低（≤ −2.0），不能接任务</em>';
  if (a.ok) return `<em class="agent-ok">可接任务 · 有效声望 ${a.best.toFixed(2)}</em>`;
  return `<em class="agent-no">需有效声望 ${a.need.toFixed(1)}（当前最高 ${a.best.toFixed(2)}）</em>`;
}

// 例：4 级 安全代理人 · 势力战争；非代理人显示军团 CEO
function npcRole(n) {
  if (!n.type) return n.ceo ? '军团 CEO' : 'NPC 人物';
  const division = NPC.divisions[n.division] || '';
  return `${n.level} 级 ${division}代理人${AGENT_TYPE[n.type] ? ' · ' + AGENT_TYPE[n.type] : ''}${n.locator ? ' · 可定位' : ''}`;
}

// 搜索：星系、星域与 NPC 人物
function searchMap(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const r of M.regions.values()) if (r.name.toLowerCase().includes(q)) results.push({ type: 'region', id: r.id, name: r.name, score: r.name.toLowerCase().startsWith(q) ? 0 : 2 });
  for (const s of M.systems) {
    if (!s.lower.includes(q)) continue;
    results.push({ type: 'system', i: s.i, name: s.name, score: s.lower === q ? -1 : s.lower.startsWith(q) ? 1 : 3 });
  }
  if (NPC.list) {
    for (const n of NPC.list) {
      if (!n.lower.includes(q) || !M.byId.has(n.system)) continue;
      const exact = n.name.toLowerCase() === q || n.en.toLowerCase() === q;
      results.push({ type: 'npc', id: n.id, name: n.name, score: exact ? 0 : n.lower.startsWith(q) || n.en.toLowerCase().startsWith(q) ? 2 : 4 });
    }
  }
  return results.sort((a, b) => a.score - b.score || a.name.length - b.name.length).slice(0, limit);
}

function resultRow(r) {
  if (r.type === 'npc') {
    const n = NPC.byId.get(r.id);
    const sys = M.byId.get(n.system);
    return `<button class="map-result" data-npc="${n.id}"><span class="result-kind">NPC</span><span class="result-name">${app.esc(n.name)}</span>
      <span class="result-sub">${app.esc(sys.name)} · ${app.esc(n.type ? n.level + ' 级' : n.ceo ? 'CEO' : '')}</span></button>`;
  }
  if (r.type === 'region') {
    return `<button class="map-result" data-region="${r.id}"><span class="result-kind">星域</span><span class="result-name">${app.esc(r.name)}</span></button>`;
  }
  const s = M.systems[r.i];
  return `<button class="map-result" data-sys="${s.i}"><i style="background:${secColor(s.sec)}"></i><span class="result-name">${app.esc(s.name)}</span>
      <span class="result-sub">${secDisplay(s.sec).toFixed(1)} · ${app.esc(regionName(s.region))}</span></button>`;
}

function bindSidebar() {
  const input = $('mapSearch');
  const results = $('mapSearchResults');
  const run = app.debounce(() => {
    const list = searchMap(input.value);
    results.hidden = !input.value.trim();
    results.innerHTML = list.length ? list.map(resultRow).join('') : `<p class="legend-empty">${NPC.list ? '没有找到匹配的星系、星域或 NPC 人物' : '没有找到匹配的星系或星域'}</p>`;
    // NPC 数据首次搜索时才加载，加载完再搜一次
    if (!NPC.list && input.value.trim()) loadNpcData().then(() => { if (input.value.trim()) run(); }).catch(() => {});
  }, 120);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { results.querySelector('.map-result')?.click(); e.preventDefault(); }
    if (e.key === 'Escape') { input.value = ''; results.hidden = true; }
  });

  $('mapSidebar').addEventListener('change', (e) => {
    if (e.target.matches('[data-ind-pick]')) {
      IND.act = e.target.value;
      try { localStorage.setItem('eve-map-ind', IND.act); } catch { /* 忽略 */ }
      computeLayer(); renderLegend();
      if (M.selected != null && $('mapIndBlock')) $('mapIndBlock').outerHTML = industryHtml(M.systems[M.selected]);
      return;
    }
    if (!e.target.matches('[data-pi-pick]')) return;
    PI.pick = e.target.value;
    try { localStorage.setItem('eve-map-pi', PI.pick); } catch { /* 忽略 */ }
    computeLayer(); renderLegend();
  });
  $('mapSidebar').addEventListener('click', (e) => {
    const layer = e.target.closest('[data-layer]');
    if (layer) { setLayer(layer.dataset.layer); return; }
    const hlRow = e.target.closest('[data-hl]');
    if (hlRow) { toggleHighlight(hlRow.dataset.hl); return; }
    if (e.target.closest('[data-hl-clear]')) { M.highlight = null; M.highlightKey = null; renderLegend(); applyColors(); return; }
    // 手机端：选中星系 / 星域后收起抽屉，露出星图
    const sys = e.target.closest('[data-sys]');
    if (sys) { selectSystem(Number(sys.dataset.sys), true); results.hidden = true; app.closeDrawer(); return; }
    const npc = e.target.closest('[data-npc]');
    if (npc) {
      const n = NPC.byId.get(Number(npc.dataset.npc));
      agentFocus = { id: n.id, system: n.system };
      selectSystem(M.byId.get(n.system).i, true);
      results.hidden = true;
      app.closeDrawer();
      return;
    }
    const reg = e.target.closest('[data-region]');
    if (reg) { selectRegion(Number(reg.dataset.region)); results.hidden = true; app.closeDrawer(); }
  });

  // 路线规划
  for (const which of ['From', 'To']) bindSystemField($('route' + which), $('route' + which + 'List'));
  $('routeFlag').innerHTML = ROUTE_FLAGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('routePlan').addEventListener('click', planRoute);
  bindJumpPlanner();
  // 反转：起点 ↔ 终点，途经点倒序
  const reverseRoute = () => {
    const fields = [$('routeFrom'), ...$('routeWaypoints').querySelectorAll('input'), $('routeTo')];
    const vals = fields.map((f) => [f.value, f.dataset.id || '']).reverse();
    fields.forEach((f, k) => { [f.value, f.dataset.id] = vals[k]; });
  };
  $('routeSwap').addEventListener('click', reverseRoute);
  bindRouteImport();
  bindBridges();
  // 起点 / 终点：一键填入 ESI 角色当前所在星系
  document.querySelectorAll('[data-route-here]').forEach((btn) => btn.addEventListener('click', () => routeFromHere(btn)));
  $('routeReverse').addEventListener('click', reverseRoute);
  // 途经点：添加 / 上移 / 下移 / 删除
  $('routeAddWp').addEventListener('click', () => { addWaypoint()?.focus(); });
  $('routeOrder').addEventListener('change', syncWaypointUi);
  $('routeWaypoints').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wp-act]');
    if (!btn) return;
    const row = btn.closest('.route-wp');
    const act = btn.dataset.wpAct;
    if (act === 'del') row.remove();
    else if (act === 'up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
    else if (act === 'down' && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    syncWaypointUi();
  });
  $('routeClear').addEventListener('click', () => {
    $('routeSummary').textContent = '';
    M.route = [];
    M.routeStops = [];
    $('routeResult').innerHTML = '';
    clearJumpRange();
    updateRouteLine();
  });
  $('routeResult').addEventListener('click', (e) => {
    if (e.target.closest('[data-game-route]')) {
      // 星门路线：游戏自动导航会自己寻路，只设终点；跳跃路线：落点依次写成航点
      const ids = J.mode === 'jump' && J.plan ? J.plan.path.slice(1).map((i) => M.systems[i].id).concat(J.plan.gates.map((i) => M.systems[i].id))
        : M.route.length ? M.routeStops : [];
      if (ids.length) app.game.route(ids, M.systems[M.byId.get(ids[ids.length - 1]).i].name);
      return;
    }
    if (e.target.closest('[data-copy-route]')) {
      app.copyText(M.route.map((i) => M.systems[i].name).join(' → '), '路线已复制');
      return;
    }
    if (e.target.closest('[data-jump-range]')) { toggleJumpRange(); return; }
    const sys = e.target.closest('[data-sys]');
    if (sys) selectSystem(Number(sys.dataset.sys), true);
  });
}

// 星系输入框 + 候选列表（起点 / 终点 / 途经点共用）
function bindSystemField(field, list) {
  field.addEventListener('input', app.debounce(() => {
    field.dataset.id = '';
    const found = searchMap(field.value, 8).filter((r) => r.type === 'system');
    list.innerHTML = found.map((r) => resultRow(r).replace('data-sys', 'data-pick')).join('');
    list.hidden = !found.length;
  }, 120));
  field.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  list.addEventListener('mousedown', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    const s = M.systems[Number(pick.dataset.pick)];
    field.value = s.name;
    field.dataset.id = s.id;
    list.hidden = true;
  });
}

const MAX_WAYPOINTS = 15;

// ---------- 粘贴导入多个星系 ----------
// 游戏里复制的人物和地点、路线、聊天内容：按行拆开，表格行（制表符分列）每行取一个星系，其余文本按 → / 逗号等拆成多个；
// 中文名本地匹配，英文名 / 空间站名用 ESI /universe/ids/ 查，星系链接 showinfo:5//ID 直接取
const IMPORT_SPLIT = /\s*(?:→|->|=>|»|›|>|,|，|、|;|；|\|)\s*/;

function importCandidates(cell) {
  // 人物和地点里没去过的星系名后面带 *
  const c = cell.replace(/<[^>]+>/g, '').trim().replace(/\*+$/, '').trim();
  if (!c || c.length > 120) return [];
  const out = [c];
  // 空间站全名「吉他 IV - 卫星 4 - 加达里海军组装工厂」/ 玩家建筑「Jita - 名字」：取第一段的星系名
  // 「Amarr VIII (Oris) - …」这种行星带括号名的也去掉
  const head = c.split(' - ')[0].replace(/\s*\([^)]*\)$/, '').replace(/\s+[IVXLC]+$/, '').trim();
  if (head && head !== c) out.push(head);
  return out;
}

async function parseRouteImport(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 每行：[{ cells: [[候选名…]…], link: 星系 index }]
  const rows = [];
  const stationIds = new Set();
  for (const line of lines) {
    const links = [...line.matchAll(/showinfo:(\d+)\/\/(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [, id] of links) if (id >= 60000000 && id < 64000000) stationIds.add(id);
    // 表格行：制表符分列；有的地方粘贴后制表符会变成连续空格，也按分列处理
    const tab = line.includes('\t') || (/ {2,}/.test(line) && !IMPORT_SPLIT.test(line));
    const cells = (tab ? line.split(/\t| {2,}/) : line.replace(/<[^>]+>/g, ' ').split(IMPORT_SPLIT)).map(importCandidates);
    rows.push({ tab, cells, links });
  }
  // 本地中文名匹配不到的，交给 ESI 查英文名 / 空间站名
  const local = (name) => M.systems.find((s) => s.lower === name.toLowerCase());
  const nameMap = new Map();
  const unknown = new Set();
  for (const r of rows) for (const cands of r.cells) for (const n of cands) {
    const s = local(n);
    if (s) nameMap.set(n.toLowerCase(), s.i); else if (/[a-z]/i.test(n)) unknown.add(n);
  }
  if (unknown.size) {
    const names = [...unknown].slice(0, 500);
    try {
      const res = await app.fetchESI('/universe/ids/?language=en', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(names) });
      for (const x of res.systems || []) { const s = M.byId.get(x.id); if (s) nameMap.set(x.name.toLowerCase(), s.i); }
      for (const x of res.stations || []) { stationIds.add(x.id); nameMap.set(x.name.toLowerCase(), -x.id); }
    } catch { /* 查不到就只用本地匹配的结果 */ }
  }
  // 空间站 → 所在星系
  const stationSys = new Map();
  await Promise.all([...stationIds].slice(0, 50).map((id) => app.fetchESI(`/universe/stations/${id}/`)
    .then((st) => { const s = M.byId.get(st.system_id); if (s) stationSys.set(id, s.i); }).catch(() => {})));
  const resolve = (n) => {
    const v = nameMap.get(n.toLowerCase());
    return v == null ? null : v >= 0 ? v : stationSys.get(-v) ?? null;
  };
  const linkSys = ([type, id]) => type === 5 ? M.byId.get(id)?.i ?? null : stationSys.get(id) ?? null;
  const out = [];
  for (const r of rows) {
    const found = r.cells.map((cands) => { for (const n of cands) { const i = resolve(n); if (i != null) return i; } return null; });
    const fromLinks = r.links.map(linkSys).filter((i) => i != null);
    if (r.tab) {
      // 表格行只取一个：链接优先，其次第 2 列起的第一个星系（第 1 列常是自定义名称），最后才用第 1 列
      const pick = fromLinks[0] ?? found.slice(1).find((i) => i != null) ?? found[0];
      if (pick != null) out.push(pick);
    } else if (fromLinks.length) out.push(...fromLinks);
    else out.push(...found.filter((i) => i != null));
  }
  return out.filter((i, k) => k === 0 || i !== out[k - 1]);
}

function bindRouteImport() {
  const box = $('routeImport'), text = $('routeImportText'), preview = $('routeImportPreview'), apply = $('routeImportApply');
  let parsed = [];
  let seq = 0;
  const open = (value) => {
    box.hidden = false;
    if (value != null) text.value = value;
    text.focus();
    refresh();
  };
  // 导入只在当前路线上追加：已填的起点 / 终点 / 途经点不动，空着的起点 / 终点用识别结果的首 / 尾补上，其余接在现有途经点后面
  const plan = (list) => {
    const from = resolveRouteField($('routeFrom')), to = resolveRouteField($('routeTo'));
    const have = new Set([from, to, ...[...$('routeWaypoints').querySelectorAll('input')].map(resolveRouteField)].filter(Boolean));
    const fresh = list.filter((i, k) => !have.has(M.systems[i].id) && list.indexOf(i) === k);
    const r = { from: null, to: null, vias: fresh.slice() };
    if (!from && r.vias.length) r.from = r.vias.shift();
    if (!to && r.vias.length && (from || r.vias.length > 1)) r.to = r.vias.pop();
    const room = MAX_WAYPOINTS - $('routeWaypoints').children.length;
    r.dropped = Math.max(0, r.vias.length - room);
    r.vias = r.vias.slice(0, Math.max(0, room));
    r.dup = list.length - fresh.length;
    return r;
  };
  const refresh = app.debounce(async () => {
    const my = ++seq;
    if (!text.value.trim()) { parsed = []; preview.textContent = ''; apply.disabled = true; return; }
    preview.textContent = '正在识别…';
    const list = await parseRouteImport(text.value);
    if (my !== seq) return;
    parsed = list;
    const r = plan(list);
    const n = r.vias.length + (r.from != null) + (r.to != null);
    apply.disabled = !n;
    const name = (i) => app.esc(M.systems[i].name);
    preview.innerHTML = !list.length ? '没有识别到星系名'
      : `识别到 <strong>${list.length}</strong> 个星系：` + list.slice(0, 30).map(name).join(' → ') + (list.length > 30 ? ' …' : '') + '<br>' +
        [r.from != null ? `起点设为 ${name(r.from)}` : '', r.vias.length ? `新增 ${r.vias.length} 个途经点` : '', r.to != null ? `终点设为 ${name(r.to)}` : ''].filter(Boolean).join('，') +
        (r.dup ? `${n ? '；' : ''}${r.dup} 个已在路线里，跳过` : '') +
        (r.dropped ? `<br><span class="sec-null">途经点最多 ${MAX_WAYPOINTS} 个，另有 ${r.dropped} 个没导入</span>` : '');
  }, 250);
  $('routeImportToggle').addEventListener('click', () => { if (box.hidden) open(); else box.hidden = true; });
  $('routeImportCancel').addEventListener('click', () => { box.hidden = true; });
  text.addEventListener('input', refresh);
  apply.addEventListener('click', () => {
    if (!parsed.length) return;
    const r = plan(parsed);
    const setField = (f, i) => { f.value = M.systems[i].name; f.dataset.id = M.systems[i].id; };
    if (r.from != null) setField($('routeFrom'), r.from);
    if (r.to != null) setField($('routeTo'), r.to);
    for (const i of r.vias) addWaypoint(M.systems[i]);
    syncWaypointUi();
    box.hidden = true;
    text.value = '';
    app.showToast(`已导入 ${r.vias.length + (r.from != null) + (r.to != null)} 个星系`, 'success', 1500);
    if (resolveRouteField($('routeFrom')) && (resolveRouteField($('routeTo')) || $('routeWaypoints').children.length)) planRoute();
  });
  // 在起点 / 终点 / 途经点框里直接粘贴多行或多个星系：转到导入框
  $('routeForm').addEventListener('paste', (e) => {
    if (!e.target.matches('.route-field input')) return;
    const t = e.clipboardData?.getData('text') || '';
    if (!/[\n\t]|→|->|showinfo:/.test(t.trim())) return;
    e.preventDefault();
    open(t);
  });
}

function addWaypoint(s = null) {
  const box = $('routeWaypoints');
  if (box.children.length >= MAX_WAYPOINTS) { app.showToast(`途经点最多 ${MAX_WAYPOINTS} 个`, 'error', 2000); return null; }
  const row = document.createElement('div');
  row.className = 'route-wp';
  row.innerHTML = `<div class="route-field"><input type="text" autocomplete="off" aria-label="途经星系"><div class="route-suggest" hidden></div></div>
    <button class="icon-btn small" data-wp-act="up" title="上移" aria-label="上移">↑</button><button class="icon-btn small" data-wp-act="down" title="下移" aria-label="下移">↓</button><button class="icon-btn small" data-wp-act="del" title="删除途经点" aria-label="删除途经点">✕</button>`;
  const input = row.querySelector('input');
  bindSystemField(input, row.querySelector('.route-suggest'));
  if (s) { input.value = s.name; input.dataset.id = s.id; }
  box.appendChild(row);
  syncWaypointUi();
  return input;
}

// 途经点序号、顺序选项、终点是否可省略
function syncWaypointUi() {
  const rows = [...$('routeWaypoints').children];
  const auto = $('routeOrder').value === 'auto';
  rows.forEach((row, k) => {
    row.querySelector('input').placeholder = auto ? '途经星系' : `第 ${k + 1} 站`;
    row.querySelector('[data-wp-act="up"]').hidden = auto;
    row.querySelector('[data-wp-act="down"]').hidden = auto;
  });
  $('routeOrder').hidden = $('routeReverse').hidden = !rows.length;
  $('routeSwap').hidden = !!rows.length;   // 有途经点时 ⇅ 会压住途经点的按钮，改用「反转」
  $('routeTo').placeholder = rows.length ? '终点星系（可不填，停在最后一个途经点）' : '终点星系';
}

function setRouteEnd(which, i, note = '') {
  const s = M.systems[i];
  setPanel('route', true);
  if (which === 'via') {
    if (addWaypoint(s)) app.showToast('已添加途经点：' + s.name, 'success', 1500);
    return;
  }
  const field = $(which === 'from' ? 'routeFrom' : 'routeTo');
  field.value = s.name;
  field.dataset.id = s.id;
  app.showToast((which === 'from' ? '起点' : '终点') + '：' + note + s.name, 'success', 1500);
  if ($('routeFrom').dataset.id && $('routeTo').dataset.id) planRoute();
}

function resolveRouteField(field) {
  if (field.dataset.id) return Number(field.dataset.id);
  const exact = M.systems.find((s) => s.lower === field.value.trim().toLowerCase());
  return exact?.id || null;
}

// 本地星门图上的单源最短路（给途经点排顺序、检查可达性、找出用到的跳桥；实际每段路线仍由 ESI 规划）
// 安全优先 / 低安优先按 ESI 的思路给不想走的星系加大代价；勾选「走跳桥」时跳桥也算一跳。dist.prev 为前驱
function gateCosts(src, flag) {
  const n = M.systems.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  dist.prev = prev;
  const br = bridgesOn() ? bridgeAdj() : null;
  const weight = (i) => {
    if (flag === 'shortest') return 1;
    const hi = secClass(M.systems[i].sec) === '高安';
    return (flag === 'secure' ? hi : !hi) ? 1 : 50;
  };
  dist[src] = 0;
  // 二叉堆 Dijkstra，元素 [代价, 星系]
  const heap = [[0, src]];
  const push = (x) => {
    heap.push(x);
    for (let k = heap.length - 1; k > 0;) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]]; k = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const relax = (j) => {
      const nd = d + weight(j);
      if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push([nd, j]); }
    };
    for (const j of M.systems[i].nbr) relax(j);
    if (br?.has(i)) for (const j of br.get(i)) relax(j);
  }
  return dist;
}

function localPath(dist, to) {
  if (dist[to] === Infinity) return null;
  const path = [];
  for (let i = to; i >= 0; i = dist.prev[i]) path.push(i);
  return path.reverse();
}

// ---------- 跳桥（安塞波克斯星门，Ansiblex）----------
// 自动：角色建筑搜索「 » 」（跳桥名称固定为「A » B - 自定义名」，需要 esi-search.search_structures.v1）→ 建筑详情（esi-universe.read_structures.v1）
//   类型 35841 的取所在星系为起点、名称里 » 后面的星系为终点；只能搜到角色有权使用的跳桥。按服务器 + 角色缓存 1 天。
// 手动：粘贴「A » B」列表，按服务器保存。两种合并后双向使用。
// ESI 路线接口的 connections 参数是单向的、最多 100 对：本地先带全部跳桥求最短路，只把路上用到的跳桥交给 ESI
const BRIDGE_TYPE = 35841;
const BRIDGE_TTL = 86400e3;
const BR = { auto: [], at: 0, cid: 0, manual: null, loading: null, note: '', adj: null };
const bridgeKey = (cid) => serverKey('eve-bridges') + '-' + cid;
const bridgeManualKey = () => serverKey('eve-bridges-manual');

function bridgesOn() { return J.mode !== 'jump' && $('routeBridgeOn')?.checked && bridgeList().length > 0; }

function bridgeList() {
  if (BR.manual == null) {
    try { BR.manual = JSON.parse(localStorage.getItem(bridgeManualKey()) || '[]'); } catch { BR.manual = []; }
  }
  const seen = new Set();
  const out = [];
  for (const b of [...BR.auto, ...BR.manual]) {
    const k = Math.min(b.a, b.b) + ':' + Math.max(b.a, b.b);
    if (seen.has(k) || !M.byId.has(b.a) || !M.byId.has(b.b)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

// 星系 index -> 跳桥对面的星系 index 列表
function bridgeAdj() {
  if (BR.adj) return BR.adj;
  const adj = new Map();
  const add = (x, y) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(y); };
  for (const b of bridgeList()) { const x = M.byId.get(b.a).i, y = M.byId.get(b.b).i; add(x, y); add(y, x); }
  BR.adj = adj;
  return adj;
}
const isGateHop = (x, y) => M.systems[x].nbr.includes(y);

function systemByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return n ? M.systems.find((s) => s.lower === n) : null;
}

// 「1DQ1-A » 8QT-H4 - 名字」→ [起点名, 终点名]
function parseBridgeName(name) {
  const m = /^\s*(.+?)\s*(?:»|<->|->|↔|<>|\t)\s*(.+?)(?:\s+-\s.*)?\s*$/.exec(name || '');
  return m ? [m[1].trim(), m[2].trim()] : null;
}

function loadBridgeCache(cid) {
  if (BR.cid === cid) return;
  BR.cid = cid; BR.auto = []; BR.at = 0; BR.adj = null;
  try {
    const c = JSON.parse(localStorage.getItem(bridgeKey(cid)) || 'null');
    if (c && Array.isArray(c.list)) { BR.auto = c.list; BR.at = c.at || 0; }
  } catch { /* 忽略 */ }
}

async function fetchBridges(force = false) {
  if (!app.hasEsiToken()) return;
  const token = await app.getEsiToken().catch(() => null);
  if (!token?.access_token) return;
  loadBridgeCache(token.character_id);
  if (!force && BR.at && Date.now() - BR.at < BRIDGE_TTL) return;
  if (BR.loading) return BR.loading;
  if (!JP.hasStructureSearchScope(token)) { BR.note = '自动读取跳桥需要「建筑搜索」授权，重新绑定 ESI 后可用'; syncBridgeUi(); return; }
  BR.loading = (async () => {
    BR.note = '正在读取跳桥…';
    syncBridgeUi();
    const auth = { headers: { Authorization: 'Bearer ' + token.access_token } };
    const search = async (term) => {
      const r = await fetch(`${SERVER.esi}/characters/${token.character_id}/search/?categories=structure&search=${encodeURIComponent(term)}&datasource=${SERVER.datasource}`, auth).catch(() => null);
      return r?.ok ? ((await r.json().catch(() => ({}))).structure || []) : null;
    };
    let ids = await search(' » ');
    if (ids == null) throw new Error('建筑搜索失败');
    // 达到 500 条上限：按起点星系名最后一个字符细分
    if (ids.length >= 500) {
      const more = await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map((c) => search(c + ' » ')));
      ids = [...new Set([...ids, ...more.flat().filter(Boolean)])];
    }
    const list = [];
    const queue = ids.slice();
    let pauseUntil = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        const wait = pauseUntil - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const r = await fetch(`${SERVER.esi}/universe/structures/${id}/?datasource=${SERVER.datasource}`, auth).catch(() => null);
        const remain = r?.headers.get('x-esi-error-limit-remain');
        if (remain != null && Number(remain) < 20) pauseUntil = Date.now() + (Number(r.headers.get('x-esi-error-limit-reset')) || 60) * 1000;
        if (!r?.ok) continue;
        const info = await r.json().catch(() => null);
        if (info?.type_id !== BRIDGE_TYPE) continue;
        const names = parseBridgeName(info.name);
        const to = names && systemByName(names[1]);
        if (to && info.solar_system_id !== to.id) list.push({ a: info.solar_system_id, b: to.id, id, name: info.name });
      }
    }));
    BR.auto = list;
    BR.at = Date.now();
    BR.adj = null;
    BR.note = '';
    try { localStorage.setItem(bridgeKey(BR.cid), JSON.stringify({ at: BR.at, list })); } catch { /* 忽略 */ }
  })().catch((error) => { BR.note = '读取跳桥失败：' + error.message; }).finally(() => { BR.loading = null; syncBridgeUi(); });
  return BR.loading;
}

function syncBridgeUi() {
  const box = $('routeBridges');
  if (!box) return;
  box.hidden = J.mode === 'jump';
  const all = bridgeList();
  const auto = BR.auto.length, manual = (BR.manual || []).length;
  $('routeBridgeRefresh').hidden = !app.hasEsiToken();
  $('routeBridgeNote').textContent = BR.note || (all.length
    ? `已知 ${all.length} 座${auto && manual ? `（自动 ${auto} · 手动 ${manual}）` : manual ? '（手动添加）' : ''}`
    : app.hasEsiToken() ? '没有找到你能用的跳桥' : '绑定 ESI 后自动读取你能用的跳桥');
}

// 中文名本地匹配，英文名（如 Jita）用 ESI /universe/ids/ 查
async function parseManualBridges(text) {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => [line, parseBridgeName(line)]);
  const en = new Map();
  const unknown = [...new Set(rows.flatMap(([, n]) => n || []).filter((n) => !systemByName(n) && /[a-z]/i.test(n)))];
  if (unknown.length) {
    try {
      const res = await app.fetchESI('/universe/ids/?language=en', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(unknown.slice(0, 500)) });
      for (const x of res.systems || []) { const sys = M.byId.get(x.id); if (sys) en.set(x.name.toLowerCase(), sys); }
    } catch { /* 只用本地匹配 */ }
  }
  const find = (n) => systemByName(n) || en.get(n.toLowerCase());
  const out = [], bad = [];
  for (const [line, names] of rows) {
    const a = names && find(names[0]), b = names && find(names[1]);
    if (a && b && a !== b) out.push({ a: a.id, b: b.id }); else bad.push(line);
  }
  return { out, bad };
}

function bindBridges() {
  const on = $('routeBridgeOn');
  on.checked = app.store.get('eve-route-bridges') !== '0';
  on.addEventListener('change', () => {
    app.store.set('eve-route-bridges', on.checked ? '1' : '0');
    if (on.checked) fetchBridges();
  });
  $('routeBridgeRefresh').addEventListener('click', () => fetchBridges(true));
  const box = $('routeBridgeBox'), text = $('routeBridgeText'), preview = $('routeBridgePreview');
  let seq = 0;
  const refresh = async () => {
    const my = ++seq;
    const { out, bad } = await parseManualBridges(text.value);
    if (my !== seq) return;
    preview.innerHTML = text.value.trim() ? `识别到 <strong>${out.length}</strong> 座跳桥${bad.length ? `，${bad.length} 行看不懂：${app.esc(bad.slice(0, 2).join('；'))}${bad.length > 2 ? ' …' : ''}` : ''}` : '';
  };
  $('routeBridgeManual').addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (!box.hidden) {
      text.value = (BR.manual || []).map((b) => `${M.byId.get(b.a)?.name} » ${M.byId.get(b.b)?.name}`).join('\n');
      refresh();
      text.focus();
    }
  });
  text.addEventListener('input', app.debounce(refresh, 200));
  $('routeBridgeCancel').addEventListener('click', () => { box.hidden = true; });
  const saveManual = (list) => {
    BR.manual = list;
    BR.adj = null;
    try { localStorage.setItem(bridgeManualKey(), JSON.stringify(list)); } catch { /* 忽略 */ }
    box.hidden = true;
    syncBridgeUi();
    if (M.route.length && J.mode !== 'jump') planRoute();
  };
  $('routeBridgeSave').addEventListener('click', async () => {
    const { out } = await parseManualBridges(text.value);
    saveManual(out);
    app.showToast(`已保存 ${out.length} 座手动跳桥`, 'success', 1500);
  });
  $('routeBridgeClearManual').addEventListener('click', () => saveManual([]));
  syncBridgeUi();
}

// 一段路线：不走跳桥时直接问 ESI；走跳桥时本地先求最短路，把用到的跳桥（双向）作为 connections 交给 ESI，ESI 失败时用本地结果
async function routeLeg(a, b, flag) {
  const base = `/route/${a}/${b}/?flag=${flag}`;
  if (!bridgesOn()) return app.fetchESI(base);
  const path = localPath(gateCosts(M.byId.get(a).i, flag), M.byId.get(b).i);
  if (!path) return app.fetchESI(base);
  const used = [];
  for (let k = 1; k < path.length; k++) if (!isGateHop(path[k - 1], path[k])) used.push([M.systems[path[k - 1]].id, M.systems[path[k]].id]);
  if (!used.length) return app.fetchESI(base);
  if (used.length <= 50) {
    const conns = used.flatMap(([x, y]) => [`connections=${x}%7C${y}`, `connections=${y}%7C${x}`]).join('&');
    try { return await app.fetchESI(`${base}&${conns}`); } catch { /* 用本地结果 */ }
  }
  return path.map((i) => M.systems[i].id);
}

// 起点固定、终点可选：状态压缩 DP 求经过全部途经点的最短顺序（途经点 ≤ 15）
// cost(a, b)：两个星系之间的代价；默认按星门图（flag 为路线偏好）
function bestWaypointOrder(start, vias, end, flag, cost = null) {
  const pts = [start, ...vias, ...(end != null ? [end] : [])];
  const dist = cost ? null : pts.map((p) => gateCosts(p, flag));
  const d = cost ? (a, b) => cost(pts[a], pts[b]) : (a, b) => dist[a][pts[b]];
  const k = vias.length, full = (1 << k) - 1;
  const dp = Array.from({ length: 1 << k }, () => new Float64Array(k).fill(Infinity));
  const prev = Array.from({ length: 1 << k }, () => new Int8Array(k).fill(-1));
  for (let j = 0; j < k; j++) dp[1 << j][j] = d(0, j + 1);
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < k; j++) {
      const cur = dp[mask][j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let t = 0; t < k; t++) {
        if (mask & (1 << t)) continue;
        const nm = mask | (1 << t), nd = cur + d(j + 1, t + 1);
        if (nd < dp[nm][t]) { dp[nm][t] = nd; prev[nm][t] = j; }
      }
    }
  }
  let last = -1, best = Infinity;
  for (let j = 0; j < k; j++) {
    const total = dp[full][j] + (end != null ? d(j + 1, k + 1) : 0);
    if (total < best) { best = total; last = j; }
  }
  if (last < 0) return null;
  const order = [];
  for (let mask = full, j = last; j >= 0;) { order.push(vias[j]); const p = prev[mask][j]; mask ^= 1 << j; j = p; }
  return order.reverse();
}

async function planRoute() {
  if (J.mode === 'jump') { planJump(); return; }
  const box = $('routeResult');
  const from = resolveRouteField($('routeFrom'));
  const toField = $('routeTo');
  const to = resolveRouteField(toField);
  const wpInputs = [...$('routeWaypoints').querySelectorAll('input')];
  const filled = wpInputs.filter((f) => f.value.trim());
  const vias = filled.map(resolveRouteField);
  const auto = $('routeOrder').value === 'auto';
  if (!from || vias.some((v) => !v) || (!to && (toField.value.trim() || !vias.length))) {
    box.innerHTML = '<p class="legend-empty">请从候选列表中选择' + (vias.length ? '起点、终点和途经星系' : '起点和终点星系') + '</p>';
    return;
  }
  const flag = $('routeFlag').value;
  box.innerHTML = '<p class="legend-empty">正在规划路线…</p>';
  if ($('routeBridgeOn').checked && app.hasEsiToken()) await fetchBridges();
  try {
    // 途经点顺序：自动时在本地星门图上求最短顺序，否则按填写顺序
    // 先在本地星门图上检查可达性，直接指出到不了的星系（波赫文、虫洞、被封锁的星系等）
    const reach = gateCosts(M.byId.get(from).i, 'shortest');
    const cut = [...vias, ...(to ? [to] : [])].filter((id) => reach[M.byId.get(id).i] === Infinity);
    if (cut.length) throw Object.assign(new Error([...new Set(cut)].map((id) => M.byId.get(id).name).join('、') + ' 无法从起点通过星门到达'), { local: true });
    let order = vias;
    if (auto && vias.length > 1) {
      const idx = (id) => M.byId.get(id).i;
      const best = bestWaypointOrder(idx(from), vias.map(idx), to ? idx(to) : null, flag);
      if (!best) throw Object.assign(new Error('有星系无法通过星门互相到达'), { local: true });
      order = best.map((i) => M.systems[i].id);
    }
    const stops = [from, ...order, ...(to ? [to] : [])].filter((id, k, a) => k === 0 || id !== a[k - 1]);
    if (stops.length < 2) throw Object.assign(new Error('起点和终点相同，请添加途经点或换一个终点'), { local: true });
    const legs = await Promise.all(stops.slice(1).map((b, k) => routeLeg(stops[k], b, flag)));
    // 拼接各段，记下每个停靠点在整条路线里的位置
    const ids = [stops[0]];
    const stopAt = new Map([[0, '起点']]);
    legs.forEach((leg, k) => {
      ids.push(...leg.slice(1));
      stopAt.set(ids.length - 1, k === legs.length - 1 && to ? '终点' : `途经 ${k + 1}`);
    });
    M.route = ids.map((id) => M.byId.get(id)?.i).filter((i) => i != null);
    // 跳桥：route 里相邻但没有星门相连的两站
    const bridgeAt = new Set();
    for (let k = 1; k < M.route.length; k++) if (!isGateHop(M.route[k - 1], M.route[k])) bridgeAt.add(k);
    // 写入游戏自动导航：途经点、终点，以及每座跳桥的两端（游戏自动导航不一定会走跳桥）
    const stopIdx = new Set(stopAt.keys());
    M.routeStops = M.route.map((i, k) => (k > 0 && (stopIdx.has(k) || bridgeAt.has(k) || bridgeAt.has(k + 1)) ? M.systems[i].id : null))
      .filter((id, k, a) => id != null && id !== a[k - 1]);
    if (!bridgeAt.size) M.routeStops = stops.slice(1);
    routeLine.material.color.setHex(ROUTE_COLORS.gate);
    const counts = { 高安: 0, 低安: 0, '00': 0 };
    M.route.forEach((i) => { counts[secClass(M.systems[i].sec)] += 1; });
    const multi = stops.length > 2;
    const legLine = multi ? '<p class="route-legs">' + stops.map((id, k) => app.esc(M.byId.get(id).name) + (k < legs.length ? ` <small>${legs[k].length - 1} 跳</small> →` : '')).join(' ') + '</p>' : '';
    box.innerHTML =
      `<div class="route-summary"><span><strong>${M.route.length - 1}</strong> 跳${bridgeAt.size ? ` <span class="route-bridge-tag">含跳桥 ${bridgeAt.size}</span>` : ''} · <span class="sec-hi">高安 ${counts['高安']}</span> · <span class="sec-lo">低安 ${counts['低安']}</span> · <span class="sec-null">00 ${counts['00']}</span></span>` +
        `<span><button class="link-btn" data-game-route title="${multi || bridgeAt.size ? '把途经点、跳桥两端和终点依次写入游戏自动导航' : '在游戏里把终点设为目的地'}（角色需在线）">写入自动导航</button> · <button class="link-btn" data-copy-route title="复制整条路线">复制路线</button></span></div>` +
      legLine +
      '<ol class="route-list">' + M.route.map((i, k) => {
        const s = M.systems[i];
        const tag = multi && stopAt.get(k);
        const cls = [tag ? 'is-stop' : '', bridgeAt.has(k) ? 'is-bridge' : ''].filter(Boolean).join(' ');
        return `<li${cls ? ` class="${cls}"` : ''}><button data-sys="${i}"${bridgeAt.has(k) ? ' title="经跳桥到达"' : ''}><i style="background:${secColor(s.sec)}"></i>${app.esc(s.name)}${bridgeAt.has(k) ? '<b class="route-bridge-tag">跳桥</b>' : ''}${tag ? `<em>${tag}</em>` : ''}<span>${secDisplay(s.sec).toFixed(1)}</span></button></li>`;
      }).join('') + '</ol>';
    updateRouteLine();
    fitTo(M.route, 1.2);
    $('routeSummary').textContent = `${M.route.length - 1} 跳` + (multi ? ` · ${stops.length - 2 + (to ? 0 : 1)} 个途经点` : '');
  } catch (error) {
    M.route = [];
    M.routeStops = [];
    $('routeSummary').textContent = '';
    box.innerHTML = '<p class="legend-empty">路线规划失败：' + app.esc(error.message) + (error.local ? '' : '（可能无法通过星门到达）') + '</p>';
    updateRouteLine();
  }
}

// ---------- 实时击杀：星图闪烁 + 弹幕 ----------
// 数据来自击杀记录服务 /api/kb/live（R2Z2 实时收录），地图打开且页面可见时每 6 秒取一次新击杀
const LIVE_POLL = 6000;
const FLASH_MS = 2600;                  // 每次闪烁 3 个脉冲
const DANMAKU_SPEED = 110;              // 像素 / 秒
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
const LIVE = { on: true, cursor: -1, timer: null, disabled: !SERVER.kb, busy: false, lanes: [], names: new Map(), types: new Map(), kills: new Map() };
M.flashes = [];
M.battles = [];                         // 疑似会战（battles.js 每 6 秒更新）

function bindLiveKills() {
  if (LIVE.disabled) $('mapLiveToggle').hidden = true;   // 晨曦服没有实时击杀数据
  LIVE.on = app.store.get('eve-map-live') !== '0';
  syncLiveToggle();
  $('mapLiveToggle').addEventListener('click', () => {
    LIVE.on = !LIVE.on;
    app.store.set('eve-map-live', LIVE.on ? '1' : '0');
    syncLiveToggle();
    if (LIVE.on) startLiveKills();
    else { stopLiveKills(); $('mapDanmaku').innerHTML = ''; hideKillTip(); M.flashes = []; invalidate(); }
    app.showToast(LIVE.on ? '已开启实时击杀推送' : '已关闭实时击杀推送', 'success', 1500);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && M.running) { pollLive(); pollMyLoc(); } });
  // 悬停弹幕：先显示一部分详情（受害者、最后一击、攻击人数、地点时间），点击再打开完整击杀记录
  $('mapDanmaku').addEventListener('mouseover', (e) => {
    const item = e.target.closest('[data-live-kill]');
    if (item) showKillTip(item);
  });
  $('mapDanmaku').addEventListener('mouseout', (e) => {
    const item = e.target.closest('[data-live-kill]');
    if (item && !item.contains(e.relatedTarget)) hideKillTip();
  });
  $('mapDanmaku').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-live-kill]');
    if (!item) return;
    hideKillTip();
    const sys = M.byId.get(Number(item.dataset.system));
    if (sys) selectSystem(sys.i, true);
    try { (await app.loadKillboard()).openServiceKill(Number(item.dataset.liveKill)); } catch (error) { app.showToast(error.message, 'error'); }
  });
}

function syncLiveToggle() {
  const btn = $('mapLiveToggle');
  btn.classList.toggle('active', LIVE.on);
  btn.setAttribute('aria-pressed', String(LIVE.on));
}

function startLiveKills() {
  if (LIVE.disabled || !LIVE.on || LIVE.timer) return;
  pollLive();
  LIVE.timer = setInterval(pollLive, LIVE_POLL);
}

function stopLiveKills() {
  clearInterval(LIVE.timer);
  LIVE.timer = null;
}

async function pollLive() {
  if (document.hidden || !M.running || LIVE.busy || LIVE.disabled) return;
  LIVE.busy = true;
  try {
    const res = await fetch('/api/kb/live?after=' + LIVE.cursor);
    if (res.status === 404) {            // 没有部署击杀记录服务：静默关闭
      LIVE.disabled = true;
      stopLiveKills();
      $('mapLiveToggle').hidden = true;
      return;
    }
    if (!res.ok) return;
    $('mapLiveToggle').hidden = false;
    const data = await res.json();
    LIVE.cursor = data.cursor;
    // 页面切回前台时可能积压很多，只播放最近 8 条
    const kills = (data.kills || []).slice(-8);
    if (!kills.length || !LIVE.on) return;
    for (const [id, name] of Object.entries(data.names || {})) if (name) LIVE.names.set(Number(id), name);
    for (const k of kills) LIVE.kills.set(k.id, k);
    while (LIVE.kills.size > 120) LIVE.kills.delete(LIVE.kills.keys().next().value);
    const missing = [...new Set(kills.flatMap((k) => [k.ship_type_id, k.final?.ship_type_id]))].filter((t) => t && !LIVE.types.has(t));
    if (missing.length) {
      const named = await app.resolveTypeNames(missing).catch(() => new Map());
      for (const [k, v] of named) LIVE.types.set(k, v);
    }
    // 均匀分散到下一个轮询周期内，避免同时涌出
    const gap = Math.min(1500, LIVE_POLL / kills.length);
    kills.forEach((k, n) => setTimeout(() => { if (LIVE.on && M.running) showLiveKill(k); }, n * gap));
  } catch { /* 网络错误：下次再试 */ } finally {
    LIVE.busy = false;
  }
}

function showLiveKill(k) {
  const s = M.byId.get(k.system_id);
  if (s) { M.flashes.push({ i: s.i, t0: performance.now(), big: k.value >= 1e9, name: s.name }); invalidate(); }
  danmaku(k, s);
}

// 闪烁：亮点 + 3 个向外扩散的圆环；10 亿以上的击杀用更大的金色圆环
function drawFlashes() {
  if (!M.flashes.length) return;
  const now = performance.now();
  M.flashes = M.flashes.filter((f) => now - f.t0 < FLASH_MS);
  for (const f of M.flashes) {
    const x = M.screen[f.i * 3], y = M.screen[f.i * 3 + 1], z = M.screen[f.i * 3 + 2];
    if (z > 1 || x < -40 || y < -40 || x > M.size.w + 40 || y > M.size.h + 40) continue;
    const t = (now - f.t0) / FLASH_MS;
    const phase = (t * 3) % 1;
    const fade = 1 - t * 0.6;
    const color = f.big ? '255, 196, 0' : '255, 82, 64';
    lg.lineWidth = f.big ? 2.5 : 2;
    lg.strokeStyle = `rgba(${color}, ${(1 - phase) * fade})`;
    lg.beginPath();
    lg.arc(x, y, 4 + phase * (f.big ? 34 : 22), 0, Math.PI * 2);
    lg.stroke();
    lg.fillStyle = `rgba(255, 240, 220, ${0.55 + 0.45 * Math.cos(phase * Math.PI * 2) * fade})`;
    lg.beginPath();
    lg.arc(x, y, f.big ? 4.5 : 3.5, 0, Math.PI * 2);
    lg.fill();
    if (t < 0.8) {
      lg.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
      lg.fillStyle = `rgba(${color}, ${fade})`;
      lg.fillText(f.name, x + 10, y - 8);
    }
  }
}

// 会战：按规模分三档，持续期间一直显示（与单次击杀的红色扩散圈区分）
//   小型：紫色，慢呼吸光晕 + 缓慢旋转的虚线圈
//   中型：橙色，较快呼吸 + 两道反向旋转的虚线圈 + 周期性扩散波
//   大型：红色，快速脉冲 + 三道交错冲击波 + 旋转准星
const BATTLE_STYLE = {
  small: { rgb: '180, 108, 255', label: 'rgba(88, 40, 140, 0.92)', text: '#f1e4ff', r: 18, period: 3, spin: 12, waves: 0 },
  medium: { rgb: '255, 156, 56', label: 'rgba(150, 72, 8, 0.94)', text: '#fff1e0', r: 26, period: 2, spin: 24, waves: 1, wavePeriod: 2.2 },
  large: { rgb: '255, 64, 64', label: 'rgba(160, 16, 24, 0.95)', text: '#ffe6e6', r: 34, period: 1, spin: 40, waves: 3, wavePeriod: 1.8 }
};
const battleTierKey = (kills) => (kills >= 100 ? 'large' : kills >= 50 ? 'medium' : 'small');

function ring(x, y, r, color, width, dash, offset) {
  lg.setLineDash(dash || []);
  lg.lineDashOffset = offset || 0;
  lg.lineWidth = width;
  lg.strokeStyle = color;
  lg.beginPath();
  lg.arc(x, y, r, 0, Math.PI * 2);
  lg.stroke();
}

function drawBattles() {
  if (!M.battles.length) return;
  const still = REDUCED_MOTION.matches;
  const t = still ? 0 : performance.now() / 1000;
  const font = getComputedStyle(document.body).fontFamily;
  // 小的先画，大型会战压在最上层
  for (const b of [...M.battles].sort((a, c) => a.kills - c.kills)) {
    const s = M.byId.get(b.system_id);
    if (!s || !onScreen(s.i, 90)) continue;
    const x = M.screen[s.i * 3], y = M.screen[s.i * 3 + 1];
    const tier = M.battleTier ? M.battleTier(b.kills) : null;
    const key = tier?.key || battleTierKey(b.kills);
    const st = BATTLE_STYLE[key];
    const r = st.r + Math.min(10, Math.sqrt(b.kills) * 0.6);
    const breathe = still ? 0.6 : 0.5 + 0.5 * Math.sin(t * Math.PI * 2 / st.period);
    lg.save();
    // 光晕
    const gr = r * (key === 'large' ? 2 : 1.6) * (key === 'large' ? 0.9 + 0.15 * breathe : 1);
    const glow = lg.createRadialGradient(x, y, 0, x, y, gr);
    glow.addColorStop(0, `rgba(${st.rgb}, ${0.3 + 0.3 * breathe})`);
    glow.addColorStop(1, `rgba(${st.rgb}, 0)`);
    lg.fillStyle = glow;
    lg.beginPath();
    lg.arc(x, y, gr, 0, Math.PI * 2);
    lg.fill();
    // 扩散波 / 冲击波
    if (!still) {
      for (let w = 0; w < st.waves; w++) {
        const p = ((t / st.wavePeriod) + w / st.waves) % 1;
        const wr = r * (0.8 + p * (key === 'large' ? 2.4 : 1.6));
        ring(x, y, wr, `rgba(${st.rgb}, ${(1 - p) * (key === 'large' ? 0.8 : 0.6)})`, key === 'large' ? 2.5 * (1 - p) + 0.5 : 1.5);
      }
    }
    // 主圈（旋转虚线）
    ring(x, y, r, `rgba(${st.rgb}, ${0.65 + 0.35 * breathe})`, 2, [6, 5], -t * st.spin);
    if (key !== 'small') ring(x, y, r * 0.7, `rgba(${st.rgb}, ${0.45 + 0.3 * breathe})`, 1.5, [3, 4], t * st.spin * 1.3);
    // 大型：旋转准星（四段弧 + 刻度）与闪烁的核心
    if (key === 'large') {
      const a0 = t * 0.9;
      lg.setLineDash([]);
      lg.lineWidth = 3;
      lg.strokeStyle = `rgba(${st.rgb}, 0.95)`;
      for (let k = 0; k < 4; k++) {
        const a = a0 + k * Math.PI / 2;
        lg.beginPath();
        lg.arc(x, y, r * 1.3, a - 0.32, a + 0.32);
        lg.stroke();
        lg.beginPath();
        lg.moveTo(x + Math.cos(a) * r * 1.42, y + Math.sin(a) * r * 1.42);
        lg.lineTo(x + Math.cos(a) * r * 1.62, y + Math.sin(a) * r * 1.62);
        lg.stroke();
      }
      lg.fillStyle = `rgba(255, 220, 200, ${0.55 + 0.45 * breathe})`;
      lg.beginPath();
      lg.arc(x, y, 3 + 2 * breathe, 0, Math.PI * 2);
      lg.fill();
    }
    lg.restore();
    // 标签
    const text = `${tier?.name || { small: '小型会战', medium: '中型会战', large: '大型会战' }[key]} · ${b.kills} 艘`;
    lg.font = `600 ${key === 'large' ? 12 : 11}px ${font}`;
    lg.textAlign = 'center';
    lg.textBaseline = 'middle';
    const tw = lg.measureText(text).width + 14;
    const ly = y - r * (key === 'large' ? 1.62 : 1) - (key === 'large' ? 18 : 24);
    lg.fillStyle = st.label;
    lg.beginPath();
    lg.roundRect(x - tw / 2, ly, tw, 18, 9);
    lg.fill();
    lg.fillStyle = st.text;
    lg.fillText(text, x, ly + 9);
    lg.textAlign = 'left';
  }
}

// ---------- 弹幕悬停详情 ----------
function killTipEl() {
  let tip = $('mapKillTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'mapKillTip';
    tip.className = 'kill-tip';
    tip.hidden = true;
    $('mapDanmaku').parentElement.appendChild(tip);
  }
  return tip;
}

function liveName(id) {
  return (id && (LIVE.names.get(id) || app.officialName(id))) || '';
}

function killAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  return Math.floor(sec / 3600) + ' 小时前';
}

function showKillTip(item) {
  const k = LIVE.kills.get(Number(item.dataset.liveKill));
  if (!k) return;
  const tip = killTipEl();
  const s = M.byId.get(k.system_id);
  const v = k.victim || {};
  const f = k.final || {};
  const img = (path, size = 32) => `https://images.evetech.net/${path}?size=${size}`;
  const party = (p, fallback) => {
    const who = liveName(p.character_id) || liveName(p.corporation_id) || fallback;
    const org = [p.character_id ? liveName(p.corporation_id) : '', liveName(p.alliance_id)].filter(Boolean).join(' · ');
    const pic = p.character_id ? img(`characters/${p.character_id}/portrait`) : p.corporation_id ? img(`corporations/${p.corporation_id}/logo`) : '';
    return `<div class="kill-tip-party">${pic ? `<img src="${pic}" alt="" width="28" height="28">` : '<span class="kill-tip-blank"></span>'}<div><b>${app.esc(who)}</b>${org ? `<small>${app.esc(org)}</small>` : ''}</div></div>`;
  };
  const tags = [k.solo ? '单刷' : '', k.npc ? 'NPC 击杀' : ''].filter(Boolean).map((t) => `<i>${t}</i>`).join('');
  const where = s ? `${app.esc(s.name)} <span style="color:${secColor(s.sec)}">${secDisplay(s.sec).toFixed(1)}</span> · ${app.esc(regionName(s.region))}` : '虫洞空间';
  tip.innerHTML = `
    <div class="kill-tip-head"><img src="${img(`types/${k.ship_type_id}/render`, 64)}" alt="" width="44" height="44">
      <div><b>${app.esc(LIVE.types.get(k.ship_type_id) || '舰船')}</b><small>${where}</small></div>
      <strong>${app.formatISK(k.value)}<span>ISK</span></strong></div>
    <div class="kill-tip-label">受害者</div>${party(v, '未知')}
    <div class="kill-tip-label">最后一击${f.ship_type_id && LIVE.types.get(f.ship_type_id) ? ` · ${app.esc(LIVE.types.get(f.ship_type_id))}` : ''}</div>${party(f, k.npc ? 'NPC' : '未知')}
    <div class="kill-tip-foot"><span>${app.formatNumber(k.attackers || 0)} 名攻击者</span>${tags}<span class="kill-tip-time">${killAgo(k.time)}</span></div>
    <div class="kill-tip-hint">点击查看完整击杀记录</div>`;
  tip.hidden = false;
  // 弹幕悬停时暂停滚动，提示框贴在弹幕下方，左右不超出星图
  const host = tip.parentElement.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  const w = tip.offsetWidth;
  const left = Math.max(8, Math.min(r.left - host.left, host.width - w - 8));
  tip.style.left = left + 'px';
  tip.style.top = (r.bottom - host.top + 6) + 'px';
}

function hideKillTip() {
  const tip = $('mapKillTip');
  if (tip) tip.hidden = true;
}

// 弹幕：从右向左滚过星图上方；多条轨道，选最早空出的一条
function danmaku(k, s) {
  const box = $('mapDanmaku');
  const laneCount = M.size.w < 600 ? 3 : 4;
  while (LIVE.lanes.length < laneCount) LIVE.lanes.push(0);
  const now = performance.now();
  let lane = 0;
  for (let n = 1; n < laneCount; n++) if (LIVE.lanes[n] < LIVE.lanes[lane]) lane = n;
  const v = k.victim;
  const victim = LIVE.names.get(v.character_id) || app.officialName(v.corporation_id) || LIVE.names.get(v.corporation_id) || '';
  const sysName = s ? s.name : '虫洞空间';
  const secText = s ? `<i style="color:${secColor(s.sec)}">${secDisplay(s.sec).toFixed(1)}</i>` : '';
  const tier = k.value >= 1e10 ? ' huge' : k.value >= 1e9 ? ' big' : '';
  const el = document.createElement('button');
  el.className = 'danmaku-item' + tier;
  el.dataset.liveKill = k.id;
  el.dataset.system = k.system_id;
  el.title = '点击查看击杀详情';
  el.innerHTML = `<img src="https://images.evetech.net/types/${k.ship_type_id}/icon?size=32" alt="" width="20" height="20">` +
    `<b>${app.esc(LIVE.types.get(k.ship_type_id) || '舰船')}</b>` +
    (victim ? `<span>${app.esc(victim)}</span>` : '') +
    `<em>${app.esc(sysName)} ${secText}</em><strong>${app.formatISK(k.value)}</strong>`;
  el.style.top = (8 + lane * 32) + 'px';
  // 先不跑动画：量宽度时会触发样式计算，新版 Chrome 会把时长 0 的动画当场结束并触发 animationend
  el.style.animationName = 'none';
  box.appendChild(el);
  if (REDUCED_MOTION.matches) {
    el.classList.add('static');
    LIVE.lanes[lane] = now + 6000;
    setTimeout(() => el.remove(), 6000);
    return;
  }
  const width = el.offsetWidth;
  const distance = M.size.w + width;
  const duration = distance / DANMAKU_SPEED;
  el.style.setProperty('--from', M.size.w + 'px');
  el.style.setProperty('--to', -width + 'px');
  el.style.animationDuration = duration + 's';
  el.style.animationName = '';
  // 这条轨道在弹幕尾部离开右边缘（再留 40px 间距）后才可复用
  LIVE.lanes[lane] = Math.max(now, LIVE.lanes[lane]) + ((width + 40) / DANMAKU_SPEED) * 1000;
  el.addEventListener('animationend', () => { if (el.matches(':hover')) hideKillTip(); el.remove(); });
}

// ---------- 旗舰跳跃规划 ----------
const J = { mode: 'gate', ships: null, loading: null, structures: null, esiSkills: null, settings: { ship: 23757, jdc: 5, jfc: 4, jf: 4, dock: 'any', skillSrc: 'manual' } };

// 跳跃相关技能：跳跃引擎校准理论、跳跃燃料节约、战略货舰操作
const JUMP_SKILLS = { jdc: 21611, jfc: 21610, jf: 29029 };

// 实际使用的技能等级：手动设置 / 全部 5 级 / 已绑定角色的技能
function jumpSkills() {
  const src = J.settings.skillSrc;
  if (src === 'max') return { jdc: 5, jfc: 5, jf: 5 };
  if (src === 'esi' && J.esiSkills) {
    const lv = (id) => J.esiSkills.levels.get(id) || 0;
    return { jdc: lv(JUMP_SKILLS.jdc), jfc: lv(JUMP_SKILLS.jfc), jf: lv(JUMP_SKILLS.jf) };
  }
  return { jdc: J.settings.jdc, jfc: J.settings.jfc, jf: J.settings.jf };
}

// 切换到「按 ESI 角色技能」时读取角色技能；失败则提示并退回手动设置
async function applySkillSource() {
  const src = J.settings.skillSrc;
  const note = $('jumpSkillNote');
  if (src === 'esi') {
    note.hidden = false;
    note.textContent = '正在读取角色技能…';
    try {
      J.esiSkills = await app.getCharacterSkills();
      note.textContent = `已按 ${J.esiSkills.name} 的技能计算`;
    } catch (error) {
      J.esiSkills = null;
      note.innerHTML = '<span class="warn">读取角色技能失败：' + app.esc(error.message) + '，暂按手动设置计算</span>';
    }
  } else {
    note.hidden = true;
  }
  const eff = jumpSkills();
  for (const key of ['jdc', 'jfc', 'jf']) {
    const el = $('jump' + key[0].toUpperCase() + key.slice(1));
    el.value = eff[key];
    el.disabled = src !== 'manual';
  }
  syncJumpOptions();
}

function bindJumpPlanner() {
  try { Object.assign(J.settings, app.store.getJSON('eve-jump-settings', {})); } catch { /* 使用默认设置 */ }
  const levels = [0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} 级</option>`).join('');
  for (const id of ['jumpJdc', 'jumpJfc', 'jumpJf']) $(id).innerHTML = levels;
  $('jumpJdc').value = J.settings.jdc;
  $('jumpJfc').value = J.settings.jfc;
  $('jumpJf').value = J.settings.jf;
  if (typeof J.settings.dock !== 'string') J.settings.dock = J.settings.dock ? 'npc' : 'any';   // 旧版是复选框
  $('jumpDock').value = J.settings.dock;
  $('jumpSkillSrc').value = J.settings.skillSrc || 'manual';
  document.querySelectorAll('[data-route-mode]').forEach((btn) => btn.addEventListener('click', () => { setPanel('route', true); setRouteMode(btn.dataset.routeMode); }));
  const onChange = async (e) => {
    const manual = J.settings.skillSrc === 'manual';
    J.settings = {
      ship: Number($('jumpShip').value) || J.settings.ship,
      // 非手动模式下技能下拉框显示的是计算值，不覆盖手动设置
      jdc: manual ? Number($('jumpJdc').value) : J.settings.jdc,
      jfc: manual ? Number($('jumpJfc').value) : J.settings.jfc,
      jf: manual ? Number($('jumpJf').value) : J.settings.jf,
      dock: $('jumpDock').value, skillSrc: $('jumpSkillSrc').value
    };
    app.store.setJSON('eve-jump-settings', J.settings);
    if (e?.target?.id === 'jumpSkillSrc') await applySkillSource();
    else syncJumpOptions();
    if (M.route.length && J.mode === 'jump') planJump();
  };
  for (const id of ['jumpShip', 'jumpJdc', 'jumpJfc', 'jumpJf', 'jumpDock', 'jumpSkillSrc']) $(id).addEventListener('change', onChange);
  applySkillSource();
  $('jumpDockNote').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-structures-refresh]')) return;
    try {
      await ensureStructures(true);
      if (M.route.length) planJump(); else $('routeResult').innerHTML = '';
    } catch (error) {
      $('routeResult').innerHTML = '<p class="legend-empty">' + app.esc(error.message) + '</p>';
    }
  });
  if (app.store.get('eve-route-mode') === 'jump') setRouteMode('jump');
}

async function setRouteMode(mode) {
  if (J.mode === mode) return;
  J.mode = mode;
  app.store.set('eve-route-mode', mode);
  document.querySelectorAll('[data-route-mode]').forEach((b) => b.classList.toggle('active', b.dataset.routeMode === mode));
  $('jumpOptions').hidden = mode !== 'jump';
  $('routeFlag').hidden = mode === 'jump';
  syncBridgeUi();
  $('routeSummary').textContent = '';
  M.route = [];
  $('routeResult').innerHTML = '';
  clearJumpRange();
  updateRouteLine();
  if (mode === 'jump') await ensureJumpShips();
}

async function ensureJumpShips() {
  if (J.ships) return J.ships;
  if (!J.loading) {
    J.loading = JP.loadJumpShips(app.fetchESI).then((ships) => {
      J.ships = ships;
      const groups = new Map(JP.SHIP_GROUPS);
      let html = '', current = null;
      for (const ship of ships) {
        if (ship.group !== current) { html += (current ? '</optgroup>' : '') + `<optgroup label="${app.esc(groups.get(ship.group))}">`; current = ship.group; }
        html += `<option value="${ship.id}">${app.esc(ship.name)}</option>`;
      }
      $('jumpShip').innerHTML = html + (current ? '</optgroup>' : '');
      if (!ships.some((x) => x.id === J.settings.ship)) J.settings.ship = ships[0]?.id;
      $('jumpShip').value = J.settings.ship;
      syncJumpOptions();
      return ships;
    }).catch((error) => {
      J.loading = null;
      $('jumpShip').innerHTML = '<option>舰船数据载入失败</option>';
      throw error;
    });
  }
  return J.loading;
}

function currentShip() {
  return J.ships?.find((x) => x.id === J.settings.ship) || null;
}

function syncJumpOptions() {
  const ship = currentShip();
  if (!ship) return;
  $('jumpJfWrap').hidden = ship.group !== 902;
  const sk = jumpSkills();
  const range = JP.maxRange(ship, sk.jdc);
  const perLy = JP.fuelPerLy(ship, sk.jfc, sk.jf);
  $('jumpRange').innerHTML = `最大跳跃距离 <strong>${range.toFixed(2)}</strong> 光年 · 每光年 ${app.formatNumber(Math.round(perLy))} ${ISOTOPE_ZH[ship.fuelType] || '燃料'}` +
    (ship.fatigue < 1 ? ` · 疲劳距离 ×${ship.fatigue}` : '');

  // 「含玩家建筑」需要绑定 ESI；超旗不能停 NPC 空间站
  const bound = app.hasEsiToken();
  const allOpt = $('jumpDock').querySelector('option[value="all"]');
  allOpt.disabled = !bound;
  allOpt.textContent = '必须可停靠（含玩家建筑）' + (bound ? '' : ' · 需绑定 ESI');
  if (!bound && $('jumpDock').value === 'all') { $('jumpDock').value = 'npc'; J.settings.dock = 'npc'; }
  const esiOpt = $('jumpSkillSrc').querySelector('option[value="esi"]');
  esiOpt.disabled = !bound;
  esiOpt.textContent = '按 ESI 角色技能' + (bound ? '' : ' · 需绑定 ESI');
  const dock = J.settings.dock;
  const can = [JP.canDockNpc(ship) ? 'NPC 空间站' : null,
    ...DOCK_NOTE_TYPES.filter((t) => JP.canDockStructure(ship, t)).map((t) => JP.STRUCTURES[t][0])].filter(Boolean);
  const note = $('jumpDockNote');
  note.hidden = dock === 'any';
  note.innerHTML = dock === 'any' ? '' : `${app.esc(ship.name)} 可停靠：${can.map(app.esc).join('、')}` +
    (dock === 'npc' && !JP.canDockNpc(ship) ? '<br><span class="warn">超级航母和泰坦不能停靠 NPC 空间站，请改选「含玩家建筑」</span>' : '') +
    (dock === 'prefer' && !bound ? '<br>未绑定 ESI，只按 NPC 空间站判断是否可停靠' : '') +
    (dock === 'prefer' && !JP.canDockNpc(ship) && !bound ? '<br><span class="warn">超级航母和泰坦不能停靠 NPC 空间站，绑定 ESI 后才能按玩家建筑判断</span>' : '') +
    (useStructures(dock) && J.structures && !J.structures.privateSearched ? '<br><span class="warn">当前授权没有建筑搜索权限，只能从订单、合同、资产、克隆位置找到内部建筑；重新绑定 ESI 后可找到全部有停靠权限的建筑</span>' : '') +
    (useStructures(dock) && J.structures ? `<br>已读取玩家建筑 ${app.formatNumber(J.structures.list.length + (J.structures.private?.length || 0))} 个（其中军团 / 联盟内部 ${app.formatNumber(J.structures.private?.length || 0)} 个，仅限你有停靠权限的）· <button class="link-btn" data-structures-refresh>重新读取</button>` : '');
}

// 说明文字只列基础型号（派系铁壁与铁壁相同）
const DOCK_NOTE_TYPES = [35832, 35825, 35835, 35836, 35833, 35826, 35827, 35834];

// 读取玩家建筑（绑定 ESI 后可用；公开部分读一次后缓存 24 小时，另含你有停靠权限的军团/联盟内部建筑）
async function ensureStructures(force = false) {
  if (J.structures && !force) return J.structures;
  if (force) { try { localStorage.removeItem(serverKey('eve-public-structures-v1')); } catch { /* 忽略 */ } }
  const token = await app.getEsiToken();
  if (JP.hasStructureScope(token) === false) throw new Error('当前 ESI 授权不包含读取玩家建筑（esi-universe.read_structures.v1），请重新绑定 ESI');
  const box = $('routeResult');
  J.structures = await JP.loadPublicStructures(app.getEsiToken, (done, total, phase) => {
    if (phase === 'private') box.innerHTML = `<p class="legend-empty">正在查找你有停靠权限的军团 / 联盟建筑 ${done} / ${total}…</p>`;
    else if (done % 20 === 0 || done === total) box.innerHTML = `<p class="legend-empty">正在读取玩家建筑 ${done} / ${total}（首次读取，之后缓存 24 小时）…</p>`;
  });
  J.structBySys = new Map();
  for (const st of [...J.structures.list, ...(J.structures.private || [])]) {
    if (!J.structBySys.has(st.system)) J.structBySys.set(st.system, []);
    J.structBySys.get(st.system).push(st);
  }
  syncJumpOptions();
  return J.structures;
}

// 是否按玩家建筑判断停靠：「必须可停靠」或「优先可停靠」（需已绑定 ESI）
const useStructures = (dock) => dock === 'all' || (dock === 'prefer' && app.hasEsiToken());

// 中途停靠约束：stops 为必须停靠的星系集合，prefer 为优先停靠的星系集合；都为 null 表示不限
async function dockStops(ship) {
  const dock = J.settings.dock;
  if (dock === 'any') return { stops: null, prefer: null };
  const set = new Set();
  if (JP.canDockNpc(ship)) for (const s of M.systems) if (s.stations.length) set.add(s.i);
  if (useStructures(dock)) {
    await ensureStructures();
    for (const st of [...J.structures.list, ...(J.structures.private || [])]) {
      const s = M.byId.get(st.system);
      if (s && JP.canDockStructure(ship, st.type)) set.add(s.i);
    }
  }
  if (dock === 'prefer') return { stops: null, prefer: set };
  if (!set.size) throw new Error(dock === 'npc' ? `${ship.name} 不能停靠 NPC 空间站，请改选「含玩家建筑」` : '没有可停靠的星系');
  return { stops: set, prefer: null };
}

// 某星系对当前舰船可停靠的设施
function dockingAt(i, ship) {
  const s = M.systems[i];
  const npc = JP.canDockNpc(ship) ? s.stations.length : 0;
  const structures = useStructures(J.settings.dock) ? (J.structBySys?.get(s.id) || []).filter((st) => JP.canDockStructure(ship, st.type)) : [];
  return { npc, structures };
}

async function planJump() {
  const box = $('routeResult');
  const from = resolveRouteField($('routeFrom'));
  const toField = $('routeTo');
  const to = resolveRouteField(toField);
  const vias = [...$('routeWaypoints').querySelectorAll('input')].filter((f) => f.value.trim()).map(resolveRouteField);
  if (!from || vias.some((v) => !v) || (!to && (toField.value.trim() || !vias.length))) {
    box.innerHTML = '<p class="legend-empty">请从候选列表中选择' + (vias.length ? '起点、终点和途经星系' : '起点和终点星系') + '</p>';
    return;
  }
  box.innerHTML = '<p class="legend-empty">正在规划跳跃路线…</p>';
  let ship;
  try {
    await ensureJumpShips();
    ship = currentShip();
  } catch (error) {
    box.innerHTML = '<p class="legend-empty">舰船数据载入失败：' + app.esc(error.message) + '</p>';
    return;
  }
  if (!ship) { box.innerHTML = '<p class="legend-empty">请选择舰船</p>'; return; }
  await new Promise((r) => setTimeout(r));   // 先让“正在规划”显示出来
  const sk = jumpSkills();
  const range = JP.maxRange(ship, sk.jdc);
  const idx = (id) => M.byId.get(id).i;
  const a = idx(from);
  let dockRule;
  try {
    dockRule = await dockStops(ship);
  } catch (error) {
    box.innerHTML = '<p class="legend-empty">' + app.esc(error.message) + '</p>';
    return;
  }
  // 途经点顺序：自动时按直线光年求最短顺序，否则按填写顺序
  let order = vias.map(idx);
  if ($('routeOrder').value === 'auto' && order.length > 1) {
    order = bestWaypointOrder(a, order, to ? idx(to) : null, null, (p, q) => JP.lyBetween(M.systems[p], M.systems[q]));
  }
  const stops = [a, ...order, ...(to ? [idx(to)] : [])].filter((i, k, arr) => k === 0 || i !== arr[k - 1]);
  const plan = planJumpStops(stops, { range, ...dockRule }, !to);
  clearJumpRange();
  if (plan.error) {
    M.route = [];
    $('routeSummary').textContent = '';
    updateRouteLine();
    box.innerHTML = '<p class="legend-empty">' + app.esc(plan.error) + '</p>';
    return;
  }
  // 角色当前的跳跃疲劳（需要「跳跃疲劳」权限），作为第一跳之前的疲劳
  const fatigue = app.getFatigue ? await app.getFatigue().catch(() => null) : null;
  const sim = JP.simulate(plan.legs, ship, { jfc: sk.jfc, jfSkill: sk.jf, fatigue: fatigue?.minutes || 0 });
  J.plan = { ...plan, sim, ship, origin: a, range, prefer: dockRule.prefer, fatigue };
  M.route = [...plan.path, ...plan.gates];
  routeLine.material.color.setHex(ROUTE_COLORS.jump);
  updateRouteLine();
  fitTo(M.route, 1.25);
  renderJumpPlan();
  $('routeSummary').textContent = `${sim.rows.length} 次跳跃` + (plan.stopAt.size ? ` · ${plan.stopAt.size} 个途经点` : '');
  const prices = await app.getMarketPriceMap().catch(() => new Map());
  const unit = prices.get(ship.fuelType);
  if (unit && J.plan?.sim === sim && $('jumpFuelIsk')) $('jumpFuelIsk').textContent = '≈ ' + app.formatISK(unit * sim.fuel) + ' ISK';
}

// 依次规划每一段（起点 → 途经点 → … → 终点）再拼接；途经点必须能直接跳入，只有最后一站可以落地后再走星门
function planJumpStops(stops, opts, endIsVia = false) {
  if (stops.length < 2) return { error: '起点和终点相同，请添加途经点或换一个终点' };
  const bad = stops.slice(1, -1).find((i) => !JP.canJumpInto(M.systems[i]));
  if (bad != null) return { error: `途经点 ${M.systems[bad].name} 不能直接跳入（高安等），请移除或换成附近可跳入的星系` };
  const path = [stops[0]], legs = [], stopAt = new Map();
  let last = null;
  for (let k = 1; k < stops.length; k++) {
    const seg = JP.planJumpRoute(M.systems, stops[k - 1], stops[k], opts);
    if (seg.error) return { error: stops.length > 2 ? `${M.systems[stops[k - 1]].name} → ${M.systems[stops[k]].name}：${seg.error}` : seg.error };
    path.push(...seg.path.slice(1));
    legs.push(...seg.legs);
    if (k < stops.length - 1 || endIsVia) stopAt.set(path.length - 1, `途经 ${k}`);
    last = seg;
  }
  return { path, legs, gates: last.gates, landing: last.landing, stopAt, stops };
}

function renderJumpPlan() {
  const { sim, gates, ship, path, landing, range, prefer, fatigue, stopAt, stops } = J.plan;
  const fatigueNote = fatigue?.minutes > 0 ? `<p class="jump-note warn">已计入角色当前的跳跃疲劳：剩余 ${JP.formatMinutes(fatigue.minutes)}（${new Date(fatigue.expires).toLocaleString('zh-CN', { hour12: false })} 消退）</p>`
    : fatigue ? '<p class="jump-note">角色当前没有跳跃疲劳</p>'
      : app.hasEsiToken() ? '<p class="jump-note">按零疲劳估算。<button class="link-btn" data-scope-rebind="fatigue">授权「跳跃疲劳」</button>后可按角色实际疲劳计算</p>' : '';
  // 「优先可停靠」模式下，中途无法停靠的星系单独标出
  const noDock = prefer ? path.slice(1, -1).filter((i) => !prefer.has(i)) : [];
  const sys = (i) => M.systems[i];
  const fuelName = ISOTOPE_ZH[ship.fuelType] || '燃料';
  const row = (i, extra, cls = '', stop = '') => {
    const s = sys(i);
    const { npc, structures } = dockingAt(i, ship);
    const tags = (stop ? `<em>${stop}</em>` : '') + (npc ? `<em class="jump-station" title="${npc} 个 NPC 空间站">站</em>` : '') +
      (noDock.includes(i) ? '<em class="jump-station is-nodock" title="没有可停靠的空间站或建筑，只能停在太空">不可停靠</em>' : '');
    // 可停靠的玩家建筑直接列出游戏内名称（最多 3 座，其余放在提示里）
    const dockName = (st) => `<span class="jump-dock" title="${app.esc(JP.STRUCTURES[st.type][0] + ' · ' + st.name)}"><b>${app.esc(JP.STRUCTURES[st.type][0])}</b>${app.esc(st.name)}</span>`;
    const docks = structures.length ? `<div class="jump-docks">${structures.slice(0, 3).map(dockName).join('')}${structures.length > 3
      ? `<span class="jump-dock-more" title="${app.esc(structures.slice(3, 20).map((st) => `${JP.STRUCTURES[st.type][0]} · ${st.name}`).join('\n'))}">另有 ${structures.length - 3} 座可停靠建筑</span>` : ''}</div>` : '';
    if (stop) cls = (cls + ' is-stop').trim();
    return `<li class="${cls}"><button data-sys="${i}"><i style="background:${secColor(s.sec)}"></i>${app.esc(s.name)}<span>${secDisplay(s.sec).toFixed(1)}</span>${tags}</button>${docks}${extra || ''}</li>`;
  };
  const legs = sim.rows.map((r, k) => row(r.to,
    `<div class="jump-leg"><span>${r.ly.toFixed(2)} 光年</span><span>${app.formatNumber(r.fuel)} 燃料</span><span title="跳后重新激活冷却">冷却 ${JP.formatMinutes(r.cooldown)}</span><span title="跳后疲劳">疲劳 ${JP.formatMinutes(r.fatigue)}</span></div>`, '', stopAt.get(k + 1))).join('');
  // 多段路线：列出每段的跳跃次数
  const cut = [...new Set([0, ...stopAt.keys(), path.length - 1])];
  const legLine = stopAt.size ? '<p class="route-legs">' + stops.map((i, k) => app.esc(sys(i).name) + (k < stops.length - 1 ? ` <small>${cut[k + 1] - cut[k]} 跳</small> →` : '')).join(' ') + '</p>' : '';
  const gateRows = gates.map((i) => row(i, '', 'is-gate')).join('');
  const dest = sys(gates.length ? gates[gates.length - 1] : landing);
  $('routeResult').innerHTML = `
    <div class="jump-summary">
      <div><strong>${sim.rows.length}</strong><span>次跳跃</span></div>
      <div><strong>${sim.totalLy.toFixed(1)}</strong><span>光年</span></div>
      <div><strong>${app.formatNumber(sim.fuel)}</strong><span>${fuelName}</span></div>
    </div>
    <p class="jump-note"><span id="jumpFuelIsk"></span>${sim.rows.length > 1 ? ` · 连续跳完约 ${JP.formatMinutes(sim.travel)}` : ''} · 到达后疲劳约 ${JP.formatMinutes(sim.finalFatigue)}，冷却 ${JP.formatMinutes(sim.finalCooldown)}</p>
    ${fatigueNote}
    ${prefer ? `<p class="jump-note${noDock.length ? ' warn' : ''}">${noDock.length ? `已尽量选择可停靠的中途点，仍有 ${noDock.length} 处无法停靠（当前跳跃距离内没有可停靠的替代星系）` : '所有中途点都可以停靠'}</p>` : ''}
    ${gates.length ? `<p class="jump-note warn">${app.esc(dest.name)} 不能直接跳入（高安等），跳到 ${app.esc(sys(landing).name)} 后再走 ${gates.length} 个星门</p>` : ''}
    <div class="route-summary"><span>${app.esc(ship.name)} · 最大 ${range.toFixed(2)} 光年</span>
      <span><button class="link-btn" data-jump-range title="在星图上高亮起点一跳可达的星系">一跳范围</button> · <button class="link-btn" data-game-route title="把每个跳跃落点依次写入游戏自动导航（角色需在线）">写入航点</button> · <button class="link-btn" data-copy-route title="复制整条路线">复制路线</button></span></div>
    ${legLine}
    <ol class="route-list jump-list">${row(path[0], '<div class="jump-leg"><span>起点</span></div>')}${legs}${gateRows}</ol>
    <p class="jump-foot">冷却与疲劳按 CCP 公布的规则估算（疲劳上限 5 小时、冷却上限 30 分钟），并假设每次冷却结束立即起跳；燃料按所选技能计算。</p>`;
}

function toggleJumpRange() {
  if (M.highlightKey === 'jump-range') { clearJumpRange(); return; }
  const p = J.plan;
  if (!p) return;
  const set = new Set(JP.inRange(M.systems, M.systems[p.origin], p.range));
  set.add(p.origin);
  M.highlight = set;
  M.highlightKey = 'jump-range';
  renderLegend();
  applyColors();
  invalidate();
  app.showToast(`${M.systems[p.origin].name} 一跳可达 ${set.size - 1} 个星系`, 'success', 2000);
}

function clearJumpRange() {
  if (M.highlightKey !== 'jump-range') return;
  M.highlight = null;
  M.highlightKey = null;
  renderLegend();
  applyColors();
  invalidate();
}

// ---------- 信息面板 ----------
function closeInfo() {
  $('mapInfo').hidden = true;
  M.selected = null;
  if (location.hash.startsWith('#map')) history.replaceState(null, '', location.pathname);
  if (M.layer === 'distance') { computeLayer(); renderLegend(); }
  invalidate();
}

// 两个星系之间的星门跳数（广度优先，带简单缓存）
const hopCache = new Map();
function hopsBetween(a, b) {
  if (!hopCache.has(a)) {
    const hops = new Int16Array(M.systems.length).fill(-1);
    hops[a] = 0;
    const queue = [a];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const n of M.systems[cur].nbr) if (hops[n] < 0) { hops[n] = hops[cur] + 1; queue.push(n); }
    }
    hopCache.clear();
    hopCache.set(a, hops);
  }
  return hopCache.get(a)[b];
}

function selectSystem(i, center) {
  M.selected = i;
  M.infoRegion = null;
  if (center) centerOn(i);
  renderSystemInfo(M.systems[i]);
  history.replaceState(null, '', '#map=' + M.systems[i].id);   // 可分享的链接
  if (M.layer === 'distance') { computeLayer(); renderLegend(); }
  invalidate();
}

function myStatusHtml(s) {
  if (M.myLocation === s.i) return '<div class="map-status mine">我的角色当前在此星系</div>';
  const h = hopsBetween(M.myLocation, s.i);
  return `<div class="map-status mine">距我的位置（${app.esc(M.systems[M.myLocation].name)}）${h < 0 ? '无法通过星门到达' : h + ' 跳'}</div>`;
}

function statCell(label, value) {
  return `<div class="map-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderSystemInfo(s) {
  if (!IND.map) loadIndustry();
  const owner = ownerOf(s);
  const kills = M.live.kills.get(s.id);
  const jumps = M.live.jumps.get(s.id);
  const fw = M.live.fw.get(s.id);
  const incursion = layerCache?.infested.get(s.id);
  const stations = s.stations.map((id) => app.officialName(id) || '空间站 ' + id);
  const status = [];
  if (incursion) status.push(`<div class="map-status incursion">入侵 · ${app.esc(zh(INCURSION_STATE_ZH, incursion.state))} · 影响力 ${(incursion.influence * 100).toFixed(0)}%</div>`);
  const adm = M.live.adm.get(s.id);
  if (adm) status.push(`<div class="map-status adm">军事指数 ${(adm.vulnerability_occupancy_level || 0).toFixed(1)} · 脆弱窗口 ${new Date(adm.vulnerable_start_time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}–${new Date(adm.vulnerable_end_time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}</div>`);
  const campaign = M.live.campaigns.find((c) => c.solar_system_id === s.id);
  if (campaign) status.push(`<div class="map-status campaign">主权争夺 · ${app.esc(zh(CAMPAIGN_TYPE_ZH, campaign.event_type))} · 防守 ${((campaign.defender_score || 0) * 100).toFixed(0)}% / 进攻 ${((campaign.attackers_score || 0) * 100).toFixed(0)}%</div>`);
  if (M.myLocation != null) status.push(myStatusHtml(s));
  if (fw) status.push(`<div class="map-status fw">势力战争 · 占领方 ${app.esc(M.factions[fw.occupier_faction_id]?.name || '')} · ${app.esc(zh(FW_STATE_ZH, fw.contested))}${fw.victory_points_threshold ? ` · 进度 ${(fw.victory_points / fw.victory_points_threshold * 100).toFixed(0)}%` : ''}</div>`);

  $('mapInfo').innerHTML = `
    <div class="map-info-head">
      <img class="map-info-star" src="https://images.evetech.net/types/${s.star}/icon?size=64" alt="" width="44" height="44">
      <div class="map-info-title">
        <h3>${app.esc(s.name)} <span class="sec-badge" style="color:${secColor(s.sec)};border-color:${secColor(s.sec)}">${secDisplay(s.sec).toFixed(1)}</span></h3>
        <p><button class="link-btn" data-info-region="${s.region}">${app.esc(regionName(s.region))}</button> › ${app.esc(constellationName(s.constellation))}</p>
      </div>
      <button class="map-info-close" data-info-close aria-label="关闭">×</button>
    </div>
    <div class="map-owner">${owner ? `<img src="${ownerLogo(owner, 64)}" alt="" width="32" height="32">` : '<i></i>'}
      <div><span>${owner?.kind === 'alliance' ? '主权联盟' : owner ? '所属阵营' : '主权'}</span><strong>${app.esc(ownerName(owner))}</strong></div></div>
    ${status.join('')}
    <div class="map-stats">
      ${statCell('舰船击毁', kills ? kills.ship_kills : 0)}
      ${statCell('太空舱击毁', kills ? kills.pod_kills : 0)}
      ${statCell('NPC 击杀', app.formatNumber(npcKills(s.id)) + `<small>${npcSpan()}</small>`)}
      ${statCell('跳跃', app.formatNumber(jumps || 0))}
    </div>
    <p class="map-info-note" title="ESI 每小时更新一次快照，游戏内是实时滚动统计，数字会有出入">舰船、太空舱、跳跃为过去 1 小时${M.live.killsAt ? `（ESI 快照，截至 ${hhmm(M.live.killsAt)}）` : ''} · 恒星与 ${s.planets} 颗行星 · ${stations.length} 座 NPC 空间站</p>
    ${industryHtml(s)}
    ${stations.length ? `<details class="map-stations"${stations.length <= 4 ? ' open' : ''}><summary>NPC 空间站（${stations.length}）</summary><ul>${stations.map((n) => `<li>${app.esc(n)}</li>`).join('')}</ul></details>` : ''}
    <div id="mapAgents"></div>
    <div class="map-neighbors"><span>相邻星系</span><div>${s.nbr.map((n) => {
      const t = M.systems[n];
      return `<button class="nbr-chip" data-sys="${n}"><i style="background:${secColor(t.sec)}"></i>${app.esc(t.name)}${t.region !== s.region ? `<small>${app.esc(regionName(t.region))}</small>` : ''}</button>`;
    }).join('')}</div></div>
    <div class="map-info-actions">
      <button class="btn" data-route-from="${s.i}">设为起点</button>
      <button class="btn" data-route-to="${s.i}">设为终点</button>
      <button class="btn" data-route-via="${s.i}">加为途经点</button>
      <button class="btn btn-ghost" data-copy="${app.esc(s.name)}">复制名称</button>
      <button class="btn btn-ghost" data-game-dest="${s.id}" data-game-name="${app.esc(s.name)}" title="在游戏里设为自动导航目的地（角色需在线）">游戏内设目的地</button>
    </div>
    ${extLinks('system', s.id)}
    ${SERVER.kb ? `<div class="map-kills">
      <div class="map-kills-head"><span>最近击杀</span><a href="https://zkillboard.com/system/${s.id}/" target="_blank" rel="noopener">zKillboard ↗</a></div>
      <div class="map-kill-list" id="mapKillList"><p class="legend-empty">载入中…</p></div>
    </div>` : ''}`;
  $('mapInfo').hidden = false;
  renderAgents(s);
  if (SERVER.kb) loadPanelKills(`systemID/${s.id}/`, (kills) => kills.slice(0, 8), () => M.selected === s.i);
}

// 星系面板：本星系的代理人与 NPC 人物，按空间站分组；从搜索点进来的人物展开并高亮
function renderAgents(s) {
  const box = $('mapAgents');
  if (!box) return;
  if (!NPC.list) {
    loadNpcData().then(() => { if (M.selected === s.i) renderAgents(s); }).catch(() => {});
    return;
  }
  const list = NPC.bySystem.get(s.id) || [];
  if (!list.length) { box.innerHTML = ''; return; }
  const focus = agentFocus?.system === s.id ? agentFocus.id : null;
  const groups = new Map();
  for (const n of [...list].sort((a, b) => (b.level - a.level) || a.name.localeCompare(b.name, 'zh'))) {
    if (!groups.has(n.station)) groups.set(n.station, []);
    groups.get(n.station).push(n);
  }
  const agents = list.filter((n) => n.type).length;
  // 绑定了角色：读声望后标出能否接任务（读完重绘一次）
  if (app.hasEsiToken() && !agentAccess && !agentAccessLoading) loadAgentAccess().then(() => { if (M.selected === s.i) renderAgents(s); });
  const accessNote = agentAccess?.error ? `<p class="legend-empty">代理人可用性：${app.esc(agentAccess.error)}</p>`
    : agentAccess ? '<p class="legend-empty">按当前角色的有效声望（含社交技能）判断普通 / 研究代理人能否接任务</p>' : '';
  box.innerHTML = `<details class="map-stations map-agents"${focus || list.length <= 6 ? ' open' : ''}>
    <summary>代理人与 NPC 人物（${agents ? agents + ' 名代理人' : list.length + ' 人'}）</summary>
    ${accessNote}
    ${[...groups].map(([station, people]) => `<div class="agent-group">${app.esc(station ? app.officialName(station) || '空间站 ' + station : '太空据点（需在星系内的据点找到）')}</div>
      <ul>${people.map((n) => `<li class="agent-row${n.id === focus ? ' focus' : ''}" data-agent="${n.id}">
        <img src="${eveImage('characters/' + n.id + '/portrait', 64)}" alt="" width="32" height="32" loading="lazy">
        <div><button class="link-btn" data-copy="${app.esc(n.name)}" title="复制名字（游戏里可搜索）">${app.esc(n.name)}</button>${n.en ? `<small>${app.esc(n.en)}</small>` : ''}
          <span>${app.esc(npcRole(n))}</span><span>${app.esc(app.officialName(n.corp) || '')}</span>${availabilityHtml(n)}</div>
        <button class="agent-dest" data-game-dest="${n.station || n.system}" data-game-name="${app.esc(n.name)}" title="在游戏里把${n.station ? '驻扎空间站' : '所在星系'}设为目的地">设目的地</button></li>`).join('')}</ul>`).join('')}
  </details>`;
  if (focus) box.querySelector('.agent-row.focus')?.scrollIntoView({ block: 'nearest' });
}

// 详情面板中的击杀列表（zKillboard），面板已切换时丢弃结果
async function loadPanelKills(path, pick, stillValid) {
  const box = () => $('mapKillList');
  try {
    const kb = await app.loadKillboard();
    const kills = pick(await kb.fetchZkill(path));
    if (!stillValid() || !box()) return;
    await kb.prepareKills(kills);
    if (!stillValid() || !box()) return;
    box().innerHTML = kb.killCompactHtml(kills);
    kb.bindKillClicks(box(), kills);
  } catch (error) {
    if (stillValid() && box()) box().innerHTML = '<p class="legend-empty">击杀记录读取失败：' + app.esc(error.message) + '</p>';
  }
}

// 外部网站：dotlan 用英文名（ESI /universe/names/ 返回英文，缓存），zKillboard 用 ID；面板渲染后再补上 dotlan 链接
const enNameCache = new Map();
async function englishName(id) {
  if (!enNameCache.has(id)) {
    enNameCache.set(id, fetch(esiUrl('/universe/names/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([id]) })
      .then((r) => (r.ok ? r.json() : [])).then((d) => d[0]?.name || null).catch(() => { enNameCache.delete(id); return null; }));
  }
  return enNameCache.get(id);
}
function extLinks(kind, id) {
  if (SERVER.id !== 'tq') return '';   // 国服的星系在 dotlan / zKillboard 上没有数据（曙光服星图也不同）
  englishName(id).then((name) => {
    const a = $('mapInfo').querySelector(`[data-dotlan="${kind}:${id}"]`);
    if (!a || !name) return;
    a.href = kind === 'region' ? 'https://evemaps.dotlan.net/map/' + encodeURIComponent(name.replace(/ /g, '_'))
      : 'https://evemaps.dotlan.net/system/' + encodeURIComponent(name.replace(/ /g, '_'));
    a.hidden = false;
  });
  return `<div class="map-ext"><span>外部网站</span>
    <a data-dotlan="${kind}:${id}" href="https://evemaps.dotlan.net/" target="_blank" rel="noopener" hidden>dotlan ↗</a>
    <a href="https://zkillboard.com/${kind}/${id}/" target="_blank" rel="noopener">zKillboard ↗</a></div>`;
}

function selectRegion(id) {
  const r = M.regions.get(id);
  if (!r) return;
  M.selected = null;
  fitTo(r.systems, 1.1);
  const counts = { 高安: 0, 低安: 0, '00': 0 };
  const owners = new Map();
  for (const i of r.systems) {
    const s = M.systems[i];
    counts[secClass(s.sec)] += 1;
    const o = ownerOf(s);
    const key = o ? o.kind + ':' + o.id : 'none';
    if (!owners.has(key)) owners.set(key, { owner: o, n: 0 });
    owners.get(key).n += 1;
  }
  const total = r.systems.length;
  const bar = (n, cls) => n ? `<i class="${cls}" style="width:${(n / total * 100).toFixed(1)}%"></i>` : '';
  const topOwners = [...owners.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  $('mapInfo').innerHTML = `
    <div class="map-info-head">
      <div class="map-info-title"><h3>${app.esc(r.name)}</h3><p>星域 · ${total} 个星系 · ${new Set(r.systems.map((i) => M.systems[i].constellation)).size} 个星座</p></div>
      <button class="map-info-close" data-info-close aria-label="关闭">×</button>
    </div>
    <div class="sec-bar">${bar(counts['高安'], 'sec-hi-bg')}${bar(counts['低安'], 'sec-lo-bg')}${bar(counts['00'], 'sec-null-bg')}</div>
    <p class="map-info-note"><span class="sec-hi">高安 ${counts['高安']}</span> · <span class="sec-lo">低安 ${counts['低安']}</span> · <span class="sec-null">00 ${counts['00']}</span></p>
    <div class="map-neighbors"><span>主要势力</span><div class="region-owners">${topOwners.map(({ owner, n }) =>
      `<div class="region-owner">${owner ? `<img src="${ownerLogo(owner)}" alt="" width="22" height="22">` : '<i></i>'}<span>${app.esc(ownerName(owner))}</span><b>${n}</b></div>`).join('')}</div></div>
    <div class="map-info-actions"><button class="btn" data-hl-region="${r.id}">高亮该星域</button></div>
    ${extLinks('region', r.id)}
    ${SERVER.kb ? `<div class="map-kills">
      <div class="map-kills-head"><span>最近大额击杀</span><a href="https://zkillboard.com/region/${r.id}/" target="_blank" rel="noopener">zKillboard ↗</a></div>
      <div class="map-kill-list" id="mapKillList"><p class="legend-empty">载入中…</p></div>
    </div>` : ''}
    ${r.description ? `<p class="region-desc">${app.esc(r.description)}</p>` : ''}`;
  $('mapInfo').hidden = false;
  M.infoRegion = id;
  if (SERVER.kb) loadPanelKills(`regionID/${id}/`, (kills) => [...kills].sort((a, b) => b.zkb.totalValue - a.zkb.totalValue).slice(0, 6),
    () => M.selected == null && M.infoRegion === id && !$('mapInfo').hidden);
  invalidate();
}

function bindInfo() {
  $('mapInfo').addEventListener('click', (e) => {
    if (e.target.closest('[data-info-close]')) { closeInfo(); return; }
    const sys = e.target.closest('[data-sys]');
    if (sys) { selectSystem(Number(sys.dataset.sys), true); return; }
    const reg = e.target.closest('[data-info-region]');
    if (reg) { selectRegion(Number(reg.dataset.infoRegion)); return; }
    const from = e.target.closest('[data-route-from]');
    if (from) { setRouteEnd('from', Number(from.dataset.routeFrom)); return; }
    const to = e.target.closest('[data-route-to]');
    if (to) { setRouteEnd('to', Number(to.dataset.routeTo)); return; }
    const via = e.target.closest('[data-route-via]');
    if (via) { setRouteEnd('via', Number(via.dataset.routeVia)); return; }
    const dest = e.target.closest('[data-game-dest]');
    if (dest) { app.game.waypoint(Number(dest.dataset.gameDest), { name: dest.dataset.gameName }); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) { app.copyText(copy.dataset.copy, '已复制'); return; }
    const hlRegion = e.target.closest('[data-hl-region]');
    if (hlRegion) {
      const r = M.regions.get(Number(hlRegion.dataset.hlRegion));
      const key = 'region:' + r.id;
      if (M.highlightKey !== key) toggleHighlight(key);
    }
  });
}

// ---------- 入口 ----------
export function initStarMap(context) {
  app = context;
  window.addEventListener('eve-intel-marks', (e) => { M.intel = e.detail; applyColors(); });
  // 个人中心切换角色：代理人可用性重新按新角色判断
  window.addEventListener('eve-account-change', () => { agentAccess = null; if (M.selected != null && $('mapAgents')) renderAgents(M.systems[M.selected]); });
  canvas = $('mapCanvas');
  labels = $('mapLabels');
  lg = labels.getContext('2d');
  // 每次打开网站进入星图都从安全等级着色开始（本次访问内切换页面仍保留当前着色）
  M.layer = 'security';
  app.store.remove('eve-map-layer');   // 清掉旧版记住的着色
  renderLayerList();
  bindPanels();
  bindSidebar();
  bindInfo();
  bindLiveKills();
  app.battles?.()?.then((m) => { if (!m) return; M.battleTier = m.battleTier; m.onBattles((list) => { M.battles = list; invalidate(); }); });
  $('mapRefresh').addEventListener('click', async () => {
    const btn = $('mapRefresh');
    btn.disabled = true;
    btn.classList.add('spinning');
    await loadLive(true);
    computeLayer();
    renderLegend();
    if (M.selected != null) renderSystemInfo(M.systems[M.selected]);
    btn.disabled = false;
    btn.classList.remove('spinning');
  });
  document.addEventListener('keydown', (e) => {
    if ($('mapView').hidden || app.isTypingTarget(e.target) || !camera) return;
    if (e.key === '+' || e.key === '=') dolly(0.7);
    else if (e.key === '-') dolly(1 / 0.7);
    else if (e.key === '0') fitAll();
    else if (e.key === 't' || e.key === 'T') { if (M.view !== '2d') topView(); }
    else if (e.key === 'v' || e.key === 'V') setView(M.view === '2d' ? '3d' : '2d');
    else if (e.key === 'Escape' && !$('mapInfo').hidden) closeInfo();
  });
}

export async function showStarMap() {
  syncMyLocationButton();
  syncJumpOptions();   // 绑定 / 解绑 ESI 后更新「含玩家建筑」选项
  if (J.settings.skillSrc === 'esi' && (!J.esiSkills || !app.hasEsiToken())) applySkillSource();   // 绑定后重新读取角色技能
  if (!M.ready) {
    M.ready = (async () => {
      $('mapLoading').hidden = false;
      await loadStaticOnce();
      buildScene();
      bindCanvas();
      resize();
      // 初始画面：直接定位到全图，不播放飞行动画
      fitAll();
      M.tween.dur = 1;
      M.running = true;
      loop();
      await loadLive();
      computeLayer();
      renderLegend();
      $('mapLoading').hidden = true;
      focusFromHash();
      startLiveKills();
      LOC.off = false;
      startLocPoll();
      syncBridgeUi();
      if ($('routeBridgeOn').checked && app.hasEsiToken()) fetchBridges().then(syncBridgeUi);
    })().catch((error) => {
      console.error(error);
      $('mapLoading').innerHTML = '星图加载失败：' + app.esc(error.message) + (/WebGL/i.test(error.message) ? '（浏览器不支持 WebGL）' : '');
      M.ready = null;
    });
    await M.ready;
    return;
  }
  await M.ready;
  // 绑定 / 换角色后更新跳桥（有缓存时不请求）
  syncBridgeUi();
  if ($('routeBridgeOn').checked && app.hasEsiToken()) fetchBridges().then(syncBridgeUi);
  if (!M.running && renderer) { M.running = true; resize(); loop(); }
  startLiveKills();
  LOC.off = false;
  startLocPoll();
  // 从其他页面跳转过来（如会战提醒「在星图查看」）：定位到地址栏里的星系
  const target = /^#map=(\d+)/.exec(location.hash);
  if (target && M.byId.get(Number(target[1]))?.i !== M.selected) focusFromHash();
  if (M.selected != null) history.replaceState(null, '', '#map=' + M.systems[M.selected].id);
  if (Date.now() - M.live.loadedAt > LIVE_TTL && M.systems.length) {
    await loadLive();
    computeLayer();
    renderLegend();
  }
}

// 定位到当前角色所在星系（需要绑定 ESI）
async function locateMe() {
  const btn = $('mapMyLocation');
  btn.disabled = true;
  try {
    const systemId = await app.getMyLocation();
    const s = M.byId.get(systemId);
    if (!s) { app.showToast('角色当前位于星图未收录的空间（如虫洞）', 'info'); return; }
    setMyLocation(s.i);
    // 和手动点击星系一样：只选中并显示信息，视角不动
    selectSystem(s.i);
    startLocPoll();
  } catch (error) {
    app.showToast('无法读取角色位置：' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 实时位置：星图在前台时每秒读一次角色位置（ESI 约 5 秒更新一次，期间浏览器直接用 HTTP 缓存，不会真的每秒请求）----------
const LOC_SCOPE = 'esi-location.read_location.v1';
const LOC_POLL = 1000;
const LOC = { timer: 0, busy: false, off: false, fails: 0 };
function startLocPoll() {
  if (LOC.timer || LOC.off || !app.hasEsiToken() || !app.hasScope?.(LOC_SCOPE)) return;
  LOC.fails = 0;
  LOC.timer = setInterval(pollMyLoc, LOC_POLL);
  pollMyLoc();
}
function stopLocPoll() {
  clearInterval(LOC.timer);
  LOC.timer = 0;
}
async function pollMyLoc() {
  if (document.hidden || !M.running || LOC.busy) return;
  if (!app.hasEsiToken()) { stopLocPoll(); setMyLocation(null); return; }
  LOC.busy = true;
  try {
    const id = await app.getMyLocation();
    LOC.fails = 0;
    setMyLocation(M.byId.get(id)?.i ?? null);   // 虫洞等星图未收录的空间不显示
  } catch (error) {
    if (error.status === 401 || error.status === 403) { LOC.off = true; stopLocPoll(); }   // 授权失效或没有位置权限
    else if (++LOC.fails >= 10) stopLocPoll();   // 连续失败先停，下次进入星图再试
  } finally {
    LOC.busy = false;
  }
}
// 位置变化：移动标记，并更新信息面板里「距我的位置」那一行
function setMyLocation(i) {
  if (i === M.myLocation) return;
  M.myLocation = i;
  const line = $('mapInfo').querySelector('.map-status.mine');
  if (M.selected != null && !$('mapInfo').hidden) {
    if (line && i != null) line.outerHTML = myStatusHtml(M.systems[M.selected]);
    else if (line) line.remove();
  }
  invalidate();
}

function syncMyLocationButton() {
  const hidden = !app.hasEsiToken();
  $('mapMyLocation').hidden = hidden;
  document.querySelectorAll('[data-route-here]').forEach((b) => { b.hidden = hidden; });
}

async function routeFromHere(btn) {
  btn.disabled = true;
  try {
    const s = M.byId.get(await app.getMyLocation());
    if (!s) { app.showToast('角色当前位于星图未收录的空间（如虫洞），无法规划星门路线', 'info'); return; }
    setMyLocation(s.i);
    setRouteEnd(btn.dataset.routeHere, s.i, '当前位置 ');
  } catch (error) {
    app.showToast('无法读取角色位置：' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// 地址栏 #map=星系ID：打开时直接定位
function focusFromHash() {
  const m = /^#map=(\d+)/.exec(location.hash);
  const s = m && M.byId.get(Number(m[1]));
  if (s) selectSystem(s.i, true);
}

// 静态星图数据（约 640 KB）与 NPC 名称只加载一次
let staticReady = null;
function loadStaticOnce() {
  if (!staticReady) staticReady = Promise.all([loadStatic(), app.loadNpcNames()]).catch((error) => { staticReady = null; throw error; });
  return staticReady;
}

// 空闲时预取：星图数据与 ESI 实时数据（主权、击杀、跳跃等），首次打开星图只需建立场景
export async function preloadStarMap() {
  await loadStaticOnce();
  await loadLive(false, true);
}

// 离开星图页时停止渲染循环，节省 GPU
export function hideStarMap() {
  M.running = false;
  stopLiveKills();
  stopLocPoll();
}
