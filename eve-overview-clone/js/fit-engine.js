// ===== 模拟装配：属性计算引擎（dogma）=====
// 数据来自 fit-data.json（server/build_fit_data.py 由 CCP 官方 SDE 生成）。
// 计算方式与游戏一致：每个属性 = 基础值，依次应用各效果的修改（预赋值、预乘、预除、加、减、后乘 / 后除 / 百分比、后赋值），
// 不可叠加的属性对装备来源的乘法修改施加叠加惩罚（舰船、技能、植入体、子系统、弹药来源不受惩罚）。
// 绝大多数加成来自效果的 modifierInfo；推进器提速、子系统槽位等少数效果在这里单独实现。

// ---------- 常用属性 ----------
export const AT = {
  mass: 4, capacity: 38, volume: 161, radius: 162,
  cpu: 50, power: 30, cpuOutput: 48, powerOutput: 11, upgradeCost: 1153, upgradeCapacity: 1132,
  hiSlots: 14, medSlots: 13, lowSlots: 12, rigSlots: 1137, maxSubSystems: 1367, turretSlots: 102, launcherSlots: 101,
  rigSize: 1547, droneCapacity: 283, droneBandwidth: 1271, droneBandwidthUsed: 1272,
  chargeSize: 128, chargeGroups: [604, 605, 606, 609], chargeRate: 56,
  speed: 51, damageMultiplier: 64, duration: 73, capNeed: 6, capacitorBonus: 67,
  em: 114, explosive: 116, kinetic: 117, thermal: 118, missileDamageMultiplier: 212,
  shieldCapacity: 263, armorHP: 265, hp: 9, shieldRecharge: 479, capCapacity: 482, capRecharge: 55,
  maxVelocity: 37, agility: 70, warpSpeedMultiplier: 600, baseWarpSpeed: 1281, signatureRadius: 552,
  maxTargetRange: 76, scanResolution: 564, maxLockedTargets: 192, sensors: [208, 209, 210, 211],
  shieldBonus: 68, armorDamageAmount: 84, structureDamageAmount: 83, chargedArmorDamageMultiplier: 1886,
  speedFactor: 20, speedBoostFactor: 567, massAddition: 796, signatureRadiusBonus: 554,
  maxRange: 54, falloff: 158, trackingSpeed: 160, explosionDelay: 281,
  maxGroupFitted: 1544, maxTypeFitted: 2431, maxGroupActive: 763, maxActiveDrones: 352,
  skillLevel: 280, subSystemSlot: 1366, fitsToShipType: 1380,
  hiSlotModifier: 1374, medSlotModifier: 1375, lowSlotModifier: 1376, turretHardPointModifier: 1368, launcherHardPointModifier: 1369,
  fighterCapacity: 2055, fighterTubes: 2216, fighterLightSlots: 2217, fighterSupportSlots: 2218, fighterHeavySlots: 2219,
  fighterIsLight: 2212, fighterIsSupport: 2213, fighterIsHeavy: 2214, fighterSquadronSize: 2215,
  fighterAttackDmg: [2227, 2228, 2229, 2230], fighterAttackMult: 2226, fighterAttackDuration: 2233,
  fighterMissileDmg: [2131, 2132, 2133, 2134], fighterMissileMult: 2130, fighterMissileDuration: 2182,
  canFitShipGroup: [1298, 1299, 1300, 1301, 1872, 1879, 1880, 1881, 2065, 2396, 2476, 2477, 2478, 2479, 2480, 2481, 2482, 2483, 2484, 2485],
  canFitShipType: [1302, 1303, 1304, 1305, 1944, 2103, 2463, 2486, 2487, 2488, 2758],
  reqSkills: [[182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288]]
};
// 抗性：电磁、热能、动能、爆炸
export const RESIST = {
  shield: [271, 274, 273, 272],
  armor: [267, 270, 269, 268],
  hull: [113, 110, 109, 111]
};
export const DAMAGE = [AT.em, AT.thermal, AT.kinetic, AT.explosive];

export const CAT = { ship: 6, module: 7, charge: 8, skill: 16, drone: 18, implant: 20, subsystem: 32, fighter: 87 };
const EXEMPT = new Set([CAT.ship, CAT.charge, CAT.skill, CAT.implant, CAT.subsystem]);   // 不受叠加惩罚的来源
const EFFECT = { passive: 0, active: 1, target: 2, online: 4, overload: 5 };
const STATE_RANK = { offline: 0, online: 1, active: 2, overload: 3 };
const OP = { preAssign: -1, preMul: 0, preDiv: 1, modAdd: 2, modSub: 3, postMul: 4, postDiv: 5, postPercent: 6, postAssign: 7 };
const PENALTY = (i) => Math.exp(-((i / 2.67) ** 2));
const SLOT_EFFECT = { 12: 'high', 13: 'mid', 11: 'low', 2663: 'rig', 3772: 'sub' };
export const SLOTS = ['high', 'mid', 'low', 'rig', 'sub'];

// ---------- 数据 ----------
let DATA = null;

