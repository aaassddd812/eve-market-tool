// ===== 击杀预警 =====
// 绑定 ESI 后可开启（默认关闭）：按角色当前所在星系（/location/，每 30 秒读一次），实时检测周边 N 跳（默认 3 跳，可设 1–10）内的击杀。
// 数据来源：
//   宁静服：击杀记录服务 /api/kb/live（R2Z2 实时收录，每 6 秒取一次），每条击杀都有 ID 与 hash；
//   晨曦 / 曙光：没有实时击杀源，只能用 ESI /universe/system_kills/（各星系过去 1 小时击杀数，约每小时更新）的增量判断，没有具体击杀邮件。
// 提醒方式：
//   游戏内邮件（默认开）：给自己发一封 EVE 邮件（esi-mail.send_mail.v1），带击杀报告链接 killReport:ID:HASH，游戏里点开即可看 KM；
//     同一分钟内的多条击杀合并成一封，两封之间至少隔 60 秒；同时开了多个标签页时只由一个标签页发送。
//   网页特效（默认关）：屏幕边缘红色闪烁 + 右上角预警卡片（点击查看击杀详情），可选提示音。
// 浏览器后台标签页的定时器会被降频（约每分钟一次），预警可能延迟。

import { SERVER, IS_TQ, serverKey, esiUrl } from './server.js?v=s3';

let ctx;   // esc, formatISK, showToast, esiAuthFetch, tokenInfo, hasScope, gateGraph, bfsJumps, resolveTypeNames, resolveNames, officialName, openKill, openEsiModal
const KEY = serverKey('eve-kill-alert-v1');
const DEFAULTS = { on: false, jumps: 3, mail: true, web: false, sound: false, pods: true };
const T = { ...DEFAULTS };
const S = {
  timerLoc: 0, timerKills: 0, system: 0, systemName: '', range: new Map(), status: '', cursor: null, busy: false,
  seen: new Set(), history: [], mailQueue: [], lastMail: 0, mailTimer: 0, snapshot: null, snapshotAt: '', charId: 0
};
const TAB = Math.random().toString(36).slice(2);
const LEADER_KEY = 'eve-kill-alert-leader';
const LOC_POLL = 30e3;
const LIVE_POLL = 6e3;
const NETEASE_POLL = 5 * 60e3;
const MAIL_GAP = 60e3;
const MAIL_SCOPE = 'esi-mail.send_mail.v1';
const LOC_SCOPE = 'esi-location.read_location.v1';
const subs = new Set();

function load() {
  try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 忽略 */ }
  T.jumps = Math.min(10, Math.max(1, Math.round(Number(T.jumps) || 3)));
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 忽略 */ } }

export const settings = () => T;
export const status = () => ({ on: T.on, text: S.status, system: S.systemName, count: S.range.size, history: S.history });
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } }
function setStatus(text) { S.status = text; notify(); }

export function initKillAlert(context) {
  ctx = context;
  load();
  window.addEventListener('eve-account-change', () => { S.system = 0; S.range = new Map(); S.charId = 0; restart(); });
  // 多个标签页：只有「领头」的标签页发游戏邮件，避免重复
  setInterval(claimLeader, 10e3);
  claimLeader();
  restart();
}

function claimLeader() {
  try {
    const cur = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null');
    if (!cur || cur.id === TAB || Date.now() - cur.at > 25e3) localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB, at: Date.now() }));
  } catch { /* 忽略 */ }
}
function isLeader() {
  try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null')?.id === TAB; } catch { return true; }
}

export function update(patch) {
  Object.assign(T, patch);
  T.jumps = Math.min(10, Math.max(1, Math.round(Number(T.jumps) || 3)));
  save();
  if ('jumps' in patch && S.system) computeRange(S.system);
  if ('on' in patch) restart();
  notify();
}

function stop() {
  clearInterval(S.timerLoc); clearInterval(S.timerKills);
  S.timerLoc = S.timerKills = 0;
}

