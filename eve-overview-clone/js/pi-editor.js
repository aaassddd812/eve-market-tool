// ===== 殖民地模板预览与编辑（仿游戏行星界面）=====
// 在可旋转、缩放的行星球面上显示模板：设施按 La/Lo 摆放，链接沿大圆弧绘制，采集控制器周围显示采集头，
// 选中设施时动画显示经过它的原料 / 产物路由。
// 编辑：拖动设施、添加 / 删除 / 复制设施、连接 / 断开链接、链接升级、配方与采集头数、行星类型与指挥中心等级。
// 检查与游戏导入一致的规则：设施间距 ≥ 0.012 弧度、路由最多 7 个设施、链接流量不超过容量、CPU / 电网不超出。
// 路由按链接自动生成：采集控制器 → 最近的发射平台 / 储藏设施，工厂原料从仓储送来、产物送回仓储。
// 画面：行星球面（按行星类型着色、带经纬网），新放的设施扫一道高光、删掉的淡出，电网 / CPU 超出时最后改动的设施泛红光；
//   设施、物料颜色与游戏一致（P0 青、P1 橙、P2 黄、P3 金、P4 绿）。
// 侧栏「产量」「存储与维护」：按 pi-sim.js 推演，拖时间轴看各仓储存量、满仓 / 断料时间、该取走和开局要装的东西。
// 桌面版「存到游戏」：直接写进游戏的模板文件夹（pi_tpl_save 命令），游戏里行星的模板列表就能选到。
import { angle, arc, basis, project, unproject, toVec } from './pi-globe.js?v=v19r12';
import { simulate } from './pi-sim.js?v=v1';

let env;   // pi, ptByCode, schemByOut, cName, tierOf, esc, formatNumber, showToast, CC_LEVELS, HEAD, headRate, ICON, PLANET_COLORS
const $ = (id) => document.getElementById(id);

export const SPACING = 0.0125;        // 生成模板时设施间距（弧度），略大于游戏下限
const MIN_SEP = 0.012;                // 游戏要求的最小间距（弧度），更近的设施导入时会被拒绝
const SEP_TOL = 1e-4;
const MAX_ROUTE = 7;                  // 路由最多经过 7 个设施
const LINK_CAP = 1250;                // 0 级链接容量 m³/h，每升一级翻倍
// 颜色跟图标外圈、游戏里的物料等级色一致
const TIER_COLORS = ['#00e7ea', '#e96e00', '#ffb102', '#f3c700', '#9fe500'];
const KINDS = {
  launchpad: { label: '发射平台', color: '#1f8fff' },
  storage: { label: '储藏设施', color: '#1f8fff' },
  ecu: { label: '采集控制器', color: '#00e7ea' },
  basic: { label: '基础工业设施', color: '#e96e00' },
  adv: { label: '高级工业设施', color: '#ffb102' },
  ht: { label: '高科技工厂', color: '#9fe500' }
};
const tierColor = (id) => TIER_COLORS[env.tierOf(id)] || '#9fb2c4';
const pinColor = (p) => (p.kind === 'adv' && p.product && env.tierOf(p.product) === 3 ? TIER_COLORS[3] : KINDS[p.kind].color);
const HUBS = new Set(['launchpad', 'storage']);
// 地图与建造栏上的设施图标（游戏行星界面风格）
const PIN_ICON = { launchpad: 'launchpad', storage: 'storage', ecu: 'ecu', basic: 'bfc', adv: 'afc-p2', ht: 'hfc' };
const pinIconUrl = (kind, product) => `assets/pi/${kind === 'adv' && product && env.tierOf(product) === 3 ? 'afc-p3' : PIN_ICON[kind]}.svg`;

export function initPiEditor(context) { env = context; }

// ---------- 模板文本 ----------
// 游戏导出的 Diam 是小数（如 5820.0），这里保持一致
export function templateText(json, pretty = false) {
  const text = JSON.stringify(json, null, pretty ? 2 : 0);
  const d = Number(json.Diam);
  return Number.isInteger(d) ? text.replace(/("Diam":\s*)(-?\d+)(?=[,}\s])/, '$1$2.0') : text;
}

// ---------- 模型 ----------
let kindIndex = null;
function kindOf(type) {
  if (!kindIndex) {
    kindIndex = new Map();
    for (const [code, pt] of Object.entries(env.ptByCode)) for (const k of [...Object.keys(KINDS), 'cc']) if (pt[k]) kindIndex.set(pt[k], [code, k]);
  }
  return kindIndex.get(type) || [null, null];
}
const codeOfPlanet = (typeId) => Object.keys(env.ptByCode).find((c) => env.ptByCode[c].id === typeId) || 'B';

function fromJson(json) {
  const keep = new Map();
  const pins = [];
  (json.P || []).forEach((p, i) => {
    const kind = kindOf(p.T)[1];
    if (!kind || kind === 'cc') return;
    keep.set(i + 1, pins.length);
    pins.push({ kind, th: Number(p.La), ph: Number(p.Lo), heads: p.H || 0, product: p.S || null });
  });
  return {
    name: json.Cmt || '模板', code: codeOfPlanet(json.Pln),
    R: (Number(json.Diam) || 10000) / 2,
    cc: Math.min(5, Math.max(0, Number(json.CmdCtrLv ?? 5))),
    pins,
    links: (json.L || []).filter((l) => keep.has(l.S) && keep.has(l.D)).map((l) => ({ a: keep.get(l.S), b: keep.get(l.D), lv: Math.min(5, l.Lv || 0) }))
  };
}

function toJson(m) {
  const pt = env.ptByCode[m.code];
  return {
    CmdCtrLv: m.cc, Cmt: m.name.slice(0, 40), Diam: Math.round(m.R * 2),
    L: m.links.map((l) => ({ D: l.b + 1, Lv: l.lv, S: l.a + 1 })),
    P: m.pins.map((p) => ({ H: p.kind === 'ecu' ? p.heads : 0, La: Number(p.th.toFixed(5)), Lo: Number(p.ph.toFixed(5)), S: HUBS.has(p.kind) ? null : p.product, T: pt[p.kind] })),
    Pln: pt.id,
    R: autoRoutes(m).routes.map((r) => ({ P: r.path.map((i) => i + 1), Q: r.qty, T: r.type }))
  };
}

const struct = (id) => env.pi.structures[id] || [0, 0];
const pinAngle = (p, q) => angle(p, q);
function linkKm(m, l) { return pinAngle(m.pins[l.a], m.pins[l.b]) * m.R; }
// 与游戏一致：CPU = 15 + 0.2·km·(级+1)^1.4，电网 = 10 + 0.15·km·(级+1)^1.2，向上取整
function linkCost(m, l) {
  const km = linkKm(m, l);
  return [Math.ceil(15 + 0.2 * km * (l.lv + 1) ** 1.4 - 1e-9), Math.ceil(10 + 0.15 * km * (l.lv + 1) ** 1.2 - 1e-9), km];
}

function usage(m) {
  const pt = env.ptByCode[m.code];
  let cpu = 0, power = 0;
  for (const p of m.pins) {
    const [c, w] = struct(pt[p.kind]);
    cpu += c + (p.kind === 'ecu' ? p.heads * env.HEAD[0] : 0);
    power += w + (p.kind === 'ecu' ? p.heads * env.HEAD[1] : 0);
  }
  for (const l of m.links) { const [c, w] = linkCost(m, l); cpu += c; power += w; }
  const [capC, capP] = env.CC_LEVELS[m.cc];
  return { cpu, power, capC, capP };
}

