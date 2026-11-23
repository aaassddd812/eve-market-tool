// ===== 总览预警（右上角铃铛「预警」弹窗的「总览预警」标签页）=====
// 看游戏里总览的「类型」一列，出现用户设定的东西就报警（泰坦怪、无畏怪、官员怪、战列怪，或者名字里带某个关键词的东西）。
// 画面：和本地红名共用来源——本地红名开着时直接用它共享的画面 / 选中的 EVE 窗口，没开时自己共享 / 选窗口（local-watch.js 的 shared）。
//   画面只在本机处理，不上传。用户在截图上框出总览「类型」那一列（只框这一列：距离等会变的列不在里面，同一个名字每帧的像素才一样）。
// 后台线程（ov-worker.js）每 0.4 秒切行（ov-detect.js 按画面自己适应字体大小、文字颜色和行底色色块）、按像素签名认出见过的行；新出现的行放大后交给文字识别（Tesseract.js，中文客户端用 chi_sim，英文用 eng，本地运行）。
// 识别结果按 ov-types.json（build_ov_types.mjs 从 SDE 生成：NPC 与玩家舰船的类型名 → 级别、官员 / 指挥官标签）模糊匹配：
//   总览列宽不够时名字会被截断（「科波斯 红衣主」），按前缀也算；最像的几个候选级别不一致时算「不确定」，不按级别报警（关键词规则照样看）。
// 报警：某一行命中开着的规则、而这个名字现在的行数比之前报过的多（新刷出来的），就报；这个名字从总览消失 1 分钟后再出现会再报。
// 提醒方式：提示音、网页卡片、系统通知、消息推送（alert-push.js 的 ov）。设置存在 eve-ovwatch-v1（不分服务器）。
// 国服（晨曦、曙光）的桌面版不能用总览预警（LOCKED，和本地红名一样）：不截游戏画面、不列 EVE 窗口，「开始」按钮变灰不能点；设置照旧保存。宁静服和网页版不变。
import * as AP from './alert-push.js?v=v15';
import * as SND from './alert-sound.js?v=v1';
import * as LW from './local-watch.js?v=v34';
import { IS_TQ } from './server.js?v=s4';

let ctx;   // esc, showToast
const KEY = 'eve-ovwatch-v1';
const TYPES_URL = './ov-types.json?v=1';
const OCR_BASE = new URL('./vendor/tesseract/', import.meta.url).href;
const FORGET = 60e3;
const CLS = [['titan', '泰坦'], ['super', '超级航母'], ['carrier', '航空母舰'], ['fax', '战力辅助舰'], ['dread', '无畏舰'], ['capital', '其他旗舰'],
  ['bs', '战列舰'], ['bc', '战列巡洋舰'], ['cruiser', '巡洋舰'], ['destroyer', '驱逐舰'], ['frigate', '护卫舰'], ['industrial', '工业舰 / 采矿船'],
  ['structure', '建筑 / 岗哨'], ['drone', '无人机'], ['other', '其他']];
const CLS_NAME = Object.fromEntries(CLS);
const TAG_NAME = { o: '官员', c: '指挥官' };
const WHO_NAME = { npc: '怪', player: '玩家', any: '' };
const CAPS = ['titan', 'super', 'carrier', 'fax', 'dread', 'capital'];
const PRESETS = [
  { id: 1, on: true, cls: ['titan'], who: 'npc' },
  { id: 2, on: true, cls: ['super', 'carrier', 'fax'], who: 'npc' },
  { id: 3, on: true, cls: ['dread', 'capital'], who: 'npc' },
  { id: 4, on: true, tag: 'o', who: 'npc' },
  { id: 5, on: false, tag: 'c', who: 'npc' },
  { id: 6, on: false, cls: ['bs'], who: 'npc' },
  { id: 7, on: false, cls: CAPS, who: 'player' }
];
const DEFAULTS = { lang: 'zh', sound: true, web: true, notify: false, rect: null, rules: PRESETS };
const T = structuredClone(DEFAULTS);
try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 用默认 */ }
if (!Array.isArray(T.rules)) T.rules = structuredClone(PRESETS);
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 无痕模式 */ } };

