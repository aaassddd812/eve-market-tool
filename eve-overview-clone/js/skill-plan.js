// ===== 技能规划 =====
// 选想开的船（可带装配：最近常见 / 当前 / 我的装配）、发展方向或单个技能，按已绑定角色的技能算出还要练什么：
// 前置技能逐级展开；先排「能开 / 能用」，再排「用好」（船体技能、主武器、坦克与支援技能到 IV 级）和发展方向；
// 每个阶段里先练耗时最短的目标（贪心：每次挑剩下的目标里还差最少的），前置技能排在前面。
// 训练时间：主属性 + 副属性 / 2 技能点每分钟（属性含植入体加成），Alpha 克隆减半；可算最佳属性重新分配（每项 17–27，共 99 点）。
// 训练队列：ESI 只开放了读取（esi-skills.read_skillqueue.v1），没有写入接口，网页无法直接改游戏里的训练队列；
// 「复制技能清单」每行「技能名 等级」，在游戏技能窗口的训练队列里 Ctrl+V 即可整批加入。
import { commonFit } from './fit-kb.js?v=v27';

let ctx;   // data, FE, getFit, savedFits, normalize, hasEsi, esiFetch, getEsiToken, getImplants, openEsiBind, esc, formatNumber, showToast, store
const KEY = 'eve-skill-plan-v1';
const AT = { rank: 275, pri: 180, sec: 181 };
// [属性 id, ESI 字段, 名称, 植入体加成属性]
const ATTRS = [[164, 'charisma', '魅力', 175], [165, 'intelligence', '智力', 176], [166, 'memory', '记忆', 177], [167, 'perception', '感知', 178], [168, 'willpower', '毅力', 179]];
const ATTR_OF = Object.fromEntries(ATTRS.map(([id, k]) => [id, k]));
const DEFAULT_ATTRS = { charisma: 19, intelligence: 20, memory: 20, perception: 20, willpower: 20 };   // 新角色默认属性
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];
const QUEUE_MAX = 150;   // 游戏训练队列最多 150 项
const IMG = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;
const $ = (id) => document.getElementById(id);
const spForLevel = (rank, level) => (level <= 0 ? 0 : Math.ceil(250 * rank * Math.pow(Math.sqrt(32), level - 1)));

// 发展方向（按英文名找技能，数据里没有的跳过）
const DIRS = [
  { id: 'core', name: '基础属性', desc: '装配、电容、导航、锁定，所有船都受益', skills: [['CPU Management', 5], ['Power Grid Management', 5], ['Capacitor Management', 4], ['Capacitor Systems Operation', 4], ['Spaceship Command', 4], ['Navigation', 4], ['Evasive Maneuvering', 4], ['Warp Drive Operation', 4], ['Target Management', 4], ['Long Range Targeting', 4], ['Signature Analysis', 4], ['Weapon Upgrades', 4], ['Advanced Weapon Upgrades', 3], ['Thermodynamics', 3], ['Afterburner', 4], ['Acceleration Control', 3], ['High Speed Maneuvering', 3]] },
  { id: 'gunnery', name: '炮台输出', desc: '射击学支援技能，所有炮台都吃', skills: [['Gunnery', 5], ['Motion Prediction', 4], ['Rapid Firing', 4], ['Sharpshooter', 4], ['Surgical Strike', 4], ['Trajectory Analysis', 4], ['Controlled Bursts', 4]] },
  { id: 'missile', name: '导弹输出', desc: '导弹支援技能，所有发射器都吃', skills: [['Missile Launcher Operation', 5], ['Missile Bombardment', 4], ['Missile Projection', 4], ['Warhead Upgrades', 4], ['Guided Missile Precision', 4], ['Target Navigation Prediction', 4], ['Rapid Launch', 4]] },
  { id: 'drone', name: '无人机', desc: '无人机操作、伤害、速度与耐久', skills: [['Drones', 5], ['Light Drone Operation', 4], ['Medium Drone Operation', 4], ['Heavy Drone Operation', 4], ['Drone Interfacing', 4], ['Drone Avionics', 4], ['Drone Navigation', 4], ['Drone Sharpshooting', 4], ['Drone Durability', 4]] },
  { id: 'shield', name: '护盾坦克', desc: '护盾容量、回充、抗性装备', skills: [['Shield Management', 4], ['Shield Operation', 4], ['Shield Upgrades', 4], ['Tactical Shield Manipulation', 4], ['Shield Compensation', 4], ['EM Shield Compensation', 3], ['Thermal Shield Compensation', 3], ['Kinetic Shield Compensation', 3], ['Explosive Shield Compensation', 3]] },
  { id: 'armor', name: '装甲坦克', desc: '装甲板、维修与抗性', skills: [['Hull Upgrades', 4], ['Mechanics', 4], ['Repair Systems', 4], ['Armor Layering', 4], ['EM Armor Compensation', 3], ['Thermal Armor Compensation', 3], ['Kinetic Armor Compensation', 3], ['Explosive Armor Compensation', 3]] },
  { id: 'logi', name: '后勤遥修', desc: '遥修护盾 / 装甲、传能', skills: [['Shield Emission Systems', 4], ['Remote Armor Repair Systems', 4], ['Capacitor Emission Systems', 4], ['Logistics Cruisers', 3]] },
  { id: 'ewar', name: '电子战', desc: '网子、扰断、阻尼、标记、ECM', skills: [['Electronic Warfare', 4], ['Propulsion Jamming', 4], ['Sensor Linking', 4], ['Target Painting', 4], ['Weapon Disruption', 4], ['Signal Suppression', 3]] },
  { id: 'explore', name: '探索', desc: '扫描信号、数据 / 遗迹站点、隐形', skills: [['Astrometrics', 4], ['Astrometric Rangefinding', 4], ['Astrometric Pinpointing', 3], ['Astrometric Acquisition', 3], ['Hacking', 4], ['Archaeology', 4], ['Cloaking', 4], ['Survey', 3]] },
  { id: 'mining', name: '采矿', desc: '采矿产量、采矿驳船、冰矿与精炼', skills: [['Mining', 4], ['Astrogeology', 4], ['Mining Frigate', 3], ['Mining Barge', 4], ['Mining Upgrades', 4], ['Ice Harvesting', 3], ['Reprocessing', 4], ['Reprocessing Efficiency', 3]] },
  { id: 'industry', name: '工业制造', desc: '制造、科研、并行作业', skills: [['Industry', 5], ['Advanced Industry', 4], ['Mass Production', 4], ['Advanced Mass Production', 3], ['Science', 4], ['Laboratory Operation', 4], ['Advanced Laboratory Operation', 3], ['Metallurgy', 4], ['Research', 4]] },
  { id: 'trade', name: '贸易', desc: '订单数量、税费、远程下单', skills: [['Trade', 4], ['Retail', 4], ['Wholesale', 3], ['Accounting', 4], ['Broker Relations', 4], ['Advanced Broker Relations', 3], ['Marketing', 3], ['Procurement', 3], ['Daytrading', 3]] },
  { id: 'pi', name: '行星工业', desc: '更多星球、更大的指挥中心', skills: [['Interplanetary Consolidation', 4], ['Command Center Upgrades', 4], ['Planetology', 3], ['Advanced Planetology', 3], ['Remote Sensing', 3]] },
  { id: 'command', name: '舰队指挥', desc: '指挥脉冲与舰队加成', skills: [['Leadership', 4], ['Wing Command', 3], ['Shield Command', 4], ['Armored Command', 4], ['Skirmish Command', 4], ['Information Command', 4]] }
];
// 「用好」：按装配里有什么自动加的支援技能
const GOOD = {
  core: [['CPU Management', 4], ['Power Grid Management', 4], ['Capacitor Management', 4], ['Capacitor Systems Operation', 4], ['Navigation', 4], ['Evasive Maneuvering', 4], ['Target Management', 4], ['Signature Analysis', 4]],
  turret: [['Gunnery', 4], ['Motion Prediction', 4], ['Rapid Firing', 4], ['Sharpshooter', 4], ['Surgical Strike', 4], ['Trajectory Analysis', 4], ['Weapon Upgrades', 4]],
  launcher: [['Missile Launcher Operation', 4], ['Missile Bombardment', 4], ['Missile Projection', 4], ['Warhead Upgrades', 4], ['Guided Missile Precision', 4], ['Target Navigation Prediction', 4], ['Rapid Launch', 4], ['Weapon Upgrades', 4]],
  drone: [['Drones', 5], ['Drone Interfacing', 4], ['Drone Avionics', 4], ['Drone Navigation', 4], ['Drone Durability', 4]],
  shield: [['Shield Management', 4], ['Shield Operation', 4], ['Shield Upgrades', 4], ['Tactical Shield Manipulation', 4]],
  armor: [['Hull Upgrades', 4], ['Mechanics', 4], ['Repair Systems', 4], ['Armor Layering', 4]]
};
const SHIELD_GROUP = 1209, ARMOR_GROUP = 1210;

