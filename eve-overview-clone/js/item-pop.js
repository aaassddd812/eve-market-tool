// ===== 单物品行情窗口：入口与窗口外壳 =====
// 入口：带 data-item-pop="typeId" 的物品图标。鼠标停留 180 ms 打开预览，移出关闭；点击图标或在窗口里操作即固定，固定后可拖动标题栏。
//   触屏点击直接打开（手机上全屏）；Esc 关闭；同一时间只开一个窗口，新入口会替换前一个。
// 外壳负责定位、固定尺寸、拖动和标题栏（图标、名称、分类、Type ID、复制、跳转市场中心），内容由 item-panel.js 在第一次打开时才加载。

let ctx = null;   // typeName, groupPath, iconUrl, copyText, openItem, loadPanel
const HOVER_DELAY = 180;
const LEAVE_DELAY = 160;
const W = 880, H = 640;
const MOBILE = window.matchMedia('(max-width: 768px)');
const P = { el: null, id: 0, pinned: false, panel: null, hoverTimer: 0, leaveTimer: 0, hoverId: 0, drag: null };

export function initItemPop(context) {
  ctx = context;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const icon = e.target.closest?.('[data-item-pop]');
    if (icon) { armHover(icon); return; }
    if (P.el && P.el.contains(e.target)) clearTimeout(P.leaveTimer);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const to = e.relatedTarget;
    const icon = e.target.closest?.('[data-item-pop]');
    if (icon && !icon.contains(to)) { clearTimeout(P.hoverTimer); P.hoverId = 0; }
    if (!P.el || P.pinned || P.el.hidden) return;
    if ((icon || P.el.contains(e.target)) && !P.el.contains(to) && !to?.closest?.(`[data-item-pop="${P.id}"]`)) {
      clearTimeout(P.leaveTimer);
      P.leaveTimer = setTimeout(close, LEAVE_DELAY);
    }
  });
  // 捕获阶段处理图标点击，不再触发所在行自己的点击（例如打开物品页）
  document.addEventListener('click', (e) => {
    const icon = e.target.closest?.('[data-item-pop]');
    if (!icon || P.el?.contains(icon)) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(P.hoverTimer);
    openItemPop(Number(icon.dataset.itemPop), { anchor: icon, pinned: true });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && P.el && !P.el.hidden && !document.querySelector('.modal:not([hidden])')) { e.stopImmediatePropagation(); close(); }
  }, true);
}

function armHover(icon) {
  const id = Number(icon.dataset.itemPop);
  if (!id || P.hoverId === id) return;
  P.hoverId = id;
  clearTimeout(P.hoverTimer);
  if (P.el && !P.el.hidden && P.id === id) { clearTimeout(P.leaveTimer); return; }
  if (P.pinned && P.el && !P.el.hidden) return;   // 已固定的窗口不被悬停替换
  P.hoverTimer = setTimeout(() => openItemPop(id, { anchor: icon, pinned: false }), HOVER_DELAY);
}

// summary：可选的 [[标签, 值, class]]，显示在标题栏下（例如倒卖排行这一行的路线与利润）
export function openItemPop(typeId, { anchor = null, pinned = true, summary = null } = {}) {
  if (!typeId) return;
  const el = ensure();
  clearTimeout(P.leaveTimer);
  const wasOpen = !el.hidden;
  const same = wasOpen && P.id === typeId;
  P.id = typeId;
  P.pinned = pinned || (same && P.pinned);
  el.classList.toggle('pinned', P.pinned);
  el.querySelector('[data-ip-pin]').setAttribute('aria-pressed', String(P.pinned));
  if (!same) fillHead(typeId, summary);
  else if (summary) fillSummary(summary);
  el.hidden = false;
  if (!wasOpen || !P.pinned || !same) place(anchor, wasOpen && P.pinned);
  if (!same) mountContent(typeId);
}

export function closeItemPop() { close(); }

function close() {
  clearTimeout(P.leaveTimer);
  if (!P.el || P.el.hidden) return;
  P.el.hidden = true;
  P.pinned = false;
  P.el.classList.remove('pinned');
  P.el.querySelector('[data-ip-pin]').setAttribute('aria-pressed', 'false');
  P.hoverId = 0;
  P.panel?.destroy?.();
  P.panel = null;
  P.id = 0;
}

function pin() {
  if (P.pinned) return;
  P.pinned = true;
  P.el.classList.add('pinned');
  P.el.querySelector('[data-ip-pin]').setAttribute('aria-pressed', 'true');
}

