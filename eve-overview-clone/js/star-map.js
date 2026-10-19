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
import { SERVER, HUB, HUB_NAME, NO_KB_MESSAGE, serverKey, esiUrl, eveImage } from './server.js?v=s3';

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
  dirty: true,
  running: false,
  tween: null,
  screen: null,        // Float32Array [x, y, depth] 每个星系的屏幕坐标（每帧更新，用于命中测试与标签）
  size: { w: 0, h: 0, dpr: 1 }
};

const LIVE_TTL = 10 * 60e3;    // 实时数据缓存 10 分钟
const MAP_BG = '#05080d';

// 图层分组：基础 / 势力 / 活动（活动类为过去 1 小时数据）
const LAYER_GROUPS = [
  ['基础', [['security', '安全等级'], ['region', '星域'], ['distance', '跳数距离'], ['stations', 'NPC 空间站']]],
  ['势力', [['sov', '势力划分'], ['adm', '军事指数'], ['campaigns', '主权争夺'], ['fw', '势力战争']]],
  ['活动 · 1 小时', [['kills', '玩家击杀'], ['npc', 'NPC 击杀'], ['jumps', '跳跃'], ['incursions', '入侵']]]
];
const LAYERS = LAYER_GROUPS.flatMap(([, list]) => list);
const LAYER_HINT = {
  security: '游戏内安全等级配色', region: '每个星域一种颜色', distance: `与选中星系的星门跳数（未选择时以${HUB_NAME}为起点）`,
  stations: '星系内 NPC 空间站数量', sov: 'ESI 实时主权：NPC 阵营 / 玩家联盟', adm: '主权枢纽的军事指数（ADM），1–6，越高越难攻破',
  campaigns: '正在进行的主权争夺战', fw: '势力战争占领方与战况',
  kills: '舰船 + 太空舱被击毁数', npc: 'NPC 被击杀数（刷怪活跃度）', jumps: '星门跳跃次数', incursions: '萨沙入侵影响的星系'
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
  M.systems = data.systems.map(([id, name, x, y, z, sec, region, constellation, faction, star, planets, stations], i) =>
    ({ i, id, name, x, y, z, sec, region, constellation, faction, star, planets, stations, nbr: [], lower: name.toLowerCase() }));
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
    app.fetchESI('/universe/system_kills/'),
    app.fetchESI('/universe/system_jumps/'),
    app.fetchESI('/incursions/'),
    app.fetchESI('/fw/systems/'),
    app.fetchESI('/sovereignty/structures/'),
    app.fetchESI('/sovereignty/campaigns/')
  ]);
  const [sov, kills, jumps, incursions, fw, structures, campaigns] = results;
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
  const failed = results.filter((r) => r.status === 'rejected').length;
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
const LAYER_METRIC = {
  kills: (s) => { const k = M.live.kills.get(s.id); return k ? k.ship_kills + k.pod_kills : 0; },
  npc: (s) => M.live.kills.get(s.id)?.npc_kills || 0,
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
      case 'npc': c = heat(metric(s), max, 32); break;
      case 'jumps': c = heat(metric(s), max, 190); break;
      case 'stations': c = heat(metric(s), max, 48); break;
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
    (sa.region === sb.region ? inner : cross).push(sa.x, sa.y, sa.z, sb.x, sb.y, sb.z);
  }
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const lineGeo = (arr) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return geo; };
  gateLinesInner = new THREE.LineSegments(lineGeo(inner), lineMat(0x6e82a0, 0.32));
  gateLinesCross = new THREE.LineSegments(lineGeo(cross), lineMat(0x9678d2, 0.42));
  scene.add(gateLinesInner, gateLinesCross);

  // 星系
  const n = M.systems.length;
  const pos = new Float32Array(n * 3);
  M.systems.forEach((s) => pos.set([s.x, s.y, s.z], s.i * 3));
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
function applyColors() {
  if (!starPoints || !layerCache) return;
  const colors = starPoints.geometry.attributes.color;
  const sizes = starPoints.geometry.attributes.size;
  const hl = M.highlight;
  for (const s of M.systems) {
    const dim = hl && !hl.has(s.i);
    tmpColor.setStyle(dim ? DIM_COLOR : layerCache.colors[s.i]);
    colors.setXYZ(s.i, tmpColor.r, tmpColor.g, tmpColor.b);
    sizes.setX(s.i, dim ? 1.6 : hl ? 3.2 : 2.4);
  }
  colors.needsUpdate = true;
  sizes.needsUpdate = true;
  invalidate();
}