const P = {
  targets: [], seq: 0,
  opt: { queue: true, alpha: false, remap: false, lang: 'zh' },
  tab: 'ship', skillLevel: 4, showAll: false
};
let C = null;            // 角色：{ id, name, trained, sp, queue, attrs, implants, error }
let charP = null;
let root = null;
let plan = null;         // 最近一次规划结果

export function initPlan(context) {
  ctx = context;
  try {
    const st = ctx.store.getJSON(KEY, null);
    if (st) {
      P.targets = (st.targets || []).filter((t) => t && (t.kind !== 'ship' || ctx.data?.types?.has?.(t.ship) !== false));
      P.seq = P.targets.reduce((m, t) => Math.max(m, t.id || 0), 0);
      Object.assign(P.opt, st.opt || {});
    }
  } catch { /* 默认 */ }
}
function save() {
  ctx.store.setJSON(KEY, { targets: P.targets.map((t) => (t.src === 'kb' ? { ...t, fit: null, label: '' } : t)), opt: P.opt });
}

// 装配页 / 战场模拟带过来的装配：{ ship, fit, label }
let pending = null;
export function queuePlan(item) { pending = item; }

export function mountPlan(el, restored = false) {
  const fresh = root !== el || !el.dataset.ready;
  root = el;
  if (fresh) {
    el.dataset.ready = '1';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('focusout', (e) => {
      if (!e.target.dataset?.spSearch) return;
      setTimeout(() => { if (!document.activeElement?.closest?.('.sp-search')) root.querySelectorAll('.kb-suggest').forEach((b) => { b.hidden = true; }); }, 150);
    });
  }
  // 绑定的角色变了（或刚绑定）：重新读取
  const want = ctx.hasEsi() ? 'esi' : 'none';
  if (!C || C.mode !== want) { C = null; charP = null; }
  if (pending) {
    const { ship, fit, label } = pending;
    pending = null;
    const t = { id: ++P.seq, kind: 'ship', ship, src: fit ? 'given' : 'hull', fit: fit ? ctx.normalize(JSON.parse(JSON.stringify(fit))) : null, label: label || '', depth: 'good' };
    P.targets = P.targets.filter((x) => !(x.kind === 'ship' && x.ship === ship && x.src === t.src));
    P.targets.unshift(t);
    save();
  }
  if (restored && root.querySelector('.sp-page') && C) return;
  render();
  loadChar();
  for (const t of P.targets) if (t.kind === 'ship' && t.src === 'kb' && !t.fit) resolveKb(t);
}

