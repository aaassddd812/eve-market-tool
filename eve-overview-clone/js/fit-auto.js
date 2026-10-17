// ===== 智能装配 =====
// 按目标（输出 / 坦克 / 均衡 / 刷怪主动坦 / 风筝）与约束（最低 DPS、EHP、速度、电容稳定、预算、装备等级、技能）自动搜索装配。
// 打分完全交给装配引擎（computeFit + fitStats，与游戏规则一致），搜索流程：
//   1. 候选：按船、装备等级、技能、预算筛选；同一族（分组 + 尺寸）只留「允许范围内最好的」与「最省 CPU / 电网的」两档
//   2. 武器：逐个试装满安装座（配最高伤害弹药），取 DPS 最高的两种方案；有无人机挂舱时同时装上最好的无人机
//   3. 贪心：中 / 低 / 改装件轮流放入让得分提升最多、且资源装得下的装备；装不下时尝试加 CPU / 电网辅助装备后再填
//   4. 替换：逐格尝试换成其他候选，直到不再变好
// 技能：全 5 级，或按 ESI 角色（候选只保留角色能用的装备与弹药，属性按角色技能计算）。
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
  mid: { shield: [38, 77, 295, 40, 1156], any: [61, 43, 46, 76, 212, 213, 1396, 644, 646] },
  low: { armor: [329, 326, 328, 98, 62, 1150, 1199], any: [60, 59, 205, 302, 367, 645, 1988, 4067, 766, 763, 764, 767, 768, 770, 211, 1395, 1292] },
  rig: { shield: [774], armor: [773], any: [775, 776, 777, 778, 779, 781, 782] }
};
// 抗性与自修：主动抗（需激活的强化 / 增强器）与被动抗（增效器、薄膜 / 附甲），自修（回充增量器 / 维修组件）
const RESIST_GROUPS = { shield: { active: [77], passive: [295] }, armor: { active: [328, 1150], passive: [326, 98] } };
const REP_GROUPS = [40, 1156, 62, 1199];
const FITTING = { cpu: [285], power: [769], rigCpuPower: [781] };   // CPU 增强设备、反应堆控制元件、改装件核心
const TACKLE = [52, 65];   // 扰频器、停滞网（PVP 预留）
// 武器改装件只配对应的武器：能量 775 / 混合 776 / 射弹 777 / 发射器 779；无人机改装件 778
const WEAPON_RIG = { 53: 775, 74: 776, 55: 777 };
const RIG_EXCLUDE = /Cargohold|Fuel|Thermal Shielding|Hyperspatial|Warp|Salvage|Signal|Targeting|Ionic|Gravity|Memetic|Particle|Inverted|Emission Scope|Sharpener|Anchor|Drone Control Range|Drone Durability|Drone Speed|Drone Mining|Repair Augmentor|Sentry|Stasis|Remote|Projector|Ancillary Current Router|Processor Overclocking/i;
const PROP = 46;

const A = { goal: 'dps', tank: 'auto', resist: 'auto', selfRep: 'auto', weapon: 'auto', meta: 't2', budget: 0, minDps: 0, minEhp: 0, minSpeed: 0, capStable: false, tackle: false, skills: 'max' };
const S = { running: false, cancel: false, results: [] };

export function initAutoFit(context) {
  ctx = context;
  Object.assign(A, ctx.store.getJSON(KEY, {}) || {});
  if (!METAS[A.meta]) A.meta = A.meta === 'all' ? 'officer' : 't2';
}

