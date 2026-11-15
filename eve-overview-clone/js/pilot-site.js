// ===== 驾驶模拟 · 场景（死亡空间复合体、深渊）=====
// 场景定义在 pilot-sites.js（房间、建筑、加速门 / 导管、每波刷怪和触发条件，按社区攻略整理），
// NPC 属性在 npc-data.json（tools/build-npc-data.mjs 从 SDE 抽），NPC → 战斗单位在 sim-npc.js。
// 房间（口袋）：各在一个远处的独立网格上（死亡空间沿 +y 每隔 ROOM_GAP 一个；深渊每个房间离得更远、没有天体）。
//   进房间 = 落地（死亡空间：加速门跃迁；深渊：导管瞬移）。房间里的建筑也是 NPC 单位（不动），加速门 / 导管是天体（cel）。
// 触发（wave.on）：'enter' 进房间就刷；{ clear: 波次 } 那一波全灭；{ kill: 建筑 } 某个建筑被打掉；{ near: 建筑或门, d: 米 } 靠近；
//   { t: 秒 } 进房间后多久；{ after: 波次, t: 秒 } 某一波刷出后多久。门可以带 lock（同样的条件，满足前激活不了）。
// 加速门：2,500 m 内右键「激活加速门」，不用对准、直接跃迁到下一个房间（客户端 Activate Gate；距离限制是游戏里的 2,500 m）。
//   门可限制舰船（ships：允许的舰船分组 ID），不合规的船激活失败（客户端提示「你的舰船不能使用这个加速门」）。
// 深渊：计时 20 分钟（到点舰船被摧毁）、每个房间有边界（出界受伤）、天气（玩家和 NPC 都受影响）、导管 2,500 m 内激活；
//   最后一个房间的起源导管把你送回普通空间 = 完成。
import { SITES } from './pilot-sites.js?v=6';
import { npcUnit } from './sim-npc.js?v=3';

let H = null;   // 钩子：{ S, ctx, esc, tr, log(text, kind), msg(text), finish(won, text), FE }
export function initSite(hooks) { H = hooks; }
export const siteList = () => SITES;
export const siteById = (id) => SITES.find((s) => s.id === id) || null;

const AU = 149597870700;
const ROOM_GAP = 2 * AU;        // 死亡空间：房间间距
const ABYSS_GAP = 1e10;         // 深渊：房间间距（瞬移过去，远一点免得互相在一个网格里）
const GATE_RANGE = 2500;        // 激活加速门 / 导管的距离
const ACCEL_GATE = 366;         // 加速门组
const KM = 1000;

// ---------- NPC 数据 ----------
let ND = null, ndP = null;
export const loadNpcData = () => (ndP ||= fetch('npc-data.json?v=3').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
  ND = d;
  // NPC 类型挂进装配数据的类型表：名字、总览图标（按组）、过滤、选中物体窗口都照舰船那套走
  const types = H.ctx.data?.types;
  if (d && types) for (const [k, n] of Object.entries(d.npc)) {
    const id = Number(k);
    if (types.has(id)) continue;
    types.set(id, { id, name: n.n[0], en: n.n[1], group: n.g, category: 11, market: 0, meta: 0, attrs: new Map(Object.entries(n.a).map(([a, v]) => [Number(a), v])), effects: [], dflt: 0, slot: null, turret: false, launcher: false, activatable: false, overloadable: false, skills: [], npc: true });
  }
  return d;
}));
const EN = () => window.I18N?.lang === 'en';
const L = (o, k = 'name') => (EN() && o[k + 'En'] != null ? o[k + 'En'] : EN() && k === 'name' && o.en ? o.en : o[k]);   // 场景、门的英文名
// 层：死亡空间第 0 层是入口（只有入口加速轨道），进去是第 1 层、第 2 层…；深渊从第 1 层开始（客户端「空间层」）
const layerNo = (st, k) => (st.abyss ? k + 1 : k);
const roomName = (st, k) => (!st.abyss && st.rooms[k]?.def.entry ? (EN() ? 'Entrance' : '入口') : EN() ? `Pocket ${layerNo(st, k)}` : `第 ${layerNo(st, k)} 层`);
const layerCount = (def) => def.rooms.filter((r) => !r.entry).length;
const npcTypeName = (id) => H.ctx.data.types.get(id)?.name || npcName(id);
const npcName = (id) => { const n = ND?.npc?.[id]; return n ? (window.I18N?.lang === 'en' ? n.n[1] : n.n[0]) : String(id); };
export const dungeonInfo = (id) => ND?.dun?.[id] || null;

