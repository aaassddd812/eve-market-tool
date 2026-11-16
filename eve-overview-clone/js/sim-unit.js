// ===== 装配 → 战斗单位（舰队对战模拟 fit-sim.js、驾驶模拟、匹配服务器 server/match_service.mjs 共用）=====
// 不碰页面：用 bindUnit(ctx, opt) 绑定装配数据（ctx.data、ctx.FE）和选项对象（prop、offKeys、chargeOv、cloakOk），之后同步调用。
// buildUnit(fit, { skills, heat, bursts }) = 按当前选项算装配，返回 { calc, stats, unit }。
let ctx, O = {};
export function bindUnit(c, opt) { ctx = c; O = opt; }
// 装配里的主动装备按装配里的状态计算（击杀记录装配都是开启）；
// 有重新激活延迟的装备（突击型损伤控制等，开几秒要冷却一分钟以上）不能一直开着，按在线不开启计算
const REACTIVATION_DELAY = 669;
// 返回不计开启的原因（null = 按装配里的状态）
function forcedOff(m, key) {
  const { FE, data } = ctx;
  if (!m || (FE.STATE_RANK[m.state] || 0) < 2) return null;
  // 驾驶模拟：玩家没开的装备（槽位:序号）
  if (key && O.offKeys?.has(key)) return '未开启';
  const t = data.types.get(m.type);
  // 驾驶模拟里自己的船：隐形装置由玩家开（重启延迟在引擎里算）
  if ((t?.attrs.get(REACTIVATION_DELAY) || 0) > 0 && !(O.cloakOk && effName(t).some((n) => CLOAK_EFFECTS.includes(n)))) return '长冷却，不计开启';
  // 推进器（微型跃迁推进器 / 加力燃烧器）：按选项开或关
  if (!O.prop && t?.attrs.has(FE.AT.speedBoostFactor) && t.attrs.has(FE.AT.massAddition)) return '推进器未开启';
  return null;
}

// ---------- 单艘船的战斗属性 ----------
const effName = (t) => t.effects.map((e) => ctx.data.effects.get(e)?.name);
// 开着时船身播放的叠加特效（客户端按效果 guid 选特效文件：effects.ShieldBoosting → shieldboosting_skinned 等）
const HULL_FX = { shieldBoosting: 'sb', fueledShieldBoosting: 'sb', armorRepair: 'ar', fueledArmorRepair: 'ar', structureRepair: 'hr',
  modifyActiveShieldResonancePostPercent: 'sh', modifyActiveArmorResonancePostPercent: 'ah', adaptiveArmorHardener: 'ah', shipModuleNonRepeatingArmorHardener: 'ah',
  emergencyHullEnergizer: 'hi', cloaking: 'ck', cloakingWarpSafe: 'ck', cloakingPrototype: 'ck' };
const CLOAK_EFFECTS = ['cloaking', 'cloakingWarpSafe', 'cloakingPrototype'];
// 脉冲波投射器的效果名 → 种类
const DICTOR_LAUNCHER = 589;   // 拦截泡发射器组
const AOE_FIELD = { doomsdayAOEWeb: 'web', doomsdayAOENeut: 'neut', doomsdayAOEPaint: 'paint', doomsdayAOETrack: 'track', doomsdayAOEGuide: 'guide', doomsdayAOEDamp: 'damp', doomsdayAOEBubble: 'bubble', doomsdayAOEECM: 'ecm' };
const hullFx = (t) => { for (const n of effName(t)) if (HULL_FX[n]) return HULL_FX[n]; return ''; };
// 隐形特效变体（effects.json：effects.CloakingCovertOps → graphicID 21015 cloaking_pentagon，effects.CloakingPrototype → 21030 cloaking_triangle，
//   普通隐形装置 effects.Cloaking 本身不带画面，画面是 effects.Cloak → 21040 cloaking）
const CLOAK_GFX = { cloakingWarpSafe: 'p', cloakingPrototype: 't' };
const cloakGfx = (t) => { for (const n of effName(t)) if (CLOAK_GFX[n]) return CLOAK_GFX[n]; return ''; };
const SENSOR_TYPES = ['雷达', '光雷达', '磁力', '引力'];
const ECM_STR = [241, 239, 240, 238];   // ECM 对雷达 / 光雷达 / 磁力 / 引力的干扰强度（与 FE.AT.sensors 顺序一致）
// 武器开火特效（3D 视图用）：种类按装备组 / 名字，颜色按弹药（激光按晶体波段，导弹爆炸按主伤害类型），大小按弹药尺寸 / 导弹爆炸半径
const LASER_COLOR = [[/radio/i, 0xff3322], [/microwave/i, 0xff6622], [/infrared/i, 0xff9933], [/standard/i, 0xffdd44], [/ultraviolet/i, 0xb070ff],
  [/xray|x-ray/i, 0x77aaff], [/gamma/i, 0x5577ff], [/multifrequency/i, 0xfff2ff], [/conflagration/i, 0xff5522], [/scorch/i, 0xffcc33],
  [/aurora/i, 0xff5577], [/gleam/i, 0xffeedd]];
