// ===== 星图（旧版 3D 星图）=====
// 静态数据：map-data.json（build_map.mjs 由 CCP SDE 生成，星系真实三维坐标）
// 实时数据：ESI 公开接口（主权、击杀、跳跃、入侵、势力战争、路线），无需授权
// 渲染：three.js（WebGL），星系名与星域名绘制在叠加的 2D 画布上
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

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
  highlight: null,     // Set<system index>：图例高亮
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
  security: '游戏内安全等级配色', region: '每个星域一种颜色', distance: '与选中星系的星门跳数（未选择时以吉他为起点）',
  stations: '星系内 NPC 空间站数量', sov: 'ESI 实时主权：NPC 阵营 / 玩家联盟', adm: '主权枢纽的军事指数（ADM），1–6，越高越难攻破',
  campaigns: '正在进行的主权争夺战', fw: '势力战争占领方与战况',
  kills: '舰船 + 太空舱被击毁数', npc: 'NPC 被击杀数（刷怪活跃度）', jumps: '星门跳跃次数', incursions: '萨沙入侵影响的星系'
};
const CAMPAIGN_TYPE_ZH = { tcu_defense: '领土控制器防御', ihub_defense: '主权枢纽防御', station_defense: '空间站防御', station_freeport: '空间站自由港' };
const JITA_ID = 30000142;
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
  return `https://images.evetech.net/${path}?size=${size}`;
}

function regionName(id) { return M.regions.get(id)?.name || ''; }
function constellationName(id) { return M.constellations.get(id)?.name || ''; }

// ---------- 数据 ----------
async function loadStatic() {
  const res = await fetch('./map-data.json?v=v7r1');
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

async function loadLive(force = false) {
  if (!force && Date.now() - M.live.loadedAt < LIVE_TTL) return;
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
  if (failed) app.showToast(failed + ' 项实时数据加载失败，部分图层可能为空', 'error');

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
  app.store.set('eve-map-layer', layer);
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

  // 悬停 / 选中的星系单独画在最上层，高亮的光点不会被相邻星系遮住
  const focusGeo = new THREE.BufferGeometry();
  focusGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  focusGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3));
  focusGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(2).fill(2.4), 1));
  focusGeo.setAttribute('boost', new THREE.BufferAttribute(new Float32Array(2), 1));
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

// 根据图层颜色与图例高亮更新星系颜色
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

function centerOn(i, maxDistance = 45) {
  const s = M.systems[i];
  const dist = Math.min(camera.position.distanceTo(controls.target), maxDistance);
  flyTo(new THREE.Vector3(s.x, s.y, s.z), dist);
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
  if (moved || M.dirty || M.tween) render();
}

const proj = new THREE.Vector3();
function project(x, y, z) {
  proj.set(x, y, z).project(camera);
  return [(proj.x + 1) / 2 * M.size.w, (1 - proj.y) / 2 * M.size.h, proj.z];
}

// 把悬停 / 选中的星系写入高亮层（选中优先；同一个星系只画一次）
function updateFocus() {
  const geo = focusPoints.geometry;
  const pos = geo.attributes.position, col = geo.attributes.color, boost = geo.attributes.boost;
  const items = [];
  if (M.selected != null) items.push([M.selected, 2]);
  if (M.hover != null && M.hover !== M.selected) items.push([M.hover, 1]);
  items.forEach(([i, b], n) => {
    const s = M.systems[i];
    pos.setXYZ(n, s.x, s.y, s.z);
    // 被图例淡化的星系高亮时恢复图层原色
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
  const always = new Set([M.selected, M.hover, ...M.route].filter((i) => i != null));
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
  for (const i of M.route) systemLabel(i, false);

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

  const picks = [];
  if (dist < 140) {
    const cam = camera.position;
    for (const s of M.systems) {
      if (!onScreen(s.i, 20)) continue;
      const d = (s.x - cam.x) ** 2 + (s.y - cam.y) ** 2 + (s.z - cam.z) ** 2;
      picks.push([d, s.i]);
    }
    picks.sort((a, b) => a[0] - b[0]);
  }
  const limit = dist < 40 ? 300 : dist < 80 ? 180 : 80;
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

// ---------- 侧栏：图层 / 图例 / 搜索 / 路线 ----------
function renderLayerList() {
  $('layerList').innerHTML = LAYER_GROUPS.map(([title, list]) =>
    `<div class="layer-group-title">${title}</div><div class="layer-group">` +
    list.map(([key, label]) => `<button class="layer-btn${M.layer === key ? ' active' : ''}" data-layer="${key}" title="${LAYER_HINT[key]}">${label}</button>`).join('') +
    '</div>').join('') +
    `<p class="layer-hint">${LAYER_HINT[M.layer]}</p>`;
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

const legendSets = new Map();   // 图例高亮 key -> Set<system index>

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
        logo: `https://images.evetech.net/alliances/${c.defender_id}/logo?size=32`,
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
}

function zh(map, key) { return map[key] || key; }

function toggleHighlight(key) {
  if (M.highlightKey === key) {
    M.highlight = null;
    M.highlightKey = null;
  } else {
    // 星域高亮也可以从星域详情面板触发，此时图例里不一定有对应的集合
    const regionMatch = /^region:(\d+)$/.exec(key);
    M.highlight = legendSets.get(key) || (regionMatch ? new Set(M.regions.get(Number(regionMatch[1]))?.systems || []) : null);
    M.highlightKey = key;
    if (M.highlight?.size) fitTo([...M.highlight], 1.2);
  }
  renderLegend();
  applyColors();
}

// 搜索：星系与星域
function searchMap(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const r of M.regions.values()) if (r.name.toLowerCase().includes(q)) results.push({ type: 'region', id: r.id, name: r.name, score: r.name.toLowerCase().startsWith(q) ? 0 : 2 });
  for (const s of M.systems) {
    if (!s.lower.includes(q)) continue;
    results.push({ type: 'system', i: s.i, name: s.name, score: s.lower === q ? -1 : s.lower.startsWith(q) ? 1 : 3 });
  }
  return results.sort((a, b) => a.score - b.score || a.name.length - b.name.length).slice(0, limit);
}

function resultRow(r) {
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
    results.innerHTML = list.length ? list.map(resultRow).join('') : '<p class="legend-empty">没有找到匹配的星系或星域</p>';
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
    const sys = e.target.closest('[data-sys]');
    if (sys) { selectSystem(Number(sys.dataset.sys), true); results.hidden = true; return; }
    const reg = e.target.closest('[data-region]');
    if (reg) { selectRegion(Number(reg.dataset.region)); results.hidden = true; }
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
  $('routeSwap').addEventListener('click', () => {
    const a = $('routeFrom'), b = $('routeTo');
    [a.value, b.value] = [b.value, a.value];
    [a.dataset.id, b.dataset.id] = [b.dataset.id, a.dataset.id];
  });
  $('routeClear').addEventListener('click', () => {
    M.route = [];
    $('routeResult').innerHTML = '';
    updateRouteLine();
  });
  $('routeResult').addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-route]')) {
      app.copyText(M.route.map((i) => M.systems[i].name).join(' → '), '路线已复制');
      return;
    }
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
  if ($('routeFrom').dataset.id && $('routeTo').dataset.id) planRoute();
}

