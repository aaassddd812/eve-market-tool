// ===== 本地红名（右上角铃铛「预警」弹窗的「本地红名」标签页）=====
// 用户点「开始」后选择共享 EVE 窗口（浏览器 getDisplayMedia，只在本机处理，不上传），后台线程（local-worker.js）每 0.1 秒看一次本地频道成员列表：
//   自动找到本地列表（local-detect.js：一列声望图标 + 上方频道标签的「本」字）；找了 8 秒找不到时把几个像名单的地方截图列出来让用户点选，
//   都不是再让用户在整张截图上自己框选（选定的区域记在设置里，之后只在里面找）；
//   红 / 橙图标（声望恶劣 / 不良、嫌犯等）持续 2 秒以上都看到、名字和所属查完确认不是自己或友方后报警（一般 2.5 秒左右，最多等 4 秒；设成「只看色块」时颜色确认了就报）；
//   无图标（白名、中立）可选报警，要等名字认出来、确认不是自己之后才报。
// 名字：新出现的人把名字那一行截下来交给文字识别（Tesseract.js，js/vendor/tesseract，本地运行），再用 ESI /universe/ids/ 换成角色；
//   查不到（认错字母）或名字被截断（列表太窄）时在本站击杀记录里搜相近的名字（/api/kb/search），只有一个最像的才认，否则标「…?」，并提示把列表拉宽。
//   认出角色后查所属军团 / 联盟（standings.js）与近 30 天击杀记录（/api/v1/pilots），显示在名单与悬浮窗里。
// 自己：已绑定 ESI 的角色名、名单里手动点「这是我」的名字，以及没有图标却和本地友方同联盟 / 同军团的人（游戏里只有自己那一行没有图标），不报警。
// 提醒方式：提示音、网页卡片、系统通知、企业微信 / 邮箱（alert-push.js）、悬浮窗（float-feed.js 的 local 一栏）。
// 设置存在 eve-localwatch-v1（不分服务器）。共享画面每次打开网页都要重新选择（浏览器规定），不会自动恢复。

import * as AP from './alert-push.js?v=v3';
import * as ST from './standings.js?v=v4';
import * as FF from './float-feed.js?v=v11';
import { SERVER, IS_TQ } from './server.js?v=s4';