// 天气对 NPC：天气的加成（PostPercent）直接改 NPC 自己的属性（炮台射程在 NPC 身上，所以模块上的加成也算到它自己）
function withEnv(n, envIds) {
  if (!envIds?.length) return n;
  const a = { ...n.a };
  for (const id of envIds) {
    const e = H.ctx.data.env?.get(id), seen = new Set();
    // 同一个属性可能既作用在船上又作用在模块上（比如暗物质的射程：船 + 炮台），NPC 只有一份属性，只算一次
    for (const [, , attr, op, value] of e?.mods || []) if (op === 6 && attr in a && !seen.has(attr)) { seen.add(attr); a[attr] = a[attr] * (1 + value / 100); }
  }
  return { ...n, a };
}
const rowCache = new Map();
function npcRow(type, envIds) {
  const k = type + '|' + (envIds || []).join(',');
  if (!rowCache.has(k)) {
    const n = ND?.npc?.[type];
    if (!n) return null;
    const unit = npcUnit({ id: type, ...withEnv(n, envIds) }, ND.msl);
    rowCache.set(k, { id: 'n' + type, ship: type, label: npcName(type), unit, npc: true });
  }
  return rowCache.get(k);
}

// 刷 NPC：自由无人机护卫舰（深渊 Tessella / Vila Swarmer）记下来，异常自动装置抑制器会打它们（EVE Uni：打导弹、无人机和自由无人机护卫舰）
function deployNpc(side, row, count, pos) {
  const { S } = H;
  const n0 = S.b.units.length;
  S.b.deploy(side, { rows: [{ row, count }], pos, mode: 'here', name: row.label });
  const units = S.b.units.slice(n0), n = ND?.npc?.[row.ship];
  if (n?.g === 1997 && /Tessella|Swarmer/.test(n.n[1])) for (const u of units) u.droneFrig = true;
  return units;
}

