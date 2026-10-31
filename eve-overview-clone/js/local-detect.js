// ===== 本地红名：画面识别（纯计算，不碰 DOM；local-worker.js 与 local-watch.js 共用）=====
// 输入是一帧画面 { data: RGBA, width, height }。
// 1. locate：在整帧里找「本地」成员列表：
//    声望图标是一列竖直对齐、大小相同（界面 90% 时约 11px）、间距固定（约图标的 1.4 倍）的彩色小方块，连续 3 个以上算一个名单（人少、只有一两个彩色图标时，认出上方的「本」字也算，行距从名字的文字行量）；
//    名单上方的频道标签里有「本」字（窗口窄时「地」会被挡住，只认「本」）的就是本地。别的频道成员列表、空间站访客列表都对不上。
//    返回列表区域（图标列左边到滚动条）、图标大小、行距。界面缩放不同时图标与行距跟着变，都从画面里量出来。
//    没认出「本」字时返回最多 4 个像名单的区域（options），让用户从截图里选。
// 2. scanRows：在锁定的区域里按行距切行，每行给出图标颜色（red / orange / friend / none）、名字那块的文字像素签名（认人用，图标闪烁不影响）、
//    名字是否被截断（几行名字停在同一条截断边上，或结尾渐隐）。
// 颜色按色相分，不写死具体数值：深浅、不同缩放下都适用。

const colored = (r, g, b) => { const mx = Math.max(r, g, b); return mx - Math.min(r, g, b) > 50 && mx > 70; };
const texty = (r, g, b) => { const mx = Math.max(r, g, b); return mx > 110 && mx - Math.min(r, g, b) < 60; };
const dim = (r, g, b) => Math.max(r, g, b) > 60 && Math.max(r, g, b) - Math.min(r, g, b) < 60;   // 含渐隐的文字

// 「本」字（图标 11px 时的大小，取自游戏截图）
const BEN = [
  '......#......',
  '......#......',
  '......#......',
  '#############',
  '.....###.....',
  '....#####....',
  '....#.#.#....',
  '...#..#.##...',
  '..##..#..##..',
  '.##...#...###',
  '##########.##',
  '......#......',
  '......#......',
  '......#......'
].map((r) => [...r].map((c) => c === '#'));
const benCache = new Map();
function benAt(size) {
  const s = size / 11;
  const key = Math.round(s * 20);
  if (!benCache.has(key)) {
    const h = Math.max(6, Math.round(BEN.length * s)), w = Math.max(6, Math.round(BEN[0].length * s));
    const t = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t.push(BEN[Math.floor(y * BEN.length / h)][Math.floor(x * BEN[0].length / w)] ? 1 : 0);
    benCache.set(key, { w, h, t, on: t.reduce((a, b) => a + b, 0) });
  }
  return benCache.get(key);
}

