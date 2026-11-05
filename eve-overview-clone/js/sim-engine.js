// ===== 战场模拟引擎（三维空间，逐 0.5 秒推进）=====
// createBattle 返回一个可以一步步推进的战局：step() 推进 0.5 秒；战斗中可以 deploy() 舰队支援、setPrimary() 点名集火；
// simulate() 一口气打完（扫描、加船估算用）。所有距离单位为米，时间为秒。
// 机动：每艘船有位置与速度，按惯性加速（时间常数 = 灵活度 × 质量 / 10⁶，与游戏一致），最大速度受网子影响。
//   走位官（opt.anchors）：每方可设火力走位官、后勤走位官（某一行的第一艘，阵亡后由同一行的下一艘接替）。
//     火力走位官按本方走位方式带队（环绕 / 保持距离 / 风筝，距离取跟随舰船主力武器的理想距离，速度不超过最慢的跟随者）；
//     后勤走位官停在火力走位官后方的遥修距离内；跟随的船（行设置 row.move = dps / logi）在走位官周围保持队形。
//   其余舰船按定位走位：输出舰按走位方式打自己的目标；拦截（有扰断 / 网子的小船）贴近环绕；后勤在本方舰队后方；
//   电子战停在装备射程内；无人机船停在控制距离内；航母远离敌方，靠舰载机输出。同方舰船互相避让。
// 炮台：每个射击周期按真实角速度（相对速度的横向分量 / 中心距离）、表面距离掷骰：
//   命中率 = 0.5^((角速度 × 40000 / (跟踪速度 × 目标信号))² + (max(0, 距离 − 最佳射程) / 失准范围)²)，
//   命中时伤害倍数 = 随机数 + 0.49，随机数 < 0.01 为三倍致命一击（与游戏相同）。
//   热能分解器（Precursor）连续打同一目标每轮伤害加成递增到上限，换目标清零；电涌投射器按爆炸半径 / 速度算伤害，并跳到附近敌船。
// 导弹：射程 = 飞行速度 × 飞行时间；导弹真实飞行追踪目标，命中时按目标当时的速度与信号半径算：
//   min(1, 信号 / 爆炸半径, (信号 / 爆炸半径 × 爆炸速度 / 目标速度)^爆炸衰减系数)；飞行时间用完没追上则落空。
// 无人机：目标在母舰控制距离内才出击，逐架飞过去，按自身的环绕距离、巡航速度绕目标飞，按炮台公式（自身跟踪、射程、信号分辨率）逐发掷骰；
//   岗哨无人机不动。舰载机按中队飞到目标、在环绕距离上攻击，伤害按导弹公式（爆炸半径 / 速度，衰减系数 = ln 衰减因子 / ln 衰减灵敏度），
//   超出最佳射程按失准范围衰减；导弹技能同样计算（不计弹药次数）。无人机、舰载机不会被击落。
// 弹药：打完一个弹夹要装填（装填时间按装备属性）；频率晶体不需要装填。武器每次开火扣电容，电容不够就等。
// 维修按周期结算：本地护盾维修在周期开始时生效，装甲 / 结构维修与遥修在周期结束时生效；中和、吸电在周期开始时生效。
// 网子、标记、阻尼、ECM、中和、吸电、遥修都按两船实际距离与衰减范围算，同类效果有叠加惩罚。
// 伤害依次扣护盾、装甲、结构，每层按四种伤害的抗性分别计算。
// 舰队支援（deploy / opt.support）：跃迁进场（从远处减速落地，落地前不能被锁定）或诱导进场（在诱导点直接出现），
//   位置 = 参照（本方 / 敌方舰队中心、战场中心）+ 方向（以本方看向敌方为前）× 距离。
//   诱导进场可以指定诱导船（rows 里 cyno: true）：诱导船先跃迁到位、开启诱导（原地不动），CYNO_JUMP 秒后其余舰船跳到诱导船身边；
//   在这之前诱导船全部被击毁，其余舰船进不来。
// 撤离：一方没有输出舰船了（只剩后勤 / 电子战），剩下的船转向远离敌人、对准后跃迁离场（对准时间按质量 × 灵活度），
//   被敌方跃迁扰断 / 扰频（强度超过跃迁稳定）就走不掉；离场算存活，不算损失。
// 胜负看战损：双方被击毁的价值（ISK，opt.value 给出单艘价值；没有价格时用 EHP）之比，不看谁被打光。
// 记录（opt.record）：每步一帧，开火 / 遥修记为四元组 [开火方, 目标, 0 未命中 | 1 命中 | 2 遥修, 第几门武器]；
//   每艘船带上各门武器的特效信息（rec.units[i].fx）与装备列表（rec.units[i].rack）；每帧另有速度、电容、锁定进度，装备运转 / 装填 / 开始新周期的位掩码，
//   rec.units[i].ew 为电子战 / 遥修装备 [序号, web|scram|point|neut|nos|ecm|damp|paint|rs|ra|rh]，电子战作用于本帧目标 tg，遥修目标逐帧记在 rr（每 3 个数 [后勤, 目标, 装备序号]）；
//   出击的无人机 / 舰载机位置（dr：每 5 个数 [母舰, x, y, z, 类别]，类别 0–3 轻 / 中 / 重 / 岗哨无人机，4–6 轻型 / 支援 / 重型舰载机）。

const DT = 0.5;            // 一步的时长
const SUB = 2;             // 机动每步再细分的次数
const SQUAD = 15;          // 集火时每 15 艘船共用一个目标
const SIDES = ['A', 'B'];
const LOGI_BACK = 3000;    // 后勤在本方舰队后方的距离
const LOGI_LOCKS = 4;      // 后勤同时锁定的队友数
const WARP_IN = 3;         // 跃迁进场的减速时间（秒）
const WARP_FROM = 150000;  // 跃迁进场从多远处减速
const CYNO_JUMP = 10;      // 诱导开启后，舰队跳过来所需时间（秒）

const PENALTY = (i) => Math.exp(-((i / 2.67) ** 2));
const stack = (list, asc) => list.sort((a, b) => (asc ? a - b : b - a)).reduce((m, x, i) => m * (1 + x * PENALTY(i)), 1);
const rangeEff = (x, d) => (d <= x.range ? 1 : x.falloff > 0 ? 0.5 ** (((d - x.range) / x.falloff) ** 2) : 0);
const lockTime = (scanRes, sig) => (scanRes > 0 ? Math.min(60, 40000 / (scanRes * Math.asinh(sig) ** 2)) : 5);
const mean = (r) => (r[0] + r[1] + r[2] + r[3]) / 4 || 1;
// 导弹 / 舰载机 / 电涌投射器的伤害比例（游戏公式）
const missileApply = (sig, V, er, ev, drf) => (er > 0 ? Math.min(1, sig / er, V > 0 && ev > 0 ? ((sig / er) * (ev / V)) ** drf : 1) : 1);
// 下一个周期开始：上一周期刚结束（差不到一步）就接着算，保持节奏；停过（锁定、射程外）就从现在重新开始，不补打
const nextCycle = (next, t, cycle) => (t - next > DT ? t : next) + cycle;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// 向量小工具（[x, y, z]）
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cap = (a, m) => { const l = len(a); return l > m ? scale(a, m / l) : a; };