// ---------- 角色 ----------
function loadChar() {
  if (charP) return charP;
  if (!ctx.hasEsi()) { C = { mode: 'none' }; render(); return Promise.resolve(); }
  charP = (async () => {
    const token = await ctx.getEsiToken();
    const id = token.character_id;
    const get = (p) => ctx.esiFetch(`/characters/${id}${p}`);
    const [sk, q, at, imp] = await Promise.allSettled([get('/skills/'), get('/skillqueue/'), get('/attributes/'), ctx.getImplants()]);
    if (sk.status !== 'fulfilled') throw sk.reason;
    const list = sk.value.skills || [];
    C = {
      mode: 'esi', id, name: token.character_name || `角色 ${id}`,
      trained: new Map(list.map((x) => [x.skill_id, x.trained_skill_level || 0])),
      sp: new Map(list.map((x) => [x.skill_id, x.skillpoints_in_skill || 0])),
      totalSp: sk.value.total_sp || 0,
      queue: q.status === 'fulfilled' && Array.isArray(q.value) ? q.value.filter((x) => !x.finish_date || Date.parse(x.finish_date) > Date.now()).sort((a, b) => a.queue_position - b.queue_position) : null,
      queueError: q.status === 'rejected' ? q.reason?.message : '',
      attrs: at.status === 'fulfilled' ? at.value : null,
      implants: imp.status === 'fulfilled' && Array.isArray(imp.value) ? imp.value : []
    };
  })().catch((e) => { C = { mode: 'esi', error: e.message || String(e) }; }).finally(() => { render(); });
  return charP;
}
// 植入体加成：{ charisma: +n, … }
function implantBonus() {
  const out = Object.fromEntries(ATTRS.map(([, k]) => [k, 0]));
  for (const id of C?.implants || []) {
    const t = ctx.data.types.get(id);
    if (!t) continue;
    for (const [, k, , bonus] of ATTRS) out[k] += t.attrs.get(bonus) || 0;
  }
  return out;
}
function baseAttrs() {
  const a = C?.attrs;
  return a ? Object.fromEntries(ATTRS.map(([, k]) => [k, a[k] || DEFAULT_ATTRS[k]])) : { ...DEFAULT_ATTRS };
}
// 已学等级（可选把训练队列里的也算上）
function haveLevels() {
  const have = new Map(C?.trained || []);
  if (P.opt.queue && C?.queue) for (const q of C.queue) have.set(q.skill_id, Math.max(have.get(q.skill_id) || 0, q.finished_level));
  return have;
}

// ---------- 目标的技能需求 ----------
const skillByEn = (() => {
  let map = null;
  return (en) => {
    if (!map) { map = new Map(); for (const t of ctx.data.skills) if (t.en) map.set(t.en, t.id); }
    return map.get(en);
  };
})();
const enList = (list) => list.map(([en, l]) => [skillByEn(en), l]).filter(([id]) => id);
const typeReqs = (id) => ctx.data.types.get(id)?.skills || [];
function fitTypes(fit) {
  const out = [];
  for (const s of ctx.FE.SLOTS) for (const m of fit.slots[s] || []) { if (!m) continue; out.push(m.type); if (m.charge) out.push(m.charge); }
  for (const d of fit.drones || []) out.push(d.type);
  for (const i of fit.implants || []) out.push(typeof i === 'object' ? i.type : i);
  return out.filter((id) => ctx.data.types.has(id));
}
// { need: [[技能, 等级]], good: [[技能, 等级]] }
function reqsOf(t) {
  if (t.kind === 'skill') return { need: [[t.skill, t.level]], good: [] };
  if (t.kind === 'dir') return { need: [], good: enList(DIRS.find((d) => d.id === t.dir)?.skills || []) };
  const need = [...typeReqs(t.ship)];
  const types = t.fit ? fitTypes(t.fit) : [];
  for (const id of types) need.push(...typeReqs(id));
  if (t.depth !== 'good') return { need, good: [] };
  // 用好：船体要求的技能到 IV、武器 / 弹药 / 无人机要求的技能到 IV，再按装配内容加支援技能
  const good = typeReqs(t.ship).map(([s, l]) => [s, Math.max(l, 4)]);
  const T = types.map((id) => ctx.data.types.get(id));
  const isWeapon = (x) => x.turret || x.launcher || x.category === ctx.FE.CAT.drone || x.category === ctx.FE.CAT.charge;
  for (const x of T) if (isWeapon(x)) for (const [s, l] of x.skills) good.push([s, Math.max(l, 4)]);
  good.push(...enList(GOOD.core));
  if (T.some((x) => x.turret)) good.push(...enList(GOOD.turret));
  if (T.some((x) => x.launcher)) good.push(...enList(GOOD.launcher));
  if (t.fit?.drones?.length) good.push(...enList(GOOD.drone));
  const tankGroup = (g) => T.some((x) => x.category === ctx.FE.CAT.module && x.skills.some(([s]) => ctx.data.types.get(s)?.group === g));
  if (tankGroup(SHIELD_GROUP)) good.push(...enList(GOOD.shield));
  if (tankGroup(ARMOR_GROUP)) good.push(...enList(GOOD.armor));
  return { need, good };
}

// ---------- 规划 ----------
function skillInfo(id) {
  const t = ctx.data.types.get(id);
  if (!t) return null;
  return { t, rank: t.attrs.get(AT.rank) || 1, pri: ATTR_OF[t.attrs.get(AT.pri)] || 'intelligence', sec: ATTR_OF[t.attrs.get(AT.sec)] || 'memory' };
}
// 把需求（含前置）按顺序展开成逐级条目；lv 为当前（已规划到的）等级，会被修改。
// onTouch(技能, 等级)：目标用到的每一项（已满足的技能不再追溯前置）
function expand(reqs, lv, onEntry, onTouch) {
  const walk = (s, L, pre, depth) => {
    const info = skillInfo(s);
    if (!info || depth > 25 || L <= 0) return;
    const have = lv.get(s) || 0;
    if (have >= L) { onTouch?.(s, L); return; }
    for (const [p, pl] of info.t.skills) walk(p, pl, true, depth + 1);
    for (let l = (lv.get(s) || 0) + 1; l <= L; l++) { lv.set(s, l); onEntry({ skill: s, level: l, pre }); }
    onTouch?.(s, L);
  };
  for (const [s, L] of reqs) walk(s, L, false, 0);
}
// 每个条目的技能点（第一级扣掉已有的部分进度）
function spOf(e, have) {
  const info = skillInfo(e.skill);
  const from = spForLevel(info.rank, e.level - 1);
  const cur = e.level === (have.get(e.skill) || 0) + 1 ? Math.max(from, C?.sp?.get(e.skill) || 0) : from;
  return Math.max(0, spForLevel(info.rank, e.level) - cur);
}
const costOf = (reqs, lv, have) => { let sp = 0; expand(reqs, new Map(lv), (e) => { sp += spOf(e, have); }); return sp; };

