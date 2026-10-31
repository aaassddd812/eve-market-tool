// ===== 本地红名：后台线程（module worker）=====
// 浏览器后台标签页里主线程的定时器会被降频，所以取画面、找列表、逐行比对都放在这里，每 0.1 秒一次。
// 画面来源：
//   网页：主线程把共享屏幕的视频轨道转成 VideoFrame 流（MediaStreamTrackProcessor）传进来，这里随时取最新一帧；
//   桌面版：这里发 { t: 'grab', rect } 让主线程调 Tauri 命令截 EVE 窗口，主线程把像素传回（{ t: 'grabbed' }）。
// 追踪：按名字那块的文字像素认人（图标闪烁不影响；鼠标停在名字上时按原位置认）；连续两帧都在才算新进本地（过滤一闪而过的杂讯）；
//   认得出的行都朝同一方向移了同样距离、没有原地不动的，是自己滚动了列表；一帧里超过一半的行都换了（换星系、滚得太快）也一样：这批当作基线，不报白名。
//   滚出视野的人先存着（PARK），滚回来时认回原编号：名字不重认、报过的警不再报。位置被别人占了的行马上去掉。
//   每个人最近 0.5 秒里出现过的颜色：红 > 橙 > 友方；红 / 橙要出现满 2 秒、最近 2 秒里四成以上的帧是这个颜色才算（确认前是 pending，
//   本地窗口半透明，后面画面偶尔闪过的红 / 橙过不了）；
//   连续 2 秒都没有图标才算「无图标」（白名，或自己；刚进本地时图标可能晚一点才画出来，不能一进来就当白名）；
//   锁定列表时就在、之后一直没有图标的只有一行时标 mine（当作自己）。
// 发给主线程：{ t: 'status' } 定位状态，{ t: 'rows' } 当前名单（有变化或每秒一次），{ t: 'ocr', id, img } 新出现的人的名字截图，
//   { t: 'options', list } 自动找不到时几个像名单的区域的截图（连同上方的频道标签），给用户选。
import { locate, scanRows, sameRow, rowImage } from './local-detect.js?v=v6';

const TICK = 100, WINDOW = 500, GONE = 1500, RELOCATE = 2000, HITS = 8, CONFIRM = 2000, PARK = 10 * 60e3;
let mode = null;            // 'stream' | 'grab'
let reader = null, latest = null;
let canvas = null, c2d = null;
let manual = null;          // 手动框选的矩形（画面坐标）
let region = null;          // 锁定的列表区域
let lastCrop = null;
let lostAt = 0, lastLocate = 0;
let timer = 0, busy = false;
let seq = 0;
const tracked = [];         // { id, sig, on, w, h, y, clipped, first, last, red, orange, friend, base }
let pending = [];           // { row, n, first }
const parked = [];          // 滚出视野的人（滚回来时认回原编号）
let scrollAt = 0;
let baseUntil = 0, initUntil = 0;
let lastSent = '', lastSentAt = 0;
let grabId = 0;
const grabs = new Map();

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.t === 'stream') { stop(); mode = 'stream'; reader = m.stream.getReader(); pump(); start(); }
  else if (m.t === 'grab-mode') { stop(); mode = 'grab'; start(); }
  else if (m.t === 'grabbed') { const p = grabs.get(m.id); grabs.delete(m.id); p?.(m.width ? { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) } : null); }
  else if (m.t === 'manual') { manual = m.rect; region = null; reset(); }
  else if (m.t === 'relocate') { region = null; reset(); }
  else if (m.t === 'snapshot') { const f = await grab(null, true); self.postMessage({ t: 'snapshot', frame: f }, f ? [f.data.buffer] : []); }
  else if (m.t === 'options') sendOptions();
  else if (m.t === 'reocr') { const t = tracked.find((x) => x.id === m.id); if (t) sendOcr(t); }
  else if (m.t === 'stop') stop();
};