function shortest(m, from, isTarget) {
  const adj = m.pins.map(() => []);
  for (const l of m.links) { adj[l.a].push(l.b); adj[l.b].push(l.a); }
  const prev = new Map([[from, -1]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur !== from && isTarget(cur)) {
      const path = [];
      for (let n = cur; n !== -1; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const n of adj[cur]) if (!prev.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  return null;
}

function crowded(m) {
  const bad = new Set();
  for (let i = 0; i < m.pins.length; i++) for (let j = i + 1; j < m.pins.length; j++) {
    if (pinAngle(m.pins[i], m.pins[j]) < MIN_SEP - SEP_TOL) { bad.add(i); bad.add(j); }
  }
  return bad;
}

function autoRoutes(m) {
  const routes = [];
  const problems = [];
  const hub = (i) => HUBS.has(m.pins[i].kind);
  const nearestHub = (i) => shortest(m, i, (j) => m.pins[j].kind === 'launchpad') || shortest(m, i, hub);
  const vol = (t) => env.pi.commodities[t]?.[3] || 0;
  m.pins.forEach((p, i) => {
    if (HUBS.has(p.kind)) return;
    const label = `${KINDS[p.kind].label} #${i + 1}`;
    if (!p.product) { problems.push({ pin: i, text: `${label} 未设置${p.kind === 'ecu' ? '采集资源' : '配方'}` }); return; }
    const path = nearestHub(i);
    if (!path) { problems.push({ pin: i, text: `${label} 没有链接到发射平台或储藏设施` }); return; }
    if (path.length > MAX_ROUTE) problems.push({ pin: i, text: `${label} 的路由经过 ${path.length} 个设施，超过 ${MAX_ROUTE} 个上限` });
    if (p.kind === 'ecu') {
      const perHour = Math.max(1, Math.round(p.heads * env.headRate()));
      routes.push({ path, qty: perHour, type: p.product, from: i, m3h: perHour * vol(p.product) });
      return;
    }
    const s = env.schemByOut.get(p.product);
    const k = 3600 / s.cycle;
    const back = path.slice().reverse();
    for (const [t, q] of s.inputs) routes.push({ path: back, qty: q, type: t, to: i, m3h: q * k * vol(t) });
    routes.push({ path, qty: s.outQty, type: p.product, from: i, m3h: s.outQty * k * vol(p.product) });
  });
  // 链接流量
  const flow = m.links.map(() => 0);
  const linkIdx = new Map(m.links.map((l, i) => [Math.min(l.a, l.b) + ':' + Math.max(l.a, l.b), i]));
  for (const r of routes) for (let s = 1; s < r.path.length; s++) {
    const key = Math.min(r.path[s - 1], r.path[s]) + ':' + Math.max(r.path[s - 1], r.path[s]);
    if (linkIdx.has(key)) flow[linkIdx.get(key)] += r.m3h;
  }
  m.links.forEach((l, i) => {
    const cap = LINK_CAP * 2 ** l.lv;
    if (flow[i] > cap) {
      const need = Math.ceil(Math.log2(flow[i] / LINK_CAP));
      problems.push({ link: i, text: `链接 #${l.a + 1}–#${l.b + 1} 流量 ${Math.round(flow[i])} m³/h，超过容量 ${cap}，需要升到 ${need} 级` });
    }
  });
  if (!m.pins.some((p) => HUBS.has(p.kind))) problems.unshift({ pin: null, text: '需要至少一个发射平台或储藏设施' });
  const bad = crowded(m);
  if (bad.size) problems.unshift({ pin: [...bad][0], text: `${bad.size} 个设施间距过近（小于 0.012 弧度），游戏会拒绝导入` });
  const u = usage(m);
  if (u.cpu > u.capC) problems.unshift({ pin: null, text: `CPU 超出 ${env.formatNumber(Math.ceil(u.cpu - u.capC))} tf` });
  if (u.power > u.capP) problems.unshift({ pin: null, text: `电网超出 ${env.formatNumber(Math.ceil(u.power - u.capP))} MW` });
  const pt = env.ptByCode[m.code];
  m.pins.forEach((p, i) => {
    if (p.kind === 'ht' && !pt.ht) problems.push({ pin: i, text: `${pt.name}行星不能建高科技工厂` });
    if (p.kind === 'ecu' && p.product && !pt.res.includes(p.product)) problems.push({ pin: i, text: `${pt.name}行星没有${env.cName(p.product)}` });
  });
  return { routes, problems, flow, crowded: bad };
}

function productOptions(m, kind) {
  if (kind === 'ecu') return env.ptByCode[m.code].res;
  const tiers = { basic: [1], adv: [2, 3], ht: [4] }[kind] || [];
  return Object.keys(env.pi.commodities).map(Number).filter((id) => tiers.includes(env.tierOf(id)) && env.schemByOut.has(id))
    .sort((a, b) => env.tierOf(a) - env.tierOf(b) || env.cName(a).localeCompare(env.cName(b), 'zh'));
}

// ---------- 相机 ----------
function centroid(pins) {
  if (!pins.length) return { th: Math.PI / 2, ph: Math.PI };
  let x = 0, y = 0, z = 0;
  for (const p of pins) { const v = toVec(p.th, p.ph); x += v[0]; y += v[1]; z += v[2]; }
  const n = Math.hypot(x, y, z) || 1;
  let ph = Math.atan2(y / n, x / n);
  if (ph < 0) ph += Math.PI * 2;
  return { th: Math.acos(z / n), ph };
}
// 视野最多约 0.7 弧度宽：拉远也只看殖民地附近
const minRpx = (w, h) => Math.min(w, h) / 0.7;
// 设施间距最多放大到 FIT_GAP 像素：设施与游戏里一样紧挨着，不会因为殖民地小而被放得很开
const FIT_GAP = 110;
function fitCam(m, w, h, fill = 0.36, gap = FIT_GAP) {
  const c = centroid(m.pins);
  const span = Math.max(0.016, ...m.pins.map((p) => pinAngle(p, c)));
  return { th: c.th, ph: c.ph, rpx: Math.max(minRpx(w, h), Math.min(80000, gap / SPACING, (Math.min(w, h) * fill) / span)), cx: w / 2, cy: h / 2 };
}

// ---------- 图标 ----------
const images = new Map();
function icon(url, onload) {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  if (!img.complete && onload) img.addEventListener('load', onload, { once: true });
  return img.complete && img.naturalWidth ? img : null;
}

let fontFamily = '';
const font = (px, weight = 400) => {
  if (!fontFamily) fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
  return `${weight} ${px}px ${fontFamily}`;
};

// ---------- 场景绘制 ----------
// view: { canvas, cam, model, sel, linkFrom, hover, t, thumb, info, redraw }
function drawScene(view) {
  const { canvas, cam } = view;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = view.width || canvas.clientWidth, h = view.height || canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  cam.cx = w / 2; cam.cy = h / 2;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPlanet(g, view, w, h);
  drawColony(g, view, w, h);
}

// ---------- 行星球面 ----------
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// 经纬网间距：屏幕上大约 7 – 14 条
const GRID_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30].map((d) => (d * Math.PI) / 180);
function drawPlanet(g, view, w, h) {
  const { cam } = view;
  const [r0, g0, b0] = hexRgb(env.PLANET_COLORS?.[view.model.code] || '#5f8fbf');
  const rgb = (a, k = 1) => `rgba(${Math.round(r0 * k)},${Math.round(g0 * k)},${Math.round(b0 * k)},${a})`;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  const R = cam.rpx;
  // 球体：暗色底 + 左上方的受光
  g.save();
  g.beginPath(); g.arc(cam.cx, cam.cy, R, 0, Math.PI * 2); g.clip();
  g.fillStyle = rgb(1, 0.13);
  g.fillRect(0, 0, w, h);
  const lr = Math.max(w, h) * 0.9;
  const lit = g.createRadialGradient(w * 0.38, h * 0.3, 0, w * 0.38, h * 0.3, lr);
  lit.addColorStop(0, rgb(0.22)); lit.addColorStop(0.55, rgb(0.07)); lit.addColorStop(1, rgb(0));
  g.fillStyle = lit;
  g.fillRect(0, 0, w, h);
  // 经纬网
  const span = Math.min(Math.PI, Math.max(w, h) / R);
  const step = GRID_STEPS.find((s) => span / s <= 14) || GRID_STEPS[GRID_STEPS.length - 1];
  const b = basis(cam);
  const line = (pts, major) => {
    g.beginPath();
    let on = false;
    for (const q of pts) {
      const p = project(cam, b, q.th, q.ph);
      if (!p.visible) { on = false; continue; }
      if (on) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      on = true;
    }
    g.strokeStyle = rgb(major ? 0.2 : 0.09, 1.3);
    g.lineWidth = major ? 1 : 0.8;
    g.stroke();
  };
  const reach = Math.min(Math.PI / 2, span * 0.8);
  const dph = Math.min(Math.PI, reach / Math.max(0.15, Math.sin(cam.th)));
  const N = 40;
  for (let k = Math.ceil((cam.th - reach) / step); k * step <= cam.th + reach; k++) {
    const th = k * step;
    if (th <= 0 || th >= Math.PI) continue;
    line(Array.from({ length: N + 1 }, (_, j) => ({ th, ph: cam.ph - dph + (2 * dph * j) / N })), k % 5 === 0);
  }
  for (let k = Math.ceil((cam.ph - dph) / step); k * step <= cam.ph + dph; k++) {
    const ph = k * step;
    line(Array.from({ length: N + 1 }, (_, j) => ({ th: Math.max(0.001, Math.min(Math.PI - 0.001, cam.th - reach + (2 * reach * j) / N)), ph })), k % 5 === 0);
  }
  g.restore();
  // 边缘（大气）光晕：拉远看到球体边缘时
  if (R < Math.hypot(w, h)) {
    const halo = g.createRadialGradient(cam.cx, cam.cy, R * 0.96, cam.cx, cam.cy, R * 1.08);
    halo.addColorStop(0, rgb(0)); halo.addColorStop(0.35, rgb(0.35, 1.2)); halo.addColorStop(1, rgb(0));
    g.fillStyle = halo;
    g.beginPath(); g.arc(cam.cx, cam.cy, R * 1.08, 0, Math.PI * 2); g.fill();
  }
}

// 设施图标按真实比例随缩放变化：图标直径约为最小间距的九成，相邻设施和游戏里一样几乎挨着
const HEAD_RING = 1.5;   // 采集头环半径（相对设施图标半径）
const pinRadius = (cam) => Math.max(5, cam.rpx * SPACING * 0.38);

const linkPx = (pts) => Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
function polyline(g, pts) {
  g.beginPath();
  pts.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
}

function drawColony(g, view, w, h) {
  const { cam, model: m } = view;
  const b = basis(cam);
  const P = (p) => project(cam, b, p.th, p.ph);
  const thumb = view.thumb;
  const info = view.info || autoRoutes(m);
  const redraw = view.redraw;
  const t = view.t || 0;
  const r = pinRadius(cam);
  const spacingPx = cam.rpx * SPACING;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // 链接
  m.links.forEach((l, i) => {
    const pts = arc(m.pins[l.a], m.pins[l.b], 10).map(P);
    if (!pts.some((p) => p.visible)) return;
    const over = info.flow && info.flow[i] > LINK_CAP * 2 ** l.lv;
    const sel = view.sel?.link === i;
    const base = sel ? '255,195,90' : over ? '255,95,95' : '90,200,255';
    polyline(g, pts); g.strokeStyle = `rgba(${base},0.16)`; g.lineWidth = thumb ? 4 : 9 + l.lv * 2; g.stroke();
    polyline(g, pts); g.strokeStyle = `rgba(${base},0.35)`; g.lineWidth = thumb ? 2 : 4 + l.lv; g.stroke();
    polyline(g, pts); g.strokeStyle = sel ? '#ffd27a' : over ? '#ff8080' : '#bfeaff'; g.lineWidth = thumb ? 0.9 : 1.4 + l.lv * 0.5; g.stroke();
    // 流动的光点（两个方向各一个）
    if (!thumb) {
      const a = pts[0], c = pts[pts.length - 1];
      for (const [dir, off] of [[1, 0], [-1, 0.5]]) {
        let f = ((t / 1600 + off + i * 0.137) % 1 + 1) % 1;
        if (dir < 0) f = 1 - f;
        const x = a.x + (c.x - a.x) * f, y = a.y + (c.y - a.y) * f;
        const pr = Math.max(1.6, r * 0.13);
        const gl = g.createRadialGradient(x, y, 0, x, y, pr * 3);
        gl.addColorStop(0, 'rgba(220,245,255,0.95)'); gl.addColorStop(1, 'rgba(90,200,255,0)');
        g.fillStyle = gl;
        g.beginPath(); g.arc(x, y, pr * 3, 0, Math.PI * 2); g.fill();
      }
    }
    if (!thumb && (sel || linkPx(pts) > r * 2.3 + 60)) {   // 链接露出的部分够长才标距离
      const mid = pts[Math.floor(pts.length / 2)];
      const dx = pts[pts.length - 1].x - pts[0].x, dy = pts[pts.length - 1].y - pts[0].y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (-dy / len) * 10, oy = (dx / len) * 10;   // 文字放在链接一侧
      g.font = font(10);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const txt = `${linkKm(m, l).toFixed(0)} km${l.lv ? ' · ' + l.lv + '级' : ''}`;
      g.lineWidth = 3; g.strokeStyle = '#000';
      g.strokeText(txt, mid.x + ox, mid.y + oy);
      g.fillStyle = sel ? '#ffd27a' : 'rgba(190,225,245,0.85)';
      g.fillText(txt, mid.x + ox, mid.y + oy);
    }
  });

  // 选中设施的路由：绿色原料进、橙色产物出
  if (!thumb && view.sel?.pin != null) {
    const i = view.sel.pin;
    g.setLineDash([8, 10]);
    g.lineDashOffset = -t * 0.045;
    const seen = new Set();
    for (const rt of info.routes) {
      if (rt.from !== i && rt.to !== i) continue;
      const inbound = rt.to === i;
      const key = rt.path.join('-') + inbound;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [];
      for (let k = 1; k < rt.path.length; k++) pts.push(...arc(m.pins[rt.path[k - 1]], m.pins[rt.path[k]], 8).map(P));
      polyline(g, pts);
      g.strokeStyle = tierColor(rt.type);
      g.globalAlpha = inbound ? 0.75 : 0.95;
      g.lineWidth = inbound ? 5 : 2.5;
      g.stroke();
      g.globalAlpha = 1;
    }
    g.setLineDash([]);
  }

  // 设施
  const pt = env.ptByCode[m.code];
  m.pins.forEach((p, i) => {
    const s = P(p);
    if (!s.visible || s.x < -60 || s.y < -60 || s.x > w + 60 || s.y > h + 60) return;
    const k = KINDS[p.kind];
    const color = pinColor(p);
    const selected = view.sel?.pin === i || view.linkFrom === i;
    const hovered = view.hover === i;
    const bad = info.crowded?.has(i);
    // 新放的设施：弹出 + 图标上扫过一道高光
    const age = !thumb && view.fx?.has(p) ? t - view.fx.get(p) : Infinity;
    if (age > SHINE_END) view.fx?.delete(p);
    const pop = age < POP_MS ? easeOutBack(Math.max(0, age) / POP_MS) : 1;
    g.globalAlpha = age < 160 ? Math.max(0, age) / 160 : 1;
    // 底部光晕
    const glow = g.createRadialGradient(s.x, s.y, r * 0.7, s.x, s.y, r * (selected || hovered ? 2.6 : 2.1));
    glow.addColorStop(0, color + (selected || hovered ? '77' : '44')); glow.addColorStop(1, color + '00');
    g.fillStyle = glow;
    g.beginPath(); g.arc(s.x, s.y, r * 2.6, 0, Math.PI * 2); g.fill();
    // 采集头（采集球）：仿游戏内的半透明青白光盘，环绕在采集控制器外圈
    const headRing = p.kind === 'ecu' && p.heads && spacingPx >= 170;   // 设施紧挨着时采集头圈会压到旁边，拉近后再画
    if (headRing) {
      const ring = r * HEAD_RING;
      const hr = Math.max(2.5, r * 0.3);
      g.strokeStyle = 'rgba(150,225,215,0.22)'; g.lineWidth = thumb ? 0.8 : 1;
      g.beginPath(); g.arc(s.x, s.y, ring, 0, Math.PI * 2); g.stroke();
      const himg = icon('assets/pi/head.svg', redraw);
      for (let hd = 0; hd < p.heads; hd++) {
        const a = -Math.PI / 2 + (hd / p.heads) * Math.PI * 2;
        const x = s.x + Math.cos(a) * ring, y = s.y + Math.sin(a) * ring;
        if (himg) g.drawImage(himg, x - hr, y - hr, hr * 2, hr * 2);
        else {
          g.fillStyle = 'rgba(190,240,230,0.4)';
          g.beginPath(); g.arc(x, y, hr, 0, Math.PI * 2); g.fill();
        }
      }
    }
    // 设施图标（自带外圈）
    const img = icon(pinIconUrl(p.kind, p.product), redraw);
    const size = r * 2.3 * pop;
    if (img) g.drawImage(img, s.x - size / 2, s.y - size / 2, size, size);
    else {
      g.fillStyle = '#0a1018'; g.strokeStyle = color; g.lineWidth = 2;
      g.beginPath(); g.arc(s.x, s.y, r * pop, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    if (age >= SHINE_START && age < SHINE_END) shine(g, s, size / 2, (age - SHINE_START) / (SHINE_END - SHINE_START));
    g.globalAlpha = 1;
    // 电网 / CPU 超出：最后改动的那个设施泛红光、外圈红环一明一暗
    if (!thumb && view.over && view.blame === p) {
      const pulse = 0.55 + 0.45 * Math.sin(t / 260);
      const veil = g.createRadialGradient(s.x, s.y, r * 0.35, s.x, s.y, r * 1.25);
      veil.addColorStop(0, 'rgba(255,70,70,0)'); veil.addColorStop(1, `rgba(255,70,70,${0.5 * pulse})`);
      g.fillStyle = veil;
      g.beginPath(); g.arc(s.x, s.y, r * 1.25, 0, Math.PI * 2); g.fill();
      g.save();
      g.shadowColor = '#ff4a4a'; g.shadowBlur = 12 * pulse;
      g.strokeStyle = `rgba(255,95,95,${0.5 + 0.5 * pulse})`; g.lineWidth = 2;
      g.beginPath(); g.arc(s.x, s.y, r * 1.45, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
    if (p.kind === 'ecu' && p.heads && !headRing) {
      const bx = s.x + r * 0.78, by = s.y + r * 0.78;
      g.font = font(Math.max(9, Math.min(13, r * 0.45)), 600);
      const txt = '×' + p.heads, tw = g.measureText(txt).width + 8, th = Math.max(13, Math.min(18, r * 0.6));
      g.fillStyle = 'rgba(5,8,14,0.9)'; g.strokeStyle = 'rgba(150,225,215,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.roundRect(bx - tw / 2, by - th / 2, tw, th, th / 2); g.fill(); g.stroke();
      g.fillStyle = '#bff3ea'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, bx, by + 0.5);
    }
    if (bad) {
      g.strokeStyle = '#ff5a5a'; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(s.x, s.y, r * (headRing ? HEAD_RING + 0.6 : 1.5), 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    if (thumb) return;
    // 产物角标
    if (p.product && !HUBS.has(p.kind)) {
      const off = headRing ? r * (HEAD_RING + 1.15) : r * 0.9 * Math.SQRT2;   // 采集控制器的角标放在采集头外圈之外
      const bx = s.x + off * Math.SQRT1_2, by = s.y - off * Math.SQRT1_2, br = Math.max(6.5, r * 0.46);
      g.fillStyle = '#05080e'; g.strokeStyle = tierColor(p.product); g.lineWidth = 1.2;
      g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill(); g.stroke();
      const pimg = icon(env.ICON(p.product, 32), redraw);
      if (pimg) g.drawImage(pimg, bx - br * 0.82, by - br * 0.82, br * 1.64, br * 1.64);
    }
    // 名称：拉近后显示
    if (spacingPx > 170 || selected || hovered) {   // 紧挨着时名称会压到旁边的设施，拉近后再显示
      const label = HUBS.has(p.kind) ? k.label : p.product ? env.cName(p.product) : '未设置';
      g.font = font(11, selected ? 600 : 400);
      g.textAlign = 'center'; g.textBaseline = 'top';
      const ly = s.y + r * (headRing ? HEAD_RING + 0.65 : 1.18) + 6;
      g.lineWidth = 3; g.strokeStyle = '#000';
      g.strokeText(label, s.x, ly);
      g.fillStyle = selected ? '#ffffff' : p.product || HUBS.has(p.kind) ? 'rgba(215,232,245,0.9)' : '#ff9b9b';
      g.fillText(label, s.x, ly);
    }
    if (selected) {
      // 游戏式选中框：四角括号
      const q = r * (headRing ? HEAD_RING + 0.65 : 1.2) + 7, L = 7;
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        g.beginPath();
        g.moveTo(s.x + sx * q, s.y + sy * (q - L)); g.lineTo(s.x + sx * q, s.y + sy * q); g.lineTo(s.x + sx * (q - L), s.y + sy * q);
        g.stroke();
      }
    }
  });

  // 删掉的设施：缩小淡出
  if (!thumb && view.ghosts?.length) {
    view.ghosts = view.ghosts.filter((gh) => t - gh.at < FADE_MS);
    for (const gh of view.ghosts) {
      const s = P(gh);
      if (!s.visible) continue;
      const e = Math.max(0, t - gh.at) / FADE_MS;
      const img = icon(pinIconUrl(gh.kind, gh.product), redraw);
      if (!img) continue;
      const size = r * 2.3 * (1 - 0.45 * e);
      g.globalAlpha = 1 - e;
      g.drawImage(img, s.x - size / 2, s.y - size / 2, size, size);
      g.globalAlpha = 1;
    }
  }

  // 悬停提示
  if (!thumb && view.hover != null && m.pins[view.hover] && view.hover !== view.sel?.pin) {
    const p = m.pins[view.hover];
    const s = P(p);
    const lines = [`${pt.name}行星${KINDS[p.kind].label} #${view.hover + 1}`];
    if (p.kind === 'ecu') lines.push(`采集 ${p.product ? env.cName(p.product) : '未设置'} · ${p.heads} 个采集头`);
    else if (!HUBS.has(p.kind)) {
      const sc = p.product && env.schemByOut.get(p.product);
      lines.push(sc ? `${sc.inputs.map(([x, q]) => env.cName(x) + '×' + q).join(' + ')} → ${env.cName(p.product)}×${sc.outQty}` : '未设置配方');
    } else lines.push(`${m.links.filter((l) => l.a === view.hover || l.b === view.hover).length} 条链接`);
    g.font = font(12);
    const tw = Math.max(...lines.map((x) => g.measureText(x).width)) + 20;
    const th = lines.length * 17 + 12;
    let x = s.x - tw / 2, y = s.y - r * 2 - th - 8;
    x = Math.max(6, Math.min(w - tw - 6, x));
    if (y < 6) y = s.y + r * 2 + 8;
    g.fillStyle = 'rgba(8,13,20,0.94)';
    g.beginPath(); g.roundRect(x, y, tw, th, 8); g.fill();
    g.textAlign = 'left'; g.textBaseline = 'top';
    lines.forEach((ln, k) => { g.fillStyle = k ? '#9fb2c4' : '#e8f1f8'; g.font = font(12, k ? 400 : 600); g.fillText(ln, x + 10, y + 7 + k * 17); });
  }
}

// ---------- 动画 ----------
const POP_MS = 320, SHINE_START = 140, SHINE_END = 760, FADE_MS = 320;
const easeOutBack = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
// 圆形图标内斜向扫过的一道柔光
function shine(g, s, rad, f) {
  g.save();
  g.beginPath(); g.arc(s.x, s.y, rad * 0.98, 0, Math.PI * 2); g.clip();
  g.translate(s.x, s.y);
  g.rotate(Math.PI / 4);
  const x = (f * 2 - 1) * rad * 1.4, bw = rad * 0.55;
  const band = g.createLinearGradient(x - bw, 0, x + bw, 0);
  band.addColorStop(0, 'rgba(255,255,255,0)'); band.addColorStop(0.5, `rgba(255,255,255,${0.6 * Math.sin(Math.PI * f)})`); band.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = band;
  g.fillRect(x - bw, -rad * 1.5, bw * 2, rad * 3);
  g.restore();
}

// ---------- 缩略预览 ----------
export function drawThumb(canvas, json) {
  const m = fromJson(json);
  if (!canvas.isConnected) return;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 150;
  const view = { canvas, model: m, cam: fitCam(m, w, h, 0.4, 56), thumb: true, width: w, height: h };
  view.redraw = () => drawScene(view);
  drawScene(view);
}

// ---------- 编辑器 ----------
const E = { view: null, onSave: null, original: null, dirty: false, linkMode: false, drag: null, raf: 0 };

export function openTemplateEditor(json, { title = '殖民地模板', onSave = null } = {}) {
  const m = fromJson(json);
  E.original = templateText(json);
  E.onSave = onSave;
  E.dirty = false; E.linkMode = false;
  let modal = $('pieModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pieModal';
    modal.className = 'pie-modal';
    document.body.appendChild(modal);
    modal.addEventListener('click', onModalClick);
    modal.addEventListener('change', onModalChange);
    modal.addEventListener('input', onModalInput);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { if (!modal.hidden && E.view) requestDraw(); });
  }
  modal.hidden = false;
  modal.innerHTML = `
    <div class="pie-dialog" role="dialog" aria-modal="true" aria-label="${env.esc(title)}">
      <div class="pie-stage" id="pieStage">
        <canvas id="pieCanvas" class="pie-canvas"></canvas>
        <div class="pie-hud-top">
          <div class="pie-title"><b>${env.esc(title)}</b></div>
          <div class="pie-top-actions">
            <span class="pie-hint">拖动移动 · 滚轮缩放 · L 链接 · Del 删除</span>
            <button type="button" class="pie-x" data-pie="close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </div>
        </div>
        <div class="pie-zoom">
          <button type="button" data-pie="zoom-in" title="放大">+</button>
          <button type="button" data-pie="zoom-out" title="缩小">−</button>
          <button type="button" data-pie="fit" title="回到殖民地">◎</button>
        </div>
        <div class="pie-hud-bottom" id="pieHud"></div>
      </div>
      <aside class="pie-side"><div class="pie-side-body" id="pieSide"></div><div class="pie-actions" id="pieActions"></div></aside>
    </div>`;
  document.documentElement.classList.add('pie-open');
  const canvas = $('pieCanvas');
  E.view = { canvas, model: m, cam: null, sel: null, linkFrom: null, hover: null, fx: new Map(), ghosts: [], blame: null, over: false };
  E.view.redraw = () => requestDraw();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerleave', () => { if (E.view) E.view.hover = null; });
  E.view.cam = fitCam(m, canvas.clientWidth, canvas.clientHeight);
  renderHud();
  renderSide();
  requestDraw();
}

// 动画循环：链接上的光点与选中路由持续流动；编辑器关闭或页面隐藏时停止
function requestDraw() {
  if (!E.view || E.raf) return;
  E.raf = requestAnimationFrame((t) => {
    E.raf = 0;
    if (!E.view || $('pieModal')?.hidden) return;
    E.view.t = t;
    E.view.info = autoRoutes(E.view.model);
    const u = usage(E.view.model);
    E.view.over = u.power > u.capP || u.cpu > u.capC;
    drawScene(E.view);
    requestDraw();
  });
}

function closeEditor(force = false) {
  if (!force && E.dirty && E.onSave && !confirm('有未保存的修改，确定关闭？')) return;
  const modal = $('pieModal');
  if (modal) { modal.hidden = true; modal.innerHTML = ''; }
  document.documentElement.classList.remove('pie-open');
  E.view = null;
}

function changed() {
  E.dirty = true;
  requestDraw();
  renderSide();
  renderHud();
}

function renderHud() {
  const m = E.view.model;
  const pt = env.ptByCode[m.code];
  const u = usage(m);
  const gauge = (label, v, cap, unit, cls) => `<div class="pie-gauge ${cls}${v > cap ? ' over' : ''}"><div><span>${label}</span><b>${env.formatNumber(Math.round(v))}<small> / ${env.formatNumber(cap)} ${unit}</small></b></div><i><em style="width:${Math.min(100, (v / cap) * 100).toFixed(1)}%"></em></i></div>`;
  $('pieHud').innerHTML = `
    <div class="pie-gauges">${gauge('电网', u.power, u.capP, 'MW', 'pg')}${gauge('CPU', u.cpu, u.capC, 'tf', 'cpu')}</div>
    <div class="pie-build">
      ${Object.entries(KINDS).filter(([k]) => k !== 'ht' || pt.ht).map(([k, v]) => `<button type="button" data-pie-add="${k}" title="添加${v.label}" style="--k:${v.color}"><img src="${pinIconUrl(k)}" alt="" width="36" height="36"><span>${v.label.replace('设施', '').replace('工厂', '')}</span></button>`).join('')}
      <button type="button" data-pie="link" class="pie-link-btn${E.linkMode ? ' active' : ''}" title="依次点两个设施连接 / 断开（L）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg><span>${E.linkMode ? '连接中' : '链接'}</span></button>
    </div>`;
}

function renderSide() {
  const view = E.view;
  const m = view.model;
  const { routes, problems, flow } = autoRoutes(m);
  const pt = env.ptByCode[m.code];
  let sel = '';
  if (view.sel?.pin != null && m.pins[view.sel.pin]) {
    const i = view.sel.pin;
    const p = m.pins[i];
    const [c, w] = struct(pt[p.kind]);
    const opts = HUBS.has(p.kind) ? [] : productOptions(m, p.kind);
    const linked = m.links.filter((l) => l.a === i || l.b === i).length;
    const s = p.product && !HUBS.has(p.kind) && p.kind !== 'ecu' ? env.schemByOut.get(p.product) : null;
    sel = `<section class="pie-panel">
      <header>已选设施</header>
      <div class="pie-sel-head"><img src="${env.ICON(pt[p.kind], 64)}" alt="" width="44" height="44"><div><b>${pt.name}行星${KINDS[p.kind].label}</b><small>#${i + 1} · CPU ${env.formatNumber(c + (p.kind === 'ecu' ? p.heads * env.HEAD[0] : 0))} tf · 电网 ${env.formatNumber(w + (p.kind === 'ecu' ? p.heads * env.HEAD[1] : 0))} MW · ${linked} 条链接</small></div></div>
      ${opts.length ? `<label class="pie-row"><span>${p.kind === 'ecu' ? '采集资源' : '配方'}</span><select data-pie-prop="product" class="pie-input">
        <option value="">未设置</option>
        ${opts.map((id) => `<option value="${id}"${p.product === id ? ' selected' : ''}>${p.kind === 'ecu' ? '' : 'P' + env.tierOf(id) + ' · '}${env.esc(env.cName(id))}</option>`).join('')}
      </select></label>` : ''}
      ${p.kind === 'ecu' ? `<label class="pie-row"><span>采集头 <b class="pie-heads">${p.heads}</b></span><input type="range" min="1" max="10" value="${p.heads}" data-pie-prop="heads"></label>` : ''}
      ${s ? `<div class="pie-io">${s.inputs.map(([t, q]) => `<span><img src="${env.ICON(t, 32)}" alt="" width="18" height="18">${env.esc(env.cName(t))} ×${q}</span>`).join('')}<em>→</em><span class="out"><img src="${env.ICON(p.product, 32)}" alt="" width="18" height="18">${env.esc(env.cName(p.product))} ×${s.outQty}</span><small>每 ${s.cycle / 60} 分钟</small></div>` : ''}
      <div class="pie-sel-actions"><button type="button" class="pie-btn" data-pie="dup">复制一个</button><button type="button" class="pie-btn danger" data-pie="delete">删除</button></div>
    </section>`;
  } else if (view.sel?.link != null && m.links[view.sel.link]) {
    const li = view.sel.link;
    const l = m.links[li];
    const [c, w, km] = linkCost(m, l);
    sel = `<section class="pie-panel">
      <header>已选链接</header>
      <div class="pie-kv"><span>长度</span><b>${km.toFixed(1)} km</b><span>负载</span><b>CPU ${c} · 电网 ${w}</b><span>流量</span><b>${Math.round(flow[li] || 0)} / ${LINK_CAP * 2 ** l.lv} m³/h</b></div>
      <label class="pie-row"><span>链接等级</span><select class="pie-input" data-pie-prop="lv">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === l.lv ? ' selected' : ''}>${n} 级 · ${LINK_CAP * 2 ** n} m³/h</option>`).join('')}</select></label>
      <div class="pie-sel-actions"><button type="button" class="pie-btn danger" data-pie="delete">删除链接</button></div>
    </section>`;
  } else {
    sel = `<p class="pie-tip">${E.linkMode ? '依次点两个设施连接 / 断开' : '点设施或链接进行修改'}</p>`;
  }
  const counts = {};
  for (const p of m.pins) counts[p.kind] = (counts[p.kind] || 0) + 1;
  $('pieSide').innerHTML = `
    <section class="pie-panel">
      <header>殖民地</header>
      <label class="pie-row"><span>模板名称</span><input class="pie-input" data-pie-prop="name" value="${env.esc(m.name)}" maxlength="40"></label>
      <div class="pie-row2">
        <label class="pie-row"><span>行星类型</span><select class="pie-input" data-pie-prop="code">${Object.entries(env.ptByCode).map(([c, p]) => `<option value="${c}"${c === m.code ? ' selected' : ''}>${p.name}</option>`).join('')}</select></label>
        <label class="pie-row"><span>指挥中心</span><select class="pie-input" data-pie-prop="cc">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === m.cc ? ' selected' : ''}>${n} 级</option>`).join('')}</select></label>
      </div>
      <label class="pie-row"><span>行星直径 km</span><input type="number" class="pie-input" min="1000" max="200000" step="10" value="${Math.round(m.R * 2)}" data-pie-prop="diam"></label>
      <div class="pie-counts">${Object.entries(counts).map(([k, n]) => `<span style="--k:${KINDS[k].color}"><i></i>${KINDS[k].label} ${n}</span>`).join('')}<span>链接 ${m.links.length}</span><span>路由 ${routes.length}</span></div>
    </section>
    ${sel}
    <section class="pie-panel">
      <header>导入检查${problems.length ? ` <em>${problems.length}</em>` : ''}</header>
      ${problems.length ? `<ul class="pie-problems">${problems.map((p) => `<li${p.pin != null ? ` data-pie-goto="${p.pin}"` : p.link != null ? ` data-pie-goto-link="${p.link}"` : ''}>${env.esc(p.text)}</li>`).join('')}</ul>` : '<p class="pie-ok">✓ 可导入游戏</p>'}
    </section>
    ${simHtml(m, { routes, problems, flow })}`;
  // 保存 / 复制等按钮固定在侧栏底部，上面的内容单独滚动
  $('pieActions').innerHTML = `
      ${E.onSave ? '<button type="button" class="pie-btn primary wide" data-pie="save">保存修改</button>' : ''}
      ${canSaveToGame() ? `<button type="button" class="pie-btn ${E.onSave ? 'game' : 'primary'} wide" data-pie="game" title="直接存进游戏的模板文件夹（文档\\EVE\\PlanetaryInteractionTemplates），游戏里行星的模板列表就能选到">存到游戏模板库</button>` : ''}
      <button type="button" class="pie-btn${E.onSave || canSaveToGame() ? '' : ' primary wide'}" data-pie="copy">复制模板</button>
      <button type="button" class="pie-btn" data-pie="download">下载 .json</button>
      <button type="button" class="pie-btn" data-pie="import">导入 JSON</button>
      <button type="button" class="pie-btn" data-pie="reset">还原</button>`;
}

// ---------- 产量与存储推演（pi-sim.js）----------
const SIM_KEY = 'eve-pie-sim';
const SIM_HOURS = [[24, '1 天'], [72, '3 天'], [168, '7 天'], [336, '14 天']];
const PERIODS = [['h', '每小时', 1], ['d', '每天', 24], ['w', '每周', 168]];
const HUB_LINE = ['#5ec8ff', '#ffb102', '#9fe500', '#e96e00', '#d39bff', '#ff7aa8'];
const SIM = { hours: 72, period: 'd', at: 24 };
try { Object.assign(SIM, JSON.parse(localStorage.getItem(SIM_KEY) || '{}')); } catch { /* 忽略 */ }
if (!SIM_HOURS.some(([h]) => h === SIM.hours)) SIM.hours = 72;
function saveSim() { try { localStorage.setItem(SIM_KEY, JSON.stringify(SIM)); } catch { /* 忽略 */ } }
const fmtH = (x) => (x < 48 ? `${Math.round(x * 10) / 10} 小时` : `${Math.round((x / 24) * 10) / 10} 天`);
const qtyText = (n) => env.formatNumber(Math.round(n));
const pinName = (m, i) => `${KINDS[m.pins[i].kind].label} #${i + 1}`;
const chip = (t, n) => `<span class="pie-chip" style="--c:${tierColor(t)}" title="${env.esc(env.cName(t))}"><img src="${env.ICON(t, 32)}" alt="" width="18" height="18"><b>${qtyText(n)}</b></span>`;

function simHtml(m, info) {
  if (!info.routes.length) { E.sim = null; return ''; }
  const sim = simulate(m, info, { env, perHead: env.headRate(), hours: SIM.hours });
  const run = simulate(m, info, { env, perHead: env.headRate(), hours: SIM.hours, steady: true });
  E.sim = sim;
  SIM.at = Math.min(Math.max(0, Number(SIM.at) || 0), sim.hours);
  // 产量：推演期内的平均值，按所选周期换算
  const [, , mult] = PERIODS.find(([k]) => k === SIM.period) || PERIODS[1];
  const types = [...sim.idealMade.keys()].sort((a, b) => env.tierOf(b) - env.tierOf(a) || env.cName(a).localeCompare(env.cName(b), 'zh'));
  const rows = types.map((t) => {
    const gross = ((run.made.get(t) || 0) / run.hours) * mult;
    const net = (((run.made.get(t) || 0) - (run.used.get(t) || 0)) / run.hours) * mult;
    const ideal = ((run.idealMade.get(t) || 0) - (run.idealUsed.get(t) || 0)) * mult;
    const own = net < 0.5 && (run.idealUsed.get(t) || 0) > 0;
    return `<tr${own ? ' class="own"' : ''}><td><span class="pie-prod-name" style="--c:${tierColor(t)}"><img src="${env.ICON(t, 32)}" alt="" width="20" height="20"><span>${env.esc(env.cName(t))}</span><i>P${env.tierOf(t)}</i></span></td>
      <td class="num">${qtyText(gross)}</td>
      <td class="num">${own ? '<small>自用</small>' : `<b>${qtyText(net)}</b>${Math.abs(ideal - net) > Math.max(1, ideal * 0.03) ? `<small title="工厂满负荷、采集按头一天平均时的净产量">满负荷 ${qtyText(ideal)}</small>` : ''}`}</td></tr>`;
  }).join('');
  const seg = (attr, list, cur) => `<span class="pie-seg">${list.map(([v, label]) => `<button type="button" data-${attr}="${v}"${String(v) === String(cur) ? ' class="on"' : ''}>${label}</button>`).join('')}</span>`;
  // 最早出问题的时刻：满仓或断料
  const events = [
    ...sim.hubs.filter((h) => h.fullAt != null).map((h) => ({ at: h.fullAt, pin: h.i, text: `${pinName(m, h.i)} 满仓` })),
    ...sim.starved.map((f) => ({ at: f.at, pin: f.i, text: `${pinName(m, f.i)} 断料（缺${env.cName(f.type)}）` }))
  ].sort((a, b) => a.at - b.at);
  const first = events[0];
  const sum = first
    ? `<p class="pie-sim-sum warn"><b>${fmtH(first.at)}</b> 内要上线一次：之后${env.esc(first.text)}</p>`
    : `<p class="pie-sim-sum ok">${fmtH(sim.hours)} 内不会满仓或断料</p>`;
  return `<section class="pie-panel">
      <header>产量${seg('pie-period', PERIODS.map(([k, l]) => [k, l]), SIM.period)}</header>
      <table class="pie-prod"><thead><tr><th>物品</th><th class="num">毛产量</th><th class="num">净产量</th></tr></thead><tbody>${rows}</tbody></table>
      <small class="pie-note">按时补货、取走时 ${fmtH(sim.hours)} 内的平均值：采集产量随采集程序时间衰减（头一天平均按每头 ${env.formatNumber(env.headRate())} / 小时），上游供不上会减产</small>
    </section>
    <section class="pie-panel">
      <header>存储与维护${seg('pie-simh', SIM_HOURS, SIM.hours)}</header>
      ${sum}
      ${events.length > 1 ? `<ul class="pie-events">${events.slice(1, 6).map((e) => `<li data-pie-goto="${e.pin}"><b>${fmtH(e.at)}</b>${env.esc(e.text)}</li>`).join('')}</ul>` : ''}
      ${chartHtml(sim)}
      <label class="pie-row pie-sim-at"><span>时间轴 <b id="pieSimAt">${fmtH(SIM.at)}</b></span><input type="range" min="0" max="${sim.hours}" step="${sim.dt}" value="${SIM.at}" data-pie-prop="sim-at"></label>
      <div id="pieSimRead">${simReadHtml(m, sim, SIM.at)}</div>
    </section>`;
}

// 各仓储装了多满（随时间），竖线是时间轴所在位置
function chartHtml(sim) {
  const W = 300, H = 92, top = 8, bot = 16;
  const y = (f) => top + (1 - Math.min(1, f)) * (H - top - bot);
  const lines = sim.hubs.map((h, n) => {
    const pts = [];
    const every = Math.max(1, Math.floor(sim.steps / 150));
    for (let k = 0; k <= sim.steps; k += every) pts.push(`${((k / sim.steps) * W).toFixed(1)},${y(h.fill[k] / h.cap).toFixed(1)}`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${HUB_LINE[n % HUB_LINE.length]}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }).join('');
  const marks = [
    ...sim.hubs.filter((h) => h.fullAt != null).map((h) => `<circle cx="${((h.fullAt / sim.hours) * W).toFixed(1)}" cy="${y(1)}" r="3.5" fill="#ff5a5a"/>`),
    ...sim.starved.map((f) => `<circle cx="${((f.at / sim.hours) * W).toFixed(1)}" cy="${H - bot}" r="3.5" fill="#ffb102"/>`)
  ].join('');
  const ticks = [0, 0.5, 1].map((f) => `<text x="${f * W}" y="${H - 3}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${fmtH(sim.hours * f)}</text>`).join('');
  return `<div class="pie-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}" class="cap"/><line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/>
      ${lines}${marks}<line id="pieSimCur" x1="${(SIM.at / sim.hours) * W}" x2="${(SIM.at / sim.hours) * W}" y1="0" y2="${H - bot}" class="cur"/>${ticks}</svg>
    <div class="pie-chart-legend">${sim.hubs.map((h, n) => `<span><i style="background:${HUB_LINE[n % HUB_LINE.length]}"></i>${pinName(E.view.model, h.i)}</span>`).join('')}<span><i class="dot r"></i>满仓</span><span><i class="dot o"></i>断料</span></div></div>`;
}

// 时间轴所在时刻：每个仓储装了多少、开局要装什么
function simReadHtml(m, sim, at) {
  const k = Math.min(sim.steps, Math.round(at / sim.dt));
  return sim.hubs.map((h) => {
    const v = h.fill[k];
    const stock = [...h.series].map(([t, arr]) => [t, arr[k]]).filter(([, n]) => n >= 1).sort((a, b) => b[1] * (env.pi.commodities[b[0]]?.[3] || 0) - a[1] * (env.pi.commodities[a[0]]?.[3] || 0));
    const out = stock.filter(([t]) => !h.ext.has(t));
    const left = stock.filter(([t]) => h.ext.has(t));
    return `<div class="pie-hub">
      <div class="pie-hub-head"><b>${pinName(m, h.i)}</b><span>${Math.round((v / h.cap) * 100)}%<small> · ${env.formatNumber(Math.round(v))} / ${env.formatNumber(h.cap)} m³</small></span></div>
      <i class="pie-fill${v >= h.cap - 1 ? ' full' : ''}"><em style="width:${Math.min(100, (v / h.cap) * 100).toFixed(1)}%"></em></i>
      ${h.initial.size ? `<div class="pie-hub-row"><span>开局装<small>（够 ${fmtH(h.refill)}）</small></span><div>${[...h.initial].map(([t, n]) => chip(t, n)).join('')}</div></div>` : ''}
      ${left.length ? `<div class="pie-hub-row"><span>原料还剩</span><div>${left.map(([t, n]) => chip(t, n)).join('')}</div></div>` : ''}
      <div class="pie-hub-row"><span>${at > 0 ? '可取走' : '存量'}</span><div>${out.length ? out.map(([t, n]) => chip(t, n)).join('') : '<small>空</small>'}</div></div>
    </div>`;
  }).join('');
}

function updateSimRead() {
  const sim = E.sim;
  if (!sim || !E.view) return;
  const read = $('pieSimRead');
  if (read) read.innerHTML = simReadHtml(E.view.model, sim, SIM.at);
  const label = $('pieSimAt');
  if (label) label.textContent = fmtH(SIM.at);
  const cur = $('pieSimCur');
  if (cur) { const x = String((SIM.at / sim.hours) * 300); cur.setAttribute('x1', x); cur.setAttribute('x2', x); }
}

// ---------- 存到游戏（桌面版）----------
export const canSaveToGame = () => Boolean(window.__EVE_DESKTOP__ && window.__TAURI_INTERNALS__);
// 文件里的非 ASCII 字符（中文模板名）写成 \uXXXX，跟游戏自己导出的一样
const asciiJson = (text) => text.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
export function saveToGame(json) {
  return window.__TAURI_INTERNALS__.invoke('pi_tpl_save', { name: json.Cmt || 'template', text: asciiJson(templateText(json)) })
    .then(() => env.showToast(`已存到游戏模板库：游戏里重新打开行星的模板列表就能看到「${json.Cmt}」`, 'success', 4000))
    .catch((e) => env.showToast(/not found|not allowed|unknown/i.test(String(e)) ? '要更新桌面版才能直接存到游戏，先用「复制模板」' : '没有存进去：' + (e?.message || e), 'error', 4500));
}

// ---------- 交互 ----------
function local(e) {
  const r = E.view.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitPin(x, y) {
  const { cam, model: m } = E.view;
  const b = basis(cam);
  const r = pinRadius(cam) + 5;
  let best = -1, bd = Infinity;
  m.pins.forEach((p, i) => {
    const s = project(cam, b, p.th, p.ph);
    if (!s.visible) return;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < (p.kind === 'ecu' ? r * 1.6 : r) && d < bd) { bd = d; best = i; }
  });
  return best;
}

function hitLink(x, y) {
  const { cam, model: m } = E.view;
  const b = basis(cam);
  for (let i = m.links.length - 1; i >= 0; i--) {
    const pts = arc(m.pins[m.links[i].a], m.pins[m.links[i].b], 12).map((p) => project(cam, b, p.th, p.ph));
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], c = pts[k];
      if (!a.visible || !c.visible) continue;
      const dx = c.x - a.x, dy = c.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) < 6) return i;
    }
  }
  return -1;
}

