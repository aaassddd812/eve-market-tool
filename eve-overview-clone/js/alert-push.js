// ===== 企业微信 / 邮箱提醒（击杀预警、本地日志、本地红名、虫洞求救、订单被压价共用）=====
// 「预警」弹窗的「微信 / 邮箱」标签页（alert-center.js）：
//   企业微信：群里添加「群机器人」，把它的 Webhook 地址填进来；
//   邮箱：用户自己的发件邮箱 + 授权码（SMTP 服务器按邮箱域名自动填，也可手改），发给自己指定的收件邮箱；保存时先发一封测试，成功才保存。
//   每个渠道分别勾选推送哪种预警。两种都经击杀记录服务转发（/api/kb/push/*，浏览器不能直接跨域调企业微信，也不能直连 SMTP），
//   邮箱账号和授权码只存在本机浏览器，每次发信随请求带给服务器，服务器不保存。
// 发送：push(src, { sig, text, url })。多个标签页同一条只发一次（sig 记在 localStorage 5 分钟）；
//   同一渠道把一段时间里的提醒合并成一条（企业微信至少隔 5 秒，邮件至少隔 60 秒，上次发送时间多个标签页共用）。
//   内容语言跟随界面语言（调用方用 alert-mail.js 的 L() 生成文字）。
// 设置存在 eve-alert-push-v1（各服务器共用）：{ wecom: { key, use: { kill, intel, local, sos, order } }, mail: { user, pass, to, host, port, security, ok, use } }；
//   ok：测试邮件发成功过（这之后才推送）。
// 下面还有「服务器托管」分区（alert-host.js）：托管了的预警由服务器推送，这里的 push 跳过，免得重复。

import { SERVER } from './server.js?v=s4';
import { L } from './alert-mail.js?v=v8';
import * as AH from './alert-host.js?v=v2';