// ---------- 进场 ----------
// 场景状态 S.site：{ def, room（当前房间序号）, rooms: [{ pos, entered, t0, waves: Map(key → { units, at }), objs: Map(key → 单位或天体序号), done }], t0（开始时间）, end }
// 深渊：每个等级一个场景（pool = 这个等级的刷怪池），开纤维时随机出这一趟的 3 个房间、天气强度、星空、气云 / 塔
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
// 按权重抽：w[k] = 第 k 项的权重
const pickW = (w) => { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let k = 0; k < w.length; k++) if ((r -= w[k]) < 0) return k; return w.length - 1; };
// 实测统计的房间（T6，parts）：主体每个 NPC 按实测数量频率抽，总数要落在实测范围里、并且有这类房间的标志舰；护卫按实测概率整组出现
function rollParts(sp) {
  const out = [];
  sp.parts.forEach((pt, pi) => {
    if (pi && Math.random() >= pt.p) return;
    let n = null;
    for (let k = 0; k < 60; k++) {
      const c = pt.g.map(([, h]) => pickW(h));
      const tot = c.reduce((a, b) => a + b, 0);
      if (tot >= pt.tot[0] && tot <= pt.tot[1] && (!pt.need?.length || pt.g.some(([t], i) => c[i] && pt.need.includes(t)))) { n = c; break; }
      if (!n && tot) n = c;   // 一直不满足就用最后一次有船的
    }
    pt.g.forEach(([t], i) => { if (n?.[i]) out.push([t, n[i]]); });
  });
  return out.map(([t, c], gi) => {
    const a = 2 * Math.PI * gi / out.length + 0.4;
    return { key: 'w' + gi, on: 'enter', at: [Math.round(Math.sin(a) * 40) / 10, 0, 25 + Math.round(Math.cos(a) * 40) / 10], npcs: [[t, c]] };
  });
}
function rollRoom(sp) {
  if (sp.parts) return rollParts(sp);
  const n = sp.g.map(([a, b]) => randInt(a, b));
  // 资料写了「每房最多几艘」的：超了就从能减的组里随机减
  const cap = sp.max || Infinity;
  for (let tot = n.reduce((x, y, i) => x + (sp.g[i][3] ? 0 : y), 0); tot > cap; tot--) {
    const can = n.map((c, i) => (c > sp.g[i][0] && !sp.g[i][3] ? i : -1)).filter((i) => i >= 0);
    if (!can.length) break;
    n[pick(can)]--;
  }
  // 一艘都没抽到：随便一组给 1 艘
  if (!n.some((c, i) => c && !sp.g[i][3])) { const i = pick(sp.g.map((g, i) => (g[3] ? -1 : i)).filter((i) => i >= 0)); n[i] = 1; }
  const waves = [];
  sp.g.forEach(([, , ids, opt], gi) => {
    if (!n[gi]) return;
    const m = new Map();
    for (let k = 0; k < n[gi]; k++) { const t = pick(ids); m.set(t, (m.get(t) || 0) + 1); }
    const a = 2 * Math.PI * gi / sp.g.length + 0.4;
    waves.push({ key: 'w' + gi, on: 'enter', at: [Math.round(Math.sin(a) * 40) / 10, 0, 25 + Math.round(Math.cos(a) * 40) / 10], npcs: [...m], ...(opt ? { opt: true } : {}) });
  });
  return waves;
}
export function siteInstance(def, wxName) {
  if (!def?.pool) return def;
  const wx = def.wx[wxName] || def.wx[pick(Object.keys(def.wx))];
  const li = randInt(0, wx.b.length - 1);
  const types = Object.entries(def.objs);
  const rooms = def.rooms.map((_, ri) => {
    // 有实测出现次数（n）的按次数加权
    const sp = def.pool[0].n ? def.pool[pickW(def.pool.map((x) => x.n))] : pick(def.pool);
    const last = ri === def.rooms.length - 1;
    const objs = [
      { key: 'c', kind: 'conduit', type: last ? 47686 : 47685, at: [0, 0, 25], lock: 'room', exit: last },
      { key: 'cache', kind: 'struct', type: 47951, at: [12, 0, 5] },
    ];
    const want = [];
    if (Math.random() < 0.6) want.push('cloud');
    if (Math.random() < 0.3) want.push('cloud');
    // 塔：有实测分布（towers：每房几座、各类型出现次数）就照实测，没有就按等级概率出 0-1 座
    if (def.towers) { const tt = Object.keys(def.towers.types); for (let k = pickW(def.towers.hist); k > 0; k--) want.push(['tower', tt[pickW(tt.map((t) => def.towers.types[t]))]]); }
    else if (Math.random() < def.tower) want.push('tower');
    want.forEach((w, oi) => {
      const kind = Array.isArray(w) ? w[0] : w;
      const [t, o] = Array.isArray(w) ? [w[1], def.objs[w[1]]] : pick(types.filter(([, o]) => o.kind === kind));
      // 塔放在导管附近（敌人那边），气云在口袋中间一带
      const p = kind === 'tower' ? [randInt(-12, 12), 0, randInt(12, 26)] : [randInt(-10, 10), 0, randInt(-8, 12)];
      objs.push({ key: 'z' + oi, kind, type: Number(t), at: p, r: o.r, zone: o.zone, slot: o.slot });
    });
    return { spawn: [0, 0, -25], waves: rollRoom(sp), objs, clearMsg: '导管已开启', spawnId: sp.id, f: sp.f, room: sp.name, note: sp.note, inf: sp.inf };
  });
  return { ...def, weather: wx.b[li], wxLv: def.lv[li], cover: wx.cover, sky: pick(def.skies), rooms };
}
export function siteStart(def) {
  const { S } = H;
  const abyss = def.kind === 'abyss';
  const gap = abyss ? ABYSS_GAP : ROOM_GAP;
  // 房间在交战点上方（避开行星轨道面）一个个排开
  const rooms = def.rooms.map((r, k) => ({ def: r, pos: [0, (k + 1) * gap, 0], entered: false, t0: 0, waves: new Map(), objs: new Map(), done: false }));
  S.site = { def, abyss, rooms, room: -1, t0: S.b.t, env: abyss && def.weather ? [def.weather] : [], end: 0, out: 0, bounty: 0 };
  // 门 / 导管放进天体表（总览、右键、选中物体窗口都按天体处理）
  rooms.forEach((R, k) => {
    for (const o of R.def.objs || []) {
      if (o.kind === 'cloud') {
        // 深渊气云：总览里是「深渊危险效果」组的物体（不能打、不能激活），在这里当天体
        const n = ND?.npc?.[o.type];
        R.objs.set(o.key, { cel: S.b.cel.length });
        S.b.cel.push({ name: n ? (EN() ? n.n[1] : n.n[0]) : String(o.type), group: n?.g || 1971, type: o.type, typeName: n ? (EN() ? n.n[1] : n.n[0]) : '', pos: at(R, o.at), radius: o.r, land: 0, site: { room: k, key: o.key, kind: 'cloud' } });
        continue;
      }
      if (o.kind !== 'gate' && o.kind !== 'conduit') continue;
      const n = ND?.npc?.[o.type];
      const c = { name: o.name ? L(o) : n ? (EN() ? n.n[1] : n.n[0]) : EN() ? 'Acceleration Gate' : '加速门', group: o.kind === 'gate' ? ACCEL_GATE : (n?.g || ACCEL_GATE), type: o.type || 0, typeName: n ? (window.I18N?.lang === 'en' ? n.n[1] : n.n[0]) : '', pos: at(R, o.at), radius: o.r || n?.r || 2000, land: 0, site: { room: k, key: o.key, kind: o.kind, to: o.to ?? k + 1, ships: o.ships || null, lock: o.lock || null, deny: o.deny || null, needKey: o.needKey || 0, exit: Boolean(o.exit) } };
      R.objs.set(o.key, { cel: S.b.cel.length });
      S.b.cel.push(c);
    }
  });
  enterRoom(0, true);
}
const at = (R, km) => [R.pos[0] + (km?.[0] || 0) * KM, R.pos[1] + (km?.[1] || 0) * KM, R.pos[2] + (km?.[2] || 0) * KM];

