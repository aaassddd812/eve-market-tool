// 工单：右上角「定制」弹窗里的「提交工单 / 我的工单 / 工单管理」。
// 提交后服务器返回 id + 查看凭证，存在本浏览器（eve-feedback-tickets），凭它查看处理状态、站长回复，并可追加说明；
// 有新的站长回复时「定制」按钮和「我的工单」上出现红点。「工单管理」只在服务器 EVE_FEEDBACK_ADMIN_IPS 里的 IP 访问时出现，
// 可查看全部工单、回复、改状态。
const TICKETS_KEY = 'eve-feedback-tickets';
const SEEN_KEY = 'eve-feedback-seen';
const KINDS = [['bug', '功能出错'], ['data', '数据不对'], ['feature', '新功能建议'], ['custom', '定制需求'], ['other', '其他']];
const KIND_TIPS = { bug: '报错、按钮没反应、页面打不开', data: '价格、击杀、计算结果有误', feature: '想要的功能或改进', custom: '军团 / 联盟专属工具、私有部署', other: '其他问题或想说的话' };
const KIND_ICONS = {
  bug: '<path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6 13H2M22 13h-4M6 9.5 3 8M18 9.5 21 8M6 17l-3 1.5M18 17l3 1.5"/>',
  data: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  feature: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z"/>',
  custom: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>'
};
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const STATUS = { open: '待处理', doing: '处理中', done: '已处理' };
const KIND_NAME = Object.fromEntries(KINDS);

let ctx = null;
const S = { isAdmin: false, tab: 'contact', kind: 'bug', draft: '', contact: '', mine: null, loading: false, admin: null, adminFilter: 'open', adminError: '' };

const EN = () => window.I18N?.lang === 'en';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ } };
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
function fmt(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path, body) {
  const res = await fetch('/api/kb/feedback' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'HTTP ' + res.status); e.status = res.status; throw e; }
  return data;
}

// 站长回复里比上次看过更新的条数
const lastAdmin = (t) => Math.max(0, ...t.replies.filter((r) => r.admin).map((r) => r.created));
function unread(items) {
  const seen = read(SEEN_KEY, {});
  return items.filter((t) => lastAdmin(t) > (seen[t.id] || 0)).length;
}
function markSeen() {
  const seen = read(SEEN_KEY, {});
  for (const t of S.mine || []) seen[t.id] = lastAdmin(t);
  write(SEEN_KEY, seen);
  syncDot();
}
function syncDot() {
  const n = S.mine ? unread(S.mine) : 0;
  $('contactBtn')?.classList.toggle('has-dot', n > 0);
  const tab = document.querySelector('[data-fb-tab=mine]');
  if (tab) tab.dataset.count = n || '';
}

async function loadMine() {
  const tickets = read(TICKETS_KEY, []);
  if (!tickets.length) { S.mine = []; return; }
  S.loading = true;
  try {
    S.mine = (await api('/mine', { tickets: tickets.slice(-50) })).items;
  } finally {
    S.loading = false;
    syncDot();
  }
}

