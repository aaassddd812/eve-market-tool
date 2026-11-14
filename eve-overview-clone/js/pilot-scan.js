// 驾驶模拟 · 扫描器：定向扫描器（客户端 directionalScannerWindow / directionalScannerPalette）、
// 探针扫描器（probeScannerWindow / probeScannerPalette / scanResults）。只读客户端界面代码后重写，没有搬代码。
// 客户端里探针的信号强度、偏差是服务器算的，这里按社区推导的旧公式近似（见 probeStrength）；
// 探针扫描器在客户端里默认嵌在「恒星系图」里（mapProbePanelEmbedded = True）：窗口左边是 3D 星系图（pilot-sysmap.js），右边是扫描面板。
// 滑条照客户端 carbonui Slider：10 像素高的暗条（#303030 边、黑 60% 底），刻度线 #305665，4×8 的拖柄 #58A7BF；拖动时吸附到档位。
let H = null;   // 钩子：{ S, root(), esc, tr, UI, typeName, typeImg(id), fmtDist, AU, ovShows(type), ovShowsGroup(g), icon(v), celIcon(c), menu(items, e), unitMenu(v), warpTo(tgt, d), log, openWin(id) }
export function initScan(hooks) { H = hooks; }

const IMG = (p) => `${H.UI}${p}?v=1`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
import { createSysMap } from './pilot-sysmap.js?v=3';

// ---------- 定向扫描器 ----------
// 距离上限 14.3 AU（int(14.3 × AU / 1000) km），下限 10 km；滑条档位 0.1、1、5、10（每 5 AU 一档）再加上限
// 角度 5° ~ 360°，默认 90°；档位按客户端的 7 档（反编译出来的常量表是乱的，取通行的 5/15/30/60/90/180/360）
const AU_KM = () => H.AU / 1000;
const DS_MAX = () => Math.floor(14.3 * AU_KM());
const DS_STEPS = [0.1, 1, 5, 10, 14.3];
const ANGLES = [5, 15, 30, 60, 90, 180, 360];
const DS_COOL = 1500;   // THROTTLE_TIME：扫完 1.5 秒后才能再扫
const DS_SWEEP = 1700;  // 列表上的绿色扫光 1.7 秒

export function scanReset() {
  const S = H.S;
  S.scan = {
    d: { km: DS_MAX(), unit: 'AU', angle: 90, res: null, filtered: 0, cool: 0, at: 0, pend: false, n: 0, last: null },
    p: { probes: [], inLauncher: PROBES, step: 5, form: null, center: null, sigs: [], res: new Map(), busyUntil: 0, scans: 0, sel: null, cel: new Map() },
  };
}

// 镜头看的方向（从镜头指向注视点）
function lookDir() {
  const ci = H.S.view?.camInfo?.();
  return ci ? [-ci.dir[0], -ci.dir[1], -ci.dir[2]] : [1, 0, 0];
}
// dir：扫描方向（不给就用镜头看的方向，客户端 GetScanDirection）
export function dscan(dirIn) {
  const S = H.S, d = S.scan?.d, me = S.me;
  if (!d || !me) return false;
  const now = performance.now();
  if (now < d.cool) { d.pend = true; return false; }
  d.cool = now + DS_COOL;
  d.pend = false;
  const dir = dirIn || lookDir(), cosA = Math.cos((d.angle / 2) * Math.PI / 180), maxM = d.km * 1000;
  const rows = [];
  let filtered = 0;
  const seen = (pos, r = 0) => {
    const v = sub(pos, me.pos), l = len(v);
    const dist = Math.max(0, l - r - me.t.radius);
    if (dist > maxM) return -1;
    if (d.angle < 360 && l > 0 && dot(v, dir) / l < cosA) return -1;
    return dist;
  };
  // 舰船（不管在不在同一网格，定向扫描就是用来找网格外的船的）
  for (const u of S.b.units) {
    if (u === me || !u.alive) continue;
    const dist = seen(u.pos, u.t.radius);
    if (dist < 0) continue;
    if (!H.ovShows(u.r.row.ship)) { filtered++; continue; }
    rows.push({ k: 'u' + u.i, icon: H.icon(u), name: S.names[u.i], type: H.typeName(u.r.row.ship), dist });
  }
  // 太空中的无人机、自己的探针
  for (const o of S.b.units) {
    if (!o.alive) continue;
    for (const dr of o.drones) {
      if (!dr.pos || dr.e) continue;
      const dist = seen(dr.pos);
      if (dist < 0) continue;
      if (!H.ovShows(dr.g.type)) { filtered++; continue; }
      rows.push({ k: '', icon: H.iconOf(dr.g.type), name: H.typeName(dr.g.type), type: H.typeName(dr.g.type), dist });
    }
  }
  for (const pr of S.scan.p.probes) {
    const dist = seen(pr.pos);
    if (dist < 0) continue;
    rows.push({ k: '', icon: H.typeImg(PROBE), name: H.typeName(PROBE), type: H.typeName(PROBE), dist });
  }
  // 天体
  (S.b.cel || []).forEach((c, i) => {
    if (!c.group) return;   // 扫描出来的信号地点不在定向扫描里
    const dist = seen(c.pos, c.radius || 0);
    if (dist < 0) return;
    if (!H.ovShowsGroup(c.group)) { filtered++; return; }
    rows.push({ k: 'c' + i, icon: H.celIcon(c), name: c.name, type: c.typeName || '', dist });
  });
  // 默认排序：第一个排序值（客户端 sortValues 的第一项是组名，这里用类型名代替），再按距离
  rows.sort((a, b) => a.type.localeCompare(b.type, 'zh') || a.dist - b.dist);
  Object.assign(d, { res: rows, filtered, at: now, n: d.n + 1, last: { angle: d.angle, km: d.km, units: rows.filter((r) => r.k[0] === 'u').map((r) => Number(r.k.slice(1))) } });
  renderDscan(true);
  return true;
}
export const dsBody = () => `<div class="pl-ds-top"><span>${esc0('扫描结果')}</span><span class="flt" data-ds-flt></span></div>
  <div class="pl-ds-list" data-ds-list></div>
  <div class="pl-ds-bot">
    <div class="half"><div class="lbl">${esc0('范围')}<input type="text" data-ds-range inputmode="decimal"><button type="button" class="unit" data-ds-unit></button></div>${slHtml('ds-r')}</div>
    <div class="half"><div class="lbl" data-ds-alab></div>${slHtml('ds-a')}</div>
    <button type="button" class="pl-btn pl-busybtn pl-ds-go" data-ds-scan title="${esc0('定向扫描')} (V)\n${esc0('扫描朝向')}：V + ${esc0('点击')}"><span>${esc0('扫描')}</span></button>
  </div>`;
