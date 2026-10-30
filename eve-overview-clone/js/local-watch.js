// ===== 本地红名（右上角铃铛「预警」弹窗的「本地红名」标签页）=====
// 用户点「开始」后选择共享 EVE 窗口（浏览器 getDisplayMedia，只在本机处理，不上传），后台线程（local-worker.js）每 0.1 秒看一次本地频道成员列表：
//   自动找到本地列表（local-detect.js：一列声望图标 + 上方频道标签的「本」字）；找了 8 秒找不到时把几个像名单的地方截图列出来让用户点选，
//   都不是再让用户在整张截图上自己框选（选定的区域记在设置里，之后只在里面找）；
//   红 / 橙图标（声望恶劣 / 不良、嫌犯等）一出现就报警；无图标（白名、中立）可选报警，要等名字认出来、确认不是自己之后才报。
// 名字：新出现的人把名字那一行截下来交给文字识别（Tesseract.js，js/vendor/tesseract，本地运行），再用 ESI /universe/ids/ 换成角色；
//   查不到（认错字母）或名字被截断（列表太窄）时在本站击杀记录里搜相近的名字（/api/kb/search），只有一个最像的才认，否则标「…?」，并提示把列表拉宽。
//   认出角色后查所属军团 / 联盟（standings.js）与近 30 天击杀记录（/api/v1/pilots），显示在名单与悬浮窗里。
// 自己：已绑定 ESI 的角色名 + 名单里手动点「这是我」的名字，不报警。
// 提醒方式：提示音、网页卡片、系统通知、企业微信 / 邮箱（alert-push.js）、悬浮窗（float-feed.js 的 local 一栏）。
// 设置存在 eve-localwatch-v1（不分服务器）。共享画面每次打开网页都要重新选择（浏览器规定），不会自动恢复。

import * as AP from './alert-push.js?v=v2';
import * as ST from './standings.js?v=v4';
import * as FF from './float-feed.js?v=v2';
import { SERVER, IS_TQ } from './server.js?v=s4';

let ctx;   // esc, showToast, resolveNames, resolveTypeNames, selfNames()
const KEY = 'eve-localwatch-v1';
const DEFAULTS = { red: true, orange: true, neutral: false, sound: true, web: true, notify: false, me: [] };
const T = { ...DEFAULTS };
const S = {
  stream: null, worker: null, video: null, canvas: null, state: 'off', region: null, since: 0, ms: 0, clipped: false,
  rows: [], people: new Map(), log: [], lastAlert: 0, alertTimer: 0, pick: null,
  options: undefined   // 自动找不到时给用户选的区域：undefined 还没截，null 正在截，[] 截好了
};
const OCR_BASE = new URL('./vendor/tesseract/', import.meta.url).href;
const WHITE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -\'.';
const CLS = { red: '红名', orange: '橙名', friend: '友方', none: '白名', pending: '…' };
const subs = new Set();

try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 忽略 */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 忽略 */ } };

export function initLocalWatch(context) {
  ctx = context;
  AP.onPushChange(renderPanel);
  ST.onStandings(renderPanel);
}
export function onChange(fn) { subs.add(fn); }
function notify() {
  // 报警后名字、击杀记录陆续查到：补进最近的报警与卡片
  for (const e of S.log) {
    if (Date.now() - e.at > 60e3) break;
    e.names = e.ids.map((id, i) => S.people.get(id)?.name || e.names[i] || '?');
    paintCard(e);
  }
  for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } }
  renderPanel();
  publishFloat();
}
export const supported = () => Boolean(navigator.mediaDevices?.getDisplayMedia);
const running = () => Boolean(S.stream);
const STATE_TEXT = {
  off: '未开启', starting: '正在启动…', locating: '正在找本地频道…', 'manual-miss': '框选的区域里没找到成员列表，请重新框选',
  noframe: '没有收到画面', lost: '本地列表不见了，正在重新找…', locked: '监视中'
};
export function status() {
  const on = running();
  const reds = S.rows.filter((r) => r.cls === 'red' || r.cls === 'orange').length;
  let text = on ? STATE_TEXT[S.state] || S.state : '本地红名未开启';
  if (on && S.state === 'locked') text = `监视中 · 本地 ${S.rows.length} 人${reds ? ` · 红名 ${reds}` : ''}`;
  return { on, alert: on && reds > 0, text };
}

