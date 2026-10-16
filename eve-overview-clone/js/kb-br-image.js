// ===== 战场统计：生成分享图片 =====
// 纯 Canvas 绘制（不依赖第三方库），固定深色主题，宽 1200（按 2 倍像素输出）。
// 势力 logo 与舰船图标来自 images.evetech.net（允许跨域），加载失败时画占位色块。
const W = 1200, PAD = 48, SCALE = 2;
const C = {
  bg: '#0b0f17', panel: '#121a27', panel2: '#172133', line: '#253047', text: '#e6edf7', sub: '#9aa8bd', muted: '#6b7a90',
  a: '#4f8ff7', b: '#f0524f'
};

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    // 加参数区分缓存：避免复用页面里不带跨域头的缓存导致画布被污染
    img.src = url + (url.includes('?') ? '&' : '?') + 'cors=1';
    setTimeout(() => resolve(null), 6000);
  });
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// 超出宽度时截断并加省略号
function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

function font(weight, size, family) {
  return `${weight} ${size}px ${family}`;
}

export async function renderBrImage(m) {
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  // 预加载图片
  const urls = new Set();
  for (const s of ['A', 'B']) {
    m.sides[s].parties.forEach((p) => urls.add(p.logo));
    m.sides[s].top.forEach((k) => urls.add(k.icon));
  }
  const images = new Map(await Promise.all([...urls].map(async (u) => [u, await loadImage(u)])));

  const rows = Math.max(m.sides.A.parties.length, m.sides.B.parties.length, 1);
  const tops = Math.max(m.sides.A.top.length, m.sides.B.top.length);
  const H = 150 + 250 + 64 + m.cmps.length * 40 + 30 + 250 + 40 + 56 + rows * 46 + (tops ? 56 + tops * 46 : 0) + 30 + 64;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const g = canvas.getContext('2d');
  g.scale(SCALE, SCALE);
  g.textBaseline = 'alphabetic';

  // 背景：深色底 + 左蓝右红的光晕
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const glow = (x, color) => {
    const gr = g.createRadialGradient(x, 260, 0, x, 260, 520);
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, 800);
  };
  glow(0, 'rgba(79,143,247,0.22)');
  glow(W, 'rgba(240,82,79,0.22)');

  // ---------- 标题 ----------
  let y = PAD + 6;
  g.fillStyle = C.muted;
  g.font = font(600, 15, family);
  g.fillText('战场统计 · BATTLE REPORT', PAD, y);
  y += 40;
  g.fillStyle = C.text;
  g.font = font(800, 34, family);
  g.fillText(fit(g, m.title, W - PAD * 2), PAD, y);
  y += 32;
  g.fillStyle = C.sub;
  g.font = font(400, 16, family);
  g.fillText(fit(g, m.subtitle, W - PAD * 2), PAD, y);
  y += 32;

  // ---------- 损失比 ----------
  const top = y;
  rr(g, PAD, top, W - PAD * 2, 236, 18);
  g.fillStyle = 'rgba(18,26,39,0.86)';
  g.fill();
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.stroke();
  const side = (s, align) => {
    const st = m.sides[s], color = s === 'A' ? C.a : C.b;
    const x = align === 'left' ? PAD + 28 : W - PAD - 28;
    g.textAlign = align;
    // 徽章 + 名称
    const bx = align === 'left' ? x : x - 26;
    rr(g, bx, top + 26, 26, 26, 7);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#fff';
    g.font = font(800, 15, family);
    g.textAlign = 'center';
    g.fillText(s, bx + 13, top + 45);
    g.textAlign = align;
    g.fillStyle = color;
    g.font = font(800, 20, family);
    const nx = align === 'left' ? x + 36 : x - 36;
    g.fillText(`${s} 方`, nx, top + 46);
    g.fillStyle = C.muted;
    g.font = font(400, 14, family);
    g.fillText(`${st.parties.length ? st.partyCount : 0} 个势力 · ${st.pilots} 人`, align === 'left' ? nx + 50 : nx - 50, top + 46);
    g.fillStyle = color;
    g.font = font(800, 52, family);
    g.fillText(st.lostText, x, top + 112);
    g.fillStyle = C.muted;
    g.font = font(400, 14, family);
    g.fillText('ISK 损失', x, top + 136);
  };
  side('A', 'left');
  side('B', 'right');
  // 中间：损失比
  g.textAlign = 'center';
  g.fillStyle = C.muted;
  g.font = font(500, 14, family);
  g.fillText('损 失 比', W / 2, top + 40);
  if (m.ratio) {
    g.font = font(800, 72, family);
    const aw = g.measureText(m.ratio[0]).width, bw = g.measureText(m.ratio[1]).width;
    g.font = font(400, 48, family);
    const cw = g.measureText(':').width + 24;
    const sx = W / 2 - (aw + cw + bw) / 2;
    g.textAlign = 'left';
    g.font = font(800, 72, family);
    g.fillStyle = C.a;
    g.fillText(m.ratio[0], sx, top + 112);
    g.fillStyle = C.muted;
    g.font = font(400, 48, family);
    g.fillText(':', sx + aw + 12, top + 104);
    g.font = font(800, 72, family);
    g.fillStyle = C.b;
    g.fillText(m.ratio[1], sx + aw + cw, top + 112);
  } else {
    g.font = font(800, 64, family);
    g.fillStyle = C.sub;
    g.fillText('—', W / 2, top + 110);
  }
  // 胜负判断
  g.textAlign = 'center';
  g.font = font(700, 16, family);
  const vw = g.measureText(m.verdict).width + 32;
  const vc = m.winner === 'A' ? C.a : m.winner === 'B' ? C.b : C.sub;
  rr(g, W / 2 - vw / 2, top + 126, vw, 30, 15);
  g.fillStyle = m.winner ? vc + '2e' : 'rgba(255,255,255,0.08)';
  g.fill();
  g.fillStyle = vc;
  g.fillText(m.verdict, W / 2, top + 147);
  // ISK 占比条
  const bx = PAD + 28, bw2 = W - PAD * 2 - 56, by = top + 172;
  const aw2 = Math.max(0, Math.min(bw2 - 3, (bw2 - 3) * m.shareA));
  rr(g, bx, by, aw2, 34, [9, 0, 0, 9]);
  let lg = g.createLinearGradient(bx, 0, bx + aw2, 0);
  lg.addColorStop(0, '#2f5fb3'); lg.addColorStop(1, C.a);
  g.fillStyle = lg;
  g.fill();
  rr(g, bx + aw2 + 3, by, bw2 - aw2 - 3, 34, [0, 9, 9, 0]);
  lg = g.createLinearGradient(bx + aw2, 0, bx + bw2, 0);
  lg.addColorStop(0, C.b); lg.addColorStop(1, '#a7302e');
  g.fillStyle = lg;
  g.fill();
  g.fillStyle = '#fff';
  g.font = font(800, 16, family);
  g.textAlign = 'left';
  if (m.shareA > 0.08) g.fillText(m.shareAText, bx + 14, by + 23);
  g.textAlign = 'right';
  if (m.shareA < 0.92) g.fillText(m.shareBText, bx + bw2 - 14, by + 23);
  y = top + 236 + 28;
  g.textAlign = 'left';
  g.fillStyle = C.muted;
  g.font = font(400, 14, family);
  g.fillText('ISK 损失占比', PAD + 4, y - 8);
  if (m.eff) { g.textAlign = 'right'; g.fillText(m.eff, W - PAD - 4, y - 8); }
  y += 14;

  // ---------- 分项对比 ----------
  for (const c of m.cmps) {
    const cx = PAD + 130, cw = W - PAD * 2 - 260;
    g.textAlign = 'center';
    g.fillStyle = C.muted;
    g.font = font(400, 13, family);
    g.fillText(c.label, W / 2, y + 6);
    const t = c.a + c.b, wa = t ? cw * c.a / t : cw / 2;
    rr(g, cx, y + 14, Math.max(0, wa - 1.5), 10, [5, 0, 0, 5]);
    g.fillStyle = C.a + 'cc';
    g.fill();
    rr(g, cx + wa + 1.5, y + 14, Math.max(0, cw - wa - 1.5), 10, [0, 5, 5, 0]);
    g.fillStyle = C.b + 'cc';
    g.fill();
    g.font = font(700, 18, family);
    g.textAlign = 'right';
    g.fillStyle = C.a;
    g.fillText(c.aText, cx - 16, y + 26);
    g.textAlign = 'left';
    g.fillStyle = C.b;
    g.fillText(c.bText, cx + cw + 16, y + 26);
    y += 40;
  }
  y += 30;

  // ---------- 战况走势 ----------
  const ch = { x: PAD, y, w: W - PAD * 2, h: 230 };
  rr(g, ch.x, ch.y, ch.w, ch.h, 16);
  g.fillStyle = C.panel;
  g.fill();
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.font = font(700, 16, family);
  g.fillText('战况走势 · 累计 ISK 损失', ch.x + 20, ch.y + 30);
  const L = ch.x + 20, R = ch.x + ch.w - 20, T = ch.y + 50, B = ch.y + ch.h - 34;
  const { t0, t1, A: sa, B: sb, max } = m.series;
  const px = (t) => L + (t - t0) / (t1 - t0) * (R - L);
  const py = (v) => B - v / (max * 1.08) * (B - T);
  g.strokeStyle = C.line;
  g.setLineDash([3, 5]);
  for (let i = 1; i <= 3; i++) { g.beginPath(); g.moveTo(L, B - (B - T) * i / 3.24); g.lineTo(R, B - (B - T) * i / 3.24); g.stroke(); }
  g.setLineDash([]);
  g.beginPath(); g.moveTo(L, B); g.lineTo(R, B); g.stroke();
  // 阶梯线路径
  const stepPath = (pts) => {
    g.beginPath();
    pts.forEach(([t, v], i) => { if (!i) g.moveTo(px(t), py(v)); else { g.lineTo(px(t), py(pts[i - 1][1])); g.lineTo(px(t), py(v)); } });
    g.lineTo(R, py(pts[pts.length - 1][1]));
  };
  for (const [pts, color] of [[sa, C.a], [sb, C.b]]) {
    // 面积
    stepPath(pts);
    g.lineTo(R, B); g.lineTo(L, B); g.closePath();
    const ag = g.createLinearGradient(0, T, 0, B);
    ag.addColorStop(0, color + '55'); ag.addColorStop(1, color + '00');
    g.fillStyle = ag;
    g.fill();
    stepPath(pts);
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.stroke();
    g.lineWidth = 1;
  }
  g.fillStyle = C.muted;
  g.font = font(400, 12, family);
  g.textAlign = 'left';
  g.fillText(m.series.labels[0], L, B + 22);
  g.textAlign = 'center';
  g.fillText(m.series.labels[1], (L + R) / 2, B + 22);
  g.textAlign = 'right';
  g.fillText(m.series.labels[2], R, B + 22);
  g.textAlign = 'right';
  g.font = font(600, 13, family);
  g.fillStyle = C.a;
  g.fillText(`A 方 ${m.sides.A.lostText}`, R - 120, ch.y + 30);
  g.fillStyle = C.b;
  g.fillText(`B 方 ${m.sides.B.lostText}`, R, ch.y + 30);
  y = ch.y + ch.h + 40;

  // ---------- 双方势力与最贵损失 ----------
  const colW = (W - PAD * 2 - 24) / 2;
  let endY = y;
  const column = (s, x) => {
    const st = m.sides[s], color = s === 'A' ? C.a : C.b;
    let cy = y;
    g.textAlign = 'left';
    rr(g, x, cy - 18, 22, 22, 6);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#fff';
    g.font = font(800, 13, family);
    g.textAlign = 'center';
    g.fillText(s, x + 11, cy - 2);
    g.textAlign = 'left';
    g.fillStyle = color;
    g.font = font(700, 17, family);
    g.fillText(`${s} 方 · 主要势力`, x + 32, cy);
    cy += 22;
    for (const p of st.parties) {
      const img = images.get(p.logo);
      rr(g, x, cy, 34, 34, 7);
      g.save(); g.clip();
      if (img) g.drawImage(img, x, cy, 34, 34); else { g.fillStyle = C.panel2; g.fillRect(x, cy, 34, 34); }
      g.restore();
      g.fillStyle = C.text;
      g.font = font(600, 15, family);
      g.fillText(fit(g, p.name, colW - 200), x + 46, cy + 15);
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText(`${p.pilots} 人 · 参与击杀 ${p.kills}`, x + 46, cy + 31);
      g.textAlign = 'right';
      g.fillStyle = p.lost ? '#f3a0a0' : C.muted;
      g.font = font(600, 14, family);
      g.fillText(p.lost ? `-${p.lostText}` : '无损失', x + colW, cy + 22);
      g.textAlign = 'left';
      cy += 46;
    }
    if (st.more) {
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText(`另有 ${st.more} 个势力`, x + 46, cy + 10);
    }
    cy = y + 22 + rows * 46 + 34;
    if (tops) {
      g.fillStyle = C.sub;
      g.font = font(600, 14, family);
      g.fillText('最贵损失', x, cy);
      cy += 16;
      for (const k of st.top) {
        const img = images.get(k.icon);
        rr(g, x, cy, 34, 34, 6);
        g.save(); g.clip();
        if (img) g.drawImage(img, x, cy, 34, 34); else { g.fillStyle = C.panel2; g.fillRect(x, cy, 34, 34); }
        g.restore();
        g.fillStyle = C.text;
        g.font = font(600, 15, family);
        g.fillText(fit(g, k.ship, colW - 190), x + 46, cy + 15);
        g.fillStyle = C.muted;
        g.font = font(400, 12, family);
        g.fillText(fit(g, k.pilot, colW - 190), x + 46, cy + 31);
        g.textAlign = 'right';
        g.fillStyle = C.text;
        g.font = font(700, 15, family);
        g.fillText(k.value, x + colW, cy + 22);
        g.textAlign = 'left';
        cy += 46;
      }
    }
    endY = Math.max(endY, cy);
  };
  column('A', PAD);
  column('B', PAD + colW + 24);

  // ---------- 页脚 ----------
  const fy = endY + 20;
  g.fillStyle = C.line;
  g.fillRect(PAD, fy, W - PAD * 2, 1);
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.font = font(800, 18, family);
  g.fillText('EVE Market', PAD, fy + 34);
  g.fillStyle = C.muted;
  g.font = font(400, 14, family);
  g.fillText(m.footer, PAD + 112, fy + 34);
  g.textAlign = 'right';
  g.fillText(m.generated, W - PAD, fy + 34);
  // 按实际内容高度裁剪
  const out = document.createElement('canvas');
  const h = Math.min(H, Math.ceil(fy + 60));
  out.width = W * SCALE;
  out.height = h * SCALE;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}
