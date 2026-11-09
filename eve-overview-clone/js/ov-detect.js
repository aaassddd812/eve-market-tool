// ===== 总览预警：画面处理（纯计算，不碰 DOM；ov-worker.js 用，也能在 node 里测试）=====
// 输入是用户框选的总览「类型」一列的画面 { data: RGBA, width, height }。
// 每个人的总览不一样：字体大小、文字颜色、按声望给行加的底色色块、窗口透明度都不同，所以这里不写死亮度和行高，全部按画面自己算：
//   文字像素：每一条横线取各通道偏暗的那部分当作这条线的底色（色块铺满整行，文字之间总有空隙），和底色差得多的像素是文字；
//     「差多少算文字」用整张图的差值分布自动定（大津法），所以暗淡的文字、彩色底、亮色底都能分出来。
//   行高：先按文字像素的水平投影切出每行，再按行高的中位数（也就是当前字体大小）决定笔画间断多少还算同一行、多矮的算噪点。
// rowsOf：切出每一行文字，返回每行的上下边与左右边。
// sigOf：一行文字的像素签名（文字区域缩成 40×10 格，每格是文字像素的比例），同一个名字每帧的签名几乎一样，用来认出「这一行之前识别过」，
//   不同名字差别大；签名按文字区域缩放，和字体大小无关。
// cellImage：一行文字按字体大小放大到约 44 像素高、转成白底黑字，交给文字识别。

const prepared = new WeakMap();
// 每个像素和所在横线底色的差（三个通道里差得最多的那个），以及区分文字和底色的阈值
function prep(img) {
  let p = prepared.get(img);
  if (p) return p;
  const { data, width: W, height: H } = img;
  const dist = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  const h = [new Uint16Array(256), new Uint16Array(256), new Uint16Array(256)];
  const at = Math.max(0, Math.floor(W * 0.15) - 1);
  for (let y = 0; y < H; y++) {
    const bg = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const hc = h[c];
      hc.fill(0);
      for (let x = 0, i = y * W * 4 + c; x < W; x++, i += 4) hc[data[i]]++;
      // 这条线上偏暗 15% 处的值当底色（总览文字比底色亮，一条线上至少有 15% 是字间空隙）
      let n = 0, v = 0;
      for (; v < 255; v++) { n += hc[v]; if (n > at) break; }
      bg[c] = v;
    }
    for (let x = 0, i = y * W * 4, o = y * W; x < W; x++, i += 4, o++) {
      const d = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
      dist[o] = d;
      hist[d]++;
    }
  }
  p = { W, H, dist, thr: otsu(hist, W * H) };
  prepared.set(img, p);
  return p;
}
// 大津法：把差值分成「底色噪点」和「文字」两堆，取最能分开的位置；至少 28，避免没有文字时把噪点当文字
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 28;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t + 1; }
  }
  return Math.max(28, Math.min(160, thr));
}

function cut(p, hits, gapMax, minH, maxH) {
  const rows = [];
  let y0 = -1, gap = 0;
  for (let y = 0; y <= p.H; y++) {
    const on = y < p.H && hits[y] > 0;
    if (on) { if (y0 < 0) y0 = y; gap = 0; continue; }
    if (y0 < 0) continue;
    if (++gap <= gapMax && y < p.H) continue;
    const y1 = y - gap + 1;
    if (y1 - y0 >= minH && y1 - y0 <= maxH) rows.push({ y0, y1 });
    y0 = -1; gap = 0;
  }
  return rows;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export function rowsOf(img) {
  const p = prep(img), { W, H, dist, thr } = p;
  const hits = new Uint16Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0, o = y * W; x < W; x++, o++) if (dist[o] >= thr) n++;
    hits[y] = n;
  }
  // 先粗切一遍得到字体大小（行高中位数），再按字体大小重切：大字体的汉字横笔之间断得更宽
  let rows = cut(p, hits, 1, 4, 120);
  if (!rows.length) return [];
  const fh = median(rows.map((r) => r.y1 - r.y0));
  rows = cut(p, hits, Math.max(1, Math.round(fh * 0.12)), Math.max(4, Math.round(fh * 0.45)), Math.round(fh * 1.9) + 2);
  for (const r of rows) {
    let x0 = W, x1 = -1;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = 0, o = y * W; x < W; x++, o++) if (dist[o] >= thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    r.x0 = x0; r.x1 = x1 + 1;
  }
  return rows.filter((r) => r.x1 - r.x0 >= Math.max(4, fh * 0.4));
}

