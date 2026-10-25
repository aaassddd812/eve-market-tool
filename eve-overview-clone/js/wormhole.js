// ===== 虫洞 =====（顶部导航「虫洞」，地址栏 #wh）
// 星系：查任意虫洞星系的等级、天象（含该等级的效果数值）、固定出口、行星与卫星；宁静服另有近 30 天击杀、活跃时段与常驻势力推测。
// 活跃度：虫洞星系按击杀排行（击杀记录服务 /api/v1/wormholes/activity，仅宁静服；ESI 的星系击杀统计不含虫洞）。
// 虫洞类型：全部虫洞代码的通往、出现位置、存活时间、质量与可通过船型。天象：六种天象各等级的效果。
// 质量计算：按虫洞总质量（±10% 随机）逐跳推算剩余质量、状态与塌洞风险。席拉连接：EVE-Scout 公开的席拉 / 图尔努尔实时虫洞（仅宁静服），按跳数排序。
// 数据：wh-data.json 由 build_wormholes.mjs 生成（CCP SDE + anoik.is 的固定出口）；星图跳数用当前服务器的 map-data。
import { SERVER, IS_TQ } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';

let ctx = null;   // esc, formatISK, formatNumber, showToast, store, loadKillboard, planPi, resolveTypeNames
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-wh-v1';
const SCOUT_API = 'https://api.eve-scout.com/v2/public/signatures';
const ICON = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;

const TABS = [['system', '星系'], ...(IS_TQ ? [['activity', '活跃度']] : []), ['holes', '虫洞类型'], ['effects', '天象'], ['mass', '质量计算'], ...(IS_TQ ? [['thera', '席拉连接']] : [])];
// 等级（SDE wormholeClassID）
const CLS = { 1: 'C1', 2: 'C2', 3: 'C3', 4: 'C4', 5: 'C5', 6: 'C6', 7: '高安', 8: '低安', 9: '00', 12: '席拉', 13: 'C13', 14: '哨兵', 15: '巴比肯', 16: '维德特', 17: '合流', 18: '雷道特', 25: '波赫文', 0: 'K162', '-1': '未知' };
const clsName = (c) => CLS[c] ?? '未知';
const clsTag = (c) => `<span class="wh-cls wh-c${c}">${clsName(c)}</span>`;
const DRIFTER = new Set([14, 15, 16, 17, 18]);
// 天象效果强度：C1–C6 对应 1–6，C13 按 6，漂流者按 2，席拉没有天象
const effectPower = (c) => (c >= 1 && c <= 6 ? c : c === 13 ? 6 : DRIFTER.has(c) ? 2 : 0);
// [名称, 方向, 基数]；数值 = 基数 × (1 + (强度 − 1) × 7/15)，即 15→22→29→36→43→50、30→…→100、60→…→200
const EFFECTS = {
  magnetar: ['磁星', [['伤害', 1, 30], ['导弹爆炸半径', 1, 15], ['无人机跟踪速度', -1, 15], ['炮台跟踪速度', -1, 15], ['锁定距离', -1, 15], ['目标标记强度', -1, 15]]],
  blackhole: ['黑洞', [['舰船速度', 1, 30], ['导弹爆炸速度', 1, 30], ['锁定距离', 1, 30], ['导弹速度', 1, 15], ['惯性', 1, 15], ['停滞网强度', -1, 15]]],
  redgiant: ['红巨星', [['过热加成', 1, 30], ['智能炸弹伤害', 1, 30], ['智能炸弹范围', 1, 30], ['炸弹伤害', 1, 30], ['过热造成的损伤', 1, 15]]],
  pulsar: ['脉冲星', [['护盾值', 1, 30], ['信号半径', 1, 30], ['能量中和 / 吸取量', 1, 30], ['装甲抗性', -1, 15], ['电容回充时间', -1, 15]]],
  wolfrayet: ['沃尔夫-拉叶星', [['小型武器伤害', 1, 60], ['装甲值', 1, 30], ['护盾抗性', -1, 15], ['信号半径', -1, 15]]],
  cataclysmic: ['激变变星', [['电容容量', 1, 30], ['远程装甲维修量', 1, 30], ['远程护盾回充量', 1, 30], ['电容回充时间', 1, 15], ['本地装甲维修量', -1, 15], ['本地护盾回充量', -1, 15], ['远程电容传输量', -1, 15]]]
};
const effVal = (base, power) => Math.round(base * (1 + (power - 1) * 7 / 15));
const PLANETS = { T: '温和', I: '冰冻', G: '气体', O: '海洋', L: '熔岩', B: '贫瘠', S: '风暴', P: '等离子', X: '碎裂' };
// 单次通过质量 → 可通过的最大船型
function shipSize(jump) {
  if (!jump) return '—';
  if (jump <= 5e6) return '护卫舰 / 驱逐舰';
  if (jump <= 62e6) return '巡洋舰 / 战巡';
  if (jump <= 375e6) return '战列舰';
  if (jump <= 1e9) return '旗舰（不含超旗）';
  return '旗舰 / 货舰';
}
const SCOUT_SIZE = { small: '护卫舰', medium: '巡洋舰', large: '战列舰', xlarge: '货舰', capital: '旗舰' };

const D = { loading: null, data: null, sysById: new Map(), sysByName: new Map(), holes: new Map(), map: null };
const S = {
  tab: 'system', sys: 0, q: '', act: new Map(), actDays: 7, actCls: 0, actEff: '', detail: new Map(),
  holeQ: '', holeDest: 'all', scout: null, scoutAt: 0, scoutErr: null, origin: '', recent: [],
  mass: { hole: 'H296', total: 3300, steps: [] }
};

