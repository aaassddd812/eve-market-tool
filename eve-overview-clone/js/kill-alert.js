// ===== 击杀预警 =====
// 绑定 ESI 后可开启（默认关闭）：按角色当前所在星系（/location/，每 30 秒读一次），实时检测周边 N 跳（默认 3 跳，可设 1–10）内的击杀。
// 数据来源：
//   宁静服：击杀记录服务 /api/kb/live（R2Z2 实时收录，每 6 秒取一次），每条击杀都有 ID 与 hash；
//   晨曦 / 曙光：没有实时击杀源，只能用 ESI /universe/system_kills/（各星系过去 1 小时击杀数，约每小时更新）的增量判断，没有具体击杀邮件。
// 提醒方式：
//   游戏内邮件（默认开）：给自己发一封 EVE 邮件（esi-mail.send_mail.v1），带击杀报告链接 killReport:ID:HASH，游戏里点开即可看 KM；
//     同一分钟内的多条击杀合并成一封，两封之间至少隔 60 秒；同时开了多个标签页时只由一个标签页发送。
//     收件人在「预警」弹窗的「邮件」标签页设置（alert-mail.js，与本地日志共用通讯录与发信间隔），这里勾选发给谁；英文界面发英文邮件。
//   网页特效（默认关）：屏幕边缘红色闪烁 + 右上角预警卡片（点击查看击杀详情），可选提示音。
// 人物关注（与位置预警相互独立，默认关闭）：关注的角色产生 KM 时提醒，可分别选「击杀」（参与击杀，含最后一击）/「损失」/「全部」。
//   只有宁静服可用：实时缓冲里每条击杀带全部玩家攻击者的角色 ID（att）；国服没有公开的个人击杀数据。
// 星域监控（与位置预警相互独立，宁静服）：指定星域里的任何击杀都提醒，不需要绑定。
// 过滤条件（位置预警与星域监控共用）：最低价值、受害者舰船类别、只提醒 N 秒内发生的击杀（zKillboard 收录有延迟，过旧的不提醒）。
// 人物关注也可以关注军团 / 联盟：成员损失，或成员参与击杀（实时缓冲里带全部攻击者的军团 / 联盟 ID：ao）。
// 浏览器后台标签页的定时器会被降频（约每分钟一次），预警可能延迟。
// 设置面板和本地日志合在右上角铃铛的「预警」弹窗里（alert-center.js），这里只画「击杀预警」标签页（mountPanel / showPanel）。

import { SERVER, IS_TQ, serverKey, esiUrl } from './server.js?v=s4';
import * as AM from './alert-mail.js?v=v4';

let ctx;   // esc, formatISK, showToast, eveImage, esiAuthFetch, tokenInfo, hasScope, gateGraph, bfsJumps, resolveTypeNames, resolveNames, officialName, openKill, openEsiModal
const KEY = serverKey('eve-kill-alert-v1');
const DEFAULTS = { on: false, jumps: 3, mail: true, web: false, sound: false, pods: true, watchOn: false, watch: [],   // watch: [{ id, name, kind: character|corporation|alliance, mode: both|kills|losses }]
  minValue: 0, classes: [], maxAge: 0, regionOn: false, regions: [] };   // classes: 舰船类别（市场分组 ID），空 = 全部；regions: [{ id, name }]