export function loadFitData(url) {
  if (!DATA) {
    DATA = fetch(url).then((r) => {
      if (!r.ok) throw new Error('装配数据加载失败 HTTP ' + r.status);
      return r.json();
    }).then(parse).catch((error) => { DATA = null; throw error; });
  }
  return DATA;
}

function parse(raw) {
  const attrs = new Map(Object.entries(raw.attrs).map(([id, [def, stackable, highIsGood, name]]) => [Number(id), { def, stackable: !!stackable, highIsGood: !!highIsGood, name }]));
  const effects = new Map(Object.entries(raw.effects).map(([id, [name, category, mods]]) => [Number(id), { id: Number(id), name, category, mods }]));
  const groups = new Map(Object.entries(raw.groups).map(([id, [name, category]]) => [Number(id), { id: Number(id), name, category }]));
  const markets = new Map(Object.entries(raw.markets).map(([id, [name, parent]]) => [Number(id), { id: Number(id), name, parent, children: [], types: [] }]));
  const types = new Map();
  const byName = new Map();
  for (const [key, [name, en, group, market, meta, attrMap, effs, dflt]] of Object.entries(raw.types)) {
    const id = Number(key);
    const g = groups.get(group);
    const a = new Map(Object.entries(attrMap).map(([k, v]) => [Number(k), v]));
    const t = { id, name, en, group, category: g?.category, market, meta, attrs: a, effects: effs, dflt };
    t.slot = slotOf(t);
    t.turret = effs.includes(42);
    t.launcher = effs.includes(40);
    const def = effects.get(dflt);
    t.activatable = Boolean(def && (def.category === EFFECT.active || def.category === EFFECT.target) && def.name !== 'online');
    t.overloadable = effs.some((e) => effects.get(e)?.category === EFFECT.overload);
    t.skills = AT.reqSkills.map(([s, l]) => [a.get(s), a.get(l) || 0]).filter(([s]) => s);
    types.set(id, t);
    byName.set(name.toLowerCase(), t);
    if (en) byName.set(en.toLowerCase(), t);
  }
  for (const m of markets.values()) if (m.parent && markets.has(m.parent)) markets.get(m.parent).children.push(m);
  for (const t of types.values()) if (t.market && markets.has(t.market)) markets.get(t.market).types.push(t);
  const skills = [...types.values()].filter((t) => t.category === CAT.skill);
  const char = new Map(Object.entries(raw.char || {}).map(([k, v]) => [Number(k), v]));
  return { attrs, effects, groups, markets, types, byName, skills, char };
}

function slotOf(t) {
  for (const e of t.effects) if (SLOT_EFFECT[e]) return SLOT_EFFECT[e];
  return null;
}

// ---------- 物品与属性计算 ----------
class Item {
  constructor(data, type, kind, base = null) {
    this.data = data;
    this.type = type;
    this.kind = kind;                 // ship / module / charge / drone / skill / implant / char
    this.base = base || type?.attrs || new Map();
    this.mods = new Map();            // 属性 -> [{ op, src, srcAttr, value, fn }]
    this.memo = new Map();
  }
  get category() { return this.kind === 'char' ? 0 : this.type.category; }
  baseValue(id) {
    if (this.base.has(id)) return this.base.get(id);
    return this.data.attrs.get(id)?.def ?? 0;
  }
  requiresSkill(skill) {
    return Boolean(this.type?.skills.some(([s]) => s === skill));
  }
  addMod(attr, mod) {
    if (!this.mods.has(attr)) this.mods.set(attr, []);
    this.mods.get(attr).push(mod);
  }
  attr(id) {
    if (this.memo.has(id)) return this.memo.get(id);
    const base = this.baseValue(id);
    this.memo.set(id, base);          // 防止循环依赖
    const list = this.mods.get(id);
    const value = list ? applyMods(this.data, id, base, list) : base;
    this.memo.set(id, value);
    return value;
  }
}

function modValue(m) {
  return m.fn ? m.fn() : m.src.attr(m.srcAttr);
}

function applyMods(data, attrId, base, list) {
  const meta = data.attrs.get(attrId);
  const stackable = meta ? meta.stackable : true;
  const byOp = new Map();
  for (const m of list) {
    if (!byOp.has(m.op)) byOp.set(m.op, []);
    byOp.get(m.op).push(m);
  }
  const vals = (op) => (byOp.get(op) || []).map((m) => ({ v: modValue(m), m }));
  let v = base;
  const pre = vals(OP.preAssign);
  if (pre.length) v = pre[pre.length - 1].v;
  v = multiply(v, vals(OP.preMul).map(({ v: x, m }) => ({ x, m })), stackable);
  v = multiply(v, vals(OP.preDiv).map(({ v: x, m }) => ({ x: x ? 1 / x : 1, m })), stackable);
  for (const { v: x } of vals(OP.modAdd)) v += x;
  for (const { v: x } of vals(OP.modSub)) v -= x;
  // 后乘、后除、百分比在同一条叠加惩罚链上
  const post = [
    ...vals(OP.postMul).map(({ v: x, m }) => ({ x, m })),
    ...vals(OP.postDiv).map(({ v: x, m }) => ({ x: x ? 1 / x : 1, m })),
    ...vals(OP.postPercent).map(({ v: x, m }) => ({ x: 1 + x / 100, m }))
  ];
  v = multiply(v, post, stackable);
  const assign = vals(OP.postAssign);
  if (assign.length) v = assign[assign.length - 1].v;
  return v;
}