// 定位：logi 后勤 / carrier 航母 / ewar 电子战 / tackle 拦截 / drone 无人机船 / dps 输出
function roleOf(t) {
  if (!t.dps && t.remote.length) return 'logi';
  if (t.fighters?.length && t.fighter >= t.dps * 0.5) return 'carrier';
  if (!t.dps && (t.ecms.length || t.damps.length || t.paints.length || t.neuts.length || t.webs.length || t.points.length)) return t.radius < 200 && (t.points.length || t.webs.length) ? 'tackle' : 'ewar';
  if ((t.points.length || t.webs.length) && t.radius < 200) return 'tackle';
  if (!t.guns.length && t.drones.length) return 'drone';
  return 'dps';
}

// 电子战与遥修装备（3D 特效、名单上的状态图标用）：[装备序号, 类别]；遥修的目标每帧另记（rr）
const ewList = (t) => [
  ...t.webs.map((x) => [x.m, 'web']), ...t.points.map((x) => [x.m, x.str >= 2 ? 'scram' : 'point']), ...t.neuts.map((x) => [x.m, 'neut']), ...t.noses.map((x) => [x.m, 'nos']),
  ...t.ecms.map((x) => [x.m, 'ecm']), ...t.damps.map((x) => [x.m, 'damp']), ...t.paints.map((x) => [x.m, 'paint']), ...t.remote.map((x) => [x.m, ['rs', 'ra', 'rh'][x.layer]]),
].filter(([m]) => m != null && m >= 0 && m < 32);

