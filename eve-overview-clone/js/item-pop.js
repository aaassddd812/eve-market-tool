// ===== 单物品行情窗口：入口与窗口外壳 =====
// 入口：带 data-item-pop="typeId" 的物品图标（悬停预览、点击固定等行为见 float-pop.js）。
// 外壳负责标题栏（图标、名称、分类、Type ID、复制、跳转市场中心），内容由 item-panel.js 在第一次打开时才加载。

import { makeFloat, pinBtn, closeBtn } from './float-pop.js?v=3';

let ctx = null;   // typeName, groupPath, iconUrl, copyText, openItem, loadPanel
let float = null;
let panel = null;
let summary = null;

const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export function initItemPop(context) {
  ctx = context;
  float = makeFloat({
    attr: 'item-pop',
    className: 'ip-pop',
    label: '物品行情',
    html: `<div class="ip-head" data-float-drag>
        <img class="ip-icon" alt="" width="40" height="40">
        <div class="ip-title"><b data-ip-name></b><span class="text-muted"><span data-ip-path></span><button type="button" class="ip-id" data-ip-copyid title="复制 Type ID"></button></span></div>
        <button type="button" class="ip-btn" data-ip-copy title="复制名称" aria-label="复制名称">${ICON_COPY}</button>
        ${pinBtn()}${closeBtn()}
      </div>
      <div class="ip-summary" data-ip-summary hidden></div>
      <div class="ip-body" data-ip-body></div>
      <div class="ip-foot"><span class="text-muted">市场中心可看完整订单和多星域行情</span><button type="button" class="btn btn-primary btn-sm" data-ip-go>在市场中心查看</button></div>`,
    onOpen: (id) => { fillHead(id); mountContent(id); },
    onClose: () => { panel?.destroy?.(); panel = null; }
  });
  float.el.addEventListener('click', (e) => {
    const id = float.id;
    if (e.target.closest('[data-ip-copy]')) { ctx.copyText(ctx.typeName(id), '已复制名称'); return; }
    if (e.target.closest('[data-ip-copyid]')) { ctx.copyText(id, '已复制 Type ID'); return; }
    if (e.target.closest('[data-ip-go]')) { float.close(); ctx.openItem(id); }
  });
}

// summary：可选的 [[标签, 值, class]]，显示在标题栏下（例如倒卖排行这一行的路线与利润）
export function openItemPop(typeId, { anchor = null, pinned = true, summary: s = null } = {}) {
  summary = s;
  const same = float.open_ && float.id === typeId;
  float.open(typeId, { anchor, pinned });
  if (same) fillSummary();
}

export function closeItemPop() { float.close(); }

function fillHead(id) {
  const el = float.el;
  el.querySelector('.ip-icon').src = ctx.iconUrl(id, 64);
  el.querySelector('[data-ip-name]').textContent = ctx.typeName(id);
  const path = ctx.groupPath(id) || [];
  el.querySelector('[data-ip-path]').textContent = path.join(' › ') + (path.length ? ' · ' : '');
  el.querySelector('[data-ip-copyid]').textContent = `Type ${id}`;
  fillSummary();
  summary = null;   // 悬停图标打开的不带上一次点行的摘要
}

function fillSummary() {
  const box = float.el.querySelector('[data-ip-summary]');
  box.hidden = !summary?.length;
  box.innerHTML = (summary || []).map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c || ''}">${esc(String(v))}</b></div>`).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function mountContent(id) {
  const body = float.el.querySelector('[data-ip-body]');
  panel?.destroy?.();
  panel = null;
  body.innerHTML = '<div class="pi-loading">加载中…</div>';
  try {
    const m = await ctx.loadPanel();
    if (float.id !== id || !float.open_) return;
    panel = m.mountItemPanel(body, id);
  } catch (e) {
    if (float.id === id) body.innerHTML = `<p class="text-muted">加载失败：${esc(e.message)}</p>`;
  }
}
