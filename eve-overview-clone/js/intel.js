// ===== 本地日志（右上角铃铛「预警」弹窗的第二个标签页）：敌情频道预警、频道关键词监控、游戏日志监控 =====
// 默认关闭。用户主动选择 EVE 日志文件夹（Documents\EVE\logs）后，浏览器用 File System Access API 只读地读取聊天记录（Chatlogs）与游戏日志（Gamelogs）：
//   文件只在本机浏览器里读取，不会上传；只有电脑版 Chrome / Edge（86 以上）等 Chromium 浏览器支持，Firefox、Safari 和手机浏览器不支持。
//   文件夹授权保存在本浏览器（IndexedDB），下次打开网页时浏览器可能要求再点一次「恢复监听」重新授权。
// 敌情频道：勾选的频道里有人报星系名 → 判断与我的距离（星门跳数）→ 在范围内时提示音 / 网页卡片 / 系统通知，星图上标红；
//   消息里含「clr / clear / 干净」等字样算报平安（星图标绿）。星系名同时认当前界面语言与英文名（ESI 取英文名，缓存在本地）。
// 我的位置：绑定 ESI 且有位置权限时读角色位置；否则读本地频道日志里「Channel changed to Local」一行；都没有时用手动填的星系。
// 关键词监控：勾选的频道（或全部频道）里出现关键词（/正则/ 也可以）就提醒。游戏日志监控：战斗日志等出现关键词就提醒（例如被跃迁扰断）。
// 提醒方式：提示音、网页卡片、系统通知、游戏内邮件（与击杀预警共用收件人与发信间隔，alert-mail.js；一段时间里的提醒合并成一封，
//   多个标签页都在监听时按消息去重，只发一次；收件人在「邮件」标签页设置，这里勾选发给谁；英文界面发英文邮件）。设置面板是右上角铃铛「预警」弹窗的「本地日志」标签页（alert-center.js）。
// 文件编码：聊天记录是 UTF-16 LE（带 BOM），游戏日志是 UTF-8；按 BOM 判断。文件名「频道名_YYYYMMDD_HHMMSS_角色ID.txt」。

import * as AM from './alert-mail.js?v=v6';

let ctx;   // esc, showToast, gateGraph, bfsJumps, esiAuthFetch, tokenInfo, hasScope, esiUrl, openMapSystem
const KEY = 'eve-intel-v1';
const DEFAULTS = {
  on: false, channels: [], jumps: 5, sound: true, notify: false, web: true, mail: false, expire: 10, home: '', useLoc: true,
  clearWords: 'clr clear 干净 安全 没人', kwOn: false, keywords: [], kwAll: false, gameOn: false, gameWords: []
};
const T = { ...DEFAULTS };
const S = {
  dir: null, chat: null, game: null, perm: 'none', status: '', timer: 0, scanTimer: 0, locTimer: 0,
  files: new Map(), channels: new Map(), reports: [], marks: new Map(), names: null, seen: new Set(),
  graph: null, dist: null, here: null, hereFrom: '', localHere: new Map(), busy: false, lastAlert: 0, alertTimer: 0, mailQueue: [], mailTimer: 0
};
const LOC_SCOPE = 'esi-location.read_location.v1';
const POLL = 2000, SCAN = 20000, LOC_POLL = 30000;
const LOCAL_NAMES = ['local', '本地'];
const subs = new Set();
export const supported = () => typeof window.showDirectoryPicker === 'function';
export const settings = () => T;
export function onChange(fn) { subs.add(fn); }
function notify() { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } renderPanel(); }
function load() { try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 忽略 */ } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 忽略 */ } }
function setStatus(t) { S.status = t; notify(); }
export const status = () => ({ on: T.on && S.timer !== 0, mail: T.mail, alert: Date.now() - S.lastAlert < 60e3, text: S.status || (T.on ? '' : '本地日志监听未开启') });