// ---------- 打分 ----------
function skillsArg() { return A.skills === 'esi' && ctx.esiLevels() ? ctx.esiLevels() : 'max'; }
const ln = (x) => Math.log(Math.max(0, x) + 1);

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
  const dps = st.weapon.total, ehp = st.defense.ehp, speed = st.navigation.velocity;
  const active = st.defense.repsEhp.shield + st.defense.repsEhp.armor + st.defense.repsEhp.hull + st.defense.passiveRegenEhp;
  // 次要项：武器射程、锁定距离、电容续航（权重很小，只在主要指标相同时让索敌 / 电容类装备有用武之地）
  const range = st.weapons.length ? st.weapons.reduce((t, w) => t + w.range + w.falloff, 0) / st.weapons.length / 1000 : 0;
  const capTerm = st.capacitor.stable ? 1 + st.capacitor.level : Math.min(1, (st.capacitor.lasts || 0) / 600);
  const extra = 0.03 * ln(range) + 0.01 * ln(st.targeting.range / 1000) + 0.03 * capTerm;
  let score;
  if (A.goal === 'tank') score = ln(ehp) + 0.15 * ln(dps) + 0.05 * ln(speed);
  else if (A.goal === 'balanced') score = ln(dps) + ln(ehp) + 0.05 * ln(speed);
  else if (A.goal === 'pve') score = ln(dps) + ln(active) + 0.2 * ln(ehp);
  else if (A.goal === 'kite') score = ln(dps) + 1.2 * ln(speed) + 0.2 * ln(ehp);
  else score = ln(dps) + 0.15 * ln(ehp) + 0.05 * ln(speed);
  // 约束：不满足时大幅扣分（差得越多扣得越多）
  const short = (v, min) => (min > 0 && v < min ? 2 + 5 * (1 - v / min) : 0);
  let penalty = short(dps, A.minDps) + short(ehp, A.minEhp) + short(speed, A.minSpeed);
  // 要求自修：维修量计入得分，没有维修装备时扣分
  const reps = st.defense.reps.shield + st.defense.reps.armor;
  if (A.selfRep === 'yes') { score += 0.5 * ln(active); if (!reps) penalty += 2; }
  if ((A.capStable || A.goal === 'pve') && !st.capacitor.stable) penalty += 2 + 3 * (1 - Math.min(1, (st.capacitor.lasts || 0) / 900));
  const cost = price(fit);
  if (A.budget > 0 && cost > A.budget * 1e6) penalty += 2 + 5 * (cost / (A.budget * 1e6) - 1);
  return { st, ok, score: score + extra - penalty, met: penalty === 0, cost, dps, ehp, speed, active };
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
  const all = [...data.types.values()];
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
    if (A.selfRep === 'no') for (const id of REP_GROUPS) groups.delete(id);
    bySlot[slot] = prune(all.filter((t) => t.slot === slot && groups.has(t.group) && fits(t) && !(slot === 'rig' && RIG_EXCLUDE.test(t.en || ''))));
  }
  // 极化武器（装上后抗性归零）不参与
  const polarized = (t) => t.effects.some((e) => /^resistanceKiller/.test(data.effects.get(e)?.name || ''));
  const weapons = prune(all.filter((t) => t.slot === 'high' && (t.turret || t.launcher) && fits(t) && !polarized(t)), 2);
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
  return { bySlot, weapons, charges, drones, fighters, fitting, tackle };
}