function buildPlan() {
  const have = haveLevels();
  const lv = new Map(have);
  const entries = [];
  const byKey = new Map();
  const reach = new Map();   // 目标 id + 阶段 -> 用到的条目 key 集合
  const R = new Map(P.targets.map((t) => [t.id, reqsOf(t)]));
  const phase = (name, items) => {
    // items: [[目标, 需求]]；贪心：每次挑还差最少的目标，目标内的需求按单项耗时从短到长
    const left = items.filter(([, reqs]) => reqs.length);
    while (left.length) {
      let bi = 0, bc = Infinity;
      left.forEach(([, reqs], i) => { const c = costOf(reqs, lv, have); if (c < bc) { bc = c; bi = i; } });
      const [t, reqs] = left.splice(bi, 1)[0];
      const sorted = reqs.slice().sort((a, b) => costOf([a], lv, have) - costOf([b], lv, have));
      const keys = new Set();
      const touch = (s, L) => { for (let l = 1; l <= L; l++) keys.add(s + ':' + l); };
      expand(sorted, lv, (e) => {
        const key = e.skill + ':' + e.level;
        const x = { ...e, key, phase: name, for: new Set([t.id]), sp: spOf(e, have) };
        entries.push(x);
        byKey.set(key, x);
      }, touch);
      for (const k of keys) byKey.get(k)?.for.add(t.id);
      reach.set(t.id + ':' + name, keys);
    }
  };
  phase('need', P.targets.map((t) => [t, R.get(t.id).need]));
  phase('good', P.targets.map((t) => [t, R.get(t.id).good]));
  // 训练时间
  const imp = implantBonus();
  const cur = baseAttrs();
  const best = optimalRemap(entries, imp);
  const attrs = P.opt.remap && best ? best.attrs : cur;
  const rate = (e) => { const i = skillInfo(e.skill); return ((attrs[i.pri] + imp[i.pri]) + (attrs[i.sec] + imp[i.sec]) / 2) * (P.opt.alpha ? 0.5 : 1); };
  const queueEnd = P.opt.queue && C?.queue?.length ? Math.max(Date.now(), ...C.queue.map((q) => (q.finish_date ? Date.parse(q.finish_date) : 0))) : Date.now();
  let at = queueEnd;
  for (const e of entries) {
    e.min = e.sp / rate(e);
    e.start = at;
    at += e.min * 60e3;
    e.end = at;
  }
  // 每个目标两个阶段的完成时间
  const done = (id, name) => {
    const keys = reach.get(id + ':' + name);
    if (!keys) return null;
    let end = 0, missing = 0;
    for (const k of keys) { const e = byKey.get(k); if (e) { end = Math.max(end, e.end); missing += 1; } }
    return { end: missing ? end : 0, missing };
  };
  const milestones = P.targets.map((t) => ({ t, need: done(t.id, 'need'), good: done(t.id, 'good') }));
  const total = { sp: entries.reduce((s, e) => s + e.sp, 0), min: entries.reduce((s, e) => s + e.min, 0) };
  return { entries, milestones, total, start: queueEnd, end: at, best, cur, imp };
}

// 最佳属性分配：每项 17–27，共 99 点；按规划里各技能的（主属性, 副属性）技能点总量算总时长最短的分配
function optimalRemap(entries, imp) {
  if (!entries.length) return null;
  const groups = new Map();
  for (const e of entries) { const i = skillInfo(e.skill); const k = i.pri + '|' + i.sec; groups.set(k, (groups.get(k) || 0) + e.sp); }
  const G = [...groups].map(([k, sp]) => { const [p, s] = k.split('|'); return { p, s, sp }; });
  const keys = ATTRS.map(([, k]) => k);
  const time = (a) => G.reduce((t, g) => t + g.sp / ((a[g.p] + imp[g.p]) + (a[g.s] + imp[g.s]) / 2), 0);
  let best = null;
  const a = {};
  for (let c = 0; c <= 10; c++) for (let i = 0; i <= 10 && c + i <= 14; i++) for (let m = 0; m <= 10 && c + i + m <= 14; m++) for (let p = 0; p <= 10 && c + i + m + p <= 14; p++) {
    const w = 14 - c - i - m - p;
    if (w > 10) continue;
    [a.charisma, a.intelligence, a.memory, a.perception, a.willpower] = [17 + c, 17 + i, 17 + m, 17 + p, 17 + w];
    const tm = time(a);
    if (!best || tm < best.min) best = { min: tm, attrs: { ...a } };
  }
  best.curMin = time(baseAttrs());
  best.keys = keys;
  return best;
}

// 大型技能注入器按角色总技能点递减：5M 以下 50 万、50M 以下 40 万、80M 以下 30 万，再往上 15 万
function injectorSp() {
  const sp = C?.totalSp || 0;
  return sp < 5e6 ? 500000 : sp < 5e7 ? 400000 : sp < 8e7 ? 300000 : 150000;
}

