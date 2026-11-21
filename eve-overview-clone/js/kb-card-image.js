// ===== 击杀详情、人物 / 军团 / 联盟页的分享图片 =====
// 纯 Canvas 绘制；配色、图片加载、画法小工具与弹窗在 share-image.js。数据模型由 killboard.js / kb-page.js 整理好传进来。
import { W, SCALE, THEMES, loadImages, rr, alpha, makeCanvas, crop, painter, qrSize } from './share-image.js?v=11';

const PAD = 40, IW = W - PAD * 2, GAP = 20;
// 安全等级颜色（页面里是 CSS 变量，画布读不了，按图片配色取）
const secColor = (C, sec) => (sec == null ? '#9b7bd4' : sec >= 0.5 ? C.good : sec > 0 ? C.gold : C.b);

// 两列卡片：每列 { title, color, right, rows, rowH, draw(row, x, y, w), empty }，两列等高，返回卡片底部 y
function twoCols(g, C, P, y, cols) {
  const colW = (IW - GAP) / 2;
  const h = Math.max(...cols.map((c) => 64 + (c.rows.length ? c.rows.length * c.rowH : 40) + (c.foot ? 26 : 0) + 14));
  cols.forEach((c, i) => {
    const x0 = PAD + i * (colW + GAP), x = x0 + 24, w = colW - 48;
    P.card(x0, y, colW, h);
    P.title(c.title, x, y + 38, { color: c.color, right: c.right, rightX: x + w });
    let cy = y + 56;
    if (!c.rows.length) P.text(c.empty || '暂无', x, cy + 26, { size: 13, color: C.muted });
    c.rows.forEach((r, j) => { c.draw(r, x, cy, w, j); cy += c.rowH; });
    if (c.foot) P.text(c.foot, x, cy + 18, { size: 12, color: C.muted });
  });
  return y + h;
}
const colsHeight = (cols) => Math.max(...cols.map((c) => 64 + (c.rows.length ? c.rows.length * c.rowH : 40) + (c.foot ? 26 : 0) + 14));

// 一排统计小卡片：[{ label, value, detail, color }]
function tiles(g, C, P, y, list, h = 104) {
  const n = list.length, tw = (IW - 16 * (n - 1)) / n;
  list.forEach((t, i) => {
    const x = PAD + i * (tw + 16);
    P.card(x, y, tw, h, 18);
    P.text(t.label, x + 20, y + 30, { size: 13, color: C.muted, max: tw - 40 });
    P.text(t.value, x + 20, y + 68, { size: 28, weight: 800, color: t.color || C.text, max: tw - 40 });
    if (t.detail) P.text(t.detail, x + 20, y + 90, { size: 12, color: C.muted, max: tw - 40 });
  });
  return y + h;
}

// 胶囊一排要占几行（画卡片前先算高度）
function chipRows(P, list, x, maxX) {
  let cx = x, rows = 1;
  for (const it of list) {
    const w = P.measure(it.text, 14, 500) + (it.dot ? 44 : 28);
    if (cx > x && cx + w > maxX) { cx = x; rows += 1; }
    cx += w + 8;
  }
  return rows;
}