// ---------- 开始 / 停止 ----------
async function start() {
  if (running()) return;
  if (!supported()) { ctx.showToast('这个浏览器不能共享画面：请用电脑版 Chrome / Edge', 'error'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 }, displaySurface: 'window' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
  } catch {
    ctx.showToast('没有共享画面', 'info');
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  S.stream = stream;
  S.state = 'starting';
  S.since = Date.now();
  S.options = undefined;
  S.rows = []; S.people.clear();
  track.addEventListener('ended', stop);
  const w = new Worker(new URL('./local-worker.js?v=v2', import.meta.url), { type: 'module' });
  S.worker = w;
  w.onmessage = onWorker;
  // Chrome / Edge：视频帧直接交给后台线程；其他浏览器：后台线程要画面时由这里从 <video> 截
  if (typeof window.MediaStreamTrackProcessor === 'function') {
    const proc = new window.MediaStreamTrackProcessor({ track });
    w.postMessage({ t: 'stream', stream: proc.readable }, [proc.readable]);
  } else {
    S.video = document.createElement('video');
    S.video.muted = true;
    S.video.srcObject = stream;
    await S.video.play().catch(() => {});
    w.postMessage({ t: 'grab-mode' });
  }
  if (T.manual) w.postMessage({ t: 'manual', rect: T.manual });
  notify();
}
function stop() {
  S.worker?.postMessage({ t: 'stop' });
  S.worker?.terminate();
  S.worker = null;
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  if (S.video) { S.video.srcObject = null; S.video = null; }
  S.state = 'off';
  S.rows = []; S.people.clear();
  closePick();
  notify();
}

function grabFromVideo(rect) {
  const v = S.video;
  if (!v || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight;
  if (!S.canvas) S.canvas = document.createElement('canvas');
  if (S.canvas.width !== W || S.canvas.height !== H) { S.canvas.width = W; S.canvas.height = H; }
  const c = S.canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(v, 0, 0);
  const r = rect ? { x: Math.max(0, rect.x | 0), y: Math.max(0, rect.y | 0), w: Math.min(W, rect.x + rect.w | 0) - Math.max(0, rect.x | 0), h: Math.min(H, rect.y + rect.h | 0) - Math.max(0, rect.y | 0) } : { x: 0, y: 0, w: W, h: H };
  if (r.w <= 0 || r.h <= 0) return null;
  return c.getImageData(r.x, r.y, r.w, r.h);
}

function onWorker(e) {
  const m = e.data || {};
  if (m.t === 'grab') {
    const img = grabFromVideo(m.rect);
    S.worker?.postMessage(img ? { t: 'grabbed', id: m.id, width: img.width, height: img.height, buffer: img.data.buffer } : { t: 'grabbed', id: m.id }, img ? [img.data.buffer] : []);
  } else if (m.t === 'status') {
    const prev = S.state;
    S.state = m.state;
    if (m.state === 'locked') { S.region = m.region; S.options = undefined; }
    if (m.state === 'locked' || m.state === 'lost') { S.rows = []; S.people.clear(); }
    if (m.state === 'lost') S.since = Date.now();
    // 找了 8 秒还没找到：截几个像名单的地方给用户选
    if (m.state === 'locating' && S.options === undefined && Date.now() - S.since > 8000) askOptions();
    if (prev !== m.state) notify();
  } else if (m.t === 'rows') onRows(m);
  else if (m.t === 'ocr') ocrRow(m);
  else if (m.t === 'snapshot') showPick(m.frame);
  else if (m.t === 'options') {
    S.options = m.list.map((o) => ({ rect: o.rect, src: toUrl(o.img) }));
    notify();
  }
  else if (m.t === 'ended') stop();
}

// ---------- 名单与报警 ----------
const isMe = (name) => {
  const n = String(name || '').toLowerCase();
  return Boolean(n) && [...(ctx.selfNames?.() || []), ...T.me].some((x) => String(x).toLowerCase() === n);
};
const newPerson = (id) => ({ id, name: '', raw: '', look: 'ocr', alerted: false, first: Date.now(), cls: 'pending', y: 0 });
const alarming = (cls) => (cls === 'red' && T.red) || (cls === 'orange' && T.orange);

function onRows(m) {
  S.ms = m.ms;
  S.clipped = m.clipped;
  const alive = new Set();
  const fire = [];
  for (const r of m.rows) {
    alive.add(r.id);
    let p = S.people.get(r.id);
    if (!p) { p = newPerson(r.id); S.people.set(r.id, p); }
    p.first = r.first;
    Object.assign(p, { cls: r.cls, y: r.y, clipped: r.clipped, base: r.base });
    if (!p.alerted && !p.self && alarming(r.cls)) { p.alerted = true; fire.push(p); }
    // 白名：认出名字、确认不是自己后才报（基线里的不报：刚开始监视或换了星系）
    if (!p.alerted && T.neutral && r.cls === 'none' && !r.base && p.look !== 'ocr' && !p.self) { p.alerted = true; fire.push(p); }
  }
  for (const id of S.people.keys()) if (!alive.has(id)) S.people.delete(id);
  S.rows = m.rows;
  if (fire.length) raise(fire);
  notify();
}

function raise(list) {
  const reds = list.filter((p) => p.cls === 'red' || p.cls === 'orange');
  const title = reds.length ? `本地出现 ${reds.length} 个红名` : `本地来了 ${list.length} 个白名`;
  const at = Date.now();
  const entry = { at, ids: list.map((p) => p.id), names: [], cls: reds.length ? 'red' : 'none', n: list.length, title };
  S.log.unshift(entry);
  S.log.length = Math.min(S.log.length, 30);
  S.lastAlert = at;
  clearTimeout(S.alertTimer);
  S.alertTimer = setTimeout(notify, 61e3);
  if (T.sound) beep(reds.length ? 4 : 2);
  if (T.web) card(entry);
  // 名字要等文字识别（一般不到 1 秒），系统通知与微信 / 邮箱等名字认出来再发，最多等 2 秒
  const t0 = Date.now();
  const later = () => {
    const ps = entry.ids.map((id) => S.people.get(id)).filter(Boolean);
    if (ps.some((p) => p.look === 'ocr') && Date.now() - t0 < 2000) { setTimeout(later, 200); return; }
    entry.names = ps.map((p) => p.name || '?');
    const body = entry.names.join('、');
    if (T.notify && window.Notification?.permission === 'granted') {
      try { const n = new Notification(title, { body, tag: 'eve-local', renotify: true }); n.onclick = () => window.focus(); } catch { /* 忽略 */ }
    }
    if (!list[0].test) AP.push('local', { sig: 'local|' + at + '|' + body, text: `${title} · ${body}` });
    notify();
  };
  setTimeout(later, 200);
}

function beep(n) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < n; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = i % 2 ? 660 : 990;
      const t0 = ac.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + 0.15);
    }
    setTimeout(() => ac.close(), 1500);
  } catch { /* 浏览器不允许自动播放 */ }
}

