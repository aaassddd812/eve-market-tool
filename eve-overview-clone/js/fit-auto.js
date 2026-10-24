// ===== 智能装配 =====
// 按目标（输出 / 坦克 / 均衡 / 刷怪主动坦 / 风筝）与约束（最低 DPS、EHP、速度、电容稳定、预算、装备等级、技能）自动搜索装配。
// 打分完全交给装配引擎（computeFit + fitStats，与游戏规则一致），搜索流程：
//   1. 候选：按船、装备等级、技能、预算筛选；同一族（分组 + 尺寸）只留「允许范围内最好的」与「最省 CPU / 电网的」两档
//   2. 武器：逐个试装满安装座（配最高伤害弹药），取 DPS 最高的两种方案；有无人机挂舱时同时装上最好的无人机
//   3. 贪心：中 / 低 / 改装件轮流放入让得分提升最多、且资源装得下的装备；装不下时尝试加 CPU / 电网辅助装备后再填
//   4. 替换：逐格尝试换成其他候选，直到不再变好
// 技能：全 5 级，或按 ESI 角色（候选只保留角色能用的装备与弹药，属性按角色技能计算）。
// 植入体：智能装配可勾选「同时推荐植入体」；装配页「智能植入体」只给当前装配推荐植入体（装备不动），见下方「植入体」一节。
let ctx;   // data, FE, getFit, applyFit, esiLevels, prices, esc, formatNumber, formatISK, showToast, store
const $ = (id) => document.getElementById(id);
const KEY = 'eve-fit-auto-v1';
const IMG = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

const GOALS = [
  ['dps', '输出优先', '尽量高的 DPS，剩余槽位补坦克'],
  ['tank', '坦克优先', '尽量高的有效血量'],
  ['balanced', '均衡', '输出与坦克兼顾'],
  ['pve', '刷怪主动坦', '主动维修 / 回充，电容稳定'],
  ['kite', '风筝', '速度优先，保留输出']
];
// 装备等级逐级放宽：T1 → T2 → 势力（含故事线）→ 死亡空间 → 官员
const METAS = { t1: [0, 1], t2: [0, 1, 2], faction: [0, 1, 2, 3, 4], deadspace: [0, 1, 2, 3, 4, 6], officer: [0, 1, 2, 3, 4, 5, 6] };
// 参与搜索的装备分组（其余如扫描、采矿、电子战等不影响打分的不参与）
const GROUPS = {
  // 护盾：扩展、强化、增效、回充增量、辅助回充、回充增量放大器、弯曲强化、回充设备；信号半径抑制
  mid: { shield: [38, 77, 295, 40, 1156, 338, 1700, 39], any: [61, 43, 46, 76, 212, 213, 1396, 644, 646, 1154] },
  // 装甲：附甲、薄膜、强化、维修、弯曲强化；护盾能源继电器；加强型舱隔壁、铁骑舰载机辅助单元
  low: { armor: [329, 326, 328, 98, 62, 1150, 1199, 1699], shield: [57], any: [60, 59, 205, 302, 367, 645, 1988, 4067, 766, 763, 764, 767, 768, 770, 211, 1395, 1292, 78, 407] },
  rig: { shield: [774], armor: [773], any: [775, 776, 777, 778, 779, 781, 782] }
};
// 抗性与自修：主动抗（需激活的强化 / 增强器）与被动抗（增效器、薄膜 / 附甲），自修（回充增量器 / 维修组件）
const RESIST_GROUPS = { shield: { active: [77, 1700], passive: [295] }, armor: { active: [328, 1150, 1699], passive: [326, 98] } };
const REP_GROUPS = [40, 1156, 62, 1199, 338];
const FITTING = { cpu: [285], power: [769], rigCpuPower: [781] };   // CPU 增强设备、反应堆控制元件、改装件核心
const TACKLE = [52, 65];   // 扰频器、停滞网（PVP 预留）
// 武器改装件只配对应的武器：能量 775 / 混合 776 / 射弹 777 / 发射器 779；无人机改装件 778
const WEAPON_RIG = { 53: 775, 74: 776, 55: 777 };
const RIG_EXCLUDE = /Cargohold|Fuel|Thermal Shielding|Hyperspatial|Warp|Salvage|Signal|Targeting|Ionic|Gravity|Memetic|Particle|Inverted|Emission Scope|Sharpener|Anchor|Drone Control Range|Drone Durability|Drone Speed|Drone Mining|Repair Augmentor|Sentry|Stasis|Remote|Projector|Ancillary Current Router|Processor Overclocking/i;
const PROP = 46;

// 舰船定位：由舰船加成（效果作用的装备分组 / 技能）与舰船分组识别，先放好定位装备再按目标填其余槽位
const REMOTE_REP = [41, 325, 1697, 1698, 2018, 585];   // 远程护盾 / 装甲 / 船体维修
const REMOTE_CAP = [67];
const EWAR = [201, 208, 291, 379];                      // ECM、感应抑阻、武器扰断、目标标记
const TACKLE_BONUS = [52, 65, 899];                     // 跃迁扰乱 / 停滞网 / 扰断力场
const MINING = { ore: [54, 464, 483], ice: [54, 464], gas: [4138] };
const MINING_ALL = [54, 464, 483, 4138];
const MINING_UPGRADE = 546;
const SIEGE = 515, BURST = 1770, CLOAK = 330, BUBBLE = 589, CARGO_EXP = 765;
const NEUT = [71, 68];
const HAULER_GROUPS = [28, 380, 1202, 513, 902];        // 运载舰、运输舰、封锁突破舰、货舰、跳跃货舰
const INTERDICTOR = 541;
const ROLE_NAME = { logi: '后勤', ewar: '电子战', tackle: '拦截', mining: '采矿', command: '指挥', hauler: '运输', neut: '能量战', covert: '隐形' };
const ATTR_ZH = { 38: '货柜容量', 263: '护盾容量', 265: '装甲值', 9: '结构值', 37: '速度', 70: '敏捷', 600: '跃迁速度', 552: '信号半径', 479: '护盾回充', 482: '电容容量', 55: '电容回充', 76: '锁定距离' };
const SHIELD_SELF = [263, 479, 271, 272, 273, 274], ARMOR_SELF = [265, 267, 268, 269, 270];

const A = { goal: 'dps', tank: 'auto', resist: 'auto', selfRep: 'auto', weapon: 'auto', meta: 't2', budget: 0, minDps: 0, minEhp: 0, minSpeed: 0, capStable: false, tackle: false, skills: 'max', role: 'auto', mineTarget: 'ore', target: 'any', range: 'any', implants: false, impBudget: 500 };
// 交战距离（米），0 为不看距离
const RANGES = { any: 0, close: 5000, mid: 20000, long: 50000, xlong: 100000 };
const S = { running: false, cancel: false, results: [] };

export function initAutoFit(context) {
  ctx = context;
  Object.assign(A, ctx.store.getJSON(KEY, {}) || {});
  if (!METAS[A.meta]) A.meta = A.meta === 'all' ? 'officer' : 't2';
}

// ---------- 舰船加成与定位 ----------
// 读出舰船自身效果里加成值不为 0 的修改：作用于某分组 / 需要某技能的装备，或舰船自身属性
const profileCache = new Map();
export function shipProfile(shipType) {
  if (profileCache.has(shipType.id)) return profileCache.get(shipType.id);
  const { data, FE } = ctx;
  const byGroup = new Map(), bySkill = new Map(), self = new Set(), labels = new Set();
  for (const eid of shipType.effects) {
    const ef = data.effects.get(eid);
    if (!ef) continue;
    for (const [func, domain, modified, src, , extra] of ef.mods) {
      if (!shipType.attrs.get(src)) continue;
      const add = (map, k) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(modified); };
      if (func === 0 && domain === 1) { self.add(modified); if (ATTR_ZH[modified]) labels.add(ATTR_ZH[modified]); }
      else if (func === 2 && domain === 1) { add(byGroup, extra); labels.add(data.groups.get(extra)?.name || ''); }
      else if (func === 3 || func === 4) { add(bySkill, extra); labels.add(data.types.get(extra)?.name || ''); }
    }
  }
  // 某件装备受到的舰船加成（被修改的属性集合）
  const bonusOf = (t) => {
    const out = new Set(byGroup.get(t.group) || []);
    for (const [s] of t.skills) for (const a of bySkill.get(s) || []) out.add(a);
    return out;
  };
  const bonused = new Set();   // 受加成的装备分组
  for (const t of data.types.values()) if (t.market && t.slot && t.slot !== 'rig' && t.slot !== 'sub' && !bonused.has(t.group) && bonusOf(t).size) bonused.add(t.group);
  const has = (groups) => groups.some((g) => bonused.has(g));
  const warfare = data.attrs.has(2469) ? 2469 : 0;
  const roles = [];
  if (has(REMOTE_REP)) roles.push('logi');
  if (has(EWAR)) roles.push('ewar');
  if (has(TACKLE_BONUS) || shipType.group === INTERDICTOR) roles.push('tackle');
  if (has(MINING_ALL)) roles.push('mining');
  if ([...data.types.values()].some((t) => t.group === BURST && t.market && [...bonusOf(t)].includes(warfare))) roles.push('command');
  if (self.has(FE.AT.capacity) || HAULER_GROUPS.includes(shipType.group)) roles.push('hauler');
  if (has(NEUT)) roles.push('neut');
  const covertCloak = [...data.types.values()].find((t) => t.group === CLOAK && t.market && /Covert Ops/i.test(t.en || '') && !FE.cannotFit(data, shipType, t));
  if (covertCloak) roles.push('covert');
  // 坦克倾向：加成作用在护盾 / 装甲（自身抗性、血量，或回充 / 维修装备）
  const shieldRep = has([40, 1156]), armorRep = has([62, 1199]);
  const shieldPts = SHIELD_SELF.filter((a) => self.has(a)).length + (shieldRep ? 3 : 0) + (bonused.has(38) ? 2 : 0);
  const armorPts = ARMOR_SELF.filter((a) => self.has(a)).length + (armorRep ? 3 : 0) + (bonused.has(329) ? 2 : 0);
  const p = {
    roles, bonused, bonusOf, covertCloak,
    tank: shieldPts > armorPts ? 'shield' : armorPts > shieldPts ? 'armor' : null,
    rep: shieldRep || armorRep,
    labels: [...labels].filter(Boolean).slice(0, 12)
  };
  profileCache.set(shipType.id, p);
  return p;
}

// 自动坦克类型：先看舰船加成，没有再按护盾 / 装甲值与中低槽数（战略巡洋舰按当前子系统）
function autoTank(shipType) {
  const P = shipProfile(shipType);
  if (P.tank) return { tank: P.tank, why: '舰船加成' };
  const sub = (ctx.getFit().slots.sub || []).filter(Boolean);
  const calc = ctx.FE.computeFit(ctx.data, { ship: shipType.id, slots: { high: [], mid: [], low: [], rig: [], sub }, drones: [], implants: [] }, 'max');
  if (!calc) return { tank: 'shield', why: '' };
  const st = ctx.FE.fitStats(calc);
  const ratio = (st.defense.shield.hp / Math.max(1, st.defense.armor.hp)) * ((st.slots.mid || 1) / Math.max(1, st.slots.low || 1));
  return { tank: ratio >= 1 ? 'shield' : 'armor', why: '护盾 / 装甲值与中低槽数' };
}