const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z"/><path d="M8 2h8"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function ensure() {
  if (P.el) return P.el;
  const el = document.createElement('div');
  el.className = 'ip-pop';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '物品行情');
  el.innerHTML = `<div class="ip-head" data-ip-drag>
      <img class="ip-icon" alt="" width="40" height="40">
      <div class="ip-title"><b data-ip-name></b><span class="text-muted"><span data-ip-path></span><button type="button" class="ip-id" data-ip-copyid title="复制 Type ID"></button></span></div>
      <button type="button" class="ip-btn" data-ip-copy title="复制名称" aria-label="复制名称">${ICON_COPY}</button>
      <button type="button" class="ip-btn" data-ip-pin title="固定窗口（固定后可拖动标题栏）" aria-label="固定窗口" aria-pressed="false">${ICON_PIN}</button>
      <button type="button" class="ip-btn" data-ip-close title="关闭（Esc）" aria-label="关闭">${ICON_X}</button>
    </div>
    <div class="ip-summary" data-ip-summary hidden></div>
    <div class="ip-body" data-ip-body></div>
    <div class="ip-foot"><span class="text-muted">市场中心可看完整订单和多星域行情</span><button type="button" class="btn btn-primary btn-sm" data-ip-go>在市场中心查看</button></div>`;
  document.body.appendChild(el);
  P.el = el;
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-ip-close],[data-ip-pin]')) pin();
    const h = e.target.closest('[data-ip-drag]');
    if (h && !e.target.closest('button') && !MOBILE.matches && e.button === 0) startDrag(e);
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ip-close]')) { close(); return; }
    if (e.target.closest('[data-ip-pin]')) {
      P.pinned = !P.pinned;
      el.classList.toggle('pinned', P.pinned);
      e.target.closest('[data-ip-pin]').setAttribute('aria-pressed', String(P.pinned));
      return;
    }
    if (e.target.closest('[data-ip-copy]')) { ctx.copyText(ctx.typeName(P.id), '已复制名称'); return; }
    if (e.target.closest('[data-ip-copyid]')) { ctx.copyText(P.id, '已复制 Type ID'); return; }
    if (e.target.closest('[data-ip-go]')) { const id = P.id; close(); ctx.openItem(id); }
  });
  window.addEventListener('resize', () => { if (!el.hidden) clampInView(); });
  return el;
}

function fillHead(id, summary) {
  const el = P.el;
  const icon = el.querySelector('.ip-icon');
  icon.src = ctx.iconUrl(id, 64);
  el.querySelector('[data-ip-name]').textContent = ctx.typeName(id);
  el.querySelector('[data-ip-path]').textContent = (ctx.groupPath(id) || []).join(' › ') + ((ctx.groupPath(id) || []).length ? ' · ' : '');
  el.querySelector('[data-ip-copyid]').textContent = `Type ${id}`;
  fillSummary(summary);
}

function fillSummary(summary) {
  const box = P.el.querySelector('[data-ip-summary]');
  box.hidden = !summary?.length;
  box.innerHTML = (summary || []).map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c || ''}">${esc(String(v))}</b></div>`).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function mountContent(id) {
  const body = P.el.querySelector('[data-ip-body]');
  P.panel?.destroy?.();
  P.panel = null;
  body.innerHTML = '<div class="pi-loading">加载中…</div>';
  try {
    const m = await ctx.loadPanel();
    if (P.id !== id || P.el.hidden) return;
    P.panel = m.mountItemPanel(body, id);
  } catch (e) {
    if (P.id === id) body.innerHTML = `<p class="text-muted">加载失败：${esc(e.message)}</p>`;
  }
}

// 预览：贴在图标旁边（右侧放不下放左侧）；点击行打开（没有图标）时居中
function place(anchor, keep) {
  const el = P.el;
  if (MOBILE.matches) { el.style.left = el.style.top = ''; return; }
  if (keep) { clampInView(); return; }
  const w = Math.min(W, innerWidth - 16), h = Math.min(H, innerHeight - 16);
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
  el.style.top = Math.round(y) + 'px';
}

function clampInView() {
  const el = P.el;
  if (MOBILE.matches) return;
  const r = el.getBoundingClientRect();
  el.style.left = Math.round(Math.min(Math.max(8, r.left), innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.round(Math.min(Math.max(8, r.top), innerHeight - Math.min(r.height, innerHeight - 16) - 8)) + 'px';
}

function startDrag(e) {
  const el = P.el;
  const r = el.getBoundingClientRect();
  P.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  el.classList.add('dragging');
  const move = (ev) => {
    el.style.left = Math.round(Math.min(Math.max(8 - r.width + 80, ev.clientX - P.drag.dx), innerWidth - 80)) + 'px';
    el.style.top = Math.round(Math.min(Math.max(0, ev.clientY - P.drag.dy), innerHeight - 40)) + 'px';
  };
  const up = () => {
    el.classList.remove('dragging');
    P.drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
}
