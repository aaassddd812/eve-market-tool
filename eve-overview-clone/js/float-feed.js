// ===== 悬浮窗（击杀预警、到价提醒、本地红名）：主页面这一侧 =====
// 悬浮窗是站内的 float.html?kind=…，内容由主页面经 BroadcastChannel（eve-float）推过去，悬浮窗只负责显示：
//   主页面 → 悬浮窗：{ t: 'snap', kind, data } 最新内容；{ t: 'ready' } 主页面刚打开（悬浮窗重新要一次内容）
//   悬浮窗 → 主页面：{ t: 'hello', kind } 要内容；{ t: 'alive', kind } 每 20 秒报一次还开着；{ t: 'open-kill' | 'open-item' | 'open-char', id } 在主页面打开详情
// 打开方式：
//   桌面版（Tauri）：原生窗口，置顶、无边框、可半透明、可鼠标穿透（float_open 命令，见 desktop/src-tauri/src/lib.rs）。
//   网页：Chrome / Edge 116+ 的文档画中画（documentPictureInPicture），窗口里放一个 iframe 加载 float.html；每个标签页只能开一个，
//     画中画里可以在击杀预警 / 到价提醒 / 本地红名之间切换。其他浏览器不支持。
// 模块各自发布内容（publish）；悬浮窗要内容而模块还没加载时，用登记的 loader 加载（loader 加载后会自己 publish）。

const CH = 'eve-float';
const FLOAT_V = 'v4';   // 跟 float.html 里 float-view.js 的版本号一致：改了悬浮窗页面就一起改，旧的画中画会重新加载
export const KINDS = { kill: '击杀预警', price: '到价提醒', local: '本地红名' };
const snap = {};
const loaders = {};
const seen = {};     // kind -> 悬浮窗最后一次报到的时间
let bc = null;
let handlers = {};   // openKill(id), openItem(id), openChar(id), showToast
let pip = null;      // 网页画中画窗口

const tauri = () => (window.__EVE_DESKTOP__ && window.__TAURI_INTERNALS__) || null;
export const canFloat = () => Boolean(tauri() || 'documentPictureInPicture' in window);

export function initFloatFeed(h) {
  handlers = h;
  if (bc || typeof BroadcastChannel !== 'function') return;
  bc = new BroadcastChannel(CH);
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (!KINDS[m.kind] && (m.t === 'hello' || m.t === 'alive')) return;
    if (m.t === 'hello' || m.t === 'alive') {
      seen[m.kind] = Date.now();
      if (m.t === 'hello') {
        if (snap[m.kind]) send(m.kind);
        loaders[m.kind]?.();
      }
    } else if (m.t === 'open-kill') handlers.openKill?.(Number(m.id));
    else if (m.t === 'open-item') handlers.openItem?.(Number(m.id));
    else if (m.t === 'open-char') handlers.openChar?.(Number(m.id));
  };
  bc.postMessage({ t: 'ready' });
}

function send(kind) { try { bc?.postMessage({ t: 'snap', kind, data: snap[kind] }); } catch { /* 数据不能序列化时忽略 */ } }

// 模块发布最新内容
export function publish(kind, data) {
  snap[kind] = data;
  send(kind);
}
// 悬浮窗要这种内容时怎么加载对应模块
export function setLoader(kind, fn) { loaders[kind] = () => Promise.resolve().then(fn).catch(() => {}); }
// 有没有这种悬浮窗开着（到价提醒据此决定后台要不要接着查价）
export const isOpen = (kind) => Date.now() - (seen[kind] || 0) < 75e3;

export async function openFloat(kind) {
  const t = tauri();
  if (t) {
    try { await t.invoke('float_open', { kind, title: KINDS[kind] }); seen[kind] = Date.now(); loaders[kind]?.(); }
    catch { handlers.showToast?.('悬浮窗打不开，请更新桌面版', 'error'); }
    return;
  }
  if (!('documentPictureInPicture' in window)) {
    handlers.showToast?.('这个浏览器不支持悬浮窗：请用 Chrome / Edge，或下载桌面版', 'error', 5000);
    return;
  }
  const src = `float.html?kind=${kind}&pip=1&v=${FLOAT_V}`;
  if (pip && !pip.closed) {
    const f = pip.document.querySelector('iframe');
    // 画中画是网站更新前打开的（版本号不同）：重新加载成新版
    if (f && !f.src.endsWith('&v=' + FLOAT_V)) f.src = src;
    else if (f) f.contentWindow.postMessage({ t: 'kind', kind }, location.origin);
    pip.focus();
    return;
  }
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 420 });
  } catch {
    handlers.showToast?.('浏览器没有允许打开悬浮窗', 'error');
    return;
  }
  const d = pip.document;
  d.title = KINDS[kind];
  const st = d.createElement('style');
  st.textContent = 'html,body{margin:0;height:100%;background:#0b0f17;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
  d.head.append(st);
  const f = d.createElement('iframe');
  f.src = src;
  d.body.append(f);
  seen[kind] = Date.now();
  loaders[kind]?.();
  pip.addEventListener('pagehide', () => { pip = null; });
}

// 「悬浮窗」按钮（击杀预警、本地红名标签页、自选看板里用）
export const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>';
export const buttonHtml = (kind, cls = 'btn btn-ghost btn-sm') => (canFloat()
  ? `<button type="button" class="${cls} float-open-btn" data-float-open="${kind}" title="${tauri() ? '置顶的小窗口，可以盖在游戏上面（游戏用窗口化或无边框窗口）' : '置顶的小窗口（Chrome / Edge 画中画），可以盖在游戏上面（游戏用窗口化或无边框窗口）'}">${ICON}悬浮窗</button>`
  : '');
// 页面上任何 [data-float-open] 按钮
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-float-open]');
  if (b && KINDS[b.dataset.floatOpen]) { e.preventDefault(); openFloat(b.dataset.floatOpen); }
});