// ---------- 打分 ----------
function skillsArg() { return A.skills === 'esi' && ctx.esiLevels() ? ctx.esiLevels() : 'max'; }
const ln = (x) => Math.log(Math.max(0, x) + 1);
let ROLES = new Set();   // 当前搜索生效的定位
let TGT = null, DIST = 0;   // 当前搜索的目标体型与交战距离
let SELF_REP = 'auto';   // 当前搜索的自修设定（自动时有维修加成的船按自修）

// 定位指标：远程维修量（HP/秒）、采矿量（m³/秒）
function roleMetrics(calc) {
  let remote = 0, mining = 0;
  for (const m of calc.modules) {
    if ((ctx.FE.STATE_RANK[m.state] || 0) < 2) continue;
    const dur = m.attr(ctx.FE.AT.duration) / 1000;
    if (!dur) continue;
    const g = m.type.group;
    if (REMOTE_REP.includes(g)) remote += (m.attr(68) || m.attr(84) || m.attr(83)) / dur;
    else if (MINING_ALL.includes(g)) mining += m.attr(77) / dur;
  }
  return { remote, mining };
}

function price(fit) {
  const p = (id) => ctx.prices()?.get(id) || 0;
  let total = 0;
  for (const s of ctx.FE.SLOTS) for (const m of fit.slots[s]) if (m) total += p(m.type);
  for (const d of fit.drones) total += p(d.type) * d.count;
  return total;
}

function evaluate(fit) {
  const { FE, data } = ctx;
  const calc = FE.computeFit(data, fit, skillsArg());
  if (!calc) return null;
  const st = FE.fitStats(calc);
  // 资源超出、槽位 / 安装座不足、同组只能装 / 激活一个等都算装不下
  const ok = !st.problems.some((p) => p.level === 'error' || p.text.includes('同时只能激活'));
  // 选了目标体型或交战距离时，输出按对目标的有效 DPS 计（跟踪、信号分辨率、射程、导弹爆炸半径 / 速度）
  const paper = st.weapon.total, ehp = st.defense.ehp, speed = st.navigation.velocity;
  const dps = TGT || DIST ? FE.appliedDps(st, TGT, DIST) : paper;
  const active = st.defense.repsEhp.shield + st.defense.repsEhp.armor + st.defense.repsEhp.hull + st.defense.passiveRegenEhp;
  // 次要项：武器射程、锁定距离、电容续航（权重很小，只在主要指标相同时让索敌 / 电容类装备有用武之地）
  const range = st.weapons.length ? st.weapons.reduce((t, w) => t + w.range + w.falloff, 0) / st.weapons.length / 1000 : 0;
  const capTerm = st.capacitor.stable ? 1 + st.capacitor.level : Math.min(1, (st.capacitor.lasts || 0) / 600);
  const extra = 0.03 * ln(range) + 0.01 * ln(st.targeting.range / 1000) + 0.03 * capTerm;
  const { remote, mining } = roleMetrics(calc);
  const cargo = st.cargo || 0;
  let score;
  // 后勤 / 采矿 / 运输：以本职指标为主，其余兼顾坦克
  if (ROLES.has('logi')) score = ln(remote) + 0.4 * ln(ehp) + 0.05 * ln(speed);
  else if (ROLES.has('mining')) score = ln(mining * 100) + 0.3 * ln(ehp) + 0.05 * ln(speed);
  else if (ROLES.has('hauler')) score = ln(cargo) + 0.3 * ln(ehp) + 0.1 * ln(speed) - 0.1 * ln(st.navigation.align);
  else if (A.goal === 'tank') score = ln(ehp) + 0.15 * ln(dps) + 0.05 * ln(speed);
  else if (A.goal === 'balanced') score = ln(dps) + ln(ehp) + 0.05 * ln(speed);
  else if (A.goal === 'pve') score = ln(dps) + ln(active) + 0.2 * ln(ehp);
  else if (A.goal === 'kite') score = ln(dps) + 1.2 * ln(speed) + 0.2 * ln(ehp);
  else score = ln(dps) + 0.15 * ln(ehp) + 0.05 * ln(speed);
  // 约束：不满足时大幅扣分（差得越多扣得越多）
  const short = (v, min) => (min > 0 && v < min ? 2 + 5 * (1 - v / min) : 0);
  let penalty = short(dps, A.minDps) + short(ehp, A.minEhp) + short(speed, A.minSpeed);
  // 要求自修：维修量计入得分，没有维修装备时扣分
  const reps = st.defense.reps.shield + st.defense.reps.armor;
  if (SELF_REP === 'yes') { score += 0.5 * ln(active); if (!reps) penalty += 2; }
  if ((A.capStable || A.goal === 'pve' || ROLES.has('logi')) && !st.capacitor.stable) penalty += 2 + 3 * (1 - Math.min(1, (st.capacitor.lasts || 0) / 900));
  const cost = price(fit);
  if (A.budget > 0 && cost > A.budget * 1e6) penalty += 2 + 5 * (cost / (A.budget * 1e6) - 1);
  // 极小的价格项：效果相同的组合取便宜的，不影响实际效果的比较
  const thrift = 1e-5 * ln(cost / 1e6);
  return { st, ok, score: score + extra - penalty - thrift, met: penalty === 0, cost, dps, paper, ehp, speed, active, remote, mining, cargo, align: st.navigation.align };
}