function enterRoom(k, first = false) {
  const { S } = H;
  const st = S.site, R = st.rooms[k];
  if (!R) return;
  st.room = k;
  R.entered = true;
  R.t0 = S.b.t;
  // 进场：第一个房间直接放到落点；之后由加速门跃迁 / 导管瞬移过来
  if (first || st.abyss) {
    // 入口：落在入口加速轨道旁（总览距离 0 km 左右）
    const g = R.def.spawn === 'gate' ? S.b.cel[R.objs.get('g')?.cel] : null;
    const p = g ? [g.pos[0], g.pos[1], g.pos[2] - (g.radius || 0) - S.me.t.radius - 300] : at(R, R.def.spawn);
    for (const u of S.b.units) if (u.side === S.me.side && u.alive && !u.isDrone) S.b.teleport(u, [p[0] + (u === S.me ? 0 : (Math.random() - 0.5) * 3000), p[1], p[2] + (u === S.me ? 0 : (Math.random() - 0.5) * 3000)]);
  } else {
    // 加速门：队友跟着一起过门（游戏里每个人自己激活；AI 队友这里直接落到你旁边）
    for (const u of S.b.units) if (u.side === S.me.side && u !== S.me && u.alive && !u.isDrone) S.b.teleport(u, [S.me.pos[0] + (Math.random() - 0.5) * 3000, S.me.pos[1], S.me.pos[2] + (Math.random() - 0.5) * 3000]);
  }
  // 建筑（会被打的 NPC 单位）
  for (const o of R.def.objs || []) {
    if (o.kind === 'gate' || o.kind === 'conduit' || o.kind === 'cloud' || R.objs.has(o.key)) continue;
    const row = npcRow(o.type, st.env);
    if (!row) continue;
    const [u] = deployNpc(S.me.side === 'A' ? 'B' : 'A', row, 1, at(R, o.at));
    if (u) { u.siteObj = o.key; R.objs.set(o.key, { unit: u }); }
  }
  // 气云 / 塔的作用范围（引擎 B.zones：范围内所有舰船，敌我都算；塔被打掉就失效）
  S.b.zones.length = 0;
  for (const o of R.def.objs || []) {
    if (!o.zone) continue;
    const { buffs, dmg, cycle, ...mods } = o.zone;
    S.b.zones.push({ pos: at(R, o.at), r: o.r, mods, dmg, cycle, buffs, slot: o.slot, unit: R.objs.get(o.key)?.unit || null });
  }
  H.envFx?.(roomFx(R));
  if (!R.def.entry) H.log(`进入第 ${layerNo(st, k)} 层${R.def.room || R.def.f ? ` · ${R.def.room || R.def.f}` : ''}`, 'sys');
}

// 条件
function cond(R, c) {
  const { S } = H;
  if (!c) return true;
  if (c === 'enter') return R.entered;
  if (c === 'room') return roomClear(R);
  // { hp: 建筑或波次里的 Boss, layer: 0 护盾 / 1 装甲 / 2 结构, below: 比例 }：打到某一层以下
  if (c.hp) {
    const o = R.objs.get(c.hp), u = o?.unit || R.waves.get(c.hp)?.units[0];
    return Boolean(u) && (!u.alive || u.hp[c.layer || 0] < (c.below ?? 1) * u.t.max[c.layer || 0]);
  }
  if (c.t != null && c.after == null) return S.b.t - R.t0 >= c.t;
  if (c.after) { const w = R.waves.get(c.after); return Boolean(w) && S.b.t - w.at >= (c.t || 0); }
  if (c.clear) { const keys = [].concat(c.clear); return keys.every((x) => { const w = R.waves.get(x); return w && w.units.every((u) => !u.alive); }); }
  if (c.kill) { const o = R.objs.get(c.kill); return Boolean(o?.unit) && !o.unit.alive; }
  if (c.near) {
    const o = R.objs.get(c.near), me = S.me;
    const p = o?.unit ? o.unit.pos : o?.cel != null ? S.b.cel[o.cel].pos : null;
    return Boolean(p) && Math.hypot(p[0] - me.pos[0], p[1] - me.pos[1], p[2] - me.pos[2]) <= (c.d || 20000);
  }
  if (c.all) return c.all.every((x) => cond(R, x));
  if (c.any) return c.any.some((x) => cond(R, x));
  return false;
}
// 房间清完：刷出来的波次全灭（opt 的不算，比如深渊的 Vila Swarmer）；还没刷的波次只看开局就在的（'enter'）
const roomClear = (R) => (R.def.waves || []).every((w) => w.opt || (R.waves.has(w.key) ? R.waves.get(w.key).units.every((u) => !u.alive) : w.on !== 'enter'));