const esc0 = (t) => H.esc(H.tr(t));
const kmText = (d) => (d.unit === 'AU' ? +(d.km / AU_KM()).toFixed(2) : Math.round(d.km)).toLocaleString('en-US');
export function renderDscan(force = false) {
  const root = H.root(), d = H.S.scan?.d;
  const w = root?.querySelector('[data-win="dscan"]');
  if (!w || !d) return;
  const now = performance.now();
  // 冷却：按钮变灰；有排队的扫描冷却完自动扫
  // 扫描按钮：扫描中（发出到冷却结束）流动箭头、不能点（客户端 ScanButton 的 is_arrow_animated / is_enabled）
  const go = w.querySelector('[data-ds-scan]');
  go.disabled = now < d.cool;
  go.classList.toggle('busy', now < d.cool);
  if (d.pend && now >= d.cool) dscan();
  const inp = w.querySelector('[data-ds-range]');
  if (document.activeElement !== inp && inp.value !== kmText(d)) inp.value = kmText(d);
  w.querySelector('[data-ds-unit]').textContent = d.unit === 'AU' ? 'AU' : 'km';
  slRender(w, 'ds-r'); slRender(w, 'ds-a');
  w.querySelector('[data-ds-alab]').textContent = `${H.tr('角度')}: ${d.dragAngle ?? d.angle}°`;
  const flt = w.querySelector('[data-ds-flt]');
  const ft = d.res ? `${H.tr(`已过滤${d.filtered}个`)}` : '';
  if (flt.textContent !== ft) { flt.textContent = ft; flt.title = H.tr('当前的总览过滤器'); }
  const list = w.querySelector('[data-ds-list]');
  list.classList.toggle('sweep', now - d.at < DS_SWEEP);
  if (!force && list.dataset.n === String(d.n)) return;
  list.dataset.n = d.n;
  const { esc, fmtDist } = H;
  list.innerHTML = !d.res ? '' : d.res.length
    ? `<table><colgroup><col style="width:22px"><col><col><col style="width:84px"></colgroup><thead><tr><th></th><th>${esc0('名字')}</th><th>${esc0('类型')}</th><th>${esc0('距离')}</th></tr></thead><tbody>${d.res.map((r) => `<tr${r.k ? ` data-ds-k="${r.k}"` : ''}><td><img src="${r.icon}" alt=""></td><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(fmtDist(r.dist))}</td></tr>`).join('')}</tbody></table>`
    : `<div class="pl-ds-none">${esc0('无扫描结果')}</div>`;
}
function setRange(km, scan = true) { const d = H.S.scan.d; d.km = Math.max(10, Math.min(DS_MAX(), km)); renderDscan(); if (scan) dscan(); }