export function restart() {
  stop();
  if (!T.on) { setStatus('预警未开启'); return; }
  const token = ctx.tokenInfo();
  if (!token) { setStatus('需要先绑定 ESI'); return; }
  if (!ctx.hasScope(LOC_SCOPE)) { setStatus('授权里没有位置权限（esi-location.read_location.v1），请重新绑定 ESI'); return; }
  S.cursor = null;
  S.snapshot = null;
  setStatus('正在读取角色位置…');
  pollLocation();
  S.timerLoc = setInterval(pollLocation, LOC_POLL);
  if (IS_TQ) { pollLive(); S.timerKills = setInterval(pollLive, LIVE_POLL); } else { pollSystemKills(); S.timerKills = setInterval(pollSystemKills, NETEASE_POLL); }
}

async function pollLocation() {
  const token = ctx.tokenInfo();
  if (!token || !T.on) return;
  try {
    const loc = await ctx.esiAuthFetch('/characters/' + token.character_id + '/location/');
    if (loc.solar_system_id !== S.system || token.character_id !== S.charId) {
      S.charId = token.character_id;
      await computeRange(loc.solar_system_id);
    }
  } catch (error) {
    setStatus('读取角色位置失败：' + error.message);
  }
}

async function computeRange(systemId) {
  const graph = await ctx.gateGraph();
  const dist = ctx.bfsJumps(graph, systemId);
  const range = new Map();
  dist.forEach((d, i) => { if (d >= 0 && d <= T.jumps) range.set(graph.systems[i][0], d); });
  S.system = systemId;
  S.range = range;
  const i = graph.index.get(systemId);
  S.systemName = i == null ? (ctx.officialName(systemId) || '星系 ' + systemId) : graph.systems[i][1];
  S.graph = graph;
  setStatus(i == null ? `角色在 ${S.systemName}（虫洞或无星门星系），只监控本星系` : `正在监控 ${S.systemName} 周边 ${T.jumps} 跳内 ${range.size} 个星系`);
  if (i == null) range.set(systemId, 0);
}

const sysName = (id) => {
  const i = S.graph?.index.get(id);
  return i == null ? ctx.officialName(id) || '星系 ' + id : S.graph.systems[i][1];
};

// ---------- 宁静服：实时击杀 ----------
async function pollLive() {
  if (S.busy || !T.on || !S.range.size) return;
  S.busy = true;
  try {
    const first = S.cursor == null;
    const res = await fetch('/api/kb/live?after=' + (first ? -1 : S.cursor) + (first ? '&initial=0' : ''));
    if (!res.ok) { if (res.status === 404) setStatus('没有部署击杀记录服务，宁静服无法实时预警'); return; }
    const data = await res.json();
    S.cursor = data.cursor;
    if (first) return;   // 第一次只取游标，不提醒旧击杀
    const hits = (data.kills || []).filter((k) => S.range.has(k.system_id) && !S.seen.has(k.id) && (T.pods || ![670, 33328].includes(k.ship_type_id)));
    if (!hits.length) return;
    hits.forEach((k) => S.seen.add(k.id));
    const types = await ctx.resolveTypeNames(hits.flatMap((k) => [k.ship_type_id, k.final?.ship_type_id])).catch(() => new Map());
    const names = data.names || {};
    for (const k of hits) {
      raise({
        id: k.id, hash: k.hash, system: k.system_id, jumps: S.range.get(k.system_id), time: k.time, value: k.value,
        ship: types.get(k.ship_type_id) || 'Type ' + k.ship_type_id,
        victim: names[k.victim?.character_id] || names[k.victim?.corporation_id] || ctx.officialName(k.victim?.corporation_id) || '',
        attackers: k.attackers, final: names[k.final?.character_id] || (k.final?.ship_type_id ? types.get(k.final.ship_type_id) : '') || ''
      });
    }
  } catch { /* 网络错误：下次再试 */ } finally { S.busy = false; }
}