// ---------------------------------------------------------------- 击杀
// 一行行的画法（精简图和完整长图共用）
function killRows(g, C, P, images) {
  return {
    head(gr, x, cy, cont) {
      const label = cont ? gr.label + '（续）' : gr.label;
      P.text(label, x, cy + 20, { size: 13, weight: 700, color: C.sub });
      if (!cont) P.text(gr.count, x + P.measure(label, 13, 700) + 8, cy + 20, { size: 12, color: C.muted });
    },
    item(it, x, cy, w) {
      if (it.dropped) { rr(g, x - 8, cy + 1, w + 16, 34, 9); g.fillStyle = alpha(C.good, 0.1); g.fill(); }
      P.pic(images.get(it.icon), x, cy + 4, 28, 6);
      const qw = it.qty !== '1' ? P.measure(`×${it.qty}`, 13, 600) + 8 : 0;
      const pw = it.part ? P.measure(it.part, 12, 600) + 14 : 0;
      const nw = P.text(it.name, x + 40, cy + 23, { size: 14, weight: 500, color: it.dropped ? C.good : C.text, max: w - 40 - 110 - qw - pw });
      if (qw) P.text(`×${it.qty}`, x + 40 + nw + 8, cy + 23, { size: 13, weight: 600, color: C.muted });
      if (it.part) P.text(it.part, x + w - 100, cy + 23, { size: 12, weight: 600, color: C.good, align: 'right' });
      if (it.value) P.text(it.value, x + w, cy + 23, { size: 13, color: C.sub, align: 'right' });
    },
    attacker(a, x, cy, w) {
      P.pic(images.get(a.avatar), x, cy + 6, 38, a.round ? 19 : 8);
      if (a.ship) P.pic(images.get(a.ship), x + w - 118, cy + 9, 30, 6);
      const tw = w - 50 - 128;
      const nx = x + 50 + P.text(a.name, x + 50, cy + 21, { size: 14, weight: 700, max: tw - (a.final ? 70 : 0) });
      if (a.final) {
        const fw = P.measure('最后一击', 11, 700) + 14;
        rr(g, nx + 8, cy + 8, fw, 18, 9);
        g.fillStyle = alpha(C.gold, 0.16);
        g.fill();
        P.text('最后一击', nx + 15, cy + 21, { size: 11, weight: 700, color: C.gold });
      }
      P.text(a.party, x + 50, cy + 38, { size: 12, color: C.muted, max: tw });
      P.bar(x + 50, cy + 45, tw, 4, a.share, C.a);
      P.text(a.damage, x + w, cy + 24, { size: 14, weight: 700, align: 'right' });
      P.text(a.pct, x + w, cy + 41, { size: 12, color: C.muted, align: 'right' });
    },
    party(p, x, cy, w) {
      P.pic(images.get(p.logo), x, cy + 6, 32, 8);
      const tw = w - 44 - 70;
      const pw = P.text(p.pilots, x + 44 + tw, cy + 20, { size: 12, color: C.muted, align: 'right' });
      P.text(p.name, x + 44, cy + 20, { size: 14, weight: 600, max: tw - pw - 12 });
      P.bar(x + 44, cy + 29, tw, 6, p.share, C.a);
      P.text(p.pct, x + w, cy + 28, { size: 14, weight: 700, align: 'right' });
    },
    ship(s, sx, sy, sw) {
      rr(g, sx, sy, sw, 36, 10);
      g.fillStyle = C.panel2;
      g.fill();
      P.pic(images.get(s.icon), sx + 4, sy + 4, 28, 6);
      P.text(s.name, sx + 40, sy + 23, { size: 13, weight: 600, max: sw - 40 - 44 });
      P.text('×' + s.count, sx + sw - 10, sy + 23, { size: 13, weight: 700, color: C.sub, align: 'right' });
    }
  };
}

// 精简图（默认）：左列装配与物品，右列攻击者（前 10 名）、攻击方势力、攻击方舰船
function shortBody(m) {
  const leftH = 64 + m.groups.reduce((s, gr) => s + 30 + gr.items.length * 36 + (gr.more ? 24 : 0) + 8, 0) + 8;
  const shipRows = Math.ceil(m.ships.length / 2);
  const rightH = 64 + m.attackers.length * 54 + (m.moreAttackers ? 26 : 0) +
    (m.parties.length ? 66 + m.parties.length * 44 : 0) + (shipRows ? 66 + shipRows * 42 : 0) + 14;
  const ch = Math.max(leftH, rightH, 120);
  return {
    h: ch,
    draw(g, C, P, R, y) {
      const lw = 640, rw = IW - lw - GAP;
      P.card(PAD, y, lw, ch);
      let x = PAD + 24, w = lw - 48;
      P.title('装配与物品', x, y + 38, { color: C.b, right: '绿色为掉落', rightX: x + w });
      let cy = y + 56;
      if (!m.groups.length) P.text('没有物品', x, cy + 26, { size: 13, color: C.muted });
      for (const gr of m.groups) {
        R.head(gr, x, cy);
        cy += 30;
        for (const it of gr.items) { R.item(it, x, cy, w); cy += 36; }
        if (gr.more) { P.text(`另有 ${gr.more} 种物品`, x + 40, cy + 16, { size: 12, color: C.muted }); cy += 24; }
        cy += 8;
      }

      // ---------- 攻击者 ----------
      const rx0 = PAD + lw + GAP;
      P.card(rx0, y, rw, ch);
      x = rx0 + 24; w = rw - 48;
      P.title(`攻击者 ${m.attackerCount}`, x, y + 38, { color: C.a, right: '伤害', rightX: x + w });
      cy = y + 56;
      for (const a of m.attackers) { R.attacker(a, x, cy, w); cy += 54; }
      if (m.moreAttackers) { P.text(`另有 ${m.moreAttackers} 名攻击者`, x + 50, cy + 16, { size: 12, color: C.muted }); cy += 26; }
      // 攻击方势力
      if (m.parties.length) {
        cy += 18;
        g.fillStyle = C.line;
        g.fillRect(x, cy, w, 1);
        P.title('攻击方势力', x, cy + 34, { color: C.a, right: '伤害占比', rightX: x + w });
        cy += 48;
        for (const p of m.parties) { R.party(p, x, cy, w); cy += 44; }
      }
      // 攻击方舰船：两列
      if (shipRows) {
        cy += 18;
        g.fillStyle = C.line;
        g.fillRect(x, cy, w, 1);
        P.title('攻击方舰船', x, cy + 34, { color: C.a });
        cy += 48;
        const sw = (w - 16) / 2;
        m.ships.forEach((s, i) => R.ship(s, x + (i % 2) * (sw + 16), cy + Math.floor(i / 2) * 42, sw));
      }
      return y + ch;
    }
  };
}