// ---------- 滑条（客户端 carbonui Slider）----------
// 档位位置：范围滑条按数值（0.1、1、5、10、14.3 AU 在 0–14.3 上的位置），角度、探针尺寸滑条等距
const even = (n) => Array.from({ length: n }, (_, i) => i / (n - 1));
const SL = {
  'ds-r': {
    norms: () => DS_STEPS.map((v) => v / DS_STEPS[DS_STEPS.length - 1]),
    get: () => Math.min(1, H.S.scan.d.km / AU_KM() / DS_STEPS[DS_STEPS.length - 1]),
    // 拖动中只改范围数字，松手才扫描（客户端 OnSetDistanceSliderValue / EndSetDistanceSliderValue）
    set: (i, end) => setRange(i === DS_STEPS.length - 1 ? DS_MAX() : DS_STEPS[i] * AU_KM(), end),
  },
  'ds-a': {
    norms: () => even(ANGLES.length),
    get: () => Math.max(0, ANGLES.indexOf(H.S.scan.d.dragAngle ?? H.S.scan.d.angle)) / (ANGLES.length - 1),
    set: (i, end) => { const d = H.S.scan.d; if (end) { d.angle = ANGLES[i]; d.dragAngle = null; renderDscan(); dscan(); } else { d.dragAngle = ANGLES[i]; renderDscan(); } },
  },
  'ps-size': {
    norms: () => even(8),
    get: () => (H.S.scan.p.step - 1) / 7,
    // 改尺寸：各探针到阵型中心的距离跟着半径同比例缩放（拖过的探针相对位置不变）
    set: (i) => { const p = H.S.scan.p; if (p.probes.length && i + 1 !== p.step) { resize(i + 1); renderProbe(); } },
  },
};
const slHtml = (k) => `<div class="pl-sl" data-sl="${k}"><span class="tk"></span><b class="hd"><i></i></b></div>`;
function slRender(w, k) {
  const el = w.querySelector(`[data-sl="${k}"]`);
  if (!el) return;
  const c = SL[k], ns = c.norms();
  const tk = el.querySelector('.tk'), key = ns.join(',');
  if (tk.dataset.k !== key) { tk.dataset.k = key; tk.innerHTML = ns.map((n) => (n > 0 && n < 1 ? `<i style="--n:${n}"></i>` : '')).join(''); }
  if (!el.classList.contains('drag')) el.style.setProperty('--x', c.get().toFixed(4));
}
const nearest = (ns, x) => ns.reduce((b, n, i) => (Math.abs(n - x) < Math.abs(ns[b] - x) ? i : b), 0);
function slDown(e, el) {
  const c = SL[el.dataset.sl];
  if (!c || el.classList.contains('off')) return;
  e.preventDefault();
  e.stopPropagation();
  const ns = c.norms(), at = (ev) => { const r = el.getBoundingClientRect(); return nearest(ns, Math.max(0, Math.min(1, (ev.clientX - r.left - 2) / Math.max(1, r.width - 4)))); };
  let i = at(e);
  el.classList.add('drag');
  el.style.setProperty('--x', ns[i]);
  c.set(i, false);
  el.setPointerCapture(e.pointerId);
  const move = (ev) => { const j = at(ev); if (j !== i) { i = j; el.style.setProperty('--x', ns[i]); c.set(i, false); } };
  const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); c.set(i, true); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
// 滚轮：一格一个档位
function slWheel(e, el) {
  const c = SL[el.dataset.sl];
  if (!c || el.classList.contains('off')) return;
  e.preventDefault();
  const ns = c.norms(), i = Math.max(0, Math.min(ns.length - 1, nearest(ns, c.get()) + (e.deltaY < 0 ? 1 : -1)));
  c.set(i, true);
}

