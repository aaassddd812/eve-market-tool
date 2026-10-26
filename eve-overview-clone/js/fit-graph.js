// ===== 伤害图表（仿 Pyfa 的 Graphs）=====
// 有效 DPS 随「距离 / 目标速度 / 目标信号半径」变化的曲线：炮台按跟踪与失准、导弹按爆炸半径与爆炸速度、无人机按信号与速度（fit-engine.js appliedDps）。
// 目标可选典型体型、自定义，或我保存的某套装配（取它的信号半径、最大速度，伤害再乘它主坦那一层的抗性）；
// 可给目标加网子 / 标记（按叠加惩罚）；当前装配之外可再选最多 3 套我的装配同图对比。
let ctx;   // data, FE, getFit, getStats, savedFits, normalize, skills, esc, formatNumber, store
const $ = (id) => document.getElementById(id);
const KEY = 'eve-fit-graph-v1';
const XS = [['dist', '距离'], ['vel', '目标速度'], ['sig', '目标信号半径']];
const WEB = -0.6, PAINT = 0.375;   // T2 网子 −60%、T2 标记 +37.5%（技能满级）
const COLORS = ['--br-a', '--buy-color', '--warning', '--br-b'];
const PENALTY = (i) => Math.exp(-((i / 2.67) ** 2));

const G = {
  x: 'dist', target: 'cruiser', sig: 140, vel: 230, dist: 10, webs: 0, paints: 0, resist: true,
  compare: []       // 我的装配 id
};

export function initGraph(context) {
  ctx = context;
  try { Object.assign(G, ctx.store.getJSON(KEY, {})); } catch { /* 默认 */ }
}

function save() {
  ctx.store.setJSON(KEY, G);
}