// opt: { dist (km), focus: weak|dps|spread, logi, ewar, cap, max (秒), moveA / moveB: orbit|range|kite, record, seed, value(row) → 单艘 ISK,
//        anchors: { A: { dps: 行 id, logi: 行 id }, B }, support: [{ side, rows: [{ row, count }], mode: warp|cyno, ref, dist (km), dir, at (秒) }] }
export function createBattle(sides, opt) {
  const rand = rng(opt.seed || 20261026);
  const capOn = opt.cap !== false;
  const units = [];
  const rows = [];
  const rowOf = new Map();
  const blank = () => ({ unitSec: 0, potential: 0, applied: 0, lockWait: 0, noRange: 0, outRange: 0, jammed: 0, capped: 0, drained: 0 });
  const tally = { A: blank(), B: blank() };
  const kills = [];
  const missiles = [];
  const events = [];   // 增援、点名集火、撤离（回放与日志用）
  const primary = { A: null, B: null };
  const spawn = { A: [-opt.dist * 500, 0, 0], B: [opt.dist * 500, 0, 0] };
  const timeline = [];
  const rec = opt.record ? { units: [], frames: [], missiles: [], events, dt: DT } : null;
  const B = { t: 0, done: false, units, primary, tally, kills, rec, rows, events };
  const support = (opt.support || []).map((s) => ({ ...s, fired: false }));

  // ---------- 加船 ----------
  // entry：{ mode: warp | cyno }，没有时为开局布阵
  function addUnits(side, row, count, at, entry = null) {
    const tpl = row.unit;
    if (!tpl || count <= 0) return 0;
    let r = rowOf.get(side + ':' + row.id);
    if (!r) { r = { row, side, lost: 0, escaped: 0, dealt: 0, taken: 0, repaired: 0, n: 0, killTimes: [] }; rowOf.set(side + ':' + row.id, r); rows.push(r); }
    r.n += count;
    // 同一行的船聚成一团：团中心在出生点附近，团半径随数量增大；舰队支援落在指定位置
    const blob = (entry ? 300 : 400) + 250 * Math.cbrt(count) + (entry?.mode === 'cyno' ? 2500 : 0);
    const c = entry ? at.slice() : [at[0] + (rand() - 0.5) * 3000, at[1] + (rand() - 0.5) * 1500, at[2] + (rand() - 0.5) * 6000];
    const enemy = centroid(units.filter((u) => u.alive && u.side !== side)) || spawn[side === 'A' ? 'B' : 'A'];
    const face = norm(sub(enemy, c));
    // 跃迁进场：从背对敌方的远处减速落地
    const from = entry?.mode === 'warp' ? norm(sub(c, enemy)) : null;
    for (let i = 0; i < count; i++) {
      let p;
      do { p = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]; } while (len(p) > 1);
      const pos = [c[0] + p[0] * blob, c[1] + p[1] * blob * 0.5, c[2] + p[2] * blob];
      // 环绕平面：大致水平，稍有倾斜；方向随机（顺时针 / 逆时针）
      const n = norm([(rand() - 0.5) * 0.4, rand() < 0.5 ? 1 : -1, (rand() - 0.5) * 0.4]);
      const u = {
        i: units.length, side, r, t: tpl, role: roleOf(tpl), pos, vel: [0, 0, 0], face, orbitN: n, alive: true, born: B.t, escaping: 0, escaped: false, pointed: 0,
        hp: tpl.max.slice(), target: null, lock: 0, repTarget: null, repLock: 0, slot: p,
        cap: tpl.cap.max, ratio: 1, jam: 0, ecmNext: tpl.ecms.map((_, k) => k), scanMult: 1, rangeMult: 1, velMult: 1, sigMult: 1, act: 0, rld: 0,
        guns: tpl.guns.map((g, k) => ({ next: B.t + rand() * Math.min(2, g.cycle) + k * 0.05, ammo: g.ammo, reloadUntil: 0, last: -1e9, spool: 0, on: null })),
        lrep: (tpl.localReps || []).map((x) => ({ next: B.t + rand() * x.cycle, ammo: x.ammo, reloadUntil: 0, pend: 0 })),
        rrep: tpl.remote.map(() => ({ end: 0, tgt: null })),
        drain: [...tpl.neuts.map(() => ({ next: 0 })), ...tpl.noses.map(() => ({ next: 0 }))],
        drones: tpl.drones.flatMap((g) => Array.from({ length: g.n }, () => ({ g, pos: null, vel: [0, 0, 0], target: null, next: 0, dir: rand() < 0.5 ? 1 : -1 }))),
        squads: (tpl.fighters || []).flatMap((f) => Array.from({ length: f.squads }, () => ({ f, pos: null, vel: [0, 0, 0], target: null, next: 0, nextM: 0, dir: rand() < 0.5 ? 1 : -1 }))),
        warp: from ? { t0: B.t, to: pos.slice(), from: add(pos, scale(from, WARP_FROM)) } : null
      };
      if (u.warp) { u.pos = u.warp.from.slice(); u.vel = scale(from, -WARP_FROM / WARP_IN); }
      units.push(u);
      if (rec) rec.units.push({ side, ship: row.ship, row: row.id, radius: tpl.radius, born: B.t, fx: tpl.guns.map((g) => g.fx || null), rack: tpl.rack || [], vel: tpl.vel, cap: tpl.cap.max, ew: ewList(tpl) });
    }
    return count;
  }
  for (const s of SIDES) for (const row of sides[s]) addUnits(s, row, row.count, spawn[s]);
  const bySide = (s) => units.filter((u) => u.side === s);
  const startN = { A: bySide('A').length, B: bySide('B').length };

  // 舰队支援的落点：参照 + 方向 × 距离（方向以本方看向敌方为前）
  B.spot = (side, ref = 'own', distKm = 0, dir = 'front') => {
    const o = side === 'A' ? 'B' : 'A';
    const own = centroid(units.filter((u) => u.alive && u.side === side)) || spawn[side];
    const foe = centroid(units.filter((u) => u.alive && u.side === o)) || spawn[o];
    const axis = len(sub(foe, own)) > 1 ? norm(sub(foe, own)) : (side === 'A' ? [1, 0, 0] : [-1, 0, 0]);
    const up = [0, 1, 0];
    const right = norm(cross(axis, up));
    const base = ref === 'enemy' ? foe : ref === 'center' ? scale(add(own, foe), 0.5) : own;
    const v = { front: axis, back: scale(axis, -1), left: scale(right, -1), right, up, down: scale(up, -1) }[dir] || axis;
    return add(base, scale(v, distKm * 1000));
  };
  // 舰队支援进场：spec = { rows: [{ row, count }], mode: warp | cyno, ref, dist, dir }；spec.pos（米）给了就直接落在那里
  const jumps = [];   // 等诱导船开诱导后再跳进来的舰队
  B.deploy = (side, spec) => {
    const at = spec.pos ? spec.pos.slice() : B.spot(side, spec.ref, spec.dist, spec.dir);
    const lead = spec.mode === 'cyno' ? spec.rows.filter((x) => x.cyno) : [];
    if (lead.length) {
      // 诱导船先跃迁到位；落地后开诱导，舰队随后跳来
      const from = units.length;
      for (const { row, count } of lead) addUnits(side, row, count, at, { mode: 'warp' });
      const ships = units.slice(from);
      if (!ships.length) return 0;
      for (const u of ships) u.cyno = true;
      jumps.push({ side, spec, ships, lit: B.t + WARP_IN, at: B.t + WARP_IN + CYNO_JUMP, litDone: false });
      events.push({ t: B.t, kind: 'reinforce', side, mode: 'warp', pos: at, ship: ships[0].r.row.ship, n: ships.length, name: spec.name || '', cynoShip: true });
      return ships.length;
    }
    let n = 0;
    for (const { row, count } of spec.rows) n += addUnits(side, row, count, at, { mode: spec.mode });
    if (n) events.push({ t: B.t, kind: 'reinforce', side, mode: spec.mode, pos: at, ship: spec.rows[0]?.row.ship, n, name: spec.name || '' });
    return n;
  };
  function cynoStep() {
    for (let k = jumps.length - 1; k >= 0; k--) {
      const j = jumps[k];
      const alive = j.ships.filter((u) => u.alive);
      if (!alive.length) {
        jumps.splice(k, 1);
        events.push({ t: B.t, kind: 'cyno-fail', side: j.side, name: j.spec.name || '', ship: j.ships[0].r.row.ship });
        continue;
      }
      if (!j.litDone && B.t >= j.lit) { j.litDone = true; events.push({ t: B.t, kind: 'cyno', side: j.side, pos: alive[0].pos.slice(), name: j.spec.name || '', ship: alive[0].r.row.ship }); }
      if (B.t < j.at) continue;
      jumps.splice(k, 1);
      const c = alive[0].pos.slice();
      let n = 0;
      for (const { row, count, cyno } of j.spec.rows) if (!cyno) n += addUnits(j.side, row, count, c, { mode: 'cyno' });
      if (n) events.push({ t: B.t, kind: 'reinforce', side: j.side, mode: 'cyno', pos: c, ship: j.spec.rows.find((x) => !x.cyno)?.row.ship, n, name: j.spec.name || '' });
    }
  }
  // 旧接口：落在本方出发点附近（跃迁进场）
  B.addFleet = (side, row, count) => B.deploy(side, { rows: [{ row, count }], mode: 'warp', ref: 'own', dist: 0, dir: 'back' });
  // 点名集火：本方所有有输出的船改打这艘（i 为单位序号，-1 取消）
  B.setPrimary = (side, i) => {
    const v = i >= 0 ? units[i] : null;
    if (v && (!v.alive || v.side === side)) return;
    primary[side] = v;
    events.push({ t: B.t, kind: 'primary', side, unit: v ? v.i : -1 });
    if (v) for (const u of units) if (ready(u) && u.side === side && attacks(u) && u.target !== v) { u.target = v; setLock(u, v); }
  };

  // ---------- 工具 ----------
  const ready = (u) => u.alive && !u.warp;   // 跃迁中的船不能锁定、不能行动
  const center = (u, v) => len(sub(v.pos, u.pos));
  const surf = (u, v) => Math.max(0, center(u, v) - u.t.radius - v.t.radius);
  const curEhp = (u) => u.hp[0] / mean(u.t.res[0]) + u.hp[1] / mean(u.t.res[1]) + u.hp[2] / mean(u.t.res[2]);
  const relock = (u, v) => lockTime(u.t.scanRes * u.scanMult, v.t.sig * v.sigMult);
  // 开始锁定：记下总锁定时间（回放显示锁定进度）
  const setLock = (u, v) => { u.lock = u.lockAll = relock(u, v); };
  const attacks = (u) => u.t.dps > 0 || u.t.webs.length || u.t.paints.length || u.t.neuts.length || u.t.noses.length || u.t.damps.length || u.t.ecms.length;
  const speedOf = (u) => len(u.vel);
  // 相对角速度（弧度 / 秒）：相对速度垂直于连线的分量 / 中心距离；a、b 为 { pos, vel }
  const angular = (a, b) => {
    const r = sub(b.pos, a.pos), d = len(r) || 1;
    const rv = sub(b.vel, a.vel);
    const along = dot(rv, r) / d;
    const trans = Math.sqrt(Math.max(0, dot(rv, rv) - along * along));
    return trans / d;
  };
  // 炮台公式（舰船炮台、无人机共用）：返回伤害倍数（0 = 未命中）
  const turretRoll = (g, from, v, d) => {
    const sig = v.t.sig * v.sigMult;
    const w = angular(from, v);
    const chance = 0.5 ** ((g.track > 0 ? (w * g.sigRes / (g.track * sig || 1)) ** 2 : 0) + (Math.max(0, d - g.opt) / Math.max(1, g.fall)) ** 2);
    const x = rand();
    if (x >= chance) return 0;
    return x < 0.01 ? 3 : x + 0.49;
  };
  function centroid(list) {
    if (!list.length) return null;
    const c = [0, 0, 0];
    for (const u of list) { c[0] += u.pos[0]; c[1] += u.pos[1]; c[2] += u.pos[2]; }
    return scale(c, 1 / list.length);
  }

  // ---------- 选目标 ----------
  function assignTargets(side) {
    const enemies = units.filter((u) => ready(u) && u.side !== side);
    if (!enemies.length) return;
    const p = primary[side];
    if (p && !p.alive) primary[side] = null;
    const attackers = units.filter((u) => ready(u) && u.side === side && attacks(u));
    if (primary[side]) {
      for (const u of attackers) if (u.target !== primary[side]) { u.target = primary[side]; setLock(u, u.target); }
      return;
    }
    if (opt.focus === 'spread') {
      for (const u of attackers) if (!u.target?.alive) { u.target = enemies[Math.floor(rand() * enemies.length)]; setLock(u, u.target); }
      return;
    }
    // 拦截船：优先抓离自己最近的
    for (const u of attackers) {
      if (u.role !== 'tackle' || u.target?.alive) continue;
      let best = null, bd = Infinity;
      for (const v of enemies) { const d = center(u, v); if (d < bd) { bd = d; best = v; } }
      u.target = best;
      setLock(u, best);
    }
    const need = attackers.filter((u) => !u.target?.alive);
    if (!need.length) return;
    const k = Math.max(1, Math.ceil(attackers.length / SQUAD));
    // 最脆优先 / 输出优先；同等时先打近的（离本方舰队中心）
    const cen = centroid(attackers);
    const ranked = enemies.slice().sort(opt.focus === 'dps'
      ? (a, b) => b.t.dps - a.t.dps || curEhp(a) - curEhp(b)
      : (a, b) => curEhp(a) * (1 + len(sub(a.pos, cen)) / 200000) - curEhp(b) * (1 + len(sub(b.pos, cen)) / 200000));
    const primaries = ranked.slice(0, k);
    const load = new Map(primaries.map((x) => [x, 0]));
    for (const u of attackers) if (u.target?.alive && load.has(u.target)) load.set(u.target, load.get(u.target) + 1);
    for (const u of need) {
      let best = primaries[0];
      for (const x of primaries) if (load.get(x) < load.get(best)) best = x;
      load.set(best, load.get(best) + 1);
      u.target = best;
      setLock(u, best);
    }
  }

  // ---------- 机动 ----------
  const moveOf = (side) => (side === 'A' ? opt.moveA : opt.moveB);
  // 走位官：设定的那一行里第一艘还在场的船
  function anchorsOf(side, alive) {
    const set = opt.anchors?.[side] || {};
    const pick = (id) => (id ? alive.find((u) => u.side === side && u.r.row.id === id) || null : null);
    return { dps: pick(set.dps), logi: pick(set.logi) };
  }
  // 跟随：火力 / 后勤走位官所在行的船默认跟随本行走位官，其余按行设置
  const followOf = (u, anc) => {
    const id = u.r.row.id, set = opt.anchors?.[u.side] || {};
    if (anc.dps && (id === set.dps || u.r.row.move === 'dps')) return anc.dps;
    if (anc.logi && (id === set.logi || u.r.row.move === 'logi')) return anc.logi;
    return null;
  };
  // 环绕 / 风筝 / 保持距离：返回期望速度
  function steer(u, v, R, mode, maxV, velRef = null) {
    const r = sub(v.pos, u.pos);
    const dc = len(r) || 1;
    const d = Math.max(0, dc - u.t.radius - (v.t?.radius || 0));
    const rin = scale(r, 1 / dc);
    if (mode === 'range') {
      // 保持距离：只在径向调整，距离合适就跟着目标走（舰队对射时几乎没有横向速度）
      const err = d - R;
      const k = Math.max(-1, Math.min(1, err / 3000));
      return Math.abs(err) < 500 ? scale(velRef || v.vel || [0, 0, 0], 0.9) : scale(rin, k * maxV);
    }
    // 环绕 / 风筝：切向全速，径向按距离误差修正
    let tan = cross(u.orbitN, rin);
    if (len(tan) < 0.1) tan = cross([1, 0, 0], rin);
    tan = norm(tan);
    const k = Math.max(-1, Math.min(1, (d - R) / Math.max(800, R * 0.25)));
    const dir = norm(add(scale(rin, k), scale(tan, Math.sqrt(1 - k * k))));
    return scale(dir, maxV);
  }
  // 火力走位官：带着整队按走位方式移动；距离取跟随舰船理想距离的中位数，速度不超过最慢的跟随者
  function anchorDesire(a, followers, enemyCen) {
    const mode = moveOf(a.side);
    const prefs = followers.map((f) => (mode === 'kite' ? f.t.reach * 0.9 : f.t.pref)).sort((x, y) => x - y);
    const R = prefs.length ? prefs[Math.floor(prefs.length / 2)] : a.t.pref;
    const slow = Math.min(a.t.vel * a.velMult, ...followers.map((f) => f.t.vel * f.velMult * 0.92));
    const ref = a.target?.alive ? a.target : { pos: enemyCen, vel: [0, 0, 0], t: { radius: 0 } };
    // 风筝：敌人贴近到距离的 60% 以内就直接背向拉开
    if (mode === 'kite' && len(sub(enemyCen, a.pos)) < R * 0.6) return scale(norm(sub(a.pos, enemyCen)), slow);
    return steer(a, ref, R, mode, slow);
  }
  function desired(u, ctx) {
    const maxV = u.t.vel * u.velMult;
    const { enemyCen, dpsCen, anc, logiReach } = ctx[u.side];
    // 撤离：背对敌方全速对准
    if (u.escaping) return scale(norm(sub(u.pos, enemyCen)), maxV);
    // 开着诱导：原地不动
    if (u.cyno) return [0, 0, 0];
    // 走位官
    if (u === anc.dps) return anchorDesire(u, ctx[u.side].dpsFollow, enemyCen);
    const front = anc.dps || null;
    if (u === anc.logi) {
      const lead = front ? front.pos : dpsCen;
      const back = norm(sub(lead, enemyCen));
      const goal = add(lead, scale(back, Math.min(LOGI_BACK, logiReach * 0.5)));
      const off = sub(goal, u.pos), d = len(off);
      const base = front ? front.vel : [0, 0, 0];
      return cap(add(base, d < 300 ? [0, 0, 0] : scale(norm(off), Math.min(maxV, d / 4))), maxV);
    }
    // 跟随走位官：在走位官周围保持队形（每艘船在队形里有固定位置）
    const lead = followOf(u, anc);
    if (lead) {
      const ball = 300 + 120 * Math.cbrt(ctx[u.side].followN.get(lead) || 1);
      const goal = add(lead.pos, scale(u.slot, ball));
      const off = sub(goal, u.pos);
      return cap(add(lead.vel, scale(off, 0.25)), maxV);
    }
    // 按定位
    const v = u.target?.alive ? u.target : null;
    if (u.role === 'logi') {
      const lead = front ? front.pos : dpsCen;
      const back = norm(sub(lead, enemyCen));
      const goal = add(lead, scale(back, Math.min(LOGI_BACK, (u.t.remote[0]?.range || 6000) * 0.5)));
      const off = sub(goal, u.pos), d = len(off);
      return d < 300 ? [0, 0, 0] : scale(norm(off), Math.min(maxV, d / 4));
    }
    if (u.role === 'carrier') {
      // 航母：离敌方舰队约 60 km（不超过锁定距离），舰载机去打
      const R = Math.min(60000, u.t.lockRange * u.rangeMult * 0.8);
      return steer(u, { pos: enemyCen, vel: [0, 0, 0], t: { radius: 0 } }, R, 'range', maxV, [0, 0, 0]);
    }
    if (!v) {
      const off = sub(enemyCen, u.pos);
      return len(off) < 1000 ? [0, 0, 0] : scale(norm(off), maxV);
    }
    const lockR = u.t.lockRange * u.rangeMult * 0.95;
    if (u.role === 'tackle') {
      const r = [...u.t.points, ...u.t.webs].map((x) => x.range);
      return steer(u, v, Math.min(lockR, Math.max(500, Math.min(...r) * 0.6)), 'orbit', maxV);
    }
    if (u.role === 'ewar') {
      const r = [...u.t.ecms, ...u.t.damps, ...u.t.paints, ...u.t.neuts, ...u.t.webs, ...u.t.points].map((x) => x.range + (x.falloff || 0) * 0.3);
      return steer(u, v, Math.min(lockR, Math.max(1000, Math.min(...r) * 0.85)), 'range', maxV);
    }
    if (u.role === 'drone') return steer(u, v, Math.min(lockR, u.t.pref), 'range', maxV);
    const mode = moveOf(u.side);
    return steer(u, v, Math.min(mode === 'kite' ? u.t.reach * 0.9 : u.t.pref, lockR), mode, maxV);
  }
  function move() {
    const t = B.t;
    // 跃迁进场：减速落地
    for (const u of units) {
      if (!u.alive || !u.warp) continue;
      const s = Math.min(1, (t + DT - u.warp.t0) / WARP_IN);
      const p = add(u.warp.to, scale(sub(u.warp.from, u.warp.to), (1 - s) ** 3));
      u.vel = scale(sub(p, u.pos), 1 / DT);
      u.pos = p;
      if (s >= 1) { u.warp = null; u.vel = scale(norm(u.vel), 100); }
    }
    const alive = units.filter(ready);
    const ctx = {};
    for (const s of SIDES) {
      const mine = alive.filter((u) => u.side === s), foes = alive.filter((u) => u.side !== s);
      const dps = mine.filter((u) => u.t.dps > 0);
      const anc = anchorsOf(s, alive);
      const followN = new Map();
      const dpsFollow = [];
      for (const u of mine) {
        const l = followOf(u, anc);
        if (l) followN.set(l, (followN.get(l) || 0) + 1);
        if (l === anc.dps && u !== anc.dps) dpsFollow.push(u);
      }
      const logi = mine.filter((u) => u.role === 'logi' && followOf(u, anc) === anc.logi);
      ctx[s] = {
        enemyCen: centroid(foes) || spawn[s === 'A' ? 'B' : 'A'], dpsCen: centroid(dps) || centroid(mine) || spawn[s],
        anc, followN, dpsFollow, logiReach: logi.length ? Math.min(...logi.map((u) => u.t.remote[0]?.range || 6000)) : 6000
      };
    }
    // 同方避让：按 1 km 网格找邻居
    const grid = new Map();
    const key = (p) => `${Math.floor(p[0] / 1000)},${Math.floor(p[1] / 1000)},${Math.floor(p[2] / 1000)}`;
    for (const u of alive) { const k = key(u.pos); (grid.get(k) || grid.set(k, []).get(k)).push(u); }
    const goal = new Map();
    for (const u of alive) {
      const D = desired(u, ctx);
      const gx = Math.floor(u.pos[0] / 1000), gy = Math.floor(u.pos[1] / 1000), gz = Math.floor(u.pos[2] / 1000);
      const push = [0, 0, 0];
      let n = 0;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const w of grid.get(`${gx + x},${gy + y},${gz + z}`) || []) {
          if (w === u || n > 8) continue;
          const off = sub(u.pos, w.pos), d = len(off), min = u.t.radius + w.t.radius + 150;
          if (d < min && d > 0) { const k = (min - d) / min; push[0] += off[0] / d * k; push[1] += off[1] / d * k; push[2] += off[2] / d * k; n++; }
        }
      }
      const maxV = u.t.vel * u.velMult;
      if (n) { D[0] += push[0] * maxV * 0.5; D[1] += push[1] * maxV * 0.5; D[2] += push[2] * maxV * 0.5; }
      goal.set(u, cap(D, maxV));
    }
    const h = DT / SUB;
    for (let s = 0; s < SUB; s++) {
      for (const u of alive) {
        const D = goal.get(u);
        const a = 1 - Math.exp(-h / Math.max(0.5, u.t.tau));
        u.vel = [u.vel[0] + (D[0] - u.vel[0]) * a, u.vel[1] + (D[1] - u.vel[1]) * a, u.vel[2] + (D[2] - u.vel[2]) * a];
        u.pos = [u.pos[0] + u.vel[0] * h, u.pos[1] + u.vel[1] * h, u.pos[2] + u.vel[2] * h];
      }
    }
  }

  // ---------- 伤害 ----------
  function hit(u, v, dmg) {
    if (!v.alive) return 0;
    let left = dmg.slice(), dealt = 0;
    for (let layer = 0; layer < 3 && left; layer++) {
      const eff = left.reduce((s, x, k) => s + x * v.t.res[layer][k], 0);
      if (eff <= 0) break;
      if (eff <= v.hp[layer]) { v.hp[layer] -= eff; dealt += eff; left = null; break; }
      const used = v.hp[layer] / eff;
      dealt += v.hp[layer];
      v.hp[layer] = 0;
      left = left.map((x) => x * (1 - used));
    }
    v.r.taken += dealt;
    u.r.dealt += dealt;
    if (v.hp[2] <= 1e-6) {
      v.alive = false;
      v.r.lost += 1;
      v.r.killTimes.push(Math.ceil(B.t));
      kills.push({ t: Math.ceil(B.t), at: B.t, side: v.side, ship: v.r.row.ship, row: v.r, unit: v.i, by: u.i });
    }
    return dealt;
  }
  const engaged = (u, v) => u.jam <= B.t && surf(u, v) <= u.t.lockRange * u.rangeMult && u.lock <= 0;
  const bit = (u, m, on = true) => { if (on && m != null && m >= 0 && m < 32) u.act |= 1 << m; };
  // 这一步开始了新周期的装备（回放画周期进度圈）
  const fired = (u, m) => { if (m != null && m >= 0 && m < 32) u.fire |= 1 << m; };

  // 无人机：出击、环绕目标、按炮台公式开火
  function droneStep(u, t) {
    const v = u.target && ready(u.target) && !(u.jam > t) && u.lock <= 0 ? u.target : null;
    const T = tally[u.side];
    for (const d of u.drones) {
      const g = d.g;
      const go = v && surf(u, v) <= g.control ? v : null;
      if (go && !d.pos) d.pos = u.pos.slice();   // 出击：从母舰放出
      d.target = go;
      if (!d.pos) continue;
      if (g.sentry) {
        d.pos = u.pos.slice();
        d.vel = u.vel.slice();
      } else {
        // 有目标：以最大速度接近，进入环绕距离后按巡航速度环绕；没目标：回到母舰身边环绕
        const c = go || u;
        const R = go ? g.fly + go.t.radius : u.t.radius + 500;
        const r = sub(c.pos, d.pos), dc = len(r) || 1;
        const rin = scale(r, 1 / dc);
        let D;
        if (dc > R + 1500) D = scale(rin, g.vel);
        else {
          let tan = cross(u.orbitN, rin);
          if (len(tan) < 0.1) tan = cross([1, 0, 0], rin);
          tan = scale(norm(tan), d.dir);
          const k = Math.max(-1, Math.min(1, (dc - R) / 600));
          D = add(c.vel, scale(norm(add(scale(rin, k), scale(tan, Math.sqrt(1 - k * k)))), g.cruise || g.vel));
          D = cap(D, g.vel);
        }
        d.vel = D;
        d.pos = add(d.pos, scale(D, DT));
      }
      if (!go || t < d.next) continue;
      const dist = Math.max(0, len(sub(go.pos, d.pos)) - go.t.radius);
      if (dist > g.attackRange) continue;
      d.next = nextCycle(d.next, t, g.cycle);
      T.potential += g.volley;
      const mult = turretRoll(g, d, go, dist);
      if (mult) { T.applied += g.volley * mult; hit(u, go, g.dmg.map((x) => x * mult)); }
    }
  }
  // 舰载机：中队飞到目标、环绕攻击（导弹公式）
  function fighterStep(u, t) {
    const v = u.target && ready(u.target) && !(u.jam > t) && u.lock <= 0 && surf(u, u.target) <= u.t.lockRange * u.rangeMult ? u.target : null;
    const T = tally[u.side];
    for (const q of u.squads) {
      const f = q.f;
      if (v && !q.pos) q.pos = u.pos.slice();
      q.target = v;
      if (!q.pos) continue;
      const c = v || u;
      const R = v ? f.orbit + v.t.radius : u.t.radius + 2000;
      const r = sub(c.pos, q.pos), dc = len(r) || 1;
      const rin = scale(r, 1 / dc);
      let D;
      if (dc > R + 3000) D = scale(rin, f.vel);
      else {
        let tan = cross(u.orbitN, rin);
        if (len(tan) < 0.1) tan = cross([1, 0, 0], rin);
        tan = scale(norm(tan), q.dir);
        const k = Math.max(-1, Math.min(1, (dc - R) / 1500));
        D = cap(add(c.vel, scale(norm(add(scale(rin, k), scale(tan, Math.sqrt(1 - k * k)))), f.vel)), f.vel);
      }
      q.vel = D;
      q.pos = add(q.pos, scale(D, DT));
      if (!v) continue;
      const dist = Math.max(0, len(sub(v.pos, q.pos)) - v.t.radius);
      const sig = v.t.sig * v.sigMult, V = speedOf(v);
      const fire = (a, next) => {
        const volley = a.dmg.reduce((s, x) => s + x, 0) * f.size;
        T.potential += volley;
        const k = missileApply(sig, V, a.er, a.ev, a.drf) * (a.fall != null ? rangeEff({ range: a.opt, falloff: a.fall }, dist) : dist <= a.range ? 1 : 0);
        if (k > 0) { T.applied += volley * k; hit(u, v, a.dmg.map((x) => x * f.size * k)); }
        return nextCycle(next, t, a.cycle);
      };
      if (f.atk && t >= q.next && dist <= f.atk.opt + f.atk.fall * 2) q.next = fire(f.atk, q.next);
      if (f.msl && t >= q.nextM && dist <= f.msl.range) q.nextM = fire(f.msl, q.nextM);
    }
  }

  // ---------- 一步 ----------
  let shots = [];
  B.step = () => {
    if (B.done) return;
    const t = B.t;
    shots = [];
    // 预设的舰队支援：到时间自动进场
    for (const s of support) if (!s.fired && s.at != null && t >= s.at) { s.fired = true; B.deploy(s.side, s); }
    cynoStep();
    const alive = units.filter(ready);
    for (const u of units) { u.act = 0; u.fire = 0; }
    // 电容：回充，再付非武器装备的耗电（武器开火、中和 / 吸电时单独扣）
    for (const u of alive) {
      tally[u.side].unitSec += DT;
      const c = u.t.cap;
      if (!capOn) { u.ratio = 1; u.cap = c.max; continue; }
      if (c.max && c.tau) { const x = Math.max(0.01, u.cap / c.max); u.cap = Math.min(c.max, u.cap + 10 * c.max / c.tau * (Math.sqrt(x) - x) * DT); }
      const use = c.other * DT;
      if (use <= 0) { u.ratio = 1; continue; }
      if (u.cap >= use) { u.cap -= use; u.ratio = 1; } else { u.ratio = Math.max(0, u.cap) / use; u.cap = 0; tally[u.side].capped += DT; }
    }
    // 一直开着的装备（抗性、推进器、损控等）：电容够就算运转
    for (const u of alive) if (u.ratio > 0.5) u.act |= u.t.alwaysOn || 0;
    assignTargets('A');
    assignTargets('B');
    // 电子战（作用于自己的目标，按距离）
    const webs = new Map(), paints = new Map(), dScan = new Map(), dRange = new Map();
    for (const u of alive) u.pointed = 0;
    const put = (m, v, x) => (m.get(v) || m.set(v, []).get(v)).push(x);
    for (const u of alive) {
      const v = u.target;
      if (!v?.alive || !engaged(u, v)) continue;
      const d = surf(u, v), k = u.ratio;
      // 跃迁扰断 / 扰频：一直开着（不受电子战开关影响，决定对方能不能跑）
      for (const x of u.t.points) if (d <= x.range) { v.pointed += x.str * (u.ratio > 0.5 ? 1 : 0); bit(u, x.m); }
      if (opt.ewar) {
        for (const w of u.t.webs) { const e = rangeEff(w, d); put(webs, v, w.v * k * e); bit(u, w.m, e > 0.01); }
        for (const p of u.t.paints) { const e = rangeEff(p, d); put(paints, v, p.v * k * e); bit(u, p.m, e > 0.01); }
        for (const x of u.t.damps) { const e = k * rangeEff(x, d); put(dScan, v, x.scan * e); put(dRange, v, x.lock * e); bit(u, x.m, e > 0.01); }
        u.t.ecms.forEach((e, i) => {
          if (rangeEff(e, d) > 0.01) bit(u, e.m);
          if (t < u.ecmNext[i]) return;
          u.ecmNext[i] = t + e.cycle;
          fired(u, e.m);
          const chance = e.str[v.t.sensorIdx] * k * rangeEff(e, d) / Math.max(1, v.t.sensor);
          if (rand() < chance) v.jam = Math.max(v.jam, t + e.jam);
        });
      }
      // 中和 / 吸电：周期开始时生效
      if (capOn) {
        const list = [...u.t.neuts.map((x) => [x, false]), ...u.t.noses.map((x) => [x, true])];
        list.forEach(([x, nos], j) => {
          const st = u.drain[j];
          const e = rangeEff(x, d);
          if (e <= 0.01) return;
          if (t >= st.next) {
            st.next = nextCycle(st.next, t, x.cycle);
            fired(u, x.m);
            const amt = Math.min(v.cap, x.amt * k * e);
            if (nos) {
              if (u.t.cap.max && v.cap / (v.t.cap.max || 1) > u.cap / u.t.cap.max) { v.cap -= amt; u.cap = Math.min(u.t.cap.max, u.cap + amt); tally[u.side].drained += amt; }
            } else { v.cap -= amt; tally[u.side].drained += amt; }
          }
          bit(u, x.m);
        });
      }
    }
    for (const u of alive) { u.velMult = 1; u.sigMult = 1; u.scanMult = 1; u.rangeMult = 1; }
    for (const [v, l] of webs) v.velMult = stack(l, true);
    for (const [v, l] of paints) v.sigMult = stack(l, false);
    for (const [v, l] of dScan) v.scanMult = stack(l, true);
    for (const [v, l] of dRange) v.rangeMult = stack(l, true);

    // 没有输出舰船的一方：剩下的船开始撤离
    for (const side of SIDES) {
      const mine = alive.filter((u) => u.side === side);
      if (mine.length && !mine.some((u) => u.t.dps > 0 && !u.escaping) && !units.some((u) => u.alive && u.warp && u.side === side) && !jumps.some((j) => j.side === side)) for (const u of mine) if (!u.escaping) u.escaping = t || DT;
    }
    move();
    // 对准完成、没被扰断的离场
    for (const u of alive) {
      if (!u.escaping || !u.alive || t - u.escaping < u.t.align || u.pointed > u.t.stab) continue;
      u.alive = false;
      u.escaped = true;
      u.r.escaped += 1;
      events.push({ t: B.t + DT, kind: 'escape', side: u.side, ship: u.r.row.ship, unit: u.i });
      if (rec) rec.units[u.i].escaped = B.t + DT;
    }

    // 武器
    for (const u of alive) {
      if (!u.alive) continue;
      const v = u.target;
      const T = tally[u.side];
      u.guns.forEach((st, k) => { if (st.reloadUntil > t) u.rld |= 1 << (u.t.guns[k].m ?? 31); });
      if (!v?.alive || !ready(v)) continue;
      if (u.jam > t) { T.jammed += DT; setLock(u, v); continue; }
      const d = surf(u, v);
      if (d > u.t.lockRange * u.rangeMult) { T.noRange += DT; continue; }
      if (u.lock > 0) { u.lock -= DT; T.lockWait += DT; continue; }
      u.t.guns.forEach((g, k) => {
        const st = u.guns[k];
        if (t < st.next || st.reloadUntil > t) return;
        // 目标远在射程外：不开火（等距离合适）
        if (d > g.reach * (g.turret && !g.vorton ? 1.6 : 1)) { st.next = t; T.outRange += DT / u.t.guns.length; return; }
        if (capOn && g.capNeed > 0) {
          if (u.cap < g.capNeed) { st.next = t + DT; T.capped += DT / u.t.guns.length; return; }
          u.cap -= g.capNeed;
        }
        st.next = nextCycle(st.next, t, g.cycle);
        st.last = t;
        fired(u, g.m);
        // 热能分解器：连续打同一目标逐轮加成
        let spool = 1;
        if (g.spool) {
          if (st.on !== v) { st.on = v; st.spool = 0; }
          spool = 1 + Math.min(g.spool.max, g.spool.per * st.spool);
          st.spool += 1;
        }
        const vol = g.volley * spool;
        T.potential += vol;
        if (g.vorton) {
          // 电涌投射器：按爆炸半径 / 速度算，再跳到主目标附近的敌船
          const hitOne = (x) => { const f = missileApply(x.t.sig * x.sigMult, speedOf(x), g.er, g.ev, g.drf); T.applied += vol * f; hit(u, x, g.dmg.map((y) => y * f)); shots.push(u.i, x.i, 1, k); };
          hitOne(v);
          let from = v;
          for (let j = 0; j < g.arcs; j++) {
            let next = null, bd = g.arcRange;
            for (const x of units) { if (!ready(x) || x.side === u.side || x === v || x.arced === t) continue; const dd = surf(from, x); if (dd <= bd) { bd = dd; next = x; } }
            if (!next) break;
            next.arced = t;
            hitOne(next);
            from = next;
          }
        } else if (g.doomsday) {
          // 末日武器：射程内直接命中，满伤害
          T.applied += vol;
          hit(u, v, g.dmg);
          shots.push(u.i, v.i, 1, k);
        } else if (g.turret) {
          const mult = turretRoll(g, u, v, d);
          if (mult) { T.applied += vol * mult; hit(u, v, g.dmg.map((y) => y * mult * spool)); }
          shots.push(u.i, v.i, mult ? 1 : 0, k);
        } else if (d <= g.reach) {
          const m = { u, v, pos: u.pos.slice(), life: g.flight, g, t0: t };
          missiles.push(m);
          if (rec) { m.rec = { f: u.i, to: v.i, t0: t, t1: null, hit: false, k }; rec.missiles.push(m.rec); }
        }
        if (g.ammo < Infinity && --st.ammo <= 0) { st.ammo = g.ammo; st.reloadUntil = st.next = t + g.reload; }
      });
    }
    // 武器运转：一个周期内开过火、没在装填
    for (const u of alive) u.guns.forEach((st, k) => bit(u, u.t.guns[k].m, t - st.last < u.t.guns[k].cycle + DT && st.reloadUntil <= t));
    for (const u of alive) { if (!u.alive) continue; if (u.drones.length) droneStep(u, t); if (u.squads.length) fighterStep(u, t); }
    // 导弹飞行
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i], v = m.v, g = m.g;
      const off = sub(v.pos, m.pos), dd = len(off) - v.t.radius, stepLen = g.mvel * DT;
      let done = false;
      if (!v.alive) done = true;
      else if (dd <= stepLen) {
        const f = missileApply(v.t.sig * v.sigMult, speedOf(v), g.er, g.ev, g.drf);
        tally[m.u.side].applied += g.volley * f;
        hit(m.u, v, g.dmg.map((x) => x * f));
        if (m.rec) m.rec.hit = true;
        done = true;
      } else {
        m.pos = add(m.pos, scale(off, stepLen / len(off)));
        m.life -= DT;
        if (m.life <= 0) done = true;
      }
      if (done) { if (m.rec) m.rec.t1 = t + DT; missiles.splice(i, 1); }
    }
    // 本地维修：护盾在周期开始、装甲 / 结构在周期结束时生效；没有逐件数据时按每秒维修量连续回复
    for (const u of units) {
      if (!u.alive) continue;
      const L = u.t.localReps;
      if (L?.length) {
        L.forEach((x, j) => {
          const st = u.lrep[j];
          if (st.reloadUntil > t) { u.rld |= 1 << (x.m ?? 31); return; }
          if (u.ratio < 0.5 && !x.charged) return;
          bit(u, x.m);
          if (t < st.next) return;
          if (st.pend) { u.hp[x.layer] = Math.min(u.t.max[x.layer], u.hp[x.layer] + st.pend); st.pend = 0; }
          st.next = nextCycle(st.next, t, x.cycle);
          fired(u, x.m);
          if (x.layer === 0) u.hp[0] = Math.min(u.t.max[0], u.hp[0] + x.amt);
          else st.pend = x.amt;
          if (x.ammo < Infinity && --st.ammo <= 0) { st.ammo = x.ammo; st.reloadUntil = st.next = t + x.reload; }
        });
      } else for (let l = 0; l < 3; l++) if (u.t.local[l] && u.hp[l] < u.t.max[l]) u.hp[l] = Math.min(u.t.max[l], u.hp[l] + u.t.local[l] * u.ratio * DT);
      const C = u.t.regenC, tau = u.t.regenTau;
      if (C && tau && u.hp[0] < C) { const x = u.hp[0] / C; u.hp[0] = Math.min(C, u.hp[0] + 10 * C / tau * (Math.sqrt(x) - x) * DT); }
    }
    // 后勤遥修：同时锁定几个受伤最重的队友（各自按锁定时间），每件遥修修其中缺血最多的；一个周期结束时生效
    if (opt.logi) {
      // 正在修（周期还没结束）的量，按目标累计：后勤挑目标时算进去，避免一群后勤都修同一艘
      const pend = new Map();
      for (const u of units) if (u.alive && u.rrep) u.t.remote.forEach((rep, j) => { const x = u.rrep[j].tgt; if (x) pend.set(x, (pend.get(x) || 0) + rep.amt); });
      for (const u of units) {
        if (!ready(u) || !u.t.remote.length) continue;
        // 周期结束：结算
        u.t.remote.forEach((rep, j) => {
          const st = u.rrep[j];
          if (!st.tgt || t < st.end) return;
          const a = st.tgt;
          st.tgt = null;
          pend.set(a, Math.max(0, (pend.get(a) || 0) - rep.amt));
          if (!a.alive) return;
          const amt = Math.min(a.t.max[rep.layer] - a.hp[rep.layer], rep.amt * rangeEff(rep, surf(u, a)));
          if (amt > 0) { a.hp[rep.layer] += amt; u.r.repaired += amt; shots.push(u.i, a.i, 2, -1); }
        });
        if (u.jam > t) { u.rl?.clear(); continue; }
        const layer = u.t.remote[0].layer;
        const reach = Math.max(...u.t.remote.map((x) => x.range + x.falloff));
        const R = Math.min(reach, u.t.lockRange * u.rangeMult);
        const rl = u.rl || (u.rl = new Map());   // 已锁定 / 正在锁定的队友 → 剩余锁定时间
        // 受伤最重的几个队友：没锁的开始锁；死了、离开距离、满血的放掉；同时最多锁 LOGI_LOCKS 个
        const hurt = [];
        for (const a of units) {
          if (!ready(a) || a.side !== u.side || a === u || !a.t.max[layer]) continue;
          const frac = (a.hp[layer] + (pend.get(a) || 0)) / a.t.max[layer];
          if (frac < 0.98 && surf(u, a) <= R) hurt.push([frac, a]);
        }
        hurt.sort((x, y) => x[0] - y[0]);
        for (const [x] of rl) if (!ready(x) || surf(u, x) > R * 1.1 || x.hp[layer] >= x.t.max[layer] * 0.995) rl.delete(x);
        for (const [, a] of hurt.slice(0, LOGI_LOCKS)) if (!rl.has(a) && rl.size < LOGI_LOCKS) rl.set(a, relock(u, a));
        for (const [x, left] of rl) if (left > 0) rl.set(x, left - DT);
        // 每件空闲的遥修：修锁定好的队友里（算上正在修的量）缺血最多的
        u.t.remote.forEach((rep, j) => {
          const st = u.rrep[j];
          if (st.tgt) { bit(u, rep.m); return; }
          if (u.ratio < 0.5) return;
          let best = null, bf = 0.995;
          for (const [x, left] of rl) {
            if (left > 0 || rangeEff(rep, surf(u, x)) < 0.05) continue;
            const f = (x.hp[rep.layer] + (pend.get(x) || 0)) / x.t.max[rep.layer];
            if (f < bf) { bf = f; best = x; }
          }
          if (!best) return;
          st.tgt = best;
          st.end = t + rep.cycle;
          pend.set(best, (pend.get(best) || 0) + rep.amt);
          u.repTarget = best;
          fired(u, rep.m);
          bit(u, rep.m);
        });
        if (u.repTarget && !u.rrep.some((st) => st.tgt === u.repTarget)) u.repTarget = u.rrep.find((st) => st.tgt)?.tgt || null;
      }
    }
    B.t = t + DT;
    const pending = support.some((s) => !s.fired && s.at != null) || jumps.length > 0;
    const left = { A: units.some((u) => u.alive && u.side === 'A'), B: units.some((u) => u.alive && u.side === 'B') };
    if (((!left.A || !left.B) && !pending) || B.t >= opt.max) B.done = true;
    record();
  };

  // ---------- 记录 ----------
  const hpSum = (list) => list.reduce((s, u) => s + u.hp[0] + u.hp[1] + u.hp[2], 0);
  const maxSum = (list) => list.reduce((s, u) => s + u.t.max[0] + u.t.max[1] + u.t.max[2], 0) || 1;
  // 每个时间点：存活（含已撤离）舰船数、场上血量比例
  function point() {
    const a = units.filter((u) => u.side === 'A'), b = units.filter((u) => u.side === 'B');
    const la = a.filter((u) => u.alive), lb = b.filter((u) => u.alive);
    return { t: Math.round(B.t), A: la.length + a.filter((u) => u.escaped).length, B: lb.length + b.filter((u) => u.escaped).length, hpA: hpSum(la) / maxSum(a), hpB: hpSum(lb) / maxSum(b) };
  }
  const DRONE_CLS = (g) => (g.sentry ? 3 : g.size);
  function record() {
    if (Number.isInteger(B.t) || B.done) timeline.push(point());
    if (!rec) return;
    const n = units.length;
    const pos = new Float32Array(n * 3), hp = new Uint8Array(n * 3), tg = new Int32Array(n).fill(-1);
    const spd = new Uint16Array(n), cp = new Uint8Array(n), act = new Uint32Array(n), rld = new Uint32Array(n), fire = new Uint32Array(n), lk = new Uint8Array(n);
    const dr = [], rr = [];
    units.forEach((u, i) => {
      pos[i * 3] = u.pos[0]; pos[i * 3 + 1] = u.pos[1]; pos[i * 3 + 2] = u.pos[2];
      if (!u.alive) return;
      u.rrep?.forEach((st, j) => { if (st.tgt?.alive) rr.push(i, st.tgt.i, u.t.remote[j].m); });
      for (let l = 0; l < 3; l++) hp[i * 3 + l] = u.t.max[l] ? Math.round(u.hp[l] / u.t.max[l] * 200) : 0;
      hp[i * 3 + 2] = Math.max(1, hp[i * 3 + 2]);
      spd[i] = Math.min(65535, Math.round(speedOf(u)));
      cp[i] = u.t.cap.max ? Math.round(Math.max(0, u.cap) / u.t.cap.max * 200) : 0;
      act[i] = u.act >>> 0;
      rld[i] = u.rld >>> 0;
      fire[i] = u.fire >>> 0;
      // 锁定：0 没有目标，1–199 锁定进度，255 已锁定
      if (u.target?.alive) lk[i] = u.lock > 0 ? Math.max(1, Math.min(199, Math.round((1 - u.lock / (u.lockAll || 1)) * 200))) : 255;
      if (u.target?.alive) tg[i] = u.target.i;
      else if (u.repTarget?.alive) tg[i] = u.repTarget.i;
      for (const d of u.drones) if (d.pos && (d.target || !d.g.sentry)) dr.push(i, d.pos[0], d.pos[1], d.pos[2], DRONE_CLS(d.g));
      for (const q of u.squads) if (q.pos) dr.push(i, q.pos[0], q.pos[1], q.pos[2], 4 + q.f.cls);
      u.rld = 0;
    });
    rec.frames.push({ t: B.t, pos, hp, tg, shots, spd, cp, act, rld, fire, lk, dr: Float32Array.from(dr), rr: Int32Array.from(rr), pa: primary.A ? primary.A.i : -1, pb: primary.B ? primary.B.i : -1 });
  }
  timeline.push(point());
  if (rec) {
    const n = units.length, pos = new Float32Array(n * 3), hp = new Uint8Array(n * 3), cp = new Uint8Array(n).fill(200);
    units.forEach((u, i) => { pos.set(u.pos, i * 3); for (let l = 0; l < 3; l++) hp[i * 3 + l] = u.t.max[l] ? 200 : 0; hp[i * 3 + 2] = 200; });
    rec.frames.push({ t: 0, pos, hp, tg: new Int32Array(n).fill(-1), shots: [], spd: new Uint16Array(n), cp, act: new Uint32Array(n), rld: new Uint32Array(n), fire: new Uint32Array(n), lk: new Uint8Array(n), dr: new Float32Array(0), rr: new Int32Array(0), pa: -1, pb: -1 });
  }

  // ---------- 结果 ----------
  // 胜负看战损：击毁对方的价值占双方损失的比例；≥ 75% 为大胜，≥ 55% 为占优
  B.result = () => {
    const last = timeline[timeline.length - 1];
    const start = { A: units.filter((u) => u.side === 'A').length, B: units.filter((u) => u.side === 'B').length };
    const isk = Boolean(opt.value) && rows.every((r) => opt.value(r.row) > 0);
    const worth = (u) => (isk ? opt.value(u.r.row) : u.t.ehp);
    const lossOf = (s) => units.reduce((t, u) => t + (u.side === s && !u.alive && !u.escaped ? worth(u) : 0), 0);
    const loss = { A: lossOf('A'), B: lossOf('B') };
    const total = loss.A + loss.B;
    const eff = total ? { A: loss.B / total, B: loss.A / total } : null;
    const lead = eff ? (eff.A >= 0.55 ? 'A' : eff.B >= 0.55 ? 'B' : null) : null;
    const winner = eff ? (eff.A >= 0.75 ? 'A' : eff.B >= 0.75 ? 'B' : null) : null;
    const escaped = { A: units.filter((u) => u.side === 'A' && u.escaped).length, B: units.filter((u) => u.side === 'B' && u.escaped).length };
    return { t: Math.ceil(B.t), timeline, kills, rows, winner, lead, eff, by: isk ? 'isk' : 'ehp', loss, tally, rec, start, startN, escaped,
      end: { A: last.A, B: last.B }, lost: { A: start.A - last.A, B: start.B - last.B }, hp: { A: last.hpA, B: last.hpB }, events };
  };
  return B;
}

// 一口气打完
export function simulate(sides, opt) {
  const B = createBattle(sides, opt);
  while (!B.done) B.step();
  return B.result();
}