const S = {
  worker: null, stream: null, native: false, hwnd: 0, winName: '', wins: null, state: 'off', grabErr: '',
  rows: [], seen: new Map(), alerted: new Map(), log: [], ms: 0, size: null, pick: null
};
const subs = new Set();
const LOCKED = Boolean(window.__EVE_DESKTOP__ && window.__TAURI_INTERNALS__) && !IS_TQ;

export function initOvWatch(context) {
  ctx = context;
  AP.onPushChange(renderPanel);
}
export function onChange(fn) { subs.add(fn); }
function notify() {
  for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } }
  renderPanel();
}
const running = () => Boolean(S.worker);
export const supported = () => Boolean(LW.shared.tauri() || navigator.mediaDevices?.getDisplayMedia);

const STATE_TEXT = { off: '未开启', starting: '正在启动…', needrect: '请框选总览的「类型」一列', watching: '监视中', noframe: '没有收到画面' };
export function status() {
  if (LOCKED) return { on: false, alert: false, text: '国服桌面版不能用总览预警' };
  const on = running();
  let text = on ? STATE_TEXT[S.state] || S.state : '总览预警未开启';
  if (on && S.state === 'noframe' && S.native) text = S.grabErr === 'minimized' ? 'EVE 窗口最小化了，截不到画面' : S.grabErr === 'covered' ? 'EVE 窗口被挡住了：把游戏窗口放到前面' : '截不到 EVE 窗口的画面';
  if (on && S.state === 'watching') text = `监视中 · 总览 ${S.rows.length} 行`;
  return { on, alert: on && Date.now() - (S.log[0]?.at || 0) < 60e3, text };
}

// ---------- 名称表与匹配 ----------
let types = null;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s*"“”'’‘。，,.·:：;；!！?？()（）[\]【】<>《》|_~`^-]/g, '');
function loadTypes() {
  if (!types) types = fetch(TYPES_URL).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((d) => ({
    zh: d.t.filter((x) => x[0]).map(([zh, , cls, tags, npc]) => ({ n: norm(zh), name: zh, cls, tags, npc })),
    en: d.t.filter((x) => x[1]).map(([, en, cls, tags, npc]) => ({ n: norm(en), name: en, cls, tags, npc }))
  })).catch((e) => { types = null; throw e; });
  return types;
}
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// 相似度：整个名字比；总览列宽不够时名字被截断，识别出来的字数够 4 个时也和名字的同长度前缀比（稍微打点折扣）
function score(q, n) {
  let s = 1 - lev(q, n) / Math.max(q.length, n.length);
  if (n.length > q.length && q.length >= 4) s = Math.max(s, (1 - lev(q, n.slice(0, q.length)) / q.length) * 0.96);
  return s;
}
// 返回最像的名字；最像的几个（差 0.05 以内）级别 / 标签 / 是否 NPC 不一致时 sure = false
function match(text, list) {
  const q = norm(text);
  if (q.length < 2) return null;
  const ok = list.filter((x) => x.n.length >= q.length - 3 && (x.n.length <= q.length + 3 || q.length >= 4)).map((x) => [score(q, x.n), x]).filter(([s]) => s >= 0.5);
  if (!ok.length) return null;
  ok.sort((a, b) => b[0] - a[0]);
  const [best, top] = ok[0];
  if (best < 0.55) return null;
  const near = ok.filter(([s]) => s >= best - 0.05).map(([, x]) => x);
  const sure = near.every((x) => x.cls === top.cls && x.npc === top.npc && x.tags === top.tags);
  return { name: top.name, cls: top.cls, tags: top.tags, npc: top.npc, score: best, sure };
}

// ---------- 规则 ----------
const ruleText = (r) => r.kw ? `名字含「${r.kw}」` : `${r.tag ? TAG_NAME[r.tag] : r.cls.map((c) => CLS_NAME[c]).join(' / ')}${r.who === 'any' ? '' : r.who === 'npc' ? '（怪）' : '（玩家）'}`;
function hit(r, e) {
  if (!r.on) return false;
  if (r.kw) { const k = norm(r.kw); return Boolean(k) && (norm(e.m?.name).includes(k) || norm(e.text).includes(k)); }
  const m = e.m;
  if (!m || !m.sure) return false;
  if (r.who === 'npc' && !m.npc) return false;
  if (r.who === 'player' && m.npc) return false;
  if (r.tag) return m.tags.includes(r.tag);
  return r.cls.includes(m.cls);
}

