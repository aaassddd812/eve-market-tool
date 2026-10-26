// ===== 击杀记录页的统计图表（SVG）=====
// 与战场统计「战况走势」同一套样式（.kb-br-plot / .kb-br-tip）：虚线网格、渐变柱、悬停十字线与提示框，容器宽度变化时重画。
// - hoursChart：最近 24 小时每小时损失（柱 = ISK，折线 = 击毁次数）
// - monthsChart：zKillboard 最近 12 个月击杀 / 损失（舰船数或 ISK 切换）
// - heatChart：活跃时段（星期 × 小时热力图，顶部为各小时合计、右侧为各天合计；UTC / 本地时间切换）
let app;   // esc, formatISK, formatNumber
export function initKbCharts(context) { app = context; }

const ro = window.ResizeObserver ? new ResizeObserver((entries) => {
  for (const e of entries) {
    const el = e.target, w = Math.round(e.contentRect.width);
    if (w && w !== el._w) { el._w = w; if (el.isConnected) el._draw?.(); else ro.unobserve(el); }
  }
}) : null;

function mount(plot, draw) {
  if (!plot) return;
  plot._draw = () => draw(plot);
  plot._draw();
  ro?.observe(plot);
}

// 4 格左右的整齐刻度：返回 { step, max }
function nice(v, n = 4, integer = false) {
  const raw = Math.max(v, integer ? 1 : 1e-9) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { step, max: step * Math.ceil(v / step || 1) };
}

function setSvg(plot, W, H, html) {
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = html;
  return svg;
}

// 悬停：.hit 接收鼠标（触屏点按也行），at(px, py) 返回 { x, html, mark? }；mark 为高亮框 { x, y, w, h }
function bindHover(plot, svg, box, at) {
  const tip = plot.querySelector('.kb-br-tip');
  const cross = svg.querySelector('.cross'), mark = svg.querySelector('.hl');
  const hit = svg.querySelector('.hit');
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const h = at(e.clientX - r.left, e.clientY - r.top);
    if (!h) { hide(); return; }
    if (cross) { cross.setAttribute('x1', h.x); cross.setAttribute('x2', h.x); cross.setAttribute('visibility', 'visible'); }
    if (mark && h.mark) { for (const k of ['x', 'y']) mark.setAttribute(k, h.mark[k]); mark.setAttribute('width', h.mark.w); mark.setAttribute('height', h.mark.h); mark.setAttribute('visibility', 'visible'); }
    tip.innerHTML = h.html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(box.W - tw - 4, Math.max(4, h.x + 14 + tw > box.W ? h.x - tw - 14 : h.x + 14)) + 'px';
    tip.style.top = (h.top ?? box.T + 4) + 'px';
  };
  const hide = () => { tip.hidden = true; cross?.setAttribute('visibility', 'hidden'); mark?.setAttribute('visibility', 'hidden'); };
  hit.onpointermove = show;
  hit.onpointerdown = show;
  hit.onpointerleave = hide;
}

const plotBox = () => '<div class="kb-br-plot"><svg></svg><div class="kb-br-tip" hidden></div></div>';

