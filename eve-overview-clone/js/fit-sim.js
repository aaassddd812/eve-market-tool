// ===== 舰队对战模拟 =====
// A / B 两方各若干艘舰船（每行：船型 + 装配 + 数量）。每艘船的属性由装配引擎（fit-engine.js）算出，
// 交战在三维空间里逐 0.5 秒推进（sim-engine.js）：真实走位、按角速度与表面距离逐发掷骰的炮台、会飞的导弹、弹药装填、电容、
// 电子战与遥修按实际距离与衰减计算；规则见 sim-engine.js 开头。
// 战局不直接出结果：「战场」里实时推进，可暂停、调速；3D 视图（sim-3d.js）点按钮才加载，全屏时下方显示双方舰船状态；
// 每方可预设支援舰队（跃迁 / 诱导进场，自定义位置，手动或定时进场），可设火力 / 后勤走位官；点一艘船可以让对面集火它；打完（或点「直接出结果」）才显示胜负与分析，之后可以拖动时间轴回放。
// 结果附胜负原因、ISK 交换比、距离 × 机动扫描与落后一方至少需要的船数；可设为对照比较改动前后，可生成分享链接。
// 装配来源：击杀记录里这型船最近阵亡时最常见的装配（fit-kb.js commonFit）、当前装配、我的装配、游戏内保存的装配（ESI）、EFT 文本，或空船；
// 点舰船打开装配详情：看槽位与属性，从本场 / 最近常见的几套装配和自己的装配里换一套。
// 战场统计（kb-br.js）可把一场会战双方的实际出场舰船带进来（openSim(preset)），结果旁边对照实际损失；
// 「AT 赛」（sim-at.js）可选这一届联盟锦标赛已打过的比赛，双方选手各一行带进来（蓝队 A 方、红队 B 方），战场上像比赛直播一样显示两队名单与血条。
import { commonFit } from './fit-kb.js?v=v30';
import { createBattle, simulate } from './sim-engine.js?v=v43';
import { initAt, openAt, loadAtData } from './sim-at.js?v=v1';
import { bindUnit, buildUnit, pilotUnit, forcedOff, BURSTS, BURST_MULT, mean } from './sim-unit.js?v=v10';
import * as NE from './native-engine.js?v=v2';

let ctx;   // data, FE, getFit, savedFits, parseEft, normalize, esc, formatNumber, formatISK, showToast, store, hasEsi, esiFits, openInFitting
const $ = (id) => document.getElementById(id);
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const KEY = 'eve-fit-sim-v1';
const DAMAGE_NAMES = ['电磁', '热能', '动能', '爆炸'];
const LAYER_NAMES = ['护盾', '装甲', '结构'];
const DISTANCES = [5, 10, 20, 30, 50, 70, 100, 150];   // 开局两队相隔（km）
const DURATIONS = [[120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟'], [900, '15 分钟'], [1800, '30 分钟']];
const FOCUS = [['weak', '最脆优先'], ['dps', '输出优先'], ['spread', '分散']];
const MOVES = [['orbit', '环绕'], ['range', '保持距离'], ['kite', '风筝']];
const MOVE_TIP = { orbit: '在主力武器的理想距离上高速环绕目标（横向速度大，难被打中）', range: '停在主力武器的理想距离对射，横向速度小（舰队对射常用）', kite: '在最远射程环绕，敌人贴近就拉开距离' };
// 常见打法：一键设置交战距离、目标机动与分阶段
const SCENES = [
  ['brawl', '近身缠斗', { dist: 10, moveA: 'orbit', moveB: 'orbit' }, '10 km 开局 · 双方环绕'],
  ['mid', '中距对射', { dist: 30, moveA: 'range', moveB: 'range' }, '30 km · 保持距离'],
  ['snipe', '远程狙击', { dist: 100, moveA: 'range', moveB: 'range' }, '100 km · 保持距离'],
  ['kite', '风筝对冲锋', { dist: 50, moveA: 'kite', moveB: 'orbit' }, 'A 风筝 · B 贴近环绕']
];
const SQUAD = 15;   // 集火时每 15 艘船共用一个目标（大舰队会同时打多个目标，避免几百艘船打一艘的过量伤害）
const SIDES = ['A', 'B'];
function sideDefaults() { return { skills: 'max', heat: false, bursts: [] }; }
// 自动装配来源：battle 本场阵亡装配（会战监制队一般同一型船同一套装配）/ kb 最近常见装配
const AUTO = new Set(['battle', 'kb']);

const S = {
  sides: { A: [], B: [] },
  opt: { dist: 30, moveA: 'orbit', moveB: 'orbit', focus: 'weak', logi: true, ewar: true, cap: true, prop: false, max: 1800, score: 'isk' },
  sideOpt: { A: sideDefaults(), B: sideDefaults() },   // 每方：技能（max / esi）、超载、指挥脉冲
  support: { A: [], B: [] },  // 每方预设的支援舰队 [{ id, name, rows, mode, ref, dist, dir, at }]
  esiSkills: null,            // 已绑定角色的技能 { name, levels }
  prices: null,               // 全服均价 Map
  sweep: null, base: null,    // 距离 × 机动扫描结果；对照（设为对照时的结果摘要）
  title: '', real: null,      // 来自会战：标题与实际损失 { A: Map(ship -> n), B }
  teams: null,                // 来自 AT 赛：{ id: 比赛, win: 实际胜方 A|B, A: { id: 联盟, name }, B }
  back: '',                   // 来自战场统计时的地址（「返回战场统计」）
  result: null, seq: 0, adding: null, chart: 'ships',
  esi: { fits: null, loading: false, error: '' },   // 已绑定角色的游戏内装配
  detail: null,                                     // 装配详情面板 { side, id, groups, sel }
  menu: false                                       // 对局存档菜单是否展开
};
let root = null;
const SAVES_KEY = 'eve-sim-saves-v1';   // 对局存档：[{ id, name, at, title, opt, sides }]
const SAVES_MAX = 20;

export function initSim(context) {
  ctx = context;
  bindUnit(ctx, S.opt);
  initAt(ctx);
  const q = ctx.store.getJSON(Q_KEY, null);
  if (QUALITY.some(([v]) => v === q)) BT.quality = q;
  try {
    const saved = ctx.store.getJSON(KEY, null);
    if (saved) loadState(saved);
  } catch { /* 默认 */ }
}

const packRows = (list) => list.map(({ ship, count, src, fit, label, kills, killsOther, lead, move, cyno, pilot, pilotId, flag, realDead, at }) => ({ ship, count, src, kills, killsOther, fit: AUTO.has(src) ? null : fit, label: AUTO.has(src) ? '' : label, lead, move, cyno, pilot, pilotId, flag, realDead, at }));
const packFleets = (list) => list.map(({ rows, ...f }) => ({ ...f, rows: packRows(rows) }));
const loadRows = (list) => (list || []).filter((r) => ctx.data.types.has(r.ship)).map((r) => ({ ...r, id: ++S.seq, status: r.fit ? 'ok' : 'idle' }));
function packState() {
  return { opt: S.opt, side: S.sideOpt, title: S.title, back: S.back, real: S.real ? { A: [...S.real.A], B: [...S.real.B] } : null, teams: S.teams, sides: { A: packRows(S.sides.A), B: packRows(S.sides.B) }, support: { A: packFleets(S.support.A), B: packFleets(S.support.B) } };
}
function loadState(st) {
  Object.assign(S.opt, st.opt || {});
  // 旧版存档：固定距离 + 目标机动 → 开局距离 + 走位
  for (const k of ['trans', 'phase', 'dist2', 'at']) delete S.opt[k];
  if (!DISTANCES.includes(S.opt.dist)) S.opt.dist = DISTANCES.reduce((a, b) => (Math.abs(b - S.opt.dist) < Math.abs(a - S.opt.dist) ? b : a));
  for (const k of ['moveA', 'moveB']) if (!MOVES.some(([v]) => v === S.opt[k])) S.opt[k] = 'orbit';
  for (const s of SIDES) S.sideOpt[s] = { ...sideDefaults(), ...(st.side?.[s] || {}) };
  if (!ctx.hasEsi?.()) for (const s of SIDES) S.sideOpt[s].skills = 'max';
  for (const s of SIDES) S.sides[s] = loadRows(st.sides?.[s]);
  for (const s of SIDES) S.support[s] = (st.support?.[s] || []).map((f) => ({ ...f, id: ++fleetSeq, rows: loadRows(f.rows) }));
  S.title = st.title || '';
  S.back = st.back || '';
  S.real = st.real ? { A: new Map(st.real.A || []), B: new Map(st.real.B || []) } : null;
  S.teams = st.teams || null;
}
function save() {
  ctx.store.setJSON(KEY, packState());
}

// 战场模拟页：root 为页面容器；preset 来自战场统计 { title, a: [{ ship, count, kills, killsOther }], b, real: { A: [[ship, n]], B }, back }
export function mountSim(el, preset = null, restored = false) {
  const fresh = root !== el || !el.dataset.ready;
  root = el;
  // 分享链接 #sim=…：读出对局后整页重画
  const share = /^#sim=([\w-]+)/.exec(location.hash);
  if (share) {
    history.replaceState(null, '', location.pathname + '#sim');
    readShare(share[1]).then((st) => {
      loadState(st);
      Object.assign(S, { result: null, detail: null, base: null, sweep: null });
      save();
      render();
      for (const s of SIDES) [...S.sides[s], ...fleetRows(s)].forEach(resolveRow);
      ensureEsiSkills();
      schedule(0);
      ctx.showToast('已打开分享的对局', 'success');
    }).catch(() => ctx.showToast('分享链接无效', 'error'));
  }
  if (!S.prices) ctx.prices?.().then((m) => { if (m?.size) { S.prices = m; renderResult(); } }).catch(() => {});
  if (fresh) {
    el.dataset.ready = '1';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('paste', onPaste);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root?.offsetParent && BT.placing) { endPlace(true); return; } if (e.key === 'Escape' && root?.offsetParent && S.detail) closeDetail(); });
    document.addEventListener('click', (e) => { if (S.menu && !e.target.closest('.sim-menu')) toggleMenu(false); });
    document.addEventListener('fullscreenchange', () => updateBattleUi());
    let w = 0;
    window.addEventListener('resize', () => { if (root?.offsetParent && root.clientWidth !== w) { w = root.clientWidth; drawChart(); } });
  }
  if (preset?.a) {
    S.title = preset.title || '';
    S.back = preset.back || '';
    S.real = preset.real ? Object.fromEntries(SIDES.map((s) => [s, new Map(preset.real[s] || [])])) : null;
    S.teams = null;
    const isShip = (r) => ctx.data.types.get(r.ship)?.category === ctx.FE.CAT.ship;
    const row = (r) => Object.assign(newRow(r.ship, r.count, r.kills?.length || r.killsOther?.length ? 'battle' : 'kb'), { kills: r.kills || [], killsOther: r.killsOther || [] });
    S.sides.A = preset.a.filter(isShip).map(row);
    S.sides.B = preset.b.filter(isShip).map(row);
    S.result = null;
    S.detail = null;
    S.base = null;
    save();
  }
  ensureEsiSkills();
  if (!fresh && restored && root.querySelector('#simBody')) { renderSides(); loadEsi(); return; }
  S.detail = null;
  render();
  for (const s of SIDES) [...S.sides[s], ...fleetRows(s)].forEach(resolveRow);
  loadEsi();
  schedule(0);
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

// 改动后自动重新模拟（短暂合并连续改动；装配还在读取时先用读到的部分算，读完再更新）
let runTimer = 0;
function schedule(delay = 250) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, delay);
}
function changed() {
  sweepSeq += 1;
  S.sweep = null;
  save();
  renderSides();
  schedule();
}

function newRow(ship, count = 1, src = 'kb', fit = null, label = '') {
  return { id: ++S.seq, ship, count: Math.max(1, Math.min(500, Math.round(count) || 1)), src, fit, label, status: fit ? 'ok' : 'idle' };
}

// ---------- 装配来源 ----------
const kbCache = new Map();   // 船型（+ 指定击杀）-> Promise<{ fit, n, list: [{ fit, n }], total } | null>
// 同时最多查 10 种船（一场会战可能有几十种船；生产站是 HTTP/2，不受浏览器每站 6 个连接的限制）
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 10) await new Promise((r) => waiting.push(r));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
}
// 击杀记录装配（按船型 + 指定击杀缓存，详情面板的候选列表也用它）
// 最近常见装配：先看最近 7 天；冷门船 7 天里没人死过时，放宽到服务器保存的全部记录（仍是最近 20 次损失）
function loadKb(ship, kills = null) {
  const key = kills?.length ? ship + ':' + kills.join(',') : String(ship);
  const get = () => (kills?.length ? commonFit(ship, { kills }) : commonFit(ship).then((r) => r || commonFit(ship, { days: 3650 })));
  if (!kbCache.has(key)) kbCache.set(key, limited(get).catch((e) => { kbCache.delete(key); throw e; }));
  return kbCache.get(key);
}
const hasBattle = (row) => Boolean(row.kills?.length || row.killsOther?.length);
async function resolveRow(row) {
  if (!AUTO.has(row.src) || row.status === 'loading' || (row.status === 'ok' && row.fit)) { if (row.fit && !row.stats) prepare(row); return; }
  const src = row.src;
  row.status = 'loading';
  renderSidesSoon();
  try {
    // 本场阵亡装配：先看本方这型船在这场的损失，没有再看对方同型船的损失；都没有时退回最近常见装配
    let r = null, label = '';
    if (src === 'battle') {
      if (row.kills?.length) { r = await loadKb(row.ship, row.kills); if (r) label = row.at ? '比赛实际装配' : `本场阵亡装配 ×${r.n}`; }
      if (!r && row.killsOther?.length) { r = await loadKb(row.ship, row.killsOther); if (r) label = row.at ? `AT 同型船实际装配 ×${r.n}` : `本场对方同型船装配 ×${r.n}`; }
    }
    if (!r) { r = await loadKb(row.ship); if (r) label = src === 'battle' ? `本场没有阵亡 · 常见装配 ×${r.n}` : `常见装配 ×${r.n}`; }
    if (row.src !== src) return;
    if (r) {
      row.fit = ctx.normalize(r.fit);
      row.label = label;
      row.status = 'ok';
    } else {
      row.fit = emptyFit(row.ship);
      row.label = '击杀记录里没有这型船 · 空船';
      row.status = 'none';
    }
  } catch (error) {
    row.fit = emptyFit(row.ship);
    row.label = '读取失败 · 空船';
    row.status = 'none';
    row.error = error.message;
  }
  prepare(row);
  renderSidesSoon();
  // 支援舰队的船读完装配不重新布阵（否则正在进行的战斗会被重置），由 fleetChanged 处理
  if (SIDES.some((s) => S.sides[s].includes(row))) schedule(400);
}