// ---------- 渲染 ----------
function tabsHtml() {
  const tabs = [['contact', '联系作者'], ['new', '提交工单'], ['mine', '我的工单']];
  if (S.isAdmin) tabs.push(['admin', '工单管理']);
  return tabs.map(([k, l]) => `<button type="button" role="tab" data-fb-tab="${k}"${S.tab === k ? ' class="active" aria-selected="true"' : ''}>${l}</button>`).join('');
}
function formHtml() {
  const { esc } = ctx;
  const ph = EN() ? 'Describe the problem or idea: which page, what you did, what you expected (max 2000 characters)' : '描述问题或想法：在哪个页面、做了什么、期望是什么（最多 2000 字）';
  return `<form class="fb-pane fb-form" data-fb-form novalidate>
    <div class="fb-field"><span class="fb-label">问题类型</span>
      <div class="fb-kind-grid" role="radiogroup" aria-label="问题类型">${KINDS.map(([k, l]) => `<button type="button" role="radio" aria-checked="${S.kind === k}" data-fb-kind="${k}"${S.kind === k ? ' class="active"' : ''}>
        ${svg(KIND_ICONS[k])}<span><b>${l}</b><small>${KIND_TIPS[k]}</small></span></button>`).join('')}</div></div>
    <label class="fb-field"><span class="fb-label">详细描述<em class="fb-count" data-fb-count>${S.draft.length} / 2000</em></span>
      <textarea class="pi-input" name="text" rows="6" maxlength="2000" placeholder="${ph}">${esc(S.draft)}</textarea></label>
    <label class="fb-field"><span class="fb-label">联系方式<small>选填</small></span>
      <input class="pi-input" name="contact" maxlength="100" value="${esc(S.contact)}" placeholder="QQ / 邮箱 / 游戏角色名，方便回复你"></label>
    <div class="fb-foot"><small class="text-muted">会附上当前页面地址。处理进度和回复在「我的工单」里查看。</small><button type="submit" class="btn btn-primary">提交工单</button></div>
  </form>`;
}
function threadHtml(t, me) {
  const { esc } = ctx;
  return `${t.replies.map((r) => `<div class="fb-msg${r.admin ? ' admin' : ''}"><small><span>${r.admin ? '站长回复' : me}</span> · ${fmt(r.created)}</small><p class="notranslate">${esc(r.text)}</p></div>`).join('')}`;
}
function ticketHead(t, fresh = false) {
  return `<div class="fb-ticket-head"><b>#${t.id}</b><span class="fb-kind">${KIND_NAME[t.kind] || t.kind}</span><span class="fb-status ${t.status}">${STATUS[t.status] || t.status}</span>${fresh ? '<span class="fb-new">新回复</span>' : ''}
    <small class="text-muted">${fmt(t.created)}</small></div>`;
}
function mineHtml() {
  const { esc } = ctx;
  let body;
  if (S.mine === null) body = '<p class="fb-empty text-muted">正在加载…</p>';
  else if (!S.mine.length) body = '<p class="fb-empty text-muted">这个浏览器还没有提交过工单</p>';
  else {
    const seen = read(SEEN_KEY, {});
    body = S.mine.map((t) => { const fresh = lastAdmin(t) > (seen[t.id] || 0); return `<div class="fb-ticket${fresh ? ' new' : ''}">${ticketHead(t, fresh)}
      <p class="fb-text notranslate">${esc(t.text)}</p>${threadHtml(t, '我')}
      <form class="fb-reply" data-fb-follow="${t.id}"><input class="pi-input" name="text" maxlength="2000" placeholder="追加说明…"><button type="submit" class="btn btn-ghost btn-sm">发送</button></form>
    </div>`; }).join('');
  }
  return `<div class="fb-pane">${body}<p class="fb-foot-note text-muted">工单记录保存在这个浏览器里，换浏览器或清除网站数据后看不到。</p></div>`;
}
function adminHtml() {
  const { esc } = ctx;
  const filters = [['open', '待处理'], ['doing', '处理中'], ['done', '已处理'], ['', '全部']];
  let list;
  if (S.adminError) list = `<p class="fb-err">${esc(S.adminError)}</p>`;
  else if (S.admin === null) list = '<p class="fb-empty text-muted">正在加载…</p>';
  else if (!S.admin.length) list = '<p class="fb-empty text-muted">没有工单</p>';
  else {
    list = S.admin.map((t) => `<div class="fb-ticket">${ticketHead(t)}
      <div class="fb-meta text-muted">${t.contact ? `<span><span>联系方式：</span><b class="notranslate">${esc(t.contact)}</b></span>` : ''}${t.page ? `<span class="notranslate">${esc(t.page)}</span>` : ''}<span>${esc(t.server || '-')} / ${t.lang === 'en' ? 'EN' : '中文'}</span></div>
      <p class="fb-text notranslate">${esc(t.text)}</p>${threadHtml(t, '提交者')}
      <form class="fb-reply admin" data-fb-admin="${t.id}"><textarea class="pi-input" name="text" rows="2" maxlength="2000" placeholder="回复提交者…"></textarea>
        <div class="fb-reply-actions"><button type="submit" class="btn btn-ghost btn-sm" data-fb-st="doing">回复</button><button type="submit" class="btn btn-primary btn-sm" data-fb-st="done">回复并标为已处理</button>
        <span class="toolbar-spacer"></span>${t.status === 'done' ? '<button type="button" class="btn btn-ghost btn-sm" data-fb-set="open">重新打开</button>' : '<button type="button" class="btn btn-ghost btn-sm" data-fb-set="done">标为已处理</button>'}</div></form>
    </div>`).join('');
  }
  return `<div class="fb-pane"><div class="fb-kinds">${filters.map(([k, l]) => `<button type="button" data-fb-filter="${k}"${S.adminFilter === k ? ' class="active"' : ''}>${l}</button>`).join('')}</div>${list}</div>`;
}
function render() {
  const box = $('feedbackBox');
  if (!box) return;
  $('feedbackTabs').innerHTML = tabsHtml();
  const contact = S.tab === 'contact';
  $('contactInfo').hidden = !contact;
  box.hidden = contact;
  box.innerHTML = contact ? '' : S.tab === 'mine' ? mineHtml() : S.tab === 'admin' ? adminHtml() : formHtml();
  syncDot();
}

async function loadAdmin() {
  S.admin = null; S.adminError = '';
  render();
  try {
    S.admin = (await api('/admin/list', S.adminFilter ? { status: S.adminFilter } : {})).items;
  } catch (error) {
    S.adminError = error.message;
  }
  if (S.tab === 'admin') render();
}

function switchTab(tab) {
  S.tab = tab;
  render();
  if (tab === 'mine') {
    loadMine().then(() => { if (S.tab === 'mine') { render(); markSeen(); } })
      .catch((error) => { S.mine = S.mine || []; ctx.showToast('加载工单失败：' + error.message, 'error'); if (S.tab === 'mine') render(); });
  }
  if (tab === 'admin') loadAdmin();
}