// ---------- 候选 ----------
function buildCandidates(shipType, tankType, resistMode = 'active') {
  const { FE, data } = ctx;
  const metas = METAS[A.meta] || METAS.t2;
  const levels = A.skills === 'esi' ? ctx.esiLevels() : null;
  const prices = ctx.prices() || new Map();
  const budget = A.budget > 0 ? A.budget * 1e6 : Infinity;
  const usable = (t) => t.market && metas.includes(t.meta ?? 1) && (prices.get(t.id) || 0) <= budget &&
    (!levels || t.skills.every(([s, l]) => (levels.get(s) || 0) >= l));
  const fits = (t) => usable(t) && !FE.cannotFit(data, shipType, t);
  // 同分组、属性完全相同的（如各势力同款装备、同款弹药）只留最便宜的；没有价格的排在后面
  const all = sameStatsCheapest([...data.types.values()].filter(usable), prices);
  const metaRank = (t) => ({ 2: 50, 6: 60, 5: 70, 4: 40, 3: 30 }[t.meta] || 10);
  const quality = (t) => (prices.get(t.id) || 0) + metaRank(t);
  const fitCost = (t) => (t.attrs.get(FE.AT.cpu) || 0) + (t.attrs.get(FE.AT.power) || 0) * 2;
  // 同一族：分组 + 尺寸（按电网需求的数量级）；改装件按英文名去掉 I / II
  const family = (t) => (t.slot === 'rig' ? 'r:' + (t.en || t.name).replace(/\s+I{1,2}$/, '') : t.group + ':' + Math.round(Math.log2((t.attrs.get(FE.AT.power) || 0) + 1)));
  const shipPower = shipType.attrs.get(FE.AT.powerOutput) || 1;
  const power = (t) => t.attrs.get(FE.AT.power) || 0;
  const prune = (list, sizes = 2) => {
    const fam = new Map();
    for (const t of list) { const k = family(t); if (!fam.has(k)) fam.set(k, []); fam.get(k).push(t); }
    // 同一分组只留电网需求最大、且不超过舰船电网 60% 的几档尺寸（中型船不再试小号装备）
    const byGroup = new Map();
    for (const vs of fam.values()) {
      const g = vs[0].slot === 'rig' ? 'r:' + family(vs[0]) : vs[0].group;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(vs);
    }
    const out = [];
    for (const fams of byGroup.values()) {
      const sized = fams.map((vs) => ({ vs, p: Math.max(...vs.map(power)) })).filter((x) => x.p <= shipPower * 0.6 || x.p === 0)
        .sort((a, b) => b.p - a.p).slice(0, sizes);
      for (const { vs } of sized) {
        const best = vs.reduce((a, b) => (quality(b) > quality(a) ? b : a));
        const cheap = vs.reduce((a, b) => (fitCost(b) < fitCost(a) ? b : a));
        out.push(best);
        if (cheap !== best && fitCost(cheap) < fitCost(best) * 0.7) out.push(cheap);
      }
    }
    return out;
  };
  const bySlot = {};
  for (const slot of ['mid', 'low', 'rig']) {
    const g = GROUPS[slot];
    const groups = new Set([...(g.any || []), ...(tankType !== 'armor' ? g.shield || [] : []), ...(tankType !== 'shield' ? g.armor || [] : [])]);
    // 抗性只用选定的一种（主动 / 被动）；不自修时去掉回充增量器与维修组件
    for (const t of ['shield', 'armor']) for (const id of RESIST_GROUPS[t][resistMode === 'active' ? 'passive' : 'active']) groups.delete(id);
    if (SELF_REP === 'no') for (const id of REP_GROUPS) groups.delete(id);
    // 采矿船加采矿改良设备，运输船加扩充货柜舱与货柜改装件
    if (slot === 'low' && ROLES.has('mining') && A.mineTarget !== 'gas') groups.add(MINING_UPGRADE);
    if (slot === 'low' && ROLES.has('hauler')) groups.add(CARGO_EXP);
    const rigBad = (t) => slot === 'rig' && RIG_EXCLUDE.test(t.en || '') && !(ROLES.has('hauler') && /Cargohold Optimization/i.test(t.en || ''));
    const mineOk = (t) => t.group !== MINING_UPGRADE || (A.mineTarget === 'ice') === /Ice|Harvester/i.test(t.en || '');
    bySlot[slot] = prune(all.filter((t) => t.slot === slot && groups.has(t.group) && fits(t) && !rigBad(t) && mineOk(t)));
  }
  // 定位装备：同一族（分组 + 尺寸）只留最好的一件，尺寸交给装配时按 CPU / 电网挑
  const P = shipProfile(shipType);
  const best = (list) => {
    const fam = new Map();
    for (const t of list) { const k = family(t); if (!fam.has(k) || quality(t) > quality(fam.get(k))) fam.set(k, t); }
    return [...fam.values()].sort((a, b) => power(b) - power(a));
  };
  const pick = (groups, slot, extra = () => true) => best(all.filter((t) => t.slot === slot && groups.includes(t.group) && P.bonused.has(t.group) && fits(t) && extra(t)));
  const isIce = (t) => /Ice/i.test(t.en || '');
  const mineFilter = { ore: (t) => !isIce(t), ice: isIce, gas: () => true }[A.mineTarget] || (() => true);
  // 指挥脉冲波：每种受加成的脉冲波（装甲 / 护盾 / 信息 / 机动 / 采矿）各一件
  const bursts = new Map();
  for (const t of all) {
    if (t.group !== BURST || !fits(t) || ![...P.bonusOf(t)].includes(2469)) continue;
    const k = (t.en || t.name).replace(/\s+I{1,2}$/, '');
    if (!bursts.has(k) || quality(t) > quality(bursts.get(k))) bursts.set(k, t);
  }
  const role = {
    remote: pick(REMOTE_REP, 'high'),
    remoteCap: pick(REMOTE_CAP, 'high'),
    // ECM 只用全频段（多光谱）型号，对任何感应类型都有效
    ewar: pick(EWAR, 'mid', (t) => t.group !== 201 || /Multispectral/i.test(t.en || '')),
    neut: pick(NEUT, 'high'),
    mining: best(all.filter((t) => t.slot === 'high' && (MINING[A.mineTarget] || MINING.ore).includes(t.group) && fits(t) && mineFilter(t))),
    bursts: [...bursts.values()],
    field: pick([899], 'high'),
    bubble: shipType.group === INTERDICTOR ? best(all.filter((t) => t.group === BUBBLE && fits(t))).slice(0, 1) : [],
    cloak: P.covertCloak && usable(P.covertCloak) ? [P.covertCloak] : [],
    // 会战 / 堡垒模块（无畏、掠夺者），分流模块（后勤旗舰）
    siege: best(all.filter((t) => t.group === SIEGE && fits(t) && !/Triage/i.test(t.en || ''))),
    triage: best(all.filter((t) => t.group === SIEGE && fits(t) && /Triage/i.test(t.en || '')))
  };
  // 极化武器（装上后抗性归零）不参与
  const polarized = (t) => t.effects.some((e) => /^resistanceKiller/.test(data.effects.get(e)?.name || ''));
  // 武器按「弹药尺寸 + 最佳射程 + 跟踪」分族（同电网的长 / 短射程炮、旗舰反旗舰炮与高角炮分开比较），每族留最好的与最省资源的
  const wfam = (t) => [t.group, t.attrs.get(FE.AT.chargeSize) || 0, Math.round(Math.log2(t.attrs.get(FE.AT.maxRange) || 1) * 2), Math.round(Math.log2((t.attrs.get(FE.AT.trackingSpeed) || 0) + 1e-3))].join(':');
  const wf = new Map();
  for (const t of all) {
    if (t.slot !== 'high' || !(t.turret || t.launcher) || MINING_ALL.includes(t.group) || t.group === 737 || !fits(t) || polarized(t) || power(t) > shipPower * 0.6) continue;
    const k = wfam(t);
    if (!wf.has(k)) wf.set(k, []);
    wf.get(k).push(t);
  }
  // 炮台只用本船的尺寸（战列舰不装小炮，打小目标靠弹药 / 无人机）
  const tsize = (t) => t.attrs.get(FE.AT.chargeSize) || 0;
  const natural = Math.max(0, ...[...wf.values()].flat().filter((t) => t.turret).map(tsize));
  const weapons = [];
  for (const vs of wf.values()) {
    if (vs[0].turret && tsize(vs[0]) < natural) continue;
    const best = vs.reduce((a, b) => (quality(b) > quality(a) ? b : a));
    const cheap = vs.reduce((a, b) => (fitCost(b) < fitCost(a) ? b : a));
    weapons.push(best);
    if (cheap !== best && fitCost(cheap) < fitCost(best) * 0.7) weapons.push(cheap);
  }
  const charges = all.filter((t) => t.category === FE.CAT.charge && usable(t));
  const drones = all.filter((t) => t.category === FE.CAT.drone && usable(t) && FE.DAMAGE.some((a) => t.attrs.get(a)));
  const fighters = all.filter((t) => t.category === FE.CAT.fighter && usable(t) && [...FE.AT.fighterAttackDmg, ...FE.AT.fighterMissileDmg].some((a) => t.attrs.get(a)));
  const fitting = {
    low: prune(all.filter((t) => t.slot === 'low' && [...FITTING.cpu, ...FITTING.power].includes(t.group) && fits(t))),
    rig: prune(all.filter((t) => t.slot === 'rig' && FITTING.rigCpuPower.includes(t.group) && fits(t) && /CPU|Power|Processor|Current/i.test(t.en || '')))
  };
  const tackle = TACKLE.map((g) => all.filter((t) => t.slot === 'mid' && t.group === g && fits(t)).sort((a, b) => quality(b) - quality(a))[0]).filter(Boolean);
  // 改装件：同族只留 T2（不可用时 T1）
  const rigBest = new Map();
  for (const t of bySlot.rig) { const k = family(t); if (!rigBest.has(k) || quality(t) > quality(rigBest.get(k))) rigBest.set(k, t); }
  bySlot.rig = [...rigBest.values()];
  // 同族（同分组同尺寸；武器按弹药尺寸 + 射程 + 跟踪）的全部可用装备，供最后「换便宜的」用
  const famOf = new Map();
  for (const t of all) {
    if (!t.slot || t.slot === 'sub' || !fits(t) || !(prices.get(t.id) > 0)) continue;
    const k = t.turret || t.launcher ? 'w:' + wfam(t) : family(t);
    if (!famOf.has(k)) famOf.set(k, []);
    famOf.get(k).push(t);
  }
  const cheaperOf = (t) => (famOf.get(t.turret || t.launcher ? 'w:' + wfam(t) : family(t)) || [])
    .filter((x) => x.id !== t.id && prices.get(x.id) < (prices.get(t.id) || Infinity)).sort((a, b) => prices.get(a.id) - prices.get(b.id));
  return { bySlot, weapons, charges, drones, fighters, fitting, tackle, role, cheaperOf };
}

// 预留定位装备：在空位放入 1..maxN 件同一候选，取能装下（CPU / 电网不超过 limit，给坦克、推进留余量）且指标最高的
async function placeFixed(fit, slot, list, maxN, metric, progress, limit = 0.7) {
  const idx = fit.slots[slot].map((m, i) => (m ? -1 : i)).filter((i) => i >= 0).slice(0, maxN);
  if (!idx.length || !list.length) return 0;
  let best = null;
  for (const t of list) {
    for (let n = idx.length; n >= 1; n--) {
      const f = clone(fit);
      for (let k = 0; k < n; k++) f.slots[slot][idx[k]] = mod(t);
      const r = evaluate(f);
      await tick(progress);
      if (!r || !r.ok) continue;
      const res = r.st.resources;
      if (res.cpu.used > res.cpu.total * limit || res.power.used > res.power.total * limit) continue;
      const m = metric(r, n, t);
      if (!best || m > best.m + 1e-9) best = { m, t, n };
      break;
    }
  }
  if (best) for (let k = 0; k < best.n; k++) fit.slots[slot][idx[k]] = { ...mod(best.t), fixed: true };
  return best ? best.n : 0;
}

// 属性比较时忽略：科技 / 元等级、元组、所需技能及等级、物品自身结构值
const IGNORE_ATTRS = new Set([422, 633, 1692, 182, 183, 184, 1285, 1289, 1290, 277, 278, 279, 1286, 1287, 1288, 9]);
function sameStatsCheapest(list, prices) {
  const cost = (t) => prices.get(t.id) || Infinity;
  const out = new Map();
  for (const t of list) {
    const key = t.group + '|' + t.effects.join(',') + '|' + [...t.attrs].filter(([a]) => !IGNORE_ATTRS.has(a)).sort((a, b) => a[0] - b[0]).map(([a, v]) => a + '=' + v).join(',');
    const cur = out.get(key);
    if (!cur || cost(t) < cost(cur) || (cost(t) === cost(cur) && (t.meta || 0) < (cur.meta || 0))) out.set(key, t);
  }
  return [...out.values()];
}

// 武器用伤害最高的弹药（伤害相同取便宜的）
function bestCharge(weapon, charges) {
  const { FE } = ctx;
  let best = null, bestDmg = 0;
  for (const c of charges) {
    if (!FE.chargeFits(weapon, c)) continue;
    const dmg = FE.DAMAGE.reduce((s, a) => s + (c.attrs.get(a) || 0), 0);
    const cheaper = best && (ctx.prices()?.get(c.id) || Infinity) < (ctx.prices()?.get(best.id) || Infinity);
    if (dmg > bestDmg + 1e-9 || (Math.abs(dmg - bestDmg) <= 1e-9 && cheaper)) { bestDmg = dmg; best = c; }
  }
  return best;
}

// 无人机：单一型号，按带宽 / 挂舱 / 同时操作上限装满，取 DPS 最高的
function bestDrones(fit, cands) {
  const { FE } = ctx;
  const probe = evaluate(fit);
  if (!probe) return [];
  const bw = probe.st.resources.bandwidth.total, bay = probe.st.resources.droneBay.total, maxActive = probe.st.resources.activeDrones.total || 5;
  if (!bw || !bay) return [];
  const scored = [];
  for (const t of cands) {
    const per = t.attrs.get(FE.AT.droneBandwidthUsed) || 0, vol = t.attrs.get(FE.AT.volume) || 0;
    if (!per || !vol) continue;
    const active = Math.min(maxActive, Math.floor(bw / per + 1e-9), Math.floor(bay / vol + 1e-9));
    if (active < 1) continue;
    const count = Math.max(active, Math.min(Math.floor(bay / vol + 1e-9), active * 2));
    const dmg = FE.DAMAGE.reduce((s, a) => s + (t.attrs.get(a) || 0), 0) * (t.attrs.get(FE.AT.damageMultiplier) || 1) / ((t.attrs.get(FE.AT.speed) || 4000) / 1000);
    scored.push({ t, active, count, est: dmg * active });
  }
  scored.sort((a, b) => b.est - a.est);
  let best = null;
  // 看目标时小无人机可能更好：轻 / 中 / 重各取几种一起比
  const pool = TGT || DIST
    ? [...Map.groupBy(scored, (c) => c.t.attrs.get(FE.AT.droneBandwidthUsed) || 0).values()].flatMap((g) => g.slice(0, 3))
    : scored.slice(0, 4);
  for (const c of pool) {
    const f = clone(fit);
    f.drones = [{ type: c.t.id, count: c.count, active: c.active }];
    const r = evaluate(f);
    if (r && (!best || r.dps > best.r.dps)) best = { r, drones: f.drones };
  }
  return best ? best.drones : [];
}