// 完整长图：装配与物品、攻击者、攻击方势力、攻击方舰船各占一整行卡片，里面分两三列（先排满左列再排右列）
const LONG_MAX = 30000;   // 图片最高（逻辑像素）；攻击者特别多的大型击杀超出时只列伤害最高的一部分
const IX = PAD + 24, IIW = IW - 48, CGAP = 32;
function longBody(m) {
  const colW = (n, gap = CGAP) => (IIW - gap * (n - 1)) / n;
  // 装配与物品：分组标题、物品行按顺序排成两列，左右差不多高；右列从一组中间开始时补一行「（续）」标题
  const lines = [];
  for (const gr of m.groups) {
    lines.push({ h: 30, head: gr });
    for (const it of gr.items) lines.push({ h: 36, it, gr });
    lines.push({ h: 8 });
  }
  const total = lines.reduce((s, l) => s + l.h, 0);
  let cut = lines.length, acc = 0;
  for (let i = 0; i < lines.length; i++) { if (acc + lines[i].h / 2 >= total / 2) { cut = i; break; } acc += lines[i].h; }
  while (cut > 0 && lines[cut - 1].head) cut--;
  const left = lines.slice(0, cut), right = lines.slice(cut);
  while (right.length && !right[0].head && !right[0].it) right.shift();
  if (right[0]?.it) right.unshift({ h: 30, head: right[0].gr, cont: true });
  const colH = (list) => list.reduce((s, l) => s + l.h, 0);
  const itemsH = 56 + (m.groups.length ? Math.max(colH(left), colH(right)) : 40) + 10;
  const shipRows = Math.ceil(m.ships.length / 3);
  const partyRows = Math.ceil(m.parties.length / 2);
  const shipsH = shipRows ? 56 + shipRows * 42 + 12 : 0;
  const partiesH = partyRows ? 56 + partyRows * 44 + 10 : 0;
  // 攻击者：放不下时只列伤害最高的（最后一击总要在里面）
  const fixed = itemsH + (partiesH ? GAP + partiesH : 0) + (shipsH ? GAP + shipsH : 0) + GAP + 56 + 14 + 26;
  const maxRows = Math.max(10, Math.floor((LONG_MAX - 600 - fixed) / 54));
  let attackers = m.attackers;
  if (Math.ceil(attackers.length / 2) > maxRows) {
    attackers = attackers.slice(0, maxRows * 2);
    const final = m.attackers.find((a) => a.final);
    if (final && !attackers.includes(final)) attackers[attackers.length - 1] = final;
  }
  const more = m.attackerCount - attackers.length;
  const atkRows = Math.ceil(attackers.length / 2);
  const atkH = 56 + atkRows * 54 + (more ? 26 : 0) + 14;
  const cols = (list, n, rowH, x0, y0, w, draw, gap = CGAP) => {
    const per = Math.ceil(list.length / n);
    list.forEach((r, i) => draw(r, x0 + Math.floor(i / per) * (w + gap), y0 + (i % per) * rowH, w));
  };
  return {
    h: itemsH + GAP + atkH + (partiesH ? GAP + partiesH : 0) + (shipsH ? GAP + shipsH : 0),
    draw(g, C, P, R, y) {
      // ---------- 装配与物品 ----------
      P.card(PAD, y, IW, itemsH);
      P.title('装配与物品', IX, y + 38, { color: C.b, right: '绿色为掉落', rightX: IX + IIW });
      const w2 = colW(2);
      if (!m.groups.length) P.text('没有物品', IX, y + 82, { size: 13, color: C.muted });
      [left, right].forEach((list, c) => {
        const x = IX + c * (w2 + CGAP);
        let cy = y + 56;
        for (const l of list) {
          if (l.head) R.head(l.head, x, cy, l.cont);
          else if (l.it) R.item(l.it, x, cy, w2);
          cy += l.h;
        }
      });
      y += itemsH + GAP;
      // ---------- 攻击者 ----------
      P.card(PAD, y, IW, atkH);
      P.title(`攻击者 ${m.attackerCount}`, IX, y + 38, { color: C.a, right: '伤害', rightX: IX + IIW });
      cols(attackers, 2, 54, IX, y + 56, w2, R.attacker);
      if (more) P.text(`另有 ${more} 名攻击者（图片太长，只列出伤害最高的 ${attackers.length} 名）`, IX + 50, y + 56 + atkRows * 54 + 16, { size: 12, color: C.muted });
      y += atkH;
      // ---------- 攻击方势力 ----------
      if (partiesH) {
        y += GAP;
        P.card(PAD, y, IW, partiesH);
        P.title(`攻击方势力 ${m.parties.length}`, IX, y + 38, { color: C.a, right: '伤害占比', rightX: IX + IIW });
        cols(m.parties, 2, 44, IX, y + 56, w2, R.party);
        y += partiesH;
      }
      // ---------- 攻击方舰船 ----------
      if (shipsH) {
        y += GAP;
        P.card(PAD, y, IW, shipsH);
        P.title(`攻击方舰船 ${m.ships.length}`, IX, y + 38, { color: C.a });
        cols(m.ships, 3, 42, IX, y + 56, colW(3, 16), R.ship, 16);
        y += shipsH;
      }
      return y;
    }
  };
}

