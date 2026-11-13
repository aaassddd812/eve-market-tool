#!/usr/bin/env node
// ===== 驾驶模拟 · 匹配对战服务（1v1 / 2v2，服务器权威）=====
// 只监听 127.0.0.1（默认 8292），由 nginx 反代 /api/match/（要带 WebSocket 升级头，见 server/eve.navexor.top.conf）。不依赖 npm 包。
//   GET /api/match/status   在线人数、各队列人数、进行中的对局数
//   GET /api/match/presets?server=      公开预设列表（不含装配内容）· GET /api/match/preset?server=&id=  一个预设（含装配）
//       公开预设存在 EVE_MATCH_DATA 目录（默认本文件旁边的 data/）的 presets.json
//   WS  /api/match/ws       消息都是 JSON：
//     客户端 → 服务器
//       hello { server: tq|serenity|infinity, id: 角色 ID, token: ESI 访问令牌 }   用令牌读这个角色的技能（令牌和角色对不上 ESI 会拒绝）
//       queue { mode: 1v1|2v2, fit, cap, skills }  随机匹配；cap = 装配价值上限（MATCH_CAPS，0 不限）；skills = esi 角色真实技能 / max 全 5 级（只和同一种匹配）
//       room  { mode, fit, cap, skills, pub }  开房间：1v1 = 约战（对方加入直接开打），2v2 = 组队（两人一起去排 2v2）；pub = 公开（出现在房间列表里），否则只能凭邀请码加入
//       join  { code, fit }                    用邀请码加入
//       rooms {}                               本服的公开房间列表
//       preset_pub { p } · preset_del { id }   发布 / 删除自己的公开预设（驾驶模拟的单人场景）
//       cancel {}                              退出队列 / 房间
//       ready {}                               对局画面建好了
//       act { a: 指令 }                        驾驶指令（格式见 js/pilot-rules.js cleanOp）
//       leave {}                               认输（船直接算被击毁）
//     服务器 → 客户端
//       hi { id, name } · err { msg } · queued { mode, bracket, cap, skills, value, n } · room { code, mode, bracket, cap, skills, pub, members } · idle {}
//       rooms { list: [{ code, mode, bracket, cap, skills, owner, ship }] } · preset_ok { id, del? }
//       match { mid, you, info }（info = 对局信息，见 js/match-sim.js）· go {} · tick { k, ops, s, rk } · end { winner, reason, t, stats }
// 匹配限制：同一游戏服务器、同舰船级别（护卫 / 驱逐 / 巡洋 / 战巡 / 战列，T1 T2 同级）、同一档装配价值上限、同一种技能（角色真实技能 / 全 5 级）；必须用 ESI 登录角色。
// 每个游戏服务器一个工作线程（match_worker.mjs）：装配数据各服不同（国服独有物品）。
import http from 'node:http';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.EVE_MATCH_PORT || 8292);
const HOST = process.env.EVE_MATCH_HOST || '127.0.0.1';
// 允许的页面来源（逗号分隔，空 = 不限）；浏览器 WebSocket 会带 Origin
const ORIGINS = (process.env.EVE_MATCH_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SERVERS = ['tq', 'serenity', 'infinity'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 站点目录（js/、数据文件）：默认仓库里本文件的上一级；生产设 EVE_MATCH_ROOT=/opt/eve/dist（工作线程同样读这个变量）
const ROOT = path.resolve(process.env.EVE_MATCH_ROOT || path.join(HERE, '..'));
const { MATCH_CAPS, MATCH_BRACKETS } = await import(pathToFileURL(path.join(ROOT, 'js/pilot-rules.js')).href + '?v=v1');
const MAX_MSG = 64 * 1024;
const PER_IP = 6;
const DEV_SKILLS = process.env.EVE_MATCH_DEV_SKILLS ? JSON.parse(readFileSync(process.env.EVE_MATCH_DEV_SKILLS, 'utf8')) : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- 公开预设（驾驶模拟单人场景）：每服一张列表，每个角色最多 PRESET_PER 个 ----------
const DATA = path.resolve(process.env.EVE_MATCH_DATA || path.join(HERE, 'data'));
const PRESET_FILE = path.join(DATA, 'presets.json');
const PRESET_PER = 10, PRESET_MAX = 1000;
let presets = {};
try { presets = JSON.parse(readFileSync(PRESET_FILE, 'utf8')); } catch { presets = {}; }
for (const s of ['tq', 'serenity', 'infinity']) if (!Array.isArray(presets[s])) presets[s] = [];
let presetTimer = null;
function savePresets() {
  clearTimeout(presetTimer);
  presetTimer = setTimeout(() => {
    try { mkdirSync(DATA, { recursive: true }); writeFileSync(PRESET_FILE + '.tmp', JSON.stringify(presets)); renameSync(PRESET_FILE + '.tmp', PRESET_FILE); } catch (e) { log('save presets', e.message); }
  }, 500);
}
const presetBrief = (p) => ({ id: p.id, name: p.name, author: p.author, aid: p.aid, ship: p.ship, fit: p.fit === 'hull' ? 'hull' : p.fit ? 'fit' : 'kb', fitName: p.fit?.name || '', foes: p.foes, allies: p.allies || [], dist: p.dist, sky: p.sky, at: p.at });

// ---------- 工作线程 ----------
const workers = new Map();
function worker(srv) {
  let W = workers.get(srv);
  if (W) return W;
  const w = new Worker(path.join(HERE, 'match_worker.mjs'), { workerData: { server: srv } });
  W = { w, rid: 0, wait: new Map(), up: null };
  W.up = new Promise((res, rej) => { W.res = res; W.rej = rej; });
  w.on('message', (m) => {
    if (m.t === 'up') { log('worker up', srv, m.types); W.res(); }
    else if (m.t === 'res') { const f = W.wait.get(m.rid); W.wait.delete(m.rid); f?.(m); }
    else if (m.t === 'tick') { const M = matches.get(m.mid); if (M) for (const c of M.conns) if (c) send(c, m.msg); }
    else if (m.t === 'go') { const M = matches.get(m.mid); if (M) for (const c of M.conns) if (c) send(c, { op: 'go' }); }
    else if (m.t === 'end') endMatch(m.mid, m.msg);
  });
  w.on('error', (e) => log('worker error', srv, e));
  w.on('exit', (code) => {
    log('worker exit', srv, code);
    workers.delete(srv);
    for (const f of W.wait.values()) f({ ok: false, err: '服务暂时不可用' });
    W.rej(new Error('worker exit'));
    // 这个服的对局全部作废
    for (const [mid, M] of matches) if (M.srv === srv) endMatch(mid, JSON.stringify({ op: 'end', winner: null, reason: 'error', t: 0, stats: [] }));
  });
  workers.set(srv, W);
  return W;
}
async function call(srv, msg, ms = 30000) {
  const W = worker(srv);
  await W.up;
  return new Promise((res) => {
    msg.rid = ++W.rid;
    const timer = setTimeout(() => { W.wait.delete(msg.rid); res({ ok: false, err: '服务超时' }); }, ms);
    W.wait.set(msg.rid, (m) => { clearTimeout(timer); res(m); });
    W.w.postMessage(msg);
  });
}
const tell = (srv, msg) => workers.get(srv)?.w.postMessage(msg);

// ---------- WebSocket（RFC 6455，只收发文本帧）----------
const conns = new Set();
const byChar = new Map();   // 服:角色 → 连接（同一角色只留最新的连接）
function send(c, m) {
  if (c.closed) return;
  const s = Buffer.from(typeof m === 'string' ? m : JSON.stringify(m));
  const n = s.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  c.sock.write(Buffer.concat([head, s]));
}
function frame(c, op, data = Buffer.alloc(0)) {
  if (c.closed) return;
  c.sock.write(Buffer.concat([Buffer.from([0x80 | op, data.length]), data]));
}
function close(c, code = 1000) {
  if (c.closed) return;
  const b = Buffer.alloc(2); b.writeUInt16BE(code);
  frame(c, 8, b);
  c.closed = true;
  c.sock.end();
  setTimeout(() => c.sock.destroy(), 1000).unref();
}
function onData(c, chunk) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  c.seen = Date.now();
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = b0 & 0x80, op = b0 & 15, masked = b1 & 0x80;
    let n = b1 & 127, off = 2;
    if (n === 126) { if (c.buf.length < 4) return; n = c.buf.readUInt16BE(2); off = 4; }
    else if (n === 127) { if (c.buf.length < 10) return; const big = c.buf.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return close(c, 1009); n = Number(big); off = 10; }
    if (!masked) return close(c, 1002);
    if (n > MAX_MSG) return close(c, 1009);
    if (c.buf.length < off + 4 + n) return;
    const mask = c.buf.subarray(off, off + 4);
    const data = Buffer.from(c.buf.subarray(off + 4, off + 4 + n));
    for (let i = 0; i < n; i++) data[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + n);
    if (op === 8) return close(c);
    if (op === 9) { frame(c, 10, data.subarray(0, 125)); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 0) {
      c.parts.push(data);
      c.partLen += n;
      if (c.partLen > MAX_MSG) return close(c, 1009);
      if (!fin) continue;
      const text = Buffer.concat(c.parts).toString('utf8');
      c.parts = []; c.partLen = 0;
      let m = null;
      try { m = JSON.parse(text); } catch { /* 忽略 */ }
      if (m && typeof m === 'object') onMsg(c, m).catch((e) => { log('msg error', e); send(c, { op: 'err', msg: '服务出错' }); });
      continue;
    }
    return close(c, 1003);
  }
}