function multiply(v, list, stackable) {
  if (!list.length) return v;
  const penalized = [];
  for (const { x, m } of list) {
    if (stackable || m.exempt) v *= x;
    else penalized.push(x);
  }
  if (penalized.length) {
    const up = penalized.filter((x) => x > 1).sort((a, b) => b - a);
    const down = penalized.filter((x) => x < 1).sort((a, b) => a - b);
    up.forEach((x, i) => { v *= 1 + (x - 1) * PENALTY(i); });
    down.forEach((x, i) => { v *= 1 + (x - 1) * PENALTY(i); });
  }
  return v;
}

// ---------- 装配计算 ----------
/**
 * fit: { ship: typeId, slots: { high: [mod|null], mid, low, rig, sub }, drones: [{ type, count, active }], implants: [typeId] }
 * mod: { type, state: 'offline'|'online'|'active'|'overload', charge: typeId|null }
 * skills: 'max'（全部 5 级）或 Map(skillId -> 等级)
 */
export function computeFit(data, fit, skills = 'max') {
  const shipType = data.types.get(fit.ship);
  if (!shipType) return null;
  const char = new Item(data, null, 'char', data.char);
  const ship = new Item(data, shipType, 'ship');
  const skillItems = [];
  for (const t of data.skills) {
    const level = skills === 'max' ? 5 : (skills.get(t.id) || 0);
    if (!level) continue;
    const base = new Map(t.attrs);
    base.set(AT.skillLevel, level);
    skillItems.push(new Item(data, t, 'skill', base));
  }
  const implants = (fit.implants || []).map((id) => data.types.get(id)).filter(Boolean).map((t) => new Item(data, t, 'implant'));
  const modules = [];
  const charges = [];
  for (const slot of SLOTS) {
    (fit.slots?.[slot] || []).forEach((m, index) => {
      const t = m && data.types.get(m.type);
      if (!t) return;
      const item = new Item(data, t, 'module');
      // 改装件、子系统始终在线
      item.state = slot === 'rig' || slot === 'sub' ? 'online' : (m.state || 'online');
      item.slot = slot;
      item.index = index;
      item.ref = m;
      modules.push(item);
      const ct = m.charge && data.types.get(m.charge);
      if (ct) {
        const charge = new Item(data, ct, 'charge');
        charge.module = item;
        item.charge = charge;
        charges.push(charge);
      }
    });
  }
  const drones = (fit.drones || []).map((d) => {
    const t = data.types.get(d.type);
    if (!t) return null;
    const item = new Item(data, t, 'drone');
    item.count = d.count || 1;
    item.active = Math.min(d.active || 0, item.count);
    item.ref = d;
    return item;
  }).filter(Boolean);

  const shipItems = [...modules, ...charges];       // 位于舰船上的物品
  const charItems = [...implants, ...skillItems];    // 位于角色上的物品
  const ownedItems = [...charges, ...drones];        // 「角色拥有、需要某技能」修改的对象

  const targets = (func, domain, src, extra) => {
    if (func === 0) {
      if (domain === 0) return [src];
      if (domain === 1) return [ship];
      if (domain === 2) return [char];
      if (domain === 3) return src.kind === 'module' ? (src.charge ? [src.charge] : []) : src.module ? [src.module] : [];
      return [];
    }
    const pool = func === 4 ? ownedItems : domain === 1 ? shipItems : domain === 2 ? charItems : [];
    if (func === 1) return pool;
    if (func === 2) return pool.filter((it) => it.type.group === extra);
    const skill = extra === -1 ? src.type.id : extra;
    return pool.filter((it) => it.requiresSkill(skill));
  };

  const active = (item, effect) => {
    if (item.kind === 'module') {
      const rank = STATE_RANK[item.state] || 0;
      if (effect.category === EFFECT.passive || effect.category === EFFECT.online) return rank >= 1;
      if (effect.category === EFFECT.active) return rank >= 2;
      if (effect.category === EFFECT.overload) return rank >= 3;
      return false;
    }
    if (item.kind === 'charge') {
      if (effect.category === EFFECT.passive) return (STATE_RANK[item.module.state] || 0) >= 1;
      return false;
    }
    if (item.kind === 'drone') return effect.category === EFFECT.passive;
    return effect.category === EFFECT.passive;
  };

  const all = [ship, ...modules, ...charges, ...drones, ...implants, ...skillItems];
  for (const item of all) {
    const exempt = EXEMPT.has(item.category);
    for (const eid of item.type.effects) {
      const effect = data.effects.get(eid);
      if (!effect || !active(item, effect)) continue;
      if (special(effect, item, { ship, exempt, shipItems, ownedItems })) continue;
      for (const [func, domain, modified, modifying, op, extra] of effect.mods) {
        if (op === 9) continue;
        for (const t of targets(func, domain, item, extra)) t.addMod(modified, { op, src: item, srcAttr: modifying, exempt });
      }
    }
  }
  return { data, fit, char, ship, modules, charges, drones, implants, skills: skillItems };
}