function updateRouteLine() {
  if (!routeLine) return;   // 场景尚未建立（初始化时恢复上次的规划方式）
  if (M.route.length < 2) { routeLine.visible = false; invalidate(); return; }
  const pts = [];
  for (const i of M.route) { const s = M.systems[i]; pts.push(s.x, s.y, s.z); }
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
  for (const i of indices) { const s = M.systems[i]; box.expandByPoint(v.set(s.x, s.y, s.z)); }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 6);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
  flyTo(sphere.center, (radius / Math.sin(fit / 2)) * padding, direction);
}

// 默认视角：从南方上空斜看整个新伊甸，接近旧版游戏星图
const OVERVIEW_DIR = new THREE.Vector3(0, 1.35, 1);
function fitAll(direction = OVERVIEW_DIR) {
  fitTo(M.systems.map((s) => s.i), 0.7, direction);
}

function topView() {
  fitTo(M.systems.map((s) => s.i), 0.78, new THREE.Vector3(0, 1, 0.0001));
}

function dolly(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const len = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  flyTo(controls.target.clone(), len);
}

const NARROW = window.matchMedia('(max-width: 768px)');
function centerOn(i, maxDistance = 45) {
  const s = M.systems[i];
  const dist = Math.min(camera.position.distanceTo(controls.target), maxDistance);
  const target = new THREE.Vector3(s.x, s.y, s.z);
  if (NARROW.matches) {
    // 手机端信息面板是底部卡片（约占下半屏）：把焦点沿屏幕向下移，让星系显示在上方 1/4 处
    const dir = camera.position.clone().sub(controls.target).normalize();
    const up = camera.up.clone().sub(dir.clone().multiplyScalar(camera.up.dot(dir))).normalize();
    const visible = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    target.sub(up.multiplyScalar(visible * 0.25));
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
  const moved = controls.update();
  if (moved || M.dirty || M.tween || M.flashes.length || M.battles.length) render();
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
    pos.setXYZ(n, s.x, s.y, s.z);
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
    const [sx, sy, sz] = project(s.x, s.y, s.z);
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
      const [sx, sy, sz] = project(r.cx, r.cy, r.cz);
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
  $('mapMyLocation').addEventListener('click', locateMe);
  new ResizeObserver(() => { if (!$('mapView').hidden) resize(); }).observe($('mapStage'));
}

function showTooltip(i, x, y) {
  const tip = $('mapTooltip');
  if (i == null) { tip.hidden = true; return; }
  const s = M.systems[i];
  const owner = ownerOf(s);
  let extra = '';
  if (M.layer === 'kills' || M.layer === 'npc') { const k = M.live.kills.get(s.id); extra = `玩家击杀 ${k ? k.ship_kills + k.pod_kills : 0} · NPC ${k ? app.formatNumber(k.npc_kills) : 0}`; }
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
    `<p class="layer-hint">${LAYER_HINT[M.layer]}</p>`;
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
    const hue = { kills: 8, npc: 32, jumps: 190, stations: 48 }[M.layer];
    // 分段色块（对数刻度）
    const steps = [0, 1, 5, 20, 100, layerCache.max].filter((v, n, arr) => n === 0 || (v <= layerCache.max && v > arr[n - 1]));
    rows.push('<div class="legend-steps">' + steps.map((v) => `<span><i style="background:${heat(v, layerCache.max, hue)}"></i>${v}</span>`).join('') + '</div>');
    const total = M.systems.reduce((t, s) => t + value(s), 0);
    const title = { kills: '玩家击杀（舰船 + 太空舱）', npc: 'NPC 击杀', jumps: '星门跳跃', stations: 'NPC 空间站' }[M.layer];
    rows.push(`<div class="legend-group">${title} · 合计 ${app.formatNumber(total)}</div>`);
    const top = [...M.systems].sort((a, b) => value(b) - value(a)).slice(0, 12).filter((s) => value(s) > 0);
    for (const s of top) rows.push(legendRow({ color: layerCache.colors[s.i], label: s.name, sub: regionName(s.region), count: app.formatNumber(value(s)), systemIndex: s.i }));
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
  for (const which of ['From', 'To']) {
    const field = $('route' + which);
    const list = $('route' + which + 'List');
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
  $('routeFlag').innerHTML = ROUTE_FLAGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('routePlan').addEventListener('click', planRoute);
  bindJumpPlanner();
  $('routeSwap').addEventListener('click', () => {
    const a = $('routeFrom'), b = $('routeTo');
    [a.value, b.value] = [b.value, a.value];
    [a.dataset.id, b.dataset.id] = [b.dataset.id, a.dataset.id];
  });
  $('routeClear').addEventListener('click', () => {
    $('routeSummary').textContent = '';
    M.route = [];
    $('routeResult').innerHTML = '';
    clearJumpRange();
    updateRouteLine();
  });
  $('routeResult').addEventListener('click', (e) => {
    if (e.target.closest('[data-game-route]')) {
      // 星门路线：游戏自动导航会自己寻路，只设终点；跳跃路线：落点依次写成航点
      const ids = J.mode === 'jump' && J.plan ? J.plan.path.slice(1).map((i) => M.systems[i].id).concat(J.plan.gates.map((i) => M.systems[i].id))
        : M.route.length ? [M.systems[M.route[M.route.length - 1]].id] : [];
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

function setRouteEnd(which, i) {
  const s = M.systems[i];
  const field = $(which === 'from' ? 'routeFrom' : 'routeTo');
  field.value = s.name;
  field.dataset.id = s.id;
  app.showToast((which === 'from' ? '起点' : '终点') + '：' + s.name, 'success', 1500);
  setPanel('route', true);
  if ($('routeFrom').dataset.id && $('routeTo').dataset.id) planRoute();
}

function resolveRouteField(field) {
  if (field.dataset.id) return Number(field.dataset.id);
  const exact = M.systems.find((s) => s.lower === field.value.trim().toLowerCase());
  return exact?.id || null;
}

async function planRoute() {
  if (J.mode === 'jump') { planJump(); return; }
  const from = resolveRouteField($('routeFrom'));
  const to = resolveRouteField($('routeTo'));
  const box = $('routeResult');
  if (!from || !to) { box.innerHTML = '<p class="legend-empty">请从候选列表中选择起点和终点星系</p>'; return; }
  box.innerHTML = '<p class="legend-empty">正在规划路线…</p>';
  try {
    const ids = await app.fetchESI(`/route/${from}/${to}/?flag=${$('routeFlag').value}`);
    M.route = ids.map((id) => M.byId.get(id)?.i).filter((i) => i != null);
    routeLine.material.color.setHex(ROUTE_COLORS.gate);
    const counts = { 高安: 0, 低安: 0, '00': 0 };
    M.route.forEach((i) => { counts[secClass(M.systems[i].sec)] += 1; });
    box.innerHTML =
      `<div class="route-summary"><span><strong>${M.route.length - 1}</strong> 跳 · <span class="sec-hi">高安 ${counts['高安']}</span> · <span class="sec-lo">低安 ${counts['低安']}</span> · <span class="sec-null">00 ${counts['00']}</span></span>` +
        '<span><button class="link-btn" data-game-route title="在游戏里把终点设为目的地（角色需在线）">写入自动导航</button> · <button class="link-btn" data-copy-route title="复制整条路线">复制路线</button></span></div>' +
      '<ol class="route-list">' + M.route.map((i) => {
        const s = M.systems[i];
        return `<li><button data-sys="${i}"><i style="background:${secColor(s.sec)}"></i>${app.esc(s.name)}<span>${secDisplay(s.sec).toFixed(1)}</span></button></li>`;
      }).join('') + '</ol>';
    updateRouteLine();
    fitTo(M.route, 1.2);
    $('routeSummary').textContent = `${M.route.length - 1} 跳`;
  } catch (error) {
    M.route = [];
    $('routeSummary').textContent = '';
    box.innerHTML = '<p class="legend-empty">路线规划失败：' + app.esc(error.message) + '（可能无法通过星门到达）</p>';
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && M.running) pollLive(); });
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
  const to = resolveRouteField($('routeTo'));
  if (!from || !to) { box.innerHTML = '<p class="legend-empty">请从候选列表中选择起点和终点星系</p>'; return; }
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
  const a = M.byId.get(from).i, b = M.byId.get(to).i;
  let dockRule;
  try {
    dockRule = await dockStops(ship);
  } catch (error) {
    box.innerHTML = '<p class="legend-empty">' + app.esc(error.message) + '</p>';
    return;
  }
  const plan = JP.planJumpRoute(M.systems, a, b, { range, ...dockRule });
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
  $('routeSummary').textContent = `${sim.rows.length} 次跳跃`;
  const prices = await app.getMarketPriceMap().catch(() => new Map());
  const unit = prices.get(ship.fuelType);
  if (unit && J.plan?.sim === sim && $('jumpFuelIsk')) $('jumpFuelIsk').textContent = '≈ ' + app.formatISK(unit * sim.fuel) + ' ISK';
}

function renderJumpPlan() {
  const { sim, gates, ship, path, landing, range, prefer, fatigue } = J.plan;
  const fatigueNote = fatigue?.minutes > 0 ? `<p class="jump-note warn">已计入角色当前的跳跃疲劳：剩余 ${JP.formatMinutes(fatigue.minutes)}（${new Date(fatigue.expires).toLocaleString('zh-CN', { hour12: false })} 消退）</p>`
    : fatigue ? '<p class="jump-note">角色当前没有跳跃疲劳</p>'
      : app.hasEsiToken() ? '<p class="jump-note">按零疲劳估算。<button class="link-btn" data-scope-rebind="fatigue">授权「跳跃疲劳」</button>后可按角色实际疲劳计算</p>' : '';
  // 「优先可停靠」模式下，中途无法停靠的星系单独标出
  const noDock = prefer ? path.slice(1, -1).filter((i) => !prefer.has(i)) : [];
  const sys = (i) => M.systems[i];
  const fuelName = ISOTOPE_ZH[ship.fuelType] || '燃料';
  const row = (i, extra, cls = '') => {
    const s = sys(i);
    const { npc, structures } = dockingAt(i, ship);
    const tags = (npc ? `<em class="jump-station" title="${npc} 个 NPC 空间站">站</em>` : '') +
      (noDock.includes(i) ? '<em class="jump-station is-nodock" title="没有可停靠的空间站或建筑，只能停在太空">不可停靠</em>' : '');
    // 可停靠的玩家建筑直接列出游戏内名称（最多 3 座，其余放在提示里）
    const dockName = (st) => `<span class="jump-dock" title="${app.esc(JP.STRUCTURES[st.type][0] + ' · ' + st.name)}"><b>${app.esc(JP.STRUCTURES[st.type][0])}</b>${app.esc(st.name)}</span>`;
    const docks = structures.length ? `<div class="jump-docks">${structures.slice(0, 3).map(dockName).join('')}${structures.length > 3
      ? `<span class="jump-dock-more" title="${app.esc(structures.slice(3, 20).map((st) => `${JP.STRUCTURES[st.type][0]} · ${st.name}`).join('\n'))}">另有 ${structures.length - 3} 座可停靠建筑</span>` : ''}</div>` : '';
    return `<li class="${cls}"><button data-sys="${i}"><i style="background:${secColor(s.sec)}"></i>${app.esc(s.name)}<span>${secDisplay(s.sec).toFixed(1)}</span>${tags}</button>${docks}${extra || ''}</li>`;
  };
  const legs = sim.rows.map((r) => row(r.to,
    `<div class="jump-leg"><span>${r.ly.toFixed(2)} 光年</span><span>${app.formatNumber(r.fuel)} 燃料</span><span title="跳后重新激活冷却">冷却 ${JP.formatMinutes(r.cooldown)}</span><span title="跳后疲劳">疲劳 ${JP.formatMinutes(r.fatigue)}</span></div>`)).join('');
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

function statCell(label, value) {
  return `<div class="map-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderSystemInfo(s) {
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
  if (M.myLocation != null && M.myLocation !== s.i) {
    const h = hopsBetween(M.myLocation, s.i);
    status.push(`<div class="map-status mine">距我的位置（${app.esc(M.systems[M.myLocation].name)}）${h < 0 ? '无法通过星门到达' : h + ' 跳'}</div>`);
  } else if (M.myLocation === s.i) {
    status.push('<div class="map-status mine">我的角色当前在此星系</div>');
  }
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
      ${statCell('玩家击杀', kills ? kills.ship_kills : 0)}
      ${statCell('太空舱击杀', kills ? kills.pod_kills : 0)}
      ${statCell('NPC 击杀', kills ? app.formatNumber(kills.npc_kills) : 0)}
      ${statCell('跳跃', app.formatNumber(jumps || 0))}
    </div>
    <p class="map-info-note">过去 1 小时 · 恒星与 ${s.planets} 颗行星 · ${stations.length} 座 NPC 空间站</p>
    ${stations.length ? `<details class="map-stations"${stations.length <= 4 ? ' open' : ''}><summary>NPC 空间站（${stations.length}）</summary><ul>${stations.map((n) => `<li>${app.esc(n)}</li>`).join('')}</ul></details>` : ''}
    <div id="mapAgents"></div>
    <div class="map-neighbors"><span>相邻星系</span><div>${s.nbr.map((n) => {
      const t = M.systems[n];
      return `<button class="nbr-chip" data-sys="${n}"><i style="background:${secColor(t.sec)}"></i>${app.esc(t.name)}${t.region !== s.region ? `<small>${app.esc(regionName(t.region))}</small>` : ''}</button>`;
    }).join('')}</div></div>
    <div class="map-info-actions">
      <button class="btn" data-route-from="${s.i}">设为起点</button>
      <button class="btn" data-route-to="${s.i}">设为终点</button>
      <button class="btn btn-ghost" data-copy="${app.esc(s.name)}">复制名称</button>
      <button class="btn btn-ghost" data-game-dest="${s.id}" data-game-name="${app.esc(s.name)}" title="在游戏里设为自动导航目的地（角色需在线）">游戏内设目的地</button>
    </div>
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
    else if (e.key === 't' || e.key === 'T') topView();
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
    })().catch((error) => {
      console.error(error);
      $('mapLoading').innerHTML = '星图加载失败：' + app.esc(error.message) + (/WebGL/i.test(error.message) ? '（浏览器不支持 WebGL）' : '');
      M.ready = null;
    });
    await M.ready;
    return;
  }
  await M.ready;
  if (!M.running && renderer) { M.running = true; resize(); loop(); }
  startLiveKills();
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
    M.myLocation = s.i;
    selectSystem(s.i, true);
  } catch (error) {
    app.showToast('无法读取角色位置：' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function syncMyLocationButton() {
  $('mapMyLocation').hidden = !app.hasEsiToken();
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
}
