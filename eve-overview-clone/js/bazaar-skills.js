// ===== 角色交易：卖家技能分析 =====
// 技能来自卖家贴的 qsna.eu 技能展示（/api/kb/bazaar/skills?id=，ESI 格式：技能 ID、已训练等级、技能点），
// 或晨曦藏宝阁的角色详情（/api/kb/bazaar/cbg/detail?id=，只有等级，技能点按等级推算），
// 舰船与技能的需求、前置、等级（rank）、主副属性取自装配数据（fit-engine 的 fit-data.json）。
// 定位：能开的旗舰 / 特种舰、主修武器与坦克（按技能组技能点）、主力种族（按船体技能技能点）、技能组分布；
// 可开舰船按船级列出；开船耗时：还差的技能（含前置）逐级列出，训练速度 = 主属性 + 副属性 / 2 技能点每分钟，
// 卖家的属性不公开，按新角色默认属性与「最优属性重置」（主 27、副 21、其余 17）各算一次，不含植入体。
// 可用装备：市场上需要技能的装备、无人机、舰载机、子系统、弹药、植入体，按物品组列出能用的（可显示还不能用的及所需时间）。
// 全部技能：按游戏技能分组列出每个技能的等级与技能点（同个人中心 · 技能），可搜索、按已学 / 未满级 / 未学筛选。
// 列表筛选：「能开某船 / 能用某装备 / 能开某船级任意一艘 / 某技能几级」，按角色技能等级判断（needHtml / meets / bindNeed）。

import { loadSkillData } from './skills-page.js?v=v35';

const AT = { rank: 275, pri: 180, sec: 181 };
const ATTR_KEYS = { 164: 'cha', 165: 'int', 166: 'mem', 167: 'per', 168: 'wil' };
const DEFAULT_ATTRS = { cha: 19, int: 20, mem: 20, per: 20, wil: 20 };
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];
const spForLevel = (rank, level) => (level <= 0 ? 0 : Math.ceil(250 * rank * Math.pow(Math.sqrt(32), level - 1)));
const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

// 定位用的船级（groupID）：[名称, 船级, 分类]
const ROLE_GROUPS = [
  ['旗舰', [30, 659, 5120, 547, 485, 4594, 1538]],
  ['特种舰', [900, 898, 834, 830, 831, 832, 1527, 540, 963, 833, 906, 894, 541, 893, 1305, 1534, 1972, 4902, 324, 358, 1201]],
  ['工业与运输', [883, 941, 543, 463, 1283, 513, 902, 380, 1202]]
];
// 船级显示顺序：旗舰 > 特种 > 工业 > 普通
const GROUP_ORDER = [...ROLE_GROUPS.flatMap(([, g]) => g), 27, 419, 26, 420, 25, 237, 28, 31];
// 武器 / 坦克方向：技能组 ID
const FOCUS = { weapon: [[255, '射击学（炮台）'], [256, '导弹'], [273, '无人机']], tank: [[1209, '护盾'], [1210, '装甲']] };
const RACES = [['Amarr', '艾玛'], ['Caldari', '加达里'], ['Gallente', '盖伦特'], ['Minmatar', '米玛塔尔'], ['ORE', 'ORE'], ['Triglavian', '三神裔'], ['EDENCOM', '伊甸联合防御阵线'], ['Upwell', 'Upwell'], ['Deathless', '不朽者']];
const RACE_RE = new RegExp(`^(${RACES.map(([en]) => en).join('|')}) `);

let esc = (s) => String(s ?? '');
let fmtNum = (n) => String(n);

export function setHelpers(h) { esc = h.esc; fmtNum = h.formatNumber; }

// ---------- 计算 ----------
export function makeChar(data, r) {
  const have = new Map(), sp = new Map();
  // 藏宝阁只给技能等级：技能点按等级与技能倍数（rank）推算
  for (const [id, lv, p] of r.skills || []) { have.set(id, lv); sp.set(id, p || spForLevel(skillInfo(data, id)?.rank || 1, lv)); }
  return { data, have, sp, total: r.total_sp || [...sp.values()].reduce((a, b) => a + b, 0), shipsCache: null, estimated: (r.skills || []).some((x) => x[1] > 0 && !x[2]) };
}

function skillInfo(data, id) {
  const t = data.types.get(id);
  if (!t) return null;
  return { t, rank: t.attrs.get(AT.rank) || 1, pri: ATTR_KEYS[t.attrs.get(AT.pri)] || 'int', sec: ATTR_KEYS[t.attrs.get(AT.sec)] || 'mem' };
}

// 还差的技能（含前置），逐级条目 [{ skill, level, sp, pri, sec }]
export function missing(c, reqs) {
  const lv = new Map(c.have);
  const out = [];
  const walk = (s, L, depth) => {
    const info = skillInfo(c.data, s);
    if (!info || depth > 25 || L <= 0 || (lv.get(s) || 0) >= L) return;
    for (const [p, pl] of info.t.skills) walk(p, pl, depth + 1);
    for (let l = (lv.get(s) || 0) + 1; l <= L; l++) {
      // 第一级扣掉已有的部分进度
      const from = l === (c.have.get(s) || 0) + 1 ? Math.max(spForLevel(info.rank, l - 1), c.sp.get(s) || 0) : spForLevel(info.rank, l - 1);
      out.push({ skill: s, level: l, sp: Math.max(0, spForLevel(info.rank, l) - from), pri: info.pri, sec: info.sec });
      lv.set(s, l);
    }
  };
  for (const [s, L] of reqs) walk(s, L, 0);
  return out;
}
const minutes = (entries, a) => entries.reduce((m, e) => m + e.sp / (a[e.pri] + a[e.sec] / 2), 0);
// 最优属性重置：主属性 27、副属性 21、其余 17（共 99 点），取用时最短的组合
export function bestRemap(entries) {
  const keys = Object.keys(DEFAULT_ATTRS);
  let best = null;
  for (const p of keys) for (const s of keys) {
    if (p === s) continue;
    const a = Object.fromEntries(keys.map((k) => [k, k === p ? 27 : k === s ? 21 : 17]));
    const m = minutes(entries, a);
    if (!best || m < best.min) best = { min: m, pri: p, sec: s };
  }
  return best;
}
export const defaultMinutes = (entries) => minutes(entries, DEFAULT_ATTRS);

