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
// 玩家驾驶（B.takeControl(i)，驾驶模拟页用）：这艘船不再自动走位、选目标，按 u.pilot 的指令行动——
//   走位 cmd：stop 停船 / approach 靠近 / orbit 环绕 / keep 保持距离 / dir 朝某方向（dir 单位向量）；speed 为速度比例（0–1）；
//   锁定 locks（目标 → 剩余锁定时间，最多 maxLocks 个，超出锁定距离自动解锁），active 为当前目标（武器、电子战打它）；
//   无人机 drones：true 放出（打当前目标）/ false 收回；装备 on（装备栏序号集合）：只有开着的武器、电子战、本地维修才运转；一直开着的装备（抗性、推进器等）按装配算。不会自动撤离。
// 记录（opt.record）：每步一帧，开火 / 遥修记为四元组 [开火方, 目标, 0 未命中 | 1 命中 | 2 遥修, 第几门武器]；
//   每艘船带上各门武器的特效信息（rec.units[i].fx）与装备列表（rec.units[i].rack）；每帧另有速度、电容、锁定进度，装备运转 / 装填 / 开始新周期的位掩码，
//   rec.units[i].ew 为电子战 / 遥修装备 [序号, web|scram|point|neut|nos|ecm|damp|paint|rs|ra|rh, 周期秒]，电子战作用于本帧目标 tg，遥修目标逐帧记在 rr（每 3 个数 [后勤, 目标, 装备序号]）；
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
// 玩家跃迁（驾驶模拟）：曲线照客户端 Destiny::WarpDistance 的闭式解重写，规则见 B.warpTo
export const AU = 149597870700;
export const MIN_WARP = 150000;   // 最短跃迁距离（appConst.minWarpDistance，按表面距离）
export const GRID = 8e6;          // 同一网格的范围（米）：电脑船只理会这个距离内的敌人，总览只列这个距离内的舰船。客户端的网格大小是动态的，这里取约 8000 km
const ALIGN_COS = Math.cos(5 * Math.PI / 180);   // 对准判定：速度 ≥ 75% 且航向偏差在 5° 内（客户端只显示进度，起跳由服务器判；角度为公开资料的说法）

const PENALTY = (i) => Math.exp(-((i / 2.67) ** 2));
const stack = (list, asc) => list.sort((a, b) => (asc ? a - b : b - a)).reduce((m, x, i) => m * (1 + x * PENALTY(i)), 1);
const rangeEff = (x, d) => (d <= x.range ? 1 : x.falloff > 0 ? 0.5 ** (((d - x.range) / x.falloff) ** 2) : 0);
const lockTime = (scanRes, sig) => (scanRes > 0 ? Math.min(60, 40000 / (scanRes * Math.asinh(sig) ** 2)) : 5);
const mean = (r) => (r[0] + r[1] + r[2] + r[3]) / 4 || 1;
// 导弹 / 舰载机 / 电涌投射器的伤害比例（游戏公式）
const missileApply = (sig, V, er, ev, drf) => (er > 0 ? Math.min(1, sig / er, V > 0 && ev > 0 ? ((sig / er) * (ev / V)) ** drf : 1) : 1);
// 下一个周期开始：上一周期刚结束（差不到一步）就接着算，保持节奏；停过（锁定、射程外）就从现在重新开始，不补打
const nextCycle = (next, t, cycle) => (t - next > DT ? t : next) + cycle;
function rng(seed) { let s = seed >>> 0 || 1; const f = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); f.get = () => s; f.set = (v) => { s = v >>> 0 || 1; }; return f; }

// 跃迁曲线（客户端 Destiny::WarpDistance）：k = 跃迁速度（AU/s），j = min(k/3, 2)，D = 跃迁距离（米）
//   峰值 vmax = min((D+1)·k·j/(k+j), k·AU)；加速段走过 e^{kt}（速率取 max(起跳速率, k·e^{kt})），巡航 vmax，减速段速率 vmax·e^{−j·t}
//   减速到 min(最大速度/2, 100 m/s) 以下时出跃迁，保留这个速率沿跃迁方向滑行
export function warpCurve(D, k, v0 = 0, maxV = 0) {
  const j = Math.min(k / 3, 2);
  const vmax = Math.min((D + 1) * k * j / (k + j), k * AU);
  const tA = Math.log(vmax / k) / k, tC = Math.max(0, D / vmax - 1 / k - 1 / j + 1 / vmax);
  const exit = Math.min(maxV * 0.5, 100) || 100;
  const tE = tA + tC + Math.log(vmax / Math.min(exit, vmax * 0.999)) / j;   // 出跃迁的时刻
  const at = (t) => {
    if (t < tA) return { s: Math.exp(k * t), v: Math.max(v0, k * Math.exp(k * t)) };
    if (t - tA < tC) return { s: vmax / k + vmax * (t - tA), v: vmax };
    const t3 = t - tA - tC;
    return { s: Math.min(D, vmax / k + vmax * tC + (vmax / j) * (1 - Math.exp(-j * t3))), v: vmax * Math.exp(-j * t3) };
  };
  return { k, j, vmax, tA, tC, tE, exit, at };
}

// 向量小工具（[x, y, z]）
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// 单位向量 h 朝单位向量 d 转过两者夹角的 f（在两者所在的平面里转；正好反向时绕水平轴转）
function turnToward(h, d, f) {
  const c = Math.max(-1, Math.min(1, h[0] * d[0] + h[1] * d[1] + h[2] * d[2])), th = Math.acos(c);
  if (th < 1e-6) return d.slice();
  let p = [d[0] - h[0] * c, d[1] - h[1] * c, d[2] - h[2] * c];
  if (len(p) < 1e-6) p = len([h[2], 0, -h[0]]) > 1e-6 ? [h[2], 0, -h[0]] : [1, 0, 0];
  p = norm(p);
  const w = th * f, cw = Math.cos(w), sw = Math.sin(w);
  return norm([h[0] * cw + p[0] * sw, h[1] * cw + p[1] * sw, h[2] * cw + p[2] * sw]);
}
const cap = (a, m) => { const l = len(a); return l > m ? scale(a, m / l) : a; };

// 定位：logi 后勤 / carrier 航母 / ewar 电子战 / tackle 拦截 / drone 无人机船 / dps 输出
function roleOf(t) {
  if (!t.dps && t.remote.length) return 'logi';
  if (t.fighters?.length && t.fighter >= t.dps * 0.5) return 'carrier';
  if (!t.dps && (t.ecms.length || t.damps.length || t.paints.length || t.neuts.length || t.webs.length || t.points.length || t.tds?.length || t.gds?.length || t.bursts?.length || t.bubbles?.length)) return t.radius < 200 && (t.points.length || t.webs.length) ? 'tackle' : 'ewar';
  if ((t.points.length || t.webs.length) && t.radius < 200) return 'tackle';
  if (!t.guns.length && t.drones.length) return 'drone';
  return 'dps';
}

const L = (t, k) => t[k] || [];
// 电子战与遥修装备（3D 特效、名单上的状态图标用）：[装备序号, 类别, 周期（秒）]；遥修的目标每帧另记（rr）
const ewList = (t) => [
  ...t.webs.map((x) => [x.m, 'web', x.cycle]), ...t.points.map((x) => [x.m, x.str >= 2 && !x.focus ? 'scram' : 'point', x.cycle]), ...t.neuts.map((x) => [x.m, 'neut', x.cycle]), ...t.noses.map((x) => [x.m, 'nos', x.cycle]),
  ...t.ecms.map((x) => [x.m, 'ecm', x.cycle]), ...t.damps.map((x) => [x.m, 'damp', x.cycle]), ...t.paints.map((x) => [x.m, 'paint', x.cycle]), ...t.remote.map((x) => [x.m, ['rs', 'ra', 'rh'][x.layer], x.cycle]),
  ...L(t, 'tds').map((x) => [x.m, 'td', x.cycle]), ...L(t, 'gds').map((x) => [x.m, 'gd', x.cycle]),
  ...L(t, 'rcaps').map((x) => [x.m, 'rc', x.cycle]), ...L(t, 'rsbs').map((x) => [x.m, 'rb', x.cycle]), ...L(t, 'rtcs').map((x) => [x.m, 'rt', x.cycle]),
  // 范围装备（没有目标，画在自己身上）：立体炸弹带主伤害类型 smart_em / th / ki / ex
  ...L(t, 'smarts').map((x) => [x.m, 'smart_' + ['em', 'th', 'ki', 'ex'][x.dmg.indexOf(Math.max(...x.dmg))], x.cycle, x.range]), ...L(t, 'bursts').map((x) => [x.m, 'burst', x.cycle, x.range]),
  ...L(t, 'bubbles').map((x) => [x.m, 'bubble', x.cycle, x.range]), ...L(t, 'mjds').map((x) => [x.m, 'mjd', x.spool, x.range]),
].filter(([m]) => m != null && m >= 0 && m < 32);

