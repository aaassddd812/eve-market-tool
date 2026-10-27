// ===== 悬浮窗（单物品行情窗口、装配页物品详情共用）=====
// 入口：带 data-<attr>="id" 的元素。鼠标停留 180 ms 打开预览，移出关闭；点击入口或在窗口里操作即固定，固定后可拖动标题栏（data-float-drag）。
//   窗口里的入口点击直接在本窗口换内容；触屏点击直接打开（手机上全屏）；Esc 关闭最上面的一个；同一种窗口只有一个，新入口替换前一个。
// 窗口尺寸由各自的 CSS 固定；内容由调用方在 onOpen 里填。

const HOVER_DELAY = 180;
const LEAVE_DELAY = 160;
const MOBILE = window.matchMedia('(max-width: 768px)');
const ALL = [];
let zTop = 990;
// 关窗后指针没动时不按悬停重新打开（窗口盖住的入口露出来会再收到 pointerover）
const ptr = { x: -1, y: -1, closedAt: null };
document.addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; }, { passive: true });
const stillSinceClose = () => ptr.closedAt && ptr.closedAt[0] === ptr.x && ptr.closedAt[1] === ptr.y;

export const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
export const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z"/><path d="M8 2h8"/></svg>';
export const pinBtn = () => `<button type="button" class="ip-btn" data-float-pin title="固定窗口（固定后可拖动标题栏）" aria-label="固定窗口" aria-pressed="false">${ICON_PIN}</button>`;
export const closeBtn = () => `<button type="button" class="ip-btn" data-float-close title="关闭（Esc）" aria-label="关闭">${ICON_X}</button>`;

