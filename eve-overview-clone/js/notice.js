// 站点公告：站长在右上角「联系 → 公告管理」里发布，发给全部服务器或指定的服；访客打开网站时读一次 /api/kb/notice?server=，
// 没看过的弹窗提示，「联系 → 公告」里可以再看。浏览器按「id:rev」记看过的（eve-notice-seen）；站长修改时勾「重新弹给所有人」，rev 加一，再弹一次。
// 页面开着时每 5 分钟（切回页面时）再查一次，新发布的同样弹窗。界面框架（标签页、事件委托）在 feedback.js。
const SEEN_KEY = 'eve-notice-seen';
const POLL_MS = 5 * 60e3;
const POP_MAX = 5;
const TITLE_MAX = 60, TEXT_MAX = 2000;

let ctx = null;   // { esc, showToast, server, servers: [{ id, name }], cred() 云同步登录凭据, rerender }
const S = { items: null, loaded: 0, admin: null, adminError: '', now: 0, edit: null, draft: null, busy: false };

const EN = () => window.I18N?.lang === 'en';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式等 */ } };
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = (sec) => { const d = new Date(sec * 1000); return `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// datetime-local 输入框的值（本地时间）⇄ Unix 秒
const toLocal = (sec) => { if (!sec) return ''; const d = new Date(sec * 1000); return `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocal = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const key = (n) => `${n.id}:${n.rev}`;
const blank = () => ({ title: '', body: '', title_en: '', body_en: '', servers: [], until: '', repop: false });

// 英文界面优先显示英文版（没写英文标题就整条用中文）
function pick(n) {
  if (EN() && n.title_en) return { title: n.title_en, body: n.body_en || n.body };
  return { title: n.title, body: n.body };
}
// 正文：转义后把网址变成链接（只认 ASCII 网址，句末标点不算进去）
function textHtml(s) {
  return ctx.esc(s).replace(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g, (u) => {
    const m = /[.,;:!?]+$/.exec(u);
    const tail = m ? m[0] : '';
    const url = tail ? u.slice(0, -tail.length) : u;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  });
}
const serverName = (id) => ctx.servers.find((s) => s.id === id)?.name || id;
const serversHtml = (n) => (n.servers.length ? n.servers.map((id) => `<span>${ctx.esc(serverName(id))}</span>`).join(' · ') : '<span>全部服务器</span>');

function cardHtml(n) {
  const { title, body } = pick(n);
  const edited = n.updated - n.created > 60 ? ` · <span>修改于</span> ${fmt(n.updated)}` : '';
  return `<article class="notice-card">
    <h4 class="notranslate">${ctx.esc(title)}</h4>
    <div class="notice-meta"><span>${fmt(n.created)}</span>${edited}</div>
    ${body ? `<div class="notice-text notranslate">${textHtml(body)}</div>` : ''}
  </article>`;
}

// ---------- 弹窗 ----------
let popKeys = null;   // 正在弹出的公告（关掉时记为看过）；预览时为 null
function closePopup() {
  const m = document.getElementById('noticeModal');
  if (!m || m.hidden) return;
  m.hidden = true;
  if (popKeys) write(SEEN_KEY, [...new Set([...read(SEEN_KEY, []), ...popKeys])].slice(-200));
  popKeys = null;
}
function popup(list, preview = false) {
  let m = document.getElementById('noticeModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal notice-modal';
    m.id = 'noticeModal';
    m.hidden = true;
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'noticeTitle');
    m.addEventListener('click', (e) => { if (e.target.closest('.modal-backdrop, [data-notice-close]')) closePopup(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
    document.body.appendChild(m);
  }
  popKeys = preview ? null : list.map(key);
  m.innerHTML = `<div class="modal-backdrop"></div>
    <div class="modal-content notice-content">
      <div class="modal-header"><h3 id="noticeTitle">${preview ? '公告预览' : '站点公告'}</h3>
        <button class="modal-close" data-notice-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body notice-body">${list.slice(0, POP_MAX).map(cardHtml).join('')}
        ${list.length > POP_MAX ? `<p class="notice-more text-muted">还有 ${list.length - POP_MAX} 条较早的公告</p>` : ''}</div>
      <div class="notice-foot"><small class="text-muted">${preview ? '这是预览，别人还看不到' : '以后可以在「联系」→「公告」里再看'}</small>
        <button type="button" class="btn btn-primary" data-notice-close>${preview ? '关闭预览' : '知道了'}</button></div>
    </div>`;
  m.hidden = false;
  m.querySelector('.notice-foot .btn')?.focus();
}

// ---------- 读取 ----------
async function load(pop = true) {
  let items;
  try {
    const r = await fetch('/api/kb/notice?server=' + encodeURIComponent(ctx.server));
    if (!r.ok) return;
    items = (await r.json()).items || [];
  } catch { return; }
  S.items = items;
  S.loaded = Date.now();
  ctx.rerender('notice');
  if (!pop) return;
  const open = document.getElementById('noticeModal');
  if (open && !open.hidden) return;   // 正在显示（或站长在预览）：下次再弹
  const seen = new Set(read(SEEN_KEY, []));
  const fresh = items.filter((n) => !seen.has(key(n)));
  if (fresh.length) popup(fresh);
}
function poll() {
  if (document.hidden || Date.now() - S.loaded < 60e3) return;
  load();
}

// ---------- 站长：公告管理 ----------
async function adminApi(op, body) {
  const res = await fetch('/api/kb/notice/admin/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(ctx.cred?.() || {}), ...body }) });   // 站长也可以是云同步账号：带上登录凭据
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
export async function loadAdmin() {
  S.adminError = '';
  if (!S.draft) S.draft = blank();
  try {
    const d = await adminApi('list', {});
    S.admin = d.items;
    S.now = d.now;
  } catch (error) {
    S.adminError = error.message;
  }
  ctx.rerender('nadmin');
}
function stateOf(n) {
  if (n.off) return ['off', '已撤回'];
  if (n.until && n.until <= (S.now || Date.now() / 1000)) return ['off', '已过期'];
  return ['on', '显示中'];
}
function adminItemHtml(n) {
  const [cls, label] = stateOf(n);
  const { esc } = ctx;
  return `<div class="notice-item${S.edit === n.id ? ' editing' : ''}">
    <div class="notice-item-head"><b>#${n.id}</b><span class="notice-state ${cls}">${label}</span><span class="notice-srv">${serversHtml(n)}</span>
      <small class="text-muted">${fmt(n.created)}</small></div>
    <b class="notice-item-title notranslate">${esc(n.title)}</b>
    ${n.body ? `<div class="notice-text notranslate">${textHtml(n.body)}</div>` : ''}
    ${n.title_en ? `<div class="notice-meta"><span>英文版：</span><span class="notranslate">${esc(n.title_en)}</span></div>` : ''}
    <div class="notice-meta">${n.updated - n.created > 60 ? `<span><span>修改于</span> ${fmt(n.updated)}</span>` : ''}${n.until ? `<span><span>截止</span> ${fmt(n.until)}</span>` : '<span>不设截止时间</span>'}${n.rev > 1 ? `<span>重新弹出过 ${n.rev - 1} 次</span>` : ''}</div>
    <div class="fb-reply-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-notice-edit="${n.id}">修改</button>
      <button type="button" class="btn btn-ghost btn-sm" data-notice-off="${n.id}" data-off="${n.off ? 0 : 1}">${n.off ? '恢复显示' : '撤回'}</button>
      <span class="toolbar-spacer"></span>
      <button type="button" class="btn btn-ghost btn-sm notice-del" data-notice-del="${n.id}">删除</button>
    </div>
  </div>`;
}
export function adminHtml() {
  const { esc } = ctx;
  const d = S.draft || (S.draft = blank());
  const editing = S.edit !== null;
  const all = !d.servers.length;
  const chips = `<button type="button" data-notice-srv=""${all ? ' class="active"' : ''} aria-pressed="${all}">全部服务器</button>` +
    ctx.servers.map((s) => { const on = d.servers.includes(s.id); return `<button type="button" data-notice-srv="${s.id}"${on ? ' class="active"' : ''} aria-pressed="${on}">${esc(s.name)}</button>`; }).join('');
  const form = `<form class="fb-pane fb-form notice-form" data-notice-form novalidate>
    ${editing ? `<p class="notice-editing"><span>正在修改</span> <b>#${S.edit}</b></p>` : ''}
    <div class="fb-field"><span class="fb-label">发给<small>可以多选；不选具体的服就是全部服务器</small></span><div class="fb-kinds">${chips}</div></div>
    <label class="fb-field"><span class="fb-label">标题<em class="fb-count" data-notice-count="title">${d.title.length} / ${TITLE_MAX}</em></span>
      <input class="pi-input" name="title" maxlength="${TITLE_MAX}" value="${esc(d.title)}" placeholder="一句话说清楚，例如：今晚 23:00 服务器维护"></label>
    <label class="fb-field"><span class="fb-label">内容<small>选填</small><em class="fb-count" data-notice-count="body">${d.body.length} / ${TEXT_MAX}</em></span>
      <textarea class="pi-input" name="body" rows="5" maxlength="${TEXT_MAX}" placeholder="可以换行；网址会自动变成链接">${esc(d.body)}</textarea></label>
    <label class="fb-field"><span class="fb-label">截止时间<small>选填，过了就不再显示，也不再弹出</small></span>
      <input class="pi-input notice-until" type="datetime-local" name="until" value="${esc(d.until)}"></label>
    <details class="notice-en"${d.title_en || d.body_en ? ' open' : ''}><summary>英文版<small>选填，英文界面显示；不写就显示中文</small></summary>
      <div class="notice-en-body">
        <input class="pi-input" name="title_en" maxlength="${TITLE_MAX}" value="${esc(d.title_en)}" placeholder="English title">
        <textarea class="pi-input" name="body_en" rows="4" maxlength="${TEXT_MAX}" placeholder="English text">${esc(d.body_en)}</textarea>
      </div></details>
    ${editing ? `<label class="notice-check"><input type="checkbox" name="repop"${d.repop ? ' checked' : ''}><span>重新弹给所有人（看过的人也会再弹一次）</span></label>` : ''}
    <div class="fb-foot notice-form-foot"><small class="text-muted">${editing ? '不勾「重新弹给所有人」的话，看过的人不会再弹出' : '发布后，打开网站的人马上会看到弹窗；页面开着的人 5 分钟内也会弹出'}</small>
      <button type="button" class="btn btn-ghost" data-notice-preview>预览</button>
      ${editing ? '<button type="button" class="btn btn-ghost" data-notice-cancel>取消修改</button>' : ''}
      <button type="submit" class="btn btn-primary"${S.busy ? ' disabled' : ''}>${editing ? '保存修改' : '发布公告'}</button></div>
  </form>`;
  let list;
  if (S.adminError) list = `<p class="fb-err">${esc(S.adminError)}</p>`;
  else if (S.admin === null) list = '<p class="fb-empty text-muted">正在加载…</p>';
  else if (!S.admin.length) list = '<p class="fb-empty text-muted">还没有发过公告</p>';
  else list = S.admin.map(adminItemHtml).join('');
  return `${form}<h4 class="notice-admin-title">发过的公告</h4><div class="fb-pane">${list}</div>`;
}
export function listHtml() {
  let body;
  if (S.items === null) body = '<p class="fb-empty text-muted">正在加载…</p>';
  else if (!S.items.length) body = '<p class="fb-empty text-muted">目前没有公告</p>';
  else body = S.items.map(cardHtml).join('');
  const srv = ctx.servers.find((s) => s.id === ctx.server)?.name || ctx.server;
  return `<div class="fb-pane">${body}<p class="fb-foot-note text-muted"><span>只显示发给当前服务器的公告：</span><b>${ctx.esc(srv)}</b></p></div>`;
}

function draftFrom(n) {
  return { title: n.title, body: n.body, title_en: n.title_en, body_en: n.body_en, servers: [...n.servers], until: toLocal(n.until), repop: false };
}
function payload() {
  const d = S.draft;
  const body = { title: d.title.trim(), body: d.body.trim(), title_en: d.title_en.trim(), body_en: d.body_en.trim(), servers: d.servers, until: fromLocal(d.until) };
  if (S.edit !== null) { body.id = S.edit; body.repop = d.repop; }
  return body;
}
async function save() {
  const body = payload();
  if (body.title.length < 2) { ctx.showToast('请先写标题', 'info'); document.querySelector('[data-notice-form] [name=title]')?.focus(); return; }
  if (body.until && body.until <= Date.now() / 1000) { ctx.showToast('截止时间应晚于现在', 'info'); return; }
  S.busy = true; ctx.rerender('nadmin');
  try {
    const r = await adminApi('save', body);
    // 自己发的不再弹给自己
    if (r.item) write(SEEN_KEY, [...new Set([...read(SEEN_KEY, []), key(r.item)])].slice(-200));
    ctx.showToast(S.edit !== null ? `公告 #${r.item.id} 已修改` : `公告已发布（#${r.item.id}）`, 'success');
    S.edit = null; S.draft = blank();
    load(false);
  } catch (error) {
    ctx.showToast('保存失败：' + error.message, 'error');
  }
  S.busy = false;
  loadAdmin();
}
async function act(op, id, body, done) {
  try {
    await adminApi(op, { id, ...body });
    ctx.showToast(done, 'success');
    if (op === 'delete' && S.edit === id) { S.edit = null; S.draft = blank(); }
    load(false);
  } catch (error) {
    ctx.showToast('操作失败：' + error.message, 'error');
  }
  loadAdmin();
}

// ---------- 事件（feedback.js 的弹窗里委托过来；处理了返回 true）----------
export function onClick(e) {
  const srv = e.target.closest('[data-notice-srv]');
  if (srv) {
    const id = srv.dataset.noticeSrv, d = S.draft;
    if (!id) d.servers = [];
    else d.servers = d.servers.includes(id) ? d.servers.filter((x) => x !== id) : [...d.servers, id];
    if (d.servers.length === ctx.servers.length) d.servers = [];   // 全选 = 全部服务器
    ctx.rerender('nadmin');
    return true;
  }
  if (e.target.closest('[data-notice-preview]')) {
    const b = payload();
    if (!b.title) { ctx.showToast('请先写标题', 'info'); return true; }
    const now = Math.floor(Date.now() / 1000);
    popup([{ id: 0, rev: 0, ...b, servers: b.servers, created: now, updated: now }], true);
    return true;
  }
  if (e.target.closest('[data-notice-cancel]')) { S.edit = null; S.draft = blank(); ctx.rerender('nadmin'); return true; }
  const edit = e.target.closest('[data-notice-edit]');
  if (edit) {
    const n = S.admin?.find((x) => x.id === Number(edit.dataset.noticeEdit));
    if (n) { S.edit = n.id; S.draft = draftFrom(n); ctx.rerender('nadmin'); document.querySelector('[data-notice-form]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    return true;
  }
  const off = e.target.closest('[data-notice-off]');
  if (off) {
    const id = Number(off.dataset.noticeOff), hide = off.dataset.off === '1';
    off.disabled = true;
    act('off', id, { off: hide }, hide ? `公告 #${id} 已撤回` : `公告 #${id} 已恢复显示`);
    return true;
  }
  const del = e.target.closest('[data-notice-del]');
  if (del) {
    const id = Number(del.dataset.noticeDel);
    if (confirm(`删除公告 #${id}？删除后不能恢复（只想先不显示的话用「撤回」）`)) { del.disabled = true; act('delete', id, {}, `公告 #${id} 已删除`); }
    return true;
  }
  return false;
}
export function onSubmit(e) {
  if (!e.target.matches('[data-notice-form]')) return false;
  e.preventDefault();
  if (!S.busy) save();
  return true;
}
export function onInput(e) {
  const form = e.target.closest('[data-notice-form]');
  if (!form) return false;
  const { name } = e.target;
  if (name === 'repop') S.draft.repop = e.target.checked;
  else if (name in S.draft) S.draft[name] = e.target.value;
  const count = form.querySelector(`[data-notice-count="${name}"]`);
  if (count) count.textContent = `${e.target.value.length} / ${name === 'title' ? TITLE_MAX : TEXT_MAX}`;
  return true;
}

export function initNotice(context) {
  ctx = context;
  // 首页先显示出来再读；之后定时查、切回页面时查
  setTimeout(() => load(), 1500);
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
export const refresh = () => load(false);