// 没有 modifierInfo 的少数效果
const MISSILE_DAMAGE_BONUS = { missileEMDmgBonus: AT.em, missileExplosiveDmgBonus: AT.explosive, missileThermalDmgBonus: AT.thermal, missileKineticDmgBonus2: AT.kinetic };

function special(effect, item, { ship, exempt, shipItems, ownedItems }) {
  const self = item.type?.id;
  switch (effect.name) {
    case 'skillEffect':
      return true;
    case 'resistanceKillerShieldArmorAll':
    case 'resistanceKillerHullAll':
      // 极化武器：抗性归零。resistanceKiller 以百分比记（100 = 抗性系数 1.0），直接赋值会得到 −9900%
      for (const [, , modified, modifying] of effect.mods) {
        ship.addMod(modified, { op: OP.postAssign, src: item, srcAttr: modifying, exempt, fn: () => { const v = item.attr(modifying); return v > 1 ? v / 100 : v; } });
      }
      return true;
    case 'missileEMDmgBonus':
    case 'missileExplosiveDmgBonus':
    case 'missileThermalDmgBonus':
    case 'missileKineticDmgBonus2':
      // 导弹技能：需要该技能的导弹伤害 +x%/级（damageMultiplierBonus 已按等级相乘）
      for (const c of ownedItems) if (c.kind === 'charge' && c.requiresSkill(self)) c.addMod(MISSILE_DAMAGE_BONUS[effect.name], { op: OP.postPercent, src: item, srcAttr: 292, exempt });
      return true;
    case 'droneDmgBonus':
      for (const d of ownedItems) if (d.kind === 'drone' && d.requiresSkill(self)) d.addMod(AT.damageMultiplier, { op: OP.postPercent, src: item, srcAttr: 292, exempt });
      return true;
    case 'selfRof':
      // 专业化技能：需要该技能的武器射速 −x%/级
      for (const m of shipItems) if (m.kind === 'module' && m.requiresSkill(self)) m.addMod(AT.speed, { op: OP.postPercent, src: item, srcAttr: 293, exempt });
      return true;
    case 'moduleBonusAfterburner':
    case 'moduleBonusMicrowarpdrive': {
      // 推进器：先加质量，再按 速度系数 × 推力 ÷ 质量 提升最大速度；微跃推进器另有信号半径膨胀
      ship.addMod(AT.mass, { op: OP.modAdd, src: item, srcAttr: AT.massAddition, exempt });
      ship.addMod(AT.maxVelocity, { op: OP.postPercent, src: item, exempt, fn: () => item.attr(AT.speedFactor) * item.attr(AT.speedBoostFactor) / ship.attr(AT.mass) });
      if (effect.name === 'moduleBonusMicrowarpdrive') ship.addMod(AT.signatureRadius, { op: OP.postPercent, src: item, srcAttr: AT.signatureRadiusBonus, exempt });
      return true;
    }
    case 'slotModifier':
      ship.addMod(AT.hiSlots, { op: OP.modAdd, src: item, srcAttr: AT.hiSlotModifier, exempt: true });
      ship.addMod(AT.medSlots, { op: OP.modAdd, src: item, srcAttr: AT.medSlotModifier, exempt: true });
      ship.addMod(AT.lowSlots, { op: OP.modAdd, src: item, srcAttr: AT.lowSlotModifier, exempt: true });
      return true;
    case 'hardPointModifierEffect':
      ship.addMod(AT.turretSlots, { op: OP.modAdd, src: item, srcAttr: AT.turretHardPointModifier, exempt: true });
      ship.addMod(AT.launcherSlots, { op: OP.modAdd, src: item, srcAttr: AT.launcherHardPointModifier, exempt: true });
      return true;
    case 'adaptiveArmorHardener':
      // 反应式装甲增强器：按初始的平均分配计算
      for (const a of RESIST.armor) ship.addMod(a, { op: OP.postMul, src: item, srcAttr: a, exempt });
      return true;
    default:
      return false;
  }
}

// ---------- 统计 ----------
const rank = (m) => STATE_RANK[m.state] || 0;
const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const avg = (list) => list.reduce((s, x) => s + x, 0) / list.length;