// ---------- 开始 / 停止 ----------
async function start() {
  if (LOCKED || running()) return;
  if (!supported()) { ctx.showToast('这个浏览器不能共享画面：请用电脑版 Chrome / Edge，或桌面版', 'error', 5000); return; }
  loadTypes().catch(() => {});
  const sh = LW.shared;
  if (sh.tauri()) {
    if (sh.hwnd()) { S.hwnd = sh.hwnd(); S.winName = sh.winName(); startWorker(true); return; }
    await listWindows();
    return;
  }
  let track = sh.track();
  if (track && track.readyState === 'live') track = track.clone();
  else {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 }, displaySurface: 'window' }, audio: false, selfBrowserSurface: 'exclude' });
    } catch { ctx.showToast('没有共享画面', 'info'); return; }
    track = stream.getVideoTracks()[0];
    if (!track) return;
  }
  S.stream = new MediaStream([track]);
  track.addEventListener('ended', stop);
  const w = startWorker(false);
  if (typeof window.MediaStreamTrackProcessor === 'function') {
    const proc = new window.MediaStreamTrackProcessor({ track });
    w.postMessage({ t: 'stream', stream: proc.readable }, [proc.readable]);
  } else {
    stop();
    ctx.showToast('这个浏览器不支持读取共享画面：请用电脑版 Chrome / Edge', 'error', 5000);
  }
}
async function listWindows() {
  if (LOCKED) return;
  let list;
  try { list = await LW.shared.tauri().invoke('local_windows'); } catch { S.hwnd = 0; startWorker(true); return; }
  if (!list.length) { ctx.showToast('没找到 EVE 窗口：先打开游戏', 'error', 5000); return; }
  if (list.length === 1) { useWindow(list[0]); return; }
  S.wins = list.map((w) => ({ ...w, name: w.title.replace(/^EVE( - )?/, '') || 'EVE' }));
  notify();
}
function useWindow(w) {
  if (LOCKED) return;
  if (w.minimized) { ctx.showToast('这个窗口最小化了：先把游戏窗口还原', 'info', 5000); return; }
  S.hwnd = w.id; S.winName = w.name || w.title; S.wins = null;
  startWorker(true);
}
function startWorker(native) {
  S.native = native;
  S.state = T.rect ? 'starting' : 'needrect';
  S.rows = []; S.seen.clear(); S.alerted.clear();
  const w = new Worker(new URL('./ov-worker.js?v=2', import.meta.url), { type: 'module' });
  S.worker = w;
  w.onmessage = onWorker;
  if (native) w.postMessage({ t: 'grab-mode' });
  if (T.rect) w.postMessage({ t: 'rect', rect: T.rect });
  notify();
  return w;
}
function stop() {
  S.worker?.postMessage({ t: 'stop' });
  S.worker?.terminate();
  S.worker = null;
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.native = false;
  S.state = 'off';
  S.rows = [];
  closePick();
  notify();
}
async function nativeGrab(rect) {
  try {
    const buf = await LW.shared.tauri().invoke('local_grab', { rect: rect || null, hwnd: S.hwnd || null, front: false });
    const v = new DataView(buf);
    S.grabErr = '';
    return { width: v.getUint32(0, true), height: v.getUint32(4, true), buffer: buf.slice(8) };
  } catch (e) {
    S.grabErr = String(e?.message || e);
    return null;
  }
}
function onWorker(e) {
  const m = e.data || {};
  if (m.t === 'grab') {
    nativeGrab(m.rect).then((img) => {
      S.worker?.postMessage(img ? { t: 'grabbed', id: m.id, width: img.width, height: img.height, buffer: img.buffer } : { t: 'grabbed', id: m.id }, img ? [img.buffer] : []);
    });
  } else if (m.t === 'status') {
    if (S.state !== m.state) { S.state = m.state; notify(); }
  } else if (m.t === 'rows') {
    S.rows = m.rows; S.ms = m.ms; S.size = m.size;
    if (S.state !== 'watching') S.state = 'watching';
    evaluate();
  } else if (m.t === 'ocr') ocrRow(m);
  else if (m.t === 'snapshot') showPick(m.frame);
  else if (m.t === 'ended') stop();
}