export function initWormhole(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {}) || {};
  if (Array.isArray(saved.recent)) S.recent = saved.recent.slice(0, 10);
  if (saved.mass) Object.assign(S.mass, saved.mass);
  if (saved.origin) S.origin = saved.origin;
}
const save = () => ctx.store.setJSON(STORE_KEY, { recent: S.recent, mass: S.mass, origin: S.origin });

function loadData() {
  if (!D.loading) {
    D.loading = fetch('wh-data.json?v=1').then((r) => { if (!r.ok) throw new Error('虫洞数据 ' + r.status); return r.json(); }).then((data) => {
      D.data = data;
      for (const [id, name, cls, region, effect, planets, moons, statics] of data.systems) {
        const s = { id, name, cls, region, effect, planets, moons, statics };
        D.sysById.set(id, s);
        D.sysByName.set(name.toUpperCase(), s);
      }
      for (const [code, type, dest, life, mass, jump, regen, src, isStatic] of data.wormholes) D.holes.set(code, { code, type, dest, life, mass, jump, regen, src, isStatic });
    }).catch((e) => { D.loading = null; throw e; });
  }
  return D.loading;
}

function loadMap() {
  if (!D.map) {
    D.map = fetch(SERVER.mapData).then((r) => r.json()).then((m) => {
      const sys = new Map(m.systems.map((s) => [s[0], { id: s[0], name: s[1], sec: s[5], region: s[6] }]));
      const nbr = new Map();
      for (const [i, j] of m.gates) {               // 星门两端是 systems 数组下标
        const a = m.systems[i][0], b = m.systems[j][0];
        if (!nbr.has(a)) nbr.set(a, []);
        if (!nbr.has(b)) nbr.set(b, []);
        nbr.get(a).push(b);
        nbr.get(b).push(a);
      }
      return { sys, nbr, regions: new Map(m.regions.map((r) => [r[0], r[1]])), byName: new Map([...sys.values()].map((s) => [s.name, s])) };
    }).catch((e) => { D.map = null; throw e; });
  }
  return D.map;
}

// ---------- 页面 ----------
// 预加载（modern-app.js：悬停导航按钮或常用页面空闲时调用），只取数据不渲染，打开页面时直接用
export const preload = () => loadData();

export async function showWormhole(hash) {
  const main = $('whMain');
  parseHash(hash || location.hash);
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `<section class="pi-page wh-page">
      <div class="pi-head"><h2>虫洞</h2>
        <div class="segmented wh-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" data-wh-tab="${k}">${l}</button>`).join('')}</div></div>
      <div id="whBody">${skPage({ title: false, cards: 4, rows: 6 })}</div></section>`;
    main.addEventListener('click', onClick);
    main.addEventListener('change', onChange);
    main.addEventListener('input', onInput);
    main.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-wh-search]')) { e.preventDefault(); pickSystem(e.target.value); }
      if (e.key === 'Enter' && e.target.matches('[data-wh-origin]')) { e.preventDefault(); S.origin = e.target.value.trim(); save(); render(); }
    });
  }
  try {
    await loadData();
  } catch (e) {
    $('whBody').innerHTML = `<div class="pi-card"><p class="text-muted">${ctx.esc(e.message)}</p></div>`;
    return;
  }
  render();
}

function parseHash(hash) {
  const m = hash.match(/^#wh\/?(\w+)?\/?([^/?]+)?/);
  if (!m) return;
  const tab = m[1];
  if (tab && TABS.some(([k]) => k === tab)) S.tab = tab;
  if (tab === 'system' && m[2] && D.data) {
    const s = D.sysById.get(Number(m[2])) || D.sysByName.get(decodeURIComponent(m[2]).toUpperCase());
    if (s) S.sys = s.id;
  } else if (tab === 'system' && m[2]) S.pendingSys = decodeURIComponent(m[2]);
}

function setHash() {
  const h = S.tab === 'system' && S.sys ? `#wh/system/${D.sysById.get(S.sys)?.name || S.sys}` : `#wh/${S.tab}`;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

function render() {
  if (S.pendingSys) { const s = D.sysByName.get(S.pendingSys.toUpperCase()) || D.sysById.get(Number(S.pendingSys)); if (s) S.sys = s.id; S.pendingSys = null; }
  document.querySelectorAll('[data-wh-tab]').forEach((b) => b.classList.toggle('active', b.dataset.whTab === S.tab));
  setHash();
  const body = $('whBody');
  if (S.tab === 'system') body.innerHTML = systemHtml();
  else if (S.tab === 'activity') renderActivity(body);
  else if (S.tab === 'holes') body.innerHTML = holesHtml();
  else if (S.tab === 'effects') body.innerHTML = effectsHtml();
  else if (S.tab === 'mass') body.innerHTML = massHtml();
  else if (S.tab === 'thera') renderThera(body);
  if (S.tab === 'system' && S.sys && IS_TQ) loadDetail(S.sys);
}

// ---------- 星系 ----------
function pickSystem(text) {
  const t = String(text || '').trim().toUpperCase();
  if (!t) return;
  let s = D.sysByName.get(t) || D.sysByName.get('J' + t) || D.sysById.get(Number(t));
  if (!s) {
    const hit = [...D.sysById.values()].filter((x) => x.name.toUpperCase().includes(t));
    if (hit.length === 1) s = hit[0];
    else { S.q = text; render(); return; }
  }
  openSystem(s.id);
}

