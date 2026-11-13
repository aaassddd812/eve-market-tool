// ===== 匹配对战：一个游戏服务器（宁静 / 晨曦 / 曙光）一个工作线程（由 match_service.mjs 启动）=====
// 每个线程按自己的服务器加载装配数据（国服有独有物品，见 js/server-extra.js），负责：
//   auth   用玩家浏览器里的 ESI 令牌读 /characters/{id}/skills/（令牌和角色对不上 ESI 会拒绝）→ 真实技能等级
//   check  检查装配（舰船级别、槽位、CPU / 电网 / 校准、技能、同组上限），按 ESI 平均价估装配价值
//   start  开一局：和驾驶模拟同一套装配换算（sim-unit pilotUnit）、战斗引擎（sim-engine）、驾驶规则（pilot-rules）；
//          每 0.5 秒走一步，玩家指令盖上步数后和这一步的校正数据一起发给所有玩家；胜负由这里判定
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRV = workerData.server;
// 站点目录（js/ 和 fit-data.json 等数据文件）：默认是本文件的上一级（仓库里），生产用 EVE_MATCH_ROOT 指到 /opt/eve/dist
const ROOT = path.resolve(process.env.EVE_MATCH_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const mod = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
// 前端模块读 localStorage「eve-server」决定当前服务器（js/server.js）
globalThis.localStorage = { getItem: (k) => (k === 'eve-server' ? SRV : null), setItem() {}, removeItem() {} };
// 前端模块用相对地址 fetch 数据文件：改成读站点目录里的文件
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (/^https?:/.test(s)) return realFetch(u, o);
  const f = path.join(ROOT, s.replace(/^\.\//, '').replace(/[?#].*$/, ''));
  if (!f.startsWith(ROOT + path.sep)) return new Response('', { status: 404 });
  try { return new Response(await readFile(f), { status: 200 }); } catch { return new Response('', { status: 404 }); }
};
const FE = await mod('js/fit-engine.js');
const { SERVER } = await import(pathToFileURL(path.join(ROOT, 'js/server.js')).href + '?v=s4');
const SU = await mod('js/sim-unit.js');
const { createBattle } = await mod('js/sim-engine.js');
const PR = await import(pathToFileURL(path.join(ROOT, 'js/pilot-rules.js')).href + '?v=v1');
const MS = await mod('js/match-sim.js');
const data = await FE.loadFitData('./fit-data.json');
SU.bindUnit({ FE, data }, {});

const DT_MS = 500;
const esi = (p) => `${SERVER.esi}${p}${p.includes('?') ? '&' : '?'}datasource=${SERVER.datasource}`;
const post = (m) => parentPort.postMessage(m);
const typeName = (id) => data.types.get(id)?.name || String(id);

// ---------- 价格：ESI /markets/prices/ 的平均价（没有就用调整价），3 小时刷新 ----------
let prices = new Map(), pricesAt = 0, pricesP = null;
async function loadPrices() {
  if (Date.now() - pricesAt < 3 * 3600e3 && prices.size) return prices;
  pricesP ||= realFetch(esi('/markets/prices/'), { signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('ESI ' + r.status))))
    .then((list) => { prices = new Map(list.map((x) => [x.type_id, x.average_price || x.adjusted_price || 0])); pricesAt = Date.now(); return prices; })
    .finally(() => { pricesP = null; });
  try { return await pricesP; } catch (e) { if (prices.size) return prices; throw e; }
}

// ---------- 身份：令牌必须属于这个角色 ----------
async function auth({ id, token }) {
  if (!Number.isInteger(id) || id <= 0 || typeof token !== 'string' || token.length > 4096) throw new Error('登录信息不对');
  const r = await realFetch(esi(`/characters/${id}/skills/`), { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('ESI 登录已失效或不是这个角色，请重新绑定');
  if (!r.ok) throw new Error('读取角色技能失败（ESI ' + r.status + '）');
  const sk = await r.json();
  const levels = (sk.skills || []).map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0]);
  const c = await realFetch(esi(`/characters/${id}/`), { signal: AbortSignal.timeout(15000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  return { id, name: c?.name || '角色 ' + id, levels };
}

// ---------- 装配检查 ----------
const MAX_GROUP_FITTED = 1544;
// 装配的结构检查：物品存在、槽位对、能装到这艘船上、弹药装得进；突变装备不收；
// 匹配（open = false）不收植入体和舰载机（令牌核实不了植入体；只开放到战列舰），公开预设（open = true）收
function cleanFit(f, ship, open = false) {
  const fit = { id: null, name: '', ship: ship.id, slots: {}, drones: [], implants: [] };
  for (const s of FE.SLOTS) {
    fit.slots[s] = (Array.isArray(f.slots?.[s]) ? f.slots[s] : []).slice(0, 8).map((m) => {
      if (!m) return null;
      const t = data.types.get(Number(m.type));
      if (!t) throw new Error('装配里有不认识的物品 ' + m.type);
      if (t.slot !== s) throw new Error(`${t.name}不能装在${FE.SLOT_NAME[s]}`);
      const why = FE.cannotFit(data, ship, t);
      if (why) throw new Error(`${t.name}：${why}`);
      const ch = m.charge ? data.types.get(Number(m.charge)) : null;
      const state = ['offline', 'online', 'active'].includes(m.state) ? m.state : m.state === 'overload' ? 'active' : 'online';
      // 突变装备不收（属性由客户端提交，服务器核实不了）
      return { type: t.id, state, charge: ch && FE.chargeFits(t, ch) ? ch.id : null };
    });
  }
  const drones = (Array.isArray(f.drones) ? f.drones : []).slice(0, 12);
  for (const d of drones) {
    const t = data.types.get(Number(d.type));
    if (!t || (t.category !== FE.CAT.drone && !(open && t.category === FE.CAT.fighter))) continue;
    const n = Math.max(1, Math.min(50, Math.round(Number(d.count) || 1)));
    const same = fit.drones.find((x) => x.type === t.id);
    const on = open ? Math.max(0, Math.min(n, Math.round(Number(d.active)) || 0)) : 0;
    if (same) { same.count += n; same.active += on; } else fit.drones.push({ type: t.id, count: n, active: on });
  }
  if (open) fit.implants = (Array.isArray(f.implants) ? f.implants : []).slice(0, 12).map(Number).filter((id) => data.types.get(id)?.category === FE.CAT.implant);
  return fit;
}
function check({ fit: f, levels }) {
  const lv = new Map(levels === 'max' ? allFive() : levels);
  const ship = data.types.get(Number(f?.ship));
  if (!ship || ship.category !== FE.CAT.ship) throw new Error('不是舰船');
  const bracket = PR.bracketOf(ship.group);
  if (!bracket) throw new Error(`${ship.name}这类舰船不能参加匹配（只开放护卫舰、驱逐舰、巡洋舰、战列巡洋舰、战列舰）`);
  const fit = cleanFit(f, ship);
  // 植入体不收：令牌只有技能权限，核实不了
  const miss = FE.missingSkills(data, fit, lv);
  if (miss.length) throw new Error('角色技能不够：' + miss.slice(0, 3).map((x) => `${x.type?.name || x.type} ${x.have}→${x.need}`).join('、') + (miss.length > 3 ? ` 等 ${miss.length} 个` : ''));
  const calc = FE.computeFit(data, fit, lv);
  if (!calc) throw new Error('装配算不出来');
  const st = FE.fitStats(calc);
  const R = st.resources || {};
  const NAME = { cpu: 'CPU', power: '电网', calibration: '校准值', turrets: '炮台安装座', launchers: '发射器安装座', droneBay: '无人机挂舱' };
  for (const k of Object.keys(NAME)) if (R[k] && R[k].used > R[k].total + 1e-6) throw new Error(`${NAME[k]}超出（${+R[k].used.toFixed(1)} / ${+R[k].total.toFixed(1)}）`);
  const cnt = st.slotCount || {};
  for (const s of FE.SLOTS) { const n = fit.slots[s].filter(Boolean).length; if (n > (cnt[s] ?? 8)) throw new Error(`${FE.SLOT_NAME[s]}只有 ${cnt[s] || 0} 个`); }
  const byGroup = new Map();
  for (const s of FE.SLOTS) for (const m of fit.slots[s]) if (m) {
    const t = data.types.get(m.type), lim = t.attrs.get(MAX_GROUP_FITTED);
    if (!lim) continue;
    const n = (byGroup.get(t.group) || 0) + 1;
    byGroup.set(t.group, n);
    if (n > lim) throw new Error(`${t.name}这一类最多装 ${lim} 个`);
  }
  // 无人机按带宽和可控数量放出（同 fitting.js autoActivateDrones）
  let bw = calc.ship.attr(FE.AT.droneBandwidth) || 0, lim = calc.char.attr(FE.AT.maxActiveDrones) || 0;
  for (const d of fit.drones) {
    const per = data.types.get(d.type).attrs.get(FE.AT.droneBandwidthUsed) || 0;
    while (d.active < d.count && lim > 0 && (per === 0 || bw >= per - 1e-9)) { d.active++; lim--; bw -= per; }
  }
  return { fit, bracket, ship: ship.id, shipName: ship.name };
}
// 公开预设：我的船（可带装配）、队友、敌人、开局距离、星空
const P_DISTS = [10, 20, 30, 50, 80], P_SKIES = ['', 'a01', 'c01', 'g01', 'm01'];
function cleanPreset(p) {
  const shipOf = (id) => { const t = data.types.get(Number(id)); if (!t || t.category !== FE.CAT.ship) throw new Error('预设里有不是舰船的物品'); return t; };
  const ship = shipOf(p?.ship);
  const name = String(p?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) throw new Error('预设要有名字');
  const foes = (Array.isArray(p.foes) ? p.foes : []).slice(0, 8).map((x) => ({ ship: shipOf(x?.ship).id, count: Math.max(1, Math.min(20, Math.round(Number(x?.count)) || 1)) }));
  if (!foes.length) throw new Error('预设里至少要有一个敌人');
  let fit = null;
  if (p.fit === 'hull') fit = 'hull';
  else if (p.fit && typeof p.fit === 'object') { fit = cleanFit(p.fit, ship, true); fit.name = String(p.fit.name || '').trim().slice(0, 40); }
  // 队友（AI）：常见装配或空船
  const allies = (Array.isArray(p.allies) ? p.allies : []).slice(0, 8).map((x) => ({ ship: shipOf(x?.ship).id, count: Math.max(1, Math.min(20, Math.round(Number(x?.count)) || 1)), fit: x?.fit === 'hull' ? 'hull' : 'kb' }));
  return { name, ship: ship.id, fit, foes, allies, dist: P_DISTS.includes(p.dist) ? p.dist : 30, sky: P_SKIES.includes(p.sky) ? p.sky : '' };
}
// 全部技能 5 级（匹配选「全 5 级」时用）
let ALL5 = null;
const allFive = () => (ALL5 ||= [...data.types.values()].filter((t) => t.category === FE.CAT.skill).map((t) => [t.id, 5]));
async function value(fit) {
  const p = await loadPrices();
  let v = p.get(fit.ship) || 0;
  for (const s of FE.SLOTS) for (const m of fit.slots[s]) if (m) v += p.get(m.type) || 0;
  for (const d of fit.drones) v += (p.get(d.type) || 0) * d.count;
  return Math.round(v);
}

// ---------- 对局 ----------
const matches = new Map();
function startMatch({ mid, players, seed }) {
  const dist = PR.MATCH_BRACKETS[players[0].bracket]?.dist || 30;
  const info = { seed, dist, max: PR.MATCH_MAX, players: players.map((x) => ({ p: x.p, side: x.side, name: x.name, id: x.id, fit: x.fit, levels: x.levels === 'max' ? allFive() : x.levels, value: x.value })) };
  const M = Object.assign(MS.buildMatch({ pilotUnit: SU.pilotUnit, createBattle }, info), { mid, ready: new Set(), ended: false, timer: null });
  for (const x of M.P) Object.assign(x, { ops: [], gone: 0 });
  M.info = info;
  M.log = [];   // 每一步执行的指令（掉线重连的人从头重放）
  matches.set(mid, M);
  // 等所有人建好画面（最多 40 秒）
  M.wait = setTimeout(() => go(M), 40000);
  return { ...info, players: info.players.map((x) => ({ ...x, unit: M.P[x.p].unit })) };
}
function go(M) {
  if (M.timer || M.ended) return;
  clearTimeout(M.wait);
  M.timer = setInterval(() => step(M), DT_MS);
  post({ t: 'go', mid: M.mid });
}
function step(M) {
  const b = M.b;
  const ops = [];
  for (const x of M.P) {
    for (const a of x.ops.splice(0)) {
      if (!x.S.me?.alive) continue;
      if (a.a === 'ammo') {
        // 弹药要装得进这件装备
        const m = x.S.on.rack[a.m], mt = m && data.types.get(m.type), ct = data.types.get(a.type);
        if (!mt || !ct || !FE.chargeFits(mt, ct)) continue;
      }
      ops.push([x.p, a]);
    }
  }
  MS.stepMatch(M, ops);
  M.log.push(ops);
  post({ t: 'tick', mid: M.mid, msg: JSON.stringify({ op: 'tick', k: M.k, ops, s: b.snap(), rk: M.P.map((x) => PR.rackSnap(x.S)) }) });
  // 胜负：一方玩家的船全被击毁；到时间按剩余血量比例；一方全部掉线 60 秒以上判负
  const alive = (s) => M.P.some((x) => x.side === s && x.S.me.alive);
  const away = (s) => M.P.filter((x) => x.side === s).every((x) => x.gone && Date.now() - x.gone > 60000);
  let res = null;
  if (!alive('A') || !alive('B')) res = { winner: alive('A') ? 'A' : alive('B') ? 'B' : null, reason: 'kill' };
  else if (away('A') || away('B')) res = { winner: away('A') ? (away('B') ? null : 'B') : 'A', reason: 'away' };
  else if (b.t >= PR.MATCH_MAX) {
    const hp = (s) => { const l = M.P.filter((x) => x.side === s).map((x) => x.S.me); return l.reduce((a, u) => a + u.hp[0] + u.hp[1] + u.hp[2], 0) / (l.reduce((a, u) => a + u.t.max[0] + u.t.max[1] + u.t.max[2], 0) || 1); };
    const a = hp('A'), c = hp('B');
    res = { winner: Math.abs(a - c) < 0.01 ? null : a > c ? 'A' : 'B', reason: 'time', hp: { A: a, B: c } };
  }
  if (res) end(M, res);
}
function end(M, res) {
  if (M.ended) return;
  M.ended = true;
  clearInterval(M.timer);
  clearTimeout(M.wait);
  const stats = M.P.map((x) => ({ p: x.p, side: x.side, name: x.name, alive: x.S.me.alive, dealt: Math.round(x.S.me.r.dealt), taken: Math.round(x.S.me.r.taken) }));
  post({ t: 'end', mid: M.mid, msg: JSON.stringify({ op: 'end', ...res, t: Math.round(M.b.t), stats }) });
  matches.delete(M.mid);
}
// 自毁 / 退出：船直接算被击毁
function selfDestruct(M, x) {
  const u = x.S.me;
  if (!u?.alive) return;
  u.hp = [0, 0, 0];
  u.alive = false;
  u.r.lost += 1;
  M.b.kills.push({ t: Math.ceil(M.b.t), at: M.b.t, side: u.side, ship: u.r.row.ship, row: u.r, unit: u.i, by: u.i, drone: false });
}

parentPort.on('message', async (m) => {
  try {
    if (m.t === 'auth') post({ t: 'res', rid: m.rid, ok: true, v: await auth(m) });
    else if (m.t === 'check') { const r = check(m); r.value = await value(r.fit); post({ t: 'res', rid: m.rid, ok: true, v: r }); }
    else if (m.t === 'preset') post({ t: 'res', rid: m.rid, ok: true, v: cleanPreset(m.p) });
    else if (m.t === 'start') post({ t: 'res', rid: m.rid, ok: true, v: startMatch(m) });
    else if (m.t === 'resume') {
      const M = matches.get(m.mid);
      if (!M) throw new Error('对局已结束');
      M.P[m.p].gone = 0;
      post({ t: 'res', rid: m.rid, ok: true, v: { info: { ...M.info, players: M.info.players.map((x) => ({ ...x, unit: M.P[x.p].unit })) }, log: M.log, s: M.b.snap(), rk: M.P.map((x) => PR.rackSnap(x.S)), started: Boolean(M.timer) } });
    } else if (m.t === 'ready') { const M = matches.get(m.mid); if (M) { M.ready.add(m.p); if (M.ready.size >= M.P.length) go(M); } }
    else if (m.t === 'op') {
      const M = matches.get(m.mid), x = M?.P[m.p];
      if (!x) return;
      const a = PR.cleanOp(m.a, M.b.units.length, x.nRack);
      if (a && x.ops.length < 20) x.ops.push(a);
    } else if (m.t === 'gone') { const x = matches.get(m.mid)?.P[m.p]; if (x) x.gone = m.on ? Date.now() : 0; }
    else if (m.t === 'leave') { const M = matches.get(m.mid), x = M?.P[m.p]; if (x) { x.ops.length = 0; selfDestruct(M, x); } }
  } catch (e) {
    if (m.rid) post({ t: 'res', rid: m.rid, ok: false, err: e.message || String(e) });
  }
});
// 价格先拉好（第一次检查装配就不用等）
loadPrices().catch((e) => console.error('prices', SRV, e.message));
post({ t: 'up', server: SRV, types: data.types.size });