// ---------- 探针扫描器 ----------
const LAUNCHER_GROUP = 481, PROBE = 30013, PROBES = 8;   // 核心探针发射器（容量 0.8 m³ / 探针 0.1 m³ = 8 个）
const BASE_R = 0.25, R_FACTOR = 2, BASE_STR = 40, BASE_DEV = 0.125;   // 核心扫描探针 I：baseScanRange / rangeFactor / baseSensorStrength / baseMaxScanDeviation
// 全 5 级技能（天体测量学 +5%×5、天体测距 +10%×5、苍鹭级 +7.5%×5、天体精确定位 −10%×5 偏差、天体获取 −5%×5 时长）——加成数值是游戏里技能说明的通行数值
const STR_MULT = 1.25 * 1.5, DEV_MULT = 0.5, SCAN_T = 10 * 0.75;
const stepR = (n) => BASE_R * R_FACTOR ** (n - 1);   // 档位 1–8：0.25、0.5、1 … 32 AU
const EXPLORERS = new Set([605, 607, 586, 29248]);   // 探索护卫舰：苍鹭级、伊米卡斯级、侦测级、富豪级
const hullBonus = () => (EXPLORERS.has(H.S.me?.r?.row.ship) ? 1.375 : 1);   // 舰船加成 +7.5%/级 探针强度
const effStr = () => BASE_STR * STR_MULT * hullBonus();
// 阵型（单位偏移 × 探针半径）：精确式 = 中心周围半径一半处 6 个 + 上下各 1；分散式 = 中心 1 个 + 外圈 7 个
const FORM = {
  pin: { step: 5, off: [[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5], [0.25, 0, 0.43], [-0.25, 0, -0.43], [0, 0.5, 0], [0, -0.5, 0]] },
  spread: { step: 7, off: [[0, 0, 0], ...Array.from({ length: 7 }, (_, k) => [Math.cos(k * 2 * Math.PI / 7) * 1.2, 0, Math.sin(k * 2 * Math.PI / 7) * 1.2])] },
};
function launcher() {
  const on = H.S.on;
  if (!on?.rack) return null;
  return on.rack.find((x) => H.data().types.get(x.type)?.group === LAUNCHER_GROUP) || null;
}
const launcherState = () => { const L = launcher(); return !L ? 'none' : (H.S.scan.p.probes.length ? 'out' : H.S.scan.p.inLauncher > 0 ? 'ready' : 'empty'); };
// 按阵型摆探针（没发射就从发射器发射）；以舰船为中心
function formation(k) {
  const S = H.S, p = S.scan.p;
  if (!launcher()) { H.log('未装配发射器', 'bad'); return; }
  if (!p.probes.length) {
    if (p.inLauncher <= 0) { H.log('发射器中没有探针', 'bad'); return; }
    p.probes = Array.from({ length: Math.min(PROBES, p.inLauncher) }, () => ({ pos: S.me.pos.slice() }));
    p.inLauncher -= p.probes.length;
    p.center = S.me.pos.slice();
  }
  p.form = k;
  p.step = FORM[k].step;
  place();
}
function place() {
  const p = H.S.scan.p, R = stepR(p.step) * H.AU, off = FORM[p.form || 'pin'].off;
  p.probes.forEach((pr, i) => { const o = off[i % off.length]; pr.pos = [p.center[0] + o[0] * R, p.center[1] + o[1] * R, p.center[2] + o[2] * R]; });
  drawMap();
}
function resize(n) {
  const p = H.S.scan.p, k = stepR(n) / stepR(p.step), c = p.center || centroid(p.probes);
  p.step = n;
  for (const pr of p.probes) pr.pos = pr.pos.map((x, j) => c[j] + (x - c[j]) * k);
  drawMap();
}
function recover() {
  const p = H.S.scan.p;
  if (!p.probes.length) return;
  p.inLauncher += p.probes.length;
  p.probes = [];
  p.busyUntil = 0;
  renderProbe(true);
}
// 每个盖住信号的探针：(强度 / 100) × (1 − 0.65 × (距离 / 半径)^1.5) × 信号难度系数，加起来（最多 100%）
// 探针强度随半径每大一档减半；偏差 = 最大偏差 × (0.6s² − 1.6s + 1)（社区推导的旧公式，服务器真实算法客户端里没有）
function probeStrength(sig) {
  const p = H.S.scan.p, R = stepR(p.step) * H.AU;
  const str = effStr() / R_FACTOR ** (p.step - 1) / 100;
  let s = 0;
  for (const pr of p.probes) {
    const d = len(sub(pr.pos, sig.pos));
    if (d < R) s += str * (1 - 0.65 * (d / R) ** 1.5) * (sig.f ?? 0.6);
  }
  return Math.min(1, s);
}
function analyze() {
  const S = H.S, p = S.scan.p;
  if (!p.probes.length || performance.now() < p.busyUntil) return;
  p.busyUntil = performance.now() + SCAN_T * 1000;
  p.busyStart = performance.now();
  renderProbe(true);
}
function finishScan() {
  const S = H.S, p = S.scan.p;
  p.busyUntil = 0;
  p.scans++;
  const R = stepR(p.step) * H.AU;
  const keep = new Map([...p.res].filter(([, r]) => r.s >= 1));   // 100% 的结果一直留着
  for (const sig of p.sigs) {
    if (keep.has(sig.id)) continue;
    const s = probeStrength(sig);
    if (s <= 0) continue;
    const dev = s >= 1 ? 0 : BASE_DEV * R_FACTOR ** (p.step - 1) * DEV_MULT * (0.6 * s * s - 1.6 * s + 1) * H.AU;
    const a = Math.random() * 2 * Math.PI, r = dev * (0.3 + 0.7 * Math.random());
    const est = s >= 1 ? sig.pos.slice() : [sig.pos[0] + Math.cos(a) * r, sig.pos[1], sig.pos[2] + Math.sin(a) * r];
    const hits = p.probes.filter((pr) => len(sub(pr.pos, sig.pos)) < R);
    const old = p.res.get(sig.id);
    keep.set(sig.id, { sig, s, dev, est, geo: resGeo(hits, sig.pos, est), prev: old?.s ?? 0, isNew: !old });
  }
  p.res = keep;
  renderProbe(true);
}
// 客户端结果的形状（服务器给的 data 类型）：1 个探针 = 球（以探针为心、半径 = 到信号的距离）、2 个 = 两球相交的圆、
// 3 个 = 三球相交的两个点（真位置和它对三探针平面的镜像）、4 个以上 = 一个点
function resGeo(hits, pos, est) {
  const n = hits.length;
  if (n >= 4 || n === 0) return { kind: 'point', p: est };
  if (n === 1) return { kind: 'sphere', c: hits[0].pos.slice(), r: len(sub(pos, hits[0].pos)) };
  if (n === 2) {
    const c1 = hits[0].pos, c2 = hits[1].pos, d1 = len(sub(pos, c1)), d2 = len(sub(pos, c2)), v = sub(c2, c1), L = len(v) || 1;
    const u = v.map((x) => x / L), a = (d1 * d1 - d2 * d2 + L * L) / (2 * L);
    return { kind: 'circle', c: c1.map((x, k) => x + u[k] * a), n: u, r: Math.sqrt(Math.max(0, d1 * d1 - a * a)) };
  }
  const [A, B, C] = hits.map((h) => h.pos), e1 = sub(B, A), e2 = sub(C, A);
  const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = len(nn) || 1, nu = nn.map((x) => x / nl);
  const h = dot(sub(pos, A), nu), mir = pos.map((x, k) => x - 2 * h * nu[k]);
  return { kind: 'pair', pts: [pos.slice(), mir] };
}
export function warpSig(id, e) {
  const S = H.S, p = S.scan.p, r = p.res.get(id);
  if (!r || r.s < 1) return;
  let ci = p.cel.get(id);
  if (ci == null) {
    // 扫出来的地点作为一个可跃迁的位置加进天体表（组 0：总览、定向扫描、3D 都不显示）
    S.b.cel.push({ name: `${id} ${H.tr(r.sig.group)}`, pos: r.sig.pos.slice(), radius: 0, group: 0, typeName: H.tr(r.sig.group) });
    ci = S.b.cel.length - 1;
    p.cel.set(id, ci);
  }
  H.warpTo({ cel: ci }, 0);
}
// 窗口：左边 3D 星系图（右上角：回到自己、俯视、侧视），右边扫描面板（客户端嵌入式面板宽 362）
export const psBody = () => `<div class="pl-ps-wrap"><div class="pl-ps-map" data-ps-map><canvas></canvas><div class="pl-sm-ov" data-sm-ov></div>
    <div class="pl-sm-tools"><button type="button" data-sm-view="me" title="${esc0('聚焦当前地点')}"><img src="${IMG('classes/mapview/focusicon.png')}" alt=""></button></div>
    <div class="pl-sm-views"><button type="button" data-sm-view="top" title="${esc0('顶视图')}\n${esc0('切换视图')}：${esc0('双击场景')}"><img src="${IMG('classes/mapview/topview.png')}" alt=""></button><button type="button" data-sm-view="side" title="${esc0('侧视图')}\n${esc0('切换视图')}：${esc0('双击场景')}"><img src="${IMG('classes/mapview/sideview.png')}" alt=""></button></div>
    <div class="pl-sm-hint">${esc0('左键拖动旋转 · 右键拖动平移 · 滚轮缩放 · 拖动箭头或中心方块移动整个阵型 · 按住 Shift 拖动单个探针')}</div></div>
  <div class="pl-ps-side">
  <div class="pl-ds-top"><span>${esc0('扫描结果')}</span></div>
  <div class="pl-ds-list pl-ps-list" data-ps-list></div>
  <div class="pl-ps-bot">
    <div class="r1"><span class="pr" data-ps-pr></span><span class="bon"><span title="${esc0('强度')}"><img src="${IMG('classes/probescanner/16/strength.png')}" alt=""><b data-ps-str></b></span><span title="${esc0('偏差')}"><img src="${IMG('classes/probescanner/16/deviation.png')}" alt=""><b data-ps-dev></b></span><span title="${esc0('时长')}"><img src="${IMG('classes/probescanner/16/time.png')}" alt=""><b data-ps-time></b></span></span><button type="button" class="ic" data-ps-recover title="${esc0('收回在用的探针')}"><img src="${IMG('classes/probescanner/16/recoverprobesicon.png')}" alt=""></button></div>
    <div class="r2"><span class="forms"><button type="button" data-ps-form="pin" title="${esc0('精确式发射')}"><img src="${IMG('classes/probescanner/32/pinpointformation.png')}" alt=""></button><button type="button" data-ps-form="spread" title="${esc0('分散式发射')}"><img src="${IMG('classes/probescanner/32/spreadformation.png')}" alt=""></button><button type="button" class="na" title="${esc0('探针阵型')}"><img src="${IMG('classes/probescanner/32/customformation.png')}" alt=""></button><button type="button" data-ps-center title="${esc0('以你的舰船为中心布置当前阵型')}"><img src="${IMG('classes/probescanner/32/centerprobes.png')}" alt=""></button></span>
      <span class="size" title="${esc0('探针尺寸')}"><span data-ps-rl></span>${slHtml('ps-size')}</span>
      <button type="button" class="pl-btn pl-busybtn pl-ps-go" data-ps-go title="(B)"><span></span></button></div>
  </div></div></div>`;
