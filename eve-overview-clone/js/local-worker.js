// ===== 本地红名：后台线程（module worker）=====
// 浏览器后台标签页里主线程的定时器会被降频，所以取画面、找列表、逐行比对都放在这里，每 0.1 秒一次。
// 画面来源：
//   网页：主线程把共享屏幕的视频轨道转成 VideoFrame 流（MediaStreamTrackProcessor）传进来，这里随时取最新一帧；
//   桌面版：这里发 { t: 'grab', rect } 让主线程调 Tauri 命令截 EVE 窗口，主线程把像素传回（{ t: 'grabbed' }）。
// 追踪：按名字那块的文字像素认人（图标闪烁不影响）；连续两帧都在才算新进本地（过滤一闪而过的杂讯）；
//   一帧里超过一半的行都换了（换星系、自己滚动了列表）就把这批当作基线，不报警。
//   每个人最近 0.5 秒里出现过的颜色：红 > 橙 > 友方；红 / 橙要从第一次看到起持续 2 秒、累计 8 帧以上、且是友方图标次数的两倍以上才算（确认前是 pending）；
//   0.5 秒都没有图标才算「无图标」（白名，或自己）；锁定列表时就在、之后一直没有图标的那一行标 mine（当作自己）。
// 发给主线程：{ t: 'status' } 定位状态，{ t: 'rows' } 当前名单（有变化或每秒一次），{ t: 'ocr', id, img } 新出现的人的名字截图，
//   { t: 'options', list } 自动找不到时几个像名单的区域的截图（连同上方的频道标签），给用户选。
import { locate, scanRows, sameRow, rowImage } from './local-detect.js?v=v2';

const TICK = 100, WINDOW = 500, GONE = 1500, RELOCATE = 2000, HITS = 8, CONFIRM = 2000;
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
  else if (m.t === 'snapshot') { const f = await full(); self.postMessage({ t: 'snapshot', frame: f }, f ? [f.data.buffer] : []); }
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
  tracked.length = 0; pending = []; baseUntil = initUntil = Date.now() + 1500; lastSent = ''; lostAt = 0;
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

// 取画面：rect 为空取整帧
async function grab(rect) {
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
    self.postMessage({ t: 'grab', id, rect: rect || null });
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

function track(rows, now) {
  const used = new Set(), fresh = [];
  for (const row of rows) {
    const t = tracked.find((x) => !used.has(x.id) && sameRow(x, row));
    if (t) {
      used.add(t.id);
      Object.assign(t, { sig: row.sig, on: row.on, y: row.y, clipped: row.clipped, last: now });
      stamp(t, row.cls, now);
    } else fresh.push(row);
  }
  // 大半都换了：换星系或滚动了列表，这批算基线
  if (rows.length >= 4 && fresh.length > rows.length * 0.5) baseUntil = now + 1000;
  const next = [];
  for (const row of fresh) {
    const p = pending.find((x) => sameRow(x.row, row));
    if (p && p.n >= 1) {
      const t = { id: ++seq, sig: row.sig, on: row.on, w: row.w, h: row.h, y: row.y, clipped: row.clipped, first: p.first, last: now, red: 0, orange: 0, friend: 0, redN: 0, orangeN: 0, friendN: 0, red0: 0, orange0: 0, base: now < baseUntil, init: now < initUntil };
      stamp(t, p.cls, p.at);
      stamp(t, row.cls, now);
      tracked.push(t);
      sendOcr(t);
    } else next.push({ row, n: 1, first: p?.first || now, cls: row.cls, at: now });
  }
  pending = next;
  for (let i = tracked.length - 1; i >= 0; i--) if (now - tracked[i].last > GONE) tracked.splice(i, 1);
}
// 每种颜色记第一次、最后一次看到的时间和累计次数
function stamp(t, cls, at) {
  if (cls === 'red') { t.red = at; t.redN++; t.red0 ||= at; } else if (cls === 'orange') { t.orange = at; t.orangeN++; t.orange0 ||= at; } else if (cls === 'friend') { t.friend = at; t.friendN++; }
}
// 红 / 橙要确认：从第一次看到起持续 CONFIRM 毫秒、累计至少 HITS 帧，且是友方图标次数的两倍以上（偶尔几帧颜色认错、画面切换、列表滚动时的杂色都不算）
const sure = (n, first, last, t) => n >= HITS && last - first >= CONFIRM && n > t.friendN * 2;
function clsOf(t, now) {
  if (now - t.red <= WINDOW && sure(t.redN, t.red0, t.red, t)) return 'red';
  if (now - t.orange <= WINDOW && sure(t.orangeN, t.orange0, t.orange, t)) return 'orange';
  if (now - t.red <= WINDOW || now - t.orange <= WINDOW) { if (t.friendN < t.redN + t.orangeN) return 'pending'; }
  if (now - t.friend <= WINDOW) return 'friend';
  return now - t.first >= WINDOW ? 'none' : 'pending';
}

function send(now, ms, clipped) {
  // mine：开始监视（锁定列表）时就在、一直没看到过图标（偶尔一两帧认错不算）
  const rows = tracked.map((t) => ({ id: t.id, cls: clsOf(t, now), y: t.y, clipped: t.clipped, base: t.base, first: t.first, mine: t.init && t.redN + t.orangeN + t.friendN < 3 })).sort((a, b) => a.y - b.y);
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