export function fitStats(calc, { profile = [0.25, 0.25, 0.25, 0.25] } = {}) {
  const { ship, modules, char, data } = calc;
  // 舰载机与无人机同在装配的无人机列表里，按类别分开计算；舰载机以中队计（count 中队、active 出击中队）
  const fighters = calc.drones.filter((d) => d.type.category === CAT.fighter);
  const drones = calc.drones.filter((d) => d.type.category !== CAT.fighter);
  const squad = (f) => f.attr(AT.fighterSquadronSize) || 1;
  const online = modules.filter((m) => rank(m) >= 1);
  const activeMods = modules.filter((m) => rank(m) >= 2);

  // 资源
  const slotCount = {
    high: ship.attr(AT.hiSlots), mid: ship.attr(AT.medSlots), low: ship.attr(AT.lowSlots),
    rig: ship.attr(AT.rigSlots), sub: ship.attr(AT.maxSubSystems)
  };
  const used = Object.fromEntries(SLOTS.map((s) => [s, modules.filter((m) => m.slot === s).length]));
  const resources = {
    cpu: { used: sum(online, (m) => m.attr(AT.cpu)), total: ship.attr(AT.cpuOutput) },
    power: { used: sum(online, (m) => m.attr(AT.power)), total: ship.attr(AT.powerOutput) },
    calibration: { used: sum(modules.filter((m) => m.slot === 'rig'), (m) => m.attr(AT.upgradeCost)), total: ship.attr(AT.upgradeCapacity) },
    turrets: { used: modules.filter((m) => m.type.turret).length, total: ship.attr(AT.turretSlots) },
    launchers: { used: modules.filter((m) => m.type.launcher).length, total: ship.attr(AT.launcherSlots) },
    droneBay: { used: sum(drones, (d) => d.attr(AT.volume) * d.count), total: ship.attr(AT.droneCapacity) },
    bandwidth: { used: sum(drones, (d) => d.attr(AT.droneBandwidthUsed) * d.active), total: ship.attr(AT.droneBandwidth) },
    activeDrones: { used: sum(drones, (d) => d.active), total: char.attr(AT.maxActiveDrones) },
    fighterBay: { used: sum(fighters, (f) => f.attr(AT.volume) * squad(f) * f.count), total: ship.attr(AT.fighterCapacity) },
    fighterTubes: { used: sum(fighters, (f) => f.active), total: ship.attr(AT.fighterTubes) },
    fighterLight: { used: sum(fighters.filter((f) => f.attr(AT.fighterIsLight)), (f) => f.active), total: ship.attr(AT.fighterLightSlots) },
    fighterSupport: { used: sum(fighters.filter((f) => f.attr(AT.fighterIsSupport)), (f) => f.active), total: ship.attr(AT.fighterSupportSlots) },
    fighterHeavy: { used: sum(fighters.filter((f) => f.attr(AT.fighterIsHeavy)), (f) => f.active), total: ship.attr(AT.fighterHeavySlots) }
  };

  // 火力
  const missileMult = char.attr(AT.missileDamageMultiplier);
  const weapon = { turret: 0, missile: 0, drone: 0, fighter: 0, volley: 0, types: [0, 0, 0, 0] };
  const weapons = [];
  const droneDps = [];
  for (const m of activeMods) {
    if (!(m.type.turret || m.type.launcher) || !m.charge) continue;
    const mult = m.type.turret ? m.attr(AT.damageMultiplier) : missileMult;
    const dmg = DAMAGE.map((a) => m.charge.attr(a) * mult);
    const volley = dmg.reduce((s, x) => s + x, 0);
    const cycle = m.attr(AT.speed) / 1000;
    if (!cycle || !volley) continue;
    const dps = volley / cycle;
    weapon[m.type.turret ? 'turret' : 'missile'] += dps;
    weapon.volley += volley;
    dmg.forEach((x, i) => { weapon.types[i] += x / cycle; });
    weapons.push({
      module: m, dps, volley,
      range: m.type.turret ? m.attr(AT.maxRange) : m.charge.attr(AT.maxVelocity) * m.charge.attr(AT.explosionDelay) / 1000,
      falloff: m.type.turret ? m.attr(AT.falloff) : 0
    });
  }
  for (const d of drones) {
    if (!d.active) continue;
    const dmg = DAMAGE.map((a) => d.attr(a) * d.attr(AT.damageMultiplier));
    const volley = dmg.reduce((s, x) => s + x, 0);
    const cycle = d.attr(AT.speed) / 1000;
    if (!cycle || !volley) continue;
    weapon.drone += volley / cycle * d.active;
    droneDps.push({ drone: d, dps: volley / cycle * d.active });
    dmg.forEach((x, i) => { weapon.types[i] += x / cycle * d.active; });
  }
  // 舰载机：普通攻击 + 导弹技能，按中队规模与出击中队数计
  for (const f of fighters) {
    if (!f.active) continue;
    const n = squad(f) * f.active;
    for (const [dmgAttrs, multAttr, durAttr] of [[AT.fighterAttackDmg, AT.fighterAttackMult, AT.fighterAttackDuration], [AT.fighterMissileDmg, AT.fighterMissileMult, AT.fighterMissileDuration]]) {
      const cycle = f.attr(durAttr) / 1000;
      if (!cycle) continue;
      const mult = f.attr(multAttr) || 1;
      const dmg = dmgAttrs.map((a) => f.attr(a) * mult);
      if (!dmg.some(Boolean)) continue;
      weapon.fighter += dmg.reduce((t, x) => t + x, 0) / cycle * n;
      dmg.forEach((x, i) => { weapon.types[i] += x / cycle * n; });
    }
  }
  weapon.total = weapon.turret + weapon.missile + weapon.drone + weapon.fighter;

  // 防御
  const layer = (hpAttr, res) => {
    const hp = ship.attr(hpAttr);
    const resonance = res.map((a) => ship.attr(a));
    const mean = resonance.reduce((s, r, i) => s + r * profile[i], 0);
    return { hp, resist: resonance.map((r) => 1 - r), ehp: mean > 0 ? hp / mean : hp, mean };
  };
  const shield = layer(AT.shieldCapacity, RESIST.shield);
  const armor = layer(AT.armorHP, RESIST.armor);
  const hull = layer(AT.hp, RESIST.hull);
  const shieldRechargeSec = ship.attr(AT.shieldRecharge) / 1000;
  const passiveRegen = shieldRechargeSec ? 2.5 * shield.hp / shieldRechargeSec : 0;
  const reps = { shield: 0, armor: 0, hull: 0 };
  for (const m of activeMods) {
    const dur = m.attr(AT.duration) / 1000;
    if (!dur) continue;
    const names = m.type.effects.map((e) => data.effects.get(e)?.name);
    if (names.includes('shieldBoosting') || names.includes('fueledShieldBoosting')) reps.shield += m.attr(AT.shieldBonus) / dur;
    if (names.includes('armorRepair')) reps.armor += m.attr(AT.armorDamageAmount) / dur;
    if (names.includes('fueledArmorRepair')) reps.armor += m.attr(AT.armorDamageAmount) * (m.charge ? m.attr(AT.chargedArmorDamageMultiplier) || 1 : 1) / dur;
    if (names.includes('structureRepair')) reps.hull += m.attr(AT.structureDamageAmount) / dur;
  }
  const defense = {
    shield, armor, hull,
    ehp: shield.ehp + armor.ehp + hull.ehp,
    passiveRegen, passiveRegenEhp: shield.mean ? passiveRegen / shield.mean : passiveRegen,
    reps, repsEhp: {
      shield: shield.mean ? reps.shield / shield.mean : 0,
      armor: armor.mean ? reps.armor / armor.mean : 0,
      hull: hull.mean ? reps.hull / hull.mean : 0
    }
  };

  // 电容
  const capacity = ship.attr(AT.capCapacity);
  const tau = ship.attr(AT.capRecharge) / 1000;
  let usage = 0;
  for (const m of activeMods) {
    const need = m.attr(AT.capNeed);
    const cycle = (m.attr(AT.duration) || m.attr(AT.speed)) / 1000;
    if (need && cycle) usage += need / cycle;
    // 电容注入器：装填后按每个周期注入的电容计
    if (m.charge && m.type.effects.some((e) => data.effects.get(e)?.name === 'powerBooster') && cycle) usage -= m.charge.attr(AT.capacitorBonus) / cycle;
  }
  const capacitor = { capacity, recharge: tau, peak: tau ? 2.5 * capacity / tau : 0, usage, ...capStability(capacity, tau, usage) };

  // 机动与锁定
  const mass = ship.attr(AT.mass), agility = ship.attr(AT.agility);
  const navigation = {
    velocity: ship.attr(AT.maxVelocity), mass, agility,
    align: Math.log(4) * agility * mass / 1e6,
    warp: ship.attr(AT.warpSpeedMultiplier) * (ship.attr(AT.baseWarpSpeed) || 1),
    signature: ship.attr(AT.signatureRadius)
  };
  const sensorValues = AT.sensors.map((a) => ship.attr(a));
  const sensorIdx = sensorValues.indexOf(Math.max(...sensorValues));
  const targeting = {
    range: ship.attr(AT.maxTargetRange), scanRes: ship.attr(AT.scanResolution),
    maxTargets: Math.min(ship.attr(AT.maxLockedTargets), char.attr(AT.maxLockedTargets)),
    sensor: sensorValues[sensorIdx], sensorType: ['雷达', '光雷达', '磁力', '引力'][sensorIdx]
  };

  return {
    slots: slotCount, used, resources, weapon, weapons, droneDps, defense, capacitor, navigation, targeting,
    cargo: ship.attr(AT.capacity), problems: problems(calc, slotCount, used, resources)
  };
}