let layer = null;
function card(entry) {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'ka-layer';
    layer.innerHTML = '<div class="ka-cards lw-cards" aria-live="assertive"></div>';
    document.body.appendChild(layer);
    layer.addEventListener('click', (e) => { const c = e.target.closest('.ka-card'); if (c) c.remove(); });
  }
  const box = layer.querySelector('.ka-cards');
  const el = document.createElement('div');
  el.className = 'ka-card lw-card' + (entry.cls === 'red' ? ' here' : '');
  el.dataset.lwAt = entry.at;
  box.prepend(el);
  paintCard(entry);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.remove(), 30e3);
}
function paintCard(entry) {
  const el = layer?.querySelector(`[data-lw-at="${entry.at}"]`);
  if (!el) return;
  const ps = entry.ids.map((id) => S.people.get(id)).filter(Boolean);
  el.innerHTML = `<div class="ka-head"><span class="ka-badge">本地</span><b>${ctx.esc(entry.title)}</b><button class="ka-close" data-ka-close aria-label="关闭">×</button></div>
    <div class="ka-body">${ps.length ? ps.map((p) => `<span class="lw-card-who"><i class="lw-dot ${p.cls}"></i>${p.name ? `<span translate="no">${ctx.esc(p.name)}</span>` : '<span>识别中…</span>'}${p.st ? ` <small>${statLine(p)}</small>` : ''}</span>`).join('') : ctx.esc(entry.names.join('、'))}</div>
    <div class="ka-meta">${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>`;
}