// ---------- 排队 / 房间 / 对局 ----------
const queues = new Map();   // 服|模式|级别|上限 → [{ conns: [c…], at }]
const rooms = new Map();    // 邀请码 → { code, srv, mode, bracket, cap, conns: [] }
const matches = new Map();  // mid → { srv, conns: [c…]（按 p）, at }
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let s; do { s = Array.from(crypto.randomBytes(6), (x) => CODE_CH[x % CODE_CH.length]).join(''); } while (rooms.has(s)); return s; };
const qKey = (srv, mode, bracket, cap, skills) => `${srv}|${mode}|${bracket}|${cap}|${skills}`;
const SKILLS = ['esi', 'max'];
const MODES = { '1v1': 1, '2v2': 2 };

function leaveAll(c, why = null) {
  // 退出队列
  if (c.q) {
    const list = queues.get(c.q.key);
    const e = list?.find((x) => x.conns.includes(c));
    if (e) {
      list.splice(list.indexOf(e), 1);
      if (!list.length) queues.delete(c.q.key);
      // 组队的队友一起出队，回到房间等待
      for (const o of e.conns) if (o !== c) { o.q = null; send(o, { op: 'err', msg: `队友 ${c.name} 退出了排队` }); send(o, { op: 'idle' }); }
    }
    c.q = null;
  }
  if (c.room) {
    const R = rooms.get(c.room);
    if (R) {
      R.conns = R.conns.filter((x) => x !== c);
      if (!R.conns.length || R.conns[0] !== R.owner) {
        rooms.delete(R.code);
        for (const o of R.conns) { o.room = null; send(o, { op: 'err', msg: '房主离开了，邀请码失效' }); send(o, { op: 'idle' }); }
      } else roomUpdate(R);
    }
    c.room = null;
  }
  if (why) send(c, { op: 'idle' });
}
function roomUpdate(R) {
  for (const o of R.conns) send(o, { op: 'room', code: R.code, mode: R.mode, bracket: R.bracket, cap: R.cap, skills: R.skills, pub: R.pub, members: R.conns.map((x) => ({ name: x.name, ship: x.fit?.ship })) });
}
async function checkFit(c, fit, cap, skills) {
  if (!MATCH_CAPS.includes(cap)) throw new Error('装配价值上限不对');
  if (!SKILLS.includes(skills)) throw new Error('技能选项不对');
  // 全 5 级：工作线程按全部技能 5 级检查和开局
  const r = await call(c.srv, { t: 'check', fit, levels: skills === 'max' ? 'max' : c.levels });
  if (r.ok) r.v.levels = skills === 'max' ? 'max' : c.levels;
  if (!r.ok) throw new Error(r.err);
  if (cap && r.v.value > cap) throw new Error(`装配价值 ${(r.v.value / 1e6).toFixed(1)}M ISK 超过上限 ${cap / 1e6}M`);
  return r.v;
}
function enqueue(entry, key) {
  if (!queues.has(key)) queues.set(key, []);
  const list = queues.get(key);
  list.push(entry);
  const [, mode, bracket, cap, skills] = key.split('|');
  for (const c of entry.conns) { c.q = { key }; send(c, { op: 'queued', mode, bracket, cap: Number(cap), skills, value: c.check.value, n: list.reduce((s, e) => s + e.conns.length, 0) }); }
  tryMatch(key);
}
function tryMatch(key) {
  const list = queues.get(key);
  if (!list) return;
  const [srv, mode] = key.split('|');
  const per = MODES[mode];
  for (;;) {
    // 按排队先后凑出两队：每队 per 人（组队的两人必须在同一队）
    const teams = [];
    const used = new Set();
    for (const e of list) {
      if (used.has(e)) continue;
      if (e.conns.length === per) { teams.push([e]); used.add(e); }
      else {
        const mate = list.find((o) => o !== e && !used.has(o) && o.conns.length + e.conns.length === per);
        if (mate) { teams.push([e, mate]); used.add(e); used.add(mate); }
      }
      if (teams.length === 2) break;
    }
    if (teams.length < 2) break;
    for (const t of teams) for (const e of t) list.splice(list.indexOf(e), 1);
    startMatch(srv, teams.map((t) => t.flatMap((e) => e.conns)));
  }
  if (!list.length) queues.delete(key);
}
async function startMatch(srv, [A, B]) {
  const mid = crypto.randomUUID();
  const all = [...A.map((c) => [c, 'A']), ...B.map((c) => [c, 'B'])];
  for (const [c] of all) { c.q = null; c.room = null; c.mid = mid; }
  const players = all.map(([c, side], p) => ({ p, side, name: c.name, id: c.id, fit: c.check.fit, levels: c.check.levels, bracket: c.check.bracket, value: c.check.value }));
  const seed = crypto.randomBytes(4).readUInt32BE() || 1;
  matches.set(mid, { srv, conns: all.map(([c]) => c), at: Date.now() });
  const r = await call(srv, { t: 'start', mid, players, seed });
  if (!r.ok) { endMatch(mid, JSON.stringify({ op: 'end', winner: null, reason: 'error', t: 0, stats: [], msg: r.err })); return; }
  log('match', mid, srv, all.map(([c, s]) => `${s}:${c.name}`).join(' '));
  all.forEach(([c], p) => { c.p = p; send(c, { op: 'match', mid, you: p, info: r.v }); });
}
function endMatch(mid, msg) {
  const M = matches.get(mid);
  if (!M) return;
  matches.delete(mid);
  for (const c of M.conns) if (c && c.mid === mid) { send(c, msg); c.mid = null; c.p = null; }
  log('end', mid, msg.slice(0, 200));
}

