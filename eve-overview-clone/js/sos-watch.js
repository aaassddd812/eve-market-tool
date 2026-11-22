// ===== 虫洞求救提醒 =====
// 开启后每分钟查一次击杀记录服务的 /api/kb/wh/sos（当前服务器），有人新发求救就按勾选的方式提醒：
//   网页弹窗（右下角卡片）、提示音、系统通知、游戏内邮件（alert-mail.js）、企业微信 / 邮箱（alert-push.js），与击杀预警共用这些渠道的设置。
// 开启时把已有的求救记为已提醒，只提醒之后新发的；重新打开网页时补提醒 30 分钟内发的。自己绑定的角色发的不提醒；可只提醒有悬赏的。
// 多个标签页：已提醒记录存在 localStorage（eve-sos-seen，按服务器），先看到的标签页领取后其他标签页跳过，所以只响一次、只发一次。
// 设置存在 eve-sos-watch-v1（按服务器）：{ on, web, sound, notify, mail, rewardOnly }。
// 设置面板是「预警」弹窗（铃铛）的「虫洞求救」标签页；虫洞页「求救」里有入口。

import { SERVER, serverKey } from './server.js?v=s4';
import * as AM from './alert-mail.js?v=v8';
import * as AP from './alert-push.js?v=v14';

let ctx;   // esc, formatISK, showToast, resolveNames, accounts, tokenInfo, hasScope, openEsiBind, openWhSystem
const KEY = serverKey('eve-sos-watch-v1');
const SEEN_KEY = serverKey('eve-sos-seen');
const POLL = 60e3;
const CATCH_UP = 30 * 60e3;     // 重新打开网页时补提醒多久内发的
const SEEN_TTL = 3 * 86400e3;
const DEFAULTS = { on: false, web: true, sound: true, notify: false, mail: false, rewardOnly: false };
const T = { ...DEFAULTS };
const S = { timer: 0, busy: false, error: '', checked: 0, recent: [], names: new Map(), mailQueue: [], mailTimer: 0 };
const subs = new Set();

export function initSosWatch(context) {
  if (ctx) return;
  ctx = context;
  try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 忽略 */ }
  AM.initAlertMail(ctx);
  AP.initAlertPush({ esc: ctx.esc, showToast: ctx.showToast });
  AM.registerSource('sos', { label: '虫洞求救', on: () => T.mail, set: (on) => update({ mail: on }) });
  AM.onMailChange(renderPanel);
  AP.onPushChange(renderPanel);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && T.on) poll(); });
  if (T.on) start(false);
}

export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export const settings = () => T;
function notify() {
  for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } }
  window.dispatchEvent(new CustomEvent('eve-sos-watch', { detail: { on: T.on } }));
}
export function status() {
  return { on: T.on, mail: T.on && T.mail, text: T.on ? (S.error ? '检查失败：' + S.error : '已开启 · 每分钟检查一次') : '未开启' };
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 忽略 */ } }
export function update(patch) {
  const was = T.on;
  Object.assign(T, patch);
  save();
  if (T.on && !was) start(true);
  if (!T.on && was) { clearInterval(S.timer); S.timer = 0; S.error = ''; }
  notify();
  renderPanel();
  if ('mail' in patch) AM.refresh();
}
function start(fresh) {
  clearInterval(S.timer);
  S.timer = setInterval(poll, POLL);
  poll(fresh);
}

// ---------- 检查 ----------
const keyOf = (x) => `${x.char_id}:${x.created}`;
function readSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch { return {}; }
}
// 领取没提醒过的（写进已提醒记录），返回本标签页负责提醒的那些
function claim(items) {
  const now = Date.now();
  const seen = readSeen();
  for (const [k, t] of Object.entries(seen)) if (now - t > SEEN_TTL) delete seen[k];
  const mine = items.filter((x) => !seen[keyOf(x)]);
  for (const x of mine) seen[keyOf(x)] = now;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* 无痕模式：只在本标签页去重 */ }
  return mine;
}
async function poll(fresh = false) {
  if (!T.on || S.busy) return;
  S.busy = true;
  try {
    const res = await fetch('/api/kb/wh/sos?server=' + SERVER.id);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || 'HTTP ' + res.status);
    const items = data.items || [];
    const unseen = claim(items);
    S.error = '';
    S.checked = Date.now();
    // 刚开启：已有的只记下不提醒；重新打开网页：只补提醒最近发的
    if (fresh) return;
    const mine = new Set((ctx.accounts?.() || []).map((a) => a.id));
    const list = unseen.filter((x) => !mine.has(x.char_id) && Date.now() - x.created * 1000 < CATCH_UP && (!T.rewardOnly || x.reward > 0));
    if (list.length) await alertAll(list);
  } catch (error) {
    S.error = error.message;
  } finally {
    S.busy = false;
    notify();
    renderPanel();
  }
}

