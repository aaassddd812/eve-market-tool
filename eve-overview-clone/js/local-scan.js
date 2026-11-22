// ===== 本地分析（击杀记录 → 本地分析，#kb/local）：一个粘贴框，自动识别是频道成员名单还是定向扫描结果 =====
// 频道成员名单：游戏里在本地频道（或任意频道）的成员列表里 Ctrl+A、Ctrl+C，粘贴进来：
//   1. ESI /universe/ids/ 把名字换成角色 ID（每次最多 500 个），/characters/affiliation/ 查所属军团 / 联盟 / 势力（每次最多 1000 个）；
//   2. 宁静服再查本站击杀记录服务 /api/v1/pilots（每次最多 200 名）：近 30 天击杀 / 损失、单挑、平均同伙人数、常用船、常去星系、最近活跃；
//      按参与击杀时开的船的舰船分组判断角色定位（轻拦 / 重拦 / 火力 / 后勤 / 特种 / 旗舰，见 ROLES）；
//      「诱导」看最近 3 次损失的 ESI 原文里装没装诱导力场发生器（击杀记录里攻击者只有船型，看不到装配）；
//      最近一次击杀读 ESI 原文坐标找星系内最近的天体（「星系 · 星门（Jita）127 km」，本站 /api/kb/locate）；
//   3. 按联盟 / 军团统计人数，点一下可以隐藏（比如自己人），隐藏名单存在本浏览器。
//   4. 已绑定 ESI 且授权了联系人时，名字前显示声望（standings.js），并统计敌对 / 中立 / 友方人数；
//      勾选「按声望筛掉」后名单里不显示选中声望的人（默认同军团、同联盟），选择存在本浏览器。
// 国服没有公开击杀数据，只显示所属势力分布。
// 定向扫描结果：扫描窗口里 Ctrl+A、Ctrl+C，每行「类型 ID<Tab>名称<Tab>类型<Tab>距离」（旧客户端没有类型 ID，按类型名用 /universe/ids/ 查）。
//   类型所属的分组（舰船类别）与大类用 ESI /universe/types/、/universe/groups/ 查，缓存在本浏览器（eve-dscan-types-v1）；
//   统计舰船总数、同格（显示距离的）、按舰船类别 / 型号的数量，标出旗舰、拦截泡、后勤、隐轰、侦察、黑隐与扫描探针，建筑、无人机与其他单列；可复制一行统计发到舰队频道。
import * as ST from './standings.js?v=v6';

let D;   // esc, formatISK, formatNumber, resolveNames, esiUrl, eveImage, kb, loadTypes, systemName, typeName, fetchESI, copyText, nearest（killboard.js 的 nearestOf）
const IGNORE_KEY = 'eve-local-ignore-v1';
const MAX = 1000;
const S = { text: '', mode: '', pilots: [], orgs: new Map(), scan: null, status: '', sort: 'threat', ignore: new Set(), busy: false, at: null, box: null };
try { S.ignore = new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) || '[]')); } catch { /* 忽略 */ }
const saveIgnore = () => { try { localStorage.setItem(IGNORE_KEY, JSON.stringify([...S.ignore])); } catch { /* 忽略 */ } };
// 按声望筛掉：on 是否勾选，cls 要筛掉的声望（standings.js 的 of().cls；自己算同军团）
const STF_KEY = 'eve-local-stf-v1';
const STF = [['corp', '同军团'], ['alliance', '同联盟'], ['excellent', '优秀'], ['good', '良好'], ['neutral', '中立'], ['bad', '不良'], ['terrible', '恶劣']];
S.stf = { on: false, cls: new Set(['corp', 'alliance']) };
try { const v = JSON.parse(localStorage.getItem(STF_KEY) || 'null'); if (v) S.stf = { on: Boolean(v.on), cls: new Set(v.cls || []) }; } catch { /* 忽略 */ }
const saveStf = () => { try { localStorage.setItem(STF_KEY, JSON.stringify({ on: S.stf.on, cls: [...S.stf.cls] })); } catch { /* 忽略 */ } };

const esc = (s) => D.esc(s);
// 声望（已绑定角色的联系人，standings.js）
const entOf = (p) => ({ char: p.id, corp: p.corp, alliance: p.alliance });