// 每步（afterStep）：刷怪、深渊计时 / 边界、完成判定
export function siteTick() {
  const { S } = H;
  const st = S.site;
  if (!st || S.ended) return;
  const R = st.rooms[st.room];
  // 先飞到门边再激活
  if (st.nav) {
    const c = S.b.cel[st.nav.i];
    if (!S.me.alive || S.me.warp || S.me.pilot?.cmd !== 'point') st.nav = null;
    else if (c && gateDist(c, S.me) <= GATE_RANGE) activate(st.nav.i);
  }
  // 跃迁落地 → 进房间
  if (!S.me.warp && st.pend != null) {
    const T = st.rooms[st.pend];
    if (T && Math.hypot(S.me.pos[0] - T.pos[0], S.me.pos[1] - T.pos[1], S.me.pos[2] - T.pos[2]) < 300 * KM) { st.pend = null; enterRoom(st.rooms.indexOf(T)); }
  }
  if (R && R.entered) {
    for (const w of R.def.waves || []) {
      if (R.waves.has(w.key) || !cond(R, w.on)) continue;
      const side = S.me.side === 'A' ? 'B' : 'A', units = [];
      for (const [type, count] of w.npcs) {
        const row = npcRow(type, st.env);
        if (!row) continue;
        units.push(...deployNpc(side, row, count, at(R, w.at || [0, 0, 30])));
      }
      R.waves.set(w.key, { units, at: S.b.t });
      if (w.msg) H.msg(w.msg);
      if (w.boss) for (const u of units) u.siteBoss = true;
    }
    if (!R.done && roomClear(R)) {
      R.done = true;
      if (R.def.clearMsg) H.msg(R.def.clearMsg);
    }
    // 死亡空间完成：最后一个房间的 win 条件（一般是打掉头目），没写就是清完房间
    if (!st.abyss && R.def.final && !st.end && (R.def.win ? cond(R, R.def.win) : R.done)) { finish(true); return; }
  }
  // 赏金
  for (const k of S.b.kills.slice(st.killN || 0)) { const u = S.b.units[k.unit]; if (u?.t.npc) st.bounty += u.t.bounty || 0; }
  st.killN = S.b.kills.length;
  if (st.abyss) {
    // 深渊计时：到点舰船被摧毁
    const left = (st.def.time || 1200) - (S.b.t - st.t0);
    if (left <= 0 && S.me.alive) { H.log('跃迁力场崩塌，你的舰船被摧毁了', 'bad'); S.b.hurt(S.me, Infinity); return; }
    // 崩塌警告（客户端 UI/Abyss/AbyssalCollapseWarning*）：剩 60 / 30 / 10 秒时各提示一次（提示的时间点是自己定的）
    for (const w of [60, 30, 10]) if (left <= w && !(st.warned ||= new Set()).has(w)) { st.warned.add(w); H.msg(`跃迁力场崩塌警告：距灾难性的跃迁力场崩塌还有${w}秒`); }
    // 边界：出了房间半径，每秒按结构比例受伤（客户端只说「出界会受到伤害」，数值拿不准）
    const r = st.def.bound || 75000;
    if (R && Math.hypot(S.me.pos[0] - R.pos[0], S.me.pos[1] - R.pos[1], S.me.pos[2] - R.pos[2]) > r) {
      if (!st.out) { st.out = S.b.t; H.msg('你已离开深渊口袋的安全范围，舰船正在受到伤害'); }
      S.b.hurt(S.me, (S.me.t.max[0] + S.me.t.max[1] + S.me.t.max[2]) * 0.02 * 0.5);   // 每秒总血量的 2%（自己定的）
    } else st.out = 0;
  }
}

