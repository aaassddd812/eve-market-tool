// ===== 本地分析（击杀记录 → 本地分析，#kb/local）：一个粘贴框，自动识别是频道成员名单还是定向扫描结果 =====
// 频道成员名单：游戏里在本地频道（或任意频道）的成员列表里 Ctrl+A、Ctrl+C，粘贴进来：
//   1. ESI /universe/ids/ 把名字换成角色 ID（每次最多 500 个），/characters/affiliation/ 查所属军团 / 联盟 / 势力（每次最多 1000 个）；
//   2. 宁静服再查本站击杀记录服务 /api/v1/pilots（每次最多 200 名）：近 30 天击杀 / 损失、单挑、平均同伙人数、常用船、常去星系、最近活跃；
//   3. 按联盟 / 军团统计人数，点一下可以隐藏（比如自己人），隐藏名单存在本浏览器。
// 国服没有公开击杀数据，只显示所属势力分布。
// 定向扫描结果：扫描窗口里 Ctrl+A、Ctrl+C，每行「类型 ID<Tab>名称<Tab>类型<Tab>距离」（旧客户端没有类型 ID，按类型名用 /universe/ids/ 查）。
//   类型所属的分组（舰船类别）与大类用 ESI /universe/types/、/universe/groups/ 查，缓存在本浏览器（eve-dscan-types-v1）；
//   统计舰船总数、同格（显示距离的）、按舰船类别 / 型号的数量，标出旗舰、拦截泡、后勤、隐轰、侦察、黑隐与扫描探针，建筑、无人机与其他单列；可复制一行统计发到舰队频道。

let D;   // esc, formatISK, formatNumber, resolveNames, esiUrl, eveImage, kb, loadTypes, systemName, typeName, fetchESI, copyText
const IGNORE_KEY = 'eve-local-ignore-v1';
const MAX = 1000;
const S = { text: '', mode: '', pilots: [], orgs: new Map(), scan: null, status: '', sort: 'threat', ignore: new Set(), busy: false, at: null, box: null };
try { S.ignore = new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) || '[]')); } catch { /* 忽略 */ }
const saveIgnore = () => { try { localStorage.setItem(IGNORE_KEY, JSON.stringify([...S.ignore])); } catch { /* 忽略 */ } };

const esc = (s) => D.esc(s);

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
      if (ships.length) await D.loadTypes(ships);
    }
    setStatus('');
    draw();
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
  if (s.solo >= 3 && s.solo >= s.kills * 0.2) out.push(['单挑', '近 30 天单人击杀 ' + s.solo + ' 次']);
  if (s.gang >= 15) out.push(['抱团', '参与的击杀平均 ' + s.gang + ' 人']);
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
const hidden = (p) => S.ignore.has(p.alliance) || S.ignore.has(p.corp);

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
      <span class="ls-gname">${g.id ? link(kind, g.id, orgName(g.id)) : kind === 'alliance' ? '无联盟' : '—'}</span>
      <span class="ls-bar"><em style="width:${(g.n / max) * 100}%"></em></span><b>${g.n}</b>
      ${g.id ? `<button class="btn btn-ghost btn-sm" data-ls-ignore="${g.id}" title="${S.ignore.has(g.id) ? '在名单里重新显示' : '在名单里隐藏（比如自己人）'}">${S.ignore.has(g.id) ? '显示' : '隐藏'}</button>` : ''}</li>`).join('')}
    </ul>${list.length > 15 ? `<p class="text-muted">另有 ${list.length - 15} 个${kind === 'alliance' ? '联盟' : '军团'}</p>` : ''}`;
}