// 电容是否稳定：充能速率 = 10C/τ × (√(c/C) − c/C)，峰值在 25% 处
// ---------- 对目标的有效 DPS ----------
// 典型目标：信号半径（m）与环绕速度（m/s，按全部为横向速度计）
export const TARGETS = {
  frigate: { name: '护卫舰 / 驱逐舰', sig: 40, vel: 400 },
  cruiser: { name: '巡洋舰 / 战列巡洋舰', sig: 140, vel: 230 },
  battleship: { name: '战列舰', sig: 400, vel: 110 },
  capital: { name: '旗舰 / 建筑', sig: 3000, vel: 40 }
};
// 炮台命中后的平均伤害倍数（含 1% 的 3 倍暴击）
function turretMult(chance) {
  const wreck = Math.min(chance, 0.01);
  const normal = chance - wreck;
  return wreck * 3 + (normal > 0 ? normal * ((0.01 + chance) / 2 + 0.49) : 0);
}
// 炮台：命中率 = 0.5^((角速度 × 信号分辨率 / (跟踪 × 目标信号))² + (max(0, 距离 − 最佳射程) / 失准范围)²)
// 导弹：伤害比例 = min(1, 目标信号 / 爆炸半径, (目标信号 / 爆炸半径 × 爆炸速度 / 目标速度)^爆炸衰减系数)，飞行距离不到则为 0
// target 为 null 表示不看体型；distance 为 0 表示不看距离（炮台按在最佳射程处算跟踪）。舰载机按满伤害计
export function appliedDps(stats, target = null, distance = 0) {
  let total = stats.weapon.fighter;
  // 无人机：会飞的按信号比例（目标信号 / 无人机信号分辨率）和追不追得上算；岗哨（不会动）按炮台公式算
  for (const { drone: d, dps } of stats.droneDps || []) {
    let f = 1;
    const sigRes = d.attr(620) || 0, vel = d.attr(AT.maxVelocity);
    if (vel < 1) {
      const optimal = d.attr(AT.maxRange), falloff = Math.max(1, d.attr(AT.falloff));
      const dist = distance || optimal;
      let exp = (Math.max(0, dist - optimal) / falloff) ** 2;
      if (target && d.attr(AT.trackingSpeed) > 0) exp += ((target.vel / dist) * sigRes / (d.attr(AT.trackingSpeed) * target.sig)) ** 2;
      f = Math.min(1, turretMult(0.5 ** exp));
    } else if (target) {
      f = Math.min(1, sigRes ? target.sig / sigRes : 1) * Math.min(1, vel / Math.max(1, target.vel));
    }
    total += dps * f;
  }
  for (const w of stats.weapons) {
    const m = w.module;
    let f = 1;
    if (m.type.turret) {
      const optimal = m.attr(AT.maxRange), falloff = Math.max(1, m.attr(AT.falloff));
      let exp = distance ? (Math.max(0, distance - optimal) / falloff) ** 2 : 0;
      if (target) {
        const d = distance || Math.max(optimal, 1000);
        const tracking = m.attr(AT.trackingSpeed);
        exp += tracking > 0 ? ((target.vel / d) * (m.attr(620) || 40000) / (tracking * target.sig)) ** 2 : 0;
      }
      f = Math.min(1, turretMult(0.5 ** exp));   // 暴击带来的 1.5% 不计，避免有效 DPS 高于纸面
    } else {
      if (distance && w.range < distance) f = 0;
      else if (target && m.charge) {
        const er = m.charge.attr(654), ev = m.charge.attr(653), drf = m.charge.attr(1353) || 1;
        if (er > 0) f = Math.min(1, target.sig / er, target.vel > 0 && ev > 0 ? ((target.sig / er) * (ev / target.vel)) ** drf : 1);
      }
    }
    total += w.dps * f;
  }
  return total;
}