// ---------- 1. 找本地列表 ----------
// opts.within：只在这个矩形里找（手动框选时，不要求「本」字）
export function locate(frame, opts = {}) {
  const { data, width: W, height: H } = frame;
  const R = opts.within || { x: 0, y: 0, w: W, h: H };
  const x0 = Math.max(0, R.x | 0), y0 = Math.max(0, R.y | 0), x1 = Math.min(W, (R.x + R.w) | 0), y1 = Math.min(H, (R.y + R.h) | 0);
  const RW = x1 - x0, RH = y1 - y0;
  const mask = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++) {
    let i = ((y + y0) * W + x0) * 4;
    for (let x = 0; x < RW; x++, i += 4) if (colored(data[i], data[i + 1], data[i + 2])) mask[y * RW + x] = 1;
  }
  // 连通块：只要小方块（宽高 6–28、接近正方形、填充率过半）
  const seen = new Uint8Array(RW * RH), stack = new Int32Array(RW * RH);
  const icons = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || seen[p]) continue;
    let sp = 0, n = 0, minx = RW, maxx = 0, miny = RH, maxy = 0, big = false;
    stack[sp++] = p; seen[p] = 1;
    while (sp) {
      const q = stack[--sp], qx = q % RW, qy = (q / RW) | 0;
      if (++n > 900) big = true;
      if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
      if (qx + 1 < RW && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
      if (qx > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
      if (qy + 1 < RH && mask[q + RW] && !seen[q + RW]) { seen[q + RW] = 1; stack[sp++] = q + RW; }
      if (qy > 0 && mask[q - RW] && !seen[q - RW]) { seen[q - RW] = 1; stack[sp++] = q - RW; }
    }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    if (big || w < 6 || h < 6 || w > 28 || h > 28 || Math.abs(w - h) > 2 || n < w * h * 0.5) continue;
    icons.push({ x: minx + x0, y: miny + y0, s: Math.max(w, h) });
  }
  // 同一列（左边 x 相差 ≤1、大小相近）按 y 排序，间距稳定的连续 ≥3 个（手动框选时 ≥2）
  const cols = [];
  for (const c of icons.sort((a, b) => a.x - b.x || a.y - b.y)) {
    const g = cols.find((g) => Math.abs(g[0].x - c.x) <= 1 && Math.abs(g[0].s - c.s) <= 1);
    if (g) g.push(c); else cols.push([c]);
  }
  const lists = [];
  for (const g of cols) {
    g.sort((a, b) => a.y - b.y);
    let run = [g[0]];
    const flush = () => { lists.push(run); };
    for (const c of g.slice(1)) {
      const dy = c.y - run[run.length - 1].y;
      if (dy >= c.s * 1.1 && dy <= c.s * 4.5) run.push(c); else { flush(); run = [c]; }
    }
    flush();
  }
  const out = [];
  for (const run of lists) {
    const size = Math.round(run.reduce((a, c) => a + c.s, 0) / run.length);
    // 人少时本地里可能只有一两个彩色图标（白名、自己没有图标）：这时行距从右边名字的文字行量，并且一定要认出「本」字
    const weak = run.length < (opts.within ? 2 : 3);
    let pitch;
    if (run.length >= 2) {
      const dys = run.slice(1).map((c, i) => c.y - run[i].y);
      const base = Math.min(...dys);
      const single = dys.filter((d) => d < base * 1.5);
      pitch = single.reduce((a, b) => a + b, 0) / single.length;
    } else pitch = textPitch(frame, run[0].x, run[0].y, size);
    if (!pitch || pitch > size * 2.2) continue;   // 行距太大：带头像的名单（空间站访客等）
    const ben = opts.within && !weak ? 1 : benScore(frame, run[0].x, run[0].y, size, pitch);
    if (weak && ben < 0.5) continue;
    out.push({ ix: run[0].x, top: run[0].y, bottom: run[run.length - 1].y, size, pitch, icons: run.length, ben });
  }
  out.sort((a, b) => b.ben - a.ben || b.icons - a.icons);
  const best = out[0];
  // 没认出「本」字：把最像名单的几列（图标多的在前）交给用户选
  if (!best || (!opts.within && best.ben < 0.5)) {
    const options = out.sort((a, b) => b.icons - a.icons).slice(0, 4).map((c) => regionOf(frame, c, R));
    return { found: false, candidates: out.length, options };
  }
  return { found: true, region: regionOf(frame, best, R), candidates: out.length, score: best.ben };
}

// 只有一个图标时的行距：图标右边名字那一栏，相邻文字行起点的间距（取中位数）；量不出来（只有一行字）就按图标大小估
function textPitch(frame, ix, top, size) {
  const xa = ix + size + 1, xb = Math.min(frame.width, ix + size * 12);
  const starts = [];
  let prev = false;
  for (let y = Math.max(0, Math.round(top - size * 8)); y < Math.min(frame.height, Math.round(top + size * 8)); y++) {
    const on = countIn(frame, xa, xb, y, y + 1, texty) >= 2;
    if (on && !prev) starts.push(y);
    prev = on;
  }
  const d = starts.slice(1).map((y, i) => y - starts[i]).filter((v) => v >= size * 1.05 && v <= size * 2.2).sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : Math.round(size * 1.3);
}