function draw() {
  const box = S.box;
  if (!box) return;
  const ta = box.querySelector('[data-ls-text]');
  const keep = ta ? ta.value : S.text;
  const shown = S.pilots.filter((p) => !hidden(p)).sort(SORTS[S.sort] || SORTS.threat);
  const lv = { high: 0, mid: 0, low: 0, none: 0 };
  for (const p of shown) { const t = threat(p); if (t.level) lv[t.level]++; }
  const th = (key, label, cls = '') => `<th class="${cls}"><button class="link-btn${S.sort === key ? ' active' : ''}" data-ls-sort="${key}">${label}${S.sort === key ? ' ↓' : ''}</button></th>`;
  const rows = shown.map((p) => {
    const t = threat(p), s = p.st;
    return `<tr>
      <td class="ls-pilot"><img src="${D.eveImage('characters/' + p.id + '/portrait', 64)}" alt="" width="28" height="28" loading="lazy">
        <span>${link('character', p.id, p.name)}
        ${tags(p).map(([l, title]) => `<i class="ls-tag" title="${esc(title)}">${l}</i>`).join('')}</span></td>
      <td class="ls-org">${p.alliance ? `<span title="联盟">${esc(orgName(p.alliance))}</span>` : ''}<small>${esc(orgName(p.corp))}</small></td>
      ${D.kb ? `<td><span class="ls-threat ${t.level}">${t.label}</span></td>
      <td class="num">${s ? s.kills : '—'}</td><td class="num">${s ? s.losses : '—'}</td>
      <td class="num ls-hide-sm">${s && s.kills + s.losses ? Math.round(t.ratio * 100) + '%' : '—'}</td>
      <td class="num ls-hide-sm">${s?.gang ?? '—'}</td>
      <td class="ls-ships ls-hide-sm">${(s?.ships || []).map(([id, n]) => `<img src="https://images.evetech.net/types/${id}/icon?size=32" alt="" width="22" height="22" title="${esc(D.typeName(id))} × ${n}" loading="lazy">`).join('')}</td>
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
        ${D.kb ? `<div class="ls-lv"><b class="high">${lv.high}</b><small>高威胁</small></div><div class="ls-lv"><b class="mid">${lv.mid}</b><small>中威胁</small></div>
        <div><b>${D.formatNumber(shown.reduce((t, p) => t + (p.st?.kills || 0), 0))}</b><small>近 30 天击杀合计</small></div>` : ''}
      </div>
      <div class="ls-cols"><div><h3 class="ls-h">联盟</h3>${groupsHtml('alliance')}</div><div><h3 class="ls-h">军团</h3>${groupsHtml('corporation')}</div></div>
    </section>
    <section class="kb-section ls-card">
      <div class="table-scroll"><table class="data-table ls-table"><thead><tr>${th('name', '角色')}${th('org', '联盟 / 军团')}
        ${D.kb ? `${th('threat', '威胁')}${th('kills', '击杀', 'num')}${th('losses', '损失', 'num')}<th class="num ls-hide-sm" title="击杀 ÷（击杀 + 损失）">击杀占比</th><th class="num ls-hide-sm" title="参与的击杀平均有多少名玩家">平均同伙</th><th class="ls-hide-sm">常用船</th><th class="ls-hide-md">常去星系</th>${th('last', '最近活跃', 'num')}` : ''}
      </tr></thead><tbody>${rows}</tbody></table></div>
      ${D.kb ? '<p class="ka-note" title="威胁按击杀数、击杀占比与单挑次数估算">近 30 天击杀统计，威胁仅供参考</p>' : ''}
    </section>` : ''}`;
}

export function renderLocal(box, deps) {
  D = deps;
  S.box = box;
  draw();
  if (box.dataset.lsBound) return;
  box.dataset.lsBound = '1';
  box.addEventListener('click', (e) => {
    if (!box.querySelector('.ls-input')) return;
    if (e.target.closest('[data-ls-run]')) { analyze(box.querySelector('[data-ls-text]').value); return; }
    const sort = e.target.closest('[data-ls-sort]');
    if (sort) { S.sort = sort.dataset.lsSort; draw(); return; }
    const ig = e.target.closest('[data-ls-ignore]');
    if (ig) { const id = Number(ig.dataset.lsIgnore); if (S.ignore.has(id)) S.ignore.delete(id); else S.ignore.add(id); saveIgnore(); draw(); return; }
    if (e.target.closest('[data-ls-unignore]')) { S.ignore.clear(); saveIgnore(); draw(); return; }
    if (e.target.closest('[data-ls-copy]') && S.scan) D.copyText(scanSummaryText(scanStats()));
  });
  box.addEventListener('paste', (e) => {
    if (!e.target.matches('[data-ls-text]')) return;
    // 粘贴后自动分析（输入框原本为空时）
    if (!e.target.value.trim()) setTimeout(() => analyze(e.target.value), 0);
  });
}