// ---------- 事件 ----------
async function submit(form) {
  const text = form.text.value.trim();
  if (text.length < 4) { ctx.showToast('请先写下要反馈的内容', 'info'); form.text.focus(); return; }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = '正在提交…';
  try {
    const r = await api('', { kind: S.kind, text, contact: form.contact.value.trim(), page: location.pathname + location.hash, server: ctx.server, lang: EN() ? 'en' : 'zh' });
    const tickets = read(TICKETS_KEY, []);
    tickets.push({ id: r.id, token: r.token });
    write(TICKETS_KEY, tickets.slice(-50));
    S.draft = '';
    ctx.showToast(`工单已提交（#${r.id}），感谢反馈`, 'success');
    switchTab('mine');
  } catch (error) {
    ctx.showToast('提交失败：' + error.message, 'error');
    btn.disabled = false; btn.textContent = '提交';
  }
}
async function follow(form) {
  const id = Number(form.dataset.fbFollow);
  const text = form.text.value.trim();
  if (!text) return;
  const t = read(TICKETS_KEY, []).find((x) => x.id === id);
  if (!t) return;
  form.querySelector('button').disabled = true;
  try {
    await api('/follow', { id, token: t.token, text });
    await loadMine();
    render(); markSeen();
  } catch (error) {
    ctx.showToast('发送失败：' + error.message, 'error');
    form.querySelector('button').disabled = false;
  }
}
async function adminAct(id, body, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(body.text !== undefined ? '/admin/reply' : '/admin/status', { id, ...body });
    ctx.showToast(`工单 #${id} 已更新`, 'success');
    loadAdmin();
  } catch (error) {
    ctx.showToast('操作失败：' + error.message, 'error');
    if (btn) btn.disabled = false;
  }
}

function onClick(e) {
  const tab = e.target.closest('[data-fb-tab]');
  if (tab) { if (tab.dataset.fbTab !== 'admin' || S.isAdmin) switchTab(tab.dataset.fbTab); return; }
  const kind = e.target.closest('[data-fb-kind]');
  if (kind) {
    S.kind = kind.dataset.fbKind;
    kind.parentElement.querySelectorAll('[data-fb-kind]').forEach((x) => { x.classList.toggle('active', x === kind); x.setAttribute('aria-checked', String(x === kind)); });
    return;
  }
  const filter = e.target.closest('[data-fb-filter]');
  if (filter) { S.adminFilter = filter.dataset.fbFilter; loadAdmin(); return; }
  const set = e.target.closest('[data-fb-set]');
  if (set) adminAct(Number(set.closest('[data-fb-admin]').dataset.fbAdmin), { status: set.dataset.fbSet }, set);
}
function onSubmit(e) {
  const form = e.target;
  e.preventDefault();
  if (form.matches('[data-fb-form]')) submit(form);
  else if (form.matches('[data-fb-follow]')) follow(form);
  else if (form.matches('[data-fb-admin]')) {
    const btn = e.submitter;
    const text = form.text.value.trim();
    const status = btn?.dataset.fbSt || 'doing';
    if (!text && status !== 'done') { form.text.focus(); return; }
    adminAct(Number(form.dataset.fbAdmin), { text, status }, btn);
  }
}
function onInput(e) {
  const form = e.target.closest('[data-fb-form]');
  if (!form) return;
  if (e.target.name === 'text') { S.draft = e.target.value; form.querySelector('[data-fb-count]').textContent = `${S.draft.length} / 2000`; }
  if (e.target.name === 'contact') S.contact = e.target.value;
}

export function initFeedback(context) {
  ctx = context;
  const box = $('feedbackBox');
  box.addEventListener('click', onClick);
  box.addEventListener('submit', onSubmit);
  box.addEventListener('input', onInput);
  $('feedbackTabs').addEventListener('click', onClick);
  render();
  // 只有站长 IP 会得到 200：显示「工单管理」
  fetch('/api/kb/feedback/admin/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => { if (r.ok) { S.isAdmin = true; render(); } }).catch(() => {});
  // 有提交过的工单：打开页面时查一次有没有新回复
  if (read(TICKETS_KEY, []).length) setTimeout(() => loadMine().catch(() => {}), 3000);
}
// 报错 / 加载慢引导：切到「提交工单」并预填类型和内容
export function prefill(kind, text) {
  S.tab = 'new';
  if (KIND_NAME[kind]) S.kind = kind;
  S.draft = text;
  render();
  const ta = $('feedbackBox')?.querySelector('textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }
}
// 打开「定制」弹窗时调用：有未读回复就直接显示「我的工单」
export function onOpen() {
  if (S.mine && unread(S.mine) > 0 && S.tab !== 'admin') switchTab('mine');
  else if (S.tab === 'mine') switchTab('mine');
  else render();
}