// 舰载机：重型、轻型位各选伤害最高的一种，在发射管内满编出击（机库装得下时多带一个中队备用）
function bestFighters(fit, cands) {
  const { FE } = ctx;
  const probe = evaluate(fit);
  if (!probe || !probe.st.resources.fighterTubes.total) return [];
  const res = probe.st.resources;
  let tubes = res.fighterTubes.total, bay = res.fighterBay.total;
  const out = [];
  for (const [flag, slots] of [[FE.AT.fighterIsHeavy, res.fighterHeavy.total], [FE.AT.fighterIsLight, res.fighterLight.total]]) {
    if (!slots || !tubes) continue;
    let best = null;
    for (const t of cands.filter((x) => x.attrs.get(flag))) {
      const f = clone(fit);
      f.drones = [...out, { type: t.id, count: 1, active: 1 }];
      const r = evaluate(f);
      if (r && (!best || r.dps > best.dps)) best = { t, dps: r.dps };
    }
    if (!best) continue;
    const squadVol = (best.t.attrs.get(FE.AT.volume) || 0) * (best.t.attrs.get(FE.AT.fighterSquadronSize) || 1);
    const active = Math.min(slots, tubes, squadVol ? Math.floor(bay / squadVol) : slots);
    if (active < 1) continue;
    const count = Math.min(active + 1, squadVol ? Math.floor(bay / squadVol) : active);
    out.push({ type: best.t.id, count, active });
    tubes -= active;
    bay -= count * squadVol;
  }
  return out;
}

// ---------- 搜索 ----------
const clone = (fit) => ({ ...fit, slots: Object.fromEntries(Object.entries(fit.slots).map(([k, v]) => [k, v.map((m) => (m ? { ...m } : null))])), drones: fit.drones.map((d) => ({ ...d })), implants: [...(fit.implants || [])] });
let CHARGES = [];   // 当前搜索可用的弹药 / 装填物
// 非武器但需要装填的装备（电容注电器、辅助回充 / 维修器等）：配容量最大的装填物
const fuelCache = new Map();
function fuelFor(t) {
  if (t.turret || t.launcher || !ctx.FE.AT.chargeGroups.some((a) => t.attrs.get(a))) return null;
  if (!fuelCache.has(t.id) && MINING_ALL.includes(t.group)) {
    // 采矿晶体按矿石种类区分，默认用高安常见的「简单小行星」A 型晶体（矿种不同请在装配页换晶体）
    const list = CHARGES.filter((c) => ctx.FE.chargeFits(t, c) && /Simple Asteroid Mining Crystal Type A/i.test(c.en || ''));
    fuelCache.set(t.id, list.sort((a, b) => (b.meta || 0) - (a.meta || 0))[0] || null);
  }
  if (!fuelCache.has(t.id)) {
    let best = null;
    const cap = t.attrs.get(ctx.FE.AT.capacity) || Infinity;
    for (const c of CHARGES) if (ctx.FE.chargeFits(t, c) && (c.attrs.get(ctx.FE.AT.volume) || 0) <= cap + 1e-9 && (!best || (c.attrs.get(ctx.FE.AT.capacitorBonus) || c.attrs.get(ctx.FE.AT.volume) || 0) > (best.attrs.get(ctx.FE.AT.capacitorBonus) || best.attrs.get(ctx.FE.AT.volume) || 0))) best = c;
    fuelCache.set(t.id, best);
  }
  return fuelCache.get(t.id);
}
const mod = (t, charge = null) => ({ type: t.id, state: t.activatable ? 'active' : 'online', charge: (charge || fuelFor(t))?.id || null });

let evals = 0, lastYield = 0;
async function tick(progress) {
  evals++;
  if (performance.now() - lastYield > 40) {
    await new Promise((r) => setTimeout(r, 0));
    lastYield = performance.now();
    progress?.();
    if (S.cancel) throw new Error('cancelled');
  }
}

// 在某类槽位的第一个空位放入候选，返回最好的结果
async function bestFor(fit, slot, cands, cur, progress, ranking = null) {
  const idx = fit.slots[slot].findIndex((m) => !m);
  if (idx < 0) return null;
  let best = null;
  for (const t of cands) {
    fit.slots[slot][idx] = mod(t);
    const r = evaluate(fit);
    await tick(progress);
    if (ranking && r && r.ok) ranking.push([t, r.score]);
    if (r && r.ok && r.score > (best ? best.r.score : cur.score + 1e-6)) best = { t, r };
  }
  fit.slots[slot][idx] = null;
  return best ? { ...best, idx } : null;
}
const TOP_K = 12;   // 第一轮之后每类槽位只保留得分最高的候选

async function greedy(fit, cands, progress) {
  let cur = evaluate(fit);
  const order = ['low', 'mid', 'rig'];
  const done = new Set();
  const pool = { ...cands.bySlot };
  const first = new Set(order);
  while (done.size < order.length) {
    let any = false;
    for (const slot of order) {
      if (done.has(slot)) continue;
      const ranking = first.has(slot) ? [] : null;
      const b = await bestFor(fit, slot, pool[slot], cur, progress, ranking);
      if (ranking) {
        first.delete(slot);
        pool[slot] = ranking.sort((x, y) => y[1] - x[1]).slice(0, TOP_K).map(([t]) => t);
      }
      if (!b) { done.add(slot); continue; }
      fit.slots[slot][b.idx] = mod(b.t);
      cur = b.r;
      any = true;
    }
    if (!any) break;
  }
  return cur;
}

async function swapPass(fit, cands, cur, progress) {
  for (const slot of ['low', 'mid', 'rig']) {
    // 只试同类槽位里与已装装备不同的候选
    const list = cands.bySlot[slot].filter((t) => !fit.slots[slot].some((m) => m?.type === t.id));
    for (let i = 0; i < fit.slots[slot].length; i++) {
      const orig = fit.slots[slot][i];
      if (!orig || orig.fixed) continue;
      let best = null;
      for (const t of list) {
        if (t.id === orig.type) continue;
        fit.slots[slot][i] = mod(t);
        const r = evaluate(fit);
        await tick(progress);
        if (r && r.ok && r.score > (best ? best.r.score : cur.score + 1e-6)) best = { t, r };
      }
      fit.slots[slot][i] = best ? mod(best.t) : orig;
      if (best) cur = best.r;
    }
  }
  return cur;
}

// 有空槽装不下时：先放一个 CPU / 电网辅助装备再继续填，取更好的
async function withFitting(fit, cands, cur, progress) {
  let best = { fit, r: cur };
  for (const slot of ['low', 'rig']) {
    if (!fit.slots[slot].some((m) => !m)) continue;
    for (const t of cands.fitting[slot].slice(0, 4)) {
      const f = clone(fit);
      f.slots[slot][f.slots[slot].findIndex((m) => !m)] = mod(t);
      if (!evaluate(f)?.ok) continue;
      const r = await greedy(f, cands, progress);
      if (r.ok && r.score > best.r.score) best = { fit: f, r };
    }
  }
  return best;
}

// 补空槽：放入不降低得分的装备（中槽优先扰频器 / 停滞网），避免留空
// 换便宜的：逐件试同族更便宜的装备，整套得分比换之前合计下降不到约 0.2%、仍满足要求就换，取最便宜的那个（属性相同的必然会换）
const THRIFT_TOL = 0.002;
async function thriftPass(fit, cands, cur, progress) {
  const floor = cur.score - THRIFT_TOL;
  for (const slot of ['high', 'mid', 'low', 'rig']) {
    for (let i = 0; i < fit.slots[slot].length; i++) {
      const orig = fit.slots[slot][i];
      if (!orig) continue;
      const t = ctx.data.types.get(orig.type);
      for (const c of cands.cheaperOf(t)) {
        fit.slots[slot][i] = { ...orig, type: c.id, charge: orig.charge && ctx.FE.chargeFits(c, ctx.data.types.get(orig.charge)) ? orig.charge : (fuelFor(c)?.id || null) };
        const r = evaluate(fit);
        await tick(progress);
        if (r && r.ok && (r.met || !cur.met) && r.score >= floor) { cur = r; break; }
        fit.slots[slot][i] = orig;
      }
    }
  }
  return cur;
}

async function fillEmpty(fit, cands, cur, progress) {
  for (const slot of ['mid', 'low', 'rig']) {
    const list = slot === 'mid' ? [...cands.tackle, ...cands.bySlot.mid] : cands.bySlot[slot];
    for (let i = 0; i < fit.slots[slot].length; i++) {
      if (fit.slots[slot][i]) continue;
      let best = null;
      // 扰频器、停滞网各最多一个
      const has = new Set(fit.slots[slot].filter(Boolean).map((m) => ctx.data.types.get(m.type)?.group));
      for (const t of list) {
        if (TACKLE.includes(t.group) && has.has(t.group)) continue;
        fit.slots[slot][i] = mod(t);
        const r = evaluate(fit);
        await tick(progress);
        if (r && r.ok && r.score >= cur.score - 1e-9 && (!best || r.score > best.r.score + 1e-9)) best = { t, r };
      }
      fit.slots[slot][i] = best ? mod(best.t) : null;
      if (best) cur = best.r;
    }
  }
  return cur;
}

// 打分用的全局设定：舰船定位（可改成「当普通战斗船」）、目标体型与交战距离、自修（自动时有维修加成的战斗船自修）
function setupScoring(shipType) {
  TGT = ctx.FE.TARGETS[A.target] || null;
  DIST = RANGES[A.range] || 0;
  const P = shipProfile(shipType);
  ROLES = new Set(A.role === 'combat' ? [] : P.roles);
  const fighting = !['logi', 'mining', 'hauler'].some((r) => ROLES.has(r));
  SELF_REP = A.selfRep === 'auto' && P.rep && fighting ? 'yes' : A.selfRep;
  return { P, fighting };
}