// 列表上方的频道标签里找「本」字，返回最高匹配度（交并比）
function benScore(frame, ix, top, size, pitch) {
  const { data, width: W } = frame;
  const t = benAt(size);
  const ys = Math.max(0, Math.round(top - pitch * 5)), ye = Math.round(top);
  const xs = Math.max(0, ix - size), xe = Math.min(W - t.w, ix + size * 12);
  if (ye - t.h <= ys || xe <= xs) return 0;
  const bw = xe - xs + t.w, bh = ye - ys;
  const m = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = ((y + ys) * W + x + xs) * 4;
    if (texty(data[i], data[i + 1], data[i + 2])) m[y * bw + x] = 1;
  }
  let best = 0;
  for (let y = 0; y + t.h <= bh; y++) {
    for (let x = 0; x + t.w <= bw; x++) {
      let inter = 0, on = 0;
      for (let ty = 0, k = 0; ty < t.h; ty++) {
        const row = (y + ty) * bw + x;
        for (let tx = 0; tx < t.w; tx++, k++) { const v = m[row + tx]; on += v; if (v && t.t[k]) inter++; }
      }
      const uni = t.on + on - inter;
      if (uni && inter / uni > best) best = inter / uni;
    }
  }
  return best;
}

// 列表的范围：上下按行距扩到没有文字为止（人数那一行的小人图标在图标列里是白色，碰到就停），右边到滚动条
function regionOf(frame, L, R) {
  const { size, pitch } = L;
  const left = L.ix - 2;
  const iconR = L.ix + size + 1;
  const maxR = Math.min(frame.width, R.x + R.w, L.ix + size * 40);
  const rowText = (y) => textInRow(frame, iconR, maxR, y, pitch);
  const iconWhite = (y) => countIn(frame, L.ix, L.ix + size, y, y + size, texty) > size;
  let top = L.top;
  while (top - pitch >= R.y && rowText(top - pitch) > 4 && !iconWhite(top - pitch) && countIn(frame, L.ix, L.ix + size, top - pitch, top - pitch + size, colored) === 0) top -= pitch;
  let bottom = L.bottom;
  while (bottom + pitch * 1.7 <= Math.min(frame.height, R.y + R.h) && rowText(bottom + pitch) > 4) bottom += pitch;
  // 右边：每行从名字开头往右，空出 2.5 个图标宽还没有文字就算这行结束（再往右是游戏画面）；
  // 所有行里最靠右的文字之后找滚动条（一条从上到下比两边亮的细竖线）；找不到就用文字最右端 + 一个图标宽
  let textR = iconR;
  for (let y = top; y <= bottom; y += pitch) textR = Math.max(textR, lineEnd(frame, iconR, maxR, y, pitch, size));
  let sb = 0;
  for (let x = textR + 1; x < Math.min(maxR - 2, textR + size * 3); x++) {
    if (vline(frame, x, top, bottom + pitch * 0.75)) { sb = x; break; }
  }
  const right = Math.min(maxR, sb || textR + size);
  return { x: left, y: Math.round(top - 1), w: right - left, h: Math.round(bottom + pitch - top + 1), size, pitch, iconW: size + 3, scrollbar: Boolean(sb) };
}
function countIn(frame, xa, xb, ya, yb, fn) {
  const { data, width: W, height: H } = frame;
  let n = 0;
  for (let y = Math.max(0, ya | 0); y < Math.min(H, yb | 0); y++) for (let x = Math.max(0, xa | 0); x < Math.min(W, xb | 0); x++) {
    const i = (y * W + x) * 4;
    if (fn(data[i], data[i + 1], data[i + 2])) n++;
  }
  return n;
}
const textInRow = (frame, xa, xb, y, pitch) => countIn(frame, xa, xb, y, y + pitch * 0.75, texty);
// 一行文字的右端（含渐隐）：遇到 2.5 个图标宽的空白就停
function lineEnd(frame, xa, xb, y, pitch, size) {
  const { data, width: W, height: H } = frame;
  let last = xa;
  for (let x = xa; x < Math.min(W, xb); x++) {
    if (x - last > size * 2.5) break;
    if (thinLine(frame, x, Math.max(0, y | 0), Math.min(H - (y | 0), Math.round(pitch * 0.75)))) continue;
    for (let yy = Math.max(0, y | 0); yy < Math.min(H, (y + pitch * 0.75) | 0); yy++) {
      const i = (yy * W + x) * 4;
      if (dim(data[i], data[i + 1], data[i + 2])) { last = x; break; }
    }
  }
  return last;
}
// 竖线：这一列在八成以上的高度上都比左右两边（隔 2 像素）亮
function vline(frame, x, ya, yb) {
  const { data, width: W, height: H } = frame;
  const v = (xx, y) => { const i = (y * W + xx) * 4; return Math.max(data[i], data[i + 1], data[i + 2]); };
  let n = 0, hit = 0;
  for (let y = Math.max(0, ya | 0); y < Math.min(H, yb | 0); y++, n++) {
    const c = v(x, y);
    if (c > v(x - 2, y) + 10 && c > v(x + 2, y) + 10) hit++;
  }
  return n > 0 && hit > n * 0.8;
}