function start() {
  clearInterval(timer);
  reset();
  timer = setInterval(tick, TICK);
}
function stop() {
  clearInterval(timer); timer = 0;
  try { reader?.cancel(); } catch { /* 忽略 */ }
  reader = null;
  latest?.close?.(); latest = null;
  region = null; mode = null;
  reset();
}
function reset() {
  tracked.length = 0; parked.length = 0; pending = []; scrollAt = 0; baseUntil = initUntil = Date.now() + 1500; lastSent = ''; lostAt = 0;
}

// 网页：一直读视频流，只留最新一帧
async function pump() {
  const r = reader;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done || r !== reader) { value?.close(); break; }
      latest?.close();
      latest = value;
    }
  } catch { /* 共享被停止 */ }
  if (r === reader) self.postMessage({ t: 'ended' });
}

// 取画面：rect 为空取整帧；front：桌面版截不到被挡住的 EVE 时临时把它提到最上面（手动框选用）
async function grab(rect, front = false) {
  if (mode === 'stream') {
    if (!latest) return null;
    const W = latest.displayWidth, H = latest.displayHeight;
    if (!canvas || canvas.width !== W || canvas.height !== H) { canvas = new OffscreenCanvas(W, H); c2d = canvas.getContext('2d', { willReadFrequently: true }); }
    c2d.drawImage(latest, 0, 0);
    const r = rect ? clamp(rect, W, H) : { x: 0, y: 0, w: W, h: H };
    if (r.w <= 0 || r.h <= 0) return null;
    const img = c2d.getImageData(r.x, r.y, r.w, r.h);
    return { width: img.width, height: img.height, data: img.data, fw: W, fh: H };
  }
  if (mode === 'grab') {
    const id = ++grabId;
    const p = new Promise((res) => { grabs.set(id, res); setTimeout(() => { if (grabs.delete(id)) res(null); }, 3000); });
    self.postMessage({ t: 'grab', id, rect: rect || null, front });
    return p;
  }
  return null;
}
const clamp = (r, W, H) => { const x = Math.max(0, r.x | 0), y = Math.max(0, r.y | 0); return { x, y, w: Math.min(W, (r.x + r.w) | 0) - x, h: Math.min(H, (r.y + r.h) | 0) - y }; };
const full = () => grab(null);