// ---------- 文字识别 ----------
let ocr = null, ocrLang = '';
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('文字识别加载失败')); document.head.append(s); });
}
function ocrWorker() {
  const lang = T.lang === 'en' ? 'eng' : 'chi_sim';
  if (ocr && ocrLang !== lang) { ocr.then((w) => w.terminate()).catch(() => {}); ocr = null; }
  if (!ocr) {
    ocrLang = lang;
    ocr = (async () => {
      if (!window.Tesseract) await loadScript(OCR_BASE + 'tesseract.min.js');
      const w = await window.Tesseract.createWorker(lang, 1, { workerPath: OCR_BASE + 'worker.min.js', corePath: OCR_BASE + 'core/', langPath: OCR_BASE + 'lang/', workerBlobURL: false });
      await w.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
      return w;
    })().catch((e) => { ocr = null; throw e; });
  }
  return ocr;
}
let ocrQ = Promise.resolve();
function ocrRow(m) {
  const e = { text: '', m: null, look: 'ocr' };
  S.seen.set(m.id, e);
  ocrQ = ocrQ.then(async () => {
    if (!running()) return;
    try {
      const [w, list] = await Promise.all([ocrWorker(), loadTypes()]);
      const c = document.createElement('canvas');
      c.width = m.img.width; c.height = m.img.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.img.data.buffer || m.img.data), m.img.width, m.img.height), 0, 0);
      const { data } = await w.recognize(c);
      e.text = String(data.text || '').trim();
      e.m = match(e.text, T.lang === 'en' ? list.en : list.zh);
    } catch (err) {
      console.warn('总览预警：文字识别失败', err);
    }
    e.look = 'done';
    evaluate();
  });
}

// ---------- 报警 ----------
function evaluate() {
  const now = Date.now();
  const count = new Map();
  for (const r of S.rows) count.set(r.id, (count.get(r.id) || 0) + 1);
  const fresh = [];
  for (const [id, n] of count) {
    const e = S.seen.get(id);
    const a = S.alerted.get(id);
    if (a) a.last = now;
    if (!e || e.look !== 'done') continue;
    const rules = T.rules.filter((r) => hit(r, e));
    if (!rules.length) continue;
    const had = a?.n || 0;
    if (n > had) fresh.push({ e, n: n - had, rule: rules[0] });
    S.alerted.set(id, { n: Math.max(n, had), last: now });
  }
  for (const [id, a] of S.alerted) if (now - a.last > FORGET) S.alerted.delete(id);
  if (fresh.length) raise(fresh);
  notify();
}
const label = (e) => e.m ? `${e.m.name}${e.m.cls ? `（${e.m.tags.includes('o') ? '官员' : CLS_NAME[e.m.cls]}）` : ''}` : e.text;
function raise(list, test = false) {
  const at = Date.now();
  const names = list.map((x) => `${label(x.e)}${x.n > 1 ? ' ×' + x.n : ''}`);
  const title = `总览出现：${ruleText(list[0].rule)}`;
  const entry = { at, title, names, rule: ruleText(list[0].rule) };
  S.log.unshift(entry);
  S.log.length = Math.min(S.log.length, 30);
  if (T.sound) beep();
  if (T.web) card(entry);
  if (T.notify && window.Notification?.permission === 'granted') {
    try { const n = new Notification(title, { body: names.join('、'), tag: 'eve-ov', renotify: true }); n.onclick = () => window.focus(); } catch { /* 忽略 */ }
  }
  if (!test) AP.push('ov', { sig: 'ov|' + at + '|' + names.join(','), text: `${title} · ${names.join('、')}` });
}
// 提示音：声音和音量在个性化设置里换（alert-sound.js）
function beep() { SND.play('ov', 3); }
let layer = null;
function card(entry) {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'ka-layer';
    layer.innerHTML = '<div class="ka-cards ov-cards" aria-live="assertive"></div>';
    document.body.appendChild(layer);
    layer.addEventListener('click', (e) => { const c = e.target.closest('.ka-card'); if (c) c.remove(); });
  }
  const box = layer.querySelector('.ka-cards');
  const el = document.createElement('div');
  el.className = 'ka-card here';
  el.innerHTML = `<div class="ka-head"><span class="ka-badge">总览</span><b>${ctx.esc(entry.title)}</b><button class="ka-close" data-ka-close aria-label="关闭">×</button></div>
    <div class="ka-body">${entry.names.map((n) => `<span class="ov-card-who">${ctx.esc(n)}</span>`).join('')}</div>
    <div class="ka-meta">${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>`;
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.remove(), 30e3);
}