// ---------- IndexedDB：保存文件夹句柄 ----------
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('eve-intel', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { resolve(req?.result); open.result.close(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const idbGet = (k) => idb('readonly', (st) => st.get(k)).catch(() => null);
const idbSet = (k, v) => idb('readwrite', (st) => st.put(v, k)).catch(() => null);

// ---------- 初始化 ----------
export async function initIntel(context) {
  ctx = context;
  load();
  AM.initAlertMail(ctx);
  AM.onMailChange(renderPanel);
  AM.registerSource('intel', { label: '本地日志', on: () => T.mail, set: (on) => update({ mail: on }) });
  if (!supported()) return;
  S.dir = await idbGet('dir');
  if (T.on && S.dir) resume(false);
}

async function resolveDirs(dir) {
  S.dir = dir;
  S.chat = S.game = null;
  const lname = dir.name.toLowerCase();
  if (lname === 'chatlogs') S.chat = dir;
  else if (lname === 'gamelogs') S.game = dir;
  else {
    try { S.chat = await dir.getDirectoryHandle('Chatlogs'); } catch { /* 没有 */ }
    try { S.game = await dir.getDirectoryHandle('Gamelogs'); } catch { /* 没有 */ }
  }
}

async function pickFolder() {
  if (!supported()) return;
  try {
    const dir = await window.showDirectoryPicker({ id: 'eve-logs', mode: 'read', startIn: 'documents' });
    await resolveDirs(dir);
    if (!S.chat && !S.game) { ctx.showToast('这个文件夹里没有 Chatlogs / Gamelogs，请选择 Documents\\EVE\\logs', 'error', 5000); return; }
    await idbSet('dir', dir);
    S.perm = 'granted';
    S.files.clear();
    await scan(true);
    if (!T.on) update({ on: true }); else start();
    ctx.showToast('已选择日志文件夹：' + dir.name, 'success');
  } catch (e) {
    if (e.name !== 'AbortError') ctx.showToast('选择文件夹失败：' + e.message, 'error');
  }
}

// 恢复监听：需要用户点击才能弹出授权（gesture = true）
async function resume(gesture) {
  if (!S.dir) { setStatus('还没有选择日志文件夹'); return; }
  let perm = await S.dir.queryPermission({ mode: 'read' }).catch(() => 'denied');
  if (perm !== 'granted' && gesture) perm = await S.dir.requestPermission({ mode: 'read' }).catch(() => 'denied');
  S.perm = perm;
  if (perm !== 'granted') { setStatus('浏览器需要重新授权读取日志文件夹：点「恢复监听」'); return; }
  await resolveDirs(S.dir);
  await scan(true);
  start();
}

function stop() {
  clearInterval(S.timer); clearInterval(S.scanTimer); clearInterval(S.locTimer);
  S.timer = S.scanTimer = S.locTimer = 0;
}
function start() {
  stop();
  if (!T.on || S.perm !== 'granted') { notify(); return; }
  S.timer = setInterval(poll, POLL);
  S.scanTimer = setInterval(() => scan(false), SCAN);
  pollLocation();
  S.locTimer = setInterval(pollLocation, LOC_POLL);
  setStatus(`正在监听 ${trackedText()}`);
}
function trackedText() {
  const chans = new Set([...S.files.values()].filter((f) => f.kind === 'chat' && !f.local).map((f) => f.channel));
  const games = [...S.files.values()].filter((f) => f.kind === 'game').length;
  return [chans.size ? `${chans.size} 个频道` : '', games ? `${games} 个游戏日志` : ''].filter(Boolean).join('、') || '（没有勾选频道）';
}

export function update(patch) {
  Object.assign(T, patch);
  T.jumps = Math.min(20, Math.max(0, Math.round(Number(T.jumps) || 0)));
  save();
  if ('on' in patch) { if (T.on) resume(false); else { stop(); setStatus('本地日志监听未开启'); } }
  else if ('channels' in patch || 'kwAll' in patch || 'gameOn' in patch || 'kwOn' in patch) scan(false);
  if ('home' in patch || 'useLoc' in patch) pollLocation();
  notify();
  if ('mail' in patch) AM.refresh();
}

// ---------- 扫描文件夹：每个频道（每个角色）只读最新的文件 ----------
const CHAT_RE = /^(.+?)_(\d{8})_(\d{6})(?:_(\d+))?\.txt$/;
const GAME_RE = /^(\d{8})_(\d{6})(?:_(\d+))?\.txt$/;
const isLocal = (ch) => LOCAL_NAMES.includes(ch.toLowerCase());
const stamp = (d, t) => Number(d + t);

async function scan(first) {
  if (S.busy || S.perm !== 'granted') return;
  S.busy = true;
  try {
    const recent = Number(dateKey(Date.now() - 7 * 86400e3));
    const newest = new Map();   // key -> { handle, channel, st, listener, kind }
    if (S.chat) {
      S.channels.clear();
      for await (const [name, h] of S.chat.entries()) {
        if (h.kind !== 'file') continue;
        const m = CHAT_RE.exec(name);
        if (!m || Number(m[2]) < recent) continue;
        const channel = m[1], st = stamp(m[2], m[3]);
        S.channels.set(channel, Math.max(S.channels.get(channel) || 0, st));
        const want = isLocal(channel) || T.channels.includes(channel) || (T.kwOn && T.kwAll && Number(m[2]) >= Number(dateKey(Date.now() - 2 * 86400e3)));
        if (!want) continue;
        const key = 'c:' + channel + ':' + (m[4] || '');
        if (!newest.has(key) || newest.get(key).st < st) newest.set(key, { handle: h, channel, st, listener: m[4] || '', kind: 'chat', local: isLocal(channel) });
      }
    }
    if (S.game && T.gameOn && T.gameWords.length) {
      for await (const [name, h] of S.game.entries()) {
        if (h.kind !== 'file') continue;
        const m = GAME_RE.exec(name);
        if (!m || Number(m[1]) < recent) continue;
        const key = 'g:' + (m[3] || '');
        const st = stamp(m[1], m[2]);
        if (!newest.has(key) || newest.get(key).st < st) newest.set(key, { handle: h, channel: '游戏日志', st, listener: m[3] || '', kind: 'game' });
      }
    }
    for (const [key, f] of newest) {
      const cur = S.files.get(key);
      if (cur && cur.st === f.st) continue;
      const file = await f.handle.getFile();
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      const utf16 = head[0] === 0xff && head[1] === 0xfe;
      // 新发现的文件：本地频道从头读（找当前星系），其他从末尾开始（只看新消息）；换了新文件（重新登录）则从头读
      const fromStart = f.local || (cur && !first);
      S.files.set(key, { ...f, utf16, offset: fromStart ? (utf16 ? 2 : 0) : file.size, rest: '' });
    }
    for (const key of [...S.files.keys()]) if (!newest.has(key)) S.files.delete(key);
    if (T.on && S.timer) S.status = `正在监听 ${trackedText()}`;
    notify();
  } catch (e) {
    setStatus('读取日志文件夹失败：' + e.message);
  } finally {
    S.busy = false;
  }
}
function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------- 读新内容 ----------
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const f of S.files.values()) {
      const file = await f.handle.getFile().catch(() => null);
      if (!file || file.size <= f.offset) continue;
      let end = file.size;
      if (f.utf16 && (end - f.offset) % 2) end--;
      const buf = await file.slice(f.offset, end).arrayBuffer();
      f.offset = end;
      const text = f.rest + new TextDecoder(f.utf16 ? 'utf-16le' : 'utf-8').decode(buf);
      const lines = text.split(/\r?\n/);
      f.rest = lines.pop();
      for (const line of lines) await handleLine(f, line);
    }
  } catch (e) {
    if (e.name === 'NotAllowedError') { S.perm = 'prompt'; stop(); setStatus('浏览器收回了读取权限：点「恢复监听」'); }
  } finally {
    polling = false;
  }
}