async function search(onProgress) {
  const { FE, data } = ctx;
  const cur = ctx.getFit();
  const shipType = data.types.get(cur.ship);
  const base = { id: null, name: '', ship: cur.ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [...(cur.implants || [])] };
  // 战略巡洋舰沿用当前子系统
  base.slots.sub = (cur.slots.sub || []).filter(Boolean).map((m) => ({ ...m }));
  const probe = evaluate(base);
  if (!probe) throw new Error('无法计算这艘船');
  const slots = probe.st.slots;
  if (slots.sub && !base.slots.sub.length) throw new Error('战略巡洋舰请先装好子系统');
  for (const s of ['high', 'mid', 'low', 'rig']) base.slots[s] = Array(slots[s] || 0).fill(null);

  const { P, fighting } = setupScoring(shipType);
  // 坦克类型：自动时先看舰船加成（护盾 / 装甲抗性、血量、回充 / 维修），没有再按护盾 / 装甲值与中低槽数判断
  const tankType = A.tank === 'auto' ? autoTank(shipType).tank : A.tank;
  // 抗性：自动时盾抗船用主动抗、甲抗船用被动抗
  const resistMode = A.resist === 'auto' ? (tankType === 'shield' ? 'active' : 'passive') : A.resist;
  const cands = buildCandidates(shipType, tankType, resistMode);
  CHARGES = cands.charges;
  fuelCache.clear();
  evals = 0;
  const progress = () => onProgress(evals);
  const R = cands.role;
  const placed = [];   // 已预留的定位装备说明
  const count = (n, label) => { if (n) placed.push(label); };

  {
    // 高槽：会战 / 堡垒 / 分流模块、隐形装置、拦截泡、指挥脉冲波、远程维修 / 采矿
    count(await placeFixed(base, 'high', ROLES.has('logi') ? [...R.triage, ...R.siege].slice(0, 1) : R.siege, 1, (r) => r.dps + r.ehp / 1000, progress, 0.9), '会战模块');
    if (ROLES.has('covert')) count(await placeFixed(base, 'high', R.cloak, 1, (r, n) => n, progress, 0.9), '隐形装置');
    if (ROLES.has('tackle')) {
      count(await placeFixed(base, 'high', R.bubble, 1, (r, n) => n, progress, 0.9), '拦截泡');
      count(await placeFixed(base, 'high', R.field, 1, (r, n) => n, progress, 0.85), '扰断力场');
    }
    if (ROLES.has('command')) {
      let n = 0;
      for (const t of R.bursts.slice(0, 3)) n += await placeFixed(base, 'high', [t], 1, (r, k) => k, progress, 0.8);
      count(n, '指挥脉冲波');
    }
    if (ROLES.has('logi')) {
      const free = base.slots.high.filter((m) => !m).length;
      // 有远程电容加成的先放一个远程电容
      if (R.remoteCap.length && free > 2) count(await placeFixed(base, 'high', R.remoteCap, 1, (r, n, t) => t.attrs.get(90) || 1, progress, 0.4), '远程电容');
      count(await placeFixed(base, 'high', R.remote, free, (r) => r.remote, progress, 0.9), '远程维修');
      // 大号装不满时，剩下的高槽换小一号
      const left = base.slots.high.filter((m) => !m).length;
      if (left > 0) await placeFixed(base, 'high', R.remote, left, (r) => r.remote, progress, 0.95);
    }
    if (ROLES.has('mining')) count(await placeFixed(base, 'high', R.mining, slots.high || 0, (r) => r.mining, progress, 0.75), '采矿设备');
    // 中槽：扰频器 + 停滞网（PVP 预留或有拦截加成）、扰断力场、电子战
    if (A.tackle || ROLES.has('tackle')) {
      for (const t of cands.tackle) { const i = base.slots.mid.findIndex((m) => !m); if (i >= 0) base.slots.mid[i] = { ...mod(t), fixed: true }; }
    }
    if (ROLES.has('ewar')) {
      const free = base.slots.mid.filter((m) => !m).length;
      // 只有目标标记加成的（掠夺者、部分护卫舰）是辅助输出，只放一个
      const onlyPainter = R.ewar.every((t) => t.group === 379);
      count(await placeFixed(base, 'mid', R.ewar, onlyPainter ? 1 : Math.max(1, free - 2), (r, n) => n, progress, 0.75), '电子战');
    }
  }

  // 无人机
  if (A.weapon === 'auto' || A.weapon === 'drone') base.drones = [...bestDrones(base, cands.drones), ...bestFighters(base, cands.fighters)];

  // 武器方案：只用剩下的高槽与安装座（采矿激光占用炮台安装座）
  const options = [];
  const baseEval = evaluate(base);
  const res = baseEval.st.resources;
  const freeHigh = base.slots.high.map((m, i) => (m ? -1 : i)).filter((i) => i >= 0);
  if (A.weapon !== 'drone' && fighting) {
    for (const w of cands.weapons) {
      if (A.weapon === 'turret' && !w.turret) continue;
      if (A.weapon === 'missile' && !w.launcher) continue;
      const n = Math.min(freeHigh.length, w.turret ? res.turrets.total - res.turrets.used : res.launchers.total - res.launchers.used);
      if (n <= 0) continue;
      // 弹药：不看目标时用伤害最高的；看目标 / 距离时逐种试装，取有效 DPS 最高的（远距离会选长射程弹药）
      const list = TGT || DIST ? cands.charges.filter((c) => FE.chargeFits(w, c)) : [bestCharge(w, cands.charges)].filter(Boolean);
      let best = null;
      for (const charge of list) {
        const f = clone(base);
        for (let i = 0; i < n; i++) f.slots.high[freeHigh[i]] = mod(w, charge);
        const r = evaluate(f);
        await tick(progress);
        if (r && r.ok && (!best || r.dps > best.r.dps + 1e-6 || (r.dps > best.r.dps - 1e-6 && r.cost < best.r.cost))) best = { f, r, w };
      }
      if (best) options.push(best);
    }
  }
  // 受舰船加成的武器优先（射程、跟踪等加成不体现在 DPS 里）
  const wScore = (o) => o.r.dps * (P.bonusOf(o.w).size ? 1.15 : 1);
  options.sort((a, b) => wScore(b) - wScore(a));
  // 同一类武器（炮台 / 导弹）只保留最好的一种，最多两种方案
  const picked = [];
  for (const o of options) {
    if (picked.length >= 2) break;
    if (picked.some((p) => p.w.group === o.w.group)) continue;
    picked.push(o);
  }
  if (!picked.length) picked.push({ f: clone(base), r: evaluate(base) });

  const results = [];
  for (const o of picked) {
    const f = o.f;
    // 能量战加成：剩下的高槽放中和器 / 掠能器
    if (ROLES.has('neut')) count(await placeFixed(f, 'high', R.neut, 8, (r, n, t) => n * (t.attrs.get(97) || t.attrs.get(90) || 1), progress, 0.75), '能量中和');
    // 武器改装件只留与这套武器匹配的
    const rigOk = (t) => ![775, 776, 777, 779].includes(t.group) || (o.w && (o.w.launcher ? t.group === 779 : t.group === WEAPON_RIG[o.w.group]));
    const oc = { ...cands, bySlot: { ...cands.bySlot, rig: cands.bySlot.rig.filter(rigOk) } };
    let r = await greedy(f, oc, progress);
    let best = { fit: f, r };
    if (['mid', 'low', 'rig'].some((s) => f.slots[s].some((m) => !m))) best = await withFitting(f, oc, r, progress);
    best.r = await swapPass(best.fit, oc, best.r, progress);
    best.r = await fillEmpty(best.fit, oc, best.r, progress);
    best.r = await thriftPass(best.fit, oc, best.r, progress);
    best.bonus = o.w && P.bonusOf(o.w).size ? Math.log(1.15) : 0;
    results.push(best);
  }
  results.sort((a, b) => b.r.score + b.bonus - a.r.score - a.bonus);
  // 同时推荐植入体：在每个方案上另做植入体搜索，套用最佳方案
  if (A.implants) {
    for (const x of results) {
      const plans = await recommendImplants(x.fit, progress);
      const plan = plans[0];
      x.implantPlan = plan || null;
      x.fit.implants = plan ? [...plan.implants] : [];
      x.r = evaluate(x.fit);
    }
  }
  return { results, tankType, resistMode, evals, roles: [...ROLES], placed: [...new Set(placed)], selfRep: SELF_REP };
}

// ---------- 植入体 ----------
// 候选：1–10 号槽、市场有售、价格不超过植入体预算（按 ESI 角色时还要求技能够）的植入体。
// 1. 逐个单独装上，记下对得分的提升，只留有提升的；同一槽位效果相同的只留最便宜的
// 2. 「最佳」：按提升从大到小逐槽挑预算内最好的；另对每个套装（低 / 中 / 高级 × 名称，水晶、极乐、蝰蛇等，占 1–6 号槽）
//    逐件加入（2 件到整套），每种件数都配上其余槽位的最佳植入体一起比较；套装叠加加成由装配引擎按游戏规则计算
// 3. 「性价比」：每个槽位取效果达到该槽最佳 70% 的最便宜植入体，不刻意凑套装
// 只加属性点（感知、记忆等）的植入体不影响装配属性，不会被推荐。
const IMPLANT_SLOT = 331;
const SET_RE = /^(Low|Mid|High)-grade (.+) (Alpha|Beta|Gamma|Delta|Epsilon|Omega)$/i;
const VALUE_SHARE = 0.7;

function implantPrice(id) { return ctx.prices()?.get(id) || 0; }

function implantCandidates() {
  const { data, FE } = ctx;
  const havePrices = Boolean(ctx.prices()?.size);
  const levels = A.skills === 'esi' ? ctx.esiLevels() : null;
  const budget = A.impBudget > 0 ? A.impBudget * 1e6 : Infinity;
  return [...data.types.values()].filter((t) => {
    const slot = t.attrs.get(IMPLANT_SLOT);
    if (t.category !== FE.CAT.implant || !t.market || !(slot >= 1 && slot <= 10)) return false;
    const p = implantPrice(t.id);
    if (havePrices && (!p || p > budget)) return false;
    return !levels || t.skills.every(([sk, l]) => (levels.get(sk) || 0) >= l);
  });
}

// 植入体单独装上时最明显的变化（相对没有植入体），用于说明「这个植入体有什么用」
const EFFECT_KEYS = [['dps', 'DPS'], ['ehp', 'EHP'], ['active', '主动坦'], ['remote', '远程维修'], ['mining', '采矿'], ['cargo', '货柜'], ['speed', '速度']];
function effectText(r, r0) {
  const out = [];
  for (const [k, label] of EFFECT_KEYS) {
    if (!(r0[k] > 0)) continue;
    const d = r[k] / r0[k] - 1;
    if (d > 0.001) out.push([d, `${label} +${(d * 100).toFixed(1)}%`]);
  }
  if (r0.align > 0 && r.align < r0.align * 0.999) out.push([1 - r.align / r0.align, `起跳 −${((1 - r.align / r0.align) * 100).toFixed(1)}%`]);
  if (r.st.capacitor.stable && !r0.st.capacitor.stable) out.push([0.05, '电容稳定']);
  return out.sort((a, b) => b[0] - a[0]).slice(0, 2).map((x) => x[1]).join('，') || '小幅提升';
}