// ---------- 文字识别 → 角色 → 击杀记录 ----------
let ocr = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('文字识别加载失败')); document.head.append(s); });
}
function ocrWorker() {
  if (!ocr) {
    ocr = (async () => {
      if (!window.Tesseract) await loadScript(OCR_BASE + 'tesseract.min.js');
      const w = await window.Tesseract.createWorker('eng', 1, { workerPath: OCR_BASE + 'worker.min.js', corePath: OCR_BASE + 'core/', langPath: OCR_BASE + 'lang/', workerBlobURL: false });
      await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: WHITE, preserve_interword_spaces: '1' });
      return w;
    })().catch((e) => { ocr = null; throw e; });
  }
  return ocr;
}
// 识别排队（一个识别线程，一次一行）
let ocrQ = Promise.resolve();
function ocrRow(m) {
  // 识别请求比名单（rows）先到：先建好这个人
  if (!S.people.has(m.id)) S.people.set(m.id, newPerson(m.id));
  ocrQ = ocrQ.then(async () => {
    const p = S.people.get(m.id);
    if (!p) return;
    try {
      const w = await ocrWorker();
      const c = document.createElement('canvas');
      c.width = m.img.width; c.height = m.img.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.img.data.buffer || m.img.data), m.img.width, m.img.height), 0, 0);
      const { data } = await w.recognize(c);
      p.raw = cleanName(data.text);
    } catch (e) {
      console.warn('本地红名：文字识别失败', e);
      p.raw = '';
    }
    p.clipped = m.clipped;
    p.self = isMe(p.raw);
    p.name = p.raw;
    p.look = p.raw ? 'look' : 'miss';
    notify();
    if (p.raw) identify(p).catch(() => {});
  });
}
// 编辑距离（文字识别认错的字母数）
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