// 武器用伤害最高的弹药
function bestCharge(weapon, charges) {
  const { FE } = ctx;
  let best = null, bestDmg = 0;
  for (const c of charges) {
    if (!FE.chargeFits(weapon, c)) continue;
    const dmg = FE.DAMAGE.reduce((s, a) => s + (c.attrs.get(a) || 0), 0);
    if (dmg > bestDmg) { bestDmg = dmg; best = c; }
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
  for (const c of scored.slice(0, 4)) {
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
      if (!orig) continue;
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

  // 坦克类型：自动时按舰船护盾 / 装甲与中低槽数判断
  let tankType = A.tank;
  if (tankType === 'auto') {
    const sh = probe.st.defense.shield.hp, ar = probe.st.defense.armor.hp;
    tankType = (sh / Math.max(1, ar)) * ((slots.mid || 1) / Math.max(1, slots.low || 1)) >= 1 ? 'shield' : 'armor';
  }
  // 抗性：自动时盾抗船用主动抗、甲抗船用被动抗
  const resistMode = A.resist === 'auto' ? (tankType === 'shield' ? 'active' : 'passive') : A.resist;
  const cands = buildCandidates(shipType, tankType, resistMode);
  CHARGES = cands.charges;
  fuelCache.clear();
  evals = 0;
  const progress = () => onProgress(evals);

  // PVP 预留：扰频器 + 停滞网
  let midStart = 0;
  if (A.tackle) for (const t of cands.tackle) if (midStart < base.slots.mid.length) base.slots.mid[midStart++] = mod(t);

  // 无人机
  if (A.weapon === 'auto' || A.weapon === 'drone') base.drones = [...bestDrones(base, cands.drones), ...bestFighters(base, cands.fighters)];

  // 武器方案
  const options = [];
  const res = probe.st.resources;
  if (A.weapon !== 'drone') {
    for (const w of cands.weapons) {
      if (A.weapon === 'turret' && !w.turret) continue;
      if (A.weapon === 'missile' && !w.launcher) continue;
      const n = Math.min(slots.high || 0, w.turret ? res.turrets.total : res.launchers.total);
      if (!n) continue;
      const charge = bestCharge(w, cands.charges);
      if (!charge) continue;
      const f = clone(base);
      for (let i = 0; i < n; i++) f.slots.high[i] = mod(w, charge);
      const r = evaluate(f);
      await tick(progress);
      if (r && r.ok) options.push({ f, r, w });
    }
  }
  options.sort((a, b) => b.r.dps - a.r.dps);
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
    // 武器改装件只留与这套武器匹配的
    const rigOk = (t) => ![775, 776, 777, 779].includes(t.group) || (o.w && (o.w.launcher ? t.group === 779 : t.group === WEAPON_RIG[o.w.group]));
    const oc = { ...cands, bySlot: { ...cands.bySlot, rig: cands.bySlot.rig.filter(rigOk) } };
    let r = await greedy(f, oc, progress);
    let best = { fit: f, r };
    if (['mid', 'low', 'rig'].some((s) => f.slots[s].some((m) => !m))) best = await withFitting(f, oc, r, progress);
    best.r = await swapPass(best.fit, oc, best.r, progress);
    best.r = await fillEmpty(best.fit, oc, best.r, progress);
    results.push(best);
  }
  results.sort((a, b) => b.r.score - a.r.score);
  return { results, tankType, resistMode, evals };
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

function renderForm() {
  const esc = ctx.esc;
  const ship = ctx.data.types.get(ctx.getFit().ship);
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-fa-set="${k}" data-v="${v}" class="${String(A[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const bound = Boolean(ctx.esiLevels());
  $('faForm').innerHTML = `
    <div class="fa-ship"><img src="${IMG(ship.id)}" alt="" width="32" height="32"><b>${esc(ship.name)}</b></div>
    <div class="fa-field"><label>目标</label>
      <div class="fa-goals">${GOALS.map(([k, l, d]) => `<button type="button" class="fa-goal${A.goal === k ? ' active' : ''}" data-fa-set="goal" data-v="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div></div>
    <div class="fa-field"><label>最低要求 <small>0 为不限</small></label>
      <div class="fa-grid3">
        <label class="fa-num"><span>DPS</span><input type="number" min="0" step="10" value="${A.minDps}" data-fa-num="minDps"></label>
        <label class="fa-num"><span>EHP</span><input type="number" min="0" step="1000" value="${A.minEhp}" data-fa-num="minEhp"></label>
        <label class="fa-num"><span>速度 m/s</span><input type="number" min="0" step="50" value="${A.minSpeed}" data-fa-num="minSpeed"></label>
      </div>
      <div class="fa-checks"><label class="pi-check"><input type="checkbox" data-fa-check="capStable"${A.capStable ? ' checked' : ''}><span>电容稳定</span></label>
      <label class="pi-check"><input type="checkbox" data-fa-check="tackle"${A.tackle ? ' checked' : ''}><span>预留扰频器和停滞网（PVP）</span></label></div></div>
    <div class="fa-field"><label>坦克</label>${seg('tank', [['auto', '自动'], ['shield', '护盾'], ['armor', '装甲']])}</div>
    <div class="fa-field"><label>抗性 <small>自动：盾抗主动抗，甲抗被动抗</small></label>${seg('resist', [['auto', '自动'], ['active', '主动抗'], ['passive', '被动抗']])}</div>
    <div class="fa-field"><label>自修</label>${seg('selfRep', [['auto', '自动'], ['yes', '自修'], ['no', '不自修']])}</div>
    <div class="fa-field"><label>武器</label>${seg('weapon', [['auto', '自动'], ['turret', '炮台'], ['missile', '导弹'], ['drone', '仅无人机']])}</div>
    <div class="fa-field"><label>装备等级 <small>逐级放宽</small></label>${seg('meta', [['t1', 'T1'], ['t2', '+T2'], ['faction', '+势力'], ['deadspace', '+死亡空间'], ['officer', '+官员']])}</div>
    <div class="fa-field"><label>预算 <small>百万 ISK，0 为不限，按全服均价</small></label><input type="number" class="fa-input" min="0" step="10" value="${A.budget}" data-fa-num="budget"></div>
    <div class="fa-field"><label>技能</label>${seg('skills', [['max', '全 5 级'], ['esi', bound ? '按角色' : '按角色（未读取）']])}</div>
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
    fit.name = `智能装配 · ${GOALS.find((g) => g[0] === A.goal)[1]}`;
    ctx.applyFit(fit);
    close();
    ctx.showToast('已套用智能装配', 'success');
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.faNum) { A[t.dataset.faNum] = Math.max(0, Number(t.value) || 0); ctx.store.setJSON(KEY, A); }
  else if (t.dataset.faCheck) { A[t.dataset.faCheck] = t.checked; ctx.store.setJSON(KEY, A); }
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
    const { results, tankType, resistMode } = await search((n) => {
      const el = $('faEvals'); if (el) el.textContent = ctx.formatNumber(n);
      const bar = $('faBar'); if (bar) bar.style.width = Math.min(95, n / 25) + '%';
    });
    S.results = results;
    renderResults(results, tankType, resistMode, (performance.now() - t0) / 1000);
  } catch (err) {
    box.innerHTML = `<div class="fa-empty">${err.message === 'cancelled' ? '已停止' : ctx.esc(err.message)}</div>`;
  } finally {
    S.running = false;
    renderForm();
  }
}