function onPointerDown(e) {
  if (e.button > 0) return;
  const { x, y } = local(e);
  E.view.canvas.setPointerCapture(e.pointerId);
  const pin = hitPin(x, y);
  if (pin >= 0) {
    if (E.linkMode) { linkClick(pin); return; }
    const p = E.view.model.pins[pin];
    const at = unproject(E.view.cam, basis(E.view.cam), x, y);
    E.drag = { kind: 'pin', i: pin, dth: at ? p.th - at.th : 0, dph: at ? p.ph - at.ph : 0, moved: false, x, y };
    if (E.view.sel?.pin !== pin) { E.view.sel = { pin }; renderSide(); requestDraw(); }
    return;
  }
  const link = E.linkMode ? -1 : hitLink(x, y);
  if (link >= 0) { E.view.sel = { link }; renderSide(); requestDraw(); return; }
  E.drag = { kind: 'rotate', x, y, th: E.view.cam.th, ph: E.view.cam.ph, moved: false };
}

function onPointerMove(e) {
  if (!E.view) return;
  const { x, y } = local(e);
  if (!E.drag) {
    const pin = hitPin(x, y);
    E.view.hover = pin >= 0 ? pin : null;
    const hover = pin >= 0 || (!E.linkMode && hitLink(x, y) >= 0);
    E.view.canvas.style.cursor = E.linkMode ? 'crosshair' : hover ? 'pointer' : 'grab';
    return;
  }
  E.view.hover = null;
  const cam = E.view.cam;
  if (Math.hypot(x - E.drag.x, y - E.drag.y) > 2) E.drag.moved = true;
  if (E.drag.kind === 'pin') {
    const at = unproject(cam, basis(cam), x, y);
    if (!at) return;
    const p = E.view.model.pins[E.drag.i];
    p.th = Math.min(Math.PI - 0.01, Math.max(0.01, at.th + E.drag.dth));
    p.ph = ((at.ph + E.drag.dph) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    requestDraw();
  } else {
    E.view.canvas.style.cursor = 'grabbing';
    cam.th = Math.min(Math.PI - 0.02, Math.max(0.02, E.drag.th - (y - E.drag.y) / cam.rpx));
    cam.ph = E.drag.ph - (x - E.drag.x) / (cam.rpx * Math.max(0.2, Math.sin(cam.th)));
    requestDraw();
  }
}

function onPointerUp() {
  const d = E.drag;
  E.drag = null;
  if (!d || !E.view) return;
  if (d.kind === 'pin' && d.moved) changed();
  else if (d.kind === 'rotate' && !d.moved && (E.view.sel || E.view.linkFrom != null)) { E.view.sel = null; E.view.linkFrom = null; renderSide(); requestDraw(); }
}

function onWheel(e) {
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, local(e));
}

