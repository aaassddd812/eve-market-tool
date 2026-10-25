// ===== 预警邮件（击杀预警、本地日志共用）=====
// 收件人：默认发给自己（可取消），可另加邮件列表（读自己加入的列表要 esi-mail.read_mail.v1）、军团、联盟、其他角色，最多 10 个。
//   游戏里的聊天频道 ESI 没有发送接口，想让队友收到就建一个邮件列表。发给军团 / 联盟要有游戏里的群发权限，对方开了 CSPA 收费会发送失败。
// 发送：esi-mail.send_mail.v1；两种预警共用发信间隔（同一角色两封至少隔 60 秒，失败后再多等 1 分钟），各自把这段时间里的提醒合并成一封。
// 设置存在 eve-alert-mail-v1（按服务器）；旧版击杀预警里的 mailSelf / mailTo 第一次加载时搬过来。

import { serverKey, esiUrl } from './server.js?v=s4';

let ctx;   // esc, showToast, esiAuthFetch, tokenInfo, hasScope
const KEY = serverKey('eve-alert-mail-v1');
export const MAIL_SCOPE = 'esi-mail.send_mail.v1';
const READ_MAIL_SCOPE = 'esi-mail.read_mail.v1';
const MAIL_GAP = 60e3;
const MAX = 10;
export const KIND_ZH = { character: '角色', corporation: '军团', alliance: '联盟', mailing_list: '邮件列表' };
const M = { self: true, to: [] };   // to: [{ id, name, kind: character|corporation|alliance|mailing_list }]
const S = { lastMail: 0, lists: null, error: '' };
const subs = new Set();

export function initAlertMail(context, legacy = null) {
  if (ctx) return;
  ctx = context;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 忽略 */ }
  if (saved) Object.assign(M, saved);
  else if (legacy && (Array.isArray(legacy.mailTo) || legacy.mailSelf === false)) { M.self = legacy.mailSelf !== false; M.to = legacy.mailTo || []; save(); }
  if (!Array.isArray(M.to)) M.to = [];
}
export const mailSettings = () => M;
export function onMailChange(fn) { subs.add(fn); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(M)); } catch { /* 忽略 */ } }
function update(patch) {
  Object.assign(M, patch);
  save();
  subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}

export const canMail = () => Boolean(ctx?.tokenInfo()) && ctx.hasScope(MAIL_SCOPE);
// 离下一次可以发信还要等多久（毫秒，至少 3 秒，好把同时到的提醒合并）
export const nextSlot = () => Math.max(3e3, S.lastMail + MAIL_GAP - Date.now());
export const lastError = () => S.error;

// 收件人：自己（可关）+ 另加的；都没有时还是发给自己
function recipients(token) {
  const out = M.self ? [{ recipient_id: token.character_id, recipient_type: 'character' }] : [];
  for (const r of M.to) if (r.id !== token.character_id || r.kind !== 'character') out.push({ recipient_id: r.id, recipient_type: r.kind });
  return out.length ? out : [{ recipient_id: token.character_id, recipient_type: 'character' }];
}
// 正文里怎么称呼预警的主人：只发给自己时是「你」，发给别人时用角色名
export function ownerWord() {
  const token = ctx.tokenInfo();
  if (!token) return '你';
  return recipients(token).some((r) => r.recipient_id !== token.character_id) ? ctx.esc(token.character_name || '') : '你';
}

// 发一封：成功 true，失败 false（原因见 lastError），没绑定 / 没权限 null
export async function sendMail(subject, body) {
  const token = ctx.tokenInfo();
  if (!token || !ctx.hasScope(MAIL_SCOPE)) return null;
  S.lastMail = Date.now();
  try {
    await ctx.esiAuthFetch('/characters/' + token.character_id + '/mail/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: recipients(token), subject: subject.slice(0, 100), body, approved_cost: 0 })
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
    .then((l) => { S.lists = Array.isArray(l) ? l : []; update({}); })
    .catch(() => { S.lists = null; });
}

async function add(box, text, listId) {
  if (M.to.length >= MAX) { ctx.showToast(`收件人最多 ${MAX} 个`, 'error'); return; }
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
  if (M.to.some((e) => e.id === hit.id)) { ctx.showToast(`${hit.name} 已经在收件人里`, 'error'); return; }
  const el = box.querySelector('[data-am-name]');
  if (el) el.value = '';
  update({ to: [...M.to, hit] });
}

// 收件人设置（放在「提醒方式」里游戏内邮件开关下面）；输入框带 data-keep，重画时各模块会保留输入
export function recipientsHtml() {
  const token = ctx.tokenInfo();
  const esc = ctx.esc;
  return `<div class="ka-opt ka-stack"><span title="游戏里的聊天频道没有发送接口，想让队友收到可以建一个邮件列表。发给军团 / 联盟要有游戏里的群发权限，对方开了 CSPA 收费会发送失败"><b>收件人</b><small>击杀预警与本地日志共用 · 聊天频道发不了，可用邮件列表</small></span>
    <div class="ka-chips"><button type="button" class="ka-chip toggle${M.self ? ' on' : ''}" data-am-self>自己</button>${M.to.map((r) => `<span class="ka-chip">${esc(r.name)}${r.kind !== 'character' ? `<small> · ${KIND_ZH[r.kind]}</small>` : ''}<button class="ka-close" data-am-del="${r.id}" aria-label="移除">×</button></span>`).join('')}</div>
    <div class="ka-watch-add">
      ${S.lists?.length ? `<select class="cr-input" data-am-list aria-label="邮件列表"><option value="">邮件列表…</option>${S.lists.map((l) => `<option value="${l.mailing_list_id}">${esc(l.name)}</option>`).join('')}</select>` : ''}
      <input type="text" class="cr-input" data-am-name data-keep="am-name" placeholder="角色 / 军团 / 联盟全名或 ID" autocomplete="off" spellcheck="false" aria-label="收件人">
      <button class="btn btn-primary btn-sm" data-am-add${token ? '' : ' disabled'}>添加</button>
    </div>
    ${token && !ctx.hasScope(READ_MAIL_SCOPE) ? '<small>读取你加入的邮件列表需要「读取邮件」授权，重新绑定 ESI 时勾选</small>' : ''}</div>`;
}
// 收件人设置的事件（每个面板容器绑一次）
export function bindRecipients(box) {
  if (box.dataset.amBound) return;
  box.dataset.amBound = '1';
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-am-add]')) { add(box, box.querySelector('[data-am-name]')?.value || '', ''); return; }
    if (e.target.closest('[data-am-self]')) { update({ self: !M.self }); return; }
    const del = e.target.closest('[data-am-del]');
    if (del) update({ to: M.to.filter((r) => r.id !== Number(del.dataset.amDel)) });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-am-name]')) { e.preventDefault(); add(box, e.target.value, ''); }
  });
  box.addEventListener('change', (e) => {
    if (e.target.matches('[data-am-list]') && e.target.value) add(box, '', e.target.value);
  });
}