// ---------- 晨曦 / 曙光：各星系过去 1 小时击杀数的增量 ----------
async function pollSystemKills() {
  if (!T.on) return;
  try {
    const res = await fetch(esiUrl('/universe/system_kills/'));
    if (!res.ok) return;
    const stamp = res.headers.get('last-modified') || '';
    const list = await res.json();
    const now = new Map(list.map((x) => [x.system_id, (x.ship_kills || 0) + (T.pods ? x.pod_kills || 0 : 0)]));
    const prev = S.snapshot;
    S.snapshot = now;
    if (!prev || stamp === S.snapshotAt) { S.snapshotAt = stamp; return; }
    S.snapshotAt = stamp;
    if (!S.range.size) return;
    for (const [sys, jumps] of S.range) {
      const added = (now.get(sys) || 0) - (prev.get(sys) || 0);
      if (added > 0 || (!prev.has(sys) && now.get(sys) > 0)) {
        raise({ id: 'sk-' + sys + '-' + stamp, system: sys, jumps, time: new Date().toISOString(), count: now.get(sys), added: Math.max(added, now.get(sys) || 0), hourly: true });
      }
    }
  } catch { /* 下次再试 */ }
}

// ---------- 提醒 ----------
function raise(a) {
  a.systemName = sysName(a.system);
  S.history.unshift({ ...a, at: Date.now() });
  S.history.length = Math.min(S.history.length, 30);
  notify();
  if (T.web) webAlert(a);
  if (T.mail) queueMail(a);
}

function describe(a) {
  if (a.hourly) return `${a.systemName}（${a.jumps} 跳）过去一小时新增击杀 ${a.added} 次`;
  return `${a.systemName}（${a.jumps} 跳）${a.victim ? a.victim + '的' : ''}${a.ship}被击毁`;
}

// 游戏内邮件：合并、限速，只由领头标签页发送
function queueMail(a) {
  if (!ctx.hasScope(MAIL_SCOPE)) return;
  S.mailQueue.push(a);
  if (S.mailTimer) return;
  const wait = Math.max(3e3, S.lastMail + MAIL_GAP - Date.now());
  S.mailTimer = setTimeout(flushMail, wait);
}

async function flushMail(force = false) {
  S.mailTimer = 0;
  const list = S.mailQueue.splice(0);
  if (!list.length || (!force && !isLeader())) return;
  const token = ctx.tokenInfo();
  if (!token) return;
  const first = list[0];
  const subject = list.length > 1 ? `击杀预警：附近 ${list.length} 起击杀（最近 ${Math.min(...list.map((x) => x.jumps))} 跳）` : `击杀预警：${describe(first)}`;
  const line = (a) => {
    const sys = `<a href="showinfo:5//${a.system}">${ctx.esc(a.systemName)}</a>`;
    if (a.hourly) return `${sys}（${a.jumps} 跳）：过去一小时新增击杀 ${a.added} 次（国服没有实时击杀邮件，数据来自 ESI 每小时统计）`;
    const km = a.hash ? ` · <a href="killReport:${a.id}:${a.hash}">查看击杀报告</a>` : '';
    return `${sys}（${a.jumps} 跳）：${ctx.esc(a.victim ? a.victim + '的' : '')}${ctx.esc(a.ship)}被击毁` +
      `${a.value ? '，价值 ' + ctx.formatISK(a.value) + ' ISK' : ''}${a.attackers ? '，' + a.attackers + ' 名攻击者' : ''}${a.final ? '（最后一击：' + ctx.esc(a.final) + '）' : ''}` +
      ` · ${new Date(a.time).toLocaleTimeString('zh-CN', { hour12: false })}${km}`;
  };
  const body = `<font size="14">击杀预警：你所在的 ${ctx.esc(S.systemName)} 周边 ${T.jumps} 跳内发生了击杀。</font><br><br>` +
    list.slice(0, 20).map(line).join('<br>') + (list.length > 20 ? `<br>……另有 ${list.length - 20} 起` : '') +
    `<br><br><font size="10" color="#ff888888">来自 EVE Market 击杀预警，可在网页右上角的铃铛里关闭或调整范围。</font>`;
  S.lastMail = Date.now();
  try {
    await ctx.esiAuthFetch('/characters/' + token.character_id + '/mail/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [{ recipient_id: token.character_id, recipient_type: 'character' }], subject: subject.slice(0, 100), body, approved_cost: 0 })
    });
  } catch (error) {
    console.warn('击杀预警邮件发送失败', error);
    S.lastMail = Date.now() + 60e3;   // 失败（多为发信频率限制）时多等一会
  }
}