async function onMsg(c, m) {
  // 每秒最多 30 条
  const now = Date.now();
  if (now - c.rateAt > 1000) { c.rateAt = now; c.rateN = 0; }
  if (++c.rateN > 30) return;
  if (m.op === 'hello') {
    if (c.id) return;
    if (!SERVERS.includes(m.server)) return send(c, { op: 'err', msg: '不支持的服务器' });
    // 本地测试：设了 EVE_MATCH_DEV_SKILLS（技能 JSON [[技能, 等级]…]）才收 token=dev 的假角色；生产不要设
    const r = DEV_SKILLS && m.token === 'dev' ? { ok: true, v: { id: Number(m.id) || 1, name: String(m.name || 'dev').slice(0, 30), levels: DEV_SKILLS } }
      : await call(m.server, { t: 'auth', id: Number(m.id), token: String(m.token || '') });
    if (!r.ok) return send(c, { op: 'err', msg: r.err, fatal: true });
    if (c.closed) return;
    Object.assign(c, { srv: m.server, id: r.v.id, name: r.v.name, levels: r.v.levels });
    const k = c.srv + ':' + c.id;
    const old = byChar.get(k);
    if (old && old !== c) { send(old, { op: 'err', msg: '这个角色在别处登录了匹配', fatal: true }); close(old); }
    byChar.set(k, c);
    send(c, { op: 'hi', id: c.id, name: c.name });
    // 对局中掉线又回来：接回原来的位置，从头重放到当前一步
    for (const [mid, M] of matches) {
      const p = M.conns.findIndex((o) => o && o.srv === c.srv && o.id === c.id);
      if (p < 0) continue;
      const r = await call(c.srv, { t: 'resume', mid, p });
      if (!r.ok || c.closed) break;
      M.conns[p] = c;
      Object.assign(c, { mid, p });
      send(c, { op: 'match', mid, you: p, info: r.v.info, log: r.v.log, s: r.v.s, rk: r.v.rk, started: r.v.started });
      break;
    }
    return;
  }
  if (!c.id) return send(c, { op: 'err', msg: '请先登录', fatal: true });
  if (m.op === 'act') { if (c.mid != null) tell(c.srv, { t: 'op', mid: c.mid, p: c.p, a: m.a }); return; }
  if (m.op === 'ready') { if (c.mid != null) tell(c.srv, { t: 'ready', mid: c.mid, p: c.p }); return; }
  if (m.op === 'leave') { if (c.mid != null) tell(c.srv, { t: 'leave', mid: c.mid, p: c.p }); return; }
  if (m.op === 'cancel') { leaveAll(c, 'cancel'); return; }
  if (m.op === 'rooms') {
    const list = [...rooms.values()].filter((R) => R.pub && R.srv === c.srv && R.conns.length < 2 && !R.conns.includes(c)).sort((a, b) => b.at - a.at).slice(0, 50)
      .map((R) => ({ code: R.code, mode: R.mode, bracket: R.bracket, cap: R.cap, skills: R.skills, owner: R.owner.name, ship: R.owner.fit?.ship }));
    return send(c, { op: 'rooms', list });
  }
  if (m.op === 'preset_pub') {
    if (Date.now() - (c.pubAt || 0) < 5000) return send(c, { op: 'err', msg: '发布太频繁，请稍等几秒' });
    c.pubAt = Date.now();
    const r = await call(c.srv, { t: 'preset', p: m.p });
    if (!r.ok) return send(c, { op: 'err', msg: r.err });
    const list = presets[c.srv];
    // 同一个人发布同名预设 = 更新
    const old = list.findIndex((x) => x.aid === c.id && x.name === r.v.name);
    if (old >= 0) list.splice(old, 1);
    else if (list.filter((x) => x.aid === c.id).length >= PRESET_PER) return send(c, { op: 'err', msg: `每人最多公开 ${PRESET_PER} 个预设，先删掉一个` });
    if (list.length >= PRESET_MAX) return send(c, { op: 'err', msg: '公开预设已满' });
    const p = { id: crypto.randomBytes(6).toString('hex'), ...r.v, author: c.name, aid: c.id, at: Date.now() };
    list.unshift(p);
    savePresets();
    log('preset', c.srv, c.name, p.name);
    return send(c, { op: 'preset_ok', id: p.id });
  }
  if (m.op === 'preset_del') {
    const list = presets[c.srv], i = list.findIndex((x) => x.id === m.id && x.aid === c.id);
    if (i < 0) return send(c, { op: 'err', msg: '只能删除自己发布的预设' });
    list.splice(i, 1);
    savePresets();
    return send(c, { op: 'preset_ok', id: m.id, del: true });
  }
  if (c.mid != null) return send(c, { op: 'err', msg: '对局进行中' });
  if (m.op === 'queue' || m.op === 'room') {
    if (!MODES[m.mode]) return send(c, { op: 'err', msg: '模式不对' });
    if (c.busy) return send(c, { op: 'err', msg: '正在检查上一套装配，请稍等' });
    c.busy = true;
    try {
      leaveAll(c);
      const cap = Number(m.cap) || 0;
      const skills = m.skills === 'max' ? 'max' : 'esi';
      c.check = await checkFit(c, m.fit, cap, skills);
      c.fit = c.check.fit;
      if (c.closed || c.mid != null) return;
      if (m.op === 'queue') enqueue({ conns: [c], at: Date.now() }, qKey(c.srv, m.mode, c.check.bracket, cap, skills));
      else {
        const R = { code: newCode(), srv: c.srv, mode: m.mode, bracket: c.check.bracket, cap, skills, pub: Boolean(m.pub), owner: c, conns: [c], at: Date.now() };
        rooms.set(R.code, R);
        c.room = R.code;
        roomUpdate(R);
      }
    } catch (e) { send(c, { op: 'err', msg: e.message }); send(c, { op: 'idle' }); } finally { c.busy = false; }
    return;
  }
  if (m.op === 'join') {
    const R = rooms.get(String(m.code || '').trim().toUpperCase());
    if (!R) return send(c, { op: 'err', msg: '邀请码不存在或已失效' });
    if (R.srv !== c.srv) return send(c, { op: 'err', msg: '邀请码是别的服务器的' });
    if (R.conns.includes(c)) return;
    if (c.busy) return send(c, { op: 'err', msg: '正在检查上一套装配，请稍等' });
    c.busy = true;
    try {
      leaveAll(c);
      c.check = await checkFit(c, m.fit, R.cap, R.skills);
      c.fit = c.check.fit;
      if (c.check.bracket !== R.bracket) throw new Error(`这个房间是${MATCH_BRACKETS[R.bracket].name}级别，你的船是${MATCH_BRACKETS[c.check.bracket].name}`);
      if (!rooms.has(R.code) || R.conns.length >= 2 || c.closed) throw new Error('房间已满或已关闭');
      R.conns.push(c);
      c.room = R.code;
      roomUpdate(R);
      // 满两人：1v1 直接开打；2v2 两人一起去排队
      rooms.delete(R.code);
      for (const o of R.conns) o.room = null;
      if (R.mode === '1v1') startMatch(R.srv, [[R.conns[0]], [R.conns[1]]]);
      else enqueue({ conns: R.conns.slice(), at: Date.now() }, qKey(R.srv, '2v2', R.bracket, R.cap, R.skills));
    } catch (e) { send(c, { op: 'err', msg: e.message }); send(c, { op: 'idle' }); } finally { c.busy = false; }
  }
}
function onClose(c) {
  if (c.gone) return;
  c.gone = true;
  c.closed = true;
  conns.delete(c);
  ipCount.set(c.ip, (ipCount.get(c.ip) || 1) - 1);
  if (byChar.get(c.srv + ':' + c.id) === c) byChar.delete(c.srv + ':' + c.id);
  leaveAll(c);
  // 对局中掉线：船留在原地照最后的指令飞，60 秒没回来判负（同方都掉线时）
  if (c.mid != null && matches.get(c.mid)?.conns[c.p] === c) tell(c.srv, { t: 'gone', mid: c.mid, p: c.p, on: true });
}

