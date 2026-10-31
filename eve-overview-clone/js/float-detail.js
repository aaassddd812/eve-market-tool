// ===== 悬浮窗里的详情（float-detail.html）=====
// ?kind=item|kill&id=…：物品详情（同装配页的物品详情）/ 击杀详情。只负责显示：经 BroadcastChannel（eve-float）向主页面要内容（detail-req），
// 主页面生成整页 HTML 回过来（float-feed.js → typeDetail / killDetail）。
// 桌面版是点了才开的无边框置顶窗口（float_detail 命令，标签 float-detail），✕ 关掉就关了；网页画中画里是叠在悬浮窗上的 iframe（关闭时通知外层悬浮窗）。
// 详情里点别的物品在本窗口换内容（可返回）；市场价格、人物 / 军团链接、去装配页等需要整页的操作交给主窗口。

const q = new URLSearchParams(location.search);
const EMBED = window.parent !== window;
const ipc = !EMBED && window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__ : null;
const invoke = (cmd, args) => ipc?.invoke(cmd, args).catch(() => {});
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = new Set(['item', 'kill']);

const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eve-float') : null;
const post = (m) => { try { bc?.postMessage(m); } catch { /* 忽略 */ } };
let cur = null;          // { kind, id, opt }
const back = [];         // 之前看过的
let rid = '', timer = 0;

// push：从详情里点进来的（可返回）；否则是新打开的，清空返回记录
function show(kind, id, opt = {}, push = false) {
  if (!KINDS.has(kind) || !(id > 0)) return;
  if (push && cur && !(cur.kind === kind && cur.id === id)) back.push(cur);
  if (!push) back.length = 0;
  load(kind, id, opt);
}
function load(kind, id, opt = {}) {
  cur = { kind, id, opt };
  $('fdBody').innerHTML = '<p class="fd-msg">读取中…</p>';
  $('fdBack').hidden = !back.length;
  rid = Math.random().toString(36).slice(2);
  post({ t: 'detail-req', rid, kind, id, opt });
  clearTimeout(timer);
  timer = setTimeout(() => { $('fdBody').innerHTML = '<p class="fd-msg">主窗口没有响应：先打开网站</p>'; }, 20e3);
}
if (bc) {
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (m.t !== 'detail' || m.rid !== rid) return;
    clearTimeout(timer);
    if (m.error) { $('fdBody').innerHTML = `<p class="fd-msg">读取失败：${esc(m.error)}</p>`; return; }
    $('fdTitle').textContent = m.title || '详情';
    document.title = (m.title || '详情') + ' · EVE';
    $('fdBody').innerHTML = m.html || '';
    $('fdBody').scrollTop = 0;
  };
}

// 交给主窗口：桌面版把主窗口切到前面
function toMain(m) {
  post(m);
  if (ipc) invoke('float_focus_main');
  else if (EMBED) window.parent.postMessage({ t: 'focus-main' }, location.origin);
}
function close() {
  if (EMBED) window.parent.postMessage({ t: 'detail-close' }, location.origin);
  else if (ipc) invoke('float_close');
  else window.close();
}

document.addEventListener('click', (e) => {
  const el = (s) => e.target.closest(s);
  let x;
  if (el('[data-fd-close]')) { close(); return; }
  if (el('[data-fd-back]')) { const p = back.pop(); if (p) load(p.kind, p.id, p.opt); return; }
  if (el('[data-fd-main]')) { if (cur) toMain({ t: cur.kind === 'kill' ? 'open-kill' : 'open-item', id: cur.id }); return; }
  // 物品详情：标签页、点别的物品
  if ((x = el('[data-fi-tab]'))) { document.querySelectorAll('[data-fi-tab], [data-fi-pane]').forEach((n) => n.classList.toggle('active', (n.dataset.fiTab || n.dataset.fiPane) === x.dataset.fiTab)); return; }
  if ((x = el('[data-fit-info]'))) { e.preventDefault(); show('item', Number(x.dataset.fitInfo), {}, true); return; }
  if ((x = el('[data-fi-market]'))) { toMain({ t: 'open-item', id: Number(x.dataset.fiMarket) }); return; }
  // 击杀详情：标签页、去装配页（主窗口打开这条击杀）
  if ((x = el('[data-kill-tab]'))) {
    document.querySelectorAll('[data-kill-tab]').forEach((b) => b.classList.toggle('active', b === x));
    document.querySelectorAll('.kb-pane').forEach((p) => { p.hidden = p.dataset.pane !== x.dataset.killTab; });
    return;
  }
  if (el('[data-kill-fit]')) { if (cur) toMain({ t: 'open-kill', id: cur.id }); return; }
  // 站内链接（人物 / 军团 / 联盟）在主窗口打开；外部链接用系统浏览器
  if ((x = el('a[href]'))) {
    const href = x.getAttribute('href');
    e.preventDefault();
    if (href.startsWith('#')) toMain({ t: 'open-hash', hash: href });
    else if (/^https?:/.test(href)) { if (ipc) ipc.invoke('plugin:opener|open_url', { url: href }).catch(() => window.open(href, '_blank', 'noopener')); else window.open(href, '_blank', 'noopener'); }
  }
});
// 击杀详情切换估值价格来源：主页面按新来源重算
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-val-src]') && cur?.kind === 'kill') load('kill', cur.id, { val: e.target.value });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

// 外层悬浮窗 / 桌面版换内容
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.t !== 'show') return;
  show(e.data.kind, Number(e.data.id));
});
window.__floatDetail = (kind, id) => show(kind, Number(id));

// 桌面版是无边框窗口：按住标题栏空白处拖动
if (ipc) {
  document.documentElement.classList.add('fd-native');
  document.querySelector('.fd-head').addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) invoke('float_drag');
  });
}
show(q.get('kind'), Number(q.get('id')));