// ---------- 2. 逐行 ----------
// crop：区域内的画面（坐标从 0 开始），reg：locate 给出的区域。返回 { rows, phase }
export function scanRows(crop, reg) {
  const { data, width: W, height: H } = crop;
  const { size, pitch, iconW } = reg;
  // 行的起点：图标的上边（列里每个图标对行距取余的中位数），没有图标时沿用上次的。
  // 只认完整的图标（彩色连续够一个图标高）：图标闪烁到一半只亮下半截时，上边会错位（本地只有一个图标时整份名单的行都跟着错开）
  const tops = [];
  const colorRow = [];
  for (let y = 0; y < H; y++) colorRow.push(rowHasColor(crop, y, iconW));
  for (let y = 1; y < H; y++) {
    if (!colorRow[y] || colorRow[y - 1]) continue;
    let n = 0;
    while (y + n < H && colorRow[y + n]) n++;
    if (n >= size * 0.8) tops.push(y);
  }
  let phase = reg.phase ?? 0;
  if (tops.length) {
    const r = tops.map((t) => ((t % pitch) + pitch) % pitch).sort((a, b) => a - b);
    phase = r[r.length >> 1];
  }
  const rows = [];
  const h = Math.max(4, Math.round(pitch * 0.75));
  const nameX = iconW, nameW = W - iconW;
  const sbCols = scrollCols(crop, nameX, pitch);
  const sbLeft = sbCols.size ? Math.min(...sbCols) : W;
  for (let y = phase; y + h <= H; y += pitch) {
    const yi = Math.round(y);
    // 名字那块的文字像素（签名）；滚动条的滑块（贯穿整行高度、1–2 像素宽的竖线）和它右边（窗口外的画面）不算文字。
    // 签名分三档：2 笔画（亮）、1 笔画边缘（抗锯齿，视频压缩时忽明忽暗）、0 背景；比对时只有笔画对背景才算不同
    const sig = new Uint8Array(nameW * h);
    let on = 0, right = -1, peak = 0;
    for (let x = 0; x < Math.min(nameW, sbLeft - nameX); x++) {
      if (sbCols.has(x + nameX)) continue;
      for (let yy = 0; yy < h; yy++) {
        const i = ((yi + yy) * W + x + nameX) * 4;
        if (texty(data[i], data[i + 1], data[i + 2])) {
          const mx = Math.max(data[i], data[i + 1], data[i + 2]);
          if (mx >= 150) { sig[yy * nameW + x] = 2; on++; } else sig[yy * nameW + x] = 1;
          peak = Math.max(peak, mx);
        } else if (Math.max(data[i], data[i + 1], data[i + 2]) >= 90) sig[yy * nameW + x] = 1;
        if (x > right && dim(data[i], data[i + 1], data[i + 2])) right = x;
      }
    }
    if (on < 4) continue;   // 空行
    // 结尾渐隐：最后半个图标宽里的最亮像素明显比整行文字暗
    let tail = 0;
    for (let x = Math.max(0, right - Math.round(size * 0.4)); x <= right; x++) for (let yy = 0; yy < h; yy++) {
      const i = ((yi + yy) * W + x + nameX) * 4;
      tail = Math.max(tail, data[i], data[i + 1], data[i + 2]);
    }
    rows.push({ y: yi, cls: iconClass(crop, yi, h, iconW, pitch, size), sig, on, w: nameW, h, right, faded: right > 0 && tail < peak * 0.72 });
  }
  // 名字被截断：放不下的名字都停在同一条截断边附近。截断边 = 至少两行同时停住（±2 像素）的最靠右位置；
  // 截断处正好落在字间空隙时会早停几个像素，所以离截断边不到 0.6 个图标宽的都算；越过截断边的（背景亮点连上了）也算。
  // 只有一行被截断时靠结尾渐隐认出来
  const tol = Math.max(2, Math.round(size * 0.2));
  const rights = rows.map((r) => r.right).filter((x) => x > size * 4).sort((a, b) => b - a);
  const edge = rights.find((x) => rights.filter((y) => y <= x && y >= x - tol).length >= 2) ?? Infinity;
  const near = edge - Math.round(size * 0.6);
  for (const r of rows) r.clipped = r.right > size * 4 && (r.right >= near || (r.faded && r.right >= rights[0] - tol));
  return { rows, phase };
}
// 滚动条滑块所在的列：1–2 像素宽、比两边亮、连续超过两行高的竖线
function scrollCols(crop, x0, pitch) {
  const { data, width: W, height: H } = crop;
  const v = (x, y) => { const i = (y * W + x) * 4; return Math.max(data[i], data[i + 1], data[i + 2]); };
  const cols = new Set();
  for (let x = x0 + 2; x < W - 2; x++) {
    let run = 0;
    for (let y = 0; y < H; y++) {
      const c = v(x, y);
      if (c >= 50 && v(x - 2, y) < c * 0.6 && v(x + 2, y) < c * 0.6) { if (++run > pitch * 2) { cols.add(x); cols.add(x - 1); cols.add(x + 1); break; } } else run = 0;
    }
  }
  return cols;
}
function thinLine(crop, x, y, h) {
  const { data, width: W } = crop;
  const v = (xx, yy) => { const i = (yy * W + xx) * 4; return Math.max(data[i], data[i + 1], data[i + 2]); };
  for (let yy = y; yy < y + h; yy++) {
    const c = v(x, yy);
    if (c < 60 || (x >= 2 && v(x - 2, yy) > c * 0.6) || (x + 2 < W && v(x + 2, yy) > c * 0.6)) return false;
  }
  return true;
}
function rowHasColor(crop, y, iconW) {
  const { data, width: W } = crop;
  for (let x = 0; x < Math.min(W, iconW); x++) { const i = (y * W + x) * 4; if (colored(data[i], data[i + 1], data[i + 2])) return true; }
  return false;
}
// 图标颜色：彩色像素的平均色按色相归类。
// 本地窗口半透明，没有图标的行会透出后面的画面（空间站里的棕色、橙色）：这时图标位置和行与行之间的缝隙是同一种颜色，算没有图标
function iconClass(crop, y, h, iconW, pitch, size) {
  const { data, width: W, height: H } = crop;
  const avg = (ya, yb) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.max(0, ya); yy < Math.min(H, yb); yy++) for (let x = 0; x < Math.min(W, iconW); x++) {
      const i = (yy * W + x) * 4;
      if (colored(data[i], data[i + 1], data[i + 2])) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    }
    return n ? { r: r / n, g: g / n, b: b / n, n } : { n: 0 };
  };
  const c = avg(y, y + h);
  if (c.n < 8) return 'none';
  const { r, g, b } = c;
  // 缝隙：图标上下各一两行（不碰相邻的图标）的平均色（不只算彩色像素：背景在缝隙里常常没那么鲜艳）
  const gapH = Math.max(1, Math.floor((pitch - size) / 2));
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (const yy of [y - 2, y - 1 - gapH, y + size + 1, y + size + gapH].filter((v, i, a) => a.indexOf(v) === i)) {
    if (yy < 0 || yy >= H || (yy >= y && yy < y + size)) continue;
    for (let x = 0; x < Math.min(W, iconW); x++) { const i = (yy * W + x) * 4; gr += data[i]; gg += data[i + 1]; gb += data[i + 2]; gn++; }
  }
  if (gn && Math.abs(gr / gn - r) + Math.abs(gg / gn - g) + Math.abs(gb / gn - b) < 60) return 'none';
  if (r > g * 1.8 && r > b * 1.8) return g < r * 0.45 ? 'red' : 'orange';
  if (r > b * 1.8 && g > b * 1.4 && r >= g) return 'orange';   // 橙 / 黄（声望不良、嫌犯）
  return 'friend';                                               // 蓝、浅蓝、绿、紫等
}