// 名字 → 角色 ID：完整名字先查 ESI；查不到（文字识别认错一两个字母）或名字被截断时在本站按开头几个字母搜，
// 和识别结果最像（编辑距离最小、且在容许范围内）的只有一个才认；截断的名字只比较能看到的那一段。
// 多个同样像的（常是同一人的一串小号）不猜：显示识别到的文字并标「…?」，免得显示别人的击杀记录
async function identify(p) {
  let id = 0, cand = 0;
  if (!p.clipped) id = (await ST.idsByName([p.raw])).get(p.raw.toLowerCase()) || 0;
  if (!id) {
    const pre = (p.clipped ? p.raw.slice(0, -1) : p.raw).trim().toLowerCase();
    const tol = Math.max(1, Math.floor(pre.length * 0.2));
    for (const q of [...new Set([pre, pre.slice(0, 4)])]) {
      if (q.length < 3) continue;
      const d = await fetch('/api/kb/search?q=' + encodeURIComponent(q) + (IS_TQ ? '' : '&server=' + SERVER.id)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      const hits = (d.results || []).filter((x) => x.category === 'character')
        .map((x) => ({ ...x, d: lev(pre, (p.clipped ? x.name.slice(0, pre.length) : x.name).toLowerCase()) })).filter((x) => x.d <= tol);
      if (!hits.length) continue;
      const best = Math.min(...hits.map((x) => x.d));
      const top = hits.filter((x) => x.d === best);
      cand = top.length;
      if (top.length === 1) { id = top[0].id; p.name = top[0].name; }
      break;
    }
  }
  if (!S.people.has(p.id)) return;
  p.charId = id;
  p.cand = cand;
  p.look = id ? 'ok' : 'miss';
  if (!p.self && isMe(p.name)) p.self = true;
  notify();
  if (!id) return;
  const aff = (await ST.affiliation([id])).get(id) || {};
  p.corp = aff.corp || 0;
  p.alliance = aff.alliance || 0;
  const { names } = await ctx.resolveNames([p.corp, p.alliance].filter(Boolean));
  p.corpName = names.get(p.corp) || '';
  p.allianceName = names.get(p.alliance) || '';
  notify();
  const res = await fetch('/api/v1/pilots?ids=' + id + (IS_TQ ? '' : '&server=' + SERVER.id)).catch(() => null);
  const d = res?.ok ? await res.json().catch(() => ({})) : {};
  p.st = d.pilots?.[id] || { kills: 0, losses: 0, solo: 0, ships: [] };
  const ships = (p.st.ships || []).slice(0, 3).map(([t]) => t);
  const types = ships.length ? await ctx.resolveTypeNames(ships).catch(() => new Map()) : new Map();
  p.ships = ships.map((t) => types.get(t) || '#' + t);
  notify();
}
const statLine = (p) => (p.st ? `近 30 天 击杀 ${p.st.kills} · 损失 ${p.st.losses}${p.ships?.length ? ' · ' + p.ships.join(' / ') : ''}` : '');

// ---------- 悬浮窗 ----------
function publishFloat() {
  if (!FF.isOpen('local') && !S.floatOn) return;
  FF.publish('local', floatData());
}
export function floatData() {
  const st = status();
  const people = [...S.people.values()].filter((p) => !p.self).sort((a, b) => rank(a) - rank(b) || a.y - b.y);
  return {
    on: st.on, status: st.text, clipped: S.clipped, n: S.rows.length,
    items: people.map((p) => ({
      id: p.charId || 0, key: p.id, cls: p.cls, name: p.name || '', sure: Boolean(p.charId) || !p.clipped, look: p.look, clipped: p.clipped,
      org: [p.allianceName, p.corpName].filter(Boolean).join(' · '),
      st: p.st ? { kills: p.st.kills, losses: p.st.losses, solo: p.st.solo || 0, ships: p.ships || [], last: p.st.last || '' } : null,
      fresh: !p.base && Date.now() - p.first < 60e3
    }))
  };
}
const rank = (p) => ({ red: 0, orange: 1, none: 2, pending: 3, friend: 4 }[p.cls] ?? 5);
export function startFloat() { S.floatOn = true; publishFloat(); }

// ---------- 从截图里选 / 手动框选 ----------
function askOptions() {
  S.options = null;
  S.worker?.postMessage({ t: 'options' });
  notify();
}
function toUrl(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer || img.data), img.width, img.height), 0, 0);
  return c.toDataURL();
}
function useRect(rect) {
  if (rect) T.manual = rect; else delete T.manual;
  save();
  S.since = Date.now();
  S.options = undefined;
  S.worker?.postMessage({ t: 'manual', rect: rect || null });
  notify();
}
function askPick() {
  if (!S.worker) return;
  S.worker.postMessage({ t: 'snapshot' });
}
function showPick(frame) {
  if (!frame) { ctx.showToast('还没有收到画面', 'error'); return; }
  closePick();
  const wrap = document.createElement('div');
  wrap.className = 'lw-pick';
  wrap.innerHTML = `<div class="lw-pick-bar"><b>拖动鼠标框住本地频道的成员列表（含左边的图标）</b><span class="lw-pick-btns"><button class="btn btn-ghost btn-sm" data-lw-pick-auto>改回自动识别</button><button class="btn btn-ghost btn-sm" data-lw-pick-close>取消</button></span></div><div class="lw-pick-stage"><canvas></canvas><i class="lw-pick-rect" hidden></i></div>`;
  document.body.append(wrap);
  S.pick = wrap;
  const cv = wrap.querySelector('canvas');
  cv.width = frame.width; cv.height = frame.height;
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data.buffer || frame.data), frame.width, frame.height), 0, 0);
  const box = wrap.querySelector('.lw-pick-rect');
  let a = null;
  const stage = wrap.querySelector('.lw-pick-stage');
  // x / y：画面坐标；cx / cy：在 stage 里的显示坐标（画框用）
  const pt = (e) => {
    const r = cv.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const px = Math.min(r.right, Math.max(r.left, e.clientX)), py = Math.min(r.bottom, Math.max(r.top, e.clientY));
    return { x: (px - r.left) * frame.width / r.width, y: (py - r.top) * frame.height / r.height, cx: px - s.left, cy: py - s.top };
  };
  cv.addEventListener('pointerdown', (e) => { a = pt(e); cv.setPointerCapture(e.pointerId); box.hidden = false; Object.assign(box.style, { left: a.cx + 'px', top: a.cy + 'px', width: 0, height: 0 }); });
  cv.addEventListener('pointermove', (e) => {
    if (!a) return;
    const b = pt(e);
    Object.assign(box.style, { left: Math.min(a.cx, b.cx) + 'px', top: Math.min(a.cy, b.cy) + 'px', width: Math.abs(b.cx - a.cx) + 'px', height: Math.abs(b.cy - a.cy) + 'px' });
  });
  cv.addEventListener('pointerup', (e) => {
    if (!a) return;
    const b = pt(e);
    const rect = { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), w: Math.round(Math.abs(b.x - a.x)), h: Math.round(Math.abs(b.y - a.y)) };
    a = null;
    if (rect.w < 30 || rect.h < 30) { box.hidden = true; return; }
    useRect(rect);
    closePick();
    ctx.showToast('已按框选的区域找本地列表', 'success');
  });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-lw-pick-close]')) closePick();
    else if (e.target.closest('[data-lw-pick-auto]')) { useRect(null); closePick(); }
  });
}
function closePick() { S.pick?.remove(); S.pick = null; }

