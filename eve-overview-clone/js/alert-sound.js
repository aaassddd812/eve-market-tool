// ===== 提示音：各类提醒共用（个性化设置里选声音、调音量、试听） =====
// 声音都是现合成的（Web Audio），不用下载；也可以换成自己的音频文件（存在本机 IndexedDB「eve-sounds」，不跟云同步，最大 2 MB，最多播 10 秒）。
// 设置存在 eve-prefs.snd（云同步会带上）：{ vol: 0–100（默认 50 = 原来的响度）, [类型]: 声音键 }，没设的类型用它自己的默认声音
// （和以前各模块写死的一样）。别的设备选了「自己的音频文件」但本机没有文件时，用默认声音。
// 各模块调用 play(类型, 几声)：几声表示急不急（击杀预警本星系 4 声、本地日志越近越多等），自己的音频文件只播一遍。
// 个性化设置：settingsHtml() 画「提示音」一节，onEvent(e, root, toast, redraw) 处理里面的操作（modern-app.js 调用）。
// 换回合成的声音时存的文件留着（再选「自己的音频文件」还能用），「恢复默认」才全部删掉。

// 声音：名称、合成参数（wave 波形、f 依次循环的音高、step 每声间隔、peak 响度、dur 每声长度；
// flat 不做淡入淡出（自选看板、订单原来的单声）；bell 带泛音的钟声；sweep 每声从低滑到高；max 最多几声）
const SOUNDS = {
  square: ['方波警报', { wave: 'square', f: [880, 660], step: 0.18, peak: 0.12, dur: 0.16 }],
  beep: ['短促蜂鸣', { wave: 'square', f: [990, 660], step: 0.16, peak: 0.09, dur: 0.14 }],
  saw: ['锯齿急报', { wave: 'sawtooth', f: [780, 520], step: 0.2, peak: 0.1, dur: 0.18 }],
  tri: ['三角波', { wave: 'triangle', f: [780, 520], step: 0.2, peak: 0.12, dur: 0.18 }],
  sos: ['三连音', { wave: 'sine', f: [660, 880, 660], step: 0.2, peak: 0.15, dur: 0.18 }],
  chime: ['柔和叮咚', { wave: 'sine', f: [660, 990], step: 0.14, peak: 0.1, dur: 0.4 }],
  ding: ['单声提示', { wave: 'sine', f: [660], step: 0.4, peak: 0.08, dur: 0.3, flat: true }],
  ding2: ['高音提示', { wave: 'sine', f: [880], step: 0.35, peak: 0.08, dur: 0.25, flat: true }],
  radar: ['雷达滴滴', { wave: 'sine', f: [1320], step: 0.12, peak: 0.12, dur: 0.06 }],
  bell: ['钟声', { f: [784, 659], step: 0.45, peak: 0.1, dur: 1.2, bell: true, max: 3 }],
  siren: ['警笛', { wave: 'sawtooth', sweep: [520, 1040], step: 0.42, peak: 0.07, dur: 0.38, max: 4 }]
};
// 提醒类型：键、名称、默认声音、试听时几声
export const TYPES = [
  ['kill', '击杀预警', 'square', 2],
  ['big', '高价值击杀播报', 'chime', 2],
  ['intel', '本地日志', 'saw', 3],
  ['local', '本地红名', 'beep', 2],
  ['ov', '总览预警', 'tri', 3],
  ['sos', '虫洞求救', 'sos', 3],
  ['watch', '自选看板到价', 'ding', 1],
  ['order', '订单被压价', 'ding2', 1]
];
const VOL = 50, MAX_BYTES = 2 * 1024 * 1024, MAX_SECS = 10;

function prefsAll() { try { return JSON.parse(localStorage.getItem('eve-prefs')) || {}; } catch { return {}; } }
const cfg = () => prefsAll().snd || {};
function save(patch) {
  const p = prefsAll();
  const s = { ...(p.snd || {}), ...patch };
  for (const k of Object.keys(s)) if (s[k] == null || s[k] === '') delete s[k];
  if (Object.keys(s).length) p.snd = s; else delete p.snd;
  try { localStorage.setItem('eve-prefs', JSON.stringify(p)); } catch { /* 存不了就只在这次有效 */ }
}
const volOf = (c = cfg()) => Math.max(0, Math.min(100, Number.isFinite(c.vol) ? c.vol : VOL));
const typeOf = (type) => TYPES.find((t) => t[0] === type) || TYPES[0];
const soundOf = (type, c = cfg()) => (c[type] === 'custom' || SOUNDS[c[type]] ? c[type] : typeOf(type)[2]);