function emptyFit(ship) {
  return { id: null, name: '', ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
}

function prepare(row, side = sideOf(row)) {
  const so = S.sideOpt[side] || sideDefaults();
  const skills = so.skills === 'esi' && S.esiSkills ? S.esiSkills.levels : 'max';
  bindUnit(ctx, S.opt);
  const r = buildUnit(row.fit, { skills, heat: so.heat, bursts: so.bursts });
  row.calc = r.calc;
  row.stats = r.stats;
  row.unit = r.unit;
}
// 某一方选了「按角色技能」：读一次角色技能，读到后重新计算
function ensureEsiSkills() {
  if (S.esiSkills || S.esiSkillsP || !SIDES.some((s) => S.sideOpt[s].skills === 'esi')) return;
  S.esiSkillsP = ctx.esiSkills().then((sk) => { S.esiSkills = sk; }).catch((e) => {
    for (const s of SIDES) S.sideOpt[s].skills = 'max';
    ctx.showToast('读取角色技能失败：' + e.message + '，已改用全部 5 级', 'error', 4000);
  }).finally(() => { S.esiSkillsP = null; reprepare(); });
}
// 行在哪一方（新建还没加入的行按 A 方算，加入时会按所在方重新计算）
const fleetRows = (s) => S.support[s].flatMap((f) => f.rows);
const sideOf = (row) => SIDES.find((s) => S.sides[s].includes(row) || fleetRows(s).includes(row)) || 'A';
function reprepare(list = SIDES) {
  for (const s of list) for (const r of [...S.sides[s], ...fleetRows(s)]) if (r.fit) prepare(r, s);
  changed();
}


// ---------- ISK ----------
// 装配价值：全服均价（ESI /markets/prices/），船体 + 装备 + 弹药 + 无人机；突变装备用深渊参考估价
function fitValue(fit) {
  const P = S.prices;
  if (!P || !fit) return 0;
  const { FE, data } = ctx;
  const p = (id) => P.get(id) || 0;
  let v = p(fit.ship);
  for (const s of FE.SLOTS) {
    for (const m of fit.slots[s] || []) {
      if (!m) continue;
      v += m.mut && m.abyssal?.value ? m.abyssal.value : p(m.type);
      const a = data.types.get(m.type), c = m.charge && data.types.get(m.charge);
      if (a && c) v += p(m.charge) * FE.chargeCount(a, c);
    }
  }
  for (const d of fit.drones || []) v += p(d.type) * d.count;
  return v;
}
// 每方出场 / 损失的 ISK 与交换效率（对方损失 / 双方损失）
function iskOf(R) {
  if (!S.prices) return null;
  const out = { A: { field: 0, lost: 0 }, B: { field: 0, lost: 0 } };
  for (const r of R.rows) {
    const v = fitValue(r.row.fit);
    r.value = v;
    out[r.side].field += v * r.n;
    out[r.side].lost += v * r.lost;
  }
  const total = out.A.lost + out.B.lost;
  out.A.eff = total ? out.B.lost / total : null;
  out.B.eff = total ? out.A.lost / total : null;
  return out;
}

// ---------- AT 得分 ----------
// 联盟锦标赛规则：击毁对方的船得它的分值；同型船第 k 艘（从 0 数）的分值 = 基础分 + k × 重复加价，这里按同型船平均摊到每艘；
// 一方派出的总分不到上限（200）时，差额算给对方；全歼对方直接获胜。分值表来自 at-data.json（server/build_at.py 从官方配队表格生成）。
const SCORE_MODES = [['isk', '看战损'], ['at', 'AT 得分']];
const AT = { points: null, limit: 200, loading: false };
function atReady() {
  if (AT.points) return true;
  if (!AT.loading) {
    AT.loading = true;
    loadAtData().then((d) => { AT.points = new Map(Object.entries(d.points || {}).map(([k, v]) => [Number(k), v])); AT.limit = d.limit || 200; scoreChanged(); })
      .catch(() => { AT.loading = false; ctx.showToast?.('AT 分值表读取失败，先按战损显示', 'error'); });
  }
  return false;
}
// fielded / lost：{ A: Map(船型 → 艘数), B }；返回 { A: 得分, B, field: { A, B }, miss: 不在分值表里的艘数 }
function atScore(fielded, lost) {
  const out = { A: 0, B: 0, field: { A: 0, B: 0 }, miss: 0 };
  const avg = { A: new Map(), B: new Map() };
  for (const s of SIDES) for (const [ship, n] of fielded[s]) {
    const p = AT.points.get(ship);
    if (!p) { out.miss += n; continue; }
    out.field[s] += n * p[0] + p[1] * n * (n - 1) / 2;
    avg[s].set(ship, p[0] + p[1] * (n - 1) / 2);
  }
  for (const s of SIDES) {
    const o = s === 'A' ? 'B' : 'A';
    for (const [ship, n] of lost[o]) out[s] += n * (avg[o].get(ship) || 0);
    out[s] += Math.max(0, AT.limit - out.field[o]);
    out[s] = Math.round(out[s]);
  }
  return out;
}
const tally = (list) => { const m = new Map(); for (const [ship, n] of list) if (n) m.set(ship, (m.get(ship) || 0) + n); return m; };
function scoreChanged() {
  renderVerdict();
  if (BT.b) { if (root?.querySelector('#simSb')) { $('simSb').innerHTML = scoreHtml(); } updateBattleUi(); }
}

// ---------- 胜负原因 ----------
const pct = (x) => `${Math.round(x * 100)}%`;
function sideFacts(R, s) {
  const T = R.tally[s];
  const rows = R.rows.filter((r) => r.side === s);
  const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
  const sec = T.unitSec || 1;
  return {
    paper: sum((r) => r.row.unit.dps * r.n),
    app: T.potential ? T.applied / T.potential : null,
    dps: R.t ? sum((r) => r.dealt) / R.t : 0,
    ehp: sum((r) => r.row.unit.ehp * r.n),
    reps: sum((r) => r.repaired), taken: sum((r) => r.taken),
    capped: T.capped / sec, jammed: T.jammed / sec, noRange: T.noRange / sec, lockWait: T.lockWait / sec, outRange: (T.outRange || 0) / sec,
    drained: T.drained,
    lockRange: Math.min(...rows.map((r) => r.row.unit.lockRange))
  };
}
function insightsHtml(R) {
  const F = { A: sideFacts(R, 'A'), B: sideFacts(R, 'B') };
  const isk = iskOf(R);
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  // 指标表：每行较好的一方加粗
  const line = (label, get, fmt, higher = true, hint = '') => {
    const a = get(F.A, 'A'), b = get(F.B, 'B');
    if (a == null && b == null) return '';
    const best = a == null || b == null || Math.abs(a - b) < 1e-9 ? '' : (a > b) === higher ? 'A' : 'B';
    return `<tr${hint ? ` title="${ctx.esc(hint)}"` : ''}><th>${label}</th><td class="${best === 'A' ? 'best' : ''}">${a == null ? '—' : fmt(a)}</td><td class="${best === 'B' ? 'best' : ''}">${b == null ? '—' : fmt(b)}</td></tr>`;
  };
  const anyOf = (k) => F.A[k] > 0.001 || F.B[k] > 0.001;
  const table = `<table class="sim-facts"><thead><tr><th></th><th><span class="sim-badge">A 方</span></th><th><span class="sim-badge sim-side-b">B 方</span></th></tr></thead><tbody>
    ${line('纸面 DPS', (f) => f.paper, num)}
    ${line('命中率', (f) => f.app, pct, true, '实际打到目标身上的伤害 / 锁定后可以打出的纸面伤害（射程、命中、电容不足都会拉低）')}
    ${line('平均有效输出', (f) => f.dps, (v) => num(v) + '/s', true, '扣掉抗性后实际造成的伤害 ÷ 交战时长')}
    ${line('总 EHP', (f) => f.ehp, (v) => ctx.formatISK(v, true))}
    ${anyOf('reps') || F.A.reps || F.B.reps ? line('遥修抵消承伤', (f) => (f.taken ? f.reps / f.taken : 0), pct, true, '遥修修回的 HP / 受到的伤害') : ''}
    ${anyOf('capped') ? line('电容见底时间', (f) => f.capped, pct, false, '电容不够、耗电装备只能部分运转的时间占比（艘·秒）') : ''}
    ${F.A.drained || F.B.drained ? line('中和 / 吸走电容', (f) => f.drained, (v) => ctx.formatISK(v, true) + ' GJ') : ''}
    ${anyOf('jammed') ? line('被 ECM 干扰', (f) => f.jammed, pct, false) : ''}
    ${anyOf('noRange') ? line('锁定距离不够', (f) => f.noRange, pct, false, '交战距离超过锁定距离、锁不上目标的时间占比') : ''}
    ${anyOf('outRange') ? line('射程外', (f) => f.outRange, pct, false, '目标在武器射程外、没法开火的时间占比（还在接近或被风筝）') : ''}
    ${anyOf('lockWait') ? line('锁定等待', (f) => f.lockWait, pct, false, '换目标后等待锁定的时间占比') : ''}
    ${isk ? line('出场价值', (f, s) => isk[s].field, ctx.formatISK, true) + line('损失 ISK', (f, s) => isk[s].lost, ctx.formatISK, false) : ''}
  </tbody></table>`;
  const list = tipsOf(R, F).slice(0, 5).map(([, s, x]) => `<li><span class="sim-badge${s === 'B' ? ' sim-side-b' : ''}">${s} 方</span><span>${ctx.esc(x)}</span></li>`).join('') || '<li>各项差距不大，主要看数量和集火</li>';
  return `<section class="sim-insight"><div class="sim-sec-head"><h4>胜负原因</h4></div>
    <div class="sim-insight-body">${table}<ul class="sim-tips">${list}</ul></div></section>`;
}
// 提示：挑差距明显的几条（[分数, 哪一方, 文字]，分数高的在前）
function tipsOf(R, F = { A: sideFacts(R, 'A'), B: sideFacts(R, 'B') }) {
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  const tips = [];
  for (const s of SIDES) {
    const o = s === 'A' ? 'B' : 'A', f = F[s], g = F[o];
    const tip = (score, text) => tips.push([score, s, text]);
    if (!f.paper && g.paper) tip(10, '没有输出（无武器或装配未读到）');
    if (f.paper && g.paper && f.paper / g.paper >= 1.5) tip(f.paper / g.paper, `纸面 DPS 是 ${o} 方的 ${(f.paper / g.paper).toFixed(1)} 倍`);
    if (f.ehp && g.ehp && f.ehp / g.ehp >= 1.5) tip(f.ehp / g.ehp, `总 EHP 是 ${o} 方的 ${(f.ehp / g.ehp).toFixed(1)} 倍`);
    if (f.app != null && f.app < 0.6) tip(4 - f.app * 4, `只有 ${pct(f.app)} 的输出打中（射程或命中不足）`);
    if (f.taken && f.reps / f.taken > 0.15) tip(1 + f.reps / f.taken * 2, `遥修抵消了 ${pct(f.reps / f.taken)} 的承伤`);
    if (f.capped > 0.1) tip(1 + f.capped * 4, `有 ${pct(f.capped)} 的时间电容见底（${g.drained ? '被中和' : '装备耗电太大'}）`);
    if (f.jammed > 0.05) tip(1 + f.jammed * 4, `有 ${pct(f.jammed)} 的时间被 ECM 干扰，无法锁定和输出`);
    if (f.outRange > 0.15) tip(1.5 + f.outRange * 3, `有 ${pct(f.outRange)} 的时间目标在射程外（还在接近或被风筝）`);
    if (f.noRange > 0.05) tip(2 + f.noRange * 4, `锁定距离只有 ${num(f.lockRange / 1000)} km，有 ${pct(f.noRange)} 的时间够不到目标`);
  }
  return tips.sort((a, b) => b[0] - a[0]);
}

// ---------- 伤害与抗性 ----------
// 每方的伤害构成 vs 对方各层抗性（按 HP 加权平均）：对方主要靠哪一层承伤、那一层哪种伤害最弱
const DMG_COLORS = ['em', 'th', 'ki', 'ex'];
function sideProfile(R, s) {
  const dmg = [0, 0, 0, 0], hp = [0, 0, 0], ehp = [0, 0, 0];
  const res = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const r of R.rows) {
    if (r.side !== s) continue;
    const u = r.row.unit;
    for (let k = 0; k < 4; k++) dmg[k] += u.types[k] * r.n;
    for (let l = 0; l < 3; l++) {
      hp[l] += u.max[l] * r.n;
      ehp[l] += u.max[l] / mean(u.res[l]) * r.n;
      for (let k = 0; k < 4; k++) res[l][k] += u.res[l][k] * u.max[l] * r.n;
    }
  }
  return { dmg, ehp, res: res.map((x, l) => x.map((v) => (hp[l] ? v / hp[l] : 1))) };
}
function matchupHtml(R) {
  const P = { A: sideProfile(R, 'A'), B: sideProfile(R, 'B') };
  // res 里是抗性系数（1 − 抗性），越大越好打
  const weakest = (a) => a.indexOf(Math.max(...a));
  const block = (s) => {
    const o = s === 'A' ? 'B' : 'A', me = P[s], en = P[o];
    const head = `<h5><span class="sim-badge${s === 'B' ? ' sim-side-b' : ''}">${s} 方</span><span>打</span><span class="sim-badge${o === 'B' ? ' sim-side-b' : ''}">${o} 方</span></h5>`;
    const tot = me.dmg.reduce((t, x) => t + x, 0);
    if (!tot) return `<div class="sim-mu-side">${head}<p class="sim-hint">这一方没有输出</p></div>`;
    const share = me.dmg.map((x) => x / tot);
    const ehpTot = en.ehp.reduce((t, x) => t + x, 0) || 1;
    const layer = en.ehp.indexOf(Math.max(...en.ehp));
    const eff = share.reduce((t, x, k) => t + x * en.res[layer][k], 0);
    const best = weakest(en.res[layer]);
    const gain = en.res[layer][best] / (eff || 1) - 1;
    const rows = DAMAGE_NAMES.map((n, k) => `<tr><th><i class="sim-dmg ${DMG_COLORS[k]}"></i>${n}</th>
      <td><div class="sim-mu-bar"><i class="${DMG_COLORS[k]}" style="width:${(share[k] * 100).toFixed(1)}%"></i></div><span>${pct(share[k])}</span></td>
      ${[0, 1, 2].map((l) => `<td class="num${l === layer ? ' main' : ''}${k === weakest(en.res[l]) && en.ehp[l] ? ' hole' : ''}">${en.ehp[l] ? pct(1 - en.res[l][k]) : '—'}</td>`).join('')}</tr>`).join('');
    const tip = gain > 0.08 && share[best] < 0.6
      ? `<p class="sim-mu-tip">${ctx.esc(`换成${DAMAGE_NAMES[best]}伤害（对方${LAYER_NAMES[layer]}抗性仅 ${pct(1 - en.res[layer][best])}），最多 +${pct(gain)}`)}</p>`
      : '<p class="sim-mu-ok">伤害类型已经比较对路</p>';
    return `<div class="sim-mu-side">${head}
      <p class="sim-mu-sum">${ctx.esc(`对方主要靠${LAYER_NAMES[layer]}承伤（占 EHP ${pct(en.ehp[layer] / ehpTot)}），本方有效比例 ${pct(eff)}`)}</p>
      <table class="sim-mu"><thead><tr><th>伤害类型</th><th>本方输出占比</th>${LAYER_NAMES.map((l, i) => `<th class="num${i === layer ? ' main' : ''}">对方${l}抗性</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      ${tip}</div>`;
  };
  return `<section class="sim-matchup"><div class="sim-sec-head"><h4>伤害与抗性</h4><span class="sim-hint">高亮 = 主要承伤层，标红 = 最弱抗性</span></div>
    <div class="sim-mu-cols">${block('A')}${block('B')}</div></section>`;
}

// 引擎选项：单艘价值按全服均价（没读到价格时引擎改用 EHP 算战损）
// 走位官：每方标了火力 / 后勤走位官的行（引擎取这一行第一艘还在场的船）
const anchors = () => Object.fromEntries(SIDES.map((s) => [s, { dps: S.sides[s].find((r) => r.lead === 'dps')?.id, logi: S.sides[s].find((r) => r.lead === 'logi')?.id }]));
const simOpt = (extra = {}) => ({ ...S.opt, anchors: anchors(), value: S.prices ? (row) => fitValue(row.fit) : null, ...extra });

// ---------- 战场（3D 实时）----------
// 设置一改就重新布阵（不开打）；「开战」后按所选速度实时推进，3D 视图读引擎的逐帧记录；打完显示结果，之后可拖动时间轴回放。
// 战斗中：增援（本方舰船或搜索其他船型，落在本方出发点）、点一艘船让对面点名集火（整方一起打，打死后恢复自动选目标）。
// 3D 画质：自动（网页默认：先按高画质画，持续卡顿就自动降到低画质）/ 高 / 低；桌面版默认高画质并自动加载 3D
const DESKTOP = Boolean(window.__EVE_DESKTOP__);
const Q_KEY = 'eve-sim-quality';
const QUALITY = [['auto', '自动'], ['high', '高'], ['low', '低']];
const BT = { b: null, view: null, host: null, t: 0, playing: false, speed: 2, sel: -1, raf: 0, last: 0, hud: 0, reinf: null, edit: null, finishing: false, want3d: DESKTOP, names: true,
  quality: DESKTOP ? 'high' : 'auto', director: false };
const SPEEDS = [1, 2, 5, 10];
let plotX = null;   // 走势图的时间 → 横坐标（回放位置线用）
const shipName = (id) => ctx.data.types.get(id)?.name || '';
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export const debugBattle = () => BT.b;   // 调试用（控制台查看战局、3D 视图）
export const debugView = () => BT.view;
function newBattle() {
  // 预设了进场时间的支援舰队交给引擎按时进场
  const support = SIDES.flatMap((s) => S.support[s].filter((f) => f.at != null).map((f) => ({ side: s, ...fleetSpec(f), at: f.at })));
  endPlace();
  resetRoster();
  BT.b = createBattle(S.sides, simOpt({ record: true, support }));
  Object.assign(BT, { t: 0, playing: false, sel: -1, finishing: false });
  S.result = null;
  renderBattle();
}
function renderBattle() {
  const box = root?.querySelector('#simBattle');
  if (!box) return;
  if (!BT.b) { disposeView(); box.innerHTML = ''; return; }
  if (!box.querySelector('.sim-battle')) {
    disposeView();
    box.innerHTML = `<section class="sim-battle" id="simBtSec">
      <div class="sim-sec-head"><h4>战场</h4><span class="sim-bt-status" id="simBtStatus"></span></div>
      <div class="sim-stage${BT.want3d ? '' : ' is-off'}" id="simStage">
        <div class="sim-sb" id="simSb">${scoreHtml()}</div>
        <div class="sim-3d${BT.want3d ? '' : ' is-off'}" id="sim3d">
          <div class="sim-3d-off"><button type="button" class="btn btn-primary btn-sm" data-bt-3d>加载 3D 画面</button><small>要下载舰船模型，不加载也能开战、看结果</small></div>
          <div class="sim-3d-tools">
            <button type="button" data-bt-dir class="${BT.director ? 'on' : ''}" title="导播镜头：自动环绕战场" aria-label="导播镜头" aria-pressed="${BT.director}">${ICON.dir}</button>
            <button type="button" data-bt-names class="${BT.names ? 'on' : ''}" title="显示名字与血条" aria-label="显示名字与血条" aria-pressed="${BT.names}">${ICON.names}</button>
            <button type="button" data-bt-cam title="重置视角" aria-label="重置视角">${ICON.cam}</button>
            <button type="button" data-bt-full title="全屏" aria-label="全屏">${ICON.full}</button>
          </div>
          <div class="sim-feed" id="simBtFeed"></div>
          <div class="sim-3d-load" id="simBtLoad" hidden><span>加载 3D 画面</span><i><b></b></i><small></small></div>
          <div class="sim-3d-tip" id="simBtTip" hidden></div>
          <div class="sim-3d-place" id="simBtPlace" hidden><span></span><button type="button" class="btn btn-ghost btn-sm" data-bt-place-cancel>取消</button></div>
          <div class="sim-3d-sel" id="simBtSel" hidden></div>
          <p class="sim-3d-fail" hidden>这个浏览器不支持 3D（WebGL），只能直接看结果</p>
        </div>
        <div class="sim-rs sim-rs-a" id="simRsA"></div>
        <div class="sim-rs sim-rs-b" id="simRsB"></div>
      </div>
      <div class="sim-bt-ctl">
        <button type="button" class="btn btn-primary btn-sm" data-bt-play></button>
        <div class="segmented" role="group" aria-label="速度">${SPEEDS.map((v) => `<button type="button" data-bt-speed="${v}" class="${BT.speed === v ? 'active' : ''}">${v}×</button>`).join('')}</div>
        <div class="sim-bt-seek"><input type="range" min="0" max="0" step="0.5" value="0" data-bt-seek aria-label="战斗时间"><span id="simBtTime"></span></div>
        <button type="button" class="btn btn-ghost btn-sm" data-bt-finish title="不看过程，直接算到结束">直接出结果</button>
        <button type="button" class="btn btn-ghost btn-sm" data-bt-restart title="回到开局（手动进场的支援与点名清空）">重新开始</button>
        <label class="sim-bt-q" title="自动：画面卡顿时自动降低画质（低画质不画星云、按 1 倍像素渲染）"><span>画质</span><select class="plain-select" data-bt-quality>${QUALITY.map(([v, l]) => `<option value="${v}"${BT.quality === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${NE.supported() ? `<button type="button" class="btn btn-ghost btn-sm${NE.running() ? ' on' : ''}" data-bt-native title="用 CCP 开源的游戏引擎（trinity）另开一个窗口画同一场战斗，镜头和这里同步（实验功能，第一次使用要下载约 120 MB）">${NE.running() ? '关闭原生引擎' : '原生引擎'}</button>` : ''}
      </div>
      <div class="sim-bt-reinf"><button type="button" class="btn btn-ghost btn-sm" data-bt-reinf="A">A 方舰队支援</button><button type="button" class="btn btn-ghost btn-sm" data-bt-reinf="B">B 方舰队支援</button></div>
      <div class="sim-bt-pop" id="simBtPop" hidden></div>
      <div class="sim-bt-log" id="simBtLog"></div>
      <p class="sim-hint">拖动旋转 · 滚轮或双指缩放 · 右键或双指拖动平移 · 点舰船或两边名单查看并点名集火 · 双击舰船镜头跟随 · 导播镜头自动环绕战场</p>
    </section>`;
    BT.host = box.querySelector('#sim3d');
    if (BT.want3d) mountView(BT.host);
  } else if (BT.view) BT.view.setRecord(BT.b.rec);
  renderPop();
  updateBattleUi();
  startLoop();
}
function mountView(host) {
  BT.host = host;
  host.classList.remove('is-off');
  host.closest('.sim-stage')?.classList.remove('is-off');
  loadBar(0, 0);
  import('./sim-3d.js?v=v95').then((m) => {
    if (BT.host !== host || !host.isConnected) return;
    BT.view = m.createView(host, {
      onPick: (i) => { BT.sel = i; updateBattleUi(); },
      onFollow: (i) => { BT.sel = i; updateBattleUi(); },
      onHover: (i, x, y) => {
        const tip = $('simBtTip');
        if (!tip) return;
        if (i < 0 || !BT.b) { tip.hidden = true; return; }
        const u = BT.b.rec.units[i];
        tip.textContent = pilotOf(i) ? `${u.side} 方 · ${pilotOf(i)} · ${shipName(u.ship)}` : `${u.side} 方 · ${shipName(u.ship)}`;
        tip.style.left = x + 12 + 'px';
        tip.style.top = y + 12 + 'px';
        tip.hidden = false;
      },
      onProgress: loadBar,
      nameOf: unitName,
      onDirector: (on) => { BT.director = on; syncTool('dir', on); },
      onQuality: () => ctx.showToast('3D 画面较卡，已自动降低画质（可在「画质」里改回）', 'info', 4000)
    }, { quality: BT.quality });
    if (!BT.view) { host.querySelector('.sim-3d-fail').hidden = false; loadBar(1, 1); return; }
    BT.view.setRecord(BT.b.rec);
    BT.view.setLabels(BT.names);
    BT.view.setDirector(BT.director);
  }).catch(() => { host.querySelector('.sim-3d-fail').hidden = false; loadBar(1, 1); });
}
// 模型加载进度：total 为 0 时是 3D 引擎本身还在加载
function syncTool(name, on) {
  const b = root?.querySelector(`[data-bt-${name}]`);
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
}
function loadBar(done, total) {
  const el = $('simBtLoad');
  if (!el) return;
  el.hidden = total > 0 && done >= total;
  el.querySelector('b').style.width = (total ? done / total * 100 : 8) + '%';
  el.querySelector('span').textContent = total ? '加载舰船模型' : '加载 3D 画面';
  el.querySelector('small').textContent = total ? `${done} / ${total}` : '';
}
function disposeView() {
  NE.disconnect();
  BT.placing = null;
  BT.view?.dispose();
  BT.view = null;
  BT.host = null;
}
// 原生引擎（桌面版可选组件，native-engine.js）：另开一个 CCP 开源引擎渲染的窗口，船位、镜头每帧从这里的 3D 画面同步过去。
// 没下载过：第一次点按钮先问（再点一次确认），下载时按钮上显示进度；开着时按钮显示组好几艘船 / 模型转换进度，再点关闭
async function toggleNative(btn) {
  // 面板可能重画，按钮换了新的元素：每次都找当前那个
  const cur = () => (btn.isConnected ? btn : document.querySelector('[data-bt-native]') || btn);
  const label = (txt) => { btn = cur(); btn.textContent = txt; };
  if (NE.running()) { NE.disconnect(); return; }
  if (BT.nativeBusy) return;
  if (!BT.view) { ctx.showToast('先打开 3D 画面，再开原生引擎', 'info', 4000); return; }
  BT.nativeBusy = true;
  try {
    const st = await NE.status();
    const progress = (d) => {
      if (d.stage === 'download' && d.total) label(`下载 ${Math.floor((d.done / d.total) * 100)}%`);
      else if (d.stage === 'verify') label('校验中');
      else if (d.stage === 'extract') label('解压中');
    };
    if (!st.installed) {
      if (!BT.nativeArmed) {
        BT.nativeArmed = true;
        label('下载约 120 MB？再点一次');
        setTimeout(() => { if (BT.nativeArmed) { BT.nativeArmed = false; if (!NE.running()) label('原生引擎'); } }, 6000);
        return;
      }
      BT.nativeArmed = false;
      label('准备下载');
      await NE.install(progress);
    } else {
      // 装过：先看有没有新版本（已是最新时只读一下版本清单就返回），有就带进度更新；查不到（离线等）就用已装的
      label('检查组件版本');
      try { await NE.install(progress); } catch { /* 用已装的版本 */ }
    }
    label('启动中…');
    await NE.connect(BT.view, {
      onStatus: (m) => { if (NE.running()) label(m.busy ? `转换模型 ${m.busy.replace(/^\D+/, '')}` : `关闭原生引擎（${m.built}/${m.ships}）`); },
      onExit: (m) => {
        cur().classList.remove('on');
        label('原生引擎');
        if (m) { const [t, k, d] = NE.exitNotice(m); ctx.showToast(t, k, k === 'error' ? 10000 : 4000, d); }
      },
      onWarn: (t) => ctx.showToast(t, 'info', 6000),
    });
    cur().classList.add('on');
    label('关闭原生引擎');
  } catch (e) {
    const [t, k, d] = NE.errorNotice(e);
    ctx.showToast(t, k, 10000, d);
    cur().classList.remove('on');
    label('原生引擎');
  } finally {
    BT.nativeBusy = false;
  }
}
function startLoop() {
  if (BT.raf) return;
  BT.last = performance.now();
  BT.raf = requestAnimationFrame(tick);
}
function tick(now) {
  BT.raf = 0;
  const b = BT.b;
  if (!b || !BT.host?.isConnected) return;
  const dt = Math.min(0.1, (now - BT.last) / 1000);
  BT.last = now;
  if (root.offsetParent && !document.hidden) {
    if (BT.playing) {
      const goal = BT.t + dt * BT.speed;
      for (let n = 0; b.t < goal && !b.done && n < 80; n++) b.step();
      BT.t = Math.min(goal, b.t);
      if (b.done && BT.t >= b.t) BT.playing = false;
      if (b.done && !S.result) finish();
    }
    if (BT.view) { BT.view.draw(BT.t, { sel: BT.sel, kills: b.kills }); BT.view.render(); }
    if (now - BT.hud > 150) { BT.hud = now; updateBattleUi(); }
  }
  BT.raf = requestAnimationFrame(tick);
}
function finish() {
  S.result = BT.b.result();
  S.result.skipped = SIDES.flatMap((s) => S.sides[s]).filter((r) => !r.unit && (r.status === 'loading' || r.status === 'idle')).reduce((t, r) => t + r.count, 0);
  renderResult();
}
// 不看过程直接打完（分段计算，不卡页面）
async function finishNow() {
  const b = BT.b;
  if (!b || BT.finishing) return;
  BT.finishing = true;
  BT.playing = false;
  updateBattleUi();
  while (!b.done) {
    const t0 = performance.now();
    while (!b.done && performance.now() - t0 < 30) b.step();
    await idle();
    if (BT.b !== b) return;
  }
  BT.finishing = false;
  BT.t = b.t;
  if (!S.result) finish();
  updateBattleUi();
}
function seek(t) {
  if (!BT.b) return;
  BT.playing = false;
  BT.t = Math.max(0, Math.min(BT.b.t, t));
  updateBattleUi();
}
function togglePlay() {
  const b = BT.b;
  if (!b || BT.finishing) return;
  if (BT.playing) BT.playing = false;
  else {
    if (b.done && BT.t >= b.t) BT.t = 0;   // 打完了：从头回放
    BT.playing = true;
    BT.last = performance.now();
  }
  updateBattleUi();
}
// 当前帧（BT.t）每方存活 / 总数
function aliveAt(t) {
  const rec = BT.b.rec, f = rec.frames[Math.max(0, Math.min(rec.frames.length - 1, Math.floor(t / rec.dt)))];
  const n = { A: 0, B: 0 }, all = { A: 0, B: 0 };
  for (let i = 0; i < f.hp.length / 3; i++) { const s = rec.units[i].side; all[s]++; if (f.hp[i * 3 + 2]) n[s]++; }
  return { n, all, f };
}
// 一艘船的装备（像游戏里一样的圆形图标）：运转中外圈按周期转一圈，装填中黄圈，被动装备不显示，不计开启的划掉
const FE_ACTIVE = new Set(['active', 'overload']);
function modsHtml(u) {
  return u.rack.map((m, k) => (FE_ACTIVE.has(m.state) || m.off ? `<i class="sim-pn-mod${m.off ? ' off' : ''}" data-k="${k}" title="${ctx.esc(shipName(m.type))}${m.off ? ' · ' + ctx.esc(m.off) : ''}"><img src="${IMG(m.type)}" alt="" width="32" height="32" loading="lazy"></i>` : '')).join('');
}
// 外圈进度：运转中 = 这个周期走了多少（往回找最近一次开始新周期的帧），装填中 = 装填走了多少；big 时在图标上写装填剩余秒数
function modProgress(i, k, cycle, reload, reloading) {
  const F = BT.b.rec.frames, dt = BT.b.rec.dt, bit = 1 << k;
  const fi = Math.max(0, Math.min(F.length - 1, Math.floor(BT.t / dt)));
  if (reloading) {
    let j = fi;
    while (j > 0 && F[j - 1].rld?.[i] & bit) j--;
    const start = F[j].t - dt, total = reload || 10;
    return { p: Math.min(1, (BT.t - start) / total), left: Math.max(0, total - (BT.t - start)) };
  }
  if (!cycle) return { p: 1 };
  for (let j = fi, n = Math.ceil(cycle / dt) + 1; j >= 0 && n > 0; j--, n--) {
    if (F[j].fire?.[i] & bit) return { p: Math.max(0, Math.min(1, (BT.t - (F[j].t - dt)) / cycle)) };
  }
  return { p: 1 };
}
function paintMods(box, f, i, big = false) {
  const act = f.act?.[i] || 0, rld = f.rld?.[i] || 0;
  const rack = BT.b.rec.units[i].rack;
  box.querySelectorAll('.sim-pn-mod').forEach((x) => {
    const k = Number(x.dataset.k);
    const on = k < 32 && Boolean(act & (1 << k)), re = k < 32 && Boolean(rld & (1 << k));
    x.classList.toggle('on', on && !re);
    x.classList.toggle('rld', re);
    if (on || re) {
      const m = rack[k], g = modProgress(i, k, m.cycle, m.reload, re);
      x.style.setProperty('--p', (g.p * 100).toFixed(1) + '%');
      if (big) x.dataset.s = re ? Math.ceil(g.left) : '';
    } else if (big) x.dataset.s = '';
  });
}
// 目标与锁定：锁定中显示进度
function targetText(f, i) {
  const tg = f.tg[i] >= 0 ? BT.b.rec.units[f.tg[i]] : null;
  if (!tg) return { text: '没有目标', lock: -1 };
  const lk = f.lk?.[i] || 255;
  return { text: lk < 255 ? `锁定中 ${Math.round(lk / 2)}% · ${unitName(f.tg[i])}` : `目标：${unitName(f.tg[i])}`, lock: lk < 255 ? lk / 200 : -1 };
}
function paintTarget(el, f, i) {
  const x = el.querySelector('.sim-pn-tg');
  if (!x) return;
  const g = targetText(f, i);
  x.firstChild.textContent = g.text;
  x.classList.toggle('locking', g.lock >= 0);
  x.querySelector('b').style.width = g.lock >= 0 ? (g.lock * 100).toFixed(0) + '%' : '0';
}
const tgHtml = () => '<div class="sim-pn-tg"><span></span><i><b></b></i></div>';
// 血条：依次为护盾、装甲、结构、电容，每条前面标明
const HP_BARS = [['sh', '盾'], ['ar', '甲'], ['hu', '构'], ['cp', '容']];
const hpBarsHtml = () => `<div class="sim-hp">${HP_BARS.map(([c, l]) => `<span>${l}</span><i class="${c}"><b></b></i>`).join('')}</div>`;
function paintBars(el, f, i) {
  const bars = el.querySelectorAll('.sim-hp b');
  if (!bars.length) return;
  for (let k = 0; k < 3; k++) bars[k].style.width = (f.hp[i * 3 + k] / 2).toFixed(0) + '%';
  bars[3].style.width = ((f.cp?.[i] || 0) / 2).toFixed(0) + '%';
}
const speedText = (f, i) => `${ctx.formatNumber(f.spd?.[i] || 0)} m/s`;
// 到当前时刻的战损：每方损失艘数、ISK（没读到价格时按 EHP）
function liveLoss() {
  const isk = Boolean(S.prices);
  const out = { A: { n: 0, v: 0 }, B: { n: 0, v: 0 }, isk };
  for (const k of BT.b.kills) {
    if (k.at > BT.t) continue;
    out[k.side].n += 1;
    out[k.side].v += isk ? fitValue(k.row.row.fit) : k.row.row.unit?.ehp || 0;
  }
  return out;
}
// ---------- 直播式比分条与双方名单（像 AT 比赛直播）----------
// 比分条：两队（AT 赛显示队标、队名），中间是时间；按胜负方式显示存活与击毁价值、战损效率，或 AT 得分（见 paintScore）。
// 名单在 3D 画面两边（窄屏 / 没加载 3D 时在下方）：每艘船一行（同型船也各自一行，多了就滚动，不显示滚动条）：
// 选手名或船名（同型多艘时带编号）+ 当前速度与电容 + 护盾 / 装甲 / 结构三条血条，阵亡变灰划掉。点一行选中那艘船。
// 每行缓存节点和上次写入的值，值没变不碰 DOM；击杀播报（谁击毁了谁）浮在画面上方。
// 名字下面一排小图标：这艘船此刻正受到的电子战（红底，装备图标）和遥修（绿底），和 AT 直播一样。
const RS = { n: -1, rows: [], head: {} };
const EW_ORDER = ['scram', 'point', 'web', 'neut', 'nos', 'ecm', 'damp', 'paint', 'rs', 'ra', 'rh'];
const EW_NAME = { scram: '跃迁扰频', point: '跃迁扰断', web: '停滞网', neut: '能量中和', nos: '能量吸取', ecm: 'ECM 干扰', damp: '感应抑阻', paint: '目标标记', rs: '护盾遥修', ra: '装甲遥修', rh: '结构遥修' };
// 这一帧每艘船受到的电子战 / 遥修：目标序号 → Map(类别 → 装备类型)
function incoming(rec, f) {
  const out = new Map();
  const put = (j, kind, type) => { if (j == null || j < 0) return; const m = out.get(j) || out.set(j, new Map()).get(j); if (!m.has(kind)) m.set(kind, type); };
  if (!f.act) return out;
  rec.units.forEach((u, i) => {
    if (!u.ew?.length || !f.act[i] || i * 3 >= f.hp.length || f.hp[i * 3 + 2] <= 0) return;
    for (const [m, kind] of u.ew) if (kind[0] !== 'r' && f.act[i] & (1 << m)) put(f.tg[i], kind, u.rack[m]?.type);
  });
  const rr = f.rr || [];
  for (let x = 0; x < rr.length; x += 3) { const u = rec.units[rr[x]]; const kind = u.ew?.find((y) => y[0] === rr[x + 2])?.[1]; if (kind) put(rr[x + 1], kind, u.rack[rr[x + 2]]?.type); }
  return out;
}
let rowMap = null;   // 行 id → 舰船行（引擎记录里每艘船只有行 id）
function rowById(id) {
  if (!rowMap?.has(id)) {
    rowMap = new Map();
    for (const s of SIDES) for (const r of [...S.sides[s], ...fleetRows(s)]) rowMap.set(r.id, r);
    if (!rowMap.has(id)) rowMap.set(id, null);
  }
  return rowMap.get(id);
}
const pilotOf = (i) => { const u = BT.b?.rec.units[i]; return (u && rowById(u.row)?.pilot) || ''; };
const unitName = (i) => pilotOf(i) || shipName(BT.b?.rec.units[i]?.ship);
// 选手名不翻译，船名照常翻译
const nameHtml = (i, cls = '') => { const p = pilotOf(i); return `<b${cls ? ` class="${cls}"` : ''}${p ? ' translate="no"' : ''}>${ctx.esc(p || shipName(BT.b.rec.units[i].ship))}</b>`; };
const teamName = (s) => S.teams?.[s]?.name || '';
function resetRoster() { RS.n = -1; RS.rows = []; rowMap = null; }
function scoreHtml() {
  const team = (s) => {
    const t = S.teams?.[s];
    return `<div class="sim-sb-team ${s.toLowerCase()}">
      ${t?.id ? `<img src="https://images.evetech.net/alliances/${t.id}/logo?size=64" alt="" width="34" height="34">` : `<span class="sim-badge${s === 'B' ? ' sim-side-b' : ''}">${s} 方</span>`}
      <div class="sim-sb-name">${t ? `<b translate="no" title="${ctx.esc(t.name)}">${ctx.esc(t.name)}</b>` : ''}<small class="v"></small></div>
      <strong id="simBt${s}"></strong></div>`;
  };
  return `${team('A')}<div class="sim-sb-mid"><b class="sim-sb-clock" id="simBtClock"></b><div class="sim-sb-bar"><i class="a"></i><i class="b"></i></div><small class="sim-sb-pct"><span class="pa"></span><span class="m"></span><span class="pb"></span></small></div>${team('B')}`;
}
function buildRoster() {
  const rec = BT.b.rec;
  RS.n = rec.units.length;
  RS.rows = [];
  for (const s of SIDES) {
    const box = $('simRs' + s);
    if (!box) continue;
    const ids = [];
    rec.units.forEach((u, i) => { if (u.side === s) ids.push(i); });
    const groups = ids.map((i) => [i]);
    // 没有选手名的同型船按出场顺序编号
    const same = new Map(), no = new Map();
    for (const i of ids) if (!pilotOf(i)) same.set(rec.units[i].ship, (same.get(rec.units[i].ship) || 0) + 1);
    const label = (i) => {
      const p = pilotOf(i), ship = rec.units[i].ship;
      if (p || (same.get(ship) || 0) < 2) return nameHtml(i);
      no.set(ship, (no.get(ship) || 0) + 1);
      return `<b>${ctx.esc(shipName(ship))} ${no.get(ship)}</b>`;
    };
    box.innerHTML = `<header><span class="sim-badge${s === 'B' ? ' sim-side-b' : ''}">${s} 方</span>${teamName(s) ? `<b translate="no">${ctx.esc(teamName(s))}</b>` : ''}<small class="n"></small></header>
      <div class="sim-rs-list">${groups.map((g) => {
        const i = g[0], u = rec.units[i], row = rowById(u.row);
        const sub = `<small>${pilotOf(i) ? `${ctx.esc(shipName(u.ship))} · ` : ''}<span class="sp" title="速度"></span> m/s</small>`;
        return `<div class="sim-rs-row" data-bt-unit="${i}"><img src="${IMG(u.ship)}" alt="" width="28" height="28" loading="lazy">
          <div class="sim-rs-main"><span>${label(i)}${row?.flag ? '<em title="AT 旗舰">★</em>' : ''}</span>${sub}<span class="sim-rs-ew"></span></div>
          <div class="sim-rs-hp"><i class="sh"><b></b></i><i class="ar"><b></b></i><i class="hu"><b></b></i><i class="cp"><b></b></i></div></div>`;
      }).join('')}</div>`;
    box.querySelectorAll('.sim-rs-row').forEach((el, k) => RS.rows.push({ el, units: groups[k], bars: [...el.querySelectorAll('.sim-rs-hp b')], sp: el.querySelector('.sp'), ew: el.querySelector('.sim-rs-ew'), last: {} }));
    RS.head[s] = box.querySelector('header .n');
  }
}
const setText = (c, key, node, v) => { if (c.last[key] !== v) { c.last[key] = v; node.textContent = v; } };
const setWidth = (c, key, node, v) => { if (c.last[key] !== v) { c.last[key] = v; node.style.width = v; } };
const setClass = (c, key, on) => { if (c.last[key] !== on) { c.last[key] = on; c.el.classList.toggle(key, on); } };
function paintRoster(f) {
  const rec = BT.b.rec, nU = f.hp.length / 3;
  if (!$('simRsA')) return;
  if (RS.n !== rec.units.length || (RS.rows[0] && !RS.rows[0].el.isConnected)) buildRoster();
  const cnt = { A: [0, 0], B: [0, 0] };
  const ewIn = incoming(rec, f);
  for (const r of RS.rows) {
    let alive = 0, total = 0, first = -1;
    const hp = [0, 0, 0];
    for (const i of r.units) {
      if (i >= nU) continue;   // 这个时刻还没进场
      total++;
      const gone = rec.units[i].escaped != null && BT.t >= rec.units[i].escaped;
      if (f.hp[i * 3 + 2] > 0 && !gone) { alive++; for (let k = 0; k < 3; k++) hp[k] += f.hp[i * 3 + k]; if (first < 0) first = i; }
    }
    const side = rec.units[r.units[0]].side;
    cnt[side][0] += alive;
    cnt[side][1] += total;
    for (let k = 0; k < 3; k++) setWidth(r, 'h' + k, r.bars[k], (alive ? hp[k] / alive / 2 : 0).toFixed(0) + '%');
    const u0 = r.units[0], on = alive > 0 && u0 < nU;
    setText(r, 'sp', r.sp, on ? String(f.spd[u0]) : '—');
    setWidth(r, 'h3', r.bars[3], on ? (f.cp[u0] / 2).toFixed(0) + '%' : '0%');
    setClass(r, 'dead', total > 0 && !alive);
    setClass(r, 'wait', !total);
    setClass(r, 'sel', r.units.includes(BT.sel));
    setClass(r, 'called', r.units.includes(f.pa) || r.units.includes(f.pb));
    const got = new Map();
    for (const i of r.units) for (const [k, type] of ewIn.get(i) || []) if (!got.has(k)) got.set(k, type);
    const key = EW_ORDER.filter((k) => got.has(k)).join();
    if (r.last.ew !== key) {
      r.last.ew = key;
      r.ew.innerHTML = EW_ORDER.filter((k) => got.has(k)).map((k) => `<i class="${k[0] === 'r' ? 'rep' : ''}" title="${EW_NAME[k]}${got.get(k) ? ' · ' + ctx.esc(shipName(got.get(k))) : ''}"><img src="${IMG(got.get(k) || 0)}" alt="${EW_NAME[k]}" width="16" height="16"></i>`).join('');
    }
    const pick = String(first >= 0 ? first : r.units[0]);
    if (r.el.dataset.btUnit !== pick) r.el.dataset.btUnit = pick;
  }
  for (const s of SIDES) if (RS.head[s]) RS.head[s].textContent = `${cnt[s][0]} / ${cnt[s][1]}`;
}
function paintScore() {
  const box = $('simSb');
  if (!box) return;
  const { n, all } = aliveAt(BT.t);
  const q = (sel) => box.querySelector(sel);
  // 比分条：看战损时大数字是存活 / 总数、队名下是损失艘数，中间是「A 方损失 : B 方损失」（价值，比例条同比例）；AT 得分时大数字是得分、队名下是击毁艘数与存活
  let share = null, pa = '—', pb = '—';
  if (S.opt.score === 'at' && atReady()) {
    const units = BT.b.rec.units, lost = { A: new Map(), B: new Map() };
    for (const k of BT.b.kills) if (k.at <= BT.t) lost[k.side].set(k.ship, (lost[k.side].get(k.ship) || 0) + 1);
    const sc = atScore({ A: tally(units.filter((u) => u.side === 'A').map((u) => [u.ship, 1])), B: tally(units.filter((u) => u.side === 'B').map((u) => [u.ship, 1])) }, lost);
    for (const s of SIDES) {
      const o = s === 'A' ? 'B' : 'A', kills = [...lost[o].values()].reduce((x, y) => x + y, 0);
      $('simBt' + s).textContent = sc[s];
      q(`.sim-sb-team.${s.toLowerCase()} .v`).textContent = `击毁 ${kills} 艘 · 存活 ${n[s]} / ${all[s]}`;
    }
    if (sc.A + sc.B) { share = sc.A / (sc.A + sc.B); pa = `${sc.A} 分`; pb = `${sc.B} 分`; }
    q('.sim-sb-pct .m').textContent = 'AT 得分';
    q('.sim-sb-pct').title = '';
  } else {
    const loss = liveLoss();
    for (const s of SIDES) {
      const o = s === 'A' ? 'B' : 'A';
      $('simBt' + s).textContent = `${n[s]} / ${all[s]}`;
      q(`.sim-sb-team.${s.toLowerCase()} .v`).textContent = loss[s].n ? `损失 ${loss[s].n} 艘` : '';
    }
    const total = loss.A.v + loss.B.v;
    if (total) {
      share = loss.A.v / total;
      const unit = loss.isk ? ' ISK' : ' EHP';
      pa = ctx.formatISK(loss.A.v, !loss.isk) + unit;   // EHP 不是价格，总是缩写
      pb = ctx.formatISK(loss.B.v, !loss.isk) + unit;
    }
    q('.sim-sb-pct .m').textContent = total ? ':' : '损失';
    q('.sim-sb-pct').title = 'A 方损失 : B 方损失';
  }
  q('.sim-sb-pct .pa').textContent = pa;
  q('.sim-sb-pct .pb').textContent = pb;
  q('.sim-sb-bar .a').style.flexGrow = share == null ? 1 : share;
  q('.sim-sb-bar .b').style.flexGrow = share == null ? 1 : 1 - share;
  q('.sim-sb-bar').classList.toggle('none', share == null);
}
// 击杀播报：最近 15 秒内的最多 5 条，「击毁者 → 被击毁」，颜色是击毁方
function paintFeed() {
  const box = $('simBtFeed');
  if (!box) return;
  const ks = BT.b.kills.filter((k) => k.at <= BT.t && BT.t - k.at < 15).slice(-5);
  const key = ks.map((k) => k.unit).join(',');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const units = BT.b.rec.units;
  box.innerHTML = ks.map((k) => {
    const by = k.by >= 0 ? units[k.by] : null;
    return `<div class="sim-feed-k ${(by?.side || (k.side === 'A' ? 'B' : 'A')).toLowerCase()}">${by ? `${nameHtml(k.by)}<img src="${IMG(by.ship)}" alt="" width="20" height="20">` : ''}<i>${ICON.kill}</i><img src="${IMG(k.ship)}" alt="" width="20" height="20">${nameHtml(k.unit, 'v')}</div>`;
  }).join('');
}
function updateBattleUi() {
  const b = BT.b;
  const box = root?.querySelector('.sim-battle');
  if (!b || !box) return;
  const { f } = aliveAt(BT.t);
  $('simBtClock').textContent = clock(BT.t);
  const live = !b.done && BT.t >= b.t - 0.6;   // 引擎每步 0.5 秒，播放位置落后不到一步算实时
  $('simBtStatus').textContent = BT.finishing ? '计算中…' : b.done ? (BT.t < b.t ? '回放中' : '战斗结束') : !b.t ? '已布阵，点「开战」' : BT.playing ? (live ? '交战中' : '回放中') : '已暂停';
  $('simBtStatus').className = 'sim-bt-status' + (BT.playing && live ? ' live' : '');
  const play = box.querySelector('[data-bt-play]');
  play.textContent = BT.playing ? '暂停' : !b.t ? '开战' : b.done && BT.t >= b.t ? '重播' : '继续';
  play.disabled = BT.finishing;
  box.querySelector('[data-bt-finish]').hidden = b.done;
  box.querySelectorAll('[data-bt-fl-go], [data-bt-fl-place]').forEach((x) => { x.disabled = b.done || BT.finishing || !x.dataset.ok; });
  const seekEl = box.querySelector('[data-bt-seek]');
  seekEl.max = b.t;
  if (document.activeElement !== seekEl) seekEl.value = BT.t;
  seekEl.style.setProperty('--p', b.t ? Math.min(1, BT.t / b.t) : 0);
  $('simBtTime').textContent = `${clock(BT.t)} / ${clock(b.t)}`;
  // 选中的船
  const sel = $('simBtSel');
  const i = BT.sel;
  if (BT.view && i >= 0 && i * 3 < f.hp.length) {
    const u = b.rec.units[i];
    const atk = u.side === 'A' ? 'B' : 'A';
    const alive = f.hp[i * 3 + 2] > 0;
    const isPrimary = b.primary[atk]?.i === i;
    const canCall = alive && (live || (!b.done && !BT.playing));
    // 内容没变时只更新血条（整块重画会让正在点的按钮失效）
    const fol = BT.view?.following?.() === i;
    const gone = b.rec.units[i].escaped != null && BT.t >= b.rec.units[i].escaped;
    const key = [i, alive, isPrimary, canCall, fol, gone].join('|');
    if (sel.dataset.key !== key) {
      sel.dataset.key = key;
      sel.innerHTML = `<div class="sim-3d-sel-head"><span class="sim-badge${u.side === 'B' ? ' sim-side-b' : ''}">${u.side} 方</span><img src="${IMG(u.ship)}" alt="" width="22" height="22">${nameHtml(i)}${pilotOf(i) ? `<small>${ctx.esc(shipName(u.ship))}</small>` : ''}<button type="button" class="sim-3d-x" data-bt-unsel aria-label="关闭">${ICON.x}</button></div>
        ${alive ? `${hpBarsHtml()}
        <small class="sim-3d-tg"><span class="sim-pn-v"></span></small>${tgHtml()}
        ${u.rack.length ? `<div class="sim-pn-mods">${modsHtml(u)}</div>` : ''}
        ${canCall ? `<button type="button" class="btn btn-sm ${isPrimary ? 'btn-ghost' : 'btn-primary'}" data-bt-primary="${atk}:${isPrimary ? -1 : i}">${isPrimary ? `取消 ${atk} 方点名` : `${atk} 方集火这艘`}</button>` : ''}` : `<small>${gone ? '已跃迁撤离' : '已被击毁'}</small>`}
        ${gone ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-bt-follow="${fol ? -1 : i}">${fol ? '取消跟随' : '镜头跟随'}</button>`}`;
    }
    const v = sel.querySelector('.sim-pn-v');
    if (v) v.textContent = speedText(f, i);
    paintTarget(sel, f, i);
    paintBars(sel, f, i);
    paintMods(sel, f, i, true);
    sel.hidden = false;
  } else sel.hidden = true;
  paintRoster(f);
  paintScore();
  paintFeed();
  // 事件
  const badge = (s) => `<span class="sim-badge${s === 'B' ? ' sim-side-b' : ''}">${s} 方</span>`;
  const ev = [
    ...b.kills.filter((k) => k.at <= BT.t).slice(-6).map((k) => [k.at, `<span class="sim-kill sim-kill-${k.side.toLowerCase()}"><small>${clock(k.at)}</small><img src="${IMG(k.ship)}" alt="" width="18" height="18" loading="lazy">${ctx.esc(shipName(k.ship))}<span>阵亡</span></span>`]),
    ...b.events.filter((e) => e.t <= BT.t).slice(-5).map((e) => [e.t, e.kind === 'reinforce'
      ? `<span class="sim-bt-ev"><small>${clock(e.t)}</small>${badge(e.side)}<span>${e.cynoShip ? '诱导船跃迁进场' : e.mode === 'cyno' ? '诱导进场' : '跃迁进场'}</span>${e.name ? `<b>${ctx.esc(e.name)}</b>` : ''}<span>${e.n} 艘</span></span>`
      : e.kind === 'cyno' ? `<span class="sim-bt-ev"><small>${clock(e.t)}</small>${badge(e.side)}${ctx.esc(shipName(e.ship))}<span>开启诱导</span></span>`
      : e.kind === 'cyno-fail' ? `<span class="sim-bt-ev"><small>${clock(e.t)}</small>${badge(e.side)}${e.name ? `<b>${ctx.esc(e.name)}</b>` : ''}<span>诱导船被击毁，舰队进不来</span></span>`
      : e.kind === 'escape' ? `<span class="sim-bt-ev"><small>${clock(e.t)}</small>${badge(e.side)}${ctx.esc(shipName(e.ship))}<span>跃迁撤离</span></span>`
      : `<span class="sim-bt-ev"><small>${clock(e.t)}</small>${badge(e.side)}${e.unit >= 0 ? `<span>点名</span>${ctx.esc(shipName(b.rec.units[e.unit].ship))}` : '<span>取消点名</span>'}</span>`])
  ].sort((x, y) => y[0] - x[0]).slice(0, 6);
  const log = $('simBtLog');
  const html = ev.map((x) => x[1]).join('');
  if (log.innerHTML !== html) log.innerHTML = html;
  // 走势图上的回放位置
  const ln = root.querySelector('#simPlot .sim-rp-ln');
  if (ln && plotX) { const x = plotX(BT.t); ln.setAttribute('x1', x); ln.setAttribute('x2', x); }
}

// ---------- 舰队支援 ----------
// 每方可以预设几支支援舰队：舰船（复制本方舰船的装配，或搜索船型读最近常见装配）、进场方式、位置（参照 + 方向 + 距离）、
// 时机（手动，或开战后第 N 秒自动进场）。跃迁进场从远处减速落地（落地前不能被锁定），诱导进场在诱导点直接出现。
const ENTRY = [['warp', '跃迁进场'], ['cyno', '诱导进场']];
const ENTRY_TIP = { warp: '从远处减速落地，落地前不能被锁定', cyno: '在诱导点直接出现，散布约 5 km' };
const REFS = [['own', '本方舰队'], ['enemy', '敌方舰队'], ['center', '战场中心']];
const DIRS = [['back', '后方'], ['front', '前方'], ['left', '左侧'], ['right', '右侧'], ['up', '上方'], ['down', '下方']];
const nameOf = (list, v) => (list.find(([k]) => k === v) || list[0])[1];
let fleetSeq = 0;
const newFleet = (side) => ({ id: ++fleetSeq, name: `支援舰队 ${S.support[side].length + 1}`, rows: [], mode: 'warp', ref: 'own', dist: 10, dir: 'back', at: null });
const fleetSpec = (f) => ({ name: f.name, rows: f.rows.filter((r) => r.unit).map((r) => ({ row: r, count: r.count, cyno: f.mode === 'cyno' && Boolean(r.cyno) })), mode: f.mode, ref: f.ref, dist: f.dist, dir: f.dir });
const cynoRows = (f) => (f.mode === 'cyno' ? f.rows.filter((r) => r.cyno) : []);
// 诱导船：先跃迁到位开诱导，舰队随后跳来；诱导船先被打掉，其余舰船进不来
const CYNO_TIP = '诱导船先跃迁到位开启诱导（原地不动），10 秒后其余舰船跳到它身边；诱导船在这之前被击毁，其余舰船进不来';
const fleetOf = (side, id) => S.support[side].find((f) => f.id === id);
function fleetCard(side, f) {
  const ok = f.rows.some((r) => r.unit);
  const n = f.rows.reduce((t, r) => t + r.count, 0);
  return `<div class="sim-fl">
    <div class="sim-fl-head"><b>${ctx.esc(f.name)}</b><small>${n} 艘</small></div>
    <div class="sim-fl-meta"><span>${nameOf(ENTRY, f.mode)}</span><span>${nameOf(REFS, f.ref)}</span>${f.dist ? `<span>${nameOf(DIRS, f.dir)}</span><span>${f.dist} km</span>` : ''}<span>${f.at == null ? '手动进场' : `开战第 ${f.at} 秒自动进场`}</span>${cynoRows(f).length ? `<span>诱导船：${cynoRows(f).map((r) => ctx.esc(shipName(r.ship))).join('、')}</span>` : ''}</div>
    <div class="sim-fl-ships">${f.rows.map((r) => `<span${f.mode === 'cyno' && r.cyno ? ' class="is-cyno"' : ''}><img src="${IMG(r.ship)}" alt="" width="20" height="20" loading="lazy">${ctx.esc(shipName(r.ship))} ×${r.count}</span>`).join('') || '<small>还没有舰船</small>'}</div>
    <div class="sim-fl-acts"><button type="button" class="btn btn-primary btn-sm" data-bt-fl-go="${side}:${f.id}"${ok ? ' data-ok="1"' : ''}>进场</button>${BT.view ? `<button type="button" class="btn btn-ghost btn-sm" data-bt-fl-place="${side}:${f.id}"${ok ? ' data-ok="1"' : ''} title="在 3D 战场上点一个位置，舰队落在那里">选位置进场</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-fl-edit="${f.id}">编辑</button><button type="button" class="link-btn danger" data-fl-del="${side}:${f.id}">删除</button></div>
  </div>`;
}
function fleetEditor(side, f) {
  const opts = (list, v) => list.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('');
  const mine = S.sides[side].filter((r) => r.unit);
  return `<div class="sim-fl-ed" data-fl="${side}:${f.id}">
    <label class="sim-fl-field"><span>名称</span><input class="pi-input" data-fl-name value="${ctx.esc(f.name)}" maxlength="30"></label>
    <div class="sim-bt-pop-list">${f.rows.map((r) => `<div class="sim-bt-pop-row"><img src="${IMG(r.ship)}" alt="" width="24" height="24" loading="lazy"><span>${ctx.esc(shipName(r.ship))}${r.status === 'loading' ? '<small>读取装配…</small>' : r.label ? `<small>${ctx.esc(r.label)}</small>` : ''}</span>
      ${f.mode === 'cyno' ? `<button type="button" class="sim-fl-cyno${r.cyno ? ' active' : ''}" data-fl-cyno="${r.id}" aria-pressed="${Boolean(r.cyno)}" title="${CYNO_TIP}">${r.cyno ? '诱导船' : '设为诱导船'}</button>` : ''}
      <input type="number" class="pi-input" min="1" max="500" value="${r.count}" data-fl-n="${r.id}" aria-label="数量"><button type="button" class="sim-3d-x" data-fl-rm="${r.id}" aria-label="移除">${ICON.x}</button></div>`).join('') || '<p class="sim-empty">从下面添加舰船</p>'}</div>
    ${mine.length ? `<div class="sim-fl-from"><small>复制本方舰船</small>${mine.map((r) => `<button type="button" class="sim-fl-chip" data-fl-copy="${r.id}"><img src="${IMG(r.ship)}" alt="" width="18" height="18" loading="lazy">${ctx.esc(shipName(r.ship))}</button>`).join('')}</div>` : ''}
    <div class="sim-search sim-bt-search"><input type="search" class="pi-input" placeholder="搜索其他船型" data-bt-search="${side}" autocomplete="off"><div class="kb-suggest" data-bt-suggest hidden></div></div>
    <textarea class="pi-input sim-fl-scan" rows="1" data-fl-scan placeholder="${ctx.esc(trTa('粘贴定向扫描结果（扫描窗口里全选复制），按船型导入'))}" spellcheck="false"></textarea>
    <div class="sim-fl-field"><span>进场方式</span><div class="segmented" role="group">${ENTRY.map(([k, l]) => `<button type="button" data-fl-mode="${k}" class="${f.mode === k ? 'active' : ''}" title="${ENTRY_TIP[k]}">${l}</button>`).join('')}</div><small>${f.mode === 'cyno' ? (cynoRows(f).length ? CYNO_TIP : '没设诱导船时，舰队直接在诱导点出现；可在上面把一行船设为诱导船') : ENTRY_TIP[f.mode]}</small></div>
    <div class="sim-fl-field"><span>位置</span><select class="pi-input" data-fl-ref>${opts(REFS, f.ref)}</select><select class="pi-input" data-fl-dir>${opts(DIRS, f.dir)}</select><input type="number" class="pi-input" min="0" max="300" value="${f.dist}" data-fl-dist aria-label="距离"><span>km</span></div>
    <div class="sim-fl-field"><span>时机</span><select class="pi-input" data-fl-when><option value="manual"${f.at == null ? ' selected' : ''}>手动进场</option><option value="auto"${f.at != null ? ' selected' : ''}>开战后自动进场</option></select>${f.at != null ? `<input type="number" class="pi-input" min="0" max="1800" value="${f.at}" data-fl-at aria-label="秒"><span>秒后</span>` : ''}</div>
    <div class="sim-fl-acts"><button type="button" class="btn btn-primary btn-sm" data-fl-done>完成</button><button type="button" class="btn btn-ghost btn-sm" data-bt-fl-go="${side}:${f.id}"${f.rows.some((r) => r.unit) ? ' data-ok="1"' : ''}>立即进场</button></div>
  </div>`;
}
function renderPop() {
  const pop = $('simBtPop');
  if (!pop) return;
  const side = BT.reinf;
  if (!side || !BT.b) { pop.hidden = true; return; }
  // 装配读完会重画：保留正在输入的搜索框
  const typing = pop.contains(document.activeElement) && document.activeElement.dataset.btSearch ? document.activeElement.value : null;
  const ed = fleetOf(side, BT.edit);
  pop.innerHTML = `<div class="sim-bt-pop-head"><b>${side} 方舰队支援</b><small>预设舰队，战斗中手动进场或到时间自动进场</small><button type="button" class="sim-3d-x" data-bt-reinf-close aria-label="关闭">${ICON.x}</button></div>
    ${ed ? fleetEditor(side, ed) : `<div class="sim-fl-list">${S.support[side].map((f) => fleetCard(side, f)).join('') || '<p class="sim-empty">还没有支援舰队</p>'}</div>
    <button type="button" class="btn btn-ghost btn-sm" data-fl-new="${side}">＋ 新建支援舰队</button>`}`;
  pop.hidden = false;
  if (typing != null) { const x = pop.querySelector('[data-bt-search]'); if (x) { x.value = typing; x.focus(); } }
  updateBattleUi();
}
// 支援舰队改了：已布阵还没开打时重新布阵（自动进场的时间交给引擎）
function fleetChanged(rebuild = false) {
  save();
  if (rebuild && BT.b && !BT.b.t) newBattle();
  else renderPop();
}
async function addFleetShip(side, ship) {
  const f = fleetOf(side, BT.edit);
  if (!f) return;
  const row = newRow(ship, 5, 'kb');
  f.rows.push(row);
  renderPop();
  await resolveRow(row);
  fleetChanged(f.at != null);
}
function deployFleet(side, id, pos = null) {
  const b = BT.b, f = fleetOf(side, id);
  if (!b || b.done || !f) return;
  BT.t = b.t;   // 在看回放时：回到当前战况再进场
  const n = b.deploy(side, pos ? { ...fleetSpec(f), pos } : fleetSpec(f));
  if (n) ctx.showToast(`${side} 方 ${f.name} ${nameOf(ENTRY, f.mode)} ×${n}`, 'success');
  updateBattleUi();
}
// 选位置进场：暂停，鼠标处显示落点圈，点战场上一个位置后舰队落在那里，再恢复播放
function startPlace(side, id) {
  const f = fleetOf(side, id);
  if (!BT.view || !f || !BT.b || BT.b.done) return;
  const was = BT.playing;
  BT.playing = false;
  BT.placing = { side, id, was };
  BT.reinf = null;
  BT.edit = null;
  renderPop();
  const bar = $('simBtPlace');
  bar.querySelector('span').textContent = `点击战场选择「${f.name}」的落点 · Esc 取消`;
  bar.hidden = false;
  BT.view.setPlacing({
    side, color: side === 'A' ? '#5b9bff' : '#ff6b5e', label: `${f.name} · ${nameOf(ENTRY, f.mode)}`,
    done: (pos) => { endPlace(); deployFleet(side, id, pos); if (was) togglePlay(); }
  });
  updateBattleUi();
}
function endPlace(resume = false) {
  const p = BT.placing;
  if (!p) return;
  BT.placing = null;
  BT.view?.setPlacing(null);
  const bar = $('simBtPlace');
  if (bar) bar.hidden = true;
  if (resume && p.was) togglePlay();
  updateBattleUi();
}
function onFleetClick(e) {
  const el = (sel) => e.target.closest(sel);
  const side = BT.reinf;
  let x;
  if ((x = el('[data-bt-fl-go]'))) { const [s, id] = x.dataset.btFlGo.split(':'); deployFleet(s, Number(id)); return true; }
  if ((x = el('[data-bt-fl-place]'))) { const [s, id] = x.dataset.btFlPlace.split(':'); startPlace(s, Number(id)); return true; }
  if (el('[data-bt-place-cancel]')) { endPlace(true); return true; }
  if (!side) return false;
  if ((x = el('[data-fl-new]'))) { const f = newFleet(side); S.support[side].push(f); BT.edit = f.id; fleetChanged(); return true; }
  if ((x = el('[data-fl-edit]'))) { BT.edit = Number(x.dataset.flEdit); renderPop(); return true; }
  if ((x = el('[data-fl-del]'))) { const id = Number(x.dataset.flDel.split(':')[1]); const f = fleetOf(side, id); S.support[side] = S.support[side].filter((y) => y !== f); fleetChanged(f?.at != null); return true; }
  const f = fleetOf(side, BT.edit);
  if (!f) return false;
  if (el('[data-fl-done]')) { BT.edit = null; renderPop(); return true; }
  if ((x = el('[data-fl-rm]'))) { f.rows = f.rows.filter((r) => r.id !== Number(x.dataset.flRm)); fleetChanged(f.at != null); return true; }
  if ((x = el('[data-fl-mode]'))) { f.mode = x.dataset.flMode; fleetChanged(f.at != null); return true; }
  if ((x = el('[data-fl-cyno]'))) { const r = f.rows.find((y) => y.id === Number(x.dataset.flCyno)); if (r) r.cyno = !r.cyno; fleetChanged(f.at != null); return true; }
  if ((x = el('[data-fl-copy]'))) {
    const src = S.sides[side].find((r) => r.id === Number(x.dataset.flCopy));
    if (!src) return true;
    const row = Object.assign(newRow(src.ship, src.count, src.src, src.fit, src.label), { kills: src.kills, killsOther: src.killsOther });
    f.rows.push(row);
    resolveRow(row).then(() => fleetChanged(f.at != null));
    return true;
  }
  if ((x = el('[data-bt-pick]'))) { const [s, ship] = x.dataset.btPick.split(':'); addFleetShip(s, Number(ship)); return true; }
  return false;
}
function onFleetChange(e) {
  const t = e.target;
  const f = BT.reinf && fleetOf(BT.reinf, BT.edit);
  if (!f || !t.closest('.sim-fl-ed')) return false;
  const num = (lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(t.value)) || d));
  if (t.matches('[data-fl-name]')) { f.name = t.value.trim() || f.name; save(); return true; }
  if (t.matches('[data-fl-n]')) { const r = f.rows.find((y) => y.id === Number(t.dataset.flN)); if (r) r.count = num(1, 500, 1); fleetChanged(f.at != null); return true; }
  if (t.matches('[data-fl-ref]')) f.ref = t.value;
  else if (t.matches('[data-fl-dir]')) f.dir = t.value;
  else if (t.matches('[data-fl-dist]')) f.dist = num(0, 300, 0);
  else if (t.matches('[data-fl-when]')) f.at = t.value === 'auto' ? 30 : null;
  else if (t.matches('[data-fl-at]')) f.at = num(0, 1800, 0);
  else return false;
  fleetChanged(true);
  return true;
}
function onBattleClick(e) {
  const el = (sel) => e.target.closest(sel);
  let x;
  if (el('[data-bt-play]')) { togglePlay(); return true; }
  if ((x = el('[data-bt-speed]'))) { BT.speed = Number(x.dataset.btSpeed); x.parentElement.querySelectorAll('button').forEach((y) => y.classList.toggle('active', y === x)); return true; }
  if (el('[data-bt-finish]')) { finishNow(); return true; }
  if (el('[data-bt-restart]')) { newBattle(); renderResult(); return true; }
  if (el('[data-bt-3d]')) { BT.want3d = true; if (BT.host) mountView(BT.host); return true; }
  if ((x = el('[data-bt-native]'))) { toggleNative(x); return true; }
  if (el('[data-bt-names]')) { BT.names = !BT.names; syncTool('names', BT.names); BT.view?.setLabels(BT.names); return true; }
  if (el('[data-bt-dir]')) { BT.director = !BT.director; syncTool('dir', BT.director); BT.view?.setDirector(BT.director); return true; }
  if (el('[data-bt-cam]')) { BT.view?.resetCamera(); updateBattleUi(); return true; }
  if ((x = el('[data-bt-follow]'))) { if (BT.director) { BT.director = false; syncTool('dir', false); BT.view?.setDirector(false); } BT.view?.follow(Number(x.dataset.btFollow)); updateBattleUi(); return true; }
  if (el('[data-bt-full]')) { const h = $('simBtSec'); if (document.fullscreenElement) document.exitFullscreen(); else h?.requestFullscreen?.(); return true; }
  if (el('[data-bt-unsel]')) { BT.sel = -1; updateBattleUi(); return true; }
  if ((x = el('[data-bt-unit]'))) { BT.sel = Number(x.dataset.btUnit); updateBattleUi(); return true; }
  if ((x = el('[data-bt-primary]'))) {
    const [side, i] = x.dataset.btPrimary.split(':');
    BT.t = BT.b.t;
    BT.b.setPrimary(side, Number(i));
    updateBattleUi();
    return true;
  }
  if ((x = el('[data-bt-reinf]'))) { BT.reinf = BT.reinf === x.dataset.btReinf ? null : x.dataset.btReinf; BT.edit = null; renderPop(); return true; }
  if (el('[data-bt-reinf-close]')) { BT.reinf = null; BT.edit = null; renderPop(); return true; }
  return onFleetClick(e);
}
function onBattleInput(e) {
  const t = e.target;
  if (t.matches('[data-bt-seek]')) { seek(Number(t.value)); t.style.setProperty('--p', Number(t.max) ? Number(t.value) / Number(t.max) : 0); return true; }
  if (t.dataset.btSearch) {
    const box = t.parentElement.querySelector('[data-bt-suggest]');
    const q = t.value.trim();
    if (!q) { box.hidden = true; return true; }
    box.innerHTML = shipSearch(q).map((x) => `<button type="button" class="kb-suggest-item" data-bt-pick="${t.dataset.btSearch}:${x.id}"><img src="${IMG(x.id)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(x.name)}</span><small>${ctx.esc(ctx.data.groups.get(x.group)?.name || '')}</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的舰船</p>';
    box.hidden = false;
    return true;
  }
  return false;
}

// ---------- 参数扫描 / 至少需要几艘 ----------
// 距离 × 目标机动全部跑一遍（不分阶段），再对落后的一方按现有船型比例加船，二分找出能赢的最少数量
let sweepSeq = 0;
const idle = () => new Promise((r) => setTimeout(r, 0));
async function runSweep() {
  if (!S.result) return;
  const seq = ++sweepSeq;
  const total = DISTANCES.length * MOVES.length;
  S.sweep = { cells: {}, done: 0, total, need: null, running: true };
  renderTactics();
  for (const [mv] of MOVES) {
    for (const d of DISTANCES) {
      await idle();
      if (seq !== sweepSeq) return;
      const R = simulate(S.sides, simOpt({ dist: d, moveA: mv }));
      const score = R.eff ? (R.eff.A - 0.5) * 2 : 0;
      S.sweep.cells[`${d}:${mv}`] = { winner: R.winner, lead: R.lead, t: R.t, score };
      S.sweep.done += 1;
      renderTactics();
    }
  }
  // 落后的一方（当前设置下）：按比例加船直到能赢，最多加到 5 倍
  const R0 = S.result;
  const loser = R0 && (R0.winner ? (R0.winner === 'A' ? 'B' : 'A') : R0.lead ? (R0.lead === 'A' ? 'B' : 'A') : null);
  if (loser) {
    const base = S.sides[loser].reduce((t, r) => t + (r.unit ? r.count : 0), 0);
    const scaled = (m) => ({ ...S.sides, [loser]: S.sides[loser].map((r) => ({ ...r, count: Math.max(r.count, Math.round(r.count * m)) })) });
    const wins = async (m) => { await idle(); const R = simulate(scaled(m), simOpt()); return R.winner === loser; };
    let need = null;
    if (await wins(5)) {
      let lo = 1, hi = 5;
      for (let i = 0; i < 9 && hi - lo > 0.5 / Math.max(1, base); i++) {
        if (seq !== sweepSeq) return;
        const mid = (lo + hi) / 2;
        if (await wins(mid)) hi = mid; else lo = mid;
      }
      need = S.sides[loser].reduce((t, r) => t + (r.unit ? Math.max(r.count, Math.round(r.count * hi)) : 0), 0);
    }
    if (seq !== sweepSeq) return;
    S.sweep.need = { side: loser, base, need };
  }
  S.sweep.running = false;
  renderTactics();
}
function renderTactics() {
  const box = root?.querySelector('#simTactics');
  if (!box) return;
  if (!S.result) { box.innerHTML = ''; return; }
  const W = S.sweep;
  const cur = (d, mv) => S.opt.dist === d && S.opt.moveA === mv;
  const cell = (d, mv) => {
    const c = W?.cells[`${d}:${mv}`];
    if (!c) return `<td><span class="sim-cell is-wait">${W?.running ? '…' : ''}</span></td>`;
    const side = c.winner || c.lead;
    const a = Math.min(1, Math.abs(c.score));
    const label = c.winner ? `${c.winner} 胜` : c.lead ? `${c.lead} 优` : '平';
    return `<td><button type="button" class="sim-cell${side ? ' is-' + side.toLowerCase() : ''}${cur(d, mv) ? ' is-cur' : ''}" style="--a:${(0.15 + a * 0.6).toFixed(2)}" data-sim-cell="${d}:${mv}" title="${d} km · A 方${MOVES.find(([v]) => v === mv)[1]} · ${label}${c.winner ? ' · ' + fmtSec(c.t) : ''}">${label}</button></td>`;
  };
  const need = W?.need;
  const needHtml = !W || W.running ? '' : need ? (need.need ? `<p class="sim-need"><b>${need.side} 方</b>至少需 <b>${need.need}</b> 艘才能赢（现 ${need.base} 艘）</p>`
    : `<p class="sim-need"><b>${need.side} 方</b>加到 5 倍也赢不了</p>`) : '<p class="sim-need">没有明显落后的一方</p>';
  box.innerHTML = `<section class="sim-tactics">
    <div class="sim-sec-head"><h4>距离与走位扫描</h4>
      ${W?.running ? `<span class="sim-status busy">扫描中 ${W.done} / ${W.total}</span>` : `<button type="button" class="btn btn-ghost btn-sm" data-sim-sweep>${W ? '重新扫描' : '开始扫描'}</button>`}</div>
    ${W ? `<div class="sim-grid-wrap"><table class="sim-grid"><thead><tr><th>A 方走位 \\ 开局距离</th>${DISTANCES.map((d) => `<th>${d} km</th>`).join('')}</tr></thead>
      <tbody>${MOVES.map(([mv, l]) => `<tr><th>${l}</th>${DISTANCES.map((d) => cell(d, mv)).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="sim-hint">点格子切换到该设置</p>${needHtml}`
    : '<p class="sim-hint">逐个模拟各开局距离 × A 方走位（B 方按当前设置，不含手动增援与点名），并算出落后方需几艘</p>'}
  </section>`;
}

// ---------- 对照 ----------
function setBaseline() {
  const R = S.result;
  if (!R) return;
  const isk = iskOf(R);
  S.base = { t: R.t, winner: R.winner, lead: R.lead, lost: { ...R.lost }, start: R.start, isk: isk ? { A: isk.A.lost, B: isk.B.lost } : null, timeline: R.timeline, at: new Date() };
  renderResult();
}
function baselineHtml(R) {
  const B = S.base;
  if (!B) return '';
  const isk = iskOf(R);
  const diff = (now, was, better) => { const d = now - was; return d ? `<em class="${(d < 0) === better ? 'good' : 'bad'}">${d > 0 ? '+' : ''}${ctx.formatNumber(d)}</em>` : ''; };
  const iskDiff = (s) => (isk && B.isk ? ` · ${ctx.formatISK(B.isk[s])} → ${ctx.formatISK(isk[s].lost)}` : '');
  const res = (x) => (x.winner ? `${x.winner} 方大胜` : x.lead ? `${x.lead} 方占优` : '势均力敌');
  return `<div class="sim-base"><b>对照组</b><span><span>${res(B)}</span> → <span>${res(R)}</span></span>
    ${SIDES.map((s) => `<span><span>${s} 方损失</span> ${B.lost[s]} → ${R.lost[s]}${diff(R.lost[s], B.lost[s], true)}${iskDiff(s)}</span>`).join('')}
    <span><span>用时</span> <span>${fmtSec(B.t)}</span> → <span>${fmtSec(R.t)}</span></span>
    <button type="button" class="link-btn" data-sim-base-clear>清除对照</button></div>`;
}

// ---------- 分享链接 ----------
// 对局（两方舰船、装配、选项）压缩后放进地址：#sim=…；击杀记录装配只记来源，打开时重新读取
const STATE_CODE = { offline: 0, online: 1, active: 2, overload: 3 };
const CODE_STATE = ['offline', 'online', 'active', 'overload'];
const packFit = (f) => f && [f.ship, ctx.FE.SLOTS.map((s) => (f.slots[s] || []).map((m) => (m ? [m.type, m.charge || 0, STATE_CODE[m.state] ?? 1] : 0))), (f.drones || []).map((d) => [d.type, d.count, d.active]), f.implants || []];
const unpackFit = (c) => c && { ship: c[0], slots: Object.fromEntries(ctx.FE.SLOTS.map((s, i) => [s, (c[1][i] || []).map((m) => (m ? { type: m[0], charge: m[1] || null, state: CODE_STATE[m[2]] || 'online' } : null))])), drones: (c[2] || []).map(([type, count, active]) => ({ type, count, active })), implants: c[3] || [] };
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
async function shareUrl() {
  const st = packState();
  for (const s of SIDES) st.sides[s] = st.sides[s].map((r) => ({ ...r, fit: packFit(r.fit) }));
  let bytes = new TextEncoder().encode(JSON.stringify(st)), tag = 'j';
  if (window.CompressionStream) { bytes = await pipe(bytes, new CompressionStream('deflate-raw')); tag = 'z'; }
  return location.origin + location.pathname + '#sim=' + tag + b64(bytes);
}
async function readShare(code) {
  let bytes = unb64(code.slice(1));
  if (code[0] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  const st = JSON.parse(new TextDecoder().decode(bytes));
  for (const s of SIDES) st.sides[s] = (st.sides?.[s] || []).map((r) => ({ ...r, fit: r.fit ? ctx.normalize(unpackFit(r.fit)) : null }));
  return st;
}
async function copyShare() {
  try {
    const url = await shareUrl();
    try { await navigator.clipboard.writeText(url); ctx.showToast('已复制分享链接', 'success'); } catch { window.prompt('复制分享链接', url); }
  } catch (e) { ctx.showToast('生成分享链接失败：' + e.message, 'error'); }
}

// ---------- 界面 ----------
// 示例对局（按英文名找船型，没有的跳过）
const PRESETS = [
  { name: '重型突击舰对射', a: [['Muninn', 15], ['Scimitar', 3]], b: [['Eagle', 15], ['Basilisk', 3]] },
  { name: '战列巡洋舰对冲', a: [['Hurricane', 10]], b: [['Drake', 10]] },
  { name: '护卫舰小队', a: [['Rifter', 5]], b: [['Merlin', 5]] }
];
let enIndex = null;
function shipByEn(name) {
  if (!enIndex) {
    enIndex = new Map();
    for (const t of ctx.data.types.values()) if (t.category === ctx.FE.CAT.ship && t.market && t.en) enIndex.set(t.en, t.id);
  }
  return enIndex.get(name);
}
const presetSide = (list) => list.map(([en, n]) => [shipByEn(en), n]).filter(([id]) => id);

const ICON = {
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  kill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  names: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  cup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg>',
  dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  mirror: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/></svg>'
};

function render() {
  if (!root) return;
  const seg = (key, items) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button type="button" data-sim-opt="${key}" data-v="${v}" class="${String(S.opt[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  root.innerHTML = `<div id="simBody" class="sim-body">
    <header class="sim-head">
      ${S.back ? `<button type="button" class="btn btn-ghost sim-back" data-sim-back>${ICON.back}返回战场统计</button>` : ''}
      <div class="sim-head-main">
        <h2>战场模拟${S.title ? `<small>${ctx.esc(S.title)}</small>` : ''}</h2>
      </div>
      <div class="sim-head-actions">
        <div class="sim-menu">
          <button type="button" class="btn btn-ghost" data-sim-menu aria-expanded="false">${ICON.save}对局存档</button>
          <div class="sim-menu-pop" id="simMenu" hidden></div>
        </div>
        <button type="button" class="btn btn-ghost" data-sim-at title="选一场这一届联盟锦标赛（AT）的比赛来模拟">${ICON.cup}AT 赛</button>
        <button type="button" class="btn btn-ghost" data-sim-share title="生成包含两方舰船、装配和选项的链接">${ICON.link}分享链接</button>
        <button type="button" class="btn btn-ghost" data-sim-swap title="交换 A / B 两方">${ICON.swap}交换两方</button>
        <button type="button" class="btn btn-ghost" data-sim-reset title="清空两方舰船">清空</button>
      </div>
    </header>
    <div class="sim-opts">
      <div class="sim-opt-row">
        <span class="sim-opt-label">常见打法</span>
        <div class="sim-scenes">${SCENES.map(([k, l, o, d]) => `<button type="button" class="sim-scene${Object.entries(o).every(([kk, v]) => S.opt[kk] === v) ? ' active' : ''}" data-sim-scene="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>
      </div>
      <div class="sim-opt-row">
        <span class="sim-opt-label">交战</span>
        <label class="sim-opt" title="开局时两队相隔的距离，之后按各自的走位接近或拉开"><span>开局距离</span><select class="pi-input" data-sim-opt-select="dist">${distOpts(S.opt.dist)}</select></label>
        ${SIDES.map((x) => `<label class="sim-opt"><span>${x} 方走位</span><select class="pi-input" data-sim-move="${x}" title="${MOVES.map(([v, l]) => l + '：' + MOVE_TIP[v]).join('&#10;')}">${MOVES.map(([v, l]) => `<option value="${v}"${S.opt['move' + x] === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`).join('')}
      </div>
      <div class="sim-opt-row">
        <span class="sim-opt-label">规则</span>
        <div class="sim-opt"><span>集火</span>${seg('focus', FOCUS)}</div>
        <div class="sim-opt" title="看战损：按双方被击毁的价值（ISK）之比定胜负&#10;AT 得分：按联盟锦标赛规则，击毁对方的船得它的分值（官方分值表，同型船第二艘起加价），没派满 200 分的差额算给对方；全歼对方直接获胜"><span>胜负</span>${seg('score', SCORE_MODES)}</div>
        <label class="sim-opt"><span>最长</span><select class="pi-input" data-sim-opt-select="max">${DURATIONS.map(([v, l]) => `<option value="${v}"${S.opt.max === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="pi-check"><input type="checkbox" data-sim-flag="logi"${S.opt.logi ? ' checked' : ''}><span>后勤遥修</span></label>
        <label class="pi-check" title="网子、标记、阻尼（扫描分辨率与锁定距离）、ECM（按干扰强度与传感器强度算概率）"><input type="checkbox" data-sim-flag="ewar"${S.opt.ewar ? ' checked' : ''}><span>电子战</span></label>
        <label class="pi-check" title="逐秒结算电容：耗电装备在电容不够时按比例运转，中和与吸电会扣目标的电容"><input type="checkbox" data-sim-flag="cap"${S.opt.cap ? ' checked' : ''}><span>电容 / 中和</span></label>
        <label class="pi-check" title="开启时速度与信号半径都按推进器开着计算（舰队对射时一般不开）"><input type="checkbox" data-sim-flag="prop"${S.opt.prop ? ' checked' : ''}><span>推进器开启</span></label>
      </div>
      <div class="sim-opt-row" id="simBulkRow" hidden><span class="sim-opt-label">装配</span><div class="sim-opt" id="simBulk"></div></div>
      <span class="sim-status" id="simStatus" role="status"></span>
    </div>
    <div id="simVerdict"></div>
    <div class="sim-sides" id="simSides"></div>
    <div id="simBattle"></div>
    <div id="simResult"></div>
    <div id="simTactics"></div>
    <details class="sim-note">
      <summary>模拟规则与局限</summary>
      <p>三维空间逐 0.5 秒推进：按惯性加速与各自走位；炮台与无人机每发按实际角速度、距离掷骰（含三倍致命一击），导弹真实飞行、命中时按目标当时速度与信号半径算，舰载机、电涌投射器同样按爆炸半径与速度；热能分解器连续打同一目标逐轮加成；弹药打完要装填；维修、中和按周期结算；电子战、遥修按实际距离与衰减范围算。</p>
      <p>一方没有输出舰船时，剩下的船对准后跃迁撤离（被扰断 / 扰频走不掉），撤离不算损失；胜负看双方损失价值之比（战损比）。</p>
      <p>集火每 ${SQUAD} 艘打一个目标（点名集火时整方一起打）；长冷却装备不计开启；超载不计过热；指挥脉冲约为基础值 ${BURST_MULT.toFixed(1)} 倍；无人机、舰载机不会被击落；ISK 按全服均价。结果仅供参考。</p>
    </details>
  </div><div class="sim-detail" id="simDetail" hidden></div>`;
  renderSides();
  renderBattle();
  renderResult();
  renderTactics();
}
const distOpts = (v) => DISTANCES.map((d) => `<option value="${d}"${v === d ? ' selected' : ''}>${d} km</option>`).join('');

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
  const opts = hasBattle(row) ? [['battle', row.at ? 'AT 实际装配' : '本场阵亡装配'], ['kb', '最近常见装配']] : [['kb', '最近常见装配']];
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
    <button type="button" class="sim-row-img" data-sim-detail title="查看 / 更换装配"><img src="${IMG(r.ship)}" alt="" width="36" height="36" loading="lazy"></button>
    <div class="sim-row-main">
      <button type="button" class="sim-row-name" data-sim-detail title="查看 / 更换装配"><b>${ctx.esc(t?.name || '')}</b><span>装配详情 ›</span></button>
      ${r.pilot ? `<div class="sim-row-pilot"><span translate="no">${ctx.esc(r.pilot)}</span>${r.flag ? '<em>AT 旗舰</em>' : ''}${r.realDead ? '<small>实际阵亡</small>' : ''}</div>` : ''}
      <div class="sim-row-info">${info}</div>
      <select class="plain-select sim-fit" data-sim-fit aria-label="装配">${fitOptions(r)}</select>
      ${followHtml(side, r)}
    </div>
    <div class="sim-step" role="group" aria-label="数量">
      <button type="button" data-sim-step="-1" aria-label="减少"${r.count <= 1 ? ' disabled' : ''}>−</button>
      <input type="number" class="sim-count" min="1" max="500" value="${r.count}" data-sim-count aria-label="数量" inputmode="numeric">
      <button type="button" data-sim-step="1" aria-label="增加"${r.count >= 500 ? ' disabled' : ''}>+</button>
    </div>
    <div class="sim-row-acts">
      <button type="button" class="icon-btn" data-sim-mirror title="复制到${side === 'A' ? ' B' : ' A'} 方" aria-label="复制到对方">${ICON.mirror}</button>
      <button type="button" class="icon-btn sim-del" data-sim-del title="移除" aria-label="移除">${ICON.x}</button>
    </div>
  </div>`;
}

// 几十种船陆续读完装配时，每帧最多重画一次（每读完一种都整表重画会卡住页面）
let sidesFrame = 0;
function renderSidesSoon() {
  if (!sidesFrame) sidesFrame = requestAnimationFrame(() => { sidesFrame = 0; renderSides(); });
}
function renderSides() {
  if (sidesFrame) { cancelAnimationFrame(sidesFrame); sidesFrame = 0; }
  const box = root?.querySelector('#simSides');
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
        <div class="sim-side-stats"><span>纸面 <b>${ctx.formatNumber(Math.round(tot.dps))}</b> DPS</span><span><b>${ctx.formatISK(tot.ehp, true)}</b> EHP</span>${tot.reps ? `<span>遥修 <b>${ctx.formatNumber(Math.round(tot.reps))}</b>/s</span>` : ''}</div>
      </header>
      ${sideOptsHtml(s)}
      <div class="sim-add">
        <div class="search-box sim-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-sim-search="${s}" placeholder="添加舰船（中英文名）" autocomplete="off" spellcheck="false" aria-label="添加舰船">
          <div class="kb-suggest" data-sim-suggest="${s}" hidden></div>
        </div>
        ${cur ? `<button type="button" class="btn btn-ghost" data-sim-add-current="${s}" title="把装配页当前的装配加入这一方">当前装配</button>` : ''}
        <button type="button" class="btn btn-ghost" data-sim-eft="${s}" title="粘贴 EFT 装配，或定向扫描结果（扫描窗口里全选复制，按船型导入）">粘贴 EFT / 扫描</button>
      </div>
      ${adding ? `<div class="sim-eft"><textarea class="pi-input" rows="6" data-sim-eft-text placeholder="${ctx.esc(trTa('EFT 装配，如 [Muninn, 舰队装配]\n或定向扫描结果：扫描窗口里全选复制后粘贴，按船型直接导入'))}"></textarea><div><button type="button" class="btn btn-primary" data-sim-eft-go="${s}">加入</button><button type="button" class="btn btn-ghost" data-sim-eft-cancel>取消</button></div></div>` : ''}
      <div class="sim-rows">${list.map((r) => rowHtml(s, r)).join('') || '<p class="sim-empty">还没有舰船</p>'}</div>
      ${list.length ? `<div class="sim-side-foot"><button type="button" class="link-btn danger" data-sim-clear="${s}">清空 ${s} 方</button></div>` : ''}
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
  const bulk = root.querySelector('#simBulk');
  if (bulk) {
    const any = SIDES.some((s) => S.sides[s].some(hasBattle));
    bulk.hidden = !any;
    root.querySelector('#simBulkRow').hidden = !any;
    const at = SIDES.some((s) => S.sides[s].some((r) => r.at));
    bulk.innerHTML = any ? `<div class="segmented" role="group"><button type="button" data-sim-src="battle">${at ? '全部用 AT 实际装配' : '全部用本场阵亡装配'}</button><button type="button" data-sim-src="kb">全部用最近常见装配</button></div>` : '';
  }
}

// 走位官：火力走位官带队按走位方式移动，后勤走位官停在它后方的遥修距离内；各行可选跟哪个走位官，不跟的按定位走位
const LEADS = [['dps', '火力走位官', '带队按本方走位方式移动，速度不超过最慢的跟随者；同一行的船都跟着它'], ['logi', '后勤走位官', '停在火力走位官后方的遥修距离内；同一行的船都跟着它']];
function leadHtml(s) {
  const list = S.sides[s];
  if (!list.length) return '';
  return LEADS.map(([k, l, tip]) => `<label class="sim-lead" title="${tip}"><span>${l}</span><select class="plain-select" data-sim-lead="${s}:${k}"><option value="">不设</option>${list.map((r) => `<option value="${r.id}"${r.lead === k ? ' selected' : ''}>${ctx.esc(shipName(r.ship))}</option>`).join('')}</select></label>`).join('');
}
// 行的走位：走位官所在行跟随走位官；其余可选跟火力 / 后勤走位官，或按定位走位
function followHtml(side, r) {
  const has = LEADS.filter(([k]) => S.sides[side].some((x) => x.lead === k));
  if (!has.length) return '';
  if (r.lead) return `<em class="sim-lead-tag">${nameOf(LEADS, r.lead)}</em>`;
  const v = has.some(([k]) => k === r.move) ? r.move : 'role';
  return `<select class="plain-select sim-follow" data-sim-follow aria-label="走位"><option value="role">按定位走位</option>${has.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>跟${l}</option>`).join('')}</select>`;
}
// 每方的设置：技能、超载、指挥脉冲、走位官
function sideOptsHtml(s) {
  const o = S.sideOpt[s];
  const esi = ctx.hasEsi?.();
  return `<div class="sim-side-opts">
    ${esi ? `<select class="plain-select" data-sim-side-skills="${s}" aria-label="技能"><option value="max"${o.skills === 'max' ? ' selected' : ''}>技能全 5 级</option><option value="esi"${o.skills === 'esi' ? ' selected' : ''}>技能按${S.esiSkills ? ' ' + ctx.esc(S.esiSkills.name) : '我的角色'}</option></select>` : '<span class="sim-side-tag" title="绑定 ESI 后可以按自己角色的技能计算">技能全 5 级</span>'}
    <label class="pi-check" title="能超载的已开启装备全部超载（伤害、射速、维修、抗性等提升；不计过热损坏）"><input type="checkbox" data-sim-side-heat="${s}"${o.heat ? ' checked' : ''}><span>超载</span></label>
    ${leadHtml(s)}
    <span class="sim-burst" role="group" aria-label="指挥脉冲"><span>指挥脉冲</span>${BURSTS.map(([k, l, tip]) => `<button type="button" class="${o.bursts.includes(k) ? 'active' : ''}" data-sim-burst="${s}:${k}" title="${tip}" aria-pressed="${o.bursts.includes(k)}">${l}</button>`).join('')}</span>
  </div>`;
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

// 输入框（textarea）里的文字不走自动翻译
const trTa = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);
// 定向扫描结果（扫描窗口里全选复制）：每行「类型 ID<Tab>名称<Tab>类型<Tab>距离」，旧客户端没有类型 ID；与本地分析同一种识别方式。
// 只取舰船（不含太空舱），按船型计数；不像扫描结果时返回 null
const SCAN_DIST = /^(-|[\d.,\s ]+\s*(m|km|au|米|千米|公里|天文单位|км|м|а\.?е\.?))$/i;
const CAPSULES = new Set([670, 33328]);
let shipByName = null;
function parseScan(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.map((l) => (l.includes('\t') ? l.split('\t') : l.trim().split(/[ \u00a0\u3000]{2,}/)).map((c) => c.trim().replace(/\*+$/, '').trim()))
    .filter((c) => c.length >= 3 && SCAN_DIST.test(c[c.length - 1]));
  if (!rows.length || rows.length < lines.length * 0.5) return null;
  if (!shipByName) {
    shipByName = new Map();
    for (const t of ctx.data.types.values()) if (t.category === ctx.FE.CAT.ship) { shipByName.set(t.name.toLowerCase(), t.id); if (t.en) shipByName.set(t.en.toLowerCase(), t.id); }
  }
  const count = new Map();
  for (const c of rows) {
    const id = /^\d+$/.test(c[0]) && c.length >= 4 ? Number(c[0]) : shipByName.get(String(c[1]).toLowerCase());
    if (!id || CAPSULES.has(id) || ctx.data.types.get(id)?.category !== ctx.FE.CAT.ship) continue;
    count.set(id, (count.get(id) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]);
}
// 扫描到的舰船并入列表（同船型的最近常见装配行合并数量），返回新加的行
function addScanned(list, ships) {
  const added = [];
  for (const [ship, n] of ships) {
    const same = list.find((r) => r.ship === ship && r.src === 'kb');
    if (same) same.count = Math.min(500, same.count + n);
    else { const r = newRow(ship, n, 'kb'); list.push(r); added.push(r); }
  }
  return added;
}
const scanToast = (ships) => ctx.showToast(ships.length ? `已从定向扫描导入 ${ships.reduce((t, x) => t + x[1], 0)} 艘（${ships.length} 种船）` : '扫描结果里没有舰船', ships.length ? 'success' : 'error');
function importScanSide(side, ships) {
  scanToast(ships);
  if (!ships.length) return;
  const added = addScanned(S.sides[side], ships);
  S.adding = null;
  undo = null;
  changed();
  added.forEach((r) => resolveRow(r));
}
function importScanFleet(f, ships) {
  scanToast(ships);
  if (!ships.length) return;
  const added = addScanned(f.rows, ships);
  renderPop();
  Promise.all(added.map(resolveRow)).then(() => fleetChanged(f.at != null));
}
// 粘贴：装配 / 支援舰队的粘贴框里贴进定向扫描结果，直接导入
function onPaste(e) {
  const t = e.target;
  if (!t.matches?.('[data-sim-eft-text], [data-fl-scan]')) return;
  const ships = parseScan(e.clipboardData?.getData('text') || '');
  if (!ships) {
    if (t.matches('[data-fl-scan]')) { e.preventDefault(); ctx.showToast('没有识别出定向扫描结果：在扫描窗口里全选复制', 'error'); }
    return;
  }
  e.preventDefault();
  if (t.matches('[data-fl-scan]')) { const f = BT.reinf && fleetOf(BT.reinf, BT.edit); if (f) importScanFleet(f, ships); }
  else if (S.adding) importScanSide(S.adding.side, ships);
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
  undo = null;
  changed();
  if (!same) { if (row.fit) prepare(row, side); resolveRow(row); }
  // 刚加的那行闪一下
  const id = same ? same.id : row.id;
  root.querySelector(`[data-sim-row="${side}:${id}"]`)?.classList.add('flash');
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
  changed();
}

function loadPreset(p) {
  const mk = (list) => presetSide(list).map(([ship, n]) => newRow(ship, n));
  S.sides.A = mk(p.a);
  S.sides.B = mk(p.b);
  S.title = '';
  S.back = '';
  S.real = null;
  S.teams = null;
  S.result = null;
  render();
  save();
  for (const s of SIDES) S.sides[s].forEach(resolveRow);
  schedule(0);
}

// AT 赛的一场比赛（sim-at.js）：蓝队进 A 方、红队进 B 方，每名选手一行（装配用这型船最近常见的装配）；
// 实际损失按选手记在行上（realDead），比赛限时 10 分钟
function loadAt(m, d) {
  // 装配：阵亡且有击杀记录的用比赛实际装配（决赛周）；其余用本场同型船的实际装配，再退到本届同队、本届任意队伍的同型船，都没有时用最近常见装配
  const kmOf = (teams, ship) => teams.flatMap((x) => x.ships).filter((x) => x[0] === ship && x[5]).map((x) => x[5]);
  const all = d.matches.flatMap((x) => [x.red, x.blue]);
  const pool = (t, ship) => [[m.red, m.blue], all.filter((x) => x.id === t.id), all].map((teams) => kmOf(teams, ship)).find((x) => x.length) || [];
  const side = (t) => t.ships.filter((x) => ctx.data.types.has(x[0])).map(([ship, pilotId, pilot, alive, flag, km]) => {
    const other = km ? [] : pool(t, ship);
    return Object.assign(newRow(ship, 1, km || other.length ? 'battle' : 'kb'), { pilot, pilotId, flag: flag ? 1 : undefined, realDead: alive ? 0 : 1, kills: km ? [km] : [], killsOther: other.slice(0, 60), at: 1 });
  });
  const lost = (t) => { const out = new Map(); for (const x of t.ships) if (!x[3]) out.set(x[0], (out.get(x[0]) || 0) + 1); return out; };
  S.sides.A = side(m.blue);
  S.sides.B = side(m.red);
  S.support = { A: [], B: [] };
  S.real = { A: lost(m.blue), B: lost(m.red) };
  S.teams = { id: m.id, win: m.winner === 'blue' ? 'A' : 'B', A: { id: m.blue.id, name: m.blue.name }, B: { id: m.red.id, name: m.red.name } };
  S.title = `${d.tournament} ${m.type === 'final' ? '决赛周' : '预选'} 第 ${m.no} 场 · ${m.blue.name} vs ${m.red.name}`;
  S.back = '';
  S.opt.max = 600;
  S.opt.score = 'at';
  Object.assign(S, { result: null, detail: null, base: null, sweep: null });
  render();
  save();
  for (const s of SIDES) S.sides[s].forEach(resolveRow);
  schedule(0);
  root.querySelector('#simSides')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- 对局存档 ----------
function savesList() { return ctx.store.getJSON(SAVES_KEY, []) || []; }
function toggleMenu(on = !S.menu) {
  S.menu = on;
  const pop = root?.querySelector('#simMenu');
  if (!pop) return;
  root.querySelector('[data-sim-menu]').setAttribute('aria-expanded', String(on));
  pop.hidden = !on;
  if (!on) return;
  const list = savesList();
  const n = (st) => SIDES.map((s) => (st.sides?.[s] || []).reduce((t, r) => t + r.count, 0));
  const empty = !S.sides.A.length && !S.sides.B.length;
  pop.innerHTML = `<form class="sim-save-form" data-sim-save-form>
      <input class="pi-input" name="name" maxlength="40" placeholder="${ctx.esc(S.title || '给这局起个名字')}" aria-label="存档名称"${empty ? ' disabled' : ''}>
      <button type="submit" class="btn btn-primary"${empty ? ' disabled' : ''}>保存当前</button>
    </form>
    ${list.length ? `<div class="sim-save-list">${list.map((x) => { const [a, b] = n(x); return `<div class="sim-save-item">
        <button type="button" data-sim-load="${x.id}"><b translate="no">${ctx.esc(x.name)}</b><small>A ${a} 艘 vs B ${b} 艘 · ${new Date(x.at).toLocaleDateString('zh-CN')}</small></button>
        <button type="button" class="icon-btn" data-sim-unsave="${x.id}" title="删除存档" aria-label="删除存档">${ICON.x}</button>
      </div>`; }).join('')}</div>` : '<p class="sim-save-empty">还没有存档（仅存本机）</p>'}`;
  if (!empty) pop.querySelector('input').focus();
}

function onSubmit(e) {
  if (!e.target.matches('[data-sim-save-form]')) return;
  e.preventDefault();
  const name = (e.target.elements.name.value.trim() || S.title || `A ${S.sides.A.reduce((t, r) => t + r.count, 0)} 艘 vs B ${S.sides.B.reduce((t, r) => t + r.count, 0)} 艘`).slice(0, 40);
  const list = savesList().filter((x) => x.name !== name);
  list.unshift({ id: Date.now(), name, at: Date.now(), ...packState() });
  ctx.store.setJSON(SAVES_KEY, list.slice(0, SAVES_MAX));
  ctx.showToast(`已保存「${name}」`, 'success');
  toggleMenu(true);
}

// ---------- 交互 ----------
function onClick(e) {
  if (S.detail && e.target.closest('#simDetail')) { onDetailClick(e); return; }
  const el = (sel) => e.target.closest(sel);
  let x;
  if (onBattleClick(e)) return;
  if (el('[data-sim-back]')) { history.back(); return; }
  if (el('[data-sim-menu]')) { toggleMenu(); return; }
  if (el('[data-sim-undo]')) { undoClear(); return; }
  if (el('[data-sim-share]')) { copyShare(); return; }
  if (el('[data-sim-sweep]')) { runSweep(); return; }
  if ((x = el('[data-sim-scene]'))) {
    const sc = SCENES.find(([k]) => k === x.dataset.simScene);
    if (!sc) return;
    Object.assign(S.opt, sc[2]);
    save();
    const sweep = S.sweep;
    render();
    S.sweep = sweep;
    run();
    return;
  }
  if (el('[data-sim-base]')) { setBaseline(); return; }
  if (el('[data-sim-base-clear]')) { S.base = null; renderResult(); return; }
  if ((x = el('[data-sim-cell]'))) {
    const [d, mv] = x.dataset.simCell.split(':');
    Object.assign(S.opt, { dist: Number(d), moveA: mv });
    save();
    const sweep = S.sweep;
    render();
    S.sweep = sweep;
    renderTactics();
    run();
    return;
  }
  if ((x = el('[data-sim-burst]'))) {
    const [side, k] = x.dataset.simBurst.split(':');
    const o = S.sideOpt[side];
    o.bursts = o.bursts.includes(k) ? o.bursts.filter((b) => b !== k) : [...o.bursts, k];
    reprepare([side]);
    return;
  }
  if ((x = el('[data-sim-load]'))) {
    const st = savesList().find((v) => String(v.id) === x.dataset.simLoad);
    if (!st) return;
    loadState(st);
    S.result = null;
    S.menu = false;
    render();
    save();
    for (const s of SIDES) S.sides[s].forEach(resolveRow);
    schedule(0);
    ctx.showToast(`已载入「${st.name}」`, 'success');
    return;
  }
  if ((x = el('[data-sim-unsave]'))) {
    ctx.store.setJSON(SAVES_KEY, savesList().filter((v) => String(v.id) !== x.dataset.simUnsave));
    toggleMenu(true);
    return;
  }
  if ((x = el('[data-sim-preset]'))) { loadPreset(PRESETS[Number(x.dataset.simPreset)]); return; }
  if (el('[data-sim-battles]')) { ctx.openBattles?.(); return; }
  if (el('[data-sim-at]')) { openAt(document.body, loadAt); return; }
  const dt = el('[data-sim-detail]');
  if (dt) { const { side, row } = findRow(dt); openDetail(side, row.id); return; }
  const opt = el('[data-sim-opt]');
  if (opt) {
    const k = opt.dataset.simOpt;
    S.opt[k] = typeof S.opt[k] === 'string' ? opt.dataset.v : Number(opt.dataset.v);
    if (k === 'score') { opt.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === opt)); save(); scoreChanged(); return; }
    opt.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === opt));
    save();
    schedule(0);
    return;
  }
  const bulk = el('[data-sim-src]');
  if (bulk) {
    const src = bulk.dataset.simSrc;
    for (const s of SIDES) for (const r of S.sides[s]) if (AUTO.has(r.src) && r.src !== src && (src === 'kb' || hasBattle(r))) { r.src = src; r.fit = null; r.status = 'idle'; resolveRow(r); }
    changed();
    return;
  }
  const ch = el('[data-sim-chart]');
  if (ch) { S.chart = ch.dataset.simChart; ch.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === ch)); drawChart(); return; }
  const pick = el('[data-sim-pick]');
  if (pick) {
    const [side, ship] = pick.dataset.simPick.split(':');
    document.activeElement?.blur?.();
    addRow(side, newRow(Number(ship), 1));
    return;
  }
  if ((x = el('[data-sim-step]'))) {
    const { row } = findRow(x);
    row.count = Math.max(1, Math.min(500, row.count + Number(x.dataset.simStep)));
    changed();
    return;
  }
  if ((x = el('[data-sim-mirror]'))) {
    const { side, row } = findRow(x);
    const other = side === 'A' ? 'B' : 'A';
    const copy = Object.assign(newRow(row.ship, row.count, row.src, row.fit ? JSON.parse(JSON.stringify(row.fit)) : null, row.label), { kills: row.kills, killsOther: row.killsOther });
    if (copy.fit) prepare(copy);
    addRow(other, copy);
    return;
  }
  const del = el('[data-sim-del]');
  if (del) {
    const { side, row } = findRow(del);
    S.sides[side] = S.sides[side].filter((r) => r !== row);
    changed();
    return;
  }
  const cur = el('[data-sim-add-current]');
  if (cur) {
    const fit = ctx.normalize(JSON.parse(JSON.stringify(ctx.getFit())));
    const row = newRow(fit.ship, 1, 'current', fit, '当前装配');
    prepare(row);
    addRow(cur.dataset.simAddCurrent, row);
    return;
  }
  const eft = el('[data-sim-eft]');
  if (eft) { S.adding = { side: eft.dataset.simEft }; renderSides(); root.querySelector('[data-sim-eft-text]')?.focus(); return; }
  if (el('[data-sim-eft-cancel]')) { S.adding = null; renderSides(); return; }
  const go = el('[data-sim-eft-go]');
  if (go) {
    const text = root.querySelector('[data-sim-eft-text]').value;
    const ships = parseScan(text);
    if (ships) { importScanSide(go.dataset.simEftGo, ships); return; }
    const r = ctx.parseEft(text);
    if (r.error) { ctx.showToast('无法识别：' + r.error, 'error', 3500); return; }
    const row = newRow(r.fit.ship, 1, 'eft', ctx.normalize(r.fit), r.fit.name || 'EFT 装配');
    prepare(row);
    S.adding = null;
    addRow(go.dataset.simEftGo, row);
    return;
  }
  const clr = el('[data-sim-clear]');
  if (clr) { clearSides([clr.dataset.simClear]); return; }
  if (el('[data-sim-reset]')) { clearSides(SIDES); return; }
  if (el('[data-sim-swap]')) {
    [S.sides.A, S.sides.B] = [S.sides.B, S.sides.A];
    [S.sideOpt.A, S.sideOpt.B] = [S.sideOpt.B, S.sideOpt.A];
    if (S.real) [S.real.A, S.real.B] = [S.real.B, S.real.A];
    if (S.teams) S.teams = { ...S.teams, A: S.teams.B, B: S.teams.A, win: S.teams.win === 'A' ? 'B' : 'A' };
    S.base = null;
    changed();
    schedule(0);
  }
}

// 清空可撤销（提示条里的「撤销」）
let undo = null;
function clearSides(list) {
  if (!list.some((s) => S.sides[s].length)) return;
  undo = { sides: { A: S.sides.A, B: S.sides.B }, title: S.title, real: S.real, back: S.back, teams: S.teams };
  for (const s of list) S.sides[s] = [];
  if (list.length === 2) { S.title = ''; S.real = null; S.back = ''; S.teams = null; render(); }
  changed();
  renderVerdict();
}
function undoClear() {
  if (!undo) return;
  Object.assign(S, { sides: undo.sides, title: undo.title, real: undo.real, back: undo.back, teams: undo.teams });
  undo = null;
  render();
  changed();
}

function onChange(e) {
  const t = e.target;
  if (onFleetChange(e)) return;
  if (t.dataset.simLead) {
    const [side, kind] = t.dataset.simLead.split(':');
    for (const r of S.sides[side]) if (r.lead === kind || String(r.id) === t.value) r.lead = String(r.id) === t.value ? kind : undefined;
    changed();
    return;
  }
  if (t.matches('[data-bt-quality]')) { BT.quality = t.value; ctx.store.setJSON(Q_KEY, t.value); BT.view?.setQuality(t.value); return; }
  if (t.matches('[data-sim-follow]')) { findRow(t).row.move = t.value === 'role' ? undefined : t.value; changed(); return; }
  if (t.matches('[data-sim-fit]')) { setSource(findRow(t).row, t.value); return; }
  if (t.matches('[data-sim-count]')) {
    const { row } = findRow(t);
    row.count = Math.max(1, Math.min(500, Math.round(Number(t.value)) || 1));
    changed();
    return;
  }
  if (t.dataset.simMove) { S.opt['move' + t.dataset.simMove] = t.value; save(); schedule(0); return; }
  if (t.dataset.simOptSelect) { S.opt[t.dataset.simOptSelect] = Number(t.value); save(); schedule(0); return; }
  if (t.dataset.simOptNum) { S.opt[t.dataset.simOptNum] = Math.max(5, Math.min(S.opt.max - 5, Math.round(Number(t.value) / 5) * 5 || 30)); t.value = S.opt[t.dataset.simOptNum]; save(); schedule(0); return; }
  if (t.dataset.simSideSkills) { S.sideOpt[t.dataset.simSideSkills].skills = t.value; save(); if (t.value === 'esi' && !S.esiSkills) ensureEsiSkills(); else reprepare([t.dataset.simSideSkills]); return; }
  if (t.dataset.simSideHeat) { S.sideOpt[t.dataset.simSideHeat].heat = t.checked; reprepare([t.dataset.simSideHeat]); return; }
  if (t.dataset.simFlag) {
    S.opt[t.dataset.simFlag] = t.checked;
    save();
    if (t.dataset.simFlag === 'prop') { for (const s of SIDES) S.sides[s].forEach((r) => { if (r.fit) prepare(r); }); renderSides(); }
    schedule(0);
  }
}

function onInput(e) {
  const t = e.target;
  if (onBattleInput(e)) return;
  if (!t.dataset.simSearch) return;
  const side = t.dataset.simSearch;
  const box = root.querySelector(`[data-sim-suggest="${side}"]`);
  const q = t.value.trim();
  if (!q) { box.hidden = true; return; }
  const hits = shipSearch(q);
  box.innerHTML = hits.map((s, i) => `<button type="button" class="kb-suggest-item${i ? '' : ' active'}" data-sim-pick="${side}:${s.id}"><img src="${IMG(s.id)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.esc(s.name)}</span><small>${ctx.esc(ctx.data.groups.get(s.group)?.name || '')}</small></button>`).join('') || '<p class="ind-side-empty">没有匹配的舰船</p>';
  box.hidden = false;
}

// 搜索框键盘操作：↑↓ 选择、回车添加、Esc 收起
function onKeydown(e) {
  const t = e.target;
  if (t.dataset?.simSearch) {
    const box = root.querySelector(`[data-sim-suggest="${t.dataset.simSearch}"]`);
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
      const [side, ship] = (items[Math.max(0, i)]).dataset.simPick.split(':');
      t.value = '';
      box.hidden = true;
      addRow(side, newRow(Number(ship), 1));
      root.querySelector(`[data-sim-search="${side}"]`)?.focus();
    }
    return;
  }
  if (e.key === 'Enter' && t.matches('[data-sim-count]')) t.blur();
}

function onFocusOut(e) {
  const t = e.target;
  if (!t.dataset?.simSearch) return;
  // 点建议项时先失焦：稍等再收起
  setTimeout(() => {
    if (!root.contains(document.activeElement) || !document.activeElement.closest('.sim-search')) root.querySelector(`[data-sim-suggest="${t.dataset.simSearch}"]`)?.setAttribute('hidden', '');
  }, 150);
}

function run() {
  if (!root?.querySelector('#simSides')) return;
  root.querySelectorAll('[data-sim-scene]').forEach((b) => b.classList.toggle('active', Object.entries(SCENES.find(([k]) => k === b.dataset.simScene)[2]).every(([k, v]) => S.opt[k] === v)));
  const all = SIDES.flatMap((s) => S.sides[s]);
  const waiting = all.filter((r) => !r.unit && (r.status === 'loading' || r.status === 'idle'));
  // 设置变了：重新布阵（不直接出结果，等用户开战）
  if (!S.sides.A.length || !S.sides.B.length || !SIDES.every((s) => S.sides[s].some((r) => r.unit))) {
    S.result = null;
    BT.b = null;
    renderBattle();
  } else newBattle();
  setStatus(waiting.length);
  renderResult();
}

function setStatus(waiting) {
  const el = root?.querySelector('#simStatus');
  if (!el) return;
  const both = S.sides.A.length && S.sides.B.length;
  el.className = 'sim-status' + (waiting ? ' busy' : S.result ? ' ok' : '');
  el.textContent = !both ? '两方各加一艘船即开始模拟'
    : waiting ? `读取装配（剩 ${waiting} 种）` : '';
}

// ---------- 结果 ----------
function fmtSec(s) { return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`; }

// 结论条放在舰船列表上方：改设置时不用往下翻就能看到胜负；两方都空时显示快速开始
function renderVerdict() {
  const box = root?.querySelector('#simVerdict');
  if (!box) return;
  const R = S.result;
  if (!S.sides.A.length && !S.sides.B.length) {
    box.innerHTML = `<section class="sim-start">
      ${undo ? `<div class="sim-undo">已清空舰船<button type="button" class="link-btn" data-sim-undo>撤销</button></div>` : ''}
      <h3>从哪里开始？</h3>
      <div class="sim-start-grid">
        <button type="button" class="sim-start-card" data-sim-battles>
          <b>从真实会战导入</b><span>自动带入双方舰船和阵亡装配</span><em>去选会战 ›</em>
        </button>
        <button type="button" class="sim-start-card sim-start-at" data-sim-at>
          <b>AT 赛（联盟锦标赛）</b><span>这一届已打过的比赛，双方选手和阵容一键带入</span><em>去选比赛 ›</em>
        </button>
        ${PRESETS.map((p, i) => {
          const a = presetSide(p.a), b = presetSide(p.b);
          if (!a.length || !b.length) return '';
          const icons = (list) => list.map(([id, n]) => `<span><img src="${IMG(id)}" alt="" width="22" height="22" loading="lazy">${ctx.esc(ctx.data.types.get(id)?.name || '')} ×${n}</span>`).join('');
          return `<button type="button" class="sim-start-card" data-sim-preset="${i}"><b>${p.name}</b><div class="sim-start-vs"><div>${icons(a)}</div><i>VS</i><div>${icons(b)}</div></div><em>载入示例 ›</em></button>`;
        }).join('')}
      </div>
    </section>`;
    return;
  }
  if (!R) { box.innerHTML = ''; return; }
  // 胜负看战损：A 方击毁价值占双方损失的比例（有价格按 ISK，否则按 EHP）
  const isk = iskOf(R);
  const eff = isk && isk.A.lost + isk.B.lost ? isk.A.eff : R.eff?.A ?? null;
  let winner = eff == null ? null : eff >= 0.75 ? 'A' : eff <= 0.25 ? 'B' : null;
  const lead = winner || (eff == null ? null : eff >= 0.55 ? 'A' : eff <= 0.45 ? 'B' : null);
  let verdict = winner ? `${winner} 方大胜` : lead ? `${lead} 方占优` : eff == null ? '双方都没有损失' : '势均力敌';
  // AT 得分：全歼对方直接获胜，否则比得分
  const side2 = (s, k) => tally(R.rows.filter((r) => r.side === s).map((r) => [r.row.ship, r[k]]));
  const at = S.opt.score === 'at' && atReady() ? atScore({ A: side2('A', 'n'), B: side2('B', 'n') }, { A: side2('A', 'lost'), B: side2('B', 'lost') }) : null;
  if (at) {
    const wipe = SIDES.find((s) => !R.end[s] && R.end[s === 'A' ? 'B' : 'A']);
    winner = wipe ? (wipe === 'A' ? 'B' : 'A') : at.A > at.B ? 'A' : at.B > at.A ? 'B' : null;
    verdict = winner ? `${winner} 方获胜${wipe ? '（全歼）' : ''}` : '平分';
  }
  const esc = SIDES.filter((s) => R.escaped[s]).map((s) => `${s} 方 ${R.escaped[s]} 艘撤离`).join('，');
  const sub = `用时 ${fmtSec(R.t)} · A 方损失 ${R.lost.A} 艘，B 方损失 ${R.lost.B} 艘${esc ? '，' + esc : ''}${!isk && eff != null ? '（按 EHP 计战损，价格未读到）' : ''}`;
  const skipped = R.skipped ? `<span class="sim-warn">还有 ${R.skipped} 艘船的装配没读到，暂未计入</span>` : '';
  const side = (s) => {
    const lost = R.lost[s];
    const real = S.real?.[s] ? [...S.real[s].values()].reduce((a, b) => a + b, 0) : null;
    const team = S.teams?.[s] ? `<div class="sim-v-team"><span translate="no">${ctx.esc(S.teams[s].name)}</span>${S.teams.win === s ? '<em>比赛实际获胜</em>' : ''}</div>` : '';
    return `<div class="sim-v-side side-${s.toLowerCase()}">${team}<span class="sim-badge">${s} 方</span><b>${R.end[s]}</b><small>/ ${R.start[s]} 艘存活</small>
      <div class="sim-v-bar"><i style="width:${(R.end[s] / Math.max(1, R.start[s]) * 100).toFixed(1)}%"></i></div>
      <small><span>损失</span> ${lost}${R.escaped[s] ? ` · <span>撤离</span> ${R.escaped[s]}` : ''}${real != null ? ` · <span>实际损失</span> ${real}` : ''}</small>
      ${at ? `<small><span>AT 得分</span> <b class="sim-v-pts">${at[s]}</b> · <span>派出</span> ${Math.round(at.field[s])} 分</small>` : ''}
      ${isk ? `<small><span>损失</span> ${ctx.formatISK(isk[s].lost)} ISK${isk[s].eff != null ? ` · <span>效率</span> ${pct(isk[s].eff)}` : ''}</small>` : ''}</div>`;
  };
  // ISK 交换比：A 方击毁 : A 方损失（大于 1 说明 A 方赚了）；AT 得分时显示比分
  const why = tipsOf(R)[0];
  const ratio = at ? `AT 得分 ${at.A} : ${at.B}${at.miss ? `（${at.miss} 艘不在分值表里，按 0 分）` : ''}`
    : isk && isk.A.lost + isk.B.lost ? (isk.A.lost ? `A 方 ISK 交换比 ${(isk.B.lost / isk.A.lost).toFixed(2)} : 1` : 'A 方零损失') : '';
  box.innerHTML = `<section class="sim-verdict${winner ? ' sim-win-' + winner.toLowerCase() : ''}">
    ${side('A')}
    <div class="sim-v-mid"><b>${verdict}</b><span>${sub}</span>${ratio ? `<span class="sim-ratio" title="${at ? '按联盟锦标赛规则：击毁对方的船得它的分值，派出不到 200 分的差额算给对方' : 'A 方击毁价值 : A 方损失价值（全服均价）'}">${ratio}</span>` : ''}${skipped}
      ${why ? `<span class="sim-why"><span class="sim-badge${why[1] === 'B' ? ' sim-side-b' : ''}">${why[1]} 方</span><span>${ctx.esc(why[2])}</span></span>` : ''}
      <button type="button" class="link-btn" data-sim-base title="记下这次结果，改完舰船 / 装配 / 设置后对比前后差异">${S.base ? '更新对照' : '设为对照'}</button></div>
    ${side('B')}
  </section>${baselineHtml(R)}`;
}

function renderResult() {
  renderVerdict();
  const box = root?.querySelector('#simResult');
  if (!box) return;
  const R = S.result;
  if (!R) { box.innerHTML = ''; renderTactics(); return; }
  const isk = iskOf(R);
  const table = (s) => {
    const rows = R.rows.filter((r) => r.side === s);
    const real = S.real?.[s];
    return `<div class="sim-res-side">
      <h5><span class="sim-badge">${s} 方</span>损失 ${R.lost[s]} / ${R.start[s]}${R.escaped[s] ? ` · 撤离 ${R.escaped[s]}` : ''}${real ? ` · 实际损失 ${[...real.values()].reduce((a, b) => a + b, 0)}` : ''}</h5>
      <div class="pi-table-wrap"><table class="pi-table sim-table">
        <thead><tr><th>舰船</th><th class="num">出场</th><th class="num">模拟损失</th>${real ? '<th class="num">实际损失</th>' : ''}${isk ? '<th class="num pi-hide-sm">损失 ISK</th>' : ''}<th class="num pi-hide-sm">输出</th><th class="num pi-hide-sm">承伤</th>${R.rows.some((r) => r.repaired) ? '<th class="num pi-hide-sm">遥修</th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><div class="pi-prod"><img src="${IMG(r.row.ship)}" alt="" width="24" height="24" loading="lazy"><span>${ctx.esc(ctx.data.types.get(r.row.ship)?.name || '')}</span>${r.row.pilot ? `<small class="sim-pilot" translate="no">${ctx.esc(r.row.pilot)}</small>` : ''}</div></td>
          <td class="num">${r.n}</td><td class="num${r.lost ? ' sim-lost' : ''}">${r.lost}</td>${real ? `<td class="num">${r.row.realDead ?? (real.get(r.row.ship) || 0)}</td>` : ''}${isk ? `<td class="num pi-hide-sm" title="单艘 ${ctx.formatISK(r.value)} ISK">${r.lost ? ctx.formatISK(r.value * r.lost) : '—'}</td>` : ''}
          <td class="num pi-hide-sm">${ctx.formatISK(r.dealt)}</td><td class="num pi-hide-sm">${ctx.formatISK(r.taken)}</td>${R.rows.some((x) => x.repaired) ? `<td class="num pi-hide-sm">${r.repaired ? ctx.formatISK(r.repaired) : '—'}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  };
  const firsts = R.kills.slice(0, 12);
  box.innerHTML = `<section class="sim-result">
    <div class="sim-chart">
      <div class="kb-br-chart-head">
        <h4>战况走势</h4>
        <div class="kb-br-legend"><span class="a"><i></i>A 方</span><span class="b"><i></i>B 方</span>${S.base ? '<span class="sim-legend-base"><i></i>对照组</span>' : ''}</div>
        <div class="segmented" role="group" aria-label="图表类型">
          <button type="button" data-sim-chart="ships" class="${S.chart !== 'hp' ? 'active' : ''}">剩余舰船</button>
          <button type="button" data-sim-chart="hp" class="${S.chart === 'hp' ? 'active' : ''}">剩余血量</button>
        </div>
      </div>
      <div class="kb-br-plot" id="simPlot"><svg></svg><div class="kb-br-tip" id="simTip" hidden></div></div>
    </div>
    ${firsts.length ? `<div class="sim-kills"><h5>阵亡顺序</h5><div>${firsts.map((k) => `<span class="sim-kill sim-kill-${k.side.toLowerCase()}"><small>${fmtSec(k.t)}</small><img src="${IMG(k.ship)}" alt="" width="20" height="20" loading="lazy">${ctx.esc(ctx.data.types.get(k.ship)?.name || '')}</span>`).join('')}${R.kills.length > firsts.length ? `<span class="sim-more">…共 ${R.kills.length} 艘</span>` : ''}</div></div>` : ''}
    ${insightsHtml(R)}
    ${matchupHtml(R)}
    <div class="sim-res-cols">${table('A')}${table('B')}</div>
  </section>`;
  drawChart();
  renderTactics();
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
  const base = S.base?.timeline;
  const tMax = Math.max(10, tl[tl.length - 1].t, base ? base[base.length - 1].t : 0);
  const top = Math.max(1, R.start.A, R.start.B, S.base ? Math.max(S.base.start.A, S.base.start.B) : 0);
  const ys = hp ? 0.25 : [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v * 4 >= top * 1.04) || Math.ceil(top / 4);
  const max = ys * 4;
  const x = (t) => L + t / tMax * iw;
  plotX = x;
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
  const line = (s, list = tl) => list.map((p, i) => (i ? (hp ? `L${x(p.t).toFixed(1)},${y(val(p, s)).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(val(p, s)).toFixed(1)}`) : `M${x(p.t).toFixed(1)},${y(val(p, s)).toFixed(1)}`)).join('');
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
    ${base ? `<path class="ln a sim-ln-base" d="${line('A', base)}"/><path class="ln b sim-ln-base" d="${line('B', base)}"/>` : ''}
    ${R.rec ? `<line class="sim-rp-ln" x1="${x(BT.t)}" x2="${x(BT.t)}" y1="${T}" y2="${T + ih}"/>` : ''}
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
  // 点图：回放跳到这一秒
  hit.onclick = (e) => {
    const r = svg.getBoundingClientRect();
    seek(Math.min(R.t, Math.max(0, (e.clientX - r.left - L) / iw * tMax)));
  };
}

// ---------- 装配详情 / 更换 ----------
// 左边是这型船能用的装配（本场阵亡的几套、最近常见的几套、我的装配、游戏装配、当前装配、空船），右边是选中那套的槽位与属性
const SLOT_NAMES = { high: '高槽', mid: '中槽', low: '低槽', rig: '改装件', sub: '子系统' };

// 详情面板在页面里整块替换模拟界面：打开时滚到顶部，关闭时回到原来的位置
let bodyScroll = 0;
function showDetailPane(on) {
  const body = $('simBody'), pane = $('simDetail');
  if (!body || !pane) return;
  const scroller = root?.closest('.kb-scroll');
  if (on && body.hidden === false && scroller) bodyScroll = scroller.scrollTop;
  body.hidden = on;
  pane.hidden = !on;
  if (!on) pane.innerHTML = '';
  if (scroller) scroller.scrollTop = on ? 0 : bodyScroll;
}

function closeDetail() {
  if (S.detail?.auto?.state === 'search') ctx.cancelCounterFit?.();
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
  if (!detailGroups().some((g) => g.items.some((x) => x.key === S.detail.sel))) S.detail.sel = 'row';
  renderDetail();
}

async function candidates(row) {
  const groups = [];
  const kb = async (title, kills, prefix) => {
    const r = await loadKb(row.ship, kills).catch(() => null);
    if (r?.list?.length) groups.push({ title, sub: `最近 ${r.total} 次损失`, items: r.list.map((g, i) => ({ key: `${prefix}:${i}`, fit: g.fit, label: `${title} #${i + 1}`, meta: `×${g.n}` })) });
  };
  if (row.fit) groups.push({ title: '正在使用', items: [{ key: 'row', fit: row.fit, label: row.label || '当前选择', meta: '' }] });
  if (row.kills?.length) await kb(row.at ? '比赛实际装配' : '本场阵亡装配', row.kills, 'bk');
  if (row.killsOther?.length) await kb(row.at ? 'AT 同型船实际装配' : '本场对方同型船装配', row.killsOther, 'bo');
  await kb('最近常见装配', null, 'kb');
  const mine = [];
  const cur = ctx.getFit();
  if (cur?.ship === row.ship) mine.push({ key: 'current', fit: cur, label: '当前装配', meta: '装配页' });
  for (const f of ctx.savedFits().filter((x) => x.ship === row.ship)) mine.push({ key: 'saved:' + f.id, fit: f, label: f.name || '未命名', meta: '我的装配' });
  if (mine.length) groups.push({ title: '我的装配', items: mine });
  if (ctx.hasEsi?.()) {
    const items = (S.esi.fits || []).filter((x) => x.ship === row.ship).map((f) => ({ key: 'esi:' + f.esiId, fit: f, label: f.name || '未命名', meta: '游戏装配' }));
    groups.push({ title: '游戏装配', items, note: S.esi.loading ? '读取中…' : S.esi.error ? '读取失败：' + S.esi.error : items.length ? '' : '游戏里没有这型船的装配' });
  }
  groups.push({ title: '其他', items: [{ key: 'hull', fit: emptyFit(row.ship), label: '空船（无装备）', meta: '' }] });
  return groups;
}

// ---------- 智能装配（针对对方阵容）----------
// 按对方阵容（各型船的信号半径、速度、按血量加权的抗性，输出的伤害类型，想打的距离）用装配页的智能装配搜索（fit-auto.js counterFit），
// 搜出的方案与正在使用的装配各按当前设置跑一次模拟，比较本方的战损交换（对方损失占双方总损失的比例）。
const foeOf = (side) => (side === 'A' ? 'B' : 'A');
function enemyOf(side) {
  const rows = S.sides[foeOf(side)].filter((r) => r.unit);
  if (!rows.length) return null;
  const total = rows.reduce((t, r) => t + r.count * r.unit.ehp, 0) || 1;
  // 权重最大的 12 型船当目标（几十型船逐个算太慢，小头影响不大）
  const top = rows.map((r) => ({ u: r.unit, w: (r.count * r.unit.ehp) / total })).sort((a, b) => b.w - a.w).slice(0, 12);
  const wsum = top.reduce((t, x) => t + x.w, 0) || 1;
  const res = [0, 0, 0, 0];
  for (const { u, w } of top) {
    const hp = u.max.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < 4; k++) res[k] += (w / wsum) * u.max.reduce((t, h, l) => t + (h / hp) * u.res[l][k], 0);
  }
  // 伤害类型比例与交战距离按对方各型船的输出加权
  const dmg = [0, 0, 0, 0];
  let dps = 0, pref = 0;
  for (const r of rows) {
    r.unit.types.forEach((v, k) => { dmg[k] += r.count * v; });
    dps += r.count * r.unit.dps;
    pref += r.count * r.unit.dps * r.unit.pref;
  }
  const sum = dmg.reduce((a, b) => a + b, 0);
  // 距离 d 上对方打得到的输出比例：炮台按最佳射程 / 失准衰减，导弹、电涌按射程；无人机、舰载机按都打得到
  const guns = rows.flatMap((r) => r.unit.guns.map((g) => ({ g, v: r.count * g.volley / (g.cycle || 1) })));
  const always = rows.reduce((t, r) => t + r.count * (r.unit.fighter + r.unit.drones.reduce((a, x) => a + x.n * x.volley / (x.cycle || 4), 0)), 0);
  const all = always + guns.reduce((t, x) => t + x.v, 0);
  const incoming = (d) => (all ? (always + guns.reduce((t, { g, v }) => t + v * (g.turret && !g.vorton ? rangeEff({ range: g.opt, falloff: g.fall }, d) : d <= g.reach ? 1 : 0), 0)) / all : 1);
  return {
    targets: top.map(({ u, w }) => ({ sig: u.sig, vel: u.vel, w: w / wsum })), res, incoming,
    profile: sum ? dmg.map((v) => v / sum) : [0.25, 0.25, 0.25, 0.25],
    dist: dps ? Math.min(150000, pref / dps) : 0
  };
}
const rangeEff = (x, d) => (d <= x.range ? 1 : x.falloff > 0 ? 0.5 ** (((d - x.range) / x.falloff) ** 2) : 0);
// 换上这套装配跑模拟：返回本方的战损交换（几次不同随机数的平均，单次受命中掷骰影响大；null = 双方都没损失）
const TRIAL_SEEDS = [20261026, 7, 1234567, 99991];
async function trial(row, side, fit, step = () => {}) {
  const tmp = { ...row, fit: ctx.normalize(JSON.parse(JSON.stringify(fit))) };
  prepare(tmp, side);
  if (!tmp.unit) return null;
  const sides = { ...S.sides, [side]: S.sides[side].map((r) => (r === row ? tmp : r)) };
  const effs = [];
  for (const seed of TRIAL_SEEDS) {
    await idle();
    const R = simulate(sides, simOpt({ seed }));
    if (R.eff) effs.push(R.eff[side]);
    step();
  }
  return effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : null;
}
async function runCounter() {
  const D = S.detail, row = detailRow();
  if (!D || !row || D.auto?.state === 'search' || D.auto?.state === 'sim') return;
  const enemy = enemyOf(D.side);
  if (!enemy) { ctx.showToast(`${foeOf(D.side)} 方还没有读到装配的舰船`, 'info'); return; }
  const token = D.token;
  const so = S.sideOpt[D.side];
  D.auto = { state: 'search', n: 0 };
  renderDetail();
  try {
    const base = row.fit || emptyFit(row.ship);
    const out = await ctx.counterFit({ fit: base, enemy, skills: so.skills === 'esi' && S.esiSkills ? S.esiSkills.levels : 'max', onProgress: (n) => {
      if (S.detail?.token !== token) return;
      D.auto.n = n;
      const el = $('simDetail')?.querySelector('[data-sim-auto-n]');
      if (el) el.textContent = ctx.formatNumber(n);
    } });
    if (S.detail?.token !== token) return;
    D.auto = { state: 'sim', done: 0, total: (out.results.length + (row.fit ? 1 : 0)) * TRIAL_SEEDS.length };
    renderDetail();
    const step = () => {
      D.auto.done += 1;
      const el = $('simDetail')?.querySelector('[data-sim-auto-n]');
      if (el) el.textContent = `${D.auto.done} / ${D.auto.total}`;
    };
    const now = row.fit ? await trial(row, D.side, row.fit, step) : null;
    const items = [];
    for (const [i, x] of out.results.entries()) {
      await idle();
      if (S.detail?.token !== token) return;
      items.push({ key: 'auto:' + i, fit: x.fit, eff: await trial(row, D.side, x.fit, step), dps: x.r.dps });
    }
    items.sort((a, b) => (b.eff ?? -1) - (a.eff ?? -1));
    const pct = (v) => (v == null ? '无损失' : Math.round(v * 100) + '%');
    items.forEach((x, i) => { x.label = i ? '智能装配 · 备选' : '智能装配 · 推荐'; x.meta = '交换 ' + pct(x.eff); });
    D.auto = { state: 'done', items, now, dist: enemy.dist };
    if (items[0]) D.sel = items[0].key;
  } catch (e) {
    if (S.detail?.token !== token) return;
    D.auto = { state: e.message === 'cancelled' ? 'idle' : 'error', error: e.message };
  }
  renderDetail();
}
// 详情左侧的装配分组：智能装配插在「正在使用」后面
function detailGroups() {
  const D = S.detail;
  if (!D?.groups) return [];
  const foe = foeOf(D.side), a = D.auto || { state: 'idle' };
  const pct = (v) => (v == null ? '无损失' : Math.round(v * 100) + '%');
  const g = { title: `智能装配 · 针对 ${foe} 方`, auto: true, items: a.items || [] };
  if (a.state === 'done') {
    const now = detailRow()?.fit && a.now != null ? a.now : null;
    const worse = now != null && !a.items.some((x) => (x.eff ?? -1) > now);
    g.note = `按 ${foe} 方阵容配装（对方主力想打 ${Math.round(a.dist / 1000)} km），各跑 ${TRIAL_SEEDS.length} 次模拟比较本方战损交换（对方损失占双方总损失）${now != null ? `；正在使用的装配 ${pct(now)}` : ''}${worse ? '，没有找到更好的方案' : ''}`;
  }
  if (a.state === 'error') g.note = '配装失败：' + a.error;
  const list = D.groups.slice();
  list.splice(list[0]?.items[0]?.key === 'row' ? 1 : 0, 0, g);
  return list;
}

// 选中装配按模拟同样的规则计算（长冷却装备与推进器的开关）
function evaluate(item) {
  if (!item.ev) {
    const tmp = { fit: ctx.normalize(JSON.parse(JSON.stringify(item.fit))) };
    try { prepare(tmp, S.detail?.side || 'A'); } catch { tmp.unit = null; }
    item.ev = tmp;
  }
  return item.ev;
}

// 列表里每套装配的摘要：主力武器（输出最高的一种，没有时取数量最多的无人机）与坦克类型（血量最多的一层）
function brief(ev) {
  const { data } = ctx;
  const out = { id: 0, text: '', tank: '' };
  const byType = new Map();
  for (const w of ev.stats?.weapons || []) {
    const id = w.module.type.id;
    const e = byType.get(id) || { n: 0, dps: 0 };
    e.n += 1; e.dps += w.dps;
    byType.set(id, e);
  }
  const top = [...byType].sort((a, b) => b[1].dps - a[1].dps)[0];
  if (top) Object.assign(out, { id: top[0], text: `${top[1].n}× ${data.types.get(top[0])?.name || ''}` });
  else {
    const d = (ev.fit?.drones || []).slice().sort((a, b) => b.count - a.count)[0];
    if (d) Object.assign(out, { id: d.type, text: `${d.count}× ${data.types.get(d.type)?.name || ''}` });
  }
  const max = ev.unit?.max;
  if (max) out.tank = ['护盾', '装甲', '结构'][max.indexOf(Math.max(...max))];
  return out;
}

function renderDetail() {
  const pane = $('simDetail');
  const row = detailRow();
  if (!pane || !row) { closeDetail(); return; }
  const { esc } = ctx;
  const t = ctx.data.types.get(row.ship);
  const D = S.detail;
  const groups = detailGroups();
  const items = groups.flatMap((g) => g.items);
  const sel = items.find((x) => x.key === D.sel) || (row.fit ? { key: 'row', fit: row.fit, label: row.label } : null);
  const a = D.auto || { state: 'idle' };
  const autoAct = a.state === 'search' ? `<p class="sim-dt-note sim-loading">正在搜索… <b data-sim-auto-n>${ctx.formatNumber(a.n || 0)}</b> 种组合 <button type="button" class="link-btn" data-sim-auto-stop>停止</button></p>`
    : a.state === 'sim' ? `<p class="sim-dt-note sim-loading">模拟对比中… <b data-sim-auto-n>${a.done} / ${a.total}</b></p>`
    : `<button type="button" class="btn btn-ghost sim-dt-auto" data-sim-auto-go title="按对方各型船的体型、速度、抗性与伤害类型挑武器、弹药和抗性，装备等级与预算按装配页智能装配的设置">${a.state === 'done' ? '重新配装' : `按 ${foeOf(D.side)} 方阵容配一套`}</button>`;
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  const list = D.groups ? groups.map((g) => `<div class="sim-dt-group">
      <h5>${esc(g.title)}${g.sub ? `<small>${esc(g.sub)}</small>` : ''}</h5>
      ${g.items.map((x) => {
        const ev = evaluate(x), u = ev.unit, w = brief(ev);
        // 智能装配的交换比：比正在使用的好标绿，差标红
        const tone = x.eff !== undefined && a.now != null ? ((x.eff ?? -1) > a.now ? ' good' : ' bad') : '';
        return `<button type="button" class="sim-dt-item${x.key === D.sel ? ' active' : ''}" data-sim-dt-pick="${esc(x.key)}">
        <span class="sim-dt-ico">${w.id ? `<img src="${IMG(w.id)}" alt="" width="32" height="32" loading="lazy">` : ''}</span>
        <span class="sim-dt-txt">
          <span class="sim-dt-top"><b>${esc(x.label)}</b>${x.meta ? `<em class="sim-dt-tag${tone}">${esc(x.meta)}</em>` : ''}</span>
          <span class="sim-dt-wpn">${w.text ? esc(w.text) : '没有武器'}</span>
          <span class="sim-dt-num">${u ? `<i><b>${num(u.dps)}</b> DPS</i><i><b>${ctx.formatISK(u.ehp)}</b> EHP</i>${w.tank ? `<i>${w.tank}</i>` : ''}` : '—'}</span>
        </span></button>`;
      }).join('')}
      ${g.note ? `<p class="sim-dt-note">${esc(g.note)}</p>` : ''}${g.auto ? autoAct : ''}
    </div>`).join('') : '<p class="sim-loading sim-dt-note">读取装配…</p>';
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
  const { esc } = ctx;
  const ev = evaluate(item);
  const using = item.key === 'row';
  return `<div class="sim-dt-view-head"><h5>${esc(item.label)}</h5>
      <div class="sim-dt-actions">
        <button type="button" class="btn btn-primary" data-sim-dt-use${using ? ' disabled' : ''}>${using ? '正在使用' : '使用这套装配'}</button>
        <button type="button" class="btn btn-ghost" data-sim-dt-open title="在装配页打开这套装配，可以改装备后再加入模拟">在装配页打开</button>
      </div></div>
    ${fitBody(ev.fit, ev.unit)}`;
}
// 装配内容（属性卡片 + 抗性表 + 按槽位的装备列表）：战场模拟的装配详情、驾驶模拟的「查看装配」共用
// pilot：驾驶模拟里看（推进器、微型跃迁引擎等都由玩家自己开关，不标「未开启 / 不计开启」）
export function fitBody(fit, u, pilot = false) {
  const { esc, FE, data } = ctx;
  const num = (v) => ctx.formatNumber(Math.round(v || 0));
  const name = (id) => esc(data.types.get(id)?.name || '#' + id);
  const icon = (id, sz = 24) => `<img src="${IMG(id, 'icon', 32)}" alt="" width="${sz}" height="${sz}" loading="lazy">`;
  const slots = FE.SLOTS.map((s) => {
    const mods = (fit.slots[s] || []).filter(Boolean);
    if (!mods.length) return '';
    // 同装备同弹药同状态合并成一行
    const grouped = [];
    for (const m of mods) {
      const off = pilot ? null : forcedOff(m);
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
    stats = `<div class="sim-dt-over"><div class="sim-dt-cards">
        <div><small>DPS</small><b>${num(u.dps)}</b>${u.dps ? dmgBar : ''}</div>
        <div><small>EHP</small><b>${ctx.formatISK(u.ehp)}</b></div>
        <div><small>最大速度</small><b>${num(u.vel)}<em>m/s</em></b></div>
        <div><small>信号半径</small><b>${num(u.sig)}<em>m</em></b></div>
        <div><small>扫描分辨率</small><b>${num(u.scanRes)}<em>mm</em></b></div>
        ${local ? `<div><small>本地维修</small><b>${num(local)}<em>HP/s</em></b></div>` : ''}
        ${remote ? `<div><small>遥修</small><b>${num(remote)}<em>HP/s</em></b></div>` : ''}
        ${u.webs.length || u.paints.length ? `<div><small>网子 / 标记</small><b>${u.webs.length} / ${u.paints.length}</b></div>` : ''}
      </div>
      <table class="fit-resist sim-dt-res"><thead><tr><th></th>${DAMAGE_NAMES.map((n, j) => `<th class="is-${DK[j]}">${n}</th>`).join('')}<th>HP</th></tr></thead><tbody>${res}</tbody></table></div>`;
  }
  return `${stats}
    <div class="sim-dt-slots">${slots}${drones}${!slots && !drones ? '<p class="sim-dt-note">没有装备</p>' : ''}</div>`;
}

function onDetailClick(e) {
  const row = detailRow();
  if (!row || e.target.closest('[data-sim-dt-back]')) { closeDetail(); return; }
  if (e.target.closest('[data-sim-auto-go]')) { runCounter(); return; }
  if (e.target.closest('[data-sim-auto-stop]')) { ctx.cancelCounterFit?.(); return; }
  const items = detailGroups().flatMap((g) => g.items);
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
    closeDetail();
    ctx.openInFitting(ctx.normalize(JSON.parse(JSON.stringify(item.fit))));
  }
}

function useFit(row, item) {
  // 我的装配 / 游戏装配 / 当前装配 / 空船：与下拉框同一个来源
  if (/^(saved|esi):/.test(item.key) || item.key === 'current' || item.key === 'hull') { setSource(row, item.key); return; }
  row.src = 'pick';
  row.error = '';
  row.fit = ctx.normalize(JSON.parse(JSON.stringify(item.fit)));
  row.label = item.key.startsWith('auto:') ? `智能装配 · 针对 ${foeOf(sideOf(row))} 方` : item.label + (item.meta ? ' ' + item.meta : '');
  row.status = 'ok';
  prepare(row);
  changed();
}

// ---------- 驾驶模拟（pilot.js）用 ----------
// 按船型和装配算出战斗单位：没给装配时用击杀记录最近常见装配，没有就是空船。技能按 A 方设置。
// 返回 { row, off, prop, variant }：row.unit 为推进器开启时的属性，off 为推进器关闭时的属性，prop 为推进器在装备栏里的序号（没有为 -1）；
// variant(装备栏序号[], { 序号: 弹药类型 }) = 这几件主动装备关着、换了这些弹药时的属性（玩家开关推进器、抗性、感应增强器、换弹药时切换；按组合缓存）
export async function pilotRow(ship, fit = null, label = '', prep = null, o = {}) {
  const row = newRow(ship, 1, fit ? 'manual' : 'kb', fit, label);
  if (!fit) {
    const r = await loadKb(ship).catch(() => null);
    row.fit = r ? ctx.normalize(r.fit) : emptyFit(ship);
    row.label = r ? `常见装配 ×${r.n}` : '击杀记录里没有这型船 · 空船';
    // 船炸的时候还在太空里的无人机不会记进击杀邮件，无人机船最常见的那套经常是空舱：从同型船别的击杀记录里拿最常见的一组无人机补上
    const bw = ctx.data.types.get(ship)?.attrs.get(ctx.FE.AT.droneBandwidth) || 0;
    if (r && bw > 0 && !(row.fit.drones || []).length) {
      const alt = (r.list || []).find((x) => x.fit?.drones?.length);
      if (alt) { row.fit.drones = alt.fit.drones.map((d) => ({ ...d, active: 0 })); row.label += ' · 无人机取自别的击杀记录'; }
    }
  }
  prep?.(row.fit);   // 驾驶模拟：装配里没激活的无人机按带宽激活（击杀记录装配的无人机都在舱里）
  // 装配里「在线」（关着）的主动装备也算进来，开关组合（variant）：sim-unit pilotUnit（匹配服务器同一份）
  const so = S.sideOpt.A || sideDefaults();
  const skills = so.skills === 'esi' && S.esiSkills ? S.esiSkills.levels : 'max';
  // 增效剂：植入体用装配里的，增效剂换成驾驶模拟里选的（o.boosters）；副作用按几率各掷一次
  let side = [];
  if (o.boosters) {
    const boost = (id) => ctx.data.types.get(id)?.attrs.has(1087);
    row.fit = { ...row.fit, implants: [...(row.fit.implants || []).filter((id) => !boost(id)), ...o.boosters.filter(boost)] };
    ({ fit: row.fit, side } = rollSideFx(row.fit, skills));
  }
  bindUnit(ctx, S.opt);
  const r = pilotUnit(row.fit, { skills, heat: so.heat, bursts: so.bursts, self: !!o.self, base: S.opt });
  Object.assign(row, { fit: r.fit, calc: r.calc, stats: r.stats, unit: r.unit });
  // 微型跃迁推进器：被扰频时要关掉；电脑船换成 off 的属性（sim-engine）
  if (r.mwd) row.unitOff = r.off;
  // 装备提示用：这件装备（槽位:序号）超载（ov）、装着这种弹药、这个舰船模式时整套装配的属性（同一份技能；按组合缓存）
  const ovCache = new Map();
  const ovCalc = (key, charge, mode = r.mode, ov = true) => {
    const k = `${key}|${charge || ''}|${mode || ''}|${ov ? 1 : 0}`;
    if (!ovCache.has(k)) {
      const [s, i] = String(key).split(':');
      const slots = { ...r.fit.slots, [s]: (r.fit.slots[s] || []).map((m, j) => (m && j === +i ? { ...m, ...(ov ? { state: 'overload' } : {}), ...(charge ? { charge } : {}) } : m)) };
      ovCache.set(k, ctx.FE.computeFit(ctx.data, { ...r.fit, slots, ...(mode ? { mode } : {}) }, skills));
    }
    return ovCache.get(k);
  };
  return { row, off: r.off, prop: r.prop, variant: r.variant, mwd: r.mwd, modes: r.modes, mode: r.mode, modeCd: r.modeCd, ovCalc, side };
}
// 增效剂副作用：每个副作用效果按增效剂上的几率属性（boosterEffectChance1..5，技能「神经毒素恢复」会降低）各掷一次；
// 返回 { fit（sideFx 列出中了的）, side: [{ booster, attr（惩罚属性）, value（%） }] }
function rollSideFx(fit, skills) {
  const { FE, data } = ctx;
  const calc = (fit.implants || []).length ? FE.computeFit(data, { ...fit, sideFx: [] }, skills) : null;
  const on = [], side = [];
  for (const it of calc?.implants || []) {
    for (const eid of it.type.effects) {
      const ch = FE.SIDE_FX.get(eid);
      if (!ch || Math.random() >= it.attr(ch)) continue;
      on.push(`${it.type.id}:${eid}`);
      const attr = data.effects.get(eid)?.mods?.[0]?.[3];
      side.push({ booster: it.type.id, attr, value: attr ? it.attr(attr) : 0 });
    }
  }
  return { fit: { ...fit, sideFx: on }, side };
}
export { shipSearch as pilotShipSearch };