// ---------- 加速门 / 导管 ----------
export function gateOf(i) { return H.S.b?.cel?.[i]?.site || null; }
// 右键天体菜单的额外项
export function gateItems(i) {
  const g = gateOf(i);
  if (!g || (g.kind !== 'gate' && g.kind !== 'conduit')) return [];
  // 客户端 menusvc：加速轨道和深渊导管都是 UI/Inflight/ActivateGate「激活加速轨道」
  return [['激活加速轨道', () => activate(i)]];
}
const gateDist = (c, me) => Math.max(0, Math.hypot(c.pos[0] - me.pos[0], c.pos[1] - me.pos[1], c.pos[2] - me.pos[2]) - (c.radius || 0) - me.t.radius);
// 客户端 GetCloseAndTryCommand → autoPilot.NavigateSystemTo：不在 2,500 m 内就先飞过去，到了再激活（中途下别的移动命令就取消）
export function activate(i) {
  const { S } = H;
  const c = S.b.cel[i], g = c?.site, me = S.me;
  if (!g || (g.kind !== 'gate' && g.kind !== 'conduit') || !me?.alive) return;
  const st = S.site;
  if (gateDist(c, me) > GATE_RANGE) {
    H.approach(i);
    st.nav = { i };
    return;
  }
  st.nav = null;
  const R = st.rooms[g.room];
  // 锁住：清怪才开的门 = 客户端 DunGateNPCsAround；要钥匙的门 = DunGateLocked_OneKey
  if (g.lock && !cond(R, g.lock)) { H.msg(g.kind === 'gate' ? '该加速轨道被锁！这个地区的所有敌对分子都有同步轨道扰频器。除非你能直接进入一艘敌舰内部来解除干扰信号，否则必须清除附近的所有敌舰。快拿起武器吧！' : '该加速轨道被锁！'); return; }
  if (g.needKey) { H.msg(`该加速轨道被锁！若要激活加速轨道，你必须拿到${npcTypeName(g.needKey)}，并把它放在货柜舱内，这样才能解锁。剩下的问题是，负责看守轨道的是谁(或者什么)？`); return; }
  const grp = H.ctx.data.types.get(me.r.row.ship)?.group;
  if ((g.ships && !g.ships.includes(grp)) || g.deny?.includes(grp)) { H.msg(`这条加速轨道的配置不支持你的${H.ctx.data.types.get(me.r.row.ship)?.name || ''}。`); return; }
  if (g.exit) { H.log('通过起源导管返回普通空间', 'good'); finish(true); return; }
  const T = st.rooms[g.to];
  if (!T) return;
  if (st.abyss) {
    // 客户端 JumpOutAbyssalBetween：看导管 → 进隧道 → 3.7 秒换到下一层（ApplyDestinationScene）→ 5 秒船重新出现
    if (st.jumping) return;
    st.jumping = true;
    const to = g.to, go = () => { if (S.site === st) enterRoom(to); };
    if (!H.jumpFx?.(i, { onMid: go, onEnd: () => { st.jumping = false; } })) { st.jumping = false; H.fade?.(); go(); }
    return;
  }
  const r = S.b.gateWarp(me, T.pos, roomName(st, g.to));
  if (r === true) { st.pend = g.to; H.msg('加速轨道正在启动。'); }   // 客户端 UI/Sessions/AreUsingAccelerationGate
  else if (r === 'scram') H.msg('你的舰船被跃迁扰断，无法激活加速轨道');
}

// 增益栏（客户端 buffBarConst）：深渊天气一直在；气云 / 塔在范围里才有。返回 [[槽位, 提示里的数值行]]
const WX_SLOT = { electricstorm: 'wxElec', darkness: 'wxDark', caustictoxin: 'wxCaustic', xenongas: 'wxXenon', infernal: 'wxInfernal' };
export function siteBuffs(u) {
  const { S } = H;
  const st = S.site, out = new Map();
  if (!st || !u?.alive || u.warp) return out;
  if (st.abyss && st.def.cover && WX_SLOT[st.def.cover]) {
    const e = H.ctx.data.env?.get(st.def.weather);
    out.set(WX_SLOT[st.def.cover], (e?.desc || []).map((d) => d[EN() ? 1 : 0]));
  }
  for (const z of S.b.zones) {
    if (!z.slot || (z.unit && !z.unit.alive) || Math.hypot(u.pos[0] - z.pos[0], u.pos[1] - z.pos[1], u.pos[2] - z.pos[2]) > z.r) continue;
    const rows = H.ctx.FE.buffText(H.ctx.data, z.buffs || []);
    out.set(z.slot, [...(out.get(z.slot) || []), ...rows.filter((x) => !out.get(z.slot)?.includes(x))]);
  }
  return out;
}
// 房间的环境特效（sim-env.js）：深渊边界泡、气云、天气云层
function roomFx(R) {
  const st = H.S.site;
  if (!st.abyss) return [];
  const list = [{ kind: 'boundary', pos: R.pos, r: st.def.bound || 75000 }];
  for (const o of R.def.objs || []) if (o.kind === 'cloud') list.push({ kind: 'cloud', type: o.type, slot: o.slot, pos: at(R, o.at), r: o.r });
  if (st.def.cover) list.push({ kind: 'cover', weather: st.def.cover });
  return list;
}