// 网页特效：屏幕边缘闪烁 + 预警卡片 + 可选提示音
let layer = null;
function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'ka-layer';
  layer.innerHTML = '<div class="ka-flash"></div><div class="ka-cards" aria-live="assertive"></div>';
  document.body.appendChild(layer);
  layer.addEventListener('click', (e) => {
    const close = e.target.closest('[data-ka-close]');
    if (close) { close.closest('.ka-card')?.remove(); return; }
    const card = e.target.closest('[data-ka-kill]');
    if (card) { ctx.openKill(Number(card.dataset.kaKill)); card.remove(); }
  });
  return layer;
}

export function webAlert(a) {
  const el = ensureLayer();
  const flash = el.querySelector('.ka-flash');
  flash.classList.remove('on');
  void flash.offsetWidth;   // 重新触发动画
  flash.classList.add('on');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => flash.classList.remove('on'), 3200);
  const cards = el.querySelector('.ka-cards');
  const card = document.createElement('div');
  card.className = 'ka-card' + (a.jumps === 0 ? ' here' : '');
  if (a.id && !a.hourly && !a.test) card.dataset.kaKill = a.id;
  card.innerHTML = `<div class="ka-head"><span class="ka-badge">${a.jumps === 0 ? '本星系' : a.jumps + ' 跳'}</span><b>击杀预警</b>
      <button class="ka-close" data-ka-close aria-label="关闭">×</button></div>
    <div class="ka-body">${ctx.esc(describe(a))}</div>
    <div class="ka-meta">${a.value ? ctx.formatISK(a.value) + ' ISK · ' : ''}${a.attackers ? a.attackers + ' 名攻击者 · ' : ''}${new Date(a.time).toLocaleTimeString('zh-CN', { hour12: false })}${a.id && !a.hourly && !a.test ? ' · 点击查看击杀详情' : ''}</div>`;
  cards.prepend(card);
  while (cards.children.length > 4) cards.lastChild.remove();
  setTimeout(() => card.remove(), 45e3);
  if (T.sound) beep(a.jumps === 0);
}

function beep(urgent) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const tones = urgent ? [880, 660, 880, 660] : [880, 660];
    tones.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + i * 0.18); o.stop(ac.currentTime + i * 0.18 + 0.17);
    });
    setTimeout(() => ac.close(), 1500);
  } catch { /* 浏览器不允许自动播放时忽略 */ }
}

// 测试：网页特效 / 游戏内邮件
export function test(kind) {
  const a = { id: 0, test: true, system: S.system || 30000142, jumps: 2, time: new Date().toISOString(), ship: '金鹏级（测试）', victim: '测试飞行员', value: 432000000, attackers: 8 };
  a.systemName = S.systemName || sysName(a.system);
  if (kind === 'web') { webAlert(a); return; }
  if (kind === 'mail') {
    if (!ctx.hasScope(MAIL_SCOPE)) { ctx.showToast('授权里没有发送邮件权限（esi-mail.send_mail.v1），请重新绑定 ESI', 'error', 4000); return; }
    S.lastMail = 0;
    S.mailQueue.push(a);
    flushMail(true).then(() => ctx.showToast('测试邮件已发送，请在游戏邮箱查看', 'success'));
  }
}