// 以某点为中心缩放：保持该点下的地表位置不动
function zoom(f, at) {
  const cam = E.view.cam;
  const w = E.view.canvas.clientWidth, h = E.view.canvas.clientHeight;
  const before = at ? unproject(cam, basis(cam), at.x, at.y) : null;
  cam.rpx = Math.max(minRpx(w, h), Math.min(80000, cam.rpx * f));
  if (before && at) {
    const after = unproject(cam, basis(cam), at.x, at.y);
    if (after) {
      cam.th = Math.min(Math.PI - 0.02, Math.max(0.02, cam.th + (before.th - after.th)));
      let dph = before.ph - after.ph;
      if (dph > Math.PI) dph -= Math.PI * 2;
      if (dph < -Math.PI) dph += Math.PI * 2;
      cam.ph += dph;
    }
  }
  requestDraw();
}

function linkClick(i) {
  const view = E.view;
  if (view.linkFrom == null) { view.linkFrom = i; view.sel = { pin: i }; renderSide(); requestDraw(); return; }
  const a = view.linkFrom;
  view.linkFrom = null;
  if (a === i) { requestDraw(); return; }
  const m = view.model;
  const idx = m.links.findIndex((l) => (l.a === a && l.b === i) || (l.a === i && l.b === a));
  if (idx >= 0) m.links.splice(idx, 1);
  else m.links.push({ a, b: i, lv: 0 });
  view.sel = { pin: i };
  changed();
}