const LINE_RE = /^﻿?\s*\[\s*(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2})\s*\]\s*(.*?)\s+>\s+(.*)$/;
const GAME_LINE_RE = /^\s*\[\s*(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2})\s*\]\s*(?:\((\w+)\)\s*)?(.*)$/;
const evetime = (s) => new Date(s.replace(/\./g, '-').replace(' ', 'T') + 'Z');

async function handleLine(f, line) {
  if (f.kind === 'game') {
    const m = GAME_LINE_RE.exec(line);
    if (!m) return;
    const msg = m[3].replace(/<[^>]+>/g, '').trim();
    const kw = matchWords(msg, T.gameWords);
    if (kw) raise({ type: 'game', time: evetime(m[1]), channel: '游戏日志' + (m[2] ? ' · ' + m[2] : ''), who: '', msg, kw });
    return;
  }
  const m = LINE_RE.exec(line);
  if (!m) return;
  const [, ts, who, msg] = m;
  const time = evetime(ts);
  if (f.local) {
    if (/^EVE\s*(System|系统)$/i.test(who) || who === 'EVE 系统') {
      await ensureNames().catch(() => {});
      const sys = msg.split(/[:：]/).pop().replace(/\*+$/, '').trim();
      const id = systemId(sys);
      if (id) { S.localHere.set(f.listener, { id, at: time }); if (S.hereFrom !== 'esi') pollLocation(); }
    }
    return;
  }
  if (Date.now() - time > 10 * 60e3) return;   // 太旧的消息（例如重新读文件）不提醒
  const sig = ts + '|' + who + '|' + msg;
  if (S.seen.has(sig)) return;   // 多个角色在同一频道：同一句话只处理一次
  S.seen.add(sig);
  if (S.seen.size > 5000) S.seen = new Set([...S.seen].slice(-2000));
  if (T.channels.includes(f.channel)) intel(f.channel, who, msg, time);
  if (T.kwOn && T.keywords.length && (T.kwAll || T.channels.includes(f.channel))) {
    const kw = matchWords(msg, T.keywords);
    if (kw) raise({ type: 'kw', time, channel: f.channel, who, msg, kw });
  }
}