export function openSystem(id) {
  S.tab = 'system';
  S.sys = id;
  S.q = '';
  S.recent = [id, ...S.recent.filter((x) => x !== id)].slice(0, 10);
  save();
  render();
  $('whMain')?.closest('.kb-scroll')?.scrollTo({ top: 0 });
}

function sysLink(id, label) {
  const s = D.sysById.get(id);
  return s ? `<button type="button" class="link-btn" data-wh-sys="${id}">${ctx.esc(label || s.name)}</button>` : ctx.esc(label || String(id));
}

function searchBox() {
  const { esc } = ctx;
  const q = S.q.trim().toUpperCase();
  const hits = q ? [...D.sysById.values()].filter((s) => s.name.toUpperCase().includes(q)).slice(0, 30) : [];
  return `<div class="pi-card wh-search-card">
    <div class="search-box"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" data-wh-search placeholder="输入虫洞星系，如 J123456（回车查询）" value="${esc(S.q)}" spellcheck="false" autocomplete="off" aria-label="虫洞星系"></div>
    ${hits.length ? `<div class="wh-chips">${hits.map((s) => `<button type="button" class="wh-chip" data-wh-sys="${s.id}">${esc(s.name)} ${clsTag(s.cls)}</button>`).join('')}</div>` : q ? '<p class="text-muted">没有匹配的虫洞星系</p>' : ''}
    ${S.recent.length ? `<div class="wh-chips"><span class="text-muted">最近：</span>${S.recent.map((id) => D.sysById.get(id)).filter(Boolean).map((s) => `<button type="button" class="wh-chip" data-wh-sys="${s.id}">${esc(s.name)} ${clsTag(s.cls)}</button>`).join('')}</div>` : ''}
  </div>`;
}

function holeRow(code, { showSrc = false } = {}) {
  const h = D.holes.get(code);
  const { esc, formatNumber } = ctx;
  if (!h) return `<tr><td><b>${esc(code)}</b></td><td colspan="5" class="text-muted">未知类型</td></tr>`;
  return `<tr>
    <td><b>${esc(h.code)}</b></td>
    ${showSrc ? `<td>${h.src.length ? h.src.map(clsTag).join(' ') : '—'}</td>` : ''}
    <td>${h.code === 'K162' ? '<span class="text-muted">出口端（通往对面）</span>' : clsTag(h.dest)}</td>
    <td class="num">${h.life ? h.life + ' 小时' : '—'}</td>
    <td class="num">${h.mass ? formatNumber(h.mass / 1e6) + ' kt' : '—'}</td>
    <td class="num">${h.jump ? formatNumber(h.jump / 1e6) + ' kt' : '—'}</td>
    <td>${shipSize(h.jump)}</td>
    ${showSrc ? `<td class="num pi-hide-sm">${h.regen ? formatNumber(h.regen / 1e6) + ' kt' : '—'}</td><td class="pi-hide-sm">${h.isStatic ? '可作固定出口' : ''}</td>` : ''}
  </tr>`;
}
const holeHead = (showSrc) => `<thead><tr><th>代码</th>${showSrc ? '<th>出现在</th>' : ''}<th>通往</th><th class="num">存活</th><th class="num">总质量</th><th class="num">单次质量</th><th>最大船型</th>${showSrc ? '<th class="num pi-hide-sm">质量回复</th><th class="pi-hide-sm"></th>' : ''}</tr></thead>`;

function effectList(key, cls) {
  const e = EFFECTS[key];
  const p = effectPower(cls);
  if (!e || !p) return '';
  return `<ul class="wh-eff-list">${e[1].map(([n, sign, base]) => `<li><span>${n}</span><b class="${sign > 0 ? 'up' : 'down'}">${sign > 0 ? '+' : '−'}${effVal(base, p)}%</b></li>`).join('')}</ul>`;
}