// ---------- 提醒 ----------
async function sysNames(list) {
  const ids = [...new Set(list.map((x) => x.system_id))].filter((id) => !S.names.has(id));
  if (ids.length) {
    try {
      const { names } = await ctx.resolveNames(ids);
      for (const id of ids) if (names.get(id)) S.names.set(id, names.get(id));
    } catch { /* 名字取不到时用 ID */ }
  }
}
const sysName = (id) => S.names.get(id) || String(id);
const sysUrl = (x) => `${location.origin}${location.pathname}#wh/system/${encodeURIComponent(sysName(x.system_id))}`;
function describe(x) {
  return AM.L(`${sysName(x.system_id)} · ${x.name} 求救`, `${sysName(x.system_id)} · ${x.name} needs help`)
    + (x.words ? AM.L('：', ': ') + x.words : '')
    + (x.reward ? AM.L(` · 悬赏 ${ctx.formatISK(x.reward)} ISK`, ` · reward ${ctx.formatISK(x.reward)} ISK`) : '')
    + (x.contact ? AM.L(` · 联系：${x.contact}`, ` · contact: ${x.contact}`) : '');
}
async function alertAll(list) {
  await sysNames(list);
  S.recent = [...list.map((x) => ({ ...x, at: Date.now() })), ...S.recent].slice(0, 10);
  for (const x of list) {
    if (T.web) webAlert(x);
    AP.push('sos', { sig: 'sos|' + keyOf(x), text: describe(x), url: sysUrl(x) });
  }
  if (T.sound) beep();
  if (T.notify && window.Notification?.permission === 'granted') {
    try {
      const n = new Notification(AM.L('虫洞求救', 'Wormhole SOS') + (list.length > 1 ? ` (${list.length})` : ''), { body: list.map(describe).join('\n'), tag: 'eve-sos-' + keyOf(list[0]) });
      n.onclick = () => { window.focus(); n.close(); ctx.openWhSystem(sysName(list[0].system_id)); };
    } catch { /* 部分浏览器只允许 Service Worker 通知 */ }
  }
  if (T.mail) queueMail(list);
}

// 网页弹窗：右下角卡片（会战提醒在右上角，互不遮挡），45 秒后消失
function webAlert(x) {
  let box = document.getElementById('sosAlerts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sosAlerts';
    box.className = 'battle-alerts sos-alerts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      const card = e.target.closest('.battle-alert');
      if (!card) return;
      if (e.target.closest('[data-sos-open]')) ctx.openWhSystem(card.dataset.name);
      if (e.target.closest('button')) card.remove();
    });
  }
  const { esc, formatISK } = ctx;
  const card = document.createElement('div');
  card.className = 'battle-alert sos-alert';
  card.dataset.name = sysName(x.system_id);
  card.innerHTML = `<div class="battle-alert-head"><strong>虫洞求救</strong><span>${esc(sysName(x.system_id))} · <span class="notranslate">${esc(x.name)}</span></span>
      <button class="battle-close" aria-label="关闭">×</button></div>
    ${x.words ? `<p class="notranslate">${esc(x.words)}</p>` : ''}
    ${x.reward || x.contact ? `<p>${x.reward ? `悬赏 <b>${formatISK(x.reward)} ISK</b>` : ''}${x.reward && x.contact ? ' · ' : ''}${x.contact ? `<span>联系：</span><span class="notranslate">${esc(x.contact)}</span>` : ''}</p>` : ''}
    <div class="battle-actions"><button class="btn btn-primary" data-sos-open>查看星系</button></div>`;
  box.prepend(card);
  while (box.children.length > 4) box.lastElementChild.remove();
  setTimeout(() => card.remove(), 45e3);
}
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880, 660].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.2);
      g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + i * 0.2 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.2 + 0.18);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + i * 0.2); o.stop(ac.currentTime + i * 0.2 + 0.19);
    });
    setTimeout(() => ac.close(), 1500);
  } catch { /* 浏览器不允许自动播放时忽略 */ }
}
// 游戏内邮件：合并、限速（与击杀预警共用发信间隔）
function queueMail(list) {
  if (!AM.canMail()) return;
  S.mailQueue.push(...list);
  if (S.mailTimer) return;
  S.mailTimer = setTimeout(flushMail, AM.nextSlot());
}
async function flushMail() {
  S.mailTimer = 0;
  const list = S.mailQueue.splice(0);
  if (!list.length) return null;
  const subject = list.length === 1 ? AM.L('虫洞求救：', 'Wormhole SOS: ') + `${sysName(list[0].system_id)} · ${list[0].name}` : AM.L(`虫洞求救：${list.length} 条新求救`, `Wormhole SOS: ${list.length} new posts`);
  const body = list.map((x) => `<a href="${sysUrl(x)}">${ctx.esc(sysName(x.system_id))}</a> · ${ctx.esc(x.name)}<br>`
    + (x.words ? ctx.esc(x.words) + '<br>' : '')
    + (x.reward ? AM.L('悬赏 ', 'Reward ') + ctx.formatISK(x.reward) + ' ISK<br>' : '')
    + (x.contact ? AM.L('联系：', 'Contact: ') + ctx.esc(x.contact) + '<br>' : '')).join('<br>');
  return AM.sendMail('sos', subject, body);
}