function matchWords(msg, words) {
  for (const w of words) {
    if (!w) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(w);
    if (re) { try { if (new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i').test(msg)) return w; } catch { /* 无效正则 */ } continue; }
    if (msg.toLowerCase().includes(w.toLowerCase())) return w;
  }
  return null;
}

// ---------- 星系名 ----------
async function ensureNames() {
  if (S.names) return S.names;
  const graph = S.graph || (S.graph = await ctx.gateGraph());
  const byName = new Map(), cjk = [];
  for (const sys of graph.systems) {
    byName.set(String(sys[1]).toLowerCase(), sys[0]);
    if (/[一-鿿]/.test(sys[1])) cjk.push([sys[1], sys[0]]);
  }
  // 英文名：ESI /universe/names/（每次最多 1000 个），缓存到本地
  let en = null;
  try { en = JSON.parse(localStorage.getItem('eve-intel-en-names') || 'null'); } catch { /* 忽略 */ }
  if (!en || en.n !== graph.systems.length) {
    en = { n: graph.systems.length, list: [] };
    const ids = graph.systems.map((s) => s[0]);
    try {
      for (let i = 0; i < ids.length; i += 1000) {
        const res = await fetch(ctx.esiUrl('/universe/names/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids.slice(i, i + 1000)) });
        if (!res.ok) throw new Error('ESI ' + res.status);
        for (const x of await res.json()) en.list.push([x.id, x.name]);
      }
      try { localStorage.setItem('eve-intel-en-names', JSON.stringify(en)); } catch { /* 存不下就每次取 */ }
    } catch { en = null; }
  }
  for (const [id, name] of en?.list || []) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), id);
  cjk.sort((a, b) => b[0].length - a[0].length);
  S.names = { byName, cjk, prefix: [...byName.keys()].filter((n) => /[\d-]/.test(n)) };
  return S.names;
}
function systemId(text) {
  const key = String(text || '').trim().toLowerCase();
  return S.names?.byName.get(key) || null;
}
function sysName(id) {
  const i = S.graph?.index.get(id);
  return i == null ? String(id) : S.graph.systems[i][1];
}

// 消息里的星系：英文 / 编号按词匹配（含两三个词的名字与编号前缀，如「1DQ」→ 1DQ1-A，唯一时才算），中文名按子串匹配
function findSystems(msg) {
  const N = S.names;
  const found = new Set();
  const words = msg.split(/[\s,，。;；!！?？()（）[\]【】"“”'*]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 3; n >= 1; n--) {
      if (i + n > words.length) continue;
      const id = N.byName.get(words.slice(i, i + n).join(' ').toLowerCase());
      if (id) { found.add(id); i += n - 1; break; }
      if (n === 1) {
        const w = words[i].toLowerCase();
        if (w.length >= 3 && /\d/.test(w) && /^[a-z0-9-]+$/.test(w)) {
          const hits = N.prefix.filter((x) => x.startsWith(w));
          if (hits.length === 1) found.add(N.byName.get(hits[0]));
        }
      }
    }
  }
  if (/[一-鿿]/.test(msg)) {
    let rest = msg;
    for (const [name, id] of N.cjk) if (rest.includes(name)) { found.add(id); rest = rest.split(name).join(' '); }
  }
  return [...found];
}

// ---------- 我的位置 ----------
async function pollLocation() {
  let id = null, from = '';
  const token = ctx.tokenInfo();
  if (T.useLoc && token && ctx.hasScope(LOC_SCOPE)) {
    try { id = (await ctx.esiAuthFetch('/characters/' + token.character_id + '/location/')).solar_system_id; from = 'esi'; } catch { /* 用其他方式 */ }
  }
  if (!id && T.useLoc && S.localHere.size) {
    const last = [...S.localHere.values()].sort((a, b) => b.at - a.at)[0];
    id = last.id; from = 'local';
  }
  if (!id && T.home) { await ensureNames().catch(() => {}); id = systemId(T.home); from = id ? 'manual' : ''; }
  if (id !== S.here) {
    S.here = id;
    S.graph = S.graph || await ctx.gateGraph();
    S.dist = id ? ctx.bfsJumps(S.graph, id) : null;
    for (const r of S.reports) r.jumps = jumpsTo(r.system);
  }
  S.hereFrom = from;
  notify();
}
function jumpsTo(id) {
  const i = S.graph?.index.get(id);
  if (i == null || !S.dist) return null;
  return S.dist[i] >= 0 ? S.dist[i] : null;
}

// ---------- 敌情 ----------
async function intel(channel, who, msg, time) {
  await ensureNames();
  const systems = findSystems(msg);
  if (!systems.length) return;
  const clear = matchWords(msg, T.clearWords.split(/\s+/));
  for (const id of systems) {
    const r = { type: 'intel', time, channel, who, msg, system: id, name: sysName(id), clear: Boolean(clear), jumps: jumpsTo(id), at: Date.now() };
    S.marks.set(id, { clear: r.clear, at: r.at });
    if (!r.clear && (S.here == null || (r.jumps != null && r.jumps <= T.jumps))) raise(r);
    else pushReport(r);
  }
  publishMarks();
}
function pushReport(r) {
  S.reports.unshift(r);
  S.reports.length = Math.min(S.reports.length, 60);
  notify();
}
function publishMarks() {
  const ttl = T.expire * 60e3, now = Date.now();
  for (const [id, m] of S.marks) if (now - m.at > ttl) S.marks.delete(id);
  window.dispatchEvent(new CustomEvent('eve-intel-marks', { detail: new Map(S.marks) }));
}
setInterval(() => { if (S.marks.size) publishMarks(); }, 30e3);

function raise(r) {
  r.at = r.at || Date.now();
  r.alert = true;
  pushReport(r);
  S.lastAlert = Date.now();
  clearTimeout(S.alertTimer);
  S.alertTimer = setTimeout(notify, 61e3);
  const title = titleOf(r);
  const body = (r.who ? r.who + '：' : '') + r.msg;
  if (T.mail && !r.test) queueMail(r);
  if (T.sound) beep(r.type === 'intel' ? (r.jumps ?? 9) : 5);
  if (T.web) card(title, body, r);
  if (T.notify && window.Notification?.permission === 'granted') {
    try { const n = new Notification(title, { body: r.channel + ' · ' + body, tag: 'eve-intel-' + (r.system || r.kw), renotify: true }); n.onclick = () => { window.focus(); if (r.system) ctx.openMapSystem(r.system); }; } catch { /* 忽略 */ }
  }
}

const titleOf = (r) => (r.type === 'intel' ? `敌情：${r.name}${r.jumps != null ? `（${r.jumps === 0 ? '本星系' : r.jumps + ' 跳'}）` : ''}` : r.type === 'kw' ? `关键词「${r.kw}」` : `游戏日志「${r.kw}」`);

// 游戏内邮件：等到可以发信时把这段时间的提醒合并成一封
function queueMail(r) {
  if (!AM.canMail() || !claimMail(r)) return;
  S.mailQueue.push(r);
  if (!S.mailTimer) S.mailTimer = setTimeout(flushMail, AM.nextSlot());
}
// 多个标签页都在读同一份日志时，同一条消息只由先读到的那个发（localStorage 记 5 分钟）
function claimMail(r) {
  const sig = [r.type, r.channel, r.who, r.msg, +r.time].join('|');
  try {
    const k = 'eve-intel-mailed', now = Date.now();
    const m = JSON.parse(localStorage.getItem(k) || '{}');
    for (const [x, t] of Object.entries(m)) if (now - t > 300e3) delete m[x];
    if (m[sig]) return false;
    m[sig] = now;
    localStorage.setItem(k, JSON.stringify(m));
  } catch { /* 无痕模式：照发 */ }
  return true;
}
async function flushMail() {
  S.mailTimer = 0;
  const list = S.mailQueue.splice(0);
  if (!list.length) return null;
  const esc = ctx.esc;
  const en = AM.EN;   // 英文界面发英文邮件
  const intelN = list.filter((r) => r.type === 'intel').length;
  const jumps = (n) => (en ? (n === 0 ? 'same system' : n === 1 ? '1 jump' : n + ' jumps') : n === 0 ? '本星系' : n + ' 跳');
  const title = (r) => (r.type === 'intel' ? (en ? `Intel: ${r.name}${r.jumps != null ? ` (${jumps(r.jumps)})` : ''}` : titleOf(r))
    : en ? (r.type === 'kw' ? `Keyword "${r.kw}"` : `Game log "${r.kw}"`) : titleOf(r));
  const subject = list.length === 1 ? AM.L('本地日志 · ', 'Local logs · ') + title(list[0])
    : en ? `Local logs: ${list.length} alerts${intelN ? ` (${intelN} intel)` : ''}` : `本地日志：${list.length} 条提醒${intelN ? `（敌情 ${intelN} 条）` : ''}`;
  const line = (r) => {
    const sys = r.system ? `<a href="showinfo:5//${r.system}">${esc(r.name)}</a>${r.jumps != null ? (en ? ` (${jumps(r.jumps)})` : `（${jumps(r.jumps)}）`) : ''}${en ? ': ' : '：'}` : '';
    const tag = en ? (r.type === 'intel' ? '[Intel] ' : r.type === 'kw' ? `[Keyword "${esc(r.kw)}"] ` : `[Game log "${esc(r.kw)}"] `)
      : r.type === 'intel' ? '【敌情】' : r.type === 'kw' ? `【关键词「${esc(r.kw)}」】` : `【游戏日志「${esc(r.kw)}」】`;
    return `${tag}${sys}${esc((r.who ? r.who + (en ? ': ' : '：') : '') + r.msg)} · ${esc(r.channel)} · ${r.time.toLocaleTimeString(en ? 'en-GB' : 'zh-CN', { hour12: false })}`;
  };
  const who = AM.ownerWord('intel');
  const here = S.here ? `<a href="showinfo:5//${S.here}">${esc(sysName(S.here))}</a>` : '';
  const intro = en ? `Local logs: new alerts from the channels / game logs ${who === 'you' ? 'you are' : who + ' is'} watching${here ? ` (${who === 'you' ? 'you are' : who + ' is'} in ${here})` : ''}.`
    : `本地日志：${who}监听的频道 / 游戏日志有新的提醒${here ? `（${who}在 ${here}）` : ''}。`;
  const body = `<font size="14">${intro}</font><br><br>` +
    list.slice(0, 20).map(line).join('<br>') + (list.length > 20 ? `<br>${en ? `…and ${list.length - 20} more` : `……另有 ${list.length - 20} 条`}` : '') +
    `<br><br><font size="10" color="#ff888888">${AM.L('来自 EVE Market 本地日志，可在网页右上角的铃铛里关闭。', 'Sent by EVE Market local log alerts. Turn it off from the bell icon at the top right of the site.')}</font>`;
  return AM.sendMail('intel', subject, body);
}

function beep(jumps) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const n = jumps <= 1 ? 4 : jumps <= 3 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sawtooth'; o.frequency.value = i % 2 ? 520 : 780;
      const t0 = ac.currentTime + i * 0.2;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + 0.19);
    }
    setTimeout(() => ac.close(), 1500);
  } catch { /* 浏览器不允许自动播放 */ }
}