// 完整长图的画布：高度按内容算，尽量 2 倍像素；太长时降低倍数（浏览器画布单边最多约 32000 像素，面积也有上限）
function longCanvas(H) {
  const scale = Math.max(1, Math.min(SCALE, 32000 / H, Math.sqrt(64e6 / (W * H))));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.ceil(H * scale);
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  g.textBaseline = 'alphabetic';
  return { canvas, g };
}

// m.full：完整长图（killboard.js 整理好全部物品、攻击者、势力和舰船）
export async function renderKillImage(m, theme = 'light') {
  const C = THEMES[theme] || THEMES.light;
  const images = await loadImages([m.render, m.victim.avatar, m.victim.corpLogo, m.victim.allianceLogo,
    ...m.groups.flatMap((gr) => gr.items.map((it) => it.icon)), ...m.attackers.flatMap((a) => [a.avatar, a.ship]),
    ...m.parties.map((p) => p.logo), ...m.ships.map((s) => s.icon)]);
  // 先用一块小画布量文字、算总高度，再建画布（完整长图的高度要先算出来）
  const MP = painter(document.createElement('canvas').getContext('2d'), C);

  const x0 = PAD + 24 + 252 + 32, xr = W - PAD - 28;
  const chips = [{ text: `${m.system.name} ${m.system.sec}`, dot: secColor(C, m.system.level) }, ...(m.system.region ? [{ text: m.system.region }] : []),
    ...(m.station ? [{ text: m.station }] : []), ...(m.near ? [{ text: m.near }] : []),
    { text: m.time }, { text: m.eveTime }, { text: `${m.attackerCount} 名攻击者` }, { text: `承受伤害 ${m.damage}` }, ...m.tags.map((t) => ({ text: t, fg: C.b, bg: alpha(C.b, 0.12) }))];
  const crow = chipRows(MP, chips, x0, xr);
  const HERO = Math.max(300, 150 + crow * 38 + 112);
  const body = m.full ? longBody(m) : shortBody(m);
  const top = Math.max(92, 40 + qrSize(m.url) + 24);   // 页眉右边的二维码比标签高，主卡片相应下移
  const H = top + HERO + GAP + body.h + (m.full ? 80 : 90);
  const { canvas, g } = m.full ? longCanvas(H) : makeCanvas(4000);
  const P = painter(g, C);
  P.background(H, C.b, C.a);
  P.header('击杀报告 · KILLMAIL', 40, C.b, m.url);

  // ---------- 主卡片：舰船图、受害者、地点时间、价值 ----------
  P.card(PAD, top, IW, HERO, 24);
  g.save();
  rr(g, PAD, top, IW, HERO, 24);
  g.clip();
  const tint = g.createLinearGradient(PAD, 0, W - PAD, 0);
  tint.addColorStop(0, alpha(C.b, C.tint * 1.3));
  tint.addColorStop(0.5, alpha(C.b, 0));
  g.fillStyle = tint;
  g.fillRect(PAD, top, IW, HERO);
  g.restore();
  P.pic(images.get(m.render), PAD + 24, top + 24, 252, 18);
  // 右上角：军团图标在左、联盟图标在右
  const logos = [images.get(m.victim.corpLogo), images.get(m.victim.allianceLogo)].filter(Boolean);
  logos.forEach((im, i) => P.pic(im, xr - 64 - (logos.length - 1 - i) * 76, top + 24, 64, 14));
  const nameMax = xr - x0 - logos.length * 76;
  P.text(m.ship, x0, top + 62, { size: 34, weight: 800, max: nameMax });
  if (m.shipGroup) P.text(m.shipGroup, x0, top + 84, { size: 13, color: C.muted, max: nameMax });
  // 受害者
  const vy = top + 98;
  P.pic(images.get(m.victim.avatar), x0, vy, 44, 22);
  P.text(m.victim.name, x0 + 56, vy + 19, { size: 18, weight: 700, max: nameMax - 56 });
  P.text(m.victim.party, x0 + 56, vy + 39, { size: 13, color: C.muted, max: nameMax - 56 });
  const cBottom = P.chips(chips, x0, vy + 58, xr, { bg: C.panel2 });
  // 价值与掉落 / 摧毁
  const ky = cBottom + 30;
  P.text('总价值', x0, ky, { size: 13, color: C.muted });
  const vw = P.text(m.value, x0, ky + 42, { size: 42, weight: 800, color: C.b });
  P.text('ISK', x0 + vw + 8, ky + 42, { size: 16, weight: 600, color: C.muted });
  const bx = x0 + 380, bw = xr - bx;
  P.text(`掉落 ${m.dropped}`, bx, ky + 14, { size: 13, weight: 600, color: C.good });
  P.text(`摧毁 ${m.destroyed}`, bx + bw, ky + 14, { size: 13, weight: 600, color: C.b, align: 'right' });
  const dw = Math.max(0, Math.min(1, m.dropShare)) * bw;
  rr(g, bx, ky + 26, bw, 14, 7);
  g.fillStyle = alpha(C.b, 0.85);
  g.fill();
  if (dw > 0) { rr(g, bx, ky + 26, Math.max(14, dw), 14, 7); g.fillStyle = C.good; g.fill(); }
  if (m.valueNote) P.text(m.valueNote, bx + bw, ky + 62, { size: 12, color: C.muted, align: 'right', max: bw });

  // ---------- 装配与物品、攻击者 ----------
  const fy = body.draw(g, C, P, killRows(g, C, P, images), top + HERO + GAP) + 44;
  P.footer(m.footer, m.generated, fy);
  return m.full ? canvas : crop(canvas, fy + 36);
}