// 某点附近、与所有设施相距至少一个间距的空位
function freeSpot(m, c) {
  for (let ring = 0; ring < 30; ring++) {
    const n = Math.max(1, ring * 6);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const d = ring * SPACING;
      const cand = { th: c.th - Math.sin(a) * d, ph: c.ph + (Math.cos(a) * d) / Math.max(0.2, Math.sin(c.th)) };
      if (m.pins.every((p) => pinAngle(p, cand) >= SPACING)) return cand;
    }
  }
  return c;
}

function addPin(kind, from = null) {
  const view = E.view;
  const m = view.model;
  const pt = env.ptByCode[m.code];
  const c = from != null ? m.pins[from] : unproject(view.cam, basis(view.cam), view.cam.cx, view.cam.cy) || { th: view.cam.th, ph: view.cam.ph };
  const pos = freeSpot(m, c);
  const pin = { kind, th: pos.th, ph: pos.ph, heads: kind === 'ecu' ? 10 : 0, product: null };
  if (kind === 'ecu') pin.product = pt.res[0];
  else if (kind === 'basic') pin.product = productOptions(m, 'basic')[0] || null;
  const hubs = m.pins.map((p, i) => [p, i]).filter(([p]) => HUBS.has(p.kind)).sort((a, b) => pinAngle(a[0], pos) - pinAngle(b[0], pos));
  m.pins.push(pin);
  const i = m.pins.length - 1;
  if (hubs.length && !HUBS.has(kind)) m.links.push({ a: hubs[0][1], b: i, lv: 0 });
  view.fx.set(pin, performance.now());
  view.blame = pin;
  view.sel = { pin: i };
  changed();
  return i;
}