// ---------- HTTP ----------
const ipCount = new Map();
const clientIp = (req) => req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/match/status') {
    const q = {};
    for (const [k, l] of queues) q[k] = l.reduce((s, e) => s + e.conns.length, 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ online: conns.size, queues: q, rooms: rooms.size, matches: matches.size }));
    return;
  }
  const sv = u.searchParams.get('server');
  if ((u.pathname === '/api/match/presets' || u.pathname === '/api/match/preset') && presets[sv] && req.method === 'GET') {
    const one = u.pathname === '/api/match/preset' ? presets[sv].find((x) => x.id === u.searchParams.get('id')) : null;
    if (u.pathname === '/api/match/preset' && !one) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    // 生产同源（nginx 反代）；本地测试（没设 EVE_MATCH_ORIGINS）页面在别的端口，放开跨域
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(ORIGINS.length ? {} : { 'Access-Control-Allow-Origin': '*' }) });
    res.end(JSON.stringify(one || presets[sv].map(presetBrief)));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
srv.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  const ip = clientIp(req);
  if (u.pathname !== '/api/match/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key
      || (ORIGINS.length && !ORIGINS.includes(req.headers.origin)) || (ipCount.get(ip) || 0) >= PER_IP) {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const c = { sock, ip, buf: Buffer.alloc(0), parts: [], partLen: 0, seen: Date.now(), rateAt: 0, rateN: 0, closed: false, id: 0, mid: null, p: null, q: null, room: null };
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  conns.add(c);
  sock.on('data', (d) => onData(c, d));
  sock.on('close', () => onClose(c));
  sock.on('error', () => onClose(c));
});
// 心跳：20 秒 ping 一次，60 秒没有任何数据就断开
setInterval(() => {
  const now = Date.now();
  for (const c of conns) { if (now - c.seen > 60000) { close(c, 1001); onClose(c); } else frame(c, 9); }
}, 20000).unref();
srv.listen(PORT, HOST, () => log(`match service on ${HOST}:${PORT}`));
for (const s of (process.env.EVE_MATCH_PRELOAD || 'tq').split(',').filter((x) => SERVERS.includes(x))) worker(s);