let ctx;   // esc, showToast
const KEY = 'eve-alert-push-v1';
const SENT_KEY = 'eve-alert-pushed';
const LAST_KEY = 'eve-alert-push-last';
const API = '/api/kb/push/';
const CH = ['wecom', 'mail'];
const GAP = { wecom: 5e3, mail: 60e3 };
const SRC = [['kill', '击杀预警'], ['intel', '本地日志'], ['local', '本地红名'], ['sos', '虫洞求救'], ['order', '订单被压价']];
const P = { wecom: { key: '', use: { kill: true, intel: true, local: true, sos: true, order: true } }, mail: { user: '', pass: '', to: '', host: '', port: 465, security: 'ssl', ok: false, use: { kill: true, intel: true, local: true, sos: true, order: true } } };
const S = { edit: false, custom: false, help: '', busy: '', error: { wecom: '', mail: '' } };   // edit：正在修改邮箱设置；custom：展开了服务器设置；help：展开的教程
// 标题旁「?」展开的教程：[步骤…]、[提示…]；步骤可以是 [文字, [分项…]]
const HELP = {
  wecom: [[
    '手机或电脑打开企业微信，进入要接收提醒的群聊（只有企业内部群能加机器人；没有企业的话，可以在企业微信里免费创建一个）',
    '群聊右上角「…」→「群机器人」→「添加」→「新创建一个机器人」，名字随意',
    '创建后复制它的 Webhook 地址（https://qyapi.weixin.qq.com 开头），粘贴到上面点「保存」',
    '点「发送测试」，群里收到消息就成功了'
  ], [
    '5 秒内的多条提醒合并成一条发送',
    'Webhook 地址相当于往群里发消息的钥匙，不要发给别人'
  ]],
  mail: [[
    ['在网页版邮箱里开启 SMTP 服务，生成授权码', [
      'QQ 邮箱：「设置 → 账号与安全」（旧版是「设置 → 账户」）→ 开启「POP3/IMAP/SMTP 服务」，按提示发短信后得到授权码',
      '163 / 126 邮箱：「设置 → POP3/SMTP/IMAP」→ 开启 SMTP 服务，新增授权密码',
      'Gmail：先开启两步验证，再在 Google 账号里创建「应用专用密码」'
    ]],
    '「发件邮箱」填这个邮箱，「授权码」填刚生成的授权码（不是邮箱登录密码）',
    '「收件邮箱」留空就发给自己，也可以填另一个常看的邮箱；手机装上邮箱 App 就能收到通知',
    '点「保存并发送测试」，收到测试邮件就成功了；没收到的话看看垃圾邮件，并把发件地址加进白名单'
  ], [
    '1 分钟内的多条提醒合并成一封发送',
    '账号和授权码只存在这台电脑的浏览器里，发信时经本站服务器转发，服务器不保存；换浏览器或清除网站数据后要重新填写',
    'Outlook / Hotmail 邮箱微软正在停用授权码登录，可能用不了，建议用 QQ 或 163 邮箱'
  ]]
};
// 常用邮箱的 SMTP 服务器（其它域名猜 smtp.域名:465，用户可改）
const QQ = ['smtp.qq.com', 465, 'ssl'], OUTLOOK = ['smtp-mail.outlook.com', 587, 'starttls'];
const PRESET = {
  'qq.com': QQ, 'foxmail.com': QQ, 'vip.qq.com': QQ, '163.com': ['smtp.163.com', 465, 'ssl'], '126.com': ['smtp.126.com', 465, 'ssl'],
  'yeah.net': ['smtp.yeah.net', 465, 'ssl'], 'sina.com': ['smtp.sina.com', 465, 'ssl'], 'aliyun.com': ['smtp.aliyun.com', 465, 'ssl'],
  '139.com': ['smtp.139.com', 465, 'ssl'], 'gmail.com': ['smtp.gmail.com', 465, 'ssl'], 'yahoo.com': ['smtp.mail.yahoo.com', 465, 'ssl'],
  'outlook.com': OUTLOOK, 'hotmail.com': OUTLOOK, 'live.com': OUTLOOK
};
const presetOf = (user) => { const d = user.split('@')[1]?.toLowerCase() || ''; return PRESET[d] || [d ? 'smtp.' + d : '', 465, 'ssl']; };
const SEC = { ssl: 'SSL', starttls: 'STARTTLS' };
const Q = { wecom: [], mail: [] };
const timer = {};
const subs = new Set();

try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  for (const ch of CH) if (saved?.[ch]) Object.assign(P[ch], saved[ch], { use: { ...P[ch].use, ...saved[ch].use } });
} catch { /* 忽略 */ }

export function initAlertPush(context) {
  ctx = ctx || context;
  if (context.host) AH.initAlertHost({ ...context.host, esc: context.esc, showToast: context.showToast, render, channels: () => ({ P, ready }), lang: () => L('zh', 'en') });
}
export function onPushChange(fn) { subs.add(fn); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch { /* 忽略 */ } }
function changed() {
  save();
  AH.sync();
  subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  render();
}

const ready = (ch) => (ch === 'wecom' ? Boolean(P.wecom.key) : P.mail.ok);
// 有渠道在推送（标签上的状态点）
export const isOn = () => CH.some((ch) => ready(ch) && SRC.some(([s]) => P[ch].use[s]));
// 别的页面（改单小助手）自己画开关时用：渠道是否已设置、某种提醒推不推送
export const isReady = (ch) => ready(ch);
export const uses = (ch, src) => Boolean(P[ch].use[src]);
export function setUse(ch, src, on) { P[ch].use[src] = Boolean(on); changed(); }