function deleteSelected() {
  const view = E.view;
  const m = view.model;
  if (view.sel?.pin != null) {
    const i = view.sel.pin;
    const [gone] = m.pins.splice(i, 1);
    view.ghosts.push({ th: gone.th, ph: gone.ph, kind: gone.kind, product: gone.product, at: performance.now() });
    if (view.blame === gone) view.blame = null;
    m.links = m.links.filter((l) => l.a !== i && l.b !== i).map((l) => ({ ...l, a: l.a > i ? l.a - 1 : l.a, b: l.b > i ? l.b - 1 : l.b }));
  } else if (view.sel?.link != null) m.links.splice(view.sel.link, 1);
  else return;
  view.sel = null;
  changed();
}

function duplicateSelected() {
  const view = E.view;
  if (view.sel?.pin == null) return;
  const src = view.model.pins[view.sel.pin];
  const i = addPin(src.kind, view.sel.pin);
  Object.assign(view.model.pins[i], { product: src.product, heads: src.heads });
  changed();
}

function importJson() {
  const text = prompt('粘贴模板 JSON');
  if (!text) return;
  try {
    const json = JSON.parse(text);
    if (!Array.isArray(json.P)) throw new Error('缺少 P');
    E.view.model = fromJson(json);
    E.view.sel = null;
    E.view.cam = fitCam(E.view.model, E.view.canvas.clientWidth, E.view.canvas.clientHeight);
    changed();
    env.showToast(`已导入 ${E.view.model.pins.length} 个设施`, 'success');
  } catch (err) {
    env.showToast('不是有效的殖民地模板：' + err.message, 'error', 3000);
  }
}