async function tick() {
  if (busy) return;
  busy = true;
  const t0 = performance.now();
  try {
    const now = Date.now();
    if (!region) {
      if (now - lastLocate < RELOCATE && lastLocate) return;
      lastLocate = now;
      const f = await full();
      if (!f) { status('noframe'); return; }
      const L = locate(f, manual ? { within: manual } : {});
      if (!L.found) { status(manual ? 'manual-miss' : 'locating', { candidates: L.candidates }); return; }
      region = L.region;
      reset();
      status('locked', { region, score: L.score, frame: [f.width, f.height], ms: Math.round(performance.now() - t0) });
      return;
    }
    const crop = await grab(region);
    if (!crop) { status('noframe'); return; }
    lastCrop = crop;
    const res = scanRows(crop, region);
    region.phase = res.phase;
    // 区域里没有名字了（窗口挪走、关掉、被挡住）：两秒后重新找
    if (!res.rows.length) {
      if (!lostAt) lostAt = now;
      if (now - lostAt > RELOCATE) { region = null; status('lost'); }
      return;
    }
    lostAt = 0;
    track(res.rows, now);
    send(now, Math.round((performance.now() - t0) * 10) / 10, res.rows.some((r) => r.clipped));
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}

function status(state, extra = {}) { self.postMessage({ t: 'status', state, ...extra }); }

// 认人：和最近一帧的签名比，也和最后一次静止时的签名比（滚动中途画面模糊，最近一帧的签名可能已经走样）
const same = (t, row) => sameRow(t, row) || Boolean(t.sig0 && sameRow({ w: t.w, h: t.h, sig: t.sig0, on: t.on0 }, row));

function track(rows, now) {
  const used = new Set(), fresh = [], moves = [];
  for (const row of rows) {
    const t = tracked.find((x) => !used.has(x.id) && same(x, row));
    if (t) {
      used.add(t.id);
      moves.push(row.y - t.y);
      Object.assign(t, { sig: row.sig, on: row.on, y: row.y, clipped: row.clipped, last: now });
      stamp(t, row.cls, now);
    } else fresh.push(row);
  }
  // 滚动：认得出的行大多朝同一方向移了同样的距离，而且没有原地不动的（有人进出时插入点上面的行不动）
  const pitch = region.pitch, shift = new Map();
  let still = 0;
  for (const d of moves) if (Math.abs(d) >= pitch * 0.4) { const k = Math.round(d / pitch); shift.set(k, (shift.get(k) || 0) + 1); } else still++;
  const most = Math.max(0, ...shift.values());
  const scrolled = moves.length >= 3 && most >= moves.length * 0.8 && !still;
  // 大半都换了（换星系、滚动太快一帧里认不出几个）也一样：这批算基线
  if (scrolled || (rows.length >= 4 && fresh.length > rows.length * 0.5)) { baseUntil = now + 1000; scrollAt = now; }
  else for (const t of tracked) if (used.has(t.id)) { t.sig0 = t.sig; t.on0 = t.on; }
  // 没在滚动时，原位置上的名字只是变了样（鼠标停在名字上、行被高亮）：还是那个人
  if (!scrolled) for (let i = fresh.length - 1; i >= 0; i--) {
    const row = fresh[i];
    const t = tracked.find((x) => !used.has(x.id) && now - x.last <= TICK * 3 && Math.abs(x.y - row.y) < pitch * 0.3);
    if (!t) continue;
    used.add(t.id);
    Object.assign(t, { sig: row.sig, on: row.on, clipped: row.clipped, last: now });
    stamp(t, row.cls, now);
    fresh.splice(i, 1);
  }
  const next = [];
  for (const row of fresh) {
    const p = pending.find((x) => sameRow(x.row, row));
    if (p && p.n >= 1) {
      // 滚出去又滚回来的人：认回原来的编号（名字、颜色、报过警都保留）；不是在滚动时出现的算重新进本地
      const k = now - scrollAt < 2000 ? parked.findIndex((x) => same(x, row)) : -1;
      if (k >= 0) {
        const t = parked.splice(k, 1)[0];
        Object.assign(t, { sig: row.sig, on: row.on, y: row.y, clipped: row.clipped, last: now });
        stamp(t, row.cls, now);
        tracked.push(t);
        used.add(t.id);
        continue;
      }
      const t = { id: ++seq, sig: row.sig, on: row.on, w: row.w, h: row.h, y: row.y, clipped: row.clipped, first: p.first, last: now, red: 0, orange: 0, friend: 0, hist: [], base: now < baseUntil, init: now < initUntil };
      stamp(t, p.cls, p.at);
      stamp(t, row.cls, now);
      tracked.push(t);
      used.add(t.id);
      sendOcr(t);
    } else next.push({ row, n: 1, first: p?.first || now, cls: row.cls, at: now });
  }
  pending = next;
  // 这一帧没看到的人：位置已经被别人占了就马上去掉，否则等 GONE 毫秒（偶尔一两帧没认出）。
  // 滚动中消失的是滚出了视野，不是离开本地：先存着，滚回来时认回去
  for (let i = tracked.length - 1; i >= 0; i--) {
    const t = tracked[i];
    if (used.has(t.id)) continue;
    const taken = rows.some((r) => Math.abs(r.y - t.y) < pitch * 0.5);
    if (!taken && now - t.last <= GONE) continue;
    tracked.splice(i, 1);
    if (now - scrollAt < GONE + 1000) { parked.push(t); t.parkedAt = now; }
  }
  for (let i = parked.length - 1; i >= 0; i--) if (now - parked[i].parkedAt > PARK) parked.splice(i, 1);
}
// 每种颜色记最后一次看到的时间、有图标的累计帧数，另留最近 CONFIRM 毫秒里每帧的颜色（hist）
function stamp(t, cls, at) {
  if (cls === 'red') t.red = at; else if (cls === 'orange') t.orange = at; else if (cls === 'friend') t.friend = at;
  if (cls !== 'none') t.iconN = (t.iconN || 0) + 1;   // 累计有图标的帧数（mine：一直没有图标的才当自己）
  (t.hist ||= []).push({ at, cls });
  while (t.hist.length && at - t.hist[0].at > CONFIRM) t.hist.shift();
}
// 红 / 橙要确认：出现满 CONFIRM 毫秒，且最近 CONFIRM 毫秒里至少 HITS 帧、四成以上的帧是这个颜色、比友方图标多一倍
// （透明窗口后面的画面偶尔闪过一片红 / 橙、列表滚动时的杂色都过不了；图标闪烁时一半的帧亮，能过）。确认过的之后看到就算
function sure(t, color, now) {
  if (t.ok?.[color]) return true;
  const h = t.hist || [];
  const n = h.filter((x) => x.cls === color).length, f = h.filter((x) => x.cls === 'friend').length;
  if (now - t.first < CONFIRM || n < HITS || n < h.length * 0.4 || n <= f * 2) return false;
  (t.ok ||= {})[color] = true;
  return true;
}
function clsOf(t, now) {
  if (now - t.red <= WINDOW && sure(t, 'red', now)) return 'red';
  if (now - t.orange <= WINDOW && sure(t, 'orange', now)) return 'orange';
  if (now - t.red <= WINDOW || now - t.orange <= WINDOW) {
    const h = t.hist || [];
    if (h.filter((x) => x.cls === 'friend').length < h.filter((x) => x.cls === 'red' || x.cls === 'orange').length) return 'pending';
  }
  if (now - t.friend <= WINDOW) return 'friend';
  // 白名也要确认：从出现（或最后一次看到图标）起 CONFIRM 毫秒都没有图标
  return now - Math.max(t.first, t.red, t.orange, t.friend) >= CONFIRM ? 'none' : 'pending';
}

function send(now, ms, clipped) {
  // mine：开始监视（锁定列表）时就在、一直没看到过图标（偶尔一两帧认错不算）
  // 开始监视时就在、一直没有图标的只有一个人时才当作自己（有好几个说明里面有真白名，等认出名字再说）
  const alone = tracked.filter((t) => t.init && (t.iconN || 0) < 3);
  const rows = tracked.map((t) => ({ id: t.id, cls: clsOf(t, now), y: t.y, clipped: t.clipped, base: t.base, first: t.first, mine: alone.length === 1 && alone[0] === t })).sort((a, b) => a.y - b.y);
  const key = rows.map((r) => r.id + r.cls + (r.clipped ? '!' : '') + (r.mine ? 'm' : '')).join(',');
  if (key === lastSent && now - lastSentAt < 1000) return;
  lastSent = key; lastSentAt = now;
  self.postMessage({ t: 'rows', rows, ms, clipped, at: now });
}

function sendOcr(t) {
  if (!lastCrop || !region) return;
  const img = rowImage(lastCrop, region, t);
  self.postMessage({ t: 'ocr', id: t.id, clipped: t.clipped, img }, [img.data.buffer]);
}

// 自动找不到时：几个像名单的区域，各截一张图（往上多截几行，带上频道标签，最多 14 行高）
async function sendOptions() {
  const f = await full();
  const L = f ? locate(f, {}) : null;
  const list = [];
  for (const r of L?.options || []) {
    const x = Math.max(0, r.x - r.size), y = Math.max(0, Math.round(r.y - r.pitch * 4));
    const w = Math.min(f.width, r.x + r.w + r.size) - x, h = Math.min(f.height, Math.round(r.y + Math.min(r.h, r.pitch * 10))) - y;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) data.set(f.data.subarray(((y + yy) * f.width + x) * 4, ((y + yy) * f.width + x + w) * 4), yy * w * 4);
    // 选中后按手动框选处理：框住整个区域，四周留一个图标宽
    list.push({ rect: { x: r.x - r.size, y: r.y - r.size, w: r.w + r.size * 2, h: r.h + r.size * 2 }, img: { width: w, height: h, data } });
  }
  self.postMessage({ t: 'options', list }, list.map((o) => o.img.data.buffer));
}