// ---------- 面板 ----------
let panel = null, shell = null;
const sw = (key, label, sub = '', tip = '') => `<label class="ka-opt"${tip ? ` title="${tip}"` : ''}><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="ka-switch" data-lw-set="${key}"${T[key] ? ' checked' : ''}></label>`;
const sec = (title, body) => `<section class="ka-sec"><h4 class="ka-h">${title}</h4>${body}</section>`;

function renderPanel() {
  if (!panel || !shell?.isOpen(panel)) return;
  const sc = panel.closest('.modal-body') || panel;
  const top = sc.scrollTop;
  panel.innerHTML = drawPanel();
  sc.scrollTop = top;
}
// 自动找不到：列出截好的几个候选区域让用户点；都不是再自己框选
function optionsHtml() {
  if (T.manual) return '';
  const tip = '确认本地频道窗口露在外面、成员列表显示着（不要最小化 EVE）';
  if (S.options === null || S.options === undefined) return `<p class="ka-warn">还没找到本地频道：${tip}。正在截取可能的位置…</p>`;
  if (!S.options.length) return `<p class="ka-warn">还没找到本地频道：${tip}。也可以点「手动框选」在截图上框出来</p>`;
  return `<div class="ka-opt ka-stack lw-opts"><span><b>没认出哪个是本地频道，下面哪个是？</b><small>点一下就用它；都不是的话点「都不是，自己框选」</small></span>
    <div class="lw-opt-grid">${S.options.map((o, i) => `<button type="button" class="lw-opt" data-lw-opt="${i}"><img src="${o.src}" alt="候选 ${i + 1}"></button>`).join('')}</div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-lw-pick>都不是，自己框选</button><button class="btn btn-ghost btn-sm" data-lw-reopt>重新截取</button></div></div>`;
}