function finish(won) {
  const { S } = H;
  const st = S.site;
  if (st.end) return;
  st.end = S.b.t;
  H.finish(won, won ? (st.abyss ? '已返回普通空间' : '复合体已完成') : '');
}
// 结算框里的额外一行
export function siteSummary() {
  const st = H.S.site;
  if (!st) return '';
  const k = st.rooms.filter((r) => r.entered && !r.def.entry).length;
  return `到达第 ${k} 层 / 共 ${layerCount(st.def)} 层${st.bounty ? ` · 赏金 ${H.ctx.formatNumber(Math.round(st.bounty))} ISK` : ''}`;
}
// 地点窗口（客户端信息面板的「当前地点」）：房间进度、深渊计时、天气
export function siteInfoHtml() {
  const { S, esc } = H;
  const st = S.site;
  if (!st) return '';
  const R = st.rooms[st.room];
  const left = st.abyss ? Math.max(0, (st.def.time || 1200) - (S.b.t - st.t0)) : 0;
  const mm = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  const alive = R ? [...R.waves.values()].reduce((n, w) => n + w.units.filter((u) => u.alive).length, 0) : 0;
  const wx = st.env.map((id) => H.ctx.data.env?.get(id)).filter(Boolean);
  return `<div class="pl-site"><b>${esc(L(st.def))}</b>
    <span>${esc(roomName(st, st.room))}</span><span>共 ${layerCount(st.def)} 层</span>
    ${st.abyss ? `<span class="pl-site-t${left < 120 ? ' bad' : ''}">剩余时间 ${mm}</span>` : ''}
    ${wx.length ? `<span>天气：${wx.map((e) => esc(window.I18N?.lang === 'en' ? e.en : e.name)).join('、')}</span>` : ''}
    <span>${alive ? `敌人 ${alive}` : R?.done ? '房间已清理' : ''}</span></div>`;
}
// 设置页：场景卡片 + 详情
export function siteSetupHtml(kind, sel, wxSel) {
  const { esc } = H;
  const list = SITES.filter((s) => s.kind === kind);
  const cur = list.find((s) => s.id === sel) || list[0];
  if (!cur) return '<p class="text-muted">还没有场景</p>';
  if (cur.pool) return abyssSetupHtml(list, cur, wxSel);
  const info = dungeonInfo(cur.dungeon);
  const npcs = new Map();
  for (const r of cur.rooms) for (const w of r.waves || []) for (const [t, n] of w.npcs) npcs.set(t, (npcs.get(t) || 0) + n);
  return `<div class="pl-sites">${list.map((s) => `<button type="button" class="pl-site-card${s === cur ? ' on' : ''}" data-pl-site="${esc(s.id)}"><b>${esc(L(s))}</b><span>${esc(L(s, 'sub') || '')}</span></button>`).join('')}</div>
    <div class="pl-site-detail">
      ${info ? `<p>${esc(EN() ? info.d[1] : info.d[0]).replace(/\n+/g, '<br>')}</p>` : ''}
      ${cur.ships ? `<p><b>舰船限制：</b>${esc(L(cur, 'ships'))}</p>` : ''}
      ${cur.req ? `<p><b>进入要求：</b>${esc(L(cur, 'req'))}</p>` : ''}
      ${cur.weather ? (() => { const e = H.ctx.data.env?.get(cur.weather); return e ? `<p><b>天气：</b>${esc(EN() ? e.en : e.name)}<span>（玩家和 NPC 都受影响）</span></p>` : ''; })() : ''}
      ${cur.time ? `<p><b>时限：</b>${Math.round(cur.time / 60)} 分钟</p><p><b>导管：</b>清完房间里的敌人后开启</p>` : ''}
      <p><b>层数：</b>${layerCount(cur)}${cur.kind === 'ded' ? '（另有入口）' : ''} · <b>敌人：</b>${[...npcs].map(([t, n]) => `${esc(npcName(t))} ×${n}`).join('、') || '—'}</p>
      ${cur.src ? `<p class="text-muted">刷怪资料：${cur.src.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`).join('、')}</p>` : ''}
    </div>`;
}
// 深渊设置页：等级卡片 + 天气选择 + 这个等级的刷怪池（每层从里面随机抽）
function abyssSetupHtml(list, cur, wxSel) {
  const { esc } = H;
  const wxKeys = Object.keys(cur.wx);
  const wk = cur.wx[wxSel] ? wxSel : wxKeys[0];
  const w = cur.wx[wk];
  const env = H.ctx.data.env?.get(w.b[w.b.length - 1]);
  const groups = (sp) => sp.g.map(([a, b, ids, opt]) => `${[...new Set(ids)].map((t) => esc(npcName(t))).join(' / ')} ×${a === b ? a : `${a}-${b}`}${opt ? '<em>（不用清）</em>' : ''}`).join(EN() ? ', ' : '、');
  // 实测统计（parts）：每个 NPC 写实测出现过的数量范围；护卫写出现概率
  const sep = EN() ? ', ' : '、';
  const range = (h) => { const ks = h.map((v, k) => (v ? k : -1)).filter((k) => k > 0); return ks.length ? (ks[0] === ks[ks.length - 1] ? ks[0] : `${ks[0]}-${ks[ks.length - 1]}`) : 0; };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const partHtml = (pt) => pt.g.map(([t, h]) => `${esc(npcName(t))} ×${range(h)}`).join(sep);
  const totalN = cur.pool.reduce((a, sp) => a + (sp.n || 0), 0);
  const spHtml = (sp) => (sp.parts
    ? `<p><b>${esc(sp.name)}</b><em>（${pct(sp.n / totalN)}，每房 ${sp.parts[0].tot[0]}-${sp.parts[0].tot[1]} 艘）</em>${partHtml(sp.parts[0])}${sp.parts.slice(1).map((pt) => `<span><em>${pct(pt.p)} 带${esc(pt.esc)}护卫（${pt.tot[0]}-${pt.tot[1]} 艘）：</em>${partHtml(pt)}</span>`).join('')}</p>`
    : `<p>${groups(sp)}${sp.max ? `<em>（每房最多 ${sp.max} 艘）</em>` : ''}${sp.inf ? ' <i>推断</i>' : ''}${sp.note ? `<span>${esc(sp.note)}</span>` : ''}</p>`);
  const fac = new Map();
  for (const sp of cur.pool) { if (!fac.has(sp.f)) fac.set(sp.f, []); fac.get(sp.f).push(sp); }
  return `<div class="pl-sites">${list.map((s) => `<button type="button" class="pl-site-card${s === cur ? ' on' : ''}" data-pl-site="${esc(s.id)}"><b>${esc(L(s))}</b><span>${esc(L(s, 'sub') || '')}</span></button>`).join('')}</div>
    <div class="pl-sites pl-aby-wx">${wxKeys.map((k) => `<button type="button" class="pl-site-card${k === wk ? ' on' : ''}" data-pl-aby-wx="${esc(k)}"><b>${esc(EN() ? cur.wx[k].en : cur.wx[k].name)}</b></button>`).join('')}</div>
    <div class="pl-site-detail">
      <p><b>舰船限制：</b>${esc(L(cur, 'ships'))}</p>
      <p><b>天气：</b>${esc(EN() ? w.en : w.name)}，强度 ${cur.lv.join('% 或 ')}%（随机）<span>（玩家和 NPC 都受影响）</span></p>
      ${env?.desc?.length ? `<p class="text-muted">最强一档：${env.desc.map((d) => esc(d[EN() ? 1 : 0])).join('；')}</p>` : ''}
      <p><b>时限：</b>${Math.round(cur.time / 60)} 分钟 · <b>层数：</b>${layerCount(cur)} · <b>导管：</b>清完房间里的敌人后开启</p>
      ${cur.stat
        ? `<p><b>房间：</b>按 Abyssal.Space 上 ${cur.stat[0]} 次 T6 巡洋舰实跑（${cur.stat[1]} 个房间）归纳出 ${cur.pool.length} 类房间；每层按实测出现比例抽一类，每种船的数量按实测频率抽；塔的数量和种类也照实测，气云随机</p>`
        : `<p><b>房间：</b>每层从下面 ${cur.pool.length} 种组合里随机抽一种，数量在区间里随机；气云、塔随机出现（等级越高塔越常见）</p>`}
      <div class="pl-aby-pool">${[...fac].map(([f, sps]) => `<div><b>${esc(f)}</b>${sps.map(spHtml).join('')}</div>`).join('')}</div>
      ${cur.pool.some((sp) => sp.inf) ? '<p class="text-muted">标「推断」的组合资料里没有：照 T5 同类组合换成 T6 版本的 NPC（数量没改）</p>' : ''}
      <p class="text-muted">星空：客户端深渊场景 ad0${cur.tier}（编号对应等级是推断）</p>
      ${cur.src ? `<p class="text-muted">刷怪资料：${cur.src.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}${new URL(u).pathname.length > 1 ? ` · ${esc(decodeURIComponent(new URL(u).pathname.split('/').pop()).replace(/_/g, ' '))}` : ''}</a>`).join('、')}</p>` : ''}
    </div>`;
}
export const siteDefault = (kind) => SITES.find((s) => s.kind === kind)?.id || '';