// ---------------------------------------------------------------- 人物 / 军团 / 联盟
export async function renderEntityImage(m, theme = 'light') {
  const C = THEMES[theme] || THEMES.light;
  const images = await loadImages([m.avatar, ...m.subs.map((s) => s.icon), ...m.topKills.map((k) => k.icon), ...m.topLosses.map((k) => k.icon),
    ...m.shipsUsed.map((s) => s.icon), ...m.shipsLost.map((s) => s.icon), ...(m.members || []).map((s) => s.icon)]);
  const { canvas, g } = makeCanvas(5000);
  const P = painter(g, C);
  const eff = m.recent.eff;
  const effColor = eff == null ? C.muted : eff >= 50 ? C.good : C.b;

  // 各区块（两列卡片）先整理好，算总高度
  const killRow = (lossSide) => (k, x, y, w) => {
    P.pic(images.get(k.icon), x, y + 4, 38, 8);
    P.text(k.ship, x + 50, y + 21, { size: 14.5, weight: 600, max: w - 50 - 130 });
    P.text(k.who, x + 50, y + 38, { size: 12, color: C.muted, max: w - 50 - 130 });
    P.text(k.value, x + w, y + 22, { size: 15, weight: 700, color: lossSide ? C.loss : C.text, align: 'right' });
    P.text(k.time, x + w, y + 39, { size: 12, color: C.muted, align: 'right' });
  };
  const shipRow = (color, max) => (s, x, y, w) => {
    P.pic(images.get(s.icon), x, y + 5, 32, 7);
    P.text(s.name, x + 44, y + 20, { size: 14, weight: 600, max: w - 44 - 60 });
    P.bar(x + 44, y + 29, w - 44 - 60, 6, s.count / max, color);
    P.text(String(s.count), x + w, y + 27, { size: 15, weight: 700, align: 'right' });
  };
  const sections = [];
  if (m.topKills.length || m.topLosses.length) sections.push([
    { title: '最贵击杀', color: C.good, rows: m.topKills, rowH: 50, draw: killRow(false), empty: '最近没有击杀' },
    { title: '最贵损失', color: C.b, rows: m.topLosses, rowH: 50, draw: killRow(true), empty: '最近没有损失' }
  ]);
  if (m.shipsUsed.length || m.shipsLost.length) {
    const max = Math.max(1, ...m.shipsUsed.map((s) => s.count), ...m.shipsLost.map((s) => s.count));
    sections.push([
      { title: '常用舰船', color: C.good, right: '参与击杀次数', rows: m.shipsUsed, rowH: 44, draw: shipRow(C.good, max) },
      { title: '损失的舰船', color: C.b, right: '损失次数', rows: m.shipsLost, rowH: 44, draw: shipRow(C.b, max) }
    ]);
  }
  if (m.regions.length || m.systems.length) {
    const rmax = Math.max(1, ...m.regions.map((r) => r.count)), smax = Math.max(1, ...m.systems.map((r) => r.count));
    sections.push([
      { title: '活跃星域', color: C.a, rows: m.regions, rowH: 40, draw: (r, x, y, w) => {
        P.text(r.name, x, y + 18, { size: 14, weight: 600, max: w - 70 });
        P.bar(x, y + 26, w - 70, 6, r.count / rmax, C.a);
        P.text(String(r.count), x + w, y + 25, { size: 14, weight: 700, align: 'right' });
      } },
      { title: '活跃星系', color: C.a, rows: m.systems, rowH: 40, draw: (r, x, y, w) => {
        const nw = P.text(r.name, x, y + 18, { size: 14, weight: 600, max: w - 140 });
        P.text(r.sec, x + nw + 8, y + 18, { size: 13, weight: 700, color: secColor(C, r.level) });
        if (r.region) P.text(r.region, x + nw + 8 + P.measure(r.sec, 13, 700) + 8, y + 18, { size: 12, color: C.muted, max: w - nw - 160 });
        P.bar(x, y + 26, w - 70, 6, r.count / smax, C.a);
        P.text(String(r.count), x + w, y + 25, { size: 14, weight: 700, align: 'right' });
      } }
    ]);
  }
  if (m.members?.length) {
    const half = Math.ceil(m.members.length / 2);
    const memberRow = (s, x, y, w) => {
      P.pic(images.get(s.icon), x, y + 5, 34, s.round ? 17 : 8);
      P.text(s.name, x + 46, y + 20, { size: 14, weight: 600, max: w - 46 - 120 });
      P.text(s.detail, x + 46, y + 37, { size: 12, color: C.muted, max: w - 46 - 120 });
      P.text(s.value, x + w, y + 27, { size: 14, weight: 700, color: C.good, align: 'right' });
    };
    sections.push([
      { title: m.membersTitle, color: C.a, right: '击毁价值', rows: m.members.slice(0, half), rowH: 46, draw: memberRow },
      { title: ' ', color: C.panel, right: '击毁价值', rows: m.members.slice(half), rowH: 46, draw: memberRow }
    ]);
  }
  const HERO = 212;
  const top = Math.max(92, 40 + qrSize(m.url) + 24);
  const H = top + HERO + GAP + 40 + 104 + (m.lifetime ? GAP + 40 + 104 : 0) + sections.reduce((s, c) => s + GAP + colsHeight(c), 0) + 100;
  P.background(H, C.a, effColor === C.muted ? C.a : effColor);
  P.header(`${m.kindLabel}档案 · ${m.kindEn}`, 40, C.a, m.url);

  // ---------- 主卡片 ----------
  P.card(PAD, top, IW, HERO, 24);
  g.save();
  rr(g, PAD, top, IW, HERO, 24);
  g.clip();
  const tint = g.createLinearGradient(PAD, 0, W - PAD, 0);
  tint.addColorStop(0, alpha(C.a, C.tint * 1.3));
  tint.addColorStop(0.55, alpha(C.a, 0));
  g.fillStyle = tint;
  g.fillRect(PAD, top, IW, HERO);
  g.restore();
  P.pic(images.get(m.avatar), PAD + 32, top + 36, 140, m.round ? 70 : 24);
  const x0 = PAD + 200, effW = 250, xr = W - PAD - 32;
  const nameMax = xr - effW - 30 - x0;
  P.text(m.name, x0, top + 80, { size: 40, weight: 800, max: nameMax });
  // 所属军团 / 联盟（带图标）
  let sx = x0;
  for (const s of m.subs) {
    if (s.icon) { P.pic(images.get(s.icon), sx, top + 98, 24, 6); sx += 32; }
    sx += P.text(s.text, sx, top + 116, { size: 15, weight: 600, color: C.sub, max: x0 + nameMax - sx }) + 18;
    if (sx > x0 + nameMax) break;
  }
  P.chips(m.chips.map((t) => ({ text: t })), x0, m.subs.length ? top + 136 : top + 100, x0 + nameMax, { bg: C.panel2 });
  // 右侧：ISK 效率
  const ex = xr - effW;
  rr(g, ex, top + 32, effW, HERO - 64, 18);
  g.fillStyle = alpha(effColor, 0.1);
  g.fill();
  P.text(`ISK 效率 · 最近 ${m.days} 天`, ex + 20, top + 64, { size: 13, color: C.muted });
  P.text(eff == null ? '—' : eff.toFixed(1) + '%', ex + 20, top + 116, { size: 44, weight: 800, color: effColor });
  if (eff != null) P.bar(ex + 20, top + 136, effW - 40, 8, eff / 100, C.good, alpha(C.b, 0.75));
  P.text(`击毁 ${m.recent.destroyed}`, ex + 20, top + 164, { size: 12, color: C.muted });
  P.text(`损失 ${m.recent.lost}`, ex + effW - 20, top + 164, { size: 12, color: C.muted, align: 'right' });

  // ---------- 统计 ----------
  let y = top + HERO + GAP;
  P.title(`最近 ${m.days} 天`, PAD + 4, y + 22, { color: C.a, right: m.valueLabel, rightX: W - PAD - 4 });
  y = tiles(g, C, P, y + 40, [
    { label: '参与击杀', value: m.recent.kills, detail: `单刷 ${m.recent.solo}`, color: C.good },
    ...(m.recent.finalBlows != null ? [{ label: '最后一击', value: m.recent.finalBlows, detail: m.recent.finalShare }] : []),
    { label: '损失', value: m.recent.losses, color: C.b },
    { label: '击毁价值', value: m.recent.destroyed, detail: 'ISK', color: C.good },
    { label: '损失价值', value: m.recent.lost, detail: 'ISK', color: C.b }
  ]);
  if (m.lifetime) {
    const L = m.lifetime;
    y += GAP;
    P.title('生涯统计', PAD + 4, y + 22, { color: C.gold, right: 'zKillboard 估值', rightX: W - PAD - 4 });
    y = tiles(g, C, P, y + 40, [
      { label: '参与击杀', value: L.kills, detail: `单刷 ${L.solo}`, color: C.good },
      { label: '损失', value: L.losses, detail: `单刷被杀 ${L.soloLosses}`, color: C.b },
      { label: '击毁价值', value: L.destroyed, detail: 'ISK', color: C.good },
      { label: '损失价值', value: L.lost, detail: 'ISK', color: C.b },
      { label: 'ISK 效率', value: L.eff, detail: L.ratios }
    ]);
  }
  for (const cols of sections) y = twoCols(g, C, P, y + GAP, cols);

  const fy = y + 44;
  P.footer(m.footer, m.generated, fy);
  return crop(canvas, fy + 36);
}