function drawPanel() {
  if (!supported()) return '<p class="ka-warn">当前浏览器不能共享画面，请用电脑版 Chrome 或 Edge</p>';
  const esc = ctx.esc;
  const st = status();
  const on = st.on;
  const slow = on && S.state !== 'locked' && Date.now() - S.since > 8000;
  const people = [...S.people.values()].sort((a, b) => a.y - b.y);
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  return `
    <div class="ka-top"><span class="ka-status${on ? ' on' : ''}"><i></i>${esc(st.text)}</span>${FF.buttonHtml('local')}</div>
    <p class="ka-note">共享 EVE 窗口后自动找到本地频道的成员列表，每 0.1 秒看一次；画面只在本机处理，不会上传</p>
    ${sec('监视', `<div class="ka-list">
      <div class="ka-opt"><span><b>${on ? '正在监视' : '共享游戏画面'}</b><small>${on ? (S.region ? `本地列表 ${S.region.w}×${S.region.h}${T.manual ? '（手动框选）' : ''} · 每次 ${S.ms} 毫秒` : '') : '选择 EVE 窗口（或整个屏幕）'}</small></span>
        <span class="ka-ctl">${on ? `<button class="btn btn-ghost btn-sm" data-lw-pick>手动框选</button><button class="btn btn-ghost btn-sm" data-lw-stop>停止</button>` : '<button class="btn btn-primary btn-sm" data-lw-start>开始</button>'}</span></div>
      ${slow ? optionsHtml() : ''}
      ${on && T.manual ? `<div class="ka-opt"><span><b>只在选定的区域里找</b><small>${S.state === 'manual-miss' ? '选定的区域里没有成员列表了（窗口挪动过？）' : '本地频道窗口挪动后要重新选'}</small></span><button class="btn btn-ghost btn-sm" data-lw-auto>改回自动识别</button></div>` : ''}
      ${on && S.clipped ? '<p class="ka-warn">有名字显示不全（标「…?」的没认出来）：把本地频道的成员列表拉宽一点就好</p>' : ''}
      ${sw('red', '红名报警', '声望恶劣、敌对', '图标为红色的人一出现就报警')}
      ${sw('orange', '橙名报警', '声望不良、嫌犯、罪犯', '图标为橙色 / 黄色的人一出现就报警')}
      ${sw('neutral', '白名也报警', '没有声望图标的人（中立）', '00 区里中立一般也是敌人；名字认出来、确认不是自己后才报')}
    </div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('sound', '提示音')}
      ${sw('web', '网页卡片', '', '右上角弹出卡片')}
      ${sw('notify', '系统通知', '', '浏览器在后台时也能看到（需要允许通知）')}
      ${AP.switchHtml('local')}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-lw-test>测试提醒</button></div>`)}
    ${sec(`本地名单${people.length ? `（${people.length}）` : ''}`, people.length ? `<ul class="lw-list">${people.map((p) => `<li class="lw-row ${p.cls}${p.self ? ' self' : ''}">
        <i class="lw-dot ${p.cls}" title="${CLS[p.cls] || ''}"></i>
        <span class="lw-who"><b>${p.charId ? `<a class="kb-link" href="#kb/character/${p.charId}" translate="no">${esc(p.name)}</a>` : p.name ? `<span translate="no">${esc(p.name)}</span>` : `<span>${p.look === 'ocr' ? '识别中…' : '没认出来'}</span>`}</b>${!p.charId && p.clipped && p.name ? `<small class="lw-unsure" title="${p.cand ? `名字显示不全，同前缀的有 ${p.cand} 个人` : '名字显示不全，没查到'}">…?</small>` : ''}${p.self ? ' <small>（我）</small>' : ''}
          <small>${p.charId ? ST.badge({ char: p.charId, corp: p.corp, alliance: p.alliance }) : ''}<span translate="no">${esc([p.allianceName, p.corpName].filter(Boolean).join(' · '))}</span>${p.st ? ` · ${statLine(p)}` : ''}</small></span>
        ${p.raw && !p.self && p.cls === 'none' ? `<button class="btn btn-ghost btn-sm" data-lw-me="${esc(p.raw)}" title="以后不对这个名字报警">这是我</button>` : ''}</li>`).join('')}</ul>`
      : `<p class="ka-empty">${on ? '还没有识别到名单' : '开始监视后显示本地里的人'}</p>`)}
    ${T.me.length ? sec('不报警的名字', `<div class="ka-chips">${T.me.map((n, i) => `<span class="ka-chip"><span translate="no">${esc(n)}</span><button class="ka-close" data-lw-unme="${i}" aria-label="移除">×</button></span>`).join('')}</div>`) : ''}
    ${sec('最近报警', S.log.length ? `<ul class="ka-history">${S.log.map((r) => `<li><span class="ka-badge${r.cls === 'red' ? '' : ' clear'}">${r.cls === 'red' ? '红名' : '白名'}</span><span translate="no">${esc(r.names.join('、') || '…')}</span><small>${ago(r.at)}</small></li>`).join('')}</ul>` : '<p class="ka-empty">还没有报警</p>')}`;
}