// ---------- 最近 24 小时每小时损失 ----------
// buckets：[{ hour(ms), count, value }]
// 接口的 hour 是每段开始时间（ISO 字符串，从 24 小时前起每小时一段）
const withTime = (buckets) => buckets.map((b) => ({ ...b, t: typeof b.hour === 'number' ? b.hour : Date.parse(b.hour) }));
export function hoursChart(list) {
  const buckets = withTime(list);
  const peak = buckets.reduce((m, b) => (b.value > m.value ? b : m), buckets[0] || { value: 0 });
  return `<div class="kb-chart kb-hours" data-kb-chart="hours">
    <div class="kb-br-chart-head">
      <h4>每小时损失<small>最近 24 小时</small></h4>
      <div class="kb-br-legend"><span class="isk"><i></i>损失 ISK</span><span class="cnt"><i></i>击毁次数</span></div>
      ${peak?.value ? `<span class="kb-chart-note">峰值 <b>${app.formatISK(peak.value)}</b> ISK · ${hh(peak.t)}</span>` : ''}
    </div>
    ${plotBox()}
  </div>`;
}
const hh = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function drawHours(root, list) {
  const buckets = withTime(list);
  const plot = root?.querySelector('[data-kb-chart="hours"] .kb-br-plot');
  mount(plot, () => {
    const W = Math.max(260, plot.clientWidth), H = W < 600 ? 150 : 170;
    const L = 50, R = 34, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
    const n = buckets.length || 1;
    const vy = nice(Math.max(...buckets.map((b) => b.value), 1));
    const cy = nice(Math.max(...buckets.map((b) => b.count), 1), 4, true);
    const slot = iw / n, bw = Math.max(2, slot - (slot > 10 ? 4 : 1.5));
    const x = (i) => L + i * slot + (slot - bw) / 2;
    const yv = (v) => T + ih - v / vy.max * ih;
    const yc = (c) => T + ih - c / cy.max * ih;
    let g = '<defs><linearGradient id="kbHrG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--sell-color)" stop-opacity=".95"/><stop offset="1" stop-color="var(--sell-color)" stop-opacity=".45"/></linearGradient></defs>';
    for (let v = 0; v <= vy.max + 1e-6; v += vy.step) {
      g += `<line class="grid${v ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${yv(v)}" y2="${yv(v)}"/><text class="ax" x="${L - 8}" y="${yv(v) + 4}" text-anchor="end">${v ? app.formatISK(v) : '0'}</text>`;
    }
    for (let c = cy.step; c <= cy.max; c += cy.step) g += `<text class="ax cnt" x="${L + iw + 6}" y="${yc(c) + 4}">${c}</text>`;
    // 整点刻度（每 3 或 6 小时）
    const every = slot < 22 ? 6 : 3, t0 = buckets[0]?.t || 0, span = n * 3600e3;
    for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t0 + span; t += 3600e3) {
      if (new Date(t).getHours() % every) continue;
      const tx = L + (t - t0) / span * iw;
      g += `<line class="grid" x1="${tx}" x2="${tx}" y1="${T}" y2="${T + ih}"/><text class="ax" x="${tx}" y="${H - 7}" text-anchor="middle">${hh(t)}</text>`;
    }
    g += buckets.map((b, i) => (b.value ? `<rect class="bar isk" x="${x(i).toFixed(1)}" y="${yv(b.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - yv(b.value)).toFixed(1)}" rx="2"/>` : '')).join('');
    const pts = buckets.map((b, i) => `${(L + i * slot + slot / 2).toFixed(1)},${yc(b.count).toFixed(1)}`);
    g += `<polyline class="ln cnt" points="${pts.join(' ')}"/>` + buckets.map((b, i) => `<circle class="dot cnt" cx="${(L + i * slot + slot / 2).toFixed(1)}" cy="${yc(b.count).toFixed(1)}" r="2.5"/>`).join('');
    const svg = setSvg(plot, W, H, `<rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>${g}<line class="cross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>`);
    bindHover(plot, svg, { W, T }, (px) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor((px - L) / slot)));
      const b = buckets[i];
      if (!b) return null;
      return { x: L + i * slot + slot / 2, html: `<b>${hh(b.t)} – ${hh(b.t + 3600e3)}</b><span class="isk">损失 ${app.formatISK(b.value)} ISK</span><span class="cnt">击毁 ${app.formatNumber(b.count)} 次</span>` };
    });
  });
}

// ---------- 月度统计 ----------
const MONTH_KEY = 'eve-kb-month-mode';
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => (window.I18N?.lang === 'en' ? EN_MONTHS[m.month - 1] : m.month + ' 月');
let monthMode = (() => { try { return localStorage.getItem(MONTH_KEY) === 'isk' ? 'isk' : 'ships'; } catch { return 'ships'; } })();