let ctx;   // esc, showToast, resolveNames, resolveTypeNames, selfNames()
const KEY = 'eve-localwatch-v1';
const DEFAULTS = { red: true, orange: true, neutral: false, withName: true, onlyHostile: true, sound: true, web: true, notify: false, me: [] };   // onlyHostile：名单与悬浮窗只显示红 / 橙 / 白名
const T = { ...DEFAULTS };
const S = {
  stream: null, worker: null, video: null, canvas: null, state: 'off', region: null, since: 0, ms: 0, clipped: false,
  rows: [], people: new Map(), gone: new Map(), log: [], lastAlert: 0, alertTimer: 0, pick: null,
  options: undefined,  // 自动找不到时给用户选的区域：undefined 还没截，null 正在截，[] 截好了
  wins: null, hwnd: 0, winName: ''   // 桌面版：点「开始」后列出的 EVE 窗口（给用户选），选中的窗口与角色名
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
  findMates();
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
// 桌面版：Rust 直接截 EVE 窗口（local_grab，desktop/src-tauri/src/capture.rs），不走浏览器共享屏幕（Windows 会给被共享的窗口加一圈黄框）
// 截图命令从桌面版 1.0.6 开始才有；旧版本（window.__EVE_DESKTOP__ 是版本号）还是走共享屏幕。
// 要按版本判断、不能先调一次命令试：等命令返回后再调 getDisplayMedia 就不算用户点击触发的了，WebView2 会直接拒绝，弹不出选择窗口
const NATIVE_FROM = [1, 0, 6];
const tauri = () => {
  const v = String(window.__EVE_DESKTOP__ || '').split('.').map(Number);
  if (!window.__TAURI_INTERNALS__ || v.length < 3) return null;
  for (let i = 0; i < 3; i++) if (v[i] !== NATIVE_FROM[i]) return v[i] > NATIVE_FROM[i] ? window.__TAURI_INTERNALS__ : null;
  return window.__TAURI_INTERNALS__;
};
// 浏览器只在 https（或本机地址）的页面里允许共享屏幕
export const supported = () => Boolean(tauri() || navigator.mediaDevices?.getDisplayMedia);
// http 地址（演示站）：Chrome / Edge 可以在 chrome://flags 的「Insecure origins treated as secure」里加上这个地址，重启浏览器后就能用
const whyNot = () => (!window.isSecureContext ? `浏览器只允许 https 地址的网页共享画面，现在是 http 地址。请用 https 打开本站；或者在浏览器地址栏打开 chrome://flags/#unsafely-treat-insecure-origin-as-secure（Edge 是 edge://flags），把 ${location.origin} 填进去、设为 Enabled，重启浏览器` : '这个浏览器不能共享画面：请用电脑版 Chrome / Edge');
const running = () => Boolean(S.stream || S.native);
// 截一次：返回 { width, height, buffer }（RGBA），截不到返回 null（原因记在 S.grabErr）
async function nativeGrab(rect, front = false) {
  try {
    const buf = await tauri().invoke('local_grab', { rect: rect || null, hwnd: S.hwnd || null, front });
    const v = new DataView(buf);
    S.grabErr = '';
    return { width: v.getUint32(0, true), height: v.getUint32(4, true), buffer: buf.slice(8) };
  } catch (e) {
    S.grabErr = String(e?.message || e);
    return null;
  }
}
const STATE_TEXT = {
  off: '未开启', starting: '正在启动…', locating: '正在找本地频道…', 'manual-miss': '框选的区域里没找到成员列表，请重新框选',
  noframe: '没有收到画面', lost: '本地列表不见了，正在重新找…', locked: '监视中'
};
export function status() {
  const on = running();
  const reds = S.rows.filter((r) => r.cls === 'red' || r.cls === 'orange').length;
  let text = on ? STATE_TEXT[S.state] || S.state : '本地红名未开启';
  if (on && S.state === 'noframe' && S.native) text = S.grabErr === 'minimized' ? 'EVE 窗口最小化了，截不到画面' : S.grabErr === 'no-eve' ? '没找到 EVE 窗口：先打开游戏' : S.grabErr === 'gone' ? '选的 EVE 窗口关掉了：点「换窗口」重新选' : S.grabErr === 'covered' ? 'EVE 窗口被挡住了，截不到画面：把游戏窗口放到前面' : '截不到 EVE 窗口的画面';
  if (on && S.state === 'locked') text = `监视中 · 本地 ${S.rows.length} 人${reds ? ` · 红名 ${reds}` : ''}`;
  return { on, alert: on && reds > 0, text };
}

// ---------- 开始 / 停止 ----------
async function start() {
  if (running()) return;
  if (!supported()) { ctx.showToast(whyNot(), 'error', 5000); return; }
  if (tauri()) { await listWindows(); return; }
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
  track.addEventListener('ended', stop);
  const w = startWorker(false);
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
  notify();
}
// 桌面版：列出所有 EVE 窗口让用户选（多开时知道监视的是哪个号），每个窗口截一张缩略图；
// 1.0.7 及更早的客户端没有 local_windows：不选，自动找
async function listWindows() {
  let list;
  try { list = await tauri().invoke('local_windows'); }
  catch { S.hwnd = 0; S.winName = ''; startWorker(true); return; }
  if (!list.length) { S.wins = null; ctx.showToast('没找到 EVE 窗口：先打开游戏', 'error', 5000); notify(); return; }
  S.wins = list.map((w) => ({ ...w, name: w.title.replace(/^EVE( - )?/, '') || 'EVE', src: '' }));
  notify();
  for (const w of S.wins) {
    if (w.minimized) continue;
    try {
      const buf = await tauri().invoke('local_grab', { rect: null, hwnd: w.id, thumb: 360 });
      const v = new DataView(buf);
      w.src = toUrl({ width: v.getUint32(0, true), height: v.getUint32(4, true), data: new Uint8ClampedArray(buf.slice(8)) });
    } catch { w.src = ''; w.blocked = true; }
    notify();
  }
}
function useWindow(id) {
  const w = S.wins?.find((x) => x.id === id);
  if (!w) return;
  if (w.minimized) { ctx.showToast('这个窗口最小化了：先把游戏窗口还原，再点「刷新」', 'info', 5000); return; }
  S.hwnd = w.id; S.winName = w.name; S.wins = null;
  T.win = w.title; save();
  startWorker(true);
}
function windowsHtml() {
  const esc = ctx.esc;
  return `<div class="ka-opt ka-stack lw-opts"><span><b>选择要监视的 EVE 窗口</b><small>点一下就开始监视它；多开的话按角色名选${S.wins.length > 1 ? `（找到 ${S.wins.length} 个窗口）` : ''}</small></span>
    <div class="lw-opt-grid">${S.wins.map((w) => `<button type="button" class="lw-opt lw-win${w.title === T.win ? ' last' : ''}" data-lw-win="${w.id}">
      ${w.src ? `<img src="${w.src}" alt="">` : `<span class="lw-win-ph">${w.minimized ? '最小化了' : w.blocked ? '被挡住了，看不到预览' : '截图中…'}</span>`}
      <span class="lw-win-name"><span translate="no">${esc(w.name)}</span>${w.title === T.win ? ' <small>上次用的</small>' : ''}</span></button>`).join('')}</div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-lw-wins>刷新</button><button class="btn btn-ghost btn-sm" data-lw-wins-x>取消</button></div></div>`;
}
// native：桌面版截图（后台线程每次要画面都经这里调 local_grab）
function startWorker(native) {
  S.native = native;
  S.state = 'starting';
  S.since = Date.now();
  S.options = undefined;
  S.rows = []; S.people.clear(); S.gone.clear();
  const w = new Worker(new URL('./local-worker.js?v=v11', import.meta.url), { type: 'module' });
  S.worker = w;
  w.onmessage = onWorker;
  if (native) w.postMessage({ t: 'grab-mode' });
  if (T.manual) w.postMessage({ t: 'manual', rect: T.manual });
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
  if (S.video) { S.video.srcObject = null; S.video = null; }
  S.state = 'off';
  S.rows = []; S.people.clear(); S.gone.clear();
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
  if (m.t === 'grab' && S.native) {
    nativeGrab(m.rect, m.front).then((img) => {
      S.worker?.postMessage(img ? { t: 'grabbed', id: m.id, width: img.width, height: img.height, buffer: img.buffer } : { t: 'grabbed', id: m.id }, img ? [img.buffer] : []);
      if (!img && S.state !== 'noframe') { S.state = 'noframe'; notify(); }
    });
  } else if (m.t === 'grab') {
    const img = grabFromVideo(m.rect);
    S.worker?.postMessage(img ? { t: 'grabbed', id: m.id, width: img.width, height: img.height, buffer: img.data.buffer } : { t: 'grabbed', id: m.id }, img ? [img.data.buffer] : []);
  } else if (m.t === 'status') {
    const prev = S.state;
    S.state = m.state;
    if (m.state === 'locked') { S.region = m.region; S.options = undefined; }
    if (m.state === 'locked' || m.state === 'lost') { S.rows = []; S.people.clear(); S.gone.clear(); }
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
// 自己那一行没有图标，同联盟 / 同军团的人在游戏里一定带蓝 / 绿星：
// 没有图标、却和本地里带友方图标的人同联盟（或同军团）的，只可能是自己（或自己的另一个号）；绑定了 ESI 时也按联系人声望认友方
let friendOrgs = new Set();
function findMates() {
  friendOrgs = new Set();
  for (const p of S.people.values()) if (p.cls === 'friend' && p.affDone) { if (p.alliance) friendOrgs.add(p.alliance); if (p.corp) friendOrgs.add(p.corp); }
  for (const p of S.people.values()) if (!p.self && p.cls === 'none' && friendly(p)) { p.self = true; p.mate = true; }
}
// 自己：认出的名字是绑定的角色 / 点过「这是我」、和友方同联盟（findMates），或开始监视时就在、一直没有图标（后台线程标 mine）
const mine = (p) => p.self || p.init;
// 查到所属后认得出是友方：和本地里带友方图标的人同联盟 / 同军团，或 ESI 联系人声望是友方
const friendly = (p) => Boolean(p.affDone && (friendOrgs.has(p.alliance) || friendOrgs.has(p.corp) || ST.group({ char: p.charId, corp: p.corp, alliance: p.alliance }) === 'friend'));
// 名字和所属查完了（或查不到），可以下结论
const settled = (p) => p.look === 'miss' || p.affDone;
const alarming = (cls) => (cls === 'red' && T.red) || (cls === 'orange' && T.orange);
// 确认是敌对：红 / 橙（后台线程已确认颜色）等名字和所属查完（最多 2 秒）、不是友方；白名要名字和所属查完、不是自己和友方。
// 「只看色块」（withName 关）时红 / 橙颜色确认了就算，不等名字
const hostile = (p) => !mine(p) && ((p.cls === 'red' || p.cls === 'orange')
  ? !T.withName || ((settled(p) || Date.now() - p.hostileAt > 2000) && !friendly(p))
  : p.cls === 'none' && (!T.withName || (settled(p) && !friendly(p))));
// 本地里红名（红 / 橙，颜色已确认）与白名的人数：不算自己、不算查出来是友方的
function counts() {
  let red = 0, white = 0;
  for (const p of S.people.values()) {
    if (mine(p) || friendly(p)) continue;
    if (p.cls === 'red' || p.cls === 'orange') red++;
    else if (p.cls === 'none') white++;
  }
  return { red, white };
}
const countText = (c) => (c.red || c.white ? `本地 ${c.red} 个红名、${c.white} 个白名` : '本地没有红名 / 白名');

function onRows(m) {
  findMates();
  S.state = 'locked';   // 暂时截不到画面后又恢复了
  S.ms = m.ms;
  S.clipped = m.clipped;
  const alive = new Set();
  const fire = [];
  for (const r of m.rows) {
    alive.add(r.id);
    let p = S.people.get(r.id);
    // 滚出视野又滚回来的人后台线程会给回原编号：名字、所属、报过警都接着用
    if (!p) { p = S.gone.get(r.id) || newPerson(r.id); S.gone.delete(r.id); S.people.set(r.id, p); }
    p.first = r.first;
    Object.assign(p, { cls: r.cls, y: r.y, clipped: r.clipped, base: r.base, init: r.mine });
    // 红 / 橙：后台线程已确认颜色；默认再等名字和所属查完（最多 2 秒），是自己或友方（颜色认错）就不报
    if ((r.cls === 'red' || r.cls === 'orange') && !p.hostileAt) p.hostileAt = Date.now();
    if (!p.alerted && alarming(r.cls) && hostile(p)) { p.alerted = true; fire.push(p); }
    // 白名：认出名字、查到所属、确认不是自己后才报（基线里的不报：刚开始监视或换了星系）
    if (!p.alerted && T.neutral && r.cls === 'none' && !r.base && hostile(p)) { p.alerted = true; fire.push(p); }
  }
  for (const [id, p] of S.people) if (!alive.has(id) && !p.test) { S.people.delete(id); p.goneAt = Date.now(); S.gone.set(id, p); }
  for (const [id, p] of S.gone) if (Date.now() - p.goneAt > 10 * 60e3) S.gone.delete(id);
  S.rows = m.rows;
  if (fire.length) raise(fire);
  notify();
}

function raise(list) {
  const reds = list.filter((p) => p.cls === 'red' || p.cls === 'orange');
  // 只看色块（不识别名字）：只报人数
  const colorOnly = !T.withName && !list[0].test;
  const title = colorOnly ? `${reds.length ? '红名进本地' : '白名进本地'} · ${countText(counts())}` : reds.length ? `本地出现 ${reds.length} 个红名` : `本地来了 ${list.length} 个白名`;
  const at = Date.now();
  const entry = { at, ids: colorOnly ? [] : list.map((p) => p.id), names: [], cls: reds.length ? 'red' : 'none', n: list.length, title, colorOnly };
  S.log.unshift(entry);
  S.log.length = Math.min(S.log.length, 30);
  S.lastAlert = at;
  clearTimeout(S.alertTimer);
  S.alertTimer = setTimeout(notify, 61e3);
  if (T.sound) beep(reds.length ? 4 : 2);
  if (T.web) card(entry);
  publishFloat();
  FF.alert('local');
  // 名字要等文字识别（一般不到 1 秒），系统通知与微信 / 邮箱等名字认出来再发，最多等 2 秒
  const t0 = Date.now();
  const later = () => {
    const ps = entry.ids.map((id) => S.people.get(id)).filter(Boolean);
    if (T.withName && ps.some((p) => p.look === 'ocr') && Date.now() - t0 < 2000) { setTimeout(later, 200); return; }
    entry.names = ps.map((p) => p.name || '?');
    const body = colorOnly ? '' : entry.names.join('、');
    if (T.notify && window.Notification?.permission === 'granted') {
      try { const n = new Notification(title, { body, tag: 'eve-local', renotify: true }); n.onclick = () => window.focus(); } catch { /* 忽略 */ }
    }
    if (!list[0].test) AP.push('local', { sig: 'local|' + at + '|' + body, text: body ? `${title} · ${body}` : title });
    notify();
  };
  if (T.withName) setTimeout(later, 200); else later();
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
    <div class="ka-body">${entry.colorOnly ? '' : ps.length ? ps.map((p) => `<span class="lw-card-who"><i class="lw-dot ${p.cls}"></i>${p.name ? `<span translate="no">${ctx.esc(p.name)}</span>` : '<span>识别中…</span>'}${p.st ? ` <small>${statLine(p)}</small>` : ''}</span>`).join('') : ctx.esc(entry.names.join('、'))}</div>
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
  // 只看色块：不识别名字（打开「色块 + 人物名」时再补认）
  if (!T.withName) { S.people.get(m.id).look = 'off'; return; }
  ocrQ = ocrQ.then(async () => {
    const p = S.people.get(m.id) || S.gone.get(m.id);
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

// 名字 → 角色 ID：先按识别出的完整名字查 ESI；查不到（文字识别认错一两个字母）或名字被截断时在本站按开头几个字母搜，
// 和识别结果最像（编辑距离最小、且在容许范围内）的只有一个才认；截断的名字只比较能看到的那一段。
// 多个同样像的（常是同一人的一串小号）不猜：显示识别到的文字并标「…?」，免得显示别人的击杀记录
async function identify(p) {
  let id = 0, cand = 0;
  // 判成截断的也先按完整名字查一次：几个名字碰巧一样长时会被误判成截断
  id = (await ST.idsByName([p.raw])).get(p.raw.toLowerCase()) || 0;
  if (id) p.clipped = false;
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
  p.affDone = true;
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
  if (!FF.isOpen('local') && !S.floatOn && !running()) return;
  FF.publish('local', floatData());
}
export function floatData() {
  const st = status();
  const all = [...S.people.values()].filter((p) => !mine(p));
  // 悬浮窗只列认出来、确认是敌对的人（颜色确认了、名字认出来、所属查完且不是友方）；
  // 颜色确认了但名字没认全的只写「还有 N 个红名」；只看色块（不识别名字）时不列人，只写红名、白名各几个
  const sure = (p) => hostile(p) && p.name && p.affDone && !friendly(p);
  const people = !T.withName ? [] : all.filter((p) => (T.onlyHostile ? sure(p) : shown(p))).sort((a, b) => rank(a) - rank(b) || a.y - b.y);
  const c = counts();
  const listed = (f) => people.filter((p) => f(p.cls)).length;
  const moreRed = T.withName && T.onlyHostile ? Math.max(0, c.red - listed((x) => x === 'red' || x === 'orange')) : 0;
  const moreWhite = T.withName && T.onlyHostile ? Math.max(0, c.white - listed((x) => x === 'none')) : 0;
  return {
    on: st.on, status: st.text, clipped: S.clipped && T.withName, n: S.rows.length,
    hidden: T.withName && T.onlyHostile ? Math.max(0, all.length - people.length - moreRed - moreWhite) : 0,
    colorOnly: !T.withName, reds: c.red, whites: c.white, moreRed, moreWhite,
    items: people.map((p) => ({
      id: p.charId || 0, key: p.id, cls: p.cls, name: p.name || '', sure: Boolean(p.charId) || !p.clipped, look: p.look, clipped: p.clipped,
      org: [p.allianceName, p.corpName].filter(Boolean).join(' · '),
      st: p.st ? { kills: p.st.kills, losses: p.st.losses, solo: p.st.solo || 0, ships: p.ships || [], last: p.st.last || '' } : null,
      fresh: !p.base && Date.now() - p.first < 60e3
    }))
  };
}
// 「只显示红名 / 白名」开着时：友方（蓝、绿、紫等）、自己、刚出现还没定颜色的不显示
const shown = (p) => !T.onlyHostile || (!mine(p) && (p.cls === 'red' || p.cls === 'orange' || p.cls === 'none'));
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
  if (!frame) { ctx.showToast(S.native && S.grabErr === 'minimized' ? 'EVE 窗口最小化了：先把游戏窗口还原' : '还没有收到画面', 'error'); return; }
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
  // 一个像名单的地方都没有（比如本地只有一两个彩色图标）：直接让用户在截图上框出来
  if (!S.options.length) return `<div class="ka-opt ka-stack lw-opts"><span><b>没认出本地频道</b><small>截一张游戏画面，把本地成员列表框出来就行（${tip}）</small></span>
    <div class="ka-actions"><button class="btn btn-primary btn-sm" data-lw-pick>截图框选</button><button class="btn btn-ghost btn-sm" data-lw-reopt>重新截取</button></div></div>`;
  return `<div class="ka-opt ka-stack lw-opts"><span><b>没认出哪个是本地频道，下面哪个是？</b><small>点一下就用它；都不是的话点「都不是，自己框选」</small></span>
    <div class="lw-opt-grid">${S.options.map((o, i) => `<button type="button" class="lw-opt" data-lw-opt="${i}"><img src="${o.src}" alt="候选 ${i + 1}"></button>`).join('')}</div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-lw-pick>都不是，自己框选</button><button class="btn btn-ghost btn-sm" data-lw-reopt>重新截取</button></div></div>`;
}

function drawPanel() {
  if (!supported()) return `<p class="ka-warn">${whyNot()}</p>`;
  const esc = ctx.esc;
  const st = status();
  const on = st.on;
  const slow = on && S.state !== 'locked' && Date.now() - S.since > 8000;
  const everyone = [...S.people.values()];
  const people = everyone.filter(shown).sort((a, b) => a.y - b.y);
  const hid = everyone.length - people.length;
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  return `
    <div class="ka-top"><span class="ka-status${on ? ' on' : ''}"><i></i>${esc(st.text)}</span>${FF.buttonHtml('local')}</div>
    <p class="ka-note">${tauri() ? '直接截取 EVE 窗口，自动找到本地频道的成员列表，每 0.1 秒看一次；画面只在本机处理，不会上传' : '共享 EVE 窗口后自动找到本地频道的成员列表，每 0.1 秒看一次；画面只在本机处理，不会上传'}</p>
    ${sec('监视', `<div class="ka-list">
      <div class="ka-opt"><span><b>${on ? (S.winName ? `正在监视：<span translate="no">${esc(S.winName)}</span>` : '正在监视') : tauri() ? '监视游戏画面' : '共享游戏画面'}</b><small>${on ? (S.region ? `本地列表 ${S.region.w}×${S.region.h}${T.manual ? '（手动框选）' : ''} · 每次 ${S.ms} 毫秒` : '') : tauri() ? '点「开始」后选择 EVE 窗口，游戏不要最小化' : '选择 EVE 窗口（或整个屏幕）'}</small></span>
        <span class="ka-ctl">${on ? `${S.winName ? '<button class="btn btn-ghost btn-sm" data-lw-rewin>换窗口</button>' : ''}<button class="btn btn-ghost btn-sm" data-lw-pick>手动框选</button><button class="btn btn-ghost btn-sm" data-lw-stop>停止</button>` : S.wins ? '' : '<button class="btn btn-primary btn-sm" data-lw-start>开始</button>'}</span></div>
      ${!on && S.wins ? windowsHtml() : ''}
      ${slow ? optionsHtml() : ''}
      ${on && T.manual ? `<div class="ka-opt"><span><b>只在选定的区域里找</b><small>${S.state === 'manual-miss' ? '选定的区域里没有成员列表了（窗口挪动过？）' : '本地频道窗口挪动后要重新选'}</small></span><button class="btn btn-ghost btn-sm" data-lw-auto>改回自动识别</button></div>` : ''}
      ${on && S.clipped ? '<p class="ka-warn">有名字显示不全（标「…?」的没认出来）：把本地频道的成员列表拉宽一点就好</p>' : ''}
      ${sw('red', '红名报警', '声望恶劣、敌对', '图标为红色的人一出现就报警')}
      ${sw('orange', '橙名报警', '声望不良、嫌犯、罪犯', '图标为橙色 / 黄色的人一出现就报警')}
      ${sw('neutral', '白名也报警', '没有声望图标的人（中立）', '00 区里中立一般也是敌人；名字认出来、确认不是自己后才报')}
      ${sw('withName', '色块 + 人物名一起预警', '关掉就只看色块：颜色确认了马上报警', '开着时等名字和所属查完（最多 2 秒）再报，并排除自己和友方；关掉报得快，但颜色认错的友方也会报')}
    </div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('sound', '提示音')}
      ${sw('web', '网页卡片', '', '右上角弹出卡片')}
      ${sw('notify', '系统通知', '', '浏览器在后台时也能看到（需要允许通知）')}
      ${AP.switchHtml('local')}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-lw-test>测试提醒</button></div>`)}
    ${sec(`本地名单${everyone.length ? `（${everyone.length}）` : ''}`, `<div class="ka-list">${sw('onlyHostile', '只显示红名 / 白名', hid ? `已隐藏 ${hid} 个友方` : '友方（蓝、绿、紫等）不显示', '关掉就显示本地里的所有人；悬浮窗也一样')}</div>` + (!T.withName ? `<p class="ka-empty">${on ? `${countText(counts())}（只看色块，不识别名字）` : '开始监视后显示红名、白名人数'}</p>` : people.length ? `<ul class="lw-list">${people.map((p) => `<li class="lw-row ${p.cls}${mine(p) ? ' self' : ''}">
        <i class="lw-dot ${p.cls}" title="${CLS[p.cls] || ''}"></i>
        <span class="lw-who"><b>${p.charId ? `<a class="kb-link" href="#kb/character/${p.charId}" translate="no">${esc(p.name)}</a>` : p.name ? `<span translate="no">${esc(p.name)}</span>` : `<span>${p.look === 'ocr' ? '识别中…' : '没认出来'}</span>`}</b>${!p.charId && p.clipped && p.name ? `<small class="lw-unsure" title="${p.cand ? `名字显示不全，同前缀的有 ${p.cand} 个人` : '名字显示不全，没查到'}">…?</small>` : ''}${mine(p) ? ` <small${p.mate ? ' title="没有声望图标，又和本地里的友方同联盟 / 同军团，应该是你自己"' : !p.self ? ' title="开始监视时就在本地、一直没有声望图标，当作你自己"' : ''}>（我）</small>` : ''}
          <small>${p.charId ? ST.badge({ char: p.charId, corp: p.corp, alliance: p.alliance }) : ''}<span translate="no">${esc([p.allianceName, p.corpName].filter(Boolean).join(' · '))}</span>${p.st ? ` · ${statLine(p)}` : ''}</small></span>
        ${p.raw && !mine(p) && p.cls === 'none' ? `<button class="btn btn-ghost btn-sm" data-lw-me="${esc(p.raw)}" title="以后不对这个名字报警">这是我</button>` : ''}</li>`).join('')}</ul>`
      : `<p class="ka-empty">${!on ? '开始监视后显示本地里的人' : everyone.length ? '本地没有红名 / 白名' : '还没有识别到名单'}</p>`))}
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
    else if (t('[data-lw-win]')) useWindow(Number(t('[data-lw-win]').dataset.lwWin));
    else if (t('[data-lw-wins]')) listWindows();
    else if (t('[data-lw-wins-x]')) { S.wins = null; notify(); }
    else if (t('[data-lw-rewin]')) { stop(); listWindows(); }
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
    // 打开「色块 + 人物名」：之前没认的名字补认
    if (key === 'withName' && T.withName) for (const p of S.people.values()) if (p.look === 'off') { p.look = 'ocr'; S.worker?.postMessage({ t: 'reocr', id: p.id }); }
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
