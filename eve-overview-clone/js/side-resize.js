// ===== 侧栏宽度：拖侧栏右边缘调宽窄，每个侧栏各自记住；「个性化」里一键全部恢复默认 =====
// 全站各页的侧栏（.sidebar：市场目录、星图、装配、制造、行星工业、LP、快递、教程、主权、角色交易、深渊、个人中心）都按 --sidebar-w 定宽。
// 这里给每个侧栏右边缘加一条拖动条：拖动时把宽度写进这个侧栏自己的 --side-w（CSS 里 .sidebar.has-side-w 用它代替默认宽度），
// 松手后存进 localStorage「eve-side-w」（{ 侧栏 id: 宽度 }，只存在本机，不跟云同步——各台电脑屏幕不一样）。双击拖动条恢复这个侧栏的默认宽度。
// 手机宽度（≤768px）侧栏是抽屉，不用自定义宽度（CSS 只在宽屏生效，拖动条也藏起来）。
const KEY = 'eve-side-w';
const MIN = 200, MAX = 760;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const write = (o) => { try { if (Object.keys(o).length) localStorage.setItem(KEY, JSON.stringify(o)); else localStorage.removeItem(KEY); } catch { /* 隐私模式：只在这次打开里有效 */ } };
// 屏幕变窄后，侧栏最多占六成宽（CSS 里也用 min(…, 60vw) 兜底）
const clamp = (w) => Math.round(Math.max(MIN, Math.min(MAX, window.innerWidth * 0.6, w)));

let sidebars = [];

function apply(el, w) {
  if (w) { el.style.setProperty('--side-w', w + 'px'); el.classList.add('has-side-w'); }
  else { el.style.removeProperty('--side-w'); el.classList.remove('has-side-w'); }
}
// 侧栏宽度变了：星图、图表等按窗口大小排版的组件跟着重排
const relayout = () => window.dispatchEvent(new Event('resize'));

function bind(el) {
  const grip = document.createElement('div');
  grip.className = 'side-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', '调整侧栏宽度');
  grip.title = '拖动调整宽度，双击恢复默认';
  el.appendChild(grip);
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.classList.contains('collapsed')) return;
    e.preventDefault();
    drag = { x: e.clientX, w: el.getBoundingClientRect().width, id: e.pointerId };
    grip.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('side-resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    apply(el, clamp(drag.w + e.clientX - drag.x));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    document.documentElement.classList.remove('side-resizing');
    const w = parseInt(el.style.getPropertyValue('--side-w'), 10);
    const saved = read();
    if (w) saved[el.id] = w; else delete saved[el.id];
    write(saved);
    relayout();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => {
    const saved = read();
    delete saved[el.id];
    write(saved);
    apply(el, 0);
    relayout();
  });
}

// ids：各侧栏元素的 id
export function initSideResize(ids) {
  const saved = read();
  sidebars = ids.map((id) => document.getElementById(id)).filter(Boolean);
  for (const el of sidebars) {
    bind(el);
    if (saved[el.id]) apply(el, Math.round(Math.max(MIN, Math.min(MAX, saved[el.id]))));   // 窗口比上次窄时由 CSS 的 60vw 兜底，不改存的值
  }
}

export const hasCustomWidth = () => Object.keys(read()).length > 0;

// 「个性化」里的「恢复默认」：所有侧栏回到默认宽度
export function resetSideWidths() {
  write({});
  for (const el of sidebars) apply(el, 0);
  relayout();
}