export function monthsChart(months) {
  const sum = (k) => months.reduce((s, m) => s + (m[k] || 0), 0);
  const kd = sum('iskDestroyed'), kl = sum('iskLost');
  return `<div class="kb-chart kb-months-chart" data-kb-chart="months">
    <div class="kb-br-chart-head">
      <div class="kb-br-legend"><span class="k"><i></i>击杀 <b>${app.formatNumber(sum('shipsDestroyed'))}</b> 艘</span><span class="l"><i></i>损失 <b>${app.formatNumber(sum('shipsLost'))}</b> 艘</span>${kd + kl ? `<span>ISK 效率 <b>${(kd / (kd + kl) * 100).toFixed(1)}%</b></span>` : ''}</div>
      <div class="segmented" role="group" aria-label="纵轴">
        <button type="button" data-kb-month-mode="ships" class="${monthMode === 'ships' ? 'active' : ''}">舰船数</button>
        <button type="button" data-kb-month-mode="isk" class="${monthMode === 'isk' ? 'active' : ''}">ISK</button>
      </div>
    </div>
    ${plotBox()}
  </div>`;
}

export function drawMonths(root, months) {
  const box = root?.querySelector('[data-kb-chart="months"]');
  if (!box) return;
  const plot = box.querySelector('.kb-br-plot');
  box.querySelector('.segmented').onclick = (e) => {
    const b = e.target.closest('[data-kb-month-mode]');
    if (!b) return;
    monthMode = b.dataset.kbMonthMode;
    try { localStorage.setItem(MONTH_KEY, monthMode); } catch { /* 不记住 */ }
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    plot._draw();
  };
  mount(plot, () => {
    const isk = monthMode === 'isk';
    const kk = isk ? 'iskDestroyed' : 'shipsDestroyed', lk = isk ? 'iskLost' : 'shipsLost';
    const fmt = isk ? app.formatISK : app.formatNumber;
    const W = Math.max(260, plot.clientWidth), H = W < 600 ? 170 : 200;
    const L = 52, R = 10, T = 12, B = 26, iw = W - L - R, ih = H - T - B;
    const n = months.length || 1;
    const y = nice(Math.max(...months.map((m) => Math.max(m[kk] || 0, m[lk] || 0)), 1), 4, !isk);
    const yv = (v) => T + ih - v / y.max * ih;
    const slot = iw / n, gap = slot > 30 ? 3 : 1.5;
    const bw = Math.max(2, Math.min(18, (slot - 10) / 2));
    const cx = (i) => L + i * slot + slot / 2;
    let g = `<defs>
      <linearGradient id="kbMoK" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--success)" stop-opacity=".95"/><stop offset="1" stop-color="var(--success)" stop-opacity=".5"/></linearGradient>
      <linearGradient id="kbMoL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--danger)" stop-opacity=".95"/><stop offset="1" stop-color="var(--danger)" stop-opacity=".5"/></linearGradient></defs>`;
    for (let v = 0; v <= y.max + 1e-6; v += y.step) g += `<line class="grid${v ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${yv(v)}" y2="${yv(v)}"/><text class="ax" x="${L - 8}" y="${yv(v) + 4}" text-anchor="end">${v ? fmt(v) : '0'}</text>`;
    months.forEach((m, i) => {
      const k = m[kk] || 0, l = m[lk] || 0;
      if (k) g += `<rect class="bar k" x="${(cx(i) - bw - gap / 2).toFixed(1)}" y="${yv(k).toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - yv(k)).toFixed(1)}" rx="2"/>`;
      if (l) g += `<rect class="bar l" x="${(cx(i) + gap / 2).toFixed(1)}" y="${yv(l).toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - yv(l)).toFixed(1)}" rx="2"/>`;
      if (slot >= 26 || i % 2 === (n - 1) % 2) g += `<text class="ax" x="${cx(i)}" y="${H - 8}" text-anchor="middle">${monthLabel(m)}</text>`;
      if (m.month === 1 && i) g += `<line class="grid year" x1="${L + i * slot}" x2="${L + i * slot}" y1="${T}" y2="${T + ih}"/><text class="ax yr" x="${L + i * slot + 4}" y="${T + 10}">${m.year}</text>`;
    });
    const svg = setSvg(plot, W, H, `<rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/><rect class="hl col" visibility="hidden" rx="4"/>${g}`);
    bindHover(plot, svg, { W, T }, (px) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor((px - L) / slot)));
      const m = months[i];
      if (!m) return null;
      const kd = m.iskDestroyed || 0, kl = m.iskLost || 0;
      return { x: cx(i) + slot / 2 - 6, mark: { x: L + i * slot + 1, y: T, w: slot - 2, h: ih },
        html: `<b>${m.year} 年 ${m.month} 月</b><span class="k">击杀 ${app.formatNumber(m.shipsDestroyed || 0)} 艘 · ${app.formatISK(kd)} ISK</span><span class="l">损失 ${app.formatNumber(m.shipsLost || 0)} 艘 · ${app.formatISK(kl)} ISK</span>${kd + kl ? `<small>ISK 效率 ${(kd / (kd + kl) * 100).toFixed(1)}%</small>` : ''}` };
    });
  });
}