const auText = (au) => (au < 1 ? au.toFixed(2) : String(Math.round(au)));
// 结果行颜色（客户端 ScanResultNew.GetColors：结果色的亮度 0.35 = 底，0.5 = 这次涨的部分，0.2 = 这次掉的部分）
const RGB = (s) => (s >= 1 ? [0, 0.8, 0] : s > 0.75 ? [1, 1, 0.1] : s > 0.25 ? [0.9, 0.5, 0] : [1, 0, 0]);
const atV = (c, v) => { const m = Math.max(...c) || 1; return `rgb(${c.map((x) => Math.round((x / m) * v * 255)).join(',')})`; };
export function renderProbe(force = false) {
  const root = H.root(), S = H.S, p = S.scan?.p;
  const w = root?.querySelector('[data-win="probe"]');
  if (!w || !p) return;
  const now = performance.now();
  if (p.busyUntil && now >= p.busyUntil) { finishScan(); return; }
  const busy = Boolean(p.busyUntil);
  const st = launcherState();
  const pr = w.querySelector('[data-ps-pr]');
  const prHtml = st === 'out' ? `<img src="${H.typeImg(PROBE)}" alt="">X ${p.probes.length}` : `<em>${esc0(st === 'none' ? '未装配发射器' : st === 'empty' ? '发射器中没有探针' : '未发射探针。')}</em>`;
  if (pr.dataset.k !== prHtml) { pr.dataset.k = prHtml; pr.innerHTML = prHtml; }
  w.querySelector('[data-ps-str]').textContent = (effStr()).toFixed(1);
  w.querySelector('[data-ps-dev]').textContent = `${(BASE_DEV * DEV_MULT).toFixed(3)} AU`;
  w.querySelector('[data-ps-time]').textContent = `${SCAN_T}s`;
  w.querySelector('[data-ps-recover]').classList.toggle('off', !p.probes.length);
  // 没探针时尺寸滑条藏起来（客户端 CheckButtonStates）
  w.querySelector('.pl-ps-bot .size').style.visibility = p.probes.length ? '' : 'hidden';
  slRender(w, 'ps-size');
  w.querySelector('[data-ps-rl]').textContent = `${auText(stepR(p.step))} AU`;
  const go = w.querySelector('[data-ps-go]');
  const gl = H.tr('分析');
  if (go.firstChild.textContent !== gl) go.firstChild.textContent = gl;
  go.disabled = busy || !p.probes.length;
  go.classList.toggle('busy', busy);
  const list = w.querySelector('[data-ps-list]');
  list.classList.toggle('busy', busy);
  const rows = [...p.res.values()].sort((a, b) => a.sig.id.localeCompare(b.sig.id));
  const key = JSON.stringify([rows.map((r) => [r.sig.id, Math.round(r.s * 1000)]), p.scans, p.sel]);
  if (force || list.dataset.k !== key) {
    list.dataset.k = key;
    const { esc, fmtDist } = H;
    // 列：图标 | 距离 | ID | 名字 | 组 | 信号（右对齐 50 宽）；行底 2 像素的信号条
    list.innerHTML = rows.length
      ? `<table><colgroup><col style="width:22px"><col style="width:74px"><col style="width:66px"><col style="width:96px"><col><col style="width:56px"></colgroup><thead><tr><th></th><th class="r">${esc0('距离')}</th><th>ID</th><th>${esc0('名字')}</th><th>${esc0('组')}</th><th class="r">${esc0('信号')}</th></tr></thead><tbody>${rows.map((r) => {
        const grp = r.s >= 0.25 ? esc0(r.sig.group) : `<span title="${esc0('需要25%信号强度才能识别。')}">${esc0('未知地点类型')}</span>`;
        const sig = r.s >= 1 ? `<button type="button" class="wp${r.isNew ? ' blink' : ''}" data-ps-warp="${r.sig.id}" title="${esc0('跃迁至')}"><img src="${IMG('icons/44_32_18.png')}" alt=""></button>` : `${(Math.floor(r.s * 1000) / 10).toFixed(1)}%`;
        const c = RGB(r.s), prev = Math.min(r.prev ?? 0, r.s), d = r.s - (r.prev ?? 0);
        const bar = d >= 0 ? `linear-gradient(90deg, ${atV(c, 0.35)} ${prev * 100}%, ${atV(c, 0.5)} 0 ${r.s * 100}%, transparent 0)` : `linear-gradient(90deg, ${atV(c, 0.35)} ${Math.max(0, r.s + d) * 100}%, ${atV(c, 0.2)} 0 ${r.s * 100}%, transparent 0)`;
        return `<tr data-ps-k="${r.sig.id}" class="${r.isNew ? 'new' : ''}${p.sel === r.sig.id ? ' sel' : ''}" style="--bar:${bar}"><td><i class="ri" style="--c:${RES_CSS(r.s)}"></i></td><td class="r">${esc(fmtDist(len(sub(r.est, S.me.pos))))}</td><td>${esc(r.sig.id)}</td><td>${r.s >= 0.75 ? esc0(r.sig.name) : ''}</td><td>${grp}</td><td class="r">${sig}</td></tr>`;
      }).join('')}</tbody></table>`
      : `<div class="pl-ds-none">${esc0(p.scans ? '当前星系没有死亡空间或异常空间信号' : (p.probes.length ? '没有部署探针' : '太空中无探针'))}</div>`;
    for (const r of rows) r.isNew = false;
  }
  drawMap();
}
// 信号强度颜色（客户端 GetResultColor）：≤25% 红、≤75% 橙、<100% 黄、100% 绿
const RES_CSS = (s) => (s >= 1 ? 'rgb(0,204,0)' : s > 0.75 ? 'rgb(255,255,26)' : s > 0.25 ? 'rgb(230,128,0)' : 'rgb(255,0,0)');