async function post(op, body) {
  const res = await fetch(API + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let d = null;
  try { d = await res.json(); } catch { /* 下面报错 */ }
  if (!res.ok || !d || d.error) throw new Error(d?.error || (res.status === 404 ? '提醒服务暂不可用' : 'HTTP ' + res.status));
  return d;
}
const mailBody = (m, title, lines, test) => ({
  smtp: { host: m.host, port: m.port, security: m.security, user: m.user, password: m.pass }, to: m.to || m.user, title, lines, lang: L('zh', 'en'), test
});

// 多个标签页同一条只发一次
function claim(sig) {
  try {
    const now = Date.now();
    const m = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
    for (const [k, t] of Object.entries(m)) if (now - t > 300e3) delete m[k];
    if (m[sig]) return false;
    m[sig] = now;
    localStorage.setItem(SENT_KEY, JSON.stringify(m));
  } catch { /* 无痕模式：照发 */ }
  return true;
}
const lastSent = (ch) => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '{}')[ch] || 0; } catch { return 0; } };
function markSent(ch, at) {
  try { const m = JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); m[ch] = at; localStorage.setItem(LAST_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
}

// 一条提醒：src 为 kill / intel，text 一行文字，url 可选（击杀详情）
export function push(src, item) {
  const chs = CH.filter((ch) => ready(ch) && P[ch].use[src] && !AH.covers(src));
  if (!chs.length || !claim(item.sig)) return;
  for (const ch of chs) {
    Q[ch].push({ src, text: item.text, url: item.url || '' });
    schedule(ch);
  }
}
function schedule(ch, extra = 0) {
  if (timer[ch]) return;
  timer[ch] = setTimeout(() => flush(ch), Math.max(2e3, lastSent(ch) + GAP[ch] - Date.now()) + extra);
}
const srcTitle = (s) => (s === 'kill' ? L('击杀预警', 'Kill alert') : s === 'order' ? L('订单被压价', 'Order undercut') : s === 'local' ? L('本地红名', 'Local reds') : s === 'sos' ? L('虫洞求救', 'Wormhole SOS') : L('本地日志', 'Local intel'));
async function flush(ch) {
  timer[ch] = 0;
  const list = Q[ch].splice(0);
  if (!list.length || !ready(ch)) return;
  const kinds = [...new Set(list.map((x) => x.src))];
  const title = `${kinds.length === 1 ? srcTitle(kinds[0]) : L('预警', 'Alerts')} · ${L(SERVER.name, SERVER.id === 'tq' ? 'Tranquility' : SERVER.id === 'serenity' ? 'Serenity' : 'Infinity')}`
    + (list.length > 1 ? L(`（${list.length} 条）`, ` (${list.length})`) : '');
  try {
    await send(ch, title, list.map(({ text, url }) => ({ text, url })));
  } catch (error) {
    // 别的标签页刚发过：放回去稍后再发
    if (/太频繁/.test(error.message) && !list.retried) { Q[ch].unshift(...list); list.retried = true; schedule(ch, 10e3); }
  }
}
async function send(ch, title, lines, test = false) {
  markSent(ch, Date.now());
  try {
    if (ch === 'wecom') await post('wecom', { key: P.wecom.key, title, lines });
    else await post('mail', mailBody(P.mail, title, lines, test));
    if (S.error[ch]) { S.error[ch] = ''; render(); }
  } catch (error) {
    console.warn('预警推送失败', ch, error);
    S.error[ch] = error.message;
    render();
    throw error;
  }
}
const testTitle = () => L('预警测试', 'Alert test') + ' · ' + L(SERVER.name, 'EVE Market');
const testLines = () => [{ text: L('这是一条测试消息：EVE Market 预警可以正常送达。', 'This is a test: EVE Market alerts are being delivered.') }];

// ---------- 击杀预警 / 本地日志标签页「提醒方式」里的两行开关 ----------
// 已设置的渠道显示开关（即这种预警推不推送），没设置的显示「去设置」（跳到「微信 / 邮箱」标签页）
export function switchHtml(src) {
  const esc = ctx.esc;
  const row = (ch, label, sub) => (ready(ch)
    ? `<label class="ka-opt"><span><b>${label}</b><small>${esc(sub)}</small></span><input type="checkbox" class="ka-switch" data-ap-src="${ch}:${src}"${P[ch].use[src] ? ' checked' : ''}></label>`
    : `<div class="ka-opt"><span><b>${label}</b><small>未设置</small></span><button type="button" class="ka-chip toggle ka-chip-link" data-ac-goto="push">去设置</button></div>`);
  return row('wecom', '企业微信', '群机器人') + row('mail', '邮箱', P.mail.to || P.mail.user);
}
// 开关的事件（每个面板容器绑一次）
export function bindSwitch(box) {
  if (box.dataset.apBound) return;
  box.dataset.apBound = '1';
  box.addEventListener('change', (e) => {
    const t = e.target.closest('[data-ap-src]');
    if (!t) return;
    const [ch, src] = t.dataset.apSrc.split(':');
    P[ch].use[src] = t.checked;
    changed();
  });
}

// ---------- 「微信 / 邮箱」标签页 ----------
let panel = null;
let shell = null;   // { close, isOpen }
function render() {
  if (!panel || !shell.isOpen(panel)) return;
  const keep = [...panel.querySelectorAll('[data-ap-in]')].map((el) => [el.dataset.apIn, el.value, document.activeElement === el]);
  panel.innerHTML = draw();
  for (const [k, v, focus] of keep) {
    const el = panel.querySelector(`[data-ap-in="${k}"]`);
    if (!el) continue;
    el.value = v;
    if (focus) el.focus();
  }
}
const chips = (ch) => `<span class="ka-chips">${SRC.map(([s, l]) => `<button type="button" class="ka-chip toggle${P[ch].use[s] ? ' on' : ''}" data-ap-use="${ch}:${s}">${l}</button>`).join('')}</span>`;
const errLine = (ch) => (S.error[ch] ? `<p class="ka-warn">发送失败：${ctx.esc(S.error[ch])}</p>` : '');
function draw() {
  const esc = ctx.esc;
  const busy = (k) => (S.busy === k ? ' disabled' : '');
  const w = P.wecom;
  const wecom = w.key
    ? `<div class="ka-opt"><span><b>群机器人</b><small>key ${esc(w.key.slice(0, 8))}…</small></span><button class="btn btn-ghost btn-sm" data-ap-del="wecom">移除</button></div>
       <div class="ka-opt"><span><b>推送</b></span>${chips('wecom')}</div>`
    : `<div class="ka-opt ka-stack"><div class="ka-watch-add">
        <input type="text" class="cr-input" data-ap-in="wecom" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" autocomplete="off" spellcheck="false" aria-label="Webhook 地址">
        <button class="btn btn-primary btn-sm" data-ap-wecom>保存</button></div></div>`;
  const m = P.mail;
  const editing = !m.ok || S.edit;
  const mail = editing ? mailForm(m, busy) : `<div class="ka-opt"><span><b>${esc(m.to && m.to !== m.user ? `${m.user} → ${m.to}` : m.user)}</b><small>${esc(m.host)}</small></span>
       <span class="ka-chips"><button class="btn btn-ghost btn-sm" data-ap-edit>修改</button><button class="btn btn-ghost btn-sm" data-ap-del="mail">移除</button></span></div>
       <div class="ka-opt"><span><b>推送</b></span>${chips('mail')}</div>`;
  return `
    <section class="ka-sec">${head('wecom', '企业微信')}<div class="ka-list">${wecom}</div>${errLine('wecom')}
      ${w.key ? `<div class="ka-actions"><button class="btn btn-ghost btn-sm" data-ap-test="wecom"${busy('test-wecom')}>发送测试</button></div>` : ''}</section>
    <section class="ka-sec">${head('mail', '邮箱')}<div class="ka-list">${mail}</div>${errLine('mail')}
      ${editing ? '' : `<div class="ka-actions"><button class="btn btn-ghost btn-sm" data-ap-test="mail"${busy('test-mail')}>发送测试</button></div>`}</section>
    ${AH.html()}`;
}
// 分区标题 + 「?」教程按钮；展开时标题下面显示步骤和提示
function head(ch, label) {
  const open = S.help === ch;
  const [steps, tips] = HELP[ch];
  return `<h4 class="ka-h">${label}<button type="button" class="ap-help-btn${open ? ' on' : ''}" data-ap-help="${ch}" aria-expanded="${open}" aria-label="使用教程" title="使用教程">?</button></h4>
    ${open ? `<div class="ap-help"><ol>${steps.map((x) => (Array.isArray(x) ? `<li>${x[0]}<ul>${x[1].map((y) => `<li>${y}</li>`).join('')}</ul></li>` : `<li>${x}</li>`)).join('')}</ol><ul>${tips.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}`;
}
// 邮箱设置表单：发件邮箱、授权码、收件邮箱；服务器按发件邮箱自动填，点「修改」展开
function mailForm(m, busy) {
  const esc = ctx.esc;
  const [host, port, sec] = S.custom ? [m.host, m.port, m.security] : presetOf(m.user);
  // 授权码用普通输入框 + 圆点遮挡（不用 password：浏览器会弹「保存密码」，把邮箱授权码存进本站的密码库）
  const field = (k, label, attrs) => `<label class="ap-field"><span>${label}</span><input class="cr-input${/ap-secret/.test(attrs) ? ' ap-secret' : ''}" data-ap-in="${k}" ${attrs.replace(' class="ap-secret"', '')} spellcheck="false"></label>`;
  return `<div class="ka-opt ka-stack ap-form">
      ${field('user', '发件邮箱', `type="email" value="${esc(m.user)}" placeholder="例如 12345@qq.com" autocomplete="email"`)}
      ${field('pass', '授权码', `type="text" class="ap-secret" value="${esc(m.pass)}" placeholder="邮箱设置里生成的授权码" autocomplete="off"`)}
      ${field('to', '收件邮箱', `type="email" value="${esc(m.to)}" placeholder="留空则发给发件邮箱" autocomplete="off"`)}
      ${S.custom ? `<div class="ap-server">${field('host', '服务器', `type="text" value="${esc(host)}" placeholder="smtp.example.com" autocomplete="off"`)}
        ${field('port', '端口', `type="number" value="${esc(String(port))}" min="1" max="65535"`)}
        <label class="ap-field"><span>加密</span><select class="cr-input" data-ap-in="sec">${Object.entries(SEC).map(([k, l]) => `<option value="${k}"${k === sec ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>`
      : `<div class="ap-server-line"><small>服务器 <span data-ap-host>${esc(host ? `${host}:${port}` : '按发件邮箱自动填写')}</span></small><button type="button" class="ka-chip toggle ka-chip-link" data-ap-custom>修改</button></div>`}
      <div class="ka-actions"><button class="btn btn-primary btn-sm" data-ap-save${busy('save')}>${S.busy === 'save' ? '发送测试中…' : '保存并发送测试'}</button>${m.ok ? '<button class="btn btn-ghost btn-sm" data-ap-cancel>取消</button>' : ''}</div></div>`;
}

async function run(k, fn) {
  S.busy = k;
  render();
  try { await fn(); } catch (error) { ctx.showToast(error.message, 'error', 5000); }
  S.busy = '';
  render();
}
function saveWecom() {
  const v = panel.querySelector('[data-ap-in="wecom"]')?.value.trim() || '';
  const key = (v.match(/[?&]key=([0-9a-f-]{36})/i) || v.match(/^([0-9a-f-]{36})$/i) || [])[1];
  if (!key) { ctx.showToast('请粘贴群机器人的 Webhook 地址（含 key=）', 'error', 4000); return; }
  P.wecom.key = key.toLowerCase();
  S.error.wecom = '';
  changed();
}
const val = (k) => (panel.querySelector(`[data-ap-in="${k}"]`)?.value || '').trim();
function saveMail() {
  const user = val('user'), pass = panel.querySelector('[data-ap-in="pass"]')?.value || '', to = val('to');
  const [host, port, security] = S.custom ? [val('host').toLowerCase(), Number(val('port')), val('sec')] : presetOf(user);
  const mailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!mailRe.test(user)) { ctx.showToast('发件邮箱不对', 'error'); return; }
  if (!pass) { ctx.showToast('请填写授权码', 'error'); return; }
  if (to && !mailRe.test(to)) { ctx.showToast('收件邮箱不对', 'error'); return; }
  if (!host || !port) { ctx.showToast('请填写邮件服务器和端口', 'error'); return; }
  const m = { user, pass, to: to === user ? '' : to, host, port, security };
  run('save', async () => {
    await post('mail', mailBody(m, testTitle(), testLines(), true));
    Object.assign(P.mail, m, { ok: true });
    S.edit = false;
    S.custom = false;
    S.error.mail = '';
    changed();
    ctx.showToast('已保存，测试邮件已发送，请查收（没收到看看垃圾邮件）', 'success', 5000);
  });
}
function test(ch) {
  run('test-' + ch, async () => {
    await send(ch, testTitle(), testLines(), true);
    ctx.showToast(ch === 'wecom' ? '测试消息已发送，请在企业微信群里查看' : '测试邮件已发送，请查收（没收到看看垃圾邮件）', 'success', 5000);
  });
}

// 把标签页挂到弹窗里（只挂一次）
export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  panel.addEventListener('click', (e) => {
    if (AH.onClick(e.target)) return;
    const t = e.target.closest('[data-ap-help], [data-ap-wecom], [data-ap-save], [data-ap-edit], [data-ap-cancel], [data-ap-custom], [data-ap-test], [data-ap-del], [data-ap-use]');
    if (!t) return;
    if (t.dataset.apHelp) { S.help = S.help === t.dataset.apHelp ? '' : t.dataset.apHelp; render(); }
    else if (t.dataset.apWecom != null) saveWecom();
    else if (t.dataset.apSave != null) saveMail();
    else if (t.dataset.apEdit != null || t.dataset.apCancel != null) {
      S.edit = t.dataset.apEdit != null;
      // 之前手改过服务器的，修改时直接展开服务器设置
      S.custom = S.edit && presetOf(P.mail.user).join() !== [P.mail.host, P.mail.port, P.mail.security].join();
      render();
    }
    else if (t.dataset.apCustom != null) {
      // 展开服务器设置：先按当前发件邮箱填好
      const [host, port, security] = presetOf(val('user'));
      Object.assign(P.mail, { host, port, security });
      S.custom = true;
      render();
    } else if (t.dataset.apTest) test(t.dataset.apTest);
    else if (t.dataset.apDel) {
      const ch = t.dataset.apDel;
      if (ch === 'wecom') P.wecom.key = '';
      else Object.assign(P.mail, { pass: '', ok: false });
      Q[ch].length = 0;
      S.error[ch] = '';
      changed();
    } else {
      const [ch, s] = t.dataset.apUse.split(':');
      P[ch].use[s] = !P[ch].use[s];
      changed();
    }
  });
  panel.addEventListener('change', (e) => AH.onChange(e.target));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && AH.onEnter(e.target)) { e.preventDefault(); return; }
    if (e.key !== 'Enter' || !e.target.matches('[data-ap-in]')) return;
    e.preventDefault();
    if (e.target.dataset.apIn === 'wecom') saveWecom(); else saveMail();
  });
  // 改发件邮箱时，服务器那一行跟着变
  panel.addEventListener('input', (e) => {
    if (!e.target.matches('[data-ap-in="user"]')) return;
    const el = panel.querySelector('[data-ap-host]');
    const [host, port] = presetOf(e.target.value.trim());
    if (el) el.textContent = host ? `${host}:${port}` : '按发件邮箱自动填写';
  });
}
export function showPanel() { render(); AH.shown(); }
