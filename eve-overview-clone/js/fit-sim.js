// ===== 舰队对战模拟 =====
// A / B 两方各若干艘舰船（每行：船型 + 装配 + 数量），按秒推进模拟交战：
// 每艘船的属性由装配引擎（fit-engine.js，全部技能 5 级）算出；武器伤害按目标的信号半径、横向速度与交战距离计算命中（与装配页「对目标的有效 DPS」同一套公式），
// 四种伤害分别乘目标当前那层的抗性，依次扣护盾、装甲、结构；本地维修、护盾自然回充、后勤遥修计入；
// 换目标时要先锁定（锁定时间按扫描分辨率与目标信号半径），网子 / 标记作用于自己的目标（按距离与叠加惩罚）。
// 不模拟：走位（双方固定在一个交战距离）、电容（假定都够用）、中和 / ECM / 阻尼、超载、指挥脉冲。
// 装配来源：击杀记录里这型船最近阵亡时最常见的装配（fit-kb.js commonFit）、当前装配、我的装配、游戏内保存的装配（ESI）、EFT 文本，或空船；
// 点舰船打开装配详情：看槽位与属性，从本场 / 最近常见的几套装配和自己的装配里换一套。
// 战场统计（kb-br.js）可把一场会战双方的实际出场舰船带进来（openSim(preset)），结果旁边对照实际损失。
import { commonFit } from './fit-kb.js?v=v26';