// opt: { dist (km), focus: weak|dps|spread, logi, ewar, cap, max (秒), moveA / moveB: orbit|range|kite, record, seed, value(row) → 单艘 ISK,
//        anchors: { A: { dps: 行 id, logi: 行 id }, B }, support: [{ side, rows: [{ row, count }], mode: warp|cyno, ref, dist (km), dir, at (秒) }] }
export function createBattle(sides, opt) {
  const rand = rng(opt.seed || 20261026);
  const capOn = opt.cap !== false;
  // 逐发命中回调（驾驶模拟的战斗日志用）：{ f 开火方, v 目标, type 武器 / 无人机类型, mult 炮台伤害倍数（0 = 未命中）, dmg 实际伤害, raw 各类型伤害, missile }
  const onHit = opt.onHit || null;
  // 中和 / 吸电每次生效：{ f: 施放者, v: 目标, m: 装备序号, amt: 实际转移的电量, nos }（驾驶模拟写战斗日志）
  const onDrain = opt.onDrain || null;
  const units = [];
  const rows = [];
  const rowOf = new Map();
  const blank = () => ({ unitSec: 0, potential: 0, applied: 0, lockWait: 0, noRange: 0, outRange: 0, jammed: 0, capped: 0, drained: 0 });
  const tally = { A: blank(), B: blank() };
  const kills = [];
  const missiles = [];
  const dooms = [];   // 预热中 / 正在出伤的末日武器
  const events = [];   // 增援、点名集火、撤离（回放与日志用）
  // 弹药打空：自动装填（客户端默认开）；玩家驾驶的装备装填后不会自己接着循环（要再开一次），关了自动装填的就停在 0 发
  const outOfAmmo = (u, st, x, t) => {
    if (u.infAmmo) { st.ammo = x.ammo; return; }   // 驾驶模拟作弊：无限弹药（不用装填）
    if (u.pilot) { u.pilot.on.delete(x.m); if (u.pilot.noReload?.has(x.m)) { st.ammo = 0; return; } }
    st.ammo = x.ammo;
    st.reloadUntil = st.next = t + x.reload;
  };
  const empty = (u, st, x) => x.ammo < Infinity && st.ammo <= 0 && Boolean(u.pilot);
  const primary = { A: null, B: null };
  const spawn = { A: [-opt.dist * 500, 0, 0], B: [opt.dist * 500, 0, 0] };
  const timeline = [];
  const rec = opt.record ? { units: [], frames: [], missiles: [], dooms: [], events, dt: DT } : null;
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
        hp: (tpl.hp0 || tpl.max).slice(), target: null, lock: 0, repTarget: null, repLock: 0, slot: p,
        cap: tpl.cap.max, ratio: 1, jam: 0, ecmNext: tpl.ecms.map((_, k) => k), scanMult: 1, rangeMult: 1, velMult: 1, sigMult: 1, act: 0, rld: 0,
        guns: tpl.guns.map((g, k) => ({ next: B.t + rand() * Math.min(2, g.cycle) + k * 0.05, ammo: g.ammo, reloadUntil: 0, last: -1e9, spool: 0, on: null })),
        inj: (tpl.injectors || []).map((x) => ({ next: 0, ammo: x.ammo, reloadUntil: 0 })),
        lrep: (tpl.localReps || []).map((x) => ({ next: B.t + rand() * x.cycle, ammo: x.ammo, reloadUntil: 0, pend: 0 })),
        rrep: tpl.remote.map(() => ({ end: 0, tgt: null })),
        drain: [...tpl.neuts.map(() => ({ next: 0 })), ...tpl.noses.map(() => ({ next: 0 }))],
        // 立体炸弹 / ECM 脉冲 / 远程电容传输的周期；友方辅助装备（电容传输、感应增强、跟踪电脑）当前对象
        aoe: [...L(tpl, 'smarts'), ...L(tpl, 'bursts')].map(() => ({ next: B.t + rand() * 2 })), rcn: L(tpl, 'rcaps').map(() => ({ next: 0 })), assist: null, aOut: [],
        optMult: 1, fallMult: 1, trackMult: 1, mvelMult: 1, flightMult: 1, erMult: 1, evMult: 1,
        drones: tpl.drones.flatMap((g) => Array.from({ length: g.n }, () => ({ g, pos: null, vel: [0, 0, 0], target: null, next: 0, dir: rand() < 0.5 ? 1 : -1 }))),
        squads: (tpl.fighters || []).flatMap((f) => Array.from({ length: f.squads }, () => ({ f, pos: null, vel: [0, 0, 0], target: null, next: 0, nextM: 0, dir: rand() < 0.5 ? 1 : -1 }))),
        warp: from ? { t0: B.t, to: pos.slice(), from: add(pos, scale(from, WARP_FROM)) } : null
      };
      if (u.warp) { u.pos = u.warp.from.slice(); u.vel = scale(from, -WARP_FROM / WARP_IN); }
      u.st0 = tpl;
      units.push(u);
      if (rec) rec.units.push({ side, ship: row.ship, row: row.id, radius: tpl.radius, born: B.t, fx: tpl.guns.map((g) => g.fx || null), gm: tpl.guns.map((g) => g.m ?? -1), rack: tpl.rack || [], vel: tpl.vel, cap: tpl.cap.max, ew: ewList(tpl) });
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
    if (v) for (const u of units) if (ready(u) && u.side === side && attacks(u) && !u.pilot && u.target !== v) { u.target = v; setLock(u, v); }
  };

  // ---------- 联机校正（匹配模式）----------
  // 服务器每步之后发 snap()，客户端跟着同样的指令走完同一步后 applySnap() 覆盖：随机数状态、每艘船的位置 / 速度 / 朝向 / 血量 / 电容 / 武器计时、击毁记录。
  // 同一套代码、同一个种子，正常情况下两边本来就一样；不同浏览器的数学函数末位可能不同，靠这个拉回来
  B.snap = () => ({
    t: B.t, rs: rand.get(),
    u: units.map((u) => [u.alive ? 1 : 0, u.pos, u.vel, u.face, u.hp, u.cap, u.guns.map((g) => [g.next, g.ammo, g.reloadUntil, g.last]), u.hv || null]),
    k: kills.map((k) => [k.at, k.unit, k.by]),
  });
  B.applySnap = (S0) => {
    rand.set(S0.rs);
    S0.u.forEach((x, i) => {
      const u = units[i];
      if (!u) return;
      u.pos = x[1].slice(); u.vel = x[2].slice(); u.face = x[3].slice(); u.hp = x[4].slice(); u.cap = x[5];
      if (x[7]) u.hv = x[7].slice();
      x[6].forEach((g, k) => { const st = u.guns[k]; if (st) [st.next, st.ammo, st.reloadUntil, st.last] = g; });
      if (!x[0] && u.alive) { u.alive = false; u.r.lost += 1; u.r.killTimes.push(Math.ceil(B.t)); }
      else if (x[0] && !u.alive) { u.alive = true; u.r.lost -= 1; }
    });
    // 击毁记录以服务器为准
    kills.length = 0;
    for (const [at, i, by] of S0.k) { const v = units[i]; if (v) kills.push({ t: Math.ceil(at), at, side: v.side, ship: v.r.row.ship, row: v.r, unit: i, by, drone: Boolean(v.isDrone) }); }
  };

  // 天体（驾驶模拟的跃迁目的地）：opt.cel = [{ name, group, pos（米）, radius, land（0 km 落点离中心的距离） }]
  B.cel = opt.cel || [];
  if (rec) rec.cel = B.cel;

  // ---------- 玩家驾驶 ----------
  B.takeControl = (i, maxLocks = 5) => {
    const u = units[i];
    if (!u) return null;
    u.pilot = { cmd: 'stop', tgt: null, dist: 0, dir: null, speed: 1, drones: false, on: new Set(), locks: new Map(), lockAll: new Map(), active: null, maxLocks };
    u.target = null;
    return u;
  };
  // 开始锁定 / 解锁（玩家）
  B.lock = (u, v) => {
    const P = u.pilot;
    if (!P || !v?.alive || v === u || v.cloak || P.locks.has(v) || P.locks.size >= P.maxLocks) return false;
    if (u.cloak || (P.lockBlock || 0) > B.t) return false;
    if (surf(u, v) > u.t.lockRange * u.rangeMult) return false;
    const T = relock(u, v);
    P.locks.set(v, T);
    P.lockAll.set(v, T);
    if (!P.active) P.active = v;
    return true;
  };
  B.unlock = (u, v) => {
    const P = u.pilot;
    if (!P) return;
    P.locks.delete(v);
    P.lockAll.delete(v);
    if (P.active === v) P.active = [...P.locks.keys()][0] || null;
  };
  // 跃迁至（玩家）：tgt = 舰船单位或 { cel: 天体序号 }，dist = 落点距离（米，0–100 km）
  // 先对准：全速朝目标点飞，速度 ≥ 75% 且航向偏差 ≤ 5° 时起跳（warpStart）；返回 true 或失败原因
  //   near 距离不到 150 km · scram 被扰断 / 扰频 / 在泡里 · cloak 开着普通隐形装置 · gone 目标不在了 · warping 已经在跃迁
  const warpPoint = (u, w) => {
    if (w.cel != null) {
      const c = B.cel[w.cel];
      if (!c) return null;
      const off = sub(u.pos, c.pos), d = len(off);
      return add(c.pos, scale(d > 1 ? scale(off, 1 / d) : [1, 0, 0], c.land || c.radius || 0));
    }
    if (w.pos) return w.pos.slice();
    return w.u?.alive && !w.u.warp ? w.u.pos.slice() : null;
  };
  const warpGap = (u, w, pt) => Math.max(0, len(sub(pt, u.pos)) - u.t.radius - (w.u ? w.u.t.radius : 0));
  B.warpTo = (u, tgt, dist = 0) => {
    const P = u.pilot;
    if (!P || !u.alive) return 'gone';
    if (u.warp) return 'warping';
    const w = tgt?.cel != null ? { cel: tgt.cel } : { u: tgt };
    const pt = warpPoint(u, w);
    if (!pt) return 'gone';
    if (warpGap(u, w, pt) < MIN_WARP) return 'near';
    if (u.cloak && !u.cloakWarp) return 'cloak';
    if (u.pointed > u.t.stab) return 'scram';
    Object.assign(P, { cmd: 'warp', wp: { ...w, dist: Math.max(0, Math.min(100000, dist)), t0: B.t }, tgt: null, pt: null, dir: null });
    return true;
  };
  // 加速门（驾驶模拟的死亡空间）：激活后不用对准、不耗电，直接跃迁到 pos（下一个口袋的落点）；name 为跃迁提示里的目的地名
  B.gateWarp = (u, pos, name = '') => {
    const P = u.pilot;
    if (!P || !u.alive) return 'gone';
    if (u.warp) return 'warping';
    if (u.pointed > u.t.stab) return 'scram';
    P.wp = { pos: pos.slice(), dist: 0, t0: B.t, gate: true, name };
    warpStart(u);
    return u.warp ? true : 'gone';
  };
  // 瞬移（深渊导管）：直接换到 pos，速度清零、解除锁定；放出去的无人机留在原地
  B.teleport = (u, pos) => {
    if (!u?.alive) return;
    u.pos = pos.slice();
    u.vel = [0, 0, 0];
    u.warp = null;
    if (u.pilot) { for (const v of [...u.pilot.locks.keys()]) B.unlock(u, v); Object.assign(u.pilot, { cmd: 'stop', tgt: null, wp: null, pt: null, dir: null }); }
    u.target = null;
    events.push({ t: B.t, kind: 'teleport', unit: u.i, side: u.side, pos: pos.slice() });
  };
  // 对准进度（客户端 spaceMgr：min(速度/75%, (cos+1)/1.99)^3）：HUD 进度条用
  B.alignProgress = (u) => {
    const P = u.pilot, pt = P?.cmd === 'warp' && P.wp ? warpPoint(u, P.wp) : null;
    if (!pt) return 0;
    const V = u.t.vel * u.velMult, sp = len(u.vel);
    const cos = sp > V * 0.01 ? dot(scale(u.vel, 1 / sp), norm(sub(pt, u.pos))) : -1;
    return Math.min(Math.min(1, sp / Math.max(1, V) / 0.75), (cos + 1) / 1.99) ** 3;
  };
  // 起跳：扣电容（不够就按电容缩短距离），清掉锁定，关掉推进器 / 微跳（pilot-rules 收到 warpStart 处理），无人机留在原地
  function warpStart(u) {
    const P = u.pilot, w = P.wp, pt = warpPoint(u, w);
    if (!pt) { P.cmd = 'stop'; P.wp = null; (P.msgs ||= []).push({ k: 'warpGone' }); return; }
    if (u.pointed > u.t.stab) { P.cmd = 'stop'; P.wp = null; (P.msgs ||= []).push({ k: 'warpScram' }); return; }
    const dir = norm(sub(pt, u.pos));
    const end = add(pt, scale(dir, -w.dist));   // 落点 = 目标点沿来向退 dist 米
    let D = len(sub(end, u.pos));
    const per = w.gate ? 0 : u.t.warpCap * u.t.mass / AU;   // 每米耗电（加速门不耗电）
    if (capOn && per > 0) {
      const can = Math.max(0, u.cap) / per;
      if (can < D) { D = can; (P.msgs ||= []).push({ k: 'warpLowCap' }); }
      u.cap -= D * per;
    }
    if (D < 1000) { P.cmd = 'stop'; P.wp = null; return; }
    for (const v of [...P.locks.keys()]) B.unlock(u, v);
    const c = warpCurve(D, u.t.warp, len(u.vel), u.t.vel * u.velMult);
    u.warp = { go: true, t0: B.t + DT, from: u.pos.slice(), dir, D, c, name: w.cel != null ? B.cel[w.cel]?.name : w.name || w.u?.r.row.label || '' };
    P.cmd = 'stop';
    P.wp = null;
    (P.msgs ||= []).push({ k: 'warpStart' });
    // 别人看到的出 / 入跃迁闪光时刻（WarpFlash.py）：加速度过 310000 m/s² 再随机延迟 0–250 毫秒起跳闪光；减速度回到 −215000 m/s² 以内落地闪光
    const tOut = Math.min(c.tA, Math.max(0, Math.log(310000 / (c.k * c.k)) / c.k));
    const tIn = Math.min(c.tE, c.tA + c.tC + Math.max(0, Math.log(c.vmax * c.j / 215000) / c.j));
    events.push({ t: B.t + DT, kind: 'warp', unit: u.i, side: u.side, D, dir, tOut: B.t + DT + tOut + ((u.i * 9301 + Math.round(B.t * 100) * 49297) % 233280) / 233280 * 0.25, tIn: B.t + DT + tIn });
  }
  function pilotLocks(alive) {
    for (const u of alive) {
      const P = u.pilot;
      if (!P) continue;
      for (const [v, left] of P.locks) {
        if (!v.alive || v.warp || surf(u, v) > u.t.lockRange * u.rangeMult) { B.unlock(u, v); continue; }
        if (u.jam > B.t) { P.locks.set(v, P.lockAll.get(v)); continue; }
        if (left > 0) P.locks.set(v, Math.max(0, left - DT));
      }
      if (P.active && !P.locks.has(P.active)) P.active = null;
      u.target = P.active;
      u.lock = P.active ? P.locks.get(P.active) : 0;
      u.lockAll = P.active ? P.lockAll.get(P.active) : 0;
    }
  }

  // ---------- 工具 ----------
  const ready = (u) => u.alive && !u.warp;
  const DRONE_AGGRO = 0.3;   // 闲着的 NPC 攻击者改打正在打本方的无人机的概率（每次挑目标）   // 跃迁中的船不能锁定、不能行动
  const center = (u, v) => len(sub(v.pos, u.pos));
  const surf = (u, v) => Math.max(0, center(u, v) - u.t.radius - v.t.radius);
  const curEhp = (u) => u.hp[0] / mean(u.t.res[0]) + u.hp[1] / mean(u.t.res[1]) + u.hp[2] / mean(u.t.res[2]);
  const relock = (u, v) => lockTime(u.t.scanRes * u.scanMult, v.t.sig * v.sigMult);
  // 开始锁定：记下总锁定时间（回放显示锁定进度）
  const setLock = (u, v) => { u.lock = u.lockAll = relock(u, v); };
  // 旧式 NPC（死亡空间等）的攻击延迟：SDE entityAttackDelayMin / Max（毫秒）—— 第一次有敌人可打时，等这之间的随机一段时间才开始选目标、锁定
  //   计时从敌人进入它的锁定距离 / 攻击范围（entityAttackRange，取大的）开始；别的房间里的 NPC 不提前计时
  const napping = (u, foes) => {
    const d = u.t.atkDelay;
    if (!d) return false;
    if (u.wake == null) {
      const R = Math.max(u.t.aggroR || 0, u.t.lockRange);
      if (!foes.some((v) => surf(u, v) <= R)) return true;
      u.wake = B.t + (d[0] + rand() * (d[1] - d[0])) / 1000;
    }
    return B.t < u.wake;
  };
  const attacks = (u) => u.t.dps > 0 || u.t.webs.length || u.t.paints.length || u.t.neuts.length || u.t.noses.length || u.t.damps.length || u.t.ecms.length || L(u.t, 'tds').length || L(u.t, 'gds').length;
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
    // 开火方被跟踪扰断 / 受远程跟踪电脑加成：最佳射程、失准范围、跟踪速度按倍数（无人机不受影响）
    const track = g.track * (from.trackMult ?? 1), opt = g.opt * (from.optMult ?? 1), fall = g.fall * (from.fallMult ?? 1);
    const chance = 0.5 ** ((track > 0 ? (w * g.sigRes / (track * sig || 1)) ** 2 : 0) + (Math.max(0, d - opt) / Math.max(1, fall)) ** 2);
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
    // 跃迁走、不在同一网格的敌人：电脑船不再追打（客户端里看不到别的网格上的船）
    for (const u of units) if (u.target && !u.pilot && u.side === side && center(u, u.target) > GRID) { u.target = null; u.lock = u.lockAll = 0; }
    const enemies = units.filter((u) => ready(u) && u.side !== side && !u.isDrone && !u.cloak && units.some((w) => w.side === side && ready(w) && !w.pilot && center(w, u) <= GRID));
    // 无人机实体（驾驶模拟）：没有舰船可打时才打；有舰船时，闲着的攻击者有一定概率去打在打本方的无人机
    const foeDrones = units.filter((u) => ready(u) && u.side !== side && u.isDrone);
    if (!enemies.length && foeDrones.length) { for (const u of units) if (ready(u) && u.side === side && attacks(u) && !u.pilot && !u.target?.alive && !napping(u, foeDrones)) { u.target = foeDrones[Math.floor(rand() * foeDrones.length)]; setLock(u, u.target); } return; }
    if (!enemies.length) return;
    const p = primary[side];
    if (p && !p.alive) primary[side] = null;
    const attackers = units.filter((u) => ready(u) && u.side === side && attacks(u) && !u.pilot && !napping(u, enemies));
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
    let need = attackers.filter((u) => !u.target?.alive);
    if (!need.length) return;
    if (foeDrones.length) {
      for (const u of need) {
        if (u.role === 'tackle' || rand() >= DRONE_AGGRO) continue;
        let best = null, bd = u.t.lockRange * u.rangeMult;
        for (const d of foeDrones) { if (d.d?.target?.side !== side) continue; const x = surf(u, d); if (x < bd) { bd = x; best = d; } }
        if (best) { u.target = best; setLock(u, best); }
      }
      need = need.filter((u) => !u.target?.alive);
      if (!need.length) return;
    }
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

  // NPC 巡航 / 追击（sim-npc 的 chase）：平时巡航速度；离目标太远时（等一段延迟后）开最大速度追一阵，信号半径跟着放大
  // 延迟 / 时长：按「几率」取满值，否则取 0 ~ 满值之间随机
  function chaseStep(alive, t) {
    for (const u of alive) {
      const c = u.t.chase;
      if (!c || u.pilot) continue;
      const st = u.chs || (u.chs = { on: false, until: 0, at: null });
      const tg = u.target?.alive && ready(u.target) ? u.target : null;
      const far = Boolean(tg) && surf(u, tg) > c.dist;
      if (st.on && (t >= st.until || !far)) { st.on = false; st.at = null; }
      if (!st.on) {
        if (!far) st.at = null;
        else {
          if (st.at == null) st.at = t + (rand() < c.delayP ? c.delay : rand() * c.delay);
          if (t >= st.at) { st.on = true; st.until = t + (rand() < c.durP ? c.dur : rand() * c.dur); }
        }
      }
      if (st.on) u.sigMult *= c.sig;
      else u.velMult *= c.cruise;
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
    if (!a.target?.alive && len(sub(enemyCen, a.pos)) > GRID) return [0, 0, 0];   // 敌人都跃迁走了：原地待命
    const ref = a.target?.alive ? a.target : { pos: enemyCen, vel: [0, 0, 0], t: { radius: 0 } };
    // 风筝：敌人贴近到距离的 60% 以内就直接背向拉开
    if (mode === 'kite' && len(sub(enemyCen, a.pos)) < R * 0.6) return scale(norm(sub(a.pos, enemyCen)), slow);
    return steer(a, ref, R, mode, slow);
  }
  // 玩家驾驶：按指令走位
  function pilotDesire(u, maxV) {
    const P = u.pilot, v = P.tgt?.alive && !P.tgt.warp ? P.tgt : null;
    const V = maxV * Math.max(0, Math.min(1, P.speed));
    if (P.cmd === 'dir' && P.dir) return scale(P.dir, V);
    // 跃迁对准：全速朝目标点（不看速度比例）
    if (P.cmd === 'warp' && P.wp) {
      const pt = warpPoint(u, P.wp);
      if (!pt) { P.cmd = 'stop'; P.wp = null; (P.msgs ||= []).push({ k: 'warpGone' }); return [0, 0, 0]; }
      return scale(norm(sub(pt, u.pos)), maxV);
    }
    // 飞向空间中的点（客户端 GotoPoint：Q + 两次点击选点）：到点停下；接近时按剩余距离减速
    if (P.cmd === 'point' && P.pt) {
      const off = sub(P.pt, u.pos), d = len(off);
      if (d < Math.max(10, u.t.radius * 0.2)) { P.cmd = 'stop'; P.pt = null; return [0, 0, 0]; }
      return scale(norm(off), Math.min(V, d / Math.max(0.5, u.t.tau * (u.tauMult ?? 1))));
    }
    if (!v || P.cmd === 'stop') { if (P.cmd !== 'stop' && P.cmd !== 'dir') P.cmd = 'stop'; return [0, 0, 0]; }
    if (P.cmd === 'approach') {
      const d = surf(u, v);
      return d < 50 ? scale(v.vel, 1) : scale(norm(sub(v.pos, u.pos)), V);
    }
    return steer(u, v, Math.max(0, P.dist), P.cmd === 'keep' ? 'range' : 'orbit', V);
  }
  function desired(u, ctx) {
    const maxV = u.t.vel * u.velMult;
    if (u.pilot) return pilotDesire(u, maxV);
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
      return len(off) < 1000 || len(off) > GRID ? [0, 0, 0] : scale(norm(off), maxV);
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
    // 玩家跃迁：按曲线走；减速到出跃迁速度以下时落地，保留出跃迁速度沿跃迁方向滑行（之后按停船减速）
    for (const u of units) {
      if (!u.alive || !u.warp?.go) continue;
      const w = u.warp, T = t + DT - w.t0;
      if (T < 0) continue;
      const x = w.c.at(T);
      if (T >= w.c.tE || x.s >= w.D) {
        u.pos = add(w.from, scale(w.dir, Math.min(x.s, w.D)));
        u.vel = scale(w.dir, w.c.exit);
        u.warp = null;
        if (u.pilot) (u.pilot.msgs ||= []).push({ k: 'warpEnd' });
        events.push({ t: B.t + DT, kind: 'warpEnd', unit: u.i, side: u.side });
        continue;
      }
      u.pos = add(w.from, scale(w.dir, x.s));
      u.vel = scale(w.dir, x.v);
      u.hv = w.dir.slice();
    }
    // 跃迁进场：减速落地
    for (const u of units) {
      if (!u.alive || !u.warp || u.warp.go) continue;
      const s = Math.min(1, (t + DT - u.warp.t0) / WARP_IN);
      const p = add(u.warp.to, scale(sub(u.warp.from, u.warp.to), (1 - s) ** 3));
      u.vel = scale(sub(p, u.pos), 1 / DT);
      u.pos = p;
      if (len(u.vel) > 1e-6) u.hv = norm(u.vel);
      if (s >= 1) { u.warp = null; u.vel = scale(norm(u.vel), 100); }
    }
    const alive = units.filter((u) => ready(u) && !u.isDrone);
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
        const a = 1 - Math.exp(-h / Math.max(0.5, u.t.tau * (u.tauMult ?? 1)));
        // 朝向（只给画面用，不影响战斗）：客户端船头朝向是单独按角速度积分的，不是速度方向（停着也是慢慢转过去）。
        //   这里每步把船头到目标方向剩下的角度转掉 a（和速度同一个惯性时间常数）：小角度转弯和速度方向的变化一样快，
        //   大角度掉头平滑地转过去（不会像速度那样先缩到 0 再翻过去）；没有目标方向（停船）时保持
        const dl = len(D);
        if (!u.hv) u.hv = len(u.vel) > 1e-6 ? norm(u.vel) : norm(u.face || [0, 0, 1]);
        if (dl > 1e-6) u.hv = turnToward(u.hv, [D[0] / dl, D[1] / dl, D[2] / dl], a);
        u.vel = [u.vel[0] + (D[0] - u.vel[0]) * a, u.vel[1] + (D[1] - u.vel[1]) * a, u.vel[2] + (D[2] - u.vel[2]) * a];
        u.pos = [u.pos[0] + u.vel[0] * h, u.pos[1] + u.vel[1] * h, u.pos[2] + u.vel[2] * h];
      }
    }
  }

  // ---------- 伤害 ----------
  function hit(u, v, dmg) {
    if (!v.alive || v.god) return 0;   // god：驾驶模拟作弊的无敌
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
    if (u) u.r.dealt += dealt;
    if (v.hp[2] <= 1e-6) {
      v.alive = false;
      v.r.lost += 1;
      v.r.killTimes.push(Math.ceil(B.t));
      kills.push({ t: Math.ceil(B.t), at: B.t, side: v.side, ship: v.r.row.ship, row: v.r, unit: v.i, by: !u ? -1 : u.isDrone ? u.owner.i : u.i, drone: Boolean(v.isDrone) });
    }
    return dealt;
  }
  // 环境区域（驾驶模拟的深渊云团 / 塔，dogma 里是 AOE 信标的 dbuff）：{ pos, r, unit?（塔被打掉就失效）, mods: { sig, vel, agi, track, sbAmt, sbDur }（乘数）,
  //   dmg: [电磁, 热能, 动能, 爆炸]（每 cycle 秒打一次区域里的无人机和 droneFrig 标记的 NPC） }
  B.zones = [];
  // 同一种加成几团重叠只算一个值（dbuff 的合并方式：速度 81、惯性 80 取最小，信号 79、跟踪 84、护盾回充 88 / 89 取最大）
  const ZONE_MIN = new Set(['vel', 'agi']);
  // 一条属性的叠加惩罚：加成、减益各自从强到弱排（dogma 正负分开），小数列表（+300% → 3）
  const chain = (l) => stack(l.filter((x) => x < 0), true) * stack(l.filter((x) => x > 0), false);
  // 区域加成和同属性的其他百分比加成排进同一条链：装备的（模板 pen）、电子战的（网子 / 标记器 / 跟踪扰断与远程跟踪），
  // 结果 ÷ 装备那条链本身（模板数值里已经算过）
  // pen：null = 属性本身不受惩罚（直接乘），没有（电脑船、无人机）= 没有装备加成
  const inChain = (pen, ewar, z) => (pen === null ? chain([...ewar]) * z : chain([...(pen || []), ...ewar, z - 1]) / chain([...(pen || [])]));
  function zoneStep(alive, t, webs, paints, wd) {
    for (const u of alive) { u.tauMult = 1; u.sbAmt = 1; u.sbDur = 1; }
    const got = new Map();
    for (const z of B.zones) {
      if (z.unit && !z.unit.alive) continue;
      const fire = z.dmg && t >= (z.next ?? 0);
      if (fire) z.next = t + (z.cycle || 2);
      for (const v of alive) {
        if (v.warp || len(sub(v.pos, z.pos)) > z.r) continue;
        const m = z.mods || {};
        let g = got.get(v);
        for (const k in m) {
          if (!m[k]) continue;
          if (!g) got.set(v, (g = {}));
          g[k] = g[k] == null ? m[k] : ZONE_MIN.has(k) ? Math.min(g[k], m[k]) : Math.max(g[k], m[k]);
        }
        if (fire && (v.isDrone || v.droneFrig)) hit(null, v, z.dmg);
      }
    }
    for (const [v, g] of got) {
      const pen = v.t.pen || {};
      if (g.vel) v.velMult = inChain(pen.vel, webs.get(v) || [], g.vel);
      if (g.sig) v.sigMult = inChain(pen.sig, paints.get(v) || [], g.sig);
      if (g.track) v.trackMult = inChain(pen.track, wd.get(v)?.track || [], g.track);
      if (g.agi) v.tauMult = inChain(pen.agi, [], g.agi);
      if (g.sbAmt) v.sbAmt = g.sbAmt;
      if (g.sbDur) v.sbDur = g.sbDur;
    }
  }
  // 环境伤害（驾驶模拟的深渊出界、计时结束）：不计抗性，依次扣护盾、装甲、结构；amt = Infinity 直接摧毁
  B.hurt = (v, amt) => {
    if (!v?.alive || v.god) return;
    let left = amt;
    for (let l = 0; l < 3 && left > 0; l++) { const x = Math.min(v.hp[l], left); v.hp[l] -= x; left -= x; v.r.taken += x; }
    if (v.hp[2] <= 1e-6) {
      v.hp = [0, 0, 0];
      v.alive = false;
      v.r.lost += 1;
      v.r.killTimes.push(Math.ceil(B.t));
      kills.push({ t: Math.ceil(B.t), at: B.t, side: v.side, ship: v.r.row.ship, row: v.r, unit: v.i, by: -1, drone: Boolean(v.isDrone) });
    }
  };
  const engaged = (u, v) => u.jam <= B.t && surf(u, v) <= u.t.lockRange * u.rangeMult && u.lock <= 0;
  const bit = (u, m, on = true) => { if (on && m != null && m >= 0 && m < 32) u.act |= 1 << m; };
  // 这一步开始了新周期的装备（回放画周期进度圈）
  const fired = (u, m) => { if (m != null && m >= 0 && m < 32) u.fire |= 1 << m; };

  // 无人机实体（opt.droneUnits，驾驶模拟）：放出后成为能被锁定、能被打的单位；收回时隐藏（血量带回无人机舱）
  function droneSpawn(u, d) {
    const g = d.g, e0 = g.ent;
    if (!e0) return;
    if (!d.hp) d.hp = e0.max.slice();
    const r = { row: { ship: g.type, id: 'drone:' + g.type }, side: u.side, lost: 0, escaped: 0, dealt: 0, taken: 0, repaired: 0, n: 1, killTimes: [] };
    const e = {
      i: units.length, side: u.side, r, t: e0, role: 'drone', pos: d.pos, vel: d.vel, face: [1, 0, 0], orbitN: u.orbitN, alive: true, born: B.t, escaping: 0, escaped: false, pointed: 0,
      hp: d.hp, target: null, lock: 0, repTarget: null, repLock: 0, slot: [0, 0, 0], cap: 0, ratio: 1, jam: 0, ecmNext: [], scanMult: 1, rangeMult: 1, velMult: 1, sigMult: 1, act: 0, rld: 0,
      guns: [], inj: [], lrep: [], rrep: [], drain: [], drones: [], squads: [], warp: null, isDrone: true, owner: u, d
    };
    d.e = e;
    units.push(e);
    if (rec) rec.units.push({ side: u.side, ship: g.type, row: r.row.id, radius: e0.radius, born: B.t, fx: [], rack: [], vel: g.vel, cap: 0, ew: [], drone: true });
  }
  function droneHide(d) {
    const e = d.e;
    d.e = null;
    if (!e || !e.alive) return;
    e.alive = false;
    e.escaped = true;
    if (rec) rec.units[e.i].escaped = B.t + DT;
  }
  // 无人机：出击、环绕目标、按炮台公式开火
  function droneStep(u, t) {
    const v = u.target && ready(u.target) && !(u.jam > t) && u.lock <= 0 ? u.target : null;
    const T = tally[u.side];
    for (let k = u.drones.length - 1; k >= 0; k--) {
      const d = u.drones[k], g = d.g;
      // 无人机实体被打爆：从母舰的无人机里去掉
      if (d.e && !d.e.alive && !d.e.escaped) { u.drones.splice(k, 1); continue; }
      // 母舰跃迁走了（或不在同一网格）：无人机留在原地待命，回到控制距离内才重新听指挥（客户端：你将要跃迁远离你的无人机）
      if (d.pos && (u.warp || len(sub(d.pos, u.pos)) > Math.max(g.control || 0, 1e5))) { d.vel = [0, 0, 0]; d.target = null; if (d.e) d.e.vel = d.vel; continue; }
      // 玩家：无人机按指令放出 / 收回（pilot.drones），放出后打当前目标
      if (u.pilot && !u.pilot.drones) { if (d.e) droneHide(d); d.pos = null; d.target = null; continue; }
      const go = v && surf(u, v) <= g.control ? v : null;
      // 出击：从母舰放出，出现在船体外侧（随机方向）；和母舰重合的话环绕方向算不出来，会一直卡在船中心
      if ((go || u.pilot) && !d.pos) d.pos = add(u.pos, scale(norm([rand() - 0.5, (rand() - 0.5) * 0.4, rand() - 0.5]), u.t.radius + 30));
      d.target = go;
      if (!d.pos) continue;
      if (opt.droneUnits && !d.e) droneSpawn(u, d);
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
      if (d.e) { d.e.pos = d.pos; d.e.vel = d.vel; }
      if (!go || t < d.next) continue;
      const dist = Math.max(0, len(sub(go.pos, d.pos)) - go.t.radius);
      if (dist > g.attackRange) continue;
      d.next = nextCycle(d.next, t, g.cycle);
      T.potential += g.volley;
      const mult = turretRoll(g, d, go, dist);
      const raw = mult ? g.dmg.map((x) => x * mult) : g.dmg;
      const got = mult ? (T.applied += g.volley * mult, hit(u, go, raw)) : 0;
      onHit?.({ f: u, v: go, type: g.type, mult, dmg: got, raw, drone: true });
      if (rec && d.e) dshots.push(d.e.i, go.i, mult ? 1 : 0);
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

  // 玩家装备的周期：P.cyc 记每件装备下一个周期开始的时间；武器（开火时扣电）、电容注入器另算
  const pilotCycles = (u, t) => {
    const P = u.pilot, rack = u.t.rack || [];
    P.cyc = P.cyc || new Map();
    P.msgs = P.msgs || [];
    P.started = new Set();   // 这一步开始了新周期的装备（立体炸弹、ECM 脉冲、电容传输、微跳按它生效）
    const skip = new Set([...u.t.guns.map((g) => g.m), ...(u.t.injectors || []).map((x) => x.m)]);
    const charged = new Set((u.t.localReps || []).filter((x) => x.charged).map((x) => x.m));   // 辅助维修装了电容弹药：不耗电
    const live = new Set(P.on);
    for (let i = 0; i < rack.length; i++) if ((u.t.alwaysOn || 0) & (1 << i)) live.add(i);
    for (const i of [...P.cyc.keys()]) if (!live.has(i)) P.cyc.delete(i);
    for (const i of live) {
      const m = rack[i];
      if (!m || skip.has(i) || !(m.cycle > 0)) continue;
      const next = P.cyc.get(i);
      if (next != null && t < next) continue;
      // 指向性、不带失准的装备：新周期开始时目标超出最远距离就停
      if (P.on.has(i) && P.targeted?.has(i) && !(m.fall > 0) && m.rng > 0) {
        const v = P.active;
        if (!v?.alive) { P.on.delete(i); P.cyc.delete(i); continue; }
        const d = surf(u, v);
        if (d > m.rng) { P.on.delete(i); P.cyc.delete(i); P.msgs.push({ k: 'far', i, v, rng: m.rng }); continue; }
      }
      if (m.cap > 0 && !charged.has(i)) {
        if (u.cap < m.cap) {
          if (P.on.has(i)) { P.on.delete(i); P.msgs.push({ k: 'cap', i, need: m.cap, got: u.cap }); }
          P.cyc.delete(i);
          continue;
        }
        u.cap -= m.cap;
      }
      P.cyc.set(i, (next != null && t - next < m.cycle ? next : t) + m.cycle);
      P.started.add(i);
    }
  };
  // 范围装备没有目标：电脑船只在范围内有敌船、没有本方舰船时才开（游戏里立体炸弹 / ECM 脉冲敌我都打；
  // NPC 什么时候开在服务器上，客户端没有依据——这是本模拟器自己的策略）
  // 范围按船心距离量（客户端 EMPWave.py：ballpark.DistanceBetween，球心距，不扣两船半径）
  const aoeWanted = (u, range) => {
    let foe = false;
    for (const x of units) {
      if (!ready(x) || x === u || x.isDrone || center(u, x) > range) continue;
      if (x.side === u.side) return false;
      foe = true;
    }
    return foe;
  };
  // 立体炸弹 / ECM 脉冲：每个周期开头对范围内所有船（不分敌我，不含自己）生效；跃迁扰断力场：开着时范围内所有船跑不掉
  function areaStep(alive, t, on) {
    for (const u of alive) {
      const sm = L(u.t, 'smarts'), bu = L(u.t, 'bursts');
      [...sm, ...bu].forEach((x, j) => {
        const isBomb = j < sm.length, st = u.aoe[j];
        if (!st) return;
        let go;
        if (u.pilot) { if (!u.pilot.on.has(x.m)) return; bit(u, x.m); go = u.pilot.started?.has(x.m); }
        else {
          if (u.ratio < 0.5 || (!aoeWanted(u, x.range) && t >= st.next)) return;
          bit(u, x.m);
          go = t >= st.next;
          if (go) st.next = nextCycle(st.next, t, x.cycle);
        }
        if (!go) return;
        fired(u, x.m);
        for (const v of units) {
          if (!ready(v) || v === u || center(u, v) > x.range) continue;
          if (isBomb) {
            const raw = x.dmg.slice();
            const got = hit(u, v, raw);
            shots.push(u.i, v.i, 3, x.m);   // 画面：冲击波扫到目标时冒一下（sim-fx 按 500 毫秒 × 距离 / 半径 延迟，客户端 EMPWave）
            if (v.side !== u.side) tally[u.side].applied += got;
            onHit?.({ f: u, v, type: x.type, mult: 1, dmg: got, raw, missile: true, aoe: true });
          } else if (v.t.sensor > 0 || x.str.some(Boolean)) {
            const chance = x.str[v.t.sensorIdx] / Math.max(1, v.t.sensor);
            if (rand() < chance) {
              v.jam = Math.max(v.jam, t + x.jam);
              (v.jamBy || (v.jamBy = new Map())).set(`${u.i}:${x.m}`, { u, m: x.m, t0: t, end: t + x.jam, burst: true });
            }
          }
        }
        // 立体炸弹也打掉范围内飞行中的导弹（自己的除外）
        if (isBomb) for (let k = missiles.length - 1; k >= 0; k--) { const mm = missiles[k]; if (mm.u !== u && len(sub(mm.pos, u.pos)) <= x.range) { if (mm.rec) mm.rec.t1 = t; missiles.splice(k, 1); } }
      });
      for (const x of L(u.t, 'bubbles')) {
        if (u.pilot ? !u.pilot.on.has(x.m) : u.ratio < 0.5 || !aoeWanted(u, x.range * 1.5)) continue;
        bit(u, x.m);
        for (const v of units) if (ready(v) && v !== u && center(u, v) <= x.range) v.pointed += x.str;
      }
    }
  }
  // 远程电容传输 / 远程感应增强 / 远程跟踪电脑：玩家对当前目标开；电脑船挑范围内的队友（电容传输给电容比例最低的，其余给输出最高的）
  function assistStep(alive, t, on, putW, put, bScan, bRange) {
    for (const u of alive) {
      u.aOut = [];
      const rc = L(u.t, 'rcaps'), rb = L(u.t, 'rsbs'), rt = L(u.t, 'rtcs');
      if (!rc.length && !rb.length && !rt.length) continue;
      if (u.jam > t) continue;
      const reach = Math.max(...[...rc, ...rb, ...rt].map((x) => x.range + x.falloff));
      let v;
      if (u.pilot) v = u.target?.alive && u.lock <= 0 ? u.target : null;
      else {
        v = u.assist;
        if (!v || !ready(v) || surf(u, v) > reach) {
          v = null;
          let best = -Infinity;
          for (const a of alive) {
            if (a === u || a.side !== u.side || a.isDrone || surf(u, a) > reach) continue;
            const sc = rc.length ? 1 - Math.max(0, a.cap) / (a.t.cap.max || 1) : a.t.dps;
            if (sc > best) { best = sc; v = a; }
          }
          u.assist = v;
        }
      }
      if (!v) continue;
      const d = surf(u, v), k = u.pilot ? 1 : u.ratio;
      rc.forEach((x, j) => {
        if (!on(u, x)) return;
        const e = rangeEff(x, d);
        if (e <= 0.01) return;
        bit(u, x.m); u.aOut.push([v, x.m]);
        const st = u.rcn[j];
        const go = u.pilot ? u.pilot.started?.has(x.m) : t >= st.next;
        if (!go) return;
        if (!u.pilot) st.next = nextCycle(st.next, t, x.cycle);
        fired(u, x.m);
        if (capOn) v.cap = Math.min(v.t.cap.max, v.cap + x.amt * k * e);
      });
      for (const x of rb) { if (!on(u, x)) continue; const e = k * rangeEff(x, d); if (e <= 0.01) continue; put(bScan, v, x.scan * e); put(bRange, v, x.lock * e); bit(u, x.m); u.aOut.push([v, x.m]); }
      for (const x of rt) { if (!on(u, x)) continue; const e = k * rangeEff(x, d); if (e <= 0.01) continue; putW(v, 'opt', x.opt * e); putW(v, 'fall', x.fall * e); putW(v, 'track', x.track * e); bit(u, x.m); u.aOut.push([v, x.m]); }
    }
  }
  // 微型跃迁引擎（只有玩家用）：开启后预热一个周期，然后沿船头朝向跳 mjdJumpRange（停船时保持最后的朝向）；被扰频开不起来 / 预热中被扰频就失败；
  // 跳完装备进入重启延迟（P.cool：装备序号 → 可再开的时间）
  // 拦截泡（拦截舰的拦截泡发射器）：开一次发射一枚探针，在发射时自己的位置展开一个泡，留在原地 life 秒；
  // 泡里所有船（包括放泡的自己）都跃迁不了。弹药打完自动装填（装填完不会自己再发射）
  const dictorLive = [];
  B.dictorBubbles = dictorLive;
  function dictorStep(alive, t) {
    for (const u of alive) {
      const P = u.pilot, ds = L(u.t, 'dictors');
      if (!P || !ds.length) continue;
      u.dict ||= ds.map((x) => ({ ammo: x.ammo, reloadUntil: 0, next: 0 }));
      ds.forEach((x, j) => {
        const st = u.dict[j];
        if (st.reloadUntil > t) { u.rld |= 1 << (x.m ?? 31); return; }
        if (!P.on.has(x.m)) return;
        bit(u, x.m);
        if (t < st.next) return;
        st.next = t + x.cycle;
        fired(u, x.m);
        dictorLive.push({ pos: u.pos.slice(), r: x.range, t0: t, end: t + x.life, by: u.i });
        events.push({ t, kind: 'bubble', unit: u.i, pos: u.pos.slice(), r: x.range, life: x.life });
        if (--st.ammo <= 0) outOfAmmo(u, st, x, t);
      });
    }
    for (let k = dictorLive.length - 1; k >= 0; k--) if (dictorLive[k].end <= t) dictorLive.splice(k, 1);
    for (const b of dictorLive) for (const v of units) if (ready(v) && len(sub(v.pos, b.pos)) <= b.r) v.pointed += 100;
  }
  function mjdStep(alive, t) {
    for (const u of alive) {
      const P = u.pilot;
      if (!P) continue;
      // 船头朝向 = 航向；停下来时保持最后的朝向（开局朝着敌人）
      if (speedOf(u) > 1) u.head = norm(u.vel); else if (!u.head) u.head = norm(u.face || [1, 0, 0]);
      for (const x of L(u.t, 'mjds')) {
        if (!P.on.has(x.m)) { if (u.mjd?.m === x.m) u.mjd = null; continue; }
        if (u.scram) { P.on.delete(x.m); u.mjd = null; (P.msgs ||= []).push({ k: 'mjdScram', i: x.m }); continue; }
        if (!u.mjd) { u.mjd = { m: x.m, t0: t, at: t + x.spool }; fired(u, x.m); }
        bit(u, x.m);
        if (t + DT < u.mjd.at) continue;
        const dir = u.head;
        const from = u.pos.slice();
        u.pos = add(u.pos, scale(dir, x.range));
        u.mjd = null;
        P.on.delete(x.m);
        (P.cool ||= new Map()).set(x.m, t + DT + x.delay);
        (P.msgs ||= []).push({ k: 'mjd', i: x.m });
        events.push({ t: t + DT, kind: 'mjd', unit: u.i, from, to: u.pos.slice() });
      }
    }
  }
  // 隐形装置（玩家）：开着时别的船锁不到、已有的锁定断开、自己的锁定也全丢；
  // 离任何船 / 无人机 2000 米内（客户端 appConst.minCloakingDistance，按表面距离算）自动解除；
  // 解除后 cloakingTargetingDelay 内不能锁定，重启延迟 moduleReactivationDelay 后才能再开（同微跳的 P.cool）
  const CLOAK_DIST = 2000;
  const nearAny = (u) => units.some((x) => x !== u && x.alive && !x.warp && surf(u, x) < CLOAK_DIST);
  B.cloakNear = (u) => nearAny(u);
  function cloakStep(alive, t) {
    for (const u of alive) {
      const P = u.pilot, cl = L(u.t, 'cloaks');
      if (!P || !cl.length) { u.cloak = false; continue; }
      let c = cl.find((x) => P.on.has(x.m));
      if (c && nearAny(u)) { P.on.delete(c.m); (P.msgs ||= []).push({ k: 'decloak', i: c.m }); c = null; }
      if (c && !u.cloak) {
        for (const v of [...P.locks.keys()]) B.unlock(u, v);
        // 开隐形时其他装备停下（客户端：隐形状态下装备不能运转）；P.cloakKeep 里的（推进器等非攻击性装备）由驾驶模拟跑完这一轮再停
        for (const i of [...P.on]) if (i !== c.m && !P.cloakKeep?.has(i)) P.on.delete(i);
        u.cloakM = c.m;
        u.cloakT0 = t;
      }
      if (!c && u.cloak) {
        const x = cl.find((y) => y.m === u.cloakM) || cl[0];
        P.lockBlock = t + x.delay;
        (P.cool ||= new Map()).set(x.m, t + x.cool);
      }
      u.cloak = !!c;
      u.cloakWarp = Boolean(c?.warp);
      if (c) bit(u, c.m);
    }
    // 跃迁中的船不在 alive 里（不结算装备），隐秘行动隐形装置带着隐形跃迁时仍记为开着，否则画面会在跃迁途中解除隐形、落地再隐形一次
    for (const u of units) if (u.alive && u.warp && u.cloak && u.cloakM != null) bit(u, u.cloakM);
    for (const v of units) if (v.target?.cloak) { v.target = null; v.lock = v.lockAll = 0; }
  }
  // 超级航母脉冲波投射器（doomsdayAOE*）：对目标开，预热 warn 秒后在目标当时的位置生成半径 radius 的力场，持续 life 秒；
  // 力场里的船（不分敌我，不含开的那艘）受对应的电子战（叠加惩罚和普通电子战一起算）；中和 / ECM 只在生成的那一刻结算一次
  // 电脑船：目标在 maxRange 内、目标周围 radius 内没有本方舰船才开（客户端没有依据——本模拟器自己的策略）
  const fieldsLive = [];
  B.fields = fieldsLive;
  const inField = (f, v) => len(sub(v.pos, f.pos)) <= f.x.radius;
  function fieldStart(alive, t) {
    for (const u of alive) {
      const fl = L(u.t, 'fields');
      if (!fl.length) continue;
      u.fieldEnd ||= fl.map(() => 0);
      fl.forEach((x, j) => {
        const P = u.pilot, v = P ? P.active : u.target;
        if (P) {
          if (!P.on.has(x.m)) return;
          bit(u, x.m);
          // 一次只开一轮（disallowRepeatingActivation）：这一轮跑完就停
          if (u.fieldEnd[j] > t && t + DT >= u.fieldEnd[j]) { P.on.delete(x.m); return; }
          if (!P.started?.has(x.m) || u.fieldEnd[j] > t) return;
          if (!v?.alive || v.cloak) return;
        } else {
          if (t < u.fieldEnd[j] || !v?.alive || v.cloak || !engaged(u, v) || center(u, v) > x.reach || u.ratio <= 0.5) return;
          if (units.some((w) => w.alive && w.side === u.side && !w.isDrone && w !== u && center(v, w) <= x.radius)) return;
          bit(u, x.m);
        }
        u.fieldEnd[j] = t + x.cycle;
        fired(u, x.m);
        const f = { u, x, v, t0: t, at: t + x.warn, end: t + x.warn + Math.max(x.life, DT), pos: null, done: false };
        if (rec) { f.rec = { kind: 'field', k: x.kind, unit: u.i, to: v.i, t: t, at: f.at, end: f.end, r: x.radius, pos: null }; events.push(f.rec); }
        fieldsLive.push(f);
      });
    }
  }
  function fieldApply(t, put, putW, webs, paints, dScan, dRange) {
    for (let i = fieldsLive.length - 1; i >= 0; i--) {
      const f = fieldsLive[i], x = f.x;
      if (t >= f.end) { fieldsLive.splice(i, 1); continue; }
      if (t + DT < f.at) continue;
      if (!f.pos) { f.pos = (f.v.alive ? f.v.pos : f.v.pos).slice(); if (f.rec) f.rec.pos = f.pos.slice(); }
      for (const w of units) {
        if (!ready(w) || w === f.u || !inField(f, w)) continue;
        (w.fieldsOn ||= new Set()).add(x.kind);
        if (x.kind === 'web') put(webs, w, x.web);
        else if (x.kind === 'paint') put(paints, w, x.paint);
        else if (x.kind === 'damp') { put(dScan, w, x.scan); put(dRange, w, x.lock); }
        else if (x.kind === 'track' || x.kind === 'guide') for (const k of ['opt', 'fall', 'track', 'mvel', 'flight', 'ev', 'er']) { if (x[k]) putW(w, k, x[k]); }
        else if (x.kind === 'bubble') w.pointed += 100;
        if (f.done) continue;
        if (x.kind === 'neut' && capOn) {
          // 中和量按目标信号半径 / doomsdayAOESignatureRadius 缩小（小于 1 时）
          const amt = Math.max(0, Math.min(w.cap, x.amt * (x.sig > 0 ? Math.min(1, w.t.sig * w.sigMult / x.sig) : 1)));
          w.cap -= amt;
          tally[f.u.side].drained += amt;
          onDrain?.({ f: f.u, v: w, m: x.m, amt, nos: false });
        } else if (x.kind === 'ecm') {
          if (rand() < x.str[w.t.sensorIdx] / Math.max(1, w.t.sensor)) {
            w.jam = Math.max(w.jam, f.end);
            (w.jamBy || (w.jamBy = new Map())).set(`${f.u.i}:${x.m}`, { u: f.u, m: x.m, t0: t, end: f.end, burst: true });
          }
        }
      }
      f.done = true;
    }
  }
  // ---------- 一步 ----------
  let shots = [];
  let dshots = [];   // 无人机实体开火（驾驶模拟）：无人机单位序号、目标、命中 0/1；只给原生引擎画炮塔开火用（客户端无人机也是炮塔开火）
  // 属性模板换了（玩家关 / 开装备、换弹；电脑船被扰频换成推进器关着的属性）：武器、注入器、维修、中和 / 吸电等的计时状态
  //   按装备序号 m 对回新模板的顺序（新模板少了或多了几门炮时，下标会错位，多出来的那门没有状态 → 引擎报错、对局中断）；新出现的装备从头开始
  const mkGun = (g) => ({ next: B.t, ammo: g.ammo, reloadUntil: 0, last: -1e9, spool: 0, on: null });
  const STATE_LISTS = [
    ['guns', (t) => t.guns, mkGun], ['inj', (t) => t.injectors || [], (x) => ({ next: 0, ammo: x.ammo, reloadUntil: 0 })],
    ['lrep', (t) => t.localReps || [], () => ({ next: B.t, ammo: 0, reloadUntil: 0, pend: 0 })], ['rrep', (t) => t.remote, () => ({ end: 0, tgt: null })],
    ['drain', (t) => [...t.neuts, ...t.noses], () => ({ next: 0 })], ['aoe', (t) => [...L(t, 'smarts'), ...L(t, 'bursts')], () => ({ next: B.t })], ['rcn', (t) => L(t, 'rcaps'), () => ({ next: 0 })],
  ];
  function syncState(u) {
    const t0 = u.st0;
    if (!t0 || t0 === u.t || u.isDrone) return;
    u.st0 = u.t;
    for (const [key, list, mk] of STATE_LISTS) {
      const st = u[key];
      if (!st) continue;
      const a = list(t0), b = list(u.t);
      if (a === b) continue;
      const by = new Map();
      a.forEach((x, k) => { if (st[k] && x.m != null) by.set(x.m, st[k]); });
      u[key] = b.map((x, k) => (x.m != null ? by.get(x.m) : st[k]) || (key === 'lrep' ? { ...mk(x), ammo: x.ammo } : mk(x)));
    }
  }
  B.step = () => {
    if (B.done) return;
    const t = B.t;
    for (const u of units) if (u.alive) syncState(u);
    shots = [];
    dshots = [];
    // 预设的舰队支援：到时间自动进场
    for (const s of support) if (!s.fired && s.at != null && t >= s.at) { s.fired = true; B.deploy(s.side, s); }
    cynoStep();
    const alive = units.filter((u) => ready(u) && !u.isDrone);
    for (const u of units) { u.act = 0; u.fire = 0; }
    // 电容：回充，再付非武器装备的耗电（武器开火、中和 / 吸电时单独扣）
    for (const u of alive) {
      tally[u.side].unitSec += DT;
      const c = u.t.cap;
      if (!capOn) { u.ratio = 1; u.cap = c.max; continue; }
      if (c.max && c.tau) { const x = Math.max(0.01, u.cap / c.max); u.cap = Math.min(c.max, u.cap + 10 * c.max / c.tau * (Math.sqrt(x) - x) * DT); }
      // 玩家驾驶的船：电容注入器逐次注入（开着才注、打空装填），耗电里不再算它的平均值
      const inj = u.pilot ? u.t.injectors || [] : [];
      inj.forEach((x, j) => {
        const st = u.inj[j];
        if (st.reloadUntil > t) { u.rld |= 1 << (x.m ?? 31); return; }
        if (!u.pilot.on.has(x.m)) return;
        if (empty(u, st, x)) { u.pilot.on.delete(x.m); return; }
        bit(u, x.m);
        if (t < st.next) return;
        st.next = nextCycle(st.next, t, x.cycle);
        fired(u, x.m);
        u.cap = Math.min(c.max, u.cap + x.bonus);
        if (--st.ammo <= 0) outOfAmmo(u, st, x, t);
      });
      // 玩家驾驶的船：不按整套装配的平均耗电扣，而是每件开着的装备在自己每个周期开头扣一次（和客户端一样）；
      // 电容不够 → 这件装备停下；不带失准的指向性装备（扰频 / 扰断等）目标超出最远距离 → 周期结束时停下
      if (u.pilot) { pilotCycles(u, t); u.ratio = 1; continue; }
      const use = c.other * DT;
      if (use <= 0) { u.ratio = 1; continue; }
      if (u.cap >= use) { u.cap -= use; u.ratio = 1; } else { u.ratio = Math.max(0, u.cap) / use; u.cap = 0; tally[u.side].capped += DT; }
    }
    // 一直开着的装备（抗性、推进器、损控等）：电容够就算运转
    for (const u of alive) if (u.ratio > 0.5) u.act |= u.t.alwaysOn || 0;
    cloakStep(alive, t);
    assignTargets('A');
    assignTargets('B');
    // 电子战（作用于自己的目标，按距离）
    const webs = new Map(), paints = new Map(), dScan = new Map(), dRange = new Map();
    // 武器扰断（负）/ 远程跟踪电脑、远程感应增强（正）：按属性分开收集，正负各自算叠加惩罚
    const wd = new Map(), bScan = new Map(), bRange = new Map();
    const putW = (v, k, x) => { let o = wd.get(v); if (!o) wd.set(v, (o = {})); (o[k] ||= []).push(x); };
    for (const u of alive) { u.pointed = 0; u.scram = false; }
    const put = (m, v, x) => (m.get(v) || m.set(v, []).get(v)).push(x);
    pilotLocks(alive);
    // 玩家开着的装备才运转
    const on = (u, x) => !u.pilot || u.pilot.on.has(x.m);
    // NPC 旧式实体效果（sim-npc.js 的 chance）：每个周期开头按几率决定这个周期生不生效
    const lucky = (u, x) => {
      if (x.chance == null) return true;
      const st = (u.ewc ||= new Map()).get(x) || { next: 0, on: false };
      if (t >= st.next) { st.next = t + (x.cycle || 5); st.on = rand() < x.chance; u.ewc.set(x, st); }
      return st.on;
    };
    for (const u of alive) {
      const v = u.target;
      if (!v?.alive || !engaged(u, v)) continue;
      const d = surf(u, v), k = u.ratio;
      // 跃迁扰断 / 扰频：一直开着（不受电子战开关影响，决定对方能不能跑）
      // 强度 ≥ 2 的是跃迁扰频器：同时让对方的微型跃迁推进器停机、开不起来
      // 聚焦脚本的跃迁扰断力场（focus）：单目标、强度视为无穷，只禁跃迁，不关微型跃迁推进器 / 微跳
      // noScram：NPC 的跃迁扰断（旧式 warpScrambleForEntity 强度 2 也只禁跃迁，不关微型跃迁推进器）
      for (const x of u.t.points) if (on(u, x) && d <= x.range && lucky(u, x)) { const ok = u.ratio > 0.5; v.pointed += x.str * (ok ? 1 : 0); if (ok && x.str >= 2 && !x.focus && !x.noScram) v.scram = true; bit(u, x.m); }
      if (opt.ewar) {
        for (const w of u.t.webs) { if (!on(u, w) || !lucky(u, w)) continue; const e = rangeEff(w, d); put(webs, v, w.v * k * e); bit(u, w.m, e > 0.01); }
        for (const p of u.t.paints) { if (!on(u, p) || !lucky(u, p)) continue; const e = rangeEff(p, d); put(paints, v, p.v * k * e); bit(u, p.m, e > 0.01); }
        for (const x of u.t.damps) { if (!on(u, x) || !lucky(u, x)) continue; const e = k * rangeEff(x, d); put(dScan, v, x.scan * e); put(dRange, v, x.lock * e); bit(u, x.m, e > 0.01); }
        for (const x of L(u.t, 'tds')) { if (!on(u, x) || !lucky(u, x)) continue; const e = k * rangeEff(x, d); putW(v, 'opt', x.opt * e); putW(v, 'fall', x.fall * e); putW(v, 'track', x.track * e); bit(u, x.m, e > 0.01); }
        for (const x of L(u.t, 'gds')) { if (!on(u, x)) continue; const e = k * rangeEff(x, d); putW(v, 'mvel', x.mvel * e); putW(v, 'flight', x.flight * e); putW(v, 'ev', x.ev * e); putW(v, 'er', x.er * e); bit(u, x.m, e > 0.01); }
        u.t.ecms.forEach((e, i) => {
          if (!on(u, e)) return;
          if (rangeEff(e, d) > 0.01) bit(u, e.m);
          if (t < u.ecmNext[i]) return;
          u.ecmNext[i] = t + e.cycle;
          fired(u, e.m);
          const chance = e.str[v.t.sensorIdx] * k * rangeEff(e, d) / Math.max(1, v.t.sensor);
          if (rand() < chance) {
            v.jam = Math.max(v.jam, t + e.jam);
            // 谁的哪件 ECM 干扰成功、从何时到何时（受到电子战提示条：成功才显示，带倒计时）
            (v.jamBy || (v.jamBy = new Map())).set(`${u.i}:${e.m}`, { u, m: e.m, t0: t, end: t + e.jam });
          }
        });
      }
      // 中和 / 吸电：周期开始时生效
      if (capOn) {
        const list = [...u.t.neuts.map((x) => [x, false]), ...u.t.noses.map((x) => [x, true])];
        list.forEach(([x, nos], j) => {
          const st = u.drain[j];
          if (!on(u, x)) return;
          const e = rangeEff(x, d);
          if (e <= 0.01) return;
          if (t >= st.next) {
            st.next = nextCycle(st.next, t, x.cycle);
            if (x.chance != null && rand() >= x.chance) return;
            fired(u, x.m);
            const amt = Math.max(0, Math.min(v.cap, x.amt * k * e));
            if (nos) {
              // 吸电：对方电容比例比自己高才吸得到；自己电容满了多出来的不算
              if (u.t.cap.max && v.cap / (v.t.cap.max || 1) > u.cap / u.t.cap.max) { const got = Math.min(amt, u.t.cap.max - u.cap); v.cap -= amt; u.cap = Math.min(u.t.cap.max, u.cap + amt); tally[u.side].drained += amt; onDrain?.({ f: u, v, m: x.m, amt: got, nos: true }); }
              else onDrain?.({ f: u, v, m: x.m, amt: 0, nos: true });
            } else { v.cap -= amt; tally[u.side].drained += amt; onDrain?.({ f: u, v, m: x.m, amt, nos: false }); }
          }
          bit(u, x.m);
        });
      }
    }
    areaStep(alive, t, on);
    dictorStep(alive, t);
    for (const w of units) w.fieldsOn = null;
    fieldStart(alive, t);
    fieldApply(t, put, putW, webs, paints, dScan, dRange);
    assistStep(alive, t, on, putW, put, bScan, bRange);
    mjdStep(alive, t);
    // 被扰频的电脑船：装的是微型跃迁推进器的换成推进器关着的属性（玩家的船由驾驶模拟自己关）
    for (const u of alive) {
      const off = u.r.row.unitOff;
      if (!off || u.pilot) continue;
      const want = u.scram ? off : u.r.row.unit;
      if (u.t !== want) { u.t = want; syncState(u); }
    }
    for (const u of alive) { u.velMult = 1; u.sigMult = 1; u.scanMult = 1; u.rangeMult = 1; u.optMult = u.fallMult = u.trackMult = u.mvelMult = u.flightMult = u.erMult = u.evMult = 1; }
    for (const [v, l] of webs) v.velMult = stack(l, true);
    for (const [v, l] of paints) v.sigMult = stack(l, false);
    for (const [v, l] of dScan) v.scanMult = stack(l, true);
    for (const [v, l] of dRange) v.rangeMult = stack(l, true);
    for (const [v, l] of bScan) v.scanMult *= stack(l, false);
    for (const [v, l] of bRange) v.rangeMult *= stack(l, false);
    // 同一属性的加成和减益各自排序算叠加惩罚（dogma 里正负分开），再相乘
    const both = (l) => stack(l.filter((x) => x < 0), true) * stack(l.filter((x) => x > 0), false);
    for (const [v, o] of wd) for (const [k, l] of Object.entries(o)) v[k + 'Mult'] = both(l);
    if (B.zones.length) zoneStep(alive, t, webs, paints, wd);
    chaseStep(alive, t);

    // 没有输出舰船的一方：剩下的船开始撤离
    for (const side of SIDES) {
      const mine = alive.filter((u) => u.side === side);
      if (mine.length && !mine.some((u) => (u.t.dps > 0 || u.pilot) && !u.escaping) && !units.some((u) => u.alive && u.warp && u.side === side) && !jumps.some((j) => j.side === side)) for (const u of mine) if (!u.escaping && !u.pilot && !u.t.stay) u.escaping = t || DT;
    }
    move();
    // 玩家跃迁：对准完成（速度 ≥ 75%、航向偏差 ≤ 5°）就起跳
    for (const u of alive) {
      const P = u.pilot;
      if (!P || P.cmd !== 'warp' || !P.wp || !u.alive || u.warp) continue;
      const pt = warpPoint(u, P.wp), V = u.t.vel * u.velMult, sp = len(u.vel);
      if (pt && !(u.cloak && !u.cloakWarp) && sp >= V * 0.75 && sp > 0 && dot(scale(u.vel, 1 / sp), norm(sub(pt, u.pos))) >= ALIGN_COS) warpStart(u);
    }
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
        if (t < st.next || st.reloadUntil > t || !on(u, g)) return;
        if (empty(u, st, g)) { u.pilot.on.delete(g.m); return; }
        // 目标远在射程外：不开火（等距离合适）
        if (d > g.reach * (g.turret && !g.vorton ? 1.6 : 1)) { st.next = t; T.outRange += DT / u.t.guns.length; return; }
        if (capOn && g.capNeed > 0) {
          if (u.cap < g.capNeed) {
            // 玩家：电容不够开这一炮 → 这门炮停下（客户端「电容器只有 … 单位」）
            if (u.pilot) { u.pilot.on.delete(g.m); (u.pilot.msgs ||= []).push({ k: 'cap', i: g.m, need: g.capNeed, got: u.cap }); }
            st.next = t + DT; T.capped += DT / u.t.guns.length; return;
          }
          u.cap -= g.capNeed;
        }
        // 玩家超载的武器：射速、伤害加成
        const ov = u.pilot?.ovl?.has(g.m);
        st.next = nextCycle(st.next, t, g.cycle * (ov ? 1 + (g.ovR || 0) : 1));
        st.last = t;
        fired(u, g.m);
        // 热能分解器：连续打同一目标逐轮加成
        let spool = 1;
        if (g.spool) {
          if (st.on !== v) { st.on = v; st.spool = 0; }
          spool = 1 + Math.min(g.spool.max, g.spool.per * st.spool);
          st.spool += 1;
        }
        const ovF = ov ? 1 + (g.ovD || 0) : 1;
        const vol = g.volley * spool * ovF;
        T.potential += vol;
        if (g.vorton) {
          // 电涌投射器：按爆炸半径 / 速度算，再跳到主目标附近的敌船
          const hitOne = (x) => { const f = missileApply(x.t.sig * x.sigMult, speedOf(x), g.er, g.ev, g.drf); T.applied += vol * f; const raw = g.dmg.map((y) => y * f * ovF); onHit?.({ f: u, v: x, type: g.type, mult: 1, dmg: hit(u, x, raw), raw, missile: true }); shots.push(u.i, x.i, 1, k); };
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
          // 末日武器：预热之后才出伤，再按伤害周期分几跳打完（一发的总伤害不变）
          T.applied += vol;
          const dm = { u, v, g, k, next: t + (g.warn || 0), left: g.ticks || 1 };
          // 画面用：预热开始时间、开始出伤、结束（中途作废时改成作废时刻）
          if (rec) { dm.rec = { f: u.i, to: v.i, k, t0: t, fire: t + (g.warn || 0), end: t + (g.warn || 0) + ((g.ticks || 1) - 1) * (g.tick || 0) + 1 }; rec.dooms.push(dm.rec); }
          dooms.push(dm);
        } else if (g.turret) {
          const mult = turretRoll(g, u, v, d);
          const raw = g.dmg.map((y) => y * (mult || 1) * spool * ovF);
          const got = mult ? (T.applied += vol * mult, hit(u, v, raw)) : 0;
          onHit?.({ f: u, v, type: g.type, mult, dmg: got, raw });
          shots.push(u.i, v.i, mult ? 1 : 0, k);
        } else if (d <= g.reach * u.mvelMult * u.flightMult) {
          // 制导扰断：发射时按开火方当时的导弹速度 / 飞行时间 / 爆炸半径 / 爆炸速度倍数
          const m = { u, v, pos: u.pos.slice(), life: g.flight * u.flightMult, g, t0: t, ovF, mv: u.mvelMult, er: u.erMult, ev: u.evMult };
          missiles.push(m);
          if (rec) { m.rec = { f: u.i, to: v.i, t0: t, t1: null, hit: false, k, v: g.mvel * (m.mv || 1) }; rec.missiles.push(m.rec); }
        }
        if (g.ammo < Infinity && --st.ammo <= 0) outOfAmmo(u, st, g, t);
      });
    }
    // 武器运转：一个周期内开过火、没在装填
    for (const u of alive) u.guns.forEach((st, k) => bit(u, u.t.guns[k].m, t - st.last < u.t.guns[k].cycle + DT && st.reloadUntil <= t));
    for (const u of alive) { if (!u.alive) continue; if (u.drones.length) droneStep(u, t); if (u.squads.length) fighterStep(u, t); }
    if (opt.droneUnits) for (const u of units) if (!u.alive && !u.isDrone) for (const d of u.drones) if (d.e) droneHide(d);
    // 末日武器：到点打一跳；开火方或目标没了就作废
    for (let i = dooms.length - 1; i >= 0; i--) {
      const d = dooms[i];
      if (!d.u.alive || !d.v.alive) { if (d.rec) d.rec.end = Math.min(d.rec.end, t); dooms.splice(i, 1); continue; }
      if (t < d.next) continue;
      const raw = d.g.dmg.map((x) => x / (d.g.ticks || 1));
      onHit?.({ f: d.u, v: d.v, type: d.g.type, mult: 1, dmg: hit(d.u, d.v, raw), raw, missile: true });
      shots.push(d.u.i, d.v.i, 1, d.k);
      d.next += d.g.tick || 0;
      if (--d.left <= 0) dooms.splice(i, 1);
    }
    // 导弹飞行
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i], v = m.v, g = m.g;
      const off = sub(v.pos, m.pos), dd = len(off) - v.t.radius, stepLen = g.mvel * (m.mv || 1) * DT;
      let done = false;
      if (!v.alive) done = true;
      else if (dd <= stepLen) {
        const f = missileApply(v.t.sig * v.sigMult, speedOf(v), g.er * (m.er || 1), g.ev * (m.ev || 1), g.drf);
        tally[m.u.side].applied += g.volley * f;
        const raw = g.dmg.map((x) => x * f * (m.ovF || 1));
        onHit?.({ f: m.u, v, type: g.type, mult: 1, dmg: hit(m.u, v, raw), raw, missile: true });
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
          if (u.pilot && !u.pilot.on.has(x.m)) { if (st.pend) { u.hp[x.layer] = Math.min(u.t.max[x.layer], u.hp[x.layer] + st.pend); st.pend = 0; } return; }
          if (empty(u, st, x)) { u.pilot.on.delete(x.m); return; }
          bit(u, x.m);
          if (t < st.next) return;
          if (st.pend) { u.hp[x.layer] = Math.min(u.t.max[x.layer], u.hp[x.layer] + st.pend); st.pend = 0; }
          const sb = x.layer === 0 ? (u.sbAmt ?? 1) : 1, sd = x.layer === 0 ? (u.sbDur ?? 1) : 1;   // 纤维云：护盾回充增量器回充量 / 持续时间
          const ov = u.pilot?.ovl?.has(x.m), amt = x.amt * sb * (ov ? 1 + (x.ovA || 0) : 1);
          st.next = nextCycle(st.next, t, x.cycle * sd * (ov ? 1 + (x.ovC || 0) : 1));
          if (x.skip && rand() < x.skip) return;   // NPC 旧式维修：这个周期延迟了，不修
          fired(u, x.m);
          if (x.layer === 0) u.hp[0] = Math.min(u.t.max[0], u.hp[0] + amt);
          else st.pend = amt;
          if (x.ammo < Infinity && --st.ammo <= 0) outOfAmmo(u, st, x, t);
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
        // 玩家驾驶：和客户端一样手动——锁定队友、选中（当前目标）、开遥修；每个周期开始时修当前目标
        if (u.pilot) {
          const P = u.pilot, a = P.active;
          u.t.remote.forEach((rep, j) => {
            const st = u.rrep[j];
            if (st.tgt) { bit(u, rep.m); return; }
            if (!P.on.has(rep.m) || !a?.alive || a === u || a.side !== u.side || P.locks.get(a) !== 0) return;
            if (rangeEff(rep, surf(u, a)) < 0.05) return;
            st.tgt = a;
            st.end = t + rep.cycle;
            pend.set(a, (pend.get(a) || 0) + rep.amt);
            u.repTarget = a;
            fired(u, rep.m);
            bit(u, rep.m);
          });
          if (u.repTarget && !u.rrep.some((st) => st.tgt === u.repTarget)) u.repTarget = u.rrep.find((st) => st.tgt)?.tgt || null;
          continue;
        }
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
          if (u.ratio < 0.5 || (u.pilot && !u.pilot.on.has(rep.m))) return;
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
    const left = { A: units.some((u) => u.alive && u.side === 'A' && !u.isDrone), B: units.some((u) => u.alive && u.side === 'B' && !u.isDrone) };
    // B.hold（驾驶模拟的练习）：一方打光了也不结束，由练习自己判定结束
    if (((!left.A || !left.B) && !pending && !B.hold) || B.t >= opt.max) B.done = true;
    record();
  };

  // ---------- 记录 ----------
  const hpSum = (list) => list.reduce((s, u) => s + u.hp[0] + u.hp[1] + u.hp[2], 0);
  const maxSum = (list) => list.reduce((s, u) => s + u.t.max[0] + u.t.max[1] + u.t.max[2], 0) || 1;
  // 每个时间点：存活（含已撤离）舰船数、场上血量比例
  function point() {
    const a = units.filter((u) => u.side === 'A' && !u.isDrone), b = units.filter((u) => u.side === 'B' && !u.isDrone);
    const la = a.filter((u) => u.alive), lb = b.filter((u) => u.alive);
    return { t: Math.round(B.t), A: la.length + a.filter((u) => u.escaped).length, B: lb.length + b.filter((u) => u.escaped).length, hpA: hpSum(la) / maxSum(a), hpB: hpSum(lb) / maxSum(b) };
  }
  const DRONE_CLS = (g) => (g.sentry ? 3 : g.size);
  function record() {
    if (Number.isInteger(B.t) || B.done) timeline.push(point());
    if (!rec) return;
    const n = units.length;
    // 位置用双精度：跃迁动辄几个 AU，单精度只剩十几公里的精度；wp：0 正常 / 1 对准跃迁中 / 2 跃迁中
    const pos = new Float64Array(n * 3), hp = new Uint8Array(n * 3), tg = new Int32Array(n).fill(-1), wp = new Uint8Array(n);
    const spd = new Float32Array(n), cp = new Uint8Array(n), act = new Uint32Array(n), rld = new Uint32Array(n), fire = new Uint32Array(n), lk = new Uint8Array(n);
    const dr = [], rr = [], hd = new Float32Array(n * 3);
    units.forEach((u, i) => {
      pos[i * 3] = u.pos[0]; pos[i * 3 + 1] = u.pos[1]; pos[i * 3 + 2] = u.pos[2];
      if (u.hv) { const l = len(u.hv) || 1; hd[i * 3] = u.hv[0] / l; hd[i * 3 + 1] = u.hv[1] / l; hd[i * 3 + 2] = u.hv[2] / l; }
      if (!u.alive) return;
      u.rrep?.forEach((st, j) => { if (st.tgt?.alive) rr.push(i, st.tgt.i, u.t.remote[j].m); });
      for (const [x, m] of u.aOut || []) if (x.alive) rr.push(i, x.i, m);
      for (let l = 0; l < 3; l++) hp[i * 3 + l] = u.t.max[l] ? Math.round(u.hp[l] / u.t.max[l] * 200) : 0;
      hp[i * 3 + 2] = Math.max(1, hp[i * 3 + 2]);
      spd[i] = u.warp?.go ? len(u.vel) : Math.round(speedOf(u));
      wp[i] = u.warp?.go ? 2 : u.pilot?.cmd === 'warp' ? 1 : 0;
      cp[i] = u.t.cap.max ? Math.round(Math.max(0, u.cap) / u.t.cap.max * 200) : 0;
      act[i] = u.act >>> 0;
      rld[i] = u.rld >>> 0;
      fire[i] = u.fire >>> 0;
      // 锁定：0 没有目标，1–199 锁定进度，255 已锁定
      if (u.target?.alive) lk[i] = u.lock > 0 ? Math.max(1, Math.min(199, Math.round((1 - u.lock / (u.lockAll || 1)) * 200))) : 255;
      if (u.target?.alive) tg[i] = u.target.i;
      else if (u.repTarget?.alive) tg[i] = u.repTarget.i;
      // 每架 6 个数：母舰、x、y、z、总览类别、类型 ID（画模型用）
      for (const d of u.drones) if (d.pos && !d.e && (d.target || !d.g.sentry)) dr.push(i, d.pos[0], d.pos[1], d.pos[2], DRONE_CLS(d.g), d.g.type || 0);
      for (const q of u.squads) if (q.pos) dr.push(i, q.pos[0], q.pos[1], q.pos[2], 4 + q.f.cls, q.f.type || 0);
      u.rld = 0;
    });
    rec.frames.push({ t: B.t, pos, hd, hp, tg, shots, spd, cp, act, rld, fire, lk, wp, dr: Float64Array.from(dr), rr: Int32Array.from(rr), ds: Int32Array.from(dshots), pa: primary.A ? primary.A.i : -1, pb: primary.B ? primary.B.i : -1 });
  }
  timeline.push(point());
  if (rec) {
    const n = units.length, pos = new Float64Array(n * 3), hp = new Uint8Array(n * 3), cp = new Uint8Array(n).fill(200);
    units.forEach((u, i) => { pos.set(u.pos, i * 3); for (let l = 0; l < 3; l++) hp[i * 3 + l] = u.t.max[l] ? 200 : 0; hp[i * 3 + 2] = 200; });
    rec.frames.push({ t: 0, pos, hp, tg: new Int32Array(n).fill(-1), shots: [], spd: new Float32Array(n), wp: new Uint8Array(n), cp, act: new Uint32Array(n), rld: new Uint32Array(n), fire: new Uint32Array(n), lk: new Uint8Array(n), dr: new Float32Array(0), rr: new Int32Array(0), pa: -1, pb: -1 });
  }

  // ---------- 结果 ----------
  // 胜负看战损：击毁对方的价值占双方损失的比例；≥ 75% 为大胜，≥ 55% 为占优
  B.result = () => {
    const last = timeline[timeline.length - 1];
    const ships = units.filter((u) => !u.isDrone);
    const start = { A: ships.filter((u) => u.side === 'A').length, B: ships.filter((u) => u.side === 'B').length };
    const isk = Boolean(opt.value) && rows.every((r) => opt.value(r.row) > 0);
    const worth = (u) => (isk ? opt.value(u.r.row) : u.t.ehp);
    const lossOf = (s) => ships.reduce((t, u) => t + (u.side === s && !u.alive && !u.escaped ? worth(u) : 0), 0);
    const loss = { A: lossOf('A'), B: lossOf('B') };
    const total = loss.A + loss.B;
    const eff = total ? { A: loss.B / total, B: loss.A / total } : null;
    const lead = eff ? (eff.A >= 0.55 ? 'A' : eff.B >= 0.55 ? 'B' : null) : null;
    const winner = eff ? (eff.A >= 0.75 ? 'A' : eff.B >= 0.75 ? 'B' : null) : null;
    const escaped = { A: ships.filter((u) => u.side === 'A' && u.escaped).length, B: ships.filter((u) => u.side === 'B' && u.escaped).length };
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