let layer = null;
function card(title, body, r) {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'ka-layer';
    layer.innerHTML = '<div class="ka-cards intel-cards" aria-live="assertive"></div>';
    document.body.appendChild(layer);
    layer.addEventListener('click', (e) => {
      const c = e.target.closest('.ka-card');
      if (!c) return;
      if (!e.target.closest('[data-ka-close]') && c.dataset.sys) ctx.openMapSystem(Number(c.dataset.sys));
      c.remove();
    });
  }
  const box = layer.querySelector('.ka-cards');
  const el = document.createElement('div');
  el.className = 'ka-card intel-card' + (r.jumps === 0 ? ' here' : '');
  if (r.system) el.dataset.sys = r.system;
  el.innerHTML = `<div class="ka-head"><span class="ka-badge">${r.type === 'intel' ? '敌情' : r.type === 'kw' ? '关键词' : '日志'}</span><b>${ctx.esc(title)}</b><button class="ka-close" data-ka-close aria-label="关闭">×</button></div>
    <div class="ka-body">${ctx.esc(body)}</div><div class="ka-meta">${ctx.esc(r.channel)} · ${r.time.toLocaleTimeString('zh-CN', { hour12: false })}${r.system ? ' · 点击在星图查看' : ''}</div>`;
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.remove(), 30e3);
}