// attr：入口 data 属性名（不含 data-）；html：窗口内部结构；onOpen(id, { anchor })：换到新 id 时填内容；onClose()：关闭时清理；
// hover：false 时只能点击打开（打开即固定）
export function makeFloat({ attr, className, label, html, onOpen, onClose, hover = true }) {
  const sel = `[data-${attr}]`;
  const idOf = (el) => Number(el.getAttribute(`data-${attr}`));
  const S = { el: null, id: 0, pinned: false, hoverTimer: 0, leaveTimer: 0, hoverId: 0 };

  function ensure() {
    if (S.el) return S.el;
    const el = document.createElement('div');
    el.className = `float-pop ${className}`;
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', label);
    el.innerHTML = html;
    document.body.appendChild(el);
    S.el = el;
    el.addEventListener('pointerdown', (e) => {
      el.style.zIndex = String(++zTop);
      if (!e.target.closest('[data-float-close],[data-float-pin]')) pin();
      if (e.target.closest('[data-float-drag]') && !e.target.closest('button, a, input, select') && !MOBILE.matches && e.button === 0) startDrag(e);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-float-close]')) { close(); return; }
      const p = e.target.closest('[data-float-pin]');
      if (p) setPinned(!S.pinned);
    });
    window.addEventListener('resize', () => { if (!el.hidden) clampInView(); });
    return el;
  }

  function setPinned(v) {
    S.pinned = v;
    S.el.classList.toggle('pinned', v);
    S.el.querySelector('[data-float-pin]')?.setAttribute('aria-pressed', String(v));
  }
  const pin = () => { if (!S.pinned) setPinned(true); };

  function open(id, { anchor = null, pinned = true } = {}) {
    if (!id) return;
    const el = ensure();
    clearTimeout(S.leaveTimer);
    const wasOpen = !el.hidden;
    const same = wasOpen && S.id === id;
    const inside = anchor && el.contains(anchor);
    S.id = id;
    setPinned(pinned || (same && S.pinned) || Boolean(inside));
    el.hidden = false;
    el.style.zIndex = String(++zTop);
    if (inside || (wasOpen && S.pinned && pinned)) clampInView();
    else place(anchor);
    if (!same) onOpen(id, { anchor });
  }

  function close() {
    clearTimeout(S.leaveTimer);
    if (!S.el || S.el.hidden) return;
    S.el.hidden = true;
    setPinned(false);
    S.hoverId = 0;
    S.id = 0;
    ptr.closedAt = [ptr.x, ptr.y];
    onClose?.();
  }

  function armHover(entry) {
    const id = idOf(entry);
    if (!id || S.hoverId === id || stillSinceClose()) return;
    S.hoverId = id;
    clearTimeout(S.hoverTimer);
    if (S.el && !S.el.hidden && S.id === id) { clearTimeout(S.leaveTimer); return; }
    if (S.pinned && S.el && !S.el.hidden) return;   // 已固定的窗口不被悬停替换
    S.hoverTimer = setTimeout(() => open(id, { anchor: entry, pinned: false }), HOVER_DELAY);
  }

  if (hover) document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const entry = e.target.closest?.(sel);
    if (entry && !S.el?.contains(entry)) { armHover(entry); return; }
    if (S.el && S.el.contains(e.target)) clearTimeout(S.leaveTimer);
  });
  if (hover) document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const to = e.relatedTarget;
    const entry = e.target.closest?.(sel);
    if (entry && !entry.contains(to)) { clearTimeout(S.hoverTimer); S.hoverId = 0; }
    if (!S.el || S.pinned || S.el.hidden) return;
    if ((entry || S.el.contains(e.target)) && !S.el.contains(to) && !to?.closest?.(`[data-${attr}="${S.id}"]`)) {
      clearTimeout(S.leaveTimer);
      S.leaveTimer = setTimeout(close, LEAVE_DELAY);
    }
  });
  // 捕获阶段处理入口点击，不再触发所在行自己的点击
  document.addEventListener('click', (e) => {
    const entry = e.target.closest?.(sel);
    if (!entry) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(S.hoverTimer);
    open(idOf(entry), { anchor: entry, pinned: true });
  }, true);

  // 预览贴在入口旁边（右侧放不下放左侧）；没有小入口（例如点整行）时居中
  function place(anchor) {
    const el = S.el;
    if (MOBILE.matches) { el.style.left = el.style.top = ''; return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    let x, y;
    const r = anchor?.getBoundingClientRect?.();
    if (r && r.width && r.width < 200) {
      x = r.right + 12 + w <= innerWidth - 8 ? r.right + 12 : r.left - 12 - w;
      if (x < 8) x = Math.max(8, Math.min(innerWidth - w - 8, r.left));
      y = Math.min(Math.max(8, r.top - 40), innerHeight - h - 8);
    } else {
      x = (innerWidth - w) / 2;
      y = Math.max(8, (innerHeight - h) / 2);
    }
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(Math.max(8, y)) + 'px';
  }

  function clampInView() {
    const el = S.el;
    if (MOBILE.matches) return;
    const r = el.getBoundingClientRect();
    el.style.left = Math.round(Math.min(Math.max(8, r.left), innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.round(Math.min(Math.max(8, r.top), innerHeight - Math.min(r.height, innerHeight - 16) - 8)) + 'px';
  }

  function startDrag(e) {
    const el = S.el;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.classList.add('dragging');
    const move = (ev) => {
      el.style.left = Math.round(Math.min(Math.max(80 - r.width, ev.clientX - dx), innerWidth - 80)) + 'px';
      el.style.top = Math.round(Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40)) + 'px';
    };
    const up = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  }

  const api = { open, close, get el() { return ensure(); }, get id() { return S.id; }, get open_() { return S.el && !S.el.hidden; } };
  ALL.push(api);
  return api;
}

// Esc 关闭最上面的悬浮窗（页面上有普通弹窗时先让弹窗处理）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.modal:not([hidden])')) return;
  const top = ALL.filter((f) => f.open_).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
  if (!top) return;
  e.stopImmediatePropagation();
  top.close();
}, true);