async function recommendImplants(fit, progress) {
  const base = clone(fit);
  base.implants = [];
  const r0 = evaluate(base);
  if (!r0) return [];
  const budget = A.impBudget > 0 ? A.impBudget * 1e6 : Infinity;
  // 1. 单个植入体的提升
  const bySlot = new Map();
  const gainOf = new Map();
  for (const t of implantCandidates()) {
    const f = clone(base);
    f.implants = [t.id];
    const r = evaluate(f);
    await tick(progress);
    const gain = r ? r.score - r0.score : 0;
    if (!(gain > 1e-4)) continue;
    const slot = t.attrs.get(IMPLANT_SLOT);
    const c = { t, slot, gain, cost: implantPrice(t.id), effect: effectText(r, r0) };
    gainOf.set(t.id, c);
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(c);
  }
  for (const list of bySlot.values()) {
    list.sort((a, b) => b.gain - a.gain || a.cost - b.cost);
    // 效果相同的（提升相差不到 0.1%）只留最便宜的
    for (let i = list.length - 1; i > 0; i--) if (list.some((x, j) => j < i && Math.abs(x.gain - list[i].gain) < list[i].gain * 1e-3 && x.cost <= list[i].cost)) list.splice(i, 1);
  }
  if (!bySlot.size) return [];

  // 在给定槽位里按提升从大到小、预算内逐槽挑
  const greedy = (slots, left) => {
    const out = [];
    const order = [...slots].filter((s) => bySlot.has(s)).sort((a, b) => bySlot.get(b)[0].gain - bySlot.get(a)[0].gain);
    for (const s of order) {
      const c = bySlot.get(s).find((x) => x.cost <= left);
      if (c) { out.push(c.t.id); left -= c.cost; }
    }
    return out;
  };
  const plans = [];
  const addPlan = async (kind, ids, setName = '', setCount = 0) => {
    const f = clone(base);
    f.implants = ids;
    const r = evaluate(f);
    await tick(progress);
    const cost = ids.reduce((sum, id) => sum + implantPrice(id), 0);
    plans.push({ kind, implants: ids, r, cost, setName, setCount, gain: r.score - r0.score });
  };
  await addPlan('best', greedy(Array.from({ length: 10 }, (_, i) => i + 1), budget));
  // 套装（1–6 号槽，同套每多装一件，套内其他件的效果都按套装系数放大）：
  // 每个套装从空开始逐件加入「加上后得分最高」的一件（预算内），每加一件都和其余槽位的最佳植入体组成一个方案比较，
  // 这样预算不够买整套时也会比较 3 件、4 件、5 件的组合
  const sets = new Map();
  for (const t of implantCandidates()) {
    const m = SET_RE.exec(t.en || '');
    if (!m) continue;
    const key = m[1] + ' ' + m[2];
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(t);
  }
  const ALL_SLOTS = Array.from({ length: 10 }, (_, i) => i + 1);
  for (const [, pieces] of sets) {
    // 至少一件单独装就有提升，才值得试这个套装
    if (pieces.length < 2 || !pieces.some((t) => gainOf.has(t.id))) continue;
    const setName = pieces[0].name.replace(/[—\-－\s]*[^—\-－\s]+型$/, '').replace(/\s+(Alpha|Beta|Gamma|Delta|Epsilon|Omega)$/, '');   // 英文版名称是「… Alpha」
    let cur = [], cost = 0, curScore = r0.score;
    const left = [...pieces];
    while (left.length) {
      let pick = null;
      for (const t of left) {
        const c = implantPrice(t.id);
        if (cost + c > budget) continue;
        const f = clone(base);
        f.implants = [...cur, t.id];
        const r = evaluate(f);
        await tick(progress);
        if (r && (!pick || r.score > pick.score)) pick = { t, score: r.score, c };
      }
      if (!pick || pick.score <= curScore + 1e-4) break;
      cur = [...cur, pick.t.id];
      cost += pick.c;
      curScore = pick.score;
      left.splice(left.indexOf(pick.t), 1);
      if (cur.length >= 2) {
        const used = new Set(cur.map((id) => ctx.data.types.get(id).attrs.get(IMPLANT_SLOT)));
        await addPlan('set', [...cur, ...greedy(ALL_SLOTS.filter((x) => !used.has(x)), budget - cost)], setName, cur.length);
      }
    }
  }
  plans.sort((a, b) => b.r.score - a.r.score || a.cost - b.cost);
  const best = plans[0];
  const out = [best];
  // 性价比：每槽取效果达到最佳 70% 的最便宜植入体
  const value = [];
  let left = budget;
  for (const list of [...bySlot.values()].sort((a, b) => b[0].gain - a[0].gain)) {
    const top = list[0].gain;
    const c = list.filter((x) => x.gain >= top * VALUE_SHARE && x.cost <= left).sort((a, b) => a.cost - b.cost)[0];
    if (c) { value.push(c.t.id); left -= c.cost; }
  }
  value.sort((a, b) => gainOf.get(a).slot - gainOf.get(b).slot);
  const vf = clone(base);
  vf.implants = value;
  const vr = evaluate(vf);
  const vcost = value.reduce((sum, id) => sum + implantPrice(id), 0);
  if (vcost < best.cost * 0.8) out.push({ kind: 'value', implants: value, r: vr, cost: vcost, setName: '', gain: vr.score - r0.score });
  // 最佳是套装时再给一个不用套装的方案；不是套装时给得分最高的套装方案，方便对比
  const other = best.kind === 'set' ? plans.find((p) => p.kind === 'best') : plans.find((p) => p.kind === 'set');
  if (other && !out.includes(other)) out.push(other);
  for (const p of out) {
    p.base = r0;
    p.implants.sort((a, b) => (ctx.data.types.get(a).attrs.get(IMPLANT_SLOT) || 0) - (ctx.data.types.get(b).attrs.get(IMPLANT_SLOT) || 0));
    p.items = p.implants.map((id) => ({ id, slot: ctx.data.types.get(id).attrs.get(IMPLANT_SLOT), cost: implantPrice(id), effect: (gainOf.get(id)?.effect || '') + (p.setName && SET_RE.test(ctx.data.types.get(id).en || '') && ctx.data.types.get(id).name.startsWith(p.setName) ? (gainOf.get(id) ? '，套装加成' : '套装加成') : '') || '小幅提升' }));
  }
  return out;
}

const PLAN_NAME = { best: '最佳植入体', set: '最佳植入体', value: '性价比方案' };
const planTitle = (p, i) => (i === 0 ? PLAN_NAME[p.kind] : p.kind === 'set' ? '套装方案' : p.kind === 'best' ? '不用套装' : PLAN_NAME[p.kind]);

// 植入体方案卡片：属性对比（相对不装植入体）+ 逐槽列表
function implantPlanHtml(p, i, applyAttr) {
  const { esc, formatNumber: num, formatISK: isk, data } = ctx;
  const r = p.r, b = p.base;
  const pct = (k) => (b[k] > 0 && r[k] / b[k] - 1 > 0.0005 ? `<small class="up"> +${((r[k] / b[k] - 1) * 100).toFixed(1)}%</small>` : '');
  const roles = [...ROLES];
  const stats = [
    roles.includes('logi') ? `<div><span>远程维修</span><b>${r.remote.toFixed(0)}${pct('remote')}</b></div>` : '',
    roles.includes('mining') ? `<div><span>采矿</span><b>${(r.mining * 60).toFixed(0)}<small> m³/分</small>${pct('mining')}</b></div>` : '',
    roles.includes('hauler') ? `<div><span>货柜</span><b>${num(Math.round(r.cargo))}${pct('cargo')}</b></div>` : '',
    r.paper >= 1 ? `<div><span>DPS</span><b>${r.dps.toFixed(0)}${pct('dps')}</b></div>` : '',
    `<div><span>EHP</span><b>${num(Math.round(r.ehp))}${pct('ehp')}</b></div>`,
    `<div><span>速度</span><b>${r.speed.toFixed(0)}${pct('speed')}</b></div>`,
    A.goal === 'pve' || r.active > b.active * 1.001 ? `<div><span>主动坦</span><b>${r.active.toFixed(0)}${pct('active')}</b></div>` : '',
    `<div><span>起跳</span><b>${r.align.toFixed(1)}<small> 秒</small>${b.align > r.align * 1.0005 ? `<small class="up"> −${((1 - r.align / b.align) * 100).toFixed(1)}%</small>` : ''}</b></div>`,
    `<div><span>植入体估价</span><b>${p.cost ? isk(p.cost) : '—'}</b></div>`
  ].join('');
  const rows = p.items.map((x) => `<div class="fa-imp-row"><span class="fa-imp-slot">${x.slot}</span><img src="${IMG(x.id)}" alt="" width="24" height="24" loading="lazy"><span class="fa-imp-name">${esc(data.types.get(x.id)?.name || x.id)}<small>${esc(x.effect)}</small></span><span class="fa-imp-cost">${x.cost ? isk(x.cost) : '—'}</span></div>`).join('');
  const title = planTitle(p, i) + (p.setName ? ` · ${esc(p.setName)}套装 ${p.setCount === 6 ? '整套' : p.setCount + ' 件'}` : '');
  const note = p.kind === 'value' ? `每个槽位取效果达到最佳 ${VALUE_SHARE * 100}% 的最便宜植入体` : p.setName ? `同套装 ${p.setCount} 件，套内每件的效果按套装系数叠乘放大` : '';
  return `<div class="fa-result${i === 0 ? ' best' : ''}">
    <div class="fa-result-head"><b>${title}</b>${note ? `<span class="fa-note-inline">${note}</span>` : ''}<button type="button" class="btn btn-primary" ${applyAttr}="${i}">套用</button></div>
    <div class="fa-stats">${stats}</div>
    <div class="fa-imps">${rows}</div>
  </div>`;
}