const DMG_COLOR = [0x88b8ff, 0xff7a3a, 0xdfe4ec, 0xffcf4a];   // EM、热能、动能、爆炸
function gunFx(m, c, raw, turret) {
  const name = m.type.en || '', ammo = c.type.en || '';
  const size = Math.max(1, Math.min(4, m.attr(128) || c.attr(128) || 1));
  const main = raw.indexOf(Math.max(...raw));
  if (!turret) return { w: 'missile', c: DMG_COLOR[main] ?? 0xffcf4a, er: c.attr(654) || 50, v: c.attr(ctx.FE.AT.maxVelocity) || 3000 };
  const g = m.type.group;
  if (g === 53) return { w: /beam|tachyon/i.test(name) ? 'beam' : 'pulse', c: (LASER_COLOR.find(([re]) => re.test(ammo)) || [0, 0xffaa44])[1], s: size };
  if (g === 74) return { w: /rail/i.test(name) ? 'rail' : 'blaster', c: /rail/i.test(name) ? 0x88c4ff : 0x9fe8ff, s: size };
  if (g === 55) return { w: /artillery|howitzer/i.test(name) ? 'arty' : 'auto', c: 0xffb04a, s: size };
  if (g === 4060) return { w: 'vorton', c: 0xa8d8ff, s: size };
  return { w: 'disint', c: 0xff5a3a, s: size };
}
// 舰载机：普通攻击按爆炸半径 / 速度与最佳射程 + 失准范围，导弹技能按爆炸半径 / 速度与射程；衰减系数 = ln 衰减因子 / ln 衰减灵敏度
const drfOf = (a, b) => (a > 0 && b > 0 && Math.log(b) ? Math.log(a) / Math.log(b) : 1);
function fighterOf(f) {
  const { FE } = ctx;
  const ability = (dmgAttrs, multAttr, durAttr) => {
    const cycle = f.attr(durAttr) / 1000;
    const mult = f.attr(multAttr) || 1;
    const dmg = dmgAttrs.map((a) => f.attr(a) * mult);
    return cycle && dmg.some(Boolean) ? { dmg, cycle } : null;
  };
  const atk = ability(FE.AT.fighterAttackDmg, FE.AT.fighterAttackMult, FE.AT.fighterAttackDuration);
  const msl = ability(FE.AT.fighterMissileDmg, FE.AT.fighterMissileMult, FE.AT.fighterMissileDuration);
  if (atk) Object.assign(atk, { er: f.attr(2234), ev: f.attr(2235), drf: drfOf(f.attr(2231), f.attr(2232)), opt: f.attr(2236) || 5000, fall: f.attr(2237) || 0 });
  if (msl) Object.assign(msl, { er: f.attr(2125), ev: f.attr(2126), drf: drfOf(f.attr(2127), f.attr(2128)), range: f.attr(2149) || 30000 });
  if (!atk && !msl) return null;
  return { type: f.type.id, squads: f.active, size: f.attr(FE.AT.fighterSquadronSize) || 1, vel: f.attr(FE.AT.maxVelocity) || 2000, orbit: f.attr(2223) || 3000,
    cls: f.attr(FE.AT.fighterIsHeavy) ? 2 : f.attr(FE.AT.fighterIsSupport) ? 1 : 0, atk, msl };
}
const BURST_ATTRS = [[2468, 2469], [2470, 2471], [2472, 2473], [2536, 2537]];   // 同 fit-engine BUFF_ATTRS
const SLOT_ORDER = ['high', 'mid', 'low'];
function unitTemplate(row) {
  const { FE } = ctx;
  const { calc, stats } = row;
  const ship = calc.ship;
  const d = stats.defense;
  const res = ['shield', 'armor', 'hull'].map((k) => FE.RESIST[k].map((a) => ship.attr(a)));
  const remote = [], webs = [], paints = [], neuts = [], noses = [], damps = [], ecms = [], points = [], localReps = [], injectors = [];
  // 其余主动装备：立体炸弹 smarts、ECM 脉冲 bursts、跟踪 / 制导扰断 tds / gds、远程电容传输 rcaps、远程感应增强 rsbs、远程跟踪 rtcs、微型跃迁引擎 mjds、跃迁扰断力场 bubbles
  const smarts = [], bursts = [], tds = [], gds = [], rcaps = [], rsbs = [], rtcs = [], mjds = [], bubbles = [], cloaks = [], fields = [], dictors = [];
  // 装备栏（状态面板用）：高、中、低槽；m 为在装备栏里的序号，引擎按序号记录每件装备是否在运转
  const rack = [];
  const idx = new Map();
  for (const s of SLOT_ORDER) for (const m of calc.modules.filter((x) => x.slot === s).sort((a, b) => a.index - b.index)) {
    idx.set(m, rack.length);
    rack.push({ type: m.type.id, key: `${s}:${m.index}`, hfx: hullFx(m.type), ...(hullFx(m.type) === 'ck' ? { ckv: cloakGfx(m.type) } : {}), slot: s, state: m.state, charge: m.charge?.type.id || 0, off: forcedOff(row.fit.slots[s]?.[m.index]) || '', cycle: (m.attr(FE.AT.duration) || m.attr(FE.AT.speed)) / 1000 || 0, reload: (m.attr(1795) || 0) / 1000,
      // disallowRepeatingActivation（1014）：客户端不让这类装备自动循环（拦截泡发射器、微跳、扫描器、炸弹发射器等），开一次只跑一轮
      norep: m.attr(1014) === 1 ? 1 : 0,
      // 每个周期开头扣的电容（capacitorNeed）、最远作用距离（maxRange）、失准范围（falloffEffectiveness）—— 玩家开装备时检查用
      cap: Math.max(0, m.attr(FE.AT.capNeed) || 0), rng: m.attr(FE.AT.maxRange) || 0, fall: m.attr(2044) || 0, heat: { abs: m.attr(1180) || 0, dmg: m.attr(1211) || 0, hp: m.attr(9) || 40, spd: (m.attr(1223) || 0) / 100 },
      // 指挥脉冲波：给的加成（warfareBuffNID / Value）、加成持续时间（buffDuration）、弹药组（决定 buff 栏哪一格）
      ...(m.type.group === FE.BURST_GROUP && m.charge ? { burst: { buffs: BURST_ATTRS.map(([a, b]) => [Math.round(m.attr(a)), m.attr(b)]).filter(([id, v]) => id && v), dur: (m.attr(2535) || 0) / 1000, grp: m.charge.type.group } } : {}) });
  }
  const used = new Set();
  // 弹药数：装备容量 / 弹药体积
  const loads = (m) => (m.charge && m.charge.attr(FE.AT.volume) > 0 ? Math.floor(m.attr(FE.AT.capacity) / m.charge.attr(FE.AT.volume)) : 0);
  for (const m of calc.modules) {
    const names = effName(m.type);
    // 微型跃迁引擎（重启延迟 180 秒，平时按「长冷却，不计开启」关着）：驾驶模拟里玩家自己开；预热 = 周期时间，跳 mjdJumpRange（2066）
    if ((names.includes('microJumpDrive') || names.includes('microJumpPortalDrive') || names.includes('microJumpPortalDriveCapital')) && m.state !== 'offline') {
      mjds.push({ spool: (m.attr(FE.AT.duration) || 12000) / 1000, range: m.attr(2066) || 100000, delay: (m.attr(REACTIVATION_DELAY) || 0) / 1000, m: idx.get(m) }); used.add(m);
      if (rack[idx.get(m)]) rack[idx.get(m)].off = '';
      continue;
    }
    // 隐形装置：解除后 cloakingTargetingDelay（560）内不能锁定，重启延迟 moduleReactivationDelay（669）；
    // 不标为已用 → 留在 alwaysOn 里，开关由玩家决定（降速等属性走 variant）
    if (names.some((n) => CLOAK_EFFECTS.includes(n)) && m.state !== 'offline') {
      cloaks.push({ m: idx.get(m), delay: (m.attr(560) || 0) / 1000, cool: (m.attr(REACTIVATION_DELAY) || 0) / 1000, warp: names.includes('cloakingWarpSafe') });   // 隐秘行动隐形装置可以带隐形跃迁
      continue;
    }
    if ((FE.STATE_RANK[m.state] || 0) < 2) continue;
    const dur = m.attr(FE.AT.duration) / 1000 || m.attr(FE.AT.speed) / 1000;
    const range = m.attr(FE.AT.maxRange), falloff = m.attr(2044) || 0;
    const k = idx.get(m);
    const mark = () => used.add(m);
    // 拦截泡发射器（拦截舰，launcherGroup 589）：每次发射一枚跃迁干扰探针，在发射时自己的位置展开一个泡，
    // 半径 = 探针的 warpScrambleRange（103），存在 explosionDelay（281）；泡里的船（包括自己）都跃迁不了。弹药数 = 容量 / 探针体积，打完装填 reloadTime
    if (m.type.group === DICTOR_LAUNCHER) {
      if (m.charge) dictors.push({ m: k, range: m.charge.attr(103) || 20000, life: (m.charge.attr(281) || 120000) / 1000, cycle: dur || 5, ammo: loads(m) || 1, reload: (m.attr(1795) || 60000) / 1000 });
      mark();
      continue;
    }
    // 跃迁扰断 / 扰频（拦截泡不算）：强度累加，超过对方跃迁稳定就走不掉
    if (m.attr(105) > 0 && range > 0 && !names.includes('warpDisruptSphere')) { points.push({ str: m.attr(105), range, cycle: dur, m: k }); mark(); }
    // 跃迁扰断力场装了聚焦脚本：不再是泡泡，变成要锁定的单目标扰断（射程按脚本改过的 maxRange，脚本自带 24 km），强度视为无穷、不关微型跃迁推进器
    if (names.includes('warpDisruptSphere') && m.charge) { points.push({ str: 1e6, focus: true, range: range || m.charge.attr(1317) || 24000, cycle: dur, m: k }); mark(); continue; }
    // 本地维修（逐周期）：辅助护盾 / 装甲维修有弹药时不耗电，打完要装填
    const ancillary = names.includes('fueledShieldBoosting') || names.includes('fueledArmorRepair');
    const fuel = ancillary && m.charge ? loads(m) : 0;
    const localRep = (layer, amt) => { localReps.push({ layer, amt, cycle: dur || 5, m: k, ammo: fuel > 0 ? fuel : Infinity, reload: (m.attr(1795) || 60000) / 1000, charged: fuel > 0, ovA: ((layer === 0 ? m.attr(1231) : m.attr(1230)) || 0) / 100, ovC: (m.attr(1206) || 0) / 100 }); mark(); };
    // 电容注入器：每个周期开始时注入弹药的电量；弹舱打空装填 10 秒（驾驶模拟逐次算，其它按平均耗电）
    if (names.includes('powerBooster')) {
      const bonus = m.charge ? m.charge.attr(FE.AT.capacitorBonus) : 0;
      if (bonus > 0) injectors.push({ bonus, cycle: dur || 12, m: k, ammo: loads(m) || 1, reload: 10 });
      mark();
      continue;
    }
    if (names.includes('shieldBoosting') || names.includes('fueledShieldBoosting')) localRep(0, m.attr(FE.AT.shieldBonus));
    else if (names.includes('armorRepair')) localRep(1, m.attr(FE.AT.armorDamageAmount));
    else if (names.includes('fueledArmorRepair')) localRep(1, m.attr(FE.AT.armorDamageAmount) * (m.charge ? m.attr(FE.AT.chargedArmorDamageMultiplier) || 1 : 1));
    else if (names.includes('structureRepair')) localRep(2, m.attr(FE.AT.structureDamageAmount));
    else if (names.includes('shipModuleRemoteShieldBooster') || names.includes('shipModuleAncillaryRemoteShieldBooster')) { remote.push({ layer: 0, amt: m.attr(FE.AT.shieldBonus), cycle: dur || 5, rate: m.attr(FE.AT.shieldBonus) / (dur || 5), range, falloff, m: k }); mark(); }
    else if (names.includes('shipModuleRemoteArmorRepairer') || names.includes('shipModuleAncillaryRemoteArmorRepairer') || names.includes('ShipModuleRemoteArmorMutadaptiveRepairer')) {
      const mult = names.includes('shipModuleAncillaryRemoteArmorRepairer') && m.charge ? m.attr(FE.AT.chargedArmorDamageMultiplier) || 1 : 1;
      const amt = m.attr(FE.AT.armorDamageAmount) * mult;
      remote.push({ layer: 1, amt, cycle: dur || 5, rate: amt / (dur || 5), range, falloff, m: k }); mark();
    } else if (names.includes('shipModuleRemoteHullRepairer')) { remote.push({ layer: 2, amt: m.attr(FE.AT.structureDamageAmount), cycle: dur || 5, rate: m.attr(FE.AT.structureDamageAmount) / (dur || 5), range, falloff, m: k }); mark(); }
    else if (names.includes('remoteWebifierFalloff')) { webs.push({ v: m.attr(FE.AT.speedFactor) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    else if (names.includes('remoteTargetPaintFalloff')) { paints.push({ v: m.attr(FE.AT.signatureRadiusBonus) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    else if (!dur) continue;
    else if (names.includes('energyNeutralizerFalloff')) { neuts.push({ amt: m.attr(97), cycle: dur, rate: m.attr(97) / dur, range, falloff, m: k }); mark(); }
    else if (names.includes('energyNosferatuFalloff')) { noses.push({ amt: m.attr(90), cycle: dur, rate: m.attr(90) / dur, range, falloff, m: k }); mark(); }
    else if (names.includes('remoteSensorDampFalloff')) { damps.push({ scan: m.attr(566) / 100, lock: m.attr(309) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    else if (names.includes('remoteECMFalloff')) { ecms.push({ str: ECM_STR.map((a) => m.attr(a)), cycle: Math.max(1, Math.round(dur)), jam: Math.max(1, Math.round(m.attr(2822) / 1000 || dur)), range, falloff, m: k }); mark(); }
    // 立体炸弹（empWave）：每个周期开头对 empFieldRange（99）内所有船造成伤害（伤害属性在装备上）
    else if (names.includes('empWave')) { smarts.push({ dmg: FE.DAMAGE.map((a) => m.attr(a) || 0), range: m.attr(99) || 0, cycle: dur, type: m.type.id, m: k }); mark(); }
    // ECM 脉冲（ECMBurstJammer）：每个周期开头对 ecmBurstRange（142）内所有船按强度掷骰
    else if (names.includes('ECMBurstJammer')) { bursts.push({ str: ECM_STR.map((a) => m.attr(a)), range: m.attr(142) || 0, cycle: dur, jam: Math.max(1, Math.round(m.attr(2822) / 1000 || dur)), m: k }); mark(); }
    // 武器扰断：跟踪扰断（最佳射程 351 / 失准 349 / 跟踪 767）、制导扰断（导弹速度 547 / 飞行时间 596 / 爆炸速度 847 / 爆炸半径 848），百分比，脚本已算进装备属性
    else if (names.includes('shipModuleTrackingDisruptor')) { tds.push({ opt: m.attr(351) / 100, fall: m.attr(349) / 100, track: m.attr(767) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    else if (names.some((n) => AOE_FIELD[n])) {
      // 超级航母脉冲波投射器（doomsdayAOE*）：对锁定的目标开，预热 doomsdayWarningDuration 后在目标位置生成半径 doomsdayAOERange 的力场，
      // 持续 doomsdayAOEDuration（中和没有持续时间：一次性）；周期 = 效果的持续时间属性（73 或 2397～2400），一次开一轮
      const kind = AOE_FIELD[names.find((n) => AOE_FIELD[n])];
      const cyc = Math.max(m.attr(FE.AT.duration) || 0, ...[2397, 2398, 2399, 2400].map((a) => m.attr(a) || 0)) / 1000;
      fields.push({ kind, warn: (m.attr(2262) || 0) / 1000, radius: m.attr(2279) || 0, life: (m.attr(2280) || 0) / 1000, reach: m.attr(FE.AT.maxRange) || 0, cycle: cyc, sig: m.attr(2281) || 0,
        web: m.attr(FE.AT.speedFactor) / 100, paint: m.attr(FE.AT.signatureRadiusBonus) / 100, scan: m.attr(566) / 100, lock: m.attr(309) / 100,
        opt: m.attr(351) / 100, fall: m.attr(349) / 100, track: m.attr(767) / 100, mvel: m.attr(547) / 100, flight: m.attr(596) / 100, ev: m.attr(847) / 100, er: m.attr(848) / 100,
        amt: m.attr(97) || 0, str: [241, 239, 240, 238].map((a) => m.attr(a) || 0), cap: Math.max(0, m.attr(FE.AT.capNeed) || 0), m: k });
      mark();
    }
    else if (names.includes('shipModuleGuidanceDisruptor')) { gds.push({ mvel: m.attr(547) / 100, flight: m.attr(596) / 100, ev: m.attr(847) / 100, er: m.attr(848) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    // 远程电容传输（powerTransferAmount 90）、远程感应增强（扫描分辨率 566 / 锁定距离 309）、远程跟踪电脑（351 / 349 / 767）：作用于友方
    else if (names.includes('shipModuleRemoteCapacitorTransmitter')) { rcaps.push({ amt: m.attr(90), range, falloff, cycle: dur, m: k }); mark(); }
    else if (names.includes('remoteSensorBoostFalloff')) { rsbs.push({ scan: m.attr(566) / 100, lock: m.attr(309) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    else if (names.includes('shipModuleRemoteTrackingComputer')) { rtcs.push({ opt: m.attr(351) / 100, fall: m.attr(349) / 100, track: m.attr(767) / 100, range, falloff, cycle: dur, m: k }); mark(); }
    // 跃迁扰断力场（重型拦截舰的泡泡，warpDisruptSphere）：warpScrambleRange（103）内所有船都跑不掉
    else if (names.includes('warpDisruptSphere')) { bubbles.push({ range: m.attr(103) || 0, str: m.attr(105) || 100, cycle: dur, m: k }); mark(); }
  }
  // 每门武器（空间模拟逐发计算）；fx 给 3D 视图画开火特效：伤害按弹药四种伤害的比例分配到这一发的总伤害
  const guns = stats.weapons.filter((w) => w.module.type.group !== DICTOR_LAUNCHER).map((w) => {
    const m = w.module, c = m.charge, turret = Boolean(m.type.turret);
    used.add(m);
    // 末日武器：每个循环（5 分钟左右）打一发，命中即满伤害
    if (w.doomsday) {
      const raw = FE.DAMAGE.map((a) => m.attr(a) || 0), rawSum = raw.reduce((a, b) => a + b, 0) || 1;
      const cycle = w.volley / w.dps;
      // 预热（doomsdayWarningDuration）之后才出伤；长枪 / 收割者等在持续时间里按伤害周期一跳一跳打
      const dur = (m.attr(2264) || 0) / 1000, tick = (m.attr(2265) || 0) / 1000;
      const ticks = dur && tick ? Math.max(1, Math.round(dur / tick)) : 1;
      return { doomsday: true, turret: false, type: m.type.id, warn: (m.attr(2262) || 0) / 1000, ticks, tick: ticks > 1 ? tick : 0, cycle, volley: w.volley, dmg: raw.map((x) => x / rawSum * w.volley), capNeed: Math.max(0, m.attr(FE.AT.capNeed)),
        ammo: Infinity, reload: 0, reach: w.range, m: idx.get(m), fx: { w: 'doom', c: 0x9fd6ff, s: 4 } };
    }
    const raw = FE.DAMAGE.map((a) => c.attr(a));
    const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
    const cycle = m.attr(FE.AT.speed) / 1000;
    // 弹夹：装备容量 / 弹药体积；频率晶体（有损坏几率属性）不用装填
    const per = loads(m);
    const crystal = (c.attr(783) || 0) > 0 || (m.attr(FE.AT.capNeed) > 0 && !per);
    // 引擎给的是递增满的伤害，模拟里逐轮递增：先换回初始伤害
    const vol0 = w.volley / (w.spool || 1);
    const g = { turret, type: m.type.id, cycle, volley: vol0, dmg: raw.map((x) => x / rawSum * vol0), capNeed: Math.max(0, m.attr(FE.AT.capNeed)),
      ammo: crystal || per <= 0 ? Infinity : per, reload: (m.attr(1795) || 10000) / 1000, m: idx.get(m) };
    g.fx = gunFx(m, c, raw, turret);
    // 超载：伤害、射速加成（百分比）
    g.ovD = (m.attr(1210) || 0) / 100;
    g.ovR = (m.attr(1205) || 0) / 100;
    if (m.type.group === 4060) {
      // 电涌投射器：按爆炸半径 / 速度算伤害，打中后跳到附近敌船
      const er = m.attr(654) || c.attr(654), ev = m.attr(653) || c.attr(653);
      Object.assign(g, { turret: true, vorton: true, reach: m.attr(FE.AT.maxRange), er, ev, drf: m.attr(1353) || c.attr(1353) || 1, arcRange: m.attr(3036) || 5000, arcs: m.attr(3037) || 1 });
    } else if (turret) Object.assign(g, { opt: m.attr(FE.AT.maxRange), fall: m.attr(FE.AT.falloff), track: m.attr(FE.AT.trackingSpeed), sigRes: m.attr(620) || 40000, reach: m.attr(FE.AT.maxRange) + m.attr(FE.AT.falloff) });
    else Object.assign(g, { mvel: c.attr(FE.AT.maxVelocity), flight: c.attr(FE.AT.explosionDelay) / 1000, reach: w.range, er: c.attr(654), ev: c.attr(653), drf: c.attr(1353) || 1 });
    // 热能分解器：连续打同一目标每轮加成，到上限为止
    if (m.type.group === 1986 && m.attr(2733) > 0) g.spool = { per: m.attr(2733), max: m.attr(2734) || 1.5 };
    return g;
  });
  const control = calc.char?.attr(458) || 60000;
  // 无人机：逐架按炮台公式（自身最佳射程、失准、跟踪、信号分辨率）；体积 5 / 10 / 25 为轻 / 中 / 重
  const drones = (stats.droneDps || []).map(({ drone: x }) => {
    const mult = x.attr(FE.AT.damageMultiplier) || 1;
    const dmg = FE.DAMAGE.map((a) => x.attr(a) * mult);
    const vel = x.attr(FE.AT.maxVelocity);
    const vol = x.attr(FE.AT.volume);
    const opt = x.attr(FE.AT.maxRange), fall = x.attr(FE.AT.falloff);
    return { type: x.type.id, n: x.active, dmg, volley: dmg.reduce((a, b) => a + b, 0), cycle: x.attr(FE.AT.speed) / 1000 || 4, sigRes: x.attr(620) || 400, vel, sentry: vel < 1, control,
      track: x.attr(FE.AT.trackingSpeed), opt, fall, attackRange: x.attr(247) || opt + fall * 2, fly: x.attr(416) || 1000, cruise: x.attr(508) || vel,
      size: vol >= 25 ? 2 : vol >= 10 ? 1 : 0, ent: droneEnt(x) };
  }).filter((x) => x.n > 0 && x.volley > 0);
  const fighters = calc.drones.filter((x) => x.type.category === 87 && x.active > 0).map(fighterOf).filter(Boolean);
  // 一直开着的装备（抗性、推进器、损控等）：没被上面归类的已开启装备
  let alwaysOn = 0;
  for (const m of calc.modules) if ((FE.STATE_RANK[m.state] || 0) >= 2 && !used.has(m) && idx.get(m) < 32) alwaysOn |= 1 << idx.get(m);
  // 走位用的距离：主力武器（输出占比最大的一类）的理想距离与最远射程
  const best = guns.slice().sort((a, b) => b.volley / b.cycle - a.volley / a.cycle)[0];
  const remoteReach = [...remote, ...webs, ...paints, ...neuts, ...noses, ...damps, ...ecms, ...tds, ...gds].map((x) => x.range + x.falloff * 0.5);
  const pref = best ? (best.vorton ? best.reach * 0.85 : best.turret ? best.opt + best.fall * 0.4 : best.reach * 0.85)
    : drones.length ? Math.min(control * 0.8, drones[0].sentry ? drones[0].opt + drones[0].fall * 0.5 : 20000)
    : fighters.length ? 40000 : remoteReach.length ? Math.min(...remoteReach) * 0.85 : 10000;
  const reach = best ? (best.vorton ? best.reach : best.turret ? best.opt + best.fall : best.reach * 0.95) : pref;
  const cap = stats.capacitor;
  const gunCap = guns.reduce((t, g) => t + g.capNeed / (g.cycle || 1), 0);
  return {
    guns, drones, fighters, fighter: stats.weapon.fighter, pref: Math.max(1000, pref), reach: Math.max(1500, reach),
    points, align: stats.navigation.align || 5, stab: Math.abs(ship.attr(104) || 0),
    // 跃迁：速度（AU/s，客户端 infosvc 按 max(1, baseWarpSpeed) × warpSpeedMultiplier）、每 AU 每千克耗电 warpCapacitorNeed（153）、质量
    warp: Math.max(1, ship.attr(1281) || 3) * (ship.attr(600) || 1), warpMul: ship.attr(600) || 1, warpCap: ship.attr(153) || 0, mass: stats.navigation.mass || 0,
    radius: ship.attr(FE.AT.radius) || 50, tau: (stats.navigation.agility * stats.navigation.mass) / 1e6 || 1,
    max: [d.shield.hp, d.armor.hp, d.hull.hp], res,
    types: stats.weapon.types.slice(), dps: stats.weapon.total,
    sig: stats.navigation.signature, vel: stats.navigation.velocity, scanRes: stats.targeting.scanRes,
    lockRange: stats.targeting.range, sensor: stats.targeting.sensor, sensorIdx: Math.max(0, SENSOR_TYPES.indexOf(stats.targeting.sensorType)),
    local: [d.reps.shield, d.reps.armor, d.reps.hull], localReps, regenC: d.shield.hp, regenTau: d.shield.hp && stats.defense.passiveRegen ? 2.5 * d.shield.hp / stats.defense.passiveRegen : 0,
    cap: { max: cap.capacity, tau: cap.recharge, use: Math.max(0, cap.usage), other: Math.max(0, cap.usage - gunCap), otherNoInj: Math.max(0, cap.usage - gunCap + injectors.reduce((t, x) => t + x.bonus * x.ammo / (x.cycle * x.ammo + x.reload), 0)) },
    injectors, remote, webs, paints, neuts, noses, damps, ecms, smarts, bursts, tds, gds, rcaps, rsbs, rtcs, mjds, bubbles, cloaks, fields, dictors, ehp: d.ehp, rack, alwaysOn,
    // 速度 / 惯性 / 信号半径 / 炮塔跟踪上，装备（和舰队加成）参与叠加惩罚的百分比加成：深渊气云、塔的加成要和它们排进同一条链
    pen: { vel: FE.penFracs(ship, FE.AT.maxVelocity), agi: FE.penFracs(ship, 70), sig: FE.penFracs(ship, 552),
      track: FE.penFracs(stats.weapons.map((w) => w.module).find((m) => m.attr(FE.AT.trackingSpeed) > 0), FE.AT.trackingSpeed) }
  };
}

// 无人机放出后的实体（驾驶模拟里能被锁定、能被打）：护盾 263 / 装甲 265 / 结构 9、三层抗性、信号半径 552、半径 162、护盾回充 479（毫秒）
function droneEnt(x) {
  const { FE } = ctx;
  const max = [x.attr(263) || 0, x.attr(265) || 0, x.attr(9) || 1];
  const res = ['shield', 'armor', 'hull'].map((k) => FE.RESIST[k].map((a) => x.attr(a) || 1));
  const ehp = max.reduce((t, h, l) => t + h / Math.max(0.05, res[l].reduce((a, b) => a + b, 0) / 4), 0);
  const vel = x.attr(FE.AT.maxVelocity);
  return {
    guns: [], drones: [], fighters: [], fighter: 0, pref: 1000, reach: 1500, points: [], align: 1, stab: 0,
    radius: x.attr(FE.AT.radius) || 5, tau: 1, max, res, types: [], dps: 0, sig: x.attr(552) || 25, vel, scanRes: x.attr(564) || 0,
    lockRange: 0, sensor: 0, sensorIdx: 0, local: [0, 0, 0], localReps: [], regenC: max[0], regenTau: max[0] ? (x.attr(479) || 0) / 1000 : 0,
    cap: { max: 0, tau: 0, use: 0, other: 0, otherNoInj: 0 }, injectors: [], remote: [], webs: [], paints: [], neuts: [], noses: [], damps: [], ecms: [], ehp, rack: [], alwaysOn: 0
  };
}

// 指挥脉冲：按 T2 脉冲 + 满技能 + 指挥舰加成 + 思维链接估算（基础值 × 1.25 × 1.5 × 1.15 × 1.25 ≈ 2.7 倍）
const BURST_MULT = 1.25 * 1.5 * 1.15 * 1.25;
const BURSTS = [
  ['shield', '护盾', `护盾抗性 +${(8 * BURST_MULT).toFixed(1)}%、护盾 HP +${(8 * BURST_MULT).toFixed(1)}%`],
  ['armor', '装甲', `装甲抗性 +${(8 * BURST_MULT).toFixed(1)}%、装甲 HP +${(8 * BURST_MULT).toFixed(1)}%`],
  ['skirmish', '游击', `信号半径 −${(6 * BURST_MULT).toFixed(1)}%`],
  ['info', '信息', `扫描分辨率 +${(9 * BURST_MULT).toFixed(1)}%、锁定距离 +${(18 * BURST_MULT).toFixed(1)}%`]
];
function applyBursts(u, list) {
  if (!list?.length) return u;
  const v = { ...u, res: u.res.map((r) => r.slice()), max: u.max.slice() };
  const tank = (layer) => { v.res[layer] = v.res[layer].map((r) => r * (1 - 0.08 * BURST_MULT)); v.max[layer] *= 1 + 0.08 * BURST_MULT; };
  if (list.includes('shield')) tank(0);
  if (list.includes('armor')) tank(1);
  if (list.includes('skirmish')) v.sig *= 1 - 0.06 * BURST_MULT;
  if (list.includes('info')) { v.scanRes *= 1 + 0.09 * BURST_MULT; v.lockRange *= 1 + 0.18 * BURST_MULT; }
  const ehp = (x) => x.max.reduce((s, hp, i) => s + hp / mean(x.res[i]), 0);
  v.ehp = u.ehp * ehp(v) / (ehp(u) || 1);
  v.regenC = v.max[0];
  return v;
}

const mean = (r) => (r[0] + r[1] + r[2] + r[3]) / 4 || 1;

// 装配 → { calc, stats, unit }：超载 = 能超载的已开启装备全部超载（不计过热损坏）；chargeOv = 驾驶模拟里换过的弹药（槽位:序号 → 弹药类型）
export function buildUnit(fit0, { skills = 'max', heat = false, bursts = [] } = {}) {
  const { FE, data } = ctx;
  const chg = (m, key) => (key && O.chargeOv?.has(key) ? { ...m, charge: O.chargeOv.get(key) } : m);
  const state = (m0, key, m = chg(m0, key)) => (forcedOff(m, key) ? { ...m, state: 'online' } : heat && m.state === 'active' && data.types.get(m.type)?.overloadable ? { ...m, state: 'overload' } : m);
  const fit = { ...fit0, slots: Object.fromEntries(FE.SLOTS.map((s) => [s, (fit0.slots[s] || []).map((m, i) => (m ? state(m, `${s}:${i}`) : m))])) };
  const calc = FE.computeFit(data, fit, skills);
  const stats = calc ? FE.fitStats(calc) : null;
  const row = { fit: fit0, calc, stats };
  return { calc, stats, unit: stats ? applyBursts(unitTemplate(row), bursts) : null };
}
// 驾驶用（驾驶模拟里自己的船、匹配服务器里每个玩家）：装配里「在线」的主动装备也算进来，开不开由玩家决定。
// 返回 { calc, stats, unit, off, prop, variant, mwd }：unit = 推进器开启时的属性，off = 推进器关闭，prop = 推进器在装备栏里的序号（没有为 -1）；
// variant(装备栏序号[], { 序号: 弹药 }) = 这几件主动装备关着、换了这些弹药时的属性（按组合缓存）；mwd = 推进器是微型跃迁推进器
// opt.self = 玩家自己开的船（隐形装置可以开）；opt.base = 调用方的其他选项（只换 prop / offKeys / chargeOv / cloakOk）
export function pilotUnit(fit0, { skills = 'max', heat = false, bursts = [], self = false, base = {} } = {}) {
  const { FE, data } = ctx;
  const fit = { ...fit0, slots: Object.fromEntries(Object.entries(fit0.slots || {}).map(([k, l]) => [k, (l || []).map((m) => (m && m.state === 'online' && data.types.get(m.type)?.activatable ? { ...m, state: 'active' } : m))])) };
  const keep = O;
  // 舰船模式（战术驱逐舰等）：没指定就用第一个（防御 / 主模式）；variant 的第三个参数可以换模式
  const modes = data.modes?.get(fit0.ship) || [];
  const mode0 = FE.modeOf(data, fit0);
  const run = (o, mode = mode0) => { O = { ...base, cloakOk: self, ...o }; try { return buildUnit(mode ? { ...fit, mode } : fit, { skills, heat, bursts }); } finally { O = keep; } };
  const off = run({ prop: false }).unit;
  const on = run({ prop: true });
  const rack = on.unit?.rack || [], cache = new Map();
  const prop = rack.findIndex((m) => { const t = data.types.get(m.type); return t?.attrs.has(FE.AT.speedBoostFactor) && t.attrs.has(FE.AT.massAddition); });
  const variant = (list, charges = {}, mode = mode0) => {
    const keys = [...new Set(list)].filter((i) => rack[i]).sort((a, b) => a - b);
    const ch = Object.entries(charges).filter(([i, c]) => rack[i] && c && c !== rack[i].charge).sort((a, b) => a[0] - b[0]);
    const md = modes.includes(mode) ? mode : mode0;
    const k = keys.join(',') + '|' + ch.map(([i, c]) => `${i}=${c}`).join(',') + '|' + md;
    if (!keys.length && !ch.length && md === mode0) return on.unit;
    if (!cache.has(k)) cache.set(k, run({ prop: true, offKeys: new Set(keys.map((i) => rack[i].key)), chargeOv: new Map(ch.map(([i, c]) => [rack[i].key, Number(c)])) }, md).unit || on.unit);
    return cache.get(k);
  };
  const mwd = prop >= 0 && (data.types.get(rack[prop].type)?.attrs.get(FE.AT.signatureRadiusBonus) || 0) > 0;
  // modes = 这条船的模式 [防御 / 主, 狙击 / 次级, 高速 / 三级]，mode = 开局模式，modeCd = 切换冷却（秒，舰船属性 1985 stanceSwitchTime）
  const modeCd = (on.calc?.ship.attr(1985) || 10000) / 1000;
  return { ...on, fit, off, prop, variant, mwd, modes, mode: mode0, modeCd };
}
export { forcedOff, unitTemplate, applyBursts, BURSTS, BURST_MULT, mean, REACTIVATION_DELAY };