// ---------- 活跃时段 ----------
// act：{ max, 0: [24 个小时的次数], ... 6 }（星期日 = 0，UTC）
const HEAT_KEY = 'eve-kb-heat-tz';
const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const OFFSET = Math.round(-new Date().getTimezoneOffset() / 60);
const OFFSET_LABEL = `UTC${OFFSET >= 0 ? '+' : ''}${OFFSET}`;
let heatTz = (() => { try { return localStorage.getItem(HEAT_KEY) === 'utc' ? 'utc' : 'local'; } catch { return 'local'; } })();

export function heatChart() {
  return `<div class="kb-chart kb-heat-chart" data-kb-chart="heat">
    <div class="kb-br-chart-head">
      <div class="kb-br-legend kb-heat-legend"><span>较少</span><span class="kb-heat-scale">${[0.12, 0.3, 0.5, 0.75, 1].map((o) => `<i style="opacity:${o}"></i>`).join('')}</span><span>较多</span><span class="kb-chart-note" data-kb-heat-peak></span></div>
      ${OFFSET ? `<div class="segmented" role="group" aria-label="时区">
        <button type="button" data-kb-heat-tz="local" class="${heatTz === 'local' ? 'active' : ''}">本地 ${OFFSET_LABEL}</button>
        <button type="button" data-kb-heat-tz="utc" class="${heatTz === 'utc' ? 'active' : ''}">UTC</button>
      </div>` : ''}
    </div>
    ${plotBox()}
  </div>`;
}