// ---------- 框选 ----------
function askPick() { S.worker?.postMessage({ t: 'snapshot' }); }
function useRect(rect) {
  T.rect = rect; save();
  S.seen.clear(); S.alerted.clear(); S.rows = [];
  S.state = 'starting';
  S.worker?.postMessage({ t: 'forget' });
  S.worker?.postMessage({ t: 'rect', rect });
  notify();
}
function showPick(frame) {
  if (!frame) { ctx.showToast(S.native && S.grabErr === 'minimized' ? 'EVE 窗口最小化了：先把游戏窗口还原' : '还没有收到画面，稍等一下再点', 'error'); return; }
  closePick();
  const wrap = document.createElement('div');
  wrap.className = 'lw-pick';
  wrap.innerHTML = `<div class="lw-pick-bar"><b>拖动鼠标框住总览的「类型」一列：从第一行到最后一行，只框这一列（不要框距离）</b><span class="lw-pick-btns"><button class="btn btn-ghost btn-sm" data-ov-pick-close>取消</button></span></div><div class="lw-pick-stage"><canvas></canvas><i class="lw-pick-rect" hidden></i></div>`;
  document.body.append(wrap);
  S.pick = wrap;
  const cv = wrap.querySelector('canvas');
  cv.width = frame.width; cv.height = frame.height;
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data.buffer || frame.data), frame.width, frame.height), 0, 0);
  const box = wrap.querySelector('.lw-pick-rect');
  const stage = wrap.querySelector('.lw-pick-stage');
  let a = null;
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
    if (rect.w < 20 || rect.h < 20) { box.hidden = true; return; }
    useRect(rect);
    closePick();
    ctx.showToast('已选定，开始看这一列', 'success');
  });
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-ov-pick-close]')) closePick(); });
}
function closePick() { S.pick?.remove(); S.pick = null; }