async function postJson(path, body) {
  const res = await fetch(D.esiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ESI ${res.status}`);
  return res.json();
}

function parseNames(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // 频道成员列表复制出来是一行一个名字；聊天记录「[ 时间 ] 名字 > 内容」取名字
    let name = raw.replace(/^\s*\[[^\]]*\]\s*/, '').split(' > ')[0].trim();
    if (!name || name.length < 3 || name.length > 37) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX);
}

function setStatus(text) { S.status = text; const el = S.box?.querySelector('[data-ls-status]'); if (el) el.textContent = text; }

async function analyze(text) {
  if (S.busy) return;
  if (isDscan(text)) { analyzeDscan(text); return; }
  const names = parseNames(text);
  if (!names.length) { setStatus('没有识别到内容：粘贴频道成员列表或定向扫描结果'); return; }
  S.busy = true;
  S.text = text;
  S.mode = 'local';
  try {
    setStatus(`正在识别 ${names.length} 个名字…`);
    const chars = [];
    for (let i = 0; i < names.length; i += 500) {
      const d = await postJson('/universe/ids/', names.slice(i, i + 500));
      chars.push(...(d.characters || []));
    }
    if (!chars.length) { setStatus('这些名字都不是角色名'); S.pilots = []; draw(); return; }
    setStatus(`识别到 ${chars.length} 名角色，正在查所属军团 / 联盟…`);
    const aff = new Map();
    for (let i = 0; i < chars.length; i += 1000) {
      for (const a of await postJson('/characters/affiliation/', chars.slice(i, i + 1000).map((c) => c.id))) aff.set(a.character_id, a);
    }
    const orgIds = [...new Set([...aff.values()].flatMap((a) => [a.corporation_id, a.alliance_id]).filter(Boolean))];
    const { names: orgNames } = await D.resolveNames(orgIds);
    S.orgs = orgNames;
    S.pilots = chars.map((c) => ({ id: c.id, name: c.name, corp: aff.get(c.id)?.corporation_id || 0, alliance: aff.get(c.id)?.alliance_id || 0, faction: aff.get(c.id)?.faction_id || 0, st: null }));
    S.at = new Date();
    draw();
    if (D.kb) {
      for (let i = 0; i < S.pilots.length; i += 200) {
        setStatus(`正在查近 30 天击杀记录 ${Math.min(i + 200, S.pilots.length)} / ${S.pilots.length}…`);
        const part = S.pilots.slice(i, i + 200);
        const res = await fetch('/api/v1/pilots?ids=' + part.map((p) => p.id).join(',') + (D.server ? '&server=' + D.server : ''));
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error?.message || '击杀记录服务 ' + res.status);
        for (const p of part) p.st = d.pilots?.[p.id] || null;
      }
      const ships = [...new Set(S.pilots.flatMap((p) => (p.st?.ships || []).map(([t]) => t)))];
      if (ships.length) {
        setStatus(`正在识别 ${ships.length} 种舰船的分组…`);
        await Promise.all([D.loadTypes(ships.slice(0, 2000)), loadGroups(ships)]);
      }
    }
    setStatus('');
    draw();
    if (D.kb && D.nearest) locateLastKills();
  } catch (e) {
    setStatus('分析失败：' + e.message);
  } finally {
    S.busy = false;
    S.box?.querySelector('[data-ls-run]')?.removeAttribute('disabled');
  }
}


// ---------- 定向扫描 ----------
// 每行至少 3 列且末列像距离（数字 + 单位，或「-」）的行占多数时算定向扫描结果。
// 列之间是 Tab；从聊天窗口、网页转贴时 Tab 常变成多个空格，也认（名称里的单个空格不受影响）。国服客户端名称末尾带「*」，去掉
const DIST_RE = /^(-|[\d.,\s ]+\s*(m|km|au|米|千米|公里|天文单位|км|м|а\.?е\.?))$/i;
function scanRows(text) {
  const clean = (c) => c.trim().replace(/\*+$/, '').trim();
  return String(text).split(/\r?\n/).map((l) => (l.includes('\t') ? l.split('\t') : l.trim().split(/[ \u00a0\u3000]{2,}/)).map(clean))   // 有 Tab 按 Tab 分（名称为空时列不错位）
    .filter((c) => c.length >= 3);
}
function isDscan(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const rows = scanRows(text).filter((c) => DIST_RE.test(c[c.length - 1]));
  return rows.length > 0 && rows.length >= lines.length * 0.5;
}
// 距离换成公里（看不到距离时为 null）
function distKm(s) {
  const m = /([\d.,\s ]+)\s*(m|km|au|米|千米|公里|天文单位|км|м)/i.exec(s || '');
  if (!m) return null;
  const n = parseFloat(m[1].replace(/[\s ,]/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = m[2].toLowerCase();
  return u === 'au' || u === '天文单位' ? n * 1.496e8 : u === 'm' || u === '米' || u === 'м' ? n / 1000 : n;
}

// 类型 → 分组、分组 → 名称与大类：缓存在本浏览器（按界面语言）
const TYPE_KEY = 'eve-dscan-types-v1';
const LANG = window.I18N?.lang === 'en' ? 'en' : 'zh';
let TC = null;
function typeCache() {
  if (!TC) {
    try { TC = JSON.parse(localStorage.getItem(TYPE_KEY) || 'null'); } catch { TC = null; }
    if (!TC || TC.lang !== LANG) TC = { lang: LANG, t: {}, g: {} };   // t: { 类型ID: 分组ID }，g: { 分组ID: [名称, 大类ID] }
  }
  return TC;
}
const saveTypeCache = () => { try { localStorage.setItem(TYPE_KEY, JSON.stringify(TC)); } catch { /* 忽略 */ } };
async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}
async function loadGroups(typeIds) {
  const c = typeCache();
  await pool(typeIds.filter((id) => !c.t[id]), 8, async (id) => {
    try { c.t[id] = (await D.fetchESI(`/universe/types/${id}/?language=zh`)).group_id; } catch { /* 查不到算其他 */ }
  });
  const gids = [...new Set(typeIds.map((id) => c.t[id]).filter((g) => g && !c.g[g]))];
  await pool(gids, 8, async (g) => {
    try { const d = await D.fetchESI(`/universe/groups/${g}/?language=zh`); c.g[g] = [d.name, d.category_id]; } catch { /* 忽略 */ }
  });
  saveTypeCache();
}

// 大类：舰船 / 无人机与舰载机 / 建筑 / 可部署 / 其他（天体、残骸等）
const KIND = { 6: 'ship', 18: 'drone', 87: 'drone', 65: 'structure', 23: 'structure', 40: 'structure', 46: 'structure', 3: 'structure', 22: 'deploy' };
const KIND_ZH = { ship: '舰船', drone: '无人机 / 舰载机', structure: '建筑', deploy: '可部署', other: '天体与其他' };
// 需要注意的舰船分组（游戏分组 ID）与可部署的拦截泡
const WATCH = [
  ['旗舰', 'cap', [30, 659, 547, 485, 1538, 4594, 883, 902], 'Capitals'],
  ['拦截泡', 'bubble', [541, 894, 361], 'Bubbles'],
  ['后勤', 'logi', [832, 1527], 'Logistics'],
  ['隐轰', 'bomber', [834], 'Bombers'],
  ['侦察', 'recon', [833, 906], 'Recons'],
  ['黑隐', 'blops', [898], 'Black Ops'],
  ['探针', 'probe', [479], 'Probes']   // 扫描 / 作战扫描探针：有人在扫
];

async function analyzeDscan(text) {
  S.busy = true;
  S.text = text;
  S.mode = 'dscan';
  try {
    const rows = scanRows(text).filter((c) => DIST_RE.test(c[c.length - 1]));
    let items = rows.map((c) => (/^\d+$/.test(c[0]) && c.length >= 4
      ? { typeId: Number(c[0]), name: c[1], typeName: c[2], dist: distKm(c[3]) }
      : { typeId: 0, name: c[0], typeName: c[1], dist: distKm(c[2]) }));
    // 旧客户端没有类型 ID：按类型名查
    const noId = [...new Set(items.filter((x) => !x.typeId).map((x) => x.typeName))];
    if (noId.length) {
      setStatus(`正在识别 ${noId.length} 种类型…`);
      const byName = new Map();
      for (let i = 0; i < noId.length; i += 500) {
        const d = await postJson('/universe/ids/', noId.slice(i, i + 500));
        for (const t of d.inventory_types || []) byName.set(t.name.toLowerCase(), t.id);
      }
      items = items.map((x) => (x.typeId ? x : { ...x, typeId: byName.get(x.typeName.toLowerCase()) || 0 }));
    }
    const ids = [...new Set(items.map((x) => x.typeId).filter(Boolean))];
    setStatus(`正在查 ${ids.length} 种类型的分组…`);
    await Promise.all([loadGroups(ids), D.loadTypes(ids).catch(() => {})]);
    const c = typeCache();
    for (const x of items) {
      const g = c.t[x.typeId];
      x.group = g || 0;
      x.groupName = (g && c.g[g]?.[0]) || '';
      x.kind = KIND[g && c.g[g]?.[1]] || 'other';
    }
    S.scan = { items, at: new Date() };
    setStatus('');
  } catch (e) {
    setStatus('分析失败：' + e.message);
  } finally {
    S.busy = false;
    draw();
  }
}

const scanTypeName = (x) => { const n = x.typeId ? D.typeName(x.typeId) : ''; return n && !/^Type \d+$/.test(n) ? n : x.typeName; };
function countBy(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    const g = m.get(k) || { key: k, n: 0, first: x };
    g.n++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
function scanStats() {
  const items = S.scan.items;
  const ships = items.filter((x) => x.kind === 'ship');
  const classes = countBy(ships, (x) => x.groupName || x.typeName);
  const types = countBy(ships, (x) => x.typeId || x.typeName);
  const watch = WATCH.map(([label, cls, gs, en]) => ({ label, en, cls, n: items.filter((x) => gs.includes(x.group)).length })).filter((w) => w.n);
  const others = countBy(items.filter((x) => x.kind !== 'ship'), (x) => x.typeId || x.typeName);
  const byKind = Object.fromEntries(Object.keys(KIND_ZH).map((k) => [k, items.filter((x) => x.kind === k).length]));
  return { ships, classes, types, watch, others, byKind, grid: ships.filter((x) => x.dist != null).length };   // 有距离的在同一格，「-」是格外
}
// 发到舰队频道的一行统计（英文界面写英文，舰船类别名本来就是界面语言）
function scanSummaryText(st) {
  const en = LANG === 'en';
  const classes = st.classes.slice(0, 8).map((g) => `${g.key} ${g.n}`).join(en ? ', ' : '、');
  if (en) return `D-scan: ${st.ships.length} ships${st.watch.length ? ' (' + st.watch.map((w) => `${w.en} ${w.n}`).join(', ') + ')' : ''}${classes ? ': ' + classes : ''}`;
  return `定向扫描：${st.ships.length} 艘舰船${st.watch.length ? '（' + st.watch.map((w) => `${w.label} ${w.n}`).join('、') + '）' : ''}${classes ? '：' + classes : ''}`;
}
function barList(list, label, icon) {
  const max = list[0]?.n || 1;
  return `<ul class="ls-groups">${list.map((g) => `<li>${icon ? icon(g) : ''}<span class="ls-gname">${esc(label(g))}</span>
    <span class="ls-bar"><em style="width:${(g.n / max) * 100}%"></em></span><b>${g.n}</b></li>`).join('')}</ul>`;
}
const typeIcon = (g) => (g.first.typeId ? `<img src="https://images.evetech.net/types/${g.first.typeId}/icon?size=32" alt="" width="20" height="20" loading="lazy">` : '<i></i>');
function scanHtml() {
  const st = scanStats();
  return `
    <section class="kb-section ls-card">
      <div class="ls-summary">
        <div><b>${st.ships.length}</b><small>艘舰船</small></div>
        <div title="扫描结果里显示距离的在同一格，「-」表示不在同格"><b>${st.grid}</b><small>同格</small></div>
        <div><b>${st.types.length}</b><small>种舰船</small></div>
        <div><b>${st.byKind.drone}</b><small>无人机 / 舰载机</small></div>
        <div><b>${st.byKind.structure + st.byKind.deploy}</b><small>建筑与可部署</small></div>
      </div>
      ${st.watch.length ? `<div class="ds-watch"><span class="text-muted">注意</span>${st.watch.map((w) => `<span class="ds-tag ${w.cls}">${w.label} <b>${w.n}</b></span>`).join('')}</div>` : ''}
      <div class="ls-actions ds-copy"><button class="btn btn-ghost btn-sm" data-ls-copy>复制统计</button><span class="text-muted notranslate">${esc(scanSummaryText(st))}</span></div>
      ${st.ships.length ? `<div class="ls-cols"><div><h3 class="ls-h">按舰船类别</h3>${barList(st.classes, (g) => g.key)}</div>
        <div><h3 class="ls-h">按舰船型号</h3>${barList(st.types, (g) => scanTypeName(g.first), typeIcon)}</div></div>` : '<p class="text-muted">扫描结果里没有舰船</p>'}
    </section>
    ${st.others.length ? `<section class="kb-section ls-card"><h3 class="ls-h">建筑、无人机与其他</h3>
      ${barList(st.others, (g) => `${scanTypeName(g.first)} · ${KIND_ZH[g.first.kind]}`, typeIcon)}</section>` : ''}`;
}

// ---------- 角色定位：按近 30 天参与击杀时开的船（舰船分组）----------
// 每类占参与击杀次数 ≥ 25%（且至少 2 次）就标上，按占比排序最多标 2 个；其余战斗舰船都算「火力」
const ROLES = [
  ['tackle', '轻拦', [831, 541, 25, 1283]],                              // 截击舰、拦截舰（泡泡）、护卫舰、远征护卫舰
  ['htackle', '重拦', [894]],                                            // 重型拦截巡洋舰
  ['logi', '后勤', [832, 1527, 1538]],                                   // 后勤巡洋舰、后勤护卫舰、战力辅助舰
  ['special', '特种', [830, 834, 833, 906, 898, 893]],                  // 隐形特勤舰、隐轰、侦察舰、黑隐、电子攻击舰
  ['cap', '旗舰', [485, 547, 659, 30, 4594]],                           // 无畏、航母、超级航母、泰坦、枪骑兵无畏
];
// 不算进定位的：太空舱、穿梭机、新手护卫舰，以及采矿 / 工业 / 运输类
const NOT_ROLE = new Set([29, 31, 237, 463, 543, 28, 380, 1202, 941, 883, 513, 902]);
// 诱导力场发生器（普通、隐秘、工业）
const CYNO = new Set([21096, 28646, 52694]);
function roles(p) {
  const s = p.st;
  const out = [];
  if (p.cyno) out.push({ key: 'cyno', label: '诱导', title: `最近 ${p.cyno[1]} 次损失里有 ${p.cyno[0]} 次装着诱导力场发生器` });
  if (!s?.ships?.length) return out;
  const c = typeCache();
  const cnt = Object.fromEntries([...ROLES.map(([k]) => [k, 0]), ['dps', 0]]);
  let total = 0;
  for (const [t, n] of s.ships) {
    const g = c.t[t];
    if (!g || NOT_ROLE.has(g) || c.g[g]?.[1] !== 6) continue;
    total += n;
    cnt[ROLES.find(([, , gs]) => gs.includes(g))?.[0] || 'dps'] += n;
  }
  if (!total) return out;
  const label = { ...Object.fromEntries(ROLES.map(([k, l]) => [k, l])), dps: '火力' };
  return out.concat(Object.entries(cnt).filter(([, n]) => n >= 2 && n / total >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k, n]) => ({ key: k, label: label[k], title: `近 30 天参与的 ${total} 次击杀里 ${n} 次开${k === 'dps' ? '输出舰船' : label[k] + '类舰船'}（${Math.round((n / total) * 100)}%）` })));
}

// ---------- 最近一次击杀的位置（ESI 原文坐标 → 星系内最近的天体，killboard.js 的 nearestOf）与诱导检测 ----------
// 按威胁排序先查前 LOC_MAX 名，6 个并发；查到一个刷新一次
const LOC_MAX = 150;
async function locateLastKills() {
  const run = S.at;
  const list = S.pilots.filter((p) => p.st?.last_kill || p.st?.recent_losses?.length).sort(SORTS.threat).slice(0, LOC_MAX);
  let pending = 0;
  const redraw = () => { if (!pending++) requestAnimationFrame(() => { pending = 0; if (S.at === run) draw(); }); };
  await pool(list, 6, async (p) => {
    // 最近 3 次损失有没有装诱导
    const losses = p.st.recent_losses || [];
    if (losses.length && !p.cyno) {
      const kms = await Promise.all(losses.map(([id, hash]) => D.fetchESI(`/killmails/${id}/${hash}/`).catch(() => null)));
      const n = kms.filter((k) => (k?.victim?.items || []).some((it) => CYNO.has(it.item_type_id))).length;
      if (n) p.cyno = [n, kms.filter(Boolean).length];
    }
    if (p.st.last_kill && !p.loc) {
      const [id, hash, , system] = p.st.last_kill;
      try {
        const km = await D.fetchESI(`/killmails/${id}/${hash}/`);
        const near = await D.nearest({ ...km, killmail_id: id, solar_system_id: km.solar_system_id || system });
        p.loc = near || { none: true };
      } catch { p.loc = { none: true }; }
    }
    if (S.at === run) redraw();
  });
}
function lastKillHtml(p) {
  const lk = p.st?.last_kill;
  if (!lk) return '—';
  const [id, , at, system] = lk;
  // 星系名已经单独显示：行星 / 卫星 / 小行星带去掉开头的星系名（「VI」写成「行星 VI」）
  const where = (l) => { const sys = D.systemName(system); const rest = l.label.startsWith(sys + ' ') ? l.label.slice(sys.length + 1) : l.label; return l.kind === 'planet' && rest !== l.label ? '行星 ' + rest : rest; };
  const near = p.loc && !p.loc.none ? `<small>距 ${esc(where(p.loc))}：${esc(p.loc.distance)}</small>` : p.loc ? '' : '<small class="text-muted">定位中…</small>';
  return `<a class="kb-link" href="#kb/kill/${id}" title="${esc(ago(at))}">${esc(D.systemName(system))}</a>${near}`;
}

// 威胁程度：近 30 天击杀数、单挑数、击杀 / (击杀 + 损失)
function threat(p) {
  const s = p.st;
  if (!s) return { score: -1, level: '', label: D.kb ? '—' : '' };
  const total = s.kills + s.losses;
  const ratio = total ? s.kills / total : 0;
  const score = s.kills * (0.5 + ratio) + s.solo * 3;
  const level = !total ? 'none' : score >= 60 ? 'high' : score >= 12 ? 'mid' : 'low';
  return { score, ratio, level, label: { none: '无记录', high: '高', mid: '中', low: '低' }[level] };
}

function tags(p) {
  const s = p.st, out = [];
  if (!s) return out;
  for (const r of roles(p)) out.push([r.label, r.title, 'role-' + r.key]);
  if (s.solo >= 3 && s.solo >= s.kills * 0.2) out.push(['单挑', '近 30 天单人击杀 ' + s.solo + ' 次']);
  if (s.kills + s.losses && s.losses >= s.kills * 2 && s.losses >= 3) out.push(['常被打', '近 30 天损失 ' + s.losses + ' 次']);
  return out;
}

const ago = (iso) => {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso)) / 3600e3;
  return h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟前' : h < 48 ? Math.round(h) + ' 小时前' : Math.round(h / 24) + ' 天前';
};

const SORTS = {
  threat: (a, b) => threat(b).score - threat(a).score,
  kills: (a, b) => (b.st?.kills || 0) - (a.st?.kills || 0),
  losses: (a, b) => (b.st?.losses || 0) - (a.st?.losses || 0),
  last: (a, b) => new Date(b.st?.last || 0) - new Date(a.st?.last || 0),
  name: (a, b) => a.name.localeCompare(b.name),
  org: (a, b) => (orgName(a.alliance) || orgName(a.corp)).localeCompare(orgName(b.alliance) || orgName(b.corp))
};
const link = (kind, id, text) => (D.kb ? `<a class="kb-link" href="#kb/${kind}/${id}" data-entity="${kind}:${id}">${esc(text)}</a>` : esc(text));
const orgName = (id) => (id ? S.orgs.get(id) || 'ID ' + id : '');
const stCls = (p) => { const c = ST.of(entOf(p))?.cls; return c === 'self' ? 'corp' : c; };
const stfHidden = (p) => S.stf.on && ST.ready() && S.stf.cls.has(stCls(p));
const hidden = (p) => S.ignore.has(p.alliance) || S.ignore.has(p.corp) || stfHidden(p);
function stfHtml() {
  if (!ST.ready()) return '';
  const n = S.stf.on ? S.pilots.filter(stfHidden).length : 0;
  return `<div class="ls-stf"><label class="ls-stf-on"><input type="checkbox" data-ls-stf-on${S.stf.on ? ' checked' : ''}> 按声望筛掉</label>
    <span class="ls-stf-ics">${STF.map(([k, l]) => `<button type="button" class="ls-stf-ic${S.stf.cls.has(k) ? ' on' : ''}" data-ls-stf="${k}" title="${l}" aria-label="${l}" aria-pressed="${S.stf.cls.has(k)}">${ST.icon(k)}</button>`).join('')}</span>
    ${n ? `<span class="text-muted">已筛掉 ${n} 人</span>` : ''}</div>`;
}

function groupsHtml(kind) {
  const counts = new Map();
  for (const p of S.pilots) {
    const id = kind === 'alliance' ? p.alliance : p.corp;
    const key = id || 0;
    const g = counts.get(key) || { id: key, n: 0, kills: 0 };
    g.n++;
    g.kills += p.st?.kills || 0;
    counts.set(key, g);
  }
  const list = [...counts.values()].sort((a, b) => b.n - a.n);
  const max = list[0]?.n || 1;
  return `<ul class="ls-groups">${list.slice(0, 15).map((g) => `<li class="${g.id && S.ignore.has(g.id) ? 'ignored' : ''}">
      ${g.id ? `<img src="${D.eveImage((kind === 'alliance' ? 'alliances/' : 'corporations/') + g.id + '/logo', 32)}" alt="" width="20" height="20" loading="lazy">` : '<i></i>'}
      <span class="ls-gname">${g.id ? ST.badge(kind === 'alliance' ? { alliance: g.id } : { corp: g.id }) + link(kind, g.id, orgName(g.id)) : kind === 'alliance' ? '无联盟' : '—'}</span>
      <span class="ls-bar"><em style="width:${(g.n / max) * 100}%"></em></span><b>${g.n}</b>
      ${g.id ? `<button class="btn btn-ghost btn-sm" data-ls-ignore="${g.id}" title="${S.ignore.has(g.id) ? '在名单里重新显示' : '在名单里隐藏（比如自己人）'}">${S.ignore.has(g.id) ? '显示' : '隐藏'}</button>` : ''}</li>`).join('')}
    </ul>${list.length > 15 ? `<p class="text-muted">另有 ${list.length - 15} 个${kind === 'alliance' ? '联盟' : '军团'}</p>` : ''}`;
}

// 只在本地分析正显示着时重画（force：打开本地分析时画第一遍）。S.box 是击杀页公共的内容区（kbMain），离开本地分析后
// 这里换成了首页、人物页等；声望更新（窗口切回前台会重读）、分析和查击杀位置的结果晚回来时，都不能再把它盖成本地分析
function draw(force = false) {
  const box = S.box;
  if (!box || (!force && !box.querySelector('.ls-input'))) return;
  const ta = box.querySelector('[data-ls-text]');
  const keep = ta ? ta.value : S.text;
  const shown = S.pilots.filter((p) => !hidden(p)).sort(SORTS[S.sort] || SORTS.threat);
  const lv = { high: 0, mid: 0, low: 0, none: 0 };
  for (const p of shown) { const t = threat(p); if (t.level) lv[t.level]++; }
  const th = (key, label, cls = '') => `<th class="${cls}"><button class="link-btn${S.sort === key ? ' active' : ''}" data-ls-sort="${key}">${label}${S.sort === key ? ' ↓' : ''}</button></th>`;
  const rows = shown.map((p) => {
    const t = threat(p), s = p.st;
    return `<tr>
      <td><div class="ls-pilot"><img src="${D.eveImage('characters/' + p.id + '/portrait', 64)}" alt="" width="28" height="28" loading="lazy">
        <span>${ST.badge(entOf(p))}${link('character', p.id, p.name)}
        ${tags(p).map(([l, title, cls]) => `<i class="ls-tag${cls ? ' ' + cls : ''}" title="${esc(title)}">${l}</i>`).join('')}</span></div></td>
      <td class="ls-org">${p.alliance ? `<span title="联盟"><img src="${D.eveImage('alliances/' + p.alliance + '/logo', 32)}" alt="" width="18" height="18" loading="lazy">${esc(orgName(p.alliance))}</span>` : ''}${p.corp ? `<small title="军团"><img src="${D.eveImage('corporations/' + p.corp + '/logo', 32)}" alt="" width="16" height="16" loading="lazy">${esc(orgName(p.corp))}</small>` : ''}</td>
      ${D.kb ? `<td><span class="ls-threat ${t.level}">${t.label}</span></td>
      <td class="num">${s ? s.kills : '—'}</td><td class="num">${s ? s.losses : '—'}</td>
      <td class="num ls-hide-sm">${s && s.kills + s.losses ? Math.round(t.ratio * 100) + '%' : '—'}</td>
      <td class="num ls-hide-sm">${s?.gang ?? '—'}</td>
      <td class="ls-ships ls-hide-sm">${(s?.ships || []).slice(0, 3).map(([id, n]) => `<img src="https://images.evetech.net/types/${id}/icon?size=32" alt="" width="22" height="22" title="${esc(D.typeName(id))} × ${n}" loading="lazy">`).join('')}</td>
      <td class="ls-lastkill">${lastKillHtml(p)}</td>
      <td class="ls-hide-md">${(s?.systems || []).slice(0, 2).map(([id]) => esc(D.systemName(id))).join('、') || '—'}</td>
      <td class="num">${s ? ago(s.last) : '—'}</td>` : ''}</tr>`;
  }).join('');
  box.innerHTML = `${D.back || ''}
    <section class="kb-section ls-input">
      <div class="kb-section-head"><h2>本地分析</h2><span class="text-muted" title="频道成员 Ctrl+A、Ctrl+C，最多 ${MAX} 人">粘贴成员列表或定向扫描结果</span></div>
      <textarea class="cr-input" rows="6" data-ls-text placeholder="${LANG === 'en' ? 'Channel member list: one pilot name per line&#10;D-scan: select all in the scan window and copy' : '频道成员列表：一行一个角色名&#10;定向扫描：扫描窗口里全选复制'}" spellcheck="false">${esc(keep)}</textarea>
      <div class="ls-actions"><button class="btn btn-primary" data-ls-run${S.busy ? ' disabled' : ''}>分析</button>
        ${S.ignore.size ? `<button class="btn btn-ghost" data-ls-unignore>显示全部（已隐藏 ${S.ignore.size} 个军团 / 联盟）</button>` : ''}
        ${S.mode ? `<span class="ds-mode">${S.mode === 'dscan' ? '定向扫描' : '频道成员名单'}</span>` : ''}
        <span class="text-muted" data-ls-status>${esc(S.status)}</span></div>
      ${D.kb || S.mode === 'dscan' ? '' : '<p class="ka-note">本服务器无击杀数据，只统计军团 / 联盟</p>'}
    </section>
    ${S.mode === 'dscan' && S.scan ? scanHtml() : ''}
    ${S.mode === 'local' && S.pilots.length ? `
    <section class="kb-section ls-card">
      <div class="ls-summary">
        <div><b>${S.pilots.length}</b><small>名角色${shown.length < S.pilots.length ? `（显示 ${shown.length}）` : ''}</small></div>
        <div><b>${new Set(S.pilots.map((p) => p.alliance).filter(Boolean)).size}</b><small>个联盟</small></div>
        <div><b>${new Set(S.pilots.map((p) => p.corp)).size}</b><small>个军团</small></div>
        ${ST.ready() ? (() => { const n = { friend: 0, neutral: 0, hostile: 0 }; for (const p of shown) n[ST.group(entOf(p))]++;
          return `<div class="ls-lv"><b class="st-n-hostile">${n.hostile}</b><small>敌对</small></div><div class="ls-lv"><b>${n.neutral}</b><small>中立</small></div><div class="ls-lv"><b class="st-n-friend">${n.friend}</b><small>友方</small></div>`; })() : ''}
        ${D.kb ? `<div class="ls-lv"><b class="high">${lv.high}</b><small>高威胁</small></div><div class="ls-lv"><b class="mid">${lv.mid}</b><small>中威胁</small></div>
        <div><b>${D.formatNumber(shown.reduce((t, p) => t + (p.st?.kills || 0), 0))}</b><small>近 30 天击杀合计</small></div>` : ''}
      </div>
      ${stfHtml()}
      <div class="ls-cols"><div><h3 class="ls-h">联盟</h3>${groupsHtml('alliance')}</div><div><h3 class="ls-h">军团</h3>${groupsHtml('corporation')}</div></div>
    </section>
    <section class="kb-section ls-card">
      <div class="table-scroll"><table class="data-table ls-table"><thead><tr>${th('name', '角色')}${th('org', '联盟 / 军团')}
        ${D.kb ? `${th('threat', '威胁')}${th('kills', '击杀', 'num')}${th('losses', '损失', 'num')}<th class="num ls-hide-sm" title="击杀 ÷（击杀 + 损失）">击杀占比</th><th class="num ls-hide-sm" title="参与的击杀平均有多少名玩家">平均同伙</th><th class="ls-hide-sm">常用船</th><th title="最近一次参与击杀的星系，和击杀位置离最近天体（星门、空间站、行星等）的距离">最近击杀位置</th><th class="ls-hide-md">常去星系</th>${th('last', '最近活跃', 'num')}` : ''}
      </tr></thead><tbody>${rows}</tbody></table></div>
      ${D.kb ? '<p class="ka-note" title="威胁按击杀数、击杀占比与单挑次数估算">近 30 天击杀统计，威胁仅供参考</p>' : ''}
    </section>` : ''}`;
}

export function renderLocal(box, deps) {
  D = deps;
  S.box = box;
  draw(true);
  if (!S.stBound) { S.stBound = true; ST.onStandings(() => draw()); }
  if (box.dataset.lsBound) return;
  box.dataset.lsBound = '1';
  box.addEventListener('click', (e) => {
    if (!box.querySelector('.ls-input')) return;
    if (e.target.closest('[data-ls-run]')) { analyze(box.querySelector('[data-ls-text]').value); return; }
    const sort = e.target.closest('[data-ls-sort]');
    if (sort) { S.sort = sort.dataset.lsSort; draw(); return; }
    const ig = e.target.closest('[data-ls-ignore]');
    if (ig) { const id = Number(ig.dataset.lsIgnore); if (S.ignore.has(id)) S.ignore.delete(id); else S.ignore.add(id); saveIgnore(); draw(); return; }
    const sf = e.target.closest('[data-ls-stf]');
    if (sf) { const k = sf.dataset.lsStf; if (S.stf.cls.has(k)) S.stf.cls.delete(k); else S.stf.cls.add(k); saveStf(); draw(); return; }
    if (e.target.closest('[data-ls-unignore]')) { S.ignore.clear(); saveIgnore(); draw(); return; }
    if (e.target.closest('[data-ls-copy]') && S.scan) D.copyText(scanSummaryText(scanStats()));
  });
  box.addEventListener('change', (e) => {
    if (e.target.matches('[data-ls-stf-on]')) { S.stf.on = e.target.checked; saveStf(); draw(); }
  });
  box.addEventListener('paste', (e) => {
    if (!e.target.matches('[data-ls-text]')) return;
    // 粘贴后自动分析（输入框原本为空时）
    if (!e.target.value.trim()) setTimeout(() => analyze(e.target.value), 0);
  });
}