export function drawHeat(root, act) {
  const box = root?.querySelector('[data-kb-chart="heat"]');
  if (!box) return;
  const plot = box.querySelector('.kb-br-plot');
  const seg = box.querySelector('.segmented');
  if (seg) seg.onclick = (e) => {
    const b = e.target.closest('[data-kb-heat-tz]');
    if (!b) return;
    heatTz = b.dataset.kbHeatTz;
    try { localStorage.setItem(HEAT_KEY, heatTz); } catch { /* 不记住 */ }
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    plot._draw();
  };
  mount(plot, () => {
    const off = heatTz === 'local' ? OFFSET : 0;
    // 按所选时区重新排：小时右移 off，跨天时星期跟着变
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const t = h + off, dd = (d + Math.floor(t / 24) + 7) % 7, hl = ((t % 24) + 24) % 24;
      grid[dd][hl] += act[d]?.[h] || 0;
    }
    // 周一开头
    const order = [1, 2, 3, 4, 5, 6, 0];
    const max = Math.max(1, ...grid.flat());
    // 颜色按最少到最多拉开（活跃度比较平均的势力也能看出高峰）
    const nz = grid.flat().filter((v) => v > 0), min = nz.length ? Math.min(...nz) : 0;
    const level = (v) => (v ? 0.16 + 0.84 * (max > min ? (v - min) / (max - min) : 1) : 0.06);
    const hourTot = Array.from({ length: 24 }, (_, h) => grid.reduce((s, r) => s + r[h], 0));
    const dayTot = grid.map((r) => r.reduce((a, b) => a + b, 0));
    const maxH = Math.max(1, ...hourTot), maxD = Math.max(1, ...dayTot);
    const W = Math.max(300, plot.clientWidth);
    const L = 38, R = W < 500 ? 44 : 70, TOP = 30, B = 22;
    const iw = W - L - R, cw = iw / 24, ch = Math.max(14, Math.min(26, cw * 0.82));
    const T = TOP + 6, ih = ch * 7, H = T + ih + B;
    const pad = cw > 14 ? 2 : 1;
    let g = '';
    // 顶部：各小时合计
    hourTot.forEach((v, h) => { const hgt = v / maxH * (TOP - 6); if (v) g += `<rect class="bar tot" x="${(L + h * cw + pad / 2).toFixed(1)}" y="${(TOP - hgt).toFixed(1)}" width="${(cw - pad).toFixed(1)}" height="${hgt.toFixed(1)}" rx="1.5"/>`; });
    order.forEach((d, r) => {
      const y = T + r * ch;
      g += `<text class="ax" x="${L - 8}" y="${y + ch / 2 + 4}" text-anchor="end">${DAYS[d]}</text>`;
      for (let h = 0; h < 24; h++) {
        const v = grid[d][h];
        g += `<rect class="cell" x="${(L + h * cw + pad / 2).toFixed(1)}" y="${(y + pad / 2).toFixed(1)}" width="${(cw - pad).toFixed(1)}" height="${(ch - pad).toFixed(1)}" rx="3" fill-opacity="${level(v).toFixed(3)}"/>`;
      }
      const dw = dayTot[d] / maxD * (R - (W < 500 ? 14 : 34));
      g += `<rect class="bar tot" x="${L + iw + 6}" y="${(y + ch * 0.25).toFixed(1)}" width="${dw.toFixed(1)}" height="${(ch * 0.5).toFixed(1)}" rx="2"/>`;
      if (W >= 500) g += `<text class="ax" x="${L + iw + 10 + dw}" y="${y + ch / 2 + 4}">${app.formatNumber(dayTot[d])}</text>`;
    });
    for (let h = 0; h < 24; h += cw < 16 ? 6 : 3) g += `<text class="ax" x="${L + h * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, '0')}</text>`;
    const svg = setSvg(plot, W, H, `<rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>${g}<rect class="hl cell-hl" visibility="hidden" rx="3"/>`);
    const peakH = hourTot.indexOf(maxH), peakD = dayTot.indexOf(maxD);
    const note = box.querySelector('[data-kb-heat-peak]');
    if (note) note.innerHTML = `<span>最活跃</span> <b>${DAYS[peakD]}</b> <b>${String(peakH).padStart(2, '0')}:00</b>`;
    bindHover(plot, svg, { W, T }, (px, py) => {
      const h = Math.floor((px - L) / cw), r = Math.floor((py - T) / ch);
      if (h < 0 || h > 23 || r < 0 || r > 6) return null;
      const d = order[r], v = grid[d][h];
      const tz = off ? OFFSET_LABEL : 'UTC';
      return { x: L + h * cw + cw / 2, top: Math.max(0, T + r * ch - 54), mark: { x: L + h * cw, y: T + r * ch, w: cw, h: ch },
        html: `<b><span>${DAYS[d]}</span> ${String(h).padStart(2, '0')}:00 – ${String((h + 1) % 24).padStart(2, '0')}:00</b><span>${app.formatNumber(v)} 次 <small>· ${tz}</small></span>` };
    });
  });
}