// 每艘可在市场买到的舰船：还差多少分钟（默认属性）
function ships(c) {
  if (c.shipsCache) return c.shipsCache;
  const out = [];
  for (const t of c.data.types.values()) {
    if (t.category !== 6 || !t.market) continue;
    const m = missing(c, t.skills);
    out.push({ t, entries: m, min: defaultMinutes(m) });
  }
  c.shipsCache = out;
  return out;
}

export function profile(c) {
  const data = c.data;
  const list = ships(c);
  const fly = list.filter((s) => !s.entries.length);
  const byGroup = new Map();
  for (const s of fly) { if (!byGroup.has(s.t.group)) byGroup.set(s.t.group, []); byGroup.get(s.t.group).push(s.t); }
  // 技能组技能点
  const groupSp = new Map();
  for (const [id, p] of c.sp) {
    const t = data.types.get(id);
    if (!t || !p) continue;
    groupSp.set(t.group, (groupSp.get(t.group) || 0) + p);
  }
  const pick = (opts) => opts.map(([g, name]) => [name, groupSp.get(g) || 0]).sort((a, b) => b[1] - a[1]);
  const weapon = pick(FOCUS.weapon), tank = pick(FOCUS.tank);
  // 种族：船体技能（如 Amarr Battleship）的技能点
  const race = new Map();
  for (const [id, p] of c.sp) {
    const m = RACE_RE.exec(data.types.get(id)?.en || '');
    if (m && p) race.set(m[1], (race.get(m[1]) || 0) + p);
  }
  const races = [...race].sort((a, b) => b[1] - a[1]).filter(([, p]) => p >= 1e6).map(([en, p]) => [RACES.find(([e]) => e === en)?.[1] || en, p]);
  const roles = ROLE_GROUPS.map(([name, gs]) => [name, gs.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)])]);
  // 接近可开：旗舰 / 特种 / 工业船级里 30 天内能练好的
  const notable = new Set(ROLE_GROUPS.flatMap(([, g]) => g));
  const seen = new Set();   // 每个船级只列最快的一艘
  const near = list.filter((s) => s.entries.length && notable.has(s.t.group) && s.min < 30 * 1440).sort((a, b) => a.min - b.min)
    .filter((s) => !seen.has(s.t.group) && seen.add(s.t.group)).slice(0, 12);
  return { fly, byGroup, groupSp, weapon, tank, races, roles, near };
}

// 一句话定位
// 英文界面直接生成英文句子（i18n 只按整段文字匹配，拼出来的中文句子翻不好；船级名会被名称表译成英文）
const EN_UI = /^en/i.test(document.documentElement.lang);
const EN_WEAPON = { '射击学（炮台）': 'gunnery', '导弹': 'missiles', '无人机': 'drones', '护盾': 'shield', '装甲': 'armor' };
const EN_RACE = Object.fromEntries(RACES.map(([en, zh]) => [zh, en]));
function summary(c, p) {
  const parts = [];
  const [caps, spec, ind] = p.roles.map(([, list]) => list.map(([g]) => groupName(c, g)));
  const [w1, w2] = p.weapon, [t1, t2] = p.tank;
  const races = p.races.slice(0, 2).map(([n]) => n);
  if (EN_UI) {
    if (caps.length) parts.push('capital pilot (' + caps.join(', ') + ')');
    if (spec.length) parts.push(`flies ${spec.length} specialized ship classes`);
    if (ind.length) parts.push('industry / transport (' + ind.join(', ') + ')');
    if (w1[1] > 2e6) parts.push('mainly ' + EN_WEAPON[w1[0]] + (w2[1] > w1[1] * 0.7 ? ' and ' + EN_WEAPON[w2[0]] : ''));
    if (t1[1] > 2e6) parts.push(t2[1] > t1[1] * 0.7 ? 'shield and armor tanking' : EN_WEAPON[t1[0]] + ' tanking');
    if (races.length) parts.push('leans ' + races.map((n) => EN_RACE[n] || n).join(' / '));
    const out = parts.join(', ') || 'few skills, mostly basics';
    return out[0].toUpperCase() + out.slice(1);
  }
  if (caps.length) parts.push('旗舰驾驶员（' + caps.join('、') + '）');
  if (spec.length) parts.push('可开 ' + spec.length + ' 类特种舰');
  if (ind.length) parts.push('工业 / 运输（' + ind.join('、') + '）');
  if (w1[1] > 2e6) parts.push('主修' + w1[0] + (w2[1] > w1[1] * 0.7 ? '、' + w2[0] : ''));
  if (t1[1] > 2e6) parts.push(t2[1] > t1[1] * 0.7 ? '护盾 / 装甲都练过' : t1[0] + '坦克');
  if (races.length) parts.push('偏' + races.join(' / '));
  return parts.join('，') || '技能较少，主要是基础技能';
}
const groupName = (c, g) => c.data.groups.get(g)?.name || '船级 ' + g;

