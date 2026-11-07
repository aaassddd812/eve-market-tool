// ===== 手机返回键（安卓 App 与手机浏览器）=====
// 安卓 App 的壳（Tauri）按返回键时：网页能后退就后退，不能就退出程序。原来弹窗、悬浮窗、抽屉都不进浏览历史，切底部标签用 replaceState，
// 所以一按返回就直接退出了。这里把返回键改成：
//   1. 有弹窗 / 悬浮窗 / 底部菜单 / 侧栏抽屉开着：关掉最上面的一个（每打开一个就压一条同地址的历史，按返回时吃掉这条、发 Esc 关窗）；
//      用界面上的 ✕ 关掉时，把压的那条历史退掉。
//   2. 否则正常后退（切页面改成 pushState，见 modern-app.js 的 switchView）。
//   3. 只在 App 里：退到最早一页时提示「再按一次返回键退出」，2 秒内再按才退出（最早一页上面垫一条历史，按到它时提示，2 秒后再垫回去）。
// 吃掉的那次后退不交给页面的路由（第一个注册 popstate、stopImmediatePropagation），并把地址改回当前地址。
// 页面自己 pushState 时如果顶上是弹窗压的历史，就直接替换掉它（不然之后退掉弹窗那条会把新页面退掉）。

const OVERLAYS = '.modal:not([hidden]), .float-pop:not([hidden]), .msheet.open, .drawer-open, .pie-modal:not([hidden]), .sim-at-modal';
const APP = Boolean(window.__EVE_APP__);
const MOBILE = window.matchMedia('(max-width: 768px)');
export const enabled = () => APP || MOBILE.matches;

let ctx = null;   // showToast
let depth = 0;    // 为开着的弹窗压了几条历史
let skip = 0;     // 自己调用 history.go 引起的 popstate，直接吞掉
let href = location.href;
let rootTimer = 0;
let popping = false;   // 正在处理一次后退（页面路由切视图时不要再 pushState）
export const isPopping = () => popping;
const nativePush = history.pushState.bind(history);
const nativeReplace = history.replaceState.bind(history);

const openOverlays = () => [...document.querySelectorAll(OVERLAYS)].filter((el) => el.getClientRects().length || el.classList.contains('drawer-open'));

export function initBackNav(context) {
  ctx = context;
  history.pushState = (state, title, url) => {
    if (depth > 0) { depth--; nativeReplace(state, title, url); } else nativePush(state, title, url);
    href = location.href;
  };
  history.replaceState = (state, title, url) => {
    // 最早一页垫的那条被页面改地址时保留标记
    nativeReplace(history.state?.eveRoot && state == null ? { eveRoot: 1 } : state, title, url);
    href = location.href;
  };
  window.addEventListener('popstate', onPop);
  if (APP && !sessionStorage.getItem('eve-back-root')) {
    try { sessionStorage.setItem('eve-back-root', '1'); } catch { /* 忽略 */ }
    nativeReplace({ eveBase: 1 }, '', location.href);
    nativePush({ eveRoot: 1 }, '', location.href);
  }
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'] });
}

let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(sync);
}
// 弹窗数量变了：多了就压历史，少了（点 ✕ 关的）就退掉多压的
function sync() {
  raf = 0;
  if (!enabled()) return;
  const n = openOverlays().length;
  if (n > depth) {
    for (; depth < n; depth++) nativePush({ eveBack: 1 }, '', location.href);
  } else if (n < depth) {
    skip++;
    history.go(n - depth);
    depth = n;
  }
}

function swallow(e) {
  e.stopImmediatePropagation();
  nativeReplace(history.state, '', href);
}

function onPop(e) {
  if (skip > 0) { skip--; swallow(e); return; }
  if (depth > 0) {
    depth--;
    swallow(e);
    closeTop();
    return;
  }
  if (APP && history.state?.eveBase) {
    swallow(e);
    ctx.showToast('再按一次返回键退出', 'info', 2000);
    clearTimeout(rootTimer);
    // 2 秒内没再按：把垫的那条放回去（再按就没有可后退的了，壳会退出程序）
    rootTimer = setTimeout(() => { if (history.state?.eveBase) nativePush({ eveRoot: 1 }, '', location.href); }, 2000);
    return;
  }
  href = location.href;
  popping = true;
  setTimeout(() => { popping = false; }, 0);
}

// 关最上面的一个：先发 Esc（各弹窗都处理 Esc），没关掉再点它的关闭按钮或直接隐藏
function closeTop() {
  const list = openOverlays();
  const top = list.sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0];
  if (!top) return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  requestAnimationFrame(() => {
    if (!top.isConnected || !openOverlays().includes(top)) return;
    const btn = top.querySelector('[data-float-close], .modal-close, [data-close], .ka-close, .modal-backdrop');
    if (btn) btn.click();
    else if (!top.classList.contains('drawer-open')) top.hidden = true;
    schedule();
  });
}
