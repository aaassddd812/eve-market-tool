// ===== NPC → 战斗单位（驾驶模拟的死亡空间 / 深渊场景用）=====
// NPC 不装装备：武器、电子战、维修都是自身的效果 + 属性（SDE typeDogma）。这里照效果定义（dogmaEffects 的
// duration / range / falloff / discharge 属性）把它们换成 sim-unit.js unitTemplate 同样结构的模板，引擎照常推进。
//   · 炮台 targetAttack：伤害 = 四种伤害 × damageMultiplier(64)，射速 speed(51)，最佳 maxRange(54)，失准 falloff(158)，
//     跟踪 trackingSpeed(160)，信号分辨率 optimalSigRadius(620)
//   · 热能分解器 targetDisintegratorAttack：同上，另按 damageMultiplierBonusPerCycle(2733) / Max(2734) 逐轮递增
//   · 导弹 missileLaunchingForEntity：弹种 entityMissileTypeID(507)，伤害 × missileDamageMultiplier(212)，
//     速度 / 飞行时间 / 爆炸半径 / 爆炸速度 × missileEntity*Multiplier(645 / 646 / 858 / 859)，发射间隔 missileLaunchDuration(506)
//   · 新式行为（npcBehavior* / behavior*）：周期、射程、失准、耗电各有专门的属性，数值用通用属性（网 speedFactor、中和
//     energyNeutralizerAmount、标记 signatureRadiusBonus、阻尼 maxTargetRangeBonus / scanResolutionBonus、ECM scan*StrengthBonus、
//     跟踪 / 制导扰断 maxRangeBonus 等、遥修 armorDamageAmount / shieldBonus、本地维修 behaviorArmorRepairerAmount / behaviorShieldBoosterAmount）
//   · 旧式实体效果（warpScrambleForEntity、modifyTargetSpeed2、entity*）：每个周期按「生效几率」属性掷骰，成功才在这个周期生效
//     （entityWarpScrambleChance 504、modifyTargetSpeedChance 512、ECMEntityChance 930、energyNeutralizerEntityChance 931 等）
//   · 旧式本地维修（entityArmorRepairing* / entityShieldBoosting*）：带「延迟几率」（638 / 639 / 1008～1011），
//     这里按每个周期有这个几率不修计算
// 没做的：攻城模式（npcBehaviorSiege）、NPC 微跃 / 微型跃迁推进器、末日武器、连锁闪电、防御导弹（entityDefenderChance）。
// n = { id, a: { 属性ID: 值 }, e: [效果名], r: 半径, m: 质量 }；msl = { 导弹 typeID: { a } }
const DMG = [114, 118, 117, 116];   // EM、热能、动能、爆炸（同 FE.DAMAGE）
const RES = [[271, 274, 273, 272], [267, 270, 269, 268], [113, 110, 109, 111]];
const SENSOR = [208, 209, 210, 211];   // 雷达、光雷达、磁力、引力（同 sim-unit SENSOR_TYPES）
const ECM_STR = [241, 239, 240, 238];
const mean4 = (r) => (r[0] + r[1] + r[2] + r[3]) / 4 || 1;
// 开火特效：按主伤害类型选（NPC 的炮塔模型 gfxTurretID 没转）
function gunFx(dmg, kind) {
  if (kind === 'disint') return { w: 'disint', c: 0xff5a3a, s: 1 };
  if (kind === 'missile') return { w: 'missile', c: [0x88b8ff, 0xff7a3a, 0xdfe4ec, 0xffcf4a][dmg.indexOf(Math.max(...dmg))] ?? 0xffcf4a, er: 50, v: 3000 };
  const [em, th, ki, ex] = dmg;
  if (em >= ki && em >= ex) return { w: 'pulse', c: 0xff9933, s: 1 };
  if (ex + ki > em + th && ex >= ki * 0.5) return { w: 'auto', c: 0xffb04a, s: 1 };
  return { w: 'blaster', c: 0x9fe8ff, s: 1 };
}
export function npcUnit(n, msl = {}) {
  const A = (k, d = 0) => (n.a[k] ?? d);
  const has = (name) => n.e.includes(name);
  const sec = (k, d = 0) => (A(k) || d) / 1000;
  let m = 0;   // 装备序号（引擎按它记周期 / 特效位）
  const max = [A(263), A(265), Math.max(1, A(9))];
  // 出生时不满血：SDE 里有些 NPC（深渊勒沙克、流浪者、迪斯帕鲁部队、德雷卡瓦等）带 shieldCharge(264) / armorDamage(266) / damage(3)，
  // 服务器按这些属性给出生时的血量：护盾 = shieldCharge，装甲 = armorHP − armorDamage，结构 = hp − damage（都是绝对值）
  const hp0 = [264 in n.a ? Math.min(max[0], A(264)) : max[0], Math.max(0, max[1] - A(266)), Math.max(1, max[2] - A(3))];
  const res = RES.map((l) => l.map((a) => A(a, 1)));
  const guns = [];
  const turret = (kind) => {
    const dmg = DMG.map((a) => A(a) * A(64, 1));
    const volley = dmg.reduce((s, x) => s + x, 0);
    if (!volley) return;
    const g = { turret: true, type: n.id, cycle: sec(51, 3000), volley, dmg, capNeed: 0, ammo: Infinity, reload: 0, m: m++,
      opt: A(54), fall: A(158), track: A(160), sigRes: A(620, 40000), reach: A(54) + A(158), fx: gunFx(dmg, kind) };
    if (kind === 'disint' && A(2733) > 0) g.spool = { per: A(2733), max: A(2734, 1.5) };
    guns.push(g);
  };
  if (has('targetAttack')) turret('gun');
  if (has('targetDisintegratorAttack')) turret('disint');
  // 电涌（EntityChainLightning，雷裔级等 Edencom NPC）：和玩家的电涌投射器同一套——射程 maxRange，按爆炸半径 / 速度算命中，
  // 再跳到附近的 VortonArcTargets 个目标（VortonArcRange 内）；伤害 = 伤害属性 × damageMultiplier，周期 speed
  if (has('EntityChainLightning')) {
    const dmg = DMG.map((a) => A(a) * A(64, 1));
    const volley = dmg.reduce((s, x) => s + x, 0);
    if (volley) guns.push({ turret: true, vorton: true, type: n.id, cycle: sec(51, 3000), volley, dmg, capNeed: 0, ammo: Infinity, reload: 0, m: m++,
      reach: A(54), er: A(654), ev: A(653), drf: A(1353, 1), arcRange: A(3036, 5000), arcs: A(3037, 1), fx: { w: 'vorton', c: 0xa8d8ff, s: 1 } });
  }
  const mt = msl[A(507)];
  if (has('missileLaunchingForEntity') && mt && A(506) > 1) {
    const M = (k, d = 0) => mt.a[k] ?? d;
    const dmg = DMG.map((a) => M(a) * A(212, 1));
    const volley = dmg.reduce((s, x) => s + x, 0);
    const mvel = M(37) * A(645, 1), flight = (M(281) / 1000) * A(646, 1);
    if (volley > 0 && mvel > 0) guns.push({ turret: false, type: A(507), cycle: A(506) / 1000, volley, dmg, capNeed: 0, ammo: Infinity, reload: 0, m: m++,
      mvel, flight, reach: mvel * flight, er: M(654) * A(858, 1), ev: M(653) * A(859, 1), drf: M(1353, 1), fx: { ...gunFx(dmg, 'missile'), er: M(654) * A(858, 1) || 50, v: mvel } });
  }
  const webs = [], points = [], neuts = [], noses = [], paints = [], damps = [], ecms = [], tds = [], gds = [], remote = [], localReps = [], smarts = [];
  let capUse = 0;
  const use = (dis, dur) => { if (A(dis) > 0 && A(dur) > 0) capUse += A(dis) / (A(dur) / 1000); };
  // 新式行为
  if (has('npcBehaviorWebifier')) { webs.push({ v: A(20) / 100, range: A(2500), falloff: A(2501), cycle: sec(2499, 5000), m: m++ }); use(2502, 2499); }
  if (has('behaviorWarpDisrupt')) { points.push({ str: A(2510, 1), range: A(2504), cycle: sec(2503, 5000), m: m++, noScram: true }); use(2505, 2503); }
  if (has('behaviorWarpScramble')) { points.push({ str: Math.max(2, A(2509, 2)), range: A(2507), cycle: sec(2506, 5000), m: m++ }); use(2508, 2506); }
  if (has('npcBehaviorEnergyNeutralizer')) { neuts.push({ amt: A(97), cycle: sec(2519, 10000), rate: A(97) / sec(2519, 10000), range: A(2520), falloff: A(2521), m: m++ }); use(2522, 2519); }
  if (has('npcBehaviorEnergyNosferatu')) { noses.push({ amt: A(90), cycle: sec(2630, 10000), rate: A(90) / sec(2630, 10000), range: A(2632), falloff: A(2631), m: m++ }); }
  if (has('behaviorTargetPainter')) { paints.push({ v: A(554) / 100, range: A(2524), falloff: A(2525), cycle: sec(2523, 5000), m: m++ }); use(2526, 2523); }
  if (has('behaviorSensorDampener')) { damps.push({ scan: A(566) / 100, lock: A(309) / 100, range: A(2528), falloff: A(2529), cycle: sec(2527, 10000), m: m++ }); use(2530, 2527); }
  if (has('behaviorECM')) { const c = sec(2531, 20000); ecms.push({ str: ECM_STR.map((a) => A(a)), cycle: Math.max(1, Math.round(c)), jam: Math.max(1, Math.round(c)), range: A(2532), falloff: A(2533), m: m++ }); use(2534, 2531); }
  if (has('npcBehaviorTrackingDisruptor')) { tds.push({ opt: A(351) / 100, fall: A(349) / 100, track: A(767) / 100, range: A(2516), falloff: A(2517), cycle: sec(2515, 5000), m: m++ }); use(2518, 2515); }
  if (has('npcBehaviorGuidanceDisruptor')) { gds.push({ mvel: A(547) / 100, flight: A(596) / 100, ev: A(847) / 100, er: A(848) / 100, range: A(2512), falloff: A(2513), cycle: sec(2511, 5000), m: m++ }); use(2514, 2511); }
  if (has('npcBehaviorRemoteArmorRepairer')) { const c = sec(2491, 5000); remote.push({ layer: 1, amt: A(84), cycle: c, rate: A(84) / c, range: A(2492), falloff: A(2493), m: m++ }); use(2494, 2491); }
  if (has('npcBehaviorRemoteShieldBooster')) { const c = sec(2495, 5000); remote.push({ layer: 0, amt: A(68), cycle: c, rate: A(68) / c, range: A(2496), falloff: A(2497), m: m++ }); use(2498, 2495); }
  if (has('npcBehaviorArmorRepairer')) { localReps.push({ layer: 1, amt: A(2635), cycle: sec(2633, 5000), m: m++, ammo: Infinity, reload: 0 }); use(2634, 2633); }
  if (has('npcBehaviorShieldBooster')) { localReps.push({ layer: 0, amt: A(2723), cycle: sec(2725, 5000), m: m++, ammo: Infinity, reload: 0 }); use(2724, 2725); }
  if (has('npcBehaviorSmartBomb')) { smarts.push({ dmg: DMG.map((a) => A(a)), range: A(99), cycle: sec(2812, 10000), type: n.id, m: m++ }); use(2814, 2812); }
  // 旧式实体效果：每个周期按几率生效
  if (has('warpScrambleForEntity') || has('warpScrambleTargetMWDBlockActivationForEntity')) points.push({ str: A(105, 1), range: A(103), cycle: sec(505, 5000), chance: A(504, 1), m: m++, noScram: !has('warpScrambleTargetMWDBlockActivationForEntity') });
  if (has('modifyTargetSpeed2')) webs.push({ v: A(20) / 100, range: A(514), falloff: 0, cycle: sec(513, 5000), chance: A(512, 1), m: m++ });
  if (has('entityEnergyNeutralizerFalloff')) neuts.push({ amt: A(97), cycle: sec(942, 10000), rate: A(97) * A(931, 1) / sec(942, 10000), range: A(98), falloff: 0, chance: A(931, 1), m: m++ });
  if (has('entityTargetPaint')) paints.push({ v: A(554) / 100, range: A(941), falloff: A(954), cycle: sec(945, 10000), chance: A(935, 1), m: m++ });
  if (has('entitySensorDampen')) damps.push({ scan: A(565, 1) - 1, lock: A(237, 1) - 1, range: A(938), falloff: A(950), cycle: sec(943, 10000), chance: A(932, 1), m: m++ });
  if (has('entityECMFalloff')) { const c = sec(929, 20000); ecms.push({ str: ECM_STR.map((a) => A(a) * A(930, 1)), cycle: Math.max(1, Math.round(c)), jam: Math.max(1, Math.round(c)), range: A(936), falloff: 0, m: m++ }); }
  if (has('npcEntityTrackingDisruptor')) tds.push({ opt: A(351) / 100, fall: A(349) / 100, track: A(767) / 100, range: A(2516), falloff: A(2517), cycle: sec(2515, 5000), chance: A(933, 1), m: m++ });
  const oldShield = ['entityShieldBoostingSmall', 'entityShieldBoostingMedium', 'entityShieldBoostingLarge', 'entityShieldBoosting', 'shieldBoostingForEntities'].some(has);
  const oldArmor = ['entityArmorRepairingSmall', 'entityArmorRepairingMedium', 'entityArmorRepairingLarge', 'entityArmorRepairing', 'armorRepairForEntities'].some(has);
  const delay = (l) => Math.max(0, ...l.map((k) => A(k)));
  if (oldShield && A(637) > 0) localReps.push({ layer: 0, amt: A(637), cycle: sec(636, 5000), skip: delay([639, 1008, 1006, 1007]), m: m++, ammo: Infinity, reload: 0 });
  if (oldArmor && A(631) > 0) localReps.push({ layer: 1, amt: A(631), cycle: sec(630, 10000), skip: delay([638, 1009, 1010, 1011]), m: m++, ammo: Infinity, reload: 0 });

  const types = DMG.map((_, k) => guns.reduce((s, g) => s + g.dmg[k] / (g.cycle || 1), 0));
  const dps = types.reduce((s, x) => s + x, 0);
  const best = guns.slice().sort((a, b) => b.volley / b.cycle - a.volley / a.cycle)[0];
  const reach = best ? (best.vorton ? best.reach : best.turret ? best.opt + best.fall : best.reach * 0.95) : 10000;
  // 环绕距离：npcBehaviorMaximumCombatOrbitRange(2786)，旧式 NPC 用 entityFlyRange(416)
  const orbit = A(2786) || A(416) || (best ? Math.min(reach * 0.7, 20000) : 5000);
  const sens = SENSOR.map((a) => A(a));
  const sensor = Math.max(...sens);
  const vel = A(37);
  // 灵活度：新式 NPC 有 agility(70)，旧式的没有 —— 按质量估一个（时间常数 = 灵活度 × 质量 / 10⁶），拿不准
  const tau = Math.max(1, ((A(70) || 0.5) * (n.m || 1e6)) / 1e6);
  const ehp = max.reduce((t, h, l) => t + h / Math.max(0.05, mean4(res[l])), 0);
  return {
    guns, drones: [], fighters: [], fighter: 0, pref: Math.max(500, orbit), reach: Math.max(1500, reach),
    points, align: 5, stab: 0, warp: 0, warpMul: 1, warpCap: 0, mass: n.m || 0,
    radius: n.r || 50, tau, max, res, types, dps,
    sig: A(552, 100), vel, scanRes: A(564, 300), lockRange: A(76) || Math.max(A(247), reach * 1.5, 30000), sensor, sensorIdx: Math.max(0, sens.indexOf(sensor)),
    local: [0, 0, 0], localReps, regenC: max[0], regenTau: max[0] ? sec(479, 0) : 0,
    cap: { max: A(482), tau: sec(55, 0), use: capUse, other: capUse, otherNoInj: capUse },
    injectors: [], remote, webs, paints, neuts, noses, damps, ecms, smarts, bursts: [], tds, gds, rcaps: [], rsbs: [], rtcs: [], mjds: [], bubbles: [], cloaks: [], fields: [], dictors: [],
    ehp, rack: [], alwaysOn: 0, hp0: hp0.some((h, l) => h < max[l]) ? hp0 : null,
    npc: true, stay: true, bounty: A(481)
  };
}