// ---------- 星系图 ----------
let MAP = null;
export function drawMap() {
  const root = H.root(), S = H.S;
  const box = root?.querySelector('[data-win="probe"] [data-ps-map]');
  if (!box || !S.scan || box.closest('[data-win]').hidden || !S.b) return;
  if (MAP && MAP.box !== box) { MAP.m.dispose(); MAP = null; }
  if (MAP && MAP.b !== S.b) { MAP.m.dispose(); MAP = null; }   // 换了场景（新练习）重建
  if (!MAP) {
    const p = () => H.S.scan.p;
    MAP = { box, b: S.b, m: createSysMap(box, {
      S, AU: H.AU, esc: H.esc, tr: H.tr, fmtDist: H.fmtDist, celIcon: H.celIcon, icon: H.icon,
      probes: () => p().probes, center: () => p().center, R: () => stepR(p().step) * H.AU, res: () => [...p().res.values()],
      busy: () => (p().busyUntil ? (performance.now() - p().busyStart) / (p().busyUntil - p().busyStart) : -1),
      selRes: () => p().sel,
      // k = 'all' 整个阵型（连中心一起），否则第 k 个探针
      moveProbe: (k, dv) => {
        const P = p(), mv = (a) => { a[0] += dv[0]; a[1] += dv[1]; a[2] += dv[2]; };
        if (k === 'all') { for (const pr of P.probes) mv(pr.pos); if (P.center) mv(P.center); }
        else if (P.probes[k]) { mv(P.probes[k].pos); P.center = centroid(P.probes); }
      },
    }) };
  }
  MAP.m.kick();
}
const centroid = (ps) => ps.reduce((c, x) => [c[0] + x.pos[0] / ps.length, c[1] + x.pos[1] / ps.length, c[2] + x.pos[2] / ps.length], [0, 0, 0]);
export function bindScanWin(stage) {
  stage.addEventListener('pointerdown', (e) => { const el = e.target.closest?.('.pl-sl'); if (el && e.button === 0) slDown(e, el); }, true);
  stage.addEventListener('wheel', (e) => { const el = e.target.closest?.('.pl-sl'); if (el) slWheel(e, el); }, { passive: false });
}