// ---------- 显示 ----------
export function dur(min) {
  if (min < 1) return '已满足';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = Math.round(min % 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
const spM = (sp) => (sp < 1e5 ? fmtNum(Math.round(sp)) : (sp / 1e6).toFixed(sp >= 1e8 ? 0 : 1) + 'M');

export function analysisHtml(c, r, author, tab, picker = '') {
  const p = profile(c);
  const nameOk = !author || !r.name || r.name.toLowerCase() === author.toLowerCase();
  const eq = equipment(c);
  const trained = [...c.have.values()].filter((l) => l > 0).length;
  const tabs = [['role', '角色定位'], ['skills', `全部技能 ${trained}`], ['ships', `可开舰船 ${p.fly.length}`], ['equip', `可用装备 ${eq.ok}`], ['train', '开船耗时']];
  return `<div class="pi-card bz-ana">
    <div class="bz-ana-head"><h3>技能分析</h3>${picker}
      <div class="segmented" role="tablist">${tabs.map(([k, l]) => `<button type="button" data-bz-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="toolbar-spacer"></span>
      <small class="text-muted">数据来自 ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source || 'qsna.eu')}</a>` : esc(r.source)} · <span translate="no">${esc(r.name)}</span> · ${spM(c.total)} SP${r.updated_at ? ' · 更新于 ' + new Date(r.updated_at).toLocaleDateString('zh-CN') : ''}</small></div>
    ${nameOk ? '' : `<p class="bz-warn">技能展示的角色（<span translate="no">${esc(r.name)}</span>）与发帖人（<span translate="no">${esc(author)}</span>）不一致，请向卖家确认。</p>`}
    <div class="bz-ana-body">${tab === 'skills' ? skillsHtml(c) : tab === 'ships' ? shipsHtml(c, p) : tab === 'train' ? trainHtml(c) : tab === 'equip' ? equipHtml(c) : roleHtml(c, p)}</div>
  </div>`;
}

function roleHtml(c, p) {
  const groups = [...p.groupSp].map(([g, sp]) => [groupName(c, g), sp]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = groups[0]?.[1] || 1;
  const chips = (list) => list.map(([g, ts]) => `<span class="bz-chip" title="${esc(ts.map((t) => t.name).join('、'))}">${esc(groupName(c, g))}<b>${ts.length}</b></span>`).join('');
  return `<p class="bz-summary">${esc(summary(c, p))}</p>
    <div class="bz-role-grid">
      <div>${p.roles.map(([name, list]) => `<div class="bz-role"><h4>${name}</h4>${list.length ? `<div class="bz-chips">${chips(list)}</div>` : '<p class="text-muted">无</p>'}</div>`).join('')}
        <div class="bz-role"><h4>武器 / 坦克（技能点）</h4><div class="bz-chips">${[...p.weapon, ...p.tank].map(([n, sp]) => `<span class="bz-chip">${n}<b>${spM(sp)}</b></span>`).join('')}</div></div>
        <div class="bz-role"><h4>主力种族（船体技能点）</h4>${p.races.length ? `<div class="bz-chips">${p.races.slice(0, 5).map(([n, sp]) => `<span class="bz-chip">${n}<b>${spM(sp)}</b></span>`).join('')}</div>` : '<p class="text-muted">无</p>'}</div>
      </div>
      <div class="bz-role"><h4>技能组分布</h4>${groups.map(([n, sp]) => `<div class="bz-bar"><span>${esc(n)}</span><i><b style="width:${(sp / max * 100).toFixed(1)}%"></b></i><small>${spM(sp)}</small></div>`).join('')}</div>
    </div>
    ${p.near.length ? `<div class="bz-role"><h4>差一点就能开（30 天内，默认属性）</h4><div class="bz-chips">${p.near.map((s) => `<button type="button" class="bz-chip is-btn" data-bz-train="${s.t.id}" title="${esc(groupName(c, s.t.group))}">${esc(s.t.name)}<small>${esc(groupName(c, s.t.group))}</small><b>${dur(s.min)}</b></button>`).join('')}</div></div>` : ''}`;
}

let shipOnly = true;   // 可开舰船：只显示能开的（取消后列出全部舰船，不能开的灰显并提示还差多久）
function shipsHtml(c, p) {
  const tools = `<div class="bz-eq-tools"><label class="bz-check"><input type="checkbox" data-bz-ship-only${shipOnly ? ' checked' : ''}>只显示能开的</label></div>`;
  const byGroup = new Map();
  for (const s of shipOnly ? ships(c).filter((x) => !x.entries.length) : ships(c)) {
    if (!byGroup.has(s.t.group)) byGroup.set(s.t.group, []);
    byGroup.get(s.t.group).push(s);
  }
  const gs = [...byGroup.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || groupName(c, a).localeCompare(groupName(c, b), 'zh-CN');
  });
  if (!gs.length) return tools + '<p class="text-muted">按卖家的技能，没有能开的舰船。</p>';
  return tools + `<div class="bz-ship-groups">${gs.map((g) => {
    const list = byGroup.get(g), ok = list.filter((s) => !s.entries.length).length;
    return `<div class="bz-ship-group"><h4>${esc(groupName(c, g))}<small>${shipOnly ? ok : `${ok} / ${list.length}`}</small></h4>
    <div class="bz-ships">${list.sort((a, b) => (a.entries.length > 0) - (b.entries.length > 0) || a.t.name.localeCompare(b.t.name, 'zh-CN')).map((s) => {
      return `<span class="${s.entries.length ? 'is-no' : ''}" data-bz-type="${s.t.id}"><img src="${ICON(s.t.id)}" alt="" width="20" height="20" loading="lazy">${esc(s.t.name)}</span>`;
    }).join('')}</div></div>`;
  }).join('')}</div>`;
}