export function downloadTemplate(json) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([templateText(json, true)], { type: 'application/json' }));
  a.download = `${json.Cmt}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function onModalClick(e) {
  if (!E.view) return;
  if (e.target.id === 'pieModal') { closeEditor(); return; }
  const add = e.target.closest('[data-pie-add]');
  if (add) { addPin(add.dataset.pieAdd); return; }
  const simh = e.target.closest('[data-pie-simh]');
  if (simh) { SIM.hours = Number(simh.dataset.pieSimh); SIM.at = Math.min(SIM.at ?? 0, SIM.hours); saveSim(); renderSide(); return; }
  const per = e.target.closest('[data-pie-period]');
  if (per) { SIM.period = per.dataset.piePeriod; saveSim(); renderSide(); return; }
  const go = e.target.closest('[data-pie-goto]');
  if (go) { focusPin(Number(go.dataset.pieGoto)); return; }
  const gol = e.target.closest('[data-pie-goto-link]');
  if (gol) { E.view.sel = { link: Number(gol.dataset.pieGotoLink) }; renderSide(); requestDraw(); return; }
  const act = e.target.closest('[data-pie]')?.dataset.pie;
  if (!act) return;
  const view = E.view;
  const center = () => ({ x: view.canvas.clientWidth / 2, y: view.canvas.clientHeight / 2 });
  if (act === 'close') closeEditor();
  else if (act === 'zoom-in') zoom(1.4, center());
  else if (act === 'zoom-out') zoom(1 / 1.4, center());
  else if (act === 'fit') { view.cam = fitCam(view.model, view.canvas.clientWidth, view.canvas.clientHeight); requestDraw(); }
  else if (act === 'link') toggleLinkMode();
  else if (act === 'delete') deleteSelected();
  else if (act === 'dup') duplicateSelected();
  else if (act === 'import') importJson();
  else if (act === 'reset') {
    view.model = fromJson(JSON.parse(E.original));
    view.sel = null; view.blame = null; E.dirty = false;
    requestDraw(); renderSide(); renderHud();
  } else if (act === 'copy') {
    navigator.clipboard.writeText(templateText(toJson(view.model)))
      .then(() => env.showToast('已复制模板，到游戏里「从剪贴板载入」', 'success'))
      .catch(() => env.showToast('浏览器阻止了复制，请改用下载', 'error'));
  } else if (act === 'download') downloadTemplate(toJson(view.model));
  else if (act === 'game') saveToGame(toJson(view.model));
  else if (act === 'save') {
    const j = toJson(view.model);
    const u = usage(view.model);
    E.onSave?.(j, { cpu: u.cpu, power: u.power, code: view.model.code });
    E.original = templateText(j);
    E.dirty = false;
    env.showToast('已保存', 'success');
    closeEditor(true);
  }
}

function focusPin(i) {
  const view = E.view;
  const p = view.model.pins[i];
  if (!p) return;
  view.sel = { pin: i };
  view.cam.th = p.th; view.cam.ph = p.ph;
  renderSide();
  requestDraw();
}

function toggleLinkMode() {
  E.linkMode = !E.linkMode;
  E.view.linkFrom = null;
  renderHud(); renderSide(); requestDraw();
}

function onModalChange(e) {
  const prop = e.target.dataset.pieProp;
  if (!prop || !E.view) return;
  const view = E.view;
  const m = view.model;
  if (prop === 'code') { m.code = e.target.value; changed(); }
  else if (prop === 'cc') { m.cc = Number(e.target.value); changed(); }
  else if (prop === 'diam') { const d = Math.min(200000, Math.max(1000, Number(e.target.value) || 10000)); m.R = d / 2; e.target.value = d; changed(); }
  else if (prop === 'product' && view.sel?.pin != null) { m.pins[view.sel.pin].product = Number(e.target.value) || null; view.blame = m.pins[view.sel.pin]; changed(); }
  else if (prop === 'heads' && view.sel?.pin != null) { m.pins[view.sel.pin].heads = Number(e.target.value); view.blame = m.pins[view.sel.pin]; changed(); }
  else if (prop === 'lv' && view.sel?.link != null) { m.links[view.sel.link].lv = Number(e.target.value); changed(); }
}

function onModalInput(e) {
  const prop = e.target.dataset.pieProp;
  if (!prop || !E.view) return;
  if (prop === 'name') { E.view.model.name = e.target.value; E.dirty = true; }
  else if (prop === 'sim-at') { SIM.at = Number(e.target.value); saveSim(); updateSimRead(); }
  else if (prop === 'heads' && E.view.sel?.pin != null) {
    E.view.model.pins[E.view.sel.pin].heads = Number(e.target.value);
    E.view.blame = E.view.model.pins[E.view.sel.pin];
    const b = e.target.closest('.pie-row')?.querySelector('.pie-heads');
    if (b) b.textContent = e.target.value;
    E.dirty = true;
    requestDraw();
    renderHud();
  }
}

function onKey(e) {
  const modal = $('pieModal');
  if (!modal || modal.hidden || !E.view) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (E.linkMode) toggleLinkMode();
    else closeEditor();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) { e.preventDefault(); deleteSelected(); }
  else if ((e.key === 'l' || e.key === 'L') && !typing) toggleLinkMode();
}