// ---------- 面板（「预警」弹窗的「本地日志」标签页）----------
let panel = null;      // 标签页容器
let shell = null;      // { close, isOpen }：弹窗由 alert-center.js 管
// 设置行：左边名称（可带一行短说明），右边开关；详细说明放在悬停提示里
const sw = (key, label, sub = '', tip = '') => `<label class="ka-opt"${tip ? ` title="${tip}"` : ''}><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="ka-switch" data-in-set="${key}"${T[key] ? ' checked' : ''}></label>`;
const sec = (title, body) => `<section class="ka-sec"><h4 class="ka-h">${title}</h4>${body}</section>`;
const wordList = (key, ph) => `<div class="ka-opt ka-stack"><div class="ka-watch-add"><input type="text" class="cr-input" data-in-word="${key}" data-keep="w-${key}" placeholder="${ph}" autocomplete="off" spellcheck="false"><button class="btn btn-primary btn-sm" data-in-wadd="${key}">添加</button></div>
  ${T[key].length ? `<div class="ka-chips">${T[key].map((w, i) => `<span class="ka-chip">${ctx.esc(w)}<button class="ka-close" data-in-wdel="${key}:${i}" aria-label="移除">×</button></span>`).join('')}</div>` : ''}</div>`;

function renderPanel() {
  if (!panel || !shell.isOpen(panel)) return;
  const body = panel;
  // 重绘时保留正在输入的文字、焦点与滚动位置
  const keep = [...body.querySelectorAll('input[data-keep]')].map((el) => [el.dataset.keep, el.value, document.activeElement === el]);
  const sc = panel.closest('.modal-body') || panel;
  const top = sc.scrollTop;
  body.innerHTML = drawPanel();
  for (const [k, v, focus] of keep) {
    const el = body.querySelector(`input[data-keep="${k}"]`);
    if (!el) continue;
    el.value = v;
    if (focus) { el.focus(); el.setSelectionRange(v.length, v.length); }
  }
  sc.scrollTop = top;
}