let trainShip = null;
export function setTrainShip(id) { trainShip = id; }
function trainHtml(c) {
  const t = trainShip && c.data.types.get(trainShip);
  const opts = ships(c).map((s) => s.t).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const picker = `<div class="bz-train-pick"><input class="input" list="bzShipList" data-bz-ship placeholder="输入舰船名（中英文都可以）" value="${t ? esc(t.name) : ''}" autocomplete="off">
    <datalist id="bzShipList">${opts.map((s) => `<option value="${esc(s.name)}">${esc(s.en || '')}</option>`).join('')}</datalist></div>`;
  if (!t) return picker + '<p class="text-muted">选择一艘船，计算这个角色还要练哪些技能、要多久。「角色定位」里的「差一点就能开」可以直接点。</p>';
  const entries = missing(c, t.skills);
  if (!entries.length) return picker + `<p class="bz-ok">已经可以驾驶 ${esc(t.name)}。</p>`;
  const def = defaultMinutes(entries), best = bestRemap(entries);
  const NAMES = { cha: '魅力', int: '智力', mem: '记忆', per: '感知', wil: '毅力' };
  const sp = entries.reduce((a, e) => a + e.sp, 0);
  return picker + `<div class="bz-train-sum">
      <div><span>还差技能点</span><b>${spM(sp)}</b></div>
      <div><span>默认属性</span><b>${dur(def)}</b></div>
      <div title="主属性 27、副属性 21、其余 17"><span>最优属性重置（${NAMES[best.pri]} / ${NAMES[best.sec]}）</span><b>${dur(best.min)}</b></div>
      <div title="大型技能注入器：总技能点 5000 万以下每支 50 万，之后递减"><span>约等于大型注入器</span><b>${Math.ceil(sp / injectorSp(c.total))} 支</b></div>
    </div>
    <table class="bz-train-table"><thead><tr><th>技能</th><th>等级</th><th>技能点</th><th>默认属性用时</th></tr></thead><tbody>
    ${entries.map((e) => { const s = c.data.types.get(e.skill); return `<tr><td>${esc(s?.name || e.skill)}</td><td>${ROMAN[e.level - 1]} → ${ROMAN[e.level]}</td><td>${fmtNum(e.sp)}</td><td>${dur(defaultMinutes([e]))}</td></tr>`; }).join('')}
    </tbody></table>
    <p class="text-muted bz-note">卖家的属性与植入体不公开：「默认属性」按新角色属性（各 20，魅力 19）且不带植入体计算，实际通常更快。</p>`;
}
// 大型技能注入器每支给的技能点：总技能点 5000 万以下 50 万，8000 万以下 40 万，1.5 亿以下 30 万，以上 15 万
function injectorSp(total) {
  return total < 5e7 ? 5e5 : total < 8e7 ? 4e5 : total < 1.5e8 ? 3e5 : 1.5e5;
}
// 舰船名：先精确匹配（中英文），loose 时再找名字以输入开头 / 包含输入的，取名字最短的
export function shipByName(c, name, loose = false) {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const t = c.data.byName.get(q);
  if (t && t.category === 6) return t;
  if (!loose) return null;
  const hits = ships(c).map((s) => s.t).map((s) => [s, s.name.toLowerCase(), (s.en || '').toLowerCase()])
    .filter(([, n, en]) => n.includes(q) || en.includes(q))
    .sort((a, b) => (b[1].startsWith(q) || b[2].startsWith(q)) - (a[1].startsWith(q) || a[2].startsWith(q)) || a[1].length - b[1].length);
  return hits[0]?.[0] || null;
}