// 共用一个 AudioContext，闲置 20 秒关掉
let ac = null, idle = 0;
function audio() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!ac || ac.state === 'closed') ac = new C();
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  clearTimeout(idle);
  idle = setTimeout(() => { try { ac?.close(); } catch { /* 忽略 */ } ac = null; }, 20e3);
  return ac;
}

function synth(c, s, n, m) {
  const t = c.currentTime + 0.01;
  const count = Math.max(1, Math.min(n, s.max || 8));
  for (let i = 0; i < count; i++) {
    const t0 = t + i * s.step, f = s.f ? s.f[i % s.f.length] : 0;
    const parts = s.bell ? [[1, 1], [2, 0.4], [3, 0.18]] : [[1, 1]];
    for (const [h, k] of parts) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = s.bell ? 'sine' : s.wave;
      if (s.sweep) { o.frequency.setValueAtTime(s.sweep[0], t0); o.frequency.linearRampToValueAtTime(s.sweep[1], t0 + s.dur); } else o.frequency.value = f * h;
      const peak = s.peak * m * k;
      if (s.flat) g.gain.setValueAtTime(peak, t0);
      else { g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur); }
      o.connect(g).connect(c.destination);
      o.start(t0); o.stop(t0 + s.dur + (s.flat ? 0 : 0.02));
    }
  }
}

// ---------- 自己的音频文件（IndexedDB，按提醒类型各存一个） ----------
const DB = 'eve-sounds', STORE = 'files';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch((e) => { dbp = null; throw e; });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = fn(d.transaction(STORE, mode).objectStore(STORE));
    q.onsuccess = () => res(q.result ?? null);
    q.onerror = () => rej(q.error);
  });
}
const fileGet = (type) => tx('readonly', (s) => s.get(type)).catch(() => null);
const filePut = (type, rec) => tx('readwrite', (s) => s.put(rec, type));
const fileDel = (type) => tx('readwrite', (s) => s.delete(type)).catch(() => null);
const decode = (c, data) => new Promise((res, rej) => { const p = c.decodeAudioData(data.slice(0), res, rej); if (p?.then) p.then(res, rej); });
const decoded = new Map();   // 类型 -> { at, buf }

async function playFile(c, type, m) {
  const rec = await fileGet(type);
  if (!rec?.data) return false;
  let hit = decoded.get(type);
  if (!hit || hit.at !== rec.at) { hit = { at: rec.at, buf: await decode(c, rec.data) }; decoded.set(type, hit); }
  const src = c.createBufferSource(), g = c.createGain();
  src.buffer = hit.buf;
  g.gain.value = m;
  src.connect(g).connect(c.destination);
  const t0 = c.currentTime + 0.01;
  src.start(t0);
  if (hit.buf.duration > MAX_SECS) { g.gain.setValueAtTime(m, t0 + MAX_SECS - 0.3); g.gain.linearRampToValueAtTime(0, t0 + MAX_SECS); src.stop(t0 + MAX_SECS); }
  return true;
}

// 播放：type 提醒类型，n 几声（越急越多）；浏览器不允许自动播放时什么都不做
export async function play(type, n = 1, override) {
  try {
    const c = cfg(), vol = volOf(c);
    if (!vol) return;
    const ctx = audio();
    if (!ctx) return;
    const key = override || soundOf(type, c);
    if (key === 'custom' && await playFile(ctx, type, vol / 100).catch(() => false)) return;
    synth(ctx, (SOUNDS[key] || SOUNDS[typeOf(type)[2]])[1], n, vol / VOL);
  } catch { /* 浏览器不允许自动播放时忽略 */ }
}