const MIN_VALUES = [[0, '不限'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿'], [1e10, '100 亿']];
const MAX_AGES = [[0, '不限'], [60, '1 分钟'], [180, '3 分钟'], [600, '10 分钟'], [1800, '30 分钟']];
const KIND_ZH = { character: '角色', corporation: '军团', alliance: '联盟' };
const REGION_MAX = 20;
const WATCH_MAX = 50;
const MODE_ZH = { both: '击杀与损失', kills: '只看击杀', losses: '只看损失' };
const T = { ...DEFAULTS };
const S = {
  timerLoc: 0, timerKills: 0, system: 0, systemName: '', range: new Map(), status: '', cursor: null, busy: false,
  seen: new Set(), history: [], mailQueue: [], mailTimer: 0, snapshot: null, snapshotAt: '', charId: 0
};
const TAB = Math.random().toString(36).slice(2);
const LEADER_KEY = 'eve-kill-alert-leader';
const LOC_POLL = 30e3;
const LIVE_POLL = 6e3;
const NETEASE_POLL = 5 * 60e3;
const LOC_SCOPE = 'esi-location.read_location.v1';
const subs = new Set();

function load() {
  try { Object.assign(T, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 忽略 */ }
  T.jumps = Math.min(10, Math.max(1, Math.round(Number(T.jumps) || 3)));
  if (!Array.isArray(T.watch)) T.watch = [];
  T.watch.forEach((e) => { if (!e.kind) e.kind = 'character'; });
  if (!Array.isArray(T.classes)) T.classes = [];
  if (!Array.isArray(T.regions)) T.regions = [];
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 忽略 */ } }

export const settings = () => T;
const watching = () => T.watchOn && T.watch.length > 0;
const regionWatching = () => T.regionOn && T.regions.length > 0 && IS_TQ;
function watchText() {
  const parts = [];
  if (watching()) parts.push(IS_TQ ? `正在关注 ${T.watch.length} 个角色 / 军团 / 联盟` : `${SERVER.full}没有实时击杀数据，人物关注不可用`);
  if (regionWatching()) parts.push(`正在监控 ${T.regions.length} 个星域`);
  return parts.join('；');
}
export const status = () => ({ on: T.on || watching() || regionWatching(), mail: T.mail, text: [T.on ? S.status : '', watchText()].filter(Boolean).join('；') || '预警未开启', area: S.status, system: S.systemName, count: S.range.size, history: S.history });
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } }
function setStatus(text) { S.status = text; notify(); }

export function initKillAlert(context) {
  ctx = context;
  load();
  AM.initAlertMail(ctx, T);   // 旧版收件人设置（T.mailSelf / mailTo）第一次搬到共用设置里
  AM.onMailChange(renderPanel);
  AM.registerSource('kill', { label: '击杀预警', on: () => T.mail, set: (on) => update({ mail: on }) });
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
  // 位置预警或人物关注的开关变化、关注名单从空到有时重新开始检测
  if ('on' in patch || 'watchOn' in patch || 'regionOn' in patch || (('watch' in patch || 'regions' in patch) && !S.timerKills)) restart();
  notify();
  if ('mail' in patch) AM.refresh();
}

function stop() {
  clearInterval(S.timerLoc); clearInterval(S.timerKills);
  S.timerLoc = S.timerKills = 0;
}

