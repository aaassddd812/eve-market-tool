// ===== 战场统计：生成分享图片 =====
// 纯 Canvas 绘制（不依赖第三方库）；配色、图片加载与弹窗在 share-image.js。
import { W, SCALE, THEMES, loadImages, rr, fit, font, alpha, siteMark, qrMark, qrSize } from './share-image.js?v=11';

const PAD = 40, IW = W - PAD * 2, GAP = 20;

export async function renderBrImage(m, theme = 'light') {
  const C = THEMES[theme] || THEMES.light;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  // 预加载图片
  const order = m.order;          // ['A', 'B'] 或三方、四方
  const multi = order.length > 2;
  const urls = new Set();
  for (const s of order) {
    m.sides[s].parties.forEach((p) => urls.add(p.logo));
    m.sides[s].top.forEach((k) => urls.add(k.icon));
    m.sides[s].players.list.forEach((p) => { urls.add(p.avatar); urls.add(p.corp?.logo); urls.add(p.alliance?.logo); p.ships.forEach((u) => urls.add(u)); });
  }
  const images = await loadImages([...urls]);
  const EXTRA = theme === 'dark' ? { C: '#22a565', D: '#a25ddc' } : { C: '#1c9a5c', D: '#8e4fd0' };
  const color = (s) => (s === 'A' ? C.a : s === 'B' ? C.b : EXTRA[s]);

  // 势力 / 玩家卡片：两方、三方都放一行并排（三方时卡片窄，玩家卡片省掉伤害与舰船两栏），四方分两行；同一行等高
  const pairs = [];
  const per = order.length === 3 ? 3 : 2;
  for (let i = 0; i < order.length; i += per) {
    const pr = order.slice(i, i + per), sd = pr.map((x) => m.sides[x]);
    const rows = Math.max(...sd.map((x) => x.parties.length), 1);
    const more = sd.some((x) => x.more);
    const tops = Math.max(...sd.map((x) => x.top.length));
    const prow = Math.max(...sd.map((x) => x.players.list.length));
    const pmore = sd.some((x) => x.players.more);
    pairs.push({ sides: pr, rows, more, tops, colW: (IW - GAP * (per - 1)) / per,
      SIDE: 72 + rows * 50 + (more ? 22 : 0) + (tops ? 58 + tops * 46 : 0) + 12,
      PLAY: prow ? 70 + prow * 40 + (pmore ? 30 : 0) + 12 : 0 });
  }
  const HERO = 292, TILE = multi ? 0 : 100, CHART = 300;
  const H = Math.max(200, PAD + qrSize(m.url) + 32) + HERO + GAP + (TILE ? TILE + GAP : 0) + CHART + pairs.reduce((t, q) => t + GAP + q.SIDE + (q.PLAY ? GAP + q.PLAY : 0), 0) + 180;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const g = canvas.getContext('2d');
  g.scale(SCALE, SCALE);
  g.textBaseline = 'alphabetic';

  // 背景：底色 + 左上蓝、右上红的光晕
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const glow = (x, c) => {
    const gr = g.createRadialGradient(x, 120, 0, x, 120, 560);
    gr.addColorStop(0, alpha(c, C.glow));
    gr.addColorStop(1, alpha(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, W, 700);
  };
  glow(0, C.a);
  glow(W, C.b);

  const card = (x, y, w, h, r = 20) => {
    rr(g, x, y, w, h, r);
    g.fillStyle = C.panel;
    g.fill();
  };
  // 方块徽章（A / B）
  const badge = (s, x, y, size) => {
    rr(g, x, y, size, size, size * 0.28);
    g.fillStyle = color(s);
    g.fill();
    g.fillStyle = '#fff';
    g.font = font(800, Math.round(size * 0.56), family);
    g.textAlign = 'center';
    g.fillText(s, x + size / 2, y + size * 0.72);
  };
  // 圆角图片，加载失败画占位色块
  const pic = (img, x, y, size, r) => {
    rr(g, x, y, size, size, r);
    g.save();
    g.clip();
    if (img) g.drawImage(img, x, y, size, size); else { g.fillStyle = C.panel2; g.fillRect(x, y, size, size); }
    g.restore();
  };
  // 圆角胶囊标签，返回宽度
  const chip = (text, x, y, opts = {}) => {
    g.font = font(opts.weight || 500, opts.size || 14, family);
    const w = g.measureText(text).width + 28;
    rr(g, x, y, w, opts.h || 30, (opts.h || 30) / 2);
    g.fillStyle = opts.bg || C.panel;
    g.fill();
    g.fillStyle = opts.fg || C.sub;
    g.textAlign = 'left';
    g.fillText(text, x + 14, y + (opts.h || 30) / 2 + (opts.size || 14) * 0.36);
    return w;
  };

  // ---------- 标题 ----------
  let y = PAD;
  chip('战场统计 · BATTLE REPORT', PAD, y, { bg: alpha(C.a, 0.14), fg: C.a, weight: 700, size: 13, h: 28 });
  // 右上角二维码（扫码打开本站这份战场统计）；标题与标签让开它和左边的说明文字
  const qr = qrMark(g, C, m.url, W - PAD, y, family);
  if (!qr) {
    g.textAlign = 'right';
    g.fillStyle = C.text;
    g.font = font(800, 18, family);
    g.fillText('EVE Market', W - PAD, y + 20);
  }
  const headR = qr ? W - PAD - qr - 120 : W - PAD;
  const qrBottom = y + qr;
  y += 28 + 50;
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.font = font(800, 38, family);
  g.fillText(fit(g, m.title, headR - PAD), PAD, y);
  y += 20;
  // 时间、击杀数等：一行放不下就换行
  let cx = PAD;
  for (const t of m.meta) {
    g.font = font(500, 14, family);
    const w = g.measureText(t).width + 28;
    if (cx > PAD && cx + w > headR) { cx = PAD; y += 38; }
    cx += chip(t, cx, y) + 8;
  }
  y = Math.max(y + 30 + 32, qrBottom + 32);

  // ---------- 损失比（三方及以上：每方一格） ----------
  const top = y;
  card(PAD, top, IW, HERO, 24);
  if (multi) drawMulti(); else drawPair();
  y = top + HERO + GAP;
  function drawMulti() {
    const n = order.length, gx = 14, cw = (IW - 48 - gx * (n - 1)) / n;
    order.forEach((s, i) => {
      const st = m.sides[s], c = color(s), x = PAD + 24 + i * (cw + gx), cy = top + 24;
      rr(g, x, cy, cw, 162, 18);
      g.fillStyle = alpha(c, C.tint * 1.3);
      g.fill();
      badge(s, x + 18, cy + 18, 28);
      g.textAlign = 'left';
      g.fillStyle = c;
      g.font = font(800, 20, family);
      g.fillText(`${s} 方`, x + 56, cy + 39);
      g.fillStyle = C.muted;
      g.font = font(400, 13, family);
      g.fillText(fit(g, `${st.partyCount} 个势力 · ${st.pilots} 人`, cw - 36), x + 18, cy + 70);
      g.fillStyle = c;
      g.font = font(800, n > 3 ? 32 : 38, family);
      g.fillText(fit(g, st.lostText, cw - 36), x + 18, cy + 112);
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText('ISK 损失', x + 18, cy + 130);
      g.fillStyle = C.sub;
      g.font = font(600, 13, family);
      g.fillText(fit(g, `击毁 ${st.destroyedText} · 效率 ${st.effText}`, cw - 36), x + 18, cy + 151);
    });
    // 各方 ISK 损失占比
    const bx = PAD + 24, bw = IW - 48, by = top + 206;
    const shown = order.filter((s) => m.sides[s].share > 0);
    let x = bx;
    const avail = bw - 4 * Math.max(0, shown.length - 1);
    shown.forEach((s, i) => {
      const w = avail * m.sides[s].share;
      const r = shown.length === 1 ? 16 : i === 0 ? [16, 4, 4, 16] : i === shown.length - 1 ? [4, 16, 16, 4] : 4;
      rr(g, x, by, w, 32, r);
      g.fillStyle = color(s);
      g.fill();
      if (w > 70) {
        g.fillStyle = '#fff';
        g.font = font(800, 15, family);
        g.textAlign = 'center';
        g.fillText(m.sides[s].shareText, x + w / 2, by + 21);
      }
      x += w + 4;
    });
    g.fillStyle = C.muted;
    g.font = font(400, 13, family);
    g.textAlign = 'left';
    g.fillText('ISK 损失占比', bx, by + 56);
  }
  function drawPair() {
    // 左右两侧淡淡的阵营色
    g.save();
    rr(g, PAD, top, IW, HERO, 24);
    g.clip();
    const tint = g.createLinearGradient(PAD, 0, W - PAD, 0);
    tint.addColorStop(0, alpha(C.a, C.tint));
    tint.addColorStop(0.42, alpha(C.a, 0));
    tint.addColorStop(0.58, alpha(C.b, 0));
    tint.addColorStop(1, alpha(C.b, C.tint));
    g.fillStyle = tint;
    g.fillRect(PAD, top, IW, HERO);
    g.restore();
    const side = (s, align) => {
      const st = m.sides[s], c = color(s), left = align === 'left';
      const x = left ? PAD + 32 : W - PAD - 32;
      badge(s, left ? x : x - 30, top + 30, 30);
      g.textAlign = align;
      g.fillStyle = c;
      g.font = font(800, 22, family);
      g.fillText(`${s} 方`, left ? x + 42 : x - 42, top + 53);
      g.fillStyle = C.muted;
      g.font = font(400, 14, family);
      g.fillText(`${st.parties.length ? st.partyCount : 0} 个势力 · ${st.pilots} 人`, x, top + 88);
      g.fillStyle = c;
      g.font = font(800, 50, family);
      g.fillText(st.lostText, x, top + 146);
      g.fillStyle = C.muted;
      g.font = font(400, 14, family);
      g.fillText('ISK 损失', x, top + 170);
    };
    side('A', 'left');
    side('B', 'right');
    // 中间：损失比
    g.textAlign = 'center';
    g.fillStyle = C.muted;
    g.font = font(600, 14, family);
    g.fillText('损失比', W / 2, top + 50);
    if (m.ratio) {
      g.font = font(800, 72, family);
      const aw = g.measureText(m.ratio[0]).width, bw = g.measureText(m.ratio[1]).width;
      const cw = 40;
      const sx = W / 2 - (aw + cw + bw) / 2;
      g.textAlign = 'left';
      g.fillStyle = C.a;
      g.fillText(m.ratio[0], sx, top + 126);
      g.fillStyle = C.b;
      g.fillText(m.ratio[1], sx + aw + cw, top + 126);
      g.fillStyle = C.muted;
      g.font = font(400, 48, family);
      g.textAlign = 'center';
      g.fillText(':', sx + aw + cw / 2, top + 118);
    } else {
      g.font = font(800, 64, family);
      g.fillStyle = C.sub;
      g.fillText('—', W / 2, top + 122);
    }
    // 胜负判断
    g.textAlign = 'center';
    g.font = font(700, 15, family);
    const vw = Math.min(460, g.measureText(m.verdict).width + 36);
    const vc = m.winner ? color(m.winner) : C.sub;
    rr(g, W / 2 - vw / 2, top + 144, vw, 32, 16);
    g.fillStyle = m.winner ? alpha(vc, 0.14) : C.panel2;
    g.fill();
    g.fillStyle = vc;
    g.fillText(fit(g, m.verdict, vw - 24), W / 2, top + 165);
    // ISK 占比条
    const bx = PAD + 32, bw2 = IW - 64, by = top + 206;
    const aw2 = Math.max(0, Math.min(bw2 - 4, (bw2 - 4) * m.shareA));
    const bar = (x, w, c1, c2, r) => {
      if (w <= 0) return;
      rr(g, x, by, w, 32, r);
      const lg = g.createLinearGradient(x, 0, x + w, 0);
      lg.addColorStop(0, c1); lg.addColorStop(1, c2);
      g.fillStyle = lg;
      g.fill();
    };
    bar(bx, aw2, C.aDeep, C.a, [16, 4, 4, 16]);
    bar(bx + aw2 + 4, bw2 - aw2 - 4, C.b, C.bDeep, [4, 16, 16, 4]);
    g.fillStyle = '#fff';
    g.font = font(800, 15, family);
    g.textAlign = 'left';
    if (m.shareA > 0.08) g.fillText(m.shareAText, bx + 16, by + 21);
    g.textAlign = 'right';
    if (m.shareA < 0.92) g.fillText(m.shareBText, bx + bw2 - 16, by + 21);
    g.fillStyle = C.muted;
    g.font = font(400, 13, family);
    g.textAlign = 'left';
    g.fillText('ISK 损失占比', bx, by + 56);
    if (m.eff) { g.textAlign = 'right'; g.fillText(m.eff, bx + bw2, by + 56); }
  }

  // ---------- 分项对比：一排小卡片（只有两方时） ----------
  const n = m.cmps.length, tw = (IW - 16 * (n - 1)) / n;
  m.cmps.forEach((c, i) => {
    const tx = PAD + i * (tw + 16);
    card(tx, y, tw, TILE, 18);
    g.textAlign = 'center';
    g.fillStyle = C.muted;
    g.font = font(500, 13, family);
    g.fillText(c.label, tx + tw / 2, y + 28);
    g.font = font(800, 22, family);
    g.textAlign = 'left';
    g.fillStyle = C.a;
    g.fillText(fit(g, c.aText, tw / 2 - 26), tx + 20, y + 62);
    g.textAlign = 'right';
    g.fillStyle = C.b;
    g.fillText(fit(g, c.bText, tw / 2 - 26), tx + tw - 20, y + 62);
    const t = c.a + c.b, lw = tw - 40, wa = t ? lw * c.a / t : lw / 2;
    rr(g, tx + 20, y + 76, Math.max(0, wa - 2), 8, [4, 0, 0, 4]);
    g.fillStyle = C.a;
    g.fill();
    rr(g, tx + 20 + wa + 2, y + 76, Math.max(0, lw - wa - 2), 8, [0, 4, 4, 0]);
    g.fillStyle = C.b;
    g.fill();
  });
  if (TILE) y += TILE + GAP;

  // ---------- 战况走势 ----------
  const ch = { x: PAD, y, w: IW, h: CHART };
  card(ch.x, ch.y, ch.w, ch.h);
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.font = font(700, 17, family);
  g.fillText('战况走势 · 累计 ISK 损失', ch.x + 24, ch.y + 36);
  // 图例
  let lx = ch.x + ch.w - 24;
  for (const s of [...order].reverse()) {
    const t = `${s} 方 ${m.sides[s].lostText}`;
    g.font = font(600, 13, family);
    const w = g.measureText(t).width + 40;
    lx -= w;
    rr(g, lx, ch.y + 16, w, 28, 14);
    g.fillStyle = alpha(color(s), 0.12);
    g.fill();
    rr(g, lx + 12, ch.y + 26, 8, 8, 4);
    g.fillStyle = color(s);
    g.fill();
    g.fillText(t, lx + 28, ch.y + 35);
    lx -= 8;
  }
  const { t0, t1, lines, axis } = m.series;
  g.font = font(400, 12, family);
  const L = ch.x + 24 + Math.max(...m.series.ticks.map((k) => g.measureText(k.label).width)) + 12;
  const R = ch.x + ch.w - 28, T = ch.y + 74, B = ch.y + ch.h - 44;
  const px = (t) => L + (t - t0) / Math.max(1, t1 - t0) * (R - L);
  const py = (v) => B - v / axis.max * (B - T);
  // 纵轴：整数刻度 + 浅色横线
  g.lineWidth = 1;
  for (const k of m.series.ticks) {
    g.strokeStyle = k.v ? C.line : C.muted;
    g.globalAlpha = k.v ? 1 : 0.5;
    g.beginPath(); g.moveTo(L, py(k.v)); g.lineTo(R, py(k.v)); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = C.muted;
    g.textAlign = 'right';
    g.fillText(k.label, L - 12, py(k.v) + 4);
  }
  // 折线：连接每次损失后的累计值，最后延伸到结束时间
  const linePath = (pts) => {
    g.beginPath();
    pts.forEach(([t, v], i) => (i ? g.lineTo(px(t), py(v)) : g.moveTo(px(t), py(v))));
    g.lineTo(R, py(pts[pts.length - 1][1]));
  };
  for (const { s: ls, pts } of lines) {
    const c = color(ls);
    if (!pts.length) continue;
    linePath(pts);
    g.lineTo(R, B); g.lineTo(L, B); g.closePath();
    const ag = g.createLinearGradient(0, T, 0, B);
    ag.addColorStop(0, alpha(c, 0.18)); ag.addColorStop(0.75, alpha(c, 0));
    g.fillStyle = ag;
    g.fill();
  }
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const { s: ls, pts } of lines) {
    const c = color(ls);
    if (!pts.length) continue;
    linePath(pts);
    g.strokeStyle = c;
    g.lineWidth = 3;
    g.stroke();
  }
  // 最贵的几次损失：空心圆圈
  for (const [t, v, , s] of m.series.marks) {
    g.beginPath();
    g.arc(px(t), py(v), 5, 0, Math.PI * 2);
    g.fillStyle = C.panel;
    g.fill();
    g.strokeStyle = color(s);
    g.lineWidth = 2.5;
    g.stroke();
  }
  // 末端：圆点 + 累计值，标在线上方；从最低的一条开始，和下面的标签靠得太近就再往上挪
  const ends = lines.map(({ s: ls, pts }) => { const v = pts.length ? pts[pts.length - 1][1] : 0; return { s: ls, v, y: py(v) }; }).sort((p, q) => p.v - q.v);
  let prevY = Infinity;
  for (const e of ends) {
    const ty = Math.min(e.y - 12, prevY - 20);
    prevY = ty;
    g.beginPath();
    g.arc(R, e.y, 5.5, 0, Math.PI * 2);
    g.fillStyle = color(e.s);
    g.fill();
    g.strokeStyle = C.panel;
    g.lineWidth = 2.5;
    g.stroke();
    g.font = font(800, 14, family);
    g.textAlign = 'right';
    g.lineWidth = 5;
    g.strokeStyle = C.panel;
    g.strokeText(m.sides[e.s].lostText, R - 12, ty);
    g.fillStyle = color(e.s);
    g.fillText(m.sides[e.s].lostText, R - 12, ty);
  }
  g.lineWidth = 1;
  g.lineCap = 'butt';
  // 横轴时间
  g.fillStyle = C.muted;
  g.font = font(400, 12, family);
  m.series.labels.forEach((l, i, all) => {
    g.textAlign = i === 0 ? 'left' : i === all.length - 1 ? 'right' : 'center';
    g.fillText(l, L + (R - L) * i / (all.length - 1), B + 24);
  });
  y += CHART;

  // ---------- 各方势力与最贵损失 ----------
  // 卡片标题：徽章 + 标题，右侧可选小字
  const head = (s, x, cy, title, right) => {
    badge(s, x, cy - 19, 24);
    g.textAlign = 'left';
    g.fillStyle = C.text;
    g.font = font(700, 17, family);
    g.fillText(title, x + 34, cy);
    if (right) { g.textAlign = 'right'; g.fillStyle = C.muted; g.font = font(400, 12, family); right(); }
  };
  const column = (s, x0, { SIDE, rows, more, tops, colW }) => {
    const st = m.sides[s], x = x0 + 24, w = colW - 48, narrow = colW < 500;
    const textW = w - (narrow ? 130 : 190);
    card(x0, y, colW, SIDE);
    // 顶部一条淡淡的阵营色
    g.save();
    rr(g, x0, y, colW, SIDE, 20);
    g.clip();
    const tg = g.createLinearGradient(0, y, 0, y + 90);
    tg.addColorStop(0, alpha(color(s), C.tint * 1.4));
    tg.addColorStop(1, alpha(color(s), 0));
    g.fillStyle = tg;
    g.fillRect(x0, y, colW, 90);
    g.restore();
    let cy = y + 40;
    head(s, x, cy, `${s} 方 · 主要势力`);
    cy += 22;
    for (const p of st.parties) {
      pic(images.get(p.logo), x, cy, 38, 9);
      g.textAlign = 'left';
      g.fillStyle = C.text;
      g.font = font(600, 15, family);
      g.fillText(fit(g, p.name, textW), x + 50, cy + 17);
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText(fit(g, narrow ? `${p.pilots} 人 · 击杀 ${p.kills}` : `${p.pilots} 人 · 参与击杀 ${p.kills}`, textW), x + 50, cy + 34);
      g.textAlign = 'right';
      g.fillStyle = p.lost ? C.loss : C.muted;
      g.font = font(p.lost ? 700 : 500, 14, family);
      g.fillText(fit(g, p.lost ? `-${p.lostText}` : '无损失', narrow ? 76 : 140), x + w, cy + 24);
      cy += 50;
    }
    if (st.more) {
      g.textAlign = 'left';
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText(`另有 ${st.more} 个势力`, x + 50, cy + 8);
    }
    if (tops) {
      cy = y + 62 + rows * 50 + (more ? 22 : 0) + 14;
      g.fillStyle = C.line;
      g.fillRect(x, cy, w, 1);
      cy += 32;
      g.textAlign = 'left';
      g.fillStyle = C.sub;
      g.font = font(700, 14, family);
      g.fillText('最贵损失', x, cy);
      cy += 14;
      for (const k of st.top) {
        pic(images.get(k.icon), x, cy, 36, 8);
        g.textAlign = 'left';
        g.fillStyle = C.text;
        g.font = font(600, 14.5, family);
        g.fillText(fit(g, k.ship, w - (narrow ? 165 : 200)), x + 48, cy + 16);
        g.fillStyle = C.muted;
        g.font = font(400, 12, family);
        g.fillText(fit(g, k.pilot, w - (narrow ? 165 : 200)), x + 48, cy + 32);
        g.textAlign = 'right';
        g.fillStyle = C.text;
        g.font = font(700, 15, family);
        g.fillText(k.value, x + w, cy + 23);
        cy += 46;
      }
    }
  };
  // ---------- 参战玩家：头像、所属、舰船、参与击杀 / 损失 ----------
  const players = (s, x0, { PLAY, colW }) => {
    const st = m.sides[s].players, x = x0 + 20, w = colW - 40, narrow = colW < 500;
    const LOSS = narrow ? 92 : 110;   // 损失栏宽
    card(x0, y, colW, PLAY);
    let cy = y + 40;
    head(s, x, cy, `${s} 方 · 参战玩家`, () => {
      g.fillText('损失', x + w - 8, cy);
      g.fillText('击杀', x + w - 8 - LOSS, cy);
      if (!narrow) g.fillText('伤害', x + w - 166, cy);
    });
    cy += 18;
    st.list.forEach((p, i) => {
      // 隔行底色
      if (i % 2 === 0) { rr(g, x - 8, cy, w + 16, 40, 10); g.fillStyle = C.panel2; g.fill(); }
      pic(images.get(p.avatar), x, cy + 5, 30, 15);
      let rx = x + w - 8;
      g.textAlign = 'right';
      g.font = font(600, 13, family);
      g.fillStyle = p.losses ? C.loss : C.muted;
      g.fillText(fit(g, p.losses ? (p.lostText ? `${p.losses} · -${p.lostText}` : String(p.losses)) : '—', LOSS - 10), rx, cy + 25);
      rx -= LOSS;   // 损失、击杀、伤害三栏固定宽度，各行的数字和舰船图标对齐
      g.fillStyle = p.kills ? C.text : C.muted;
      g.font = font(700, 14, family);
      g.fillText(p.kills ? String(p.kills) : '—', rx, cy + 25);
      rx -= 48;
      // 三方并排时卡片窄：只留最常用的一艘舰船，不画伤害
      if (!narrow) {
        g.fillStyle = p.dmgText ? C.sub : C.muted;
        g.font = font(600, 13, family);
        g.fillText(p.dmgText || '—', rx, cy + 25);
        rx -= 82;
      } else rx += 8;
      const ships = narrow ? p.ships.slice(0, 1) : p.ships;
      for (let j = ships.length - 1; j >= 0; j--) {
        rx -= 24;
        pic(images.get(ships[j]), rx, cy + 8, 24, 6);
        rx -= 4;
      }
      g.textAlign = 'left';
      const nw = rx - (x + 42) - 10;
      g.fillStyle = C.text;
      g.font = font(600, 14, family);
      g.fillText(fit(g, p.name, nw), x + 42, cy + 18);
      // 所属：军团图标 + 名字 · 联盟图标 + 名字；放不下两个名字时军团只画图标，名字留给联盟；旧数据没有时只写势力名
      g.fillStyle = C.muted;
      g.font = font(400, 11.5, family);
      const orgs = [p.corp, p.alliance].filter(Boolean);
      if (!orgs.length) g.fillText(fit(g, p.party, nw), x + 42, cy + 33);
      else {
        const ICON = 13, GAPX = 8;
        const full = orgs.reduce((t, o) => t + ICON + 4 + g.measureText(o.name).width, 0) + GAPX * (orgs.length - 1);
        let ox = x + 42;
        orgs.forEach((o, j) => {
          pic(images.get(o.logo), ox, cy + 23, ICON, 3);
          const iconOnly = full > nw && orgs.length > 1 && j === 0;
          if (iconOnly) { ox += ICON + 5; return; }
          const w = j === orgs.length - 1 ? x + 42 + nw - ox : (nw - GAPX) / 2;
          g.fillStyle = C.muted;
          g.fillText(fit(g, o.name, w - ICON - 4), ox + ICON + 4, cy + 33);
          ox += ICON + 4 + g.measureText(fit(g, o.name, w - ICON - 4)).width + GAPX;
        });
      }
      cy += 40;
    });
    if (st.more) {
      g.textAlign = 'left';
      g.fillStyle = C.muted;
      g.font = font(400, 12, family);
      g.fillText(`另有 ${st.more} 人`, x + 42, cy + 22);
    }
  };
  // 每两方一组：势力卡片一行、参战玩家一行
  for (const q of pairs) {
    y += GAP;
    q.sides.forEach((s, i) => column(s, PAD + i * (q.colW + GAP), q));
    y += q.SIDE;
    if (q.PLAY) {
      y += GAP;
      q.sides.forEach((s, i) => players(s, PAD + i * (q.colW + GAP), q));
      y += q.PLAY;
    }
  }

  // ---------- 页脚 ----------
  const fy = y + 44;
  const sw = siteMark(g, C, PAD, fy, family);
  g.textAlign = 'left';
  g.fillStyle = C.muted;
  g.font = font(400, 13, family);
  g.fillText(m.footer, PAD + sw + 14, fy);
  g.textAlign = 'right';
  g.fillText(m.generated, W - PAD, fy);
  // 按实际内容高度裁剪
  const out = document.createElement('canvas');
  const h = Math.min(H, Math.ceil(fy + 36));
  out.width = W * SCALE;
  out.height = h * SCALE;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}