function renderResults(results, tankType, resistMode, secs) {
  const { esc, formatNumber: num, formatISK: isk, data, FE } = ctx;
  const box = $('faResults');
  if (!results.length) { box.innerHTML = '<div class="fa-empty">没有找到可行的装配</div>'; return; }
  const name = (id) => data.types.get(id)?.name || id;
  box.innerHTML = `<p class="fa-meta">${tankType === 'shield' ? '护盾' : '装甲'}坦克 · ${resistMode === 'active' ? '主动抗' : '被动抗'}${A.selfRep === 'yes' ? ' · 自修' : A.selfRep === 'no' ? ' · 不自修' : ''} · ${num(evals)} 种组合 · ${secs.toFixed(1)} 秒</p>` + results.map((x, i) => {
    const r = x.r, st = r.st;
    const groups = FE.SLOTS.map((s) => {
      const counts = new Map();
      for (const m of x.fit.slots[s]) if (m) counts.set(m.type, (counts.get(m.type) || 0) + 1);
      if (!counts.size) return '';
      return `<div class="fa-slot"><span>${FE.SLOT_NAME[s]}</span><div>${[...counts].map(([id, n]) => `<em title="${esc(name(id))}"><img src="${IMG(id)}" alt="" width="20" height="20" loading="lazy">${esc(name(id))}${n > 1 ? ` <b>×${n}</b>` : ''}</em>`).join('')}</div></div>`;
    }).join('');
    const charge = x.fit.slots.high.find((m) => m?.charge)?.charge;
    const drones = x.fit.drones.map((d) => `<em><img src="${IMG(d.type)}" alt="" width="20" height="20" loading="lazy">${esc(name(d.type))} <b>×${d.count}</b></em>`).join('');
    return `<div class="fa-result${i === 0 ? ' best' : ''}">
      <div class="fa-result-head"><b>${i === 0 ? '推荐方案' : '备选方案'}</b>${r.met ? '' : '<span class="fa-unmet">未满足全部要求</span>'}<button type="button" class="btn btn-primary" data-fa-apply="${i}">套用</button></div>
      <div class="fa-stats">
        <div><span>DPS</span><b>${r.dps.toFixed(0)}</b></div>
        <div><span>EHP</span><b>${num(Math.round(r.ehp))}</b></div>
        <div><span>速度</span><b>${r.speed.toFixed(0)}</b></div>
        <div><span>电容</span><b class="${st.capacitor.stable ? 'good' : 'bad'}">${st.capacitor.stable ? (st.capacitor.level * 100).toFixed(0) + '%' : Math.round(st.capacitor.lasts / 60) + ' 分'}</b></div>
        ${A.goal === 'pve' ? `<div><span>主动坦</span><b>${r.active.toFixed(0)}</b></div>` : ''}
        <div><span>估价</span><b>${r.cost ? isk(r.cost) : '—'}</b></div>
      </div>
      ${groups}
      ${charge ? `<div class="fa-slot"><span>弹药</span><div><em><img src="${IMG(charge)}" alt="" width="20" height="20" loading="lazy">${esc(name(charge))}</em></div></div>` : ''}
      ${drones ? `<div class="fa-slot"><span>无人机</span><div>${drones}</div></div>` : ''}
    </div>`;
  }).join('');
}