export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  AP.bindSwitch(panel);
  panel.addEventListener('click', (e) => {
    const t = (sel) => e.target.closest(sel);
    if (t('[data-lw-start]')) start();
    else if (t('[data-lw-stop]')) stop();
    else if (t('[data-lw-pick]')) askPick();
    else if (t('[data-lw-opt]')) { const o = S.options?.[Number(t('[data-lw-opt]').dataset.lwOpt)]; if (o) { useRect(o.rect); ctx.showToast('已选定，开始监视这个列表', 'success'); } }
    else if (t('[data-lw-reopt]')) askOptions();
    else if (t('[data-lw-auto]')) useRect(null);
    else if (t('[data-lw-test]')) test();
    else if (t('[data-lw-me]')) { const n = t('[data-lw-me]').dataset.lwMe; if (!T.me.includes(n)) T.me.push(n); save(); for (const p of S.people.values()) if (isMe(p.raw)) p.self = true; notify(); }
    else if (t('[data-lw-unme]')) { T.me.splice(Number(t('[data-lw-unme]').dataset.lwUnme), 1); save(); notify(); }
    else if (t('.kb-link')) shell.close();
  });
  panel.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-lw-set]');
    if (!s) return;
    const key = s.dataset.lwSet;
    if (key === 'notify' && s.checked && window.Notification && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { s.checked = false; ctx.showToast('浏览器没有允许通知', 'error'); return; }
    }
    T[key] = s.checked;
    save();
    notify();
  });
}
export function showPanel() { renderPanel(); }

function test() {
  if (!T.sound && !T.web && !T.notify && !FF.isOpen('local')) { ctx.showToast('先打开提示音、网页卡片或系统通知', 'info'); return; }
  const id = -Date.now();
  S.people.set(id, { id, cls: 'red', name: '测试红名', raw: '测试红名', look: 'ok', first: Date.now(), y: -1, test: true });
  raise([S.people.get(id)]);
  publishFloat();
  setTimeout(() => { S.people.delete(id); notify(); }, 5000);
}