function systemHtml() {
  const { esc, formatNumber } = ctx;
  const s = D.sysById.get(S.sys);
  if (!s) return searchBox() + `<div class="pi-card"><p class="text-muted">输入虫洞星系名称查看等级、天象、固定出口与行星。${IS_TQ ? '宁静服还会显示近 30 天的击杀、活跃时段与常驻势力。' : ''}</p></div>`;
  const counts = {};
  for (const c of s.planets) counts[c] = (counts[c] || 0) + 1;
  const planetHtml = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<span class="wh-planet wh-p${c}">${PLANETS[c] || c} ×${n}</span>`).join('') || '<span class="text-muted">没有行星</span>';
  const region = D.data.regions[s.region] || '';
  const canPi = /[TIGOLBSP]/.test(s.planets);
  return searchBox() + `
    <div class="pi-card wh-sys-head">
      <div class="wh-sys-title"><h3>${esc(s.name)}</h3>${clsTag(s.cls)}${s.effect ? `<span class="wh-eff-tag wh-e-${s.effect}">${EFFECTS[s.effect][0]}</span>` : ''}
        <span class="toolbar-spacer"></span>
        ${canPi ? `<button type="button" class="btn btn-ghost btn-sm" data-wh-pi="${s.id}">行星工业规划</button>` : ''}
        ${IS_TQ ? `<a class="btn btn-ghost btn-sm" href="https://zkillboard.com/system/${s.id}/" target="_blank" rel="noopener">zKillboard</a>` : ''}
        <a class="btn btn-ghost btn-sm" href="https://anoik.is/systems/${encodeURIComponent(s.name)}" target="_blank" rel="noopener">anoik.is</a></div>
      <p class="text-muted">星域 ${esc(region)} · ${s.planets.length} 颗行星 · ${formatNumber(s.moons)} 颗卫星</p>
      <div class="wh-planets">${planetHtml}</div>
    </div>
    <div class="wh-grid">
      <div class="pi-card"><h4 class="wh-h">固定出口</h4>
        ${s.statics.length ? `<div class="pi-table-wrap"><table class="pi-table wh-table">${holeHead(false)}<tbody>${s.statics.map((c) => holeRow(c)).join('')}</tbody></table></div>` : '<p class="text-muted">没有固定出口</p>'}
        <p class="pi-note">固定出口塌了会在原处重新刷出同类型的洞；另外随时可能有随机虫洞与对面开过来的 K162</p></div>
      <div class="pi-card"><h4 class="wh-h">天象</h4>
        ${s.effect ? `<p><b>${EFFECTS[s.effect][0]}</b> <span class="text-muted">· ${clsName(s.cls)} 强度</span></p>${effectList(s.effect, s.cls)}` : `<p class="text-muted">${s.cls === 12 ? '席拉没有天象效果' : '没有天象效果'}</p>`}</div>
    </div>
    ${IS_TQ ? `<div id="whDetail">${detailHtml(s.id)}</div>` : ''}`;
}

async function loadDetail(id) {
  if (S.detail.has(id)) { if (S.detail.get(id).data || S.detail.get(id).error) return; }
  else S.detail.set(id, {});
  const entry = S.detail.get(id);
  if (entry.loading) return;
  entry.loading = true;
  try {
    const res = await fetch(`/api/v1/wormholes/systems/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'HTTP ' + res.status);
    entry.data = data;
    const types = [...new Set(data.recent.map((k) => k.ship_type_id))];
    entry.typeNames = await ctx.resolveTypeNames(types).catch(() => new Map());
  } catch (e) {
    entry.error = e.message;
  } finally {
    entry.loading = false;
  }
  const box = $('whDetail');
  if (box && S.tab === 'system' && S.sys === id) box.innerHTML = detailHtml(id);
}

function detailHtml(id) {
  const { esc, formatISK, formatNumber } = ctx;
  const e = S.detail.get(id);
  if (!e || e.loading || (!e.data && !e.error)) return '<div class="pi-card"><div class="pi-loading">读取近 30 天击杀…</div></div>';
  if (e.error) return `<div class="pi-card"><p class="text-muted">击杀统计读取失败：${esc(e.error)}</p></div>`;
  const d = e.data;
  if (!d.kills) return '<div class="pi-card"><h4 class="wh-h">近 30 天活动</h4><p class="text-muted">本站没有记录到这个星系近 30 天的击杀（可能没人住，或住户很少出门）</p></div>';
  const name = (x) => esc(d.names?.[x] || String(x));
  const max = Math.max(...d.hours_utc, 1);
  const bars = d.hours_utc.map((n, h) => `<div class="wh-bar" title="UTC ${h}:00（北京时间 ${(h + 8) % 24}:00）· ${n} 次"><i style="height:${Math.round(n / max * 100)}%"></i><small>${h % 6 === 0 ? (h + 8) % 24 : ''}</small></div>`).join('');
  const ent = (list, kind) => list.map((x) => `<li><img src="https://images.evetech.net/${kind}/${x.id}/logo?size=32" alt="" width="20" height="20" loading="lazy"><span>${name(x.id)}</span><b>${x.count}</b></li>`).join('');
  const typeName = (t) => e.typeNames?.get(t) || e.typeNames?.get(String(t)) || 'Type ' + t;
  const recent = d.recent.map((k) => `<tr data-wh-kill="${k.id}" title="查看击杀详情">
      <td class="pi-hide-sm">${new Date(k.time).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td><div class="pi-prod"><img src="${ICON(k.ship_type_id)}" alt="" width="24" height="24" loading="lazy"><span>${esc(typeName(k.ship_type_id))}</span></div></td>
      <td>${name(k.victim.corporation_id)}${k.victim.alliance_id ? `<small class="hc-sub">${name(k.victim.alliance_id)}</small>` : ''}</td>
      <td class="num">${formatISK(k.value)}</td></tr>`).join('');
  return `<div class="wh-grid">
    <div class="pi-card"><h4 class="wh-h">近 30 天活动</h4>
      <div class="wh-stats"><div><b>${formatNumber(d.kills)}</b><small>次击杀</small></div><div><b>${formatISK(d.value)}</b><small>总价值</small></div><div><b>${formatNumber(d.npc_kills)}</b><small>被 NPC 击毁</small></div><div><b>${d.last ? new Date(d.last).toLocaleDateString('zh-CN') : '—'}</b><small>最近一次</small></div></div>
      <h4 class="wh-h">活跃时段 <small class="text-muted">（北京时间）</small></h4><div class="wh-hours">${bars}</div></div>
    <div class="pi-card"><h4 class="wh-h">出现最多的势力 <small class="text-muted" title="近 30 天在这里击杀或损失次数最多的军团 / 联盟，大概率是住户或常来的猎人">（推测常驻）</small></h4>
      <div class="wh-ent"><ul>${ent(d.corporations, 'corporations')}</ul>${d.alliances.length ? `<ul>${ent(d.alliances, 'alliances')}</ul>` : ''}</div></div>
  </div>
  <div class="pi-card"><h4 class="wh-h">最近击杀</h4><div class="pi-table-wrap"><table class="pi-table wh-table wh-kills"><thead><tr><th class="pi-hide-sm">时间</th><th>舰船</th><th>受害者</th><th class="num">价值</th></tr></thead><tbody>${recent}</tbody></table></div></div>`;
}