// ---------- 面板 ----------
let panel = null, shell = null;
const sw = (key, label, sub = '', tip = '') => `<label class="ka-opt"${tip ? ` title="${tip}"` : ''}><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="ka-switch" data-ov-set="${key}"${T[key] ? ' checked' : ''}></label>`;
const sec = (title, body) => `<section class="ka-sec"><h4 class="ka-h">${title}</h4>${body}</section>`;
function renderPanel() {
  if (!panel || !shell?.isOpen(panel)) return;
  if (panel.contains(document.activeElement) && document.activeElement.matches('input[type=text],select')) return;   // 正在填关键词：先不重画
  const sc = panel.closest('.modal-body') || panel;
  const top = sc.scrollTop;
  panel.innerHTML = drawPanel();
  sc.scrollTop = top;
}
function drawPanel() {
  if (LOCKED) return lockedPanel();
  const esc = ctx.esc;
  if (!supported()) return '<p class="ka-warn">这个浏览器不能共享画面：请用电脑版 Chrome / Edge，或桌面版</p>';
  const st = status();
  const on = st.on;
  const desk = Boolean(LW.shared.tauri());
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  // 当前总览里认出的东西（同名合并），命中规则的排前面
  const cnt = new Map();
  for (const r of S.rows) cnt.set(r.id, (cnt.get(r.id) || 0) + 1);
  const seen = [...cnt].map(([id, n]) => ({ id, n, e: S.seen.get(id) })).filter((x) => x.e).map((x) => ({ ...x, hit: x.e.look === 'done' && T.rules.some((r) => hit(r, x.e)) }))
    .sort((a, b) => b.hit - a.hit || b.n - a.n);
  return `
    <div class="ka-top"><span class="ka-status${on ? ' on' : ''}"><i></i>${esc(st.text)}</span></div>
    ${sec('监视', `<div class="ka-list">
      <div class="ka-opt"><span><b>${on ? (S.winName ? `正在监视：<span translate="no">${esc(S.winName)}</span>` : '正在监视') : desk ? '监视游戏画面' : '共享游戏画面'}</b></span>
        <span class="ka-ctl">${on ? `<button class="btn btn-ghost btn-sm" data-ov-pick>${T.rect ? '重新框选' : '框选总览'}</button><button class="btn btn-ghost btn-sm" data-ov-stop>停止</button>` : S.wins ? '' : '<button class="btn btn-primary btn-sm" data-ov-start>开始</button>'}</span></div>
      ${!on && S.wins ? `<div class="ka-opt ka-stack"><span><b>选择要监视的 EVE 窗口</b></span><div class="ka-chips">${S.wins.map((w, i) => `<button type="button" class="ka-chip toggle" data-ov-win="${i}" translate="no">${esc(w.name)}</button>`).join('')}</div></div>` : ''}
      <div class="ka-opt"><span><b>游戏语言</b></span><div class="segmented">${[['zh', '中文'], ['en', 'English']].map(([k, l]) => `<button type="button" data-ov-lang="${k}" class="${(T.lang === 'en' ? 'en' : 'zh') === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    </div>`)}
    ${sec('报警规则', `<div class="ka-list">${T.rules.map((r) => `<div class="ka-opt"><span><b>${esc(ruleText(r))}</b></span><span class="ka-ctl"><input type="checkbox" class="ka-switch" data-ov-rule="${r.id}"${r.on ? ' checked' : ''} aria-label="开关"><button type="button" class="ka-close" data-ov-del="${r.id}" title="删除这条规则" aria-label="删除">×</button></span></div>`).join('')}
      <div class="ka-opt ka-stack ov-add"><span><b>添加规则</b></span>
        <div class="ov-add-row"><select class="pi-input" data-ov-new-cls><option value="kw">名字含关键词</option><option value="o">官员</option><option value="c">指挥官</option>${CLS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <select class="pi-input" data-ov-new-who hidden><option value="npc">怪</option><option value="player">玩家</option><option value="any">都算</option></select>
          <input type="text" class="pi-input" data-ov-new-kw placeholder="关键词，如 泰坦、Dread、监察官" autocomplete="off">
          <button type="button" class="btn btn-primary btn-sm" data-ov-add>添加</button></div></div>
      <div class="ka-actions"><button type="button" class="btn btn-ghost btn-sm" data-ov-reset>恢复默认规则</button></div></div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('sound', '提示音', '<button type="button" class="link-btn" data-open-prefs="sound">换声音、调音量</button>')}
      ${sw('web', '网页卡片', '', '右上角弹出卡片')}
      ${sw('notify', '系统通知', '', '浏览器在后台时也能看到（需要允许通知）')}
      ${AP.switchHtml('ov')}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-ov-test>测试提醒</button></div>`)}
    ${sec(`总览里认出的东西${seen.length ? `（${seen.length} 种）` : ''}`, seen.length ? `<ul class="ov-list">${seen.slice(0, 60).map(({ n, e, hit: h }) => `<li class="ov-row${h ? ' hit' : ''}">
        <span class="ov-name">${e.look !== 'done' ? '<span class="text-muted">识别中…</span>' : e.m ? `<b>${esc(e.m.name)}</b>` : `<span class="text-muted" title="没对上名称表">${esc(e.text || '没认出来')}</span>`}${n > 1 ? ` <small>×${n}</small>` : ''}</span>
        ${e.m ? `<span class="ov-tag${e.m.sure ? '' : ' unsure'}" title="${e.m.sure ? `识别：${esc(e.text)}` : `识别：${esc(e.text)}；几个相近的名字级别不同，不确定`}">${e.m.npc ? '怪' : '玩家'} · ${e.m.tags.includes('o') ? '官员' : e.m.tags.includes('c') ? '指挥官' : CLS_NAME[e.m.cls]}${e.m.sure ? '' : '?'}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="ka-empty">${on ? (T.rect ? '还没有认出东西' : '框选总览后显示') : '开始监视后显示总览里认出的东西'}</p>`)}
    ${sec('最近报警', S.log.length ? `<ul class="ka-history">${S.log.map((r) => `<li><span class="ka-badge">${esc(r.rule)}</span><span>${esc(r.names.join('、'))}</span><small>${ago(r.at)}</small></li>`).join('')}</ul>` : '<p class="ka-empty">还没有报警</p>')}`;
}

// 国服桌面版：只留「监视」一栏，「开始」变灰不能点，其余设置不显示
function lockedPanel() {
  return `
    <div class="ka-top"><span class="ka-status"><i></i>${ctx.esc(status().text)}</span></div>
    <p class="ka-note">晨曦、曙光服的桌面版不截取 EVE 游戏画面，总览预警用不了，切到宁静服可以用</p>
    ${sec('监视', `<div class="ka-list ka-locked">
      <div class="ka-opt"><span><b>监视游戏画面</b><small>不截取游戏画面，也不能手动开始</small></span>
        <span class="ka-ctl"><button class="btn btn-primary btn-sm" disabled>开始</button></span></div>
    </div>`)}`;
}

export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  AP.bindSwitch(panel);
  panel.addEventListener('click', (e) => {
    if (LOCKED) return;
    const t = (sel) => e.target.closest(sel);
    if (t('[data-ov-start]')) start();
    else if (t('[data-ov-stop]')) stop();
    else if (t('[data-ov-pick]')) askPick();
    else if (t('[data-ov-win]')) useWindow(S.wins[Number(t('[data-ov-win]').dataset.ovWin)]);
    else if (t('[data-ov-test]')) test();
    else if (t('[data-ov-del]')) { T.rules = T.rules.filter((r) => r.id !== Number(t('[data-ov-del]').dataset.ovDel)); save(); notify(); }
    else if (t('[data-ov-reset]')) { T.rules = structuredClone(PRESETS); save(); evaluate(); }
    else if (t('[data-ov-add]')) addRule();
    else if (t('[data-ov-lang]')) {
      const lang = t('[data-ov-lang]').dataset.ovLang;
      if (lang === T.lang) return;
      T.lang = lang; save();
      S.seen.clear(); S.alerted.clear();
      S.worker?.postMessage({ t: 'forget' });
      notify();
    }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-ov-new-kw]')) { e.preventDefault(); addRule(); } });
  panel.addEventListener('change', async (e) => {
    if (LOCKED) return;
    const s = e.target.closest('[data-ov-set]');
    if (s) {
      const key = s.dataset.ovSet;
      if (key === 'notify' && s.checked && window.Notification && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission().catch(() => 'denied');
        if (p !== 'granted') { s.checked = false; ctx.showToast('浏览器没有允许通知', 'error'); return; }
      }
      T[key] = s.checked; save(); notify();
      return;
    }
    const r = e.target.closest('[data-ov-rule]');
    if (r) { const x = T.rules.find((y) => y.id === Number(r.dataset.ovRule)); if (x) x.on = r.checked; save(); evaluate(); return; }
    if (e.target.matches('[data-ov-new-cls]')) { const kw = e.target.value === 'kw'; panel.querySelector('[data-ov-new-kw]').hidden = !kw; panel.querySelector('[data-ov-new-who]').hidden = kw; }
  });
}
function addRule() {
  const cls = panel.querySelector('[data-ov-new-cls]').value;
  const who = panel.querySelector('[data-ov-new-who]').value;
  const kw = panel.querySelector('[data-ov-new-kw]').value.trim();
  const id = Math.max(0, ...T.rules.map((r) => r.id)) + 1;
  if (cls === 'kw') {
    if (!kw) { ctx.showToast('先填关键词', 'info'); return; }
    T.rules.push({ id, on: true, kw, who: 'any' });
  } else if (cls === 'o' || cls === 'c') T.rules.push({ id, on: true, tag: cls, who });
  else T.rules.push({ id, on: true, cls: [cls], who });
  save();
  document.activeElement?.blur();
  evaluate();
}
export function showPanel() { renderPanel(); }

function test() {
  if (!T.sound && !T.web && !T.notify) { ctx.showToast('先打开提示音、网页卡片或系统通知', 'info'); return; }
  raise([{ e: { m: { name: '黑暗血袭者泰坦', cls: 'titan', tags: '', npc: 1, sure: true }, text: '' }, n: 1, rule: PRESETS[0] }], true);
  notify();
}