// 测试：按开着的网页提醒方式弹一条假的
function test() {
  const x = { char_id: 0, created: Math.floor(Date.now() / 1000), system_id: 0, name: AM.L('测试飞行员', 'Test Pilot'), words: AM.L('这是一条测试求救', 'This is a test SOS'), reward: 100000000, contact: '' };
  S.names.set(0, 'J123456');
  if (!T.web && !T.sound && !T.notify) { ctx.showToast('先打开网页弹窗、提示音或系统通知', 'info'); return; }
  if (T.web) webAlert(x);
  if (T.sound) beep();
  if (T.notify && window.Notification?.permission === 'granted') {
    try { new Notification(AM.L('虫洞求救（测试）', 'Wormhole SOS (test)'), { body: describe(x) }); } catch { /* 忽略 */ }
  }
}

// ---------- 设置面板（「预警」弹窗的「虫洞求救」标签页）----------
let panel = null;
let shell = null;   // { close, isOpen }
const sw = (key, label, sub = '', tip = '') => `<label class="ka-opt"${tip ? ` title="${tip}"` : ''}><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="ka-switch" data-sw-set="${key}"${T[key] ? ' checked' : ''}></label>`;
const sec = (title, body) => `<section class="ka-sec"><h4 class="ka-h">${title}</h4>${body}</section>`;
function renderPanel() {
  if (!panel || !shell.isOpen(panel)) return;
  const { esc, formatISK } = ctx;
  const st = status();
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  panel.innerHTML = `
    <div class="ka-top"><span class="ka-status${st.on ? ' on' : ''}"><i></i>${esc(st.text)}</span></div>
    ${sec('虫洞求救', `<div class="ka-list">
      ${sw('on', '开启求救提醒', '', '有人在虫洞里发求救时提醒（每分钟检查一次，自己的角色发的不提醒）')}
      ${sw('rewardOnly', '只提醒有悬赏的')}
    </div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('mail', '游戏内邮件', '', '发 EVE 邮件，附星系链接（每分钟最多一封，多条合并）')}
      ${T.mail ? AM.pickerHtml('sos') : ''}
      ${AP.switchHtml('sos')}
      ${sw('web', '网页弹窗', '', '右下角弹出求救卡片')}
      ${sw('sound', '提示音')}
      ${sw('notify', '系统通知', '', '浏览器在后台时也能看到（需要允许通知）')}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-sw-test>测试网页提醒</button></div>`)}
    ${sec('最近求救', S.recent.length ? `<ul class="sos-recent">${S.recent.map((x) => `<li><button type="button" class="link-btn" data-sw-open="${esc(sysName(x.system_id))}">${esc(sysName(x.system_id))}</button> · <span class="notranslate">${esc(x.name)}</span>${x.reward ? ` · ${formatISK(x.reward)} ISK` : ''}<small class="text-muted"> ${ago(x.at)}</small>${x.words ? `<br><small class="notranslate">${esc(x.words)}</small>` : ''}</li>`).join('')}</ul>`
      : `<p class="ka-note">${T.on ? (S.checked ? `暂时没有新求救 · ${ago(S.checked)}检查` : '正在检查…') : '开启后这里显示收到的求救'}</p>`)}
    <p class="ka-note">网页需保持打开（可在后台）</p>`;
}
export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  AM.bindPicker(panel);
  AP.bindSwitch(panel);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-sw-test]')) { test(); return; }
    const open = e.target.closest('[data-sw-open]');
    if (open) { shell.close(); ctx.openWhSystem(open.dataset.swOpen); }
  });
  panel.addEventListener('change', async (e) => {
    const set = e.target.closest('[data-sw-set]');
    if (!set) return;
    if (set.dataset.swSet === 'notify' && set.checked) {
      if (!window.Notification) { set.checked = false; ctx.showToast('这个浏览器不支持系统通知', 'error'); return; }
      if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission().catch(() => 'denied');
        if (p !== 'granted') { set.checked = false; ctx.showToast('浏览器没有允许通知', 'error'); return; }
      }
    }
    update({ [set.dataset.swSet]: set.checked });
  });
}
export function showPanel() {
  renderPanel();
  AM.loadMailLists();
}
