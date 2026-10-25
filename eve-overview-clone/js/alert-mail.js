// ===== 预警邮件（击杀预警、本地日志共用）=====
// 「预警」弹窗的「邮件」标签页（alert-center.js）集中设置：收件人通讯录（自己 + 邮件列表、军团、联盟、其他角色，最多 10 个），
//   每个收件人勾选接收哪种预警，以及哪种预警发邮件；击杀预警、本地日志标签页里只打开「游戏内邮件」并勾选收件人。
//   读自己加入的邮件列表要 esi-mail.read_mail.v1；发给军团 / 联盟要有游戏里的群发权限，对方开了 CSPA 收费会发送失败。
// 发送：esi-mail.send_mail.v1；两种预警共用发信间隔（同一角色两封至少隔 60 秒，失败后再多等 1 分钟），各自把这段时间里的提醒合并成一封。
//   邮件语言跟随界面语言（英文界面发英文邮件），见 L()。
// 设置存在 eve-alert-mail-v1（按服务器）：{ book: [{ id, name, kind }], use: { kill: ['self', id…], intel: [...] } }；
//   旧格式 { self, to } 与旧版击杀预警里的 mailSelf / mailTo 加载时自动转换（原来的收件人两种预警都勾上，见 mergeLegacy）。

import { serverKey, esiUrl } from './server.js?v=s4';

let ctx;   // esc, showToast, esiAuthFetch, tokenInfo, hasScope
const KEY = serverKey('eve-alert-mail-v1');
export const MAIL_SCOPE = 'esi-mail.send_mail.v1';
const READ_MAIL_SCOPE = 'esi-mail.read_mail.v1';
const MAIL_GAP = 60e3;
const MAX = 10;
// 邮件正文语言：英文界面发英文
export const EN = window.I18N?.lang === 'en';
export const L = (zh, en) => (EN ? en : zh);
export const KIND_ZH = { character: '角色', corporation: '军团', alliance: '联盟', mailing_list: '邮件列表' };
const SRC = ['kill', 'intel'];
const M = { book: [], use: { kill: ['self'], intel: ['self'] } };   // book: [{ id, name, kind: character|corporation|alliance|mailing_list }]
const S = { lastMail: 0, lists: null, error: '' };
const subs = new Set();
const sources = new Map();   // kill / intel → { label, on(), set(on) }，由两个模块登记

export function initAlertMail(context) {
  if (ctx) return;
  ctx = context;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 忽略 */ }
  if (saved?.book) Object.assign(M, saved);
  else if (saved) convert(saved.self !== false, saved.to);
  if (!Array.isArray(M.book)) M.book = [];
  M.use = M.use || {};
  for (const s of SRC) if (!Array.isArray(M.use[s])) M.use[s] = ['self'];
  mergeLegacy();
}
// 旧格式：一份收件人两种预警共用 → 通讯录 + 两种预警都勾上
function convert(self, to) {
  M.book = Array.isArray(to) ? to.slice(0, MAX) : [];
  const keys = [...(self ? ['self'] : []), ...M.book.map((r) => String(r.id))];
  M.use = { kill: [...keys], intel: [...keys] };
}
// 旧版击杀预警自己存的收件人（eve-kill-alert-v1 的 mailSelf / mailTo）：直接从存储里读，不管哪个模块先初始化；
// 只做一次（legacyDone），之前因为本地日志先加载而没搬过来的，这里补进通讯录（两种预警都勾上）
function mergeLegacy() {
  if (M.legacyDone) return;
  let t = null;
  try { t = JSON.parse(localStorage.getItem(serverKey('eve-kill-alert-v1')) || 'null'); } catch { /* 忽略 */ }
  const add = (Array.isArray(t?.mailTo) ? t.mailTo : []).filter((r) => r?.id && r.kind && !M.book.some((b) => b.id === r.id)).slice(0, Math.max(0, MAX - M.book.length));
  for (const r of add) {
    M.book.push({ id: r.id, name: r.name, kind: r.kind });
    for (const s of SRC) if (!M.use[s].includes(String(r.id))) M.use[s].push(String(r.id));
  }
  if (t?.mailSelf === false && add.length) for (const s of SRC) M.use[s] = M.use[s].filter((k) => k !== 'self');
  M.legacyDone = true;
  save();
}
export function onMailChange(fn) { subs.add(fn); }
// 两个预警模块登记自己（「邮件」标签页里显示开关）
export function registerSource(src, def) { sources.set(src, def); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(M)); } catch { /* 忽略 */ } }
function update(patch) {
  Object.assign(M, patch);
  save();
  changed();
}
function changed() {
  subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  renderPanel();
}