export function openGraph() {
  let modal = $('fitGraphModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitGraphModal';
    modal.className = 'modal sim-modal';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `<div class="modal-backdrop"></div><div class="modal-content sim-content graph-content">
      <div class="modal-header"><h3>伤害图表</h3><button class="modal-close" data-gr-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="grBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onClick);
    modal.addEventListener('change', onChange);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
    window.addEventListener('resize', () => { if (!modal.hidden) draw(); });
  }
  modal.hidden = false;
  document.body.classList.add('modal-open');
  render();
}

function close() {
  $('fitGraphModal').hidden = true;
  document.body.classList.remove('modal-open');
}

// ---------- 数据 ----------
function series() {
  const { FE, data } = ctx;
  const out = [];
  const cur = ctx.getFit();
  if (cur && ctx.getStats()) out.push({ name: '当前：' + (cur.name || data.types.get(cur.ship)?.name || ''), stats: ctx.getStats() });
  for (const id of G.compare) {
    const f = ctx.savedFits().find((x) => String(x.id) === String(id));
    if (!f) continue;
    const calc = FE.computeFit(data, ctx.normalize(f), ctx.skills());
    if (calc) out.push({ name: (f.name || '未命名') + ' · ' + (data.types.get(f.ship)?.name || ''), stats: FE.fitStats(calc) });
  }
  return out.slice(0, 4).map((s, i) => ({ ...s, color: COLORS[i] }));
}

// 目标：{ sig, vel, res: [4] | null, label }
function targetInfo() {
  const { FE, data } = ctx;
  if (G.target.startsWith('fit:')) {
    const f = ctx.savedFits().find((x) => 'fit:' + x.id === G.target);
    const calc = f && FE.computeFit(data, ctx.normalize(f), ctx.skills());
    if (calc) {
      const st = FE.fitStats(calc);
      const d = st.defense;
      const layers = [['护盾', d.shield, FE.RESIST.shield], ['装甲', d.armor, FE.RESIST.armor], ['结构', d.hull, FE.RESIST.hull]];
      const tank = layers.reduce((a, b) => (b[1].ehp > a[1].ehp ? b : a));
      return { sig: st.navigation.signature, vel: st.navigation.velocity, res: tank[2].map((a) => calc.ship.attr(a)), layer: tank[0], label: f.name || data.types.get(f.ship)?.name };
    }
  }
  if (G.target === 'custom') return { sig: G.sig, vel: G.vel, res: null };
  const t = FE.TARGETS[G.target] || FE.TARGETS.cruiser;
  return { sig: t.sig, vel: t.vel, res: null };
}

function stack(base, n, v, sortDesc) {
  let m = 1;
  for (let i = 0; i < n; i++) m *= 1 + v * PENALTY(i);
  return base * m;
}

// 某条曲线在 x 处的有效 DPS
function valueAt(s, tgt, x) {
  const { FE } = ctx;
  let sig = stack(tgt.sig, G.paints, PAINT), vel = stack(tgt.vel, G.webs, WEB), dist = G.dist * 1000;
  if (G.x === 'dist') dist = Math.max(1, x * 1000);
  else if (G.x === 'vel') vel = stack(x, G.webs, WEB);
  else sig = stack(x, G.paints, PAINT);
  let dps = FE.appliedDps(s.stats, { sig, vel }, dist);
  if (tgt.res && G.resist && s.stats.weapon.total) {
    const w = s.stats.weapon.types;
    dps *= w.reduce((t, x2, k) => t + x2 * tgt.res[k], 0) / s.stats.weapon.total;
  }
  return dps;
}

function xRange(list) {
  if (G.x === 'vel') return [0, 3000, 'm/s'];
  if (G.x === 'sig') return [10, 1000, 'm'];
  let far = 10000;
  for (const s of list) {
    for (const w of s.stats.weapons) far = Math.max(far, w.range + 2 * (w.falloff || 0));
    for (const d of s.stats.droneDps || []) far = Math.max(far, (d.drone.attr(ctx.FE.AT.maxRange) || 0) + 2 * (d.drone.attr(ctx.FE.AT.falloff) || 0));
  }
  return [0, Math.min(300, Math.ceil(far * 1.15 / 5000) * 5), 'km'];
}

// ---------- 界面 ----------
function render() {
  const saved = ctx.savedFits();
  const { FE } = ctx;
  const seg = (key, items) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-gr-set="${key}" data-v="${v}" class="${String(G[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const tgt = targetInfo();
  const fitName = (f) => ctx.esc((f.name || '未命名') + ' · ' + (ctx.data.types.get(f.ship)?.name || ''));
  $('grBody').innerHTML = `
    <div class="sim-opts gr-opts">
      <div class="sim-opt"><span>横轴</span>${seg('x', XS)}</div>
      <label class="sim-opt"><span>目标舰船</span><select class="pi-input" data-gr-target>
        ${Object.entries(FE.TARGETS).map(([k, t]) => `<option value="${k}"${G.target === k ? ' selected' : ''}>${ctx.esc(t.name)}（${t.sig} m · ${t.vel} m/s）</option>`).join('')}
        <option value="custom"${G.target === 'custom' ? ' selected' : ''}>自定义</option>
        ${saved.length ? `<optgroup label="我的装配">${saved.map((f) => `<option value="fit:${f.id}"${G.target === 'fit:' + f.id ? ' selected' : ''}>${fitName(f)}</option>`).join('')}</optgroup>` : ''}
      </select></label>
      ${G.target === 'custom' ? `
        <label class="sim-opt"><span>信号半径</span><input type="number" class="pi-input gr-num" min="1" max="100000" value="${G.sig}" data-gr-num="sig"><small>m</small></label>
        <label class="sim-opt"><span>速度</span><input type="number" class="pi-input gr-num" min="0" max="20000" value="${G.vel}" data-gr-num="vel"><small>m/s</small></label>` : ''}
      ${G.x !== 'dist' ? `<label class="sim-opt"><span>距离</span><input type="number" class="pi-input gr-num" min="0" max="300" step="1" value="${G.dist}" data-gr-num="dist"><small>km</small></label>` : ''}
      <label class="sim-opt"><span>网子</span><select class="pi-input" data-gr-num="webs">${[0, 1, 2, 3].map((n) => `<option value="${n}"${G.webs === n ? ' selected' : ''}>${n ? n + ' 个' : '无'}</option>`).join('')}</select></label>
      <label class="sim-opt"><span>标记</span><select class="pi-input" data-gr-num="paints">${[0, 1, 2, 3].map((n) => `<option value="${n}"${G.paints === n ? ' selected' : ''}>${n ? n + ' 个' : '无'}</option>`).join('')}</select></label>
      ${tgt.res ? `<label class="pi-check"><input type="checkbox" data-gr-resist${G.resist ? ' checked' : ''}><span>计入目标${tgt.layer}抗性</span></label>` : ''}
    </div>
    <div class="gr-compare">
      <span>对比</span>
      ${G.compare.map((id) => { const f = saved.find((x) => String(x.id) === String(id)); return f ? `<span class="ka-chip on">${fitName(f)}<button type="button" data-gr-uncompare="${id}" aria-label="移除">×</button></span>` : ''; }).join('')}
      ${G.compare.length < 3 && saved.length ? `<select class="plain-select" data-gr-compare><option value="">+ 加入我的装配…</option>${saved.filter((f) => !G.compare.includes(String(f.id))).map((f) => `<option value="${f.id}">${fitName(f)}</option>`).join('')}</select>` : saved.length ? '' : '<small class="text-muted">保存装配后可以加进来对比</small>'}
    </div>
    <div class="kb-br-plot gr-plot" id="grPlot"><svg></svg><div class="kb-br-tip" id="grTip" hidden></div></div>
    <div class="gr-legend" id="grLegend"></div>
    <p class="fit-hint">纵轴为对目标的有效 DPS（含命中与伤害比例${tgt.res && G.resist ? '，并乘目标抗性' : ''}）；网子按 T2 −60%、标记按 T2 +37.5%，多个时有叠加惩罚。
      横轴为距离时目标速度按全部为横向速度计算；导弹超过飞行距离为 0，舰载机按满伤害。</p>`;
  draw();
}

// 与战场统计「战况走势」同样式：SVG 折线 + 渐变面积 + 虚线网格 + 十字准线提示
function draw() {
  const plot = $('grPlot');
  if (!plot) return;
  const list = series();
  const tgt = targetInfo();
  const [x0, x1, unit] = xRange(list);
  const N = 160;
  const pts = list.map((s) => Array.from({ length: N + 1 }, (_, i) => { const x = x0 + (x1 - x0) * i / N; return [x, valueAt(s, tgt, x)]; }));
  const top = Math.max(10, ...pts.flat().map((p) => p[1]));
  const ys = niceNum(top * 1.08 / 4);
  const max = ys * 4;
  const W = Math.max(280, plot.clientWidth), H = W < 600 ? 220 : 300;
  const L = 50, R = 16, T = 12, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const X = (x) => L + (x - x0) / (x1 - x0) * iw;
  const Y = (v) => T + ih - v / max * ih;
  let grid = '';
  for (let i = 0; i <= 4; i++) grid += `<line class="grid${i ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${Y(ys * i)}" y2="${Y(ys * i)}"/><text class="ax" x="${L - 8}" y="${Y(ys * i) + 4}" text-anchor="end">${ctx.formatNumber(ys * i)}</text>`;
  const xs = niceNum((x1 - x0) / Math.max(3, Math.floor(iw / 90)));
  for (let x = Math.ceil(x0 / xs) * xs; x <= x1 + 1e-9; x += xs) {
    if (x > x0) grid += `<line class="grid" x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${T + ih}"/>`;
    if (X(x) < L + iw - 34) grid += `<text class="ax" x="${X(x)}" y="${H - 8}" text-anchor="middle">${ctx.formatNumber(Math.round(x * 10) / 10)}</text>`;
  }
  grid += `<text class="ax" x="${L + iw}" y="${H - 8}" text-anchor="end">${unit}</text>`;
  const path = (p) => p.map(([x, v], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const defs = list.map((s, k) => `<linearGradient id="grG${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(${s.color})" stop-opacity="${list.length > 1 ? 0.14 : 0.22}"/><stop offset="1" stop-color="var(${s.color})" stop-opacity="0"/></linearGradient>`).join('');
  const body = list.map((s, k) => `<path d="${path(pts[k])}V${Y(0)}H${X(x0)}Z" fill="url(#grG${k})"/>`).join('')
    + list.map((s, k) => `<path class="ln" style="stroke:var(${s.color})" d="${path(pts[k])}"/>`).join('');
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = `<defs>${defs}</defs><rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>${grid}${body}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>${list.map((s, k) => `<circle class="gr-dot" r="4" style="fill:var(${s.color})" data-k="${k}" visibility="hidden"/>`).join('')}`;
  const tip = $('grTip'), cross = svg.querySelector('.cross'), hit = svg.querySelector('.hit');
  const show = (clientX) => {
    if (!list.length) return;
    const r = svg.getBoundingClientRect();
    const px = Math.min(L + iw, Math.max(L, (clientX - r.left) * W / r.width));
    const x = x0 + (px - L) / iw * (x1 - x0);
    const vals = list.map((s) => valueAt(s, tgt, x));
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    svg.querySelectorAll('.gr-dot').forEach((d) => { d.setAttribute('cx', px); d.setAttribute('cy', Y(vals[d.dataset.k])); d.setAttribute('visibility', 'visible'); });
    tip.innerHTML = `<b>${ctx.formatNumber(Math.round(x * 10) / 10)} ${unit}</b>${vals.map((v, k) => `<span><i style="background:var(${list[k].color})"></i>${v.toFixed(1)} DPS</span>`).join('')}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(W - tw - 4, Math.max(4, px + 12 + tw > W ? px - tw - 12 : px + 12)) + 'px';
    tip.style.top = T + 4 + 'px';
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); svg.querySelectorAll('.gr-dot').forEach((d) => d.setAttribute('visibility', 'hidden')); };
  hit.onmousemove = (e) => show(e.clientX);
  hit.onmouseleave = hide;
  hit.ontouchstart = hit.ontouchmove = (e) => show(e.touches[0].clientX);
  $('grLegend').innerHTML = list.length ? list.map((s, k) => {
    const peak = Math.max(...pts[k].map((p) => p[1]));
    return `<span><i style="background:var(${s.color})"></i>${ctx.esc(s.name)} <small>纸面 ${s.stats.weapon.total.toFixed(0)} · 最高 ${peak.toFixed(0)} DPS</small></span>`;
  }).join('') : '<span class="text-muted">先在装配页装好一艘船</span>';
}

// 1 / 2 / 2.5 / 5 × 10ⁿ 的整齐刻度
function niceNum(v) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((x) => x >= v);
}

function onClick(e) {
  if (e.target.closest('[data-gr-close]') || e.target.classList.contains('modal-backdrop')) { close(); return; }
  const set = e.target.closest('[data-gr-set]');
  if (set) { G[set.dataset.grSet] = set.dataset.v; save(); render(); return; }
  const un = e.target.closest('[data-gr-uncompare]');
  if (un) { G.compare = G.compare.filter((id) => id !== un.dataset.grUncompare); save(); render(); }
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-gr-target]')) G.target = t.value;
  else if (t.matches('[data-gr-compare]')) { if (t.value) G.compare.push(String(t.value)); }
  else if (t.matches('[data-gr-resist]')) G.resist = t.checked;
  else if (t.dataset.grNum) G[t.dataset.grNum] = Math.max(0, Number(t.value) || 0);
  else return;
  save();
  render();
}