let ctx;   // data, FE, getFit, savedFits, parseEft, normalize, esc, formatNumber, formatISK, showToast, store, hasEsi, esiFits, openInFitting
const $ = (id) => document.getElementById(id);
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const KEY = 'eve-fit-sim-v1';
const DAMAGE_NAMES = ['电磁', '热能', '动能', '爆炸'];
const LAYER_NAMES = ['护盾', '装甲', '结构'];
const DISTANCES = [2, 5, 10, 20, 30, 50, 70];
const DURATIONS = [[120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟']];
const FOCUS = [['weak', '最脆优先'], ['dps', '输出优先'], ['spread', '分散']];
const TRANS = [[0, '静止'], [25, '慢速'], [50, '环绕'], [100, '全速']];
const SQUAD = 15;   // 集火时每 15 艘船共用一个目标（大舰队会同时打多个目标，避免几百艘船打一艘的过量伤害）
const SIDES = ['A', 'B'];
// 自动装配来源：battle 本场阵亡装配（会战监制队一般同一型船同一套装配）/ kb 最近常见装配
const AUTO = new Set(['battle', 'kb']);

const S = {
  sides: { A: [], B: [] },
  opt: { dist: 10, trans: 25, focus: 'weak', logi: true, ewar: true, prop: false, max: 300 },
  title: '', real: null,      // 来自会战：标题与实际损失 { A: Map(ship -> n), B }
  result: null, seq: 0, adding: null, chart: 'ships',
  esi: { fits: null, loading: false, error: '' },   // 已绑定角色的游戏内装配
  detail: null                                      // 装配详情面板 { side, id, groups, sel }
};

export function initSim(context) {
  ctx = context;
  try {
    const saved = ctx.store.getJSON(KEY, null);
    if (saved) {
      Object.assign(S.opt, saved.opt || {});
      for (const s of SIDES) S.sides[s] = (saved.sides?.[s] || []).filter((r) => ctx.data.types.has(r.ship)).map((r) => ({ ...r, id: ++S.seq, status: r.fit ? 'ok' : 'idle' }));
      S.title = saved.title || '';
    }
  } catch { /* 默认 */ }
}

function save() {
  const rows = (list) => list.map(({ ship, count, src, fit, label, kills, killsOther }) => ({ ship, count, src, kills, killsOther, fit: AUTO.has(src) ? null : fit, label: AUTO.has(src) ? '' : label }));
  ctx.store.setJSON(KEY, { opt: S.opt, title: S.title, sides: { A: rows(S.sides.A), B: rows(S.sides.B) } });
}

// preset：{ title, a: [{ ship, count }], b: [...], real: { A: [[ship, n]], B } }
export function openSim(preset = null) {
  let modal = $('fitSimModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitSimModal';
    modal.className = 'modal sim-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'simTitle');
    modal.innerHTML = `<div class="modal-backdrop"></div><div class="modal-content sim-content">
      <div class="modal-header"><h3 id="simTitle">舰队对战模拟</h3><button class="modal-close" data-sim-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="simBody"></div><div class="modal-body sim-detail" id="simDetail" hidden></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onClick);
    modal.addEventListener('change', onChange);
    modal.addEventListener('input', onInput);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { if (S.detail) closeDetail(); else close(); } });
    window.addEventListener('resize', () => { if (!modal.hidden) drawChart(); });
  }
  if (preset) {
    S.title = preset.title || '';
    S.real = preset.real ? Object.fromEntries(SIDES.map((s) => [s, new Map(preset.real[s] || [])])) : null;
    const isShip = (r) => ctx.data.types.get(r.ship)?.category === ctx.FE.CAT.ship;
    const row = (r) => {
      const hasBattle = r.kills?.length || r.killsOther?.length;
      return Object.assign(newRow(r.ship, r.count, hasBattle ? 'battle' : 'kb'), { kills: r.kills || [], killsOther: r.killsOther || [] });
    };
    S.sides.A = preset.a.filter(isShip).map(row);
    S.sides.B = preset.b.filter(isShip).map(row);
    S.result = null;
    save();
  }
  modal.hidden = false;
  document.body.classList.add('modal-open');
  S.detail = null;
  render();
  showDetailPane(false);
  for (const s of SIDES) S.sides[s].forEach(resolveRow);
  loadEsi();
}

// 游戏内装配（绑定了角色才读；与装配页「游戏装配」弹窗共用缓存）
function loadEsi() {
  if (!ctx.hasEsi?.() || S.esi.loading || S.esi.fits) return;
  S.esi.loading = true;
  ctx.esiFits()
    .then((list) => { S.esi.fits = list; S.esi.error = ''; })
    .catch((e) => { S.esi.error = e.message; })
    .finally(() => { S.esi.loading = false; renderSides(); if (S.detail) openDetail(S.detail.side, S.detail.id, S.detail.sel); });
}

function close() {
  S.detail = null;
  showDetailPane(false);
  $('fitSimModal').hidden = true;
  document.body.classList.remove('modal-open');
}

function newRow(ship, count = 1, src = 'kb', fit = null, label = '') {
  return { id: ++S.seq, ship, count: Math.max(1, Math.min(500, Math.round(count) || 1)), src, fit, label, status: fit ? 'ok' : 'idle' };
}

// ---------- 装配来源 ----------
const kbCache = new Map();   // 船型（+ 指定击杀）-> Promise<{ fit, n, list: [{ fit, n }], total } | null>
// 同时最多查 6 种船（一场会战可能有几十种船）
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 6) await new Promise((r) => waiting.push(r));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
}
// 击杀记录装配（按船型 + 指定击杀缓存，详情面板的候选列表也用它）
function loadKb(ship, kills = null) {
  const key = kills?.length ? ship + ':' + kills.join(',') : String(ship);
  if (!kbCache.has(key)) kbCache.set(key, limited(() => commonFit(ship, kills?.length ? { kills } : {})).catch((e) => { kbCache.delete(key); throw e; }));
  return kbCache.get(key);
}
const hasBattle = (row) => Boolean(row.kills?.length || row.killsOther?.length);
async function resolveRow(row) {
  if (!AUTO.has(row.src) || row.status === 'loading' || (row.status === 'ok' && row.fit)) { if (row.fit && !row.stats) prepare(row); return; }
  const src = row.src;
  row.status = 'loading';
  renderSides();
  try {
    // 本场阵亡装配：先看本方这型船在这场的损失，没有再看对方同型船的损失；都没有时退回最近常见装配
    let r = null, label = '';
    if (src === 'battle') {
      if (row.kills?.length) { r = await loadKb(row.ship, row.kills); if (r) label = `本场阵亡装配 ×${r.n}`; }
      if (!r && row.killsOther?.length) { r = await loadKb(row.ship, row.killsOther); if (r) label = `本场对方同型船装配 ×${r.n}`; }
    }
    if (!r) { r = await loadKb(row.ship); if (r) label = src === 'battle' ? `本场没有阵亡 · 常见装配 ×${r.n}` : `常见装配 ×${r.n}`; }
    if (row.src !== src) return;
    if (r) {
      row.fit = ctx.normalize(r.fit);
      row.label = label;
      row.status = 'ok';
    } else {
      row.fit = emptyFit(row.ship);
      row.label = '无阵亡记录 · 空船';
      row.status = 'none';
    }
  } catch (error) {
    row.fit = emptyFit(row.ship);
    row.label = '读取失败 · 空船';
    row.status = 'none';
    row.error = error.message;
  }
  prepare(row);
  S.result = null;
  renderSides();
  renderResult();
}

function emptyFit(ship) {
  return { id: null, name: '', ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
}

// 装配里的主动装备按装配里的状态计算（击杀记录装配都是开启）；
// 有重新激活延迟的装备（突击型损伤控制等，开几秒要冷却一分钟以上）不能一直开着，按在线不开启计算
const REACTIVATION_DELAY = 669;
// 返回不计开启的原因（null = 按装配里的状态）
function forcedOff(m) {
  const { FE, data } = ctx;
  if (!m || (FE.STATE_RANK[m.state] || 0) < 2) return null;
  const t = data.types.get(m.type);
  if ((t?.attrs.get(REACTIVATION_DELAY) || 0) > 0) return '长冷却，不计开启';
  // 推进器（微型跃迁推进器 / 加力燃烧器）：按选项开或关
  if (!S.opt.prop && t?.attrs.has(FE.AT.speedBoostFactor) && t.attrs.has(FE.AT.massAddition)) return '推进器未开启';
  return null;
}
function prepare(row) {
  const { FE, data } = ctx;
  const fit = { ...row.fit, slots: Object.fromEntries(FE.SLOTS.map((s) => [s, (row.fit.slots[s] || []).map((m) => (forcedOff(m) ? { ...m, state: 'online' } : m))])) };
  row.calc = FE.computeFit(data, fit, 'max');
  row.stats = row.calc ? FE.fitStats(row.calc) : null;
  row.unit = row.stats ? unitTemplate(row) : null;
}

// ---------- 单艘船的战斗属性 ----------
const effName = (t) => t.effects.map((e) => ctx.data.effects.get(e)?.name);
function unitTemplate(row) {
  const { FE } = ctx;
  const { calc, stats } = row;
  const ship = calc.ship;
  const d = stats.defense;
  const res = ['shield', 'armor', 'hull'].map((k) => FE.RESIST[k].map((a) => ship.attr(a)));
  const remote = [], webs = [], paints = [];
  for (const m of calc.modules) {
    if ((FE.STATE_RANK[m.state] || 0) < 2) continue;
    const names = effName(m.type);
    const dur = m.attr(FE.AT.duration) / 1000 || m.attr(FE.AT.speed) / 1000;
    const range = m.attr(FE.AT.maxRange), falloff = m.attr(2044) || 0;
    if (names.includes('shipModuleRemoteShieldBooster') || names.includes('shipModuleAncillaryRemoteShieldBooster')) remote.push({ layer: 0, rate: m.attr(FE.AT.shieldBonus) / dur, range, falloff });
    else if (names.includes('shipModuleRemoteArmorRepairer') || names.includes('shipModuleAncillaryRemoteArmorRepairer') || names.includes('ShipModuleRemoteArmorMutadaptiveRepairer')) {
      const mult = names.includes('shipModuleAncillaryRemoteArmorRepairer') && m.charge ? m.attr(FE.AT.chargedArmorDamageMultiplier) || 1 : 1;
      remote.push({ layer: 1, rate: m.attr(FE.AT.armorDamageAmount) * mult / dur, range, falloff });
    } else if (names.includes('shipModuleRemoteHullRepairer')) remote.push({ layer: 2, rate: m.attr(FE.AT.structureDamageAmount) / dur, range, falloff });
    else if (names.includes('remoteWebifierFalloff')) webs.push({ v: m.attr(FE.AT.speedFactor) / 100, range, falloff });
    else if (names.includes('remoteTargetPaintFalloff')) paints.push({ v: m.attr(FE.AT.signatureRadiusBonus) / 100, range, falloff });
  }
  return {
    max: [d.shield.hp, d.armor.hp, d.hull.hp], res,
    types: stats.weapon.types.slice(), dps: stats.weapon.total,
    sig: stats.navigation.signature, vel: stats.navigation.velocity, scanRes: stats.targeting.scanRes,
    local: [d.reps.shield, d.reps.armor, d.reps.hull], regenC: d.shield.hp, regenTau: d.shield.hp && stats.defense.passiveRegen ? 2.5 * d.shield.hp / stats.defense.passiveRegen : 0,
    remote, webs, paints, ehp: d.ehp
  };
}

// 锁定时间（秒）= 40000 / (扫描分辨率 × asinh(目标信号半径)²)
const lockTime = (scanRes, sig) => (scanRes > 0 ? Math.min(60, 40000 / (scanRes * Math.asinh(sig) ** 2)) : 5);
// 带衰减范围的装备在距离 d 的效果比例
const rangeEff = (x, d) => (d <= x.range ? 1 : x.falloff > 0 ? 0.5 ** (((d - x.range) / x.falloff) ** 2) : 0);
const PENALTY = (i) => Math.exp(-((i / 2.67) ** 2));
// 简单的可复现随机数（分散火力用）
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---------- 模拟 ----------
export function simulate(sides, opt) {
  const { FE } = ctx;
  const dist = opt.dist * 1000;
  const trans = opt.trans / 100;
  const rand = rng(20261026);
  const units = [];
  const rows = [];
  for (const s of SIDES) {
    for (const row of sides[s]) {
      if (!row.unit) continue;
      const r = { row, side: s, lost: 0, dealt: 0, taken: 0, repaired: 0, n: row.count, killTimes: [] };
      rows.push(r);
      for (let i = 0; i < row.count; i++) {
        const t = row.unit;
        units.push({ side: s, r, t, hp: t.max.slice(), alive: true, target: null, lock: 0, repTarget: null, repLock: 0, ehpMax: t.ehp });
      }
    }
  }
  const bySide = { A: units.filter((u) => u.side === 'A'), B: units.filter((u) => u.side === 'B') };
  const totalHp = (list) => list.reduce((t, u) => t + u.hp[0] + u.hp[1] + u.hp[2], 0);
  const maxHp = { A: totalHp(bySide.A) || 1, B: totalHp(bySide.B) || 1 };
  const timeline = [{ t: 0, A: bySide.A.length, B: bySide.B.length, hpA: 1, hpB: 1 }];
  const kills = [];
  // 命中比例缓存：攻击方装配 × 目标装配 × 网 / 标记倍数
  const applyCache = new Map();
  const applied = (u, v, velMult, sigMult) => {
    if (!u.t.dps) return 0;
    const key = `${u.r.row.id}|${v.r.row.id}|${velMult.toFixed(2)}|${sigMult.toFixed(2)}`;
    let f = applyCache.get(key);
    if (f === undefined) {
      const target = { sig: v.t.sig * sigMult, vel: v.t.vel * velMult * trans };
      f = FE.appliedDps(u.r.row.stats, target, dist) / u.t.dps;
      applyCache.set(key, f);
    }
    return f;
  };
  const curEhp = (u) => u.hp[0] / mean(u.t.res[0]) + u.hp[1] / mean(u.t.res[1]) + u.hp[2] / mean(u.t.res[2]);

  // 每方挑选集火目标：按策略排序后取前 K 个，攻击者轮流分配
  function assignTargets(side) {
    const enemies = bySide[side === 'A' ? 'B' : 'A'].filter((u) => u.alive);
    const attackers = bySide[side].filter((u) => u.alive && (u.t.dps > 0 || u.t.webs.length || u.t.paints.length));
    if (!enemies.length) return;
    if (opt.focus === 'spread') {
      for (const u of attackers) if (!u.target?.alive) { u.target = enemies[Math.floor(rand() * enemies.length)]; u.lock = lockTime(u.t.scanRes, u.target.t.sig); }
      return;
    }
    const k = Math.max(1, Math.ceil(attackers.length / SQUAD));
    const ranked = enemies.slice().sort(opt.focus === 'dps' ? (a, b) => b.t.dps - a.t.dps || curEhp(a) - curEhp(b) : (a, b) => curEhp(a) - curEhp(b));
    const primaries = ranked.slice(0, k);
    // 已在打的活目标继续打（换目标要重新锁定）；目标死了才换
    const load = new Map(primaries.map((p) => [p, 0]));
    for (const u of attackers) if (u.target?.alive && load.has(u.target)) load.set(u.target, load.get(u.target) + 1);
    for (const u of attackers) {
      if (u.target?.alive) continue;
      let best = primaries[0];
      for (const p of primaries) if (load.get(p) < load.get(best)) best = p;
      load.set(best, load.get(best) + 1);
      u.target = best;
      u.lock = lockTime(u.t.scanRes, best.t.sig);
    }
  }

  let t = 0;
  for (; t < opt.max; t++) {
    if (!bySide.A.some((u) => u.alive) || !bySide.B.some((u) => u.alive)) break;
    assignTargets('A');
    assignTargets('B');
    // 网 / 标记：作用于自己的目标
    const velMult = new Map(), sigMult = new Map();
    if (opt.ewar) {
      const webs = new Map(), paints = new Map();
      for (const u of units) {
        if (!u.alive || !u.target?.alive || u.lock > 0) continue;
        for (const w of u.t.webs) (webs.get(u.target) || webs.set(u.target, []).get(u.target)).push(w.v * rangeEff(w, dist));
        for (const p of u.t.paints) (paints.get(u.target) || paints.set(u.target, []).get(u.target)).push(p.v * rangeEff(p, dist));
      }
      for (const [v, list] of webs) velMult.set(v, list.sort((a, b) => a - b).reduce((m, x, i) => m * (1 + x * PENALTY(i)), 1));
      for (const [v, list] of paints) sigMult.set(v, list.sort((a, b) => b - a).reduce((m, x, i) => m * (1 + x * PENALTY(i)), 1));
    }
    // 输出：累计每个目标承受的四种伤害
    const incoming = new Map();
    for (const u of units) {
      if (!u.alive || !u.target?.alive) continue;
      if (u.lock > 0) { u.lock -= 1; continue; }
      const v = u.target;
      const f = applied(u, v, velMult.get(v) || 1, sigMult.get(v) || 1);
      if (!f) continue;
      let inc = incoming.get(v);
      if (!inc) incoming.set(v, (inc = { dmg: [0, 0, 0, 0], from: [] }));
      for (let k = 0; k < 4; k++) inc.dmg[k] += u.t.types[k] * f;
      inc.from.push([u, f]);
    }
    for (const [v, inc] of incoming) {
      const raw = inc.dmg;
      let left = raw.slice();
      let dealt = 0;
      for (let layer = 0; layer < 3 && left.some((x) => x > 0); layer++) {
        const eff = left.reduce((s, x, k) => s + x * v.t.res[layer][k], 0);
        if (eff <= 0) break;
        if (eff <= v.hp[layer]) { v.hp[layer] -= eff; dealt += eff; left = null; break; }
        const used = v.hp[layer] / eff;
        dealt += v.hp[layer];
        v.hp[layer] = 0;
        left = left.map((x) => x * (1 - used));
      }
      v.r.taken += dealt;
      // 输出按各攻击者的原始伤害占比分摊
      const sumRaw = raw.reduce((s, x) => s + x, 0) || 1;
      for (const [u, f] of inc.from) u.r.dealt += dealt * (u.t.dps * f) / sumRaw;
      if (v.hp[2] <= 1e-6) {
        v.alive = false;
        v.r.lost += 1;
        v.r.killTimes.push(t + 1);
        kills.push({ t: t + 1, side: v.side, ship: v.r.row.ship, row: v.r });
      }
    }
    // 维修：本地维修、护盾自然回充、后勤遥修
    for (const u of units) {
      if (!u.alive) continue;
      for (let l = 0; l < 3; l++) if (u.t.local[l] && u.hp[l] < u.t.max[l]) u.hp[l] = Math.min(u.t.max[l], u.hp[l] + u.t.local[l]);
      const C = u.t.regenC, tau = u.t.regenTau;
      if (C && tau && u.hp[0] < C) { const x = u.hp[0] / C; u.hp[0] = Math.min(C, u.hp[0] + 10 * C / tau * (Math.sqrt(x) - x)); }
    }
    if (opt.logi) {
      for (const u of units) {
        if (!u.alive || !u.t.remote.length) continue;
        // 修受伤最重的队友（按遥修能修的那层），换目标要先锁定
        const layer = u.t.remote[0].layer;
        let best = null, worst = 0.98;
        for (const a of bySide[u.side]) {
          if (!a.alive || a === u || !a.t.max[layer]) continue;
          const frac = a.hp[layer] / a.t.max[layer];
          if (frac < worst) { worst = frac; best = a; }
        }
        if (!best) continue;
        if (u.repTarget !== best) {
          // 当前目标还没修满一半就不换，避免来回切
          if (u.repTarget?.alive && u.repTarget.hp[layer] / u.repTarget.t.max[layer] < 0.5) best = u.repTarget;
          else { u.repTarget = best; u.repLock = lockTime(u.t.scanRes, best.t.sig); }
        }
        if (u.repLock > 0) { u.repLock -= 1; continue; }
        const a = u.repTarget;
        for (const rep of u.t.remote) {
          const room = a.t.max[rep.layer] - a.hp[rep.layer];
          if (room <= 0) continue;
          const amt = Math.min(room, rep.rate);
          a.hp[rep.layer] += amt;
          u.r.repaired += amt;
        }
      }
    }
    timeline.push({
      t: t + 1,
      A: bySide.A.filter((u) => u.alive).length, B: bySide.B.filter((u) => u.alive).length,
      hpA: totalHp(bySide.A.filter((u) => u.alive)) / maxHp.A, hpB: totalHp(bySide.B.filter((u) => u.alive)) / maxHp.B
    });
  }
  const last = timeline[timeline.length - 1];
  const winner = last.A && !last.B ? 'A' : last.B && !last.A ? 'B' : null;
  const lead = winner || (last.hpA - last.hpB > 0.05 ? 'A' : last.hpB - last.hpA > 0.05 ? 'B' : null);
  return { t, timeline, kills, rows, winner, lead, start: { A: bySide.A.length, B: bySide.B.length }, end: { A: last.A, B: last.B }, hp: { A: last.hpA, B: last.hpB } };
}

const mean = (r) => (r[0] + r[1] + r[2] + r[3]) / 4 || 1;

// ---------- 界面 ----------
function render() {
  const body = $('simBody');
  $('simTitle').textContent = S.title ? `对战模拟 · ${S.title}` : '舰队对战模拟';
  const seg = (key, items) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-sim-opt="${key}" data-v="${v}" class="${String(S.opt[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  body.innerHTML = `
    <div class="sim-opts">
      <label class="sim-opt"><span>交战距离</span><select class="pi-input" data-sim-opt-select="dist">${DISTANCES.map((d) => `<option value="${d}"${S.opt.dist === d ? ' selected' : ''}>${d} km</option>`).join('')}</select></label>
      <div class="sim-opt"><span>目标机动</span>${seg('trans', TRANS)}</div>
      <div class="sim-opt"><span>集火</span>${seg('focus', FOCUS)}</div>
      <label class="sim-opt"><span>最长时间</span><select class="pi-input" data-sim-opt-select="max">${DURATIONS.map(([v, l]) => `<option value="${v}"${S.opt.max === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="pi-check"><input type="checkbox" data-sim-flag="logi"${S.opt.logi ? ' checked' : ''}><span>后勤遥修</span></label>
      <label class="pi-check"><input type="checkbox" data-sim-flag="ewar"${S.opt.ewar ? ' checked' : ''}><span>网子 / 标记</span></label>
      <label class="pi-check" title="开启时速度与信号半径都按推进器开着计算（舰队对射时一般不开）"><input type="checkbox" data-sim-flag="prop"${S.opt.prop ? ' checked' : ''}><span>推进器开启</span></label>
      ${SIDES.some((s) => S.sides[s].some(hasBattle)) ? `<div class="sim-opt"><span>装配来源</span><div class="segmented" role="group"><button type="button" data-sim-src="battle">全部用本场阵亡装配</button><button type="button" data-sim-src="kb">全部用最近常见装配</button></div></div>` : ''}
      <button type="button" class="btn btn-primary sim-go" data-sim-run>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/></svg>开始模拟
      </button>
    </div>
    <div class="sim-sides" id="simSides"></div>
    <div id="simResult"></div>
    <p class="fit-hint sim-note">技能全部 5 级；双方固定在交战距离上，目标横向速度 = 最大速度 × 目标机动比例；有长冷却的装备（突击型损伤控制等）不计开启；集火时每 ${SQUAD} 艘船共打一个目标。
      不计电容（假定够用）、中和、ECM、阻尼、超载与指挥脉冲。本场阵亡装配：这型船在这场会战里阵亡时最常见的一套（本方没有阵亡时取对方同型船的），会战一般是监制队，同型船按同一套装配算；最近常见装配：最近 7 天最近 20 次损失里最常见的一套。结果仅供参考。</p>`;
  renderSides();
  renderResult();
}

function sideTotals(list) {
  const t = { ships: 0, dps: 0, ehp: 0, reps: 0, loading: 0 };
  for (const r of list) {
    t.ships += r.count;
    if (r.status === 'loading' || r.status === 'idle') t.loading += 1;
    if (!r.unit) continue;
    t.dps += r.unit.dps * r.count;
    t.ehp += r.unit.ehp * r.count;
    t.reps += r.unit.remote.reduce((s, x) => s + x.rate, 0) * r.count;
  }
  return t;
}

function fitOptions(row) {
  const cur = ctx.getFit();
  const saved = ctx.savedFits().filter((f) => f.ship === row.ship);
  const opts = hasBattle(row) ? [['battle', '本场阵亡装配'], ['kb', '最近常见装配']] : [['kb', '最近常见装配']];
  if (cur?.ship === row.ship) opts.push(['current', '当前装配']);
  for (const f of saved) opts.push(['saved:' + f.id, '我的装配：' + (f.name || '未命名')]);
  for (const f of (S.esi.fits || []).filter((x) => x.ship === row.ship)) opts.push(['esi:' + f.esiId, '游戏装配：' + (f.name || '未命名')]);
  opts.push(['hull', '空船（无装备）']);
  // EFT、详情面板里选的装配、游戏装配还没读到时：保留当前这一项
  if (!opts.some(([v]) => v === row.src)) opts.splice(opts.length - 1, 0, [row.src, row.label || (row.src === 'eft' ? 'EFT 装配' : '已选装配')]);
  return opts.map(([v, l]) => `<option value="${v}"${row.src === v ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('');
}

function rowHtml(side, r) {
  const t = ctx.data.types.get(r.ship);
  const u = r.unit;
  const info = r.status === 'loading' ? '<span class="sim-loading">读取装配…</span>'
    : u ? `<span>${ctx.formatNumber(Math.round(u.dps))} DPS · ${ctx.formatNumber(Math.round(u.ehp))} EHP${u.remote.length ? ` · 遥修 ${ctx.formatNumber(Math.round(u.remote.reduce((s, x) => s + x.rate, 0)))}/s` : ''}</span>${r.status === 'none' ? `<em class="sim-warn" title="${ctx.esc(r.error || '这型船最近没有阵亡记录，按空船计算；可在下拉框换成自己的装配')}">${ctx.esc(r.label)}</em>` : AUTO.has(r.src) && r.label ? `<em>${ctx.esc(r.label)}</em>` : ''}`
      : '';
  return `<div class="sim-row" data-sim-row="${side}:${r.id}">
    <button type="button" class="sim-row-img" data-sim-detail title="查看 / 更换装配"><img src="${IMG(r.ship)}" alt="" width="32" height="32" loading="lazy"></button>
    <div class="sim-row-main">
      <button type="button" class="sim-row-name" data-sim-detail title="查看 / 更换装配"><b>${ctx.esc(t?.name || '')}</b><span>装配详情</span></button>
      <div class="sim-row-info">${info}</div>
      <select class="plain-select sim-fit" data-sim-fit aria-label="装配">${fitOptions(r)}</select>
    </div>
    <input type="number" class="pi-input sim-count" min="1" max="500" value="${r.count}" data-sim-count aria-label="数量">
    <button type="button" class="icon-btn sim-del" data-sim-del title="移除" aria-label="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>`;
}

function renderSides() {
  const box = $('simSides');
  if (!box) return;
  // 装配读完后会重画：保留正在输入的搜索框
  const typing = document.activeElement?.dataset?.simSearch ? { side: document.activeElement.dataset.simSearch, value: document.activeElement.value, pos: document.activeElement.selectionStart } : null;
  const eftText = box.querySelector('[data-sim-eft-text]')?.value;
  const cur = ctx.getFit();
  box.innerHTML = SIDES.map((s) => {
    const list = S.sides[s];
    const tot = sideTotals(list);
    const adding = S.adding?.side === s;
    return `<section class="sim-side sim-side-${s.toLowerCase()}">
      <header class="sim-side-head">
        <h4><span class="sim-badge">${s} 方</span>${tot.ships} 艘${tot.loading ? `<small class="sim-loading">读取装配 ${list.length - tot.loading} / ${list.length}</small>` : ''}</h4>
        <div class="sim-side-stats"><span>纸面 <b>${ctx.formatNumber(Math.round(tot.dps))}</b> DPS</span><span><b>${ctx.formatISK(tot.ehp)}</b> EHP</span>${tot.reps ? `<span>遥修 <b>${ctx.formatNumber(Math.round(tot.reps))}</b>/s</span>` : ''}</div>
      </header>
      <div class="sim-rows">${list.map((r) => rowHtml(s, r)).join('') || '<p class="sim-empty">还没有舰船</p>'}</div>
      <div class="sim-add">
        <div class="search-box sim-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-sim-search="${s}" placeholder="添加舰船（中英文名）" autocomplete="off" spellcheck="false" aria-label="添加舰船">
          <div class="kb-suggest" data-sim-suggest="${s}" hidden></div>
        </div>
        ${cur ? `<button type="button" class="btn btn-ghost" data-sim-add-current="${s}" title="把装配页当前的装配加入这一方">加入当前装配</button>` : ''}
        <button type="button" class="btn btn-ghost" data-sim-eft="${s}">粘贴 EFT</button>
        ${list.length ? `<button type="button" class="link-btn danger" data-sim-clear="${s}">清空</button>` : ''}
      </div>
      ${adding ? `<div class="sim-eft"><textarea class="pi-input" rows="6" data-sim-eft-text placeholder="[Muninn, 舰队装配]&#10;…"></textarea><div><button type="button" class="btn btn-primary" data-sim-eft-go="${s}">加入</button><button type="button" class="btn btn-ghost" data-sim-eft-cancel>取消</button></div></div>` : ''}
    </section>`;
  }).join('');
  if (eftText) { const ta = box.querySelector('[data-sim-eft-text]'); if (ta) ta.value = eftText; }
  if (typing) {
    const input = box.querySelector(`[data-sim-search="${typing.side}"]`);
    input.value = typing.value;
    input.focus();
    try { input.setSelectionRange(typing.pos, typing.pos); } catch { /* search 输入框不支持时忽略 */ }
    if (typing.value.trim()) input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function shipSearch(q) {
  const s = q.toLowerCase();
  const out = [];
  for (const t of ctx.data.types.values()) {
    if (t.category !== ctx.FE.CAT.ship || !t.market) continue;
    if (t.name.toLowerCase().includes(s) || t.en?.toLowerCase().includes(s)) out.push(t);
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => (a.name.toLowerCase().startsWith(s) ? 0 : 1) - (b.name.toLowerCase().startsWith(s) ? 0 : 1) || a.name.length - b.name.length).slice(0, 12);
}

function findRow(el) {
  const [side, id] = el.closest('[data-sim-row]').dataset.simRow.split(':');
  return { side, row: S.sides[side].find((r) => r.id === Number(id)) };
}

function addRow(side, row) {
  // 同船型同来源（击杀记录装配）合并数量
  const same = AUTO.has(row.src) && S.sides[side].find((r) => r.ship === row.ship && r.src === row.src);
  if (same) same.count = Math.min(500, same.count + row.count);
  else S.sides[side].push(row);
  S.result = null;
  save();
  renderSides();
  renderResult();
  if (!same) resolveRow(row); else if (row.fit) prepare(row);
}

function setSource(row, src) {
  row.src = src;
  row.error = '';
  if (AUTO.has(src)) { row.fit = null; row.status = 'idle'; resolveRow(row); }
  else if (src === 'current') { row.fit = ctx.normalize(JSON.parse(JSON.stringify(ctx.getFit()))); row.label = '当前装配'; row.status = 'ok'; prepare(row); }
  else if (src.startsWith('saved:')) {
    const f = ctx.savedFits().find((x) => String(x.id) === src.slice(6));
    row.fit = f ? ctx.normalize(f) : emptyFit(row.ship);
    row.label = f?.name || '我的装配';
    row.status = 'ok';
    prepare(row);
  } else if (src.startsWith('esi:')) {
    const f = (S.esi.fits || []).find((x) => String(x.esiId) === src.slice(4));
    row.fit = f ? ctx.normalize(f) : emptyFit(row.ship);
    row.label = f?.name || '游戏装配';
    row.status = 'ok';
    prepare(row);
  } else if (src === 'hull') { row.fit = emptyFit(row.ship); row.label = '空船'; row.status = 'ok'; prepare(row); }
  S.result = null;
  save();
  renderSides();
  renderResult();
}

function onClick(e) {
  if (e.target.closest('[data-sim-close]') || e.target.classList.contains('modal-backdrop')) { close(); return; }
  if (S.detail && e.target.closest('#simDetail')) { onDetailClick(e); return; }
  const dt = e.target.closest('[data-sim-detail]');
  if (dt) { const { side, row } = findRow(dt); openDetail(side, row.id); return; }
  const opt = e.target.closest('[data-sim-opt]');
  if (opt) {
    const k = opt.dataset.simOpt;
    S.opt[k] = k === 'focus' ? opt.dataset.v : Number(opt.dataset.v);
    opt.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === opt));
    save();
    if (S.result) run();
    return;
  }
  if (e.target.closest('[data-sim-run]')) { run(); return; }
  const bulk = e.target.closest('[data-sim-src]');
  if (bulk) {
    const src = bulk.dataset.simSrc;
    for (const s of SIDES) for (const r of S.sides[s]) if (AUTO.has(r.src) && r.src !== src && (src === 'kb' || hasBattle(r))) { r.src = src; r.fit = null; r.status = 'idle'; resolveRow(r); }
    S.result = null;
    save();
    renderSides();
    renderResult();
    return;
  }
  const ch = e.target.closest('[data-sim-chart]');
  if (ch) { S.chart = ch.dataset.simChart; ch.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === ch)); drawChart(); return; }
  const pick = e.target.closest('[data-sim-pick]');
  if (pick) {
    const [side, ship] = pick.dataset.simPick.split(':');
    document.activeElement?.blur?.();
    addRow(side, newRow(Number(ship), 1));
    return;
  }
  const del = e.target.closest('[data-sim-del]');
  if (del) {
    const { side, row } = findRow(del);
    S.sides[side] = S.sides[side].filter((r) => r !== row);
    S.result = null;
    save();
    renderSides();
    renderResult();
    return;
  }
  const cur = e.target.closest('[data-sim-add-current]');
  if (cur) {
    const fit = ctx.normalize(JSON.parse(JSON.stringify(ctx.getFit())));
    const row = newRow(fit.ship, 1, 'current', fit, '当前装配');
    prepare(row);
    addRow(cur.dataset.simAddCurrent, row);
    return;
  }
  const eft = e.target.closest('[data-sim-eft]');
  if (eft) { S.adding = { side: eft.dataset.simEft }; renderSides(); document.querySelector('[data-sim-eft-text]')?.focus(); return; }
  if (e.target.closest('[data-sim-eft-cancel]')) { S.adding = null; renderSides(); return; }
  const go = e.target.closest('[data-sim-eft-go]');
  if (go) {
    const r = ctx.parseEft(document.querySelector('[data-sim-eft-text]').value);
    if (r.error) { ctx.showToast('无法识别：' + r.error, 'error', 3500); return; }
    const row = newRow(r.fit.ship, 1, 'eft', ctx.normalize(r.fit), r.fit.name || 'EFT 装配');
    prepare(row);
    S.adding = null;
    addRow(go.dataset.simEftGo, row);
    return;
  }
  const clr = e.target.closest('[data-sim-clear]');
  if (clr) { S.sides[clr.dataset.simClear] = []; S.result = null; save(); renderSides(); renderResult(); return; }
  const sw = e.target.closest('[data-sim-swap]');
  if (sw) { [S.sides.A, S.sides.B] = [S.sides.B, S.sides.A]; if (S.real) [S.real.A, S.real.B] = [S.real.B, S.real.A]; save(); renderSides(); run(); }
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-sim-fit]')) { setSource(findRow(t).row, t.value); return; }
  if (t.matches('[data-sim-count]')) {
    const { row } = findRow(t);
    row.count = Math.max(1, Math.min(500, Math.round(Number(t.value)) || 1));
    t.value = row.count;
    S.result = null;
    save();
    renderSides();
    renderResult();
    return;
  }
  if (t.dataset.simOptSelect) { S.opt[t.dataset.simOptSelect] = Number(t.value); save(); if (S.result) run(); return; }
  if (t.dataset.simFlag) {
    S.opt[t.dataset.simFlag] = t.checked;
    save();
    if (t.dataset.simFlag === 'prop') { for (const s of SIDES) S.sides[s].forEach((r) => { if (r.fit) prepare(r); }); renderSides(); }
    if (S.result) run();
  }
}

function onInput(e) {
  const t = e.target;
  if (!t.dataset.simSearch) return;
  const side = t.dataset.simSearch;
  const box = document.querySelector(`[data-sim-suggest="${side}"]`);
  const q = t.value.trim();
  if (!q) { box.hidden = true; return; }
  const hits = shipSearch(q);
  box.innerHTML = hits.map((s) => `<button type="button" class="kb-suggest-item" data-sim-pick="${side}:${s.id}"><img src="${IMG(s.id)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(s.name)}</span><small>${ctx.esc(ctx.data.groups.get(s.group)?.name || '')}</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的舰船</p>';
  box.hidden = false;
}

function run() {
  const pending = SIDES.flatMap((s) => S.sides[s]).filter((r) => !r.unit);
  if (!S.sides.A.length || !S.sides.B.length) { ctx.showToast('两方都要至少有一艘船', 'info'); return; }
  const waiting = pending.filter((r) => r.status === 'loading' || r.status === 'idle');
  if (!SIDES.every((s) => S.sides[s].some((r) => r.unit))) { ctx.showToast('还在读取装配，稍等再试', 'info'); return; }
  S.result = simulate(S.sides, S.opt);
  S.result.skipped = waiting.reduce((t, r) => t + r.count, 0);
  renderResult();
}

// ---------- 结果 ----------
function fmtSec(s) { return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`; }

function renderResult() {
  const box = $('simResult');
  if (!box) return;
  const R = S.result;
  if (!R) { box.innerHTML = ''; return; }
  const { winner, lead } = R;
  const verdict = winner ? `${winner} 方获胜` : lead ? `未分胜负 · ${lead} 方占优` : '势均力敌';
  const skipped = R.skipped ? `<span class="sim-warn">还有 ${R.skipped} 艘船的装配没读到，未计入；读完后再点「开始模拟」</span>` : '';
  const sub = winner ? `用时 ${fmtSec(R.t)}，剩余 ${R.end[winner]} / ${R.start[winner]} 艘` : `${fmtSec(R.t)} 后 A 方剩 ${R.end.A} 艘（${(R.hp.A * 100).toFixed(0)}% 血量），B 方剩 ${R.end.B} 艘（${(R.hp.B * 100).toFixed(0)}%）`;
  const table = (s) => {
    const rows = R.rows.filter((r) => r.side === s);
    const real = S.real?.[s];
    return `<div class="sim-res-side">
      <h5><span class="sim-badge">${s} 方</span>损失 ${R.start[s] - R.end[s]} / ${R.start[s]}${real ? ` · 实际损失 ${[...real.values()].reduce((a, b) => a + b, 0)}` : ''}</h5>
      <div class="pi-table-wrap"><table class="pi-table sim-table">
        <thead><tr><th>舰船</th><th class="num">出场</th><th class="num">模拟损失</th>${real ? '<th class="num">实际损失</th>' : ''}<th class="num pi-hide-sm">输出</th><th class="num pi-hide-sm">承伤</th>${R.rows.some((r) => r.repaired) ? '<th class="num pi-hide-sm">遥修</th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><div class="pi-prod"><img src="${IMG(r.row.ship)}" alt="" width="24" height="24" loading="lazy"><span>${ctx.esc(ctx.data.types.get(r.row.ship)?.name || '')}</span></div></td>
          <td class="num">${r.n}</td><td class="num${r.lost ? ' sim-lost' : ''}">${r.lost}</td>${real ? `<td class="num">${real.get(r.row.ship) || 0}</td>` : ''}
          <td class="num pi-hide-sm">${ctx.formatISK(r.dealt)}</td><td class="num pi-hide-sm">${ctx.formatISK(r.taken)}</td>${R.rows.some((x) => x.repaired) ? `<td class="num pi-hide-sm">${r.repaired ? ctx.formatISK(r.repaired) : '—'}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  };
  const firsts = R.kills.slice(0, 12);
  box.innerHTML = `<section class="sim-result">
    <div class="sim-hero${winner ? ' sim-win-' + winner.toLowerCase() : ''}">
      <div><b>${verdict}</b><span>${sub}</span>${skipped}</div>
      <button type="button" class="btn btn-ghost" data-sim-swap title="交换 A / B 两方">交换两方</button>
    </div>
    <div class="sim-chart">
      <div class="kb-br-chart-head">
        <h4>战况走势</h4>
        <div class="kb-br-legend"><span class="a"><i></i>A 方</span><span class="b"><i></i>B 方</span></div>
        <div class="segmented" role="group" aria-label="图表类型">
          <button type="button" data-sim-chart="ships" class="${S.chart !== 'hp' ? 'active' : ''}">剩余舰船</button>
          <button type="button" data-sim-chart="hp" class="${S.chart === 'hp' ? 'active' : ''}">剩余血量</button>
        </div>
      </div>
      <div class="kb-br-plot" id="simPlot"><svg></svg><div class="kb-br-tip" id="simTip" hidden></div></div>
    </div>
    ${firsts.length ? `<div class="sim-kills"><h5>阵亡顺序</h5><div>${firsts.map((k) => `<span class="sim-kill sim-kill-${k.side.toLowerCase()}"><small>${fmtSec(k.t)}</small><img src="${IMG(k.ship)}" alt="" width="20" height="20" loading="lazy">${ctx.esc(ctx.data.types.get(k.ship)?.name || '')}</span>`).join('')}${R.kills.length > firsts.length ? `<span class="sim-more">…共 ${R.kills.length} 艘</span>` : ''}</div></div>` : ''}
    <div class="sim-res-cols">${table('A')}${table('B')}</div>
  </section>`;
  drawChart();
}

// 走势图：与战场统计「战况走势」同样式（SVG 阶梯线 + 渐变面积 + 阵亡标记 + 十字准线提示）
function drawChart() {
  const plot = $('simPlot');
  const R = S.result;
  if (!plot || !R) return;
  const hp = S.chart === 'hp';
  const tl = R.timeline;
  const W = Math.max(280, plot.clientWidth), H = W < 600 ? 190 : 230;
  const L = 44, Rp = 14, T = 12, B = 26;
  const iw = W - L - Rp, ih = H - T - B;
  const tMax = Math.max(10, tl[tl.length - 1].t);
  const top = Math.max(1, R.start.A, R.start.B);
  const ys = hp ? 0.25 : [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v * 4 >= top * 1.04) || Math.ceil(top / 4);
  const max = ys * 4;
  const x = (t) => L + t / tMax * iw;
  const y = (v) => T + ih - v / max * ih;
  const val = (p, s) => (hp ? p['hp' + s] : p[s]);
  const fmtT = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`);
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = ys * i;
    grid += `<line class="grid${i ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${hp ? Math.round(v * 100) + '%' : Math.round(v)}</text>`;
  }
  const step = [5, 10, 15, 20, 30, 60, 120, 180, 300].find((m) => tMax / m <= Math.max(3, Math.floor(iw / 80))) || 600;
  for (let t = step; t <= tMax; t += step) grid += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + ih}"/><text class="ax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmtT(t)}</text>`;
  // 舰船数是阶梯线，血量是折线
  const line = (s) => tl.map((p, i) => (i ? (hp ? `L${x(p.t).toFixed(1)},${y(val(p, s)).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(val(p, s)).toFixed(1)}`) : `M${x(p.t).toFixed(1)},${y(val(p, s)).toFixed(1)}`)).join('');
  const area = (s) => line(s) + `V${y(0)}H${x(0)}Z`;
  const at = (t) => tl[Math.min(tl.length - 1, Math.max(0, Math.round(t)))];
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = `<defs>
      <linearGradient id="simGa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--br-a)" stop-opacity=".24"/><stop offset="1" stop-color="var(--br-a)" stop-opacity="0"/></linearGradient>
      <linearGradient id="simGb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--br-b)" stop-opacity=".24"/><stop offset="1" stop-color="var(--br-b)" stop-opacity="0"/></linearGradient>
    </defs><rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>${grid}
    <path d="${area('A')}" fill="url(#simGa)"/><path d="${area('B')}" fill="url(#simGb)"/>
    <path class="ln a" d="${line('A')}"/><path class="ln b" d="${line('B')}"/>
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>`;
  const tip = $('simTip'), cross = svg.querySelector('.cross'), hit = svg.querySelector('.hit');
  hit.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const t = Math.min(tMax, Math.max(0, (e.clientX - r.left - L) / iw * tMax));
    const p = at(t);
    const px = x(p.t);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    const died = R.kills.filter((k) => k.t <= p.t);
    tip.innerHTML = `<b>${fmtSec(p.t)}</b><span class="a">A 方 ${p.A} / ${R.start.A} 艘 · 血量 ${(p.hpA * 100).toFixed(0)}%</span><span class="b">B 方 ${p.B} / ${R.start.B} 艘 · 血量 ${(p.hpB * 100).toFixed(0)}%</span>${died.length ? `<small>已阵亡 ${died.length} 艘</small>` : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(W - tw - 4, Math.max(4, px + 12 + tw > W ? px - tw - 12 : px + 12)) + 'px';
    tip.style.top = T + 4 + 'px';
  };
  hit.onmouseleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
}

// ---------- 装配详情 / 更换 ----------
// 左边是这型船能用的装配（本场阵亡的几套、最近常见的几套、我的装配、游戏装配、当前装配、空船），右边是选中那套的槽位与属性
const SLOT_NAMES = { high: '高槽', mid: '中槽', low: '低槽', rig: '改装件', sub: '子系统' };

function showDetailPane(on) {
  const body = $('simBody'), pane = $('simDetail');
  if (!body || !pane) return;
  body.hidden = on;
  pane.hidden = !on;
  if (!on) pane.innerHTML = '';
}

function closeDetail() {
  S.detail = null;
  showDetailPane(false);
}

const detailRow = () => S.detail && S.sides[S.detail.side]?.find((r) => r.id === S.detail.id);

async function openDetail(side, id, sel = 'row') {
  const token = {};
  S.detail = { side, id, groups: null, sel, token };
  showDetailPane(true);
  renderDetail();
  const row = detailRow();
  if (!row) return;
  const groups = await candidates(row);
  if (S.detail?.token !== token) return;
  S.detail.groups = groups;
  if (!groups.some((g) => g.items.some((x) => x.key === S.detail.sel))) S.detail.sel = 'row';
  renderDetail();
}

async function candidates(row) {
  const groups = [];
  const kb = async (title, kills, prefix) => {
    const r = await loadKb(row.ship, kills).catch(() => null);
    if (r?.list?.length) groups.push({ title, sub: `最近 ${r.total} 次损失`, items: r.list.map((g, i) => ({ key: `${prefix}:${i}`, fit: g.fit, label: `${title} #${i + 1}`, meta: `×${g.n}` })) });
  };
  if (row.fit) groups.push({ title: '正在使用', items: [{ key: 'row', fit: row.fit, label: row.label || '当前选择', meta: '' }] });
  if (row.kills?.length) await kb('本场阵亡装配', row.kills, 'bk');
  if (row.killsOther?.length) await kb('本场对方同型船装配', row.killsOther, 'bo');
  await kb('最近常见装配', null, 'kb');
  const mine = [];
  const cur = ctx.getFit();
  if (cur?.ship === row.ship) mine.push({ key: 'current', fit: cur, label: '当前装配', meta: '装配页' });
  for (const f of ctx.savedFits().filter((x) => x.ship === row.ship)) mine.push({ key: 'saved:' + f.id, fit: f, label: f.name || '未命名', meta: '我的装配' });
  if (mine.length) groups.push({ title: '我的装配', items: mine });
  if (ctx.hasEsi?.()) {
    const items = (S.esi.fits || []).filter((x) => x.ship === row.ship).map((f) => ({ key: 'esi:' + f.esiId, fit: f, label: f.name || '未命名', meta: '游戏装配' }));
    groups.push({ title: '游戏装配', items, note: S.esi.loading ? '读取中…' : S.esi.error ? '读取失败：' + S.esi.error : items.length ? '' : '游戏里没有保存这型船的装配' });
  }
  groups.push({ title: '其他', items: [{ key: 'hull', fit: emptyFit(row.ship), label: '空船（无装备）', meta: '' }] });
  return groups;
}

// 选中装配按模拟同样的规则计算（长冷却装备与推进器的开关）
function evaluate(item) {
  if (!item.ev) {
    const tmp = { fit: ctx.normalize(JSON.parse(JSON.stringify(item.fit))) };
    try { prepare(tmp); } catch { tmp.unit = null; }
    item.ev = tmp;
  }
  return item.ev;
}

function renderDetail() {
  const pane = $('simDetail');
  const row = detailRow();
  if (!pane || !row) { closeDetail(); return; }
  const { esc } = ctx;
  const t = ctx.data.types.get(row.ship);
  const D = S.detail;
  const items = D.groups ? D.groups.flatMap((g) => g.items) : [];
  const sel = items.find((x) => x.key === D.sel) || (row.fit ? { key: 'row', fit: row.fit, label: row.label } : null);
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  const list = D.groups ? D.groups.map((g) => `<div class="sim-dt-group">
      <h5>${esc(g.title)}${g.sub ? `<small>${esc(g.sub)}</small>` : ''}</h5>
      ${g.items.map((x) => { const u = evaluate(x).unit; return `<button type="button" class="sim-dt-item${x.key === D.sel ? ' active' : ''}" data-sim-dt-pick="${esc(x.key)}">
        <span><b>${esc(x.label)}</b>${x.meta ? `<em>${esc(x.meta)}</em>` : ''}</span>
        <small>${u ? `${num(u.dps)} DPS · ${ctx.formatISK(u.ehp)} EHP` : '—'}</small></button>`; }).join('')}
      ${g.note ? `<p class="sim-dt-note">${esc(g.note)}</p>` : ''}
    </div>`).join('') : '<p class="sim-loading sim-dt-note">读取可用装配…</p>';
  pane.innerHTML = `
    <div class="sim-dt-head">
      <button type="button" class="btn btn-ghost" data-sim-dt-back><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>返回模拟</button>
      <img src="${IMG(row.ship, 'icon', 64)}" alt="" width="40" height="40">
      <div class="sim-dt-title"><b>${esc(t?.name || '')}</b><small><span class="sim-badge sim-side-${D.side.toLowerCase()}">${D.side} 方</span>×${row.count} · 正在使用：${esc(row.label || '—')}</small></div>
    </div>
    <div class="sim-dt-body">
      <aside class="sim-dt-list">${list}</aside>
      <div class="sim-dt-view">${sel ? fitView(sel, row) : ''}</div>
    </div>`;
}

function fitView(item, row) {
  const { esc, FE, data } = ctx;
  const ev = evaluate(item);
  const u = ev.unit;
  const fit = ev.fit;
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  const name = (id) => esc(data.types.get(id)?.name || '#' + id);
  const icon = (id, sz = 24) => `<img src="${IMG(id, 'icon', 32)}" alt="" width="${sz}" height="${sz}" loading="lazy">`;
  const slots = FE.SLOTS.map((s) => {
    const mods = (fit.slots[s] || []).filter(Boolean);
    if (!mods.length) return '';
    // 同装备同弹药同状态合并成一行
    const grouped = [];
    for (const m of mods) {
      const off = forcedOff(m);
      const k = `${m.type}|${m.charge || ''}|${m.state}|${off || ''}`;
      const g = grouped.find((x) => x.k === k);
      if (g) g.n += 1; else grouped.push({ k, m, off, n: 1 });
    }
    return `<div class="sim-dt-slot"><h6>${SLOT_NAMES[s]}<small>${mods.length}</small></h6>${grouped.map(({ m, off, n }) => `<div class="sim-dt-mod${(FE.STATE_RANK[m.state] || 0) < 1 || off ? ' dim' : ''}">
      ${icon(m.type)}<span><b>${n > 1 ? `<i>${n}×</i>` : ''}${name(m.type)}</b>${m.charge ? `<small>${icon(m.charge, 14)}${name(m.charge)}</small>` : ''}</span>
      ${off ? `<em>${esc(off)}</em>` : m.state === 'offline' ? '<em>离线</em>' : ''}</div>`).join('')}</div>`;
  }).join('');
  const drones = (fit.drones || []).length ? `<div class="sim-dt-slot"><h6>无人机</h6>${fit.drones.map((d) => `<div class="sim-dt-mod">${icon(d.type)}<span><b><i>${d.count}×</i>${name(d.type)}</b>${d.active ? `<small>出动 ${d.active}</small>` : ''}</span></div>`).join('')}</div>` : '';
  let stats = '<p class="sim-dt-note">这套装配算不出属性</p>';
  if (u) {
    const totalDmg = u.types.reduce((a, b) => a + b, 0) || 1;
    const DK = ['em', 'th', 'ki', 'ex'];
    const dmgBar = `<div class="fit-dmg">${u.types.map((v, i) => `<i class="is-${DK[i]}" style="flex:${v || 0.0001}" title="${DAMAGE_NAMES[i]} ${Math.round(v / totalDmg * 100)}%"></i>`).join('')}</div>`;
    const res = LAYER_NAMES.map((l, i) => `<tr><th>${l}</th>${u.res[i].map((r) => `<td style="--r:${Math.round((1 - r) * 100)}%">${Math.round((1 - r) * 100)}%</td>`).join('')}<td class="hp">${ctx.formatISK(u.max[i])}</td></tr>`).join('');
    const remote = u.remote.reduce((s, x) => s + x.rate, 0);
    const local = u.local.reduce((a, b) => a + (b || 0), 0);
    stats = `<div class="sim-dt-cards">
        <div><small>DPS</small><b>${num(u.dps)}</b>${u.dps ? dmgBar : ''}</div>
        <div><small>EHP</small><b>${ctx.formatISK(u.ehp)}</b></div>
        <div><small>最大速度</small><b>${num(u.vel)}<em>m/s</em></b></div>
        <div><small>信号半径</small><b>${num(u.sig)}<em>m</em></b></div>
        <div><small>扫描分辨率</small><b>${num(u.scanRes)}<em>mm</em></b></div>
        ${local ? `<div><small>本地维修</small><b>${num(local)}<em>HP/s</em></b></div>` : ''}
        ${remote ? `<div><small>遥修</small><b>${num(remote)}<em>HP/s</em></b></div>` : ''}
        ${u.webs.length || u.paints.length ? `<div><small>网子 / 标记</small><b>${u.webs.length} / ${u.paints.length}</b></div>` : ''}
      </div>
      <table class="fit-resist sim-dt-res"><thead><tr><th></th>${DAMAGE_NAMES.map((n, j) => `<th class="is-${DK[j]}">${n}</th>`).join('')}<th>HP</th></tr></thead><tbody>${res}</tbody></table>`;
  }
  const using = item.key === 'row';
  return `<div class="sim-dt-view-head"><h5>${esc(item.label)}</h5>
      <div class="sim-dt-actions">
        <button type="button" class="btn btn-primary" data-sim-dt-use${using ? ' disabled' : ''}>${using ? '正在使用' : '使用这套装配'}</button>
        <button type="button" class="btn btn-ghost" data-sim-dt-open title="在装配页打开这套装配，可以改装备后再加入模拟">在装配页打开</button>
      </div></div>
    ${stats}
    <div class="sim-dt-slots">${slots}${drones}${!slots && !drones ? '<p class="sim-dt-note">没有装备</p>' : ''}</div>`;
}

function onDetailClick(e) {
  const row = detailRow();
  if (!row || e.target.closest('[data-sim-dt-back]')) { closeDetail(); return; }
  const items = S.detail.groups ? S.detail.groups.flatMap((g) => g.items) : [];
  const pick = e.target.closest('[data-sim-dt-pick]');
  if (pick) {
    S.detail.sel = pick.dataset.simDtPick;
    renderDetail();
    // 窄屏时列表在上、详情在下：选完滚到详情
    if (matchMedia('(max-width: 760px)').matches) $('simDetail').querySelector('.sim-dt-view')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const item = items.find((x) => x.key === S.detail.sel);
  if (!item) return;
  if (e.target.closest('[data-sim-dt-use]')) {
    useFit(row, item);
    closeDetail();
    return;
  }
  if (e.target.closest('[data-sim-dt-open]')) {
    ctx.openInFitting(ctx.normalize(JSON.parse(JSON.stringify(item.fit))));
    close();
  }
}

function useFit(row, item) {
  // 我的装配 / 游戏装配 / 当前装配 / 空船：与下拉框同一个来源
  if (/^(saved|esi):/.test(item.key) || item.key === 'current' || item.key === 'hull') { setSource(row, item.key); return; }
  row.src = 'pick';
  row.error = '';
  row.fit = ctx.normalize(JSON.parse(JSON.stringify(item.fit)));
  row.label = item.label + (item.meta ? ' ' + item.meta : '');
  row.status = 'ok';
  prepare(row);
  S.result = null;
  save();
  renderSides();
  renderResult();
}