export const canMail = () => Boolean(ctx?.tokenInfo()) && ctx.hasScope(MAIL_SCOPE);
// 离下一次可以发信还要等多久（毫秒，至少 3 秒，好把同时到的提醒合并）
export const nextSlot = () => Math.max(3e3, S.lastMail + MAIL_GAP - Date.now());
export const lastError = () => S.error;

// 某种预警勾选的收件人（test：两种预警勾过的都算）；都没勾时发给自己
const useOf = (src) => (src === 'test' ? [...new Set(SRC.flatMap((s) => M.use[s]))] : M.use[src] || []);
function recipients(token, src) {
  const use = useOf(src);
  const out = use.includes('self') ? [{ recipient_id: token.character_id, recipient_type: 'character' }] : [];
  for (const r of M.book) {
    if (!use.includes(String(r.id)) || (r.id === token.character_id && r.kind === 'character')) continue;
    out.push({ recipient_id: r.id, recipient_type: r.kind });
  }
  return out.length ? out : [{ recipient_id: token.character_id, recipient_type: 'character' }];
}
// 正文里怎么称呼预警的主人：只发给自己时是「你」，发给别人时用角色名
export function ownerWord(src) {
  const token = ctx.tokenInfo();
  if (!token) return L('你', 'you');
  return recipients(token, src).some((r) => r.recipient_id !== token.character_id) ? ctx.esc(token.character_name || '') : L('你', 'you');
}
// 收件人名字（标签页里一行摘要用）
export function recipientNames(src) {
  const use = useOf(src);
  const names = [...(use.includes('self') ? ['自己'] : []), ...M.book.filter((r) => use.includes(String(r.id))).map((r) => r.name)];
  return names.length ? names : ['自己'];
}

// 发一封：成功 true，失败 false（原因见 lastError），没绑定 / 没权限 null
export async function sendMail(src, subject, body) {
  const token = ctx.tokenInfo();
  if (!token || !ctx.hasScope(MAIL_SCOPE)) return null;
  S.lastMail = Date.now();
  try {
    await ctx.esiAuthFetch('/characters/' + token.character_id + '/mail/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: recipients(token, src), subject: subject.slice(0, 100), body, approved_cost: 0 })
    });
    S.error = '';
    return true;
  } catch (error) {
    console.warn('预警邮件发送失败', error);
    S.lastMail = Date.now() + 60e3;   // 失败（多为发信频率限制、没有群发权限、对方开了 CSPA 收费）时多等一会
    S.error = error.message;
    return false;
  }
}
// 测试邮件发完后的提示
export function testToast(ok) {
  if (ok) ctx.showToast('测试邮件已发送，请在游戏邮箱查看', 'success');
  else if (ok === false) ctx.showToast('测试邮件发送失败：' + (S.error || '未知错误') + '（发给军团 / 联盟要有群发权限，对方开了 CSPA 收费也会失败）', 'error', 6000);
  else ctx.showToast('授权里没有发送邮件权限（esi-mail.send_mail.v1），请重新绑定 ESI', 'error', 4000);
}