function capStability(C, tau, usage) {
  if (usage <= 0 || !C) return { stable: true, level: 1 };
  if (!tau) return { stable: false, lasts: C / usage };
  const k = usage * tau / (10 * C);
  if (k <= 0.25) {
    const x = (1 + Math.sqrt(1 - 4 * k)) / 2;
    return { stable: true, level: x * x };
  }
  // 不稳定：从满电容按 1 秒步长模拟到耗尽
  let c = C, t = 0;
  while (c > 0 && t < 36000) {
    const r = c / C;
    c += (10 * C / tau) * (Math.sqrt(r) - r) - usage;
    t += 1;
  }
  return { stable: false, lasts: t };
}

// ---------- 装配检查 ----------
function problems(calc, slotCount, used, res) {
  const { ship, modules, data } = calc;
  const out = [];
  const shipType = ship.type;
  for (const s of SLOTS) if (used[s] > slotCount[s]) out.push({ level: 'error', text: `${SLOT_NAME[s]}超出 ${used[s] - slotCount[s]} 个` });
  if (res.cpu.used > res.cpu.total + 1e-6) out.push({ level: 'error', text: `CPU 超出 ${(res.cpu.used - res.cpu.total).toFixed(1)} tf` });
  if (res.power.used > res.power.total + 1e-6) out.push({ level: 'error', text: `能量栅格超出 ${(res.power.used - res.power.total).toFixed(1)} MW` });
  if (res.calibration.used > res.calibration.total) out.push({ level: 'error', text: `校准值超出 ${res.calibration.used - res.calibration.total}` });
  if (res.turrets.used > res.turrets.total) out.push({ level: 'error', text: `炮台安装座不足（${res.turrets.used} / ${res.turrets.total}）` });
  if (res.launchers.used > res.launchers.total) out.push({ level: 'error', text: `发射器安装座不足（${res.launchers.used} / ${res.launchers.total}）` });
  if (res.droneBay.used > res.droneBay.total) out.push({ level: 'error', text: '无人机挂舱容量不足' });
  if (res.bandwidth.used > res.bandwidth.total) out.push({ level: 'error', text: '无人机带宽不足' });
  if (res.activeDrones.used > res.activeDrones.total) out.push({ level: 'warn', text: `同时操作的无人机超过上限 ${res.activeDrones.total} 架` });
  if (res.fighterBay.used > res.fighterBay.total + 1e-6) out.push({ level: 'error', text: '舰载机机库容量不足' });
  if (res.fighterTubes.used > res.fighterTubes.total) out.push({ level: 'error', text: `出击中队超过发射管数 ${res.fighterTubes.total}` });
  for (const [k, label] of [['fighterLight', '轻型'], ['fighterSupport', '支援'], ['fighterHeavy', '重型']]) {
    if (res[k].used > res[k].total) out.push({ level: 'error', text: `${label}舰载机中队超过上限 ${res[k].total}` });
  }
  const groupCount = new Map(), typeCount = new Map(), activeGroup = new Map();
  for (const m of modules) {
    const t = m.type;
    groupCount.set(t.group, (groupCount.get(t.group) || 0) + 1);
    typeCount.set(t.id, (typeCount.get(t.id) || 0) + 1);
    if (rank(m) >= 2) activeGroup.set(t.group, (activeGroup.get(t.group) || 0) + 1);
    const why = cannotFit(data, shipType, t, ship);
    if (why) out.push({ level: 'error', text: `${t.name}：${why}`, module: m });
  }
  const seen = new Set();
  for (const m of modules) {
    const t = m.type;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    // 用计算后的值：指挥舰等会提高同组可激活数量
    const maxGroup = m.attr(AT.maxGroupFitted), maxType = m.attr(AT.maxTypeFitted), maxActive = m.attr(AT.maxGroupActive);
    if (maxGroup && groupCount.get(t.group) > maxGroup) out.push({ level: 'error', text: `${data.groups.get(t.group)?.name || t.name} 最多装配 ${maxGroup} 个` });
    if (maxType && typeCount.get(t.id) > maxType) out.push({ level: 'error', text: `${t.name} 最多装配 ${maxType} 个` });
    if (maxActive && activeGroup.get(t.group) > maxActive) out.push({ level: 'warn', text: `${data.groups.get(t.group)?.name || t.name} 同时只能激活 ${maxActive} 个` });
  }
  return out;
}