// ---------- 界面 ----------
export function openAutoFit() {
  let modal = $('fitAutoModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitAutoModal';
    modal.className = 'modal fa-modal';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `<div class="modal-backdrop"></div><div class="modal-content fa-content">
      <div class="modal-header"><h3>智能装配</h3><button class="modal-close" data-fa-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body fa-body"><form class="fa-form" id="faForm"></form><div class="fa-results" id="faResults"></div></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onClick);
    modal.addEventListener('change', onChange);
    modal.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  }
  modal.hidden = false;
  S.results = [];
  renderForm();
  $('faResults').innerHTML = `<div class="fa-empty">设定目标后点「开始装配」</div>`;
}

function close() {
  S.cancel = true;
  const m = $('fitAutoModal');
  if (m) m.hidden = true;
}

// 交战目标：体型与距离用卡片选，底下一句话总结会怎么挑武器
const AIM_TARGETS = [
  ['any', '不限', '面板 DPS'],
  ['frigate', '小船', '护卫 / 驱逐'],
  ['cruiser', '中型船', '巡洋 / 战巡'],
  ['battleship', '大船', '战列舰'],
  ['capital', '旗舰', '旗舰 / 建筑']
];
const AIM_RANGES = [
  ['any', '不限', '不看射程'],
  ['close', '5 km', '贴脸'],
  ['mid', '20 km', '中距离'],
  ['long', '50 km', '远程'],
  ['xlong', '100 km', '超远']
];
function aimHtml() {
  const card = (k, [v, title, sub]) => `<button type="button" class="fa-opt${A[k] === v ? ' active' : ''}" data-fa-set="${k}" data-v="${v}"><b>${title}</b><small>${sub}</small></button>`;
  const t = ctx.FE.TARGETS[A.target], d = RANGES[A.range];
  let summary;
  if (!t && !d) summary = '都选「不限」时按面板 DPS 挑武器，不考虑打不打得中。';
  else {
    const parts = [];
    if (t) parts.push(`目标按信号半径 ${t.sig} m、速度 ${t.vel} m/s 算：炮台跟踪不够、导弹爆炸半径太大都会掉伤害`);
    if (d) parts.push(`在 ${d / 1000} km 开火：炮台超出最佳射程 + 失准范围会掉伤害，导弹飞不到不算`);
    summary = `<b>会怎么挑：</b>${parts.join('；')}。武器、弹药和无人机都按打得中的伤害比较，结果里显示「有效 DPS / 面板 DPS」。`;
  }
  return `<div class="fa-field"><label>目标体型</label><div class="fa-opts">${AIM_TARGETS.map((o) => card('target', o)).join('')}</div></div>
    <div class="fa-field"><label>交战距离</label><div class="fa-opts">${AIM_RANGES.map((o) => card('range', o)).join('')}</div></div>
    <p class="fa-aim">${summary}</p>`;
}

function renderForm() {
  const esc = ctx.esc;
  const ship = ctx.data.types.get(ctx.getFit().ship);
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-fa-set="${k}" data-v="${v}" class="${String(A[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const hint = (text) => (text ? `<p class="fa-hint">${text}</p>` : '');
  const field = (label, body, help = '') => `<div class="fa-field">${label ? `<label>${label}</label>` : ''}${body}${hint(help)}</div>`;
  const section = (title, body) => `<section class="fa-sec"><h4>${title}</h4>${body}</section>`;
  const bound = Boolean(ctx.esiLevels());
  const P = shipProfile(ship);
  const roles = A.role === 'combat' ? [] : P.roles;
  const job = roles.find((r) => ['logi', 'mining', 'hauler'].includes(r));
  const NAME = { shield: '护盾', armor: '装甲', active: '主动抗', passive: '被动抗' };

  // 「自动」实际会怎么配：按这艘船算出来写在选项下面
  const tank = A.tank === 'auto' ? autoTank(ship) : { tank: A.tank };
  const resist = A.resist === 'auto' ? (tank.tank === 'shield' ? 'active' : 'passive') : A.resist;
  const repAuto = P.rep && !job;
  const auto = (text) => `<b>自动 →</b> ${text}`;
  const help = {
    role: A.role === 'combat' ? '忽略舰船定位，和普通战斗船一样只看输出 / 坦克'
      : `先放好${roles.map((r) => ROLE_NAME[r]).join('、')}装备，其余槽位再按目标配`,
    mineTarget: { ore: '露天采矿器 / 采矿激光 + 采矿改良设备，默认装简单小行星晶体', ice: '冰矿采集器 + 冰矿采集改良设备', gas: '气云采集器' }[A.mineTarget],
    tank: A.tank === 'auto' ? auto(`本船用${NAME[tank.tank]}坦克（依据${tank.why}）`) : A.tank === 'shield' ? '中槽放护盾扩展、强化装置' : '低槽放装甲附甲、薄膜',
    resist: A.resist === 'auto' ? auto(`${NAME[tank.tank]}船用${NAME[resist]}（盾抗主动抗、甲抗被动抗）`)
      : A.resist === 'active' ? '需要激活的强化器 / 增强器，抗性高但耗电容' : '增效器 / 薄膜等被动装备，不耗电容',
    selfRep: A.selfRep === 'auto' ? auto(repAuto ? '本船有维修加成，配回充 / 维修装备' : A.goal === 'pve' ? '刷怪主动坦会配回充 / 维修装备' : '看得分决定，一般不配')
      : A.selfRep === 'yes' ? '一定配回充 / 维修装备，维修量计入得分' : '不配回充 / 维修装备，槽位全给血量和抗性',
    weapon: { auto: '比较各种炮台、导弹，取伤害最高的；有无人机挂舱也配无人机', turret: '只用炮台', missile: '只用导弹发射器', drone: '高槽不放武器，只配无人机 / 舰载机' }[A.weapon],
    meta: { t1: '只用 T1 及其变体', t2: '可用 T1、T2', faction: '再加势力、故事线装备', deadspace: '再加死亡空间装备', officer: '全部可用，包括官员装备' }[A.meta],
    skills: A.skills === 'esi' ? '只用角色能装的装备，属性按角色技能计算' : '按全部技能 5 级计算'
  };

  $('faForm').innerHTML = `
    <div class="fa-ship"><img src="${IMG(ship.id)}" alt="" width="32" height="32"><b>${esc(ship.name)}</b>${P.roles.map((r) => `<span class="fa-role">${ROLE_NAME[r]}</span>`).join('')}</div>
    ${P.labels.length ? `<div class="fa-bonus"><span>舰船加成</span>${P.labels.map((l) => `<em>${esc(l)}</em>`).join('')}</div>` : ''}
    ${P.roles.length ? section('舰船定位', field('', seg('role', [['auto', '按加成：' + P.roles.map((r) => ROLE_NAME[r]).join(' / ')], ['combat', '当普通战斗船']]), help.role)
      + (roles.includes('mining') ? field('采矿对象', seg('mineTarget', [['ore', '矿石'], ['ice', '冰矿'], ['gas', '气云']]), help.mineTarget) : '')) : ''}
    ${section('目标', job ? `<p class="fa-note">${ROLE_NAME[job]}船按${{ logi: '远程维修量', mining: '采矿量', hauler: '货柜容量' }[job]}配装，其余兼顾坦克</p>`
      : `<div class="fa-goals">${GOALS.map(([k, l, d]) => `<button type="button" class="fa-goal${A.goal === k ? ' active' : ''}" data-fa-set="goal" data-v="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>`)}
    ${job ? '' : section('打什么目标', aimHtml())}
    ${section('最低要求 <small>填 0 表示不限</small>', `<div class="fa-grid3">
        <label class="fa-num"><span>DPS</span><input type="number" min="0" step="10" value="${A.minDps}" data-fa-num="minDps"></label>
        <label class="fa-num"><span>EHP</span><input type="number" min="0" step="1000" value="${A.minEhp}" data-fa-num="minEhp"></label>
        <label class="fa-num"><span>速度 m/s</span><input type="number" min="0" step="50" value="${A.minSpeed}" data-fa-num="minSpeed"></label>
      </div>
      <div class="fa-checks">
        <label class="pi-check"><input type="checkbox" data-fa-check="capStable"${A.capStable ? ' checked' : ''}><span>电容稳定<small>所有装备一直开着也不会耗光电容</small></span></label>
        <label class="pi-check"><input type="checkbox" data-fa-check="tackle"${A.tackle ? ' checked' : ''}><span>预留扰频器和停滞网<small>PVP 抓人用，先占两个中槽</small></span></label>
      </div>`)}
    ${section('坦克', field('坦克类型', seg('tank', [['auto', '自动'], ['shield', '护盾'], ['armor', '装甲']]), help.tank)
      + field('抗性', seg('resist', [['auto', '自动'], ['active', '主动抗'], ['passive', '被动抗']]), help.resist)
      + field('自修', seg('selfRep', [['auto', '自动'], ['yes', '自修'], ['no', '不自修']]), help.selfRep))}
    ${section('武器与装备', field('武器', seg('weapon', [['auto', '自动'], ['turret', '炮台'], ['missile', '导弹'], ['drone', '仅无人机']]), help.weapon)
      + field('装备等级', seg('meta', [['t1', 'T1'], ['t2', '+T2'], ['faction', '+势力'], ['deadspace', '+死亡空间'], ['officer', '+官员']]), help.meta))}
    ${section('植入体', `<div class="fa-checks"><label class="pi-check"><input type="checkbox" data-fa-check="implants"${A.implants ? ' checked' : ''}><span>同时推荐植入体<small>装备配好后，再按同样的目标挑 1–10 号槽植入体（含套装）</small></span></label></div>`
      + (A.implants ? field('植入体预算', `<div class="fa-unit"><input type="number" class="fa-input" min="0" step="50" value="${A.impBudget}" data-fa-num="impBudget"><span>百万 ISK</span></div>`, '整套植入体按全服均价计，0 为不限；高级套装往往要数十亿') : ''))}
    ${section('预算与技能', field('预算', `<div class="fa-unit"><input type="number" class="fa-input" min="0" step="10" value="${A.budget}" data-fa-num="budget"><span>百万 ISK</span></div>`, '整套装备（不含船）按全服均价计，0 为不限')
      + field('技能', seg('skills', [['max', '全 5 级'], ['esi', bound ? '按角色' : '按角色（未读取）']]), help.skills))}
    <button type="submit" class="btn btn-primary fa-go">${S.running ? '计算中…' : '开始装配'}</button>`;
}

function onClick(e) {
  if (e.target.closest('[data-fa-close]') || e.target.classList.contains('modal-backdrop')) { close(); return; }
  const set = e.target.closest('[data-fa-set]');
  if (set) {
    const k = set.dataset.faSet;
    if (k === 'skills' && set.dataset.v === 'esi' && !ctx.esiLevels()) { ctx.showToast('请先在装配页切换到「按 ESI 角色」读取技能', 'error'); return; }
    A[k] = set.dataset.v;
    ctx.store.setJSON(KEY, A);
    renderForm();
    return;
  }
  if (e.target.closest('[data-fa-cancel]')) { S.cancel = true; return; }
  const apply = e.target.closest('[data-fa-apply]');
  if (apply) {
    const r = S.results[Number(apply.dataset.faApply)];
    const fit = clone(r.fit);
    for (const s of ctx.FE.SLOTS) for (const m of fit.slots[s]) if (m) delete m.fixed;
    fit.name = `智能装配 · ${GOALS.find((g) => g[0] === A.goal)[1]}`;
    if (!A.implants) fit.implants = [...(ctx.getFit().implants || [])];
    ctx.applyFit(fit);
    close();
    ctx.showToast('已套用智能装配', 'success');
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.faNum) { A[t.dataset.faNum] = Math.max(0, Number(t.value) || 0); ctx.store.setJSON(KEY, A); }
  else if (t.dataset.faCheck) { A[t.dataset.faCheck] = t.checked; ctx.store.setJSON(KEY, A); if (t.dataset.faCheck === 'implants') renderForm(); }
}

async function run() {
  if (S.running) return;
  S.running = true;
  S.cancel = false;
  renderForm();
  const box = $('faResults');
  box.innerHTML = `<div class="fa-progress"><p>正在搜索装配… <b id="faEvals">0</b> 种组合</p><i><em id="faBar"></em></i><button type="button" class="btn btn-ghost" data-fa-cancel>停止</button></div>`;
  const t0 = performance.now();
  try {
    const { results, tankType, resistMode, roles, placed, selfRep } = await search((n) => {
      const el = $('faEvals'); if (el) el.textContent = ctx.formatNumber(n);
      const bar = $('faBar'); if (bar) bar.style.width = Math.min(95, n / 25) + '%';
    });
    S.results = results;
    renderResults(results, { tankType, resistMode, roles, placed, selfRep }, (performance.now() - t0) / 1000);
  } catch (err) {
    box.innerHTML = `<div class="fa-empty">${err.message === 'cancelled' ? '已停止' : ctx.esc(err.message)}</div>`;
  } finally {
    S.running = false;
    renderForm();
  }
}

function renderResults(results, { tankType, resistMode, roles, placed, selfRep }, secs) {
  const { esc, formatNumber: num, formatISK: isk, data, FE } = ctx;
  const box = $('faResults');
  if (!results.length) { box.innerHTML = '<div class="fa-empty">没有找到可行的装配</div>'; return; }
  const name = (id) => data.types.get(id)?.name || id;
  const aimed = A.target !== 'any' || A.range !== 'any';
  const aimText = aimed ? '对' + (A.target !== 'any' ? ctx.FE.TARGETS[A.target].name : '任意目标') + (A.range !== 'any' ? ` @ ${RANGES[A.range] / 1000} km` : '') + ' · ' : '';
  const roleText = roles.length ? roles.map((r) => ROLE_NAME[r]).join(' / ') + (placed.length ? `（预留${placed.join('、')}）` : '') + ' · ' : '';
  box.innerHTML = `<p class="fa-meta">${aimText}${roleText}${tankType === 'shield' ? '护盾' : '装甲'}坦克 · ${resistMode === 'active' ? '主动抗' : '被动抗'}${selfRep === 'yes' ? ' · 自修' : selfRep === 'no' ? ' · 不自修' : ''} · ${num(evals)} 种组合 · ${secs.toFixed(1)} 秒</p>` + results.map((x, i) => {
    const r = x.r, st = r.st;
    const groups = FE.SLOTS.map((s) => {
      const counts = new Map();
      for (const m of x.fit.slots[s]) if (m) counts.set(m.type, (counts.get(m.type) || 0) + 1);
      if (!counts.size) return '';
      return `<div class="fa-slot"><span>${FE.SLOT_NAME[s]}</span><div>${[...counts].map(([id, n]) => `<em title="${esc(name(id))}"><img src="${IMG(id)}" alt="" width="20" height="20" loading="lazy">${esc(name(id))}${n > 1 ? ` <b>×${n}</b>` : ''}</em>`).join('')}</div></div>`;
    }).join('');
    const charge = x.fit.slots.high.find((m) => m?.charge && (data.types.get(m.type)?.turret || data.types.get(m.type)?.launcher))?.charge;
    const drones = x.fit.drones.map((d) => `<em><img src="${IMG(d.type)}" alt="" width="20" height="20" loading="lazy">${esc(name(d.type))} <b>×${d.count}</b></em>`).join('');
    return `<div class="fa-result${i === 0 ? ' best' : ''}">
      <div class="fa-result-head"><b>${i === 0 ? '推荐方案' : '备选方案'}</b>${r.met ? '' : '<span class="fa-unmet">未满足全部要求</span>'}<button type="button" class="btn btn-primary" data-fa-apply="${i}">套用</button></div>
      <div class="fa-stats">
        ${roles.includes('logi') ? `<div><span>远程维修</span><b>${r.remote.toFixed(0)}<small> HP/s</small></b></div>` : ''}
        ${roles.includes('mining') ? `<div><span>采矿</span><b>${(r.mining * 60).toFixed(0)}<small> m³/分</small></b></div>` : ''}
        ${roles.includes('hauler') ? `<div><span>货柜</span><b>${num(Math.round(r.cargo))}<small> m³</small></b></div>` : ''}
        ${r.dps >= 1 || !roles.some((x) => ['logi', 'mining', 'hauler'].includes(x)) ? (aimed ? `<div title="纸面 DPS ${r.paper.toFixed(0)}"><span>有效 DPS</span><b>${r.dps.toFixed(0)}<small> / ${r.paper.toFixed(0)}</small></b></div>` : `<div><span>DPS</span><b>${r.dps.toFixed(0)}</b></div>`) : ''}
        <div><span>EHP</span><b>${num(Math.round(r.ehp))}</b></div>
        <div><span>速度</span><b>${r.speed.toFixed(0)}</b></div>
        <div><span>电容</span><b class="${st.capacitor.stable ? 'good' : 'bad'}">${st.capacitor.stable ? (st.capacitor.level * 100).toFixed(0) + '%' : Math.round(st.capacitor.lasts / 60) + ' 分'}</b></div>
        ${A.goal === 'pve' ? `<div><span>主动坦</span><b>${r.active.toFixed(0)}</b></div>` : ''}
        <div><span>估价</span><b>${r.cost ? isk(r.cost) : '—'}</b></div>
      </div>
      ${groups}
      ${charge ? `<div class="fa-slot"><span>弹药</span><div><em><img src="${IMG(charge)}" alt="" width="20" height="20" loading="lazy">${esc(name(charge))}</em></div></div>` : ''}
      ${drones ? `<div class="fa-slot"><span>无人机</span><div>${drones}</div></div>` : ''}
      ${A.implants ? `<div class="fa-slot"><span>植入体</span><div>${x.implantPlan?.items.length ? x.implantPlan.items.map((it) => `<em title="${esc(name(it.id) + ' · ' + it.effect)}"><img src="${IMG(it.id)}" alt="" width="20" height="20" loading="lazy">${esc(name(it.id))}</em>`).join('') + `<small class="fa-imp-total">${x.implantPlan.cost ? isk(x.implantPlan.cost) : ''}</small>` : '<small class="fa-imp-total">没有能提升这套装配的植入体</small>'}</div></div>` : ''}
    </div>`;
  }).join('');
}


// ---------- 智能植入体（只推荐植入体，装备不动）----------
const IS = { plans: [], running: false };

export function openImplantAdvisor() {
  const fit = ctx.getFit();
  if (!fit) { ctx.showToast('请先选择舰船并装好装备', 'error'); return; }
  let modal = $('fitImpModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitImpModal';
    modal.className = 'modal fa-modal';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `<div class="modal-backdrop"></div><div class="modal-content fa-content fa-imp-content">
      <div class="modal-header"><h3>智能植入体</h3><button class="modal-close" data-fi-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body fa-body"><form class="fa-form" id="fiForm"></form><div class="fa-results" id="fiResults"></div></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onImpClick);
    modal.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.fiNum) { A[t.dataset.fiNum] = Math.max(0, Number(t.value) || 0); ctx.store.setJSON(KEY, A); }
    });
    modal.addEventListener('submit', (e) => { e.preventDefault(); runImplants(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.stopImmediatePropagation(); closeImp(); } }, true);
  }
  modal.hidden = false;
  IS.plans = [];
  renderImpForm();
  $('fiResults').innerHTML = '<div class="fa-empty">保持当前装备不变，按目标挑 1–10 号槽的植入体。设好后点「推荐植入体」</div>';
}