// ID 依次试角色 / 军团 / 联盟的公开资料；名字用 /universe/ids/ 精确匹配（游戏内完整名字，不区分大小写），同名时角色优先
export async function resolveEntity(text) {
  let hit = null;
  try {
    if (/^\d{6,12}$/.test(text)) {
      for (const [kind, path] of [['character', 'characters'], ['corporation', 'corporations'], ['alliance', 'alliances']]) {
        const res = await fetch(esiUrl(`/${path}/${text}/`));
        if (res.ok) { hit = { id: Number(text), name: (await res.json()).name, kind }; break; }
      }
    } else {
      const res = await fetch(esiUrl('/universe/ids/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([text]) });
      const d = res.ok ? await res.json() : {};
      const pick = d.characters?.[0] ? ['character', d.characters[0]] : d.corporations?.[0] ? ['corporation', d.corporations[0]] : d.alliances?.[0] ? ['alliance', d.alliances[0]] : null;
      if (pick) hit = { ...pick[1], kind: pick[0] };
    }
  } catch { /* 调用方提示 */ }
  return hit;
}

// 自己加入的邮件列表（需要 esi-mail.read_mail.v1），读完通知重画
export function loadMailLists() {
  const token = ctx.tokenInfo();
  if (!token || S.lists || !ctx.hasScope(READ_MAIL_SCOPE)) return;
  S.lists = [];
  ctx.esiAuthFetch('/characters/' + token.character_id + '/mail/lists/')
    .then((l) => { S.lists = Array.isArray(l) ? l : []; changed(); })
    .catch(() => { S.lists = null; });
}

// 加进通讯录：默认两种预警都勾上
async function add(text, listId) {
  if (M.book.length >= MAX) { ctx.showToast(`收件人最多 ${MAX} 个`, 'error'); return; }
  let hit = null;
  if (listId) {
    const l = (S.lists || []).find((x) => x.mailing_list_id === Number(listId));
    if (l) hit = { id: l.mailing_list_id, name: l.name, kind: 'mailing_list' };
  } else {
    text = text.trim();
    if (!text) return;
    hit = await resolveEntity(text);
    if (!hit) { ctx.showToast('没有找到：请输入游戏内完整的角色 / 军团 / 联盟名称，或 ID', 'error', 4000); return; }
  }
  if (!hit) return;
  if (M.book.some((e) => e.id === hit.id)) { ctx.showToast(`${hit.name} 已经在收件人里`, 'error'); return; }
  const el = panel?.querySelector('[data-am-name]');
  if (el) el.value = '';
  const key = String(hit.id);
  update({ book: [...M.book, hit], use: Object.fromEntries(SRC.map((s) => [s, [...M.use[s], key]])) });
}
function toggleUse(src, key) {
  const cur = M.use[src] || [];
  update({ use: { ...M.use, [src]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] } });
}
function remove(id) {
  const key = String(id);
  update({ book: M.book.filter((r) => r.id !== Number(id)), use: Object.fromEntries(SRC.map((s) => [s, M.use[s].filter((k) => k !== key)])) });
}

// 击杀预警 / 本地日志标签页里「游戏内邮件」开关下面的一行：勾选这种预警发给谁，通讯录在「邮件」标签页管理
export function pickerHtml(src) {
  const esc = ctx.esc;
  const use = M.use[src] || [];
  const chip = (key, label, sub = '') => `<button type="button" class="ka-chip toggle${use.includes(key) ? ' on' : ''}" data-am-use="${src}:${key}">${esc(label)}${sub ? `<small> · ${sub}</small>` : ''}</button>`;
  return `<div class="ka-opt ka-stack"><span><b>收件人</b><small>${M.book.length ? '勾选这种预警发给谁' : '邮件列表、军团、联盟、其他角色在「邮件」里添加'}</small></span>
    <div class="ka-chips">${chip('self', '自己')}${M.book.map((r) => chip(String(r.id), r.name, r.kind !== 'character' ? KIND_ZH[r.kind] : '')).join('')}
      <button type="button" class="ka-chip toggle ka-chip-link" data-ac-goto="mail">管理收件人</button></div></div>`;
}
// 收件人勾选的事件（每个面板容器绑一次）
export function bindPicker(box) {
  if (box.dataset.amBound) return;
  box.dataset.amBound = '1';
  box.addEventListener('click', (e) => {
    const u = e.target.closest('[data-am-use]');
    if (!u) return;
    const [src, key] = u.dataset.amUse.split(':');
    toggleUse(src, key);
  });
}

// ---------- 「邮件」标签页 ----------
let panel = null;
let shell = null;   // { close, isOpen }
function renderPanel() {
  if (!panel || !shell.isOpen(panel)) return;
  const el = panel.querySelector('[data-am-name]');
  const keep = el ? { value: el.value, focus: document.activeElement === el } : null;
  const sc = panel.closest('.modal-body');
  const top = sc?.scrollTop || 0;
  panel.innerHTML = drawPanel();
  if (keep) {
    const n = panel.querySelector('[data-am-name]');
    n.value = keep.value;
    if (keep.focus) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }
  if (sc) sc.scrollTop = top;
}
function drawPanel() {
  const esc = ctx.esc;
  const token = ctx.tokenInfo();
  const ok = canMail();
  const state = !token ? '未绑定 ESI，不能发邮件' : ok ? `以 ${token.character_name || ''} 的名义发送` : '授权里没有发送邮件权限，请重新绑定 ESI';
  const labels = SRC.filter((s) => sources.has(s)).map((s) => [s, sources.get(s).label]);
  const useBtn = (src, key, label) => `<button type="button" class="ka-chip toggle${(M.use[src] || []).includes(key) ? ' on' : ''}" data-am-use="${src}:${key}">${label}</button>`;
  const row = (key, name, sub, del) => `<div class="ka-opt am-row"><span><b>${esc(name)}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    <span class="ka-chips">${labels.map(([s, l]) => useBtn(s, key, l)).join('')}</span>${del ? `<button class="ka-close" data-am-del="${key}" aria-label="移除" title="移除">×</button>` : '<span class="am-del-gap"></span>'}</div>`;
  const sw = (s, l) => `<label class="ka-opt"><span><b>${l}</b><small>${sources.get(s).on() ? esc(recipientNames(s).join(' · ')) : '不发邮件'}</small></span><input type="checkbox" class="ka-switch" data-am-on="${s}"${sources.get(s).on() ? ' checked' : ''}></label>`;
  return `
    <div class="ka-top"><span class="ka-status${ok ? ' on' : ''}"><i></i>${esc(state)}</span></div>
    ${token ? '' : '<p class="ka-warn">游戏内邮件需要先在「个人中心」绑定 ESI</p>'}
    <section class="ka-sec"><h4 class="ka-h">哪些预警发邮件</h4><div class="ka-list">${labels.map(([s, l]) => sw(s, l)).join('')}</div>
      <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-am-test${token ? '' : ' disabled'}>发送测试邮件</button></div></section>
    <section class="ka-sec"><h4 class="ka-h">收件人<small>每个收件人勾选接收哪种预警</small></h4><div class="ka-list">
      ${row('self', '自己', token ? esc(token.character_name || '') : '', false)}
      ${M.book.map((r) => row(String(r.id), r.name, KIND_ZH[r.kind], true)).join('')}
      <div class="ka-opt ka-stack"><div class="ka-watch-add">
        ${S.lists?.length ? `<select class="cr-input" data-am-list aria-label="邮件列表"><option value="">邮件列表…</option>${S.lists.map((l) => `<option value="${l.mailing_list_id}">${esc(l.name)}</option>`).join('')}</select>` : ''}
        <input type="text" class="cr-input" data-am-name placeholder="角色 / 军团 / 联盟全名或 ID" autocomplete="off" spellcheck="false" aria-label="收件人">
        <button class="btn btn-primary btn-sm" data-am-add${token ? '' : ' disabled'}>添加</button>
      </div>
      ${token && !ctx.hasScope(READ_MAIL_SCOPE) ? '<small>读取你加入的邮件列表需要「读取邮件」授权，重新绑定 ESI 时勾选</small>' : ''}</div>
    </div></section>
    <p class="ka-note">同一角色两封邮件至少隔 1 分钟，期间的提醒合并成一封；邮件语言跟随界面语言。发给军团 / 联盟要有游戏里的群发权限，对方开了 CSPA 收费会发送失败。</p>`;
}
function testMail() {
  if (!canMail()) { testToast(null); return; }
  const token = ctx.tokenInfo();
  const names = recipientNames('test').map((n) => (n === '自己' ? L('自己', 'yourself') : n));
  const body = `<font size="14">${L('这是一封测试邮件：EVE Market 预警邮件可以正常送达。', 'This is a test mail: EVE Market alert mails are being delivered.')}</font><br><br>` +
    `${L('发件人：', 'Sender: ')}${ctx.esc(token.character_name || '')}<br>${L('收件人：', 'Recipients: ')}${ctx.esc(names.join(L('、', ', ')))}` +
    `<br><br><font size="10" color="#ff888888">${L('可在网页右上角铃铛的「邮件」里调整收件人。', 'Recipients can be changed under Alerts → Mail (bell icon, top right of the site).')}</font>`;
  sendMail('test', L('预警邮件测试', 'Alert mail test'), body).then(testToast);
}
// 把标签页挂到弹窗里（只挂一次）
export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  bindPicker(panel);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-am-add]')) { add(panel.querySelector('[data-am-name]')?.value || '', ''); return; }
    if (e.target.closest('[data-am-test]')) { testMail(); return; }
    const del = e.target.closest('[data-am-del]');
    if (del) remove(del.dataset.amDel);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-am-name]')) { e.preventDefault(); add(e.target.value, ''); }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-am-list]') && e.target.value) { add('', e.target.value); return; }
    const on = e.target.closest('[data-am-on]');
    if (on) {
      if (on.checked && !ctx.tokenInfo()) { on.checked = false; ctx.showToast('游戏内邮件需要先在「个人中心」绑定 ESI', 'error', 4000); return; }
      sources.get(on.dataset.amOn)?.set(on.checked);
      renderPanel();
    }
  });
}
export function showPanel() {
  renderPanel();
  loadMailLists();
}
// 模块设置变了（开关邮件）时刷新「邮件」标签页
export const refresh = () => renderPanel();