// ---------- 格式 ----------
function dur(min) {
  if (!(min > 0)) return '0';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = Math.round(min % 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
}
const dateTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = (ms) => new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
const skName = (id) => ctx.data.types.get(id)?.name || String(id);
function targetName(t) {
  if (t.kind === 'ship') return ctx.data.types.get(t.ship)?.name || '';
  if (t.kind === 'dir') return DIRS.find((d) => d.id === t.dir)?.name || '';
  return `${skName(t.skill)} ${ROMAN[t.level]}`;
}
function targetIcon(t) {
  if (t.kind === 'ship') return `<img src="${IMG(t.ship)}" alt="" width="36" height="36" loading="lazy">`;
  if (t.kind === 'skill') return `<img src="${IMG(t.skill)}" alt="" width="36" height="36" loading="lazy">`;
  return '<span class="sp-dir-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h5v-5h5v-5h5V5h3"/></svg></span>';
}

// ---------- 界面 ----------
function render() {
  if (!root) return;
  const esc = ctx.esc;
  const keep = document.activeElement?.dataset?.spSearch ? { k: document.activeElement.dataset.spSearch, v: document.activeElement.value } : null;
  plan = C && (C.mode === 'none' || C.trained || C.error) ? buildPlan() : null;
  root.innerHTML = `<div class="sp-page">
    ${charHtml()}
    <div class="sp-cols">
      <div class="sp-left">
        ${addHtml()}
        ${targetsHtml()}
      </div>
      <div class="sp-right">${resultHtml()}</div>
    </div>
  </div>`;
  if (keep) {
    const input = root.querySelector(`[data-sp-search="${keep.k}"]`);
    if (input) { input.value = keep.v; input.focus(); }
  }
}

function charHtml() {
  const esc = ctx.esc;
  if (!C) return '<section class="sp-char"><span class="sim-status busy">读取角色技能…</span></section>';
  const opts = `<div class="sp-char-opts">
      ${C.queue ? `<label class="pi-check" title="训练队列里的技能按已学计算，规划从队列结束时开始"><input type="checkbox" data-sp-opt="queue"${P.opt.queue ? ' checked' : ''}><span>计入训练队列</span></label>` : ''}
      <label class="pi-check" title="Alpha 克隆训练速度减半"><input type="checkbox" data-sp-opt="alpha"${P.opt.alpha ? ' checked' : ''}><span>Alpha 克隆</span></label>
      <label class="pi-check" title="按下方建议的属性分配计算训练时间"><input type="checkbox" data-sp-opt="remap"${P.opt.remap ? ' checked' : ''}><span>按最佳属性分配</span></label>
    </div>`;
  if (C.mode === 'none') {
    return `<section class="sp-char is-guest">
      <div class="sp-char-main"><b>未绑定角色</b><span>按全部技能未学估算</span></div>
      ${ctx.openEsiBind ? '<button type="button" class="btn btn-primary btn-sm" data-sp-bind>绑定 ESI</button>' : ''}
      ${opts}
    </section>`;
  }
  if (C.error) return `<section class="sp-char"><span class="sim-warn">读取角色技能失败：${esc(C.error)}</span><button type="button" class="link-btn" data-sp-reload>重试</button></section>`;
  const imp = implantBonus(), base = baseAttrs();
  const q = C.queue;
  const qEnd = q?.length ? Math.max(...q.map((x) => (x.finish_date ? Date.parse(x.finish_date) : 0))) : 0;
  return `<section class="sp-char">
    <div class="sp-char-main"><span>${q ? (q.length ? `训练队列 ${q.length} 项，${qEnd ? dateOnly(qEnd) + ' 完成' : '已暂停'}` : '训练队列为空') : `训练队列读取失败${C.queueError ? '：' + esc(C.queueError) : ''}`}</span></div>
    <div class="sp-attrs">${ATTRS.map(([, k, n]) => `<span><em>${n}</em><b>${base[k] + imp[k]}</b>${imp[k] ? `<small>+${imp[k]}</small>` : ''}</span>`).join('')}</div>
    ${opts}
  </section>`;
}

function addHtml() {
  const tab = P.tab;
  const cur = ctx.getFit();
  const saved = ctx.savedFits();
  let body = '';
  if (tab === 'ship') {
    body = `<div class="search-box sp-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-sp-search="ship" placeholder="搜索舰船（中英文名）" autocomplete="off" spellcheck="false" aria-label="搜索舰船">
        <div class="kb-suggest" data-sp-suggest="ship" hidden></div>
      </div>
      <div class="sp-quick">
        ${cur ? `<button type="button" class="btn btn-ghost btn-sm" data-sp-add-current>装配页当前装配</button>` : ''}
        ${saved.length ? `<select class="plain-select" data-sp-add-saved aria-label="我的装配"><option value="">从我的装配添加…</option>${saved.map((f) => `<option value="${ctx.esc(String(f.id))}">${ctx.esc(ctx.data.types.get(f.ship)?.name || '')} · ${ctx.esc(f.name || '未命名')}</option>`).join('')}</select>` : ''}
      </div>`;
  } else if (tab === 'dir') {
    const on = new Set(P.targets.filter((t) => t.kind === 'dir').map((t) => t.dir));
    body = `<div class="sp-dirs">${DIRS.map((d) => `<button type="button" class="sp-dir${on.has(d.id) ? ' active' : ''}" data-sp-dir="${d.id}" aria-pressed="${on.has(d.id)}" title="${d.desc}"><b>${d.name}</b></button>`).join('')}</div>`;
  } else {
    body = `<div class="sp-skill-add">
        <div class="search-box sp-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-sp-search="skill" placeholder="搜索技能（中英文名）" autocomplete="off" spellcheck="false" aria-label="搜索技能">
          <div class="kb-suggest" data-sp-suggest="skill" hidden></div>
        </div>
        <div class="segmented" role="group" aria-label="目标等级">${[1, 2, 3, 4, 5].map((l) => `<button type="button" data-sp-level="${l}" class="${P.skillLevel === l ? 'active' : ''}">${ROMAN[l]}</button>`).join('')}</div>
      </div>`;
  }
  return `<section class="sp-box">
    <div class="sim-sec-head"><h4>添加目标</h4></div>
    <div class="segmented sp-tabs" role="tablist">${[['ship', '想开的船'], ['dir', '发展方向'], ['skill', '单个技能']].map(([k, l]) => `<button type="button" role="tab" data-sp-tab="${k}" class="${tab === k ? 'active' : ''}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
    ${body}
  </section>`;
}

function fitSrcOptions(t) {
  const saved = ctx.savedFits().filter((f) => f.ship === t.ship);
  const opts = [['kb', '最近常见装配'], ['hull', '只开船（不带装配）']];
  if (t.src === 'given') opts.unshift(['given', t.label || '带入的装配']);
  for (const f of saved) opts.push(['saved:' + f.id, '我的装配：' + (f.name || '未命名')]);
  if (t.src?.startsWith('saved:') && !opts.some(([v]) => v === t.src)) opts.push([t.src, t.label || '我的装配']);
  return opts.map(([v, l]) => `<option value="${ctx.esc(v)}"${t.src === v ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('');
}

function targetsHtml() {
  const esc = ctx.esc;
  const ms = new Map((plan?.milestones || []).map((m) => [m.t.id, m]));
  const status = (m, phase, label) => {
    const x = m?.[phase];
    if (!x) return '';
    if (!x.missing) return `<span class="sp-ok">${label}：已满足</span>`;
    return `<span title="${esc(dateTime(x.end))}">${label}：还需 ${dur((x.end - Date.now()) / 60e3)} · ${esc(dateOnly(x.end))}</span>`;
  };
  const rows = P.targets.map((t) => {
    const m = ms.get(t.id);
    const sub = t.kind === 'ship'
      ? `<div class="sp-t-ctl">
          <select class="plain-select" data-sp-src aria-label="装配">${fitSrcOptions(t)}</select>
          <div class="segmented" role="group" aria-label="目标"><button type="button" data-sp-depth="fly" class="${t.depth !== 'good' ? 'active' : ''}" title="只算开船和装上装配需要的技能">能开</button><button type="button" data-sp-depth="good" class="${t.depth === 'good' ? 'active' : ''}" title="再加船体技能、武器与坦克支援技能到 IV 级">用好</button></div>
        </div>
        ${t.status === 'loading' ? '<small class="sim-loading">读取常见装配…</small>' : t.status === 'none' ? '<small class="sim-warn">没有常见装配，只算开船</small>' : ''}`
      : '';
    return `<div class="sp-target" data-sp-target="${t.id}">
      ${targetIcon(t)}
      <div class="sp-t-main">
        <b>${esc(targetName(t))}</b>
        ${sub}
        <div class="sp-t-status">${t.kind === 'dir' ? status(m, 'good', '练完') : status(m, 'need', t.kind === 'ship' ? '能开' : '练到')}${t.kind === 'ship' && t.depth === 'good' ? status(m, 'good', '用好') : ''}</div>
      </div>
      <button type="button" class="icon-btn sim-del" data-sp-del title="移除" aria-label="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`;
  }).join('');
  return `<section class="sp-box">
    <div class="sim-sec-head"><h4>规划目标 <small>${P.targets.length}</small></h4>${P.targets.length ? '<button type="button" class="link-btn" data-sp-clear>清空</button>' : ''}</div>
    <div class="sp-targets">${rows || '<p class="sim-empty">还没有目标</p>'}</div>
  </section>`;
}

function resultHtml() {
  const esc = ctx.esc;
  if (!C) return '<div class="sp-box sp-wait"><span class="sim-status busy">读取角色技能…</span></div>';
  if (!plan) return '';
  if (!P.targets.length) return '<div class="sp-box sp-empty-res"><p class="sim-empty">训练顺序显示在这里</p></div>';
  const E = plan.entries;
  const card = (label, value, detail = '') => `<div class="valuation-card"><span class="valuation-label">${label}</span><strong class="valuation-value">${value}</strong><span class="valuation-detail">${detail}</span></div>`;
  const wait = (plan.start - Date.now()) / 60e3;
  const cards = `<div class="valuation-grid sp-cards">
    ${card('总训练时间', E.length ? dur(plan.total.min) : '—', wait > 1 ? `接在当前队列后` : '')}
    ${card('预计完成', E.length ? esc(dateOnly(plan.end)) : '—')}
    ${card('需要技能点', ctx.formatNumber(plan.total.sp), plan.total.sp ? `≈ ${Math.ceil(plan.total.sp / injectorSp())} 个大型注入器` : '')}
    ${card('技能条目', `${E.length}<span class="unit">项</span>`, E.length > QUEUE_MAX ? `超过 ${QUEUE_MAX} 项，需分批` : '')}
  </div>`;
  if (!E.length) return cards + '<div class="sp-box sp-done"><b>全部目标都已满足</b></div>';
  // 属性重新分配建议
  const B = plan.best;
  let remap = '';
  if (B) {
    const save = B.curMin - B.min;
    const a = C?.attrs;
    const when = a?.accrued_remap_cooldown_date && Date.parse(a.accrued_remap_cooldown_date) > Date.now() ? `${dateOnly(Date.parse(a.accrued_remap_cooldown_date))} 可重新分配` : a ? '现在可重新分配' : '';
    const bonus = a?.bonus_remaps ? ` · 奖励 ${a.bonus_remaps} 次` : '';
    remap = `<div class="sp-box sp-remap">
      <div class="sim-sec-head"><h4>属性分配建议</h4>${when ? `<span class="sp-hint">${esc(when + bonus)}</span>` : ''}</div>
      ${save > 60 ? `<div class="sp-remap-row">${ATTRS.map(([, k, n]) => { const d = B.attrs[k] - plan.cur[k]; return `<span><em>${n}</em><b>${B.attrs[k]}</b>${d ? `<small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</small>` : ''}</span>`; }).join('')}</div>` : ''}
      <p class="sp-hint">${save > 60 ? esc(`可少练 ${dur(save)}（${Math.round(save / B.curMin * 100)}%）`) : '当前分配已接近最佳'}</p>
    </div>`;
  }
  // 里程碑
  const ms = plan.milestones.flatMap(({ t, need, good }) => [
    need?.missing ? { t, end: need.end, label: t.kind === 'ship' ? '能开' : '练到' } : null,
    good?.missing ? { t, end: good.end, label: t.kind === 'dir' ? '练完' : '用好' } : null
  ]).filter(Boolean).sort((a, b) => a.end - b.end);
  const msHtml = ms.length ? `<div class="sp-box"><div class="sim-sec-head"><h4>里程碑</h4></div><ol class="sp-ms">${ms.map((m) => `<li><time>${esc(dateOnly(m.end))}</time><span class="sp-ms-tag">${m.label}</span><b>${esc(targetName(m.t))}</b></li>`).join('')}</ol></div>` : '';
  // 清单
  const limit = P.showAll ? E.length : 80;
  let n = 0;
  const section = (phase, title) => {
    const list = E.filter((e) => e.phase === phase);
    if (!list.length) return '';
    const min = list.reduce((s, e) => s + e.min, 0);
    const rows = list.map((e) => {
      n += 1;
      if (n > limit) return '';
      const info = skillInfo(e.skill);
      return `<tr>
        <td class="num sp-n">${n}</td>
        <td><div class="sp-sk"><span class="sp-sk-name">${esc(info.t.name)}</span><span class="sp-lv">${ROMAN[e.level]}</span>${e.pre ? '<span class="sp-pre" title="其他技能的前置要求">前置</span>' : ''}</div></td>
        <td class="num pi-hide-sm">${ctx.formatNumber(e.sp)}</td>
        <td class="num">${dur(e.min)}</td>
        <td class="num pi-hide-sm">${esc(dateTime(e.end))}</td>
      </tr>`;
    }).join('');
    return `<tbody class="sp-phase"><tr class="sp-phase-head"><th colspan="5"><b>${title}</b><span>${list.length} 项 · ${dur(min)}</span></th></tr>${rows}</tbody>`;
  };
  const list = `<div class="sp-box sp-list">
    <div class="sim-sec-head"><h4>训练顺序</h4>
      <div class="sp-copy">
        ${window.I18N?.lang === 'en' ? '' : `<div class="segmented" role="group" aria-label="技能名语言"><button type="button" data-sp-lang="zh" class="${P.opt.lang !== 'en' ? 'active' : ''}" title="国服 / 中文客户端">中文名</button><button type="button" data-sp-lang="en" class="${P.opt.lang === 'en' ? 'active' : ''}" title="英文客户端">英文名</button></div>`}
        <button type="button" class="btn btn-primary btn-sm" data-sp-copy title="复制后在游戏技能队列里按 Ctrl+V 粘贴（一次最多 ${QUEUE_MAX} 项）">复制技能清单</button>
      </div></div>
    <div class="pi-table-wrap"><table class="pi-table sp-table">
      <thead><tr><th class="num">#</th><th>技能</th><th class="num pi-hide-sm">技能点</th><th class="num">时长</th><th class="num pi-hide-sm">完成时间</th></tr></thead>
      ${section('need', '第一阶段 · 能开 / 能用')}${section('good', '第二阶段 · 用好 / 发展方向')}
    </table></div>
    ${E.length > limit ? `<button type="button" class="btn btn-ghost btn-sm sp-more" data-sp-all>显示全部 ${E.length} 项</button>` : ''}
  </div>`;
  return cards + msHtml + list + remap;
}

// ---------- 搜索 ----------
function search(kind, q) {
  const s = q.toLowerCase();
  const out = [];
  const pool = kind === 'ship' ? ctx.data.types.values() : ctx.data.skills;
  for (const t of pool) {
    if (kind === 'ship' && (t.category !== ctx.FE.CAT.ship || !t.market)) continue;
    if (kind === 'skill' && !t.market) continue;
    if (t.name.toLowerCase().includes(s) || t.en?.toLowerCase().includes(s)) out.push(t);
    if (out.length >= 60) break;
  }
  return out.sort((a, b) => (a.name.toLowerCase().startsWith(s) || a.en?.toLowerCase().startsWith(s) ? 0 : 1) - (b.name.toLowerCase().startsWith(s) || b.en?.toLowerCase().startsWith(s) ? 0 : 1) || a.name.length - b.name.length).slice(0, 12);
}

// ---------- 目标 ----------
function addTarget(t) {
  t.id = ++P.seq;
  P.targets.push(t);
  save();
  render();
  if (t.kind === 'ship' && t.src === 'kb') resolveKb(t);
}
async function resolveKb(t) {
  t.status = 'loading';
  try {
    const r = await commonFit(t.ship);
    if (!P.targets.includes(t) || t.src !== 'kb') return;
    if (r) { t.fit = ctx.normalize(r.fit); t.label = `最近常见装配 ×${r.n}`; t.status = 'ok'; } else { t.fit = null; t.label = '没有找到常见装配，只算开船'; t.status = 'none'; }
  } catch (e) {
    if (!P.targets.includes(t)) return;
    t.fit = null;
    t.label = '常见装配读取失败，只算开船';
    t.status = 'none';
  }
  render();
}
function setSrc(t, src) {
  t.src = src;
  t.status = '';
  if (src === 'kb') { t.fit = null; resolveKb(t); return; }
  if (src === 'hull') { t.fit = null; t.label = ''; }
  else if (src.startsWith('saved:')) {
    const f = ctx.savedFits().find((x) => String(x.id) === src.slice(6));
    t.fit = f ? ctx.normalize(JSON.parse(JSON.stringify(f))) : null;
    t.label = f?.name || '';
  }
  save();
  render();
}

function copyList() {
  const E = plan?.entries || [];
  if (!E.length) return;
  // 英文界面下装配数据里的名称已换成英文（i18n.js），只能复制英文名
  const en = P.opt.lang === 'en' || window.I18N?.lang === 'en';
  const lines = E.slice(0, QUEUE_MAX).map((e) => { const t = ctx.data.types.get(e.skill); return `${(en ? t.en : t.name) || t.name} ${e.level}`; });
  const msg = E.length > QUEUE_MAX ? `已复制前 ${QUEUE_MAX} 项（队列上限）` : `已复制 ${lines.length} 项，在游戏训练队列里 Ctrl+V 粘贴`;
  navigator.clipboard.writeText(lines.join('\n')).then(() => ctx.showToast(msg, 'success', 3500), () => window.prompt('复制技能清单', lines.join('\n')));
}

// ---------- 交互 ----------
function onClick(e) {
  const el = (s) => e.target.closest(s);
  let x;
  if ((x = el('[data-sp-tab]'))) { P.tab = x.dataset.spTab; render(); root.querySelector('[data-sp-search]')?.focus(); return; }
  if ((x = el('[data-sp-pick]'))) {
    const [kind, id] = x.dataset.spPick.split(':');
    document.activeElement?.blur?.();
    pick(kind, Number(id));
    return;
  }
  if ((x = el('[data-sp-dir]'))) {
    const on = P.targets.find((t) => t.kind === 'dir' && t.dir === x.dataset.spDir);
    if (on) { P.targets = P.targets.filter((t) => t !== on); save(); render(); } else addTarget({ kind: 'dir', dir: x.dataset.spDir });
    return;
  }
  if ((x = el('[data-sp-level]'))) { P.skillLevel = Number(x.dataset.spLevel); x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x)); return; }
  if (el('[data-sp-add-current]')) {
    const f = ctx.getFit();
    if (f) addTarget({ kind: 'ship', ship: f.ship, src: 'given', fit: ctx.normalize(JSON.parse(JSON.stringify(f))), label: f.name ? `当前装配：${f.name}` : '装配页当前装配', depth: 'good' });
    return;
  }
  if ((x = el('[data-sp-depth]'))) {
    const t = findTarget(x);
    t.depth = x.dataset.spDepth;
    save();
    render();
    return;
  }
  if ((x = el('[data-sp-del]'))) { const t = findTarget(x); P.targets = P.targets.filter((y) => y !== t); save(); render(); return; }
  if (el('[data-sp-clear]')) { P.targets = []; save(); render(); return; }
  if (el('[data-sp-all]')) { P.showAll = true; render(); return; }
  if ((x = el('[data-sp-lang]'))) { P.opt.lang = x.dataset.spLang; save(); x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x)); return; }
  if (el('[data-sp-copy]')) { copyList(); return; }
  if (el('[data-sp-bind]')) { ctx.openEsiBind?.(); return; }
  if (el('[data-sp-reload]')) { C = null; charP = null; render(); loadChar(); }
}
const findTarget = (el) => P.targets.find((t) => t.id === Number(el.closest('[data-sp-target]').dataset.spTarget));
function pick(kind, id) {
  if (kind === 'ship') addTarget({ kind: 'ship', ship: id, src: 'kb', fit: null, label: '', depth: 'good' });
  else {
    const old = P.targets.find((t) => t.kind === 'skill' && t.skill === id);
    if (old) { old.level = Math.max(old.level, P.skillLevel); save(); render(); } else addTarget({ kind: 'skill', skill: id, level: P.skillLevel });
  }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.spOpt) { P.opt[t.dataset.spOpt] = t.checked; save(); render(); return; }
  if (t.matches('[data-sp-src]')) { setSrc(findTarget(t), t.value); return; }
  if (t.matches('[data-sp-add-saved]') && t.value) {
    const f = ctx.savedFits().find((x) => String(x.id) === t.value);
    if (f) addTarget({ kind: 'ship', ship: f.ship, src: 'saved:' + f.id, fit: ctx.normalize(JSON.parse(JSON.stringify(f))), label: f.name || '', depth: 'good' });
  }
}
function onInput(e) {
  const t = e.target;
  const kind = t.dataset.spSearch;
  if (!kind) return;
  const box = root.querySelector(`[data-sp-suggest="${kind}"]`);
  const q = t.value.trim();
  if (!q) { box.hidden = true; return; }
  const have = C?.trained;
  box.innerHTML = search(kind, q).map((s, i) => `<button type="button" class="kb-suggest-item${i ? '' : ' active'}" data-sp-pick="${kind}:${s.id}"><img src="${IMG(s.id)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(s.name)}</span><small>${kind === 'skill' && have ? (have.get(s.id) ? `已学 ${ROMAN[have.get(s.id)]}` : '未学') : ctx.esc(ctx.data.groups.get(s.group)?.name || '')}</small></button>`).join('') || `<p class="ind-side-empty">${kind === 'ship' ? '没有匹配的舰船' : '没有匹配的技能'}</p>`;
  box.hidden = false;
}
function onKeydown(e) {
  const t = e.target;
  const kind = t.dataset?.spSearch;
  if (!kind) return;
  const box = root.querySelector(`[data-sp-suggest="${kind}"]`);
  const items = [...box.querySelectorAll('.kb-suggest-item')];
  if (e.key === 'Escape') { box.hidden = true; return; }
  if (box.hidden || !items.length) return;
  const i = items.findIndex((x) => x.classList.contains('active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((x, k) => x.classList.toggle('active', k === j));
    items[j].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const [k, id] = items[Math.max(0, i)].dataset.spPick.split(':');
    t.value = '';
    box.hidden = true;
    pick(k, Number(id));
  }
}