// 两行名字是不是同一个人：文字像素签名的差异占比（允许背景变化造成的少量像素抖动）。
// 行距不是整数像素，滚动后按行距切出来的位置会差 1 像素，所以上下错开 1 像素也比一次
export function sameRow(a, b) {
  if (a.w !== b.w || a.h !== b.h) return false;
  if (Math.abs(a.on - b.on) > Math.max(8, Math.max(a.on, b.on) * 0.4)) return false;   // 亮笔画的多少随画面压缩浮动
  const limit = Math.max(4, Math.min(a.on, b.on) * 0.1), w = a.w, h = a.h;
  for (const dy of [0, 1, -1]) {
    let diff = 0;
    for (let y = 0; y < h && diff <= limit; y++) {
      const yb = y + dy;
      for (let x = 0; x < w; x++) {
        const va = a.sig[y * w + x], vb = yb >= 0 && yb < h ? b.sig[yb * w + x] : 0;
        if ((va === 2 && vb === 0) || (va === 0 && vb === 2)) { if (++diff > limit) break; }
      }
    }
    if (diff <= limit) return true;
  }
  return false;
}

// 截一行名字给文字识别：放大、二值化成白底黑字（返回 RGBA 像素和宽高）
export function rowImage(crop, reg, row, scale = 4) {
  const { data, width: W } = crop;
  const x0 = reg.iconW, w = W - x0, h = Math.round(reg.pitch);
  const y0 = Math.max(0, Math.round(row.y - reg.pitch * 0.12));
  const pad = 10, OW = w * scale + pad * 2, OH = h * scale + pad * 2;
  const out = new Uint8ClampedArray(OW * OH * 4).fill(255);
  for (let y = 0; y < h * scale; y++) {
    const sy = y0 + y / scale;
    const syi = Math.min(crop.height - 1, Math.floor(sy)), fy = sy - Math.floor(sy);
    const syj = Math.min(crop.height - 1, syi + 1);
    for (let x = 0; x < w * scale; x++) {
      const sx = x0 + x / scale;
      const sxi = Math.min(W - 1, Math.floor(sx)), fx = sx - Math.floor(sx), sxj = Math.min(W - 1, sxi + 1);
      const v = (k) => Math.max(data[k], data[k + 1], data[k + 2]);
      const a = v((syi * W + sxi) * 4), b = v((syi * W + sxj) * 4), c = v((syj * W + sxi) * 4), d = v((syj * W + sxj) * 4);
      const lum = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      if (lum > 90) { const o = ((y + pad) * OW + x + pad) * 4; out[o] = out[o + 1] = out[o + 2] = 0; }
    }
  }
  return { data: out, width: OW, height: OH };
}
