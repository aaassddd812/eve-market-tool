// ===== 总览预警：后台线程（module worker）=====
// 和本地红名（local-worker.js）一样，取画面、切行、比签名放在这里（后台标签页里主线程的定时器会被降频），每 0.4 秒看一次框选的区域。
// 画面来源：网页传进来 VideoFrame 流；桌面版发 { t: 'grab', rect } 让主线程截图，主线程传回像素（{ t: 'grabbed' }）。
// 每一行算像素签名（ov-detect.js），和见过的签名比：认得出的给原编号，新的给新编号并把这行的放大图发给主线程做文字识别（{ t: 'ocr' }）。
// 一帧里的行连同编号发给主线程（{ t: 'rows' }，有变化或每秒一次），报警由主线程按识别结果判断。
// 见过的签名最多留 400 个，超出时丢掉最久没出现的。
import { rowsOf, sigOf, sameSig, cellImage } from './ov-detect.js?v=2';

const TICK = 400, KEEP = 400;
let mode = null, reader = null, latest = null;
let canvas = null, c2d = null;
let rect = null;
let timer = 0, busy = false;
let grabId = 0;
const grabs = new Map();
const known = [];   // { id, w, h, v, last }
let seq = 0, lastSent = '', lastSentAt = 0;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.t === 'stream') { stop(); mode = 'stream'; reader = m.stream.getReader(); pump(); start(); }
  else if (m.t === 'grab-mode') { stop(); mode = 'grab'; start(); }
  else if (m.t === 'grabbed') { const p = grabs.get(m.id); grabs.delete(m.id); p?.(m.width ? { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) } : null); }
  else if (m.t === 'rect') { rect = m.rect; lastSent = ''; }
  else if (m.t === 'forget') { known.length = 0; lastSent = ''; }
  else if (m.t === 'snapshot') { const f = await grab(null); self.postMessage({ t: 'snapshot', frame: f }, f ? [f.data.buffer] : []); }
  else if (m.t === 'stop') stop();
};

function start() { clearInterval(timer); timer = setInterval(tick, TICK); }
function stop() {
  clearInterval(timer); timer = 0;
  try { reader?.cancel(); } catch { /* 忽略 */ }
  reader = null;
  latest?.close?.(); latest = null;
  mode = null;
}
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
const clamp = (r, W, H) => { const x = Math.max(0, r.x | 0), y = Math.max(0, r.y | 0); return { x, y, w: Math.min(W, (r.x + r.w) | 0) - x, h: Math.min(H, (r.y + r.h) | 0) - y }; };
async function grab(r) {
  if (mode === 'stream') {
    if (!latest) return null;
    const W = latest.displayWidth, H = latest.displayHeight;
    if (!canvas || canvas.width !== W || canvas.height !== H) { canvas = new OffscreenCanvas(W, H); c2d = canvas.getContext('2d', { willReadFrequently: true }); }
    c2d.drawImage(latest, 0, 0);
    const c = r ? clamp(r, W, H) : { x: 0, y: 0, w: W, h: H };
    if (c.w <= 0 || c.h <= 0) return null;
    const img = c2d.getImageData(c.x, c.y, c.w, c.h);
    return { width: img.width, height: img.height, data: img.data };
  }
  if (mode === 'grab') {
    const id = ++grabId;
    const p = new Promise((res) => { grabs.set(id, res); setTimeout(() => { if (grabs.delete(id)) res(null); }, 3000); });
    self.postMessage({ t: 'grab', id, rect: r || null });
    return p;
  }
  return null;
}

async function tick() {
  if (busy || !rect) return;
  busy = true;
  const t0 = performance.now();
  try {
    const img = await grab(rect);
    if (!img) { self.postMessage({ t: 'status', state: 'noframe' }); return; }
    const now = Date.now();
    const rows = [];
    for (const r of rowsOf(img)) {
      const s = sigOf(img, r);
      let k = known.find((x) => sameSig(x, s));
      if (!k) {
        k = { id: ++seq, ...s, last: now };
        known.push(k);
        if (known.length > KEEP) { known.sort((a, b) => b.last - a.last); known.length = KEEP; }
        const c = cellImage(img, r);
        self.postMessage({ t: 'ocr', id: k.id, img: c }, [c.data.buffer]);
      }
      k.last = now;
      rows.push({ id: k.id, y: r.y0 });
    }
    const key = rows.map((r) => r.id).join(',');
    if (key !== lastSent || now - lastSentAt > 1000) {
      lastSent = key; lastSentAt = now;
      self.postMessage({ t: 'rows', rows, at: now, ms: Math.round(performance.now() - t0), size: [img.width, img.height] });
    }
  } finally {
    busy = false;
  }
}