export function restart() {
  stop();
  const watch = (watching() && IS_TQ) || regionWatching();
  if (!T.on && !watch) { setStatus(T.on ? '' : '位置预警未开启'); return; }
  S.cursor = null;
  S.snapshot = null;
  let area = T.on;
  // 位置预警要读角色位置；人物关注只用公开的实时击杀，不绑定也能用（游戏邮件提醒仍需绑定）
  if (area && !ctx.tokenInfo()) { setStatus('需要先绑定 ESI'); area = false; }
  else if (area && !ctx.hasScope(LOC_SCOPE)) { setStatus('授权里没有位置权限（esi-location.read_location.v1），请重新绑定 ESI'); area = false; }
  if (area) {
    setStatus('正在读取角色位置…');
    pollLocation();
    S.timerLoc = setInterval(pollLocation, LOC_POLL);
  } else if (!T.on) setStatus('位置预警未开启');
  // 宁静服实时击杀同时服务于位置预警与人物关注；国服只有位置预警（每小时统计）
  if (IS_TQ) { if (area || watch) { pollLive(); S.timerKills = setInterval(pollLive, LIVE_POLL); } }
  else if (area) { pollSystemKills(); S.timerKills = setInterval(pollSystemKills, NETEASE_POLL); }
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
  S.dist = dist;
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

// 某星系距角色当前位置的跳数（不知道位置时为 null）
function jumpsTo(systemId) {
  const i = S.graph?.index.get(systemId);
  if (i == null || !S.dist) return null;
  return S.dist[i] >= 0 ? S.dist[i] : null;
}

// 关注名单里的角色 / 军团 / 联盟是否出现在这条击杀里：受害者 = 损失；攻击者（含最后一击）= 击杀
function watchMatch(k) {
  if (!watching()) return null;
  for (const e of T.watch) {
    const key = e.kind === 'corporation' ? 'corporation_id' : e.kind === 'alliance' ? 'alliance_id' : 'character_id';
    if (e.mode !== 'kills' && k.victim?.[key] === e.id) return { ...e, role: 'loss' };
    if (e.mode !== 'losses' && (k.final?.[key] === e.id || (e.kind === 'character' ? k.att || [] : k.ao || []).includes(e.id))) return { ...e, role: 'kill' };
  }
  return null;
}

// 位置预警 / 星域监控的过滤条件
function passes(k) {
  const pod = [670, 33328].includes(k.ship_type_id);
  if (pod && !T.pods) return false;
  if (T.minValue && (k.value || 0) < T.minValue) return false;
  if (T.classes.length && !pod && !T.classes.includes(ctx.shipClassOf?.(k.ship_type_id) ?? -1)) return false;
  return true;
}

// ---------- 宁静服：实时击杀 ----------
async function pollLive() {
  if (S.busy || (!T.on && !watching())) return;
  S.busy = true;
  try {
    const first = S.cursor == null;
    const res = await fetch('/api/kb/live?after=' + (first ? -1 : S.cursor) + (first ? '&initial=0' : ''));
    if (!res.ok) { if (res.status === 404) setStatus('没有部署击杀记录服务，宁静服无法实时预警'); return; }
    const data = await res.json();
    S.cursor = data.cursor;
    if (first) return;   // 第一次只取游标，不提醒旧击杀
    // 人物关注优先（同一条击杀只提醒一次）；位置预警按跳数范围与太空舱设置
    const hits = [];
    for (const k of data.kills || []) {
      if (S.seen.has(k.id)) continue;
      if (T.maxAge && (Date.now() - new Date(k.time)) / 1000 > T.maxAge) continue;
      const w = watchMatch(k);
      if (w) hits.push({ k, w });
      else if (passes(k)) {
        if (T.on && S.range.has(k.system_id)) hits.push({ k });
        else if (regionWatching() && T.regions.some((r) => r.id === k.region_id)) hits.push({ k, region: T.regions.find((r) => r.id === k.region_id).name });
      }
    }
    if (!hits.length) return;
    hits.forEach(({ k }) => S.seen.add(k.id));
    const types = await ctx.resolveTypeNames(hits.flatMap(({ k }) => [k.ship_type_id, k.final?.ship_type_id])).catch(() => new Map());
    const names = data.names || {};
    for (const { k, w, region } of hits) {
      raise({
        id: k.id, hash: k.hash, system: k.system_id, jumps: w || region ? jumpsTo(k.system_id) : S.range.get(k.system_id), time: k.time, value: k.value,
        watch: w ? { id: w.id, name: w.name, role: w.role, kind: w.kind } : null, region: region || null,
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

const where = (a) => a.jumps == null ? a.systemName : `${a.systemName}（${a.jumps === 0 ? '本星系' : a.jumps + ' 跳'}）`;
const badge = (a) => a.watch ? `<span class="ka-badge ${a.watch.role === 'loss' ? 'loss' : 'kill'}">${a.watch.role === 'loss' ? '损失' : '击杀'}</span>`
  : a.region ? '<span class="ka-badge">星域</span>' : `<span class="ka-badge">${a.jumps === 0 ? '本星系' : a.jumps + ' 跳'}</span>`;
const whoOf = (w) => (w.kind && w.kind !== 'character' ? `${KIND_ZH[w.kind]} ${w.name}` : w.name);
function describe(a) {
  if (a.hourly) return `${a.systemName}（${a.jumps} 跳）过去一小时新增击杀 ${a.added} 次`;
  if (a.watch) return a.watch.role === 'loss'
    ? `关注的 ${whoOf(a.watch)} 损失了${a.ship} · ${where(a)}`
    : `关注的 ${whoOf(a.watch)} 参与击杀了${a.victim ? a.victim + '的' : ''}${a.ship} · ${where(a)}`;
  if (a.region) return `${a.region} · ${where(a)} ${a.victim ? a.victim + '的' : ''}${a.ship}被击毁`;
  return `${a.systemName}（${a.jumps} 跳）${a.victim ? a.victim + '的' : ''}${a.ship}被击毁`;
}

// 游戏内邮件：合并、限速，只由领头标签页发送
function queueMail(a) {
  if (!AM.canMail()) return;
  S.mailQueue.push(a);
  if (S.mailTimer) return;
  S.mailTimer = setTimeout(flushMail, AM.nextSlot());
}

async function flushMail(force = false) {
  S.mailTimer = 0;
  const list = S.mailQueue.splice(0);
  if (!list.length || (!force && !isLeader())) return null;
  if (!ctx.tokenInfo()) return null;
  const subject = mailSubject(list);
  const body = (AM.EN ? mailBodyEn : mailBodyZh)(list);
  return AM.sendMail('kill', subject, body);
}
// 邮件标题与正文（英文界面发英文，舰船 / 星系名在英文模式下本来就是英文）
function mailSubject(list) {
  const first = list[0];
  const watched = list.filter((x) => x.watch).length;
  if (!AM.EN) {
    return list.length === 1 ? (first.watch ? '人物关注：' : '击杀预警：') + describe(first)
      : watched === list.length ? `人物关注：关注的角色产生了 ${list.length} 条 KM`
        : watched ? `击杀预警：${list.length} 条（其中关注人物 ${watched} 条）`
          : `击杀预警：附近 ${list.length} 起击杀（最近 ${Math.min(...list.map((x) => x.jumps ?? 99))} 跳）`;
  }
  return list.length === 1 ? (first.watch ? 'Watchlist: ' : 'Kill alert: ') + describeEn(first)
    : watched === list.length ? `Watchlist: ${list.length} new killmails`
      : watched ? `Kill alert: ${list.length} kills (${watched} watchlist)`
        : `Kill alert: ${list.length} kills nearby (closest ${Math.min(...list.map((x) => x.jumps ?? 99))} jumps)`;
}
const jumpsEn = (n) => (n === 0 ? 'same system' : n === 1 ? '1 jump' : n + ' jumps');
function describeEn(a) {
  const ship = (a.victim ? a.victim + "'s " : '') + a.ship;
  if (a.hourly) return `${a.systemName} (${jumpsEn(a.jumps)}): ${a.added} new kills in the last hour`;
  if (a.watch) return a.watch.role === 'loss' ? `${a.watch.name} lost a ${a.ship} · ${a.systemName}` : `${a.watch.name} killed ${ship} · ${a.systemName}`;
  if (a.region) return `${a.region} · ${a.systemName}: ${ship} destroyed`;
  return `${a.systemName} (${jumpsEn(a.jumps)}): ${ship} destroyed`;
}
const mailTime = (t) => new Date(t).toLocaleTimeString(AM.EN ? 'en-GB' : 'zh-CN', { hour12: false });
const mailSys = (a) => `<a href="showinfo:5//${a.system}">${ctx.esc(a.systemName)}</a>`;
const mailKm = (a, label) => (a.hash ? ` · <a href="killReport:${a.id}:${a.hash}">${label}</a>` : '');
const mailWho = (a, name) => `<a href="showinfo:${{ corporation: 2, alliance: 16159 }[a.watch.kind] || 1377}//${a.watch.id}">${ctx.esc(name)}</a>`;
function mailFrame(list, intro, line, more, foot) {
  return `<font size="14">${intro}</font><br><br>` + list.slice(0, 20).map(line).join('<br>') + (list.length > 20 ? `<br>${more(list.length - 20)}` : '') +
    `<br><br><font size="10" color="#ff888888">${foot}</font>`;
}
function mailBodyZh(list) {
  const who = AM.ownerWord('kill');   // 发给别人时说清楚是谁的预警
  const first = list[0];
  const watched = list.filter((x) => x.watch).length;
  const line = (a) => {
    const sys = mailSys(a);
    if (a.hourly) return `${sys}（${a.jumps} 跳）：过去一小时新增击杀 ${a.added} 次（国服没有实时击杀邮件，数据来自 ESI 每小时统计）`;
    const km = mailKm(a, '查看击杀报告');
    if (a.watch) {
      const w = mailWho(a, whoOf(a.watch));
      const what = a.watch.role === 'loss' ? `${w} <b>损失</b>了${ctx.esc(a.ship)}` : `${w} <b>参与击杀</b>了${ctx.esc(a.victim ? a.victim + '的' : '')}${ctx.esc(a.ship)}`;
      return `【关注】${what} · ${sys}${a.jumps != null ? `（距你 ${a.jumps} 跳）` : ''}${a.value ? '，价值 ' + ctx.formatISK(a.value) + ' ISK' : ''} · ${mailTime(a.time)}${km}`;
    }
    return `${a.region ? '【' + ctx.esc(a.region) + '】' : ''}${sys}${a.jumps != null ? `（${a.jumps} 跳）` : ''}：${ctx.esc(a.victim ? a.victim + '的' : '')}${ctx.esc(a.ship)}被击毁` +
      `${a.value ? '，价值 ' + ctx.formatISK(a.value) + ' ISK' : ''}${a.attackers ? '，' + a.attackers + ' 名攻击者' : ''}${a.final ? '（最后一击：' + ctx.esc(a.final) + '）' : ''} · ${mailTime(a.time)}${km}`;
  };
  const regional = list.filter((x) => x.region).length;
  const intro = watched === list.length ? `人物关注：${who}关注的角色 / 军团 / 联盟产生了新的 KM。`
    : regional === list.length - watched ? `星域监控：${who}监控的星域发生了击杀${watched ? '，另有关注的对象产生了 KM' : ''}。`
      : `击杀预警：${who}所在的 ${ctx.esc(S.systemName || first.systemName || '')} 周边 ${T.jumps} 跳内发生了击杀${regional ? '，监控的星域也有击杀' : ''}${watched ? '，另有关注的对象产生了 KM' : ''}。`;
  return mailFrame(list, intro, line, (n) => `……另有 ${n} 起`, '来自 EVE Market 击杀预警，可在网页右上角的铃铛里关闭或调整范围。');
}
function mailBodyEn(list) {
  const who = AM.ownerWord('kill');
  const whose = who === 'you' ? 'your' : who + "'s";
  const first = list[0];
  const watched = list.filter((x) => x.watch).length;
  const kindEn = { corporation: 'Corporation ', alliance: 'Alliance ' };
  const line = (a) => {
    const sys = mailSys(a);
    if (a.hourly) return `${sys} (${jumpsEn(a.jumps)}): ${a.added} new kills in the last hour (no live killmails on this server; hourly ESI statistics)`;
    const km = mailKm(a, 'Kill report');
    const value = a.value ? `, worth ${ctx.formatISK(a.value)} ISK` : '';
    const ship = ctx.esc((a.victim ? a.victim + "'s " : '') + a.ship);
    if (a.watch) {
      const w = mailWho(a, (kindEn[a.watch.kind] || '') + a.watch.name);
      const what = a.watch.role === 'loss' ? `${w} <b>lost</b> a ${ctx.esc(a.ship)}` : `${w} <b>was on the kill</b> of ${ship}`;
      return `[Watchlist] ${what} · ${sys}${a.jumps != null ? ` (${jumpsEn(a.jumps)} from you)` : ''}${value} · ${mailTime(a.time)}${km}`;
    }
    return `${a.region ? '[' + ctx.esc(a.region) + '] ' : ''}${sys}${a.jumps != null ? ` (${jumpsEn(a.jumps)})` : ''}: ${ship} destroyed${value}` +
      `${a.attackers ? `, ${a.attackers} attacker${a.attackers > 1 ? 's' : ''}` : ''}${a.final ? ` (final blow: ${ctx.esc(a.final)})` : ''} · ${mailTime(a.time)}${km}`;
  };
  const regional = list.filter((x) => x.region).length;
  const also = watched ? '; watched pilots / corporations / alliances also have new killmails' : '';
  const intro = watched === list.length ? `Watchlist: ${whose} watched pilots / corporations / alliances have new killmails.`
    : regional === list.length - watched ? `Region watch: kills in ${whose} watched regions${also}.`
      : `Kill alert: kills within ${T.jumps} jumps of ${ctx.esc(S.systemName || first.systemName || '')}, where ${who === 'you' ? 'you are' : who + ' is'}${regional ? '; also kills in watched regions' : ''}${also}.`;
  return mailFrame(list, intro, line, (n) => `…and ${n} more`, 'Sent by EVE Market kill alerts. Turn it off or change the range from the bell icon at the top right of the site.');
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
  card.className = 'ka-card' + (a.watch ? ' watch' : a.jumps === 0 ? ' here' : '');
  if (a.id && !a.hourly && !a.test) card.dataset.kaKill = a.id;
  card.innerHTML = `<div class="ka-head">${badge(a)}<b>${a.watch ? '人物关注' : '击杀预警'}</b>
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
  const a = { id: 0, test: true, system: S.system || 30000142, jumps: 2, time: new Date().toISOString(), ship: AM.L('金鹏级（测试）', 'Raven (test)'), victim: AM.L('测试飞行员', 'Test Pilot'), value: 432000000, attackers: 8 };
  a.systemName = S.systemName || sysName(a.system);
  if (kind === 'web') { webAlert(a); return; }
  if (kind === 'mail') {
    if (!AM.canMail()) { AM.testToast(null); return; }
    S.mailQueue.push(a);
    flushMail(true).then(AM.testToast);
  }
}

// ---------- 设置面板（「预警」弹窗的「击杀预警」标签页）----------
let panel = null;      // 标签页容器
let shell = null;      // { close, isOpen }：弹窗由 alert-center.js 管
// 设置行：左边名称（可带一行短说明），右边开关；详细说明放在悬停提示里
const sw = (key, label, sub = '', tip = '') => `<label class="ka-opt"${tip ? ` title="${tip}"` : ''}><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="ka-switch" data-ka-set="${key}"${T[key] ? ' checked' : ''}></label>`;
const sec = (title, body, extra = '') => `<section class="ka-sec"><h4 class="ka-h">${title}${extra}</h4>${body}</section>`;
function renderPanel() {
  if (!panel || !shell.isOpen(panel)) return;
  // 重绘时保留正在输入的关注角色名
  const keep = ['[data-ka-name]', '[data-ka-region]'].map((sel) => {
    const el = panel.querySelector(sel);
    return el ? { sel, value: el.value, focus: document.activeElement === el } : null;
  }).filter(Boolean);
  const mode = panel.querySelector('[data-ka-mode]')?.value;
  drawPanel();
  for (const k of keep) {
    const el = panel.querySelector(k.sel);
    if (!el) continue;
    el.value = k.value;
    if (k.focus) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
  if (mode) panel.querySelector('[data-ka-mode]').value = mode;
}

// 添加关注
async function addWatch(text, mode) {
  text = text.trim();
  if (!text) return;
  if (T.watch.length >= WATCH_MAX) { ctx.showToast(`最多关注 ${WATCH_MAX} 个`, 'error'); return; }
  const hit = await AM.resolveEntity(text);
  if (!hit) { ctx.showToast('没有找到：请输入游戏内完整的角色 / 军团 / 联盟名称，或 ID', 'error', 4000); return; }
  if (T.watch.some((e) => e.id === hit.id)) { ctx.showToast(`已经关注了 ${hit.name}`, 'error'); return; }
  update({ watch: [...T.watch, { id: hit.id, name: hit.name, kind: hit.kind, mode }] });
  const el = panel?.querySelector('[data-ka-name]');
  if (el) el.value = '';
  ctx.showToast(`已关注${KIND_ZH[hit.kind]} ${hit.name}（${MODE_ZH[mode]}）`, 'success');
}

async function addRegion(text) {
  text = text.trim();
  if (!text) return;
  const list = await ctx.regionList();
  const key = text.toLowerCase();
  const hit = list.find((r) => r.name.toLowerCase() === key) || list.find((r) => r.name.toLowerCase().includes(key));
  if (!hit) { ctx.showToast('没有找到这个星域', 'error'); return; }
  if (T.regions.some((r) => r.id === hit.id)) { ctx.showToast(`已经在监控 ${hit.name}`, 'error'); return; }
  if (T.regions.length >= REGION_MAX) { ctx.showToast(`最多监控 ${REGION_MAX} 个星域`, 'error'); return; }
  update({ regions: [...T.regions, { id: hit.id, name: hit.name }] });
  const el = panel?.querySelector('[data-ka-region]');
  if (el) el.value = '';
}
const entityImg = (e) => ctx.eveImage((e.kind === 'corporation' ? 'corporations/' + e.id + '/logo' : e.kind === 'alliance' ? 'alliances/' + e.id + '/logo' : 'characters/' + e.id + '/portrait'), 64);
const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${l}</option>`).join('');

function drawPanel() {
  const token = ctx.tokenInfo();
  const st = status();
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
  const pill = (on, text) => `<span class="ka-status${on ? ' on' : ''}"><i></i>${ctx.esc(text)}</span>`;
  panel.innerHTML = `
    <div class="ka-top">${pill(st.on, st.text)}</div>
    ${token ? '' : '<p class="ka-warn">位置预警需要先在「个人中心」绑定 ESI</p>'}
    ${IS_TQ ? '' : `<p class="ka-warn" title="用 ESI 各星系过去一小时击杀数的增量判断，约每小时更新">${ctx.esc(SERVER.full)}没有实时击杀数据：提醒会延迟，星域监控与人物关注不可用</p>`}
    ${sec('位置预警', `<div class="ka-list">
      ${sw('on', '开启位置预警', '角色所在星系周边的击杀')}
      <label class="ka-opt"><span><b>检测范围</b></span><span class="ka-ctl"><input type="number" class="cr-input" min="1" max="10" step="1" value="${T.jumps}" data-ka-jumps aria-label="检测范围（跳）" title="1–10 跳"> 跳</span></label>
      ${sw('pods', '包括太空舱')}
    </div>`)}
    ${sec('提醒方式', `<div class="ka-list">
      ${sw('mail', '游戏内邮件', '', '发 EVE 邮件，附击杀报告链接（每分钟最多一封，多条合并）')}
      ${T.mail ? AM.pickerHtml('kill') : ''}
      ${sw('web', '网页特效', '', '屏幕边缘红色闪烁 + 右上角预警卡片')}
      ${sw('sound', '提示音', '', '网页特效时同时播放提示音')}
    </div>
    <div class="ka-actions"><button class="btn btn-ghost btn-sm" data-ka-test="web">测试网页特效</button><button class="btn btn-ghost btn-sm" data-ka-test="mail"${token ? '' : ' disabled'}>发送测试邮件</button></div>`)}
    ${sec('星域监控', `<div class="ka-list">
      ${sw('regionOn', '开启星域监控', '', '指定星域里发生的任何击杀都提醒，不需要绑定 ESI')}
      <div class="ka-opt ka-stack"><div class="ka-watch-add">
        <input type="text" class="cr-input" data-ka-region list="kaRegionList" placeholder="添加星域" autocomplete="off" aria-label="监控星域">
        <datalist id="kaRegionList">${(S.regionNames || []).map((r) => `<option value="${ctx.esc(r.name)}"></option>`).join('')}</datalist>
        <button class="btn btn-primary btn-sm" data-ka-radd>添加</button>
      </div>
      ${T.regions.length ? `<div class="ka-chips">${T.regions.map((r) => `<span class="ka-chip">${ctx.esc(r.name)}<button class="ka-close" data-ka-rdel="${r.id}" aria-label="移除">×</button></span>`).join('')}</div>` : ''}</div>
    </div>`)}
    ${sec('过滤条件', `<div class="ka-list">
      <label class="ka-opt"><span><b>最低价值</b></span><select class="cr-input" data-ka-num="minValue" aria-label="最低价值">${opts(MIN_VALUES, T.minValue)}</select></label>
      <label class="ka-opt" title="击杀记录收录有延迟，过旧的不再提醒"><span><b>只提醒多久内的</b></span><select class="cr-input" data-ka-num="maxAge" aria-label="时效">${opts(MAX_AGES, T.maxAge)}</select></label>
      <div class="ka-opt ka-stack"><span><b>舰船类别</b><small>${T.classes.length ? `已选 ${T.classes.length} 类` : '不选 = 全部'}</small></span>
        <div class="ka-chips">${(ctx.shipClasses?.() || []).map((c) => `<button type="button" class="ka-chip toggle${T.classes.includes(c.id) ? ' on' : ''}" data-ka-class="${c.id}">${ctx.esc(c.name)}</button>`).join('')}</div></div>
    </div>`, '<small>位置预警与星域监控</small>')}
    ${sec('人物关注', `<div class="ka-list">
      ${sw('watchOn', '开启人物提醒', '', '关注的角色 / 军团 / 联盟产生 KM 时提醒')}
      <div class="ka-opt ka-stack"><div class="ka-watch-add">
        <input type="text" class="cr-input" data-ka-name placeholder="角色 / 军团 / 联盟全名或 ID" autocomplete="off" spellcheck="false" aria-label="关注角色">
        <select class="cr-input" data-ka-mode aria-label="提醒类型">${Object.entries(MODE_ZH).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <button class="btn btn-primary btn-sm" data-ka-add>添加</button>
      </div>
      ${T.watch.length ? `<ul class="ka-watch">${T.watch.map((e) => `<li><img src="${entityImg(e)}" alt="" width="24" height="24" loading="lazy">
        <span>${ctx.esc(e.name)}${e.kind !== 'character' ? `<small> · ${KIND_ZH[e.kind]}</small>` : ''}</span><select class="cr-input" data-ka-wmode="${e.id}" aria-label="提醒类型">${Object.entries(MODE_ZH).map(([k, l]) => `<option value="${k}"${e.mode === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="ka-close" data-ka-del="${e.id}" title="取消关注" aria-label="取消关注">×</button></li>`).join('')}</ul>` : ''}</div>
    </div>`)}
    ${sec('最近预警', st.history.length ? `<ul class="ka-history">${st.history.map((a) => `<li${a.id && !a.hourly ? ` data-ka-open="${a.id}"` : ''}>${badge(a)}<span>${ctx.esc(describe(a))}</span><small>${ago(a.at)}</small></li>`).join('')}</ul>` : '<p class="ka-empty">还没有预警</p>')}
    <p class="ka-note">网页需保持打开（可在后台）</p>`;
}

// 把标签页挂到弹窗里（只挂一次）；opts：{ close() 关掉弹窗, isOpen(el) 这个标签页是否正显示 }
export function mountPanel(el, opts) {
  if (panel) return;
  panel = el;
  shell = opts;
  AM.bindPicker(panel);
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ka-test]');
    if (t) { test(t.dataset.kaTest); return; }
    const open = e.target.closest('[data-ka-open]');
    if (open) { shell.close(); ctx.openKill(Number(open.dataset.kaOpen)); return; }
    if (e.target.closest('[data-ka-add]')) { addWatch(panel.querySelector('[data-ka-name]').value, panel.querySelector('[data-ka-mode]').value); return; }
    if (e.target.closest('[data-ka-radd]')) { addRegion(panel.querySelector('[data-ka-region]').value); return; }
    const rdel = e.target.closest('[data-ka-rdel]');
    if (rdel) { update({ regions: T.regions.filter((r) => r.id !== Number(rdel.dataset.kaRdel)) }); return; }
    const cls = e.target.closest('[data-ka-class]');
    if (cls) { const id = Number(cls.dataset.kaClass); update({ classes: T.classes.includes(id) ? T.classes.filter((x) => x !== id) : [...T.classes, id] }); return; }
    const del = e.target.closest('[data-ka-del]');
    if (del) update({ watch: T.watch.filter((x) => x.id !== Number(del.dataset.kaDel)) });
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-ka-name]')) { e.preventDefault(); addWatch(e.target.value, panel.querySelector('[data-ka-mode]').value); }
    if (e.key === 'Enter' && e.target.matches('[data-ka-region]')) { e.preventDefault(); addRegion(e.target.value); }
  });
  panel.addEventListener('change', (e) => {
    const set = e.target.closest('[data-ka-set]');
    if (set) {
      if (set.dataset.kaSet === 'on' && set.checked && !ctx.tokenInfo()) { set.checked = false; shell.close(); ctx.openEsiBind(); return; }
      update({ [set.dataset.kaSet]: set.checked });
      return;
    }
    if (e.target.matches('[data-ka-jumps]')) { update({ jumps: Number(e.target.value) }); return; }
    if (e.target.matches('[data-ka-num]')) { update({ [e.target.dataset.kaNum]: Number(e.target.value) }); return; }
    const wm = e.target.closest('[data-ka-wmode]');
    if (wm) update({ watch: T.watch.map((x) => (x.id === Number(wm.dataset.kaWmode) ? { ...x, mode: wm.value } : x)) });
  });
  onChange(renderPanel);
}
// 切到这个标签页时
export function showPanel() {
  renderPanel();
  AM.loadMailLists();
  if (!S.regionNames) ctx.regionList().then((list) => { S.regionNames = list; renderPanel(); }).catch(() => {});
}