function resolveRouteField(field) {
  if (field.dataset.id) return Number(field.dataset.id);
  const exact = M.systems.find((s) => s.lower === field.value.trim().toLowerCase());
  return exact?.id || null;
}

async function planRoute() {
  const from = resolveRouteField($('routeFrom'));
  const to = resolveRouteField($('routeTo'));
  const box = $('routeResult');
  if (!from || !to) { box.innerHTML = '<p class="legend-empty">请从候选列表中选择起点和终点星系</p>'; return; }
  box.innerHTML = '<p class="legend-empty">正在规划路线…</p>';
  try {
    const ids = await app.fetchESI(`/route/${from}/${to}/?flag=${$('routeFlag').value}`);
    M.route = ids.map((id) => M.byId.get(id)?.i).filter((i) => i != null);
    const counts = { 高安: 0, 低安: 0, '00': 0 };
    M.route.forEach((i) => { counts[secClass(M.systems[i].sec)] += 1; });
    box.innerHTML =
      `<div class="route-summary"><span><strong>${M.route.length - 1}</strong> 跳 · <span class="sec-hi">高安 ${counts['高安']}</span> · <span class="sec-lo">低安 ${counts['低安']}</span> · <span class="sec-null">00 ${counts['00']}</span></span>` +
        '<button class="link-btn" data-copy-route title="复制整条路线">复制路线</button></div>' +
      '<ol class="route-list">' + M.route.map((i) => {
        const s = M.systems[i];
        return `<li><button data-sys="${i}"><i style="background:${secColor(s.sec)}"></i>${app.esc(s.name)}<span>${secDisplay(s.sec).toFixed(1)}</span></button></li>`;
      }).join('') + '</ol>';
    updateRouteLine();
    fitTo(M.route, 1.2);
  } catch (error) {
    M.route = [];
    box.innerHTML = '<p class="legend-empty">路线规划失败：' + app.esc(error.message) + '（可能无法通过星门到达）</p>';
    updateRouteLine();
  }
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
    <div class="map-neighbors"><span>相邻星系</span><div>${s.nbr.map((n) => {
      const t = M.systems[n];
      return `<button class="nbr-chip" data-sys="${n}"><i style="background:${secColor(t.sec)}"></i>${app.esc(t.name)}${t.region !== s.region ? `<small>${app.esc(regionName(t.region))}</small>` : ''}</button>`;
    }).join('')}</div></div>
    <div class="map-info-actions">
      <button class="btn" data-route-from="${s.i}">设为起点</button>
      <button class="btn" data-route-to="${s.i}">设为终点</button>
      <button class="btn btn-ghost" data-copy="${app.esc(s.name)}">复制名称</button>
      <a class="btn btn-ghost" href="https://zkillboard.com/system/${s.id}/" target="_blank" rel="noopener" title="在 zKillboard 查看该星系的击杀记录">zKillboard ↗</a>
    </div>`;
  $('mapInfo').hidden = false;
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
    ${r.description ? `<p class="region-desc">${app.esc(r.description)}</p>` : ''}`;
  $('mapInfo').hidden = false;
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
  canvas = $('mapCanvas');
  labels = $('mapLabels');
  lg = labels.getContext('2d');
  M.layer = LAYERS.some(([k]) => k === app.store.get('eve-map-layer')) ? app.store.get('eve-map-layer') : 'security';
  renderLayerList();
  bindSidebar();
  bindInfo();
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
  if (!M.ready) {
    M.ready = (async () => {
      $('mapLoading').hidden = false;
      await Promise.all([loadStatic(), app.loadNpcNames()]);
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

// 离开星图页时停止渲染循环，节省 GPU
export function hideStarMap() {
  M.running = false;
}