function closeImp() {
  S.cancel = true;
  const m = $('fitImpModal');
  if (m) m.hidden = true;
}

function renderImpForm() {
  const { esc, data } = ctx;
  const fit = ctx.getFit();
  const ship = data.types.get(fit.ship);
  const P = shipProfile(ship);
  const roles = A.role === 'combat' ? [] : P.roles;
  const job = roles.find((r) => ['logi', 'mining', 'hauler'].includes(r));
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-fi-set="${k}" data-v="${v}" class="${String(A[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const section = (title, body) => `<section class="fa-sec"><h4>${title}</h4>${body}</section>`;
  const bound = Boolean(ctx.esiLevels());
  const mods = ctx.FE.SLOTS.reduce((n, s) => n + (fit.slots[s] || []).filter(Boolean).length, 0);
  const cur = (fit.implants || []).length;
  $('fiForm').innerHTML = `
    <div class="fa-ship"><img src="${IMG(ship.id)}" alt="" width="32" height="32"><b>${esc(ship.name)}</b>${P.roles.map((r) => `<span class="fa-role">${ROLE_NAME[r]}</span>`).join('')}</div>
    <p class="fa-note">当前装配 ${mods} 件装备${cur ? `，已装 ${cur} 个植入体（推荐时从空白算起，套用后替换）` : ''}${mods ? '' : '：还没有装备，建议先装好装备或用「智能装配」'}</p>
    ${section('目标', job ? `<p class="fa-note">${ROLE_NAME[job]}船按${{ logi: '远程维修量', mining: '采矿量', hauler: '货柜容量与起跳时间' }[job]}挑植入体，其次是坦克</p>`
      : `<div class="fa-goals">${GOALS.map(([k, l, d]) => `<button type="button" class="fa-goal${A.goal === k ? ' active' : ''}" data-fi-set="goal" data-v="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>`)}
    ${section('预算与技能', `<div class="fa-field"><label>植入体预算</label><div class="fa-unit"><input type="number" class="fa-input" min="0" step="50" value="${A.impBudget}" data-fi-num="impBudget"><span>百万 ISK</span></div><p class="fa-hint">整套植入体按全服均价计，0 为不限；高级套装往往要数十亿</p></div>
      <div class="fa-field"><label>技能</label>${seg('skills', [['max', '全 5 级'], ['esi', bound ? '按角色' : '按角色（未读取）']])}<p class="fa-hint">${A.skills === 'esi' ? '只推荐角色技能够用的植入体' : '按全部技能 5 级计算'}</p></div>`)}
    <button type="submit" class="btn btn-primary fa-go">${IS.running ? '计算中…' : '推荐植入体'}</button>`;
}

function onImpClick(e) {
  if (e.target.closest('[data-fi-close]') || e.target.classList.contains('modal-backdrop')) { closeImp(); return; }
  const set = e.target.closest('[data-fi-set]');
  if (set) {
    const k = set.dataset.fiSet;
    if (k === 'skills' && set.dataset.v === 'esi' && !ctx.esiLevels()) { ctx.showToast('请先在装配页切换到「按 ESI 角色」读取技能', 'error'); return; }
    A[k] = set.dataset.v;
    ctx.store.setJSON(KEY, A);
    renderImpForm();
    return;
  }
  if (e.target.closest('[data-fa-cancel]')) { S.cancel = true; return; }
  const apply = e.target.closest('[data-fi-apply]');
  if (apply) {
    const p = IS.plans[Number(apply.dataset.fiApply)];
    const fit = clone(ctx.getFit());
    fit.implants = [...p.implants];
    ctx.applyFit(fit);
    closeImp();
    ctx.showToast(`已套用 ${p.implants.length} 个植入体`, 'success');
  }
}

async function runImplants() {
  if (IS.running) return;
  IS.running = true;
  S.cancel = false;
  renderImpForm();
  const box = $('fiResults');
  box.innerHTML = `<div class="fa-progress"><p>正在比较植入体… <b id="fiEvals">0</b> 种组合</p><i><em id="fiBar"></em></i><button type="button" class="btn btn-ghost" data-fa-cancel>停止</button></div>`;
  const t0 = performance.now();
  try {
    const fit = ctx.getFit();
    setupScoring(ctx.data.types.get(fit.ship));
    evals = 0;
    const plans = await recommendImplants(fit, () => {
      const el = $('fiEvals'); if (el) el.textContent = ctx.formatNumber(evals);
      const bar = $('fiBar'); if (bar) bar.style.width = Math.min(95, evals / 10) + '%';
    });
    IS.plans = plans;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    box.innerHTML = plans.length
      ? `<p class="fa-meta">相对不装植入体 · ${ctx.formatNumber(evals)} 种组合 · ${secs} 秒</p>` + plans.map((p, i) => implantPlanHtml(p, i, 'data-fi-apply')).join('') +
        '<p class="fa-hint fa-imp-foot">价格为全服均价</p>'
      : '<div class="fa-empty">没有能提升这套装配的植入体（预算内或技能允许的范围内）</div>';
  } catch (err) {
    box.innerHTML = `<div class="fa-empty">${err.message === 'cancelled' ? '已停止' : ctx.esc(err.message)}</div>`;
  } finally {
    IS.running = false;
    renderImpForm();
  }
}