// ---------- 设置面板（右上角铃铛）----------
let panel = null;
const sw = (key, label, desc) => `<label class="ka-opt"><input type="checkbox" data-ka-set="${key}"${T[key] ? ' checked' : ''}><span><b>${label}</b><small>${desc}</small></span></label>`;
function renderPanel() {
  if (!panel || panel.hidden) return;
  const token = ctx.tokenInfo();
  const st = status();
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  panel.querySelector('#kaBody').innerHTML = `
    ${token ? '' : '<p class="ka-warn">需要先在「个人中心」绑定 ESI，按角色所在位置检测周边击杀。</p>'}
    ${sw('on', '开启击杀预警', '按角色当前所在星系，实时检测周边星系的击杀（默认关闭）')}
    <label class="ka-opt ka-range"><span><b>检测范围</b><small>角色所在星系周边多少跳以内（1–10，默认 3）</small></span>
      <input type="number" class="cr-input" min="1" max="10" step="1" value="${T.jumps}" data-ka-jumps aria-label="检测范围（跳）"> 跳</label>
    ${sw('mail', '游戏内邮件提醒', '给自己发 EVE 邮件，附击杀报告链接，游戏里点开即可看 KM（每分钟最多一封，多条合并）')}
    ${sw('web', '网页醒目特效', '屏幕边缘红色闪烁 + 右上角预警卡片（默认关闭）')}
    ${sw('sound', '提示音', '网页特效时同时播放提示音')}
    ${sw('pods', '包括太空舱', '太空舱被击毁也提醒')}
    <p class="ka-status${st.on ? ' on' : ''}">${ctx.esc(st.text)}</p>
    ${IS_TQ ? '' : `<p class="ka-note">${ctx.esc(SERVER.full)}没有实时击杀数据，只能用 ESI 各星系「过去一小时击杀数」的增量判断（约每小时更新一次），提醒会有延迟，也没有具体的击杀邮件。</p>`}
    <div class="ka-actions"><button class="btn btn-ghost" data-ka-test="web">测试网页特效</button><button class="btn btn-ghost" data-ka-test="mail"${token ? '' : ' disabled'}>发送测试邮件</button></div>
    <h4 class="ka-h">最近预警</h4>
    ${st.history.length ? `<ul class="ka-history">${st.history.map((a) => `<li${a.id && !a.hourly ? ` data-ka-open="${a.id}"` : ''}><span class="ka-badge">${a.jumps === 0 ? '本星系' : a.jumps + ' 跳'}</span><span>${ctx.esc(describe(a))}</span><small>${ago(a.at)}</small></li>`).join('')}</ul>` : '<p class="text-muted">还没有预警</p>'}
    <p class="ka-note">网页需要保持打开（可以在后台标签页，但浏览器会降低后台页面的检测频率）。多个标签页同时打开时只发一封邮件。</p>`;
}

export function openPanel() {
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'modal';
    panel.id = 'killAlertModal';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = `<div class="modal-backdrop" data-ka-dismiss></div><div class="modal-content ka-modal">
      <div class="modal-header"><h3>击杀预警</h3><button class="modal-close" data-ka-dismiss aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="kaBody"></div></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-ka-dismiss]')) { panel.hidden = true; return; }
      const t = e.target.closest('[data-ka-test]');
      if (t) { test(t.dataset.kaTest); return; }
      const open = e.target.closest('[data-ka-open]');
      if (open) { panel.hidden = true; ctx.openKill(Number(open.dataset.kaOpen)); }
    });
    panel.addEventListener('change', (e) => {
      const set = e.target.closest('[data-ka-set]');
      if (set) {
        if (set.dataset.kaSet === 'on' && set.checked && !ctx.tokenInfo()) { set.checked = false; panel.hidden = true; ctx.openEsiBind(); return; }
        update({ [set.dataset.kaSet]: set.checked });
        return;
      }
      if (e.target.matches('[data-ka-jumps]')) update({ jumps: Number(e.target.value) });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel && !panel.hidden) { e.stopImmediatePropagation(); panel.hidden = true; } }, true);
    onChange(renderPanel);
  }
  panel.hidden = false;
  renderPanel();
}