// ---------- 个性化设置里的「提示音」一节 ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
export function settingsHtml() {
  const c = cfg(), vol = volOf(c);
  const rows = TYPES.map(([type, name, dflt]) => {
    const cur = c[type] === 'custom' || SOUNDS[c[type]] ? c[type] : '';
    const opts = [['', `默认（${SOUNDS[dflt][0]}）`], ...Object.entries(SOUNDS).filter(([k]) => k !== dflt).map(([k, [l]]) => [k, l]), ['custom', '自己的音频文件…']]
      .map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return `<div class="snd-row"><span class="snd-name">${esc(name)}</span>
      <select class="pi-input snd-sel" data-snd-type="${type}" aria-label="${esc(name)}">${opts}</select>
      <button type="button" class="btn btn-ghost btn-sm snd-play" data-snd-play="${type}" title="试听">${PLAY_ICON}<span>试听</span></button>
      <div class="snd-file" data-snd-file="${type}"${cur === 'custom' ? '' : ' hidden'}></div></div>`;
  }).join('');
  return `<section class="ml-section snd-section" id="prefsSound"><div class="ml-head"><b class="prefs-title">提示音</b><span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-snd-reset${Object.keys(c).length ? '' : ' disabled'}>恢复默认</button></div>
    <p class="ml-tip">各类提醒开不开提示音在右上角铃铛「预警」里设置（自选看板、订单在各自页面）</p>
    <label class="snd-vol"><span>音量</span><input type="range" min="0" max="100" step="5" value="${vol}" data-snd-vol aria-label="音量"><b data-snd-vol-text>${vol}%</b></label>
    <div class="snd-list">${rows}</div></section>`;
}
// 选了「自己的音频文件」的类型：显示文件名（本机没有文件时提示先用默认声音）
export async function fillFiles(root) {
  for (const el of root.querySelectorAll('[data-snd-file]')) {
    if (el.hidden) continue;
    const rec = await fileGet(el.dataset.sndFile);
    el.innerHTML = rec ? `<span class="snd-fname" title="${esc(rec.name)}">${esc(rec.name)}</span><button type="button" class="link-btn" data-snd-pick-for="${el.dataset.sndFile}">换一个</button>`
      : `<span>这台设备上还没有文件，先用默认声音</span><button type="button" class="link-btn" data-snd-pick-for="${el.dataset.sndFile}">选择文件</button>`;
  }
}
// 选文件的输入框挂在 body 上（设置那一节会重画，放在里面的话选完文件就收不到了）
let picker = null;
function pick(type, toast, redraw) {
  if (!picker) {
    picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'audio/*';
    picker.hidden = true;
    document.body.appendChild(picker);
  }
  picker.value = '';
  picker.onchange = async () => {
    const f = picker.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) { toast('文件太大，最多 2 MB', 'info'); return; }
    try {
      const data = await f.arrayBuffer();
      const c = audio();
      if (!c) throw new Error('no audio');
      const buf = await decode(c, data);
      if (!(buf.duration > 0)) throw new Error('empty');
      await filePut(type, { name: f.name, size: f.size, at: Date.now(), data });
      save({ [type]: 'custom' });
      toast(buf.duration > MAX_SECS ? `已换成 ${f.name}（超过 ${MAX_SECS} 秒的部分不播）` : `已换成 ${f.name}`, 'success');
      play(type, 1);
    } catch { toast('这个文件不能当提示音播放，换一个音频文件试试', 'info'); }
    redraw();
  };
  picker.click();
}
// 设置里的操作；返回 true 表示要重画这一节
export async function onEvent(e, root, toast, redraw) {
  const t = e.target;
  if (e.type === 'input' && t.matches('[data-snd-vol]')) {
    save({ vol: Number(t.value) === VOL ? null : Number(t.value) });
    root.querySelector('[data-snd-vol-text]').textContent = `${t.value}%`;
    root.querySelector('[data-snd-reset]').disabled = !Object.keys(cfg()).length;
    return false;
  }
  if (e.type === 'change' && t.matches('[data-snd-vol]')) { play(TYPES[0][0], TYPES[0][3]); return false; }
  if (e.type === 'change' && t.matches('[data-snd-type]')) {
    const type = t.dataset.sndType;
    save({ [type]: t.value || null });
    // 选了「自己的音频文件」但本机还没有：直接打开选文件（读数据库只要几毫秒，还在这次操作的有效时间里）
    if (t.value === 'custom' && !(await fileGet(type))) { pick(type, toast, redraw); return true; }
    play(type, typeOf(type)[3]);
    return true;
  }
  if (e.type !== 'click') return false;
  const pl = t.closest('[data-snd-play]');
  if (pl) { const type = pl.dataset.sndPlay; play(type, typeOf(type)[3]); return false; }
  const pf = t.closest('[data-snd-pick-for]');
  if (pf) { pick(pf.dataset.sndPickFor, toast, redraw); return false; }
  if (t.closest('[data-snd-reset]')) {
    const c = cfg();
    for (const [type] of TYPES) if (c[type] === 'custom') fileDel(type);
    const p = prefsAll(); delete p.snd;
    try { localStorage.setItem('eve-prefs', JSON.stringify(p)); } catch { /* 忽略 */ }
    toast('提示音已恢复默认', 'success');
    return true;
  }
  return false;
}