// ---------- 可用装备 ----------
const EQ_CATS = [[7, '装备'], [18, '无人机'], [87, '舰载机'], [32, '子系统'], [8, '弹药'], [20, '植入体']];
const META = { 2: 'T2', 3: '故事线', 4: '势力', 5: '官员', 6: '死亡空间', 14: 'T3' };
const typeOk = (have, t) => t.skills.every(([s, l]) => (have.get(s) || 0) >= l);
function equipment(c) {
  if (c.eqCache) return c.eqCache;
  const groups = new Map();
  let total = 0, ok = 0, t2 = 0, t2ok = 0;
  for (const t of c.data.types.values()) {
    if (!t.market || !t.skills.length || !EQ_CATS.some(([k]) => k === t.category)) continue;
    const yes = typeOk(c.have, t);
    if (!groups.has(t.group)) groups.set(t.group, { g: t.group, cat: t.category, items: [], ok: 0 });
    const g = groups.get(t.group);
    g.items.push({ t, ok: yes });
    g.ok += yes; total++; ok += yes;
    if (t.meta === 2) { t2++; t2ok += yes; }
  }
  const order = EQ_CATS.map(([k]) => k);
  const list = [...groups.values()].sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || b.ok - a.ok || groupName(c, a.g).localeCompare(groupName(c, b.g), 'zh-CN'));
  for (const g of list) g.items.sort((a, b) => b.ok - a.ok || (a.t.meta || 0) - (b.t.meta || 0) || a.t.name.localeCompare(b.t.name, 'zh-CN'));
  c.eqCache = { list, total, ok, t2, t2ok };
  return c.eqCache;
}
let eqQ = '', eqAll = false;
export function setEqQuery(q) { eqQ = q.trim().toLowerCase(); }
export function setEqAll(on) { eqAll = on; }
function equipHtml(c) {
  const e = equipment(c);
  const cats = EQ_CATS.map(([k, n]) => { const gs = e.list.filter((g) => g.cat === k); return [n, gs.reduce((a, g) => a + g.ok, 0), gs.reduce((a, g) => a + g.items.length, 0)]; }).filter(([, , n]) => n);
  return `<div class="bz-train-sum">
      <div><span>能用的装备</span><b>${fmtNum(e.ok)} / ${fmtNum(e.total)}</b></div>
      <div><span>能用的 T2 装备</span><b>${fmtNum(e.t2ok)} / ${fmtNum(e.t2)}</b></div>
      ${cats.map(([n, a, b]) => `<div><span>${n}</span><b>${fmtNum(a)} / ${fmtNum(b)}</b></div>`).join('')}
    </div>
    <div class="bz-eq-tools"><input class="input" type="search" data-bz-eq placeholder="搜索装备（中英文都可以）" value="${esc(eqQ)}" autocomplete="off">
      <label class="bz-check"><input type="checkbox" data-bz-eq-only${eqAll ? '' : ' checked'}>只显示能用的</label></div>
    <div id="bzEqList">${equipListHtml(c)}</div>
    <p class="text-muted bz-note">只列出市场上能买到、并且需要技能的物品；按技能等级判断，不考虑舰船限制。</p>`;
}
export function equipListHtml(c) {
  const e = equipment(c);
  const q = eqQ;
  let shown = 0;
  const html = e.list.map((g) => {
    const gname = groupName(c, g.g);
    const hitGroup = q && gname.toLowerCase().includes(q);
    const items = g.items.filter((x) => (eqAll || x.ok) && (!q || hitGroup || x.t.name.toLowerCase().includes(q) || (x.t.en || '').toLowerCase().includes(q)));
    if (!items.length) return '';
    shown += items.length;
    const cat = EQ_CATS.find(([k]) => k === g.cat)?.[1] || '';
    return `<details class="bz-eq-group"${q ? ' open' : ''}><summary><b>${esc(gname)}</b><small class="text-muted">${cat}</small><span class="toolbar-spacer"></span><small class="${g.ok ? 'up' : 'text-muted'}">${g.ok} / ${g.items.length}</small></summary>
      <div class="bz-ships">${items.slice(0, 300).map((x) => {
        return `<span class="${x.ok ? '' : 'is-no'}" data-bz-type="${x.t.id}"><img src="${ICON(x.t.id)}" alt="" width="20" height="20" loading="lazy">${esc(x.t.name)}${META[x.t.meta] ? `<em class="bz-meta m${x.t.meta}">${META[x.t.meta]}</em>` : ''}</span>`;
      }).join('')}</div></details>`;
  }).join('');
  return shown ? html : '<p class="text-muted">没有符合的装备。</p>';
}
// ---------- 全部技能 ----------
let SKD = null, skQ = '', skF = 'all', skSort = 'name', anaRerender = null;
const skGSort = new Map(), skOpenG = new Set();   // 各技能组单独的排序、展开的技能组
const ATTR_ZH = { 164: '魅力', 165: '智力', 166: '记忆', 167: '感知', 168: '毅力' };
const ATTR_DEF = { 164: 19, 165: 20, 166: 20, 167: 20, 168: 20 };
function skillsHtml(c) {
  if (!SKD) {
    loadSkillData().then((d) => { SKD = d; anaRerender?.(); }).catch(() => {});
    return '<p class="text-muted">正在加载技能列表…</p>';
  }
  const all = Object.values(SKD.skills).length;
  const five = [...c.have.values()].filter((l) => l === 5).length;
  const trained = [...c.have.values()].filter((l) => l > 0).length;
  return `<div class="bz-train-sum">
      <div><span>总技能点</span><b>${spM(c.total)}</b></div>
      <div><span>已学技能</span><b>${fmtNum(trained)} / ${fmtNum(all)}</b></div>
      <div><span>V 级技能</span><b>${fmtNum(five)}</b></div>
    </div>
    <div class="skl-toolbar bz-sk-tools">
      <div class="search-box sk-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-bz-sk placeholder="搜索技能或技能组（中英文）" value="${esc(skQ)}" autocomplete="off" spellcheck="false">
      </div>
      <label class="bz-check"><input type="checkbox" data-bz-sk-trained${skF === 'trained' ? ' checked' : ''}>只显示已训练</label>
      <div class="segmented" role="group" title="技能组和组内技能的排序">${[['name', '按名称'], ['sp', '按技能点']].map(([k, l]) => `<button type="button" data-bz-sk-sort="${k}" class="${skSort === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <button type="button" class="link-btn" data-bz-sk-all="1">全部展开</button><button type="button" class="link-btn" data-bz-sk-all="0">全部收起</button>
    </div>
    <div id="bzSkList" class="sk-groups">${skillListHtml(c)}</div>
    ${c.estimated ? '<p class="text-muted bz-note">这个来源只给技能等级，技能点按等级推算。</p>' : ''}`;
}
export function skillListHtml(c) {
  if (!SKD) return '';
  const q = skQ;
  const match = (s, lv) => (skF !== 'trained' || lv) && (skF !== 'untrained' || !lv) && (skF !== 'partial' || (lv && lv < 5));
  // 按技能点排序：技能点多的在前（同技能点按训练倍数、名称），一眼看出 V 级与最费技能点的技能
  const bySp = (a, b) => b.sp - a.sp || b.rank - a.rank || a.name.localeCompare(b.name, 'zh');
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  const groups = Object.entries(SKD.groups).map(([gid, gname]) => {
    const list = Object.entries(SKD.skills).filter(([, s]) => s[2] === Number(gid))
      .map(([id, s]) => ({ id: Number(id), name: s[0], en: s[1], rank: s[3], pri: s[4], sec: s[5], desc: s[6], lv: c.have.get(Number(id)) || 0, sp: c.sp.get(Number(id)) || 0 }));
    return { gid: Number(gid), gname, list, sp: list.reduce((t, s) => t + s.sp, 0) };
  });
  if (skSort === 'sp') groups.sort((a, b) => b.sp - a.sp || a.gname.localeCompare(b.gname, 'zh'));
  const html = groups.map(({ gid, gname, list, sp }) => {
    const sort = skGSort.get(gid) || skSort;
    const hitGroup = q && (gname.toLowerCase().includes(q));
    const shown = list.filter((s) => match(s, s.lv) && (!q || hitGroup || s.name.toLowerCase().includes(q) || (s.en || '').toLowerCase().includes(q)))
      .sort(sort === 'sp' ? bySp : byName);
    if (!shown.length) return '';
    const levels = list.reduce((t, s) => t + s.lv, 0), got = list.filter((s) => s.lv).length, five = list.filter((s) => s.lv === 5).length;
    const tiles = shown.map((s) => {
      const rate = (ATTR_DEF[s.pri] || 20) + (ATTR_DEF[s.sec] || 20) / 2;
      const need = s.lv < 5 ? spForLevel(s.rank, s.lv + 1) - s.sp : 0;
      const title = `${s.desc || ''}\n\n主属性：${ATTR_ZH[s.pri] || '—'} · 副属性：${ATTR_ZH[s.sec] || '—'} · 训练倍数 ×${s.rank}` +
        (need > 0 ? `\n升到 ${ROMAN[s.lv + 1]} 级约 ${dur(need / rate)}（默认属性）` : '');
      return `<div class="bz-sk-tile${s.lv ? '' : ' untrained'}${s.lv === 5 ? ' is-v' : ''}" title="${esc(title)}">
        <span class="bz-sk-name">${esc(s.name)}</span>
        <span class="sk-boxes" aria-label="${s.lv} 级">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= s.lv ? 'on' : ''}"></i>`).join('')}</span>
        <small class="bz-sk-sp">${s.lv ? spM(s.sp) : '未学'}<span> · ×${s.rank}</span></small>
      </div>`;
    }).join('');
    const open = q || skOpenG.has(gid);
    return `<details class="sk-group" data-bz-gid="${gid}"${open ? ' open' : ''}>
      <summary><span class="sk-g-name">${esc(gname)}</span><span class="sk-g-count">${got} / ${list.length}${five ? ` · V ${five}` : ''}</span>
        <i class="sk-g-bar"><em style="width:${(levels / (list.length * 5) * 100).toFixed(1)}%"></em></i><span class="sk-g-sp">${fmtNum(Math.round(sp))} 技能点</span></summary>
      <div class="bz-sk-body"><div class="bz-sk-gsort">${[['name', '按名称'], ['sp', '按技能点']].map(([k, l]) => `<button type="button" class="link-btn${sort === k ? ' active' : ''}" data-bz-sk-gsort="${gid}:${k}">${l}</button>`).join('')}</div>
        <div class="bz-sk-grid">${tiles}</div></div></details>`;
  }).join('');
  return html || '<p class="text-muted">没有符合条件的技能。</p>';
}

// ---------- 悬停提示：舰船 / 装备需要的技能（含前置）、所需等级与角色当前等级 ----------
function reqTipHtml(c, t) {
  // 同一技能可能被多条前置要求，取最高等级
  const need = new Map();
  const all = (reqs, depth) => { for (const [s, L] of reqs) { if (depth > 12 || (need.get(s) || 0) >= L) continue; need.set(s, L); all(c.data.types.get(s)?.skills || [], depth + 1); } };
  all(t.skills, 0);
  const rows = [], seen = new Set();
  const walk = (reqs, depth) => {
    for (const [s] of reqs) {
      if (seen.has(s) || depth > 12) continue;
      seen.add(s);
      const L = need.get(s), have = c.have.get(s) || 0;
      rows.push({ s, L, depth, have });
      const info = c.data.types.get(s);
      if (info && have < L) walk(info.skills, depth + 1);   // 已满足的技能，前置一定也满足，不再展开
    }
  };
  walk(t.skills, 0);
  const m = missing(c, t.skills);
  const sp = m.reduce((a, e) => a + e.sp, 0);
  return `<div class="fit-mtip-head"><img src="${ICON(t.id)}" alt="" width="32" height="32"><div><b>${esc(t.name)}</b>${t.en && t.en !== t.name ? `<small class="bz-tip-en" translate="no">${esc(t.en)}</small>` : ''}</div></div>
    ${rows.length ? `<div class="bz-tip-rows">${rows.map((r) => `<div class="bz-tip-row${r.have >= r.L ? ' ok' : ' no'}" style="padding-left:${r.depth * 12}px">
      <span>${esc(c.data.types.get(r.s)?.name || '技能 ' + r.s)}</span><b>${ROMAN[r.L]}</b><small>${r.have >= r.L ? '✓' : r.have ? '当前 ' + ROMAN[r.have] : '未学'}</small></div>`).join('')}</div>` : '<p class="text-muted">不需要技能</p>'}
    <div class="bz-tip-foot ${m.length ? 'no' : 'ok'}">${m.length ? `还差 ${spM(sp)} 技能点 · 约 ${dur(defaultMinutes(m))}（默认属性）` : '技能已满足'}</div>`;
}
let tipEl = null;
function placeTip(e) {
  const r = tipEl.getBoundingClientRect(), pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = Math.max(8, e.clientX - pad - r.width);
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - 8 - r.height);
  tipEl.style.transform = `translate(${x}px, ${y}px)`;
}
function bindTip(root, getChar) {
  let cur = null;
  root.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-bz-type]');
    if (!el) { if (cur && !cur.isConnected) { cur = null; tipEl.hidden = true; } return; }   // 列表重画后原来的格子没了，不会触发 mouseout
    if (el === cur) return;
    const c = getChar(), t = c && c.data.types.get(Number(el.dataset.bzType));
    if (!t) return;
    cur = el;
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'fit-mtip bz-tip'; document.body.appendChild(tipEl); }
    tipEl.innerHTML = reqTipHtml(c, t);
    tipEl.hidden = false;
    placeTip(e);
  });
  root.addEventListener('mousemove', (e) => { if (cur && tipEl && !tipEl.hidden) placeTip(e); });
  root.addEventListener('mouseout', (e) => {
    if (!cur || cur.contains(e.relatedTarget)) return;
    cur = null;
    if (tipEl) tipEl.hidden = true;
  });
}

// 技能分析里的输入控件（开船耗时的舰船、装备搜索、显示不能用的）：getChar() 返回当前角色，rerender() 重画技能分析
export function bindAna(root, getChar, rerender, warn) {
  anaRerender = rerender;
  bindTip(root, getChar);
  const skList = () => { const c = getChar(), box = document.getElementById('bzSkList'); if (c && box) box.innerHTML = skillListHtml(c); };
  let skT = 0;
  root.addEventListener('input', (e) => {
    if (!e.target.matches('[data-bz-sk]')) return;
    skQ = e.target.value.trim().toLowerCase();
    clearTimeout(skT);
    skT = setTimeout(skList, 150);
  });
  root.addEventListener('click', (e) => {
    const so = e.target.closest('[data-bz-sk-sort]');
    if (so) {
      skSort = so.dataset.bzSkSort;
      skGSort.clear();
      so.parentElement.querySelectorAll('[data-bz-sk-sort]').forEach((b) => b.classList.toggle('active', b === so));
      skList();
      return;
    }
    const gs = e.target.closest('[data-bz-sk-gsort]');
    if (gs) {
      const [gid, k] = gs.dataset.bzSkGsort.split(':');
      skGSort.set(Number(gid), k);
      skList();
      return;
    }
    const a = e.target.closest('[data-bz-sk-all]');
    if (a) {
      const open = a.dataset.bzSkAll === '1';
      skOpenG.clear();
      if (open && SKD) Object.keys(SKD.groups).forEach((g) => skOpenG.add(Number(g)));
      document.querySelectorAll('#bzSkList .sk-group').forEach((d) => { d.open = open; });
    }
  });
  // 记住展开的技能组（排序、筛选重画后保持）；搜索时全部展开，不记
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('#bzSkList .sk-group') || skQ) return;
    const gid = Number(d.dataset.bzGid);
    if (d.open) skOpenG.add(gid); else skOpenG.delete(gid);
  }, true);
  // 舰船：从候选里点选（input 事件，名字完全一致）立即计算；回车 / 离开输入框（change）时名字不完整也找最接近的
  root.addEventListener('input', (e) => {
    if (!e.target.matches('[data-bz-ship]')) return;
    const c = getChar(), ship = c && shipByName(c, e.target.value);
    if (ship && ship.id !== trainShip) { setTrainShip(ship.id); rerender(); }
  });
  root.addEventListener('change', (e) => {
    if (!e.target.matches('[data-bz-ship]') || !e.target.value.trim()) return;
    const c = getChar(), ship = c && shipByName(c, e.target.value, true);
    if (!ship) { warn('没有找到这艘船'); return; }
    if (ship.id !== trainShip || e.target.value !== ship.name) { setTrainShip(ship.id); rerender(); }
  });
  root.addEventListener('input', (e) => {
    if (!e.target.matches('[data-bz-eq]')) return;
    const c = getChar(), box = document.getElementById('bzEqList');
    if (!c || !box) return;
    setEqQuery(e.target.value);
    box.innerHTML = equipListHtml(c);
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-bz-sk-trained]')) { skF = e.target.checked ? 'trained' : 'all'; skList(); return; }
    if (e.target.matches('[data-bz-ship-only]')) { shipOnly = e.target.checked; rerender(); return; }
    if (!e.target.matches('[data-bz-eq-only]')) return;
    const c = getChar(), box = document.getElementById('bzEqList');
    setEqAll(!e.target.checked);
    if (c && box) box.innerHTML = equipListHtml(c);
  });
}

// ---------- 列表筛选：技能要求 ----------
// 条件：{ k: 'type', id, n }（能开这艘船 / 能用这件装备）、{ k: 'group', id, n }（能开这个船级的任意一艘）、{ k: 'skill', id, lv, n }
// n 是显示用的文字，装配数据没加载时侧边栏也能显示
export const parseSkills = (str) => new Map((str || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number)));
const groupShips = new Map();
function shipsOfGroup(data, g) {
  if (!groupShips.has(g)) groupShips.set(g, [...data.types.values()].filter((t) => t.group === g && t.category === 6 && t.market));
  return groupShips.get(g);
}
export function meets(data, have, reqs) {
  return reqs.every((r) => {
    if (r.k === 'skill') return (have.get(r.id) || 0) >= r.lv;
    if (r.k === 'group') return shipsOfGroup(data, r.id).some((t) => typeOk(have, t));
    const t = data.types.get(r.id);
    return !!t && typeOk(have, t);
  });
}
const PRESETS = [[30, '泰坦'], [659, '超级航母'], [485, '无畏舰'], [547, '航空母舰'], [1538, '战力辅助舰'], [898, '黑隐特勤舰'], [900, '掠夺舰'], [883, '旗舰级工业舰'], [941, '工业指挥舰'], [543, '采掘者']];
export function needHtml(reqs, note) {
  return `<div class="ind-side-section bz-side-form bz-need">
      <h4>技能要求${reqs.length ? `<button class="link-btn" data-bz-need-clear>清空</button>` : ''}</h4>
      ${reqs.length ? `<div class="bz-chips">${reqs.map((r, i) => `<span class="bz-chip">${esc(r.n)}<button type="button" data-bz-need-del="${i}" aria-label="移除" title="移除">×</button></span>`).join('')}</div>` : ''}
      <input class="input" list="bzNeedList" data-bz-need placeholder="能开的船 / 能用的装备 / 船级" autocomplete="off" aria-label="能开的船或能用的装备"><datalist id="bzNeedList"></datalist>
      <div class="bz-need-skill"><input class="input" list="bzNeedSkills" data-bz-need-skill placeholder="技能名" autocomplete="off" aria-label="技能"><datalist id="bzNeedSkills"></datalist>
        <select class="input" data-bz-need-lv aria-label="等级">${[1, 2, 3, 4, 5].map((l) => `<option value="${l}"${l === 5 ? ' selected' : ''}>${ROMAN[l]}</option>`).join('')}</select>
        <button type="button" class="btn btn-sm" data-bz-need-add>添加</button></div>
      <div class="bz-chips bz-need-presets">${PRESETS.filter(([g]) => !reqs.some((r) => r.k === 'group' && r.id === g)).map(([g, n]) => `<button type="button" class="bz-chip is-btn" data-bz-need-group="${g}">${n}</button>`).join('')}</div>
      ${note ? `<p class="bz-side-note">${note}</p>` : ''}
    </div>`;
}
// 侧边栏筛选控件的事件：opts = { get() 当前条件, set(条件), data() Promise<装配数据> }
export function bindNeed(root, opts) {
  const add = (r) => { if (!opts.get().some((x) => x.k === r.k && x.id === r.id)) opts.set([...opts.get(), r]); else if (r.k === 'skill') opts.set(opts.get().map((x) => (x.k === 'skill' && x.id === r.id ? r : x))); };
  root.addEventListener('input', async (e) => {
    const el = e.target;
    if (!el.matches('[data-bz-need]')) return;
    el.setCustomValidity('');
    const q = el.value.trim().toLowerCase();
    if (!q || q.startsWith('船级：')) return;
    const data = await opts.data();
    const hits = [];
    for (const g of data.groups.values()) if (g.category === 6 && g.name.toLowerCase().includes(q) && shipsOfGroup(data, g.id).length) hits.push([0, '船级：' + g.name, '能开任一艘']);
    for (const t of data.types.values()) {
      if (!t.market || !t.skills.length || (t.category !== 6 && !EQ_CATS.some(([k]) => k === t.category))) continue;
      const name = t.name.toLowerCase(), en = (t.en || '').toLowerCase();
      if (name.includes(q) || en.includes(q)) hits.push([name.startsWith(q) || en.startsWith(q) ? 1 : 2, t.name, (t.category === 6 ? '舰船 · ' : '') + (t.en || '')]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
    const list = document.getElementById('bzNeedList');
    if (list) list.innerHTML = hits.slice(0, 40).map(([, v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  });
  root.addEventListener('focusin', async (e) => {
    if (!e.target.matches('[data-bz-need-skill]')) return;
    const list = document.getElementById('bzNeedSkills');
    if (!list || list.children.length) return;
    const data = await opts.data();
    list.innerHTML = data.skills.filter((t) => t.market).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((t) => `<option value="${esc(t.name)}">${esc(t.en || '')}</option>`).join('');
  });
  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.matches('[data-bz-need]') || !el.value.trim()) return;
    const data = await opts.data();
    const v = el.value.trim();
    if (v.startsWith('船级：')) {
      const g = [...data.groups.values()].find((x) => x.category === 6 && x.name === v.slice(3));
      if (g) { add({ k: 'group', id: g.id, n: '能开任一' + g.name }); return; }
    }
    const t = data.byName.get(v.toLowerCase());
    if (t && t.skills.length && t.category !== 16) { add({ k: 'type', id: t.id, n: (t.category === 6 ? '能开 ' : '能用 ') + t.name }); return; }
    el.setCustomValidity('没有找到这艘船或这件装备');
    el.reportValidity();
  });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const del = t.closest('[data-bz-need-del]');
    if (del) { opts.set(opts.get().filter((_, i) => i !== Number(del.dataset.bzNeedDel))); return; }
    if (t.closest('[data-bz-need-clear]')) { opts.set([]); return; }
    const pre = t.closest('[data-bz-need-group]');
    if (pre) { add({ k: 'group', id: Number(pre.dataset.bzNeedGroup), n: '能开任一' + pre.textContent }); return; }
    if (!t.closest('[data-bz-need-add]')) return;
    const box = t.closest('.bz-need-skill');
    const input = box.querySelector('[data-bz-need-skill]');
    const data = await opts.data();
    const sk = data.byName.get(input.value.trim().toLowerCase());
    if (!sk || sk.category !== 16) { input.setCustomValidity('没有找到这个技能'); input.reportValidity(); input.addEventListener('input', () => input.setCustomValidity(''), { once: true }); return; }
    const lv = Number(box.querySelector('[data-bz-need-lv]').value);
    add({ k: 'skill', id: sk.id, lv, n: sk.name + ' ' + ROMAN[lv] });
  });
}