const GW = 40, GH = 10;
export function sigOf(img, r) {
  const { W, dist, thr } = prep(img);
  const v = new Uint8Array(GW * GH);
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  for (let gy = 0; gy < GH; gy++) {
    const ya = r.y0 + Math.floor(gy * h / GH), yb = Math.max(ya + 1, r.y0 + Math.floor((gy + 1) * h / GH));
    for (let gx = 0; gx < GW; gx++) {
      const xa = r.x0 + Math.floor(gx * w / GW), xb = Math.max(xa + 1, r.x0 + Math.floor((gx + 1) * w / GW));
      let n = 0, on = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { n++; if (dist[y * W + x] >= thr) on++; }
      v[gy * GW + gx] = Math.round(255 * on / n);
    }
  }
  return { w, h, v };
}
// 两个签名是不是同一个名字：宽高差 6% 以内、每格平均差不到 8%
export function sameSig(a, b) {
  if (Math.abs(a.w - b.w) > Math.max(2, a.w * 0.06) || Math.abs(a.h - b.h) > Math.max(2, a.h * 0.06)) return false;
  let d = 0;
  for (let i = 0; i < a.v.length; i++) d += Math.abs(a.v[i] - b.v[i]);
  return d / a.v.length / 255 < 0.08;
}

export function cellImage(img, r) {
  const { W, H, dist, thr } = prep(img);
  const x0 = Math.max(0, r.x0 - 3), x1 = Math.min(W, r.x1 + 3), y0 = Math.max(0, r.y0 - 3), y1 = Math.min(H, r.y1 + 3);
  const w = x1 - x0, h = y1 - y0, pad = 16;
  // 放大到文字约 44 像素高（小字体放大多些，大字体少些）
  const scale = Math.max(2, Math.min(8, Math.round(44 / Math.max(1, r.y1 - r.y0))));
  // 这一行文字有多「实」：取文字像素差值的高位，用来把笔画拉成纯黑
  const hs = new Uint32Array(256);
  let n = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { const d = dist[y * W + x]; if (d >= thr) { hs[d]++; n++; } }
  let hi = 255;
  for (let v = 255, c = 0; v > 0; v--) { c += hs[v]; if (c >= n * 0.2) { hi = v; break; } }
  const lo = thr * 0.5, span = Math.max(20, hi - lo);
  const OW = w * scale + pad * 2, OH = h * scale + pad * 2;
  const out = new Uint8ClampedArray(OW * OH * 4).fill(255);
  for (let y = 0; y < h * scale; y++) {
    const sy = y0 + y / scale, ya = Math.min(H - 1, Math.floor(sy)), yb = Math.min(H - 1, ya + 1), fy = sy - Math.floor(sy);
    for (let x = 0; x < w * scale; x++) {
      const sx = x0 + x / scale, xa = Math.min(W - 1, Math.floor(sx)), xb = Math.min(W - 1, xa + 1), fx = sx - Math.floor(sx);
      const a = dist[ya * W + xa], b = dist[ya * W + xb], c = dist[yb * W + xa], d = dist[yb * W + xb];
      const t = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      // 底色压成白，文字压成黑，中间按比例拉开
      const v = 255 - Math.max(0, Math.min(255, (t - lo) * 255 / span));
      const o = ((y + pad) * OW + x + pad) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
    }
  }
  return { data: out, width: OW, height: OH };
}