// ---------- 活跃度 ----------
async function renderActivity(body) {
  const days = S.actDays;
  if (!S.act.has(days)) {
    body.innerHTML = '<div class="pi-card"><div class="pi-loading">读取虫洞击杀统计…</div></div>';
    try {
      const res = await fetch(`/api/v1/wormholes/activity?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'HTTP ' + res.status);
      S.act.set(days, data);
    } catch (e) {
      body.innerHTML = `<div class="pi-card"><p class="text-muted">读取失败：${ctx.esc(e.message)}</p></div>`;
      return;
    }
    if (S.tab !== 'activity' || S.actDays !== days) return;
  }
  const { esc, formatISK, formatNumber } = ctx;
  const data = S.act.get(days);
  const rows = Object.entries(data.systems).map(([id, [kills, value, npc, last]]) => ({ s: D.sysById.get(Number(id)), kills, value, npc, last }))
    .filter((r) => r.s && (!S.actCls || r.s.cls === S.actCls) && (!S.actEff || (S.actEff === 'none' ? !r.s.effect : r.s.effect === S.actEff)))
    .sort((a, b) => b.kills - a.kills || b.value - a.value);
  const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-wh-set="${k}" data-v="${v}" class="${String(S[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const clsOpts = [[0, '全部'], ...[1, 2, 3, 4, 5, 6, 13].map((c) => [c, clsName(c)])];
  const effOpts = [['', '全部天象'], ['none', '无天象'], ...Object.entries(EFFECTS).map(([k, v]) => [k, v[0]])];
  body.innerHTML = `<div class="pi-card ind-rank-filters">
      <div class="ind-rank-row"><div class="pi-inline"><span>时间</span>${seg('actDays', [[1, '24 小时'], [7, '7 天'], [30, '30 天']])}</div>
        <div class="pi-inline"><span>等级</span>${seg('actCls', clsOpts)}</div>
        <div class="pi-inline"><span>天象</span><select class="pi-input" data-wh-sel="actEff">${effOpts.map(([v, l]) => `<option value="${v}"${S.actEff === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <p class="pi-note">${rows.length} 个虫洞星系有击杀，显示前 200 · 击杀多说明有人住或常有人来猎杀；被 NPC 击毁多通常是有人在刷站点 · 本站击杀库统计</p></div>
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table wh-table"><thead><tr><th class="pi-hide-sm">#</th><th>星系</th><th>等级</th><th class="pi-hide-sm">天象</th><th class="pi-hide-sm">固定出口</th><th class="num">击杀</th><th class="num">价值</th><th class="num pi-hide-sm">被 NPC 击毁</th><th class="num">最近</th></tr></thead><tbody>
    ${rows.slice(0, 200).map((r, i) => `<tr data-wh-sys="${r.s.id}" class="wh-row">
      <td class="pi-rank pi-hide-sm">${i + 1}</td><td><b>${esc(r.s.name)}</b></td><td>${clsTag(r.s.cls)}</td>
      <td class="pi-hide-sm">${r.s.effect ? EFFECTS[r.s.effect][0] : '<span class="text-muted">—</span>'}</td>
      <td class="pi-hide-sm">${r.s.statics.map((c) => `${esc(c)}<small class="hc-sub">${clsName(D.holes.get(c)?.dest)}</small>`).join(' ')}</td>
      <td class="num">${formatNumber(r.kills)}</td><td class="num">${formatISK(r.value)}</td><td class="num pi-hide-sm">${formatNumber(r.npc)}</td>
      <td class="num">${ago(r.last)}</td></tr>`).join('') || '<tr><td colspan="9" class="text-muted">没有符合条件的星系</td></tr>'}
    </tbody></table></div></div>`;
}

function ago(t) {
  const m = (Date.now() - new Date(t)) / 60e3;
  return m < 60 ? Math.max(1, Math.round(m)) + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
}

// ---------- 虫洞类型 ----------
function holesHtml() {
  const { esc } = ctx;
  const q = S.holeQ.trim().toUpperCase();
  const list = [...D.holes.values()].filter((h) => (!q || h.code.includes(q)) && (S.holeDest === 'all' || String(h.dest) === S.holeDest));
  const dests = [...new Set([...D.holes.values()].map((h) => h.dest))].filter((d) => d > 0).sort((a, b) => a - b);
  return `<div class="pi-card ind-rank-filters"><div class="ind-rank-row">
      <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-wh-holeq placeholder="虫洞代码，如 H296" value="${esc(S.holeQ)}" spellcheck="false" aria-label="虫洞代码"></div>
      <div class="pi-inline"><span>通往</span><select class="pi-input" data-wh-sel="holeDest"><option value="all">全部</option>${dests.map((d) => `<option value="${d}"${S.holeDest === String(d) ? ' selected' : ''}>${clsName(d)}</option>`).join('')}</select></div></div>
      <p class="pi-note">共 ${list.length} 种 · 总质量与存活时间都有约 ±10% 的随机浮动 · 质量单位 kt（千吨，1 kt = 100 万 kg）</p></div>
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table wh-table">${holeHead(true)}<tbody>${list.map((h) => holeRow(h.code, { showSrc: true })).join('') || '<tr><td colspan="9" class="text-muted">没有匹配的虫洞</td></tr>'}</tbody></table></div></div>`;
}

// ---------- 天象 ----------
function effectsHtml() {
  const classes = [1, 2, 3, 4, 5, 6];
  const counts = {};
  for (const s of D.sysById.values()) if (s.effect) counts[s.effect] = (counts[s.effect] || 0) + 1;
  return `<p class="pi-note wh-intro">虫洞星系里的次级恒星给整个星系的舰船加上效果，强度随等级提高（C13 按 C6，漂流者星系按 C2）</p>
    <div class="wh-eff-grid">${Object.entries(EFFECTS).map(([k, [name, mods]]) => `<div class="pi-card"><h4 class="wh-h"><span class="wh-eff-tag wh-e-${k}">${name}</span> <small class="text-muted">${counts[k] || 0} 个星系</small></h4>
      <div class="pi-table-wrap"><table class="pi-table wh-table wh-eff-table"><thead><tr><th>效果</th>${classes.map((c) => `<th class="num">C${c}</th>`).join('')}</tr></thead><tbody>
      ${mods.map(([n, sign, base]) => `<tr><td>${n}</td>${classes.map((c) => `<td class="num ${sign > 0 ? 'up' : 'down'}">${sign > 0 ? '+' : '−'}${effVal(base, c)}%</td>`).join('')}</tr>`).join('')}
      </tbody></table></div></div>`).join('')}</div>`;
}

// ---------- 质量计算 ----------
// 预设舰船质量（kg，冷 / 开推进）；不同舰船差别很大，可直接改数字
const SHIP_PRESETS = [
  ['战列舰', 100e6, 150e6], ['战列舰（希格斯锚定）', 200e6, 250e6], ['战巡', 15e6, 65e6], ['巡洋舰', 12e6, 17e6], ['战略巡洋舰', 13e6, 18e6],
  ['护卫舰', 1.2e6, 1.7e6], ['长须鲸级 / 运输舰', 20e6, 25e6], ['航母 / 无畏', 1150e6, 1200e6]
];

function massCalc() {
  const total = S.mass.total * 1e6;
  let used = 0, far = 0;
  const hole = D.holes.get(S.mass.hole);
  return S.mass.steps.map((st) => {
    const m = st.mass * 1e6;
    used += m;
    far += st.dir === 'in' ? 1 : -1;
    const lo = total * 0.9 - used, hi = total * 1.1 - used;
    return { ...st, used, lo, hi, far, tooBig: hole?.jump && m > hole.jump };
  });
}

function stateOf(rem, total) {
  const f = rem / total;
  if (rem <= 0) return ['已塌', 'down'];
  if (f < 0.1) return ['临界（<10%）', 'down'];
  if (f <= 0.5) return ['减弱（10–50%）', 'warn'];
  return ['稳定（>50%）', 'up'];
}

function massHtml() {
  const { esc, formatNumber } = ctx;
  const hole = D.holes.get(S.mass.hole);
  const total = S.mass.total * 1e6;
  const calc = massCalc();
  const last = calc[calc.length - 1];
  const holes = [...D.holes.values()].filter((h) => h.mass).sort((a, b) => a.code.localeCompare(b.code));
  const rows = calc.map((r, i) => {
    const [lo] = stateOf(r.hi, total), [hiS, cls] = stateOf(r.lo, total);
    const collapse = r.hi <= 0 ? '<b class="down">一定已塌</b>' : r.lo <= 0 ? '<b class="warn">可能已塌</b>' : '';
    return `<tr><td>${i + 1}</td><td>${r.dir === 'in' ? '进 →' : '← 出'}</td>
      <td><input type="number" class="pi-input wh-mass-in" data-wh-step="${i}" value="${r.mass}" min="0" step="0.1" aria-label="质量"> kt${r.tooBig ? ' <b class="down" title="超过单次通过质量，过不去">超重</b>' : ''}</td>
      <td class="num">${formatNumber(Math.round(r.used / 1e6))} kt</td>
      <td class="num">${formatNumber(Math.max(0, Math.round(r.lo / 1e6)))} – ${formatNumber(Math.max(0, Math.round(r.hi / 1e6)))} kt</td>
      <td class="${cls}">${collapse || (hiS === lo ? hiS : `${lo} ~ ${hiS}`)}</td>
      <td>${r.far > 0 ? `<span class="warn">${r.far} 艘在对面</span>` : '全部在家'}</td>
      <td><button type="button" class="link-btn" data-wh-del="${i}" aria-label="删除">删除</button></td></tr>`;
  }).join('');
  const preset = SHIP_PRESETS.map(([n, cold, hot], i) => `<div class="wh-preset"><span>${n}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-wh-add="${i}" data-hot="0" data-dir="in">冷 ${formatNumber(cold / 1e6)} 进</button>
      <button type="button" class="btn btn-ghost btn-sm" data-wh-add="${i}" data-hot="0" data-dir="out">冷 出</button>
      <button type="button" class="btn btn-ghost btn-sm" data-wh-add="${i}" data-hot="1" data-dir="in">热 ${formatNumber(hot / 1e6)} 进</button>
      <button type="button" class="btn btn-ghost btn-sm" data-wh-add="${i}" data-hot="1" data-dir="out">热 出</button></div>`).join('');
  return `<div class="pi-card ind-rank-filters">
      <div class="ind-rank-row">
        <div class="pi-inline"><span>虫洞</span><select class="pi-input" data-wh-sel="massHole">${holes.map((h) => `<option value="${h.code}"${h.code === S.mass.hole ? ' selected' : ''}>${h.code} · ${clsName(h.dest)} · ${formatNumber(h.mass / 1e6)} kt</option>`).join('')}</select></div>
        <div class="pi-inline"><span>总质量</span><input type="number" class="pi-input wh-mass-in" data-wh-total value="${S.mass.total}" min="1" step="1"> kt</div>
        <div class="pi-inline"><span>单次上限</span><b>${hole?.jump ? formatNumber(hole.jump / 1e6) + ' kt' : '—'}</b></div>
        <span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-wh-clear>清空</button>
      </div>
      <p class="pi-note">实际总质量在标称值 ±10% 之间随机，所以剩余质量按区间算。游戏里看虫洞信息：>50% 稳定、10–50% 「减弱」、<10% 「临界」，可用来缩小区间。「热」= 开着微曲 / 加力（500MN 微曲 +50 kt、50MN +5 kt）</p>
    </div>
    <div class="pi-card"><h4 class="wh-h">添加一次通过</h4><div class="wh-presets">${preset}
      <div class="wh-preset"><span>自定义</span><input type="number" class="pi-input wh-mass-in" data-wh-custom placeholder="质量 kt" min="0" step="0.1">
        <button type="button" class="btn btn-ghost btn-sm" data-wh-addc="in">进</button><button type="button" class="btn btn-ghost btn-sm" data-wh-addc="out">出</button></div></div></div>
    <div class="pi-card">${calc.length ? `<div class="pi-table-wrap"><table class="pi-table wh-table"><thead><tr><th>#</th><th>方向</th><th>舰船质量</th><th class="num">累计</th><th class="num">剩余（区间）</th><th>状态</th><th>船在哪</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${last && last.far > 0 && last.lo - 0 < (calc.filter((r) => r.dir === 'in').slice(-1)[0]?.mass || 0) * 1e6 ? '<p class="pi-note warn">注意：还有船在对面，剩余质量可能不够它回来，回程可能把洞关掉，船被关在对面</p>' : ''}`
      : '<p class="text-muted">从上面添加每一次通过（进 = 从家这边过去，出 = 回来），查看每一步后虫洞剩多少质量</p>'}</div>`;
}

// ---------- 席拉连接 ----------
async function renderThera(body) {
  const { esc } = ctx;
  if (!S.scout || Date.now() - S.scoutAt > 5 * 60e3) {
    body.innerHTML = '<div class="pi-card"><div class="pi-loading">读取 EVE-Scout 实时连接…</div></div>';
    try {
      const [res, map] = await Promise.all([fetch(SCOUT_API), loadMap()]);
      if (!res.ok) throw new Error('EVE-Scout ' + res.status);
      S.scout = (await res.json()).filter((x) => x.signature_type === 'wormhole');
      S.scoutAt = Date.now();
      S.scoutErr = null;
      void map;
    } catch (e) {
      S.scoutErr = e.message;
    }
    if (S.tab !== 'thera') return;
  }
  if (S.scoutErr && !S.scout) { body.innerHTML = `<div class="pi-card"><p class="text-muted">读取失败：${esc(S.scoutErr)}</p></div>`; return; }
  const map = await loadMap();
  const origin = S.origin && map.byName.get(S.origin.trim());
  const dist = origin ? bfs(map, origin.id) : null;
  const rows = S.scout.map((x) => {
    const inK = x.in_system_id < 31000000;
    const ksys = map.sys.get(x.in_system_id);
    return { x, inK, ksys, jumps: dist && inK ? dist.get(x.in_system_id) ?? null : null };
  }).sort((a, b) => (a.jumps ?? 1e9) - (b.jumps ?? 1e9) || a.x.out_system_name.localeCompare(b.x.out_system_name) || b.x.remaining_hours - a.x.remaining_hours);
  const secTxt = (sec) => { const v = sec > 0 && sec < 0.05 ? 0.1 : Math.max(0, Math.round(sec * 10) / 10); return `<b class="${v >= 0.45 ? 'up' : v > 0 ? 'warn' : 'down'}">${v.toFixed(1)}</b>`; };
  const hub = (x) => x.out_system_id === 31000005 ? '席拉' : x.out_system_id === 30002086 ? '图尔努尔' : esc(x.out_system_name);
  body.innerHTML = `<div class="pi-card ind-rank-filters"><div class="ind-rank-row">
      <div class="pi-inline"><span>从</span><input type="search" class="pi-input wh-origin" data-wh-origin list="whOriginList" placeholder="输入所在星系（中文名，回车）" value="${esc(S.origin)}" spellcheck="false" aria-label="出发星系"></div>
      <datalist id="whOriginList">${S.origin ? '' : ''}</datalist>
      <span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-wh-scout-reload>刷新</button></div>
      <p class="pi-note">${rows.length} 个连接${origin ? ` · 按离 ${esc(origin.name)} 的跳数排序` : S.origin ? ' · <span class="warn">没找到这个星系</span>' : ' · 输入所在星系后按跳数排序，找最近的席拉入口'} · 数据：EVE-Scout 志愿者实时扫描，5 分钟更新 · 进出席拉前确认信号还在</p></div>
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table wh-table"><thead><tr><th>枢纽</th><th>枢纽内信号</th><th>对面星系</th><th class="pi-hide-sm">星域</th><th>对面信号</th><th class="pi-hide-sm">类型</th><th>最大船型</th><th class="num">剩余</th>${origin ? '<th class="num">跳数</th>' : ''}</tr></thead><tbody>
    ${rows.map(({ x, inK, ksys, jumps }) => `<tr>
      <td><b>${hub(x)}</b></td><td><code>${esc(x.out_signature || '')}</code></td>
      <td>${inK ? `${esc(ksys?.name || x.in_system_name)} ${ksys ? secTxt(ksys.sec) : ''}` : `${sysLink(x.in_system_id, x.in_system_name)} ${clsTag(D.sysById.get(x.in_system_id)?.cls ?? 0)}`}</td>
      <td class="pi-hide-sm">${esc(inK ? map.regions.get(ksys?.region) || x.in_region_name : x.in_region_name || '')}</td>
      <td><code>${esc(x.in_signature || '')}</code></td><td class="pi-hide-sm">${esc(x.wh_type || '')}</td>
      <td>${SCOUT_SIZE[x.max_ship_size] || esc(x.max_ship_size || '')}</td>
      <td class="num">${x.remaining_hours != null ? x.remaining_hours + ' 小时' : '—'}</td>
      ${origin ? `<td class="num">${jumps != null ? jumps : '—'}</td>` : ''}</tr>`).join('') || '<tr><td colspan="9" class="text-muted">当前没有已扫描的连接</td></tr>'}
    </tbody></table></div></div>`;
  const dl = $('whOriginList');
  if (dl && !dl.children.length) dl.innerHTML = [...map.byName.keys()].slice(0, 6000).map((n) => `<option value="${esc(n)}">`).join('');
}

function bfs(map, from) {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const n of map.nbr.get(cur) || []) if (!dist.has(n)) { dist.set(n, dist.get(cur) + 1); queue.push(n); }
  }
  return dist;
}

// ---------- 事件 ----------
function onClick(e) {
  const tab = e.target.closest('[data-wh-tab]');
  if (tab) { S.tab = tab.dataset.whTab; render(); return; }
  const kill = e.target.closest('[data-wh-kill]');
  if (kill) { ctx.loadKillboard().then((kb) => kb.openServiceKill(Number(kill.dataset.whKill))); return; }
  const sys = e.target.closest('[data-wh-sys]');
  if (sys) { openSystem(Number(sys.dataset.whSys)); return; }
  const pi = e.target.closest('[data-wh-pi]');
  if (pi) { ctx.planPi(Number(pi.dataset.whPi)); return; }
  const set = e.target.closest('[data-wh-set]');
  if (set) { const k = set.dataset.whSet; S[k] = typeof S[k] === 'number' ? Number(set.dataset.v) : set.dataset.v; render(); return; }
  if (e.target.closest('[data-wh-scout-reload]')) { S.scoutAt = 0; render(); return; }
  const add = e.target.closest('[data-wh-add]');
  if (add) {
    const p = SHIP_PRESETS[Number(add.dataset.whAdd)];
    S.mass.steps.push({ mass: (add.dataset.hot === '1' ? p[2] : p[1]) / 1e6, dir: add.dataset.dir });
    save(); render(); return;
  }
  const addc = e.target.closest('[data-wh-addc]');
  if (addc) {
    const v = Number(document.querySelector('[data-wh-custom]')?.value);
    if (!(v > 0)) { ctx.showToast('请先填写舰船质量（kt）', 'info'); return; }
    S.mass.steps.push({ mass: v, dir: addc.dataset.whAddc });
    save(); render(); return;
  }
  const del = e.target.closest('[data-wh-del]');
  if (del) { S.mass.steps.splice(Number(del.dataset.whDel), 1); save(); render(); return; }
  if (e.target.closest('[data-wh-clear]')) { S.mass.steps = []; save(); render(); }
}

function onChange(e) {
  const sel = e.target.closest('[data-wh-sel]');
  if (sel) {
    const k = sel.dataset.whSel;
    if (k === 'massHole') { S.mass.hole = sel.value; S.mass.total = Math.round((D.holes.get(sel.value)?.mass || 0) / 1e6); save(); }
    else S[k] = sel.value;
    render(); return;
  }
  if (e.target.matches('[data-wh-total]')) { S.mass.total = Number(e.target.value) || 0; save(); render(); return; }
  const step = e.target.closest('[data-wh-step]');
  if (step) { S.mass.steps[Number(step.dataset.whStep)].mass = Number(step.value) || 0; save(); render(); return; }
  if (e.target.matches('[data-wh-origin]')) { S.origin = e.target.value.trim(); save(); render(); }
}

let inputTimer = 0;
function onInput(e) {
  if (e.target.matches('[data-wh-search]')) {
    S.q = e.target.value;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { const pos = e.target.selectionStart; $('whBody').innerHTML = systemHtml(); if (S.sys && IS_TQ) loadDetail(S.sys); const inp = document.querySelector('[data-wh-search]'); inp.focus(); inp.setSelectionRange(pos, pos); }, 200);
  } else if (e.target.matches('[data-wh-holeq]')) {
    S.holeQ = e.target.value;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { const pos = e.target.selectionStart; render(); const inp = document.querySelector('[data-wh-holeq]'); inp.focus(); inp.setSelectionRange(pos, pos); }, 200);
  }
}