// ---------- 事件 ----------
export function scanClick(e) {
  const S = H.S;
  if (!S.scan) return false;
  const t = e.target;
  let x;
  if ((x = t.closest('[data-ds-scan]'))) { dscan(); return true; }
  if ((x = t.closest('[data-ds-unit]'))) { S.scan.d.unit = S.scan.d.unit === 'AU' ? 'km' : 'AU'; renderDscan(); return true; }
  if ((x = t.closest('[data-ps-form]'))) { formation(x.dataset.psForm); renderProbe(true); return true; }
  if ((x = t.closest('[data-ps-center]'))) { const p = S.scan.p; if (p.probes.length) { p.center = S.me.pos.slice(); place(); } return true; }
  if ((x = t.closest('[data-ps-recover]'))) { recover(); return true; }
  if ((x = t.closest('[data-ps-go]'))) { analyze(); return true; }
  if ((x = t.closest('[data-ps-warp]'))) { warpSig(x.dataset.psWarp, e); return true; }
  // 结果行 / 星系图上的结果标记：选中（星系图上那个结果变亮红）
  if ((x = t.closest('[data-ps-k], [data-sm-res]'))) { const p = S.scan.p, id = x.dataset.psK || x.dataset.smRes; p.sel = p.sel === id ? null : id; renderProbe(true); return true; }
  if ((x = t.closest('[data-sm-view]'))) { const v = x.dataset.smView; if (MAP) { if (v === 'me') MAP.m.focusMe(); else MAP.m.view(v); } return true; }
  if ((x = t.closest('[data-ds-k]'))) { const k = x.dataset.dsK; if (k[0] === 'u') H.pick(Number(k.slice(1)), e); else H.pickCel(Number(k.slice(1)), e); return true; }
  return false;
}
export function scanInput(e) {
  const S = H.S, t = e.target;
  if (!S.scan) return false;
  return false;
}
export function scanChange(e) {
  const t = e.target, S = H.S;
  if (!S.scan || !t.matches?.('[data-ds-range]')) return false;
  const v = Number(String(t.value).replace(/,/g, ''));
  if (Number.isFinite(v) && v > 0) setRange(S.scan.d.unit === 'AU' ? v * AU_KM() : v);
  else renderDscan();
  return true;
}
export function scanCtx(e) {
  const x = e.target.closest?.('[data-ds-k], [data-ps-k], [data-sm-res]');
  if (!x || !H.S.scan) return false;
  e.preventDefault();
  let items = [];
  if (x.dataset.dsK) {
    const k = x.dataset.dsK, i = Number(k.slice(1));
    if (k[0] === 'u') items = H.unitMenu(H.S.b.units[i]);
    else items = [[`跃迁至 0 m内`, () => H.warpTo({ cel: i }, 0)]];
  } else {
    const id = x.dataset.psK || x.dataset.smRes, p = H.S.scan.p;
    if (p.res.get(id)?.s >= 1) items.push(['跃迁至', () => warpSig(id)]);
    items.push(['清除结果', () => { p.res.delete(id); renderProbe(true); }], ['清除其他结果', () => { for (const k of [...p.res.keys()]) if (k !== id) p.res.delete(k); renderProbe(true); }]);
  }
  if (items.length) H.menu(items, e);
  return true;
}
// 快捷键：Alt + D 定向扫描器、V 扫描、Alt + P 探针扫描器、B 分析（客户端默认键位）
export function scanKey(e, k) {
  if (!H.S.scan) return false;
  if (e.altKey && k === 'd') { e.preventDefault(); H.openWin('dscan'); return true; }
  if (e.altKey && k === 'p') { e.preventDefault(); H.openWin('probe'); return true; }
  // V（客户端 CmdRefreshDirectionalScan）：定向扫描器没开 → 打开；开着 → 按住 V 点击物体朝它扫描（ScanTowardsItem），
  // 按住期间没点东西就松开 → 按镜头方向扫（OnCmdDirectionalScanUnload）
  if (!e.altKey && !e.ctrlKey && !e.metaKey && k === 'v') {
    const w = H.root()?.querySelector('[data-win="dscan"]');
    if (!w || w.hidden) { H.openWin('dscan', true); return true; }
    H.S.keys.add('v');
    H.S.scan.vHold = { done: false };
    return true;
  }
  if (!e.altKey && !e.ctrlKey && !e.metaKey && k === 'b') { analyze(); return true; }
  return false;
}
export function scanKeyUp(k) {
  const S = H.S;
  if (k !== 'v' || !S.scan?.vHold) return;
  const h = S.scan.vHold;
  S.scan.vHold = null;
  if (!h.done) dscan();
}
// 按住 V 点击物体：朝它扫描（正在扫 / 冷却中就不扫）；镜头保持原来的视角不动
export function scanToward(pos, track) {
  const S = H.S, d = S.scan?.d;
  if (!d || !S.me) return false;
  if (S.scan.vHold) S.scan.vHold.done = true;
  if (performance.now() < d.cool) return true;
  const v = sub(pos, S.me.pos), l = len(v);
  if (!l) return true;
  dscan(v.map((x) => x / l));
  track?.();
  return true;
}
// 装备栏里点探针发射器：没发射就按精确式阵型发射（客户端激活发射器 = 发射探针），并打开探针扫描器
export function rackLaunch(m) {
  const S = H.S, x = S.on?.rack?.[m];
  if (!S.scan || !x || H.data().types.get(x.type)?.group !== LAUNCHER_GROUP) return false;
  if (!S.scan.p.probes.length) formation('pin');
  H.openWin('probe', true);
  renderProbe(true);
  return true;
}
// 练习：放信号（{ id, group, name, f, pos }）
export function setSigs(list) { H.S.scan.p.sigs = list.map((x) => ({ ...x })); H.S.scan.p.res = new Map(); }
export const scanState = () => H.S.scan;