function drawPanel() {
  if (!supported()) {
    return `<p class="ka-warn">当前浏览器不支持读取本地文件夹。请用<b>电脑版 Chrome 或 Edge（86 以上）</b>打开本站；Firefox、Safari 和手机浏览器都不支持。</p>
      <p class="ka-note">这个功能读取游戏写在电脑上的聊天记录与游戏日志（Documents\\EVE\\logs），实现敌情频道预警、频道关键词与游戏日志提醒。</p>`;
  }
  const chans = [...S.channels.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).filter((c) => !isLocal(c));
  for (const c of T.channels) if (!chans.includes(c)) chans.push(c);
  const here = S.here ? `${sysName(S.here)}（${{ esi: 'ESI 角色位置', local: '本地频道日志', manual: '手动设置' }[S.hereFrom] || ''}）` : '未知（所有敌情都提醒）';
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m + ' 分钟前'; };
  return `
    <div class="ka-top"><span class="ka-status${status().on ? ' on' : ''}"><i></i>${ctx.esc(status().text)}</span></div>
    <p class="ka-note">读取本机的游戏聊天记录与日志，文件不会上传；需要电脑版 Chrome 或 Edge。</p>
    ${sec('日志文件夹', `<div class="ka-list">
      <div class="ka-opt"><span><b>${S.dir ? ctx.esc(S.dir.name) : '未选择'}</b><small>${S.dir ? `聊天记录 ${S.chat ? '✓' : '✗'} · 游戏日志 ${S.game ? '✓' : '✗'}` : `选 <code>${window.I18N?.lang === 'en' ? 'Documents' : '文档'}\\EVE\\logs</code>`}</small></span>
        <span class="ka-ctl">${S.dir && S.perm !== 'granted' ? '<button class="btn btn-ghost btn-sm" data-in-resume>恢复监听</button>' : ''}<button class="btn btn-primary btn-sm" data-in-pick>${S.dir ? '重新选择' : '选择文件夹'}</button></span></div>
      ${sw('on', '开启本地日志监听')}
    </div>`)}
    ${sec('敌情频道', `<div class="ka-list">
      <div class="ka-opt ka-stack"><div class="intel-chans">${chans.length ? chans.map((c) => `<label class="ka-chip toggle${T.channels.includes(c) ? ' on' : ''}"><input type="checkbox" data-in-chan="${ctx.esc(c)}"${T.channels.includes(c) ? ' checked' : ''} hidden>${ctx.esc(c)}</label>`).join('')
        : `<span class="ka-empty">${S.dir ? '最近 7 天没有聊天记录（游戏设置 → 聊天 → 勾选「记录聊天到文件」）' : '选择文件夹后列出最近 7 天用过的频道'}</span>`}</div></div>
      <label class="ka-opt" title="敌情星系距离我的位置多少跳以内才提醒（0–20）"><span><b>预警范围</b></span><span class="ka-ctl"><input type="number" class="cr-input" min="0" max="20" step="1" value="${T.jumps}" data-in-num="jumps" aria-label="预警范围（跳）"> 跳</span></label>
      ${sw('useLoc', '自动获取我的位置', `当前：${ctx.esc(here)}`, '绑定 ESI 时读角色位置，否则读本地频道日志里的星系切换记录')}
      <label class="ka-opt" title="自动获取不到位置时使用"><span><b>手动设置位置</b></span><input type="text" class="cr-input intel-home" data-in-home="home" data-keep="home" value="${ctx.esc(T.home)}" placeholder="星系名" autocomplete="off" aria-label="手动位置"></label>
      <label class="ka-opt" title="消息里有这些词（空格分隔）算星系已清空，星图标绿、不提醒"><span><b>报平安的字样</b></span><input type="text" class="cr-input intel-home" data-in-home="clearWords" data-keep="clear" value="${ctx.esc(T.clearWords)}" aria-label="报平安字样"></label>
      <label class="ka-opt" title="星图上的红 / 绿标记多久后消失"><span><b>星图标记保留</b></span><select class="cr-input" data-in-num="expire">${[5, 10, 15, 30, 60].map((m) => `<option value="${m}"${T.expire === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}</select></label>
    </div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('sound', '提示音', '', '越近响得越急')}
      ${sw('web', '网页卡片', '', '右上角弹出敌情卡片，点击在星图查看')}
      ${sw('notify', '系统通知', '', '浏览器在后台时也能看到（需要允许通知）')}
      ${sw('mail', '游戏内邮件', '', '发 EVE 邮件（每分钟最多一封，多条合并），需要绑定 ESI')}
      ${T.mail ? AM.pickerHtml('intel') : ''}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-in-test>测试提醒</button>${T.mail ? `<button class="btn btn-ghost btn-sm" data-in-testmail${ctx.tokenInfo() ? '' : ' disabled'}>发送测试邮件</button>` : ''}</div>`)}
    ${sec('频道关键词', `<div class="ka-list">
      ${sw('kwOn', '开启关键词提醒', '', '勾选的敌情频道里出现关键词就提醒；写成 /正则/ 也可以')}
      ${sw('kwAll', '监控所有频道', '', '包括军团、舰队、私聊等全部频道（最近 2 天的聊天记录）')}
      ${wordList('keywords', '关键词，例如 你的名字、cyno、/集合|ping/')}
    </div>`)}
    ${sec('游戏日志', `<div class="ka-list">
      ${sw('gameOn', '开启游戏日志提醒', '', '战斗、通知等游戏日志里出现关键词就提醒')}
      ${wordList('gameWords', '关键词，例如 warp scramble、跃迁扰断、被锁定')}
    </div>`)}
    ${sec('最近消息', S.reports.length ? `<ul class="ka-history">${S.reports.map((r) => `<li${r.system ? ` data-in-sys="${r.system}"` : ''}>
      <span class="ka-badge${r.clear ? ' clear' : ''}">${r.type !== 'intel' ? (r.type === 'kw' ? '关键词' : '日志') : r.clear ? '平安' : r.jumps == null ? '敌情' : r.jumps + ' 跳'}</span>
      <span>${r.system ? `<b>${ctx.esc(r.name)}</b> ` : ''}${ctx.esc((r.who ? r.who + '：' : '') + r.msg)}<small> · ${ctx.esc(r.channel)}</small></span><small>${ago(r.at)}</small></li>`).join('')}</ul>` : '<p class="ka-empty">还没有消息</p>')}`;
}

// 把标签页挂到弹窗里（只挂一次）；opts：{ close() 关掉弹窗, isOpen(el) 这个标签页是否正显示 }
export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  AM.bindPicker(panel);
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChangeEvt);
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const w = e.target.closest('[data-in-word]');
    if (w) { e.preventDefault(); addWord(w.dataset.inWord, w.value); }
    const h = e.target.closest('[data-in-home]');
    if (h) { e.preventDefault(); update({ [h.dataset.inHome]: h.value.trim() }); }
  });
}
// 切到这个标签页时
export function showPanel() {
  renderPanel();
  AM.loadMailLists();
  if (S.dir && S.perm === 'granted' && !S.channels.size) scan(false);
}

function addWord(key, value) {
  const v = value.trim();
  if (!v || T[key].includes(v)) return;
  update({ [key]: [...T[key], v] });
}

async function onClick(e) {
  const t = (sel) => e.target.closest(sel);
  if (t('[data-in-pick]')) { pickFolder(); return; }
  if (t('[data-in-resume]')) {
    if (!T.on) { T.on = true; save(); }
    resume(true);
    return;
  }
  const wadd = t('[data-in-wadd]');
  if (wadd) { const k = wadd.dataset.inWadd; addWord(k, panel.querySelector(`[data-in-word="${k}"]`).value); return; }
  const wdel = t('[data-in-wdel]');
  if (wdel) { const [k, i] = wdel.dataset.inWdel.split(':'); update({ [k]: T[k].filter((_, n) => n !== Number(i)) }); return; }
  const sys = t('[data-in-sys]');
  if (sys) { shell.close(); ctx.openMapSystem(Number(sys.dataset.inSys)); return; }
  if (t('[data-in-testmail]')) {
    if (!AM.canMail()) { AM.testToast(null); return; }
    await ensureNames().catch(() => {});
    const id = S.here || S.graph?.systems[0]?.[0];
    S.mailQueue.push({ type: 'intel', time: new Date(), channel: AM.L('测试频道', 'Test channel'), who: AM.L('测试', 'Tester'), msg: AM.L('（测试）', '(test) ') + (id ? sysName(id) : '') + AM.L(' 2 红', ' 2 reds'), system: id, name: id ? sysName(id) : '', jumps: S.here ? 0 : null });
    clearTimeout(S.mailTimer);
    flushMail().then(AM.testToast);
    return;
  }
  if (t('[data-in-test]')) {
    await ensureNames().catch(() => {});
    const id = S.here || S.graph?.systems[0]?.[0];
    raise({ test: true, type: 'intel', time: new Date(), channel: '测试频道', who: '测试', msg: '（测试）' + (id ? sysName(id) : '') + ' 2 红', system: id, name: id ? sysName(id) : '', jumps: S.here ? 0 : null });
  }
}

async function onChangeEvt(e) {
  const set = e.target.closest('[data-in-set]');
  if (set) {
    const key = set.dataset.inSet;
    if (key === 'notify' && set.checked && window.Notification && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { set.checked = false; ctx.showToast('浏览器没有允许通知', 'error'); return; }
    }
    if (key === 'on' && set.checked && !S.dir) { set.checked = false; pickFolder(); return; }
    if (key === 'mail' && set.checked && !ctx.tokenInfo()) { set.checked = false; ctx.showToast('游戏内邮件需要先在「个人中心」绑定 ESI', 'error', 4000); return; }
    if (key === 'on' && set.checked && S.perm !== 'granted') { T.on = true; save(); resume(true); return; }
    update({ [key]: set.checked });
    return;
  }
  const chan = e.target.closest('[data-in-chan]');
  if (chan) {
    const c = chan.dataset.inChan;
    update({ channels: chan.checked ? [...new Set([...T.channels, c])] : T.channels.filter((x) => x !== c) });
    return;
  }
  const num = e.target.closest('[data-in-num]');
  if (num) { update({ [num.dataset.inNum]: Number(num.value) }); return; }
  const home = e.target.closest('[data-in-home]');
  if (home) update({ [home.dataset.inHome]: home.value.trim() });
}