export const SLOT_NAME = { high: '高槽', mid: '中槽', low: '低槽', rig: '改装件', sub: '子系统' };

// 装备能否装到这艘船上（不检查资源）；返回原因或 null
export function cannotFit(data, shipType, t, ship = null) {
  if (!t.slot) return '不是可装配的装备';
  if (t.slot === 'rig') {
    const need = t.attrs.get(AT.rigSize), have = ship ? ship.attr(AT.rigSize) : shipType.attrs.get(AT.rigSize);
    if (need && have && need !== have) return '改装件尺寸与舰船不符';
  }
  if (t.slot === 'sub') {
    const fits = t.attrs.get(AT.fitsToShipType);
    if (fits && fits !== shipType.id) return '只能装配在 ' + (data.types.get(fits)?.name || '指定舰船') + ' 上';
  }
  const groups = AT.canFitShipGroup.map((a) => t.attrs.get(a)).filter(Boolean);
  const types = AT.canFitShipType.map((a) => t.attrs.get(a)).filter(Boolean);
  if ((groups.length || types.length) && !groups.includes(shipType.group) && !types.includes(shipType.id)) return '不能装配在这类舰船上';
  return null;
}

// 弹药能否装进装备
export function chargeFits(module, charge) {
  const groups = AT.chargeGroups.map((a) => module.attrs.get(a)).filter(Boolean);
  if (!groups.includes(charge.group)) return false;
  const size = module.attrs.get(AT.chargeSize);
  return !size || !charge.attrs.get(AT.chargeSize) || size === charge.attrs.get(AT.chargeSize);
}

// 装备当前能装的弹药数量
export function chargeCount(moduleType, chargeType) {
  const cap = moduleType.attrs.get(AT.capacity) || 0, vol = chargeType.attrs.get(AT.volume) || 0;
  return vol ? Math.max(1, Math.floor(cap / vol + 1e-9)) : 1;
}

// 装配用到的技能是否满足（返回 [{ type, need, have }]）
export function missingSkills(data, fit, levels) {
  const need = new Map();
  const visit = (t) => {
    for (const [s, l] of t.skills) {
      if ((need.get(s) || 0) < l) need.set(s, l);
      const st = data.types.get(s);
      if (st && !visit.seen.has(s)) { visit.seen.add(s); visit(st); }
    }
  };
  visit.seen = new Set();
  const ids = [fit.ship, ...SLOTS.flatMap((s) => (fit.slots?.[s] || []).flatMap((m) => (m ? [m.type, m.charge] : []))),
    ...(fit.drones || []).map((d) => d.type), ...(fit.implants || [])].filter(Boolean);
  for (const id of ids) { const t = data.types.get(id); if (t) visit(t); }
  return [...need].filter(([s, l]) => (levels.get(s) || 0) < l).map(([s, l]) => ({ type: data.types.get(s), need: l, have: levels.get(s) || 0 }));
}

export { STATE_RANK };
